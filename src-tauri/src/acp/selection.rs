//! Per-conversation selector persistence (codeg#1179).
//!
//! Every conversation keeps its OWN model / options / mode on its row
//! (`conversation.selector_state`), written here from the connection's
//! authoritative `SessionState` — the one place that sees every change: the
//! user's picks from any client, agent-initiated mode switches, a fork's
//! re-application. On connect, a conversation with a stored selection
//! replays only that (`commands::acp::resolve_connect_selection`); the
//! client's new-conversation default never reaches it.
//!
//! Writes are serialized under one manager-wide mutex, and each write reads
//! the state AT THAT MOMENT, so whichever writer runs last leaves the row on
//! the latest state. Only one connection may write a row at a time (its WRITE
//! AUTHORITY, held in the same mutex): taken when a connection binds to the
//! row — `acp_connect` for an existing conversation, `ConversationLinked` for
//! a draft's new row — latest binder wins, and released by the connection's
//! driver once its loop has ended, after the final flush.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use sea_orm::DatabaseConnection;
use tokio::sync::{Mutex, MutexGuard, RwLock};

use crate::acp::error::AcpError;
use crate::acp::session_state::SessionState;
use crate::acp::types::AcpEvent;
use crate::db::service::conversation_service;
use crate::models::ConversationSelection;
use crate::web::event_bridge::{emit_with_state_gated, EventEmitter};

/// Row id → id of the connection that may write that row's selection.
pub(crate) type SelectionOwners = HashMap<i32, String>;

#[derive(Default)]
pub struct SelectionPersister {
    /// Installed once at bootstrap (`lifecycle_subscriber_task`). Tests that
    /// never install it simply persist nothing.
    db: OnceLock<DatabaseConnection>,
    /// THE persister mutex: serializes every selection write and every
    /// connect-time read, and guards the write-authority map.
    owners: Mutex<SelectionOwners>,
}

/// The mode a session currently runs with.
fn applied_mode(s: &SessionState) -> Option<String> {
    s.modes
        .as_ref()
        .map(|m| m.current_mode_id.clone())
        .or_else(|| s.current_mode.clone())
}

/// What the row stores for this state.
pub(crate) fn selection_snapshot(s: &SessionState) -> ConversationSelection {
    ConversationSelection {
        mode_id: applied_mode(s),
        composer_mode_id: s.composer_mode_id.clone(),
        config_values: s
            .config_options
            .as_deref()
            .map(crate::acp::connection::current_config_option_values)
            .unwrap_or_default(),
    }
}

/// Whether the composer's pending pick has been reached by the agent and can
/// be cleared: only outside an establishment, so a fork's handshake default
/// that happens to equal the pick never clears it.
fn composer_pick_reached(s: &SessionState) -> bool {
    s.selectors_ready
        && !s.selectors_settling
        && s.composer_mode_id.is_some()
        && s.composer_mode_id == applied_mode(s)
}

impl SelectionPersister {
    pub fn install_db(&self, db: DatabaseConnection) {
        let _ = self.db.set(db);
    }

    /// The database [`Self::install_db`] installed, if bootstrap has run.
    pub(crate) fn db(&self) -> Option<&DatabaseConnection> {
        self.db.get()
    }

    /// Hold the persister mutex, e.g. while reading a row's selection at
    /// connect, so a reconnect never reads mid-write.
    pub(crate) async fn lock(&self) -> MutexGuard<'_, SelectionOwners> {
        self.owners.lock().await
    }

    /// Whether `conn_id` currently holds the write authority for `row_id`.
    pub async fn owns(&self, row_id: i32, conn_id: &str) -> bool {
        self.owners
            .lock()
            .await
            .get(&row_id)
            .is_some_and(|owner| owner == conn_id)
    }

    /// Bind a connection to an existing conversation's row before its first
    /// prompt links it (`acp_connect`, chat-channel resume, task rerun): take
    /// the row's write authority (latest binder wins; idempotent for the
    /// current owner), restore the stored composer intent when this
    /// connection has none yet, then persist once as a catch-up — the
    /// connection's `SelectorsReady` may already have been processed, or a
    /// reused connection may emit no further selector event.
    ///
    /// Refused (`ConnectionNotFound`) once the connection's loop has ended.
    pub async fn bind(
        &self,
        conn_id: &str,
        state: &Arc<RwLock<SessionState>>,
        emitter: &EventEmitter,
        row_id: i32,
        stored_composer_mode_id: Option<String>,
    ) -> Result<(), AcpError> {
        {
            let mut owners = self.owners.lock().await;
            {
                let mut s = state.write().await;
                if s.selection_finalized {
                    return Err(AcpError::ConnectionNotFound(conn_id.to_string()));
                }
                if s.conversation_id.is_none() {
                    s.selection_conversation_id = Some(row_id);
                }
            }
            owners.insert(row_id, conn_id.to_string());
        }
        if let Some(mode) = stored_composer_mode_id {
            // One-time initialization: never overwrites a pick made on this
            // connection (any surface), nor a pending one.
            emit_with_state_gated(
                state,
                emitter,
                AcpEvent::ComposerModeChanged {
                    mode_id: Some(mode),
                    explicit: false,
                },
                |s| {
                    !s.selection_finalized
                        && !s.composer_mode_touched
                        && s.composer_mode_id.is_none()
                },
            )
            .await;
        }
        self.persist(conn_id, state, Some(emitter)).await;
        Ok(())
    }

    /// `ConversationLinked`: the connection now runs `row_id` (a draft's
    /// first prompt created it, or a resumed conversation's first prompt
    /// linked it). Takes the row's write authority unless the connection's
    /// loop has already ended. Called at the link itself, before the event
    /// is emitted.
    pub async fn take_authority_on_link(
        &self,
        conn_id: &str,
        state: &Arc<RwLock<SessionState>>,
        row_id: i32,
    ) {
        let mut owners = self.owners.lock().await;
        let (finalized, snapshot) = {
            let s = state.read().await;
            let settled = s.selectors_ready && !s.selectors_settling;
            (
                s.selection_finalized,
                settled.then(|| selection_snapshot(&s)),
            )
        };
        if !finalized {
            owners.insert(row_id, conn_id.to_string());
            return;
        }
        // The loop already ended (its final flush ran before this link, so it
        // had no row to write): record the selection the connection ended
        // with — but only into a row that has none yet and no live writer,
        // so it can never overwrite anyone's newer selection.
        if owners.contains_key(&row_id) {
            return;
        }
        if let (Some(db), Some(snapshot)) = (self.db.get(), snapshot) {
            if let Err(e) =
                conversation_service::set_selector_state_if_absent(db, row_id, &snapshot).await
            {
                tracing::warn!("[selection] late link of conversation {row_id} failed: {e}");
            }
        }
    }

    /// Persist the connection's current selection to its row, if it has one,
    /// its selectors are settled, and it holds the row's write authority.
    /// With an emitter, first clears a composer pick the agent has reached
    /// (gated under the state lock, so a newer pick landing in between vetoes
    /// the clear instead of being erased).
    pub async fn persist(
        &self,
        conn_id: &str,
        state: &Arc<RwLock<SessionState>>,
        emitter: Option<&EventEmitter>,
    ) {
        let Some(db) = self.db.get() else {
            return;
        };
        let owners = self.owners.lock().await;
        let (row, should_clear) = {
            let s = state.read().await;
            let row = s.conversation_id.or(s.selection_conversation_id);
            if !s.selectors_ready || s.selectors_settling {
                return;
            }
            (row, composer_pick_reached(&s))
        };
        let Some(row) = row else {
            return;
        };
        if owners.get(&row).map(String::as_str) != Some(conn_id) {
            return;
        }
        if should_clear {
            if let Some(emitter) = emitter {
                emit_with_state_gated(
                    state,
                    emitter,
                    AcpEvent::ComposerModeChanged {
                        mode_id: None,
                        explicit: false,
                    },
                    composer_pick_reached,
                )
                .await;
            }
        }
        // Fresh read AFTER the reconciliation.
        let snapshot = {
            let s = state.read().await;
            if !s.selectors_ready || s.selectors_settling {
                return;
            }
            if s.conversation_id.or(s.selection_conversation_id) != Some(row) {
                return;
            }
            selection_snapshot(&s)
        };
        if let Err(e) = conversation_service::set_selector_state(db, row, &snapshot).await {
            tracing::warn!("[selection] persist conversation {row} failed: {e}");
        }
        drop(owners);
    }

    /// The driver's final flush, run once the connection's loop has ended
    /// (queued commands drained): close the admission barrier, flush with the
    /// state it now holds, and release the row's authority — only if this
    /// connection still owns it.
    pub async fn finalize(&self, conn_id: &str, state: &Arc<RwLock<SessionState>>) {
        state.write().await.selection_finalized = true;
        let mut owners = self.owners.lock().await;
        let (row, snapshot) = {
            let s = state.read().await;
            let row = s.conversation_id.or(s.selection_conversation_id);
            let settled = s.selectors_ready && !s.selectors_settling;
            (row, settled.then(|| selection_snapshot(&s)))
        };
        let Some(row) = row else {
            return;
        };
        if owners.get(&row).map(String::as_str) != Some(conn_id) {
            return;
        }
        if let (Some(db), Some(snapshot)) = (self.db.get(), snapshot) {
            if let Err(e) = conversation_service::set_selector_state(db, row, &snapshot).await {
                tracing::warn!("[selection] final flush of conversation {row} failed: {e}");
            }
        }
        owners.remove(&row);
    }
}

/// Record the composer's pending mode pick on a connection (never sent to
/// the agent). `initial` = a draft's one-time hand-over of its pick at its
/// first send: applied only while no surface has picked on this connection
/// and nothing is pending. Returns whether it applied.
pub async fn set_composer_mode(
    conn_id: &str,
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    mode_id: Option<String>,
    initial: bool,
) -> Result<bool, AcpError> {
    if state.read().await.selection_finalized {
        return Err(AcpError::ConnectionNotFound(conn_id.to_string()));
    }
    let mut finalized = false;
    let applied = emit_with_state_gated(
        state,
        emitter,
        AcpEvent::ComposerModeChanged {
            mode_id,
            explicit: !initial,
        },
        |s| {
            if s.selection_finalized {
                finalized = true;
                return false;
            }
            !initial || (!s.composer_mode_touched && s.composer_mode_id.is_none())
        },
    )
    .await;
    if finalized {
        return Err(AcpError::ConnectionNotFound(conn_id.to_string()));
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::{SessionModeInfo, SessionModeStateInfo};
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
    use crate::models::AgentType;

    fn ready_state(conn: &str, mode: &str) -> Arc<RwLock<SessionState>> {
        let mut s = SessionState::new(conn.into(), AgentType::Codex, None, "w".into(), None);
        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "S".into(),
        });
        s.apply_event(&AcpEvent::SessionModes {
            modes: SessionModeStateInfo {
                current_mode_id: mode.into(),
                available_modes: vec![
                    SessionModeInfo {
                        id: "a".into(),
                        name: "A".into(),
                        description: None,
                    },
                    SessionModeInfo {
                        id: "b".into(),
                        name: "B".into(),
                        description: None,
                    },
                ],
            },
        });
        s.apply_event(&AcpEvent::SelectorsReady);
        Arc::new(RwLock::new(s))
    }

    async fn row(db: &crate::db::AppDatabase) -> i32 {
        let folder = seed_folder(db, "/tmp/codeg-selection").await;
        conversation_service::create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .expect("row")
            .id
    }

    fn emitter() -> EventEmitter {
        EventEmitter::Noop
    }

    #[tokio::test]
    async fn bind_persists_and_only_the_owner_writes() {
        let db = fresh_in_memory_db().await;
        let id = row(&db).await;
        let p = SelectionPersister::default();
        p.install_db(db.conn.clone());

        let a = ready_state("A", "a");
        p.bind("A", &a, &emitter(), id, None).await.unwrap();
        let stored = conversation_service::get_selector_state(&db.conn, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.mode_id.as_deref(), Some("a"));

        // A newer connection binds; the retiring one can no longer write.
        let b = ready_state("B", "b");
        p.bind("B", &b, &emitter(), id, None).await.unwrap();
        a.write().await.apply_event(&AcpEvent::ModeChanged {
            mode_id: "a".into(),
        });
        p.persist("A", &a, None).await;
        p.finalize("A", &a).await;
        let stored = conversation_service::get_selector_state(&db.conn, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.mode_id.as_deref(), Some("b"));
        assert!(p.owns(id, "B").await);
    }

    #[tokio::test]
    async fn nothing_is_written_while_selectors_settle() {
        let db = fresh_in_memory_db().await;
        let id = row(&db).await;
        let p = SelectionPersister::default();
        p.install_db(db.conn.clone());
        let a = ready_state("A", "a");
        p.bind("A", &a, &emitter(), id, None).await.unwrap();
        // A new establishment starts (resume / fork): its defaults are
        // transitional.
        a.write().await.apply_event(&AcpEvent::SessionStarted {
            session_id: "S2".into(),
        });
        a.write().await.apply_event(&AcpEvent::ModeChanged {
            mode_id: "b".into(),
        });
        p.persist("A", &a, None).await;
        let stored = conversation_service::get_selector_state(&db.conn, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.mode_id.as_deref(), Some("a"));
        a.write().await.apply_event(&AcpEvent::SelectorsReady);
        p.persist("A", &a, None).await;
        let stored = conversation_service::get_selector_state(&db.conn, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.mode_id.as_deref(), Some("b"));
    }

    #[tokio::test]
    async fn composer_pick_is_stored_apart_and_cleared_once_reached() {
        let db = fresh_in_memory_db().await;
        let id = row(&db).await;
        let p = SelectionPersister::default();
        p.install_db(db.conn.clone());
        let a = ready_state("A", "a");
        let em = emitter();
        p.bind("A", &a, &em, id, None).await.unwrap();
        assert!(set_composer_mode("A", &a, &em, Some("b".into()), false)
            .await
            .unwrap());
        p.persist("A", &a, Some(&em)).await;
        let stored = conversation_service::get_selector_state(&db.conn, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.mode_id.as_deref(), Some("a"));
        assert_eq!(stored.composer_mode_id.as_deref(), Some("b"));

        // The tab's send applied it.
        a.write().await.apply_event(&AcpEvent::ModeChanged {
            mode_id: "b".into(),
        });
        p.persist("A", &a, Some(&em)).await;
        assert_eq!(a.read().await.composer_mode_id, None);
        let stored = conversation_service::get_selector_state(&db.conn, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.mode_id.as_deref(), Some("b"));
        assert_eq!(stored.composer_mode_id, None);
    }

    #[tokio::test]
    async fn an_initial_hand_over_never_overwrites_an_explicit_pick() {
        let a = ready_state("A", "a");
        let em = emitter();
        assert!(set_composer_mode("A", &a, &em, Some("b".into()), false)
            .await
            .unwrap());
        // Cleared since — still touched.
        a.write().await.apply_event(&AcpEvent::ComposerModeChanged {
            mode_id: None,
            explicit: false,
        });
        assert!(!set_composer_mode("A", &a, &em, Some("a".into()), true)
            .await
            .unwrap());
        assert_eq!(a.read().await.composer_mode_id, None);
    }

    #[tokio::test]
    async fn after_finalization_picks_are_refused_and_the_flush_has_the_last_one() {
        let db = fresh_in_memory_db().await;
        let id = row(&db).await;
        let p = SelectionPersister::default();
        p.install_db(db.conn.clone());
        let a = ready_state("A", "a");
        let em = emitter();
        p.bind("A", &a, &em, id, None).await.unwrap();
        set_composer_mode("A", &a, &em, Some("b".into()), false)
            .await
            .unwrap();
        p.finalize("A", &a).await;
        let stored = conversation_service::get_selector_state(&db.conn, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.composer_mode_id.as_deref(), Some("b"));
        assert!(set_composer_mode("A", &a, &em, Some("a".into()), false)
            .await
            .is_err());
        assert!(p.bind("A", &a, &em, id, None).await.is_err());
        assert!(!p.owns(id, "A").await);
    }
}
