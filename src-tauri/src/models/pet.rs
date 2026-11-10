//! Desktop-pet data model.
//!
//! Field shapes mirror the Codex `/pet` + `/hatch` format so a directory under
//! `~/.codex/pets/<id>/` can be copied verbatim into `~/.codeg/pets/<id>/` and
//! work without further translation.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Sprite-sheet geometry. The grid is a fixed 8 columns with a constant
/// 192×208 frame cell; only the row count varies. The base Codex format is
/// 9 rows (1536×1872), while v2 marketplace pets append two animation rows
/// for 11 rows (1536×2288). Height therefore grows in whole 208px steps and
/// is validated per sheet rather than pinned to a single value.
pub const SPRITE_SHEET_WIDTH: u32 = 1536;
/// Height of the base 9-row sheet. Treated as the canonical *minimum*; taller
/// sheets are accepted as long as the height is a whole multiple of a row.
pub const SPRITE_SHEET_HEIGHT: u32 = 1872;
#[allow(dead_code)]
pub const SPRITE_GRID_COLS: u32 = 8;
/// Row count of the base format, i.e. the minimum number of rows a sheet must
/// carry (all base animation states). Newer sheets append rows beyond this.
pub const SPRITE_GRID_ROWS: u32 = 9;
#[allow(dead_code)]
pub const SPRITE_FRAME_WIDTH: u32 = SPRITE_SHEET_WIDTH / SPRITE_GRID_COLS; // 192
pub const SPRITE_FRAME_HEIGHT: u32 = SPRITE_SHEET_HEIGHT / SPRITE_GRID_ROWS; // 208

/// Filename codex writes inside each pet directory. Stored as a relative path
/// in `pet.json::spritesheetPath`; we resolve it against the pet directory.
pub const SPRITESHEET_FILENAME: &str = "spritesheet.webp";
pub const PET_MANIFEST_FILENAME: &str = "pet.json";

/// Animation rows in the spritesheet, top-to-bottom, mirroring the
/// openai/skills `animation-rows.md` ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PetState {
    #[default]
    Idle,
    RunningRight,
    RunningLeft,
    Waving,
    Jumping,
    Failed,
    Waiting,
    Running,
    Review,
}

impl PetState {
    pub const fn row(self) -> u8 {
        match self {
            PetState::Idle => 0,
            PetState::RunningRight => 1,
            PetState::RunningLeft => 2,
            PetState::Waving => 3,
            PetState::Jumping => 4,
            PetState::Failed => 5,
            PetState::Waiting => 6,
            PetState::Running => 7,
            PetState::Review => 8,
        }
    }
}

/// Persisted manifest. Field names match Codex's `pet.json` so the file is
/// byte-compatible (modulo formatting whitespace).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetManifest {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Codex always writes `"spritesheet.webp"` here. We keep the field for
    /// round-trip compatibility but ignore the value when locating the asset
    /// (see `SPRITESHEET_FILENAME`).
    pub spritesheet_path: String,
    /// Any additional manifest fields the upstream format carries (e.g.
    /// `spriteVersionNumber`, `kind`). Captured verbatim so install/edit
    /// round-trips preserve metadata newer formats introduce instead of
    /// silently dropping it.
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Flattened summary returned to the frontend's pet list / picker.
/// `spritesheet_path` is an *absolute* filesystem path so the frontend can
/// pass it back to a `read_pet_spritesheet` command without re-resolving.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSummary {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub spritesheet_path: PathBuf,
}

/// Full pet metadata + asset path, returned by `pet_get`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetDetail {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub spritesheet_path: PathBuf,
}

/// Asset payload streamed to the renderer. WebP is preferred; PNG is
/// returned as-is when the user supplies a PNG sheet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSpriteAsset {
    pub mime: String,
    pub data_base64: String,
}

/// Input payload for `pet_add`. The frontend reads the file with the Tauri
/// dialog/file API, base64-encodes the bytes, and submits the rest as
/// metadata. The backend re-validates everything.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPetInput {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Raw bytes of the spritesheet, base64-encoded. May be PNG or WebP.
    pub spritesheet_base64: String,
}

/// Patch payload for `pet_update_meta`. Only mutable fields are exposed; the
/// `id` is a primary key and renaming = recreate.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetMetaPatch {
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<Option<String>>,
}

/// One importable Codex pet seen on disk under `~/.codex/pets/`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportablePet {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub source_path: PathBuf,
    /// True when an entry of the same id already exists in `~/.codeg/pets/`.
    pub already_imported: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCodexPetsRequest {
    /// Subset of ids returned by `pet_list_importable_codex`. Empty = all.
    #[serde(default)]
    pub ids: Vec<String>,
    /// When true, conflicting ids get an `-imported` suffix; otherwise the
    /// import for that id is skipped and reported in `skipped`.
    #[serde(default)]
    pub overwrite_with_suffix: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCodexPetsResult {
    pub imported_ids: Vec<String>,
    pub skipped: Vec<ImportSkipped>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkipped {
    pub source_id: String,
    pub reason: String,
}

/// Subset of `PetState` rows that the backend ever broadcasts on the
/// `pet://oneshot` channel: the celebration / failure cues that the pet
/// renderer plays as transient overlays on top of the ambient state.
/// Frontend `usePetOneShot` filters identically; we narrow the type at
/// the API boundary so callers can't accidentally trigger an ambient
/// row (e.g. `running`) as a one-shot.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PetCelebrationKind {
    Jumping,
    Waving,
    Failed,
}

impl From<PetCelebrationKind> for PetState {
    fn from(kind: PetCelebrationKind) -> Self {
        match kind {
            PetCelebrationKind::Jumping => PetState::Jumping,
            PetCelebrationKind::Waving => PetState::Waving,
            PetCelebrationKind::Failed => PetState::Failed,
        }
    }
}

/// Persisted UI state for the pet feature. JSON-serialized into the
/// `app_metadata` KV table under `pet.config`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWindowConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub active_pet_id: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default = "default_scale")]
    pub scale: f64,
    #[serde(default = "default_always_on_top")]
    pub always_on_top: bool,
}

fn default_scale() -> f64 {
    0.75
}

fn default_always_on_top() -> bool {
    true
}

impl Default for PetWindowConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            active_pet_id: None,
            x: None,
            y: None,
            scale: 0.75,
            always_on_top: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWindowStatePatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub scale: Option<f64>,
    pub always_on_top: Option<bool>,
    pub enabled: Option<bool>,
}

// ─── active-session list (pet panel) ────────────────────────────────────

/// Compact view of a pending permission request, surfaced to the pet panel so
/// the user can approve/reject without switching to the main window.
///
/// `tool_call` is the agent's raw JSON forwarded verbatim — identical to what
/// the main permission dialog receives — so the panel can reuse
/// `parsePermissionToolCall` to render the shell command / diff / plan preview.
/// The owning `connection_id` lives on the parent [`PetSessionEntry`] (one
/// connection ↔ at most one pending permission), so it isn't duplicated here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPermissionSummary {
    pub request_id: String,
    pub tool_call: serde_json::Value,
    pub options: Vec<crate::acp::types::PermissionOptionInfo>,
}

impl From<&crate::acp::session_state::PendingPermissionState> for PetPermissionSummary {
    fn from(p: &crate::acp::session_state::PendingPermissionState) -> Self {
        Self {
            request_id: p.request_id.clone(),
            tool_call: p.tool_call.clone(),
            options: p.options.clone(),
        }
    }
}

/// Where a delegation sub-agent row belongs. Present ONLY on rows whose
/// conversation has a `parent_id` — i.e. a sub-agent the panel is showing
/// because it is blocked on the user (see `pet_list_active_sessions_core`).
///
/// The panel needs the parent's ids (not the child's) for its jump target: a
/// delegation child is never openable as a tab, so clicking the row focuses the
/// conversation that delegated it. `title` names that parent so the row reads
/// as "sub-agent of «…»" rather than as a session the user doesn't recognize.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetParentRef {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: crate::models::agent::AgentType,
    pub title: String,
}

/// One active agent session as shown in the pet panel's list. "Active" means
/// the connection is currently prompting, awaiting a permission, or errored —
/// see `ConnectionManager::list_active_sessions`. `title` is resolved from the
/// conversation row by the command layer; the manager leaves it empty.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSessionEntry {
    pub connection_id: String,
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: crate::models::agent::AgentType,
    pub title: String,
    pub status: crate::acp::types::ConnectionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<PetPermissionSummary>,
    /// Set iff this row is a delegation sub-agent (see [`PetParentRef`]).
    /// Absent for ordinary sessions, which are their own jump target.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<PetParentRef>,
    /// The assistant a delegation sub-agent runs as, by the name it started
    /// with — the panel names the row after it rather than after the agent.
    /// Resolved by the command layer, like `title`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_name: Option<String>,
}

/// Aggregate payload for the `pet://sessions` event and the
/// `pet_list_active_sessions` snapshot command. Counts are precomputed so the
/// sprite-window badge can pick the right cue (number / clock / error) without
/// walking the list, and they follow the same precedence as the ambient
/// `compute_pet_state`: a session blocked on a permission counts as `waiting`,
/// not `running`.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PetSessionsPayload {
    pub running_count: u32,
    pub waiting_count: u32,
    pub error_count: u32,
    pub sessions: Vec<PetSessionEntry>,
}

impl PetSessionsPayload {
    /// Build the payload from raw entries, computing the precedence-based
    /// counts. Pure (no DB / manager access) so it is unit-testable and is the
    /// single source of truth for how a session maps to a badge bucket.
    pub fn from_entries(sessions: Vec<PetSessionEntry>) -> Self {
        use crate::acp::types::ConnectionStatus;
        let mut running_count = 0;
        let mut waiting_count = 0;
        let mut error_count = 0;
        for s in &sessions {
            if s.pending.is_some() {
                waiting_count += 1;
            } else if s.status == ConnectionStatus::Error {
                error_count += 1;
            } else if s.status == ConnectionStatus::Prompting {
                running_count += 1;
            }
        }
        Self {
            running_count,
            waiting_count,
            error_count,
            sessions,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_geometry_matches_codex() {
        assert_eq!(SPRITE_FRAME_WIDTH, 192);
        assert_eq!(SPRITE_FRAME_HEIGHT, 208);
    }

    #[test]
    fn pet_state_rows_are_unique_and_sequential() {
        let states = [
            PetState::Idle,
            PetState::RunningRight,
            PetState::RunningLeft,
            PetState::Waving,
            PetState::Jumping,
            PetState::Failed,
            PetState::Waiting,
            PetState::Running,
            PetState::Review,
        ];
        for (i, s) in states.iter().enumerate() {
            assert_eq!(s.row() as usize, i);
        }
    }

    #[test]
    fn manifest_round_trips_codex_layout() {
        // Verify the on-disk shape is byte-compatible with what codex writes.
        let raw = r#"{
            "id": "duck",
            "displayName": "Dewey",
            "description": "A small duck.",
            "spritesheetPath": "spritesheet.webp"
        }"#;
        let manifest: PetManifest = serde_json::from_str(raw).expect("parse codex pet.json");
        assert_eq!(manifest.id, "duck");
        assert_eq!(manifest.display_name, "Dewey");
        assert_eq!(manifest.spritesheet_path, "spritesheet.webp");

        let reserialized = serde_json::to_value(&manifest).unwrap();
        assert_eq!(reserialized["displayName"], "Dewey");
        assert_eq!(reserialized["spritesheetPath"], "spritesheet.webp");
    }

    fn session_entry(
        status: crate::acp::types::ConnectionStatus,
        pending: bool,
    ) -> PetSessionEntry {
        PetSessionEntry {
            connection_id: "c".into(),
            conversation_id: 1,
            folder_id: 1,
            agent_type: crate::models::agent::AgentType::ClaudeCode,
            title: String::new(),
            status,
            pending: pending.then(|| PetPermissionSummary {
                request_id: "r".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
            }),
            parent: None,
            assistant_name: None,
        }
    }

    #[test]
    fn from_entries_counts_follow_waiting_over_running_precedence() {
        use crate::acp::types::ConnectionStatus;
        let payload = PetSessionsPayload::from_entries(vec![
            session_entry(ConnectionStatus::Prompting, false), // running
            session_entry(ConnectionStatus::Prompting, true), // waiting: pending outranks prompting
            session_entry(ConnectionStatus::Error, false),     // error
            session_entry(ConnectionStatus::Connected, false), // idle-ish: counted nowhere
        ]);
        assert_eq!(payload.running_count, 1);
        assert_eq!(payload.waiting_count, 1);
        assert_eq!(payload.error_count, 1);
        assert_eq!(payload.sessions.len(), 4);
    }

    #[test]
    fn pet_sessions_payload_serializes_camel_case() {
        let payload = PetSessionsPayload::default();
        let v = serde_json::to_value(&payload).unwrap();
        assert_eq!(v["runningCount"], 0);
        assert_eq!(v["waitingCount"], 0);
        assert_eq!(v["errorCount"], 0);
        assert!(v["sessions"].is_array());
    }

    #[test]
    fn pet_session_entry_omits_pending_when_absent() {
        let entry = session_entry(crate::acp::types::ConnectionStatus::Prompting, false);
        let v = serde_json::to_value(&entry).unwrap();
        assert!(v.get("pending").is_none(), "pending must be omitted when None");
        assert_eq!(v["connectionId"], "c");
    }
}
