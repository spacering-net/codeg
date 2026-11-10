//! stdin as (part of) the prompt.
//!
//! Read only when it is a pipe or a regular file. A terminal is never read
//! (nobody is typing into a CI job), and neither is `/dev/null` or another
//! character device — a CI runner that leaves stdin open but silent would
//! otherwise hang the run forever.

use tokio::io::AsyncReadExt;

use crate::cli_run::wire::Subtype;

use super::Failure;

/// Whether stdin is something to read: a pipe or a regular file.
pub fn is_readable() -> bool {
    platform::is_readable()
}

/// All of stdin, as text, bounded by `limit` bytes.
pub async fn read_all(limit: usize) -> Result<String, Failure> {
    let mut buf = Vec::new();
    let mut stdin = tokio::io::stdin().take(limit as u64 + 1);
    stdin.read_to_end(&mut buf).await.map_err(|e| {
        Failure::new(
            Subtype::ErrorUsage,
            "stdin_unreadable",
            format!("cannot read stdin: {e}"),
        )
    })?;
    if buf.len() > limit {
        return Err(Failure::usage(
            "prompt_too_large",
            "the prompt and stdin together exceed 10 MiB",
        ));
    }
    String::from_utf8(buf).map_err(|_| Failure::usage("stdin_not_utf8", "stdin is not UTF-8 text"))
}

#[cfg(unix)]
mod platform {
    pub fn is_readable() -> bool {
        let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: fstat on fd 0 writes into the buffer only on success.
        if unsafe { libc::fstat(0, st.as_mut_ptr()) } != 0 {
            return false;
        }
        // SAFETY: fstat succeeded, so the struct is initialized.
        let mode = unsafe { st.assume_init() }.st_mode & libc::S_IFMT;
        mode == libc::S_IFIFO || mode == libc::S_IFREG
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_DISK, FILE_TYPE_PIPE};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};

    pub fn is_readable() -> bool {
        // SAFETY: plain queries on this process's own standard handle.
        unsafe {
            let handle = GetStdHandle(STD_INPUT_HANDLE);
            if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                return false;
            }
            matches!(GetFileType(handle), FILE_TYPE_PIPE | FILE_TYPE_DISK)
        }
    }
}
