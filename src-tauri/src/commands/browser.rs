//! `browser_*` commands: thin parameter validation over the registry. The
//! `_core` functions are the real implementation and are also driven by the
//! dev-only smoke puppet, so every code path the frontend uses is the one the
//! P0/P1 checks exercised.

use std::time::Duration;

use base64::Engine as _;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri::Url;

use crate::app_error::AppCommandError;
use crate::browser::agent::{self, GrantLevel};
use crate::browser::blank_page;
use crate::browser::capture::{self, CaptureOutcome, CaptureRegion, CaptureRequest};
use crate::browser::console::{ConsoleEntry, ConsoleLevel, ConsoleQuery, ConsoleReadout};
use crate::browser::confirm::{
    AskRefused, EvalConsent, EvalRequestPayload, EVAL_CONFIRM_TIMEOUT,
};
use crate::browser::doc_guest::{self, DocGuestState, DocGuests, DocMode};
use crate::browser::eval::{self, EvalAnswer, EvalOutcome, EvalRequest};
use crate::browser::handoff::{self, PageHandoff};
use crate::browser::downloads::{BrowserDownload, BrowserDownloads};
use crate::browser::policy::{BrowserPolicy, HostRule};
use crate::browser::registry::{self, BrowserRegistry, BrowserTab};
use crate::browser::surface::{BrowserSurface, PointerFailure, PointerGesture};
use crate::browser::open_request;
use crate::browser::types::{
    Bounds, BrowserCapabilities, BrowserErrorInfo, BrowserErrorKind, BrowserOpenRequestPayload,
    BrowserTabState, ChannelKind, DetectedService, FrozenFrame, SurfaceChoice, SurfaceKind,
    TabKind,
};
use crate::browser::{events, hooks, listener, policy, profile, services, tab_label};

#[cfg(all(
    feature = "browser-child",
    any(target_os = "macos", target_os = "windows")
))]
const CHILD_SURFACE_COMPILED: bool = true;
#[cfg(not(all(
    feature = "browser-child",
    any(target_os = "macos", target_os = "windows")
)))]
const CHILD_SURFACE_COMPILED: bool = false;

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// What this build can do on this machine. `channel` is what a new tab will
/// be given, not what any tab currently has: a tab reports its own, and a
/// per-tab install that fails lands in its `channel_error`. The frontend keys
/// off `available` and `surface`. An administrator's policy can turn the whole
/// feature off, in which case every link goes to the system browser.
pub fn capabilities(policy: &BrowserPolicy) -> BrowserCapabilities {
    let mut reasons = Vec::new();
    let enabled = policy.enabled();
    if !enabled {
        reasons.push("disabled by the administrator's policy".to_string());
    }
    let surface = if CHILD_SURFACE_COMPILED {
        SurfaceKind::Child
    } else {
        reasons.push(if cfg!(target_os = "linux") {
            "linux: child webviews cannot be positioned; using owned windows".to_string()
        } else {
            "child surface not compiled; using owned windows".to_string()
        });
        SurfaceKind::Window
    };
    // The installer ships with the embedded surface. On macOS before 11 it
    // falls back to the page world, which only the live controller can tell,
    // so a tab there answers `legacy` while this still says `native`. Linux
    // has no embedded surface and a channel all the same: its owned window
    // carries the script world itself.
    let channel = if CHILD_SURFACE_COMPILED || crate::browser::surface_window::HAS_CHANNEL {
        ChannelKind::Native
    } else {
        reasons.push("no page channel without the embedded surface".to_string());
        ChannelKind::Degraded
    };
    BrowserCapabilities {
        available: enabled,
        surface: enabled.then_some(surface),
        platform: platform_name().to_string(),
        channel,
        reasons,
        isolated_storage: crate::browser::profile::isolated_storage(),
        proxy: crate::browser::profile::proxy_status(),
        downloads_dir: crate::browser::downloads::downloads_dir_display(),
        policy: policy.status(),
        doc_guest: enabled && doc_guest::supported(),
        profiles: enabled && profile::profiles_supported(),
        sign_in_user_agent: enabled && profile::sign_in_user_agent_supported(),
        owned_window_controls: crate::browser::surface_window::HAS_CHANNEL,
        remote_egress: enabled && crate::browser::remote::supported(),
    }
}

/// The error a tab shows for an address a site rule blocks. No message: the
/// status layer has its own wording, in the user's language.
fn blocked_error(url: &Url) -> BrowserErrorInfo {
    BrowserErrorInfo {
        kind: BrowserErrorKind::Blocked,
        message: String::new(),
        url: Some(url.to_string()),
    }
}

/// Whether the policy in force refuses `url` outright.
fn blocked_by_policy(app: &AppHandle, url: &Url) -> bool {
    app.try_state::<BrowserPolicy>()
        .is_some_and(|policy| policy.blocked(url))
}

fn pick_surface(choice: SurfaceChoice) -> SurfaceKind {
    if CHILD_SURFACE_COMPILED && choice != SurfaceChoice::Window {
        SurfaceKind::Child
    } else {
        SurfaceKind::Window
    }
}

/// Tab ids become webview labels, and a label is also what the popup and
/// capability checks key on, so keep them to a safe alphabet.
fn validate_tab_id(tab_id: &str) -> Result<(), AppCommandError> {
    let ok = !tab_id.is_empty()
        && tab_id.len() <= 64
        && tab_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(AppCommandError::invalid_input(format!(
            "invalid browser tab id {tab_id:?}"
        )))
    }
}

fn parse_web_url(raw: &str) -> Result<Url, AppCommandError> {
    let url = Url::parse(raw.trim())
        .map_err(|e| AppCommandError::invalid_input(format!("invalid url {raw:?}: {e}")))?;
    if !policy::open_url_allowed(&url) {
        return Err(AppCommandError::invalid_input(format!(
            "url scheme not allowed in a browser tab: {raw:?}"
        )));
    }
    Ok(url)
}

/// `host[:port]` — an owned window's title never shows the path or query, so a
/// one-time token in an OAuth URL cannot leak through the window list.
pub fn origin_title(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        (None, _) => url.to_string(),
    }
}

fn window_err(what: &str, err: impl std::fmt::Display) -> AppCommandError {
    AppCommandError::window(what.to_string(), err.to_string())
}

pub struct OpenTabParams {
    pub tab_id: String,
    pub url: String,
    pub bounds: Bounds,
    pub background: bool,
    pub surface: SurfaceChoice,
    /// Build the surface with the web inspector available (user preference).
    pub devtools: bool,
    /// The browser profile to open the tab in (`default` when the caller has
    /// no opinion).
    pub profile: String,
}

pub fn open_tab_core(
    app: &AppHandle,
    owner: &WebviewWindow,
    registry: &BrowserRegistry,
    params: OpenTabParams,
) -> Result<BrowserTabState, AppCommandError> {
    validate_tab_id(&params.tab_id)?;
    // Held until the tab is registered: a second open of the same id while
    // this one builds its surface must fail, not build a second surface.
    let reservation = registry.reserve(&params.tab_id)?;
    if app
        .try_state::<BrowserPolicy>()
        .is_some_and(|policy| !policy.enabled())
    {
        return Err(AppCommandError::invalid_input(
            "the built-in browser is disabled by the administrator's policy",
        ));
    }
    let asked = parse_web_url(&params.url)?;
    // Where the tab really goes: a remote profile's loopback address, on
    // macOS, by its alias (see `browser::remote`).
    let url = crate::browser::remote::egress_address(&params.profile, &asked).into_owned();
    let label = tab_label(&params.tab_id);
    profile::check(&params.profile).map_err(AppCommandError::invalid_input)?;
    // Held until this returns (the tab is registered by then): a deletion of
    // the profile that has begun refuses the open, one that begins now waits
    // for it.
    let _admission = profile::admit(&params.profile).map_err(AppCommandError::invalid_input)?;
    profile::prepare(app, &params.profile)
        .map_err(|e| window_err("Failed to prepare the browser profile", e))?;

    // A remote profile's tab on macOS is embedded whatever the preference:
    // the alias rewrite and the loopback rules are the embedded surface's
    // (`remote::supported` refuses a build without it).
    let choice = if cfg!(target_os = "macos") && profile::is_remote_profile(&params.profile) {
        SurfaceChoice::Child
    } else {
        params.surface
    };
    let surface = match pick_surface(choice) {
        #[cfg(all(
            feature = "browser-child",
            any(target_os = "macos", target_os = "windows")
        ))]
        SurfaceKind::Child => BrowserSurface::Child(
            crate::browser::surface_child::create(
                app,
                owner,
                &params.tab_id,
                &label,
                params.bounds,
                params.background,
                params.devtools,
                &params.profile,
            )
            .map_err(|e| window_err("Failed to create browser webview", e))?,
        ),
        _ => BrowserSurface::Window(Box::new(
            crate::browser::surface_window::create(
                app,
                owner,
                &params.tab_id,
                &label,
                &origin_title(&url),
                params.background,
                params.devtools,
                &params.profile,
            )
            .map_err(|e| window_err("Failed to create browser window", e))?,
        )),
    };

    let state = BrowserTabState {
        tab_id: params.tab_id.clone(),
        owner_window: owner.label().to_string(),
        kind: TabKind::Page,
        surface: surface.kind(),
        channel: ChannelKind::Degraded,
        channel_error: None,
        url: String::new(),
        requested_url: url.to_string(),
        title: String::new(),
        favicon: None,
        loading: true,
        can_go_back: false,
        can_go_forward: false,
        origin: None,
        zoom: 1.0,
        error: None,
        remote_host: profile::remote_host(&params.profile),
        opener_tab_id: None,
        profile: Some(params.profile.clone()),
        agent_grant: None,
    };
    if let Err(err) = registry.insert_reserved(
        BrowserTab::new(
            state.clone(),
            surface.clone(),
            params.bounds,
            !params.background,
            params.devtools,
        ),
        reservation,
    ) {
        let _ = surface.close();
        return Err(err);
    }
    // The helper must be in place before the first real document loads;
    // `about:blank` is still showing at this point. A failed install is not
    // fatal: the tab works, only the page channel is missing.
    let mut state = state;
    if surface.has_channel() {
        match surface.install_channel() {
            // Stays `degraded` until the helper's `hello` proves the round trip.
            Ok(true) => {}
            Ok(false) => {
                if let Some(next) =
                    registry.update_state(&params.tab_id, |s| s.channel = ChannelKind::Legacy)
                {
                    state = next;
                }
            }
            Err(err) => {
                tracing::warn!(
                    "[browser] tab {}: page channel unavailable ({err}); continuing degraded",
                    params.tab_id
                );
                if let Some(next) = registry.update_state(&params.tab_id, |s| {
                    s.channel_error = Some(err.to_string())
                }) {
                    state = next;
                }
            }
        }
    }
    if params.background && surface.is_embedded() {
        let _ = surface.hide();
    }
    // A blocked address gets its tab — the caller (an agent tool, a deep
    // link) asked for one and the block page is where the user learns why —
    // but nothing is loaded into it.
    if blocked_by_policy(app, &asked) || blocked_by_policy(app, &url) {
        let state = registry
            .update_state(&params.tab_id, |s| {
                s.loading = false;
                s.error = Some(blocked_error(&asked));
            })
            .unwrap_or(state);
        events::emit_state(app, &state);
        return Ok(state);
    }
    if let Err(err) = surface.navigate(url) {
        registry.remove(&params.tab_id);
        let _ = surface.close();
        return Err(window_err("Failed to navigate browser tab", err));
    }
    hooks::begin_load(app, &params.tab_id);
    events::emit_state(app, &state);
    Ok(state)
}

pub struct DocOpenParams {
    pub tab_id: String,
    /// Absolute path of the HTML file.
    pub path: String,
    /// Directory to confine the document to (the owning workspace folder);
    /// the file's own directory when absent or not containing the file.
    pub root: Option<String>,
    pub bounds: Bounds,
    pub background: bool,
    pub devtools: bool,
}

/// What `browser_doc_open` answers: the tab like any other, and the guest's
/// own state (mode, root, URL).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocOpenResult {
    pub state: BrowserTabState,
    pub doc: DocGuestState,
}

/// Show a local HTML file through a document guest (see `doc_guest`). The
/// guest is an embedded surface like a tab's, registered under the same
/// registry so bounds, visibility, reload and close work unchanged; the
/// grant — root, entry, mode — is looked up by document, so the file comes
/// back in the mode the user last chose for it this session.
#[cfg_attr(
    not(all(
        feature = "browser-child",
        any(target_os = "macos", target_os = "windows")
    )),
    // Everything below the surface is dead where there is no embedded surface:
    // `doc_guest::supported()` is false there, and the block that would build
    // one is a `return`. It still has to compile.
    allow(unreachable_code, unused_variables)
)]
pub fn doc_open_core(
    app: &AppHandle,
    owner: &WebviewWindow,
    registry: &BrowserRegistry,
    guests: &DocGuests,
    params: DocOpenParams,
) -> Result<DocOpenResult, AppCommandError> {
    validate_tab_id(&params.tab_id)?;
    let reservation = registry.reserve(&params.tab_id)?;
    if app
        .try_state::<BrowserPolicy>()
        .is_some_and(|policy| !policy.enabled())
    {
        return Err(AppCommandError::invalid_input(
            "the built-in browser is disabled by the administrator's policy",
        ));
    }
    if !doc_guest::supported() {
        return Err(AppCommandError::invalid_input(
            "document guests need the embedded browser surface",
        ));
    }
    let (root, entry) = doc_guest::resolve_document(&params.path, params.root.as_deref())
        .map_err(AppCommandError::invalid_input)?;
    let grant = guests
        .grant_for(root, entry)
        .map_err(AppCommandError::invalid_input)?;
    let label = doc_guest::doc_label(&params.tab_id);
    // Annotated because on a platform without the embedded surface the block
    // below is nothing but a `return`, and a diverging block tells the
    // compiler nothing about what the rest of this function is holding.
    let surface: BrowserSurface = {
        #[cfg(all(
            feature = "browser-child",
            any(target_os = "macos", target_os = "windows")
        ))]
        {
            BrowserSurface::Child(
                crate::browser::surface_child::create_document(
                    app,
                    owner,
                    &params.tab_id,
                    &label,
                    params.bounds,
                    params.background,
                    params.devtools,
                    grant.clone(),
                )
                .map_err(|e| window_err("Failed to create document webview", e))?,
            )
        }
        #[cfg(not(all(
            feature = "browser-child",
            any(target_os = "macos", target_os = "windows")
        )))]
        {
            let _ = (owner, &label, reservation);
            return Err(AppCommandError::invalid_input(
                "document guests need the embedded browser surface",
            ));
        }
    };
    let url = grant.document_url();
    let state = BrowserTabState {
        tab_id: params.tab_id.clone(),
        owner_window: owner.label().to_string(),
        kind: TabKind::Document,
        surface: surface.kind(),
        channel: ChannelKind::Degraded,
        channel_error: None,
        url: String::new(),
        requested_url: url.clone(),
        title: String::new(),
        favicon: None,
        loading: true,
        can_go_back: false,
        can_go_forward: false,
        origin: None,
        zoom: 1.0,
        error: None,
        remote_host: None,
        opener_tab_id: None,
        profile: None,
        agent_grant: None,
    };
    if let Err(err) = registry.insert_reserved(
        BrowserTab::new(
            state.clone(),
            surface.clone(),
            params.bounds,
            !params.background,
            params.devtools,
        ),
        reservation,
    ) {
        let _ = surface.close();
        return Err(err);
    }
    guests.bind(&params.tab_id, grant.clone());
    let mut state = state;
    match surface.install_channel() {
        Ok(true) => {}
        Ok(false) => {
            if let Some(next) =
                registry.update_state(&params.tab_id, |s| s.channel = ChannelKind::Legacy)
            {
                state = next;
            }
        }
        Err(err) => {
            tracing::warn!(
                "[browser] document {}: page channel unavailable ({err}); continuing degraded",
                params.tab_id
            );
            if let Some(next) = registry
                .update_state(&params.tab_id, |s| s.channel_error = Some(err.to_string()))
            {
                state = next;
            }
        }
    }
    if params.background {
        let _ = surface.hide();
    }
    let parsed = Url::parse(&url)
        .map_err(|e| AppCommandError::invalid_input(format!("bad document url {url:?}: {e}")))?;
    if let Err(err) = surface.navigate(doc_guest::engine_url(&parsed)) {
        registry.remove(&params.tab_id);
        guests.unbind(&params.tab_id);
        let _ = surface.close();
        return Err(window_err("Failed to load the document", err));
    }
    hooks::begin_load(app, &params.tab_id);
    events::emit_state(app, &state);
    let doc = grant.state(&params.tab_id);
    events::emit_doc_state(app, &doc);
    Ok(DocOpenResult { state, doc })
}

/// The user's choice of mode for a document. Takes effect on the reload
/// this performs: the CSP travels with the document, and a fresh approval
/// starts counting from now.
pub fn doc_set_mode_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    guests: &DocGuests,
    tab_id: &str,
    mode: DocMode,
) -> Result<DocGuestState, AppCommandError> {
    let grant = guests
        .for_tab(tab_id)
        .ok_or_else(|| AppCommandError::not_found(format!("document guest {tab_id} not found")))?;
    let surface = surface_of(registry, tab_id)?;
    grant.set_mode(mode);
    let doc = grant.state(tab_id);
    events::emit_doc_state(app, &doc);
    reload_document(app, registry, tab_id, &surface, &grant.document_url())?;
    Ok(doc)
}

/// Load a document guest's page again so the policy in force travels with
/// it. Nothing committed yet (the first load still in flight, or refused):
/// navigate to the document instead — a reload has nothing to reload, and
/// the general retry path would refuse a `codeg-doc:` address.
fn reload_document(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    surface: &BrowserSurface,
    document_url: &str,
) -> Result<(), AppCommandError> {
    let state = registry.update_state(tab_id, |state| {
        state.requested_url = document_url.to_string();
        state.loading = true;
        state.error = None;
    });
    if surface.url().is_ok() {
        surface
            .reload()
            .map_err(|e| window_err("Failed to reload the document", e))?;
    } else {
        let url = Url::parse(document_url).map_err(|e| {
            AppCommandError::invalid_input(format!("bad document url {document_url:?}: {e}"))
        })?;
        surface
            .navigate(doc_guest::engine_url(&url))
            .map_err(|e| window_err("Failed to load the document", e))?;
    }
    hooks::begin_load(app, tab_id);
    if let Some(state) = state {
        events::emit_state(app, &state);
    }
    Ok(())
}

pub fn doc_state_core(guests: &DocGuests, tab_id: &str) -> Result<DocGuestState, AppCommandError> {
    guests
        .for_tab(tab_id)
        .map(|grant| grant.state(tab_id))
        .ok_or_else(|| AppCommandError::not_found(format!("document guest {tab_id} not found")))
}

/// Wipe cookies, caches and every other kind of stored site data of one
/// profile. Every tab of the profile shares the store, so this is app-wide
/// for that profile; open pages keep running (nothing is reloaded, as in a
/// browser).
pub async fn clear_data_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    profile_id: &str,
) -> Result<(), AppCommandError> {
    // `check`, not only the syntax: below macOS 14 a profile other than the
    // default has no store of its own, and clearing "it" would clear the
    // shared one.
    profile::check(profile_id).map_err(AppCommandError::invalid_input)?;
    // Held through the clear: see `open_tab_core`. On macOS the engine's
    // completion callback holds a share, so a wait that gives up (the 15 s
    // cap) does not end the admission while WebKit is still clearing.
    let admission = profile::admit(profile_id).map_err(AppCommandError::invalid_input)?;
    #[cfg(target_os = "macos")]
    {
        // Straight at the profile's store: works with no tab open and reports
        // completion, which a surface's `clear_all_browsing_data` cannot.
        let _ = registry;
        let profile_id = profile_id.to_string();
        let held = admission.share();
        on_main_until_done(app, "Failed to clear browsing data", move |done| {
            crate::browser::shim::macos::clear_profile_store(&profile_id, move || {
                let _held = &held;
                done()
            })
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Until the Windows / Linux shims land, clearing goes through a live
        // surface of the profile (they all share its store); with none open
        // there is nothing to call into. Picked under one lock: a tab id
        // looked up separately could by then name a tab of another profile.
        // The engine reports no completion here, so the admission ends when
        // the call returns — a deletion that follows at once may find the
        // engine still writing and fail with a retry, which is the accepted
        // shape on these platforms until their shims land.
        let _ = app;
        let Some(surface) = registry.surface_in_profile(profile_id) else {
            return Err(AppCommandError::invalid_input(
                "open a page in this profile first, then clear its data",
            ));
        };
        let result = surface
            .clear_browsing_data()
            .map_err(|e| window_err("Failed to clear browsing data", e));
        drop(admission);
        result
    }
}

/// Delete a profile and everything stored in it. The default profile stays
/// (clear it instead). The profile's tabs are closed first — every window's,
/// with the `browser://closed` event that drops their records — because the
/// engine refuses to remove a store a webview still uses (and would keep
/// writing into a folder being deleted); WebKit then gets a moment to let go
/// of the views before the store is asked to go.
pub async fn remove_profile_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    profile_id: &str,
) -> Result<(), AppCommandError> {
    profile::check(profile_id).map_err(AppCommandError::invalid_input)?;
    if profile_id == profile::DEFAULT_PROFILE_ID {
        return Err(AppCommandError::invalid_input(
            "the default browser profile cannot be deleted; clear its data instead",
        ));
    }
    // From here until the store is gone, nothing may put it back in use:
    // opens, popups and clears of this profile are refused (see
    // `profile::admit`), the ones already under way are waited for, and the
    // mark lifts when the last holder is gone — the native completion
    // callbacks hold shares, so a command that times out cannot lift it
    // while WebKit is still at work.
    let removing = profile::begin_removal(profile_id).map_err(AppCommandError::invalid_input)?;
    if !profile::wait_until_idle(profile_id).await {
        return Err(AppCommandError::invalid_input(
            "the browser profile is busy; try again in a moment",
        ));
    }
    // Detach only tabs that are STILL in the profile when each is taken: a
    // tab id can be reused by a later incarnation in another profile.
    for tab_id in registry.tabs_in_profile(profile_id) {
        let Some(tab) = registry.remove_if(&tab_id, |tab| tab.state.profile.as_deref() == Some(profile_id))
        else {
            continue;
        };
        let _ = tab.surface.close();
        if let Some(guests) = app.try_state::<DocGuests>() {
            guests.unbind(&tab_id);
        }
        events::emit_closed(app, &tab_id, &tab.state.owner_window, None);
    }
    // A moment for the engine to let go of views that were just closed —
    // here or by a close that was still running when the tabs were listed.
    tokio::time::sleep(Duration::from_millis(300)).await;
    #[cfg(target_os = "macos")]
    {
        // Two main-thread turns: the data goes through the store first (that
        // reaches the network process's session, which removing the store
        // alone leaves alone — its cookies were seen surviving into a store
        // created again under the same identifier), then the store itself,
        // on a later turn so that no reference to it from the first — ours or
        // an autoreleased one — is still alive when WebKit checks.
        let what = "Failed to delete the browser profile";
        let clearing = profile_id.to_string();
        let mark = removing.share();
        on_main_until_done(app, what, move |done| {
            crate::browser::shim::macos::clear_profile_store(&clearing, move || {
                let _held = &mark;
                done()
            })
        })
        .await?;
        let removing_id = profile_id.to_string();
        let mark = removing.share();
        on_main_until_result(app, what, move |done| {
            crate::browser::shim::macos::remove_profile_store(&removing_id, move |result| {
                let _held = &mark;
                done(result)
            })
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(all(feature = "browser-child", target_os = "windows"))]
        crate::browser::surface_child::forget_profile_context(app, profile_id)
            .map_err(|e| window_err("Failed to delete the browser profile", e))?;
        let _ = app;
        let result = profile::remove_directory(profile_id)
            .map_err(|e| window_err("Failed to delete the browser profile", e));
        drop(removing);
        result
    }
}

/// Run `start` on the main thread and wait until the completion callback it
/// was given has fired (WebKit reports finished removals that way), with a
/// timeout so a callback that never comes cannot hang the caller.
#[cfg(target_os = "macos")]
pub async fn on_main_until_done(
    app: &AppHandle,
    what: &str,
    start: impl FnOnce(Box<dyn Fn() + 'static>) -> Result<(), String> + Send + 'static,
) -> Result<(), AppCommandError> {
    on_main_until_result(app, what, move |done| start(Box::new(move || done(Ok(()))))).await
}

/// `on_main_until_done` for callbacks that carry the platform's verdict.
#[cfg(target_os = "macos")]
pub async fn on_main_until_result(
    app: &AppHandle,
    what: &str,
    start: impl FnOnce(Box<dyn Fn(Result<(), String>) + 'static>) -> Result<(), String> + Send + 'static,
) -> Result<(), AppCommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let finish = move |result: Result<(), String>| {
        if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = tx.send(result);
        }
    };
    app.run_on_main_thread(move || {
        let on_done = finish.clone();
        if let Err(err) = start(Box::new(on_done)) {
            finish(Err(err));
        }
    })
    .map_err(|e| window_err(what, e))?;
    match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(err))) => Err(window_err(what, err)),
        Ok(Err(_)) => Err(window_err(what, "the request was dropped")),
        Err(_) => Err(window_err(what, "timed out waiting for WebKit")),
    }
}

fn surface_of(registry: &BrowserRegistry, tab_id: &str) -> Result<BrowserSurface, AppCommandError> {
    registry
        .surface(tab_id)
        .ok_or_else(|| AppCommandError::not_found(format!("browser tab {tab_id} not found")))
}

/// `request_id` is echoed back on `browser://closed` so the caller can tell
/// that event from one it did not ask for — see [`BrowserClosedPayload`].
/// Nothing is emitted when the tab was already gone: the registry removal is
/// what earns the right to announce a close, and somebody else has earned it.
pub fn close_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    request_id: Option<&str>,
) -> Result<(), AppCommandError> {
    close_core_if(app, registry, tab_id, request_id, |_| true)
}

/// Close only the incarnation `matches` recognises. A tab id is reused, so a
/// caller that decided on a snapshot and then crossed a thread boundary to act
/// on it — the page asking for its own window to go is the one that does —
/// must say which tab it looked at, or it can take one it never saw.
/// `close_core` is the form for a caller holding the registry still.
pub fn close_core_if(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    request_id: Option<&str>,
    matches: impl FnOnce(&BrowserTab) -> bool,
) -> Result<(), AppCommandError> {
    if let Some(tab) = registry.remove_if(tab_id, matches) {
        let _ = tab.surface.close();
        if let Some(guests) = app.try_state::<DocGuests>() {
            guests.unbind(tab_id);
        }
        events::emit_closed(app, tab_id, &tab.state.owner_window, request_id);
    }
    Ok(())
}

/// Called from the window-event hook when a window is destroyed: its tabs go
/// with it. Errors are ignored — a child webview of a destroyed window is
/// already gone.
pub fn close_all_for_owner(app: &AppHandle, owner_window: &str) {
    if let Some(registry) = app.try_state::<BrowserRegistry>() {
        for tab in registry.remove_by_owner(owner_window) {
            let _ = tab.surface.close();
            if let Some(guests) = app.try_state::<DocGuests>() {
                guests.unbind(&tab.state.tab_id);
            }
        }
    }
}

pub fn set_bounds_core(
    registry: &BrowserRegistry,
    tab_id: &str,
    bounds: Bounds,
) -> Result<(), AppCommandError> {
    let surface = surface_of(registry, tab_id)?;
    let visible = registry
        .update(tab_id, |tab| {
            tab.last_bounds = bounds;
            tab.visible
        })
        .unwrap_or(false);
    // A hidden surface picks the bounds up again when it is shown; moving it
    // while hidden is wasted main-thread work on every split-pane drag.
    if visible && surface.is_embedded() {
        surface
            .set_bounds(bounds)
            .map_err(|e| window_err("Failed to move browser webview", e))?;
    }
    Ok(())
}

/// JPEG quality of the freeze frame: legible text under a dimmed overlay,
/// small enough to ride the IPC without being noticed.
const FREEZE_JPEG_QUALITY: f64 = 0.8;
/// How long a hide may wait for its freeze frame. Longer than this and the
/// overlay would sit under the page for a visible moment; the hide then goes
/// ahead without a frame.
const FREEZE_CAPTURE_TIMEOUT: Duration = Duration::from_millis(250);

/// The frame the surface shows now, for the placeholder to paint while the
/// surface is hidden. `None` whenever it cannot be had in time — a blank
/// placeholder is the state before this existed, never an error.
async fn capture_freeze_frame(surface: &BrowserSurface) -> Option<FrozenFrame> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(Vec<u8>, u32, u32), String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    if let Err(err) = surface.snapshot_jpeg(FREEZE_JPEG_QUALITY, move |result| {
        if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = tx.send(result);
        }
    }) {
        tracing::debug!("[browser] no freeze frame: {err}");
        return None;
    }
    match tokio::time::timeout(FREEZE_CAPTURE_TIMEOUT, rx).await {
        Ok(Ok(Ok((bytes, width, height)))) => Some(FrozenFrame {
            mime: "image/jpeg".to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            width,
            height,
        }),
        Ok(Ok(Err(err))) => {
            tracing::debug!("[browser] freeze frame failed: {err}");
            None
        }
        Ok(Err(_)) | Err(_) => {
            tracing::debug!("[browser] freeze frame did not arrive in time");
            None
        }
    }
}

/// The frame the surface shows right now, leaving its visibility alone.
///
/// Capturing and hiding in one call (`set_visible_core` below, which still
/// does) means the placeholder has nothing to paint until the answer gets
/// back — a blank gap as wide as an IPC round trip, seen as a flash when a
/// menu opens over a page. Taking the frame first lets the caller paint it
/// UNDER the still-visible native view, where it shows nothing, and hide only
/// once it is on screen: the view goes and the still is already there.
pub async fn freeze_frame_core(
    registry: &BrowserRegistry,
    tab_id: &str,
) -> Result<Option<FrozenFrame>, AppCommandError> {
    let surface = surface_of(registry, tab_id)?;
    // An owned window is not painted into a placeholder, so no still of it
    // would ever be shown. A hidden surface has nothing on screen to capture
    // and answers with a blank or a stale frame on some platforms, which is
    // worse than the caller's own fallback.
    if !surface.is_embedded() || registry.update(tab_id, |tab| tab.visible) != Some(true) {
        return Ok(None);
    }
    Ok(capture_freeze_frame(&surface).await)
}

/// Show or hide a surface. Hiding with `freeze` first captures the frame the
/// surface shows and hands it back, so the placeholder can keep showing the
/// page while an overlay is open over it; the capture is asynchronous, and a
/// request that a newer one overtook meanwhile is dropped rather than
/// applied late. Kept as the fallback for callers that could not take a frame
/// up front (`freeze_frame_core`) — a late still beats none.
pub async fn set_visible_core(
    owner: &WebviewWindow,
    registry: &BrowserRegistry,
    tab_id: &str,
    visible: bool,
    handoff_focus: bool,
    freeze: bool,
) -> Result<Option<FrozenFrame>, AppCommandError> {
    // The surface and the request's stamp (its sequence number and the
    // tab's incarnation) are taken in ONE registry operation: taken apart, a
    // close-and-reopen of the same id in between would pair the old surface
    // with the new tab's stamp. Then the tab's lock: requests apply one at a
    // time and in the order they came, and one that a newer request has
    // overtaken while it waited or captured is dropped rather than applied
    // late (the newer one carries the state that stands).
    let (surface, stamp) = registry
        .update(tab_id, |tab| {
            tab.visible_seq += 1;
            (tab.surface.clone(), (tab.visible_seq, tab.generation))
        })
        .ok_or_else(|| AppCommandError::not_found(format!("browser tab {tab_id} not found")))?;
    let lock = registry.visibility_lock(tab_id);
    let _applying = lock.lock().await;
    // Both the sequence and the incarnation: the id may have been closed and
    // reopened while this waited, and the new tab's own counter must not be
    // mistaken for ours.
    let current = || registry.update(tab_id, |tab| (tab.visible_seq, tab.generation));
    if current() != Some(stamp) {
        return Ok(None);
    }
    let mut frame = None;
    if !visible && freeze && surface.is_embedded() {
        frame = capture_freeze_frame(&surface).await;
    }
    // Check and record in one operation, so nothing can come between the
    // last look at the stamp and the state change it guards.
    let Some(Some(bounds)) = registry.update(tab_id, |tab| {
        if (tab.visible_seq, tab.generation) != stamp {
            return None;
        }
        tab.visible = visible;
        Some(tab.last_bounds)
    }) else {
        return Ok(None);
    };
    if visible {
        if surface.is_embedded() {
            surface
                .set_bounds(bounds)
                .map_err(|e| window_err("Failed to move browser webview", e))?;
        }
        surface
            .show()
            .map_err(|e| window_err("Failed to show browser surface", e))?;
    } else {
        // Keyboard focus must not stay inside a hidden native view: the
        // overlay that caused the hide would never receive Esc / Tab.
        if handoff_focus {
            let _ = owner.set_focus();
        }
        surface
            .hide()
            .map_err(|e| window_err("Failed to hide browser surface", e))?;
    }
    Ok(frame)
}

pub fn navigate_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    raw_url: &str,
) -> Result<BrowserTabState, AppCommandError> {
    let asked = parse_web_url(raw_url)?;
    let surface = surface_of(registry, tab_id)?;
    let current = registry.state(tab_id);
    // A document guest shows one file; it is not an address bar.
    if current.as_ref().is_some_and(|state| state.kind == TabKind::Document) {
        return Err(AppCommandError::invalid_input(
            "a document view cannot be navigated to another address",
        ));
    }
    // A remote tab's loopback address, on macOS, by its alias (see
    // `browser::remote`): sent there now rather than refused by the tab's
    // navigation hook and sent there after.
    let url = match current.as_ref().and_then(|state| state.profile.as_deref()) {
        Some(profile_id) => crate::browser::remote::egress_address(profile_id, &asked).into_owned(),
        None => asked.clone(),
    };
    // Refused by a site rule: the block page takes the place of the page,
    // as in a browser, and nothing is loaded. Whatever was loading before
    // is stopped and its watcher retired, or its commit or failure would
    // land on top of the block a moment later.
    if blocked_by_policy(app, &asked) || blocked_by_policy(app, &url) {
        let _ = surface.stop();
        let state = registry
            .update(tab_id, |tab| {
                tab.load_seq += 1;
                tab.provisional_url = None;
                tab.state.requested_url = asked.to_string();
                tab.state.loading = false;
                tab.state.error = Some(blocked_error(&asked));
                tab.state.clone()
            })
            .ok_or_else(|| AppCommandError::not_found(format!("browser tab {tab_id} not found")))?;
        events::emit_state(app, &state);
        return Ok(state);
    }
    let state = registry
        .update_state(tab_id, |state| {
            state.requested_url = url.to_string();
            state.loading = true;
            state.error = None;
        })
        .ok_or_else(|| AppCommandError::not_found(format!("browser tab {tab_id} not found")))?;
    surface
        .navigate(url)
        .map_err(|e| window_err("Failed to navigate browser tab", e))?;
    hooks::begin_load(app, tab_id);
    events::emit_state(app, &state);
    Ok(state)
}

pub fn reload_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
) -> Result<(), AppCommandError> {
    let surface = surface_of(registry, tab_id)?;
    let current = registry
        .state(tab_id)
        .ok_or_else(|| AppCommandError::not_found(format!("browser tab {tab_id} not found")))?;
    // A document guest reloads its one document (its address is not a web
    // address the retry path below would accept).
    if current.kind == TabKind::Document {
        let document_url = app
            .try_state::<DocGuests>()
            .and_then(|guests| guests.for_tab(tab_id))
            .map(|grant| grant.document_url())
            .unwrap_or(current.requested_url);
        return reload_document(app, registry, tab_id, &surface, &document_url);
    }
    // Retry rather than reload when the page showing is not the one asked
    // for: a navigation that failed before committing left nothing to reload
    // (or left an older document, which the error page now covers), and the
    // error page's button means "try that address again".
    let retry = current.error.is_some() || surface.url().is_err();
    if retry && !current.requested_url.is_empty() {
        navigate_core(app, registry, tab_id, &current.requested_url)?;
        return Ok(());
    }
    // A reload asks for the document that is showing; saying so keeps the
    // load watcher's "did the requested page arrive" check honest after an
    // in-page (pushState) navigation moved `url` away from the last request.
    let state = registry.update_state(tab_id, |state| {
        if !state.url.is_empty() {
            state.requested_url = state.url.clone();
        }
        state.loading = true;
        state.error = None;
    });
    surface
        .reload()
        .map_err(|e| window_err("Failed to reload browser tab", e))?;
    hooks::begin_load(app, tab_id);
    if let Some(state) = state {
        events::emit_state(app, &state);
    }
    Ok(())
}

/// Find in page. Returns whether the engine highlighted a match; an empty
/// query is the "close the find bar" case and only clears the highlight.
/// The search itself is WebKit's, so the page can neither see it nor break it.
pub async fn find_core(
    registry: &BrowserRegistry,
    tab_id: &str,
    query: &str,
    forward: bool,
) -> Result<bool, AppCommandError> {
    let surface = surface_of(registry, tab_id)?;
    if query.is_empty() {
        surface
            .clear_find()
            .map_err(|e| window_err("Failed to clear the page search", e))?;
        return Ok(false);
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    surface
        .find(query, forward, move |found| {
            if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = tx.send(found);
            }
        })
        .map_err(|e| window_err("Failed to search the page", e))?;
    // A search that never answers must not hang the caller — but it must not
    // be reported as "no match" either: the engine may still highlight one a
    // moment later, and the bar would be saying the opposite of the screen.
    // An error leaves the bar showing nothing at all.
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(found)) => Ok(found),
        Ok(Err(_)) => Err(window_err("Failed to search the page", "the search was dropped")),
        Err(_) => Err(window_err("Failed to search the page", "WebKit did not answer")),
    }
}

pub fn go_back_core(registry: &BrowserRegistry, tab_id: &str) -> Result<(), AppCommandError> {
    surface_of(registry, tab_id)?
        .go_back()
        .map_err(|e| window_err("Failed to go back", e))
}

pub fn go_forward_core(registry: &BrowserRegistry, tab_id: &str) -> Result<(), AppCommandError> {
    surface_of(registry, tab_id)?
        .go_forward()
        .map_err(|e| window_err("Failed to go forward", e))
}

pub fn stop_core(app: &AppHandle, registry: &BrowserRegistry, tab_id: &str) -> Result<(), AppCommandError> {
    surface_of(registry, tab_id)?
        .stop()
        .map_err(|e| window_err("Failed to stop loading", e))?;
    if let Some(state) = registry.update_state(tab_id, |s| s.loading = false) {
        events::emit_state(app, &state);
    }
    Ok(())
}

/// Whether this tab's page can be inspected, from the one bit the registry
/// keeps about how its surface was BUILT (`BrowserTab::devtools`).
///
/// It has to be answered here rather than by the surface: all three engines
/// take the inspector as a creation-time webview attribute and none of them
/// can be asked afterwards, so `open_devtools` on a surface built without it
/// succeeds and shows nothing. A menu item that silently does nothing is
/// worse than one that says why.
///
/// `None` is "no such tab" — the surface has gone, or never existed.
fn devtools_refusal(built_with: Option<bool>, tab_id: &str) -> Option<AppCommandError> {
    match built_with {
        Some(true) => None,
        Some(false) => Some(
            AppCommandError::invalid_input(
                "this tab was opened with the web inspector switched off; turn it on in the \
                 browser settings and open the page again"
                    .to_string(),
            )
            .with_i18n(BROWSER_I18N_KEY_INSPECTOR_OFF, std::collections::BTreeMap::new()),
        ),
        None => Some(AppCommandError::not_found(format!("browser tab {tab_id} not found"))),
    }
}

/// How often an open inspector is asked whether it is still there. WebKit
/// announces its closing no other way, and a page it was docked into stays
/// where WebKit left it until somebody notices, so the poll is what ends that.
/// One private selector per tick, on the main thread, and only while one is
/// open.
const DEVTOOLS_POLL: Duration = Duration::from_millis(700);

/// Show the web inspector for a tab's page.
///
/// It opens in a window of its own (`shim::macos::prefer_detached_inspector`),
/// so the page keeps its slot and the workspace has nothing to do about it.
/// Watched all the same: somebody who has told WebKit they want the inspector
/// docked gets it docked, and then the page is left filling the host window
/// until `browser://devtools-closed` puts it back.
pub fn open_devtools_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
) -> Result<(), AppCommandError> {
    let surface = devtools_target(registry, tab_id)?;
    let watchable = surface
        .open_devtools()
        .map_err(|e| window_err("Failed to open the web inspector", e))?;
    if watchable {
        watch_devtools(app.clone(), surface, tab_id.to_string());
    }
    Ok(())
}

/// The surface to show an inspector on, or why not. Apart from
/// `open_devtools_core` so that every refusal is reachable from a test —
/// opening one needs an `AppHandle`, and deciding whether to does not.
fn devtools_target(
    registry: &BrowserRegistry,
    tab_id: &str,
) -> Result<BrowserSurface, AppCommandError> {
    if let Some(err) = devtools_refusal(registry.update(tab_id, |tab| tab.devtools), tab_id) {
        return Err(err);
    }
    surface_of(registry, tab_id)
}

/// Say when the inspector on `surface` has gone, once.
///
/// Stops the moment the answer is no — including when the surface has gone
/// with the tab, which answers the same way and needs the same thing done
/// about it. Deliberately UNBOUNDED otherwise: the tab is what bounds it, and
/// a cap would have to either say an inspector that is still up has closed, or
/// stop watching and never say it at all. The handle it holds is an id and an
/// `AppHandle`, not the webview.
///
/// A second open while one is already being watched starts a second watcher;
/// both see the same close, and what the close does — put the page back where
/// the host wants it — is the same done once or twice.
fn watch_devtools(app: AppHandle, surface: BrowserSurface, tab_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(DEVTOOLS_POLL).await;
            // An error is "no inspector to be found", which is the answer that
            // ends this either way.
            if !surface.devtools_visible().unwrap_or(false) {
                tracing::debug!("[browser] tab {tab_id}: the web inspector closed");
                events::emit_devtools_closed(&app, &tab_id);
                return;
            }
        }
    });
}

pub fn state_core(registry: &BrowserRegistry, tab_id: &str) -> Result<BrowserTabState, AppCommandError> {
    registry
        .state(tab_id)
        .ok_or_else(|| AppCommandError::not_found(format!("browser tab {tab_id} not found")))
}

// ---------------------------------------------------------------------------
// Agent access
// ---------------------------------------------------------------------------

/// The error an agent tool turns into `browser_grant_required{tabId}`: this
/// tab has not been shared, or the page it was shared for is gone.
///
/// One error for both, on purpose. To the agent they are the same instruction
/// — ask the user to share this tab — and telling the two apart would report
/// on a page it is not allowed to read.
fn grant_required(tab_id: &str) -> AppCommandError {
    AppCommandError::permission_denied(format!(
        "browser tab {tab_id} has not been shared with agents"
    ))
    .with_i18n(BROWSER_I18N_KEY_GRANT_REQUIRED, std::collections::BTreeMap::new())
}

/// Emitted whenever an agent is refused a page. The frontend turns it into
/// the prompt that offers to share the tab.
pub const BROWSER_I18N_KEY_GRANT_REQUIRED: &str = "browser.agent.error.grantRequired";

/// The tab is shared for reading and an agent asked to act on it. A separate
/// key from `grantRequired` because the person has a different button to
/// press: not "share", but "allow actions" on a tab they already shared.
pub const BROWSER_I18N_KEY_CONTROL_REQUIRED: &str = "browser.agent.error.controlRequired";

/// The ref an action named is from a snapshot the page has moved past. Not a
/// permission matter: the agent takes a new snapshot and carries on.
pub const BROWSER_I18N_KEY_STALE_REF: &str = "browser.agent.error.staleRef";

/// The action was allowed and could not be done: the element is covered,
/// takes no text, has no such option. The message says which.
pub const BROWSER_I18N_KEY_ACTION_FAILED: &str = "browser.agent.error.actionFailed";

/// Not an address a browser tab can hold. An argument mistake, not a
/// permission one — its own key so the tool surface can tell an agent to fix
/// what it sent rather than to ask the user for something.
pub const BROWSER_I18N_KEY_BAD_ADDRESS: &str = "browser.agent.error.badAddress";

/// A site rule or the administrator's policy refuses this host. Nothing the
/// agent or the user can do from where they are standing.
pub const BROWSER_I18N_KEY_BLOCKED: &str = "browser.agent.error.blocked";

/// The workspace was asked for a tab and none arrived.
pub const BROWSER_I18N_KEY_OPEN_FAILED: &str = "browser.agent.error.openFailed";

/// This tab's surface was built without the inspector. Not an agent error —
/// only a person opens one — but it travels the same `AppCommandError` i18n
/// channel, so it is named beside the others.
pub const BROWSER_I18N_KEY_INSPECTOR_OFF: &str = "browser.inspector.error.switchedOff";

fn open_failed(detail: &str) -> AppCommandError {
    AppCommandError::window("Failed to open a browser tab".to_string(), detail.to_string())
        .with_i18n(BROWSER_I18N_KEY_OPEN_FAILED, std::collections::BTreeMap::new())
}

fn control_required(tab_id: &str) -> AppCommandError {
    AppCommandError::permission_denied(format!(
        "browser tab {tab_id} is shared for reading only; acting on it needs the person to \
         allow actions"
    ))
    .with_i18n(BROWSER_I18N_KEY_CONTROL_REQUIRED, std::collections::BTreeMap::new())
}

/// The tab was closed — or closed and reopened under the same id — while a
/// read of it was in flight. Not the tab the read was about, so nothing is
/// handed out and no line is written to the strip of whatever holds the id
/// now; the agent is told to list the tabs again.
fn tab_replaced(tab_id: &str) -> AppCommandError {
    AppCommandError::not_found(format!(
        "browser tab {tab_id} was closed while it was being read"
    ))
}

/// After a read that spanned an `await`: whether the tab is still the one it
/// started on and its grant still covers the page the world reported.
/// Outer `None` — the tab is gone or is another incarnation now; inner
/// `false` — same tab, grant withdrawn or page elsewhere.
fn still_readable(
    registry: &BrowserRegistry,
    tab_id: &str,
    generation: u64,
    walked_origin: Option<&str>,
) -> Option<bool> {
    registry
        .read(tab_id, |tab| {
            (tab.generation == generation).then(|| {
                tab.state.agent_grant.as_ref().is_some_and(|grant| {
                    grant.level.allows(GrantLevel::Read) && grant.covers(walked_origin)
                })
            })
        })
        .flatten()
}

fn stale_ref(detail: &str) -> AppCommandError {
    AppCommandError::invalid_input(detail)
        .with_i18n(BROWSER_I18N_KEY_STALE_REF, std::collections::BTreeMap::new())
}

fn action_failed(error: agent::ActionError, detail: &str) -> AppCommandError {
    let mut params = std::collections::BTreeMap::new();
    if let Some(slug) = serde_json::to_value(error).ok().and_then(|v| v.as_str().map(str::to_string)) {
        params.insert("error".to_string(), slug);
    }
    AppCommandError::invalid_input(detail).with_i18n(BROWSER_I18N_KEY_ACTION_FAILED, params)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Every tab an agent may be told about, oldest id first.
///
/// Not scoped to a window, a folder, or the conversation that asked. A tab
/// does not belong to a conversation, and the backend is not even told which
/// folder one was opened in — `browser_open_tab` takes a `folder_id` and
/// discards it, because grouping tabs is the tab strip's business. One user,
/// one set of tabs; what any given agent may *read* of them is the grant, and
/// that is decided per tab by the person, not by which chat is asking.
pub fn agent_list_tabs_core(registry: &BrowserRegistry) -> Vec<agent::AgentTabSummary> {
    registry.list().iter().filter_map(agent::summarize_tab).collect()
}

/// Share a tab with agents, change the level, or take it back.
///
/// Only ever called for a person: nothing reachable by an agent leads here,
/// which is the entire model (`browser::agent`). The check and the write
/// happen under one lock so a grant cannot be bound to an origin the tab left
/// while the request was in the air.
pub async fn set_agent_grant_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    level: GrantLevel,
) -> Result<BrowserTabState, AppCommandError> {
    // Taken before the lock: asking the operating system who holds a port is
    // tens of milliseconds, and the registry lock is on the path of every
    // tab's events. `apply_grant` drops the answer unless the tab is still
    // showing the address it was taken for.
    let probed = match level {
        GrantLevel::None => None,
        _ => {
            let origin = registry
                .read(tab_id, |tab| {
                    agent::grantable_origin(&tab.state).ok().map(str::to_string)
                })
                .flatten();
            match origin {
                Some(origin) => probe_listener(&origin).await,
                None => None,
            }
        }
    };
    let now = now_millis();
    let applied = registry
        .update(tab_id, |tab| {
            agent::apply_grant(&mut tab.state, level, now, probed)
                .map(|change| (tab.state.clone(), change))
        })
        .ok_or_else(|| AppCommandError::not_found(format!("browser tab {tab_id} not found")))?;
    let (state, change) = applied.map_err(|reason| match reason {
        agent::NotGrantable::NoOrigin => AppCommandError::invalid_input(
            "This tab has no web address to share: an agent's access is tied to one site, \
             and there is nothing here to tie it to.",
        ),
        agent::NotGrantable::DocumentGuest => AppCommandError::invalid_input(
            "A document view cannot be shared with an agent. It is showing a local file, \
             which an agent reads from disk.",
        ),
    })?;
    events::emit_state(app, &state);
    if let Some(change) = change {
        events::emit_agent_grant(
            app,
            tab_id,
            change.change,
            change.level,
            change.origin.as_deref(),
        );
    }
    Ok(state)
}

/// Ask the operating system which program is serving `origin`, off the async
/// runtime. `None` for anything that is not a loopback address this machine
/// can answer about — see [`browser::listener`](crate::browser::listener).
async fn probe_listener(origin: &str) -> Option<agent::ProbedListener> {
    let port = listener::loopback_port(origin)?;
    let origin = origin.to_string();
    // Reading the kernel's socket table — and on macOS running `lsof` — is
    // blocking work with no business on a runtime thread that other tabs'
    // events are queued behind.
    let identity = tokio::task::spawn_blocking(move || listener::identify(port))
        .await
        .ok()??;
    Some(agent::ProbedListener { origin, identity })
}

/// End a grant whose loopback address is being served by a different program
/// than the one it was pinned to.
///
/// The address in the toolbar has not changed, which is exactly why this is
/// worth telling the user about: everything they can see about the tab still
/// looks like what they shared.
///
/// Ends the grant and says nothing else — the refusal that follows is the
/// ordinary one for a tab with no grant, raised by the check that was already
/// there. A second refusal path for this case would be a second place to keep
/// the activity strip's accounting right.
async fn revoke_if_listener_replaced(app: &AppHandle, registry: &BrowserRegistry, tab_id: &str) {
    // Only a pinned grant has anything to check, and reading that costs a
    // lock rather than a process scan — so the common case (a real site, or
    // an unpinned loopback one) never reaches the probe at all.
    let pinned_origin = registry
        .read(tab_id, |tab| {
            tab.state
                .agent_grant
                .as_ref()
                .filter(|grant| grant.listener.is_some())
                .map(|grant| grant.origin.clone())
        })
        .flatten();
    let Some(origin) = pinned_origin else {
        return;
    };
    let Some(probed) = probe_listener(&origin).await else {
        // Nobody is home, or nobody this process can name. There is no second
        // program to point at, and an address nobody serves cannot deliver
        // anything new — a dev server between two restarts is the ordinary
        // shape of this, and ending the sharing for it would be wrong.
        return;
    };
    let lost = registry
        .update(tab_id, |tab| {
            agent::revoke_if_replaced(&mut tab.state, &origin, &probed.identity)
                .map(|lost| (tab.state.clone(), lost))
        })
        .flatten();
    let Some((state, lost)) = lost else {
        return;
    };
    events::emit_state(app, &state);
    events::emit_agent_grant(
        app,
        tab_id,
        agent::GrantChange::Replaced,
        GrantLevel::None,
        Some(&lost.origin),
    );
}

/// Read a shared page, as the tree an agent operates on.
///
/// The grant is checked twice, and the second time is the one that decides.
/// Reading a page is not instantaneous: between the first check and the
/// answer the user can revoke, the tab can be closed and another opened under
/// the same id, and the page can go anywhere. So the tree is handed over only
/// if the grant *as it stands now* still allows reading and still covers the
/// address the world reports having walked — not the address the host last
/// heard about, which is the one that can be out of date.
///
/// That address is `location.href` read inside the isolated world, which the
/// page cannot dress up: `location` is unforgeable, and a page-level
/// redefinition would not be visible from the world in any case.
///
/// Refusing costs an agent a round trip and the instruction to ask again.
/// Not refusing hands it a page nobody shared.
///
/// Every attempt that reaches an existing tab leaves a line on that tab's
/// activity strip, whichever way it goes. The strip is only worth having if
/// it is complete: a user who sees nothing on it has to be able to conclude
/// that nothing happened.
pub async fn agent_snapshot_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    request: &agent::SnapshotRequest,
) -> Result<agent::PageSnapshot, AppCommandError> {
    // The address is still the one that was shared. For a loopback address
    // that settles less than it sounds like — `localhost:3000` is a port
    // number, and the question worth asking is whether the program behind it
    // is still the one the person pointed at. A grant that fails it is gone
    // before the read below looks for one.
    revoke_if_listener_replaced(app, registry, tab_id).await;
    let (outcome, answer) = match read_shared_page(registry, tab_id, request).await {
        Ok(snapshot) => (Some(agent::AgentOutcome::Done), Ok(snapshot)),
        Err((outcome, err)) => (outcome, Err(err)),
    };
    if let Some(outcome) = outcome {
        events::emit_agent_activity(app, tab_id, agent::AgentAction::Read, outcome, now_millis());
    }
    answer
}

/// What a read failed on, and the line it leaves behind. `None` for a tab
/// that does not exist: there is no strip to report into and nobody watching
/// it.
type ReadFailure = (Option<agent::AgentOutcome>, AppCommandError);

async fn read_shared_page(
    registry: &BrowserRegistry,
    tab_id: &str,
    request: &agent::SnapshotRequest,
) -> Result<agent::PageSnapshot, ReadFailure> {
    let Some((surface, generation, epoch, level)) = registry.read(tab_id, |tab| {
        (
            tab.surface.clone(),
            tab.generation,
            agent::epoch(tab.generation, tab.nav_epoch),
            agent::level_of(tab.state.agent_grant.as_ref()),
        )
    }) else {
        return Err((
            None,
            AppCommandError::not_found(format!("browser tab {tab_id} not found")),
        ));
    };
    let failed = |err: AppCommandError| (Some(agent::AgentOutcome::Failed), err);
    // Before touching the page at all: an unshared tab is never read, not
    // even to find out that the read would have been refused.
    if !level.allows(GrantLevel::Read) {
        return Err((Some(agent::AgentOutcome::Refused), grant_required(tab_id)));
    }

    let answer = eval_in_world_string(&surface, &agent::probe_and_snapshot(request, &epoch))
        .await
        .map_err(failed)?;
    // The engine is not in this document — a page that has just loaded, or
    // one loaded before the tab was ever shared. Put it there and take the
    // snapshot in the same evaluation, so the two cannot straddle a
    // navigation.
    let answer = if answer == agent::ENGINE_ABSENT {
        eval_in_world_string(&surface, &agent::install_and_snapshot(request, &epoch))
            .await
            .map_err(failed)?
    } else {
        answer
    };
    let snapshot: agent::PageSnapshot = serde_json::from_str(&answer)
        .map_err(|e| failed(window_err("Failed to read the page", format!("unreadable snapshot: {e}"))))?;

    let walked = Url::parse(&snapshot.url).ok();
    let walked_origin = walked.as_ref().and_then(hooks::origin_of);
    match still_readable(registry, tab_id, generation, walked_origin.as_deref()) {
        Some(true) => Ok(snapshot),
        Some(false) => Err((Some(agent::AgentOutcome::Refused), grant_required(tab_id))),
        None => Err((None, tab_replaced(tab_id))),
    }
}

/// Act on a shared page — click, hover, type, press, select — by the ref a
/// snapshot handed out.
///
/// Gated on [`GrantLevel::Control`], which a person grants separately from
/// reading and can take back on its own. Reading a page cannot change it;
/// acting can, and the two are different decisions for the person to make.
///
/// The checks run before the page is touched, because unlike a read there is
/// nothing to withhold afterwards: a click that happened has happened. So the
/// grant is checked first, then the host's half of the ref's freshness (the
/// epoch it embedded in the snapshot's token), and only then is the world
/// asked — which checks its own half and acts in the same evaluation, so
/// nothing can happen to the page between the two.
///
/// Every attempt on an existing tab leaves a line on that tab's activity
/// strip, under the kind of action it was.
pub async fn agent_act_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    request: &agent::ActionRequest,
) -> Result<agent::ActionOutcome, AppCommandError> {
    revoke_if_listener_replaced(app, registry, tab_id).await;
    let action = agent::AgentAction::from(&request.action);
    let (outcome, answer) = match act_on_shared_page(registry, tab_id, request).await {
        Ok(Settled { outcome, record }) => (
            record.then_some(agent::AgentOutcome::Done),
            Ok(outcome),
        ),
        Err((outcome, err)) => (outcome, Err(err)),
    };
    if let Some(outcome) = outcome {
        events::emit_agent_activity(app, tab_id, action, outcome, now_millis());
    }
    answer
}

/// An action that happened, and whether the tab it happened on is still the
/// tab under that id — if not, there is no strip to write to.
struct Settled {
    outcome: agent::ActionOutcome,
    record: bool,
}

/// Whether an action may still go ahead, read fresh: same tab incarnation,
/// a grant that still allows acting, and a page that has not moved past the
/// snapshot the ref came from.
///
/// Asked more than once on the way to the page, because every `await` between
/// the first answer and the delivery is time in which the person can take the
/// grant back or the page can move. It cannot make the delivery atomic — the
/// registry lock is never held across a main-thread hop — but it makes the
/// window the length of the hop rather than of the whole exchange.
fn still_actionable(
    registry: &BrowserRegistry,
    tab_id: &str,
    generation: u64,
    quoted: &str,
) -> Result<String, ReadFailure> {
    let now = registry.read(tab_id, |tab| {
        (
            tab.generation,
            agent::epoch(tab.generation, tab.nav_epoch),
            agent::level_of(tab.state.agent_grant.as_ref()),
        )
    });
    let Some((generation_now, epoch, level)) = now else {
        return Err((
            None,
            AppCommandError::not_found(format!("browser tab {tab_id} not found")),
        ));
    };
    if generation_now != generation {
        // Another tab under the same id: not the one the ref came from, and
        // not one this attempt is about.
        return Err((
            None,
            AppCommandError::not_found(format!("browser tab {tab_id} not found")),
        ));
    }
    // An unshared tab gets the same answer as for a read: the agent should
    // not learn that it would have been the level, rather than the share,
    // that stopped it.
    if !level.allows(GrantLevel::Read) {
        return Err((Some(agent::AgentOutcome::Refused), grant_required(tab_id)));
    }
    if !level.allows(GrantLevel::Control) {
        return Err((Some(agent::AgentOutcome::Refused), control_required(tab_id)));
    }
    // The host's half of "is this ref from the page as it is now". The world
    // would refuse an old token too, but only from its next snapshot on; the
    // host knows now, and knows about navigations the world cannot see.
    if !agent::ref_is_current(quoted, &epoch) {
        return Err((
            Some(agent::AgentOutcome::Failed),
            stale_ref("the page has navigated since that snapshot; take a new one"),
        ));
    }
    Ok(epoch)
}

async fn act_on_shared_page(
    registry: &BrowserRegistry,
    tab_id: &str,
    request: &agent::ActionRequest,
) -> Result<Settled, ReadFailure> {
    let Some((surface, generation)) =
        registry.read(tab_id, |tab| (tab.surface.clone(), tab.generation))
    else {
        return Err((
            None,
            AppCommandError::not_found(format!("browser tab {tab_id} not found")),
        ));
    };
    let failed = |err: AppCommandError| (Some(agent::AgentOutcome::Failed), err);
    still_actionable(registry, tab_id, generation, &request.generation)?;
    if request.target.is_none() && !matches!(request.action, agent::ActionKind::Press { .. }) {
        return Err(failed(AppCommandError::invalid_input(
            "this action needs the ref of an element from a snapshot",
        )));
    }

    // A real pointer where the platform has one. A failure before anything
    // reached the page falls back to the dispatched kind, and the outcome
    // says which it was; a failure after that is reported as what it is.
    if surface.supports_trusted_input() && request.action.is_pointer() {
        if let Some(target) = request.target.as_deref() {
            if let Some(outcome) =
                deliver_trusted_pointer(registry, tab_id, generation, &surface, target, request)
                    .await?
            {
                return settle(registry, tab_id, generation, outcome);
            }
            // Time has passed on the trusted path; ask again before the
            // dispatched one touches the page.
            still_actionable(registry, tab_id, generation, &request.generation)?;
        }
    }

    let raw = eval_in_world_string(&surface, &agent::act_call(request))
        .await
        .map_err(failed)?;
    if raw == agent::ENGINE_ABSENT {
        // No snapshot was ever taken in this document, so whatever ref the
        // caller holds is from another one.
        return Err(failed(stale_ref(
            "no snapshot has been taken of this page; take one first",
        )));
    }
    let answer: agent::WorldAnswer = serde_json::from_str(&raw).map_err(|e| {
        failed(window_err("Failed to act on the page", format!("unreadable answer: {e}")))
    })?;
    let outcome = accept(answer, agent::Fidelity::Synthetic).map_err(failed)?;
    settle(registry, tab_id, generation, outcome)
}

/// Ask the world where the element is and put a real pointer there.
///
/// `Ok(None)` when the platform delivered nothing — the caller falls back to
/// dispatching. `Err` for what the world itself refused (a stale ref, a
/// covered element), which a fallback would not change, and for a gesture
/// that failed after part of it had reached the page, which a fallback would
/// do twice.
async fn deliver_trusted_pointer(
    registry: &BrowserRegistry,
    tab_id: &str,
    tab_generation: u64,
    surface: &BrowserSurface,
    target: &str,
    request: &agent::ActionRequest,
) -> Result<Option<agent::ActionOutcome>, ReadFailure> {
    let failed = |err: AppCommandError| (Some(agent::AgentOutcome::Failed), err);
    let generation = request.generation.as_str();
    let action = &request.action;
    let raw = eval_in_world_string(surface, &agent::locate_call(generation, target))
        .await
        .map_err(failed)?;
    if raw == agent::ENGINE_ABSENT {
        return Err(failed(stale_ref(
            "no snapshot has been taken of this page; take one first",
        )));
    }
    let answer: agent::WorldAnswer = serde_json::from_str(&raw).map_err(|e| {
        failed(window_err("Failed to act on the page", format!("unreadable answer: {e}")))
    })?;
    let (Some(x), Some(y)) = (answer.x, answer.y) else {
        // Not ok, or ok with no point — the first is a refusal, the second a
        // world this host does not understand; neither is improved by a
        // synthetic retry against the same answer.
        return match accept(answer, agent::Fidelity::Trusted) {
            Ok(_) => Ok(None),
            Err(err) => Err(failed(err)),
        };
    };
    let gesture = match action {
        agent::ActionKind::Click { button, count } => PointerGesture::Click {
            x,
            y,
            button: button.unwrap_or_default(),
            count: count.unwrap_or(1).clamp(1, 3),
        },
        agent::ActionKind::Hover => PointerGesture::Move { x, y },
        _ => return Ok(None),
    };
    // The world's answer is a moment old by now, and the pointer is about to
    // land for real: the grant and the page have to be as they were.
    still_actionable(registry, tab_id, tab_generation, generation)?;
    match dispatch_pointer(surface, gesture).await {
        // A pointer, never a key: nothing on this path scrolls.
        Ok(()) => Ok(Some(agent::ActionOutcome {
            fidelity: agent::Fidelity::Trusted,
            url: answer.url,
            scrolled: None,
        })),
        Err(PointerFailure {
            delivered: false,
            error,
        }) => {
            tracing::warn!("[browser] trusted input not delivered, dispatching instead: {error}");
            Ok(None)
        }
        Err(PointerFailure { error, .. }) => Err(failed(window_err(
            "Failed to act on the page",
            format!("the pointer was delivered only in part: {error}"),
        ))),
    }
}

async fn dispatch_pointer(
    surface: &BrowserSurface,
    gesture: PointerGesture,
) -> Result<(), PointerFailure> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), PointerFailure>>();
    surface
        .dispatch_pointer(gesture, move |result| {
            let _ = tx.send(result);
        })
        .map_err(|e| PointerFailure {
            delivered: false,
            error: e.to_string(),
        })?;
    // Not knowing how far a gesture got is read as it having got somewhere.
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(PointerFailure {
            delivered: true,
            error: "the request was dropped".into(),
        }),
        Err(_) => Err(PointerFailure {
            delivered: true,
            error: "the engine did not answer".into(),
        }),
    }
}

/// The world's answer as the agent's: the outcome, or the refusal it was.
fn accept(
    answer: agent::WorldAnswer,
    fidelity: agent::Fidelity,
) -> Result<agent::ActionOutcome, AppCommandError> {
    if answer.ok {
        return Ok(agent::ActionOutcome {
            fidelity,
            url: answer.url,
            scrolled: answer.scrolled,
        });
    }
    let detail = answer
        .detail
        .unwrap_or_else(|| "the action could not be done".to_string());
    match answer.error {
        Some(agent::ActionError::Stale) | None => Err(stale_ref(&detail)),
        Some(error) => Err(action_failed(error, &detail)),
    }
}

/// After the action. It has happened, so nothing here can withhold it; what
/// is decided is what to tell the agent and the strip.
///
/// The page the world says it acted on is one the grant covers — always, since
/// the world acts only at the address its snapshot was taken at and that
/// address passed the read's check — so that part is a guard on the
/// reasoning, not a decision; if it ever fails, the agent gets the ordinary
/// refusal and the strip a refusal. A grant that was taken back while the
/// action was in the air does not change the answer: the click landed, and
/// saying otherwise would be false in both places. The next attempt is
/// refused.
///
/// A tab that is a different incarnation by now — closed and reopened under
/// the same id while the action was in flight — is not the one anything
/// happened on. The agent still hears what happened; the new tab's strip
/// does not.
fn settle(
    registry: &BrowserRegistry,
    tab_id: &str,
    generation: u64,
    outcome: agent::ActionOutcome,
) -> Result<Settled, ReadFailure> {
    let walked_origin = Url::parse(&outcome.url).ok().as_ref().and_then(hooks::origin_of);
    let (same_tab, elsewhere) = registry
        .read(tab_id, |tab| {
            (
                tab.generation == generation,
                tab.state
                    .agent_grant
                    .as_ref()
                    .is_some_and(|grant| !grant.covers(walked_origin.as_deref())),
            )
        })
        .unwrap_or((false, false));
    if same_tab && elsewhere {
        tracing::warn!(
            "[browser] tab {tab_id}: an action was done at {} which the grant does not cover",
            outcome.url
        );
        return Err((Some(agent::AgentOutcome::Refused), grant_required(tab_id)));
    }
    Ok(Settled {
        outcome,
        record: same_tab,
    })
}

/// Read what a shared page has printed to its console.
///
/// A read, gated like a snapshot (`GrantLevel::Read`) and leaving the same
/// kind of line on the strip. The lines come from the ring the tab keeps
/// (`browser::console`), filtered to those whose origin the grant covers — so
/// a line from an embedded frame on another site, or one that arrived around
/// a navigation, is never handed out — and only while the page on screen is
/// itself one the grant covers, the same condition a snapshot is held to.
pub async fn agent_console_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    query: &ConsoleQuery,
) -> Result<ConsoleReadout, AppCommandError> {
    revoke_if_listener_replaced(app, registry, tab_id).await;
    let (outcome, answer) = match read_console(registry, tab_id, query) {
        Ok(readout) => (Some(agent::AgentOutcome::Done), Ok(readout)),
        Err((outcome, err)) => (outcome, Err(err)),
    };
    if let Some(outcome) = outcome {
        events::emit_agent_activity(app, tab_id, agent::AgentAction::Console, outcome, now_millis());
    }
    answer
}

fn read_console(
    registry: &BrowserRegistry,
    tab_id: &str,
    query: &ConsoleQuery,
) -> Result<ConsoleReadout, ReadFailure> {
    let answer = registry.read(tab_id, |tab| {
        let grant = tab
            .state
            .agent_grant
            .as_ref()
            .filter(|grant| grant.level.allows(GrantLevel::Read))?;
        // The page on screen has to be the one shared, as for a snapshot;
        // then each line is held to the same origin on its own.
        if !grant.covers(tab.state.origin.as_deref()) {
            return None;
        }
        Some(
            tab.console
                .read(query, &tab.state.url, |origin| grant.covers(origin)),
        )
    });
    match answer {
        None => Err((
            None,
            AppCommandError::not_found(format!("browser tab {tab_id} not found")),
        )),
        Some(None) => Err((Some(agent::AgentOutcome::Refused), grant_required(tab_id))),
        Some(Some(readout)) => Ok(readout),
    }
}

/// Take a screenshot of a shared page, or of one element of it.
///
/// A read: gated on `GrantLevel::Read` like a snapshot, checked before the
/// engine draws a pixel and again once the pixels are in hand — a grant
/// taken back while the engine was drawing withholds the image, as the
/// snapshot path withholds the tree. An element's box comes from the world
/// under the same ref rules as an action (`browser_stale_ref` when the page
/// has moved past the snapshot); the capture itself is the platform's
/// viewport image, cropped and scaled here (`browser::capture`).
pub async fn agent_capture_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    request: &CaptureRequest,
) -> Result<CaptureOutcome, AppCommandError> {
    revoke_if_listener_replaced(app, registry, tab_id).await;
    let (outcome, answer) = match capture_shared_page(registry, tab_id, request).await {
        Ok(capture) => (Some(agent::AgentOutcome::Done), Ok(capture)),
        Err((outcome, err)) => (outcome, Err(err)),
    };
    if let Some(outcome) = outcome {
        events::emit_agent_activity(app, tab_id, agent::AgentAction::Capture, outcome, now_millis());
    }
    answer
}

/// How long the engine gets to draw the page for a capture. Longer than the
/// freeze frame's budget, which had an animation to keep up with; a tool call
/// can wait for a heavy page.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// A frame's worth of waiting after the world scrolled an element into view,
/// so the pixels the engine hands over are of the page as it is now.
const SCROLL_SETTLE: Duration = Duration::from_millis(60);

async fn capture_shared_page(
    registry: &BrowserRegistry,
    tab_id: &str,
    request: &CaptureRequest,
) -> Result<CaptureOutcome, ReadFailure> {
    let Some((surface, generation, epoch, level)) = registry.read(tab_id, |tab| {
        (
            tab.surface.clone(),
            tab.generation,
            agent::epoch(tab.generation, tab.nav_epoch),
            agent::level_of(tab.state.agent_grant.as_ref()),
        )
    }) else {
        return Err((
            None,
            AppCommandError::not_found(format!("browser tab {tab_id} not found")),
        ));
    };
    let failed = |err: AppCommandError| (Some(agent::AgentOutcome::Failed), err);
    let capture_err = |detail: String| window_err("Failed to capture the page", detail);
    // Before the page is touched: an unshared tab is not even measured.
    if !level.allows(GrantLevel::Read) {
        return Err((Some(agent::AgentOutcome::Refused), grant_required(tab_id)));
    }

    // What to capture: the element's visible box, or the whole viewport.
    // Either way the world says where the page is, in its own `location`.
    let (url, viewport, region, clipped, scrolled) = match request.clip_target() {
        Some((quoted, target)) => {
            if !agent::ref_is_current(quoted, &epoch) {
                return Err(failed(stale_ref(
                    "the page has navigated since that snapshot; take a new one",
                )));
            }
            let raw = eval_in_world_string(&surface, &agent::rect_call(quoted, target))
                .await
                .map_err(failed)?;
            if raw == agent::ENGINE_ABSENT {
                return Err(failed(stale_ref(
                    "no snapshot has been taken of this page; take one first",
                )));
            }
            let answer: agent::RectAnswer = serde_json::from_str(&raw)
                .map_err(|e| failed(capture_err(format!("unreadable answer: {e}"))))?;
            if !answer.ok {
                let detail = answer
                    .detail
                    .unwrap_or_else(|| "the element could not be captured".to_string());
                return Err(failed(match answer.error {
                    Some(agent::ActionError::Stale) | None => stale_ref(&detail),
                    Some(error) => action_failed(error, &detail),
                }));
            }
            let (Some(x), Some(y), Some(width), Some(height), Some(viewport)) =
                (answer.x, answer.y, answer.width, answer.height, answer.viewport)
            else {
                return Err(failed(capture_err("the page answered with no box".to_string())));
            };
            (
                answer.url,
                viewport,
                CaptureRegion { x, y, width, height },
                true,
                answer.scrolled,
            )
        }
        None => {
            let raw = eval_in_world_string(&surface, agent::viewport_call())
                .await
                .map_err(failed)?;
            let answer: agent::ViewportAnswer = serde_json::from_str(&raw)
                .map_err(|e| failed(capture_err(format!("unreadable answer: {e}"))))?;
            let region = CaptureRegion {
                x: 0.0,
                y: 0.0,
                width: answer.viewport.width,
                height: answer.viewport.height,
            };
            (answer.url, answer.viewport, region, false, false)
        }
    };

    // The page the world reports is one the grant covers, on the same tab —
    // checked before the engine draws a pixel, so a page nobody shared is
    // never rendered for an agent, and again below with the pixels in hand.
    // A tab that is another incarnation by then is not the one this was
    // about: nothing is handed out, and nothing is written to its strip.
    let walked_origin = Url::parse(&url).ok().as_ref().and_then(hooks::origin_of);
    let admit = || match still_readable(registry, tab_id, generation, walked_origin.as_deref()) {
        Some(true) => Ok(()),
        Some(false) => Err((Some(agent::AgentOutcome::Refused), grant_required(tab_id))),
        None => Err((None, tab_replaced(tab_id))),
    };
    admit()?;
    if scrolled {
        tokio::time::sleep(SCROLL_SETTLE).await;
    }
    let capture = draw_capture(
        &surface,
        viewport.width,
        region,
        clipped,
        capture::effective_max_width(request.max_width),
        request.format,
        url,
    )
    .await
    .map_err(failed)?;
    admit()?;
    Ok(capture)
}

/// Ask the engine for the viewport, crop it to `region` and encode it.
///
/// `css_width` is the viewport's width in CSS pixels at that moment: the ratio
/// of the image's width to it is how many pixels the engine drew per CSS
/// pixel, which is what turns a clip into pixel coordinates without asking any
/// platform about zoom or device scale.
async fn draw_capture(
    surface: &BrowserSurface,
    css_width: f64,
    region: CaptureRegion,
    clipped: bool,
    max_width: u32,
    format: capture::CaptureFormat,
    url: String,
) -> Result<CaptureOutcome, AppCommandError> {
    let capture_err = |detail: String| window_err("Failed to capture the page", detail);
    let encoded = capture_viewport(surface).await?;
    let clip = clipped.then_some(region);
    // Decoding and re-encoding a screenshot is real work; off the runtime.
    let fitted = tokio::task::spawn_blocking(move || {
        capture::fit(&encoded, css_width, clip, max_width, format)
    })
    .await
    .map_err(|e| capture_err(e.to_string()))?
    .map_err(capture_err)?;
    Ok(CaptureOutcome {
        mime: format.mime().to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(fitted.bytes),
        width: fitted.width,
        height: fitted.height,
        url,
        region,
        clipped,
    })
}

/// The viewport as the engine encodes it, within [`CAPTURE_TIMEOUT`].
async fn capture_viewport(surface: &BrowserSurface) -> Result<Vec<u8>, AppCommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    surface
        .snapshot_png(move |result| {
            if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = tx.send(result);
            }
        })
        .map_err(|e| window_err("Failed to capture the page", e))?;
    match tokio::time::timeout(CAPTURE_TIMEOUT, rx).await {
        Ok(Ok(Ok(bytes))) => Ok(bytes),
        Ok(Ok(Err(err))) => Err(window_err("Failed to capture the page", err)),
        Ok(Err(_)) => Err(window_err("Failed to capture the page", "the request was dropped")),
        Err(_) => Err(window_err(
            "Failed to capture the page",
            "the engine did not draw the page in time",
        )),
    }
}

// ---- running the agent's own code ----------------------------------------

/// The person said no to this snippet, or said nothing.
pub const BROWSER_I18N_KEY_EVAL_DECLINED: &str = "browser.agent.error.evalDeclined";

/// Another snippet is in front of the person, or this tab is in the quiet
/// period a refusal buys.
pub const BROWSER_I18N_KEY_EVAL_BUSY: &str = "browser.agent.error.evalBusy";

/// How long the engine gets to run a snippet and hand back its render.
///
/// A snippet that loops forever has hung the page's main thread, and no
/// timeout here can un-hang it — what this bounds is how long the agent waits
/// to be told so. Longer than a capture, because the person already spent
/// their attention approving it and a slow answer is better than none.
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Run an agent's own code on a shared page, once a person has said yes to
/// that particular snippet.
///
/// The order of the gates is the whole design:
///
/// 1. the `browser_eval` switch, then the grant — both read from the registry,
///    so a tab nobody shared never raises a dialog and an agent cannot use the
///    confirmation itself as a way to get someone's attention;
/// 2. where the page actually is, read in codeg's own world, held against the
///    grant — so the origin named in the dialog is the live one, not the last
///    one the host happened to hear about;
/// 3. the person;
/// 4. **the same checks again**, because a dialog can stand for two minutes
///    and a grant can be taken back or a page navigate in far less;
/// 5. the code, in the page's world;
/// 6. where the page is now, again — the snippet may well have moved it, and
///    what it produced is page content, so it is handed over only if the grant
///    still covers where it came from.
///
/// Step 4 does not make step 5 atomic, and cannot: the registry lock is never
/// held across a main-thread hop. What it does is make the window one hop
/// long rather than as long as the person took to read — the same bound
/// `still_actionable` settles for, and recorded here for the same reason.
///
/// Every attempt that reaches an existing tab leaves a line on that tab's
/// activity strip, as every other agent touch does.
pub async fn agent_eval_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    consent: &EvalConsent,
    tab_id: &str,
    request: &EvalRequest,
) -> Result<EvalOutcome, AppCommandError> {
    revoke_if_listener_replaced(app, registry, tab_id).await;
    let (outcome, answer) = match eval_on_shared_page(app, registry, consent, tab_id, request).await
    {
        Ok(Evaluated { outcome, record }) => (record.then_some(agent::AgentOutcome::Done), Ok(outcome)),
        Err((outcome, err)) => (outcome, Err(err)),
    };
    if let Some(outcome) = outcome {
        events::emit_agent_activity(app, tab_id, agent::AgentAction::Eval, outcome, now_millis());
    }
    answer
}

/// A snippet that ran, and whether the tab it ran on is still the tab under
/// that id.
struct Evaluated {
    outcome: EvalOutcome,
    record: bool,
}

fn eval_declined(tab_id: &str) -> AppCommandError {
    AppCommandError::permission_denied(format!(
        "the user did not approve running that code on browser tab {tab_id}"
    ))
    .with_i18n(BROWSER_I18N_KEY_EVAL_DECLINED, std::collections::BTreeMap::new())
}

fn eval_busy(tab_id: &str, refused: AskRefused) -> AppCommandError {
    let detail = match refused {
        AskRefused::Busy => format!(
            "another snippet is already waiting for the user's answer; try browser tab {tab_id} \
             again in a moment"
        ),
        AskRefused::CoolingDown => format!(
            "the user refused a snippet on browser tab {tab_id} a moment ago; that tab is not \
             asking again just yet"
        ),
    };
    AppCommandError::permission_denied(detail)
        .with_i18n(BROWSER_I18N_KEY_EVAL_BUSY, std::collections::BTreeMap::new())
}

/// Where the page is, as codeg's own world reports it, held against the tab's
/// grant and incarnation. Answers the page's address and **the origin of the
/// grant that admitted it**.
///
/// The address has to come from here and not from the snippet's answer: the
/// snippet is inlined source text and can return whatever object it likes,
/// including one that claims to be at the origin the grant covers. This
/// evaluation contains no agent text at all.
///
/// The grant's origin comes back with it, out of the same lock acquisition
/// that admitted the address, because that pair is what the dialog puts in
/// front of the person. Reading the grant separately would leave a window —
/// narrow, but real — in which the page moves and the person is re-granted for
/// where it went, and the dialog then names the site they left.
///
/// `required` is the level the caller needs *at this point*: `Control` for the
/// two calls that stand between the agent and the page, `Read` for the one
/// that decides whether a value already produced is handed over. The
/// distinction matters because this is the LAST gate before the snippet runs,
/// and a gate that only asked for `Read` would let a tab downgraded to
/// read-only in the moment before execution still be executed on. Same rule
/// as `still_actionable`, for the same reason.
async fn eval_page_address(
    registry: &BrowserRegistry,
    surface: &BrowserSurface,
    tab_id: &str,
    generation: u64,
    required: GrantLevel,
) -> Result<(String, String), ReadFailure> {
    let failed = |err: AppCommandError| (Some(agent::AgentOutcome::Failed), err);
    let raw = eval_in_world_string(surface, agent::viewport_call())
        .await
        .map_err(failed)?;
    let answer: agent::ViewportAnswer = serde_json::from_str(&raw).map_err(|e| {
        failed(window_err(
            "Failed to read the page",
            format!("unreadable answer: {e}"),
        ))
    })?;
    let walked_origin = Url::parse(&answer.url).ok().as_ref().and_then(hooks::origin_of);
    // One lock acquisition for all of it — incarnation, level and origin — and
    // it is the last thing that happens before the caller acts. Nothing may be
    // awaited between here and the page.
    let admitted = registry.read(tab_id, |tab| {
        (tab.generation == generation).then(|| {
            let level = agent::level_of(tab.state.agent_grant.as_ref());
            if !level.allows(GrantLevel::Read) {
                return Err(grant_required(tab_id));
            }
            if !level.allows(required) {
                return Err(control_required(tab_id));
            }
            match tab.state.agent_grant.as_ref() {
                Some(grant) if grant.covers(walked_origin.as_deref()) => Ok(grant.origin.clone()),
                // The page is somewhere the grant does not reach. The same
                // words an unshared tab gets: which of the two it was is not
                // the agent's to know.
                _ => Err(grant_required(tab_id)),
            }
        })
    });
    match admitted {
        Some(Some(Ok(origin))) => Ok((answer.url, origin)),
        Some(Some(Err(err))) => Err((Some(agent::AgentOutcome::Refused), err)),
        Some(None) | None => Err((None, tab_replaced(tab_id))),
    }
}

async fn eval_on_shared_page(
    app: &AppHandle,
    registry: &BrowserRegistry,
    consent: &EvalConsent,
    tab_id: &str,
    request: &EvalRequest,
) -> Result<Evaluated, ReadFailure> {
    let failed = |err: AppCommandError| (Some(agent::AgentOutcome::Failed), err);
    if let Err(bad) = eval::validate_code(&request.code) {
        return Err(failed(AppCommandError::invalid_input(bad.message())));
    }
    let Some((surface, generation, owner_window, level, title)) = registry.read(tab_id, |tab| {
        (
            tab.surface.clone(),
            tab.generation,
            tab.state.owner_window.clone(),
            agent::level_of(tab.state.agent_grant.as_ref()),
            tab.state.title.clone(),
        )
    }) else {
        return Err((
            None,
            AppCommandError::not_found(format!("browser tab {tab_id} not found")),
        ));
    };
    // Before anything is shown to anyone: an unshared tab, or one shared for
    // reading only, is refused without a dialog. An agent must not be able to
    // make a dialog appear on a page nobody gave it.
    if !level.allows(GrantLevel::Read) {
        return Err((Some(agent::AgentOutcome::Refused), grant_required(tab_id)));
    }
    if !level.allows(GrantLevel::Control) {
        return Err((Some(agent::AgentOutcome::Refused), control_required(tab_id)));
    }

    // Where the page is now, from codeg's world, held against the grant — and
    // the origin of the grant that admitted it, which is what the dialog will
    // name.
    let (_, asked_origin) =
        eval_page_address(registry, &surface, tab_id, generation, GrantLevel::Control).await?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let rx = consent
        .arm(tab_id, request_id.clone())
        .map_err(|refused| (Some(agent::AgentOutcome::Refused), eval_busy(tab_id, refused)))?;
    events::emit_eval_request(
        app,
        &EvalRequestPayload {
            request_id: request_id.clone(),
            tab_id: tab_id.to_string(),
            owner_window,
            origin: asked_origin,
            title,
            code: request.code.clone(),
            expires_at: now_millis() + EVAL_CONFIRM_TIMEOUT.as_millis() as i64,
        },
    );
    let allowed = match tokio::time::timeout(EVAL_CONFIRM_TIMEOUT, rx).await {
        Ok(Ok(allowed)) => allowed,
        // A dropped sender is the slot having been taken from under this
        // question, and a timeout is nobody there. Both are "no".
        Ok(Err(_)) => false,
        Err(_) => {
            consent.abandon(&request_id);
            false
        }
    };
    if !allowed {
        return Err((Some(agent::AgentOutcome::Refused), eval_declined(tab_id)));
    }

    // The dialog stood for as long as a person took. Everything checked before
    // it was shown is checked again, against the tab as it is now — including
    // who is behind the address, which the other tools probe once and are done
    // with in milliseconds. Here the gap is human-scale, and a program taking
    // over a loopback port is itself a human-scale event: `localhost:3000`
    // reads the same in the dialog whichever server is answering it, so the
    // pin has to be re-checked on this side of the question.
    revoke_if_listener_replaced(app, registry, tab_id).await;
    // Asking for `Control` here, not `Read`, and asking for it LAST: this is
    // the gate the snippet has to get past, and nothing is awaited between it
    // and the page.
    eval_page_address(registry, &surface, tab_id, generation, GrantLevel::Control).await?;

    let raw = run_in_page(&surface, &eval::eval_call(&request.code))
        .await
        .map_err(failed)?;
    let answer = read_eval_answer(&raw).map_err(failed)?;

    // The code has run; what is still to be decided is whether its result is
    // handed over. It is page content, so it follows the rules a read does —
    // and a snippet that navigated the page away from the shared site has
    // produced something from a page nobody shared.
    // `Read` is enough now: the code has run, and what is left to decide is
    // whether its answer — page content — may be handed over. A person who
    // pulled the tab back to read-only while it ran has not said the page
    // became unreadable.
    let url = match eval_page_address(registry, &surface, tab_id, generation, GrantLevel::Read)
        .await
    {
        Ok((url, _)) => url,
        Err((outcome, err)) => {
            tracing::warn!(
                "[browser] tab {tab_id}: a snippet ran and its result was withheld: {}",
                err.message
            );
            return Err((outcome, err));
        }
    };
    let record = registry
        .read(tab_id, |tab| tab.generation == generation)
        .unwrap_or(false);
    Ok(Evaluated {
        outcome: EvalOutcome::from_answer(&answer, url),
        record,
    })
}

/// Parse what the page handed back through `eval_with_callback`.
///
/// Two layers, because the engines JSON-encode whatever the expression
/// produced: the outer layer is that encoding (a JSON string, since the
/// wrapper returns one), the inner layer is the envelope the renderer built.
/// An empty answer is what all three engines give for an evaluation the engine
/// itself refused — overwhelmingly a snippet that did not parse, since it is
/// inlined into the source text rather than passed to `eval`, which a page's
/// CSP may forbid.
fn read_eval_answer(raw: &str) -> Result<EvalAnswer, AppCommandError> {
    let eval_err = |detail: &str| window_err("Failed to run the code", detail);
    if raw.trim().is_empty() || raw.trim() == "null" {
        return Err(eval_err(
            "the page's engine did not run it. The most likely reason is that the code does not \
             parse — check for an unbalanced brace or an unterminated comment; the snippet is \
             used as the body of a function.",
        ));
    }
    if raw.len() > eval::MAX_EVAL_ANSWER_BYTES {
        return Err(eval_err(
            "the page answered with more than the host will read. The code ran; use `return` to \
             hand back a summary rather than a whole document.",
        ));
    }
    // The snippet can break out of the wrapper it was inlined into, in which
    // case whatever it left behind is what arrives here. That is the caller's
    // own doing and costs nothing but this message.
    let inner: String = serde_json::from_str(raw).map_err(|_| {
        eval_err(
            "the code ran and did not answer with a value this can read. Make sure the snippet \
             `return`s something and leaves the surrounding function intact.",
        )
    })?;
    serde_json::from_str(&inner).map_err(|e| eval_err(&format!("unreadable answer: {e}")))
}

/// Evaluate an expression in the page's own world, within [`EVAL_TIMEOUT`].
///
/// Deliberately not `eval_in_world`: everything else in this module evaluates
/// in codeg's isolated world, and an agent's own code is the one thing that
/// must never run there — see `browser::eval`.
async fn run_in_page(surface: &BrowserSurface, js: &str) -> Result<String, AppCommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    surface
        .eval_with_callback(js, move |value| {
            if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = tx.send(value);
            }
        })
        .map_err(|e| window_err("Failed to run the code", e.to_string()))?;
    match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err(window_err("Failed to run the code", "the request was dropped")),
        Err(_) => Err(window_err(
            "Failed to run the code",
            "the page did not answer in time. It may still be running: code that loops holds the \
             page's own main thread, which nothing here can take back.",
        )),
    }
}

// ---- the tabs themselves -------------------------------------------------
//
// Opening, pointing elsewhere, closing. Everything above this line is about a
// page that already exists; these three decide which pages exist at all.
//
// They are part of the browser tool group rather than a switch of their own:
// the group already says "an agent may see and drive the built-in browser",
// and a person who has said that has said this. What that means in practice is
// worth being plain about, and the group's own copy says it: with the standing
// sharing default in force, a tab an agent opens is shared with it the moment
// the page commits — so this group hands an agent the browser, not a view of
// the pages the person happened to have open.

/// Whether a tab is showing something worth protecting.
///
/// `browser_navigate` and `browser_close_tab` need the tab shared at
/// [`GrantLevel::Control`] — the same bar as clicking a link on it, which is
/// the same act by another name. This is the one exception: a tab with no
/// document in it is not a page anybody shared, has no content to lose and no
/// half-typed form to throw away.
///
/// Without it, an agent that opens `http://localhost:3000` against a server
/// that is not up gets an error page — which has no origin, so it can never
/// carry a grant — and is left with a tab it can neither retry nor close.
///
/// The test is `state.url`, which is written when a document commits, and not
/// `loading`: a shared page navigating somewhere is still on screen until the
/// new document commits, and must not fall through this hole mid-flight.
fn shows_no_document(state: &BrowserTabState) -> bool {
    // `about:blank` is what the "+" menu's empty tab holds, and the page every
    // tab boots from (`policy::open_url_allowed`). Either way there is nothing
    // on it.
    state.error.is_some() || state.url.is_empty() || state.url == "about:blank"
}

/// The grant check the two tab-driving tools share, read fresh.
///
/// Returns the tab's generation, so the caller can tell a tab that was closed
/// and reopened under the same id from the one it checked.
fn may_drive_tab(registry: &BrowserRegistry, tab_id: &str) -> Result<u64, ReadFailure> {
    let Some((generation, level, blank, kind)) = registry.read(tab_id, |tab| {
        (
            tab.generation,
            agent::level_of(tab.state.agent_grant.as_ref()),
            shows_no_document(&tab.state),
            tab.state.kind,
        )
    }) else {
        return Err((
            None,
            AppCommandError::not_found(format!("browser tab {tab_id} not found")),
        ));
    };
    if kind == TabKind::Document {
        // A document guest is never listed to an agent in the first place
        // (`agent::summarize_tab`), so this is only reachable by guessing an
        // id. Same answer as for an id that does not exist: nothing is
        // confirmed about what the person has open.
        return Err((
            None,
            AppCommandError::not_found(format!("browser tab {tab_id} not found")),
        ));
    }
    if blank || level.allows(GrantLevel::Control) {
        return Ok(generation);
    }
    // Shared for reading, or not shared at all — the two are told apart the
    // same way the action tools tell them apart, and no other way: the refusal
    // for an unshared tab must not reveal that it exists at a lower level.
    Err((
        Some(agent::AgentOutcome::Refused),
        if level.allows(GrantLevel::Read) {
            control_required(tab_id)
        } else {
            grant_required(tab_id)
        },
    ))
}

/// A tab that has stopped moving: what an agent may know about it, and — when
/// the address it was sent to did not load — which way it failed.
struct SettledTab {
    summary: agent::AgentTabSummary,
    /// `dns` / `tls` / `blocked` / `failed`, from the error page the tab is
    /// showing instead of the address.
    load_error: Option<String>,
}

impl SettledTab {
    fn of(state: &BrowserTabState) -> Option<Self> {
        Some(Self {
            summary: agent::summarize_tab(state)?,
            load_error: state.error.as_ref().and_then(|e| {
                serde_json::to_value(e.kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
            }),
        })
    }
}

/// Wait for a tab to hold a settled page, and answer with it.
///
/// "Settled" is three things in sequence, each with its own reason:
///
/// 1. The tab is in the registry. After an open it is not there yet — the
///    frontend has been asked and has to build the surface.
/// 2. A document has committed, or the load has failed. Until then the tab
///    has no address and no title, and an answer about it says nothing.
/// 3. A sharing level has appeared, or [`open_request::GRANT_GRACE`] has
///    passed. The standing default is applied by the frontend when it sees
///    the commit, so for one round trip after step 2 every tab looks unshared
///    — and an agent told "nobody shared this" would relay that to the user
///    about a page that is already shared with it.
///
/// Every wait is capped. A page that is still loading when the cap expires is
/// answered as the tab it is; the agent reads it whenever it likes.
async fn wait_for_settled_tab(
    registry: &BrowserRegistry,
    tab_id: &str,
    generation: Option<u64>,
    deadline: std::time::Instant,
) -> Option<SettledTab> {
    let mut committed_at: Option<std::time::Instant> = None;
    loop {
        let now = std::time::Instant::now();
        let seen = registry.read(tab_id, |tab| {
            (
                tab.generation,
                tab.state.clone(),
                tab.state.agent_grant.is_some(),
            )
        });
        // A different incarnation of the id is not the tab this call is about
        // — it is treated as "not here yet", which is what it is. An open
        // waits for any incarnation and passes `None`.
        match seen.filter(|(seen, _, _)| generation.is_none_or(|wanted| wanted == *seen)) {
            Some((_, state, shared)) => {
                if !state.loading || state.error.is_some() {
                    let since = *committed_at.get_or_insert(now);
                    if shared || now.duration_since(since) >= open_request::GRANT_GRACE {
                        return SettledTab::of(&state);
                    }
                } else {
                    // Off again: a page that started loading after committing
                    // has not settled, and the grace period restarts with it.
                    committed_at = None;
                }
                if now >= deadline {
                    return SettledTab::of(&state);
                }
            }
            // The deadline has to be checked on this branch too. A tab that
            // is gone, or is another incarnation by now, would otherwise keep
            // this loop running for as long as the process does.
            None if now >= deadline => return None,
            None => {}
        }
        tokio::time::sleep(open_request::POLL_INTERVAL).await;
    }
}

/// Parse and vet an address an agent named, before anything is built for it,
/// and stamp the refusal with the key the tool surface branches on.
///
/// `open_tab_core` would give a blocked address its tab and show the block
/// page in it, which is right for a person following a link — the block page
/// is where they learn why. An agent asked a question and gets an answer; a
/// tab it cannot use is litter on someone else's screen.
fn address_refusal(app: &AppHandle, raw: &str) -> Result<Url, AppCommandError> {
    let url = parse_web_url(raw).map_err(|e| {
        AppCommandError::invalid_input(e.message)
            .with_i18n(BROWSER_I18N_KEY_BAD_ADDRESS, std::collections::BTreeMap::new())
    })?;
    if blocked_by_policy(app, &url) {
        return Err(AppCommandError::permission_denied(format!(
            "{url} is refused by a site rule"
        ))
        .with_i18n(BROWSER_I18N_KEY_BLOCKED, std::collections::BTreeMap::new()));
    }
    Ok(url)
}

/// Open a tab on `url` and answer with the tab once it holds a page.
///
/// The tab is opened by the workspace, not here: see
/// [`crate::browser::open_request`] for why a backend-built tab would be an
/// orphan. It is opened in the foreground, which is not a courtesy — a tab
/// nobody has looked at has no native surface, so a background one would not
/// exist as far as every other tool on this surface is concerned. The person
/// seeing it appear is the happy side effect.
pub async fn agent_open_tab_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    requests: &open_request::OpenRequests,
    raw_url: &str,
) -> Result<(agent::AgentTabSummary, Option<String>), AppCommandError> {
    let url = address_refusal(app, raw_url)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let answer = requests.arm(&request_id);
    events::emit_open_request(
        app,
        &BrowserOpenRequestPayload {
            url: url.to_string(),
            source: "agent".to_string(),
            activate: true,
            owner_window: None,
            opener_tab_id: None,
            profile: None,
            request_id: Some(request_id.clone()),
        },
    );
    let answered = tokio::time::timeout(open_request::ANSWER_TIMEOUT, answer).await;
    // Whatever happened, this request is over: a late answer names a tab
    // nobody is waiting to hear about.
    requests.abandon(&request_id);
    let tab_id = match answered {
        Ok(Ok(Some(tab_id))) => tab_id,
        Ok(Ok(None)) => {
            return Err(open_failed(
                "the workspace could not open a tab for that address",
            ))
        }
        Ok(Err(_)) | Err(_) => {
            return Err(open_failed(
                "no codeg workspace window answered. There has to be one open to put a tab in",
            ))
        }
    };
    let deadline = std::time::Instant::now() + open_request::SETTLE_TIMEOUT;
    let Some(settled) = wait_for_settled_tab(registry, &tab_id, None, deadline).await else {
        return Err(open_failed(
            "the tab was opened and then went away before it loaded anything",
        ));
    };
    // The first line on the new tab's strip, and the one thing about a page a
    // person cannot work out by looking at it: this one is here because an
    // agent asked for it.
    events::emit_agent_activity(
        app,
        &tab_id,
        agent::AgentAction::Open,
        agent::AgentOutcome::Done,
        now_millis(),
    );
    Ok((settled.summary, settled.load_error))
}

/// Point an existing tab at another address.
///
/// The same act as clicking a link on the page, and gated the same way. The
/// answer is the tab once the new page has settled, so the level it reports is
/// the one that applies where the tab has landed — a navigation across origins
/// ends the old grant, and whatever replaces it is what the agent gets.
pub async fn agent_navigate_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    raw_url: &str,
) -> Result<(agent::AgentTabSummary, Option<String>), AppCommandError> {
    revoke_if_listener_replaced(app, registry, tab_id).await;
    let (outcome, answer) = match drive_tab_to(app, registry, tab_id, raw_url).await {
        Ok(settled) => (
            Some(agent::AgentOutcome::Done),
            Ok((settled.summary, settled.load_error)),
        ),
        Err((outcome, err)) => (outcome, Err(err)),
    };
    if let Some(outcome) = outcome {
        events::emit_agent_activity(
            app,
            tab_id,
            agent::AgentAction::Navigate,
            outcome,
            now_millis(),
        );
    }
    answer
}

async fn drive_tab_to(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
    raw_url: &str,
) -> Result<SettledTab, ReadFailure> {
    // The grant first, then the address. An address is refused for reasons
    // that have nothing to do with this tab (a site rule, a scheme), and
    // answering those before the permission check would let an agent with no
    // standing on any tab read the user's site rules one address at a time.
    let generation = may_drive_tab(registry, tab_id)?;
    let url = address_refusal(app, raw_url).map_err(|e| (Some(agent::AgentOutcome::Failed), e))?;
    navigate_core(app, registry, tab_id, url.as_str())
        .map_err(|e| (Some(agent::AgentOutcome::Failed), e))?;
    let deadline = std::time::Instant::now() + open_request::SETTLE_TIMEOUT;
    wait_for_settled_tab(registry, tab_id, Some(generation), deadline)
        .await
        .ok_or_else(|| (None, tab_replaced(tab_id)))
}

/// Close a tab.
///
/// Gated like a navigation, and for the same reason: a tab that goes away
/// takes whatever was in it with it. The strip records only the refusals — a
/// tab that was closed has no strip left to read, and writing a line to it
/// would bring the state of a dead tab back.
pub async fn agent_close_tab_core(
    app: &AppHandle,
    registry: &BrowserRegistry,
    tab_id: &str,
) -> Result<(), AppCommandError> {
    if let Err((outcome, err)) = may_drive_tab(registry, tab_id) {
        if let Some(outcome) = outcome {
            events::emit_agent_activity(
                app,
                tab_id,
                agent::AgentAction::Close,
                outcome,
                now_millis(),
            );
        }
        return Err(err);
    }
    close_core(app, registry, tab_id, None)
}

// ---- page → conversation -------------------------------------------------
//
// The other direction from the `agent_*` reads above, and the reason none of
// this is gated: nothing here happens unless a person does it, and what comes
// out lands in their composer, where they read it, edit it and decide whether
// to send it. The activity strip is not written either — it records what an
// agent did to a tab while nobody was looking, and this is the opposite of
// that. What a person hands over is still page content, so `browser::handoff`
// caps it and labels it as data rather than instruction.

/// How long a pick stays armed with nobody choosing anything. Long enough to
/// scroll a page and think; short enough that a forgotten pick does not keep a
/// highlight on a page for the rest of the session.
const PICK_TIMEOUT: Duration = Duration::from_secs(180);

/// Let a person point at an element of a page and hand it to a conversation.
///
/// Arms the picker in the tab's isolated world and waits for one answer. It
/// ends as "called off" — never as an error — when the person presses Escape,
/// starts another pick, navigates, closes the tab, or simply walks away for
/// [`PICK_TIMEOUT`]: none of those is a failure, and the caller's next move is
/// the same for all of them.
pub async fn pick_element_core(
    registry: &BrowserRegistry,
    tab_id: &str,
) -> Result<handoff::PageHandoff, AppCommandError> {
    let Some((surface, generation, profile)) = registry.read(tab_id, |tab| {
        (tab.surface.clone(), tab.generation, tab.state.profile.clone())
    }) else {
        return Err(AppCommandError::not_found(format!(
            "browser tab {tab_id} not found"
        )));
    };
    // Which pick this is. The registry mints the token and parks the waiter
    // under one lock, and refuses if the id now names a later incarnation of
    // the tab than the surface taken above — otherwise the picker would go
    // into the old page while the waiter sat on the new tab. A report quoting
    // any other token is from a pick already abandoned and is dropped where
    // it arrives.
    let Some((token, wait)) = registry.arm_pick(tab_id, generation) else {
        return Err(AppCommandError::not_found(format!(
            "browser tab {tab_id} not found"
        )));
    };
    // Armed before the page is told, so a very fast pick cannot arrive before
    // there is anywhere to put it. The picker is already in the document on
    // every pick after the first, so ask before shipping twenty kilobytes of
    // it again — the same two-step the agent bundle uses. Those two steps can
    // straddle a navigation, leaving a picker armed in a document nobody is
    // waiting on; `stop_picking` puts an orphan like that away, which is what
    // its `Empty` case is for.
    if let Err(err) = arm_picker(&surface, &token).await {
        stop_picking(registry, tab_id, Some(&token)).await;
        return Err(err);
    }
    let mut picked = match tokio::time::timeout(PICK_TIMEOUT, wait).await {
        Ok(Ok(handoff::PickReport::Picked(element))) => element,
        // Cancelled by the person, or the slot went away under us: a new
        // document, a second pick, the tab closing. Either way there is
        // nothing to hand over. Only THIS pick is put away — a second pick
        // wakes the first one here, and taking the page's picker down then
        // would cancel the pick that replaced it.
        Ok(Ok(handoff::PickReport::Cancelled { .. })) | Ok(Err(_)) | Err(_) => {
            stop_picking(registry, tab_id, Some(&token)).await;
            return Ok(handoff::PageHandoff::cancelled());
        }
    };
    // Everything below says where the page is — the block, the link, the
    // picture — and says it as the agent's host knows it (a remote tab).
    picked.href = crate::browser::remote::host_address(profile.as_deref(), &picked.href).into_owned();
    let text = handoff::render_element(&picked);
    let (url, _) = handoff::redact_url(&picked.href);
    // A picture of the element, when it has a box on screen and the page said
    // how wide its viewport is. Best effort: an element worth describing is
    // still worth handing over when the engine cannot draw it.
    let image = match (picked.clip(), picked.viewport) {
        (Some(clip), Some(viewport)) => draw_capture(
            &surface,
            viewport.width,
            clip,
            true,
            capture::effective_max_width(None),
            capture::CaptureFormat::Png,
            url.clone(),
        )
        .await
        .map_err(|err| {
            tracing::warn!("[browser] tab {tab_id}: could not picture the picked element: {err:?}");
        })
        .ok(),
        _ => None,
    };
    Ok(handoff::PageHandoff {
        cancelled: false,
        label: picked.label.clone(),
        text,
        url,
        image,
        count: 0,
    })
}

/// Arm the picker in a page, putting it there first if it is not already.
async fn arm_picker(surface: &BrowserSurface, token: &str) -> Result<(), AppCommandError> {
    let answer = eval_in_world_string(surface, &handoff::probe_and_pick(token)).await?;
    if answer == handoff::PICKER_ABSENT {
        eval_in_world_string(surface, &handoff::install_and_pick(token)).await?;
    }
    Ok(())
}

/// Put the picker away. Called when the person presses the button a second
/// time, and whenever a pick ends for any other reason.
pub async fn cancel_pick_core(
    registry: &BrowserRegistry,
    tab_id: &str,
) -> Result<(), AppCommandError> {
    if !registry.contains(tab_id) {
        return Err(AppCommandError::not_found(format!(
            "browser tab {tab_id} not found"
        )));
    }
    stop_picking(registry, tab_id, None).await;
    Ok(())
}

/// Stop waiting, and tell the page to take the highlight down.
///
/// `token` names the pick the caller may end; `None` ends whatever is armed
/// (the person pressed the button again). Three outcomes, and each matters:
///
/// * the slot was this caller's — put the page's picker away, naming it, so
///   that a pick armed while this call is in flight is not the one that
///   stops;
/// * someone else's pick is armed — leave both alone. A superseded pick wakes
///   up here, and taking the page's picker down then would cancel the pick
///   that replaced it;
/// * nothing was armed — but this caller may still have installed a picker
///   of its own, because the document can change between the probe and the
///   install. That orphan is named by this caller's token and only it comes
///   down. A caller with no token to name has nothing to clean up: whatever
///   is in the page belongs to someone, and asking the page to stop
///   "whatever is there" would take down a pick that armed in the meantime.
///
/// Every stop names the pick it means, for the same reason: telling the page
/// is a second round trip, and by the time it lands the answer may have
/// changed.
///
/// Best effort throughout: the world may already have gone with the document.
async fn stop_picking(registry: &BrowserRegistry, tab_id: &str, token: Option<&str>) {
    let stop = match registry.cancel_pick(tab_id, token) {
        registry::PickSlot::Cleared(cleared) => cleared,
        registry::PickSlot::Empty => match token {
            Some(token) => token.to_string(),
            None => return,
        },
        registry::PickSlot::Elsewhere => return,
    };
    let Some(surface) = registry.surface(tab_id) else {
        return;
    };
    let call = handoff::stop_pick_call(&stop);
    if let Err(err) = eval_in_world_string(&surface, &call).await {
        tracing::debug!("[browser] tab {tab_id}: could not put the picker away: {err:?}");
    }
}

/// A screenshot of the page as it is on screen, for a conversation.
pub async fn capture_page_core(
    registry: &BrowserRegistry,
    tab_id: &str,
) -> Result<handoff::PageHandoff, AppCommandError> {
    let Some((surface, title, profile)) = registry.read(tab_id, |tab| {
        (tab.surface.clone(), tab.state.title.clone(), tab.state.profile.clone())
    }) else {
        return Err(AppCommandError::not_found(format!(
            "browser tab {tab_id} not found"
        )));
    };
    let raw = eval_in_world_string(&surface, agent::viewport_call()).await?;
    let answer: agent::ViewportAnswer = serde_json::from_str(&raw)
        .map_err(|e| window_err("Failed to capture the page", format!("unreadable answer: {e}")))?;
    let region = CaptureRegion {
        x: 0.0,
        y: 0.0,
        width: answer.viewport.width,
        height: answer.viewport.height,
    };
    // Where the page is, as the agent's host knows it (a remote tab).
    let page = crate::browser::remote::host_address(profile.as_deref(), &answer.url);
    let (url, _) = handoff::redact_url(&page);
    let image = draw_capture(
        &surface,
        answer.viewport.width,
        region,
        false,
        capture::effective_max_width(None),
        capture::CaptureFormat::Png,
        url.clone(),
    )
    .await?;
    Ok(handoff::PageHandoff {
        cancelled: false,
        label: String::new(),
        text: handoff::render_screenshot(&page, &title, region, &image),
        url,
        image: Some(image),
        count: 0,
    })
}

/// What the page has printed, for a conversation. `errors_only` is the
/// everyday case — a person who noticed the red mark wants what broke, not
/// four hundred lines of debug logging.
pub fn page_console_core(
    registry: &BrowserRegistry,
    tab_id: &str,
    errors_only: bool,
) -> Result<handoff::PageHandoff, AppCommandError> {
    let answer = registry.read(tab_id, |tab| {
        // No grant, and no origin filter beyond the one the ring already
        // applied on the way in (only the tab's own origin is ever kept):
        // this is a person reading the console of the page in front of them.
        let query = ConsoleQuery {
            since: 0,
            min_level: errors_only.then_some(ConsoleLevel::Error),
            limit: Some(crate::browser::console::CONSOLE_RING_CAPACITY),
        };
        let readout = tab.console.read(&query, &tab.state.url, |_| true);
        (tab.state.url.clone(), readout.entries, readout.dropped, tab.state.profile.clone())
    });
    let Some((url, entries, dropped, profile)) = answer else {
        return Err(AppCommandError::not_found(format!(
            "browser tab {tab_id} not found"
        )));
    };
    Ok(console_handoff(profile.as_deref(), &url, entries, dropped, errors_only))
}

/// The console lines a tab of `profile` read out, as the block that goes to
/// a conversation.
fn console_handoff(
    profile: Option<&str>,
    url: &str,
    mut entries: Vec<ConsoleEntry>,
    dropped: u64,
    errors_only: bool,
) -> handoff::PageHandoff {
    // The newest lines, not the oldest: someone handing over a console wants
    // what just happened. What that leaves out is counted with what the ring
    // had already lost, so the block never reads as the whole story when it
    // is not.
    let omitted = entries.len().saturating_sub(handoff::HANDOFF_CONSOLE_LIMIT);
    if omitted > 0 {
        entries.drain(..omitted);
    }
    // The page, and the scripts the lines came from, as the agent's host
    // knows them (a remote tab).
    let url = crate::browser::remote::host_address(profile, url);
    for entry in &mut entries {
        if let Some(script) = entry.url.as_mut() {
            *script = crate::browser::remote::host_address(profile, script).into_owned();
        }
    }
    let text = handoff::render_console(&url, &entries, dropped + omitted as u64, errors_only);
    let (url, _) = handoff::redact_url(&url);
    handoff::PageHandoff {
        cancelled: false,
        label: String::new(),
        text,
        url,
        image: None,
        count: entries.len(),
    }
}

/// The browser tools an agent gets, answered from this process's tab
/// registry.
///
/// Holds an `AppHandle` rather than the registry itself: the registry is Tauri
/// managed state, and resolving it per call means a build that never installed
/// one degrades to "no browser here" instead of panicking at startup.
///
/// The feature flag is re-read on every call, not captured at injection. A
/// person switching this off has decided something about the session in front
/// of them right now, and an agent launched five minutes ago is exactly the
/// one they mean.
pub struct McpBrowserTools {
    app: AppHandle,
    config: crate::acp::browser_tools::BrowserToolsRuntimeConfig,
}

impl McpBrowserTools {
    pub fn new(app: AppHandle, config: crate::acp::browser_tools::BrowserToolsRuntimeConfig) -> Self {
        Self { app, config }
    }

    /// The registry, or `None` when this build has no browser to speak of.
    async fn registry(&self) -> Option<State<'_, BrowserRegistry>> {
        if !self.config.is_enabled().await {
            return None;
        }
        self.app.try_state::<BrowserRegistry>()
    }
}

#[async_trait::async_trait]
impl crate::acp::browser_tools::BrowserToolAccess for McpBrowserTools {
    async fn list_tabs(&self) -> crate::acp::browser_tools::BrowserTabsOutcome {
        use crate::acp::browser_tools::{BrowserTabsOutcome, NO_BROWSER_NOTE};
        let Some(registry) = self.registry().await else {
            return BrowserTabsOutcome::unavailable(NO_BROWSER_NOTE);
        };
        BrowserTabsOutcome {
            tabs: agent_list_tabs_core(&registry),
            note: None,
        }
    }

    async fn snapshot(
        &self,
        tab_id: &str,
        max_chars: Option<usize>,
    ) -> crate::acp::browser_tools::BrowserSnapshotOutcome {
        use crate::acp::browser_tools::{
            BrowserSnapshotOutcome, DEFAULT_SNAPSHOT_MAX_CHARS, ERROR_NO_SUCH_TAB,
            ERROR_READ_FAILED, ERROR_UNAVAILABLE, NO_BROWSER_NOTE,
        };
        let Some(registry) = self.registry().await else {
            return BrowserSnapshotOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE);
        };
        // `Some(0)` is the caller asking for the whole page, and is passed
        // through as such; only an absent cap becomes the default.
        let request = agent::SnapshotRequest {
            max_chars: Some(max_chars.unwrap_or(DEFAULT_SNAPSHOT_MAX_CHARS)),
        };
        // Straight through `agent_snapshot_core`: the grant check and the line
        // it leaves on the tab's activity strip both live in there, so this
        // surface cannot read a page more quietly than the app's own does.
        match agent_snapshot_core(&self.app, &registry, tab_id, &request).await {
            Ok(snapshot) => BrowserSnapshotOutcome::page(tab_id, snapshot),
            // The refusal is recognized by the key the error was tagged with,
            // not by its code: `PermissionDenied` is a wide category, and only
            // this one means "the user can fix it with one click".
            Err(err)
                if err.i18n_key.as_deref() == Some(BROWSER_I18N_KEY_GRANT_REQUIRED) =>
            {
                BrowserSnapshotOutcome::grant_required(tab_id)
            }
            Err(err)
                if matches!(err.code, crate::app_error::AppErrorCode::NotFound) =>
            {
                BrowserSnapshotOutcome::refused(
                    tab_id,
                    ERROR_NO_SUCH_TAB,
                    format!(
                        "No browser tab {tab_id} is open. Call browser_list_tabs for the ids \
                         that are."
                    ),
                )
            }
            Err(err) => BrowserSnapshotOutcome::refused(tab_id, ERROR_READ_FAILED, err.message),
        }
    }

    async fn act(
        &self,
        tab_id: &str,
        request: agent::ActionRequest,
    ) -> crate::acp::browser_tools::BrowserActOutcome {
        use crate::acp::browser_tools::{
            BrowserActOutcome, ERROR_ACTION_FAILED, ERROR_NO_SUCH_TAB, ERROR_UNAVAILABLE,
            NO_BROWSER_NOTE,
        };
        let Some(registry) = self.registry().await else {
            return BrowserActOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE);
        };
        match agent_act_core(&self.app, &registry, tab_id, &request).await {
            Ok(outcome) => BrowserActOutcome::done(tab_id, outcome),
            Err(err) => match err.i18n_key.as_deref() {
                Some(BROWSER_I18N_KEY_GRANT_REQUIRED) => BrowserActOutcome::grant_required(tab_id),
                Some(BROWSER_I18N_KEY_CONTROL_REQUIRED) => {
                    BrowserActOutcome::control_required(tab_id)
                }
                Some(BROWSER_I18N_KEY_STALE_REF) => BrowserActOutcome::stale_ref(tab_id, &err.message),
                _ if matches!(err.code, crate::app_error::AppErrorCode::NotFound) => {
                    BrowserActOutcome::refused(
                        tab_id,
                        ERROR_NO_SUCH_TAB,
                        format!(
                            "No browser tab {tab_id} is open. Call browser_list_tabs for the ids \
                             that are."
                        ),
                    )
                }
                _ => BrowserActOutcome::refused(tab_id, ERROR_ACTION_FAILED, err.message),
            },
        }
    }

    async fn console(
        &self,
        tab_id: &str,
        query: ConsoleQuery,
    ) -> crate::acp::browser_tools::BrowserConsoleOutcome {
        use crate::acp::browser_tools::{
            BrowserConsoleOutcome, ERROR_NO_SUCH_TAB, ERROR_READ_FAILED, ERROR_UNAVAILABLE,
            NO_BROWSER_NOTE,
        };
        let Some(registry) = self.registry().await else {
            return BrowserConsoleOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE);
        };
        match agent_console_core(&self.app, &registry, tab_id, &query).await {
            Ok(readout) => BrowserConsoleOutcome::lines(tab_id, readout),
            Err(err) if err.i18n_key.as_deref() == Some(BROWSER_I18N_KEY_GRANT_REQUIRED) => {
                BrowserConsoleOutcome::grant_required(tab_id)
            }
            Err(err) if matches!(err.code, crate::app_error::AppErrorCode::NotFound) => {
                BrowserConsoleOutcome::refused(
                    tab_id,
                    ERROR_NO_SUCH_TAB,
                    format!(
                        "No browser tab {tab_id} is open. Call browser_list_tabs for the ids \
                         that are."
                    ),
                )
            }
            Err(err) => BrowserConsoleOutcome::refused(tab_id, ERROR_READ_FAILED, err.message),
        }
    }

    async fn capture(
        &self,
        tab_id: &str,
        request: CaptureRequest,
    ) -> crate::acp::browser_tools::BrowserCaptureOutcome {
        use crate::acp::browser_tools::{
            BrowserCaptureOutcome, ERROR_NO_SUCH_TAB, ERROR_READ_FAILED, ERROR_UNAVAILABLE,
            NO_BROWSER_NOTE,
        };
        let Some(registry) = self.registry().await else {
            return BrowserCaptureOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE);
        };
        match agent_capture_core(&self.app, &registry, tab_id, &request).await {
            Ok(capture) => BrowserCaptureOutcome::image(tab_id, capture),
            Err(err) => match err.i18n_key.as_deref() {
                Some(BROWSER_I18N_KEY_GRANT_REQUIRED) => {
                    BrowserCaptureOutcome::grant_required(tab_id)
                }
                Some(BROWSER_I18N_KEY_STALE_REF) => {
                    BrowserCaptureOutcome::stale_ref(tab_id, &err.message)
                }
                _ if matches!(err.code, crate::app_error::AppErrorCode::NotFound) => {
                    BrowserCaptureOutcome::refused(
                        tab_id,
                        ERROR_NO_SUCH_TAB,
                        format!(
                            "No browser tab {tab_id} is open. Call browser_list_tabs for the ids \
                             that are."
                        ),
                    )
                }
                _ => BrowserCaptureOutcome::refused(tab_id, ERROR_READ_FAILED, err.message),
            },
        }
    }

    async fn eval(
        &self,
        tab_id: &str,
        request: EvalRequest,
    ) -> crate::acp::browser_tools::BrowserEvalOutcome {
        use crate::acp::browser_tools::{
            BrowserEvalOutcome, ERROR_EVAL_BUSY, ERROR_EVAL_DISABLED, ERROR_NO_SUCH_TAB,
            ERROR_READ_FAILED, ERROR_UNAVAILABLE, NO_BROWSER_NOTE,
        };
        let Some(registry) = self.registry().await else {
            return BrowserEvalOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE);
        };
        // Its own switch, re-read here rather than trusted from injection
        // time. `tools/list` hides the tool when it is off, so an agent only
        // reaches this line if the user turned it off mid-session — which is
        // exactly the case the re-read is for.
        if !self.config.is_eval_enabled().await {
            return BrowserEvalOutcome::refused(
                tab_id,
                ERROR_EVAL_DISABLED,
                "Running your own code on a page is switched off. The user can turn it on under \
                 Settings → General → the tools an agent may use, next to the browser switch. It \
                 is off by default and is theirs to turn on; the other browser tools still work.",
            );
        }
        let Some(consent) = self.app.try_state::<EvalConsent>() else {
            return BrowserEvalOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE);
        };
        match agent_eval_core(&self.app, &registry, &consent, tab_id, &request).await {
            Ok(result) => BrowserEvalOutcome::ran(tab_id, result),
            Err(err) => match err.i18n_key.as_deref() {
                Some(BROWSER_I18N_KEY_GRANT_REQUIRED) => BrowserEvalOutcome::grant_required(tab_id),
                Some(BROWSER_I18N_KEY_CONTROL_REQUIRED) => {
                    BrowserEvalOutcome::control_required(tab_id)
                }
                Some(BROWSER_I18N_KEY_EVAL_DECLINED) => BrowserEvalOutcome::declined(tab_id),
                Some(BROWSER_I18N_KEY_EVAL_BUSY) => {
                    BrowserEvalOutcome::refused(tab_id, ERROR_EVAL_BUSY, err.message)
                }
                _ if matches!(err.code, crate::app_error::AppErrorCode::NotFound) => {
                    BrowserEvalOutcome::refused(
                        tab_id,
                        ERROR_NO_SUCH_TAB,
                        format!(
                            "No browser tab {tab_id} is open. Call browser_list_tabs for the ids \
                             that are."
                        ),
                    )
                }
                _ => BrowserEvalOutcome::refused(tab_id, ERROR_READ_FAILED, err.message),
            },
        }
    }

    async fn tab_op(
        &self,
        op: crate::acp::browser_tools::BrowserTabOp,
    ) -> crate::acp::browser_tools::BrowserTabOutcome {
        use crate::acp::browser_tools::{
            BrowserTabOp, BrowserTabOutcome, ERROR_BAD_ADDRESS, ERROR_BLOCKED, ERROR_NO_SUCH_TAB,
            ERROR_OPEN_FAILED, ERROR_UNAVAILABLE, NO_BROWSER_NOTE,
        };
        let Some(registry) = self.registry().await else {
            return BrowserTabOutcome::refused(op.tab_id(), ERROR_UNAVAILABLE, NO_BROWSER_NOTE);
        };
        let named = op.tab_id().map(str::to_string);
        let answer = match &op {
            BrowserTabOp::Open { url } => {
                let Some(requests) = self.app.try_state::<open_request::OpenRequests>() else {
                    return BrowserTabOutcome::refused(None, ERROR_UNAVAILABLE, NO_BROWSER_NOTE);
                };
                agent_open_tab_core(&self.app, &registry, &requests, url)
                    .await
                    .map(|(tab, load_error)| BrowserTabOutcome::tab(tab, load_error))
            }
            BrowserTabOp::Navigate { tab_id, url } => {
                agent_navigate_core(&self.app, &registry, tab_id, url)
                    .await
                    .map(|(tab, load_error)| BrowserTabOutcome::tab(tab, load_error))
            }
            BrowserTabOp::Close { tab_id } => agent_close_tab_core(&self.app, &registry, tab_id)
                .await
                .map(|()| BrowserTabOutcome::closed(tab_id)),
        };
        let named = named.as_deref();
        match answer {
            Ok(outcome) => outcome,
            Err(err) => match err.i18n_key.as_deref() {
                Some(BROWSER_I18N_KEY_GRANT_REQUIRED) => {
                    // Only reachable for the two ops that name a tab.
                    BrowserTabOutcome::grant_required(named.unwrap_or_default())
                }
                Some(BROWSER_I18N_KEY_CONTROL_REQUIRED) => {
                    BrowserTabOutcome::control_required(named.unwrap_or_default())
                }
                Some(BROWSER_I18N_KEY_BAD_ADDRESS) => BrowserTabOutcome::refused(
                    named,
                    ERROR_BAD_ADDRESS,
                    format!(
                        "{}. Browser tabs take http:// and https:// addresses.",
                        err.message.trim_end_matches('.')
                    ),
                ),
                Some(BROWSER_I18N_KEY_BLOCKED) => BrowserTabOutcome::refused(
                    named,
                    ERROR_BLOCKED,
                    format!(
                        "{}. The user (or their administrator) wrote a rule that refuses this \
                         host in the built-in browser; the same address will be refused next \
                         time.",
                        err.message.trim_end_matches('.')
                    ),
                ),
                Some(BROWSER_I18N_KEY_OPEN_FAILED) => {
                    BrowserTabOutcome::refused(named, ERROR_OPEN_FAILED, err.message)
                }
                _ if matches!(err.code, crate::app_error::AppErrorCode::NotFound) => {
                    BrowserTabOutcome::refused(
                        named,
                        ERROR_NO_SUCH_TAB,
                        format!(
                            "No browser tab {} is open. Call browser_list_tabs for the ids that \
                             are.",
                            named.unwrap_or_default()
                        ),
                    )
                }
                _ => BrowserTabOutcome::refused(named, ERROR_OPEN_FAILED, err.message),
            },
        }
    }
}

/// Evaluate an expression in a tab's isolated world and unwrap the shim's
/// `{ok, value}` envelope. The value is always a string here: every caller in
/// this module asks for `JSON.stringify(…)` or for a literal.
async fn eval_in_world_string(surface: &BrowserSurface, js: &str) -> Result<String, AppCommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    surface
        .eval_in_world(js, move |result| {
            if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = tx.send(result);
            }
        })
        .map_err(|e| window_err("Failed to read the page", e))?;
    // Long enough that a big page's tree is not mistaken for a hung engine.
    // It bounds how long a caller waits for an answer that is not coming, not
    // how large a page may be.
    let raw = match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(Ok(raw))) => raw,
        Ok(Ok(Err(err))) => return Err(window_err("Failed to read the page", err)),
        Ok(Err(_)) => {
            return Err(window_err("Failed to read the page", "the request was dropped"))
        }
        Err(_) => return Err(window_err("Failed to read the page", "the page did not answer")),
    };
    let envelope: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| window_err("Failed to read the page", format!("unreadable answer: {e}")))?;
    if envelope["ok"] == serde_json::Value::Bool(true) {
        envelope["value"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| window_err("Failed to read the page", "the page answered with no value"))
    } else {
        Err(window_err(
            "Failed to read the page",
            envelope["error"].as_str().unwrap_or("evaluation failed"),
        ))
    }
}

#[tauri::command]
pub async fn browser_capabilities(
    policy: State<'_, BrowserPolicy>,
) -> Result<BrowserCapabilities, AppCommandError> {
    Ok(capabilities(&policy))
}

/// The local servers this window has seen start, minus the ones that have
/// since stopped answering.
///
/// Read when the "+" menu opens rather than kept in sync: liveness is a
/// property of a socket, not of an event stream, and one connect per entry at
/// the moment someone looks is both cheaper and more truthful than anything
/// that tries to notice a server going away.
#[tauri::command]
pub async fn browser_list_services(
    window: WebviewWindow,
) -> Result<Vec<DetectedService>, AppCommandError> {
    let owner = window.label().to_string();
    // One connect per entry, with a timeout each: blocking work with no
    // business on a runtime thread other tabs' events queue behind.
    tokio::task::spawn_blocking(move || services::registry().list_live(&owner))
        .await
        .map_err(|err| window_err("Failed to list local services", err))
}

/// The user's site rules, pushed by the frontend (which owns the preference)
/// at startup and on every change. Invalid patterns are dropped.
#[tauri::command]
pub async fn browser_set_host_rules(
    policy: State<'_, BrowserPolicy>,
    rules: Vec<HostRule>,
) -> Result<(), AppCommandError> {
    policy.set_user_rules(rules);
    Ok(())
}

/// Record the "sign-in user agent" preference and re-decide the identity of
/// every open page under it, so a flip applies to the pages on screen and
/// not only to their next navigation.
pub fn set_sign_in_user_agent_core(registry: &BrowserRegistry, enabled: bool) {
    profile::set_sign_in_user_agent(enabled);
    // Each surface decides from its own current URL on the main thread, so a
    // tab id reused by a newer incarnation meanwhile cannot be given the
    // older page's identity.
    for state in registry.list() {
        if state.kind != TabKind::Page {
            continue;
        }
        if let Some(surface) = registry.surface(&state.tab_id) {
            if let Err(err) = surface.refresh_user_agent() {
                tracing::debug!("[browser] tab {}: identity not re-applied: {err}", state.tab_id);
            }
        }
    }
}

/// Record what the empty tab's page should look like and repaint the blank
/// pages that are already open, so a theme change reaches the tab on screen
/// and not only the next one opened.
pub fn set_blank_page_theme_core(
    registry: &BrowserRegistry,
    background: String,
    dark: bool,
) -> Result<(), AppCommandError> {
    blank_page::set(blank_page::BlankPageTheme { background, dark })
        .map_err(AppCommandError::invalid_input)?;
    blank_page::repaint_all(registry);
    Ok(())
}

/// The colours of the empty tab's page, pushed by the frontend (which owns
/// the theme) at startup and on every change. See `browser::blank_page`.
#[tauri::command]
pub async fn browser_set_blank_page_theme(
    registry: State<'_, BrowserRegistry>,
    background: String,
    dark: bool,
) -> Result<(), AppCommandError> {
    set_blank_page_theme_core(&registry, background, dark)
}

/// The "sign-in user agent" preference, pushed by the frontend (which owns
/// it) at startup and on every change.
#[tauri::command]
pub async fn browser_set_sign_in_user_agent(
    registry: State<'_, BrowserRegistry>,
    enabled: bool,
) -> Result<(), AppCommandError> {
    set_sign_in_user_agent_core(&registry, enabled);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_open_tab(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    url: String,
    bounds: Bounds,
    background: Option<bool>,
    surface: Option<SurfaceChoice>,
    folder_id: Option<i64>,
    devtools: Option<bool>,
    profile: Option<String>,
    egress: Option<i32>,
) -> Result<BrowserTabState, AppCommandError> {
    // Folder scoping is a frontend concern (tab strip grouping); the backend
    // only needs the owner window.
    let _ = folder_id;
    let profile = open_tab_profile(profile, egress, || {
        validate_tab_id(&tab_id)?;
        parse_web_url(&url).map(|_| ())
    })?;
    let profile = match profile {
        TabProfile::Named(profile) => profile,
        // The connection's own profile, once its egress is ready: nothing
        // about the tab may reach this computer instead.
        TabProfile::Remote(connection_id) => {
            crate::browser::remote::prepare(&app, &window, connection_id).await?;
            profile::remote_profile_id(connection_id)
        }
    };
    open_tab_core(
        &app,
        &window,
        &registry,
        OpenTabParams {
            tab_id,
            url,
            bounds,
            background: background.unwrap_or(false),
            surface: surface.unwrap_or_default(),
            devtools: devtools.unwrap_or(false),
            profile,
        },
    )
}

/// The profile a tab asked for from the frontend goes into.
#[derive(Debug, PartialEq, Eq)]
enum TabProfile {
    /// A profile the user has (`default` when the caller has no opinion).
    Named(String),
    /// The egress profile of this remote connection.
    Remote(i32),
}

/// Sort out `browser_open_tab`'s profile arguments. An `egress` connection
/// decides the profile by itself; a remote profile named outright is refused
/// — its proxy is the one thing about it that must not be anything but its
/// egress, and only `remote::prepare` sets that up. `check` runs first, so an
/// open that is refused anyway starts no listener and no tunnel.
fn open_tab_profile(
    profile: Option<String>,
    egress: Option<i32>,
    check: impl FnOnce() -> Result<(), AppCommandError>,
) -> Result<TabProfile, AppCommandError> {
    check()?;
    if let Some(connection_id) = egress {
        return Ok(TabProfile::Remote(connection_id));
    }
    let profile = profile.unwrap_or_else(|| profile::DEFAULT_PROFILE_ID.to_string());
    if profile::is_remote_profile(&profile) {
        return Err(AppCommandError::invalid_input(format!(
            "browser profile {profile:?} is a remote connection's; open the tab with its connection instead"
        )));
    }
    Ok(TabProfile::Named(profile))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_doc_open(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, BrowserRegistry>,
    guests: State<'_, DocGuests>,
    tab_id: String,
    path: String,
    root: Option<String>,
    bounds: Bounds,
    background: Option<bool>,
    devtools: Option<bool>,
) -> Result<DocOpenResult, AppCommandError> {
    doc_open_core(
        &app,
        &window,
        &registry,
        &guests,
        DocOpenParams {
            tab_id,
            path,
            root,
            bounds,
            background: background.unwrap_or(false),
            devtools: devtools.unwrap_or(false),
        },
    )
}

#[tauri::command]
pub async fn browser_doc_set_mode(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    guests: State<'_, DocGuests>,
    tab_id: String,
    mode: DocMode,
) -> Result<DocGuestState, AppCommandError> {
    doc_set_mode_core(&app, &registry, &guests, &tab_id, mode)
}

#[tauri::command]
pub async fn browser_doc_state(
    guests: State<'_, DocGuests>,
    tab_id: String,
) -> Result<DocGuestState, AppCommandError> {
    doc_state_core(&guests, &tab_id)
}

#[tauri::command]
pub async fn browser_clear_data(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    profile: Option<String>,
) -> Result<(), AppCommandError> {
    clear_data_core(
        &app,
        &registry,
        profile.as_deref().unwrap_or(profile::DEFAULT_PROFILE_ID),
    )
    .await
}

#[tauri::command]
pub async fn browser_remove_profile(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    profile: String,
) -> Result<(), AppCommandError> {
    remove_profile_core(&app, &registry, &profile).await
}

/// `request_id` is optional and echoed back on `browser://closed`; the
/// workspace passes one so it can tell the close it asked for from a close of
/// the same tab it did not (see [`BrowserClosedPayload`]).
#[tauri::command]
pub async fn browser_close(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    request_id: Option<String>,
) -> Result<(), AppCommandError> {
    close_core(&app, &registry, &tab_id, request_id.as_deref())
}

#[tauri::command]
pub async fn browser_set_bounds(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    bounds: Bounds,
) -> Result<(), AppCommandError> {
    set_bounds_core(&registry, &tab_id, bounds)
}

#[tauri::command]
pub async fn browser_set_visible(
    window: WebviewWindow,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    visible: bool,
    handoff_focus: Option<bool>,
    freeze: Option<bool>,
) -> Result<Option<FrozenFrame>, AppCommandError> {
    set_visible_core(
        &window,
        &registry,
        &tab_id,
        visible,
        handoff_focus.unwrap_or(false),
        freeze.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn browser_freeze_frame(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<Option<FrozenFrame>, AppCommandError> {
    freeze_frame_core(&registry, &tab_id).await
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    url: String,
) -> Result<BrowserTabState, AppCommandError> {
    navigate_core(&app, &registry, &tab_id, &url)
}

#[tauri::command]
pub async fn browser_reload(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<(), AppCommandError> {
    reload_core(&app, &registry, &tab_id)
}

#[tauri::command]
pub async fn browser_go_back(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<(), AppCommandError> {
    go_back_core(&registry, &tab_id)
}

#[tauri::command]
pub async fn browser_go_forward(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<(), AppCommandError> {
    go_forward_core(&registry, &tab_id)
}

#[tauri::command]
pub async fn browser_stop(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<(), AppCommandError> {
    stop_core(&app, &registry, &tab_id)
}

/// Show the engine's web inspector for a tab's page. Refuses, rather than
/// doing nothing, when that tab was opened with the inspector switched off —
/// see [`devtools_refusal`].
#[tauri::command]
pub async fn browser_open_devtools(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<(), AppCommandError> {
    open_devtools_core(&app, &registry, &tab_id)
}

#[tauri::command]
pub async fn browser_find(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    query: String,
    forward: bool,
) -> Result<bool, AppCommandError> {
    find_core(&registry, &tab_id, &query, forward).await
}

#[tauri::command]
pub async fn browser_get_state(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<BrowserTabState, AppCommandError> {
    state_core(&registry, &tab_id)
}

#[tauri::command]
pub async fn browser_list_tabs(
    window: WebviewWindow,
    registry: State<'_, BrowserRegistry>,
) -> Result<Vec<BrowserTabState>, AppCommandError> {
    Ok(registry.list_for_owner(window.label()))
}

/// The share control in a tab's toolbar. A person, always.
#[tauri::command]
pub async fn browser_agent_grant(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    level: GrantLevel,
) -> Result<BrowserTabState, AppCommandError> {
    set_agent_grant_core(&app, &registry, &tab_id, level).await
}

/// Read a shared page on an agent's behalf.
///
/// A command rather than only a `_core` function because the smoke puppet
/// drives commands, and because the tool surface in `codeg-mcp` reaches the
/// backend the same way the frontend does. It is not a way around the grant:
/// the check is inside `agent_snapshot_core`, so every caller gets it.
#[tauri::command]
pub async fn browser_agent_snapshot(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    max_chars: Option<usize>,
) -> Result<agent::PageSnapshot, AppCommandError> {
    agent_snapshot_core(&app, &registry, &tab_id, &agent::SnapshotRequest { max_chars }).await
}

/// Act on a shared page by ref. The check for `control` is inside
/// `agent_act_core`, so every caller gets it.
#[tauri::command]
pub async fn browser_agent_act(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    request: agent::ActionRequest,
) -> Result<agent::ActionOutcome, AppCommandError> {
    agent_act_core(&app, &registry, &tab_id, &request).await
}

/// What a shared page printed to its console. Gated inside
/// `agent_console_core`, so every caller gets the check.
#[tauri::command]
pub async fn browser_agent_console(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    query: Option<ConsoleQuery>,
) -> Result<ConsoleReadout, AppCommandError> {
    agent_console_core(&app, &registry, &tab_id, &query.unwrap_or_default()).await
}

/// A screenshot of a shared page, or of one element of it. Gated inside
/// `agent_capture_core`, so every caller gets the check.
#[tauri::command]
pub async fn browser_agent_capture(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    request: Option<CaptureRequest>,
) -> Result<CaptureOutcome, AppCommandError> {
    agent_capture_core(&app, &registry, &tab_id, &request.unwrap_or_default()).await
}

/// Run an agent's own code on a shared page. Resolves only once the person has
/// answered for that snippet — the grant, the level and the confirmation are
/// all inside `agent_eval_core`, so every caller gets them.
///
/// The `browser_eval` settings switch is *not* checked here: it decides
/// whether the MCP tool exists for an agent, and this command is the app's own
/// path (the dev puppet, and whatever the app itself might one day run). The
/// gates that protect the page — the share, the level, the person — are in the
/// core and apply to both.
#[tauri::command]
pub async fn browser_agent_eval(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    consent: State<'_, EvalConsent>,
    tab_id: String,
    request: EvalRequest,
) -> Result<EvalOutcome, AppCommandError> {
    agent_eval_core(&app, &registry, &consent, &tab_id, &request).await
}

/// The person's answer to one `browser://eval-request`.
///
/// `false` back means the question is no longer waiting — it lapsed, or
/// another window answered first. The frontend uses that to stop showing a
/// dialog nobody is listening to any more.
#[tauri::command]
pub async fn browser_eval_decide(
    consent: State<'_, EvalConsent>,
    request_id: String,
    allow: bool,
) -> Result<bool, AppCommandError> {
    Ok(consent.decide(&request_id, allow))
}

/// The workspace's answer to one `browser://open-request` that named itself.
///
/// `tab_id` is the backend id of the tab it opened — which the frontend knows
/// the moment its own record exists, before the native surface is built, so
/// the answer does not wait on a webview. `None` means it could not open one
/// (a malformed address that got this far, no workspace to put it in).
///
/// `false` back means nobody was waiting for this answer any more: the
/// request timed out, or another document of the same window answered first.
/// The frontend does nothing with it — the tab it opened is a real tab either
/// way — but a silent success would hide a frontend answering the wrong id.
#[tauri::command]
pub async fn browser_answer_open_request(
    requests: State<'_, open_request::OpenRequests>,
    request_id: String,
    tab_id: Option<String>,
) -> Result<bool, AppCommandError> {
    Ok(requests.answer(&request_id, tab_id))
}

/// Point at an element of a page and hand it to a conversation. Resolves when
/// the person picks one — or reports the pick as called off; see
/// `pick_element_core` for the several ways that happens.
#[tauri::command]
pub async fn browser_pick_element(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<PageHandoff, AppCommandError> {
    pick_element_core(&registry, &tab_id).await
}

/// Take the picker's highlight down without picking anything.
#[tauri::command]
pub async fn browser_pick_cancel(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<(), AppCommandError> {
    cancel_pick_core(&registry, &tab_id).await
}

/// A screenshot of the page as it is on screen, for a conversation.
#[tauri::command]
pub async fn browser_page_capture(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
) -> Result<PageHandoff, AppCommandError> {
    capture_page_core(&registry, &tab_id).await
}

/// What the page has printed, for a conversation. Not the agent's read: no
/// grant, no activity line — a person is looking at the console of the page
/// in front of them.
#[tauri::command]
pub async fn browser_page_console(
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    errors_only: Option<bool>,
) -> Result<PageHandoff, AppCommandError> {
    page_console_core(&registry, &tab_id, errors_only.unwrap_or(true))
}

/// Downloads this run started, oldest first. The frontend hydrates from it on
/// mount; afterwards `browser://download` keeps it current.
#[tauri::command]
pub async fn browser_list_downloads(
    downloads: State<'_, BrowserDownloads>,
) -> Result<Vec<BrowserDownload>, AppCommandError> {
    Ok(downloads.list())
}

/// Show a finished download in the file manager. Only reachable for a record
/// this run made, and it is the record's path that is shown — the caller
/// names a download, not a path. The frontend falls back to this when the
/// opener plugin cannot take the path (a network location on Windows).
#[tauri::command]
pub async fn browser_reveal_download(
    downloads: State<'_, BrowserDownloads>,
    id: String,
) -> Result<(), AppCommandError> {
    crate::browser::downloads::reveal(&downloads, &id)
        .map_err(|e| window_err("Failed to show the download", e))
}

/// Forget the records (the "dismiss" of the download bar). The files stay.
#[tauri::command]
pub async fn browser_clear_downloads(
    downloads: State<'_, BrowserDownloads>,
) -> Result<(), AppCommandError> {
    downloads.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_ids_are_label_safe() {
        assert!(validate_tab_id("b7e2c1d0-1a2b").is_ok());
        assert!(validate_tab_id("tab_1").is_ok());
        for bad in ["", "a b", "a/b", "a:b", "é", &"x".repeat(65)] {
            assert!(validate_tab_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn origin_title_hides_path_and_query() {
        let url = Url::parse("https://accounts.example.com/o/oauth2?state=SECRET").unwrap();
        assert_eq!(origin_title(&url), "accounts.example.com");
        let url = Url::parse("http://localhost:3000/app#x").unwrap();
        assert_eq!(origin_title(&url), "localhost:3000");
    }

    #[test]
    fn a_tab_goes_into_the_profile_asked_for_or_its_connection_s() {
        let ok = || Ok(());
        assert_eq!(open_tab_profile(None, None, ok).unwrap(), TabProfile::Named("default".into()));
        assert_eq!(
            open_tab_profile(Some("p-abc".into()), None, ok).unwrap(),
            TabProfile::Named("p-abc".into())
        );
        // The connection decides, whatever profile came along with it.
        assert_eq!(open_tab_profile(Some("p-abc".into()), Some(4), ok).unwrap(), TabProfile::Remote(4));
        // A remote profile is never named from outside: only its connection
        // opens it, after its egress is in place.
        assert!(open_tab_profile(Some("remote-4".into()), None, ok).is_err());
        // An open refused anyway is refused before anything is started.
        let refused = open_tab_profile(None, Some(4), || Err(AppCommandError::invalid_input("bad url")));
        assert_eq!(refused.unwrap_err().message, "bad url");
    }

    #[test]
    fn open_url_must_be_a_web_page() {
        assert!(parse_web_url(" https://example.com ").is_ok());
        assert!(parse_web_url("about:blank").is_ok());
        assert!(parse_web_url("file:///etc/hosts").is_err());
        assert!(parse_web_url("javascript:1").is_err());
        assert!(parse_web_url("not a url").is_err());
    }

    /// The refusal an agent gets is the same one whether the tab was never
    /// shared or the page has since left the shared origin. Distinguishing
    /// them would report on a page the caller is not allowed to read, and the
    /// instruction is identical either way: ask the user to share this tab.
    #[test]
    fn the_refusal_carries_the_key_the_frontend_branches_on() {
        let err = grant_required("t1");
        assert!(matches!(err.code, crate::app_error::AppErrorCode::PermissionDenied));
        assert_eq!(
            err.i18n_key.as_deref(),
            Some("browser.agent.error.grantRequired")
        );
        // …and that key has a message. A stamped key with nothing behind it
        // silently degrades to the English `message`, which is the kind of
        // thing nobody notices until a user reports it in their own language.
        let messages = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/i18n/messages/en.json");
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&messages).expect("en.json")).unwrap();
        let mut node = &json;
        for segment in BROWSER_I18N_KEY_GRANT_REQUIRED.split('.') {
            node = &node[segment];
        }
        assert!(
            node.as_str().is_some_and(|s| !s.is_empty()),
            "{BROWSER_I18N_KEY_GRANT_REQUIRED} has no message in en.json"
        );
    }

    /// The three tab refusals are told apart by their keys — like `staleRef`
    /// and `controlRequired`, these are discriminators for the tool surface
    /// rather than messages for a person (no app surface calls these cores),
    /// so what matters is that they are distinct and always stamped.
    #[test]
    fn the_tab_refusals_are_told_apart_by_their_keys() {
        let keys = [
            BROWSER_I18N_KEY_BAD_ADDRESS,
            BROWSER_I18N_KEY_BLOCKED,
            BROWSER_I18N_KEY_OPEN_FAILED,
            BROWSER_I18N_KEY_GRANT_REQUIRED,
            BROWSER_I18N_KEY_CONTROL_REQUIRED,
        ];
        let unique: std::collections::BTreeSet<_> = keys.iter().collect();
        assert_eq!(unique.len(), keys.len(), "two refusals share a key");
        assert_eq!(
            open_failed("nobody answered").i18n_key.as_deref(),
            Some(BROWSER_I18N_KEY_OPEN_FAILED)
        );
    }

    /// The carve-out that lets an agent retry or clean up a tab it opened on
    /// an address that did not load — and the line it must not cross.
    #[test]
    fn a_tab_with_nothing_in_it_is_not_a_page_anyone_shared() {
        let blank = |f: fn(&mut BrowserTabState)| {
            let mut state = BrowserTabState {
                tab_id: "t1".into(),
                owner_window: "main".into(),
                kind: TabKind::Page,
                surface: SurfaceKind::Child,
                channel: ChannelKind::Native,
                channel_error: None,
                url: String::new(),
                requested_url: "https://example.com/".into(),
                title: String::new(),
                favicon: None,
                loading: true,
                can_go_back: false,
                can_go_forward: false,
                origin: None,
                zoom: 1.0,
                error: None,
                remote_host: None,
                opener_tab_id: None,
                profile: None,
                agent_grant: None,
            };
            f(&mut state);
            shows_no_document(&state)
        };

        // Never committed anything; showing an error page; sitting on the
        // blank page. Nothing to lose in any of them.
        assert!(blank(|_| {}));
        assert!(blank(|s| {
            s.url = "https://example.com/".into();
            s.error = Some(BrowserErrorInfo {
                kind: BrowserErrorKind::Failed,
                message: String::new(),
                url: None,
            });
        }));
        assert!(blank(|s| s.url = "about:blank".into()));

        // A committed page is a page, whether or not it is loading something
        // else on top — the old document is still on screen until the new one
        // commits, so `loading` must not be what decides this.
        assert!(!blank(|s| s.url = "https://example.com/".into()));
        assert!(!blank(|s| {
            s.url = "https://example.com/".into();
            s.loading = true;
            s.requested_url = "https://elsewhere.example/".into();
        }));
    }

    /// The inspector is a creation-time attribute of the webview and no engine
    /// reports it back, so a tab built without it would take the call and show
    /// nothing. The three answers, and which of them is actionable.
    #[test]
    fn a_tab_opened_without_the_inspector_is_told_so_rather_than_ignored() {
        assert!(devtools_refusal(Some(true), "t1").is_none());

        let off = devtools_refusal(Some(false), "t1").expect("refused");
        // Invalid input, not not-found: the tab is right there, and the person
        // has something to do about it — which the key carries to the toast.
        assert!(matches!(off.code, crate::app_error::AppErrorCode::InvalidInput));
        assert_eq!(off.i18n_key.as_deref(), Some(BROWSER_I18N_KEY_INSPECTOR_OFF));

        let gone = devtools_refusal(None, "t1").expect("no such tab");
        assert!(matches!(gone.code, crate::app_error::AppErrorCode::NotFound));
        // …and nothing for a person to act on, so no key.
        assert!(gone.i18n_key.is_none());
    }

    /// And the wiring reaches it: a tab that is not there never gets as far as
    /// asking a surface for an inspector.
    ///
    /// Only that branch is reachable from here — a tab with `devtools: false`
    /// needs a real surface to put in the registry, and `surface_of` answers
    /// the same not-found for a ghost either way, so taking the gate out of
    /// `open_devtools_core` leaves both of these green. The refusal's wiring
    /// is exercised on a real engine through the `browser_open_devtools`
    /// puppet op (`browser/smoke.rs`).
    #[test]
    fn opening_the_inspector_on_a_tab_that_is_not_there_says_so() {
        let registry = BrowserRegistry::default();
        let err = devtools_target(&registry, "ghost").err().expect("no such tab");
        assert!(matches!(err.code, crate::app_error::AppErrorCode::NotFound));
    }

    /// The gate itself: an unshared page is refused, a read-only one is told
    /// what to ask for, and an empty tab goes through.
    #[test]
    fn driving_a_tab_needs_control_unless_there_is_nothing_in_it() {
        let registry = BrowserRegistry::default();
        // No tab at all reports to nobody, like every other missing tab.
        let (outcome, err) = may_drive_tab(&registry, "ghost").expect_err("no such tab");
        assert!(outcome.is_none());
        assert!(matches!(err.code, crate::app_error::AppErrorCode::NotFound));
    }

    /// A tab that is not there is the one exit that leaves no line: there is
    /// no strip to leave it on, and no one watching. Every other way a read
    /// can end reports itself, which is what lets an empty strip be read as
    /// "nothing reached this tab".
    #[tokio::test]
    async fn a_read_of_a_tab_that_is_not_there_reports_to_nobody() {
        let registry = BrowserRegistry::default();
        let (outcome, err) = read_shared_page(&registry, "ghost", &agent::SnapshotRequest::default())
            .await
            .expect_err("no such tab");
        assert!(outcome.is_none());
        assert!(matches!(err.code, crate::app_error::AppErrorCode::NotFound));
    }

    /// Every page → conversation entry point answers "no such tab" rather
    /// than hanging or handing back an empty block: a pick on a tab that is
    /// gone would otherwise wait out its three minutes with a person watching
    /// a highlight that does not exist.
    #[tokio::test]
    async fn handing_over_a_tab_that_is_not_there_says_so_at_once() {
        let registry = BrowserRegistry::default();
        let not_found = |err: AppCommandError| {
            matches!(err.code, crate::app_error::AppErrorCode::NotFound)
        };
        assert!(not_found(pick_element_core(&registry, "ghost").await.unwrap_err()));
        assert!(not_found(cancel_pick_core(&registry, "ghost").await.unwrap_err()));
        assert!(not_found(capture_page_core(&registry, "ghost").await.unwrap_err()));
        assert!(not_found(page_console_core(&registry, "ghost", true).unwrap_err()));
    }

    /// A remote tab's console goes to an agent on the remote host, so the page
    /// and the scripts the lines came from are named as that host names them,
    /// not by the alias macOS loaded them by. Any other tab's alias is an
    /// address someone typed, and stays.
    #[test]
    fn a_remote_tab_s_console_names_its_page_as_the_remote_host_does() {
        let line = |url: &str| ConsoleEntry {
            seq: 1,
            at: 0,
            level: ConsoleLevel::Error,
            source: crate::browser::console::ConsoleSource::Exception,
            text: "boom".into(),
            url: Some(url.into()),
            line: Some(12),
            column: Some(5),
            top: true,
            origin: None,
        };
        let entries = vec![
            line("http://remote.localhost:3000/src/main.js"),
            line("https://cdn.example.com/lib.js"),
        ];
        let page = "http://remote.localhost:3000/app?token=a";

        let remote = console_handoff(Some("remote-7"), page, entries.clone(), 0, true);
        assert_eq!(remote.url, "http://localhost:3000/app?token=REDACTED");
        assert!(remote.text.contains("- page: http://localhost:3000/app?token=REDACTED\n"));
        assert!(remote.text.contains("(http://localhost:3000/src/main.js:12:5)"));
        assert!(remote.text.contains("(https://cdn.example.com/lib.js:12:5)"));
        assert!(!remote.text.contains("remote.localhost"), "{}", remote.text);
        assert_eq!(remote.count, 2);

        let local = console_handoff(Some("default"), page, entries, 0, true);
        assert_eq!(local.url, "http://remote.localhost:3000/app?token=REDACTED");
        assert!(local.text.contains("(http://remote.localhost:3000/src/main.js:12:5)"));
    }

    #[test]
    fn capabilities_report_a_surface() {
        let caps = capabilities(&BrowserPolicy::default());
        assert!(caps.available);
        assert!(caps.surface.is_some());
        assert!(!caps.platform.is_empty());
        assert!(caps.policy.enabled);
        assert_eq!(caps.doc_guest, doc_guest::supported());
    }

    /// The page channel travels with whatever surface can carry one — the
    /// embedded child surface, or the owned window where it installs the
    /// world itself. Only where neither can is the answer `degraded`, and it
    /// says why rather than leaving the settings section to guess.
    #[test]
    fn capabilities_report_the_page_channel_the_surface_brings() {
        let caps = capabilities(&BrowserPolicy::default());
        if CHILD_SURFACE_COMPILED || crate::browser::surface_window::HAS_CHANNEL {
            assert_eq!(caps.channel, ChannelKind::Native);
            assert!(!caps.reasons.iter().any(|r| r.contains("page channel")));
        } else {
            assert_eq!(caps.channel, ChannelKind::Degraded);
            assert!(caps.reasons.iter().any(|r| r.contains("page channel")));
        }
    }

    /// An administrator can turn the feature off: no surface is offered and
    /// the reason is spelled out for the settings section.
    #[test]
    fn capabilities_follow_a_disabling_policy() {
        let policy = BrowserPolicy::with_managed(crate::browser::policy::ManagedPolicy {
            browser_enabled: false,
            host_rules: Vec::new(),
            source: None,
        });
        let caps = capabilities(&policy);
        assert!(!caps.available);
        assert!(caps.surface.is_none());
        assert!(!caps.doc_guest);
        assert!(!caps.policy.enabled);
        assert!(caps.reasons.iter().any(|r| r.contains("policy")));
    }
}
