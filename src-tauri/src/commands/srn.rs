//! The desktop's SRN account (`srn_*`): what the status bar's SRN entry
//! calls. Desktop only, and Tauri only: the account belongs to this app, so
//! neither codeg-server nor the embedded web service has a route for any of
//! these, and a remote workspace window reaches them through the shell
//! transport — never the remote Codeg. The interface reference is
//! `/tmp/codeg-briefs/b1-api.md`.
//!
//! No command returns the token. Every failure is an `SrnAccount.errors.*`
//! key with a stable `code` param (`srn/error.rs`).

use tauri::AppHandle;

use crate::app_error::AppCommandError;
use crate::models::system::AppLocale;
use crate::srn::desktop;
use crate::srn::types::{CheckTrigger, SrnAccountState, SrnSignOutResult};

/// The account as it is (`loading` until the keychain has been read). Never
/// fails and never waits.
#[tauri::command]
pub async fn srn_account(app: AppHandle) -> Result<SrnAccountState, AppCommandError> {
    Ok(desktop::service(&app).state())
}

/// Starts a sign-in and opens the authorization page in the system browser.
/// `locale` is the interface's (`getCurrentEffectiveAppLocale()`): it picks
/// the page's language and that of the page the browser comes back to.
#[tauri::command]
pub async fn srn_sign_in(
    app: AppHandle,
    locale: Option<AppLocale>,
) -> Result<SrnAccountState, AppCommandError> {
    let language = desktop::page_language(&app, locale).await;
    Ok(desktop::service(&app).sign_in(language).await?)
}

/// Opens the pending sign-in's page again.
#[tauri::command]
pub async fn srn_reopen_sign_in(app: AppHandle) -> Result<SrnAccountState, AppCommandError> {
    Ok(desktop::service(&app).reopen()?)
}

/// Ends the pending sign-in, if any.
#[tauri::command]
pub async fn srn_cancel_sign_in(app: AppHandle) -> Result<SrnAccountState, AppCommandError> {
    Ok(desktop::service(&app).cancel())
}

/// Checks the account with SpaceRing, if `trigger` makes a check due
/// (`foreground` when omitted; `user` for the person's "check again").
#[tauri::command]
pub async fn srn_check_online(
    app: AppHandle,
    trigger: Option<CheckTrigger>,
) -> Result<SrnAccountState, AppCommandError> {
    Ok(desktop::service(&app)
        .check(trigger.unwrap_or_default())
        .await?)
}

/// Signs out: the keychain first, then SpaceRing. `expectedSrn` is the
/// account the popover showed; `locale` picks the website's page for a
/// connection SpaceRing did not confirm ending.
#[tauri::command]
pub async fn srn_sign_out(
    app: AppHandle,
    expected_srn: Option<u64>,
    locale: Option<AppLocale>,
) -> Result<SrnSignOutResult, AppCommandError> {
    let language = desktop::page_language(&app, locale).await;
    Ok(desktop::service(&app)
        .sign_out(expected_srn, language)
        .await?)
}

/// Which SpaceRing console page [`srn_open_manage_connections`] opens.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SrnConsolePage {
    /// The list of connections ("Manage connections"), where one can be
    /// removed by hand.
    #[default]
    Connections,
    /// The console's front page ("Open SRN console").
    Console,
}

/// Opens a page of the website's console in the system browser: the list of
/// connections, unless `page` asks for the console's front page. An older
/// frontend sends no `page` and gets the connections, as before.
#[tauri::command]
pub async fn srn_open_manage_connections(
    app: AppHandle,
    locale: Option<AppLocale>,
    page: Option<SrnConsolePage>,
) -> Result<(), AppCommandError> {
    let language = desktop::page_language(&app, locale).await;
    let service = desktop::service(&app);
    let url = match page.unwrap_or_default() {
        SrnConsolePage::Connections => service.manage_connections_url(language),
        SrnConsolePage::Console => service.console_url(language),
    };
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| crate::srn::error::Problem::OpenBrowser.into())
}

#[cfg(test)]
mod tests {
    use super::SrnConsolePage;

    #[test]
    fn the_console_page_reads_as_the_frontend_writes_it() {
        let read = |raw: &str| serde_json::from_str::<SrnConsolePage>(raw);
        assert!(matches!(read("\"console\""), Ok(SrnConsolePage::Console)));
        assert!(matches!(
            read("\"connections\""),
            Ok(SrnConsolePage::Connections)
        ));
        assert!(read("\"elsewhere\"").is_err());
    }
}
