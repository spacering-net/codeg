// Label of the Tauri window this document runs in. Read from the injected
// Tauri metadata (no IPC, no permission needed); "main" outside the desktop
// runtime and in tests.

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      metadata?: { currentWindow?: { label?: string } }
    }
  }
}

export function getCurrentWindowLabel(): string {
  if (typeof window === "undefined") return "main"
  return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? "main"
}
