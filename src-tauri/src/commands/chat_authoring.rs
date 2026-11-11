//! `create_automation` / `create_work_task` backing logic + settings
//! persistence.
//!
//! Two surfaces live here, mirroring `crate::commands::session_info`:
//!
//!   * [`DbChatAuthoring`] — the production [`ChatAuthoringAccess`] impl the
//!     delegation listener calls when a chat agent asks codeg to save an
//!     automation or queue a board task. It resolves the target project, builds
//!     the same drafts the editors build, and writes through
//!     `automation_create_core` / `work_task_create_core` so the lists get their
//!     broadcasts and the work-task pump its nudge.
//!   * The `chat_authoring.*` settings knobs (**default false, both**) — read at
//!     MCP injection time via [`ChatAuthoringRuntimeConfig`] to build
//!     `--features`, and AGAIN at write time by [`DbChatAuthoring`] so turning
//!     the switch off takes effect on sessions that are already running.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::chat_authoring::{
    local_timezone, AuthoringContext, AuthoringOutcome, ChatAuthoringAccess, ChatAuthoringConfig,
    ChatAuthoringRuntimeConfig, NewAutomationSpec, NewWorkTaskSpec, MAX_ATTACHMENT_IMAGE_BYTES,
    MAX_ATTACHMENT_IMAGE_TOTAL_BYTES,
};
use crate::acp::types::{attachment_marker, PromptInputBlock};
use crate::app_error::AppCommandError;
use crate::db::entities::automation::{IsolationMode, TriggerKind};
use crate::db::entities::folder::FolderKind;
use crate::db::service::{app_metadata_service, conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::models::{
    AutomationConfig, AutomationDraft, FolderDetail, WorkTaskConfig, WorkTaskDraft,
};
use crate::web::event_bridge::{emit_event, EventEmitter, CHAT_AUTHORING_SETTINGS_CHANGED_EVENT};

const KIND_AUTOMATION: &str = "automation";
const KIND_WORK_TASK: &str = "work_task";

/// Production [`ChatAuthoringAccess`]. Holds the DB plus the event emitter (so
/// creates broadcast exactly like a UI-driven create) and the runtime config it
/// re-checks before every write.
pub struct DbChatAuthoring {
    pub db: Arc<AppDatabase>,
    pub emitter: EventEmitter,
    pub config: ChatAuthoringRuntimeConfig,
}

impl DbChatAuthoring {
    pub fn new(
        db: Arc<AppDatabase>,
        emitter: EventEmitter,
        config: ChatAuthoringRuntimeConfig,
    ) -> Self {
        Self {
            db,
            emitter,
            config,
        }
    }

    /// Resolve the project the new automation / task belongs to.
    ///
    /// Order: an explicit `folder_path` wins; otherwise the caller's own
    /// conversation; otherwise the working directory the companion was launched
    /// with. Whatever matches is then normalized to its project root — a
    /// worktree folder resolves to the project it was cut from, mirroring the
    /// "turn this message into a task" action in the UI.
    async fn resolve_folder(
        &self,
        ctx: &AuthoringContext,
        folder_path: Option<&str>,
    ) -> Result<FolderDetail, String> {
        let conn = &self.db.conn;
        let folders = folder_service::list_all_folder_details(conn)
            .await
            .map_err(|e| format!("could not read the folder list: {e}"))?;

        let found = if let Some(raw) = folder_path {
            match match_folder_by_path(&folders, raw) {
                Some(f) => f,
                None => {
                    // "known to codeg" — the lookup spans every non-deleted
                    // folder row, which includes projects the user has opened
                    // before but currently has closed.
                    return Err(format!(
                        "no project matching '{raw}' is known to codeg. Open the project first, \
                         or omit folder_path to use the one this conversation is in."
                    ));
                }
            }
        } else {
            let from_conversation = match ctx.conversation_id {
                Some(id) => conversation_service::get_by_id(conn, id)
                    .await
                    .ok()
                    .and_then(|c| folders.iter().find(|f| f.id == c.folder_id).cloned()),
                None => None,
            };
            match from_conversation
                .or_else(|| match_folder_by_path(&folders, &ctx.working_dir.to_string_lossy()))
            {
                Some(f) => f,
                None => {
                    return Err(
                        "could not tell which project this conversation belongs to. \
                                Pass folder_path with the absolute path of the target project."
                            .to_string(),
                    );
                }
            }
        };

        // Worktree folders are flattened (a worktree of a worktree still points
        // at the original root), so one hop is always enough.
        let root = match found.parent_id {
            Some(parent_id) => folders
                .iter()
                .find(|f| f.id == parent_id)
                .cloned()
                .unwrap_or(found),
            None => found,
        };
        if root.kind != FolderKind::Regular || root.parent_id.is_some() {
            return Err(format!(
                "'{}' is not a project folder that can hold automations or tasks. \
                 Pass folder_path with the absolute path of the target project.",
                root.path
            ));
        }
        Ok(root)
    }
}

/// Match `raw` against the registered folders: an exact path first, then the
/// longest folder the path lives inside. Component-wise (`Path::starts_with`),
/// so `/repo/app-2` never matches `/repo/app`.
fn match_folder_by_path(folders: &[FolderDetail], raw: &str) -> Option<FolderDetail> {
    let candidate = Path::new(raw.trim());
    if candidate.as_os_str().is_empty() {
        return None;
    }
    folders
        .iter()
        .filter(|f| candidate.starts_with(Path::new(&f.path)))
        // Deepest match wins: a conversation inside a worktree should resolve to
        // that worktree (and then walk up to its project), not straight to some
        // ancestor project that also contains it.
        .max_by_key(|f| Path::new(&f.path).components().count())
        .cloned()
}

/// Validate an agent wire slug (`claude_code`, `custom:<id>`, …). `None` input
/// stays `None` — the caller decides what to fall back to.
fn parse_agent_slug(raw: Option<&str>) -> Result<Option<AgentType>, String> {
    match raw {
        None => Ok(None),
        Some(s) => AgentType::from_wire(s)
            .map(Some)
            .ok_or_else(|| format!("unknown agent_type '{s}'")),
    }
}

/// Wrap a plain prompt string as the single text block both editors produce for
/// a text-only prompt.
fn text_prompt_blocks(prompt: &str) -> Result<Vec<serde_json::Value>, String> {
    let block = PromptInputBlock::Text {
        text: prompt.to_string(),
    };
    Ok(vec![serde_json::to_value(&block).map_err(|e| {
        format!("could not encode the prompt: {e}")
    })?])
}

/// The image formats every image-capable agent takes, told apart by their
/// leading bytes rather than the file name: a `.png` that is really a JPEG
/// would otherwise go out labelled `image/png`, which model APIs reject. `None`
/// for anything else (SVG included — it is markup, and travels as a file).
fn sniff_image_mime(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Read up to the first 12 bytes of `path` — enough for [`sniff_image_mime`].
async fn read_head(path: &Path) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await?;
    let mut head = Vec::with_capacity(12);
    file.take(12).read_to_end(&mut head).await?;
    Ok(head)
}

/// An attachment path as given, made absolute against the caller's working
/// directory when it is relative — the directory the agent itself resolves
/// relative paths in.
fn resolve_attachment_path(raw: &str, working_dir: &Path) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        working_dir.join(path)
    }
}

/// The `file://` uri of a resolved attachment path.
fn file_uri(raw: &str, path: &Path) -> Result<String, String> {
    url::Url::from_file_path(path)
        .map(String::from)
        .map_err(|_| format!("attachment '{raw}' is not a usable file path."))
}

/// An attachment as the inline `[name](file://…)` reference a composer file
/// badge serializes to.
fn file_reference(raw: &str, path: &Path) -> Result<String, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw.to_string());
    Ok(attachment_marker(&name, &file_uri(raw, path)?))
}

/// Build a chat-authored task's prompt the way the task editor's composer
/// builds one: the prose as a single text block, every non-image file as an
/// inline `[name](file://…)` reference appended to that prose (one per line),
/// and every image as an `image` block carrying its bytes inline — the shape a
/// desktop drop stores, which the engine re-encodes at launch for agents that
/// take images only as embedded resources. Returns the blocks plus the display
/// text (the text block's content, which is what the editor's `getText` yields
/// for the same draft).
///
/// Images are stored by value so the task still has them when it runs, however
/// long it waits on the board; other files stay references, like a file badge
/// in the composer, and are read by the executing agent itself.
///
/// All-or-nothing: an attachment that is missing, not a regular file, or over a
/// size cap fails the whole create with a note naming it, so the LLM can fix
/// the call rather than queue a task that silently lacks what it was told to
/// carry.
///
/// With `host_reads_files` off (the caller hosts its own file access, see
/// [`AuthoringContext::host_reads_files`]) nothing is opened, read or even
/// stat'ed: every attachment, image or not, becomes a path reference that the
/// executing agent reads — or is refused — inside its own sandbox.
async fn work_task_prompt_blocks(
    prompt: &str,
    attachments: &[String],
    working_dir: &Path,
    host_reads_files: bool,
) -> Result<(Vec<serde_json::Value>, String), String> {
    let mut links: Vec<String> = Vec::new();
    let mut images: Vec<PromptInputBlock> = Vec::new();
    let mut image_total: u64 = 0;
    for raw in attachments {
        let path = resolve_attachment_path(raw, working_dir);
        if !host_reads_files {
            links.push(file_reference(raw, &path)?);
            continue;
        }
        let unreadable = |e: std::io::Error| {
            format!(
                "attachment '{raw}' could not be read ({e}). Nothing was created — pass the \
                 absolute path of an existing file, or drop it from `attachments`."
            )
        };
        let meta = tokio::fs::metadata(&path).await.map_err(unreadable)?;
        if !meta.is_file() {
            return Err(format!(
                "attachment '{raw}' is not a file. Nothing was created — attach files only \
                 (mention a directory in `prompt` instead)."
            ));
        }
        let head = read_head(&path).await.map_err(unreadable)?;
        let Some(mime) = sniff_image_mime(&head) else {
            links.push(file_reference(raw, &path)?);
            continue;
        };
        let uri = file_uri(raw, &path)?;
        // Checked against the size on disk BEFORE reading, so an oversized
        // image is refused without buffering it — and again on the bytes read,
        // for a file that grew in between.
        let over_cap = |len: u64| {
            format!(
                "image '{raw}' is {} MB, over the {} MB limit for one attached image. \
                 Nothing was created — attach a smaller image.",
                len.div_ceil(1024 * 1024),
                MAX_ATTACHMENT_IMAGE_BYTES / (1024 * 1024)
            )
        };
        if meta.len() > MAX_ATTACHMENT_IMAGE_BYTES {
            return Err(over_cap(meta.len()));
        }
        let bytes = tokio::fs::read(&path).await.map_err(unreadable)?;
        let len = bytes.len() as u64;
        if len > MAX_ATTACHMENT_IMAGE_BYTES {
            return Err(over_cap(len));
        }
        image_total += len;
        if image_total > MAX_ATTACHMENT_IMAGE_TOTAL_BYTES {
            return Err(format!(
                "the attached images add up to more than {} MB. Nothing was created — attach \
                 fewer or smaller images.",
                MAX_ATTACHMENT_IMAGE_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        images.push(PromptInputBlock::Image {
            data: BASE64.encode(&bytes),
            mime_type: mime.to_string(),
            uri: Some(uri),
        });
    }

    let mut text = prompt.to_string();
    if !links.is_empty() {
        text.push_str("\n\n");
        text.push_str(&links.join("\n"));
    }
    let mut blocks = text_prompt_blocks(&text)?;
    for image in &images {
        blocks.push(
            serde_json::to_value(image)
                .map_err(|e| format!("could not encode an attached image: {e}"))?,
        );
    }
    Ok((blocks, text))
}

/// The advisory on a created task, saying what it carries so the LLM can tell
/// the user the screenshots made it in.
fn work_task_created_note(images: usize, files: usize) -> String {
    let mut note = String::from(
        "Queued as a to-do; the user starts it from there (or auto-processing picks it up).",
    );
    let plural =
        |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    match (images, files) {
        (0, 0) => {}
        (i, 0) => note.push_str(&format!(" Attached {}.", plural(i, "image", "images"))),
        (0, f) => note.push_str(&format!(" Attached {}.", plural(f, "file", "files"))),
        (i, f) => note.push_str(&format!(
            " Attached {} and {}.",
            plural(i, "image", "images"),
            plural(f, "file", "files")
        )),
    }
    note
}

#[async_trait]
impl ChatAuthoringAccess for DbChatAuthoring {
    async fn create_automation(
        &self,
        ctx: AuthoringContext,
        spec: NewAutomationSpec,
    ) -> AuthoringOutcome {
        // Re-check at call time, not just at injection: a session launched while
        // the switch was on keeps the tool listed after the user turns it off,
        // and "off" has to stop the write.
        if !self.config.automations_enabled().await {
            return AuthoringOutcome::rejected(
                KIND_AUTOMATION,
                "Creating automations from chat is turned off in codeg's settings \
                 (Settings → General → Create from chat). Ask the user to enable it.",
            );
        }
        let folder = match self.resolve_folder(&ctx, spec.folder_path.as_deref()).await {
            Ok(f) => f,
            Err(note) => return AuthoringOutcome::rejected(KIND_AUTOMATION, note),
        };
        let agent = match parse_agent_slug(spec.agent_type.as_deref()) {
            Ok(a) => a,
            Err(note) => return AuthoringOutcome::rejected(KIND_AUTOMATION, note),
        };
        // An automation always runs as a concrete agent (the fire path parses
        // this slug), so resolve a default rather than storing an empty string:
        // the project's configured agent, else whatever the caller is running as.
        let agent = match agent.or(folder.default_agent_type) {
            Some(a) => a,
            None => {
                let from_caller = match ctx.conversation_id {
                    Some(id) => conversation_service::get_by_id(&self.db.conn, id)
                        .await
                        .ok()
                        .map(|c| c.agent_type),
                    None => None,
                };
                match from_caller {
                    Some(a) => a,
                    None => {
                        return AuthoringOutcome::rejected(
                            KIND_AUTOMATION,
                            "this project has no default agent — pass agent_type \
                             (e.g. 'claude_code').",
                        );
                    }
                }
            }
        };
        let prompt_blocks = match text_prompt_blocks(&spec.prompt) {
            Ok(b) => b,
            Err(note) => return AuthoringOutcome::rejected(KIND_AUTOMATION, note),
        };
        let config = AutomationConfig {
            action: spec.action,
            prompt_blocks,
            display_text: spec.prompt.clone(),
            mode_id: None,
            config_values: BTreeMap::new(),
            label_snapshot: None,
        };
        let config = match serde_json::to_value(&config) {
            Ok(v) => v,
            Err(e) => {
                return AuthoringOutcome::rejected(
                    KIND_AUTOMATION,
                    format!("could not encode the automation config: {e}"),
                );
            }
        };
        let cron = spec.cron.clone();
        let timezone = spec.timezone.clone().unwrap_or_else(local_timezone);
        let draft = AutomationDraft {
            name: spec.name.clone(),
            enabled: spec.enabled,
            trigger_kind: if cron.is_some() {
                TriggerKind::Schedule
            } else {
                TriggerKind::Manual
            },
            cron: cron.clone(),
            timezone: timezone.clone(),
            agent_type: agent.as_wire().into_owned(),
            root_folder_id: Some(folder.id),
            // A fresh worktree per run is the safe default and the only shape
            // `enqueue_task` accepts; branch / shared-in-root stay an editor-only
            // choice.
            isolation: IsolationMode::WorktreePerRun,
            branch: None,
            is_remote_branch: false,
            config,
        };
        match crate::commands::automation::automation_create_core(&self.emitter, &self.db, draft)
            .await
        {
            Ok(info) => AuthoringOutcome {
                created: true,
                kind: KIND_AUTOMATION.to_string(),
                id: Some(info.id),
                title: Some(info.name),
                folder_name: Some(folder.name),
                folder_path: Some(folder.path),
                agent_type: Some(info.agent_type),
                cron: info.cron,
                timezone: Some(info.timezone),
                next_run_at: info.next_run_at,
                note: (!info.enabled).then(|| {
                    "Saved switched off — the user can enable it on the Automations page."
                        .to_string()
                }),
            },
            // The service's validation errors (bad cron, unknown timezone, empty
            // prompt) are exactly what the LLM should read and retry against, so
            // they come back as a soft note rather than a tool error.
            Err(e) => AuthoringOutcome::rejected(KIND_AUTOMATION, e.to_string()),
        }
    }

    async fn create_work_task(
        &self,
        ctx: AuthoringContext,
        spec: NewWorkTaskSpec,
    ) -> AuthoringOutcome {
        if !self.config.work_tasks_enabled().await {
            return AuthoringOutcome::rejected(
                KIND_WORK_TASK,
                "Creating board tasks from chat is turned off in codeg's settings \
                 (Settings → General → Create from chat). Ask the user to enable it.",
            );
        }
        let folder = match self.resolve_folder(&ctx, spec.folder_path.as_deref()).await {
            Ok(f) => f,
            Err(note) => return AuthoringOutcome::rejected(KIND_WORK_TASK, note),
        };
        let agent = match parse_agent_slug(spec.agent_type.as_deref()) {
            Ok(a) => a,
            Err(note) => return AuthoringOutcome::rejected(KIND_WORK_TASK, note),
        };
        let (prompt_blocks, display_text) = match work_task_prompt_blocks(
            &spec.prompt,
            &spec.attachments,
            &ctx.working_dir,
            ctx.host_reads_files,
        )
        .await
        {
            Ok(b) => b,
            Err(note) => return AuthoringOutcome::rejected(KIND_WORK_TASK, note),
        };
        // Everything after the prose block is an image; the other attachments
        // went into the prose as file references.
        let images = prompt_blocks.len().saturating_sub(1);
        let files = spec.attachments.len().saturating_sub(images);
        // `agent_type: None` deliberately stays None — that is "inherit the
        // board's settings", which is what the user configured for this project.
        let config = WorkTaskConfig {
            prompt_blocks,
            display_text,
            agent_type: agent.map(|a| a.as_wire().into_owned()),
            mode_id: None,
            config_values: BTreeMap::new(),
            label_snapshot: None,
            deliverable: None,
            // No branch face on the authoring tool: the task branches from the
            // project folder's checkout, as it did before the choice existed.
            base_branch: None,
        };
        let config = match serde_json::to_value(&config) {
            Ok(v) => v,
            Err(e) => {
                return AuthoringOutcome::rejected(
                    KIND_WORK_TASK,
                    format!("could not encode the task config: {e}"),
                );
            }
        };
        let draft = WorkTaskDraft {
            folder_id: folder.id,
            title: spec.title.clone(),
            config,
        };
        match crate::commands::work_task::work_task_create_core(&self.emitter, &self.db, draft)
            .await
        {
            Ok(info) => AuthoringOutcome {
                created: true,
                kind: KIND_WORK_TASK.to_string(),
                id: Some(info.id),
                title: Some(info.title),
                folder_name: Some(folder.name),
                folder_path: Some(folder.path),
                agent_type: spec.agent_type.clone(),
                note: Some({
                    let mut note = work_task_created_note(images, files);
                    if !ctx.host_reads_files && files > 0 {
                        note.push_str(
                            " This agent manages its own file access, so they are referenced \
                             by path rather than copied into the task: they must still exist, \
                             and be readable by the agent that runs it, when the task starts.",
                        );
                    }
                    note
                }),
                ..Default::default()
            },
            Err(e) => AuthoringOutcome::rejected(KIND_WORK_TASK, e.to_string()),
        }
    }
}

// ===========================================================================
// Settings persistence — `chat_authoring.automations_enabled` /
// `chat_authoring.work_tasks_enabled` (both default OFF). Mirrors
// `crate::commands::session_info`.
// ===========================================================================

pub const KEY_CHAT_AUTHORING_AUTOMATIONS: &str = "chat_authoring.automations_enabled";
pub const KEY_CHAT_AUTHORING_WORK_TASKS: &str = "chat_authoring.work_tasks_enabled";

/// Off by default, unlike the read-only `get_session_info` / `ask_user_question`
/// toggles: these tools write app state and a scheduled automation goes on to
/// spawn agents unattended, so the user opts in.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatAuthoringSettings {
    pub automations_enabled: bool,
    pub work_tasks_enabled: bool,
}

impl ChatAuthoringSettings {
    fn into_runtime_config(self) -> ChatAuthoringConfig {
        ChatAuthoringConfig {
            automations_enabled: self.automations_enabled,
            work_tasks_enabled: self.work_tasks_enabled,
        }
    }
}

async fn load_flag(conn: &DatabaseConnection, key: &str) -> bool {
    match app_metadata_service::get_value(conn, key).await {
        Ok(Some(raw)) => raw.parse::<bool>().unwrap_or(false),
        _ => false,
    }
}

/// Read the persisted keys from `app_metadata`, falling back to the default
/// (both off) for a missing or malformed value. Never errors hard.
pub async fn load_chat_authoring_settings(conn: &DatabaseConnection) -> ChatAuthoringSettings {
    ChatAuthoringSettings {
        automations_enabled: load_flag(conn, KEY_CHAT_AUTHORING_AUTOMATIONS).await,
        work_tasks_enabled: load_flag(conn, KEY_CHAT_AUTHORING_WORK_TASKS).await,
    }
}

/// Pull settings from the DB and push the resulting [`ChatAuthoringConfig`] onto
/// the shared runtime handle. Idempotent — safe on startup or after any save.
pub async fn apply_persisted_chat_authoring_config(
    conn: &DatabaseConnection,
    config: &ChatAuthoringRuntimeConfig,
) {
    let settings = load_chat_authoring_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

/// Serializes every write to this record within the process.
///
/// Per-key upserts alone are not enough. Both writers below finish by re-reading
/// the record and pushing it onto the runtime config, and `load_*` reads the two
/// keys in two separate queries — so two writers can interleave such that the
/// database ends correct while the runtime handle (which is what the companion
/// injection actually reads) settles on a value neither writer intended, and
/// stays there until the next write or a restart. Holding this across
/// write → re-read → apply → broadcast makes the sequence atomic.
static AUTHORING_WRITE_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Which of the two independent switches in the record to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatAuthoringFlag {
    Automations,
    WorkTasks,
}

/// Move exactly one switch, leaving the sibling to whatever the database says
/// at the moment of the write.
///
/// [`set_chat_authoring_settings_core`] republishes both keys, which is right
/// for the settings form (it edits both) and wrong for any caller that only
/// means to move one: two such callers racing — the status-bar popover's two
/// adjacent switches are one click apart — each read the pair, each write the
/// pair back, and whoever lands second silently reverts the other's flip. This
/// writes one key and then re-reads the record, so concurrent flips of the two
/// switches commute and the broadcast carries the record as it now stands
/// rather than as the caller imagined it.
pub async fn set_chat_authoring_flag_core(
    conn: &DatabaseConnection,
    config: &ChatAuthoringRuntimeConfig,
    emitter: &EventEmitter,
    flag: ChatAuthoringFlag,
    enabled: bool,
) -> Result<ChatAuthoringSettings, AppCommandError> {
    let key = match flag {
        ChatAuthoringFlag::Automations => KEY_CHAT_AUTHORING_AUTOMATIONS,
        ChatAuthoringFlag::WorkTasks => KEY_CHAT_AUTHORING_WORK_TASKS,
    };
    let _guard = AUTHORING_WRITE_LOCK.lock().await;
    app_metadata_service::upsert_value(conn, key, &enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    let settings = load_chat_authoring_settings(conn).await;
    config.set(settings.clone().into_runtime_config()).await;
    emit_event(emitter, CHAT_AUTHORING_SETTINGS_CHANGED_EVENT, &settings);
    Ok(settings)
}

/// Persist + apply + broadcast. Shared by the Tauri command and the HTTP handler
/// so the write + re-apply + notify chain lives in one place.
///
/// Takes [`AUTHORING_WRITE_LOCK`] too: its two upserts are not atomic either, so
/// a per-flag write landing between them would be half-overwritten.
pub async fn set_chat_authoring_settings_core(
    conn: &DatabaseConnection,
    config: &ChatAuthoringRuntimeConfig,
    emitter: &EventEmitter,
    desired: ChatAuthoringSettings,
) -> Result<ChatAuthoringSettings, AppCommandError> {
    let _guard = AUTHORING_WRITE_LOCK.lock().await;
    app_metadata_service::upsert_value(
        conn,
        KEY_CHAT_AUTHORING_AUTOMATIONS,
        &desired.automations_enabled.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    app_metadata_service::upsert_value(
        conn,
        KEY_CHAT_AUTHORING_WORK_TASKS,
        &desired.work_tasks_enabled.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, CHAT_AUTHORING_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_chat_authoring_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<ChatAuthoringSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_chat_authoring_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_chat_authoring_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, ChatAuthoringRuntimeConfig>,
    settings: ChatAuthoringSettings,
) -> Result<ChatAuthoringSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_chat_authoring_settings_core(&db.conn, &config, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn folder(id: i32, path: &str, parent: Option<i32>, kind: FolderKind) -> FolderDetail {
        FolderDetail {
            id,
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            git_branch: None,
            default_agent_type: None,
            last_opened_at: Utc::now(),
            sort_order: 0,
            color: "blue".into(),
            parent_id: parent,
            kind,
            alias: None,
            group_id: None,
        }
    }

    #[test]
    fn match_folder_by_path_prefers_exact_then_deepest() {
        let folders = vec![
            folder(1, "/repo/app", None, FolderKind::Regular),
            folder(2, "/repo/app-2", None, FolderKind::Regular),
            folder(3, "/repo/app/worktrees/wt", Some(1), FolderKind::Regular),
        ];
        // Exact hit.
        assert_eq!(match_folder_by_path(&folders, "/repo/app").unwrap().id, 1);
        // A sibling whose name merely shares a prefix must NOT match.
        assert_eq!(match_folder_by_path(&folders, "/repo/app-2").unwrap().id, 2);
        // A path inside a folder resolves to the deepest containing folder.
        assert_eq!(
            match_folder_by_path(&folders, "/repo/app/worktrees/wt/src/lib.rs")
                .unwrap()
                .id,
            3
        );
        assert_eq!(
            match_folder_by_path(&folders, "/repo/app/src/lib.rs")
                .unwrap()
                .id,
            1
        );
        // Nothing registered under this path.
        assert!(match_folder_by_path(&folders, "/elsewhere").is_none());
        assert!(match_folder_by_path(&folders, "   ").is_none());
    }

    #[test]
    fn parse_agent_slug_validates() {
        assert_eq!(parse_agent_slug(None).unwrap(), None);
        assert_eq!(
            parse_agent_slug(Some("claude_code")).unwrap(),
            Some(AgentType::ClaudeCode)
        );
        assert!(parse_agent_slug(Some("not_an_agent")).is_err());
    }

    #[test]
    fn text_prompt_blocks_is_one_text_block() {
        let blocks = text_prompt_blocks("do the thing").unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], "do the thing");
    }

    #[test]
    fn settings_default_is_both_off() {
        let s = ChatAuthoringSettings::default();
        assert!(!s.automations_enabled);
        assert!(!s.work_tasks_enabled);
    }

    // ── integration: the real write path against an in-memory DB ────────────

    use crate::db::service::{automation_service, work_task_service};
    use crate::db::test_helpers::fresh_in_memory_db;

    /// Wire a `DbChatAuthoring` over a fresh DB with both flags set as given.
    async fn harness(
        automations: bool,
        work_tasks: bool,
    ) -> (
        Arc<AppDatabase>,
        DbChatAuthoring,
        ChatAuthoringRuntimeConfig,
    ) {
        let db = Arc::new(fresh_in_memory_db().await);
        let config = ChatAuthoringRuntimeConfig::new();
        config
            .set(ChatAuthoringConfig {
                automations_enabled: automations,
                work_tasks_enabled: work_tasks,
            })
            .await;
        let access = DbChatAuthoring::new(db.clone(), EventEmitter::Noop, config.clone());
        (db, access, config)
    }

    fn ctx_at(dir: &str) -> AuthoringContext {
        AuthoringContext {
            conversation_id: None,
            working_dir: std::path::PathBuf::from(dir),
            host_reads_files: true,
        }
    }

    fn automation_spec() -> NewAutomationSpec {
        NewAutomationSpec {
            name: "Nightly audit".into(),
            prompt: "audit the dependencies".into(),
            cron: Some("0 3 * * *".into()),
            timezone: Some("UTC".into()),
            action: Default::default(),
            agent_type: Some("claude_code".into()),
            folder_path: None,
            enabled: true,
        }
    }

    fn work_task_spec() -> NewWorkTaskSpec {
        NewWorkTaskSpec {
            title: "Fix the flake".into(),
            prompt: "the retry test is flaky".into(),
            agent_type: None,
            folder_path: None,
            attachments: Vec::new(),
        }
    }

    /// The headline invariant: with the switch off the tool writes NOTHING, even
    /// though the companion may still be advertising it (it was injected while
    /// the switch was on). The injection-time check alone would let this through.
    #[tokio::test]
    async fn create_automation_refuses_and_writes_nothing_when_disabled() {
        let (db, access, _cfg) = harness(false, true).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        let out = access
            .create_automation(ctx_at("/repo/app"), automation_spec())
            .await;

        assert!(!out.created);
        assert_eq!(out.kind, "automation");
        assert!(out.note.unwrap().contains("turned off"));
        assert!(automation_service::list(&db.conn).await.unwrap().is_empty());
    }

    /// …and the two flags gate independently: automations on must not unlock the
    /// board tool.
    #[tokio::test]
    async fn create_work_task_refuses_when_only_automations_enabled() {
        let (db, access, _cfg) = harness(true, false).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        let out = access
            .create_work_task(ctx_at("/repo/app"), work_task_spec())
            .await;

        assert!(!out.created);
        assert!(out.note.unwrap().contains("turned off"));
        assert!(work_task_service::list(&db.conn, None)
            .await
            .unwrap()
            .is_empty());
    }

    /// Flipping the shared runtime handle takes effect on the NEXT call — no
    /// reconstruction of the access impl needed. This is what makes the call-time
    /// check meaningful for an already-running session.
    #[tokio::test]
    async fn flipping_the_flag_takes_effect_on_the_next_call() {
        let (db, access, cfg) = harness(false, false).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        assert!(
            !access
                .create_automation(ctx_at("/repo/app"), automation_spec())
                .await
                .created
        );
        cfg.set(ChatAuthoringConfig {
            automations_enabled: true,
            work_tasks_enabled: false,
        })
        .await;
        let out = access
            .create_automation(ctx_at("/repo/app"), automation_spec())
            .await;
        assert!(out.created, "note: {:?}", out.note);
        assert_eq!(automation_service::list(&db.conn).await.unwrap().len(), 1);
    }

    /// A successful create lands a real row with the shape the fire path expects,
    /// and reports back the schedule the scheduler actually computed.
    #[tokio::test]
    async fn create_automation_persists_a_fireable_row() {
        let (db, access, _cfg) = harness(true, false).await;
        let folder = folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        let out = access
            .create_automation(ctx_at("/repo/app"), automation_spec())
            .await;
        assert!(out.created, "note: {:?}", out.note);
        assert_eq!(out.folder_path.as_deref(), Some("/repo/app"));
        assert!(
            out.next_run_at.is_some(),
            "a scheduled automation has a next run"
        );

        let row = automation_service::get(&db.conn, out.id.unwrap())
            .await
            .unwrap();
        assert_eq!(row.root_folder_id, Some(folder.id));
        assert_eq!(row.agent_type, "claude_code");
        assert_eq!(row.cron.as_deref(), Some("0 3 * * *"));
        assert_eq!(row.isolation, IsolationMode::WorktreePerRun);
        assert!(row.branch.is_none());
        // The fire path parses this slug and replays these blocks verbatim.
        let cfg: AutomationConfig = serde_json::from_value(row.config).unwrap();
        assert_eq!(cfg.prompt_blocks.len(), 1);
        assert_eq!(cfg.prompt_blocks[0]["text"], "audit the dependencies");
        assert_eq!(cfg.display_text, "audit the dependencies");
    }

    /// A chat running inside a worktree targets the PROJECT, not the worktree —
    /// the board and the automations list are both project-scoped.
    #[tokio::test]
    async fn create_work_task_resolves_a_worktree_to_its_project() {
        let (db, access, _cfg) = harness(false, true).await;
        let root = folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();
        folder_service::add_folder_with_parent(&db.conn, "/repo/app-task-1", Some(root.id))
            .await
            .unwrap();

        // Deep inside the worktree, so the deepest-match + parent-hop both run.
        let out = access
            .create_work_task(ctx_at("/repo/app-task-1/src"), work_task_spec())
            .await;

        assert!(out.created, "note: {:?}", out.note);
        let row = work_task_service::get(&db.conn, out.id.unwrap())
            .await
            .unwrap();
        assert_eq!(row.folder_id, root.id, "task belongs to the project root");
        // No agent override — the task inherits the board's configured default.
        let cfg: WorkTaskConfig = serde_json::from_value(row.config).unwrap();
        assert!(cfg.agent_type.is_none());
        assert_eq!(cfg.prompt_blocks.len(), 1);
    }

    const PNG_HEAD: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn sniff_image_mime_reads_the_bytes_not_the_name() {
        assert_eq!(sniff_image_mime(PNG_HEAD), Some("image/png"));
        assert_eq!(
            sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_mime(b"GIF89a.."), Some("image/gif"));
        assert_eq!(
            sniff_image_mime(b"RIFF\0\0\0\0WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(sniff_image_mime(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(sniff_image_mime(b"<svg xmlns="), None);
        assert_eq!(sniff_image_mime(b""), None);
    }

    #[test]
    fn created_note_names_what_was_attached() {
        assert!(!work_task_created_note(0, 0).contains("Attached"));
        assert!(work_task_created_note(1, 0).ends_with("Attached 1 image."));
        assert!(work_task_created_note(0, 2).ends_with("Attached 2 files."));
        assert!(work_task_created_note(2, 1).ends_with("Attached 2 images and 1 file."));
    }

    /// Images travel by value as `image` blocks after the prose (the composer's
    /// order); any other file becomes an inline `file://` reference appended to
    /// the prose, which is also the display text. The image kind comes from the
    /// bytes: a JPEG named `.png` is stored as `image/jpeg`, and a `.png` that
    /// is not an image at all is attached as a plain file.
    #[tokio::test]
    async fn create_work_task_stores_images_inline_and_references_files() {
        let (db, access, _cfg) = harness(false, true).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let shot = dir.path().join("shot.png");
        std::fs::write(&shot, PNG_HEAD).unwrap();
        let mislabelled = dir.path().join("photo.png");
        std::fs::write(&mislabelled, [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]).unwrap();
        let fake = dir.path().join("fake.png");
        std::fs::write(&fake, "not an image").unwrap();
        let log = dir.path().join("run (1).log");
        std::fs::write(&log, "boom").unwrap();

        let mut spec = work_task_spec();
        spec.attachments = vec![
            shot.to_string_lossy().into_owned(),
            log.to_string_lossy().into_owned(),
            mislabelled.to_string_lossy().into_owned(),
            fake.to_string_lossy().into_owned(),
        ];
        let out = access.create_work_task(ctx_at("/repo/app"), spec).await;
        assert!(out.created, "note: {:?}", out.note);
        assert!(
            out.note
                .as_deref()
                .unwrap()
                .ends_with("Attached 2 images and 2 files."),
            "note: {:?}",
            out.note
        );

        let row = work_task_service::get(&db.conn, out.id.unwrap())
            .await
            .unwrap();
        let cfg: WorkTaskConfig = serde_json::from_value(row.config).unwrap();
        let blocks: Vec<PromptInputBlock> = cfg
            .prompt_blocks
            .iter()
            .map(|b| serde_json::from_value(b.clone()).unwrap())
            .collect();
        assert_eq!(blocks.len(), 3, "prose + two images: {blocks:?}");

        let uri = |p: &Path| String::from(url::Url::from_file_path(p).unwrap());
        let expected_text = format!(
            "the retry test is flaky\n\n{}\n{}",
            attachment_marker("run (1).log", &uri(&log)),
            attachment_marker("fake.png", &uri(&fake)),
        );
        assert_eq!(
            blocks[0],
            PromptInputBlock::Text {
                text: expected_text.clone()
            }
        );
        assert_eq!(cfg.display_text, expected_text);
        assert_eq!(
            blocks[1],
            PromptInputBlock::Image {
                data: BASE64.encode(PNG_HEAD),
                mime_type: "image/png".into(),
                uri: Some(uri(&shot)),
            }
        );
        match &blocks[2] {
            PromptInputBlock::Image {
                mime_type, uri: u, ..
            } => {
                assert_eq!(mime_type, "image/jpeg");
                assert_eq!(u.as_deref(), Some(uri(&mislabelled).as_str()));
            }
            other => panic!("expected an image, got {other:?}"),
        }
    }

    /// A caller that hosts its own file access (`CODEG_ACP_HOST_TOOLS=agent`)
    /// must not get codeg to read a file for it: codeg's process is outside the
    /// agent's sandbox. So nothing is read — an image's bytes never land in the
    /// task, and every attachment, even one that does not exist, is only a path
    /// reference for the executing agent to read inside its own sandbox.
    #[tokio::test]
    async fn create_work_task_never_reads_files_for_a_self_sandboxed_agent() {
        let (db, access, _cfg) = harness(false, true).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let shot = dir.path().join("secret.png");
        std::fs::write(&shot, PNG_HEAD).unwrap();
        let missing = dir.path().join("gone.log");

        let mut spec = work_task_spec();
        spec.attachments = vec![
            shot.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ];
        let mut ctx = ctx_at("/repo/app");
        ctx.host_reads_files = false;
        let out = access.create_work_task(ctx, spec).await;
        assert!(out.created, "note: {:?}", out.note);
        assert!(
            out.note.as_deref().unwrap().contains("referenced by path"),
            "note: {:?}",
            out.note
        );

        let row = work_task_service::get(&db.conn, out.id.unwrap())
            .await
            .unwrap();
        let cfg: WorkTaskConfig = serde_json::from_value(row.config).unwrap();
        assert_eq!(cfg.prompt_blocks.len(), 1, "no image block: {cfg:?}");
        let uri = |p: &Path| String::from(url::Url::from_file_path(p).unwrap());
        assert_eq!(
            cfg.display_text,
            format!(
                "the retry test is flaky\n\n{}\n{}",
                attachment_marker("secret.png", &uri(&shot)),
                attachment_marker("gone.log", &uri(&missing)),
            )
        );
        assert!(
            !serde_json::to_string(&cfg.prompt_blocks)
                .unwrap()
                .contains(&BASE64.encode(PNG_HEAD)),
            "the image's bytes must not be stored"
        );
    }

    /// A relative attachment is read against the caller's working directory.
    #[tokio::test]
    async fn create_work_task_resolves_relative_attachments_against_the_working_dir() {
        let (db, access, _cfg) = harness(false, true).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("shots")).unwrap();
        std::fs::write(dir.path().join("shots/a.png"), PNG_HEAD).unwrap();

        let mut spec = work_task_spec();
        spec.folder_path = Some("/repo/app".into());
        spec.attachments = vec!["shots/a.png".into()];
        let ctx = AuthoringContext {
            conversation_id: None,
            working_dir: dir.path().to_path_buf(),
            host_reads_files: true,
        };
        let out = access.create_work_task(ctx, spec).await;
        assert!(out.created, "note: {:?}", out.note);
        let row = work_task_service::get(&db.conn, out.id.unwrap())
            .await
            .unwrap();
        let cfg: WorkTaskConfig = serde_json::from_value(row.config).unwrap();
        assert_eq!(cfg.prompt_blocks.len(), 2);
        assert_eq!(cfg.prompt_blocks[1]["type"], "image");
    }

    /// A missing file, a directory, or an over-cap image refuses the whole
    /// create — softly, naming the attachment — and writes nothing.
    #[tokio::test]
    async fn create_work_task_refuses_bad_attachments_and_writes_nothing() {
        let (db, access, _cfg) = harness(false, true).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone.png");
        let big = dir.path().join("big.png");
        {
            let f = std::fs::File::create(&big).unwrap();
            std::io::Write::write_all(&mut &f, PNG_HEAD).unwrap();
            // Sparse: costs no disk, still reads back over the cap.
            f.set_len(MAX_ATTACHMENT_IMAGE_BYTES + 1).unwrap();
        }

        for (path, expect) in [
            (missing.to_string_lossy().into_owned(), "could not be read"),
            (dir.path().to_string_lossy().into_owned(), "not a file"),
            (big.to_string_lossy().into_owned(), "limit"),
        ] {
            let mut spec = work_task_spec();
            spec.attachments = vec![path.clone()];
            let out = access.create_work_task(ctx_at("/repo/app"), spec).await;
            assert!(!out.created);
            let note = out.note.unwrap();
            assert!(note.contains(expect), "{path}: {note}");
            assert!(
                note.contains(&path),
                "the note names the attachment: {note}"
            );
        }
        assert!(work_task_service::list(&db.conn, None)
            .await
            .unwrap()
            .is_empty());
    }

    /// An unresolvable target is a soft refusal telling the LLM what to pass —
    /// never a silent write to some arbitrary folder.
    #[tokio::test]
    async fn unresolvable_folder_is_a_soft_refusal() {
        let (db, access, _cfg) = harness(true, true).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        // Working dir outside every registered folder.
        let out = access
            .create_automation(ctx_at("/somewhere/else"), automation_spec())
            .await;
        assert!(!out.created);
        assert!(out.note.unwrap().contains("folder_path"));

        // An explicit path that is not a registered folder.
        let mut spec = work_task_spec();
        spec.folder_path = Some("/not/registered".into());
        let out = access.create_work_task(ctx_at("/repo/app"), spec).await;
        assert!(!out.created);
        assert!(out.note.unwrap().contains("/not/registered"));
        assert!(work_task_service::list(&db.conn, None)
            .await
            .unwrap()
            .is_empty());
    }

    /// Settings persist and re-apply onto the shared runtime handle, so a save in
    /// one transport is visible to MCP injection and to the write path.
    #[tokio::test]
    async fn settings_persist_and_reapply_to_the_runtime_handle() {
        let db = fresh_in_memory_db().await;
        let config = ChatAuthoringRuntimeConfig::new();

        // Nothing stored yet → both off.
        apply_persisted_chat_authoring_config(&db.conn, &config).await;
        assert_eq!(config.snapshot().await, ChatAuthoringConfig::default());

        set_chat_authoring_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            ChatAuthoringSettings {
                automations_enabled: true,
                work_tasks_enabled: false,
            },
        )
        .await
        .unwrap();
        assert!(config.automations_enabled().await);
        assert!(!config.work_tasks_enabled().await);

        // Round-trips through the DB (what a fresh boot reads).
        let loaded = load_chat_authoring_settings(&db.conn).await;
        assert!(loaded.automations_enabled);
        assert!(!loaded.work_tasks_enabled);
        let fresh = ChatAuthoringRuntimeConfig::new();
        apply_persisted_chat_authoring_config(&db.conn, &fresh).await;
        assert!(fresh.automations_enabled().await);
        assert!(!fresh.work_tasks_enabled().await);
    }
}
