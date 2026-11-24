/**
 * What a skill can be called. The rule is the backend's `validate_skill_id`,
 * mirrored so a name the backend would refuse is said to be wrong while it is
 * being typed. The backend still has the last word: it also refuses a name
 * that is taken, or that one of Codeg's packs keeps for itself, and the page
 * shows what it says.
 */

/** Why a name cannot be a skill's. */
export type SkillIdProblem = "empty" | "invalid"

const ALLOWED = /^[A-Za-z0-9._-]+$/

export function skillIdProblem(raw: string): SkillIdProblem | null {
  const id = raw.trim()
  if (id === "") return "empty"
  if (id.startsWith(".") || id.includes("..") || !ALLOWED.test(id)) {
    return "invalid"
  }
  return null
}

/** `base` when it is free, else `base-2`, `base-3`, and so on. */
export function freeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const next = `${base}-${n}`
    if (!taken.has(next)) return next
  }
}

/** A name for a copy of `id` that is not taken yet: `id-copy`, then
 *  `id-copy-2`, and so on. */
export function freeCopyId(id: string, taken: ReadonlySet<string>): string {
  return freeId(`${id}-copy`, taken)
}
