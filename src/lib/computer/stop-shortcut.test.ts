import { describe, expect, it } from "vitest"

import {
  defaultStopShortcut,
  isAllowedStopKey,
  parseStopShortcut,
  spellStopShortcut,
  stopShortcutFromEvent,
  stopShortcutLabel,
  stopShortcutProblem,
} from "./stop-shortcut"

const press = (
  code: string,
  held: Partial<
    Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>
  > = {}
) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...held,
})

describe("stop shortcut", () => {
  it("is spelled in the one order the backend keeps", () => {
    const parts = parseStopShortcut("Command+Control+Escape")
    expect(parts).toEqual({
      control: true,
      alt: false,
      shift: false,
      command: true,
      code: "Escape",
    })
    expect(spellStopShortcut(parts!)).toBe("Control+Command+Escape")
    for (const bad of ["", "Control+Control+KeyS", "Ctrl+Alt+KeyS", "Alt+"]) {
      expect(parseStopShortcut(bad)).toBeNull()
    }
  })

  it("takes only keys that need no permission to watch", () => {
    for (const good of ["KeyA", "Digit0", "F1", "F12", "Escape", "Period"]) {
      expect(isAllowedStopKey(good)).toBe(true)
    }
    for (const bad of [
      "MediaPlayPause",
      "AudioVolumeUp",
      "F13",
      "Space",
      "Tab",
      "Enter",
      "ArrowUp",
      "Numpad1",
      "toString",
    ]) {
      expect(isAllowedStopKey(bad)).toBe(false)
    }
  })

  it("holds two modifiers, one of them Control or — on a Mac — Command", () => {
    const check = (spelling: string, isMac: boolean) =>
      stopShortcutProblem(parseStopShortcut(spelling)!, isMac)
    expect(check("Control+KeyS", false)).toBe("weakModifiers")
    expect(check("Alt+Shift+KeyS", true)).toBe("weakModifiers")
    expect(check("Shift+Command+KeyS", true)).toBeNull()
    expect(check("Control+Alt+KeyS", false)).toBeNull()
    expect(check("Control+Command+Escape", false)).toBe("metaOffMac")
    expect(check("Control+Alt+Space", false)).toBe("unsupportedKey")
    expect(check(defaultStopShortcut(true), true)).toBeNull()
    expect(check(defaultStopShortcut(false), false)).toBeNull()
  })

  it("is read off the physical key, and waits while only modifiers are down", () => {
    expect(stopShortcutFromEvent(press("ControlLeft", { ctrlKey: true }))).toBe(
      null
    )
    expect(
      spellStopShortcut(
        stopShortcutFromEvent(press("KeyK", { ctrlKey: true, shiftKey: true }))!
      )
    ).toBe("Control+Shift+KeyK")
  })

  it("is shown in each platform's own way", () => {
    expect(stopShortcutLabel("Control+Command+Escape", true)).toBe("⌃⌘Esc")
    expect(stopShortcutLabel("Control+Alt+Shift+Period", true)).toBe("⌃⌥⇧.")
    expect(stopShortcutLabel("Control+Alt+Escape", false)).toBe("Ctrl+Alt+Esc")
    expect(stopShortcutLabel("Control+Shift+F5", false)).toBe("Ctrl+Shift+F5")
  })
})
