//! Which modifier keys the person is holding down right now.
//!
//! Keys sent with the window brought to the front go in as real input, and
//! the system combines them with whatever modifier is held at that moment: a
//! Tab under a held Windows key is Win+Tab, an Escape under Ctrl is
//! Ctrl+Escape — chords a shared window's keys never reach in the background.
//! So before keys go in at the front this is asked, and while one is held
//! none is sent (see `act`).
//!
//! It is a query of the modifier state at one moment — what AppKit's
//! `NSEvent.modifierFlags` answers on macOS — not a watch over the input
//! (an event tap, which is what Input Monitoring governs there), and nothing
//! is recorded.

/// The modifiers held down at this moment, by the name the person knows them
/// by, each once — empty when none is held; `None` where the platform will
/// not say, which is not the same as none.
pub fn held_modifiers() -> Option<Vec<&'static str>> {
    imp::held_modifiers()
}

#[cfg(windows)]
mod imp {
    /// `VK_CONTROL`, `VK_MENU` (Alt), `VK_SHIFT`, `VK_LWIN`, `VK_RWIN`.
    const KEYS: [(i32, &str); 5] = [
        (0x11, "Ctrl"),
        (0x12, "Alt"),
        (0x10, "Shift"),
        (0x5B, "the Windows key"),
        (0x5C, "the Windows key"),
    ];

    // Declared here: windows-sys has it behind a feature this crate does not
    // turn on (`Win32_UI_Input_KeyboardAndMouse`), and turning one on rebuilds
    // every crate that shares windows-sys — Tauri among them.
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
    }

    pub fn held_modifiers() -> Option<Vec<&'static str>> {
        let mut held = Vec::new();
        for (key, name) in KEYS {
            // SAFETY: a virtual-key code; the top bit of the answer says the
            // key is down now.
            let down = unsafe { GetAsyncKeyState(key) } < 0;
            if down && !held.contains(&name) {
                held.push(name);
            }
        }
        Some(held)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    /// `kCGEventSourceStateCombinedSessionState`: the keyboard, and any
    /// modifier something in the session has posted and not let go of —
    /// which the keys would combine with all the same.
    const COMBINED_SESSION_STATE: i32 = 0;

    /// `kCGEventFlagMaskCommand`, `…Alternate`, `…Control`, `…Shift`. Caps
    /// Lock is a state, not a key held, and changes no chord.
    const FLAGS: [(u64, &str); 4] = [
        (0x0010_0000, "Command"),
        (0x0008_0000, "Option"),
        (0x0004_0000, "Control"),
        (0x0002_0000, "Shift"),
    ];

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }

    pub fn held_modifiers() -> Option<Vec<&'static str>> {
        // SAFETY: a pure query of the keyboard's state.
        let flags = unsafe { CGEventSourceFlagsState(COMBINED_SESSION_STATE) };
        Some(
            FLAGS
                .iter()
                .filter(|(mask, _)| flags & mask != 0)
                .map(|(_, name)| *name)
                .collect(),
        )
    }
}

/// X11: the keyboard as the server has it at this moment, read through its
/// modifier map (see `super::x11win`). Not on Wayland, which tells no client
/// what keys are down.
#[cfg(all(target_os = "linux", feature = "computer-helper"))]
mod imp {
    pub fn held_modifiers() -> Option<Vec<&'static str>> {
        super::super::x11win::held_modifiers()
    }
}

/// Elsewhere the platform will not say.
#[cfg(not(any(
    windows,
    target_os = "macos",
    all(target_os = "linux", feature = "computer-helper")
)))]
mod imp {
    pub fn held_modifiers() -> Option<Vec<&'static str>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The answer names each modifier at most once — the two Windows keys
    /// are one — and only modifiers.
    #[test]
    fn held_modifiers_are_named_once() {
        let Some(held) = held_modifiers() else {
            return;
        };
        let mut seen = held.clone();
        seen.dedup();
        assert_eq!(held.len(), seen.len(), "{held:?}");
        let known = [
            "Ctrl",
            "Alt",
            "Shift",
            "the Windows key",
            "Command",
            "Option",
            "Control",
        ];
        assert!(held.iter().all(|name| known.contains(name)), "{held:?}");
    }
}
