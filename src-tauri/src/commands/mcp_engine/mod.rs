//! The MCP engine: what every agent's MCP configuration says, and the only
//! way codeg changes it.
//!
//! Three commands, each a `_core` function shared by the desktop command and
//! the web handler:
//!
//! - [`mcp_inventory`]: every agent's servers, read agent by agent and never
//!   merged — where the file is (with the environment the agent is launched
//!   with applied), whether codeg can read and write it, what transports it
//!   takes, how its servers reach a session, and each entry with its
//!   definition, the agent's own fields, its on/off state and its problems.
//! - [`mcp_apply`]: a list of operations, each naming an agent and an entry,
//!   and the basis of every file the caller saw. All of it is done or none
//!   of it; a preflight does none of it and says what would happen.
//! - [`mcp_parse_snippet`]: servers out of pasted configuration.
//!
//! How a write stays safe is spread over the modules: [`lock`] (one writer
//! at a time, across processes), [`apply`] (the basis check, the validation,
//! the restore), `store` and its formats (edits that keep the rest of the
//! document byte for byte), [`fsio`] (atomic replacement, pre-write copies),
//! and `acp::codex_catalog_commit::mcp_servers` (the one door to Codex's
//! config.toml).
//!
//! The commands this replaces — `commands::mcp`'s `mcp_scan_local` and its
//! seven siblings — stay for one release, for older clients of a newer
//! server. They take the same write lock, and reach Codex's file through
//! [`legacy_codex_replace_entry`].

pub(crate) mod agents;
pub(crate) mod apply;
pub(crate) mod dialect;
pub(crate) mod fsio;
pub(crate) mod inventory;
pub(crate) mod json_doc;
pub mod lock;
pub mod model;
pub(crate) mod plugin_gate;
pub mod session;
pub(crate) mod snippet;
pub(crate) mod store;
pub(crate) mod toml_doc;
pub(crate) mod yaml_doc;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use crate::acp::codex_catalog_commit;
use crate::app_error::AppCommandError;
use crate::commands::mcp::McpAppType;
use crate::db::service::agent_setting_service;
use crate::db::AppDatabase;
use crate::web::event_bridge::{emit_event, EventEmitter};

use agents::EngineCtx;
use apply::CodexAccess;
use model::{codes, McpOpIssue};
pub use model::{
    McpApplyRequest, McpApplyResult, McpChanged, McpInventory, McpOp, McpSnippet, MCP_CHANGED_EVENT,
};

/// `lock_busy` → `errors.lockBusy`: the key the page finds the message
/// under, the way the older MCP errors name theirs.
fn i18n_key(code: &str) -> String {
    let mut key = String::from("errors.");
    let mut upper = false;
    for c in code.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            key.extend(c.to_uppercase());
            upper = false;
        } else {
            key.push(c);
        }
    }
    key
}

/// Stamp an error with its stable code: `i18n_key` is `errors.<codeInCamel>`
/// and `i18n_params` carries the code itself (`code`) and, when there is one,
/// the technical detail (`detail`).
pub(crate) fn coded_error(
    error: AppCommandError,
    code: &str,
    detail: Option<String>,
) -> AppCommandError {
    let mut params = BTreeMap::from([("code".to_string(), code.to_string())]);
    if let Some(detail) = detail {
        params.insert("detail".to_string(), detail);
    }
    error.with_i18n(i18n_key(code), params)
}

/// Which agents are on this machine, as the Agents page sees it. `None` for
/// every agent when that cannot be told.
pub(crate) async fn installed_agents(db: &AppDatabase) -> BTreeMap<McpAppType, bool> {
    match crate::commands::acp::acp_list_agents_core(db).await {
        Ok(listed) => listed
            .into_iter()
            .filter_map(|agent| {
                Some((
                    agents::app_of(agent.agent_type)?,
                    agent.installed_version.is_some(),
                ))
            })
            .collect(),
        Err(error) => {
            tracing::warn!("[MCP] could not tell which agents are installed: {error}");
            BTreeMap::new()
        }
    }
}

pub(crate) async fn engine_ctx(db: &AppDatabase) -> EngineCtx {
    EngineCtx::from_envs(&agent_setting_service::load_agent_envs(&db.conn).await)
}

pub async fn mcp_inventory_core(db: &AppDatabase) -> Result<McpInventory, AppCommandError> {
    let ctx = engine_ctx(db).await;
    let installed = installed_agents(db).await;
    // Twenty-odd files, some of them megabytes (`~/.claude.json`): off the
    // async workers.
    tokio::task::spawn_blocking(move || inventory::inventory(&ctx, &installed))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(format!("MCP inventory: {e}")))
}

fn codex_lock_issue(error: &codex_catalog_commit::CatalogError) -> McpOpIssue {
    let code = match error.code {
        "lock_busy" => codes::CODEX_LOCK_BUSY,
        "lock_held" => codes::CODEX_LOCK_HELD,
        "repair_needed" => codes::CODEX_REPAIR_NEEDED,
        _ => codes::IO_ERROR,
    };
    McpOpIssue::new(code).detail(error.message.clone())
}

/// Run `request` in `ctx`: take the MCP write lock, then Codex's when Codex
/// is among the agents, then [`apply::apply_locked`]. A preflight takes
/// neither.
pub(crate) async fn apply_in(ctx: &EngineCtx, request: &McpApplyRequest) -> McpApplyResult {
    apply_in_then(ctx, request, |_| ()).await.0
}

/// [`apply_in`], then `then` on the result while the MCP write lock is still
/// held — for a caller that keeps a record of its own in step with what was
/// written (the Harness provenance file). `then` does not run for a preflight
/// or when the lock could not be taken; it does run when the save itself
/// failed, with the result that says so.
pub(crate) async fn apply_in_then<R>(
    ctx: &EngineCtx,
    request: &McpApplyRequest,
    then: impl FnOnce(&McpApplyResult) -> R,
) -> (McpApplyResult, Option<R>) {
    match apply_in_guarded(
        ctx,
        request,
        || Ok::<(), std::convert::Infallible>(()),
        then,
    )
    .await
    {
        Ok(done) => done,
        Err(never) => match never {},
    }
}

/// [`apply_in_then`], with `guard` run once the MCP write lock is held and
/// before any file is read or written. An `Err` from it calls the save off —
/// nothing is written, `then` does not run, the lock is let go — and is
/// handed back. For a caller whose own record must still agree with what it
/// planned on, checked under the lock that record is written under (the
/// Harness provenance file). `guard` does not run for a preflight, nor when
/// the lock could not be taken.
pub(crate) async fn apply_in_guarded<G, R>(
    ctx: &EngineCtx,
    request: &McpApplyRequest,
    guard: impl FnOnce() -> Result<(), G>,
    then: impl FnOnce(&McpApplyResult) -> R,
) -> Result<(McpApplyResult, Option<R>), G> {
    if request.preflight {
        let result = apply::apply_locked(ctx, request, &CodexAccess::Unlocked);
        return Ok((result, None));
    }
    let _guard = match lock::acquire_at(&ctx.lock_path, ctx.lock_wait).await {
        Ok(guard) => guard,
        Err(error) => {
            let mut problem = McpOpIssue::new(error.code());
            problem.detail = error.detail();
            return Ok((apply::busy_result(ctx, request, problem), None));
        }
    };
    guard()?;
    let codex_home = request
        .ops
        .iter()
        .any(|op| op.agent == McpAppType::Codex)
        .then(|| ctx.paths_of(McpAppType::Codex))
        .flatten()
        .and_then(|paths| paths.servers.parent().map(std::path::Path::to_path_buf));
    let locked = match &codex_home {
        Some(home) => Some(codex_catalog_commit::lock_home(home).await),
        None => None,
    };
    let result = {
        let access = match &locked {
            None => CodexAccess::Unlocked,
            Some(Ok(home)) => CodexAccess::Locked(home),
            Some(Err(error)) => CodexAccess::Failed(codex_lock_issue(error)),
        };
        apply::apply_locked(ctx, request, &access)
    };
    // Codex's lock is let go first; the MCP lock is still held.
    drop(locked);
    let after = then(&result);
    Ok((result, Some(after)))
}

fn announce(emitter: &EventEmitter, agents: Vec<McpAppType>) {
    if !agents.is_empty() {
        emit_event(emitter, MCP_CHANGED_EVENT, McpChanged { agents });
    }
}

/// Tell every window and web client that these agents' MCP configuration
/// changed — which agents, and nothing of what is in their files.
pub(crate) fn announce_changed(emitter: &EventEmitter, agents: &[McpAppType]) {
    let mut agents = agents.to_vec();
    agents.sort();
    agents.dedup();
    announce(emitter, agents);
}

pub async fn mcp_apply_core(
    db: &AppDatabase,
    emitter: &EventEmitter,
    request: McpApplyRequest,
) -> Result<McpApplyResult, AppCommandError> {
    let ctx = engine_ctx(db).await;
    let result = apply_in(&ctx, &request).await;
    announce(emitter, apply::changed_agents(&result));
    Ok(result)
}

/// [`mcp_apply_core`], with `then` run on the result before the MCP write
/// lock is let go (see [`apply_in_then`]). For callers inside codeg that
/// write a record of their own under the same lock.
pub async fn mcp_apply_core_then<R>(
    db: &AppDatabase,
    emitter: &EventEmitter,
    request: McpApplyRequest,
    then: impl FnOnce(&McpApplyResult) -> R,
) -> Result<(McpApplyResult, Option<R>), AppCommandError> {
    let ctx = engine_ctx(db).await;
    let (result, after) = apply_in_then(&ctx, &request, then).await;
    announce(emitter, apply::changed_agents(&result));
    Ok((result, after))
}

pub fn mcp_parse_snippet_core(text: &str) -> McpSnippet {
    snippet::parse_snippet(text)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn mcp_inventory(
    db: tauri::State<'_, AppDatabase>,
) -> Result<McpInventory, AppCommandError> {
    mcp_inventory_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn mcp_apply(
    basis: Option<BTreeMap<McpAppType, String>>,
    ops: Vec<McpOp>,
    preflight: Option<bool>,
    db: tauri::State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<McpApplyResult, AppCommandError> {
    let request = McpApplyRequest {
        basis: basis.unwrap_or_default(),
        ops,
        preflight: preflight.unwrap_or(false),
    };
    mcp_apply_core(&db, &EventEmitter::from_app(&app), request).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn mcp_parse_snippet(text: String) -> Result<McpSnippet, AppCommandError> {
    Ok(mcp_parse_snippet_core(&text))
}

// ─── The retired commands' way to Codex's file ──────────────────────────

fn toml_to_item(value: &toml::Value) -> toml_edit::Item {
    fn to_value(value: &toml::Value) -> Option<toml_edit::Value> {
        Some(match value {
            toml::Value::String(text) => text.as_str().into(),
            toml::Value::Integer(number) => (*number).into(),
            toml::Value::Float(number) => (*number).into(),
            toml::Value::Boolean(flag) => (*flag).into(),
            toml::Value::Datetime(when) => {
                when.to_string().parse::<toml_edit::Datetime>().ok()?.into()
            }
            toml::Value::Array(items) => {
                let mut array = toml_edit::Array::new();
                for item in items.iter().filter_map(to_value) {
                    array.push(item);
                }
                toml_edit::Value::Array(array)
            }
            toml::Value::Table(table) => {
                let mut inline = toml_edit::InlineTable::new();
                for (key, item) in table {
                    if let Some(item) = to_value(item) {
                        inline.insert(key, item);
                    }
                }
                toml_edit::Value::InlineTable(inline)
            }
        })
    }
    match value {
        toml::Value::Table(table) => {
            let mut out = toml_edit::Table::new();
            for (key, item) in table {
                let item = toml_to_item(item);
                if !item.is_none() {
                    out.insert(key, item);
                }
            }
            toml_edit::Item::Table(out)
        }
        other => to_value(other)
            .map(toml_edit::Item::Value)
            .unwrap_or(toml_edit::Item::None),
    }
}

/// Put `entry` under `[mcp_servers.<id>]` of the Codex config in `home` — or
/// take the entry away, with `None` — the way the retired commands mean it:
/// the whole entry is theirs to replace. Unlike before, the rest of the file
/// is kept as it is, and the write goes where every write of Codex's files
/// goes: through `codex_catalog_commit`, under its lock.
///
/// Synchronous, for those commands' per-agent walk; the caller holds the MCP
/// write lock. Returns whether the file changed.
pub(crate) fn legacy_codex_replace_entry(
    home: &std::path::Path,
    id: &str,
    entry: Option<&toml::Value>,
) -> Result<bool, AppCommandError> {
    let invalid = |message: String| AppCommandError::configuration_invalid(message);
    let locked = codex_catalog_commit::lock_home_blocking(home).map_err(|error| {
        let issue = codex_lock_issue(&error);
        coded_error(
            AppCommandError::task_execution_failed(error.message.clone()),
            &issue.code,
            issue.detail,
        )
    })?;
    let path = locked.config_path();
    let original = locked.read_config_bytes().map_err(|error| {
        let detail = format!("{}: {error}", path.display());
        AppCommandError::io(error).with_detail(detail)
    })?;
    if original.is_none() && entry.is_none() {
        return Ok(false);
    }
    let text = store::decode(original.as_deref())
        .map_err(|_| invalid(format!("{} is not UTF-8 text", path.display())))?;
    let (bom, body) = store::split_bom(text);
    let mut doc = body
        .parse::<toml_edit::Document>()
        .map_err(|e| invalid(format!("invalid TOML at {}: {e}", path.display())))?;

    let mut changed = false;
    match entry {
        Some(entry) => {
            if doc.get("mcp_servers").is_none() {
                let mut table = toml_edit::Table::new();
                table.set_implicit(true);
                doc.as_table_mut()
                    .insert("mcp_servers", toml_edit::Item::Table(table));
            }
            let servers = doc
                .get_mut("mcp_servers")
                .and_then(toml_edit::Item::as_table_like_mut)
                .ok_or_else(|| invalid("Codex mcp_servers must be a TOML table".to_string()))?;
            servers.insert(id, toml_to_item(entry));
            changed = true;
        }
        None => {
            if let Some(servers) = doc
                .get_mut("mcp_servers")
                .and_then(toml_edit::Item::as_table_like_mut)
            {
                changed |= servers.remove(id).is_some();
            }
        }
    }
    // The copy an older codeg left under `[mcp.servers]` goes either way.
    let mut legacy_emptied = false;
    if let Some(mcp) = doc
        .get_mut("mcp")
        .and_then(toml_edit::Item::as_table_like_mut)
    {
        let mut servers_emptied = false;
        if let Some(servers) = mcp
            .get_mut("servers")
            .and_then(toml_edit::Item::as_table_like_mut)
        {
            changed |= servers.remove(id).is_some();
            servers_emptied = servers.is_empty();
        }
        if servers_emptied {
            mcp.remove("servers");
        }
        legacy_emptied = servers_emptied && mcp.is_empty();
    }
    if legacy_emptied {
        doc.as_table_mut().remove("mcp");
    }
    if !changed {
        return Ok(false);
    }
    let updated = store::with_bom(bom, doc.to_string());
    if Some(updated.as_bytes()) == original.as_deref() {
        return Ok(false);
    }
    if let Some(original) = &original {
        let backups = agents::default_backup_root().join(agents::wire_name(McpAppType::Codex));
        fsio::backup(&backups, &path, original).map_err(|error| {
            coded_error(
                AppCommandError::io_error(format!(
                    "could not keep a copy of {} before changing it",
                    path.display()
                )),
                codes::BACKUP_FAILED,
                Some(error.to_string()),
            )
        })?;
    }
    locked
        .commit_mcp_servers(
            original.as_deref(),
            codex_catalog_commit::McpConfigChange::Write(updated.as_bytes()),
        )
        .map_err(|error| {
            let message = error.to_string();
            let issue = match error {
                codex_catalog_commit::McpCommitError::Changed => codes::BASIS_MISMATCH,
                codex_catalog_commit::McpCommitError::OutsideMcpServers => {
                    codes::OUTSIDE_MCP_SERVERS
                }
                codex_catalog_commit::McpCommitError::Invalid(_) => codes::EDIT_FAILED,
                codex_catalog_commit::McpCommitError::Io(_) => codes::WRITE_FAILED,
            };
            coded_error(AppCommandError::configuration_invalid(message), issue, None)
        })?;
    Ok(true)
}

#[cfg(test)]
mod engine_tests {
    use super::*;

    #[test]
    fn a_code_names_its_translation_key() {
        assert_eq!(i18n_key("lock_busy"), "errors.lockBusy");
        assert_eq!(i18n_key("codex_repair_needed"), "errors.codexRepairNeeded");
        assert_eq!(i18n_key("busy"), "errors.busy");
        let error = coded_error(
            AppCommandError::io_error("x"),
            codes::LOCK_BUSY,
            Some("why".to_string()),
        );
        assert_eq!(error.i18n_key.as_deref(), Some("errors.lockBusy"));
        let params = error.i18n_params.unwrap();
        assert_eq!(params["code"], "lock_busy");
        assert_eq!(params["detail"], "why");
    }

    /// The copies the engine takes hold tokens, and the lock is per user:
    /// neither may be swept into codeg's own backup.
    #[test]
    fn codegs_backup_takes_neither_the_copies_nor_the_locks() {
        use crate::commands::backup::sections::MANAGED_SECTIONS;
        let codeg = agents::real_codeg_dir();
        let private = [
            codeg.join("mcp").join("backups"),
            codeg.join("locks").join(lock::LOCK_FILE),
            codeg.join("harness").join("mcp.json"),
        ];
        // With the data directory at its default, `~/.codeg` itself.
        let data_dir = codeg.clone();
        for section in MANAGED_SECTIONS {
            let live = (section.live_path)(&data_dir);
            for path in &private {
                assert!(
                    !path.starts_with(&live),
                    "backup section `{}` ({}) would pack {}",
                    section.id,
                    live.display(),
                    path.display()
                );
            }
        }
    }

    #[test]
    fn the_retired_commands_reach_codex_through_its_commit() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex");
        std::fs::create_dir_all(&home).unwrap();
        let config = home.join("config.toml");
        let before = "# mine\nmodel = \"gpt-5.5\" # default\n\n[mcp_servers.keep]\ncommand = \"keep\" # as is\n\n[mcp.servers.old]\ncommand = \"old\"\n";
        std::fs::write(&config, before).unwrap();

        let entry: toml::Value = "command = \"npx\"\nargs = [\"-y\", \"x\"]\n[env]\nA = \"b\"\n"
            .parse::<toml::Table>()
            .map(toml::Value::Table)
            .unwrap();
        assert!(legacy_codex_replace_entry(&home, "old", Some(&entry)).unwrap());
        let after = std::fs::read_to_string(&config).unwrap();
        assert!(after.contains("# mine"), "{after}");
        assert!(after.contains("model = \"gpt-5.5\" # default"), "{after}");
        assert!(after.contains("command = \"keep\" # as is"), "{after}");
        let parsed: toml::Table = after.parse().unwrap();
        assert!(parsed.get("mcp").is_none(), "the old copy is gone: {after}");
        assert_eq!(parsed["mcp_servers"]["old"]["env"]["A"].as_str(), Some("b"));
        assert_eq!(
            parsed["mcp_servers"]["old"]["args"]
                .as_array()
                .map(Vec::len),
            Some(2)
        );

        // Removing what is not there writes nothing.
        assert!(!legacy_codex_replace_entry(&home, "absent", None).unwrap());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), after);
        assert!(legacy_codex_replace_entry(&home, "old", None).unwrap());
        let parsed: toml::Table = std::fs::read_to_string(&config).unwrap().parse().unwrap();
        assert!(parsed["mcp_servers"].get("old").is_none());
        assert!(parsed["mcp_servers"].get("keep").is_some());

        // No file and nothing to remove: no file is made.
        let empty = dir.path().join("empty");
        assert!(!legacy_codex_replace_entry(&empty, "x", None).unwrap());
        assert!(!empty.join("config.toml").exists());
    }
}
