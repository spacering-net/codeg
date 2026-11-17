//! What the update check says, on the wire and in its file, and how it is
//! read off the records and the answers kept.
//!
//! Only ids, revisions and states: an answer keeps the item's status, the
//! asked revision's status, the latest revision with its version label and
//! the item's address now — never the snapshot's risk, permissions, checks
//! or packages, and never its `stateSha256`. What an install decides on is
//! read fresh by the install itself (`resolve.rs`); nothing here lets one
//! through or holds one back.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::harness::error::HarnessError;
use crate::harness::types::{Installed, ItemStatus, Resolved, VersionStatus};

/// Announced after a check that changed what the check says, and after the
/// records changed what it says (an install, an update, an uninstall).
pub const UPDATES_CHANGED_EVENT: &str = "harness://updates-changed";

/// What is installed, as the records say: item id → every revision recorded
/// for it (an MCP item can be at a different revision in each agent).
pub(crate) type InstalledRevisions = BTreeMap<String, BTreeSet<u64>>;

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
}

impl Answer {
    /// What is kept of `/resolve`'s answer about `asked`.
    pub(crate) fn of(asked: &Installed, resolved: Resolved) -> Self {
        let told = matches!(resolved.status, ItemStatus::Public | ItemStatus::Listed);
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
    /// The item was stopped by its author or its source (`retired`).
    DisabledByAuthor,
    /// The item (`removed`) or an installed revision (`blocked`) was taken
    /// down by Harness.
    RemovedByHarness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownReason {
    /// Not asked about yet: installed since the last check that got an
    /// answer, or no check has got one.
    NotChecked,
    /// Asked, and the catalog does not tell: not out, private, no such item
    /// or revision, or a status this Codeg does not know.
    Unavailable,
}

/// One installed item, MCP server or skill.
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

/// A revision that was asked about.
fn answered(answer: &Answer) -> Part {
    match answer.status {
        ItemStatus::Retired => Part::Pressing(UpdateState::DisabledByAuthor),
        ItemStatus::Removed => Part::Pressing(UpdateState::RemovedByHarness),
        ItemStatus::Public | ItemStatus::Listed => match answer.version_status {
            Some(VersionStatus::Blocked) => Part::Pressing(UpdateState::RemovedByHarness),
            Some(VersionStatus::Yanked) => Part::Pressing(UpdateState::Yanked),
            Some(VersionStatus::Ok) => match &answer.latest {
                Some(latest) if latest.revision > answer.revision => Part::Behind,
                Some(_) => Part::Current,
                None => Part::Unknown(UnknownReason::Unavailable),
            },
            // no such revision, or a status this Codeg does not know (never
            // read as `ok`)
            Some(VersionStatus::Unknown) | None => Part::Unknown(UnknownReason::Unavailable),
        },
        ItemStatus::Unavailable | ItemStatus::Unknown => Part::Unknown(UnknownReason::Unavailable),
    }
}

/// A revision recorded since the last answer (an update, an install by
/// another Codeg), read off what that answer said of the item: under the
/// latest revision it was told, behind; at it, current; an item stopped or
/// taken down is so at every revision. Anything else waits for the next
/// check.
fn inferred(revision: u64, told: Option<&Answer>) -> Part {
    let Some(told) = told else {
        return Part::Unknown(UnknownReason::NotChecked);
    };
    match told.status {
        ItemStatus::Retired => Part::Pressing(UpdateState::DisabledByAuthor),
        ItemStatus::Removed => Part::Pressing(UpdateState::RemovedByHarness),
        ItemStatus::Public | ItemStatus::Listed => match &told.latest {
            Some(latest) if revision < latest.revision => Part::Behind,
            Some(latest) if revision == latest.revision => Part::Current,
            _ => Part::Unknown(UnknownReason::NotChecked),
        },
        ItemStatus::Unavailable | ItemStatus::Unknown => Part::Unknown(UnknownReason::NotChecked),
    }
}

/// Every installed item, by id, as the answers kept say.
pub(crate) fn derive(installed: &InstalledRevisions, answers: &[Answer]) -> Vec<UpdateItem> {
    let mut by_id: BTreeMap<&str, Vec<&Answer>> = BTreeMap::new();
    for answer in answers {
        by_id.entry(answer.id.as_str()).or_default().push(answer);
    }
    installed
        .iter()
        .filter_map(|(id, revisions)| {
            let lowest = *revisions.first()?;
            let told = by_id.get(id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
            Some(item(id, lowest, revisions, told))
        })
        .collect()
}

fn item(id: &str, lowest: u64, revisions: &BTreeSet<u64>, told: &[&Answer]) -> UpdateItem {
    // What the catalog said of the item as a whole: every answer of one
    // check carries it alike.
    let latest = told
        .iter()
        .filter_map(|answer| answer.latest.clone())
        .max_by_key(|latest| latest.revision);
    let item_ref = told.iter().find_map(|answer| answer.item_ref.clone());
    let about_item = told
        .iter()
        .copied()
        .find(|answer| answer.latest.is_some())
        .or_else(|| told.first().copied());

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
            Some(answer) => answered(answer),
            None => inferred(*revision, about_item),
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

    let update_available = latest
        .as_ref()
        .is_some_and(|latest| lowest < latest.revision);
    let state = match pressing {
        Some(state) => state,
        None if update_available => UpdateState::UpdateAvailable,
        None if all_current => UpdateState::Latest,
        None => UpdateState::Unknown,
    };
    UpdateItem {
        id: id.to_string(),
        revision: lowest,
        state,
        update_available,
        latest,
        item_ref,
        unknown: (state == UpdateState::Unknown)
            .then(|| unknown.unwrap_or(UnknownReason::NotChecked)),
    }
}

pub(crate) fn count(items: &[UpdateItem]) -> usize {
    items.iter().filter(|item| item.update_available).count()
}

/// What an announcement compares: per item, what the sections show of it.
pub(crate) type Summary = BTreeMap<String, (UpdateState, bool, Option<u64>)>;

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
