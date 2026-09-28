use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU32;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering as AtomicOrdering};
use std::sync::Mutex;

use sea_orm::DatabaseConnection;
use tauri::{
    window::{Effect, EffectState, EffectsBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::db::AppDatabase;
use crate::models::FolderDetail;

/// Base traffic-light position (logical px) at 100 % zoom, tuned for the
/// standard h-8 (32px) overlay title bar shared by the auxiliary windows
/// (commit / merge / push / stash / settings / …).
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_X: f64 = 12.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_Y: f64 = 17.0;
/// The workspace windows (local `main` + remote workspace) render the taller
/// h-10 (40px) `FolderTitleBar` that hosts the relocated conversation + file
/// tab strips, so their traffic lights sit ~5px lower to stay vertically
/// centred within the taller bar.
#[cfg(target_os = "macos")]
const WORKSPACE_TRAFFIC_LIGHT_Y: f64 = 22.0;

#[cfg(target_os = "macos")]
static CURRENT_ZOOM: AtomicU32 = AtomicU32::new(100);

#[cfg(target_os = "macos")]
fn traffic_light_position_at(base_y: f64) -> tauri::LogicalPosition<f64> {
    let zoom = CURRENT_ZOOM.load(AtomicOrdering::Relaxed) as f64;
    // Only Y scales with zoom: overlay content shifts vertically with
    // font-size changes, but the horizontal inset remains constant.
    tauri::LogicalPosition::new(TRAFFIC_LIGHT_X, base_y * zoom / 100.0)
}

/// Traffic-light position for the shared/auxiliary windows (standard bar).
#[cfg(target_os = "macos")]
fn traffic_light_position() -> tauri::LogicalPosition<f64> {
    traffic_light_position_at(TRAFFIC_LIGHT_Y)
}

/// Traffic-light position for the workspace windows (taller bar): the local
/// `main` window and every remote workspace window, both of which load the
/// `/workspace` route. macOS only; call sites are guarded with
/// `#[cfg(target_os = "macos")]`.
#[cfg(target_os = "macos")]
pub(crate) fn workspace_window_traffic_light_position() -> tauri::LogicalPosition<f64> {
    traffic_light_position_at(WORKSPACE_TRAFFIC_LIGHT_Y)
}

const ZOOM_LEVEL_DB_KEY: &str = "appearance_zoom_level";

/// Load saved zoom level from DB and initialize CURRENT_ZOOM.
/// Called once at startup before any window is created.
pub async fn load_saved_zoom(conn: &DatabaseConnection) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(Some(raw)) = app_metadata_service::get_value(conn, ZOOM_LEVEL_DB_KEY).await {
            if let Ok(zoom) = raw.parse::<u32>() {
                let clamped = zoom.clamp(50, 300);
                CURRENT_ZOOM.store(clamped, AtomicOrdering::Relaxed);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = conn;
    }
}

// ---------------------------------------------------------------------------
// Appearance mode persistence (dark / light / system)
// ---------------------------------------------------------------------------

const APPEARANCE_MODE_DB_KEY: &str = "appearance_mode";

/// Encoded appearance mode: 0 = system (default), 1 = dark, 2 = light.
static CACHED_APPEARANCE_MODE: AtomicU8 = AtomicU8::new(0);

const MODE_SYSTEM: u8 = 0;
const MODE_DARK: u8 = 1;
const MODE_LIGHT: u8 = 2;

fn mode_from_str(s: &str) -> u8 {
    match s {
        "dark" => MODE_DARK,
        "light" => MODE_LIGHT,
        _ => MODE_SYSTEM,
    }
}

/// Load saved appearance mode from DB. Called once at startup.
pub async fn load_saved_appearance_mode(conn: &DatabaseConnection) {
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, APPEARANCE_MODE_DB_KEY).await {
        CACHED_APPEARANCE_MODE.store(mode_from_str(&raw), AtomicOrdering::Relaxed);
    }
}

pub struct SettingsWindowState {
    owner_by_settings_label: Mutex<HashMap<String, String>>,
}

pub struct CommitWindowState {
    owner_by_commit_label: Mutex<HashMap<String, String>>,
}

/// Owner tracking for the auxiliary windows that have no state of their own:
/// stash, push, project boot and the session importer. They share one map
/// because their labels are already distinct namespaces, and because the
/// restore is the same three lines for all four.
pub struct AuxWindowState {
    owner_by_aux_label: Mutex<HashMap<String, String>>,
}

/// Detect macOS system dark mode via `defaults read`.
/// Result is cached for the process lifetime via `OnceLock`.
#[cfg(target_os = "macos")]
fn is_system_dark_mode() -> bool {
    use std::sync::OnceLock;
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        crate::process::std_command("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output()
            .map(|o| o.status.success()) // key exists only in dark mode
            .unwrap_or(false)
    })
}

/// Detect Windows system dark mode via registry query.
/// `AppsUseLightTheme`: 0 = dark, 1 = light.
/// Uses `crate::process::std_command` to avoid flashing a console window.
/// On pre-1809 Windows where the key is absent, defaults to light mode.
#[cfg(target_os = "windows")]
fn is_system_dark_mode() -> bool {
    use std::sync::OnceLock;
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        crate::process::std_command("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "/v",
                "AppsUseLightTheme",
            ])
            .output()
            .ok()
            .and_then(|o| {
                let stdout = String::from_utf8_lossy(&o.stdout);
                // Output: "    AppsUseLightTheme    REG_DWORD    0x0"
                // Extract the last token on the matching line to avoid
                // substring false-positives (e.g. "0x00000001" contains "0x0").
                stdout
                    .lines()
                    .find(|l| l.contains("AppsUseLightTheme"))
                    .map(|line| {
                        line.split_whitespace()
                            .last()
                            .map(|val| val == "0x0" || val == "0x00000000")
                            .unwrap_or(false)
                    })
            })
            .unwrap_or(false)
    })
}

/// Detect Linux system dark mode via desktop environment settings.
/// Covers GNOME (gsettings) and KDE Plasma (kreadconfig5/6).
/// Falls back to light mode on unsupported desktops (XFCE, etc.).
#[cfg(target_os = "linux")]
fn is_system_dark_mode() -> bool {
    use std::sync::OnceLock;
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        // GNOME 42+: color-scheme = 'prefer-dark'
        if let Ok(output) = crate::process::std_command("gsettings")
            .args(["get", "org.gnome.desktop.interface", "color-scheme"])
            .output()
        {
            let s = String::from_utf8_lossy(&output.stdout);
            if s.contains("prefer-dark") {
                return true;
            }
        }
        // Older GNOME / GTK: theme name contains "dark"
        if let Ok(output) = crate::process::std_command("gsettings")
            .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
            .output()
        {
            let s = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if s.contains("dark") {
                return true;
            }
        }
        // KDE Plasma 5/6: ColorScheme name contains "dark"
        for cmd in ["kreadconfig6", "kreadconfig5"] {
            if let Ok(output) = crate::process::std_command(cmd)
                .args(["--group", "General", "--key", "ColorScheme"])
                .output()
            {
                let s = String::from_utf8_lossy(&output.stdout).to_lowercase();
                if s.contains("dark") {
                    return true;
                }
            }
        }
        false
    })
}

/// Determine whether the window should use a dark background, considering
/// both the user's explicit preference (from DB) and the OS appearance.
fn should_use_dark_background() -> bool {
    match CACHED_APPEARANCE_MODE.load(AtomicOrdering::Relaxed) {
        MODE_DARK => true,
        MODE_LIGHT => false,
        _ => is_system_dark_mode(), // "system" or unknown — follow OS
    }
}

pub(crate) fn apply_platform_window_style<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    #[cfg(target_os = "macos")]
    {
        let builder = if should_use_dark_background() {
            // oklch(0.145 0 0) ≈ rgb(9,9,11) — matches CSS --background in dark mode
            builder.background_color(tauri::window::Color(9, 9, 11, 255))
        } else {
            builder
        };
        builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(traffic_light_position())
    }

    #[cfg(target_os = "windows")]
    {
        let builder = if should_use_dark_background() {
            builder.background_color(tauri::window::Color(9, 9, 11, 255))
        } else {
            builder
        };
        builder.decorations(false)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: drop the native GTK title bar so it doesn't stack on top of
        // the app's own toolbar (the "double title bar"). The frontend then
        // renders custom window controls + resize grips, mirroring Windows.
        let builder = if should_use_dark_background() {
            builder.background_color(tauri::window::Color(9, 9, 11, 255))
        } else {
            builder
        };
        builder.decorations(false)
    }
}

#[cfg(target_os = "windows")]
fn ensure_windows_undecorated(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(false);
}

#[cfg(not(target_os = "windows"))]
fn ensure_windows_undecorated(_window: &tauri::WebviewWindow) {}

/// Apply platform-specific post-creation setup.
pub(crate) fn post_window_setup(window: &tauri::WebviewWindow) {
    ensure_windows_undecorated(window);
}

impl SettingsWindowState {
    pub fn new() -> Self {
        Self {
            owner_by_settings_label: Mutex::new(HashMap::new()),
        }
    }

    fn set_owner(&self, settings_label: String, owner_label: String) {
        if let Ok(mut owners) = self.owner_by_settings_label.lock() {
            owners.insert(settings_label, owner_label);
        }
    }

    fn take_owner(&self, settings_label: &str) -> Option<String> {
        self.owner_by_settings_label
            .lock()
            .ok()
            .and_then(|mut owners| owners.remove(settings_label))
    }
}

impl Default for SettingsWindowState {
    fn default() -> Self {
        Self::new()
    }
}

impl CommitWindowState {
    pub fn new() -> Self {
        Self {
            owner_by_commit_label: Mutex::new(HashMap::new()),
        }
    }

    fn set_owner(&self, commit_label: String, owner_label: String) {
        if let Ok(mut owners) = self.owner_by_commit_label.lock() {
            owners.insert(commit_label, owner_label);
        }
    }

    fn take_owner(&self, commit_label: &str) -> Option<String> {
        self.owner_by_commit_label
            .lock()
            .ok()
            .and_then(|mut owners| owners.remove(commit_label))
    }
}

impl Default for CommitWindowState {
    fn default() -> Self {
        Self::new()
    }
}

impl AuxWindowState {
    pub fn new() -> Self {
        Self {
            owner_by_aux_label: Mutex::new(HashMap::new()),
        }
    }

    fn set_owner(&self, aux_label: String, owner_label: String) {
        if let Ok(mut owners) = self.owner_by_aux_label.lock() {
            owners.insert(aux_label, owner_label);
        }
    }

    fn take_owner(&self, aux_label: &str) -> Option<String> {
        self.owner_by_aux_label
            .lock()
            .ok()
            .and_then(|mut owners| owners.remove(aux_label))
    }
}

impl Default for AuxWindowState {
    fn default() -> Self {
        Self::new()
    }
}

fn resolve_settings_route(section: Option<&str>) -> &'static str {
    match section {
        // Explicit, even though `settings/general` is where an *unspecified*
        // section lands on the web transport: the desktop fallback below is
        // Appearance, so a caller that wants General has to name it.
        Some("general") => "settings/general",
        Some("appearance") => "settings/appearance",
        Some("agents") => "settings/agents",
        Some("mcp") => "settings/mcp",
        Some("skills") => "settings/skills",
        Some("experts") => "settings/experts",
        Some("science") => "settings/science",
        Some("office-tools") => "settings/office-tools",
        Some("collaboration") => "settings/collaboration",
        Some("browser") => "settings/browser",
        Some("version-control") => "settings/version-control",
        Some("shortcuts") => "settings/shortcuts",
        Some("system") => "settings/system",
        _ => "settings/appearance",
    }
}

fn normalize_agent_query(agent_type: Option<&str>) -> Option<String> {
    let raw = agent_type?.trim();
    if raw.is_empty() {
        return None;
    }
    if raw
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        return Some(raw.to_string());
    }
    None
}

fn resolve_settings_target(section: Option<&str>, agent_type: Option<&str>) -> String {
    let route = resolve_settings_route(section);
    if route == "settings/agents" {
        if let Some(agent) = normalize_agent_query(agent_type) {
            return format!("{route}?agent={agent}");
        }
    }
    route.to_string()
}

fn append_query_param(route: String, key: &str, value: &str) -> String {
    if route.contains('?') {
        format!("{route}&{key}={value}")
    } else {
        format!("{route}?{key}={value}")
    }
}

fn append_remote_context(
    route: String,
    remote_connection_id: Option<i32>,
    remote_window_id: Option<&str>,
) -> String {
    let Some(id) = remote_connection_id else {
        return route;
    };
    let route = append_query_param(route, "remoteConnectionId", &id.to_string());
    match remote_window_id {
        Some(window_id) => append_query_param(route, "remoteWindowId", window_id),
        None => route,
    }
}

fn route_with_new_remote_window(
    route: String,
    remote_connection_id: Option<i32>,
) -> (String, Option<String>) {
    let remote_window_id = remote_connection_id
        .map(|_| crate::commands::remote_workspace::new_remote_window_instance_id());
    let route = append_remote_context(route, remote_connection_id, remote_window_id.as_deref());
    (route, remote_window_id)
}

fn remote_window_id_from_window(window: &tauri::WebviewWindow) -> Option<String> {
    window.url().ok()?.query_pairs().find_map(|(key, value)| {
        if key == "remoteWindowId" && !value.is_empty() {
            Some(value.into_owned())
        } else {
            None
        }
    })
}

fn register_remote_window_cleanup(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    remote_window_id: Option<&str>,
) {
    let Some(remote_window_id) = remote_window_id else {
        return;
    };
    if let Some(proxy) =
        app.try_state::<std::sync::Arc<crate::commands::remote_proxy::RemoteProxyState>>()
    {
        proxy
            .inner()
            .register_window_instance_cleanup(window, remote_window_id.to_string());
    }
}

// ---------------------------------------------------------------------------
// Window title localization
// ---------------------------------------------------------------------------
//
// Window titles are set at creation time and not refreshed on locale change,
// which mirrors the behavior of native OS dialogs across the app. Translations
// live in Rust (not the frontend i18n JSON) because the title is applied via
// Tauri's window builder before the webview boots.

struct WindowTitles {
    settings: &'static str,
    commit: &'static str,
    merge: &'static str,
    stash: &'static str,
    push: &'static str,
    project_boot: &'static str,
    import_sessions: &'static str,
}

fn window_titles_for(locale: crate::models::system::AppLocale) -> WindowTitles {
    use crate::models::system::AppLocale;
    match locale {
        AppLocale::ZhCn => WindowTitles {
            settings: "设置",
            commit: "提交代码",
            merge: "解决冲突",
            stash: "储藏",
            push: "推送",
            project_boot: "项目启动器",
            import_sessions: "导入本地会话",
        },
        AppLocale::ZhTw => WindowTitles {
            settings: "設定",
            commit: "提交程式碼",
            merge: "解決衝突",
            stash: "暫存",
            push: "推送",
            project_boot: "專案啟動器",
            import_sessions: "匯入本機工作階段",
        },
        AppLocale::Ja => WindowTitles {
            settings: "設定",
            commit: "コミット",
            merge: "コンフリクトの解決",
            stash: "スタッシュ",
            push: "プッシュ",
            project_boot: "プロジェクトブート",
            import_sessions: "ローカルセッションをインポート",
        },
        AppLocale::Ko => WindowTitles {
            settings: "설정",
            commit: "커밋",
            merge: "충돌 해결",
            stash: "스태시",
            push: "푸시",
            project_boot: "프로젝트 부트",
            import_sessions: "로컬 세션 가져오기",
        },
        AppLocale::Es => WindowTitles {
            settings: "Configuración",
            commit: "Confirmar",
            merge: "Resolver conflictos",
            stash: "Reserva",
            push: "Enviar",
            project_boot: "Inicio de Proyecto",
            import_sessions: "Importar sesiones locales",
        },
        AppLocale::De => WindowTitles {
            settings: "Einstellungen",
            commit: "Commit",
            merge: "Konflikte lösen",
            stash: "Stash",
            push: "Push",
            project_boot: "Projekt-Starter",
            import_sessions: "Lokale Sitzungen importieren",
        },
        AppLocale::Fr => WindowTitles {
            settings: "Paramètres",
            commit: "Valider",
            merge: "Résoudre les conflits",
            stash: "Réserve",
            push: "Pousser",
            project_boot: "Lanceur de projet",
            import_sessions: "Importer les sessions locales",
        },
        AppLocale::Pt => WindowTitles {
            settings: "Configurações",
            commit: "Confirmar",
            merge: "Resolver conflitos",
            stash: "Stash",
            push: "Enviar",
            project_boot: "Inicializador de Projeto",
            import_sessions: "Importar sessões locais",
        },
        AppLocale::Ar => WindowTitles {
            settings: "الإعدادات",
            commit: "الالتزام",
            merge: "حل التعارضات",
            stash: "إخفاء",
            push: "دفع",
            project_boot: "مُنشئ المشروع",
            import_sessions: "استيراد الجلسات المحلية",
        },
        AppLocale::En => WindowTitles {
            settings: "Settings",
            commit: "Commit",
            merge: "Resolve Conflicts",
            stash: "Stash",
            push: "Push",
            project_boot: "Project Boot",
            import_sessions: "Import Local Sessions",
        },
    }
}

// When the frontend passes an explicit `locale`, use it — that's the
// authoritative effective locale (see lib/i18n.ts::getCurrentEffectiveAppLocale).
// Falling back to the DB only matters for callers that bypass the JS wrappers
// (e.g. a future HTTP client, internal tests).
async fn resolve_window_titles(
    conn: &DatabaseConnection,
    explicit: Option<crate::models::system::AppLocale>,
) -> WindowTitles {
    if let Some(locale) = explicit {
        return window_titles_for(locale);
    }
    let locale = crate::commands::system_settings::load_system_language_settings(conn)
        .await
        .map(|settings| settings.language)
        .unwrap_or_default();
    window_titles_for(locale)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder_window(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    // Single-window workspace: upsert the folder (is_open = true), close any
    // legacy project-boot window, and return the full detail for the frontend
    // to add to its workspace state.
    let entry = crate::db::service::folder_service::add_folder(&db.conn, &path)
        .await
        .map_err(AppCommandError::from)?;

    if let Some(w) = app.get_webview_window("project-boot") {
        let _ = w.close();
    }

    let folder = crate::db::service::folder_service::get_folder_by_id(&db.conn, entry.id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found after add"))?;

    // Bring the main window to focus if it exists
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.set_focus();
    }

    Ok(folder)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_commit_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    state: tauri::State<'_, CommitWindowState>,
    folder_id: i32,
    locale: Option<crate::models::system::AppLocale>,
    remote_connection_id: Option<i32>,
) -> Result<(), AppCommandError> {
    let owner_label = window.label().to_string();
    let label = match remote_connection_id {
        Some(remote_id) => format!("remote-commit-{remote_id}-{folder_id}"),
        None => format!("commit-{folder_id}"),
    };

    if let Some(existing) = app.get_webview_window(&label) {
        state.set_owner(label.clone(), owner_label);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus commit window", e.to_string()))?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let window_title = if remote_connection_id.is_some() {
        titles.commit.to_string()
    } else {
        let folder = crate::db::service::folder_service::get_folder_by_id(&db.conn, folder_id)
            .await
            .map_err(AppCommandError::from)?
            .ok_or_else(|| {
                AppCommandError::not_found(format!("Folder {folder_id} not found"))
                    .with_detail(format!("folder_id={folder_id}"))
            })?;
        format!("{} - {}", titles.commit, folder.name)
    };
    let (url_str, remote_window_id) =
        route_with_new_remote_window(format!("commit?folderId={folder_id}"), remote_connection_id);
    let url = WebviewUrl::App(url_str.into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(window_title)
        .inner_size(1220.0, 820.0)
        .min_inner_size(980.0, 620.0)
        .center();
    let builder = builder.parent(&window).map_err(|e| {
        AppCommandError::window("Failed to attach commit window to parent", e.to_string())
    })?;
    let commit_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open commit window", e.to_string()))?;
    register_remote_window_cleanup(&app, &commit_window, remote_window_id.as_deref());
    post_window_setup(&commit_window);
    state.set_owner(label, owner_label);
    commit_window
        .set_focus()
        .map_err(|e| AppCommandError::window("Failed to focus commit window", e.to_string()))?;

    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn open_settings_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    section: Option<String>,
    agent_type: Option<String>,
    locale: Option<crate::models::system::AppLocale>,
    remote_connection_id: Option<i32>,
    state: tauri::State<'_, SettingsWindowState>,
) -> Result<(), AppCommandError> {
    let settings_label = match remote_connection_id {
        Some(remote_id) => format!("remote-settings-{remote_id}"),
        None => "settings".to_string(),
    };
    let owner_label = window.label().to_string();
    if let Some(existing) = app.get_webview_window(&settings_label) {
        post_window_setup(&existing);
        if section.is_some() || agent_type.is_some() || remote_connection_id.is_some() {
            let existing_remote_window_id = remote_window_id_from_window(&existing);
            let generated_remote_window_id = remote_connection_id
                .filter(|_| existing_remote_window_id.is_none())
                .map(|_| crate::commands::remote_workspace::new_remote_window_instance_id());
            let remote_window_id = existing_remote_window_id
                .as_deref()
                .or(generated_remote_window_id.as_deref());
            if generated_remote_window_id.is_some() {
                register_remote_window_cleanup(&app, &existing, remote_window_id);
            }
            let target_route = append_remote_context(
                resolve_settings_target(section.as_deref(), agent_type.as_deref()),
                remote_connection_id,
                remote_window_id,
            );
            let target_path = format!("/{target_route}");
            let target_json = serde_json::to_string(&target_path).map_err(|e| {
                AppCommandError::window("Failed to build settings navigation target", e.to_string())
            })?;
            let nav_script = format!("window.location.replace({target_json});");
            existing.eval(&nav_script).map_err(|e| {
                AppCommandError::window("Failed to navigate settings window", e.to_string())
            })?;
        }
        let _ = state.take_owner(&settings_label);
        state.set_owner(settings_label, owner_label);
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| {
            AppCommandError::window("Failed to focus settings window", e.to_string())
        })?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let (target_route, remote_window_id) = route_with_new_remote_window(
        resolve_settings_target(section.as_deref(), agent_type.as_deref()),
        remote_connection_id,
    );
    let url = WebviewUrl::App(target_route.into());
    let builder = WebviewWindowBuilder::new(&app, &settings_label, url)
        .title(titles.settings)
        .inner_size(1080.0, 700.0)
        .min_inner_size(1080.0, 600.0)
        .center();
    // Intentionally NOT a child of the caller window: on macOS `.parent()`
    // attaches the window via `addChildWindow`, which makes settings move and
    // minimize together with the main window. Keep it an independent top-level
    // window; focus returns to the owner on close via
    // `restore_windows_after_settings` (the SettingsWindowState owner tracking
    // is independent of any parent/child relationship).
    let settings_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open settings window", e.to_string()))?;
    register_remote_window_cleanup(&app, &settings_window, remote_window_id.as_deref());
    post_window_setup(&settings_window);
    state.set_owner(settings_label, owner_label);
    settings_window
        .set_focus()
        .map_err(|e| AppCommandError::window("Failed to focus settings window", e.to_string()))?;
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_import_sessions_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    state: tauri::State<'_, AuxWindowState>,
    focus_path: Option<String>,
    locale: Option<crate::models::system::AppLocale>,
    remote_connection_id: Option<i32>,
) -> Result<(), AppCommandError> {
    let owner_label = window.label().to_string();
    let label = match remote_connection_id {
        Some(remote_id) => format!("remote-import-sessions-{remote_id}"),
        None => "import-sessions".to_string(),
    };

    let trimmed_focus = focus_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());

    if let Some(existing) = app.get_webview_window(&label) {
        // Re-anchor an already-open picker to the newly requested folder (the
        // folder context-menu entry passes its path) by navigating the existing
        // webview, mirroring the settings window's eval-nav on reuse. Preserve
        // the window's existing remote context. The global entry (no focus_path)
        // just refocuses so an in-progress selection is never reset.
        if let Some(path) = trimmed_focus {
            let existing_remote_window_id = remote_window_id_from_window(&existing);
            let route = append_remote_context(
                append_query_param(
                    "import-sessions".to_string(),
                    "focusPath",
                    &urlencoding::encode(path),
                ),
                remote_connection_id,
                existing_remote_window_id.as_deref(),
            );
            let target_path = format!("/{route}");
            let target_json = serde_json::to_string(&target_path).map_err(|e| {
                AppCommandError::window(
                    "Failed to build import navigation target",
                    e.to_string(),
                )
            })?;
            existing
                .eval(format!("window.location.replace({target_json});"))
                .map_err(|e| {
                    AppCommandError::window(
                        "Failed to navigate import sessions window",
                        e.to_string(),
                    )
                })?;
        }
        state.set_owner(label.clone(), owner_label);
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| {
            AppCommandError::window("Failed to focus import sessions window", e.to_string())
        })?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let mut route = "import-sessions".to_string();
    if let Some(path) = trimmed_focus {
        // `append_query_param` does not percent-encode, and filesystem paths
        // carry '&'/'#'/'?'-hostile characters — encode explicitly.
        route = append_query_param(route, "focusPath", &urlencoding::encode(path));
    }
    let (url_str, remote_window_id) = route_with_new_remote_window(route, remote_connection_id);
    let url = WebviewUrl::App(url_str.into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(titles.import_sessions)
        .inner_size(1080.0, 720.0)
        .min_inner_size(860.0, 560.0)
        .center();
    // Independent top-level window — same rationale as settings: `.parent()`
    // on macOS would make it move/minimize together with the opener.
    let import_window = apply_platform_window_style(builder).build().map_err(|e| {
        AppCommandError::window("Failed to open import sessions window", e.to_string())
    })?;
    register_remote_window_cleanup(&app, &import_window, remote_window_id.as_deref());
    post_window_setup(&import_window);
    state.set_owner(label, owner_label);
    import_window.set_focus().map_err(|e| {
        AppCommandError::window("Failed to focus import sessions window", e.to_string())
    })?;
    Ok(())
}

/// Bring `label` to the foreground: unminimize, unhide, then focus.
///
/// `set_focus` on its own is not enough: tao skips it outright while the
/// window is hidden or minimized (both the Windows and the macOS backend
/// guard on `is_visible && !is_minimized`), and the workspace close button
/// *hides* `main` to the tray (see the `main` `CloseRequested` arm in
/// `lib.rs`). Settings is deliberately an independent top-level window, so
/// the workspace can be hidden while it is still open; restoring an owner by
/// focus alone then left the app with nothing on screen once settings was
/// closed too.
///
/// Single source of truth for the sequence: the tray / dock / single-instance
/// path (`show_main_window`) and the auxiliary-window owner restores must not
/// drift apart again. `unminimize` is inert when the window isn't minimized
/// (macOS returns early; Windows first syncs the flag from `IsIconic`, so the
/// diff it applies is empty), and `show` preserves the maximized flag — a
/// tray-hidden maximized workspace comes back maximized.
fn show_and_focus_window(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn restore_windows_after_settings(
    app: &AppHandle,
    state: &SettingsWindowState,
    settings_window_label: &str,
) {
    if let Some(owner_label) = state.take_owner(settings_window_label) {
        show_and_focus_window(app, &owner_label);
    }
}

pub fn restore_window_after_commit(
    app: &AppHandle,
    state: &CommitWindowState,
    commit_window_label: &str,
) {
    if let Some(owner_label) = state.take_owner(commit_window_label) {
        show_and_focus_window(app, &owner_label);
    }
}

/// Owner restore for the stash / push / project-boot / import windows. Called
/// for every closing window rather than from a list of label prefixes: a
/// window that never registered an owner has none to hand back, so the map is
/// the only place that has to know which labels take part.
pub fn restore_window_after_aux(app: &AppHandle, state: &AuxWindowState, aux_window_label: &str) {
    if let Some(owner_label) = state.take_owner(aux_window_label) {
        show_and_focus_window(app, &owner_label);
    }
}

pub struct MergeWindowState {
    owner_by_merge_label: Mutex<HashMap<String, String>>,
}

impl MergeWindowState {
    pub fn new() -> Self {
        Self {
            owner_by_merge_label: Mutex::new(HashMap::new()),
        }
    }

    fn set_owner(&self, merge_label: String, owner_label: String) {
        if let Ok(mut owners) = self.owner_by_merge_label.lock() {
            owners.insert(merge_label, owner_label);
        }
    }

    fn take_owner(&self, merge_label: &str) -> Option<String> {
        self.owner_by_merge_label
            .lock()
            .ok()
            .and_then(|mut owners| owners.remove(merge_label))
    }
}

impl Default for MergeWindowState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn open_merge_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    state: tauri::State<'_, MergeWindowState>,
    folder_id: i32,
    operation: String,
    upstream_commit: Option<String>,
    locale: Option<crate::models::system::AppLocale>,
    remote_connection_id: Option<i32>,
) -> Result<(), AppCommandError> {
    let owner_label = window.label().to_string();
    let label = match remote_connection_id {
        Some(remote_id) => format!("remote-merge-{remote_id}-{folder_id}"),
        None => format!("merge-{folder_id}"),
    };

    if let Some(existing) = app.get_webview_window(&label) {
        state.set_owner(label.clone(), owner_label);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus merge window", e.to_string()))?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let window_title = if remote_connection_id.is_some() {
        titles.merge.to_string()
    } else {
        let folder = crate::db::service::folder_service::get_folder_by_id(&db.conn, folder_id)
            .await
            .map_err(AppCommandError::from)?
            .ok_or_else(|| {
                AppCommandError::not_found(format!("Folder {folder_id} not found"))
                    .with_detail(format!("folder_id={folder_id}"))
            })?;
        format!("{} - {}", titles.merge, folder.name)
    };
    let mut url_str = format!("merge?folderId={folder_id}&operation={operation}");
    if let Some(ref commit) = upstream_commit {
        url_str.push_str(&format!("&upstreamCommit={commit}"));
    }
    let (url_str, remote_window_id) = route_with_new_remote_window(url_str, remote_connection_id);
    let url = WebviewUrl::App(url_str.into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(window_title)
        .inner_size(1400.0, 900.0)
        .min_inner_size(1100.0, 650.0)
        .center();
    let builder = builder.parent(&window).map_err(|e| {
        AppCommandError::window("Failed to attach merge window to parent", e.to_string())
    })?;
    let merge_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open merge window", e.to_string()))?;
    register_remote_window_cleanup(&app, &merge_window, remote_window_id.as_deref());
    post_window_setup(&merge_window);
    state.set_owner(label, owner_label);
    merge_window
        .set_focus()
        .map_err(|e| AppCommandError::window("Failed to focus merge window", e.to_string()))?;

    Ok(())
}

pub fn restore_window_after_merge(
    app: &AppHandle,
    state: &MergeWindowState,
    merge_window_label: &str,
) {
    if let Some(owner_label) = state.take_owner(merge_window_label) {
        show_and_focus_window(app, &owner_label);
    }
}

/// Clean up dangling merge state when a merge window is closed without
/// completing or aborting. Checks if MERGE_HEAD exists, aborts the merge,
/// and notifies the parent window.
pub async fn cleanup_dangling_merge(app: &AppHandle, merge_window_label: &str) {
    let folder_id: i32 = match merge_window_label
        .strip_prefix("merge-")
        .and_then(|s| s.parse().ok())
    {
        Some(id) => id,
        None => return,
    };

    let db = match app.try_state::<AppDatabase>() {
        Some(db) => db,
        None => return,
    };

    let folder =
        match crate::db::service::folder_service::get_folder_by_id(&db.conn, folder_id).await {
            Ok(Some(f)) => f,
            _ => return,
        };

    // Check if MERGE_HEAD exists
    let check = crate::process::tokio_command("git")
        .args(["rev-parse", "--verify", "MERGE_HEAD"])
        .current_dir(&folder.path)
        .output()
        .await;
    let has_merge_head = check.map(|o| o.status.success()).unwrap_or(false);

    if has_merge_head {
        let _ = crate::process::tokio_command("git")
            .args(["merge", "--abort"])
            .current_dir(&folder.path)
            .output()
            .await;

        let emitter = crate::web::event_bridge::EventEmitter::Tauri(app.clone());
        crate::web::event_bridge::emit_event(
            &emitter,
            "folder://merge-aborted",
            serde_json::json!({ "folder_id": folder_id }),
        );
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_stash_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    state: tauri::State<'_, AuxWindowState>,
    folder_id: i32,
    locale: Option<crate::models::system::AppLocale>,
    remote_connection_id: Option<i32>,
) -> Result<(), AppCommandError> {
    let owner_label = window.label().to_string();
    let label = match remote_connection_id {
        Some(remote_id) => format!("remote-stash-{remote_id}-{folder_id}"),
        None => format!("stash-{folder_id}"),
    };

    if let Some(existing) = app.get_webview_window(&label) {
        post_window_setup(&existing);
        state.set_owner(label.clone(), owner_label);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus stash window", e.to_string()))?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let window_title = if remote_connection_id.is_some() {
        titles.stash.to_string()
    } else {
        let folder = crate::db::service::folder_service::get_folder_by_id(&db.conn, folder_id)
            .await
            .map_err(AppCommandError::from)?
            .ok_or_else(|| {
                AppCommandError::not_found(format!("Folder {folder_id} not found"))
                    .with_detail(format!("folder_id={folder_id}"))
            })?;
        format!("{} - {}", titles.stash, folder.name)
    };
    let (url_str, remote_window_id) =
        route_with_new_remote_window(format!("stash?folderId={folder_id}"), remote_connection_id);
    let url = WebviewUrl::App(url_str.into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(window_title)
        .inner_size(1100.0, 700.0)
        .min_inner_size(800.0, 500.0)
        .center();
    let stash_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open stash window", e.to_string()))?;
    register_remote_window_cleanup(&app, &stash_window, remote_window_id.as_deref());
    post_window_setup(&stash_window);
    state.set_owner(label, owner_label);

    Ok(())
}

/// Open (or raise) the push window for a folder.
///
/// `branch` is the branch to push: `None` targets whatever is checked out (the
/// toolbars' "push" entry), while the branch selector's per-branch push names
/// one explicitly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn open_push_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    state: tauri::State<'_, AuxWindowState>,
    folder_id: i32,
    locale: Option<crate::models::system::AppLocale>,
    remote_connection_id: Option<i32>,
    branch: Option<String>,
) -> Result<(), AppCommandError> {
    let owner_label = window.label().to_string();
    let label = match remote_connection_id {
        Some(remote_id) => format!("remote-push-{remote_id}-{folder_id}"),
        None => format!("push-{folder_id}"),
    };
    let branch = branch.filter(|value| !value.trim().is_empty());

    if let Some(existing) = app.get_webview_window(&label) {
        post_window_setup(&existing);
        state.set_owner(label.clone(), owner_label);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus push window", e.to_string()))?;
        // The window is reused as-is, so its URL still carries whatever branch it
        // was opened for. Without this the user picks branch B, we raise the
        // window still showing branch A, and the push button lies about its
        // target — so tell the live window to retarget.
        //
        // Emitted UNCONDITIONALLY, `None` included: going the other way — a
        // window opened for branch B, then raised by the plain "push" entry that
        // means "whatever is checked out" — is the same lie, so a null branch has
        // to reset the window rather than leave it on B.
        //
        // Addressed to THAT window rather than broadcast: folder ids are scoped
        // per connection, so a remote workspace's folder 5 and the local folder 5
        // both answer to the same `folder_id` and a broadcast would retarget the
        // wrong window. The address only binds because the window listens
        // against its own label — a listener on the default `Any` target would
        // receive this regardless (Tauri's `match_any_or_filter`).
        use tauri::Emitter;
        let _ = app.emit_to(
            &label,
            "push://retarget-branch",
            serde_json::json!({ "folder_id": folder_id, "branch": branch }),
        );
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let window_title = if remote_connection_id.is_some() {
        titles.push.to_string()
    } else {
        let folder = crate::db::service::folder_service::get_folder_by_id(&db.conn, folder_id)
            .await
            .map_err(AppCommandError::from)?
            .ok_or_else(|| {
                AppCommandError::not_found(format!("Folder {folder_id} not found"))
                    .with_detail(format!("folder_id={folder_id}"))
            })?;
        format!("{} - {}", titles.push, folder.name)
    };
    // Branch names carry `/` (and may carry `#`/`?`), so they have to be encoded
    // before riding a query string.
    let branch_param = branch
        .as_deref()
        .map(|value| format!("&branch={}", urlencoding::encode(value)))
        .unwrap_or_default();
    let (url_str, remote_window_id) = route_with_new_remote_window(
        format!("push?folderId={folder_id}{branch_param}"),
        remote_connection_id,
    );
    let url = WebviewUrl::App(url_str.into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(window_title)
        .inner_size(1100.0, 700.0)
        .min_inner_size(800.0, 500.0)
        .center();
    let builder = builder.parent(&window).map_err(|e| {
        AppCommandError::window("Failed to attach push window to parent", e.to_string())
    })?;
    let push_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open push window", e.to_string()))?;
    register_remote_window_cleanup(&app, &push_window, remote_window_id.as_deref());
    post_window_setup(&push_window);
    state.set_owner(label, owner_label);

    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_project_boot_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    state: tauri::State<'_, AuxWindowState>,
    source: Option<String>,
    locale: Option<crate::models::system::AppLocale>,
    remote_connection_id: Option<i32>,
) -> Result<(), AppCommandError> {
    let _ = source;
    let owner_label = window.label().to_string();
    let label = match remote_connection_id {
        Some(id) => format!("remote-project-boot-{id}"),
        None => "project-boot".to_string(),
    };
    if let Some(existing) = app.get_webview_window(&label) {
        post_window_setup(&existing);
        state.set_owner(label.clone(), owner_label);
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| {
            AppCommandError::window("Failed to focus project boot window", e.to_string())
        })?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let (url_str, remote_window_id) =
        route_with_new_remote_window("project-boot".to_string(), remote_connection_id);
    let url = WebviewUrl::App(url_str.into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(titles.project_boot)
        .inner_size(1400.0, 900.0)
        .min_inner_size(1100.0, 700.0)
        .center();
    let boot_window = apply_platform_window_style(builder).build().map_err(|e| {
        AppCommandError::window("Failed to open project boot window", e.to_string())
    })?;
    register_remote_window_cleanup(&app, &boot_window, remote_window_id.as_deref());
    post_window_setup(&boot_window);
    state.set_owner(label, owner_label);

    Ok(())
}

// ─── Desktop pet window ─────────────────────────────────────────────────

const PET_WINDOW_LABEL: &str = "pet";
const PET_HOVER_ENTER_EVENT: &str = "pet://hover-enter";
const PET_HOVER_LEAVE_EVENT: &str = "pet://hover-leave";
/// Single-frame logical pixel dimensions, locked to the Codex sprite-sheet
/// contract. The window is sized as one frame × user scale, with no extra
/// chrome — DPR handling lives inside the webview.
const PET_BASE_WIDTH: f64 = 192.0;
const PET_BASE_HEIGHT: f64 = 208.0;

/// Process-global "cursor is currently inside the pet window" flag, owned by
/// the hover watcher but readable/writable by the context-menu command so
/// that dismissing the native menu can force a fresh `enter` event. Without
/// this, the cursor never appears to "leave" while the menu is up — the
/// watcher's transition detector then misses the post-dismiss enter and
/// the user has to wiggle off-pet-and-back to re-trigger waving.
static PET_HOVER_WAS_INSIDE: AtomicBool = AtomicBool::new(false);

/// Apply the pet-window-specific platform style. Deliberately separate from
/// `apply_platform_window_style`: that helper sets a solid background color
/// for the main / settings / git windows, which would defeat the
/// transparent + chromeless pet window. The pet builder needs only
/// borderless decoration; transparency itself is set by the caller.
fn apply_pet_window_style<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    #[cfg(target_os = "macos")]
    {
        builder
            .title_bar_style(tauri::TitleBarStyle::Transparent)
            .hidden_title(true)
    }

    #[cfg(target_os = "windows")]
    {
        builder.decorations(false)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        builder
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_pet_window(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
) -> Result<(), AppCommandError> {
    let mut config = crate::commands::pet::pet_get_settings_core(&db.conn).await?;
    let pet_id = config
        .active_pet_id
        .clone()
        .ok_or_else(|| AppCommandError::configuration_missing("No active pet selected."))?;

    // Validate the pet still exists; otherwise fail loudly so the caller
    // can route the user to the picker rather than open an empty window.
    {
        let id = pet_id.clone();
        tokio::task::spawn_blocking(move || crate::pets::get_pet(&id))
            .await
            .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))??;
    }

    if let Some(existing) = app.get_webview_window(PET_WINDOW_LABEL) {
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus pet window", e.to_string()))?;
        return Ok(());
    }

    let scale = config.scale.clamp(0.5, 3.0);
    config.scale = scale;
    config.enabled = true;
    crate::commands::pet::pet_save_window_state_core(
        &db.conn,
        crate::models::pet::PetWindowStatePatch {
            x: None,
            y: None,
            scale: Some(scale),
            always_on_top: None,
            enabled: Some(true),
        },
    )
    .await?;

    let url = WebviewUrl::App(format!("pet?petId={pet_id}").into());
    let mut builder = WebviewWindowBuilder::new(&app, PET_WINDOW_LABEL, url)
        .title("codeg pet")
        .inner_size(PET_BASE_WIDTH * scale, PET_BASE_HEIGHT * scale)
        .min_inner_size(PET_BASE_WIDTH * 0.5, PET_BASE_HEIGHT * 0.5)
        .max_inner_size(PET_BASE_WIDTH * 3.0, PET_BASE_HEIGHT * 3.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(config.always_on_top)
        .skip_taskbar(true)
        .shadow(false)
        // Don't steal focus from the user's IDE/terminal on summon, and let
        // the first click on an inactive pet window hit the webview directly
        // (so drag works without a "click once to activate" cycle).
        .focused(false)
        .accept_first_mouse(true);

    builder = builder.center();

    apply_pet_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open pet window", e.to_string()))?;

    spawn_pet_hover_watcher(app.clone());

    Ok(())
}

/// Polls the global cursor position and emits `pet://hover-enter` whenever
/// the cursor crosses into the pet window's bounds. Native webviews on
/// macOS don't reliably deliver mouse events to non-key windows, so we
/// detect "cursor over the pet" in Rust and let the frontend trigger the
/// waving animation in response. The task ends when the pet window is
/// closed.
fn spawn_pet_hover_watcher(app: AppHandle) {
    use std::time::Duration;
    use tauri::Emitter;

    // Bounds change only on drag or scale; refreshing every N ticks cuts
    // `outer_position`/`outer_size` IPC by ~80% in the steady state. The
    // false hover-enter that cache staleness produces during a drag is
    // suppressed on the JS side via a pointer-down guard (see PetWindow).
    const BOUNDS_REFRESH_TICKS: u8 = 5;

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(80));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Start fresh: prior pet sessions may have left the flag set to
        // true, and we must guarantee an enter event next time the cursor
        // actually crosses the bounds.
        PET_HOVER_WAS_INSIDE.store(false, AtomicOrdering::Relaxed);
        let mut bounds: Option<(f64, f64, f64, f64)> = None;
        let mut ticks_since_refresh: u8 = BOUNDS_REFRESH_TICKS;
        loop {
            interval.tick().await;
            let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) else {
                break;
            };

            if ticks_since_refresh >= BOUNDS_REFRESH_TICKS {
                let Ok(pos) = window.outer_position() else {
                    continue;
                };
                let Ok(size) = window.outer_size() else {
                    continue;
                };
                let x_min = pos.x as f64;
                let y_min = pos.y as f64;
                bounds = Some((
                    x_min,
                    x_min + size.width as f64,
                    y_min,
                    y_min + size.height as f64,
                ));
                ticks_since_refresh = 0;
            } else {
                ticks_since_refresh += 1;
            }

            let Some((x_min, x_max, y_min, y_max)) = bounds else {
                continue;
            };
            let Ok(cursor) = app.cursor_position() else {
                continue;
            };
            let inside =
                cursor.x >= x_min && cursor.x < x_max && cursor.y >= y_min && cursor.y < y_max;
            let was_inside = PET_HOVER_WAS_INSIDE.load(AtomicOrdering::Relaxed);
            if inside && !was_inside {
                let _ = app.emit(PET_HOVER_ENTER_EVENT, ());
            } else if !inside && was_inside {
                let _ = app.emit(PET_HOVER_LEAVE_EVENT, ());
            }
            PET_HOVER_WAS_INSIDE.store(inside, AtomicOrdering::Relaxed);
        }
    });
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn close_pet_window(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
) -> Result<(), AppCommandError> {
    if let Some(existing) = app.get_webview_window(PET_WINDOW_LABEL) {
        let _ = existing.close();
    }
    let _ = crate::commands::pet::pet_save_window_state_core(
        &db.conn,
        crate::models::pet::PetWindowStatePatch {
            x: None,
            y: None,
            scale: None,
            always_on_top: None,
            enabled: Some(false),
        },
    )
    .await?;
    Ok(())
}

/// Persist the pet window's last-known position. Called by the pet renderer
/// when the user finishes dragging.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_window_record_position(
    db: tauri::State<'_, AppDatabase>,
    x: f64,
    y: f64,
) -> Result<(), AppCommandError> {
    crate::commands::pet::pet_save_window_state_core(
        &db.conn,
        crate::models::pet::PetWindowStatePatch {
            x: Some(x),
            y: Some(y),
            scale: None,
            always_on_top: None,
            enabled: None,
        },
    )
    .await?;
    Ok(())
}

// ─── Pet session panel (click-to-open companion window) ─────────────────
//
// A second, focusable window anchored next to the sprite. The sprite window
// itself is transparent / non-focusing / exact-fit and hostile to a scrollable
// interactive list, so the list + inline permission actions live here. Tapping
// the pet toggles it; clicking away (blur) dismisses it.

pub const PET_PANEL_LABEL: &str = "pet-panel";
const PET_PANEL_WIDTH: f64 = 300.0;
/// First-frame window height (logical px). The panel reports its real content
/// height via `resize_pet_panel` right after it mounts, so this is only the
/// open-time size — tuned to the rendered empty-state card (header + "no active
/// sessions" message + padding). Keeping it at the common (empty) height means
/// the common path opens already-correct, with no resize flash.
const PET_PANEL_DEFAULT_HEIGHT: f64 = 132.0;
/// Floor for `resize_pet_panel`'s clamp — never collapse below a usable header.
const PET_PANEL_MIN_HEIGHT: f64 = 80.0;
const PET_PANEL_GAP: f64 = 8.0;

/// Guards the toggle-vs-blur race. When the panel auto-closes on blur because
/// the user clicked the pet, that same click also fires `toggle_pet_panel`;
/// without this guard the toggle would immediately reopen the just-closed
/// panel. The blur handler stamps the close instant here and `toggle_pet_panel`
/// skips the reopen while the stamp is fresh.
static PET_PANEL_BLUR_CLOSED_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);
const PET_PANEL_REOPEN_SUPPRESS_MS: u128 = 300;

/// Close the panel on blur (click-away dismiss) and record the time so a
/// paired pet click doesn't reopen it. Invoked from the global window-event
/// handler in `lib.rs`.
#[cfg(feature = "tauri-runtime")]
pub fn close_pet_panel_on_blur(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(PET_PANEL_LABEL) {
        if let Ok(mut guard) = PET_PANEL_BLUR_CLOSED_AT.lock() {
            *guard = Some(std::time::Instant::now());
        }
        let _ = panel.close();
    }
}

/// True (consuming the stamp) if the panel was blur-closed within the suppress
/// window — i.e. the current toggle is the back half of a click that already
/// dismissed the panel, so it must not reopen.
fn pet_panel_reopen_suppressed() -> bool {
    if let Ok(mut guard) = PET_PANEL_BLUR_CLOSED_AT.lock() {
        if let Some(t) = *guard {
            if t.elapsed().as_millis() < PET_PANEL_REOPEN_SUPPRESS_MS {
                *guard = None;
                return true;
            }
        }
    }
    false
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn toggle_pet_panel(app: AppHandle) -> Result<(), AppCommandError> {
    // Already open → toggle off. (Covers the race where the pet click reaches
    // this command before the panel's blur event has fired.)
    if let Some(existing) = app.get_webview_window(PET_PANEL_LABEL) {
        let _ = existing.close();
        return Ok(());
    }
    // The click that closed it via blur must not reopen it.
    if pet_panel_reopen_suppressed() {
        return Ok(());
    }
    open_pet_panel_window(&app)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn close_pet_panel(app: AppHandle) -> Result<(), AppCommandError> {
    if let Some(existing) = app.get_webview_window(PET_PANEL_LABEL) {
        let _ = existing.close();
    }
    Ok(())
}

/// Compute the panel's top-left origin (logical px) from the pet window's
/// logical rect (`px,py,pw,ph`), the current monitor's logical rect (`mon_*`),
/// and the panel size. Prefers placement above the pet, drops below if that
/// would clip the monitor's top edge, then clamps vertically into the monitor;
/// horizontally aligns the panel's right edge with the pet's, clamped into the
/// monitor. Pure (no Tauri handles) so the initial open and `resize_pet_panel`
/// re-anchor identically — and so it's unit-testable. Re-running it with a
/// larger `panel_h` is what keeps the panel attached as it grows.
#[allow(clippy::too_many_arguments)]
fn compute_pet_panel_origin(
    px: f64,
    py: f64,
    pw: f64,
    ph: f64,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
    panel_w: f64,
    panel_h: f64,
) -> (f64, f64) {
    // Prefer above the pet; drop below if it would clip the top edge, then
    // clamp into the monitor either way.
    let mut panel_y = py - panel_h - PET_PANEL_GAP;
    if panel_y < mon_y {
        panel_y = py + ph + PET_PANEL_GAP;
    }
    let max_y = mon_y + mon_h - panel_h;
    if panel_y > max_y {
        panel_y = max_y.max(mon_y);
    }

    // Align the panel's right edge with the pet's, clamped horizontally.
    let mut panel_x = (px + pw) - panel_w;
    let max_x = mon_x + mon_w - panel_w;
    if panel_x > max_x {
        panel_x = max_x;
    }
    if panel_x < mon_x {
        panel_x = mon_x;
    }

    (panel_x, panel_y)
}

/// Pet + monitor logical rects, the shared input to [`compute_pet_panel_origin`]:
/// `(px, py, pw, ph, mon_x, mon_y, mon_w, mon_h)`.
type PetAnchorGeometry = (f64, f64, f64, f64, f64, f64, f64, f64);

/// Read the pet window's logical rect and its monitor's logical rect — the
/// shared input to [`compute_pet_panel_origin`]. Returns `None` if the pet
/// window isn't open. A missing monitor falls back to a generous default so
/// placement still resolves. All math is in logical pixels for DPI independence.
#[cfg(feature = "tauri-runtime")]
fn read_pet_anchor_geometry(app: &AppHandle) -> Option<PetAnchorGeometry> {
    let pet = app.get_webview_window(PET_WINDOW_LABEL)?;

    let sf = pet.scale_factor().unwrap_or(1.0);
    let (px, py, pw, ph) = match (pet.outer_position(), pet.outer_size()) {
        (Ok(pos), Ok(size)) => (
            pos.x as f64 / sf,
            pos.y as f64 / sf,
            size.width as f64 / sf,
            size.height as f64 / sf,
        ),
        _ => (0.0, 0.0, PET_BASE_WIDTH, PET_BASE_HEIGHT),
    };

    let (mon_x, mon_y, mon_w, mon_h) = pet
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let msf = m.scale_factor();
            let mp = m.position();
            let ms = m.size();
            (
                mp.x as f64 / msf,
                mp.y as f64 / msf,
                ms.width as f64 / msf,
                ms.height as f64 / msf,
            )
        })
        .unwrap_or((px, py - PET_PANEL_DEFAULT_HEIGHT, 1920.0, 1080.0));

    Some((px, py, pw, ph, mon_x, mon_y, mon_w, mon_h))
}

/// Create the panel anchored to the sprite at the default (empty-state) height.
/// The renderer measures its real content and calls `resize_pet_panel` to fit.
#[cfg(feature = "tauri-runtime")]
fn open_pet_panel_window(app: &AppHandle) -> Result<(), AppCommandError> {
    let (px, py, pw, ph, mon_x, mon_y, mon_w, mon_h) = read_pet_anchor_geometry(app)
        .ok_or_else(|| AppCommandError::window("Pet window not open", String::new()))?;

    let (panel_x, panel_y) = compute_pet_panel_origin(
        px,
        py,
        pw,
        ph,
        mon_x,
        mon_y,
        mon_w,
        mon_h,
        PET_PANEL_WIDTH,
        PET_PANEL_DEFAULT_HEIGHT,
    );

    let url = WebviewUrl::App("pet-panel".into());
    let builder = WebviewWindowBuilder::new(app, PET_PANEL_LABEL, url)
        .title("codeg sessions")
        .inner_size(PET_PANEL_WIDTH, PET_PANEL_DEFAULT_HEIGHT)
        .position(panel_x, panel_y)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .visible(false)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .build(),
        )
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .accept_first_mouse(true);

    apply_pet_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open pet panel", e.to_string()))?;

    Ok(())
}

/// Resize the open session panel to fit its measured content height (logical
/// px, reported by the panel renderer after layout) and re-anchor it to the pet
/// so it stays attached as the list grows or shrinks. No-op if the panel isn't
/// open — it can race a blur / Esc close. `height` is clamped to a usable floor
/// and a monitor-derived ceiling (never taller than the screen); the practical
/// upper bound is the panel's own scrollable list, so this clamp is just a
/// safety net for tiny displays.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn resize_pet_panel(app: AppHandle, height: f64) -> Result<(), AppCommandError> {
    let Some(panel) = app.get_webview_window(PET_PANEL_LABEL) else {
        return Ok(());
    };
    let Some((px, py, pw, ph, mon_x, mon_y, mon_w, mon_h)) = read_pet_anchor_geometry(&app) else {
        return Ok(());
    };

    let max_h = (mon_h - PET_PANEL_GAP).max(PET_PANEL_MIN_HEIGHT);
    let panel_h = height.clamp(PET_PANEL_MIN_HEIGHT, max_h);

    let (panel_x, panel_y) = compute_pet_panel_origin(
        px, py, pw, ph, mon_x, mon_y, mon_w, mon_h, PET_PANEL_WIDTH, panel_h,
    );

    // Size before reposition so the re-anchor uses the final height. Errors are
    // non-fatal: the caller fires this and forgets, and a failed resize just
    // leaves the panel at its previous size.
    let _ = panel.set_size(LogicalSize::new(PET_PANEL_WIDTH, panel_h));
    let _ = panel.set_position(LogicalPosition::new(panel_x, panel_y));
    let _ = panel.show();
    let _ = panel.set_focus();
    Ok(())
}

/// Bring the main workspace to the foreground and ask it to focus a specific
/// conversation. Uses an event (not a URL reload) so the in-memory tab/session
/// state survives — `PetFocusBridge` in the main window calls `openTab`.
///
/// Only the pet panel calls this. A `codeg://` OS deep link cannot: the emit
/// reaches only webviews that have *already* registered a JS listener, which
/// on a cold start is none of them — see `deep_link::PENDING_FOCUS` for the
/// handoff that path uses instead.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn focus_conversation(
    app: AppHandle,
    folder_id: i32,
    conversation_id: i32,
    agent: String,
) -> Result<(), AppCommandError> {
    show_main_window(&app);
    let payload = serde_json::json!({
        "folderId": folder_id,
        "conversationId": conversation_id,
        "agent": agent,
    });
    app.emit_to("main", "workspace://focus-conversation", payload)
        .map_err(|e| AppCommandError::window("Failed to signal main window", e.to_string()))?;
    Ok(())
}

// ─── Pet right-click context menu (native) ──────────────────────────────
//
// The pet window is intentionally tiny (a single sprite frame × user scale,
// e.g. 144×156 logical px at 0.75x). An HTML-rendered popup gets clipped to
// those bounds — items don't fit, and the user can't click "outside" because
// there is no outside inside the window. Popping a real OS menu via Tauri's
// `popup_menu_at` sidesteps the clip entirely and gets us native dismiss
// (Escape, click-elsewhere) for free. Item ids carry the action; the global
// `on_menu_event` listener wired up in `lib.rs` dispatches them.

/// Stable id namespace for pet menu items.
pub const PET_MENU_ID_PREFIX: &str = "pet:";
pub const PET_MENU_ID_OPEN_MANAGER: &str = "pet:open_manager";
pub const PET_MENU_ID_CLOSE: &str = "pet:close";
pub const PET_MENU_SCALE_PREFIX: &str = "pet:scale:";
/// Selectable scale steps. Display label is locale-independent (just digits +
/// "×"), so we don't translate it. The id `suffix` survives a round-trip
/// through the OS menu and back into our event dispatcher.
const PET_MENU_SCALE_STEPS: &[(f64, &str, &str)] = &[
    (0.5, "0.5×", "05"),
    (0.75, "0.75×", "075"),
    (1.0, "1×", "1"),
    (1.5, "1.5×", "15"),
    (2.0, "2×", "2"),
];

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetMenuLabels {
    pub scale: String,
    pub open_manager: String,
    pub close: String,
}

/// Map a menu item id back to its scale value. Used by the global menu event
/// dispatcher in `lib.rs` so the suffix→value table lives in one place.
pub fn pet_menu_scale_from_id(id: &str) -> Option<f64> {
    let suffix = id.strip_prefix(PET_MENU_SCALE_PREFIX)?;
    PET_MENU_SCALE_STEPS
        .iter()
        .find_map(|(value, _, s)| if *s == suffix { Some(*value) } else { None })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn pet_show_context_menu(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
    labels: PetMenuLabels,
    x: f64,
    y: f64,
) -> Result<(), AppCommandError> {
    use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem, PredefinedMenuItem};

    let pet_window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| AppCommandError::window("Pet window not open", String::new()))?;

    let config = crate::commands::pet::pet_get_settings_core(&db.conn).await?;
    let current = config.scale;

    let menu_err = |stage: &str, e: tauri::Error| AppCommandError::window(stage, e.to_string());

    // Disabled header acts as a "Scale" section label. macOS renders this as
    // dimmed gray text, Linux/Windows as a non-clickable item — close enough
    // to a section heading without depending on platform-specific section
    // APIs that don't exist in Tauri's cross-platform menu wrapper.
    let header = MenuItem::with_id(
        &app,
        format!("{PET_MENU_ID_PREFIX}header"),
        &labels.scale,
        false,
        None::<&str>,
    )
    .map_err(|e| menu_err("Failed to build pet menu header", e))?;
    let sep1 = PredefinedMenuItem::separator(&app)
        .map_err(|e| menu_err("Failed to build pet menu separator", e))?;
    let sep2 = PredefinedMenuItem::separator(&app)
        .map_err(|e| menu_err("Failed to build pet menu separator", e))?;

    let mut scale_items = Vec::with_capacity(PET_MENU_SCALE_STEPS.len());
    for (value, label, suffix) in PET_MENU_SCALE_STEPS {
        let id = format!("{PET_MENU_SCALE_PREFIX}{suffix}");
        let checked = (current - *value).abs() < 0.01;
        let item = CheckMenuItem::with_id(&app, id, *label, true, checked, None::<&str>)
            .map_err(|e| menu_err("Failed to build pet menu scale item", e))?;
        scale_items.push(item);
    }

    let open_mgr = MenuItem::with_id(
        &app,
        PET_MENU_ID_OPEN_MANAGER,
        &labels.open_manager,
        true,
        None::<&str>,
    )
    .map_err(|e| menu_err("Failed to build pet menu manager item", e))?;
    let close_item = MenuItem::with_id(&app, PET_MENU_ID_CLOSE, &labels.close, true, None::<&str>)
        .map_err(|e| menu_err("Failed to build pet menu close item", e))?;

    let mut builder = MenuBuilder::new(&app).item(&header).item(&sep1);
    for item in &scale_items {
        builder = builder.item(item);
    }
    let menu = builder
        .item(&sep2)
        .item(&open_mgr)
        .item(&close_item)
        .build()
        .map_err(|e| menu_err("Failed to build pet menu", e))?;

    pet_window
        .popup_menu_at(&menu, LogicalPosition::new(x, y))
        .map_err(|e| menu_err("Failed to popup pet menu", e))?;

    // Hover transition state needs a manual reset after the menu
    // dismisses — see `reset_pet_hover_after_native_menu`'s docs.
    reset_pet_hover_after_native_menu();

    Ok(())
}

/// Force the hover watcher to re-emit `enter` next tick if the cursor
/// is still over the pet.
///
/// `popup_menu_at` is modal on macOS / Windows, so this runs strictly
/// after the user has dismissed the menu. The cursor almost certainly
/// never appeared to leave the pet window from the watcher's view —
/// right-click happens *at* the pet, and the OS menu is just an
/// overlay sitting on top, so the polled cursor stays inside the
/// window's bounds the whole time. Without this reset, the watcher's
/// `was_inside == true` flag suppresses the next genuine hover-enter
/// and the wave animation silently stops working until the user moves
/// off-pet and back. Storing `false` makes the very next 80 ms tick
/// re-emit `enter` if the cursor is still over the pet, restoring
/// waving on the spot.
fn reset_pet_hover_after_native_menu() {
    PET_HOVER_WAS_INSIDE.store(false, AtomicOrdering::Relaxed);
}

/// Store the current zoom level and persist it to DB so the next launch
/// creates windows with the correct traffic-light position.
/// Existing windows are NOT repositioned at runtime.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_traffic_light_position(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
    zoom: f64,
) -> Result<(), AppCommandError> {
    let clamped = zoom.clamp(50.0, 300.0) as u32;

    #[cfg(target_os = "macos")]
    CURRENT_ZOOM.store(clamped, AtomicOrdering::Relaxed);

    // Persist to DB so the next launch reads the correct value.
    let _ =
        app_metadata_service::upsert_value(&db.conn, ZOOM_LEVEL_DB_KEY, &clamped.to_string()).await;

    let _ = app;
    Ok(())
}

/// Persist the user's appearance mode ("dark" / "light" / "system") to DB
/// and update the in-memory cache so that subsequent window creations use the
/// correct native background color.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_appearance_mode(
    db: tauri::State<'_, AppDatabase>,
    mode: String,
) -> Result<(), AppCommandError> {
    CACHED_APPEARANCE_MODE.store(mode_from_str(&mode), AtomicOrdering::Relaxed);

    let _ = app_metadata_service::upsert_value(&db.conn, APPEARANCE_MODE_DB_KEY, &mode).await;

    Ok(())
}

// ─── System tray icon ──────────────────────────────────────────────────

/// Monochrome template image for the macOS menu bar. AppKit treats an
/// `NSImage` with `isTemplate = true` as a mask: only the alpha channel
/// matters and the system tints it to match the menu-bar appearance
/// (light, dark, accent). The colored window icon won't get this
/// treatment and looks out of place next to other system icons.
#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
const MACOS_TRAY_TEMPLATE_PNG: &[u8] = include_bytes!("../../icons/tray-icon-template.png");

#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
fn load_macos_tray_template_icon() -> Result<tauri::image::Image<'static>, String> {
    let decoded = image::load_from_memory(MACOS_TRAY_TEMPLATE_PNG)
        .map_err(|e| format!("decode tray template png: {e}"))?
        .to_rgba8();
    let (w, h) = (decoded.width(), decoded.height());
    Ok(tauri::image::Image::new_owned(decoded.into_raw(), w, h))
}

/// Stable id namespace for tray menu items. Routed through the app-wide
/// `on_menu_event` handler in `lib.rs`.
pub const TRAY_MENU_ID_PREFIX: &str = "tray:";
pub const TRAY_MENU_ID_SHOW: &str = "tray:show";
pub const TRAY_MENU_ID_QUIT: &str = "tray:quit";
pub const TRAY_ICON_ID: &str = "codeg-tray";

/// True after `install_tray_icon` returns `Ok`. The hide-on-close path
/// in `lib.rs` consults this so we don't strand the user on systems
/// where the tray failed to install (Windows tray refused, etc.). On
/// Linux this is necessary-but-not-sufficient: the StatusNotifierWatcher
/// may be missing and the icon invisible even when build() returns Ok,
/// which is why `can_hide_to_tray()` reports false on Linux regardless.
#[cfg(feature = "tauri-runtime")]
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// Whether hide-on-close is safe on this platform/session. When false,
/// the close handler in `lib.rs` forces a real app exit instead — both
/// `hide()` and `minimize()` would leave aux windows (pet, settings)
/// running without a recoverable workspace.
#[cfg(feature = "tauri-runtime")]
pub fn can_hide_to_tray() -> bool {
    // Linux: even with a successfully installed tray icon, modern GNOME
    // (45+) defaults ship without a StatusNotifierWatcher and the icon
    // is silently invisible. Refusing here forces the close to pass
    // through to a real exit on Linux — preferable to a phantom process
    // with no UI surface.
    if cfg!(target_os = "linux") {
        return false;
    }
    TRAY_AVAILABLE.load(AtomicOrdering::Relaxed)
}

// ─── macOS native-fullscreen drain on close (issue #507) ───────────────
//
// Native fullscreen on macOS is a separate Space. `orderOut:` (what
// `Window::hide` does) and process exit both leave that Space standing, as
// a black blank with leftover toolbar chrome — so every close action that
// hides or exits leaves fullscreen first and waits for AppKit to tear the
// Space down.
//
// Two tao facts (0.34, macOS) set the shape of that wait. `is_fullscreen()`
// reads `shared_state.fullscreen`, and exactly two things clear it:
//
//   * `restore_state_from_fullscreen`, called from `windowDidExitFullScreen`
//     — the END of the animation. It is the only thing that clears the flag
//     for an exit the *user* started (green button, ⌃⌘F, the View menu), so
//     while their animation runs the flag is still up. Polling it is what
//     covers a close pressed mid-animation, including the mid-transition
//     case where tao parks our `set_fullscreen` in `target_fullscreen` and
//     replays it at `windowDid{Enter,Exit}FullScreen`.
//   * `set_fullscreen` itself, synchronously, BEFORE it dispatches
//     `toggleFullScreen:` to the main queue. So on the path this code
//     drives the flag is already down before the animation starts, and says
//     nothing about the Space.
//
// Nothing in tao's public surface reports `windowDidExitFullScreen` for the
// second case, so what follows the flag drop is a timer. Making it exact
// would take an `NSWindowDidExitFullScreenNotification` observer via objc2.

/// Whether a close action must drain native fullscreen first.
///
/// Other platforms treat fullscreen as a maximized window and hide/close
/// tear it down correctly, so this is a no-op there.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn should_drain_macos_fullscreen_before_close(
    is_macos: bool,
    is_fullscreen: bool,
) -> bool {
    is_macos && is_fullscreen
}

/// How long to give AppKit's Space teardown once tao's fullscreen flag is
/// down.
///
/// On the path this code drives the flag falls before `toggleFullScreen:`
/// has even been dispatched, so this is measured from the start of the
/// animation, not its end: ~0.5s is the system transition, 700ms is that
/// plus slack so hide/exit does not race the last frames (issue #507;
/// tauri-apps/tauri#10580, #12056).
#[cfg(target_os = "macos")]
const MACOS_FULLSCREEN_EXIT_SETTLE: std::time::Duration = std::time::Duration::from_millis(700);

#[cfg(target_os = "macos")]
const MACOS_FULLSCREEN_EXIT_POLL: std::time::Duration = std::time::Duration::from_millis(50);

#[cfg(target_os = "macos")]
const MACOS_FULLSCREEN_EXIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// How long one `is_fullscreen()` sample may take before the drain gives up
/// on it and lets its own deadline decide. Generous next to a main thread
/// that is merely busy, short next to one that is never coming back.
#[cfg(target_os = "macos")]
const MACOS_FULLSCREEN_EXIT_PROBE: std::time::Duration = std::time::Duration::from_millis(250);

/// How long an in-flight drain keeps suppressing later close presses.
///
/// Comfortably past the longest honest drain (poll timeout + settle), and
/// short enough that a stalled one costs a few seconds rather than the rest
/// of the session — same bargain as `CLOSE_PROMPT_GRACE`.
#[cfg(target_os = "macos")]
const MACOS_FULLSCREEN_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// The in-flight drain: which press owns it, and when it started.
///
/// A second press while one is in flight is dropped — the in-flight callback
/// is the press that will be answered. Two details earn their keep:
///
///   * It is a timestamp, not a flag. The drain is bounded (see
///     `wait_for_macos_fullscreen_space_release`), but a starved or panicked
///     drain thread must still not leave the close button dead for good.
///   * It carries a generation, because a stale claim is exactly when a
///     later press takes over — and then the stale thread finishes and
///     releases. Without the generation it would clear its successor's
///     claim, and the press after THAT would act on a window whose Space is
///     still going.
#[cfg(target_os = "macos")]
static MACOS_FULLSCREEN_DRAIN: Mutex<Option<(u64, std::time::Instant)>> = Mutex::new(None);

#[cfg(target_os = "macos")]
static MACOS_FULLSCREEN_DRAIN_SEQ: AtomicU64 = AtomicU64::new(0);

/// `Some(generation)` when this press owns the drain, `None` when another one
/// already does.
#[cfg(target_os = "macos")]
fn claim_macos_fullscreen_drain() -> Option<u64> {
    let now = std::time::Instant::now();
    let took_over;
    let generation;
    {
        let mut drain = MACOS_FULLSCREEN_DRAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        took_over = match *drain {
            Some((_, started)) if now.duration_since(started) < MACOS_FULLSCREEN_DRAIN_GRACE => {
                return None
            }
            Some(_) => true,
            None => false,
        };
        generation = MACOS_FULLSCREEN_DRAIN_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
        *drain = Some((generation, now));
    }
    if took_over {
        tracing::warn!("[close] previous fullscreen drain never finished; taking the press over");
    }
    Some(generation)
}

/// No-op unless `generation` still owns the drain, so a thread whose claim
/// expired cannot clear the claim that replaced it.
#[cfg(target_os = "macos")]
fn release_macos_fullscreen_drain(generation: u64) {
    let mut drain = MACOS_FULLSCREEN_DRAIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if matches!(*drain, Some((owner, _)) if owner == generation) {
        *drain = None;
    }
}

#[cfg(target_os = "macos")]
type MacosDrainAction = Mutex<Option<Box<dyn FnOnce() + Send>>>;

/// Take the close action out of the slot, run it, and only then hand the
/// claim back.
///
/// The claim spans the action, not just the wait: handing it back first
/// leaves a gap in which a second press sees a free drain and acts ahead of
/// the press already being answered. `app.exit(0)` never returns, so the
/// release is best-effort — which is what the grace on the claim is for.
/// Every exit from a drain goes through here, and the `Option` is what makes
/// "at most once" hold when two of those exits are reached.
#[cfg(target_os = "macos")]
fn finish_macos_fullscreen_drain(generation: u64, action: &std::sync::Arc<MacosDrainAction>) {
    let action = action
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(action) = action {
        action();
    }
    release_macos_fullscreen_drain(generation);
}

#[cfg(target_os = "macos")]
fn macos_fullscreen_drain_in_flight() -> bool {
    let now = std::time::Instant::now();
    let drain = *MACOS_FULLSCREEN_DRAIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    drain.is_some_and(|(_, started)| now.duration_since(started) < MACOS_FULLSCREEN_DRAIN_GRACE)
}

/// Run `action` once the main window no longer owns a macOS
/// native-fullscreen Space.
///
/// Off macOS, and on a window that is not fullscreen, `action` runs inline
/// on the calling thread; otherwise it runs on the main thread once the
/// Space is gone. Every close path that hides or exits goes through here.
///
/// Keyed off the `AppHandle` rather than a `Window` because the answers to
/// the close dialog arrive on a command that has no window handle, and
/// `Manager::get_window` is behind tauri's `unstable` feature — the webview
/// window is the flavour every caller can reach.
pub(crate) fn with_macos_fullscreen_drained(
    app: &tauri::AppHandle,
    action: impl FnOnce() + Send + 'static,
) {
    #[cfg(target_os = "macos")]
    {
        // The in-flight check is not redundant with the flag: `set_fullscreen`
        // clears tao's flag before the animation even starts, so a second
        // close press arriving mid-drain reads as windowed while the Space is
        // still going. Hand it to the drain, which drops it as a duplicate of
        // the press already being answered.
        //
        // The sample is the bounded one because the dialog's answer reaches
        // here on a tokio worker, where the plain getter would park a runtime
        // thread on the event loop indefinitely. An unanswered sample drains:
        // being wrong that way costs a delay, being wrong the other way is
        // the bug this whole module exists for.
        if let Some(window) = app.get_webview_window("main") {
            if should_drain_macos_fullscreen_before_close(
                true,
                sample_macos_fullscreen(&window) != Some(false),
            ) || macos_fullscreen_drain_in_flight()
            {
                drain_macos_fullscreen_then(window, action);
                return;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    action();
}

/// Exit native fullscreen and wait until the Space is gone, then run `then`
/// on the main thread.
#[cfg(target_os = "macos")]
fn drain_macos_fullscreen_then(
    window: tauri::WebviewWindow,
    then: impl FnOnce() + Send + 'static,
) {
    let Some(generation) = claim_macos_fullscreen_drain() else {
        return;
    };

    let _ = window.set_fullscreen(false);
    tracing::info!("[close] draining macOS native fullscreen before close behavior");

    // Shared, and taken exactly once, so every way this can go wrong still
    // answers the press: a close the user pressed and that this path then
    // swallowed leaves a window nothing can dismiss, which is worse than
    // acting on a Space that has not quite finished going.
    let action: std::sync::Arc<MacosDrainAction> =
        std::sync::Arc::new(Mutex::new(Some(Box::new(then) as Box<dyn FnOnce() + Send>)));

    let app = window.app_handle().clone();
    let spawned = std::thread::Builder::new()
        .name("macos-fs-close-drain".into())
        .spawn({
            let action = action.clone();
            move || {
                wait_for_macos_fullscreen_space_release(&window);
                let hop = {
                    let action = action.clone();
                    move || finish_macos_fullscreen_drain(generation, &action)
                };
                // `run_on_main_thread` consumes the closure either way, which
                // is why the action lives behind the shared `Option` rather
                // than being moved in: a rejected hop must not eat the press.
                if let Err(err) = app.run_on_main_thread(hop) {
                    tracing::warn!(
                        "[close] failed to hop back to main thread after fullscreen drain: {err}"
                    );
                    finish_macos_fullscreen_drain(generation, &action);
                }
            }
        });

    if let Err(err) = spawned {
        tracing::warn!("[close] failed to spawn fullscreen drain: {err}");
        finish_macos_fullscreen_drain(generation, &action);
    }
}

/// One `is_fullscreen()` sample that cannot outlive `MACOS_FULLSCREEN_EXIT_PROBE`.
///
/// `WebviewWindow::is_fullscreen` off the main thread posts to the event loop
/// and then blocks on a channel with NO timeout, so a stalled or closing loop
/// would hang the drain thread outright — a deadline around the loop cannot
/// bound a call that never returns. Hopping the read onto the main thread
/// (where the runtime answers it inline) and waiting on our own channel with
/// a deadline is what makes the whole drain finite.
///
/// `None` is "no answer this round", never "not fullscreen": the caller's own
/// deadline decides when to stop asking.
#[cfg(target_os = "macos")]
fn sample_macos_fullscreen(window: &tauri::WebviewWindow) -> Option<bool> {
    let (tx, rx) = std::sync::mpsc::channel();
    let probe = {
        let window = window.clone();
        move || {
            let _ = tx.send(window.is_fullscreen().unwrap_or(false));
        }
    };
    window.app_handle().run_on_main_thread(probe).ok()?;
    rx.recv_timeout(MACOS_FULLSCREEN_EXIT_PROBE).ok()
}

#[cfg(target_os = "macos")]
fn wait_for_macos_fullscreen_space_release(window: &tauri::WebviewWindow) {
    let deadline = std::time::Instant::now() + MACOS_FULLSCREEN_EXIT_TIMEOUT;
    while sample_macos_fullscreen(window) != Some(false) {
        if std::time::Instant::now() >= deadline {
            tracing::warn!(
                "[close] timed out waiting for macOS fullscreen to drop; applying close behavior anyway"
            );
            break;
        }
        std::thread::sleep(MACOS_FULLSCREEN_EXIT_POLL);
    }
    // The flag is not the Space — see the module note above. Give AppKit
    // the animation before anything calls `orderOut:` or exits.
    std::thread::sleep(MACOS_FULLSCREEN_EXIT_SETTLE);
}

/// Bring the hidden / minimized main workspace window back to the
/// foreground. Used by:
///   * single-instance plugin (second launch)
///   * tray icon left-click and "Show Workspace" menu item
///   * macOS dock-icon reopen
#[cfg(feature = "tauri-runtime")]
pub fn show_main_window(app: &AppHandle) {
    show_and_focus_window(app, "main");
}

#[cfg(feature = "tauri-runtime")]
struct TrayLabels {
    show_workspace: &'static str,
    quit: &'static str,
}

#[cfg(feature = "tauri-runtime")]
fn tray_labels_for(locale: crate::models::system::AppLocale) -> TrayLabels {
    use crate::models::system::AppLocale;
    match locale {
        AppLocale::ZhCn => TrayLabels {
            show_workspace: "显示工作台",
            quit: "退出 Codeg",
        },
        AppLocale::ZhTw => TrayLabels {
            show_workspace: "顯示工作臺",
            quit: "退出 Codeg",
        },
        AppLocale::Ja => TrayLabels {
            show_workspace: "ワークスペースを表示",
            quit: "Codeg を終了",
        },
        AppLocale::Ko => TrayLabels {
            show_workspace: "워크스페이스 표시",
            quit: "Codeg 종료",
        },
        AppLocale::Es => TrayLabels {
            show_workspace: "Mostrar el área de trabajo",
            quit: "Salir de Codeg",
        },
        AppLocale::De => TrayLabels {
            show_workspace: "Arbeitsbereich anzeigen",
            quit: "Codeg beenden",
        },
        AppLocale::Fr => TrayLabels {
            show_workspace: "Afficher l'espace de travail",
            quit: "Quitter Codeg",
        },
        AppLocale::Pt => TrayLabels {
            show_workspace: "Mostrar área de trabalho",
            quit: "Sair do Codeg",
        },
        AppLocale::Ar => TrayLabels {
            show_workspace: "إظهار مساحة العمل",
            quit: "إنهاء Codeg",
        },
        AppLocale::En => TrayLabels {
            show_workspace: "Show Workspace",
            quit: "Quit Codeg",
        },
    }
}

/// Install the system tray icon and its right-click menu. Left-click
/// (Linux/Windows) and dock-style activation behaviors map to
/// `show_main_window`. Menu wiring lives in the app-wide
/// `on_menu_event` callback in `lib.rs` so the tray and pet menus share
/// one dispatcher.
#[cfg(feature = "tauri-runtime")]
pub fn install_tray_icon(
    app: &AppHandle,
    locale: crate::models::system::AppLocale,
) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let labels = tray_labels_for(locale);
    let show_item = MenuItem::with_id(
        app,
        TRAY_MENU_ID_SHOW,
        labels.show_workspace,
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_ID_QUIT, labels.quit, true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &separator, &quit_item])
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .tooltip("Codeg")
        .menu(&menu)
        // `false` is required for `on_tray_icon_event::Click` to fire on
        // every platform we ship: the default `true` causes the OS to
        // consume left-click to pop the menu (notably on macOS — see
        // tauri-apps/tauri#11413). Right-click still shows the menu
        // because that's the OS's job, not ours.
        .show_menu_on_left_click(false);

    // macOS menu bar expects a monochrome template image that adapts to
    // light/dark mode and the user's accent settings. Other platforms
    // (Windows tray, Linux indicators) want the regular colored icon.
    #[cfg(target_os = "macos")]
    {
        match load_macos_tray_template_icon() {
            Ok(icon) => {
                builder = builder.icon(icon).icon_as_template(true);
            }
            Err(err) => {
                tracing::warn!("[Tray] failed to load template icon, falling back: {err}");
                if let Some(icon) = app.default_window_icon() {
                    builder = builder.icon(icon.clone());
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }

    builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    TRAY_AVAILABLE.store(true, AtomicOrdering::Relaxed);
    Ok(())
}

/// Rebuild the tray menu in the supplied locale and swap it onto the
/// existing tray icon. No-op if the tray hasn't been installed yet
/// (e.g. the language change races setup, or the platform refused the
/// initial install).
#[cfg(feature = "tauri-runtime")]
pub fn refresh_tray_menu(
    app: &AppHandle,
    locale: crate::models::system::AppLocale,
) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};

    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return Ok(());
    };

    let labels = tray_labels_for(locale);
    let show_item = MenuItem::with_id(
        app,
        TRAY_MENU_ID_SHOW,
        labels.show_workspace,
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_ID_QUIT, labels.quit, true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &separator, &quit_item])
        .build()?;

    tray.set_menu(Some(menu))?;
    Ok(())
}

/// Push the current effective UI locale to the system tray. Called by
/// the i18n provider whenever the resolved app locale changes — covers
/// both manual selection and OS-driven changes in system mode.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_tray_locale(
    app: AppHandle,
    locale: crate::models::system::AppLocale,
) -> Result<(), AppCommandError> {
    refresh_tray_menu(&app, locale)
        .map_err(|e| AppCommandError::window("Failed to refresh tray menu", e.to_string()))
}

#[cfg(test)]
mod owner_window_tests {
    use super::{AuxWindowState, SettingsWindowState};

    // `lib.rs` runs the restore on both `CloseRequested` and `Destroyed`, so the
    // owner has to be handed back exactly once. That mattered less while the
    // restore was a bare `set_focus`; now that it also unhides the owner, a
    // second pass would fight a user who re-hid the workspace in between.
    #[test]
    fn settings_owner_is_handed_back_once() {
        let state = SettingsWindowState::new();
        state.set_owner("settings".to_string(), "main".to_string());

        assert_eq!(state.take_owner("settings").as_deref(), Some("main"));
        assert_eq!(state.take_owner("settings"), None);
    }

    // Re-opening settings from a different window re-points the owner, so the
    // restore brings back the window the user actually came from.
    #[test]
    fn reopening_settings_repoints_the_owner() {
        let state = SettingsWindowState::new();
        state.set_owner("settings".to_string(), "main".to_string());
        state.set_owner("settings".to_string(), "remote-workspace-3".to_string());

        assert_eq!(state.take_owner("settings").as_deref(), Some("remote-workspace-3"));
    }

    // Same hand-back-once contract for the shared map, which stash, push,
    // project boot and the importer all write into.
    #[test]
    fn aux_owner_is_handed_back_once() {
        let state = AuxWindowState::new();
        state.set_owner("stash-7".to_string(), "main".to_string());

        assert_eq!(state.take_owner("stash-7").as_deref(), Some("main"));
        assert_eq!(state.take_owner("stash-7"), None);
    }

    // The four window kinds share one map, so their labels must not collide:
    // closing the stash window has to leave the push window's owner alone.
    #[test]
    fn aux_owners_are_kept_per_window_label() {
        let state = AuxWindowState::new();
        state.set_owner("stash-7".to_string(), "main".to_string());
        state.set_owner("push-7".to_string(), "remote-workspace-3".to_string());
        state.set_owner("project-boot".to_string(), "main".to_string());
        state.set_owner("import-sessions".to_string(), "main".to_string());

        assert_eq!(state.take_owner("stash-7").as_deref(), Some("main"));
        assert_eq!(state.take_owner("push-7").as_deref(), Some("remote-workspace-3"));
        assert_eq!(state.take_owner("project-boot").as_deref(), Some("main"));
        assert_eq!(state.take_owner("import-sessions").as_deref(), Some("main"));
    }

    // `lib.rs` runs the aux restore for EVERY closing window, so a label that
    // never registered an owner (main, pet, settings, a commit window) must
    // come back empty rather than pull some other window forward.
    #[test]
    fn aux_restore_is_inert_for_unregistered_labels() {
        let state = AuxWindowState::new();
        state.set_owner("stash-7".to_string(), "main".to_string());

        for label in ["main", "pet", "settings", "commit-7", "merge-7"] {
            assert_eq!(state.take_owner(label), None, "{label} owns nothing");
        }
        assert_eq!(state.take_owner("stash-7").as_deref(), Some("main"));
    }

    // Re-opening from another window re-points the owner here too. The stash
    // window is reused across workspaces, so the restore has to follow the
    // window the user last came from.
    #[test]
    fn reopening_an_aux_window_repoints_the_owner() {
        let state = AuxWindowState::new();
        state.set_owner("stash-7".to_string(), "main".to_string());
        state.set_owner("stash-7".to_string(), "remote-workspace-3".to_string());

        assert_eq!(state.take_owner("stash-7").as_deref(), Some("remote-workspace-3"));
    }
}

#[cfg(test)]
mod pet_panel_geometry_tests {
    use super::{compute_pet_panel_origin, PET_PANEL_GAP, PET_PANEL_WIDTH};

    // A roomy 1920×1080 monitor at the origin, with the pet near the bottom-right
    // (the common resting spot). Sprite ≈ 144×156 logical px (0.75× of 192×208).
    const MON: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);
    const PET_W: f64 = 144.0;
    const PET_H: f64 = 156.0;

    fn origin(pet_x: f64, pet_y: f64, panel_h: f64) -> (f64, f64) {
        compute_pet_panel_origin(
            pet_x,
            pet_y,
            PET_W,
            PET_H,
            MON.0,
            MON.1,
            MON.2,
            MON.3,
            PET_PANEL_WIDTH,
            panel_h,
        )
    }

    #[test]
    fn places_above_and_aligns_right_edge() {
        // Pet low on screen: the panel sits above it, gap included.
        let (x, y) = origin(1000.0, 900.0, 380.0);
        assert_eq!(y, 900.0 - 380.0 - PET_PANEL_GAP, "panel bottom hugs pet top");
        // Right edges align: panel_x = pet_right - panel_w.
        assert_eq!(x, (1000.0 + PET_W) - PET_PANEL_WIDTH);
    }

    #[test]
    fn drops_below_when_above_would_clip_top() {
        // Pet near the top: above placement is off-screen, so drop below the pet.
        let (_x, y) = origin(500.0, 20.0, 380.0);
        assert_eq!(y, 20.0 + PET_H + PET_PANEL_GAP, "panel drops below the pet");
    }

    #[test]
    fn taller_panel_anchored_above_grows_upward() {
        // With an above-anchor, a taller panel's top moves further up while its
        // bottom stays pinned near the pet — i.e. it grows upward.
        let (_x, short) = origin(1000.0, 900.0, 200.0);
        let (_x2, tall) = origin(1000.0, 900.0, 380.0);
        assert!(tall < short, "taller panel has a higher (smaller-y) top");
    }

    #[test]
    fn clamps_right_edge_into_monitor() {
        // Pet at the far right: aligning right edges would push the panel off the
        // monitor, so it clamps to the right work-area edge.
        let (x, _y) = origin(1850.0, 900.0, 380.0);
        assert_eq!(x, MON.2 - PET_PANEL_WIDTH, "clamped to right edge");
    }

    #[test]
    fn clamps_left_edge_into_monitor() {
        // Pet at the far left: right-edge alignment would yield a negative x, so
        // it clamps to the left work-area edge.
        let (x, _y) = origin(0.0, 900.0, 380.0);
        assert_eq!(x, MON.0, "clamped to left edge");
    }

    #[test]
    fn clamps_bottom_on_short_monitor() {
        // Short monitor where neither above nor below fully fits: vertical clamp
        // pins the panel into the monitor (and never above its top edge).
        let short_mon = (0.0, 0.0, 1920.0, 300.0);
        let (_x, y) = compute_pet_panel_origin(
            500.0,
            20.0,
            PET_W,
            PET_H,
            short_mon.0,
            short_mon.1,
            short_mon.2,
            short_mon.3,
            PET_PANEL_WIDTH,
            380.0,
        );
        assert_eq!(y, short_mon.1, "clamped to the monitor top, not above it");
    }
}

#[cfg(test)]
mod settings_route_tests {
    use super::resolve_settings_route;

    /// Every section the frontend's `SettingsSection` union can send must map
    /// to a real route. `general` is the one that looks redundant and is not:
    /// the fallback below it is Appearance, so a caller wanting the General
    /// page must be able to name it and land there. `collaboration` is where
    /// the codeg-mcp tool switches live in full, and it is what the status-bar
    /// popover links to.
    #[test]
    fn every_named_settings_section_resolves_to_its_own_route() {
        for section in [
            "general",
            "appearance",
            "agents",
            "mcp",
            "skills",
            "experts",
            "science",
            "office-tools",
            "collaboration",
            "browser",
            "version-control",
            "shortcuts",
            "system",
        ] {
            assert_eq!(
                resolve_settings_route(Some(section)),
                format!("settings/{section}"),
                "section {section} must route to its own page"
            );
        }
        // An unnamed section keeps its long-standing desktop landing spot.
        assert_eq!(resolve_settings_route(None), "settings/appearance");
    }
}

#[cfg(test)]
mod macos_fullscreen_close_tests {
    use super::should_drain_macos_fullscreen_before_close;

    /// Linux (and Windows) fullscreen is not a separate Space. Close must
    /// not wait on it, or a maximized window would take the settle delay on
    /// every hide/exit for nothing.
    #[test]
    fn non_macos_never_drains_fullscreen() {
        assert!(!should_drain_macos_fullscreen_before_close(false, true));
        assert!(!should_drain_macos_fullscreen_before_close(false, false));
    }

    /// The flag is up for the whole of a user-driven exit animation (tao
    /// only clears it in `windowDidExitFullScreen`), so it is also what
    /// covers a close pressed mid-animation. Windowed must not drain: that
    /// would put the settle delay on every ordinary close.
    #[test]
    fn macos_drains_exactly_while_the_fullscreen_flag_is_up() {
        assert!(should_drain_macos_fullscreen_before_close(true, true));
        assert!(!should_drain_macos_fullscreen_before_close(true, false));
    }

    /// The drain is claimed once and answered once: a second press while one
    /// is in flight is dropped rather than queueing a second hide. And while
    /// it is in flight it stays observable, because tao's fullscreen flag is
    /// already down by then and would otherwise read as "nothing to wait for".
    #[cfg(target_os = "macos")]
    #[test]
    fn a_drain_claim_is_exclusive_and_observable_until_released() {
        use super::{
            claim_macos_fullscreen_drain, macos_fullscreen_drain_in_flight,
            release_macos_fullscreen_drain, MACOS_FULLSCREEN_DRAIN,
        };

        *MACOS_FULLSCREEN_DRAIN.lock().unwrap() = None;
        assert!(!macos_fullscreen_drain_in_flight());

        let first = claim_macos_fullscreen_drain().expect("first press claims the drain");
        assert!(
            macos_fullscreen_drain_in_flight(),
            "a second press must be able to see the drain it should defer to"
        );
        assert!(
            claim_macos_fullscreen_drain().is_none(),
            "a press arriving mid-drain must not start a second one"
        );

        release_macos_fullscreen_drain(first);
        assert!(!macos_fullscreen_drain_in_flight());
        let second =
            claim_macos_fullscreen_drain().expect("the next press is answerable once done");
        assert_ne!(first, second);

        // The wedge case the generation exists for: the thread that lost its
        // claim to a takeover must not clear the claim that replaced it.
        release_macos_fullscreen_drain(first);
        assert!(
            macos_fullscreen_drain_in_flight(),
            "a stale release must leave the incumbent drain owning the press"
        );

        release_macos_fullscreen_drain(second);
        assert!(!macos_fullscreen_drain_in_flight());
    }
}
