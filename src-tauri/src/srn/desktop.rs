//! The desktop account in the running app: the one [`AccountService`], and
//! what it does through Tauri — the event to every desktop window, the system
//! browser, the main window brought forward.

use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

use super::account::{AccountService, Config, Host, SystemClock};
use super::client::SrnApi;
use super::environment::Environment;
use super::page::PageLanguage;
use super::store::Keychain;
use super::types::{CheckTrigger, SrnAccountChanged, ACCOUNT_CHANGED_EVENT};
use crate::models::system::AppLocale;

static SERVICE: OnceLock<Arc<AccountService>> = OnceLock::new();

/// The app's account. Made on first use — from a command, the startup task
/// or a window's focus, whichever comes first — with this build's
/// environment and the OS keychain.
pub(crate) fn service(app: &AppHandle) -> Arc<AccountService> {
    SERVICE
        .get_or_init(|| {
            let env = Environment::current();
            let api = SrnApi::new(env.origin.clone());
            AccountService::new(
                env,
                api,
                Arc::new(Keychain),
                Arc::new(Desktop(app.clone())),
                Arc::new(SystemClock),
                Config::default(),
            )
        })
        .clone()
}

/// At startup: reads the keychain, then checks online. In the background.
pub(crate) fn start(app: &AppHandle) {
    if !super::privacy::enabled() {
        return;
    }
    let account = service(app);
    tauri::async_runtime::spawn(async move { account.startup().await });
}

/// A window came to the front — the app returning to the foreground among
/// the ways that happens: the online check, if one is due.
pub(crate) fn window_focused(app: &AppHandle) {
    if !super::privacy::enabled() {
        return;
    }
    let account = service(app);
    tauri::async_runtime::spawn(async move {
        let _ = account.check(CheckTrigger::Foreground).await;
    });
}

/// Invalidate pending browser flows and update every desktop window immediately.
pub(crate) fn privacy_changed(app: &AppHandle, settings: super::privacy::OnlineSettings) {
    if settings.enabled {
        start(app);
    } else if let Some(account) = SERVICE.get() {
        account.cancel();
    }
    let state = SrnAccountChanged {
        status: if settings.enabled {
            "loading"
        } else {
            "disabled"
        },
        account: None,
    };
    Desktop(app.clone()).announce(&state);
    let _ = app.emit("srn://online-settings-changed", settings);
    crate::harness::updates::records_changed();
}

/// The interface language a command named, or else the saved one.
pub(crate) async fn page_language(app: &AppHandle, locale: Option<AppLocale>) -> PageLanguage {
    if let Some(locale) = locale {
        return PageLanguage::of(locale);
    }
    let Some(conn) = app
        .try_state::<crate::db::AppDatabase>()
        .map(|db| db.conn.clone())
    else {
        return PageLanguage::English;
    };
    crate::commands::system_settings::load_system_language_settings(&conn)
        .await
        .map(|settings| PageLanguage::of(settings.language))
        .unwrap_or(PageLanguage::English)
}

struct Desktop(AppHandle);

impl Host for Desktop {
    fn announce(&self, event: &SrnAccountChanged) {
        // Every desktop window — and nothing else. Not `emit_event`, which
        // also feeds the embedded web service's clients: a browser on Codeg
        // Web has an SRN session of its own, and this account is not its
        // business.
        let disabled = SrnAccountChanged {
            status: "disabled",
            account: None,
        };
        let event = if super::privacy::enabled() {
            event
        } else {
            &disabled
        };
        if let Err(error) = self.0.emit(ACCOUNT_CHANGED_EVENT, event) {
            tracing::warn!("[srn] the account event was not sent: {error}");
        }
    }

    fn open_url(&self, url: &str) -> Result<(), ()> {
        use tauri_plugin_opener::OpenerExt;
        // The opener's error can quote the address; it is not kept.
        if !super::privacy::enabled() {
            return Err(());
        }
        self.0.opener().open_url(url, None::<&str>).map_err(|_| ())
    }

    fn bring_to_front(&self) {
        // As a deep link does (`deep_link::handle_raw_urls`).
        crate::commands::windows::show_main_window(&self.0);
    }
}
