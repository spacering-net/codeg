//! The shortcut that stops every agent at once, from anywhere on the desktop.
//!
//! It is registered with the OS as a global hotkey (see
//! `commands::computer`), and that is why the keys are a closed list. On
//! macOS a hotkey on an ordinary key is a Carbon hotkey, which needs no
//! permission at all; a hotkey on a media key is watched through an event
//! tap, which needs Input Monitoring — a permission codeg must never hold,
//! because every agent's shell would inherit it. So only the keys below are
//! ever registered, whatever a settings record says.
//!
//! It must also be hard to press by accident and hard to take from another
//! application: two modifiers at least, one of them Control — or, on a Mac,
//! Command. (macOS no longer honours a hotkey held with Option alone.)
//!
//! Spelled as modifiers then one key, joined by `+`, in a fixed order:
//! `Control+Alt+Shift+Command+<code>`, the key named by its W3C `code` — the
//! physical key, whatever the keyboard layout prints on it. An empty string
//! is "no shortcut".

use std::fmt;

use serde::Serialize;

use crate::computer::keys::Platform;

/// Where the stop shortcut stands. Held with the OS by the desktop app
/// alone: codeg-server has none, and says so with this left empty.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopKeyStatus {
    /// The shortcut in force, spelled as the settings spell it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
    /// The shortcut the settings name that the OS would not take — most
    /// likely another application holds it — and what the OS said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The punctuation keys of the main block, by W3C code.
const PUNCTUATION: &[&str] = &[
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Backquote",
    "Comma",
    "Period",
    "Slash",
];

/// The modifiers held with the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct ShortcutModifiers {
    pub control: bool,
    /// Option on a Mac.
    pub alt: bool,
    pub shift: bool,
    /// Macs only.
    pub command: bool,
}

impl ShortcutModifiers {
    fn count(&self) -> usize {
        [self.control, self.alt, self.shift, self.command]
            .into_iter()
            .filter(|held| *held)
            .count()
    }
}

/// A shortcut that may stop every agent: see the module note.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StopShortcut {
    pub modifiers: ShortcutModifiers,
    /// The key's W3C `code`, one of [`is_allowed_key`]'s.
    pub code: String,
}

/// Why a spelling is not a stop shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutError {
    /// Not modifiers and a key joined by `+`, or a modifier named twice.
    Malformed,
    /// A key this shortcut cannot be on.
    UnsupportedKey,
    /// Fewer than two modifiers, or neither Control nor (on a Mac) Command.
    WeakModifiers,
    /// Command, off a Mac.
    CommandOffMac,
}

impl fmt::Display for ShortcutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ShortcutError::Malformed => "not a shortcut: modifiers and one key, joined by `+`",
            ShortcutError::UnsupportedKey => {
                "the stop shortcut is on a letter, a digit, F1–F12, Escape or a punctuation key"
            }
            ShortcutError::WeakModifiers => {
                "the stop shortcut holds two modifiers or more, one of them Control (or Command \
                 on a Mac)"
            }
            ShortcutError::CommandOffMac => "Command is a Mac modifier",
        })
    }
}

/// Whether the stop shortcut can be on `code`: a letter, a digit, F1–F12,
/// Escape, or a punctuation key of the main block.
pub fn is_allowed_key(code: &str) -> bool {
    let one = |rest: &str, class: fn(&char) -> bool| {
        let mut chars = rest.chars();
        matches!((chars.next(), chars.next()), (Some(c), None) if class(&c))
    };
    if let Some(letter) = code.strip_prefix("Key") {
        return one(letter, char::is_ascii_uppercase);
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return one(digit, char::is_ascii_digit);
    }
    if let Some(n) = code.strip_prefix('F') {
        return !n.starts_with('0') && n.parse::<u8>().is_ok_and(|n| (1..=12).contains(&n));
    }
    code == "Escape" || PUNCTUATION.contains(&code)
}

impl StopShortcut {
    /// Read a spelling (see the module note) as a stop shortcut on
    /// `platform`. Modifiers may come in any order; the key comes last.
    pub fn parse(spelling: &str, platform: Platform) -> Result<StopShortcut, ShortcutError> {
        let mut parts: Vec<&str> = spelling.split('+').collect();
        let code = parts
            .pop()
            .filter(|c| !c.is_empty())
            .ok_or(ShortcutError::Malformed)?;
        let mut modifiers = ShortcutModifiers::default();
        for part in parts {
            let held = match part {
                "Control" => &mut modifiers.control,
                "Alt" => &mut modifiers.alt,
                "Shift" => &mut modifiers.shift,
                "Command" => &mut modifiers.command,
                _ => return Err(ShortcutError::Malformed),
            };
            if *held {
                return Err(ShortcutError::Malformed);
            }
            *held = true;
        }
        if !is_allowed_key(code) {
            return Err(ShortcutError::UnsupportedKey);
        }
        let mac = platform == Platform::Mac;
        if modifiers.command && !mac {
            return Err(ShortcutError::CommandOffMac);
        }
        if modifiers.count() < 2 || !(modifiers.control || modifiers.command) {
            return Err(ShortcutError::WeakModifiers);
        }
        Ok(StopShortcut {
            modifiers,
            code: code.to_string(),
        })
    }

    /// The shortcut a person gets until they choose another: ⌃⌘⎋ on a Mac,
    /// Ctrl+Alt+Esc elsewhere.
    pub fn default_for(platform: Platform) -> StopShortcut {
        StopShortcut {
            modifiers: ShortcutModifiers {
                control: true,
                alt: platform != Platform::Mac,
                shift: false,
                command: platform == Platform::Mac,
            },
            code: "Escape".to_string(),
        }
    }

    /// What a settings record's spelling comes to on `platform`: nothing for
    /// the empty string, the shortcut it spells, or — for a spelling that is
    /// not one here (a record from another platform's codeg) — the default,
    /// because a stop shortcut that silently stopped existing is the worse
    /// surprise.
    pub fn from_setting(spelling: &str, platform: Platform) -> Option<StopShortcut> {
        if spelling.is_empty() {
            return None;
        }
        Some(Self::parse(spelling, platform).unwrap_or_else(|_| Self::default_for(platform)))
    }
}

#[cfg(feature = "tauri-runtime")]
impl StopShortcut {
    /// The hotkey to register with the OS. `None` only for a key outside the
    /// list, which [`StopShortcut::parse`] never lets through.
    pub fn hotkey(&self) -> Option<tauri_plugin_global_shortcut::Shortcut> {
        use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
        if !is_allowed_key(&self.code) {
            return None;
        }
        let code: Code = self.code.parse().ok()?;
        let m = &self.modifiers;
        let mut modifiers = Modifiers::empty();
        for (held, flag) in [
            (m.control, Modifiers::CONTROL),
            (m.alt, Modifiers::ALT),
            (m.shift, Modifiers::SHIFT),
            (m.command, Modifiers::SUPER),
        ] {
            if held {
                modifiers |= flag;
            }
        }
        Some(Shortcut::new(Some(modifiers), code))
    }
}

impl fmt::Display for StopShortcut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let m = &self.modifiers;
        for (held, name) in [
            (m.control, "Control"),
            (m.alt, "Alt"),
            (m.shift, "Shift"),
            (m.command, "Command"),
        ] {
            if held {
                write!(f, "{name}+")?;
            }
        }
        f.write_str(&self.code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shortcut_is_modifiers_and_one_key_in_any_order() {
        let s = StopShortcut::parse("Command+Control+Escape", Platform::Mac).unwrap();
        assert!(s.modifiers.control && s.modifiers.command);
        assert!(!s.modifiers.alt && !s.modifiers.shift);
        assert_eq!(s.code, "Escape");
        // Written back in the one order.
        assert_eq!(s.to_string(), "Control+Command+Escape");
        assert_eq!(
            StopShortcut::parse(&s.to_string(), Platform::Mac).unwrap(),
            s
        );
        for bad in [
            "",
            "Escape+Control+Alt",
            "Control+Control+KeyS",
            "Ctrl+Alt+KeyS",
            "Control+Alt+",
            "control+alt+KeyS",
        ] {
            assert!(
                StopShortcut::parse(bad, Platform::Windows).is_err(),
                "{bad} parsed"
            );
        }
    }

    /// Only keys that register as Carbon hotkeys on a Mac — never a media key,
    /// which would take an event tap and Input Monitoring with it — and none
    /// a person types or moves the caret with.
    #[test]
    fn the_keys_are_a_closed_list() {
        for good in [
            "KeyA",
            "KeyZ",
            "Digit0",
            "Digit9",
            "F1",
            "F12",
            "Escape",
            "Period",
            "Slash",
            "Backquote",
            "BracketLeft",
        ] {
            assert!(is_allowed_key(good), "{good} refused");
        }
        for bad in [
            "MediaPlayPause",
            "AudioVolumeUp",
            "MediaTrackNext",
            "F13",
            "F0",
            "F01",
            "Keya",
            "KeyAA",
            "Digit10",
            "Space",
            "Tab",
            "Enter",
            "Backspace",
            "Delete",
            "ArrowUp",
            "Home",
            "Numpad1",
            "MetaLeft",
            "",
        ] {
            assert!(!is_allowed_key(bad), "{bad} allowed");
        }
        assert_eq!(
            StopShortcut::parse("Control+Alt+MediaPlayPause", Platform::Mac),
            Err(ShortcutError::UnsupportedKey)
        );
    }

    #[test]
    fn it_takes_two_modifiers_one_of_them_control_or_command() {
        use ShortcutError::*;
        let on = |s: &str, p: Platform| StopShortcut::parse(s, p).map(|_| ());
        assert_eq!(on("Control+KeyS", Platform::Windows), Err(WeakModifiers));
        assert_eq!(on("Alt+Shift+KeyS", Platform::Windows), Err(WeakModifiers));
        // Option alone is no longer a hotkey on macOS.
        assert_eq!(on("Alt+Shift+KeyS", Platform::Mac), Err(WeakModifiers));
        assert_eq!(on("Command+KeyS", Platform::Mac), Err(WeakModifiers));
        assert_eq!(on("Control+Alt+KeyS", Platform::Linux), Ok(()));
        assert_eq!(on("Control+Shift+F5", Platform::Windows), Ok(()));
        assert_eq!(on("Shift+Command+KeyS", Platform::Mac), Ok(()));
        assert_eq!(on("Control+Command+Escape", Platform::Mac), Ok(()));
        assert_eq!(
            on("Control+Command+Escape", Platform::Windows),
            Err(CommandOffMac)
        );
    }

    #[test]
    fn every_platform_has_a_default_it_accepts() {
        for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
            let default = StopShortcut::default_for(platform);
            assert_eq!(
                StopShortcut::parse(&default.to_string(), platform),
                Ok(default)
            );
        }
        assert_eq!(
            StopShortcut::default_for(Platform::Mac).to_string(),
            "Control+Command+Escape"
        );
        assert_eq!(
            StopShortcut::default_for(Platform::Windows).to_string(),
            "Control+Alt+Escape"
        );
    }

    /// Every key on the list is one the hotkey library knows, by the same
    /// name.
    #[cfg(feature = "tauri-runtime")]
    #[test]
    fn every_listed_key_becomes_a_hotkey() {
        let letters = ('A'..='Z').map(|c| format!("Key{c}"));
        let digits = ('0'..='9').map(|c| format!("Digit{c}"));
        let fkeys = (1..=12).map(|n| format!("F{n}"));
        let others = PUNCTUATION
            .iter()
            .map(|s| s.to_string())
            .chain(["Escape".to_string()]);
        for code in letters.chain(digits).chain(fkeys).chain(others) {
            let shortcut =
                StopShortcut::parse(&format!("Control+Alt+{code}"), Platform::Linux).unwrap();
            let hotkey = shortcut.hotkey().unwrap_or_else(|| panic!("{code}"));
            assert_eq!(hotkey.key.to_string(), code);
        }
        let mac = StopShortcut::default_for(Platform::Mac).hotkey().unwrap();
        use tauri_plugin_global_shortcut::Modifiers;
        assert_eq!(mac.mods, Modifiers::CONTROL | Modifiers::SUPER);
    }

    /// Empty is off; a spelling that is no shortcut here falls back to the
    /// default rather than to none.
    #[test]
    fn a_setting_is_off_a_shortcut_or_the_default() {
        assert_eq!(StopShortcut::from_setting("", Platform::Windows), None);
        assert_eq!(
            StopShortcut::from_setting("Control+Shift+KeyK", Platform::Windows)
                .unwrap()
                .to_string(),
            "Control+Shift+KeyK"
        );
        assert_eq!(
            StopShortcut::from_setting("Control+Command+Escape", Platform::Windows),
            Some(StopShortcut::default_for(Platform::Windows))
        );
    }
}
