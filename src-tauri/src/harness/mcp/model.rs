//! What the Harness MCP commands take and answer, as they go over the wire.
//!
//! Every field this module defines is snake_case, like the MCP engine's
//! types, whose results these embed unchanged (`apply`, `definition`). Two
//! objects are the catalog's own and keep the API's camelCase: `snapshot`
//! (the API's `VersionState`, read fresh from `/resolve`) and `latest`.
//!
//! Everything a person is told — why an option cannot be chosen, what to
//! confirm, what changed — is a [`Reason`]: a stable snake_case code (see
//! [`codes`]) with the values the sentence needs as `params`. `detail` is
//! technical and never the only explanation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::commands::mcp::McpAppType;
use crate::commands::mcp_engine::model::{
    McpApplyResult, McpDefinition, McpFileStatus, McpIssue, McpTransport,
};
use crate::harness::types::{ItemStatus, Kind, LatestVersion, Localized, Verified, VersionState};

/// Announces that the provenance record changed (an install, an update, an
/// uninstall, or a scan that found a server gone). Payload:
/// [`InstalledChanged`]. The engine's `mcp://changed` still announces the
/// config files that were written.
pub const INSTALLED_CHANGED_EVENT: &str = "harness://installed-changed";

/// The stable codes of [`Reason`]s.
pub mod codes {
    // ── The item as a whole cannot be installed (plan `blocking`; install
    //    `aborted` when it became so after the plan) ─────────────────────
    /// The item is not an MCP server. Params: `kind`.
    pub const NOT_AN_MCP_SERVER: &str = "not_an_mcp_server";
    /// The item is not public or listed (any more). Params: `status`
    /// (`retired`, `removed`, `unavailable`, `unknown`).
    pub const ITEM_UNAVAILABLE: &str = "item_unavailable";
    /// The item has no such revision. Params: `revision`.
    pub const REVISION_UNAVAILABLE: &str = "revision_unavailable";
    /// Harness blocked this version.
    pub const VERSION_BLOCKED: &str = "version_blocked";
    /// The version's status is one this Codeg does not know.
    pub const VERSION_STATUS_UNKNOWN: &str = "version_status_unknown";
    /// `/resolve` left out something the decision needs. Params: `field`.
    pub const SNAPSHOT_INCOMPLETE: &str = "snapshot_incomplete";
    /// The version has no server definition, or none Codeg can install.
    pub const NOTHING_TO_INSTALL: &str = "nothing_to_install";
    /// The version's server.json cannot be read. `detail` says why.
    pub const SERVER_UNREADABLE: &str = "server_unreadable";

    // ── To be confirmed explicitly (plan `confirm`) ──────────────────────
    /// The author withdrew this version (`acceptYanked: true` installs it).
    pub const YANKED: &str = "yanked";

    // ── One option cannot be chosen (`options[].blocking`) ───────────────
    /// Only npm and PyPI packages are run. Params: `registry_type`.
    pub const REGISTRY_UNSUPPORTED: &str = "registry_unsupported";
    /// The package asks for a runtime other than `npx` (npm) or `uvx`
    /// (PyPI). Params: `registry_type`, `runtime`.
    pub const RUNTIME_UNSUPPORTED: &str = "runtime_unsupported";
    /// The package's name carries a version of its own, so the pinned one
    /// could not be applied. Params: `registry_type`, `identifier`.
    pub const IDENTIFIER_HAS_VERSION: &str = "identifier_has_version";
    /// The package declares runtime arguments (`npx`/`uvx` options, or
    /// operands before the package): they could make the runner fetch or run
    /// something other than the pinned package, so none are passed. Params:
    /// `registry_type`, `identifier`, `argument` (the first one's name).
    pub const RUNTIME_ARGUMENTS_UNSUPPORTED: &str = "runtime_arguments_unsupported";
    /// The package declares an environment variable that configures the
    /// runner itself (`npm_config_*`, `UV_*`, `PIP_*`, `NODE_OPTIONS`,
    /// `NODE_PATH`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`), which could
    /// change where the package comes from or what runs. Params: `name`.
    pub const RUNNER_ENVIRONMENT_UNSUPPORTED: &str = "runner_environment_unsupported";
    /// Harness has no pin for the package. Params: `registry_type`,
    /// `identifier`.
    pub const PACKAGE_NOT_PINNED: &str = "package_not_pinned";
    /// The pinned version is empty, `latest`, or not an exact version.
    /// Params: `registry_type`, `identifier`, `version` (may be empty).
    pub const PACKAGE_VERSION_INEXACT: &str = "package_version_inexact";
    /// The pinned version is not at its registry. Params: `registry_type`,
    /// `identifier`, `version`.
    pub const PACKAGE_MISSING: &str = "package_missing";
    /// A verification result this Codeg does not know. Same params.
    pub const PACKAGE_VERIFICATION_UNKNOWN: &str = "package_verification_unknown";
    /// The address is not a public https address. Params: `host` (empty
    /// when the address cannot be read).
    pub const REMOTE_NOT_PUBLIC: &str = "remote_not_public";
    /// A required secret could only be sent in the URL's query string.
    /// Params: `name`.
    pub const SECRET_IN_QUERY: &str = "secret_in_query";

    // ── Worth telling, stops nothing (`options[].warnings`) ──────────────
    /// The pinned version has not been checked at its registry (yet).
    /// Params: `registry_type`, `identifier`, `version`, `verified`
    /// (`pending`, `unchecked`).
    pub const VERSION_UNVERIFIED: &str = "version_unverified";
    /// The package runs install scripts when it is fetched. Params:
    /// `registry_type`, `identifier`.
    pub const INSTALL_SCRIPT: &str = "install_script";
    /// An optional secret is left out: it could only be sent in the query
    /// string. Params: `name`.
    pub const SECRET_NOT_SENT: &str = "secret_not_sent";

    // ── An install or uninstall call that is not carried out (`refused`) ─
    pub const OPTION_NOT_FOUND: &str = "option_not_found";
    /// The name does not match `^[A-Za-z0-9_-]{1,64}$`. Params: `key`.
    pub const KEY_INVALID: &str = "key_invalid";
    /// `codeg-mcp` is Codeg's own. Params: `key`.
    pub const KEY_RESERVED: &str = "key_reserved";
    /// No agent to install to.
    pub const NO_TARGETS: &str = "no_targets";
    /// `replace` names an agent that is not a target. Params: `agent`.
    pub const REPLACE_NOT_TARGET: &str = "replace_not_target";
    /// No basis was given for a target agent. Params: `agent`.
    pub const BASIS_REQUIRED: &str = "basis_required";
    /// A required parameter has no value. Params: `key`.
    pub const PARAMETER_REQUIRED: &str = "parameter_required";
    /// The agent already has a server under this name and the call does
    /// not say to replace it. Params: `agent`, `key`.
    pub const REPLACE_REQUIRED: &str = "replace_required";
    /// The version is yanked and the call does not accept that.
    pub const YANKED_NOT_ACCEPTED: &str = "yanked_not_accepted";
    /// The item is installed under another name; update or extend it under
    /// that name, or uninstall it first. Params: `key` (the recorded one).
    pub const INSTALLED_UNDER_OTHER_KEY: &str = "installed_under_other_key";
    /// The provenance record cannot be read (or was written by a newer
    /// Codeg); nothing is written so as not to lose it. `detail` says why.
    pub const RECORD_UNREADABLE: &str = "record_unreadable";
    /// The definition could not be made from the server.json and the
    /// values. `detail` says why.
    pub const CONVERSION_FAILED: &str = "conversion_failed";
    /// Uninstall: nothing of this item is recorded. Params: `item_id`.
    pub const NOT_INSTALLED: &str = "not_installed";

    // ── What changed since the user confirmed (`changes`) ────────────────
    /// Params: `from`, `to`.
    pub const STATUS_CHANGED: &str = "status_changed";
    /// Params: `from`, `to` (empty when absent).
    pub const RISK_CHANGED: &str = "risk_changed";
    /// Params: `from`, `to`.
    pub const REVIEWED_CHANGED: &str = "reviewed_changed";
    /// Params: `profile` (`declared`, `detected`), `field` (`runsCode`,
    /// `installs`, `installScripts`, `network`, `secrets`, `paths`,
    /// `tools`), `value`.
    pub const PERMISSION_ADDED: &str = "permission_added";
    pub const PERMISSION_REMOVED: &str = "permission_removed";
    /// Params: `severity` (`low`, `medium`, `high`), `from`, `to`.
    pub const FINDINGS_CHANGED: &str = "findings_changed";
    /// Credentials found in the package. Params: `from`, `to`.
    pub const SECRETS_FOUND_CHANGED: &str = "secrets_found_changed";
    /// The model review. Params: `from`, `to`.
    pub const REVIEW_CHANGED: &str = "review_changed";
    /// Params: `registry_type`, `identifier`.
    pub const PACKAGE_ADDED: &str = "package_added";
    pub const PACKAGE_REMOVED: &str = "package_removed";
    /// Params: `registry_type`, `identifier`, `from`, `to`.
    pub const PACKAGE_VERSION_CHANGED: &str = "package_version_changed";
    pub const VERIFICATION_CHANGED: &str = "verification_changed";
    /// Params: `registry_type`, `identifier`.
    pub const INSTALL_SCRIPT_ADDED: &str = "install_script_added";
    pub const INSTALL_SCRIPT_REMOVED: &str = "install_script_removed";
    /// The fingerprint differs, but not in anything listed above (or the
    /// state the user confirmed is no longer known to this Codeg): show the
    /// whole new snapshot.
    pub const STATE_CHANGED: &str = "state_changed";

    // ── The record write (`record.code`) ─────────────────────────────────
    pub const RECORD_WRITE_FAILED: &str = "record_write_failed";
    /// The record no longer agrees with what this install was checked
    /// against under the lock (not expected: the record is only written
    /// under the MCP write lock). Left as it is.
    pub const RECORD_CONFLICT: &str = "record_conflict";
}

/// A coded remark for a person: see [`codes`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reason {
    pub code: String,
    /// The values the message needs; omitted when there are none.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    /// Technical, untranslated; omitted when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Reason {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            params: BTreeMap::new(),
            detail: None,
        }
    }

    pub fn param(mut self, name: &str, value: impl Into<String>) -> Self {
        self.params.insert(name.to_string(), value.into());
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// How a recorded install stands in one agent's config right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalState {
    /// The entry is exactly what Codeg wrote.
    AsInstalled,
    /// The entry is there but its definition is not what Codeg wrote.
    ChangedLocally,
    /// The entry is gone. Reported once, by the scan that drops the agent
    /// from the record.
    Missing,
    /// The agent's config cannot be read: the record is kept.
    Unknown,
}

// ─── harness_mcp_plan ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanItem {
    /// Stable; what the record and `/resolve` know the item by.
    pub id: String,
    #[serde(rename = "ref")]
    pub item_ref: String,
    pub kind: Kind,
    pub title: Localized,
    pub revision: u64,
    pub version: Option<String>,
    pub published_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OptionSource {
    /// A package Codeg starts (stdio), or one that declares a remote
    /// transport of its own.
    Package,
    /// A hosted endpoint from the server's `remotes`.
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanPackage {
    pub registry_type: String,
    pub identifier: String,
    /// The version Harness pinned, as `/resolve` says now; `null` when it has
    /// none.
    pub version: Option<String>,
    /// `null` when Harness has no pin for this package.
    pub verified: Option<Verified>,
    pub has_install_script: bool,
    /// The server.json's `runtimeHint`, when it gives one.
    pub runtime: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanParameter {
    /// What `values` names it by: `env.<NAME>`, `headers.<Name>`,
    /// `variables.<name>`, `runtime_arguments.<i>`, `package_arguments.<i>`.
    pub key: String,
    /// The variable's, header's or argument's own name.
    pub name: String,
    /// `env`, `header`, `query` (a URL variable) or `arg`.
    pub location: String,
    /// As the server.json gives it (third-party text).
    pub description: Option<String>,
    pub required: bool,
    /// Mask it: marked secret, or named like a secret.
    pub secret: bool,
    /// `string`, `boolean`, `number`, `integer` or `json`.
    pub kind: String,
    pub default: Option<String>,
    pub placeholder: Option<String>,
    /// The values it may take, as the server.json lists them (`choices`);
    /// empty when any value goes.
    pub choices: Vec<String>,
    /// An installed item (an update, or managing its agents): what its own
    /// entries hold for this parameter now. `null` when none holds a value.
    pub current: Option<RecoveredValue>,
}

/// A parameter's value read back from an installed item's own entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecoveredValue {
    /// The value (in clear, secrets included, as `key.conflicts[].definition`
    /// carries them: mask it, and send it back to keep it). With
    /// `conflicting`, the first agent's.
    pub value: String,
    /// The agents whose entry holds a value for it.
    pub agents: Vec<McpAppType>,
    /// The entries disagree: different values, or some hold one and some
    /// do not.
    pub conflicting: bool,
}

/// What reading an installed item's entries back into one option found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OptionRecovery {
    /// The agents whose entry is this option's and was read.
    pub from: Vec<McpAppType>,
    /// Agents installed with this option whose entry no longer fits it
    /// (another transport or package, or not a server Codeg can describe):
    /// nothing of theirs is carried over.
    pub unmatched: Vec<McpAppType>,
    /// What an entry holds that the option's parameters cannot carry over
    /// (an update would drop it): a parameter key that could not be read
    /// back (`variables.<name>` when the address no longer fits the
    /// template, `package_arguments.<i>`), a field no parameter offers
    /// (`env.<NAME>`, `headers.<Name>`), or `args` (arguments no parameter
    /// accounts for).
    pub lost: Vec<LostValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LostValue {
    pub key: String,
    pub agents: Vec<McpAppType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanOption {
    /// What `optionId` names it by.
    pub id: String,
    pub transport: McpTransport,
    pub source: OptionSource,
    pub package: Option<PlanPackage>,
    /// What will be run or reached, with the defaults filled in. `null` when
    /// it cannot be made without the user's values.
    pub definition: Option<McpDefinition>,
    /// Remote options: the address as written, placeholders and all.
    pub url: Option<String>,
    pub parameters: Vec<PlanParameter>,
    pub blocking: Vec<Reason>,
    pub warnings: Vec<Reason>,
    /// Neither it nor the item has a blocking reason.
    pub selectable: bool,
    /// The agents ticked when this option is chosen.
    pub default_targets: Vec<McpAppType>,
    /// Of those, the ones whose entry under the default key is ticked to be
    /// replaced (an update: this item's own entries).
    pub default_replace: Vec<McpAppType>,
    /// An installed item: what its entries installed with this option hold,
    /// read back into `parameters[].current`. `null` for a first install, or
    /// when no agent was installed with this option.
    pub recovery: Option<OptionRecovery>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryOwner {
    /// This item, by the record.
    ThisItem,
    /// Another Harness item, by the record.
    OtherItem,
    /// Not from Harness: added by hand, by the agent, or by another tool.
    Elsewhere,
}

/// An entry already under a name the install may use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyConflict {
    pub key: String,
    pub agent: McpAppType,
    pub owner: EntryOwner,
    /// `other_item`: which one.
    pub item_id: Option<String>,
    pub item_ref: Option<String>,
    /// `this_item`: whether it is still as installed.
    pub state: Option<LocalState>,
    /// What a "replace" would overwrite; `null` when the entry is not a
    /// server Codeg can describe.
    pub definition: Option<McpDefinition>,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyPlan {
    /// The item's own name.
    pub name: String,
    /// The name proposed: the recorded one for an installed item, else the
    /// item's name, else `<name>-<publisher>`, else that with a number.
    pub default: String,
    /// Every agent's entry under `name` or `default`.
    pub conflicts: Vec<KeyConflict>,
    /// What every new name must match.
    pub pattern: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanAgent {
    pub agent: McpAppType,
    pub installed: Option<bool>,
    pub writable: bool,
    pub transports: Vec<McpTransport>,
    pub path: String,
    pub status: McpFileStatus,
    /// Send this back as `basis[agent]`. `null` when the file cannot be read.
    pub basis: Option<String>,
    /// The names of the servers in its config (for a name the user types).
    pub keys: Vec<String>,
    /// Why codeg cannot write it, when it cannot (`writable: false`): the
    /// inventory's `config.reason`, or `managed_by_agent` for an agent codeg
    /// only lists. `null` when it is writable.
    pub reason: Option<McpIssue>,
    /// Every server in its config, by name, with where it came from (by the
    /// record) — names only: what a "replace" of a typed name would
    /// overwrite.
    pub entries: Vec<ExistingEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExistingEntry {
    pub key: String,
    pub owner: EntryOwner,
    /// `this_item`, `other_item`: which item.
    pub item_id: Option<String>,
    pub item_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstalledAgent {
    pub agent: McpAppType,
    pub state: LocalState,
    pub revision: u64,
    pub version: Option<String>,
    pub option: String,
    pub transport: McpTransport,
    pub packages: Vec<PinnedPackageRef>,
    /// The `/resolve` fingerprint the user confirmed when installing.
    pub state_sha256: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedPackageRef {
    pub registry_type: String,
    pub identifier: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstalledItem {
    pub id: String,
    #[serde(rename = "ref")]
    pub item_ref: String,
    /// As recorded at the last install or update; `null` for one recorded
    /// before titles were kept.
    pub title: Option<Localized>,
    pub key: String,
    /// The lowest revision among its agents (what an update starts from).
    pub revision: u64,
    pub version: Option<String>,
    /// `changed_locally` if any agent is; else `as_installed` if any is;
    /// else `unknown` if any is; else `missing`.
    pub state: LocalState,
    pub agents: Vec<InstalledAgent>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HarnessMcpPlan {
    pub item: PlanItem,
    /// How the item stands, by `/resolve`.
    pub item_status: ItemStatus,
    /// The newest revision, by `/resolve` (API shape, camelCase).
    pub latest: Option<LatestVersion>,
    /// The revision's state, read fresh from `/resolve` (the API's
    /// `VersionState`, camelCase). The only source of the dialog's risk,
    /// review, permissions, checks and package verification.
    pub snapshot: Option<VersionState>,
    /// The snapshot's fingerprint: send it back as `stateSha256`.
    pub state_sha256: Option<String>,
    pub blocking: Vec<Reason>,
    /// To be confirmed explicitly before installing (`yanked`).
    pub confirm: Vec<Reason>,
    pub options: Vec<PlanOption>,
    pub default_option: Option<String>,
    pub key: KeyPlan,
    pub agents: Vec<PlanAgent>,
    /// Every readable agent's basis, as the plan saw it.
    pub basis: BTreeMap<McpAppType, String>,
    /// Set when the item is already installed (an update).
    pub installed: Option<InstalledItem>,
}

// ─── harness_mcp_install ────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessMcpInstallRequest {
    pub item_ref: String,
    pub revision: u64,
    pub option_id: String,
    /// By parameter key; empty values count as not given.
    pub values: BTreeMap<String, String>,
    pub key: String,
    pub agents: Vec<McpAppType>,
    /// Targets whose entry under `key` may be overwritten.
    pub replace: Vec<McpAppType>,
    /// The fingerprint of the snapshot the user confirmed.
    pub state_sha256: String,
    /// Per target agent, the basis the dialog showed.
    pub basis: BTreeMap<McpAppType, String>,
    /// The user confirmed installing a yanked version.
    pub accept_yanked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallOutcome {
    /// Written to every target (see `record` for the provenance record).
    Installed,
    /// The call cannot be carried out as it is (`issues`). Nothing written.
    Refused,
    /// A config file is not the one the dialog saw. Nothing written: plan
    /// again.
    ChangedElsewhere,
    /// The snapshot changed since it was confirmed (`changes`, `snapshot`,
    /// `state_sha256`). Nothing written: confirm again with the new
    /// fingerprint.
    StateChanged,
    /// The item or version can no longer be installed (`issues`,
    /// `snapshot`). Nothing written.
    Aborted,
    /// The engine refused the operations (`apply`). Nothing written.
    Invalid,
    /// The MCP write lock could not be taken. Nothing written. Retry.
    Busy,
    /// A write failed part-way; see `apply` for what was put back.
    WriteFailed,
}

/// The provenance record, after a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecordWrite {
    /// `written`, `unchanged` (the commit wrote nothing it should record) or
    /// `failed` (`code`, `detail`).
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HarnessMcpInstallResult {
    pub outcome: InstallOutcome,
    pub issues: Vec<Reason>,
    pub changes: Vec<Reason>,
    /// `state_changed`, `aborted`: the snapshot as it is now.
    pub snapshot: Option<VersionState>,
    pub state_sha256: Option<String>,
    /// The engine's result, exactly as `mcp_apply` reports it: the commit's
    /// once there was one, else the preflight's (`outcome: "preflight"`).
    pub apply: Option<McpApplyResult>,
    pub record: Option<RecordWrite>,
}

// ─── harness_installed ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HarnessInstalled {
    pub mcp: Vec<InstalledItem>,
    /// The skills installed from Harness (H3; `harness::skills`).
    pub skills: Vec<crate::harness::skills::InstalledSkill>,
    /// Why `mcp` is empty when its record cannot be read
    /// (`record_unreadable`, `detail`); `null` otherwise. Each part is
    /// listed on its own: one that cannot be read does not hide the other.
    pub mcp_problem: Option<Reason>,
    /// The same for `skills` (the skills manifest).
    pub skills_problem: Option<Reason>,
}

// ─── harness_mcp_uninstall ──────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessMcpUninstallRequest {
    pub item_id: String,
    /// Which recorded agents; all of them when absent.
    pub agents: Option<Vec<McpAppType>>,
    /// Agents whose locally changed entry may be removed too.
    pub remove_changed: Vec<McpAppType>,
    /// Per agent to remove from, the basis the preflight returned.
    pub basis: BTreeMap<McpAppType, String>,
    /// Report and check only; write nothing.
    pub preflight: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UninstallAction {
    /// The entry is removed (as installed, or changed and allowed).
    Remove,
    /// Changed locally and not in `removeChanged`: left, still recorded.
    KeepChanged,
    /// The config cannot be read: left, still recorded.
    KeepUnknown,
    /// Already gone: only the record forgets it.
    Forget,
    /// Not among `agents`: left as it is.
    NotRequested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UninstallAgent {
    pub agent: McpAppType,
    pub key: String,
    pub state: LocalState,
    pub action: UninstallAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UninstallOutcome {
    /// A preflight: nothing written; `apply` and `agents` say what would be.
    Preflight,
    Uninstalled,
    Refused,
    ChangedElsewhere,
    Invalid,
    Busy,
    WriteFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HarnessMcpUninstallResult {
    pub outcome: UninstallOutcome,
    pub issues: Vec<Reason>,
    pub agents: Vec<UninstallAgent>,
    pub apply: Option<McpApplyResult>,
    pub record: Option<RecordWrite>,
}

/// Payload of [`INSTALLED_CHANGED_EVENT`]: which items and agents, nothing
/// of what is in any config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstalledChanged {
    pub item_ids: Vec<String>,
    pub agents: Vec<McpAppType>,
}
