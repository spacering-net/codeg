// src/lib/theme-preset-library.ts
//
// tweakcn's published themes, snapshotted by `pnpm themes:fetch` (see
// `scripts/fetch-theme-presets.mjs` for where they come from and which variables
// survive the trip).
//
// A preset is data, not behaviour: applying one is nothing more than replacing
// the custom-theme overrides with its two variable maps, which is the same path
// an imported shadcn theme takes. That is why nothing here touches the DOM —
// `AppearanceProvider` already owns writing overrides to `<html>`.

import library from "./theme-preset-library.json"
import { sanitizeCustomTheme, type CustomTheme } from "./custom-style"

/** One tweakcn theme, already reduced to the variables this app can apply. */
export type PresetLibraryEntry = {
  id: string
  /** tweakcn's display name, kept in English. */
  label: string
  light: Record<string, string>
  dark: Record<string, string>
}

export const PRESET_LIBRARY = library as PresetLibraryEntry[]

const byId = new Map(PRESET_LIBRARY.map((entry) => [entry.id, entry]))

export function presetLibraryEntry(id: string): PresetLibraryEntry | undefined {
  return byId.get(id)
}

/**
 * The overrides a preset stands for.
 *
 * Runs through `sanitizeCustomTheme` rather than handing the maps over directly:
 * the snapshot is a committed file that can be regenerated from a remote
 * registry, so it gets the same whitelist and value check as a pasted theme.
 */
export function presetToCustomTheme(entry: PresetLibraryEntry): CustomTheme {
  return sanitizeCustomTheme({ light: entry.light, dark: entry.dark })
}

/** The six colours a preview swatch needs to stand for a whole theme. */
const PREVIEW_TOKENS = [
  "background",
  "foreground",
  "primary",
  "secondary",
  "accent",
  "border",
] as const

export function presetPreviewColors(
  entry: PresetLibraryEntry,
  dark: boolean
): string[] {
  const vars = dark ? entry.dark : entry.light
  return PREVIEW_TOKENS.map((token) => vars[token] ?? "")
}
