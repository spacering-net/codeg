//! The owner's preferences and the team's division of work: the account's
//! settings, the same for every assistant, kept on the primary's row (the
//! `prefs` and `team` keys of its settings JSON).
//!
//! Every item defaults, and every one reads leniently: a value this build
//! does not know (written by a newer one) reads as its default, without
//! taking the other items with it. The items are only those whose feature
//! exists; a milestone that brings a feature adds its items here.
//!
//! Two kinds of item:
//! - what codeg itself does: whether a dispatch, a follow-up or a message to
//!   another assistant goes to the owner as a card first, how changes the
//!   owner asks for in chat land, how many rounds two assistants may go
//!   without progress;
//! - what the brain is asked to do: how long its replies are, whether it
//!   answers with cards, what it does when unsure. codeg writes those into
//!   the handoff card as `<codeg-prefs>` and tells the brain when they change.

use std::collections::BTreeMap;

use serde::de::{DeserializeOwned, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::db::entities::personal_agent_dispatch::DispatchMode;

/// A value this build cannot read is the item's default.
fn lenient<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

/// The default number of rounds two assistants may go back and forth with
/// no progress before codeg stops their exchange (4.9).
pub const DEFAULT_LOOP_ROUNDS: u32 = 3;
/// The most rounds that can be set.
pub const MAX_LOOP_ROUNDS: u32 = 1_000;

fn default_loop_rounds() -> u32 {
    DEFAULT_LOOP_ROUNDS
}

/// How many times codeg retries one dispatch on its own after a restart
/// interrupted it (7.3), unless the owner changes it; 0 is never.
pub const DEFAULT_RETRY_ROUNDS: u32 = 2;
/// The most automatic retries that can be set.
pub const MAX_RETRY_ROUNDS: u32 = 10;

fn default_retry_rounds() -> u32 {
    DEFAULT_RETRY_ROUNDS
}

fn lenient_retry_rounds<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_u64()
        .map(|n| n.min(MAX_RETRY_ROUNDS as u64) as u32)
        .unwrap_or(DEFAULT_RETRY_ROUNDS))
}

fn lenient_rounds<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_u64()
        .map(|n| n.min(MAX_LOOP_ROUNDS as u64) as u32)
        .unwrap_or(DEFAULT_LOOP_ROUNDS))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyLength {
    Short,
    #[default]
    Medium,
    Long,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardUse {
    /// Wherever a card says it better.
    #[default]
    Prefer,
    /// Only when the owner has to decide something.
    Decisions,
    Never,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WhenUnsure {
    /// Go with the most reasonable reading, and say what was assumed.
    #[default]
    Assume,
    Ask,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatChanges {
    /// What the owner says to change is changed at once, on a card that
    /// undoes it.
    #[default]
    Apply,
    /// It goes to the owner as a card first.
    Show,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmDispatch {
    #[default]
    Never,
    /// Only work that changes code: a kanban task or a work session, which
    /// run in a project's checkout. A chat touches no project.
    Code,
    Always,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskFirst {
    #[default]
    Auto,
    Ask,
}

/// Who answers an executor's questions or plan approvals (7.3.1).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecAnswers {
    /// The assistant that dispatched the work answers for the owner, and
    /// forwards what it cannot settle.
    #[default]
    Assistant,
    /// Always the owner.
    Owner,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerHandoff {
    /// Write to the work assistant and let it see the work through.
    #[default]
    Message,
    /// Dispatch to the work assistant's executor config directly.
    Direct,
}

/// The owner's preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prefs {
    #[serde(default, deserialize_with = "lenient")]
    pub reply_length: ReplyLength,
    #[serde(default, deserialize_with = "lenient")]
    pub cards: CardUse,
    #[serde(default, deserialize_with = "lenient")]
    pub when_unsure: WhenUnsure,
    #[serde(default, deserialize_with = "lenient")]
    pub chat_changes: ChatChanges,
    #[serde(default, deserialize_with = "lenient")]
    pub confirm_dispatch: ConfirmDispatch,
    /// Follow-ups and retries of the assistant's own dispatches.
    #[serde(default, deserialize_with = "lenient")]
    pub followups: AskFirst,
    /// Messages to the other assistants (`bot_message`).
    #[serde(default, deserialize_with = "lenient")]
    pub messages: AskFirst,
    #[serde(default, deserialize_with = "lenient")]
    pub worker_handoff: WorkerHandoff,
    /// Rounds without progress before an exchange between two assistants is
    /// stopped; 0 is no limit.
    #[serde(default = "default_loop_rounds", deserialize_with = "lenient_rounds")]
    pub loop_rounds: u32,
    /// A dispatch a restart interrupted: retried at once, or put to the
    /// owner on a card first (7.3).
    #[serde(default, deserialize_with = "lenient")]
    pub interrupt_retry: AskFirst,
    /// How many times one dispatch is retried on its own; 0 is never.
    #[serde(default = "default_retry_rounds", deserialize_with = "lenient_retry_rounds")]
    pub retry_rounds: u32,
    /// An executor's questions (7.3.1).
    #[serde(default, deserialize_with = "lenient")]
    pub exec_questions: ExecAnswers,
    /// An executor's plan approvals (7.3.1).
    #[serde(default, deserialize_with = "lenient")]
    pub exec_plans: ExecAnswers,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            reply_length: ReplyLength::default(),
            cards: CardUse::default(),
            when_unsure: WhenUnsure::default(),
            chat_changes: ChatChanges::default(),
            confirm_dispatch: ConfirmDispatch::default(),
            followups: AskFirst::default(),
            messages: AskFirst::default(),
            worker_handoff: WorkerHandoff::default(),
            loop_rounds: DEFAULT_LOOP_ROUNDS,
            interrupt_retry: AskFirst::default(),
            retry_rounds: DEFAULT_RETRY_ROUNDS,
            exec_questions: ExecAnswers::default(),
            exec_plans: ExecAnswers::default(),
        }
    }
}

/// What a preference takes.
#[derive(Debug, Clone, Copy)]
pub enum PrefKind {
    /// One of these words.
    Choice(&'static [&'static str]),
    /// A whole number in range.
    Count { max: u32 },
}

/// One item, as codeg checks and describes it.
#[derive(Debug, Clone, Copy)]
pub struct PrefSpec {
    pub key: &'static str,
    pub kind: PrefKind,
    /// What the brain reads it as.
    pub label: &'static str,
}

/// Every preference there is.
pub const PREFS: &[PrefSpec] = &[
    PrefSpec {
        key: "reply_length",
        kind: PrefKind::Choice(&["short", "medium", "long"]),
        label: "replies",
    },
    PrefSpec {
        key: "cards",
        kind: PrefKind::Choice(&["prefer", "decisions", "never"]),
        label: "cards",
    },
    PrefSpec {
        key: "when_unsure",
        kind: PrefKind::Choice(&["assume", "ask"]),
        label: "when unsure what the owner means",
    },
    PrefSpec {
        key: "chat_changes",
        kind: PrefKind::Choice(&["apply", "show"]),
        label: "settings changes asked for in chat",
    },
    PrefSpec {
        key: "confirm_dispatch",
        kind: PrefKind::Choice(&["never", "code", "always"]),
        label: "confirm before dispatching",
    },
    PrefSpec {
        key: "followups",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "follow-ups and retries of your dispatches",
    },
    PrefSpec {
        key: "messages",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "messages to the other assistants",
    },
    PrefSpec {
        key: "worker_handoff",
        kind: PrefKind::Choice(&["message", "direct"]),
        label: "handing work to a work assistant",
    },
    PrefSpec {
        key: "loop_rounds",
        kind: PrefKind::Count {
            max: MAX_LOOP_ROUNDS,
        },
        label: "rounds without progress before an exchange between assistants stops",
    },
    PrefSpec {
        key: "interrupt_retry",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "retrying a dispatch a restart interrupted",
    },
    PrefSpec {
        key: "retry_rounds",
        kind: PrefKind::Count {
            max: MAX_RETRY_ROUNDS,
        },
        label: "automatic retries of one dispatch",
    },
    PrefSpec {
        key: "exec_questions",
        kind: PrefKind::Choice(&["assistant", "owner"]),
        label: "questions from the sessions you dispatched",
    },
    PrefSpec {
        key: "exec_plans",
        kind: PrefKind::Choice(&["assistant", "owner"]),
        label: "plan approvals from the sessions you dispatched",
    },
];

/// The "automation level" (13.4): a preset over the items below — not
/// stored, read off them. Changing one of them makes it "custom".
pub const AUTOMATION_KEY: &str = "automation_level";

/// The items each automation level sets, and to what.
pub fn automation_preset(level: &str) -> Option<Vec<(&'static str, Value)>> {
    match level {
        "standard" => Some(vec![
            ("confirm_dispatch", json!("never")),
            ("followups", json!("auto")),
            ("messages", json!("auto")),
            ("chat_changes", json!("apply")),
            ("interrupt_retry", json!("auto")),
            ("exec_questions", json!("assistant")),
            ("exec_plans", json!("assistant")),
        ]),
        "ask_more" => Some(vec![
            ("confirm_dispatch", json!("code")),
            ("followups", json!("ask")),
            ("messages", json!("ask")),
            ("chat_changes", json!("show")),
            ("interrupt_retry", json!("ask")),
            ("exec_questions", json!("owner")),
            ("exec_plans", json!("owner")),
        ]),
        _ => None,
    }
}

pub fn spec(key: &str) -> Option<&'static PrefSpec> {
    PREFS.iter().find(|s| s.key == key)
}

/// A value for `key`, checked and in its stored form.
pub fn check_pref(key: &str, value: &Value) -> Result<Value, String> {
    let spec = spec(key).ok_or_else(|| format!("no preference `{key}`"))?;
    match spec.kind {
        PrefKind::Choice(words) => {
            let word = value.as_str().map(str::trim).unwrap_or_default();
            if words.contains(&word) {
                Ok(json!(word))
            } else {
                Err(format!("`{key}` takes one of: {}", words.join(", ")))
            }
        }
        PrefKind::Count { max } => {
            let n = value
                .as_u64()
                .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
                .ok_or_else(|| format!("`{key}` takes a whole number, 0 to {max}"))?;
            if n > max as u64 {
                return Err(format!("`{key}` takes a whole number, 0 to {max}"));
            }
            Ok(json!(n))
        }
    }
}

impl Prefs {
    pub fn parse(v: Option<&Value>) -> Self {
        v.cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// The items as stored, by key.
    pub fn to_map(&self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        }
    }

    pub fn get(&self, key: &str) -> Value {
        self.to_map().remove(key).unwrap_or(Value::Null)
    }

    /// Whether a dispatch in `mode` goes to the owner as a card first.
    pub fn confirms(&self, mode: DispatchMode) -> bool {
        match self.confirm_dispatch {
            ConfirmDispatch::Never => false,
            ConfirmDispatch::Code => mode != DispatchMode::Chat,
            ConfirmDispatch::Always => true,
        }
    }

    /// The automation level the items add up to: `standard`, `ask_more`, or
    /// `custom` when they match neither.
    pub fn automation_level(&self) -> &'static str {
        let map = self.to_map();
        for level in ["standard", "ask_more"] {
            let preset = automation_preset(level).unwrap_or_default();
            if preset
                .iter()
                .all(|(k, v)| map.get(*k).is_some_and(|have| have == v))
            {
                return level;
            }
        }
        "custom"
    }
}

/// How an item's value reads to the brain.
fn brain_value(key: &str, value: &Value) -> String {
    let word = value.as_str().unwrap_or_default();
    match (key, word) {
        ("reply_length", "short") => "short: a few sentences, the answer first".into(),
        ("reply_length", "medium") => "medium: as long as the matter needs, no longer".into(),
        ("reply_length", "long") => {
            "detailed: the reasoning, the steps and the alternatives".into()
        }
        ("cards", "prefer") => {
            "answer with cards (the ui-render skill) wherever a card says it better".into()
        }
        ("cards", "decisions") => "a card only when the owner has to decide something".into(),
        ("cards", "never") => "no cards: plain text only".into(),
        ("when_unsure", "assume") => {
            "go with the most reasonable reading and say what you assumed".into()
        }
        ("when_unsure", "ask") => "ask the owner first".into(),
        ("chat_changes", "apply") => {
            "prefs_update changes what the owner asks for at once; they can undo it".into()
        }
        ("chat_changes", "show") => "prefs_update puts it on a card for the owner first".into(),
        ("confirm_dispatch", "never") => "dispatches go out directly".into(),
        ("confirm_dispatch", "code") => {
            "a dispatch that changes code (task or session) goes to the owner as a card to \
             confirm first; a chat goes out directly"
                .into()
        }
        ("confirm_dispatch", "always") => {
            "every dispatch goes to the owner as a card to confirm first".into()
        }
        ("followups" | "messages", "auto") => "sent directly".into(),
        ("followups" | "messages", "ask") => "go to the owner as a card first".into(),
        ("worker_handoff", "message") => {
            "write to the work assistant (bot_message) and let it see the work through".into()
        }
        ("worker_handoff", "direct") => {
            "dispatch to the work assistant's executor config directly".into()
        }
        ("loop_rounds", _) => match value.as_u64() {
            Some(0) => "no limit".into(),
            Some(n) => n.to_string(),
            None => value.to_string(),
        },
        ("interrupt_retry", "auto") => {
            "codeg retries it once by itself and notes it on its card".into()
        }
        ("interrupt_retry", "ask") => "codeg asks the owner on a card first".into(),
        ("retry_rounds", _) => match value.as_u64() {
            Some(0) => "none: the owner retries".into(),
            Some(n) => format!("at most {n}, then it is the owner's"),
            None => value.to_string(),
        },
        ("exec_questions" | "exec_plans", "assistant") => {
            "you answer them for the owner (dispatch_answer), and forward what you cannot settle"
                .into()
        }
        ("exec_questions" | "exec_plans", "owner") => {
            "they go to the owner; you are told, nothing to answer".into()
        }
        _ => value.to_string(),
    }
}

/// The preferences as the brain reads them: `<codeg-prefs>`. A worker is
/// not told how the primary hands work to workers.
pub fn prefs_block(prefs: &Prefs, worker: bool) -> String {
    let map = prefs.to_map();
    let lines: Vec<String> = PREFS
        .iter()
        .filter(|s| !(worker && s.key == "worker_handoff"))
        .map(|s| {
            let v = map.get(s.key).cloned().unwrap_or(Value::Null);
            format!("- {}: {}", s.label, brain_value(s.key, &v))
        })
        .collect();
    format!(
        "<codeg-prefs>\n\
The owner's preferences, as they set them in codeg — every assistant follows the same ones. The \
ones about how you write are yours to follow; the others codeg applies itself, so a tool may \
answer that something went to the owner first.\n\
{}\n\
</codeg-prefs>",
        lines.join("\n")
    )
}

/// What changed between two sets of preferences, one line each
/// ("replies → short: …").
pub fn prefs_changes(old: &Prefs, new: &Prefs, worker: bool) -> Vec<String> {
    let (a, b) = (old.to_map(), new.to_map());
    PREFS
        .iter()
        .filter(|s| !(worker && s.key == "worker_handoff"))
        .filter_map(|s| {
            let (from, to) = (a.get(s.key)?, b.get(s.key)?);
            (from != to).then(|| format!("{} → {}", s.label, brain_value(s.key, to)))
        })
        .collect()
}

/// For the next delivery after the owner changed a preference: what
/// changed, and the whole set anew.
pub fn prefs_update_card(changes: &[String], prefs: &Prefs, worker: bool) -> String {
    format!(
        "<codeg-context kind=\"prefs-update\">\n\
The owner changed their preferences: {}. These replace what you had.\n\
{}\n\
</codeg-context>",
        changes.join("; "),
        prefs_block(prefs, worker)
    )
}

// ── the team ────────────────────────────────────────────────────────────────

/// The kinds of work the division assigns a first pick for (10.5).
pub const DIVISION: &[&str] = &[
    "code", "review", "test", "fix_ci", "docs", "release", "research", "check",
];

/// What the brain reads a kind of work as.
pub fn division_label(category: &str) -> &'static str {
    match category {
        "code" => "writing code",
        "review" => "review",
        "test" => "testing",
        "fix_ci" => "fixing CI",
        "docs" => "docs",
        "release" => "releases",
        "research" => "research",
        "check" => "checking finished work",
        _ => "other",
    }
}

fn default_true() -> bool {
    true
}

fn all_modes() -> Vec<DispatchMode> {
    vec![
        DispatchMode::Task,
        DispatchMode::Chat,
        DispatchMode::Session,
    ]
}

/// How the assistants may use an executor config (10.5, 补齐三). The
/// owner's, set on the executor config, checked at `dispatch`. Not on the
/// `assistant` table: @-delegation, codeg-cli and config sync never see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutorUsage {
    /// The assistants may dispatch to it at all. Off, it is still there to
    /// @ in a conversation.
    #[serde(default = "default_true")]
    pub dispatch: bool,
    /// The modes it takes.
    #[serde(default = "all_modes")]
    pub modes: Vec<DispatchMode>,
    /// The projects it works on; `None` is every one. A chat takes no
    /// project, so this never refuses one.
    #[serde(default)]
    pub projects: Option<Vec<i32>>,
}

impl Default for ExecutorUsage {
    fn default() -> Self {
        Self {
            dispatch: true,
            modes: all_modes(),
            projects: None,
        }
    }
}

impl ExecutorUsage {
    /// Checked as the editor submits it.
    pub fn checked(mut self) -> Result<Self, String> {
        let mut modes = Vec::new();
        for m in all_modes() {
            if self.modes.contains(&m) {
                modes.push(m);
            }
        }
        if modes.is_empty() {
            return Err(
                "an executor config the assistants dispatch to takes at least one mode".into(),
            );
        }
        self.modes = modes;
        if let Some(p) = self.projects.as_mut() {
            p.sort_unstable();
            p.dedup();
            if p.is_empty() {
                return Err("pick at least one project, or allow every project".into());
            }
        }
        Ok(self)
    }

    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// The team's settings: the division of work and how each executor config
/// may be used. A division entry is `bot:<uid>` (a work assistant) or
/// `assistant:<uid>` (an executor config); a kind of work left out is
/// "auto".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamSettings {
    #[serde(default, deserialize_with = "lenient")]
    pub division: BTreeMap<String, String>,
    #[serde(default, deserialize_with = "lenient_usage")]
    pub usage: BTreeMap<String, ExecutorUsage>,
}

/// Each executor config's usage on its own: one this build cannot read is
/// the default, the others stay.
fn lenient_usage<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<String, ExecutorUsage>, D::Error> {
    let v = Value::deserialize(d)?;
    let Value::Object(map) = v else {
        return Ok(BTreeMap::new());
    };
    Ok(map
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_value(v).ok().map(|u| (k, u)))
        .collect())
}

impl TeamSettings {
    pub fn parse(v: Option<&Value>) -> Self {
        v.cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// How executor config `uid` may be used (the default when the owner
    /// set nothing).
    pub fn usage_of(&self, uid: &str) -> ExecutorUsage {
        self.usage.get(uid).cloned().unwrap_or_default()
    }
}

/// A division pick, checked: `auto` (as `None`), `bot:<uid>` or
/// `assistant:<uid>`.
pub fn check_division(category: &str, value: &Value) -> Result<Option<String>, String> {
    if !DIVISION.contains(&category) {
        return Err(format!(
            "no kind of work `{category}`; one of: {}",
            DIVISION.join(", ")
        ));
    }
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s == "auto" => Ok(None),
        Value::String(s) => {
            let ok = s
                .split_once(':')
                .is_some_and(|(k, uid)| matches!(k, "bot" | "assistant") && !uid.trim().is_empty());
            if ok {
                Ok(Some(s.clone()))
            } else {
                Err("a division pick is auto, bot:<uid> or assistant:<uid>".into())
            }
        }
        _ => Err("a division pick is auto, bot:<uid> or assistant:<uid>".into()),
    }
}

/// The account's preferences and team, as the page reads them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountView {
    pub prefs: Prefs,
    pub team: TeamSettings,
    /// The automation level the preferences add up to.
    #[serde(default)]
    pub automation_level: String,
}

impl AccountView {
    /// Read off the primary's settings JSON.
    pub fn from_settings(raw: &str) -> Self {
        let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        let prefs = Prefs::parse(v.get("prefs"));
        let automation_level = prefs.automation_level().to_string();
        Self {
            prefs,
            team: TeamSettings::parse(v.get("team")),
            automation_level,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_read_leniently_item_by_item() {
        let p = Prefs::parse(Some(&json!({
            "reply_length": "short",
            "cards": "holograms",
            "loop_rounds": "lots",
            "confirm_dispatch": "code",
        })));
        assert_eq!(p.reply_length, ReplyLength::Short);
        assert_eq!(p.cards, CardUse::Prefer, "an unknown word is the default");
        assert_eq!(p.loop_rounds, DEFAULT_LOOP_ROUNDS);
        assert_eq!(p.confirm_dispatch, ConfirmDispatch::Code);
        assert_eq!(Prefs::parse(None), Prefs::default());
        assert_eq!(Prefs::parse(Some(&json!("junk"))), Prefs::default());
    }

    #[test]
    fn every_item_checks_and_reads_back() {
        for s in PREFS {
            let stored = Prefs::default().get(s.key);
            assert!(!stored.is_null(), "{} is on Prefs", s.key);
            assert_eq!(check_pref(s.key, &stored).unwrap(), stored);
        }
        assert!(check_pref("reply_length", &json!("tiny")).is_err());
        assert!(check_pref("loop_rounds", &json!(1_001)).is_err());
        assert_eq!(check_pref("loop_rounds", &json!("5")).unwrap(), json!(5));
        assert!(check_pref("nope", &json!(1)).is_err());
    }

    #[test]
    fn the_automation_level_is_read_off_the_items() {
        let mut p = Prefs::default();
        assert_eq!(p.automation_level(), "standard");
        let mut map = p.to_map();
        for (k, v) in automation_preset("ask_more").unwrap() {
            map.insert(k.into(), v);
        }
        p = serde_json::from_value(Value::Object(map)).unwrap();
        assert_eq!(p.automation_level(), "ask_more");
        assert!(p.confirms(DispatchMode::Task) && !p.confirms(DispatchMode::Chat));
        p.followups = AskFirst::Auto;
        assert_eq!(p.automation_level(), "custom");
    }

    #[test]
    fn the_brain_reads_the_changes_and_the_whole_set() {
        let old = Prefs::default();
        let new = Prefs {
            reply_length: ReplyLength::Short,
            worker_handoff: WorkerHandoff::Direct,
            ..Prefs::default()
        };
        let lines = prefs_changes(&old, &new, false);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("replies → short"));
        assert_eq!(
            prefs_changes(&old, &new, true).len(),
            1,
            "a worker is not told the handoff"
        );
        let block = prefs_block(&new, true);
        assert!(block.contains("<codeg-prefs>") && block.contains("replies: short"));
        assert!(!block.contains("handing work"));
    }

    #[test]
    fn usage_and_division_check() {
        let u = ExecutorUsage {
            dispatch: true,
            modes: vec![
                DispatchMode::Session,
                DispatchMode::Task,
                DispatchMode::Task,
            ],
            projects: Some(vec![3, 1, 3]),
        }
        .checked()
        .unwrap();
        assert_eq!(u.modes, vec![DispatchMode::Task, DispatchMode::Session]);
        assert_eq!(u.projects, Some(vec![1, 3]));
        assert!(ExecutorUsage {
            modes: vec![],
            ..ExecutorUsage::default()
        }
        .checked()
        .is_err());
        assert_eq!(
            check_division("review", &json!("bot:abc"))
                .unwrap()
                .as_deref(),
            Some("bot:abc")
        );
        assert_eq!(check_division("review", &json!("auto")).unwrap(), None);
        assert!(check_division("review", &json!("person:abc")).is_err());
        assert!(check_division("cooking", &json!("auto")).is_err());
        let team = TeamSettings::parse(Some(&json!({
            "division": "junk",
            "usage": { "u1": { "dispatch": false }, "u3": { "modes": "junk" } },
        })));
        assert!(team.division.is_empty());
        assert!(!team.usage_of("u1").dispatch);
        assert_eq!(team.usage_of("u1").modes.len(), 3);
        assert!(team.usage_of("u2").is_default());
        assert!(
            team.usage_of("u3").is_default(),
            "one unreadable entry leaves the others"
        );
    }
}
