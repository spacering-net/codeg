/**
 * Third-party MCP tool calls: who served them and what they were about.
 *
 * Hosts spell an MCP tool's identity differently — Claude Code, Kiro, Qoder and
 * codex's rollout write `mcp__<server>__<tool>`, codex's live stream
 * `<server>/<tool>`, others `<server>.<tool>` or `<server>:<tool>`. The server
 * half is what the row's source chip shows; the tool half is the row's name.
 * codeg's own companion tools never get here: they are resolved to their
 * canonical names (and dedicated rows) before this is consulted.
 */

import { peelMcpResultEnvelope } from "@/lib/mcp-result-envelope"
import { ellipsis } from "./format"
import { tryParseJson } from "./json"

export interface McpIdentity {
  server: string
  tool: string
}

/** Prefixes that look like `<server>.<tool>` but are not MCP servers. */
const NON_MCP_PREFIXES = new Set(["functions", "multi_tool_use", "tools"])

const DOUBLE_UNDERSCORE_RE = /^mcp__(.+?)__(.+)$/i
const SEPARATED_RE = /^([A-Za-z0-9][\w-]*)[/.:]([A-Za-z0-9][\w.-]*)$/

export function parseMcpToolName(rawName: string): McpIdentity | null {
  const name = rawName.trim()
  const prefixed = name.match(DOUBLE_UNDERSCORE_RE)
  if (prefixed) {
    const server = prefixed[1]!
    const tool = prefixed[2]!
    if (!server || !tool) return null
    return { server, tool }
  }
  const separated = name.match(SEPARATED_RE)
  if (separated) {
    const server = separated[1]!
    const tool = separated[2]!
    if (NON_MCP_PREFIXES.has(server.toLowerCase())) return null
    return { server, tool }
  }
  return null
}

const MAX_ARG_PREVIEW = 60
const MAX_RESULT_PREVIEW = 80
/** Result fields that name what came back, in order of preference. */
const RESULT_LABEL_KEYS = ["title", "name", "summary", "message"]

/** The first argument worth naming the call by: `{id: "HVAC-212"}` → "HVAC-212". */
export function mcpArgumentPreview(input: string | null): string | null {
  if (!input) return null
  const parsed = tryParseJson(input)
  if (!parsed) {
    const text = input.trim()
    return text && !text.startsWith("{")
      ? ellipsis(text, MAX_ARG_PREVIEW)
      : null
  }
  for (const value of Object.values(parsed)) {
    if (typeof value === "string") {
      const text = value.replace(/\s+/g, " ").trim()
      if (text) return ellipsis(text, MAX_ARG_PREVIEW)
    } else if (typeof value === "number" && Number.isFinite(value)) {
      return String(value)
    }
  }
  return null
}

export interface McpResultPayload {
  /** The structured result (an object or array) when there is one. */
  json: unknown
  /** The result as text, when it is not structured. */
  text: string | null
  /** The server marked the result as an error (`CallToolResult.isError`). */
  isError: boolean
}

function isCallToolResult(value: Record<string, unknown>): boolean {
  const structured = value.structuredContent
  return (
    Array.isArray(value.content) ||
    (typeof structured === "object" &&
      structured !== null &&
      !Array.isArray(structured))
  )
}

function textOfContent(content: unknown[]): string | null {
  const texts = content.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const block = item as Record<string, unknown>
    return block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : []
  })
  return texts.length > 0 ? texts.join("\n") : null
}

function parseJsonValue(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * The payload an MCP result carries, with the host and protocol layers taken
 * off: codex's `{result, error}` / `{Ok}` envelopes, then the `CallToolResult`
 * itself — its `structuredContent` when present (that is what the model saw),
 * else its text blocks, parsed as JSON when they are JSON.
 */
export function mcpResultPayload(
  output: string | null
): McpResultPayload | null {
  if (output == null) return null
  const parsed = parseJsonValue(output)
  if (parsed === undefined) {
    return output.trim() ? { json: null, text: output, isError: false } : null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (Array.isArray(parsed)) {
      const text = textOfContent(parsed)
      if (text !== null) {
        const inner = parseJsonValue(text)
        return inner !== undefined
          ? { json: inner, text: null, isError: false }
          : { json: null, text, isError: false }
      }
    }
    return { json: parsed, text: null, isError: false }
  }
  const { obj, hostError } = peelMcpResultEnvelope(
    parsed as Record<string, unknown>,
    isCallToolResult
  )
  if (hostError) return { json: null, text: hostError, isError: true }
  if (!isCallToolResult(obj)) return { json: obj, text: null, isError: false }
  const isError = obj.isError === true
  const structured = obj.structuredContent
  if (structured && typeof structured === "object") {
    return { json: structured, text: null, isError }
  }
  const text = Array.isArray(obj.content) ? textOfContent(obj.content) : null
  if (text === null) return { json: obj, text: null, isError }
  const inner = parseJsonValue(text)
  return inner !== undefined
    ? { json: inner, text: null, isError }
    : { json: null, text, isError }
}

/** What the result was about: its `title` / `name` / `summary` / `message`. */
export function mcpResultLabel(
  payload: McpResultPayload | null
): string | null {
  const json = payload?.json
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  const record = json as Record<string, unknown>
  for (const key of RESULT_LABEL_KEYS) {
    const value = record[key]
    if (typeof value === "string") {
      const text = value.replace(/\s+/g, " ").trim()
      if (text) return ellipsis(text, MAX_RESULT_PREVIEW)
    }
  }
  return null
}
