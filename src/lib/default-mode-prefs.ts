/**
 * Classification helper shared by the floating ball's "Plan ⇄ full access"
 * toggle: identify the full-access mode among an agent's advertised mode ids.
 * Each CLI calls full access something else (zcode `yolo`, codex
 * `danger-full-access`, claude `bypassPermissions`), so the match runs a fixed
 * weight order of well-known substrings — no blind id guessing, the backend
 * would silently drop a wrong preferred id.
 */

/** Substrings that identify a full-access mode, in match priority order. */
export const FULL_ACCESS_WEIGHTS = [
  "danger",
  "bypass",
  "yolo",
  "full",
  "access",
] as const

/**
 * Match a full-access mode among the advertised ids. Weight order decides
 * between multiple hits (an agent offering both `yolo` and
 * `danger-full-access` gets the `danger` one); ties resolve by list order so
 * the result is stable across restarts.
 */
export function matchFullAccessMode(modeIds: readonly string[]): string | null {
  for (const weight of FULL_ACCESS_WEIGHTS) {
    for (const id of modeIds) {
      if (id.toLowerCase().includes(weight)) return id
    }
  }
  return null
}
