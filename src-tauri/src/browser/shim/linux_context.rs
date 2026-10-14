//! One native WebKit context per browser profile, shared by child and owned
//! surfaces. A non-navigating related view lets both builders use that context.

use std::cell::RefCell;
use std::collections::HashMap;

use webkit2gtk::{
    CookieManagerExt, CookiePersistentStorage, NetworkProxyMode, NetworkProxySettings, WebContext,
    WebView, WebViewExt, WebsiteDataManager, WebsiteDataManagerExt,
};

use crate::browser::profile;

thread_local! {
    static PROFILES: RefCell<HashMap<String, WebView>> = RefCell::new(HashMap::new());
}

/// Main thread only. The anchor never loads a page; it owns the profile's
/// native context even when every visible tab has closed.
pub fn related_view(profile_id: &str) -> Result<WebView, String> {
    let anchor = PROFILES.with(|profiles| {
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
                WebView::with_context(&context)
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
    let manager = anchor
        .website_data_manager()
        .ok_or("browser profile has no data manager")?;
    if let Some(proxy) = proxy {
        let mut settings = NetworkProxySettings::new(Some(&proxy.to_url_string()), &[]);
        manager.set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut settings));
    } else {
        manager.set_network_proxy_settings(NetworkProxyMode::Default, None);
    }
    Ok(anchor)
}

/// Release the native store after the profile's tabs have been closed.
pub fn forget(profile_id: &str) {
    PROFILES.with(|profiles| profiles.borrow_mut().remove(profile_id));
}
