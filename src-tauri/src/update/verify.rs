//! Minisign signature verification for downloaded release archives.
//!
//! The release pipeline signs each server tarball/zip with the **same**
//! minisign key the desktop updater uses (`tauri signer sign`), producing a
//! detached `<asset>.sig`. We verify that signature against the public key
//! embedded below before extracting or installing anything — executing a
//! downloaded binary without verifying its provenance would be the whole
//! ballgame for an attacker.
//!
//! Wire format note: both the public key (from `tauri.conf.json`) and the
//! `.sig` produced by `tauri signer sign` are **base64 of a minisign text
//! file**. We base64-decode that outer wrapper, then hand the inner
//! minisign text to `minisign-verify`.
//!
//! A valid signature is not the whole check: the archive must also have been
//! signed for the version the manifest offers (see [`verify_signed_version`]).

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

use crate::update::version::trim_v_prefix;

/// Tauri-format minisign public key — copied verbatim from
/// `tauri.conf.json` `plugins.updater.pubkey`. Base64 of the two-line
/// `minisign.pub` file (`untrusted comment:` + `RW…` key line).
const TAURI_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ4OEM3NkMyMTVENjdBODgKUldTSWV0WVZ3bmFNU0NnSzhpdFg2bXFmMHFidWd1eWpuZ2Y2WmU5QmVXdWVrU0ZpOCt2dnd6WW4K";

/// Decode an outer base64 wrapper into the inner minisign text file.
fn unwrap_base64(b64: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("invalid utf-8 in minisign text: {e}"))
}

/// Build a [`PublicKey`] from a two-line minisign `.pub` text (or just the
/// bare `RW…` key line).
fn parse_public_key(minisign_pub_text: &str) -> Result<PublicKey, String> {
    let key_line = minisign_pub_text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("untrusted comment:"))
        .ok_or_else(|| "minisign public key text has no key line".to_string())?;
    PublicKey::from_base64(key_line)
        .map_err(|e| format!("failed to parse minisign public key: {e}"))
}

/// The embedded release-signing public key.
fn embedded_public_key() -> Result<PublicKey, String> {
    parse_public_key(&unwrap_base64(TAURI_PUBKEY_B64)?)
}

/// Verify `data` against a minisign signature text (the `.minisig` file
/// contents) using an explicit public key, and that it was signed for
/// `version`. Testable core — production code goes through
/// [`verify_release_signature`].
pub fn verify_minisign(
    public_key: &PublicKey,
    data: &[u8],
    minisig_text: &str,
    version: &str,
) -> Result<(), String> {
    let signature =
        Signature::decode(minisig_text).map_err(|e| format!("failed to parse signature: {e}"))?;
    // `allow_legacy = true` to match tauri-plugin-updater's own
    // `verify_signature` (it passes `true`). `tauri signer sign` can emit
    // legacy-format signatures; with `false` we would reject valid release
    // signatures. `true` is a strict superset — a valid signature from our
    // key is still required.
    public_key
        .verify(data, &signature, true)
        .map_err(|e| format!("signature verification failed: {e}"))?;
    // Only now can the trusted comment be believed: it is covered by the
    // global signature, which is what `verify` has just checked.
    verify_signed_version(signature.trusted_comment(), version)
}

/// Check the version an archive was signed for against `announced`, the
/// version the manifest offers.
///
/// The manifest is not signed, and the archive is downloaded apart from it,
/// so neither says on its own which release the archive belongs to. The
/// release workflow signs every server archive with `--app-version`, which
/// writes the version into the signature's trusted comment as
/// `version:<v>`; it has to be the one announced. Otherwise a tampered
/// manifest could pass an older signed release off as the latest — and an
/// archive that names no version is refused for the same reason, as every
/// release signed before the workflow named one would be such a release. The
/// desktop updater makes the same check, under `requireSignedVersion`.
fn verify_signed_version(trusted_comment: &str, announced: &str) -> Result<(), String> {
    let signed = trusted_comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .ok_or_else(|| "the signature does not name the version it was made for".to_string())?;
    // As semver, the way the desktop updater compares them, so `1.2.3` and
    // `v1.2.3` match; literally when either one is not semver.
    let matches = match (
        semver::Version::parse(trim_v_prefix(signed)),
        semver::Version::parse(trim_v_prefix(announced)),
    ) {
        (Ok(signed), Ok(announced)) => signed == announced,
        _ => signed == announced,
    };
    if matches {
        Ok(())
    } else {
        Err(format!(
            "the signature was made for version {signed}, not {announced}"
        ))
    }
}

/// Verify `data` against a Tauri-format `.sig` (base64 of a `.minisig`)
/// using the embedded release-signing public key. Returns `Ok(())` only if
/// the signature is valid and was made for `version`.
pub fn verify_release_signature(
    data: &[u8],
    tauri_sig_b64: &str,
    version: &str,
) -> Result<(), String> {
    let public_key = embedded_public_key()?;
    let minisig_text = unwrap_base64(tauri_sig_b64)?;
    verify_minisign(&public_key, data, &minisig_text, version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_pubkey_parses() {
        // The const baked from tauri.conf.json must always decode to a
        // usable key — a bad paste would silently disable verification.
        embedded_public_key().expect("embedded pubkey should parse");
    }

    #[test]
    fn bare_key_line_parses() {
        let text = "untrusted comment: minisign public key: 488C76C215D67A88\n\
                    RWSIetYVwnaMSCgK8itX6mqf0qbuguyjngf6Ze9BeWuekSFi8+vvwzYn\n";
        parse_public_key(text).expect("two-line pub text should parse");
    }

    #[test]
    fn garbage_signature_is_rejected() {
        let pk = embedded_public_key().unwrap();
        let err = verify_minisign(&pk, b"hello", "not a signature", "1.2.3").unwrap_err();
        assert!(err.contains("parse") || err.contains("signature"));
    }

    #[test]
    fn non_base64_sig_wrapper_is_rejected() {
        assert!(verify_release_signature(b"data", "%%% not base64 %%%", "1.2.3").is_err());
    }

    // Made with a throwaway key by the Tauri CLI the release workflow uses:
    // `tauri signer sign [--app-version 1.2.3]` over `PAYLOAD`.
    const TEST_PUBKEY: &str = "untrusted comment: minisign public key: A79AF58C1271B5FA\n\
        RWT6tXESjPWap6H6d3WSjNHFG4qB37Na10QmYP2+TN5DghQqBI2iIYzg\n";
    const PAYLOAD: &[u8] = b"codeg release payload";
    const SIGNED_FOR_1_2_3: &str = "untrusted comment: signature from tauri secret key\n\
        RUT6tXESjPWap9e0BMiOsY2EtpW0O59HcNiDZ1LR1PT/T28QTZFOL25XM3JTHRifgZxesxUmVgD5AoXc+QPOTKiVllA1HDmiwQc=\n\
        trusted comment: timestamp:1792063972\tfile:codeg-server-x86_64-unknown-linux-gnu.tar.gz\tversion:1.2.3\n\
        z3vufMYf/CuVl47mBcYK/Q9g4B7YdXxoDSronvaM0/sVycxIhy3xYja5ZpEfx4IKUo8IyGzlMUpYuS8BY0NDBg==\n";
    const SIGNED_FOR_NO_VERSION: &str = "untrusted comment: signature from tauri secret key\n\
        RUT6tXESjPWapxohXyYsHgc5hjgoHYZAnpt+HWB8vOWwEeU/RZJvg8nzTt3At6MQPIdAC2/B3ZKlDvymtXcdoK/v+HZw3zYxgA4=\n\
        trusted comment: timestamp:1792063972\tfile:codeg-server-x86_64-unknown-linux-gnu.tar.gz\n\
        MfCKBGgrJEzgiR5HKWQdatdyrplwU57s+UJWo/1rxlJRyTzxqd7fpVLAsdfesEj0kICi2Hx1cgNNjgPIlUAACQ==\n";

    fn test_key() -> PublicKey {
        parse_public_key(TEST_PUBKEY).unwrap()
    }

    #[test]
    fn an_archive_signed_for_the_announced_version_is_accepted() {
        verify_minisign(&test_key(), PAYLOAD, SIGNED_FOR_1_2_3, "1.2.3").unwrap();
        verify_minisign(&test_key(), PAYLOAD, SIGNED_FOR_1_2_3, "v1.2.3").unwrap();
    }

    #[test]
    fn an_archive_signed_for_another_version_is_refused() {
        let err = verify_minisign(&test_key(), PAYLOAD, SIGNED_FOR_1_2_3, "1.2.4").unwrap_err();
        assert!(err.contains("1.2.3") && err.contains("1.2.4"), "{err}");
    }

    #[test]
    fn an_archive_signed_for_no_version_is_refused() {
        let err =
            verify_minisign(&test_key(), PAYLOAD, SIGNED_FOR_NO_VERSION, "1.2.3").unwrap_err();
        assert!(err.contains("version"), "{err}");
    }

    #[test]
    fn the_signed_version_cannot_be_rewritten() {
        let edited = SIGNED_FOR_1_2_3.replace("version:1.2.3", "version:1.2.4");
        let err = verify_minisign(&test_key(), PAYLOAD, &edited, "1.2.4").unwrap_err();
        assert!(err.contains("signature verification failed"), "{err}");
    }

    #[test]
    fn the_version_still_has_to_sign_the_bytes() {
        assert!(
            verify_minisign(&test_key(), b"another archive", SIGNED_FOR_1_2_3, "1.2.3").is_err()
        );
    }

    #[test]
    fn signed_versions_compare_as_semver_and_literally_otherwise() {
        let comment = |version: &str| format!("timestamp:1\tfile:a.tar.gz\tversion:{version}");
        assert!(verify_signed_version(&comment("v1.2.3"), "1.2.3").is_ok());
        assert!(verify_signed_version(&comment("1.2.3-rc.1"), "1.2.3").is_err());
        assert!(verify_signed_version(&comment("nightly"), "nightly").is_ok());
        assert!(verify_signed_version(&comment("nightly"), "nightly-2").is_err());
        assert!(verify_signed_version("timestamp:1\tfile:a.tar.gz", "1.2.3").is_err());
        assert!(verify_signed_version("timestamp:1\tsubversion:1.2.3", "1.2.3").is_err());
    }

    /// The release workflow has to sign every server archive for its version:
    /// one signed without `--app-version` names none, and every server would
    /// refuse to update to it.
    #[test]
    fn the_release_workflow_signs_server_archives_for_their_version() {
        let workflow = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../.github/workflows/release.yml"
        ))
        .unwrap();
        let signs: Vec<&str> = workflow
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("pnpm tauri signer sign"))
            .collect();
        assert_eq!(signs.len(), 2, "the Unix and the Windows archive");
        for line in signs {
            assert!(line.contains("--app-version"), "{line}");
        }
    }
}
