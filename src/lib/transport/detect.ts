export type TransportEnvironment = "tauri" | "web"

/**
 * True when the page runs inside a Tauri child webview owned by another
 * desktop shell (WingHarness) rather than in Codeg's own desktop window.
 *
 * Tauri defines `__TAURI_INTERNALS__` on every webview it creates, child
 * webviews included, and it does so before any page script runs. That marker
 * therefore cannot tell Codeg's own window apart from a webview embedded in a
 * different app, so the embedding host sets `__CODEG_EMBEDDED__` during its own
 * `initialization_script`. Such a page has no access to Codeg's commands and
 * must talk to codeg-server over HTTP, exactly like the browser build.
 */
function isEmbeddedHost(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { __CODEG_EMBEDDED__?: unknown }).__CODEG_EMBEDDED__ ===
      true
  )
}

export function detectEnvironment(): TransportEnvironment {
  if (isEmbeddedHost()) {
    return "web"
  }
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return "tauri"
  }
  return "web"
}
