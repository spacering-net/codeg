//! Keys an agent may press on a shared window, and which of them a window
//! grant allows.
//!
//! A window grant is permission to work *in* one window. A key reaches the
//! application, though, not the window: ⌘Q quits all of it, ⌘W closes the
//! window, and the platforms' own chords (⌘Tab, Alt+Tab, Win+L, ⌃⌘Q) act on
//! the whole desktop. So what a window grant lets through is a closed list —
//! the editing and navigation keys and the few chords that stay inside a text
//! field (select all, copy, cut, undo, redo, find, moving by word or line) —
//! and everything else is refused as needing more than one window.
//!
//! An application shared as a whole reaches further: every chord it takes —
//! its menu commands, ⌘W and ⌘Q among them — but still not the desktop's
//! own (switching applications, the launcher, the screenshot keys, locking
//! the screen or logging out, forcing applications to quit, moving between
//! desktops), which reach past any one application ([`classify_for_app`]).
//!
//! **Paste is its own case.** ⌘V writes the clipboard into a window the agent
//! can read, and the clipboard is the user's: what they last copied from a
//! password manager is exactly what would come back in the next snapshot. A
//! paste is safe only when the clipboard holds what the agent itself copied
//! out of a window it may read, which this version does not track — so every
//! paste chord is refused.
//!
//! The vocabulary is also closed, and spelled once here: the driver's key
//! names differ by platform (its Windows build even reads an unknown name as
//! its first letter — `printscreen` is P), so an agent's key is parsed into
//! [`Key`] and written back out in the one spelling that platform's driver
//! reads.

use serde::{Deserialize, Serialize};

/// A key on the keyboard, by what it is rather than by any platform's name
/// for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Key {
    /// A letter (`a`–`z`), a digit, or one of the punctuation keys of the
    /// main block. Always lowercase: the key, not the character shift makes
    /// of it.
    Char(char),
    Return,
    Tab,
    Space,
    /// Deletes to the left (the key a Mac labels "delete").
    Backspace,
    /// Deletes to the right (fn+delete on a Mac).
    Delete,
    Escape,
    Home,
    End,
    PageUp,
    PageDown,
    Up,
    Down,
    Left,
    Right,
    /// F1–F12.
    F(u8),
}

/// The punctuation keys of the main block, as their unshifted characters.
const PUNCTUATION: &[char] = &['-', '=', '[', ']', '\\', ';', '\'', ',', '.', '/', '`'];

impl Key {
    /// Parse an agent's name for a key. Case does not matter; a few common
    /// aliases are read (`enter`, `esc`, `del`, `arrowup`, …).
    pub fn parse(name: &str) -> Result<Key, String> {
        let raw = name.trim();
        if raw.chars().count() == 1 {
            let c = raw.chars().next().unwrap_or(' ');
            let lower = c.to_ascii_lowercase();
            return if lower.is_ascii_lowercase() || lower.is_ascii_digit() {
                Ok(Key::Char(lower))
            } else if PUNCTUATION.contains(&c) {
                Ok(Key::Char(c))
            } else if c == ' ' {
                Ok(Key::Space)
            } else {
                Err(format!(
                    "`{raw}` is not a key this tool presses; type text with computer_type"
                ))
            };
        }
        let lower = raw.to_ascii_lowercase().replace(['-', ' '], "_");
        let key = match lower.as_str() {
            "return" | "enter" => Key::Return,
            "tab" => Key::Tab,
            "space" | "spacebar" => Key::Space,
            "backspace" => Key::Backspace,
            "delete" | "del" | "forward_delete" | "forwarddelete" => Key::Delete,
            "escape" | "esc" => Key::Escape,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" | "page_up" | "pgup" => Key::PageUp,
            "pagedown" | "page_down" | "pgdn" => Key::PageDown,
            "up" | "arrowup" | "up_arrow" | "arrow_up" => Key::Up,
            "down" | "arrowdown" | "down_arrow" | "arrow_down" => Key::Down,
            "left" | "arrowleft" | "left_arrow" | "arrow_left" => Key::Left,
            "right" | "arrowright" | "right_arrow" | "arrow_right" => Key::Right,
            other => match other.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                Some(n) if (1..=12).contains(&n) => Key::F(n),
                _ => {
                    return Err(format!(
                        "`{raw}` is not a key this tool knows. Keys: a letter, a digit or a \
                         punctuation key, return, tab, space, backspace, delete, escape, home, \
                         end, pageup, pagedown, up, down, left, right, f1–f12"
                    ))
                }
            },
        };
        Ok(key)
    }

    /// Whether pressing it (with nothing held, or shift) puts a character
    /// into whatever has focus.
    pub fn is_character(self) -> bool {
        matches!(self, Key::Char(_) | Key::Space)
    }

    /// The key's name as `platform`'s driver reads it.
    pub fn driver_name(self, platform: Platform) -> String {
        match self {
            Key::Char(c) => c.to_string(),
            Key::Return => "return".into(),
            Key::Tab => "tab".into(),
            Key::Space => "space".into(),
            Key::Backspace => "backspace".into(),
            // The Mac driver's "delete" is the Mac key of that name, which
            // deletes to the left.
            Key::Delete => match platform {
                Platform::Mac => "forward_delete".into(),
                Platform::Windows | Platform::Linux => "delete".into(),
            },
            Key::Escape => "escape".into(),
            Key::Home => "home".into(),
            Key::End => "end".into(),
            Key::PageUp => "pageup".into(),
            Key::PageDown => "pagedown".into(),
            Key::Up => "up".into(),
            Key::Down => "down".into(),
            Key::Left => "left".into(),
            Key::Right => "right".into(),
            Key::F(n) => format!("f{n}"),
        }
    }

    fn is_arrow(self) -> bool {
        matches!(self, Key::Up | Key::Down | Key::Left | Key::Right)
    }
}

/// The modifier keys held with a key.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Modifiers {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shift: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub control: bool,
    /// Option on a Mac.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub alt: bool,
    /// Command on a Mac; the Windows key, or Super, elsewhere.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub meta: bool,
}

impl Modifiers {
    /// Parse an agent's list of modifier names.
    pub fn parse<S: AsRef<str>>(names: &[S]) -> Result<Modifiers, String> {
        let mut m = Modifiers::default();
        for name in names {
            match name.as_ref().trim().to_ascii_lowercase().as_str() {
                "shift" => m.shift = true,
                "control" | "ctrl" => m.control = true,
                "alt" | "option" | "opt" => m.alt = true,
                "meta" | "command" | "cmd" | "super" | "win" | "windows" => m.meta = true,
                other => {
                    return Err(format!(
                        "`{other}` is not a modifier. Modifiers: shift, control, alt (option), \
                         meta (command on a Mac)"
                    ))
                }
            }
        }
        Ok(m)
    }

    pub fn is_empty(self) -> bool {
        self == Modifiers::default()
    }

    /// The modifiers as `platform`'s driver spells them.
    pub fn driver_names(self, platform: Platform) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.shift {
            out.push("shift");
        }
        if self.control {
            out.push("ctrl");
        }
        if self.alt {
            out.push(match platform {
                Platform::Mac => "option",
                Platform::Windows | Platform::Linux => "alt",
            });
        }
        if self.meta {
            out.push(match platform {
                Platform::Mac => "cmd",
                Platform::Windows => "win",
                Platform::Linux => "super",
            });
        }
        out
    }
}

/// A key and the modifiers held with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chord {
    pub key: Key,
    #[serde(default)]
    pub modifiers: Modifiers,
}

impl Chord {
    /// Whether the chord types a character into whatever has focus: a
    /// character key with nothing held but, perhaps, shift. Such a key goes
    /// only into an element the agent names, and never into a secret one.
    pub fn types_text(&self) -> bool {
        let m = self.modifiers;
        self.key.is_character() && !m.control && !m.alt && !m.meta
    }
}

/// Which desktop the rules are being applied for. The chords differ — the
/// shortcut modifier is ⌘ on a Mac and Ctrl elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    pub fn current() -> Platform {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }
}

/// What a window grant makes of a chord.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChordClass {
    /// Stays inside the window: editing and navigation.
    Window,
    /// Writes the clipboard into the window. See the module note.
    Paste,
    /// Acts on the application or the desktop — or is simply not on the
    /// list. Needs more than a window grant.
    Beyond,
}

/// Judge `chord` for a window grant on `platform`. See the module note.
pub fn classify(chord: &Chord, platform: Platform) -> ChordClass {
    let Chord { key, modifiers: m } = *chord;
    // The platform's shortcut modifier, and the one that is not it. On
    // Windows and Linux the Windows / Super key is the desktop's own and
    // never reaches a single window.
    let (primary, other) = match platform {
        Platform::Mac => (m.meta, m.control),
        Platform::Windows | Platform::Linux => (m.control, m.meta),
    };
    if other {
        return ChordClass::Beyond;
    }
    if primary && key == Key::Char('v') {
        return ChordClass::Paste;
    }
    match (primary, m.alt) {
        // Nothing held but perhaps shift: every key but the function keys,
        // which applications (and some desktops) bind to their own commands,
        // and shift+delete, which deletes a selected file for good in the
        // Windows File Explorer.
        (false, false) => {
            if matches!(key, Key::F(_)) || (m.shift && key == Key::Delete) {
                ChordClass::Beyond
            } else {
                ChordClass::Window
            }
        }
        // The shortcut modifier: the editing chords, and moving through text.
        // Shift only where it is the same command backwards (redo, find
        // previous) or extends a selection — ⇧⌘A opens a folder in the
        // Finder, and ⇧⌘⌫ empties the Trash. ⌘ with backspace or delete is a
        // menu command on a Mac (the Finder's Move to Trash), so only Ctrl
        // deletes by word elsewhere.
        (true, false) => {
            let editing = match key {
                Key::Char('a' | 'c' | 'x' | 'f') => !m.shift,
                Key::Char('z' | 'g') => true,
                Key::Char('y') => platform != Platform::Mac && !m.shift,
                _ => false,
            };
            let moving = key.is_arrow()
                || (platform != Platform::Mac
                    && (matches!(key, Key::Home | Key::End)
                        || (matches!(key, Key::Backspace | Key::Delete) && !m.shift)));
            if editing || moving {
                ChordClass::Window
            } else {
                ChordClass::Beyond
            }
        }
        // Option on a Mac moves and deletes by word; Alt elsewhere opens the
        // application's menus.
        (false, true) => {
            let by_word = key.is_arrow()
                || (matches!(key, Key::Backspace | Key::Delete) && !m.shift);
            if platform == Platform::Mac && by_word {
                ChordClass::Window
            } else {
                ChordClass::Beyond
            }
        }
        (true, true) => ChordClass::Beyond,
    }
}

/// Judge `chord` for a grant on a whole application: every chord the
/// application takes, except a paste (see the module note) and the
/// desktop's own shortcuts ([`desktop_chord`]), which stay [`ChordClass::Beyond`].
pub fn classify_for_app(chord: &Chord, platform: Platform) -> ChordClass {
    if classify(chord, platform) == ChordClass::Paste {
        ChordClass::Paste
    } else if desktop_chord(chord, platform) {
        ChordClass::Beyond
    } else {
        ChordClass::Window
    }
}

/// The desktop's own shortcuts on `platform`, which no application grant
/// reaches: they switch applications, open the launcher, take screenshots,
/// lock the screen or log out, force applications to quit, or move between
/// desktops.
fn desktop_chord(chord: &Chord, platform: Platform) -> bool {
    let Chord { key, modifiers: m } = *chord;
    match platform {
        Platform::Mac => {
            let (cmd, ctrl, opt, shift) = (m.meta, m.control, m.alt, m.shift);
            // ⌘Tab; Spotlight (⌘Space, ⌥⌘Space), the input sources (⌃Space)
            // and the character viewer (⌃⌘Space).
            (cmd && key == Key::Tab)
                || (key == Key::Space && (cmd || ctrl))
                // Screenshots: ⇧⌘3 to ⇧⌘6, with ⌃ to the clipboard.
                || (cmd && shift && matches!(key, Key::Char('3' | '4' | '5' | '6')))
                // Lock the screen (⌃⌘Q), log out (⇧⌘Q), Force Quit (⌥⌘Esc).
                || (cmd && ctrl && key == Key::Char('q'))
                || (cmd && shift && key == Key::Char('q'))
                || (cmd && opt && key == Key::Escape)
                // The Dock (⌥⌘D), hiding every other application (⌥⌘H).
                || (cmd && opt && matches!(key, Key::Char('d' | 'h')))
                // Mission Control and the desktops (⌃ and an arrow), keyboard
                // access to the menu bar, the Dock and the rest (⌃F1–F12),
                // VoiceOver (⌘F5), Show Desktop (F11).
                || (ctrl && (key.is_arrow() || matches!(key, Key::F(_))))
                || (cmd && key == Key::F(5))
                || (!cmd && !ctrl && !opt && key == Key::F(11))
        }
        // The Windows key; switching (Alt+Tab, Alt+Esc); Start (Ctrl+Esc) and
        // the Task Manager (Ctrl+Shift+Esc); Ctrl+Alt with anything — the
        // secure attention keys, the display's rotation, and AltGr's
        // characters, which are typed with computer_type.
        Platform::Windows => {
            m.meta
                || (m.alt && matches!(key, Key::Tab | Key::Escape))
                || (m.control && key == Key::Escape)
                || (m.control && m.alt)
        }
        // Super; switching (Alt+Tab, Alt+`, Alt+Esc); the launcher or the
        // process monitor (Ctrl+Esc); the window manager's Alt+F-keys (the
        // activities, the run dialog, moving and resizing) but Alt+F4, which
        // closes the application's own window; Ctrl+Alt with anything — a
        // terminal, the lock screen, logging out, the workspaces, the text
        // consoles.
        Platform::Linux => {
            m.meta
                || (m.alt && matches!(key, Key::Tab | Key::Escape | Key::Char('`')))
                || (m.control && key == Key::Escape)
                || (m.alt && matches!(key, Key::F(n) if n != 4))
                || (m.control && m.alt)
        }
    }
}

/// Judge `chord` for the entire screen shared: every chord, the desktop's
/// own included, except a paste and the few no sharing reaches
/// ([`never_chord`]).
pub fn classify_for_screen(chord: &Chord, platform: Platform) -> ChordClass {
    if classify(chord, platform) == ChordClass::Paste {
        ChordClass::Paste
    } else if never_chord(chord, platform) {
        ChordClass::Beyond
    } else {
        ChordClass::Window
    }
}

/// The chords no sharing sends: the ones that lock the screen or log out,
/// and the ones that show every window at once — never-shared ones included,
/// drawn by the system itself where codeg cannot paint them over.
fn never_chord(chord: &Chord, platform: Platform) -> bool {
    let Chord { key, modifiers: m } = *chord;
    match platform {
        // Lock Screen (⌃⌘Q), log out (⇧⌘Q, ⌥⇧⌘Q at once); Mission Control
        // (⌃↑) and the application's windows (⌃↓).
        Platform::Mac => {
            (m.meta && key == Key::Char('q') && (m.control || m.shift))
                || (m.control && matches!(key, Key::Up | Key::Down))
        }
        // Lock (Win+L), the secure attention keys (Ctrl+Alt+Delete); Task
        // View (Win+Tab) and the switcher that stays up (Ctrl+Alt+Tab).
        Platform::Windows => {
            (m.meta && matches!(key, Key::Char('l') | Key::Tab))
                || (m.control
                    && m.alt
                    && matches!(key, Key::Delete | Key::Backspace | Key::Tab))
        }
        // Lock (Super+L, Ctrl+Alt+L), log out (Ctrl+Alt+Delete), ending the
        // X server (Ctrl+Alt+Backspace).
        Platform::Linux => {
            (m.meta && key == Key::Char('l'))
                || (m.control
                    && m.alt
                    && matches!(key, Key::Char('l') | Key::Delete | Key::Backspace))
        }
    }
}

/// [`pointer_modifiers_allowed`] for a grant on the whole application: Option
/// too on a Mac — what it reaches beyond the window is the application's —
/// and still never the Windows / Super key elsewhere.
pub fn pointer_modifiers_allowed_for_app(modifiers: Modifiers, platform: Platform) -> bool {
    !modifiers.meta || platform == Platform::Mac
}

/// Whether `chord` copies or cuts: the platform's shortcut modifier with C
/// or X — what is watched for a change of the clipboard.
pub fn copies(chord: &Chord, platform: Platform) -> bool {
    let primary = match platform {
        Platform::Mac => chord.modifiers.meta,
        Platform::Windows | Platform::Linux => chord.modifiers.control,
    };
    primary && matches!(chord.key, Key::Char('c' | 'x'))
}

/// Words a menu command's title uses for copying or cutting, in the
/// languages applications commonly come in.
const COPY_WORDS: &[&str] = &[
    "copy",
    "cut",
    "复制",
    "拷贝",
    "剪切",
    "複製",
    "拷貝",
    "剪下",
    "コピー",
    "カット",
    "복사",
    "잘라내기",
    "copiar",
    "cortar",
    "recortar",
    "kopieren",
    "ausschneiden",
    "copier",
    "couper",
    "copia",
    "taglia",
    "kopiëren",
    "knippen",
    "копировать",
    "вырезать",
    "نسخ",
    "قص",
];

/// Whether a menu command is named for copying or cutting — whose change of
/// the clipboard is then watched, as a copying key's is.
pub fn names_copy(title: &str) -> bool {
    let title = title.to_lowercase();
    COPY_WORDS.iter().any(|word| title.contains(word))
}

/// Words a control's title uses for pasting, in the languages applications
/// commonly come in. Matched anywhere in a title, case aside: "Paste and
/// Match Style" is a paste too. Some of them also mean "insert" in their
/// language, and refusing an Insert menu there is the safe side.
const PASTE_WORDS: &[&str] = &[
    "paste",
    "粘贴",
    "貼上",
    "ペースト",
    "貼り付け",
    "붙여넣기",
    "pegar",
    "coller",
    "colar",
    "einsetzen",
    "einfügen",
    "incolla",
    "plakken",
    "вставить",
    "вставка",
    "لصق",
    "yapıştır",
    "wklej",
    "klistra in",
    "indsæt",
    "lim inn",
    "liitä",
    "vložit",
    "beilleszt",
    "lipește",
    "הדבק",
    "tempel",
];

/// Whether a menu command or a control is named for pasting — which writes
/// the person's clipboard into a window, as ⌘V / Ctrl+V does (see the module
/// note).
pub fn names_paste(title: &str) -> bool {
    let title = title.to_lowercase();
    PASTE_WORDS.iter().any(|word| title.contains(word))
}

/// Whether a window grant reaches `modifiers` held during a click or a drag
/// on `platform`: Shift and Control everywhere — a click with them stays the
/// window's own (extending a selection, a context click). On a Mac Command
/// too, and not Option: Option-clicking a window's close button closes every
/// window of the application, and minimizing or zooming acts on them all the
/// same. Elsewhere Alt, and never the Windows / Super key, which is the
/// desktop's.
pub fn pointer_modifiers_allowed(modifiers: Modifiers, platform: Platform) -> bool {
    match platform {
        Platform::Mac => !modifiers.alt,
        Platform::Windows | Platform::Linux => !modifiers.meta,
    }
}

/// Whether `platform`'s driver holds `modifiers` down over a drag. macOS's
/// does. Windows' and Linux's drag without them and answer that they
/// dragged — a move where a copy was meant — so there a drag with keys held
/// is not sent at all.
pub fn drag_carries_modifiers(modifiers: Modifiers, platform: Platform) -> bool {
    modifiers.is_empty() || platform == Platform::Mac
}

/// The chords a window grant allows, in words, for a refusal to quote.
pub fn window_chords_note(platform: Platform) -> &'static str {
    match platform {
        Platform::Mac => {
            "On a shared window you may press the editing and navigation keys (return, tab, \
             escape, backspace, delete, the arrows, home, end, page up/down — with or without \
             shift, except shift+delete) and ⌘A, ⌘C, ⌘X, ⌘Z, ⇧⌘Z, ⌘F, ⌘G, ⇧⌘G, ⌘ or ⌥ with \
             an arrow (with or without shift), ⌥ with backspace or delete."
        }
        Platform::Windows | Platform::Linux => {
            "On a shared window you may press the editing and navigation keys (enter, tab, \
             escape, backspace, delete, the arrows, home, end, page up/down — with or without \
             shift, except shift+delete) and Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+Z, Ctrl+Shift+Z, \
             Ctrl+Y, Ctrl+F, Ctrl+G, Ctrl with an arrow, home or end (with or without shift), \
             Ctrl with backspace or delete."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shift and Control may be held over a pointer everywhere; Command on a
    /// Mac, not Option, which reaches every window of the application; Alt
    /// elsewhere, never the Windows and Super keys, which are the desktop's.
    #[test]
    fn pointer_modifiers_stop_where_the_window_does() {
        let m = |names: &[&str]| Modifiers::parse(names).unwrap();
        for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
            assert!(pointer_modifiers_allowed(m(&[]), platform));
            assert!(pointer_modifiers_allowed(m(&["shift", "ctrl"]), platform));
        }
        assert!(pointer_modifiers_allowed(
            m(&["cmd", "shift"]),
            Platform::Mac
        ));
        assert!(!pointer_modifiers_allowed(m(&["option"]), Platform::Mac));
        assert!(pointer_modifiers_allowed(m(&["alt"]), Platform::Windows));
        assert!(pointer_modifiers_allowed(m(&["alt"]), Platform::Linux));
        assert!(!pointer_modifiers_allowed(m(&["win"]), Platform::Windows));
        assert!(!pointer_modifiers_allowed(
            m(&["super", "shift"]),
            Platform::Linux
        ));
    }

    /// An application grant takes the application's own chords — menu
    /// commands, closing and quitting — and never the desktop's, nor a paste.
    #[test]
    fn an_application_grant_takes_its_chords_but_not_the_desktops() {
        let app = |key: &str, modifiers: &[&str], platform: Platform| {
            classify_for_app(&chord(key, modifiers), platform)
        };
        for (key, modifiers) in [
            ("q", &["cmd"][..]),
            ("w", &["cmd"]),
            ("n", &["cmd", "shift"]),
            (",", &["cmd"]),
            ("`", &["cmd"]),
            ("h", &["cmd"]),
            ("f", &["cmd", "ctrl"]),
            ("f3", &[]),
            ("delete", &["cmd"]),
        ] {
            assert_eq!(
                app(key, modifiers, Platform::Mac),
                ChordClass::Window,
                "{key} {modifiers:?}"
            );
        }
        for (key, modifiers) in [
            ("tab", &["cmd"][..]),
            ("tab", &["cmd", "shift"]),
            ("space", &["cmd"]),
            ("space", &["cmd", "alt"]),
            ("space", &["ctrl"]),
            ("4", &["cmd", "shift"]),
            ("4", &["cmd", "shift", "ctrl"]),
            ("q", &["cmd", "ctrl"]),
            ("q", &["cmd", "shift"]),
            ("escape", &["cmd", "alt"]),
            ("h", &["cmd", "alt"]),
            ("d", &["cmd", "alt"]),
            ("left", &["ctrl"]),
            ("up", &["ctrl"]),
            ("f2", &["ctrl"]),
            ("f5", &["cmd"]),
            ("f11", &[]),
        ] {
            assert_eq!(
                app(key, modifiers, Platform::Mac),
                ChordClass::Beyond,
                "{key} {modifiers:?}"
            );
        }
        for platform in [Platform::Windows, Platform::Linux] {
            for (key, modifiers) in [
                ("w", &["ctrl"][..]),
                ("q", &["ctrl"]),
                ("n", &["ctrl", "shift"]),
                ("f4", &["alt"]),
                ("f", &["alt"]),
                ("f5", &[]),
                ("left", &["ctrl"]),
            ] {
                assert_eq!(
                    app(key, modifiers, platform),
                    ChordClass::Window,
                    "{platform:?} {key} {modifiers:?}"
                );
            }
            for (key, modifiers) in [
                ("tab", &["alt"][..]),
                ("escape", &["alt"]),
                ("escape", &["ctrl"]),
                ("escape", &["ctrl", "shift"]),
                ("delete", &["ctrl", "alt"]),
                ("t", &["ctrl", "alt"]),
                ("l", &["win"]),
                ("d", &["super"]),
            ] {
                assert_eq!(
                    app(key, modifiers, platform),
                    ChordClass::Beyond,
                    "{platform:?} {key} {modifiers:?}"
                );
            }
        }
        assert_eq!(app("f2", &["alt"], Platform::Linux), ChordClass::Beyond);
        assert_eq!(app("`", &["alt"], Platform::Linux), ChordClass::Beyond);
        assert_eq!(app("f2", &["alt"], Platform::Windows), ChordClass::Window);
        assert_eq!(app("v", &["cmd"], Platform::Mac), ChordClass::Paste);
        assert_eq!(app("v", &["ctrl"], Platform::Windows), ChordClass::Paste);
        assert_eq!(
            app("v", &["ctrl", "shift"], Platform::Linux),
            ChordClass::Paste
        );
    }

    /// The entire screen takes the desktop's own chords too — switching
    /// applications, the launcher — but never locking the screen, logging
    /// out or showing every window at once, nor a paste.
    #[test]
    fn the_entire_screen_takes_all_but_locking_logging_out_and_overviews() {
        let screen = |key: &str, modifiers: &[&str], platform: Platform| {
            classify_for_screen(&chord(key, modifiers), platform)
        };
        assert_eq!(screen("tab", &["cmd"], Platform::Mac), ChordClass::Window);
        assert_eq!(screen("space", &["cmd"], Platform::Mac), ChordClass::Window);
        assert_eq!(screen("q", &["cmd"], Platform::Mac), ChordClass::Window);
        assert_eq!(
            screen("q", &["cmd", "ctrl"], Platform::Mac),
            ChordClass::Beyond
        );
        assert_eq!(
            screen("q", &["cmd", "shift"], Platform::Mac),
            ChordClass::Beyond
        );
        assert_eq!(screen("v", &["cmd"], Platform::Mac), ChordClass::Paste);
        assert_eq!(screen("up", &["ctrl"], Platform::Mac), ChordClass::Beyond);
        assert_eq!(screen("down", &["ctrl"], Platform::Mac), ChordClass::Beyond);
        assert_eq!(screen("left", &["ctrl"], Platform::Mac), ChordClass::Window);
        assert_eq!(screen("d", &["win"], Platform::Windows), ChordClass::Window);
        assert_eq!(screen("tab", &["alt"], Platform::Windows), ChordClass::Window);
        assert_eq!(screen("l", &["win"], Platform::Windows), ChordClass::Beyond);
        assert_eq!(screen("tab", &["win"], Platform::Windows), ChordClass::Beyond);
        assert_eq!(
            screen("tab", &["ctrl", "alt"], Platform::Windows),
            ChordClass::Beyond
        );
        assert_eq!(
            screen("delete", &["ctrl", "alt"], Platform::Windows),
            ChordClass::Beyond
        );
        assert_eq!(
            screen("t", &["ctrl", "alt"], Platform::Linux),
            ChordClass::Window
        );
        assert_eq!(
            screen("l", &["ctrl", "alt"], Platform::Linux),
            ChordClass::Beyond
        );
        assert_eq!(screen("l", &["super"], Platform::Linux), ChordClass::Beyond);
    }

    /// Option over the pointer reaches the application's other windows,
    /// which an application grant covers; the desktop's key never.
    #[test]
    fn an_application_grant_takes_option_over_the_pointer() {
        let m = |names: &[&str]| Modifiers::parse(names).unwrap();
        assert!(pointer_modifiers_allowed_for_app(
            m(&["option", "cmd"]),
            Platform::Mac
        ));
        assert!(pointer_modifiers_allowed_for_app(
            m(&["alt"]),
            Platform::Windows
        ));
        assert!(!pointer_modifiers_allowed_for_app(
            m(&["win"]),
            Platform::Windows
        ));
        assert!(!pointer_modifiers_allowed_for_app(
            m(&["super"]),
            Platform::Linux
        ));
    }

    /// Copying and cutting are the shortcut modifier with C or X, on each
    /// platform's own modifier; nothing else is watched.
    #[test]
    fn copying_is_the_shortcut_modifier_with_c_or_x() {
        assert!(copies(&chord("c", &["cmd"]), Platform::Mac));
        assert!(copies(&chord("x", &["cmd", "shift"]), Platform::Mac));
        assert!(!copies(&chord("c", &["ctrl"]), Platform::Mac));
        assert!(copies(&chord("c", &["ctrl"]), Platform::Windows));
        assert!(copies(&chord("x", &["ctrl"]), Platform::Linux));
        assert!(!copies(&chord("v", &["ctrl"]), Platform::Linux));
        assert!(!copies(&chord("c", &[]), Platform::Windows));
    }

    /// A title is a paste's in any of the languages listed, wherever the
    /// word sits in it.
    #[test]
    fn paste_is_known_by_its_name() {
        for title in [
            "Paste",
            "Paste and Match Style",
            "  paste special…",
            "粘贴并匹配样式",
            "貼上",
            "ペースト",
            "Einsetzen",
            "Coller",
            "Вставить",
        ] {
            assert!(names_paste(title), "{title}");
        }
        for title in ["Copy", "Cut", "Close", "Select All", "复制", "Kopieren"] {
            assert!(!names_paste(title), "{title}");
        }
    }

    /// Keys are held over a drag only where the driver holds them.
    #[test]
    fn drags_hold_keys_only_on_a_mac() {
        let shift = Modifiers::parse(&["shift"]).unwrap();
        assert!(drag_carries_modifiers(shift, Platform::Mac));
        for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
            assert!(drag_carries_modifiers(Modifiers::default(), platform));
        }
        assert!(!drag_carries_modifiers(shift, Platform::Windows));
        assert!(!drag_carries_modifiers(shift, Platform::Linux));
    }

    fn chord(key: &str, modifiers: &[&str]) -> Chord {
        Chord {
            key: Key::parse(key).unwrap(),
            modifiers: Modifiers::parse(modifiers).unwrap(),
        }
    }

    /// Names are read case-insensitively with their common aliases, and a
    /// name that is no key is refused rather than guessed at — the Windows
    /// driver would press its first letter.
    #[test]
    fn keys_parse_into_one_closed_vocabulary() {
        assert_eq!(Key::parse("Enter"), Ok(Key::Return));
        assert_eq!(Key::parse("ESC"), Ok(Key::Escape));
        assert_eq!(Key::parse("ArrowUp"), Ok(Key::Up));
        assert_eq!(Key::parse("page down"), Ok(Key::PageDown));
        assert_eq!(Key::parse("A"), Ok(Key::Char('a')));
        assert_eq!(Key::parse("7"), Ok(Key::Char('7')));
        assert_eq!(Key::parse("/"), Ok(Key::Char('/')));
        assert_eq!(Key::parse("F12"), Ok(Key::F(12)));
        for bad in ["printscreen", "f13", "f0", "é", "!", "volumeup", "", "cmd"] {
            assert!(Key::parse(bad).is_err(), "{bad}");
        }
        assert!(Modifiers::parse(&["hyper"]).is_err());
        assert_eq!(
            Modifiers::parse(&["Command", "option"]).unwrap(),
            Modifiers {
                meta: true,
                alt: true,
                ..Modifiers::default()
            }
        );
    }

    /// Each platform's driver gets its own spelling — the one that differs
    /// being "delete", which the Mac driver reads as backspace.
    #[test]
    fn keys_are_written_in_each_drivers_spelling() {
        assert_eq!(Key::Delete.driver_name(Platform::Mac), "forward_delete");
        assert_eq!(Key::Delete.driver_name(Platform::Windows), "delete");
        assert_eq!(Key::Backspace.driver_name(Platform::Mac), "backspace");
        let all = Modifiers {
            shift: true,
            control: true,
            alt: true,
            meta: true,
        };
        assert_eq!(
            all.driver_names(Platform::Mac),
            vec!["shift", "ctrl", "option", "cmd"]
        );
        assert_eq!(
            all.driver_names(Platform::Windows),
            vec!["shift", "ctrl", "alt", "win"]
        );
        assert_eq!(
            all.driver_names(Platform::Linux),
            vec!["shift", "ctrl", "alt", "super"]
        );
    }

    /// The editing and navigation chords stay in the window; paste is told
    /// apart; the application's and the desktop's chords are refused.
    #[test]
    fn a_window_grant_allows_editing_and_navigation_only() {
        let mac = Platform::Mac;
        for ok in [
            chord("return", &[]),
            chord("tab", &["shift"]),
            chord("left", &["shift"]),
            chord("a", &[]),
            chord("a", &["cmd"]),
            chord("c", &["cmd"]),
            chord("z", &["cmd", "shift"]),
            chord("g", &["cmd", "shift"]),
            chord("left", &["cmd", "shift"]),
            chord("backspace", &["option"]),
            chord("right", &["option", "shift"]),
            chord("delete", &[]),
        ] {
            assert_eq!(classify(&ok, mac), ChordClass::Window, "{ok:?}");
        }
        for paste in [
            chord("v", &["cmd"]),
            chord("v", &["cmd", "shift"]),
            chord("v", &["cmd", "shift", "option"]),
        ] {
            assert_eq!(classify(&paste, mac), ChordClass::Paste, "{paste:?}");
        }
        for beyond in [
            chord("q", &["cmd"]),
            chord("w", &["cmd"]),
            chord("tab", &["cmd"]),
            chord("space", &["cmd"]),
            chord("h", &["cmd"]),
            chord("q", &["cmd", "ctrl"]),
            chord("q", &["cmd", "shift"]),
            chord("escape", &["cmd", "option"]),
            chord("a", &["ctrl"]),
            chord("e", &["option"]),
            chord("f11", &[]),
            chord("y", &["cmd"]),
            // ⇧⌘A opens a Finder folder; ⇧⌘⌫ empties the Trash; ⌘⌫ moves a
            // file to it.
            chord("a", &["cmd", "shift"]),
            chord("backspace", &["cmd", "shift"]),
            chord("backspace", &["option", "shift"]),
            chord("backspace", &["cmd"]),
            chord("delete", &["cmd"]),
        ] {
            assert_eq!(classify(&beyond, mac), ChordClass::Beyond, "{beyond:?}");
        }

        let win = Platform::Windows;
        assert_eq!(classify(&chord("c", &["ctrl"]), win), ChordClass::Window);
        assert_eq!(
            classify(&chord("backspace", &["ctrl"]), win),
            ChordClass::Window
        );
        // Deletes a selected file for good in the File Explorer.
        assert_eq!(
            classify(&chord("delete", &["shift"]), win),
            ChordClass::Beyond
        );
        assert_eq!(classify(&chord("y", &["ctrl"]), win), ChordClass::Window);
        assert_eq!(
            classify(&chord("home", &["ctrl", "shift"]), win),
            ChordClass::Window
        );
        assert_eq!(classify(&chord("v", &["ctrl"]), win), ChordClass::Paste);
        for beyond in [
            chord("f4", &["alt"]),
            chord("tab", &["alt"]),
            chord("l", &["win"]),
            chord("r", &["win"]),
            chord("delete", &["ctrl", "alt"]),
            chord("c", &["cmd"]),
            chord("w", &["ctrl"]),
            chord("f", &["alt"]),
        ] {
            assert_eq!(classify(&beyond, win), ChordClass::Beyond, "{beyond:?}");
        }
    }

    /// Only a bare or shifted character key types text; a chord with the
    /// shortcut modifier does not.
    #[test]
    fn only_character_keys_type_text() {
        assert!(chord("a", &[]).types_text());
        assert!(chord("a", &["shift"]).types_text());
        assert!(chord("space", &[]).types_text());
        assert!(!chord("a", &["cmd"]).types_text());
        assert!(!chord("return", &[]).types_text());
        assert!(!chord("backspace", &[]).types_text());
    }
}
