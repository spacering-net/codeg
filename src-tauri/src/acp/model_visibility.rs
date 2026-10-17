//! WHICH of the model rows an agent advertises codeg shows the user.
//!
//! The agent's own list is the source of truth for what can RUN: OpenCode and
//! pi already filter what they advertise against every credential and config
//! source they know (measured 2026-10-16 — a bare machine sees only the free
//! Zen models, and neither agent ever lists the whole models.dev catalog), so
//! codeg does NOT re-derive availability: it has fewer facts than the agent,
//! and an inference built here can only hide rows the agent considers fine.
//!
//! The one display-side opinion codeg DOES honor is the user's own: the
//! OpenCode desktop app's model page carries per-model show/hide toggles,
//! persisted in its `drafts.sqlite` (`state` row `opencode.global.dat` /
//! `model`). That is a direct statement of "these I want to see", so for the
//! OpenCode agent a provider the desktop has toggles for is opt-in — only its
//! `show` rows (plus the session's current value) survive — and a provider
//! without toggles travels untouched. pi has no desktop companion and already
//! self-filters its advertised list → unfiltered.
//!
//! Design invariants:
//!
//! - The snapshot is taken ONCE per launch (`compute`, stored on
//!   `SessionState::model_availability` at spawn). The desktop app is not
//!   watched; a fresh connect re-reads its state.
//! - Filtering is applied at the single emit choke point
//!   (`connection::emit_session_config_options_values`), so the composer, the
//!   `/`-grouped model picker and the delegation "default model" probe all read
//!   one list — while every DECISION path (the wire `set`, preference replay,
//!   retirement healing) keeps reading the agent's raw list.
//! - Only the model option is ever touched (`is_model_config_option`'s dual
//!   signal, same as the connection's); `thought_level`/`mode`/`fast`/… travel
//!   byte-for-byte.
//! - The row whose value equals `currentValue` is always kept, even when the
//!   desktop toggled it `hide` — the session IS on that model, and hiding it
//!   would make the composer show something the conversation is not running.
//!   No fallback, no silent `set`.
//! - Fail-soft in every direction: no desktop state (CLI-only machine), an
//!   unreadable or locked db, an absent row, unexpected JSON, or an empty
//!   opinion set all collapse into [`ModelAvailability::Unfiltered`]. Toggle
//!   entries with a visibility that is neither `"show"` nor `"hide"` (a future
//!   value) are skipped whole — no opinion, no shown row — rather than guessed
//!   into either bucket.
//! - And the selector-level guard: if filtering would leave the model select
//!   with zero rows, the WHOLE original list is put back. An empty selector
//!   means the policy misread the shape, never that the user has nothing to
//!   select.
//!
//! Deliberately out of scope: re-implementing the agents' own availability
//! rules (environment variables, stored accounts, project configs, local
//! servers — the agent's list already reflects them, and the long-term fix for
//! oversized lists belongs in the agents' own broadcast); and filtering any
//! agent but OpenCode (zcode filters upstream; the others read their list off
//! the account that credentials them; custom agents are never second-guessed).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelect,
    SessionConfigSelectGroup, SessionConfigSelectOption, SessionConfigSelectOptions,
};

use crate::models::agent::AgentType;

/// The conventional id of a model selector. ACP reserves none — `category:
/// "model"` is the spec-level signal — but every agent codeg drives spells the
/// id this way, and the frontend accepts either. Mirror of connection.rs's
/// `MODEL_CONFIG_OPTION_ID`.
const MODEL_CONFIG_OPTION_ID: &str = "model";

/// Per-launch model visibility for one connection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ModelAvailability {
    /// No policy for this agent (or the policy failed soft): every advertised
    /// row travels as-is.
    #[default]
    Unfiltered,
    /// A restricted view, built from the OpenCode desktop's per-model toggles;
    /// applied only at the emit path.
    Restricted(RestrictedAvailability),
}

/// The keep-rules behind [`ModelAvailability::Restricted`].
///
/// A row's provider is the segment before the first `/` of its value
/// (`vercel/anthropic/claude-x` → `vercel`; same meaning as the frontend's
/// group prefix). A row is kept when:
///
/// - its value equals the select's `currentValue` (constant rule, not a field —
///   it needs the option, not the policy) — even when the desktop toggled that
///   row `hide`, or
/// - its exact value is in [`Self::shown_models`] (the desktop's per-row
///   `show`), or
/// - its value has no `/` at all, so it cannot be attributed to a toggled
///   provider (fail-open), or
/// - its provider is NOT in [`Self::opinionated_providers`] — the desktop has
///   no word on it, so the agent's own list stands.
///
/// Otherwise it is dropped: a provider with desktop toggles is opt-in, and its
/// non-shown rows are exactly what the user asked to stop seeing.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RestrictedAvailability {
    /// Providers the OpenCode desktop's model page has at least one toggle
    /// entry (`show` or `hide`) for. For these, visibility is opt-in — only
    /// [`Self::shown_models`] rows survive. Providers not in here are
    /// untouched; the agent's list stands for them.
    pub opinionated_providers: HashSet<String>,
    /// Exact row values (`providerID/modelID`) the desktop marks `show`.
    pub shown_models: HashSet<String>,
}

/// The availability policy for a launch of `agent_type`. Called once per
/// spawn; the only IO is the desktop state read.
pub fn compute(agent_type: AgentType) -> ModelAvailability {
    match agent_type {
        AgentType::OpenCode => desktop_availability(read_desktop_visibility()),
        // pi and every other built-in: the agent's list stands. pi self-filters
        // via its own availability snapshot; Claude/Gemini/Grok/Qoder/
        // CodeBuddy-family/Antigravity/DeepSeek/OpenClaw/Hermes read their list
        // off the same account the credentials open; Codex/Kimi/Cursor/Cline
        // fail closed before listing anything unauthenticated. Custom agents:
        // the bridge filters upstream; never second-guess it here.
        _ => ModelAvailability::Unfiltered,
    }
}

/// The OpenCode policy: the desktop app's model page is the only display-side
/// fact source. `None` (no state, unreadable db, absent row, empty opinion
/// set) → [`ModelAvailability::Unfiltered`] — this source never has the
/// authority to hide anything on its own failure.
fn desktop_availability(visibility: Option<DesktopVisibility>) -> ModelAvailability {
    let Some(visibility) = visibility else {
        return ModelAvailability::Unfiltered;
    };
    tracing::debug!(
        "[ACP] opencode desktop visibility applied: {} opinionated provider(s), {} shown model(s)",
        visibility.providers_with_opinions.len(),
        visibility.shown.len()
    );
    ModelAvailability::Restricted(RestrictedAvailability {
        opinionated_providers: visibility.providers_with_opinions,
        shown_models: visibility.shown,
    })
}

/// Apply the policy to an advertised config-option list. `Unfiltered` returns
/// the list untouched; a `Restricted` policy rewrites only the model SELECT —
/// every other option, and every non-select model option, passes through
/// exactly.
pub fn filter_model_options(
    availability: &ModelAvailability,
    config_options: Vec<SessionConfigOption>,
) -> Vec<SessionConfigOption> {
    let ModelAvailability::Restricted(policy) = availability else {
        return config_options;
    };

    let original = config_options.clone();
    let mut emptied_model_select = false;
    let filtered: Vec<SessionConfigOption> = config_options
        .into_iter()
        .map(|option| filter_config_option(policy, option, &mut emptied_model_select))
        .collect();

    // The zero-row guard: a model selector with nothing left in it means the
    // policy misread this agent's shape (not that the user has no choices), so
    // the whole original list goes back — all options, unfiltered.
    if emptied_model_select {
        return original;
    }
    filtered
}

/// Rewrite one option. Non-model options and non-select model options return
/// unchanged. Sets `emptied` when a model select lost every row (the caller
/// reverts the whole list then).
fn filter_config_option(
    policy: &RestrictedAvailability,
    mut option: SessionConfigOption,
    emptied: &mut bool,
) -> SessionConfigOption {
    if !is_model_config_option(&option) {
        return option;
    }
    // Build the replacement first (shared borrow), so the fall-out paths can
    // move `option` back out untouched.
    let replacement = match &option.kind {
        SessionConfigKind::Select(select) => Some((
            select.current_value.clone(),
            filter_select_options(policy, select),
        )),
        _ => None,
    };
    let Some((current_value, filtered_options)) = replacement else {
        return option;
    };
    if select_row_count(&filtered_options) == 0 {
        *emptied = true;
        return option;
    }
    option.kind =
        SessionConfigKind::Select(agent_client_protocol::schema::v1::SessionConfigSelect::new(
            current_value,
            filtered_options,
        ));
    option
}

/// Whether an advertised option IS the agent's model selector — the
/// `category` signal or the conventional `model` id, the same pair
/// connection.rs's `is_model_config_option` checks (kept as the module's own
/// twin so the policy is self-contained).
fn is_model_config_option(option: &SessionConfigOption) -> bool {
    matches!(option.category, Some(SessionConfigOptionCategory::Model))
        || option.id.to_string() == MODEL_CONFIG_OPTION_ID
}

/// Filter a select's option set: flat rows one by one, grouped rows per group
/// with emptied groups dropped (a bare group header with no rows under it
/// renders as a broken control).
fn filter_select_options(
    policy: &RestrictedAvailability,
    select: &SessionConfigSelect,
) -> SessionConfigSelectOptions {
    let current_value = select.current_value.to_string();
    match &select.options {
        SessionConfigSelectOptions::Ungrouped(rows) => {
            SessionConfigSelectOptions::Ungrouped(filter_rows(policy, &current_value, rows))
        }
        SessionConfigSelectOptions::Grouped(groups) => SessionConfigSelectOptions::Grouped(
            groups
                .iter()
                .filter_map(|group| {
                    let rows = filter_rows(policy, &current_value, &group.options);
                    if rows.is_empty() {
                        return None;
                    }
                    Some(
                        SessionConfigSelectGroup::new(
                            group.group.clone(),
                            group.name.clone(),
                            rows,
                        )
                        .meta(group.meta.clone()),
                    )
                })
                .collect(),
        ),
        // non_exhaustive: a future select shape is passed through unchanged
        // (fail-open — we cannot judge rows we do not understand).
        other => other.clone(),
    }
}

fn filter_rows(
    policy: &RestrictedAvailability,
    current_value: &str,
    rows: &[SessionConfigSelectOption],
) -> Vec<SessionConfigSelectOption> {
    rows.iter()
        .filter(|row| row_is_kept(policy, current_value, &row.value.to_string()))
        .cloned()
        .collect()
}

/// The keep decision for ONE row value. See [`RestrictedAvailability`] for the
/// contract and each fail-open case.
fn row_is_kept(policy: &RestrictedAvailability, current_value: &str, value: &str) -> bool {
    if value == current_value {
        return true;
    }
    if policy.shown_models.contains(value) {
        return true;
    }
    let Some((provider, _model)) = value.split_once('/') else {
        // No provider segment: nothing to attribute it to. Fail open rather
        // than hide a row whose shape we do not recognize.
        return true;
    };
    // Unopinionated → the agent's own list stands.
    !policy.opinionated_providers.contains(provider)
}

/// How many rows a filtered select would show. A future (unknown) select shape
/// is passed through by [`filter_select_options`], so it can never be the
/// empty-selector case.
fn select_row_count(options: &SessionConfigSelectOptions) -> usize {
    match options {
        SessionConfigSelectOptions::Ungrouped(rows) => rows.len(),
        SessionConfigSelectOptions::Grouped(groups) => groups.iter().map(|g| g.options.len()).sum(),
        _ => 1,
    }
}

/// The OpenCode desktop app's per-model visibility state, as its model page
/// persists it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct DesktopVisibility {
    /// Providers with at least one honored toggle entry (`show` or `hide`).
    providers_with_opinions: HashSet<String>,
    /// Exact `providerID/modelID` row values marked `show`.
    shown: HashSet<String>,
}

/// Where the desktop app keeps its UI state: Electron's userData dir, which
/// maps to `~/Library/Application Support` on macOS, `%APPDATA%` on Windows
/// and `~/.config` on Linux. `dirs::data_dir()` covers the first two and
/// `dirs::config_dir()` the third, so BOTH roots are probed — on Linux they
/// differ and only one holds the db.
fn desktop_db_candidates(data_root: Option<PathBuf>, config_root: Option<PathBuf>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in [data_root, config_root].into_iter().flatten() {
        let path = root.join("ai.opencode.desktop").join("drafts.sqlite");
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    }
    candidates
}

/// Read the desktop visibility: probe the candidates in order and read the
/// first that exists. EVERY failure mode — no desktop app, unreadable or
/// locked db, absent row, unexpected JSON — collapses into `None` and the
/// agent's list stands unchanged.
fn read_desktop_visibility() -> Option<DesktopVisibility> {
    read_desktop_visibility_at_any(&desktop_db_candidates(dirs::data_dir(), dirs::config_dir()))
}

fn read_desktop_visibility_at_any(candidates: &[PathBuf]) -> Option<DesktopVisibility> {
    let path = candidates.iter().find(|path| path.exists())?;
    read_desktop_visibility_at(path)
}

fn read_desktop_visibility_at(path: &Path) -> Option<DesktopVisibility> {
    let connection =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let raw: String = connection
        .query_row(
            "SELECT value FROM state WHERE name = 'opencode.global.dat' AND key = 'model'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    parse_desktop_model_state(&raw)
}

/// Pure parse of the `opencode.global.dat`/`model` payload — measured shape:
/// `{"user":[{"providerID","modelID","visibility":"show"|"hide"},...],
/// "recent":[...],"variant":{...}}`. Only the `user` toggles count, and only
/// the two visibility values the desktop writes today are honored: `"show"`
/// marks its row visible and makes its provider opinionated; `"hide"` makes
/// the provider opinionated alone. Any other visibility — a missing one, or a
/// future value — skips the entry WHOLE: no opinion, no shown row, rather
/// than guessed into either bucket. Entries without both ids are skipped;
/// `recent` and `variant` are usage metadata, not the user's word. An empty
/// opinion set means the desktop holds no state worth honoring → `None`.
fn parse_desktop_model_state(raw: &str) -> Option<DesktopVisibility> {
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let entries = value.get("user")?.as_array()?;
    let mut visibility = DesktopVisibility::default();
    for entry in entries {
        let (Some(provider), Some(model), Some(word)) = (
            entry.get("providerID").and_then(serde_json::Value::as_str),
            entry.get("modelID").and_then(serde_json::Value::as_str),
            entry.get("visibility").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        match word {
            "show" => {
                visibility
                    .providers_with_opinions
                    .insert(provider.to_string());
                visibility.shown.insert(format!("{provider}/{model}"));
            }
            "hide" => {
                visibility
                    .providers_with_opinions
                    .insert(provider.to_string());
            }
            // A future value is not the user's word on either side.
            _ => continue,
        }
    }
    if visibility.providers_with_opinions.is_empty() {
        return None;
    }
    Some(visibility)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{SessionConfigId, SessionConfigValueId};

    /// A policy with the OpenCode desktop's opinions: the providers its model
    /// page has toggles for, and the rows marked `show`.
    fn desktop_policy(opinionated: &[&str], shown: &[&str]) -> ModelAvailability {
        ModelAvailability::Restricted(RestrictedAvailability {
            opinionated_providers: opinionated.iter().map(|p| p.to_string()).collect(),
            shown_models: shown.iter().map(|s| s.to_string()).collect(),
        })
    }

    fn rows(values: &[&str]) -> Vec<SessionConfigSelectOption> {
        values
            .iter()
            .map(|value| {
                SessionConfigSelectOption::new(
                    SessionConfigValueId::new(*value),
                    format!("label of {value}"),
                )
            })
            .collect()
    }

    fn model_select(current: &str, values: &[&str]) -> SessionConfigOption {
        SessionConfigOption::select(
            SessionConfigId::new(MODEL_CONFIG_OPTION_ID),
            "Model",
            SessionConfigValueId::new(current),
            rows(values),
        )
        .category(SessionConfigOptionCategory::Model)
    }

    fn plain_select(
        id: &str,
        category: Option<SessionConfigOptionCategory>,
        current: &str,
        values: &[&str],
    ) -> SessionConfigOption {
        let mut option = SessionConfigOption::select(
            SessionConfigId::new(id),
            format!("{id} label"),
            SessionConfigValueId::new(current),
            rows(values),
        );
        if let Some(category) = category {
            option = option.category(category);
        }
        option
    }

    /// Every row value across all options, in order.
    fn values(options: &[SessionConfigOption]) -> Vec<String> {
        options
            .iter()
            .flat_map(|option| match &option.kind {
                SessionConfigKind::Select(select) => match &select.options {
                    SessionConfigSelectOptions::Ungrouped(rows) => {
                        rows.iter().map(|r| r.value.to_string()).collect::<Vec<_>>()
                    }
                    SessionConfigSelectOptions::Grouped(groups) => groups
                        .iter()
                        .flat_map(|g| {
                            g.options
                                .iter()
                                .map(|r| r.value.to_string())
                                .collect::<Vec<_>>()
                        })
                        .collect(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            })
            .collect()
    }

    fn model_select_with_groups(current: &str, groups: &[&[&str]]) -> SessionConfigOption {
        SessionConfigOption::select(
            SessionConfigId::new(MODEL_CONFIG_OPTION_ID),
            "Model",
            SessionConfigValueId::new(current),
            SessionConfigSelectOptions::Grouped(
                groups
                    .iter()
                    .enumerate()
                    .map(|(index, values)| {
                        SessionConfigSelectGroup::new(
                            agent_client_protocol::schema::v1::SessionConfigGroupId::new(format!(
                                "g{index}"
                            )),
                            format!("Group {index}"),
                            rows(values),
                        )
                    })
                    .collect(),
            ),
        )
        .category(SessionConfigOptionCategory::Model)
    }

    fn seeded_desktop_db(payload: &serde_json::Value) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("drafts.sqlite");
        let connection = rusqlite::Connection::open(&db).expect("create db");
        connection
            .execute_batch(
                "CREATE TABLE state (
                    name TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    updated_at INTEGER,
                    PRIMARY KEY (name, key)
                );",
            )
            .expect("create table");
        connection
            .execute(
                "INSERT INTO state (name, key, value) VALUES ('opencode.global.dat', 'model', ?1)",
                [payload.to_string()],
            )
            .expect("insert row");
        drop(connection);
        (dir, db)
    }

    #[test]
    fn desktop_gate_narrows_an_opinionated_provider_to_its_shows() {
        let policy = desktop_policy(&["go"], &["go/m1"]);
        let options = filter_model_options(
            &policy,
            vec![model_select(
                "go/m2",
                &["go/m1", "go/m2", "go/m3", "authed/a", "authed/b"],
            )],
        );
        // `go` has desktop opinions: only its show row and the session's
        // current row survive it; the unopinionated provider keeps the
        // agent's whole list.
        assert_eq!(
            values(&options),
            vec![
                "go/m1".to_string(),
                "go/m2".to_string(),
                "authed/a".to_string(),
                "authed/b".to_string(),
            ],
        );
    }

    #[test]
    fn a_row_without_a_provider_segment_fails_open_under_an_opinionated_policy() {
        // A value with no `/` cannot be attributed to any provider, so the
        // policy has nothing to judge it against — it is kept even when the
        // policy is otherwise opinionated (and the attribution-based drop
        // next to it proves the bare rule is not vacuous).
        let policy = desktop_policy(&["go"], &[]);
        let options = filter_model_options(
            &policy,
            vec![model_select("go/m1", &["go/m1", "go/m2", "lc"])],
        );
        assert_eq!(values(&options), vec!["go/m1".to_string(), "lc".to_string()],);
    }

    #[test]
    fn a_show_keeps_a_row_the_provider_gate_would_otherwise_drop() {
        // The measured 2026-10-16 case: the desktop's Console account reaches
        // providers the CLI's own files never carry — the user's `show` is
        // what puts those rows back.
        let policy = desktop_policy(&["deepseek"], &["deepseek/flash", "deepseek/other"]);
        let options = filter_model_options(
            &policy,
            vec![model_select(
                "deepseek/flash",
                &["deepseek/flash", "deepseek/other", "deepseek/third"],
            )],
        );
        assert_eq!(
            values(&options),
            vec![
                "deepseek/flash".to_string(),
                "deepseek/other".to_string(),
            ],
            "the shown non-current row and the current row survive; the \
             untoggled sibling is dropped"
        );
    }

    #[test]
    fn the_current_row_survives_a_hide_only_provider() {
        // A provider the user only ever hid: its remaining rows go, but the
        // row the session is actually running on always stays — the composer
        // must show what the conversation runs.
        let policy = desktop_policy(&["zen"], &[]);
        let options = filter_model_options(
            &policy,
            vec![model_select("zen/paid", &["zen/paid", "zen/other"])],
        );
        assert_eq!(values(&options), vec!["zen/paid".to_string()]);
    }

    #[test]
    fn unopinionated_providers_are_untouched() {
        let policy = desktop_policy(&["go"], &[]);
        let options = filter_model_options(
            &policy,
            vec![model_select(
                "authed/a",
                &["authed/a", "authed/b", "go/x", "random/y"],
            )],
        );
        // `go/x`: opinionated but not shown → dropped. Everything the desktop
        // has no word on — including `random/y`, whose availability is the
        // AGENT's judgment, not ours — travels as-is.
        assert_eq!(
            values(&options),
            vec![
                "authed/a".to_string(),
                "authed/b".to_string(),
                "random/y".to_string(),
            ],
        );
    }

    #[test]
    fn show_rows_only_narrow_within_the_advertised_list() {
        // A `show` the agent does not advertise adds nothing: the policy
        // filters, it never fabricates rows.
        let policy = desktop_policy(&["go"], &["go/ghost"]);
        let options = filter_model_options(
            &policy,
            vec![model_select("other/current", &["go/x", "other/current"])],
        );
        assert_eq!(values(&options), vec!["other/current".to_string()]);
    }

    #[test]
    fn parse_desktop_model_state_reads_toggles_and_skips_noise() {
        let payload = serde_json::json!({
            "user": [
                {"providerID": "go", "modelID": "m1", "visibility": "show"},
                {"providerID": "go", "modelID": "m2", "visibility": "hide"},
                {"providerID": "future-only", "modelID": "f1", "visibility": "some-future-value"},
                {"providerID": "vercel", "modelID": "a/b", "visibility": "hide"},
                {"providerID": "no-word", "modelID": "n1"},
                {"modelID": "orphan", "visibility": "show"},
                {"providerID": "orphan2"},
                "not-an-object",
            ],
            "recent": [{"providerID": "go", "modelID": "m1"}],
        });
        let visibility = parse_desktop_model_state(&payload.to_string()).expect("parseable");
        assert_eq!(
            visibility.providers_with_opinions,
            HashSet::from(["go".to_string(), "vercel".to_string()]),
            "an unknown visibility registers NO opinion for its provider"
        );
        assert_eq!(
            visibility.shown,
            HashSet::from(["go/m1".to_string()]),
        );

        // Only-shows-when-there-is-something-to-honor.
        assert_eq!(
            parse_desktop_model_state(r#"{"user": [], "recent": []}"#),
            None,
        );
        assert_eq!(parse_desktop_model_state(r#"{"recent": []}"#), None);
        assert_eq!(parse_desktop_model_state("not json"), None);
    }

    #[test]
    fn read_desktop_visibility_at_reads_the_state_row() {
        let (_dir, db) = seeded_desktop_db(&serde_json::json!({
            "user": [
                {"providerID": "go", "modelID": "m1", "visibility": "show"},
                {"providerID": "go", "modelID": "m2", "visibility": "hide"},
                {"providerID": "zen", "modelID": "free", "visibility": "show"},
            ],
            "recent": [],
        }));
        let visibility = read_desktop_visibility_at(&db).expect("readable");
        assert_eq!(
            visibility.providers_with_opinions,
            HashSet::from(["go".to_string(), "zen".to_string()]),
        );
        assert_eq!(
            visibility.shown,
            HashSet::from(["go/m1".to_string(), "zen/free".to_string()]),
        );
    }

    #[test]
    fn read_desktop_visibility_at_fails_soft_on_a_corrupt_db() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("drafts.sqlite");
        std::fs::write(&db, b"not a database at all").expect("write garbage");
        assert_eq!(read_desktop_visibility_at(&db), None);
    }

    #[test]
    fn read_desktop_visibility_at_any_probes_candidates_in_order() {
        let payload = serde_json::json!({
            "user": [{"providerID": "go", "modelID": "m1", "visibility": "show"}],
        });
        let (_dir, db) = seeded_desktop_db(&payload);
        let missing = std::env::temp_dir()
            .join("codeg-mv-test-no-such-dir")
            .join("drafts.sqlite");

        // The first EXISTING candidate wins, wherever it sits in the list.
        let visibility =
            read_desktop_visibility_at_any(&[missing.clone(), db.clone()]).expect("second exists");
        assert_eq!(visibility.shown, HashSet::from(["go/m1".to_string()]),);
        // A corrupt first candidate is still "found": first-wins does not
        // second-guess it with a later candidate — the parse failure surfaces
        // (and fails soft to Unfiltered downstream) instead.
        let corrupt_dir = tempfile::tempdir().expect("tempdir");
        let corrupt = corrupt_dir.path().join("drafts.sqlite");
        std::fs::write(&corrupt, b"not a database at all").expect("write garbage");
        assert_eq!(read_desktop_visibility_at_any(&[corrupt, db.clone()]), None);
        // All candidates missing (a CLI-only machine) → None.
        assert_eq!(read_desktop_visibility_at_any(&[missing]), None);
        assert_eq!(read_desktop_visibility_at_any(&[]), None);
    }

    #[test]
    fn desktop_db_candidates_map_the_platform_roots() {
        let data = PathBuf::from("/data-root");
        let config = PathBuf::from("/config-root");
        // Linux: the two roots differ and only one holds the db — both probed,
        // data first.
        assert_eq!(
            desktop_db_candidates(Some(data.clone()), Some(config.clone())),
            vec![
                data.join("ai.opencode.desktop").join("drafts.sqlite"),
                config.join("ai.opencode.desktop").join("drafts.sqlite"),
            ],
        );
        // macOS/Windows: data_dir == config_dir, so the list holds one entry.
        assert_eq!(
            desktop_db_candidates(Some(data.clone()), Some(data.clone())),
            vec![data.join("ai.opencode.desktop").join("drafts.sqlite")],
        );
        // Unresolvable home/XDG → no candidates at all.
        assert_eq!(desktop_db_candidates(None, None), Vec::<PathBuf>::new());
        assert_eq!(
            desktop_db_candidates(None, Some(config.clone())),
            vec![config.join("ai.opencode.desktop").join("drafts.sqlite")],
        );
    }

    #[test]
    fn compute_keeps_every_agent_but_opencode_unfiltered() {
        assert_eq!(compute(AgentType::Pi), ModelAvailability::Unfiltered);
        assert_eq!(
            compute(AgentType::custom("zcode").expect("valid slug")),
            ModelAvailability::Unfiltered
        );
        for agent_type in [
            AgentType::ClaudeCode,
            AgentType::Codex,
            AgentType::Cline,
            AgentType::KimiCode,
            AgentType::Grok,
        ] {
            assert_eq!(compute(agent_type), ModelAvailability::Unfiltered);
        }
        // AgentType::OpenCode is deliberately not asserted here: `compute`
        // reads THIS machine's desktop db, so the answer depends on the
        // machine — it is covered through `desktop_availability` above.
    }

    #[test]
    fn an_empty_opinion_set_fails_soft_to_unfiltered() {
        assert_eq!(desktop_availability(None), ModelAvailability::Unfiltered);
    }

    #[test]
    fn non_model_options_are_untouched_byte_for_byte() {
        let availability = desktop_policy(&["hidden"], &[]);
        let effort = plain_select(
            "effort",
            Some(SessionConfigOptionCategory::ThoughtLevel),
            "default",
            &["nvidia/only", "hidden/only"],
        );
        let mode = plain_select(
            "mode",
            Some(SessionConfigOptionCategory::Mode),
            "build",
            &["a/b"],
        );
        let toggle = SessionConfigOption::boolean(SessionConfigId::new("fast"), "Fast", false);
        let options = vec![
            model_select("kept/current", &["kept/a", "hidden/b"]),
            effort.clone(),
            mode.clone(),
            toggle.clone(),
        ];

        let filtered = filter_model_options(&availability, options);

        // Serialized equality: not merely PartialEq — the JSON the wire would
        // carry is identical.
        assert_eq!(
            serde_json::to_value(&filtered[1]).unwrap(),
            serde_json::to_value(&effort).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&filtered[2]).unwrap(),
            serde_json::to_value(&mode).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&filtered[3]).unwrap(),
            serde_json::to_value(&toggle).unwrap()
        );
        assert_eq!(
            values(&filtered[0..1]),
            vec!["kept/a".to_string()],
            "only the model select is filtered"
        );
    }

    #[test]
    fn zero_row_guard_puts_the_original_list_back() {
        // Every advertised provider is opinionated with no shows, and the
        // current value is not among the rows at all. That is a shape we
        // misread (or a policy from another machine) — revert everything.
        let availability = desktop_policy(&["hidden", "other"], &[]);
        let options = vec![model_select("gone/model", &["hidden/a", "other/b"])];

        let filtered = filter_model_options(&availability, options.clone());
        assert_eq!(
            serde_json::to_value(&filtered).unwrap(),
            serde_json::to_value(&options).unwrap(),
            "an emptied model select reverts the whole list"
        );
    }

    #[test]
    fn grouped_selects_lose_empty_groups_and_keep_current_rows() {
        let availability = desktop_policy(&["hidden"], &[]);
        let grouped = SessionConfigSelectOptions::Grouped(vec![
            SessionConfigSelectGroup::new(
                agent_client_protocol::schema::v1::SessionConfigGroupId::new("g1"),
                "Only hidden",
                rows(&["hidden/a"]),
            ),
            SessionConfigSelectGroup::new(
                agent_client_protocol::schema::v1::SessionConfigGroupId::new("g2"),
                "Keeps",
                rows(&["kept/b", "hidden/c"]),
            ),
        ]);
        let options = vec![SessionConfigOption::select(
            SessionConfigId::new(MODEL_CONFIG_OPTION_ID),
            "Model",
            SessionConfigValueId::new("kept/b"),
            grouped,
        )
        .category(SessionConfigOptionCategory::Model)];

        let filtered = filter_model_options(&availability, options);
        let SessionConfigKind::Select(select) = &filtered[0].kind else {
            panic!("still a select");
        };
        let SessionConfigSelectOptions::Grouped(groups) = &select.options else {
            panic!("still grouped");
        };
        assert_eq!(groups.len(), 1, "the emptied group is dropped");
        assert_eq!(groups[0].group.to_string(), "g2");
        assert_eq!(
            groups[0]
                .options
                .iter()
                .map(|r| r.value.to_string())
                .collect::<Vec<_>>(),
            vec!["kept/b".to_string()]
        );

        // Every group emptied and the current value absent → the guard puts
        // the original (both groups) back.
        let all_hidden = vec![model_select_with_groups(
            "gone/model",
            &[&["hidden/a"], &["hidden/b"]],
        )];
        let filtered = filter_model_options(&availability, all_hidden.clone());
        assert_eq!(
            serde_json::to_value(&filtered).unwrap(),
            serde_json::to_value(&all_hidden).unwrap()
        );
    }
}
