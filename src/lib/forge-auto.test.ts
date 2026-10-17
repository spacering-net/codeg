import { beforeEach, describe, expect, it, vi } from "vitest"

const getWebServerStatus = vi.fn()
const isLocalDesktop = vi.fn()
const getServerBaseUrl = vi.fn()
vi.mock("@/lib/api", () => ({
  getWebServerStatus: () => getWebServerStatus(),
}))
vi.mock("@/lib/platform", () => ({
  isLocalDesktop: () => isLocalDesktop(),
}))
vi.mock("@/lib/transport", () => ({
  getServerBaseUrl: () => getServerBaseUrl(),
}))

import {
  DEFAULT_FORGE_AUTO_SETTINGS,
  FORGE_WEBHOOK_PATH,
  SCAN_INTERVAL_PRESETS,
  autoSettingsOf,
  forgeWebhookUrls,
  generateWebhookSecret,
  isAutoActive,
  sameAutoSettings,
  scanIntervalOptions,
} from "./forge-auto"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("autoSettingsOf", () => {
  /** A blob written before auto-processing existed has no block at all, and
   *  must read as OFF — the backend's own default. */
  it("reads a missing block as the defaults, and fills a partial one", () => {
    expect(autoSettingsOf(null)).toEqual(DEFAULT_FORGE_AUTO_SETTINGS)
    expect(
      autoSettingsOf({ writeback_default: true, scenario_prompts: {} })
    ).toEqual(DEFAULT_FORGE_AUTO_SETTINGS)
    const partial = autoSettingsOf({
      writeback_default: true,
      scenario_prompts: {},
      auto: { schedule: true } as never,
    })
    expect(partial.schedule).toBe(true)
    expect(partial.issues).toBe(true)
    expect(partial.interval_minutes).toBe(15)
  })

  it("ships off and on the cautious side", () => {
    const d = DEFAULT_FORGE_AUTO_SETTINGS
    expect(isAutoActive(d)).toBe(false)
    expect(d.issues && !d.pull_requests).toBe(true)
    expect(d.skip_drafts && !d.writeback && !d.include_existing).toBe(true)
  })
})

describe("isAutoActive", () => {
  it("needs a trigger AND a kind", () => {
    const base = DEFAULT_FORGE_AUTO_SETTINGS
    expect(isAutoActive({ ...base, schedule: true })).toBe(true)
    expect(isAutoActive({ ...base, webhook: true })).toBe(true)
    expect(isAutoActive({ ...base, schedule: true, issues: false })).toBe(false)
    expect(
      isAutoActive({
        ...base,
        webhook: true,
        issues: false,
        pull_requests: true,
      })
    ).toBe(true)
  })
})

describe("scanIntervalOptions", () => {
  it("offers the presets, plus a stored value outside them", () => {
    expect(scanIntervalOptions(15)).toEqual([...SCAN_INTERVAL_PRESETS])
    const odd = scanIntervalOptions(7)
    expect(odd).toContain(7)
    expect(odd).toEqual([...odd].sort((a, b) => a - b))
  })
})

describe("sameAutoSettings", () => {
  /** `enabled_at` is the server's to stamp — it must never make a form look
   *  edited, or "Scan now" would refuse on a form nobody touched. */
  it("ignores the server-stamped switch-on time", () => {
    const a = { ...DEFAULT_FORGE_AUTO_SETTINGS, schedule: true }
    expect(
      sameAutoSettings(a, { ...a, enabled_at: "2026-10-14T08:00:00Z" })
    ).toBe(true)
  })

  it("sees any rule edit", () => {
    const a = { ...DEFAULT_FORGE_AUTO_SETTINGS, include_labels: ["bug"] }
    expect(sameAutoSettings(a, { ...a, include_labels: ["Bug"] })).toBe(false)
    expect(sameAutoSettings(a, { ...a, interval_minutes: 30 })).toBe(false)
  })
})

describe("generateWebhookSecret", () => {
  it("mints 32 random bytes as hex", () => {
    const one = generateWebhookSecret()
    expect(one).toMatch(/^[0-9a-f]{64}$/)
    expect(generateWebhookSecret()).not.toBe(one)
  })
})

describe("forgeWebhookUrls", () => {
  it("names this server's own address in a browser", async () => {
    isLocalDesktop.mockReturnValue(false)
    getServerBaseUrl.mockReturnValue("https://codeg.example.com")
    await expect(forgeWebhookUrls()).resolves.toEqual([
      `https://codeg.example.com${FORGE_WEBHOOK_PATH}`,
    ])
    expect(getWebServerStatus).not.toHaveBeenCalled()
  })

  it("names the local web service's addresses on the desktop", async () => {
    isLocalDesktop.mockReturnValue(true)
    getWebServerStatus.mockResolvedValue({
      port: 3080,
      token: "t",
      addresses: ["http://192.168.1.5:3080", "http://127.0.0.1:3080/"],
    })
    await expect(forgeWebhookUrls()).resolves.toEqual([
      `http://192.168.1.5:3080${FORGE_WEBHOOK_PATH}`,
      `http://127.0.0.1:3080${FORGE_WEBHOOK_PATH}`,
    ])
  })

  /** No web service, nowhere to deliver — an empty list, not a guess. */
  it("names nothing while the desktop web service is off", async () => {
    isLocalDesktop.mockReturnValue(true)
    getWebServerStatus.mockResolvedValue(null)
    await expect(forgeWebhookUrls()).resolves.toEqual([])
    getWebServerStatus.mockRejectedValue(new Error("boom"))
    await expect(forgeWebhookUrls()).resolves.toEqual([])
  })
})
