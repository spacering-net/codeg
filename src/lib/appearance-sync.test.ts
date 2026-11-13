import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({ localDesktop: true }))
const call = vi.hoisted(() => vi.fn(async () => null))

vi.mock("./platform", () => ({
  isLocalDesktop: () => env.localDesktop,
}))
vi.mock("./transport", () => ({
  getTransport: () => ({ call }),
}))

import * as appearanceScript from "./appearance-script"
import {
  SYNCED_APPEARANCE_KEYS,
  adoptSyncedAppearance,
  isSyncedAppearanceKey,
  mirrorAppearanceOnLaunch,
  readSyncedAppearance,
} from "./appearance-sync"

/** Appearance keys that stay on their machine, and why. Every
 *  `STORAGE_KEY_*` the pre-paint script knows has to be either synced or
 *  listed here, so a new appearance setting is a decision, not an omission. */
const DEVICE_LOCAL = new Set([
  // Cache-buster for the background image file, which does not travel.
  appearanceScript.STORAGE_KEY_WORKSPACE_BG_IMAGE_VERSION,
  // Wallpaper-market page of that same image.
  appearanceScript.STORAGE_KEY_WORKSPACE_BG_SOURCE_URL,
  // The custom-style escape hatch: a safety switch for THIS machine.
  appearanceScript.STORAGE_KEY_CUSTOM_STYLE_SUSPENDED,
])

beforeEach(() => {
  window.localStorage.clear()
  call.mockClear()
  env.localDesktop = true
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("the synced key list", () => {
  it("is the same list the backend accepts", () => {
    const rust = readFileSync(
      resolve(
        process.cwd(),
        "src-tauri/src/commands/config_sync/appearance.rs"
      ),
      "utf8"
    )
    const block = rust.match(
      /pub const APPEARANCE_STORAGE_KEYS: &\[&str\] = &\[([\s\S]*?)\];/
    )
    expect(block).not.toBeNull()
    const backend = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(backend).toEqual([...SYNCED_APPEARANCE_KEYS])
  })

  it("classifies every appearance storage key as synced or device-local", () => {
    const declared = Object.entries(appearanceScript)
      .filter(([name]) => name.startsWith("STORAGE_KEY_"))
      .map(([, value]) => value as string)
    expect(declared.length).toBeGreaterThan(20)
    for (const key of declared) {
      expect(
        isSyncedAppearanceKey(key) !== DEVICE_LOCAL.has(key),
        `${key} must be exactly one of synced / device-local`
      ).toBe(true)
    }
  })
})

describe("readSyncedAppearance", () => {
  it("reads only synced keys that are set", () => {
    window.localStorage.setItem("codeg-theme-color", "yellow")
    window.localStorage.setItem("codeg-custom-style-suspended", "1")
    window.localStorage.setItem("unrelated", "x")
    expect(readSyncedAppearance()).toEqual({ "codeg-theme-color": "yellow" })
  })
})

describe("adoptSyncedAppearance", () => {
  it("writes the values and announces each change as a storage event", () => {
    window.localStorage.setItem("codeg-zoom-level", "100")
    window.localStorage.setItem("codeg-ui-font", "inter")
    const seen: (string | null)[] = []
    const onStorage = (e: StorageEvent) => seen.push(e.key)
    window.addEventListener("storage", onStorage)

    const changed = adoptSyncedAppearance({
      "codeg-zoom-level": "125",
      "codeg-ui-font": "inter",
      theme: "dark",
      // Never adopted, whatever the snapshot says.
      "codeg-custom-style-suspended": "1",
      "codeg-workspace-bg-image-version": "1",
    })
    window.removeEventListener("storage", onStorage)

    expect(changed).toBe(2)
    expect(seen.sort()).toEqual(["codeg-zoom-level", "theme"])
    expect(window.localStorage.getItem("codeg-zoom-level")).toBe("125")
    expect(window.localStorage.getItem("theme")).toBe("dark")
    expect(window.localStorage.getItem("codeg-custom-style-suspended")).toBe(
      null
    )
  })

  it("re-checks a custom theme instead of trusting the snapshot", () => {
    adoptSyncedAppearance({ "codeg-custom-theme": "{not json" })
    expect(window.localStorage.getItem("codeg-custom-theme")).toBeNull()

    adoptSyncedAppearance({
      "codeg-custom-theme": JSON.stringify({
        light: { primary: "oklch(0.5 0.2 30)", bogus: "x" },
        dark: {},
      }),
    })
    const stored = JSON.parse(
      window.localStorage.getItem("codeg-custom-theme") ?? "{}"
    )
    expect(stored.light).toEqual({ primary: "oklch(0.5 0.2 30)" })
  })

  it("mirrors the adopted state back so the next snapshot carries it", async () => {
    adoptSyncedAppearance({ "codeg-theme-color": "red" })
    expect(call).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(call).toHaveBeenCalledWith("config_sync_mirror_appearance", {
      values: { "codeg-theme-color": "red" },
    })
  })

  it("does nothing for an apply that carried no appearance", async () => {
    expect(adoptSyncedAppearance(undefined)).toBe(0)
    await vi.runAllTimersAsync()
    expect(call).not.toHaveBeenCalled()
  })
})

describe("mirrorAppearanceOnLaunch", () => {
  it("mirrors a local desktop window's appearance", async () => {
    window.localStorage.setItem("codeg-zoom-level", "125")
    mirrorAppearanceOnLaunch()
    await vi.runAllTimersAsync()
    expect(call).toHaveBeenCalledWith("config_sync_mirror_appearance", {
      values: { "codeg-zoom-level": "125" },
    })
  })

  /// In server mode every browser has its own appearance: merely opening one
  /// must not replace what another browser set.
  it("leaves a browser's appearance alone until it changes something", async () => {
    env.localDesktop = false
    window.localStorage.setItem("codeg-zoom-level", "125")
    mirrorAppearanceOnLaunch()
    await vi.runAllTimersAsync()
    expect(call).not.toHaveBeenCalled()
  })
})
