/**
 * Whether a press drags the desktop window: Tauri's own test (its injected
 * `drag.js`, Tauri 2.12), walking the press's composed path up from its
 * target.
 *
 * - `data-tauri-drag-region` bare or `"true"`: only a press on that element
 *   itself drags;
 * - `"deep"`: a press anywhere inside it drags;
 * - `"false"`: nothing at or under it drags;
 * - a clickable element (a button, a link, a field, a tab…) without the
 *   attribute stops the walk: a press on it never drags.
 *
 * Such a press never reaches the page as a click on the desktop: Tauri
 * stops its `mousedown` and starts the native drag, which swallows the
 * mouse-up. Anything waiting for the click — Radix's popovers, which close
 * on the click after an outside press — never hears of it.
 */
const CLICKABLE_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "LABEL",
  "SUMMARY",
])
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
])

function isClickable(el: HTMLElement): boolean {
  const editable = el.getAttribute("contenteditable")
  const tabIndex = el.getAttribute("tabindex")
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (editable !== null && editable !== "false") ||
    (tabIndex !== null && tabIndex !== "-1") ||
    INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "")
  )
}

export function isWindowDragPress(path: readonly EventTarget[]): boolean {
  for (const el of path) {
    if (!(el instanceof HTMLElement)) continue
    const attr = el.getAttribute("data-tauri-drag-region")
    if (attr === null) {
      if (isClickable(el)) return false
      continue
    }
    if (attr === "false") return false
    if (attr === "deep") return true
    if (attr === "" || attr === "true") return el === path[0]
  }
  return false
}
