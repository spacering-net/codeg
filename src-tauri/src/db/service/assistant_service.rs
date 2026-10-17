//! Assistants: user-defined delegation presets the composer can @-mention.
//!
//! ## Rows
//!
//! Soft-deleted only. Every reader of a mention link, delegation card or
//! delegated child resolves the assistant by id, and a deleted one must still
//! draw with its name and avatar, so [`list_all`] returns tombstones too and the
//! UI filters them out where only live assistants belong.
//!
//! ## Revisions
//!
//! Every write bumps `revision` in SQL (`revision = revision + 1`, never a
//! value computed from an earlier read) and every caller gets the whole row
//! back, read after the write. So one `(id, revision)` always names one row
//! content, which is what lets a client keep whichever copy of a row carries
//! the higher revision without ever rolling a newer one back.
//!
//! ## Writes
//!
//! No transaction here ever reads before it writes, for the reason
//! `conversation_tag_service` gives: SQLite in WAL mode cannot upgrade a read
//! snapshot another connection has written past, so a read-then-write
//! transaction fails with `SQLITE_BUSY_SNAPSHOT` under concurrent load. The
//! duplicate-name check reads first, outside any transaction; the partial
//! unique index is the backstop for two writers racing past it.

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, DbErr, EntityTrait,
    QueryFilter, QueryOrder, Set, SqlErr, TransactionTrait,
};

use crate::db::entities::assistant;
use crate::db::error::DbError;
use crate::models::assistant::ASSISTANT_AVATAR_COLORS;
use crate::models::{
    AgentType, AssistantAgentConfig, AssistantAvatar, AssistantDraft, AssistantInfo,
    AssistantLabelSnapshot, AssistantPatch,
};

/// Longest name, in characters. It is drawn on a mention chip and a card
/// header; this keeps it to something those can show.
pub const MAX_NAME_CHARS: usize = 40;
/// Longest description, in characters: one line in the mention panel, and the
/// line the delegating agent reads to decide when to use the assistant.
pub const MAX_DESCRIPTION_CHARS: usize = 200;
/// Longest standing instructions, in characters.
pub const MAX_INSTRUCTIONS_CHARS: usize = 20_000;
/// Largest decoded avatar image. The client crops and scales to 128px first,
/// which lands far below this; the limit matches custom agent icons'.
pub const MAX_AVATAR_IMAGE_BYTES: usize = 256 * 1024;
/// Largest avatar image side, in pixels.
pub const MAX_AVATAR_IMAGE_SIDE: u32 = 512;
/// Longest emoji avatar, in bytes: one grapheme, however many code points a
/// family or flag sequence takes.
pub const MAX_AVATAR_EMOJI_BYTES: usize = 64;

/// The record separator codeg's internal prompt frames are delimited by. Text
/// that ends up in a prompt never carries one of its own.
const FRAME_SEPARATOR: char = '\u{1e}';

/// Why an assistant operation was refused. Everything but `Db` is the caller's
/// input being wrong for the current state, and maps to a 4xx-style error.
#[derive(Debug, thiserror::Error)]
pub enum AssistantError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error("Assistant name cannot be empty")]
    EmptyName,
    #[error("Assistant name is longer than {MAX_NAME_CHARS} characters")]
    NameTooLong,
    #[error("An assistant named \"{0}\" already exists")]
    DuplicateName(String),
    #[error("Assistant description is longer than {MAX_DESCRIPTION_CHARS} characters")]
    DescriptionTooLong,
    #[error("Assistant instructions are longer than {MAX_INSTRUCTIONS_CHARS} characters")]
    InstructionsTooLong,
    #[error("Invalid assistant avatar: {0}")]
    InvalidAvatar(String),
    #[error("Assistant avatar image is larger than {} KiB", MAX_AVATAR_IMAGE_BYTES / 1024)]
    AvatarTooLarge,
    #[error("Invalid assistant agent options: {0}")]
    InvalidAgentConfig(String),
    #[error("Assistant {0} not found")]
    NotFound(i32),
}

impl From<DbErr> for AssistantError {
    fn from(err: DbErr) -> Self {
        AssistantError::Db(DbError::Database(err))
    }
}

/// Characters that never belong in a single line of text a prompt carries:
/// every control character (tabs and line breaks included, which callers turn
/// into spaces first) and the frame separator.
fn is_stripped_inline(c: char) -> bool {
    c.is_control() || c == FRAME_SEPARATOR
}

/// Fold a value onto one line: line breaks and tabs become spaces, every other
/// control character and the frame separator go, and the ends are trimmed.
fn single_line(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if matches!(c, '\n' | '\r' | '\t') {
                ' '
            } else {
                c
            }
        })
        .filter(|&c| !is_stripped_inline(c))
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn normalize_name(raw: &str) -> Result<String, AssistantError> {
    let name = single_line(raw);
    if name.is_empty() {
        return Err(AssistantError::EmptyName);
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AssistantError::NameTooLong);
    }
    Ok(name)
}

pub fn normalize_description(raw: &str) -> Result<String, AssistantError> {
    let description = single_line(raw);
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(AssistantError::DescriptionTooLong);
    }
    Ok(description)
}

/// Keep line breaks and tabs, drop every other control character (a `\r` of a
/// CRLF pair included) and the frame separator, and trim the ends.
pub fn normalize_instructions(raw: &str) -> Result<String, AssistantError> {
    let instructions = raw
        .chars()
        .filter(|&c| matches!(c, '\n' | '\t') || !is_stripped_inline(c))
        .collect::<String>()
        .trim()
        .to_string();
    if instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
        return Err(AssistantError::InstructionsTooLong);
    }
    Ok(instructions)
}

fn check_color(color: &str) -> Result<(), AssistantError> {
    if ASSISTANT_AVATAR_COLORS.contains(&color) {
        Ok(())
    } else {
        Err(AssistantError::InvalidAvatar(format!(
            "unknown color \"{color}\""
        )))
    }
}

/// Validate an avatar. An image must be a PNG, JPEG or WebP data URL that
/// decodes as what it claims to be, within the size limits.
pub fn validate_avatar(avatar: &AssistantAvatar) -> Result<(), AssistantError> {
    match avatar {
        AssistantAvatar::Monogram { color } => check_color(color),
        AssistantAvatar::Emoji { emoji, color } => {
            check_color(color)?;
            if emoji.is_empty()
                || emoji.len() > MAX_AVATAR_EMOJI_BYTES
                || emoji.chars().any(|c| c.is_whitespace() || c.is_control())
            {
                return Err(AssistantError::InvalidAvatar(
                    "the emoji must be one non-blank symbol".to_string(),
                ));
            }
            Ok(())
        }
        AssistantAvatar::Image { data_url } => validate_avatar_image(data_url),
    }
}

fn validate_avatar_image(data_url: &str) -> Result<(), AssistantError> {
    let invalid = |why: &str| AssistantError::InvalidAvatar(why.to_string());
    let rest = data_url
        .strip_prefix("data:image/")
        .ok_or_else(|| invalid("the image must be a data URL"))?;
    let (subtype, payload) = rest
        .split_once(";base64,")
        .ok_or_else(|| invalid("the image must be base64-encoded"))?;
    let format = match subtype {
        "png" => image::ImageFormat::Png,
        "jpeg" => image::ImageFormat::Jpeg,
        "webp" => image::ImageFormat::WebP,
        _ => return Err(invalid("the image must be a PNG, JPEG or WebP")),
    };
    // Refuse an oversized payload before decoding it at all.
    if payload.len() > MAX_AVATAR_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err(AssistantError::AvatarTooLarge);
    }
    let bytes = BASE64
        .decode(payload)
        .map_err(|_| invalid("the image is not valid base64"))?;
    if bytes.len() > MAX_AVATAR_IMAGE_BYTES {
        return Err(AssistantError::AvatarTooLarge);
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_AVATAR_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_AVATAR_IMAGE_SIDE);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| invalid("the image does not decode, or is larger than 512×512"))?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(invalid("the image is empty"));
    }
    Ok(())
}

pub fn validate_agent_config(config: &AssistantAgentConfig) -> Result<(), AssistantError> {
    config
        .validate()
        .map_err(AssistantError::InvalidAgentConfig)
}

/// An assistant's content, validated and normalized, ready to store. Create,
/// update and config-sync import all go through [`normalize_draft`], so a row
/// written by any of them obeys the same rules.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedAssistant {
    pub name: String,
    pub description: String,
    pub avatar_json: String,
    pub agent_type: String,
    pub agent_options_json: String,
    pub label_snapshot_json: String,
    pub instructions: String,
    pub enabled: bool,
}

pub fn normalize_draft(draft: &AssistantDraft) -> Result<NormalizedAssistant, AssistantError> {
    validate_avatar(&draft.avatar)?;
    validate_agent_config(&draft.agent_config)?;
    let (agent_type, agent_options_json, label_snapshot_json) =
        agent_config_columns(&draft.agent_config)?;
    Ok(NormalizedAssistant {
        name: normalize_name(&draft.name)?,
        description: normalize_description(&draft.description)?,
        avatar_json: to_json(&draft.avatar)?,
        agent_type,
        agent_options_json,
        label_snapshot_json,
        instructions: normalize_instructions(&draft.instructions)?,
        enabled: draft.enabled,
    })
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, AssistantError> {
    serde_json::to_string(value)
        .map_err(|e| AssistantError::InvalidAgentConfig(format!("does not serialize: {e}")))
}

fn agent_config_columns(
    config: &AssistantAgentConfig,
) -> Result<(String, String, String), AssistantError> {
    Ok((
        config.agent_type.as_wire().into_owned(),
        to_json(&config.agent_options)?,
        to_json(&config.label_snapshot)?,
    ))
}

/// The key two names collide on: Unicode lowercase, so "Reviewer" and
/// "REVIEWER" are one name — and so are "Ärger" and "ärger", which SQLite's
/// ASCII-only NOCASE (the unique index's fold) would let through.
pub fn name_key(name: &str) -> String {
    name.to_lowercase()
}

/// Read a stored row. A JSON column that no longer parses (hand-edited, say)
/// falls back to an empty value rather than failing every window's list; an
/// agent slug that does not parse drops the row, because running it on some
/// other agent would be worse than not offering it.
pub fn to_info(m: assistant::Model) -> Option<AssistantInfo> {
    let Some(agent_type) = AgentType::from_wire(&m.agent_type) else {
        tracing::warn!(
            "[assistant_service] assistant {} has unknown agent type {:?}; skipping it",
            m.id,
            m.agent_type
        );
        return None;
    };
    let avatar = serde_json::from_str(&m.avatar).unwrap_or_else(|e| {
        tracing::warn!(
            "[assistant_service] assistant {} avatar unreadable: {e}",
            m.id
        );
        AssistantAvatar::Monogram {
            color: "slate".to_string(),
        }
    });
    let agent_options = serde_json::from_str(&m.agent_options).unwrap_or_else(|e| {
        tracing::warn!(
            "[assistant_service] assistant {} options unreadable: {e}",
            m.id
        );
        Default::default()
    });
    let label_snapshot = serde_json::from_str(&m.label_snapshot).unwrap_or_else(|e| {
        tracing::warn!(
            "[assistant_service] assistant {} option list unreadable: {e}",
            m.id
        );
        AssistantLabelSnapshot {
            agent: agent_type.to_string(),
            ..Default::default()
        }
    });
    Some(AssistantInfo {
        id: m.id,
        uid: m.uid,
        name: m.name,
        description: m.description,
        avatar,
        agent_type,
        agent_options,
        label_snapshot,
        instructions: m.instructions,
        enabled: m.enabled,
        sort_order: m.sort_order,
        revision: m.revision,
        created_at: m.created_at,
        updated_at: m.updated_at,
        deleted_at: m.deleted_at,
    })
}

/// A unique-index violation is the live-name index (the uid one never fires:
/// uids are fresh v4s), so it means a concurrent writer took the name after
/// our own check passed.
fn duplicate_or_db(err: DbErr, name: &str) -> AssistantError {
    match err.sql_err() {
        Some(SqlErr::UniqueConstraintViolation(_)) => {
            AssistantError::DuplicateName(name.to_string())
        }
        _ => err.into(),
    }
}

fn ordered() -> sea_orm::Select<assistant::Entity> {
    assistant::Entity::find()
        .order_by_asc(assistant::Column::SortOrder)
        .order_by_asc(assistant::Column::Id)
}

async fn live_rows(conn: &DatabaseConnection) -> Result<Vec<assistant::Model>, DbErr> {
    ordered()
        .filter(assistant::Column::DeletedAt.is_null())
        .all(conn)
        .await
}

/// Refuse `name` when another live assistant already has it. `except` is the
/// assistant being renamed, which may keep its own name.
async fn ensure_name_free(
    conn: &DatabaseConnection,
    name: &str,
    except: Option<i32>,
) -> Result<(), AssistantError> {
    let key = name_key(name);
    let taken = live_rows(conn)
        .await?
        .iter()
        .any(|row| Some(row.id) != except && name_key(&row.name) == key);
    if taken {
        return Err(AssistantError::DuplicateName(name.to_string()));
    }
    Ok(())
}

/// Every assistant, tombstones included, in display order.
pub async fn list_all(conn: &DatabaseConnection) -> Result<Vec<AssistantInfo>, DbError> {
    Ok(ordered()
        .all(conn)
        .await?
        .into_iter()
        .filter_map(to_info)
        .collect())
}

/// One assistant by id, tombstone or not.
pub async fn get(conn: &DatabaseConnection, id: i32) -> Result<Option<AssistantInfo>, DbError> {
    Ok(assistant::Entity::find_by_id(id)
        .one(conn)
        .await?
        .and_then(to_info))
}

/// One assistant that can be delegated to right now: live and enabled.
pub async fn get_live_enabled(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<AssistantInfo>, DbError> {
    Ok(get(conn, id).await?.filter(|a| a.is_live() && a.enabled))
}

/// Every assistant that can be delegated to right now, in display order.
pub async fn list_live_enabled(conn: &DatabaseConnection) -> Result<Vec<AssistantInfo>, DbError> {
    Ok(live_rows(conn)
        .await?
        .into_iter()
        .filter(|row| row.enabled)
        .filter_map(to_info)
        .collect())
}

async fn read_back(conn: &DatabaseConnection, id: i32) -> Result<AssistantInfo, AssistantError> {
    get(conn, id).await?.ok_or(AssistantError::NotFound(id))
}

/// Create an assistant at the end of the list.
pub async fn create(
    conn: &DatabaseConnection,
    draft: &AssistantDraft,
) -> Result<AssistantInfo, AssistantError> {
    let row = normalize_draft(draft)?;
    ensure_name_free(conn, &row.name, None).await?;
    // A lost race here only means two assistants share a position, which the
    // `id` tie-break absorbs.
    let next_order = live_rows(conn)
        .await?
        .iter()
        .map(|a| a.sort_order)
        .max()
        .unwrap_or(0)
        + 1;
    let now = Utc::now();
    let inserted = assistant::ActiveModel {
        id: NotSet,
        uid: Set(uuid::Uuid::new_v4().to_string()),
        name: Set(row.name.clone()),
        description: Set(row.description),
        avatar: Set(row.avatar_json),
        agent_type: Set(row.agent_type),
        agent_options: Set(row.agent_options_json),
        label_snapshot: Set(row.label_snapshot_json),
        instructions: Set(row.instructions),
        enabled: Set(row.enabled),
        sort_order: Set(next_order),
        // The insert is the row's first write.
        revision: Set(1),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
    }
    .insert(conn)
    .await
    .map_err(|e| duplicate_or_db(e, &row.name))?;
    read_back(conn, inserted.id).await
}

/// Apply an edit to a live assistant. Absent fields stay as they are; an edit
/// with nothing in it returns the row unchanged.
pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    patch: &AssistantPatch,
) -> Result<AssistantInfo, AssistantError> {
    let name = patch.name.as_deref().map(normalize_name).transpose()?;
    let description = patch
        .description
        .as_deref()
        .map(normalize_description)
        .transpose()?;
    let instructions = patch
        .instructions
        .as_deref()
        .map(normalize_instructions)
        .transpose()?;
    let avatar = match &patch.avatar {
        Some(avatar) => {
            validate_avatar(avatar)?;
            Some(to_json(avatar)?)
        }
        None => None,
    };
    let agent = match &patch.agent_config {
        Some(config) => {
            validate_agent_config(config)?;
            Some(agent_config_columns(config)?)
        }
        None => None,
    };

    let current = get(conn, id)
        .await?
        .filter(AssistantInfo::is_live)
        .ok_or(AssistantError::NotFound(id))?;
    if patch.is_empty() {
        return Ok(current);
    }
    if let Some(ref name) = name {
        ensure_name_free(conn, name, Some(id)).await?;
    }

    let mut query = assistant::Entity::update_many()
        .col_expr(
            assistant::Column::Revision,
            Expr::col(assistant::Column::Revision).add(1),
        )
        .col_expr(assistant::Column::UpdatedAt, Expr::value(Utc::now()));
    if let Some(ref name) = name {
        query = query.col_expr(assistant::Column::Name, Expr::value(name.clone()));
    }
    if let Some(description) = description {
        query = query.col_expr(assistant::Column::Description, Expr::value(description));
    }
    if let Some(avatar) = avatar {
        query = query.col_expr(assistant::Column::Avatar, Expr::value(avatar));
    }
    if let Some((agent_type, options, labels)) = agent {
        query = query
            .col_expr(assistant::Column::AgentType, Expr::value(agent_type))
            .col_expr(assistant::Column::AgentOptions, Expr::value(options))
            .col_expr(assistant::Column::LabelSnapshot, Expr::value(labels));
    }
    if let Some(instructions) = instructions {
        query = query.col_expr(assistant::Column::Instructions, Expr::value(instructions));
    }
    if let Some(enabled) = patch.enabled {
        query = query.col_expr(assistant::Column::Enabled, Expr::value(enabled));
    }
    let result = query
        .filter(assistant::Column::Id.eq(id))
        .filter(assistant::Column::DeletedAt.is_null())
        .exec(conn)
        .await
        .map_err(|e| duplicate_or_db(e, name.as_deref().unwrap_or_default()))?;
    if result.rows_affected == 0 {
        // Deleted since the read above.
        return Err(AssistantError::NotFound(id));
    }
    read_back(conn, id).await
}

/// Soft-delete a live assistant and return its tombstone. Its name is kept —
/// historical cards draw it — but freed for a new assistant to take.
pub async fn soft_delete(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<AssistantInfo, AssistantError> {
    let now = Utc::now();
    let result = assistant::Entity::update_many()
        .col_expr(
            assistant::Column::Revision,
            Expr::col(assistant::Column::Revision).add(1),
        )
        .col_expr(assistant::Column::UpdatedAt, Expr::value(now))
        .col_expr(assistant::Column::DeletedAt, Expr::value(now))
        .filter(assistant::Column::Id.eq(id))
        .filter(assistant::Column::DeletedAt.is_null())
        .exec(conn)
        .await?;
    if result.rows_affected == 0 {
        return Err(AssistantError::NotFound(id));
    }
    read_back(conn, id).await
}

/// Persist an order: each live id gets its position in `ordered_ids`
/// (1-based). The client sends the complete list after a drag; ids that are
/// unknown or deleted match no row. Returns the rows whose position actually
/// changed, read back after the write — the only ones whose revision moved.
pub async fn reorder(
    conn: &DatabaseConnection,
    ordered_ids: &[i32],
) -> Result<Vec<AssistantInfo>, AssistantError> {
    let current: HashMap<i32, i32> = live_rows(conn)
        .await?
        .into_iter()
        .map(|row| (row.id, row.sort_order))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let moves: Vec<(i32, i32)> = ordered_ids
        .iter()
        .copied()
        .filter(|id| current.contains_key(id) && seen.insert(*id))
        .enumerate()
        .map(|(idx, id)| (id, idx as i32 + 1))
        .filter(|(id, position)| current.get(id) != Some(position))
        .collect();
    if moves.is_empty() {
        return Ok(Vec::new());
    }

    let changed: Vec<i32> = moves.iter().map(|(id, _)| *id).collect();
    conn.transaction::<_, (), DbErr>(|txn| {
        Box::pin(async move {
            let now = Utc::now();
            for (id, position) in moves {
                assistant::Entity::update_many()
                    .col_expr(assistant::Column::SortOrder, Expr::value(position))
                    .col_expr(
                        assistant::Column::Revision,
                        Expr::col(assistant::Column::Revision).add(1),
                    )
                    .col_expr(assistant::Column::UpdatedAt, Expr::value(now))
                    .filter(assistant::Column::Id.eq(id))
                    .filter(assistant::Column::DeletedAt.is_null())
                    .exec(txn)
                    .await?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| match e {
        sea_orm::TransactionError::Connection(e) | sea_orm::TransactionError::Transaction(e) => {
            AssistantError::from(e)
        }
    })?;

    let mut rows: Vec<AssistantInfo> = assistant::Entity::find()
        .filter(assistant::Column::Id.is_in(changed))
        .all(conn)
        .await?
        .into_iter()
        .filter_map(to_info)
        .collect();
    rows.sort_by_key(|a| (a.sort_order, a.id));
    Ok(rows)
}

// ─── Config sync ──────────────────────────────────────────────────────

/// `base`, or the first of "base (2)", "base (3)", … whose name key is not in
/// `taken` — the base shortened as needed to stay within the name limit. The
/// same inputs always give the same name, so importing one snapshot twice
/// names its rows the same way both times.
pub fn deduplicated_name(base: &str, taken: &std::collections::HashSet<String>) -> String {
    if !taken.contains(&name_key(base)) {
        return base.to_string();
    }
    (2u32..)
        .map(|n| {
            let suffix = format!(" ({n})");
            let room = MAX_NAME_CHARS.saturating_sub(suffix.chars().count());
            let head: String = base.chars().take(room).collect();
            format!("{}{suffix}", head.trim_end())
        })
        .find(|candidate| !taken.contains(&name_key(candidate)))
        .expect("an unbounded sequence of distinct names has a free one")
}

/// One assistant as a configuration snapshot carries it, already validated
/// through [`normalize_draft`] — the rule every other write obeys.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedAssistant {
    /// The natural key rows are matched by across machines.
    pub uid: String,
    pub row: NormalizedAssistant,
    pub sort_order: i32,
}

/// What [`import_into`] wrote.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ImportOutcome {
    pub written: usize,
    /// Rows stored under another name than the snapshot's, because a different
    /// live assistant here already had it.
    pub renamed: usize,
}

/// Upsert snapshot rows by `uid` inside the config-sync transaction: a match
/// is overwritten (and brought back if it had been deleted here — the
/// snapshot says it exists), anything else is inserted. Nothing is deleted.
/// Every written row's revision moves on in SQL, so a client merging by
/// revision takes it over whatever it held. A `uid` the batch repeats is
/// written once, with its last entry.
///
/// Names are settled for the whole batch before anything is written: each
/// row keeps the snapshot's name unless an assistant the batch does NOT write
/// — or a row earlier in the batch — already has it, and then gets
/// [`deduplicated_name`]. So the outcome depends only on the snapshot and on
/// the rows it leaves alone, never on the names its own rows held before:
/// importing a snapshot twice gives the same names, and re-applying the
/// rollback snapshot taken before an import puts every name back, swaps
/// included. The rows' current names are cleared to placeholders first, so a
/// swap never trips the live-name unique index half way.
///
/// Unlike the rest of this module this reads before it writes inside one
/// transaction: it is the config-sync apply's own transaction, which every
/// domain shares.
pub async fn import_into(
    tx: &sea_orm::DatabaseTransaction,
    rows: Vec<ImportedAssistant>,
) -> Result<ImportOutcome, DbErr> {
    // Last entry per uid, in the order the uids first appear.
    let mut batch: Vec<ImportedAssistant> = Vec::with_capacity(rows.len());
    for row in rows {
        match batch.iter_mut().find(|held| held.uid == row.uid) {
            Some(held) => *held = row,
            None => batch.push(row),
        }
    }
    if batch.is_empty() {
        return Ok(ImportOutcome::default());
    }

    let uids: Vec<String> = batch.iter().map(|row| row.uid.clone()).collect();
    let matched: HashMap<String, assistant::Model> = assistant::Entity::find()
        .filter(assistant::Column::Uid.is_in(uids))
        .all(tx)
        .await?
        .into_iter()
        .map(|row| (row.uid.clone(), row))
        .collect();
    let written_ids: std::collections::HashSet<i32> = matched.values().map(|row| row.id).collect();
    let mut taken: std::collections::HashSet<String> = assistant::Entity::find()
        .filter(assistant::Column::DeletedAt.is_null())
        .all(tx)
        .await?
        .into_iter()
        .filter(|row| !written_ids.contains(&row.id))
        .map(|row| name_key(&row.name))
        .collect();
    let names: Vec<String> = batch
        .iter()
        .map(|row| {
            let name = deduplicated_name(&row.row.name, &taken);
            taken.insert(name_key(&name));
            name
        })
        .collect();

    // Free the names the batch's live rows hold. A control character never
    // survives `normalize_name`, so no assistant can be called this, and the
    // row id makes each placeholder unique — under the index's case folding
    // too, which two uids differing only in case would not be.
    for row in matched.values().filter(|row| row.deleted_at.is_none()) {
        assistant::Entity::update_many()
            .col_expr(
                assistant::Column::Name,
                Expr::value(format!("\u{1}import:{}", row.id)),
            )
            .filter(assistant::Column::Id.eq(row.id))
            .exec(tx)
            .await?;
    }

    let mut outcome = ImportOutcome::default();
    let now = Utc::now();
    for (imported, name) in batch.into_iter().zip(names) {
        if name != imported.row.name {
            outcome.renamed += 1;
        }
        let row = imported.row;
        match matched.get(&imported.uid).map(|existing| existing.id) {
            Some(id) => {
                assistant::Entity::update_many()
                    .col_expr(assistant::Column::Name, Expr::value(name))
                    .col_expr(assistant::Column::Description, Expr::value(row.description))
                    .col_expr(assistant::Column::Avatar, Expr::value(row.avatar_json))
                    .col_expr(assistant::Column::AgentType, Expr::value(row.agent_type))
                    .col_expr(
                        assistant::Column::AgentOptions,
                        Expr::value(row.agent_options_json),
                    )
                    .col_expr(
                        assistant::Column::LabelSnapshot,
                        Expr::value(row.label_snapshot_json),
                    )
                    .col_expr(
                        assistant::Column::Instructions,
                        Expr::value(row.instructions),
                    )
                    .col_expr(assistant::Column::Enabled, Expr::value(row.enabled))
                    .col_expr(
                        assistant::Column::SortOrder,
                        Expr::value(imported.sort_order),
                    )
                    .col_expr(
                        assistant::Column::DeletedAt,
                        Expr::value(Option::<chrono::DateTime<Utc>>::None),
                    )
                    .col_expr(
                        assistant::Column::Revision,
                        Expr::col(assistant::Column::Revision).add(1),
                    )
                    .col_expr(assistant::Column::UpdatedAt, Expr::value(now))
                    .filter(assistant::Column::Id.eq(id))
                    .exec(tx)
                    .await?;
            }
            None => {
                assistant::ActiveModel {
                    id: NotSet,
                    uid: Set(imported.uid),
                    name: Set(name),
                    description: Set(row.description),
                    avatar: Set(row.avatar_json),
                    agent_type: Set(row.agent_type),
                    agent_options: Set(row.agent_options_json),
                    label_snapshot: Set(row.label_snapshot_json),
                    instructions: Set(row.instructions),
                    enabled: Set(row.enabled),
                    sort_order: Set(imported.sort_order),
                    revision: Set(1),
                    created_at: Set(now),
                    updated_at: Set(now),
                    deleted_at: Set(None),
                }
                .insert(tx)
                .await?;
            }
        }
        outcome.written += 1;
    }
    Ok(outcome)
}

/// Every live assistant as a configuration snapshot carries it, in display
/// order, with the stored row content. A row whose stored agent no longer
/// parses is left out, as everywhere else ([`to_info`]).
pub async fn live_rows_for_export(conn: &DatabaseConnection) -> Result<Vec<AssistantInfo>, DbErr> {
    Ok(live_rows(conn)
        .await?
        .into_iter()
        .filter_map(to_info)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::models::assistant::selection;
    use crate::models::{AssistantOptionKind, AssistantOptionLabel};

    /// A 1×1 PNG, the smallest image that decodes.
    fn tiny_png_data_url() -> String {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([10, 20, 30, 255]),
        ))
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("encode png");
        format!("data:image/png;base64,{}", BASE64.encode(bytes))
    }

    fn codex_config(effort: &str) -> AssistantAgentConfig {
        AssistantAgentConfig {
            agent_type: AgentType::Codex,
            agent_options: selection(None, &[("model", "gpt-5.5"), ("effort", effort)]),
            label_snapshot: AssistantLabelSnapshot {
                agent: "Codex CLI".to_string(),
                mode: None,
                options: vec![
                    AssistantOptionLabel {
                        id: "model".to_string(),
                        kind: AssistantOptionKind::Select,
                        name: "Model".to_string(),
                        value_label: "GPT-5.5".to_string(),
                    },
                    AssistantOptionLabel {
                        id: "effort".to_string(),
                        kind: AssistantOptionKind::Select,
                        name: "Effort".to_string(),
                        value_label: effort.to_string(),
                    },
                ],
            },
        }
    }

    fn draft(name: &str) -> AssistantDraft {
        AssistantDraft {
            name: name.to_string(),
            description: "Reviews diffs".to_string(),
            avatar: AssistantAvatar::Monogram {
                color: "violet".to_string(),
            },
            agent_config: codex_config("high"),
            instructions: "Be terse.".to_string(),
            enabled: true,
        }
    }

    #[test]
    fn a_taken_name_gets_the_first_free_number_within_the_limit() {
        let taken = |names: &[&str]| {
            names
                .iter()
                .map(|n| name_key(n))
                .collect::<std::collections::HashSet<_>>()
        };
        assert_eq!(deduplicated_name("Reviewer", &taken(&[])), "Reviewer");
        assert_eq!(
            deduplicated_name("Reviewer", &taken(&["REVIEWER"])),
            "Reviewer (2)"
        );
        assert_eq!(
            deduplicated_name("Ärger", &taken(&["ärger", "ärger (2)"])),
            "Ärger (3)"
        );
        // Shortened to fit, by characters, never splitting one.
        let long = "名".repeat(MAX_NAME_CHARS);
        let renamed = deduplicated_name(&long, &taken(&[&long]));
        assert_eq!(renamed.chars().count(), MAX_NAME_CHARS);
        assert_eq!(renamed, format!("{} (2)", "名".repeat(MAX_NAME_CHARS - 4)));
        assert!(normalize_name(&renamed).is_ok());
    }

    #[tokio::test]
    async fn create_lists_and_reads_back_the_whole_row() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, &draft("Reviewer")).await.expect("create");
        assert_eq!(a.revision, 1);
        assert_eq!(a.sort_order, 1);
        assert_eq!(a.agent_type, AgentType::Codex);
        assert_eq!(a.agent_options, codex_config("high").agent_options);
        assert_eq!(a.label_snapshot, codex_config("high").label_snapshot);
        assert!(uuid::Uuid::parse_str(&a.uid).is_ok());
        assert!(a.is_live() && a.enabled);

        let b = create(&db.conn, &draft("Writer")).await.expect("create");
        assert_eq!(b.sort_order, 2, "new assistants go to the end");
        assert_eq!(list_all(&db.conn).await.unwrap(), vec![a.clone(), b]);
        assert_eq!(get(&db.conn, a.id).await.unwrap(), Some(a));
    }

    #[tokio::test]
    async fn names_are_unique_among_live_assistants_regardless_of_case() {
        let db = fresh_in_memory_db().await;
        let first = create(&db.conn, &draft("Reviewer")).await.expect("create");
        assert!(matches!(
            create(&db.conn, &draft("reviewer")).await,
            Err(AssistantError::DuplicateName(_))
        ));
        // Unicode folding, which the index's ASCII NOCASE alone would miss.
        create(&db.conn, &draft("Ärger")).await.expect("create");
        assert!(matches!(
            create(&db.conn, &draft("ärger")).await,
            Err(AssistantError::DuplicateName(_))
        ));

        // A deleted assistant's name is free again; the tombstone keeps it.
        soft_delete(&db.conn, first.id).await.expect("delete");
        let again = create(&db.conn, &draft("Reviewer"))
            .await
            .expect("reuse name");
        assert_ne!(again.id, first.id);
        let tomb = get(&db.conn, first.id).await.unwrap().unwrap();
        assert_eq!(tomb.name, "Reviewer");
        assert!(tomb.deleted_at.is_some());
    }

    #[tokio::test]
    async fn the_index_backstops_a_race_past_the_name_check() {
        let db = fresh_in_memory_db().await;
        create(&db.conn, &draft("Reviewer")).await.expect("create");
        // What a writer that passed the check before the first insert landed
        // would do next: insert straight away.
        let err = assistant::ActiveModel {
            id: NotSet,
            uid: Set(uuid::Uuid::new_v4().to_string()),
            name: Set("REVIEWER".to_string()),
            description: Set(String::new()),
            avatar: Set("{}".to_string()),
            agent_type: Set("codex".to_string()),
            agent_options: Set("{}".to_string()),
            label_snapshot: Set("{}".to_string()),
            instructions: Set(String::new()),
            enabled: Set(true),
            sort_order: Set(2),
            revision: Set(1),
            created_at: Set(Utc::now()),
            updated_at: Set(Utc::now()),
            deleted_at: Set(None),
        }
        .insert(&db.conn)
        .await
        .expect_err("index refuses the duplicate");
        assert!(matches!(
            duplicate_or_db(err, "REVIEWER"),
            AssistantError::DuplicateName(_)
        ));
    }

    #[tokio::test]
    async fn every_write_bumps_the_revision_and_returns_the_row_it_wrote() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, &draft("Reviewer")).await.expect("create");

        let renamed = update(
            &db.conn,
            a.id,
            &AssistantPatch {
                name: Some("  Code reviewer ".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("rename");
        assert_eq!(renamed.revision, 2);
        assert_eq!(renamed.name, "Code reviewer");
        // Only the named field moved.
        assert_eq!(renamed.instructions, a.instructions);
        assert_eq!(renamed.agent_options, a.agent_options);

        let moved = update(
            &db.conn,
            a.id,
            &AssistantPatch {
                agent_config: Some(codex_config("low")),
                enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .expect("change options");
        assert_eq!(moved.revision, 3);
        assert_eq!(moved.agent_options, codex_config("low").agent_options);
        assert_eq!(moved.label_snapshot, codex_config("low").label_snapshot);
        assert!(!moved.enabled);
        assert_eq!(moved.name, "Code reviewer");

        let unchanged = update(&db.conn, a.id, &AssistantPatch::default())
            .await
            .expect("empty edit");
        assert_eq!(unchanged, moved, "an empty edit writes nothing");

        let tomb = soft_delete(&db.conn, a.id).await.expect("delete");
        assert_eq!(tomb.revision, 4);
        assert!(tomb.deleted_at.is_some());
    }

    #[tokio::test]
    async fn an_edit_without_options_keeps_the_saved_selection() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, &draft("Reviewer")).await.expect("create");
        let edited = update(
            &db.conn,
            a.id,
            &AssistantPatch {
                instructions: Some("Cite line numbers.".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("edit");
        assert_eq!(edited.agent_type, a.agent_type);
        assert_eq!(edited.agent_options, a.agent_options);
        assert_eq!(edited.label_snapshot, a.label_snapshot);
    }

    #[tokio::test]
    async fn a_deleted_assistant_cannot_be_edited_or_deleted_again() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, &draft("Reviewer")).await.expect("create");
        soft_delete(&db.conn, a.id).await.expect("delete");
        let rename = AssistantPatch {
            name: Some("Other".to_string()),
            ..Default::default()
        };
        assert!(matches!(
            update(&db.conn, a.id, &rename).await,
            Err(AssistantError::NotFound(_))
        ));
        assert!(matches!(
            soft_delete(&db.conn, a.id).await,
            Err(AssistantError::NotFound(_))
        ));
        assert!(matches!(
            update(&db.conn, 999, &rename).await,
            Err(AssistantError::NotFound(999))
        ));
    }

    #[tokio::test]
    async fn renaming_onto_another_live_name_is_refused_but_keeping_ones_own_is_not() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, &draft("Reviewer")).await.expect("create");
        create(&db.conn, &draft("Writer")).await.expect("create");
        assert!(matches!(
            update(
                &db.conn,
                a.id,
                &AssistantPatch {
                    name: Some("writer".to_string()),
                    ..Default::default()
                }
            )
            .await,
            Err(AssistantError::DuplicateName(_))
        ));
        update(
            &db.conn,
            a.id,
            &AssistantPatch {
                name: Some("REVIEWER".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("a case change of its own name");
    }

    #[tokio::test]
    async fn reorder_renumbers_and_returns_only_the_rows_that_moved() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, &draft("A")).await.unwrap();
        let b = create(&db.conn, &draft("B")).await.unwrap();
        let c = create(&db.conn, &draft("C")).await.unwrap();

        // Swap A and B; C keeps position 3. Unknown and duplicate ids are
        // ignored.
        let moved = reorder(&db.conn, &[b.id, a.id, 999, b.id, c.id])
            .await
            .expect("reorder");
        assert_eq!(
            moved
                .iter()
                .map(|r| (r.id, r.sort_order, r.revision))
                .collect::<Vec<_>>(),
            vec![(b.id, 1, 2), (a.id, 2, 2)]
        );
        let order: Vec<i32> = list_all(&db.conn)
            .await
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(order, vec![b.id, a.id, c.id]);
        assert_eq!(get(&db.conn, c.id).await.unwrap().unwrap().revision, 1);

        assert!(reorder(&db.conn, &[b.id, a.id, c.id])
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn only_live_enabled_assistants_can_be_delegated_to() {
        let db = fresh_in_memory_db().await;
        let live = create(&db.conn, &draft("Live")).await.unwrap();
        let off = create(
            &db.conn,
            &AssistantDraft {
                enabled: false,
                ..draft("Off")
            },
        )
        .await
        .unwrap();
        let gone = create(&db.conn, &draft("Gone")).await.unwrap();
        soft_delete(&db.conn, gone.id).await.unwrap();

        let ids: Vec<i32> = list_live_enabled(&db.conn)
            .await
            .unwrap()
            .iter()
            .map(|a| a.id)
            .collect();
        assert_eq!(ids, vec![live.id]);
        assert!(get_live_enabled(&db.conn, live.id).await.unwrap().is_some());
        assert!(get_live_enabled(&db.conn, off.id).await.unwrap().is_none());
        assert!(get_live_enabled(&db.conn, gone.id).await.unwrap().is_none());
        assert_eq!(list_all(&db.conn).await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn an_incomplete_selection_is_refused_before_anything_is_written() {
        let db = fresh_in_memory_db().await;
        let mut incomplete = draft("Reviewer");
        incomplete
            .agent_config
            .agent_options
            .config_values
            .remove("effort");
        assert!(matches!(
            create(&db.conn, &incomplete).await,
            Err(AssistantError::InvalidAgentConfig(_))
        ));
        assert!(list_all(&db.conn).await.unwrap().is_empty());
    }

    #[test]
    fn text_fields_are_normalized_and_bounded() {
        assert_eq!(
            normalize_name("  Re\nviewer\u{1e}\t ").unwrap(),
            "Re viewer"
        );
        assert!(matches!(
            normalize_name(" \n "),
            Err(AssistantError::EmptyName)
        ));
        assert!(normalize_name(&"名".repeat(MAX_NAME_CHARS)).is_ok());
        assert!(matches!(
            normalize_name(&"名".repeat(MAX_NAME_CHARS + 1)),
            Err(AssistantError::NameTooLong)
        ));

        assert_eq!(
            normalize_description("Reviews\r\ndiffs\u{7}").unwrap(),
            "Reviews  diffs"
        );
        assert!(normalize_description(&"x".repeat(MAX_DESCRIPTION_CHARS + 1)).is_err());

        assert_eq!(
            normalize_instructions("\n- one\r\n\t- two\u{1e}\u{0}\n").unwrap(),
            "- one\n\t- two"
        );
        assert!(normalize_instructions(&"x".repeat(MAX_INSTRUCTIONS_CHARS + 1)).is_err());
    }

    #[test]
    fn avatars_are_validated_by_kind() {
        let mono = |color: &str| AssistantAvatar::Monogram {
            color: color.to_string(),
        };
        assert!(validate_avatar(&mono("teal")).is_ok());
        assert!(validate_avatar(&mono("#ff0000")).is_err());

        let emoji = |e: &str| AssistantAvatar::Emoji {
            emoji: e.to_string(),
            color: "amber".to_string(),
        };
        assert!(validate_avatar(&emoji("🦉")).is_ok());
        assert!(validate_avatar(&emoji("👨‍👩‍👧‍👦")).is_ok());
        assert!(validate_avatar(&emoji("")).is_err());
        assert!(validate_avatar(&emoji("a b")).is_err());
        assert!(validate_avatar(&emoji(&"🦉".repeat(17))).is_err());

        let image = |url: String| AssistantAvatar::Image { data_url: url };
        assert!(validate_avatar(&image(tiny_png_data_url())).is_ok());
        // Claims JPEG, carries PNG bytes.
        let mislabeled = tiny_png_data_url().replace("image/png", "image/jpeg");
        assert!(validate_avatar(&image(mislabeled)).is_err());
        assert!(validate_avatar(&image("data:image/gif;base64,R0lGOD".to_string())).is_err());
        assert!(validate_avatar(&image("https://example.com/a.png".to_string())).is_err());
        assert!(validate_avatar(&image("data:image/png;base64,!!!".to_string())).is_err());
        let huge = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_AVATAR_IMAGE_BYTES.div_ceil(3) * 4 + 4)
        );
        assert!(matches!(
            validate_avatar(&image(huge)),
            Err(AssistantError::AvatarTooLarge)
        ));
    }

    /// What the editor uploads: a canvas encodes WebP LOSSY (a `VP8 ` chunk —
    /// the image crate's own encoder only writes lossless, so the sample is a
    /// fixed 4×4 one), falling back to PNG or JPEG.
    #[test]
    fn every_encoding_the_editor_sends_is_accepted() {
        const LOSSY_WEBP: &str = "UklGRmAAAABXRUJQVlA4IFQAAAAwAgCdASoEAAQAAUAmJbACdLoAd6qDX/gcgAD+43eRnLUD5Efbu5+c4PLAT2ImrsMhRGZ/tapBQ74+/f1ySnykmrgRfSP8EVv+DZg5dX4nfoXcAAA=";
        let image = |url: String| AssistantAvatar::Image { data_url: url };
        assert!(validate_avatar(&image(format!("data:image/webp;base64,{LOSSY_WEBP}"))).is_ok());

        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            128,
            128,
            image::Rgb([10, 20, 30]),
        ))
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .expect("encode jpeg");
        let url = format!("data:image/jpeg;base64,{}", BASE64.encode(jpeg));
        assert!(validate_avatar(&image(url)).is_ok());
    }

    #[test]
    fn an_oversized_image_side_is_refused() {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::new(MAX_AVATAR_IMAGE_SIDE + 1, 1))
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .expect("encode png");
        let url = format!("data:image/png;base64,{}", BASE64.encode(bytes));
        assert!(validate_avatar(&AssistantAvatar::Image { data_url: url }).is_err());
    }

    #[test]
    fn an_unreadable_column_falls_back_but_an_unknown_agent_drops_the_row() {
        let now = Utc::now();
        let row = assistant::Model {
            id: 1,
            uid: "u".to_string(),
            name: "Reviewer".to_string(),
            description: String::new(),
            avatar: "not json".to_string(),
            agent_type: "codex".to_string(),
            agent_options: "not json".to_string(),
            label_snapshot: "not json".to_string(),
            instructions: String::new(),
            enabled: true,
            sort_order: 1,
            revision: 1,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        };
        let info = to_info(row.clone()).expect("still readable");
        assert!(matches!(info.avatar, AssistantAvatar::Monogram { .. }));
        assert!(info.agent_options.is_empty());
        assert!(info.label_snapshot.options.is_empty());

        let unknown = assistant::Model {
            agent_type: "no_such_agent".to_string(),
            ..row
        };
        assert!(to_info(unknown).is_none());
    }
}
