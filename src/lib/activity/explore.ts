/**
 * Read and search results, reduced to what an activity row reports about them:
 * the file text a read returned (and how many lines it was), and how many hits
 * a search found.
 */

import {
  isCodexGrepNoMatchEnvelope,
  parseCodexCommandEnvelope,
} from "@/lib/codex-command-action"
import { parseSearchOutput } from "@/lib/search-output"
import { CLI_META_LINE_RE, parseCliExecutionEnvelope } from "./command"
import { countLines } from "./format"

/**
 * codex classifies file-reading shell commands (sed/cat/head) as ACP `read`
 * commandActions whose output is a command-execution envelope — codex-acp's
 * `createCommandExecutionCompleteUpdate` always sends BOTH
 * `{ formatted_output: <string>, exit_code: <number> }` — NOT the
 * `{ start_line, content }` read shape. Return the inner `formatted_output` so the
 * file content renders. Requiring BOTH keys keeps a genuine JSON-file read
 * (`{ output: … }`, `{ stdout: … }`, a lone `{ exit_code: 0 }`, …) from being
 * mistaken for a command envelope. Returns null when it isn't that exact shape.
 *
 * Read-only on purpose: the sibling `search` body unwraps the envelope WITHOUT
 * the CLI-framing strip below, because a search's matched line can legitimately
 * begin with one of those metadata words (see the `searchOutput` memo).
 */
export function codexCommandReadOutput(raw: string): string | null {
  const envelope = parseCodexCommandEnvelope(raw)
  if (!envelope) return null
  const out = envelope.output
  // Strip codex's CLI framing ("Chunk ID:/Wall time:/…/Output:\n<content>") only
  // when the output actually STARTS with that metadata — so a clean file whose
  // first line happens to be "Output:" is never truncated by the envelope parser.
  const firstLine = (
    out.split("\n").find((l) => l.trim().length > 0) ?? ""
  ).trim()
  return CLI_META_LINE_RE.test(firstLine)
    ? parseCliExecutionEnvelope(out).output
    : out
}

/**
 * Parse structured read output from backend: `{"start_line":N,"content":"..."}`.
 * Falls back to raw text with startLine=1 if not structured.
 */
export function parseReadOutput(raw: string): {
  startLine: number
  content: string
} {
  try {
    const parsed = JSON.parse(raw)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.start_line === "number" &&
      typeof parsed.content === "string"
    ) {
      return { startLine: parsed.start_line, content: parsed.content }
    }
  } catch {
    // not JSON
  }
  const cmdOut = codexCommandReadOutput(raw)
  if (cmdOut !== null) return { startLine: 1, content: cmdOut }
  return { startLine: 1, content: raw }
}

/** How many lines a successful read returned, or null when nothing came back. */
export function readLineCount(
  output: string | null | undefined
): number | null {
  if (!output) return null
  const { content } = parseReadOutput(output)
  const lines = countLines(content)
  return lines > 0 ? lines : null
}

/**
 * The text a search printed, with codex's command envelope unwrapped and
 * nothing else touched: a search prints the files' own lines, which can read
 * like CLI framing (`Wall time:`, `Output:`) or be the code fences it was
 * looking for, so the command-output cleanup would delete real matches. `""`
 * is a real result (no matches); null means there is no result to read yet.
 */
export function searchResultText(
  toolName: string,
  output: string | null | undefined,
  errorText: string | null | undefined
): string | null {
  if (typeof errorText === "string") {
    if (toolName !== "grep") return null
    return isCodexGrepNoMatchEnvelope(errorText) ? "" : null
  }
  if (typeof output !== "string") return null
  return parseCodexCommandEnvelope(output)?.output ?? output
}

export type SearchOutcome =
  | { kind: "none" }
  | { kind: "matches"; matches: number; files: number }
  | { kind: "files"; files: number }
  | { kind: "lines"; lines: number }

/**
 * What a search found, in the unit its output is in: matched lines (grep with
 * line numbers), file paths (glob, `rg --files`, `ls`), or — when the output is
 * in neither shape — plain result lines.
 */
export function summarizeSearchResult(
  text: string | null
): SearchOutcome | null {
  if (text === null) return null
  // Claude Code's Grep/Glob say "No files found" / "No matches found" for an
  // empty result, and open a files-with-matches listing with "Found N files".
  const body = text.trim().replace(FOUND_PREAMBLE_RE, "").trim()
  if (!body || NO_RESULTS_RE.test(body)) return { kind: "none" }
  const parsed = parseSearchOutput(body, { maxRows: Number.MAX_SAFE_INTEGER })
  if (parsed?.mode === "matches") {
    return {
      kind: "matches",
      matches: parsed.matchCount,
      files: parsed.fileCount,
    }
  }
  if (parsed?.mode === "files")
    return { kind: "files", files: parsed.fileCount }
  const lines = countLines(body)
  return lines > 0 ? { kind: "lines", lines } : { kind: "none" }
}

const FOUND_PREAMBLE_RE = /^Found \d+ (?:files?|matches?|results?)\b[^\n]*\n?/i
const NO_RESULTS_RE = /^No (?:files|matches|results) found\.?$/i
