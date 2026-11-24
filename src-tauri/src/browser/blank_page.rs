//! The empty tab's page: `about:blank`, painted in the app's own colours.
//!
//! The engine's blank document is white in every theme, and it is the one
//! surface in the app that cannot be styled from the app's stylesheet — a
//! native webview paints itself. That white is also what the engine HOLDS on
//! the way to a page (nothing else is painted until the new document does),
//! so in a dark theme it is both what an empty tab shows for as long as it is
//! empty and what flashes on the way to the first page in it.
//!
//! So the host paints it. The frontend owns the colour — it is a variable of
//! the running theme, which the person can change at any time — and pushes it
//! here at startup and on every change (`browser_set_blank_page_theme`); each
//! blank document a tab commits is painted with what was last pushed, and a
//! change repaints the ones already open.
//!
//! Only a tab's OWN blank page:
//! - a popup adopted from `window.open` sits on `about:blank` too, and its
//!   OPENER writes the document into it. The root's background is what fills
//!   the viewport, so painting one there would put our colour behind somebody
//!   else's page — and a white receipt written into a dark-themed popup would
//!   come out with a dark margin around it.
//! - a document guest (`codeg-doc:`) shows a file, never the blank page.

use std::sync::RwLock;

use crate::browser::registry::BrowserRegistry;
use crate::browser::types::{BrowserTabState, TabKind};

/// How the empty tab's page should look, as the frontend reads it off the
/// running theme.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlankPageTheme {
    /// The app's `--background`, resolved to `#rrggbb` — the same colour the
    /// placeholder the webview sits in is painted with, so hiding the surface
    /// (an overlay, a notice) changes nothing on screen.
    pub background: String,
    /// Which scheme that colour belongs to. Sets `color-scheme` on the
    /// document, so the scrollbars and form controls of anything that ends up
    /// in it are the matching ones rather than the light default.
    pub dark: bool,
}

static THEME: RwLock<Option<BlankPageTheme>> = RwLock::new(None);

/// A `#rrggbb` colour and nothing else. The value is interpolated into a
/// script, and it reaches us from a CSS variable that a theme — including a
/// hand-written custom one — can put anything at all in, so it is checked
/// here rather than trusted.
fn is_hex_colour(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Record what the blank page should look like. Refuses a colour that is not
/// `#rrggbb`; the previous one (if any) stays, since a blank page in the last
/// known colour beats one in the engine's white.
pub fn set(theme: BlankPageTheme) -> Result<(), String> {
    if !is_hex_colour(&theme.background) {
        return Err(format!(
            "the blank page's background must be #rrggbb, not {:?}",
            theme.background
        ));
    }
    *THEME.write().unwrap_or_else(|p| p.into_inner()) = Some(theme);
    Ok(())
}

/// The script that paints one blank document, or `None` while nothing has
/// been pushed yet (the first tab of a run can open before the frontend's
/// startup push lands, and it is repainted when it does).
pub fn paint_script() -> Option<String> {
    let theme = THEME.read().unwrap_or_else(|p| p.into_inner()).clone()?;
    Some(script_for(&theme))
}

/// An inline style on the ROOT element: the root's background is what fills
/// the viewport (`<body>` need not even exist yet at the moment a document
/// commits), and painting again — a theme change — is one more assignment
/// rather than a node to find and replace.
///
/// The script asks the page what it is before it paints, and that question is
/// the one thing here that cannot be asked from this side: our caller decided
/// on a CLONE of the tab's state, and the eval runs on the main thread some
/// time after that, so the document that receives it need not be the one that
/// was looked at. Somebody else's page must not come out in our colours, and
/// only the page itself knows, at the moment the script runs, whether it is
/// still the blank one.
fn script_for(theme: &BlankPageTheme) -> String {
    // Belt and braces over `is_hex_colour`: quoted by the JSON encoder, so
    // even a value that got past the check cannot leave its string literal.
    let background = serde_json::Value::from(theme.background.as_str());
    let scheme = if theme.dark { "dark" } else { "light" };
    format!(
        "(function(){{var e=document.documentElement;if(!e)return;\
         var u=location.href;\
         if(u!==\"about:blank\"&&u.indexOf(\"about:blank#\")!==0)return;\
         e.style.background={background};e.style.colorScheme={scheme:?};}})()"
    )
}

/// `about:blank`, fragment and all — the frontend's `isBlankPageUrl` in the
/// one form a committed URL ever takes.
fn is_blank_url(url: &str) -> bool {
    url == "about:blank" || url.starts_with("about:blank#")
}

/// Whether this tab is showing the blank page that belongs to US: the empty
/// tab's own page, which nobody else writes into.
///
/// Answered about a state that was read at some point — which is why the
/// script asks the page the same question again when it gets there.
pub fn is_own_blank_page(state: &BrowserTabState) -> bool {
    state.kind == TabKind::Page && state.opener_tab_id.is_none() && is_blank_url(&state.url)
}

/// Paint the tab's blank page, if the blank page is what it is showing.
/// Best effort throughout: a surface that has gone, a theme nobody has pushed
/// yet and an engine that refuses the script all leave the page as the engine
/// drew it, which is where this started.
pub fn paint(registry: &BrowserRegistry, state: &BrowserTabState) {
    if !is_own_blank_page(state) {
        return;
    }
    let Some(script) = paint_script() else {
        return;
    };
    // The handle is taken — and the registry's lock released with it — before
    // the call: an embedded surface hops to the main thread, and the main
    // thread may need that lock to carry the hop out.
    let Some(surface) = registry.surface(&state.tab_id) else {
        return;
    };
    if let Err(err) = surface.eval(&script) {
        tracing::debug!(
            "[browser] tab {}: blank page not painted ({err})",
            state.tab_id
        );
    }
}

/// Repaint every blank page that is open. Runs when the frontend pushes the
/// colours: at startup, where it catches the tabs restored before the push,
/// and on every theme change, where it is the whole point — a page already on
/// screen must not stay in the colours of the theme that was just left.
pub fn repaint_all(registry: &BrowserRegistry) {
    for state in registry.list() {
        paint(registry, &state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::types::{ChannelKind, SurfaceKind};

    fn state(url: &str) -> BrowserTabState {
        BrowserTabState {
            tab_id: "t1".into(),
            owner_window: "main".into(),
            kind: TabKind::Page,
            surface: SurfaceKind::Child,
            channel: ChannelKind::Native,
            channel_error: None,
            url: url.into(),
            requested_url: url.into(),
            title: String::new(),
            favicon: None,
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            origin: None,
            zoom: 1.0,
            error: None,
            remote_host: None,
            opener_tab_id: None,
            profile: Some("default".into()),
            agent_grant: None,
        }
    }

    #[test]
    fn only_hex_colours_are_taken() {
        assert!(is_hex_colour("#09090b"));
        assert!(is_hex_colour("#FFFFFF"));
        assert!(!is_hex_colour("#fff"));
        assert!(!is_hex_colour("oklch(0.145 0 0)"));
        assert!(!is_hex_colour("rgb(9,9,11)"));
        assert!(!is_hex_colour(""));
        // The shape that would matter if it ever got through.
        assert!(!is_hex_colour("#000';alert(1);'"));
    }

    #[test]
    fn the_script_carries_the_colour_and_the_scheme() {
        let dark = script_for(&BlankPageTheme {
            background: "#09090b".into(),
            dark: true,
        });
        assert!(dark.contains("\"#09090b\""), "{dark}");
        assert!(dark.contains("colorScheme=\"dark\""), "{dark}");
        // The page is asked what it is before anything is painted on it: the
        // caller decided on a state that was read earlier, and by the time
        // this runs the tab may have committed somebody else's page.
        assert!(dark.contains("location.href"), "{dark}");
        // The whole of it, because the continuations in the format string are
        // what join those lines: a stray newline inside a statement would be
        // a syntax error the page throws away in silence.
        assert_eq!(
            dark,
            "(function(){var e=document.documentElement;if(!e)return;\
             var u=location.href;\
             if(u!==\"about:blank\"&&u.indexOf(\"about:blank#\")!==0)return;\
             e.style.background=\"#09090b\";e.style.colorScheme=\"dark\";})()"
        );
        let light = script_for(&BlankPageTheme {
            background: "#ffffff".into(),
            dark: false,
        });
        assert!(light.contains("colorScheme=\"light\""), "{light}");
    }

    #[test]
    fn a_tabs_own_blank_page_and_nobody_elses() {
        assert!(is_own_blank_page(&state("about:blank")));
        assert!(is_own_blank_page(&state("about:blank#x")));
        // A page, not the absence of one.
        assert!(!is_own_blank_page(&state("https://example.com/")));
        // Nothing has committed yet: there is no document to paint.
        assert!(!is_own_blank_page(&state("")));
        // The opener writes this document; its background is the opener's
        // business, not ours.
        let popup = BrowserTabState {
            opener_tab_id: Some("opener".into()),
            ..state("about:blank")
        };
        assert!(!is_own_blank_page(&popup));
        // A document guest shows a file.
        let guest = BrowserTabState {
            kind: TabKind::Document,
            ..state("about:blank")
        };
        assert!(!is_own_blank_page(&guest));
    }

    #[test]
    fn a_pushed_colour_is_what_the_script_paints() {
        set(BlankPageTheme {
            background: "#123456".into(),
            dark: true,
        })
        .expect("a hex colour is taken");
        assert!(paint_script().expect("a script").contains("#123456"));
        // And a bad one is refused rather than written over it.
        set(BlankPageTheme {
            background: "red".into(),
            dark: true,
        })
        .expect_err("a colour name is not #rrggbb");
        assert!(paint_script().expect("a script").contains("#123456"));
    }
}
