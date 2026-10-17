//! One native WebKit context per browser profile, shared by child and owned
//! surfaces. Neither builder takes a context it did not make — wry keeps its
//! own to itself, and tauri keys its contexts by data directory — but both
//! take a view to relate the new one to, and a related view is built in that
//! view's context.
//!
//! The view handed out is a new one for every surface, never loaded, and let
//! go of once that surface is built. Relating also gives the new page the
//! related page's web process, and WebKit keeps a page's first navigation
//! wherever it is when the page it comes from has shown nothing yet: one view
//! kept for the profile would put the first page of every tab, whatever its
//! site, in a single shared process. A fresh view has a process of its own to
//! lend.

use std::cell::RefCell;
use std::collections::HashMap;

use webkit2gtk::{
    CookieManagerExt, CookiePersistentStorage, NetworkProxyMode, NetworkProxySettings, WebContext,
    WebContextExt, WebView, WebsiteDataManager, WebsiteDataManagerExt,
};

use crate::browser::profile;

thread_local! {
    /// Each profile's context, held for as long as the profile exists, open
    /// tabs or not. Main thread only.
    static PROFILES: RefCell<HashMap<String, WebContext>> = RefCell::new(HashMap::new());
}

/// Main thread only. A view in the profile's context to build ONE new surface
/// from (see the module header). It never loads a page; the caller drops it
/// once that surface is built.
pub fn related_view(profile_id: &str) -> Result<WebView, String> {
    let context = PROFILES.with(|profiles| {
        profiles
            .borrow_mut()
            .entry(profile_id.to_string())
            .or_insert_with(|| {
                // Keep the on-disk layout used by wry's previous profile contexts.
                let directory = profile::directory(profile_id);
                let manager = WebsiteDataManager::builder()
                    .base_data_directory(directory.to_string_lossy())
                    .base_cache_directory(directory.to_string_lossy())
                    .build();
                if let Some(cookies) = manager.cookie_manager() {
                    // Wry stores this file as Netscape text; keep existing logins readable.
                    cookies.set_persistent_storage(
                        &directory.join("cookies").to_string_lossy(),
                        CookiePersistentStorage::Text,
                    );
                }
                let context = WebContext::builder().website_data_manager(&manager).build();
                super::linux::install_download_context(&context);
                context
            })
            .clone()
    });
    let proxy = match profile::proxy_for(profile_id) {
        Ok(proxy) => proxy,
        Err(error) if profile::is_remote_profile(profile_id) => return Err(error),
        Err(error) => {
            tracing::warn!("[browser] ignoring the configured proxy: {error}");
            None
        }
    };
    let manager = context
        .website_data_manager()
        .ok_or("browser profile has no data manager")?;
    if let Some(proxy) = proxy {
        let mut settings = NetworkProxySettings::new(Some(&proxy.to_url_string()), &[]);
        manager.set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut settings));
    } else {
        manager.set_network_proxy_settings(NetworkProxyMode::Default, None);
    }
    Ok(WebView::with_context(&context))
}

/// Release the native store after the profile's tabs have been closed.
pub fn forget(profile_id: &str) {
    PROFILES.with(|profiles| profiles.borrow_mut().remove(profile_id));
}
