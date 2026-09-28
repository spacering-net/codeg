//! One TCP connection carried as one tunnel stream — the same on both ends:
//! the server pumps between a stream and the connection it dialled, the
//! desktop between a stream and the connection its browser made to the local
//! SOCKS listener.
//!
//! Two things matter here, and both are about bytes nobody is reading.
//!
//! **Flow control.** Each direction of a stream has a window
//! (`INITIAL_WINDOW`): a side sends that much, then waits for WINDOW frames
//! granting more, which the other side sends only once it has written those
//! bytes onward. A page that stops reading — a paused video, a dev tool left
//! on a breakpoint — therefore holds at most one window per direction in the
//! tunnel, and never slows the other streams of the same WebSocket. A peer
//! that sends past its window is broken or hostile; its stream is closed.
//!
//! **Independent directions.** Reading and writing run concurrently, so a
//! connection whose peer is not reading can never stall the direction that
//! is still moving (the classic single-loop proxy deadlock, where both ends
//! wait to write to each other). EOF travels as a half-close: HTTP/1.0
//! request bodies and other protocols that signal "done sending" by shutting
//! down one direction keep working.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

use super::frame::{CloseCode, Frame, INITIAL_WINDOW, MAX_DATA_CHUNK};

/// Most credit a side may hold at once. Grants beyond the window it could
/// ever need are a peer that lost count; refusing them keeps the counter from
/// wrapping.
const MAX_CREDIT: u32 = 16 * INITIAL_WINDOW;

/// What the peer sent on a stream, as the session routes it to the stream's
/// pump.
#[derive(Debug)]
pub enum StreamEvent {
    Data(Vec<u8>),
    Window(u32),
    Eof,
    Close(CloseCode, String),
}

impl StreamEvent {
    /// The event a frame for an already open stream is, or `None` for the
    /// two frames that only make sense while a stream is being set up.
    pub fn from_frame(frame: Frame) -> Option<Self> {
        Some(match frame {
            Frame::Data { payload, .. } => Self::Data(payload),
            Frame::Window { credit, .. } => Self::Window(credit),
            Frame::Eof { .. } => Self::Eof,
            Frame::Close { code, message, .. } => Self::Close(code, message),
            Frame::Open { .. } | Frame::Opened { .. } => return None,
        })
    }
}

/// How a pump ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PumpEnd {
    /// Both directions finished (EOF each way).
    Done,
    /// The peer closed the stream.
    ClosedByPeer(CloseCode),
    /// The session went away (the WebSocket closed).
    Detached,
    /// This side's connection failed, or the peer broke the protocol; a
    /// CLOSE saying so has been sent.
    Failed(CloseCode),
}

/// Pump bytes between `connection` and stream `id` until the stream is over.
/// `events` carries what the peer sends on the stream; `frames` goes to the
/// WebSocket writer. Returns once nothing more will move either way; the
/// caller forgets the stream then. A CLOSE is sent for every ending this
/// side decides on (done, or failed), so the peer can forget it too.
pub async fn pump<C>(
    connection: C,
    id: u32,
    mut events: mpsc::UnboundedReceiver<StreamEvent>,
    frames: mpsc::Sender<Frame>,
) -> PumpEnd
where
    C: AsyncRead + AsyncWrite + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(connection);
    // Bytes this side may still send to the peer.
    let credit = Arc::new(AtomicU32::new(INITIAL_WINDOW));
    let credit_granted = Arc::new(Notify::new());
    // Bytes the peer sent that this side has not written onward and granted
    // back yet: the peer may never have more than a window of these.
    let unconsumed = Arc::new(AtomicU32::new(0));
    // Set by whichever direction fails; ends the other one too.
    let failed = CancellationToken::new();
    let failure = Arc::new(std::sync::Mutex::new(None::<CloseCode>));

    let (to_writer, mut writer_rx) = mpsc::unbounded_channel::<Option<Vec<u8>>>();

    let fail = {
        let failed = failed.clone();
        let failure = failure.clone();
        let frames = frames.clone();
        move |code: CloseCode, message: String| {
            let failed = failed.clone();
            let failure = failure.clone();
            let frames = frames.clone();
            async move {
                {
                    let mut slot = failure.lock().unwrap_or_else(|e| e.into_inner());
                    if slot.is_some() {
                        return;
                    }
                    *slot = Some(code);
                }
                let _ = frames.send(Frame::Close { stream: id, code, message }).await;
                failed.cancel();
            }
        }
    };

    // Connection → peer, within the credit the peer grants.
    let read_side = {
        let credit = credit.clone();
        let credit_granted = credit_granted.clone();
        let frames = frames.clone();
        let fail = fail.clone();
        async move {
            let mut buf = vec![0u8; MAX_DATA_CHUNK];
            loop {
                let available = loop {
                    let available = credit.load(Ordering::Acquire);
                    if available > 0 {
                        break available;
                    }
                    credit_granted.notified().await;
                };
                let want = (available as usize).min(MAX_DATA_CHUNK);
                match reader.read(&mut buf[..want]).await {
                    Ok(0) => {
                        let _ = frames.send(Frame::Eof { stream: id }).await;
                        return;
                    }
                    Ok(n) => {
                        credit.fetch_sub(n as u32, Ordering::AcqRel);
                        let payload = buf[..n].to_vec();
                        if frames.send(Frame::Data { stream: id, payload }).await.is_err() {
                            return;
                        }
                    }
                    Err(err) => {
                        fail(CloseCode::Failed, format!("read failed: {err}")).await;
                        return;
                    }
                }
            }
        }
    };

    // Peer → connection, granting credit back once bytes are written onward.
    let write_side = {
        let frames = frames.clone();
        let unconsumed = unconsumed.clone();
        let fail = fail.clone();
        async move {
            while let Some(chunk) = writer_rx.recv().await {
                let Some(bytes) = chunk else {
                    // The peer sent EOF: pass the half-close on.
                    let _ = writer.shutdown().await;
                    return;
                };
                if let Err(err) = writer.write_all(&bytes).await {
                    fail(CloseCode::Failed, format!("write failed: {err}")).await;
                    return;
                }
                let n = bytes.len() as u32;
                unconsumed.fetch_sub(n, Ordering::AcqRel);
                if n > 0 && frames.send(Frame::Window { stream: id, credit: n }).await.is_err() {
                    return;
                }
            }
        }
    };

    // The peer's frames, routed to the two directions.
    let dispatch = {
        let fail = fail.clone();
        async move {
            while let Some(event) = events.recv().await {
                match event {
                    StreamEvent::Data(bytes) => {
                        let n = bytes.len() as u32;
                        let outstanding = unconsumed.fetch_add(n, Ordering::AcqRel) + n;
                        if outstanding > INITIAL_WINDOW {
                            fail(CloseCode::Protocol, "sent past the window".into()).await;
                            return None;
                        }
                        let _ = to_writer.send(Some(bytes));
                    }
                    StreamEvent::Window(grant) => {
                        let before = credit.load(Ordering::Acquire);
                        if before.saturating_add(grant) > MAX_CREDIT {
                            fail(CloseCode::Protocol, "granted more than a window".into()).await;
                            return None;
                        }
                        credit.fetch_add(grant, Ordering::AcqRel);
                        credit_granted.notify_one();
                    }
                    StreamEvent::Eof => {
                        let _ = to_writer.send(None);
                    }
                    StreamEvent::Close(code, _) => return Some(code),
                }
            }
            None
        }
    };

    let mut read_task = tokio::spawn(read_side);
    let mut write_task = tokio::spawn(write_side);
    tokio::pin!(dispatch);
    let end = tokio::select! {
        _ = async {
            let _ = (&mut read_task).await;
            let _ = (&mut write_task).await;
        } => PumpEnd::Done,
        closed = &mut dispatch => match closed {
            // A graceful close comes once the peer is done both ways, right
            // behind the last of its data and its EOF — which may still be
            // on their way to the connection. The dispatcher has let go of
            // the writer's queue, so the writer finishes what is in it and
            // stops; this side had already sent everything (the peer saw its
            // EOF before closing).
            Some(CloseCode::Normal) => {
                let _ = (&mut write_task).await;
                PumpEnd::ClosedByPeer(CloseCode::Normal)
            }
            Some(code) => PumpEnd::ClosedByPeer(code),
            None => PumpEnd::Detached,
        },
        _ = failed.cancelled() => PumpEnd::Detached,
    };
    read_task.abort();
    write_task.abort();
    let failed_with = *failure.lock().unwrap_or_else(|e| e.into_inner());
    match (end, failed_with) {
        (_, Some(code)) => PumpEnd::Failed(code),
        (PumpEnd::Done, None) => {
            let _ = frames
                .send(Frame::Close { stream: id, code: CloseCode::Normal, message: String::new() })
                .await;
            PumpEnd::Done
        }
        (end, None) => end,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    /// A pump over one end of an in-memory pipe; the test plays both the
    /// application (the pipe's other end) and the peer (events in, frames
    /// out).
    struct Harness {
        app: tokio::io::DuplexStream,
        events: mpsc::UnboundedSender<StreamEvent>,
        frames: mpsc::Receiver<Frame>,
        pump: tokio::task::JoinHandle<PumpEnd>,
    }

    fn harness(buffer: usize) -> Harness {
        let (app, pumped) = duplex(buffer);
        let (events, events_rx) = mpsc::unbounded_channel();
        let (frames_tx, frames) = mpsc::channel(64);
        let pump = tokio::spawn(pump(pumped, 9, events_rx, frames_tx));
        Harness { app, events, frames, pump }
    }

    #[tokio::test]
    async fn bytes_move_both_ways_and_eof_ends_the_stream() {
        let mut h = harness(1024);
        h.app.write_all(b"request").await.unwrap();
        assert_eq!(
            h.frames.recv().await.unwrap(),
            Frame::Data { stream: 9, payload: b"request".to_vec() }
        );
        h.events.send(StreamEvent::Data(b"response".to_vec())).unwrap();
        let mut got = [0u8; 8];
        h.app.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"response");
        // Written onward, so granted back.
        assert_eq!(h.frames.recv().await.unwrap(), Frame::Window { stream: 9, credit: 8 });

        // Both sides say they are done sending.
        h.app.shutdown().await.unwrap();
        assert_eq!(h.frames.recv().await.unwrap(), Frame::Eof { stream: 9 });
        h.events.send(StreamEvent::Eof).unwrap();
        assert_eq!(h.pump.await.unwrap(), PumpEnd::Done);
        assert!(matches!(
            h.frames.recv().await.unwrap(),
            Frame::Close { code: CloseCode::Normal, .. }
        ));
    }

    // A half-close is passed on, and the other direction keeps working.
    #[tokio::test]
    async fn the_peers_eof_is_a_half_close() {
        let mut h = harness(1024);
        h.events.send(StreamEvent::Eof).unwrap();
        let mut rest = Vec::new();
        h.app.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        h.app.write_all(b"still talking").await.unwrap();
        assert_eq!(
            h.frames.recv().await.unwrap(),
            Frame::Data { stream: 9, payload: b"still talking".to_vec() }
        );
    }

    #[tokio::test]
    async fn sending_stops_at_the_window_until_credit_is_granted() {
        let mut h = harness(4 * INITIAL_WINDOW as usize);
        let big = vec![7u8; INITIAL_WINDOW as usize + 1000];
        h.app.write_all(&big).await.unwrap();
        let mut sent = 0usize;
        while sent < INITIAL_WINDOW as usize {
            match h.frames.recv().await.unwrap() {
                Frame::Data { payload, .. } => sent += payload.len(),
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(sent, INITIAL_WINDOW as usize);
        // Nothing more without credit.
        let more = tokio::time::timeout(std::time::Duration::from_millis(100), h.frames.recv()).await;
        assert!(more.is_err(), "sent past the window: {more:?}");
        h.events.send(StreamEvent::Window(1000)).unwrap();
        let Frame::Data { payload, .. } = h.frames.recv().await.unwrap() else {
            panic!("expected the rest")
        };
        assert_eq!(payload.len(), 1000);
    }

    #[tokio::test]
    async fn a_peer_that_sends_past_its_window_is_closed() {
        let mut h = harness(16);
        // The application reads nothing, so nothing is granted back.
        h.events.send(StreamEvent::Data(vec![0u8; INITIAL_WINDOW as usize])).unwrap();
        h.events.send(StreamEvent::Data(vec![0u8; 1])).unwrap();
        assert_eq!(h.pump.await.unwrap(), PumpEnd::Failed(CloseCode::Protocol));
        let mut saw_close = false;
        while let Ok(frame) = h.frames.try_recv() {
            if matches!(frame, Frame::Close { code: CloseCode::Protocol, .. }) {
                saw_close = true;
            }
        }
        assert!(saw_close);
    }

    // The peer's graceful close arrives right behind its last data and EOF:
    // that data must still reach the connection.
    #[tokio::test]
    async fn a_graceful_close_does_not_cut_off_the_data_before_it() {
        let mut h = harness(1024);
        h.events.send(StreamEvent::Data(b"the last words".to_vec())).unwrap();
        h.events.send(StreamEvent::Eof).unwrap();
        h.events.send(StreamEvent::Close(CloseCode::Normal, String::new())).unwrap();
        let mut rest = Vec::new();
        h.app.read_to_end(&mut rest).await.unwrap();
        assert_eq!(rest, b"the last words");
        assert_eq!(h.pump.await.unwrap(), PumpEnd::ClosedByPeer(CloseCode::Normal));
    }

    #[tokio::test]
    async fn a_close_from_the_peer_ends_the_pump_and_drops_the_connection() {
        let mut h = harness(1024);
        h.events.send(StreamEvent::Close(CloseCode::Refused, String::new())).unwrap();
        assert_eq!(h.pump.await.unwrap(), PumpEnd::ClosedByPeer(CloseCode::Refused));
        let mut rest = Vec::new();
        // The pump's end of the pipe is gone: the application reads EOF.
        h.app.read_to_end(&mut rest).await.unwrap();
    }

    #[tokio::test]
    async fn a_session_that_goes_away_detaches_the_pump() {
        let h = harness(1024);
        drop(h.events);
        assert_eq!(h.pump.await.unwrap(), PumpEnd::Detached);
    }
}
