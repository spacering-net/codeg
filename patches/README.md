# OverlayScrollbars 2.15.1

The patch selects OverlayScrollbars' existing scroll-event implementation and
percentage-based handle positioning in WebKit. Its native implementation
animates scrollbar handles with
`ScrollTimeline` and `translate*(calc(-100% + 100cq*))`. On macOS 27.2
(26B123), repeatedly updating those timelines retains native WebKit allocations
even when the DOM size and JavaScript live heap stay small.

A system WKWebView reproducer with 24 scrolling elements grew from 293 MiB to
2,324 MiB in 40 seconds. The same timeline with a fixed-pixel transform stayed
near 111 MiB for 90 seconds; the scroll-event control stayed near 116 MiB for
150 seconds. The CSS fallback also uses container-relative transforms by default,
so WebKit scrollbar elements receive a class that keeps the original percentage
rules instead. The patch avoids the problematic interpolation without changing
the page's scrolling or disabling CSS animations. Blink keeps the native path.

All four ESM/CommonJS package entrypoints used by package exports and the
legacy `main`/`module` fields carry the same change. The lockfile records the
patch hash so clean and frozen installs apply it.

`src/lib/overlay-scrollbars-memory.test.ts` runs fresh ESM and CommonJS imports
for desktop/iOS WebKit, Chromium browsers, and browsers without the API. It
checks that WebKit creates handles without native timeline animations and that
Chromium retains the native implementation. Browser functionality and memory
also need a system WebKit check: initialize real scrollbars, repeatedly change
the viewport's scroll position, and verify that the handle moves while
`document.getAnimations()` contains no scrollbar `ScrollTimeline` animations.

Revisit the patch when upgrading OverlayScrollbars or when WebKit fixes this
interpolation path. Test native physical footprint, rather than only a
JavaScript heap snapshot.
