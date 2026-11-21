//! Sealing what Codeg Web's sign-in keeps in `codeg.db`: the SRN token, the
//! PKCE verifier and the request ID. AES-256-GCM, a random 96-bit nonce per
//! value, and associated data naming what the value is and which row it
//! belongs to, so a sealed value moved to another row or column does not
//! open.
//!
//! The key is made on first use and kept outside the database — and outside
//! Codeg's backup, which carries `codeg.db` and `tokens.json`:
//!
//! - **codeg-server**: [`KEY_FILE_NAME`] in the data directory, mode 0600,
//!   written to a temporary file first and then moved into place (never over
//!   an existing key). The backup takes files by allowlist
//!   (`commands::backup::sections`), and this file is not on it.
//! - **the desktop app's embedded web service**: the keychain's named secret
//!   [`KEYCHAIN_SECRET_NAME`] (never `tokens.json`).
//!
//! A database restored where the key is not (another machine, a lost key)
//! holds values nothing here opens: those rows count as signed out and are
//! removed by the caller. A key that cannot be *read* right now (a locked
//! keychain, a file that will not open) is not a lost key: nothing is
//! removed and nothing is made over it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use rand::RngCore;

/// The key file of codeg-server, in its data directory.
pub const KEY_FILE_NAME: &str = "srn-web.key";

/// The keychain entry of the desktop app's embedded web service (a named
/// secret, `keyring_store`).
pub const KEYCHAIN_SECRET_NAME: &str = "srn-web-key";

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const SEALED_PREFIX: &str = "v1.";

/// What a sealed value is, part of its associated data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// A session's SRN token; bound to the session cookie's hash.
    Token,
    /// A pending sign-in's PKCE verifier; bound to the state's hash.
    Verifier,
    /// A pending sign-in's request ID; bound to the state's hash.
    RequestId,
}

impl Purpose {
    fn label(self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::Verifier => "verifier",
            Self::RequestId => "request-id",
        }
    }
}

/// Where the key lives.
#[derive(Clone)]
pub enum KeySource {
    /// A file (codeg-server: `<data dir>/srn-web.key`).
    File(PathBuf),
    /// The keychain (the desktop app's embedded web service).
    #[cfg(feature = "tauri-runtime")]
    Keychain,
    /// Memory, for tests: the stored text, and whether reading fails.
    #[cfg(test)]
    Memory(Arc<std::sync::Mutex<MemoryKey>>),
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct MemoryKey {
    pub stored: Option<String>,
    pub unreadable: bool,
}

impl KeySource {
    pub fn server_file(data_dir: &Path) -> Self {
        Self::File(data_dir.join(KEY_FILE_NAME))
    }
}

/// The key, once loaded.
pub struct SealKey(Aes256Gcm);

impl std::fmt::Debug for SealKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SealKey([redacted])")
    }
}

impl SealKey {
    fn from_bytes(bytes: &[u8; KEY_BYTES]) -> Self {
        Self(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(bytes)))
    }

    /// `v1.` + URL-safe base64 of nonce and ciphertext.
    pub fn seal(&self, purpose: Purpose, binding: &str, plaintext: &str) -> Result<String, String> {
        let mut nonce = [0u8; NONCE_BYTES];
        rand::rngs::OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|error| format!("no random bytes: {error}"))?;
        let aad = associated_data(purpose, binding);
        let sealed = self
            .0
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| "the value could not be sealed".to_string())?;
        let mut out = Vec::with_capacity(NONCE_BYTES + sealed.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        Ok(format!("{SEALED_PREFIX}{}", URL_SAFE_NO_PAD.encode(out)))
    }

    /// The value, or `None` when it does not open with this key for this
    /// purpose and row: sealed under another key, moved, or damaged.
    pub fn open(&self, purpose: Purpose, binding: &str, sealed: &str) -> Option<String> {
        let raw = URL_SAFE_NO_PAD
            .decode(sealed.strip_prefix(SEALED_PREFIX)?)
            .ok()?;
        if raw.len() <= NONCE_BYTES {
            return None;
        }
        let (nonce, ciphertext) = raw.split_at(NONCE_BYTES);
        let aad = associated_data(purpose, binding);
        let plain = self
            .0
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .ok()?;
        String::from_utf8(plain).ok()
    }
}

fn associated_data(purpose: Purpose, binding: &str) -> String {
    format!("codeg-srn-web/v1/{}/{binding}", purpose.label())
}

/// The key of one source, loaded (or made) on first use and kept for the
/// life of the process. A failure is not kept: the next use tries again.
pub struct Sealer {
    source: KeySource,
    key: tokio::sync::Mutex<Option<Arc<SealKey>>>,
}

impl Sealer {
    pub fn new(source: KeySource) -> Self {
        Self {
            source,
            key: tokio::sync::Mutex::new(None),
        }
    }

    /// The key; made and stored first if there is none yet. `Err` is "the
    /// store would not give one", with its own account (never key material).
    pub async fn key(&self) -> Result<Arc<SealKey>, String> {
        let mut slot = self.key.lock().await;
        if let Some(key) = slot.as_ref() {
            return Ok(Arc::clone(key));
        }
        let source = self.source.clone();
        let bytes = tokio::task::spawn_blocking(move || load_or_make(&source))
            .await
            .map_err(|error| format!("the key task did not run: {error}"))??;
        let key = Arc::new(SealKey::from_bytes(&bytes));
        *slot = Some(Arc::clone(&key));
        Ok(key)
    }
}

fn load_or_make(source: &KeySource) -> Result<[u8; KEY_BYTES], String> {
    match source {
        KeySource::File(path) => file::load_or_make(path),
        #[cfg(feature = "tauri-runtime")]
        KeySource::Keychain => keychain_load_or_make(),
        #[cfg(test)]
        KeySource::Memory(memory) => {
            let mut memory = memory.lock().unwrap();
            if memory.unreadable {
                return Err("the test store is unreadable".into());
            }
            match memory.stored.as_deref() {
                Some(text) => decode_key(text),
                None => {
                    let key = new_key()?;
                    memory.stored = Some(encode_key(&key));
                    Ok(key)
                }
            }
        }
    }
}

fn new_key() -> Result<[u8; KEY_BYTES], String> {
    let mut key = [0u8; KEY_BYTES];
    rand::rngs::OsRng
        .try_fill_bytes(&mut key)
        .map_err(|error| format!("no random bytes: {error}"))?;
    Ok(key)
}

fn encode_key(key: &[u8; KEY_BYTES]) -> String {
    STANDARD.encode(key)
}

fn decode_key(text: &str) -> Result<[u8; KEY_BYTES], String> {
    STANDARD
        .decode(text.trim())
        .ok()
        .and_then(|bytes| <[u8; KEY_BYTES]>::try_from(bytes.as_slice()).ok())
        .ok_or_else(|| "what is stored is not a key Codeg wrote".to_string())
}

#[cfg(feature = "tauri-runtime")]
fn keychain_load_or_make() -> Result<[u8; KEY_BYTES], String> {
    match crate::keyring_store::get_secret(KEYCHAIN_SECRET_NAME)? {
        Some(text) => decode_key(&text).map_err(|reason| format!("keychain entry: {reason}")),
        None => {
            let key = new_key()?;
            crate::keyring_store::set_secret(KEYCHAIN_SECRET_NAME, &encode_key(&key))?;
            Ok(key)
        }
    }
}

mod file {
    use std::io::Write;
    use std::path::Path;

    use super::{decode_key, encode_key, new_key, KEY_BYTES};

    /// The key in `path`, or a new one written there if there is no file.
    /// A file that is there but will not open or does not hold a key is an
    /// error: it is never overwritten.
    pub fn load_or_make(path: &Path) -> Result<[u8; KEY_BYTES], String> {
        if let Some(key) = read(path)? {
            return Ok(key);
        }
        let key = new_key()?;
        match write_new(path, &key) {
            Ok(()) => Ok(key),
            // Made meanwhile by someone else: theirs is the key.
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                read(path)?.ok_or_else(|| format!("{} vanished as it was made", path.display()))
            }
            Err(error) => Err(format!("{} could not be written: {error}", path.display())),
        }
    }

    fn read(path: &Path) -> Result<Option<[u8; KEY_BYTES]>, String> {
        #[cfg(unix)]
        tighten(path);
        match std::fs::read_to_string(path) {
            Ok(text) => decode_key(&text)
                .map(Some)
                .map_err(|reason| format!("{}: {reason}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("{} could not be read: {error}", path.display())),
        }
    }

    /// A key file wider than 0600 (copied by hand, restored from somewhere)
    /// is narrowed before it is read, as `tokens.json` is.
    #[cfg(unix)]
    fn tighten(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let Ok(meta) = std::fs::metadata(path) else {
            return;
        };
        if meta.permissions().mode() & 0o077 == 0 {
            return;
        }
        if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!(
                "[srn-web] could not narrow {} to 0600: {error}",
                path.display()
            );
        }
    }

    /// Into a temporary file beside it, mode 0600 from its first byte,
    /// flushed to disk, then moved into place — but never over a file that
    /// is already there.
    fn write_new(path: &Path, key: &[u8; KEY_BYTES]) -> std::io::Result<()> {
        let dir = path
            .parent()
            .ok_or_else(|| std::io::Error::other("the key file has no directory"))?;
        std::fs::create_dir_all(dir)?;
        let mut temp = tempfile::Builder::new()
            .prefix(".srn-web.key.")
            .tempfile_in(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temp.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        temp.write_all(format!("{}\n", encode_key(key)).as_bytes())?;
        temp.as_file().sync_all()?;
        temp.persist_noclobber(path).map_err(|error| error.error)?;
        #[cfg(unix)]
        if let Ok(dir) = std::fs::File::open(dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_value_opens_with_its_key_its_purpose_and_its_row_only() {
        let sealer = Sealer::new(KeySource::Memory(Arc::default()));
        let key = sealer.key().await.unwrap();
        let sealed = key.seal(Purpose::Token, "row-a", "the-token").unwrap();
        assert!(sealed.starts_with("v1."));
        assert!(!sealed.contains("the-token"));
        assert_eq!(
            key.open(Purpose::Token, "row-a", &sealed).as_deref(),
            Some("the-token")
        );
        assert_eq!(key.open(Purpose::Token, "row-b", &sealed), None);
        assert_eq!(key.open(Purpose::Verifier, "row-a", &sealed), None);
        // a nonce of its own each time
        assert_ne!(
            sealed,
            key.seal(Purpose::Token, "row-a", "the-token").unwrap()
        );
        // another key
        let other = Sealer::new(KeySource::Memory(Arc::default()))
            .key()
            .await
            .unwrap();
        assert_eq!(other.open(Purpose::Token, "row-a", &sealed), None);
        // damaged
        let mut damaged = sealed.clone();
        let last = damaged.pop().unwrap();
        damaged.push(if last == 'A' { 'B' } else { 'A' });
        assert_eq!(key.open(Purpose::Token, "row-a", &damaged), None);
        for junk in ["", "v1.", "v1.AAAA", "v2.xyz", "plain-token"] {
            assert_eq!(key.open(Purpose::Token, "row-a", junk), None, "{junk}");
        }
        assert_eq!(format!("{key:?}"), "SealKey([redacted])");
    }

    #[tokio::test]
    async fn the_key_is_made_once_and_kept() {
        let memory: Arc<std::sync::Mutex<MemoryKey>> = Arc::default();
        let sealer = Sealer::new(KeySource::Memory(memory.clone()));
        let sealed = sealer
            .key()
            .await
            .unwrap()
            .seal(Purpose::Token, "r", "v")
            .unwrap();
        let stored = memory.lock().unwrap().stored.clone().unwrap();
        // a second process reads the same key
        let again = Sealer::new(KeySource::Memory(Arc::new(std::sync::Mutex::new(
            MemoryKey {
                stored: Some(stored),
                unreadable: false,
            },
        ))));
        assert_eq!(
            again
                .key()
                .await
                .unwrap()
                .open(Purpose::Token, "r", &sealed)
                .as_deref(),
            Some("v")
        );
    }

    #[tokio::test]
    async fn a_store_that_will_not_open_is_not_a_missing_key() {
        let memory = Arc::new(std::sync::Mutex::new(MemoryKey {
            stored: None,
            unreadable: true,
        }));
        let sealer = Sealer::new(KeySource::Memory(memory.clone()));
        assert!(sealer.key().await.is_err());
        // nothing was made over it, and the next use tries again
        assert!(memory.lock().unwrap().stored.is_none());
        memory.lock().unwrap().unreadable = false;
        assert!(sealer.key().await.is_ok());
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn the_server_key_file_is_0600_and_made_once() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let source = KeySource::server_file(&data);
        let path = data.join(KEY_FILE_NAME);
        let key = Sealer::new(source.clone()).key().await.unwrap();
        assert!(path.is_file());
        #[cfg(unix)]
        assert_eq!(mode(&path), 0o600);
        let written = std::fs::read_to_string(&path).unwrap();
        // nothing but the key was left behind
        let names: Vec<String> = std::fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec![KEY_FILE_NAME.to_string()]);

        // a restart reads it back rather than making another
        let sealed = key.seal(Purpose::Token, "r", "v").unwrap();
        let again = Sealer::new(source).key().await.unwrap();
        assert_eq!(
            again.open(Purpose::Token, "r", &sealed).as_deref(),
            Some("v")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), written);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_wide_key_file_is_narrowed_and_a_bad_one_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(KEY_FILE_NAME);
        Sealer::new(KeySource::File(path.clone()))
            .key()
            .await
            .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        Sealer::new(KeySource::File(path.clone()))
            .key()
            .await
            .unwrap();
        assert_eq!(mode(&path), 0o600);

        std::fs::write(&path, "not a key").unwrap();
        assert!(Sealer::new(KeySource::File(path.clone()))
            .key()
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a key");
    }
}
