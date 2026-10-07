//! Single write chokepoint for the conversation canvas.
//!
//! Every mutation runs `lock → one transaction { write + bump canvas_revision }
//! → commit`, and each committed mutation maps to exactly ONE broadcast event
//! carrying its revision. That gives clients a dense total order: an event at
//! `lastRevision + 1` is applied, at or below `lastRevision` is stale, above
//! `lastRevision + 1` means a gap → refetch the snapshot. Per-node semantics
//! stay last-write-wins — the revision orders writers, it does not reject them
//! (unlike the tabs CAS, which protects whole-set replacement).
//!
//! Nodes live on boards (`canvas_board`), but the revision stays ONE
//! workspace-global clock rather than one per board. A client only ever holds
//! one board's nodes, yet it still sees every event: an event for another board
//! simply advances its revision without touching its node set (every node
//! payload carries `board_id`, and a node never changes board). One clock keeps
//! the gap detection exactly as dense as before — and the deletion funnel,
//! which scrubs conversations off EVERY board in one transaction, stays one
//! event instead of fanning out into a revision per board.

use chrono::{DateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, FromQueryResult, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::sync::Mutex;

use crate::db::entities::canvas_node::{self, CanvasNodeKind};
use crate::db::entities::{app_metadata, canvas_board, conversation, folder, folder_group};
use crate::db::error::DbError;
use crate::db::service::app_metadata_service;

/// Workspace-global logical clock for the canvas, stored in the `app_metadata`
/// KV table (survives restart, stays monotonic). Bumped once per committed
/// mutation; carried on every response and every `canvas://changed` event.
const CANVAS_REVISION_KEY: &str = "canvas_revision";

/// Hard cap on a custom region's member list. Whole-node JSON read/write is the
/// storage model, so the list must stay small enough to rewrite on every add.
pub const MAX_CUSTOM_MEMBERS: usize = 200;

/// Upper bound on a pinned grid axis. Not a layout limit — the frontend derives
/// far more columns than this from a wide region — but a sanity clamp so a
/// fat-fingered value can't make a region's derived width explode past
/// [`MAX_NODE_SIZE`] and strand it off-screen. 0 stays "auto".
pub const MAX_GRID_AXIS: i32 = 12;

/// Geometry clamps: a node the user cannot see or grab again is unrecoverable
/// short of SQL, so reject degenerate sizes and non-finite coordinates at the
/// chokepoint rather than trusting every caller.
const MIN_NODE_SIZE: f64 = 48.0;
const MAX_NODE_SIZE: f64 = 20_000.0;
const MAX_COORD: f64 = 1_000_000.0;

/// Serializes every canvas mutation (including the deletion-funnel prune) so
/// the logical clock advances strictly sequentially — two concurrent writers
/// would otherwise both read the revision and race the bump — and so the
/// liveness check inside a write transaction cannot interleave with a prune:
/// add-then-prune gets scrubbed, prune-then-add sees the deleted conversation
/// and rejects. Mutations are tiny; serializing them is a correctness lock, not
/// a throughput cap (same reasoning as `tab_service::version_lock`).
fn revision_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub async fn get_revision<C: ConnectionTrait>(conn: &C) -> Result<i64, DbError> {
    let raw = app_metadata_service::get_value_conn(conn, CANVAS_REVISION_KEY).await?;
    Ok(raw.and_then(|s| s.parse::<i64>().ok()).unwrap_or(0))
}

async fn bump_revision<C: ConnectionTrait>(conn: &C) -> Result<i64, DbError> {
    let next = get_revision(conn).await? + 1;
    app_metadata_service::upsert_value(conn, CANVAS_REVISION_KEY, &next.to_string()).await?;
    Ok(next)
}

/// The opening statement of every canvas mutation's transaction, and the reason
/// each one below starts with a call to it.
///
/// SeaORM's SQLite backend can only open a transaction with a plain (deferred)
/// `BEGIN` — access mode isn't configurable per transaction — so a transaction
/// whose FIRST statement is a `SELECT` takes a read snapshot and only tries to
/// become a writer later. If any other pooled connection commits in between,
/// SQLite cannot promote that now-stale snapshot and fails the WHOLE
/// transaction with `SQLITE_BUSY_SNAPSHOT` (517): surfaced to the user as
/// "database is locked" with nothing actually deadlocked, and NOT retried by
/// `busy_timeout`, which only covers ordinary lock contention.
///
/// Every mutation here leads with reads — liveness checks, the row it is about
/// to rewrite — and the runtime pool has five connections, so the losing side of
/// that race is ordinary use: dragging a card while an agent streams (the ACP
/// transcript write-behind holds its own connection for the whole turn) is the
/// shape that produced it. `acp::manager::persist_fork_outcome` documents the
/// same hazard and `folder_group_service` sidesteps it; this is the same rule.
///
/// Touching the revision row is the cheapest claim available and needs no new
/// table. The value is deliberately left ALONE: [`bump_revision`] still owns the
/// counter at the end of the transaction, so a mutation that turns out to be a
/// no-op (or rolls back) consumes no revision and leaves no gap in the sequence
/// clients use to tell "applied" from "refetch the snapshot".
///
/// `rows_affected == 0` means the first-ever mutation on a fresh database, where
/// there is no row to touch: create it, so the claim is a write either way. "0"
/// is what [`get_revision`] already reads a missing row as, so this is not a
/// bump either.
///
/// Applied to ALL of them, including `delete_node`, which happens to already
/// open with a `DELETE`: the invariant is "canvas transactions claim first", and
/// one that holds only by accident of statement order breaks the next time
/// someone adds a check above the write.
async fn claim_writer<C: ConnectionTrait>(conn: &C) -> Result<(), DbError> {
    let touched = app_metadata::Entity::update_many()
        .col_expr(app_metadata::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(app_metadata::Column::Key.eq(CANVAS_REVISION_KEY))
        .exec(conn)
        .await?;
    if touched.rows_affected == 0 {
        app_metadata_service::upsert_value(conn, CANVAS_REVISION_KEY, "0").await?;
    }
    Ok(())
}

/// Read one board's node set and the revision in a single transaction so a
/// concurrent mutation can't tear the pair — old nodes stamped with a newer
/// revision would pass the client's `snapshot.revision >= lastRevision` guard
/// while silently dropping the concurrent change (same hazard
/// `tab_service::snapshot_tabs` exists for).
///
/// A board that does not exist is `NotFound`, not an empty board: the two look
/// identical as a node list, and a client told "empty" would keep drawing — and
/// writing to — a canvas that was deleted out from under it.
pub async fn snapshot(
    conn: &DatabaseConnection,
    board_id: i32,
) -> Result<(Vec<canvas_node::Model>, i64), DbError> {
    let txn = conn.begin().await?;
    require_board(&txn, board_id).await?;
    let nodes = canvas_node::Entity::find()
        .filter(canvas_node::Column::BoardId.eq(board_id))
        .order_by_asc(canvas_node::Column::Id)
        .all(&txn)
        .await?;
    let revision = get_revision(&txn).await?;
    txn.commit().await?;
    Ok((nodes, revision))
}

/// Reject a write aimed at a board that does not exist (never created, or
/// deleted by another client a moment ago). Runs inside the caller's write
/// transaction and under [`revision_lock`], which is what orders it against
/// [`delete_board`]: create-then-delete takes the new node with the board,
/// delete-then-create is refused here instead of minting an orphan no board
/// will ever show.
async fn require_board<C: ConnectionTrait>(conn: &C, board_id: i32) -> Result<(), DbError> {
    let exists = canvas_board::Entity::find_by_id(board_id)
        .one(conn)
        .await?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(DbError::NotFound(format!(
            "canvas board {board_id} not found"
        )))
    }
}

/// Stamp the boards a node write just changed as edited now. Rides the node
/// write's own transaction, so "last edited" on the canvas list can never
/// disagree with what is on the board — and costs one statement however many
/// nodes moved.
async fn touch_boards<C: ConnectionTrait>(
    conn: &C,
    board_ids: impl IntoIterator<Item = i32>,
    now: DateTime<Utc>,
) -> Result<(), DbError> {
    let mut ids: Vec<i32> = board_ids.into_iter().collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }
    canvas_board::Entity::update_many()
        .col_expr(canvas_board::Column::UpdatedAt, Expr::value(now))
        .filter(canvas_board::Column::Id.is_in(ids))
        .exec(conn)
        .await?;
    Ok(())
}

/// Decode a stored member list. Damaged JSON degrades to an empty list rather
/// than failing every canvas read.
pub fn parse_member_ids(raw: Option<&str>) -> Vec<i32> {
    raw.and_then(|s| serde_json::from_str::<Vec<i32>>(s).ok())
        .unwrap_or_default()
}

fn encode_member_ids(ids: &[i32]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_string())
}

/// Reject a write that would reference a soft-deleted (or never-existing)
/// conversation. Runs INSIDE the caller's write transaction and under
/// [`revision_lock`], which is what makes the prune ordering race-free.
async fn require_live_conversation<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
) -> Result<(), DbError> {
    let live = conversation::Entity::find_by_id(conversation_id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .is_some();
    if live {
        Ok(())
    } else {
        Err(DbError::Validation(format!(
            "conversation {conversation_id} does not exist or was deleted"
        )))
    }
}

fn clamp_coord(v: f64) -> Result<f64, DbError> {
    if !v.is_finite() {
        return Err(DbError::Validation("coordinate is not finite".to_string()));
    }
    Ok(v.clamp(-MAX_COORD, MAX_COORD))
}

fn clamp_size(v: f64) -> Result<f64, DbError> {
    if !v.is_finite() {
        return Err(DbError::Validation("size is not finite".to_string()));
    }
    Ok(v.clamp(MIN_NODE_SIZE, MAX_NODE_SIZE))
}

/// Normalize an optional text field: trims, and maps empty to NULL so "clear
/// the color / title" is expressible over the wire without a nested Option.
fn normalize_text(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The FolderThemeColor vocabulary (frontend `theme-presets.ts` THEME_COLORS).
/// Stored values are preset NAMES resolved to CSS at render time, so an
/// arbitrary string would render as no color at all — reject it at the write.
const THEME_COLOR_NAMES: &[&str] = &[
    "neutral", "zinc", "slate", "stone", "gray", "red", "rose", "orange", "green", "blue",
    "yellow", "violet",
];

/// Trim/clear like [`normalize_text`], then require vocabulary membership.
fn normalize_color(v: Option<String>) -> Result<Option<String>, DbError> {
    match normalize_text(v) {
        None => Ok(None),
        Some(c) if THEME_COLOR_NAMES.contains(&c.as_str()) => Ok(Some(c)),
        Some(c) => Err(DbError::Validation(format!("unknown theme color '{c}'"))),
    }
}

/// Longest filesystem path a node may bind to. Well past every real OS limit
/// (Windows extended-length paths top out at 32767 UTF-16 units, but nothing a
/// user picks or a folder root comes near this) — it exists so a malformed
/// caller cannot park an unbounded blob in a column every client reads.
const MAX_PATH_LEN: usize = 4096;

/// Trim a bound filesystem path, requiring a non-empty value. Callers hand us
/// an already-absolute path (the frontend normalizes before it asks); we do not
/// touch separators here, because the string has to round-trip byte-for-byte —
/// it is the identity a file card's reads and a terminal's cwd are keyed on.
fn normalize_path(v: Option<String>) -> Result<String, DbError> {
    let path = normalize_text(v)
        .ok_or_else(|| DbError::Validation("this node kind needs a path".into()))?;
    if path.chars().count() > MAX_PATH_LEN {
        return Err(DbError::Validation("path is too long".into()));
    }
    Ok(path)
}

/// Trim a pinned grid axis to `0..=MAX_GRID_AXIS`. Absent / negative reads as
/// auto rather than an error: the axis is a display preference, and rejecting
/// the whole write over one would lose a legitimate geometry change with it.
fn clamp_grid_axis(v: Option<i32>) -> i32 {
    v.unwrap_or(0).clamp(0, MAX_GRID_AXIS)
}

pub struct NewCanvasNode {
    /// The board the node is placed on; must exist.
    pub board_id: i32,
    pub kind: CanvasNodeKind,
    pub folder_id: Option<i32>,
    pub folder_group_id: Option<i32>,
    pub agent_type: Option<String>,
    pub conversation_id: Option<i32>,
    pub title: Option<String>,
    pub content: Option<String>,
    /// Required for `file` / `terminal`, rejected for every other kind.
    pub path: Option<String>,
    pub color: Option<String>,
    pub grid_columns: Option<i32>,
    pub grid_rows: Option<i32>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Field-by-field patch: `None` = leave untouched; empty strings clear nullable
/// text fields. `member_add` / `member_remove` are atomic list operations
/// executed server-side (never a whole-list replace), so two concurrent adds
/// cannot lose each other under the serializing lock.
#[derive(Debug, Default, Clone)]
pub struct CanvasNodePatch {
    pub title: Option<String>,
    pub content: Option<String>,
    pub color: Option<String>,
    pub collapsed: Option<bool>,
    pub grid_columns: Option<i32>,
    pub grid_rows: Option<i32>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub member_add: Option<i32>,
    pub member_remove: Option<i32>,
}

pub async fn create_node(
    conn: &DatabaseConnection,
    input: NewCanvasNode,
) -> Result<(canvas_node::Model, i64), DbError> {
    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    claim_writer(&txn).await?;
    require_board(&txn, input.board_id).await?;

    // Kind-specific binding invariants. The unrelated binding columns are
    // forced to NULL rather than trusted from the caller, so a row can never
    // carry a stale cross-kind reference.
    let mut folder_id = None;
    let mut folder_group_id = None;
    let mut agent_type = None;
    let mut conversation_id = None;
    let mut path = None;
    match input.kind {
        CanvasNodeKind::Folder => {
            let id = input
                .folder_id
                .ok_or_else(|| DbError::Validation("folder region needs folder_id".into()))?;
            let exists = folder::Entity::find_by_id(id)
                .filter(folder::Column::DeletedAt.is_null())
                .one(&txn)
                .await?
                .is_some();
            if !exists {
                return Err(DbError::NotFound(format!("folder {id} not found")));
            }
            folder_id = Some(id);
        }
        CanvasNodeKind::Group => {
            let id = input
                .folder_group_id
                .ok_or_else(|| DbError::Validation("group region needs folder_group_id".into()))?;
            // Folder groups are HARD-deleted, so unlike the folder check this
            // one is the only chance to catch a bad id — but the reference stays
            // soft afterwards (a region whose group is later deleted renders as
            // unresolved rather than vanishing, matching folder regions).
            let exists = folder_group::Entity::find_by_id(id)
                .one(&txn)
                .await?
                .is_some();
            if !exists {
                return Err(DbError::NotFound(format!("folder group {id} not found")));
            }
            folder_group_id = Some(id);
        }
        CanvasNodeKind::Agent => {
            let agent = input
                .agent_type
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| DbError::Validation("agent region needs agent_type".into()))?;
            agent_type = Some(agent.to_string());
        }
        CanvasNodeKind::Conversation => {
            let id = input.conversation_id.ok_or_else(|| {
                DbError::Validation("conversation node needs conversation_id".into())
            })?;
            require_live_conversation(&txn, id).await?;
            conversation_id = Some(id);
        }
        // A custom region starts empty; members arrive via `member_add` /
        // `detach_member` so every entry passes the liveness check.
        CanvasNodeKind::Custom => {}
        CanvasNodeKind::Note => {}
        // Both bind a place on disk. Existence is deliberately NOT checked:
        // like the folder / conversation bindings above the reference is SOFT,
        // and a card whose file was moved has to survive as a visible
        // "unavailable" frame the user can delete — the alternative is a create
        // that fails on a network share that happens to be unmounted, or a row
        // that silently vanishes when a branch switch takes the file away. The
        // frontend renders the missing state and offers the delete.
        CanvasNodeKind::File | CanvasNodeKind::Terminal => {
            path = Some(normalize_path(input.path.clone())?);
        }
    }
    // A path on any other kind is a caller bug, and one that would smuggle a
    // filesystem reference into a row nothing reads it from — same stance the
    // `content` check below takes for notes.
    if path.is_none() && input.path.as_deref().is_some_and(|s| !s.trim().is_empty()) {
        return Err(DbError::Validation(
            "path only applies to file and terminal nodes".into(),
        ));
    }

    let now = Utc::now();
    let model = canvas_node::ActiveModel {
        id: NotSet,
        board_id: Set(input.board_id),
        kind: Set(input.kind),
        folder_id: Set(folder_id),
        folder_group_id: Set(folder_group_id),
        agent_type: Set(agent_type),
        conversation_id: Set(conversation_id),
        member_ids: Set(match input.kind {
            CanvasNodeKind::Custom => Some("[]".to_string()),
            _ => None,
        }),
        title: Set(normalize_text(input.title)),
        // `content` is the note body — any other kind carrying one is a caller
        // bug that would smuggle invisible state into the row.
        content: Set(match input.kind {
            CanvasNodeKind::Note => input.content.filter(|s| !s.is_empty()),
            _ => {
                if input.content.as_deref().is_some_and(|s| !s.is_empty()) {
                    return Err(DbError::Validation(
                        "content only applies to notes".into(),
                    ));
                }
                None
            }
        }),
        path: Set(path),
        color: Set(normalize_color(input.color)?),
        collapsed: Set(false),
        // Grid shape is meaningless for a pinned card or a note; forcing 0
        // keeps those rows from carrying state nothing reads.
        grid_columns: Set(if input.kind.is_region() {
            clamp_grid_axis(input.grid_columns)
        } else {
            0
        }),
        grid_rows: Set(if input.kind.is_region() {
            clamp_grid_axis(input.grid_rows)
        } else {
            0
        }),
        x: Set(clamp_coord(input.x)?),
        y: Set(clamp_coord(input.y)?),
        width: Set(clamp_size(input.width)?),
        height: Set(clamp_size(input.height)?),
        created_at: Set(now),
        updated_at: Set(now),
    };
    let row = model.insert(&txn).await?;
    touch_boards(&txn, [row.board_id], now).await?;
    let revision = bump_revision(&txn).await?;
    txn.commit().await?;
    Ok((row, revision))
}

pub struct GroupIntoRegion {
    /// The board the gesture happened on. A merge target and every consumed
    /// card must be on it; a new region is created on it.
    pub board_id: i32,
    /// Existing custom region to fold the conversations into. `None` creates a
    /// new custom region from the geometry below; `Some` merges into that
    /// region and ignores the geometry entirely (the frame is already placed).
    pub target_region_id: Option<i32>,
    pub title: Option<String>,
    pub color: Option<String>,
    /// Conversations to seed the new custom region with, in the caller's order.
    pub member_ids: Vec<i32>,
    /// Pinned `conversation` cards the selection swallowed. Absorbed into the
    /// region and deleted here so the loose card doesn't stay stranded under the
    /// frame it was just collected into.
    pub consume_node_ids: Vec<i32>,
    pub grid_columns: Option<i32>,
    pub grid_rows: Option<i32>,
    /// Where to put a NEW region. Required when `target_region_id` is absent
    /// and meaningless when it is present (that frame is already placed), so it
    /// is optional here rather than a set of zeros the merge path has to invent
    /// — a zero size would silently clamp to the 48px minimum instead of
    /// failing, which is a mystery region rather than an error.
    pub geometry: Option<RegionGeometry>,
}

pub struct RegionGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What [`group_into_region`] committed: the region (created or merged into),
/// the pinned cards that were ACTUALLY deleted (raced/mistyped ids dropped,
/// mirroring `move_nodes`), and the revision of the single event describing
/// both halves.
pub struct GroupIntoRegionOutcome {
    pub node: canvas_node::Model,
    pub deleted_ids: Vec<i32>,
    pub revision: i64,
}

/// "Collect these conversations into a region", as ONE transaction: the region
/// is created (or extended) with its member list already validated, and the
/// loose pinned cards it absorbed are deleted alongside. Doing this as
/// `create` + N × `member_add` + M × `delete` would spray a dozen revisions for
/// one gesture and leave every intermediate state observable (a region that
/// exists but is empty, cards that vanished before their region appeared).
///
/// Three canvas gestures share it: box-select → collect, a pinned card dragged
/// into an existing custom region, and two cards dropped onto each other. All
/// three are the same shape — "this region now holds these conversations, and
/// these loose cards are gone" — which is exactly what the `Grouped` broadcast
/// carries.
pub async fn group_into_region(
    conn: &DatabaseConnection,
    input: GroupIntoRegion,
) -> Result<GroupIntoRegionOutcome, DbError> {
    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    claim_writer(&txn).await?;
    require_board(&txn, input.board_id).await?;

    // Dedupe preserving the caller's order: the same conversation can be
    // selected twice (a member card and its mirror in another region), and the
    // member list is a set.
    let mut members: Vec<i32> = Vec::with_capacity(input.member_ids.len());
    for id in input.member_ids {
        if members.contains(&id) {
            continue;
        }
        if members.len() >= MAX_CUSTOM_MEMBERS {
            return Err(DbError::Validation(format!(
                "a region holds at most {MAX_CUSTOM_MEMBERS} conversations"
            )));
        }
        require_live_conversation(&txn, id).await?;
        members.push(id);
    }

    // Resolve the destination BEFORE anything is deleted: a consumed card may
    // only be destroyed once the conversation it was showing is guaranteed a
    // seat in the region (see the adoption check below).
    let target = match input.target_region_id {
        // Merge into an existing frame. Only custom regions have a member list
        // to write: a folder/group/agent region's members are a live binding,
        // so "drop a card in here" has no meaning there.
        Some(region_id) => {
            let region = canvas_node::Entity::find_by_id(region_id)
                .one(&txn)
                .await?
                .ok_or_else(|| DbError::NotFound(format!("canvas node {region_id} not found")))?;
            if region.kind != CanvasNodeKind::Custom {
                return Err(DbError::Validation(
                    "only custom regions can absorb conversations".into(),
                ));
            }
            // A gesture only ever sees one board, so a target on another one
            // is a stale or forged id — refuse it rather than reach across.
            if region.board_id != input.board_id {
                return Err(DbError::Validation(
                    "the region is on a different canvas".into(),
                ));
            }
            Some(region)
        }
        None => None,
    };

    // The member list this call will leave behind — the union for a merge, the
    // selection itself for a new region.
    let final_members = match &target {
        Some(region) => {
            let mut merged = parse_member_ids(region.member_ids.as_deref());
            for id in &members {
                if merged.contains(id) {
                    continue;
                }
                if merged.len() >= MAX_CUSTOM_MEMBERS {
                    return Err(DbError::Validation(format!(
                        "a region holds at most {MAX_CUSTOM_MEMBERS} conversations"
                    )));
                }
                merged.push(*id);
            }
            merged
        }
        None => members,
    };

    // Only pinned cards are consumable. A region or note in the selection keeps
    // living where it is — collecting a conversation is a membership change,
    // not a licence to delete arbitrary nodes the caller named. Same for a card
    // on another board: the gesture cannot have selected it, so it is skipped
    // like any other id that is not a pin here.
    let mut deleted_ids = Vec::new();
    if !input.consume_node_ids.is_empty() {
        let doomed = canvas_node::Entity::find()
            .filter(canvas_node::Column::Id.is_in(input.consume_node_ids.iter().copied()))
            .filter(canvas_node::Column::Kind.eq(CanvasNodeKind::Conversation))
            .filter(canvas_node::Column::BoardId.eq(input.board_id))
            .all(&txn)
            .await?;
        // Consuming a card is "the region took it over", so the takeover has to
        // be real. Deleting a card whose conversation ends up in no member list
        // would destroy the only handle the user had on that conversation —
        // silently, and inside the same event that claims it was collected.
        for card in &doomed {
            let adopted = card
                .conversation_id
                .is_some_and(|cid| final_members.contains(&cid));
            if !adopted {
                return Err(DbError::Validation(
                    "a consumed card's conversation must be a member of the region".into(),
                ));
            }
        }
        deleted_ids = doomed.iter().map(|n| n.id).collect();
        if !deleted_ids.is_empty() {
            canvas_node::Entity::delete_many()
                .filter(canvas_node::Column::Id.is_in(deleted_ids.iter().copied()))
                .exec(&txn)
                .await?;
        }
    }

    let now = Utc::now();
    let node = match target {
        Some(region) => {
            let mut active = region.into_active_model();
            active.member_ids = Set(Some(encode_member_ids(&final_members)));
            active.updated_at = Set(now);
            active.update(&txn).await?
        }
        None => {
            let geometry = input.geometry.ok_or_else(|| {
                DbError::Validation("a new region needs its geometry".into())
            })?;
            canvas_node::ActiveModel {
                id: NotSet,
                board_id: Set(input.board_id),
                kind: Set(CanvasNodeKind::Custom),
                folder_id: Set(None),
                folder_group_id: Set(None),
                agent_type: Set(None),
                conversation_id: Set(None),
                member_ids: Set(Some(encode_member_ids(&final_members))),
                title: Set(normalize_text(input.title)),
                content: Set(None),
                path: Set(None),
                color: Set(normalize_color(input.color)?),
                collapsed: Set(false),
                grid_columns: Set(clamp_grid_axis(input.grid_columns)),
                grid_rows: Set(clamp_grid_axis(input.grid_rows)),
                x: Set(clamp_coord(geometry.x)?),
                y: Set(clamp_coord(geometry.y)?),
                width: Set(clamp_size(geometry.width)?),
                height: Set(clamp_size(geometry.height)?),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(&txn)
            .await?
        }
    };

    touch_boards(&txn, [input.board_id], now).await?;
    let revision = bump_revision(&txn).await?;
    txn.commit().await?;
    Ok(GroupIntoRegionOutcome {
        node,
        deleted_ids,
        revision,
    })
}

pub async fn update_node(
    conn: &DatabaseConnection,
    node_id: i32,
    patch: CanvasNodePatch,
) -> Result<(canvas_node::Model, i64), DbError> {
    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    claim_writer(&txn).await?;

    let existing = canvas_node::Entity::find_by_id(node_id)
        .one(&txn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("canvas node {node_id} not found")))?;
    let kind = existing.kind;
    let board_id = existing.board_id;
    let mut members = parse_member_ids(existing.member_ids.as_deref());
    let mut active = existing.into_active_model();

    if patch.member_add.is_some() || patch.member_remove.is_some() {
        if kind != CanvasNodeKind::Custom {
            return Err(DbError::Validation(
                "member operations only apply to custom regions".into(),
            ));
        }
        if let Some(id) = patch.member_add {
            require_live_conversation(&txn, id).await?;
            if !members.contains(&id) {
                if members.len() >= MAX_CUSTOM_MEMBERS {
                    return Err(DbError::Validation(format!(
                        "a region holds at most {MAX_CUSTOM_MEMBERS} conversations"
                    )));
                }
                members.push(id);
            }
        }
        if let Some(id) = patch.member_remove {
            members.retain(|m| *m != id);
        }
        active.member_ids = Set(Some(encode_member_ids(&members)));
    }

    if let Some(title) = patch.title {
        active.title = Set(normalize_text(Some(title)));
    }
    if let Some(content) = patch.content {
        if kind != CanvasNodeKind::Note {
            return Err(DbError::Validation("content only applies to notes".into()));
        }
        // Notes keep interior whitespace; only a fully-empty note clears.
        active.content = Set(Some(content).filter(|s| !s.is_empty()));
    }
    if let Some(color) = patch.color {
        active.color = Set(normalize_color(Some(color))?);
    }
    if let Some(collapsed) = patch.collapsed {
        active.collapsed = Set(collapsed);
    }
    if patch.grid_columns.is_some() || patch.grid_rows.is_some() {
        if !kind.is_region() {
            return Err(DbError::Validation(
                "grid shape only applies to regions".into(),
            ));
        }
        if let Some(columns) = patch.grid_columns {
            active.grid_columns = Set(clamp_grid_axis(Some(columns)));
        }
        if let Some(rows) = patch.grid_rows {
            active.grid_rows = Set(clamp_grid_axis(Some(rows)));
        }
    }
    if let Some(x) = patch.x {
        active.x = Set(clamp_coord(x)?);
    }
    if let Some(y) = patch.y {
        active.y = Set(clamp_coord(y)?);
    }
    if let Some(w) = patch.width {
        active.width = Set(clamp_size(w)?);
    }
    if let Some(h) = patch.height {
        active.height = Set(clamp_size(h)?);
    }
    let now = Utc::now();
    active.updated_at = Set(now);

    let row = active.update(&txn).await?;
    touch_boards(&txn, [board_id], now).await?;
    let revision = bump_revision(&txn).await?;
    txn.commit().await?;
    Ok((row, revision))
}

pub struct CanvasNodeMove {
    pub id: i32,
    pub x: f64,
    pub y: f64,
}

/// Batch position write (drag drop, auto-arrange, multi-select drag): one bump,
/// one event, however many nodes moved. Ids that no longer exist are skipped —
/// a move is cosmetic and racing a delete must not fail the whole batch.
///
/// Returns the moves as ACTUALLY WRITTEN — clamped coordinates, ghosts dropped
/// — because that is what the broadcast must carry: echoing the caller's raw
/// values would leave every client holding positions the database never stored.
/// `None` when nothing was written (no bump, no event).
pub async fn move_nodes(
    conn: &DatabaseConnection,
    moves: &[CanvasNodeMove],
) -> Result<Option<(Vec<CanvasNodeMove>, i64)>, DbError> {
    if moves.is_empty() {
        return Ok(None);
    }
    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    claim_writer(&txn).await?;
    let now = Utc::now();
    let mut applied = Vec::with_capacity(moves.len());
    let mut boards = Vec::new();
    for m in moves {
        let Some(existing) = canvas_node::Entity::find_by_id(m.id).one(&txn).await? else {
            continue;
        };
        let x = clamp_coord(m.x)?;
        let y = clamp_coord(m.y)?;
        boards.push(existing.board_id);
        let mut active = existing.into_active_model();
        active.x = Set(x);
        active.y = Set(y);
        active.updated_at = Set(now);
        active.update(&txn).await?;
        applied.push(CanvasNodeMove { id: m.id, x, y });
    }
    if applied.is_empty() {
        txn.commit().await?;
        return Ok(None);
    }
    touch_boards(&txn, boards, now).await?;
    let revision = bump_revision(&txn).await?;
    txn.commit().await?;
    Ok(Some((applied, revision)))
}

/// Result of [`detach_member`]: the region the conversation was removed from
/// (custom regions only — binding regions copy), the freshly pinned node, and
/// the revision of the single event describing both steps.
#[derive(Debug)]
pub struct DetachOutcome {
    pub removed_from: Option<i32>,
    pub node: canvas_node::Model,
    pub revision: i64,
}

/// Default card footprint recorded for a pinned conversation node. The frontend
/// renders conversation cards at a fixed size, so the stored geometry only has
/// to be sane, not authoritative.
const CARD_WIDTH: f64 = 224.0;
const CARD_HEIGHT: f64 = 132.0;

/// Drag a member card out of a region onto open canvas, as ONE transaction —
/// removal and creation can never be torn apart by a crash or a lost request.
/// Custom regions MOVE (membership is removed; it must be present, so a stale
/// retry surfaces as `NotFound` instead of minting a duplicate pin); folder and
/// agent regions COPY (their member list is a live binding with no single
/// member to remove).
pub async fn detach_member(
    conn: &DatabaseConnection,
    region_id: i32,
    conversation_id: i32,
    x: f64,
    y: f64,
) -> Result<DetachOutcome, DbError> {
    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    claim_writer(&txn).await?;

    let region = canvas_node::Entity::find_by_id(region_id)
        .one(&txn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("canvas node {region_id} not found")))?;
    // The pin lands on the region's own board — a member dragged out of a
    // region is still on the canvas it was dragged across.
    let board_id = region.board_id;

    let removed_from = match region.kind {
        CanvasNodeKind::Custom => {
            let mut members = parse_member_ids(region.member_ids.as_deref());
            let before = members.len();
            members.retain(|m| *m != conversation_id);
            if members.len() == before {
                return Err(DbError::NotFound(format!(
                    "conversation {conversation_id} is not a member of region {region_id}"
                )));
            }
            let mut active = region.into_active_model();
            active.member_ids = Set(Some(encode_member_ids(&members)));
            active.updated_at = Set(Utc::now());
            active.update(&txn).await?;
            Some(region_id)
        }
        CanvasNodeKind::Folder | CanvasNodeKind::Group | CanvasNodeKind::Agent => None,
        CanvasNodeKind::Conversation
        | CanvasNodeKind::Note
        | CanvasNodeKind::File
        | CanvasNodeKind::Terminal => {
            return Err(DbError::Validation(format!(
                "canvas node {region_id} is not a region"
            )));
        }
    };

    require_live_conversation(&txn, conversation_id).await?;

    let now = Utc::now();
    let node = canvas_node::ActiveModel {
        id: NotSet,
        board_id: Set(board_id),
        kind: Set(CanvasNodeKind::Conversation),
        folder_id: Set(None),
        folder_group_id: Set(None),
        agent_type: Set(None),
        conversation_id: Set(Some(conversation_id)),
        member_ids: Set(None),
        title: Set(None),
        content: Set(None),
        path: Set(None),
        color: Set(None),
        collapsed: Set(false),
        grid_columns: Set(0),
        grid_rows: Set(0),
        x: Set(clamp_coord(x)?),
        y: Set(clamp_coord(y)?),
        width: Set(CARD_WIDTH),
        height: Set(CARD_HEIGHT),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await?;

    touch_boards(&txn, [board_id], now).await?;
    let revision = bump_revision(&txn).await?;
    txn.commit().await?;
    Ok(DetachOutcome {
        removed_from,
        node,
        revision,
    })
}

/// Delete a node. `None` when the node was already gone — nothing changed, so
/// the caller must not bump-broadcast a phantom event.
pub async fn delete_node(
    conn: &DatabaseConnection,
    node_id: i32,
) -> Result<Option<i64>, DbError> {
    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    claim_writer(&txn).await?;
    // Read before deleting: the board it sat on is stamped as edited.
    let Some(node) = canvas_node::Entity::find_by_id(node_id).one(&txn).await? else {
        txn.commit().await?;
        return Ok(None);
    };
    canvas_node::Entity::delete_by_id(node_id)
        .exec(&txn)
        .await?;
    touch_boards(&txn, [node.board_id], Utc::now()).await?;
    let revision = bump_revision(&txn).await?;
    txn.commit().await?;
    Ok(Some(revision))
}

/// Delete several nodes at once (multi-select on the canvas): one transaction,
/// one bump, one event — deleting them one by one would spray a revision per
/// node and let every client watch the selection disappear in pieces. Ids that
/// no longer exist are skipped, and the ids ACTUALLY deleted come back so the
/// broadcast describes what the database did rather than what was asked.
/// `None` when nothing existed to delete (no bump, no event).
pub async fn delete_nodes(
    conn: &DatabaseConnection,
    ids: &[i32],
) -> Result<Option<(Vec<i32>, i64)>, DbError> {
    if ids.is_empty() {
        return Ok(None);
    }
    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    claim_writer(&txn).await?;
    let rows = canvas_node::Entity::find()
        .filter(canvas_node::Column::Id.is_in(ids.iter().copied()))
        .all(&txn)
        .await?;
    if rows.is_empty() {
        txn.commit().await?;
        return Ok(None);
    }
    let existing: Vec<i32> = rows.iter().map(|n| n.id).collect();
    canvas_node::Entity::delete_many()
        .filter(canvas_node::Column::Id.is_in(existing.iter().copied()))
        .exec(&txn)
        .await?;
    touch_boards(&txn, rows.iter().map(|n| n.board_id), Utc::now()).await?;
    let revision = bump_revision(&txn).await?;
    txn.commit().await?;
    Ok(Some((existing, revision)))
}

/// What the deletion funnel changed: pinned nodes removed, custom regions whose
/// member list was scrubbed, and the revision of the single `Pruned` event.
pub struct PruneOutcome {
    pub deleted_ids: Vec<i32>,
    pub updated: Vec<canvas_node::Model>,
    pub revision: i64,
}

/// Scrub every canvas reference to the given conversations: drop their pinned
/// `conversation` nodes and remove them from every custom region's member list.
/// Runs under [`revision_lock`] in one transaction — the write-barrier half of
/// the liveness check in `require_live_conversation` (see the lock's doc).
/// `None` when nothing referenced them (no bump, no event — a quieter barrier
/// than tabs' because stale writes are rejected by liveness, not by version).
///
/// Crosses boards on purpose (a conversation can be pinned on several), and
/// deliberately does NOT stamp them as edited: this is housekeeping after a
/// deletion elsewhere, not someone working on the canvas, and "last edited"
/// jumping on every board that happened to show a deleted conversation would
/// reorder the canvas list for no visible reason.
pub async fn prune_for_conversations(
    conn: &DatabaseConnection,
    conversation_ids: &[i32],
) -> Result<Option<PruneOutcome>, DbError> {
    if conversation_ids.is_empty() {
        return Ok(None);
    }
    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    claim_writer(&txn).await?;

    let doomed = canvas_node::Entity::find()
        .filter(canvas_node::Column::ConversationId.is_in(conversation_ids.iter().copied()))
        .all(&txn)
        .await?;
    let deleted_ids: Vec<i32> = doomed.iter().map(|n| n.id).collect();
    if !deleted_ids.is_empty() {
        canvas_node::Entity::delete_many()
            .filter(canvas_node::Column::Id.is_in(deleted_ids.iter().copied()))
            .exec(&txn)
            .await?;
    }

    let customs = canvas_node::Entity::find()
        .filter(canvas_node::Column::Kind.eq(CanvasNodeKind::Custom))
        .all(&txn)
        .await?;
    let mut updated = Vec::new();
    let now = Utc::now();
    for region in customs {
        let members = parse_member_ids(region.member_ids.as_deref());
        let next: Vec<i32> = members
            .iter()
            .copied()
            .filter(|m| !conversation_ids.contains(m))
            .collect();
        if next.len() == members.len() {
            continue;
        }
        let mut active = region.into_active_model();
        active.member_ids = Set(Some(encode_member_ids(&next)));
        active.updated_at = Set(now);
        updated.push(active.update(&txn).await?);
    }

    if deleted_ids.is_empty() && updated.is_empty() {
        txn.commit().await?;
        return Ok(None);
    }

    let revision = bump_revision(&txn).await?;
    txn.commit().await?;
    Ok(Some(PruneOutcome {
        deleted_ids,
        updated,
        revision,
    }))
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

/// Longest board name / description a write accepts. Not a layout limit — the
/// cards truncate long text anyway — but the list endpoint hands every board's
/// text to every client, so a malformed caller must not be able to park an
/// unbounded blob in it (the same stance [`MAX_PATH_LEN`] takes).
pub const MAX_BOARD_NAME_LEN: usize = 200;
pub const MAX_BOARD_DESCRIPTION_LEN: usize = 2_000;

/// Most node rectangles a board's list card draws. A thumbnail is a silhouette,
/// not a render: past a couple of hundred shapes nothing more is legible at card
/// size, while every rectangle is paid for on each list refresh by every
/// client. The largest nodes are kept (see [`list_boards`]), so what survives
/// the cut is the structure — regions and big cards — not a random sample.
pub const MAX_BOARD_PREVIEW_RECTS: usize = 200;

pub struct NewCanvasBoard {
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
}

/// Field-by-field patch, same convention as [`CanvasNodePatch`]: `None` leaves a
/// field alone, an empty (or all-whitespace) string clears it.
#[derive(Debug, Default, Clone)]
pub struct CanvasBoardPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
}

/// One node's footprint on a board's list card.
#[derive(Debug, Clone)]
pub struct BoardPreviewRect {
    pub kind: CanvasNodeKind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: Option<String>,
}

/// A board plus what its list card shows about the nodes on it.
#[derive(Debug, Clone)]
pub struct BoardSummary {
    pub board: canvas_board::Model,
    pub node_count: i64,
    /// Terminal cards on the board — each one a shell a board delete stops, so
    /// the confirmation can say so before the user agrees to it.
    pub terminal_count: i64,
    /// Up to [`MAX_BOARD_PREVIEW_RECTS`] footprints, largest first.
    pub preview: Vec<BoardPreviewRect>,
}

/// The columns of a node the canvas list reads — its board and footprint.
#[derive(Debug, FromQueryResult)]
struct NodeFootprint {
    board_id: i32,
    kind: CanvasNodeKind,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color: Option<String>,
}

/// Trim/clear like [`normalize_text`], then bound the length.
fn normalize_board_text(
    v: Option<String>,
    max: usize,
    what: &str,
) -> Result<Option<String>, DbError> {
    let text = normalize_text(v);
    if text.as_ref().is_some_and(|s| s.chars().count() > max) {
        return Err(DbError::Validation(format!("{what} is too long")));
    }
    Ok(text)
}

/// Every board, most recently edited first, each with its node count and a
/// thumbnail's worth of footprints. One read transaction, so a board and the
/// nodes counted under it can't come from two different moments.
pub async fn list_boards(conn: &DatabaseConnection) -> Result<Vec<BoardSummary>, DbError> {
    let txn = conn.begin().await?;
    let boards = canvas_board::Entity::find()
        .order_by_desc(canvas_board::Column::UpdatedAt)
        .order_by_desc(canvas_board::Column::Id)
        .all(&txn)
        .await?;
    // Only the geometry columns: a note's text or a region's member list is
    // never drawn on a thumbnail, and reading every node's whole row for a list
    // page would ship all of it for nothing.
    let footprints = canvas_node::Entity::find()
        .select_only()
        .column(canvas_node::Column::BoardId)
        .column(canvas_node::Column::Kind)
        .column(canvas_node::Column::X)
        .column(canvas_node::Column::Y)
        .column(canvas_node::Column::Width)
        .column(canvas_node::Column::Height)
        .column(canvas_node::Column::Color)
        .into_model::<NodeFootprint>()
        .all(&txn)
        .await?;
    txn.commit().await?;

    let mut by_board: HashMap<i32, Vec<BoardPreviewRect>> = HashMap::new();
    for f in footprints {
        by_board.entry(f.board_id).or_default().push(BoardPreviewRect {
            kind: f.kind,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
            color: f.color,
        });
    }

    Ok(boards
        .into_iter()
        .map(|board| {
            let mut rects = by_board.remove(&board.id).unwrap_or_default();
            let node_count = rects.len() as i64;
            let terminal_count = rects
                .iter()
                .filter(|r| r.kind == CanvasNodeKind::Terminal)
                .count() as i64;
            // Largest first: that is both the order worth keeping under the cap
            // and the paint order that leaves small cards on top of the regions
            // around them.
            rects.sort_by(|a, b| (b.width * b.height).total_cmp(&(a.width * a.height)));
            rects.truncate(MAX_BOARD_PREVIEW_RECTS);
            BoardSummary {
                board,
                node_count,
                terminal_count,
                preview: rects,
            }
        })
        .collect())
}

pub async fn create_board(
    conn: &DatabaseConnection,
    input: NewCanvasBoard,
) -> Result<canvas_board::Model, DbError> {
    let name = normalize_board_text(input.name, MAX_BOARD_NAME_LEN, "name")?;
    let description =
        normalize_board_text(input.description, MAX_BOARD_DESCRIPTION_LEN, "description")?;
    let color = normalize_color(input.color)?;
    let _guard = revision_lock().lock().await;
    let now = Utc::now();
    let row = canvas_board::ActiveModel {
        id: NotSet,
        name: Set(name),
        description: Set(description),
        color: Set(color),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(conn)
    .await?;
    Ok(row)
}

pub async fn update_board(
    conn: &DatabaseConnection,
    board_id: i32,
    patch: CanvasBoardPatch,
) -> Result<canvas_board::Model, DbError> {
    // Validate before taking the lock or opening anything: a rejected patch
    // must not cost the writer lock (or a stamp on the board).
    let name = patch
        .name
        .map(|n| normalize_board_text(Some(n), MAX_BOARD_NAME_LEN, "name"))
        .transpose()?;
    let description = patch
        .description
        .map(|d| normalize_board_text(Some(d), MAX_BOARD_DESCRIPTION_LEN, "description"))
        .transpose()?;
    let color = patch.color.map(|c| normalize_color(Some(c))).transpose()?;

    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    let now = Utc::now();
    // Write first, then read (see `claim_writer`): stamping the row IS the
    // claim, and zero rows touched means there is no such board.
    let touched = canvas_board::Entity::update_many()
        .col_expr(canvas_board::Column::UpdatedAt, Expr::value(now))
        .filter(canvas_board::Column::Id.eq(board_id))
        .exec(&txn)
        .await?;
    if touched.rows_affected == 0 {
        return Err(DbError::NotFound(format!(
            "canvas board {board_id} not found"
        )));
    }
    let existing = canvas_board::Entity::find_by_id(board_id)
        .one(&txn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("canvas board {board_id} not found")))?;
    let mut active = existing.into_active_model();
    if let Some(name) = name {
        active.name = Set(name);
    }
    if let Some(description) = description {
        active.description = Set(description);
    }
    if let Some(color) = color {
        active.color = Set(color);
    }
    active.updated_at = Set(now);
    let row = active.update(&txn).await?;
    txn.commit().await?;
    Ok(row)
}

/// What [`delete_board`] removed: the nodes that were on the board (so their
/// shells can be ended and every client told they are gone), and the revision
/// of that node removal — `None` when the board was empty, since nothing on the
/// node stream changed.
pub struct DeleteBoardOutcome {
    pub deleted_node_ids: Vec<i32>,
    pub revision: Option<i64>,
}

/// Delete a board and every node on it, as ONE transaction: a board that is
/// gone with its nodes still in the table would leave rows no board ever shows
/// again (and terminal cards whose shells nothing can reach), while nodes gone
/// with the board still listed would be a canvas that silently emptied.
/// `None` when the board was already gone — nothing changed, so the caller must
/// not broadcast anything.
pub async fn delete_board(
    conn: &DatabaseConnection,
    board_id: i32,
) -> Result<Option<DeleteBoardOutcome>, DbError> {
    let _guard = revision_lock().lock().await;
    let txn = conn.begin().await?;
    claim_writer(&txn).await?;
    let removed = canvas_board::Entity::delete_by_id(board_id)
        .exec(&txn)
        .await?;
    if removed.rows_affected == 0 {
        txn.commit().await?;
        return Ok(None);
    }
    let deleted_node_ids: Vec<i32> = canvas_node::Entity::find()
        .select_only()
        .column(canvas_node::Column::Id)
        .filter(canvas_node::Column::BoardId.eq(board_id))
        .order_by_asc(canvas_node::Column::Id)
        .into_tuple()
        .all(&txn)
        .await?;
    let revision = if deleted_node_ids.is_empty() {
        None
    } else {
        canvas_node::Entity::delete_many()
            .filter(canvas_node::Column::BoardId.eq(board_id))
            .exec(&txn)
            .await?;
        Some(bump_revision(&txn).await?)
    };
    txn.commit().await?;
    Ok(Some(DeleteBoardOutcome {
        deleted_node_ids,
        revision,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    /// A fresh database with one board on it — every node needs a board.
    async fn board_db() -> (crate::db::AppDatabase, i32) {
        let db = fresh_in_memory_db().await;
        let board = create_board(
            &db.conn,
            NewCanvasBoard {
                name: None,
                description: None,
                color: None,
            },
        )
        .await
        .expect("create board")
        .id;
        (db, board)
    }

    fn new_node(board_id: i32, kind: CanvasNodeKind, path: Option<&str>) -> NewCanvasNode {
        NewCanvasNode {
            board_id,
            kind,
            folder_id: None,
            folder_group_id: None,
            agent_type: None,
            conversation_id: None,
            title: None,
            content: None,
            path: path.map(str::to_string),
            color: None,
            grid_columns: None,
            grid_rows: None,
            x: 0.0,
            y: 0.0,
            width: 460.0,
            height: 360.0,
        }
    }

    #[tokio::test]
    async fn file_and_terminal_nodes_keep_their_path() {
        let (db, board) = board_db().await;
        let (file, _) = create_node(
            &db.conn,
            new_node(board, CanvasNodeKind::File, Some("  /repo/src/main.rs  ")),
        )
        .await
        .expect("create file node");
        // Trimmed, but otherwise byte-for-byte: the path is the identity every
        // read and every watch join is keyed on, so nothing may rewrite it.
        assert_eq!(file.path.as_deref(), Some("/repo/src/main.rs"));

        let (terminal, _) = create_node(
            &db.conn,
            new_node(board, CanvasNodeKind::Terminal, Some("/repo")),
        )
        .await
        .expect("create terminal node");
        assert_eq!(terminal.path.as_deref(), Some("/repo"));
    }

    #[tokio::test]
    async fn a_path_bound_kind_without_a_path_is_rejected() {
        let (db, board) = board_db().await;
        for kind in [CanvasNodeKind::File, CanvasNodeKind::Terminal] {
            for candidate in [None, Some(""), Some("   ")] {
                let err = create_node(&db.conn, new_node(board, kind, candidate))
                    .await
                    .expect_err("a path-bound node needs a path");
                assert!(matches!(err, DbError::Validation(_)), "got {err:?}");
            }
        }
    }

    #[tokio::test]
    async fn other_kinds_may_not_smuggle_a_path() {
        // Same stance `content` takes for notes: a column only one kind reads
        // must not be settable on the kinds that ignore it, or the row carries
        // state nothing will ever surface or clean up.
        let (db, board) = board_db().await;
        let err = create_node(
            &db.conn,
            new_node(board, CanvasNodeKind::Custom, Some("/repo/secret")),
        )
        .await
        .expect_err("path is not a custom-region field");
        assert!(matches!(err, DbError::Validation(_)), "got {err:?}");

        // …and a kind that legitimately has none stores NULL rather than "".
        let (note, _) = create_node(&db.conn, new_node(board, CanvasNodeKind::Note, None))
            .await
            .expect("create note");
        assert_eq!(note.path, None);
    }

    #[tokio::test]
    async fn an_over_long_path_is_rejected_rather_than_stored() {
        let (db, board) = board_db().await;
        let long = format!("/{}", "a".repeat(MAX_PATH_LEN));
        let err = create_node(&db.conn, new_node(board, CanvasNodeKind::File, Some(&long)))
            .await
            .expect_err("bounded");
        assert!(matches!(err, DbError::Validation(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn file_and_terminal_nodes_are_not_regions() {
        // `is_region` gates the grid shape, member drops and the detach
        // gesture. A file card answering yes would accept conversations it has
        // nowhere to put.
        assert!(!CanvasNodeKind::File.is_region());
        assert!(!CanvasNodeKind::Terminal.is_region());
        assert!(CanvasNodeKind::File.needs_path());
        assert!(CanvasNodeKind::Terminal.needs_path());
        for kind in [
            CanvasNodeKind::Folder,
            CanvasNodeKind::Group,
            CanvasNodeKind::Agent,
            CanvasNodeKind::Custom,
            CanvasNodeKind::Conversation,
            CanvasNodeKind::Note,
        ] {
            assert!(!kind.needs_path(), "{kind:?} should not carry a path");
        }

        let (db, board) = board_db().await;
        let (file, _) = create_node(
            &db.conn,
            new_node(board, CanvasNodeKind::File, Some("/repo/a.rs")),
        )
        .await
        .expect("create file node");
        // Grid axes are forced to 0 for non-regions, so nothing downstream can
        // read a shape off a card that has no grid.
        assert_eq!((file.grid_columns, file.grid_rows), (0, 0));

        let err = detach_member(&db.conn, file.id, 1, 0.0, 0.0)
            .await
            .expect_err("a file card is not a region to detach from");
        assert!(matches!(err, DbError::Validation(_)), "got {err:?}");
    }
}
