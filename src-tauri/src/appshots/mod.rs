//! User-initiated, one-shot desktop context. This never creates an agent grant.

use async_trait::async_trait;
use serde::Serialize;

use crate::computer::agent::{grantable, Blocklist, SelfIdentity};
use crate::computer::backend::{BackendError, ComputerBackend, SnapshotOptions};
use crate::computer::protocol::{RawCapture, RawSnapshot, RawWindow};

#[cfg(feature = "tauri-runtime")]
pub mod desktop;

pub const MAX_TEXT_CHARS: usize = 40_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appshot {
    pub id: String,
    pub app_name: String,
    pub app_key: String,
    pub title: String,
    pub captured_at: String,
    pub image: AppshotImage,
    pub text: String,
    pub truncated: bool,
    pub text_unavailable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppshotImage {
    pub data: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

/// The small read-only seam also used by the capture contract tests.
#[async_trait]
pub trait AppshotSource: Send + Sync {
    async fn windows(&self) -> Result<Vec<RawWindow>, BackendError>;
    async fn picture(&self, window: &RawWindow) -> Result<RawCapture, BackendError>;
    async fn text(&self, window: &RawWindow) -> Result<RawSnapshot, BackendError>;
}

#[async_trait]
impl<T: ComputerBackend + ?Sized> AppshotSource for T {
    async fn windows(&self) -> Result<Vec<RawWindow>, BackendError> {
        self.list_windows(None).await
    }
    async fn picture(&self, window: &RawWindow) -> Result<RawCapture, BackendError> {
        self.capture(window.pid, window.window_id, Some(2000)).await
    }
    async fn text(&self, window: &RawWindow) -> Result<RawSnapshot, BackendError> {
        self.snapshot(
            window.pid,
            window.window_id,
            SnapshotOptions {
                max_depth: Some(30),
                max_elements: Some(4000),
                app_menus: false,
                ..Default::default()
            },
        )
        .await
    }
}

fn frontmost(windows: &[RawWindow]) -> Result<&RawWindow, String> {
    windows
        .iter()
        .filter(|w| {
            w.on_screen
                && w.minimized != Some(true)
                && w.hidden != Some(true)
                && w.on_current_space != Some(false)
                && !w.bounds.is_empty()
                && (w.z_index.is_some() || w.app.active)
        })
        .max_by_key(|w| (w.z_index.unwrap_or(i64::MIN), w.app.active))
        .ok_or_else(|| "no-window".to_string())
}

fn same_window(a: &RawWindow, b: &RawWindow) -> bool {
    a.pid == b.pid
        && a.window_id == b.window_id
        && a.app.started_at == b.app.started_at
        && a.app.key() == b.app.key()
        && a.content == b.content
        && a.title == b.title
}

/// Pin one target before reading. Never fall through to a window behind a
/// blocked one, and discard the entire capture if its identity changes.
pub async fn capture(
    source: &dyn AppshotSource,
    me: &SelfIdentity,
    blocklist: &Blocklist,
) -> Result<Appshot, String> {
    let windows = source.windows().await.map_err(|e| e.to_string())?;
    let window = frontmost(&windows)?;
    grantable(&window.app, me, blocklist).map_err(|e| format!("not-capturable:{e:?}"))?;
    let captured_at = chrono::Utc::now().to_rfc3339();
    let image = source.picture(window).await.map_err(|e| e.to_string())?;
    if image.png_base64.is_empty() || image.width == 0 || image.height == 0 {
        return Err("empty-image".to_string());
    }
    let snapshot = source.text(window).await.ok();
    let after = source.windows().await.map_err(|e| e.to_string())?;
    if !after.iter().any(|w| same_window(window, w)) {
        return Err("window-changed".to_string());
    }
    // A navigation may change the document between the two reads, even
    // though the native window's identity is unchanged.
    for title in [
        image.title.as_deref(),
        snapshot.as_ref().and_then(|s| s.title.as_deref()),
    ]
    .into_iter()
    .flatten()
    {
        if !title.is_empty() && !window.title.is_empty() && title != window.title {
            return Err("window-changed".to_string());
        }
    }
    let available = snapshot.as_ref().is_some_and(|s| !s.tree.is_empty());
    let (text, truncated) = match snapshot {
        Some(s) => {
            let end = s.tree.char_indices().nth(MAX_TEXT_CHARS).map(|(i, _)| i);
            (
                s.tree[..end.unwrap_or(s.tree.len())].to_string(),
                s.truncated || end.is_some(),
            )
        }
        None => (String::new(), false),
    };
    Ok(Appshot {
        id: uuid::Uuid::new_v4().to_string(),
        app_name: window.app.name.clone(),
        app_key: window.app.key().unwrap_or_default().to_string(),
        title: window.title.clone(),
        captured_at,
        image: AppshotImage {
            data: image.png_base64,
            mime: "image/png".to_string(),
            width: image.width,
            height: image.height,
        },
        text,
        truncated,
        text_unavailable: !available,
    })
}

#[cfg(test)]
mod tests;
