//! Platform-specific WebKit / WebView2 calls that neither tauri nor wry
//! expose: isolated-world scripts and message handlers, world-scoped
//! evaluation, snapshots, back / forward. Every function here runs on the
//! main thread against the live platform webview and is only ever reached
//! through `surface_child::ChildHandle` (or, later, `with_webview` for owned
//! windows).

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(all(target_os = "windows", feature = "browser-child"))]
pub mod windows;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod navigation {
    //! What the engines report about a navigation and wry does not: where a
    //! page-initiated load is heading, that it was redirected, that it ended
    //! without being the page's fault, and how it failed. One shape for every
    //! platform, so `surface_child` handles them in one place.

    use std::sync::Arc;

    use super::super::hooks::LoadFailure;

    /// Events a platform's navigation hooks report, on the main thread.
    pub enum NavigationEvent {
        /// A main-frame navigation started; the URL it is heading for.
        Started(String),
        /// The provisional navigation was redirected by the server; the URL it
        /// is heading for now.
        Redirected(String),
        /// The provisional navigation was ended by policy — the host refused
        /// the address it was redirected to, or the response became a download
        /// — so no page is coming for it, and that is not a failure of the
        /// page.
        Interrupted,
        Failed(LoadFailure),
    }

    pub type NavigationSink = Arc<dyn Fn(NavigationEvent) + Send + Sync>;

    /// Where "the page asked for this window to be closed" goes — every engine
    /// reports `window.close()` in its own way, and what wry does with it is
    /// never to pass it on: macOS does not subscribe at all, Windows and Linux
    /// destroy the surface in place and leave the tab behind. One
    /// argument-less call, because the only thing to say is that it happened;
    /// whether the tab may act on it is the host's decision
    /// (`hooks::page_may_close_itself`).
    pub type PageCloseSink = Arc<dyn Fn() + Send + Sync>;
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub use navigation::{NavigationEvent, NavigationSink, PageCloseSink};
