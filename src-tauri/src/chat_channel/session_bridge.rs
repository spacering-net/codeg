use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Instant;

use crate::acp::types::PermissionOptionInfo;
use crate::chat_channel::types::{ChannelMessageTarget, SentMessageId};
use crate::models::agent::AgentType;

pub struct PendingPermission {
    pub request_id: String,
    pub tool_description: String,
    pub options: Vec<PermissionOptionInfo>,
    pub sent_message_id: Option<SentMessageId>,
}

pub struct ActiveSession {
    pub channel_id: i32,
    pub sender_id: String,
    pub target: ChannelMessageTarget,
    pub conversation_id: i32,
    pub connection_id: String,
    pub agent_type: AgentType,
    pub content_buffer: String,
    pub tool_calls: Vec<String>,
    /// Stores raw_input by tool_call_id for detail extraction on completion.
    pub tool_call_inputs: HashMap<String, String>,
    /// `tool_call_id`s of delegations whose terminal result line was already
    /// rendered to the channel. The dedup marker for async delegation: the
    /// result can surface via the terminal `ToolCallUpdate` OR the
    /// `DelegationCompleted` event (whichever fires for a given task), and this
    /// set guarantees exactly one result line. Kept separate from
    /// `tool_call_inputs` because that map is re-populated by every `raw_input`
    /// update and so can't serve as a one-shot token. Cleared with the session.
    pub delegation_rendered: HashSet<String>,
    pub last_flushed: Instant,
    pub pending_prompt: Option<String>,
    pub permission_pending: Option<PendingPermission>,
}

/// How many removed sessions [`SessionBridge`] keeps the conversation of.
/// Entries normally go when the global event subscriber reaches the
/// connection's `Disconnected`; the cap only bounds the ones it never sees
/// (a `Lagged` gap, or a removal that lands after that event).
const ENDED_SESSIONS_CAP: usize = 256;

#[derive(Default)]
pub struct SessionBridge {
    sessions: HashMap<String, ActiveSession>,
    /// Conversation of each session removed while its connection may still
    /// have events queued for a slower bus subscriber. The session relay
    /// removes a session on a terminal error; the global event subscriber can
    /// be seconds behind it (it awaits IM sends inline) and still needs to
    /// know which conversation that error belongs to.
    ended: HashMap<String, i32>,
    ended_order: VecDeque<String>,
}

impl SessionBridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, connection_id: String, session: ActiveSession) {
        self.forget_ended(&connection_id);
        self.sessions.insert(connection_id, session);
    }

    pub fn remove(&mut self, connection_id: &str) -> Option<ActiveSession> {
        let removed = self.sessions.remove(connection_id);
        if let Some(session) = &removed {
            if self
                .ended
                .insert(connection_id.to_string(), session.conversation_id)
                .is_none()
            {
                self.ended_order.push_back(connection_id.to_string());
            }
            while self.ended_order.len() > ENDED_SESSIONS_CAP {
                if let Some(oldest) = self.ended_order.pop_front() {
                    self.ended.remove(&oldest);
                }
            }
        }
        removed
    }

    /// The conversation a connection's chat session belongs to — the live
    /// session's, or that of one removed since (see `ended`).
    pub fn conversation_id_of(&self, connection_id: &str) -> Option<i32> {
        self.sessions
            .get(connection_id)
            .map(|session| session.conversation_id)
            .or_else(|| self.ended.get(connection_id).copied())
    }

    /// Drop what is kept of a removed session; called once its connection's
    /// last event has been handled.
    pub fn forget_ended(&mut self, connection_id: &str) {
        if self.ended.remove(connection_id).is_some() {
            self.ended_order.retain(|id| id != connection_id);
        }
    }

    pub fn get(&self, connection_id: &str) -> Option<&ActiveSession> {
        self.sessions.get(connection_id)
    }

    pub fn get_mut(&mut self, connection_id: &str) -> Option<&mut ActiveSession> {
        self.sessions.get_mut(connection_id)
    }

    pub fn find_by_sender(&self, channel_id: i32, sender_id: &str) -> Option<&ActiveSession> {
        self.sessions
            .values()
            .find(|s| s.channel_id == channel_id && s.sender_id == sender_id)
    }

    pub fn find_by_target(&self, target: &ChannelMessageTarget) -> Option<&ActiveSession> {
        self.sessions
            .values()
            .find(|s| s.target.matches_thread(target))
    }

    pub fn find_by_sender_mut(
        &mut self,
        channel_id: i32,
        sender_id: &str,
    ) -> Option<&mut ActiveSession> {
        self.sessions
            .values_mut()
            .find(|s| s.channel_id == channel_id && s.sender_id == sender_id)
    }

    pub fn find_by_target_mut(
        &mut self,
        target: &ChannelMessageTarget,
    ) -> Option<&mut ActiveSession> {
        self.sessions
            .values_mut()
            .find(|s| s.target.matches_thread(target))
    }

    pub fn all_sessions(&self) -> impl Iterator<Item = &ActiveSession> {
        self.sessions.values()
    }

    pub fn all_sessions_mut(&mut self) -> impl Iterator<Item = &mut ActiveSession> {
        self.sessions.values_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(conversation_id: i32) -> ActiveSession {
        ActiveSession {
            channel_id: 1,
            sender_id: "u".into(),
            target: ChannelMessageTarget::channel(1),
            conversation_id,
            connection_id: String::new(),
            agent_type: AgentType::ClaudeCode,
            content_buffer: String::new(),
            tool_calls: Vec::new(),
            tool_call_inputs: HashMap::new(),
            delegation_rendered: HashSet::new(),
            last_flushed: Instant::now(),
            pending_prompt: None,
            permission_pending: None,
        }
    }

    #[test]
    fn a_removed_session_keeps_its_conversation_until_forgotten() {
        let mut bridge = SessionBridge::new();
        bridge.register("c1".into(), session(7));
        assert_eq!(bridge.conversation_id_of("c1"), Some(7));

        assert!(bridge.remove("c1").is_some());
        assert!(bridge.get("c1").is_none(), "the session itself is gone");
        assert_eq!(bridge.conversation_id_of("c1"), Some(7));

        bridge.forget_ended("c1");
        assert_eq!(bridge.conversation_id_of("c1"), None);
        assert!(bridge.ended_order.is_empty());
    }

    #[test]
    fn registering_again_clears_the_kept_conversation() {
        let mut bridge = SessionBridge::new();
        bridge.register("c1".into(), session(7));
        bridge.remove("c1");
        bridge.register("c1".into(), session(8));
        assert_eq!(bridge.conversation_id_of("c1"), Some(8));
        bridge.remove("c1");
        assert_eq!(bridge.conversation_id_of("c1"), Some(8));
        assert_eq!(bridge.ended_order.len(), 1);
    }

    #[test]
    fn kept_conversations_are_capped_oldest_first() {
        let mut bridge = SessionBridge::new();
        for i in 0..(ENDED_SESSIONS_CAP + 3) {
            let id = format!("c{i}");
            bridge.register(id.clone(), session(i as i32));
            bridge.remove(&id);
        }
        assert_eq!(bridge.ended.len(), ENDED_SESSIONS_CAP);
        assert_eq!(bridge.conversation_id_of("c0"), None);
        assert_eq!(bridge.conversation_id_of("c2"), None);
        assert_eq!(bridge.conversation_id_of("c3"), Some(3));
    }

    #[test]
    fn removing_an_unknown_connection_keeps_nothing() {
        let mut bridge = SessionBridge::new();
        assert!(bridge.remove("nope").is_none());
        assert!(bridge.ended.is_empty());
    }
}
