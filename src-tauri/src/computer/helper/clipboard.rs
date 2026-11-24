//! The clipboard as the helper keeps track of it for agents: a stamp that
//! tells one content from the next, and whether an application marked what
//! it holds as not to be read.
//!
//! An agent may paste only what it put on the clipboard itself — copied out
//! of a window it may read, or written there — and may read back only that:
//! the clipboard is otherwise the person's, and holds what they copied from a
//! password manager as readily as anything else. So the stamp is taken around
//! an agent's copy, and checked again just before a paste or a read.
//!
//! macOS counts every change of the general pasteboard, and Windows numbers
//! every change of the clipboard; neither needs the content read, which on
//! macOS would ask the person's leave. Linux has no such count, and there the
//! stamp is a digest of what the driver reads of it.

use std::time::Duration;

use super::driver_proc::DriverProc;
use crate::computer::protocol::HelperError;

/// What tells the clipboard's content apart from the next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub value: u64,
    /// An application marked what it holds as not to be read or kept — what
    /// password managers mark theirs with.
    pub concealed: bool,
    /// It holds plain text and nothing else — no HTML, image or file list
    /// alongside, which a paste could write instead.
    pub plain_text: bool,
}

/// How long a copy may take to reach the clipboard once its key went in.
const COPY_WAIT: Duration = Duration::from_millis(1000);
const COPY_POLL: Duration = Duration::from_millis(25);

/// The clipboard's stamp once it has moved from `before` — what an agent's
/// copy put there — or `None` when it did not move within [`COPY_WAIT`]: an
/// empty selection, a copy the application refused, and then the clipboard
/// still holds what was there before, which was not the agent's. Nor when
/// what it now holds is concealed.
pub async fn changed_since(driver: &DriverProc, before: u64) -> Option<u64> {
    let deadline = tokio::time::Instant::now() + COPY_WAIT;
    loop {
        if let Ok(now) = stamp(driver).await {
            if now.value != before {
                return (!now.concealed).then_some(now.value);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(COPY_POLL).await;
    }
}

/// Pasteboard types that say "not to be read": concealed (a password) and
/// transient (gone in a moment), as nspasteboard.org names them.
#[cfg(target_os = "macos")]
const CONCEALED_TYPES: &[&str] = &[
    "org.nspasteboard.ConcealedType",
    "org.nspasteboard.TransientType",
];

/// The pasteboard types of plain text.
#[cfg(target_os = "macos")]
const MAC_TEXT_TYPES: &[&str] = &[
    "public.utf8-plain-text",
    "public.utf16-plain-text",
    "public.utf16-external-plain-text",
    "public.plain-text",
    "NSStringPboardType",
];

/// The general pasteboard's change count, and its types.
#[cfg(target_os = "macos")]
pub async fn stamp(_driver: &DriverProc) -> Result<Stamp, HelperError> {
    tokio::task::spawn_blocking(|| {
        let board = objc2_app_kit::NSPasteboard::generalPasteboard();
        let value = board.changeCount() as u64;
        let types: Vec<String> = board
            .types()
            .map(|types| types.iter().map(|kind| kind.to_string()).collect())
            .unwrap_or_default();
        let concealed = types
            .iter()
            .any(|kind| CONCEALED_TYPES.contains(&kind.as_str()));
        // One item, and of text only: two items share one list of types, and
        // a paste can take both.
        // SAFETY: `pasteboardItems` takes nothing and answers an array of
        // items, or nil.
        let items: Option<
            objc2::rc::Retained<objc2_foundation::NSArray<objc2::runtime::NSObject>>,
        > = unsafe { objc2::msg_send![&*board, pasteboardItems] };
        let one_item = items.is_some_and(|items| items.count() == 1);
        let plain_text = one_item
            && !types.is_empty()
            && types
                .iter()
                .all(|kind| MAC_TEXT_TYPES.contains(&kind.as_str()));
        Stamp {
            value,
            concealed,
            plain_text,
        }
    })
    .await
    .map_err(|e| HelperError::failed(format!("clipboard: {e}")))
}

/// Clipboard formats that say "not to be read or kept", as Windows'
/// clipboard history and clipboard managers honour them.
#[cfg(windows)]
const CONCEALED_FORMATS: &[&str] = &[
    "ExcludeClipboardContentFromMonitorProcessing",
    "Clipboard Viewer Ignore",
];

/// The clipboard's sequence number, and whether a concealing format is on
/// it. Neither opens the clipboard.
#[cfg(windows)]
pub async fn stamp(_driver: &DriverProc) -> Result<Stamp, HelperError> {
    use windows_sys::Win32::System::DataExchange::{
        CountClipboardFormats, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
        RegisterClipboardFormatW,
    };
    // CF_TEXT, CF_OEMTEXT, CF_UNICODETEXT and CF_LOCALE: plain text, and
    // the forms Windows makes of it on its own.
    const TEXT_FORMATS: [u32; 4] = [1, 7, 13, 16];
    tokio::task::spawn_blocking(|| {
        // SAFETY: no arguments; answers 0 where it cannot be read.
        let value = u64::from(unsafe { GetClipboardSequenceNumber() });
        let concealed = CONCEALED_FORMATS.iter().any(|name| {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            // SAFETY: a NUL-terminated UTF-16 name that outlives the call.
            let format = unsafe { RegisterClipboardFormatW(wide.as_ptr()) };
            // SAFETY: a plain query of a registered format.
            format != 0 && unsafe { IsClipboardFormatAvailable(format) } != 0
        });
        // Every format on it is one of the text ones: counted, not
        // enumerated, so the clipboard is never opened.
        // SAFETY: plain queries.
        let text_formats = TEXT_FORMATS
            .iter()
            .filter(|format| unsafe { IsClipboardFormatAvailable(**format) } != 0)
            .count();
        // SAFETY: a plain query.
        let all_formats = unsafe { CountClipboardFormats() };
        let plain_text = text_formats > 0 && usize::try_from(all_formats) == Ok(text_formats);
        Stamp {
            value,
            concealed,
            plain_text,
        }
    })
    .await
    .map_err(|e| HelperError::failed(format!("clipboard: {e}")))
}

/// What says "a password" on a Linux clipboard (KDE's password managers
/// mark theirs so).
#[cfg(not(any(target_os = "macos", windows)))]
const CONCEALED_TYPES: &[&str] = &["x-kde-passwordManagerHint"];

/// The types a Linux clipboard of plain text goes by — the content itself
/// and the selection's own bookkeeping. Anything else (an image, HTML, a
/// file list) the driver does not hand over, so its digest could not tell
/// one such content from the next.
#[cfg(any(test, not(any(target_os = "macos", windows))))]
const PLAIN_TEXT_TYPES: &[&str] = &[
    "text/plain",
    "text/plain;charset=utf-8",
    "utf8_string",
    "string",
    "text",
    "compound_text",
    "targets",
    "timestamp",
    "multiple",
    "save_targets",
];

/// Whether a digest of the driver's read would tell this content apart from
/// any other: text, and nothing that is not text.
#[cfg(any(test, not(any(target_os = "macos", windows))))]
fn fingerprintable(types: &[String], text: Option<&str>) -> bool {
    text.is_some()
        && types
            .iter()
            .all(|kind| PLAIN_TEXT_TYPES.contains(&kind.to_ascii_lowercase().as_str()))
}

/// A digest of what the driver reads of the clipboard — its types and its
/// text — for want of a change count.
#[cfg(not(any(target_os = "macos", windows)))]
pub async fn stamp(driver: &DriverProc) -> Result<Stamp, HelperError> {
    let result = driver
        .call(
            "clipboard_read",
            serde_json::json!({ "include_text": true }),
            Duration::from_secs(10),
        )
        .await?;
    if result.is_error {
        return Err(super::ops::tool_error("clipboard_read", &result));
    }
    let said = result.structured.unwrap_or_default();
    let types: Vec<String> = said
        .get("types")
        .and_then(serde_json::Value::as_array)
        .map(|types| {
            types
                .iter()
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let text = said.get("text").and_then(serde_json::Value::as_str);
    // What cannot be told from other content cannot be held as the agent's:
    // it is as good as concealed.
    let plain_text = fingerprintable(&types, text);
    let concealed = types.iter().any(|t| CONCEALED_TYPES.contains(&t.as_str())) || !plain_text;
    let text = text.unwrap_or_default();
    let mut digest = Fnv::default();
    for kind in &types {
        digest.write(kind.as_bytes());
        digest.write(&[0]);
    }
    digest.write(&[1]);
    digest.write(text.as_bytes());
    Ok(Stamp {
        value: digest.0,
        concealed,
        plain_text,
    })
}

/// FNV-1a, 64-bit: the same digest in every helper that is started, which a
/// randomly keyed hash would not be.
#[cfg(any(test, not(any(target_os = "macos", windows))))]
struct Fnv(u64);

#[cfg(any(test, not(any(target_os = "macos", windows))))]
impl Default for Fnv {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}

#[cfg(any(test, not(any(target_os = "macos", windows))))]
impl Fnv {
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The digest is the published FNV-1a: the same in every helper.
    #[test]
    fn the_digest_is_fnv_1a() {
        let mut digest = Fnv::default();
        digest.write(b"a");
        assert_eq!(digest.0, 0xaf63_dc4c_8601_ec8c);
    }

    /// Only plain text can be told apart by what the driver reads: an image
    /// or HTML alongside, or no text at all, cannot.
    #[test]
    fn only_plain_text_is_fingerprintable() {
        let types = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        assert!(fingerprintable(
            &types(&["UTF8_STRING", "text/plain;charset=utf-8", "TARGETS"]),
            Some("hi")
        ));
        assert!(!fingerprintable(&types(&["image/png"]), None));
        assert!(!fingerprintable(
            &types(&["text/html", "text/plain"]),
            Some("hi")
        ));
        assert!(!fingerprintable(&types(&["text/plain"]), None));
    }
}
