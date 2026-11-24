//! The secrets of a sign-in, and the opaque values SpaceRing hands out.
//!
//! Each is a type of its own that prints as `[redacted]` — in `{:?}`, in a
//! panic message, in a log line — so none can be written out by accident; the
//! value is reached only through `expose`, where a request is made.
//!
//! SpaceRing's rules (`api/clients/protocol.ts`): `state` is 43–128 URL-safe
//! base64 characters, the challenge exactly 43, an installation ID 16–128;
//! the verifier 43–128 characters of RFC 7636's alphabet. A request ID, a code
//! and a token are what its `randomValue()` makes: 32 random bytes in URL-safe
//! base64 without padding, exactly 43 characters.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// How many random bytes each secret Codeg makes holds.
const SECRET_BYTES: usize = 32;

/// The length of 32 bytes in URL-safe base64 without padding.
pub const OPAQUE_LEN: usize = 43;

/// Exactly what SpaceRing's `randomValue()` makes: 43 URL-safe base64
/// characters.
pub fn is_opaque(value: &str) -> bool {
    value.len() == OPAQUE_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Equality that takes as long whatever the first difference is. Lengths are
/// not secret: every value compared here has a fixed one.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

macro_rules! opaque_value {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq)]
        pub struct $name(String);

        impl $name {
            /// The value, where a request needs it.
            pub fn expose(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(concat!(stringify!($name), "([redacted])"))
            }
        }
    };
}

opaque_value!(
    /// A `state` or a PKCE `verifier`: 32 random bytes, as 43 URL-safe base64
    /// characters (which RFC 7636's verifier alphabet contains).
    FlowSecret
);

opaque_value!(
    /// The code the browser brings back.
    AuthCode
);

opaque_value!(
    /// The request ID of a login request: what the authorization page reads
    /// from its fragment.
    RequestId
);

opaque_value!(
    /// An SRN connection's Bearer token (`profile:read`).
    AccessToken
);

impl FlowSecret {
    /// A new one, from the operating system's random source.
    pub fn generate() -> Result<Self, rand::Error> {
        let mut bytes = [0u8; SECRET_BYTES];
        rand::rngs::OsRng.try_fill_bytes(&mut bytes)?;
        Ok(Self(URL_SAFE_NO_PAD.encode(bytes)))
    }

    /// The S256 challenge of this verifier: the URL-safe base64 of its
    /// SHA-256 (RFC 7636 §4.2).
    pub fn challenge(&self) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(self.0.as_bytes()))
    }

    /// Whether `candidate` is this value, in constant time.
    pub fn matches(&self, candidate: &str) -> bool {
        constant_time_eq(self.0.as_bytes(), candidate.as_bytes())
    }

    /// One Codeg made, read back from where it was kept (the Web sign-in
    /// keeps its verifier sealed in the database), or nothing.
    pub fn parse(raw: &str) -> Option<Self> {
        is_opaque(raw).then(|| Self(raw.to_string()))
    }
}

impl AuthCode {
    /// A code as SpaceRing makes them, or nothing.
    pub fn parse(raw: &str) -> Option<Self> {
        is_opaque(raw).then(|| Self(raw.to_string()))
    }
}

impl RequestId {
    pub fn parse(raw: &str) -> Option<Self> {
        is_opaque(raw).then(|| Self(raw.to_string()))
    }
}

impl AccessToken {
    /// A token as SpaceRing makes them (and as `/me` accepts them: a
    /// `Bearer` of exactly 43 such characters), or nothing.
    pub fn parse(raw: &str) -> Option<Self> {
        is_opaque(raw).then(|| Self(raw.to_string()))
    }
}

#[cfg(test)]
impl FlowSecret {
    /// A known value, for a test that has to name one.
    pub(crate) fn from_test_value(raw: &str) -> Self {
        Self(raw.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_rfc_7636_s256() {
        // RFC 7636, appendix B.
        let verifier = FlowSecret::from_test_value("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(
            verifier.challenge(),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_new_secret_is_32_random_bytes_in_url_safe_base64() {
        let one = FlowSecret::generate().unwrap();
        let two = FlowSecret::generate().unwrap();
        assert!(is_opaque(one.expose()), "{}", one.expose().len());
        assert_eq!(URL_SAFE_NO_PAD.decode(one.expose()).unwrap().len(), 32);
        assert_ne!(one, two);
        // the verifier alphabet of RFC 7636 holds it, and so does SpaceRing's
        assert!(one
            .expose()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b)));
        assert!(is_opaque(&one.challenge()));
    }

    #[test]
    fn nothing_secret_prints() {
        let secret = FlowSecret::generate().unwrap();
        let printed = format!("{secret:?}");
        assert!(!printed.contains(secret.expose()));
        assert_eq!(printed, "FlowSecret([redacted])");
        let token = AccessToken::parse(&"t".repeat(43)).unwrap();
        assert_eq!(format!("{token:?}"), "AccessToken([redacted])");
        let code = AuthCode::parse(&"c".repeat(43)).unwrap();
        assert!(!format!("{code:?}").contains("ccc"));
        let id = RequestId::parse(&"r".repeat(43)).unwrap();
        assert!(!format!("{id:?}").contains("rrr"));
    }

    #[test]
    fn opaque_values_are_exactly_43_url_safe_characters() {
        assert!(is_opaque(&"A".repeat(43)));
        assert!(is_opaque("abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE"));
        for bad in [
            "A".repeat(42),
            "A".repeat(44),
            format!("{}=", "A".repeat(42)),
            format!("{}+", "A".repeat(42)),
            format!("{}/", "A".repeat(42)),
            format!("{} ", "A".repeat(42)),
            format!("{}%", "A".repeat(42)),
            format!("{}é", "A".repeat(41)),
            String::new(),
        ] {
            assert!(!is_opaque(&bad), "{bad:?}");
            assert!(AuthCode::parse(&bad).is_none());
            assert!(AccessToken::parse(&bad).is_none());
        }
    }

    #[test]
    fn a_secret_matches_itself_only() {
        let secret = FlowSecret::generate().unwrap();
        assert!(secret.matches(secret.expose()));
        let mut other = secret.expose().to_string();
        other.replace_range(42..43, if other.ends_with('A') { "B" } else { "A" });
        assert!(!secret.matches(&other));
        assert!(!secret.matches(&secret.expose()[..42]));
        assert!(!secret.matches(""));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"a", b"b"));
    }
}
