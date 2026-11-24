"use client"

import { useMemo, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"

import { getAgentLabel } from "@/lib/custom-agents"
import type { McpAgentBlock } from "@/lib/mcp/model"
import { isMcpAppType, type McpIssue, type McpOpIssue } from "@/lib/mcp/types"
import { Code } from "../discover/detail-sections"

/**
 * Where an issue was reported. The same code can mean different things in
 * different places — `duplicate_key` is about a whole file, one entry, or one
 * op; `entry_not_found` is a failure for a rename and a remark for a removal —
 * and is worded for the place.
 */
export type McpIssueContext =
  | "file"
  | "related"
  | "entry"
  | "snippet"
  | "op"
  | "warning"

/** Every code the engine can report (m1-api §6), with its message key. */
const FILE_CODES = [
  "io_permission_denied",
  "io_error",
  "not_utf8",
  "invalid_json",
  "invalid_toml",
  "invalid_yaml",
  "root_not_object",
  "container_invalid",
  "managed_by_agent",
  "file_not_writable",
  "related_file_unreadable",
] as const

const ENTRY_CODES = [
  "entry_not_an_object",
  "missing_command_or_url",
  "unsupported_type",
  "command_and_url",
  "invalid_command",
  "invalid_url",
  "invalid_args",
  "invalid_env",
  "invalid_headers",
  "invalid_enabled_flag",
  "unsupported_transport",
  "rejected_by_agent",
  "legacy_location",
  "reserved_key",
] as const

const OP_CODES = [
  "agent_read_only",
  "file_read_only",
  "basis_required",
  "basis_mismatch",
  "key_exists",
  "key_structural",
  "entry_not_editable",
  "transport_unsupported",
  "command_required",
  "url_required",
  "env_name_required",
  "header_name_required",
  "disable_unsupported",
  "edit_failed",
  "lock_busy",
  "lock_held",
  "codex_lock_busy",
  "codex_lock_held",
  "codex_repair_needed",
  "backup_failed",
  "write_failed",
  "changed_after_write",
  "restore_failed",
  "outside_mcp_servers",
] as const

const WARNING_CODES = ["yaml_comments_lost", "fields_dropped"] as const
const SNIPPET_CODES = ["snippet_empty", "snippet_unrecognized"] as const

/** Every code with a message of its own, for the test that checks each one
 *  is worded. */
export const MCP_ISSUE_CODES = [
  ...FILE_CODES,
  ...ENTRY_CODES,
  ...OP_CODES,
  ...WARNING_CODES,
  ...SNIPPET_CODES,
  "duplicate_key",
  "entry_not_found",
  "key_invalid",
  "key_reserved",
] as const

const has = (list: readonly string[], code: string) => list.includes(code)

/** `value` as one of `list`'s own strings, when it is one. */
function oneOf<T extends string>(list: readonly T[], value: string): T | null {
  return (list as readonly string[]).includes(value) ? (value as T) : null
}

export const MCP_AGENT_STATUSES = [
  "ready",
  "unchanged",
  "written",
  "invalid",
  "changed_elsewhere",
  "unreadable",
  "read_only",
  "not_written",
  "write_failed",
  "restored",
  "restore_skipped",
  "restore_failed",
] as const

export const MCP_OP_EFFECTS = [
  "created",
  "updated",
  "removed",
  "renamed",
  "enabled",
  "disabled",
  "unchanged",
] as const

const FORMATS = ["json", "jsonc", "toml", "yaml"] as const

export interface McpLabels {
  locale: string
  /** An agent's name as the rest of the app shows it; an agent this build
   *  does not know is shown as the backend spells it. */
  agent: (id: string) => string
  /** `stdio`, `HTTP`, `SSE` — or the word itself for one this build does not
   *  know. */
  transport: (transport: string) => string
  transports: (transports: readonly string[]) => string
  /** An issue in words. `detail` is never the message: the caller shows it,
   *  where it helps, as technical detail. */
  issue: (issue: McpIssue | McpOpIssue, context: McpIssueContext) => ReactNode
  /** Why Codeg will not change an agent's file. */
  block: (block: McpAgentBlock) => ReactNode
  status: (status: string) => string
  effect: (effect: string) => string
  format: (format: string) => string
  /** A list of names, joined with the locale's separator. */
  list: (items: readonly string[]) => string
  date: (iso: string) => string
}

/**
 * The MCP section's vocabulary: the engine's codes, statuses and effects, the
 * agents' names — with an answer for every value, including those a newer
 * backend may send. No code reaches the page as its raw name, and no
 * untranslated `detail` stands in for a message.
 */
export function useMcpLabels(): McpLabels {
  const t = useTranslations("Harness.mcp")
  const locale = useLocale()
  return useMemo(() => {
    const code = (chunks: ReactNode) => <Code>{chunks}</Code>
    const rich = (key: string, values: Record<string, string> = {}) =>
      t.rich(key as never, { ...values, code } as never)
    const transport = (value: string) =>
      value === "stdio" || value === "http" || value === "sse"
        ? t(`transport.${value}`)
        : value
    // A separator rather than "a, b and c": the names are often long, the
    // lists short, and the app's lib does not type `Intl.ListFormat`.
    const separator = t("listSeparator")
    const list = (items: readonly string[]) => items.join(separator)

    const issue = (
      item: McpIssue | McpOpIssue,
      context: McpIssueContext
    ): ReactNode => {
      const field = item.field ?? ""
      const detail = item.detail ?? ""
      const c = item.code
      switch (c) {
        case "duplicate_key":
          if (context === "file" || context === "related") {
            return rich(
              field && context === "related"
                ? "issues.duplicate_key_related"
                : "issues.duplicate_key_file",
              { key: detail || "?", path: field }
            )
          }
          return field
            ? rich("issues.duplicate_key_field", { field })
            : rich("issues.duplicate_key_entry")
        case "entry_not_found":
          return rich(
            context === "warning"
              ? "issues.entry_not_found_warning"
              : "issues.entry_not_found"
          )
        case "key_invalid":
          return rich(
            field === "new_key"
              ? "issues.key_invalid_rename"
              : "issues.key_invalid"
          )
        case "key_reserved":
          return rich("issues.key_reserved")
        case "unsupported_type":
          return rich("issues.unsupported_type", { word: detail || "?" })
        case "invalid_enabled_flag":
          return rich("issues.invalid_enabled_flag", { field: field || "?" })
        case "unsupported_transport":
        case "transport_unsupported":
          return rich(`issues.${c}`, { transport: transport(detail || "?") })
        case "container_invalid":
          return rich("issues.container_invalid", { key: detail || "?" })
        case "related_file_unreadable":
          return rich("issues.related_file_unreadable", { path: field || "?" })
        case "key_exists":
          return rich("issues.key_exists", { name: detail || "?" })
        case "lock_held":
          return rich("issues.lock_held", { path: detail || "?" })
        case "changed_after_write":
        case "restore_failed":
          return rich(`issues.${c}`, { file: field || "?" })
        case "fields_dropped":
          return rich("issues.fields_dropped", { fields: detail || "?" })
      }
      if (
        has(FILE_CODES, c) ||
        has(ENTRY_CODES, c) ||
        has(OP_CODES, c) ||
        has(WARNING_CODES, c) ||
        has(SNIPPET_CODES, c)
      ) {
        return rich(`issues.${c}`)
      }
      // `name`, not `code`: `code` is the tag the code is shown in.
      return rich("issues.unknown", { name: c })
    }

    const block = (value: McpAgentBlock): ReactNode => {
      if (value.kind === "unknownAgent") return t("blocks.unknownAgent")
      if (value.kind === "related") return issue(value.reason, "related")
      if (value.reason) return issue(value.reason, "file")
      // Not writable and no reason given: an agent Codeg only lists, whose
      // file does not exist yet.
      return t("blocks.listedOnly")
    }

    const dateFormat = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    })

    return {
      locale,
      agent: (id: string) => (isMcpAppType(id) ? getAgentLabel(id) : id),
      transport,
      transports: (values: readonly string[]) => list(values.map(transport)),
      issue,
      block,
      status: (status: string) => {
        const known = oneOf(MCP_AGENT_STATUSES, status)
        return known ? t(`status.${known}`) : t("status.unknown", { status })
      },
      effect: (effect: string) => {
        const known = oneOf(MCP_OP_EFFECTS, effect)
        return known ? t(`effect.${known}`) : t("effect.unknown", { effect })
      },
      format: (format: string) => {
        const known = oneOf(FORMATS, format)
        return known ? t(`format.${known}`) : format
      },
      list,
      date: (iso: string) => {
        const date = new Date(iso)
        return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date)
      },
    }
  }, [t, locale])
}
