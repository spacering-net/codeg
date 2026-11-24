import { beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_SHORTCUTS,
  SHORTCUTS_STORAGE_KEY,
  NUMBERED_TAB_ACTION_IDS,
  SHORTCUT_DEFINITIONS,
  formatShortcutLabel,
  matchShortcutEvent,
  normalizeShortcut,
  readShortcutSettings,
  resolveWindowZoomAction,
  numberedTabIndexFromEvent,
  pickNumberedTabId,
  shortcutFromKeyboardEvent,
  shortcutsConflict,
  writeShortcutSettings,
} from "./keyboard-shortcuts"

function keyEvent(
  key: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
      code: string
    }
  > = {}
) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

describe("tab cycling shortcuts", () => {
  it("registers next_tab and prev_tab with defaults", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toContain("next_tab")
    expect(ids).toContain("prev_tab")
    expect(DEFAULT_SHORTCUTS.next_tab).toBe("mod+tab")
    expect(DEFAULT_SHORTCUTS.prev_tab).toBe("mod+shift+tab")
  })

  it("matches Ctrl+Tab against the next_tab default", () => {
    expect(
      matchShortcutEvent(keyEvent("Tab", { ctrlKey: true }), "mod+tab")
    ).toBe(true)
    expect(matchShortcutEvent(keyEvent("Tab"), "mod+tab")).toBe(false)
  })

  it("matches Ctrl+Shift+Tab against the prev_tab default", () => {
    expect(
      matchShortcutEvent(
        keyEvent("Tab", { ctrlKey: true, shiftKey: true }),
        "mod+shift+tab"
      )
    ).toBe(true)
    // Without Shift it must not match prev_tab, and with Shift it must not
    // match next_tab, so the two bindings stay distinct.
    expect(
      matchShortcutEvent(keyEvent("Tab", { ctrlKey: true }), "mod+shift+tab")
    ).toBe(false)
    expect(
      matchShortcutEvent(
        keyEvent("Tab", { ctrlKey: true, shiftKey: true }),
        "mod+tab"
      )
    ).toBe(false)
  })
})

describe("numbered tab shortcuts", () => {
  it("registers Ctrl/Cmd+1 through 9 as switch_tab_N", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    for (const [index, actionId] of NUMBERED_TAB_ACTION_IDS.entries()) {
      expect(ids).toContain(actionId)
      expect(DEFAULT_SHORTCUTS[actionId]).toBe(`mod+${index + 1}`)
    }
  })

  it("maps Ctrl+1 to the first tab and ignores a missing ninth tab", () => {
    const tabs = ["conv-a", "conv-b", "conv-c"]
    expect(pickNumberedTabId(tabs, 0)).toBe("conv-a")
    expect(pickNumberedTabId(tabs, 2)).toBe("conv-c")
    expect(pickNumberedTabId(tabs, 8)).toBeNull()
    expect(pickNumberedTabId([], 0)).toBeNull()
  })

  it("resolves Ctrl+2 against the default numbered-tab bindings", () => {
    expect(
      numberedTabIndexFromEvent(
        keyEvent("2", { ctrlKey: true }),
        DEFAULT_SHORTCUTS
      )
    ).toBe(1)
    expect(
      numberedTabIndexFromEvent(keyEvent("2"), DEFAULT_SHORTCUTS)
    ).toBeNull()
    expect(
      numberedTabIndexFromEvent(
        keyEvent("Tab", { ctrlKey: true }),
        DEFAULT_SHORTCUTS
      )
    ).toBeNull()
  })
})

describe("reopen last closed tab", () => {
  it("defaults to Ctrl/Cmd+Shift+T", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toContain("reopen_last_closed_tab")
    expect(DEFAULT_SHORTCUTS.reopen_last_closed_tab).toBe("mod+shift+t")
    expect(
      matchShortcutEvent(
        keyEvent("t", { ctrlKey: true, shiftKey: true }),
        DEFAULT_SHORTCUTS.reopen_last_closed_tab
      )
    ).toBe(true)
    expect(
      matchShortcutEvent(
        keyEvent("t", { ctrlKey: true }),
        DEFAULT_SHORTCUTS.reopen_last_closed_tab
      )
    ).toBe(false)
  })
})

describe("alt combinations use event.code", () => {
  // macOS 上 ⌥S 报的 event.key 是 "ß"，不是 "s"。不看 event.code 的话，任何
  // 含 alt 的组合在 macOS 上都按不出来 —— 自定义样式的逃生舱正是这样一条。
  it("matches Cmd+Option+Shift+S even though the layout rewrote the key", () => {
    expect(
      matchShortcutEvent(
        keyEvent("ß", {
          metaKey: true,
          altKey: true,
          shiftKey: true,
          code: "KeyS",
        }),
        "mod+alt+shift+s"
      )
    ).toBe(true)
  })

  it("records the physical key rather than the rewritten character", () => {
    expect(
      shortcutFromKeyboardEvent(
        keyEvent("ß", {
          metaKey: true,
          altKey: true,
          shiftKey: true,
          code: "KeyS",
        })
      )
    ).toBe("mod+alt+shift+s")
  })

  it("leaves non-alt shortcuts on event.key", () => {
    // 没有 alt 时不改道：既有快捷键的行为必须逐字节不变。
    expect(
      matchShortcutEvent(
        keyEvent("k", { metaKey: true, code: "KeyK" }),
        "mod+k"
      )
    ).toBe(true)
    expect(
      matchShortcutEvent(
        keyEvent("Dead", { metaKey: true, code: "KeyK" }),
        "mod+k"
      )
    ).toBe(false)
  })

  it("still resolves the escape hatch when the runtime omits event.code", () => {
    expect(
      matchShortcutEvent(
        keyEvent("s", { metaKey: true, altKey: true, shiftKey: true }),
        "mod+alt+shift+s"
      )
    ).toBe(true)
  })
})

const defaultZoom = {
  zoom_in: DEFAULT_SHORTCUTS.zoom_in,
  zoom_out: DEFAULT_SHORTCUTS.zoom_out,
  zoom_reset: DEFAULT_SHORTCUTS.zoom_reset,
}

describe("window zoom shortcuts", () => {
  it("registers zoom_in / zoom_out / zoom_reset defaults", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toContain("zoom_in")
    expect(ids).toContain("zoom_out")
    expect(ids).toContain("zoom_reset")
    expect(DEFAULT_SHORTCUTS.zoom_in).toBe("mod+=")
    expect(DEFAULT_SHORTCUTS.zoom_out).toBe("mod+-")
    expect(DEFAULT_SHORTCUTS.zoom_reset).toBe("mod+0")
  })

  it("lets + survive normalize so Ctrl/Cmd Shift = can be recorded", () => {
    expect(normalizeShortcut("mod++")).toBe("mod++")
    expect(normalizeShortcut("mod+shift++")).toBe("mod+shift++")
    expect(
      shortcutFromKeyboardEvent(
        keyEvent("+", { ctrlKey: true, shiftKey: true })
      )
    ).toBe("mod+shift++")
    expect(formatShortcutLabel("mod++", false)).toBe("Ctrl++")
    expect(formatShortcutLabel("mod++", true)).toBe("⌘+")
  })

  it("treats = and + as the same physical key on the bound zoom-in shortcut", () => {
    expect(matchShortcutEvent(keyEvent("=", { ctrlKey: true }), "mod+=")).toBe(
      true
    )
    expect(
      matchShortcutEvent(
        keyEvent("+", { ctrlKey: true, shiftKey: true }),
        "mod+="
      )
    ).toBe(true)
    expect(matchShortcutEvent(keyEvent("k", { ctrlKey: true }), "mod+=")).toBe(
      false
    )
  })

  it("treats - and _ as the same physical key on the bound zoom-out shortcut", () => {
    expect(matchShortcutEvent(keyEvent("-", { ctrlKey: true }), "mod+-")).toBe(
      true
    )
    expect(
      matchShortcutEvent(
        keyEvent("_", { ctrlKey: true, shiftKey: true }),
        "mod+-"
      )
    ).toBe(true)
    expect(matchShortcutEvent(keyEvent("=", { ctrlKey: true }), "mod+-")).toBe(
      false
    )
  })

  it("follows a remapped zoom-in binding and ignores the old default", () => {
    const remapped = {
      ...defaultZoom,
      zoom_in: "mod+shift+z",
    }
    expect(
      resolveWindowZoomAction(
        keyEvent("z", { ctrlKey: true, shiftKey: true }),
        remapped
      )
    ).toBe("in")
    expect(
      resolveWindowZoomAction(keyEvent("=", { ctrlKey: true }), remapped)
    ).toBeNull()
    expect(
      resolveWindowZoomAction(
        keyEvent("+", { ctrlKey: true, shiftKey: true }),
        remapped
      )
    ).toBeNull()
  })

  it("still matches a repeat of the bound zoom key", () => {
    expect(
      resolveWindowZoomAction(keyEvent("=", { ctrlKey: true }), defaultZoom)
    ).toBe("in")
    expect(
      resolveWindowZoomAction(keyEvent("-", { ctrlKey: true }), defaultZoom)
    ).toBe("out")
    expect(
      resolveWindowZoomAction(keyEvent("0", { ctrlKey: true }), defaultZoom)
    ).toBe("reset")
  })

  it("does not treat AZERTY Ctrl+) as zoom out just because code is Minus", () => {
    expect(
      matchShortcutEvent(
        keyEvent(")", { ctrlKey: true, code: "Minus" }),
        "mod+-"
      )
    ).toBe(false)
  })

  it("still matches numpad + / - against the default zoom bindings", () => {
    expect(
      matchShortcutEvent(
        keyEvent("Add", { ctrlKey: true, code: "NumpadAdd" }),
        "mod+="
      )
    ).toBe(true)
    expect(
      matchShortcutEvent(
        keyEvent("Subtract", { ctrlKey: true, code: "NumpadSubtract" }),
        "mod+-"
      )
    ).toBe(true)
  })
})

describe("digit bindings on a shifted digit row", () => {
  // AZERTY shifts the digit row: unshifted Digit0 types "à", and "0" needs
  // Shift. Both spellings used to miss `mod+0`, leaving reset unpressable.
  it("resolves reset from the unshifted AZERTY zero key", () => {
    expect(
      resolveWindowZoomAction(
        keyEvent("à", { ctrlKey: true, code: "Digit0" }),
        defaultZoom
      )
    ).toBe("reset")
  })

  it("resolves reset from the shifted AZERTY spelling that actually types 0", () => {
    expect(
      resolveWindowZoomAction(
        keyEvent("0", { ctrlKey: true, shiftKey: true, code: "Digit0" }),
        defaultZoom
      )
    ).toBe("reset")
  })

  it("keeps QWERTY Ctrl+0 working, with or without event.code", () => {
    expect(
      resolveWindowZoomAction(
        keyEvent("0", { ctrlKey: true, code: "Digit0" }),
        defaultZoom
      )
    ).toBe("reset")
    expect(
      resolveWindowZoomAction(keyEvent("0", { ctrlKey: true }), defaultZoom)
    ).toBe("reset")
  })

  // The positional fallback must not claim a SHIFTED digit key: with Shift that
  // key types a character that belongs to another binding, so matching by
  // position would make one press satisfy two.
  it("leaves shifted US Digit0 to whoever owns the character it types", () => {
    expect(
      matchShortcutEvent(
        keyEvent(")", { metaKey: true, shiftKey: true, code: "Digit0" }),
        "mod+0"
      )
    ).toBe(false)
  })

  it("gives QWERTZ Ctrl+Shift+0 to zoom in only, not also to reset", () => {
    // On German QWERTZ that keypress types "=", which is the zoom-in binding.
    const event = keyEvent("=", {
      ctrlKey: true,
      shiftKey: true,
      code: "Digit0",
    })
    expect(matchShortcutEvent(event, "mod+0")).toBe(false)
    expect(matchShortcutEvent(event, "mod+=")).toBe(true)
    expect(resolveWindowZoomAction(event, defaultZoom)).toBe("in")
  })

  // AZERTY puts `-` on Digit6 and `_` on Digit8. Binding the digits 1-9 to tab
  // jumps put those two physical keys in reach of the positional fallback, so
  // one Ctrl+- press would have matched `mod+-` by key AND `mod+6` by code —
  // and the zoom listener preventDefaults without stopping propagation, so the
  // window would zoom out *and* the app would jump to tab 6. `shortcutsConflict`
  // cannot see the pair, so Settings shows no warning either.
  it("leaves the AZERTY minus/underscore keys to the zoom bindings", () => {
    const minus = keyEvent("-", { ctrlKey: true, code: "Digit6" })
    expect(matchShortcutEvent(minus, "mod+6")).toBe(false)
    expect(numberedTabIndexFromEvent(minus, DEFAULT_SHORTCUTS)).toBeNull()
    expect(resolveWindowZoomAction(minus, defaultZoom)).toBe("out")

    const underscore = keyEvent("_", { ctrlKey: true, code: "Digit8" })
    expect(matchShortcutEvent(underscore, "mod+8")).toBe(false)
    expect(numberedTabIndexFromEvent(underscore, DEFAULT_SHORTCUTS)).toBeNull()
  })

  it("still reaches tab 6 from the AZERTY spelling that types the digit", () => {
    // Shift is how you type "6" there, and the surplus-Shift tolerance for
    // digits already accepts it — so declining the position costs nothing.
    expect(
      numberedTabIndexFromEvent(
        keyEvent("6", { ctrlKey: true, shiftKey: true, code: "Digit6" }),
        DEFAULT_SHORTCUTS
      )
    ).toBe(5)
  })

  it("keeps the positional fallback for AZERTY digits nobody else claims", () => {
    // Unshifted Digit1 types "&", which no binding owns by name.
    expect(
      numberedTabIndexFromEvent(
        keyEvent("&", { ctrlKey: true, code: "Digit1" }),
        DEFAULT_SHORTCUTS
      )
    ).toBe(0)
  })

  it("only accepts the bound digit's own physical key", () => {
    expect(
      matchShortcutEvent(
        keyEvent("à", { ctrlKey: true, code: "Digit0" }),
        "mod+1"
      )
    ).toBe(false)
    expect(
      matchShortcutEvent(
        keyEvent("&", { ctrlKey: true, code: "Digit1" }),
        "mod+0"
      )
    ).toBe(false)
  })

  it("leaves the surplus-Shift rule exact for non-digit keys", () => {
    // The tolerance is scoped to the digit row; a letter must still be exact,
    // or every mod+shift+X binding would start firing its mod+X neighbour.
    expect(
      matchShortcutEvent(
        keyEvent("k", { ctrlKey: true, shiftKey: true, code: "KeyK" }),
        "mod+k"
      )
    ).toBe(false)
    expect(
      matchShortcutEvent(
        keyEvent("Enter", { shiftKey: true, code: "Enter" }),
        "enter"
      )
    ).toBe(false)
  })
})

describe("binding conflicts use matcher semantics", () => {
  it("catches two different strings that fire on the same event", () => {
    // Ctrl/Cmd+Shift+= matches both, so string equality reports no conflict
    // while both actions run.
    expect(
      matchShortcutEvent(
        keyEvent("+", { ctrlKey: true, shiftKey: true }),
        "mod+="
      )
    ).toBe(true)
    expect(
      matchShortcutEvent(
        keyEvent("+", { ctrlKey: true, shiftKey: true }),
        "mod+shift++"
      )
    ).toBe(true)
    expect(shortcutsConflict("mod+=", "mod+shift++")).toBe(true)
  })

  it("catches a digit colliding with its own shifted spelling", () => {
    expect(shortcutsConflict("mod+0", "mod+shift+0")).toBe(true)
  })

  it("does not invent a conflict between genuinely distinct chords", () => {
    expect(shortcutsConflict("mod+k", "mod+shift+k")).toBe(false)
    expect(shortcutsConflict("mod+k", "mod+j")).toBe(false)
    expect(shortcutsConflict("enter", "shift+enter")).toBe(false)
    expect(shortcutsConflict("mod+=", "mod+-")).toBe(false)
  })

  it("still reports an exact duplicate", () => {
    expect(shortcutsConflict("mod+b", "mod+b")).toBe(true)
  })

  it("treats an unparseable or unbound side as no conflict", () => {
    expect(shortcutsConflict("", "mod+b")).toBe(false)
    expect(shortcutsConflict("mod+b", "")).toBe(false)
  })
})

describe("a new default never steals a stored binding", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("leaves the new action unbound when the chord is already claimed", () => {
    // Exactly the payload the previously shipped app could have written: the
    // zoom keys are new, so they are absent and get seeded on top.
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ toggle_search: "mod+-", toggle_sidebar: "mod+0" })
    )

    const settings = readShortcutSettings()

    expect(settings.toggle_search).toBe("mod+-")
    expect(settings.toggle_sidebar).toBe("mod+0")
    expect(settings.zoom_out).toBe("")
    expect(settings.zoom_reset).toBe("")
    // The one that does not collide still arrives on its default.
    expect(settings.zoom_in).toBe(DEFAULT_SHORTCUTS.zoom_in)
  })

  it("compares with matcher semantics, not string equality", () => {
    // `mod+shift++` is not the string `mod+=`, but the same event fires both.
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ toggle_search: "mod+shift++" })
    )

    expect(readShortcutSettings().zoom_in).toBe("")
  })

  it("survives a later write instead of reseeding the collision", () => {
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ toggle_sidebar: "mod+0" })
    )

    const settings = readShortcutSettings()
    expect(settings.zoom_reset).toBe("")

    // Changing something unrelated writes the whole object back. The unbound
    // action has to stay unbound, or the collision returns on the next read.
    writeShortcutSettings({ ...settings, toggle_terminal: "mod+shift+j" })

    const reread = readShortcutSettings()
    expect(reread.zoom_reset).toBe("")
    expect(reread.toggle_sidebar).toBe("mod+0")
    expect(reread.toggle_terminal).toBe("mod+shift+j")
  })

  it("still seeds every default for a profile that never stored anything", () => {
    expect(readShortcutSettings()).toEqual(DEFAULT_SHORTCUTS)
  })

  it("keeps the pairs that are meant to share a chord", () => {
    // new_terminal_tab and new_conversation ship on the same chord on purpose,
    // so a stored copy of one must not unbind the other.
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ new_terminal_tab: "mod+t" })
    )

    const settings = readShortcutSettings()
    expect(settings.new_terminal_tab).toBe("mod+t")
    expect(settings.new_conversation).toBe(DEFAULT_SHORTCUTS.new_conversation)
  })

  it("does not unbind a default over a collision between two defaults", () => {
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ toggle_search: "mod+shift+f" })
    )

    const settings = readShortcutSettings()
    for (const definition of SHORTCUT_DEFINITIONS) {
      if (definition.id === "toggle_search") continue
      expect(settings[definition.id]).toBe(DEFAULT_SHORTCUTS[definition.id])
    }
  })
})
