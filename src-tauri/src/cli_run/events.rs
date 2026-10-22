//! From the connection's own events to the CLI's (contract v1, `wire.rs`).
//!
//! The CLI never sees an `AcpEvent`: that shape is internal and changes with
//! codeg. Only what a script can use is translated; permissions and questions
//! are not here, because what they became depends on the run's policy and on
//! who answered (see `service.rs`).

use crate::acp::types::AcpEvent;

use super::wire::{EventBody, PlanEntry, RunEvent};

/// The CLI event for one connection event, when it has one.
pub fn translate(event: &AcpEvent) -> Option<EventBody> {
    match event {
        // Main-thread reply text only: a sub-agent's chunks
        // (`parent_tool_use_id`) are not this run's reply.
        AcpEvent::ContentDelta {
            text,
            parent_tool_use_id: None,
        } if !text.is_empty() => Some(EventBody::MessageDelta { text: text.clone() }),
        AcpEvent::ToolCall {
            tool_call_id,
            title,
            kind,
            status,
            ..
        } => Some(EventBody::ToolCall {
            id: tool_call_id.clone(),
            title: title.clone(),
            kind: kind.clone(),
            status: status.clone(),
        }),
        AcpEvent::ToolCallUpdate {
            tool_call_id,
            title,
            status,
            ..
        } if title.is_some() || status.is_some() => Some(EventBody::ToolCallUpdate {
            id: tool_call_id.clone(),
            title: title.clone(),
            status: status.clone(),
        }),
        AcpEvent::PlanUpdate { entries } => Some(EventBody::Plan {
            entries: entries
                .iter()
                .map(|e| PlanEntry {
                    content: e.content.clone(),
                    status: e.status.clone(),
                })
                .collect(),
        }),
        AcpEvent::SessionNotice { notice } => Some(EventBody::Notice {
            severity: notice.severity.clone(),
            title: notice.title.clone(),
            message: notice.description.clone(),
        }),
        AcpEvent::SessionFailure { record } => Some(EventBody::Notice {
            severity: record.severity.clone(),
            title: if record.title.is_empty() {
                record.category.clone()
            } else {
                record.title.clone()
            },
            message: record.details.clone(),
        }),
        AcpEvent::Error { message, code, .. } => Some(EventBody::Error {
            message: message.clone(),
            code: code.clone(),
        }),
        _ => None,
    }
}

/// The error text a turn's events leave behind, for the result's `error` when
/// the turn failed: the last `Error`, else the last error-severity notice or
/// failure record.
pub fn error_text(event: &AcpEvent) -> Option<String> {
    match event {
        AcpEvent::Error { message, .. } => Some(message.clone()),
        AcpEvent::SessionFailure { record } if record.severity == "error" => {
            Some(match &record.details {
                Some(details) if !record.title.is_empty() => {
                    format!("{}: {details}", record.title)
                }
                Some(details) => details.clone(),
                None => record.title.clone(),
            })
        }
        AcpEvent::SessionNotice { notice } if notice.severity == "error" => {
            Some(match &notice.description {
                Some(description) => format!("{}: {description}", notice.title),
                None => notice.title.clone(),
            })
        }
        _ => None,
    }
}

/// Merge each run of consecutive `message_delta`s into one, keeping the last
/// one's `seq` so the poll's cursor still points past everything returned.
pub fn coalesce_deltas(events: Vec<RunEvent>) -> Vec<RunEvent> {
    let mut out: Vec<RunEvent> = Vec::with_capacity(events.len());
    for event in events {
        if let (
            Some(RunEvent {
                seq,
                body: EventBody::MessageDelta { text: merged },
                ..
            }),
            EventBody::MessageDelta { text },
        ) = (out.last_mut(), &event.body)
        {
            merged.push_str(text);
            *seq = event.seq;
            continue;
        }
        out.push(event);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::{PlanEntryInfo, SessionFailureRecord, SessionNotice};

    fn ev(seq: u64, body: EventBody) -> RunEvent {
        RunEvent::new(seq, Some("r".into()), body)
    }

    fn delta(text: &str) -> EventBody {
        EventBody::MessageDelta { text: text.into() }
    }

    #[test]
    fn the_events_a_script_uses_are_translated() {
        let cases: Vec<(AcpEvent, Option<serde_json::Value>)> = vec![
            (
                AcpEvent::ContentDelta {
                    text: "hel".into(),
                    parent_tool_use_id: None,
                },
                Some(serde_json::json!({"type": "message_delta", "text": "hel"})),
            ),
            (
                AcpEvent::ContentDelta {
                    text: "sub-agent text".into(),
                    parent_tool_use_id: Some("toolu_1".into()),
                },
                None,
            ),
            (
                AcpEvent::ToolCall {
                    tool_call_id: "t1".into(),
                    title: "Read file".into(),
                    kind: "read".into(),
                    status: "pending".into(),
                    content: Some("ignored".into()),
                    raw_input: None,
                    raw_output: None,
                    locations: None,
                    meta: None,
                    images: None,
                },
                Some(serde_json::json!({
                    "type": "tool_call", "id": "t1", "title": "Read file",
                    "kind": "read", "status": "pending"
                })),
            ),
            (
                AcpEvent::ToolCallUpdate {
                    tool_call_id: "t1".into(),
                    title: None,
                    status: Some("completed".into()),
                    content: None,
                    raw_input: None,
                    raw_output: Some("output".into()),
                    raw_output_append: None,
                    locations: None,
                    meta: None,
                    images: None,
                },
                Some(
                    serde_json::json!({"type": "tool_call_update", "id": "t1", "status": "completed"}),
                ),
            ),
            (
                AcpEvent::ToolCallUpdate {
                    tool_call_id: "t1".into(),
                    title: None,
                    status: None,
                    content: Some("streamed output only".into()),
                    raw_input: None,
                    raw_output: None,
                    raw_output_append: None,
                    locations: None,
                    meta: None,
                    images: None,
                },
                None,
            ),
            (
                AcpEvent::PlanUpdate {
                    entries: vec![PlanEntryInfo {
                        content: "write tests".into(),
                        priority: "high".into(),
                        status: "in_progress".into(),
                    }],
                },
                Some(serde_json::json!({
                    "type": "plan",
                    "entries": [{"content": "write tests", "status": "in_progress"}]
                })),
            ),
            (
                AcpEvent::SessionNotice {
                    notice: SessionNotice {
                        severity: "warning".into(),
                        title: "Falling back".into(),
                        description: Some("model unavailable".into()),
                    },
                },
                Some(serde_json::json!({
                    "type": "notice", "severity": "warning",
                    "title": "Falling back", "message": "model unavailable"
                })),
            ),
            (
                AcpEvent::Error {
                    message: "boom".into(),
                    agent_type: "codex".into(),
                    code: Some("turn_failed".into()),
                    details: Some("stderr tail".into()),
                    terminal: false,
                },
                Some(
                    serde_json::json!({"type": "error", "message": "boom", "code": "turn_failed"}),
                ),
            ),
            (AcpEvent::SelectorsReady, None),
            (
                AcpEvent::Thinking {
                    text: "hmm".into(),
                    parent_tool_use_id: None,
                },
                None,
            ),
        ];
        for (event, expected) in cases {
            let got = translate(&event).map(|body| serde_json::to_value(body).unwrap());
            assert_eq!(got, expected, "{event:?}");
        }
    }

    #[test]
    fn a_failure_record_reads_as_an_error_text() {
        let record = SessionFailureRecord {
            id: "f1".into(),
            revision: 1,
            category: "limit".into(),
            severity: "error".into(),
            title: "Rate limited".into(),
            details: Some("try later".into()),
            actions: vec![],
            resolved: false,
        };
        assert_eq!(
            error_text(&AcpEvent::SessionFailure {
                record: record.clone()
            }),
            Some("Rate limited: try later".into())
        );
        let warning = SessionFailureRecord {
            severity: "warning".into(),
            ..record
        };
        assert_eq!(
            error_text(&AcpEvent::SessionFailure { record: warning }),
            None
        );
    }

    #[test]
    fn consecutive_deltas_merge_and_keep_the_last_seq() {
        let merged = coalesce_deltas(vec![
            ev(1, delta("a")),
            ev(2, delta("b")),
            ev(
                3,
                EventBody::ToolCallUpdate {
                    id: "t".into(),
                    title: None,
                    status: Some("completed".into()),
                },
            ),
            ev(4, delta("c")),
            ev(5, delta("d")),
        ]);
        let seqs: Vec<u64> = merged.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, [2, 3, 5]);
        assert_eq!(merged[0].body, delta("ab"));
        assert_eq!(merged[2].body, delta("cd"));
    }
}
