//! Tauri + Axum command surface for the desktop-pet feature.
//!
//! All filesystem operations live in `crate::pets`; this module owns the
//! database-backed settings KV plus the thin double-mode wrappers that
//! translate raw I/O errors into `AppCommandError`. Window-management
//! commands live in `commands::windows::pet` to keep the Tauri-only code
//! together.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::db::service::{app_metadata_service, conversation_service};
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
use crate::models::pet::{
    ImportCodexPetsRequest, ImportCodexPetsResult, ImportablePet, NewPetInput, PetCelebrationKind,
    PetDetail, PetMetaPatch, PetParentRef, PetSessionEntry, PetSessionsPayload, PetSpriteAsset,
    PetState, PetSummary, PetWindowConfig, PetWindowStatePatch,
};
use crate::pet_state_mapper::{read_pet_state, PetStateHandle};
use crate::pets;
use crate::pets::marketplace::{
    MarketplaceInstallRequest, MarketplaceInstallResponse, MarketplaceListParams,
    MarketplaceListResponse,
};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// KV key used by `app_metadata_service` for the persisted pet UI state.
const PET_CONFIG_KEY: &str = "pet.config";

// ─── pure ops (filesystem) ──────────────────────────────────────────────

pub async fn pet_list_core() -> Result<Vec<PetSummary>, AppCommandError> {
    tokio::task::spawn_blocking(pets::list_pets)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

pub async fn pet_get_core(id: String) -> Result<PetDetail, AppCommandError> {
    tokio::task::spawn_blocking(move || pets::get_pet(&id))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

pub async fn pet_read_spritesheet_core(id: String) -> Result<PetSpriteAsset, AppCommandError> {
    tokio::task::spawn_blocking(move || pets::read_pet_spritesheet(&id))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

pub async fn pet_add_core(input: NewPetInput) -> Result<PetSummary, AppCommandError> {
    tokio::task::spawn_blocking(move || pets::add_pet(input))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

pub async fn pet_update_meta_core(
    id: String,
    patch: PetMetaPatch,
) -> Result<PetSummary, AppCommandError> {
    tokio::task::spawn_blocking(move || pets::update_pet_meta(&id, patch))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

pub async fn pet_replace_sprite_core(
    id: String,
    spritesheet_base64: String,
) -> Result<(), AppCommandError> {
    tokio::task::spawn_blocking(move || pets::replace_pet_sprite(&id, &spritesheet_base64))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

pub async fn pet_delete_core(db: &DatabaseConnection, id: String) -> Result<(), AppCommandError> {
    let id_for_fs = id.clone();
    tokio::task::spawn_blocking(move || pets::delete_pet(&id_for_fs))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))??;

    // If the deleted pet was the active one, clear the active selection so
    // the renderer doesn't keep trying to load a missing asset.
    let mut config = load_config(db).await?;
    if config.active_pet_id.as_deref() == Some(&id) {
        config.active_pet_id = None;
        config.enabled = false;
        save_config(db, &config).await?;
    }
    Ok(())
}

pub async fn pet_list_importable_codex_core() -> Result<Vec<ImportablePet>, AppCommandError> {
    tokio::task::spawn_blocking(pets::codex_import::list_importable_codex_pets)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

pub async fn pet_import_codex_core(
    request: ImportCodexPetsRequest,
) -> Result<ImportCodexPetsResult, AppCommandError> {
    tokio::task::spawn_blocking(move || pets::codex_import::import_codex_pets(request))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

// ─── settings / window_state (DB-backed KV) ─────────────────────────────

async fn load_config(db: &DatabaseConnection) -> Result<PetWindowConfig, AppCommandError> {
    let raw = app_metadata_service::get_value(db, PET_CONFIG_KEY)
        .await
        .map_err(AppCommandError::db)?;
    let parsed = match raw {
        Some(s) => serde_json::from_str::<PetWindowConfig>(&s).unwrap_or_default(),
        None => PetWindowConfig::default(),
    };
    Ok(parsed)
}

async fn save_config(
    db: &DatabaseConnection,
    config: &PetWindowConfig,
) -> Result<(), AppCommandError> {
    let json = serde_json::to_string(config)
        .map_err(|e| AppCommandError::io_error(format!("Failed to serialize pet config: {e}")))?;
    app_metadata_service::upsert_value(db, PET_CONFIG_KEY, &json)
        .await
        .map_err(AppCommandError::db)?;
    Ok(())
}

pub async fn pet_get_settings_core(
    db: &DatabaseConnection,
) -> Result<PetWindowConfig, AppCommandError> {
    load_config(db).await
}

pub async fn pet_set_active_core(
    db: &DatabaseConnection,
    emitter: &EventEmitter,
    pet_id: Option<String>,
) -> Result<PetWindowConfig, AppCommandError> {
    let mut config = load_config(db).await?;

    if let Some(ref id) = pet_id {
        // Defense in depth: don't persist a non-existent id.
        let id_clone = id.clone();
        let exists = tokio::task::spawn_blocking(move || pets::get_pet(&id_clone))
            .await
            .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
        let _ = exists?;
    }

    config.active_pet_id = pet_id;
    save_config(db, &config).await?;
    // Notify the live pet window (and any WebSocket subscribers) so it can
    // swap sprites in place rather than requiring close-and-reopen.
    emit_event(emitter, "pet://active-changed", &config);
    Ok(config)
}

/// Manual oneshot trigger for events the backend can't observe directly
/// (e.g. `folder://merge-completed`, which is currently emitted only by
/// the merge UI in the renderer). Goes through `emit_event` so both the
/// Tauri webview and any WebSocket clients see the same `pet://oneshot`
/// stream the mapper produces for ACP/git/install events. The narrowed
/// `PetCelebrationKind` keeps callers from broadcasting an ambient row
/// (e.g. `running`) — the frontend would silently drop those, which
/// makes the API quietly mis-behaved.
pub fn pet_celebrate_core(emitter: &EventEmitter, kind: PetCelebrationKind) {
    let state: crate::models::pet::PetState = kind.into();
    emit_event(emitter, "pet://oneshot", state);
}

/// Snapshot of the current ambient pet state. The mapper only emits
/// `pet://state` when the state changes, so a window that opens *after*
/// the agent already started prompting would otherwise sit on its default
/// `Idle` until the next ACP transition. The frontend calls this on mount
/// to fill in the gap.
pub fn pet_get_current_state_core(handle: &PetStateHandle) -> PetState {
    read_pet_state(handle)
}

/// Snapshot of all active agent sessions for the pet panel: the connections
/// that are prompting, awaiting a permission, or errored, joined with their
/// conversation titles. Shared by the `pet_list_active_sessions` snapshot
/// command (mount-time) and the `pet://sessions` aggregator (live updates), so
/// the two never diverge. A missing/renamed conversation row degrades to an
/// empty title rather than failing the whole payload.
///
/// Delegation sub-agent sessions (child conversations, i.e. `parent_id` set)
/// are excluded **while they are working**: their progress is already
/// represented by the parent connection's own `Prompting` row, so listing them
/// too would double-count the badge and fill the panel with sessions the user
/// never opened.
///
/// A sub-agent BLOCKED on a permission is the exception, and is kept. Nothing
/// else surfaces that state: the child is hidden from every tab/picker, and the
/// parent's row actively mis-reports it as "running". Its only other outlet is
/// the status badge on the `delegate_to_agent` card inside the parent's
/// transcript — which the user has to already be looking at. Keeping the row
/// here gives the state a global signal AND a place to answer it: the panel's
/// permission card posts to `entry.connection_id`, which is connection-scoped
/// and therefore works for a child exactly as it does for a tab (see #447).
/// The row carries [`PetParentRef`] so it reads as a sub-agent and jumps to the
/// conversation that delegated it.
///
/// Filtering happens here — before `from_entries` — so the precomputed counts
/// and the per-row list come from the same filtered set and can never disagree
/// (the badge and the panel share this one payload). Kept sub-agent rows always
/// have `pending`, so they land in `waiting_count` and never in `running_count`
/// — mirroring `compute_pet_state`, which likewise lets a child's pending
/// permission (and only that) reach the ambient sprite.
pub async fn pet_list_active_sessions_core(
    manager: &ConnectionManager,
    db: &DatabaseConnection,
) -> Result<PetSessionsPayload, AppCommandError> {
    let raw: Vec<PetSessionEntry> = manager.list_active_sessions().await;
    let mut entries: Vec<PetSessionEntry> = Vec::with_capacity(raw.len());
    for mut entry in raw {
        // A readable row with a parent is a delegation sub-agent: keep it only
        // while it's blocking the user. A missing/renamed row (the `if let`
        // doesn't match) falls through with an empty title — degrade, don't
        // fail or drop.
        if let Ok(summary) = conversation_service::get_by_id(db, entry.conversation_id).await {
            if let Some(parent_id) = summary.parent_id {
                if entry.pending.is_none() {
                    continue;
                }
                // A parent row we can't read leaves `parent` unset: the row
                // still renders (and stays answerable) as a plain session
                // rather than vanishing over a missing title.
                if let Ok(parent) = conversation_service::get_by_id(db, parent_id).await {
                    entry.parent = Some(PetParentRef {
                        conversation_id: parent.id,
                        folder_id: parent.folder_id,
                        agent_type: parent.agent_type,
                        title: parent.title.unwrap_or_default(),
                    });
                }
            }
            entry.title = summary.title.unwrap_or_default();
            entry.assistant_name = summary.assistant_name;
        }
        entries.push(entry);
    }
    Ok(PetSessionsPayload::from_entries(entries))
}

pub async fn pet_save_window_state_core(
    db: &DatabaseConnection,
    patch: PetWindowStatePatch,
) -> Result<PetWindowConfig, AppCommandError> {
    let mut config = load_config(db).await?;
    if let Some(x) = patch.x {
        config.x = Some(x);
    }
    if let Some(y) = patch.y {
        config.y = Some(y);
    }
    if let Some(scale) = patch.scale {
        config.scale = scale.clamp(0.5, 3.0);
    }
    if let Some(top) = patch.always_on_top {
        config.always_on_top = top;
    }
    if let Some(enabled) = patch.enabled {
        config.enabled = enabled;
    }
    save_config(db, &config).await?;
    Ok(config)
}

// ─── Tauri command wrappers ─────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetIdParams {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetUpdateMetaParams {
    pub id: String,
    pub patch: PetMetaPatch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetReplaceSpriteParams {
    pub id: String,
    pub spritesheet_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSetActiveParams {
    pub pet_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCodexImportAvailability {
    pub available: bool,
}

pub async fn pet_codex_import_available_core() -> Result<PetCodexImportAvailability, AppCommandError>
{
    Ok(PetCodexImportAvailability {
        available: pets::codex_import::codex_import_available(),
    })
}

pub async fn pet_marketplace_list_core(
    params: MarketplaceListParams,
) -> Result<MarketplaceListResponse, AppCommandError> {
    pets::marketplace::list(params).await
}

pub async fn pet_marketplace_install_core(
    request: MarketplaceInstallRequest,
) -> Result<MarketplaceInstallResponse, AppCommandError> {
    pets::marketplace::install(request).await
}

/// Proxy a marketplace image (poster / preview / spritesheet) through the
/// backend so the renderer loads it as a blob URL instead of fetching
/// codex-pets.net directly — the webview can't always reach the CDN, but this
/// backend can (it already downloads packages for install). Returns the same
/// `{ mime, dataBase64 }` shape as `pet_read_spritesheet`, so the frontend
/// reuses `createPetSpriteObjectUrl`.
pub async fn pet_marketplace_asset_core(url: String) -> Result<PetSpriteAsset, AppCommandError> {
    let (mime, bytes) = pets::marketplace::fetch_asset(&url).await?;
    Ok(PetSpriteAsset {
        mime,
        data_base64: BASE64.encode(&bytes),
    })
}

// Tauri 2 looks up command parameters by their top-level name in the JSON
// args object. The frontend `lib/pet/api.ts` ships flat objects (e.g.
// `{ id, displayName, description, spritesheetBase64 }` for `pet_add`), so
// each command takes flat scalar parameters whose names match the camelCase
// keys after Tauri's auto snake_case translation. We *don't* declare a
// single struct param like `input: NewPetInput` — that would expect the
// frontend to wrap the payload as `{ input: { ... } }`, which it does not.

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_list() -> Result<Vec<PetSummary>, AppCommandError> {
    pet_list_core().await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_get(id: String) -> Result<PetDetail, AppCommandError> {
    pet_get_core(id).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_read_spritesheet(id: String) -> Result<PetSpriteAsset, AppCommandError> {
    pet_read_spritesheet_core(id).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_add(
    id: String,
    display_name: String,
    description: Option<String>,
    spritesheet_base64: String,
) -> Result<PetSummary, AppCommandError> {
    pet_add_core(NewPetInput {
        id,
        display_name,
        description,
        spritesheet_base64,
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_update_meta(
    id: String,
    patch: PetMetaPatch,
) -> Result<PetSummary, AppCommandError> {
    pet_update_meta_core(id, patch).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_replace_sprite(
    id: String,
    spritesheet_base64: String,
) -> Result<(), AppCommandError> {
    pet_replace_sprite_core(id, spritesheet_base64).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_delete(
    db: tauri::State<'_, AppDatabase>,
    id: String,
) -> Result<(), AppCommandError> {
    pet_delete_core(&db.conn, id).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_list_importable_codex() -> Result<Vec<ImportablePet>, AppCommandError> {
    pet_list_importable_codex_core().await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_import_codex(
    ids: Option<Vec<String>>,
    overwrite_with_suffix: Option<bool>,
) -> Result<ImportCodexPetsResult, AppCommandError> {
    pet_import_codex_core(ImportCodexPetsRequest {
        ids: ids.unwrap_or_default(),
        overwrite_with_suffix: overwrite_with_suffix.unwrap_or(false),
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_codex_import_available() -> Result<PetCodexImportAvailability, AppCommandError> {
    pet_codex_import_available_core().await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_marketplace_list(
    page: Option<u32>,
    page_size: Option<u32>,
    q: Option<String>,
    kind: Option<String>,
    sort: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<MarketplaceListResponse, AppCommandError> {
    pet_marketplace_list_core(MarketplaceListParams {
        page,
        page_size,
        q,
        kind,
        sort,
        tags,
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_marketplace_install(
    id: String,
    download_url: String,
    overwrite: Option<bool>,
) -> Result<MarketplaceInstallResponse, AppCommandError> {
    pet_marketplace_install_core(MarketplaceInstallRequest {
        id,
        download_url,
        overwrite: overwrite.unwrap_or(false),
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_marketplace_asset(url: String) -> Result<PetSpriteAsset, AppCommandError> {
    pet_marketplace_asset_core(url).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_get_settings(
    db: tauri::State<'_, AppDatabase>,
) -> Result<PetWindowConfig, AppCommandError> {
    pet_get_settings_core(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_set_active(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    pet_id: Option<String>,
) -> Result<PetWindowConfig, AppCommandError> {
    pet_set_active_core(&db.conn, &EventEmitter::Tauri(app), pet_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_celebrate(
    app: tauri::AppHandle,
    kind: PetCelebrationKind,
) -> Result<(), AppCommandError> {
    pet_celebrate_core(&EventEmitter::Tauri(app), kind);
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_get_current_state(
    handle: tauri::State<'_, PetStateHandle>,
) -> Result<PetState, AppCommandError> {
    Ok(pet_get_current_state_core(handle.inner()))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_list_active_sessions(
    manager: tauri::State<'_, ConnectionManager>,
    db: tauri::State<'_, AppDatabase>,
) -> Result<PetSessionsPayload, AppCommandError> {
    pet_list_active_sessions_core(manager.inner(), &db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_save_window_state(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    x: Option<f64>,
    y: Option<f64>,
    scale: Option<f64>,
    always_on_top: Option<bool>,
    enabled: Option<bool>,
) -> Result<PetWindowConfig, AppCommandError> {
    let scale_changed = scale.is_some();
    let new_config = pet_save_window_state_core(
        &db.conn,
        PetWindowStatePatch {
            x,
            y,
            scale,
            always_on_top,
            enabled,
        },
    )
    .await?;

    // Keep the OS window in lockstep with the persisted scale. Without this,
    // changing scale via the right-click menu would shrink/grow the sprite
    // inside an unchanged transparent window — a 0.5x sprite floating in a
    // 1x window's worth of dead pixels that still capture clicks.
    if scale_changed {
        if let Some(window) = tauri::Manager::get_webview_window(&app, "pet") {
            let s = new_config.scale;
            let _ = window.set_size(tauri::LogicalSize::new(192.0_f64 * s, 208.0_f64 * s));
        }
    }

    Ok(new_config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    #[tokio::test]
    async fn pet_settings_returns_defaults_on_fresh_db() {
        let db = fresh_in_memory_db().await;
        let cfg = pet_get_settings_core(&db.conn).await.expect("get");
        // Default config should be the type's `Default` impl — no panic, no
        // null active id (regression guard against schema drift).
        assert!(cfg.active_pet_id.is_none());
    }

    #[tokio::test]
    async fn pet_save_window_state_patches_individual_fields() {
        let db = fresh_in_memory_db().await;
        let patch = PetWindowStatePatch {
            x: Some(42.0),
            y: Some(99.0),
            scale: Some(1.5),
            always_on_top: Some(true),
            enabled: None,
        };
        let cfg = pet_save_window_state_core(&db.conn, patch)
            .await
            .expect("save");
        assert_eq!(cfg.x, Some(42.0));
        assert_eq!(cfg.y, Some(99.0));
        assert_eq!(cfg.scale, 1.5);
        assert!(cfg.always_on_top);

        // Subsequent partial patch leaves untouched fields alone.
        let patch2 = PetWindowStatePatch {
            x: None,
            y: None,
            scale: Some(2.0),
            always_on_top: None,
            enabled: None,
        };
        let cfg2 = pet_save_window_state_core(&db.conn, patch2)
            .await
            .expect("save 2");
        assert_eq!(cfg2.x, Some(42.0), "x preserved");
        assert_eq!(cfg2.scale, 2.0);
    }

    #[tokio::test]
    async fn pet_save_window_state_clamps_scale_to_valid_range() {
        let db = fresh_in_memory_db().await;
        let patch_too_large = PetWindowStatePatch {
            x: None,
            y: None,
            scale: Some(10.0),
            always_on_top: None,
            enabled: None,
        };
        let cfg = pet_save_window_state_core(&db.conn, patch_too_large)
            .await
            .expect("save");
        assert_eq!(cfg.scale, 3.0, "scale clamped to upper bound");

        let patch_too_small = PetWindowStatePatch {
            x: None,
            y: None,
            scale: Some(0.1),
            always_on_top: None,
            enabled: None,
        };
        let cfg2 = pet_save_window_state_core(&db.conn, patch_too_small)
            .await
            .expect("save 2");
        assert_eq!(cfg2.scale, 0.5, "scale clamped to lower bound");
    }

    /// A parent conversation + a delegated child of it, each on its own live
    /// `Prompting` connection. Returns `(db, manager, parent_id, child_id,
    /// folder_id)` so a test only has to decide what blocks.
    #[cfg(test)]
    async fn seed_parent_and_delegation_child() -> (
        crate::db::AppDatabase,
        crate::acp::manager::ConnectionManager,
        i32,
        i32,
        i32,
    ) {
        use crate::acp::delegation::spawner::DelegationLink;
        use crate::acp::manager::ConnectionManager;
        use crate::acp::types::ConnectionStatus;
        use crate::db::test_helpers;
        use crate::models::agent::AgentType;
        use crate::web::event_bridge::EventEmitter;

        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/pet-deleg").await;

        let parent = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("Parent".into()),
            None,
        )
        .await
        .expect("create parent");
        let child = conversation_service::create_with_delegation(
            &db.conn,
            folder_id,
            AgentType::Codex,
            Some("Child".into()),
            None,
            Some(DelegationLink {
                parent_conversation_id: parent.id,
                parent_tool_use_id: "tu-1".into(),
                delegation_call_id: "call-1".into(),
                assistant: None,
            }),
        )
        .await
        .expect("create child");

        let manager = ConnectionManager::new();
        for id in ["conn-parent", "conn-child"] {
            manager
                .insert_test_connection(id, AgentType::ClaudeCode, None, EventEmitter::Noop)
                .await;
        }
        for (conn_id, conv_id) in [("conn-parent", parent.id), ("conn-child", child.id)] {
            let state = manager.get_state(conn_id).await.expect("state");
            let mut s = state.write().await;
            s.conversation_id = Some(conv_id);
            s.folder_id = Some(folder_id);
            s.status = ConnectionStatus::Prompting;
        }
        (db, manager, parent.id, child.id, folder_id)
    }

    #[tokio::test]
    async fn pet_list_active_sessions_excludes_working_delegation_children() {
        let (db, manager, parent_id, _child_id, _folder_id) =
            seed_parent_and_delegation_child().await;

        let payload = pet_list_active_sessions_core(&manager, &db.conn)
            .await
            .expect("payload");

        // A sub-agent that is merely working is filtered out: only the parent
        // remains, and the precomputed counts follow the filtered list (badge ↔
        // panel agree).
        assert_eq!(
            payload.sessions.len(),
            1,
            "a working delegation child must be excluded from the active-session list"
        );
        assert_eq!(payload.sessions[0].conversation_id, parent_id);
        assert!(payload.sessions[0].parent.is_none());
        assert_eq!(payload.running_count, 1);
        assert_eq!(payload.waiting_count, 0);
        assert_eq!(payload.error_count, 0);
    }

    #[tokio::test]
    async fn pet_list_active_sessions_keeps_permission_blocked_delegation_children() {
        use crate::acp::session_state::PendingPermissionState;
        use crate::models::agent::AgentType;

        let (db, manager, parent_id, child_id, folder_id) =
            seed_parent_and_delegation_child().await;

        // The child hits a permission prompt (#447): it is now blocking the
        // user, so it must reach the badge count and the panel — the panel's
        // card is the only place the user can answer it without hunting through
        // the parent's transcript.
        {
            let state = manager.get_state("conn-child").await.expect("state");
            let mut s = state.write().await;
            s.pending_permission = Some(PendingPermissionState {
                request_id: "req-1".into(),
                tool_call_id: "tc-1".into(),
                tool_call: serde_json::json!({ "title": "rm -rf /tmp/x" }),
                options: vec![],
                created_at: chrono::Utc::now(),
                queued: 0,
            });
        }

        let payload = pet_list_active_sessions_core(&manager, &db.conn)
            .await
            .expect("payload");

        assert_eq!(payload.sessions.len(), 2, "parent + blocked sub-agent");
        let child_row = payload
            .sessions
            .iter()
            .find(|s| s.conversation_id == child_id)
            .expect("the blocked sub-agent must be listed");
        assert_eq!(
            child_row.connection_id, "conn-child",
            "the row must answer through the CHILD connection, not the parent"
        );
        let parent_ref = child_row.parent.as_ref().expect("sub-agent row names its parent");
        assert_eq!(parent_ref.conversation_id, parent_id);
        assert_eq!(parent_ref.folder_id, folder_id);
        assert_eq!(parent_ref.agent_type, AgentType::ClaudeCode);
        assert_eq!(parent_ref.title, "Parent");

        // Precedence: the blocked child lands in `waiting`, never in `running`.
        assert_eq!(payload.running_count, 1, "only the parent is running");
        assert_eq!(payload.waiting_count, 1);
        assert_eq!(payload.error_count, 0);
    }
}
