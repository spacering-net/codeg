//! Per-session update routing on an ACP client connection.
//!
//! codeg sends `session/new`, `session/load` and `session/resume` itself —
//! partly untyped, so it can read fields the typed responses drop (see
//! `send_new_session_capturing_models`) — and then needs the session's updates
//! routed to it. The official runtime only routes updates for sessions it
//! started itself: `ConnectionTo::attach_session` is crate-private since
//! `agent-client-protocol` 2.0. This is the same routing that method installs —
//! a dynamic handler claiming every message from the agent that names this
//! session id, feeding an unbounded channel — minus the prompt helpers codeg
//! never used. codeg sends `session/prompt` itself and reads the stop reason off
//! the response, so this channel only ever carries the agent's own messages,
//! and it hands them out as plain [`Dispatch`]es rather than the runtime's
//! `SessionMessage` (whose other variant, a stop reason, nothing here produces).
//!
//! Registering the handler is also what releases any updates the agent sent
//! BEFORE it existed: the `Agent` role's default handler parks every message
//! carrying a `sessionId` for retry, and parked messages are replayed into each
//! newly added dynamic handler. That is how a `session/load` replay, or the
//! `available_commands_update` an agent sends right after `session/new`, reaches
//! the session even though it raced the response.

use agent_client_protocol::schema::v1::{NewSessionResponse, SessionId, SessionModeState};
use agent_client_protocol::util::MatchDispatchFrom;
use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, DynamicHandlerGuard, HandleDispatchFrom, Handled,
};
use futures::channel::mpsc;
use futures::StreamExt;

/// A session the connection routes updates to. Dropping it unregisters the
/// routing; updates for the session then fall back to the connection's other
/// handlers (and, having a `sessionId`, are parked for a future router).
#[derive(Debug)]
pub struct AgentSession {
    session_id: SessionId,
    modes: Option<SessionModeState>,
    connection: ConnectionTo<Agent>,
    update_rx: mpsc::UnboundedReceiver<Dispatch>,
    _routing: DynamicHandlerGuard<Agent>,
}

impl AgentSession {
    /// Start routing the updates of the session `response` describes.
    pub fn attach(
        connection: &ConnectionTo<Agent>,
        response: NewSessionResponse,
    ) -> Result<Self, agent_client_protocol::Error> {
        let NewSessionResponse {
            session_id, modes, ..
        } = response;
        let (update_tx, update_rx) = mpsc::unbounded();
        let routing = connection.add_dynamic_handler(SessionRouter {
            session_id: session_id.clone(),
            update_tx,
        })?;
        Ok(Self {
            session_id,
            modes,
            connection: connection.clone(),
            update_rx,
            _routing: routing,
        })
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    /// The modes the agent reported when the session was created or loaded.
    pub fn modes(&self) -> &Option<SessionModeState> {
        &self.modes
    }

    /// The connection the session lives on (cheap to clone).
    pub fn connection(&self) -> ConnectionTo<Agent> {
        self.connection.clone()
    }

    /// The next message the agent sent about this session.
    ///
    /// Waiting here never times out on its own: the router outlives an agent
    /// that has gone quiet (the runtime keeps its handlers for as long as any
    /// `ConnectionTo` exists, and this session holds one). So an `Err` does not
    /// mean one unreadable message — it means the router itself is gone, i.e.
    /// the connection is, and a caller must stop reading rather than retry.
    pub async fn read_update(&mut self) -> Result<Dispatch, agent_client_protocol::Error> {
        self.update_rx.next().await.ok_or_else(|| {
            agent_client_protocol::util::internal_error("session channel closed unexpectedly")
        })
    }
}

/// Claims every message from the agent whose `params.sessionId` names this
/// session. Mirrors the runtime's own `ActiveSessionHandler`.
struct SessionRouter {
    session_id: SessionId,
    update_tx: mpsc::UnboundedSender<Dispatch>,
}

impl HandleDispatchFrom<Agent> for SessionRouter {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        cx: ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        MatchDispatchFrom::new(message, &cx)
            .if_dispatch_from(Agent, async |message: Dispatch| {
                if dispatch_session_id(&message) == Some(&*self.session_id.0) {
                    self.update_tx
                        .unbounded_send(message)
                        .map_err(agent_client_protocol::util::internal_error)?;
                    return Ok(Handled::Yes);
                }
                Ok(Handled::No {
                    message,
                    retry: false,
                })
            })
            .await
            .done()
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        format!("AgentSession({})", self.session_id)
    }
}

/// The `sessionId` a request or notification names, if it names one as a
/// string. A `null` (or otherwise non-string) id matches no session — the
/// runtime's own router errors on it instead, which is why codeg claims the
/// `null` ones, the shape agents actually send, before they get this far
/// (`ClaimNullSessionIds`).
fn dispatch_session_id(dispatch: &Dispatch) -> Option<&str> {
    let message = match dispatch {
        Dispatch::Request(message, _) | Dispatch::Notification(message) => message,
        Dispatch::Response(..) => return None,
    };
    message.params().get("sessionId")?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        AvailableCommandsUpdate, NewSessionRequest, SessionNotification, SessionUpdate,
    };
    use agent_client_protocol::{Channel, Client, Responder, UntypedMessage};

    fn notification(params: serde_json::Value) -> Dispatch {
        Dispatch::Notification(UntypedMessage::new("session/update", params).unwrap())
    }

    fn commands_update(session_id: &str) -> SessionNotification {
        SessionNotification::new(
            SessionId::new(session_id),
            SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(Vec::new())),
        )
    }

    fn update_session_id(dispatch: Dispatch) -> String {
        dispatch_session_id(&dispatch)
            .expect("a routed update names its session")
            .to_string()
    }

    /// The whole contract, against the real runtime over an in-memory pipe:
    /// codeg creates the session UNTYPED (as `send_new_session_capturing_models`
    /// does), attaches afterwards, and still receives the update the agent sent
    /// BEFORE its `session/new` response — parked by the runtime because it
    /// carries a `sessionId`, and replayed into the router the moment it is
    /// added. That replay is what a `session/load` history drain and the
    /// `available_commands_update` agents send right after `session/new` depend
    /// on. A frame for another session must not leak in.
    #[tokio::test]
    async fn an_attached_session_receives_updates_the_agent_sent_before_the_response() {
        let (client_end, agent_end) = Channel::duplex();

        let agent = tokio::spawn(
            Agent
                .builder()
                .on_receive_request(
                    async |_req: NewSessionRequest,
                           responder: Responder<NewSessionResponse>,
                           cx: ConnectionTo<Client>| {
                        // Racing the response: sent first, so it reaches the
                        // client before any router for `s1` exists.
                        cx.send_notification(commands_update("s1"))?;
                        cx.send_notification(commands_update("someone-else"))?;
                        responder.respond(NewSessionResponse::new(SessionId::new("s1")))
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_to(agent_end),
        );

        let routed = Client
            .builder()
            .connect_with(client_end, async |cx: ConnectionTo<Agent>| {
                let raw = cx
                    .send_request_to(
                        Agent,
                        UntypedMessage::new("session/new", NewSessionRequest::new("/tmp"))?,
                    )
                    .block_task()
                    .await?;
                let response: NewSessionResponse = serde_json::from_value(raw)
                    .map_err(agent_client_protocol::Error::into_internal_error)?;
                let mut session = AgentSession::attach(&cx, response)?;
                assert_eq!(&*session.session_id().0, "s1");

                let first = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    session.read_update(),
                )
                .await
                .expect("the parked update is replayed into the new router")?;
                // Nothing else is routed here: the other session's frame stays
                // parked for a router of its own.
                let nothing_more = tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    session.read_update(),
                )
                .await;
                assert!(nothing_more.is_err(), "another session's update leaked in");
                Ok(update_session_id(first))
            })
            .await
            .expect("client connection");

        assert_eq!(routed, "s1");
        agent.abort();
    }

    #[test]
    fn a_dispatch_names_its_session_only_through_a_string_id() {
        assert_eq!(
            dispatch_session_id(&notification(serde_json::json!({"sessionId": "s1"}))),
            Some("s1")
        );
        assert_eq!(
            dispatch_session_id(&notification(serde_json::json!({"sessionId": null}))),
            None
        );
        assert_eq!(
            dispatch_session_id(&notification(serde_json::json!({"update": {}}))),
            None
        );
    }
}
