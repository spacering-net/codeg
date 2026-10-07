//! Callbacks the surfaces install on their webviews. They only touch the
//! registry and emit state; nothing here calls back into the surface, so the
//! webview thread never waits on itself.

use std::time::Duration;

use tauri::{AppHandle, Manager, Url};

use super::agent;
use super::blank_page;
use super::events;
use super::registry::BrowserRegistry;
use super::types::{
    BrowserErrorInfo, BrowserErrorKind, BrowserTabState, NavigationBlockReason, TabKind,
};

/// Where a platform delegate's navigation events go: the hooks below, for one
/// tab. Every surface that has a shim builds its sink here, so the four events
/// mean the same thing whichever engine reported them.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn navigation_sink(app: &AppHandle, tab_id: &str) -> super::shim::NavigationSink {
    use super::shim::NavigationEvent;

    let app = app.clone();
    let tab_id = tab_id.to_string();
    std::sync::Arc::new(move |event| match event {
        NavigationEvent::Started(url) => {
            if let Ok(url) = Url::parse(&url) {
                navigation_started(&app, &tab_id, &url);
            }
        }
        NavigationEvent::Redirected(url) => {
            if let Ok(url) = Url::parse(&url) {
                navigation_redirected(&app, &tab_id, &url);
            }
        }
        NavigationEvent::Interrupted => navigation_interrupted(&app, &tab_id),
        NavigationEvent::Failed(failure) => navigation_failed(&app, &tab_id, failure),
    })
}

/// Where a platform's "the page asked for this window to be closed" callback
/// goes: [`page_requested_close`] for one tab. Built by every surface that has
/// a shim, so `window.close()` means the same thing on each engine.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn page_close_sink(app: &AppHandle, tab_id: &str) -> super::shim::PageCloseSink {
    let app = app.clone();
    let tab_id = tab_id.to_string();
    std::sync::Arc::new(move || page_requested_close(&app, &tab_id))
}

/// Whether a tab may close itself on the page's say-so: an adopted popup, and
/// nothing else.
///
/// The engines already apply the browser rule — only a window a script opened
/// may be closed by script — but each in its own words, and a document guest
/// is not a window the person can get back. `opener_tab_id` is the host's own
/// record of the one case that qualifies: a webview built for a page-initiated
/// `window.open` (see `surface_child::new_window_handler`).
///
/// Saying no here does not put a surface back: on Windows and Linux wry has
/// already destroyed it by the time this is asked (see the shims), so a
/// refused tab keeps its place in the strip with a dead view. That is what
/// those two engines have always done; it is not this gate's to undo.
pub fn page_may_close_itself(state: &BrowserTabState) -> bool {
    state.kind == TabKind::Page && state.opener_tab_id.is_some()
}

/// The page called `window.close()`. For a popup this is the last step of a
/// sign-in flow: the site opened a window, the provider wrote its receipt into
/// it, and the page it left behind closes itself. No TAB went with it before
/// this: macOS never heard the request (wry implements no `webViewDidClose:`),
/// and the two engines wry does hear it on answer by destroying the surface
/// and telling nobody. Either way the empty "Sign In" tab stayed open until
/// the person noticed it.
///
/// The close runs off the engine's callback — it drops the very webview whose
/// delegate is calling, which must not happen while the engine is inside it,
/// and `close_core` reaches the main thread and waits, which from the main
/// thread is a deadlock. So the decision is taken again inside the task, and
/// carries the incarnation it was taken about all the way to the removal: an
/// id on its own names whatever is under it at the moment it is used, which
/// need not be the tab whose page asked.
pub fn page_requested_close(app: &AppHandle, tab_id: &str) {
    let app = app.clone();
    let tab_id = tab_id.to_string();
    tauri::async_runtime::spawn(async move {
        let Some(registry) = app.try_state::<BrowserRegistry>() else {
            return;
        };
        // The incarnation, not just the id: an id names whatever is under it
        // at the moment it is used, and by the time this runs the tab that
        // asked may be gone and another one — another popup, with an opener
        // of its own — under its name. `generation` is never reused, so
        // carrying it to the removal is what makes the tab that asked and the
        // tab that goes the same tab.
        let Some((generation, state)) =
            registry.read(&tab_id, |tab| (tab.generation, tab.state.clone()))
        else {
            return;
        };
        if !page_may_close_itself(&state) {
            tracing::debug!(
                "[browser] tab {tab_id}: window.close() ignored (not a page's own window)"
            );
            return;
        }
        tracing::info!("[browser] tab {tab_id}: closed by the page");
        let close = crate::commands::browser::close_core_if(&app, &registry, &tab_id, None, |tab| {
            tab.generation == generation
        });
        if let Err(err) = close {
            tracing::warn!("[browser] tab {tab_id}: close requested by the page failed: {err}");
        }
    });
}

pub fn origin_of(url: &Url) -> Option<String> {
    let origin = url.origin();
    if origin.is_tuple() {
        Some(origin.ascii_serialization())
    } else {
        None
    }
}

/// A commit of `about:blank` while the navigation the engine had started was
/// for somewhere else. WebKit refuses some loads without ever reporting a
/// failure — a request to a restricted port (1, 7, 25, … the list every
/// browser keeps) is answered by committing an empty document in place of
/// the page — and this is the only trace it leaves. A page that navigates
/// itself to `about:blank` announces that URL as its provisional start first,
/// so it is not mistaken for one.
pub fn blank_substituted_for(provisional: Option<&str>, committed: &Url) -> bool {
    committed.as_str() == "about:blank"
        && provisional.is_some_and(|started| started != "about:blank")
}

pub fn page_load(app: &AppHandle, tab_id: &str, url: &Url, started: bool) {
    tracing::debug!("[browser] tab {tab_id} page load {}: {url}", if started { "started" } else { "finished" });
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    // History flags are only trustworthy once the navigation committed; the
    // surface call runs inline here (main thread) and never takes the
    // registry lock itself.
    let history = if started {
        None
    } else {
        registry
            .surface(tab_id)
            .map(|surface| {
                (
                    surface.can_go_back().unwrap_or(false),
                    surface.can_go_forward().unwrap_or(false),
                )
            })
    };
    let state = registry.update(tab_id, |tab| {
        let failed_address = (started && blank_substituted_for(tab.provisional_url.as_deref(), url))
            .then(|| tab.provisional_url.clone())
            .flatten();
        let substituted = failed_address.is_some();
        if started {
            tab.provisional_url = None;
            // A document has been put in place of the old one, so every ref
            // an agent holds names an element of a page that is gone. The
            // world draws a new generation of its own for exactly this, but
            // the host counts too: `nav_epoch` is also what distinguishes two
            // route changes inside one document, where the world cannot tell.
            tab.nav_epoch += 1;
            // The console is the document's: what the old one printed is
            // not a fact about the page that is on screen now, and a read of
            // this tab from here on is a read of the new one.
            tab.console.clear();
            // The picker went with the world the old document had. Nobody is
            // going to answer the pick, so end it here rather than leaving a
            // person watching a highlight that is not there any more.
            tab.pending_pick = None;
        }
        let state = &mut tab.state;
        state.url = url.to_string();
        state.origin = origin_of(url);
        if let Some(address) = failed_address {
            // The engine gave up on the page and put nothing in its place:
            // that is a failed load of the address that was asked for, and
            // the empty document that committed is not worth a spinner.
            state.loading = false;
            state.error = Some(BrowserErrorInfo {
                kind: BrowserErrorKind::Failed,
                message: String::new(),
                url: Some(address),
            });
        } else {
            state.loading = started;
            if started {
                state.error = None;
                // The previous document's title must not label the new one;
                // the toolbar falls back to the host until `title_changed`
                // fires.
                state.title.clear();
            }
        }
        if let Some((back, forward)) = history {
            state.can_go_back = back;
            state.can_go_forward = forward;
        }
        // After the origin is written, never before: the question is whether
        // the grant covers the page that is on screen now.
        let lost = agent::revoke_if_departed(state);
        (state.clone(), substituted, lost)
    });
    let Some((state, substituted, lost)) = state else {
        return;
    };
    if started {
        // A document has just been put on the surface, and if it is the empty
        // tab's own blank page it is ours to paint — the engine's is white in
        // every theme. Before the state goes out and before anything else
        // here: this is a main-thread callback, the paint is one main-thread
        // eval, and it is the frame on screen that is waiting for it.
        blank_page::paint(&registry, &state);
    }
    events::emit_state(app, &state);
    if started {
        // The ring was cleared above, so nothing has gone wrong on the page
        // that is arriving — yet. Said from here rather than left for the
        // frontend to infer from the tab state: `loading` is set by more than
        // a commit, and a second one arriving after the page's first error
        // would take the mark back off while the error was still there.
        events::emit_console_errors(app, tab_id, false);
    }
    if let Some(lost) = lost {
        events::emit_agent_grant(
            app,
            tab_id,
            agent::GrantChange::Navigated,
            agent::GrantLevel::None,
            Some(&lost.origin),
        );
    }
    if started && !substituted {
        begin_load(app, tab_id);
    }
}

/// The engine started a main-frame navigation (WebKit's
/// `didStartProvisionalNavigation`, before any byte has arrived). This is the
/// earliest the tab knows where it is heading: a link click, a redirect chain
/// or a form post all announce themselves here, so `requested_url` follows
/// the page's own navigations and not only the address bar's. The failed-load
/// watcher is armed from here for page-initiated navigations; the commands
/// arm it themselves as well, and a second arming only retires the first.
pub fn navigation_started(app: &AppHandle, tab_id: &str, url: &Url) {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    let state = registry.update(tab_id, |tab| {
        tab.provisional_url = Some(url.to_string());
        tab.state.requested_url = url.to_string();
        tab.state.loading = true;
        tab.state.error = None;
        tab.state.clone()
    });
    if let Some(state) = state {
        events::emit_state(app, &state);
    }
    begin_load(app, tab_id);
}

/// The server redirected the navigation in flight: the tab is heading for
/// `url` now, and that is the address an error page must name (and the one
/// a blank substitution stands in for). The engine asks the navigation
/// policy again for the new address, so a site rule still applies to it.
pub fn navigation_redirected(app: &AppHandle, tab_id: &str, url: &Url) {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    let state = registry.update(tab_id, |tab| {
        tab.provisional_url = Some(url.to_string());
        tab.state.requested_url = url.to_string();
        tab.state.clone()
    });
    if let Some(state) = state {
        events::emit_state(app, &state);
    }
}

/// A navigation the engine reported as failed (a platform delegate callback,
/// where one exists — wry itself never reports failure).
#[derive(Debug, Clone, PartialEq)]
pub struct LoadFailure {
    pub kind: BrowserErrorKind,
    /// The platform's own description, in the system language.
    pub message: String,
    /// The address that failed, when the error names one.
    pub url: Option<String>,
    /// Failed before anything committed (nothing of the new page is showing)
    /// rather than after (the page is up, a later part of the load broke).
    pub provisional: bool,
}

/// Classify a platform load error. `None` means "not a failure of the page":
/// a cancelled navigation (superseded by another, stopped by the user) and a
/// load the host itself redirected to a download or refused by policy both
/// end with an error code that is not the page's fault and must not paint an
/// error page. Domains and codes are Apple's (`NSURLErrorDomain`,
/// `WebKitErrorDomain`); other platforms map their own onto the same kinds.
pub fn classify_load_error(domain: &str, code: i64) -> Option<BrowserErrorKind> {
    match domain {
        "NSURLErrorDomain" => match code {
            // NSURLErrorCancelled
            -999 => None,
            // NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed
            -1003 | -1006 => Some(BrowserErrorKind::Dns),
            // NSURLErrorSecureConnectionFailed … NSURLErrorClientCertificateRequired
            -1206..=-1200 => Some(BrowserErrorKind::Tls),
            _ => Some(BrowserErrorKind::Failed),
        },
        // WebKitErrorFrameLoadInterruptedByPolicyChange: the policy delegate
        // (our own navigation handler) cancelled the load, or it became a
        // download. Both are handled where they happen.
        "WebKitErrorDomain" if code == 102 => None,
        _ => Some(BrowserErrorKind::Failed),
    }
}

/// Apply a reported failure. A provisional failure replaces the page with the
/// error page for the address that was asked for; a failure after commit
/// only stops the spinner — the document that committed stays, as in a
/// browser. Either way the load watcher, seeing `loading: false`, stands
/// down.
pub fn navigation_failed(app: &AppHandle, tab_id: &str, mut failure: LoadFailure) {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    // A remote tab's page that did not load: the tunnel knows why, the
    // engine only that its proxy said no (see `browser::remote`).
    if failure.provisional && failure.kind == BrowserErrorKind::Failed {
        if let Some(state) = registry.state(tab_id) {
            let url = failure.url.clone().filter(|u| !u.is_empty()).unwrap_or(state.requested_url);
            if let Some(kind) = state
                .profile
                .as_deref()
                .and_then(|profile| crate::browser::remote::failure_kind(app, profile, &url))
            {
                failure.kind = kind;
            }
        }
    }
    let state = registry.update(tab_id, |tab| {
        if failure.provisional {
            tab.provisional_url = None;
        }
        let state = &mut tab.state;
        state.loading = false;
        if failure.provisional {
            let url = failure
                .url
                .clone()
                .filter(|u| !u.is_empty())
                .or_else(|| (!state.requested_url.is_empty()).then(|| state.requested_url.clone()))
                .or_else(|| (!state.url.is_empty()).then(|| state.url.clone()));
            state.error = Some(BrowserErrorInfo {
                kind: failure.kind,
                message: failure.message.clone(),
                url,
            });
        }
        state.clone()
    });
    if let Some(state) = state {
        events::emit_state(app, &state);
    }
}

/// A top-level navigation was refused (scheme not allowed, or a site rule).
/// Nothing changes in the tab; the status layer shows why the click did
/// nothing.
pub fn navigation_blocked(app: &AppHandle, tab_id: &str, url: &str, reason: NavigationBlockReason) {
    tracing::info!("[browser] tab {tab_id} blocked navigation to {url} ({reason:?})");
    events::emit_navigation_blocked(app, tab_id, url, reason);
}

/// Arm the failed-load watcher for a navigation that is starting now. Called
/// where a load is kicked off (open, address bar, adopted popup) as well as
/// from `page_load`: wry's "started" is WebKit's `didCommitNavigation`, so a
/// navigation that never commits (DNS failure) never reports starting at all.
pub fn begin_load(app: &AppHandle, tab_id: &str) {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    if let Some(seq) = registry.update(tab_id, |tab| {
        tab.load_seq += 1;
        tab.load_seq
    }) {
        watch_load(app.clone(), tab_id.to_string(), seq);
    }
}

/// The tab's state once the navigation in flight ended without a page and
/// without a failure of its own — it became a download, or policy refused
/// where it was heading: not loading, no error, and back on the document it
/// is showing (what it "asked for" is no longer coming).
fn settle_without_page(state: &mut crate::browser::types::BrowserTabState) {
    state.loading = false;
    state.error = None;
    state.requested_url = state.url.clone();
}

/// What the load watcher does when the engine has stopped loading and the tab
/// still believes it has a navigation in flight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadConclusion {
    /// A document is on screen: stop the spinner and leave it there.
    Settle,
    /// Nothing ever arrived — the tab is empty. The error page names this
    /// address.
    Failed(String),
}

/// Decide it. The engine reports a real failure through the navigation hooks
/// (every platform installs them), and the tab is not loading by the time the
/// watcher looks; so a load that ends here with no failure reported is one
/// that was ABANDONED — superseded, cancelled by the page, answered with
/// nothing to display.
///
/// A browser leaves the document alone for those, and so does this: an error
/// page over a page the person is reading would be wrong on its own, and it
/// also takes the native surface off the screen (`BrowserTabView` hides it
/// under the DOM error page), which stops the very script that was about to
/// navigate again — a challenge page mid-check never finishes, and the address
/// the user asked for never arrives at all.
///
/// An empty tab is the other half: nothing is showing, nothing is coming, and
/// the address that never arrived is worth saying out loud.
///
/// What this gives up is the fallback error on a surface whose navigation
/// hooks did NOT install (`attach_engine_hooks` says so in a warning): there,
/// a load that fails on its way away from a page nobody hears about, and the
/// tab settles back on the page it is showing rather than reporting it. That
/// is the right way round — this watcher cannot tell a failure from an
/// abandonment, and only one of the two is worth taking a page off the screen
/// for.
pub fn conclude_load(has_document: bool, state: &BrowserTabState) -> LoadConclusion {
    if has_document && !state.url.is_empty() {
        return LoadConclusion::Settle;
    }
    let url = if state.requested_url.is_empty() {
        state.url.clone()
    } else {
        state.requested_url.clone()
    };
    LoadConclusion::Failed(url)
}

/// The load in flight was ended by policy (WebKit's "frame load interrupted
/// by policy change"): the host refused the address a redirect led to, or
/// the response became a download. Either way no page is coming for it and
/// nothing is wrong with the tab: settle it on the document it shows and
/// retire the watcher, which would otherwise report the address that never
/// arrived as a failed load. Only acts while a provisional load is known to
/// be in flight — the same error also follows a refused NEW navigation, which
/// never started and needs nothing settled.
pub fn navigation_interrupted(app: &AppHandle, tab_id: &str) {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    let state = registry
        .update(tab_id, |tab| {
            tab.provisional_url.take()?;
            tab.load_seq += 1;
            tab.download_seq = None;
            settle_without_page(&mut tab.state);
            Some(tab.state.clone())
        })
        .flatten();
    if let Some(state) = state {
        events::emit_state(app, &state);
    }
}

const LOAD_POLL: Duration = Duration::from_millis(500);
const LOAD_FINISH_GRACE: Duration = Duration::from_millis(300);

/// wry reports navigation start and finish but never failure, so a load that
/// ends without a page would leave `loading: true` forever. Poll the engine's
/// own flag until it clears; if our state is still loading a moment later, the
/// load in flight is over and nobody said so — `conclude_load` decides what
/// that means for the tab. A newer navigation (higher `load_seq`) retires the
/// watcher, and so does a failure the navigation hooks reported (it clears
/// `loading` itself).
fn watch_load(app: AppHandle, tab_id: String, seq: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(LOAD_POLL).await;
            let Some(registry) = app.try_state::<BrowserRegistry>() else {
                return;
            };
            let Some((surface, loading, current)) = registry.update(&tab_id, |tab| {
                (tab.surface.clone(), tab.state.loading, tab.load_seq)
            }) else {
                return;
            };
            if current != seq || !loading {
                return;
            }
            match surface.is_loading() {
                Ok(true) => continue,
                Ok(false) => {}
                // No load state on this surface (owned windows for now).
                Err(_) => return,
            }
            // `didFinish` may still be on its way.
            tokio::time::sleep(LOAD_FINISH_GRACE).await;
            let Some((loading, current)) =
                registry.update(&tab_id, |tab| (tab.state.loading, tab.load_seq))
            else {
                return;
            };
            if current != seq || !loading {
                return;
            }
            let has_document = surface.url().is_ok();
            let next = registry.update(&tab_id, |tab| {
                // This very navigation turned into a download: it was never
                // going to commit, so there is nothing to report.
                if tab.download_seq == Some(seq) {
                    tab.download_seq = None;
                    settle_without_page(&mut tab.state);
                    return tab.state.clone();
                }
                let state = &mut tab.state;
                // The load in flight is over, whatever became of it. What
                // that means for the tab is `conclude_load`'s to say; its
                // wording, where there is any, is the status layer's, in the
                // user's language.
                match conclude_load(has_document, state) {
                    LoadConclusion::Settle => settle_without_page(state),
                    LoadConclusion::Failed(url) => {
                        state.loading = false;
                        state.error = Some(BrowserErrorInfo {
                            kind: BrowserErrorKind::Failed,
                            message: String::new(),
                            url: Some(url),
                        });
                    }
                }
                state.clone()
            });
            if let Some(next) = next {
                events::emit_state(&app, &next);
            }
            return;
        }
    });
}

/// A navigation turned into a download. Nothing will ever commit for it, so
/// the watcher armed for it must not report "the requested address never
/// arrived" and paint an error page over the document the tab is still
/// perfectly happily showing.
///
/// This only MARKS the generation; the watcher settles when it concludes.
/// Retiring the watcher here instead would be wrong whenever the download's
/// callback arrives late: by then the tab may be loading something else, and
/// clearing that navigation's state would both stop its spinner early and
/// swallow its real failure.
///
/// Known limit: the engine does not say which navigation a download came
/// from, and for a redirected download the reported URL is the FINAL one
/// (verified on macOS: navigating to a URL that 302s to a file reports the
/// file's URL), so the address cannot be used to correlate either. A download
/// callback that arrives after a later navigation has started therefore marks
/// that navigation's generation, and if it then fails its error is not
/// reported. The alternative — matching on the URL — would put an error page
/// over a perfectly good page for every redirected download, which is the
/// common case.
///
/// A surface that cannot answer a load state has no watcher — the one it was
/// given exits at its first tick — so nothing there would ever consume the
/// mark: those tabs settle here and now, or they would spin for ever. That is
/// the owned window on macOS and Windows, where the host has no hold on the
/// engine webview, and NOT the owned window on Linux, which answers like an
/// embedded tab; asking the surface keeps the two apart without naming either.
pub fn navigation_became_download(app: &AppHandle, tab_id: &str) {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    let watched = registry
        .surface(tab_id)
        .is_some_and(|surface| surface.is_loading().is_ok());
    if watched {
        registry.update(tab_id, |tab| tab.download_seq = Some(tab.load_seq));
        return;
    }
    let state = registry.update(tab_id, |tab| {
        tab.download_seq = None;
        settle_without_page(&mut tab.state);
        tab.state.clone()
    });
    if let Some(state) = state {
        events::emit_state(app, &state);
    }
}

pub fn title_changed(app: &AppHandle, tab_id: &str, title: String) {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    let state = registry.update_state(tab_id, |state| state.title = title);
    if let Some(state) = state {
        events::emit_state(app, &state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::types::{BrowserTabState, ChannelKind, SurfaceKind, TabKind};

    fn state(url: &str, requested: &str) -> BrowserTabState {
        BrowserTabState {
            tab_id: "t1".into(),
            owner_window: "main".into(),
            kind: TabKind::Page,
            surface: SurfaceKind::Child,
            channel: ChannelKind::Native,
            channel_error: None,
            url: url.into(),
            requested_url: requested.into(),
            title: "Listing".into(),
            favicon: None,
            loading: true,
            can_go_back: false,
            can_go_forward: false,
            origin: None,
            zoom: 1.0,
            error: Some(BrowserErrorInfo {
                kind: BrowserErrorKind::Failed,
                message: String::new(),
                url: Some(requested.into()),
            }),
            remote_host: None,
            opener_tab_id: None,
            profile: Some("default".into()),
            agent_grant: None,
        }
    }

    /// Clicking a link that downloads leaves the navigation for ever
    /// uncommitted. Without this the load watcher's "the requested address
    /// never arrived" rule paints an error page over a perfectly good page.
    #[test]
    fn a_download_leaves_the_tab_on_the_page_it_is_showing() {
        let mut s = state("http://127.0.0.1:8790/", "http://127.0.0.1:8790/a.bin");
        settle_without_page(&mut s);
        assert!(!s.loading);
        assert!(s.error.is_none());
        assert_eq!(s.requested_url, "http://127.0.0.1:8790/");
        assert_eq!(s.url, "http://127.0.0.1:8790/");
        assert_eq!(s.title, "Listing");
    }

    /// A tab opened straight on a download URL has no document at all; it
    /// stays empty rather than claiming a failure.
    #[test]
    fn a_download_into_a_fresh_tab_settles_empty() {
        let mut s = state("", "http://127.0.0.1:8790/a.bin");
        settle_without_page(&mut s);
        assert!(!s.loading);
        assert!(s.error.is_none());
        assert_eq!(s.requested_url, "");
    }

    /// The load in flight ended and nothing was reported for it. A tab with a
    /// page on screen keeps it: the navigation was abandoned (superseded,
    /// cancelled by the page, answered with nothing to show), which is not a
    /// failure — and an error page here would take the surface off the screen
    /// and stop the script that was about to navigate again.
    #[test]
    fn a_page_on_screen_survives_a_navigation_that_ended_without_one() {
        let showing = state("https://linux.do/", "https://linux.do/challenge");
        assert_eq!(conclude_load(true, &showing), LoadConclusion::Settle);
        // A failed reload of the page showing: same answer, and it was the
        // same answer before — the spinner stops, the page stays.
        let reloaded = state("https://linux.do/", "https://linux.do/");
        assert_eq!(conclude_load(true, &reloaded), LoadConclusion::Settle);
    }

    /// Nothing ever arrived: the error page names the address that was asked
    /// for, and falls back to the tab's own when there is none.
    #[test]
    fn an_empty_tab_reports_the_address_that_never_arrived() {
        let empty = state("", "https://example.com/");
        assert_eq!(
            conclude_load(false, &empty),
            LoadConclusion::Failed("https://example.com/".into())
        );
        // The engine holds no document either way; `url` is all there is.
        let stale = state("https://example.com/", "");
        assert_eq!(
            conclude_load(false, &stale),
            LoadConclusion::Failed("https://example.com/".into())
        );
    }

    /// Only an adopted popup — a window a page opened — may close itself.
    #[test]
    fn a_page_may_only_close_the_window_it_opened() {
        let popup = BrowserTabState {
            opener_tab_id: Some("opener".into()),
            ..state("https://accounts.google.com/", "")
        };
        assert!(page_may_close_itself(&popup));
        // A tab the person opened is theirs to close.
        assert!(!page_may_close_itself(&state("https://example.com/", "")));
        // A document guest is a file preview, not a window.
        let guest = BrowserTabState {
            kind: TabKind::Document,
            opener_tab_id: Some("opener".into()),
            ..state("codeg-doc://x/index.html", "")
        };
        assert!(!page_may_close_itself(&guest));
    }

    /// An empty document committed in place of the page that was started is
    /// a refused load; a page that heads for `about:blank` itself is not.
    #[test]
    fn a_blank_commit_counts_as_failure_only_when_something_else_was_started() {
        let blank = Url::parse("about:blank").unwrap();
        let page = Url::parse("http://127.0.0.1:1/").unwrap();
        assert!(blank_substituted_for(Some("http://127.0.0.1:1/"), &blank));
        assert!(!blank_substituted_for(Some("about:blank"), &blank));
        assert!(!blank_substituted_for(None, &blank));
        assert!(!blank_substituted_for(Some("http://127.0.0.1:1/"), &page));
    }

    /// Apple's codes, by kind — and the two that are NOT page failures.
    #[test]
    fn load_errors_classify_by_domain_and_code() {
        use BrowserErrorKind::*;
        assert_eq!(classify_load_error("NSURLErrorDomain", -1003), Some(Dns));
        assert_eq!(classify_load_error("NSURLErrorDomain", -1006), Some(Dns));
        assert_eq!(classify_load_error("NSURLErrorDomain", -1200), Some(Tls));
        assert_eq!(classify_load_error("NSURLErrorDomain", -1202), Some(Tls));
        assert_eq!(classify_load_error("NSURLErrorDomain", -1206), Some(Tls));
        assert_eq!(classify_load_error("NSURLErrorDomain", -1004), Some(Failed));
        assert_eq!(classify_load_error("NSURLErrorDomain", -1001), Some(Failed));
        assert_eq!(classify_load_error("NSURLErrorDomain", -1009), Some(Failed));
        assert_eq!(classify_load_error("NSURLErrorDomain", -1199), Some(Failed));
        assert_eq!(classify_load_error("NSURLErrorDomain", -1207), Some(Failed));
        // Superseded / stopped / the page navigated again: not an error of
        // the page — and still the end of the load in flight, which is why
        // every one of these is reported as `NavigationEvent::Interrupted`
        // (see `shim::macos::report_failure`) rather than left for the load
        // watcher to notice.
        assert_eq!(classify_load_error("NSURLErrorDomain", -999), None);
        // Cancelled by our own policy handler, or became a download.
        assert_eq!(classify_load_error("WebKitErrorDomain", 102), None);
        assert_eq!(classify_load_error("WebKitErrorDomain", 101), Some(Failed));
        assert_eq!(classify_load_error("WKErrorDomain", 2), Some(Failed));
    }

    #[test]
    fn origin_is_none_for_opaque_urls() {
        assert_eq!(
            origin_of(&Url::parse("https://example.com:8443/a").unwrap()).as_deref(),
            Some("https://example.com:8443")
        );
        assert_eq!(origin_of(&Url::parse("about:blank").unwrap()), None);
        assert_eq!(origin_of(&Url::parse("blob:null/x").unwrap()), None);
    }
}
