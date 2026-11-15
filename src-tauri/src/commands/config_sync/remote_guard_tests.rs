//! Wire-level tests for "never replace a remote snapshot this device has not
//! seen" (#1149), against an in-process WebDAV share that two "machines" — two
//! in-memory databases — point at.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;

use super::appearance::mirror_appearance_core;
use super::credentials;
use super::snapshot::{parse_manifest, MANIFEST_FILE_NAME};
use super::webdav_sync::*;
use crate::db::service::app_metadata_service;
use crate::db::test_helpers::fresh_in_memory_db;
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

// ─── the fake share ───────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fault {
    /// Store the body, then answer 500 — a PUT whose response was lost.
    WriteThenFail,
    /// Answer 500 without storing anything.
    FailWithoutWrite,
}

#[derive(Default)]
struct DavState {
    files: HashMap<String, Vec<u8>>,
    puts: usize,
    /// One-shot fault for the next PUT whose path ends with the given name.
    fault: Option<(String, Fault)>,
}

type Shared = Arc<Mutex<DavState>>;

async fn dav(State(state): State<Shared>, method: Method, uri: Uri, body: Bytes) -> Response {
    let path = uri.path().to_string();
    let mut st = state.lock().unwrap();
    match method.as_str() {
        "MKCOL" => StatusCode::CREATED.into_response(),
        "PROPFIND" => StatusCode::MULTI_STATUS.into_response(),
        "GET" => match st.files.get(&path) {
            Some(bytes) => (StatusCode::OK, bytes.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        "PUT" => {
            let fault = match &st.fault {
                Some((suffix, fault)) if path.ends_with(suffix.as_str()) => Some(*fault),
                _ => None,
            };
            if fault.is_some() {
                st.fault = None;
            }
            if fault == Some(Fault::FailWithoutWrite) {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            st.files.insert(path, body.to_vec());
            st.puts += 1;
            if fault == Some(Fault::WriteThenFail) {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            StatusCode::CREATED.into_response()
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

struct Share {
    url: String,
    state: Shared,
}

impl Share {
    async fn start() -> Self {
        let state: Shared = Arc::default();
        let app = Router::new().fallback(dav).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr: SocketAddr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            url: format!("http://{addr}/dav/"),
            state,
        }
    }

    fn manifest_bytes(&self) -> Option<Vec<u8>> {
        let st = self.state.lock().unwrap();
        st.files
            .iter()
            .find(|(path, _)| path.ends_with(MANIFEST_FILE_NAME))
            .map(|(_, bytes)| bytes.clone())
    }

    fn manifest_sha(&self) -> String {
        parse_manifest(&self.manifest_bytes().expect("manifest"))
            .expect("parse")
            .config
            .sha256
    }

    fn puts(&self) -> usize {
        self.state.lock().unwrap().puts
    }

    fn fail_next_put(&self, suffix: &str, fault: Fault) {
        self.state.lock().unwrap().fault = Some((suffix.to_string(), fault));
    }

    fn put_manifest_raw(&self, bytes: &[u8]) {
        let path = "/dav/codeg/v1/default/manifest.json".to_string();
        self.state
            .lock()
            .unwrap()
            .files
            .insert(path, bytes.to_vec());
    }
}

// ─── machines ─────────────────────────────────────────────────────────

fn settings_for(share: &Share) -> ConfigSyncSettingsInput {
    ConfigSyncSettingsInput {
        enabled: true,
        server_url: share.url.clone(),
        username: "alice".to_string(),
        password: Some("pw".to_string()),
        passphrase: None,
        encrypt: false,
        remote_dir: None,
        profile: None,
        auto_sync: true,
        interval_minutes: 5,
    }
}

async fn machine(share: &Share) -> AppDatabase {
    let db = fresh_in_memory_db().await;
    save_settings_core(&db.conn, settings_for(share))
        .await
        .expect("save settings");
    db
}

/// A local change, so the next tick has something new to upload.
async fn change(db: &AppDatabase, zoom: &str) {
    app_metadata_service::upsert_value(&db.conn, "appearance_zoom_level", zoom)
        .await
        .expect("seed");
}

fn auto() -> UploadRequest<'static> {
    UploadRequest {
        automatic: true,
        ..UploadRequest::default()
    }
}

fn manual(token: Option<&str>) -> UploadRequest<'_> {
    UploadRequest {
        force: true,
        automatic: false,
        overwrite_remote_sha256: token,
    }
}

async fn tick(db: &AppDatabase, request: UploadRequest<'_>) -> UploadOutcome {
    upload_snapshot_core(&db.conn, "1.0.0", request)
        .await
        .expect("upload")
}

fn emitter() -> EventEmitter {
    EventEmitter::Noop
}

/// Drop the fields this build added, leaving what an older build wrote.
async fn make_legacy(db: &AppDatabase) {
    let mut state = load_state(&db.conn).await;
    state.known_remote = None;
    state.inflight_remote.clear();
    state.conflict = None;
    save_state(&db.conn, &state).await;
}

// ─── the report ───────────────────────────────────────────────────────

/// #1149 as filed: machine A uploads; machine B is a fresh install pointed at
/// the same share, and its first automatic tick must not replace A's snapshot.
#[tokio::test]
async fn a_fresh_machine_does_not_overwrite_another_machines_snapshot() {
    let _guard = credentials::test_guard().await;
    let share = Share::start().await;
    let a = machine(&share).await;
    change(&a, "125").await;
    assert!(
        tick(&a, auto()).await.uploaded,
        "an empty remote is uploaded to"
    );
    let a_manifest = share.manifest_bytes().expect("A's manifest");
    let puts = share.puts();

    let b = machine(&share).await;
    let outcome = tick(&b, auto()).await;
    assert!(!outcome.uploaded);
    let conflict = outcome.conflict.expect("held back");
    assert_eq!(conflict.sha256, share.manifest_sha());
    assert!(conflict.source_device.is_some() && conflict.created_at.is_some());
    assert_eq!(share.puts(), puts, "nothing was written");
    assert_eq!(
        share.manifest_bytes().as_deref(),
        Some(a_manifest.as_slice())
    );
    assert_eq!(load_state_view(&b.conn).await.conflict, Some(conflict));

    // "Sync now" is not a way around it either.
    let outcome = tick(&b, manual(None)).await;
    assert!(!outcome.uploaded && outcome.conflict.is_some());
    assert_eq!(share.puts(), puts);

    // Restoring is: B has now seen A's snapshot, and its next upload — the
    // merged configuration — may replace it.
    download_and_apply_core(&b.conn, &emitter())
        .await
        .expect("restore");
    let state = load_state_view(&b.conn).await;
    assert!(state.conflict.is_none());
    assert!(state.last_pulled_at.is_some());
    assert_eq!(
        app_metadata_service::get_value(&b.conn, "appearance_zoom_level")
            .await
            .expect("read")
            .as_deref(),
        Some("125")
    );
    change(&b, "150").await;
    assert!(tick(&b, auto()).await.uploaded);
}

/// The wider form of the same loss: B synced with the share earlier, A has
/// uploaded since, and B's next local change must not replace A's snapshot.
#[tokio::test]
async fn a_machine_that_synced_before_does_not_overwrite_a_newer_snapshot() {
    let _guard = credentials::test_guard().await;
    let share = Share::start().await;
    let a = machine(&share).await;
    let b = machine(&share).await;
    change(&b, "110").await;
    assert!(tick(&b, auto()).await.uploaded);

    download_and_apply_core(&a.conn, &emitter())
        .await
        .expect("A restores B's");
    change(&a, "125").await;
    assert!(
        tick(&a, auto()).await.uploaded,
        "A replaces what it has seen"
    );

    change(&b, "150").await;
    let outcome = tick(&b, auto()).await;
    assert!(!outcome.uploaded && outcome.conflict.is_some());
}

/// The overwrite token names one snapshot. A confirmation the user gave about
/// a snapshot that has since been replaced again must not carry over.
#[tokio::test]
async fn a_confirmed_overwrite_replaces_exactly_the_named_snapshot() {
    let _guard = credentials::test_guard().await;
    let share = Share::start().await;
    let a = machine(&share).await;
    change(&a, "125").await;
    tick(&a, auto()).await;

    let b = machine(&share).await;
    let stale = tick(&b, auto()).await.conflict.expect("conflict").sha256;

    change(&a, "150").await;
    tick(&a, auto()).await;
    let outcome = tick(&b, manual(Some(&stale))).await;
    assert!(
        !outcome.uploaded,
        "the named snapshot is no longer up there"
    );
    let current = outcome.conflict.expect("a fresh conflict").sha256;
    assert_ne!(current, stale);

    let outcome = tick(&b, manual(Some(&current))).await;
    assert!(outcome.uploaded && outcome.conflict.is_none());
    assert!(load_state_view(&b.conn).await.conflict.is_none());
}

/// A manifest this build cannot read is still a snapshot somebody put there:
/// it blocks until named, and the name is the manifest file's checksum.
#[tokio::test]
async fn an_unreadable_remote_manifest_is_named_not_overwritten() {
    let _guard = credentials::test_guard().await;
    let share = Share::start().await;
    share.put_manifest_raw(b"not json");
    let a = machine(&share).await;
    let conflict = tick(&a, auto()).await.conflict.expect("held back");
    assert_eq!(conflict.sha256, super::snapshot::sha256_hex(b"not json"));
    assert!(conflict.source_device.is_none());
    assert!(tick(&a, manual(Some(&conflict.sha256))).await.uploaded);
}

// ─── this device's own uploads stay replaceable ───────────────────────

/// The PUT landed but the response was lost: the remote holds OUR snapshot
/// under a checksum `known_remote` does not name. Then the retry fails too,
/// before writing anything. Neither may turn into "somebody else's snapshot".
#[tokio::test]
async fn lost_responses_and_failed_retries_never_read_as_another_machine() {
    let _guard = credentials::test_guard().await;
    let share = Share::start().await;
    let a = machine(&share).await;
    change(&a, "110").await;
    tick(&a, auto()).await;

    change(&a, "125").await;
    share.fail_next_put(MANIFEST_FILE_NAME, Fault::WriteThenFail);
    upload_snapshot_core(&a.conn, "1.0.0", auto())
        .await
        .expect_err("the response was lost");
    let landed = share.manifest_sha();
    assert_ne!(
        load_state(&a.conn).await.known_remote.map(|k| k.sha256),
        Some(landed.clone())
    );

    change(&a, "150").await;
    share.fail_next_put("config.json", Fault::FailWithoutWrite);
    upload_snapshot_core(&a.conn, "1.0.0", auto())
        .await
        .expect_err("the retry failed before writing");
    assert_eq!(share.manifest_sha(), landed, "the remote did not move");
    // Promoted durably before the retry's own write-ahead went in.
    assert_eq!(
        load_state(&a.conn).await.known_remote.map(|k| k.sha256),
        Some(landed)
    );

    let outcome = tick(&a, auto()).await;
    assert!(outcome.uploaded, "{:?}", outcome.conflict);
}

/// Switching encryption on changes HOW the snapshot is stored, not WHERE: it
/// must re-upload (no plaintext left behind) and must not see its own
/// plaintext upload as a stranger's. Same for re-keying.
#[tokio::test]
async fn encryption_changes_reupload_without_a_false_conflict() {
    let _guard = credentials::test_guard().await;
    let share = Share::start().await;
    let a = machine(&share).await;
    change(&a, "125").await;
    tick(&a, auto()).await;

    for passphrase in ["first secret", "second secret"] {
        save_settings_core(
            &a.conn,
            ConfigSyncSettingsInput {
                encrypt: true,
                passphrase: Some(passphrase.to_string()),
                ..settings_for(&share)
            },
        )
        .await
        .expect("save");
        let outcome = tick(&a, auto()).await;
        assert!(outcome.uploaded, "{passphrase}: {:?}", outcome.conflict);
        let manifest = parse_manifest(&share.manifest_bytes().unwrap()).unwrap();
        assert_eq!(manifest.encryption, super::snapshot::ENCRYPTION_AES_GCM);
    }

    save_settings_core(&a.conn, settings_for(&share))
        .await
        .expect("encryption off");
    assert!(tick(&a, auto()).await.uploaded);
}

/// A state row from before this change records only the plaintext hash of
/// this device's last upload. Recognising it has to be exact — for plaintext
/// and for encrypted snapshots — or every existing user stalls after updating.
#[tokio::test]
async fn upgraded_state_rows_recognise_their_own_upload_and_nothing_else() {
    let _guard = credentials::test_guard().await;

    // Plaintext.
    let share = Share::start().await;
    let a = machine(&share).await;
    change(&a, "125").await;
    tick(&a, auto()).await;
    make_legacy(&a).await;
    change(&a, "150").await;
    assert!(tick(&a, auto()).await.uploaded);

    // Encrypted.
    let share = Share::start().await;
    let a = machine(&share).await;
    let encrypted = ConfigSyncSettingsInput {
        encrypt: true,
        passphrase: Some("secret".to_string()),
        ..settings_for(&share)
    };
    save_settings_core(&a.conn, encrypted.clone())
        .await
        .expect("save");
    change(&a, "125").await;
    tick(&a, auto()).await;
    make_legacy(&a).await;
    change(&a, "150").await;
    assert!(tick(&a, auto()).await.uploaded);

    // Somebody else's snapshot under an old row is still somebody else's.
    let b = machine(&share).await;
    save_settings_core(&b.conn, encrypted).await.expect("save");
    let mut state = load_state(&b.conn).await;
    state.last_uploaded_sha256 = Some("not this one".to_string());
    state.last_uploaded_target = load_state(&a.conn).await.last_uploaded_target;
    save_state(&b.conn, &state).await;
    change(&b, "175").await;
    assert!(tick(&b, auto()).await.conflict.is_some());

    // And a passphrase that cannot open it proves nothing.
    make_legacy(&a).await;
    save_settings_core(
        &a.conn,
        ConfigSyncSettingsInput {
            encrypt: true,
            passphrase: Some("another secret".to_string()),
            ..settings_for(&share)
        },
    )
    .await
    .expect("re-key");
    change(&a, "200").await;
    assert!(tick(&a, auto()).await.conflict.is_some());
}

/// An upload holds the operation lock for its whole run, so it cannot collect
/// a snapshot before a restore and PUT it after.
#[tokio::test]
async fn an_upload_waits_out_an_operation_in_progress() {
    let _guard = credentials::test_guard().await;
    let share = Share::start().await;
    let a = machine(&share).await;
    change(&a, "125").await;

    let held = super::webdav_sync::sync_lock().lock().await;
    let conn = a.conn.clone();
    let upload = tokio::spawn(async move { upload_snapshot_core(&conn, "1.0.0", auto()).await });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(
        share.puts(),
        0,
        "nothing happens while another operation runs"
    );
    assert!(!upload.is_finished());
    drop(held);
    assert!(upload.await.expect("join").expect("upload").uploaded);
}

// ─── appearance rides along ───────────────────────────────────────────

#[tokio::test]
async fn a_restore_hands_the_remote_appearance_back_to_its_caller() {
    let _guard = credentials::test_guard().await;
    let share = Share::start().await;
    let a = machine(&share).await;
    mirror_appearance_core(
        &a.conn,
        [
            ("codeg-theme-color".to_string(), "yellow".to_string()),
            ("codeg-zoom-level".to_string(), "125".to_string()),
        ]
        .into_iter()
        .collect(),
    )
    .await
    .expect("mirror");
    tick(&a, auto()).await;

    let b = machine(&share).await;
    let restored = download_and_apply_core(&b.conn, &emitter())
        .await
        .expect("restore");
    assert_eq!(
        restored
            .applied
            .appearance
            .get("codeg-theme-color")
            .map(String::as_str),
        Some("yellow")
    );
    assert_eq!(
        restored
            .applied
            .appearance
            .get("codeg-zoom-level")
            .map(String::as_str),
        Some("125")
    );
    assert_eq!(restored.applied.domains.get("appearance"), Some(&2));
}
