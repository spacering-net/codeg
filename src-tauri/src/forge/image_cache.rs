//! Private, bounded disk cache for forge images. JSON/IPC carries only a
//! resource URL; the renderer reads the file as a binary image stream.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime};

use axum::body::Body;
use axum::extract::{Path as AxumPath, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio_util::io::ReaderStream;

use super::{ForgeError, ForgeImage};

pub(crate) const IMAGE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;
const CACHE_MAX_ENTRIES: usize = 512;
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const GRANT_TTL: Duration = Duration::from_secs(60 * 60);
const URL_PREFIX: &str = "/api/forge_image/";

static DOWNLOADS: Semaphore = Semaphore::const_new(4);
static KEY_LOCKS: LazyLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CACHE_WRITE: AsyncMutex<()> = AsyncMutex::const_new(());
static GRANTS: LazyLock<Mutex<HashMap<String, Grant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct Grant {
    cap: String,
    path: PathBuf,
    mime_type: String,
    expires: Instant,
}

#[derive(Serialize, Deserialize)]
struct Metadata {
    mime_type: String,
    bytes: u64,
}

fn io_error(error: impl std::fmt::Display) -> ForgeError {
    ForgeError::Network(format!("forge image cache: {error}"))
}

/// Length-prefix the fields so repository/account/token boundaries cannot
/// collide. Neither credentials nor upload names are written to disk.
pub(crate) fn cache_key(fields: &[&str]) -> String {
    let mut hash = Sha256::new();
    for field in fields {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

pub(crate) async fn get_or_download<F, Fut>(
    root: &Path,
    key: String,
    max_bytes: u64,
    download: F,
) -> Result<ForgeImage, ForgeError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<reqwest::Response, ForgeError>>,
{
    let lock = {
        let mut locks = KEY_LOCKS.lock().map_err(io_error)?;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(AsyncMutex::new(()));
            locks.insert(key.clone(), Arc::downgrade(&lock));
            lock
        }
    };
    let _key_guard = lock.lock().await;
    let root = root.to_path_buf();
    let entry = root.join(&key);
    let read_entry = entry.clone();
    if let Some(metadata) = tokio::task::spawn_blocking(move || cached(&read_entry, max_bytes))
        .await
        .map_err(io_error)?
    {
        return grant(key, entry.join("image"), metadata.mime_type);
    }

    let _permit = DOWNLOADS.acquire().await.map_err(io_error)?;
    let mut response = download().await?;
    if response.content_length().is_some_and(|n| n > max_bytes) {
        return Err(ForgeError::Invalid(format!("image exceeds the {max_bytes} byte limit")));
    }
    let declared_svg = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().unwrap_or_default().trim().eq_ignore_ascii_case("image/svg+xml"));
    let prepare_root = root.clone();
    let staging = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&prepare_root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&prepare_root, std::fs::Permissions::from_mode(0o700))?;
        }
        // A process crash can leave a staging directory behind. Downloads
        // have a 30-second HTTP deadline; hour-old stages cannot be active.
        for item in std::fs::read_dir(&prepare_root)? {
            let item = item?;
            if item.file_name().to_string_lossy().starts_with(".download-") {
                let metadata = match item.metadata() {
                    Ok(metadata) => metadata,
                    // A peer may publish or cancel its stage after read_dir
                    // yielded it. Its disappearance is a successful cleanup.
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                };
                let old = metadata.modified()?.elapsed().unwrap_or_default()
                    > Duration::from_secs(60 * 60);
                if old {
                    match std::fs::remove_dir_all(item.path()) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error),
                    }
                }
            }
        }
        tempfile::Builder::new().prefix(".download-").tempdir_in(prepare_root)
    })
    .await
    .map_err(io_error)?
    .map_err(io_error)?;
    let mut file = tokio::fs::File::create(staging.path().join("image"))
        .await
        .map_err(io_error)?;
    let mut prefix = Vec::with_capacity(4096);
    let mut bytes = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(io_error)? {
        if chunk.len() as u64 > max_bytes.saturating_sub(bytes) {
            return Err(ForgeError::Invalid(format!("image exceeds the {max_bytes} byte limit")));
        }
        bytes += chunk.len() as u64;
        prefix.extend_from_slice(&chunk[..chunk.len().min(4096 - prefix.len())]);
        file.write_all(&chunk).await.map_err(io_error)?;
    }
    file.flush().await.map_err(io_error)?;
    drop(file);
    let mime_type = image::guess_format(&prefix)
        .map(|format| format.to_mime_type())
        .ok()
        .or_else(|| (declared_svg && bytes > 0).then_some("image/svg+xml"))
        .ok_or_else(|| ForgeError::Invalid("upload is not a supported image".into()))?
        .to_string();
    let metadata = Metadata { mime_type: mime_type.clone(), bytes };
    let json = serde_json::to_vec(&metadata).map_err(io_error)?;
    tokio::fs::write(staging.path().join("metadata.json"), json)
        .await
        .map_err(io_error)?;

    // Publish complete entries atomically. Staging files are removed by
    // TempDir on errors, cancellation and failed size/type validation.
    let _write_guard = CACHE_WRITE.lock().await;
    let final_entry = entry.clone();
    tokio::task::spawn_blocking(move || {
        if final_entry.exists() {
            std::fs::remove_dir_all(&final_entry)?;
        }
        prune(&root, bytes)?;
        std::fs::rename(staging.path(), final_entry)
    })
    .await
    .map_err(io_error)?
    .map_err(io_error)?;
    grant(key, entry.join("image"), mime_type)
}

fn cached(entry: &Path, max_bytes: u64) -> Option<Metadata> {
    let json = std::fs::read(entry.join("metadata.json")).ok()?;
    let metadata: Metadata = serde_json::from_slice(&json).ok()?;
    let path = entry.join("image");
    let file = std::fs::File::open(&path).ok()?;
    let actual = file.metadata().ok()?;
    if !actual.is_file()
        || actual.len() != metadata.bytes
        || actual.len() > max_bytes
        || SystemTime::now().duration_since(actual.modified().ok()?).ok()? > CACHE_TTL
        || !metadata.mime_type.starts_with("image/")
        || metadata.mime_type.contains(['\r', '\n'])
    {
        return None;
    }
    let _ = file.set_modified(SystemTime::now());
    Some(metadata)
}

fn prune(root: &Path, incoming: u64) -> std::io::Result<()> {
    let now = SystemTime::now();
    let mut entries = Vec::new();
    for item in std::fs::read_dir(root)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if !valid_key(&name) { continue; }
        let path = item.path();
        let Ok(metadata) = std::fs::metadata(path.join("image")) else { continue; };
        let modified = metadata.modified()?;
        if now.duration_since(modified).unwrap_or_default() > CACHE_TTL {
            std::fs::remove_dir_all(path)?;
        } else {
            entries.push((modified, metadata.len(), path));
        }
    }
    entries.sort_by_key(|(modified, _, _)| *modified);
    let mut total: u64 = entries.iter().map(|(_, bytes, _)| bytes).sum();
    let mut count = entries.len();
    for (_, bytes, path) in entries {
        if total + incoming <= CACHE_MAX_BYTES && count < CACHE_MAX_ENTRIES { break; }
        std::fs::remove_dir_all(path)?;
        total -= bytes;
        count -= 1;
    }
    Ok(())
}

fn grant(key: String, path: PathBuf, mime_type: String) -> Result<ForgeImage, ForgeError> {
    let now = Instant::now();
    let mut grants = GRANTS.lock().map_err(io_error)?;
    grants.retain(|_, grant| grant.expires > now);
    if !grants.contains_key(&key) && grants.len() >= CACHE_MAX_ENTRIES {
        if let Some(oldest) = grants.iter().min_by_key(|(_, grant)| grant.expires).map(|(key, _)| key.clone()) {
            grants.remove(&oldest);
        }
    }
    let held = grants.entry(key.clone()).or_insert_with(|| Grant {
        cap: uuid::Uuid::new_v4().to_string(),
        path: path.clone(),
        mime_type: mime_type.clone(),
        expires: now + GRANT_TTL,
    });
    held.path = path;
    held.mime_type.clone_from(&mime_type);
    held.expires = now + GRANT_TTL;
    Ok(ForgeImage {
        mime_type,
        url: format!("{URL_PREFIX}{key}?cap={}", held.cap),
    })
}

fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Only a minted cache resource URL is accepted by the remote desktop proxy.
/// It cannot turn an image request into an arbitrary authenticated HTTP call.
#[cfg(feature = "tauri-runtime")]
pub(crate) fn valid_image_url(url: &str) -> bool {
    url.strip_prefix(URL_PREFIX)
        .and_then(|rest| rest.split_once("?cap="))
        .is_some_and(|(key, cap)| valid_key(key) && cap.len() == 36 && uuid::Uuid::parse_str(cap).is_ok())
}

#[derive(Deserialize)]
pub(crate) struct ImageQuery {
    cap: String,
}

/// The unguessable, expiring capability is issued by authenticated JSON/IPC.
/// No application token is put in a URL; no client-supplied file is opened.
pub(crate) async fn serve_image(
    AxumPath(key): AxumPath<String>,
    Query(query): Query<ImageQuery>,
) -> Response {
    let grant = GRANTS.lock().ok().and_then(|grants| {
        grants.get(&key).filter(|grant| grant.cap == query.cap && grant.expires > Instant::now()).cloned()
    });
    let Some(grant) = grant else { return StatusCode::NOT_FOUND.into_response(); };
    let Ok(file) = tokio::fs::File::open(&grant.path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(metadata) = file.metadata().await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let body = Body::from_stream(ReaderStream::with_capacity(file, 64 * 1024));
    // SVG must remain inert even when someone navigates to the resource URL.
    // In particular, it must not execute script with the server app's origin.
    axum::http::Response::builder()
        .header("content-type", grant.mime_type)
        .header("content-length", metadata.len())
        .header("cache-control", "private, max-age=3600")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("content-security-policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Desktop webviews read a loopback stream, avoiding filesystem permissions,
/// Base64 IPC and mixed-content requests to an HTTP remote workspace.
#[cfg(feature = "tauri-runtime")]
pub(crate) async fn local_image_url(mut image: ForgeImage) -> Result<ForgeImage, ForgeError> {
    static LISTENER: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    let origin = LISTENER.get_or_try_init(|| async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(io_error)?;
        let address = listener.local_addr().map_err(io_error)?;
        let router = axum::Router::new()
            .route("/api/forge_image/{key}", axum::routing::get(serve_image));
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                tracing::warn!(%error, "forge image cache listener stopped");
            }
        });
        Ok::<_, ForgeError>(format!("http://{address}"))
    }).await?;
    image.url = format!("{origin}{}", image.url);
    Ok(image)
}

#[cfg(test)]
pub(super) fn cached_path(image: &ForgeImage) -> PathBuf {
    let rest = image.url.strip_prefix(URL_PREFIX).unwrap();
    let (key, _) = rest.split_once("?cap=").unwrap();
    GRANTS.lock().unwrap().get(key).unwrap().path.clone()
}
