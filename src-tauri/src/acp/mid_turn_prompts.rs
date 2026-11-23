//! Own the responses to concurrent ACP prompts until the last one settles.
//! Devin echoes its client message id. The Antigravity CLI has no early receipt
//! and hands the remaining work to the most recent prompt.

use std::collections::HashMap;

use agent_client_protocol::schema::v1::{
    Meta, PromptRequest, PromptResponse, SessionId, StopReason,
};
use agent_client_protocol::{Agent, ConnectionTo, Dispatch};
use futures::future::BoxFuture;
use futures::stream::{FuturesUnordered, StreamExt};
use futures::FutureExt;
use tokio::sync::oneshot;

use std::sync::Arc;

use tokio::sync::RwLock;

use super::{
    agent_error_text, map_prompt_blocks, prompt_rejection_is_terminal, record_steer,
    version_at_least, SteerOutcome,
};
use crate::acp::session_state::SessionState;
use crate::web::event_bridge::{emit_with_state_gated, EventEmitter};
use crate::acp::background_watch::PromptLedger;
use crate::acp::error::AcpError;
use crate::acp::feedback::{FeedbackStatus, MidTurnAdapter};
use crate::acp::types::{AcpEvent, ConnectionStatus};
use crate::acp::types::PromptInputBlock;
use crate::models::AgentType;

const CLIENT_MESSAGE_ID: &str = "cognition.ai/clientMessageId";

pub(super) fn adapter(
    capabilities: Option<&Meta>,
    info: Option<&agent_client_protocol::schema::v1::Implementation>,
) -> Option<MidTurnAdapter> {
    if capabilities
        .and_then(|m| m.get("cognition.ai/midTurnPrompts"))
        .and_then(|v| v.as_bool())
        == Some(true)
    {
        Some(MidTurnAdapter::Devin)
    } else if info.is_some_and(|i| {
        i.name == "Antigravity ACP Server" && version_at_least(&i.version, "1.5.0")
    }) {
        // Google added concurrent prompts in `agy acp` 1.5.0. The separately
        // distributed `antigravity-acp` 1.5.0 opens a competing receive_steps stream.
        Some(MidTurnAdapter::AntigravityCli)
    } else {
        None
    }
}

type Response = Result<PromptResponse, agent_client_protocol::Error>;

/// The CLI can explicitly refuse admission while its previous cancellation is
/// unwinding, even after a bounded wait for that turn's outstanding replies.
/// Only this refusal makes sending the same next prompt again unambiguous.
pub(super) async fn prompt_after_antigravity_cancel(
    cx: ConnectionTo<Agent>,
    request: PromptRequest,
    stop: tokio_util::sync::CancellationToken,
) -> Response {
    let mut delay = std::time::Duration::from_millis(100);
    loop {
        if stop.is_cancelled() {
            return Ok(PromptResponse::new(StopReason::Cancelled));
        }
        let result = cx
            .send_request_to(Agent, request.clone())
            .block_task()
            .await;
        if !result.as_ref().is_err_and(|error| {
            agent_error_text(error)
                .contains("the running prompt is being cancelled; wait for it to finish")
        }) {
            return result;
        }
        tokio::select! {
            _ = stop.cancelled() => return Ok(PromptResponse::new(StopReason::Cancelled)),
            _ = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(std::time::Duration::from_secs(1));
    }
}

enum Receipt {
    ClientEcho(String),
    Submitted(Option<String>),
}

pub(super) struct Completion {
    ordinal: usize,
    receipt: Receipt,
    response: Response,
}
type SteerReply = oneshot::Sender<Result<SteerOutcome, AcpError>>;

pub(super) struct Submission {
    pub blocks: Vec<PromptInputBlock>,
    pub reply: SteerReply,
    pub recorded: oneshot::Receiver<String>,
}

#[derive(Default)]
pub(super) struct MidTurnPrompts {
    responses: FuturesUnordered<BoxFuture<'static, Completion>>,
    // Keep an acknowledged id until its response so multipart echoes record
    // the original blocks exactly once.
    submissions: HashMap<String, Option<Submission>>,
    issued: usize,
    last_response: Option<(usize, Response)>,
}

impl MidTurnPrompts {
    pub(super) async fn send(
        &mut self,
        adapter: MidTurnAdapter,
        cx: &ConnectionTo<Agent>,
        sid: &SessionId,
        submission: Submission,
        agent_type: AgentType,
        ledger: &PromptLedger,
    ) {
        let request = PromptRequest::new(sid.clone(), map_prompt_blocks(submission.blocks.clone()));
        let (response, receipt) = match adapter {
            MidTurnAdapter::Devin => {
                let id = uuid::Uuid::new_v4().to_string();
                let request = request.meta(Meta::from_iter([(
                    CLIENT_MESSAGE_ID.into(),
                    id.clone().into(),
                )]));
                self.submissions.insert(id.clone(), Some(submission));
                (cx.send_request_to(Agent, request), Receipt::ClientEcho(id))
            }
            MidTurnAdapter::AntigravityCli => {
                let response = cx.send_request_to(Agent, request);
                // The UI can accept another message while this RPC is open.
                let note = submission
                    .publish(SteerOutcome::Submitted, agent_type, sid, ledger)
                    .await;
                (response, Receipt::Submitted(note))
            }
        };
        self.issued += 1;
        let ordinal = self.issued;
        self.responses.push(
            async move {
                Completion {
                    ordinal,
                    receipt,
                    response: response.block_task().await,
                }
            }
            .boxed(),
        );
    }

    pub(super) fn is_empty(&self) -> bool {
        self.responses.is_empty()
    }

    pub(super) async fn next(&mut self) -> Option<Completion> {
        self.responses.next().await
    }

    pub(super) fn echoed_id<'a>(&self, dispatch: &'a Dispatch, sid: &SessionId) -> Option<&'a str> {
        if self.submissions.is_empty() {
            return None;
        }
        let Dispatch::Notification(msg) = dispatch else {
            return None;
        };
        if msg.method() != "session/update" || msg.params()["sessionId"].as_str() != Some(&sid.0) {
            return None;
        }
        let update = &msg.params()["update"];
        if update["sessionUpdate"] != "user_message_chunk" {
            return None;
        }
        let id = update["_meta"][CLIENT_MESSAGE_ID].as_str()?;
        self.submissions.contains_key(id).then_some(id)
    }

    pub(super) async fn acknowledge(
        &mut self,
        id: &str,
        agent_type: AgentType,
        sid: &SessionId,
        ledger: &PromptLedger,
    ) {
        if let Some(submission) = self.submissions.get_mut(id).and_then(Option::take) {
            submission
                .publish(SteerOutcome::Injected, agent_type, sid, ledger)
                .await;
        }
    }

    pub(super) async fn settle(
        &mut self,
        Completion {
            ordinal,
            receipt,
            response,
        }: Completion,
        agent_type: AgentType,
        sid: &SessionId,
        ledger: &PromptLedger,
    ) -> Option<AcpEvent> {
        let mut event = None;
        match receipt {
            Receipt::Submitted(Some(id)) => {
                event = submitted_settlement(id, &response);
                if response.is_err() {
                    return event;
                }
            }
            Receipt::Submitted(None) => {}
            Receipt::ClientEcho(id) => {
                if let Some(submission) = self.submissions.remove(&id).flatten() {
                    // A peer may omit the echo. Only a successful response can confirm it then.
                    let rejection = match &response {
                        Err(error) => Some(agent_error_text(error)),
                        Ok(r) if r.stop_reason == StopReason::Cancelled => {
                            Some("Devin stopped before acknowledging the message".into())
                        }
                        Ok(_) => None,
                    };
                    if let Some(message) = rejection {
                        let _ = submission.reply.send(Err(AcpError::protocol(message)));
                        return None;
                    }
                    submission
                        .publish(SteerOutcome::Injected, agent_type, sid, ledger)
                        .await;
                }
            }
        }
        // The latest accepted prompt owns the final stop reason and usage,
        // even when an earlier RPC answers last.
        if self
            .last_response
            .as_ref()
            .is_none_or(|(last, _)| ordinal > *last)
        {
            self.last_response = Some((ordinal, response));
        }
        event
    }

    pub(super) fn turn_result(&mut self, original: Response) -> Response {
        match (original, self.last_response.take()) {
            // A dead connection stays fatal whatever the later prompts answered.
            (Err(error), _) if prompt_rejection_is_terminal(&error) => Err(error),
            // A turn-scoped rejection of the original prompt does not void a
            // later prompt that the agent accepted and answered.
            (_, Some((_, latest))) => latest,
            (original, None) => original,
        }
    }

    /// Runs detached after Stop, once the turn has already ended for the UI.
    pub(super) async fn drain_cancelled(
        mut self,
        state: Arc<RwLock<SessionState>>,
        emitter: EventEmitter,
    ) {
        for submission in self.submissions.drain().filter_map(|(_, s)| s) {
            let _ = submission.reply.send(Err(AcpError::protocol(
                "Turn cancelled before Devin acknowledged the message",
            )));
        }
        // session/cancel is already on the wire. Dropping outstanding requests
        // would issue additional request cancellations. Keep settling the
        // submitted notes: the composer already cleared their drafts, so a
        // rejection must still reach the notes list.
        while let Some(Completion {
            receipt, response, ..
        }) = self.responses.next().await
        {
            if let Receipt::Submitted(Some(id)) = receipt {
                let still_sent = |s: &SessionState| {
                    s.status != ConnectionStatus::Prompting
                        && s.feedback
                            .iter()
                            .any(|f| f.id == id && f.status == FeedbackStatus::Sent)
                };
                if let Some(event) = submitted_settlement(id.clone(), &response) {
                    // Only until the next turn opens (`StatusChanged(Prompting)`,
                    // sequenced under the same lock): from there its events own
                    // the stream and its `UserMessage` clears the notes. A prompt
                    // still held for this drain has not opened its turn yet.
                    emit_with_state_gated(&state, &emitter, event, still_sent).await;
                }
            }
        }
    }
}

/// Settle a note whose prompt had no early receipt. A cancelled reply is left
/// `Sent`: the agent may or may not have read it, so neither a receipt nor a
/// retry offer would be honest.
fn submitted_settlement(id: String, response: &Response) -> Option<AcpEvent> {
    match response {
        Ok(r) if r.stop_reason != StopReason::Cancelled => Some(AcpEvent::FeedbackConsumed {
            ids: vec![id],
            delivered_at: chrono::Utc::now(),
        }),
        Ok(_) => None,
        Err(error) => Some(AcpEvent::FeedbackFailed {
            id,
            message: AcpError::protocol(agent_error_text(error)).to_string(),
        }),
    }
}

impl Submission {
    async fn publish(
        self,
        outcome: SteerOutcome,
        agent_type: AgentType,
        sid: &SessionId,
        ledger: &PromptLedger,
    ) -> Option<String> {
        ledger.record_prompt_blocks(&self.blocks);
        record_steer(agent_type, &sid.0, &map_prompt_blocks(self.blocks)).await;
        let _ = self.reply.send(Ok(outcome));
        // Publish the user turn before processing the reply that follows its echo.
        self.recorded.await.ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::Implementation;

    #[test]
    fn only_the_antigravity_cli_with_mid_turn_prompt_support_uses_it() {
        for (name, version, expected) in [
            ("Antigravity ACP Server", "1.5.0", true),
            ("Antigravity ACP Server", "1.5.13", true),
            ("Antigravity ACP Server", "1.5.0-preview.1", false),
            ("antigravity-acp", "1.5.0", false),
            ("antigravity-acp", "1.5.2", false),
            ("other", "1.5.13", false),
        ] {
            assert_eq!(
                adapter(None, Some(&Implementation::new(name, version))),
                expected.then_some(MidTurnAdapter::AntigravityCli)
            );
        }
    }

    #[test]
    fn a_later_accepted_prompt_outlives_a_turn_scoped_rejection_of_the_original() {
        let accepted = || Some((1, Ok(PromptResponse::new(StopReason::EndTurn))));
        let mut prompts = MidTurnPrompts {
            last_response: accepted(),
            ..Default::default()
        };
        let rejected = agent_client_protocol::Error::invalid_params().data("busy");
        assert_eq!(
            prompts.turn_result(Err(rejected)).unwrap().stop_reason,
            StopReason::EndTurn
        );
        prompts.last_response = accepted();
        let gone = agent_client_protocol::Error::resource_not_found(None);
        assert!(prompts.turn_result(Err(gone)).is_err(), "a lost session stays fatal");
        assert!(
            prompts.turn_result(Ok(PromptResponse::new(StopReason::Cancelled)))
                .is_ok_and(|r| r.stop_reason == StopReason::Cancelled),
            "without concurrent prompts the original answer stands"
        );
    }

    #[test]
    fn devin_steering_requires_the_advertised_mid_turn_prompt_capability() {
        let key = "cognition.ai/midTurnPrompts";
        assert_eq!(adapter(None, None), None);
        for (value, enabled) in [
            (serde_json::json!(false), false),
            (serde_json::json!("true"), false),
            (serde_json::json!(true), true),
        ] {
            assert_eq!(
                adapter(Some(&Meta::from_iter([(key.into(), value)])), None).is_some(),
                enabled
            );
        }
    }
}
