//! The personal agent's whole schema in one step: every `personal_agent*`
//! table with its indexes, the full-text index over the history and the
//! triggers that keep it in step, the two columns the feature adds to tables
//! of their own (`work_task.personal_agent_dispatch_id`, the dispatch that
//! created the task; `conversation.bot_uid`, the assistant a delegation
//! child ran as), and the assistants the owner had made in the collaboration
//! settings (the `assistant` table, released before this) made assistants of
//! their own: each one a worker whose work runs on what it ran on, hidden
//! when it was turned off. The feature had no release before this, so this
//! builds the final shape directly.
//!
//! The statements are plain SQL rather than the schema builder because some
//! of them cannot be built that way (the partial unique index that allows one
//! live primary assistant, the FTS5 table and its triggers) and one form for
//! all of them reads more easily side by side.
//!
//! Safe to run again: SeaORM does not wrap a migration in a transaction on
//! SQLite and registers it only after `up` returns, so a process stopped in
//! between, or a second process that read the same pending list, runs this
//! once more. All of it is one transaction (a run cut short leaves nothing),
//! and every step changes nothing the second time: `IF NOT EXISTS`, a column
//! added only when `pragma_table_info` does not list it, an assistant
//! converted only when none came from it yet. Two processes are kept apart
//! by the lock `init_database` holds over the whole of `Migrator::up`.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{
    ConnectionTrait, DatabaseTransaction, DbBackend, Statement, TransactionTrait,
};

use crate::models::personal_agent_bots::BotAvatar;

#[derive(DeriveMigrationName)]
pub struct Migration;

const TABLES: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS "personal_agent" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "name" text NOT NULL DEFAULT '',
        "avatar" text NOT NULL,
        "agent_type" text NULL,
        "agent_options" text NULL,
        "label_snapshot" text NULL,
        "settings" text NOT NULL DEFAULT '{}',
        "workdir" text NULL,
        "folder_id" integer NULL,
        "revision" bigint NOT NULL DEFAULT 0,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL,
        "kind" text NOT NULL DEFAULT 'primary',
        "uid" text NULL,
        "sort_order" integer NOT NULL DEFAULT 0,
        "pinned_at" timestamp_with_timezone_text NULL,
        "section" text NULL,
        "hidden" boolean NOT NULL DEFAULT FALSE,
        "muted" boolean NOT NULL DEFAULT FALSE,
        "unread_mark" boolean NOT NULL DEFAULT FALSE,
        "notify" boolean NOT NULL DEFAULT TRUE,
        "deleted_at" timestamp_with_timezone_text NULL,
        "work_agent_type" text NOT NULL,
        "work_agent_options" text NOT NULL,
        "work_label_snapshot" text NOT NULL,
        "work_instructions" text NULL,
        "seed_persona" text NULL,
        "seed_version" integer NOT NULL DEFAULT 0,
        "workdir_ready" boolean NOT NULL DEFAULT FALSE,
        "legacy_assistant_id" integer NULL,
        "legacy_assistant_uid" text NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_segment" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "seq" integer NOT NULL,
        "agent_type" text NOT NULL,
        "agent_options" text NOT NULL,
        "conversation_id" integer NULL,
        "agent_session_id" text NULL,
        "start_reason" text NOT NULL,
        "end_reason" text NULL,
        "pending_reason" text NULL,
        "started_at" timestamp_with_timezone_text NOT NULL,
        "ended_at" timestamp_with_timezone_text NULL,
        "usage_at_end" text NULL,
        "handoff_size" integer NULL,
        "compactions_auto" integer NOT NULL DEFAULT 0,
        "compactions_manual" integer NOT NULL DEFAULT 0,
        "compactions_agent" integer NOT NULL DEFAULT 0,
        "auto_compact_paused" boolean NOT NULL DEFAULT FALSE,
        "persona_digest" text NULL,
        "team_digest" text NULL,
        "state" text NOT NULL DEFAULT '{}',
        "bot_id" integer NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_batch" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "segment_id" integer NOT NULL,
        "kind" text NOT NULL,
        "status" text NOT NULL,
        "stop_reason" text NULL,
        "detail" text NULL,
        "error" text NULL,
        "started_at" timestamp_with_timezone_text NOT NULL,
        "ended_at" timestamp_with_timezone_text NULL,
        "trigger" text NULL,
        "bot_id" integer NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_timeline" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "segment_id" integer NULL,
        "batch_id" integer NULL,
        "kind" text NOT NULL,
        "status" text NULL,
        "body" text NOT NULL DEFAULT '',
        "data" text NULL,
        "dispatch_id" integer NULL,
        "ref_id" text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL,
        "reply_to" integer NULL,
        "read_at" timestamp_with_timezone_text NULL,
        "event_id" integer NULL,
        "seen_at" timestamp_with_timezone_text NULL,
        "bot_id" integer NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_event" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "kind" text NOT NULL,
        "source_key" text NOT NULL UNIQUE,
        "coalesce_key" text NULL,
        "summary" text NOT NULL,
        "payload" text NULL,
        "wake" boolean NOT NULL DEFAULT TRUE,
        "state" text NOT NULL,
        "batch_id" integer NULL,
        "requeues" integer NOT NULL DEFAULT 0,
        "requeued_from" integer NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL,
        "bot_id" integer NULL,
        "origin_bot_id" integer NULL,
        "origin_row_id" integer NULL,
        "thread_id" integer NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_item" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "kind" text NOT NULL,
        "dispatch_id" integer NULL,
        "status" text NOT NULL,
        "waits_for" text NULL,
        "summary" text NOT NULL,
        "on_done" text NULL,
        "origin_timeline_id" integer NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL,
        "bot_id" integer NULL,
        "due_at" timestamp_with_timezone_text NULL,
        "repeat" text NULL,
        "at_due" text NULL,
        "act_spec" text NULL,
        "fired_at" timestamp_with_timezone_text NULL,
        "mention" text NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_dispatch" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "mode" text NOT NULL,
        "work_snapshot" text NOT NULL,
        "folder_id" integer NULL,
        "deliverable" text NULL,
        "title" text NOT NULL,
        "prompt" text NOT NULL,
        "work_task_id" integer NULL,
        "conversation_id" integer NULL,
        "connection_id" text NULL,
        "state" text NOT NULL,
        "result_excerpt" text NULL,
        "error" text NULL,
        "origin_batch_id" integer NULL,
        "on_done" text NULL,
        "turns" integer NOT NULL DEFAULT 0,
        "followup" text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL,
        "finished_at" timestamp_with_timezone_text NULL,
        "source_batch_id" integer NULL,
        "round_op_id" text NULL,
        "bot_id" integer NULL,
        "origin_bot_id" integer NULL,
        "origin_row_id" integer NULL,
        "thread_id" integer NULL,
        "for_input" text NULL,
        "done_when" text NULL,
        "pr_fix" text NULL,
        "is_check" boolean NOT NULL DEFAULT FALSE,
        "replaces_id" integer NULL,
        "replaces_run_seq" integer NULL,
        "replaced_by" integer NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_action" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "batch_id" integer NOT NULL,
        "key" text NOT NULL,
        "kind" text NOT NULL,
        "state" text NOT NULL,
        "ref_id" text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL,
        "op_id" text NULL,
        "payload" text NULL,
        "observed" text NULL,
        "target" text NULL,
        "notice_id" integer NULL,
        "attempted_at" timestamp_with_timezone_text NULL,
        "detail" text NULL,
        "bot_id" integer NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_notice" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "kind" text NOT NULL,
        "subject_key" text NULL,
        "level" text NOT NULL,
        "state" text NOT NULL,
        "timeline_id" integer NULL,
        "batch_id" integer NULL,
        "payload" text NOT NULL,
        "notified_at" timestamp_with_timezone_text NULL,
        "acted_at" timestamp_with_timezone_text NULL,
        "expires_at" timestamp_with_timezone_text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL,
        "bot_id" integer NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_message" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "thread_id" integer NULL,
        "from_bot_id" integer NOT NULL,
        "to_bot_id" integer NOT NULL,
        "reply_to" integer NULL,
        "body" text NOT NULL,
        "wants_reply" boolean NOT NULL DEFAULT FALSE,
        "state" text NOT NULL DEFAULT 'queued',
        "sent_batch_id" integer NULL,
        "delivered_batch_id" integer NULL,
        "origin_bot_id" integer NULL,
        "origin_row_id" integer NULL,
        "for_input" text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_thread" (
        "id" integer NOT NULL PRIMARY KEY,
        "state" text NOT NULL DEFAULT 'open',
        "counts" text NOT NULL DEFAULT '{}',
        "last_progress_at" timestamp_with_timezone_text NULL,
        "origin_bot_id" integer NULL,
        "origin_row_id" integer NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_activity" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "day" text NOT NULL,
        "slot" integer NOT NULL,
        "count" integer NOT NULL DEFAULT 0,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_verification" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "bot_id" integer NULL,
        "dispatch_id" integer NOT NULL,
        "check_dispatch_id" integer NULL,
        "round" integer NOT NULL,
        "run_seq" integer NOT NULL,
        "fingerprint" text NOT NULL,
        "state" text NOT NULL,
        "check_verdict" text NULL,
        "check_evidence" text NULL,
        "decision" text NULL,
        "reason" text NULL,
        "message" text NULL,
        "question" text NULL,
        "decided_by" text NULL,
        "notice_id" integer NULL,
        "unchecked" boolean NOT NULL DEFAULT FALSE,
        "delivered_head" text NULL,
        "merge_commit" text NULL,
        "version_guaranteed" boolean NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL,
        "decided_at" timestamp_with_timezone_text NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_watch" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "bot_id" integer NOT NULL,
        "item_key" text NOT NULL UNIQUE,
        "provider" text NOT NULL,
        "server_host" text NOT NULL,
        "account_id" text NOT NULL,
        "owner_repo" text NOT NULL,
        "kind" text NOT NULL,
        "number" bigint NOT NULL,
        "folder_id" integer NULL,
        "work_task_id" integer NULL,
        "dispatch_id" integer NULL,
        "source" text NOT NULL,
        "state" text NOT NULL,
        "ended_reason" text NULL,
        "url" text NULL,
        "title" text NULL,
        "pr_state" text NULL,
        "draft" boolean NOT NULL DEFAULT FALSE,
        "head_sha" text NULL,
        "mergeable" boolean NULL,
        "merge_state" text NULL,
        "checks" text NULL,
        "detail" text NULL,
        "phase" text NULL,
        "notified" text NULL,
        "quiet_first" boolean NOT NULL DEFAULT FALSE,
        "last_read_at" timestamp_with_timezone_text NULL,
        "last_change_at" timestamp_with_timezone_text NULL,
        "next_poll_at" timestamp_with_timezone_text NULL,
        "not_found" integer NOT NULL DEFAULT 0,
        "failures" integer NOT NULL DEFAULT 0,
        "backoff" boolean NOT NULL DEFAULT FALSE,
        "last_error" text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL,
        "auto" text NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_watch_name" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "folder_id" integer NOT NULL,
        "kind" text NOT NULL,
        "number" bigint NOT NULL,
        "watch_id" integer NOT NULL,
        "created_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_signal" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "kind" text NOT NULL,
        "key" text NOT NULL UNIQUE,
        "bot_id" integer NULL,
        "folder_id" integer NULL,
        "facts" text NOT NULL,
        "created_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_routine" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "bot_id" integer NOT NULL,
        "title" text NOT NULL,
        "what" text NOT NULL,
        "kind" text NOT NULL,
        "trigger" text NOT NULL,
        "cron" text NULL,
        "timezone" text NULL,
        "zone_used" text NULL,
        "event_kind" text NULL,
        "event_filter" text NULL,
        "dispatch" text NULL,
        "precheck" text NULL,
        "precheck_state" text NULL,
        "enabled" boolean NOT NULL DEFAULT TRUE,
        "paused_reason" text NULL,
        "source" text NOT NULL,
        "next_run_at" timestamp_with_timezone_text NULL,
        "last_run_at" timestamp_with_timezone_text NULL,
        "runs" integer NOT NULL DEFAULT 0,
        "failures" integer NOT NULL DEFAULT 0,
        "signal_cursor" integer NOT NULL DEFAULT 0,
        "trial_pending" boolean NOT NULL DEFAULT FALSE,
        "deleted_at" timestamp_with_timezone_text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_routine_run" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "routine_id" integer NOT NULL,
        "bot_id" integer NOT NULL,
        "seq" integer NOT NULL DEFAULT 0,
        "trigger" text NOT NULL,
        "event_key" text NULL,
        "due_at" timestamp_with_timezone_text NULL,
        "started_at" timestamp_with_timezone_text NOT NULL,
        "ended_at" timestamp_with_timezone_text NULL,
        "outcome" text NOT NULL,
        "note" text NULL,
        "batch_id" integer NULL,
        "event_id" integer NULL,
        "dispatch_id" integer NULL,
        "notice_id" integer NULL,
        "created_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_rule_state" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "rule" text NOT NULL,
        "object" text NOT NULL,
        "bot_id" integer NULL,
        "first_seen_at" timestamp_with_timezone_text NOT NULL,
        "last_seen_at" timestamp_with_timezone_text NOT NULL,
        "data" text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_brief" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "bot_id" integer NOT NULL,
        "kind" text NOT NULL,
        "day" text NOT NULL,
        "key" text NOT NULL,
        "state" text NOT NULL,
        "since" timestamp_with_timezone_text NOT NULL,
        "material" text NULL,
        "event_id" integer NULL,
        "batch_id" integer NULL,
        "row_id" integer NULL,
        "tonight" text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "ready_at" timestamp_with_timezone_text NULL,
        "delivered_at" timestamp_with_timezone_text NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_history_doc" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "source" text NOT NULL,
        "ref_id" integer NOT NULL,
        "part" text NOT NULL,
        "role" text NOT NULL,
        "bot_id" integer NULL,
        "peer_bot_id" integer NULL,
        "folder_id" integer NULL,
        "agent_type" text NULL,
        "title" text NULL,
        "body" text NOT NULL,
        "weight" integer NOT NULL,
        "at" timestamp_with_timezone_text NOT NULL,
        "row_id" integer NULL,
        "conversation_id" integer NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_history_cursor" (
        "source" text NOT NULL,
        "ref_id" integer NOT NULL,
        "at" timestamp_with_timezone_text NULL,
        "mark" integer NULL,
        PRIMARY KEY ("source", "ref_id")
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_profile" (
        "key" text NOT NULL PRIMARY KEY,
        "data" text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_plan" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "bot_id" integer NOT NULL,
        "title" text NOT NULL,
        "goal" text NULL,
        "state" text NOT NULL,
        "notice_id" integer NULL,
        "origin_batch_id" integer NULL,
        "for_input" text NULL,
        "origin_bot_id" integer NULL,
        "origin_row_id" integer NULL,
        "thread_id" integer NULL,
        "stuck_reason" text NULL,
        "changes" text NOT NULL DEFAULT '[]',
        "told" text NULL,
        "started_at" timestamp_with_timezone_text NULL,
        "ended_at" timestamp_with_timezone_text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_plan_step" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "plan_id" integer NOT NULL,
        "seq" integer NOT NULL,
        "title" text NOT NULL,
        "target_kind" text NOT NULL,
        "target_id" integer NOT NULL,
        "target_name" text NOT NULL,
        "mode" text NULL,
        "project_id" integer NULL,
        "deliverable" text NULL,
        "prompt" text NOT NULL,
        "done_when" text NULL,
        "depends_on" text NOT NULL DEFAULT '[]',
        "state" text NOT NULL,
        "confirmed" boolean NOT NULL DEFAULT TRUE,
        "dispatch_id" integer NULL,
        "message_id" integer NULL,
        "attempt" integer NOT NULL DEFAULT 0,
        "failures" integer NOT NULL DEFAULT 0,
        "result" text NULL,
        "error" text NULL,
        "started_at" timestamp_with_timezone_text NULL,
        "ended_at" timestamp_with_timezone_text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS "personal_agent_check" (
        "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
        "bot_id" integer NOT NULL,
        "conversation_id" integer NOT NULL,
        "message_fp" text NOT NULL,
        "quote_fp" text NOT NULL DEFAULT '',
        "message" text NOT NULL,
        "quote" text NULL,
        "asked" text NULL,
        "state" text NOT NULL,
        "verdict" text NULL,
        "evidence" text NULL,
        "note" text NULL,
        "dispatch_id" integer NULL,
        "notice_id" integer NULL,
        "told_at" timestamp_with_timezone_text NULL,
        "created_at" timestamp_with_timezone_text NOT NULL,
        "updated_at" timestamp_with_timezone_text NOT NULL
    )"#,
    r#"CREATE VIRTUAL TABLE IF NOT EXISTS personal_agent_history_fts USING fts5(body, content='personal_agent_history_doc', content_rowid='id', tokenize='trigram')"#,
];

const INDEXES: &[&str] = &[
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_batch_status" ON "personal_agent_batch" ("status")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_timeline_kind_status" ON "personal_agent_timeline" ("kind", "status")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_event_state" ON "personal_agent_event" ("state")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_item_status" ON "personal_agent_item" ("status")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_dispatch_state" ON "personal_agent_dispatch" ("state")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_dispatch_work_task" ON "personal_agent_dispatch" ("work_task_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_dispatch_conversation" ON "personal_agent_dispatch" ("conversation_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_timeline_batch" ON "personal_agent_timeline" ("batch_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_timeline_event" ON "personal_agent_timeline" ("event_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_timeline_updated" ON "personal_agent_timeline" ("updated_at")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_action_key" ON "personal_agent_action" ("batch_id", "key")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_notice_state" ON "personal_agent_notice" ("state")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_notice_subject" ON "personal_agent_notice" ("subject_key")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_action_op" ON "personal_agent_action" ("op_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_action_state" ON "personal_agent_action" ("state")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_uid" ON "personal_agent" ("uid")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_legacy_assistant_id" ON "personal_agent" ("legacy_assistant_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_legacy_assistant_uid" ON "personal_agent" ("legacy_assistant_uid")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_agent_one_primary ON personal_agent (kind) WHERE kind = 'primary' AND deleted_at IS NULL"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_segment_bot_ended_at ON personal_agent_segment (bot_id, ended_at)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_timeline_bot_id ON personal_agent_timeline (bot_id, id)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_batch_bot_status ON personal_agent_batch (bot_id, status)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_event_bot_state ON personal_agent_event (bot_id, state)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_item_bot_status ON personal_agent_item (bot_id, status)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_dispatch_bot_state ON personal_agent_dispatch (bot_id, state)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_action_bot ON personal_agent_action (bot_id)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_notice_bot_state ON personal_agent_notice (bot_id, state)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_message_to_state ON personal_agent_message (to_bot_id, state)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_personal_agent_message_thread ON personal_agent_message (thread_id)"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_item_due" ON "personal_agent_item" ("due_at")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_activity_day_slot" ON "personal_agent_activity" ("day", "slot")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_verification_dispatch" ON "personal_agent_verification" ("dispatch_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_verification_check" ON "personal_agent_verification" ("check_dispatch_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_watch_due" ON "personal_agent_watch" ("bot_id", "state", "next_poll_at")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_watch_task" ON "personal_agent_watch" ("work_task_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_watch_folder" ON "personal_agent_watch" ("folder_id", "number")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_watch_name_unique" ON "personal_agent_watch_name" ("folder_id", "kind", "number")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_signal_created" ON "personal_agent_signal" ("created_at")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_routine_due" ON "personal_agent_routine" ("bot_id", "enabled", "next_run_at")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_routine_run_event" ON "personal_agent_routine_run" ("routine_id", "event_key")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_routine_run_dispatch" ON "personal_agent_routine_run" ("dispatch_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_routine_run_batch" ON "personal_agent_routine_run" ("batch_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_rule_state_key" ON "personal_agent_rule_state" ("rule", "object")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_brief_key" ON "personal_agent_brief" ("bot_id", "key")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_brief_batch" ON "personal_agent_brief" ("batch_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_history_doc_ref" ON "personal_agent_history_doc" ("source", "ref_id", "part")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_history_doc_at" ON "personal_agent_history_doc" ("at")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_plan_bot_state" ON "personal_agent_plan" ("bot_id", "state")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_agent_plan_step_plan" ON "personal_agent_plan_step" ("plan_id", "seq")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_plan_step_dispatch" ON "personal_agent_plan_step" ("dispatch_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_plan_step_message" ON "personal_agent_plan_step" ("message_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_check_conversation" ON "personal_agent_check" ("conversation_id", "message_fp")"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_check_dispatch" ON "personal_agent_check" ("dispatch_id")"#,
];

const TRIGGERS: &[&str] = &[
    r#"CREATE TRIGGER IF NOT EXISTS personal_agent_history_doc_ai AFTER INSERT ON personal_agent_history_doc BEGIN INSERT INTO personal_agent_history_fts(rowid, body) VALUES (new.id, new.body); END"#,
    r#"CREATE TRIGGER IF NOT EXISTS personal_agent_history_doc_ad AFTER DELETE ON personal_agent_history_doc BEGIN INSERT INTO personal_agent_history_fts(personal_agent_history_fts, rowid, body) VALUES ('delete', old.id, old.body); END"#,
    r#"CREATE TRIGGER IF NOT EXISTS personal_agent_history_doc_au AFTER UPDATE OF body ON personal_agent_history_doc BEGIN INSERT INTO personal_agent_history_fts(personal_agent_history_fts, rowid, body) VALUES ('delete', old.id, old.body); INSERT INTO personal_agent_history_fts(rowid, body) VALUES (new.id, new.body); END"#,
];

/// Dropped in this order on the way down: triggers before the tables they
/// sit on, the full-text table before the table it indexes.
const DROP: &[&str] = &[
    "DROP TRIGGER IF EXISTS personal_agent_history_doc_au",
    "DROP TRIGGER IF EXISTS personal_agent_history_doc_ad",
    "DROP TRIGGER IF EXISTS personal_agent_history_doc_ai",
    "DROP TABLE IF EXISTS personal_agent_history_fts",
    "DROP TABLE IF EXISTS personal_agent_check",
    "DROP TABLE IF EXISTS personal_agent_plan_step",
    "DROP TABLE IF EXISTS personal_agent_plan",
    "DROP TABLE IF EXISTS personal_agent_profile",
    "DROP TABLE IF EXISTS personal_agent_history_cursor",
    "DROP TABLE IF EXISTS personal_agent_history_doc",
    "DROP TABLE IF EXISTS personal_agent_brief",
    "DROP TABLE IF EXISTS personal_agent_rule_state",
    "DROP TABLE IF EXISTS personal_agent_routine_run",
    "DROP TABLE IF EXISTS personal_agent_routine",
    "DROP TABLE IF EXISTS personal_agent_signal",
    "DROP TABLE IF EXISTS personal_agent_watch_name",
    "DROP TABLE IF EXISTS personal_agent_watch",
    "DROP TABLE IF EXISTS personal_agent_verification",
    "DROP TABLE IF EXISTS personal_agent_activity",
    "DROP TABLE IF EXISTS personal_agent_thread",
    "DROP TABLE IF EXISTS personal_agent_message",
    "DROP TABLE IF EXISTS personal_agent_notice",
    "DROP TABLE IF EXISTS personal_agent_action",
    "DROP TABLE IF EXISTS personal_agent_dispatch",
    "DROP TABLE IF EXISTS personal_agent_item",
    "DROP TABLE IF EXISTS personal_agent_event",
    "DROP TABLE IF EXISTS personal_agent_timeline",
    "DROP TABLE IF EXISTS personal_agent_batch",
    "DROP TABLE IF EXISTS personal_agent_segment",
    "DROP TABLE IF EXISTS personal_agent",
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let txn = manager.get_connection().begin().await?;
        // A write first: the transaction holds the write lock from its start,
        // so nothing it reads below can change under it before it writes.
        txn.execute_unprepared("UPDATE seaql_migrations SET version = version WHERE 0")
            .await?;
        for sql in TABLES.iter().chain(INDEXES).chain(TRIGGERS) {
            txn.execute_unprepared(sql).await?;
        }
        add_column(&txn, "work_task", "personal_agent_dispatch_id", "integer NULL").await?;
        add_column(&txn, "conversation", "bot_uid", "text NULL").await?;
        convert_assistants(&txn).await?;
        txn.commit().await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        conn.execute_unprepared("ALTER TABLE work_task DROP COLUMN personal_agent_dispatch_id")
            .await?;
        conn.execute_unprepared("ALTER TABLE conversation DROP COLUMN bot_uid")
            .await?;
        for sql in DROP {
            conn.execute_unprepared(sql).await?;
        }
        Ok(())
    }
}

/// Add `column` to `table` unless it is there already.
async fn add_column(
    conn: &DatabaseTransaction,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), DbErr> {
    let there = conn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT 1 FROM pragma_table_info(?) WHERE name = ?",
            [table.into(), column.into()],
        ))
        .await?
        .is_some();
    if !there {
        conn.execute_unprepared(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))
            .await?;
    }
    Ok(())
}

/// Each assistant of the collaboration settings not deleted, made a worker:
/// a new uid (the old one may be anything an old sync package carried, so it
/// is kept apart, in `legacy_assistant_uid`), a face picked by that uid, its
/// work on the agent and options it ran on, its standing instructions its
/// work's, its description the first paragraph of its persona once its
/// directory is made (`seed_persona`), hidden when it was turned off, in its
/// old order. No brain until the primary's is copied to it, no directory
/// until one is made for it — this only has the database. One `created_at`
/// for all of them: the sidebar orders assistants with no activity by it,
/// then by `sort_order`, so they keep the order they had. Their old row
/// stays as it is (old links and old children read it), and one converted
/// already is not again.
async fn convert_assistants(conn: &DatabaseTransaction) -> Result<(), DbErr> {
    let rows = conn
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT id, uid, name, description, agent_type, agent_options, label_snapshot, \
             instructions, enabled, sort_order FROM assistant \
             WHERE deleted_at IS NULL ORDER BY sort_order, id"
                .to_owned(),
        ))
        .await?;
    let now = chrono::Utc::now();
    for row in rows {
        let id: i32 = row.try_get("", "id")?;
        let legacy_uid: String = row.try_get("", "uid")?;
        let name: String = row.try_get("", "name")?;
        let description: String = row.try_get("", "description")?;
        let agent_type: String = row.try_get("", "agent_type")?;
        let agent_options: String = row.try_get("", "agent_options")?;
        let label_snapshot: String = row.try_get("", "label_snapshot")?;
        let instructions: String = row.try_get("", "instructions")?;
        let enabled: bool = row.try_get("", "enabled")?;
        let sort_order: i32 = row.try_get("", "sort_order")?;
        let uid = uuid::Uuid::new_v4().simple().to_string();
        let avatar = serde_json::to_string(&BotAvatar::default_for(&uid))
            .map_err(|e| DbErr::Custom(e.to_string()))?;
        let persona = Some(description.trim())
            .filter(|d| !d.is_empty())
            .map(str::to_string);
        let instructions = Some(instructions).filter(|i| !i.trim().is_empty());
        conn.execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            r#"INSERT INTO personal_agent (
                name, avatar, agent_type, agent_options, label_snapshot, settings,
                workdir, folder_id, revision, created_at, updated_at, kind, uid,
                sort_order, hidden, muted, unread_mark, notify,
                work_agent_type, work_agent_options, work_label_snapshot,
                work_instructions, seed_persona, seed_version, workdir_ready,
                legacy_assistant_id, legacy_assistant_uid
            ) VALUES (
                ?, ?, NULL, NULL, NULL, '{}',
                NULL, NULL, 1, ?, ?, 'worker', ?,
                ?, ?, FALSE, FALSE, TRUE,
                ?, ?, ?,
                ?, ?, 1, FALSE,
                ?, ?
            ) ON CONFLICT DO NOTHING"#,
            [
                name.into(),
                avatar.into(),
                now.into(),
                now.into(),
                uid.into(),
                sort_order.into(),
                (!enabled).into(),
                agent_type.into(),
                agent_options.into(),
                label_snapshot.into(),
                instructions.into(),
                persona.into(),
                id.into(),
                legacy_uid.into(),
            ],
        ))
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use sea_orm_migration::MigratorTrait;

    use crate::db::migration::Migrator;

    async fn names(conn: &sea_orm::DatabaseConnection, sql: &str) -> Vec<String> {
        conn.query_all(Statement::from_string(DbBackend::Sqlite, sql.to_owned()))
            .await
            .expect("query")
            .iter()
            .map(|r| r.try_get_by_index::<String>(0).expect("name"))
            .collect()
    }

    /// A fresh database finds what the history holds: the triggers that feed
    /// the full-text index were made, and they follow an edit and a delete.
    /// Without them the migration still runs and every search finds nothing.
    #[tokio::test]
    async fn a_fresh_database_searches_the_history() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        Migrator::up(&conn, None).await.expect("migrate");
        let insert = "INSERT INTO personal_agent_history_doc \
            (source, ref_id, part, role, body, weight, at) \
            VALUES ('timeline', 1, 'body', 'owner', 'the quarterly invoice run', 1, '2026-11-20T00:00:00Z')";
        conn.execute_unprepared(insert).await.expect("insert");
        let search = |q: &str| {
            format!(
                "SELECT CAST(rowid AS TEXT) FROM personal_agent_history_fts \
                 WHERE personal_agent_history_fts MATCH '{q}'"
            )
        };
        assert_eq!(
            names(&conn, &search("invoice")).await,
            vec!["1".to_string()]
        );
        conn.execute_unprepared(
            "UPDATE personal_agent_history_doc SET body = 'the yearly audit' WHERE id = 1",
        )
        .await
        .expect("update");
        assert!(names(&conn, &search("invoice")).await.is_empty());
        assert_eq!(names(&conn, &search("audit")).await, vec!["1".to_string()]);
        conn.execute_unprepared("DELETE FROM personal_agent_history_doc WHERE id = 1")
            .await
            .expect("delete");
        assert!(names(&conn, &search("audit")).await.is_empty());
    }

    /// Down takes back all of it: no `personal_agent*` object stays, and
    /// `work_task` loses the one column this added.
    #[tokio::test]
    async fn down_removes_everything_it_made() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        Migrator::up(&conn, None).await.expect("migrate");
        Migrator::down(&conn, Some(1)).await.expect("down");
        let left = names(
            &conn,
            "SELECT name FROM sqlite_master WHERE name LIKE '%personal_agent%' \
             OR tbl_name LIKE '%personal_agent%'",
        )
        .await;
        assert!(left.is_empty(), "left behind: {left:?}");
        let columns = names(&conn, "SELECT name FROM pragma_table_info('work_task')").await;
        assert!(!columns.iter().any(|c| c == "personal_agent_dispatch_id"));
        let columns = names(&conn, "SELECT name FROM pragma_table_info('conversation')").await;
        assert!(!columns.iter().any(|c| c == "bot_uid"));
        Migrator::up(&conn, None).await.expect("up again");
    }

    /// The database as the release before this left it: every migration up
    /// to this one, and the assistants of the collaboration settings — one
    /// described and instructed, one turned off, one deleted.
    async fn released_with_assistants() -> sea_orm::DatabaseConnection {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let idx = <Migrator as MigratorTrait>::migrations()
            .iter()
            .position(|m| m.name().contains("m20261125_000001_personal_agent"))
            .expect("migration is registered");
        Migrator::up(&conn, Some(idx as u32))
            .await
            .expect("released migrations");
        let at = "'2026-10-20 00:00:00'";
        for (id, uid, name, description, instructions, enabled, sort, deleted) in [
            (1, "u-1", "Reviewer", "Reads diffs closely", "Be strict.", 1, 2, "NULL"),
            (2, "u-2", "Scratch", "", "", 0, 1, "NULL"),
            (3, "u-3", "Gone", "", "", 1, 0, at),
        ] {
            conn.execute_unprepared(&format!(
                "INSERT INTO assistant (id, uid, name, description, avatar, agent_type, \
                 agent_options, label_snapshot, instructions, enabled, sort_order, revision, \
                 created_at, updated_at, deleted_at) VALUES ({id}, '{uid}', '{name}', \
                 '{description}', '{{\"kind\":\"monogram\",\"color\":\"red\"}}', 'codex', \
                 '{{\"mode_id\":null,\"config_values\":{{\"model\":\"gpt\"}}}}', \
                 '{{\"agent\":\"Codex\",\"mode\":null,\"options\":[]}}', '{instructions}', \
                 {enabled}, {sort}, 1, {at}, {at}, {deleted})"
            ))
            .await
            .expect("released assistant");
        }
        conn
    }

    /// Upgrading makes each assistant not deleted a worker of its own, its
    /// work on what it ran on, hidden when it was turned off, its old order
    /// kept; and a run again — its registration lost — makes none twice.
    #[tokio::test]
    async fn upgrading_makes_the_assistants_workers() {
        use sea_orm::EntityTrait;

        use crate::db::entities::personal_agent as agent;

        let conn = released_with_assistants().await;
        Migrator::up(&conn, None).await.expect("upgrade");
        let mut bots = agent::Entity::find().all(&conn).await.expect("bots");
        bots.sort_by_key(|b| b.sort_order);
        assert_eq!(bots.len(), 2, "the deleted one is not converted");
        let (scratch, reviewer) = (&bots[0], &bots[1]);
        assert_eq!(reviewer.name, "Reviewer");
        assert_eq!(reviewer.kind, agent::BotKind::Worker);
        assert_eq!(reviewer.agent_type, None, "no brain until the primary's");
        assert_eq!(reviewer.work_agent_type, "codex");
        assert!(reviewer.work_agent_options.contains("gpt"));
        assert_eq!(reviewer.work_instructions.as_deref(), Some("Be strict."));
        assert_eq!(reviewer.seed_persona.as_deref(), Some("Reads diffs closely"));
        assert!(!reviewer.workdir_ready);
        assert!(!reviewer.hidden);
        assert_eq!(reviewer.legacy_assistant_id, Some(1));
        assert_eq!(reviewer.legacy_assistant_uid.as_deref(), Some("u-1"));
        assert_ne!(reviewer.uid.as_deref(), Some("u-1"));
        assert!(reviewer.avatar.contains("\"face\""), "{}", reviewer.avatar);
        assert!(scratch.hidden, "turned off: hidden");
        assert_eq!(scratch.work_instructions, None);
        assert_eq!(scratch.seed_persona, None);
        assert_eq!(scratch.created_at, reviewer.created_at, "one time for all");

        conn.execute_unprepared(
            "DELETE FROM seaql_migrations WHERE version LIKE '%m20261125_000001_personal_agent%'",
        )
        .await
        .expect("lose the registration");
        Migrator::up(&conn, None).await.expect("run again");
        assert_eq!(agent::Entity::find().all(&conn).await.expect("bots").len(), 2);
        let left = names(&conn, "SELECT name FROM assistant ORDER BY id").await;
        assert_eq!(left, vec!["Reviewer", "Scratch", "Gone"], "the old rows stay");
    }
}
