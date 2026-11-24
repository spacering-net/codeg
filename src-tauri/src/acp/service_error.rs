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
//!
//! codex-acp 2.3.0 (#668) adds one rule ahead of the envelope: an
//! `invalid_encrypted_content` error reads as a sentence explaining it
//! ([`INVALID_ENCRYPTED_CONTENT_MESSAGE`]). codex resends the encrypted
//! reasoning of earlier turns, which only the provider (or account) that
//! encrypted it can read, so a thread whose provider changed fails every turn
//! with it. The adapter puts the sentence on the `sessionFailure` title only;
//! the same rule here gives it to the line a reloaded failed turn draws and to
//! a failed compaction's card.
//!
//! codex-acp 2.4.0 (#697) adds one more rule, ahead of both: a ChatGPT login
//! looks its workspace up on chatgpt.com before each model request, and when
//! that lookup gets no answer the turn fails with one of two bare texts
//! ([`WORKSPACE_ROUTING_UNAVAILABLE_MESSAGES`]). They read as a sentence that
//! says so, with the original text kept at its end.

use serde_json::Value;

use crate::acp::js_text::is_js_blank;

/// codex-acp 2.3.0's `INVALID_ENCRYPTED_CONTENT_MESSAGE`, word for word.
pub(crate) const INVALID_ENCRYPTED_CONTENT_MESSAGE: &str =
    "The current provider can't read this thread's earlier reasoning, \
which another provider or account encrypted. This happens after the provider changes in a thread. \
Switch back to the previous provider or start a new thread.";

/// The provider error code the explanation is for.
const INVALID_ENCRYPTED_CONTENT_CODE: &str = "invalid_encrypted_content";

/// codex-acp 2.4.0's `ACCOUNT_READ_UNAVAILABLE_MESSAGES`: the whole error text
/// of a workspace lookup that got no answer from the ChatGPT backend. Matched
/// exactly, as the adapter's `Set.has` does.
const WORKSPACE_ROUTING_UNAVAILABLE_MESSAGES: &[&str] = &[
    "workspace routing discovery failed",
    "workspace routing discovery timed out",
];

/// codex-acp 2.4.0's `workspaceRoutingUnavailableMessage`, word for word.
fn workspace_routing_unavailable_message(text: &str) -> String {
    format!(
        "Codex can't reach chatgpt.com to look up your ChatGPT workspace. \
Check your network connection and any proxy, VPN, or firewall that blocks chatgpt.com, then try again. \
({text})"
    )
}

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

/// The message of a known service error envelope, the explanation of an
/// `invalid_encrypted_content` error or of an unreachable workspace lookup, or
/// `None` for any other text, which then stays as it is.
///
/// Strict on purpose, like the adapter: a key beyond `type`/`status`/`error`
/// (or beyond `type`/`message`/`code`/`param` inside `error`), a status that is
/// not a whole number from 400 to 599, an unknown error type, a non-string
/// `code`/`param`, or a blank message all mean the text is something else, and
/// custom JSON a provider wrote is never cut down to one field of it. The
/// encrypted-content check comes first and reads any JSON, as the adapter's
/// does: its gateway shapes carry keys the envelope rule refuses.
pub(crate) fn readable_service_error_message(text: &str) -> Option<String> {
    if WORKSPACE_ROUTING_UNAVAILABLE_MESSAGES.contains(&text) {
        return Some(workspace_routing_unavailable_message(text));
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    if is_invalid_encrypted_content_error(&value) {
        return Some(INVALID_ENCRYPTED_CONTENT_MESSAGE.to_string());
    }
    let Value::Object(envelope) = value else {
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

/// The adapter's `isInvalidEncryptedContentError`: a provider error
/// `{"error": {"code": "invalid_encrypted_content", …}}` (bare, or inside
/// codex's service envelope), or a gateway's error that carries it in
/// `error.metadata` — as `provider_error_code`, or inside the provider's raw
/// body, a JSON string in `metadata.raw` that is read the same way.
fn is_invalid_encrypted_content_error(value: &Value) -> bool {
    let Some(Value::Object(error)) = value.as_object().and_then(|object| object.get("error"))
    else {
        return false;
    };
    if error.get("code").and_then(Value::as_str) == Some(INVALID_ENCRYPTED_CONTENT_CODE) {
        return true;
    }
    let Some(Value::Object(metadata)) = error.get("metadata") else {
        return false;
    };
    metadata.get("provider_error_code").and_then(Value::as_str)
        == Some(INVALID_ENCRYPTED_CONTENT_CODE)
        || metadata
            .get("raw")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .is_some_and(|raw| is_invalid_encrypted_content_error(&raw))
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

    // codex-acp 2.3.0's own encrypted-content cases
    // (`src/__tests__/ServiceErrorMessage.test.ts`, #668).

    fn provider_error(code: &str) -> Value {
        json!({
            "message": "The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
            "type": "invalid_request_error",
            "param": null,
            "code": code,
        })
    }

    /// The explanation, as the adapter's snapshot file
    /// (`data/service-error-invalid-encrypted-content.txt`) spells it.
    #[test]
    fn the_explanation_is_the_adapters_word_for_word() {
        assert_eq!(
            INVALID_ENCRYPTED_CONTENT_MESSAGE,
            "The current provider can't read this thread's earlier reasoning, which another provider or account encrypted. This happens after the provider changes in a thread. Switch back to the previous provider or start a new thread."
        );
    }

    #[test]
    fn explains_encrypted_content_from_another_provider() {
        let error = provider_error("invalid_encrypted_content");
        let raw = serde_json::to_string_pretty(&json!({"error": error})).unwrap();
        let cases = [
            ("the provider error", json!({"error": error})),
            (
                "the Codex service envelope",
                json!({"type": "error", "status": 400, "error": error}),
            ),
            (
                "a gateway error with the raw provider error",
                json!({
                    "error": {"message": "Provider returned error", "code": 400, "metadata": {"raw": raw}},
                    "user_id": "org_1",
                }),
            ),
            (
                "a gateway error with the provider error code",
                json!({
                    "error": {
                        "message": "Provider returned error",
                        "code": 400,
                        "metadata": {"provider_name": "Azure", "is_byok": false, "provider_error_code": "invalid_encrypted_content"},
                    },
                }),
            ),
        ];
        for (name, value) in cases {
            assert_eq!(
                readable_service_error_message(&value.to_string()).as_deref(),
                Some(INVALID_ENCRYPTED_CONTENT_MESSAGE),
                "{name}"
            );
        }
    }

    #[test]
    fn keeps_other_provider_errors_verbatim() {
        let cases = [
            json!({"error": provider_error("other_code")}),
            json!({"error": {"message": "Provider returned error", "metadata": {"raw": "{not json}"}}}),
            json!({"error": {"message": "Provider returned error", "metadata": {"raw": json!({"error": {"code": "other_code"}}).to_string()}}}),
        ];
        for value in cases {
            let text = value.to_string();
            assert_eq!(readable_service_error_message(&text), None, "{text}");
        }
    }

    /// Inputs run through codex-acp 2.3.0's own `readableServiceErrorMessage`
    /// under Node 24 (the adapter's cases, then codeg's edges), each with
    /// what it returned (`None` where it returned the text unchanged).
    /// `EXPLAINED` stands for [`INVALID_ENCRYPTED_CONTENT_MESSAGE`], which
    /// the adapter returned verbatim in each such row.
    const ADAPTER_EXPLAINS: &[(&str, Option<&str>)] = &[
        ("{\"error\":{\"message\":\"The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":\"invalid_encrypted_content\"}}", Some(EXPLAINED)),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":\"invalid_encrypted_content\"}}", Some(EXPLAINED)),
        ("{\"error\":{\"message\":\"Provider returned error\",\"code\":400,\"metadata\":{\"raw\":\"{\\n  \\\"error\\\": {\\n    \\\"message\\\": \\\"The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.\\\",\\n    \\\"type\\\": \\\"invalid_request_error\\\",\\n    \\\"param\\\": null,\\n    \\\"code\\\": \\\"invalid_encrypted_content\\\"\\n  }\\n}\"}},\"user_id\":\"org_1\"}", Some(EXPLAINED)),
        ("{\"error\":{\"message\":\"Provider returned error\",\"code\":400,\"metadata\":{\"provider_name\":\"Azure\",\"is_byok\":false,\"provider_error_code\":\"invalid_encrypted_content\"}}}", Some(EXPLAINED)),
        ("{\"error\":{\"message\":\"The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":\"other_code\"}}", None),
        ("{\"error\":{\"message\":\"Provider returned error\",\"metadata\":{\"raw\":\"{not json}\"}}}", None),
        ("{\"error\":{\"message\":\"Provider returned error\",\"metadata\":{\"raw\":\"{\\\"error\\\":{\\\"code\\\":\\\"other_code\\\"}}\"}}}", None),
        ("{\"error\":{\"code\":\"invalid_encrypted_content\"}}", Some(EXPLAINED)),
        ("{\"error\":{\"code\":\"Invalid_Encrypted_Content\"}}", None),
        ("{\"error\":{\"code\":\" invalid_encrypted_content\"}}", None),
        ("{\"error\":{\"code\":[\"invalid_encrypted_content\"]}}", None),
        ("{\"error\":[{\"code\":\"invalid_encrypted_content\"}]}", None),
        ("[{\"error\":{\"code\":\"invalid_encrypted_content\"}}]", None),
        ("{\"error\":null}", None),
        ("{\"error\":\"invalid_encrypted_content\"}", None),
        ("{\"code\":\"invalid_encrypted_content\"}", None),
        ("{\"error\":{\"metadata\":[\"invalid_encrypted_content\"]}}", None),
        ("{\"error\":{\"metadata\":{\"provider_error_code\":[\"invalid_encrypted_content\"]}}}", None),
        ("{\"error\":{\"metadata\":{\"raw\":{\"error\":{\"code\":\"invalid_encrypted_content\"}}}}}", None),
        ("{\"error\":{\"metadata\":{\"raw\":\"{\\\"error\\\":{\\\"metadata\\\":{\\\"raw\\\":\\\"{\\\\\\\"error\\\\\\\":{\\\\\\\"code\\\\\\\":\\\\\\\"invalid_encrypted_content\\\\\\\"}}\\\"}}}\"}}}", Some(EXPLAINED)),
        ("{\"error\":{\"metadata\":{\"raw\":\"{\\\"error\\\":{\\\"metadata\\\":{\\\"provider_error_code\\\":\\\"invalid_encrypted_content\\\"}}}\"}}}", Some(EXPLAINED)),
        ("{\"error\":{\"metadata\":{\"raw\":\"[{\\\"error\\\":{\\\"code\\\":\\\"invalid_encrypted_content\\\"}}]\"}}}", None),
        ("{\"error\":{\"code\":\"other\",\"code\":\"invalid_encrypted_content\"}}", Some(EXPLAINED)),
        ("{\"error\":{\"code\":\"invalid_encrypted_content\",\"code\":\"other\"}}", None),
        ("  {\"error\":{\"code\":\"invalid_encrypted_content\"}}\n", Some(EXPLAINED)),
        ("unexpected status 400 Bad Request: {\"error\":{\"code\":\"invalid_encrypted_content\"}}", None),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\",\"code\":\"invalid_encrypted_content\"}}", Some(EXPLAINED)),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"m\",\"code\":\"c\"}}", Some("m")),
    ];

    const EXPLAINED: &str = INVALID_ENCRYPTED_CONTENT_MESSAGE;

    #[test]
    fn explains_exactly_what_the_adapter_explains() {
        for (text, want) in ADAPTER_EXPLAINS {
            assert_eq!(
                readable_service_error_message(text).as_deref(),
                *want,
                "{text:?}"
            );
        }
    }

    /// Inputs run through codex-acp 2.4.0's own `readableServiceErrorMessage`
    /// under Node 24.18 (#697), each with what it returned (`None` where it
    /// returned the text unchanged): only the whole bare text matches, and an
    /// envelope carrying it as its message reads down to the bare text.
    const ADAPTER_EXPLAINS_ROUTING: &[(&str, Option<&str>)] = &[
        ("workspace routing discovery failed", Some("Codex can't reach chatgpt.com to look up your ChatGPT workspace. Check your network connection and any proxy, VPN, or firewall that blocks chatgpt.com, then try again. (workspace routing discovery failed)")),
        ("workspace routing discovery timed out", Some("Codex can't reach chatgpt.com to look up your ChatGPT workspace. Check your network connection and any proxy, VPN, or firewall that blocks chatgpt.com, then try again. (workspace routing discovery timed out)")),
        (" workspace routing discovery failed", None),
        ("workspace routing discovery failed\n", None),
        ("Workspace routing discovery failed", None),
        ("workspace routing discovery unauthorized (401)", None),
        ("workspace routing discovery", None),
        ("\"workspace routing discovery failed\"", None),
        ("{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"workspace routing discovery failed\"}}", Some("workspace routing discovery failed")),
    ];

    #[test]
    fn explains_an_unreachable_workspace_lookup_as_the_adapter_does() {
        for (text, want) in ADAPTER_EXPLAINS_ROUTING {
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
