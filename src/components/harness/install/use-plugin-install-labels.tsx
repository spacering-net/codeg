"use client"

import { useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import { knownKind, oneOf } from "@/lib/harness/display"
import type { HarnessReason } from "@/lib/harness/mcp-install-types"
import { PLUGIN_MODES } from "@/lib/harness/plugin-install"
import { Code } from "../discover/detail-sections"
import {
  SKILLS_ISSUE_CODES,
  useSkillsLabels,
} from "../skills/use-skills-labels"
import { useSkillInstallLabels } from "./use-skill-install-labels"

/**
 * Every code a plugin install can come back with that the skill and MCP
 * install steps' labels do not word — the plugin step's own
 * (`harness/plugins/model.rs`), its hosts' adapters' (`hosts::codes`), and
 * the plugin-owned skills' (`skills::owned`) — for the test that checks none
 * is left unworded, in any language.
 */
export const PLUGIN_INSTALL_REASON_CODES = [
  // The plugin step.
  "not_a_plugin",
  "plugin_info_missing",
  "plugin_install_name_invalid",
  "plugin_install_name_mismatch",
  "plugin_install_name_taken",
  "plugin_already_installed",
  "plugin_no_hosts",
  "plugin_no_adapter",
  "plugin_native_unavailable",
  "plugin_revision_not_target",
  "plugin_no_full",
  "plugin_not_approved",
  "plugin_mcp_unpinned",
  "plugin_consent_required",
  "plugin_consent_stale",
  "plugin_host_step_failed",
  "plugin_needs_repair",
  "plugin_up_to_date",
  "plugin_record_changed",
  "plugin_not_on_agent",
  "plugin_last_host",
  "plugin_unchanged",
  "plugin_suspended",
  "plugin_no_repair_needed",
  "plugin_reinstall_required",
  "plugin_revision_modified",
  "plugin_unverified",
  "plugin_advisory_disable",
  "plugin_launch_env_unreadable",
  // The hosts' adapters.
  "plugin_host_not_found",
  "plugin_host_version_unknown",
  "plugin_host_home_relative",
  "plugin_adapter_off",
  "plugin_host_version_unsupported",
  "plugin_host_command_failed",
  "plugin_host_command_timed_out",
  "plugin_host_command_not_started",
  "plugin_marketplace_unreadable",
  "plugin_host_name_taken",
  "plugin_host_name_changed",
  "plugin_revision_missing",
  "plugin_host_files",
  "plugin_host_not_listed",
  "plugin_entry_missing",
  "plugin_host_settings_unreadable",
  "plugin_host_not_installed",
  "plugin_marketplace_not_added",
  "plugin_marketplace_elsewhere",
  "plugin_marketplace_entry_missing",
  "plugin_marketplace_source_mismatch",
  "plugin_host_entry_mismatch",
  "plugin_host_cache_missing",
  "plugin_hooks_unreadable",
  // The plugin's own skills.
  "experts_linked",
  "owned_set_differs",
  "owned_by_other",
  "copies_not_refreshed",
  "member_duplicate",
  "member_file_mismatch",
  "plugin_owned",
] as const

/** The hosts' names, as the website shows them (`PluginHost.host`). Product
 *  names: the same in every language. */
const HOST_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  pi: "Pi",
  kimi: "Kimi Code",
  antigravity: "Antigravity",
  devin: "Devin",
  hermes: "Hermes",
  muse: "Muse",
  "agent-plugins": "Agent Plugins",
}

export const AUTORUN_TYPES = [
  "hook",
  "code",
  "mcp",
  "lsp",
  "monitor",
  "bin",
] as const

export const PLUGIN_HOST_STEP_STATUSES = [
  "done",
  "failed",
  "undone",
  "needs_repair",
] as const

const REVISION_MODES = ["native", "skills"] as const

export interface PluginInstallLabels {
  reason: (reason: HarnessReason) => ReactNode
  /** A host by the website's id; one this build does not know, as itself. */
  host: (id: string) => string
  mode: (mode: string) => string
  autorunType: (type: string) => string
  stepStatus: (status: string) => string
  agent: (id: string) => string
  agents: (ids: readonly string[]) => string
}

/** The words for a plugin install's codes, modes and parts. Every code has
 *  an answer; a code neither this step nor the skill and MCP steps know is
 *  shown as itself, in a sentence that says so. */
export function usePluginInstallLabels(): PluginInstallLabels {
  const t = useTranslations("Harness.pluginInstall")
  const tKind = useTranslations("Harness.discover.kind")
  const skill = useSkillInstallLabels()
  const skills = useSkillsLabels()
  return useMemo(() => {
    const code = (chunks: ReactNode) => <Code>{chunks}</Code>
    const rich = (key: string, values: Record<string, string> = {}) =>
      t.rich(key as never, { ...values, code } as never)
    const agent = skill.agent
    const agents = skill.agents
    const agentList = (value: string) =>
      agents(value.split(",").filter(Boolean)) || "?"
    const host = (id: string) => HOST_NAMES[id] ?? id

    const reason: PluginInstallLabels["reason"] = (item) => {
      const p = (name: string) => item.params[name] ?? ""
      const or = (name: string) => p(name) || "?"
      switch (item.code) {
        case "not_a_plugin":
          return rich("reasons.not_a_plugin", {
            kind: tKind(knownKind(p("kind")) ?? "unknown"),
          })
        case "plugin_install_name_invalid":
        case "plugin_already_installed":
        case "plugin_host_not_installed":
        case "copies_not_refreshed":
        case "member_duplicate":
        case "plugin_owned":
          return rich(`reasons.${item.code}`, { name: or("name") })
        case "plugin_install_name_mismatch":
          return rich("reasons.plugin_install_name_mismatch", {
            name: or("name"),
            expected: or("expected"),
          })
        case "plugin_install_name_taken":
          return rich("reasons.plugin_install_name_taken", {
            name: or("name"),
            ref: or("ref"),
          })
        case "plugin_no_adapter":
        case "plugin_not_on_agent":
        case "plugin_last_host":
        case "plugin_unchanged":
        case "plugin_no_repair_needed":
        case "plugin_reinstall_required":
        case "plugin_launch_env_unreadable":
          return rich(`reasons.${item.code}`, { agent: agent(or("agent")) })
        case "plugin_native_unavailable": {
          const head = rich("reasons.plugin_native_unavailable", {
            agent: agent(or("agent")),
          })
          const why = p("why")
          return why ? (
            <>
              {head} {reason({ code: why, params: {}, detail: null })}
            </>
          ) : (
            head
          )
        }
        case "plugin_revision_not_target": {
          const mode = oneOf(REVISION_MODES, p("mode")) ?? "skills"
          return p("expected")
            ? rich(`reasons.plugin_revision_not_target_${mode}`, {
                revision: or("revision"),
                expected: p("expected"),
              })
            : rich("reasons.plugin_revision_not_target", {
                revision: or("revision"),
              })
        }
        case "plugin_no_full":
          return rich(
            p("reason") === "mcp_unpinned"
              ? "reasons.plugin_no_full_unpinned"
              : "reasons.plugin_no_full"
          )
        case "plugin_not_approved":
        case "plugin_revision_missing":
        case "plugin_revision_modified":
          return rich(`reasons.${item.code}`, { revision: or("revision") })
        case "plugin_up_to_date":
          return rich("reasons.plugin_up_to_date", {
            revision: or("revision"),
          })
        case "plugin_mcp_unpinned":
          return rich("reasons.plugin_mcp_unpinned", {
            servers: or("servers"),
          })
        case "plugin_host_step_failed":
          return rich("reasons.plugin_host_step_failed", {
            agent: agent(or("agent")),
            step: or("step"),
          })
        case "plugin_needs_repair":
          return rich("reasons.plugin_needs_repair", {
            agents: agentList(p("agents")),
          })
        case "plugin_suspended":
          return rich("reasons.plugin_suspended", {
            agent: agent(or("agent")),
          })
        case "plugin_host_home_relative":
          return rich("reasons.plugin_host_home_relative", {
            variable: or("variable"),
            path: or("path"),
          })
        case "plugin_host_version_unsupported":
          return rich("reasons.plugin_host_version_unsupported", {
            version: or("version"),
          })
        case "plugin_host_command_failed":
          return rich("reasons.plugin_host_command_failed", {
            command: or("command"),
            status: or("status"),
          })
        case "plugin_host_command_timed_out":
          return rich("reasons.plugin_host_command_timed_out", {
            command: or("command"),
            seconds: or("seconds"),
          })
        case "plugin_host_command_not_started":
          return rich("reasons.plugin_host_command_not_started", {
            command: or("command"),
          })
        case "plugin_host_name_taken":
          return rich("reasons.plugin_host_name_taken", {
            name: or("name"),
            plugin: or("plugin"),
          })
        case "plugin_host_name_changed":
          return rich("reasons.plugin_host_name_changed", {
            from: or("from"),
            to: or("to"),
          })
        case "plugin_marketplace_elsewhere":
          return p("path")
            ? rich("reasons.plugin_marketplace_elsewhere", { path: p("path") })
            : rich("reasons.plugin_marketplace_elsewhere_unknown")
        case "plugin_marketplace_source_mismatch":
        case "plugin_host_entry_mismatch":
          return rich(`reasons.${item.code}`, {
            expected: or("expected"),
            found: or("found"),
          })
        case "plugin_host_cache_missing":
          return rich("reasons.plugin_host_cache_missing")
        case "experts_linked":
          return rich("reasons.experts_linked", { names: or("names") })
        case "owned_by_other":
          return rich("reasons.owned_by_other", {
            name: or("name"),
            plugin: or("plugin"),
          })
        case "member_file_mismatch":
          return rich("reasons.member_file_mismatch", {
            name: or("name"),
            path: or("path"),
          })
      }
      if (oneOf(PLUGIN_INSTALL_REASON_CODES, item.code)) {
        return rich(`reasons.${item.code}`)
      }
      // The skills engine's own, as a member's link reports it.
      if (oneOf(SKILLS_ISSUE_CODES, item.code)) {
        return skills.issue({
          code: item.code,
          path: item.params.path,
          agents: (item.params.agents ?? "").split(",").filter(Boolean),
        })
      }
      // The skill and MCP steps' — and, failing those, said to be unknown.
      return skill.reason(item)
    }

    return {
      reason,
      host,
      mode: (mode) =>
        t(`modes.${oneOf(PLUGIN_MODES, mode) ?? "unknown"}` as never),
      autorunType: (type) =>
        t(`autorun.types.${oneOf(AUTORUN_TYPES, type) ?? "unknown"}` as never),
      stepStatus: (status) =>
        t(
          `outcome.status.${oneOf(PLUGIN_HOST_STEP_STATUSES, status) ?? "unknown"}` as never
        ),
      agent,
      agents,
    }
  }, [t, tKind, skill, skills])
}
