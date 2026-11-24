import type { ForgePanelSettings, ForgeSettingsStore } from "@/lib/types"

/**
 * Sentinel folder id of the global row — the same one the task settings dialog
 * uses for its own "all folders" scope, so the two surfaces speak one language.
 *
 * On the WIRE the global row is `folderId: null`, not `0`: the forge store keys
 * its overrides by real folder id and has a named `global` field, so there is
 * no sentinel to collide with. This constant is a UI value only — what the
 * scope picker holds while "all folders" is chosen.
 */
export const FORGE_GLOBAL_SCOPE = 0

/**
 * What applies to a folder: its own settings WHOLESALE, else the global row.
 *
 * Mirrors `ForgeSettingsStore::effective`. Deliberately not a field-by-field
 * blend — one save detaches a folder from the global row entirely, which is the
 * same rule the task settings follow, and the two dialogs sit one click apart.
 */
export function effectiveForgeSettings(
  store: ForgeSettingsStore | null | undefined,
  folderId: number | null | undefined
): ForgePanelSettings | null {
  if (store == null) return null
  if (folderId == null) return store.global
  return store.folders?.[String(folderId)] ?? store.global
}

/** A folder's OWN settings, or `null` when it follows the global row — what
 *  the settings dialog needs to show the true source rather than guess it. */
export function ownForgeSettings(
  store: ForgeSettingsStore | null | undefined,
  folderId: number | null | undefined
): ForgePanelSettings | null {
  if (store == null || folderId == null) return null
  return store.folders?.[String(folderId)] ?? null
}
