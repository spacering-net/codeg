import { copyTextToClipboard } from "@/lib/utils"

/**
 * The fields of a `KeyboardEvent` the terminal shortcut checks read. Structural
 * so callers — and tests — can pass a plain object.
 */
type TerminalShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey"
>

/**
 * Ctrl+Shift+C — the copy binding every Windows/Linux terminal emulator uses,
 * because plain Ctrl+C has to stay free for SIGINT (issue #506).
 *
 * Claiming it costs the PTY nothing: xterm.js only maps Ctrl+<letter> to a
 * control character when Shift is *not* held (`evaluateKeyboardEvent`), so this
 * combo already produced no bytes.
 *
 * macOS is excluded — the copy key there is ⌘C, which the webview delivers as a
 * native `copy` event that xterm's own handler already answers.
 *
 * Matches either the physical C key (`code`) or the key that prints c (`key`),
 * so it works both on non-Latin layouts, where the C position prints something
 * else, and on remapped Latin layouts such as Dvorak, where c sits elsewhere.
 * The `!altKey` guard also excludes Windows AltGr, which is reported as
 * Ctrl+Alt.
 */
export function isTerminalCopyShortcut(
  event: TerminalShortcutEvent,
  isMac: boolean
): boolean {
  return (
    !isMac &&
    (event.code === "KeyC" || event.key.toLowerCase() === "c") &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  )
}

/** The bits of an xterm `Terminal` the copy action needs. */
interface TerminalSelectionSource {
  getSelection(): string
  focus(): void
}

/**
 * Copy the terminal's current selection, then put the keyboard back where it
 * was. Resolves false when nothing was selected or the write failed.
 *
 * The focus dance matters in the web build served over plain HTTP/LAN: there is
 * no `navigator.clipboard` outside a secure context, so `copyTextToClipboard`
 * falls back to a hidden `<textarea>` + `execCommand` — which focuses that
 * textarea and then removes it, dropping focus to `<body>`. Without the restore
 * the terminal goes deaf to typing until the user clicks it again. Only restore
 * when focus actually landed on `<body>`, so a user who clicked elsewhere while
 * the write was in flight keeps the focus they chose.
 */
export async function copyTerminalSelection(
  term: TerminalSelectionSource
): Promise<boolean> {
  const selection = term.getSelection()
  if (!selection) return false

  const activeBefore = document.activeElement
  const copied = await copyTextToClipboard(selection)
  if (
    document.activeElement !== activeBefore &&
    document.activeElement === document.body
  ) {
    term.focus()
  }

  return copied
}
