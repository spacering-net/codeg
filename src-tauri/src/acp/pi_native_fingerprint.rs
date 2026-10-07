//! Pi-native config files that belong in the session config fingerprint.
//!
//! Kept out of `commands/acp.rs` so fork-specific Pi staleness logic does not
//! keep growing that upstream hotspot and inflate merge-tree conflict surface.

use std::fs;
use std::path::Path;

use sha2::Digest;

/// Filenames Pi reads at process start for provider/model registry and
/// credentials. Changes here must mark running Pi sessions restart-required.
pub(crate) const PI_NATIVE_FINGERPRINT_FILES: &[&str] =
    &["settings.json", "auth.json", "models.json"];

/// Hash Pi's native config directory into `hasher`.
///
/// Raw bytes (plus an explicit missing-file marker) rather than parsed JSON so
/// additions/removals and custom fields are tracked while secrets never appear
/// in the fingerprint string itself — only in the digest input.
pub(crate) fn hash_pi_native_dir_into(hasher: &mut impl Digest, pi_dir: &Path) {
    for file in PI_NATIVE_FINGERPRINT_FILES {
        hasher.update(b"\x01pi_native_file\x01");
        hasher.update(file.as_bytes());
        hasher.update([0u8]);
        match fs::read(pi_dir.join(file)) {
            Ok(raw) => {
                hasher.update([1u8]);
                hasher.update(raw);
            }
            Err(_) => hasher.update([0u8]),
        }
        hasher.update([0u8]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Sha256;

    fn digest_hex(pi_dir: &Path) -> String {
        let mut hasher = Sha256::new();
        hash_pi_native_dir_into(&mut hasher, pi_dir);
        format!("{:x}", hasher.finalize())
    }

    #[test]
    fn hash_changes_when_models_or_settings_appear() {
        let dir = tempfile::tempdir().expect("tempdir");
        let empty = digest_hex(dir.path());

        std::fs::write(
            dir.path().join("models.json"),
            r#"{"providers":{"tokenkey":{"models":[{"id":"gpt-6"}]}}}"#,
        )
        .expect("write models");
        let with_models = digest_hex(dir.path());
        assert_ne!(empty, with_models);

        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"defaultProvider":"tokenkey","defaultModel":"gpt-6"}"#,
        )
        .expect("write settings");
        let with_settings = digest_hex(dir.path());
        assert_ne!(with_models, with_settings);
    }

    #[test]
    fn missing_and_present_files_differ() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = digest_hex(dir.path());
        std::fs::write(dir.path().join("auth.json"), r#"{"tokenkey":{"type":"api_key"}}"#)
            .expect("write auth");
        assert_ne!(missing, digest_hex(dir.path()));
    }
}
