"use client"

import { useMemo, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"

import { getAgentLabel } from "@/lib/custom-agents"
import { formatBytes, knownKind, oneOf } from "@/lib/harness/display"
import type { HarnessReason } from "@/lib/harness/mcp-install-types"
import type { HarnessSkillNameTaken } from "@/lib/harness/skill-install-types"
import { Code } from "../discover/detail-sections"
import { SKILLS_ORIGINS, useSkillsLabels } from "../skills/use-skills-labels"
import { useInstallLabels } from "./use-install-labels"

/**
 * Every code a skill install can come back with that the MCP install step's
 * labels do not word (h3-api §7), each with its words — for the test that
 * checks none is left unworded, in any language. The codes the two steps
 * share (the item's state, a package the snapshot lists, `yanked`, …) are
 * worded by `useInstallLabels`.
 */
export const SKILL_INSTALL_REASON_CODES = [
  // The item.
  "not_a_skill",
  "manifest_unreadable",
  "nothing_to_install",
  // The package, by its listing.
  "unsafe_path",
  "duplicate_path",
  "too_many_files",
  "file_too_large",
  "package_too_large",
  "too_deep",
  "path_too_long",
  "archive_too_large",
  "skill_md_missing",
  "hash_invalid",
  "hash_invalid_archive",
  "archive_address_invalid",
  "source_invalid",
  // The package, as downloaded.
  "archive_size_mismatch",
  "archive_hash_mismatch",
  "archive_unreadable",
  "file_missing",
  "file_unexpected",
  "file_size_mismatch",
  "file_hash_mismatch",
  "compression_ratio",
  "link_in_archive",
  "source_file_unavailable",
  "skill_md_invalid",
  // The call.
  "name_invalid",
  "name_reserved",
  "name_taken",
  "installed_under_other_name",
  "agent_unsupported",
  "acknowledgement_required",
  "effects_changed",
  // Warnings.
  "allowed_tools",
  "fetched_from_source",
  "files_changed_locally",
  "files_unreadable",
  // Disk and lock.
  "io_error",
  "manifest_write_failed",
  "rollback_failed",
  "unlink_failed",
  "lock_busy",
  "lock_held",
] as const

/** Who can hold a name (`NameTaken.by`). */
export const NAME_TAKEN_BY = [
  "reserved",
  "pack",
  "custom",
  "harness",
  "store",
  "codeg_link",
  "agent_dir",
] as const

export const SKILL_INSTALL_PHASES = [
  "download",
  "verify",
  "stage",
  "snapshot",
  "unlink",
  "swap",
  "commit",
  "cleanup",
  "backup",
  "copies",
  "links",
] as const

export const SKILL_PHASE_STATUSES = [
  "done",
  "skipped",
  "failed",
  "rolled_back",
] as const

const SOURCE_FIELDS = ["repository", "commit", "path"] as const

export interface SkillInstallLabels {
  /** A reason in words — the skill step's own codes here, the rest as the
   *  MCP step words them. */
  reason: (reason: HarnessReason) => ReactNode
  /** Who holds a name, in words. */
  taken: (entry: HarnessSkillNameTaken) => ReactNode
  phase: (phase: string) => string
  phaseStatus: (status: string) => string
  agent: (id: string) => string
  agents: (ids: readonly string[]) => string
  bytes: (value: number | string) => string
}

/**
 * The words for a skill install's codes: what in a package is not what it
 * says, why a name is taken, a link that needs confirming, the steps of an
 * install that failed part-way. Every code has an answer — one this build
 * does not know is shown as itself, in a sentence that says so — and no
 * `detail` ever stands in for the words.
 */
export function useSkillInstallLabels(): SkillInstallLabels {
  const t = useTranslations("Harness.skillInstall")
  const tOrigin = useTranslations("Harness.skills.origins")
  const tKind = useTranslations("Harness.discover.kind")
  const locale = useLocale()
  const install = useInstallLabels()
  const skills = useSkillsLabels()
  return useMemo(() => {
    const code = (chunks: ReactNode) => <Code>{chunks}</Code>
    const rich = (key: string, values: Record<string, string> = {}) =>
      t.rich(key as never, { ...values, code } as never)
    const agent = (id: string) => getAgentLabel(id)
    const agents = (ids: readonly string[]) => skills.list(ids.map(agent))
    const bytes = (value: number | string) => {
      const amount = typeof value === "number" ? value : Number(value)
      return Number.isFinite(amount) && value !== ""
        ? formatBytes(amount, locale)
        : String(value || "?")
    }
    const pack = (value: string | null) =>
      value && oneOf(SKILLS_ORIGINS, value)
        ? tOrigin(value as never)
        : value || "?"

    const taken: SkillInstallLabels["taken"] = (entry) => {
      const by = oneOf(NAME_TAKEN_BY, entry.by)
      switch (by) {
        case "reserved":
        case "pack":
          return rich(`taken.${by}`, { pack: pack(entry.pack) })
        case "harness":
          return rich("taken.harness", {
            ref: entry.item_ref ?? entry.item_id ?? "?",
          })
        case "codeg_link":
        case "agent_dir":
          // A refusal names the path only; the plan names whose folder.
          return entry.agents.length > 0
            ? rich(`taken.${by}`, { agents: agents(entry.agents) })
            : rich(`taken.${by}At`, { path: entry.path ?? "?" })
        case "custom":
        case "store":
          return rich(`taken.${by}`)
        default:
          return rich("taken.unknown", { name: String(entry.by) })
      }
    }

    const reason: SkillInstallLabels["reason"] = (item) => {
      const p = (name: string) => item.params[name] ?? ""
      const or = (name: string) => p(name) || "?"
      switch (item.code) {
        case "not_a_skill":
          return rich("reasons.not_a_skill", {
            kind: tKind(knownKind(p("kind")) ?? "unknown"),
          })
        case "unsafe_path":
        case "duplicate_path":
        case "file_missing":
        case "file_unexpected":
        case "file_hash_mismatch":
        case "link_in_archive":
        case "source_file_unavailable":
          return rich(`reasons.${item.code}`, { path: or("path") })
        case "too_many_files":
          return rich("reasons.too_many_files", {
            count: or("count"),
            limit: or("limit"),
          })
        case "file_too_large":
          return rich("reasons.file_too_large", {
            path: or("path"),
            size: bytes(p("size")),
            limit: bytes(p("limit")),
          })
        case "package_too_large":
        case "archive_too_large":
          return rich(`reasons.${item.code}`, {
            size: bytes(p("size")),
            limit: bytes(p("limit")),
          })
        case "too_deep":
        case "path_too_long":
          return rich(`reasons.${item.code}`, {
            path: or("path"),
            limit: or("limit"),
          })
        case "compression_ratio":
          return rich("reasons.compression_ratio", {
            path: or("path"),
            limit: or("limit"),
          })
        case "hash_invalid":
          return p("path")
            ? rich("reasons.hash_invalid", { path: p("path") })
            : rich("reasons.hash_invalid_archive")
        case "source_invalid": {
          const field = oneOf(SOURCE_FIELDS, p("field"))
          return rich("reasons.source_invalid", {
            field: t(`sourceField.${field ?? "other"}`),
          })
        }
        case "archive_size_mismatch":
          return rich("reasons.archive_size_mismatch", {
            expected: bytes(p("expected")),
            actual: bytes(p("actual")),
          })
        case "file_size_mismatch":
          return rich("reasons.file_size_mismatch", {
            path: or("path"),
            expected: bytes(p("expected")),
          })
        case "name_invalid":
        case "installed_under_other_name":
          return rich(`reasons.${item.code}`, { name: or("name") })
        case "name_reserved":
          return rich("reasons.name_reserved", {
            name: or("name"),
            pack: pack(p("pack") || null),
          })
        case "name_taken": {
          const head = rich("reasons.name_taken", { name: or("name") })
          const by = p("by")
          if (!by) return head
          return (
            <>
              {head}{" "}
              {taken({
                name: p("name"),
                by,
                pack: null,
                item_id: null,
                item_ref: p("item_ref") || null,
                path: p("path") || null,
                agents: [],
              })}
            </>
          )
        }
        case "agent_unsupported":
        case "acknowledgement_required":
        case "effects_changed":
          return rich(`reasons.${item.code}`, { agent: agent(or("agent")) })
        case "allowed_tools":
          return rich("reasons.allowed_tools", { tools: or("tools") })
        case "fetched_from_source":
          return rich("reasons.fetched_from_source", {
            repository: or("repository"),
            commit: or("commit").slice(0, 12),
          })
        case "files_changed_locally":
          return t.rich("reasons.files_changed_locally", {
            count: Number(p("count")) || 0,
            code,
          })
        case "unlink_failed":
          return (
            <>
              {rich("reasons.unlink_failed", { path: or("path") })}{" "}
              {skills.issue({ code: p("code") || "unknown" })}
            </>
          )
      }
      if (oneOf(SKILL_INSTALL_REASON_CODES, item.code)) {
        return rich(`reasons.${item.code}`)
      }
      // A code the MCP step words too: the item's state, the snapshot's
      // packages, the withdrawn version, nothing recorded.
      return install.reason(item)
    }

    return {
      reason,
      taken,
      phase: (value) => {
        const known = oneOf(SKILL_INSTALL_PHASES, value)
        return known
          ? t(`phases.${known}`)
          : t("phases.unknown", { phase: value })
      },
      phaseStatus: (value) =>
        t(`phaseStatus.${oneOf(SKILL_PHASE_STATUSES, value) ?? "unknown"}`),
      agent,
      agents,
      bytes,
    }
  }, [t, tOrigin, tKind, locale, install, skills])
}
