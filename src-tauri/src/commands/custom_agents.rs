//! Commands for managing **custom ACP agents** — agents the user registers by
//! supplying ACP-registry information rather than agents codeg ships support
//! for.
//!
//! The whole surface is deliberately thin: add / edit / remove a definition,
//! and browse the public ACP registry to add one in a click. There is
//! intentionally no per-agent configuration here — a custom agent is driven
//! purely by the protocol (see `crate::acp::custom_registry`).

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use serde::{Deserialize, Serialize};

use crate::acp::custom_registry::{
    derive_command_name, CustomAgentDef, CustomAgentSpec, CustomDistributionKind,
};
use crate::acp::error::AcpError;
use crate::acp::family_isolator;
use crate::acp::remote_registry::{self, RegistryCatalogAgent};
use crate::acp::{custom_registry, registry};
use crate::commands::acp::emit_acp_agents_updated;
use crate::db::service::custom_agent_service;
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

/// A registered custom agent, as shown in the settings list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentInfo {
    pub registry_id: String,
    /// Wire form of the agent type (`custom:<id>`) — what the frontend passes
    /// back as an `AgentType`.
    pub agent_type: AgentType,
    pub name: String,
    pub description: String,
    pub version: String,
    pub distribution_kind: String,
    pub spec: CustomAgentSpec,
    pub icon_url: Option<String>,
    /// Mirrors [`CustomAgentDef::skills_shared_store`] so the edit form can
    /// prefill the declaration.
    pub skills_shared_store: bool,
    /// Mirrors [`CustomAgentDef::skills_dir`] — the agent's own skills
    /// directory, already normalized to an absolute path.
    pub skills_dir: Option<String>,
    /// `registry` | `manual`. The edit form and every whole-definition
    /// re-save must send it back, or provenance would reset.
    pub source: String,
    /// Mirrors [`CustomAgentDef::version_probe`] for the edit form.
    pub version_probe: Option<String>,
    /// Mirrors [`CustomAgentDef::supports_mcp`] — backs the settings toggle
    /// that decides whether codeg-mcp rides along on `session/new`.
    pub supports_mcp: bool,
    /// False when the stored definition cannot produce launch metadata (e.g.
    /// a binary-only agent with no release for this platform). The row still
    /// lists, with the reason, instead of vanishing.
    pub launchable: bool,
    pub problem: Option<String>,
}

fn info_from_def(def: &CustomAgentDef) -> CustomAgentInfo {
    // `validate`, not `build_meta`: the settings list re-renders on every
    // refresh and this result is thrown away, while building metadata leaks the
    // arg/env/platform slices it interns (see `custom_registry::build_meta`).
    let problem = custom_registry::validate(def).err().map(|e| e.to_string());
    CustomAgentInfo {
        agent_type: AgentType::custom(&def.registry_id)
            // An unparseable id cannot reach the database (`upsert` validates),
            // so this is unreachable in practice; degrade rather than panic.
            .unwrap_or(AgentType::Custom("")),
        registry_id: def.registry_id.clone(),
        name: def.name.clone(),
        description: def.description.clone(),
        version: def.version.clone(),
        distribution_kind: def.distribution_kind.as_str().to_string(),
        spec: def.spec.clone(),
        icon_url: def.icon_url.clone(),
        skills_shared_store: def.skills_shared_store,
        skills_dir: def.skills_dir.clone(),
        source: def.source.as_str().to_string(),
        version_probe: def.version_probe.clone(),
        supports_mcp: def.supports_mcp,
        launchable: problem.is_none(),
        problem,
    }
}

pub async fn acp_list_custom_agents_core(db: &AppDatabase) -> Result<Vec<CustomAgentInfo>, AcpError> {
    let defs = custom_agent_service::list_defs(&db.conn)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    Ok(defs.iter().map(info_from_def).collect())
}

pub async fn acp_save_custom_agent_core(
    def: CustomAgentDef,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let mut def = def;
    def.icon_url = normalize_icon(def.icon_url.take()).await;
    // Both runtimes save through here, so this is where the dedicated skills
    // directory is pinned down to an absolute path (or rejected) — the skills
    // surfaces read it back without a workspace to resolve against.
    def.skills_dir = normalize_skills_dir(def.skills_dir.take())?;
    custom_agent_service::upsert(&db.conn, &def)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    // Republish immediately so the agent is launchable without a restart.
    custom_agent_service::hydrate_registry(&db.conn)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    emit_acp_agents_updated(
        emitter,
        "custom_agent_saved",
        AgentType::custom(&def.registry_id),
    );
    Ok(())
}

pub async fn acp_delete_custom_agent_core(
    registry_id: String,
    delete_transcripts: bool,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let existed = custom_agent_service::delete(&db.conn, &registry_id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    if !existed {
        return Err(AcpError::protocol(format!(
            "custom agent not found: {registry_id}"
        )));
    }
    custom_agent_service::hydrate_registry(&db.conn)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;

    // Conversations keep their `custom:<id>` rows either way; dropping the
    // transcripts is what actually loses history, so it is opt-in.
    if delete_transcripts {
        if let Err(e) = crate::acp_transcript::remove_agent_transcripts_in(
            &crate::paths::codeg_acp_transcripts_root(),
            &registry_id,
        ) {
            tracing::warn!("[custom-agent] failed to remove transcripts for {registry_id}: {e}");
        }
    }
    emit_acp_agents_updated(emitter, "custom_agent_deleted", None);
    Ok(())
}

/// Fetch the public ACP registry, annotated with which entries codeg already
/// ships natively and which the user has already added.
pub async fn acp_fetch_registry_catalog_core(
    db: &AppDatabase,
) -> Result<Vec<RegistryCatalogAgent>, AcpError> {
    let installed: Vec<String> = custom_agent_service::list(&db.conn)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?
        .into_iter()
        .map(|row| row.registry_id)
        .collect();
    remote_registry::fetch_catalog(&installed)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))
}

/// The platform key (`darwin-aarch64`, …) binary distributions are keyed by on
/// this machine. The manual add form asks for it to prefill a binary template
/// that actually applies — and in server mode "this machine" is the server,
/// where installs run, so the answer has to come from the backend.
pub fn acp_current_platform_core() -> String {
    registry::current_platform().to_string()
}

/// Add an agent straight from the ACP registry by id.
///
/// For npx/uvx entries the console-script name is resolved from npm metadata
/// when possible — the registry does not publish it and guessing from the
/// package name is wrong for e.g. `@github/copilot` (bin: `copilot`).
pub async fn acp_add_registry_agent_core(
    registry_id: String,
    distribution_kind: Option<String>,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    if registry::builtin_acp_agents()
        .into_iter()
        .any(|a| registry::registry_id_for(a) == registry_id)
    {
        return Err(AcpError::protocol(format!(
            "{registry_id} is already built into codeg"
        )));
    }
    let catalog = acp_fetch_registry_catalog_core(db).await?;
    let entry = catalog
        .iter()
        .find(|e| e.registry_id == registry_id)
        .ok_or_else(|| {
            AcpError::protocol(format!("{registry_id} is not in the ACP registry"))
        })?;

    let kind = match distribution_kind.as_deref() {
        Some(raw) => Some(CustomDistributionKind::parse(raw).ok_or_else(|| {
            AcpError::protocol(format!("unknown distribution kind: {raw}"))
        })?),
        None => None,
    };

    // Resolve the channel ONCE and pass it down. Deriving it separately here
    // would let this and `catalog_entry_to_def` disagree — an entry whose
    // preferred binary has no release for this platform is added through npx,
    // and guessing "binary" here would skip the console-script lookup below and
    // leave the definition with a command name derived from the package
    // (`qwen-code` for `@qwen-code/qwen-code`, whose real bin is `qwen`).
    let kind = remote_registry::effective_kind(entry, kind)
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let cmd_override = match kind {
        CustomDistributionKind::Npx => match entry.spec.npx.as_ref() {
            Some(npx) => resolve_npm_bin(&npx.package).await,
            None => None,
        },
        // uvx console scripts are not discoverable without resolving the
        // wheel; the derived name is the honest default and the user can edit
        // it in the manual form.
        _ => None,
    };

    let def = remote_registry::catalog_entry_to_def(entry, Some(kind), cmd_override)
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    // The registry's `icon` rides along on `def`; `acp_save_custom_agent_core`
    // inlines it.
    acp_save_custom_agent_core(def, db, emitter).await
}

/// Pin a declared skills directory down to a stored, absolute path.
///
/// Blank input reads as "not declared". A leading `~` is expanded so the form
/// accepts the spelling every skills doc uses; anything still relative after
/// that is rejected rather than silently resolved against whatever the
/// process's working directory happens to be. Deliberately NOT part of
/// `custom_registry::validate` — a bad skills path must never make the agent
/// itself unlaunchable (hydrate skips rows that fail validation).
fn normalize_skills_dir(raw: Option<String>) -> Result<Option<String>, AcpError> {
    let Some(raw) = raw else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let expanded = expand_home(trimmed);
    if !expanded.is_absolute() {
        return Err(AcpError::protocol(format!(
            "skills directory must be an absolute path (got {trimmed:?})"
        )));
    }
    Ok(Some(expanded.to_string_lossy().into_owned()))
}

/// `~` / `~/…` (and the `~\…` Windows spelling) resolved against the home
/// directory; anything else passes through untouched.
fn expand_home(path: &str) -> std::path::PathBuf {
    let home = || dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    if path == "~" {
        return home();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home().join(rest);
    }
    std::path::PathBuf::from(path)
}

/// Largest icon codeg will inline. Registry marks are 650 B–5 KB SVGs, so this
/// is far above anything real; it exists so a hostile or mistyped URL cannot
/// push an arbitrary blob into the database.
pub const MAX_ICON_BYTES: usize = 256 * 1024;

/// The same bound expressed for an already-encoded `data:` URL (base64 costs
/// 4 bytes per 3, plus the `data:<mime>;base64,` prefix).
pub const MAX_ICON_DATA_URL_CHARS: usize = MAX_ICON_BYTES * 4 / 3 + 128;

/// How long an icon fetch may take before the save proceeds without it. Saving
/// an agent must not hang on an unreachable icon host.
const ICON_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Decide what to persist as an agent's icon.
///
/// * An uploaded / already-inlined `data:` URL is kept, bounded by
///   [`MAX_ICON_DATA_URL_CHARS`] so a client cannot push an arbitrary blob into
///   the row (oversized ones are dropped — the initial glyph is a fine
///   fallback and a bloated row is not).
/// * A remote URL is downloaded and inlined, so rendering it later needs no
///   network. If the fetch fails the URL is kept as-is: the webview may still
///   be able to reach it, and if it can't, the icon simply falls back.
/// * Anything else (a `file://` path, a relative path, empty) is dropped.
async fn normalize_icon(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let url = raw.trim();
    if url.is_empty() {
        return None;
    }
    if url.starts_with("data:") {
        if url.len() > MAX_ICON_DATA_URL_CHARS {
            tracing::warn!(
                "[custom-agent] dropping an icon of {} chars (limit {MAX_ICON_DATA_URL_CHARS})",
                url.len()
            );
            return None;
        }
        return Some(url.to_string());
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return None;
    }
    Some(inline_icon(url).await.unwrap_or_else(|| url.to_string()))
}

/// Download an icon and turn it into a `data:` URL. `None` on any failure — a
/// non-image response, an oversized body, or no network.
///
/// Callers go through [`normalize_icon`]; this is the http(s) half of it.
async fn inline_icon(url: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(ICON_FETCH_TIMEOUT)
        .build()
        .ok()?;
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        // Strip `; charset=utf-8`, which SVG responses commonly carry.
        .and_then(|v| v.split(';').next())
        .map(|v| v.trim().to_ascii_lowercase())
        .or_else(|| mime_from_extension(url))?;
    if !content_type.starts_with("image/") {
        return None;
    }

    let bytes = read_body_capped(response, MAX_ICON_BYTES).await?;
    if bytes.is_empty() {
        return None;
    }
    Some(build_data_url(&content_type, &bytes))
}

/// Read a response body, giving up as soon as it exceeds `limit`.
///
/// The URL is remote and only loosely trusted (a registry entry, or whatever
/// the user typed), so the cap has to bound what is ALLOCATED, not just what is
/// accepted: buffering the whole body first and measuring it afterwards would
/// let any URL decide how much memory this process takes.
async fn read_body_capped(response: reqwest::Response, limit: usize) -> Option<Vec<u8>> {
    use futures_util::StreamExt as _;
    // A server that declares an oversized body is rejected without reading it
    // at all. The header is only a hint, so the streaming check below is what
    // actually enforces the cap.
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return None;
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if body.len() + chunk.len() > limit {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
}

/// Fallback MIME for a server that answers without a usable `Content-Type`.
fn mime_from_extension(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "svg" => Some("image/svg+xml".to_string()),
        "png" => Some("image/png".to_string()),
        "jpg" | "jpeg" => Some("image/jpeg".to_string()),
        "webp" => Some("image/webp".to_string()),
        "gif" => Some("image/gif".to_string()),
        "ico" => Some("image/x-icon".to_string()),
        _ => None,
    }
}

fn build_data_url(content_type: &str, bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Best-effort lookup of the console script an npm package installs.
///
/// Reads the package's `bin` field from the public npm registry. Returns the
/// bin name when the package installs exactly one, or the one matching the
/// package's own short name when it installs several; `None` on any failure,
/// which leaves [`derive_command_name`] as the fallback.
pub async fn resolve_npm_bin(package_spec: &str) -> Option<String> {
    let (name, version) = split_npm_spec(package_spec);
    let url = match version {
        Some(v) => format!("https://registry.npmjs.org/{name}/{v}"),
        None => format!("https://registry.npmjs.org/{name}/latest"),
    };
    let response = reqwest::Client::new().get(&url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let doc: serde_json::Value = response.json().await.ok()?;
    let bin = doc.get("bin")?;
    // `"bin": "./cli.js"` — npm names the script after the package.
    if bin.is_string() {
        return Some(derive_command_name(package_spec));
    }
    let obj = bin.as_object()?;
    let short = derive_command_name(package_spec);
    if let Some(exact) = obj.keys().find(|k| **k == short) {
        return Some(exact.clone());
    }
    match obj.keys().collect::<Vec<_>>().as_slice() {
        [only] => Some((*only).clone()),
        _ => None,
    }
}

/// Split `@scope/name@1.2.3` into (`@scope/name`, `1.2.3`). A spec with no
/// version yields `None` for the version.
fn split_npm_spec(spec: &str) -> (&str, Option<&str>) {
    let spec = spec.trim();
    let search_from = if spec.starts_with('@') {
        spec.find('/').map(|i| i + 1).unwrap_or(0)
    } else {
        0
    };
    match spec[search_from..].find('@') {
        Some(idx) => {
            let at = search_from + idx;
            (&spec[..at], Some(&spec[at + 1..]))
        }
        None => (spec, None),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (desktop). The web handlers call the `_core` functions above.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCustomAgentParams {
    pub registry_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: String,
    pub distribution_kind: String,
    pub spec: CustomAgentSpec,
    #[serde(default)]
    pub icon_url: Option<String>,
    /// See [`CustomAgentDef::skills_shared_store`]. Defaults off so saves from
    /// older frontends keep the agent out of the skills surfaces.
    #[serde(default)]
    pub skills_shared_store: bool,
    /// See [`CustomAgentDef::skills_dir`]. Normalized (and possibly rejected)
    /// by the save path, so the form can send what the user typed.
    #[serde(default)]
    pub skills_dir: Option<String>,
    /// See [`CustomAgentDef::source`]. `None` preserves the stored row's value
    /// (or `manual` for a brand-new row) — a caller that doesn't know the
    /// provenance can never flip it. Resolved in
    /// [`acp_save_custom_agent_params_core`], the only params path with DB
    /// access.
    #[serde(default)]
    pub source: Option<String>,
    /// See [`CustomAgentDef::version_probe`]. Full-replace like the skills
    /// fields: every save carries the whole declaration, so a save that
    /// omits it clears it.
    #[serde(default)]
    pub version_probe: Option<String>,
    /// See [`CustomAgentDef::supports_mcp`]. `None` preserves the stored row's
    /// value (or `true` for a brand-new row), like [`Self::source`] and unlike
    /// the full-replace fields above: the safe value here is the one already
    /// stored, so a caller that re-saves some OTHER declaration without
    /// knowing about this one must not silently switch MCP back on and break a
    /// connection the user just fixed. Resolved in
    /// [`acp_save_custom_agent_params_core`], the only params path with DB
    /// access.
    #[serde(default)]
    pub supports_mcp: Option<bool>,
}

impl SaveCustomAgentParams {
    pub fn into_def(self) -> Result<CustomAgentDef, AcpError> {
        let distribution_kind =
            CustomDistributionKind::parse(&self.distribution_kind).ok_or_else(|| {
                AcpError::protocol(format!(
                    "unknown distribution kind: {}",
                    self.distribution_kind
                ))
            })?;
        Ok(CustomAgentDef {
            registry_id: self.registry_id.trim().to_string(),
            name: self.name,
            description: self.description,
            version: self.version,
            distribution_kind,
            spec: self.spec,
            icon_url: self.icon_url,
            skills_shared_store: self.skills_shared_store,
            skills_dir: self.skills_dir,
            // Placeholders — `acp_save_custom_agent_params_core` resolves the
            // real values (params override / stored row / Manual, resp. on).
            source: Default::default(),
            version_probe: self
                .version_probe
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            supports_mcp: true,
        })
    }
}

/// Save through the params surface (both runtimes' `acp_save_custom_agent`).
///
/// Split from [`acp_save_custom_agent_core`] because two fields resolve against
/// the DB rather than against the payload: an absent `params.source` keeps the
/// stored row's provenance (a registry-added agent edited through a partial
/// caller must not silently become "manual") and only a genuinely new row
/// defaults to `Manual` — the params surface is the manual form; an absent
/// `params.supports_mcp` likewise keeps the stored declaration, defaulting to
/// on for a new row.
pub async fn acp_save_custom_agent_params_core(
    params: SaveCustomAgentParams,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let explicit_source = params
        .source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(custom_registry::CustomAgentSource::parse);
    // One read backs both fallbacks, and is skipped entirely when the caller
    // stated everything that could need it.
    let stored = if explicit_source.is_none() || params.supports_mcp.is_none() {
        custom_agent_service::get(&db.conn, params.registry_id.trim())
            .await
            .map_err(|e| AcpError::protocol(e.to_string()))?
    } else {
        None
    };
    let source = explicit_source.unwrap_or_else(|| {
        stored
            .as_ref()
            .map(|row| custom_registry::CustomAgentSource::parse(&row.source))
            .unwrap_or(custom_registry::CustomAgentSource::Manual)
    });
    let supports_mcp = params
        .supports_mcp
        .unwrap_or_else(|| stored.as_ref().map(|row| row.supports_mcp).unwrap_or(true));
    let mut def = params.into_def()?;
    def.source = source;
    def.supports_mcp = supports_mcp;
    acp_save_custom_agent_core(def, db, emitter).await
}

/// Result of extra-slot official login. `launched` is true only when a
/// desktop terminal was actually opened. Headless / web returns the same
/// command so the UI can show a copyable line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraSlotLoginResult {
    pub family: String,
    pub isolator_key: String,
    pub home: String,
    pub command: String,
    pub launched: bool,
}

/// Resolve the official family login for a custom extra slot. Never reads or
/// writes `auth.json` / `.credentials.json`.
pub async fn acp_login_extra_agent_core(
    registry_id: &str,
    db: &AppDatabase,
) -> Result<ExtraSlotLoginResult, AcpError> {
    let row = custom_agent_service::get(&db.conn, registry_id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?
        .ok_or_else(|| AcpError::protocol(format!("custom agent not found: {registry_id}")))?;
    let def = custom_agent_service::def_from_model(&row).ok_or_else(|| {
        AcpError::protocol(format!("custom agent spec is unreadable: {registry_id}"))
    })?;
    let plan = family_isolator::login_plan_from_def(&def).ok_or_else(|| {
        AcpError::protocol(
            "this custom agent has no isolated family home (set CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME, GEMINI_CONFIG_DIR, or OPENCODE_CONFIG_DIR)",
        )
    })?;
    std::fs::create_dir_all(&plan.home).map_err(|e| {
        AcpError::protocol(format!(
            "failed to create isolated home {}: {e}",
            plan.home.display()
        ))
    })?;
    let command = family_isolator::shell_export_and_login(&plan)
        .map_err(AcpError::protocol)?;
    let launched = launch_extra_slot_login(&command, &plan.home);
    Ok(ExtraSlotLoginResult {
        family: plan.family.as_str().to_string(),
        isolator_key: plan.isolator_key.to_string(),
        home: plan.home.display().to_string(),
        command,
        launched,
    })
}

fn launch_extra_slot_login(command: &str, home: &std::path::Path) -> bool {
    if cfg!(test) {
        let _ = (command, home);
        return false;
    }
    #[cfg(feature = "tauri-runtime")]
    {
        let home_str = home.to_string_lossy();
        crate::commands::acp::open_external_terminal_impl(command, Some(home_str.as_ref())).is_ok()
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = (command, home);
        false
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_login_extra_agent(
    registry_id: String,
    db: State<'_, AppDatabase>,
) -> Result<ExtraSlotLoginResult, AcpError> {
    acp_login_extra_agent_core(&registry_id, &db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_list_custom_agents(
    db: State<'_, AppDatabase>,
) -> Result<Vec<CustomAgentInfo>, AcpError> {
    acp_list_custom_agents_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_save_custom_agent(
    params: SaveCustomAgentParams,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_save_custom_agent_params_core(params, &db, &emitter).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_delete_custom_agent(
    registry_id: String,
    delete_transcripts: bool,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_delete_custom_agent_core(registry_id, delete_transcripts, &db, &emitter).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_fetch_registry_catalog(
    db: State<'_, AppDatabase>,
) -> Result<Vec<RegistryCatalogAgent>, AcpError> {
    acp_fetch_registry_catalog_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn acp_current_platform() -> String {
    acp_current_platform_core()
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_add_registry_agent(
    registry_id: String,
    distribution_kind: Option<String>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_add_registry_agent_core(registry_id, distribution_kind, &db, &emitter).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::custom_registry::{BinaryPlatformSpec, NpxSpec};
    use std::collections::BTreeMap;

    #[test]
    fn npm_specs_split_into_name_and_version() {
        assert_eq!(
            split_npm_spec("@qwen-code/qwen-code@0.21.0"),
            ("@qwen-code/qwen-code", Some("0.21.0"))
        );
        assert_eq!(split_npm_spec("cline@3.0.46"), ("cline", Some("3.0.46")));
        assert_eq!(split_npm_spec("@scope/pkg"), ("@scope/pkg", None));
        assert_eq!(split_npm_spec("plain"), ("plain", None));
    }

    #[test]
    fn save_params_reject_an_unknown_distribution_kind() {
        let params = SaveCustomAgentParams {
            registry_id: "x".into(),
            name: "X".into(),
            description: String::new(),
            version: "1".into(),
            distribution_kind: "carrier-pigeon".into(),
            spec: CustomAgentSpec::default(),
            icon_url: None,
            skills_shared_store: false,
            skills_dir: None,
            source: Default::default(),
            version_probe: None,
            supports_mcp: None,
        };
        assert!(params.into_def().is_err());
    }

    #[test]
    fn save_params_trim_the_registry_id() {
        let params = SaveCustomAgentParams {
            registry_id: "  goose  ".into(),
            name: "Goose".into(),
            description: String::new(),
            version: "1".into(),
            distribution_kind: "npx".into(),
            spec: CustomAgentSpec::default(),
            icon_url: None,
            skills_shared_store: false,
            skills_dir: None,
            source: Default::default(),
            version_probe: None,
            supports_mcp: None,
        };
        assert_eq!(params.into_def().unwrap().registry_id, "goose");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn extra_slot_login_uses_isolator_and_does_not_copy_auth() {
        let _guard = custom_registry::hydrate_test_guard();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let emitter = EventEmitter::Noop;
        let extra = tempfile::tempdir().expect("extra home");
        let other = tempfile::tempdir().expect("other home");
        let extra_auth = extra.path().join("auth.json");
        let other_auth = other.path().join(".credentials.json");
        std::fs::write(&extra_auth, b"slot-2\n").unwrap();
        std::fs::write(&other_auth, b"slot-1\n").unwrap();

        let mut params = npx_params("codex-2");
        params.spec.npx.as_mut().unwrap().env.insert(
            "CODEX_HOME".into(),
            extra.path().to_string_lossy().into_owned(),
        );
        acp_save_custom_agent_params_core(params, &db, &emitter)
            .await
            .expect("saves extra slot");

        let result = acp_login_extra_agent_core("codex-2", &db)
            .await
            .expect("login plan");
        assert_eq!(result.family, "codex");
        assert_eq!(result.isolator_key, "CODEX_HOME");
        assert_eq!(result.home, extra.path().display().to_string());
        assert!(result.command.contains("codex login"));
        assert!(result.command.contains("CODEX_HOME"));
        assert!(!result.launched, "unit tests must not spawn a terminal");
        assert_eq!(std::fs::read(&extra_auth).unwrap(), b"slot-2\n");
        assert_eq!(std::fs::read(&other_auth).unwrap(), b"slot-1\n");

        let missing = acp_login_extra_agent_core("goose", &db).await;
        assert!(missing.is_err());

        custom_registry::hydrate(&[]);
    }

    fn npx_params(id: &str) -> SaveCustomAgentParams {
        SaveCustomAgentParams {
            registry_id: id.into(),
            name: "Qwen".into(),
            description: String::new(),
            version: "0.21.0".into(),
            distribution_kind: "npx".into(),
            spec: CustomAgentSpec {
                npx: Some(NpxSpec {
                    package: "@qwen-code/qwen-code@0.21.0".into(),
                    cmd: Some("qwen".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            icon_url: None,
            skills_shared_store: false,
            skills_dir: None,
            source: Default::default(),
            version_probe: None,
            supports_mcp: None,
        }
    }

    #[tokio::test]
    // The hydrate guard is held across awaits on purpose — see the identical
    // note in `custom_agent_service`: it is a test-only mutex no production
    // code takes, and `#[tokio::test]` runs this on a single-threaded runtime.
    #[allow(clippy::await_holding_lock)]
    async fn an_omitted_mcp_declaration_keeps_the_stored_one() {
        let _guard = custom_registry::hydrate_test_guard();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let emitter = EventEmitter::Noop;

        // A brand-new row starts out forwarding MCP.
        acp_save_custom_agent_params_core(npx_params("mcp-params"), &db, &emitter)
            .await
            .expect("saves");
        async fn stored(db: &AppDatabase) -> crate::db::entities::custom_agent::Model {
            custom_agent_service::get(&db.conn, "mcp-params")
                .await
                .unwrap()
                .expect("the row exists")
        }
        assert!(stored(&db).await.supports_mcp);

        // The settings toggle states it explicitly.
        let mut off = npx_params("mcp-params");
        off.supports_mcp = Some(false);
        acp_save_custom_agent_params_core(off, &db, &emitter)
            .await
            .expect("saves");
        assert!(!stored(&db).await.supports_mcp);

        // A caller that re-saves some OTHER declaration without knowing about
        // this one must not switch MCP back on — that would re-break a
        // connection the user just fixed. This is why the field is an
        // `Option`, unlike the full-replace skills fields.
        let mut unaware = npx_params("mcp-params");
        unaware.skills_shared_store = true;
        acp_save_custom_agent_params_core(unaware, &db, &emitter)
            .await
            .expect("saves");
        let row = stored(&db).await;
        assert!(!row.supports_mcp, "an omitted flag must preserve the row");
        assert!(row.skills_shared_store, "the stated field still applies");

        // And it can be turned back on.
        let mut on = npx_params("mcp-params");
        on.supports_mcp = Some(true);
        acp_save_custom_agent_params_core(on, &db, &emitter)
            .await
            .expect("saves");
        assert!(stored(&db).await.supports_mcp);

        custom_registry::hydrate(&[]);
    }

    #[test]
    fn info_flags_a_definition_that_cannot_launch() {
        // Binary-only with no release for this platform: still listed, with a
        // reason, so the user can fix it instead of wondering where it went.
        let mut binary = BTreeMap::new();
        binary.insert(
            "some-unreal-platform".to_string(),
            BinaryPlatformSpec {
                archive: "https://example.com/a.tar.gz".into(),
                cmd: "./a".into(),
                ..Default::default()
            },
        );
        let def = CustomAgentDef {
            registry_id: "unreachable-agent".into(),
            name: "Unreachable".into(),
            description: String::new(),
            version: "1".into(),
            distribution_kind: CustomDistributionKind::Binary,
            spec: CustomAgentSpec {
                binary,
                ..Default::default()
            },
            icon_url: None,
            skills_shared_store: false,
            skills_dir: None,
            source: Default::default(),
            version_probe: None,
            supports_mcp: true,
        };
        let info = info_from_def(&def);
        assert!(!info.launchable);
        assert!(info.problem.unwrap().contains("no binary release"));
    }

    #[test]
    fn skills_dir_normalization_expands_home_and_rejects_relative_paths() {
        // HOME is pinned so a parallel test rewriting it cannot flip the
        // expansion mid-test; expectations still derive from `dirs::home_dir()`
        // itself, which ignores $HOME on Windows.
        temp_env::with_var("HOME", Some("/tmp/codeg-skills-home"), || {
            let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));

            // Blank input reads as "not declared".
            assert_eq!(normalize_skills_dir(None).unwrap(), None);
            assert_eq!(normalize_skills_dir(Some("   ".into())).unwrap(), None);

            // `~` spellings land on the home directory.
            assert_eq!(
                normalize_skills_dir(Some("~/qwen/skills".into())).unwrap(),
                Some(home.join("qwen/skills").to_string_lossy().into_owned())
            );
            assert_eq!(
                normalize_skills_dir(Some("~".into())).unwrap(),
                Some(home.to_string_lossy().into_owned())
            );

            // An absolute path passes through, trimmed.
            let absolute = home.join("elsewhere");
            assert_eq!(
                normalize_skills_dir(Some(format!("  {}  ", absolute.display()))).unwrap(),
                Some(absolute.to_string_lossy().into_owned())
            );

            // Relative paths are rejected rather than silently resolved
            // against whatever the process's working directory happens to be.
            for bad in ["skills", "./skills", "../skills", "~elsewhere/skills"] {
                assert!(
                    normalize_skills_dir(Some(bad.into())).is_err(),
                    "{bad:?} must be rejected"
                );
            }
        });
    }

    #[tokio::test]
    async fn icon_normalization_keeps_uploads_and_refuses_what_it_must_not_fetch() {
        // An uploaded icon arrives already inlined; saving must not touch the
        // network for it.
        let uploaded = "data:image/svg+xml;base64,PHN2Zy8+".to_string();
        assert_eq!(
            normalize_icon(Some(uploaded.clone())).await.as_deref(),
            Some(uploaded.as_str())
        );
        // An oversized one is dropped rather than persisted.
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_ICON_DATA_URL_CHARS));
        assert_eq!(normalize_icon(Some(huge)).await, None);
        // Anything that is not http(s) is dropped, never fetched — notably
        // `file://`, which would otherwise read local disk.
        assert_eq!(normalize_icon(Some("file:///etc/passwd".into())).await, None);
        assert_eq!(normalize_icon(Some("/local/path.svg".into())).await, None);
        assert_eq!(normalize_icon(Some("   ".into())).await, None);
        assert_eq!(normalize_icon(None).await, None);
    }

    #[tokio::test]
    async fn icon_download_enforces_its_cap_while_streaming() {
        use axum::http::header::CONTENT_TYPE;
        use axum::routing::get;

        let app = axum::Router::new()
            // Declares an oversized length up front — rejected without reading
            // the body at all.
            .route(
                "/declared.png",
                get(|| async { ([(CONTENT_TYPE, "image/png")], vec![0u8; MAX_ICON_BYTES * 2]) }),
            )
            // Chunked with NO content-length, so only the running total can
            // stop it. This is the case a length check alone would miss.
            .route(
                "/chunked.png",
                get(|| async {
                    let chunks = futures_util::stream::iter(
                        (0..8).map(|_| Ok::<_, std::io::Error>(vec![0u8; MAX_ICON_BYTES / 4])),
                    );
                    axum::response::Response::builder()
                        .header(CONTENT_TYPE, "image/png")
                        .body(axum::body::Body::from_stream(chunks))
                        .unwrap()
                }),
            )
            .route(
                "/small.png",
                get(|| async { ([(CONTENT_TYPE, "image/png")], vec![7u8; 16]) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        assert_eq!(inline_icon(&format!("http://{addr}/declared.png")).await, None);
        assert_eq!(inline_icon(&format!("http://{addr}/chunked.png")).await, None);
        // An icon within the cap still round-trips into a data URL.
        let small = inline_icon(&format!("http://{addr}/small.png"))
            .await
            .expect("a small icon inlines");
        assert!(small.starts_with("data:image/png;base64,"));
        assert!(small.len() <= MAX_ICON_DATA_URL_CHARS);

        server.abort();
    }

    #[test]
    fn icon_mime_falls_back_to_the_url_extension() {
        assert_eq!(
            mime_from_extension("https://cdn.example.com/registry/v1/goose.svg").as_deref(),
            Some("image/svg+xml")
        );
        // Query strings and fragments must not be mistaken for the extension.
        assert_eq!(
            mime_from_extension("https://e/i.png?v=2#x").as_deref(),
            Some("image/png")
        );
        assert_eq!(mime_from_extension("https://e/icon").as_deref(), None);
        assert_eq!(mime_from_extension("https://e/i.exe").as_deref(), None);
    }

    #[test]
    fn data_urls_are_built_in_the_shape_an_img_tag_accepts() {
        assert_eq!(
            build_data_url("image/svg+xml", b"<svg/>"),
            "data:image/svg+xml;base64,PHN2Zy8+"
        );
    }

    #[test]
    fn info_carries_the_wire_agent_type() {
        let def = CustomAgentDef {
            registry_id: "qwen-code".into(),
            name: "Qwen".into(),
            description: String::new(),
            version: "0.21.0".into(),
            distribution_kind: CustomDistributionKind::Npx,
            spec: CustomAgentSpec {
                npx: Some(NpxSpec {
                    package: "@qwen-code/qwen-code@0.21.0".into(),
                    cmd: Some("qwen".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            icon_url: None,
            skills_shared_store: false,
            skills_dir: None,
            source: Default::default(),
            version_probe: None,
            supports_mcp: true,
        };
        let info = info_from_def(&def);
        assert!(info.launchable);
        assert_eq!(info.problem, None);
        assert_eq!(
            serde_json::to_value(info.agent_type).unwrap(),
            serde_json::json!("custom:qwen-code")
        );
    }
}
