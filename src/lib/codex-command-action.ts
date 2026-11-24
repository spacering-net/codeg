/**
 * codex-acp "command action" tool calls.
 *
 * When codex classifies a shell command as a known action (read / search /
 * list-files), codex-acp announces it as an ACP `tool_call` carrying ONLY a
 * human title — no `rawInput` at all (`createCommandActionEvent`) — and later
 * completes it with `rawOutput: { formatted_output, exit_code }`. The query and
 * the path therefore exist nowhere but the title, so both the tool-name
 * classifier and the live input synthesis have to read them back out of it.
 *
 * The title shapes are codex-acp's `createSearchTitle` / list-files literals.
 * Note the asymmetric quoting — the search path is NOT quoted, every other
 * interpolation is:
 *
 *   Search for '<query>' in <path>
 *   Search for '<query>'
 *   Search in '<path>'
 *   Search
 *   List files in '<path>'
 *   List files
 *   Read file '<path>'            ← resolved elsewhere (`^read` freeform rule)
 */

export interface CodexSearchAction {
  /** Search pattern, or null when codex could not extract one from the command. */
  query: string | null
  /** Directory / file the search was scoped to, or null for a whole-tree search. */
  path: string | null
}

export interface CodexListFilesAction {
  path: string | null
}

const SEARCH_FOR_PREFIX = "Search for '"
/**
 * Separator between a quoted query and the UNQUOTED path. Matched from the
 * right: a path never contains `' in `, but a query may.
 */
const QUERY_PATH_SEPARATOR = "' in "
const SEARCH_IN_RE = /^Search in '([\s\S]*)'$/
const LIST_FILES_IN_RE = /^List files in '([\s\S]*)'$/

/**
 * Parse a codex-acp search title into its query / path, or null when the title
 * isn't one. `{ query: null, path: null }` (bare "Search") is a successful
 * parse — the caller distinguishes it from "not a search title" by the null.
 */
export function parseCodexSearchTitle(
  title: string | null | undefined
): CodexSearchAction | null {
  const trimmed = title?.trim()
  if (!trimmed) return null
  if (trimmed === "Search") return { query: null, path: null }

  if (trimmed.startsWith(SEARCH_FOR_PREFIX)) {
    const rest = trimmed.slice(SEARCH_FOR_PREFIX.length)
    const separator = rest.lastIndexOf(QUERY_PATH_SEPARATOR)
    if (separator > 0) {
      const query = rest.slice(0, separator)
      const path = rest.slice(separator + QUERY_PATH_SEPARATOR.length).trim()
      if (path.length > 0) return { query, path }
    }
    if (rest.endsWith("'")) {
      const query = rest.slice(0, -1)
      if (query.length > 0) return { query, path: null }
    }
    return null
  }

  const pathOnly = trimmed.match(SEARCH_IN_RE)
  if (pathOnly && pathOnly[1].length > 0) {
    return { query: null, path: pathOnly[1] }
  }
  return null
}

/** Parse a codex-acp list-files title into its path, or null when it isn't one. */
export function parseCodexListFilesTitle(
  title: string | null | undefined
): CodexListFilesAction | null {
  const trimmed = title?.trim()
  if (!trimmed) return null
  if (trimmed === "List files") return { path: null }

  const match = trimmed.match(LIST_FILES_IN_RE)
  if (match && match[1].length > 0) return { path: match[1] }
  return null
}

/**
 * `_meta` key the backend stamps on codex's `search` command actions
 * (`stamp_codex_search_action` in `acp/connection.rs`). It is the only way the
 * frontend can tell a codex search from another agent's grep once codeg
 * advertises `_meta.terminal_output_delta`: a search that printed nothing then
 * completes as a bare `failed`, with no envelope and so no exit code.
 */
export const CODEX_SEARCH_ACTION_META_KEY = "codeg.codexSearchAction"

export interface CodexCommandEnvelope {
  output: string
  exitCode: number
}

/**
 * Unwrap codex-acp's command-execution result envelope
 * (`createCommandExecutionCompleteUpdate`), which always sends BOTH
 * `formatted_output` and `exit_code`. Requiring both keys keeps a genuine
 * JSON payload (`{ output: … }`, `{ stdout: … }`, a lone `{ exit_code: 0 }`, …)
 * from being mistaken for the envelope. Returns null for anything else.
 */
export function parseCodexCommandEnvelope(
  raw: string
): CodexCommandEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  if (
    typeof obj.exit_code !== "number" ||
    typeof obj.formatted_output !== "string"
  ) {
    return null
  }
  return { output: obj.formatted_output, exitCode: obj.exit_code }
}

/**
 * True for the one command envelope that means "the search ran fine and matched
 * nothing": codex derives an ACP tool status from the process exit code, and
 * rg/grep exit 1 when no line was selected, so a healthy negative search arrives
 * as a FAILED tool call carrying `{exit_code: 1, formatted_output: ""}`.
 *
 * Callers MUST first establish that the tool is a grep-like search
 * (`normalizeToolName(...) === "grep"`): exit 1 only means "nothing selected"
 * for grep-likes — for the list-files commands that classify as `glob`
 * (ls/find/…) it is a genuine failure, and a successful empty listing already
 * arrives with exit 0. The tool-name gate lives at the call sites because
 * `tool-call-normalization` imports this module, not the other way round.
 *
 * Whitespace-only output counts as empty, matching `<SearchResultsOutput>`,
 * which renders any blank body as "No matches" — a shell that echoes a bare
 * newline must not flip the same result between the neutral and the error
 * rendering. A real failure (exit ≥ 2, or any diagnostic text) is untouched.
 */
export function isCodexGrepNoMatchEnvelope(raw: string): boolean {
  const envelope = parseCodexCommandEnvelope(raw)
  return envelope?.exitCode === 1 && envelope.output.trim().length === 0
}
