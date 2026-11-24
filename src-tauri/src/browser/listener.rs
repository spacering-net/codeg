//! Who is serving a loopback address.
//!
//! A grant binds to an origin, and for a site on the internet the origin is
//! the thing itself: nobody but the operator can be `https://mail.example.com`,
//! so "still the same origin" and "still the same site" are one statement.
//! `http://localhost:3000` is not a name, it is a port number. This morning it
//! was the project the person is working on; this afternoon it can be an
//! unrelated admin tool with a session in it, and the tab — still open, still
//! shared, still showing the same address in the toolbar — would hand the
//! second one to an agent on the strength of consent given for the first.
//!
//! So a grant on a loopback address records what was answering there, and the
//! read path checks it. That is the whole of this module: find the program
//! behind a port, well enough to tell it apart from a different program.
//!
//! **It is depth, not a guarantee**, and the shape of the thing it cannot do
//! is worth being precise about. Any process on this machine that can bind the
//! port receives the browser's cookies for that origin on the next request,
//! whatever any grant says; the mitigation for *that* is the profile isolation
//! the built-in browser already has, which keeps `localhost:*` cookies out of
//! the user's everyday browser and vice versa. What this adds is narrower and
//! still worth having: consent given for one program does not silently carry
//! over to the next one to take the port.

use std::net::IpAddr;

use tauri::Url;

use super::agent::ListenerIdentity;

/// The port a grant on `origin` should pin a listener for, or `None` when the
/// address is not one this machine serves.
///
/// Loopback only. A private address (`192.168.1.5:3000`) is just as ambiguous
/// a name, but it belongs to another machine and there is no listener here to
/// look at; pretending otherwise would record an emptiness and call it an
/// identity.
pub fn loopback_port(origin: &str) -> Option<u16> {
    let url = Url::parse(origin).ok()?;
    let host = url.host_str()?;
    // An IPv6 host keeps its brackets in the URL serialization.
    let literal = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    let is_loopback = match literal.parse::<IpAddr>() {
        // 127/8 and ::1. Not the unspecified address: `http://0.0.0.0:3000`
        // does reach a wildcard listener on most stacks, but it is not the
        // address a person shares, and a grant is bound to the string.
        Ok(addr) => addr.is_loopback(),
        // `localhost` and anything under it are reserved for the loopback
        // interface (RFC 6761 §6.3), which is why a browser treats them as a
        // secure context without a certificate.
        Err(_) => {
            let name = host.to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
    };
    if !is_loopback {
        return None;
    }
    // An origin without an explicit port is still served on one: `http://` on
    // 80, `https://` on 443. The pin is about the socket, not about how the
    // address was spelled.
    url.port_or_known_default()
}

/// Whether a listening socket bound to `addr` answers requests to a loopback
/// address — either because it *is* one, or because it took every interface.
fn serves_loopback(addr: IpAddr) -> bool {
    addr.is_loopback() || addr.is_unspecified()
}

/// The program serving `port` on this machine, or `None` when there is no
/// program here this process can name.
///
/// `None` covers three situations on purpose, because they lead to the same
/// decision: nothing is listening, something is listening that belongs to
/// another user, and the probe could not be run at all. In each of them there
/// is no program to compare against, so a pin is not taken and an existing pin
/// is not judged. The check can only ever end a grant by naming two different
/// programs; it never ends one out of ignorance.
///
/// Blocking: it reads the kernel's socket table and, on macOS, runs `lsof`.
/// Callers on an async runtime go through `tokio::task::spawn_blocking`.
pub fn identify(port: u16) -> Option<ListenerIdentity> {
    let pid = imp::listener_pid(port)?;
    let program = imp::program_of(pid)?;
    // A working directory that is missing *here* and present *there* would
    // read as a changed program, so the two probes have to disagree only when
    // the machine really changed. Where the platform can answer, a failure to
    // answer is transient (the process exited mid-probe) and abandons the
    // whole probe; where it cannot answer at all, the field is absent by
    // construction and both probes are absent together.
    let workdir = if imp::WORKDIR_AVAILABLE {
        Some(imp::workdir_of(pid)?)
    } else {
        None
    };
    Some(ListenerIdentity {
        program: Some(program),
        workdir,
    })
}

// ---------------------------------------------------------------------------
// Pure parsers
//
// Compiled on every platform, not just the one that feeds them, so that the
// Linux socket table and the macOS `lsof` output are both exercised by
// `cargo test` wherever it runs. The half that cannot travel is the half that
// asks the kernel; the half that decides what the answer means can.
// ---------------------------------------------------------------------------

/// The inodes of the loopback listeners on `port` in one `/proc/net/tcp`
/// table. Linux reports sockets here and nothing about who holds them;
/// turning an inode into a process is a second step.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn proc_net_listen_inodes(table: &str, port: u16) -> Vec<u64> {
    let mut inodes = Vec::new();
    for line in table.lines().skip(1) {
        let mut fields = line.split_ascii_whitespace();
        let Some(local) = fields.next().and_then(|_sl| fields.next()) else {
            continue;
        };
        let (_rem, state, inode) = match (fields.next(), fields.next(), fields.nth(5)) {
            (Some(rem), Some(state), Some(inode)) => (rem, state, inode),
            _ => continue,
        };
        // 0A is TCP_LISTEN. Every other state is a connection, which says
        // nothing about who will answer the next one.
        if state != "0A" {
            continue;
        }
        let Some((addr, listen_port)) = parse_proc_net_address(local) else {
            continue;
        };
        if listen_port != port || !serves_loopback(addr) {
            continue;
        }
        if let Ok(inode) = inode.parse::<u64>() {
            inodes.push(inode);
        }
    }
    inodes
}

/// `0100007F:1F90` → `127.0.0.1:8080`, and the 32-hex-digit IPv6 form.
///
/// The address is a memory dump of the kernel's `in_addr` / `in6_addr`, so its
/// 32-bit words carry this machine's byte order, while the port beside it is
/// a plain hex `u16`. On the little-endian machines Linux is deployed on that
/// makes `0100007F` read backwards and `1F90` read forwards, which is
/// confusing enough to be worth naming rather than discovering.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_net_address(field: &str) -> Option<(IpAddr, u16)> {
    let (addr, port) = field.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let addr = match addr.len() {
        8 => {
            let raw = u32::from_str_radix(addr, 16).ok()?;
            IpAddr::from(std::net::Ipv4Addr::from(raw.swap_bytes().to_be_bytes()))
        }
        32 => {
            let mut bytes = [0u8; 16];
            for (word, chunk) in bytes.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let raw = u32::from_str_radix(&addr[word * 8..word * 8 + 8], 16).ok()?;
                chunk.copy_from_slice(&raw.swap_bytes().to_be_bytes());
            }
            IpAddr::from(std::net::Ipv6Addr::from(bytes))
        }
        _ => return None,
    };
    Some((addr, port))
}

/// The pids holding a loopback listener on `port`, from `lsof -F pn` output.
///
/// The field format is a stream, not a table: a `p` line opens a process and
/// every `f`/`n` line after it belongs to that process until the next `p`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_lsof_listeners(output: &str, port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    let mut current: Option<u32> = None;
    for line in output.lines() {
        let mut chars = line.chars();
        let Some(tag) = chars.next() else { continue };
        let value = chars.as_str();
        match tag {
            'p' => current = value.parse().ok(),
            'n' => {
                let Some(pid) = current else { continue };
                if lsof_address_serves(value, port) && !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
            _ => {}
        }
    }
    pids
}

/// Whether an `lsof -nP` address names a loopback listener on `port`.
///
/// `-n -P` keeps it numeric, so the forms are `*:3000`, `127.0.0.1:3000` and
/// `[::1]:3000`. `*` is lsof's spelling of the unspecified address.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn lsof_address_serves(name: &str, port: u16) -> bool {
    let Some((addr, listen_port)) = name.rsplit_once(':') else {
        return false;
    };
    if listen_port.parse::<u16>() != Ok(port) {
        return false;
    }
    if addr == "*" {
        return true;
    }
    let addr = addr.strip_prefix('[').and_then(|a| a.strip_suffix(']')).unwrap_or(addr);
    addr.parse::<IpAddr>().is_ok_and(serves_loopback)
}

/// The path on the single `n` line of an `lsof -Fn` answer about one file.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_lsof_path(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.strip_prefix('n'))
        .filter(|path| !path.is_empty())
        .map(str::to_string)
}

/// The one pid among `pids`, or `None` when they disagree.
///
/// Two different programs listening on one port across the two address
/// families is pathological, and choosing between them by scan order would
/// make the pin depend on the kernel's iteration order — it would revoke and
/// restore itself at random. An address that ambiguous is one this module
/// declines to have an opinion about.
fn sole(pids: &[u32]) -> Option<u32> {
    match pids {
        [only] => Some(*only),
        // Dual-stack is the common shape: one process, two sockets.
        [first, rest @ ..] if rest.iter().all(|pid| pid == first) => Some(*first),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Linux: the kernel publishes the socket table as a file, and a socket is
// tied to a process only through that process's own /proc directory.
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod imp {
    use super::{proc_net_listen_inodes, sole};

    pub const WORKDIR_AVAILABLE: bool = true;

    pub fn listener_pid(port: u16) -> Option<u32> {
        let mut inodes = Vec::new();
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(text) = std::fs::read_to_string(table) {
                inodes.extend(proc_net_listen_inodes(&text, port));
            }
        }
        // Both tables were unreadable, or nobody is listening. Either way
        // there is no program here to name.
        if inodes.is_empty() {
            return None;
        }
        sole(&pids_holding(&inodes))
    }

    /// The processes holding any of these sockets.
    ///
    /// One walk for the whole set rather than one per inode: a dual-stack
    /// server contributes two, and they almost always belong to the same
    /// process, so scanning every process's file descriptors twice would find
    /// the same answer twice as slowly.
    ///
    /// `/proc/net/tcp` lists every socket on the machine; `/proc/<pid>/fd` is
    /// readable only for this user's own processes. So a listener owned by
    /// another user is visible as a socket and not as a program, which is the
    /// honest answer: an agent running as this user cannot become that
    /// listener, and if it displaced one it would appear as a program we can
    /// see.
    fn pids_holding(inodes: &[u64]) -> Vec<u32> {
        let needles: Vec<String> = inodes.iter().map(|i| format!("socket:[{i}]")).collect();
        let mut found = Vec::new();
        let Ok(procs) = std::fs::read_dir("/proc") else {
            return found;
        };
        for entry in procs.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
                continue;
            };
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                let Ok(link) = std::fs::read_link(fd.path()) else {
                    continue;
                };
                if needles.iter().any(|needle| link.as_os_str() == needle.as_str()) {
                    found.push(pid);
                    break;
                }
            }
        }
        found
    }

    pub fn program_of(pid: u32) -> Option<String> {
        readlink(&format!("/proc/{pid}/exe"))
    }

    pub fn workdir_of(pid: u32) -> Option<String> {
        readlink(&format!("/proc/{pid}/cwd"))
    }

    /// A deleted binary's link reads as `/path/to/thing (deleted)`, which is
    /// a different string from the one recorded before the deploy that
    /// replaced it. That is a real change of program and is left alone.
    fn readlink(path: &str) -> Option<String> {
        std::fs::read_link(path)
            .ok()?
            .into_os_string()
            .into_string()
            .ok()
    }
}

// ---------------------------------------------------------------------------
// macOS: the socket table is reachable only through `libproc`, whose
// `socket_fdinfo` is a 792-byte struct with an internal union that the `libc`
// crate does not declare. Re-declaring it by hand would put a security check
// on top of hand-copied field offsets, where a mistake reads plausible
// garbage rather than failing; `lsof` is the system's own reader of that
// struct, ships with every install, and is asked here with a fixed argument
// vector and no shell. The executable path needs no such help — `proc_pidpath`
// is one call with a flat buffer.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use std::process::Command;

    use super::{parse_lsof_listeners, parse_lsof_path, sole};

    pub const WORKDIR_AVAILABLE: bool = true;

    /// Absolute: this runs in a security check, and resolving it through
    /// `PATH` would let anything that can set the environment choose which
    /// program answers "who is listening".
    const LSOF: &str = "/usr/sbin/lsof";

    pub fn listener_pid(port: u16) -> Option<u32> {
        let out = lsof(&[
            "-nP",
            "-a",
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
            "-Fpn",
        ])?;
        sole(&parse_lsof_listeners(&out, port))
    }

    pub fn program_of(pid: u32) -> Option<String> {
        // PROC_PIDPATHINFO_MAXSIZE. `proc_pidpath` writes a NUL-terminated
        // path and returns its length, or 0 with errno set — including for a
        // process this user does not own.
        let mut buf = vec![0u8; 4096];
        let written = unsafe {
            libc::proc_pidpath(pid as libc::c_int, buf.as_mut_ptr().cast(), buf.len() as u32)
        };
        if written <= 0 {
            return None;
        }
        buf.truncate(written as usize);
        String::from_utf8(buf).ok()
    }

    pub fn workdir_of(pid: u32) -> Option<String> {
        let out = lsof(&["-nP", "-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])?;
        parse_lsof_path(&out)
    }

    /// `None` only when the command could not be run. Finding nothing is a
    /// successful run with empty output, and lsof exits non-zero for it, so
    /// the status is not consulted.
    fn lsof(args: &[&str]) -> Option<String> {
        let out = Command::new(LSOF).args(args).output().ok()?;
        String::from_utf8(out.stdout).ok()
    }
}

// ---------------------------------------------------------------------------
// Windows: the socket table is a documented API that reports the owning pid
// directly. A process's working directory is not — it lives in that process's
// own PEB, and reading it means an undocumented `NtQueryInformationProcess`
// plus a cross-process read. The field stays absent here rather than being
// obtained that way, so a Windows pin is the executable alone.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use std::os::windows::ffi::OsStringExt;

    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
        MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::{serves_loopback, sole};

    pub const WORKDIR_AVAILABLE: bool = false;

    pub fn listener_pid(port: u16) -> Option<u32> {
        let mut pids = tcp_listeners(port);
        pids.extend(tcp6_listeners(port));
        sole(&pids)
    }

    /// The listener table for one address family, as raw bytes.
    ///
    /// Two calls: the first learns the size, the second fills the buffer. The
    /// table can grow between them (a socket opened elsewhere on the machine),
    /// which the API reports by asking for a larger buffer again — so this
    /// gives up rather than looping forever.
    ///
    /// Giving up on one family leaves the other's answer standing rather than
    /// abandoning the probe. A partial view can be wrong either way — naming a
    /// program that is not the one actually being reached, or missing the one
    /// that is — but a `GetExtendedTcpTable` that cannot answer twice in a row
    /// is a machine in trouble, and neither outcome is worse than the check
    /// not existing.
    fn table(family: u32) -> Option<Vec<u8>> {
        let mut size: u32 = 0;
        for _ in 0..4 {
            let mut buf = vec![0u8; size as usize];
            let ptr = if buf.is_empty() {
                std::ptr::null_mut()
            } else {
                buf.as_mut_ptr().cast()
            };
            let rc = unsafe {
                GetExtendedTcpTable(ptr, &mut size, 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0)
            };
            if rc == NO_ERROR {
                buf.truncate(size as usize);
                return Some(buf);
            }
            if rc != ERROR_INSUFFICIENT_BUFFER {
                return None;
            }
        }
        None
    }

    /// `dwNumEntries: u32` followed by the entries. Where the array begins is
    /// asked of the header struct rather than worked out from alignment: the
    /// answer is the same today, and a wrong guess would not fail — it would
    /// read neighbouring fields as pids.
    fn rows<T: Copy>(buf: &[u8], start: usize) -> Vec<T> {
        let Some(count) = buf.get(..4).map(|n| u32::from_ne_bytes(n.try_into().unwrap())) else {
            return Vec::new();
        };
        let stride = std::mem::size_of::<T>();
        (0..count as usize)
            .map_while(|i| {
                let at = start + i * stride;
                let bytes = buf.get(at..at + stride)?;
                // The buffer came from the OS and is only read here; a copy
                // out of it cannot be misaligned because it goes through
                // `read_unaligned`.
                Some(unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<T>()) })
            })
            .collect()
    }

    /// `dwLocalPort` carries the port in network byte order inside a `u32`.
    fn port_of(raw: u32) -> u16 {
        u16::from_be((raw & 0xffff) as u16)
    }

    fn tcp_listeners(port: u16) -> Vec<u32> {
        let Some(buf) = table(AF_INET as u32) else {
            return Vec::new();
        };
        rows::<MIB_TCPROW_OWNER_PID>(&buf, std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table))
            .into_iter()
            .filter(|row| port_of(row.dwLocalPort) == port)
            .filter(|row| {
                serves_loopback(std::net::Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).into())
            })
            .map(|row| row.dwOwningPid)
            .collect()
    }

    fn tcp6_listeners(port: u16) -> Vec<u32> {
        let Some(buf) = table(AF_INET6 as u32) else {
            return Vec::new();
        };
        rows::<MIB_TCP6ROW_OWNER_PID>(&buf, std::mem::offset_of!(MIB_TCP6TABLE_OWNER_PID, table))
            .into_iter()
            .filter(|row| port_of(row.dwLocalPort) == port)
            .filter(|row| serves_loopback(std::net::Ipv6Addr::from(row.ucLocalAddr).into()))
            .map(|row| row.dwOwningPid)
            .collect()
    }

    pub fn program_of(pid: u32) -> Option<String> {
        // LIMITED_INFORMATION is the right of the two: it is granted for
        // processes at a higher integrity level, where the full query right
        // is refused, and the image path is all this asks for.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) };
        unsafe { CloseHandle(handle) };
        if ok == 0 {
            return None;
        }
        buf.truncate(len as usize);
        Some(std::ffi::OsString::from_wide(&buf).to_string_lossy().into_owned())
    }

    pub fn workdir_of(_pid: u32) -> Option<String> {
        None
    }
}

// ---------------------------------------------------------------------------
// Anywhere else the built-in browser runs on an owned window and this check
// simply has no implementation: every grant is unpinned, which is what the
// grant model did before this module existed.
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod imp {
    pub const WORKDIR_AVAILABLE: bool = false;

    pub fn listener_pid(_port: u16) -> Option<u32> {
        None
    }

    pub fn program_of(_pid: u32) -> Option<String> {
        None
    }

    pub fn workdir_of(_pid: u32) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loopback_origin_names_the_port_its_grant_is_pinned_to() {
        assert_eq!(loopback_port("http://127.0.0.1:8790"), Some(8790));
        assert_eq!(loopback_port("http://localhost:3000"), Some(3000));
        assert_eq!(loopback_port("https://localhost:3000"), Some(3000));
        assert_eq!(loopback_port("http://[::1]:5173"), Some(5173));
        // Anywhere in 127/8, not just the one everybody types.
        assert_eq!(loopback_port("http://127.0.0.2:9000"), Some(9000));
        // Reserved for loopback by RFC 6761, and used by tooling that wants a
        // separate origin per service.
        assert_eq!(loopback_port("http://api.localhost:8080"), Some(8080));
        // The port is served whether or not it was spelled.
        assert_eq!(loopback_port("http://localhost"), Some(80));
        assert_eq!(loopback_port("https://localhost"), Some(443));
    }

    #[test]
    fn an_address_on_another_machine_is_not_pinned() {
        // A private address is every bit as ambiguous a name, but the
        // listener is not on this machine to be looked at.
        assert_eq!(loopback_port("http://192.168.1.5:3000"), None);
        assert_eq!(loopback_port("https://example.com"), None);
        // A host that merely mentions localhost is a different host.
        assert_eq!(loopback_port("http://localhost.example.com"), None);
        assert_eq!(loopback_port("http://notlocalhost"), None);
        assert_eq!(loopback_port("not a url"), None);
    }

    /// A real table, trimmed to the columns and rows that matter: a listener
    /// on 127.0.0.1:8790, a listener on 0.0.0.0:3000, an established
    /// connection on the same port as the first, and a listener bound to a
    /// LAN address.
    const PROC_NET_TCP: &str = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2256 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000 100 0 0 10 0
   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000 100 0 0 10 0
   2: 0100007F:2256 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 41003 1 0000 100 0 0 10 0
   3: 0501A8C0:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41004 1 0000 100 0 0 10 0
";

    #[test]
    fn the_socket_table_yields_the_listener_and_not_the_connection_beside_it() {
        // 0x2256 == 8790, on 127.0.0.1.
        assert_eq!(proc_net_listen_inodes(PROC_NET_TCP, 8790), vec![41001]);
        // 0x0BB8 == 3000, on the wildcard address, which serves loopback too.
        assert_eq!(proc_net_listen_inodes(PROC_NET_TCP, 3000), vec![41002]);
        // 0x1F90 == 8080, but bound to 192.168.1.5: not reachable as
        // localhost, so not the listener a loopback grant is about.
        assert!(proc_net_listen_inodes(PROC_NET_TCP, 8080).is_empty());
        assert!(proc_net_listen_inodes(PROC_NET_TCP, 9999).is_empty());
    }

    #[test]
    fn the_ipv6_table_reads_the_same_way_in_words_of_four_bytes() {
        let table = "\
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52001 1 0000 100 0 0 10 0
   1: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52002 1 0000 100 0 0 10 0
";
        // ::1 — the last word is 0x00000001, byte-swapped in the dump.
        assert_eq!(proc_net_listen_inodes(table, 8080), vec![52001]);
        // :: takes every interface.
        assert_eq!(proc_net_listen_inodes(table, 3000), vec![52002]);
    }

    #[test]
    fn a_hex_address_is_words_of_this_machines_byte_order_and_a_plain_port() {
        assert_eq!(
            parse_proc_net_address("0100007F:1F90"),
            Some(("127.0.0.1".parse().unwrap(), 8080))
        );
        assert_eq!(
            parse_proc_net_address("00000000:0050"),
            Some(("0.0.0.0".parse().unwrap(), 80))
        );
        assert_eq!(parse_proc_net_address("0100007F"), None);
        assert_eq!(parse_proc_net_address("nonsense:1F90"), None);
    }

    #[test]
    fn lsof_fields_are_a_stream_where_a_name_belongs_to_the_pid_above_it() {
        let out = "p3646\nf4\nn*:8791\np4100\nf7\nn127.0.0.1:8791\n";
        assert_eq!(parse_lsof_listeners(out, 8791), vec![3646, 4100]);
        // A second socket under the same pid is the same program.
        let dual = "p3646\nf4\nn127.0.0.1:8791\nf5\nn[::1]:8791\n";
        assert_eq!(parse_lsof_listeners(dual, 8791), vec![3646]);
    }

    #[test]
    fn an_lsof_listener_on_another_interface_or_another_port_is_not_the_one() {
        assert!(lsof_address_serves("*:3000", 3000));
        assert!(lsof_address_serves("127.0.0.1:3000", 3000));
        assert!(lsof_address_serves("[::1]:3000", 3000));
        assert!(lsof_address_serves("[::]:3000", 3000));
        assert!(!lsof_address_serves("192.168.1.5:3000", 3000));
        assert!(!lsof_address_serves("127.0.0.1:3001", 3000));
        assert!(!lsof_address_serves("garbage", 3000));
    }

    #[test]
    fn a_cwd_answer_is_the_one_path_line() {
        assert_eq!(
            parse_lsof_path("p3646\nfcwd\nn/private/tmp\n"),
            Some("/private/tmp".to_string())
        );
        assert_eq!(parse_lsof_path("p3646\nfcwd\n"), None);
        assert_eq!(parse_lsof_path(""), None);
    }

    #[test]
    fn two_programs_on_one_port_are_an_address_this_module_has_no_opinion_about() {
        assert_eq!(sole(&[7]), Some(7));
        // Dual-stack: one process, one answer.
        assert_eq!(sole(&[7, 7]), Some(7));
        assert_eq!(sole(&[7, 9]), None);
        assert_eq!(sole(&[]), None);
    }

    #[test]
    fn the_probe_answers_for_a_port_this_test_is_listening_on() {
        // The one place the platform half is exercised: bind a port, ask who
        // has it, and expect this test binary. It says nothing about *how*
        // the answer was obtained, which is the point — each platform gets to
        // be right in its own way.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        let Some(found) = identify(port) else {
            // A platform with no implementation, or a machine where the probe
            // could not run. Both are "no pin", which is a supported state.
            return;
        };
        let program = found.program.expect("a named program");
        assert!(
            program.contains("browser") || program.contains("codeg") || program.contains("test"),
            "expected this test binary to be named as the listener, got {program}"
        );
        // A port nobody has is nobody's program.
        drop(listener);
        // The kernel can hold the socket briefly in TIME_WAIT, but a listener
        // that is closed has no owning process either way.
        if let Some(after) = identify(port) {
            assert_ne!(after.program.as_deref(), Some(program.as_str()));
        }
    }
}
