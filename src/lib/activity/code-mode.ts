/**
 * Code-mode scripts: tool calls an agent makes by running a script that calls
 * its tools, rendered as one "Script" row.
 *
 * Two shapes reach the row:
 * - codex's synthetic `codex_script` card (`{source, title, call_count}`, see
 *   `src/lib/codex-code-mode.ts`), for a script its history parser could not
 *   decompose;
 * - OpenCode 2's `execute` tool (`{code}`), which runs every MCP tool by
 *   default (packages/core/src/codemode/tool.ts, 2.2.0). Its name normalizes to
 *   `bash` live and in history alike, so the input shape is what tells it from
 *   a command — the same rule the code-mode delegation check uses.
 *
 * The calls a script made ride the call's `_meta` under
 * {@link CODE_MODE_CALLS_META_KEY}, agent-neutral: whoever writes them (the
 * live backend from OpenCode's `rawOutput.metadata.toolCalls`, a history parser
 * from the stored call) writes this shape.
 */

import { parseCodexScriptCard } from "@/lib/codex-code-mode"
import { tryParseJson } from "./json"

/**
 * `_meta` key carrying the calls a code-mode script made, an array of
 * {@link CodeModeCall}. Backend twin: `CODE_MODE_CALLS_META_KEY` in
 * `src-tauri/src/acp/connection.rs`.
 */
export const CODE_MODE_CALLS_META_KEY = "codeg.codeModeCalls"

/** One call a code-mode script made, as OpenCode reports it. */
export interface CodeModeCall {
  /** The catalog path the script called: `probe.echo`, `codeg-mcp.ask_user_question`. */
  tool: string
  status: "running" | "completed" | "error"
  /** The call's arguments as the agent shows them; null when not reported. */
  input: Record<string, unknown> | null
}

/** A script row's source, whichever agent ran it. */
export interface ScriptCard {
  /** The script, as the agent ran it. */
  source: string
  /** Best-effort one-line title; null when nothing reads as one. */
  title: string | null
  /** `tools.*` call sites the agent counted; 0 when it did not count. */
  callCount: number
}

/**
 * The script of an OpenCode code-mode `execute` call: its input is `{code}`
 * and carries nothing a command does, so a command card would show an empty
 * command line. Null for any other input.
 */
export function codeModeScriptSource(
  input: string | null | undefined
): string | null {
  if (!input || !input.includes('"code"')) return null
  const parsed = tryParseJson(input)
  if (!parsed) return null
  const code = parsed.code
  if (typeof code !== "string" || !code.trim()) return null
  for (const key of ["command", "cmd", "script", "args", "argv"]) {
    if (key in parsed) return null
  }
  return code
}

/**
 * Whether a call that normalized to `bash` is really a code-mode script.
 * `execute` normalizes to `bash`, so the input shape decides.
 */
export function isCodeModeScriptCall(
  normalizedToolName: string,
  input: string | null | undefined
): boolean {
  return normalizedToolName === "bash" && codeModeScriptSource(input) !== null
}

const CALL_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "completed",
  "error",
])

/** The calls recorded on a call's `_meta` (see {@link CODE_MODE_CALLS_META_KEY}). */
export function codeModeCalls(meta: unknown): CodeModeCall[] {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return []
  const list = (meta as Record<string, unknown>)[CODE_MODE_CALLS_META_KEY]
  if (!Array.isArray(list)) return []
  const calls: CodeModeCall[] = []
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const tool = typeof record.tool === "string" ? record.tool.trim() : ""
    if (!tool) continue
    const status =
      typeof record.status === "string" && CALL_STATUSES.has(record.status)
        ? (record.status as CodeModeCall["status"])
        : "running"
    const input =
      record.input &&
      typeof record.input === "object" &&
      !Array.isArray(record.input)
        ? (record.input as Record<string, unknown>)
        : null
    calls.push({ tool, status, input })
  }
  return calls
}

/** The first line of a script that says something. */
function firstCodeLine(source: string): string | null {
  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith("//")) return trimmed
  }
  return null
}

/**
 * A script row's card: codex's synthetic card, or an OpenCode `execute`
 * call's script. The title names the tools the script called when they are
 * known — what the user wants from a row that only runs other tools — and
 * otherwise its first line.
 */
export function parseScriptCard(
  input: string | null | undefined,
  meta: unknown
): ScriptCard | null {
  const codex = parseCodexScriptCard(input)
  if (codex) return codex
  const source = codeModeScriptSource(input)
  if (source === null) return null
  const calls = codeModeCalls(meta)
  const tools = [...new Set(calls.map((call) => call.tool))]
  return {
    source,
    title: tools.length > 0 ? tools.join(", ") : firstCodeLine(source),
    callCount: calls.length,
  }
}
