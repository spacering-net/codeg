// Transport-aware bindings for the wallpaper market (wallhaven.cc) commands.
// Same dual-mode pattern as src/lib/workspace-background.ts: everything goes
// through getTransport().call(...) so one code path serves Tauri (invoke) and
// standalone-server (fetch) modes.

import { getTransport } from "@/lib/transport"
import {
  MAX_WORKSPACE_BG_BYTES,
  MAX_WORKSPACE_BG_PIXELS,
  type BackgroundAsset,
} from "@/lib/workspace-background"

// ─── Types ───

/** Category filter mirrored from the Rust `wallhaven_categories` allowlist. */
export const MARKET_CATEGORIES = ["all", "general", "anime", "people"] as const
export type MarketCategory = (typeof MARKET_CATEGORIES)[number]

/**
 * camelCase mirror of the Rust `MarketWallpaperSummary`. `width` / `height` /
 * `fileSizeBytes` are `0` when the listing omitted them.
 */
export type MarketWallpaper = {
  id: string
  thumbUrl: string
  fullUrl: string
  sourceUrl: string
  width: number
  height: number
  fileSizeBytes: number
  category: string
}

// ─── Applicability ───

/** Why a listed wallpaper cannot become a background, or `null` if it can. */
export type MarketWallpaperBlocker = "tooManyBytes" | "tooManyPixels"

/**
 * Whether `download` would refuse this wallpaper, decided from the listing
 * instead of from a failed download.
 *
 * The backend caps market downloads at the same 16 MiB / 40 Mpx as a local pick,
 * and a sizeable minority of wallhaven's catalogue is past one of them — around
 * one card per page of twenty-four on the default browse view. Those cards used
 * to look identical to any other, and clicking one produced "please retry" for a
 * condition retrying cannot change.
 *
 * A `0` (field absent upstream) is treated as "no reason to doubt it" — the
 * backend still has the final say.
 */
export function marketWallpaperBlocker(
  wallpaper: Pick<MarketWallpaper, "width" | "height" | "fileSizeBytes">
): MarketWallpaperBlocker | null {
  if (wallpaper.fileSizeBytes > MAX_WORKSPACE_BG_BYTES) return "tooManyBytes"
  const pixels = wallpaper.width * wallpaper.height
  if (pixels > MAX_WORKSPACE_BG_PIXELS) return "tooManyPixels"
  return null
}

/** `1920×1080`, or `""` when the listing omitted the dimensions. */
export function formatMarketResolution(
  wallpaper: Pick<MarketWallpaper, "width" | "height">
): string {
  if (wallpaper.width <= 0 || wallpaper.height <= 0) return ""
  return `${wallpaper.width}×${wallpaper.height}`
}

/** Compact size for the "why not" hint, e.g. `17.8 MB`. */
export function formatMarketBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Compact pixel count for the "why not" hint, e.g. `132.7 MP`. */
export function formatMarketPixels(pixels: number): string {
  return `${(pixels / 1_000_000).toFixed(1)} MP`
}

/** camelCase mirror of the Rust `MarketSearchPage`. */
export type MarketSearchResult = {
  items: MarketWallpaper[]
  page: number
  lastPage: number
}

// ─── Transport bindings ───

export async function searchWorkspaceBgMarket(input: {
  query: string
  category: MarketCategory
  page: number
}): Promise<MarketSearchResult> {
  return getTransport().call("background_market_search", {
    query: input.query,
    category: input.category,
    page: input.page,
  })
}

export async function fetchWorkspaceBgMarketAsset(
  url: string
): Promise<BackgroundAsset> {
  return getTransport().call("background_market_asset", { url })
}

export async function downloadWorkspaceBgMarket(
  url: string,
  sourceUrl: string
): Promise<void> {
  return getTransport().call("background_market_download", {
    url,
    sourceUrl,
  })
}
