/**
 * What the Skills section knows of skills installed from SpaceRing Harness
 * beyond what the inventory says: one mark per store id, from the Harness
 * manifest as `harness_installed` reads it against the folders now — and the
 * actions on such a skill.
 *
 * A mark has two halves, as the MCP section's (`mcp-marks.ts`). `local` is
 * how the folder stands against what Codeg installed (known now). `remote`
 * is what the catalog says of the installed version — up to date, a newer
 * one out, withdrawn, taken down — which the host's update check tells (H6,
 * `./updates.ts`): `null` until it has, and where it has nothing to say, so
 * the section then shows no "update available" and offers no filter for it
 * (a filter that can never match is not offered).
 */
import { useMemo } from "react"

import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { HARNESS_INSTALLED } from "./mcp-install-state"
import type { HarnessReason } from "./mcp-install-types"
import { openSkillInstall, openSkillUninstall } from "./skill-install-state"
import type {
  HarnessInstalledSkill,
  HarnessSkillFileChanges,
  HarnessSkillRewrites,
} from "./skill-install-types"
import {
  HARNESS_UPDATES,
  remoteFor,
  updatesById,
  type HarnessUpdates,
} from "./updates"

/** The states plan §7.7 gives an installed item, as M2's MCP seam has them. */
export const SKILLS_HARNESS_STATES = [
  "latest",
  "updateAvailable",
  "yanked",
  "disabledByAuthor",
  "removedByHarness",
  "changedLocally",
  "filesMissing",
] as const

export type SkillsHarnessState = (typeof SKILLS_HARNESS_STATES)[number]

/** How an installed skill's folder stands, by the manifest's check. */
export type SkillsHarnessLocalState =
  | "asInstalled"
  | "changedLocally"
  | "filesMissing"
  /** The folder cannot be read: nothing can be said. */
  | "unknown"

/** What the update check (H6) will say of the installed version. */
export type SkillsHarnessRemoteState = Extract<
  SkillsHarnessState,
  | "latest"
  | "updateAvailable"
  | "yanked"
  | "disabledByAuthor"
  | "removedByHarness"
>

/** One skill installed from Harness, under its store id. */
export interface SkillsHarnessMark {
  itemId: string
  /** The item's address as recorded at the last install. */
  itemRef: string
  /** The install name: the store id. */
  name: string
  revision: number
  version: string | null
  local: SkillsHarnessLocalState
  /** The update check's word on it; `null` until there is one (H6). */
  remote: SkillsHarnessRemoteState | null
  /** A newer revision is out — also beside a withdrawn or taken-down one,
   *  or a folder changed here, when there is one to move to. What the
   *  "Update available" filter goes by. */
  updateAvailable: boolean
  /** Who sees Codeg's link (or copy) of it now. */
  agents: string[]
  files: HarnessSkillFileChanges
  rewrites: HarnessSkillRewrites
  installedAt: string
}

export interface SkillsHarnessSeam {
  /** By store id: the one state a Harness skill is marked with, where there
   *  is one — the folder's own state first, then the catalog's. */
  states: ReadonlyMap<string, SkillsHarnessState>
  /** By store id: everything the listing says of it. */
  marks: ReadonlyMap<string, SkillsHarnessMark>
  /** The manifest could not be read: no skill is marked, and this says why. */
  problem: HarnessReason | null
  /** Whether the catalog is offered here. Updating asks it; uninstalling
   *  only touches this host's files. */
  catalog: boolean
  /** Start updating the skill installed as `id` (to the newest revision).
   *  Absent where the catalog is switched off. */
  update?: (id: string) => void
  uninstall?: (id: string) => void
}

export function skillLocalStateOf(state: string): SkillsHarnessLocalState {
  switch (state) {
    case "as_installed":
      return "asInstalled"
    case "changed_locally":
      return "changedLocally"
    case "missing":
      return "filesMissing"
    default:
      return "unknown"
  }
}

/** The marks a listing makes, by install name. Should two records ever
 *  claim one name, the first listed keeps it. `updates`: the host's update
 *  check, for the `remote` half. */
export function skillMarksOf(
  skills: readonly HarnessInstalledSkill[],
  updates: HarnessUpdates | null = null
): ReadonlyMap<string, SkillsHarnessMark> {
  const marks = new Map<string, SkillsHarnessMark>()
  const checked = updatesById(updates)
  for (const skill of skills) {
    if (marks.has(skill.name)) continue
    const { remote, updateAvailable } = remoteFor(
      checked.get(skill.id),
      skill.revision
    )
    marks.set(skill.name, {
      itemId: skill.id,
      itemRef: skill.ref,
      name: skill.name,
      revision: skill.revision,
      version: skill.version,
      local: skillLocalStateOf(skill.state),
      remote,
      updateAvailable,
      agents: [...skill.agents],
      files: skill.files,
      rewrites: skill.rewrites,
      installedAt: skill.installed_at,
    })
  }
  return marks
}

/** The one state a mark shows: a folder changed or incomplete says more
 *  than the catalog's word on the version. */
export function skillStateOf(
  mark: SkillsHarnessMark
): SkillsHarnessState | null {
  if (mark.local === "changedLocally" || mark.local === "filesMissing") {
    return mark.local
  }
  return mark.remote
}

/**
 * The seam, once the host has said what it has installed; `undefined`
 * before that, and from a Codeg too old to say — the section then shows no
 * Harness marks beyond the inventory's own rather than guessing.
 */
export function useSkillsHarness(): SkillsHarnessSeam | undefined {
  const { slots, discoverEnabled } = useHarnessView()
  const [state] = useHarnessSlot(HARNESS_INSTALLED)
  const [updatesState] = useHarnessSlot(HARNESS_UPDATES)
  const updates = updatesState.value
  const value = state.value
  return useMemo(() => {
    if (!value) return undefined
    const marks = skillMarksOf(value.skills, updates)
    const checked = updatesById(updates)
    const states = new Map<string, SkillsHarnessState>()
    for (const [id, mark] of marks) {
      const shown = skillStateOf(mark)
      if (shown) states.set(id, shown)
    }
    const seam: SkillsHarnessSeam = {
      states,
      marks,
      problem: value.skills_problem,
      catalog: discoverEnabled,
      uninstall: (id) => {
        const mark = marks.get(id)
        if (mark) {
          openSkillUninstall(slots, {
            itemId: mark.itemId,
            itemRef: mark.itemRef,
            name: mark.name,
          })
        }
      },
    }
    if (discoverEnabled) {
      seam.update = (id) => {
        const mark = marks.get(id)
        if (mark) {
          // At its address now: a rename keeps the id, not the address.
          openSkillInstall(slots, {
            itemRef: checked.get(mark.itemId)?.ref ?? mark.itemRef,
            purpose: "update",
            from: "skills",
          })
        }
      }
    }
    return seam
  }, [value, updates, slots, discoverEnabled])
}
