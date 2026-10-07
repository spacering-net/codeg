//! Whether the person's session can take input right now.
//!
//! A locked screen, or a session another user has switched to, is a desktop
//! nobody is watching: whatever an agent does there goes unseen until the
//! person is back, and on Windows it would land on the lock screen's own
//! desktop. The helper asks just before each action's driver call, and does
//! not act unless the answer is an affirmative "unlocked". The driver does
//! not ask at all.

/// What the platform says about the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// Unlocked, and the one on the console.
    Unlocked,
    /// Locked, or another user's session is on the console.
    Locked,
    /// The platform gave no answer this code can read. Treated as "do not
    /// act": an action nobody can be sure someone is watching is not one to
    /// take.
    Unknown,
}

/// The session as macOS describes it: on the console (`kCGSessionOnConsoleKey`
/// true) and not showing the lock screen (`CGSSessionScreenIsLocked` absent or
/// false — the key is only there while the screen is locked).
#[cfg(target_os = "macos")]
pub fn state() -> SessionState {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::dictionary::CFDictionaryRef;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    }

    // SAFETY: no arguments; returns a +1 dictionary, or null outside a GUI
    // session.
    let raw = unsafe { CGSessionCopyCurrentDictionary() };
    if raw.is_null() {
        return SessionState::Unknown;
    }
    // SAFETY: the +1 dictionary from above, released by the wrapper.
    let session: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(raw) };
    let flag = |key: &'static str| {
        session
            .find(CFString::from_static_string(key))
            .and_then(|v| v.downcast::<CFBoolean>())
            .map(bool::from)
    };
    match (
        flag("kCGSSessionOnConsoleKey"),
        flag("CGSSessionScreenIsLocked"),
    ) {
        (_, Some(true)) | (Some(false), _) => SessionState::Locked,
        (Some(true), _) => SessionState::Unlocked,
        (None, _) => SessionState::Unknown,
    }
}

/// The input desktop is the user's own `Default` one — the lock screen and
/// the UAC prompt run on the secure desktop, which a user-level process
/// cannot even open.
#[cfg(windows)]
pub fn state() -> SessionState {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
    };
    // SAFETY: plain Win32 calls with valid arguments; the handle is closed
    // before returning.
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return SessionState::Locked;
        }
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            (name.len() * 2) as u32,
            &mut needed,
        );
        CloseDesktop(desktop);
        if ok == 0 {
            return SessionState::Unknown;
        }
        let len = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        if String::from_utf16_lossy(&name[..len]) == "Default" {
            SessionState::Unlocked
        } else {
            SessionState::Locked
        }
    }
}

/// Linux: affirmatively unlocked only when two things agree — logind says
/// the session this process is in is active (the one on its seat's console)
/// and not locked (`LockedHint`), and the desktop's own screen saver, asked
/// over the session bus, says it is not on. Anything less is "cannot be
/// told": a desktop with no screen-saver service to ask — a window manager
/// with a locker of its own, like i3 with i3lock — tells nobody when its
/// screen is locked, and an action there could land on the lock screen.
///
/// Asked with `dbus-send`, under one budget for the whole question
/// ([`SESSION_BUDGET`]); a service is asked only if it is running, so asking
/// starts nothing.
#[cfg(target_os = "linux")]
pub fn state() -> SessionState {
    let deadline = std::time::Instant::now() + SESSION_BUDGET;
    let session = |property: &str| {
        let property = format!("string:{property}");
        dbus_reply(
            deadline,
            &[
                "--system",
                "--dest=org.freedesktop.login1",
                "/org/freedesktop/login1/session/auto",
                "org.freedesktop.DBus.Properties.Get",
                "string:org.freedesktop.login1.Session",
                property.as_str(),
            ],
        )
        .as_deref()
        .and_then(reply_bool)
    };
    match (session("Active"), session("LockedHint")) {
        (Some(true), Some(false)) => {}
        (Some(_), Some(_)) => return SessionState::Locked,
        _ => return SessionState::Unknown,
    }
    let Some(running) = dbus_reply(
        deadline,
        &[
            "--session",
            "--dest=org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus.ListNames",
        ],
    ) else {
        return SessionState::Unknown;
    };
    let running = reply_strings(&running);
    for (service, path) in SCREEN_SAVERS {
        if !running.iter().any(|name| name == service) {
            continue;
        }
        let dest = format!("--dest={service}");
        let method = format!("{service}.GetActive");
        match dbus_reply(deadline, &["--session", &dest, path, &method])
            .as_deref()
            .and_then(reply_bool)
        {
            Some(true) => return SessionState::Locked,
            Some(false) => return SessionState::Unlocked,
            None => continue,
        }
    }
    SessionState::Unknown
}

/// The screen savers the desktops run, by bus name and object: KDE and the
/// freedesktop one most desktops answer to, then GNOME's, Cinnamon's,
/// MATE's and Xfce's own. Each has `GetActive` under its own name.
#[cfg(any(test, target_os = "linux"))]
const SCREEN_SAVERS: [(&str, &str); 6] = [
    (
        "org.freedesktop.ScreenSaver",
        "/org/freedesktop/ScreenSaver",
    ),
    ("org.freedesktop.ScreenSaver", "/ScreenSaver"),
    ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"),
    ("org.cinnamon.ScreenSaver", "/org/cinnamon/ScreenSaver"),
    ("org.mate.ScreenSaver", "/org/mate/ScreenSaver"),
    ("org.xfce.ScreenSaver", "/org/xfce/ScreenSaver"),
];

/// How long the whole question may take, every `dbus-send` together.
#[cfg(target_os = "linux")]
const SESSION_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// Run `dbus-send --print-reply` with `args`, and return its reply; `None`
/// when it fails, or does not answer before `deadline`. Found at the
/// system's own path, not on `PATH`, and given none of this process's
/// environment but the session bus's address.
#[cfg(target_os = "linux")]
fn dbus_reply(deadline: std::time::Instant, args: &[&str]) -> Option<String> {
    use std::process::{Command, Stdio};
    let left = deadline.checked_duration_since(std::time::Instant::now())?;
    let program = ["/usr/bin/dbus-send", "/bin/dbus-send"]
        .into_iter()
        .find(|path| std::path::Path::new(path).is_file())?;
    let mut command = Command::new(program);
    command
        .env_clear()
        .arg("--print-reply")
        .arg(format!("--reply-timeout={}", left.as_millis().max(1)))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for key in ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().ok()?;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut reply = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut reply).ok()?;
    Some(reply)
}

/// The boolean in a `dbus-send --print-reply` answer (`boolean true`, or
/// `variant boolean false` for a property).
#[cfg(any(test, target_os = "linux"))]
fn reply_bool(reply: &str) -> Option<bool> {
    let mut words = reply.split_whitespace().skip_while(|w| *w != "boolean");
    words.next()?;
    match words.next()? {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// The strings in a `dbus-send --print-reply` answer (`string "…"`, one a
/// line) — the names `ListNames` gives.
#[cfg(any(test, target_os = "linux"))]
fn reply_strings(reply: &str) -> Vec<String> {
    reply
        .lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix("string \"")?;
            Some(rest.strip_suffix('"')?.to_string())
        })
        .collect()
}

/// Elsewhere there is no one question to ask — so no action is taken there.
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub fn state() -> SessionState {
    SessionState::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The boolean is read off a method's reply and a property's alike, and
    /// anything else is no answer.
    #[test]
    fn a_reply_says_true_or_false_or_nothing() {
        let property = "method return time=1.5 sender=:1.2 -> destination=:1.9 serial=7 \
                        reply_serial=2\n   variant       boolean false\n";
        assert_eq!(reply_bool(property), Some(false));
        let method = "method return time=1.5 sender=:1.4 -> destination=:1.9 serial=3 \
                      reply_serial=2\n   boolean true\n";
        assert_eq!(reply_bool(method), Some(true));
        assert_eq!(reply_bool("   variant       string \"2\"\n"), None);
        assert_eq!(reply_bool("   boolean maybe\n"), None);
        assert_eq!(reply_bool(""), None);
    }

    /// The names on the bus are read off `ListNames`, one a line; the screen
    /// savers asked are each asked under their own name.
    #[test]
    fn the_running_names_are_read_off_the_list() {
        let reply = "method return time=1.5 sender=org.freedesktop.DBus -> destination=:1.9 \
                     serial=3 reply_serial=2\n   array [\n      string \"org.freedesktop.DBus\"\n      \
                     string \":1.4\"\n      string \"org.gnome.ScreenSaver\"\n   ]\n";
        assert_eq!(
            reply_strings(reply),
            vec!["org.freedesktop.DBus", ":1.4", "org.gnome.ScreenSaver"]
        );
        assert!(reply_strings("   boolean true\n").is_empty());
        for (service, path) in SCREEN_SAVERS {
            assert!(service.ends_with(".ScreenSaver"), "{service}");
            assert!(
                path.starts_with('/') && path.ends_with("ScreenSaver"),
                "{path}"
            );
        }
    }
}
