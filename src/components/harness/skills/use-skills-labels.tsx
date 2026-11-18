"use client"

import { useMemo, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"

import { getAgentLabel } from "@/lib/custom-agents"
import type { CellKind } from "@/lib/skills/model"
import type { SkillsIssue } from "@/lib/skills/types"
import { Code } from "../discover/detail-sections"

/** Every code the engine can report (k1-api §8), each with a message. */
export const SKILLS_ISSUE_CODES = [
  "lock_busy",
  "lock_held",
  "io_error",
  "skill_invalid",
  "skill_not_found",
  "agent_unsupported",
  "name_taken",
  "id_taken",
  "id_reserved",
  "target_occupied",
  "target_linked_elsewhere",
  "target_broken",
  "no_own_directory",
  "not_visible",
  "acknowledgement_required",
  "effects_changed",
  "copy_modified",
  "link_failed",
  "copy_failed",
  "remove_failed",
  "record_write_failed",
  "rollback_failed",
  "path_outside_agent_dirs",
  "not_codeg_link",
  "not_broken",
  "not_found",
  "already_visible",
  "shared_directory",
  "disabled_together",
  "copied",
  "copy_modified_kept",
  "name_also_elsewhere",
  "no_copy",
  "store_link_read_only",
  "read_only_skill",
  "not_own_skill",
  "verify_failed",
  "invalid_source",
  "backup_not_found",
  "backup_linked",
  "manifest_unreadable",
  "ownership_unresolved",
  "officecli_not_installed",
  "command_failed",
] as const

/** Codes whose sentence names agents. */
const WITH_AGENTS = new Set([
  "shared_directory",
  "disabled_together",
  "backup_linked",
  "acknowledgement_required",
])

export const SKILLS_OP_STATUSES = [
  "ready",
  "unchanged",
  "needs_ack",
  "blocked",
  "done",
  "not_done",
  "failed",
  "rolled_back",
  "rollback_failed",
] as const

export const SKILLS_ORIGINS = [
  "experts",
  "science",
  "office",
  "ui",
  "harness",
  "custom",
] as const

export const SKILLS_OWNERS = [
  "pack",
  "harness",
  "custom",
  "agent",
  "linked_elsewhere",
  "broken",
] as const

const has = (list: readonly string[], value: string) => list.includes(value)

/** Where `detail` is a word the message is made of, not technical text to
 *  show under it: an `id_reserved` for a skill Harness installed carries
 *  `"harness"`; an `ownership_unresolved`, the pack. */
export const detailIsWording = (issue: SkillsIssue) =>
  (issue.code === "id_reserved" && issue.detail === "harness") ||
  issue.code === "ownership_unresolved"

export interface SkillsLabels {
  locale: string
  /** An agent's name as the rest of the app shows it. */
  agent: (id: string) => string
  /** A list of names, joined with the locale's separator. */
  list: (items: readonly string[]) => string
  agents: (ids: readonly string[]) => string
  /** A code in words. `path` and `detail` are never the message: the caller
   *  shows them, where they help, beside it. */
  issue: (issue: SkillsIssue) => ReactNode
  status: (status: string) => string
  /** Where a skill comes from: a pack, Harness, Custom. */
  origin: (origin: string) => string
  /** Whose an agent's listed skill is. */
  owner: (owner: string | null, pack?: string | null) => string
  /** A cell in words, as plain text — an accessible name, a tooltip;
   *  `dir` is the shared folder of a `through` cell. */
  cellText: (kind: CellKind, dir?: string | null, state?: string) => string
  /** A cell in a word or two, for a mark beside the agent's name: on, off,
   *  the name taken. */
  cellChip: (kind: CellKind, state?: string) => string
  /** What the mark leaves out — how an "on" cell is on, what holds the
   *  name — or `null` where the mark says it all. */
  cellNote: (kind: CellKind, dir?: string | null) => ReactNode | null
  date: (iso: string) => string
}

/** Cells whose name is held by something that is not Codeg's skill. */
const CELL_TAKEN: ReadonlySet<CellKind> = new Set([
  "blocked",
  "elsewhere",
  "broken",
  "brokenOther",
])

/**
 * The skills sections' vocabulary: the engine's codes, statuses, origins and
 * owners, the agents' names — with an answer for every value, including those
 * a newer backend may send. No code reaches the page as its raw name, and no
 * untranslated `detail` stands in for a message.
 */
export function useSkillsLabels(): SkillsLabels {
  const t = useTranslations("Harness.skills")
  const tHarness = useTranslations("Harness.skillInstall")
  const locale = useLocale()
  return useMemo(() => {
    const code = (chunks: ReactNode) => <Code>{chunks}</Code>
    const separator = t("listSeparator")
    const list = (items: readonly string[]) => items.join(separator)
    const agent = (id: string) => getAgentLabel(id)
    const agents = (ids: readonly string[]) => list(ids.map(agent))
    const dateFormat = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    })
    return {
      locale,
      agent,
      list,
      agents,
      issue: (item: SkillsIssue) => {
        const c = item.code
        if (c === "id_reserved" && item.detail === "harness") {
          return t.rich("issues.id_reserved_harness", { code })
        }
        // The Harness manifest could not be read: the folder may be a skill
        // Harness installed, not a pack's.
        if (c === "ownership_unresolved" && item.detail === "harness") {
          return tHarness("ownershipUnresolved")
        }
        if (c === "ownership_unresolved") {
          const pack = item.detail ?? ""
          return t.rich("issues.ownership_unresolved", {
            pack: has(SKILLS_ORIGINS, pack)
              ? t(`origins.${pack}` as never)
              : pack || "?",
            code,
          })
        }
        // Thrown by a new skill's save: who would see it, in the folder the
        // agent shares — it has none of its own.
        if (c === "no_own_directory" && item.agents?.length) {
          return t.rich("issues.no_own_directory_shared", {
            agents: agents(item.agents),
            code,
          })
        }
        // Without agents it is the agent's own copy; with them, another
        // reader's copy that enabling or repointing would leave beside ours.
        if (c === "copy_modified" && item.agents?.length) {
          return t.rich("issues.copy_modified_others", {
            agents: agents(item.agents),
            code,
          })
        }
        if (has(SKILLS_ISSUE_CODES, c)) {
          if (WITH_AGENTS.has(c)) {
            const names = item.agents?.length ? agents(item.agents) : "—"
            return t.rich(
              `issues.${c}` as never,
              {
                agents: names,
                code,
              } as never
            )
          }
          return t.rich(`issues.${c}` as never, { code } as never)
        }
        // `name`, not `code`: `code` is the tag the code is shown in.
        return t.rich("issues.unknown", { name: c, code })
      },
      status: (status: string) =>
        has(SKILLS_OP_STATUSES, status)
          ? t(`status.${status}` as never)
          : t("status.unknown", { status }),
      origin: (origin: string) =>
        has(SKILLS_ORIGINS, origin)
          ? t(`origins.${origin}` as never)
          : t("origins.unknown", { origin }),
      owner: (owner: string | null, pack?: string | null) => {
        if (owner === "pack") {
          return t("owners.pack", {
            pack:
              pack && has(SKILLS_ORIGINS, pack)
                ? t(`origins.${pack}` as never)
                : (pack ?? "?"),
          })
        }
        if (owner && has(SKILLS_OWNERS, owner)) {
          return t(`owners.${owner}` as never)
        }
        return t("owners.unknown")
      },
      cellText: (kind: CellKind, dir?: string | null, state?: string) => {
        if (kind === "through") {
          return t("cellsText.through", { dir: dir ?? "?" })
        }
        if (kind === "unknown")
          return t("cells.unknown", { state: state ?? "?" })
        return t(`cells.${kind}` as never)
      },
      cellChip: (kind: CellKind, state?: string) => {
        if (kind === "off") return t("cells.off")
        if (kind === "unknown")
          return t("cells.unknown", { state: state ?? "?" })
        if (CELL_TAKEN.has(kind)) return t("cellChips.taken")
        return t("cells.on")
      },
      cellNote: (kind: CellKind, dir?: string | null) => {
        if (kind === "through") {
          return t.rich("cellNotes.through", { dir: dir ?? "?", code })
        }
        if (
          kind === "copy" ||
          kind === "copyOutdated" ||
          kind === "copyChanged"
        ) {
          return t(`cellNotes.${kind}`)
        }
        if (CELL_TAKEN.has(kind)) return t(`cells.${kind}` as never)
        return null
      },
      date: (iso: string) => {
        const date = new Date(iso)
        return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date)
      },
    }
  }, [t, tHarness, locale])
}
