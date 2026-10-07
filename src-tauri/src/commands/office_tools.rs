//! OfficeCLI integration — detect, install/uninstall the binary, and manage
//! OfficeCLI skills as external experts.
//!
//! Skills are loaded dynamically from the OfficeCLI binary (`officecli
//! load_skill <id>`) and placed in the same central store
//! (`~/.codeg/skills/<id>/`) used by built-in experts. Enabling a skill for
//! an agent reuses the expert system's symlink mechanism.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::acp::types::AgentSkillScope;
use crate::commands::acp::{
    preferred_scope_skill_dir, remove_skill_entry, resolve_command_on_path, scoped_skill_dirs,
    skill_storage_spec, validate_skill_id,
};
use crate::commands::experts::{
    central_experts_dir, classify_link, create_link_raw, path_is_symlink, read_link_target,
    ExpertInstallStatus, ExpertLinkState, LinkOp, LinkOpResult,
};
use crate::app_error::AppCommandError;
use crate::commands::folders::resolve_tree_path;
use crate::models::agent::AgentType;
use crate::process::{collect_lines_lossy, tokio_command};
use crate::web::event_bridge::EventEmitter;

// ─── Error type ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum OfficeToolsError {
    #[error("officecli is not installed")]
    NotInstalled,
    #[error("skill not found: {0}")]
    SkillNotFound(String),
    #[error("agent does not support skills: {0:?}")]
    UnsupportedAgent(AgentType),
    #[error("a real directory already exists at '{path}'")]
    NameCollision { path: String },
    #[error("a different link already exists at '{path}' (points to '{found}')")]
    ForeignLink { path: String, found: String },
    #[error("io error: {0}")]
    Io(String),
    #[error("command failed: {0}")]
    CommandFailed(String),
}

impl Serialize for OfficeToolsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<io::Error> for OfficeToolsError {
    fn from(err: io::Error) -> Self {
        OfficeToolsError::Io(err.to_string())
    }
}

// ─── Concurrency ───────────────────────────────────────────────────────

fn mutation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

// ─── Public types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficecliInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// Set when the binary file is present (`installed = true`) but actually
    /// running it failed — e.g. a self-contained-.NET startup failure from a
    /// missing system library (libicu) on a slim Linux server image. Carries a
    /// human-readable, actionable diagnostic; `None` when officecli runs fine or
    /// isn't installed at all.
    pub runtime_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficecliSkill {
    pub id: String,
    pub category: String,
    pub icon: String,
    pub sort_order: i32,
    pub display_name: BTreeMap<String, String>,
    pub description: BTreeMap<String, String>,
    pub installed_centrally: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSyncReport {
    pub synced: usize,
    pub errors: Vec<String>,
}

// ─── Skill metadata (hardcoded — OfficeCLI has no list command) ────────

struct SkillDef {
    /// Canonical skill identity used throughout codeg: the central-store
    /// directory name (`~/.codeg/skills/<id>/`) and the agent invocation
    /// name (`/<id>`). Matches the SKILL.md frontmatter `name:` so the
    /// directory and the skill's self-declared name agree.
    id: &'static str,
    /// Argument passed to `officecli load_skill <load_id>`. The CLI uses
    /// short ids (`pptx`, `word`, `excel`) that differ from the invocation
    /// name (`officecli-pptx`, `officecli-docx`, `officecli-xlsx`); for the
    /// morph skills the two happen to coincide.
    load_id: &'static str,
    category: &'static str,
    icon: &'static str,
    sort_order: i32,
    en_name: &'static str,
    en_desc: &'static str,
    zh_name: &'static str,
    zh_desc: &'static str,
}

const SKILLS: &[SkillDef] = &[
    SkillDef {
        id: "officecli-pptx",
        load_id: "pptx",
        category: "presentations",
        icon: "Presentation",
        sort_order: 10,
        en_name: "Presentation",
        en_desc: "Generic presentations — board reviews, sales decks, all-hands",
        zh_name: "演示文稿",
        zh_desc: "通用演示文稿——评审、销售汇报、全员大会",
    },
    SkillDef {
        id: "officecli-pitch-deck",
        load_id: "pitch-deck",
        category: "presentations",
        icon: "Rocket",
        sort_order: 20,
        en_name: "Pitch Deck",
        en_desc: "Fundraising pitch decks — Seed, Series A–C, SAFE, convertible",
        zh_name: "融资路演",
        zh_desc: "融资路演 PPT——种子轮、A–C 轮、SAFE、可转换票据",
    },
    SkillDef {
        id: "morph-ppt",
        load_id: "morph-ppt",
        category: "presentations",
        icon: "Clapperboard",
        sort_order: 30,
        en_name: "Morph Animation PPT",
        en_desc: "Cinematic Morph-animated presentations",
        zh_name: "Morph 动画 PPT",
        zh_desc: "电影级 Morph 过渡动画演示文稿",
    },
    SkillDef {
        id: "morph-ppt-3d",
        load_id: "morph-ppt-3d",
        category: "presentations",
        icon: "Box",
        sort_order: 40,
        en_name: "3D Morph PPT",
        en_desc: "3D Morph with GLB models and camera moves",
        zh_name: "3D Morph PPT",
        zh_desc: "3D Morph + GLB 模型 + 镜头运动",
    },
    SkillDef {
        id: "officecli-docx",
        load_id: "word",
        category: "documents",
        icon: "FileText",
        sort_order: 50,
        en_name: "Word Document",
        en_desc: "Reports, letters, memos, proposals",
        zh_name: "Word 文档",
        zh_desc: "报告、信件、备忘录、提案",
    },
    SkillDef {
        id: "officecli-academic-paper",
        load_id: "academic-paper",
        category: "documents",
        icon: "GraduationCap",
        sort_order: 60,
        en_name: "Academic Paper",
        en_desc: "Journal/thesis with citations, equations, cross-refs",
        zh_name: "学术论文",
        zh_desc: "期刊论文——引用、公式、交叉引用",
    },
    SkillDef {
        id: "officecli-xlsx",
        load_id: "excel",
        category: "spreadsheets",
        icon: "FileSpreadsheet",
        sort_order: 70,
        en_name: "Excel Workbook",
        en_desc: "Generic workbooks, formulas, pivots, trackers",
        zh_name: "Excel 工作簿",
        zh_desc: "通用工作簿——公式、数据透视表、追踪表",
    },
    SkillDef {
        id: "officecli-financial-model",
        load_id: "financial-model",
        category: "spreadsheets",
        icon: "TrendingUp",
        sort_order: 80,
        en_name: "Financial Model",
        en_desc: "3-statement, DCF, LBO, scenarios, projections",
        zh_name: "财务模型",
        zh_desc: "三大报表、DCF、LBO、情景分析、预测",
    },
    SkillDef {
        id: "officecli-data-dashboard",
        load_id: "data-dashboard",
        category: "spreadsheets",
        icon: "BarChart3",
        sort_order: 90,
        en_name: "Data Dashboard",
        en_desc: "CSV/tabular data → KPI/analytics Excel dashboards",
        zh_name: "数据仪表盘",
        zh_desc: "CSV/表格数据 → KPI/分析 Excel 仪表盘",
    },
];

/// Ids of all OfficeCLI-managed skills. Used by the custom-skills pack to
/// exclude built-in ids from the "custom" set (all packs share the central
/// store).
pub(crate) fn bundled_skill_ids() -> Vec<String> {
    SKILLS.iter().map(|s| s.id.to_string()).collect()
}

fn skill_defs() -> &'static [SkillDef] {
    SKILLS
}

fn find_skill_def(id: &str) -> Option<&'static SkillDef> {
    skill_defs().iter().find(|s| s.id == id)
}

fn skill_def_to_metadata(def: &SkillDef) -> OfficecliSkill {
    let mut display_name = BTreeMap::new();
    display_name.insert("en".to_string(), def.en_name.to_string());
    display_name.insert("zh-CN".to_string(), def.zh_name.to_string());

    let mut description = BTreeMap::new();
    description.insert("en".to_string(), def.en_desc.to_string());
    description.insert("zh-CN".to_string(), def.zh_desc.to_string());

    let central_path = skill_central_path(def.id);
    OfficecliSkill {
        id: def.id.to_string(),
        category: def.category.to_string(),
        icon: def.icon.to_string(),
        sort_order: def.sort_order,
        display_name,
        description,
        installed_centrally: central_path.exists(),
    }
}

// ─── Path helpers ──────────────────────────────────────────────────────

fn skill_central_path(skill_id: &str) -> PathBuf {
    central_experts_dir().join(skill_id)
}

fn agent_link_path(agent: AgentType, skill_id: &str) -> Result<PathBuf, OfficeToolsError> {
    let dir = preferred_scope_skill_dir(agent, AgentSkillScope::Global, None)
        .map_err(|_| OfficeToolsError::UnsupportedAgent(agent))?;
    Ok(dir.join(skill_id))
}

// ─── Binary detection ──────────────────────────────────────────────────

/// Locations the official OfficeCLI installers drop the binary, in priority
/// order. `install.sh` uses `~/.local/bin/officecli` on Unix; `install.ps1`
/// uses `%LOCALAPPDATA%\OfficeCLI\officecli.exe` on Windows. Used as a fallback
/// when `officecli` isn't (yet) on `PATH`.
fn officecli_known_install_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            paths.push(
                PathBuf::from(local_app_data)
                    .join("OfficeCLI")
                    .join("officecli.exe"),
            );
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".local").join("bin").join("officecli"));
        }
    }
    paths
}

/// The path `officecli_uninstall` removes — the official installer's primary
/// install location for this platform.
fn officecli_primary_install_path() -> Option<PathBuf> {
    officecli_known_install_paths().into_iter().next()
}

pub(crate) fn resolve_officecli() -> Option<PathBuf> {
    if let Some(p) = resolve_command_on_path("officecli") {
        return Some(p);
    }
    // Fall back to the official installers' known locations — covers the window
    // on Windows where `install.ps1`'s persistent User-PATH change hasn't yet
    // reached this already-running process.
    officecli_known_install_paths()
        .into_iter()
        .find(|p| p.is_file())
}

/// Directory to prepend to a spawned agent's `PATH` so agent-invoked
/// `officecli …` (from an enabled office skill) resolves immediately after a
/// fresh install — before `install.ps1`'s persistent User-PATH change reaches
/// already-running processes (codeg and the agents it spawns). Returns `None`
/// once `officecli` is on `PATH` (the injection then self-deactivates) or when
/// it isn't installed. Also closes the latent gap where a GUI-launched codeg on
/// Unix doesn't inherit `~/.local/bin` on `PATH`.
pub(crate) fn officecli_agent_path_dir() -> Option<PathBuf> {
    if resolve_command_on_path("officecli").is_some() {
        return None;
    }
    officecli_known_install_paths()
        .into_iter()
        .find(|p| p.is_file())
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Recognize the self-contained-.NET "missing system dependency" startup
/// failures in an officecli invocation's stderr and return an actionable hint.
///
/// OfficeCLI is a single self-contained binary with an embedded .NET runtime;
/// on Linux that runtime still needs a few system libraries at startup — most
/// commonly ICU (globalization). The slim server/Docker base image
/// (`node:*-bookworm-slim`) doesn't ship `libicu`, so every officecli call
/// aborts before doing any work and the raw .NET message ("Couldn't find a valid
/// ICU package installed on the system") is opaque to most users. Map the known
/// signatures to a fix; return `None` for unrecognized stderr (shown verbatim).
fn officecli_runtime_dependency_hint(stderr: &str) -> Option<String> {
    let lower = stderr.to_ascii_lowercase();
    let missing_icu = lower.contains("valid icu package")
        || lower.contains("libicu")
        || (lower.contains("icu") && lower.contains("globalization"));
    if missing_icu {
        return Some(
            "officecli could not start: the server is missing the ICU library its \
             embedded .NET runtime needs. Install it in the runtime image and restart \
             (Debian/Ubuntu: `apt-get install -y libicu72`; Alpine: `apk add icu-libs`), \
             or upgrade to a codeg image that already includes it."
                .to_string(),
        );
    }
    if lower.contains("error while loading shared libraries") {
        return Some(
            "officecli could not start: a required system library is missing on the \
             server. Install the library named in the error below and restart."
                .to_string(),
        );
    }
    None
}

/// Build a diagnostic for an officecli invocation that ran but failed, pairing a
/// recognized actionable hint (missing libicu, …) with a bounded tail of the raw
/// stderr so the underlying error is never hidden.
fn officecli_run_failure_message(stderr: &str) -> String {
    let stderr = stderr.trim();
    match officecli_runtime_dependency_hint(stderr) {
        Some(hint) if stderr.is_empty() => hint,
        Some(hint) => format!("{hint}\n\nofficecli error: {}", bounded_tail(stderr, 600)),
        None if stderr.is_empty() => {
            "officecli exited with an error and produced no output".to_string()
        }
        None => format!("officecli error: {}", bounded_tail(stderr, 600)),
    }
}

/// Outcome of probing an installed officecli binary by running `--version`.
struct OfficecliProbe {
    version: Option<String>,
    runtime_error: Option<String>,
}

/// Run `officecli --version` to learn the version AND confirm the binary can
/// actually execute. A present-but-unrunnable binary (e.g. missing libicu on a
/// slim Linux server) yields `runtime_error` so the UI can show "installed but
/// not runnable" instead of a misleading healthy "installed" badge.
async fn probe_officecli(binary: &Path) -> OfficecliProbe {
    match tokio_command(binary).arg("--version").output().await {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            OfficecliProbe {
                version: (!version.is_empty()).then_some(version),
                runtime_error: None,
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::warn!(
                "[office] `officecli --version` exited unsuccessfully ({}): {}",
                output.status,
                stderr.trim()
            );
            OfficecliProbe {
                version: None,
                runtime_error: Some(officecli_run_failure_message(&stderr)),
            }
        }
        Err(e) => {
            tracing::warn!("[office] `officecli --version` could not be spawned: {e}");
            OfficecliProbe {
                version: None,
                runtime_error: Some(format!("failed to run officecli: {e}")),
            }
        }
    }
}

// ─── Commands: detect ──────────────────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_detect() -> OfficecliInfo {
    match resolve_officecli() {
        Some(path) => {
            let probe = probe_officecli(&path).await;
            OfficecliInfo {
                installed: true,
                version: probe.version,
                path: Some(path.to_string_lossy().to_string()),
                runtime_error: probe.runtime_error,
            }
        }
        None => OfficecliInfo {
            installed: false,
            version: None,
            path: None,
            runtime_error: None,
        },
    }
}

// ─── Commands: install / uninstall ─────────────────────────────────────

// ─── Streamed install progress events ──────────────────────────────────
//
// The official installer downloads a multi-MB binary; on a slow network that
// looks like a hang. Mirror the ACP agent-install UX: stream the installer's
// stdout/stderr to the settings page line-by-line over a dedicated event
// channel, tagged with the caller's `task_id` so concurrent installs don't
// cross-contaminate. Shape matches `AgentInstallEvent` in `commands::acp`.

const OFFICECLI_INSTALL_EVENT: &str = "app://officecli-install";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum OfficecliInstallEventKind {
    Started,
    Log,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
struct OfficecliInstallEvent {
    task_id: String,
    kind: OfficecliInstallEventKind,
    payload: String,
}

fn emit_officecli_install_event(
    emitter: &EventEmitter,
    task_id: &str,
    kind: OfficecliInstallEventKind,
    payload: impl Into<String>,
) {
    crate::web::event_bridge::emit_event(
        emitter,
        OFFICECLI_INSTALL_EVENT,
        OfficecliInstallEvent {
            task_id: task_id.to_string(),
            kind,
            payload: payload.into(),
        },
    );
}

/// Tauri command: run the OfficeCLI installer, streaming progress as
/// `app://officecli-install` events tagged with `task_id`. The work lives in
/// `officecli_install_core` so the web handler can share it with its own emitter.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn officecli_install(
    task_id: String,
    app: tauri::AppHandle,
) -> Result<OfficecliInfo, OfficeToolsError> {
    officecli_install_core(task_id, &EventEmitter::Tauri(app)).await
}

/// Run the vendor's official installer script (mirror-first, GitHub fallback),
/// streaming its output to the UI as `app://officecli-install` log events. The
/// script owns the download, checksum, install location, and — on Windows — the
/// persistent User-PATH registration. See `officecli_install_command`.
pub(crate) async fn officecli_install_core(
    task_id: String,
    emitter: &EventEmitter,
) -> Result<OfficecliInfo, OfficeToolsError> {
    emit_officecli_install_event(emitter, &task_id, OfficecliInstallEventKind::Started, "");

    // Install and uninstall share `mutation_lock`. Acquire it AFTER the first
    // stream event so the panel is responsive immediately, and surface a waiting
    // hint when another operation already holds it (e.g. a second web client)
    // rather than spinning silently for up to the install timeout.
    let _guard = match mutation_lock().try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            emit_officecli_install_event(
                emitter,
                &task_id,
                OfficecliInstallEventKind::Log,
                "Waiting for another OfficeCLI operation to finish…",
            );
            mutation_lock().lock().await
        }
    };

    emit_officecli_install_event(
        emitter,
        &task_id,
        OfficecliInstallEventKind::Log,
        "Running the OfficeCLI installer…",
    );

    let cmd = officecli_install_command(current_install_os());
    let child = tokio_command(&cmd.program)
        .args(&cmd.args)
        // Pipe output so we can stream it; null stdin so the installer can't
        // block waiting on input it will never get.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let msg = format!(
                "failed to run the OfficeCLI installer: {e} — install manually from {OFFICECLI_MANUAL_URL}"
            );
            emit_officecli_install_event(
                emitter,
                &task_id,
                OfficecliInstallEventKind::Failed,
                &msg,
            );
            OfficeToolsError::CommandFailed(msg)
        })?;

    // Stream stdout+stderr line-by-line as Log events, bounded by the install
    // timeout. On timeout the whole process tree is killed — not just the direct
    // shell — so the vendor script's download descendant can't keep installing in
    // the background and race a later retry/uninstall once `mutation_lock` is
    // released. See `stream_install_or_kill_tree`.
    let (maybe_status, stdout_tail, stderr_tail) =
        stream_install_or_kill_tree(child, OFFICECLI_INSTALL_TIMEOUT, &task_id, emitter)
            .await
            .map_err(|e| {
                let msg = format!(
                    "failed to run the OfficeCLI installer: {e} — install manually from {OFFICECLI_MANUAL_URL}"
                );
                emit_officecli_install_event(
                    emitter,
                    &task_id,
                    OfficecliInstallEventKind::Failed,
                    &msg,
                );
                OfficeToolsError::CommandFailed(msg)
            })?;

    let status = match maybe_status {
        Some(status) => status,
        None => {
            let msg = format!(
                "OfficeCLI install timed out after {}s — check your network and install manually from {OFFICECLI_MANUAL_URL}",
                OFFICECLI_INSTALL_TIMEOUT.as_secs()
            );
            emit_officecli_install_event(
                emitter,
                &task_id,
                OfficecliInstallEventKind::Failed,
                &msg,
            );
            return Err(OfficeToolsError::CommandFailed(msg));
        }
    };

    if !status.success() {
        // The official scripts report failures on stdout (PowerShell `Write-Host`,
        // bash `echo`) as much as stderr, so prefer stderr but fall back to stdout
        // — otherwise the toast can read just "OfficeCLI install failed:". Bound
        // the tail so a chatty script can't flood the UI.
        let detail = if stderr_tail.trim().is_empty() {
            stdout_tail.trim()
        } else {
            stderr_tail.trim()
        };
        let msg = format!(
            "OfficeCLI install failed: {} — install manually from {OFFICECLI_MANUAL_URL}",
            bounded_tail(detail, 800)
        );
        emit_officecli_install_event(emitter, &task_id, OfficecliInstallEventKind::Failed, &msg);
        return Err(OfficeToolsError::CommandFailed(msg));
    }

    let info = officecli_detect().await;
    if !info.installed {
        let msg = format!(
            "installation completed but the officecli binary was not found — install manually from {OFFICECLI_MANUAL_URL}"
        );
        emit_officecli_install_event(emitter, &task_id, OfficecliInstallEventKind::Failed, &msg);
        return Err(OfficeToolsError::CommandFailed(msg));
    }

    // The installer placed the binary, but it must also actually RUN. A present-
    // but-unrunnable binary (e.g. missing libicu on a slim Linux server) is not a
    // usable install: report it as a failure with the actionable diagnostic
    // rather than a misleading "installed successfully" that the caller would then
    // follow with a doomed auto-sync (every load_skill would fail the same way).
    if let Some(runtime_error) = &info.runtime_error {
        emit_officecli_install_event(
            emitter,
            &task_id,
            OfficecliInstallEventKind::Failed,
            runtime_error.clone(),
        );
        return Err(OfficeToolsError::CommandFailed(runtime_error.clone()));
    }

    let done = match &info.version {
        Some(version) => format!("OfficeCLI {version} installed successfully"),
        None => "OfficeCLI installed successfully".to_string(),
    };
    emit_officecli_install_event(emitter, &task_id, OfficecliInstallEventKind::Completed, done);
    Ok(info)
}

// ─── Official installer (shell out, mirror-first) ──────────────────────
//
// codeg installs OfficeCLI by running the vendor's official installer script —
// `install.sh` on Unix, `install.ps1` on Windows — mirror-first (the
// CN-reachable `d.officecli.ai`) with a GitHub-raw fallback. This mirrors how
// iOfficeAI's own AionUi backend installs OfficeCLI, keeps both platforms
// symmetric, and never reimplements the download/checksum/PATH logic those
// scripts already own (on Windows `install.ps1` also persists the install dir
// onto the User PATH).

/// Last `max` chars of `s` (char-boundary safe), prefixed with `…` when
/// truncated. Bounds installer diagnostics surfaced to the UI toast.
fn bounded_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/// Stream `child`'s stdout+stderr line-by-line as OfficeCLI install Log events,
/// bounded by `timeout`. Returns the exit status (`None` on timeout) plus the
/// collected stdout/stderr tails for failure diagnostics.
///
/// Killing the *tree* (via `kill_tree`) on timeout rather than just the direct
/// child matters: the vendor installer script downloads the multi-MB binary in a
/// descendant process (`curl` under `install.sh`, `Invoke-WebRequest` under
/// `install.ps1`). On timeout, dropping the wait future detaches the direct
/// shell but would leave that descendant running — it could finish installing
/// in the background and race a later retry/uninstall once `mutation_lock` is
/// released. We deliberately do NOT use `Command::kill_on_drop`: it SIGKILLs the
/// shell first, reparenting the descendant away so `kill_tree` could no longer
/// reach it. Capturing the pid before the wait and killing the tree on timeout
/// keeps the descendant reachable. `kill_tree` is best-effort (a pid that has
/// already exited is a no-op); Tokio's orphan reaper reaps the killed children.
async fn stream_install_or_kill_tree(
    mut child: tokio::process::Child,
    timeout: Duration,
    task_id: &str,
    emitter: &EventEmitter,
) -> io::Result<(Option<std::process::ExitStatus>, String, String)> {
    use tokio::io::BufReader;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_handle = tokio::spawn({
        let emitter = emitter.clone();
        let task_id = task_id.to_string();
        async move {
            match stdout {
                Some(out) => {
                    collect_lines_lossy(BufReader::new(out), |line| {
                        emit_officecli_install_event(
                            &emitter,
                            &task_id,
                            OfficecliInstallEventKind::Log,
                            line,
                        );
                    })
                    .await
                }
                None => String::new(),
            }
        }
    });

    let stderr_handle = tokio::spawn({
        let emitter = emitter.clone();
        let task_id = task_id.to_string();
        async move {
            match stderr {
                Some(err) => {
                    collect_lines_lossy(BufReader::new(err), |line| {
                        emit_officecli_install_event(
                            &emitter,
                            &task_id,
                            OfficecliInstallEventKind::Log,
                            line,
                        );
                    })
                    .await
                }
                None => String::new(),
            }
        }
    });

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            // `wait()` itself failed (rare). Best-effort kill the tree in case
            // the process is still alive — same rationale as the timeout path —
            // then abort the readers (which may never EOF) and surface the error.
            if let Some(pid) = pid {
                if let Err(err) = kill_tree::tokio::kill_tree(pid).await {
                    tracing::error!("[office] kill_tree failed for install pid {pid}: {err}");
                }
            }
            stdout_handle.abort();
            stderr_handle.abort();
            return Err(e);
        }
        Err(_) => {
            // Timed out: kill the whole tree (see note above), then return
            // WITHOUT joining the readers. A descendant that survived a
            // best-effort kill keeps its pipe write-end open, so the reader
            // would never hit EOF — awaiting it here would pin `mutation_lock`
            // forever, defeating the timeout. The timeout diagnostic doesn't
            // need the collected tails, so abort the readers and return.
            if let Some(pid) = pid {
                if let Err(err) = kill_tree::tokio::kill_tree(pid).await {
                    tracing::error!("[office] kill_tree failed for install pid {pid}: {err}");
                }
            }
            stdout_handle.abort();
            stderr_handle.abort();
            return Ok((None, String::new(), String::new()));
        }
    };

    // Normal exit: the process is gone, so the pipes are at EOF and these joins
    // return promptly with the collected tails (used for failure diagnostics).
    let stdout_tail = stdout_handle.await.unwrap_or_default();
    let stderr_tail = stderr_handle.await.unwrap_or_default();

    Ok((Some(status), stdout_tail, stderr_tail))
}

/// Where users can install OfficeCLI by hand when the network path fails.
const OFFICECLI_MANUAL_URL: &str = "https://github.com/iOfficeAI/OfficeCLI";
const OFFICECLI_INSTALL_SH_MIRROR_URL: &str = "https://d.officecli.ai/install.sh";
const OFFICECLI_INSTALL_SH_GITHUB_URL: &str =
    "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.sh";
const OFFICECLI_INSTALL_PS1_MIRROR_URL: &str = "https://d.officecli.ai/install.ps1";
const OFFICECLI_INSTALL_PS1_GITHUB_URL: &str =
    "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.ps1";

/// Hard ceiling on the whole installer subprocess — the small script download
/// *and* the multi-MB binary the script then fetches. Generous (slow networks
/// pulling tens of MB are fine) but bounded: a stalled mirror or hung download
/// must never pin the mutation lock and the UI's "installing" state forever. On
/// timeout the whole process tree is killed (see `stream_install_or_kill_tree`).
/// The per-request `curl`/`irm` timeouts below only bound the script fetch; this
/// bounds everything.
const OFFICECLI_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallOs {
    Unix,
    Windows,
}

/// `cfg!(windows)` (not `#[cfg]`) so both variants stay referenced in source —
/// otherwise the unused variant trips dead-code on the platform that omits it.
fn current_install_os() -> InstallOs {
    if cfg!(windows) {
        InstallOs::Windows
    } else {
        InstallOs::Unix
    }
}

struct OfficecliInstallCommand {
    program: String,
    args: Vec<String>,
}

/// Build the installer invocation for `os`. Both branches try the mirror first,
/// then fall back to GitHub raw. Kept platform-parameterized (not `cfg`-gated)
/// so unit tests verify both shapes on any host.
fn officecli_install_command(os: InstallOs) -> OfficecliInstallCommand {
    match os {
        InstallOs::Windows => OfficecliInstallCommand {
            program: "powershell.exe".to_string(),
            args: vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                // Hardening preamble. `iex $s` runs the vendor install.ps1 in THIS
                // same process/scope, so these settings also govern the multi-MB
                // binary download the script does via `Invoke-WebRequest`:
                //   • TLS 1.2 — Windows PowerShell 5.1 on older/locked-down .NET
                //     can default to TLS 1.0, which GitHub (and most CDNs) reject.
                //     Add it ADDITIVELY (`-bor`, so existing protocols are kept)
                //     and ONLY when the current value is not `SystemDefault`
                //     (value 0): a modern host that lets the OS negotiate TLS 1.3
                //     is left exactly as-is — no regression. Compare against `0`,
                //     not the `SystemDefault` enum member (added in .NET 4.7;
                //     referencing it throws on 4.5/4.6 and the catch would then
                //     skip the upgrade on exactly the old hosts that need it).
                //   • `$ProgressPreference` — silence `Invoke-WebRequest`'s progress
                //     rendering, which slows the binary download by orders of
                //     magnitude on PS 5.1 (and is just noise when stdout is piped).
                //   • `[Console]::OutputEncoding` — emit UTF-8 (no BOM) so non-ASCII
                //     installer/error text (OEM codepage on non-English Windows)
                //     decodes in our line reader. Best-effort (the setter can throw
                //     with no console attached); the lossy reader is the real net.
                //   • `-TimeoutSec` bounds each script fetch so a stalled mirror
                //     fails over to GitHub instead of hanging; the binary download
                //     the script then does is bounded by OFFICECLI_INSTALL_TIMEOUT.
                format!(
                    "$ErrorActionPreference='Stop'; try {{ $sp=[Net.ServicePointManager]::SecurityProtocol; if([int]$sp -ne 0){{ [Net.ServicePointManager]::SecurityProtocol=$sp -bor [Net.SecurityProtocolType]::Tls12 }} }} catch {{}}; $ProgressPreference='SilentlyContinue'; try {{ [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false) }} catch {{}}; try {{ $s = irm -TimeoutSec 60 {OFFICECLI_INSTALL_PS1_MIRROR_URL} }} catch {{ $s = irm -TimeoutSec 60 {OFFICECLI_INSTALL_PS1_GITHUB_URL} }}; iex $s"
                ),
            ],
        },
        InstallOs::Unix => OfficecliInstallCommand {
            program: "bash".to_string(),
            args: vec![
                "-lc".to_string(),
                // Download to a temp file rather than `curl | bash`: a
                // connection dropped mid-stream would otherwise concatenate the
                // fallback output after a partial script. The `--connect-timeout`
                // / `--max-time` flags bound each script fetch so a stalled
                // mirror fails over to GitHub instead of hanging; the binary
                // download the script then does is bounded by
                // OFFICECLI_INSTALL_TIMEOUT.
                format!(
                    "f=$(mktemp) || exit 1; (curl -fsSL --connect-timeout 20 --max-time 60 {OFFICECLI_INSTALL_SH_MIRROR_URL} -o \"$f\" || curl -fsSL --connect-timeout 20 --max-time 60 {OFFICECLI_INSTALL_SH_GITHUB_URL} -o \"$f\") && bash \"$f\"; s=$?; rm -f \"$f\"; exit $s"
                ),
            ],
        },
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_uninstall() -> Result<OfficecliInfo, OfficeToolsError> {
    let _guard = mutation_lock().lock().await;

    // Operate on the official installer's primary install location directly,
    // not the PATH-resolved binary. This avoids removing a Homebrew/system
    // binary that happens to shadow it, and ensures we delete the right file.
    let managed_path = officecli_primary_install_path()
        .ok_or_else(|| OfficeToolsError::Io("could not determine install directory".to_string()))?;

    // Remove the binary if it exists.  If it's already gone (e.g. retrying
    // after a partial failure), skip straight to cleanup.
    if managed_path.exists() {
        fs::remove_file(&managed_path).map_err(|e| {
            OfficeToolsError::Io(format!("failed to remove {}: {e}", managed_path.display()))
        })?;
    }

    let mut cleanup_errors: Vec<String> = Vec::new();

    // Remove per-agent symlinks across all scoped skill dirs (not just the
    // preferred dir) so secondary dirs like ~/.agents/skills are also cleaned.
    for agent in supported_agents() {
        let dirs = match scoped_skill_dirs(agent, AgentSkillScope::Global, None) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for def in skill_defs() {
            let central = skill_central_path(def.id);
            for dir in &dirs {
                let candidate = dir.join(def.id);
                if !candidate.exists() && !path_is_symlink(&candidate) {
                    continue;
                }
                let state = classify_link(&candidate, &central);
                let should_remove = match state {
                    ExpertLinkState::LinkedToCodeg => true,
                    ExpertLinkState::Broken => {
                        // Only remove broken links whose target was our
                        // central skill dir (not user-owned danglers).
                        read_link_target(&candidate)
                            .map(|t| t.starts_with(&central))
                            .unwrap_or(false)
                    }
                    _ => false,
                };
                if should_remove {
                    if let Err(e) = remove_skill_entry(&candidate) {
                        cleanup_errors.push(format!(
                            "failed to remove link {}: {e}",
                            candidate.display()
                        ));
                    }
                }
            }
        }
    }

    // Clean up OfficeCLI skills from central store
    for def in skill_defs() {
        let central = skill_central_path(def.id);
        if central.exists() {
            if let Err(e) = fs::remove_dir_all(&central) {
                cleanup_errors.push(format!("failed to remove {}: {e}", central.display()));
            }
        }
    }

    if !cleanup_errors.is_empty() {
        return Err(OfficeToolsError::Io(format!(
            "binary removed but cleanup had errors: {}",
            cleanup_errors.join("; ")
        )));
    }

    // Re-detect so the caller sees the real post-uninstall state (e.g. a
    // system/Homebrew binary may still be on PATH).
    Ok(officecli_detect().await)
}

// ─── Commands: skill listing ───────────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_list_skills() -> Vec<OfficecliSkill> {
    skill_defs().iter().map(skill_def_to_metadata).collect()
}

// ─── Commands: skill sync ──────────────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_sync_skills() -> Result<SkillSyncReport, OfficeToolsError> {
    let _guard = mutation_lock().lock().await;
    let binary = resolve_officecli().ok_or(OfficeToolsError::NotInstalled)?;

    let central_dir = central_experts_dir();
    fs::create_dir_all(&central_dir)?;

    let mut report = SkillSyncReport {
        synced: 0,
        errors: vec![],
    };

    for def in skill_defs() {
        let target_dir = skill_central_path(def.id);
        let skill_md = target_dir.join("SKILL.md");

        // Load skill content from OfficeCLI binary. The CLI keys skills by
        // its own short id (`load_id`), which differs from our invocation
        // name (`def.id`) for the officecli-* skills.
        let output = tokio_command(&binary)
            .arg("load_skill")
            .arg(def.load_id)
            .output()
            .await;

        match output {
            Ok(out) if out.status.success() => {
                let content = String::from_utf8_lossy(&out.stdout);
                if content.trim().is_empty() {
                    report
                        .errors
                        .push(format!("{}: empty skill content", def.id));
                    continue;
                }
                fs::create_dir_all(&target_dir)?;
                fs::write(&skill_md, content.as_ref())?;
                report.synced += 1;
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stderr = stderr.trim();
                tracing::warn!(
                    "[office] load_skill {} exited unsuccessfully ({}): {stderr}",
                    def.load_id,
                    out.status
                );
                // Map a known runtime-dependency failure (missing libicu, …) to a
                // single actionable line; otherwise surface the raw stderr. The
                // full detail is in the log line above regardless.
                let msg = match officecli_runtime_dependency_hint(stderr) {
                    Some(hint) => format!("{}: {hint}", def.id),
                    None => format!("{}: load_skill failed: {stderr}", def.id),
                };
                report.errors.push(msg);
            }
            Err(e) => {
                tracing::warn!("[office] load_skill {} could not be spawned: {e}", def.load_id);
                report
                    .errors
                    .push(format!("{}: command error: {e}", def.id));
            }
        }
    }

    Ok(report)
}

// ─── Commands: skill link / unlink ─────────────────────────────────────

fn supported_agents() -> Vec<AgentType> {
    const ALL: &[AgentType] = &[
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
    // Custom agents that declared the shared skills store join the built-in
    // set — the same `skill_storage_spec` gate every skills surface uses, so
    // this stays in lockstep with the columns the frontend renders.
    ALL.iter()
        .copied()
        .chain(crate::acp::custom_registry::all())
        .filter(|a| skill_storage_spec(*a).is_some())
        .collect()
}

/// Link one office skill into one agent's skill dir. **Assumes the mutation
/// lock is already held** — `tokio::sync::Mutex` is not reentrant, so
/// `officecli_skill_apply_links` locks once and calls this directly rather than
/// the public command. The "not synced" guard stays here so a batch enable of
/// an un-synced skill fails only that op.
fn link_one_locked(
    skill_id: &str,
    agent_type: AgentType,
) -> Result<ExpertInstallStatus, OfficeToolsError> {
    let skill_id = validate_skill_id(skill_id).map_err(|e| OfficeToolsError::Io(e.to_string()))?;
    let _ = find_skill_def(&skill_id)
        .ok_or_else(|| OfficeToolsError::SkillNotFound(skill_id.clone()))?;

    let central = skill_central_path(&skill_id);
    if !central.exists() {
        return Err(OfficeToolsError::Io(format!(
            "skill '{skill_id}' is not synced — run sync first"
        )));
    }

    let link_path = agent_link_path(agent_type, &skill_id)?;
    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut copy_mode = false;
    match create_link_raw(&central, &link_path) {
        Ok(is_copy) => {
            copy_mode = is_copy;
        }
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            match classify_link(&link_path, &central) {
                ExpertLinkState::LinkedToCodeg => {}
                ExpertLinkState::BlockedByRealDirectory => {
                    return Err(OfficeToolsError::NameCollision {
                        path: link_path.to_string_lossy().to_string(),
                    });
                }
                ExpertLinkState::LinkedElsewhere | ExpertLinkState::Broken => {
                    let found = read_link_target(&link_path)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "<unknown>".into());
                    return Err(OfficeToolsError::ForeignLink {
                        path: link_path.to_string_lossy().to_string(),
                        found,
                    });
                }
                ExpertLinkState::NotLinked => {
                    create_link_raw(&central, &link_path)
                        .map_err(|e| OfficeToolsError::Io(format!("retry link failed: {e}")))?;
                }
            }
        }
        Err(err) => return Err(OfficeToolsError::Io(err.to_string())),
    }

    let state = classify_link(&link_path, &central);
    let target_path = read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
    Ok(ExpertInstallStatus {
        expert_id: skill_id.clone(),
        agent_type,
        state,
        link_path: link_path.to_string_lossy().to_string(),
        target_path,
        expected_target_path: central.to_string_lossy().to_string(),
        copy_mode,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_skill_link_to_agent(
    skill_id: String,
    agent_type: AgentType,
) -> Result<ExpertInstallStatus, OfficeToolsError> {
    let _guard = mutation_lock().lock().await;
    link_one_locked(&skill_id, agent_type)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_skill_unlink_from_agent(
    skill_id: String,
    agent_type: AgentType,
) -> Result<(), OfficeToolsError> {
    let _guard = mutation_lock().lock().await;
    unlink_one_locked(&skill_id, agent_type)
}

/// Remove one office skill's link from one agent's skill dirs. **Assumes the
/// mutation lock is already held** (see `link_one_locked`).
fn unlink_one_locked(skill_id: &str, agent_type: AgentType) -> Result<(), OfficeToolsError> {
    let skill_id = validate_skill_id(skill_id).map_err(|e| OfficeToolsError::Io(e.to_string()))?;
    let _ = find_skill_def(&skill_id)
        .ok_or_else(|| OfficeToolsError::SkillNotFound(skill_id.clone()))?;

    let dirs = scoped_skill_dirs(agent_type, AgentSkillScope::Global, None)
        .map_err(|_| OfficeToolsError::UnsupportedAgent(agent_type))?;

    let central = skill_central_path(&skill_id);
    for dir in dirs {
        let candidate = dir.join(&skill_id);
        if !candidate.exists() && !path_is_symlink(&candidate) {
            continue;
        }
        let state = classify_link(&candidate, &central);
        let should_remove = match state {
            ExpertLinkState::LinkedToCodeg => true,
            ExpertLinkState::Broken => read_link_target(&candidate)
                .map(|t| t.starts_with(&central))
                .unwrap_or(false),
            _ => false,
        };
        if should_remove {
            remove_skill_entry(&candidate).map_err(|e| {
                OfficeToolsError::Io(format!("remove link {}: {e}", candidate.display()))
            })?;
        } else if state == ExpertLinkState::LinkedElsewhere {
            return Err(OfficeToolsError::ForeignLink {
                path: candidate.to_string_lossy().to_string(),
                found: read_link_target(&candidate)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "<unknown>".into()),
            });
        }
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_skill_get_install_status(
    skill_id: String,
) -> Result<Vec<ExpertInstallStatus>, OfficeToolsError> {
    let skill_id = validate_skill_id(&skill_id).map_err(|e| OfficeToolsError::Io(e.to_string()))?;
    let _ = find_skill_def(&skill_id)
        .ok_or_else(|| OfficeToolsError::SkillNotFound(skill_id.clone()))?;

    let expected = skill_central_path(&skill_id);
    let agents = supported_agents();

    let mut out = Vec::with_capacity(agents.len());
    for agent in agents {
        let link_path = match agent_link_path(agent, &skill_id) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let state = classify_link(&link_path, &expected);
        let target_path = read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
        out.push(ExpertInstallStatus {
            expert_id: skill_id.clone(),
            agent_type: agent,
            state,
            link_path: link_path.to_string_lossy().to_string(),
            target_path,
            expected_target_path: expected.to_string_lossy().to_string(),
            copy_mode: false,
        });
    }
    Ok(out)
}

/// Apply a batch of enable/disable operations under a single lock acquisition.
/// Mirrors `experts_apply_links`; an un-synced skill simply fails its own op.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_skill_apply_links(
    ops: Vec<LinkOp>,
) -> Result<Vec<LinkOpResult>, OfficeToolsError> {
    let _guard = mutation_lock().lock().await;
    let mut out = Vec::with_capacity(ops.len());
    for op in ops {
        // `LinkOp.expert_id` carries the office skill id here — the field name is
        // shared with the experts batch type, and office's ExpertInstallStatus
        // already overloads `expert_id` as the skill id.
        let LinkOp {
            expert_id,
            agent_type,
            enable,
        } = op;
        let res = if enable {
            link_one_locked(&expert_id, agent_type).map(Some)
        } else {
            unlink_one_locked(&expert_id, agent_type).map(|()| None)
        };
        out.push(match res {
            Ok(status) => LinkOpResult {
                expert_id,
                agent_type,
                ok: true,
                status,
                error: None,
            },
            Err(err) => LinkOpResult {
                expert_id,
                agent_type,
                ok: false,
                status: None,
                error: Some(err.to_string()),
            },
        });
    }
    Ok(out)
}

/// One-shot snapshot of every (skill, agent) link state for the matrix UI.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_skill_list_all_install_statuses(
) -> Result<Vec<ExpertInstallStatus>, OfficeToolsError> {
    let agents = supported_agents();
    let mut out = Vec::with_capacity(skill_defs().len() * agents.len());
    for def in skill_defs() {
        let expected = skill_central_path(def.id);
        for &agent in &agents {
            let link_path = match agent_link_path(agent, def.id) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let state = classify_link(&link_path, &expected);
            let target_path =
                read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
            out.push(ExpertInstallStatus {
                expert_id: def.id.to_string(),
                agent_type: agent,
                state,
                link_path: link_path.to_string_lossy().to_string(),
                target_path,
                expected_target_path: expected.to_string_lossy().to_string(),
                copy_mode: false,
            });
        }
    }
    Ok(out)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_skill_read_content(skill_id: String) -> Result<String, OfficeToolsError> {
    let skill_id = validate_skill_id(&skill_id).map_err(|e| OfficeToolsError::Io(e.to_string()))?;
    let _ = find_skill_def(&skill_id)
        .ok_or_else(|| OfficeToolsError::SkillNotFound(skill_id.clone()))?;

    let path = skill_central_path(&skill_id).join("SKILL.md");
    if !path.exists() {
        return Err(OfficeToolsError::Io(format!(
            "skill '{skill_id}' has no SKILL.md — run sync first"
        )));
    }
    let content = fs::read_to_string(&path)?;
    Ok(content)
}

// ─── Commands: office file preview ─────────────────────────────────────

pub(crate) fn is_office_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("docx") | Some("xlsx") | Some("pptx")
    )
}

/// Render an office file (.docx/.xlsx/.pptx) to self-contained HTML via
/// `officecli view <file> html`, for the in-app preview. Runs officecli in
/// codeg's own process (not the agent's command sandbox), so it is unaffected
/// by the sandbox restrictions that can break officecli inside an agent turn.
///
/// `path` is relative to `root_path`; the resolved target is canonicalized and
/// confined to the workspace root, mirroring `read_workspace_file_base64`.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn officecli_render_html(
    root_path: String,
    path: String,
) -> Result<String, OfficeToolsError> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(OfficeToolsError::Io(
            "workspace root does not exist".to_string(),
        ));
    }

    let target =
        resolve_tree_path(&root, &path).map_err(|e| OfficeToolsError::Io(e.to_string()))?;

    // Canonicalize + confine within the workspace root (defense in depth: the
    // path comes from an open file tab, but never render outside the root).
    let canonical_root = fs::canonicalize(&root)?;
    let canonical_target = fs::canonicalize(&target)?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(OfficeToolsError::Io(
            "path is outside workspace root".to_string(),
        ));
    }
    if !canonical_target.is_file() {
        return Err(OfficeToolsError::Io("path is not a file".to_string()));
    }
    if !is_office_path(&canonical_target) {
        return Err(OfficeToolsError::Io(
            "not a supported office file (.docx/.xlsx/.pptx)".to_string(),
        ));
    }

    let binary = resolve_officecli().ok_or(OfficeToolsError::NotInstalled)?;
    let output = tokio_command(&binary)
        .arg("view")
        .arg(&canonical_target)
        .arg("html")
        .output()
        .await
        .map_err(|e| OfficeToolsError::CommandFailed(format!("officecli view failed: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(OfficeToolsError::CommandFailed(format!(
            "officecli view failed: {}",
            stderr.trim()
        )));
    }

    let html = String::from_utf8_lossy(&output.stdout).to_string();
    if html.trim().is_empty() {
        return Err(OfficeToolsError::CommandFailed(
            "officecli produced empty output".to_string(),
        ));
    }
    Ok(html)
}

// ─── Commands: office live preview (watch) ─────────────────────────────

/// Start (or share, by ref-count) a long-lived `officecli watch` HTTP preview
/// server for an office file and return its loopback port. The live preview is
/// driven by officecli's own SSE refresh, so it no longer races the agent's
/// edits for the file on disk (the bug the one-shot `view html` path caused on
/// Windows). See `crate::office_watch`.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn start_office_watch(
    root_path: String,
    path: String,
) -> Result<crate::office_watch::OfficeWatchStarted, AppCommandError> {
    crate::office_watch::start_office_watch_core(root_path, path)
        .await
        .map_err(Into::into)
}

/// Release one reference to the watch preview for an office file; kills the
/// server when the last viewer goes away.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn stop_office_watch(root_path: String, path: String) -> Result<(), AppCommandError> {
    crate::office_watch::stop_office_watch_core(root_path, path)
        .await
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_declared_custom_agent_gains_a_column_here_too() {
        use crate::acp::custom_registry::{
            hydrate, hydrate_test_guard, CustomAgentDef, CustomAgentSpec, CustomDistributionKind,
            NpxSpec,
        };
        let _guard = hydrate_test_guard();
        let mut def = CustomAgentDef {
            registry_id: "office-pack-agent".into(),
            name: "Pack Agent".into(),
            description: String::new(),
            version: "1.0.0".into(),
            distribution_kind: CustomDistributionKind::Npx,
            spec: CustomAgentSpec {
                npx: Some(NpxSpec {
                    package: "pack-agent@1.0.0".into(),
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
        let agent = crate::models::agent::AgentType::custom("office-pack-agent").unwrap();

        assert!(hydrate(std::slice::from_ref(&def)).is_empty());
        assert!(
            !supported_agents().contains(&agent),
            "undeclared custom agents stay out"
        );

        def.skills_shared_store = true;
        assert!(hydrate(std::slice::from_ref(&def)).is_empty());
        assert!(
            supported_agents().contains(&agent),
            "declared custom agents get a column"
        );

        assert!(hydrate(&[]).is_empty());
        assert!(!supported_agents().contains(&agent));
    }

    use tokio::time::{timeout, Duration};

    // Tests use unknown skill ids so they never touch the developer's real skill
    // directories: office link/unlink both fail at `find_skill_def` for an
    // unknown id, before any filesystem access.

    #[tokio::test]
    async fn apply_links_does_not_deadlock() {
        // Regression guard: `officecli_skill_apply_links` must hold the
        // (non-reentrant) lock once and call the lock-free inner helpers, not the
        // public single commands — otherwise the second op would hang.
        let ops = vec![
            LinkOp {
                expert_id: "zzz-unknown-office-skill-a".into(),
                agent_type: AgentType::ClaudeCode,
                enable: false,
            },
            LinkOp {
                expert_id: "zzz-unknown-office-skill-b".into(),
                agent_type: AgentType::Codex,
                enable: false,
            },
        ];
        let results = timeout(Duration::from_secs(5), officecli_skill_apply_links(ops))
            .await
            .expect("officecli_skill_apply_links must not deadlock")
            .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        // Unknown skills fail their own op without aborting the batch.
        assert!(results.iter().all(|r| !r.ok && r.error.is_some()), "{results:?}");
    }

    #[tokio::test]
    async fn apply_links_collects_per_op_results_without_aborting() {
        let ops = vec![
            LinkOp {
                expert_id: "zzz-unknown-office-skill".into(),
                agent_type: AgentType::ClaudeCode,
                enable: true,
            },
            LinkOp {
                expert_id: "zzz-unknown-office-skill".into(),
                agent_type: AgentType::Codex,
                enable: false,
            },
        ];
        let results = officecli_skill_apply_links(ops)
            .await
            .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| !r.ok));
        assert!(results.iter().all(|r| r.error.is_some()));
        assert!(results.iter().all(|r| r.status.is_none()));
    }

    #[tokio::test]
    // The hydrate guard is held across the await on purpose — see the
    // identical note in `custom_agent_service`.
    #[allow(clippy::await_holding_lock)]
    async fn list_all_install_statuses_covers_every_skill_agent_pair() {
        // A test hydrating a custom agent that declares a store would add a
        // column between the snapshot and the count below.
        let _guard = crate::acp::custom_registry::hydrate_test_guard();
        let rows = officecli_skill_list_all_install_statuses()
            .await
            .expect("snapshot returns Ok");
        let expected = skill_defs().len() * supported_agents().len();
        assert_eq!(rows.len(), expected);
    }

    #[test]
    fn primary_install_path_is_platform_specific() {
        let p = officecli_primary_install_path().expect("install path resolvable");
        let name = p
            .file_name()
            .expect("has file name")
            .to_string_lossy()
            .to_string();
        #[cfg(windows)]
        {
            assert_eq!(name, "officecli.exe");
            assert!(
                p.components().any(|c| c.as_os_str() == "OfficeCLI"),
                "{p:?}"
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(name, "officecli");
            assert!(p.ends_with(".local/bin/officecli"), "{p:?}");
        }
    }

    #[test]
    fn runtime_dependency_hint_detects_missing_icu() {
        // The exact .NET startup failure users hit on a slim Linux server image
        // (node:*-bookworm-slim ships no system libicu).
        for stderr in [
            "Process terminated. Couldn't find a valid ICU package installed on the system. \
             Please install libicu (or icu-libs) using your package manager and try again.",
            "System.Globalization could not load ICU",
            "error: libicu not found",
        ] {
            let hint = officecli_runtime_dependency_hint(stderr)
                .unwrap_or_else(|| panic!("ICU failure should be recognized: {stderr}"));
            assert!(hint.contains("libicu72"), "hint must name the fix: {hint}");
        }
    }

    #[test]
    fn runtime_dependency_hint_detects_missing_shared_library() {
        let stderr =
            "officecli: error while loading shared libraries: libfoo.so.1: cannot open shared \
             object file: No such file or directory";
        assert!(officecli_runtime_dependency_hint(stderr).is_some());
    }

    #[test]
    fn runtime_dependency_hint_ignores_ordinary_errors() {
        // A normal officecli error (e.g. unknown skill) must NOT be mislabeled as
        // a missing-system-library problem.
        assert!(officecli_runtime_dependency_hint("unknown skill id: pptx").is_none());
        assert!(officecli_runtime_dependency_hint("").is_none());
    }

    #[test]
    fn run_failure_message_pairs_hint_with_raw_stderr() {
        let stderr = "Couldn't find a valid ICU package installed on the system.";
        let msg = officecli_run_failure_message(stderr);
        assert!(msg.contains("libicu72"), "actionable: {msg}");
        assert!(msg.contains("officecli error:"), "keeps raw detail: {msg}");
    }

    #[test]
    fn run_failure_message_handles_empty_stderr() {
        let msg = officecli_run_failure_message("   ");
        assert!(!msg.is_empty());
        // No dangling "officecli error:" with nothing after it.
        assert!(!msg.contains("officecli error:"), "no empty raw tail: {msg}");
    }

    #[test]
    fn install_command_uses_official_scripts() {
        let unix = officecli_install_command(InstallOs::Unix);
        assert_eq!(unix.program, "bash");
        let unix_script = unix.args.join(" ");
        assert!(unix_script.contains("install.sh"), "{unix_script}");

        let windows = officecli_install_command(InstallOs::Windows);
        assert_eq!(windows.program, "powershell.exe");
        let win_script = windows.args.join(" ");
        assert!(win_script.contains("install.ps1"), "{win_script}");
        // PowerShell fetch-and-run idiom: Invoke-RestMethod | Invoke-Expression.
        assert!(
            win_script.contains("irm") && win_script.contains("iex"),
            "{win_script}"
        );
    }

    #[test]
    fn install_command_tries_mirror_before_github() {
        // The CN-reachable mirror must be attempted before raw.githubusercontent
        // (often unreachable from mainland-China deployments) on both platforms.
        for os in [InstallOs::Unix, InstallOs::Windows] {
            let script = officecli_install_command(os).args.join(" ");
            let mirror = script.find("d.officecli.ai").expect("mirror URL present");
            let github = script
                .find("raw.githubusercontent.com")
                .expect("github URL present");
            assert!(mirror < github, "mirror must precede github for {os:?}: {script}");
        }
    }

    #[test]
    fn install_command_bounds_script_download_time() {
        // Fetching the installer *script* must fail over quickly rather than
        // hang on a stalled mirror. (The binary download the script then does is
        // bounded separately by OFFICECLI_INSTALL_TIMEOUT.)
        let unix = officecli_install_command(InstallOs::Unix).args.join(" ");
        assert!(unix.contains("--connect-timeout"), "{unix}");
        assert!(unix.contains("--max-time"), "{unix}");

        let win = officecli_install_command(InstallOs::Windows).args.join(" ");
        assert!(win.contains("-TimeoutSec"), "{win}");
    }

    #[test]
    fn windows_install_command_hardening_preamble_ordered() {
        let win = officecli_install_command(InstallOs::Windows).args.join(" ");

        // The hardening preamble must run before the first network fetch, and
        // `$ProgressPreference` must also reach the vendor script run via `iex`.
        let tls = win
            .find("SecurityProtocol")
            .expect("sets SecurityProtocol");
        let progress = win
            .find("$ProgressPreference")
            .expect("sets $ProgressPreference");
        let encoding = win.find("OutputEncoding").expect("sets OutputEncoding");
        let irm = win.find("irm").expect("fetches the script via irm");
        let iex = win.find("iex").expect("runs the script via iex");

        assert!(tls < irm, "TLS must be set before the first irm: {win}");
        assert!(
            progress < irm,
            "$ProgressPreference must be set before the first irm: {win}"
        );
        assert!(
            encoding < irm,
            "OutputEncoding must be set before the first irm: {win}"
        );
        assert!(
            progress < iex,
            "$ProgressPreference must be set before iex: {win}"
        );

        // The TLS upgrade is additive (`-bor … Tls12`) and guarded on a
        // non-SystemDefault (nonzero) value so a modern host that negotiates
        // TLS 1.3 via the OS is left untouched — no regression.
        assert!(win.contains("-bor"), "TLS upgrade must be additive: {win}");
        assert!(win.contains("Tls12"), "must add TLS 1.2: {win}");
        assert!(
            win.contains("[int]$sp -ne 0"),
            "TLS upgrade must be guarded on non-SystemDefault: {win}"
        );
    }

    /// On timeout the *whole tree* must die, not just the direct shell — the
    /// vendor script downloads the binary in a descendant. Models that with
    /// `sh` spawning a long-lived `sleep` grandchild and asserts the grandchild
    /// is killed. Unix-only (relies on `sh`/`kill(2)`).
    #[cfg(unix)]
    #[tokio::test]
    async fn install_timeout_kills_whole_process_tree() {
        use std::time::Duration;

        let dir = tempfile::tempdir().expect("tempdir");
        let pidfile = dir.path().join("grandchild.pid");
        // `sh` (direct child) backgrounds `sleep` (grandchild), records its pid,
        // and `wait`s — so the tree outlives our short timeout.
        let child = tokio_command("sh")
            .arg("-c")
            .arg(format!("sleep 30 & echo $! > '{}'; wait", pidfile.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");

        let (status, _stdout, _stderr) =
            stream_install_or_kill_tree(child, Duration::from_millis(300), "test", &EventEmitter::Noop)
                .await
                .expect("no io error");
        assert!(status.is_none(), "expected a timeout (no exit status)");

        // Grandchild pid is written almost immediately; poll briefly for it.
        let mut gpid = None;
        for _ in 0..100 {
            if let Ok(s) = std::fs::read_to_string(&pidfile) {
                if let Ok(p) = s.trim().parse::<i32>() {
                    gpid = Some(p);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let gpid = gpid.expect("grandchild recorded its pid");

        // Poll until the grandchild is gone: `kill(pid, 0)` returns -1/ESRCH
        // once it no longer exists (reparented + reaped after the tree kill).
        let mut alive = true;
        for _ in 0..150 {
            // SAFETY: signal 0 only probes for existence; it sends no signal.
            if unsafe { libc::kill(gpid, 0) } != 0 {
                alive = false;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            !alive,
            "grandchild {gpid} survived — the process tree was not killed"
        );
    }

    #[test]
    fn bounded_tail_is_char_safe_and_bounded() {
        assert_eq!(bounded_tail("short", 800), "short");

        let long = "x".repeat(1000);
        let tail = bounded_tail(&long, 800);
        assert!(tail.starts_with('…'));
        assert_eq!(tail.chars().filter(|c| *c == 'x').count(), 800);

        // Multibyte input must not panic and must stay on a char boundary.
        let multibyte = "あ".repeat(500); // 1500 bytes
        let tail = bounded_tail(&multibyte, 800);
        assert!(tail.starts_with('…'));
        assert!(tail.chars().skip(1).all(|c| c == 'あ'));
    }

}
