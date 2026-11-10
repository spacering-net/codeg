//! codex's asynchronous questions in a rollout.
//!
//! codex 0.166 (driven by codex-acp 2.6.0) gives GPT-6-family models a
//! `request_user_input_async` tool: the model asks one or more questions and
//! its turn goes on without waiting. The rollout records the call (a
//! `function_call` whose arguments are `{questions: [{title, options?}]}`), its
//! output (`{"accepted":true}`), and, when the user answered while the turn was
//! still running, an ordinary user message holding the reply envelope codex's
//! own clients write:
//!
//! ```text
//! <send_user_message_question_reply>
//! [{"answer":"Staging","question":"Which environment?","questionItemId":"[\"request_user_input_async\",\"call_1\",0]"}]
//! </send_user_message_question_reply>
//! ```
//!
//! Live, codeg asks these questions on the same card as Plan mode's blocking
//! `request_user_input` and, once answered, shows the same answered card in the
//! stream. History renders the call as that card too: the tool is named
//! `request_user_input`, its input takes codex's `request_user_input` shape,
//! and its output takes codex's answer shape, filled from the reply envelope.
//! The envelope message itself is folded into the card instead of standing as
//! a user bubble of raw JSON that also splits the turn. An envelope that names
//! no call in the rollout (written by another Codex client, say) is shown the
//! way codex shows it: each question quoted, followed by its answer.
//!
//! The envelope format follows codex's `context-fragments/src/answered_question.rs`
//! and its parsing `tui/src/async_question_reply.rs` (rust-v0.166.0).

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

/// The tool name codex records the call under.
pub(crate) const TOOL_NAME: &str = "request_user_input_async";
/// The tool name the card renders under: Plan mode's question tool, which the
/// frontend already draws as the answered-question card.
pub(crate) const CARD_TOOL_NAME: &str = "request_user_input";

const REPLY_START: &str = "<send_user_message_question_reply>";
const REPLY_END: &str = "</send_user_message_question_reply>";
/// The prefix codex's IDE clients put before a user request.
const IDE_CONTEXT_PREFIX: &str = "# Context from my IDE setup:\n";
const IDE_REQUEST_MARKER: &str = "\n## My request for Codex:\n";
/// codex's prefix for the free-form part of a `request_user_input` answer.
const NOTE_PREFIX: &str = "user_note: ";

struct Question {
    title: String,
    options: Vec<String>,
}

/// One `request_user_input_async` call, and what the user answered.
pub(crate) struct AsyncQuestionCall {
    questions: Vec<Question>,
    /// Answer text by question index, from the reply envelope.
    answers: BTreeMap<usize, String>,
    /// Where the call's result card sits in the message list, once its output
    /// has been read.
    pub(crate) result_index: Option<usize>,
}

impl AsyncQuestionCall {
    /// The call from its `function_call` arguments; `None` when they hold no
    /// question.
    pub(crate) fn from_arguments(args: &Value) -> Option<Self> {
        let questions: Vec<Question> = args
            .get("questions")?
            .as_array()?
            .iter()
            .filter_map(|q| {
                let title = q.get("title")?.as_str()?.trim();
                if title.is_empty() {
                    return None;
                }
                let options = q
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                Some(Question {
                    title: title.to_string(),
                    options,
                })
            })
            .collect();
        (!questions.is_empty()).then_some(Self {
            questions,
            answers: BTreeMap::new(),
            result_index: None,
        })
    }

    /// The card's input: codex's `request_user_input` arguments. The ids are
    /// the ones codex-acp gives the same questions on the live form.
    pub(crate) fn card_input(&self) -> String {
        let questions: Vec<Value> = self
            .questions
            .iter()
            .enumerate()
            .map(|(index, q)| {
                serde_json::json!({
                    "id": question_id(index),
                    "header": "",
                    "question": q.title,
                    "options": q
                        .options
                        .iter()
                        .map(|label| serde_json::json!({"label": label, "description": ""}))
                        .collect::<Vec<_>>(),
                })
            })
            .collect();
        serde_json::json!({ "questions": questions }).to_string()
    }

    /// The card's output: codex's `request_user_input` answers, keyed by
    /// question id. Empty until the envelope answers something, which is what
    /// an unanswered Plan-mode question records too.
    pub(crate) fn card_output(&self) -> String {
        let answers: serde_json::Map<String, Value> = self
            .answers
            .iter()
            .filter_map(|(index, answer)| {
                let question = self.questions.get(*index)?;
                Some((
                    question_id(*index),
                    serde_json::json!({ "answers": encode_answer(question, answer) }),
                ))
            })
            .collect();
        serde_json::json!({ "answers": answers }).to_string()
    }
}

fn question_id(index: usize) -> String {
    format!("question_{index}")
}

/// One answer as codex's `request_user_input` lists it: an option label, then
/// the rest as a `user_note: ` entry. codex-acp writes an option followed by
/// the user's note as `<label>\n\n<note>`, and an own answer as the bare text.
fn encode_answer(question: &Question, answer: &str) -> Vec<String> {
    let answer = answer.trim();
    for label in &question.options {
        if answer == label {
            return vec![label.clone()];
        }
        if let Some(note) = answer
            .strip_prefix(label.as_str())
            .and_then(|rest| rest.strip_prefix("\n\n"))
        {
            let note = note.trim();
            return if note.is_empty() {
                vec![label.clone()]
            } else {
                vec![label.clone(), format!("{NOTE_PREFIX}{note}")]
            };
        }
    }
    vec![format!("{NOTE_PREFIX}{answer}")]
}

struct Reply {
    question_item_id: String,
    question: String,
    answer: String,
}

/// The replies in a user message that is exactly one reply envelope, as
/// codex's TUI reads it: optionally after the IDE context prefix, holding one
/// reply or a non-empty array of them. `None` for any other message.
fn parse_replies(text: &str) -> Option<Vec<Reply>> {
    let text = text.trim();
    let text = if text.starts_with(IDE_CONTEXT_PREFIX) {
        text.rsplit_once(IDE_REQUEST_MARKER)?.1.trim()
    } else {
        text
    };
    let body = text.strip_prefix(REPLY_START)?.strip_suffix(REPLY_END)?;
    let parsed: Value = serde_json::from_str(body).ok()?;
    let items = match parsed {
        Value::Array(items) => items,
        one => vec![one],
    };
    let replies = items
        .iter()
        .map(|item| {
            Some(Reply {
                question_item_id: item.get("questionItemId")?.as_str()?.to_string(),
                question: item.get("question")?.as_str()?.to_string(),
                answer: item.get("answer")?.as_str()?.to_string(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    (!replies.is_empty()).then_some(replies)
}

/// The call and question index a reply answers: its `questionItemId` is the
/// JSON array `["request_user_input_async", <call id>, <index>]`.
fn reply_target(question_item_id: &str) -> Option<(String, usize)> {
    let parts: Vec<Value> = serde_json::from_str(question_item_id).ok()?;
    let [tool, call, index] = parts.as_slice() else {
        return None;
    };
    (tool.as_str()? == TOOL_NAME).then_some(())?;
    Some((
        call.as_str()?.to_string(),
        usize::try_from(index.as_u64()?).ok()?,
    ))
}

/// What a user message is, with respect to async questions.
pub(crate) enum ReplyMessage {
    /// Not a reply envelope: render it as it is.
    NotAReply,
    /// Every reply answers a call of this rollout: the answers went onto those
    /// calls (whose ids are listed), and the message renders as nothing.
    Answered(Vec<String>),
    /// A reply envelope this rollout has no call for: render this text
    /// instead, each question quoted and followed by its answer, as codex does.
    Display(String),
}

/// Read a user message as a reply to `calls`, recording the answers on them.
/// Idempotent, so the twin records of one message may both pass through here.
pub(crate) fn take_reply(
    text: &str,
    calls: &mut HashMap<String, AsyncQuestionCall>,
) -> ReplyMessage {
    let Some(replies) = parse_replies(text) else {
        return ReplyMessage::NotAReply;
    };
    let targets: Option<Vec<(String, usize)>> = replies
        .iter()
        .map(|reply| {
            reply_target(&reply.question_item_id)
                .filter(|(call, index)| calls.get(call).is_some_and(|c| *index < c.questions.len()))
        })
        .collect();
    let Some(targets) = targets else {
        return ReplyMessage::Display(
            replies
                .iter()
                .map(|reply| format!("> {}\n\n{}", reply.question, reply.answer))
                .collect::<Vec<_>>()
                .join("\n\n"),
        );
    };
    let mut touched: Vec<String> = Vec::new();
    for ((call, index), reply) in targets.into_iter().zip(replies) {
        if let Some(c) = calls.get_mut(&call) {
            c.answers.insert(index, reply.answer);
        }
        if !touched.contains(&call) {
            touched.push(call);
        }
    }
    ReplyMessage::Answered(touched)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call() -> AsyncQuestionCall {
        AsyncQuestionCall::from_arguments(&serde_json::json!({"questions": [
            {"title": "Which environment should I deploy to?", "options": ["Staging", "Production"]},
            {"title": "Anything else I should know?"}
        ]}))
        .expect("questions")
    }

    /// The envelope codex-acp 2.6.0 steered for codeg's form, recorded live:
    /// "Staging" picked with a note on the first question, free text on the
    /// second.
    const LIVE_REPLY: &str = "<send_user_message_question_reply>\n[{\"answer\":\"Staging\\n\\nprobe note\",\"question\":\"Which environment should I deploy to?\",\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"call_1\\\",0]\"},{\"answer\":\"probe note\",\"question\":\"Anything else I should know?\",\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"call_1\\\",1]\"}]\n</send_user_message_question_reply>";

    #[test]
    fn the_call_renders_as_a_request_user_input_card() {
        let input: Value = serde_json::from_str(&call().card_input()).unwrap();
        assert_eq!(
            input,
            serde_json::json!({"questions": [
                {"id": "question_0", "header": "", "question": "Which environment should I deploy to?",
                 "options": [{"label": "Staging", "description": ""}, {"label": "Production", "description": ""}]},
                {"id": "question_1", "header": "", "question": "Anything else I should know?", "options": []}
            ]})
        );
        let output: Value = serde_json::from_str(&call().card_output()).unwrap();
        assert_eq!(output, serde_json::json!({"answers": {}}));
    }

    #[test]
    fn a_reply_answers_its_call_in_codex_answer_shape() {
        let mut calls = HashMap::from([("call_1".to_string(), call())]);
        let ReplyMessage::Answered(touched) = take_reply(LIVE_REPLY, &mut calls) else {
            panic!("the reply names call_1");
        };
        assert_eq!(touched, ["call_1"]);
        let output: Value = serde_json::from_str(&calls["call_1"].card_output()).unwrap();
        assert_eq!(
            output,
            serde_json::json!({"answers": {
                "question_0": {"answers": ["Staging", "user_note: probe note"]},
                "question_1": {"answers": ["user_note: probe note"]}
            }})
        );
        // The twin record of the same message changes nothing.
        assert!(matches!(
            take_reply(LIVE_REPLY, &mut calls),
            ReplyMessage::Answered(_)
        ));
        assert_eq!(
            serde_json::from_str::<Value>(&calls["call_1"].card_output()).unwrap(),
            output
        );
    }

    #[test]
    fn answers_keep_option_labels_and_own_answers_apart() {
        let q = &call().questions[0];
        assert_eq!(encode_answer(q, "Production"), ["Production"]);
        assert_eq!(encode_answer(q, "Staging\n\n"), ["Staging"]);
        assert_eq!(encode_answer(q, "Canary"), ["user_note: Canary"]);
        // Only a whole label followed by codex-acp's separator is a choice.
        assert_eq!(encode_answer(q, "Staging2"), ["user_note: Staging2"]);
    }

    #[test]
    fn a_reply_to_no_call_of_this_rollout_reads_as_codex_shows_it() {
        let mut calls = HashMap::new();
        let ReplyMessage::Display(text) = take_reply(LIVE_REPLY, &mut calls) else {
            panic!("no call to fold it into");
        };
        assert_eq!(
            text,
            "> Which environment should I deploy to?\n\nStaging\n\nprobe note\n\n\
             > Anything else I should know?\n\nprobe note"
        );
        // An index past the call's questions is not its answer either.
        let mut calls = HashMap::from([("call_1".to_string(), call())]);
        let past = LIVE_REPLY.replace("\\\"call_1\\\",1]", "\\\"call_1\\\",5]");
        assert!(matches!(
            take_reply(&past, &mut calls),
            ReplyMessage::Display(_)
        ));
    }

    #[test]
    fn only_a_whole_envelope_is_a_reply() {
        let mut calls = HashMap::from([("call_1".to_string(), call())]);
        for text in [
            "plain text",
            "see <send_user_message_question_reply>[]</send_user_message_question_reply>",
            "<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>",
            "<send_user_message_question_reply>\nnot json\n</send_user_message_question_reply>",
            "<send_user_message_question_reply>\n[{\"answer\":\"x\"}]\n</send_user_message_question_reply>",
        ] {
            assert!(
                matches!(take_reply(text, &mut calls), ReplyMessage::NotAReply),
                "{text}"
            );
        }
        // One bare reply object, after the IDE context prefix, also counts.
        let one = format!(
            "{IDE_CONTEXT_PREFIX}## Open tabs:\n- a.rs\n{IDE_REQUEST_MARKER}{REPLY_START}\n{}\n{REPLY_END}",
            serde_json::json!({"answer": "Production", "question": "Which environment should I deploy to?",
                "questionItemId": "[\"request_user_input_async\",\"call_1\",0]"})
        );
        assert!(matches!(
            take_reply(&one, &mut calls),
            ReplyMessage::Answered(_)
        ));
    }

    #[test]
    fn a_call_without_questions_is_no_card() {
        assert!(AsyncQuestionCall::from_arguments(&serde_json::json!({"questions": []})).is_none());
        assert!(AsyncQuestionCall::from_arguments(
            &serde_json::json!({"questions": [{"title": " "}]})
        )
        .is_none());
    }
}
