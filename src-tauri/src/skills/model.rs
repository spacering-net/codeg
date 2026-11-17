//! What the skills engine's commands take and return, exactly as serialized.
//!
//! Every type here serializes with snake_case field names and snake_case enum
//! values, like the MCP engine's (`commands::mcp_engine::model`). Results say
//! what happened in the value — a lock that could not be taken, an operation
//! that needs confirming, a write that failed — with a stable code from
//! [`codes`]; nothing is meant to be read from the English `detail`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::models::agent::AgentType;

/// The event every change to skills is announced with. Payload: [`SkillsChanged`].
pub const SKILLS_CHANGED_EVENT: &str = "skills://changed";

/// Every code the engine reports, in results (`issues`, `warnings`) and in
/// the `i18n_params.code` of the errors it throws.
pub mod codes {
    // ── The lock and the disk ────────────────────────────────────────────
    /// Another writer held the skills lock for the whole wait.
    pub const LOCK_BUSY: &str = "lock_busy";
    /// The fallback lock file (`skills.lock.d`) is there and stayed there.
    pub const LOCK_HELD: &str = "lock_held";
    /// A file or directory could not be read, created or moved.
    pub const IO_ERROR: &str = "io_error";

    // ── What an operation names ──────────────────────────────────────────
    /// The skill id is not a valid directory name.
    pub const SKILL_INVALID: &str = "skill_invalid";
    /// No skill of that id is in Codeg's store.
    pub const SKILL_NOT_FOUND: &str = "skill_not_found";
    /// The agent has no skill directory Codeg knows of.
    pub const AGENT_UNSUPPORTED: &str = "agent_unsupported";
    /// A pack's skill whose id a skill of another origin holds in the store.
    pub const NAME_TAKEN: &str = "name_taken";
    /// The id is already used (in the store, or in a directory of the scope).
    pub const ID_TAKEN: &str = "id_taken";
    /// The id belongs to one of Codeg's skill packs.
    pub const ID_RESERVED: &str = "id_reserved";

    // ── Linking ──────────────────────────────────────────────────────────
    /// A real folder or file is where the link would go.
    pub const TARGET_OCCUPIED: &str = "target_occupied";
    /// A link to somewhere else is where the link would go.
    pub const TARGET_LINKED_ELSEWHERE: &str = "target_linked_elsewhere";
    /// A broken link is where the link would go.
    pub const TARGET_BROKEN: &str = "target_broken";
    /// "Only for this agent" for an agent without a directory of its own.
    pub const NO_OWN_DIRECTORY: &str = "no_own_directory";
    /// "Only for this agent" for an agent that does not see the skill.
    pub const NOT_VISIBLE: &str = "not_visible";
    /// The operation changes what other agents see; it needs the `ack` its
    /// preflight returned.
    pub const ACKNOWLEDGEMENT_REQUIRED: &str = "acknowledgement_required";
    /// The `ack` sent is not the one these effects have now: they changed
    /// since the preflight.
    pub const EFFECTS_CHANGED: &str = "effects_changed";
    /// A copy Codeg made was changed on the agent's side; it is not replaced
    /// or removed without `replace_modified`.
    pub const COPY_MODIFIED: &str = "copy_modified";
    /// Neither a link nor (where allowed) a copy could be made.
    pub const LINK_FAILED: &str = "link_failed";
    /// A copy could not be made or verified.
    pub const COPY_FAILED: &str = "copy_failed";
    /// An entry could not be removed.
    pub const REMOVE_FAILED: &str = "remove_failed";
    /// The link record could not be written; everything was put back.
    pub const RECORD_WRITE_FAILED: &str = "record_write_failed";
    /// Putting things back after a failure failed too.
    pub const ROLLBACK_FAILED: &str = "rollback_failed";

    // ── Repairing a link ─────────────────────────────────────────────────
    /// The path is not in any agent's skill directory.
    pub const PATH_OUTSIDE_AGENT_DIRS: &str = "path_outside_agent_dirs";
    /// The entry is not a link Codeg made.
    pub const NOT_CODEG_LINK: &str = "not_codeg_link";
    /// The link is not broken.
    pub const NOT_BROKEN: &str = "not_broken";

    // ── The agents' own skills (the Skills page) ─────────────────────────
    /// The write would go, through a link, into Codeg's store.
    pub const STORE_LINK_READ_ONLY: &str = "store_link_read_only";
    /// The skill belongs to the agent CLI itself.
    pub const READ_ONLY_SKILL: &str = "read_only_skill";
    /// No such skill in that scope.
    pub const NOT_FOUND: &str = "not_found";
    /// "Move into Codeg management" of something that is not a skill of the
    /// agent's own (a link, say).
    pub const NOT_OWN_SKILL: &str = "not_own_skill";
    /// A copy did not match its source.
    pub const VERIFY_FAILED: &str = "verify_failed";
    /// The source of an import is not a skill.
    pub const INVALID_SOURCE: &str = "invalid_source";

    // ── Backups ──────────────────────────────────────────────────────────
    pub const BACKUP_NOT_FOUND: &str = "backup_not_found";
    /// The backup is linked into an agent's directory (an older release's
    /// backup the user enabled): turn those links off first.
    pub const BACKUP_LINKED: &str = "backup_linked";

    // ── Reading the store ────────────────────────────────────────────────
    /// A manifest or the link record could not be read; what it claims is
    /// left out. `path` = the file.
    pub const MANIFEST_UNREADABLE: &str = "manifest_unreadable";
    /// A folder under a pack's id whose owner nobody can tell (the pack's
    /// manifest could not be read, and the folder is not the pack's skill as
    /// shipped): left exactly as it is, not claimed by the pack (it reads as
    /// the user's; the pack's is "name taken"). `path` = the folder,
    /// `detail` = the pack (`experts`, `science`, `office`).
    pub const OWNERSHIP_UNRESOLVED: &str = "ownership_unresolved";

    // ── Warnings ─────────────────────────────────────────────────────────
    /// The agent already sees Codeg's skill (`path`); nothing is added.
    pub const ALREADY_VISIBLE: &str = "already_visible";
    /// The link goes into a directory other agents read too (`agents`).
    pub const SHARED_DIRECTORY: &str = "shared_directory";
    /// The agents in `agents` read the same shared directory and lose the
    /// skill along with this one: it cannot be turned off for one alone.
    pub const DISABLED_TOGETHER: &str = "disabled_together";
    /// No link could be made (Windows: the junction failed); a copy was made
    /// instead, which does not follow updates by itself.
    pub const COPIED: &str = "copied";
    /// A copy changed on the agent's side was left as it is (`path`).
    pub const COPY_MODIFIED_KEPT: &str = "copy_modified_kept";
    /// Something else of the same name is in another directory the agent
    /// reads (`path`).
    pub const NAME_ALSO_ELSEWHERE: &str = "name_also_elsewhere";
    /// `refresh` found no copy of the skill for the agent.
    pub const NO_COPY: &str = "no_copy";
}

/// One reason, problem or remark. Absent fields are omitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillsIssue {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// `rollback_failed`: what Codeg left where it is so that nothing is
    /// lost — the original it had moved aside (in a staging folder whose
    /// `op.json` lets the next start put it back), a backup it had taken.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub kept: Vec<String>,
}

impl SkillsIssue {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            path: None,
            agents: Vec::new(),
            detail: None,
            kept: Vec::new(),
        }
    }

    pub fn kept(mut self, kept: &[PathBuf]) -> Self {
        self.kept = kept
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        self
    }

    pub fn path(mut self, path: impl AsRef<std::path::Path>) -> Self {
        self.path = Some(path.as_ref().to_string_lossy().into_owned());
        self
    }

    pub fn agents(mut self, agents: Vec<AgentType>) -> Self {
        self.agents = agents;
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

// ─── Who a skill belongs to ─────────────────────────────────────────────

/// The origin of a skill in Codeg's store, as the manifests say: a pack's
/// manifest (or the UI skill's marker), the Harness manifest, or none of
/// them — a Custom skill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOrigin {
    Experts,
    Science,
    Office,
    Ui,
    Harness,
    Custom,
}

impl SkillOrigin {
    pub fn is_pack(self) -> bool {
        matches!(
            self,
            SkillOrigin::Experts | SkillOrigin::Science | SkillOrigin::Office | SkillOrigin::Ui
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SkillOrigin::Experts => "experts",
            SkillOrigin::Science => "science",
            SkillOrigin::Office => "office",
            SkillOrigin::Ui => "ui",
            SkillOrigin::Harness => "harness",
            SkillOrigin::Custom => "custom",
        }
    }
}

// ─── Directories ────────────────────────────────────────────────────────

/// What a skill directory is to one agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DirRole {
    /// Only this agent reads it.
    Own,
    /// Other agents read it too (`~/.agents/skills`, say).
    Shared,
    /// The agent CLI's own bundled skills (Codex `skills/.system`, Cursor
    /// `skills-cursor`): listed, never linked into.
    ReadOnly,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSkillDir {
    pub path: String,
    pub role: DirRole,
    /// The other agents that read this directory.
    pub shared_with: Vec<AgentType>,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillsAgent {
    pub agent: AgentType,
    /// Every global skill directory the agent reads, in its reading order.
    pub dirs: Vec<AgentSkillDir>,
    /// Where enabling a skill puts the link: the agent's first directory of
    /// its own, else its first shared one. `null` without either.
    pub link_dir: Option<String>,
    /// `link_dir` is shared: enabling there shows the skill to other agents
    /// too, so it needs confirming.
    pub link_dir_shared: bool,
}

// ─── The state of a skill for an agent ──────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CellState {
    /// Codeg's link, in a directory of the agent's own.
    Linked,
    /// Codeg's link, in a shared directory the agent reads (`dir`).
    VisibleThrough,
    /// Codeg's copy (where no link could be made); see `copy_matches`.
    Copy,
    /// A link to somewhere else holds the name.
    LinkedElsewhere,
    /// A real folder or file holds the name.
    Blocked,
    /// A broken link holds the name; `codeg` says whether Codeg made it.
    Broken,
    NotLinked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    /// A link Codeg made, to this skill in the store.
    CodegLink,
    /// A copy Codeg made (its record says so).
    CodegCopy,
    /// A broken link Codeg made.
    CodegBroken,
    /// A link to somewhere else (another place, or another skill).
    Link,
    /// A broken link Codeg did not make.
    BrokenLink,
    Folder,
    File,
    Unreadable,
}

/// One thing under the skill's name in one of the agent's directories.
#[derive(Debug, Clone, Serialize)]
pub struct CellEntry {
    pub path: String,
    pub dir: String,
    pub dir_role: DirRole,
    pub kind: EntryKind,
    /// The link's target as it reads; links only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Copies only: the copy is what Codeg copied (its recorded hash).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_matches: Option<bool>,
    /// Copies only: the copy equals the skill in the store now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_current: Option<bool>,
}

/// A skill × an agent.
#[derive(Debug, Clone, Serialize)]
pub struct SkillCell {
    pub agent: AgentType,
    pub state: CellState,
    /// The entry that decides `state`; `null` for `not_linked`.
    pub path: Option<String>,
    pub dir: Option<String>,
    pub dir_role: Option<DirRole>,
    pub target: Option<String>,
    /// The deciding entry is Codeg's (its link, copy or broken link).
    pub codeg: bool,
    pub copy_matches: Option<bool>,
    pub copy_current: Option<bool>,
    /// The other agents that see this same entry (it is in a shared
    /// directory).
    pub shared_with: Vec<AgentType>,
    /// Everything under the skill's name in the agent's directories.
    pub entries: Vec<CellEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessSkillInfo {
    #[serde(rename = "ref")]
    pub item_ref: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoreSkill {
    pub id: String,
    pub origin: SkillOrigin,
    pub path: String,
    /// Frontmatter `name:`, else the id.
    pub name: String,
    pub description: Option<String>,
    /// A pack's skill the user had changed, set aside at the last update.
    pub pending_user_review: bool,
    pub harness: Option<HarnessSkillInfo>,
    /// How many backups of it there are (`skills_backups`).
    pub backups: usize,
    pub cells: Vec<SkillCell>,
}

/// A pack's skill that is not in the store as the pack's: a skill of
/// another origin holds the id.
#[derive(Debug, Clone, Serialize)]
pub struct NameTaken {
    pub id: String,
    pub pack: SkillOrigin,
    pub held_by: SkillOrigin,
}

/// A broken link Codeg made, wherever it is — also those whose skill is no
/// longer in the store.
#[derive(Debug, Clone, Serialize)]
pub struct BrokenLink {
    pub path: String,
    pub dir: String,
    pub target: Option<String>,
    /// The store id it points at.
    pub skill: String,
    /// Every agent that reads the directory.
    pub agents: Vec<AgentType>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillsInventory {
    pub store: String,
    pub agents: Vec<SkillsAgent>,
    pub skills: Vec<StoreSkill>,
    pub name_taken: Vec<NameTaken>,
    pub broken_links: Vec<BrokenLink>,
    pub problems: Vec<SkillsIssue>,
}

// ─── Applying ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillAction {
    /// Make the agent see Codeg's skill.
    Enable,
    /// Make the agent stop seeing it: remove Codeg's links (and matching
    /// copies) in every directory it reads.
    Disable,
    /// Keep it for this agent alone: move a shared link into the agent's
    /// own directory.
    Only,
    /// Bring Codeg's copies of the skill for this agent up to date.
    Refresh,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SkillOp {
    pub skill: String,
    pub agent: AgentType,
    pub action: SkillAction,
    /// The `ack` the preflight returned for this operation, when it needs one.
    #[serde(default)]
    pub ack: Option<String>,
    /// `refresh` only: replace a copy changed on the agent's side, after
    /// backing it up.
    #[serde(default)]
    pub replace_modified: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SkillsApplyRequest {
    pub ops: Vec<SkillOp>,
    #[serde(default)]
    pub preflight: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyOutcome {
    /// A preflight: nothing written.
    Preflight,
    /// Every operation done.
    Applied,
    /// An operation changes what other agents see and its `ack` was missing
    /// or stale. Nothing written.
    AcknowledgementRequired,
    /// An operation cannot be done. Nothing written.
    Invalid,
    /// The skills lock could not be taken. Nothing written.
    Busy,
    /// A write failed; what had been done was put back (see each op).
    WriteFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpStatus {
    /// Preflight: would be done.
    Ready,
    /// Nothing to do.
    Unchanged,
    /// Would be done once acknowledged (preflight), or was not done for
    /// want of the acknowledgement.
    NeedsAck,
    /// Cannot be done; see `issues`.
    Blocked,
    Done,
    /// Not done, because another operation stopped the request.
    NotDone,
    /// Its write failed.
    Failed,
    /// Was done, and put back after a later failure.
    RolledBack,
    /// Was done, and could not be put back.
    RollbackFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Link,
    Copy,
    BrokenLink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathChange {
    pub path: String,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathMove {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillOpResult {
    pub index: usize,
    pub skill: String,
    pub agent: AgentType,
    pub action: SkillAction,
    pub status: OpStatus,
    pub creates: Vec<PathChange>,
    pub removes: Vec<PathChange>,
    pub moves: Vec<PathMove>,
    /// Other agents that start seeing the skill.
    pub gains: Vec<AgentType>,
    /// Other agents that stop seeing it.
    pub loses: Vec<AgentType>,
    /// Other agents whose directories change though they keep seeing it.
    pub touches: Vec<AgentType>,
    /// Present when the operation affects other agents: send it back in the
    /// op to confirm exactly these effects.
    pub ack: Option<String>,
    pub issues: Vec<SkillsIssue>,
    pub warnings: Vec<SkillsIssue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillsApplyResult {
    pub outcome: ApplyOutcome,
    /// Applied in full — or, in a preflight, nothing is blocked.
    pub ok: bool,
    pub ops: Vec<SkillOpResult>,
    /// About the request as a whole (the lock).
    pub issues: Vec<SkillsIssue>,
}

// ─── Repairing a broken link ────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepairAction {
    /// Point it at the store's skill of its own name again.
    Repoint,
    Remove,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillsRepairResult {
    pub outcome: ApplyOutcome,
    pub ok: bool,
    pub path: String,
    pub action: RepairAction,
    /// The store id the link points at afterwards (`repoint`).
    pub skill: Option<String>,
    pub status: OpStatus,
    pub creates: Vec<PathChange>,
    pub removes: Vec<PathChange>,
    pub gains: Vec<AgentType>,
    pub loses: Vec<AgentType>,
    pub touches: Vec<AgentType>,
    pub ack: Option<String>,
    pub issues: Vec<SkillsIssue>,
    pub warnings: Vec<SkillsIssue>,
}

// ─── Moving an agent's skill into Codeg ─────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdoptOutcome {
    Adopted,
    Invalid,
    Busy,
    /// A step failed; everything was put back (unless `restored` is false).
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillsAdoptResult {
    pub outcome: AdoptOutcome,
    pub ok: bool,
    pub skill: String,
    pub agent: AgentType,
    /// The agent's skill that was moved (a folder, or a flat `<id>.md`).
    pub source: Option<String>,
    pub store_path: Option<String>,
    pub link_path: Option<String>,
    /// `symlink`, `junction` or `copy`.
    pub mode: Option<String>,
    /// After a failure: whether everything was put back as it was.
    pub restored: bool,
    pub issues: Vec<SkillsIssue>,
}

// ─── Backups ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupKind {
    /// A pack's (or Harness's) skill the user had changed, set aside before
    /// an update.
    Update,
    /// A copy changed on an agent's side, set aside before it was replaced.
    Copy,
    /// An older release's `<id>.user-backup-<time>` still in the store root,
    /// because it is linked into an agent's directory.
    Legacy,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillBackup {
    pub skill: String,
    /// Its name among the skill's backups; with `skill`, what the restore and
    /// delete commands take.
    pub name: String,
    pub path: String,
    pub kind: BackupKind,
    /// RFC 3339, from the name; `null` when the name carries no time.
    pub created_at: Option<String>,
    /// `copy` backups: the agent whose copy it was.
    pub agent: Option<String>,
    /// `legacy` backups: the agents that see it through a link.
    pub linked_by: Vec<AgentType>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillsBackups {
    pub backups: Vec<SkillBackup>,
    pub problems: Vec<SkillsIssue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupOutcome {
    Restored,
    Deleted,
    Invalid,
    Busy,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillsBackupResult {
    pub outcome: BackupOutcome,
    pub ok: bool,
    pub skill: String,
    pub name: String,
    /// `restore`: the Custom skill's id and path.
    pub id: Option<String>,
    pub path: Option<String>,
    /// `restore`: whether the backup is still there (an older release's
    /// linked backup is copied, not moved).
    pub backup_kept: bool,
    pub issues: Vec<SkillsIssue>,
}

// ─── The event ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangedKind {
    /// Links or copies in agents' skill directories.
    Links,
    /// Skills in Codeg's store (created, edited, updated, removed).
    Store,
    /// An agent's own skills (the Skills page).
    AgentSkills,
    /// Backups of skills.
    Backups,
}

/// What changed, and for which agents — never any file content or name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillsChanged {
    pub kinds: Vec<ChangedKind>,
    pub agents: Vec<AgentType>,
}
