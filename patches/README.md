# Tauri API 2.12.4 event callback cleanup

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
