//! Optional passphrase encryption for the snapshot payload.
//!
//! The feature's baseline security boundary is the user's own authenticated
//! WebDAV endpoint, and for a self-hosted share that is a real boundary. It is
//! a weaker one on a hosted drive, where the operator can read every file in
//! the account — and a config snapshot carries provider API keys. Turning
//! encryption on moves the trust boundary from "my storage provider" to "my
//! passphrase" without changing anything else about the protocol.
//!
//! ## Shape
//!
//! The envelope is JSON, not a binary header like
//! [`crate::commands::backup::crypto`]'s `.codegbak`. Three reasons: the remote
//! file keeps its `config.json` name and stays a JSON document a cloud drive's
//! web UI will preview; the import path can tell an encrypted payload from a
//! plaintext one by looking at the same parsed value it already reads the
//! export marker from; and the payload is tens of KB, so the streaming
//! construction that exists to keep gigabyte archives out of memory buys
//! nothing here. AES-256-GCM in one shot, Argon2id for the key.
//!
//! The header is cleartext because the salt and nonce must be readable before
//! the key can be derived. It needs no separate integrity check: every field in
//! it feeds either key derivation or the nonce, so tampering with any of them
//! produces a wrong key or a wrong nonce and the GCM tag fails — which is also
//! what tells a wrong passphrase from a right one. (`algo` and `kdf` are the
//! two that feed neither, and those are compared against fixed constants.)
//!
//! ## What the envelope does not bind
//!
//! No AAD, so the ciphertext is bound to nothing outside itself: not the remote
//! folder, not the profile, not the time it was written. A share operator can
//! therefore serve back an older copy of the same folder, or move the `work`
//! pair into `personal`, and it will decrypt and apply. That is deliberate, on
//! two grounds. It is not a regression — plaintext sync, the default, has
//! exactly the same exposure, because a snapshot has no notion of where it was
//! supposed to come from. And binding the profile would break the manual import
//! path, which decrypts a `config.json` the user copied off the share by hand
//! and cannot know which folder it came from.
//!
//! What encryption is claimed to buy is therefore narrow and worth stating
//! plainly: the operator cannot READ the snapshot, and cannot substitute one
//! they authored — only replay one of the user's own. Injecting attacker-chosen
//! provider endpoints and API keys is what it stops, and the other half of that
//! guarantee is in `open_after_download`, which refuses a manifest that claims
//! the payload is plaintext while the local switch says otherwise.

use std::collections::BTreeMap;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_error::{
    AppCommandError, CONFIG_SYNC_I18N_KEY_BAD_PASSPHRASE, CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT,
};

/// Marker + version of the encrypted envelope. Bump only for a change an older
/// binary cannot read.
pub const ENVELOPE_VERSION: u32 = 1;
/// The JSON key whose presence identifies an encrypted payload.
pub const ENVELOPE_MARKER: &str = "codegConfigEncryption";

const ALGO: &str = "AES-256-GCM";
const KDF: &str = "Argon2id";
const SALT_LEN: usize = 16;
/// GCM's standard nonce width. Random per encryption, never reused: every
/// upload re-encrypts from scratch rather than patching a stored ciphertext.
const NONCE_LEN: usize = 12;

// Argon2id cost. Matches the backup envelope: 64 MiB / 3 passes / 1 lane is an
// interactive cost that still meaningfully slows brute force on a snapshot
// someone pulled off a cloud drive.
const DEFAULT_M_COST: u32 = 64 * 1024;
const DEFAULT_T_COST: u32 = 3;
const DEFAULT_P_COST: u32 = 1;

// Bounds on the attacker-controlled header, so a hostile file cannot drive an
// unbounded Argon2 before the tag check gets a chance to fail. Same envelope
// the product ever emits, with headroom; widen only alongside a version bump.
const MAX_M_COST: u32 = 256 * 1024; // KiB
const MAX_T_COST: u32 = 10;
const MAX_P_COST: u32 = 4;
const MAX_SALT_LEN: usize = 64;
const MIN_SALT_LEN: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    /// Argon2 version constant: `0x13` (19) for the modern V0x13.
    pub version: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m_cost: DEFAULT_M_COST,
            t_cost: DEFAULT_T_COST,
            p_cost: DEFAULT_P_COST,
            version: 0x13,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedPayload {
    /// Named to match [`ENVELOPE_MARKER`] after `rename_all`.
    pub codeg_config_encryption: u32,
    pub algo: String,
    pub kdf: String,
    pub kdf_params: KdfParams,
    pub salt_b64: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

/// Cheap enough to run on every parsed import: looks at one key of a value the
/// caller has already deserialized.
pub fn is_encrypted_value(value: &Value) -> bool {
    value.get(ENVELOPE_MARKER).is_some()
}

fn invalid(message: &str) -> AppCommandError {
    AppCommandError::invalid_input(message)
        .with_i18n(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT, BTreeMap::new())
}

/// A wrong passphrase and a corrupted ciphertext are the same GCM tag failure,
/// and telling them apart is not possible by design. The message names the
/// likely cause without claiming to know.
pub fn bad_passphrase_error() -> AppCommandError {
    AppCommandError::invalid_input("The snapshot could not be decrypted with the stored passphrase")
        .with_i18n(CONFIG_SYNC_I18N_KEY_BAD_PASSPHRASE, BTreeMap::new())
}

fn derive_key(passphrase: &str, salt: &[u8], params: &KdfParams) -> Result<[u8; 32], AppCommandError> {
    let p = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(32)).map_err(|e| {
        AppCommandError::task_execution_failed("Invalid KDF parameters").with_detail(e.to_string())
    })?;
    let version = if params.version == 0x10 {
        Version::V0x10
    } else {
        Version::V0x13
    };
    let argon2 = Argon2::new(Algorithm::Argon2id, version, p);
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| {
            AppCommandError::task_execution_failed("Key derivation failed").with_detail(e.to_string())
        })?;
    Ok(key)
}

/// Wrap `plain` in an encrypted envelope. Synchronous and CPU-bound for the
/// duration of one Argon2 derivation (~100 ms); callers on an async path hop to
/// a blocking thread.
pub fn encrypt(plain: &[u8], passphrase: &str) -> Result<Vec<u8>, AppCommandError> {
    if passphrase.is_empty() {
        return Err(passphrase_required_error());
    }
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    let kdf_params = KdfParams::default();
    let key = derive_key(passphrase, &salt, &kdf_params)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain)
        .map_err(|_| AppCommandError::task_execution_failed("Failed to encrypt the snapshot"))?;

    let payload = EncryptedPayload {
        codeg_config_encryption: ENVELOPE_VERSION,
        algo: ALGO.to_string(),
        kdf: KDF.to_string(),
        kdf_params,
        salt_b64: B64.encode(salt),
        nonce_b64: B64.encode(nonce_bytes),
        ciphertext_b64: B64.encode(&ciphertext),
    };
    serde_json::to_vec_pretty(&payload).map_err(|e| {
        AppCommandError::task_execution_failed("Serialize encrypted snapshot")
            .with_detail(e.to_string())
    })
}

pub fn passphrase_required_error() -> AppCommandError {
    AppCommandError::invalid_input("This snapshot is encrypted and no passphrase is configured")
        .with_i18n(
            crate::app_error::CONFIG_SYNC_I18N_KEY_PASSPHRASE_REQUIRED,
            BTreeMap::new(),
        )
}

/// Unwrap an envelope produced by [`encrypt`].
pub fn decrypt(payload: &EncryptedPayload, passphrase: &str) -> Result<Vec<u8>, AppCommandError> {
    if payload.codeg_config_encryption > ENVELOPE_VERSION {
        return Err(invalid("Encrypted snapshot uses a newer envelope format"));
    }
    if !payload.algo.eq_ignore_ascii_case(ALGO) || !payload.kdf.eq_ignore_ascii_case(KDF) {
        return Err(invalid("Encrypted snapshot uses an unsupported algorithm"));
    }
    if passphrase.is_empty() {
        return Err(passphrase_required_error());
    }

    let params = &payload.kdf_params;
    if params.m_cost > MAX_M_COST || params.t_cost > MAX_T_COST || params.p_cost > MAX_P_COST {
        return Err(invalid("Encrypted snapshot asks for an unsupported KDF cost"));
    }

    let salt = B64
        .decode(payload.salt_b64.as_bytes())
        .map_err(|_| invalid("Encrypted snapshot has a malformed salt"))?;
    if !(MIN_SALT_LEN..=MAX_SALT_LEN).contains(&salt.len()) {
        return Err(invalid("Encrypted snapshot has a malformed salt"));
    }
    let nonce = B64
        .decode(payload.nonce_b64.as_bytes())
        .map_err(|_| invalid("Encrypted snapshot has a malformed nonce"))?;
    if nonce.len() != NONCE_LEN {
        return Err(invalid("Encrypted snapshot has a malformed nonce"));
    }
    let ciphertext = B64
        .decode(payload.ciphertext_b64.as_bytes())
        .map_err(|_| invalid("Encrypted snapshot has a malformed payload"))?;

    let key = derive_key(passphrase, &salt, params)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| bad_passphrase_error())
}

/// Parse an envelope out of an already-deserialized value.
pub fn parse_envelope(value: Value) -> Result<EncryptedPayload, AppCommandError> {
    serde_json::from_value(value)
        .map_err(|e| invalid("Malformed encrypted snapshot").with_detail(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cheap Argon2 settings: these tests exercise the envelope, not the KDF,
    /// and the default 64 MiB cost would dominate the suite's runtime.
    fn cheap(payload: &mut EncryptedPayload) {
        payload.kdf_params = KdfParams {
            m_cost: 8,
            t_cost: 1,
            p_cost: 1,
            version: 0x13,
        };
    }

    /// Re-encrypt `plain` under the cheap parameters so the round-trip tests
    /// do not each pay a 64 MiB derivation.
    fn seal(plain: &[u8], passphrase: &str) -> EncryptedPayload {
        let mut salt = [0u8; SALT_LEN];
        let mut nonce = [0u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let mut payload = EncryptedPayload {
            codeg_config_encryption: ENVELOPE_VERSION,
            algo: ALGO.to_string(),
            kdf: KDF.to_string(),
            kdf_params: KdfParams::default(),
            salt_b64: B64.encode(salt),
            nonce_b64: B64.encode(nonce),
            ciphertext_b64: String::new(),
        };
        cheap(&mut payload);
        let key = derive_key(passphrase, &salt, &payload.kdf_params).expect("derive");
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), plain)
            .expect("encrypt");
        payload.ciphertext_b64 = B64.encode(&ct);
        payload
    }

    #[test]
    fn a_snapshot_round_trips_through_the_envelope() {
        let plain = br#"{"schemaVersion":1,"domains":{}}"#;
        let payload = seal(plain, "correct horse");
        assert_eq!(decrypt(&payload, "correct horse").expect("decrypt"), plain);
    }

    #[test]
    fn the_envelope_never_contains_the_plaintext() {
        let plain = b"sk-super-secret-api-key";
        let bytes = serde_json::to_vec(&seal(plain, "pw")).expect("bytes");
        let text = String::from_utf8(bytes).expect("utf8");
        assert!(
            !text.contains("sk-super-secret-api-key"),
            "plaintext leaked into the envelope: {text}"
        );
        // And it is still JSON with the marker the import path branches on.
        let value: Value = serde_json::from_str(&text).expect("json");
        assert!(is_encrypted_value(&value));
        assert!(!is_encrypted_value(&serde_json::json!({"schemaVersion": 1})));
    }

    #[test]
    fn a_wrong_passphrase_is_refused_rather_than_misparsed() {
        let payload = seal(b"payload", "right");
        let err = decrypt(&payload, "wrong").expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(CONFIG_SYNC_I18N_KEY_BAD_PASSPHRASE)
        );
    }

    /// Every header field feeds the key or the nonce, so flipping one must fail
    /// the tag — this is what stands in for a separate header MAC.
    #[test]
    fn tampering_with_the_cleartext_header_fails_the_tag() {
        let original = seal(b"payload", "pw");

        let mut swapped_salt = original.clone();
        swapped_salt.salt_b64 = B64.encode([7u8; SALT_LEN]);
        assert!(decrypt(&swapped_salt, "pw").is_err());

        let mut swapped_nonce = original.clone();
        swapped_nonce.nonce_b64 = B64.encode([7u8; NONCE_LEN]);
        assert!(decrypt(&swapped_nonce, "pw").is_err());

        let mut bumped_cost = original.clone();
        bumped_cost.kdf_params.t_cost += 1;
        assert!(decrypt(&bumped_cost, "pw").is_err());

        let mut flipped = original;
        let mut ct = B64.decode(flipped.ciphertext_b64.as_bytes()).expect("decode");
        ct[0] ^= 0xff;
        flipped.ciphertext_b64 = B64.encode(&ct);
        assert!(decrypt(&flipped, "pw").is_err());
    }

    /// A hostile file must not be able to make us burn gigabytes of RAM on
    /// Argon2 before the tag it cannot forge gets a chance to fail.
    #[test]
    fn an_absurd_kdf_cost_is_rejected_before_any_work_is_done() {
        let mut payload = seal(b"payload", "pw");
        payload.kdf_params.m_cost = MAX_M_COST + 1;
        assert!(decrypt(&payload, "pw").is_err());

        let mut payload = seal(b"payload", "pw");
        payload.kdf_params.t_cost = MAX_T_COST + 1;
        assert!(decrypt(&payload, "pw").is_err());
    }

    #[test]
    fn a_newer_envelope_is_refused_rather_than_guessed_at() {
        let mut payload = seal(b"payload", "pw");
        payload.codeg_config_encryption = ENVELOPE_VERSION + 1;
        let err = decrypt(&payload, "pw").expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT)
        );
    }

    #[test]
    fn an_empty_passphrase_is_a_configuration_error_not_a_decrypt_failure() {
        let payload = seal(b"payload", "pw");
        let err = decrypt(&payload, "").expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(crate::app_error::CONFIG_SYNC_I18N_KEY_PASSPHRASE_REQUIRED)
        );
        assert!(encrypt(b"payload", "").is_err());
    }

    /// The expensive one, run once: the shipped defaults have to actually work
    /// end to end, not just the cheap parameters the other tests use.
    #[test]
    fn the_shipped_parameters_round_trip() {
        let bytes = encrypt(b"real defaults", "passphrase").expect("encrypt");
        let value: Value = serde_json::from_slice(&bytes).expect("json");
        assert!(is_encrypted_value(&value));
        let payload = parse_envelope(value).expect("parse");
        assert_eq!(payload.kdf_params.m_cost, DEFAULT_M_COST);
        assert_eq!(
            decrypt(&payload, "passphrase").expect("decrypt"),
            b"real defaults"
        );
    }
}
