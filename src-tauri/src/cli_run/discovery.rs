//! Discovery files: how a `codeg-cli` on this machine finds the runtimes it
//! may talk to, and the token for each.
//!
//! Every runtime with command-line access on publishes
//! `<data_dir>/cli/endpoint-<pid>.json` — one file per process, because a
//! desktop app and a server can share a data directory, debug and release
//! desktops share theirs, and a restart briefly overlaps the old and the new
//! process. The token in it is the key to running agents as the user, so the
//! file's secrecy never rests on the data directory's own permissions
//! (`CODEG_DATA_DIR` can point anywhere): the `cli/` directory is created
//! private (0700, or with a protected owner-only DACL from its first moment),
//! an existing one that belongs to another user is refused (on Unix also one
//! that is not private; on Windows one of ours is made private again), and
//! the file itself is created private and renamed into place. Where privacy
//! cannot be established, nothing is published and the CLI can only reach
//! the runtime with `--url`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::wire::{BuildKind, RuntimeKind};

/// The directory under the data dir.
pub const DIR: &str = "cli";

/// Exported by each runtime to everything it starts (agents, terminals): the
/// discovery file of THAT runtime, so a CLI run from inside codeg connects
/// back to the codeg it runs in.
pub const ENDPOINT_FILE_ENV: &str = "CODEG_CLI_ENDPOINT_FILE";

/// One runtime's discovery file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryRecord {
    /// `http://127.0.0.1:<port>`.
    pub url: String,
    pub token: String,
    pub pid: u32,
    pub runtime: RuntimeKind,
    pub build: BuildKind,
    pub version: String,
    pub api_version: u32,
    pub data_dir: String,
    /// RFC 3339.
    pub started_at: String,
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR)
}

/// The discovery file process `pid` publishes for `data_dir`.
pub fn file_for(data_dir: &Path, pid: u32) -> PathBuf {
    dir(data_dir).join(format!("endpoint-{pid}.json"))
}

/// The pid an `endpoint-<pid>.json` name carries.
pub fn pid_of(path: &Path) -> Option<u32> {
    path.file_name()?
        .to_str()?
        .strip_prefix("endpoint-")?
        .strip_suffix(".json")?
        .parse()
        .ok()
}

/// The private discovery directory, checked and held: records are published
/// through it, so the folder that was checked is the one written to.
#[derive(Debug)]
pub struct PreparedDir(platform::OpenDir);

/// Create the private discovery directory, or check that an existing one is
/// private. `Err` explains why nothing may be published there.
pub fn prepare_dir(dir: &Path) -> Result<PreparedDir, String> {
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    platform::prepare_dir(dir).map(PreparedDir)
}

/// Publish `record` as `path`'s file name in `dir`: written to a private
/// temporary file there, then renamed over the name, so a reader never sees
/// half a file.
pub fn write_record(
    dir: &PreparedDir,
    path: &Path,
    record: &DiscoveryRecord,
) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    platform::publish(&dir.0, name, &json)
}

/// Read every discovery file in `dir`, oldest name order. Unreadable or
/// malformed files come back as errors, so a caller can say what it skipped.
pub fn read_records(dir: &Path) -> Vec<(PathBuf, Result<DiscoveryRecord, String>)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| pid_of(p).is_some())
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|p| {
            let record = read_record(&p);
            (p, record)
        })
        .collect()
}

/// A discovery file, read only when it is a file of this user's: one that
/// someone else put there — in a folder open to them, or one they own —
/// would point the CLI at their listener with a token of their choosing,
/// which passes the hello proof.
pub fn read_record(path: &Path) -> Result<DiscoveryRecord, String> {
    // Opened once, and checked and read through that one open file: a
    // folder renamed in between (by someone who may rename in its parent)
    // cannot slip another file under the name after the check.
    let bytes = platform::read_own(path)?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// Delete the discovery files of processes that no longer exist. A file of a
/// live process — including another user's, which the OS will not let us
/// signal — stays.
pub fn sweep_stale(dir: &Path) {
    let own = std::process::id();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(pid) = pid_of(&path) {
            if pid != own && pid_is_dead(pid) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Only proof that the process is gone counts as dead: on Unix `kill(pid, 0)`
/// failing with `ESRCH` (`EPERM` is someone else's live process), on Windows
/// `OpenProcess` rejecting the id outright.
pub fn pid_is_dead(pid: u32) -> bool {
    platform::pid_is_dead(pid)
}

#[cfg(unix)]
mod platform {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    /// The checked folder, held open.
    #[derive(Debug)]
    pub struct OpenDir(std::fs::File);

    pub fn prepare_dir(dir: &Path) -> Result<OpenDir, String> {
        match std::fs::DirBuilder::new().mode(0o700).create(dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("cannot create {}: {e}", dir.display())),
        }
        // Everything below goes through this one open folder (no link
        // followed): the name cannot be pointed elsewhere in between.
        let opened = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(dir)
            .map_err(|e| {
                format!(
                    "{} is not a folder this process can use: {e}",
                    dir.display()
                )
            })?;
        let meta = opened
            .metadata()
            .map_err(|e| format!("cannot inspect {}: {e}", dir.display()))?;
        if !meta.file_type().is_dir() {
            return Err(format!("{} is not a directory", dir.display()));
        }
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if meta.uid() != euid {
            return Err(format!(
                "{} belongs to uid {}, not to this process ({euid})",
                dir.display(),
                meta.uid()
            ));
        }
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(format!(
                "{} is readable by other users (mode {:o}); make it 0700",
                dir.display(),
                meta.permissions().mode() & 0o777
            ));
        }
        // macOS keeps access-list entries apart from the mode bits, and a
        // folder inherits them from its parent: a 0700 one can still let
        // others in. One with any entry is refused — and left as it is: an
        // access list is someone's decision, never this process's to undo.
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::io::AsRawFd;
            if super::macos_acl::fd_has_entries(opened.as_raw_fd())? {
                return Err(format!(
                    "{} has an access list (perhaps inherited from the folder above), which \
                     may let other users in; remove it (chmod -N) and any inheritable entry \
                     above it, or use another data directory",
                    dir.display()
                ));
            }
        }
        Ok(OpenDir(opened))
    }

    /// `bytes` published as `name` in the open folder: a private temporary
    /// file created there (0600, exclusive, no link followed), then renamed
    /// over `name` — both relative to the folder's handle, so a folder
    /// renamed in the meantime is not where anything is written.
    pub fn publish(dir: &OpenDir, name: &str, bytes: &[u8]) -> Result<(), String> {
        use std::ffi::CString;
        use std::os::unix::io::{AsRawFd, FromRawFd};
        let dirfd = dir.0.as_raw_fd();
        let tmp = format!(".{name}.tmp-{}", super::super::hello::random_hex(6));
        let c_tmp = CString::new(tmp).map_err(|e| e.to_string())?;
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        // SAFETY: a valid folder descriptor and NUL-terminated names; the new
        // descriptor is owned by the File below.
        let fd = unsafe {
            libc::openat(
                dirfd,
                c_tmp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600 as libc::c_uint,
            )
        };
        if fd < 0 {
            return Err(format!(
                "cannot create the record: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: `fd` was just returned by openat and nothing else owns it.
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let written = (|| {
            // Created in a folder checked to have none, it inherits none; say
            // so rather than assume it.
            #[cfg(target_os = "macos")]
            if super::macos_acl::fd_has_entries(file.as_raw_fd())? {
                return Err("the new record came with an access list".to_string());
            }
            file.write_all(bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            // SAFETY: as above, both names relative to the same folder.
            if unsafe { libc::renameat(dirfd, c_tmp.as_ptr(), dirfd, c_name.as_ptr()) } != 0 {
                return Err(format!(
                    "cannot publish the record: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        })();
        if written.is_err() {
            // SAFETY: as above.
            unsafe { libc::unlinkat(dirfd, c_tmp.as_ptr(), 0) };
        }
        written
    }

    /// A discovery file's bytes, if it is a regular file (no link followed)
    /// of this user's that no one else may write — all checked through the
    /// one open file it is read from. Non-blocking, so a FIFO planted under
    /// the name cannot hang the CLI before it is seen not to be a file.
    pub fn read_own(path: &Path) -> Result<Vec<u8>, String> {
        use std::io::Read;
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|e| format!("not a file of this user's ({e})"))?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if !meta.file_type().is_file() || meta.uid() != euid {
            return Err("it is not this user's file".to_string());
        }
        if meta.permissions().mode() & 0o022 != 0 {
            return Err("other users may write to it".to_string());
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::io::AsRawFd;
            if super::macos_acl::fd_has_entries(file.as_raw_fd())? {
                return Err("an access list lets other users at it".to_string());
            }
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes)
    }

    pub fn pid_is_dead(pid: u32) -> bool {
        let Ok(pid) = i32::try_from(pid) else {
            return true;
        };
        if pid <= 0 {
            return true;
        }
        // SAFETY: signal 0 only checks that the process exists.
        let rc = unsafe { libc::kill(pid, 0) };
        rc == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

/// macOS access lists, through the system's own `acl_*` calls.
#[cfg(target_os = "macos")]
mod macos_acl {
    #[allow(non_camel_case_types)]
    type acl_t = *mut libc::c_void;
    const ACL_TYPE_EXTENDED: libc::c_int = 0x0000_0100;
    const ACL_FIRST_ENTRY: libc::c_int = 0;

    extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> acl_t;
        fn acl_get_entry(
            acl: acl_t,
            entry_id: libc::c_int,
            entry: *mut *mut libc::c_void,
        ) -> libc::c_int;
        fn acl_free(obj: *mut libc::c_void) -> libc::c_int;
    }

    /// A filesystem that keeps no access lists (FAT, some network shares):
    /// there is none to read, and the mode bits are all there is.
    fn unsupported(err: &std::io::Error) -> bool {
        matches!(
            err.raw_os_error(),
            Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP)
        )
    }

    /// Whether the open file `fd` has any access-list entry.
    pub fn fd_has_entries(fd: libc::c_int) -> Result<bool, String> {
        // SAFETY: `fd` is open for the duration; the ACL is freed below.
        unsafe {
            let acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
            if acl.is_null() {
                let err = std::io::Error::last_os_error();
                return if err.raw_os_error() == Some(libc::ENOENT) || unsupported(&err) {
                    Ok(false)
                } else {
                    Err(format!("cannot read its access list: {err}"))
                };
            }
            let mut entry: *mut libc::c_void = std::ptr::null_mut();
            let any = acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) == 0;
            acl_free(acl);
            Ok(any)
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_INVALID_PARAMETER,
        GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
        SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetSecurityDescriptorDacl, GetTokenInformation, TokenOwner, TokenUser, ACL,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_INFORMATION_CLASS, TOKEN_OWNER,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Full control for the owner only, inherited by everything created
    /// inside, and protected from inheriting anything from above.
    const OWNER_ONLY: &str = "D:P(A;OICI;FA;;;OW)";

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// The owner-only security descriptor, freed on drop.
    struct OwnerOnly(PSECURITY_DESCRIPTOR);

    impl OwnerOnly {
        fn new() -> Result<Self, String> {
            let sddl = wide(OWNER_ONLY);
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            // SAFETY: valid NUL-terminated SDDL; `sd` receives a LocalAlloc'd
            // descriptor, freed by Drop.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(format!("cannot build an owner-only DACL: {}", unsafe {
                    GetLastError()
                }));
            }
            Ok(Self(sd))
        }

        /// For creating an object with this descriptor from the start, so it
        /// is never, even briefly, open to anyone else.
        fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0,
                bInheritHandle: 0,
            }
        }

        /// Replace `path`'s DACL with this one.
        fn apply(&self, path: &Path) -> Result<(), String> {
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl: *mut ACL = std::ptr::null_mut();
            // SAFETY: `self.0` is a valid descriptor.
            let got = unsafe {
                GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted)
            };
            if got == 0 || present == 0 {
                return Err("the owner-only descriptor has no DACL".to_string());
            }
            let path = wide_path(path);
            // SAFETY: valid path and DACL; only the DACL is replaced.
            let rc = unsafe {
                SetNamedSecurityInfoW(
                    path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    dacl,
                    std::ptr::null(),
                )
            };
            if rc == 0 {
                Ok(())
            } else {
                Err(format!("cannot restrict access: error {rc}"))
            }
        }
    }

    impl Drop for OwnerOnly {
        fn drop(&mut self) {
            // SAFETY: allocated by ConvertStringSecurityDescriptor…W.
            unsafe { LocalFree(self.0 as _) };
        }
    }

    /// One SID-holding piece of this process's token (`TokenUser`,
    /// `TokenOwner`), copied out. 8-aligned: the structures hold pointers.
    fn token_info(class: TOKEN_INFORMATION_CLASS) -> Result<Vec<u64>, String> {
        // SAFETY: a query-only token handle, closed below; buffers are sized
        // by the first call.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(format!("cannot open the process token: {}", GetLastError()));
            }
            let mut len = 0u32;
            GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut len);
            let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
            let ok = GetTokenInformation(token, class, buf.as_mut_ptr().cast(), len, &mut len);
            let err = GetLastError();
            CloseHandle(token);
            if ok == 0 {
                return Err(format!("cannot read the process token: {err}"));
            }
            Ok(buf)
        }
    }

    /// Whether `path` — a regular file, or a directory, and not a link —
    /// belongs to this process's user, or to the owner it gives what it
    /// creates (an elevated one makes the Administrators group the owner).
    fn owned_by_us(path: &Path) -> Result<bool, String> {
        let kind = std::fs::symlink_metadata(path)
            .map_err(|e| e.to_string())?
            .file_type();
        if kind.is_symlink() || !(kind.is_file() || kind.is_dir()) {
            return Ok(false);
        }
        let user = token_info(TokenUser)?;
        let owner = token_info(TokenOwner)?;
        let wide = wide_path(path);
        let mut file_owner: PSID = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: valid path; the owner SID points into `sd`, freed below.
        let rc = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut file_owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut sd,
            )
        };
        if rc != 0 {
            return Err(format!(
                "cannot read who owns {}: error {rc}",
                path.display()
            ));
        }
        // SAFETY: the buffers hold a TOKEN_USER and a TOKEN_OWNER, whose SIDs
        // point into the same buffers; `file_owner` is valid until `sd` goes.
        let ours = unsafe {
            let user_sid = (*(user.as_ptr() as *const TOKEN_USER)).User.Sid;
            let owner_sid = (*(owner.as_ptr() as *const TOKEN_OWNER)).Owner;
            EqualSid(file_owner, user_sid) != 0 || EqualSid(file_owner, owner_sid) != 0
        };
        // SAFETY: allocated by GetNamedSecurityInfoW.
        unsafe { LocalFree(sd as _) };
        Ok(ours)
    }

    /// A discovery file's bytes, if it is a regular file (a link is opened
    /// as itself, not followed) whose owner is this user — the owner read
    /// from the same open handle the bytes then come from.
    pub fn read_own(path: &Path) -> Result<Vec<u8>, String> {
        use std::io::Read;
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|e| format!("not a file of this user's ({e})"))?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.file_type().is_file() || !handle_owned_by_us(file.as_raw_handle() as HANDLE)? {
            return Err("it is not this user's file".to_string());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes)
    }

    /// Whether the object open as `handle` belongs to this process's user (or
    /// to the default owner it gives what it creates).
    fn handle_owned_by_us(handle: HANDLE) -> Result<bool, String> {
        use windows_sys::Win32::Security::Authorization::GetSecurityInfo;
        let user = token_info(TokenUser)?;
        let owner = token_info(TokenOwner)?;
        let mut file_owner: PSID = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: an open handle; the owner SID points into `sd`, freed below.
        let rc = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut file_owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut sd,
            )
        };
        if rc != 0 {
            return Err(format!("cannot read who owns it: error {rc}"));
        }
        // SAFETY: as in `owned_by_us`.
        let ours = unsafe {
            let user_sid = (*(user.as_ptr() as *const TOKEN_USER)).User.Sid;
            let owner_sid = (*(owner.as_ptr() as *const TOKEN_OWNER)).Owner;
            EqualSid(file_owner, user_sid) != 0 || EqualSid(file_owner, owner_sid) != 0
        };
        // SAFETY: allocated by GetSecurityInfo.
        unsafe { LocalFree(sd as _) };
        Ok(ours)
    }

    /// The checked folder: every file in it is created with its own
    /// protected owner-only descriptor, so what it inherits cannot matter.
    #[derive(Debug)]
    pub struct OpenDir(std::path::PathBuf);

    /// `bytes` published as `name` in the folder: a private temporary file
    /// (owner-only from its first moment), then renamed over `name`.
    pub fn publish(dir: &OpenDir, name: &str, bytes: &[u8]) -> Result<(), String> {
        let tmp = dir.0.join(format!(
            ".{name}.tmp-{}",
            super::super::hello::random_hex(6)
        ));
        let result = write_private(&tmp, bytes)
            .and_then(|()| std::fs::rename(&tmp, dir.0.join(name)).map_err(|e| e.to_string()));
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }

    pub fn prepare_dir(dir: &Path) -> Result<OpenDir, String> {
        let sd = OwnerOnly::new()?;
        let attributes = sd.attributes();
        let wide = wide_path(dir);
        // Created owner-only from the start: no moment in which someone else
        // could open it.
        // SAFETY: valid path and attributes.
        if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
            let err = unsafe { GetLastError() };
            if err != ERROR_ALREADY_EXISTS {
                return Err(format!("cannot create {}: error {err}", dir.display()));
            }
        }
        if !std::fs::symlink_metadata(dir)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_dir()
        {
            return Err(format!("{} is not a directory", dir.display()));
        }
        // One that was already there must be ours: whoever owns it can swap
        // the file in it for one of their own.
        if !owned_by_us(dir)? {
            return Err(format!("{} belongs to another user", dir.display()));
        }
        sd.apply(dir)?;
        Ok(OpenDir(dir.to_path_buf()))
    }

    fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
        let sd = OwnerOnly::new()?;
        let attributes = sd.attributes();
        let wide = wide_path(path);
        // Owner-only from the start, and opened by no one else while the token
        // goes in (no sharing).
        // SAFETY: valid path and attributes; the handle is owned below.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_WRITE,
                0,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "cannot create {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: a fresh handle nothing else owns.
        let mut file = unsafe { std::fs::File::from_raw_handle(handle as _) };
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }

    pub fn pid_is_dead(pid: u32) -> bool {
        // SAFETY: plain query; the handle, when one is returned, is closed.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return GetLastError() == ERROR_INVALID_PARAMETER;
            }
            CloseHandle(handle);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(pid: u32) -> DiscoveryRecord {
        DiscoveryRecord {
            url: "http://127.0.0.1:4100".into(),
            token: "secret".into(),
            pid,
            runtime: RuntimeKind::Server,
            build: BuildKind::Release,
            version: "0.0.0".into(),
            api_version: 1,
            data_dir: "/data".into(),
            started_at: "2026-10-17T00:00:00Z".into(),
        }
    }

    #[test]
    fn a_record_round_trips_through_its_private_file() {
        let data = tempfile::tempdir().unwrap();
        let d = dir(data.path());
        let prepared = prepare_dir(&d).unwrap();
        let path = file_for(data.path(), 42);
        write_record(&prepared, &path, &record(42)).unwrap();
        assert_eq!(read_record(&path).unwrap(), record(42));
        assert_eq!(pid_of(&path), Some(42));
        let listed = read_records(&d);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].1.as_ref().unwrap(), &record(42));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&d), 0o700);
            assert_eq!(mode(&path), 0o600);
        }
        // No temporary file is left behind.
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
    }

    /// A link, even to a well-formed record, is not this user's file: the
    /// CLI would otherwise follow it to whatever someone else put there.
    #[cfg(unix)]
    #[test]
    fn only_this_users_own_files_are_read() {
        let data = tempfile::tempdir().unwrap();
        let d = dir(data.path());
        let prepared = prepare_dir(&d).unwrap();
        let real = file_for(data.path(), 42);
        write_record(&prepared, &real, &record(42)).unwrap();
        let link = file_for(data.path(), 43);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert!(read_record(&real).is_ok());
        let err = read_record(&link).unwrap_err();
        assert!(err.contains("this user's"), "{err}");
        let listed = read_records(&d);
        assert_eq!(listed.iter().filter(|(_, r)| r.is_ok()).count(), 1);
    }

    /// A record others may write is not trusted, even one of this user's.
    #[cfg(unix)]
    #[test]
    fn a_record_others_may_write_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let prepared = prepare_dir(&dir(data.path())).unwrap();
        let path = file_for(data.path(), 42);
        write_record(&prepared, &path, &record(42)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o620)).unwrap();
        let err = read_record(&path).unwrap_err();
        assert!(err.contains("may write"), "{err}");
    }

    /// macOS: a `cli` folder with an access-list entry — inherited from the
    /// data directory, or given to one already there — is refused and left
    /// as it is; a record with an entry is not read.
    #[cfg(target_os = "macos")]
    #[test]
    fn access_lists_are_refused_and_left_as_they_are() {
        use std::os::unix::io::AsRawFd;
        let chmod = |args: &[&str]| {
            let done = std::process::Command::new("/bin/chmod")
                .args(args)
                .output()
                .unwrap();
            assert!(
                done.status.success(),
                "{}",
                String::from_utf8_lossy(&done.stderr)
            );
        };
        let fd_has = |p: &Path| {
            let f = std::fs::File::open(p).unwrap();
            macos_acl::fd_has_entries(f.as_raw_fd()).unwrap()
        };

        let inheriting = tempfile::tempdir().unwrap();
        chmod(&[
            "+a",
            "everyone allow list,add_file,read,write,file_inherit,directory_inherit",
            inheriting.path().to_str().unwrap(),
        ]);
        let d = dir(inheriting.path());
        let err = prepare_dir(&d).unwrap_err();
        assert!(err.contains("access list"), "{err}");
        assert!(
            fd_has(&d),
            "nothing cleared: what it inherited is still there"
        );

        let data = tempfile::tempdir().unwrap();
        let prepared = prepare_dir(&dir(data.path())).unwrap();
        let path = file_for(data.path(), 42);
        write_record(&prepared, &path, &record(42)).unwrap();
        assert!(read_record(&path).is_ok());
        chmod(&["+a", "everyone allow write", path.to_str().unwrap()]);
        let err = read_record(&path).unwrap_err();
        assert!(err.contains("access list"), "{err}");

        // Already there, with a list someone gave it: not touched, refused.
        let other = tempfile::tempdir().unwrap();
        let d = dir(other.path());
        std::fs::create_dir(&d).unwrap();
        std::fs::set_permissions(&d, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
        chmod(&["+a", "everyone deny add_file", d.to_str().unwrap()]);
        let err = prepare_dir(&d).unwrap_err();
        assert!(err.contains("access list"), "{err}");
        assert!(fd_has(&d), "left as it was");
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_others_can_read_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let d = dir(data.path());
        std::fs::create_dir(&d).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = prepare_dir(&d).unwrap_err();
        assert!(err.contains("readable by other users"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn only_a_vanished_pid_is_dead() {
        assert!(!pid_is_dead(std::process::id()));
        // pid 1 is alive and, for a normal user, cannot be signalled: EPERM
        // is someone else's live process, not a dead one.
        assert!(!pid_is_dead(1));
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(pid_is_dead(pid));
    }

    #[cfg(unix)]
    #[test]
    fn the_sweep_removes_only_dead_processes_files() {
        let data = tempfile::tempdir().unwrap();
        let d = dir(data.path());
        let prepared = prepare_dir(&d).unwrap();
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        let own = std::process::id();
        for pid in [dead, own, 1] {
            write_record(&prepared, &file_for(data.path(), pid), &record(pid)).unwrap();
        }
        std::fs::write(d.join("notes.txt"), "keep").unwrap();
        sweep_stale(&d);
        assert!(!file_for(data.path(), dead).exists());
        assert!(file_for(data.path(), own).exists());
        assert!(file_for(data.path(), 1).exists());
        assert!(d.join("notes.txt").exists());
    }
}
