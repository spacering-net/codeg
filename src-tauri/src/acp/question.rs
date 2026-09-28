//! Interactive multiple-choice question ("ask the user") domain types.
//!
//! Mid-turn an agent can ask the user one or more multiple-choice questions and
//! BLOCK until the user answers — the `ask_user_question` MCP tool exposed by
//! `codeg-mcp`. Unlike live-feedback ([`crate::acp::feedback`]), which is a
//! non-blocking pull the user pushes into, a question PAUSES the agent's tool
//! call: the questions render as an interactive card above the conversation
//! input box (driven by [`crate::acp::session_state::SessionState`], in-memory
//! and turn-scoped — it is real-time steering, not durable history), and the
//! tool call returns only once the user submits their choices.
//!
//! This module holds the pieces shared across layers so the manager, the
//! delegation listener, the MCP companion plumbing, and the settings command
//! don't each grow their own copy:
//!   * [`QuestionSpec`] / [`QuestionOption`] — one question + its choices.
//!   * [`PendingQuestionState`] — the awaiting-answer set stored on the session.
//!   * [`QuestionAnswer`] / [`QuestionAnswerItem`] — the user's submission
//!     (frontend → backend).
//!   * [`QuestionOutcome`] / [`QuestionAnsweredItem`] — the self-describing
//!     result handed back to the blocked tool (so the companion can render it
//!     without re-holding the questions).
//!   * [`SessionQuestionAccess`] — the listener-facing trait the production
//!     `ConnectionManager` implements (kept here so the listener can be unit
//!     tested with an in-memory stub, mirroring `SessionFeedbackAccess`).
//!   * [`QuestionRuntimeConfig`] — the hot-swappable "is the feature on?" flag,
//!     read at MCP injection time (mirrors [`crate::acp::feedback`]).

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use agent_client_protocol::schema::v1::{
    CreateElicitationRequest, CreateElicitationResponse, ElicitationAcceptAction, ElicitationAction,
    ElicitationContentValue, ElicitationMode, ElicitationPropertySchema, ElicitationScope,
    MultiSelectItems, StringPropertySchema,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use tokio::sync::{oneshot, RwLock};

/// Max questions per `ask_user_question` call. Matches Claude Code's
/// `AskUserQuestion` contract; the JSON schema advertises the same `maxItems`.
pub const MAX_QUESTIONS: usize = 4;
/// Min / max selectable options per question. Fewer than two options is not a
/// meaningful choice; more than four overwhelms the card. Matches Claude Code.
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 4;
/// Max characters for a question's short `header` chip.
pub const MAX_HEADER_CHARS: usize = 12;
/// Per-field sanity bound (characters) for every agent/user-supplied free-text
/// field: the question text, each option label + description, and the free-text
/// "Other" answer. The full text rides in the broadcast event, the snapshot, and
/// the agent-facing tool result, so this caps the blast radius of a pathological
/// field — whether from a malformed agent (`parse_questions`) or a hand-rolled
/// client hitting `acp_answer_question` directly (`build_outcome`). The UI can't
/// produce anything this long.
pub const MAX_QUESTION_TEXT_CHARS: usize = 4096;

/// One selectable choice in a question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    /// Concise display text. A recommended option puts itself first and ends
    /// its label with "(Recommended)" (a string convention, like Claude Code).
    pub label: String,
    /// What this choice means / its trade-off. May be empty.
    pub description: String,
}

/// A single multiple-choice question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionSpec {
    /// Backend-minted stable id. Used as the answer correlation key instead of
    /// the question text (which Claude Code keys on) so duplicate question
    /// strings or reordering can't collide.
    pub id: String,
    /// The full question shown to the user.
    pub question: String,
    /// Short category label (≤ [`MAX_HEADER_CHARS`]) rendered as a chip.
    pub header: String,
    /// When true the user may select multiple options.
    pub multi_select: bool,
    /// The choices (0..=[`MAX_OPTIONS`]). Empty means free-text: the card
    /// renders only its always-present "Other" input (codex `request_user_input`
    /// and MCP-server elicitations both ask open questions this way; the
    /// codeg-mcp ask tool still requires [`MIN_OPTIONS`] at its own parse
    /// layer).
    pub options: Vec<QuestionOption>,
    /// True when the answer is a secret (codex `request_user_input` marks API
    /// keys etc. with `_meta.codex.isSecret`): the card masks the free-text
    /// input. Default false — absent on the wire for every non-secret source.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_secret: bool,
}

/// The pending (awaiting-answer) question set stored on
/// `SessionState.pending_question` and carried on `to_snapshot()` so a client
/// attaching mid-turn (cold attach, reconnect, another window) re-renders the
/// card even though the one-shot `QuestionRequest` event won't replay for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingQuestionState {
    pub question_id: String,
    pub questions: Vec<QuestionSpec>,
    pub created_at: DateTime<Utc>,
}

/// One question's answer (frontend → backend). `labels` carries the selected
/// option labels (and any free-text "Other" the user typed, which the host UI
/// always offers); single-select submits exactly one label. camelCase on the
/// wire — this is constructed by the frontend, not read from an event payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswerItem {
    pub question_id: String,
    pub labels: Vec<String>,
}

/// The user's full submission for a pending question set (frontend → backend →
/// the blocked tool). `declined` is set when the user dismissed the card
/// without choosing — the agent then proceeds with its own judgment.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionAnswer {
    #[serde(default)]
    pub answers: Vec<QuestionAnswerItem>,
    #[serde(default)]
    pub declined: bool,
}

/// One answered question, joined with its prompt text so the result is
/// self-describing (the companion renders it without holding the questions).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionAnsweredItem {
    pub question: String,
    pub header: String,
    pub multi_select: bool,
    /// The labels the user chose (or typed via "Other").
    pub selected: Vec<String>,
}

/// The resolved outcome delivered over the broker socket to the blocked tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOutcome {
    #[serde(default)]
    pub answers: Vec<QuestionAnsweredItem>,
    #[serde(default)]
    pub declined: bool,
}

/// What [`SessionQuestionAccess::register_question`] hands back to the listener:
/// the new question id plus the receiver to await the user's answer on.
pub struct RegisteredQuestion {
    pub question_id: String,
    pub answer_rx: oneshot::Receiver<QuestionOutcome>,
}

/// Listener-facing access to register / cancel a pending question on a parent
/// connection. The production impl (`ConnectionManagerQuestionLookup`) wraps the
/// `ConnectionManager`; tests use an in-memory stub. Mirrors
/// [`crate::acp::feedback::SessionFeedbackAccess`] and
/// `crate::acp::delegation::listener::ParentSessionLookup`.
#[async_trait]
pub trait SessionQuestionAccess: Send + Sync {
    /// Register a question set on the parent connection (resolved from the
    /// per-launch token), broadcast it to every attached client, and return a
    /// receiver that resolves when the user answers (or the question is
    /// canceled). `None` when the connection is gone — nothing to ask.
    async fn register_question(
        &self,
        parent_connection_id: &str,
        questions: Vec<QuestionSpec>,
    ) -> Option<RegisteredQuestion>;

    /// Cancel a pending question — the companion's tool call was canceled
    /// (peer-close) or the connection is tearing down. Removes it and clears
    /// the card on every client. No-op if it was already answered / gone.
    async fn cancel_question(&self, parent_connection_id: &str, question_id: &str);

    /// Cancel every pending question parked on a connection that is tearing
    /// down. Called from the `run_connection` cleanup guard (alongside the
    /// delegation `cancel_by_parent` cascade) so a question entry — and the
    /// listener task parked on it — is reclaimed synchronously on disconnect,
    /// rather than lingering until the companion's ask socket happens to close.
    /// No-op when the connection has no pending ask.
    async fn cancel_questions_by_parent(&self, parent_connection_id: &str);
}

/// Validate + parse the MCP `ask_user_question` arguments into typed
/// [`QuestionSpec`]s, minting a stable id per question. Enforces the contract
/// (1..=[`MAX_QUESTIONS`] questions, each with a non-empty question + header
/// ≤ [`MAX_HEADER_CHARS`] and [`MIN_OPTIONS`]..=[`MAX_OPTIONS`] labeled options)
/// so a malformed call is rejected synchronously with a helpful message the LLM
/// can fix, rather than round-tripping bad data. `multiSelect` defaults to
/// false; an option `description` defaults to empty (lenient).
pub fn parse_questions(arguments: &Value) -> Result<Vec<QuestionSpec>, String> {
    let arr = arguments
        .get("questions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "ask_user_question requires a `questions` array".to_string())?;
    if arr.is_empty() {
        return Err("ask_user_question requires at least one question".to_string());
    }
    if arr.len() > MAX_QUESTIONS {
        return Err(format!(
            "ask_user_question supports at most {MAX_QUESTIONS} questions per call"
        ));
    }
    let mut out = Vec::with_capacity(arr.len());
    for (qi, q) in arr.iter().enumerate() {
        let question = q
            .get("question")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("questions[{qi}] is missing a non-empty `question`"))?;
        if question.chars().count() > MAX_QUESTION_TEXT_CHARS {
            return Err(format!(
                "questions[{qi}] `question` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
            ));
        }
        let header = q
            .get("header")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("questions[{qi}] is missing a non-empty `header`"))?;
        if header.chars().count() > MAX_HEADER_CHARS {
            return Err(format!(
                "questions[{qi}] `header` exceeds {MAX_HEADER_CHARS} characters"
            ));
        }
        let multi_select = q
            .get("multiSelect")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let opts = q
            .get("options")
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("questions[{qi}] is missing an `options` array"))?;
        if opts.len() < MIN_OPTIONS || opts.len() > MAX_OPTIONS {
            return Err(format!(
                "questions[{qi}] must have between {MIN_OPTIONS} and {MAX_OPTIONS} options"
            ));
        }
        let mut options = Vec::with_capacity(opts.len());
        for (oi, o) in opts.iter().enumerate() {
            let label = o
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    format!("questions[{qi}].options[{oi}] is missing a non-empty `label`")
                })?;
            if label.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `label` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
            let description = o
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if description.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `description` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
            options.push(QuestionOption {
                label: label.to_string(),
                description,
            });
        }
        // Reject duplicate option labels within a question: the UI uses the
        // label as both the React key and the selection identity, and the
        // answer is submitted by label — duplicates would be ambiguous (select
        // one, select both) and collide on the key.
        let mut seen_labels = std::collections::HashSet::new();
        for o in &options {
            if !seen_labels.insert(o.label.as_str()) {
                return Err(format!(
                    "questions[{qi}] has duplicate option label {:?}",
                    o.label
                ));
            }
        }
        out.push(QuestionSpec {
            id: uuid::Uuid::new_v4().to_string(),
            question: question.to_string(),
            header: header.to_string(),
            multi_select,
            options,
            is_secret: false,
        });
    }
    Ok(out)
}

/// Re-assert the [`parse_questions`] count + size bounds on already-typed specs.
/// The companion validates before sending, but the broker socket is only
/// token-gated, so a hand-rolled client could bypass that path and ride
/// oversized or malformed specs straight into the broadcast `QuestionRequest`
/// event and the `pending_question` snapshot. The listener registers through
/// this, declining the ask on `Err` rather than trusting unbounded input — the
/// authoritative answer-side bounds already live in [`build_outcome`], so this
/// closes the matching gap on the request side. Bounds mirror `parse_questions`.
pub fn validate_specs(specs: &[QuestionSpec]) -> Result<(), String> {
    if specs.is_empty() || specs.len() > MAX_QUESTIONS {
        return Err(format!(
            "expected 1..={MAX_QUESTIONS} questions, got {}",
            specs.len()
        ));
    }
    let mut seen_ids = std::collections::HashSet::new();
    for (qi, q) in specs.iter().enumerate() {
        // `parse_questions` mints a fresh uuid per question; a hand-rolled client
        // could send empty / colliding ids, and the answer routing + UI state map
        // key on `id`, so duplicates would misroute or collide.
        if q.id.trim().is_empty() {
            return Err(format!("questions[{qi}] has an empty `id`"));
        }
        if !seen_ids.insert(q.id.as_str()) {
            return Err(format!("questions[{qi}] has a duplicate `id` {:?}", q.id));
        }
        if q.question.trim().is_empty() {
            return Err(format!("questions[{qi}] has an empty `question`"));
        }
        if q.question.chars().count() > MAX_QUESTION_TEXT_CHARS {
            return Err(format!(
                "questions[{qi}] `question` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
            ));
        }
        if q.header.trim().is_empty() {
            return Err(format!("questions[{qi}] has an empty `header`"));
        }
        if q.header.chars().count() > MAX_HEADER_CHARS {
            return Err(format!(
                "questions[{qi}] `header` exceeds {MAX_HEADER_CHARS} characters"
            ));
        }
        // Unlike `parse_questions` (the codeg-mcp tool contract, which keeps
        // its [`MIN_OPTIONS`] floor), typed specs allow 0..=[`MAX_OPTIONS`]:
        // a question with no options is a legal free-text ask — the card
        // renders its always-present "Other" input alone (codex elicitation
        // and MCP-server forms ask open questions this way).
        if q.options.len() > MAX_OPTIONS {
            return Err(format!(
                "questions[{qi}] must have at most {MAX_OPTIONS} options"
            ));
        }
        let mut seen_labels = std::collections::HashSet::new();
        for (oi, o) in q.options.iter().enumerate() {
            if o.label.trim().is_empty() {
                return Err(format!("questions[{qi}].options[{oi}] has an empty `label`"));
            }
            if o.label.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `label` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
            // Mirror parse_questions: labels are the React key + selection identity
            // and answers are submitted by label, so duplicates (trimmed) are
            // ambiguous.
            if !seen_labels.insert(o.label.trim()) {
                return Err(format!(
                    "questions[{qi}] has a duplicate option label {:?}",
                    o.label
                ));
            }
            if o.description.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `description` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
        }
    }
    Ok(())
}

/// Join the user's submission with the original questions into a self-describing
/// [`QuestionOutcome`], normalizing + validating against the stored specs. The
/// UI enforces these rules, but `acp_answer_question` is a plain API a stale or
/// hand-rolled client can hit directly, so the authoritative checks live here.
///
/// Iterates the TRUSTED `questions` (≤ [`MAX_QUESTIONS`]), not the client's
/// `answers`, so a flood of unknown / duplicate answer items can neither grow an
/// intermediate set nor bloat the output — extra items are simply never looked
/// up. For each spec question it takes the first matching answer (dedup) and:
///   * trims each label, drops empties, bounds each to [`MAX_QUESTION_TEXT_CHARS`];
///   * caps the count — single-select keeps 1, multi-select keeps at most every
///     real option plus one free-text "Other" (`options.len() + 1`);
///   * drops a question left with no usable label.
///
/// Output is therefore bounded by the question set's own size, in asked order.
/// A declined submission yields an empty, `declined: true` outcome.
pub fn build_outcome(questions: &[QuestionSpec], answer: &QuestionAnswer) -> QuestionOutcome {
    if answer.declined {
        return QuestionOutcome {
            answers: Vec::new(),
            declined: true,
        };
    }
    let answers = questions
        .iter()
        .filter_map(|spec| {
            let a = answer.answers.iter().find(|a| a.question_id == spec.id)?;
            // Cap selections to the question's own size: single-select → 1;
            // multi-select → every real option plus one "Other". Enforce the cap
            // DURING iteration (early break, allocate only kept labels) so a
            // pathological `labels` array can't do unbounded intermediate work.
            let cap = if spec.multi_select {
                spec.options.len() + 1
            } else {
                1
            };
            let mut labels: Vec<String> = Vec::with_capacity(cap);
            for l in &a.labels {
                if labels.len() == cap {
                    break;
                }
                let trimmed = l.trim();
                if trimmed.is_empty() {
                    continue;
                }
                labels.push(trimmed.chars().take(MAX_QUESTION_TEXT_CHARS).collect());
            }
            if labels.is_empty() {
                return None;
            }
            Some(QuestionAnsweredItem {
                question: spec.question.clone(),
                header: spec.header.clone(),
                multi_select: spec.multi_select,
                selected: labels,
            })
        })
        .collect();
    QuestionOutcome {
        answers,
        declined: false,
    }
}

/// Some native asks carry NO `header` (the short category chip codeg renders):
/// grok's `ask_user_question` tool and pi's extension-UI `select` both send bare
/// question text. Synthesize one from the leading characters, bounded to
/// [`MAX_HEADER_CHARS`]. Always returns a non-empty, in-bounds string so
/// [`validate_specs`] accepts it.
pub(crate) fn synthesize_header(question: &str) -> String {
    let header: String = question.trim().chars().take(MAX_HEADER_CHARS).collect();
    let header = header.trim();
    if header.is_empty() {
        "Ask".to_string()
    } else {
        header.to_string()
    }
}

/// Convert grok's native `_x.ai/ask_user_question` ext-request params into codeg
/// [`QuestionSpec`]s, so grok's own questions render in the SAME interactive card
/// as the `codeg-mcp` ask tool (grok emits an ACP ext request and blocks on the
/// reply; if codeg doesn't answer it, grok falls back to inert fire-and-forget
/// rendering — see the connection handler). Grok's wire shape per question is
/// `{question, options:[{label, description}], multiSelect}` — no `header`, which
/// we synthesize. Counts are clamped to codeg's bounds because
/// [`crate::acp::manager::ConnectionManager::register_question`] re-runs
/// [`validate_specs`] and would otherwise decline the whole ask: more than
/// [`MAX_QUESTIONS`] questions or [`MAX_OPTIONS`] options are truncated (logged,
/// never silently dropped), and duplicate option labels — which `validate_specs`
/// rejects as ambiguous — are deduped. A question left with fewer than
/// [`MIN_OPTIONS`] usable options is not a real choice and fails the request
/// (grok then falls back — no worse than before the bridge existed).
pub fn parse_grok_ext_questions(params: &Value) -> Result<Vec<QuestionSpec>, String> {
    let arr = params
        .get("questions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "ask_user_question ext request missing `questions` array".to_string())?;
    if arr.is_empty() {
        return Err("ask_user_question ext request has no questions".to_string());
    }
    if arr.len() > MAX_QUESTIONS {
        tracing::warn!(
            "[grok ask] dropping {} question(s) past the max of {MAX_QUESTIONS}",
            arr.len() - MAX_QUESTIONS
        );
    }
    let mut out = Vec::with_capacity(arr.len().min(MAX_QUESTIONS));
    for (qi, q) in arr.iter().take(MAX_QUESTIONS).enumerate() {
        let question = q
            .get("question")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("questions[{qi}] is missing a non-empty `question`"))?;
        let multi_select = q
            .get("multiSelect")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let opts = q
            .get("options")
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("questions[{qi}] is missing an `options` array"))?;
        if opts.len() > MAX_OPTIONS {
            tracing::warn!(
                "[grok ask] questions[{qi}] has {} options; truncating to {MAX_OPTIONS}",
                opts.len()
            );
        }
        let mut options = Vec::with_capacity(opts.len().min(MAX_OPTIONS));
        let mut seen_labels = std::collections::HashSet::new();
        for o in opts {
            if options.len() == MAX_OPTIONS {
                break;
            }
            let label = o
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let Some(label) = label else { continue };
            // `validate_specs` rejects duplicate labels (the label is the card's
            // React key + selection identity); dedup rather than fail the ask.
            if !seen_labels.insert(label.to_string()) {
                continue;
            }
            let description: String = o
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_QUESTION_TEXT_CHARS)
                .collect();
            options.push(QuestionOption {
                label: label.chars().take(MAX_QUESTION_TEXT_CHARS).collect(),
                description,
            });
        }
        if options.len() < MIN_OPTIONS {
            return Err(format!(
                "questions[{qi}] has fewer than {MIN_OPTIONS} usable options"
            ));
        }
        out.push(QuestionSpec {
            id: uuid::Uuid::new_v4().to_string(),
            question: question.chars().take(MAX_QUESTION_TEXT_CHARS).collect(),
            header: synthesize_header(question),
            multi_select,
            options,
            is_secret: false,
        });
    }
    Ok(out)
}

/// pi-acp's tool-call id prefix for an extension-UI request
/// (`extensionUiToolCall`, pi-acp 0.0.33). It is the only marker that
/// distinguishes a `ctx.ui.*` dialog from a real tool approval, since both
/// arrive as a plain `session/request_permission`. Public so the connection
/// handler can screen requests on it before paying for anything else — one
/// definition, so the cheap screen and the full parse can never drift.
pub const PI_EXTENSION_UI_ID_PREFIX: &str = "pi-ui-";

/// pi-acp's option-id prefix for a `select` choice (`CHOICE_OPTION_PREFIX`); it
/// maps the id back to the index of its own options array when replying to the
/// extension.
const PI_CHOICE_OPTION_PREFIX: &str = "choice-";

/// pi's extension-UI `select` ask, lifted off a `session/request_permission`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiSelectAsk {
    /// The single question to register on the interactive card.
    pub spec: QuestionSpec,
    /// `(option label, permission optionId)` in wire order. The user picks a
    /// LABEL on the card, but pi must be answered with the id that label arrived
    /// with — pi-acp turns it back into an index into its own options array — so
    /// the pairing has to survive the round trip.
    pub option_ids: Vec<(String, String)>,
}

/// Recognize a `session/request_permission` that is really pi asking the user a
/// multiple-choice question, and convert it into a [`QuestionSpec`] so it renders
/// in the SAME interactive card as the codeg-mcp ask tool.
///
/// pi has no dedicated question channel: `ctx.ui.select` from an extension
/// becomes an `extension_ui_request`, which pi-acp translates into a permission
/// request whose `toolCall` is a synthetic `{toolCallId: "pi-ui-<id>", kind:
/// "other", status: "pending", rawInput: {method: "select", title, options:
/// [...]}}` and whose permission options are the choices, keyed
/// `choice-<index>` (verified against pi-acp 0.0.33 on a live run). Without this
/// the choices render as a generic approval card that dumps that JSON verbatim.
///
/// Returns `None` — leaving the caller on the untouched permission path — for
/// anything that does not fingerprint as pi's select, and for a select the card
/// could not represent FAITHFULLY: more than [`MAX_OPTIONS`] choices (truncating
/// would hide choices the user must be able to pick), fewer than
/// [`MIN_OPTIONS`], or duplicate/blank labels (the label is the card's selection
/// identity, so a duplicate would answer pi with the wrong index). Those keep
/// today's approval card, which lists every option as its own button.
///
/// `options` is `(optionId, name)` in wire order.
pub fn parse_pi_select_ask(tool_call: &Value, options: &[(String, String)]) -> Option<PiSelectAsk> {
    let id = tool_call
        .get("toolCallId")
        .or_else(|| tool_call.get("tool_call_id"))
        .and_then(|v| v.as_str())?;
    if !id.starts_with(PI_EXTENSION_UI_ID_PREFIX) {
        return None;
    }
    let raw_input = tool_call
        .get("rawInput")
        .or_else(|| tool_call.get("raw_input"))?;
    if raw_input.get("method").and_then(|v| v.as_str()) != Some("select") {
        return None;
    }
    // The dialog prompt: `rawInput.title` is the extension's own text, while the
    // tool call's `title` falls back to a bare `Pi select` when it has none.
    let question = raw_input
        .get("title")
        .and_then(|v| v.as_str())
        .or_else(|| tool_call.get("title").and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    if !(MIN_OPTIONS..=MAX_OPTIONS).contains(&options.len()) {
        return None;
    }
    let mut choices = Vec::with_capacity(options.len());
    let mut option_ids = Vec::with_capacity(options.len());
    let mut seen = std::collections::HashSet::new();
    for (option_id, name) in options {
        if !option_id.starts_with(PI_CHOICE_OPTION_PREFIX) {
            return None;
        }
        let label = name.trim();
        if label.is_empty() || label.chars().count() > MAX_QUESTION_TEXT_CHARS {
            return None;
        }
        if !seen.insert(label) {
            return None;
        }
        choices.push(QuestionOption {
            label: label.to_string(),
            // pi's select carries no per-option description; the card renders
            // fine without one.
            description: String::new(),
        });
        option_ids.push((label.to_string(), option_id.clone()));
    }
    Some(PiSelectAsk {
        spec: QuestionSpec {
            id: uuid::Uuid::new_v4().to_string(),
            question: question.chars().take(MAX_QUESTION_TEXT_CHARS).collect(),
            header: synthesize_header(question),
            // `ctx.ui.select` resolves to ONE value; pi-acp's reply carries a
            // single `optionId`.
            multi_select: false,
            options: choices,
            is_secret: false,
        },
        option_ids,
    })
}

/// The permission `optionId` that answers pi with what the user picked, or
/// `None` when the card produced nothing pi can accept: a declined card, or a
/// free-text "Other" answer (the card always offers one, but pi's select can
/// only be answered with one of ITS options). `None` means reply `Cancelled`,
/// which pi-acp forwards to the extension as `{cancelled: true}` — the same
/// thing `ctx.ui.select` returns when a TUI user presses Escape.
pub fn pi_select_option_id(outcome: &QuestionOutcome, ask: &PiSelectAsk) -> Option<String> {
    if outcome.declined {
        return None;
    }
    let picked = outcome.answers.first()?.selected.first()?;
    ask.option_ids
        .iter()
        .find(|(label, _)| label == picked)
        .map(|(_, option_id)| option_id.clone())
}

/// True when a host's name for a tool is codeg's OWN `ask_user_question`
/// companion tool, in whatever spelling the host composed it
/// (`mcp__codeg-mcp__ask_user_question` from claude-agent-acp,
/// `codeg-mcp/ask_user_question`, `codeg-mcp: ask_user_question`, …). Separators
/// are folded and case is ignored, so only the two identifying words matter.
///
/// BOTH halves have to be present — the server name codeg itself injects
/// (`codeg-mcp`, see `acp::connection::inject_codeg_mcp`) AND the tool name.
/// The frontend can afford a bare `*ask_user_question` suffix rule because a
/// wrong match there only picks a nicer card; this one unlocks an AUTO-APPROVAL
/// of a blocked `session/request_permission`, and a third-party MCP server's
/// similarly named tool is the user's to approve, not codeg's.
///
/// Auto-approving codeg's own ask tool is not a permission being skipped: the
/// tool's entire effect is to put the interactive question card on screen and
/// block until the user answers it. The consent IS the next dialog, so gating it
/// behind a generic "run this tool?" card asks the user to approve being asked.
pub fn is_codeg_ask_tool_name(name: &str) -> bool {
    let normalized = name
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' ', '.', '/', ':'], "_");
    normalized.ends_with("ask_user_question") && normalized.contains("codeg_mcp")
}

/// Serialize a resolved [`QuestionOutcome`] into grok's `AskUserQuestionExtResponse`
/// — the reply to a `_x.ai/ask_user_question` ext request. Verified against grok
/// 0.2.101 on a real run: the response is internally tagged by `outcome`; the
/// `accepted` variant carries an `answers` map keyed by the QUESTION TEXT (grok's
/// questions have no id and it correlates the answer by text) whose value is a
/// bare string for single-select or an array for multi-select (grok's
/// `StringOrVec`), plus an empty `partial_answers`. A declined card maps to
/// `skip_interview` (a variant grok's enum accepts). A wrong shape only makes grok
/// fall back to inert rendering, so this can never regress the pre-bridge state.
pub fn build_grok_ext_response(outcome: &QuestionOutcome) -> Value {
    if outcome.declined {
        return grok_ext_skip_response();
    }
    let mut answers = serde_json::Map::new();
    for item in &outcome.answers {
        let value = if item.multi_select {
            Value::Array(item.selected.iter().cloned().map(Value::String).collect())
        } else {
            // Single-select keeps exactly one label (capped in `build_outcome`);
            // grok's `StringOrVec` wants a bare string here, not a 1-element array.
            match item.selected.first() {
                Some(label) => Value::String(label.clone()),
                None => continue,
            }
        };
        answers.insert(item.question.clone(), value);
    }
    serde_json::json!({
        "outcome": "accepted",
        "answers": Value::Object(answers),
        "partial_answers": Value::Object(serde_json::Map::new()),
    })
}

/// The `_x.ai/ask_user_question` reply for a declined card or an ask that was
/// canceled/torn down before the user submitted (the answer one-shot dropped).
/// Grok's `skip_interview` outcome — chosen over `cancelled` because the ACP
/// response enum only exposes `Accepted`/`ChatAboutThis`/`SkipInterview`.
pub fn grok_ext_skip_response() -> Value {
    serde_json::json!({ "outcome": "skip_interview" })
}

/// One selectable choice lifted from a schema property: the display `label`
/// (`title`, falling back to the wire value) and the `value` (`const` / `enum`
/// entry) the accept response must send back. The two differ when a generic
/// MCP server elicits with `enum` + `enumNames` (codex-acp normalizes that to
/// `oneOf` with `const` ≠ `title`); codex's own `request_user_input` sets them
/// identical. The typed schema drops per-option descriptions, so they are left
/// empty (the card renders fine without one).
struct ElicitationChoice {
    label: String,
    value: String,
}

fn string_prop_choices(s: &StringPropertySchema) -> Vec<ElicitationChoice> {
    if let Some(one_of) = &s.one_of {
        return one_of
            .iter()
            .map(|o| ElicitationChoice {
                label: if o.title.trim().is_empty() {
                    o.value.clone()
                } else {
                    o.title.clone()
                },
                value: o.value.clone(),
            })
            .collect();
    }
    if let Some(values) = &s.enum_values {
        return values
            .iter()
            .map(|v| ElicitationChoice {
                label: v.clone(),
                value: v.clone(),
            })
            .collect();
    }
    Vec::new()
}

fn multi_select_choices(items: &MultiSelectItems) -> Vec<ElicitationChoice> {
    match items {
        MultiSelectItems::Titled(t) => t
            .options
            .iter()
            .map(|o| ElicitationChoice {
                label: if o.title.trim().is_empty() {
                    o.value.clone()
                } else {
                    o.title.clone()
                },
                value: o.value.clone(),
            })
            .collect(),
        MultiSelectItems::String(u) => u
            .values
            .iter()
            .map(|v| ElicitationChoice {
                label: v.clone(),
                value: v.clone(),
            })
            .collect(),
        // `MultiSelectItems` is `#[non_exhaustive]`; an unknown item kind
        // yields no options — the question degrades to free text.
        _ => Vec::new(),
    }
}

/// How one form field's answer must be typed in the elicitation response.
/// MCP servers validate the accepted content against their schema, so a
/// boolean/number field answered with a string would be rejected — each
/// answer is rebuilt into the schema's own primitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElicitationFieldKind {
    /// Single-select or free-text string → bare string.
    Text,
    /// Multi-select array → string array.
    MultiSelect,
    /// Yes/No choice → JSON boolean.
    Boolean,
    /// Free-text parsed as f64 → JSON number (unparseable answers are omitted).
    Number,
    /// Free-text parsed as i64 → JSON integer (unparseable answers are omitted).
    Integer,
}

/// The response-side rebuild plan for one schema property, parallel (same
/// index) to the [`QuestionSpec`] minted for it. Keeps the property id, the
/// primitive kind, and the label→value map for choice fields — everything
/// [`build_elicitation_response`] needs that [`QuestionSpec`] (a shared wire
/// type the card renders) must not carry.
pub struct ElicitationField {
    /// Schema property name — the key the accepted content is sent under.
    pub id: String,
    pub kind: ElicitationFieldKind,
    /// Display label → wire value for choice fields. A label the user typed
    /// via "Other" (absent here) is sent verbatim.
    pub value_by_label: std::collections::HashMap<String, String>,
}

/// A form elicitation that renders as ask-card questions.
pub struct ElicitationQuestions {
    pub specs: Vec<QuestionSpec>,
    /// Parallel to `specs` (same index).
    pub fields: Vec<ElicitationField>,
    /// The elicitation's `toolCallId` (codex sets it to the `request_user_input`
    /// item id). The connection handler keys the synthesized in-stream result
    /// card to it, so the live card and the reloaded history card (parsed by
    /// `codex.rs` from the same id) are one card. `None` when the wire carried
    /// no session scope tool_call_id.
    pub tool_call_id: Option<String>,
}

/// One selectable option of an approval-style elicitation, shaped for the
/// permission card (`PermissionOptionInfo` mirrors these fields 1:1).
pub struct ElicitationApprovalOption {
    pub option_id: String,
    pub label: String,
    /// `allow_once` / `allow_always` / `reject_once` — the permission-option
    /// kinds the frontend already styles.
    pub kind: &'static str,
}

/// The reserved option id for rejecting an approval-style elicitation. Never
/// collides with a persist `const` (codex only mints `once`/`session`/`always`)
/// and is filtered out of the accept mapping defensively.
pub const ELICITATION_DECLINE_OPTION_ID: &str = "__decline";

/// A form elicitation that renders through the PERMISSION card rather than the
/// ask card: an MCP tool-call approval (`_meta.codex_approval_kind ==
/// "mcp_tool_call"`) or a message-only confirm (a form with no renderable
/// fields). Routing these through the permission flow keeps MCP approvals
/// looking exactly like they did before codeg advertised `elicitation.form`
/// (codex-acp then used `session/request_permission` with the same options).
pub struct ElicitationApproval {
    /// The human prompt ("Allow tool call?" / the MCP server's message).
    pub message: String,
    /// The tool call this approval correlates to (codex emits the mcpToolCall
    /// item before eliciting), when the wire carried one.
    pub tool_call_id: Option<String>,
    /// The selectable options in display order; always ends with the
    /// [`ELICITATION_DECLINE_OPTION_ID`] entry.
    pub options: Vec<ElicitationApprovalOption>,
    /// True when the accept response must echo the chosen option back as
    /// `content.persist` (the request carried codex's persist-choice
    /// property; codex-acp pops it into the app-server `_meta.persist`).
    pub persist_in_content: bool,
}

/// How a form `elicitation/create` request must be presented.
pub enum ElicitationPlan {
    Questions(ElicitationQuestions),
    Approval(ElicitationApproval),
}

/// Codex's synthetic free-text "Other" companion fields are named
/// `<questionId>__other` (`__other1`, `__other2`… on collision). The card
/// offers its own "Other" on every question, so companions are skipped and the
/// typed answer rides the main field (codex falls back to it).
///
/// Name-based, and deliberately kept alongside the `_meta` markers below.
///
/// codex-acp 1.12.0 renamed the companion to `<questionId>_note` — which this
/// deliberately does NOT match. `_note` is a plausible suffix for a REAL field
/// in a generic MCP server's form (`release_note`, `user_note`), and skipping
/// one would silently drop a question the user has to answer. The rename needs
/// no name heuristic anyway: `buildUserInputRequest` stamps
/// `_meta.codex.role = "user_note"` on the new companion unconditionally, so
/// [`codex_companion_role`] recognizes it exactly.
fn is_other_companion(id: &str) -> bool {
    let Some(pos) = id.rfind("__other") else {
        return false;
    };
    pos > 0 && id[pos + "__other".len()..].chars().all(|c| c.is_ascii_digit())
}

/// True when the raw schema property carries codex's own companion marker, the
/// `_meta.codex` half of [`is_other_companion`]: `isOtherAnswer: true`
/// (codex-acp ≤ 1.11.0) or `role: "user_note"` (≥ 1.12.0). Either one means the
/// property is the free-text companion of a sibling select question, so the
/// card must not render it as a question of its own.
///
/// Both markers are unconditional in `buildUserInputRequest` — the companion is
/// created and marked in the same expression — so this is the exact recognizer
/// for both generations, and the ONLY one for 1.12.0's `_note` naming.
fn codex_companion_role(raw: &Value, id: &str) -> Option<CodexUserInputShape> {
    let codex = codex_property_meta(raw, id)?;
    if codex.get("isOtherAnswer").and_then(Value::as_bool) == Some(true) {
        return Some(CodexUserInputShape::QuestionInDescription);
    }
    if codex.get("role").and_then(Value::as_str) == Some("user_note") {
        return Some(CodexUserInputShape::QuestionInTitle);
    }
    None
}

/// Which generation of codex-acp's `request_user_input` bridge produced a form
/// — i.e. which of a question property's `title` / `description` holds the
/// QUESTION, and which holds the short tab header.
///
/// codex-acp 1.12.0 swapped the two:
///
/// ```text
///   ≤ 1.11.0   title = header (the short tab label)   description = question
///   ≥ 1.12.0   title = question                       description = header
/// ```
///
/// Reading them the wrong way round is not cosmetic: a single-question ask has
/// no tab strip, so the card would show only the header ("Approach") and the
/// actual question would never be displayed at all.
///
/// The connection pins this at `initialize` from the RUNNING adapter's
/// `agentInfo.version` (`SessionState::codex_user_input_shape`) — codeg's pin is
/// 1.12.0, but launch may resolve an older PATH install or a custom pinned
/// version, and both are supported configurations.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CodexUserInputShape {
    /// codex-acp ≤ 1.11.0 — the question is in `description`, and the free-text
    /// companion is `<id>__other` marked `_meta.codex.isOtherAnswer`.
    QuestionInDescription,
    /// codex-acp ≥ 1.12.0 — the question is in `title`, the companion is
    /// `<id>_note` marked `_meta.codex.role = "user_note"`, and an `isOther`
    /// question's `oneOf` carries an injected "None of the above".
    QuestionInTitle,
}

/// Who sent this `elicitation/create` — and the ONLY thing that may unlock a
/// codex-specific fixup in this parser.
///
/// The identity has to come from the connection, not from the payload. `_meta`
/// is an OPEN namespace: the ACP spec tells implementations to make no
/// assumptions about keys they do not own, and this parser is shared — codeg
/// advertises `elicitation.form` to DeepSeek as well as Codex, and EITHER
/// adapter also forwards arbitrary MCP-server forms through it. Deciding "this
/// is codex" from `_meta.codex.*` in the request would let a third party, by
/// coincidence or on purpose, switch on codex's orientation flip, its companion
/// skip and its synthetic-option filter for a form codex never sent — which can
/// hide a legitimate field or change how an answer is encoded.
///
/// So `Other` is absolute: no codex fixup runs for it, whatever `_meta` claims.
/// Only inside `Codex` does the payload get a say, and then only about WHICH
/// generation sent it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ElicitationPeer {
    /// Anything that is not codex-acp (DeepSeek today; any future
    /// `elicitation.form` speaker). The form is parsed generically.
    Other,
    /// codex-acp, carrying the `request_user_input` shape its RUNNING version
    /// implies — `None` when `agentInfo.version` was absent or unparseable, in
    /// which case the form's own markers have to date it.
    Codex(Option<CodexUserInputShape>),
}

impl ElicitationPeer {
    /// Whether codex's `_meta.codex` markers may be trusted on this connection.
    fn is_codex(self) -> bool {
        matches!(self, Self::Codex(_))
    }
}

/// The `_meta.codex` object of one schema property, when present. codex-acp
/// stamps it on every `request_user_input` field (question properties carry
/// `isOther`/`isSecret`, companions carry `questionId` plus the role marker),
/// and on nothing else — a generic MCP server's form has no `codex` namespace.
/// The typed schema property structs carry no `_meta`, so this reads the raw
/// JSON.
fn codex_property_meta<'a>(raw: &'a Value, id: &str) -> Option<&'a Value> {
    raw.get("requestedSchema")?
        .get("properties")?
        .get(id)?
        .get("_meta")?
        .get("codex")
}

/// Resolve a form's [`CodexUserInputShape`], or `None` when no codex-specific
/// reading may be applied to it.
///
/// `None` is load-bearing well beyond orientation — it is the single switch that
/// keeps EVERY 1.12.0 fixup (the orientation flip and the injected "None of the
/// above") off forms codex did not send. Two independent things have to hold
/// before it returns `Some`:
///
///   * the PEER is codex-acp ([`ElicitationPeer`]). This comes from the
///     connection, never from the payload, because DeepSeek and arbitrary
///     MCP-server forms share this parser and `_meta` is an open namespace;
///   * the FORM is one of codex's `request_user_input` asks rather than an MCP
///     tool-call approval or a server form codex is merely relaying —
///     `buildUserInputRequest` stamps `_meta.codex.isOther` on every question
///     property in both generations, and only it does.
///
/// Which generation then sent it is the remaining question, and nothing in the
/// form distinguishes the two reliably — question properties look identical —
/// so the answer comes from the ADAPTER, in descending order of authority:
///
///   1. `running` — the version the connection read out of the running
///      adapter's `agentInfo` at `initialize`. This is the process that built
///      the frame, so it is authoritative when known.
///   2. The form's own free-text companion marker (`isOtherAnswer` ⇒ ≤1.11.0,
///      `role: "user_note"` ⇒ ≥1.12.0), for the case where the adapter reported
///      no `agentInfo` at all. Only present when the form has an `isOther`
///      question.
///   3. The pinned adapter's shape, which is 1.12.0's — the last resort for an
///      undatable form from an unidentified adapter, and the likeliest truth
///      since the pin is what codeg launches.
fn codex_form_shape(raw: &Value, peer: ElicitationPeer) -> Option<CodexUserInputShape> {
    // Identity first, and unconditionally: a non-codex peer gets the generic
    // reading no matter what its `_meta` says.
    let ElicitationPeer::Codex(running) = peer else {
        return None;
    };
    let properties = raw
        .get("requestedSchema")?
        .get("properties")?
        .as_object()?;
    let mut is_codex_form = false;
    let mut companion_shape = None;
    for id in properties.keys() {
        if let Some(shape) = codex_companion_role(raw, id) {
            companion_shape = Some(shape);
            continue;
        }
        is_codex_form |= codex_property_meta(raw, id)
            .is_some_and(|codex| codex.get("isOther").is_some());
    }
    if !is_codex_form && companion_shape.is_none() {
        return None;
    }
    Some(
        running
            .or(companion_shape)
            .unwrap_or(CodexUserInputShape::QuestionInTitle),
    )
}

/// The synthetic choice codex-acp ≥1.12.0 appends to an `isOther` question's
/// `oneOf`, verbatim — label and description both.
///
/// codeg's card already offers a free-text "Other" input on every question and
/// writes it to the MAIN field, while the note field this option points at is
/// skipped as a companion. So the option is a dead end here: picking it sends
/// codex the bare string "None of the above" and no elaboration.
///
/// "None of the above" is an entirely plausible option for a MODEL to write, and
/// codex-acp suppresses its own injection when one already did
/// (`!options.some(o => o.label === USER_INPUT_OTHER_OPTION)`) — so dropping a
/// bare label match would silently delete a real choice. Four conditions must
/// hold together before one is removed, and each narrows a different axis:
///
///   * the PEER is codex-acp ([`ElicitationPeer`]) — DeepSeek and generic MCP
///     forms share this parser and are never touched, and that is decided from
///     the connection rather than from the form's `_meta`;
///   * the form is a codex ≥1.12.0 `request_user_input`;
///   * the property is an `isOther` question — the only kind codex injects into;
///   * THIS choice's own raw `oneOf` entry — located by its `const`, not by
///     scanning the array — carries codex's description verbatim.
///
/// That last point is why the match is by `const` rather than "does the array
/// contain a synthetic entry anywhere": a scan drops any option that merely
/// SHARES the label with a synthetic one sitting elsewhere in the same `oneOf`.
/// A conforming codex cannot produce that pair — it builds every option as
/// `{const: label, title: label}` and skips its injection entirely when the
/// label is taken — but "the adapter would never" is not a property worth
/// relying on when the exact check costs nothing.
///
/// Every failure lands on "keep the option". If upstream rewords the copy the
/// filter simply stops firing and the redundant choice reappears.
const CODEX_SYNTHETIC_OTHER_LABEL: &str = "None of the above";
const CODEX_SYNTHETIC_OTHER_DESCRIPTION: &str = "Provide a different answer in the note field.";

/// True when this property is an `isOther` codex question, i.e. the only place
/// codex-acp ≥1.12.0 injects [`CODEX_SYNTHETIC_OTHER_LABEL`].
fn is_codex_other_question(raw: &Value, id: &str) -> bool {
    codex_property_meta(raw, id)
        .and_then(|codex| codex.get("isOther"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// True when THIS choice is codex's injected option: its label and its `const`
/// are both [`CODEX_SYNTHETIC_OTHER_LABEL`], and the raw `oneOf` entry carrying
/// that same `const` describes it exactly as codex-acp does. Callers must have
/// already established the peer, the form's generation and the property's
/// `isOther`-ness.
///
/// `value` is the choice's `const`, which is what pins the lookup to the entry
/// being rendered instead of to any entry in the array.
fn is_codex_synthetic_other_choice(raw: &Value, id: &str, label: &str, value: &str) -> bool {
    // codex writes `const: option.label` for every option, injected or
    // model-authored, so a choice whose `const` is not the synthetic label is
    // someone else's option that happens to display the same text.
    if label != CODEX_SYNTHETIC_OTHER_LABEL || value != CODEX_SYNTHETIC_OTHER_LABEL {
        return false;
    }
    let Some(one_of) = raw
        .get("requestedSchema")
        .and_then(|s| s.get("properties"))
        .and_then(|p| p.get(id))
        .and_then(|prop| prop.get("oneOf"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    one_of.iter().any(|entry| {
        entry.get("const").and_then(Value::as_str) == Some(value)
            && entry.get("description").and_then(Value::as_str)
                == Some(CODEX_SYNTHETIC_OTHER_DESCRIPTION)
    })
}

/// True when the raw schema property carries the shared custom-answer marker
/// (`_meta._askUserQuestionCustomAnswer.isCustomAnswer`), i.e. it is the
/// free-text "Other" companion of a sibling select question.
///
/// claude-agent-acp 0.64.0 (#929) introduced this key deliberately WITHOUT an
/// agent namespace so every AskUserQuestion bridge can be recognized the same
/// way; its own companion fields are named `question_<n>_custom`, which
/// [`is_other_companion`]'s `__other` heuristic does not match. Reading the
/// marker means codeg keeps collapsing the companion into the card's built-in
/// "Other" input no matter which adapter produced the form.
///
/// Like [`is_secret_property`], this reads the raw JSON: the typed schema
/// property structs carry no `_meta`.
fn is_custom_answer_property(raw: &Value, id: &str) -> bool {
    raw.get("requestedSchema")
        .and_then(|s| s.get("properties"))
        .and_then(|p| p.get(id))
        .and_then(|prop| prop.get("_meta"))
        .and_then(|m| m.get("_askUserQuestionCustomAnswer"))
        .and_then(|c| c.get("isCustomAnswer"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// True when the request is codex's MCP tool-call approval elicitation. The
/// marker rides the request `_meta` verbatim (codex-acp passes the app-server
/// `_meta` through), NOT under the `codex` namespace.
fn is_mcp_tool_call_approval(raw: &Value) -> bool {
    raw.get("_meta")
        .and_then(|m| m.get("codex_approval_kind"))
        .and_then(Value::as_str)
        == Some("mcp_tool_call")
}

/// Classify a form `elicitation/create` request (the raw JSON params) into its
/// presentation plan. Everything codex-acp can send once `elicitation.form` is
/// advertised lands here, so every shape must resolve to SOMETHING the user
/// can act on — an unhandled shape would stall or silently reject the agent's
/// blocked request:
///
///   * MCP tool-call approvals (`_meta.codex_approval_kind`) → [`ElicitationApproval`]
///     with the persist choices (`once`/`session`/`always`) + Decline — the
///     permission card, exactly like the pre-capability `request_permission`
///     fallback. This includes approvals for codeg-mcp's OWN tools in
///     consent-requiring permission modes, so declining them here would break
///     ask/delegation for codex outright.
///   * Forms with no renderable fields (message-only MCP confirms) →
///     [`ElicitationApproval`] with Accept/Decline.
///   * Everything else (codex `request_user_input`, generic MCP forms) →
///     [`ElicitationQuestions`]: string `oneOf`/`enum` render as choices
///     (title displayed, `const` sent back), plain strings/numbers/integers as
///     free text, booleans as Yes/No, arrays as multi-select; the free-text
///     companion is skipped (the card has its own "Other").
///
/// `peer` is who the connection is talking to — see [`ElicitationPeer`]. It is
/// the sole gate on every codex-specific fixup here, and for a codex peer it
/// also carries what `initialize` learned about the running adapter
/// (`SessionState::codex_user_input_shape`), which settles the one thing the
/// wire cannot: which of a codex question's `title`/`description` is the
/// question — see [`CodexUserInputShape`]. `Codex(None)` is safe: the parser
/// then dates the form from its own markers and falls back to the pinned
/// adapter's shape.
///
/// Counts are clamped to codeg's bounds because
/// [`crate::acp::manager::ConnectionManager::register_question`] re-runs
/// [`validate_specs`]. Errors only on non-form / undeserializable requests,
/// which the connection handler turns into a graceful decline.
pub fn classify_elicitation(
    raw: &Value,
    peer: ElicitationPeer,
) -> Result<ElicitationPlan, String> {
    let req: CreateElicitationRequest = serde_json::from_value(raw.clone())
        .map_err(|e| format!("unparseable elicitation request: {e}"))?;
    let ElicitationMode::Form(form) = &req.mode else {
        // codeg only advertises `elicitation.form` — URL mode goes down
        // codex-acp's `request_permission` fallback and never reaches here.
        return Err("elicitation is not form mode".to_string());
    };
    let message: String = req
        .message
        .trim()
        .chars()
        .take(MAX_QUESTION_TEXT_CHARS)
        .collect();
    let tool_call_id = match &form.scope {
        ElicitationScope::Session(s) => s.tool_call_id.as_ref().map(|t| t.0.to_string()),
        _ => None,
    };
    if is_mcp_tool_call_approval(raw) {
        return Ok(ElicitationPlan::Approval(approval_from_form(
            form,
            message,
            tool_call_id,
        )));
    }
    let mut questions = parse_form_questions(form, raw, peer);
    if questions.specs.is_empty() {
        // A form with nothing to fill in is a bare confirmation — mirror
        // codex-acp's own no-capability fallback (Accept/Decline options).
        return Ok(ElicitationPlan::Approval(ElicitationApproval {
            message,
            tool_call_id,
            options: vec![
                ElicitationApprovalOption {
                    option_id: "accept".to_string(),
                    label: "Accept".to_string(),
                    kind: "allow_once",
                },
                decline_approval_option(),
            ],
            persist_in_content: false,
        }));
    }
    // Carry the elicitation's tool_call_id so the connection handler can key the
    // synthesized in-stream result card to it — codex delivers `request_user_input`
    // ONLY as this elicitation, never as a stream tool_call.
    questions.tool_call_id = tool_call_id;
    Ok(ElicitationPlan::Questions(questions))
}

fn decline_approval_option() -> ElicitationApprovalOption {
    ElicitationApprovalOption {
        option_id: ELICITATION_DECLINE_OPTION_ID.to_string(),
        label: "Decline".to_string(),
        kind: "reject_once",
    }
}

/// Build the approval plan for an MCP tool-call approval elicitation. The
/// request's only (optional) field is codex-acp's injected `persist` choice —
/// `oneOf` of `once` (+ `session`/`always` when codex advertises them). Its
/// options become the allow choices (wire titles displayed, `const` as the
/// option id) plus Decline; with no persist property the choices are plain
/// Allow/Decline. Mirrors codex-acp's own `request_permission` fallback
/// (`buildToolApprovalOptions`) so approvals look identical either way.
fn approval_from_form(
    form: &agent_client_protocol::schema::v1::ElicitationFormMode,
    message: String,
    tool_call_id: Option<String>,
) -> ElicitationApproval {
    let persist_choices = form
        .requested_schema
        .properties
        .get("persist")
        .and_then(|p| match p {
            ElicitationPropertySchema::String(s) => Some(string_prop_choices(s)),
            _ => None,
        })
        .filter(|c| !c.is_empty());
    let persist_in_content = persist_choices.is_some();
    let mut options = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(choices) = persist_choices {
        for c in choices {
            if options.len() == MAX_OPTIONS {
                break;
            }
            let value = c.value.trim();
            if value.is_empty()
                || value == ELICITATION_DECLINE_OPTION_ID
                || !seen.insert(value.to_string())
            {
                continue;
            }
            options.push(ElicitationApprovalOption {
                option_id: value.to_string(),
                label: if c.label.trim().is_empty() {
                    value.to_string()
                } else {
                    c.label.trim().chars().take(MAX_QUESTION_TEXT_CHARS).collect()
                },
                kind: if value == "once" {
                    "allow_once"
                } else {
                    "allow_always"
                },
            });
        }
    }
    if options.is_empty() {
        options.push(ElicitationApprovalOption {
            option_id: "accept".to_string(),
            label: "Allow".to_string(),
            kind: "allow_once",
        });
    }
    options.push(decline_approval_option());
    ElicitationApproval {
        message,
        tool_call_id,
        options,
        persist_in_content,
    }
}

/// True when the raw schema property carries codex's secret marker
/// (`_meta.codex.isSecret`). The typed schema property structs carry no
/// `_meta`, so this reads the raw JSON alongside them.
fn is_secret_property(raw: &Value, id: &str) -> bool {
    raw.get("requestedSchema")
        .and_then(|s| s.get("properties"))
        .and_then(|p| p.get(id))
        .and_then(|prop| prop.get("_meta"))
        .and_then(|m| m.get("codex"))
        .and_then(|c| c.get("isSecret"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Convert a form's schema properties into ask-card questions + their typed
/// rebuild plans (see [`classify_elicitation`] for the shape taxonomy). A
/// property with no usable choices renders as free text (the card's
/// always-present "Other" input) — including plain strings, numbers, integers,
/// and choice fields whose options were all empty/duplicate.
fn parse_form_questions(
    form: &agent_client_protocol::schema::v1::ElicitationFormMode,
    raw: &Value,
    peer: ElicitationPeer,
) -> ElicitationQuestions {
    // Decided once for the whole form: codex-acp 1.12.0 swapped which of
    // `title`/`description` carries the question (see [`codex_form_shape`]).
    let codex_shape = codex_form_shape(raw, peer);
    // The 1.12.0-only fixups below apply to exactly one generation of exactly
    // one adapter; everything else — DeepSeek, generic MCP servers — shares this
    // parser and must come through untouched.
    let is_codex_112_form = codex_shape == Some(CodexUserInputShape::QuestionInTitle);
    // `_meta.codex` is only codex's to interpret. On any other peer the same
    // keys are an unrelated extension that must not silently eat a field.
    let peer_is_codex = peer.is_codex();
    let mut specs = Vec::new();
    let mut fields = Vec::new();
    for (id, prop) in &form.requested_schema.properties {
        if specs.len() == MAX_QUESTIONS {
            tracing::warn!(
                "[codex elicitation] dropping question(s) past the max of {MAX_QUESTIONS}"
            );
            break;
        }
        // Skip synthetic free-text "Other" companion fields — codex's
        // name-based `<id>__other[N]` shape, codex's own `_meta.codex` marker
        // in either generation (codex peers only: on anything else those keys
        // are not codex's and dropping the field would hide a real question),
        // and any adapter's `_meta`-marked companion (claude-agent-acp ≥0.64,
        // deliberately un-namespaced so every bridge is recognized alike).
        // The card always offers its own "Other" input, so a companion would
        // render as a duplicate question.
        if is_other_companion(id)
            || (peer_is_codex && codex_companion_role(raw, id).is_some())
            || is_custom_answer_property(raw, id)
        {
            continue;
        }
        let (title, description, kind, multi_select, choices) = match prop {
            ElicitationPropertySchema::String(s) => (
                s.title.clone(),
                s.description.clone(),
                ElicitationFieldKind::Text,
                false,
                string_prop_choices(s),
            ),
            ElicitationPropertySchema::Array(a) => (
                a.title.clone(),
                a.description.clone(),
                ElicitationFieldKind::MultiSelect,
                true,
                multi_select_choices(&a.items),
            ),
            ElicitationPropertySchema::Boolean(b) => (
                b.title.clone(),
                b.description.clone(),
                ElicitationFieldKind::Boolean,
                false,
                vec![
                    ElicitationChoice {
                        label: "Yes".to_string(),
                        value: "true".to_string(),
                    },
                    ElicitationChoice {
                        label: "No".to_string(),
                        value: "false".to_string(),
                    },
                ],
            ),
            ElicitationPropertySchema::Number(n) => (
                n.title.clone(),
                n.description.clone(),
                ElicitationFieldKind::Number,
                false,
                Vec::new(),
            ),
            ElicitationPropertySchema::Integer(i) => (
                i.title.clone(),
                i.description.clone(),
                ElicitationFieldKind::Integer,
                false,
                Vec::new(),
            ),
            // `ElicitationPropertySchema` is `#[non_exhaustive]`; a future
            // property type has no rendering here, so skip it (the agent
            // reads the missing key as unanswered and proceeds).
            _ => continue,
        };
        // Which string is the question and which is the tab label. Everything
        // except a codex-acp ≥1.12.0 `request_user_input` form keeps the
        // original reading (`description` is the prose, `title` the label);
        // 1.12.0 swapped codex's two slots, so that one form is read the other
        // way round. See [`codex_form_shape`].
        let (question_text, header_text) = if is_codex_112_form {
            (&title, &description)
        } else {
            (&description, &title)
        };
        let question = question_text
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                header_text
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or(id.as_str());
        // Dedup + clamp option labels exactly like the grok bridge, keeping
        // the label→value map for the response rebuild.
        let drop_synthetic_other = is_codex_112_form && is_codex_other_question(raw, id);
        let mut options = Vec::with_capacity(choices.len().min(MAX_OPTIONS));
        let mut value_by_label = std::collections::HashMap::new();
        let mut seen = std::collections::HashSet::new();
        for c in &choices {
            if options.len() == MAX_OPTIONS {
                break;
            }
            let label = c.label.trim();
            if label.is_empty() || !seen.insert(label.to_string()) {
                continue;
            }
            // codex-acp ≥1.12.0's injected "None of the above" choice — the
            // card's own "Other" input already covers it, and better.
            if drop_synthetic_other && is_codex_synthetic_other_choice(raw, id, label, &c.value) {
                continue;
            }
            let label: String = label.chars().take(MAX_QUESTION_TEXT_CHARS).collect();
            value_by_label.insert(label.clone(), c.value.clone());
            options.push(QuestionOption {
                label,
                description: String::new(),
            });
        }
        let header = header_text
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|h| h.chars().take(MAX_HEADER_CHARS).collect())
            .unwrap_or_else(|| synthesize_header(question));
        specs.push(QuestionSpec {
            id: id.clone(),
            question: question.chars().take(MAX_QUESTION_TEXT_CHARS).collect(),
            header,
            multi_select,
            options,
            is_secret: is_secret_property(raw, id),
        });
        fields.push(ElicitationField {
            id: id.clone(),
            kind,
            value_by_label,
        });
    }
    // `tool_call_id` is filled in by `classify_elicitation` (which reads the
    // form scope); the parser itself only shapes the questions.
    ElicitationQuestions {
        specs,
        fields,
        tool_call_id: None,
    }
}

/// "Yes"/"No" answers (and free-text variants) for a boolean field.
fn parse_bool_answer(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "y" => Some(true),
        "false" | "no" | "n" => Some(false),
        _ => None,
    }
}

/// Serialize a resolved [`QuestionOutcome`] into the elicitation response.
/// The agent keys answers by the schema property id, which [`QuestionOutcome`]
/// drops — so correlate each answered item back to its spec by
/// `(question, header)` (unique per ask) and rebuild the value through the
/// parallel [`ElicitationField`]: chosen labels map back to their wire values
/// (free-text "Other" answers ride verbatim), typed per the field's kind — an
/// answer that can't be coerced (e.g. non-numeric text for a number field) is
/// omitted rather than sent mistyped. A declined card or an empty result maps
/// to `Decline`, which the agent reads as "no answer" and proceeds — never
/// worse than the pre-bridge behavior.
///
/// Every value is written under the MAIN field id, including a free-text
/// "Other": the companion property skipped by [`is_custom_answer_property`] /
/// [`is_other_companion`] is never written back. That is correct for codex,
/// which falls back to the main field. If codeg ever advertises
/// `elicitation.form` to an agent that requires the answer under the companion
/// key instead (claude-agent-acp reads `question_<n>_custom` separately), this
/// has to route the free-text answer there using the marker's `questionId`.
pub fn build_elicitation_response(
    questions: &ElicitationQuestions,
    outcome: &QuestionOutcome,
) -> CreateElicitationResponse {
    if outcome.declined {
        return elicitation_decline_response();
    }
    let mut content: BTreeMap<String, ElicitationContentValue> = BTreeMap::new();
    for item in &outcome.answers {
        let Some(idx) = questions
            .specs
            .iter()
            .position(|s| s.question == item.question && s.header == item.header)
        else {
            continue;
        };
        let field = &questions.fields[idx];
        let mapped: Vec<String> = item
            .selected
            .iter()
            .map(|l| field.value_by_label.get(l).cloned().unwrap_or_else(|| l.clone()))
            .collect();
        let value = match field.kind {
            ElicitationFieldKind::Text => match mapped.into_iter().next() {
                Some(v) => ElicitationContentValue::String(v),
                None => continue,
            },
            ElicitationFieldKind::MultiSelect => ElicitationContentValue::StringArray(mapped),
            ElicitationFieldKind::Boolean => {
                match mapped.first().and_then(|v| parse_bool_answer(v)) {
                    Some(b) => ElicitationContentValue::Boolean(b),
                    None => continue,
                }
            }
            ElicitationFieldKind::Number => {
                match mapped
                    .first()
                    .and_then(|v| v.trim().parse::<f64>().ok())
                    .filter(|f| f.is_finite())
                {
                    Some(f) => ElicitationContentValue::Number(f),
                    None => continue,
                }
            }
            ElicitationFieldKind::Integer => {
                match mapped.first().and_then(|v| v.trim().parse::<i64>().ok()) {
                    Some(i) => ElicitationContentValue::Integer(i),
                    None => continue,
                }
            }
        };
        content.insert(field.id.clone(), value);
    }
    if content.is_empty() {
        return elicitation_decline_response();
    }
    CreateElicitationResponse::new(ElicitationAction::Accept(
        ElicitationAcceptAction::new().content(content),
    ))
}

/// Serialize the user's permission-card choice for an approval-style
/// elicitation. The decline option (and any unknown option id, defensively)
/// maps to `Decline`; an allow choice maps to `Accept`, echoing the chosen
/// persist value back as `content.persist` when the request carried the
/// persist property (codex-acp pops it into the app-server `_meta.persist`;
/// a plain Accept sends no content, which codex-acp reads the same as
/// `content: null`).
pub fn build_elicitation_approval_response(
    approval: &ElicitationApproval,
    option_id: &str,
) -> CreateElicitationResponse {
    let accepted = option_id != ELICITATION_DECLINE_OPTION_ID
        && approval.options.iter().any(|o| o.option_id == option_id);
    if !accepted {
        return elicitation_decline_response();
    }
    let mut accept = ElicitationAcceptAction::new();
    if approval.persist_in_content {
        let mut content: BTreeMap<String, ElicitationContentValue> = BTreeMap::new();
        content.insert(
            "persist".to_string(),
            ElicitationContentValue::String(option_id.to_string()),
        );
        accept = accept.content(content);
    }
    CreateElicitationResponse::new(ElicitationAction::Accept(accept))
}

/// The elicitation reply for a declined / unrenderable / torn-down ask.
/// `Decline` makes the agent proceed with its own judgment (it reads it as no
/// answer), so no path through the bridge can regress the pre-bridge behavior.
pub fn elicitation_decline_response() -> CreateElicitationResponse {
    CreateElicitationResponse::new(ElicitationAction::Decline)
}

/// The elicitation reply when the pending card is torn down without a user
/// choice (turn cancel, disconnect): `Cancel`, mirroring codex-acp's own
/// "cancelled" outcome mapping.
pub fn elicitation_cancel_response() -> CreateElicitationResponse {
    CreateElicitationResponse::new(ElicitationAction::Cancel)
}

/// Build the `raw_input` (questions) for the in-stream `AskQuestionResultCard`
/// codeg synthesizes for a native ask that resolves out-of-band rather than as a
/// completed stream tool_call. Three callers: grok (answers over the
/// `_x.ai/ask_user_question` ext round-trip — `handle_grok_ask_user_question`),
/// codex `request_user_input` (answers over the `elicitation/create` round-trip
/// — `handle_elicitation_request`), and pi's extension-UI `select` (answers over
/// the `session/request_permission` round-trip — `try_bridge_pi_select_ask`).
/// None of them emits a completed tool result into the ACP stream, so the
/// connection handler emits this once the user submits.
///
/// Deliberately omits `header`, so the frontend parses `header:""` and matches
/// answers to questions by `question` text alone. The paired
/// [`grok_result_card_output`] uses the SAME empty header. For grok this is exact
/// live↔reload parity (its history parser emits `header:""` too); for codex the
/// reloaded history card (`codex.rs`) does carry the question header, so a
/// multi-question ask shows header tab labels after reload but not live — a
/// cosmetic gap only (single-question asks, the common case, render identically
/// and the answer always shows). Built from the already-clamped [`QuestionSpec`]s
/// so input and output stay in lockstep.
pub fn grok_result_card_input(specs: &[QuestionSpec]) -> Value {
    let questions: Vec<Value> = specs
        .iter()
        .map(|s| {
            serde_json::json!({
                "question": s.question,
                "multiSelect": s.multi_select,
                "options": s.options,
            })
        })
        .collect();
    serde_json::json!({ "questions": questions })
}

/// Build the `raw_output` (`{answers, declined}` envelope) for the in-stream
/// `AskQuestionResultCard` — the codeg-mcp `structuredContent` shape the frontend
/// already parses (`parseAskQuestionOutcome`). Emits `header:""` to match
/// [`grok_result_card_input`] (see its docs). Companion to [`grok_result_card_input`].
pub fn grok_result_card_output(outcome: &QuestionOutcome) -> Value {
    let answers: Vec<Value> = outcome
        .answers
        .iter()
        .map(|a| {
            serde_json::json!({
                "header": "",
                "question": a.question,
                "multi_select": a.multi_select,
                "selected": a.selected,
            })
        })
        .collect();
    serde_json::json!({ "answers": answers, "declined": outcome.declined })
}

/// The hot-swappable feature config read at MCP injection time. Kept tiny and
/// separate from `FeedbackConfig` / `DelegationConfig` so the three features
/// toggle independently — `codeg-mcp` is injected when ANY is enabled, and each
/// tool is listed only when its own feature is on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuestionConfig {
    pub enabled: bool,
}

/// Shared, hot-swappable handle to [`QuestionConfig`]. Cloned into
/// `DelegationInjection` (read at injection) and `AppState` (updated on save).
/// Mirrors [`crate::acp::feedback::FeedbackRuntimeConfig`].
#[derive(Clone, Default)]
pub struct QuestionRuntimeConfig {
    inner: Arc<RwLock<QuestionConfig>>,
}

impl QuestionRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> QuestionConfig {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, cfg: QuestionConfig) {
        *self.inner.write().await = cfg;
    }

    /// Convenience read used at MCP injection time.
    pub async fn is_enabled(&self) -> bool {
        self.inner.read().await.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_args() -> Value {
        json!({
            "questions": [{
                "question": "Which approach?",
                "header": "Approach",
                "multiSelect": false,
                "options": [
                    { "label": "Incremental", "description": "smaller diffs" },
                    { "label": "Rewrite", "description": "clean slate" }
                ]
            }]
        })
    }

    #[test]
    fn parse_questions_happy_path_mints_ids() {
        let qs = parse_questions(&valid_args()).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].question, "Which approach?");
        assert_eq!(qs[0].header, "Approach");
        assert!(!qs[0].multi_select);
        assert_eq!(qs[0].options.len(), 2);
        assert!(!qs[0].id.is_empty());
    }

    fn elicitation_raw(props: Value, required: Value) -> Value {
        json!({
            "mode": "form",
            "sessionId": "sess-1",
            "toolCallId": "item-1",
            "requestedSchema": {
                "type": "object",
                "properties": props,
                "required": required,
            },
            "message": "Input requested",
        })
    }

    fn expect_questions(plan: ElicitationPlan) -> ElicitationQuestions {
        match plan {
            ElicitationPlan::Questions(q) => q,
            ElicitationPlan::Approval(_) => panic!("expected a questions plan"),
        }
    }

    fn expect_approval(plan: ElicitationPlan) -> ElicitationApproval {
        match plan {
            ElicitationPlan::Approval(a) => a,
            ElicitationPlan::Questions(_) => panic!("expected an approval plan"),
        }
    }

    #[test]
    fn classify_elicitation_single_select_maps_options_and_id() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Approach",
                    "description": "Which approach?",
                    "oneOf": [
                        {"const": "Incremental", "title": "Incremental"},
                        {"const": "Rewrite", "title": "Rewrite"}
                    ]
                }
            }),
            json!(["q1"]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs.len(), 1);
        assert_eq!(q.specs[0].id, "q1", "property key becomes the spec id");
        assert_eq!(q.specs[0].question, "Which approach?");
        assert_eq!(q.specs[0].header, "Approach");
        assert!(!q.specs[0].multi_select);
        assert!(!q.specs[0].is_secret);
        let labels: Vec<_> = q.specs[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Incremental", "Rewrite"]);
        assert_eq!(q.fields[0].kind, ElicitationFieldKind::Text);
        // The elicitation's toolCallId rides along so the connection handler can
        // key the synthesized in-stream result card to it (see the fn docs).
        assert_eq!(
            q.tool_call_id.as_deref(),
            Some("item-1"),
            "carries the elicitation toolCallId for the synthesized card"
        );
    }

    /// codex-acp ≥1.12.0's `request_user_input` shape, verbatim off
    /// `buildUserInputRequest`: the QUESTION is in `title`, the short tab label
    /// is in `description`, the companion is `<id>_note` with
    /// `_meta.codex.role`, and an `isOther` question's `oneOf` ends with the
    /// injected "None of the above".
    #[test]
    fn classify_elicitation_reads_codex_112_orientation_and_drops_its_extras() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Which approach should I take for the rewrite?",
                    "description": "Approach",
                    "_meta": {"codex": {"isOther": true, "isSecret": false}},
                    "oneOf": [
                        {"const": "Incremental", "title": "Incremental"},
                        {"const": "Rewrite", "title": "Rewrite"},
                        {
                            "const": "None of the above",
                            "title": "None of the above",
                            "description": "Provide a different answer in the note field."
                        }
                    ]
                },
                "q1_note": {
                    "type": "string",
                    "title": "Additional answer or note",
                    "_meta": {"codex": {
                        "questionId": "q1", "role": "user_note", "isSecret": false
                    }}
                }
            }),
            json!(["q1"]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs.len(), 1, "the `_note` companion must not render");
        assert_eq!(q.specs[0].id, "q1");
        assert_eq!(
            q.specs[0].question, "Which approach should I take for the rewrite?",
            "1.12.0 puts the question in `title`"
        );
        assert_eq!(
            q.specs[0].header, "Approach",
            "…and the short tab label in `description`"
        );
        let labels: Vec<_> = q.specs[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(
            labels,
            ["Incremental", "Rewrite"],
            "codex's injected 'None of the above' is dropped for the card's own Other input"
        );
    }

    /// A model that writes "None of the above" itself: codex-acp then injects
    /// nothing, so the option is REAL and must survive. Same label, no codex
    /// description.
    #[test]
    fn classify_elicitation_keeps_a_model_authored_none_of_the_above() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Which approach?",
                    "description": "Approach",
                    "_meta": {"codex": {"isOther": true, "isSecret": false}},
                    "oneOf": [
                        {"const": "Incremental", "title": "Incremental"},
                        {"const": "None of the above", "title": "None of the above"}
                    ]
                },
                "q1_note": {
                    "type": "string",
                    "title": "Additional answer or note",
                    "_meta": {"codex": {"questionId": "q1", "role": "user_note"}}
                }
            }),
            json!(["q1"]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        let labels: Vec<_> = q.specs[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Incremental", "None of the above"]);
    }

    /// A codex-acp ≤1.11.0 form still reads the old way round. The `__other`
    /// companion + `isOtherAnswer` marker date the form, so `description` stays
    /// the question and `title` the tab label.
    #[test]
    fn classify_elicitation_keeps_codex_111_orientation() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Approach",
                    "description": "Which approach should I take for the rewrite?",
                    "_meta": {"codex": {"isOther": true, "isSecret": false}},
                    "oneOf": [
                        {"const": "Incremental", "title": "Incremental"},
                        {"const": "Rewrite", "title": "Rewrite"}
                    ]
                },
                "q1__other": {
                    "type": "string",
                    "title": "Other",
                    "description": "Type your own answer instead of choosing an option above.",
                    "_meta": {"codex": {
                        "questionId": "q1", "isOtherAnswer": true, "isSecret": false
                    }}
                }
            }),
            json!([]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs.len(), 1);
        assert_eq!(
            q.specs[0].question, "Which approach should I take for the rewrite?",
            "≤1.11.0 puts the question in `description`"
        );
        assert_eq!(q.specs[0].header, "Approach");
    }

    /// A codex form whose questions all have `isOther: false` carries NO
    /// companion, in either generation — so the form itself cannot be dated and
    /// the running adapter's version is the only real signal. Both readings are
    /// reachable, and `None` falls back to the pinned adapter's shape.
    ///
    /// This is the ordinary case, not an edge one: most `request_user_input`
    /// questions are plain selects.
    #[test]
    fn classify_elicitation_undated_codex_form_follows_the_running_adapter() {
        let props = json!({
            "q1": {
                "type": "string",
                "title": "Which approach should I take?",
                "description": "Approach",
                "_meta": {"codex": {"isOther": false, "isSecret": false}},
                "oneOf": [{"const": "Incremental", "title": "Incremental"}]
            }
        });
        let raw = elicitation_raw(props, json!(["q1"]));

        // Running ≥1.12.0 — `title` is the question.
        let q = expect_questions(
            classify_elicitation(&raw, ElicitationPeer::Codex(Some(CodexUserInputShape::QuestionInTitle))).unwrap(),
        );
        assert_eq!(q.specs[0].question, "Which approach should I take?");
        assert_eq!(q.specs[0].header, "Approach");

        // Running ≤1.11.0 — the old reading, even though no marker dates the
        // form. A custom pin is a supported configuration.
        let q = expect_questions(
            classify_elicitation(&raw, ElicitationPeer::Codex(Some(CodexUserInputShape::QuestionInDescription))).unwrap(),
        );
        assert_eq!(q.specs[0].question, "Approach");
        // …and the question text lands in the header slot, where the
        // `MAX_HEADER_CHARS` clamp shears it — which is what the wrong
        // orientation costs a user: a truncated chip and no question.
        assert_eq!(
            q.specs[0].header,
            "Which approach should I take?"
                .chars()
                .take(MAX_HEADER_CHARS)
                .collect::<String>()
        );

        // Adapter reported no usable version — fall back to the pinned shape.
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs[0].question, "Which approach should I take?");
    }

    /// The running adapter's version OUTRANKS a companion marker: it describes
    /// the process that built the frame. They agree in practice, so this pins
    /// the precedence rather than a behavior anyone should see.
    #[test]
    fn classify_elicitation_running_version_outranks_the_companion_marker() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Approach",
                    "description": "Which approach should I take?",
                    "_meta": {"codex": {"isOther": true, "isSecret": false}},
                    "oneOf": [{"const": "Incremental", "title": "Incremental"}]
                },
                "q1__other": {
                    "type": "string",
                    "title": "Other",
                    "_meta": {"codex": {"questionId": "q1", "isOtherAnswer": true}}
                }
            }),
            json!([]),
        );
        let q = expect_questions(
            classify_elicitation(&raw, ElicitationPeer::Codex(Some(CodexUserInputShape::QuestionInTitle))).unwrap(),
        );
        assert_eq!(q.specs[0].question, "Approach", "running version wins");
        // …and with no running version, the marker dates it the old way.
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs[0].question, "Which approach should I take?");
    }

    /// The 1.12.0 fixups are codex-only. DeepSeek is routed through this same
    /// parser (`build_client_capabilities` advertises `elicitation.form` to it),
    /// and for DeepSeek a value that is not in the option set is decoded as a
    /// CUSTOM answer — so silently eating a real "None of the above" would not
    /// just hide a radio, it would change what the agent is told.
    #[test]
    fn classify_elicitation_non_codex_form_keeps_none_of_the_above() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Pick one",
                    "oneOf": [
                        {"const": "Incremental", "title": "Incremental"},
                        {
                            "const": "None of the above",
                            "title": "None of the above",
                            "description": "Provide a different answer in the note field."
                        }
                    ]
                }
            }),
            json!(["q1"]),
        );
        for peer in [
            ElicitationPeer::Other,
            ElicitationPeer::Codex(None),
            ElicitationPeer::Codex(Some(CodexUserInputShape::QuestionInTitle)),
            ElicitationPeer::Codex(Some(CodexUserInputShape::QuestionInDescription)),
        ] {
            let q = expect_questions(classify_elicitation(&raw, peer).unwrap());
            let labels: Vec<_> = q.specs[0].options.iter().map(|o| o.label.as_str()).collect();
            assert_eq!(
                labels,
                ["Incremental", "None of the above"],
                "no `_meta.codex` ⇒ not a codex form ⇒ no codex fixups (peer={peer:?})"
            );
        }
    }

    /// The gate is the PEER, not the payload. `_meta` is an open namespace, so
    /// a non-codex speaker — DeepSeek, or any MCP server whose form either
    /// adapter relays — can carry a `codex` block of its own meaning. If that
    /// were enough to unlock the codex fixups, a third party could make codeg
    /// hide one of its fields (the companion skip), read its questions upside
    /// down (the orientation flip) and delete one of its options (the synthetic
    /// filter). None of those may fire on `ElicitationPeer::Other`.
    ///
    /// The same payload under a codex peer is asserted right below, so the test
    /// shows the identity gate doing the deciding rather than the payload
    /// merely being inert.
    #[test]
    fn classify_elicitation_foreign_codex_meta_is_ignored_off_codex() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Approach",
                    "description": "Which approach should I take?",
                    "_meta": {"codex": {"isOther": true, "isSecret": false}},
                    "oneOf": [
                        {"const": "Incremental", "title": "Incremental"},
                        {
                            "const": "None of the above",
                            "title": "None of the above",
                            "description": "Provide a different answer in the note field."
                        }
                    ]
                },
                "q1_note": {
                    "type": "string",
                    "title": "Release note",
                    "description": "Anything to add?",
                    "_meta": {"codex": {"questionId": "q1", "role": "user_note"}}
                }
            }),
            json!([]),
        );

        // Not codex: every field is a real field, the JSON Schema reading
        // stands, and every option survives.
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Other).unwrap());
        assert_eq!(
            q.specs.len(),
            2,
            "a `user_note` block from a non-codex peer is not a companion"
        );
        assert_eq!(q.specs[0].question, "Which approach should I take?");
        assert_eq!(q.specs[0].header, "Approach");
        let labels: Vec<_> = q.specs[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Incremental", "None of the above"]);

        // The identical payload from codex: companion skipped, 1.12 orientation,
        // injected option dropped. Same bytes, opposite treatment — the peer is
        // the only input that changed.
        let q = expect_questions(
            classify_elicitation(
                &raw,
                ElicitationPeer::Codex(Some(CodexUserInputShape::QuestionInTitle)),
            )
            .unwrap(),
        );
        assert_eq!(q.specs.len(), 1);
        assert_eq!(q.specs[0].question, "Approach");
        let labels: Vec<_> = q.specs[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Incremental"]);
    }

    /// The synthetic-option filter matches THIS choice's own `oneOf` entry, by
    /// `const`, rather than asking whether the array contains a synthetic entry
    /// anywhere. Scanning would drop a legitimate option that merely shares the
    /// label with one — and since the labels collide, the dedup pass then eats
    /// the synthetic one too, leaving the real choice unselectable and its
    /// `const` unmappable on the way back.
    ///
    /// A conforming codex cannot send this pair (it writes `const: label` for
    /// every option and skips its injection when the label is already taken),
    /// so this pins the narrowing rather than a shape seen in the wild.
    #[test]
    fn classify_elicitation_keeps_a_same_label_option_with_its_own_const() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Approach",
                    "_meta": {"codex": {"isOther": true, "isSecret": false}},
                    "oneOf": [
                        {
                            "const": "real-none",
                            "title": "None of the above",
                            "description": "A real option the model wrote."
                        },
                        {
                            "const": "None of the above",
                            "title": "None of the above",
                            "description": "Provide a different answer in the note field."
                        }
                    ]
                }
            }),
            json!([]),
        );
        let q = expect_questions(
            classify_elicitation(
                &raw,
                ElicitationPeer::Codex(Some(CodexUserInputShape::QuestionInTitle)),
            )
            .unwrap(),
        );
        let labels: Vec<_> = q.specs[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(
            labels,
            ["None of the above"],
            "the model's own option survives; only the injected twin goes"
        );
        // …and it still round-trips to the model's `const`, not the synthetic
        // one, so the agent is told what the user actually picked.
        assert_eq!(
            q.fields[0].value_by_label.get("None of the above"),
            Some(&"real-none".to_string())
        );
    }

    /// …and within codex, a NON-`isOther` question is never injected into
    /// either, so its options are left alone too.
    #[test]
    fn classify_elicitation_codex_non_other_question_keeps_none_of_the_above() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Pick one",
                    "_meta": {"codex": {"isOther": false, "isSecret": false}},
                    "oneOf": [
                        {"const": "Incremental", "title": "Incremental"},
                        {
                            "const": "None of the above",
                            "title": "None of the above",
                            "description": "Provide a different answer in the note field."
                        }
                    ]
                }
            }),
            json!(["q1"]),
        );
        let q = expect_questions(
            classify_elicitation(&raw, ElicitationPeer::Codex(Some(CodexUserInputShape::QuestionInTitle))).unwrap(),
        );
        let labels: Vec<_> = q.specs[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Incremental", "None of the above"]);
    }

    /// A generic MCP server's form has no `codex` namespace at all, so it keeps
    /// the JSON Schema reading codeg has always used — `description` is the
    /// prose, `title` the short label. The swap is codex-only.
    #[test]
    fn classify_elicitation_generic_mcp_form_keeps_description_as_the_question() {
        let raw = elicitation_raw(
            json!({
                "port": {
                    "type": "integer",
                    "title": "Port",
                    "description": "Which port should the server listen on?"
                }
            }),
            json!(["port"]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs[0].question, "Which port should the server listen on?");
        assert_eq!(q.specs[0].header, "Port");
    }

    /// 1.12.0 omits `description` entirely when the model supplied no header —
    /// the question still comes from `title`, and the tab label is synthesized.
    #[test]
    fn classify_elicitation_codex_112_without_a_header_still_reads_the_title() {
        let raw = elicitation_raw(
            json!({
                "q1": {
                    "type": "string",
                    "title": "Which approach should I take?",
                    "_meta": {"codex": {"isOther": false, "isSecret": false}}
                }
            }),
            json!(["q1"]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs[0].question, "Which approach should I take?");
        assert!(!q.specs[0].header.is_empty(), "header is synthesized");
    }

    /// Defense against over-skipping the renamed companion: a REAL question
    /// whose id merely ends in `_note` carries no `_meta.codex` marker, so it
    /// must render. (This is why the `_note` rename is matched by marker only,
    /// never by name — unlike the legacy `__other`.)
    #[test]
    fn classify_elicitation_keeps_an_unmarked_field_named_note() {
        let raw = elicitation_raw(
            json!({
                "q1": {"type": "string", "title": "Pick one", "enum": ["a", "b"]},
                "release_note": {"type": "string", "title": "Release note"}
            }),
            json!([]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        let ids: Vec<_> = q.specs.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["q1", "release_note"]);
    }

    #[test]
    fn classify_elicitation_free_text_renders_and_skips_other_companion() {
        // A free-text question (no options) renders as a 0-option spec (the
        // card shows its always-present "Other" input); the synthetic
        // `__other` companion (any digit-suffixed collision variant too) is
        // skipped.
        let raw = elicitation_raw(
            json!({
                "q1": {"type": "string", "title": "Name", "description": "Your name?",
                       "_meta": {"codex": {"isSecret": true}}},
                "q1__other": {"type": "string", "title": "Other"},
                "q1__other1": {"type": "string", "title": "Other"}
            }),
            json!([]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs.len(), 1);
        assert_eq!(q.specs[0].id, "q1");
        assert!(q.specs[0].options.is_empty(), "free text has no options");
        assert!(q.specs[0].is_secret, "secret marker read from raw _meta");
        assert!(validate_specs(&q.specs).is_ok(), "0-option specs register");

        // The typed answer rides the main field verbatim.
        let answer = QuestionAnswer {
            answers: vec![QuestionAnswerItem {
                question_id: "q1".into(),
                labels: vec!["Ada Lovelace".into()],
            }],
            declined: false,
        };
        let outcome = build_outcome(&q.specs, &answer);
        let v = serde_json::to_value(build_elicitation_response(&q, &outcome)).unwrap();
        assert_eq!(v["action"], "accept");
        assert_eq!(v["content"]["q1"], "Ada Lovelace");
    }

    #[test]
    fn classify_elicitation_skips_meta_marked_custom_answer_companion() {
        // claude-agent-acp ≥0.64 (#929) names its companion `question_<n>_custom`
        // — the `__other` heuristic misses it — and marks it with the shared,
        // un-namespaced `_meta._askUserQuestionCustomAnswer`. The marker alone
        // must collapse it into the card's built-in "Other" input.
        let raw = elicitation_raw(
            json!({
                "question_0": {
                    "type": "string",
                    "title": "Pick one",
                    "enum": ["a", "b"],
                },
                "question_0_custom": {
                    "type": "string",
                    "title": "Other",
                    "description": "Type your own answer instead.",
                    "_meta": {
                        "_askUserQuestionCustomAnswer": {
                            "questionId": "question_0",
                            "isCustomAnswer": true,
                        }
                    },
                },
            }),
            json!([]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs.len(), 1, "companion must not render as a question");
        assert_eq!(q.specs[0].id, "question_0");
        assert_eq!(q.specs[0].options.len(), 2);
    }

    #[test]
    fn classify_elicitation_keeps_unmarked_free_text_field() {
        // Defense against over-skipping: a plain string field that merely sits
        // next to a select — no marker, no `__other` name — is a real question.
        let raw = elicitation_raw(
            json!({
                "question_0": {"type": "string", "title": "Pick one", "enum": ["a", "b"]},
                "notes": {"type": "string", "title": "Notes"},
                "unmarked_custom": {
                    "type": "string",
                    "title": "Other",
                    "_meta": {"_askUserQuestionCustomAnswer": {"questionId": "question_0"}},
                },
            }),
            json!([]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        let ids: Vec<&str> = q.specs.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["notes", "question_0", "unmarked_custom"],
            "only `isCustomAnswer: true` skips; a marker without it does not"
        );
    }

    #[test]
    fn classify_elicitation_multi_select_marks_multi_and_maps_values() {
        let raw = elicitation_raw(
            json!({
                "langs": {
                    "type": "array",
                    "title": "Langs",
                    "description": "Pick languages",
                    "items": { "anyOf": [
                        {"const": "rust", "title": "Rust"},
                        {"const": "ts", "title": "TS"}
                    ]}
                }
            }),
            json!([]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs.len(), 1);
        assert!(q.specs[0].multi_select);
        // Titles display; consts ride back on accept.
        let labels: Vec<_> = q.specs[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Rust", "TS"]);
        let answer = QuestionAnswer {
            answers: vec![QuestionAnswerItem {
                question_id: q.specs[0].id.clone(),
                labels: vec!["Rust".into(), "TS".into()],
            }],
            declined: false,
        };
        let outcome = build_outcome(&q.specs, &answer);
        let v = serde_json::to_value(build_elicitation_response(&q, &outcome)).unwrap();
        assert_eq!(v["content"]["langs"], json!(["rust", "ts"]));
    }

    #[test]
    fn classify_elicitation_boolean_and_numbers_type_their_answers() {
        let raw = elicitation_raw(
            json!({
                "confirm": {"type": "boolean", "title": "Confirm", "description": "Proceed?"},
                "count": {"type": "integer", "title": "Count", "description": "How many?"},
                "ratio": {"type": "number", "title": "Ratio", "description": "What ratio?"}
            }),
            json!(["confirm"]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs.len(), 3);
        // Booleans render as Yes/No; numbers as free text.
        let confirm = q.specs.iter().position(|s| s.id == "confirm").unwrap();
        let labels: Vec<_> = q.specs[confirm].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Yes", "No"]);

        let answer = QuestionAnswer {
            answers: vec![
                QuestionAnswerItem {
                    question_id: "confirm".into(),
                    labels: vec!["Yes".into()],
                },
                QuestionAnswerItem {
                    question_id: "count".into(),
                    labels: vec!["42".into()],
                },
                QuestionAnswerItem {
                    question_id: "ratio".into(),
                    labels: vec!["not-a-number".into()],
                },
            ],
            declined: false,
        };
        let outcome = build_outcome(&q.specs, &answer);
        let v = serde_json::to_value(build_elicitation_response(&q, &outcome)).unwrap();
        assert_eq!(v["content"]["confirm"], json!(true), "boolean typed");
        assert_eq!(v["content"]["count"], json!(42), "integer typed");
        assert!(
            v["content"].get("ratio").is_none(),
            "unparseable number omitted, not sent mistyped"
        );
    }

    #[test]
    fn classify_elicitation_enum_names_display_title_but_send_const() {
        // Generic MCP `enum` + `enumNames` normalize to oneOf with
        // const ≠ title: display the title, send the const back.
        let raw = elicitation_raw(
            json!({
                "env": {
                    "type": "string",
                    "title": "Env",
                    "description": "Which environment?",
                    "oneOf": [
                        {"const": "prod-eu-1", "title": "Production (EU)"},
                        {"const": "stg-eu-1", "title": "Staging (EU)"}
                    ]
                }
            }),
            json!(["env"]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(q.specs[0].options[0].label, "Production (EU)");
        let answer = QuestionAnswer {
            answers: vec![QuestionAnswerItem {
                question_id: "env".into(),
                labels: vec!["Production (EU)".into()],
            }],
            declined: false,
        };
        let outcome = build_outcome(&q.specs, &answer);
        let v = serde_json::to_value(build_elicitation_response(&q, &outcome)).unwrap();
        assert_eq!(v["content"]["env"], "prod-eu-1");
    }

    #[test]
    fn classify_elicitation_tool_approval_maps_persist_options() {
        // The exact wire shape codex-acp sends for an MCP tool-call approval
        // once `elicitation.form` is advertised (verified against its
        // elicitation-events tests): message + persist choice, approval marker
        // in top-level `_meta`.
        let raw = json!({
            "mode": "form",
            "sessionId": "sess-1",
            "toolCallId": "call-1",
            "message": "Allow tool call?",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "persist": {
                        "type": "string",
                        "title": "Approval scope",
                        "oneOf": [
                            {"const": "once", "title": "Allow once"},
                            {"const": "session", "title": "Allow for this session"},
                            {"const": "always", "title": "Allow and don't ask again"}
                        ],
                        "default": "once"
                    }
                },
                "required": ["persist"]
            },
            "_meta": {"codex_approval_kind": "mcp_tool_call", "persist": ["session", "always"]}
        });
        let approval = expect_approval(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(approval.message, "Allow tool call?");
        assert_eq!(approval.tool_call_id.as_deref(), Some("call-1"));
        assert!(approval.persist_in_content);
        let ids: Vec<_> = approval.options.iter().map(|o| o.option_id.as_str()).collect();
        assert_eq!(ids, ["once", "session", "always", ELICITATION_DECLINE_OPTION_ID]);
        assert_eq!(approval.options[0].label, "Allow once");
        assert_eq!(approval.options[0].kind, "allow_once");
        assert_eq!(approval.options[1].kind, "allow_always");

        // Accepting echoes the chosen persist back in content…
        let v =
            serde_json::to_value(build_elicitation_approval_response(&approval, "session"))
                .unwrap();
        assert_eq!(v["action"], "accept");
        assert_eq!(v["content"]["persist"], "session");
        // …declining (or an unknown option) maps to decline.
        let v = serde_json::to_value(build_elicitation_approval_response(
            &approval,
            ELICITATION_DECLINE_OPTION_ID,
        ))
        .unwrap();
        assert_eq!(v["action"], "decline");
        let v = serde_json::to_value(build_elicitation_approval_response(&approval, "bogus"))
            .unwrap();
        assert_eq!(v["action"], "decline");
    }

    #[test]
    fn classify_elicitation_tool_approval_without_persist_is_allow_decline() {
        // No persist advertised → codex-acp sends an EMPTY properties object.
        // This must NOT auto-decline: it renders Allow/Decline and accepts
        // with no content.
        let raw = json!({
            "mode": "form",
            "sessionId": "sess-1",
            "toolCallId": "call-1",
            "message": "Allow tool call?",
            "requestedSchema": {"type": "object", "properties": {}},
            "_meta": {"codex_approval_kind": "mcp_tool_call"}
        });
        let approval = expect_approval(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert!(!approval.persist_in_content);
        let ids: Vec<_> = approval.options.iter().map(|o| o.option_id.as_str()).collect();
        assert_eq!(ids, ["accept", ELICITATION_DECLINE_OPTION_ID]);
        let v = serde_json::to_value(build_elicitation_approval_response(&approval, "accept"))
            .unwrap();
        assert_eq!(v["action"], "accept");
        assert!(
            v.get("content").is_none() || v["content"].is_null(),
            "plain accept sends no content"
        );
    }

    #[test]
    fn classify_elicitation_message_only_form_is_accept_decline_confirm() {
        // A non-approval form with nothing to fill in (a bare MCP server
        // confirmation) renders Accept/Decline rather than auto-declining.
        let raw = elicitation_raw(json!({}), json!([]));
        let approval = expect_approval(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        assert_eq!(approval.message, "Input requested");
        let ids: Vec<_> = approval.options.iter().map(|o| o.option_id.as_str()).collect();
        assert_eq!(ids, ["accept", ELICITATION_DECLINE_OPTION_ID]);
    }

    #[test]
    fn elicitation_round_trips_answer_keyed_by_property_id() {
        let raw = elicitation_raw(
            json!({
                "colour": {
                    "type": "string",
                    "title": "Colour",
                    "description": "Pick a colour",
                    "oneOf": [
                        {"const": "Red", "title": "Red"},
                        {"const": "Blue", "title": "Blue"}
                    ]
                }
            }),
            json!(["colour"]),
        );
        let q = expect_questions(classify_elicitation(&raw, ElicitationPeer::Codex(None)).unwrap());
        // Simulate the user picking "Blue" through the normal answer path.
        let answer = QuestionAnswer {
            answers: vec![QuestionAnswerItem {
                question_id: "colour".into(),
                labels: vec!["Blue".into()],
            }],
            declined: false,
        };
        let outcome = build_outcome(&q.specs, &answer);
        let resp = build_elicitation_response(&q, &outcome);
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["action"], "accept");
        // Codex reads the answer back by the schema property id.
        assert_eq!(v["content"]["colour"], "Blue");
    }

    #[test]
    fn build_elicitation_response_declined_maps_to_decline() {
        let outcome = QuestionOutcome {
            answers: vec![],
            declined: true,
        };
        let empty = ElicitationQuestions {
            specs: vec![],
            fields: vec![],
            tool_call_id: None,
        };
        let v = serde_json::to_value(build_elicitation_response(&empty, &outcome)).unwrap();
        assert_eq!(v["action"], "decline");
        let v = serde_json::to_value(elicitation_cancel_response()).unwrap();
        assert_eq!(v["action"], "cancel");
    }

    #[test]
    fn validate_specs_accepts_well_formed_and_rejects_malformed() {
        // What parse_questions mints passes the request-side re-check.
        let good = parse_questions(&valid_args()).unwrap();
        assert!(validate_specs(&good).is_ok());

        // Build a spec with a tunable question, option count, and first-label
        // length so each bound can be tripped independently.
        let spec = |question: &str, options: usize, first_label_len: usize| QuestionSpec {
            id: "q".into(),
            question: question.into(),
            header: "H".into(),
            multi_select: false,
            options: (0..options)
                .map(|i| QuestionOption {
                    label: if first_label_len > 0 && i == 0 {
                        "x".repeat(first_label_len)
                    } else {
                        format!("opt{i}")
                    },
                    description: String::new(),
                })
                .collect(),
            is_secret: false,
        };

        assert!(validate_specs(&[]).is_err(), "empty set");
        assert!(
            validate_specs(&[spec(&"q".repeat(MAX_QUESTION_TEXT_CHARS + 1), 2, 0)]).is_err(),
            "oversized question text"
        );
        assert!(
            validate_specs(&[spec("ok", 0, 0)]).is_ok(),
            "0 options is a legal free-text ask (elicitation / MCP forms)"
        );
        assert!(
            validate_specs(&[spec("ok", MAX_OPTIONS + 1, 0)]).is_err(),
            "too many options"
        );
        assert!(
            validate_specs(&[spec("ok", 2, MAX_QUESTION_TEXT_CHARS + 1)]).is_err(),
            "oversized option label"
        );
        assert!(validate_specs(&[spec("   ", 2, 0)]).is_err(), "blank question");

        // Duplicate question id across the set (spec() hardcodes id "q") — answer
        // routing + UI state key on id, so duplicates must be rejected.
        assert!(
            validate_specs(&[spec("a", 2, 0), spec("b", 2, 0)]).is_err(),
            "duplicate question id"
        );
        let blank_id = QuestionSpec {
            id: "  ".into(),
            question: "ok".into(),
            header: "H".into(),
            multi_select: false,
            options: vec![
                QuestionOption {
                    label: "a".into(),
                    description: String::new(),
                },
                QuestionOption {
                    label: "b".into(),
                    description: String::new(),
                },
            ],
            is_secret: false,
        };
        assert!(validate_specs(&[blank_id]).is_err(), "blank id");
        // Duplicate option label within one question (parse_questions rejects it).
        let dup_label = QuestionSpec {
            id: "q".into(),
            question: "ok".into(),
            header: "H".into(),
            multi_select: false,
            options: vec![
                QuestionOption {
                    label: "same".into(),
                    description: String::new(),
                },
                QuestionOption {
                    label: " same ".into(),
                    description: String::new(),
                },
            ],
            is_secret: false,
        };
        assert!(
            validate_specs(&[dup_label]).is_err(),
            "duplicate option label (trimmed)"
        );
    }

    #[test]
    fn parse_questions_rejects_empty_and_overlong_sets() {
        assert!(parse_questions(&json!({ "questions": [] })).is_err());
        assert!(parse_questions(&json!({})).is_err());
        let mut many = Vec::new();
        for _ in 0..(MAX_QUESTIONS + 1) {
            many.push(json!({
                "question": "q", "header": "h", "multiSelect": false,
                "options": [{ "label": "a", "description": "" }, { "label": "b", "description": "" }]
            }));
        }
        assert!(parse_questions(&json!({ "questions": many })).is_err());
    }

    #[test]
    fn parse_questions_enforces_option_count_and_header_len() {
        // One option is not a choice.
        let one_opt = json!({ "questions": [{
            "question": "q", "header": "h", "multiSelect": false,
            "options": [{ "label": "only", "description": "" }]
        }] });
        assert!(parse_questions(&one_opt).is_err());
        // Header too long.
        let long_header = json!({ "questions": [{
            "question": "q", "header": "this-header-is-way-too-long", "multiSelect": false,
            "options": [{ "label": "a", "description": "" }, { "label": "b", "description": "" }]
        }] });
        assert!(parse_questions(&long_header).is_err());
    }

    #[test]
    fn build_outcome_maps_labels_by_id_and_drops_unknown() {
        let qs = parse_questions(&valid_args()).unwrap();
        let qid = qs[0].id.clone();
        let answer = QuestionAnswer {
            answers: vec![
                QuestionAnswerItem {
                    question_id: qid,
                    labels: vec!["Incremental".into()],
                },
                QuestionAnswerItem {
                    question_id: "does-not-exist".into(),
                    labels: vec!["ghost".into()],
                },
            ],
            declined: false,
        };
        let outcome = build_outcome(&qs, &answer);
        assert!(!outcome.declined);
        assert_eq!(outcome.answers.len(), 1);
        assert_eq!(outcome.answers[0].question, "Which approach?");
        assert_eq!(outcome.answers[0].selected, vec!["Incremental".to_string()]);
    }

    #[test]
    fn parse_questions_rejects_overlong_option_label() {
        let huge = "x".repeat(MAX_QUESTION_TEXT_CHARS + 1);
        let bad = json!({ "questions": [{
            "question": "q", "header": "h", "multiSelect": false,
            "options": [
                { "label": huge, "description": "" },
                { "label": "B", "description": "" }
            ]
        }] });
        let err = parse_questions(&bad).unwrap_err();
        assert!(err.contains("exceeds"));
    }

    #[test]
    fn build_outcome_caps_multiselect_labels_and_ignores_unknown() {
        // A multi-select question with 2 options: a flood of submitted labels
        // plus a flood of unknown answer items must NOT bloat the outcome.
        let args = json!({ "questions": [{
            "question": "Which modules?", "header": "Scope", "multiSelect": true,
            "options": [
                { "label": "auth", "description": "" },
                { "label": "billing", "description": "" }
            ]
        }] });
        let qs = parse_questions(&args).unwrap();
        let qid = qs[0].id.clone();
        let mut items = vec![QuestionAnswerItem {
            question_id: qid,
            labels: (0..1000).map(|i| format!("l{i}")).collect(),
        }];
        // 10k unknown answer items — must be ignored without growth.
        for i in 0..10_000 {
            items.push(QuestionAnswerItem {
                question_id: format!("ghost-{i}"),
                labels: vec!["x".into()],
            });
        }
        let outcome = build_outcome(&qs, &QuestionAnswer { answers: items, declined: false });
        assert_eq!(outcome.answers.len(), 1);
        // Cap = options.len() + 1 = 3 (every real option plus one "Other"); the
        // FIRST three are kept (early break — labels past the cap and the 10k
        // unknown items are never processed/retained).
        assert_eq!(
            outcome.answers[0].selected,
            vec!["l0".to_string(), "l1".to_string(), "l2".to_string()]
        );
    }

    #[test]
    fn parse_questions_rejects_duplicate_option_labels() {
        let dup = json!({ "questions": [{
            "question": "q", "header": "h", "multiSelect": false,
            "options": [
                { "label": "Same", "description": "a" },
                { "label": "Same", "description": "b" }
            ]
        }] });
        let err = parse_questions(&dup).unwrap_err();
        assert!(err.contains("duplicate"));
    }

    #[test]
    fn build_outcome_normalizes_malformed_answer() {
        // Single-select with two labels + an empty + an oversize one, plus a
        // duplicate answer item and an unknown question id. The endpoint must
        // not trust this; build_outcome sanitizes it.
        let qs = parse_questions(&valid_args()).unwrap();
        let qid = qs[0].id.clone();
        let huge = "x".repeat(MAX_QUESTION_TEXT_CHARS + 50);
        let answer = QuestionAnswer {
            answers: vec![
                QuestionAnswerItem {
                    question_id: qid.clone(),
                    labels: vec!["  ".into(), "Incremental".into(), huge.clone()],
                },
                // Duplicate item for the same question — must be deduped (first wins).
                QuestionAnswerItem {
                    question_id: qid,
                    labels: vec!["Rewrite".into()],
                },
                // Unknown question — dropped.
                QuestionAnswerItem {
                    question_id: "ghost".into(),
                    labels: vec!["x".into()],
                },
            ],
            declined: false,
        };
        let outcome = build_outcome(&qs, &answer);
        assert_eq!(outcome.answers.len(), 1, "deduped + unknown dropped");
        // Single-select: empty trimmed away, then truncated to one → "Incremental".
        assert_eq!(outcome.answers[0].selected, vec!["Incremental".to_string()]);
    }

    #[test]
    fn build_outcome_drops_question_with_only_empty_labels() {
        let qs = parse_questions(&valid_args()).unwrap();
        let outcome = build_outcome(
            &qs,
            &QuestionAnswer {
                answers: vec![QuestionAnswerItem {
                    question_id: qs[0].id.clone(),
                    labels: vec!["   ".into(), "".into()],
                }],
                declined: false,
            },
        );
        assert!(outcome.answers.is_empty());
    }

    #[test]
    fn build_outcome_declined_is_empty() {
        let qs = parse_questions(&valid_args()).unwrap();
        let outcome = build_outcome(
            &qs,
            &QuestionAnswer {
                answers: vec![],
                declined: true,
            },
        );
        assert!(outcome.declined);
        assert!(outcome.answers.is_empty());
    }

    #[tokio::test]
    async fn runtime_config_hot_swaps() {
        let cfg = QuestionRuntimeConfig::new();
        assert!(!cfg.is_enabled().await);
        cfg.set(QuestionConfig { enabled: true }).await;
        assert!(cfg.is_enabled().await);
    }

    fn grok_params(questions: Value) -> Value {
        json!({
            "sessionId": "s-1",
            "toolCallId": "call-1",
            "questions": questions,
            "mode": "default",
        })
    }

    #[test]
    fn parse_grok_ext_maps_shape_and_synthesizes_header() {
        // Grok's wire shape: no `header`, camelCase `multiSelect`.
        let specs = parse_grok_ext_questions(&grok_params(json!([{
            "question": "What is your favorite color?",
            "options": [
                { "label": "Red", "description": "warm" },
                { "label": "Blue", "description": "cool" }
            ],
            "multiSelect": false
        }])))
        .unwrap();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].question, "What is your favorite color?");
        assert!(!specs[0].multi_select);
        assert_eq!(specs[0].options.len(), 2);
        // Header is synthesized, non-empty, and within the chip bound.
        assert!(!specs[0].header.is_empty());
        assert!(specs[0].header.chars().count() <= MAX_HEADER_CHARS);
        // Whatever we synthesize MUST satisfy the register-time re-validation,
        // else `register_question` silently declines the whole ask.
        validate_specs(&specs).expect("synthesized specs must pass validate_specs");
    }

    #[test]
    fn parse_grok_ext_clamps_questions_and_options_to_bounds() {
        // 6 questions, each with 6 options — both past codeg's maxima.
        let many: Vec<Value> = (0..6)
            .map(|qi| {
                let opts: Vec<Value> = (0..6)
                    .map(|oi| json!({ "label": format!("q{qi}o{oi}"), "description": "" }))
                    .collect();
                json!({ "question": format!("Question {qi}?"), "options": opts })
            })
            .collect();
        let specs = parse_grok_ext_questions(&grok_params(json!(many))).unwrap();
        assert_eq!(specs.len(), MAX_QUESTIONS, "questions clamped");
        assert!(specs.iter().all(|s| s.options.len() == MAX_OPTIONS), "options clamped");
        validate_specs(&specs).unwrap();
    }

    #[test]
    fn parse_grok_ext_dedups_option_labels() {
        // Duplicate labels would fail validate_specs; we dedup, keeping enough.
        let specs = parse_grok_ext_questions(&grok_params(json!([{
            "question": "Pick one",
            "options": [
                { "label": "A", "description": "" },
                { "label": "A", "description": "dup" },
                { "label": "B", "description": "" }
            ]
        }])))
        .unwrap();
        assert_eq!(specs[0].options.len(), 2);
        validate_specs(&specs).unwrap();
    }

    #[test]
    fn parse_grok_ext_rejects_degenerate_and_malformed() {
        // Fewer than two usable options is not a real choice → fail (grok falls back).
        assert!(parse_grok_ext_questions(&grok_params(json!([{
            "question": "Only one",
            "options": [{ "label": "Solo", "description": "" }]
        }])))
        .is_err());
        // Missing questions array.
        assert!(parse_grok_ext_questions(&json!({ "mode": "default" })).is_err());
        // Empty questions.
        assert!(parse_grok_ext_questions(&grok_params(json!([]))).is_err());
    }

    /// The `toolCall` of a `session/request_permission` captured from a live
    /// pi-acp 0.0.33 run of an extension calling `ctx.ui.select` (#644).
    fn pi_select_tool_call() -> Value {
        json!({
            "toolCallId": "pi-ui-69c549d7-9f79-4de6-a860-7ae4d27553f7",
            "title": "[未提交改动] 当前分支有未提交的 AddIOP.cs 修改；创建热修复分支时应如何处理？",
            "kind": "other",
            "status": "pending",
            "rawInput": {
                "method": "select",
                "title": "[未提交改动] 当前分支有未提交的 AddIOP.cs 修改；创建热修复分支时应如何处理？",
                "options": [
                    "1. 暂存后切分支 (Recommended) — 把当前改动保存到具名 stash",
                    "2. 独立 worktree — 保留当前工作区不动",
                    "3. 携带改动切换 — 直接创建并切换分支",
                    "4. Type something."
                ]
            }
        })
    }

    /// The paired permission `options`, same run.
    fn pi_select_options() -> Vec<(String, String)> {
        [
            "1. 暂存后切分支 (Recommended) — 把当前改动保存到具名 stash",
            "2. 独立 worktree — 保留当前工作区不动",
            "3. 携带改动切换 — 直接创建并切换分支",
            "4. Type something.",
        ]
        .iter()
        .enumerate()
        .map(|(i, name)| (format!("choice-{i}"), (*name).to_string()))
        .collect()
    }

    #[test]
    fn parse_pi_select_ask_maps_captured_wire_shape() {
        let ask = parse_pi_select_ask(&pi_select_tool_call(), &pi_select_options())
            .expect("pi select must be recognized");
        assert_eq!(
            ask.spec.question,
            "[未提交改动] 当前分支有未提交的 AddIOP.cs 修改；创建热修复分支时应如何处理？"
        );
        // `ctx.ui.select` yields one value.
        assert!(!ask.spec.multi_select);
        assert_eq!(ask.spec.options.len(), 4);
        assert_eq!(
            ask.spec.options[0].label,
            "1. 暂存后切分支 (Recommended) — 把当前改动保存到具名 stash"
        );
        // Whatever we synthesize MUST satisfy the register-time re-validation,
        // else `register_question` silently declines the ask and the user is
        // left with the raw approval card.
        validate_specs(std::slice::from_ref(&ask.spec))
            .expect("synthesized spec must pass validate_specs");
        // Labels round-trip to the ids pi replies against.
        assert_eq!(
            ask.option_ids
                .iter()
                .map(|(_, id)| id.as_str())
                .collect::<Vec<_>>(),
            ["choice-0", "choice-1", "choice-2", "choice-3"]
        );
    }

    #[test]
    fn parse_pi_select_ask_declines_what_it_cannot_render_faithfully() {
        let opts = |n: usize| -> Vec<(String, String)> {
            (0..n)
                .map(|i| (format!("choice-{i}"), format!("option {i}")))
                .collect()
        };
        // More options than the card can show: truncating would HIDE choices the
        // user must be able to pick, so keep the approval card (which lists all).
        assert!(parse_pi_select_ask(&pi_select_tool_call(), &opts(MAX_OPTIONS + 1)).is_none());
        assert!(parse_pi_select_ask(&pi_select_tool_call(), &opts(MIN_OPTIONS - 1)).is_none());
        // Duplicate labels: the label is the card's selection identity, so a
        // duplicate could answer pi with the wrong index.
        let dup = vec![
            ("choice-0".to_string(), "Same".to_string()),
            ("choice-1".to_string(), "Same".to_string()),
        ];
        assert!(parse_pi_select_ask(&pi_select_tool_call(), &dup).is_none());
        // Blank label.
        let blank = vec![
            ("choice-0".to_string(), "  ".to_string()),
            ("choice-1".to_string(), "B".to_string()),
        ];
        assert!(parse_pi_select_ask(&pi_select_tool_call(), &blank).is_none());
    }

    #[test]
    fn parse_pi_select_ask_ignores_other_permission_requests() {
        let strip = |f: &str| {
            let mut tc = pi_select_tool_call();
            tc.as_object_mut().unwrap().remove(f);
            tc
        };
        // An ordinary tool approval (claude/codex/pi's own tools) has no pi-ui id.
        let mut edit = pi_select_tool_call();
        edit["toolCallId"] = json!("call_abc");
        assert!(parse_pi_select_ask(&edit, &pi_select_options()).is_none());
        // pi's `confirm` dialog is a real yes/no approval, which the permission
        // card already models (allow_once / reject_once).
        let mut confirm = pi_select_tool_call();
        confirm["rawInput"]["method"] = json!("confirm");
        assert!(parse_pi_select_ask(&confirm, &pi_select_options()).is_none());
        assert!(parse_pi_select_ask(&strip("rawInput"), &pi_select_options()).is_none());
        // Option ids that aren't pi-acp's `choice-<index>`: the reply mapping
        // would be a guess.
        let foreign = vec![
            ("allow".to_string(), "Allow".to_string()),
            ("deny".to_string(), "Deny".to_string()),
        ];
        assert!(parse_pi_select_ask(&pi_select_tool_call(), &foreign).is_none());
    }

    #[test]
    fn is_codeg_ask_tool_name_accepts_every_host_spelling_of_codegs_own_tool() {
        for spelling in [
            // claude-agent-acp: an MCP tool's permission card title IS the
            // raw tool name.
            "mcp__codeg-mcp__ask_user_question",
            "codeg-mcp/ask_user_question",
            "codeg-mcp: ask_user_question",
            "mcp.codeg-mcp.ask_user_question",
            // Hosts that title-case or pad it.
            "  MCP__Codeg-MCP__Ask_User_Question  ",
        ] {
            assert!(
                is_codeg_ask_tool_name(spelling),
                "{spelling} is codeg's own ask tool"
            );
        }
    }

    #[test]
    fn is_codeg_ask_tool_name_rejects_tools_that_are_not_codegs_ask() {
        for other in [
            // A third-party MCP server's similarly named tool: approving it is
            // the user's decision, so the bare suffix must NOT be enough.
            "mcp__other-server__ask_user_question",
            "ask_user_question",
            // grok's NATIVE ask arrives on its own ext channel, never as a
            // permission request — and it is not codeg-mcp's tool either.
            "_x.ai/ask_user_question",
            // Codeg's other companion tools keep their approval gate.
            "mcp__codeg-mcp__delegate_to_agent",
            "mcp__codeg-mcp__check_user_feedback",
            // Right server, right words, wrong tool — the match is anchored at
            // the END so a longer name cannot borrow it.
            "mcp__codeg-mcp__ask_user_question_twice",
            "",
        ] {
            assert!(
                !is_codeg_ask_tool_name(other),
                "{other} must keep its approval card"
            );
        }
    }

    #[test]
    fn pi_select_option_id_maps_pick_and_cancels_what_pi_cannot_take() {
        let ask = parse_pi_select_ask(&pi_select_tool_call(), &pi_select_options()).unwrap();
        let answered = |labels: Vec<&str>| QuestionOutcome {
            answers: vec![QuestionAnsweredItem {
                question: ask.spec.question.clone(),
                header: ask.spec.header.clone(),
                multi_select: false,
                selected: labels.into_iter().map(str::to_string).collect(),
            }],
            declined: false,
        };
        assert_eq!(
            pi_select_option_id(&answered(vec![&ask.spec.options[1].label]), &ask).as_deref(),
            Some("choice-1")
        );
        // Declined card → cancel, which is what `ctx.ui.select` sees on Escape.
        assert_eq!(
            pi_select_option_id(
                &QuestionOutcome {
                    answers: vec![],
                    declined: true
                },
                &ask
            ),
            None
        );
        // Free text typed into the card's always-present "Other" box has no
        // option id, so pi can only be told the dialog was cancelled.
        assert_eq!(
            pi_select_option_id(&answered(vec!["something else"]), &ask),
            None
        );
        assert_eq!(pi_select_option_id(&answered(vec![]), &ask), None);
    }

    #[test]
    fn build_grok_ext_response_single_select_is_bare_string() {
        let outcome = QuestionOutcome {
            answers: vec![QuestionAnsweredItem {
                question: "What is your favorite color?".into(),
                header: "What is your".into(),
                multi_select: false,
                selected: vec!["Red".into()],
            }],
            declined: false,
        };
        let v = build_grok_ext_response(&outcome);
        assert_eq!(v["outcome"], "accepted");
        // Keyed by question text; single-select value is a bare string.
        assert_eq!(v["answers"]["What is your favorite color?"], json!("Red"));
        assert!(v["partial_answers"].as_object().unwrap().is_empty());
    }

    #[test]
    fn build_grok_ext_response_multi_select_is_array() {
        let outcome = QuestionOutcome {
            answers: vec![QuestionAnsweredItem {
                question: "Which modules?".into(),
                header: "Which module".into(),
                multi_select: true,
                selected: vec!["auth".into(), "billing".into()],
            }],
            declined: false,
        };
        let v = build_grok_ext_response(&outcome);
        assert_eq!(v["outcome"], "accepted");
        assert_eq!(v["answers"]["Which modules?"], json!(["auth", "billing"]));
    }

    #[test]
    fn build_grok_ext_response_declined_is_skip_interview() {
        let outcome = QuestionOutcome {
            answers: vec![],
            declined: true,
        };
        assert_eq!(build_grok_ext_response(&outcome), json!({ "outcome": "skip_interview" }));
        assert_eq!(grok_ext_skip_response(), json!({ "outcome": "skip_interview" }));
    }

    #[test]
    fn grok_result_card_input_omits_header_and_keeps_shape() {
        // Built from parsed specs (which DO carry a synthesized header) — the card
        // input must nonetheless drop it, so the frontend parses `header:""`.
        let specs = parse_grok_ext_questions(&grok_params(json!([{
            "question": "Which colors?",
            "options": [
                { "label": "Red", "description": "warm" },
                { "label": "Green", "description": "cool" }
            ],
            "multiSelect": true
        }])))
        .unwrap();
        let input = grok_result_card_input(&specs);
        let q = &input["questions"][0];
        assert_eq!(q["question"], "Which colors?");
        assert_eq!(q["multiSelect"], true);
        assert_eq!(q["options"][0]["label"], "Red");
        // No header field is serialized (the frontend reads it as "").
        assert!(q.get("header").is_none(), "input must not carry a header");
    }

    #[test]
    fn grok_result_card_output_single_select_empty_header() {
        let outcome = QuestionOutcome {
            answers: vec![QuestionAnsweredItem {
                question: "你更喜欢哪种演示方式？".into(),
                header: "你更喜欢哪种".into(), // synthesized upstream; must be dropped here
                multi_select: false,
                selected: vec!["随便看看".into()],
            }],
            declined: false,
        };
        let out = grok_result_card_output(&outcome);
        assert_eq!(out["declined"], false);
        let a = &out["answers"][0];
        // Header is forced empty to align with the header-less card input.
        assert_eq!(a["header"], "");
        assert_eq!(a["question"], "你更喜欢哪种演示方式？");
        assert_eq!(a["selected"], json!(["随便看看"]));
    }

    #[test]
    fn grok_result_card_output_multi_and_declined() {
        let multi = QuestionOutcome {
            answers: vec![QuestionAnsweredItem {
                question: "Which colors?".into(),
                header: "Which colors".into(),
                multi_select: true,
                selected: vec!["Red".into(), "Green".into()],
            }],
            declined: false,
        };
        assert_eq!(
            grok_result_card_output(&multi)["answers"][0]["selected"],
            json!(["Red", "Green"])
        );
        let declined = QuestionOutcome {
            answers: vec![],
            declined: true,
        };
        let out = grok_result_card_output(&declined);
        assert_eq!(out["declined"], true);
        assert_eq!(out["answers"], json!([]));
    }

    #[test]
    fn grok_result_card_input_output_question_texts_align() {
        // The frontend matches answers to questions by (header, question); with
        // header empty on both sides, the question text must match verbatim so the
        // capsule shows the pick rather than "未选择". `build_outcome` copies the
        // spec's question into the answer, so a full round trip stays aligned.
        let specs = parse_grok_ext_questions(&grok_params(json!([{
            "question": "Pick one",
            "options": [
                { "label": "A", "description": "" },
                { "label": "B", "description": "" }
            ]
        }])))
        .unwrap();
        let outcome = build_outcome(
            &specs,
            &QuestionAnswer {
                answers: vec![QuestionAnswerItem {
                    question_id: specs[0].id.clone(),
                    labels: vec!["A".into()],
                }],
                declined: false,
            },
        );
        let input = grok_result_card_input(&specs);
        let output = grok_result_card_output(&outcome);
        assert_eq!(input["questions"][0]["question"], output["answers"][0]["question"]);
        assert_eq!(output["answers"][0]["header"], "");
    }
}
