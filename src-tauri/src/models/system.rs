use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SystemProxySettings {
    pub enabled: bool,
    pub proxy_url: Option<String>,
    /// Hosts that connect directly instead of through the proxy, as a
    /// comma-separated list. Exported as `NO_PROXY` behind the loopback hosts
    /// codeg always adds (see [`crate::network::proxy::no_proxy_env_value`]).
    /// `#[serde(default)]` so rows stored before this field existed still parse.
    #[serde(default)]
    pub no_proxy: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AppLocale {
    #[default]
    En,
    ZhCn,
    ZhTw,
    Ja,
    Ko,
    Es,
    De,
    Fr,
    Pt,
    Ar,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum LanguageMode {
    #[default]
    System,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SystemLanguageSettings {
    pub mode: LanguageMode,
    pub language: AppLocale,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SystemTerminalSettings {
    pub default_shell: Option<String>,
    /// Force ANSI color out of the commands an agent runs, so its output
    /// renders colored in the transcript's terminal card rather than as plain
    /// text.
    ///
    /// Off by default, and deliberately so: the only lever codeg has is the
    /// AGENT process's env (the agent runs its own bash tool in-process — codeg
    /// never spawns those commands), which every descendant inherits. What it
    /// injects there — `CLICOLOR` + `CLICOLOR_FORCE` for the BSD/Go/Rust
    /// toolchain, `FORCE_COLOR` for the npm one, and a pinned `TERM` for the
    /// terminfo lookup both need — colors the output codeg renders AND the
    /// output the agent pipes into `jq`, and the force flags outrank `NO_COLOR`,
    /// so nothing downstream can opt back out. See
    /// [`crate::acp::connection::force_command_color_enabled`].
    ///
    /// Carried in the terminal settings row rather than a key of its own
    /// because it is read on the same startup load and written by the same save
    /// path; `#[serde(default)]` on the struct means rows stored before this
    /// field existed parse as `false` with no migration.
    pub colorize_command_output: bool,
}

/// One row in the "default shell" picker. Backend owns the option list so the
/// frontend doesn't have to know which shells are available on which platform.
/// Labels are not localized server-side: `label_key` points at a frontend i18n
/// key under `GeneralSettings.*`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalShellOption {
    /// Stable identifier the dropdown uses as its <option value>.
    pub id: String,
    /// i18n key resolved by the frontend (`GeneralSettings.<label_key>`).
    pub label_key: String,
    /// Concrete value persisted into `SystemTerminalSettings.default_shell`.
    /// `None` for `system` (use `resolve_shell()`) and `custom` (user supplies path).
    pub value: Option<String>,
    /// Whether this shell is currently resolvable on the host. `false` lets
    /// the UI mark the option as "not installed" without preventing selection.
    pub exists: bool,
    /// True for the `custom` row — the UI should render a path input next to
    /// the dropdown when this option is selected.
    pub accepts_custom_path: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailableTerminalShells {
    pub options: Vec<TerminalShellOption>,
    /// What a terminal tab opened right now would launch, given the stored
    /// selection: the platform fallback when the selection is "system default",
    /// and otherwise the chosen shell resolved to a concrete path. Surfaced
    /// read-only in the UI, which is the only place a user can see that
    /// "Windows PowerShell" means `…\v1.0\powershell.exe` — or that a custom
    /// path resolved to nothing. Best-effort by nature; see
    /// [`crate::commands::system_settings::resolve_effective_shell`] for which
    /// promises it does and does not make.
    pub resolved_shell: String,
}

/// What the main window's close button does.
///
/// Three values rather than the two a settings page needs, because the third
/// is what makes the other two discoverable: codeg has always hidden to tray,
/// and a user who believes the app exited never goes looking for a preference
/// to change. `Ask` shows the choice once, on the first close, and pins itself
/// to `Minimize` or `Exit` from there.
#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CloseWindowBehavior {
    #[default]
    Ask,
    Minimize,
    Exit,
}

#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SystemCloseBehaviorSettings {
    pub behavior: CloseWindowBehavior,
}

/// The settings-page view. `tray_available` is a live platform capability, not
/// a stored value: where the tray is unusable the close button force-exits and
/// the preference cannot apply, so the UI disables the control and says why.
/// Sending it from the backend keeps the frontend from re-deriving it by
/// guessing at the OS.
#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SystemCloseBehaviorSettingsView {
    pub behavior: CloseWindowBehavior,
    pub tray_available: bool,
}

#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SystemRenderingSettings {
    pub disable_hardware_acceleration: bool,
}

/// "Launch at login". The OS registration itself is the source of truth
/// (registry Run value / LaunchAgent plist / XDG autostart entry), so there is
/// no mirrored copy in the database — the toggle always reflects what the
/// system would actually do, including changes made outside the app (e.g.
/// Windows Task Manager's Startup tab).
///
/// Known limitation, inherited from `auto-launch` 0.5: on macOS and Linux
/// `is_enabled()` only asks whether the file exists. macOS Ventura's Login
/// Items and GNOME both disable an entry *in place*, leaving the file behind,
/// so after one of those the toggle reads on while login will not start the
/// app. Turning it off and on again in this UI rewrites the entry and restores
/// agreement. Windows does not have the gap — its `is_enabled()` also consults
/// the StartupApproved key that Task Manager writes.
#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SystemAutostartSettings {
    pub enabled: bool,
}

// --- Version Control ---

/// Explicit credentials for a single git remote operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCredentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDetectResult {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct GitSettings {
    pub custom_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubAccount {
    pub id: String,
    pub server_url: String,
    pub username: String,
    pub scopes: Vec<String>,
    pub avatar_url: Option<String>,
    pub is_default: bool,
    pub created_at: String,
    /// Which forge this account signs in to: `"github"` | `"gitlab"` |
    /// `"gitea"` (which covers Forgejo), or absent. Absent is what every
    /// account stored before GitLab support existed looks like, and it keeps
    /// meaning what it always meant — a
    /// credential for this HOST, whichever forge lives there. Set, it also
    /// says which API the token is for, which is the only reliable signal for
    /// a self-hosted instance whose hostname gives nothing away.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct GitHubAccountsSettings {
    pub accounts: Vec<GitHubAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubTokenValidation {
    pub success: bool,
    pub username: Option<String>,
    pub scopes: Vec<String>,
    pub avatar_url: Option<String>,
    pub message: Option<String>,
}
