//! What a plugin's install plan, its install and its uninstall take and
//! answer (`super::install`), and its update, a change of mode, switching
//! off and on and repair (`super::update`). Answers are snake_case like the skill
//! install's; requests camelCase.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::harness::mcp::model::{PlanItem, Reason};
use crate::harness::skills::owned::OwnedPlan;
use crate::harness::skills::{PackageLimits, UninstallOutcome};
use crate::harness::types::{
    Archive, AutorunPart, FileEntry, ItemStatus, NotFull, PluginComponent, PluginHost, Source,
    VersionState,
};
use crate::models::agent::AgentType;
use crate::skills::owned::ExpertLink;

use super::record::{HostMode, HostState};

/// The codes of the plugin install's [`Reason`]s (beside the shared ones,
/// the skill install's and the adapters' `hosts::codes`).
pub mod codes {
    /// The item is of another kind. Params: `kind`.
    pub const NOT_A_PLUGIN: &str = "not_a_plugin";
    /// A plugin's install info without its `plugin` part.
    pub const PLUGIN_INFO_MISSING: &str = "plugin_info_missing";
    /// The plugin's name cannot be an install name. Params: `name`.
    pub const INSTALL_NAME_INVALID: &str = "plugin_install_name_invalid";
    /// The request's install name is not the revision's `PluginInfo.name`.
    /// Params: `expected`, `name`.
    pub const INSTALL_NAME_MISMATCH: &str = "plugin_install_name_mismatch";
    /// Another item is installed under the name (no other name is tried:
    /// the members call each other by it). Params: `name`, `ref`.
    pub const INSTALL_NAME_TAKEN: &str = "plugin_install_name_taken";
    /// This item is installed already: an update or a change of modes, not
    /// an install. Params: `name`.
    pub const ALREADY_INSTALLED: &str = "plugin_already_installed";
    /// The request installs it for no agent.
    pub const NO_HOSTS: &str = "plugin_no_hosts";
    /// "Install as a plugin" for an agent whose host Codeg has no adapter
    /// for. Params: `agent`.
    pub const NO_ADAPTER: &str = "plugin_no_adapter";
    /// "Install as a plugin" for an agent whose host cannot take it now.
    /// Params: `agent`, `why` (the reason's code); `detail`: its detail.
    pub const NATIVE_UNAVAILABLE: &str = "plugin_native_unavailable";
    /// The request's revision is not the one these modes install (`full`
    /// with any host as a plugin, else the latest). Params: `revision`,
    /// `expected` (empty: there is none), `mode` (`native` / `skills`).
    pub const REVISION_NOT_TARGET: &str = "plugin_revision_not_target";
    /// No revision may be installed whole. Params: `reason` (`NotFull`, when
    /// the site said).
    pub const NO_FULL: &str = "plugin_no_full";
    /// The revision is not approved to be installed whole. Params:
    /// `revision`.
    pub const NOT_APPROVED: &str = "plugin_not_approved";
    /// An MCP server it brings is not pinned. Params: `servers`.
    pub const MCP_UNPINNED: &str = "plugin_mcp_unpinned";
    /// What runs on its own needs the user's agreement (`consentExec`).
    pub const CONSENT_REQUIRED: &str = "plugin_consent_required";
    /// The agreement given is not for what runs on its own now. Params:
    /// `expected`.
    pub const CONSENT_STALE: &str = "plugin_consent_stale";
    /// A host step failed. Params: `agent`, `step`.
    pub const HOST_STEP_FAILED: &str = "plugin_host_step_failed";
    /// What these agents have of the plugin is not known: repair or
    /// uninstall. Params: `agents`.
    pub const NEEDS_REPAIR: &str = "plugin_needs_repair";
    /// Every agent has the revision to update to already, as it should.
    /// Params: `revision`.
    pub const UP_TO_DATE: &str = "plugin_up_to_date";
    /// The record changed since the plan was made (another operation on
    /// the plugin): plan again.
    pub const RECORD_CHANGED: &str = "plugin_record_changed";
    /// The plugin is not installed for this agent. Params: `agent`.
    pub const NOT_ON_AGENT: &str = "plugin_not_on_agent";
    /// The agent's only one with the plugin: uninstall it instead.
    /// Params: `agent`.
    pub const LAST_HOST: &str = "plugin_last_host";
    /// The agent has the plugin so already. Params: `agent`.
    pub const UNCHANGED: &str = "plugin_unchanged";
    /// Codeg turned it off for the agent (SRN no longer vouches for the
    /// revision): only an update the user agrees to turns it on again.
    /// Params: `agent`, `reason`.
    pub const SUSPENDED: &str = "plugin_suspended";
    /// The agent does not need repair. Params: `agent`.
    pub const NO_REPAIR_NEEDED: &str = "plugin_no_repair_needed";
    /// The host knows the plugin by another name in the new revision: it
    /// cannot be updated in place; uninstall it and install it again.
    /// Params: `agent`.
    pub const REINSTALL_REQUIRED: &str = "plugin_reinstall_required";
    /// The revision's folder is not what its listing says (changed since
    /// it was put there): nothing of it goes into a host as a plugin.
    /// Params: `revision`; `detail`: what differs.
    pub const REVISION_MODIFIED: &str = "plugin_revision_modified";
    /// SRN could not be asked whether it vouches for the revision: what
    /// runs on its own stays off. Set as a `Suspended` reason.
    pub const UNVERIFIED: &str = "plugin_unverified";
    /// An advisory asks for the revision to be switched off (or taken out):
    /// it is not installed, updated, resumed or switched on whole, and what
    /// runs on its own stays off. Also a `Suspended` reason.
    pub const ADVISORY_DISABLE: &str = "plugin_advisory_disable";
    /// The agent's launch environment (its settings) cannot be read: its
    /// host is not looked at with a guessed one. Params: `agent`.
    pub const ENV_UNREADABLE: &str = "plugin_launch_env_unreadable";
}

/// How an agent is to have the plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanMode {
    /// Whole, through the host's own plugin system.
    Native,
    /// Its skills only, through Codeg's skill store.
    Skills,
    /// Not at all.
    None,
}

impl PlanMode {
    pub fn host_mode(self) -> Option<HostMode> {
        match self {
            PlanMode::Native => Some(HostMode::Native),
            PlanMode::Skills => Some(HostMode::Skills),
            PlanMode::None => None,
        }
    }
}

/// One revision the plan offers: the latest, or the one to install whole.
#[derive(Debug, Clone, Serialize)]
pub struct PlanRevision {
    pub revision: u64,
    pub version: Option<String>,
    pub published_at: String,
    /// `PluginInfo.name`: the install name with this revision.
    pub name: Option<String>,
    /// Its `/resolve` fingerprint: what the request confirms.
    pub state_sha256: Option<String>,
    /// From the fresh snapshot: may it be installed whole.
    pub approved: bool,
    /// What the user agrees to when something runs on its own.
    pub exec_sha256: Option<String>,
    pub mcp_unpinned: Vec<String>,
    /// Skills and assistants.
    pub members: Vec<PluginComponent>,
    pub autorun: Vec<AutorunPart>,
    pub autorun_files: Vec<String>,
    /// What each host gets, as the website lists it.
    pub hosts: Vec<PluginHost>,
    pub archive: Option<Archive>,
    pub source: Option<Source>,
    pub files: Vec<FileEntry>,
    pub total_bytes: u64,
    /// Why this revision cannot be installed at all now.
    pub blocking: Vec<Reason>,
    /// What the user must confirm in so many words (`yanked`).
    pub confirm: Vec<Reason>,
    pub warnings: Vec<Reason>,
}

/// What the adapter found of the agent's host.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanDetect {
    pub found: bool,
    /// `wrapper` (the ACP wrapper's own copy) or `native` (the user's CLI).
    pub via: Option<String>,
    pub version: Option<String>,
    pub supported: bool,
    pub why_not: Option<Reason>,
}

/// One agent's row in the install dialog.
#[derive(Debug, Clone, Serialize)]
pub struct PlanHost {
    pub agent: AgentType,
    /// The website's host id, for an agent whose host has an adapter.
    pub host_id: Option<String>,
    /// Whether the agent is installed here; `None` when it cannot be told.
    pub installed: Option<bool>,
    pub detect: Option<PlanDetect>,
    pub offered: Vec<PlanMode>,
    pub default: PlanMode,
    /// The mode this row's preflight is for (as asked, else the default).
    pub planned: PlanMode,
    /// Why "as a plugin" is not offered.
    pub why_not: Option<Reason>,
    /// The Experts pack's links the install takes out of what the agent
    /// reads (for the planned mode's revision), given back on uninstall.
    pub experts_to_take_over: Vec<ExpertLink>,
    /// Send it back (`expertsAcks`) when the takeover reaches other agents
    /// (a shared directory).
    pub experts_ack: Option<String>,
    /// Codex runs the plugin's hooks only once the user trusts them there.
    pub codex_hooks_need_trust: bool,
    /// Skills planned: the links' preflight (`acks` by member), what holds a
    /// name, the copies that go.
    pub skills: Option<OwnedPlan>,
}

/// How one agent has an installed plugin.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstalledHost {
    pub mode: HostMode,
    pub state: HostState,
    pub host_name: Option<String>,
    pub skills: Vec<String>,
    pub experts: Vec<ExpertLink>,
}

/// The record's entry for the item, when it is installed.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstalledPlugin {
    pub name: String,
    pub item_id: String,
    #[serde(rename = "ref")]
    pub item_ref: String,
    pub revision: u64,
    pub version: Option<String>,
    /// By agent wire id.
    pub hosts: BTreeMap<String, InstalledHost>,
    /// The `exec_sha256` agreed to.
    pub consent: Option<String>,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessPluginPlan {
    /// The latest revision's item.
    pub item: PlanItem,
    pub item_status: ItemStatus,
    pub latest: PlanRevision,
    /// The revision to install whole (it may be the latest); `None`: none
    /// may be.
    pub full: Option<PlanRevision>,
    pub not_full: Option<NotFull>,
    /// The revision the planned modes install: `full` with any agent as a
    /// plugin, else the latest.
    pub target: u64,
    /// `PluginInfo.name` of `target`.
    pub install_name: Option<String>,
    /// `target`'s members.
    pub members: Vec<PluginComponent>,
    /// What runs on its own in `full`.
    pub autorun: Vec<AutorunPart>,
    pub snapshot_latest: Option<VersionState>,
    pub snapshot_full: Option<VersionState>,
    pub hosts: Vec<PlanHost>,
    /// The planned modes install something whole that runs on its own: the
    /// request needs `consentExec` = `consent_exec`.
    pub consent_required: bool,
    pub consent_exec: Option<String>,
    /// Why nothing can be installed (for the planned modes).
    pub blocking: Vec<Reason>,
    pub warnings: Vec<Reason>,
    pub installed: Option<InstalledPlugin>,
    pub limits: PackageLimits,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessPluginInstallRequest {
    pub item_ref: String,
    pub revision: u64,
    pub install_name: String,
    /// How each agent is to have it; `none` and agents left out get nothing.
    pub hosts: BTreeMap<AgentType, PlanMode>,
    /// The fingerprint of the revision's snapshot the user confirmed.
    pub state_sha256: String,
    /// The `exec_sha256` the user agreed to (needed when something runs on
    /// its own and any agent has it as a plugin).
    pub consent_exec: Option<String>,
    /// Skills agents: by member, the `ack` of its link's op.
    pub acks: BTreeMap<AgentType, BTreeMap<String, String>>,
    /// The plan's `experts_ack`, by agent.
    pub experts_acks: BTreeMap<AgentType, String>,
    pub accept_yanked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallOutcome {
    /// Installed for every agent asked; recorded.
    Installed,
    /// The call cannot be carried out as it is (`issues`). Nothing written.
    Refused,
    /// Effects on other agents are not the ones confirmed (`skills`,
    /// `experts_acks`: the preflights now). Nothing written.
    AcknowledgementRequired,
    /// The snapshot changed since it was confirmed. Nothing written.
    StateChanged,
    /// The item or revision can no longer be installed so. Nothing written.
    Aborted,
    /// The package is not what its install info says. Nothing written.
    InvalidPackage,
    /// A lock could not be taken. Nothing written. Retry.
    Busy,
    /// A step failed; what was done was undone (`hosts`), or the agents in
    /// `needs_repair` are marked so in the record.
    Failed,
    /// Every agent has the new revision; recorded.
    Updated,
    /// The agent has it as asked (a mode, on or off); recorded.
    Changed,
    /// The agents asked are repaired (those still in `needs_repair` are
    /// not); recorded.
    Repaired,
    /// What the call would do (`skills`, `experts_acks`, `consent_*`,
    /// `snapshot`). Nothing written.
    Preflight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostStepStatus {
    Done,
    Failed,
    /// Done (or begun), then undone after a later failure.
    Undone,
    /// It could not be undone: the record marks the agent so.
    NeedsRepair,
}

/// What one agent's step did.
#[derive(Debug, Clone, Serialize)]
pub struct HostOutcome {
    pub agent: AgentType,
    pub mode: HostMode,
    pub status: HostStepStatus,
    pub host_name: Option<String>,
    pub issues: Vec<Reason>,
    /// The Experts pack's links taken out.
    pub experts_taken: Vec<ExpertLink>,
    /// …and put back.
    pub experts_back: Vec<ExpertLink>,
    /// Not put back: the user changed their place meanwhile.
    pub experts_left: Vec<ExpertLink>,
}

impl HostOutcome {
    pub(crate) fn new(agent: AgentType, mode: HostMode) -> Self {
        Self {
            agent,
            mode,
            status: HostStepStatus::Done,
            host_name: None,
            issues: Vec::new(),
            experts_taken: Vec::new(),
            experts_back: Vec::new(),
            experts_left: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessPluginInstallResult {
    pub outcome: PluginInstallOutcome,
    pub issues: Vec<Reason>,
    /// `state_changed`: what changed.
    pub changes: Vec<Reason>,
    pub snapshot: Option<VersionState>,
    pub state_sha256: Option<String>,
    pub name: Option<String>,
    pub revision: Option<u64>,
    pub hosts: Vec<HostOutcome>,
    /// `acknowledgement_required`: the skills agents' preflights now.
    pub skills: BTreeMap<AgentType, OwnedPlan>,
    /// `acknowledgement_required`: the experts' acks now.
    pub experts_acks: BTreeMap<AgentType, String>,
    pub needs_repair: Vec<AgentType>,
    /// What the cleanup after the commit could not do (the next operation
    /// does it).
    pub problems: Vec<String>,
    /// An update or a change (`preflight` / `refused`): the user must agree
    /// to what runs on its own, `consent_exec`.
    pub consent_required: bool,
    pub consent_exec: Option<String>,
    /// A change's preflight: the Experts pack's links it takes out, and
    /// gives back, by agent.
    pub experts_to_take_over: BTreeMap<AgentType, Vec<ExpertLink>>,
    pub experts_to_give_back: BTreeMap<AgentType, Vec<ExpertLink>>,
}

impl HarnessPluginInstallResult {
    pub(crate) fn new(outcome: PluginInstallOutcome) -> Self {
        Self {
            outcome,
            issues: Vec::new(),
            changes: Vec::new(),
            snapshot: None,
            state_sha256: None,
            name: None,
            revision: None,
            hosts: Vec::new(),
            skills: BTreeMap::new(),
            experts_acks: BTreeMap::new(),
            needs_repair: Vec::new(),
            problems: Vec::new(),
            consent_required: false,
            consent_exec: None,
            experts_to_take_over: BTreeMap::new(),
            experts_to_give_back: BTreeMap::new(),
        }
    }

    pub(crate) fn refused(issues: Vec<Reason>) -> Self {
        Self {
            issues,
            ..Self::new(PluginInstallOutcome::Refused)
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessPluginUninstallRequest {
    pub item_id: String,
    pub preflight: bool,
    /// The preflight's `ack`.
    pub ack: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessPluginUninstallResult {
    pub outcome: UninstallOutcome,
    pub issues: Vec<Reason>,
    pub item_id: String,
    pub name: Option<String>,
    /// Skills agents: what goes from where, and who stops seeing it.
    pub removes: BTreeMap<AgentType, OwnedPlan>,
    /// The Experts pack's links to give back, by agent.
    pub experts: BTreeMap<AgentType, Vec<ExpertLink>>,
    /// Send it back with the real call.
    pub ack: Option<String>,
    pub hosts: Vec<HostOutcome>,
    pub needs_repair: Vec<AgentType>,
    pub problems: Vec<String>,
}

impl HarnessPluginUninstallResult {
    pub(crate) fn new(outcome: UninstallOutcome, item_id: &str) -> Self {
        Self {
            outcome,
            issues: Vec::new(),
            item_id: item_id.to_string(),
            name: None,
            removes: BTreeMap::new(),
            experts: BTreeMap::new(),
            ack: None,
            hosts: Vec::new(),
            needs_repair: Vec::new(),
            problems: Vec::new(),
        }
    }
}

// ─── Update, a change of mode, on and off, repair ───────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessPluginUpdateRequest {
    pub item_id: String,
    /// The plan's `target`.
    pub revision: u64,
    /// The fingerprint of the target's snapshot the user confirmed.
    pub state_sha256: String,
    /// The `exec_sha256` the user agreed to (needed when the plan says
    /// `needs_consent`).
    pub consent_exec: Option<String>,
    /// Skills agents: by member, the `ack` of its link's op.
    pub acks: BTreeMap<AgentType, BTreeMap<String, String>>,
    /// The plan's `experts_ack`, by agent.
    pub experts_acks: BTreeMap<AgentType, String>,
    pub accept_yanked: bool,
}

/// How one member differs between the installed revision and the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberChangeKind {
    Added,
    Removed,
    /// Its files' tree hash differs (or one of the two is not known).
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MemberChange {
    pub kind: crate::harness::types::ComponentKind,
    pub name: String,
    pub change: MemberChangeKind,
}

/// What an update does for one agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateAction {
    /// Moved to the target revision, as it has it now.
    Update,
    /// Turned on again (Codeg had turned it off), at the target revision.
    Resume,
    /// Its host cannot take the target whole: its skills only from now on.
    ToSkills,
    /// Switched off by the user: only the record moves (it stays off).
    RecordOnly,
    /// Nothing to do: it has the target as it should.
    None,
    /// It needs repair first: left as it is.
    NeedsRepair,
}

/// One agent's row in the update prompt.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateHost {
    pub agent: AgentType,
    pub host_id: Option<String>,
    pub mode: HostMode,
    pub state: HostState,
    /// How it has the plugin once updated.
    pub to_mode: HostMode,
    pub to_state: HostState,
    pub action: UpdateAction,
    /// `to_skills`: why its host cannot take the target whole.
    pub why_not: Option<Reason>,
    pub detect: Option<PlanDetect>,
    pub experts_to_take_over: Vec<ExpertLink>,
    pub experts_ack: Option<String>,
    /// Links of members the target no longer has.
    pub experts_to_give_back: Vec<ExpertLink>,
    pub codex_hooks_need_trust: bool,
    /// Skills from now on: the links' preflight (`acks` by member).
    pub skills: Option<OwnedPlan>,
}

/// The update prompt: from which revision to which, what changed, what
/// each agent gets, and what the user must agree to.
#[derive(Debug, Clone, Serialize)]
pub struct HarnessPluginUpdatePlan {
    pub installed: InstalledPlugin,
    pub item: Option<PlanItem>,
    pub item_status: ItemStatus,
    pub latest: Option<PlanRevision>,
    pub full: Option<PlanRevision>,
    pub not_full: Option<NotFull>,
    /// The revision every agent moves to: `full` when any agent keeps it as
    /// a plugin, else the latest. `None`: there is none to move to.
    pub target: Option<u64>,
    pub revision_from: u64,
    pub version_from: Option<String>,
    pub version_to: Option<String>,
    /// By `treeSha256`, installed against target; `None` when the target
    /// is not known.
    pub changed_members: Option<Vec<MemberChange>>,
    /// Every agent has the target as it should: nothing to update.
    pub up_to_date: bool,
    /// The request needs `consentExec` = `consent_exec`: what runs on its
    /// own changed since the user agreed to it, or Codeg turned it off.
    pub needs_consent: bool,
    pub consent_exec: Option<String>,
    pub autorun: Vec<AutorunPart>,
    pub snapshot: Option<VersionState>,
    pub state_sha256: Option<String>,
    pub hosts: Vec<UpdateHost>,
    pub blocking: Vec<Reason>,
    pub warnings: Vec<Reason>,
    pub limits: PackageLimits,
}

/// How one agent is to have the plugin from now on (at the record's
/// revision): another mode, or not at all.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPluginSetHostRequest {
    pub item_id: String,
    pub agent: AgentType,
    pub mode: PlanMode,
    /// Only say what it would do.
    #[serde(default)]
    pub preflight: bool,
    /// As a plugin: the fingerprint of the revision's snapshot the user
    /// confirmed (the preflight's `state_sha256`).
    #[serde(default)]
    pub state_sha256: Option<String>,
    #[serde(default)]
    pub consent_exec: Option<String>,
    /// The preflight's skills `acks`, by member.
    #[serde(default)]
    pub acks: BTreeMap<String, String>,
    #[serde(default)]
    pub experts_ack: Option<String>,
}

/// One agent's plugin switched off or on again.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPluginSetEnabledRequest {
    pub item_id: String,
    pub agent: AgentType,
    pub enabled: bool,
    #[serde(default)]
    pub preflight: bool,
    #[serde(default)]
    pub acks: BTreeMap<String, String>,
    #[serde(default)]
    pub experts_ack: Option<String>,
}

/// The agents an interrupted operation left (`needs_repair`) brought back
/// to the record: the given one, else all of them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessPluginRepairRequest {
    pub item_id: String,
    pub agent: Option<AgentType>,
    pub preflight: bool,
    pub acks: BTreeMap<AgentType, BTreeMap<String, String>>,
    pub experts_acks: BTreeMap<AgentType, String>,
}
