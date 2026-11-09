//! Proof, from the agent's side, that one prompt reached it.
//!
//! A sender that must be able to tell — after a crash, a lost connection —
//! whether its prompt went out attaches a [`PromptReceipt`] to it. The
//! connection then calls the receipt's sink twice: right before it writes the
//! `session/prompt` request ([`PromptReceiptSink::attempted`]; refused, the
//! request is not written at all), and when the agent's side confirms that
//! very request ([`PromptReceiptSink::received`]). Neither goes through the
//! event bus, which may drop events when its consumer falls behind.
//!
//! Only what the agent sends back about THIS request counts as received: the
//! response to the request itself, or the agent echoing the prompt back with
//! its operation frame in it. Ordinary turn output does not — updates are
//! routed by session alone, and a late update of the previous turn can land
//! while this one is being waited for.

use std::sync::Arc;

/// How the agent's side confirmed a prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptVia {
    /// The agent answered this `session/prompt` request (`PromptResponse`, at
    /// the end of its turn — a cancelled turn's answer included).
    PromptResponse,
    /// The agent rejected this request: it got it, and said no.
    PromptRejected,
    /// The agent echoed the prompt back (`user_message_chunk`) with this
    /// prompt's operation frame in it.
    UserMessageEcho,
}

impl ReceiptVia {
    pub fn as_str(self) -> &'static str {
        match self {
            ReceiptVia::PromptResponse => "prompt_response",
            ReceiptVia::PromptRejected => "prompt_rejected",
            ReceiptVia::UserMessageEcho => "user_message_echo",
        }
    }
}

/// Where a connection reports on a prompt carrying a receipt.
#[async_trait::async_trait]
pub trait PromptReceiptSink: Send + Sync {
    /// The request is about to be written to the agent. Persist that before
    /// answering: an `Err` keeps the request from being written, and the
    /// connection ends the turn instead.
    async fn attempted(&self, op_id: &str) -> Result<(), String>;
    /// The agent's side confirmed this request.
    async fn received(&self, op_id: &str, via: ReceiptVia);
}

/// The receipt one prompt carries.
#[derive(Clone)]
pub struct PromptReceipt {
    /// The sender's id for this send; also what the prompt's operation frame
    /// carries (`agent_mentions::render_operation_frame`).
    pub op_id: String,
    pub sink: Arc<dyn PromptReceiptSink>,
}

impl PromptReceipt {
    pub async fn attempted(&self) -> Result<(), String> {
        self.sink.attempted(&self.op_id).await
    }

    pub async fn received(&self, via: ReceiptVia) {
        self.sink.received(&self.op_id, via).await
    }
}
