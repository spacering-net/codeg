use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::app_error::AppCommandError;

/// Write a base64-encoded binary blob to a user-chosen path on disk.
///
/// Used by the frontend's "download generated image" flow on desktop:
/// the renderer first invokes `tauri-plugin-dialog`'s `save()` to obtain
/// a destination path from the system save dialog, then calls this command
/// with the base64 payload. Web mode bypasses this command entirely and
/// uses an `<a download>` Blob link.
///
/// `path` must be an absolute filesystem path (the dialog returns one).
/// Parent directory must already exist (it does, since the OS dialog only
/// lets the user pick an existing folder + filename).
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_binary_file(path: String, data_base64: String) -> Result<(), AppCommandError> {
    let bytes = STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| AppCommandError::invalid_input(format!("invalid base64 payload: {e}")))?;
    std::fs::write(&path, bytes).map_err(AppCommandError::io)?;
    Ok(())
}

/// Write a UTF-8 text payload to a user-chosen path on disk.
///
/// Used by the frontend's "export conversation as Markdown / HTML" flow on
/// desktop. The renderer first invokes `tauri-plugin-dialog`'s `save()`
/// to obtain a destination path from the system save dialog, then calls
/// this command with the text contents. Web mode bypasses this command
/// entirely and uses an `<a download>` Blob link.
///
/// Mirrors `save_binary_file`'s contract: `path` must be an absolute
/// filesystem path returned by the OS dialog, and the parent directory
/// is guaranteed to exist by the dialog. I/O failures (including macOS
/// TCC denials at write time) surface through `AppCommandError::io`,
/// which maps `PermissionDenied` so the caller can disambiguate.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_text_file(path: String, contents: String) -> Result<(), AppCommandError> {
    std::fs::write(&path, contents).map_err(AppCommandError::io)?;
    Ok(())
}

/// Keep something pasted into the desktop composer that has no file behind
/// it (bytes an app put on the clipboard without a path) in codeg's uploads
/// directory, so the agent is handed a path to read, as with any upload.
///
/// The bytes cross the IPC as base64. A payload that could not decode to
/// within `UPLOAD_MAX_BYTES`, the cap every upload has, is refused before it
/// is decoded.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_pasted_attachment(
    file_name: String,
    mime_type: Option<String>,
    session_id: Option<String>,
    data_base64: String,
) -> Result<crate::web::handlers::files::UploadAttachmentResult, AppCommandError> {
    use crate::web::handlers::files::{store_attachment_bytes, upload_too_large, UPLOAD_MAX_BYTES};

    // The longest padded base64 of a file exactly at the cap.
    let max_base64_len = (UPLOAD_MAX_BYTES as usize).div_ceil(3) * 4;
    if data_base64.len() > max_base64_len {
        return Err(upload_too_large((data_base64.len() / 4 * 3) as u64));
    }
    let bytes = STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| AppCommandError::invalid_input(format!("invalid base64 payload: {e}")))?;
    store_attachment_bytes(&file_name, mime_type, session_id.as_deref(), &bytes).await
}

#[cfg(all(test, feature = "tauri-runtime"))]
mod tests {
    use super::*;

    // Only the refusals that happen before anything is written: a stored
    // paste goes to the real uploads root, which a test must not touch. The
    // storing itself is covered by `store_attachment_bytes_in`'s tests.
    #[tokio::test]
    async fn a_pasted_payload_over_the_cap_is_refused_before_decoding() {
        let cap = crate::web::handlers::files::UPLOAD_MAX_BYTES as usize;
        // Not base64 at all: only the length check can turn this into the
        // size-cap error; decoding it would fail as invalid input instead.
        let oversized = "!".repeat(cap.div_ceil(3) * 4 + 4);
        let err = save_pasted_attachment("big.bin".into(), None, None, oversized)
            .await
            .expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(crate::app_error::UPLOAD_I18N_KEY_TOO_LARGE)
        );
    }

    #[tokio::test]
    async fn a_pasted_payload_that_is_not_base64_is_refused() {
        let err = save_pasted_attachment("a.zip".into(), None, None, "not base64!".into())
            .await
            .expect_err("must refuse");
        assert!(matches!(
            err.code,
            crate::app_error::AppErrorCode::InvalidInput
        ));
    }

    #[tokio::test]
    async fn save_text_file_writes_utf8_payload() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("out.md");
        let contents = "# Title\n\n中文内容 emoji 🎉\n".to_string();
        save_text_file(path.to_string_lossy().into_owned(), contents.clone())
            .await
            .expect("write");
        let read = std::fs::read_to_string(&path).expect("read");
        assert_eq!(read, contents);
    }

    #[tokio::test]
    async fn save_text_file_overwrites_existing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("out.md");
        std::fs::write(&path, "old").expect("seed");
        save_text_file(path.to_string_lossy().into_owned(), "new".into())
            .await
            .expect("overwrite");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "new");
    }

    #[tokio::test]
    async fn save_text_file_surfaces_io_error_on_missing_parent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bad = dir.path().join("does/not/exist/out.md");
        let err = save_text_file(bad.to_string_lossy().into_owned(), "x".into())
            .await
            .expect_err("must fail");
        assert!(matches!(err.code, crate::app_error::AppErrorCode::NotFound));
    }
}
