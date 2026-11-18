"use client"

import { useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import { getAgentLabel } from "@/lib/custom-agents"
import { knownKind, knownRisk, oneOf } from "@/lib/harness/display"
import type {
  HarnessReason,
  HarnessUninstallAction,
} from "@/lib/harness/mcp-install-types"
import { HARNESS_PERMISSION_KEYS } from "@/lib/harness/types"
import { isMcpAppType } from "@/lib/mcp/types"
import { Code } from "../discover/detail-sections"

/**
 * Every code an install can come back with (h4-api §7), each with its words
 * — for the test that checks none is left unworded, in any language.
 */
export const INSTALL_REASON_CODES = [
  // The item as a whole.
  "not_an_mcp_server",
  "item_unavailable",
  "revision_unavailable",
  "version_blocked",
  "version_status_unknown",
  "snapshot_incomplete",
  "nothing_to_install",
  "server_unreadable",
  "record_unreadable",
  // One option.
  "registry_unsupported",
  "runtime_unsupported",
  "identifier_has_version",
  "runtime_arguments_unsupported",
  "runner_environment_unsupported",
  "package_not_pinned",
  "package_version_inexact",
  "package_missing",
  "package_verification_unknown",
  "remote_not_public",
  "secret_in_query",
  // Warnings.
  "version_unverified",
  "install_script",
  "secret_not_sent",
  // To confirm.
  "yanked",
  // The call.
  "key_invalid",
  "key_reserved",
  "no_targets",
  "replace_not_target",
  "basis_required",
  "option_not_found",
  "parameter_required",
  "replace_required",
  "yanked_not_accepted",
  "installed_under_other_key",
  "conversion_failed",
  "not_installed",
] as const

/** What changed between the state the user saw and the one now (§7.5). */
export const INSTALL_CHANGE_CODES = [
  "status_changed",
  "risk_changed",
  "reviewed_changed",
  "permission_added",
  "permission_removed",
  "findings_changed",
  "secrets_found_changed",
  "review_changed",
  "package_added",
  "package_removed",
  "package_version_changed",
  "verification_changed",
  "install_script_added",
  "install_script_removed",
  "state_changed",
] as const

export const RECORD_CODES = [
  "record_unreadable",
  "record_write_failed",
  "record_conflict",
] as const

export const UNINSTALL_ACTIONS = [
  "remove",
  "keep_changed",
  "keep_unknown",
  "forget",
  "not_requested",
] as const

export const VERSION_STATUSES = ["ok", "yanked", "blocked"] as const
const PACKAGE_CHECKS = ["ok", "missing", "unchecked", "pending"] as const
const MODEL_REVIEWS = ["off", "pending", "done"] as const
const SNAPSHOT_FIELDS = [
  "risk",
  "reviewed",
  "permissions",
  "checks",
  "packages",
  "stateSha256",
] as const
const SEVERITIES = ["low", "medium", "high"] as const

export interface InstallLabels {
  /** A reason in words. `parameterName` turns a parameter's key
   *  (`env.API_KEY`) into the name the dialog shows it under. */
  reason: (
    reason: HarnessReason,
    options?: { parameterName?: (key: string) => string }
  ) => ReactNode
  /** One entry of what changed. */
  change: (change: HarnessReason) => ReactNode
  /** A version's status: available, withdrawn, blocked, unknown. */
  status: (status: string) => string
  /** A risk level, lower-case, for "from → to". `null`: not stated. */
  risk: (risk: string | null) => string
  /** A package check, as the Discover detail words it. */
  check: (verified: string | null) => string
  /** What an uninstall does to one agent. */
  uninstallAction: (action: HarnessUninstallAction) => string
  /** Why the record could not be written. */
  record: (code: string | null) => string
  agent: (id: string) => string
}

/**
 * The words for an install's codes: the reasons an item or a way of running
 * it cannot be installed, the warnings, the refusals, what changed in the
 * catalog's account, what the record write came to. Every code has an answer
 * — one this build does not know is shown as itself, in a sentence that says
 * so — and no `detail` ever stands in for the words.
 */
export function useInstallLabels(): InstallLabels {
  const t = useTranslations("Harness.install")
  const tDetail = useTranslations("Harness.discover.detail")
  const tKind = useTranslations("Harness.discover.kind")
  return useMemo(() => {
    const code = (chunks: ReactNode) => <Code>{chunks}</Code>
    const rich = (key: string, values: Record<string, string> = {}) =>
      t.rich(key as never, { ...values, code } as never)
    const agent = (id: string) => (isMcpAppType(id) ? getAgentLabel(id) : id)
    const check = (verified: string | null) =>
      tDetail(
        `verified.${(verified && oneOf(PACKAGE_CHECKS, verified)) || "unknown"}`
      )
    const status = (value: string) => {
      const known = oneOf(VERSION_STATUSES, value)
      return t(`status.${known ?? "unknown"}`)
    }
    const risk = (value: string | null) =>
      value === null || value === ""
        ? t("riskLevel.none")
        : t(`riskLevel.${knownRisk(value) ?? "unknown"}`)
    const review = (value: string) =>
      t(`modelReview.${oneOf(MODEL_REVIEWS, value) ?? "unknown"}`)
    const permission = (field: string) => {
      const known = oneOf(HARNESS_PERMISSION_KEYS, field)
      return known ? tDetail(`perms.${known}`) : field
    }

    const reason: InstallLabels["reason"] = (item, options = {}) => {
      const p = (name: string) => item.params[name] ?? ""
      const or = (name: string) => p(name) || "?"
      switch (item.code) {
        case "not_an_mcp_server":
          return rich("reasons.not_an_mcp_server", {
            kind: tKind(knownKind(p("kind")) ?? "unknown"),
          })
        case "item_unavailable": {
          const state = p("status")
          return rich(
            state === "retired"
              ? "reasons.item_unavailable_retired"
              : state === "removed"
                ? "reasons.item_unavailable_removed"
                : "reasons.item_unavailable"
          )
        }
        case "revision_unavailable":
          return rich("reasons.revision_unavailable", {
            revision: or("revision"),
          })
        case "snapshot_incomplete": {
          const field = oneOf(SNAPSHOT_FIELDS, p("field"))
          return rich("reasons.snapshot_incomplete", {
            field: t(`snapshotField.${field ?? "other"}`),
          })
        }
        case "registry_unsupported":
          return rich("reasons.registry_unsupported", {
            registry: or("registry_type"),
          })
        case "runtime_unsupported":
          return rich("reasons.runtime_unsupported", {
            registry: or("registry_type"),
            runtime: or("runtime"),
          })
        case "identifier_has_version":
        case "package_not_pinned":
        case "install_script":
          return rich(`reasons.${item.code}`, {
            identifier: or("identifier"),
          })
        case "runtime_arguments_unsupported":
          return rich("reasons.runtime_arguments_unsupported", {
            identifier: or("identifier"),
            argument: or("argument"),
          })
        case "runner_environment_unsupported":
        case "secret_in_query":
        case "secret_not_sent":
          return rich(`reasons.${item.code}`, { name: or("name") })
        case "package_version_inexact":
          return p("version")
            ? rich("reasons.package_version_inexact", {
                identifier: or("identifier"),
                version: p("version"),
              })
            : rich("reasons.package_version_inexact_none", {
                identifier: or("identifier"),
              })
        case "package_missing":
        case "package_verification_unknown":
          return rich(`reasons.${item.code}`, {
            identifier: or("identifier"),
            version: or("version"),
          })
        case "version_unverified":
          return rich("reasons.version_unverified", {
            identifier: or("identifier"),
            version: or("version"),
            check: check(p("verified") || null),
          })
        case "remote_not_public":
          return p("host")
            ? rich("reasons.remote_not_public_host", { host: p("host") })
            : rich("reasons.remote_not_public")
        case "key_invalid":
        case "key_reserved":
        case "installed_under_other_key":
          return rich(`reasons.${item.code}`, { key: or("key") })
        case "replace_not_target":
        case "basis_required":
          return rich(`reasons.${item.code}`, { agent: agent(or("agent")) })
        case "option_not_found":
          return rich("reasons.option_not_found", { option: or("option") })
        case "parameter_required": {
          const key = or("key")
          return rich("reasons.parameter_required", {
            name: options.parameterName?.(key) ?? key,
          })
        }
        case "replace_required":
          return rich("reasons.replace_required", {
            agent: agent(or("agent")),
            key: or("key"),
          })
        case "not_installed":
          return rich("reasons.not_installed")
      }
      const known = oneOf(INSTALL_REASON_CODES, item.code)
      return known
        ? rich(`reasons.${known}`)
        : rich("reasons.unknown", { name: item.code })
    }

    const change: InstallLabels["change"] = (item) => {
      const p = (name: string) => item.params[name] ?? ""
      switch (item.code) {
        case "status_changed":
          return rich("changes.status_changed", {
            from: status(p("from")),
            to: status(p("to")),
          })
        case "risk_changed":
          return rich("changes.risk_changed", {
            from: risk(p("from") || null),
            to: risk(p("to") || null),
          })
        case "reviewed_changed":
          return rich(
            p("to") === "true"
              ? "changes.reviewed_now"
              : "changes.reviewed_no_longer"
          )
        case "permission_added":
        case "permission_removed":
          return rich(
            `changes.${item.code}_${p("profile") === "declared" ? "declared" : "detected"}`,
            { field: permission(p("field")), value: p("value") || "?" }
          )
        case "findings_changed":
          return rich("changes.findings_changed", {
            severity: t(
              `severity.${oneOf(SEVERITIES, p("severity")) ?? "unknown"}`
            ),
            from: p("from") || "0",
            to: p("to") || "0",
          })
        case "secrets_found_changed":
          return rich("changes.secrets_found_changed", {
            from: p("from") || "0",
            to: p("to") || "0",
          })
        case "review_changed":
          return rich("changes.review_changed", {
            from: review(p("from")),
            to: review(p("to")),
          })
        case "package_added":
        case "package_removed":
        case "install_script_added":
        case "install_script_removed":
          return rich(`changes.${item.code}`, {
            identifier: p("identifier") || "?",
          })
        case "package_version_changed":
          return rich("changes.package_version_changed", {
            identifier: p("identifier") || "?",
            from: p("from") || "—",
            to: p("to") || "—",
          })
        case "verification_changed":
          return rich("changes.verification_changed", {
            identifier: p("identifier") || "?",
            from: check(p("from") || null),
            to: check(p("to") || null),
          })
        case "state_changed":
          return rich("changes.state_changed")
      }
      return rich("changes.unknown", { name: item.code })
    }

    return {
      reason,
      change,
      status,
      risk,
      check,
      uninstallAction: (action) =>
        t(`uninstall.actions.${oneOf(UNINSTALL_ACTIONS, action) ?? "unknown"}`),
      record: (value) =>
        t(`record.${(value && oneOf(RECORD_CODES, value)) || "unknown"}`),
      agent,
    }
  }, [t, tDetail, tKind])
}
