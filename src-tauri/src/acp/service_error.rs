//! A service error envelope, read down to the message it carries.
//!
//! codex keeps a provider's error body verbatim as a turn error's message. For
//! some failures, an HTTP 400 for a model the account cannot use for one, that
//! body is a JSON envelope:
//!
//! ```text
//! {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"…"}}
//! ```
//!
//! codex-acp 2.1.1 (#572) reads the message out of it for the `sessionFailure`
//! title, but still forwards the raw JSON as a failed compaction's `error`,
//! which the compaction card shows (live: a compaction whose model request
//! gets that 400 reaches codeg as a readable banner beside a card reading the
//! JSON). [`readable_service_error_message`] is the adapter's
//! `readableServiceErrorMessage`, rule for rule and with JavaScript's idea of
//! a blank message, so the card reads the sentence the banner does. One input
//! it cannot follow: a body escaping a lone surrogate (`"\ud800"`), which
//! `JSON.parse` takes and serde_json refuses, so that body stays as written.

use serde_json::Value;

use crate::acp::js_text::is_js_blank;

/// The error types the adapter recognizes. Any other type is not the envelope.
const SERVICE_ERROR_TYPES: &[&str] = &[
    "invalid_request_error",
    "server_error",
    "rate_limit_error",
    "insufficient_quota",
    "authentication_error",
    "permission_error",
    "not_found_error",
    "conflict_error",
    "overloaded_error",
];

/// The message of a known service error envelope, or `None` for any other
/// text, which then stays as it is.
///
/// Strict on purpose, like the adapter: a key beyond `type`/`status`/`error`
/// (or beyond `type`/`message`/`code`/`param` inside `error`), a status that is
/// not a whole number from 400 to 599, an unknown error type, a non-string
/// `code`/`param`, or a blank message all mean the text is something else, and
/// custom JSON a provider wrote is never cut down to one field of it.
pub(crate) fn readable_service_error_message(text: &str) -> Option<String> {
    let Ok(Value::Object(envelope)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    if envelope
        .keys()
        .any(|key| !matches!(key.as_str(), "type" | "status" | "error"))
        || envelope.get("type").and_then(Value::as_str) != Some("error")
    {
        return None;
    }
    // A JSON number, whole (`400.0` is), in the error range.
    let status = envelope.get("status")?.as_f64()?;
    if status.fract() != 0.0 || !(400.0..=599.0).contains(&status) {
        return None;
    }
    let Value::Object(error) = envelope.get("error")? else {
        return None;
    };
    if error
        .keys()
        .any(|key| !matches!(key.as_str(), "type" | "message" | "code" | "param"))
        || !error
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| SERVICE_ERROR_TYPES.contains(&kind))
        || ["code", "param"].iter().any(|key| {
            error
                .get(*key)
                .is_some_and(|v| !v.is_null() && !v.is_string())
        })
    {
        return None;
    }
    let message = error.get("message")?.as_str()?;
    (!is_js_blank(message)).then(|| message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // codex-acp 2.1.1's own cases (`src/__tests__/ServiceErrorMessage.test.ts`).

    const MESSAGE: &str = "The model is not supported with this account.";

    fn envelope() -> Value {
        json!({"type": "error", "status": 400, "error": {"type": "invalid_request_error", "message": MESSAGE}})
    }

    fn with(mut value: Value, path: &[&str], field: Value) -> Value {
        let mut target = &mut value;
        for key in &path[..path.len() - 1] {
            target = target.get_mut(*key).expect("path exists");
        }
        target[path[path.len() - 1]] = field;
        value
    }

    #[test]
    fn reads_every_known_envelope_type() {
        for kind in SERVICE_ERROR_TYPES {
            let text = with(envelope(), &["error", "type"], json!(kind)).to_string();
            assert_eq!(
                readable_service_error_message(&text).as_deref(),
                Some(MESSAGE),
                "{kind}"
            );
        }
    }

    #[test]
    fn reads_the_optional_standard_fields() {
        for (code, param) in [
            (json!("unsupported_model"), json!("model")),
            (Value::Null, Value::Null),
        ] {
            let text = with(
                with(envelope(), &["error", "code"], code),
                &["error", "param"],
                param,
            )
            .to_string();
            assert_eq!(
                readable_service_error_message(&text).as_deref(),
                Some(MESSAGE)
            );
        }
    }

    #[test]
    fn leaves_every_other_text_alone() {
        let mut cases: Vec<String> = [
            "Plain error text",
            "",
            "{not json}",
            "null",
            "[]",
            "\"json string\"",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        cases.push(json!({"error": {"message": MESSAGE}}).to_string());
        cases.push(with(envelope(), &["custom"], json!(true)).to_string());
        cases.push(with(envelope(), &["type"], json!("custom")).to_string());
        cases.push(with(envelope(), &["status"], json!("400")).to_string());
        for status in [json!(200), json!(399), json!(600), json!(400.5)] {
            cases.push(with(envelope(), &["status"], status).to_string());
        }
        cases.push(with(envelope(), &["error", "type"], json!("custom_error")).to_string());
        cases.push(with(envelope(), &["error", "custom"], json!(true)).to_string());
        cases.push(with(envelope(), &["error", "code"], json!(123)).to_string());
        cases.push(with(envelope(), &["error", "param"], json!({"name": "model"})).to_string());
        cases.push(with(envelope(), &["error", "type"], json!(123)).to_string());
        cases.push(with(envelope(), &["error", "message"], json!("")).to_string());
        cases.push(with(envelope(), &["error", "message"], json!("  ")).to_string());
        cases.push(with(envelope(), &["error", "message"], json!(123)).to_string());
        for text in cases {
            assert_eq!(readable_service_error_message(&text), None, "{text}");
        }
    }

    // codeg's own cases.

    /// JSON writes a whole status as `400.0` just as validly as `400`, and the
    /// adapter's `Number.isInteger` takes both.
    #[test]
    fn a_whole_status_written_as_a_float_is_still_whole() {
        let text = r#"{"type":"error","status":400.0,"error":{"type":"invalid_request_error","message":"m"}}"#;
        assert_eq!(readable_service_error_message(text).as_deref(), Some("m"));
    }

    /// The live body: codex hands the body on with whatever spacing the server
    /// used, and the message keeps its own.
    #[test]
    fn reads_the_body_codex_handed_on_live() {
        let text = "{\"type\": \"error\", \"status\": 400, \"error\": {\"type\": \"invalid_request_error\", \"message\": \"The 'fake-model' model is not supported when using Codex with a ChatGPT account.\"}}";
        assert_eq!(
            readable_service_error_message(text).as_deref(),
            Some(
                "The 'fake-model' model is not supported when using Codex with a ChatGPT account."
            )
        );
    }

    /// claude's API error body has no `status` and carries a `request_id`; it is
    /// not this envelope and is never cut down.
    #[test]
    fn an_anthropic_error_body_is_not_the_envelope() {
        let text = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}"#;
        assert_eq!(readable_service_error_message(text), None);
    }

    /// Inputs run through codex-acp 2.1.1's own `readableServiceErrorMessage`
    /// under Node 24, each with what it returned (`None` where it returned the
    /// text unchanged). The one input it reads and this cannot is the body
    /// escaping a lone surrogate, listed as `None` (see the module docs).
    const ADAPTER_READ: &[(&str, Option<&str>)] = &[
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The model is not supported.\"}}", Some("The model is not supported.")),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The model is not supported.\",\"code\":\"c\",\"param\":\"p\"}}", Some("The model is not supported.")),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The model is not supported.\",\"code\":null,\"param\":null}}", Some("The model is not supported.")),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The model is not supported.\",\"code\":1}}", None),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The model is not supported.\",\"param\":{}}}", None),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The model is not supported.\",\"extra\":1}}", None),
        ("{\"type\":\"error\",\"status\":400.0,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", Some("m")),
        ("{\"type\":\"error\",\"status\":4e2,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", Some("m")),
        ("{\"type\":\"error\",\"status\":-0,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", None),
        ("{\"type\":\"error\",\"status\":1e400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", None),
        ("{\"type\":\"error\",\"status\":599.9999999999999,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", None),
        ("{\"type\":\"error\",\"status\":599.99999999999999999,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", None),
        ("{\"type\":\"error\",\"status\":399.99999999999999999,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", Some("m")),
        ("{\"type\":\"error\",\"status\":599,\"error\":{\"type\":\"overloaded_error\",\"message\":\"m\"}}", Some("m")),
        ("{\"type\":\"error\",\"status\":true,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", None),
        ("{\"type\":\"error\",\"status\":400,\"error\":null}", None),
        ("{\"type\":\"error\",\"status\":400,\"error\":[]}", None),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"a\",\"message\":\"b\"}}", Some("b")),
        ("{\"type\":\"error\",\"type\":\"x\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", None),
        ("{\"type\":\"x\",\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", Some("m")),
        ("  {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}\n", Some("m")),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"\\u0085\"}}", Some("\u{85}")),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"\\ufeff\"}}", None),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\" \\u3000x \"}}", Some(" \u{3000}x ")),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"\\ud800\",\"message\":\"m\"}}", None),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"insufficient_quota\",\"message\":\"q\"}}", Some("q")),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"usage_limit_reached\",\"message\":\"q\"}}", None),
        ("{\"type\":\"error\",\"status\":\"400\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", None),
        ("unexpected status 400 Bad Request: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\"}}", None),
        ("", None),
        ("null", None),
        ("[]", None),
        ("\"s\"", None),
        ("{}", None),
    ];

    #[test]
    fn reads_exactly_what_the_adapter_reads() {
        for (text, want) in ADAPTER_READ {
            assert_eq!(
                readable_service_error_message(text).as_deref(),
                *want,
                "{text:?}"
            );
        }
    }

    /// "Blank" is JavaScript's `trim()`: U+0085 is not whitespace there and
    /// U+FEFF is, the other way round from Rust's.
    #[test]
    fn a_blank_message_is_blank_the_way_javascript_trims() {
        let text =
            |message: &str| with(envelope(), &["error", "message"], json!(message)).to_string();
        assert_eq!(
            readable_service_error_message(&text("\u{85}")).as_deref(),
            Some("\u{85}")
        );
        assert_eq!(readable_service_error_message(&text("\u{FEFF}")), None);
    }
}
