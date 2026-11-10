// The stop shortcut, spelled and checked as `src-tauri/src/computer/
// stop_shortcut.rs` does: modifiers then one key, joined by `+`, in the order
// Control, Alt, Shift, Command; the key by its W3C `code` — the physical key,
// whatever the layout prints on it. Empty is "no shortcut".
//
// The Rust side is the authority (it refuses anything else on save); this
// mirror is for recording a shortcut from key presses and for showing one.

export interface StopShortcutParts {
  control: boolean
  /** Option on a Mac. */
  alt: boolean
  shift: boolean
  /** Macs only. */
  command: boolean
  code: string
}

/** Why a pressed shortcut cannot be the stop shortcut. */
export type StopShortcutProblem =
  | "unsupportedKey"
  | "weakModifiers"
  | "metaOffMac"

const PUNCTUATION = new Map<string, string>([
  ["Minus", "-"],
  ["Equal", "="],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Backslash", "\\"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["Backquote", "`"],
  ["Comma", ","],
  ["Period", "."],
  ["Slash", "/"],
])

const MODIFIER_NAMES = new Map<string, "control" | "alt" | "shift" | "command">(
  [
    ["Control", "control"],
    ["Alt", "alt"],
    ["Shift", "shift"],
    ["Command", "command"],
  ]
)

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "CapsLock",
  "Fn",
])

/** A letter, a digit, F1–F12, Escape or a punctuation key — never a media
 *  key (on macOS watching one takes a permission codeg must not hold). */
export function isAllowedStopKey(code: string): boolean {
  return (
    /^Key[A-Z]$/.test(code) ||
    /^Digit[0-9]$/.test(code) ||
    /^F([1-9]|1[0-2])$/.test(code) ||
    code === "Escape" ||
    PUNCTUATION.has(code)
  )
}

export function parseStopShortcut(spelling: string): StopShortcutParts | null {
  if (!spelling) return null
  const parts = spelling.split("+")
  const code = parts.pop()
  if (!code) return null
  const out: StopShortcutParts = {
    control: false,
    alt: false,
    shift: false,
    command: false,
    code,
  }
  for (const part of parts) {
    const key = MODIFIER_NAMES.get(part)
    if (!key || out[key]) return null
    out[key] = true
  }
  return out
}

export function spellStopShortcut(parts: StopShortcutParts): string {
  return [
    parts.control && "Control",
    parts.alt && "Alt",
    parts.shift && "Shift",
    parts.command && "Command",
    parts.code,
  ]
    .filter(Boolean)
    .join("+")
}

/** Why `parts` cannot be the stop shortcut here, or null when it can. */
export function stopShortcutProblem(
  parts: StopShortcutParts,
  isMac: boolean
): StopShortcutProblem | null {
  if (!isAllowedStopKey(parts.code)) return "unsupportedKey"
  if (parts.command && !isMac) return "metaOffMac"
  const held = [parts.control, parts.alt, parts.shift, parts.command].filter(
    Boolean
  ).length
  if (held < 2 || !(parts.control || parts.command)) return "weakModifiers"
  return null
}

/** The shortcut a key press makes, or null while only modifiers are down. */
export function stopShortcutFromEvent(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
  >
): StopShortcutParts | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null
  return {
    control: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    command: event.metaKey,
    code: event.code,
  }
}

function keyLabel(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  if (code === "Escape") return "Esc"
  return PUNCTUATION.get(code) ?? code
}

/** How a shortcut is shown: ⌃⌥⇧⌘ and the key on a Mac, Ctrl+Alt+Shift+Key
 *  elsewhere. An unreadable spelling is shown as it is. */
export function stopShortcutLabel(spelling: string, isMac: boolean): string {
  const parts = parseStopShortcut(spelling)
  if (!parts) return spelling
  const key = keyLabel(parts.code)
  if (isMac) {
    return [
      parts.control && "⌃",
      parts.alt && "⌥",
      parts.shift && "⇧",
      parts.command && "⌘",
      key,
    ]
      .filter(Boolean)
      .join("")
  }
  return [
    parts.control && "Ctrl",
    parts.alt && "Alt",
    parts.shift && "Shift",
    parts.command && "Win",
    key,
  ]
    .filter(Boolean)
    .join("+")
}

/** The shortcut a person gets until they choose another. */
export function defaultStopShortcut(isMac: boolean): string {
  return isMac ? "Control+Command+Escape" : "Control+Alt+Escape"
}
