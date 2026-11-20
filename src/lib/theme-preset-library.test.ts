import { describe, expect, it } from "vitest"
import {
  PRESET_LIBRARY,
  presetLibraryEntry,
  presetPreviewColors,
  presetToCustomTheme,
} from "./theme-preset-library"
import { CUSTOM_THEME_TOKENS } from "./custom-style"

describe("theme preset library", () => {
  it("ships a non-empty snapshot with unique ids", () => {
    expect(PRESET_LIBRARY.length).toBeGreaterThan(0)
    const ids = PRESET_LIBRARY.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // 快照是 `pnpm themes:fetch` 从远端注册表重新生成的文件，任何一个主题在此处
  // 丢掉整套 token 都说明抓取端点或 token 名单已经漂移，而不是数据「本来就少」。
  it("survives the sanitiser with both modes populated", () => {
    for (const entry of PRESET_LIBRARY) {
      const theme = presetToCustomTheme(entry)
      expect(Object.keys(theme.light).length, entry.id).toBeGreaterThan(0)
      expect(Object.keys(theme.dark).length, entry.id).toBeGreaterThan(0)
    }
  })

  it("only carries tokens the app can apply", () => {
    const known = new Set<string>(CUSTOM_THEME_TOKENS)
    for (const entry of PRESET_LIBRARY) {
      for (const mode of [entry.light, entry.dark]) {
        for (const token of Object.keys(mode)) {
          expect(known.has(token), `${entry.id}: ${token}`).toBe(true)
        }
      }
    }
  })

  it("offers a six-swatch preview in either mode", () => {
    const [entry] = PRESET_LIBRARY
    expect(presetPreviewColors(entry, false)).toHaveLength(6)
    expect(presetPreviewColors(entry, true)).toHaveLength(6)
  })

  it("looks entries up by id", () => {
    const [entry] = PRESET_LIBRARY
    expect(presetLibraryEntry(entry.id)).toBe(entry)
    expect(presetLibraryEntry("no-such-theme")).toBeUndefined()
  })
})
