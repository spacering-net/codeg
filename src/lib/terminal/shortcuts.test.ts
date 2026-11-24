import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  copyTerminalSelection,
  isTerminalCopyShortcut,
} from "@/lib/terminal/shortcuts"
import { copyTextToClipboard } from "@/lib/utils"

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}))

const copyMock = vi.mocked(copyTextToClipboard)

type ShortcutEvent = Parameters<typeof isTerminalCopyShortcut>[0]

function event(overrides: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return {
    key: "C",
    code: "KeyC",
    altKey: false,
    metaKey: false,
    ctrlKey: true,
    shiftKey: true,
    ...overrides,
  }
}

describe("isTerminalCopyShortcut", () => {
  it("claims Ctrl+Shift+C outside macOS", () => {
    expect(isTerminalCopyShortcut(event(), false)).toBe(true)
  })

  it("leaves macOS alone, where ⌘C is the copy key", () => {
    expect(isTerminalCopyShortcut(event(), true)).toBe(false)
  })

  it("rejects every other modifier combination on the C key", () => {
    expect(isTerminalCopyShortcut(event({ shiftKey: false }), false)).toBe(
      false
    )
    expect(isTerminalCopyShortcut(event({ ctrlKey: false }), false)).toBe(false)
    // Windows AltGr is reported as Ctrl+Alt.
    expect(isTerminalCopyShortcut(event({ altKey: true }), false)).toBe(false)
    expect(isTerminalCopyShortcut(event({ metaKey: true }), false)).toBe(false)
  })

  it("rejects other keys", () => {
    expect(
      isTerminalCopyShortcut(event({ key: "V", code: "KeyV" }), false)
    ).toBe(false)
  })

  it("accepts the physical C key on layouts that print something else", () => {
    // Cyrillic layout: the QWERTY C position prints "с" (U+0441).
    expect(
      isTerminalCopyShortcut(event({ key: "С", code: "KeyC" }), false)
    ).toBe(true)
  })

  it("accepts the key that prints c on remapped Latin layouts", () => {
    // Dvorak: c sits on the QWERTY I position.
    expect(
      isTerminalCopyShortcut(event({ key: "C", code: "KeyI" }), false)
    ).toBe(true)
  })
})

describe("copyTerminalSelection", () => {
  function terminal(selection: string) {
    return {
      getSelection: () => selection,
      focus: vi.fn(),
    }
  }

  beforeEach(() => {
    copyMock.mockClear().mockResolvedValue(true)
    document.body.innerHTML = ""
  })

  it("does nothing when there is no selection", async () => {
    const term = terminal("")

    await expect(copyTerminalSelection(term)).resolves.toBe(false)
    expect(copyMock).not.toHaveBeenCalled()
    expect(term.focus).not.toHaveBeenCalled()
  })

  it("copies the selection", async () => {
    const term = terminal("npm run build")

    await expect(copyTerminalSelection(term)).resolves.toBe(true)
    expect(copyMock).toHaveBeenCalledWith("npm run build")
  })

  it("reports a failed write", async () => {
    copyMock.mockResolvedValue(false)

    await expect(copyTerminalSelection(terminal("text"))).resolves.toBe(false)
  })

  it("refocuses the terminal when the copy dropped focus to the body", async () => {
    // What the non-secure-context fallback does: focus a hidden textarea, copy,
    // remove it — which leaves document.activeElement on <body>.
    const helper = document.createElement("textarea")
    document.body.appendChild(helper)
    helper.focus()
    copyMock.mockImplementation(async () => {
      const scratch = document.createElement("textarea")
      document.body.appendChild(scratch)
      scratch.focus()
      scratch.remove()
      return true
    })
    const term = terminal("text")

    await copyTerminalSelection(term)

    expect(document.activeElement).toBe(document.body)
    expect(term.focus).toHaveBeenCalledTimes(1)
  })

  it("keeps focus where the user put it mid-copy", async () => {
    const helper = document.createElement("textarea")
    const elsewhere = document.createElement("input")
    document.body.append(helper, elsewhere)
    helper.focus()
    copyMock.mockImplementation(async () => {
      elsewhere.focus()
      return true
    })
    const term = terminal("text")

    await copyTerminalSelection(term)

    expect(document.activeElement).toBe(elsewhere)
    expect(term.focus).not.toHaveBeenCalled()
  })

  it("leaves focus alone when the clipboard API never touched it", async () => {
    const helper = document.createElement("textarea")
    document.body.appendChild(helper)
    helper.focus()
    const term = terminal("text")

    await copyTerminalSelection(term)

    expect(document.activeElement).toBe(helper)
    expect(term.focus).not.toHaveBeenCalled()
  })
})
