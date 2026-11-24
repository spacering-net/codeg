//! What the update check says, on the wire and in its file, and how it is
//! read off the records and the answers kept.
//!
//! Only ids, revisions and states: an answer keeps the item's status, the
//! asked revision's status, the latest revision with its version label and
//! the item's address now — for a plugin also whether the revision is
//! approved, the revision to install whole and its `execSha256`, and
//! whether an advisory asks for it to be switched off — never the
//! snapshot's risk, permissions, checks or packages, and never its
//! `stateSha256`. What an install decides on is read fresh by the install
//! itself (`resolve.rs`); nothing here lets one through or holds one back.
//! What switches a plugin off on an answer is `plugins::guard`.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::harness::error::HarnessError;
use crate::harness::plugins::record::{HostMode, HostState, PluginEntry};
use crate::harness::types::{Installed, ItemStatus, Resolved, VersionStatus};

/// Announced after a check that changed what the check says, and after the
/// records changed what it says (an install, an update, an uninstall).
pub const UPDATES_CHANGED_EVENT: &str = "harness://updates-changed";

/// What is installed, as the records say: item id → every revision recorded
/// for it (an MCP item can be at a different revision in each agent).
pub(crate) type InstalledRevisions = BTreeMap<String, BTreeSet<u64>>;

/// How the plugins record has each installed plugin, by item id: what its
/// update is measured against.
pub(crate) type PluginsModes = BTreeMap<String, PluginModes>;

/// How one installed plugin's agents have it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PluginModes {
    /// An agent has it as a plugin (in any state, one that will go on with
    /// its skills only at the next update included): an update goes to
    /// `full`, as the install chose it.
    pub any_native: bool,
    /// Something in it runs on its own once installed whole.
    pub autorun: bool,
    /// The `execSha256` the user agreed to.
    pub consent_exec: Option<String>,
    /// An agent Codeg switched off (`Suspended`).
    pub suspended: bool,
}

impl PluginModes {
    pub(crate) fn of(entry: &PluginEntry) -> Self {
        Self {
            any_native: entry
                .hosts
                .values()
                .any(|host| host.mode == HostMode::Native),
            autorun: !entry.autorun.is_empty(),
            consent_exec: entry.consent.as_ref().map(|consent| consent.exec.clone()),
            suspended: entry
                .hosts
                .values()
                .any(|host| matches!(host.state, HostState::Suspended { .. })),
        }
    }
}

/// The latest revision as the catalog told it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatestRevision {
    pub revision: u64,
    pub version: Option<String>,
}

/// How one installed `(item, revision)` stood when it was asked about. Kept
/// in `updates.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Answer {
    pub id: String,
    pub revision: u64,
    pub status: ItemStatus,
    /// The asked revision's own status; `None` when the item has no such
    /// revision, or the catalog does not tell (`unavailable`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_status: Option<VersionStatus>,
    /// `public` and `listed` items only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<LatestRevision>,
    /// The item's address now (`public` and `listed` only): a rename keeps
    /// the id, and an update opens the item here.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub item_ref: Option<String>,
    /// A plugin's revision (`public` and `listed` only, when the catalog
    /// told it): approved or not, which one to install whole now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<PluginAnswer>,
    /// An advisory asks for the asked revision to be switched off or taken
    /// out (action `disable` or `remove`, for it or for every revision).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disable_advisory: bool,
}

/// A plugin revision's standing, as the answer told it (`PluginState`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PluginAnswer {
    /// A person approved the asked revision to be installed whole; a field
    /// the catalog left out reads as not approved.
    pub approved: bool,
    /// The revision to install whole now (item-wide), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full: Option<LatestRevision>,
    /// What runs on its own in the asked revision, hashed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exec_sha256: Option<String>,
}

impl Answer {
    /// What is kept of `/resolve`'s answer about `asked`.
    pub(crate) fn of(asked: &Installed, resolved: Resolved) -> Self {
        let told = matches!(resolved.status, ItemStatus::Public | ItemStatus::Listed);
        let disable_advisory = resolved
            .advisories
            .iter()
            .any(|advisory| advisory.disables(asked.revision));
        let plugin = resolved
            .installed
            .as_ref()
            .and_then(|state| state.plugin.as_ref())
            .filter(|_| told)
            .map(|plugin| PluginAnswer {
                approved: plugin.approved,
                full: plugin.full.as_ref().map(|full| LatestRevision {
                    revision: full.revision,
                    version: full.version.clone(),
                }),
                exec_sha256: plugin.exec_sha256.clone(),
            });
        Self {
            id: asked.id.clone(),
            revision: asked.revision,
            status: resolved.status,
            version_status: resolved.installed.map(|state| state.status),
            latest: resolved
                .latest
                .filter(|_| told)
                .map(|latest| LatestRevision {
                    revision: latest.revision,
                    version: latest.version,
                }),
            item_ref: resolved.r#ref.filter(|_| told),
            plugin,
            disable_advisory,
        }
    }
}

/// What one installed item comes to. The order is the precedence when an
/// item's revisions come to different things (most pressing last).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    /// Nothing known: see [`UnknownReason`].
    Unknown,
    /// Every installed revision is the latest, and none is withdrawn.
    Latest,
    /// A newer revision is out.
    UpdateAvailable,
    /// An installed revision was withdrawn by its author (`yanked`).
    Yanked,
    /// A plugin installed whole somewhere: the installed revision is no
    /// longer approved (its approval was withdrawn).
    Unapproved,
    /// The item was stopped by its author or its source (`retired`).
    DisabledByAuthor,
    /// The item (`removed`) or an installed revision (`blocked`) was taken
    /// down by Harness.
    RemovedByHarness,
    /// The item is no longer on SRN (`unavailable`: deleted, made private or
    /// never out — which is not told), whatever its kind. Nothing to check
    /// any more; it can be kept or uninstalled.
    Gone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownReason {
    /// Not asked about yet: installed since the last check that got an
    /// answer, or no check has got one.
    NotChecked,
    /// Asked, and the catalog does not tell: the item is there but not the
    /// revision asked about, or a status this Codeg does not know. (An item
    /// that is not there at all is [`UpdateState::Gone`].)
    Unavailable,
}

/// What an installed plugin's update would be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePlugin {
    /// The revision an update goes to: `full` while any agent has it as a
    /// plugin, else the latest; `None` when there is none (as the catalog
    /// last told it).
    pub target: Option<LatestRevision>,
    /// The update will ask the user to agree again to what runs on its own:
    /// an agent Codeg switched off is to run it again, or nothing was agreed
    /// to. (Whether a newer target's `execSha256` differs from the one
    /// agreed to is known only from its install info: the update's plan
    /// tells.)
    pub needs_consent: bool,
    /// An agent Codeg switched off (`Suspended`): only an update turns it on
    /// again.
    pub suspended: bool,
}

/// One installed item: MCP server, skill or plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateItem {
    pub id: String,
    /// The lowest revision recorded for it: where an update starts.
    pub revision: u64,
    pub state: UpdateState,
    /// A newer revision than [`Self::revision`] is out. Also set beside
    /// `yanked` or `removed_by_harness` (a blocked revision), when there is
    /// one to move to.
    pub update_available: bool,
    /// As the catalog last told it (`public` and `listed` items).
    pub latest: Option<LatestRevision>,
    /// The item's address now, when the catalog told it.
    #[serde(rename = "ref")]
    pub item_ref: Option<String>,
    /// Why `state` is `unknown`; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unknown: Option<UnknownReason>,
    /// Plugins only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<UpdatePlugin>,
}

/// Why the last check got no answer. The answers before it are kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckError {
    /// `network`, `rate_limited`, `server`, `too_large`, `invalid_response`,
    /// `not_found`, `resolve_unavailable` (SpaceRing does not serve
    /// `/resolve`: a failed check, not items gone) or `disabled`.
    pub code: String,
    /// `rate_limited`: the pause SpaceRing asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<u64>,
    /// `server`: the HTTP status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl From<&HarnessError> for CheckError {
    fn from(error: &HarnessError) -> Self {
        let code = match error {
            HarnessError::Disabled => "disabled",
            HarnessError::Network(_) => "network",
            HarnessError::RateLimited { .. } => "rate_limited",
            HarnessError::NotFound => "not_found",
            HarnessError::InvalidRef => "invalid_ref",
            HarnessError::Server { .. } => "server",
            HarnessError::TooLarge => "too_large",
            HarnessError::InvalidResponse(_) => "invalid_response",
            HarnessError::ResolveUnavailable => "resolve_unavailable",
        };
        Self {
            code: code.to_string(),
            seconds: match error {
                HarnessError::RateLimited { seconds } => Some(*seconds),
                _ => None,
            },
            status: match error {
                HarnessError::Server { status } => Some(*status),
                _ => None,
            },
        }
    }
}

/// What `harness_updates` and `harness_check_updates` answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HarnessUpdates {
    /// `false` under `CODEG_HARNESS=off`: nothing is checked, and nothing
    /// else here is filled.
    pub enabled: bool,
    /// A check is running in this process now.
    pub checking: bool,
    /// When the answers the states come from were asked; `null` before the
    /// first check that got an answer.
    pub checked_at: Option<DateTime<Utc>>,
    /// When a check was last tried, whatever came of it.
    pub attempted_at: Option<DateTime<Utc>>,
    /// The last try got no answer; the states are still `checked_at`'s.
    pub error: Option<CheckError>,
    /// Every installed item (both records), by id.
    pub items: Vec<UpdateItem>,
    /// How many have `update_available`.
    pub count: usize,
}

impl HarnessUpdates {
    pub(crate) fn switched_off() -> Self {
        Self {
            enabled: false,
            checking: false,
            checked_at: None,
            attempted_at: None,
            error: None,
            items: Vec::new(),
            count: 0,
        }
    }
}

/// Payload of [`UPDATES_CHANGED_EVENT`]: the new count and which items
/// changed (gone, new, or with another state) — nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatesChanged {
    pub count: usize,
    pub item_ids: Vec<String>,
}

// ─── The derivation ─────────────────────────────────────────────────────

/// Whether `/resolve` can be asked about this pair: the API takes a
/// lowercase UUID and a revision from 1. A record holding anything else
/// (hand-edited, damaged) would fail the whole request, so it is not asked
/// and reads as not checked.
pub(crate) fn askable(id: &str, revision: u64) -> bool {
    let bytes = id.as_bytes();
    revision >= 1
        && bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

/// The pairs a check asks about, in a stable order.
pub(crate) fn pairs(installed: &InstalledRevisions) -> Vec<Installed> {
    installed
        .iter()
        .flat_map(|(id, revisions)| {
            revisions
                .iter()
                .filter(|revision| askable(id, **revision))
                .map(|revision| Installed {
                    id: id.clone(),
                    revision: *revision,
                })
        })
        .collect()
}

/// Whether some pair a check would ask about has no answer kept.
pub(crate) fn unanswered(installed: &InstalledRevisions, answers: &[Answer]) -> bool {
    pairs(installed).iter().any(|pair| {
        !answers
            .iter()
            .any(|answer| answer.id == pair.id && answer.revision == pair.revision)
    })
}

/// What one revision comes to.
enum Part {
    Pressing(UpdateState),
    Current,
    Behind,
    Unknown(UnknownReason),
}

/// A revision that was asked about, against `target` — the revision an
/// update goes to (the latest; `full` for a plugin an agent has whole).
/// `whole`: a plugin an agent has whole, whose installed revision must stay
/// approved.
fn answered(answer: &Answer, target: Option<&LatestRevision>, whole: bool) -> Part {
    match answer.status {
        ItemStatus::Retired => Part::Pressing(UpdateState::DisabledByAuthor),
        ItemStatus::Removed => Part::Pressing(UpdateState::RemovedByHarness),
        ItemStatus::Public | ItemStatus::Listed => match answer.version_status {
            Some(VersionStatus::Blocked) => Part::Pressing(UpdateState::RemovedByHarness),
            Some(VersionStatus::Yanked) => Part::Pressing(UpdateState::Yanked),
            Some(VersionStatus::Ok)
                if whole
                    && answer
                        .plugin
                        .as_ref()
                        .is_some_and(|plugin| !plugin.approved) =>
            {
                Part::Pressing(UpdateState::Unapproved)
            }
            Some(VersionStatus::Ok) => match target {
                Some(target) if target.revision > answer.revision => Part::Behind,
                Some(_) => Part::Current,
                None => Part::Unknown(UnknownReason::Unavailable),
            },
            // no such revision, or a status this Codeg does not know (never
            // read as `ok`)
            Some(VersionStatus::Unknown) | None => Part::Unknown(UnknownReason::Unavailable),
        },
        ItemStatus::Unavailable => Part::Pressing(UpdateState::Gone),
        // never read as anything the catalog said
        ItemStatus::Unknown => Part::Unknown(UnknownReason::Unavailable),
    }
}

/// A revision recorded since the last answer (an update, an install by
/// another Codeg), read off what that answer said of the item: under the
/// target it was told, behind; at it, current; an item stopped, taken down
/// or gone is so at every revision. Anything else waits for the next check.
fn inferred(revision: u64, told: Option<&Answer>, target: Option<&LatestRevision>) -> Part {
    let Some(told) = told else {
        return Part::Unknown(UnknownReason::NotChecked);
    };
    match told.status {
        ItemStatus::Retired => Part::Pressing(UpdateState::DisabledByAuthor),
        ItemStatus::Removed => Part::Pressing(UpdateState::RemovedByHarness),
        ItemStatus::Public | ItemStatus::Listed => match target {
            Some(target) if revision < target.revision => Part::Behind,
            Some(target) if revision == target.revision => Part::Current,
            _ => Part::Unknown(UnknownReason::NotChecked),
        },
        ItemStatus::Unavailable => Part::Pressing(UpdateState::Gone),
        ItemStatus::Unknown => Part::Unknown(UnknownReason::NotChecked),
    }
}

/// Every installed item, by id, as the answers kept say. `plugins`: how
/// the plugins record has each plugin.
pub(crate) fn derive(
    installed: &InstalledRevisions,
    plugins: &PluginsModes,
    answers: &[Answer],
) -> Vec<UpdateItem> {
    let mut by_id: BTreeMap<&str, Vec<&Answer>> = BTreeMap::new();
    for answer in answers {
        by_id.entry(answer.id.as_str()).or_default().push(answer);
    }
    installed
        .iter()
        .filter_map(|(id, revisions)| {
            let lowest = *revisions.first()?;
            let told = by_id.get(id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
            Some(item(id, lowest, revisions, told, plugins.get(id)))
        })
        .collect()
}

fn item(
    id: &str,
    lowest: u64,
    revisions: &BTreeSet<u64>,
    told: &[&Answer],
    plugin: Option<&PluginModes>,
) -> UpdateItem {
    // What the catalog said of the item as a whole: every answer of one
    // check carries it alike.
    let latest = told
        .iter()
        .filter_map(|answer| answer.latest.clone())
        .max_by_key(|latest| latest.revision);
    let full = told
        .iter()
        .filter_map(|answer| answer.plugin.as_ref()?.full.clone())
        .max_by_key(|full| full.revision);
    let item_ref = told.iter().find_map(|answer| answer.item_ref.clone());
    let about_item = told
        .iter()
        .copied()
        .find(|answer| answer.latest.is_some())
        .or_else(|| told.first().copied());
    // A plugin any agent has whole moves to `full` (the install's choice),
    // and its installed revision must stay approved; else the latest.
    let whole = plugin.is_some_and(|plugin| plugin.any_native);
    let target = if whole { full } else { latest.clone() };

    let mut pressing: Option<UpdateState> = None;
    let mut all_current = true;
    let mut unknown: Option<UnknownReason> = None;
    for revision in revisions {
        if !askable(id, *revision) {
            all_current = false;
            unknown.get_or_insert(UnknownReason::NotChecked);
            continue;
        }
        let part = match told.iter().find(|answer| answer.revision == *revision) {
            Some(answer) => answered(answer, target.as_ref(), whole),
            None => inferred(*revision, about_item, target.as_ref()),
        };
        match part {
            Part::Pressing(state) => {
                all_current = false;
                pressing = pressing.max(Some(state));
            }
            Part::Current => {}
            Part::Behind => all_current = false,
            Part::Unknown(reason) => {
                all_current = false;
                // not asked yet says more than "asked, not told"
                if unknown != Some(UnknownReason::NotChecked) {
                    unknown = Some(reason);
                }
            }
        }
    }

    let lowest_answer = told.iter().find(|answer| answer.revision == lowest);
    // A plugin Codeg switched off whose installed revision SRN vouches for
    // again (`full` back on it): the update turns it on again.
    let resumes = plugin.is_some_and(|plugin| plugin.suspended)
        && whole
        && target
            .as_ref()
            .is_some_and(|target| target.revision == lowest)
        && !lowest_answer.is_some_and(|answer| answer.disable_advisory);
    let update_available = target
        .as_ref()
        .is_some_and(|target| lowest < target.revision)
        || resumes;
    let state = match pressing {
        Some(state) => state,
        None if update_available => UpdateState::UpdateAvailable,
        None if all_current => UpdateState::Latest,
        None => UpdateState::Unknown,
    };
    let plugin = plugin.map(|modes| UpdatePlugin {
        target: target.clone(),
        needs_consent: update_available
            && whole
            && modes.autorun
            && (modes.suspended || modes.consent_exec.is_none()),
        suspended: modes.suspended,
    });
    UpdateItem {
        id: id.to_string(),
        revision: lowest,
        state,
        update_available,
        latest,
        item_ref,
        unknown: (state == UpdateState::Unknown)
            .then(|| unknown.unwrap_or(UnknownReason::NotChecked)),
        plugin,
    }
}

pub(crate) fn count(items: &[UpdateItem]) -> usize {
    items.iter().filter(|item| item.update_available).count()
}

/// What an announcement compares: per item, what the sections show of it.
pub(crate) type Summary = BTreeMap<String, (UpdateState, bool, Option<u64>, Option<UpdatePlugin>)>;

pub(crate) fn summary(items: &[UpdateItem]) -> Summary {
    items
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                (
                    item.state,
                    item.update_available,
                    item.latest.as_ref().map(|latest| latest.revision),
                    item.plugin.clone(),
                ),
            )
        })
        .collect()
}

/// The items new, gone or changed between two summaries, by id.
pub(crate) fn changed_ids(before: &Summary, after: &Summary) -> Vec<String> {
    let ids: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    ids.into_iter()
        .filter(|id| before.get(*id) != after.get(*id))
        .cloned()
        .collect()
}
