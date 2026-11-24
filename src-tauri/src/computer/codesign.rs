//! macOS code-signature checks: who is on the other end of a socket, and what
//! a suspended child is about to run.
//!
//! Both questions are answered by the kernel's view of a *running* process,
//! never by a path: a path names a file, and the files in question sit in
//! places another process of the same user can rewrite. The socket peer is
//! named by the audit token the kernel attaches to the connection
//! (`LOCAL_PEERTOKEN`), which carries the pid *and* its version, so a pid that
//! has been recycled does not resolve to the new process. The child is named
//! by its pid while it is suspended and unreaped — our own child, which no
//! one else can have been given its pid.
//!
//! Security.framework and `csops` are not governed by TCC, so these checks
//! are as safe to run inside codeg as inside the helper.

use std::ffi::{c_int, c_void};
use std::os::fd::RawFd;

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFRelease, CFTypeRef};
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;

use super::driver::DENIED_ENTITLEMENTS;

type SecCodeRef = *const c_void;
type SecRequirementRef = *const c_void;
type OSStatus = i32;
type SecCSFlags = u32;

const K_SEC_CS_DEFAULT_FLAGS: SecCSFlags = 0;
const K_SEC_CS_SIGNING_INFORMATION: SecCSFlags = 1 << 1;
const K_SEC_CS_REQUIREMENT_INFORMATION: SecCSFlags = 1 << 2;

/// `csops` operations and status bits (`<kern/cs_blobs.h>`).
const CS_OPS_STATUS: u32 = 0;
const CS_OPS_CDHASH: u32 = 5;
pub const CS_VALID: u32 = 0x0000_0001;
pub const CS_GET_TASK_ALLOW: u32 = 0x0000_0004;
pub const CS_RUNTIME: u32 = 0x0001_0000;
pub const CS_DEBUGGED: u32 = 0x1000_0000;

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecGuestAttributeAudit: CFStringRef;
    static kSecGuestAttributePid: CFStringRef;
    static kSecCodeInfoIdentifier: CFStringRef;
    static kSecCodeInfoTeamIdentifier: CFStringRef;
    static kSecCodeInfoUnique: CFStringRef;
    static kSecCodeInfoFlags: CFStringRef;
    static kSecCodeInfoEntitlementsDict: CFStringRef;

    fn SecCodeCopyGuestWithAttributes(
        host: SecCodeRef,
        attributes: CFDictionaryRef,
        flags: SecCSFlags,
        guest: *mut SecCodeRef,
    ) -> OSStatus;
    fn SecCodeCheckValidity(
        code: SecCodeRef,
        flags: SecCSFlags,
        requirement: SecRequirementRef,
    ) -> OSStatus;
    fn SecRequirementCreateWithString(
        text: CFStringRef,
        flags: SecCSFlags,
        requirement: *mut SecRequirementRef,
    ) -> OSStatus;
    fn SecCodeCopySigningInformation(
        code: SecCodeRef,
        flags: SecCSFlags,
        information: *mut CFDictionaryRef,
    ) -> OSStatus;
    fn SecCodeCopySelf(flags: SecCSFlags, code: *mut SecCodeRef) -> OSStatus;
}

extern "C" {
    /// libsystem_kernel; not in the `libc` crate.
    fn csops(pid: libc::pid_t, ops: u32, useraddr: *mut c_void, usersize: libc::size_t) -> c_int;
}

/// A Core Foundation object this module owns, released on drop.
struct Owned(CFTypeRef);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: `self.0` came from a Copy/Create call and is released
            // exactly once, here.
            unsafe { CFRelease(self.0) };
        }
    }
}

/// The kernel's name for the process on the other end of a local socket.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct AuditToken(pub [u32; 8]);

impl std::fmt::Debug for AuditToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "AuditToken(pid {}, version {})",
            self.pid(),
            self.pid_version()
        )
    }
}

impl AuditToken {
    /// `audit_token_to_pid`: the sixth word.
    pub fn pid(&self) -> u32 {
        self.0[5]
    }

    /// `audit_token_to_pidversion`: the eighth word. Moves every time a pid
    /// is handed out again.
    pub fn pid_version(&self) -> u32 {
        self.0[7]
    }
}

/// The audit token of the process at the other end of the AF_UNIX socket
/// `fd`.
///
/// For a socketpair this is the last process to have used the *other* end.
/// Both ends of a socketpair start out belonging to whoever created it, so a
/// peer is only meaningful once that other end has been handed over and used
/// — see `protocol`'s note on why the helper speaks first.
pub fn peer_audit_token(fd: RawFd) -> std::io::Result<AuditToken> {
    let mut token = [0u32; 8];
    let mut len = std::mem::size_of_val(&token) as libc::socklen_t;
    // SAFETY: `token` is a 32-byte buffer and `len` says so; the kernel writes
    // at most `len` bytes and reports how many.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERTOKEN,
            token.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if len as usize != std::mem::size_of_val(&token) {
        return Err(std::io::Error::other("short LOCAL_PEERTOKEN"));
    }
    Ok(AuditToken(token))
}

/// Which running process to check.
#[derive(Debug, Clone, Copy)]
pub enum Guest {
    /// A socket peer.
    Audit(AuditToken),
    /// Our own suspended, unreaped child.
    ChildPid(u32),
}

/// What a signature says about a running process, once it has checked out.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodeInfo {
    pub identifier: Option<String>,
    pub team_id: Option<String>,
    /// The code-directory hash, lowercase hex.
    pub cdhash: Option<String>,
    /// The code directory's flags (`0x10000` is the hardened runtime).
    pub flags: Option<u32>,
    /// Every entitlement the signature carries that is not a boolean `false`.
    pub entitlements: Vec<String>,
}

impl CodeInfo {
    /// Refuse a signature carrying any entitlement that would let another
    /// process put code inside this one.
    pub fn entitlements_clean(&self) -> Result<(), String> {
        match self
            .entitlements
            .iter()
            .find(|e| DENIED_ENTITLEMENTS.contains(&e.as_str()))
        {
            Some(denied) => Err(format!("its signature carries {denied}")),
            None => Ok(()),
        }
    }
}

fn status_error(what: &str, status: OSStatus) -> String {
    let name = match status {
        -67050 => " (errSecCSReqFailed: does not satisfy the requirement)",
        -67062 => " (errSecCSUnsigned)",
        -67061 => " (errSecCSSignatureFailed)",
        -67030 => " (errSecCSStaticCodeChanged: the file on disk no longer matches)",
        -67065 => " (errSecCSNoSuchCode)",
        -67052 => " (errSecCSReqInvalid)",
        -67068 => " (errSecCSGuestInvalid)",
        _ => "",
    };
    format!("{what} failed: OSStatus {status}{name}")
}

fn copy_guest(guest: Guest) -> Result<Owned, String> {
    // SAFETY: the extern statics are valid CFStrings for the life of the
    // process; wrapping under the get rule retains nothing we must release.
    let dict = unsafe {
        match guest {
            Guest::Audit(token) => {
                let bytes: Vec<u8> = token.0.iter().flat_map(|w| w.to_ne_bytes()).collect();
                CFDictionary::from_CFType_pairs(&[(
                    CFString::wrap_under_get_rule(kSecGuestAttributeAudit).as_CFType(),
                    CFData::from_buffer(&bytes).as_CFType(),
                )])
            }
            Guest::ChildPid(pid) => {
                let pid = i32::try_from(pid).map_err(|_| "pid out of range".to_string())?;
                CFDictionary::from_CFType_pairs(&[(
                    CFString::wrap_under_get_rule(kSecGuestAttributePid).as_CFType(),
                    CFNumber::from(pid).as_CFType(),
                )])
            }
        }
    };
    let mut code: SecCodeRef = std::ptr::null();
    // SAFETY: a null host means "the system's guest registry"; `dict` is a
    // live dictionary and `code` receives a +1 reference on success.
    let status = unsafe {
        SecCodeCopyGuestWithAttributes(
            std::ptr::null(),
            dict.as_concrete_TypeRef(),
            K_SEC_CS_DEFAULT_FLAGS,
            &mut code,
        )
    };
    if status != 0 {
        return Err(status_error("SecCodeCopyGuestWithAttributes", status));
    }
    Ok(Owned(code))
}

fn check_requirement(code: &Owned, requirement: &str) -> Result<(), String> {
    let text = CFString::new(requirement);
    let mut req: SecRequirementRef = std::ptr::null();
    // SAFETY: `text` is live; `req` receives a +1 reference on success.
    let status = unsafe {
        SecRequirementCreateWithString(text.as_concrete_TypeRef(), K_SEC_CS_DEFAULT_FLAGS, &mut req)
    };
    if status != 0 {
        return Err(status_error("SecRequirementCreateWithString", status));
    }
    let req = Owned(req);
    // SAFETY: both references are live for the call.
    let status = unsafe { SecCodeCheckValidity(code.0, K_SEC_CS_DEFAULT_FLAGS, req.0) };
    if status != 0 {
        return Err(status_error("SecCodeCheckValidity", status));
    }
    Ok(())
}

fn signing_info(code: &Owned) -> Result<CodeInfo, String> {
    let mut raw: CFDictionaryRef = std::ptr::null();
    // SAFETY: `code` is live; `raw` receives a +1 dictionary on success.
    let status = unsafe {
        SecCodeCopySigningInformation(
            code.0,
            K_SEC_CS_SIGNING_INFORMATION | K_SEC_CS_REQUIREMENT_INFORMATION,
            &mut raw,
        )
    };
    if status != 0 {
        return Err(status_error("SecCodeCopySigningInformation", status));
    }
    // SAFETY: a +1 CFDictionary from the call above, released by the wrapper.
    let dict: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(raw) };
    // SAFETY: extern CFString keys, valid for the life of the process.
    let key = |k: CFStringRef| unsafe { CFString::wrap_under_get_rule(k) };
    let string = |k: CFStringRef| {
        dict.find(key(k))
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
    };
    let mut info = CodeInfo {
        // SAFETY for the statics in this block: see `key`.
        identifier: string(unsafe { kSecCodeInfoIdentifier }),
        team_id: string(unsafe { kSecCodeInfoTeamIdentifier }),
        cdhash: dict
            .find(key(unsafe { kSecCodeInfoUnique }))
            .and_then(|v| v.downcast::<CFData>())
            .map(|d| hex(d.bytes())),
        flags: dict
            .find(key(unsafe { kSecCodeInfoFlags }))
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i64())
            .and_then(|n| u32::try_from(n).ok()),
        entitlements: Vec::new(),
    };
    if let Some(ents) = dict
        .find(key(unsafe { kSecCodeInfoEntitlementsDict }))
        .and_then(|v| v.downcast::<CFDictionary>())
    {
        // SAFETY: the dictionary is live; keys come back as borrowed CF refs.
        let ents: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(ents.as_concrete_TypeRef()) };
        let (keys, values) = ents.get_keys_and_values();
        for (k, v) in keys.into_iter().zip(values) {
            // SAFETY: entries of a live dictionary, borrowed.
            let name = unsafe { CFString::wrap_under_get_rule(k as CFStringRef) }.to_string();
            let value = unsafe { CFType::wrap_under_get_rule(v) };
            let off = value
                .downcast::<CFBoolean>()
                .is_some_and(|b| !bool::from(b));
            if !off {
                info.entitlements.push(name);
            }
        }
        info.entitlements.sort();
    }
    Ok(info)
}

/// Check a running process against a designated-requirement string, and read
/// its signature if it passes.
///
/// `SecCodeCheckValidity` on a running process checks the kernel's view of it
/// (still validly signed) and that the code on disk is the code that is
/// running — a file replaced after `exec` fails here rather than passing on
/// the strength of the new file.
pub fn check_guest(guest: Guest, requirement: &str) -> Result<CodeInfo, String> {
    let code = copy_guest(guest)?;
    check_requirement(&code, requirement)?;
    signing_info(&code)
}

/// This process's own signature, unchecked. For the helper's interlock: a
/// helper that carries a Team ID but no compiled-in trust anchors refuses to
/// start.
pub fn self_info() -> Result<CodeInfo, String> {
    let mut code: SecCodeRef = std::ptr::null();
    // SAFETY: `code` receives a +1 reference on success.
    let status = unsafe { SecCodeCopySelf(K_SEC_CS_DEFAULT_FLAGS, &mut code) };
    if status != 0 {
        return Err(status_error("SecCodeCopySelf", status));
    }
    signing_info(&Owned(code))
}

/// The kernel's code-directory hash for the image `pid` is running, lowercase
/// hex. From the kernel, not the file: this is what is actually mapped.
pub fn running_cdhash(pid: u32) -> std::io::Result<String> {
    let pid = libc::pid_t::try_from(pid).map_err(std::io::Error::other)?;
    let mut hash = [0u8; 20];
    // SAFETY: a 20-byte buffer, and CS_OPS_CDHASH writes exactly 20.
    let rc = unsafe { csops(pid, CS_OPS_CDHASH, hash.as_mut_ptr().cast(), hash.len()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(hex(&hash))
}

/// The kernel's code-signing status bits for `pid` (`CS_VALID`,
/// `CS_RUNTIME`, `CS_GET_TASK_ALLOW`, …).
pub fn running_status(pid: u32) -> std::io::Result<u32> {
    let pid = libc::pid_t::try_from(pid).map_err(std::io::Error::other)?;
    let mut flags: u32 = 0;
    // SAFETY: a u32 out-parameter, which is what CS_OPS_STATUS writes.
    let rc = unsafe {
        csops(
            pid,
            CS_OPS_STATUS,
            (&mut flags as *mut u32).cast(),
            std::mem::size_of::<u32>(),
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(flags)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The test binary is running, so the kernel knows its cdhash and status,
    /// and its own signature can be read (ad-hoc, linker-signed: no Team ID).
    #[test]
    fn the_kernel_describes_this_process() {
        let me = std::process::id();
        let cdhash = running_cdhash(me).expect("a running process has a cdhash");
        assert_eq!(cdhash.len(), 40);
        let status = running_status(me).expect("and a status");
        assert_ne!(status & CS_VALID, 0);

        let info = self_info().expect("its own signature");
        assert_eq!(info.cdhash.as_deref(), Some(cdhash.as_str()));
    }

    /// A requirement this process cannot meet is refused with the framework's
    /// reason, and a malformed one is refused before any check runs.
    #[test]
    fn an_unmet_requirement_is_refused() {
        let me = Guest::ChildPid(std::process::id());
        let err = check_guest(
            me,
            "anchor apple generic and certificate leaf[subject.OU] = \"XXXXXXXXXX\"",
        )
        .unwrap_err();
        assert!(err.contains("SecCodeCheckValidity"), "{err}");
        assert!(check_guest(me, "this is not a requirement").is_err());
    }

    /// The peer of one end of a socketpair is whoever last used the other end
    /// — at first, the creator.
    #[test]
    fn a_socketpair_peer_is_named_by_the_kernel() {
        let (a, b) = std::os::unix::net::UnixStream::pair().unwrap();
        use std::os::fd::AsRawFd;
        let token = peer_audit_token(a.as_raw_fd()).unwrap();
        assert_eq!(token.pid(), std::process::id());
        drop(b);
    }

    #[test]
    fn a_denied_entitlement_is_named() {
        let info = CodeInfo {
            entitlements: vec![
                "com.apple.security.device.screen-capture".into(),
                "com.apple.security.cs.allow-dyld-environment-variables".into(),
            ],
            ..CodeInfo::default()
        };
        assert!(info
            .entitlements_clean()
            .unwrap_err()
            .contains("allow-dyld"));
        assert!(CodeInfo::default().entitlements_clean().is_ok());
    }
}
