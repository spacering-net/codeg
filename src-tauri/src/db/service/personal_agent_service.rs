//! Storage of the personal agent's assistants: their rows, and each one's
//! session segments, the batches its engine sent, its timeline, its event
//! queue, its open matters and its dispatches.
//!
//! Every table of an assistant's records carries `bot_id`: every write sets
//! it, and every read that is not by a row's own id filters on it — one
//! assistant never sees another's rows. A read by id from outside (a page, a
//! tool call naming a row) goes through the `_of` variant, which checks the
//! row is the asking assistant's.
//!
//! Every write here is a single statement or an insert-first transaction, for
//! the reason `assistant_service` gives: under WAL a read-then-write
//! transaction can fail with `SQLITE_BUSY_SNAPSHOT` once another connection has
//! written past its snapshot. The engine that calls these is the only writer of
//! most of the tables (it runs in exactly one process), so the conditional
//! updates below guard against its own races, not against another process.

use chrono::{DateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};

use crate::db::entities::personal_agent_action::{self as action, ActionState};
use crate::db::entities::personal_agent_batch::{self as batch, BatchKind, BatchStatus, BatchTrigger};
use crate::db::entities::personal_agent_dispatch::{self as dispatch, DispatchMode, DispatchState};
use crate::db::entities::personal_agent_event::{self as event, EventState};
use crate::db::entities::personal_agent_item::{self as item, ItemKind, ItemStatus, WaitsFor};
use crate::db::entities::personal_agent_notice::{
    self as notice, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_segment::{self as segment, SegmentReason};
use crate::db::entities::personal_agent_timeline::{self as timeline, OwnerStatus, TimelineKind};
use crate::db::entities::personal_agent::{self as agent, BotKind};
use crate::db::error::DbError;
use crate::models::personal_agent::{TimelineCursor, TimelineRow};

/// Rows a range read (`since_id`) returns at most.
pub const RANGE_ROWS_MAX: u64 = 500;
/// Rows a read of changed rows returns at most.
pub const CHANGED_ROWS_MAX: u64 = 500;
/// Rows a page may be pulled back by so it does not split a turn.
const BATCH_PULL_MAX: u64 = 500;

// ── the agent row ───────────────────────────────────────────────────────────

/// The primary assistant — the personal agent there was first — when it is
/// set up.
pub async fn primary_bot(conn: &DatabaseConnection) -> Result<Option<agent::Model>, DbError> {
    Ok(agent::Entity::find()
        .filter(agent::Column::Kind.eq(BotKind::Primary))
        .filter(agent::Column::DeletedAt.is_null())
        .order_by_asc(agent::Column::Id)
        .one(conn)
        .await?)
}

/// An assistant that is not deleted.
pub async fn get_bot(conn: &DatabaseConnection, id: i32) -> Result<Option<agent::Model>, DbError> {
    Ok(agent::Entity::find_by_id(id)
        .filter(agent::Column::DeletedAt.is_null())
        .one(conn)
        .await?)
}

/// An assistant by id, deleted or not (a message names its sender even
/// after it is gone).
pub async fn get_bot_any(conn: &DatabaseConnection, id: i32) -> Result<Option<agent::Model>, DbError> {
    Ok(agent::Entity::find_by_id(id).one(conn).await?)
}

/// Every assistant not deleted: the primary first, then the roster's order.
pub async fn list_bots(conn: &DatabaseConnection) -> Result<Vec<agent::Model>, DbError> {
    let mut bots = agent::Entity::find()
        .filter(agent::Column::DeletedAt.is_null())
        .order_by_asc(agent::Column::SortOrder)
        .order_by_asc(agent::Column::Id)
        .all(conn)
        .await?;
    bots.sort_by_key(|b| b.kind != BotKind::Primary);
    Ok(bots)
}

/// A worker to make: its identity and brain, the profile it is bound to.
#[derive(Debug, Clone)]
pub struct NewWorker {
    /// Its uid when the caller has one ready (the page previewed its face
    /// with it); a fresh one otherwise.
    pub uid: Option<String>,
    pub notify: bool,
    pub name: String,
    pub avatar_json: String,
    pub agent_type: String,
    pub agent_options_json: String,
    pub label_snapshot_json: String,
    pub settings_json: String,
    pub template: Option<String>,
    pub executor_assistant_id: Option<i32>,
}

/// Make a worker, with a fresh uid, last in the roster.
pub async fn create_worker(
    conn: &DatabaseConnection,
    new: NewWorker,
) -> Result<agent::Model, DbError> {
    let now = Utc::now();
    let last = agent::Entity::find()
        .filter(agent::Column::DeletedAt.is_null())
        .order_by_desc(agent::Column::SortOrder)
        .one(conn)
        .await?
        .map(|b| b.sort_order)
        .unwrap_or(0);
    let row = agent::ActiveModel {
        id: NotSet,
        name: Set(new.name),
        avatar: Set(new.avatar_json),
        agent_type: Set(new.agent_type),
        agent_options: Set(new.agent_options_json),
        label_snapshot: Set(new.label_snapshot_json),
        settings: Set(new.settings_json),
        workdir: Set(None),
        folder_id: Set(None),
        revision: Set(1),
        created_at: Set(now),
        updated_at: Set(now),
        kind: Set(BotKind::Worker),
        uid: Set(Some(new.uid.unwrap_or_else(new_bot_uid))),
        template: Set(new.template),
        executor_assistant_id: Set(new.executor_assistant_id),
        sort_order: Set(last + 1),
        pinned_at: Set(None),
        section: Set(None),
        hidden: Set(false),
        muted: Set(false),
        unread_mark: Set(false),
        notify: Set(new.notify),
        deleted_at: Set(None),
    };
    Ok(row.insert(conn).await?)
}

/// Whether any assistant, deleted or not, has `uid`.
pub async fn uid_taken(conn: &DatabaseConnection, uid: &str) -> Result<bool, DbError> {
    Ok(agent::Entity::find()
        .filter(agent::Column::Uid.eq(uid))
        .count(conn)
        .await?
        > 0)
}

/// Set the template a worker is made from.
pub async fn set_bot_template(
    conn: &DatabaseConnection,
    id: i32,
    template: &str,
) -> Result<(), DbError> {
    agent::Entity::update_many()
        .col_expr(agent::Column::Template, Expr::value(template))
        .col_expr(agent::Column::UpdatedAt, Expr::value(Utc::now()))
        .col_expr(
            agent::Column::Revision,
            Expr::col(agent::Column::Revision).add(1),
        )
        .filter(agent::Column::Id.eq(id))
        .filter(agent::Column::DeletedAt.is_null())
        .exec(conn)
        .await?;
    Ok(())
}

/// Hand dispatches, and the matters that follow them, to assistant `bot`
/// (a deleted worker's work, to the primary).
pub async fn move_dispatches_to(
    conn: &DatabaseConnection,
    ids: &[i32],
    bot: i32,
) -> Result<(), DbError> {
    if ids.is_empty() {
        return Ok(());
    }
    use sea_orm::TransactionTrait;
    require_bot(bot)?;
    let now = Utc::now();
    let txn = conn.begin().await?;
    dispatch::Entity::update_many()
        .col_expr(dispatch::Column::BotId, Expr::value(bot))
        .col_expr(dispatch::Column::UpdatedAt, Expr::value(now))
        .filter(dispatch::Column::Id.is_in(ids.to_vec()))
        .exec(&txn)
        .await?;
    item::Entity::update_many()
        .col_expr(item::Column::BotId, Expr::value(bot))
        .col_expr(item::Column::UpdatedAt, Expr::value(now))
        .filter(item::Column::DispatchId.is_in(ids.to_vec()))
        .exec(&txn)
        .await?;
    txn.commit().await?;
    Ok(())
}

/// A stable id naming an assistant's directory: 32 hex digits.
pub fn new_bot_uid() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Soft-delete a worker. The primary is never deleted. False when there was
/// no such worker left.
pub async fn delete_worker(conn: &DatabaseConnection, id: i32) -> Result<bool, DbError> {
    let now = Utc::now();
    let res = agent::Entity::update_many()
        .col_expr(agent::Column::DeletedAt, Expr::value(now))
        .col_expr(agent::Column::UpdatedAt, Expr::value(now))
        .col_expr(
            agent::Column::Revision,
            Expr::col(agent::Column::Revision).add(1),
        )
        .filter(agent::Column::Id.eq(id))
        .filter(agent::Column::Kind.eq(BotKind::Worker))
        .filter(agent::Column::DeletedAt.is_null())
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// The columns a save writes. `None` leaves a column as it is (an update) —
/// an insert needs every brain column.
#[derive(Debug, Default, Clone)]
pub struct AgentWrite {
    pub name: Option<String>,
    pub avatar_json: Option<String>,
    pub agent_type: Option<String>,
    pub agent_options_json: Option<String>,
    pub label_snapshot_json: Option<String>,
    pub settings_json: Option<String>,
    /// A JSON merge patch (RFC 7396) applied to the stored settings in the
    /// same statement, so keys it leaves out — another window's, another
    /// part of codeg's — stay as they are. Wins over `settings_json` on an
    /// update; an insert takes `settings_json`.
    pub settings_patch: Option<serde_json::Value>,
    /// A work assistant's executor config.
    pub executor_assistant_id: Option<i32>,
}

/// The SQL that applies a merge patch to the stored settings: whatever is
/// stored that is not an object reads as an empty one.
const SETTINGS_PATCH_SQL: &str =
    "json_patch(CASE WHEN json_valid(settings) AND json_type(settings) = 'object' THEN settings ELSE '{}' END, ?)";

/// Apply a JSON merge patch to an assistant's settings, in one statement:
/// two windows changing different items both keep theirs. A `null` in the
/// patch removes the key. Returns the row as stored, `None` when it is gone.
pub async fn patch_settings(
    conn: &impl ConnectionTrait,
    id: i32,
    patch: &serde_json::Value,
) -> Result<Option<agent::Model>, DbError> {
    let res = agent::Entity::update_many()
        .col_expr(
            agent::Column::Settings,
            Expr::cust_with_values(SETTINGS_PATCH_SQL, [patch.to_string()]),
        )
        .col_expr(agent::Column::UpdatedAt, Expr::value(Utc::now()))
        .col_expr(
            agent::Column::Revision,
            Expr::col(agent::Column::Revision).add(1),
        )
        .filter(agent::Column::Id.eq(id))
        .filter(agent::Column::DeletedAt.is_null())
        .exec(conn)
        .await?;
    if res.rows_affected == 0 {
        return Ok(None);
    }
    Ok(agent::Entity::find_by_id(id).one(conn).await?)
}

/// Insert the primary assistant's row, or update the one that exists.
/// Returns the row as stored. (A second primary is refused by the database:
/// one undeleted primary only.)
pub async fn save_primary(
    conn: &DatabaseConnection,
    write: AgentWrite,
) -> Result<agent::Model, DbError> {
    match primary_bot(conn).await? {
        Some(existing) => save_bot(conn, existing.id, write).await,
        None => insert_primary(conn, write).await,
    }
}

async fn insert_primary(
    conn: &DatabaseConnection,
    write: AgentWrite,
) -> Result<agent::Model, DbError> {
    let now = Utc::now();
    let (Some(agent_type), Some(options), Some(labels)) = (
        write.agent_type,
        write.agent_options_json,
        write.label_snapshot_json,
    ) else {
        return Err(DbError::Validation(
            "the personal agent needs an agent to run on".into(),
        ));
    };
    let row = agent::ActiveModel {
        id: NotSet,
        name: Set(write.name.unwrap_or_default()),
        avatar: Set(write
            .avatar_json
            .unwrap_or_else(|| r#"{"kind":"emoji","emoji":"🧭","color":"violet"}"#.into())),
        agent_type: Set(agent_type),
        agent_options: Set(options),
        label_snapshot: Set(labels),
        settings: Set(write.settings_json.unwrap_or_else(|| "{}".into())),
        workdir: Set(None),
        folder_id: Set(None),
        revision: Set(1),
        created_at: Set(now),
        updated_at: Set(now),
        kind: Set(BotKind::Primary),
        uid: Set(Some(new_bot_uid())),
        template: Set(None),
        executor_assistant_id: Set(None),
        sort_order: Set(0),
        pinned_at: Set(None),
        section: Set(None),
        hidden: Set(false),
        muted: Set(false),
        unread_mark: Set(false),
        notify: Set(true),
        deleted_at: Set(None),
    };
    Ok(row.insert(conn).await?)
}

/// Update an assistant's row. Returns it as stored.
pub async fn save_bot(
    conn: &DatabaseConnection,
    id: i32,
    write: AgentWrite,
) -> Result<agent::Model, DbError> {
    let now = Utc::now();
    let mut update = agent::Entity::update_many()
        .col_expr(agent::Column::UpdatedAt, Expr::value(now))
        .col_expr(
            agent::Column::Revision,
            Expr::col(agent::Column::Revision).add(1),
        )
        .filter(agent::Column::Id.eq(id))
        .filter(agent::Column::DeletedAt.is_null());
    if let Some(v) = write.name {
        update = update.col_expr(agent::Column::Name, Expr::value(v));
    }
    if let Some(v) = write.avatar_json {
        update = update.col_expr(agent::Column::Avatar, Expr::value(v));
    }
    if let Some(v) = write.agent_type {
        update = update.col_expr(agent::Column::AgentType, Expr::value(v));
    }
    if let Some(v) = write.agent_options_json {
        update = update.col_expr(agent::Column::AgentOptions, Expr::value(v));
    }
    if let Some(v) = write.label_snapshot_json {
        update = update.col_expr(agent::Column::LabelSnapshot, Expr::value(v));
    }
    if let Some(v) = write.executor_assistant_id {
        update = update.col_expr(agent::Column::ExecutorAssistantId, Expr::value(Some(v)));
    }
    if let Some(patch) = write.settings_patch {
        update = update.col_expr(
            agent::Column::Settings,
            Expr::cust_with_values(SETTINGS_PATCH_SQL, [patch.to_string()]),
        );
    } else if let Some(v) = write.settings_json {
        update = update.col_expr(agent::Column::Settings, Expr::value(v));
    }
    update.exec(conn).await?;
    get_bot(conn, id)
        .await?
        .ok_or_else(|| DbError::NotFound("personal agent".into()))
}

/// Point the agent at a working directory and the hidden folder backing it.
/// `workdir: None` is the data dir's default.
pub async fn set_workdir(
    conn: &DatabaseConnection,
    id: i32,
    workdir: Option<String>,
    folder_id: Option<i32>,
) -> Result<(), DbError> {
    agent::Entity::update_many()
        .col_expr(agent::Column::Workdir, Expr::value(workdir))
        .col_expr(agent::Column::FolderId, Expr::value(folder_id))
        .col_expr(agent::Column::UpdatedAt, Expr::value(Utc::now()))
        .col_expr(
            agent::Column::Revision,
            Expr::col(agent::Column::Revision).add(1),
        )
        .filter(agent::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

// ── segments ────────────────────────────────────────────────────────────────

/// The segment that is open, if the agent has started.
pub async fn open_segment(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Option<segment::Model>, DbError> {
    Ok(segment::Entity::find()
        .filter(segment::Column::BotId.eq(bot))
        .filter(segment::Column::EndedAt.is_null())
        .order_by_desc(segment::Column::Id)
        .one(conn)
        .await?)
}

pub async fn get_segment(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<segment::Model>, DbError> {
    Ok(segment::Entity::find_by_id(id).one(conn).await?)
}

pub async fn list_segments(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<segment::Model>, DbError> {
    Ok(segment::Entity::find()
        .filter(segment::Column::BotId.eq(bot))
        .order_by_asc(segment::Column::Id)
        .all(conn)
        .await?)
}

/// Start a new segment. The caller has ended the previous one.
pub async fn create_segment(
    conn: &DatabaseConnection,
    bot: i32,
    agent_type: &str,
    agent_options_json: String,
    reason: SegmentReason,
) -> Result<segment::Model, DbError> {
    require_bot(bot)?;
    let seq = segment::Entity::find()
        .filter(segment::Column::BotId.eq(bot))
        .order_by_desc(segment::Column::Seq)
        .one(conn)
        .await?
        .map(|s| s.seq)
        .unwrap_or(0)
        + 1;
    let row = segment::ActiveModel {
        id: NotSet,
        seq: Set(seq),
        agent_type: Set(agent_type.to_string()),
        agent_options: Set(agent_options_json),
        conversation_id: Set(None),
        agent_session_id: Set(None),
        start_reason: Set(reason),
        end_reason: Set(None),
        pending_reason: Set(None),
        started_at: Set(Utc::now()),
        ended_at: Set(None),
        usage_at_end: Set(None),
        handoff_size: Set(None),
        compactions_auto: Set(0),
        compactions_manual: Set(0),
        compactions_agent: Set(0),
        auto_compact_paused: Set(false),
        persona_digest: Set(None),
        state: Set("{}".to_string()),
        bot_id: Set(Some(bot)),
    };
    Ok(row.insert(conn).await?)
}

/// Close a segment. A no-op on one already closed.
pub async fn end_segment(
    conn: &DatabaseConnection,
    id: i32,
    reason: SegmentReason,
    usage_json: Option<String>,
) -> Result<bool, DbError> {
    let res = segment::Entity::update_many()
        .col_expr(segment::Column::EndedAt, Expr::value(Utc::now()))
        .col_expr(segment::Column::EndReason, Expr::value(reason))
        .col_expr(segment::Column::UsageAtEnd, Expr::value(usage_json))
        .col_expr(segment::Column::PendingReason, Expr::value(Option::<SegmentReason>::None))
        .filter(segment::Column::Id.eq(id))
        .filter(segment::Column::EndedAt.is_null())
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// Mark the open segment to be replaced at the next delivery. The most
/// recent reason wins: it is the one the new segment's card explains.
pub async fn set_pending_reason(
    conn: &DatabaseConnection,
    id: i32,
    reason: Option<SegmentReason>,
) -> Result<(), DbError> {
    segment::Entity::update_many()
        .col_expr(segment::Column::PendingReason, Expr::value(reason))
        .filter(segment::Column::Id.eq(id))
        .filter(segment::Column::EndedAt.is_null())
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn set_segment_session(
    conn: &DatabaseConnection,
    id: i32,
    conversation_id: Option<i32>,
    agent_session_id: Option<String>,
) -> Result<(), DbError> {
    let mut update = segment::Entity::update_many().filter(segment::Column::Id.eq(id));
    if let Some(cid) = conversation_id {
        update = update.col_expr(segment::Column::ConversationId, Expr::value(cid));
    }
    if let Some(sid) = agent_session_id {
        update = update.col_expr(segment::Column::AgentSessionId, Expr::value(sid));
    }
    update.exec(conn).await?;
    Ok(())
}

pub async fn set_segment_options(
    conn: &DatabaseConnection,
    id: i32,
    agent_options_json: String,
) -> Result<(), DbError> {
    segment::Entity::update_many()
        .col_expr(segment::Column::AgentOptions, Expr::value(agent_options_json))
        .filter(segment::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn set_segment_state(
    conn: &DatabaseConnection,
    id: i32,
    state_json: String,
) -> Result<(), DbError> {
    segment::Entity::update_many()
        .col_expr(segment::Column::State, Expr::value(state_json))
        .filter(segment::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn set_segment_paused(
    conn: &DatabaseConnection,
    id: i32,
    paused: bool,
) -> Result<(), DbError> {
    segment::Entity::update_many()
        .col_expr(segment::Column::AutoCompactPaused, Expr::value(paused))
        .filter(segment::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn set_segment_persona_digest(
    conn: &DatabaseConnection,
    id: i32,
    digest: Option<String>,
) -> Result<(), DbError> {
    segment::Entity::update_many()
        .col_expr(segment::Column::PersonaDigest, Expr::value(digest))
        .filter(segment::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn set_segment_handoff_size(
    conn: &DatabaseConnection,
    id: i32,
    size: i32,
) -> Result<(), DbError> {
    segment::Entity::update_many()
        .col_expr(segment::Column::HandoffSize, Expr::value(size))
        .filter(segment::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

/// Count one compaction on a segment, by who started it.
pub async fn bump_compactions(
    conn: &DatabaseConnection,
    id: i32,
    initiator: crate::models::personal_agent::CompactInitiator,
) -> Result<(), DbError> {
    use crate::models::personal_agent::CompactInitiator;
    let col = match initiator {
        CompactInitiator::Auto => segment::Column::CompactionsAuto,
        CompactInitiator::Owner => segment::Column::CompactionsManual,
        CompactInitiator::Agent => segment::Column::CompactionsAgent,
    };
    segment::Entity::update_many()
        .col_expr(col, Expr::col(col).add(1))
        .filter(segment::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

// ── batches ─────────────────────────────────────────────────────────────────

pub async fn create_batch(
    conn: &DatabaseConnection,
    bot: i32,
    segment_id: i32,
    kind: BatchKind,
    detail: Option<serde_json::Value>,
) -> Result<batch::Model, DbError> {
    create_batch_with(conn, bot, segment_id, kind, detail, None).await
}

/// A batch with its trigger (recorded only).
pub async fn create_batch_with(
    conn: &DatabaseConnection,
    bot: i32,
    segment_id: i32,
    kind: BatchKind,
    detail: Option<serde_json::Value>,
    trigger: Option<BatchTrigger>,
) -> Result<batch::Model, DbError> {
    require_bot(bot)?;
    let row = batch::ActiveModel {
        id: NotSet,
        segment_id: Set(segment_id),
        kind: Set(kind),
        status: Set(BatchStatus::Running),
        stop_reason: Set(None),
        detail: Set(detail.map(|d| d.to_string())),
        error: Set(None),
        started_at: Set(Utc::now()),
        ended_at: Set(None),
        trigger: Set(trigger),
        bot_id: Set(Some(bot)),
    };
    Ok(row.insert(conn).await?)
}

pub async fn get_batch(conn: &DatabaseConnection, id: i32) -> Result<Option<batch::Model>, DbError> {
    Ok(batch::Entity::find_by_id(id).one(conn).await?)
}

/// Settle a running batch. Returns false when it was already settled.
pub async fn finish_batch(
    conn: &DatabaseConnection,
    id: i32,
    status: BatchStatus,
    stop_reason: Option<String>,
    error: Option<String>,
    detail: Option<serde_json::Value>,
) -> Result<bool, DbError> {
    let mut update = batch::Entity::update_many()
        .col_expr(batch::Column::Status, Expr::value(status))
        .col_expr(batch::Column::StopReason, Expr::value(stop_reason))
        .col_expr(batch::Column::Error, Expr::value(error))
        .col_expr(batch::Column::EndedAt, Expr::value(Utc::now()))
        .filter(batch::Column::Id.eq(id))
        .filter(batch::Column::Status.eq(BatchStatus::Running));
    if let Some(d) = detail {
        update = update.col_expr(batch::Column::Detail, Expr::value(d.to_string()));
    }
    Ok(update.exec(conn).await?.rows_affected == 1)
}

/// Add `why` to a batch's detail (`"why"`), keeping the rest of it.
pub async fn set_batch_why(conn: &DatabaseConnection, id: i32, why: &str) -> Result<(), DbError> {
    let Some(batch) = get_batch(conn, id).await? else {
        return Ok(());
    };
    let mut detail = batch
        .detail
        .as_deref()
        .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(map) = detail.as_object_mut() {
        map.insert("why".into(), why.into());
    } else {
        detail = serde_json::json!({ "why": why });
    }
    batch::Entity::update_many()
        .col_expr(batch::Column::Detail, Expr::value(detail.to_string()))
        .filter(batch::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

/// A batch's `why`, from its detail: how it ended when that was not an
/// ordinary completion (`"preempted"`: it gave way to the owner's message).
pub fn batch_why(batch: &batch::Model) -> Option<String> {
    batch
        .detail
        .as_deref()
        .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
        .and_then(|d| d.get("why").and_then(|v| v.as_str()).map(str::to_string))
}

/// The newest compaction batch of a segment.
pub async fn last_compaction(
    conn: &DatabaseConnection,
    segment_id: i32,
) -> Result<Option<batch::Model>, DbError> {
    Ok(batch::Entity::find()
        .filter(batch::Column::SegmentId.eq(segment_id))
        .filter(batch::Column::Kind.eq(BatchKind::Compaction))
        .order_by_desc(batch::Column::Id)
        .one(conn)
        .await?)
}

pub async fn running_batches(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<batch::Model>, DbError> {
    Ok(batch::Entity::find()
        .filter(batch::Column::BotId.eq(bot))
        .filter(batch::Column::Status.eq(BatchStatus::Running))
        .order_by_asc(batch::Column::Id)
        .all(conn)
        .await?)
}

pub async fn batches_since(
    conn: &DatabaseConnection,
    bot: i32,
    since: DateTime<Utc>,
) -> Result<Vec<batch::Model>, DbError> {
    Ok(batch::Entity::find()
        .filter(batch::Column::BotId.eq(bot))
        .filter(batch::Column::StartedAt.gte(since))
        .order_by_asc(batch::Column::Id)
        .all(conn)
        .await?)
}

// ── timeline ────────────────────────────────────────────────────────────────

pub fn to_row(m: timeline::Model) -> TimelineRow {
    TimelineRow {
        id: m.id,
        segment_id: m.segment_id,
        batch_id: m.batch_id,
        kind: m.kind,
        status: m.status,
        body: m.body,
        data: m.data.as_deref().and_then(|d| serde_json::from_str(d).ok()),
        dispatch_id: m.dispatch_id,
        ref_id: m.ref_id,
        reply_to: m.reply_to,
        read_at: m.read_at,
        event_id: m.event_id,
        seen_at: m.seen_at,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

/// Whether a row is a reply whose prompt never reached the agent: every
/// reader treats it as absent.
pub fn is_discarded(m: &timeline::Model) -> bool {
    m.kind == TimelineKind::Reply && reply_state(m) == Some("discarded")
}

/// A reply row's `data.state`: `running`, `done`, `canceled`,
/// `interrupted`, `discarded` — `None` on a phase-one row, which has none.
pub fn reply_state(m: &timeline::Model) -> Option<&'static str> {
    let data = m.data.as_deref()?;
    let state = serde_json::from_str::<serde_json::Value>(data)
        .ok()?
        .get("state")?
        .as_str()?
        .to_string();
    ["running", "done", "canceled", "interrupted", "discarded"]
        .into_iter()
        .find(|s| *s == state)
}

/// Whether a reply row holds nothing to read yet: running with no body, or
/// discarded.
pub fn is_unwritten_reply(m: &timeline::Model) -> bool {
    m.kind == TimelineKind::Reply
        && match reply_state(m) {
            Some("discarded") => true,
            Some("running") => m.body.trim().is_empty(),
            _ => false,
        }
}

/// A timeline row to write.
#[derive(Debug, Clone)]
pub struct NewRow {
    pub kind: TimelineKind,
    pub segment_id: Option<i32>,
    pub batch_id: Option<i32>,
    pub status: Option<OwnerStatus>,
    pub body: String,
    pub data: Option<serde_json::Value>,
    pub dispatch_id: Option<i32>,
    pub ref_id: Option<String>,
    pub reply_to: Option<i32>,
    pub event_id: Option<i32>,
}

impl NewRow {
    pub fn new(kind: TimelineKind, body: impl Into<String>) -> Self {
        Self {
            kind,
            segment_id: None,
            batch_id: None,
            status: None,
            body: body.into(),
            data: None,
            dispatch_id: None,
            ref_id: None,
            reply_to: None,
            event_id: None,
        }
    }

    pub(crate) fn into_active(self, bot: i32, now: DateTime<Utc>) -> timeline::ActiveModel {
        timeline::ActiveModel {
            id: NotSet,
            segment_id: Set(self.segment_id),
            batch_id: Set(self.batch_id),
            kind: Set(self.kind),
            status: Set(self.status),
            body: Set(self.body),
            data: Set(self.data.map(|d| d.to_string())),
            dispatch_id: Set(self.dispatch_id),
            ref_id: Set(self.ref_id),
            reply_to: Set(self.reply_to),
            read_at: Set(None),
            event_id: Set(self.event_id),
            seen_at: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
            bot_id: Set(Some(bot)),
        }
    }
}

pub async fn insert_row(
    conn: &DatabaseConnection,
    bot: i32,
    row: NewRow,
) -> Result<timeline::Model, DbError> {
    require_bot(bot)?;
    Ok(row.into_active(bot, Utc::now()).insert(conn).await?)
}

pub async fn get_row(conn: &DatabaseConnection, id: i32) -> Result<Option<timeline::Model>, DbError> {
    Ok(timeline::Entity::find_by_id(id).one(conn).await?)
}

/// A row of this assistant's, by id: `None` for one of another's.
pub async fn get_row_of(
    conn: &DatabaseConnection,
    bot: i32,
    id: i32,
) -> Result<Option<timeline::Model>, DbError> {
    Ok(timeline::Entity::find_by_id(id)
        .filter(timeline::Column::BotId.eq(bot))
        .one(conn)
        .await?)
}

/// A write of an assistant's records needs the assistant: a row with no
/// owner would belong to no one's timeline.
fn require_bot(bot: i32) -> Result<(), DbError> {
    if bot > 0 {
        Ok(())
    } else {
        Err(DbError::Validation(
            "the personal agent is not set up yet".into(),
        ))
    }
}

/// Only a reply row still running: a checkpoint landing after the turn was
/// settled must not roll it back, and a turn is settled once.
fn still_running() -> sea_orm::sea_query::SimpleExpr {
    Expr::cust("json_extract(data, '$.state') = 'running'")
}

/// Write the progress of a running reply row (its step in the slot, its last
/// text so far), for a page that cannot hear the engine and for a restart.
/// `false` when the row is no longer running.
pub async fn checkpoint_reply_row(
    conn: &DatabaseConnection,
    id: i32,
    data: serde_json::Value,
) -> Result<bool, DbError> {
    let res = timeline::Entity::update_many()
        .col_expr(timeline::Column::Data, Expr::value(data.to_string()))
        .col_expr(timeline::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(timeline::Column::Id.eq(id))
        .filter(timeline::Column::Kind.eq(TimelineKind::Reply))
        .filter(still_running())
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// Settle a running reply row in place: its body, data and quote, in one
/// write. `None` when it was settled already.
pub async fn settle_reply_row(
    conn: &DatabaseConnection,
    id: i32,
    body: String,
    data: serde_json::Value,
    reply_to: Option<i32>,
) -> Result<Option<timeline::Model>, DbError> {
    let res = timeline::Entity::update_many()
        .col_expr(timeline::Column::Body, Expr::value(body))
        .col_expr(timeline::Column::Data, Expr::value(data.to_string()))
        .col_expr(timeline::Column::ReplyTo, Expr::value(reply_to))
        .col_expr(timeline::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(timeline::Column::Id.eq(id))
        .filter(timeline::Column::Kind.eq(TimelineKind::Reply))
        .filter(still_running())
        .exec(conn)
        .await?;
    if res.rows_affected == 0 {
        return Ok(None);
    }
    get_row(conn, id).await
}

/// The reply row of a batch, when it has one.
pub async fn reply_row_of_batch(
    conn: &DatabaseConnection,
    batch_id: i32,
) -> Result<Option<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Reply))
        .filter(timeline::Column::BatchId.eq(batch_id))
        .order_by_asc(timeline::Column::Id)
        .one(conn)
        .await?)
}

/// The row a batch's turn is drawn at: its reply row, else (a phase-one
/// batch, which wrote a reply only when there was text) its first row that is
/// not an owner message.
pub async fn anchor_row_of_batch(
    conn: &DatabaseConnection,
    batch_id: i32,
) -> Result<Option<timeline::Model>, DbError> {
    if let Some(reply) = reply_row_of_batch(conn, batch_id).await? {
        if !is_discarded(&reply) {
            return Ok(Some(reply));
        }
    }
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BatchId.eq(batch_id))
        .filter(timeline::Column::Kind.ne(TimelineKind::Owner))
        .filter(timeline::Column::Kind.ne(TimelineKind::Reply))
        .order_by_asc(timeline::Column::Id)
        .one(conn)
        .await?)
}

/// The newest follow-up card of a dispatch.
pub async fn latest_followup_row(
    conn: &DatabaseConnection,
    dispatch_id: i32,
) -> Result<Option<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Dispatch))
        .filter(timeline::Column::DispatchId.eq(dispatch_id))
        .filter(Expr::cust("json_extract(data, '$.followup') = 1"))
        .order_by_desc(timeline::Column::Id)
        .one(conn)
        .await?)
}

/// Whether any row is older than `id`.
pub async fn has_rows_before(
    conn: &DatabaseConnection,
    bot: i32,
    id: i32,
) -> Result<bool, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Id.lt(id))
        .one(conn)
        .await?
        .is_some())
}

/// Rows by id (at most 100), id order.
pub async fn rows_by_ids(
    conn: &DatabaseConnection,
    bot: i32,
    ids: &[i32],
) -> Result<Vec<timeline::Model>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i32> = ids.iter().copied().take(100).collect();
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Id.is_in(ids))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

/// The rows from `since_id` up to (not including) `before_id`, oldest first —
/// or, when that is more than [`RANGE_ROWS_MAX`] rows, none and `true`.
pub async fn range(
    conn: &DatabaseConnection,
    bot: i32,
    since_id: i32,
    before_id: Option<i32>,
) -> Result<(Vec<timeline::Model>, bool), DbError> {
    let mut query = timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Id.gte(since_id))
        .order_by_asc(timeline::Column::Id);
    if let Some(before) = before_id {
        query = query.filter(timeline::Column::Id.lt(before));
    }
    let rows = query.limit(RANGE_ROWS_MAX + 1).all(conn).await?;
    if rows.len() as u64 > RANGE_ROWS_MAX {
        return Ok((Vec::new(), true));
    }
    // The turn the first row belongs to starts where it is drawn.
    Ok((pull_back_to_turn_start(conn, bot, rows).await?, false))
}

/// Rows changed since a moment, `(updated_at, id)` order, from `min_id` up:
/// after `after` when continuing a read, else from `since` (inclusive — a
/// row written later in the same instant as the last one read is not
/// missed; the reader drops what it already holds). Returns where to go on
/// from when more changed than [`CHANGED_ROWS_MAX`].
pub async fn changed_since(
    conn: &DatabaseConnection,
    bot: i32,
    since: Option<DateTime<Utc>>,
    after: Option<TimelineCursor>,
    min_id: i32,
) -> Result<(Vec<timeline::Model>, Option<TimelineCursor>), DbError> {
    changed_since_limited(conn, bot, since, after, min_id, CHANGED_ROWS_MAX).await
}

/// [`changed_since`], `limit` rows at a time.
pub async fn changed_since_limited(
    conn: &DatabaseConnection,
    bot: i32,
    since: Option<DateTime<Utc>>,
    after: Option<TimelineCursor>,
    min_id: i32,
    limit: u64,
) -> Result<(Vec<timeline::Model>, Option<TimelineCursor>), DbError> {
    use sea_orm::Condition;
    let mut query = timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Id.gte(min_id));
    if let Some(cursor) = after {
        query = query.filter(
            Condition::any()
                .add(timeline::Column::UpdatedAt.gt(cursor.updated_at))
                .add(
                    Condition::all()
                        .add(timeline::Column::UpdatedAt.eq(cursor.updated_at))
                        .add(timeline::Column::Id.gt(cursor.id)),
                ),
        );
    } else if let Some(since) = since {
        query = query.filter(timeline::Column::UpdatedAt.gte(since));
    }
    let mut rows = query
        .order_by_asc(timeline::Column::UpdatedAt)
        .order_by_asc(timeline::Column::Id)
        .limit(limit + 1)
        .all(conn)
        .await?;
    let next = if rows.len() as u64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|r| TimelineCursor {
            updated_at: r.updated_at,
            id: r.id,
        })
    } else {
        None
    };
    Ok((rows, next))
}

/// Mark the result cards of these events read (`Some`) or unread (`None`).
/// Returns the rows changed.
pub async fn set_result_rows_read(
    conn: &DatabaseConnection,
    bot: i32,
    event_ids: &[i32],
    read_at: Option<DateTime<Utc>>,
) -> Result<Vec<timeline::Model>, DbError> {
    if event_ids.is_empty() {
        return Ok(Vec::new());
    }
    timeline::Entity::update_many()
        .col_expr(timeline::Column::ReadAt, Expr::value(read_at))
        .col_expr(timeline::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Result))
        .filter(timeline::Column::EventId.is_in(event_ids.to_vec()))
        .exec(conn)
        .await?;
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Result))
        .filter(timeline::Column::EventId.is_in(event_ids.to_vec()))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

/// The result cards of these events, by event id.
pub async fn result_rows_of_events(
    conn: &DatabaseConnection,
    event_ids: &[i32],
) -> Result<Vec<timeline::Model>, DbError> {
    if event_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Result))
        .filter(timeline::Column::EventId.is_in(event_ids.to_vec()))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

/// Replace a row's data (and optionally its body).
pub async fn update_row_data(
    conn: &DatabaseConnection,
    id: i32,
    body: Option<String>,
    data: Option<serde_json::Value>,
) -> Result<(), DbError> {
    let mut update = timeline::Entity::update_many()
        .col_expr(timeline::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(timeline::Column::Id.eq(id));
    if let Some(b) = body {
        update = update.col_expr(timeline::Column::Body, Expr::value(b));
    }
    update = update.col_expr(
        timeline::Column::Data,
        Expr::value(data.map(|d| d.to_string())),
    );
    update.exec(conn).await?;
    Ok(())
}

/// The owner's messages waiting for a delivery, oldest first.
pub async fn queued_owner_rows(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Owner))
        .filter(timeline::Column::Status.eq(OwnerStatus::Queued))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

pub async fn count_queued_owner_rows(conn: &DatabaseConnection, bot: i32) -> Result<u64, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Owner))
        .filter(timeline::Column::Status.eq(OwnerStatus::Queued))
        .count(conn)
        .await?)
}

/// What the owner has not seen: a result card, a native card, or a reply
/// that settled (one still running is neither counted nor marked, so a turn
/// the owner left before it ended is new once it does).
fn unseen_by_owner() -> Condition {
    Condition::all()
        .add(timeline::Column::SeenAt.is_null())
        .add(
            Condition::any()
                .add(timeline::Column::Kind.eq(TimelineKind::Result))
                .add(timeline::Column::Kind.eq(TimelineKind::Notice))
                .add(
                    Condition::all()
                        .add(timeline::Column::Kind.eq(TimelineKind::Reply))
                        .add(Expr::cust(
                            "COALESCE(json_extract(data, '$.state'), '') \
                             NOT IN ('running', 'discarded')",
                        )),
                ),
        )
}

pub async fn count_unseen(conn: &DatabaseConnection, bot: i32) -> Result<u64, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(unseen_by_owner())
        .count(conn)
        .await?)
}

/// The owner has seen the timeline up to row `up_to`: what of it was new to
/// them is marked so (and touched, so a page following changed rows hears
/// of it). Returns the rows marked.
pub async fn mark_seen(
    conn: &DatabaseConnection,
    bot: i32,
    up_to: i32,
) -> Result<Vec<timeline::Model>, DbError> {
    let now = Utc::now();
    let res = timeline::Entity::update_many()
        .col_expr(timeline::Column::SeenAt, Expr::value(now))
        .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Id.lte(up_to))
        .filter(unseen_by_owner())
        .exec(conn)
        .await?;
    if res.rows_affected == 0 {
        return Ok(Vec::new());
    }
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Id.lte(up_to))
        .filter(timeline::Column::SeenAt.eq(now))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

/// What a move does to the read mark of the rows it moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadMark {
    Keep,
    /// The assistant starts on them now.
    Read,
    /// Back to unread: they never reached the assistant.
    Unread,
}

/// Move owner rows to `to`, but only those still in `from` — so a row
/// another path already settled keeps its state. Returns the rows moved.
pub async fn move_owner_rows(
    conn: &DatabaseConnection,
    ids: &[i32],
    from: &[OwnerStatus],
    to: OwnerStatus,
    batch_id: Option<i32>,
    segment_id: Option<i32>,
    read: ReadMark,
) -> Result<Vec<timeline::Model>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let now = Utc::now();
    let mut update = timeline::Entity::update_many()
        .col_expr(timeline::Column::Status, Expr::value(to))
        .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
        .filter(timeline::Column::Id.is_in(ids.to_vec()))
        .filter(timeline::Column::Kind.eq(TimelineKind::Owner))
        .filter(timeline::Column::Status.is_in(from.to_vec()));
    if let Some(b) = batch_id {
        update = update.col_expr(timeline::Column::BatchId, Expr::value(b));
    }
    if let Some(s) = segment_id {
        update = update.col_expr(timeline::Column::SegmentId, Expr::value(s));
    }
    match read {
        ReadMark::Keep => {}
        ReadMark::Read => {
            update = update.col_expr(timeline::Column::ReadAt, Expr::value(Some(now)));
        }
        ReadMark::Unread => {
            update = update.col_expr(
                timeline::Column::ReadAt,
                Expr::value(Option::<DateTime<Utc>>::None),
            );
        }
    }
    update.exec(conn).await?;
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Id.is_in(ids.to_vec()))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

/// The owner rows a batch carried.
pub async fn owner_rows_of_batch(
    conn: &DatabaseConnection,
    batch_id: i32,
) -> Result<Vec<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Owner))
        .filter(timeline::Column::BatchId.eq(batch_id))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

/// A page of the timeline, newest last: up to `limit` rows older than
/// `before_id` (or the newest ones) — pulled back further when it would cut a
/// turn in two: the page then starts at the first row of every turn it holds
/// (the reply, or a phase-one turn's first card), so the page draws each turn
/// whole.
pub async fn page(
    conn: &DatabaseConnection,
    bot: i32,
    before_id: Option<i32>,
    limit: u64,
) -> Result<(Vec<timeline::Model>, bool), DbError> {
    let mut query = timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .order_by_desc(timeline::Column::Id);
    if let Some(before) = before_id {
        query = query.filter(timeline::Column::Id.lt(before));
    }
    let mut rows = query.limit(limit + 1).all(conn).await?;
    let has_older = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    rows.reverse();
    if !has_older {
        return Ok((rows, false));
    }
    let rows = pull_back_to_turn_start(conn, bot, rows).await?;
    let has_older = match rows.first() {
        Some(first) => has_rows_before(conn, bot, first.id).await?,
        None => false,
    };
    Ok((rows, has_older))
}

/// `rows` (oldest first) with the rows before them that the turns they show
/// begin with: a turn is drawn at its first row that is not an owner message
/// (its reply, or a phase-one turn's first card), so a read must not start
/// after it.
async fn pull_back_to_turn_start(
    conn: &DatabaseConnection,
    bot: i32,
    rows: Vec<timeline::Model>,
) -> Result<Vec<timeline::Model>, DbError> {
    let Some(first) = rows.first().map(|r| r.id) else {
        return Ok(rows);
    };
    let mut batches: Vec<i32> = rows
        .iter()
        .filter(|r| r.kind != TimelineKind::Owner)
        .filter_map(|r| r.batch_id)
        .collect();
    batches.sort_unstable();
    batches.dedup();
    if batches.is_empty() {
        return Ok(rows);
    }
    let anchor = timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::BatchId.is_in(batches))
        .filter(timeline::Column::Kind.ne(TimelineKind::Owner))
        .filter(timeline::Column::Id.lt(first))
        .order_by_asc(timeline::Column::Id)
        .one(conn)
        .await?;
    let Some(anchor) = anchor else {
        return Ok(rows);
    };
    let mut pulled = timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Id.gte(anchor.id))
        .filter(timeline::Column::Id.lt(first))
        .order_by_desc(timeline::Column::Id)
        .limit(BATCH_PULL_MAX)
        .all(conn)
        .await?;
    pulled.reverse();
    pulled.extend(rows);
    Ok(pulled)
}

/// The newest `limit` rows of the given kinds, oldest first.
pub async fn recent_rows(
    conn: &DatabaseConnection,
    bot: i32,
    kinds: &[TimelineKind],
    limit: u64,
) -> Result<Vec<timeline::Model>, DbError> {
    let mut rows = timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.is_in(kinds.to_vec()))
        .order_by_desc(timeline::Column::Id)
        .limit(limit)
        .all(conn)
        .await?;
    rows.reverse();
    Ok(rows)
}

pub async fn row_by_ref(
    conn: &DatabaseConnection,
    bot: i32,
    kind: TimelineKind,
    ref_id: &str,
) -> Result<Option<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(kind))
        .filter(timeline::Column::RefId.eq(ref_id))
        .order_by_desc(timeline::Column::Id)
        .one(conn)
        .await?)
}

pub async fn rows_since(
    conn: &DatabaseConnection,
    bot: i32,
    since: DateTime<Utc>,
) -> Result<Vec<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::CreatedAt.gte(since))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

// ── events ──────────────────────────────────────────────────────────────────

/// Queue an event. `false` when its `source_key` was already recorded — a
/// repeated arrival is the same event.
#[allow(clippy::too_many_arguments)]
pub async fn insert_event(
    conn: &DatabaseConnection,
    bot: i32,
    kind: &str,
    source_key: &str,
    coalesce_key: Option<String>,
    summary: String,
    payload: Option<serde_json::Value>,
    wake: bool,
) -> Result<bool, DbError> {
    require_bot(bot)?;
    let source_key = scoped_source_key(conn, bot, source_key).await?;
    let source_key = source_key.as_str();
    let exists = event::Entity::find()
        .filter(event::Column::SourceKey.eq(source_key))
        .count(conn)
        .await?
        > 0;
    if exists {
        return Ok(false);
    }
    let now = Utc::now();
    let row = event::ActiveModel {
        id: NotSet,
        kind: Set(kind.to_string()),
        source_key: Set(source_key.to_string()),
        coalesce_key: Set(coalesce_key),
        summary: Set(summary),
        payload: Set(payload.map(|p| p.to_string())),
        wake: Set(wake),
        state: Set(EventState::Pending),
        batch_id: Set(None),
        requeues: Set(0),
        requeued_from: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        bot_id: Set(Some(bot)),
        origin_bot_id: Set(None),
        origin_row_id: Set(None),
        thread_id: Set(None),
    };
    match row.insert(conn).await {
        Ok(_) => Ok(true),
        // Two arrivals racing past the check above: the unique index decides,
        // and the loser is the duplicate.
        Err(e) if matches!(e.sql_err(), Some(sea_orm::SqlErr::UniqueConstraintViolation(_))) => {
            Ok(false)
        }
        Err(e) => Err(e.into()),
    }
}

/// An event's `source_key` as stored: unique across the table, so a worker's
/// carry `bot<id>:` in front — the same dispatch's news reaching two
/// assistants never collides. The primary's keys are as they always were.
pub async fn scoped_source_key(
    conn: &DatabaseConnection,
    bot: i32,
    key: &str,
) -> Result<String, DbError> {
    let primary = agent::Entity::find_by_id(bot)
        .one(conn)
        .await?
        .is_none_or(|b| b.kind == BotKind::Primary);
    Ok(if primary {
        key.to_string()
    } else {
        format!("bot{bot}:{key}")
    })
}

pub async fn pending_events(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<event::Model>, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::BotId.eq(bot))
        .filter(event::Column::State.eq(EventState::Pending))
        .order_by_asc(event::Column::Id)
        .all(conn)
        .await?)
}

/// Hand pending events to a batch. Returns the ids actually moved.
pub async fn mark_events_delivered(
    conn: &DatabaseConnection,
    ids: &[i32],
    batch_id: i32,
) -> Result<Vec<i32>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Delivered))
        .col_expr(event::Column::BatchId, Expr::value(batch_id))
        .col_expr(event::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(event::Column::Id.is_in(ids.to_vec()))
        .filter(event::Column::State.eq(EventState::Pending))
        .exec(conn)
        .await?;
    delivered_event_ids(conn, batch_id).await
}

/// Every event batch `batch_id` was handed, whatever came of it since.
pub async fn events_of_batch(
    conn: &DatabaseConnection,
    batch_id: i32,
) -> Result<Vec<event::Model>, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::BatchId.eq(batch_id))
        .order_by_asc(event::Column::Id)
        .all(conn)
        .await?)
}

/// An event of this assistant's, by id: `None` for one of another's.
pub async fn get_event_of(
    conn: &DatabaseConnection,
    bot: i32,
    id: i32,
) -> Result<Option<event::Model>, DbError> {
    Ok(event::Entity::find_by_id(id)
        .filter(event::Column::BotId.eq(bot))
        .one(conn)
        .await?)
}

/// The events a batch holds now.
async fn delivered_event_ids(conn: &DatabaseConnection, batch_id: i32) -> Result<Vec<i32>, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::BatchId.eq(batch_id))
        .filter(event::Column::State.eq(EventState::Delivered))
        .order_by_asc(event::Column::Id)
        .all(conn)
        .await?
        .into_iter()
        .map(|e| e.id)
        .collect())
}

/// The events a batch carried are handled.
pub async fn finish_batch_events(conn: &DatabaseConnection, batch_id: i32) -> Result<(), DbError> {
    event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Done))
        .col_expr(event::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(event::Column::BatchId.eq(batch_id))
        .filter(event::Column::State.eq(EventState::Delivered))
        .exec(conn)
        .await?;
    Ok(())
}

/// The batch carrying these events never ended on its own: put each back
/// once, so the next delivery hands it over again with a note. An event that
/// was already put back once is considered handled — a second interruption of
/// the same event most likely means it is what kills the turn.
///
/// Returns the ids put back.
pub async fn requeue_batch_events(conn: &DatabaseConnection, batch_id: i32) -> Result<Vec<i32>, DbError> {
    let now = Utc::now();
    let back: Vec<i32> = event::Entity::find()
        .filter(event::Column::BatchId.eq(batch_id))
        .filter(event::Column::State.eq(EventState::Delivered))
        .filter(event::Column::Requeues.eq(0))
        .all(conn)
        .await?
        .into_iter()
        .map(|e| e.id)
        .collect();
    if back.is_empty() {
        finish_batch_events(conn, batch_id).await?;
        return Ok(back);
    }
    event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Pending))
        .col_expr(event::Column::BatchId, Expr::value(Option::<i32>::None))
        .col_expr(event::Column::RequeuedFrom, Expr::value(batch_id))
        .col_expr(event::Column::Requeues, Expr::col(event::Column::Requeues).add(1))
        .col_expr(event::Column::UpdatedAt, Expr::value(now))
        .filter(event::Column::Id.is_in(back.clone()))
        .filter(event::Column::State.eq(EventState::Delivered))
        .filter(event::Column::Requeues.eq(0))
        .exec(conn)
        .await?;
    finish_batch_events(conn, batch_id).await?;
    Ok(back)
}

/// A batch that never reached the agent: its events wait again, as if never
/// handed out (no requeue counted). Returns the ids put back.
pub async fn revert_batch_events(conn: &DatabaseConnection, batch_id: i32) -> Result<Vec<i32>, DbError> {
    let back = delivered_event_ids(conn, batch_id).await?;
    if back.is_empty() {
        return Ok(back);
    }
    event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Pending))
        .col_expr(event::Column::BatchId, Expr::value(Option::<i32>::None))
        .col_expr(event::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(event::Column::Id.is_in(back.clone()))
        .filter(event::Column::State.eq(EventState::Delivered))
        .exec(conn)
        .await?;
    Ok(back)
}

/// The batch gave way to the owner's message: every event it was handed
/// waits again, to ride with that message — `requeued_from` names the batch
/// (its ledger is inherited, its note written), and `requeues` is NOT
/// counted: giving way is not a failure, and the one requeue a failure gets
/// stays available. Returns the ids put back.
pub async fn yield_batch_events(conn: &DatabaseConnection, batch_id: i32) -> Result<Vec<i32>, DbError> {
    let back = delivered_event_ids(conn, batch_id).await?;
    if back.is_empty() {
        return Ok(back);
    }
    event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Pending))
        .col_expr(event::Column::BatchId, Expr::value(Option::<i32>::None))
        .col_expr(event::Column::RequeuedFrom, Expr::value(batch_id))
        .col_expr(event::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(event::Column::Id.is_in(back.clone()))
        .filter(event::Column::State.eq(EventState::Delivered))
        .exec(conn)
        .await?;
    Ok(back)
}

/// Queue an event together with its result card, in one transaction: an
/// event is never handed out before its card exists (the delivery quotes the
/// card's id, and marks it read). `None` when the event's `source_key` was
/// recorded already — a repeated arrival is the same event.
pub async fn insert_event_with_row(
    conn: &DatabaseConnection,
    bot: i32,
    event: NewEvent,
    mut row: NewRow,
) -> Result<Option<(event::Model, timeline::Model)>, DbError> {
    use sea_orm::TransactionTrait;
    require_bot(bot)?;
    let source_key = scoped_source_key(conn, bot, &event.source_key).await?;
    let now = Utc::now();
    let txn = conn.begin().await?;
    // Insert first: the unique index decides a repeat, and a transaction
    // that reads before it writes can fail under WAL (see the module docs).
    let inserted = event::ActiveModel {
        id: NotSet,
        kind: Set(event.kind),
        source_key: Set(source_key),
        coalesce_key: Set(event.coalesce_key),
        summary: Set(event.summary),
        payload: Set(event.payload.map(|p| p.to_string())),
        wake: Set(event.wake),
        state: Set(EventState::Pending),
        batch_id: Set(None),
        requeues: Set(0),
        requeued_from: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        bot_id: Set(Some(bot)),
        origin_bot_id: Set(event.lineage.origin_bot_id),
        origin_row_id: Set(event.lineage.origin_row_id),
        thread_id: Set(event.lineage.thread_id),
    }
    .insert(&txn)
    .await;
    let ev = match inserted {
        Ok(ev) => ev,
        Err(e) if matches!(e.sql_err(), Some(sea_orm::SqlErr::UniqueConstraintViolation(_))) => {
            txn.rollback().await?;
            return Ok(None);
        }
        Err(e) => {
            let _ = txn.rollback().await;
            return Err(e.into());
        }
    };
    row.event_id = Some(ev.id);
    let card = row.into_active(bot, now).insert(&txn).await?;
    txn.commit().await?;
    Ok(Some((ev, card)))
}

/// An event to queue.
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub kind: String,
    pub source_key: String,
    pub coalesce_key: Option<String>,
    pub summary: String,
    pub payload: Option<serde_json::Value>,
    pub wake: bool,
    /// The chain it belongs to: a dispatch's news carries the dispatch's.
    pub lineage: Lineage,
}

pub async fn count_pending_events(conn: &DatabaseConnection, bot: i32) -> Result<u64, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::BotId.eq(bot))
        .filter(event::Column::State.eq(EventState::Pending))
        .count(conn)
        .await?)
}

// ── items ───────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn create_item(
    conn: &DatabaseConnection,
    bot: i32,
    kind: ItemKind,
    dispatch_id: Option<i32>,
    status: ItemStatus,
    waits_for: Option<WaitsFor>,
    summary: String,
    on_done: Option<String>,
    origin_timeline_id: Option<i32>,
) -> Result<item::Model, DbError> {
    require_bot(bot)?;
    let now = Utc::now();
    let row = item::ActiveModel {
        id: NotSet,
        kind: Set(kind),
        dispatch_id: Set(dispatch_id),
        status: Set(status),
        waits_for: Set(waits_for),
        summary: Set(summary),
        on_done: Set(on_done),
        origin_timeline_id: Set(origin_timeline_id),
        created_at: Set(now),
        updated_at: Set(now),
        bot_id: Set(Some(bot)),
    };
    Ok(row.insert(conn).await?)
}

pub async fn get_item(conn: &DatabaseConnection, id: i32) -> Result<Option<item::Model>, DbError> {
    Ok(item::Entity::find_by_id(id).one(conn).await?)
}

/// A matter of this assistant's, by id: `None` for one of another's.
pub async fn get_item_of(
    conn: &DatabaseConnection,
    bot: i32,
    id: i32,
) -> Result<Option<item::Model>, DbError> {
    Ok(item::Entity::find_by_id(id)
        .filter(item::Column::BotId.eq(bot))
        .one(conn)
        .await?)
}

pub async fn item_of_dispatch(
    conn: &DatabaseConnection,
    dispatch_id: i32,
) -> Result<Option<item::Model>, DbError> {
    Ok(item::Entity::find()
        .filter(item::Column::DispatchId.eq(dispatch_id))
        .order_by_asc(item::Column::Id)
        .one(conn)
        .await?)
}

/// The fields an update may change; `None` leaves one alone.
#[derive(Debug, Default, Clone)]
pub struct ItemWrite {
    pub status: Option<ItemStatus>,
    pub waits_for: Option<Option<WaitsFor>>,
    pub summary: Option<String>,
    pub on_done: Option<Option<String>>,
}

pub async fn update_item(
    conn: &DatabaseConnection,
    id: i32,
    write: ItemWrite,
) -> Result<Option<item::Model>, DbError> {
    let mut update = item::Entity::update_many()
        .col_expr(item::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(item::Column::Id.eq(id));
    if let Some(v) = write.status {
        update = update.col_expr(item::Column::Status, Expr::value(v));
    }
    if let Some(v) = write.waits_for {
        update = update.col_expr(item::Column::WaitsFor, Expr::value(v));
    }
    if let Some(v) = write.summary {
        update = update.col_expr(item::Column::Summary, Expr::value(v));
    }
    if let Some(v) = write.on_done {
        update = update.col_expr(item::Column::OnDone, Expr::value(v));
    }
    update.exec(conn).await?;
    get_item(conn, id).await
}

/// Items in the given statuses (all of them when empty), newest first.
pub async fn list_items(
    conn: &DatabaseConnection,
    bot: i32,
    statuses: &[ItemStatus],
    limit: u64,
) -> Result<Vec<item::Model>, DbError> {
    let mut query = item::Entity::find()
        .filter(item::Column::BotId.eq(bot))
        .order_by_desc(item::Column::Id);
    if !statuses.is_empty() {
        query = query.filter(item::Column::Status.is_in(statuses.to_vec()));
    }
    Ok(query.limit(limit).all(conn).await?)
}

// ── dispatches ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct NewDispatch {
    /// The assistant dispatching it.
    pub bot_id: i32,
    pub mode: DispatchMode,
    pub executor_assistant_id: i32,
    pub executor_snapshot_json: String,
    pub folder_id: Option<i32>,
    pub deliverable: Option<String>,
    pub title: String,
    pub prompt: String,
    pub origin_batch_id: Option<i32>,
    pub on_done: Option<String>,
    /// Where the chain it belongs to started, the thread it is on, and the
    /// input it was dispatched for.
    pub lineage: Lineage,
}

/// Where an input's chain started — an assistant and its timeline row (an
/// owner's message), or the assistant alone (nobody started it) — the thread
/// between assistants it is on, and the input an action was taken for
/// (`<kind>:<id>`, the logical input: a resent message's first copy).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Lineage {
    pub origin_bot_id: Option<i32>,
    pub origin_row_id: Option<i32>,
    pub thread_id: Option<i32>,
    pub for_input: Option<String>,
}

pub async fn create_dispatch(
    conn: &DatabaseConnection,
    new: NewDispatch,
) -> Result<dispatch::Model, DbError> {
    require_bot(new.bot_id)?;
    Ok(dispatch_active(new).insert(conn).await?)
}

fn dispatch_active(new: NewDispatch) -> dispatch::ActiveModel {
    let now = Utc::now();
    dispatch::ActiveModel {
        id: NotSet,
        bot_id: Set(Some(new.bot_id)),
        origin_bot_id: Set(new.lineage.origin_bot_id),
        origin_row_id: Set(new.lineage.origin_row_id),
        thread_id: Set(new.lineage.thread_id),
        for_input: Set(new.lineage.for_input),
        mode: Set(new.mode),
        executor_assistant_id: Set(new.executor_assistant_id),
        executor_snapshot: Set(new.executor_snapshot_json),
        folder_id: Set(new.folder_id),
        deliverable: Set(new.deliverable),
        title: Set(new.title),
        prompt: Set(new.prompt),
        work_task_id: Set(None),
        conversation_id: Set(None),
        connection_id: Set(None),
        state: Set(DispatchState::Queued),
        result_excerpt: Set(None),
        error: Set(None),
        origin_batch_id: Set(new.origin_batch_id),
        source_batch_id: Set(new.origin_batch_id),
        on_done: Set(new.on_done),
        turns: Set(0),
        followup: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        finished_at: Set(None),
        round_op_id: Set(None),
    }
}

/// What a ledgered write came to.
#[derive(Debug, Clone)]
pub enum Ledgered<T> {
    /// It ran now.
    New(T),
    /// The same call is on record already — in this batch, one it
    /// re-delivers, or under this operation id: here is its entry.
    Earlier(Box<action::Model>),
}

/// Where a ledger entry goes. A call made in a delivery: its batch and the
/// call's key. One made outside any (a card the owner clicked): batch 0,
/// keyed by its operation id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerSlot {
    pub batch_id: i32,
    pub key: String,
    pub op_id: String,
}

impl LedgerSlot {
    pub fn in_batch(batch_id: i32, key: String, op_id: String) -> Self {
        Self {
            batch_id,
            key,
            op_id,
        }
    }

    pub fn outside(op_id: String) -> Self {
        Self {
            batch_id: 0,
            key: op_id.clone(),
            op_id,
        }
    }
}

/// A card settled in the same transaction as what it runs: its notice goes
/// from acting to acted, its timeline row takes `row_data` with the state
/// and the dispatch made written in.
#[derive(Debug, Clone)]
pub struct CardSettle {
    pub notice_id: i32,
    pub row_id: i32,
    pub row_data: serde_json::Value,
}

pub(crate) fn is_unique_violation(e: &sea_orm::DbErr) -> bool {
    matches!(
        e.sql_err(),
        Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
    )
}

/// The entry an insert into `slot` collided with.
async fn colliding_entry(
    conn: &DatabaseConnection,
    slot: &LedgerSlot,
) -> Result<action::Model, DbError> {
    if let Some(e) = get_op(conn, &slot.op_id).await? {
        return Ok(e);
    }
    action::Entity::find()
        .filter(action::Column::BatchId.eq(slot.batch_id))
        .filter(action::Column::Key.eq(slot.key.clone()))
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound("ledger entry".into()))
}

/// Record a dispatch together with its ledger entry — and, for one a card
/// runs, the card's settling — in one transaction: the entry is committed
/// with the dispatch it made, or none of it exists. An insert that collides
/// with an entry on record (same batch and key, or same operation) makes
/// nothing and hands that entry back.
pub async fn create_dispatch_ledgered(
    conn: &DatabaseConnection,
    new: NewDispatch,
    slot: &LedgerSlot,
    payload: Option<serde_json::Value>,
    card: Option<CardSettle>,
) -> Result<Ledgered<dispatch::Model>, DbError> {
    use sea_orm::TransactionTrait;
    require_bot(new.bot_id)?;
    let bot = new.bot_id;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let made = dispatch_active(new).insert(&txn).await?;
    let entry = action::ActiveModel {
        id: NotSet,
        bot_id: Set(Some(bot)),
        batch_id: Set(slot.batch_id),
        key: Set(slot.key.clone()),
        kind: Set("dispatch".into()),
        state: Set(ActionState::Committed),
        ref_id: Set(Some(made.id.to_string())),
        created_at: Set(now),
        updated_at: Set(now),
        op_id: Set(Some(slot.op_id.clone())),
        payload: Set(payload.map(|p| p.to_string())),
        observed: Set(None),
        target: Set(None),
        notice_id: Set(card.as_ref().map(|c| c.notice_id)),
        attempted_at: Set(None),
        detail: Set(None),
    }
    .insert(&txn)
    .await;
    match entry {
        Ok(_) => {}
        Err(e) if is_unique_violation(&e) => {
            txn.rollback().await?;
            return Ok(Ledgered::Earlier(Box::new(colliding_entry(conn, slot).await?)));
        }
        Err(e) => {
            let _ = txn.rollback().await;
            return Err(e.into());
        }
    }
    if let Some(card) = card {
        let moved = notice::Entity::update_many()
            .col_expr(notice::Column::State, Expr::value(NoticeState::Acted))
            .col_expr(notice::Column::ActedAt, Expr::value(now))
            .col_expr(notice::Column::UpdatedAt, Expr::value(now))
            .filter(notice::Column::Id.eq(card.notice_id))
            .filter(notice::Column::State.eq(NoticeState::Acting))
            .exec(&txn)
            .await?;
        if moved.rows_affected != 1 {
            txn.rollback().await?;
            return Err(DbError::Conflict("the card is not being acted on".into()));
        }
        let mut data = card.row_data;
        if let Some(map) = data.as_object_mut() {
            map.insert("state".into(), "acted".into());
            map.insert("result".into(), serde_json::json!({ "dispatch_id": made.id }));
            map.insert("error".into(), serde_json::Value::Null);
        }
        timeline::Entity::update_many()
            .col_expr(timeline::Column::Data, Expr::value(data.to_string()))
            .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
            .filter(timeline::Column::Id.eq(card.row_id))
            .exec(&txn)
            .await?;
    }
    txn.commit().await?;
    Ok(Ledgered::New(made))
}

// ── the ledger ──────────────────────────────────────────────────────────────

/// Every entry for `key` in these batches, oldest first.
pub async fn ledger_entries(
    conn: &DatabaseConnection,
    scope: &[i32],
    key: &str,
) -> Result<Vec<action::Model>, DbError> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    Ok(action::Entity::find()
        .filter(action::Column::BatchId.is_in(scope.to_vec()))
        .filter(action::Column::Key.eq(key))
        .order_by_asc(action::Column::Id)
        .all(conn)
        .await?)
}

pub async fn get_op(conn: &DatabaseConnection, op_id: &str) -> Result<Option<action::Model>, DbError> {
    // An operation id is unique across all assistants.
    Ok(action::Entity::find()
        .filter(action::Column::OpId.eq(op_id))
        .one(conn)
        .await?)
}

/// An operation to record before it runs.
#[derive(Debug, Clone)]
pub struct NewOp {
    /// The assistant acting.
    pub bot_id: i32,
    pub slot: LedgerSlot,
    pub kind: &'static str,
    pub payload: serde_json::Value,
    pub target: Option<serde_json::Value>,
    pub notice_id: Option<i32>,
}

/// Record an operation that ran in-process and is done (`committed`), with
/// the answer it gave (`detail`) and what that answer carried (`observed`):
/// a re-delivered turn's same call reads it back instead of running again.
/// `Earlier` when its slot is taken.
pub async fn record_done_op(
    conn: &DatabaseConnection,
    bot_id: i32,
    slot: &LedgerSlot,
    kind: &str,
    payload: serde_json::Value,
    answer: &str,
    observed: serde_json::Value,
) -> Result<Ledgered<action::Model>, DbError> {
    require_bot(bot_id)?;
    let now = Utc::now();
    let inserted = action::ActiveModel {
        id: NotSet,
        bot_id: Set(Some(bot_id)),
        batch_id: Set(slot.batch_id),
        key: Set(slot.key.clone()),
        kind: Set(kind.to_string()),
        state: Set(ActionState::Committed),
        ref_id: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        op_id: Set(Some(slot.op_id.clone())),
        payload: Set(Some(payload.to_string())),
        observed: Set(Some(observed.to_string())),
        target: Set(None),
        notice_id: Set(None),
        attempted_at: Set(None),
        detail: Set(Some(answer.to_string())),
    }
    .insert(conn)
    .await;
    match inserted {
        Ok(e) => Ok(Ledgered::New(e)),
        Err(e) if is_unique_violation(&e) => {
            Ok(Ledgered::Earlier(Box::new(colliding_entry(conn, slot).await?)))
        }
        Err(e) => Err(e.into()),
    }
}

/// Write an operation's intent (`prepared`) before it runs. `Earlier` when
/// its slot is taken — the same call in the same batch, or the same
/// operation id.
pub async fn begin_op(conn: &DatabaseConnection, new: NewOp) -> Result<Ledgered<action::Model>, DbError> {
    require_bot(new.bot_id)?;
    let now = Utc::now();
    let inserted = action::ActiveModel {
        id: NotSet,
        bot_id: Set(Some(new.bot_id)),
        batch_id: Set(new.slot.batch_id),
        key: Set(new.slot.key.clone()),
        kind: Set(new.kind.to_string()),
        state: Set(ActionState::Prepared),
        ref_id: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        op_id: Set(Some(new.slot.op_id.clone())),
        payload: Set(Some(new.payload.to_string())),
        observed: Set(None),
        target: Set(new.target.map(|t| t.to_string())),
        notice_id: Set(new.notice_id),
        attempted_at: Set(None),
        detail: Set(None),
    }
    .insert(conn)
    .await;
    match inserted {
        Ok(e) => Ok(Ledgered::New(e)),
        Err(e) if is_unique_violation(&e) => {
            Ok(Ledgered::Earlier(Box::new(colliding_entry(conn, &new.slot).await?)))
        }
        Err(e) => Err(e.into()),
    }
}

/// A send is about to be written to the agent: mark it, so that an entry
/// without the mark was certainly never sent. False — and the send must not
/// go out — unless the entry is still a prepared, unattempted one.
pub async fn op_attempted(conn: &DatabaseConnection, op_id: &str) -> Result<bool, DbError> {
    let now = Utc::now();
    let res = action::Entity::update_many()
        .col_expr(action::Column::AttemptedAt, Expr::value(now))
        .col_expr(action::Column::UpdatedAt, Expr::value(now))
        .filter(action::Column::OpId.eq(op_id))
        .filter(action::Column::State.eq(ActionState::Prepared))
        .filter(action::Column::AttemptedAt.is_null())
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// The receiving side confirmed the operation (`observed`: how): committed.
/// From prepared, or from unknown — the confirmation can come after codeg
/// gave up waiting for it.
pub async fn op_received(
    conn: &DatabaseConnection,
    op_id: &str,
    observed: serde_json::Value,
) -> Result<bool, DbError> {
    let res = action::Entity::update_many()
        .col_expr(action::Column::State, Expr::value(ActionState::Committed))
        .col_expr(action::Column::Observed, Expr::value(observed.to_string()))
        .col_expr(action::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(action::Column::OpId.eq(op_id))
        .filter(action::Column::State.is_in([ActionState::Prepared, ActionState::Unknown]))
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// Move an operation from one of `from` to `to`, with what it made, why,
/// and the evidence. False when it was not in `from` any more.
pub async fn op_settle(
    conn: &DatabaseConnection,
    op_id: &str,
    from: &[ActionState],
    to: ActionState,
    ref_id: Option<String>,
    detail: Option<String>,
    observed: Option<serde_json::Value>,
) -> Result<bool, DbError> {
    let mut update = action::Entity::update_many()
        .col_expr(action::Column::State, Expr::value(to))
        .col_expr(action::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(action::Column::OpId.eq(op_id))
        .filter(action::Column::State.is_in(from.to_vec()));
    if let Some(r) = ref_id {
        update = update.col_expr(action::Column::RefId, Expr::value(r));
    }
    if let Some(d) = detail {
        update = update.col_expr(action::Column::Detail, Expr::value(d));
    }
    if let Some(o) = observed {
        update = update.col_expr(action::Column::Observed, Expr::value(o.to_string()));
    }
    Ok(update.exec(conn).await?.rows_affected == 1)
}

/// A prepared operation that never reached the point of being sent:
/// `not_executed`. The same test as [`op_attempted`]'s, so of the two racing
/// for one entry exactly one wins — a send this refuses is never written.
pub async fn op_unattempted_to_not_executed(
    conn: &DatabaseConnection,
    op_id: &str,
    detail: &str,
) -> Result<bool, DbError> {
    let res = action::Entity::update_many()
        .col_expr(action::Column::State, Expr::value(ActionState::NotExecuted))
        .col_expr(action::Column::Detail, Expr::value(detail.to_string()))
        .col_expr(action::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(action::Column::OpId.eq(op_id))
        .filter(action::Column::State.eq(ActionState::Prepared))
        .filter(action::Column::AttemptedAt.is_null())
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// Back to prepared, unattempted, under a NEW operation id: an operation that
/// certainly did not run is run again — and a send of the old id still on
/// its way somewhere finds no entry to mark, so it is never written.
pub async fn op_rearm(
    conn: &DatabaseConnection,
    op_id: &str,
    new_op_id: &str,
    payload: serde_json::Value,
    target: serde_json::Value,
) -> Result<bool, DbError> {
    let res = action::Entity::update_many()
        .col_expr(action::Column::OpId, Expr::value(new_op_id.to_string()))
        .col_expr(action::Column::Payload, Expr::value(payload.to_string()))
        .col_expr(action::Column::Target, Expr::value(target.to_string()))
        .col_expr(action::Column::Observed, Expr::value(Option::<String>::None))
        .col_expr(action::Column::RefId, Expr::value(Option::<String>::None))
        .col_expr(action::Column::State, Expr::value(ActionState::Prepared))
        .col_expr(
            action::Column::AttemptedAt,
            Expr::value(Option::<DateTime<Utc>>::None),
        )
        .col_expr(action::Column::Detail, Expr::value(Option::<String>::None))
        .col_expr(action::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(action::Column::OpId.eq(op_id))
        .filter(action::Column::State.is_in([ActionState::NotExecuted, ActionState::Failed]))
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

pub async fn op_set_target(
    conn: &DatabaseConnection,
    op_id: &str,
    target: serde_json::Value,
) -> Result<(), DbError> {
    action::Entity::update_many()
        .col_expr(action::Column::Target, Expr::value(target.to_string()))
        .col_expr(action::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(action::Column::OpId.eq(op_id))
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn op_set_notice(conn: &DatabaseConnection, op_id: &str, notice_id: i32) -> Result<(), DbError> {
    action::Entity::update_many()
        .col_expr(action::Column::NoticeId, Expr::value(notice_id))
        .col_expr(action::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(action::Column::OpId.eq(op_id))
        .exec(conn)
        .await?;
    Ok(())
}

/// Operations in these states, oldest first.
pub async fn ops_in_states(
    conn: &DatabaseConnection,
    bot: i32,
    states: &[ActionState],
) -> Result<Vec<action::Model>, DbError> {
    Ok(action::Entity::find()
        .filter(action::Column::BotId.eq(bot))
        .filter(action::Column::State.is_in(states.to_vec()))
        .filter(action::Column::OpId.is_not_null())
        .order_by_asc(action::Column::Id)
        .all(conn)
        .await?)
}

/// The operations a card ran, oldest first.
pub async fn ops_of_notice(conn: &DatabaseConnection, notice_id: i32) -> Result<Vec<action::Model>, DbError> {
    Ok(action::Entity::find()
        .filter(action::Column::NoticeId.eq(notice_id))
        .order_by_asc(action::Column::Id)
        .all(conn)
        .await?)
}

// ── notices ─────────────────────────────────────────────────────────────────

/// A native card to raise.
#[derive(Debug, Clone)]
pub struct NewNotice {
    pub kind: NoticeKind,
    pub subject_key: Option<String>,
    pub level: NoticeLevel,
    pub batch_id: Option<i32>,
    pub payload: serde_json::Value,
}

/// Raise a native card: its state and its timeline row, in one transaction
/// (the row's `ref_id` is the notice's id, the notice's `timeline_id` the
/// row's).
pub async fn create_notice_with_row(
    conn: &DatabaseConnection,
    bot: i32,
    new: NewNotice,
    mut row: NewRow,
) -> Result<(notice::Model, timeline::Model), DbError> {
    use sea_orm::TransactionTrait;
    require_bot(bot)?;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let made = notice::ActiveModel {
        id: NotSet,
        bot_id: Set(Some(bot)),
        kind: Set(new.kind),
        subject_key: Set(new.subject_key),
        level: Set(new.level),
        state: Set(NoticeState::Open),
        timeline_id: Set(None),
        batch_id: Set(new.batch_id),
        payload: Set(new.payload.to_string()),
        notified_at: Set(None),
        acted_at: Set(None),
        expires_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await?;
    row.ref_id = Some(made.id.to_string());
    let card = row.into_active(bot, now).insert(&txn).await?;
    notice::Entity::update_many()
        .col_expr(notice::Column::TimelineId, Expr::value(card.id))
        .filter(notice::Column::Id.eq(made.id))
        .exec(&txn)
        .await?;
    txn.commit().await?;
    let made = notice::Model {
        timeline_id: Some(card.id),
        ..made
    };
    Ok((made, card))
}

pub async fn get_notice(conn: &DatabaseConnection, id: i32) -> Result<Option<notice::Model>, DbError> {
    Ok(notice::Entity::find_by_id(id).one(conn).await?)
}

/// A card of this assistant's, by id: `None` for one of another's.
pub async fn get_notice_of(
    conn: &DatabaseConnection,
    bot: i32,
    id: i32,
) -> Result<Option<notice::Model>, DbError> {
    Ok(notice::Entity::find_by_id(id)
        .filter(notice::Column::BotId.eq(bot))
        .one(conn)
        .await?)
}

/// Move a notice from one of `from` to `to`. False when it was in none of
/// them any more: of two answers to one card, the first wins.
pub async fn move_notice(
    conn: &DatabaseConnection,
    id: i32,
    from: &[NoticeState],
    to: NoticeState,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let acted_at: Option<DateTime<Utc>> = (to != NoticeState::Open).then_some(now);
    let res = notice::Entity::update_many()
        .col_expr(notice::Column::State, Expr::value(to))
        .col_expr(notice::Column::ActedAt, Expr::value(acted_at))
        .col_expr(notice::Column::UpdatedAt, Expr::value(now))
        .filter(notice::Column::Id.eq(id))
        .filter(notice::Column::State.is_in(from.to_vec()))
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// The card of `kind` raised under `subject` by one of the batches in
/// `scope`: what a re-delivered turn raised already.
pub async fn notice_by_subject(
    conn: &DatabaseConnection,
    bot: i32,
    kind: NoticeKind,
    subject: &str,
    scope: &[i32],
) -> Result<Option<notice::Model>, DbError> {
    if scope.is_empty() {
        return Ok(None);
    }
    Ok(notice::Entity::find()
        .filter(notice::Column::BotId.eq(bot))
        .filter(notice::Column::Kind.eq(kind))
        .filter(notice::Column::SubjectKey.eq(subject))
        .filter(notice::Column::BatchId.is_in(scope.to_vec()))
        .order_by_asc(notice::Column::Id)
        .one(conn)
        .await?)
}

/// `bot`'s card of `kind` with `subject`, whenever it was raised (the
/// newest).
pub async fn notice_of_subject(
    conn: &DatabaseConnection,
    bot: i32,
    kind: NoticeKind,
    subject: &str,
) -> Result<Option<notice::Model>, DbError> {
    Ok(notice::Entity::find()
        .filter(notice::Column::BotId.eq(bot))
        .filter(notice::Column::Kind.eq(kind))
        .filter(notice::Column::SubjectKey.eq(subject))
        .order_by_desc(notice::Column::Id)
        .one(conn)
        .await?)
}

/// The cards of `kind`, of any assistant, that moved to one of `states`
/// since `since`.
pub async fn notices_since(
    conn: &DatabaseConnection,
    kind: NoticeKind,
    states: &[NoticeState],
    since: DateTime<Utc>,
) -> Result<Vec<notice::Model>, DbError> {
    Ok(notice::Entity::find()
        .filter(notice::Column::Kind.eq(kind))
        .filter(notice::Column::State.is_in(states.to_vec()))
        .filter(notice::Column::UpdatedAt.gte(since))
        .order_by_asc(notice::Column::Id)
        .all(conn)
        .await?)
}

pub async fn notices_in_state(
    conn: &DatabaseConnection,
    bot: i32,
    state: NoticeState,
) -> Result<Vec<notice::Model>, DbError> {
    Ok(notice::Entity::find()
        .filter(notice::Column::BotId.eq(bot))
        .filter(notice::Column::State.eq(state))
        .order_by_asc(notice::Column::Id)
        .all(conn)
        .await?)
}

pub async fn get_dispatch(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find_by_id(id).one(conn).await?)
}

/// A dispatch of this assistant's, by id: `None` for one of another's.
pub async fn get_dispatch_of(
    conn: &DatabaseConnection,
    bot: i32,
    id: i32,
) -> Result<Option<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find_by_id(id)
        .filter(dispatch::Column::BotId.eq(bot))
        .one(conn)
        .await?)
}

/// The fields an update may change; `None` leaves one alone.
#[derive(Debug, Default, Clone)]
pub struct DispatchWrite {
    pub state: Option<DispatchState>,
    pub work_task_id: Option<i32>,
    pub conversation_id: Option<i32>,
    pub connection_id: Option<Option<String>>,
    pub result_excerpt: Option<Option<String>>,
    pub error: Option<Option<String>>,
    pub followup: Option<Option<String>>,
    pub source_batch_id: Option<Option<i32>>,
    pub bump_turns: bool,
    /// The operation claiming this round (`round_op_id`), or none.
    pub round_op_id: Option<Option<String>>,
    /// Only while the round is this operation's.
    pub expect_round_op: Option<String>,
}

/// Update a dispatch. With `expect`, only while it is in one of those states
/// — the guard that keeps a late event from rolling a settled dispatch back.
/// Returns the row when the update applied.
pub async fn update_dispatch(
    conn: &DatabaseConnection,
    id: i32,
    expect: Option<&[DispatchState]>,
    write: DispatchWrite,
) -> Result<Option<dispatch::Model>, DbError> {
    let now = Utc::now();
    let mut update = dispatch::Entity::update_many()
        .col_expr(dispatch::Column::UpdatedAt, Expr::value(now))
        .filter(dispatch::Column::Id.eq(id));
    if let Some(states) = expect {
        update = update.filter(dispatch::Column::State.is_in(states.to_vec()));
    }
    if let Some(op) = write.expect_round_op {
        update = update.filter(dispatch::Column::RoundOpId.eq(op));
    }
    if let Some(v) = write.round_op_id {
        update = update.col_expr(dispatch::Column::RoundOpId, Expr::value(v));
    }
    if let Some(state) = write.state {
        update = update.col_expr(dispatch::Column::State, Expr::value(state));
        let finished = matches!(
            state,
            DispatchState::Completed
                | DispatchState::Failed
                | DispatchState::Canceled
                | DispatchState::Interrupted
                | DispatchState::HandedOver
        );
        update = update.col_expr(
            dispatch::Column::FinishedAt,
            Expr::value(if finished { Some(now) } else { None }),
        );
    }
    if let Some(v) = write.work_task_id {
        update = update.col_expr(dispatch::Column::WorkTaskId, Expr::value(v));
    }
    if let Some(v) = write.conversation_id {
        update = update.col_expr(dispatch::Column::ConversationId, Expr::value(v));
    }
    if let Some(v) = write.connection_id {
        update = update.col_expr(dispatch::Column::ConnectionId, Expr::value(v));
    }
    if let Some(v) = write.result_excerpt {
        update = update.col_expr(dispatch::Column::ResultExcerpt, Expr::value(v));
    }
    if let Some(v) = write.error {
        update = update.col_expr(dispatch::Column::Error, Expr::value(v));
    }
    if let Some(v) = write.followup {
        update = update.col_expr(dispatch::Column::Followup, Expr::value(v));
    }
    if let Some(v) = write.source_batch_id {
        update = update.col_expr(dispatch::Column::SourceBatchId, Expr::value(v));
    }
    if write.bump_turns {
        update = update.col_expr(dispatch::Column::Turns, Expr::col(dispatch::Column::Turns).add(1));
    }
    if update.exec(conn).await?.rows_affected == 0 {
        return Ok(None);
    }
    get_dispatch(conn, id).await
}

/// Dispatches in the given states (all of them when empty), newest first.
pub async fn list_dispatches(
    conn: &DatabaseConnection,
    bot: i32,
    states: &[DispatchState],
    mode: Option<DispatchMode>,
    limit: u64,
) -> Result<Vec<dispatch::Model>, DbError> {
    let mut query = dispatch::Entity::find()
        .filter(dispatch::Column::BotId.eq(bot))
        .order_by_desc(dispatch::Column::Id);
    if !states.is_empty() {
        query = query.filter(dispatch::Column::State.is_in(states.to_vec()));
    }
    if let Some(m) = mode {
        query = query.filter(dispatch::Column::Mode.eq(m));
    }
    Ok(query.limit(limit).all(conn).await?)
}

/// Every assistant's dispatches, newest first, up to `limit`.
pub async fn dispatches_to_executors(
    conn: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .order_by_desc(dispatch::Column::Id)
        .limit(limit)
        .all(conn)
        .await?)
}

/// Dispatches by id, newest first.
pub async fn dispatches_by_ids(
    conn: &DatabaseConnection,
    bot: i32,
    ids: &[i32],
) -> Result<Vec<dispatch::Model>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::BotId.eq(bot))
        .filter(dispatch::Column::Id.is_in(ids.iter().copied().take(500).collect::<Vec<_>>()))
        .order_by_desc(dispatch::Column::Id)
        .all(conn)
        .await?)
}

/// Dispatches created since `since`, oldest first.
pub async fn dispatches_since(
    conn: &DatabaseConnection,
    bot: i32,
    since: DateTime<Utc>,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::BotId.eq(bot))
        .filter(dispatch::Column::CreatedAt.gte(since))
        .order_by_asc(dispatch::Column::Id)
        .all(conn)
        .await?)
}

/// The dispatches batch `batch_id` made or continued (a follow-up it sent
/// moves `source_batch_id` to it).
pub async fn dispatches_run_by_batch(
    conn: &DatabaseConnection,
    batch_id: i32,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(
            Condition::any()
                .add(dispatch::Column::OriginBatchId.eq(batch_id))
                .add(dispatch::Column::SourceBatchId.eq(batch_id)),
        )
        .order_by_asc(dispatch::Column::Id)
        .all(conn)
        .await?)
}

/// The dispatches made on thread `thread_id`, by any assistant.
pub async fn dispatches_of_thread(
    conn: &DatabaseConnection,
    thread_id: i32,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::ThreadId.eq(thread_id))
        .order_by_asc(dispatch::Column::Id)
        .all(conn)
        .await?)
}

pub async fn dispatches_of_batch(
    conn: &DatabaseConnection,
    batch_id: i32,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::OriginBatchId.eq(batch_id))
        .order_by_asc(dispatch::Column::Id)
        .all(conn)
        .await?)
}

/// The dispatch that owns a conversation, when one does — whichever
/// assistant's it is (its `bot_id` says whom its news is for).
pub async fn dispatch_by_conversation(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Option<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::ConversationId.eq(conversation_id))
        .order_by_desc(dispatch::Column::Id)
        .one(conn)
        .await?)
}

pub async fn dispatch_by_connection(
    conn: &DatabaseConnection,
    connection_id: &str,
) -> Result<Option<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::ConnectionId.eq(connection_id))
        .order_by_desc(dispatch::Column::Id)
        .one(conn)
        .await?)
}

/// Conversation dispatches holding a slot: running or blocked on input.
pub async fn count_active_conversation_dispatches(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<u64, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::BotId.eq(bot))
        .filter(dispatch::Column::Mode.is_in([DispatchMode::Chat, DispatchMode::Session]))
        .filter(dispatch::Column::State.is_in([DispatchState::Running, DispatchState::WaitingInput]))
        .count(conn)
        .await?)
}

/// Conversation dispatches waiting for a slot, in the order they started
/// waiting (a queued follow-up waits from when it was asked for).
pub async fn queued_conversation_dispatches(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::BotId.eq(bot))
        .filter(dispatch::Column::Mode.is_in([DispatchMode::Chat, DispatchMode::Session]))
        .filter(dispatch::Column::State.eq(DispatchState::Queued))
        .order_by_asc(dispatch::Column::UpdatedAt)
        .order_by_asc(dispatch::Column::Id)
        .all(conn)
        .await?)
}
