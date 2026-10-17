//! Preferences for the Issues/PR panel: what the trigger dialog opens with,
//! and the standing instructions every task it mints carries.
//!
//! **Scoped exactly like the task settings.** There is one global row plus an
//! optional per-folder override, and an override wins WHOLESALE — saving one
//! detaches that folder from the global row entirely rather than merging field
//! by field. The rule is copied deliberately: the two dialogs sit one click
//! apart on the same workbench, and a user who has learned "this folder has its
//! own settings now" in one of them must not meet different arithmetic in the
//! other.
//!
//! What it does NOT replace is the folder's `stage_prompts` in the task
//! settings, which forge tasks receive at launch like any other work task (see
//! `engine::stage_prompt_block`). That covers a stage of a task's life; this
//! covers a KIND of work item — how an issue should be handled as opposed to a
//! review, which is a distinction the task engine has no word for.
//!
//! Stored as ONE JSON blob in `app_metadata` — the global row and every
//! override together — rather than a row per scope. The whole thing is read
//! once per page load and once per trigger, and a save is a read-modify-write
//! of a single scope, so no save ever rewrites another scope's values.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::db::error::DbError;
use crate::db::service::app_metadata_service;

/// `app_metadata` key holding the whole store.
const SETTINGS_KEY: &str = "forge_workbench_settings";

/// Bounds of the scan interval, in minutes. A day at the top because a scan
/// that runs less often than that has stopped being "automatic" in any sense
/// the setting promises; a minute at the bottom because the scan reads the
/// forge's core REST quota (5000 requests an hour on GitHub), which one
/// request a minute per repository does not dent.
pub const MIN_SCAN_INTERVAL_MINUTES: u32 = 1;
pub const MAX_SCAN_INTERVAL_MINUTES: u32 = 24 * 60;
/// What a fresh scope scans at.
pub const DEFAULT_SCAN_INTERVAL_MINUTES: u32 = 15;

/// Most patterns one rule list may hold, and the longest one pattern may be.
/// Sanity bounds on a payload, refused by name rather than trimmed — the same
/// rule the standing instructions follow.
pub const MAX_RULE_PATTERNS: usize = 100;
pub const MAX_PATTERN_CHARS: usize = 200;
/// Longest webhook secret accepted. Far above anything a forge generates.
pub const MAX_SECRET_CHARS: usize = 256;

/// Reserved [`ForgePanelSettings::scenario_prompts`] key whose text is appended
/// for EVERY scenario — the mirror of `STAGE_PROMPT_ALL`.
pub const SCENARIO_PROMPT_ALL: &str = "all";

/// Longest one standing instruction may be.
///
/// Generous, because this is the user's own prose and there is no reason to
/// make them count characters — but not unbounded: unlike a chat message this
/// text is replayed into every task the panel mints, so a pasted file would be
/// paid for on each one. Enforced on save with an error rather than a silent
/// trim; text the user typed must not disappear without being told.
pub const PROMPT_CAP: usize = 4000;

/// Preferences of one scope — the global row, or one folder's own. Every field
/// is optional in the wire form: a blob written by an older build must still
/// decode, and one written by a newer build must not stop this one from reading
/// the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgePanelSettings {
    /// Scenario the trigger dialog preselects for an ISSUE — a wire name
    /// (`fix` / `plan_first`). `None` = the built-in default.
    ///
    /// Read by the DIALOG, not by the trigger: it decides what the radio group
    /// opens on, and the request that follows always names a scenario
    /// explicitly. The backend keeps its own historical default for a request
    /// that names none, exactly as it does for the write-back answer — an
    /// absent field comes from a client that never showed the picker, and a
    /// preference it never displayed is not the choice it made.
    #[serde(default)]
    pub default_issue_scenario: Option<String>,
    /// Same, for a proposed change (`review_fix` / `review_only`).
    #[serde(default)]
    pub default_pr_scenario: Option<String>,
    /// What the trigger dialog's "comment the outcome back" switch starts as.
    /// Only the initial state: the switch is on screen every time, and what it
    /// says when the user presses Create is what gets stored on the task.
    #[serde(default = "default_writeback")]
    pub writeback_default: bool,
    /// User-authored text appended after a scenario's built-in instruction,
    /// keyed by scenario wire name plus the reserved [`SCENARIO_PROMPT_ALL`].
    /// Unknown keys are kept and ignored, so a future scenario needs no schema
    /// change (same contract as `stage_prompts`).
    #[serde(default)]
    pub scenario_prompts: BTreeMap<String, String>,
    /// Unattended handling — see [`ForgeAutoSettings`]. Scoped with the rest
    /// of the row, so a folder with its own settings has its own rules too.
    #[serde(default)]
    pub auto: ForgeAutoSettings,
}

fn default_writeback() -> bool {
    true
}

impl Default for ForgePanelSettings {
    fn default() -> Self {
        Self {
            default_issue_scenario: None,
            default_pr_scenario: None,
            writeback_default: default_writeback(),
            scenario_prompts: BTreeMap::new(),
            auto: ForgeAutoSettings::default(),
        }
    }
}

/// Auto-processing: the panel turning matching work items into tasks without
/// anyone pressing Start.
///
/// **What wakes it up** is one of two triggers, or both: a SCHEDULE (the
/// repository is scanned every `interval_minutes`) and a WEBHOOK (the forge
/// tells codeg an item changed, and the repository is scanned right away). The
/// webhook carries no item data codeg trusts — it is only a nudge, and the scan
/// that follows reads the items from the forge's own API like every other read.
/// Both on is the robust setup: the webhook for speed, the schedule to catch a
/// delivery that never arrived.
///
/// **What it picks up** is decided by the rules below, evaluated against each
/// OPEN item. Every item is handled at most once: an item that has ever had a
/// task — finished, canceled or deleted included — is never picked up again,
/// so dismissing an automatic task is a decision that sticks. Starting another
/// one by hand stays possible from the panel.
///
/// **From when** is `enabled_at`, unless `include_existing` says otherwise: an
/// item is picked up only once it is opened or updated AFTER auto-processing
/// was switched on. Switching it on over a repository with four hundred open
/// issues must not mint four hundred tasks behind the user's back — labelling
/// an old issue updates it, which is how one is pulled in on purpose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgeAutoSettings {
    /// Scan the repository on a timer.
    #[serde(default)]
    pub schedule: bool,
    /// Minutes between scheduled scans; clamped into
    /// [`MIN_SCAN_INTERVAL_MINUTES`]..=[`MAX_SCAN_INTERVAL_MINUTES`] on save.
    #[serde(default = "default_interval")]
    pub interval_minutes: u32,
    /// Scan as soon as the forge delivers a webhook for this repository.
    #[serde(default)]
    pub webhook: bool,
    /// What the forge signs its deliveries with (GitHub / Gitea: HMAC-SHA256 of
    /// the body; GitLab: sent back verbatim as `X-Gitlab-Token`). Generated on
    /// save when the webhook is on and none is set, and KEPT when the webhook
    /// is switched off — turning it back on must not invalidate the secret
    /// already pasted into the forge.
    #[serde(default)]
    pub webhook_secret: Option<String>,
    /// Pick up issues.
    #[serde(default = "default_true")]
    pub issues: bool,
    /// Pick up pull / merge requests.
    #[serde(default)]
    pub pull_requests: bool,
    /// How an automatic ISSUE task is handled — a scenario wire name, `None`
    /// for the kind's built-in default. Its own field rather than the trigger
    /// dialog's default: a task nobody looked at before it started may well
    /// deserve a more careful scenario than the one a click opens on.
    #[serde(default)]
    pub issue_scenario: Option<String>,
    /// Same, for a pull / merge request.
    #[serde(default)]
    pub pr_scenario: Option<String>,
    /// Only items carrying at least one label matching one of these. Empty =
    /// no label requirement. Patterns: case-insensitive, `*` matches any run
    /// of characters (`area/*` is "labels starting with area/").
    #[serde(default)]
    pub include_labels: Vec<String>,
    /// Never items carrying a label matching one of these. Wins over every
    /// include rule.
    #[serde(default)]
    pub exclude_labels: Vec<String>,
    /// Only items opened by an author matching one of these. Empty = anyone.
    #[serde(default)]
    pub include_authors: Vec<String>,
    /// Never items opened by an author matching one of these (`*[bot]`).
    #[serde(default)]
    pub exclude_authors: Vec<String>,
    /// Leave draft pull / merge requests alone until they are ready.
    #[serde(default = "default_true")]
    pub skip_drafts: bool,
    /// Queue the task as soon as it exists (subject to the folder's
    /// concurrency limit), rather than leaving it in To-do.
    #[serde(default = "default_true")]
    pub auto_start: bool,
    /// Comment the outcome back on the item when the task finishes. Off by
    /// default and its own switch — a thread other people read is not one to
    /// post into on a default nobody chose for THIS kind of task.
    #[serde(default)]
    pub writeback: bool,
    /// Also pick up items that were already open, untouched, before
    /// auto-processing was switched on.
    #[serde(default)]
    pub include_existing: bool,
    /// When auto-processing was last switched on for this scope. SERVER-
    /// STAMPED on save — a value sent by a client is ignored — and cleared
    /// when both triggers go off.
    #[serde(default)]
    pub enabled_at: Option<DateTime<Utc>>,
}

fn default_true() -> bool {
    true
}

fn default_interval() -> u32 {
    DEFAULT_SCAN_INTERVAL_MINUTES
}

impl Default for ForgeAutoSettings {
    fn default() -> Self {
        Self {
            schedule: false,
            interval_minutes: DEFAULT_SCAN_INTERVAL_MINUTES,
            webhook: false,
            webhook_secret: None,
            issues: true,
            pull_requests: false,
            issue_scenario: None,
            pr_scenario: None,
            include_labels: Vec::new(),
            exclude_labels: Vec::new(),
            include_authors: Vec::new(),
            exclude_authors: Vec::new(),
            skip_drafts: true,
            auto_start: true,
            writeback: false,
            include_existing: false,
            enabled_at: None,
        }
    }
}

impl ForgeAutoSettings {
    /// Whether anything can set auto-processing off. Neither trigger on means
    /// the rules are kept but nothing runs them.
    pub fn is_active(&self) -> bool {
        (self.schedule || self.webhook) && (self.issues || self.pull_requests)
    }

    /// The webhook secret, when deliveries for this scope are to be accepted.
    pub fn active_secret(&self) -> Option<&str> {
        if !self.webhook || !self.is_active() {
            return None;
        }
        self.webhook_secret
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    /// The earliest `updated_at` a scan has to look at, or `None` for "every
    /// open item" — see the type's note on `enabled_at`.
    pub fn picks_up_since(&self) -> Option<DateTime<Utc>> {
        if self.include_existing {
            None
        } else {
            self.enabled_at
        }
    }

    /// Normalize for storage. Patterns are trimmed, blanks dropped and
    /// duplicates (case-insensitively — that is how they match) removed; an
    /// oversized list or pattern is refused by name; the interval is clamped;
    /// a webhook without a secret gets one.
    fn normalized(mut self) -> Result<Self, DbError> {
        self.interval_minutes = self
            .interval_minutes
            .clamp(MIN_SCAN_INTERVAL_MINUTES, MAX_SCAN_INTERVAL_MINUTES);
        self.issue_scenario = trim_option(self.issue_scenario);
        self.pr_scenario = trim_option(self.pr_scenario);
        for (name, list) in [
            ("labels to include", &mut self.include_labels),
            ("labels to exclude", &mut self.exclude_labels),
            ("authors to include", &mut self.include_authors),
            ("authors to exclude", &mut self.exclude_authors),
        ] {
            *list = normalize_patterns(std::mem::take(list), name)?;
        }
        self.webhook_secret = trim_option(self.webhook_secret);
        if let Some(secret) = &self.webhook_secret {
            if secret.chars().count() > MAX_SECRET_CHARS {
                return Err(DbError::Validation(format!(
                    "the webhook secret is longer than {MAX_SECRET_CHARS} characters"
                )));
            }
        }
        if self.webhook && self.webhook_secret.is_none() {
            self.webhook_secret = Some(generate_secret());
        }
        Ok(self)
    }

    /// Stamp [`Self::enabled_at`] against what this scope ran under before the
    /// save. Staying on keeps the old instant — re-saving a rule must not
    /// quietly drop every item that changed since auto-processing began —
    /// while switching on starts the clock now.
    fn stamp_enabled_at(&mut self, previous: Option<&ForgeAutoSettings>, now: DateTime<Utc>) {
        if !self.is_active() {
            self.enabled_at = None;
            return;
        }
        self.enabled_at = match previous {
            Some(prev) if prev.is_active() => prev.enabled_at.or(Some(now)),
            _ => Some(now),
        };
    }
}

/// Trim, drop blanks, de-duplicate case-insensitively (first spelling wins),
/// and refuse a list or a pattern past its bound.
fn normalize_patterns(raw: Vec<String>, what: &str) -> Result<Vec<String>, DbError> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for pattern in raw {
        let pattern = pattern.trim().to_string();
        if pattern.is_empty() || !seen.insert(pattern.to_lowercase()) {
            continue;
        }
        if pattern.chars().count() > MAX_PATTERN_CHARS {
            return Err(DbError::Validation(format!(
                "a pattern in {what} is longer than {MAX_PATTERN_CHARS} characters"
            )));
        }
        out.push(pattern);
    }
    if out.len() > MAX_RULE_PATTERNS {
        return Err(DbError::Validation(format!(
            "{what} holds more than {MAX_RULE_PATTERNS} patterns"
        )));
    }
    Ok(out)
}

/// 32 random bytes, hex — the shape GitHub's own UI suggests for a secret.
fn generate_secret() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl ForgePanelSettings {
    /// The standing instruction for one scenario: the `all` text (every
    /// scenario) then that scenario's own, as one string. `None` when neither
    /// is configured — the overwhelmingly common case, and the one that must
    /// leave the composed prompt byte-identical to what it was before this
    /// setting existed.
    pub fn standing_prompt(&self, scenario: &str) -> Option<String> {
        let parts: Vec<&str> = [SCENARIO_PROMPT_ALL, scenario]
            .into_iter()
            .filter_map(|key| self.scenario_prompts.get(key))
            .map(|text| text.trim())
            .filter(|text| !text.is_empty())
            .collect();
        if parts.is_empty() {
            return None;
        }
        Some(parts.join("\n\n"))
    }

    /// Normalize for storage: trim every instruction and drop the blank ones,
    /// so an emptied box leaves no entry behind rather than an `""` the reader
    /// then has to filter anyway.
    fn normalized(mut self) -> Result<Self, DbError> {
        self.default_issue_scenario = trim_option(self.default_issue_scenario);
        self.default_pr_scenario = trim_option(self.default_pr_scenario);
        let mut prompts = BTreeMap::new();
        for (key, text) in std::mem::take(&mut self.scenario_prompts) {
            let text = text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            if text.chars().count() > PROMPT_CAP {
                return Err(DbError::Validation(format!(
                    "the standing instruction for \"{key}\" is longer than {PROMPT_CAP} characters"
                )));
            }
            prompts.insert(key, text);
        }
        self.scenario_prompts = prompts;
        self.auto = self.auto.normalized()?;
        Ok(self)
    }
}

fn trim_option(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Every scope at once: the global row, plus the folders that have their own.
///
/// The dialog needs all of it — it shows one scope while telling you whether
/// that scope is following the global one — and the page needs the global row
/// anyway to resolve whichever folder is on screen. One value, one read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgeSettingsStore {
    #[serde(default)]
    pub global: ForgePanelSettings,
    /// Keyed by folder id. A folder with no entry FOLLOWS the global row —
    /// absence is the "use the global defaults" answer, so there is no third
    /// state to keep in sync with the entry itself.
    #[serde(default)]
    pub folders: BTreeMap<i32, ForgePanelSettings>,
}

impl ForgeSettingsStore {
    /// What applies to a folder: its own settings wholesale, else the global
    /// row. Never a field-by-field blend — see the module note.
    pub fn effective(&self, folder_id: i32) -> &ForgePanelSettings {
        self.folders.get(&folder_id).unwrap_or(&self.global)
    }

    /// Apply one scope's save. Pure, so the scope rules can be tested without
    /// a database — [`save`] is this plus the read and the write.
    ///
    /// `folder_id = None` is the global row. `settings = None` DROPS a folder's
    /// own row so it follows the global one again, which is how the dialog's
    /// "use global defaults" saves.
    ///
    /// `now` stamps `auto.enabled_at`, measured against what the scope RAN
    /// UNDER before this save — for a folder that was following the global row,
    /// that is the global row. A folder detaching with auto-processing already
    /// on keeps the clock it was running on rather than restarting it.
    fn apply(
        &mut self,
        folder_id: Option<i32>,
        settings: Option<ForgePanelSettings>,
        now: DateTime<Utc>,
    ) -> Result<(), DbError> {
        match (folder_id, settings) {
            (None, Some(settings)) => {
                let mut next = settings.normalized()?;
                next.auto.stamp_enabled_at(Some(&self.global.auto), now);
                self.global = next;
            }
            (Some(id), Some(settings)) => {
                let mut next = settings.normalized()?;
                next.auto
                    .stamp_enabled_at(Some(&self.effective(id).auto), now);
                self.folders.insert(id, next);
            }
            (Some(id), None) => {
                self.folders.remove(&id);
            }
            // There is nothing behind the global row for it to fall back to,
            // so "follow the defaults" is not an answer it can give.
            (None, None) => {
                return Err(DbError::Validation(
                    "the global panel settings have nothing to fall back to".to_string(),
                ))
            }
        }
        Ok(())
    }
}

/// Read every scope. Never fails on content: a blob this build cannot parse
/// (hand-edited, or written by a future one) reads as the defaults rather than
/// taking down the page and the trigger with it.
pub async fn load(conn: &DatabaseConnection) -> Result<ForgeSettingsStore, DbError> {
    let raw = app_metadata_service::get_value(conn, SETTINGS_KEY).await?;
    Ok(raw.as_deref().and_then(decode).unwrap_or_default())
}

/// What applies to one folder — the trigger's only question.
pub async fn load_effective(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<ForgePanelSettings, DbError> {
    Ok(load(conn).await?.effective(folder_id).clone())
}

/// Decode either shape this key has held.
///
/// Discriminated on the store's own field names rather than by trying each
/// shape in turn: every field of both is defaulted, so a bare panel blob
/// deserializes into a store just fine — as an EMPTY one, silently dropping
/// the settings it holds. The marker is what stops that.
fn decode(raw: &str) -> Option<ForgeSettingsStore> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    if value.get("global").is_some() || value.get("folders").is_some() {
        return serde_json::from_value(value).ok();
    }
    // The shape this key held before the panel had scopes: one un-scoped blob,
    // which is exactly what the global row means now.
    Some(ForgeSettingsStore {
        global: serde_json::from_value(value).ok()?,
        folders: BTreeMap::new(),
    })
}

/// Write ONE scope and hand back every scope as stored.
///
/// Read-modify-write of the single blob, so a save against one scope carries
/// the others through untouched rather than replacing them with whatever the
/// saving client happened to be holding.
pub async fn save(
    conn: &DatabaseConnection,
    folder_id: Option<i32>,
    settings: Option<ForgePanelSettings>,
) -> Result<ForgeSettingsStore, DbError> {
    let mut store = load(conn).await?;
    store.apply(folder_id, settings, Utc::now())?;
    let encoded = serde_json::to_string(&store)
        .map_err(|e| DbError::Validation(format!("settings not serializable: {e}")))?;
    app_metadata_service::upsert_value(conn, SETTINGS_KEY, &encoded).await?;
    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed instant, so stamping is assertable.
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-14T08:00:00Z")
            .expect("valid instant")
            .with_timezone(&Utc)
    }

    fn with_prompts(pairs: &[(&str, &str)]) -> ForgePanelSettings {
        ForgePanelSettings {
            scenario_prompts: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ..Default::default()
        }
    }

    /// Nothing configured must compose to nothing: the trigger appends this
    /// only when it is `Some`, so `Some("")` here would put an empty section
    /// header into every prompt.
    #[test]
    fn an_unconfigured_panel_contributes_no_text() {
        let settings = ForgePanelSettings::default();
        assert_eq!(settings.standing_prompt("fix"), None);
        assert_eq!(with_prompts(&[("fix", "   ")]).standing_prompt("fix"), None);
        // Another scenario's text is not this scenario's.
        assert_eq!(with_prompts(&[("review_only", "x")]).standing_prompt("fix"), None);
    }

    /// `all` first, then the scenario's own — the reading order of a policy:
    /// what always applies, then what applies here.
    #[test]
    fn the_all_key_joins_the_scenarios_own_text() {
        let settings = with_prompts(&[("all", "Reply in English."), ("fix", "Run the tests.")]);
        assert_eq!(
            settings.standing_prompt("fix").as_deref(),
            Some("Reply in English.\n\nRun the tests.")
        );
        // A scenario with nothing of its own still gets the `all` text.
        assert_eq!(
            settings.standing_prompt("plan_first").as_deref(),
            Some("Reply in English.")
        );
    }

    /// Saving is where the blanks go, so the reader never has to know about
    /// them — and a scenario name with only whitespace typed into it does not
    /// survive as a key.
    #[test]
    fn saving_drops_blank_entries_and_trims_the_rest() {
        let settings = ForgePanelSettings {
            default_issue_scenario: Some("  plan_first ".into()),
            default_pr_scenario: Some("   ".into()),
            writeback_default: false,
            scenario_prompts: [
                ("all".to_string(), "  keep me  ".to_string()),
                ("fix".to_string(), "\n \t".to_string()),
            ]
            .into_iter()
            .collect(),
            auto: ForgeAutoSettings::default(),
        };
        let stored = settings.normalized().expect("within the cap");
        assert_eq!(stored.default_issue_scenario.as_deref(), Some("plan_first"));
        assert_eq!(stored.default_pr_scenario, None);
        assert!(!stored.writeback_default);
        assert_eq!(stored.scenario_prompts.get("all").map(String::as_str), Some("keep me"));
        assert!(!stored.scenario_prompts.contains_key("fix"));
    }

    /// Over the cap is refused, not truncated: this text rides in every task
    /// the panel mints, and silently keeping half of an instruction is worse
    /// than not keeping it at all.
    #[test]
    fn an_oversized_instruction_is_refused_by_name() {
        let settings = with_prompts(&[("review_fix", &"x".repeat(PROMPT_CAP + 1))]);
        let err = settings.normalized().expect_err("over the cap");
        assert!(err.to_string().contains("review_fix"), "{err}");
        // The boundary itself is allowed.
        assert!(with_prompts(&[("review_fix", &"x".repeat(PROMPT_CAP))])
            .normalized()
            .is_ok());
    }

    /// The cap counts CHARACTERS, not bytes — a Chinese instruction is not
    /// three times shorter than an English one.
    #[test]
    fn the_cap_counts_characters_not_bytes() {
        assert!(with_prompts(&[("all", &"提".repeat(PROMPT_CAP))])
            .normalized()
            .is_ok());
    }

    /// A folder's own row REPLACES the global one; it does not layer on top of
    /// it. The `all` text is the trap: a folder that set a scenario prompt and
    /// nothing else must not keep inheriting the global standing text, or
    /// "this folder has its own settings" would mean something different here
    /// than it does in the task settings dialog one click away.
    #[test]
    fn a_folders_own_settings_replace_the_global_row_wholesale() {
        let mut store = ForgeSettingsStore::default();
        store
            .apply(None, Some(with_prompts(&[("all", "Reply in English.")])), now())
            .expect("global");
        // Nothing of its own yet — it follows.
        assert_eq!(store.effective(7).standing_prompt("fix").as_deref(), Some("Reply in English."));

        store
            .apply(Some(7), Some(with_prompts(&[("fix", "Run the tests.")])), now())
            .expect("folder 7");
        assert_eq!(store.effective(7).standing_prompt("fix").as_deref(), Some("Run the tests."));
        // Every other folder is untouched by folder 7's save.
        assert_eq!(store.effective(8).standing_prompt("fix").as_deref(), Some("Reply in English."));
    }

    /// "Use the global defaults" is a DELETE, and the global row is the one
    /// scope that cannot give that answer.
    #[test]
    fn dropping_a_folders_row_puts_it_back_on_the_global_one() {
        let mut store = ForgeSettingsStore::default();
        store.apply(None, Some(with_prompts(&[("all", "global")])), now()).expect("global");
        store.apply(Some(3), Some(with_prompts(&[("all", "mine")])), now()).expect("folder 3");
        assert_eq!(store.effective(3).standing_prompt("fix").as_deref(), Some("mine"));

        store.apply(Some(3), None, now()).expect("follow the global row");
        assert!(!store.folders.contains_key(&3));
        assert_eq!(store.effective(3).standing_prompt("fix").as_deref(), Some("global"));
        // Idempotent: a folder that already follows stays following.
        store.apply(Some(3), None, now()).expect("still fine");

        assert!(store.apply(None, None, now()).is_err(), "the global row has no fallback");
    }

    /// The cap applies to a folder's own row too — a per-folder save is not a
    /// way around the limit the global row is held to.
    #[test]
    fn a_folder_save_is_validated_like_the_global_one() {
        let mut store = ForgeSettingsStore::default();
        let huge = with_prompts(&[("fix", &"x".repeat(PROMPT_CAP + 1))]);
        assert!(store.apply(Some(4), Some(huge), now()).is_err());
        // Refused, not half-applied.
        assert!(store.folders.is_empty());
    }

    /// A blob from an older build carries none of the newer fields, and one
    /// from a newer build carries fields this one has never heard of. Both
    /// must decode — the second is what a user gets by downgrading.
    #[test]
    fn stored_blobs_decode_across_versions() {
        let empty = decode("{}").expect("decodes");
        assert_eq!(empty, ForgeSettingsStore::default());
        // The write-back default is the one field whose absence must NOT read
        // as `false`: this is the switch's starting position, and the build
        // that shipped before this setting existed started it on.
        assert!(empty.global.writeback_default);

        let future = decode(
            r#"{"global":{"writeback_default":false,"scenario_prompts":{"fix":"a"}},
                "folders":{"12":{"scenario_prompts":{"fix":"b"}}},"auto_label":true}"#,
        )
        .expect("unknown fields are ignored");
        assert!(!future.global.writeback_default);
        assert_eq!(future.effective(1).standing_prompt("fix").as_deref(), Some("a"));
        assert_eq!(future.effective(12).standing_prompt("fix").as_deref(), Some("b"));

        // The shape this key held before scopes existed. It has none of the
        // store's field names, so it has to be recognized by their ABSENCE —
        // read as a store it would decode to an empty one and quietly discard
        // settings the user had saved.
        let legacy =
            decode(r#"{"writeback_default":false,"scenario_prompts":{"all":"Reply in zh."}}"#)
                .expect("the un-scoped shape still decodes");
        assert!(!legacy.global.writeback_default);
        assert!(legacy.folders.is_empty());
        assert_eq!(legacy.effective(9).standing_prompt("fix").as_deref(), Some("Reply in zh."));

        // Anything that is not JSON at all is the defaults, not an error.
        assert!(decode("not json").is_none());
    }

    /// Folder ids survive the round trip as ids. JSON has no integer keys, so
    /// they go out as strings — and a store that could not read its own output
    /// would lose every override on the next load.
    #[test]
    fn folder_keys_survive_the_json_round_trip() {
        let mut store = ForgeSettingsStore::default();
        store.apply(Some(42), Some(with_prompts(&[("fix", "mine")])), now()).expect("folder 42");
        let encoded = serde_json::to_string(&store).expect("serializable");
        assert!(encoded.contains("\"42\""), "{encoded}");
        assert_eq!(decode(&encoded).expect("decodes"), store);
    }

    /// Through a real database, because [`save`] is a READ-MODIFY-WRITE: the
    /// pure tests above prove the arithmetic, and this proves the load and the
    /// store are the same blob — one key typo and every save would land on
    /// something the next load never reads.
    #[tokio::test]
    async fn scopes_persist_independently_across_saves() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;

        // Nothing stored is the defaults, not an error.
        assert_eq!(load(&db.conn).await.expect("empty"), ForgeSettingsStore::default());

        save(&db.conn, None, Some(with_prompts(&[("all", "global")])))
            .await
            .expect("global");
        save(&db.conn, Some(2), Some(with_prompts(&[("all", "folder two")])))
            .await
            .expect("folder 2");
        // Saving folder 2 must not have taken the global row with it, and a
        // third folder still follows.
        let store = load(&db.conn).await.expect("reload");
        assert_eq!(store.effective(2).standing_prompt("fix").as_deref(), Some("folder two"));
        assert_eq!(store.effective(3).standing_prompt("fix").as_deref(), Some("global"));
        assert_eq!(
            load_effective(&db.conn, 2).await.expect("effective"),
            *store.effective(2)
        );

        // A refused save leaves storage exactly as it was.
        let huge = with_prompts(&[("fix", &"x".repeat(PROMPT_CAP + 1))]);
        save(&db.conn, Some(2), Some(huge)).await.expect_err("over the cap");
        assert_eq!(load(&db.conn).await.expect("unchanged"), store);

        save(&db.conn, Some(2), None).await.expect("follow the global row");
        assert_eq!(
            load_effective(&db.conn, 2).await.expect("effective").standing_prompt("fix").as_deref(),
            Some("global")
        );
    }

    /// The upgrade path: a blob written before the panel had scopes is already
    /// sitting under this key. It must be READ as the global row, and the next
    /// save must carry it forward rather than write an empty store over it —
    /// the one way this change could silently discard a user's settings.
    #[tokio::test]
    async fn a_legacy_blob_becomes_the_global_row_and_survives_the_next_save() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(
            &db.conn,
            SETTINGS_KEY,
            r#"{"writeback_default":false,"scenario_prompts":{"all":"Reply in zh."}}"#,
        )
        .await
        .expect("seed the old shape");

        assert_eq!(
            load_effective(&db.conn, 5).await.expect("read").standing_prompt("fix").as_deref(),
            Some("Reply in zh.")
        );

        // A save aimed at ONE FOLDER must not disturb what the legacy blob was
        // saying for everyone else.
        let store = save(&db.conn, Some(5), Some(with_prompts(&[("all", "mine")])))
            .await
            .expect("folder 5");
        assert!(!store.global.writeback_default);
        assert_eq!(store.effective(6).standing_prompt("fix").as_deref(), Some("Reply in zh."));
        assert_eq!(load(&db.conn).await.expect("reload"), store);
    }

    fn auto_on(schedule: bool, webhook: bool) -> ForgeAutoSettings {
        ForgeAutoSettings {
            schedule,
            webhook,
            ..Default::default()
        }
    }

    fn with_auto(auto: ForgeAutoSettings) -> ForgePanelSettings {
        ForgePanelSettings {
            auto,
            ..Default::default()
        }
    }

    fn later(minutes: i64) -> DateTime<Utc> {
        now() + chrono::Duration::minutes(minutes)
    }

    /// A scope nobody has touched runs nothing, and when it is switched on it
    /// starts from the cautious side of every choice: issues only, drafts
    /// left alone, no comment posted on anyone's thread, no backlog swept up.
    #[test]
    fn auto_processing_ships_off_and_cautious() {
        let auto = ForgeAutoSettings::default();
        assert!(!auto.is_active());
        assert!(auto.issues && !auto.pull_requests);
        assert!(auto.skip_drafts);
        assert!(auto.auto_start);
        assert!(!auto.writeback, "an unattended task must not post by default");
        assert!(!auto.include_existing, "switching on must not sweep the backlog");
        assert_eq!(auto.interval_minutes, DEFAULT_SCAN_INTERVAL_MINUTES);
        assert_eq!(auto.active_secret(), None);

        // On, but with nothing to pick up, is still off.
        let nothing = ForgeAutoSettings {
            schedule: true,
            issues: false,
            pull_requests: false,
            ..Default::default()
        };
        assert!(!nothing.is_active());
    }

    /// Patterns are matched case-insensitively, so two spellings of one
    /// pattern are one pattern — and blanks are what an emptied chip leaves.
    #[test]
    fn auto_rules_are_trimmed_deduplicated_and_the_interval_clamped() {
        let stored = ForgeAutoSettings {
            include_labels: vec!["  bug ".into(), "BUG".into(), "".into(), "area/*".into()],
            exclude_authors: vec!["*[bot]".into(), "  ".into()],
            interval_minutes: 0,
            issue_scenario: Some("  plan_first ".into()),
            pr_scenario: Some("   ".into()),
            ..Default::default()
        }
        .normalized()
        .expect("valid");
        assert_eq!(stored.include_labels, vec!["bug".to_string(), "area/*".to_string()]);
        assert_eq!(stored.exclude_authors, vec!["*[bot]".to_string()]);
        assert_eq!(stored.interval_minutes, MIN_SCAN_INTERVAL_MINUTES);
        assert_eq!(stored.issue_scenario.as_deref(), Some("plan_first"));
        assert_eq!(stored.pr_scenario, None);

        let slow = ForgeAutoSettings {
            interval_minutes: 99_999,
            ..Default::default()
        }
        .normalized()
        .expect("valid");
        assert_eq!(slow.interval_minutes, MAX_SCAN_INTERVAL_MINUTES);
    }

    /// Past the bounds is refused, naming which list — not trimmed, which
    /// would silently stop applying a rule the user can still see.
    #[test]
    fn oversized_rule_lists_are_refused_by_name() {
        let long = ForgeAutoSettings {
            exclude_labels: vec!["x".repeat(MAX_PATTERN_CHARS + 1)],
            ..Default::default()
        };
        let err = long.normalized().expect_err("too long");
        assert!(err.to_string().contains("labels to exclude"), "{err}");

        let many = ForgeAutoSettings {
            include_authors: (0..=MAX_RULE_PATTERNS).map(|i| format!("user{i}")).collect(),
            ..Default::default()
        };
        let err = many.normalized().expect_err("too many");
        assert!(err.to_string().contains("authors to include"), "{err}");
    }

    /// Switching the webhook on mints a secret; switching it off keeps it, so
    /// the one already pasted into the forge still verifies when it comes
    /// back on. A secret the user typed is theirs and survives as typed.
    #[test]
    fn a_webhook_gets_a_secret_and_keeps_it_across_toggles() {
        let on = auto_on(false, true).normalized().expect("valid");
        let secret = on.webhook_secret.clone().expect("generated");
        assert_eq!(secret.len(), 64);
        assert!(secret.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(on.active_secret(), Some(secret.as_str()));

        let off = ForgeAutoSettings {
            webhook: false,
            ..on.clone()
        }
        .normalized()
        .expect("valid");
        assert_eq!(off.webhook_secret.as_deref(), Some(secret.as_str()));
        assert_eq!(off.active_secret(), None, "off means deliveries are refused");

        let mine = ForgeAutoSettings {
            webhook_secret: Some("  my-own-secret  ".into()),
            ..auto_on(false, true)
        }
        .normalized()
        .expect("valid");
        assert_eq!(mine.webhook_secret.as_deref(), Some("my-own-secret"));

        // Two fresh secrets are not the same secret.
        let again = auto_on(false, true).normalized().expect("valid");
        assert_ne!(again.webhook_secret, on.webhook_secret);
    }

    /// The clock starts when auto-processing is switched ON, survives every
    /// later save while it stays on — otherwise editing a rule would drop
    /// every item that changed since — and stops when it goes off. A client
    /// cannot set it.
    #[test]
    fn enabled_at_is_stamped_on_switch_on_and_kept_while_on() {
        let mut store = ForgeSettingsStore::default();
        let claimed = ForgeAutoSettings {
            enabled_at: Some(later(-9999)),
            ..auto_on(true, false)
        };
        store.apply(None, Some(with_auto(claimed)), now()).expect("on");
        assert_eq!(store.global.auto.enabled_at, Some(now()), "a client's claim is ignored");

        let mut edited = auto_on(true, false);
        edited.include_labels = vec!["bug".into()];
        store.apply(None, Some(with_auto(edited)), later(30)).expect("edited");
        assert_eq!(store.global.auto.enabled_at, Some(now()), "re-saving restarted the clock");

        // Swapping one trigger for the other is still "on".
        store
            .apply(None, Some(with_auto(auto_on(false, true))), later(60))
            .expect("webhook instead");
        assert_eq!(store.global.auto.enabled_at, Some(now()));

        store
            .apply(None, Some(with_auto(ForgeAutoSettings::default())), later(90))
            .expect("off");
        assert_eq!(store.global.auto.enabled_at, None);

        store
            .apply(None, Some(with_auto(auto_on(true, false))), later(120))
            .expect("on again");
        assert_eq!(store.global.auto.enabled_at, Some(later(120)));
    }

    /// A folder detaching from a global row that already runs keeps that
    /// row's clock — it was being processed all along. One detaching from an
    /// idle global row starts its own.
    #[test]
    fn a_detaching_folder_inherits_the_clock_it_ran_under() {
        let mut store = ForgeSettingsStore::default();
        store
            .apply(None, Some(with_auto(auto_on(true, false))), now())
            .expect("global on");
        store
            .apply(Some(5), Some(with_auto(auto_on(true, true))), later(10))
            .expect("folder 5 detaches");
        assert_eq!(store.effective(5).auto.enabled_at, Some(now()));

        let mut idle = ForgeSettingsStore::default();
        idle.apply(Some(6), Some(with_auto(auto_on(true, false))), later(10))
            .expect("folder 6 switches on");
        assert_eq!(idle.effective(6).auto.enabled_at, Some(later(10)));
        // And the global row it detached from is untouched by that.
        assert_eq!(idle.global.auto.enabled_at, None);
    }

    /// "From when" is the clock, unless the backlog was asked for.
    #[test]
    fn the_pick_up_window_follows_include_existing() {
        let auto = ForgeAutoSettings {
            enabled_at: Some(now()),
            ..auto_on(true, false)
        };
        assert_eq!(auto.picks_up_since(), Some(now()));
        let all = ForgeAutoSettings {
            include_existing: true,
            ..auto
        };
        assert_eq!(all.picks_up_since(), None);
    }

    /// Every blob written before auto-processing existed has no `auto` block,
    /// and must read as auto-processing OFF — never as whatever a partial
    /// block would default to.
    #[test]
    fn blobs_without_an_auto_block_read_as_off() {
        let store = decode(r#"{"global":{"writeback_default":true,"scenario_prompts":{}}}"#)
            .expect("decodes");
        assert_eq!(store.global.auto, ForgeAutoSettings::default());
        assert!(!store.global.auto.is_active());

        // A partial block keeps its own values and defaults the rest.
        let partial =
            decode(r#"{"global":{"auto":{"schedule":true,"exclude_labels":["wontfix"]}}}"#)
                .expect("decodes");
        assert!(partial.global.auto.schedule);
        assert!(partial.global.auto.issues);
        assert_eq!(partial.global.auto.interval_minutes, DEFAULT_SCAN_INTERVAL_MINUTES);
        assert_eq!(partial.global.auto.exclude_labels, vec!["wontfix".to_string()]);
    }
}
