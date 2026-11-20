import type { MemoryCounters } from "./frontend-memory"

/**
 * Shallow numbers only. These temporary collections stay inside this task;
 * never return DOM/animation objects or callback keys, handlers or payloads.
 * Called only by the opt-in local desktop diagnostics reporter.
 */
export function readBrowserMemoryCounters(): MemoryCounters {
  const metrics: MemoryCounters = {
    domElements: document.getElementsByTagName("*").length,
    domCanvases: document.getElementsByTagName("canvas").length,
    terminalElements: document.getElementsByClassName("xterm").length,
    resourceTimingEntries: performance.getEntriesByType("resource").length,
  }
  const internals = (
    window as typeof window & {
      __TAURI_INTERNALS__?: { callbacks?: { size?: unknown } }
    }
  ).__TAURI_INTERNALS__
  const callbacks = internals?.callbacks?.size
  if (typeof callbacks === "number") metrics.tauriCallbacks = callbacks

  // Older WebViews can lack getAnimations or the optional Chromium heap API.
  // Omit unsupported counters so "unavailable" is not reported as zero.
  if (typeof document.getAnimations === "function") {
    const animations = document.getAnimations()
    metrics.documentAnimations = animations.length
    metrics.runningAnimations = animations.filter(
      (animation) => animation.playState === "running"
    ).length
  }
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: unknown }
    }
  ).memory
  if (typeof memory?.usedJSHeapSize === "number") {
    metrics.jsHeapUsedBytes = memory.usedJSHeapSize
  }
  return metrics
}
