//! The driver's accessibility tree, read line by line: which lines start an
//! element, which elements can be acted on, and which are secrets.
//!
//! The driver writes values unescaped, newlines included, so a node is not a
//! line: it runs from a line that starts one (see [`Dialect::head`]) to the
//! next, and a secret's value goes with every line of it.
//!
//! Secrets are judged once, here, for two uses: the value of a secret field
//! never leaves the helper, and nothing is ever typed into one. The two
//! cannot disagree — a field the agent sees as `[redacted]` is the field it
//! cannot type into.

use std::collections::BTreeSet;

/// Words that mark a field as a secret, in the languages codeg ships in.
const SECRET_WORDS: &[&str] = &[
    "password",
    "passwd",
    "passcode",
    "passphrase",
    "secret",
    "pin code",
    "密码",
    "密碼",
    "口令",
    "パスワード",
    "비밀번호",
    "contraseña",
    "mot de passe",
    "passwort",
    "senha",
    "كلمة المرور",
];

/// A tree with every secret's value taken out, and what is known of each
/// element in it that can be acted on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    pub tree: String,
    /// In tree order.
    pub nodes: Vec<TreeNode>,
}

/// One element that can be acted on: a node whose line carries `[N]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNode {
    pub index: u32,
    /// Where its line starts in [`Redacted::tree`], in bytes.
    pub offset: u32,
    /// Its role as the tree spells it: `AXTextField`, `Edit`, `password text`.
    pub role: String,
    /// A password or other secret field.
    pub secret: bool,
}

/// Take the value out of every tree node that describes a secret, and name
/// the elements that can be acted on.
///
/// The platforms already refuse to hand a secure field's text to an
/// accessibility client — macOS answers bullets for a secure text field,
/// Windows refuses a password edit's value to other processes — so this is
/// the second line, not the first: a node whose role names a password
/// control, or whose label says it is one, or whose value is nothing but
/// bullets, keeps its role and label and loses its value. The driver's tree
/// does not carry macOS subroles, so a secure field is recognised here by its
/// words; recognising it by subrole needs the driver to report one.
pub fn redact_secrets(tree: &str) -> Redacted {
    redact_tree(tree, Dialect::current())
}

/// The roles of an application's menu bars in the macOS tree — its menus
/// and its status items — and of the items on them.
pub const APP_MENU_ROLES: &[&str] = &["AXMenuBar", "AXExtrasMenuBar", "AXMenuBarItem"];

/// How much of its application's menu bars a window's tree keeps (macOS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppMenus<'a> {
    /// None of them: a window shared on its own does not reach its
    /// application's menus.
    Withheld,
    /// The application's own menus, for an application shared as a whole —
    /// but not the Apple menu and the application menu, the first two items
    /// of its menu bar, named here by their titles as Accessibility gives
    /// them (a tree cut down by a query may not show either, and a row's
    /// place in it says nothing): they restart and log out, run Services and
    /// hide every other application, reaching past this one.
    Own { protected: &'a [String; 2] },
}

/// The tree without what `keep` leaves out of its application's menu bars,
/// and the indices of the elements that were in it (macOS).
///
/// The driver's tree of a window carries its application's menu bars along
/// with it. A menu bar's row goes with every line under it, up to the next
/// row no deeper than itself — and so does each item on it, row by row,
/// since the driver leaves out a menu bar's own row when it has nothing to
/// say, keeping its items at their depth. Elsewhere a window's menus are its
/// own, and the tree is left whole.
pub fn without_app_menus(
    tree: &str,
    dialect: Dialect,
    keep: AppMenus<'_>,
) -> (String, BTreeSet<u32>) {
    let mut withheld = BTreeSet::new();
    if dialect != Dialect::Mac {
        return (tree.to_string(), withheld);
    }
    let mut out = String::with_capacity(tree.len());
    // The depth of what is being left out, while something is.
    let mut leaving: Option<usize> = None;
    for line in tree.split_inclusive('\n') {
        if let Some(head) = dialect.head(line) {
            let depth = line.len() - line.trim_start_matches(' ').len();
            if leaving.is_some_and(|start| depth <= start) {
                leaving = None;
            }
            if leaving.is_none() {
                let leave = match (head.role, keep) {
                    ("AXMenuBar" | "AXExtrasMenuBar" | "AXMenuBarItem", AppMenus::Withheld) => true,
                    ("AXMenuBarItem", AppMenus::Own { protected }) => protected
                        .iter()
                        .any(|title| line.contains(&format!("AXMenuBarItem \"{title}\""))),
                    _ => false,
                };
                if leave {
                    leaving = Some(depth);
                }
            }
            if leaving.is_some() {
                withheld.extend(head.index);
            }
        }
        if leaving.is_none() {
            out.push_str(line);
        }
    }
    (out, withheld)
}

/// The shape of a node line in the driver's tree on each platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// `- [3] AXTextField "Title" = "value" (description) [attrs]`
    Mac,
    /// `- [3] Edit "Name" [value="…" id=… actions=[…]]`, and `- Text "Name" = "…"`
    Windows,
    /// `- [3] password text "name" value="…" [actions=[…]]`, and `- label = "name"`
    Linux,
}

/// What a node's first line says about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeHead<'a> {
    /// The `N` of `[N]`: only elements that can be acted on carry one.
    pub index: Option<u32>,
    pub role: &'a str,
}

impl Dialect {
    /// Where a node's value starts in this platform's tree: after ` = ` on
    /// every macOS node and on the other platforms' plain nodes; in
    /// `[value="…"` (Windows) or ` value="…"` (Linux) on their addressable
    /// ones. Only this platform's: another's marker in a title is just text.
    fn value_markers(self) -> &'static [&'static str] {
        match self {
            Dialect::Mac => &[" = \""],
            Dialect::Windows => &[" = \"", " [value=\""],
            Dialect::Linux => &[" = \"", " value=\""],
        }
    }

    /// What can only follow the quote that closes a value in this platform's
    /// tree — a description or an attribute block (macOS), the next attribute
    /// in the block the value sits in (Windows), the attribute block (Linux) —
    /// besides the end of the node.
    fn after_value(self) -> &'static [&'static str] {
        match self {
            Dialect::Mac => &["\" (", "\" ["],
            Dialect::Windows => &["\" id=", "\" help=", "\" actions=", "\"]"],
            Dialect::Linux => &["\" [actions="],
        }
    }

    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Dialect::Mac
        } else if cfg!(windows) {
            Dialect::Windows
        } else {
            Dialect::Linux
        }
    }

    /// Whether `line` starts a node rather than continuing the value of the
    /// one above it.
    pub fn starts_node(self, line: &str) -> bool {
        self.head(line).is_some()
    }

    /// The head of the node `line` starts, if it starts one: indentation in
    /// whole steps, `- `, an optional `[index] `, then a role as this
    /// platform's tree spells one — an `AX` role on macOS, one of UI
    /// Automation's control types on Windows, an AT-SPI role name followed by
    /// the quoted name every Linux node carries. A value's own lines are the
    /// user's text; the stricter this is, the less of that text can pass for
    /// a node and escape its node's redaction.
    pub fn head(self, line: &str) -> Option<NodeHead<'_>> {
        let line = line.trim_end_matches('\n');
        let rest = line.trim_start_matches(' ');
        if !(line.len() - rest.len()).is_multiple_of(2) {
            return None;
        }
        let mut rest = rest.strip_prefix("- ")?;
        let mut index = None;
        if let Some(inner) = rest.strip_prefix('[') {
            let close = inner.find("] ")?;
            if close == 0 || !inner[..close].bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            index = Some(inner[..close].parse::<u32>().ok()?);
            rest = &inner[close + 2..];
        }
        // What may follow a role in a node line: nothing, a quoted title or
        // name, a value, a description, an attribute block.
        let follows = |after: &str, allowed: &[&str]| {
            after.is_empty() || allowed.iter().any(|a| after.starts_with(a))
        };
        let role = match self {
            Dialect::Mac => {
                let end = rest
                    .bytes()
                    .position(|b| !b.is_ascii_alphanumeric())
                    .unwrap_or(rest.len());
                (rest.starts_with("AX")
                    && end > 2
                    && follows(&rest[end..], &[" \"", " = \"", " (", " ["]))
                    .then(|| &rest[..end])
            }
            Dialect::Windows => {
                let end = rest
                    .bytes()
                    .position(|b| !b.is_ascii_alphabetic())
                    .unwrap_or(rest.len());
                (UIA_CONTROL_TYPES.contains(&&rest[..end])
                    && follows(&rest[end..], &[" \"", " = \"", " ["]))
                    .then(|| &rest[..end])
            }
            Dialect::Linux => {
                // `- [3] push button "name" …` and `- label = "name"`: an
                // AT-SPI node always carries its name, quoted.
                let end = rest
                    .bytes()
                    .position(|b| !(b.is_ascii_lowercase() || b == b' '))
                    .unwrap_or(rest.len());
                let role = rest[..end].trim_end();
                let after = &rest[role.len()..];
                (!role.is_empty()
                    && after.starts_with(if index.is_some() { " \"" } else { " = \"" }))
                .then_some(role)
            }
        }?;
        Some(NodeHead { index, role })
    }
}

/// UI Automation's control types, as cua-driver names them in its Windows
/// tree.
const UIA_CONTROL_TYPES: &[&str] = &[
    "AppBar", "Button", "Calendar", "CheckBox", "ComboBox", "Custom", "DataGrid", "DataItem",
    "Document", "Edit", "Group", "Header", "HeaderItem", "Hyperlink", "Image", "List",
    "ListItem", "Menu", "MenuBar", "MenuItem", "Pane", "ProgressBar", "RadioButton",
    "ScrollBar", "SemanticZoom", "Separator", "Slider", "Spinner", "SplitButton", "StatusBar",
    "Tab", "TabItem", "Table", "Text", "Thumb", "TitleBar", "ToolBar", "ToolTip", "Tree",
    "TreeItem", "Unknown", "Window",
];

pub fn redact_tree(tree: &str, dialect: Dialect) -> Redacted {
    let mut out = Redacted {
        tree: String::with_capacity(tree.len()),
        nodes: Vec::new(),
    };
    let mut node = String::new();
    for line in tree.split_inclusive('\n') {
        if !node.is_empty() && dialect.starts_node(line) {
            push_node(&mut out, &node, dialect);
            node.clear();
        }
        node.push_str(line);
    }
    push_node(&mut out, &node, dialect);
    out
}

fn push_node(out: &mut Redacted, node: &str, dialect: Dialect) {
    let offset = u32::try_from(out.tree.len()).unwrap_or(u32::MAX);
    let (text, secret) = redact_node(node, dialect);
    let first_line = node.split_inclusive('\n').next().unwrap_or("");
    if let Some(NodeHead {
        index: Some(index),
        role,
    }) = dialect.head(first_line)
    {
        out.nodes.push(TreeNode {
            index,
            offset,
            role: role.to_string(),
            secret,
        });
    }
    out.tree.push_str(&text);
}

/// One node, redacted if it is a secret, and whether it is.
fn redact_node(node: &str, dialect: Dialect) -> (String, bool) {
    // The earliest marker: what is kept of a redacted node ends there, so it
    // can never hold any of the value.
    let marker = dialect
        .value_markers()
        .iter()
        .filter_map(|m| node.find(m).map(|i| (i, *m)))
        .min_by_key(|(i, _)| *i);
    // Judged on what names the node — its role and title before the value,
    // its description and attributes after it — never on the value itself: a
    // document that mentions a password is not a password field, and a
    // field's secret is not what says it is one. The one exception is a value
    // that is nothing but bullets, which is how a secure field shows its
    // contents.
    let (label, value) = match marker {
        Some((start, m)) => {
            let from = start + m.len();
            let after = after_value(node, from, dialect).max(from);
            (
                format!("{}{}", &node[..start], &node[after..]),
                Some(&node[from..after]),
            )
        }
        None => (node.to_string(), None),
    };
    let masked = value.is_some_and(is_masked);
    let secret = names_a_secret(&label) || masked;
    let Some((start, _)) = marker.filter(|_| secret) else {
        return (node.to_string(), secret);
    };
    // Everything from the value on goes, not just the value: the driver writes
    // values unescaped, so a value can contain `" (` or `" [` or a newline and
    // there is no telling where it ends. What stays — the index, the role and
    // the title — is what names the field.
    let newline = if node.ends_with('\n') { "\n" } else { "" };
    (
        format!(
            "{} = \"[redacted]\"{newline}",
            node[..start].trim_end_matches([' ', '['])
        ),
        true,
    )
}

/// Whether `text` — a node's role and label, never its value — says it is a
/// password or other secret field.
pub fn names_a_secret(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("securetextfield")
        || lower.contains("password text")
        || SECRET_WORDS.iter().any(|w| lower.contains(w))
}

/// A value that is nothing but the bullets a secure field shows in place of
/// its text.
pub fn is_masked(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value.chars().all(|c| matches!(c, '•' | '●' | '∙' | '⦁'))
}

/// Where the text after a node's value begins, as near as can be told: the
/// driver does not escape the quote that closes a value, so this is the
/// earliest quote on the node's last line (a value ends on the line its node
/// does) that is followed by what only comes after one in this platform's
/// tree, or the node's closing quote. Earlier is the safe side — more of the
/// node is read as label.
fn after_value(node: &str, value_from: usize, dialect: Dialect) -> usize {
    let body = node.trim_end_matches('\n');
    let last_line = body.rfind('\n').map_or(0, |i| i + 1);
    let from = last_line.max(value_from).min(body.len());
    let tail = &body[from..];
    dialect
        .after_value()
        .iter()
        .filter_map(|m| tail.find(m))
        .chain(tail.ends_with('"').then(|| tail.len() - 1))
        .min()
        .map_or(body.len(), |i| from + i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redacted(tree: &str, dialect: Dialect) -> String {
        redact_tree(tree, dialect).tree
    }

    /// A secret's value goes; its role and label, and every other line, stay.
    /// A window shared on its own is read without its application's menu
    /// bars: each goes with everything under it, and what follows at its
    /// depth or above stays — whether the driver wrote the bar's own row or
    /// left it out. An application shared as a whole keeps its own menus, and
    /// not the Apple menu and the application menu. Elsewhere the tree is
    /// left whole.
    #[test]
    fn the_applications_menu_bars_are_left_out() {
        let tree = "- [0] AXWindow \"Doc\"\n  - [1] AXButton \"Save\"\n- AXMenuBar\n  - [2] AXMenuBarItem \"Apple\"\n    - [3] AXMenuItem \"Restart…\"\n  - [4] AXMenuBarItem \"TextEdit\"\n  - [5] AXMenuBarItem \"File\"\n    - AXMenu\n      - [6] AXMenuItem \"Close\" = \"two\nlines\"\n  - [7] AXMenuBarItem \"Edit\"\n- [8] AXSheet \"Save as\"\n  - [9] AXButton \"OK\"\n- [10] AXExtrasMenuBar\n  - [11] AXMenuBarItem \"Status\"\n";
        let (kept, withheld) = without_app_menus(tree, Dialect::Mac, AppMenus::Withheld);
        assert_eq!(
            kept,
            "- [0] AXWindow \"Doc\"\n  - [1] AXButton \"Save\"\n- [8] AXSheet \"Save as\"\n  - [9] AXButton \"OK\"\n"
        );
        assert_eq!(
            withheld.into_iter().collect::<Vec<_>>(),
            vec![2, 3, 4, 5, 6, 7, 10, 11]
        );

        // The bar's own row left out by the driver: its items, at their
        // depth, go one by one — an open menu under them too.
        let rowless = "- [0] AXWindow \"Doc\"\n  - [1] AXButton \"Save\"\n  - [2] AXMenuBarItem \"Apple\"\n  - [3] AXMenuBarItem \"TextEdit\"\n  - [4] AXMenuBarItem \"Edit\"\n      - [5] AXMenuItem \"Paste\"\n  - [6] AXMenuBarItem \"Window\"\n- [7] AXSheet \"Save as\"\n";
        let (kept, withheld) = without_app_menus(rowless, Dialect::Mac, AppMenus::Withheld);
        assert_eq!(
            kept,
            "- [0] AXWindow \"Doc\"\n  - [1] AXButton \"Save\"\n- [7] AXSheet \"Save as\"\n"
        );
        assert_eq!(
            withheld.into_iter().collect::<Vec<_>>(),
            vec![2, 3, 4, 5, 6]
        );

        // Shared as a whole: its own menus stay; the Apple menu and the
        // application menu go, by their titles — wherever a query or the
        // status items' bar puts them.
        let protected = ["Apple".to_string(), "TextEdit".to_string()];
        let own = AppMenus::Own {
            protected: &protected,
        };
        let (kept, withheld) = without_app_menus(tree, Dialect::Mac, own);
        assert!(kept.contains("[5] AXMenuBarItem \"File\""), "{kept}");
        assert!(kept.contains("[6] AXMenuItem \"Close\""), "{kept}");
        assert!(kept.contains("[11] AXMenuBarItem \"Status\""), "{kept}");
        assert!(!kept.contains("Restart"), "{kept}");
        assert!(!kept.contains("\"TextEdit\""), "{kept}");
        assert_eq!(withheld.into_iter().collect::<Vec<_>>(), vec![2, 3, 4]);
        let queried = "  - [5] AXMenuBarItem \"File\"\n    - [6] AXMenuItem \"Close\"\n  - [7] AXMenuBarItem \"TextEdit Help\"\n";
        let (kept, withheld) = without_app_menus(queried, Dialect::Mac, own);
        assert_eq!(kept, queried);
        assert!(withheld.is_empty());
        let extras_first = "  - [1] AXMenuBarItem \"Status\"\n  - [2] AXMenuBarItem \"Apple\"\n  - [3] AXMenuBarItem \"TextEdit\"\n    - [4] AXMenuItem \"Quit TextEdit\"\n  - [5] AXMenuBarItem \"File\"\n";
        let (_, withheld) = without_app_menus(extras_first, Dialect::Mac, own);
        assert_eq!(withheld.into_iter().collect::<Vec<_>>(), vec![2, 3, 4]);

        let windows = "- [0] Window \"Doc\"\n  - [1] MenuBar \"Application\"\n";
        let (kept, withheld) = without_app_menus(windows, Dialect::Windows, AppMenus::Withheld);
        assert_eq!(kept, windows);
        assert!(withheld.is_empty());
    }

    #[test]
    fn secret_values_are_redacted_and_nothing_else_is() {
        let tree = "- [0] AXWindow \"Sign in\"\n  - [1] AXTextField \"Email\" = \"me@example.com\" [actions=[confirm]]\n  - [2] AXTextField \"Password\" = \"hunter2\" [id=pw actions=[confirm]]\n  - [3] AXTextField = \"秘密\" (密码)\n  - [4] AXSecureTextField = \"abc\" (x)\" (Code) [id=q]\n  - [5] AXStaticText = \"Forgot your password?\"\n";
        let out = redacted(tree, Dialect::Mac);
        assert!(
            out.contains("\"Email\" = \"me@example.com\" [actions=[confirm]]"),
            "{out}"
        );
        assert!(
            out.contains("- [2] AXTextField \"Password\" = \"[redacted]\"\n"),
            "{out}"
        );
        // A label after the value counts too.
        assert!(out.contains("- [3] AXTextField = \"[redacted]\"\n"), "{out}");
        // A value with a quote in it is cut at its start, not guessed at.
        assert!(
            out.contains("- [4] AXSecureTextField = \"[redacted]\"\n"),
            "{out}"
        );
        assert!(
            !out.contains("hunter2") && !out.contains("秘密") && !out.contains("(x)"),
            "{out}"
        );
        // Text that merely mentions the word is not a secret field.
        assert!(
            out.contains("AXStaticText = \"Forgot your password?\""),
            "{out}"
        );
        assert_eq!(out.lines().count(), tree.lines().count());
        assert!(out.starts_with("- [0] AXWindow \"Sign in\"\n"));
    }

    /// Values are written unescaped, so a secret can run over several lines;
    /// all of them go. A long value that is not a secret — a document that
    /// mentions a password in passing, even on its last line — keeps every
    /// line; a label that names a secret on a line of its own still counts.
    #[test]
    fn a_secret_that_spans_lines_goes_whole() {
        let tree = "- [0] AXWindow \"Keys\"\n  - [1] AXTextArea \"Secret key\" = \"-----BEGIN KEY-----\nMIIEabc\n- not a node\n-----END KEY-----\" [id=k]\n  - [2] AXTextArea = \"line one\nthe password is elsewhere\nline three\"\n  - [3] AXButton \"Copy\"\n";
        let out = redacted(tree, Dialect::Mac);
        assert!(
            out.contains("  - [1] AXTextArea \"Secret key\" = \"[redacted]\"\n  - [2]"),
            "{out}"
        );
        for leaked in ["MIIEabc", "not a node", "END KEY"] {
            assert!(!out.contains(leaked), "{leaked}: {out}");
        }
        assert!(
            out.contains("\"line one\nthe password is elsewhere\nline three\"\n"),
            "{out}"
        );
        assert!(out.ends_with("  - [3] AXButton \"Copy\"\n"), "{out}");

        let tree = "- [0] AXTextArea = \"notes\nremember: the password is in the vault\"\n- [1] AXTextField \"Enter your\npassword\nhere\" = \"hunter2\" [id=pw]\n- [2] AXTextField = \"s3cr3t\" (Account password) [help=\"x\" actions=[confirm]]\n";
        let out = redacted(tree, Dialect::Mac);
        assert!(out.contains("remember: the password is in the vault\"\n"), "{out}");
        assert!(
            out.contains("- [1] AXTextField \"Enter your\npassword\nhere\" = \"[redacted]\"\n"),
            "{out}"
        );
        assert!(out.ends_with("- [2] AXTextField = \"[redacted]\"\n"), "{out}");
        assert!(!out.contains("hunter2") && !out.contains("s3cr3t"), "{out}");

        // Another platform's markers are just text here: `value="` in a
        // macOS title does not start the value, and ` id=` in a document
        // does not end it.
        let tree = "- [0] AXTextField \"HTML input value=\"Password\"\" = \"hunter2\"\n- [1] AXTextArea = \"<form>\n<input type=\"text\" id=\"password\">\"\n";
        let out = redacted(tree, Dialect::Mac);
        assert!(!out.contains("hunter2"), "{out}");
        assert!(out.contains("<input type=\"text\" id=\"password\">\"\n"), "{out}");
    }

    /// Windows and Linux trees put an addressable element's value in
    /// `value="…"`, not after ` = `; it goes all the same.
    #[test]
    fn values_are_found_in_every_platforms_tree() {
        let windows = "- [0] Window \"Sign in\"\n  - [1] Edit \"Password\" [value=\"hunter2\" id=pw actions=[invoke]]\n  - [2] Edit \"User\" [value=\"me\"]\n  - Text \"PIN code\" = \"1234\"\n  - [3] Edit [value=\"one\n- Recovery code: 5678\n  - Button two\" help=\"Enter the password\"]\n  - [4] Button \"OK\"\n";
        let out = redacted(windows, Dialect::Windows);
        assert!(out.contains("  - [1] Edit \"Password\" = \"[redacted]\"\n"), "{out}");
        assert!(out.contains("  - [2] Edit \"User\" [value=\"me\"]\n"), "{out}");
        assert!(out.contains("  - Text \"PIN code\" = \"[redacted]\"\n"), "{out}");
        // A line of the value that looks like a list item is not a node.
        assert!(out.contains("  - [3] Edit = \"[redacted]\"\n  - [4] Button"), "{out}");
        for leaked in ["hunter2", "1234", "5678", "Button two"] {
            assert!(!out.contains(leaked), "{leaked}: {out}");
        }

        let linux = "- [0] frame \"Login\" [actions=[]]\n  - [1] password text \"\" value=\"s3cr3t\nmore\" [actions=[activate]]\n  - [2] push button \"OK\" [actions=[click]]\n";
        let out = redacted(linux, Dialect::Linux);
        assert!(
            out.contains("  - [1] password text \"\" = \"[redacted]\"\n  - [2] push button"),
            "{out}"
        );
        assert!(!out.contains("s3cr3t") && !out.contains("more"), "{out}");
    }

    /// What starts a node, per platform.
    #[test]
    fn node_lines_are_told_from_continuations() {
        assert!(Dialect::Mac.starts_node("  - [12] AXButton \"OK\"\n"));
        assert!(Dialect::Mac.starts_node("- AXGroup\n"));
        assert!(!Dialect::Mac.starts_node("- item\n"));
        assert!(!Dialect::Mac.starts_node("- AX\n"));
        assert!(!Dialect::Mac.starts_node("   - [1] AXButton\n"));
        assert!(!Dialect::Mac.starts_node("  - [x] AXButton\n"));
        assert!(Dialect::Windows.starts_node("  - [3] Edit \"a\"\n"));
        assert!(Dialect::Windows.starts_node("- Pane\n"));
        assert!(!Dialect::Windows.starts_node("  - edit\n"));
        assert!(!Dialect::Windows.starts_node("- Recovery code: 1234\n"));
        assert!(!Dialect::Windows.starts_node("- Editor notes\n"));
        assert!(!Dialect::Windows.starts_node("  - Button two\n"));
        assert!(Dialect::Windows.starts_node("  - [5] Button [actions=[invoke]]\n"));
        assert!(!Dialect::Mac.starts_node("- AXE is great\n"));
        assert!(Dialect::Linux.starts_node("  - [3] push button \"a\" [actions=[click]]\n"));
        assert!(Dialect::Linux.starts_node("  - label = \"Name\"\n"));
        assert!(!Dialect::Linux.starts_node("- recovery code: 1234\n"));
        assert!(!Dialect::Linux.starts_node("  - [3] push button\n"));
        assert!(!Dialect::Linux.starts_node("MIIEabc\n"));
    }

    /// Every element that can be acted on is named, in order, with where its
    /// line starts in the redacted tree — so a tree cut short says which refs
    /// its reader saw — and whether it is a secret.
    #[test]
    fn actionable_elements_are_named_with_their_place_and_secrecy() {
        let tree = "- [0] AXWindow \"Sign in\"\n  - AXStaticText = \"Welcome\"\n  - [1] AXTextField \"Email\" = \"me@example.com\"\n  - [2] AXTextField \"Password\" = \"hunter2\nsecond line\" [actions=[confirm]]\n  - [3] AXTextField = \"••••••\"\n  - [4] AXTextField \"PIN code\"\n  - [5] AXButton \"Sign in\"\n";
        let out = redact_tree(tree, Dialect::Mac);
        let nodes: Vec<(u32, &str, bool)> = out
            .nodes
            .iter()
            .map(|n| (n.index, n.role.as_str(), n.secret))
            .collect();
        assert_eq!(
            nodes,
            vec![
                (0, "AXWindow", false),
                (1, "AXTextField", false),
                (2, "AXTextField", true),
                (3, "AXTextField", true),
                // An empty secret field is still a secret field.
                (4, "AXTextField", true),
                (5, "AXButton", false),
            ]
        );
        for node in &out.nodes {
            let line = &out.tree[node.offset as usize..];
            assert!(
                line.trim_start().starts_with(&format!("- [{}] ", node.index)),
                "{line}"
            );
        }
        assert!(!out.tree.contains("hunter2") && !out.tree.contains("second line"));
        assert!(!out.tree.contains("••••"));
    }
}
