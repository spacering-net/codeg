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

/// An agent with every option picked, as a row stores it: the brain's
/// columns, or the work's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentColumns {
    pub agent_type: String,
    pub agent_options_json: String,
    pub label_snapshot_json: String,
}

impl AgentColumns {
    pub fn of(config: &crate::models::AssistantAgentConfig) -> Self {
        Self {
            agent_type: config.agent_type.as_wire().into_owned(),
            agent_options_json: serde_json::to_string(&config.agent_options)
                .unwrap_or_else(|_| "{}".into()),
            label_snapshot_json: serde_json::to_string(&config.label_snapshot)
                .unwrap_or_else(|_| "{}".into()),
        }
    }
}

/// A worker to make: its identity, its brain and the agent its work runs
/// on.
#[derive(Debug, Clone)]
pub struct NewWorker {
    /// Its uid when the caller has one ready (the page previewed its face
    /// with it); a fresh one otherwise.
    pub uid: Option<String>,
    pub notify: bool,
    pub name: String,
    pub avatar_json: String,
    /// `None`: no brain yet (an import with no primary to copy one from).
    pub brain: Option<AgentColumns>,
    pub work: AgentColumns,
    pub work_instructions: Option<String>,
    pub settings_json: String,
    /// Its directory is made with it; `false` — an import's — leaves it to
    /// be made when it is first needed, `seed_persona` written into it then.
    pub workdir_ready: bool,
    pub seed_persona: Option<String>,
    pub legacy_assistant_uid: Option<String>,
    /// Its place in the roster; `None`: last.
    pub sort_order: Option<i32>,
    pub hidden: bool,
    /// When it was made; `None`: now.
    pub created_at: Option<DateTime<Utc>>,
}

impl NewWorker {
    /// A worker made on the page or by a tool, its directory made with it.
    pub fn made(
        name: String,
        avatar_json: String,
        brain: AgentColumns,
        work: AgentColumns,
        settings_json: String,
    ) -> Self {
        Self {
            uid: None,
            notify: true,
            name,
            avatar_json,
            brain: Some(brain),
            work,
            work_instructions: None,
            settings_json,
            workdir_ready: true,
            seed_persona: None,
            legacy_assistant_uid: None,
            sort_order: None,
            hidden: false,
            created_at: None,
        }
    }
}

/// Make a worker, with a fresh uid, last in the roster unless placed.
pub async fn create_worker(
    conn: &impl ConnectionTrait,
    new: NewWorker,
) -> Result<agent::Model, DbError> {
    let now = Utc::now();
    let sort_order = match new.sort_order {
        Some(s) => s,
        None => {
            agent::Entity::find()
                .filter(agent::Column::DeletedAt.is_null())
                .order_by_desc(agent::Column::SortOrder)
                .one(conn)
                .await?
                .map(|b| b.sort_order)
                .unwrap_or(0)
                + 1
        }
    };
    let created_at = new.created_at.unwrap_or(now);
    let row = agent::ActiveModel {
        id: NotSet,
        name: Set(new.name),
        avatar: Set(new.avatar_json),
        agent_type: Set(new.brain.as_ref().map(|b| b.agent_type.clone())),
        agent_options: Set(new.brain.as_ref().map(|b| b.agent_options_json.clone())),
        label_snapshot: Set(new.brain.as_ref().map(|b| b.label_snapshot_json.clone())),
        settings: Set(new.settings_json),
        workdir: Set(None),
        folder_id: Set(None),
        revision: Set(1),
        created_at: Set(created_at),
        updated_at: Set(created_at),
        kind: Set(BotKind::Worker),
        uid: Set(Some(new.uid.unwrap_or_else(new_bot_uid))),
        sort_order: Set(sort_order),
        pinned_at: Set(None),
        section: Set(None),
        hidden: Set(new.hidden),
        muted: Set(false),
        unread_mark: Set(false),
        notify: Set(new.notify),
        deleted_at: Set(None),
        work_agent_type: Set(new.work.agent_type),
        work_agent_options: Set(new.work.agent_options_json),
        work_label_snapshot: Set(new.work.label_snapshot_json),
        work_instructions: Set(new.work_instructions.filter(|i| !i.trim().is_empty())),
        seed_persona: Set(new.seed_persona),
        seed_version: Set(if new.workdir_ready { 0 } else { 1 }),
        workdir_ready: Set(new.workdir_ready),
        legacy_assistant_id: Set(None),
        legacy_assistant_uid: Set(new.legacy_assistant_uid),
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
    // Their rounds of acceptance go with them (7.5).
    crate::db::entities::personal_agent_verification::Entity::update_many()
        .col_expr(
            crate::db::entities::personal_agent_verification::Column::BotId,
            Expr::value(bot),
        )
        .col_expr(
            crate::db::entities::personal_agent_verification::Column::UpdatedAt,
            Expr::value(now),
        )
        .filter(
            crate::db::entities::personal_agent_verification::Column::DispatchId
                .is_in(ids.to_vec()),
        )
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
/// an insert needs the brain and the work.
#[derive(Debug, Default, Clone)]
pub struct AgentWrite {
    pub name: Option<String>,
    pub avatar_json: Option<String>,
    pub brain: Option<AgentColumns>,
    pub settings_json: Option<String>,
    /// A JSON merge patch (RFC 7396) applied to the stored settings in the
    /// same statement, so keys it leaves out — another window's, another
    /// part of codeg's — stay as they are. Wins over `settings_json` on an
    /// update; an insert takes `settings_json`.
    pub settings_patch: Option<serde_json::Value>,
    /// The agent its work runs on.
    pub work: Option<AgentColumns>,
    /// Its work's standing instructions; `Some(None)` clears them.
    pub work_instructions: Option<Option<String>>,
}

/// Mark a worker's directory made, with the persona version `version` in
/// it — only while that is the version stored: one a sync package wrote
/// since is not cleared (`seed_persona` goes, now in SOUL.md). Whether it
/// was marked.
pub async fn mark_workdir_ready(
    conn: &impl ConnectionTrait,
    id: i32,
    version: i32,
) -> Result<bool, DbError> {
    let res = agent::Entity::update_many()
        .col_expr(agent::Column::WorkdirReady, Expr::value(true))
        .col_expr(agent::Column::SeedPersona, Expr::value(Option::<String>::None))
        .filter(agent::Column::Id.eq(id))
        .filter(agent::Column::SeedVersion.eq(version))
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// Give every assistant with no brain yet a copy of `brain` (the
/// primary's, D3) — only the brain: what its work runs on stays. One with a
/// brain already is not touched, so this is the same however often it
/// runs. The ids given one.
pub async fn fill_missing_brains(
    conn: &impl ConnectionTrait,
    brain: &AgentColumns,
) -> Result<Vec<i32>, DbError> {
    let missing: Vec<i32> = agent::Entity::find()
        .filter(agent::Column::DeletedAt.is_null())
        .filter(agent::Column::AgentType.is_null())
        .all(conn)
        .await?
        .into_iter()
        .map(|b| b.id)
        .collect();
    let mut filled = Vec::new();
    for id in missing {
        let res = agent::Entity::update_many()
            .col_expr(agent::Column::AgentType, Expr::value(brain.agent_type.clone()))
            .col_expr(
                agent::Column::AgentOptions,
                Expr::value(brain.agent_options_json.clone()),
            )
            .col_expr(
                agent::Column::LabelSnapshot,
                Expr::value(brain.label_snapshot_json.clone()),
            )
            .col_expr(agent::Column::UpdatedAt, Expr::value(Utc::now()))
            .col_expr(
                agent::Column::Revision,
                Expr::col(agent::Column::Revision).add(1),
            )
            .filter(agent::Column::Id.eq(id))
            .filter(agent::Column::AgentType.is_null())
            .exec(conn)
            .await?;
        if res.rows_affected > 0 {
            filled.push(id);
        }
    }
    Ok(filled)
}

/// One work assistant as a configuration snapshot carries it (the
/// `assistants` domain, §6.3), already checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedWorker {
    /// The package's uid: a collaboration assistant's from an older build,
    /// or the one an assistant was exported under (`legacy_assistant_uid`,
    /// else its own).
    pub key: String,
    pub name: String,
    /// Its persona, for one whose directory is not made yet; empty: none.
    pub persona: String,
    pub work: AgentColumns,
    pub instructions: String,
    pub hidden: bool,
    pub sort_order: i32,
}

/// What [`import_workers`] wrote.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WorkerImport {
    pub written: usize,
    /// Stored under another name than the package's: another assistant
    /// here already had it.
    pub renamed: usize,
    /// Matched one whose directory is made, the package's persona another
    /// than its own: its `SOUL.md` is its own, and stays.
    pub persona_kept: usize,
}

/// Write a package's work assistants inside the config-sync transaction
/// (§6.3). Each is matched among the live workers only — by
/// `legacy_assistant_uid`, then (for those still unmatched) by `uid` — and
/// overwritten: its name, the agent its work runs on, its standing
/// instructions, hidden, its place; its persona only while its directory is
/// not made (`seed_version` moved on, so the one being made takes it). Its
/// brain is not in a package and stays. One that matches none is made: a
/// new uid and face, the package's uid kept as its `legacy_assistant_uid`
/// (taken off any deleted one first), the primary's brain when there is
/// one, its directory made when first needed; one `created_at` for all made
/// at once. A deleted one is never brought back: its directory may be going
/// away under it, or be another's by now. Nothing is deleted.
///
/// Names are settled for the whole batch first, as `assistant_service::
/// import_into` does: the package's unless an assistant the batch does not
/// write — or one earlier in it — has it, and then with a suffix.
/// `persona_of` reads a made one's persona as a package carries it (`None`
/// when it cannot be read: not counted as kept).
pub async fn import_workers(
    tx: &sea_orm::DatabaseTransaction,
    rows: Vec<ImportedWorker>,
    persona_of: &(dyn Fn(&agent::Model) -> Option<String> + Send + Sync),
) -> Result<WorkerImport, DbError> {
    use crate::db::service::assistant_service::{deduplicated_name, name_key};
    use std::collections::{HashMap, HashSet};

    // Last entry per key, in the order the keys first appear.
    let mut batch: Vec<ImportedWorker> = Vec::with_capacity(rows.len());
    for row in rows {
        match batch.iter_mut().find(|held| held.key == row.key) {
            Some(held) => *held = row,
            None => batch.push(row),
        }
    }
    if batch.is_empty() {
        return Ok(WorkerImport::default());
    }

    let live: Vec<agent::Model> = agent::Entity::find()
        .filter(agent::Column::DeletedAt.is_null())
        .all(tx)
        .await?;
    let workers: Vec<&agent::Model> = live.iter().filter(|b| b.kind == BotKind::Worker).collect();
    // Matched by `legacy_assistant_uid` first for the whole batch, so a row
    // another entry names by its own uid is not taken from the entry its
    // legacy uid names.
    let mut matched: HashMap<usize, &agent::Model> = HashMap::new();
    let mut used: HashSet<i32> = HashSet::new();
    for (i, row) in batch.iter().enumerate() {
        if let Some(b) = workers
            .iter()
            .find(|b| b.legacy_assistant_uid.as_deref() == Some(row.key.as_str()))
        {
            used.insert(b.id);
            matched.insert(i, *b);
        }
    }
    for (i, row) in batch.iter().enumerate() {
        if matched.contains_key(&i) {
            continue;
        }
        if let Some(b) = workers
            .iter()
            .find(|b| !used.contains(&b.id) && b.uid.as_deref() == Some(row.key.as_str()))
        {
            used.insert(b.id);
            matched.insert(i, *b);
        }
    }

    let mut taken: HashSet<String> = live
        .iter()
        .filter(|b| !used.contains(&b.id))
        .map(|b| name_key(b.name.trim()))
        .collect();
    let names: Vec<String> = batch
        .iter()
        .map(|row| {
            let name = deduplicated_name(&row.name, &taken);
            taken.insert(name_key(&name));
            name
        })
        .collect();

    let brain = live
        .iter()
        .filter(|b| b.kind == BotKind::Primary)
        .min_by_key(|b| b.id)
        .and_then(|p| {
            Some(AgentColumns {
                agent_type: p.agent_type.clone()?,
                agent_options_json: p.agent_options.clone().unwrap_or_else(|| "{}".into()),
                label_snapshot_json: p.label_snapshot.clone().unwrap_or_else(|| "{}".into()),
            })
        });

    let mut outcome = WorkerImport::default();
    let now = Utc::now();
    for (i, (row, name)) in batch.into_iter().zip(names).enumerate() {
        if name != row.name {
            outcome.renamed += 1;
        }
        let persona = Some(row.persona.trim())
            .filter(|p| !p.is_empty())
            .map(str::to_string);
        let instructions = Some(row.instructions).filter(|i| !i.trim().is_empty());
        match matched.get(&i) {
            Some(existing) => {
                let mut update = agent::Entity::update_many()
                    .col_expr(agent::Column::Name, Expr::value(name))
                    .col_expr(agent::Column::WorkAgentType, Expr::value(row.work.agent_type))
                    .col_expr(
                        agent::Column::WorkAgentOptions,
                        Expr::value(row.work.agent_options_json),
                    )
                    .col_expr(
                        agent::Column::WorkLabelSnapshot,
                        Expr::value(row.work.label_snapshot_json),
                    )
                    .col_expr(agent::Column::WorkInstructions, Expr::value(instructions))
                    .col_expr(agent::Column::Hidden, Expr::value(row.hidden))
                    .col_expr(agent::Column::SortOrder, Expr::value(row.sort_order))
                    .col_expr(
                        agent::Column::Revision,
                        Expr::col(agent::Column::Revision).add(1),
                    )
                    .col_expr(agent::Column::UpdatedAt, Expr::value(now));
                if existing.workdir_ready {
                    let folded = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
                    let given = folded(persona.as_deref().unwrap_or_default());
                    if persona_of(existing).is_some_and(|own| folded(&own) != given) {
                        outcome.persona_kept += 1;
                    }
                } else {
                    // The directory being made takes this one (§6.2): its
                    // version moves on, so the one made with the old is not
                    // marked ready on it.
                    update = update
                        .col_expr(agent::Column::SeedPersona, Expr::value(persona))
                        .col_expr(
                            agent::Column::SeedVersion,
                            Expr::col(agent::Column::SeedVersion).add(1),
                        );
                }
                update
                    .filter(agent::Column::Id.eq(existing.id))
                    .exec(tx)
                    .await?;
            }
            None => {
                // A deleted one's legacy uid is the new one's now.
                agent::Entity::update_many()
                    .col_expr(
                        agent::Column::LegacyAssistantUid,
                        Expr::value(Option::<String>::None),
                    )
                    .filter(agent::Column::LegacyAssistantUid.eq(row.key.as_str()))
                    .filter(agent::Column::DeletedAt.is_not_null())
                    .exec(tx)
                    .await?;
                let uid = new_bot_uid();
                let avatar = serde_json::to_string(
                    &crate::models::personal_agent_bots::BotAvatar::default_for(&uid),
                )
                .unwrap_or_else(|_| "{}".into());
                create_worker(
                    tx,
                    NewWorker {
                        uid: Some(uid),
                        notify: true,
                        name,
                        avatar_json: avatar,
                        brain: brain.clone(),
                        work: row.work,
                        work_instructions: instructions,
                        settings_json: "{}".into(),
                        workdir_ready: false,
                        seed_persona: persona,
                        legacy_assistant_uid: Some(row.key),
                        sort_order: Some(row.sort_order),
                        hidden: row.hidden,
                        created_at: Some(now),
                    },
                )
                .await?;
            }
        }
        outcome.written += 1;
    }
    Ok(outcome)
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

/// The opening statement of a transaction that reads an assistant's row
/// and then writes it: a write that changes nothing, so the transaction
/// holds the write lock from its start. A deferred transaction that reads
/// first and writes later fails with `SQLITE_BUSY_SNAPSHOT` when another
/// connection commits in between (see `canvas_service::claim_writer`).
/// Whether the row is there.
pub async fn claim_row(conn: &impl ConnectionTrait, id: i32) -> Result<bool, DbError> {
    let res = agent::Entity::update_many()
        .col_expr(agent::Column::Revision, Expr::col(agent::Column::Revision).into())
        .filter(agent::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// [`patch_settings`], only while the value at JSON `path` (`$.a.b`) is
/// `expect` (`None`: absent or null) — the check and the write one
/// statement, so a save in between is never overwritten. Whether it wrote.
pub async fn patch_settings_if(
    conn: &impl ConnectionTrait,
    id: i32,
    path: &str,
    expect: Option<&str>,
    patch: &serde_json::Value,
) -> Result<bool, DbError> {
    let at: Vec<sea_orm::Value> = vec![path.to_string().into(), expect.map(str::to_string).into()];
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
        .filter(Expr::cust_with_values(
            "json_extract(CASE WHEN json_valid(settings) AND json_type(settings) = 'object' \
             THEN settings ELSE '{}' END, ?) IS ?",
            at,
        ))
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// A change to how an assistant sits on the roster (4.14). Not a setting:
/// neither the revision nor `updated_at` moves, so a settings view open on
/// it is not told someone else changed it.
#[derive(Debug, Clone, Default)]
pub struct RosterWrite {
    pub pinned_at: Option<Option<DateTime<Utc>>>,
    pub section: Option<Option<String>>,
    pub hidden: Option<bool>,
    pub muted: Option<bool>,
    pub unread_mark: Option<bool>,
    pub notify: Option<bool>,
    pub sort_order: Option<i32>,
}

pub async fn set_roster(
    conn: &DatabaseConnection,
    id: i32,
    write: RosterWrite,
) -> Result<Option<agent::Model>, DbError> {
    let mut update = agent::Entity::update_many()
        .filter(agent::Column::Id.eq(id))
        .filter(agent::Column::DeletedAt.is_null());
    let mut any = false;
    if let Some(v) = write.pinned_at {
        update = update.col_expr(agent::Column::PinnedAt, Expr::value(v));
        any = true;
    }
    if let Some(v) = write.section {
        update = update.col_expr(agent::Column::Section, Expr::value(v));
        any = true;
    }
    if let Some(v) = write.hidden {
        update = update.col_expr(agent::Column::Hidden, Expr::value(v));
        any = true;
    }
    if let Some(v) = write.muted {
        update = update.col_expr(agent::Column::Muted, Expr::value(v));
        any = true;
    }
    if let Some(v) = write.unread_mark {
        update = update.col_expr(agent::Column::UnreadMark, Expr::value(v));
        any = true;
    }
    if let Some(v) = write.notify {
        update = update.col_expr(agent::Column::Notify, Expr::value(v));
        any = true;
    }
    if let Some(v) = write.sort_order {
        update = update.col_expr(agent::Column::SortOrder, Expr::value(v));
        any = true;
    }
    if any {
        update.exec(conn).await?;
    }
    get_bot(conn, id).await
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
    let Some(brain) = write.brain else {
        return Err(DbError::Validation(
            "the personal agent needs an agent to run on".into(),
        ));
    };
    let Some(work) = write.work else {
        return Err(DbError::Validation(
            "the personal agent needs an agent for its work".into(),
        ));
    };
    let row = agent::ActiveModel {
        id: NotSet,
        name: Set(write.name.unwrap_or_default()),
        avatar: Set(write
            .avatar_json
            .unwrap_or_else(|| r#"{"kind":"emoji","emoji":"🧭","color":"violet"}"#.into())),
        agent_type: Set(Some(brain.agent_type)),
        agent_options: Set(Some(brain.agent_options_json)),
        label_snapshot: Set(Some(brain.label_snapshot_json)),
        settings: Set(write.settings_json.unwrap_or_else(|| "{}".into())),
        workdir: Set(None),
        folder_id: Set(None),
        revision: Set(1),
        created_at: Set(now),
        updated_at: Set(now),
        kind: Set(BotKind::Primary),
        uid: Set(Some(new_bot_uid())),
        sort_order: Set(0),
        pinned_at: Set(None),
        section: Set(None),
        hidden: Set(false),
        muted: Set(false),
        unread_mark: Set(false),
        notify: Set(true),
        deleted_at: Set(None),
        work_agent_type: Set(work.agent_type),
        work_agent_options: Set(work.agent_options_json),
        work_label_snapshot: Set(work.label_snapshot_json),
        work_instructions: Set(write.work_instructions.flatten()),
        seed_persona: Set(None),
        seed_version: Set(0),
        workdir_ready: Set(true),
        legacy_assistant_id: Set(None),
        legacy_assistant_uid: Set(None),
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
    if let Some(b) = write.brain {
        update = update
            .col_expr(agent::Column::AgentType, Expr::value(Some(b.agent_type)))
            .col_expr(agent::Column::AgentOptions, Expr::value(Some(b.agent_options_json)))
            .col_expr(agent::Column::LabelSnapshot, Expr::value(Some(b.label_snapshot_json)));
    }
    if let Some(w) = write.work {
        update = update
            .col_expr(agent::Column::WorkAgentType, Expr::value(w.agent_type))
            .col_expr(agent::Column::WorkAgentOptions, Expr::value(w.agent_options_json))
            .col_expr(agent::Column::WorkLabelSnapshot, Expr::value(w.label_snapshot_json));
    }
    if let Some(v) = write.work_instructions {
        update = update.col_expr(
            agent::Column::WorkInstructions,
            Expr::value(v.filter(|i| !i.trim().is_empty())),
        );
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
        team_digest: Set(None),
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

pub async fn set_segment_team_digest(
    conn: &DatabaseConnection,
    id: i32,
    digest: Option<String>,
) -> Result<(), DbError> {
    segment::Entity::update_many()
        .col_expr(segment::Column::TeamDigest, Expr::value(digest))
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
    let mut data: Option<serde_json::Value> =
        m.data.as_deref().and_then(|d| serde_json::from_str(d).ok());
    // A result card written before its gist was (A1): the gist of its
    // excerpt, read now.
    if m.kind == TimelineKind::Result {
        if let Some(map) = data.as_mut().and_then(|d| d.as_object_mut()) {
            if !map.contains_key("gist") {
                let gist = map
                    .get("excerpt")
                    .and_then(|e| e.as_str())
                    .and_then(crate::personal_agent::gist::plain_gist);
                map.insert("gist".into(), serde_json::json!(gist));
            }
        }
    }
    TimelineRow {
        id: m.id,
        segment_id: m.segment_id,
        batch_id: m.batch_id,
        kind: m.kind,
        status: m.status,
        body: m.body,
        data,
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

/// Whether a row is a reply whose prompt never reached the agent — or one
/// that said only that there was nothing to say (a routine's `[[silent]]`,
/// 6.9): every reader treats it as absent.
pub fn is_discarded(m: &timeline::Model) -> bool {
    m.kind == TimelineKind::Reply && matches!(reply_state(m), Some("discarded" | "silent"))
}

/// A reply row's `data.state`: `running`, `done`, `canceled`,
/// `interrupted`, `discarded`, `silent` — `None` on a phase-one row, which
/// has none.
pub fn reply_state(m: &timeline::Model) -> Option<&'static str> {
    let data = m.data.as_deref()?;
    let state = serde_json::from_str::<serde_json::Value>(data)
        .ok()?
        .get("state")?
        .as_str()?
        .to_string();
    [
        "running",
        "done",
        "canceled",
        "interrupted",
        "discarded",
        "silent",
    ]
    .into_iter()
    .find(|s| *s == state)
}

/// Whether a reply row holds nothing to read yet: running with no body, or
/// discarded.
pub fn is_unwritten_reply(m: &timeline::Model) -> bool {
    m.kind == TimelineKind::Reply
        && match reply_state(m) {
            Some("discarded" | "silent") => true,
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

/// Insert `row` and, in the same transaction, set row `other`'s data to
/// `data` (the assistant's own rows only): both are written, or neither.
/// Returns the new row and `other` as written.
pub async fn insert_row_writing(
    conn: &DatabaseConnection,
    bot: i32,
    row: NewRow,
    other: i32,
    data: serde_json::Value,
) -> Result<(timeline::Model, Option<timeline::Model>), DbError> {
    use sea_orm::TransactionTrait;
    require_bot(bot)?;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let inserted = row.into_active(bot, now).insert(&txn).await?;
    let written = timeline::Entity::update_many()
        .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
        .col_expr(timeline::Column::Data, Expr::value(Some(data.to_string())))
        .filter(timeline::Column::Id.eq(other))
        .filter(timeline::Column::BotId.eq(bot))
        .exec(&txn)
        .await?;
    if written.rows_affected != 1 {
        return Err(DbError::Validation(format!("no row #{other} of this assistant")));
    }
    txn.commit().await?;
    let other = get_row(conn, other).await?;
    Ok((inserted, other))
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

/// The result cards of these events, by event id — a matter that came due
/// for the assistant to do is numbered by its reminder card (6.1).
pub async fn result_rows_of_events(
    conn: &DatabaseConnection,
    event_ids: &[i32],
) -> Result<Vec<timeline::Model>, DbError> {
    if event_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.is_in([TimelineKind::Result, TimelineKind::Notice]))
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

/// When the owner last wrote to `bot` before row `before` (before now,
/// without it): the `<codeg-now>` line's "last message" (6.1).
pub async fn last_owner_message_before(
    conn: &DatabaseConnection,
    bot: i32,
    before: Option<i32>,
) -> Result<Option<DateTime<Utc>>, DbError> {
    let mut query = timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Owner));
    if let Some(id) = before {
        query = query.filter(timeline::Column::Id.lt(id));
    }
    Ok(query
        .order_by_desc(timeline::Column::Id)
        .one(conn)
        .await?
        .map(|r| r.created_at))
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
                             NOT IN ('running', 'discarded', 'silent')",
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
    conn: &impl ConnectionTrait,
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

/// The newest row of an assistant's timeline: when anything last happened
/// in its conversation.
pub async fn latest_row(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Option<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .order_by_desc(timeline::Column::Id)
        .one(conn)
        .await?)
}

/// The questions and permission requests in an assistant's conversation
/// still waiting for the owner (its own brain's and those shown for
/// another), oldest first.
pub async fn pending_prompt_rows(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(
            timeline::Column::Kind.is_in([TimelineKind::Question, TimelineKind::Permission]),
        )
        .filter(Expr::cust("json_extract(data, '$.state') = 'pending'"))
        .order_by_asc(timeline::Column::Id)
        .limit(50)
        .all(conn)
        .await?)
}

/// The last reply with words in it that an assistant finished.
pub async fn last_said(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Option<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Reply))
        .filter(Expr::cust("trim(body) <> ''"))
        .filter(Expr::cust(
            "COALESCE(json_extract(data, '$.state'), '') NOT IN ('running', 'discarded', 'silent')",
        ))
        .order_by_desc(timeline::Column::Id)
        .one(conn)
        .await?)
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

/// Every assistant's events of `kind` still on their way: waiting for a
/// delivery, or riding in one.
pub async fn events_in_flight(
    conn: &DatabaseConnection,
    kind: &str,
) -> Result<Vec<event::Model>, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::Kind.eq(kind))
        .filter(event::Column::State.is_in([EventState::Pending, EventState::Delivered]))
        .order_by_asc(event::Column::Id)
        .all(conn)
        .await?)
}

/// Let pending events go unhandled: they are done, and no delivery takes
/// them. One already handed out is left to its batch.
pub async fn drop_events(conn: &DatabaseConnection, ids: &[i32]) -> Result<u64, DbError> {
    if ids.is_empty() {
        return Ok(0);
    }
    let res = event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Done))
        .col_expr(event::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(event::Column::Id.is_in(ids.to_vec()))
        .filter(event::Column::State.eq(EventState::Pending))
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}

/// The newest event of `kind` in assistant `bot`'s queue that a delivery
/// took — one let go before any did is not it.
pub async fn latest_delivered_event_of(
    conn: &DatabaseConnection,
    bot: i32,
    kind: &str,
) -> Result<Option<event::Model>, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::BotId.eq(bot))
        .filter(event::Column::Kind.eq(kind))
        .filter(event::Column::BatchId.is_not_null())
        .order_by_desc(event::Column::Id)
        .one(conn)
        .await?)
}

/// Whether an event whose key ends with `suffix` was ever queued, for any
/// assistant (a worker's keys carry its prefix).
pub async fn event_key_ends_with(conn: &DatabaseConnection, suffix: &str) -> Result<bool, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::SourceKey.ends_with(suffix))
        .count(conn)
        .await?
        > 0)
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

/// The newest event under `coalesce_key`.
pub async fn latest_event_of_coalesce(
    conn: &DatabaseConnection,
    coalesce_key: &str,
) -> Result<Option<event::Model>, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::CoalesceKey.eq(coalesce_key))
        .order_by_desc(event::Column::Id)
        .one(conn)
        .await?)
}

/// This assistant's events under `coalesce_key` not yet handed to any
/// delivery, oldest first.
pub async fn pending_events_of_coalesce(
    conn: &DatabaseConnection,
    bot: i32,
    coalesce_key: &str,
) -> Result<Vec<event::Model>, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::BotId.eq(bot))
        .filter(event::Column::CoalesceKey.eq(coalesce_key))
        .filter(event::Column::State.eq(EventState::Pending))
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

/// The pending news of dispatched work that the turn of `batch_id` was handed
/// mid-turn (`dispatch_wait`) and reported, through the events of the result
/// cards `rows`: settled with that batch — each such event and the older
/// pending news of the same work, which only it would have said again — so
/// no later delivery tells it once more. Only pending events move: one a
/// delivery has taken meanwhile is that delivery's. Returns the event ids
/// settled.
pub async fn settle_waited_events(
    conn: &DatabaseConnection,
    bot: i32,
    rows: &[i32],
    batch_id: i32,
) -> Result<Vec<i32>, DbError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let event_ids: Vec<i32> = timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Result))
        .filter(timeline::Column::Id.is_in(rows.to_vec()))
        .all(conn)
        .await?
        .into_iter()
        .filter_map(|r| r.event_id)
        .collect();
    if event_ids.is_empty() {
        return Ok(Vec::new());
    }
    let events = event::Entity::find()
        .filter(event::Column::BotId.eq(bot))
        .filter(event::Column::Id.is_in(event_ids))
        .filter(event::Column::Kind.eq("dispatch_status"))
        .all(conn)
        .await?;
    // Read first, then one guarded update — no read-then-write transaction
    // (see the module docs). The caller holds the pump, so no delivery takes
    // these events between the read and the write.
    let mut settled: Vec<i32> = Vec::new();
    for e in events {
        let Some(key) = e.coalesce_key.as_deref() else {
            continue;
        };
        settled.extend(
            event::Entity::find()
                .filter(event::Column::BotId.eq(bot))
                .filter(event::Column::CoalesceKey.eq(key))
                .filter(event::Column::State.eq(EventState::Pending))
                .filter(event::Column::Id.lte(e.id))
                .all(conn)
                .await?
                .into_iter()
                .map(|e| e.id),
        );
    }
    settled.sort_unstable();
    settled.dedup();
    if settled.is_empty() {
        return Ok(settled);
    }
    event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Done))
        .col_expr(event::Column::BatchId, Expr::value(batch_id))
        .col_expr(event::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(event::Column::BotId.eq(bot))
        .filter(event::Column::Id.is_in(settled.clone()))
        .filter(event::Column::State.eq(EventState::Pending))
        .exec(conn)
        .await?;
    Ok(settled)
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

/// Queue `event` (its chain and all) without a card. `false` when its
/// `source_key` was already recorded.
pub async fn insert_new_event(
    conn: &DatabaseConnection,
    bot: i32,
    event: NewEvent,
) -> Result<bool, DbError> {
    require_bot(bot)?;
    let source_key = scoped_source_key(conn, bot, &event.source_key).await?;
    let now = Utc::now();
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
    .insert(conn)
    .await;
    match inserted {
        Ok(_) => Ok(true),
        Err(e)
            if matches!(
                e.sql_err(),
                Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(e.into()),
    }
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
    create_item_timed(
        conn,
        bot,
        kind,
        dispatch_id,
        status,
        waits_for,
        summary,
        on_done,
        origin_timeline_id,
        ItemTime::default(),
    )
    .await
}

/// [`create_item`], due at a time (6.1).
#[allow(clippy::too_many_arguments)]
pub async fn create_item_timed(
    conn: &DatabaseConnection,
    bot: i32,
    kind: ItemKind,
    dispatch_id: Option<i32>,
    status: ItemStatus,
    waits_for: Option<WaitsFor>,
    summary: String,
    on_done: Option<String>,
    origin_timeline_id: Option<i32>,
    time: ItemTime,
) -> Result<item::Model, DbError> {
    require_bot(bot)?;
    let now = Utc::now();
    // Only the assistant writes one settled from the start (`item_update`
    // with a status of done or dropped).
    let how = match status {
        ItemStatus::Done => Some("done"),
        ItemStatus::Dropped => Some("dropped"),
        _ => None,
    };
    let row = item::ActiveModel {
        id: NotSet,
        kind: Set(kind),
        dispatch_id: Set(dispatch_id),
        closed_at: Set(how.map(|_| now)),
        closed_by: Set(how.map(|_| Closer::Agent.as_str().to_string())),
        closed_how: Set(how.map(str::to_string)),
        answer_row_id: Set(None),
        answer_state: Set(None),
        status: Set(status),
        waits_for: Set(waits_for),
        summary: Set(summary),
        on_done: Set(on_done),
        origin_timeline_id: Set(origin_timeline_id),
        created_at: Set(now),
        updated_at: Set(now),
        bot_id: Set(Some(bot)),
        due_at: Set(time.due_at),
        repeat: Set(time.repeat),
        at_due: Set(time.at_due),
        act_spec: Set(time.act_spec),
        fired_at: Set(None),
        mention: Set(None),
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
    /// A matter's time, whole: its due time, repeat, what happens then,
    /// what to do, and when its current time fired.
    pub time: Option<ItemTime>,
    /// Who settles it and how, when `status` settles it: written only on
    /// the move from open or waiting, never over an earlier settling's.
    pub closing: Option<Closing>,
    /// The owner's answer to a question, set (`Some(Some)`) or cleared
    /// (`Some(None)`). Left out, a write of `status` or `waits_for` clears
    /// it: whatever moved the matter ended what the answer was waiting on.
    pub answer: Option<Option<AnswerLink>>,
}

/// Who settled a matter (`personal_agent_item.closed_by`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closer {
    /// The owner, on the panel or a card.
    Owner,
    /// The assistant, with `item_update`.
    Agent,
    /// codeg, as what the matter waited on came (an answer, a reply, ...).
    Codeg,
}

impl Closer {
    pub fn as_str(self) -> &'static str {
        match self {
            Closer::Owner => "owner",
            Closer::Agent => "agent",
            Closer::Codeg => "codeg",
        }
    }
}

/// How a matter came to be settled (`closed_by`, `closed_how`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Closing {
    pub by: Closer,
    /// `done`, `dropped`, `withdrawn`, `stopped_waiting`, `plan_canceled`,
    /// `answered`, `replied`, `gone`, `used_up`, `expired`, `merged`,
    /// `replaced`.
    pub how: &'static str,
}

impl Closing {
    pub const fn new(by: Closer, how: &'static str) -> Self {
        Self { by, how }
    }
}

/// An owner's answer linked to a question (`answer_row_id`,
/// `answer_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnswerLink {
    pub row_id: Option<i32>,
    pub state: AnswerState,
}

/// How the owner's answer to a question stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerState {
    /// Sent, the assistant has it: the question waits for it to be read.
    Linked,
    /// The turn that had it did not finish: back with the owner.
    Interrupted,
}

impl AnswerState {
    pub fn as_str(self) -> &'static str {
        match self {
            AnswerState::Linked => "linked",
            AnswerState::Interrupted => "interrupted",
        }
    }

    pub fn parse(s: Option<&str>) -> Option<Self> {
        match s {
            Some("linked") => Some(AnswerState::Linked),
            Some("interrupted") => Some(AnswerState::Interrupted),
            _ => None,
        }
    }
}

/// Write a matter's move to `to` on `update`, with how it was settled:
/// stamped only when the row is still open or waiting before the write
/// (in SQLite the right-hand side of an `UPDATE ... SET` reads the row as
/// it was), so a settled matter written settled again keeps who settled it
/// first; cleared when it opens again.
pub fn closing_exprs(
    mut update: sea_orm::UpdateMany<item::Entity>,
    to: ItemStatus,
    closing: Option<Closing>,
    now: DateTime<Utc>,
) -> sea_orm::UpdateMany<item::Entity> {
    if matches!(to, ItemStatus::Open | ItemStatus::Waiting) {
        return update
            .col_expr(item::Column::ClosedAt, Expr::value(None::<DateTime<Utc>>))
            .col_expr(item::Column::ClosedBy, Expr::value(None::<String>))
            .col_expr(item::Column::ClosedHow, Expr::value(None::<String>));
    }
    const WAS_OPEN: &str = "status IN ('open', 'waiting')";
    update = update.col_expr(
        item::Column::ClosedAt,
        Expr::cust_with_values(
            format!("CASE WHEN {WAS_OPEN} THEN ? ELSE closed_at END"),
            [sea_orm::Value::from(now)],
        ),
    );
    update = update.col_expr(
        item::Column::ClosedBy,
        Expr::cust_with_values(
            format!("CASE WHEN {WAS_OPEN} THEN ? ELSE closed_by END"),
            [sea_orm::Value::from(closing.map(|c| c.by.as_str().to_string()))],
        ),
    );
    update.col_expr(
        item::Column::ClosedHow,
        Expr::cust_with_values(
            format!("CASE WHEN {WAS_OPEN} THEN ? ELSE closed_how END"),
            [sea_orm::Value::from(closing.map(|c| c.how.to_string()))],
        ),
    )
}

/// Write `answer` on `update`: set, or cleared (`None`).
fn answer_exprs(
    update: sea_orm::UpdateMany<item::Entity>,
    answer: Option<AnswerLink>,
) -> sea_orm::UpdateMany<item::Entity> {
    update
        .col_expr(
            item::Column::AnswerRowId,
            Expr::value(answer.and_then(|a| a.row_id)),
        )
        .col_expr(
            item::Column::AnswerState,
            Expr::value(answer.map(|a| a.state.as_str().to_string())),
        )
}

/// When a matter is due and what happens then (6.1); all `None`, it has no
/// time. `repeat` and `act_spec` are JSON.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ItemTime {
    pub due_at: Option<DateTime<Utc>>,
    pub repeat: Option<String>,
    pub at_due: Option<String>,
    pub act_spec: Option<String>,
    /// A new time: written, the matter has not fired for it. Otherwise
    /// whether it fired is left as the clock has it — never written back
    /// from an earlier read, which could undo a firing in between.
    pub fresh: bool,
}

impl ItemTime {
    /// A matter's time as it stands.
    pub fn of(item: &item::Model) -> Self {
        Self {
            due_at: item.due_at,
            repeat: item.repeat.clone(),
            at_due: item.at_due.clone(),
            act_spec: item.act_spec.clone(),
            fresh: false,
        }
    }

    /// This time moved to `due_at`, not fired yet.
    pub fn at(self, due_at: DateTime<Utc>) -> Self {
        Self {
            due_at: Some(due_at),
            fresh: true,
            ..self
        }
    }

    /// No time.
    pub fn none() -> Self {
        Self {
            fresh: true,
            ..Self::default()
        }
    }
}

pub async fn update_item(
    conn: &DatabaseConnection,
    id: i32,
    write: ItemWrite,
) -> Result<Option<item::Model>, DbError> {
    item_update_stmt(id, write).exec(conn).await?;
    get_item(conn, id).await
}

/// The update `write` makes to matter `id`. A time that is not new
/// (`fresh` false) changes its rule, what happens and what to do, never
/// its due time or whether it fired — those are the clock's.
fn item_update_stmt(id: i32, write: ItemWrite) -> sea_orm::UpdateMany<item::Entity> {
    let now = Utc::now();
    let mut update = item::Entity::update_many()
        .col_expr(item::Column::UpdatedAt, Expr::value(now))
        .filter(item::Column::Id.eq(id));
    if let Some(v) = write.status {
        update = update.col_expr(item::Column::Status, Expr::value(v));
        update = closing_exprs(update, v, write.closing, now);
    }
    match write.answer {
        Some(a) => update = answer_exprs(update, a),
        None if write.status.is_some() || write.waits_for.is_some() => {
            update = answer_exprs(update, None)
        }
        None => {}
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
    if let Some(t) = write.time {
        update = update
            .col_expr(item::Column::Repeat, Expr::value(t.repeat))
            .col_expr(item::Column::AtDue, Expr::value(t.at_due))
            .col_expr(item::Column::ActSpec, Expr::value(t.act_spec));
        if t.fresh {
            update = update
                .col_expr(item::Column::DueAt, Expr::value(t.due_at))
                .col_expr(item::Column::FiredAt, Expr::value(None::<DateTime<Utc>>));
        }
    }
    update
}

/// What becomes of a matter's open reminder cards when it changes.
#[derive(Debug, Clone)]
pub struct CardClose {
    pub to: NoticeState,
    /// The card's `data.state`.
    pub state: String,
    /// When it was put off to.
    pub until: Option<DateTime<Utc>>,
}

/// The owner's change of a matter as it can be taken back (`undo_item_op`):
/// written into the payload of the line the assistant reads about it.
#[derive(Debug, Clone)]
pub struct UndoDraft {
    /// `done`, `drop`, `later`, `snooze`.
    pub op: &'static str,
    /// Where the owner made it: `panel`, `assistant_card`, `reminder_card`,
    /// `rule_card`. Only the panel's is taken back.
    pub source: &'static str,
    /// The matter as the change read it — the row it changes, since the
    /// change is made only if the row is still that one (`expect_updated`).
    pub before: item::Model,
}

/// A message the matter waits for an answer to, taken back with the
/// owner's drop when it still can be: queued, its event never handed out.
#[derive(Debug, Clone)]
pub struct Withdraw {
    pub message_id: i32,
    pub to_bot: i32,
    /// How the matter closes, and the line the assistant reads, when it was
    /// taken back.
    pub withdrawn: (Closing, String),
    /// ... and when it could not be.
    pub kept: (Closing, String),
}

/// A change of a matter and what goes with it (`update_item_with`).
#[derive(Debug, Clone, Default)]
pub struct ItemChange {
    pub write: ItemWrite,
    /// Only if its due time is still this.
    pub expect_due: Option<Option<DateTime<Utc>>>,
    /// Only if it was not written since this.
    pub expect_updated: Option<DateTime<Utc>>,
    /// Its open reminder cards closed so.
    pub close: Option<CardClose>,
    /// The line the assistant reads about it.
    pub note: Option<NewEvent>,
    /// Recorded on the note so it can be taken back.
    pub undo: Option<UndoDraft>,
    pub withdraw: Option<Withdraw>,
}

/// What `update_item_with` wrote.
#[derive(Debug, Clone)]
pub struct ItemChanged {
    pub item: item::Model,
    /// The card rows that changed.
    pub rows: Vec<timeline::Model>,
    /// The note's event: with an undo, the token that takes the change back.
    pub note_id: Option<i32>,
    /// With `withdraw`: whether the message was taken back.
    pub withdrawn: Option<bool>,
}

/// A matter's fields an undo puts back, as JSON.
pub fn item_snapshot(m: &item::Model) -> serde_json::Value {
    serde_json::json!({
        "status": m.status,
        "waits_for": m.waits_for,
        "due_at": m.due_at,
        "repeat": m.repeat,
        "at_due": m.at_due,
        "act_spec": m.act_spec,
        "fired_at": m.fired_at,
        "closed_at": m.closed_at,
        "closed_by": m.closed_by,
        "closed_how": m.closed_how,
        "answer_row_id": m.answer_row_id,
        "answer_state": m.answer_state,
    })
}

/// Take back message `message_id` inside `txn` before its receiver started
/// on it: its event (stored under `key`) settled unread while still waiting
/// and never handed out, then the message stopped — both or neither. Its
/// first statement writes: the caller reads what it needs (`key`) before
/// the transaction, so the transaction never reads before it holds the
/// write lock.
pub(crate) async fn withdraw_in(
    txn: &sea_orm::DatabaseTransaction,
    message_id: i32,
    key: String,
    now: DateTime<Utc>,
) -> Result<bool, DbError> {
    use crate::db::entities::personal_agent_message::{self as message, MessageState};
    use sea_orm::TransactionTrait;
    let sp = txn.begin().await?;
    let taken = event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Done))
        .col_expr(event::Column::UpdatedAt, Expr::value(now))
        .filter(event::Column::SourceKey.eq(key))
        .filter(event::Column::State.eq(EventState::Pending))
        .filter(event::Column::RequeuedFrom.is_null())
        .exec(&sp)
        .await?;
    let moved = if taken.rows_affected == 1 {
        message::Entity::update_many()
            .col_expr(message::Column::State, Expr::value(MessageState::Stopped))
            .col_expr(message::Column::UpdatedAt, Expr::value(now))
            .filter(message::Column::Id.eq(message_id))
            .filter(message::Column::State.eq(MessageState::Queued))
            .exec(&sp)
            .await?
            .rows_affected
    } else {
        0
    };
    if moved == 1 {
        sp.commit().await?;
        Ok(true)
    } else {
        sp.rollback().await?;
        Ok(false)
    }
}

/// Change `bot`'s matter `id` as `change.write` says, in one transaction
/// with what goes with it: its open reminder cards closed (`close`), a
/// message it waits on taken back (`withdraw`), the line the assistant
/// reads about it queued (`note`) — with, for the owner's change, what
/// takes it back (`undo`). Only if its due time is still `expect_due` and
/// it was not written since `expect_updated`, when those are given: a
/// change worked out from an earlier read never lands on a matter that
/// moved meanwhile. `None` when it had (or is not this assistant's).
pub async fn update_item_with(
    conn: &DatabaseConnection,
    bot: i32,
    id: i32,
    change: ItemChange,
) -> Result<Option<ItemChanged>, DbError> {
    use sea_orm::TransactionTrait;
    require_bot(bot)?;
    let ItemChange {
        mut write,
        expect_due,
        expect_updated,
        close,
        mut note,
        undo,
        withdraw,
    } = change;
    let note_key = match &note {
        Some(n) => Some(scoped_source_key(conn, bot, &n.source_key).await?),
        None => None,
    };
    // Read before the transaction: inside it, the first statement writes,
    // so it holds the write lock before it reads anything (WAL refuses a
    // write from a snapshot another write overtook).
    let withdraw_key = match &withdraw {
        Some(w) => Some(
            super::personal_agent_message_service::stored_event_key(conn, w.to_bot, w.message_id)
                .await?,
        ),
        None => None,
    };
    let now = Utc::now();
    let txn = conn.begin().await?;
    let mut withdrawn = None;
    if let (Some(w), Some(key)) = (&withdraw, withdraw_key) {
        // Tried first, its first statement a write: the matter's CAS below
        // rolls this back with the rest when it misses.
        let took = withdraw_in(&txn, w.message_id, key, now).await?;
        let (closing, line) = if took { &w.withdrawn } else { &w.kept };
        write.closing = Some(*closing);
        if let Some(n) = note.as_mut() {
            n.summary = line.clone();
        }
        withdrawn = Some(took);
    }
    let mut update = item_update_stmt(id, write).filter(item::Column::BotId.eq(bot));
    update = match expect_due {
        Some(Some(d)) => update.filter(item::Column::DueAt.eq(d)),
        Some(None) => update.filter(item::Column::DueAt.is_null()),
        None => update,
    };
    if let Some(at) = expect_updated {
        update = update.filter(item::Column::UpdatedAt.eq(at));
    }
    if update.exec(&txn).await?.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(None);
    }
    let mut rows = Vec::new();
    let mut cards = Vec::new();
    if let Some(close) = close {
        let open = notice::Entity::find()
            .filter(notice::Column::BotId.eq(bot))
            .filter(notice::Column::Kind.eq(NoticeKind::Reminder))
            .filter(notice::Column::SubjectKey.eq(reminder_subject(id)))
            .filter(notice::Column::State.eq(NoticeState::Open))
            .all(&txn)
            .await?;
        for n in open {
            notice::Entity::update_many()
                .col_expr(notice::Column::State, Expr::value(close.to))
                .col_expr(notice::Column::ActedAt, Expr::value(Some(now)))
                .col_expr(notice::Column::UpdatedAt, Expr::value(now))
                .filter(notice::Column::Id.eq(n.id))
                .exec(&txn)
                .await?;
            let Some(row_id) = n.timeline_id else {
                cards.push(serde_json::json!({
                    "notice_id": n.id,
                    "from_state": NoticeState::Open,
                    "to_state": close.to,
                    "row_id": null,
                }));
                continue;
            };
            let Some(row) = timeline::Entity::find_by_id(row_id).one(&txn).await? else {
                continue;
            };
            let mut data = row
                .data
                .as_deref()
                .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                .filter(serde_json::Value::is_object)
                .unwrap_or_else(|| serde_json::json!({}));
            cards.push(serde_json::json!({
                "notice_id": n.id,
                "from_state": NoticeState::Open,
                "to_state": close.to,
                "row_id": row_id,
                "row_before": {
                    "state": data.get("state").cloned().unwrap_or(serde_json::Value::Null),
                    "until": data.get("until").cloned().unwrap_or(serde_json::Value::Null),
                    "error": data.get("error").cloned().unwrap_or(serde_json::Value::Null),
                    "error_key": data.get("error_key").cloned().unwrap_or(serde_json::Value::Null),
                    "error_params": data.get("error_params").cloned().unwrap_or(serde_json::Value::Null),
                },
            }));
            data["state"] = close.state.clone().into();
            data["until"] = close
                .until
                .map(|u| serde_json::json!(u))
                .unwrap_or(serde_json::Value::Null);
            data["error"] = serde_json::Value::Null;
            data["error_key"] = serde_json::Value::Null;
            data["error_params"] = serde_json::Value::Null;
            timeline::Entity::update_many()
                .col_expr(timeline::Column::Data, Expr::value(Some(data.to_string())))
                .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
                .filter(timeline::Column::Id.eq(row_id))
                .exec(&txn)
                .await?;
            if let Some(r) = timeline::Entity::find_by_id(row_id).one(&txn).await? {
                rows.push(r);
            }
        }
    }
    let Some(item) = item::Entity::find_by_id(id).one(&txn).await? else {
        txn.rollback().await?;
        return Ok(None);
    };
    let mut note_id = None;
    if let (Some(n), Some(key)) = (note, note_key) {
        let mut payload = n.payload;
        if let Some(u) = &undo {
            let payload = payload.get_or_insert_with(|| serde_json::json!({ "item_id": id }));
            payload["undo"] = serde_json::json!({
                "op": u.op,
                "source": u.source,
                "message": withdraw.as_ref().map(|w| serde_json::json!({
                    "id": w.message_id,
                    "to_bot_id": w.to_bot,
                    "outcome": if withdrawn == Some(true) { "withdrawn" } else { "stopped_waiting" },
                })),
                "before": item_snapshot(&u.before),
                "after": {
                    "updated_at": item.updated_at,
                    "status": item.status,
                    "waits_for": item.waits_for,
                    "due_at": item.due_at,
                    "fired_at": item.fired_at,
                },
                "cards": cards,
            });
        }
        let made = event::ActiveModel {
            id: NotSet,
            kind: Set(n.kind),
            source_key: Set(key),
            coalesce_key: Set(n.coalesce_key),
            summary: Set(n.summary),
            payload: Set(payload.map(|p| p.to_string())),
            wake: Set(n.wake),
            state: Set(EventState::Pending),
            batch_id: Set(None),
            requeues: Set(0),
            requeued_from: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
            bot_id: Set(Some(bot)),
            origin_bot_id: Set(n.lineage.origin_bot_id),
            origin_row_id: Set(n.lineage.origin_row_id),
            thread_id: Set(n.lineage.thread_id),
        }
        .insert(&txn)
        .await?;
        note_id = Some(made.id);
    }
    txn.commit().await?;
    Ok(Some(ItemChanged {
        item,
        rows,
        note_id,
        withdrawn,
    }))
}

/// `bot`'s matters due by `now` with something to happen then: open or
/// waiting, a due time at or before `now`, and either not fired for it yet
/// (earliest first, a batch at a time — each fires and leaves the set) or
/// repeating, so its next time may have come. A one-off that fired waits
/// for the owner and is not read again.
pub async fn due_items(
    conn: &DatabaseConnection,
    bot: i32,
    now: DateTime<Utc>,
) -> Result<Vec<item::Model>, DbError> {
    use sea_orm::Condition;
    let due = || {
        item::Entity::find()
            .filter(item::Column::BotId.eq(bot))
            .filter(item::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
            .filter(item::Column::DueAt.is_not_null())
            .filter(item::Column::DueAt.lte(now))
            .filter(item::Column::AtDue.is_not_null())
    };
    let mut out = due()
        .filter(
            Condition::any()
                .add(item::Column::FiredAt.is_null())
                .add(Expr::col(item::Column::FiredAt).lt(Expr::col(item::Column::DueAt))),
        )
        .order_by_asc(item::Column::DueAt)
        .order_by_asc(item::Column::Id)
        .limit(200)
        .all(conn)
        .await?;
    out.extend(
        due()
            .filter(item::Column::Repeat.is_not_null())
            .filter(item::Column::FiredAt.is_not_null())
            .filter(Expr::col(item::Column::FiredAt).gte(Expr::col(item::Column::DueAt)))
            .order_by_asc(item::Column::Id)
            .all(conn)
            .await?,
    );
    Ok(out)
}

/// An assistant's repeating matters waiting for a time still ahead of
/// `now`, not fired for it — the ones a change of the owner's zone moves
/// (1.12).
pub async fn repeating_items(
    conn: &DatabaseConnection,
    bot: i32,
    now: DateTime<Utc>,
) -> Result<Vec<item::Model>, DbError> {
    use sea_orm::Condition;
    Ok(item::Entity::find()
        .filter(item::Column::BotId.eq(bot))
        .filter(item::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
        .filter(item::Column::Repeat.is_not_null())
        .filter(item::Column::DueAt.gt(now))
        .filter(
            Condition::any()
                .add(item::Column::FiredAt.is_null())
                .add(Expr::col(item::Column::FiredAt).lt(Expr::col(item::Column::DueAt))),
        )
        .order_by_asc(item::Column::Id)
        .all(conn)
        .await?)
}

/// How a matter fires (6.1): its occurrence and what it leaves behind.
#[derive(Debug, Clone)]
pub struct ItemFire {
    /// The matter, as the clock read it: it fires only if it still is so.
    pub item_id: i32,
    pub seen_due: DateTime<Utc>,
    pub seen_fired: Option<DateTime<Utc>>,
    /// The occurrence that fires (a repeating matter that missed several
    /// fires the latest of them).
    pub due_at: DateTime<Utc>,
    pub fired_at: DateTime<Utc>,
    pub waits_for: Option<WaitsFor>,
    /// The card it raises.
    pub notice: NewNotice,
    pub notice_state: NoticeState,
    pub row: NewRow,
    /// The event for the assistant: a wake-up for one it is to do (its card
    /// numbered by the row), a note that the owner was reminded.
    pub event: NewEvent,
    pub event_numbers_row: bool,
}

/// What firing a matter wrote.
#[derive(Debug, Clone)]
pub struct Fired {
    pub notice: notice::Model,
    pub row: timeline::Model,
    /// Reminder cards of the same matter still open from an earlier
    /// occurrence, now expired.
    pub expired: Vec<notice::Model>,
}

/// Fire a matter, in one transaction: the matter takes the occurrence and
/// is marked fired — only if it is still as the clock read it, so a matter
/// the owner or the assistant changed meanwhile, or another tick fired, is
/// left alone (`None`) — its card and its event are written, and its
/// cards still open from an earlier occurrence expire.
pub async fn fire_item(
    conn: &DatabaseConnection,
    bot: i32,
    fire: ItemFire,
) -> Result<Option<Fired>, DbError> {
    use sea_orm::TransactionTrait;
    require_bot(bot)?;
    let source_key = scoped_source_key(conn, bot, &fire.event.source_key).await?;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let mut claim = item::Entity::update_many()
        .col_expr(item::Column::DueAt, Expr::value(fire.due_at))
        .col_expr(item::Column::FiredAt, Expr::value(fire.fired_at))
        .col_expr(item::Column::WaitsFor, Expr::value(fire.waits_for))
        .col_expr(item::Column::UpdatedAt, Expr::value(now))
        .filter(item::Column::Id.eq(fire.item_id))
        .filter(item::Column::BotId.eq(bot))
        .filter(item::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
        .filter(item::Column::DueAt.eq(fire.seen_due));
    claim = match fire.seen_fired {
        Some(f) => claim.filter(item::Column::FiredAt.eq(f)),
        None => claim.filter(item::Column::FiredAt.is_null()),
    };
    if claim.exec(&txn).await?.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(None);
    }
    let subject = fire.notice.subject_key.clone();
    let stale = match subject.as_deref() {
        Some(subject) => {
            notice::Entity::find()
                .filter(notice::Column::BotId.eq(bot))
                .filter(notice::Column::Kind.eq(NoticeKind::Reminder))
                .filter(notice::Column::SubjectKey.eq(subject))
                .filter(notice::Column::State.eq(NoticeState::Open))
                .all(&txn)
                .await?
        }
        None => Vec::new(),
    };
    if !stale.is_empty() {
        notice::Entity::update_many()
            .col_expr(notice::Column::State, Expr::value(NoticeState::Expired))
            .col_expr(notice::Column::ActedAt, Expr::value(Some(now)))
            .col_expr(notice::Column::UpdatedAt, Expr::value(now))
            .filter(notice::Column::Id.is_in(stale.iter().map(|n| n.id).collect::<Vec<_>>()))
            .filter(notice::Column::State.eq(NoticeState::Open))
            .exec(&txn)
            .await?;
    }
    let ev = event::ActiveModel {
        id: NotSet,
        kind: Set(fire.event.kind),
        source_key: Set(source_key),
        coalesce_key: Set(fire.event.coalesce_key),
        summary: Set(fire.event.summary),
        payload: Set(fire.event.payload.map(|p| p.to_string())),
        wake: Set(fire.event.wake),
        state: Set(EventState::Pending),
        batch_id: Set(None),
        requeues: Set(0),
        requeued_from: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        bot_id: Set(Some(bot)),
        origin_bot_id: Set(fire.event.lineage.origin_bot_id),
        origin_row_id: Set(fire.event.lineage.origin_row_id),
        thread_id: Set(fire.event.lineage.thread_id),
    }
    .insert(&txn)
    .await?;
    let made = notice::ActiveModel {
        id: NotSet,
        bot_id: Set(Some(bot)),
        kind: Set(fire.notice.kind),
        subject_key: Set(fire.notice.subject_key),
        level: Set(fire.notice.level),
        state: Set(fire.notice_state),
        timeline_id: Set(None),
        batch_id: Set(fire.notice.batch_id),
        payload: Set(fire.notice.payload.to_string()),
        notified_at: Set(None),
        acted_at: Set((fire.notice_state != NoticeState::Open).then_some(now)),
        expires_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await?;
    let mut row = fire.row;
    row.ref_id = Some(made.id.to_string());
    if fire.event_numbers_row {
        row.event_id = Some(ev.id);
    }
    let card = row.into_active(bot, now).insert(&txn).await?;
    notice::Entity::update_many()
        .col_expr(notice::Column::TimelineId, Expr::value(card.id))
        .filter(notice::Column::Id.eq(made.id))
        .exec(&txn)
        .await?;
    txn.commit().await?;
    Ok(Some(Fired {
        notice: notice::Model {
            timeline_id: Some(card.id),
            ..made
        },
        row: card,
        expired: stale,
    }))
}

/// The subject a matter's reminder cards are filed under.
pub fn reminder_subject(item_id: i32) -> String {
    format!("item:{item_id}")
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

/// Whether assistant `bot` has a matter open that it works on — not one
/// that only waits to be mentioned (6.8).
pub async fn has_open_matters(conn: &DatabaseConnection, bot: i32) -> Result<bool, DbError> {
    Ok(item::Entity::find()
        .filter(item::Column::BotId.eq(bot))
        .filter(item::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
        .filter(item::Column::Kind.ne(ItemKind::WhenMentioned))
        .one(conn)
        .await?
        .is_some())
}

/// Every open `when_mentioned` matter, of every assistant, oldest first
/// (6.8).
pub async fn open_mentions(conn: &DatabaseConnection) -> Result<Vec<item::Model>, DbError> {
    Ok(item::Entity::find()
        .filter(item::Column::Kind.eq(ItemKind::WhenMentioned))
        .filter(item::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
        .order_by_asc(item::Column::Id)
        .all(conn)
        .await?)
}

/// Move matter `id`'s mention from `was` to `now`, closing it as `status`
/// when given — only while it is open and still reads `was`, so two
/// messages never both count the same time. Whether it moved.
pub async fn swap_mention(
    conn: &DatabaseConnection,
    id: i32,
    was: &str,
    now: &str,
    status: Option<ItemStatus>,
) -> Result<bool, DbError> {
    let mut update = item::Entity::update_many()
        .col_expr(item::Column::Mention, Expr::value(Some(now.to_string())))
        .col_expr(item::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(item::Column::Id.eq(id))
        .filter(item::Column::Mention.eq(was))
        .filter(item::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]));
    if let Some(s) = status {
        // Closed by its mentions: used up (done) or past its end (dropped).
        let how = if s == ItemStatus::Done { "used_up" } else { "expired" };
        update = update.col_expr(item::Column::Status, Expr::value(s));
        update = closing_exprs(update, s, Some(Closing::new(Closer::Codeg, how)), Utc::now());
    }
    Ok(update.exec(conn).await?.rows_affected > 0)
}

/// A new `when_mentioned` matter of assistant `bot`: open, its reminder
/// the summary, its keywords and how it comes up in `mention` (6.8).
pub async fn create_mention_item(
    conn: &DatabaseConnection,
    bot: i32,
    summary: String,
    origin_timeline_id: Option<i32>,
    mention: String,
) -> Result<item::Model, DbError> {
    require_bot(bot)?;
    let now = Utc::now();
    Ok(item::ActiveModel {
        id: NotSet,
        kind: Set(ItemKind::WhenMentioned),
        dispatch_id: Set(None),
        status: Set(ItemStatus::Open),
        waits_for: Set(None),
        summary: Set(summary),
        on_done: Set(None),
        origin_timeline_id: Set(origin_timeline_id),
        created_at: Set(now),
        updated_at: Set(now),
        bot_id: Set(Some(bot)),
        due_at: Set(None),
        repeat: Set(None),
        at_due: Set(None),
        act_spec: Set(None),
        fired_at: Set(None),
        mention: Set(Some(mention)),
        closed_at: Set(None),
        closed_by: Set(None),
        closed_how: Set(None),
        answer_row_id: Set(None),
        answer_state: Set(None),
    }
    .insert(conn)
    .await?)
}

/// Set matter `id`'s mention (its keywords and how it comes up).
pub async fn set_mention(conn: &DatabaseConnection, id: i32, mention: &str) -> Result<(), DbError> {
    item::Entity::update_many()
        .col_expr(
            item::Column::Mention,
            Expr::value(Some(mention.to_string())),
        )
        .col_expr(item::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(item::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

// ── dispatches ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct NewDispatch {
    /// The assistant dispatching it.
    pub bot_id: i32,
    pub mode: DispatchMode,
    pub work_snapshot_json: String,
    pub folder_id: Option<i32>,
    pub deliverable: Option<String>,
    pub title: String,
    pub prompt: String,
    pub origin_batch_id: Option<i32>,
    pub on_done: Option<String>,
    /// Where the chain it belongs to started, the thread it is on, and the
    /// input it was dispatched for.
    pub lineage: Lineage,
    /// What done looks like (7.5).
    pub done_when: Option<String>,
    /// A round codeg starts to fix a watched pull request (7.4), as JSON.
    pub pr_fix: Option<String>,
    /// codeg's own check of other work (7.5).
    pub is_check: bool,
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
    create_dispatch_on(conn, new).await
}

/// [`create_dispatch`] on any connection — a transaction that writes what
/// the dispatch is for with it.
pub async fn create_dispatch_on<C: ConnectionTrait>(
    conn: &C,
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
        work_snapshot: Set(new.work_snapshot_json),
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
        done_when: Set(new.done_when),
        pr_fix: Set(new.pr_fix),
        is_check: Set(new.is_check),
        replaces_id: Set(None),
        replaces_run_seq: Set(None),
        replaced_by: Set(None),
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
pub(crate) async fn colliding_entry(
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

/// A dispatch that takes over failed work (B1): written in the same
/// transaction as the dispatch, or none of it is.
#[derive(Debug, Clone)]
pub struct Handover {
    /// The failed (or stopped) work taken over.
    pub predecessor: i32,
    /// Its board task and the run of it taken over, when it is a task's.
    pub task: Option<(i32, i32)>,
    /// The new work's matter, made here rather than after the commit: the
    /// work is followed by one matter or the other at every moment.
    pub summary: String,
    pub on_done: Option<String>,
}

/// Record a dispatch together with its ledger entry — and, for one a card
/// runs, the card's settling; for one that takes over failed work, the
/// handing over — in one transaction: the entry is committed with the
/// dispatch it made, or none of it exists. An insert that collides with an
/// entry on record (same batch and key, or same operation) makes nothing
/// and hands that entry back. Without a `slot` (a call outside any ledger)
/// only the rest is written.
///
/// Handing over: the predecessor is claimed (`replaced_by`) only while it
/// is this assistant's, unclaimed and failed, interrupted or stopped — and,
/// a task's, while its board task is still failed or canceled in the run
/// taken over; its matter is closed and the new work's made. A claim that
/// does not hold refuses the whole write ([`DbError::Conflict`]).
pub async fn create_dispatch_ledgered(
    conn: &DatabaseConnection,
    new: NewDispatch,
    slot: Option<&LedgerSlot>,
    payload: Option<serde_json::Value>,
    card: Option<CardSettle>,
    handover: Option<&Handover>,
) -> Result<Ledgered<dispatch::Model>, DbError> {
    use sea_orm::TransactionTrait;
    require_bot(new.bot_id)?;
    let bot = new.bot_id;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let mut active = dispatch_active(new);
    if let Some(h) = handover {
        active.replaces_id = Set(Some(h.predecessor));
        active.replaces_run_seq = Set(h.task.map(|(_, run)| run));
    }
    let made = active.insert(&txn).await?;
    if let Some(h) = handover {
        if let Err(e) = hand_over_in(&txn, bot, &made, h, now).await {
            let _ = txn.rollback().await;
            return Err(match e {
                // Who holds it, read after the rollback.
                DbError::Conflict(_) => refused_handover(conn, h).await,
                e => e,
            });
        }
    }
    let Some(slot) = slot else {
        if let Some(card) = card {
            settle_card_in(&txn, card, made.id, now).await?;
        }
        txn.commit().await?;
        return Ok(Ledgered::New(made));
    };
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
        settle_card_in(&txn, card, made.id, now).await?;
    }
    txn.commit().await?;
    Ok(Ledgered::New(made))
}

/// A card settled with what it ran: acting → acted, its row's data with the
/// dispatch made written in.
async fn settle_card_in(
    txn: &sea_orm::DatabaseTransaction,
    card: CardSettle,
    made: i32,
    now: DateTime<Utc>,
) -> Result<(), DbError> {
    let moved = notice::Entity::update_many()
        .col_expr(notice::Column::State, Expr::value(NoticeState::Acted))
        .col_expr(notice::Column::ActedAt, Expr::value(now))
        .col_expr(notice::Column::UpdatedAt, Expr::value(now))
        .filter(notice::Column::Id.eq(card.notice_id))
        .filter(notice::Column::State.eq(NoticeState::Acting))
        .exec(txn)
        .await?;
    if moved.rows_affected != 1 {
        return Err(DbError::Conflict("the card is not being acted on".into()));
    }
    let mut data = card.row_data;
    if let Some(map) = data.as_object_mut() {
        map.insert("state".into(), "acted".into());
        map.insert("result".into(), serde_json::json!({ "dispatch_id": made }));
        map.insert("error".into(), serde_json::Value::Null);
    }
    timeline::Entity::update_many()
        .col_expr(timeline::Column::Data, Expr::value(data.to_string()))
        .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
        .filter(timeline::Column::Id.eq(card.row_id))
        .exec(txn)
        .await?;
    Ok(())
}

/// The handing over in `txn` (see [`create_dispatch_ledgered`]).
async fn hand_over_in(
    txn: &sea_orm::DatabaseTransaction,
    bot: i32,
    made: &dispatch::Model,
    h: &Handover,
    now: DateTime<Utc>,
) -> Result<(), DbError> {
    use crate::db::entities::work_task::{self as work_task, WorkTaskStatus};
    let claimed = dispatch::Entity::update_many()
        .col_expr(dispatch::Column::ReplacedBy, Expr::value(made.id))
        .col_expr(dispatch::Column::UpdatedAt, Expr::value(now))
        .filter(dispatch::Column::Id.eq(h.predecessor))
        .filter(dispatch::Column::BotId.eq(bot))
        .filter(dispatch::Column::ReplacedBy.is_null())
        .filter(dispatch::Column::State.is_in([
            DispatchState::Failed,
            DispatchState::Interrupted,
            DispatchState::Canceled,
        ]))
        .exec(txn)
        .await?;
    if claimed.rows_affected != 1 {
        return Err(DbError::Conflict("not claimed".into()));
    }
    // A follow-up of it on its way (recorded, not settled): it goes on with
    // the work itself — the follow-up checks again once its record is in.
    let following = action::Entity::find()
        .filter(action::Column::Kind.eq("followup"))
        .filter(action::Column::State.eq(ActionState::Prepared))
        .filter(action::Column::Payload.like(format!("{{\"dispatch_id\":{},%", h.predecessor)))
        .count(txn)
        .await?;
    if following > 0 {
        return Err(DbError::Conflict("followed up".into()));
    }
    if let Some((task, run)) = h.task {
        let still = work_task::Entity::find()
            .filter(work_task::Column::Id.eq(task))
            .filter(work_task::Column::RunSeq.eq(run))
            .filter(work_task::Column::Status.is_in([WorkTaskStatus::Failed, WorkTaskStatus::Canceled]))
            .filter(work_task::Column::DeletedAt.is_null())
            .count(txn)
            .await?;
        if still != 1 {
            return Err(DbError::Conflict("its task moved on".into()));
        }
    }
    closing_exprs(
        item::Entity::update_many(),
        ItemStatus::Done,
        Some(Closing::new(Closer::Codeg, "replaced")),
        now,
    )
        .col_expr(item::Column::Status, Expr::value(ItemStatus::Done))
        .col_expr(item::Column::WaitsFor, Expr::value(Option::<WaitsFor>::None))
        .col_expr(item::Column::UpdatedAt, Expr::value(now))
        .filter(item::Column::DispatchId.eq(h.predecessor))
        .filter(item::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
        .exec(txn)
        .await?;
    item::ActiveModel {
        id: NotSet,
        kind: Set(ItemKind::Dispatch),
        dispatch_id: Set(Some(made.id)),
        status: Set(ItemStatus::Open),
        waits_for: Set(Some(WaitsFor::External)),
        summary: Set(h.summary.clone()),
        on_done: Set(h.on_done.clone()),
        origin_timeline_id: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        bot_id: Set(Some(bot)),
        due_at: Set(None),
        repeat: Set(None),
        at_due: Set(None),
        act_spec: Set(None),
        fired_at: Set(None),
        mention: Set(None),
        closed_at: Set(None),
        closed_by: Set(None),
        closed_how: Set(None),
        answer_row_id: Set(None),
        answer_state: Set(None),
    }
    .insert(txn)
    .await?;
    Ok(())
}

/// Let go of the claim `by` holds on dispatch `id` (B1: the owner ran its
/// task again since), and — in the same transaction — open its matter again
/// as `reopen` says when it was closed: once, whether this write did it.
pub async fn release_claim(
    conn: &DatabaseConnection,
    id: i32,
    by: i32,
    reopen: Option<(ItemStatus, WaitsFor)>,
) -> Result<bool, DbError> {
    use sea_orm::TransactionTrait;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = dispatch::Entity::update_many()
        .col_expr(dispatch::Column::ReplacedBy, Expr::value(Option::<i32>::None))
        .col_expr(dispatch::Column::UpdatedAt, Expr::value(now))
        .filter(dispatch::Column::Id.eq(id))
        .filter(dispatch::Column::ReplacedBy.eq(by))
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    if let Some((status, waits_for)) = reopen {
        closing_exprs(item::Entity::update_many(), status, None, now)
            .col_expr(item::Column::Status, Expr::value(status))
            .col_expr(item::Column::WaitsFor, Expr::value(Some(waits_for)))
            .col_expr(item::Column::UpdatedAt, Expr::value(now))
            .filter(item::Column::DispatchId.eq(id))
            .filter(item::Column::Status.eq(ItemStatus::Done))
            .exec(&txn)
            .await?;
    }
    txn.commit().await?;
    Ok(true)
}

/// Whether a follow-up of dispatch `p` is recorded and not settled.
async fn pending_followup(conn: &DatabaseConnection, p: i32) -> bool {
    action::Entity::find()
        .filter(action::Column::Kind.eq("followup"))
        .filter(action::Column::State.eq(ActionState::Prepared))
        .filter(action::Column::Payload.like(format!("{{\"dispatch_id\":{p},%")))
        .count(conn)
        .await
        .is_ok_and(|n| n > 0)
}

/// A dispatch's matter written as its progress has it — unless, by the
/// time the write holds the lock, other work took the dispatch over in the
/// run it is in (B1): then nothing is written. The write goes first, so a
/// handing over is wholly before it (and seen) or wholly after (and closes
/// the matter itself).
pub async fn update_item_unless_taken_over(
    conn: &DatabaseConnection,
    item_id: i32,
    dispatch_id: i32,
    write: ItemWrite,
) -> Result<bool, DbError> {
    use crate::db::entities::work_task;
    use sea_orm::TransactionTrait;
    let txn = conn.begin().await?;
    item_update_stmt(item_id, write).exec(&txn).await?;
    let d = dispatch::Entity::find_by_id(dispatch_id).one(&txn).await?;
    let taken = match d.and_then(|d| d.replaced_by.map(|by| (by, d.work_task_id))) {
        None => false,
        Some((by, task)) => {
            let run = dispatch::Entity::find_by_id(by)
                .one(&txn)
                .await?
                .and_then(|n| n.replaces_run_seq);
            match (run, task) {
                (Some(run), Some(t)) => work_task::Entity::find_by_id(t)
                    .one(&txn)
                    .await?
                    .is_none_or(|t| t.run_seq == run),
                _ => true,
            }
        }
    };
    if taken {
        txn.rollback().await?;
        return Ok(false);
    }
    txn.commit().await?;
    Ok(true)
}

/// Why a handing over was refused, in words for the assistant.
async fn refused_handover(conn: &DatabaseConnection, h: &Handover) -> DbError {
    let p = h.predecessor;
    match get_dispatch(conn, p).await {
        Ok(Some(d)) => match d.replaced_by {
            Some(by) => DbError::Conflict(format!("dispatch #{p} was taken over by #{by} already")),
            None if !matches!(
                d.state,
                DispatchState::Failed | DispatchState::Interrupted | DispatchState::Canceled
            ) => DbError::Conflict(format!(
                "dispatch #{p} is {} now, not failed or stopped: nothing to take over",
                sea_orm::ActiveEnum::to_value(&d.state)
            )),
            None if pending_followup(conn, p).await => DbError::Conflict(format!(
                "dispatch #{p} has a follow-up on its way; let it run, or wait for it"
            )),
            None => DbError::Conflict(format!(
                "dispatch #{p}'s board task was run again: that run is not yours to take over"
            )),
        },
        _ => DbError::Conflict(format!("dispatch #{p} does not exist")),
    }
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

/// [`move_notice`] and the card row's data written with it, in one
/// transaction: both or neither.
pub async fn move_notice_with_data(
    conn: &DatabaseConnection,
    id: i32,
    from: &[NoticeState],
    to: NoticeState,
    row_id: i32,
    data: &serde_json::Value,
) -> Result<bool, DbError> {
    use sea_orm::TransactionTrait;
    let txn = conn.begin().await?;
    let now = Utc::now();
    let acted_at: Option<DateTime<Utc>> = (to != NoticeState::Open).then_some(now);
    let res = notice::Entity::update_many()
        .col_expr(notice::Column::State, Expr::value(to))
        .col_expr(notice::Column::ActedAt, Expr::value(acted_at))
        .col_expr(notice::Column::UpdatedAt, Expr::value(now))
        .filter(notice::Column::Id.eq(id))
        .filter(notice::Column::State.is_in(from.to_vec()))
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    timeline::Entity::update_many()
        .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
        .col_expr(timeline::Column::Data, Expr::value(Some(data.to_string())))
        .filter(timeline::Column::Id.eq(row_id))
        .exec(&txn)
        .await?;
    txn.commit().await?;
    Ok(true)
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

/// Assistant `bot`'s newest card of `kind`, whatever came of it.
pub async fn latest_notice_of(
    conn: &DatabaseConnection,
    bot: i32,
    kind: NoticeKind,
) -> Result<Option<notice::Model>, DbError> {
    Ok(notice::Entity::find()
        .filter(notice::Column::BotId.eq(bot))
        .filter(notice::Column::Kind.eq(kind))
        .order_by_desc(notice::Column::Id)
        .one(conn)
        .await?)
}

/// Every assistant's cards of `kind` made since `since`, in any state.
pub async fn notices_made_since(
    conn: &DatabaseConnection,
    kind: NoticeKind,
    since: DateTime<Utc>,
) -> Result<Vec<notice::Model>, DbError> {
    Ok(notice::Entity::find()
        .filter(notice::Column::Kind.eq(kind))
        .filter(notice::Column::CreatedAt.gte(since))
        .order_by_asc(notice::Column::Id)
        .all(conn)
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
    /// The pull-request fix round it carries (7.4), or none.
    pub pr_fix: Option<Option<String>>,
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
    if let Some(v) = write.pr_fix {
        update = update.col_expr(dispatch::Column::PrFix, Expr::value(v));
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

/// An assistant's own work that got done, the last finished first (codeg's
/// checks left out), up to `limit`.
pub async fn recent_done(
    conn: &DatabaseConnection,
    bot: i32,
    limit: u64,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::BotId.eq(bot))
        .filter(dispatch::Column::State.eq(DispatchState::Completed))
        .filter(dispatch::Column::IsCheck.eq(false))
        .order_by(
            Expr::cust(r#"COALESCE("finished_at", "updated_at")"#),
            sea_orm::Order::Desc,
        )
        .order_by_desc(dispatch::Column::Id)
        .limit(limit)
        .all(conn)
        .await?)
}

/// An assistant's own work that got done since `since` (by when it
/// finished, wherever it was handed out: work handed out before and
/// finished since counts), codeg's checks left out — the first finished
/// first, up to `limit`.
pub async fn done_since(
    conn: &DatabaseConnection,
    bot: i32,
    since: DateTime<Utc>,
    limit: u64,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::BotId.eq(bot))
        .filter(dispatch::Column::State.eq(DispatchState::Completed))
        .filter(dispatch::Column::IsCheck.eq(false))
        .filter(
            Condition::any()
                .add(dispatch::Column::FinishedAt.gte(since))
                .add(
                    Condition::all()
                        .add(dispatch::Column::FinishedAt.is_null())
                        .add(dispatch::Column::UpdatedAt.gte(since)),
                ),
        )
        .order_by(
            Expr::cust(r#"COALESCE("finished_at", "updated_at")"#),
            sea_orm::Order::Asc,
        )
        .order_by_asc(dispatch::Column::Id)
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

/// Every assistant's dispatches made since `since` for a request whose
/// start is known (7.8), oldest first.
pub async fn dispatches_with_origin_since(
    conn: &DatabaseConnection,
    since: DateTime<Utc>,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::CreatedAt.gte(since))
        .filter(dispatch::Column::OriginRowId.is_not_null())
        .filter(dispatch::Column::OriginBotId.is_not_null())
        .order_by_asc(dispatch::Column::Id)
        .all(conn)
        .await?)
}

/// Dispatches by id, whichever assistant's, oldest first.
pub async fn dispatches_by_id_any(
    conn: &DatabaseConnection,
    ids: &[i32],
) -> Result<Vec<dispatch::Model>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::Id.is_in(ids.iter().copied().take(200).collect::<Vec<_>>()))
        .order_by_asc(dispatch::Column::Id)
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

// ── asks (7.3.1) ────────────────────────────────────────────────────────────

/// The event kind telling an assistant about an executor's question or plan
/// approval.
pub const ASK_EVENT: &str = "ask";

/// The states of an ask card a page shows as still open: the assistant is
/// answering it, the owner is, or an answer is on its way.
pub const ASK_OPEN_STATES: &[&str] = &["asking", "forwarded", "submitting"];

fn ask_state_filter(states: &[&str]) -> String {
    let list = states
        .iter()
        .map(|s| format!("'{}'", s.replace('\'', "")))
        .collect::<Vec<_>>()
        .join(",");
    format!("json_extract(data, '$.state') IN ({list})")
}

/// Raise an ask card: its notice, its timeline row and the event that tells
/// its assistant (`event`; its source key is made from the notice's id, so
/// one wait is told once), in one transaction. The event's payload gets the
/// card's `ask_id` and `row_id`; the row's `ref_id` is the notice's id.
pub async fn create_ask(
    conn: &DatabaseConnection,
    bot: i32,
    new: NewNotice,
    mut row: NewRow,
    event: NewEvent,
) -> Result<(notice::Model, timeline::Model, event::Model), DbError> {
    use sea_orm::TransactionTrait;
    require_bot(bot)?;
    let prefix = scoped_source_key(conn, bot, "ask:").await?;
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
    let mut payload = event.payload.unwrap_or_else(|| serde_json::json!({}));
    if let Some(map) = payload.as_object_mut() {
        map.insert("ask_id".into(), made.id.into());
        map.insert("row_id".into(), card.id.into());
    }
    let ev = event::ActiveModel {
        id: NotSet,
        kind: Set(event.kind),
        source_key: Set(format!("{prefix}{}", made.id)),
        coalesce_key: Set(event.coalesce_key),
        summary: Set(event.summary),
        payload: Set(Some(payload.to_string())),
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
    .await?;
    timeline::Entity::update_many()
        .col_expr(timeline::Column::EventId, Expr::value(ev.id))
        .filter(timeline::Column::Id.eq(card.id))
        .exec(&txn)
        .await?;
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
    let card = timeline::Model {
        event_id: Some(ev.id),
        ..card
    };
    Ok((made, card, ev))
}

/// The ask card raised for one underlying request (`subject`: connection
/// and request id), whoever's it is.
pub async fn ask_by_subject(
    conn: &DatabaseConnection,
    subject: &str,
) -> Result<Option<notice::Model>, DbError> {
    Ok(notice::Entity::find()
        .filter(notice::Column::Kind.eq(NoticeKind::Ask))
        .filter(notice::Column::SubjectKey.eq(subject))
        .order_by_desc(notice::Column::Id)
        .one(conn)
        .await?)
}

/// The ask cards of `bot` still open (any bot's with `None`), oldest first.
pub async fn open_asks(
    conn: &DatabaseConnection,
    bot: Option<i32>,
) -> Result<Vec<notice::Model>, DbError> {
    let mut q = notice::Entity::find()
        .filter(notice::Column::Kind.eq(NoticeKind::Ask))
        .filter(notice::Column::State.eq(NoticeState::Open));
    if let Some(b) = bot {
        q = q.filter(notice::Column::BotId.eq(b));
    }
    Ok(q.order_by_asc(notice::Column::Id).all(conn).await?)
}

/// `bot`'s ask card rows (its own and the mirrors shown to it) in one of
/// `states`, oldest first.
pub async fn ask_rows(
    conn: &DatabaseConnection,
    bot: i32,
    states: &[&str],
) -> Result<Vec<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Notice))
        .filter(Expr::cust("json_extract(data, '$.notice') = 'ask'"))
        .filter(Expr::cust(ask_state_filter(states)))
        .order_by_asc(timeline::Column::Id)
        .limit(200)
        .all(conn)
        .await?)
}

/// `bot`'s answered ask cards with plan feedback still to send.
pub async fn ask_rows_with_feedback(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Notice))
        .filter(Expr::cust("json_extract(data, '$.notice') = 'ask'"))
        .filter(Expr::cust("json_extract(data, '$.state') = 'answered'"))
        .filter(Expr::cust("json_extract(data, '$.feedback') IS NOT NULL"))
        .filter(Expr::cust("COALESCE(json_extract(data, '$.feedback_sent'), 0) = 0"))
        .filter(Expr::cust("json_extract(data, '$.mirror_of') IS NULL"))
        .order_by_asc(timeline::Column::Id)
        .limit(50)
        .all(conn)
        .await?)
}

/// The ask card rows (not the mirrors) of these dispatches, oldest first.
pub async fn ask_rows_of_dispatches(
    conn: &DatabaseConnection,
    dispatch_ids: &[i32],
) -> Result<Vec<timeline::Model>, DbError> {
    if dispatch_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Notice))
        .filter(timeline::Column::DispatchId.is_in(dispatch_ids.to_vec()))
        .filter(Expr::cust("json_extract(data, '$.notice') = 'ask'"))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

/// How many operations have ids starting with `prefix` (an automatic
/// retry's are `pa-retry-<dispatch>-`).
pub async fn count_ops_with_prefix(conn: &DatabaseConnection, prefix: &str) -> Result<u64, DbError> {
    let pattern = format!("{}%", prefix.replace('%', "").replace('_', "\\_"));
    Ok(action::Entity::find()
        .filter(Expr::cust_with_values(
            "op_id LIKE ? ESCAPE '\\'",
            [sea_orm::Value::from(pattern)],
        ))
        .count(conn)
        .await?)
}

/// The card a dispatch went out with.
pub async fn dispatch_card_row(
    conn: &DatabaseConnection,
    dispatch_id: i32,
) -> Result<Option<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Dispatch))
        .filter(timeline::Column::DispatchId.eq(dispatch_id))
        .order_by_asc(timeline::Column::Id)
        .one(conn)
        .await?)
}

/// Point a matter at the row it came from, once there is one.
pub async fn set_item_origin(conn: &DatabaseConnection, id: i32, row: i32) -> Result<(), DbError> {
    item::Entity::update_many()
        .col_expr(item::Column::OriginTimelineId, Expr::value(row))
        .filter(item::Column::Id.eq(id))
        .filter(item::Column::OriginTimelineId.is_null())
        .exec(conn)
        .await?;
    Ok(())
}

/// Every result card of a dispatch, oldest first.
pub async fn result_rows_of_dispatch(
    conn: &DatabaseConnection,
    dispatch_id: i32,
) -> Result<Vec<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Result))
        .filter(timeline::Column::DispatchId.eq(dispatch_id))
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?)
}

/// The newest result card of a dispatch.
pub async fn latest_result_row(
    conn: &DatabaseConnection,
    dispatch_id: i32,
) -> Result<Option<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Result))
        .filter(timeline::Column::DispatchId.eq(dispatch_id))
        .order_by_desc(timeline::Column::Id)
        .one(conn)
        .await?)
}

/// Replace a notice's payload.
pub async fn set_notice_payload(
    conn: &DatabaseConnection,
    id: i32,
    payload: &serde_json::Value,
) -> Result<(), DbError> {
    notice::Entity::update_many()
        .col_expr(notice::Column::Payload, Expr::value(payload.to_string()))
        .col_expr(notice::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(notice::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}
