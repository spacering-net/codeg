# Dependency patches

Each section explains one `patchedDependencies` entry in `pnpm-workspace.yaml`.

## Tauri API 2.12.4 event callback cleanup

Tauri creates a JavaScript callback before awaiting native listener registration.
Its native registration eval and invoke response can reach WKWebView in either
order. If cleanup runs before that eval, the event registry does not yet contain
the callback ID. Registration failures never populate it at all. Both cases can
retain the subscriber closure after its view has gone away.

The patch captures the callback ID at registration, releases it explicitly on
failure or cleanup, and still calls native unlisten when registry cleanup is
unavailable. Cleanup is idempotent. `once` releases before invoking user code,
including when the first event arrives before the registration response.
Both `event.js` and `event.cjs` are patched; global, Webview, and Window listeners
all reach these functions. The transport, which registers through the core API,
owns the same cleanup directly.

The lockfile records the package patch hash. Run a frozen install and
`src/lib/tauri-native-event-memory.test.ts` against the installed ESM/CommonJS
package, plus `src/lib/transport/tauri-transport.test.ts`. They cover registration
failure, cleanup racing the registration eval, repeated mounts, normal independent
subscriptions, registry exceptions, and early `once` events. Run full TypeScript
checking as well, including tests rather than just Next's production build.

Revisit this patch on upgrades to `@tauri-apps/api` or after upstream provides an
equivalent callback lifetime fix. It does not change the Rust Tauri event plugin.

## OverlayScrollbars 2.15.1

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

Revalidation against the independently installed split on official main
`5c03d7af` used 24 scrolling elements in system WKWebView. The original path
reached 1,770.6 MiB within the first 20 seconds and was stopped at the experiment's
footprint cap. The patched path ran for 120 seconds (9,170 animation frames),
with a 208.9–276.7 MiB footprint range and a final 215.4 MiB sample. It had zero
scrollbar ScrollTimeline animations and continued moving the handles. A separate
16-case native geometry check passed with a maximum 0.235 CSS-pixel error;
Playwright WebKit passed all eight horizontal/vertical LTR/RTL drag and track
click cases. These are focused reproducer results, not a claim about all of
Codeg's long-running memory usage.

## Streamdown 2.7.1 highlighting lifecycle

The `HighlightedCodeBlockBody` effect now supplies an optional `AbortSignal`
to its highlighter plugin and aborts it on a code/language/theme change or
unmount. Plugins that ignore the extra option continue to work unchanged.
Both the executable ESM chunk and the exported TypeScript interface are patched.
Streamdown has no CommonJS entrypoint.

Codeg uses this lifecycle to remove a superseded Markdown request from the shared
highlighter's callbacks and retry waiters. Work is capped at 16 distinct requests;
there is at most one waiter per live code view, removed at the next streaming
update or unmount. Waiters do not retain token trees or a second cache key. This
avoids accumulating all historical prefixes while still eventually highlighting
every mounted block after a cold-engine burst. Callback-only consumers without
an abort signal have a separate 128-waiter safety limit and fall back to plaintext
beyond it. Codeg's Markdown and file/tool views supply a lifecycle.

`src/lib/code-highlighter-streamdown.test.tsx` renders the installed Streamdown
package with the real Shiki service, including 24 concurrent blocks. It also
checks that actual component replacement and unmount abort every plugin request.
Service tests exercise saturation, cancelled streaming prefixes, unmounts,
coalescing, and the cache budgets. Remove or revisit this patch when upgrading
Streamdown or after upstream provides an equivalent cancellation lifecycle.
