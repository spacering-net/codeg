//! GTK regressions share one test thread and one Tauri event loop.
#![allow(deprecated)] // Bounded test pumping of the event loop.
use super::*;
use crate::browser::types::SurfaceChoice;
use crate::browser::{
    downloads::BrowserDownloads, policy::BrowserPolicy, registry::BrowserRegistry,
};
use tauri::{Listener, Manager};
use webkit2gtk::WebViewExt;

/// All native checks run on this one thread; serial Rust tests still use
/// different threads and therefore cannot share GTK initialization.
#[test]
#[ignore = "requires X11 GTK/WebKit (xvfb-run)"]
fn linux_browser_regressions() {
    let root = tempfile::Builder::new()
        .prefix("browser-gui-")
        .tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target"))
        .unwrap()
        .keep();
    let config = root.join("config");
    let downloads = root.join("downloads");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&downloads).unwrap();
    std::fs::write(
        config.join("user-dirs.dirs"),
        format!("XDG_DOWNLOAD_DIR=\"{}\"\n", downloads.display()),
    )
    .unwrap();
    temp_env::with_vars(
        [
            ("CODEG_HOME", None),
            ("CODEG_DATA_DIR", Some(root.to_str().unwrap())),
            ("XDG_CONFIG_HOME", Some(config.to_str().unwrap())),
            ("GTK_IM_MODULE", Some("simple")),
        ],
        || {
            let mut context = tauri::generate_context!();
            context.config_mut().identifier = "app.codeg.linux-browser-test".into();
            let mut app = tauri::Builder::default()
                .any_thread()
                .manage(BrowserRegistry::default())
                .manage(BrowserPolicy::default())
                .manage(BrowserDownloads::default())
                .build(context)
                .unwrap();
            app.run_iteration(|_, _| {});
            crate::browser::surface_child::init_main_thread();
            crate::browser::surface_window::init_main_thread();
            let owner = tauri::WebviewWindowBuilder::new(
                &app,
                "main",
                tauri::WebviewUrl::External(tauri::Url::parse("about:blank").unwrap()),
            )
            .decorations(false)
            .inner_size(800.0, 600.0)
            .build()
            .unwrap();
            eprintln!("GUI: address input");
            embedded_browser_preserves_tauri_address_input(&mut app, &owner);
            eprintln!("GUI: overlay routing, bounds and focus");
            browser_layer_keeps_workspace_and_page_input_reachable();
            browser_layer_preserves_workspace_layout_and_updated_bounds();
            browser_layer_keeps_workspace_focus();
            hidden_page_hands_keys_to_the_workspace();
            eprintln!("GUI: shared profile cookies and clearing");
            mixed_surfaces_share_profile_state(&mut app, &owner);
            eprintln!("GUI: download attribution and closed source");
            downloads_follow_the_source_tab(&mut app, &owner, &downloads);
            eprintln!("GUI: iframe notices");
            frame_denials_stay_quiet(&mut app, &owner);
            eprintln!("GUI: focus handed back on hide");
            hiding_a_focused_page_hands_focus_back(&mut app, &owner);
            crate::commands::browser::close_all_for_owner(app.handle(), owner.label());
            owner.close().unwrap();
            app.cleanup_before_exit();
        },
    );
}

fn pump_until(app: &mut tauri::App, what: &str, ready: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !ready() {
        assert!(std::time::Instant::now() < deadline, "timed out: {what}");
        app.run_iteration(|_, _| {});
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

fn eval(app: &mut tauri::App, view: &webkit2gtk::WebView, script: &str) -> String {
    use javascriptcore::ValueExt;
    let result = std::rc::Rc::new(std::cell::RefCell::new(None));
    let output = result.clone();
    view.evaluate_javascript(
        script,
        None,
        None,
        None::<&gtk::gio::Cancellable>,
        move |value| {
            *output.borrow_mut() = Some(value.unwrap().to_str().to_string());
        },
    );
    pump_until(app, "JavaScript result", || result.borrow().is_some());
    let value = result.borrow_mut().take().unwrap();
    value
}

fn open_tab(
    app: &mut tauri::App,
    owner: &tauri::WebviewWindow,
    id: &str,
    surface: SurfaceChoice,
    profile: &str,
) -> webkit2gtk::WebView {
    crate::commands::browser::open_tab_core(
        app.handle(),
        owner,
        &app.state(),
        crate::commands::browser::OpenTabParams {
            tab_id: id.into(),
            url: "about:blank".into(),
            bounds: Bounds {
                x: 400.0,
                y: 150.0,
                width: 300.0,
                height: 300.0,
            },
            background: false,
            surface,
            devtools: false,
            profile: profile.into(),
            zoom: None,
        },
    )
    .unwrap();
    let view = if matches!(surface, SurfaceChoice::Window) {
        app.get_webview_window(&crate::browser::tab_label(id))
            .unwrap()
            .default_vbox()
            .unwrap()
            .children()
            .into_iter()
            .find_map(|w| w.downcast::<webkit2gtk::WebView>().ok())
            .unwrap()
    } else {
        container(owner)
            .unwrap()
            .children()
            .last()
            .unwrap()
            .clone()
            .downcast::<webkit2gtk::WebView>()
            .unwrap()
    };
    view.load_html(
        "<title>ready</title><p>fixture</p>",
        Some("https://profile.test/"),
    );
    pump_until(app, "fixture page load", || {
        view.title().as_deref() == Some("ready") && !view.is_loading()
    });
    view
}

fn close_tab(app: &tauri::App, id: &str) {
    crate::commands::browser::close_core(app.handle(), &app.state(), id, None).unwrap();
}

/// Existing Wry text cookies must survive the switch to embedded surfaces.
fn mixed_surfaces_share_profile_state(app: &mut tauri::App, owner: &tauri::WebviewWindow) {
    let directory = crate::browser::profile::directory("gui-profile");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("cookies"),
        "# Netscape HTTP Cookie File\nprofile.test\tFALSE\t/\tFALSE\t2147483647\tsession\tlegacy\n",
    )
    .unwrap();
    let child = open_tab(
        app,
        owner,
        "profile-child",
        SurfaceChoice::Child,
        "gui-profile",
    );
    let window = open_tab(
        app,
        owner,
        "profile-window",
        SurfaceChoice::Window,
        "gui-profile",
    );
    assert_eq!(eval(app, &child, "window.opener === null"), "true");
    assert_eq!(eval(app, &window, "window.opener === null"), "true");
    assert_eq!(eval(app, &child, "document.cookie"), "session=legacy");
    assert_eq!(eval(app, &window, "document.cookie"), "session=legacy");
    eval(
        app,
        &child,
        "document.cookie = 'session=child; path=/'; document.cookie",
    );
    assert_eq!(
        eval(app, &window, "document.cookie"),
        "session=child",
        "a profile must share live cookies across surfaces"
    );
    eval(
        app,
        &window,
        "document.cookie = 'session=window; path=/'; document.cookie",
    );
    assert_eq!(eval(app, &child, "document.cookie"), "session=window");
    tauri::async_runtime::block_on(crate::commands::browser::clear_data_core(
        app.handle(),
        &app.state(),
        "gui-profile",
    ))
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !eval(app, &window, "document.cookie").is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "profile clear did not reach the owned window"
        );
    }
    assert_eq!(eval(app, &child, "document.cookie"), "");
    close_tab(app, "profile-child");
    close_tab(app, "profile-window");
}

fn downloads_follow_the_source_tab(
    app: &mut tauri::App,
    owner: &tauri::WebviewWindow,
    dir: &std::path::Path,
) {
    use crate::browser::downloads::DownloadState;
    let _first = open_tab(
        app,
        owner,
        "download-first",
        SurfaceChoice::Child,
        "gui-downloads",
    );
    let second = open_tab(
        app,
        owner,
        "download-second",
        SurfaceChoice::Child,
        "gui-downloads",
    );
    let window = open_tab(
        app,
        owner,
        "download-window",
        SurfaceChoice::Window,
        "gui-downloads",
    );
    for (view, expected, payload) in [
        (&second, "download-second", "second"),
        (&window, "download-window", "window"),
    ] {
        let before = app.state::<BrowserDownloads>().list().len();
        view.download_uri(&format!("data:application/octet-stream,{payload}"));
        let handle = app.handle().clone();
        pump_until(app, "download completion", || {
            let entries = handle.state::<BrowserDownloads>().list();
            entries.len() > before && entries.last().unwrap().state != DownloadState::Started
        });
        let entries = app.state::<BrowserDownloads>().list();
        let entry = entries.last().unwrap();
        assert_eq!(entry.tab_id, expected);
        assert_eq!(entry.state, DownloadState::Completed);
        assert!(std::path::Path::new(&entry.path).starts_with(dir));
        assert_eq!(std::fs::read(&entry.path).unwrap(), payload.as_bytes());
        if expected == "download-second" {
            close_tab(app, "download-first");
        }
    }
    close_tab(app, "download-second");
    close_tab(app, "download-window");
}

fn frame_denials_stay_quiet(app: &mut tauri::App, owner: &tauri::WebviewWindow) {
    let view = open_tab(app, owner, "frame-tab", SurfaceChoice::Child, "gui-frames");
    let notices = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let received = notices.clone();
    let listener = app.listen("browser://navigation-blocked", move |event| {
        received.lock().unwrap().push(event.payload().into())
    });
    view.load_html(
        "<iframe src='data:text/html,frame'></iframe><title>frames-ready</title>",
        Some("https://profile.test/"),
    );
    pump_until(app, "iframe load", || {
        view.title().as_deref() == Some("frames-ready") && !view.is_loading()
    });
    assert!(
        notices.lock().unwrap().is_empty(),
        "iframe denials must not produce a top-level blocked notice"
    );
    view.load_uri("file:///codeg-test-denied");
    pump_until(app, "top-level scheme refusal", || {
        !notices.lock().unwrap().is_empty()
    });
    assert!(notices.lock().unwrap()[0].contains("file:///codeg-test-denied"));
    app.unlisten(listener);
    close_tab(app, "frame-tab");
}

/// An overlay that hides a page holding the keyboard must get the keyboard:
/// GTK leaves the window with no focus widget at all once that page is hidden.
fn hiding_a_focused_page_hands_focus_back(app: &mut tauri::App, owner: &tauri::WebviewWindow) {
    let page = open_tab(app, owner, "focus-tab", SurfaceChoice::Child, "gui-focus");
    page.grab_focus();
    assert!(page.is_focus(), "fixture: the page holds the keyboard");
    tauri::async_runtime::block_on(crate::commands::browser::set_visible_core(
        owner,
        &app.state(),
        "focus-tab",
        false,
        true,
        false,
    ))
    .unwrap();
    let workspace = owner
        .gtk_window()
        .unwrap()
        .child()
        .and_then(|layer| layer.downcast::<gtk::Overlay>().ok())
        .and_then(|layer| layer.child())
        .expect("the workspace under the browser layer");
    assert!(
        workspace.is_focus(),
        "hiding the page must hand the keyboard to the workspace"
    );
    close_tab(app, "focus-tab");
}

/// Exercise Tauri's real borderless-window handlers, which plain GTK/Wry
/// fixtures do not install. Clicking the address input must also allow typing.
fn embedded_browser_preserves_tauri_address_input(
    app: &mut tauri::App,
    owner: &tauri::WebviewWindow,
) {
    use gtk::glib::translate::ToGlibPtr;
    use std::cell::Cell;
    use std::rc::Rc;
    use tauri_runtime_wry::wry::{WebViewBuilder, WebViewBuilderExtUnix};

    let html = "<input id='address' style='position:absolute;left:20px;top:20px;width:200px;height:40px'><script>document.title='fixture-ready'</script>";
    let workspace = owner
        .default_vbox()
        .unwrap()
        .children()
        .into_iter()
        .find_map(|child| child.downcast::<webkit2gtk::WebView>().ok())
        .unwrap();
    workspace.load_html(html, None);
    pump_until(app, "workspace page load", || {
        workspace.title().as_deref() == Some("fixture-ready")
    });

    let fixed = container(owner).expect("browser layer");
    let page = WebViewBuilder::new()
        .with_bounds(wry::Rect {
            position: wry::dpi::LogicalPosition::new(400, 150).into(),
            size: wry::dpi::LogicalSize::new(300, 300).into(),
        })
        .with_html("<input id='page'><script>document.title='browser-ready'</script>")
        .build_gtk(&fixed)
        .expect("embedded browser");
    pump_until(app, "browser page load", || {
        page.webview().title().as_deref() == Some("browser-ready")
    });
    assert_eq!(
        container(owner).unwrap(),
        fixed,
        "reuse the workspace's browser layer"
    );
    owner.set_focus().unwrap();
    // Xvfb has no window manager to activate the test window for keyboard input.
    owner
        .gtk_window()
        .unwrap()
        .window()
        .unwrap()
        .focus(gtk::gdk::ffi::GDK_CURRENT_TIME as u32);

    let clicked = Rc::new(Cell::new(false));
    let received = clicked.clone();
    workspace.connect_button_press_event(move |_, _| {
        received.set(true);
        gtk::glib::Propagation::Proceed
    });
    let native = workspace.window().unwrap();
    let seat = workspace.display().default_seat().unwrap();
    let (_, root_x, root_y) = native.origin();
    for kind in [
        gtk::gdk::EventType::ButtonPress,
        gtk::gdk::EventType::ButtonRelease,
    ] {
        let mut event = gtk::gdk::Event::new(kind)
            .downcast::<gtk::gdk::EventButton>()
            .unwrap();
        event.as_mut().window = native.to_glib_full();
        event.as_mut().button = 1;
        event.as_mut().x = 50.0;
        event.as_mut().y = 40.0;
        event.as_mut().x_root = f64::from(root_x + 50);
        event.as_mut().y_root = f64::from(root_y + 40);
        event.set_device(seat.pointer().as_ref());
        workspace.event(&event);
    }
    workspace.display().sync();
    pump_until(app, "workspace click", || clicked.get());
    assert_eq!(
        eval(app, &workspace, "document.activeElement.id"),
        "address"
    );
    let key = gtk::gdk::Keymap::for_display(&workspace.display())
        .unwrap()
        .entries_for_keyval(u32::from(b'x'))
        .into_iter()
        .find(|key| key.level() == 0)
        .unwrap();
    for kind in [
        gtk::gdk::EventType::KeyPress,
        gtk::gdk::EventType::KeyRelease,
    ] {
        let mut event = gtk::gdk::Event::new(kind)
            .downcast::<gtk::gdk::EventKey>()
            .unwrap();
        event.as_mut().window = native.to_glib_full();
        event.as_mut().keyval = u32::from(b'x');
        event.as_mut().hardware_keycode = key.keycode() as u16;
        event.as_mut().group = key.group() as u8;
        event.as_mut().length = 1;
        event.as_mut().string = "x".to_glib_full();
        event.set_device(seat.keyboard().as_ref());
        workspace.event(&event);
    }
    workspace.display().sync();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut value = eval(app, &workspace, "document.querySelector('#address').value");
    // WebKit applies the native key event asynchronously in its web process.
    while value.is_empty() && std::time::Instant::now() < deadline {
        app.run_iteration(|_, _| {});
        std::thread::sleep(std::time::Duration::from_millis(5));
        value = eval(app, &workspace, "document.querySelector('#address').value");
    }
    assert_eq!(value, "x");
    drop(page);
}

/// A full-window overlay must not steal toolbar/sidebar input, while its
/// browser child must still receive input. Run under xvfb-run (X11).
fn browser_layer_keeps_workspace_and_page_input_reachable() {
    gtk::init().expect("GTK display");
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_default_size(800, 600);
    let vbox = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let workspace = gtk::DrawingArea::new();
    window.add(&vbox);
    vbox.pack_start(&workspace, true, true, 0);
    window.show_all();

    let fixed = attach_container(&window, &vbox, workspace.upcast_ref());
    let page = gtk::DrawingArea::new();
    page.set_size_request(300, 300);
    fixed.put(&page, 400, 150);
    page.show();

    let display = window.display();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while page.allocation().width() != 300 {
        assert!(std::time::Instant::now() < deadline, "GTK layout timed out");
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    display.sync();
    let pointer = display.default_seat().unwrap().pointer().unwrap();
    let screen = WidgetExt::screen(&window).unwrap();
    let (_, x, y) = window.window().unwrap().origin();
    for (point, target) in [
        ((50, 50), workspace.window().unwrap()),
        ((450, 200), page.window().unwrap()),
    ] {
        pointer.warp(&screen, x + point.0, y + point.1);
        display.sync();
        assert_eq!(
            pointer.window_at_position().0,
            Some(target),
            "input at {point:?} must reach the intended widget"
        );
    }
    unsafe { window.destroy() };
}

/// Run with xvfb-run: real GTK allocations catch stale Fixed coordinates
/// and an overlay accidentally contributing to the main window's minimum size.
fn browser_layer_preserves_workspace_layout_and_updated_bounds() {
    gtk::init().expect("GTK display");
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    let vbox = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let workspace = gtk::DrawingArea::new();
    workspace.set_size_request(100, 80);
    window.add(&vbox);
    vbox.pack_start(&workspace, true, true, 0);
    let fixed = attach_container(&window, &vbox, workspace.upcast_ref());
    let page = gtk::DrawingArea::new();
    fixed.put(&page, 10, 20);
    window.show_all();

    for bounds in [
        Bounds {
            x: 600.0,
            y: 80.0,
            width: 360.0,
            height: 500.0,
        },
        Bounds {
            x: 400.0,
            y: 90.0,
            width: 240.0,
            height: 300.0,
        },
    ] {
        position_widget(&fixed, page.upcast_ref(), bounds);
        // Repeated allocations must preserve the latest position and size.
        for _ in 0..2 {
            fixed.size_allocate(&gtk::Allocation::new(0, 0, 1000, 700));
            let actual = page.allocation();
            assert_eq!((actual.x(), actual.y()), (bounds.x as i32, bounds.y as i32));
            assert_eq!(
                (actual.width(), actual.height()),
                (bounds.width as i32, bounds.height as i32)
            );
        }
    }
    let content = window.child().unwrap();
    assert_eq!(content.preferred_width().0, 100);
    assert_eq!(content.preferred_height().0, 80);
    assert_eq!(workspace.toplevel(), Some(window.clone().upcast()));
    unsafe { window.destroy() };
}

/// Moving the workspace under the overlay takes it out of its parent, which
/// drops the window's keyboard focus; the workspace that had it gets it back.
fn browser_layer_keeps_workspace_focus() {
    gtk::init().expect("GTK display");
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    let vbox = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let workspace = gtk::DrawingArea::new();
    workspace.set_can_focus(true);
    window.add(&vbox);
    vbox.pack_start(&workspace, true, true, 0);
    window.show_all();
    workspace.grab_focus();
    assert!(
        workspace.is_focus(),
        "fixture: the workspace holds the keyboard"
    );
    attach_container(&window, &vbox, workspace.upcast_ref());
    assert!(
        workspace.is_focus(),
        "the workspace must keep the keyboard across the move"
    );
    unsafe { window.destroy() };
}

/// What handing the keyboard back is for: once the page that held it is
/// hidden, a key typed into the window reaches the workspace — where the
/// overlay that asked for the hide lives — instead of going nowhere.
fn hidden_page_hands_keys_to_the_workspace() {
    gtk::init().expect("GTK display");
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    let vbox = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let workspace = gtk::Entry::new();
    window.add(&vbox);
    vbox.pack_start(&workspace, true, true, 0);
    window.show_all();
    let fixed = attach_container(&window, &vbox, workspace.upcast_ref());
    let page = gtk::Entry::new();
    fixed.put(&page, 10, 10);
    page.show();
    page.grab_focus();
    assert!(page.is_focus(), "fixture: the page holds the keyboard");

    release_focus_of(page.upcast_ref());
    page.hide();
    type_into_window(&window, 'y');
    assert_eq!(workspace.text(), "y", "the key must reach the workspace");
    assert_eq!(page.text(), "");
    unsafe { window.destroy() };
}

/// A key pressed and released in `window`, routed the way GTK routes one:
/// to whichever widget holds the window's keyboard focus.
fn type_into_window(window: &gtk::Window, key: char) {
    use gtk::glib::translate::ToGlibPtr;
    let native = window.window().unwrap();
    let display = WidgetExt::display(window);
    let seat = display.default_seat().unwrap();
    let keyval = u32::from(key);
    let entry = gtk::gdk::Keymap::for_display(&display)
        .unwrap()
        .entries_for_keyval(keyval)
        .into_iter()
        .find(|entry| entry.level() == 0)
        .unwrap();
    for kind in [
        gtk::gdk::EventType::KeyPress,
        gtk::gdk::EventType::KeyRelease,
    ] {
        let mut event = gtk::gdk::Event::new(kind)
            .downcast::<gtk::gdk::EventKey>()
            .unwrap();
        event.as_mut().window = native.to_glib_full();
        event.as_mut().keyval = keyval;
        event.as_mut().hardware_keycode = entry.keycode() as u16;
        event.as_mut().group = entry.group() as u8;
        event.as_mut().length = 1;
        event.as_mut().string = key.to_string().to_glib_full();
        event.set_device(seat.keyboard().as_ref());
        window.event(&event);
    }
}
