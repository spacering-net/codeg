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
//! What it does NOT hold either is the panel's remote selection: that lives in
//! [`super::remotes`], because the picker saves it on every click while this
//! blob is rewritten WHOLESALE by a dialog — and one field living in the
//! other's blob is how "use global defaults" came to destroy a choice the
//! picker had already saved.
//!
//! Stored as ONE JSON blob in `app_metadata` — the global row and every
//! override together — rather than a row per scope. The whole thing is read
//! once per page load and once per trigger, and a save is a read-modify-write
//! of a single scope, so no save ever rewrites another scope's values.

use std::collections::BTreeMap;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::db::error::DbError;
use crate::db::service::app_metadata_service;

/// `app_metadata` key holding the whole store.
const SETTINGS_KEY: &str = "forge_workbench_settings";

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
        }
    }
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
    fn apply(
        &mut self,
        folder_id: Option<i32>,
        settings: Option<ForgePanelSettings>,
    ) -> Result<(), DbError> {
        match (folder_id, settings) {
            (None, Some(settings)) => self.global = settings.normalized()?,
            (Some(id), Some(settings)) => {
                self.folders.insert(id, settings.normalized()?);
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
    store.apply(folder_id, settings)?;
    let encoded = serde_json::to_string(&store)
        .map_err(|e| DbError::Validation(format!("settings not serializable: {e}")))?;
    app_metadata_service::upsert_value(conn, SETTINGS_KEY, &encoded).await?;
    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;

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
            .apply(None, Some(with_prompts(&[("all", "Reply in English.")])))
            .expect("global");
        // Nothing of its own yet — it follows.
        assert_eq!(store.effective(7).standing_prompt("fix").as_deref(), Some("Reply in English."));

        store
            .apply(Some(7), Some(with_prompts(&[("fix", "Run the tests.")])))
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
        store.apply(None, Some(with_prompts(&[("all", "global")]))).expect("global");
        store.apply(Some(3), Some(with_prompts(&[("all", "mine")]))).expect("folder 3");
        assert_eq!(store.effective(3).standing_prompt("fix").as_deref(), Some("mine"));

        store.apply(Some(3), None).expect("follow the global row");
        assert!(!store.folders.contains_key(&3));
        assert_eq!(store.effective(3).standing_prompt("fix").as_deref(), Some("global"));
        // Idempotent: a folder that already follows stays following.
        store.apply(Some(3), None).expect("still fine");

        assert!(store.apply(None, None).is_err(), "the global row has no fallback");
    }

    /// The cap applies to a folder's own row too — a per-folder save is not a
    /// way around the limit the global row is held to.
    #[test]
    fn a_folder_save_is_validated_like_the_global_one() {
        let mut store = ForgeSettingsStore::default();
        let huge = with_prompts(&[("fix", &"x".repeat(PROMPT_CAP + 1))]);
        assert!(store.apply(Some(4), Some(huge)).is_err());
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
        store.apply(Some(42), Some(with_prompts(&[("fix", "mine")]))).expect("folder 42");
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
}
