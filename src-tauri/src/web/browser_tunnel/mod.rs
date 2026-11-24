//! The browser tunnel: how a remote-workspace window's built-in browser
//! reaches this host.
//!
//! A desktop app connected to this codeg-server renders pages locally, but the
//! addresses those pages come from — `localhost:3000` printed by an agent
//! here, a container at `172.17.0.2` — only exist from this host's side. The
//! desktop runs a SOCKS5 listener for a browser profile of its own and carries
//! every connection that profile makes over one WebSocket to this endpoint,
//! which connects to the destination from here. The page is then exactly the
//! page it would be on this host, with nothing rewritten in between: the
//! tunnel moves TCP bytes, and TLS, WebSockets and HTTP/2 go through
//! untouched.
//!
//! One WebSocket, many streams (`frame`); per-stream flow control and
//! half-close (`pump`); where a stream may go (`policy`). The endpoint sits
//! behind codeg's token like `/ws/events`.

pub mod frame;
pub mod policy;
pub mod pump;

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use self::frame::{CloseCode, Frame, TUNNEL_PROTOCOL};
use self::policy::TunnelPolicy;
use self::pump::{pump, StreamEvent};
use super::shutdown::ShutdownSignal;

/// Frames waiting for the WebSocket: control frames and at most a window of
/// data per stream (the pumps wait for credit), so this only bounds bursts.
const OUTGOING_QUEUE: usize = 256;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Extension(shutdown): Extension<Arc<ShutdownSignal>>,
) -> Response {
    let policy = TunnelPolicy::current();
    if policy == TunnelPolicy::Off {
        return (StatusCode::FORBIDDEN, "the browser tunnel is off on this server").into_response();
    }
    ws.protocols([TUNNEL_PROTOCOL])
        .on_upgrade(move |socket| session(socket, policy, shutdown))
}

async fn session(socket: WebSocket, policy: TunnelPolicy, shutdown: Arc<ShutdownSignal>) {
    if shutdown.is_triggered() {
        return;
    }
    let (mut sink, mut incoming) = socket.split();
    let (frames, mut outgoing) = mpsc::channel::<Frame>(OUTGOING_QUEUE);
    let writer = tokio::spawn(async move {
        while let Some(frame) = outgoing.recv().await {
            if sink.send(Message::Binary(frame.encode().into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // Open streams, by id: where the peer's frames for each one go.
    let mut streams: HashMap<u32, mpsc::UnboundedSender<StreamEvent>> = HashMap::new();
    let (ended, mut ended_rx) = mpsc::unbounded_channel::<u32>();

    loop {
        tokio::select! {
            _ = shutdown.wait() => break,
            Some(id) = ended_rx.recv() => {
                streams.remove(&id);
            }
            message = incoming.next() => {
                let bytes = match message {
                    Some(Ok(Message::Binary(bytes))) => bytes,
                    // axum answers pings itself; nothing else is expected.
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    Some(Ok(Message::Text(_))) => {
                        tracing::debug!("[browser-tunnel] text message; closing");
                        break;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                };
                let frame = match Frame::decode(&bytes) {
                    Ok(frame) => frame,
                    Err(err) => {
                        tracing::debug!("[browser-tunnel] {err}; closing");
                        break;
                    }
                };
                match frame {
                    Frame::Open { stream: id, host, port } => {
                        if id == 0 || streams.contains_key(&id) || host.is_empty() || port == 0 {
                            let _ = frames
                                .send(Frame::Close {
                                    stream: id,
                                    code: CloseCode::BadRequest,
                                    message: "not a stream that can be opened".into(),
                                })
                                .await;
                            continue;
                        }
                        let (to_stream, events) = mpsc::unbounded_channel();
                        streams.insert(id, to_stream);
                        tokio::spawn(open_stream(
                            id,
                            host,
                            port,
                            policy,
                            events,
                            frames.clone(),
                            ended.clone(),
                        ));
                    }
                    // Only this side answers an OPEN.
                    Frame::Opened { .. } => {
                        tracing::debug!("[browser-tunnel] peer sent OPENED; closing");
                        break;
                    }
                    frame => {
                        let id = frame.stream();
                        // A stream that is not open any more (it ended while
                        // this frame was on its way) has nothing to say.
                        if let (Some(to_stream), Some(event)) =
                            (streams.get(&id), StreamEvent::from_frame(frame))
                        {
                            let _ = to_stream.send(event);
                        }
                    }
                }
            }
        }
    }
    // Every pump sees its event channel close and lets its connection go.
    drop(streams);
    drop(frames);
    let _ = writer.await;
}

/// Connect stream `id` and pump it until it is over. The peer does not send
/// data before OPENED (its SOCKS client waits for the reply), so anything
/// but a CLOSE while connecting is a broken peer.
async fn open_stream(
    id: u32,
    host: String,
    port: u16,
    policy: TunnelPolicy,
    mut events: mpsc::UnboundedReceiver<StreamEvent>,
    frames: mpsc::Sender<Frame>,
    ended: mpsc::UnboundedSender<u32>,
) {
    let connected = tokio::select! {
        result = policy::dial(&host, port, policy) => Some(result),
        event = events.recv() => {
            if !matches!(event, Some(StreamEvent::Close(..)) | None) {
                let _ = frames
                    .send(Frame::Close {
                        stream: id,
                        code: CloseCode::Protocol,
                        message: "sent before the stream was open".into(),
                    })
                    .await;
            }
            None
        }
    };
    match connected {
        Some(Ok(connection)) => {
            if frames.send(Frame::Opened { stream: id }).await.is_ok() {
                let end = pump(connection, id, events, frames).await;
                tracing::debug!("[browser-tunnel] stream {id} to {host}:{port} ended: {end:?}");
            }
        }
        Some(Err((code, message))) => {
            tracing::debug!("[browser-tunnel] stream {id} to {host}:{port}: {message}");
            let _ = frames.send(Frame::Close { stream: id, code, message }).await;
        }
        None => {}
    }
    let _ = ended.send(id);
}
