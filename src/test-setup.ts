import "@testing-library/jest-dom/vitest"
import { beforeEach } from "vitest"

import { resetDisclosureStore } from "@/components/message/activity/disclosure-store"

// The activity timeline remembers which rows were opened in a module-level
// store keyed by step (tool call) id, so it outlives a test's render: without
// a reset, a row one test opened mounts already open in the next test that
// reuses the id, and that test's click closes it instead.
beforeEach(() => {
  resetDisclosureStore()
})

// jsdom doesn't implement a few layout APIs that ProseMirror's EditorView
// touches on mount (used by Tiptap-based editors such as the message composer).
// Polyfill them as no-ops so headless/component editor tests can construct a
// view. Only defined when missing, so real browsers/environments are untouched.
if (typeof document !== "undefined" && !document.elementFromPoint) {
  document.elementFromPoint = () => null
}
if (typeof Element !== "undefined") {
  // jsdom doesn't implement scrollIntoView; the composer's suggestion popup
  // calls it to keep the active row visible.
  Element.prototype.scrollIntoView ??= () => {}
  // jsdom doesn't implement Pointer Capture; Radix menus/popovers touch these
  // during the pointer interactions @testing-library/user-event drives.
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
}
if (typeof globalThis !== "undefined" && !("ResizeObserver" in globalThis)) {
  // jsdom doesn't implement ResizeObserver; cmdk (the command palette used by
  // the branch/folder pickers) constructs one on mount. A no-op stub is enough
  // for headless rendering — layout callbacks never need to fire.
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (typeof window !== "undefined" && !window.matchMedia) {
  // jsdom doesn't implement matchMedia, which `useMediaQuery` (and so
  // `useIsMobile`) subscribes to on mount. Nothing matches by default, so a
  // component tree renders at its desktop breakpoint; a test that needs the
  // other side stubs this itself.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects ??= () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
    }) as DOMRect
}
