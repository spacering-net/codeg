use async_trait::async_trait;
use tokio::sync::mpsc;

use super::error::ChatChannelError;
use super::types::*;

#[async_trait]
pub trait ChatChannelBackend: Send + Sync + 'static {
    fn channel_type(&self) -> ChannelType;

    /// Start the receiving loop. `command_tx` forwards incoming IM messages
    /// to the central command dispatcher.
    async fn start(
        &self,
        command_tx: mpsc::Sender<IncomingCommand>,
    ) -> Result<(), ChatChannelError>;

    /// Stop the backend connection gracefully.
    async fn stop(&self) -> Result<(), ChatChannelError>;

    /// Current connection status.
    async fn status(&self) -> ChannelConnectionStatus;

    /// Send a plain text message.
    async fn send_message(&self, text: &str) -> Result<SendOutcome, ChatChannelError>;

    /// Send a rich/structured message (Telegram Markdown / Lark Card).
    async fn send_rich_message(
        &self,
        message: &RichMessage,
    ) -> Result<SendOutcome, ChatChannelError>;

    /// Send a rich message to a provider-specific thread/topic target.
    /// Backends without thread semantics keep the existing channel-level behavior.
    async fn send_rich_message_to(
        &self,
        message: &RichMessage,
        _target: &ChannelMessageTarget,
    ) -> Result<SendOutcome, ChatChannelError> {
        self.send_rich_message(message).await
    }

    /// Create a provider-specific thread/topic target.
    async fn create_thread(
        &self,
        _title: &str,
    ) -> Result<ChannelMessageTarget, ChatChannelError> {
        Err(ChatChannelError::Unsupported(
            "thread creation is not supported by this channel".to_string(),
        ))
    }

    /// Best-effort provider-side title sync for a bound thread/topic.
    async fn edit_thread_title(
        &self,
        _target: &ChannelMessageTarget,
        _title: &str,
    ) -> Result<(), ChatChannelError> {
        Err(ChatChannelError::Unsupported(
            "thread title editing is not supported by this channel".to_string(),
        ))
    }

    /// [Phase 2] Send an interactive message with action buttons.
    /// Default implementation degrades to send_rich_message.
    async fn send_interactive_message(
        &self,
        message: &InteractiveMessage,
    ) -> Result<SendOutcome, ChatChannelError> {
        self.send_rich_message(&message.to_rich_fallback()).await
    }

    /// Send an interactive message to a provider-specific thread/topic target.
    async fn send_interactive_message_to(
        &self,
        message: &InteractiveMessage,
        _target: &ChannelMessageTarget,
    ) -> Result<SendOutcome, ChatChannelError> {
        self.send_interactive_message(message).await
    }

    /// [Phase 2] Update an already-sent message (e.g., permission status change).
    async fn update_message(
        &self,
        _message_id: &SentMessageId,
        _message: &RichMessage,
    ) -> Result<(), ChatChannelError> {
        Ok(())
    }

    /// Test the connection (used by "Test Connection" button in UI).
    async fn test_connection(&self) -> Result<(), ChatChannelError>;
}
