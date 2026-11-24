//! What the Harness skill commands take and answer, as they go over the wire.
//!
//! Like H4's (`harness::mcp::model`): top-level *arguments* are camelCase
//! (Tauri's convention, read the same way by the Web routes), everything
//! returned is **snake_case** — including the skills engine's results it
//! embeds unchanged (`links`). Three objects are the catalog's own and keep
//! the API's camelCase: `snapshot` (`/resolve`'s `VersionState`), `latest`,
//! and `package.archive` / `package.source` / `package.files` (whose fields
//! are single words anyway).
//!
//! Everything a person is told is a [`Reason`] (H4's type): a stable
//! snake_case code with the values the sentence needs as `params`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::harness::mcp::model::{LocalState, PlanItem, Reason};
use crate::harness::types::{Archive, FileEntry, ItemStatus, LatestVersion, Source, VersionState};
use crate::models::agent::AgentType;
use crate::skills::model::{SkillOpResult, SkillOrigin, SkillsApplyResult, SkillsIssue};

/// The stable codes of this step's [`Reason`]s. The snapshot's codes (the
/// item as a whole, what changed, the packages' pins) are H4's
/// (`harness::mcp::model::codes`) and mean the same here.
pub mod codes {
    // ── The item as a whole (plan `blocking`) ────────────────────────────
    /// The item is not a skill. Params: `kind`.
    pub const NOT_A_SKILL: &str = "not_a_skill";
    /// `.manifest.harness.json` cannot be read (or a newer Codeg wrote it):
    /// nothing is installed or uninstalled, so as not to lose it. `detail`.
    pub const MANIFEST_UNREADABLE: &str = "manifest_unreadable";

    // ── The package, as its file list gives it (plan `blocking`; install
    //    `invalid_package`) ───────────────────────────────────────────────
    /// A listed path is absolute, climbs (`..`), has an empty or `.`
    /// segment, a backslash, a drive or stream colon, or a control
    /// character. Params: `path`.
    pub const UNSAFE_PATH: &str = "unsafe_path";
    /// Two listed paths are the same ignoring case. Params: `path`.
    pub const DUPLICATE_PATH: &str = "duplicate_path";
    /// More files than `/config` allows. Params: `count`, `limit`.
    pub const TOO_MANY_FILES: &str = "too_many_files";
    /// One file over `/config`'s `fileBytes`. Params: `path`, `size`, `limit`.
    pub const FILE_TOO_LARGE: &str = "file_too_large";
    /// All files together over `/config`'s `totalBytes`. Params: `size`,
    /// `limit`.
    pub const PACKAGE_TOO_LARGE: &str = "package_too_large";
    /// A path deeper than `/config`'s `depth`. Params: `path`, `limit`.
    pub const TOO_DEEP: &str = "too_deep";
    /// A path longer (UTF-8 bytes) than `/config`'s `pathBytes`. Params:
    /// `path`, `limit`.
    pub const PATH_TOO_LONG: &str = "path_too_long";
    /// The archive is over `/config`'s `zipBytes`. Params: `size`, `limit`.
    pub const ARCHIVE_TOO_LARGE: &str = "archive_too_large";
    /// The package has no `SKILL.md` at its root.
    pub const SKILL_MD_MISSING: &str = "skill_md_missing";
    /// A hash in the install info is not 64 lowercase hex digits. Params:
    /// `path` (empty for the archive's).
    pub const HASH_INVALID: &str = "hash_invalid";
    /// The archive's address is not a path on the catalog's origin.
    pub const ARCHIVE_ADDRESS_INVALID: &str = "archive_address_invalid";
    /// No archive, and the source is not a GitHub repository at a full
    /// commit with a safe folder. Params: `field` (`repository`, `commit`,
    /// `path`).
    pub const SOURCE_INVALID: &str = "source_invalid";

    // ── What the download turned out to be (install `invalid_package`) ───
    /// The archive is not the size the install info gives. Params:
    /// `expected`, `actual`.
    pub const ARCHIVE_SIZE_MISMATCH: &str = "archive_size_mismatch";
    /// The archive does not hash to what the install info gives.
    pub const ARCHIVE_HASH_MISMATCH: &str = "archive_hash_mismatch";
    /// The archive cannot be read as a zip (or an entry of it). `detail`.
    pub const ARCHIVE_UNREADABLE: &str = "archive_unreadable";
    /// A listed file is not in the archive. Params: `path`.
    pub const FILE_MISSING: &str = "file_missing";
    /// The archive holds a file the list does not name (or names twice).
    /// Params: `path`.
    pub const FILE_UNEXPECTED: &str = "file_unexpected";
    /// A file is not the size listed. Params: `path`, `expected`.
    pub const FILE_SIZE_MISMATCH: &str = "file_size_mismatch";
    /// A file does not hash to what is listed. Params: `path`.
    pub const FILE_HASH_MISMATCH: &str = "file_hash_mismatch";
    /// A file over `compression.minBytes` unpacks to more than
    /// `compression.ratio` times its packed size. Params: `path`, `limit`.
    pub const COMPRESSION_RATIO: &str = "compression_ratio";
    /// The archive holds a link (or another special file). Params: `path`.
    pub const LINK_IN_ARCHIVE: &str = "link_in_archive";
    /// Without an archive: the source host has no such file at the commit.
    /// Params: `path`.
    pub const SOURCE_FILE_UNAVAILABLE: &str = "source_file_unavailable";
    /// `SKILL.md` cannot be rewritten safely (not UTF-8, no frontmatter, or
    /// a frontmatter whose rewrite could not be checked). `detail`.
    pub const SKILL_MD_INVALID: &str = "skill_md_invalid";

    // ── The install name (install `refused`) ─────────────────────────────
    /// Not a skill name: `^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$`. Params:
    /// `name`.
    pub const NAME_INVALID: &str = "name_invalid";
    /// A Codeg pack's id (Experts, Science, Office, UI). Params: `name`,
    /// `pack`.
    pub const NAME_RESERVED: &str = "name_reserved";
    /// Something already holds the name (see `NameTaken.by`). Params:
    /// `name`, `by`; `path`, `item_ref` when known.
    pub const NAME_TAKEN: &str = "name_taken";
    /// The item is installed under another name: update it under that one,
    /// or uninstall it first. Params: `name` (the recorded one).
    pub const INSTALLED_UNDER_OTHER_NAME: &str = "installed_under_other_name";
    /// A target that is not an agent with skill directories. Params:
    /// `agent`.
    pub const AGENT_UNSUPPORTED: &str = "agent_unsupported";

    // ── Warnings (plan `warnings`) ───────────────────────────────────────
    /// No archive: the files come from GitHub (`raw.githubusercontent.com`)
    /// at the source commit, each checked against its listed hash. Params:
    /// `repository`, `commit`.
    pub const FETCHED_FROM_SOURCE: &str = "fetched_from_source";
    /// `SKILL.md` declares `allowed-tools`: dropped unless the user keeps
    /// it. Params: `tools` (comma-separated).
    pub const ALLOWED_TOOLS: &str = "allowed_tools";
    /// An update over files the user changed: the old folder is kept in
    /// `.user-backups/<name>/<time>/`. Params: `count`.
    pub const FILES_CHANGED_LOCALLY: &str = "files_changed_locally";
    /// The installed folder cannot be compared with what was installed (a
    /// file cannot be read): an update or uninstall keeps it whole in
    /// `.user-backups/<name>/<time>/`.
    pub const FILES_UNREADABLE: &str = "files_unreadable";

    // ── Uninstall ────────────────────────────────────────────────────────
    /// The real call sent no `ack` (run the preflight first).
    pub const ACKNOWLEDGEMENT_REQUIRED: &str = "acknowledgement_required";
    /// The `ack` sent is not the one the effects have now.
    pub const EFFECTS_CHANGED: &str = "effects_changed";

    // ── Disk (install / uninstall `write_failed`, `issues`) ──────────────
    /// A file or folder could not be written, moved or removed. `detail`,
    /// `path` param when known.
    pub const IO_ERROR: &str = "io_error";
    /// The manifest could not be written; everything was put back.
    pub const MANIFEST_WRITE_FAILED: &str = "manifest_write_failed";
    /// Putting things back failed too. Nothing was deleted: `kept` lists
    /// where things are, and the next start finishes the job.
    pub const ROLLBACK_FAILED: &str = "rollback_failed";
    /// Uninstall: a link could not be removed; nothing else was changed.
    pub const UNLINK_FAILED: &str = "unlink_failed";
}

// ─── Shared pieces ──────────────────────────────────────────────────────

/// What Codeg changed in the package when it installed it, recorded in the
/// manifest and done again on an update.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rewrites {
    /// `SKILL.md`'s `name`, set to the install name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<NameRewrite>,
    /// What became of `SKILL.md`'s `allowed-tools`; absent when it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<AllowedTools>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameRewrite {
    /// As the package wrote it; `null` when it had none (or one that is not
    /// one line of text).
    pub from: Option<String>,
    pub to: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllowedTools {
    /// Taken out (the default): the agent asks before using any tool.
    Removed,
    /// Kept, because the user said so.
    Kept,
}

/// The files of an installed skill that are not as installed (by SHA-256,
/// skipping what the skills engine's change detection skips:
/// `__pycache__/`, `*.pyc`, `.DS_Store`, `Thumbs.db`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct FileChanges {
    pub changed: Vec<String>,
    pub added: Vec<String>,
    pub missing: Vec<String>,
}

impl FileChanges {
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.added.is_empty() && self.missing.is_empty()
    }
}

/// One installed Harness skill, as the listing (and the plan, for an
/// update) gives it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstalledSkill {
    /// The item's stable id: what `/resolve` is asked by.
    pub id: String,
    /// `publisher/name` as recorded at the last install.
    #[serde(rename = "ref")]
    pub item_ref: String,
    /// The install name: the folder in Codeg's store, the skill's id
    /// everywhere else (`skills_inventory`, `skills_apply_links`).
    pub name: String,
    pub revision: u64,
    pub version: Option<String>,
    /// `as_installed`; `changed_locally` (a file changed or added);
    /// `missing` (the folder or a file of it is gone); `unknown` (the folder
    /// cannot be read).
    pub state: LocalState,
    /// The agents that see Codeg's link (or copy) of it now.
    pub agents: Vec<AgentType>,
    pub files: FileChanges,
    pub rewrites: Rewrites,
    /// The archive's SHA-256; `null` when the files came from the source.
    pub archive_sha256: Option<String>,
    /// The `/resolve` fingerprint the user confirmed when installing.
    pub state_sha256: String,
    pub installed_at: String,
}

/// What ended each phase of an install or uninstall.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Download,
    Verify,
    Snapshot,
    Stage,
    Unlink,
    Swap,
    Commit,
    Cleanup,
    Backup,
    Links,
    Copies,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PhaseStatus {
    Done,
    /// Nothing to do in it.
    Skipped,
    Failed,
    /// Done, then put back after a later failure.
    RolledBack,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PhaseResult {
    pub phase: Phase,
    pub status: PhaseStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

// ─── harness_skill_plan ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanSkill {
    /// The skill's own name (`SKILL.md`'s, as the catalog read it).
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    /// `SKILL.md`'s `allowed-tools`, when it declares any (`null`: none).
    /// Dropped at install unless `keepAllowedTools`.
    pub allowed_tools: Option<Vec<String>>,
}

/// The limits a package is checked against (`/config`'s, capped by Codeg's
/// own ceilings).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PackageLimits {
    pub zip_bytes: u64,
    pub total_bytes: u64,
    pub files: u64,
    pub file_bytes: u64,
    pub depth: u64,
    pub path_bytes: u64,
    pub compression_min_bytes: u64,
    pub compression_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanPackage {
    /// The whole package as one zip (API shape); `null`: the files come from
    /// `source`.
    pub archive: Option<Archive>,
    pub source: Option<Source>,
    pub files: Vec<FileEntry>,
    pub total_bytes: u64,
    pub limits: PackageLimits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TakenBy {
    /// A Codeg pack's id (`pack` says which), whether or not it is there.
    Reserved,
    /// A skill a pack's manifest claims (`pack`).
    Pack,
    /// A Custom skill of the user's in the store.
    Custom,
    /// Another Harness item (`item_id`, `item_ref`).
    Harness,
    /// Something in the store under that name that is not a skill.
    Store,
    /// A link (or copy) Codeg made under that name in an agent's directory,
    /// which would come alive (`path`, `agents` = who reads it).
    CodegLink,
    /// Something under that name in a target agent's skill directory
    /// (`path`, `agents`). Only the default name avoids it; a name the user
    /// gives may keep it, and linking to that agent is then refused.
    AgentDir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NameTaken {
    pub name: String,
    pub by: TakenBy,
    pub pack: Option<SkillOrigin>,
    pub item_id: Option<String>,
    pub item_ref: Option<String>,
    pub path: Option<String>,
    pub agents: Vec<AgentType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NamePlan {
    /// The skill's own name.
    pub name: String,
    /// The name proposed: the recorded one for an installed item; else the
    /// skill's name; else `<name>-<publisher>` (cut to 64); else that with
    /// `-2`, `-3`, …
    pub default: String,
    /// Why each name tried before `default` was not taken (and anything
    /// under `default` in a target's directory).
    pub taken: Vec<NameTaken>,
    /// The rule every install name must match.
    pub pattern: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanAgent {
    pub agent: AgentType,
    /// Installed on this machine, as the Agents page says (custom agents:
    /// `true`); `null` when that cannot be told.
    pub installed: Option<bool>,
    /// Where enabling links it (the engine's `link_dir`).
    pub link_dir: Option<String>,
    pub link_dir_shared: bool,
    /// Sees Codeg's skill under the default name now (an update).
    pub sees: bool,
    /// Ticked by default.
    pub default: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessSkillPlan {
    pub item: PlanItem,
    pub item_status: ItemStatus,
    /// By `/resolve` (API shape, camelCase).
    pub latest: Option<LatestVersion>,
    /// The revision's state, read fresh from `/resolve` (API shape): the
    /// only source of the dialog's status, risk, review, permissions, checks
    /// and package verification.
    pub snapshot: Option<VersionState>,
    /// Send it back as `stateSha256`.
    pub state_sha256: Option<String>,
    pub blocking: Vec<Reason>,
    /// To be confirmed explicitly (`yanked`).
    pub confirm: Vec<Reason>,
    pub warnings: Vec<Reason>,
    pub skill: PlanSkill,
    pub package: PlanPackage,
    pub install_name: NamePlan,
    /// Every agent with skill directories, in the engine's order.
    pub agents: Vec<PlanAgent>,
    pub default_agents: Vec<AgentType>,
    /// The skills engine's preflight of `enable` for the agents asked about
    /// (`agents`, else `default_agents`), in that order, under
    /// `install_name.default`, as if the skill were in the store already.
    /// Each op's `ack` goes back in `acks`.
    pub links: SkillsApplyResult,
    /// Set when the item is installed (an update).
    pub installed: Option<InstalledSkill>,
}

// ─── harness_skill_install ──────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessSkillInstallRequest {
    pub item_ref: String,
    pub revision: u64,
    pub install_name: String,
    /// The agents to link it to (in this order). May be empty.
    pub agents: Vec<AgentType>,
    /// Keep `SKILL.md`'s `allowed-tools` (default: drop it).
    pub keep_allowed_tools: bool,
    /// The fingerprint of the snapshot the user confirmed.
    pub state_sha256: String,
    /// Per agent, the `ack` the links preflight gave its op.
    pub acks: BTreeMap<AgentType, String>,
    pub accept_yanked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallOutcome {
    /// In the store and the manifest; see `links` for each agent.
    Installed,
    /// The call cannot be carried out as it is (`issues`). Nothing written.
    Refused,
    /// A link's effects on other agents are not the ones confirmed
    /// (`links`: the preflight now, with its `ack`s). Nothing written.
    AcknowledgementRequired,
    /// The snapshot changed since it was confirmed (`changes`, `snapshot`,
    /// `state_sha256`). Nothing written.
    StateChanged,
    /// The item or version can no longer be installed (`issues`,
    /// `snapshot`). Nothing written.
    Aborted,
    /// The package is not what its install info says, or breaks a limit or
    /// a path rule (`issues`). Nothing written.
    InvalidPackage,
    /// The skills lock could not be taken. Nothing written. Retry.
    Busy,
    /// A step on disk failed; what was done was put back (`phases`,
    /// `issues`; `kept` when putting back failed too).
    WriteFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CopiesRefresh {
    /// Codeg's copies replaced with the new content.
    pub refreshed: Vec<String>,
    /// Copies changed on the agent's side: left as they are.
    pub kept_changed: Vec<String>,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessSkillInstallResult {
    pub outcome: InstallOutcome,
    pub issues: Vec<Reason>,
    pub changes: Vec<Reason>,
    pub snapshot: Option<VersionState>,
    pub state_sha256: Option<String>,
    /// The install name it was (or would have been) installed under.
    pub name: Option<String>,
    pub phases: Vec<PhaseResult>,
    /// `acknowledgement_required`: the links preflight now. `installed`: the
    /// engine's result of the link request that ran (ops blocked in the
    /// preflight are not in it: `links_skipped`).
    pub links: Option<SkillsApplyResult>,
    /// The ops the preflight under the lock found blocked (e.g. a folder of
    /// the same name in that agent's directory): not run, nothing there
    /// overwritten.
    pub links_skipped: Vec<SkillOpResult>,
    /// An update: Codeg's copies (where no link could be made).
    pub copies: Option<CopiesRefresh>,
    /// An update over changed files: where the old folder was kept.
    pub backup: Option<String>,
    pub rewrites: Option<Rewrites>,
    /// What stayed where it is because putting it back failed.
    pub kept: Vec<String>,
}

// ─── harness_skill_uninstall ────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessSkillUninstallRequest {
    pub item_id: String,
    pub preflight: bool,
    /// The preflight's `ack`.
    pub ack: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UninstallOutcome {
    Preflight,
    Uninstalled,
    Refused,
    AcknowledgementRequired,
    Busy,
    WriteFailed,
}

/// One entry an uninstall removes from an agent's directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Removal {
    pub path: String,
    /// `link`, `copy` or `broken_link`.
    pub kind: crate::skills::model::ChangeKind,
    /// Who reads the directory it is in.
    pub agents: Vec<AgentType>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessSkillUninstallResult {
    pub outcome: UninstallOutcome,
    pub issues: Vec<Reason>,
    pub item_id: String,
    pub name: Option<String>,
    pub removes: Vec<Removal>,
    /// Every agent that stops seeing it.
    pub loses: Vec<AgentType>,
    /// Copies changed on the agent's side: left where they are (the
    /// engine's `copy_modified_kept`).
    pub kept_copies: Vec<SkillsIssue>,
    /// Files the user changed in the store's folder: the folder then goes to
    /// `.user-backups/<name>/<time>/` instead of being deleted.
    pub files: FileChanges,
    /// The folder could not be compared with what was installed (why): it is
    /// then kept whole, as for changed files.
    pub files_unreadable: Option<String>,
    /// The folder goes to `.user-backups/<name>/<time>/` (changed or
    /// unreadable files), not deleted. Covered by the `ack`.
    pub keeps_folder: bool,
    /// The real call: where the changed folder was kept.
    pub backup: Option<String>,
    /// Send it back with the real call.
    pub ack: Option<String>,
    pub phases: Vec<PhaseResult>,
    pub kept: Vec<String>,
}

// ─── harness://installed-changed ────────────────────────────────────────

/// Payload of `harness://installed-changed` for skills: the same shape as
/// H4's, with the skills engine's agent names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillsInstalledChanged {
    pub item_ids: Vec<String>,
    pub agents: Vec<AgentType>,
}

pub(crate) fn phase(phase: Phase, status: PhaseStatus) -> PhaseResult {
    PhaseResult {
        phase,
        status,
        detail: None,
    }
}

pub(crate) fn phase_detail(phase: Phase, status: PhaseStatus, detail: String) -> PhaseResult {
    PhaseResult {
        phase,
        status,
        detail: Some(detail),
    }
}
