use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, Set,
};

use crate::db::entities::conversation;
use crate::db::error::DbError;
use crate::db::service::conversation_service;
use crate::models::{AgentType, ConversationSummary, ImportResult};
use crate::parsers::{build_agent_parser, path_eq_for_matching, AgentParser};

/// Every locally-parsable agent, in the canonical parser order.
const ALL_PARSER_AGENTS: [AgentType; 15] = [
    AgentType::ClaudeCode,
    AgentType::Codex,
    AgentType::OpenCode,
    AgentType::Gemini,
    AgentType::OpenClaw,
    AgentType::Cline,
    AgentType::Hermes,
    AgentType::CodeBuddy,
    AgentType::KimiCode,
    AgentType::Pi,
    AgentType::Grok,
    AgentType::Cursor,
    AgentType::DeepSeek,
    AgentType::Qoder,
    AgentType::Antigravity,
];

fn build_parser(agent_type: AgentType) -> Box<dyn AgentParser> {
    build_agent_parser(agent_type)
}

/// List every local agent's sessions — one `spawn_blocking` per parser so the
/// filesystem walks run concurrently (each closure captures only the Copy
/// `AgentType` and constructs its parser inside, since `dyn AgentParser` is
/// not `Send`). `on_agent_done(agent, done, total, session_count)` fires once
/// per parser (in fixed parser order) so callers can surface scan progress. A
/// parser error is logged and contributes zero sessions; the scan still
/// completes.
///
/// Delegation children (`parent_id.is_some()`) are filtered out here: they are
/// captured live by the delegation flow with their parent linkage, and
/// `import_one` inserts new rows with `parent_id: None` — importing one from a
/// parser listing would surface a sub-session as a root conversation.
/// Duplicates are dropped by `(agent_type, id)`, matching
/// `list_conversations_sync`.
pub(crate) async fn collect_local_summaries<F>(
    mut on_agent_done: F,
) -> Vec<(AgentType, ConversationSummary)>
where
    F: FnMut(AgentType, u32, u32, u32),
{
    let total = ALL_PARSER_AGENTS.len() as u32;

    let tasks: Vec<(AgentType, tokio::task::JoinHandle<Vec<ConversationSummary>>)> =
        ALL_PARSER_AGENTS
            .into_iter()
            .map(|at| {
                (
                    at,
                    tokio::task::spawn_blocking(move || {
                        match build_parser(at).list_conversations() {
                            Ok(convs) => convs,
                            Err(e) => {
                                tracing::error!("Error listing {} conversations: {}", at, e);
                                Vec::new()
                            }
                        }
                    }),
                )
            })
            .collect();

    let mut all: Vec<(AgentType, ConversationSummary)> = Vec::new();
    let mut seen: std::collections::HashSet<(AgentType, String)> = std::collections::HashSet::new();
    let mut done = 0u32;

    // Awaiting in parser order only affects callback ordering — all twelve
    // walks already run concurrently on the blocking pool.
    for (at, task) in tasks {
        let mut count = 0u32;
        match task.await {
            Ok(convs) => {
                for c in convs {
                    if c.parent_id.is_some() {
                        continue;
                    }
                    if seen.insert((at, c.id.clone())) {
                        all.push((at, c));
                        count += 1;
                    }
                }
            }
            Err(e) => {
                tracing::error!("Session listing task for {} panicked: {}", at, e);
            }
        }
        done += 1;
        on_agent_done(at, done, total, count);
    }

    all
}

/// What an import does when a parsed session already has a SOFT-DELETED row.
///
/// Deleting a conversation in codeg only stamps `deleted_at`; neither the row
/// nor the agent's session file is destroyed. So "import" has a meaningful
/// answer for a deleted session — bring it back — but only when the user asked
/// for that specific session by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeletedPolicy {
    /// Leave it deleted (and untouched). The default for every implicit pass:
    /// the whole-folder sweep and the scan's drive-by refresh both walk
    /// sessions the user never picked, and resurrecting a conversation they
    /// deliberately deleted is not a refresh.
    Skip,
    /// Un-delete the existing row in place — see
    /// [`conversation_service::restore_soft_deleted`]. Only the import picker
    /// passes this, where every item is a session the user explicitly checked
    /// while its row was badged as deleted.
    Restore,
}

/// Reconcile a batch of parsed summaries into `folder_id` via [`import_one`].
/// Returns the tally plus the ids of already-imported conversations whose title
/// was refreshed, so the caller can broadcast a sidebar upsert without
/// re-querying. Strict: the first row error aborts and propagates — this is the
/// legacy per-folder import's contract, so its public command still surfaces DB
/// failures rather than silently returning `0/0/0`. The batch importer uses the
/// resilient [`import_summaries_resilient`] instead.
pub(crate) async fn import_summaries(
    conn: &DatabaseConnection,
    folder_id: i32,
    items: &[(AgentType, ConversationSummary)],
    deleted: DeletedPolicy,
) -> Result<(ImportResult, Vec<i32>), DbError> {
    let mut imported = 0u32;
    let mut updated = 0u32;
    let mut skipped = 0u32;
    let mut restored = 0u32;
    let mut updated_ids: Vec<i32> = Vec::new();

    for (agent_type, summary) in items {
        match import_one(conn, folder_id, agent_type, summary, deleted).await? {
            ImportOutcome::Imported => imported += 1,
            ImportOutcome::Updated(id) => {
                updated += 1;
                updated_ids.push(id);
            }
            ImportOutcome::Restored => restored += 1,
            ImportOutcome::Skipped => skipped += 1,
        }
    }

    Ok((ImportResult { imported, updated, skipped, restored }, updated_ids))
}

/// Like [`import_summaries`] but resilient — a single row's DB error is logged
/// and counted in the returned `failed` count rather than aborting the group.
/// The batch importer wants this because each `import_one` insert autocommits:
/// a mid-loop `?`-abort would strand already-committed rows uncounted and leave
/// their (already-created) folder unbroadcast, and imports are idempotent so a
/// re-run finishes the rest — rolling good rows back would be worse. Callers
/// surface the `failed` count in their own structured result.
pub(crate) async fn import_summaries_resilient(
    conn: &DatabaseConnection,
    folder_id: i32,
    items: &[(AgentType, ConversationSummary)],
    deleted: DeletedPolicy,
) -> (ImportResult, Vec<i32>, u32) {
    let mut imported = 0u32;
    let mut updated = 0u32;
    let mut skipped = 0u32;
    let mut restored = 0u32;
    let mut failed = 0u32;
    let mut updated_ids: Vec<i32> = Vec::new();

    for (agent_type, summary) in items {
        match import_one(conn, folder_id, agent_type, summary, deleted).await {
            Ok(ImportOutcome::Imported) => imported += 1,
            Ok(ImportOutcome::Updated(id)) => {
                updated += 1;
                updated_ids.push(id);
            }
            Ok(ImportOutcome::Restored) => restored += 1,
            Ok(ImportOutcome::Skipped) => skipped += 1,
            Err(e) => {
                failed += 1;
                tracing::error!(
                    "Failed to import session {} ({}): {}",
                    summary.id,
                    agent_type,
                    e
                );
            }
        }
    }

    (
        ImportResult { imported, updated, skipped, restored },
        updated_ids,
        failed,
    )
}

/// Import (and refresh the titles of) the local agent sessions under
/// `folder_path`. Strict: a DB error surfaces to the caller (the legacy
/// command's back-compat contract).
///
/// A whole-folder sweep never restores: [`DeletedPolicy::Skip`], because the
/// user picked a FOLDER here, not the individual sessions, and every session
/// they ever deleted under it would come back.
pub async fn import_local_conversations(
    conn: &DatabaseConnection,
    folder_id: i32,
    folder_path: &str,
) -> Result<(ImportResult, Vec<i32>), DbError> {
    let summaries = collect_local_summaries(|_, _, _, _| {}).await;
    let matched: Vec<(AgentType, ConversationSummary)> = summaries
        .into_iter()
        .filter(|(_, c)| {
            c.folder_path
                .as_deref()
                .map(|p| path_eq_for_matching(p, folder_path))
                .unwrap_or(false)
        })
        .collect();

    import_summaries(conn, folder_id, &matched, DeletedPolicy::Skip).await
}

/// Outcome of reconciling a single parsed session against the DB.
#[derive(Debug, PartialEq, Eq)]
enum ImportOutcome {
    /// A new conversation row was inserted.
    Imported,
    /// An already-imported conversation was refreshed in place (title and/or
    /// transcript activity); carries the row id so the caller can broadcast a
    /// sidebar upsert.
    Updated(i32),
    /// A soft-deleted conversation was brought back (and then refreshed like
    /// any other existing row). Counted separately from `Updated` because the
    /// user is owed a distinct number: "3 restored" is a different fact from
    /// "3 titles refreshed".
    Restored,
    /// Already imported and nothing changed — or the row is one the sidebar
    /// never shows (a delegation child, or a soft-deleted row under
    /// [`DeletedPolicy::Skip`]).
    Skipped,
}

/// The `conversation.agent_type` column's string form.
fn agent_type_db_str(agent_type: &AgentType) -> String {
    serde_json::to_value(agent_type)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

/// Reconcile ONE already-imported conversation against a fresh parse of its
/// agent-side session file. Returns `true` when a row was written, so the
/// caller can count it and broadcast a sidebar upsert. Never inserts, never
/// moves the conversation between folders.
///
/// Two independent refreshes, because a re-scan can find either kind of drift
/// (or both) — a session titled after the fact, and a session the user kept
/// working on in the agent's own CLI:
///
/// * [`conversation_service::refresh_auto_title`] adopts a title that did not
///   exist at first import. A missing/empty parsed title leaves the existing
///   one intact rather than nulling it, a locked title is never clobbered, and
///   it deliberately does not bump `updated_at` (a title is metadata, not
///   activity).
/// * [`conversation_service::refresh_external_activity`] adopts the transcript's
///   own last-activity time into `updated_at` (plus the fresh `message_count`)
///   when it is strictly newer, so a conversation continued outside codeg sorts
///   and reads correctly in a recency-ordered sidebar.
///
/// Both are single conditional UPDATEs whose guards are re-evaluated by the
/// database at write time, so a concurrent manual rename or a live turn wins.
/// The `if` conditions here only mirror those guards in Rust to skip the
/// round-trip when nothing drifted — a converged conversation (the common case,
/// and every row on a re-scan) costs ZERO statements, which is what keeps a
/// whole-machine scan over thousands of imported sessions cheap.
async fn refresh_existing(
    conn: &DatabaseConnection,
    existing: &conversation::Model,
    summary: &ConversationSummary,
) -> Result<bool, DbError> {
    // Rows the sidebar never shows are left completely alone: a delegation
    // child is not a sidebar row (the upsert broadcast suppresses it too, which
    // would also desync the `updated` count), and a soft-deleted conversation
    // must stay deleted — a REFRESH never resurrects. (Restoring is a separate,
    // explicitly-requested step in `import_one`, which un-deletes the row and
    // updates this model before calling here, so the guard below sees a live
    // row and the restored conversation still gets its title/activity refresh.)
    if existing.parent_id.is_some() || existing.deleted_at.is_some() {
        return Ok(false);
    }

    let mut wrote = false;

    if !existing.title_locked {
        if let Some(title) = summary
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty() && existing.title.as_deref() != Some(*t))
        {
            wrote |= conversation_service::refresh_auto_title(conn, existing.id, title.to_string())
                .await?;
        }
    }

    if let Some(activity_at) = summary.ended_at.filter(|at| *at > existing.updated_at) {
        wrote |= conversation_service::refresh_external_activity(
            conn,
            existing.id,
            activity_at,
            summary.message_count,
        )
        .await?;
    }

    Ok(wrote)
}

/// Refresh every already-imported session in `items` in place — see
/// [`refresh_existing`]. Returns the ids actually written so the caller can
/// broadcast sidebar upserts.
///
/// Unlike [`import_one`] this NEVER inserts: a session the user has not
/// imported yet stays untouched (and unimported) until they pick it. It rides
/// along with the import-picker scan, which already has to load `rows` — every
/// conversation carrying an `external_id` — to mark which sessions exist, so
/// the sync costs one index build plus one UPDATE per row that genuinely
/// drifted, with no per-session SELECT.
///
/// `rows` is matched, not `items`, so every row carrying an `external_id` is
/// visited directly rather than looked up per session. (An earlier version of
/// this comment claimed the pair had no unique index and that duplicate rows
/// therefore had to converge — both are wrong: the init migration creates
/// `idx_conversation_external_agent` UNIQUE over `(external_id, agent_type)`,
/// so duplicates cannot exist. The iteration shape is unchanged; only the
/// stated reason was.) A row error is logged and skipped: a best-effort refresh
/// must never fail the scan it rides along with.
pub(crate) async fn sync_imported_sessions(
    conn: &DatabaseConnection,
    rows: &[conversation::Model],
    items: &[(AgentType, ConversationSummary)],
) -> Vec<i32> {
    let parsed: std::collections::HashMap<(String, &str), &ConversationSummary> = items
        .iter()
        .map(|(at, s)| ((agent_type_db_str(at), s.id.as_str()), s))
        .collect();

    let mut refreshed = Vec::new();
    for row in rows {
        if row.parent_id.is_some() || row.deleted_at.is_some() {
            continue;
        }
        let Some(external_id) = row.external_id.as_deref() else {
            continue;
        };
        let Some(summary) = parsed.get(&(row.agent_type.clone(), external_id)) else {
            continue;
        };
        match refresh_existing(conn, row, summary).await {
            Ok(true) => refreshed.push(row.id),
            Ok(false) => {}
            Err(e) => tracing::error!(
                "Failed to refresh imported session {} ({}): {}",
                external_id,
                row.agent_type,
                e
            ),
        }
    }
    refreshed
}

/// Insert a brand-new conversation, or — when it already exists — refresh it in
/// place from the freshly parsed session file (see [`refresh_existing`]). A
/// soft-deleted row is restored first when `deleted` says so (see
/// [`DeletedPolicy`]), and only then refreshed like any other existing row.
async fn import_one(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: &AgentType,
    summary: &ConversationSummary,
    deleted: DeletedPolicy,
) -> Result<ImportOutcome, DbError> {
    let at_str = agent_type_db_str(agent_type);

    let exists = conversation::Entity::find()
        .filter(conversation::Column::ExternalId.eq(&summary.id))
        .filter(conversation::Column::AgentType.eq(&at_str))
        .one(conn)
        .await?;

    if let Some(mut existing) = exists {
        // A delegation child is never a sidebar row, so it is left completely
        // alone whatever the policy — including no token-usage invalidation.
        if existing.parent_id.is_some() {
            return Ok(ImportOutcome::Skipped);
        }

        // Deleted, and the caller did not ask to restore: leave it deleted and
        // untouched (mirrors the guard inside [`refresh_existing`], so it must
        // not pick up a token-usage invalidation either).
        let restoring = existing.deleted_at.is_some();
        if restoring && deleted == DeletedPolicy::Skip {
            return Ok(ImportOutcome::Skipped);
        }

        // Un-delete BEFORE refreshing: both refreshes are conditional UPDATEs
        // filtered on `deleted_at IS NULL`, so a title/activity refresh run
        // first would silently no-op and the restored row would come back
        // stale. A restore that loses the race (the row was un-deleted
        // concurrently) still falls through to the refresh below, and is
        // reported as `Updated`/`Skipped` rather than double-counted.
        let mut won_restore = false;
        if restoring {
            won_restore =
                conversation_service::restore_soft_deleted(conn, existing.id, folder_id).await?;
            // Bring the in-memory model in line with what the UPDATE just
            // wrote, so `refresh_existing`'s mirrored guards (which read this
            // model, not the DB) see a live row and let the title/activity
            // refresh through. `deleted_at` clears either way: losing the race
            // means somebody else un-deleted the row, so it is live regardless
            // — only the two columns THIS call would have written are
            // conditional on having won.
            existing.deleted_at = None;
            if won_restore {
                existing.folder_id = folder_id;
                existing.status = conversation::ConversationStatus::PendingReview;
            }
        }
        // The user just pointed at this session's file on disk, which is the
        // one moment we know its transcript may have grown in the agent's own
        // CLI since we last read it. `refresh_existing` only bumps `updated_at`
        // when the parsed activity time is strictly newer, and a title refresh
        // deliberately never bumps it at all, so the token-usage stamp would
        // otherwise keep reporting the conversation as already counted. Mark it
        // for re-parse; a failure is non-fatal (the import is the user's goal,
        // and "Rebuild all" still recovers).
        //
        // This deliberately sits HERE and not inside [`refresh_existing`],
        // which the whole-machine re-scan also calls: that path's cheapness
        // rests on a converged conversation costing zero statements, and an
        // unconditional invalidation would be one write per row per scan.
        if let Err(e) =
            crate::db::service::token_usage_service::mark_stale_for_reparse(conn, existing.id).await
        {
            tracing::warn!(
                conversation_id = existing.id,
                error = %e,
                "import: failed to invalidate the token-usage stamp"
            );
        }
        let wrote = refresh_existing(conn, &existing, summary).await?;
        // A restore subsumes whatever the refresh did: the row came back, which
        // is the outcome the user asked for and the one worth reporting.
        return Ok(if won_restore {
            ImportOutcome::Restored
        } else if wrote {
            ImportOutcome::Updated(existing.id)
        } else {
            ImportOutcome::Skipped
        });
    }

    let created_at = summary.started_at;
    let updated_at = summary.ended_at.unwrap_or(created_at);
    let conv = conversation::ActiveModel {
        id: NotSet,
        folder_id: Set(folder_id),
        title: Set(summary.title.clone()),
        title_locked: Set(false),
        agent_type: Set(at_str),
        // Imported sessions land as `PendingReview` ("待审查"), not `Completed`:
        // they are surfaced for the user to review and stay visible even when
        // the sidebar's "show completed" filter is off (now its default).
        status: Set(conversation::ConversationStatus::PendingReview),
        // Imports scan regular folders' session files; chat scratch dirs and
        // loop runs are never import targets, so every imported row is regular.
        kind: Set(conversation::ConversationKind::Regular),
        model: Set(summary.model.clone()),
        git_branch: Set(summary.git_branch.clone()),
        external_id: Set(Some(summary.id.clone())),
        parent_id: Set(None),
        parent_tool_use_id: Set(None),
        delegation_call_id: Set(None),
        message_count: Set(summary.message_count as i32),
        created_at: Set(created_at),
        updated_at: Set(updated_at),
        deleted_at: Set(None),
        pinned_at: Set(None),
        pin_order: Set(None),
        origin_cwd: Set(None),
    };
    conv.insert(conn).await?;
    Ok(ImportOutcome::Imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
    use chrono::{DateTime, Duration, Utc};

    /// [`import_one`] under [`DeletedPolicy::Skip`] — the implicit-pass
    /// contract (whole-folder sweep, scan drive-by refresh). The restore tests
    /// call `import_one` directly with [`DeletedPolicy::Restore`].
    async fn import_one_skip(
        conn: &DatabaseConnection,
        folder_id: i32,
        agent_type: &AgentType,
        summary: &ConversationSummary,
    ) -> Result<ImportOutcome, DbError> {
        import_one(conn, folder_id, agent_type, summary, DeletedPolicy::Skip).await
    }

    fn summary(id: &str, title: Option<&str>) -> ConversationSummary {
        ConversationSummary {
            id: id.to_string(),
            agent_type: AgentType::ClaudeCode,
            folder_path: Some("/tmp/codeg-import".to_string()),
            folder_name: None,
            title: title.map(|t| t.to_string()),
            started_at: Utc::now(),
            ended_at: None,
            message_count: 3,
            model: None,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        }
    }

    /// A parse of a session whose transcript ends at `ended_at` — what a
    /// re-scan sees after the user kept working on it in the agent's own CLI.
    fn timed_summary(
        id: &str,
        title: Option<&str>,
        ended_at: DateTime<Utc>,
        message_count: u32,
    ) -> ConversationSummary {
        ConversationSummary {
            started_at: ended_at - Duration::hours(1),
            ended_at: Some(ended_at),
            message_count,
            ..summary(id, title)
        }
    }

    async fn find_row(conn: &DatabaseConnection, ext: &str) -> conversation::Model {
        conversation::Entity::find()
            .filter(conversation::Column::ExternalId.eq(ext))
            .one(conn)
            .await
            .expect("query")
            .expect("row exists")
    }

    /// Every conversation carrying an `external_id` — the row set the import
    /// scan loads and hands to [`sync_imported_sessions`].
    async fn external_rows(conn: &DatabaseConnection) -> Vec<conversation::Model> {
        conversation::Entity::find()
            .filter(conversation::Column::ExternalId.is_not_null())
            .all(conn)
            .await
            .expect("query")
    }

    async fn find_id(conn: &DatabaseConnection, ext: &str) -> i32 {
        conversation::Entity::find()
            .filter(conversation::Column::ExternalId.eq(ext))
            .one(conn)
            .await
            .expect("query")
            .expect("row exists")
            .id
    }

    #[tokio::test]
    async fn reimport_refreshes_a_changed_title() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import").await;
        let at = AgentType::ClaudeCode;

        let first = import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("first prompt")))
            .await
            .expect("import");
        assert_eq!(first, ImportOutcome::Imported);

        let id = find_id(&db.conn, "ext-1").await;
        // The agent generated an AI title only after the first import; a
        // re-import must adopt it.
        let again = import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("AI Summary")))
            .await
            .expect("re-import");
        assert_eq!(again, ImportOutcome::Updated(id));

        let got = conversation_service::get_by_id(&db.conn, id)
            .await
            .expect("get");
        assert_eq!(got.title.as_deref(), Some("AI Summary"));
        assert!(!got.title_locked, "auto refresh must not lock the title");
    }

    #[tokio::test]
    async fn reimport_marks_the_conversation_for_a_token_usage_re_parse() {
        // A re-import is the one moment we learn a transcript may have grown in
        // the agent's own CLI. Nothing else here bumps `updated_at` (by
        // design), so without this the dashboard would keep reporting the
        // conversation as already counted and silently under-report it.
        use crate::db::service::token_usage_service::{
            self as usage, replace_conversation_facts, UsageFact,
        };

        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-usage").await;
        let at = AgentType::ClaudeCode;

        import_one_skip(&db.conn, folder, &at, &summary("ext-usage", Some("t")))
            .await
            .expect("import");
        let id = find_id(&db.conn, "ext-usage").await;
        let updated_at = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .expect("query")
            .expect("row")
            .updated_at;

        replace_conversation_facts(
            &db.conn,
            id,
            updated_at,
            &[UsageFact {
                turn_key: "t1".into(),
                occurred_at: Utc::now(),
                model: None,
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                duration_ms: 0,
            }],
        )
        .await
        .expect("record usage");
        assert!(!usage::list_sync_candidates(&db.conn).await.expect("c")[0].is_stale());

        // Same title, so the title-refresh path reports `Skipped` — the mark
        // must land regardless of whether the title moved.
        let again = import_one_skip(&db.conn, folder, &at, &summary("ext-usage", Some("t")))
            .await
            .expect("re-import");
        assert_eq!(again, ImportOutcome::Skipped);

        let candidate = usage::list_sync_candidates(&db.conn).await.expect("c")[0].clone();
        assert!(candidate.is_stale());
        // The stamp row itself survives, so a transcript that turns out to be
        // unreachable on the re-parse can't erase the facts we already have.
        assert_eq!(candidate.synced_turn_count, Some(1));
    }

    #[tokio::test]
    async fn import_inserts_a_pending_review_conversation() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-status").await;
        let at = AgentType::ClaudeCode;

        assert_eq!(
            import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("first prompt")))
                .await
                .expect("import"),
            ImportOutcome::Imported
        );

        let id = find_id(&db.conn, "ext-1").await;
        let got = conversation_service::get_by_id(&db.conn, id)
            .await
            .expect("get");
        // Imported rows are surfaced for review, not marked done — so they stay
        // visible even when the sidebar hides completed conversations.
        // `DbConversationSummary.status` is the serde-serialized string
        // (`rename_all = "snake_case"`), not the enum.
        assert_eq!(got.status, "pending_review");
    }

    #[tokio::test]
    async fn reimport_skips_an_unchanged_title() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-same").await;
        let at = AgentType::ClaudeCode;
        let s = summary("ext-1", Some("same title"));

        assert_eq!(
            import_one_skip(&db.conn, folder, &at, &s).await.expect("import"),
            ImportOutcome::Imported
        );
        assert_eq!(
            import_one_skip(&db.conn, folder, &at, &s)
                .await
                .expect("re-import"),
            ImportOutcome::Skipped
        );
    }

    #[tokio::test]
    async fn reimport_never_clobbers_a_manual_rename() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-lock").await;
        let at = AgentType::ClaudeCode;

        import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("first prompt")))
            .await
            .expect("import");
        let id = find_id(&db.conn, "ext-1").await;
        conversation_service::update_title(&db.conn, id, "User Pick".into())
            .await
            .expect("rename");

        let outcome = import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("AI Summary")))
            .await
            .expect("re-import");
        assert_eq!(
            outcome,
            ImportOutcome::Skipped,
            "a locked title must not be touched by import"
        );

        let got = conversation_service::get_by_id(&db.conn, id)
            .await
            .expect("get");
        assert_eq!(got.title.as_deref(), Some("User Pick"));
    }

    #[tokio::test]
    async fn reimport_with_no_title_keeps_the_existing_one() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-empty").await;
        let at = AgentType::ClaudeCode;

        import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("kept title")))
            .await
            .expect("import");
        let id = find_id(&db.conn, "ext-1").await;

        // A parse that yields no title (or only whitespace) must not null the
        // existing title.
        assert_eq!(
            import_one_skip(&db.conn, folder, &at, &summary("ext-1", None))
                .await
                .expect("none"),
            ImportOutcome::Skipped
        );
        assert_eq!(
            import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("   ")))
                .await
                .expect("blank"),
            ImportOutcome::Skipped
        );
        let got = conversation_service::get_by_id(&db.conn, id)
            .await
            .expect("get");
        assert_eq!(got.title.as_deref(), Some("kept title"));
    }

    #[tokio::test]
    async fn reimport_skips_a_soft_deleted_conversation() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-deleted").await;
        let at = AgentType::ClaudeCode;

        import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("original")))
            .await
            .expect("import");
        let id = find_id(&db.conn, "ext-1").await;
        conversation_service::soft_delete(&db.conn, id)
            .await
            .expect("soft delete");

        // A re-import must neither resurrect nor rewrite a deleted conversation.
        let outcome = import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("AI Summary")))
            .await
            .expect("re-import");
        assert_eq!(outcome, ImportOutcome::Skipped);

        let row = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .expect("query")
            .expect("row still present");
        assert_eq!(row.title.as_deref(), Some("original"), "title untouched");
        assert!(row.deleted_at.is_some(), "must stay soft-deleted");
    }

    #[tokio::test]
    async fn restore_brings_a_soft_deleted_conversation_back_in_place() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-restore").await;
        let at = AgentType::ClaudeCode;

        let first_end = Utc::now() - Duration::hours(5);
        import_one_skip(
            &db.conn,
            folder,
            &at,
            &timed_summary("ext-1", Some("original"), first_end, 2),
        )
        .await
        .expect("import");
        let id = find_id(&db.conn, "ext-1").await;
        conversation_service::soft_delete(&db.conn, id)
            .await
            .expect("soft delete");

        // The user checked this deleted session in the picker. It comes back as
        // the SAME row (id and all — nothing was ever physically deleted), and
        // picks up the drift the transcript accumulated while it was gone.
        let later = first_end + Duration::hours(2);
        let outcome = import_one(
            &db.conn,
            folder,
            &at,
            &timed_summary("ext-1", Some("AI Summary"), later, 9),
            DeletedPolicy::Restore,
        )
        .await
        .expect("restore");
        assert_eq!(outcome, ImportOutcome::Restored);

        let rows = conversation::Entity::find()
            .filter(conversation::Column::ExternalId.eq("ext-1"))
            .all(&db.conn)
            .await
            .expect("query");
        assert_eq!(rows.len(), 1, "restored in place, never re-inserted");
        assert_eq!(rows[0].id, id, "same row: history, tabs and children hold");
        assert!(rows[0].deleted_at.is_none(), "back from the dead");
        assert_eq!(
            rows[0].status,
            conversation::ConversationStatus::PendingReview,
            "restored rows survive the sidebar's default completed filter"
        );
        assert_eq!(
            rows[0].title.as_deref(),
            Some("AI Summary"),
            "the refresh runs AFTER the un-delete, not against a deleted row"
        );
        assert_eq!(rows[0].updated_at, later, "adopts the newer activity");
        assert_eq!(rows[0].message_count, 9);
    }

    #[tokio::test]
    async fn restore_is_idempotent_and_leaves_a_live_row_alone() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-restore-twice").await;
        let at = AgentType::ClaudeCode;

        import_one_skip(&db.conn, folder, &at, &summary("ext-1", Some("kept")))
            .await
            .expect("import");
        let id = find_id(&db.conn, "ext-1").await;
        conversation_service::soft_delete(&db.conn, id)
            .await
            .expect("soft delete");

        assert_eq!(
            import_one(&db.conn, folder, &at, &summary("ext-1", Some("kept")), DeletedPolicy::Restore)
                .await
                .expect("restore"),
            ImportOutcome::Restored
        );
        // A second pass has nothing left to restore: the row is live, so it is
        // an ordinary already-imported row and must not be counted again.
        assert_eq!(
            import_one(&db.conn, folder, &at, &summary("ext-1", Some("kept")), DeletedPolicy::Restore)
                .await
                .expect("re-run"),
            ImportOutcome::Skipped
        );
    }

    #[tokio::test]
    async fn restore_lands_the_conversation_in_the_import_target_folder() {
        let db = fresh_in_memory_db().await;
        let old_folder = seed_folder(&db, "/tmp/codeg-restore-old").await;
        let target = seed_folder(&db, "/tmp/codeg-restore-target").await;
        let at = AgentType::ClaudeCode;

        import_one_skip(&db.conn, old_folder, &at, &summary("ext-1", Some("t")))
            .await
            .expect("import");
        let id = find_id(&db.conn, "ext-1").await;
        conversation_service::soft_delete(&db.conn, id)
            .await
            .expect("soft delete");

        import_one(&db.conn, target, &at, &summary("ext-1", Some("t")), DeletedPolicy::Restore)
            .await
            .expect("restore");

        // The picker's group folder is the one `add_folder` just made live AND
        // open; the row's own folder may have been removed or closed since,
        // and a conversation restored into an invisible folder reads as a
        // restore that did not work.
        assert_eq!(find_row(&db.conn, "ext-1").await.folder_id, target);
    }

    #[tokio::test]
    async fn restore_never_touches_a_delegation_child() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-restore-child").await;
        let at = AgentType::ClaudeCode;

        import_one_skip(&db.conn, folder, &at, &summary("parent-ext", Some("p")))
            .await
            .expect("import parent");
        let parent_id = find_id(&db.conn, "parent-ext").await;

        let now = Utc::now();
        conversation::ActiveModel {
            id: NotSet,
            folder_id: Set(folder),
            title: Set(Some("child".to_string())),
            title_locked: Set(false),
            agent_type: Set(agent_type_db_str(&at)),
            status: Set(conversation::ConversationStatus::Completed),
            kind: Set(conversation::ConversationKind::Delegate),
            model: Set(None),
            git_branch: Set(None),
            external_id: Set(Some("child-ext".to_string())),
            parent_id: Set(Some(parent_id)),
            parent_tool_use_id: Set(None),
            delegation_call_id: Set(None),
            message_count: Set(1),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_at: Set(Some(now)),
            pinned_at: Set(None),
            pin_order: Set(None),
            origin_cwd: Set(None),
        }
        .insert(&db.conn)
        .await
        .expect("insert deleted child");

        // A delegation child is not a sidebar row, so "restore" has no meaning
        // for it — it would surface a sub-session as a root conversation.
        assert_eq!(
            import_one(&db.conn, folder, &at, &summary("child-ext", Some("x")), DeletedPolicy::Restore)
                .await
                .expect("restore child"),
            ImportOutcome::Skipped
        );
        let child = find_row(&db.conn, "child-ext").await;
        assert!(child.deleted_at.is_some(), "child stays deleted");
        assert_eq!(child.title.as_deref(), Some("child"), "child untouched");
    }

    #[tokio::test]
    async fn reimport_adopts_newer_transcript_activity() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-activity").await;
        let at = AgentType::ClaudeCode;

        let first_end = Utc::now() - Duration::hours(3);
        import_one_skip(
            &db.conn,
            folder,
            &at,
            &timed_summary("ext-1", Some("kept"), first_end, 2),
        )
        .await
        .expect("import");
        let created_at = find_row(&db.conn, "ext-1").await.created_at;
        let id = find_id(&db.conn, "ext-1").await;

        // The user resumed the session in the agent's own CLI and sent more
        // messages; a re-scan must move it to the front of a recency-sorted
        // sidebar and show the transcript's time, not the scan's.
        let later = first_end + Duration::hours(1);
        assert_eq!(
            import_one_skip(
                &db.conn,
                folder,
                &at,
                &timed_summary("ext-1", Some("kept"), later, 5)
            )
            .await
            .expect("re-import"),
            ImportOutcome::Updated(id)
        );

        let row = find_row(&db.conn, "ext-1").await;
        assert_eq!(row.updated_at, later, "updated_at follows the transcript");
        assert_eq!(row.message_count, 5);
        assert_eq!(
            row.created_at, created_at,
            "created_at is the original session start and must not move"
        );
        assert_eq!(row.title.as_deref(), Some("kept"));
    }

    #[tokio::test]
    async fn reimport_never_moves_updated_at_backwards() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-monotonic").await;
        let at = AgentType::ClaudeCode;

        let end = Utc::now() - Duration::hours(1);
        import_one_skip(
            &db.conn,
            folder,
            &at,
            &timed_summary("ext-1", Some("kept"), end, 4),
        )
        .await
        .expect("import");

        // Re-scanning the same transcript, or one that somehow parses older
        // (clock skew, a truncated tail), must change nothing at all.
        for (ended_at, label) in [(end, "identical"), (end - Duration::hours(2), "older")] {
            assert_eq!(
                import_one_skip(
                    &db.conn,
                    folder,
                    &at,
                    &timed_summary("ext-1", Some("kept"), ended_at, 99)
                )
                .await
                .expect("re-import"),
                ImportOutcome::Skipped,
                "{label} activity must be a no-op"
            );
        }

        let row = find_row(&db.conn, "ext-1").await;
        assert_eq!(row.updated_at, end);
        assert_eq!(row.message_count, 4);
    }

    #[tokio::test]
    async fn activity_refresh_preserves_pin_status_and_locked_title() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-preserve").await;
        let at = AgentType::ClaudeCode;

        import_one_skip(
            &db.conn,
            folder,
            &at,
            &timed_summary("ext-1", Some("first prompt"), Utc::now(), 2),
        )
        .await
        .expect("import");
        let id = find_id(&db.conn, "ext-1").await;
        conversation_service::update_title(&db.conn, id, "User Pick".into())
            .await
            .expect("rename");
        conversation_service::update_pin(&db.conn, id, true)
            .await
            .expect("pin");
        conversation_service::update_status(
            &db.conn,
            id,
            conversation::ConversationStatus::Completed,
        )
        .await
        .expect("status");

        let later = Utc::now() + Duration::hours(1);
        assert_eq!(
            import_one_skip(
                &db.conn,
                folder,
                &at,
                &timed_summary("ext-1", Some("AI Summary"), later, 6)
            )
            .await
            .expect("re-import"),
            ImportOutcome::Updated(id),
            "activity alone is enough to report an update"
        );

        let row = find_row(&db.conn, "ext-1").await;
        assert_eq!(row.updated_at, later);
        assert_eq!(row.message_count, 6);
        assert_eq!(row.title.as_deref(), Some("User Pick"), "rename survives");
        assert!(row.title_locked);
        assert!(row.pinned_at.is_some(), "pin survives");
        assert_eq!(
            row.status,
            conversation::ConversationStatus::Completed,
            "codeg's own status survives"
        );
    }

    #[tokio::test]
    async fn sync_imported_sessions_refreshes_in_place_and_never_inserts() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-sync-scan").await;
        let at = AgentType::ClaudeCode;

        let end = Utc::now() - Duration::hours(2);
        import_one_skip(
            &db.conn,
            folder,
            &at,
            &timed_summary("ext-live", Some("first prompt"), end, 2),
        )
        .await
        .expect("import");
        let live_id = find_id(&db.conn, "ext-live").await;

        // What a re-scan sees: the imported session grew AND got a title, plus
        // a session the user has never imported.
        let later = end + Duration::hours(1);
        let items = vec![
            (at, timed_summary("ext-live", Some("AI Summary"), later, 5)),
            (at, timed_summary("ext-never", Some("untouched"), later, 3)),
        ];
        let rows = external_rows(&db.conn).await;
        assert_eq!(
            sync_imported_sessions(&db.conn, &rows, &items).await,
            vec![live_id]
        );

        let row = find_row(&db.conn, "ext-live").await;
        assert_eq!(row.updated_at, later);
        assert_eq!(row.message_count, 5);
        assert_eq!(row.title.as_deref(), Some("AI Summary"));

        assert!(
            conversation::Entity::find()
                .filter(conversation::Column::ExternalId.eq("ext-never"))
                .one(&db.conn)
                .await
                .expect("query")
                .is_none(),
            "a session the user never imported must stay unimported"
        );

        // Idempotent: a second scan over the same transcripts writes nothing.
        let rows = external_rows(&db.conn).await;
        assert!(sync_imported_sessions(&db.conn, &rows, &items)
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn sync_imported_sessions_skips_deleted_rows() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-sync-deleted").await;
        let at = AgentType::ClaudeCode;

        let end = Utc::now() - Duration::hours(2);
        import_one_skip(
            &db.conn,
            folder,
            &at,
            &timed_summary("ext-1", Some("original"), end, 2),
        )
        .await
        .expect("import");
        let id = find_id(&db.conn, "ext-1").await;
        conversation_service::soft_delete(&db.conn, id)
            .await
            .expect("soft delete");

        let items = vec![(
            at,
            timed_summary("ext-1", Some("AI Summary"), end + Duration::hours(1), 9),
        )];
        let rows = external_rows(&db.conn).await;
        assert!(
            sync_imported_sessions(&db.conn, &rows, &items)
                .await
                .is_empty(),
            "a deleted conversation must never be half-resurrected by a scan"
        );

        let row = find_row(&db.conn, "ext-1").await;
        assert_eq!(row.updated_at, end, "activity untouched");
        assert_eq!(row.message_count, 2);
        assert_eq!(row.title.as_deref(), Some("original"));
        assert!(row.deleted_at.is_some());
    }

    #[tokio::test]
    async fn reimport_skips_a_delegation_child() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-import-child").await;
        let at = AgentType::ClaudeCode;
        let at_str = serde_json::to_value(at)
            .expect("ser")
            .as_str()
            .expect("str")
            .to_string();

        // A root conversation to parent the child.
        import_one_skip(&db.conn, folder, &at, &summary("parent-ext", Some("parent")))
            .await
            .expect("import parent");
        let parent_id = find_id(&db.conn, "parent-ext").await;

        // A delegation child carrying its own external_id, as a parser would
        // surface that child's session file on disk.
        let now = Utc::now();
        conversation::ActiveModel {
            id: NotSet,
            folder_id: Set(folder),
            title: Set(Some("child original".to_string())),
            title_locked: Set(false),
            agent_type: Set(at_str),
            status: Set(conversation::ConversationStatus::Completed),
            kind: Set(conversation::ConversationKind::Delegate),
            model: Set(None),
            git_branch: Set(None),
            external_id: Set(Some("child-ext".to_string())),
            parent_id: Set(Some(parent_id)),
            parent_tool_use_id: Set(None),
            delegation_call_id: Set(None),
            message_count: Set(1),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_at: Set(None),
            pinned_at: Set(None),
            pin_order: Set(None),
            origin_cwd: Set(None),
        }
        .insert(&db.conn)
        .await
        .expect("insert child");

        let outcome = import_one_skip(&db.conn, folder, &at, &summary("child-ext", Some("AI Summary")))
            .await
            .expect("re-import child");
        assert_eq!(
            outcome,
            ImportOutcome::Skipped,
            "a delegation child is never a sidebar row"
        );

        let child_id = find_id(&db.conn, "child-ext").await;
        let row = conversation::Entity::find_by_id(child_id)
            .one(&db.conn)
            .await
            .expect("query")
            .expect("child present");
        assert_eq!(
            row.title.as_deref(),
            Some("child original"),
            "child title untouched"
        );
    }
}
