//! macOS shim on top of `WKWebView` / `WKUserContentController` (objc2).
//!
//! The helper script and the `codegBrowser` message handler live in the
//! `WKContentWorld` named `codeg`: a separate JavaScript global for the same
//! DOM, invisible to page scripts and immune to their prototype tampering.
//! `WKContentWorld` needs macOS 11; older systems fall back to the page world
//! (reported as `ChannelKind::Legacy`).

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{define_class, msg_send, sel, DeclaredClass, MainThreadMarker, MainThreadOnly, Message};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor};
use objc2_foundation::{
    ns_string, NSArray, NSDate, NSDictionary, NSError, NSNumber, NSProcessInfo, NSString, NSURL,
    NSURLErrorFailingURLErrorKey, NSUUID,
};
use objc2_web_kit::{
    WKContentWorld, WKFindConfiguration, WKFindResult, WKNavigation, WKNavigationAction,
    WKNavigationActionPolicy, WKNavigationDelegate, WKScriptMessage, WKScriptMessageHandler,
    WKSnapshotConfiguration, WKUIDelegate, WKUserContentController, WKUserScript,
    WKUserScriptInjectionTime, WKWebView, WKWebViewConfiguration, WKWebsiteDataRecord,
    WKWebsiteDataStore, WKContentRuleList, WKContentRuleListStore,
};
use tauri_runtime_wry::wry::{self, WebViewExtMacOS};

use super::super::channel::MessageSink;
use super::super::hooks::{classify_load_error, LoadFailure};
use super::super::profile::{self, BrowserProxy, ProxyScheme};

pub const WORLD_NAME: &str = "codeg";
pub const HANDLER_NAME: &str = "codegBrowser";

thread_local! {
    // Controllers that already carry our handler + scripts. A popup created
    // from an opener arrives with the opener's WKUserContentController, and
    // WebKit throws on a second handler registration under the same name.
    static INSTALLED_CONTROLLERS: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
}

pub struct HandlerIvars {
    sink: MessageSink,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = HandlerIvars]
    pub struct CodegMessageHandler;

    unsafe impl NSObjectProtocol for CodegMessageHandler {}

    unsafe impl WKScriptMessageHandler for CodegMessageHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(
            this: &CodegMessageHandler,
            _controller: &WKUserContentController,
            message: &WKScriptMessage,
        ) {
            // SAFETY: WebKit hands us live objects on the main thread.
            unsafe {
                let body = message.body();
                let Some(text) = body.downcast_ref::<NSString>() else {
                    return;
                };
                let frame = message.frameInfo();
                let main_frame = frame.isMainFrame();
                let source = frame
                    .webView()
                    .map(|wv| Retained::as_ptr(&wv) as usize)
                    .unwrap_or(0);
                (this.ivars().sink)(text.to_string(), main_frame, source);
            }
        }
    }
);

impl CodegMessageHandler {
    fn new(sink: MessageSink, mtm: MainThreadMarker) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(HandlerIvars { sink });
        // SAFETY: plain NSObject init.
        unsafe { msg_send![super(this), init] }
    }
}

fn mtm() -> Result<MainThreadMarker, String> {
    MainThreadMarker::new().ok_or_else(|| "not on the main thread".to_string())
}

/// Content worlds (macOS 11+): decided at runtime, not compile time, because
/// codeg sets no minimumSystemVersion.
pub fn supports_content_world(controller: &WKUserContentController) -> bool {
    controller.respondsToSelector(sel!(addScriptMessageHandler:contentWorld:name:))
}

/// Register the message handler and inject `scripts` at document start in
/// every frame — in the isolated world where the engine has one — and
/// `page_scripts` in the page's own world, whichever the case. Returns `true`
/// when an isolated world was used. Idempotent per user-content controller.
pub fn install_world(
    webview: &wry::WebView,
    scripts: &[&str],
    page_scripts: &[&str],
    sink: MessageSink,
) -> Result<bool, String> {
    let mtm = mtm()?;
    let controller = webview.manager();
    let key = Retained::as_ptr(&controller) as usize;
    let already = INSTALLED_CONTROLLERS.with(|set| !set.borrow_mut().insert(key));
    if already {
        // Shared controller (popup from an opener): scripts and handler are in
        // place already, and the sink resolves the tab per message.
        return Ok(supports_content_world(&controller));
    }
    let handler = CodegMessageHandler::new(sink, mtm);
    let proto = ProtocolObject::from_ref(&*handler);
    // SAFETY: main thread, live controller; WebKit retains the handler.
    unsafe {
        if supports_content_world(&controller) {
            let world = WKContentWorld::worldWithName(ns_string!("codeg"), mtm);
            controller.addScriptMessageHandler_contentWorld_name(
                proto,
                &world,
                ns_string!("codegBrowser"),
            );
            for source in scripts {
                let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
                    mtm.alloc(),
                    &NSString::from_str(source),
                    WKUserScriptInjectionTime::AtDocumentStart,
                    false,
                    &world,
                );
                controller.addUserScript(&script);
            }
            add_page_scripts(&controller, page_scripts, mtm);
            Ok(true)
        } else {
            controller.addScriptMessageHandler_name(proto, ns_string!("codegBrowser"));
            for source in scripts {
                let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                    mtm.alloc(),
                    &NSString::from_str(source),
                    WKUserScriptInjectionTime::AtDocumentStart,
                    false,
                );
                controller.addUserScript(&script);
            }
            add_page_scripts(&controller, page_scripts, mtm);
            Ok(false)
        }
    }
}

/// Inject scripts into the PAGE world at document start, every frame: no
/// content world, which is the page's own. Only the console shim goes this
/// way; everything that must stay out of the page's reach uses the world
/// above.
///
/// # Safety
/// Main thread, live controller.
unsafe fn add_page_scripts(
    controller: &WKUserContentController,
    page_scripts: &[&str],
    mtm: MainThreadMarker,
) {
    for source in page_scripts {
        let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
            mtm.alloc(),
            &NSString::from_str(source),
            WKUserScriptInjectionTime::AtDocumentStart,
            false,
        );
        controller.addUserScript(&script);
    }
}

/// Evaluate `expression` in the `codeg` world of the main frame. The result
/// arrives as the JSON string `{"ok":true,"value":…}` or
/// `{"ok":false,"error":…}` so no platform value conversion is needed.
pub fn eval_in_world(
    webview: &wry::WebView,
    expression: &str,
    callback: impl Fn(Result<String, String>) + Send + 'static,
) -> Result<(), String> {
    let mtm = mtm()?;
    let wk = webview.webview();
    let wrapped = format!(
        "(function(){{try{{return JSON.stringify({{ok:true,value:(function(){{return ({expression});}})()}})}}catch(e){{return JSON.stringify({{ok:false,error:String(e&&e.stack||e)}})}}}})()"
    );
    let block = RcBlock::<dyn Fn(*mut AnyObject, *mut NSError)>::new(
        move |result: *mut AnyObject, error: *mut NSError| {
            // SAFETY: WebKit passes valid or null pointers; we only read.
            let outcome = unsafe {
                if !error.is_null() {
                    Err((*error).localizedDescription().to_string())
                } else if result.is_null() {
                    Ok("null".to_string())
                } else {
                    (*result)
                        .downcast_ref::<NSString>()
                        .map(|s| s.to_string())
                        .ok_or_else(|| "non-string result".to_string())
                }
            };
            callback(outcome);
        },
    );
    // SAFETY: main thread, live webview.
    unsafe {
        let world = WKContentWorld::worldWithName(ns_string!("codeg"), mtm);
        wk.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(&wrapped),
            None,
            &world,
            Some(&block),
        );
    }
    Ok(())
}

/// Viewport snapshot as JPEG: `(bytes, pixel width, pixel height)`. Built for
/// the freeze frame a placeholder shows while its surface is hidden under an
/// overlay, so it takes the frame as displayed now (`afterScreenUpdates:
/// false`) and encodes as JPEG through AppKit — a 5-megapixel PNG would take
/// longer to encode than the overlay's own open animation.
/// WKWebView has no channel for input at a page point: the only way to hand
/// it an event is the window's event queue, which delivers to wherever the
/// pointer is on screen. `BrowserSurface::supports_trusted_input` answers
/// false here before anyone reaches this; it exists so the child surface has
/// one call on every platform it is built for.
pub fn dispatch_pointer(
    _webview: &wry::WebView,
    _gesture: super::super::surface::PointerGesture,
    _done: impl FnOnce(Result<(), super::super::surface::PointerFailure>) + 'static,
) -> Result<(), String> {
    Err("this platform delivers no trusted input".into())
}

pub fn snapshot_jpeg(
    webview: &wry::WebView,
    quality: f64,
    callback: impl Fn(Result<(Vec<u8>, u32, u32), String>) + Send + 'static,
) -> Result<(), String> {
    let mtm = mtm()?;
    let wk = webview.webview();
    let block = RcBlock::<dyn Fn(*mut NSImage, *mut NSError)>::new(
        move |image: *mut NSImage, error: *mut NSError| {
            // SAFETY: WebKit passes valid or null pointers; we only read.
            let outcome = unsafe {
                if !error.is_null() {
                    Err((*error).localizedDescription().to_string())
                } else if image.is_null() {
                    Err("snapshot returned no image".to_string())
                } else {
                    encode_jpeg(&*image, quality, mtm)
                }
            };
            callback(outcome);
        },
    );
    // SAFETY: main thread, live webview.
    unsafe {
        let config = WKSnapshotConfiguration::new(mtm);
        config.setAfterScreenUpdates(false);
        wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
    }
    Ok(())
}

/// # Safety
/// Main thread, live image.
unsafe fn encode_jpeg(image: &NSImage, quality: f64, mtm: MainThreadMarker) -> Result<(Vec<u8>, u32, u32), String> {
    let cg = image
        .CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None)
        .ok_or_else(|| "snapshot has no bitmap".to_string())?;
    let rep = NSBitmapImageRep::initWithCGImage(mtm.alloc(), &cg);
    let width = u32::try_from(rep.pixelsWide()).unwrap_or(0);
    let height = u32::try_from(rep.pixelsHigh()).unwrap_or(0);
    let factor = NSNumber::new_f64(quality);
    let factor_object: &AnyObject = &factor;
    let properties = NSDictionary::from_slices(&[NSImageCompressionFactor], &[factor_object]);
    let data = rep
        .representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties)
        .ok_or_else(|| "jpeg encoding failed".to_string())?;
    Ok((data.to_vec(), width, height))
}

/// Viewport snapshot as PNG bytes.
pub fn snapshot_png(
    webview: &wry::WebView,
    callback: impl Fn(Result<Vec<u8>, String>) + Send + 'static,
) -> Result<(), String> {
    let mtm = mtm()?;
    let wk = webview.webview();
    let block = RcBlock::<dyn Fn(*mut NSImage, *mut NSError)>::new(
        move |image: *mut NSImage, error: *mut NSError| {
            // SAFETY: WebKit passes valid or null pointers; we only read.
            let outcome = unsafe {
                if !error.is_null() {
                    Err((*error).localizedDescription().to_string())
                } else if image.is_null() {
                    Err("snapshot returned no image".to_string())
                } else {
                    (*image)
                        .TIFFRepresentation()
                        .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                        .and_then(|rep| {
                            rep.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                        })
                        .map(|png| png.to_vec())
                        .ok_or_else(|| "png encoding failed".to_string())
                }
            };
            callback(outcome);
        },
    );
    // SAFETY: main thread, live webview.
    unsafe {
        let config = WKSnapshotConfiguration::new(mtm);
        config.setAfterScreenUpdates(true);
        wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
    }
    Ok(())
}

/// Highlight the next (or previous) occurrence of `query` in the page, the
/// way ⌘F does in Safari: WebKit owns the search and the selection, so this
/// never touches the DOM and cannot be observed or broken by the page.
/// Wraps around, case-insensitive — the defaults a find bar is expected to
/// have. `callback` gets whether anything matched.
pub fn find_string(
    webview: &wry::WebView,
    query: &str,
    forward: bool,
    callback: impl Fn(bool) + Send + 'static,
) -> Result<(), String> {
    let mtm = mtm()?;
    let wk = webview.webview();
    let block = RcBlock::<dyn Fn(NonNull<WKFindResult>)>::new(move |result: NonNull<WKFindResult>| {
        // SAFETY: WebKit hands us a live result for the duration of the call.
        callback(unsafe { result.as_ref().matchFound() });
    });
    // SAFETY: main thread, live webview.
    unsafe {
        let configuration = WKFindConfiguration::new(mtm);
        configuration.setBackwards(!forward);
        configuration.setCaseSensitive(false);
        configuration.setWraps(true);
        wk.findString_withConfiguration_completionHandler(
            &NSString::from_str(query),
            Some(&configuration),
            &block,
        );
    }
    Ok(())
}

/// Drop the find highlight. WebKit has no "stop finding" call; clearing the
/// selection (in the isolated world, on the shared DOM) is what removes it.
pub fn clear_find(webview: &wry::WebView) -> Result<(), String> {
    eval_in_world(
        webview,
        "(function(){try{getSelection().removeAllRanges()}catch(e){}return true})()",
        |_| {},
    )
}

pub fn go_back(webview: &wry::WebView) {
    // SAFETY: main thread, live webview.
    unsafe {
        let _ = webview.webview().goBack();
    }
}

pub fn go_forward(webview: &wry::WebView) {
    // SAFETY: main thread, live webview.
    unsafe {
        let _ = webview.webview().goForward();
    }
}

pub fn can_go_back(webview: &wry::WebView) -> bool {
    // SAFETY: main thread, live webview.
    unsafe { webview.webview().canGoBack() }
}

pub fn can_go_forward(webview: &wry::WebView) -> bool {
    // SAFETY: main thread, live webview.
    unsafe { webview.webview().canGoForward() }
}

pub fn stop_loading(webview: &wry::WebView) {
    // SAFETY: main thread, live webview.
    unsafe { webview.webview().stopLoading() }
}

/// Identity of the platform webview behind a wry `WebView`, matching the
/// `source` a message sink receives.
/// `WKWebView.URL`, or `None` before any navigation has committed (and after
/// a first navigation failed). wry's own `url()` unwraps this and panics.
pub fn current_url(webview: &wry::WebView) -> Option<String> {
    let wk = WebViewExtMacOS::webview(webview);
    // SAFETY: main thread; WebKit hands back an owned NSURL / NSString.
    unsafe { wk.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()) }
}

/// `WKWebView.isLoading`. wry has no navigation-failure callback, so this is
/// the only way to notice that a load ended without finishing.
pub fn is_loading(webview: &wry::WebView) -> bool {
    let wk = WebViewExtMacOS::webview(webview);
    // SAFETY: main thread.
    unsafe { wk.isLoading() }
}

/// Ask WebKit to put web inspectors in a window of their own rather than
/// docking them into the window that holds the inspected page.
///
/// A docked inspector is the wrong shape for an embedded tab: attaching
/// resizes the inspected view to fill its host window, and for a child surface
/// that window is the whole workspace — measured here, a tab in a 900×620 slot
/// became 2560×933 with the tab strip, sidebar and address bar behind it.
/// `_WKInspector`'s private `detach` does nothing about it on macOS 27, sent
/// before `show` or after, and re-sending the view's frame while the inspector
/// is up is ignored. This preference is what WebKit itself consults when it
/// opens one, and it does decide it.
///
/// REGISTERED, not written: the registration domain is the fallback, so a
/// value stored for this app still wins — and WebKit stores one the moment
/// somebody docks or undocks an inspector from its own toolbar. Whoever wants
/// it docked says so once and keeps it.
///
/// The preference belongs to the app, not to a view: from the first browser
/// tab that opens one, every inspector in this app opens in its own window,
/// the app's own windows included. That is the same bargain — one dock click
/// to say otherwise — and there is no per-webview version of this key to
/// narrow it with.
///
/// Called at startup, before any webview exists, because the More menu is not
/// the only way in: a `with_devtools` webview offers "Inspect Element" in its
/// own context menu, which reaches WebKit without passing through any of this
/// crate. Also called from [`open_devtools`], where it costs nothing.
///
/// Measured on macOS 27, same binary, this call the only difference: without
/// it the inspected view went 900×620 → 1200×280 and no window was added;
/// with it the view kept its frame and a `_WKInspectorWindow` appeared. With
/// `…StartsAttached = YES` in the app domain it docked either way.
pub fn prefer_detached_inspector() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: plain Foundation objects; `NSUserDefaults` is thread-safe
        // and an unknown key here is inert rather than undefined.
        unsafe {
            let no: *mut AnyObject =
                objc2::msg_send![objc2::class!(NSNumber), numberWithBool: false];
            let key = ns_string!("__WebInspectorPageGroupLevel1__.WebKit2InspectorStartsAttached");
            let registration: *mut AnyObject =
                objc2::msg_send![objc2::class!(NSDictionary), dictionaryWithObject: no, forKey: key];
            let defaults: *mut AnyObject =
                objc2::msg_send![objc2::class!(NSUserDefaults), standardUserDefaults];
            let _: () = objc2::msg_send![defaults, registerDefaults: registration];
        }
    });
}

/// Show the Web Inspector for this page — in its own window, see
/// [`prefer_detached_inspector`]. `true` when there was an inspector and it
/// was asked to show, which is also what makes its closing worth watching for.
///
/// The selectors are private — `_inspector` is a `_WKInspector`, the same one
/// wry's own `open_devtools` uses — and each is checked for before it is sent,
/// so a WebKit that renames them opens nothing instead of doing something
/// undefined. `isInspectable` is set by wry at build time from
/// `with_devtools`; without it the inspector is nil.
pub fn open_devtools(webview: &wry::WebView) -> bool {
    prefer_detached_inspector();
    with_inspector(webview, |inspector| unsafe {
        let can_show: bool = objc2::msg_send![inspector, respondsToSelector: objc2::sel!(show)];
        if !can_show {
            return false;
        }
        let _: () = objc2::msg_send![inspector, show];
        true
    })
    .unwrap_or(false)
}

/// Whether the inspector for this page is on screen. Polled while one is
/// open, because WebKit reports its closing no other way.
pub fn devtools_visible(webview: &wry::WebView) -> bool {
    with_inspector(webview, |inspector| unsafe {
        let can_ask: bool =
            objc2::msg_send![inspector, respondsToSelector: objc2::sel!(isVisible)];
        can_ask && objc2::msg_send![inspector, isVisible]
    })
    .unwrap_or(false)
}

/// Run `f` against this view's `_WKInspector`, or `None` where WebKit has no
/// such thing to hand out.
fn with_inspector<R>(
    webview: &wry::WebView,
    f: impl FnOnce(*mut objc2::runtime::AnyObject) -> R,
) -> Option<R> {
    use objc2::runtime::AnyObject;

    let wk = WebViewExtMacOS::webview(webview);
    // SAFETY: main thread, live view; the selector is checked for and the
    // inspector is null-checked before anything is sent to it.
    unsafe {
        let view: &AnyObject = &*(Retained::as_ptr(&wk) as *const AnyObject);
        let has: bool = objc2::msg_send![view, respondsToSelector: objc2::sel!(_inspector)];
        if !has {
            return None;
        }
        let inspector: *mut AnyObject = objc2::msg_send![view, _inspector];
        if inspector.is_null() {
            return None;
        }
        Some(f(inspector))
    }
}

pub fn webview_pointer(webview: &wry::WebView) -> usize {
    Retained::as_ptr(&webview.webview()) as usize
}

/// Diagnostic view of the native state (dev puppet only).
pub fn debug_view(webview: &wry::WebView) -> serde_json::Value {
    let wk = webview.webview();
    // SAFETY: main thread, live view.
    let (hidden, hidden_or_ancestor, has_window, has_superview, frame, loading, has_url) = unsafe {
        let frame = wk.frame();
        (
            wk.isHidden(),
            wk.isHiddenOrHasHiddenAncestor(),
            wk.window().is_some(),
            wk.superview().is_some(),
            [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height],
            wk.isLoading(),
            wk.URL().is_some(),
        )
    };
    serde_json::json!({
        "hidden": hidden,
        "isLoading": loading,
        "hasUrl": has_url,
        "hiddenOrAncestor": hidden_or_ancestor,
        "hasWindow": has_window,
        "hasSuperview": has_superview,
        "frame": frame,
    })
}

// ---------------------------------------------------------------------------
// Navigation delegate: what wry does not report
// ---------------------------------------------------------------------------
//
// wry installs its own `WKNavigationDelegate` and surfaces two of its
// callbacks (commit, finish). A tab needs three more: the provisional start
// (where a page-initiated navigation is heading), the failures (which kind,
// and at once rather than when a poll notices the spinner stopped), and, for
// the policy decision wry does forward, whether the action is for the main
// frame. Rather than re-implementing wry's delegate — its handlers reach into
// private state — the tab's `WKWebView` gets a wrapper: it answers the
// callbacks it cares about and forwards every other selector to wry's object
// (`forwardingTargetForSelector:`), which stays alive inside wry's
// `WebView` for as long as the tab does. `respondsToSelector:` is answered
// from both, so WebKit sees exactly the optional methods wry implements plus
// ours. The wrapper is dropped together with the webview: keeping it longer
// would keep wry's delegate, and through it the `WKWebView`, alive.

pub use super::{NavigationEvent, NavigationSink};

thread_local! {
    /// Wrappers by `WKWebView` pointer, kept alive here (`navigationDelegate`
    /// is a weak property).
    static NAV_DELEGATES: RefCell<HashMap<usize, Retained<CodegNavigationDelegate>>> =
        RefCell::new(HashMap::new());
    /// Whether the navigation action currently being decided targets the main
    /// frame. Set around the forward to wry, whose synchronous call into the
    /// navigation handler is the only place the host learns about the action
    /// — and wry's handler signature carries the URL alone.
    static CURRENT_ACTION_MAIN_FRAME: Cell<Option<bool>> = const { Cell::new(None) };
}

/// Inside a navigation handler: does the action being decided target the
/// main frame? `None` outside a decision (other platforms, or a call from
/// elsewhere), which callers treat as "main frame" — the strict reading.
pub fn current_navigation_is_main_frame() -> Option<bool> {
    CURRENT_ACTION_MAIN_FRAME.with(|flag| flag.get())
}

pub struct NavigationDelegateIvars {
    inner: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
    sink: NavigationSink,
    /// The `WKNavigation` that started most recently (by identity). A
    /// redirect, interruption or failure reported for an OLDER navigation
    /// — a superseded load, a download the previous document started — is
    /// not news about the load in flight and is dropped.
    current: Cell<usize>,
}

fn navigation_id(navigation: Option<&WKNavigation>) -> usize {
    navigation.map_or(0, |n| n as *const WKNavigation as usize)
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = NavigationDelegateIvars]
    pub struct CodegNavigationDelegate;

    unsafe impl NSObjectProtocol for CodegNavigationDelegate {}

    impl CodegNavigationDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            self.class().responds_to(selector) || self.ivars().inner.respondsToSelector(selector)
        }

        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, _selector: Sel) -> *mut AnyObject {
            Retained::as_ptr(&self.ivars().inner) as *mut AnyObject
        }
    }

    unsafe impl WKNavigationDelegate for CodegNavigationDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(
            &self,
            webview: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::Block<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            // SAFETY: WebKit hands us live objects on the main thread.
            let main_frame = unsafe { action.targetFrame().map(|frame| frame.isMainFrame()) };
            // No target frame = a new window; the strict reading applies.
            CURRENT_ACTION_MAIN_FRAME.with(|flag| flag.set(Some(main_frame.unwrap_or(true))));
            // The identity this webview presents follows where its main
            // frame is going (the sign-in exception) — but only once the
            // navigation is admitted: a refused address must not change what
            // the page that stays presents. So the decision handler is
            // wrapped, and the identity is set right before the `Allow`
            // reaches WebKit (still ahead of the request, see
            // `apply_user_agent`). A new window's URL is the new window's
            // business.
            let inner = &self.ivars().inner;
            let admitted_url = if main_frame == Some(true) {
                // SAFETY: live action on the main thread.
                unsafe { action.request().URL().and_then(|u| u.absoluteString()) }
                    .and_then(|s| tauri::Url::parse(&s.to_string()).ok())
            } else {
                None
            };
            match admitted_url {
                Some(url) => {
                    let retained = webview.retain();
                    let original = handler.copy();
                    let wrapped = RcBlock::new(move |policy: WKNavigationActionPolicy| {
                        if policy == WKNavigationActionPolicy::Allow {
                            apply_user_agent(&retained, &url);
                        }
                        original.call((policy,));
                    });
                    // SAFETY: same selector and arguments WebKit gave us,
                    // with a block of the same signature in the handler's
                    // place; wry calls it once, synchronously or later, and
                    // the block copies keep everything it needs alive.
                    unsafe {
                        let _: () = msg_send![
                            &**inner,
                            webView: webview,
                            decidePolicyForNavigationAction: action,
                            decisionHandler: &*wrapped
                        ];
                    }
                }
                None => {
                    // SAFETY: forwarding the exact selector and arguments
                    // WebKit gave us to the delegate that implements it.
                    unsafe {
                        let _: () = msg_send![
                            &**inner,
                            webView: webview,
                            decidePolicyForNavigationAction: action,
                            decisionHandler: handler
                        ];
                    }
                }
            }
            CURRENT_ACTION_MAIN_FRAME.with(|flag| flag.set(None));
        }

        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn did_start_provisional(&self, webview: &WKWebView, navigation: Option<&WKNavigation>) {
            self.ivars().current.set(navigation_id(navigation));
            // `URL` is the active URL: the provisional one while a load is in
            // flight, so this is where the navigation is heading.
            // SAFETY: main thread, live webview.
            let url = unsafe { webview.URL().and_then(|u| u.absoluteString()) }.map(|s| s.to_string());
            tracing::debug!("[browser] navigation started: {url:?}");
            if let Some(url) = url {
                (self.ivars().sink)(NavigationEvent::Started(url));
            }
        }

        #[unsafe(method(webView:didReceiveServerRedirectForProvisionalNavigation:))]
        fn did_redirect_provisional(&self, webview: &WKWebView, navigation: Option<&WKNavigation>) {
            if self.is_stale(navigation) {
                return;
            }
            // SAFETY: main thread, live webview; `URL` is the redirect target
            // by the time WebKit reports the redirect.
            let url = unsafe { webview.URL().and_then(|u| u.absoluteString()) }.map(|s| s.to_string());
            tracing::debug!("[browser] navigation redirected: {url:?}");
            if let Some(url) = url {
                (self.ivars().sink)(NavigationEvent::Redirected(url));
            }
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(&self, _webview: &WKWebView, navigation: Option<&WKNavigation>, error: &NSError) {
            if self.is_stale(navigation) {
                tracing::debug!("[browser] ignoring the failure of a superseded navigation");
                return;
            }
            let settles = self.names_current(navigation);
            self.report_failure(error, true, settles);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _webview: &WKWebView, navigation: Option<&WKNavigation>, error: &NSError) {
            if self.is_stale(navigation) {
                return;
            }
            // Not provisional: a page committed and then failed. Nothing
            // below settles on this path, so attribution buys nothing.
            self.report_failure(error, false, false);
        }
    }
);

impl CodegNavigationDelegate {
    fn new(
        inner: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
        sink: NavigationSink,
        mtm: MainThreadMarker,
    ) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(NavigationDelegateIvars {
            inner,
            sink,
            current: Cell::new(0),
        });
        // SAFETY: plain NSObject init.
        unsafe { msg_send![super(this), init] }
    }

    /// A callback about a navigation other than the one that started last.
    /// WebKit hands the same `WKNavigation` object to every callback of one
    /// navigation, so identity is the comparison; a callback without one
    /// (nil, as for some engine-internal loads) is taken at face value.
    fn is_stale(&self, navigation: Option<&WKNavigation>) -> bool {
        navigation.is_some_and(|n| n as *const WKNavigation as usize != self.ivars().current.get())
    }

    /// Whether the callback NAMES the navigation that started last — the one
    /// the tab believes is in flight. Stronger than `!is_stale`, which lets a
    /// nil `WKNavigation` through so that a real failure is still reported:
    /// nil names nothing, and a callback that names nothing cannot be used to
    /// SETTLE a navigation. Settling the wrong one takes a live load's address
    /// off the toolbar and retires its watcher, and the load it was really
    /// about is then the only thing left to notice.
    fn names_current(&self, navigation: Option<&WKNavigation>) -> bool {
        navigation.is_some_and(|n| n as *const WKNavigation as usize == self.ivars().current.get())
    }

    fn report_failure(&self, error: &NSError, provisional: bool, settles: bool) {
        let domain = error.domain().to_string();
        let code = i64::try_from(error.code()).unwrap_or(i64::MAX);
        let kind = classify_load_error(&domain, code);
        tracing::debug!(
            "[browser] navigation failed (provisional: {provisional}): {domain} {code} -> {kind:?}: {}",
            error.localizedDescription()
        );
        let Some(kind) = kind else {
            // Not a failure of the page, and the load in flight is over all
            // the same: our own navigation handler cancelled it (a refused
            // redirect target), it turned into a download
            // (WebKitErrorFrameLoadInterruptedByPolicyChange), or it was
            // cancelled outright (`NSURLErrorCancelled`) — a page that
            // navigated itself again mid-flight, a load the user stopped.
            //
            // Said out loud rather than left to the load watcher: nothing
            // else will report this navigation, and a tab left believing one
            // is in flight both spins for ever and, once the watcher gives
            // up on it, puts an error page over a document that is fine.
            //
            // Only for a callback that names the load in flight, though
            // (`settles`). This event SETTLES: it takes the tab's
            // `provisional_url` and bumps `load_seq`, which retires the
            // watcher. A superseded navigation never reaches here
            // (`is_stale`), but one WITHOUT a `WKNavigation` would, and it
            // would settle whatever happens to be in flight instead of
            // itself. Letting the watcher conclude that load a moment later
            // is the cheaper mistake: it settles a tab that has a page and
            // errors one that has none, which is where this would land
            // anyway.
            if provisional && settles {
                (self.ivars().sink)(NavigationEvent::Interrupted);
            } else if provisional {
                tracing::debug!(
                    "[browser] a load ended without naming itself; left to the load watcher"
                );
            }
            return;
        };
        // SAFETY: main thread; the dictionary and its values are live.
        let url = unsafe {
            error
                .userInfo()
                .objectForKey(NSURLErrorFailingURLErrorKey)
                .and_then(|value| value.downcast::<NSURL>().ok())
                .and_then(|url| url.absoluteString())
                .map(|s| s.to_string())
        };
        (self.ivars().sink)(NavigationEvent::Failed(LoadFailure {
            kind,
            message: error.localizedDescription().to_string(),
            url,
            provisional,
        }));
    }
}

/// Re-decide the identity for the page the webview shows (the preference
/// changed), from the webview's own URL. Main thread. A webview with no URL
/// yet (nothing committed) is left alone: its first navigation decides.
pub fn refresh_user_agent(webview: &wry::WebView) {
    let wk = webview.webview();
    // SAFETY: main thread, live webview.
    let url = unsafe { wk.URL().and_then(|u| u.absoluteString()) }
        .and_then(|s| tauri::Url::parse(&s.to_string()).ok());
    if let Some(url) = url {
        apply_user_agent(&wk, &url);
    }
}

/// Give the webview the user agent `profile::user_agent_for` wants for a
/// main-frame navigation to `url`, when that differs from what it presents
/// now. Called as the policy decision is answered, i.e. before the engine
/// sends the request: `customUserAgent` reaches the web process ahead of
/// the policy answer, so the request being decided already carries it (a
/// request the server redirects elsewhere keeps the identity it left with;
/// the destination's own requests follow the rule again).
fn apply_user_agent(webview: &WKWebView, url: &tauri::Url) {
    let wanted = profile::user_agent_for(url);
    // SAFETY: main thread, live webview.
    let current = unsafe { webview.customUserAgent() }.map(|s| s.to_string());
    if current.as_deref() == wanted {
        return;
    }
    tracing::debug!(
        "[browser] user agent for {}: {}",
        url.host_str().unwrap_or("?"),
        profile::user_agent_name(wanted)
    );
    let value = wanted.map(NSString::from_str);
    // SAFETY: main thread, live webview; `None` restores the engine's own.
    unsafe { webview.setCustomUserAgent(value.as_deref()) };
}

/// Wrap the webview's navigation delegate. Idempotent per webview.
pub fn install_navigation_delegate(webview: &wry::WebView, sink: NavigationSink) -> Result<(), String> {
    let mtm = mtm()?;
    let wk = webview.webview();
    let key = Retained::as_ptr(&wk) as usize;
    let installed = NAV_DELEGATES.with(|map| map.borrow().contains_key(&key));
    if installed {
        return Ok(());
    }
    // SAFETY: main thread, live webview.
    let inner = unsafe { wk.navigationDelegate() }
        .ok_or_else(|| "the webview has no navigation delegate to wrap".to_string())?;
    let delegate = CodegNavigationDelegate::new(inner, sink, mtm);
    // SAFETY: main thread; the wrapper is retained in `NAV_DELEGATES` below,
    // which is what keeps the weak `navigationDelegate` valid.
    unsafe { wk.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    NAV_DELEGATES.with(|map| map.borrow_mut().insert(key, delegate));
    Ok(())
}

/// Drop the wrapper of a webview that is going away (call before the wry
/// `WebView` is dropped, on the main thread).
pub fn forget_navigation_delegate(webview: &wry::WebView) {
    let key = webview_pointer(webview);
    NAV_DELEGATES.with(|map| map.borrow_mut().remove(&key));
    UI_DELEGATES.with(|map| map.borrow_mut().remove(&key));
}

// ---------------------------------------------------------------------------
// UI delegate: `window.close()`
// ---------------------------------------------------------------------------
//
// The same wrapper trick, for the other delegate. wry's `WKUIDelegate` is
// what answers the engine's request for a new window (that is how a popup
// becomes a tab) and it implements no `webViewDidClose:` at all, so a page
// closing its own window — the last step of every popup sign-in flow — used
// to reach nobody and left an empty tab behind.
//
// WebKit only calls it for a window a script opened, which is exactly the
// adopted popup; the host checks that again on its side (`page_may_close_itself`).

pub use super::PageCloseSink;

thread_local! {
    /// Wrappers by `WKWebView` pointer, kept alive here (`UIDelegate` is a
    /// weak property). Dropped with the navigation wrapper above.
    static UI_DELEGATES: RefCell<HashMap<usize, Retained<CodegUIDelegate>>> =
        RefCell::new(HashMap::new());
}

pub struct UIDelegateIvars {
    inner: Retained<ProtocolObject<dyn WKUIDelegate>>,
    sink: PageCloseSink,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = UIDelegateIvars]
    pub struct CodegUIDelegate;

    unsafe impl NSObjectProtocol for CodegUIDelegate {}

    impl CodegUIDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            self.class().responds_to(selector) || self.ivars().inner.respondsToSelector(selector)
        }

        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, _selector: Sel) -> *mut AnyObject {
            Retained::as_ptr(&self.ivars().inner) as *mut AnyObject
        }
    }

    unsafe impl WKUIDelegate for CodegUIDelegate {
        #[unsafe(method(webViewDidClose:))]
        fn web_view_did_close(&self, _webview: &WKWebView) {
            (self.ivars().sink)();
        }
    }
);

impl CodegUIDelegate {
    fn new(
        inner: Retained<ProtocolObject<dyn WKUIDelegate>>,
        sink: PageCloseSink,
        mtm: MainThreadMarker,
    ) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(UIDelegateIvars { inner, sink });
        // SAFETY: plain NSObject init.
        unsafe { msg_send![super(this), init] }
    }
}

/// Wrap the webview's UI delegate so `window.close()` reaches the host.
/// Idempotent per webview; not fatal when it cannot be done (the tab works,
/// only a page that closes itself is not heard).
pub fn install_page_close_hook(webview: &wry::WebView, sink: PageCloseSink) -> Result<(), String> {
    let mtm = mtm()?;
    let wk = webview.webview();
    let key = Retained::as_ptr(&wk) as usize;
    let installed = UI_DELEGATES.with(|map| map.borrow().contains_key(&key));
    if installed {
        return Ok(());
    }
    // SAFETY: main thread, live webview.
    let inner = unsafe { wk.UIDelegate() }
        .ok_or_else(|| "the webview has no UI delegate to wrap".to_string())?;
    let delegate = CodegUIDelegate::new(inner, sink, mtm);
    // SAFETY: main thread; the wrapper is retained in `UI_DELEGATES` above,
    // which is what keeps the weak `UIDelegate` valid.
    unsafe { wk.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    UI_DELEGATES.with(|map| map.borrow_mut().insert(key, delegate));
    Ok(())
}

// ---------------------------------------------------------------------------
// Profile: the tabs' own data store and its proxy
// ---------------------------------------------------------------------------

struct ProfileStore {
    store: Retained<WKWebsiteDataStore>,
    /// A store of the profile's own (macOS 14+) rather than WebKit's default
    /// store, which the app's own webviews live in.
    isolated: bool,
    /// Proxy last written to the store, to skip rewriting the same value.
    proxy: Option<BrowserProxy>,
}

thread_local! {
    /// Stores by profile id, created on first use and kept for the life of
    /// the main thread. Below macOS 14 an id maps to WebKit's default store
    /// (`isolated: false`); `profile::prepare` refuses every profile but
    /// `default` there, so that is the only id this map ever sees then.
    static PROFILES: RefCell<HashMap<String, ProfileStore>> = RefCell::new(HashMap::new());
}

/// The running release, `(major, minor)`. Safe from any thread.
pub fn macos_version() -> (isize, isize) {
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    (version.majorVersion, version.minorVersion)
}

fn macos_major_version() -> isize {
    macos_version().0
}

/// `WKWebsiteDataStore(forIdentifier:)` and `proxyConfigurations` both arrived
/// in macOS 14; before that the tabs share WebKit's default store with the app
/// and cannot be proxied. Safe from any thread.
pub fn supports_isolated_profile() -> bool {
    macos_major_version() >= 14
}

/// A profile's data store, created on first use and kept for the life of
/// the main thread. WebKit hands back the same store for the same
/// identifier, so owned windows built by tauri with that identifier share
/// it too.
fn profile_store(mtm: MainThreadMarker, profile_id: &str) -> Retained<WKWebsiteDataStore> {
    PROFILES.with(|slot| {
        let mut map = slot.borrow_mut();
        let entry = map.entry(profile_id.to_string()).or_insert_with(|| {
            let isolated = supports_isolated_profile();
            // SAFETY: main thread; WebKit owns the store.
            let store = unsafe {
                if isolated {
                    let identifier = NSUUID::from_bytes(profile::data_store_identifier(profile_id));
                    WKWebsiteDataStore::dataStoreForIdentifier(&identifier, mtm)
                } else {
                    WKWebsiteDataStore::defaultDataStore(mtm)
                }
            };
            ProfileStore {
                store,
                isolated,
                proxy: None,
            }
        });
        entry.store.clone()
    })
}

fn profile_is_isolated(profile_id: &str) -> bool {
    PROFILES.with(|slot| {
        slot.borrow()
            .get(profile_id)
            .map(|entry| entry.isolated)
            .unwrap_or(false)
    })
}

/// A `WKWebViewConfiguration` whose data store is the profile's. Every regular
/// tab is built from one; popups inherit their opener's instead (and with it
/// the opener's profile, and a remote profile's rules: the user content
/// controller is shared).
pub fn profile_configuration(
    mtm: MainThreadMarker,
    profile_id: &str,
) -> Result<Retained<WKWebViewConfiguration>, String> {
    let store = profile_store(mtm, profile_id);
    // SAFETY: main thread; both objects are live.
    let configuration = unsafe {
        let configuration = WKWebViewConfiguration::new(mtm);
        configuration.setWebsiteDataStore(&store);
        configuration
    };
    if profile::is_remote_profile(profile_id) {
        let rules = LOOPBACK_RULE_LIST.with(|slot| slot.borrow().clone()).ok_or_else(|| {
            format!("browser profile {profile_id} cannot keep its pages off this computer yet")
        })?;
        // SAFETY: main thread; the controller is the configuration's own.
        unsafe { configuration.userContentController().addContentRuleList(&rules) };
    }
    Ok(configuration)
}

/// A configuration for a document guest: a data store that lives in memory
/// and dies with the webview, so nothing a document stores outlives it or is
/// shared with browser tabs or the app. Nothing here depends on the macOS
/// version — non-persistent stores predate identifier-based ones.
pub fn document_configuration(mtm: MainThreadMarker) -> Retained<WKWebViewConfiguration> {
    // SAFETY: main thread; both objects are live.
    unsafe {
        let configuration = WKWebViewConfiguration::new(mtm);
        configuration.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(mtm));
        configuration
    }
}

// ---------------------------------------------------------------------------
// Remote-egress profiles: what WebKit sends around any proxy
// ---------------------------------------------------------------------------
//
// Network.framework sends `localhost` and loopback addresses straight to this
// machine whatever a store's proxy says, and nothing reaches that exception.
// So the tabs of a remote profile (`browser/egress.rs`) address the remote
// host's loopback through a `*.localhost` alias, which is proxied like any
// other name, and a content rule list stops whatever a page addresses to a
// loopback name itself: a request that fails is the right outcome for a page
// of the remote host, one answered by whatever listens on this computer's
// port of the same number is not.

/// Identifier of the list in the app's content-rule-list store.
const LOOPBACK_RULES_ID: &str = "codeg-remote-egress-loopback";

/// Everything addressed to this machine by a literal name, blocked: every
/// resource type (no `resource-type`), so documents, frames, subresources and
/// WebSockets alike. `url-filter` is WebKit's cut-down regex — no alternation,
/// hence one rule per name — and URLs reach it canonical: `127.1` arrives as
/// `127.0.0.1`, `[0:0::1]` as `[::1]`, `[::ffff:127.0.0.1]` as
/// `[::ffff:7f00:1]`. `*.localhost` names do not match: those are proxied.
const LOOPBACK_RULES_JSON: &str = r#"[
{"trigger":{"url-filter":"^[a-z]+://([^/]*@)?localhost\\.?[:/]"},"action":{"type":"block"}},
{"trigger":{"url-filter":"^[a-z]+://([^/]*@)?127\\.[0-9]+\\.[0-9]+\\.[0-9]+[:/]"},"action":{"type":"block"}},
{"trigger":{"url-filter":"^[a-z]+://([^/]*@)?0\\.0\\.0\\.0[:/]"},"action":{"type":"block"}},
{"trigger":{"url-filter":"^[a-z]+://([^/]*@)?\\[::1\\]"},"action":{"type":"block"}},
{"trigger":{"url-filter":"^[a-z]+://([^/]*@)?\\[::\\]"},"action":{"type":"block"}},
{"trigger":{"url-filter":"^[a-z]+://([^/]*@)?\\[::ffff:7f"},"action":{"type":"block"}}
]"#;

thread_local! {
    /// `LOOPBACK_RULES_JSON`, once compiled (once per run).
    static LOOPBACK_RULE_LIST: RefCell<Option<Retained<WKContentRuleList>>> = const { RefCell::new(None) };
    /// Probe pages by key, alive until their probe is over.
    static PROBE_VIEWS: RefCell<HashMap<String, Retained<WKWebView>>> = RefCell::new(HashMap::new());
}

/// Compile the loopback rules if that has not been done this run; `done`
/// hears how it went, on the main thread. A remote profile's tabs cannot be
/// built before this succeeds (`profile_configuration`).
pub fn prepare_loopback_rules(done: Box<dyn Fn(Result<(), String>) + 'static>) -> Result<(), String> {
    let mtm = mtm()?;
    if LOOPBACK_RULE_LIST.with(|slot| slot.borrow().is_some()) {
        done(Ok(()));
        return Ok(());
    }
    // SAFETY: main thread.
    let store = unsafe { WKContentRuleListStore::defaultStore(mtm) }
        .ok_or("WebKit has no content rule list store")?;
    let block = RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
        // SAFETY: WebKit passes a live list or a live error (or null), on the
        // main thread.
        let outcome = match unsafe { Retained::retain(list) } {
            Some(list) => {
                LOOPBACK_RULE_LIST.with(|slot| *slot.borrow_mut() = Some(list));
                Ok(())
            }
            None if !error.is_null() => Err(unsafe { &*error }.localizedDescription().to_string()),
            None => Err("the loopback rules did not compile".to_string()),
        };
        done(outcome);
    });
    // SAFETY: main thread; WebKit copies the block and calls it once.
    unsafe {
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&NSString::from_str(LOOPBACK_RULES_ID)),
            Some(&NSString::from_str(LOOPBACK_RULES_JSON)),
            Some(&block),
        );
    }
    Ok(())
}

/// Load `url` in a webview of `profile_id` that is never shown: the egress
/// probe's page (see `browser/egress.rs`). Built from the configuration the
/// profile's tabs get — store, proxy and rules — so what it proves holds for
/// them. A `WKWebView` in no window loads and runs its page all the same.
pub fn open_probe_view(profile_id: &str, url: &str, key: &str) -> Result<(), String> {
    let mtm = mtm()?;
    let configuration = profile_configuration(mtm, profile_id)?;
    let url = NSURL::URLWithString(&NSString::from_str(url)).ok_or("invalid probe address")?;
    // SAFETY: main thread; every object is live.
    let webview = unsafe {
        let frame = objc2_foundation::NSRect::new(
            objc2_foundation::NSPoint::new(0.0, 0.0),
            objc2_foundation::NSSize::new(800.0, 600.0),
        );
        let webview = WKWebView::initWithFrame_configuration(mtm.alloc(), frame, &configuration);
        let _ = webview.loadRequest(&objc2_foundation::NSURLRequest::requestWithURL(&url));
        webview
    };
    PROBE_VIEWS.with(|views| views.borrow_mut().insert(key.to_string(), webview));
    Ok(())
}

/// The probe is over: its page goes.
pub fn close_probe_view(key: &str) {
    if let Some(webview) = PROBE_VIEWS.with(|views| views.borrow_mut().remove(key)) {
        // SAFETY: main thread, live webview.
        unsafe { webview.stopLoading() };
    }
}

/// Create the profile's store if needed and point it at `proxy` (or at no
/// proxy). Open tabs use the new value for their next connections; setting the
/// same value again does nothing, so callers can be liberal.
pub fn ensure_profile(profile_id: &str, proxy: Option<BrowserProxy>) -> Result<(), String> {
    let mtm = mtm()?;
    let store = profile_store(mtm, profile_id);
    let unchanged = PROFILES.with(|slot| {
        slot.borrow()
            .get(profile_id)
            .is_some_and(|entry| entry.proxy == proxy)
    });
    if unchanged {
        return Ok(());
    }
    if !profile_is_isolated(profile_id) {
        return match proxy {
            Some(_) => Err("proxying browser tabs needs macOS 14 or later".to_string()),
            None => Ok(()),
        };
    }
    let remote = crate::browser::profile::is_remote_profile(profile_id);
    let configurations: Retained<NSArray<NSObject>> = match &proxy {
        Some(proxy) => NSArray::from_retained_slice(&[network::proxy_config(proxy, remote)?]),
        None => NSArray::new(),
    };
    // SAFETY: main thread; `proxyConfigurations` is a public property on
    // macOS 14+ (checked above). Written through KVC because objc2-web-kit
    // does not bind Network.framework's types.
    unsafe {
        let _: () = msg_send![&*store, setValue: &*configurations, forKey: ns_string!("proxyConfigurations")];
    }
    PROFILES.with(|slot| {
        if let Some(entry) = slot.borrow_mut().get_mut(profile_id) {
            entry.proxy = proxy;
        }
    });
    Ok(())
}

/// The proxy setting changed: re-point every store that exists. A profile
/// whose store has not been created yet gets the proxy when it is
/// (`ensure_profile` from `profile::prepare`).
pub fn apply_proxy_to_profiles(proxy: Option<BrowserProxy>) -> Result<(), String> {
    // A remote profile's proxy is its egress, whatever the app's setting says.
    let ids: Vec<String> = PROFILES.with(|slot| {
        slot.borrow()
            .keys()
            .filter(|id| !crate::browser::profile::is_remote_profile(id))
            .cloned()
            .collect()
    });
    let mut first_error = None;
    for id in ids {
        if let Err(err) = ensure_profile(&id, proxy.clone()) {
            first_error.get_or_insert(err);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Remove every kind of website data (cookies, caches, storage, …) from the
/// profile, whether or not a tab is open. With a store of its own (macOS 14+)
/// that is the whole store; when the tabs still share WebKit's default store
/// with the app, see `clear_shared_store_except_app`. `done` runs on the main
/// thread once WebKit has finished.
pub fn clear_profile_store(profile_id: &str, done: impl Fn() + 'static) -> Result<(), String> {
    let mtm = mtm()?;
    let store = profile_store(mtm, profile_id);
    if !profile_is_isolated(profile_id) {
        return clear_shared_store_except_app(done);
    }
    // SAFETY: main thread; WebKit owns every object handed back.
    unsafe {
        let types = WKWebsiteDataStore::allWebsiteDataTypes(mtm);
        let since = NSDate::dateWithTimeIntervalSince1970(0.0);
        let handler = RcBlock::new(done);
        store.removeDataOfTypes_modifiedSince_completionHandler(&types, &since, &handler);
    }
    Ok(())
}

/// Delete a profile's store altogether (macOS 14+): its files go, and the
/// identifier is free to be created anew. WebKit refuses while anything
/// still holds a `WKWebsiteDataStore` for the identifier — a webview, a
/// reference of ours, or an autoreleased one from earlier in the same
/// run-loop turn — so the caller has closed the profile's tabs and runs this
/// on a turn of its own; the reference kept here is dropped before asking.
/// `done` runs on the main thread with WebKit's verdict.
///
/// Removal alone deletes what is on disk: the network process keeps a
/// session for a store it recently served, cookies included, and a store
/// created again under the same identifier right after would find them
/// still there (seen live). `clear_profile_store` first, then this.
pub fn remove_profile_store(
    profile_id: &str,
    done: impl Fn(Result<(), String>) + 'static,
) -> Result<(), String> {
    let mtm = mtm()?;
    if !supports_isolated_profile() {
        return Err("browser profiles need macOS 14 or later".to_string());
    }
    PROFILES.with(|slot| slot.borrow_mut().remove(profile_id));
    let identifier = NSUUID::from_bytes(profile::data_store_identifier(profile_id));
    let handler = RcBlock::new(move |error: *mut NSError| {
        // SAFETY: WebKit passes nil or a live error, on the main thread.
        let result = match unsafe { error.as_ref() } {
            None => Ok(()),
            Some(error) => Err(error.localizedDescription().to_string()),
        };
        done(result);
    });
    // SAFETY: main thread; a valid identifier and a live block.
    unsafe { WKWebsiteDataStore::removeDataStoreForIdentifier_completionHandler(&identifier, &handler, mtm) };
    Ok(())
}

/// Clear WebKit's default store one origin at a time, leaving the app's own
/// origins alone: below macOS 14 the tabs have no store of their own, and a
/// blanket removal would wipe the workspace's localStorage along with the
/// pages' cookies.
pub fn clear_shared_store_except_app(done: impl Fn() + 'static) -> Result<(), String> {
    let mtm = mtm()?;
    // SAFETY: main thread; WebKit owns the store.
    let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
    let types = unsafe { WKWebsiteDataStore::allWebsiteDataTypes(mtm) };
    let done = std::rc::Rc::new(done);
    let removing_store = store.clone();
    let removing_types = types.clone();
    let fetched = RcBlock::new(move |records: std::ptr::NonNull<NSArray<WKWebsiteDataRecord>>| {
        // SAFETY: WebKit passes a live array on the main thread.
        let records = unsafe { records.as_ref() };
        let victims: Vec<Retained<WKWebsiteDataRecord>> = records
            .iter()
            .filter(|record| {
                // SAFETY: live record.
                let name = unsafe { record.displayName() };
                !is_app_origin(&name.to_string())
            })
            .collect();
        let victims = NSArray::from_retained_slice(&victims);
        let done = done.clone();
        let finished = RcBlock::new(move || done());
        // SAFETY: main thread; all three arguments are live.
        unsafe {
            removing_store.removeDataOfTypes_forDataRecords_completionHandler(
                &removing_types,
                &victims,
                &finished,
            );
        }
    });
    // SAFETY: main thread.
    unsafe { store.fetchDataRecordsOfTypes_completionHandler(&types, &fetched) };
    Ok(())
}

/// Display names of every record in WebKit's default store (dev puppet only:
/// evidence that the per-record path spares the app's origins).
pub fn default_store_record_names(done: impl Fn(Vec<String>) + 'static) -> Result<(), String> {
    let mtm = mtm()?;
    // SAFETY: main thread; WebKit owns the store.
    let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
    let types = unsafe { WKWebsiteDataStore::allWebsiteDataTypes(mtm) };
    let fetched = RcBlock::new(move |records: std::ptr::NonNull<NSArray<WKWebsiteDataRecord>>| {
        // SAFETY: WebKit passes a live array on the main thread.
        let records = unsafe { records.as_ref() };
        let names = records
            .iter()
            // SAFETY: live record.
            .map(|record| unsafe { record.displayName() }.to_string())
            .collect();
        done(names);
    });
    // SAFETY: main thread.
    unsafe { store.fetchDataRecordsOfTypes_completionHandler(&types, &fetched) };
    Ok(())
}

/// Hosts the app's own webviews are served from — `http://localhost:<port>`
/// in development, `tauri://localhost` and `http://tauri.localhost` in release
/// — as WebKit names their data records.
fn is_app_origin(display_name: &str) -> bool {
    display_name == "localhost" || display_name.ends_with(".localhost")
}

mod network {
    //! Network.framework's proxy-config C API, resolved at run time: the
    //! symbols exist only on macOS 14+, and a load-time reference would keep
    //! the whole binary from launching on older systems. The objects it hands
    //! back are Objective-C objects (`OS_object`), which is what lets them
    //! ride in an `NSArray` and be retained like any other.

    use std::ffi::{c_char, c_void, CString};

    use objc2::rc::Retained;
    use objc2::runtime::NSObject;

    use super::{BrowserProxy, ProxyScheme};

    type CreateHost = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut NSObject;
    type CreateSocks5 = unsafe extern "C" fn(*mut NSObject) -> *mut NSObject;
    type CreateHttpConnect = unsafe extern "C" fn(*mut NSObject, *mut NSObject) -> *mut NSObject;
    type AddExcludedDomain = unsafe extern "C" fn(*mut NSObject, *const c_char);
    type SetFailoverAllowed = unsafe extern "C" fn(*mut NSObject, bool);

    /// Connections to these hosts never go through the proxy: pages served
    /// from this machine (dev servers, codeg's own bridges) are the point of
    /// the built-in browser and must keep working whatever the proxy would do
    /// with them — the exception every browser and the `NO_PROXY` convention
    /// make. A remote-egress profile wants the opposite, and gets none.
    const EXCLUDED_DOMAINS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

    fn symbol(name: &str) -> Result<*mut c_void, String> {
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        // SAFETY: a valid C string; RTLD_DEFAULT searches every loaded image.
        let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c_name.as_ptr()) };
        if pointer.is_null() {
            Err(format!("{name} is not available on this macOS"))
        } else {
            Ok(pointer)
        }
    }

    /// `egress`: the configuration of a remote-egress profile — nothing
    /// excluded, and no failing over to a direct connection when the proxy
    /// cannot be reached: a direct connection would reach this computer, not
    /// the remote host the page belongs to. (WebKit still sends `localhost`
    /// and loopback addresses straight here whatever this says; the remote
    /// profile's tabs use a `*.localhost` alias for those, and a content
    /// rule stops what a page itself sends there.)
    pub fn proxy_config(proxy: &BrowserProxy, egress: bool) -> Result<Retained<NSObject>, String> {
        // SAFETY: the signatures are Network.framework's declared ones.
        let (create_host, create_socks5, create_http_connect, add_excluded_domain) = unsafe {
            (
                std::mem::transmute::<*mut c_void, CreateHost>(symbol("nw_endpoint_create_host")?),
                std::mem::transmute::<*mut c_void, CreateSocks5>(symbol("nw_proxy_config_create_socksv5")?),
                std::mem::transmute::<*mut c_void, CreateHttpConnect>(symbol("nw_proxy_config_create_http_connect")?),
                std::mem::transmute::<*mut c_void, AddExcludedDomain>(symbol("nw_proxy_config_add_excluded_domain")?),
            )
        };
        let host = CString::new(proxy.host.as_str()).map_err(|e| format!("proxy host: {e}"))?;
        let port = CString::new(proxy.port.to_string()).map_err(|e| format!("proxy port: {e}"))?;
        // SAFETY: valid C strings; every `create` follows the create rule
        // (+1), which `Retained::from_raw` takes over.
        unsafe {
            let endpoint = Retained::from_raw(create_host(host.as_ptr(), port.as_ptr()))
                .ok_or_else(|| format!("cannot describe proxy endpoint {}:{}", proxy.host, proxy.port))?;
            let endpoint_ptr = Retained::as_ptr(&endpoint) as *mut NSObject;
            let config = match proxy.scheme {
                ProxyScheme::Http => create_http_connect(endpoint_ptr, std::ptr::null_mut()),
                ProxyScheme::Socks5 => create_socks5(endpoint_ptr),
            };
            let config = Retained::from_raw(config).ok_or("cannot create proxy configuration")?;
            let config_ptr = Retained::as_ptr(&config) as *mut NSObject;
            if egress {
                let set_failover_allowed = std::mem::transmute::<*mut c_void, SetFailoverAllowed>(
                    symbol("nw_proxy_config_set_failover_allowed")?,
                );
                set_failover_allowed(config_ptr, false);
            } else {
                for domain in EXCLUDED_DOMAINS {
                    let domain = CString::new(domain).expect("static");
                    add_excluded_domain(config_ptr, domain.as_ptr());
                }
            }
            Ok(config)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_app_origin;

    /// The per-record clear must spare every host the app's own webviews are
    /// served from and nothing else.
    #[test]
    fn app_origins_are_recognised_by_record_name() {
        assert!(is_app_origin("localhost"));
        assert!(is_app_origin("tauri.localhost"));
        assert!(!is_app_origin("example.com"));
        assert!(!is_app_origin("127.0.0.1"));
        assert!(!is_app_origin("localhost.example.com"));
    }
}
