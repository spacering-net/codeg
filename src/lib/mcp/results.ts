/**
 * What an `mcp_apply` answer comes to, for the reader.
 *
 * Each agent has its own result — written, unchanged, or why not — and the
 * page shows every one of them. "Saved" is said only for a write that went
 * through in full: `ok` and the outcome `applied`. Anything else, including a
 * save where only some agents could be written and the rest were put back,
 * is told as what it was.
 */
import type { McpAgentResult, McpApplyResult } from "./types"

export function isSaved(result: McpApplyResult): boolean {
  return result.ok && result.outcome === "applied"
}

/** The sentence a result opens with. */
export type McpResultHeadline =
  /** A preflight: everything would be written. */
  | "ready"
  /** A preflight: at least one agent cannot be. */
  | "blocked"
  | "saved"
  | "changedElsewhere"
  | "busy"
  | "invalid"
  | "writeFailed"
  /** An outcome this build does not know. Never read as success. */
  | "unknown"

export function headlineOf(result: McpApplyResult): McpResultHeadline {
  switch (result.outcome) {
    case "preflight":
      return result.ok ? "ready" : "blocked"
    case "applied":
      return result.ok ? "saved" : "unknown"
    case "changed_elsewhere":
      return "changedElsewhere"
    case "busy":
      return "busy"
    case "invalid":
      return "invalid"
    case "write_failed":
      return "writeFailed"
    default:
      return "unknown"
  }
}

/** Statuses that mean the agent's file was changed by this call — whether or
 *  not the change was meant to stay. */
const CHANGED_FILE = new Set(["written", "restore_skipped", "restore_failed"])

/** Whether this call left some agent's file changed, so the inventory is out
 *  of date. */
export function changedFiles(result: McpApplyResult): boolean {
  return result.agents.some((agent) => CHANGED_FILE.has(agent.status))
}

/** Statuses that are this agent's part going well. */
const FINE = new Set(["ready", "unchanged", "written"])

export function isAgentFine(agent: McpAgentResult): boolean {
  return FINE.has(agent.status)
}

/** An agent whose file another program changed between Codeg's write and the
 *  undo: left as that program made it, with the copy from before the save. */
export function restoreSkipped(result: McpApplyResult): McpAgentResult[] {
  return result.agents.filter((agent) => agent.status === "restore_skipped")
}
