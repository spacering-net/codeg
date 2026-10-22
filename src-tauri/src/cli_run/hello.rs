//! `cli_hello`: the CLI proves which runtime it is talking to before it sends
//! a token or a prompt.
//!
//! A discovery file left by a crashed runtime names a pid that may have been
//! reused and a port that may now belong to anything — another local user's
//! process included — and "pid alive + health answers" proves nothing. So the
//! CLI sends a random nonce WITHOUT a token, and the runtime answers with
//! `HMAC-SHA256(token, "codeg-cli-hello\0" ‖ nonce ‖ "\0" ‖ port)`. Only the
//! process the file's token was minted for can compute that; binding the port
//! in keeps an impostor from relaying the challenge to another live runtime.
//! Over `--url` (a remote server, perhaps behind a proxy that hides its port)
//! the port is left out and the proof is keyed by the main token.

use hmac::{Hmac, Mac};
use sha2::Sha256;

const DOMAIN: &[u8] = b"codeg-cli-hello\0";

/// The proof for `nonce`, hex. `port` is the loopback listener's own port;
/// `None` on the main `/api` routes.
pub fn proof(token: &str, nonce: &str, port: Option<u16>) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC takes a key of any length");
    mac.update(DOMAIN);
    mac.update(nonce.as_bytes());
    if let Some(port) = port {
        mac.update(b"\0");
        mac.update(port.to_string().as_bytes());
    }
    hex(&mac.finalize().into_bytes())
}

/// Check a proof in constant time.
pub fn verify(token: &str, nonce: &str, port: Option<u16>, claimed: &str) -> bool {
    let expected = proof(token, nonce, port);
    expected.len() == claimed.len()
        && expected
            .bytes()
            .zip(claimed.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// `len` random bytes, hex — for tokens and nonces.
pub fn random_hex(len: usize) -> String {
    use rand::RngCore;
    let mut bytes = vec![0u8; len];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_proof_is_bound_to_the_token_the_nonce_and_the_port() {
        let p = proof("tok", "n1", Some(4100));
        assert_eq!(p.len(), 64);
        assert!(verify("tok", "n1", Some(4100), &p));
        assert!(!verify("other", "n1", Some(4100), &p));
        assert!(!verify("tok", "n2", Some(4100), &p));
        assert!(
            !verify("tok", "n1", Some(4101), &p),
            "a relayed challenge fails"
        );
        assert!(!verify("tok", "n1", None, &p));
        assert!(!verify("tok", "n1", Some(4100), "00"));
    }

    #[test]
    fn random_hex_has_the_asked_length_and_varies() {
        let a = random_hex(32);
        assert_eq!(a.len(), 64);
        assert_ne!(a, random_hex(32));
    }
}
