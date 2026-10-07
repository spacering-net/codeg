//! Cursor ACP client-extension methods.
//!
//! Cursor's CLI (`cursor-agent acp`) sends these as JSON-RPC **requests with
//! ids**, even when https://cursor.com/docs/cli/acp calls some of them
//! notifications. The ACP runtime's default for an unregistered method is `-32601 Method
//! not found`, which is what codeg used to send — and what made a live Cursor
//! turn show a red banner on every `Task` spawn / todo update.
//!
//! Blocking methods (`cursor/ask_question`, `cursor/create_plan`) wait for a
//! reply before the agent continues. They reuse the same interactive cards as
//! the Grok bridges ([`crate::acp::question`], [`crate::acp::plan_approval`])
//! so a new agent does not grow a third UI. Fire-and-forget-shaped methods
//! (`cursor/update_todos`, `cursor/task`, `cursor/generate_image`) still need
//! an `accepted` / `completed` / `generated` envelope because the CLI sends a
//! request id; the reply is the documented outcome object, not a silent drop.
//!
//! Adding a new `cursor/…` method: one `#[request(method = …)]` newtype here,
//! one `.on_receive_request` in `connection.rs`, a reply builder in this
//! module. The runtime routes on the raw wire method, so the derive string must match
//! Cursor's docs byte-for-byte.

use agent_client_protocol::JsonRpcRequest;
use serde_json::{json, Value};

use crate::acp::plan_approval::{
    PlanApprovalAnswer, PlanApprovalDecision, MAX_PLAN_MARKDOWN_CHARS,
};
use crate::acp::question::{
    synthesize_header, QuestionOption, QuestionOutcome, QuestionSpec, MAX_OPTIONS, MAX_QUESTIONS,
    MAX_QUESTION_TEXT_CHARS, MIN_OPTIONS,
};

/// `cursor/ask_question` — blocking. Params `{ toolCallId, title?, questions }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/ask_question", response = Value)]
#[serde(transparent)]
pub struct CursorAskQuestionRequest(pub Value);

/// `cursor/create_plan` — blocking. Params `{ toolCallId, name?, overview?, plan, todos?, … }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/create_plan", response = Value)]
#[serde(transparent)]
pub struct CursorCreatePlanRequest(pub Value);

/// `cursor/update_todos`. Params `{ toolCallId, todos, merge }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/update_todos", response = Value)]
#[serde(transparent)]
pub struct CursorUpdateTodosRequest(pub Value);

/// `cursor/task`. Params `{ toolCallId, description, prompt, subagentType, agentId?, durationMs? }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/task", response = Value)]
#[serde(transparent)]
pub struct CursorTaskRequest(pub Value);

/// `cursor/generate_image`. Params `{ toolCallId, description, filePath?, referenceImagePaths? }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/generate_image", response = Value)]
#[serde(transparent)]
pub struct CursorGenerateImageRequest(pub Value);

/// Cursor's documented `{ outcome: { outcome: <kind>, … } }` envelope.
pub fn cursor_outcome(kind: &str) -> Value {
    json!({ "outcome": { "outcome": kind } })
}

fn cursor_outcome_with(kind: &str, extra: Value) -> Value {
    let mut inner = json!({ "outcome": kind });
    if let (Some(obj), Some(extra_obj)) = (inner.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    json!({ "outcome": inner })
}

/// One Cursor question plus the label → option-id map needed to reply. The
/// card shows labels (same as Grok / pi); Cursor's response wants option ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorAskQuestion {
    pub spec: QuestionSpec,
    /// Cursor's `questions[].id` (the `questionId` we must echo).
    pub cursor_id: String,
    /// `(label, option id)` in wire order, mirroring [`crate::acp::question::PiSelectAsk`].
    pub option_ids: Vec<(String, String)>,
}

/// Parse `cursor/ask_question` params into card specs + the id map for the
/// reply. Cursor's shape is `{ questions: [{ id, prompt, options:[{id,label}],
/// allowMultiple? }] }` — `prompt` not `question`, `allowMultiple` not
/// `multiSelect`. Counts are clamped to codeg's card bounds the same way
/// [`crate::acp::question::parse_grok_ext_questions`] clamps Grok, so
/// `register_question` will not decline the whole ask.
pub fn parse_cursor_ask_questions(params: &Value) -> Result<Vec<CursorAskQuestion>, String> {
    let arr = params
        .get("questions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "cursor/ask_question missing `questions` array".to_string())?;
    if arr.is_empty() {
        return Err("cursor/ask_question has no questions".to_string());
    }
    if arr.len() > MAX_QUESTIONS {
        tracing::warn!(
            "[cursor ask] dropping {} question(s) past the max of {MAX_QUESTIONS}",
            arr.len() - MAX_QUESTIONS
        );
    }
    let title = params
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let mut out = Vec::with_capacity(arr.len().min(MAX_QUESTIONS));
    for (qi, q) in arr.iter().take(MAX_QUESTIONS).enumerate() {
        let prompt = q
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("questions[{qi}] is missing a non-empty `prompt`"))?;
        let cursor_id = q
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("q{qi}"));
        let multi_select = q
            .get("allowMultiple")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let opts = q
            .get("options")
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("questions[{qi}] is missing an `options` array"))?;
        if opts.len() > MAX_OPTIONS {
            tracing::warn!(
                "[cursor ask] questions[{qi}] has {} options; truncating to {MAX_OPTIONS}",
                opts.len()
            );
        }
        let mut options = Vec::with_capacity(opts.len().min(MAX_OPTIONS));
        let mut option_ids = Vec::new();
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
            if !seen_labels.insert(label.to_string()) {
                continue;
            }
            let option_id = o
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(label)
                .to_string();
            let clipped: String = label.chars().take(MAX_QUESTION_TEXT_CHARS).collect();
            options.push(QuestionOption {
                label: clipped.clone(),
                description: String::new(),
            });
            option_ids.push((clipped, option_id));
        }
        if options.len() < MIN_OPTIONS {
            return Err(format!(
                "questions[{qi}] has fewer than {MIN_OPTIONS} usable options"
            ));
        }
        // Cursor's `title` is one banner for the whole ask; with none, fall back
        // to the question itself the way the grok / pi bridges do rather than
        // stamping a constant on every chip.
        let header = synthesize_header(title.unwrap_or(prompt));
        out.push(CursorAskQuestion {
            spec: QuestionSpec {
                id: uuid::Uuid::new_v4().to_string(),
                question: prompt.chars().take(MAX_QUESTION_TEXT_CHARS).collect(),
                header,
                multi_select,
                options,
                is_secret: false,
            },
            cursor_id,
            option_ids,
        });
    }
    Ok(out)
}

/// Map the card's outcome onto Cursor's `CursorAskQuestionResponse`.
///
/// The ask card ALWAYS offers a free-text "Other" row, and on a single-select
/// question picking it CLEARS the real options — so a submitted label is very
/// often not one of Cursor's options at all. Cursor's `answered` variant can
/// only name option ids, so such an answer has no faithful encoding there:
/// replying `answered` with an empty `selectedOptionIds` would tell the agent
/// the user answered and chose nothing, and drop what they typed on the floor.
/// [`crate::acp::question::pi_select_option_id`] refuses to fake an option for
/// the same reason. So `answered` is used ONLY when every selected label maps;
/// otherwise the reply is `skipped` and the documented `reason` carries what
/// the user actually said, which is lossless in the direction that matters.
pub fn build_cursor_ask_response(parsed: &[CursorAskQuestion], outcome: &QuestionOutcome) -> Value {
    if outcome.declined {
        return cursor_ask_skip_response();
    }
    let mut answers = Vec::new();
    let mut all_mapped = true;
    for q in parsed {
        let Some(item) = outcome
            .answers
            .iter()
            .find(|a| a.question == q.spec.question)
        else {
            continue;
        };
        let mut selected_option_ids = Vec::with_capacity(item.selected.len());
        for label in &item.selected {
            match q.option_ids.iter().find(|(l, _)| l == label) {
                Some((_, id)) => selected_option_ids.push(id.clone()),
                None => all_mapped = false,
            }
        }
        if selected_option_ids.is_empty() {
            continue;
        }
        answers.push(json!({
            "questionId": q.cursor_id,
            "selectedOptionIds": selected_option_ids,
        }));
    }
    if !all_mapped || answers.is_empty() {
        return cursor_ask_skip_response_with_reason(&free_text_reason(outcome));
    }
    json!({
        "outcome": {
            "outcome": "answered",
            "answers": answers,
        }
    })
}

/// Render a submitted [`QuestionOutcome`] as prose for the `skipped` reason —
/// the only channel Cursor's response leaves for an answer its option ids can't
/// express. Bounded like every other agent-facing field here.
fn free_text_reason(outcome: &QuestionOutcome) -> String {
    let said = outcome
        .answers
        .iter()
        .filter(|a| !a.selected.is_empty())
        .map(|a| format!("{}: {}", a.question, a.selected.join(", ")))
        .collect::<Vec<_>>()
        .join(" | ");
    if said.is_empty() {
        return String::new();
    }
    format!("the user answered in free text — {said}")
        .chars()
        .take(MAX_QUESTION_TEXT_CHARS)
        .collect()
}

pub fn cursor_ask_skip_response() -> Value {
    cursor_outcome("skipped")
}

/// `skipped` plus the documented optional `reason`, so the agent can tell a
/// user who dismissed the card from a host that could not present it at all.
pub fn cursor_ask_skip_response_with_reason(reason: &str) -> Value {
    let reason = reason.trim();
    if reason.is_empty() {
        return cursor_ask_skip_response();
    }
    cursor_outcome_with(
        "skipped",
        json!({ "reason": reason.chars().take(MAX_QUESTION_TEXT_CHARS).collect::<String>() }),
    )
}

/// Plan markdown + toolCallId for the shared approval card. Cursor puts the
/// body in `plan` (not Grok's `planContent`). Empty plan is valid — same
/// empty-state surface as Grok.
pub fn parse_cursor_create_plan(params: &Value) -> Result<(String, String), String> {
    let obj = params
        .as_object()
        .ok_or_else(|| "cursor/create_plan params is not an object".to_string())?;
    let mut plan: String = obj
        .get("plan")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(MAX_PLAN_MARKDOWN_CHARS)
        .collect();
    if plan.is_empty() {
        if let Some(overview) = obj.get("overview").and_then(|v| v.as_str()) {
            plan = overview.chars().take(MAX_PLAN_MARKDOWN_CHARS).collect();
        }
    }
    let tool_call_id = obj
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok((plan, tool_call_id))
}

/// Map the plan-approval card onto Cursor's `CursorCreatePlanResponse`.
/// Approve → `accepted` (unblocks the agent). Request-changes / abandon →
/// `rejected` / `cancelled` so Cursor does not treat a disconnect as a silent
/// go-ahead — same caution as [`crate::acp::plan_approval::grok_exit_plan_disconnect_response`].
pub fn build_cursor_create_plan_response(answer: &PlanApprovalAnswer) -> Value {
    match answer.decision {
        PlanApprovalDecision::Approve => cursor_outcome("accepted"),
        PlanApprovalDecision::RequestChanges => {
            let reason = answer.normalized_feedback();
            if reason.is_empty() {
                cursor_outcome("rejected")
            } else {
                cursor_outcome_with("rejected", json!({ "reason": reason }))
            }
        }
        PlanApprovalDecision::Abandon => cursor_outcome("cancelled"),
    }
}

pub fn cursor_create_plan_disconnect_response() -> Value {
    cursor_outcome("cancelled")
}

/// `cursor/update_todos` — accept the list. Live todo UI is a follow-up; the
/// agent only needs the documented `accepted` outcome to stop retrying.
///
/// The documented `accepted` variant is `{ outcome, todos }` — `todos` is NOT
/// optional there — and it means "the list the client now holds". Codeg keeps
/// no todo state, so echo back exactly what the request carried: correct for
/// `merge: false` (replace) and the closest honest answer for `merge: true`.
/// Bare `accepted` is only for a request that carried no `todos` array at all.
pub fn build_cursor_update_todos_response(params: &Value) -> Value {
    match params.get("todos") {
        Some(todos @ Value::Array(_)) => {
            cursor_outcome_with("accepted", json!({ "todos": todos.clone() }))
        }
        _ => cursor_outcome("accepted"),
    }
}

/// `cursor/task` — Cursor already spawned the subagent; we acknowledge so the
/// parent turn is not left waiting on `-32601`. Echo `agentId` / `durationMs`
/// when the request carried them.
pub fn build_cursor_task_response(params: &Value) -> Value {
    let mut extra = serde_json::Map::new();
    if let Some(id) = params.get("agentId").and_then(|v| v.as_str()) {
        extra.insert("agentId".into(), json!(id));
    }
    if let Some(ms) = params.get("durationMs").and_then(|v| v.as_u64()) {
        extra.insert("durationMs".into(), json!(ms));
    }
    if extra.is_empty() {
        cursor_outcome("completed")
    } else {
        cursor_outcome_with("completed", Value::Object(extra))
    }
}

/// `cursor/generate_image` — no image renderer yet. If Cursor already wrote a
/// file, acknowledge the path; otherwise reject so the agent does not hang.
pub fn build_cursor_generate_image_response(params: &Value) -> Value {
    match params.get("filePath").and_then(|v| v.as_str()).map(str::trim) {
        Some(path) if !path.is_empty() => {
            cursor_outcome_with("generated", json!({ "filePath": path }))
        }
        _ => cursor_outcome_with(
            "rejected",
            json!({ "reason": "image display is not implemented" }),
        ),
    }
}

/// Top-level param keys only — never the prompt / plan body.
pub fn param_keys(params: &Value) -> Vec<&str> {
    params
        .as_object()
        .map(|o| o.keys().map(String::as_str).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    // `matches_method` lives on the `JsonRpcMessage` supertrait, not on the
    // `JsonRpcRequest` the derive is named after.
    use agent_client_protocol::JsonRpcMessage;

    fn answered(question: &str, selected: &[&str]) -> crate::acp::question::QuestionAnsweredItem {
        crate::acp::question::QuestionAnsweredItem {
            question: question.into(),
            header: "Cursor".into(),
            multi_select: selected.len() > 1,
            selected: selected.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn request_types_match_cursor_docs_methods() {
        assert!(CursorAskQuestionRequest::matches_method("cursor/ask_question"));
        assert!(CursorCreatePlanRequest::matches_method("cursor/create_plan"));
        assert!(CursorUpdateTodosRequest::matches_method("cursor/update_todos"));
        assert!(CursorTaskRequest::matches_method("cursor/task"));
        assert!(CursorGenerateImageRequest::matches_method(
            "cursor/generate_image"
        ));
        assert!(!CursorTaskRequest::matches_method("session/prompt"));
        assert!(!CursorTaskRequest::matches_method("_x.ai/ask_user_question"));
    }

    #[test]
    fn parse_ask_reads_prompt_and_option_ids() {
        let parsed = parse_cursor_ask_questions(&json!({
            "toolCallId": "call_123",
            "title": "Need input",
            "questions": [{
                "id": "q1",
                "prompt": "Which mode should I use?",
                "options": [
                    { "id": "agent", "label": "Agent" },
                    { "id": "plan", "label": "Plan" }
                ],
                "allowMultiple": false
            }]
        }))
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].cursor_id, "q1");
        assert_eq!(parsed[0].spec.question, "Which mode should I use?");
        assert!(!parsed[0].spec.multi_select);
        assert_eq!(parsed[0].option_ids.len(), 2);
        assert_eq!(parsed[0].option_ids[0], ("Agent".into(), "agent".into()));
    }

    #[test]
    fn parse_ask_rejects_empty_or_short_options() {
        assert!(parse_cursor_ask_questions(&json!({ "questions": [] })).is_err());
        assert!(parse_cursor_ask_questions(&json!({
            "questions": [{
                "id": "q1",
                "prompt": "Only one?",
                "options": [{ "id": "a", "label": "A" }]
            }]
        }))
        .is_err());
    }

    #[test]
    fn build_ask_response_maps_labels_to_option_ids() {
        let parsed = parse_cursor_ask_questions(&json!({
            "questions": [{
                "id": "q1",
                "prompt": "Pick",
                "options": [
                    { "id": "agent", "label": "Agent" },
                    { "id": "plan", "label": "Plan" }
                ]
            }]
        }))
        .unwrap();
        let outcome = QuestionOutcome {
            answers: vec![crate::acp::question::QuestionAnsweredItem {
                question: "Pick".into(),
                header: "Cursor".into(),
                multi_select: false,
                selected: vec!["Plan".into()],
            }],
            declined: false,
        };
        let v = build_cursor_ask_response(&parsed, &outcome);
        assert_eq!(v["outcome"]["outcome"], "answered");
        assert_eq!(v["outcome"]["answers"][0]["questionId"], "q1");
        assert_eq!(v["outcome"]["answers"][0]["selectedOptionIds"][0], "plan");
    }

    #[test]
    fn declined_ask_is_skipped() {
        let v = build_cursor_ask_response(
            &[],
            &QuestionOutcome {
                answers: Vec::new(),
                declined: true,
            },
        );
        assert_eq!(v["outcome"]["outcome"], "skipped");
        // A plain dismissal carries no reason — that field is for the cases the
        // host itself could not ask, or could not encode the answer.
        assert!(v["outcome"].get("reason").is_none());
    }

    /// The ask card always offers a free-text "Other" row, and single-select
    /// REPLACES the picked option with it — so the reply must never claim
    /// `answered` with an empty selection (the agent would read that as "asked
    /// and chose nothing") and must not silently eat what the user typed.
    #[test]
    fn free_text_answer_is_skipped_with_the_users_words() {
        let parsed = parse_cursor_ask_questions(&json!({
            "questions": [{
                "id": "q1",
                "prompt": "Pick",
                "options": [
                    { "id": "agent", "label": "Agent" },
                    { "id": "plan", "label": "Plan" }
                ]
            }]
        }))
        .unwrap();
        let v = build_cursor_ask_response(
            &parsed,
            &QuestionOutcome {
                answers: vec![answered("Pick", &["neither — use review mode"])],
                declined: false,
            },
        );
        assert_eq!(v["outcome"]["outcome"], "skipped");
        assert_ne!(v["outcome"]["outcome"], "answered");
        assert!(v["outcome"]["answers"].is_null());
        assert!(v["outcome"]["reason"]
            .as_str()
            .unwrap()
            .contains("neither — use review mode"));
    }

    /// A multi-select that mixes a real option with typed text has no faithful
    /// `answered` encoding either: the typed half would vanish. Skip with the
    /// whole submission in the reason rather than half-answer.
    #[test]
    fn partially_mapped_answer_does_not_drop_the_typed_half() {
        let parsed = parse_cursor_ask_questions(&json!({
            "questions": [{
                "id": "q1",
                "prompt": "Pick",
                "allowMultiple": true,
                "options": [
                    { "id": "agent", "label": "Agent" },
                    { "id": "plan", "label": "Plan" }
                ]
            }]
        }))
        .unwrap();
        let v = build_cursor_ask_response(
            &parsed,
            &QuestionOutcome {
                answers: vec![answered("Pick", &["Agent", "and also ship docs"])],
                declined: false,
            },
        );
        assert_eq!(v["outcome"]["outcome"], "skipped");
        let reason = v["outcome"]["reason"].as_str().unwrap();
        assert!(reason.contains("Agent"));
        assert!(reason.contains("and also ship docs"));
    }

    #[test]
    fn skip_reason_is_omitted_when_empty() {
        assert!(cursor_ask_skip_response_with_reason("   ")["outcome"]
            .get("reason")
            .is_none());
        assert_eq!(
            cursor_ask_skip_response_with_reason("bridge unavailable")["outcome"]["reason"],
            "bridge unavailable"
        );
    }

    /// Without a `title`, every chip used to read "Cursor"; the grok / pi
    /// bridges synthesize the chip from the question instead.
    #[test]
    fn header_falls_back_to_the_prompt_when_no_title() {
        let parsed = parse_cursor_ask_questions(&json!({
            "questions": [{
                "id": "q1",
                "prompt": "Which mode should I use?",
                "options": [
                    { "id": "a", "label": "A" },
                    { "id": "b", "label": "B" }
                ]
            }]
        }))
        .unwrap();
        assert_eq!(parsed[0].spec.header, "Which mode s");
        let titled = parse_cursor_ask_questions(&json!({
            "title": "Need input",
            "questions": [{
                "id": "q1",
                "prompt": "Which mode should I use?",
                "options": [
                    { "id": "a", "label": "A" },
                    { "id": "b", "label": "B" }
                ]
            }]
        }))
        .unwrap();
        assert_eq!(titled[0].spec.header, "Need input");
    }

    #[test]
    fn parse_create_plan_reads_plan_not_plan_content() {
        let (plan, tc) = parse_cursor_create_plan(&json!({
            "toolCallId": "call_124",
            "name": "Refactor",
            "plan": "1. Inspect\n2. Update",
        }))
        .unwrap();
        assert_eq!(plan, "1. Inspect\n2. Update");
        assert_eq!(tc, "call_124");
    }

    #[test]
    fn create_plan_decisions_match_cursor_outcomes() {
        let accept = PlanApprovalAnswer {
            decision: PlanApprovalDecision::Approve,
            feedback: None,
        };
        assert_eq!(
            build_cursor_create_plan_response(&accept)["outcome"]["outcome"],
            "accepted"
        );
        let reject = PlanApprovalAnswer {
            decision: PlanApprovalDecision::RequestChanges,
            feedback: Some("use SSE".into()),
        };
        let v = build_cursor_create_plan_response(&reject);
        assert_eq!(v["outcome"]["outcome"], "rejected");
        assert_eq!(v["outcome"]["reason"], "use SSE");
        let cancel = PlanApprovalAnswer {
            decision: PlanApprovalDecision::Abandon,
            feedback: None,
        };
        assert_eq!(
            build_cursor_create_plan_response(&cancel)["outcome"]["outcome"],
            "cancelled"
        );
        assert_eq!(
            cursor_create_plan_disconnect_response()["outcome"]["outcome"],
            "cancelled"
        );
    }

    #[test]
    fn task_echoes_agent_id() {
        let v = build_cursor_task_response(&json!({
            "toolCallId": "call_126",
            "description": "Explore",
            "agentId": "abc-1",
            "durationMs": 12
        }));
        assert_eq!(v["outcome"]["outcome"], "completed");
        assert_eq!(v["outcome"]["agentId"], "abc-1");
        assert_eq!(v["outcome"]["durationMs"], 12);
    }

    #[test]
    fn generate_image_generated_when_path_present() {
        let v = build_cursor_generate_image_response(&json!({
            "filePath": "/tmp/icon.png"
        }));
        assert_eq!(v["outcome"]["outcome"], "generated");
        assert_eq!(v["outcome"]["filePath"], "/tmp/icon.png");
        let rejected = build_cursor_generate_image_response(&json!({}));
        assert_eq!(rejected["outcome"]["outcome"], "rejected");
    }

    /// Cursor's documented `accepted` variant is `{ outcome, todos }` — the
    /// list the client now holds — so the reply has to carry one back.
    #[test]
    fn update_todos_accepted_echoes_the_list() {
        let todos = json!([
            { "id": "t1", "content": "Read the parser", "status": "completed" },
            { "id": "t2", "content": "Wire the card", "status": "in_progress" },
        ]);
        let v = build_cursor_update_todos_response(&json!({
            "toolCallId": "call_127",
            "merge": false,
            "todos": todos,
        }));
        assert_eq!(v["outcome"]["outcome"], "accepted");
        assert_eq!(v["outcome"]["todos"], todos);
        // No list on the request → bare accepted, not a bogus empty list.
        let bare = build_cursor_update_todos_response(&json!({ "toolCallId": "call_128" }));
        assert_eq!(bare["outcome"]["outcome"], "accepted");
        assert!(bare["outcome"].get("todos").is_none());
    }
}
