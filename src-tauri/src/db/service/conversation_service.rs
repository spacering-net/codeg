use std::collections::HashMap;

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, Set,
};

use crate::db::entities::conversation::ConversationKind;
use crate::db::entities::{conversation, folder};
use crate::db::error::DbError;
use crate::models::{AgentType, DbConversationSummary};

pub async fn create(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: AgentType,
    title: Option<String>,
    git_branch: Option<String>,
) -> Result<conversation::Model, DbError> {
    create_inner(
        conn,
        folder_id,
        agent_type,
        title,
        git_branch,
        None,
        ConversationKind::Regular,
    )
    .await
}

/// Mirror of [`create`] for folderless chat-mode conversations: identical row
/// shape but `kind = 'chat'`, so the sidebar routes the row to its flat "Chat"
/// section. Callers must pair it with the hidden chat folder created in the
/// same flow (`create_chat_conversation_core`).
pub async fn create_chat(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: AgentType,
    title: Option<String>,
    git_branch: Option<String>,
) -> Result<conversation::Model, DbError> {
    create_inner(
        conn,
        folder_id,
        agent_type,
        title,
        git_branch,
        None,
        ConversationKind::Chat,
    )
    .await
}

/// Mirror of [`create`] plus optional delegation linkage. Used by the
/// multi-agent broker when spawning a child sub-session — populates
/// `parent_id` / `parent_tool_use_id` / `delegation_call_id` so the lifecycle
/// subscriber and frontend can rebuild the parent ↔ child binding without
/// inspecting the live broker state. `kind` follows the invariant
/// `delegate ⟺ parent_id set`.
pub async fn create_with_delegation(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: AgentType,
    title: Option<String>,
    git_branch: Option<String>,
    delegation: Option<crate::acp::delegation::spawner::DelegationLink>,
) -> Result<conversation::Model, DbError> {
    let kind = if delegation.is_some() {
        ConversationKind::Delegate
    } else {
        ConversationKind::Regular
    };
    create_inner(
        conn, folder_id, agent_type, title, git_branch, delegation, kind,
    )
    .await
}

async fn create_inner(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: AgentType,
    title: Option<String>,
    git_branch: Option<String>,
    delegation: Option<crate::acp::delegation::spawner::DelegationLink>,
    kind: ConversationKind,
) -> Result<conversation::Model, DbError> {
    let at_str = serde_json::to_value(agent_type)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    let now = Utc::now();
    let (parent_id, parent_tool_use_id, delegation_call_id) = match delegation {
        Some(link) => (
            Some(link.parent_conversation_id),
            Some(link.parent_tool_use_id),
            Some(link.delegation_call_id),
        ),
        None => (None, None, None),
    };
    let model = conversation::ActiveModel {
        id: NotSet,
        folder_id: Set(folder_id),
        title: Set(title),
        title_locked: Set(false),
        agent_type: Set(at_str),
        status: Set(conversation::ConversationStatus::InProgress),
        kind: Set(kind),
        model: Set(None),
        git_branch: Set(git_branch),
        external_id: Set(None),
        parent_id: Set(parent_id),
        parent_tool_use_id: Set(parent_tool_use_id),
        delegation_call_id: Set(delegation_call_id),
        message_count: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
        pinned_at: Set(None),
        origin_cwd: Set(None),
    };
    Ok(model.insert(conn).await?)
}

pub async fn update_status(
    conn: &DatabaseConnection,
    conversation_id: i32,
    status: conversation::ConversationStatus,
) -> Result<(), DbError> {
    let conv = conversation::Entity::find_by_id(conversation_id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("Conversation not found: {conversation_id}")))?;
    let mut active: conversation::ActiveModel = conv.into();
    active.status = Set(status);
    active.updated_at = Set(Utc::now());
    active.update(conn).await?;
    Ok(())
}

/// Conditional status transition (CAS): write `new_status` only if the row's
/// current `status` equals `expected`. Returns `true` when the row was
/// updated. Used by the lifecycle subscriber on disconnect/error so a
/// concurrent user-driven `completed` (or a prior `pending_review` from
/// `TurnComplete`) cannot be silently overwritten.
pub async fn update_status_if(
    conn: &DatabaseConnection,
    conversation_id: i32,
    expected: conversation::ConversationStatus,
    new_status: conversation::ConversationStatus,
) -> Result<bool, DbError> {
    use sea_orm::sea_query::Expr;
    let result = conversation::Entity::update_many()
        .col_expr(conversation::Column::Status, Expr::value(new_status))
        .col_expr(conversation::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(conversation::Column::Id.eq(conversation_id))
        .filter(conversation::Column::Status.eq(expected))
        .exec(conn)
        .await?;
    Ok(result.rows_affected > 0)
}

/// Manual rename: set the title AND lock it. Once locked, the per-turn
/// auto-title backfill ([`refresh_auto_title`]) leaves this row alone, so the
/// user's hand-picked name survives every subsequent session-file parse.
pub async fn update_title(
    conn: &DatabaseConnection,
    conversation_id: i32,
    title: String,
) -> Result<(), DbError> {
    let conv = conversation::Entity::find_by_id(conversation_id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("Conversation not found: {conversation_id}")))?;
    let mut active: conversation::ActiveModel = conv.into();
    active.title = Set(Some(title));
    active.title_locked = Set(true);
    active.updated_at = Set(Utc::now());
    active.update(conn).await?;
    Ok(())
}

/// Auto-derive counterpart to [`update_title`]: write `title` ONLY when the row
/// is not user-locked and the value actually changed. Never sets `title_locked`
/// (the title stays eligible for future auto-refreshes, e.g. when an agent like
/// OpenCode regenerates its own session title) and deliberately does NOT bump
/// `updated_at` — a title backfill is metadata, not user activity, so it must
/// not float the row to the top of a recency-sorted sidebar. Returns `true`
/// when a row was written so the caller can broadcast a sidebar upsert.
///
/// Implemented as a single conditional UPDATE (`... WHERE id = ? AND
/// title_locked = false AND (title IS NULL OR title <> ?)`) so the lock/equality
/// checks and the write are atomic: a manual rename ([`update_title`], which
/// sets `title_locked = true`) that lands between a would-be read and the write
/// can never be clobbered, because the lock predicate is re-evaluated at write
/// time by the database. A non-existent row simply matches nothing (`false`).
pub async fn refresh_auto_title(
    conn: &DatabaseConnection,
    conversation_id: i32,
    title: String,
) -> Result<bool, DbError> {
    use sea_orm::sea_query::Expr;
    let title = title.trim();
    if title.is_empty() {
        return Ok(false);
    }
    let res = conversation::Entity::update_many()
        .col_expr(conversation::Column::Title, Expr::value(title))
        .filter(conversation::Column::Id.eq(conversation_id))
        .filter(conversation::Column::TitleLocked.eq(false))
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(
            sea_orm::Condition::any()
                .add(conversation::Column::Title.is_null())
                .add(conversation::Column::Title.ne(title)),
        )
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// First-prompt seed: write `title` ONLY when the row is unlocked AND still
/// empty. Unlike [`refresh_auto_title`], this will not replace an existing
/// name — a later user prompt must not overwrite the first one, and an
/// agent-generated ACP title that already landed must not be clobbered by
/// the next send. Returns `true` when a row was written so the caller can
/// broadcast a sidebar upsert. Does not bump `updated_at` or set the lock.
pub async fn seed_auto_title_if_empty(
    conn: &DatabaseConnection,
    conversation_id: i32,
    title: String,
) -> Result<bool, DbError> {
    use sea_orm::sea_query::Expr;
    let title = title.trim();
    if title.is_empty() {
        return Ok(false);
    }
    let res = conversation::Entity::update_many()
        .col_expr(conversation::Column::Title, Expr::value(title))
        .filter(conversation::Column::Id.eq(conversation_id))
        .filter(conversation::Column::TitleLocked.eq(false))
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(
            sea_orm::Condition::any()
                .add(conversation::Column::Title.is_null())
                .add(conversation::Column::Title.eq("")),
        )
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// Write the session's `model` ONLY when the row still has none. The sibling
/// of [`seed_auto_title_if_empty`], and for the same reason: a conversation
/// row is inserted before the agent has named a model, so the column is NULL
/// for every session started in-app and only the transcript knows the answer.
/// Without this the sidebar — which reads the row, not the transcript — could
/// only show a model for imported sessions.
///
/// First value wins. The detail view re-reads the transcript on every open and
/// stays exact, so the stored value is a cheap projection for the list rather
/// than a second source of truth; re-writing it on every model switch would
/// buy a row write per switch for a chip nobody reads mid-turn.
///
/// Returns `true` when a row was written so the caller can broadcast a sidebar
/// upsert. Does not bump `updated_at` — the sidebar sorts on it, and merely
/// opening a conversation must not float it to the top of Recent (same
/// reasoning as [`update_pin`]).
pub async fn seed_model_if_empty(
    conn: &DatabaseConnection,
    conversation_id: i32,
    model: &str,
) -> Result<bool, DbError> {
    use sea_orm::sea_query::Expr;
    let model = model.trim();
    if model.is_empty() {
        return Ok(false);
    }
    let res = conversation::Entity::update_many()
        .col_expr(conversation::Column::Model, Expr::value(model))
        .filter(conversation::Column::Id.eq(conversation_id))
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(
            sea_orm::Condition::any()
                .add(conversation::Column::Model.is_null())
                .add(conversation::Column::Model.eq("")),
        )
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// Lock a row's title WITHOUT rewriting it. For a conversation whose name was
/// typed by the user somewhere else — a work task's title, an automation's name
/// — the seed passed to [`create`] already IS the name; all that's missing is
/// the promise that [`refresh_auto_title`] will keep its hands off it, exactly
/// as it does after a manual rename ([`update_title`]).
///
/// Without this, a task-launched session drifts to whatever the agent's session
/// file parses to — for agents with no title of their own, the first line of the
/// composed prompt — and the board's own name for the work is lost (issue #495).
///
/// Deliberately does NOT touch `title` or bump `updated_at`: like
/// [`refresh_auto_title`], flipping this flag is metadata, not user activity,
/// and must not float the row to the top of a recency-sorted sidebar. A
/// non-existent row simply matches nothing.
///
/// Callers must lock BEFORE broadcasting the row's first sidebar upsert: the
/// conversation id is not knowable to any client until that broadcast, so
/// locking first makes an auto-title backfill on this row impossible rather
/// than merely unlikely.
pub async fn lock_title(conn: &DatabaseConnection, conversation_id: i32) -> Result<(), DbError> {
    use sea_orm::sea_query::Expr;
    conversation::Entity::update_many()
        .col_expr(conversation::Column::TitleLocked, Expr::value(true))
        .filter(conversation::Column::Id.eq(conversation_id))
        .exec(conn)
        .await?;
    Ok(())
}

/// Rename a locked title when its OWNER was renamed: write `new_title` only if
/// the row still carries `expected`. Used when a work task is retitled — the
/// session it produced should follow the card it came from, but only while the
/// two are still in sync.
///
/// The equality guard is the whole point. Both a task-derived title and a hand
/// picked one leave `title_locked = true`, so the flag alone cannot tell them
/// apart; `expected` (the task's PREVIOUS title) can. If the user renamed the
/// conversation themselves, nothing matches and not a byte is written. Same
/// optimistic shape as [`refresh_auto_title`]: one conditional UPDATE, so the
/// comparison happens at write time in the database and a rename landing in
/// between can never be clobbered. Returns `true` when a row was written.
///
/// Leaves `title_locked` alone (already true for every row this can match) and,
/// like its siblings, does not bump `updated_at`.
pub async fn retitle_if_unchanged(
    conn: &DatabaseConnection,
    conversation_id: i32,
    expected: &str,
    new_title: &str,
) -> Result<bool, DbError> {
    use sea_orm::sea_query::Expr;
    let new_title = new_title.trim();
    if new_title.is_empty() || new_title == expected {
        return Ok(false);
    }
    let res = conversation::Entity::update_many()
        .col_expr(conversation::Column::Title, Expr::value(new_title))
        .filter(conversation::Column::Id.eq(conversation_id))
        .filter(conversation::Column::Title.eq(expected))
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// Conditionally adopt one title discovered from Codex's session index.
///
/// Every field used to select the candidate is re-checked in the UPDATE, plus
/// the title observed by the candidate read. This prevents a delayed refresh
/// from writing an index title after the row was re-pointed, deleted, manually
/// renamed, moved into a deleted folder, or refreshed by another task.
///
/// `kind` is deliberately absent: it is written once at insert and never
/// updated, so the candidate query's filter cannot go stale between the two.
async fn refresh_codex_auto_title_candidate(
    conn: &DatabaseConnection,
    candidate: &conversation::Model,
    title: &str,
) -> Result<bool, DbError> {
    use sea_orm::sea_query::Expr;

    let title = title.trim();
    let Some(external_id) = candidate.external_id.as_deref() else {
        return Ok(false);
    };
    if title.is_empty() || candidate.title.as_deref() == Some(title) {
        return Ok(false);
    }

    let old_title = match candidate.title.as_deref() {
        Some(old_title) => conversation::Column::Title.eq(old_title),
        None => conversation::Column::Title.is_null(),
    };
    let res = conversation::Entity::update_many()
        .col_expr(conversation::Column::Title, Expr::value(title))
        .filter(conversation::Column::Id.eq(candidate.id))
        .filter(conversation::Column::AgentType.eq(AgentType::Codex.as_wire().into_owned()))
        .filter(conversation::Column::ExternalId.eq(external_id))
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::TitleLocked.eq(false))
        .filter(
            conversation::Column::FolderId.in_subquery(
                sea_orm::sea_query::Query::select()
                    .column(folder::Column::Id)
                    .from(folder::Entity)
                    .and_where(folder::Column::DeletedAt.is_null())
                    .to_owned(),
            ),
        )
        .filter(old_title)
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// Refresh every live, unlocked Codex conversation whose external session id
/// has a title in `titles`. Candidate selection is limited to indexed session
/// ids and chunked below SQLite's bound-variable limit. Each UPDATE atomically
/// re-checks the complete candidate identity via
/// [`refresh_codex_auto_title_candidate`]. Converged rows issue no UPDATE and
/// title refreshes never bump `updated_at`. This is a best-effort reconciliation:
/// a failed chunk or row is logged and skipped while successful row ids are
/// retained for downstream notifications.
///
/// Candidate scope mirrors [`list_all`]'s own visibility rules — a live folder
/// and `kind != 'loop'` — because every refreshed id is broadcast as a sidebar
/// upsert. Refreshing a row this query would never return would push a row the
/// list deliberately hides into every client's sidebar until its next refetch.
///
/// Each candidate keeps its OWN autocommit UPDATE rather than sharing one
/// transaction per chunk: the guarantee callers rely on is that a row that
/// failed (or lost its CAS) never holds back the rows that succeeded, and a
/// chunk-wide transaction would roll those back together.
pub(crate) async fn refresh_codex_auto_titles(
    conn: &DatabaseConnection,
    titles: &HashMap<String, String>,
) -> Vec<i32> {
    if titles.is_empty() {
        return Vec::new();
    }

    const SQLITE_TITLE_QUERY_CHUNK_SIZE: usize = 500;
    let external_ids: Vec<String> = titles
        .iter()
        .filter(|(_, title)| !title.trim().is_empty())
        .map(|(external_id, _)| external_id.clone())
        .collect();
    let mut refreshed = Vec::new();

    for external_id_chunk in external_ids.chunks(SQLITE_TITLE_QUERY_CHUNK_SIZE) {
        let candidates = match conversation::Entity::find()
            .filter(conversation::Column::AgentType.eq(AgentType::Codex.as_wire().into_owned()))
            .filter(conversation::Column::ExternalId.is_in(external_id_chunk.iter().cloned()))
            .filter(conversation::Column::DeletedAt.is_null())
            .filter(conversation::Column::TitleLocked.eq(false))
            .filter(conversation::Column::Kind.ne(ConversationKind::Loop))
            .filter(
                conversation::Column::FolderId.in_subquery(
                    sea_orm::sea_query::Query::select()
                        .column(folder::Column::Id)
                        .from(folder::Entity)
                        .and_where(folder::Column::DeletedAt.is_null())
                        .to_owned(),
                ),
            )
            .order_by_asc(conversation::Column::Id)
            .all(conn)
            .await
        {
            Ok(candidates) => candidates,
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    session_count = external_id_chunk.len(),
                    "failed to select Codex title refresh candidates; skipping chunk"
                );
                continue;
            }
        };

        for candidate in candidates {
            let Some(external_id) = candidate.external_id.as_deref() else {
                continue;
            };
            let Some(title) = titles.get(external_id) else {
                continue;
            };
            match refresh_codex_auto_title_candidate(conn, &candidate, title).await {
                Ok(true) => refreshed.push(candidate.id),
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    error = %error,
                    conversation_id = candidate.id,
                    external_id,
                    "failed to refresh Codex title candidate; skipping row"
                ),
            }
        }
    }

    refreshed
}

/// Adopt an imported conversation's newest activity from its agent-side
/// transcript: stamp `updated_at` with the session file's own last-activity
/// time (never `now()` — the scan is not the activity) and re-sync
/// `message_count`. Returns `true` when a row was written, so the caller can
/// broadcast a sidebar upsert.
///
/// This is the counterpart to [`refresh_auto_title`] for the OTHER half of a
/// re-import: a session the user kept working on in the agent's own CLI after
/// importing it into codeg. Its title may be unchanged while its activity is
/// hours newer, and `updated_at` is what the sidebar's "recently updated"
/// ordering (and the relative timestamp on each row) reads.
///
/// One conditional UPDATE, guarded so it can never do harm:
/// * `updated_at < activity_at` — strictly forward. A re-import can never move
///   a conversation backwards or re-order an unchanged one, re-running is a
///   no-op, and a turn running live in codeg (which stamps `updated_at =
///   now()`) wins over a transcript tail parsed moments earlier.
/// * `deleted_at IS NULL` — a soft-deleted conversation stays deleted; agent
///   activity must not half-resurrect an invisible row.
/// * `parent_id IS NULL` — delegation children are not sidebar rows and are
///   maintained by the delegation flow.
///
/// Everything else the user owns is left alone: `created_at`, `title` (and its
/// lock), `pinned_at`, `status`, and folder placement.
pub async fn refresh_external_activity(
    conn: &DatabaseConnection,
    conversation_id: i32,
    activity_at: chrono::DateTime<Utc>,
    message_count: u32,
) -> Result<bool, DbError> {
    use sea_orm::sea_query::Expr;
    let res = conversation::Entity::update_many()
        .col_expr(conversation::Column::UpdatedAt, Expr::value(activity_at))
        .col_expr(
            conversation::Column::MessageCount,
            Expr::value(message_count as i32),
        )
        .filter(conversation::Column::Id.eq(conversation_id))
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::ParentId.is_null())
        .filter(conversation::Column::UpdatedAt.lt(activity_at))
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// Pin or unpin a conversation. Sets `pinned_at = now()` when pinning, `NULL`
/// when unpinning. Only the `pinned_at` column is written — `updated_at` is
/// deliberately left untouched (SeaORM updates only the `Set` field), because
/// pinning is a view preference, not conversation activity, and must not float
/// the row to the top of a recency-sorted sidebar (same reasoning as
/// [`refresh_auto_title`]). The sidebar's "Pinned" section orders by `pinned_at`
/// descending, so a freshly pinned conversation jumps to the top.
pub async fn update_pin(
    conn: &DatabaseConnection,
    conversation_id: i32,
    pinned: bool,
) -> Result<(), DbError> {
    let conv = conversation::Entity::find_by_id(conversation_id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("Conversation not found: {conversation_id}")))?;
    let mut active: conversation::ActiveModel = conv.into();
    active.pinned_at = Set(pinned.then(Utc::now));
    active.update(conn).await?;
    Ok(())
}

/// Bind an agent session id (`external_id`) to a conversation row WITHOUT ever
/// orphaning the session it was previously bound to.
///
/// Returns `Some(preserved_row_id)` when the previous session had to be moved
/// onto a freshly inserted row to keep it reachable, `None` when the write was
/// an ordinary (re)binding that created nothing.
///
/// Either `Ok` is a promise the caller builds on: **the row is now bound to
/// `external_id`**. `send_prompt_linked` flips the row to `InProgress` and
/// dispatches the prompt on exactly that basis. When the id cannot be taken
/// because another row holds it, this returns [`DbError::Conflict`] rather than
/// a quiet `Ok(None)` — see the conflict guard in the body for why reporting a
/// refusal as success would misfile the user's turn.
///
/// # The invariant
///
/// **After this commits, the previous session's history is still reachable.**
///
/// Stated as a post-condition on purpose. The tempting phrasing ("before
/// re-pointing, some other row must already hold S1") reads as an ordering
/// requirement and leads straight into the unique index below.
///
/// Note "history is reachable", not "some row holds the id". `continues` is
/// what separates the two: it lists the sessions the INCOMING id carries
/// forward (see [`crate::acp::continued_session_ids`]). When the outgoing id
/// is one of them, this is the same conversation moving to a new agent
/// session — its turns are still readable through the new id, so the row just
/// advances and nothing is split off. Passing an empty slice is always safe
/// in the sense that it never loses data; it only risks splitting a
/// continuation into a duplicate conversation.
///
/// Why it matters: the conversation list is built purely from DB rows
/// (`list_all`) — nothing scans the agent's own transcript store. So a session
/// id that no row references is invisible in the UI even though its transcript
/// is intact on disk, and the user reasonably reads that as "my conversation
/// was deleted". That is codeg#500: a connection spawned with `session_id =
/// None` mints a fresh session, then a prompt carrying an existing
/// `conversation_id` adopts that row and the fresh id lands on top of the id
/// the row's whole history hangs off.
///
/// # Why the writes are ordered the way they are
///
/// `idx_conversation_external_agent` is UNIQUE over
/// `(external_id, agent_type)` (see the init migration). So the preserving row
/// can only be inserted AFTER the current row has released S1 — insert-first
/// fails the constraint every time. Both statements share one transaction, so
/// the "S1 released but nobody holds it" window can never be observed by
/// another connection and never commits. (SQLite treats NULLs as distinct, so
/// any number of rows may sit at `external_id IS NULL`.)
///
/// The claim write that opens the transaction is a SELF-ASSIGNMENT
/// (`updated_at = updated_at`). It exists for the same reason as the one in
/// `persist_fork_outcome` — lead with a write so SQLite takes the writer lock
/// immediately instead of a deferred read snapshot it may fail to promote
/// (`SQLITE_BUSY_SNAPSHOT`, surfaced as a bogus "database is locked") — but it
/// must not CHANGE `updated_at`, because the row is read straight afterwards
/// and the preserving row copies that pre-transition timestamp to hold its
/// place in the sidebar's activity ordering. A self-assigning UPDATE still
/// matches the row and still claims the lock.
///
/// The `deleted_at IS NULL` guard is inherited from the previous
/// `update_external_id`: `SessionStarted` writes are not serialized against
/// deletes (deleting only soft-marks the row; the agent stays connected and
/// bound), so a late event must not half-resurrect an invisible row.
pub async fn bind_external_id(
    conn: &DatabaseConnection,
    conversation_id: i32,
    external_id: &str,
    continues: &[String],
) -> Result<Option<i32>, DbError> {
    use sea_orm::sea_query::Expr;
    use sea_orm::TransactionTrait;

    let external_id = external_id.to_string();
    let continues: Vec<String> = continues.to_vec();
    // The closure below MOVES `external_id`; keep a copy for the conflict
    // message, which is built after the transaction has returned.
    let requested_id = external_id.clone();
    let outcome = conn
        .transaction::<_, BindTxOutcome, sea_orm::DbErr>(|txn| {
            Box::pin(async move {
                let now = Utc::now();

                // Claim the writer lock without disturbing any value.
                let claimed = conversation::Entity::update_many()
                    .col_expr(
                        conversation::Column::UpdatedAt,
                        Expr::col(conversation::Column::UpdatedAt).into(),
                    )
                    .filter(conversation::Column::Id.eq(conversation_id))
                    .filter(conversation::Column::DeletedAt.is_null())
                    .exec(txn)
                    .await?;
                if claimed.rows_affected == 0 {
                    // Gone or soft-deleted. Every caller treats "no live row" as
                    // nothing to do, so this stays Ok — same contract the old
                    // `update_external_id` had.
                    return Ok(BindTxOutcome::Bound(None));
                }

                // Read under the write lock: pristine values, and no other
                // writer can interpose before this transaction finishes.
                let current = conversation::Entity::find_by_id(conversation_id)
                    .one(txn)
                    .await?
                    .ok_or_else(|| {
                        sea_orm::DbErr::Custom(format!("conversation {conversation_id} not found"))
                    })?;

                let previous = current.external_id.clone();
                let repoints_away = matches!(
                    previous.as_deref(),
                    Some(prev) if prev != external_id && !continues.iter().any(|c| c == prev)
                );

                // Conflict guard, covering BOTH write branches below.
                //
                // `idx_conversation_external_agent` is UNIQUE over
                // `(external_id, agent_type)` and — unlike every read in this
                // module — carries no `deleted_at` predicate, so a soft-deleted
                // row still occupies its id. Claiming an id another row holds
                // therefore fails the constraint outright, rolls the whole
                // transaction back, and surfaces a raw "UNIQUE constraint
                // failed" out of `send_prompt_linked`: the user's prompt just
                // errors. Both branches are exposed — the plain bind (a fresh
                // row whose connection resumed a session codeg already has a
                // row for) as much as the split's release.
                //
                // Refuse instead, and change nothing. The invariant still
                // holds, from both ends: this row keeps the session it had, and
                // the incoming session is already reachable through the row
                // that holds it. Taking the id would orphan THAT row's history
                // — the very failure this function exists to prevent — so there
                // is no better move available here, only a louder one.
                //
                // A soft-deleted holder is refused on the same terms rather
                // than having its id taken, matching how the rest of this
                // module treats rows the sidebar never shows (`import_one` and
                // `refresh_existing` return `Skipped` for one instead of
                // rewriting it). Conversations have no restore path, so such a
                // row is inert — but it is inert with the id, and the index
                // counts it.
                //
                // Skipped when this row already holds the id: it is then the
                // holder, so by the same index no other row can be.
                //
                // Surfaced as `DbError::Conflict`, NOT as a quiet `Ok(None)`.
                // The distinction is load-bearing: `Ok` here means "this row is
                // bound to `external_id`", and `send_prompt_linked` goes on to
                // flip the row to `InProgress` and dispatch the prompt on that
                // basis. A refusal reported as success would send the turn into
                // a session the row does not own — it would land in the HOLDER
                // row's transcript while every event named the refused row, so
                // the user's message would move conversations on reload. An
                // `Err` returns before either step, exactly as the raw unique
                // violation used to, and the retry in
                // `lifecycle::handle_event_with_retry` gives up after three
                // attempts.
                if previous.as_deref() != Some(external_id.as_str()) {
                    let holder = conversation::Entity::find()
                        .filter(conversation::Column::ExternalId.eq(external_id.clone()))
                        .filter(conversation::Column::AgentType.eq(current.agent_type.clone()))
                        .filter(conversation::Column::Id.ne(conversation_id))
                        .one(txn)
                        .await?;
                    if let Some(holder) = holder {
                        // Logged here rather than left to the caller: these
                        // fields are what post-hoc diagnosis needs, and the
                        // error string that reaches the user must stay short.
                        tracing::warn!(
                            conversation_id,
                            holder_row_id = holder.id,
                            holder_deleted = holder.deleted_at.is_some(),
                            from_session = previous.as_deref().unwrap_or("<none>"),
                            to_session = %external_id,
                            agent_type = %current.agent_type,
                            "[conversation] refused to bind a session another row \
                             already holds; both histories left where they are"
                        );
                        return Ok(BindTxOutcome::Refused {
                            holder_row_id: holder.id,
                        });
                    }
                }

                // A row that already holds this id, or holds none yet, is an
                // ordinary bind: first bind, resume, or a duplicate
                // SessionStarted. A row whose id the INCOMING session carries
                // forward is one too — same conversation, new agent session,
                // with the earlier turns still readable through the new id (see
                // `continues`). Splitting that would clone the conversation in
                // the sidebar every time a memory-only custom agent restarts.
                // Nothing to preserve in any of these.
                if !repoints_away {
                    let mut active: conversation::ActiveModel = current.into();
                    active.external_id = Set(Some(external_id));
                    active.updated_at = Set(now);
                    active.update(txn).await?;
                    return Ok(BindTxOutcome::Bound(None));
                }

                let previous = previous.expect("repoints_away implies a previous id");

                // Does another live row already carry the outgoing session?
                //
                // Under today's schema it cannot: this row holds `previous`,
                // and the unique index admits exactly one holder per
                // `(external_id, agent_type)`. The cases that look like they
                // produce it do not. Fork writes its sibling INSERT and its
                // re-point in ONE transaction, so `previous` is observable only
                // on this row (before) or on the sibling with this row already
                // advanced (after — and then `repoints_away` is false and we
                // never reach here). A replayed `SessionStarted` is likewise
                // the idempotent branch above.
                //
                // Kept as a guard rather than an assert because the cost is one
                // indexed lookup and the failure it covers is silent data loss:
                // if the index is ever narrowed (a partial `WHERE deleted_at IS
                // NULL` would do it), two rows COULD hold `previous`, and
                // preserving it a second time would then insert a duplicate
                // conversation for history that already has a home.
                let already_preserved = conversation::Entity::find()
                    .filter(conversation::Column::ExternalId.eq(previous.clone()))
                    .filter(conversation::Column::AgentType.eq(current.agent_type.clone()))
                    .filter(conversation::Column::Id.ne(conversation_id))
                    .filter(conversation::Column::DeletedAt.is_null())
                    .one(txn)
                    .await?
                    .is_some();

                // Snapshot what the preserving row inherits BEFORE the re-point
                // consumes `current`.
                let carried = CarriedOverRow::from(&current);

                // Release S1 first — the unique index leaves no other order.
                let mut active: conversation::ActiveModel = current.into();
                active.external_id = Set(Some(external_id.clone()));
                // The model described the session being released, and `carried`
                // has already taken it for the row that keeps S1's history. Left
                // in place it would name S1's model on a row that is now S2 —
                // and `seed_model_if_empty` only fills an EMPTY column, so
                // nothing would ever correct it. Cleared, S2 seeds itself on its
                // next open.
                active.model = Set(None);
                active.updated_at = Set(now);
                active.update(txn).await?;

                if already_preserved {
                    tracing::info!(
                        conversation_id,
                        from_session = %previous,
                        to_session = %external_id,
                        "[conversation] re-pointed a conversation to a new session; the \
                         previous session is already held by another row"
                    );
                    return Ok(BindTxOutcome::Bound(None));
                }

                let agent_type = carried.agent_type.clone();
                let preserved = carried.into_active_model(previous.clone()).insert(txn).await?;
                // The one signal that this happened at all. Deliberately WARN:
                // every occurrence means a connection bound to a row while
                // holding a session unrelated to that row's history, which is
                // never intentional — the split keeps it from destroying data,
                // but the cause is still worth finding. These five fields are
                // what post-hoc diagnosis actually needs (codeg#500 was
                // reconstructed by hand from WAL dumps for want of them).
                tracing::warn!(
                    conversation_id,
                    preserved_row_id = preserved.id,
                    from_session = %previous,
                    to_session = %external_id,
                    agent_type = %agent_type,
                    "[conversation] session changed under a bound conversation; \
                     preserved the previous session's history on a new row"
                );
                Ok(BindTxOutcome::Bound(Some(preserved.id)))
            })
        })
        .await
        .map_err(|e| match e {
            sea_orm::TransactionError::Connection(e)
            | sea_orm::TransactionError::Transaction(e) => DbError::Database(e),
        })?;
    match outcome {
        BindTxOutcome::Bound(preserved) => Ok(preserved),
        // Raised AFTER the transaction commits rather than by rolling it back:
        // the only statement it ran is the self-assigning claim, which changes
        // no value, so commit and rollback are indistinguishable on disk and
        // committing keeps the writer lock held for the shortest time.
        //
        // The message is what reaches the user through
        // `AcpError::protocol(e.to_string())`, so it names the conflict in
        // terms the sidebar can be read against; the WARN inside the
        // transaction carries the full diagnostic tuple.
        BindTxOutcome::Refused { holder_row_id } => Err(DbError::Conflict(format!(
            "agent session {requested_id} is already bound to conversation \
             {holder_row_id}; refusing to move it onto conversation \
             {conversation_id}"
        ))),
    }
}

/// What [`bind_external_id`]'s transaction concluded.
///
/// A refusal has to leave the closure as a distinct VALUE rather than an early
/// `Ok(None)`, because the two mean opposite things to a caller: `Bound` means
/// the row now holds the requested session and it is safe to build on that,
/// while `Refused` means nothing was written and the operation must be
/// abandoned. It is translated to [`DbError::Conflict`] outside the
/// transaction (a `sea_orm::DbErr` raised inside would be flattened into
/// `DbError::Database` by the `TransactionError` mapping and become
/// indistinguishable from transient contention).
enum BindTxOutcome {
    /// The row holds `external_id`. `Some(id)` when the outgoing session had to
    /// be split onto a new row to stay reachable.
    Bound(Option<i32>),
    /// Another row already holds `(external_id, agent_type)`. Nothing written.
    Refused { holder_row_id: i32 },
}

/// The fields a preserving row inherits from the row it is splitting off from.
///
/// Snapshotted before the re-point because turning the model into an
/// `ActiveModel` consumes it.
struct CarriedOverRow {
    folder_id: i32,
    title: Option<String>,
    title_locked: bool,
    agent_type: String,
    status: conversation::ConversationStatus,
    kind: ConversationKind,
    model: Option<String>,
    git_branch: Option<String>,
    parent_id: Option<i32>,
    message_count: i32,
    created_at: chrono::DateTime<Utc>,
    updated_at: chrono::DateTime<Utc>,
    origin_cwd: Option<String>,
}

impl CarriedOverRow {
    fn from(row: &conversation::Model) -> Self {
        Self {
            folder_id: row.folder_id,
            title: row.title.clone(),
            title_locked: row.title_locked,
            agent_type: row.agent_type.clone(),
            // `InProgress` is deliberately NOT carried over: no agent is
            // attached to the outgoing session any more, so copying it would
            // leave a row spinning in the sidebar forever. This is the same
            // call `persist_fork_outcome` makes for its sibling. A row that
            // already reached a terminal state keeps it — that state is
            // user-visible and still true of the history being preserved.
            status: match row.status {
                conversation::ConversationStatus::InProgress => {
                    conversation::ConversationStatus::PendingReview
                }
                ref settled => settled.clone(),
            },
            kind: row.kind.clone(),
            model: row.model.clone(),
            git_branch: row.git_branch.clone(),
            // Carried so the `kind == Delegate ⟺ parent_id IS NOT NULL`
            // invariant survives, and so a preserved child stays inside its
            // parent's sub-session subtree instead of surfacing as a root.
            parent_id: row.parent_id,
            message_count: row.message_count,
            // Copied, not stamped `now`: the preserving row IS the old
            // conversation, so it must keep its place in the sidebar's
            // activity ordering rather than jumping to the top as if new.
            created_at: row.created_at,
            updated_at: row.updated_at,
            // The Gemini/Cline stale-external-id fallback matches on
            // `origin_cwd ?? folder.path`, so dropping this would break
            // history lookup for a re-parented conversation.
            origin_cwd: row.origin_cwd.clone(),
        }
    }

    fn into_active_model(self, external_id: String) -> conversation::ActiveModel {
        conversation::ActiveModel {
            id: NotSet,
            folder_id: Set(self.folder_id),
            title: Set(self.title),
            title_locked: Set(self.title_locked),
            agent_type: Set(self.agent_type),
            status: Set(self.status),
            kind: Set(self.kind),
            model: Set(self.model),
            git_branch: Set(self.git_branch),
            external_id: Set(Some(external_id)),
            parent_id: Set(self.parent_id),
            // Deliberately NOT carried: both are close to unique per delegation
            // call, and duplicating them would point the parent's tool-call view
            // at two children for one call.
            parent_tool_use_id: Set(None),
            delegation_call_id: Set(None),
            message_count: Set(self.message_count),
            created_at: Set(self.created_at),
            updated_at: Set(self.updated_at),
            deleted_at: Set(None),
            // Pinning is a view preference attached to the row the user pinned,
            // not to the history.
            pinned_at: Set(None),
            origin_cwd: Set(self.origin_cwd),
        }
    }
}

/// Re-point a conversation at a DIFFERENT SPELLING of the session it is already
/// bound to — an alias normalization, not a session change.
///
/// The one caller is the detail load, which resolves an ACP-minted UUID to the
/// branch id the parser actually indexes by (Gemini / Cline) and writes it back
/// so later lookups go direct. Because both ids denote the same session, there
/// is no history to preserve and [`bind_external_id`]'s split would be wrong
/// here — it would manufacture a phantom conversation for the old spelling.
///
/// `expected_old` makes that narrow intent explicit and doubles as a CAS: the
/// caller passes the exact id it resolved FROM, so a concurrent rebind (a
/// `SessionStarted` landing mid-parse) leaves the write matching nothing
/// instead of clobbering the newer binding. A no-match is a silent no-op.
pub async fn renormalize_external_id_alias(
    conn: &DatabaseConnection,
    conversation_id: i32,
    expected_old: Option<&str>,
    external_id: String,
) -> Result<(), DbError> {
    use sea_orm::sea_query::Expr;
    let mut query = conversation::Entity::update_many()
        .col_expr(conversation::Column::ExternalId, Expr::value(external_id))
        .col_expr(conversation::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(conversation::Column::Id.eq(conversation_id))
        .filter(conversation::Column::DeletedAt.is_null());
    query = match expected_old {
        Some(old) => query.filter(conversation::Column::ExternalId.eq(old)),
        None => query.filter(conversation::Column::ExternalId.is_null()),
    };
    query.exec(conn).await?;
    Ok(())
}

/// Re-parent every live conversation of `from_folder_id` (a task worktree
/// folder about to be removed) onto the project folder, stamping `origin_cwd`
/// with the worktree's original path. History loading is external_id-driven and
/// unaffected; the Gemini/Cline/OpenClaw stale-id fallback matches on
/// `origin_cwd ?? folder.path`, which this preserves.
pub async fn reparent_folder_conversations(
    conn: &DatabaseConnection,
    from_folder_id: i32,
    to_folder_id: i32,
    origin_cwd: &str,
) -> Result<u64, DbError> {
    use sea_orm::sea_query::Expr;
    let res = conversation::Entity::update_many()
        .col_expr(conversation::Column::FolderId, Expr::value(to_folder_id))
        .col_expr(
            conversation::Column::OriginCwd,
            Expr::value(Some(origin_cwd.to_string())),
        )
        .col_expr(conversation::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(conversation::Column::FolderId.eq(from_folder_id))
        .filter(conversation::Column::DeletedAt.is_null())
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}

pub async fn soft_delete(conn: &DatabaseConnection, conversation_id: i32) -> Result<(), DbError> {
    let conv = conversation::Entity::find_by_id(conversation_id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("Conversation not found: {conversation_id}")))?;
    let mut active: conversation::ActiveModel = conv.into();
    active.deleted_at = Set(Some(Utc::now()));
    active.update(conn).await?;
    Ok(())
}

/// Undo [`soft_delete`] for a conversation the user re-selected in the
/// import picker. Returns `true` when this call is the one that brought the row
/// back, `false` when it was already live (or is a delegation child, which is
/// never a sidebar row) — so a caller can count restores without double-
/// counting a concurrent one.
///
/// Deleting a conversation in codeg never touches the agent's own session file
/// and never removes the row: it only stamps `deleted_at`. Everything needed to
/// bring it back is therefore still on both sides, which is what makes restore
/// a single conditional UPDATE rather than a re-insert — the conversation keeps
/// its id, so bound tabs, token-usage rows and delegation children all still
/// point at it.
///
/// Three columns move, and only these:
/// * `deleted_at → NULL` — the restore itself.
/// * `folder_id → folder_id` — the folder the import is landing this session's
///   group in, which `add_folder` has just made live AND open. The row's own
///   `folder_id` is deliberately NOT preserved: it may point at a folder the
///   user has since removed or closed, and restoring into an invisible folder
///   looks exactly like a restore that did not work. This is also the folder
///   header the user checked the row under in the picker. (Live rows are still
///   never moved — see `import_service::refresh_existing`; this applies only to
///   a row being brought back.)
/// * `status → pending_review` — the same status a fresh import lands on, and
///   for the same reason: the sidebar's "show completed" filter defaults OFF,
///   so a conversation restored as `completed` would come back invisible.
///
/// `updated_at` is deliberately left alone: a restore is not activity, and the
/// caller's `refresh_external_activity` pass adopts the transcript's real
/// last-activity time right after, so the row sorts where it belongs.
///
/// The `deleted_at IS NOT NULL` guard is re-evaluated by the database at write
/// time, so a row that was un-deleted between the caller's read and this write
/// is not clobbered back to `pending_review`.
pub async fn restore_soft_deleted(
    conn: &DatabaseConnection,
    conversation_id: i32,
    folder_id: i32,
) -> Result<bool, DbError> {
    use sea_orm::sea_query::Expr;
    let res = conversation::Entity::update_many()
        .col_expr(
            conversation::Column::DeletedAt,
            Expr::value(None::<chrono::DateTime<Utc>>),
        )
        .col_expr(conversation::Column::FolderId, Expr::value(folder_id))
        .col_expr(
            conversation::Column::Status,
            Expr::value(conversation::ConversationStatus::PendingReview),
        )
        .filter(conversation::Column::Id.eq(conversation_id))
        .filter(conversation::Column::DeletedAt.is_not_null())
        .filter(conversation::Column::ParentId.is_null())
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

fn parse_agent_type(s: &str) -> AgentType {
    match serde_json::from_value(serde_json::Value::String(s.to_string())) {
        Ok(at) => at,
        Err(_) => {
            // DB has a value the enum does not recognise (manual edit or removed variant).
            // Fall back to ClaudeCode so the row stays readable, but log so resume-as-wrong-agent
            // regressions are traceable.
            tracing::warn!(
                "[conversation_service] unknown agent_type {s:?} in DB, falling back to ClaudeCode"
            );
            AgentType::ClaudeCode
        }
    }
}

fn conv_to_summary(r: conversation::Model) -> DbConversationSummary {
    let status = serde_json::to_value(&r.status)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| format!("{:?}", r.status));
    DbConversationSummary {
        id: r.id,
        folder_id: r.folder_id,
        title: r.title,
        title_locked: r.title_locked,
        agent_type: parse_agent_type(&r.agent_type),
        status,
        kind: r.kind.clone(),
        model: r.model,
        git_branch: r.git_branch,
        external_id: r.external_id,
        message_count: r.message_count as u32,
        // Pure mapper: `child_count` is backfilled by `fill_child_counts` over
        // the returned set, never queried per-row here.
        child_count: 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
        pinned_at: r.pinned_at,
        parent_id: r.parent_id,
        parent_tool_use_id: r.parent_tool_use_id,
        delegation_call_id: r.delegation_call_id,
        origin_cwd: r.origin_cwd,
    }
}

/// Backfill each summary's `child_count` with its number of direct, non-deleted
/// delegation children using ONE `GROUP BY` aggregate over the whole set (never
/// per-row — no N+1). `child_count > 0` iff `list_children` would return rows
/// (same `parent_id == id AND deleted_at IS NULL` predicate), so the sidebar
/// chevron neither expands to nothing nor hides a real subtree. No-op on an
/// empty slice (avoids an `IN ()`).
async fn fill_child_counts(
    conn: &DatabaseConnection,
    summaries: &mut [DbConversationSummary],
) -> Result<(), DbError> {
    if summaries.is_empty() {
        return Ok(());
    }
    let ids: Vec<i32> = summaries.iter().map(|s| s.id).collect();
    let pairs: Vec<(Option<i32>, i64)> = conversation::Entity::find()
        .select_only()
        .column(conversation::Column::ParentId)
        .column_as(conversation::Column::Id.count(), "cnt")
        .filter(conversation::Column::ParentId.is_in(ids))
        .filter(conversation::Column::DeletedAt.is_null())
        .group_by(conversation::Column::ParentId)
        .into_tuple()
        .all(conn)
        .await?;
    let mut counts: std::collections::HashMap<i32, u32> =
        std::collections::HashMap::with_capacity(pairs.len());
    for (parent_id, cnt) in pairs {
        if let Some(pid) = parent_id {
            counts.insert(pid, cnt.max(0) as u32);
        }
    }
    for s in summaries.iter_mut() {
        s.child_count = counts.get(&s.id).copied().unwrap_or(0);
    }
    Ok(())
}

pub async fn get_by_id(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<DbConversationSummary, DbError> {
    let conv = conversation::Entity::find_by_id(conversation_id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("Conversation not found: {conversation_id}")))?;

    let mut summary = conv_to_summary(conv);
    fill_child_counts(conn, std::slice::from_mut(&mut summary)).await?;
    Ok(summary)
}

/// Resolve a `codeg://session/<ref>` path to a live (non-deleted) conversation.
///
/// `session_ref` is either Codeg's numeric primary key (what MCP and the
/// `codeg://session/<id>` markdown mentions use) or the agent's own session
/// id stored as `external_id` (a Grok UUID, a Codex thread id, …). Several
/// rows can share an `external_id` across agents; the most recently updated
/// live row wins. Missing rows return `Ok(None)` — a stale deep link is not
/// an error.
///
/// A numeric ref is tried as a primary key *first* and as an `external_id`
/// only if no live row carries that id: nothing stops an agent from handing
/// out all-digit session ids, and silently resolving one to an unrelated
/// conversation that happens to own that PK is worse than a second query.
pub async fn find_live_by_session_ref(
    conn: &DatabaseConnection,
    session_ref: &str,
) -> Result<Option<DbConversationSummary>, DbError> {
    let session_ref = session_ref.trim();
    if session_ref.is_empty() {
        return Ok(None);
    }
    let by_pk = match session_ref.parse::<i32>() {
        Ok(id) if id > 0 => {
            conversation::Entity::find_by_id(id)
                .filter(conversation::Column::DeletedAt.is_null())
                .one(conn)
                .await?
        }
        _ => None,
    };
    let conv = match by_pk {
        Some(conv) => Some(conv),
        None => {
            conversation::Entity::find()
                .filter(conversation::Column::ExternalId.eq(session_ref))
                .filter(conversation::Column::DeletedAt.is_null())
                .order_by_desc(conversation::Column::UpdatedAt)
                .one(conn)
                .await?
        }
    };
    match conv {
        Some(conv) => {
            let mut summary = conv_to_summary(conv);
            fill_child_counts(conn, std::slice::from_mut(&mut summary)).await?;
            Ok(Some(summary))
        }
        None => Ok(None),
    }
}

/// Look up a child conversation by its `delegation_call_id` (the broker's
/// `task_id`). Returns `Ok(None)` when no row matches — used by the broker's
/// `ChildStatusLookup` DB fallback to recover a delegation task's terminal
/// status after its in-memory result was evicted from the completed-cache.
/// Unlike [`get_by_id`] this never errors hard on "not found": a missing row
/// is a legitimate "unknown task" answer.
pub async fn get_by_delegation_call_id(
    conn: &DatabaseConnection,
    delegation_call_id: &str,
) -> Result<Option<DbConversationSummary>, DbError> {
    let conv = conversation::Entity::find()
        .filter(conversation::Column::DelegationCallId.eq(delegation_call_id))
        .filter(conversation::Column::DeletedAt.is_null())
        .one(conn)
        .await?;
    Ok(conv.map(conv_to_summary))
}

pub async fn list_by_folder(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: Option<AgentType>,
    search: Option<String>,
    sort_by: Option<String>,
    status: Option<String>,
) -> Result<Vec<DbConversationSummary>, DbError> {
    let mut query = conversation::Entity::find()
        .filter(conversation::Column::FolderId.eq(folder_id))
        .filter(conversation::Column::DeletedAt.is_null());

    // Filter by agent_type
    if let Some(ref at) = agent_type {
        let at_str = serde_json::to_value(at)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        query = query.filter(conversation::Column::AgentType.eq(at_str));
    }

    // Search by title
    if let Some(ref s) = search {
        if !s.is_empty() {
            query = query.filter(conversation::Column::Title.contains(s));
        }
    }

    // Filter by status
    if let Some(ref st) = status {
        if let Ok(status_enum) = serde_json::from_value::<conversation::ConversationStatus>(
            serde_json::Value::String(st.clone()),
        ) {
            query = query.filter(conversation::Column::Status.eq(status_enum));
        }
    }

    // Sort
    query = match sort_by.as_deref() {
        Some("oldest") => query.order_by_asc(conversation::Column::CreatedAt),
        _ => query.order_by_desc(conversation::Column::CreatedAt),
    };

    let rows = query.all(conn).await?;

    let mut summaries: Vec<DbConversationSummary> = rows.into_iter().map(conv_to_summary).collect();
    fill_child_counts(conn, &mut summaries).await?;

    Ok(summaries)
}

/// List conversations across folders. When `folder_ids` is `None`, queries all
/// When `folder_ids` is provided, results are scoped to that set. Otherwise
/// returns conversations across every non-deleted folder (open or not).
///
/// `include_children` controls visibility of delegation sub-sessions. When
/// `false` (the default for the top-level list), rows whose `parent_id` is
/// non-null are filtered out — they belong to their parent's tool-call view,
/// not the workspace conversation list. Rows with `kind = 'loop'` are always
/// excluded — they belong to the loops workbench.
pub async fn list_all(
    conn: &DatabaseConnection,
    folder_ids: Option<Vec<i32>>,
    agent_type: Option<AgentType>,
    search: Option<String>,
    sort_by: Option<String>,
    status: Option<String>,
    include_children: bool,
) -> Result<Vec<DbConversationSummary>, DbError> {
    let mut query = conversation::Entity::find().filter(conversation::Column::DeletedAt.is_null());

    // Loop-engineering runs never surface in the workspace conversation list —
    // their entry point is the loops workbench.
    query = query.filter(conversation::Column::Kind.ne(ConversationKind::Loop));

    if !include_children {
        query = query.filter(conversation::Column::ParentId.is_null());
    }

    match folder_ids {
        Some(ids) if !ids.is_empty() => {
            query = query.filter(conversation::Column::FolderId.is_in(ids));
        }
        _ => {
            // Exclude conversations whose folder was soft-deleted.
            let active_folder_ids: Vec<i32> = folder::Entity::find()
                .filter(folder::Column::DeletedAt.is_null())
                .all(conn)
                .await?
                .into_iter()
                .map(|m| m.id)
                .collect();
            if active_folder_ids.is_empty() {
                return Ok(Vec::new());
            }
            query = query.filter(conversation::Column::FolderId.is_in(active_folder_ids));
        }
    }

    if let Some(ref at) = agent_type {
        let at_str = serde_json::to_value(at)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        query = query.filter(conversation::Column::AgentType.eq(at_str));
    }

    if let Some(ref s) = search {
        if !s.is_empty() {
            query = query.filter(conversation::Column::Title.contains(s));
        }
    }

    if let Some(ref st) = status {
        if let Ok(status_enum) = serde_json::from_value::<conversation::ConversationStatus>(
            serde_json::Value::String(st.clone()),
        ) {
            query = query.filter(conversation::Column::Status.eq(status_enum));
        }
    }

    query = match sort_by.as_deref() {
        Some("oldest") => query.order_by_asc(conversation::Column::UpdatedAt),
        _ => query.order_by_desc(conversation::Column::UpdatedAt),
    };

    let rows = query.all(conn).await?;
    let mut summaries: Vec<DbConversationSummary> = rows.into_iter().map(conv_to_summary).collect();
    fill_child_counts(conn, &mut summaries).await?;
    Ok(summaries)
}

/// List delegation children of a single parent conversation, newest first
/// (`created_at` DESC), matching the sidebar's newest-on-top ordering so a
/// freshly-spawned sub-agent surfaces right under its parent. The only other
/// consumer (`inject_delegation_meta`) keys these by `parent_tool_use_id` and
/// is order-agnostic. Returns rows where `parent_id == parent_conversation_id`.
/// Soft-deleted children are filtered out so a removed sub-session stays hidden
/// in the parent's tool-call view too.
pub async fn list_children(
    conn: &DatabaseConnection,
    parent_conversation_id: i32,
) -> Result<Vec<DbConversationSummary>, DbError> {
    let rows = conversation::Entity::find()
        .filter(conversation::Column::ParentId.eq(parent_conversation_id))
        .filter(conversation::Column::DeletedAt.is_null())
        .order_by_desc(conversation::Column::CreatedAt)
        // Explicit id tie-break so same-timestamp siblings are deterministic and
        // match the frontend re-sort (which tie-breaks id DESC): the raw fetch
        // snapshot and a live-inserted child then land in the same order.
        .order_by_desc(conversation::Column::Id)
        .all(conn)
        .await?;
    let mut summaries: Vec<DbConversationSummary> = rows.into_iter().map(conv_to_summary).collect();
    fill_child_counts(conn, &mut summaries).await?;
    Ok(summaries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::delegation::spawner::DelegationLink;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

    /// Build a parent + a delegation child for filter assertions.
    async fn seed_parent_with_child(conn: &DatabaseConnection, folder_id: i32) -> (i32, i32) {
        let parent = create(
            conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("P".into()),
            None,
        )
        .await
        .expect("parent");
        let link = DelegationLink {
            parent_conversation_id: parent.id,
            parent_tool_use_id: "tu-1".into(),
            delegation_call_id: "call-1".into(),
        };
        let child = create_with_delegation(
            conn,
            folder_id,
            AgentType::Codex,
            Some("C".into()),
            None,
            Some(link),
        )
        .await
        .expect("child");
        (parent.id, child.id)
    }

    #[tokio::test]
    async fn list_all_excludes_children_by_default() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-list-children-default").await;
        let (parent, _child) = seed_parent_with_child(&db.conn, folder).await;

        let rows = list_all(&db.conn, None, None, None, None, None, false)
            .await
            .expect("list");
        let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
        assert!(ids.contains(&parent), "parent must remain visible: {ids:?}");
        assert_eq!(
            rows.len(),
            1,
            "expected only the parent, got {} rows: {ids:?}",
            rows.len()
        );
    }

    #[tokio::test]
    async fn list_all_includes_children_when_requested() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-list-children-on").await;
        let (parent, child) = seed_parent_with_child(&db.conn, folder).await;

        let rows = list_all(&db.conn, None, None, None, None, None, true)
            .await
            .expect("list");
        let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
        assert!(
            ids.contains(&parent) && ids.contains(&child),
            "both parent + child must appear when include_children=true, got: {ids:?}",
        );
    }

    #[tokio::test]
    async fn list_children_returns_only_matching_parent() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-list-children-only").await;
        let (parent_a, child_a) = seed_parent_with_child(&db.conn, folder).await;
        let (_parent_b, _child_b) = seed_parent_with_child(&db.conn, folder).await;

        let rows = list_children(&db.conn, parent_a).await.expect("list");
        assert_eq!(
            rows.len(),
            1,
            "expected 1 child of parent_a, got {}",
            rows.len()
        );
        assert_eq!(rows[0].id, child_a);
        assert_eq!(rows[0].parent_id, Some(parent_a));
    }

    #[tokio::test]
    async fn list_children_orders_newest_first() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-list-children-order").await;
        let parent = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("P".into()),
            None,
        )
        .await
        .expect("parent");
        // Two children created oldest → newest under the same parent.
        let first = create_with_delegation(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("first".into()),
            None,
            Some(DelegationLink {
                parent_conversation_id: parent.id,
                parent_tool_use_id: "tu-1".into(),
                delegation_call_id: "call-1".into(),
            }),
        )
        .await
        .expect("first child");
        let second = create_with_delegation(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("second".into()),
            None,
            Some(DelegationLink {
                parent_conversation_id: parent.id,
                parent_tool_use_id: "tu-2".into(),
                delegation_call_id: "call-2".into(),
            }),
        )
        .await
        .expect("second child");

        // The sidebar shows sub-sessions newest-first so a freshly-spawned
        // sub-agent surfaces right under its parent.
        let rows = list_children(&db.conn, parent.id).await.expect("list");
        let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
        assert_eq!(
            ids,
            vec![second.id, first.id],
            "newest child must come first"
        );
    }

    #[tokio::test]
    async fn child_count_reflects_direct_children() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-child-count-direct").await;
        let (parent, child) = seed_parent_with_child(&db.conn, folder).await;

        // The root listing carries the parent's direct-child count so the
        // sidebar knows to show a chevron; the leaf child carries 0.
        let roots = list_all(&db.conn, None, None, None, None, None, false)
            .await
            .expect("list");
        let parent_row = roots.iter().find(|r| r.id == parent).expect("parent row");
        assert_eq!(parent_row.child_count, 1, "parent has one delegation child");

        let children = list_children(&db.conn, parent).await.expect("children");
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].id, child);
        assert_eq!(children[0].child_count, 0, "leaf child has no children");
    }

    #[tokio::test]
    async fn child_count_counts_grandchildren_for_nested_chevron() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-child-count-nested").await;
        let (parent, child) = seed_parent_with_child(&db.conn, folder).await;

        // Delegate a grandchild from the child so the child itself becomes
        // expandable one level down.
        let link = DelegationLink {
            parent_conversation_id: child,
            parent_tool_use_id: "tu-2".into(),
            delegation_call_id: "call-2".into(),
        };
        create_with_delegation(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("G".into()),
            None,
            Some(link),
        )
        .await
        .expect("grandchild");

        // list_children(parent) must report the child's OWN child_count (1) so
        // the recursive chevron appears on the nested row.
        let children = list_children(&db.conn, parent).await.expect("children");
        let child_row = children.iter().find(|r| r.id == child).expect("child row");
        assert_eq!(child_row.child_count, 1, "child has one grandchild");
    }

    #[tokio::test]
    async fn child_count_excludes_soft_deleted_children() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-child-count-deleted").await;
        let (parent, child) = seed_parent_with_child(&db.conn, folder).await;

        soft_delete(&db.conn, child)
            .await
            .expect("soft delete child");

        // A removed sub-session must not keep the parent's chevron alive: the
        // aggregate filters deleted_at IS NULL, matching list_children.
        let roots = list_all(&db.conn, None, None, None, None, None, false)
            .await
            .expect("list");
        let parent_row = roots.iter().find(|r| r.id == parent).expect("parent row");
        assert_eq!(
            parent_row.child_count, 0,
            "soft-deleted child must not be counted"
        );
    }

    #[tokio::test]
    async fn seed_model_fills_an_empty_column_once_without_bumping_updated_at() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-seed-model").await;
        let conv = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("c".into()),
            None,
        )
        .await
        .expect("create");

        // The gap this closes: a row created in-app carries no model at all,
        // which is why the sidebar could only ever show one for imported
        // sessions.
        let before = get_by_id(&db.conn, conv.id).await.expect("get before");
        assert!(before.model.is_none(), "a new row names no model");
        let updated_at_before = before.updated_at;

        assert!(
            seed_model_if_empty(&db.conn, conv.id, "  gpt-5-codex  ")
                .await
                .expect("seed"),
            "an empty column must be filled, and report that it was so the \
             caller knows to broadcast"
        );
        let seeded = get_by_id(&db.conn, conv.id).await.expect("get seeded");
        assert_eq!(seeded.model.as_deref(), Some("gpt-5-codex"), "trimmed");
        assert_eq!(
            seeded.updated_at, updated_at_before,
            "seeding must not bump updated_at: the sidebar sorts on it, and \
             merely opening a conversation must not float it to the top"
        );

        // First value wins. The detail view re-reads the transcript and stays
        // exact; the column is a projection for the list, not a second source
        // of truth that fights the parse.
        assert!(
            !seed_model_if_empty(&db.conn, conv.id, "gpt-5.2")
                .await
                .expect("second seed"),
            "a populated column must be left alone, and say nothing was written"
        );
        assert_eq!(
            get_by_id(&db.conn, conv.id)
                .await
                .expect("get after")
                .model
                .as_deref(),
            Some("gpt-5-codex")
        );

        // A transcript that names no model asks for no write at all.
        assert!(
            !seed_model_if_empty(&db.conn, conv.id, "   ")
                .await
                .expect("blank seed")
        );
    }

    #[tokio::test]
    async fn seed_model_skips_a_soft_deleted_row() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-seed-model-deleted").await;
        let conv = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("c".into()),
            None,
        )
        .await
        .expect("create");
        soft_delete(&db.conn, conv.id).await.expect("delete");

        assert!(
            !seed_model_if_empty(&db.conn, conv.id, "gpt-5-codex")
                .await
                .expect("seed"),
            "a deleted conversation is not something an open can resurrect a \
             column on"
        );
    }

    #[tokio::test]
    async fn update_pin_sets_and_clears_without_bumping_updated_at() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-update-pin").await;
        let conv = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("c".into()),
            None,
        )
        .await
        .expect("create");

        // Freshly created rows are unpinned, and the summary projection carries
        // the field through (conv_to_summary mapping).
        let before = get_by_id(&db.conn, conv.id).await.expect("get before");
        assert!(
            before.pinned_at.is_none(),
            "new conversation must be unpinned"
        );
        let updated_at_before = before.updated_at;

        // Pin → pinned_at populated; updated_at must NOT move (pin is a view
        // preference, not activity).
        update_pin(&db.conn, conv.id, true).await.expect("pin");
        let pinned = get_by_id(&db.conn, conv.id).await.expect("get pinned");
        assert!(
            pinned.pinned_at.is_some(),
            "pinned_at must be set after pin"
        );
        assert_eq!(
            pinned.updated_at, updated_at_before,
            "pinning must not bump updated_at"
        );

        // Unpin → pinned_at cleared back to NULL; updated_at still unchanged.
        update_pin(&db.conn, conv.id, false).await.expect("unpin");
        let unpinned = get_by_id(&db.conn, conv.id).await.expect("get unpinned");
        assert!(
            unpinned.pinned_at.is_none(),
            "pinned_at must clear after unpin"
        );
        assert_eq!(
            unpinned.updated_at, updated_at_before,
            "unpinning must not bump updated_at"
        );
    }

    #[tokio::test]
    async fn list_children_excludes_soft_deleted() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-list-children-soft-del").await;
        let (parent, child) = seed_parent_with_child(&db.conn, folder).await;

        soft_delete(&db.conn, child).await.expect("soft delete");

        let rows = list_children(&db.conn, parent).await.expect("list");
        assert!(
            rows.is_empty(),
            "soft-deleted child must not appear: {rows:?}"
        );
    }

    #[tokio::test]
    async fn create_leaves_title_unlocked() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-unlocked").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("hi".into()),
            None,
        )
        .await
        .expect("create");
        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert!(
            !summary.title_locked,
            "new conversation must start unlocked"
        );
    }

    #[tokio::test]
    async fn update_title_locks_the_title() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-lock").await;
        let row = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("create");
        update_title(&db.conn, row.id, "My name".into())
            .await
            .expect("rename");
        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.title.as_deref(), Some("My name"));
        assert!(summary.title_locked, "manual rename must lock the title");
    }

    /// Read a row straight from the table — `get_by_id` returns a summary and
    /// filters deleted rows, but these tests assert on raw persisted columns.
    async fn raw_row(conn: &DatabaseConnection, id: i32) -> conversation::Model {
        conversation::Entity::find_by_id(id)
            .one(conn)
            .await
            .expect("query")
            .expect("row")
    }

    /// The single live row (if any) holding `external_id`, whatever its id.
    async fn rows_holding(conn: &DatabaseConnection, external_id: &str) -> Vec<conversation::Model> {
        conversation::Entity::find()
            .filter(conversation::Column::ExternalId.eq(external_id))
            .filter(conversation::Column::DeletedAt.is_null())
            .all(conn)
            .await
            .expect("query by external_id")
    }

    #[tokio::test]
    async fn bind_external_id_preserves_the_outgoing_session_on_a_new_row() {
        // codeg#500 in miniature: a row bound to S1 is handed S2 (a fresh
        // session that knows nothing about it). S1 must survive on a row of its
        // own, wearing the identity the user recognises, or it disappears from
        // a sidebar that is built purely from DB rows.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-preserve").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("nouveauté de cette version".into()),
            Some("main".into()),
        )
        .await
        .expect("create");
        bind_external_id(&db.conn, row.id, "S1", &[])
            .await
            .expect("first bind");
        seed_model_if_empty(&db.conn, row.id, "gpt-5-codex")
            .await
            .expect("seed S1's model");
        let before = raw_row(&db.conn, row.id).await;

        let preserved_id = bind_external_id(&db.conn, row.id, "S2", &[])
            .await
            .expect("rebind")
            .expect("a session change with nothing holding S1 must preserve it");

        let current = raw_row(&db.conn, row.id).await;
        assert_eq!(
            current.external_id.as_deref(),
            Some("S2"),
            "the live row advances to the new session"
        );
        assert!(
            current.model.is_none(),
            "the model described S1; left behind it would name S1's model on a \
             row that is now S2, and `seed_model_if_empty` only fills an EMPTY \
             column, so nothing would ever correct it"
        );

        let preserved = raw_row(&db.conn, preserved_id).await;
        assert_eq!(preserved.external_id.as_deref(), Some("S1"));
        assert_eq!(
            preserved.title.as_deref(),
            Some("nouveauté de cette version"),
            "the preserved row must keep the name the user recognises"
        );
        assert_eq!(preserved.folder_id, before.folder_id);
        assert_eq!(preserved.agent_type, before.agent_type);
        assert_eq!(preserved.git_branch.as_deref(), Some("main"));
        assert_eq!(
            preserved.model.as_deref(),
            Some("gpt-5-codex"),
            "the model belongs to S1, and this row is what S1 becomes"
        );
        assert_eq!(
            preserved.created_at, before.created_at,
            "created_at is carried, not stamped now — the preserved row IS the \
             old conversation and must not read as freshly created"
        );
        assert_eq!(
            preserved.updated_at, before.updated_at,
            "updated_at is carried so the sidebar's activity ordering keeps the \
             conversation in place instead of floating it to the top. This also \
             pins the self-assigning claim write: bumping updated_at to claim \
             the writer lock would make the SELECT read the clobbered value."
        );
        assert!(preserved.deleted_at.is_none());
        assert!(
            preserved.pinned_at.is_none(),
            "pinning belongs to the row the user pinned, not to the history"
        );
    }

    #[tokio::test]
    async fn bind_external_id_advances_in_place_when_the_session_is_carried_forward() {
        // A custom agent that keeps sessions in memory forgets them on every
        // restart. codeg's answer is to open a fresh session and link the
        // transcripts (`continues_from`), and both the reader and the generic
        // parser then render the chain as ONE conversation — the parser even
        // hides the superseded ids, precisely so the conversation isn't listed
        // twice.
        //
        // So a bind whose incoming session carries the outgoing one forward
        // must NOT split. Splitting would clone the conversation in the sidebar
        // on every restart, with each copy rendering a longer prefix of the
        // same history (S1, S1+S2, S1+S2+S3...), and double-count its tokens.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-continues").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::Custom("goose"),
            Some("Long-running chat".into()),
            None,
        )
        .await
        .expect("create");
        bind_external_id(&db.conn, row.id, "S1", &[])
            .await
            .expect("first bind");

        // Restart 1: S2 continues S1.
        let preserved = bind_external_id(&db.conn, row.id, "S2", &["S1".to_string()])
            .await
            .expect("continuation bind");
        assert_eq!(
            preserved, None,
            "a carried-forward session is the same conversation, not a new one"
        );

        // Restart 2: S3 continues S2 (and transitively S1).
        let preserved = bind_external_id(
            &db.conn,
            row.id,
            "S3",
            &["S2".to_string(), "S1".to_string()],
        )
        .await
        .expect("second continuation bind");
        assert_eq!(preserved, None);

        let rows = conversation::Entity::find()
            .filter(conversation::Column::DeletedAt.is_null())
            .all(&db.conn)
            .await
            .expect("list");
        assert_eq!(
            rows.len(),
            1,
            "two restarts must leave ONE conversation, got {rows:?}"
        );
        assert_eq!(rows[0].external_id.as_deref(), Some("S3"));

        // The guard is not over-broad: an UNRELATED session on the same row is
        // still split off, which is the bug this whole primitive exists for.
        let preserved = bind_external_id(&db.conn, row.id, "UNRELATED", &[])
            .await
            .expect("unrelated bind")
            .expect("an unrelated session must still preserve the history");
        assert_eq!(
            raw_row(&db.conn, preserved).await.external_id.as_deref(),
            Some("S3")
        );
    }

    #[tokio::test]
    async fn bind_external_id_survives_the_unique_index() {
        // `idx_conversation_external_agent` is UNIQUE over
        // `(external_id, agent_type)`, so the preserving row can only be
        // inserted after the current row has released S1. Insert-first would
        // fail the constraint every single time — this test exists so a
        // refactor that "tidies" the two writes into the intuitive order gets
        // caught here rather than in production.
        //
        // The migrations run in `fresh_in_memory_db`, so the index is real.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-unique").await;
        let row = create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .expect("create");
        bind_external_id(&db.conn, row.id, "S1", &[])
            .await
            .expect("first bind");

        bind_external_id(&db.conn, row.id, "S2", &[])
            .await
            .expect("the split must not trip the unique index")
            .expect("preserved");

        assert_eq!(
            rows_holding(&db.conn, "S1").await.len(),
            1,
            "exactly one row holds the old session"
        );
        assert_eq!(
            rows_holding(&db.conn, "S2").await.len(),
            1,
            "exactly one row holds the new session"
        );
    }

    #[tokio::test]
    async fn bind_external_id_refuses_a_session_another_row_already_holds() {
        // The incoming id is exposed to the unique index in BOTH branches, and
        // neither used to check for a holder, so each of these used to raise a
        // raw `UNIQUE constraint failed`.
        //
        // Two things are asserted together because they only make sense
        // together: the DB is left completely untouched, AND the caller is told
        // so. `Conflict` rather than `Ok(None)` is the load-bearing half —
        // `send_prompt_linked` reads any `Ok` as "the row is bound now" and
        // goes on to dispatch the prompt, which would then land in the HOLDER
        // row's transcript while every event named this row.
        for repointing in [false, true] {
            let db = fresh_in_memory_db().await;
            let folder = seed_folder(&db, "/tmp/codeg-bind-conflict").await;
            let holder = create(&db.conn, folder, AgentType::Codex, None, None)
                .await
                .expect("holder");
            bind_external_id(&db.conn, holder.id, "S_SHARED", &[])
                .await
                .expect("seed holder");

            let row = create(&db.conn, folder, AgentType::Codex, None, None)
                .await
                .expect("create");
            // `false` exercises the plain-bind branch (a fresh row whose
            // connection resumed a session codeg already indexed); `true` the
            // split branch, which would otherwise fail on the release write
            // before ever reaching its INSERT.
            if repointing {
                bind_external_id(&db.conn, row.id, "S_OWN", &[])
                    .await
                    .expect("seed own session");
            }

            let err = bind_external_id(&db.conn, row.id, "S_SHARED", &[])
                .await
                .expect_err("a taken session id must be refused, not reported bound");

            assert!(
                matches!(err, DbError::Conflict(_)),
                "must be distinguishable from transient contention, got {err:?}"
            );
            assert!(
                err.to_string().contains(&holder.id.to_string()),
                "the message must name the row that actually holds the session, got {err}"
            );
            assert_eq!(
                raw_row(&db.conn, row.id).await.external_id.as_deref(),
                repointing.then_some("S_OWN"),
                "the refused row keeps exactly the session it had"
            );
            let holders = rows_holding(&db.conn, "S_SHARED").await;
            assert_eq!(holders.len(), 1, "the original holder is untouched");
            assert_eq!(holders[0].id, holder.id);
        }
    }

    #[tokio::test]
    async fn bind_external_id_refuses_a_session_a_soft_deleted_row_holds() {
        // The unique index carries no `deleted_at` predicate, so a soft-deleted
        // row still occupies its id — a lookup that filtered on `deleted_at IS
        // NULL` would miss it and walk straight into the constraint. Refused on
        // the same terms as a live holder rather than having its id taken,
        // matching `import_one` / `refresh_existing`, which skip such a row
        // instead of rewriting it.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-conflict-deleted").await;
        let holder = create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .expect("holder");
        bind_external_id(&db.conn, holder.id, "S_SHARED", &[])
            .await
            .expect("seed holder");
        soft_delete(&db.conn, holder.id).await.expect("soft delete");

        let row = create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .expect("create");
        bind_external_id(&db.conn, row.id, "S_OWN", &[])
            .await
            .expect("seed own session");

        let err = bind_external_id(&db.conn, row.id, "S_SHARED", &[])
            .await
            .expect_err("a deleted row's id is still taken; refuse it");

        assert!(matches!(err, DbError::Conflict(_)), "got {err:?}");
        assert_eq!(
            raw_row(&db.conn, row.id).await.external_id.as_deref(),
            Some("S_OWN")
        );
        let holder_after = raw_row(&db.conn, holder.id).await;
        assert_eq!(holder_after.external_id.as_deref(), Some("S_SHARED"));
        assert!(
            holder_after.deleted_at.is_some(),
            "a refused bind must not resurrect the deleted holder"
        );
    }

    #[tokio::test]
    async fn bind_external_id_is_a_plain_write_on_first_bind() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-first").await;
        let row = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("create");

        let preserved = bind_external_id(&db.conn, row.id, "S1", &[])
            .await
            .expect("first bind");

        assert_eq!(
            preserved, None,
            "a row with no session yet has nothing to preserve"
        );
        assert_eq!(raw_row(&db.conn, row.id).await.external_id.as_deref(), Some("S1"));
    }

    #[tokio::test]
    async fn bind_external_id_is_idempotent_for_the_same_session() {
        // A duplicate SessionStarted (replay, agent re-init, or simply both
        // subscribers handling the same event) must not fork the history.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-idem").await;
        let row = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("create");
        bind_external_id(&db.conn, row.id, "S1", &[]).await.expect("bind");

        let preserved = bind_external_id(&db.conn, row.id, "S1", &[])
            .await
            .expect("rebind to the same id");

        assert_eq!(preserved, None, "rebinding the same id preserves nothing");
        assert_eq!(rows_holding(&db.conn, "S1").await.len(), 1);
    }

    #[tokio::test]
    async fn bind_external_id_adopts_a_row_that_already_holds_the_old_session() {
        // What fork establishes: a sibling already carries S1, so the invariant
        // holds before we start and re-preserving would both duplicate the row
        // and (given the unique index) fail outright. Either race order must
        // land on exactly two rows.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-adopt").await;
        let row = create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .expect("create");
        bind_external_id(&db.conn, row.id, "S1", &[]).await.expect("bind");
        // Stand in for fork's sibling insert.
        let sibling = create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .expect("sibling");
        bind_external_id(&db.conn, sibling.id, "S1_HOLDER", &[])
            .await
            .expect("seed");
        let mut active: conversation::ActiveModel = raw_row(&db.conn, sibling.id).await.into();
        active.external_id = Set(Some("S1".into()));
        // Release S1 on the original first, exactly as the real fork does.
        let mut original: conversation::ActiveModel = raw_row(&db.conn, row.id).await.into();
        original.external_id = Set(Some("S2".into()));
        original.update(&db.conn).await.expect("release");
        active.update(&db.conn).await.expect("hand S1 to the sibling");

        // Now the late SessionStarted{S2} arrives for the original row.
        let preserved = bind_external_id(&db.conn, row.id, "S2", &[])
            .await
            .expect("late rebind");

        assert_eq!(
            preserved, None,
            "S1 already has a home; preserving again would duplicate it"
        );
        assert_eq!(rows_holding(&db.conn, "S1").await.len(), 1);
    }

    #[tokio::test]
    async fn bind_external_id_maps_in_progress_to_pending_review() {
        // The preserved row has no agent attached any more, so carrying
        // `InProgress` over would leave it spinning in the sidebar forever.
        // Settled states are carried as-is — they are user-visible and still
        // true of the history being preserved.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-status").await;

        for (original, expected) in [
            (
                conversation::ConversationStatus::InProgress,
                conversation::ConversationStatus::PendingReview,
            ),
            (
                conversation::ConversationStatus::Completed,
                conversation::ConversationStatus::Completed,
            ),
            (
                conversation::ConversationStatus::Cancelled,
                conversation::ConversationStatus::Cancelled,
            ),
        ] {
            let row = create(&db.conn, folder, AgentType::Codex, None, None)
                .await
                .expect("create");
            let seed = format!("S1-{original:?}");
            bind_external_id(&db.conn, row.id, &seed, &[]).await.expect("bind");
            update_status(&db.conn, row.id, original.clone())
                .await
                .expect("status");

            let preserved_id = bind_external_id(&db.conn, row.id, &format!("S2-{original:?}"), &[])
                .await
                .expect("rebind")
                .expect("preserved");

            assert_eq!(
                raw_row(&db.conn, preserved_id).await.status,
                expected,
                "{original:?} must be preserved as {expected:?}"
            );
        }
    }

    #[tokio::test]
    async fn bind_external_id_keeps_a_delegation_child_inside_its_parent() {
        // `kind == Delegate ⟺ parent_id IS NOT NULL` is a documented invariant,
        // and a preserved child that lost its parent would surface as a stray
        // root in the sidebar. The two near-unique delegation identity fields
        // are deliberately NOT carried — duplicating them would point the
        // parent's tool-call view at two children for one call.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-delegate").await;
        let (parent_id, child_id) = seed_parent_with_child(&db.conn, folder).await;
        bind_external_id(&db.conn, child_id, "S1", &[])
            .await
            .expect("bind child");

        let preserved_id = bind_external_id(&db.conn, child_id, "S2", &[])
            .await
            .expect("rebind child")
            .expect("preserved");

        let preserved = raw_row(&db.conn, preserved_id).await;
        assert_eq!(preserved.parent_id, Some(parent_id));
        assert_eq!(preserved.kind, ConversationKind::Delegate);
        assert_eq!(preserved.parent_tool_use_id, None);
        assert_eq!(preserved.delegation_call_id, None);
    }

    #[tokio::test]
    async fn bind_external_id_ignores_the_same_session_under_another_agent() {
        // The uniqueness the index enforces is per-AGENT, and so is the
        // "already preserved" lookup. A row belonging to a different agent that
        // happens to share the id string must not be mistaken for a home for
        // this agent's outgoing session.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-bind-agent-scope").await;
        let other_agent = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("other agent row");
        bind_external_id(&db.conn, other_agent.id, "S1", &[])
            .await
            .expect("bind other agent");
        let row = create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .expect("create");
        bind_external_id(&db.conn, row.id, "S1", &[])
            .await
            .expect("same id, different agent is allowed by the index");

        let preserved = bind_external_id(&db.conn, row.id, "S2", &[])
            .await
            .expect("rebind")
            .expect("the other agent's row is not a home for OUR session");

        let preserved = raw_row(&db.conn, preserved).await;
        assert_eq!(preserved.agent_type, row.agent_type);
    }

    #[tokio::test]
    async fn renormalize_external_id_alias_is_a_compare_and_swap() {
        // The alias path rewrites one spelling of a session into another and
        // must NOT split history. Its expected-old guard exists so a
        // `SessionStarted` that rebound the row while the parse was running
        // cannot be clobbered by the stale write that follows.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-alias").await;
        let row = create(&db.conn, folder, AgentType::Gemini, None, None)
            .await
            .expect("create");
        bind_external_id(&db.conn, row.id, "acp-uuid", &[])
            .await
            .expect("bind");

        renormalize_external_id_alias(&db.conn, row.id, Some("acp-uuid"), "branch-id".into())
            .await
            .expect("normalize");
        assert_eq!(
            raw_row(&db.conn, row.id).await.external_id.as_deref(),
            Some("branch-id"),
            "the alias is normalized in place, with no second row"
        );
        assert_eq!(
            rows_holding(&db.conn, "acp-uuid").await.len(),
            0,
            "an alias rewrite must not leave a phantom conversation behind"
        );

        // Stale write: the row has since moved on. It must match nothing.
        renormalize_external_id_alias(&db.conn, row.id, Some("acp-uuid"), "stale".into())
            .await
            .expect("a no-match is a silent no-op, not an error");
        assert_eq!(
            raw_row(&db.conn, row.id).await.external_id.as_deref(),
            Some("branch-id"),
            "a stale alias write must not clobber a newer binding"
        );
    }

    #[tokio::test]
    async fn bind_external_id_skips_soft_deleted_row() {
        // A late/stale `SessionStarted` write — e.g. a fork's SessionStarted{S2}
        // landing after the user deleted the conversation — must NOT mutate a
        // soft-deleted row. `bind_external_id` is guarded on `deleted_at IS
        // NULL`, so it is a silent no-op: the deleted row keeps its old
        // external_id and is never half-resurrected.
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-extid-deleted").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("Doomed".into()),
            None,
        )
        .await
        .expect("create");
        bind_external_id(&db.conn, row.id, "session-S1", &[])
            .await
            .expect("seed external_id");
        soft_delete(&db.conn, row.id).await.expect("soft delete");

        // The guarded write must no-op (Ok) without touching the deleted row.
        // Critically it must ALSO not preserve anything: a deleted row's
        // session is not being orphaned, so manufacturing a preserving row
        // here would resurrect a conversation the user just deleted.
        let preserved = bind_external_id(&db.conn, row.id, "session-S2", &[])
            .await
            .expect("a stale SessionStarted write must be a no-op, not an error");
        assert_eq!(
            preserved, None,
            "a soft-deleted row must not spawn a preserving row"
        );

        // Inspect the raw row directly — `get_by_id` filters deleted rows out.
        let raw = conversation::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .expect("query")
            .expect("row still exists (soft-deleted)");
        assert!(raw.deleted_at.is_some(), "row must remain soft-deleted");
        assert_eq!(
            raw.external_id.as_deref(),
            Some("session-S1"),
            "a stale external_id write must not re-point a soft-deleted row"
        );

        // Sanity: the guard is not over-broad — a LIVE row still updates.
        let live = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("Live".into()),
            None,
        )
        .await
        .expect("create live");
        bind_external_id(&db.conn, live.id, "session-S9", &[])
            .await
            .expect("live update");
        let live_raw = conversation::Entity::find_by_id(live.id)
            .one(&db.conn)
            .await
            .expect("query live")
            .expect("live row");
        assert_eq!(
            live_raw.external_id.as_deref(),
            Some("session-S9"),
            "a live row must still receive its external_id"
        );
    }

    #[tokio::test]
    async fn refresh_auto_title_writes_when_unlocked_and_changed() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-auto").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("old".into()),
            None,
        )
        .await
        .expect("create");

        let wrote = refresh_auto_title(&db.conn, row.id, "fresh".into())
            .await
            .expect("auto");
        assert!(wrote, "an unlocked, changed title must be written");

        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.title.as_deref(), Some("fresh"));
        assert!(
            !summary.title_locked,
            "auto refresh must NOT lock — the title stays eligible for future refreshes"
        );
    }

    #[tokio::test]
    async fn refresh_auto_title_skips_when_unchanged_or_empty() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-auto-skip").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("same".into()),
            None,
        )
        .await
        .expect("create");

        assert!(
            !refresh_auto_title(&db.conn, row.id, "same".into())
                .await
                .expect("auto-same"),
            "identical title must be a no-op"
        );
        assert!(
            !refresh_auto_title(&db.conn, row.id, String::new())
                .await
                .expect("auto-empty"),
            "empty title must be a no-op"
        );
    }

    #[tokio::test]
    async fn refresh_auto_title_never_clobbers_a_locked_title() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-auto-locked").await;
        let row = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("create");
        update_title(&db.conn, row.id, "User pick".into())
            .await
            .expect("rename");

        let wrote = refresh_auto_title(&db.conn, row.id, "parser title".into())
            .await
            .expect("auto");
        assert!(!wrote, "a locked title must never be auto-overwritten");
        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.title.as_deref(), Some("User pick"));
        assert!(summary.title_locked);
    }

    #[tokio::test]
    async fn refresh_auto_title_does_not_bump_updated_at() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-no-bump").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("old".into()),
            None,
        )
        .await
        .expect("create");
        let before = row.updated_at;

        let wrote = refresh_auto_title(&db.conn, row.id, "fresh".into())
            .await
            .expect("auto");
        assert!(wrote);

        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.title.as_deref(), Some("fresh"));
        assert_eq!(
            summary.updated_at, before,
            "auto-title backfill is metadata, not activity — it must not bump updated_at"
        );
    }

    #[tokio::test]
    async fn seed_auto_title_if_empty_writes_only_when_untitled() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-seed").await;
        let row = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("create");
        let before = row.updated_at;

        assert!(
            seed_auto_title_if_empty(&db.conn, row.id, "  First prompt  ".into())
                .await
                .expect("seed"),
            "an empty unlocked title must be seeded"
        );
        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.title.as_deref(), Some("First prompt"));
        assert!(!summary.title_locked);
        assert_eq!(summary.updated_at, before, "seed must not bump updated_at");

        assert!(
            !seed_auto_title_if_empty(&db.conn, row.id, "Second prompt".into())
                .await
                .expect("seed-2"),
            "a later prompt must not replace the first-prompt seed"
        );
        let summary = get_by_id(&db.conn, row.id).await.expect("get-2");
        assert_eq!(summary.title.as_deref(), Some("First prompt"));
    }

    #[tokio::test]
    async fn seed_auto_title_if_empty_skips_locked_and_empty() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-seed-skip").await;
        let row = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("create");
        update_title(&db.conn, row.id, "User pick".into())
            .await
            .expect("rename");

        assert!(
            !seed_auto_title_if_empty(&db.conn, row.id, "First prompt".into())
                .await
                .expect("seed-locked"),
            "a locked title must not be seeded over"
        );
        assert!(
            !seed_auto_title_if_empty(&db.conn, row.id, String::new())
                .await
                .expect("seed-empty")
        );
        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.title.as_deref(), Some("User pick"));
    }

    /// Neither auto-title primitive may write a soft-deleted row. Both are now
    /// driven from the live ACP path (a title can land while the user is
    /// deleting the conversation), and a late write to a deleted row is a
    /// resurrection the sidebar can never show — `emit_conversation_upsert`
    /// filters it out, so the row would silently diverge from every client.
    #[tokio::test]
    async fn auto_title_writes_skip_soft_deleted_rows() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-deleted").await;

        // Untitled + deleted: the first-prompt seed must not name it.
        let seeded = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("create");
        soft_delete(&db.conn, seeded.id).await.expect("soft delete");
        assert!(
            !seed_auto_title_if_empty(&db.conn, seeded.id, "First prompt".into())
                .await
                .expect("seed"),
            "a soft-deleted row must not be seeded"
        );

        // Titled + deleted: a live ACP title must not replace it either.
        let refreshed = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("Old name".into()),
            None,
        )
        .await
        .expect("create");
        soft_delete(&db.conn, refreshed.id).await.expect("soft delete");
        assert!(
            !refresh_auto_title(&db.conn, refreshed.id, "Agent title".into())
                .await
                .expect("refresh"),
            "a soft-deleted row must not be auto-retitled"
        );

        for (id, expected) in [(seeded.id, None), (refreshed.id, Some("Old name"))] {
            let row = conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .expect("query")
                .expect("row still present");
            assert_eq!(row.title.as_deref(), expected);
        }
    }

    /// The work-task / automation launch path: the seed IS the name, so locking
    /// must keep the title byte-identical, keep the row where it is in a
    /// recency-sorted sidebar, and make the next auto-title a no-op.
    #[tokio::test]
    async fn lock_title_freezes_the_seed_without_rewriting_or_bumping() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-title-lock-seed").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("Fix the login flow".into()),
            None,
        )
        .await
        .expect("create");
        let before = row.updated_at;
        assert!(!row.title_locked, "a fresh row starts unlocked");

        lock_title(&db.conn, row.id).await.expect("lock");

        let locked = get_by_id(&db.conn, row.id).await.expect("get");
        assert!(locked.title_locked, "lock_title must set the flag");
        assert_eq!(
            locked.title.as_deref(),
            Some("Fix the login flow"),
            "lock_title must not rewrite the title"
        );
        assert_eq!(
            locked.updated_at, before,
            "locking is metadata, not activity — it must not bump updated_at"
        );

        // The whole point: the parsed session title can no longer take over.
        assert!(
            !refresh_auto_title(&db.conn, row.id, "项目：/Users/me/app".into())
                .await
                .expect("auto"),
            "a seeded-and-locked title must survive the per-turn backfill"
        );
        let after = get_by_id(&db.conn, row.id).await.expect("get again");
        assert_eq!(after.title.as_deref(), Some("Fix the login flow"));
    }

    /// A missing row must not be an error — the caller locks on a best-effort
    /// path where a failure would be worse than the drift it prevents.
    #[tokio::test]
    async fn lock_title_on_a_missing_row_is_a_no_op() {
        let db = fresh_in_memory_db().await;
        lock_title(&db.conn, 999_999).await.expect("no-op lock");
    }

    #[tokio::test]
    async fn retitle_if_unchanged_follows_the_owner_rename() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-retitle-follow").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("old".into()),
            None,
        )
        .await
        .expect("create");
        let before = row.updated_at;
        lock_title(&db.conn, row.id).await.expect("lock");

        let wrote = retitle_if_unchanged(&db.conn, row.id, "old", "new")
            .await
            .expect("retitle");
        assert!(wrote, "a title still in sync with its owner must follow it");

        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.title.as_deref(), Some("new"));
        assert!(summary.title_locked, "the row must stay locked");
        assert_eq!(
            summary.updated_at, before,
            "following an owner rename is metadata, not activity"
        );
    }

    /// The guard that makes the sync safe: once the user names the conversation
    /// themselves, the owner's rename must not reach it. `title_locked` is true
    /// in BOTH cases, so only the expected-value comparison can tell them apart.
    #[tokio::test]
    async fn retitle_if_unchanged_refuses_after_a_manual_rename() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-retitle-refuse").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("old".into()),
            None,
        )
        .await
        .expect("create");
        update_title(&db.conn, row.id, "User pick".into())
            .await
            .expect("rename");

        let wrote = retitle_if_unchanged(&db.conn, row.id, "old", "new")
            .await
            .expect("retitle");
        assert!(!wrote, "a hand-picked title must not follow the owner");
        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.title.as_deref(), Some("User pick"));
    }

    #[tokio::test]
    async fn retitle_if_unchanged_skips_empty_and_identical() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-retitle-skip").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("same".into()),
            None,
        )
        .await
        .expect("create");

        assert!(
            !retitle_if_unchanged(&db.conn, row.id, "same", "same")
                .await
                .expect("identical"),
            "an unchanged owner name must be a no-op"
        );
        assert!(
            !retitle_if_unchanged(&db.conn, row.id, "same", "   ")
                .await
                .expect("blank"),
            "a blank new title must never erase the name"
        );
        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.title.as_deref(), Some("same"));
    }

    #[tokio::test]
    async fn refresh_codex_auto_titles_converges_without_bumping_updated_at() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-codex-index-title").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("Makefile 文件的作用".into()),
            None,
        )
        .await
        .expect("create");
        bind_external_id(&db.conn, row.id, "codex-session-1", &[])
            .await
            .expect("set external id");
        let before = get_by_id(&db.conn, row.id).await.expect("get before");
        let titles = HashMap::from([(
            "codex-session-1".to_string(),
            "解释 Makefile 文件作用".to_string(),
        )]);

        assert_eq!(
            refresh_codex_auto_titles(&db.conn, &titles).await,
            vec![row.id]
        );
        let refreshed = get_by_id(&db.conn, row.id).await.expect("get refreshed");
        assert_eq!(refreshed.title.as_deref(), Some("解释 Makefile 文件作用"));
        assert_eq!(
            refreshed.updated_at, before.updated_at,
            "index title refresh must not count as conversation activity"
        );

        assert_eq!(
            refresh_codex_auto_titles(&db.conn, &titles).await,
            Vec::<i32>::new(),
            "a converged title map must issue no UPDATE"
        );
    }

    #[tokio::test]
    async fn refresh_codex_auto_titles_keeps_partial_successes_after_row_failure() {
        use sea_orm::{ConnectionTrait, DbBackend, Statement};

        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-codex-index-partial-failure").await;
        let successful = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("old success".into()),
            None,
        )
        .await
        .expect("create successful candidate");
        bind_external_id(&db.conn, successful.id, "session-success", &[])
            .await
            .expect("set successful external id");
        let failing = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("old failure".into()),
            None,
        )
        .await
        .expect("create failing candidate");
        bind_external_id(&db.conn, failing.id, "session-failure", &[])
            .await
            .expect("set failing external id");
        db.conn
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                format!(
                    r#"CREATE TRIGGER fail_second_codex_title_sync
                       BEFORE UPDATE OF title ON conversation
                       WHEN OLD.id = {}
                       BEGIN
                         SELECT RAISE(FAIL, 'injected partial title sync failure');
                       END"#,
                    failing.id
                ),
            ))
            .await
            .expect("install title failure trigger");
        let titles = HashMap::from([
            ("session-success".to_string(), "new success".to_string()),
            ("session-failure".to_string(), "new failure".to_string()),
        ]);

        let refreshed = refresh_codex_auto_titles(&db.conn, &titles).await;

        assert_eq!(refreshed, vec![successful.id]);
        assert_eq!(
            get_by_id(&db.conn, successful.id)
                .await
                .expect("get successful row")
                .title
                .as_deref(),
            Some("new success")
        );
        assert_eq!(
            get_by_id(&db.conn, failing.id)
                .await
                .expect("get failing row")
                .title
                .as_deref(),
            Some("old failure")
        );
    }

    #[tokio::test]
    async fn refresh_codex_auto_title_candidate_rechecks_external_id_at_write_time() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-codex-index-race").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("old title".into()),
            None,
        )
        .await
        .expect("create");
        bind_external_id(&db.conn, row.id, "session-before", &[])
            .await
            .expect("set initial external id");
        let stale_candidate = conversation::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .expect("query candidate")
            .expect("candidate exists");

        // In-place re-point: this test is about the CAS seeing a changed
        // `external_id`, not about session preservation, so it uses the alias
        // rewrite rather than `bind_external_id` (which would additionally
        // split `session-before` onto a preserving row and put a second
        // candidate-shaped row in front of the assertions below).
        renormalize_external_id_alias(
            &db.conn,
            row.id,
            Some("session-before"),
            "session-after".into(),
        )
        .await
        .expect("re-point conversation");
        let wrote = refresh_codex_auto_title_candidate(
            &db.conn,
            &stale_candidate,
            "title for session-before",
        )
        .await
        .expect("conditional refresh");

        assert!(!wrote, "a stale candidate must not update a re-pointed row");
        let current = get_by_id(&db.conn, row.id).await.expect("read current row");
        assert_eq!(current.external_id.as_deref(), Some("session-after"));
        assert_eq!(current.title.as_deref(), Some("old title"));
    }

    #[tokio::test]
    async fn refresh_codex_auto_title_candidate_rechecks_original_title_at_write_time() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-codex-index-title-race").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("candidate title".into()),
            None,
        )
        .await
        .expect("create");
        bind_external_id(&db.conn, row.id, "session-title-race", &[])
            .await
            .expect("set external id");
        let stale_candidate = conversation::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .expect("query candidate")
            .expect("candidate exists");

        refresh_auto_title(&db.conn, row.id, "newer automatic title".into())
            .await
            .expect("apply concurrent automatic title");
        let wrote = refresh_codex_auto_title_candidate(
            &db.conn,
            &stale_candidate,
            "stale session index title",
        )
        .await
        .expect("conditional refresh");

        assert!(!wrote, "a stale candidate must not overwrite a newer title");
        let current = get_by_id(&db.conn, row.id).await.expect("read current row");
        assert_eq!(current.title.as_deref(), Some("newer automatic title"));
    }

    #[tokio::test]
    async fn refresh_codex_auto_title_candidate_rechecks_deleted_at_at_write_time() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-codex-index-delete-race").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("candidate title".into()),
            None,
        )
        .await
        .expect("create");
        bind_external_id(&db.conn, row.id, "session-delete-race", &[])
            .await
            .expect("set external id");
        let stale_candidate = conversation::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .expect("query candidate")
            .expect("candidate exists");

        soft_delete(&db.conn, row.id)
            .await
            .expect("concurrently delete candidate");
        let wrote = refresh_codex_auto_title_candidate(
            &db.conn,
            &stale_candidate,
            "stale session index title",
        )
        .await
        .expect("conditional refresh");

        assert!(!wrote, "a stale candidate must not update a deleted row");
        let current = conversation::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .expect("read current row")
            .expect("soft-deleted row remains persisted");
        assert!(current.deleted_at.is_some());
        assert_eq!(current.title.as_deref(), Some("candidate title"));
    }

    #[tokio::test]
    async fn refresh_codex_auto_title_candidate_rechecks_title_lock_at_write_time() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-codex-index-lock-race").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("same manual title".into()),
            None,
        )
        .await
        .expect("create");
        bind_external_id(&db.conn, row.id, "session-lock-race", &[])
            .await
            .expect("set external id");
        let stale_candidate = conversation::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .expect("query candidate")
            .expect("candidate exists");

        update_title(&db.conn, row.id, "same manual title".into())
            .await
            .expect("lock title without changing its value");
        let wrote = refresh_codex_auto_title_candidate(
            &db.conn,
            &stale_candidate,
            "stale session index title",
        )
        .await
        .expect("conditional refresh");

        assert!(
            !wrote,
            "a stale candidate must not overwrite a locked title"
        );
        let current = get_by_id(&db.conn, row.id).await.expect("read current row");
        assert!(current.title_locked);
        assert_eq!(current.title.as_deref(), Some("same manual title"));
    }

    #[tokio::test]
    async fn refresh_codex_auto_title_candidate_rechecks_folder_deletion_at_write_time() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-codex-index-folder-race").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("old title".into()),
            None,
        )
        .await
        .expect("create");
        bind_external_id(&db.conn, row.id, "session-folder-race", &[])
            .await
            .expect("set external id");
        let stale_candidate = conversation::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .expect("query candidate")
            .expect("candidate exists");

        crate::db::service::folder_service::soft_delete_folder(&db.conn, folder)
            .await
            .expect("soft delete folder");
        let wrote =
            refresh_codex_auto_title_candidate(&db.conn, &stale_candidate, "index title").await;

        assert!(
            !wrote.expect("conditional refresh"),
            "a row whose folder was deleted mid-refresh must not be rewritten (and so must not be broadcast)"
        );
        let current = get_by_id(&db.conn, row.id).await.expect("read current row");
        assert_eq!(current.title.as_deref(), Some("old title"));
    }

    #[tokio::test]
    async fn refresh_codex_auto_title_candidate_adopts_a_title_over_null() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-codex-index-null-title").await;
        let row = create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .expect("create");
        bind_external_id(&db.conn, row.id, "session-null-title", &[])
            .await
            .expect("set external id");
        let candidate = conversation::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .expect("query candidate")
            .expect("candidate exists");
        assert!(candidate.title.is_none(), "fixture must start titleless");

        assert!(
            refresh_codex_auto_title_candidate(&db.conn, &candidate, "first Codex title")
                .await
                .expect("conditional refresh"),
            "the IS NULL branch of the observed-title CAS must still write"
        );
        assert_eq!(
            get_by_id(&db.conn, row.id)
                .await
                .expect("read current row")
                .title
                .as_deref(),
            Some("first Codex title")
        );

        // ...and once a title exists, the same stale (title = NULL) candidate
        // must no longer match.
        assert!(
            !refresh_codex_auto_title_candidate(&db.conn, &candidate, "second Codex title")
                .await
                .expect("conditional refresh"),
            "a stale titleless candidate must not clobber the title it just wrote"
        );
    }

    #[tokio::test]
    async fn refresh_codex_auto_titles_skips_rows_the_sidebar_list_hides() {
        let db = fresh_in_memory_db().await;
        let live_folder = seed_folder(&db, "/tmp/codeg-codex-index-visible").await;
        let dead_folder = seed_folder(&db, "/tmp/codeg-codex-index-hidden").await;

        let visible = create(
            &db.conn,
            live_folder,
            AgentType::Codex,
            Some("old visible".into()),
            None,
        )
        .await
        .expect("create visible");
        bind_external_id(&db.conn, visible.id, "session-visible", &[])
            .await
            .expect("set visible external id");

        let in_dead_folder = create(
            &db.conn,
            dead_folder,
            AgentType::Codex,
            Some("old hidden".into()),
            None,
        )
        .await
        .expect("create hidden");
        bind_external_id(&db.conn, in_dead_folder.id, "session-hidden", &[])
            .await
            .expect("set hidden external id");
        crate::db::service::folder_service::soft_delete_folder(&db.conn, dead_folder)
            .await
            .expect("soft delete folder");

        let loop_row = create(
            &db.conn,
            live_folder,
            AgentType::Codex,
            Some("old loop".into()),
            None,
        )
        .await
        .expect("create loop row");
        bind_external_id(&db.conn, loop_row.id, "session-loop", &[])
            .await
            .expect("set loop external id");
        // No public write path mints kind='loop' yet, so flip it directly.
        let mut active: conversation::ActiveModel = conversation::Entity::find_by_id(loop_row.id)
            .one(&db.conn)
            .await
            .expect("query loop row")
            .expect("loop row exists")
            .into();
        active.kind = Set(ConversationKind::Loop);
        active.update(&db.conn).await.expect("flip kind");

        let titles = HashMap::from([
            ("session-visible".to_string(), "new visible".to_string()),
            ("session-hidden".to_string(), "new hidden".to_string()),
            ("session-loop".to_string(), "new loop".to_string()),
        ]);

        let refreshed = refresh_codex_auto_titles(&db.conn, &titles).await;

        assert_eq!(
            refreshed,
            vec![visible.id],
            "only rows `list_all` would return may be refreshed — every refreshed id is broadcast as a sidebar upsert"
        );
        assert_eq!(
            get_by_id(&db.conn, in_dead_folder.id)
                .await
                .expect("read hidden row")
                .title
                .as_deref(),
            Some("old hidden")
        );
        assert_eq!(
            get_by_id(&db.conn, loop_row.id)
                .await
                .expect("read loop row")
                .title
                .as_deref(),
            Some("old loop")
        );
    }

    #[tokio::test]
    async fn refresh_external_activity_moves_forward_only() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-activity").await;
        let row = create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("kept".into()),
            None,
        )
        .await
        .expect("create");
        let created_at = row.created_at;
        let before = row.updated_at;

        // The session kept running in the agent's own CLI after import.
        let later = before + chrono::Duration::hours(2);
        assert!(
            refresh_external_activity(&db.conn, row.id, later, 7)
                .await
                .expect("newer"),
            "newer transcript activity must be adopted"
        );
        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.updated_at, later);
        assert_eq!(summary.message_count, 7);
        assert_eq!(
            summary.created_at, created_at,
            "created_at is the import/creation time and must not move"
        );
        assert_eq!(summary.title.as_deref(), Some("kept"));

        // Re-scanning the same (or an older) transcript must not move the row
        // back or re-order a sidebar sorted by recency.
        for (at, label) in [(later, "identical"), (before, "older")] {
            assert!(
                !refresh_external_activity(&db.conn, row.id, at, 1)
                    .await
                    .expect("no-op"),
                "{label} activity must be a no-op"
            );
        }
        let summary = get_by_id(&db.conn, row.id).await.expect("get");
        assert_eq!(summary.updated_at, later);
        assert_eq!(summary.message_count, 7, "a no-op must not resync counts");
    }

    #[tokio::test]
    async fn refresh_external_activity_skips_deleted_and_child_rows() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-activity-guards").await;
        let parent = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("parent");
        let child = create_with_delegation(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            None,
            None,
            Some(DelegationLink {
                parent_conversation_id: parent.id,
                parent_tool_use_id: "tu-activity".into(),
                delegation_call_id: "call-activity".into(),
            }),
        )
        .await
        .expect("child");
        let deleted = create(&db.conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("deleted");
        soft_delete(&db.conn, deleted.id)
            .await
            .expect("soft delete");

        let later = Utc::now() + chrono::Duration::hours(1);
        assert!(
            !refresh_external_activity(&db.conn, child.id, later, 9)
                .await
                .expect("child"),
            "a delegation child is not a sidebar row"
        );
        assert!(
            !refresh_external_activity(&db.conn, deleted.id, later, 9)
                .await
                .expect("deleted"),
            "a soft-deleted conversation must never be half-resurrected"
        );

        for id in [child.id, deleted.id] {
            let raw = conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .expect("query")
                .expect("row present");
            assert_eq!(raw.message_count, 0, "row {id} untouched");
        }
    }

    #[tokio::test]
    async fn create_paths_write_expected_kinds() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/kinds").await;

        let regular = create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
            .await
            .expect("regular");
        assert_eq!(regular.kind, ConversationKind::Regular);

        let chat = create_chat(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
            .await
            .expect("chat");
        assert_eq!(chat.kind, ConversationKind::Chat);

        let child = create_with_delegation(
            &db.conn,
            folder_id,
            AgentType::Codex,
            None,
            None,
            Some(DelegationLink {
                parent_conversation_id: regular.id,
                parent_tool_use_id: "tu-kind".into(),
                delegation_call_id: "call-kind".into(),
            }),
        )
        .await
        .expect("delegate");
        assert_eq!(child.kind, ConversationKind::Delegate);
        assert_eq!(child.parent_id, Some(regular.id));
    }

    #[tokio::test]
    async fn list_all_excludes_loop_kind_rows() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/loop-filter").await;
        let keep = create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("keep".into()),
            None,
        )
        .await
        .expect("keep");
        let hide = create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("hide".into()),
            None,
        )
        .await
        .expect("hide");
        // No public write path mints kind='loop' yet (reserved for the loop
        // engine), so flip the row directly to exercise the filter.
        let mut active: conversation::ActiveModel = hide.into();
        active.kind = Set(ConversationKind::Loop);
        active.update(&db.conn).await.expect("flip kind");

        let rows = list_all(&db.conn, None, None, None, None, None, false)
            .await
            .expect("list");
        assert!(rows.iter().any(|r| r.id == keep.id), "regular row stays");
        assert!(
            !rows.iter().any(|r| r.title.as_deref() == Some("hide")),
            "loop row must be excluded"
        );
    }
}
