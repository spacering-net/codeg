//! The tunnel's wire format: binary WebSocket messages, one frame each.
//!
//! ```text
//! [kind: u8][stream: u32 BE][payload …]
//! ```
//!
//! The desktop opens a stream per TCP connection its browser makes, names
//! where it should go, and both ends then move bytes and flow-control credit
//! over it until either side is done. Everything that crosses the tunnel is
//! one of the six kinds below; anything else is a protocol error that ends the
//! whole WebSocket, because a peer that cannot be understood cannot be trusted
//! to have understood what came before either.

use std::fmt;

/// WebSocket subprotocol both ends name, next to codeg's token protocol.
pub const TUNNEL_PROTOCOL: &str = "codeg-tunnel";

/// Where the tunnel is served, relative to the codeg-server's base URL.
pub const TUNNEL_PATH: &str = "/ws/browser-tunnel";

/// Bytes a side may send on a stream before the other grants more — per
/// stream, per direction. Enough for a page's resources to arrive at full
/// speed, small enough that a stalled reader holds this much and no more.
pub const INITIAL_WINDOW: u32 = 256 * 1024;

/// Largest DATA payload a side sends: small enough to interleave the streams
/// of one page, large enough that the 5-byte header is noise.
pub const MAX_DATA_CHUNK: usize = 32 * 1024;

/// Longest host an OPEN may name: what its one-byte length can say, and
/// what a SOCKS5 request can carry (a DNS name is at most 253 octets anyway).
pub const MAX_HOST_LEN: usize = 255;

/// Longest human-readable reason a CLOSE carries.
pub const MAX_CLOSE_MESSAGE: usize = 256;

const HEADER_LEN: usize = 5;

/// Why a stream ended. Maps onto SOCKS5 reply codes on the desktop side, so a
/// page that could not connect gets the engine's own error page for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CloseCode {
    /// Either side is done with the stream.
    Normal = 0,
    /// Nothing listens at the destination.
    Refused = 1,
    /// The destination could not be reached (no route, name did not resolve).
    Unreachable = 2,
    /// The server's policy does not allow this destination.
    NotAllowed = 3,
    /// Connecting took too long.
    Timeout = 4,
    /// The OPEN itself made no sense (empty host, port 0, a reused stream id).
    BadRequest = 5,
    /// The peer broke the protocol on this stream (sent past its window).
    Protocol = 6,
    /// Anything else went wrong.
    Failed = 7,
}

impl CloseCode {
    fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            0 => Self::Normal,
            1 => Self::Refused,
            2 => Self::Unreachable,
            3 => Self::NotAllowed,
            4 => Self::Timeout,
            5 => Self::BadRequest,
            6 => Self::Protocol,
            7 => Self::Failed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// Desktop → server: connect this stream to `host:port`. `host` is a DNS
    /// name or an IP literal (IPv6 without brackets).
    Open { stream: u32, host: String, port: u16 },
    /// Server → desktop: the connection is up; bytes may flow.
    Opened { stream: u32 },
    /// Either way: bytes of the stream, within the sender's credit.
    Data { stream: u32, payload: Vec<u8> },
    /// Either way: the receiver has consumed `credit` more bytes; the sender
    /// may send that many more.
    Window { stream: u32, credit: u32 },
    /// Either way: the sender will send no more data (a TCP half-close); it
    /// still reads what arrives.
    Eof { stream: u32 },
    /// Either way: the stream is over, in both directions.
    Close { stream: u32, code: CloseCode, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Kind {
    Open = 1,
    Opened = 2,
    Data = 3,
    Window = 4,
    Eof = 5,
    Close = 6,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// Shorter than a header.
    Truncated,
    UnknownKind(u8),
    /// A payload that does not have the shape its kind requires.
    Malformed(&'static str),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => write!(f, "frame shorter than its header"),
            Self::UnknownKind(kind) => write!(f, "unknown frame kind {kind}"),
            Self::Malformed(what) => write!(f, "malformed frame: {what}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl Frame {
    /// An OPEN, or `None` when the destination cannot be one: an empty host,
    /// one longer than `MAX_HOST_LEN`, or port 0. Never shortened — a cut
    /// name is somebody else's host.
    pub fn open(stream: u32, host: &str, port: u16) -> Option<Self> {
        if host.is_empty() || host.len() > MAX_HOST_LEN || port == 0 {
            return None;
        }
        Some(Self::Open { stream, host: host.to_string(), port })
    }

    pub fn stream(&self) -> u32 {
        match self {
            Self::Open { stream, .. }
            | Self::Opened { stream }
            | Self::Data { stream, .. }
            | Self::Window { stream, .. }
            | Self::Eof { stream }
            | Self::Close { stream, .. } => *stream,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let (kind, payload_len) = match self {
            Self::Open { host, .. } => (Kind::Open, 3 + host.len()),
            Self::Opened { .. } => (Kind::Opened, 0),
            Self::Data { payload, .. } => (Kind::Data, payload.len()),
            Self::Window { .. } => (Kind::Window, 4),
            Self::Eof { .. } => (Kind::Eof, 0),
            Self::Close { message, .. } => (Kind::Close, 1 + message.len()),
        };
        let mut out = Vec::with_capacity(HEADER_LEN + payload_len);
        out.push(kind as u8);
        out.extend_from_slice(&self.stream().to_be_bytes());
        match self {
            Self::Open { host, port, .. } => {
                out.extend_from_slice(&port.to_be_bytes());
                // `Frame::open` refuses a longer host; one built by hand that
                // is longer anyway goes out empty, which the peer refuses,
                // rather than cut down to somebody else's name.
                let host = if host.len() <= MAX_HOST_LEN { host.as_bytes() } else { &[] };
                out.push(host.len() as u8);
                out.extend_from_slice(host);
            }
            Self::Data { payload, .. } => out.extend_from_slice(payload),
            Self::Window { credit, .. } => out.extend_from_slice(&credit.to_be_bytes()),
            Self::Close { code, message, .. } => {
                out.push(*code as u8);
                out.extend_from_slice(truncate_utf8(message, MAX_CLOSE_MESSAGE).as_bytes());
            }
            Self::Opened { .. } | Self::Eof { .. } => {}
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, FrameError> {
        if bytes.len() < HEADER_LEN {
            return Err(FrameError::Truncated);
        }
        let kind = bytes[0];
        let stream = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        let payload = &bytes[HEADER_LEN..];
        Ok(match kind {
            k if k == Kind::Open as u8 => {
                if payload.len() < 3 {
                    return Err(FrameError::Malformed("open without port and host length"));
                }
                let port = u16::from_be_bytes([payload[0], payload[1]]);
                let len = payload[2] as usize;
                let host = payload
                    .get(3..3 + len)
                    .filter(|_| payload.len() == 3 + len)
                    .ok_or(FrameError::Malformed("open host length does not match"))?;
                let host = std::str::from_utf8(host)
                    .map_err(|_| FrameError::Malformed("open host is not UTF-8"))?;
                Self::Open { stream, host: host.to_string(), port }
            }
            k if k == Kind::Opened as u8 => {
                expect_empty(payload, "opened carries no payload")?;
                Self::Opened { stream }
            }
            k if k == Kind::Data as u8 => Self::Data { stream, payload: payload.to_vec() },
            k if k == Kind::Window as u8 => {
                let credit: [u8; 4] = payload
                    .try_into()
                    .map_err(|_| FrameError::Malformed("window credit is four bytes"))?;
                Self::Window { stream, credit: u32::from_be_bytes(credit) }
            }
            k if k == Kind::Eof as u8 => {
                expect_empty(payload, "eof carries no payload")?;
                Self::Eof { stream }
            }
            k if k == Kind::Close as u8 => {
                let (&code, message) = payload
                    .split_first()
                    .ok_or(FrameError::Malformed("close without a code"))?;
                let code = CloseCode::from_u8(code).ok_or(FrameError::Malformed("unknown close code"))?;
                Self::Close {
                    stream,
                    code,
                    message: String::from_utf8_lossy(message).into_owned(),
                }
            }
            other => return Err(FrameError::UnknownKind(other)),
        })
    }
}

fn expect_empty(payload: &[u8], what: &'static str) -> Result<(), FrameError> {
    if payload.is_empty() {
        Ok(())
    } else {
        Err(FrameError::Malformed(what))
    }
}

/// `text` cut to at most `max` bytes, at a character boundary.
fn truncate_utf8(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(frame: Frame) {
        assert_eq!(Frame::decode(&frame.encode()).unwrap(), frame);
    }

    #[test]
    fn every_kind_survives_a_round_trip() {
        round_trip(Frame::Open { stream: 1, host: "localhost".into(), port: 3000 });
        round_trip(Frame::Open { stream: 7, host: "::1".into(), port: 443 });
        round_trip(Frame::Opened { stream: 1 });
        round_trip(Frame::Data { stream: 2, payload: b"GET / HTTP/1.1\r\n".to_vec() });
        round_trip(Frame::Data { stream: 2, payload: Vec::new() });
        round_trip(Frame::Window { stream: 3, credit: INITIAL_WINDOW });
        round_trip(Frame::Eof { stream: u32::MAX });
        round_trip(Frame::Close { stream: 4, code: CloseCode::NotAllowed, message: "policy".into() });
        round_trip(Frame::Close { stream: 4, code: CloseCode::Normal, message: String::new() });
    }

    #[test]
    fn the_header_is_kind_then_big_endian_stream() {
        let bytes = Frame::Window { stream: 0x0102_0304, credit: 0x0a0b_0c0d }.encode();
        assert_eq!(bytes, [4, 1, 2, 3, 4, 0x0a, 0x0b, 0x0c, 0x0d]);
        let bytes = Frame::Open { stream: 1, host: "a".into(), port: 80 }.encode();
        assert_eq!(bytes, [1, 0, 0, 0, 1, 0, 80, 1, b'a']);
    }

    #[test]
    fn malformed_frames_are_refused_rather_than_guessed_at() {
        assert_eq!(Frame::decode(&[1, 0, 0]), Err(FrameError::Truncated));
        assert_eq!(Frame::decode(&[99, 0, 0, 0, 1]), Err(FrameError::UnknownKind(99)));
        // Host length says 5, one byte follows.
        assert!(Frame::decode(&[1, 0, 0, 0, 1, 0, 80, 5, b'a']).is_err());
        // Host length says 1, two bytes follow.
        assert!(Frame::decode(&[1, 0, 0, 0, 1, 0, 80, 1, b'a', b'b']).is_err());
        assert!(Frame::decode(&[4, 0, 0, 0, 1, 0, 0]).is_err());
        assert!(Frame::decode(&[2, 0, 0, 0, 1, 9]).is_err());
        assert!(Frame::decode(&[6, 0, 0, 0, 1]).is_err());
        assert!(Frame::decode(&[6, 0, 0, 0, 1, 42]).is_err());
        assert!(Frame::decode(&[1, 0, 0, 0, 1, 0, 80, 2, 0xff, 0xfe]).is_err());
    }

    #[test]
    fn an_open_is_never_made_to_a_destination_that_cannot_be_one() {
        assert!(Frame::open(1, "localhost", 3000).is_some());
        assert!(Frame::open(1, "", 3000).is_none());
        assert!(Frame::open(1, "localhost", 0).is_none());
        assert!(Frame::open(1, &"a".repeat(MAX_HOST_LEN), 1).is_some());
        assert!(Frame::open(1, &"a".repeat(MAX_HOST_LEN + 1), 1).is_none());
        // Built by hand past the limit: sent without a host, not shortened.
        let frame = Frame::Open { stream: 1, host: "a".repeat(300), port: 1 };
        assert_eq!(
            Frame::decode(&frame.encode()).unwrap(),
            Frame::Open { stream: 1, host: String::new(), port: 1 }
        );
    }

    #[test]
    fn a_long_close_message_is_cut_at_a_character_boundary() {
        let message = "é".repeat(MAX_CLOSE_MESSAGE);
        let frame = Frame::Close { stream: 1, code: CloseCode::Failed, message };
        let Frame::Close { message, .. } = Frame::decode(&frame.encode()).unwrap() else {
            panic!("not a close")
        };
        assert!(message.len() <= MAX_CLOSE_MESSAGE);
        assert!(message.chars().all(|c| c == 'é'));
    }
}
