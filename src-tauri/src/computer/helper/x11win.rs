//! X11: what the helper asks the X server and its window manager itself,
//! rather than the driver — which windows are minimized and which are on
//! another desktop, and which modifier keys are held down.
//!
//! The driver's listing on X11 says only whether a window is mapped. A
//! minimized (iconified) window is not, nor is one on another of the window
//! manager's desktops, nor the furniture applications keep; the window
//! manager tells them apart (ICCCM `WM_STATE`, EWMH `_NET_WM_STATE` and
//! `_NET_WM_DESKTOP`).
//!
//! Only on an X11 session: on Wayland the driver's window ids are not X11
//! windows, and XWayland knows only some of them.

use std::collections::HashMap;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt, Window};
use x11rb::rust_connection::RustConnection;

/// ICCCM `IconicState`.
const ICONIC: u32 = 3;
/// EWMH: on every desktop.
const ALL_DESKTOPS: u32 = 0xFFFF_FFFF;
/// The longest list of state atoms read for one window.
const MAX_STATES: u32 = 64;

/// What the window manager says of one window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowState {
    /// Iconified.
    pub minimized: bool,
    /// On a desktop of the window manager's other than the current one.
    pub elsewhere: bool,
}

/// Whether this process is in an X11 session — not a Wayland one, where an
/// X11 connection would reach XWayland and only its windows.
pub fn is_x11_session() -> bool {
    let set = |key: &str| std::env::var_os(key).is_some_and(|v| !v.is_empty());
    set("DISPLAY") && !set("WAYLAND_DISPLAY")
}

/// What the window manager says of each of `windows` it knows, by window
/// id. Empty off an X11 session, or when the server cannot be reached.
pub fn window_states(windows: &[u64]) -> HashMap<u64, WindowState> {
    if !is_x11_session() {
        return HashMap::new();
    }
    let Ok((conn, screen)) = RustConnection::connect(None) else {
        return HashMap::new();
    };
    let root = conn.setup().roots[screen].root;
    let atoms = Atoms::of(&conn);
    let current_desktop = atoms
        .net_current_desktop
        .and_then(|atom| cardinal(&conn, root, atom));
    windows
        .iter()
        .filter_map(|&id| {
            let window = Window::try_from(id).ok()?;
            Some((id, state_of(&conn, window, &atoms, current_desktop)?))
        })
        .collect()
}

/// The modifiers held down at this moment, by the name the person knows
/// them by, each once; `None` off an X11 session, or when the server cannot
/// be reached or its answer read — not knowing is not "none held".
pub fn held_modifiers() -> Option<Vec<&'static str>> {
    if !is_x11_session() {
        return None;
    }
    let (conn, _) = RustConnection::connect(None).ok()?;
    let keymap = conn.query_keymap().ok()?.reply().ok()?;
    let mapping = conn.get_modifier_mapping().ok()?.reply().ok()?;
    held_of(&keymap.keys, &mapping.keycodes)
}

/// The modifiers whose keys are down in `keymap` (one bit per keycode), by
/// the server's modifier mapping (`keycodes`: eight rows — Shift, Lock,
/// Control, Mod1 … Mod5 — of equal length); `None` for a mapping not of that
/// shape.
fn held_of(keymap: &[u8], keycodes: &[u8]) -> Option<Vec<&'static str>> {
    if keycodes.is_empty() || !keycodes.len().is_multiple_of(8) {
        return None;
    }
    let per = keycodes.len() / 8;
    let down = |keycode: u8| {
        keycode != 0
            && keymap
                .get(usize::from(keycode / 8))
                .is_some_and(|byte| byte & (1 << (keycode % 8)) != 0)
    };
    // Mod1 is Alt and Mod4 Super on every desktop's default map; Lock and
    // Mod2 (Num Lock) are toggles, not held keys.
    let mut held = Vec::new();
    for (row, name) in [(0, "Shift"), (2, "Ctrl"), (3, "Alt"), (6, "the Super key")] {
        let row = &keycodes[row * per..(row + 1) * per];
        if row.iter().copied().any(down) && !held.contains(&name) {
            held.push(name);
        }
    }
    Some(held)
}

struct Atoms {
    wm_state: Option<Atom>,
    net_wm_state: Option<Atom>,
    net_wm_state_hidden: Option<Atom>,
    net_wm_desktop: Option<Atom>,
    net_current_desktop: Option<Atom>,
}

impl Atoms {
    fn of(conn: &RustConnection) -> Self {
        let atom = |name: &str| {
            conn.intern_atom(true, name.as_bytes())
                .ok()
                .and_then(|c| c.reply().ok())
                .map(|r| r.atom)
                .filter(|atom| *atom != x11rb::NONE)
        };
        Self {
            wm_state: atom("WM_STATE"),
            net_wm_state: atom("_NET_WM_STATE"),
            net_wm_state_hidden: atom("_NET_WM_STATE_HIDDEN"),
            net_wm_desktop: atom("_NET_WM_DESKTOP"),
            net_current_desktop: atom("_NET_CURRENT_DESKTOP"),
        }
    }
}

fn state_of(
    conn: &RustConnection,
    window: Window,
    atoms: &Atoms,
    current_desktop: Option<u32>,
) -> Option<WindowState> {
    let iconic = atoms.wm_state.and_then(|wm_state| {
        let reply = conn
            .get_property(false, window, wm_state, wm_state, 0, 2)
            .ok()?
            .reply()
            .ok()?;
        let state = reply.value32()?.next()?;
        Some(state == ICONIC)
    });
    let hidden = match (atoms.net_wm_state, atoms.net_wm_state_hidden) {
        (Some(net_wm_state), Some(net_hidden)) => conn
            .get_property(false, window, net_wm_state, AtomEnum::ATOM, 0, MAX_STATES)
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|reply| Some(reply.value32()?.any(|atom| atom == net_hidden))),
        _ => None,
    };
    let desktop = atoms
        .net_wm_desktop
        .and_then(|atom| cardinal(conn, window, atom));
    if iconic.is_none() && hidden.is_none() && desktop.is_none() {
        // Nothing the window manager keeps for a window it manages.
        return None;
    }
    let minimized = iconic == Some(true) || hidden == Some(true);
    let elsewhere = match (desktop, current_desktop) {
        (Some(desktop), Some(current)) => desktop != ALL_DESKTOPS && desktop != current,
        _ => false,
    };
    Some(WindowState {
        minimized,
        elsewhere,
    })
}

/// One CARDINAL property of `window`.
fn cardinal(conn: &RustConnection, window: Window, property: Atom) -> Option<u32> {
    conn.get_property(false, window, property, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .next()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keycodes of each held modifier row name it, once; Lock and Num
    /// Lock are toggles, and a row of zeros names nothing.
    #[test]
    fn held_modifiers_are_read_off_the_modifier_rows() {
        // Two keycodes per row: Shift 50/62, Lock 66, Control 37/105, Mod1
        // 64/108, Mod2 77, Mod3 none, Mod4 133/134, Mod5 none.
        let keycodes = [50, 62, 66, 0, 37, 105, 64, 108, 77, 0, 0, 0, 133, 134, 0, 0];
        let mut keymap = [0u8; 32];
        let press =
            |map: &mut [u8; 32], keycode: u8| map[usize::from(keycode / 8)] |= 1 << (keycode % 8);
        assert_eq!(held_of(&keymap, &keycodes), Some(vec![]));
        press(&mut keymap, 66); // Caps Lock
        press(&mut keymap, 77); // Num Lock
        assert_eq!(held_of(&keymap, &keycodes), Some(vec![]));
        press(&mut keymap, 105); // right Control
        press(&mut keymap, 134); // right Super
        assert_eq!(
            held_of(&keymap, &keycodes),
            Some(vec!["Ctrl", "the Super key"])
        );
        press(&mut keymap, 50);
        press(&mut keymap, 62);
        assert_eq!(
            held_of(&keymap, &keycodes),
            Some(vec!["Shift", "Ctrl", "the Super key"])
        );
        // A mapping that is not eight equal rows cannot be read.
        assert_eq!(held_of(&keymap, &keycodes[..15]), None);
    }
}
