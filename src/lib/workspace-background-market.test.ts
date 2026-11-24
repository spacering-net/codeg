import { beforeEach, describe, expect, it, vi } from "vitest"

const callMock = vi.fn()

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: callMock }),
}))

import {
  downloadWorkspaceBgMarket,
  fetchWorkspaceBgMarketAsset,
  formatMarketBytes,
  formatMarketPixels,
  formatMarketResolution,
  marketWallpaperBlocker,
  searchWorkspaceBgMarket,
} from "./workspace-background-market"

beforeEach(() => {
  callMock.mockReset()
})

describe("workspace-background-market transport bindings", () => {
  it("passes camelCase params to background_market_search", async () => {
    callMock.mockResolvedValue({ items: [], page: 2, lastPage: 5 })
    await searchWorkspaceBgMarket({
      query: "mountain",
      category: "anime",
      page: 2,
    })
    expect(callMock).toHaveBeenCalledWith("background_market_search", {
      query: "mountain",
      category: "anime",
      page: 2,
    })
  })

  it("proxies asset fetch through background_market_asset", async () => {
    callMock.mockResolvedValue({ mime: "image/jpeg", dataBase64: "eHg=" })
    await fetchWorkspaceBgMarketAsset("https://th.wallhaven.cc/small/ab/x.jpg")
    expect(callMock).toHaveBeenCalledWith("background_market_asset", {
      url: "https://th.wallhaven.cc/small/ab/x.jpg",
    })
  })

  it("sends url + sourceUrl to background_market_download", async () => {
    callMock.mockResolvedValue(undefined)
    await downloadWorkspaceBgMarket(
      "https://w.wallhaven.cc/full/ab/x.jpg",
      "https://wallhaven.cc/w/x"
    )
    // The timeout sits above the backend's 570 s download deadline so its
    // structured error, not a 60 s transport abort, reaches the user.
    expect(callMock).toHaveBeenCalledWith(
      "background_market_download",
      {
        url: "https://w.wallhaven.cc/full/ab/x.jpg",
        sourceUrl: "https://wallhaven.cc/w/x",
      },
      { timeoutMs: 600_000 }
    )
  })
})

describe("marketWallpaperBlocker", () => {
  // The thresholds must track src-tauri `MAX_BG_BYTES` / `MAX_BG_PIXELS`; a
  // wallpaper the backend would refuse must never be offered as clickable.
  const sized = (fileSizeBytes: number, width = 1920, height = 1080) => ({
    fileSizeBytes,
    width,
    height,
  })

  it("passes a wallpaper inside both caps", () => {
    expect(marketWallpaperBlocker(sized(4_455_320))).toBeNull()
    // Past the old 16 MiB ceiling — no longer refused.
    expect(marketWallpaperBlocker(sized(20 * 1024 * 1024))).toBeNull()
    // Exactly at the ceiling is still fine — the backend uses `>` too.
    expect(marketWallpaperBlocker(sized(64 * 1024 * 1024))).toBeNull()
    expect(marketWallpaperBlocker(sized(1000, 8000, 5000))).toBeNull()
    // A 10K wallpaper, past the old 40 Mpx ceiling — no longer refused.
    expect(marketWallpaperBlocker(sized(1000, 10240, 5760))).toBeNull()
    expect(marketWallpaperBlocker(sized(1000, 10_000, 10_000))).toBeNull()
  })

  it("blocks a wallpaper past the byte cap", () => {
    expect(marketWallpaperBlocker(sized(64 * 1024 * 1024 + 1))).toBe(
      "tooManyBytes"
    )
  })

  it("blocks a wallpaper past the pixel cap", () => {
    expect(marketWallpaperBlocker(sized(1000, 15360, 8640))).toBe(
      "tooManyPixels"
    )
    expect(marketWallpaperBlocker(sized(1000, 10_000, 10_001))).toBe(
      "tooManyPixels"
    )
  })

  it("treats a listing that omitted the sizes as unknown, not blocked", () => {
    expect(marketWallpaperBlocker(sized(0, 0, 0))).toBeNull()
  })
})

describe("market formatting helpers", () => {
  it("formats a resolution only when both dimensions are known", () => {
    expect(formatMarketResolution({ width: 1920, height: 1080 })).toBe(
      "1920×1080"
    )
    expect(formatMarketResolution({ width: 0, height: 1080 })).toBe("")
  })

  it("formats sizes the way the 'too large' hint reads them", () => {
    expect(formatMarketBytes(64 * 1024 * 1024)).toBe("64.0 MB")
    expect(formatMarketPixels(132_710_400)).toBe("132.7 MP")
  })
})
