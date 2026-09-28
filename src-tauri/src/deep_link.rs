//! OS-level `codeg://` URL scheme.
//!
//! In-app markdown already uses `codeg://session/<id>` and `codeg://agent/<type>`
//! as reference links. Those stay in-process badges. This module is the
//! **system** handler: a click in another app, `open codeg://…`, or a browser
//! custom-scheme navigation should bring the desktop workspace forward and
//! focus the named conversation.
//!
//! Supported forms:
//!
//! - `codeg://session/<id>` — Codeg's numeric conversation PK, or an agent's
//!   `external_id` (Grok UUID, Codex thread id, …)
//! - `codeg://workspace?conversationId=<id>` — same lookup; `folderId` and
//!   `agent` are optional and filled from the row when omitted
//! - `codeg://open` / `codeg://` — just show the main window
//!
//! `codeg://agent/…`, `codeg://commit/…`, and `codeg://embedded/…` are
//! in-app mention badges, not OS navigation, and are ignored here.

use crate::db::service::conversation_service;
use crate::db::AppDatabase;
use crate::models::DbConversationSummary;

/// What a parsed `codeg://` URL wants the desktop app to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    /// Bring the workspace forward without targeting a conversation.
    Open,
    /// Focus a conversation looked up by `codeg://session/<ref>`.
    Session { session_ref: String },
    /// Explicit workspace query. `conversation_id` is required; folder and
    /// agent are filled from the database when omitted.
    Workspace {
        folder_id: Option<i32>,
        conversation_id: i32,
        agent: Option<String>,
    },
}

/// A `codeg://` link resolved to a conversation the workspace can open.
///
/// Serializes as the payload of [`take_pending_deep_link`], in the same
/// camelCase shape as the `workspace://focus-conversation` event so both
/// arrive at `PetFocusBridge` looking alike.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusTarget {
    pub folder_id: i32,
    pub conversation_id: i32,
    pub agent: String,
}

impl FocusTarget {
    /// Path the main window should load on a cold start so
    /// `DeepLinkBootstrap` can open the tab after hydration.
    pub fn workspace_path(&self) -> String {
        format!(
            "workspace?folderId={}&conversationId={}&agent={}",
            self.folder_id,
            self.conversation_id,
            urlencoding::encode(&self.agent)
        )
    }

    fn from_summary(summary: DbConversationSummary) -> Self {
        Self {
            folder_id: summary.folder_id,
            conversation_id: summary.id,
            agent: summary.agent_type.as_wire().into_owned(),
        }
    }
}

/// Parse a `codeg:` / `codeg://` URL. Returns `None` for a different scheme
/// or for in-app mention badges that must not navigate the workspace.
pub fn parse_deep_link(raw: &str) -> Option<DeepLink> {
    let raw = raw.trim();
    let rest = raw
        .strip_prefix("codeg://")
        .or_else(|| raw.strip_prefix("codeg:"))?;
    let rest = rest.trim_start_matches('/');
    if rest.is_empty() {
        return Some(DeepLink::Open);
    }

    let (path, query) = split_path_query(rest);
    let path = path.trim_end_matches('/');
    if path.is_empty() || path.eq_ignore_ascii_case("open") {
        return Some(DeepLink::Open);
    }
    if path.eq_ignore_ascii_case("workspace") {
        return parse_workspace_query(query.unwrap_or(""));
    }
    // `session` is the URL's host component, which the `url` crate lower-cases
    // before we ever see it — but an argv-delivered link on Windows/Linux keeps
    // whatever case the caller typed, so match the segment case-insensitively
    // like `open`/`workspace` above. The ref itself stays case-sensitive: an
    // agent's `external_id` is an opaque, case-significant token.
    if let Some((head, session_ref)) = path.split_once('/') {
        if head.eq_ignore_ascii_case("session") {
            return parse_session_ref(session_ref);
        }
    }
    None
}

fn split_path_query(rest: &str) -> (&str, Option<&str>) {
    let without_fragment = rest.split('#').next().unwrap_or(rest);
    match without_fragment.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (without_fragment, None),
    }
}

fn parse_session_ref(raw: &str) -> Option<DeepLink> {
    let decoded = percent_decode(raw);
    let decoded = decoded.trim();
    if decoded.is_empty() || decoded.contains('/') || decoded.contains('\\') {
        return None;
    }
    if decoded.len() > 256 {
        return None;
    }
    Some(DeepLink::Session {
        session_ref: decoded.to_string(),
    })
}

fn parse_workspace_query(query: &str) -> Option<DeepLink> {
    let mut folder_id = None;
    let mut conversation_id = None;
    let mut agent = None;
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some(parts) => parts,
            None => continue,
        };
        let value = percent_decode(value);
        match key {
            "folderId" | "folder_id" => {
                folder_id = value.parse::<i32>().ok().filter(|id| *id > 0);
            }
            "conversationId" | "conversation_id" => {
                conversation_id = value.parse::<i32>().ok().filter(|id| *id > 0);
            }
            "agent" => {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    agent = Some(trimmed.to_string());
                }
            }
            _ => {}
        }
    }
    Some(DeepLink::Workspace {
        folder_id,
        conversation_id: conversation_id?,
        agent,
    })
}

fn percent_decode(raw: &str) -> String {
    match urlencoding::decode(raw) {
        Ok(decoded) => decoded.into_owned(),
        Err(_) => raw.to_string(),
    }
}

/// Look a parsed link up in the live conversation table.
pub async fn resolve_deep_link(
    db: &AppDatabase,
    link: &DeepLink,
) -> Result<Option<FocusTarget>, crate::db::error::DbError> {
    match link {
        DeepLink::Open => Ok(None),
        DeepLink::Session { session_ref } => {
            let summary =
                conversation_service::find_live_by_session_ref(&db.conn, session_ref).await?;
            Ok(summary.map(FocusTarget::from_summary))
        }
        DeepLink::Workspace {
            folder_id,
            conversation_id,
            agent,
        } => {
            let Some(summary) =
                conversation_service::find_live_by_session_ref(&db.conn, &conversation_id.to_string())
                    .await?
            else {
                return Ok(None);
            };
            if folder_id.is_some_and(|id| id != summary.folder_id) {
                return Ok(None);
            }
            if agent.as_ref().is_some_and(|wanted| {
                wanted != summary.agent_type.as_wire().as_ref()
            }) {
                return Ok(None);
            }
            Ok(Some(FocusTarget::from_summary(summary)))
        }
    }
}

/// Nudge telling the workspace that a resolved deep link is waiting in
/// [`PENDING_FOCUS`]. Deliberately carries no payload — see that doc.
#[cfg(feature = "tauri-runtime")]
pub const PENDING_EVENT: &str = "workspace://deep-link-pending";

/// The one channel a resolved `codeg://` target travels on.
///
/// The obvious design — emit the target like the pet panel does — cannot work
/// here, in both directions. An emit reaches only webviews that *already*
/// registered a JS listener (Tauri's `emit_js_filter` skips the rest and
/// queues nothing), so a cold-start link is dropped: on macOS the launch URL
/// arrives as `RunEvent::Opened` after the setup hook, long before React
/// mounts `PetFocusBridge`. And an emitted target that is *also* parked can be
/// consumed twice — once from the payload, once from the slot — or linger and
/// re-open on a later mount.
///
/// So the target is only ever handed over by [`take_pending_deep_link`], which
/// is an atomic take: the mount-time drain and every nudge-driven drain
/// compete for one slot and exactly one of them wins. [`PENDING_EVENT`] is a
/// bare "come and get it" — dropping it during boot costs nothing because the
/// mount drain follows.
///
/// A single slot means a launch carrying several URLs focuses the last one
/// the frontend gets to, which is all a focus operation can mean anyway.
static PENDING_FOCUS: std::sync::Mutex<Option<FocusTarget>> = std::sync::Mutex::new(None);

/// Only the desktop URL handler parks targets; `codeg-server` compiles the
/// parser and the lookup but has no OS scheme to feed them.
#[cfg(any(feature = "tauri-runtime", test))]
fn set_pending_focus(target: FocusTarget) {
    if let Ok(mut slot) = PENDING_FOCUS.lock() {
        *slot = Some(target);
    }
}

/// Take the deep link the app was opened (or re-activated) with. Returns
/// `None` when there was none, or when another drain already claimed it.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn take_pending_deep_link() -> Option<FocusTarget> {
    PENDING_FOCUS.lock().ok().and_then(|mut slot| slot.take())
}

/// Collect `codeg:` URLs from a process argv (Windows / Linux second launch).
pub fn urls_from_argv(argv: &[impl AsRef<str>]) -> Vec<String> {
    argv.iter()
        .map(|arg| arg.as_ref().to_string())
        .filter(|arg| parse_deep_link(arg).is_some())
        .collect()
}

#[cfg(feature = "tauri-runtime")]
pub fn handle_raw_urls(app: &tauri::AppHandle, urls: &[String]) {
    use crate::commands::windows;
    use tauri::{Emitter, Manager};

    if urls.is_empty() {
        windows::show_main_window(app);
        return;
    }

    let Some(db) = app.try_state::<AppDatabase>() else {
        tracing::warn!(
            "[deep-link] database not ready; showing workspace for {} url(s)",
            urls.len()
        );
        windows::show_main_window(app);
        return;
    };
    let db = AppDatabase {
        conn: db.conn.clone(),
    };
    let app = app.clone();
    let urls = urls.to_vec();
    tauri::async_runtime::spawn(async move {
        let mut focused = false;
        for raw in &urls {
            let Some(link) = parse_deep_link(raw) else {
                continue;
            };
            match resolve_deep_link(&db, &link).await {
                Ok(Some(target)) => {
                    // Park, then nudge. The nudge never carries the target —
                    // see `PENDING_FOCUS` for why the slot has to be the only
                    // channel.
                    set_pending_focus(target);
                    windows::show_main_window(&app);
                    if let Err(err) = app.emit_to("main", PENDING_EVENT, ()) {
                        tracing::warn!("[deep-link] failed to signal main window: {err}");
                    }
                    focused = true;
                }
                Ok(None) => {
                    tracing::info!("[deep-link] no live conversation for {raw}");
                }
                Err(err) => {
                    tracing::warn!("[deep-link] {raw}: {err}");
                }
            }
        }
        if !focused {
            windows::show_main_window(&app);
        }
    });
}

#[cfg(feature = "tauri-runtime")]
pub fn handle_argv(app: &tauri::AppHandle, argv: &[String]) {
    handle_raw_urls(app, &urls_from_argv(argv));
}

/// Resolve the first session-targeting startup URL so the main window can
/// load `/workspace?folderId=…` on a cold start. `DeepLinkBootstrap` then
/// opens the tab after folders/tabs hydrate — an event emitted here would
/// race the webview's subscription.
///
/// This only fires where the plugin already knows the launch URL by the time
/// the setup hook runs, i.e. Windows/Linux (argv, parsed during plugin setup).
/// On macOS the URL arrives later as `RunEvent::Opened`, so `get_current()` is
/// empty here and the cold start is carried by [`PENDING_FOCUS`] instead. The
/// two paths are mutually exclusive: whichever delivery populated the plugin
/// before our `on_open_url` listener existed is the one that wins.
pub async fn startup_workspace_path(db: &AppDatabase, urls: &[String]) -> String {
    for raw in urls {
        let Some(link) = parse_deep_link(raw) else {
            continue;
        };
        if matches!(link, DeepLink::Open) {
            continue;
        }
        match resolve_deep_link(db, &link).await {
            Ok(Some(target)) => return target.workspace_path(),
            Ok(None) => tracing::info!("[deep-link] startup url did not match a live session: {raw}"),
            Err(err) => tracing::warn!("[deep-link] startup {raw}: {err}"),
        }
    }
    "workspace".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;
    use sea_orm::{ActiveModelTrait, EntityTrait, Set};

    #[test]
    fn parses_session_numeric_id() {
        assert_eq!(
            parse_deep_link("codeg://session/214"),
            Some(DeepLink::Session {
                session_ref: "214".into()
            })
        );
        assert_eq!(
            parse_deep_link("codeg:session/214"),
            Some(DeepLink::Session {
                session_ref: "214".into()
            })
        );
        assert_eq!(
            parse_deep_link("codeg://session/214/"),
            Some(DeepLink::Session {
                session_ref: "214".into()
            })
        );
    }

    #[test]
    fn parses_session_external_id() {
        assert_eq!(
            parse_deep_link("codeg://session/0193c0de-aaaa-7bbb-8ccc-ddddeeeeffff"),
            Some(DeepLink::Session {
                session_ref: "0193c0de-aaaa-7bbb-8ccc-ddddeeeeffff".into()
            })
        );
        assert_eq!(
            parse_deep_link("codeg://session/codex_abc%20123"),
            Some(DeepLink::Session {
                session_ref: "codex_abc 123".into()
            })
        );
    }

    /// The `url` crate lower-cases a URL's host before `event.urls()` hands it
    /// over, but an argv-delivered link keeps the caller's casing, so the
    /// `session` segment must match either way. The ref after it must not — an
    /// `external_id` is an opaque token.
    #[test]
    fn session_segment_is_case_insensitive_but_the_ref_is_not() {
        for raw in [
            "codeg://SESSION/Codex_AbC",
            "codeg://Session/Codex_AbC",
            "codeg://sEsSiOn/Codex_AbC",
        ] {
            assert_eq!(
                parse_deep_link(raw),
                Some(DeepLink::Session {
                    session_ref: "Codex_AbC".into()
                }),
                "{raw}"
            );
        }
    }

    #[test]
    fn rejects_path_traversal_and_in_app_badges() {
        assert_eq!(parse_deep_link("codeg://session/../etc/passwd"), None);
        assert_eq!(parse_deep_link("codeg://session/"), None);
        assert_eq!(parse_deep_link("codeg://agent/grok"), None);
        assert_eq!(parse_deep_link("codeg://commit/abc"), None);
        assert_eq!(parse_deep_link("https://example.com/session/1"), None);
    }

    #[test]
    fn parses_open_and_workspace_query() {
        assert_eq!(parse_deep_link("codeg://"), Some(DeepLink::Open));
        assert_eq!(parse_deep_link("codeg://open"), Some(DeepLink::Open));
        assert_eq!(
            parse_deep_link("codeg://workspace?conversationId=9&folderId=3&agent=grok"),
            Some(DeepLink::Workspace {
                folder_id: Some(3),
                conversation_id: 9,
                agent: Some("grok".into()),
            })
        );
        assert_eq!(
            parse_deep_link("codeg://workspace?conversationId=9"),
            Some(DeepLink::Workspace {
                folder_id: None,
                conversation_id: 9,
                agent: None,
            })
        );
        assert_eq!(parse_deep_link("codeg://workspace"), None);
    }

    #[test]
    fn argv_keeps_only_codeg_urls() {
        let argv = [
            "/Applications/codeg.app/Contents/MacOS/codeg",
            "codeg://session/12",
            "--flag",
        ];
        assert_eq!(urls_from_argv(&argv), vec!["codeg://session/12".to_string()]);
    }

    #[tokio::test]
    async fn resolves_numeric_and_external_ids() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;

        let by_pk = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: id.to_string(),
            },
        )
        .await
        .expect("lookup pk");
        assert_eq!(
            by_pk,
            Some(FocusTarget {
                folder_id: folder,
                conversation_id: id,
                agent: "grok".into(),
            })
        );

        let mut active: crate::db::entities::conversation::ActiveModel =
            crate::db::entities::conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .expect("load")
                .expect("row")
                .into();
        active.external_id = Set(Some("grok-session-uuid".into()));
        active.update(&db.conn).await.expect("set external_id");

        let by_ext = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: "grok-session-uuid".into(),
            },
        )
        .await
        .expect("lookup external");
        assert_eq!(by_ext.as_ref().map(|t| t.conversation_id), Some(id));

        let missing = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: "999999".into(),
            },
        )
        .await
        .expect("missing");
        assert_eq!(missing, None);
    }

    /// Nothing stops an agent from issuing all-digit session ids, so an
    /// all-digit ref that matches no live primary key must still be tried as
    /// an `external_id` rather than reported as a dead link.
    #[tokio::test]
    async fn numeric_ref_falls_back_to_external_id() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-numeric").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;

        // An external id that can never collide with a live PK.
        let external = "90210";
        assert_ne!(external.parse::<i32>().ok(), Some(id));
        let mut active: crate::db::entities::conversation::ActiveModel =
            crate::db::entities::conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .expect("load")
                .expect("row")
                .into();
        active.external_id = Set(Some(external.into()));
        active.update(&db.conn).await.expect("set external_id");

        let resolved = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: external.into(),
            },
        )
        .await
        .expect("lookup numeric external");
        assert_eq!(resolved.as_ref().map(|t| t.conversation_id), Some(id));
    }

    /// The parked-target handoff that carries a macOS cold start, where the
    /// `workspace://focus-conversation` emit lands before the webview listens.
    /// Single test on purpose: `PENDING_FOCUS` is process-global.
    #[test]
    fn pending_focus_is_taken_exactly_once() {
        assert_eq!(take_pending_deep_link(), None);
        let target = FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "grok".into(),
        };
        set_pending_focus(target.clone());
        assert_eq!(take_pending_deep_link(), Some(target));
        assert_eq!(take_pending_deep_link(), None);
    }

    #[test]
    fn pending_focus_serializes_like_the_focus_event() {
        let json = serde_json::to_value(FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "claude_code".into(),
        })
        .expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "folderId": 3,
                "conversationId": 9,
                "agent": "claude_code",
            })
        );
    }

    #[tokio::test]
    async fn startup_path_resolves_first_session_url_else_plain_workspace() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-startup").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;

        assert_eq!(startup_workspace_path(&db, &[]).await, "workspace");
        assert_eq!(
            startup_workspace_path(&db, &["codeg://open".into()]).await,
            "workspace"
        );
        assert_eq!(
            startup_workspace_path(&db, &["codeg://session/999999".into()]).await,
            "workspace"
        );
        assert_eq!(
            startup_workspace_path(
                &db,
                &[
                    "--some-flag".into(),
                    "codeg://open".into(),
                    format!("codeg://session/{id}"),
                ]
            )
            .await,
            format!("workspace?folderId={folder}&conversationId={id}&agent=grok")
        );
    }

    #[tokio::test]
    async fn workspace_query_fills_agent_and_rejects_mismatch() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-ws").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;

        let filled = resolve_deep_link(
            &db,
            &DeepLink::Workspace {
                folder_id: None,
                conversation_id: id,
                agent: None,
            },
        )
        .await
        .expect("fill");
        assert_eq!(filled.unwrap().agent, "grok");

        let mismatch = resolve_deep_link(
            &db,
            &DeepLink::Workspace {
                folder_id: None,
                conversation_id: id,
                agent: Some("codex".into()),
            },
        )
        .await
        .expect("mismatch");
        assert_eq!(mismatch, None);
    }

    #[test]
    fn workspace_path_encodes_query() {
        let path = FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "claude_code".into(),
        }
        .workspace_path();
        assert_eq!(
            path,
            "workspace?folderId=3&conversationId=9&agent=claude_code"
        );
    }
}
