import {
  parseCodexListFilesTitle,
  parseCodexSearchTitle,
} from "@/lib/codex-command-action"
import { CODEX_SCRIPT_TOOL_NAME } from "@/lib/codex-code-mode"
import { COLLAB_AGENT_TOOL_NAME, isCodexCollabInput } from "@/lib/collab-tool"
import { WAIT_TOOL_NAME, WRITE_STDIN_TOOL_NAME } from "@/lib/shell-session-tool"

const EXACT_TOOL_NAME_ALIASES: Record<string, string> = {
  shell_command: "bash",
  "functions.shell_command": "bash",
  // Grok Build (xAI) names its terminal tool `run_terminal_command`. History
  // parses the raw name (`parsers/grok.rs`), so without this alias the reload
  // path misses the "bash" classification the live path infers from
  // `rawInput.command` — the command card would fall through to the generic
  // tool renderer (raw ANSI, no terminal title) instead of the Terminal card.
  run_terminal_command: "bash",
  // Cursor's history parser (`parsers/cursor.rs`) emits the CLI's own tool
  // identifiers; `shell` carries `rawInput.command`, so alias it to the
  // Terminal card. Cursor's other tool names (read/edit/grep/glob/ls) already
  // match their canonical kinds verbatim.
  shell: "bash",
  // Antigravity calls its terminal tool `run_command`, which is the name its
  // history parser reads back out of the trajectory (`parsers/antigravity.rs`).
  // The LIVE stream never sends it: `tools.py::extract_tool_display_title`
  // replaces the title with the command string itself ("so IDEs render the
  // command inside the terminal box"), so the live path has to classify on the
  // input shape instead — see the `command_line` / `CommandLine` keys in
  // `inferFromInput`. Both paths land on the same Terminal card.
  run_command: "bash",
  // Windows shells, under the two names that reach a client. Claude Code's CLI
  // runs commands through a `PowerShell` tool whenever Windows has no Git Bash
  // (SDK `SDKStartupFailureReason.shell_tool_missing` names the same pair), and
  // pi swaps `powershell` in for `bash` on the same platform. The freeform
  // matcher below cannot help: its `\bshell\b` needs a word boundary that
  // "powershell" does not have.
  //
  // Without the alias the name only half-resolved — `getToolIcon` and
  // `classifyToolKind` matched it, so the call drew a terminal icon and counted
  // as a command, while every dispatch keyed on the NORMALIZED name
  // (`isCommandTool`, `deriveToolTitle`, `StructuredToolInput`) fell through to
  // the generic renderer and dumped the input as raw JSON with no command line
  // and no terminal body. The live ACP path was rescued only once `rawInput`
  // streamed and `inferFromInput` found a `command` key in it; the history path
  // never is, because `parsers/claude.rs` and `parsers/pi.rs` both read the raw
  // tool name back out of the transcript — so the same call rendered one way
  // while it ran and another way on reload.
  powershell: "bash",
  exec_command: "exec_command",
  "functions.exec_command": "exec_command",
  "functions.read": "read",
  "functions.edit": "edit",
  "functions.write": "write",
  "functions.apply_patch": "apply_patch",
  change: "edit",
  "functions.change": "edit",
  changes: "edit",
  read_file: "read",
  read_text_file: "read",
  readfile: "read",
  "read file": "read",
  edit_file: "edit",
  update_file: "edit",
  write_file: "write",
  mcp__acp__read: "read",
  mcp__acp__edit: "edit",
  mcp__acp__write: "write",
  todowrite: "todowrite",
  todo_write: "todowrite",
  task_update: "taskupdate",
  task_create: "taskcreate",
  task_list: "tasklist",
  enter_plan_mode: "enterplanmode",
  exit_plan_mode: "exitplanmode",
  web_fetch: "webfetch",
  web_search: "websearch",
  context7_query_docs: "context7_query-docs",
  context7_resolve_library_id: "context7_resolve-library-id",
  agent: "agent",
  // Gemini CLI
  searchtext: "grep",
  search_text: "grep",
  writefile: "write",
  editfile: "edit",
  // Cline
  attempt_completion: "attempt_completion",
  ask_followup_question: "question",
  write_to_file: "write",
  replace_in_file: "edit",
  execute_command: "bash",
  list_files: "glob",
  search_files: "grep",
  list_code_definition_names: "grep",
  browser_action: "webfetch",
  use_mcp_tool: "tool",
  // Codex
  // Code-mode script card (`parsers/codex_code_mode.rs`). MUST be an exact
  // alias: the freeform `exec(ute)?` matcher below would otherwise collapse it
  // to "bash" and render the JS source as a shell command.
  [CODEX_SCRIPT_TOOL_NAME]: CODEX_SCRIPT_TOOL_NAME,
  // Unified-exec session tools. They keep their own identity (see
  // `shell-session-tool.ts`) instead of collapsing into "bash": their arguments
  // carry a session id, not a command, so the Terminal card's title derivation
  // came up empty and every one of them rendered as a bare "bash" / "wait".
  // Listed explicitly so no future freeform rule can hijack them.
  [WAIT_TOOL_NAME]: WAIT_TOOL_NAME,
  [WRITE_STDIN_TOOL_NAME]: WRITE_STDIN_TOOL_NAME,
  spawn_agent: "agent",
  wait_agent: "task",
  close_agent: "task",
  update_plan: "task",
  // Grok
  // The native sub-agent launcher. The history parser rewrites it to "Agent"
  // and the live path classifies it from `rawInput.subagent_type`; this alias
  // is the belt-and-braces for any path where only the raw name survives
  // (`x.ai/tool.name` fallback with no rawInput). The freeform `\bagent\b`
  // matcher can NOT catch it — "subagent" has no word boundary before "agent".
  spawn_subagent: "agent",
  create_goal: "create_goal",
  "functions.create_goal": "create_goal",
  update_goal: "update_goal",
  "functions.update_goal": "update_goal",
  request_user_input: "question",
  // codeg multi-agent delegation MCP tools (server prefix varies by host)
  delegate_to_agent: "delegate_to_agent",
  "mcp__codeg-mcp__delegate_to_agent": "delegate_to_agent",
  "mcp__codeg-delegate__delegate_to_agent": "delegate_to_agent",
  mcp__codeg__delegate_to_agent: "delegate_to_agent",
  get_delegation_status: "get_delegation_status",
  cancel_delegation: "cancel_delegation",
  resume_delegation: "resume_delegation",
  // codeg-mcp workbench companions (session lookup, work-task reporting, chat
  // authoring). Listed explicitly because the freeform `^task(\b|[_\s:-])` rule
  // below would otherwise collapse `task_progress` / `task_complete` into the
  // generic "task" tool and strand them on the generic tool shell. The suffix
  // rules in `normalizeToolName` cover the `mcp__<server>__…` forms.
  get_session_info: "get_session_info",
  task_progress: "task_progress",
  task_complete: "task_complete",
  create_automation: "create_automation",
  create_work_task: "create_work_task",
  // codeg-mcp live-feedback poll (server prefix varies by host; the suffix rule
  // in `normalizeToolName` covers the other separators). Codex persists it under
  // the bare `check_user_feedback` name, dropping the `mcp__codeg_mcp` namespace.
  check_user_feedback: "check_user_feedback",
  "mcp__codeg-mcp__check_user_feedback": "check_user_feedback",
  mcp__codeg__check_user_feedback: "check_user_feedback",
  // OpenCode
  delegate_task: "task",
  call_omo_agent: "agent",
  ast_grep_search: "grep",
  ast_grep_replace: "edit",
  background_task: "task",
  background_cancel: "task",
  background_output: "task",
  slashcommand: "skill",
  question: "question",
  ask_user_question: "question",
  askuserquestion: "question",
  // codeg-mcp ask-user-question companion tool (server prefix varies by host;
  // the suffix rule in `normalizeToolName` covers the other separators)
  "mcp__codeg-mcp__ask_user_question": "question",
  lsp_diagnostics: "lsp",
  lsp_document_symbols: "lsp",
  lsp_goto_definition: "lsp",
  lsp_servers: "lsp",
  execute: "bash",
  search: "grep",
  fetch: "webfetch",
  think: "task",
  switch_mode: "switch_mode",
  other: "tool",
}

function canonicalizeToolName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[().]/g, "_")
    .replace(/[\s-]+/g, "_")
}

function inferFromFreeformName(input: string): string | null {
  const normalized = input.trim().toLowerCase()
  if (!normalized) return null

  if (
    /\b(?:shell|bash|exec(?:ute)?)\s*[_-]?(?:command|cmd)?\b/.test(normalized)
  )
    return "bash"
  if (/apply\s*[_-]?patch/.test(normalized)) return "apply_patch"
  if (/^change(?:$|[\s:/_-])/.test(normalized)) return "edit"
  if (/^read(?:$|[\s:/-])/.test(normalized)) return "read"
  if (/^edit(?:$|[\s:/-])/.test(normalized)) return "edit"
  if (/^write(?:$|[\s:/-])/.test(normalized)) return "write"
  if (/^grep(?:\b|[_\s:-])/.test(normalized)) return "grep"
  if (/^glob(?:\b|[_\s:-])/.test(normalized)) return "glob"
  if (/^webfetch(?:\b|[_\s:-])/.test(normalized)) return "webfetch"
  if (/^websearch(?:\b|[_\s:-])/.test(normalized)) return "websearch"
  if (/\bweb[_\s-]?search\b/.test(normalized)) return "websearch"
  if (/\bgrep\b/.test(normalized)) return "grep"
  if (/\bagent\b/.test(normalized)) return "agent"
  if (/\blsp\b/.test(normalized)) return "lsp"
  if (/^todowrite(?:\b|[_\s:-])/.test(normalized)) return "todowrite"
  if (/^taskupdate(?:\b|[_\s:-])/.test(normalized)) return "taskupdate"
  if (/^taskcreate(?:\b|[_\s:-])/.test(normalized)) return "taskcreate"
  if (/^tasklist(?:\b|[_\s:-])/.test(normalized)) return "tasklist"
  if (/^task(?:\b|[_\s:-])/.test(normalized)) return "task"
  if (/\bask\s*(?:user)?\s*question\b/.test(normalized)) return "question"

  return null
}

function extractToolNameFromLiveCallTitle(input: string): string | null {
  const match = input.match(
    /^[:：'"`“”‘’\s]*([a-z0-9_.-]+)(?:\s*[:：])?\s*call[\w-]*['"`“”‘’\s]*$/i
  )
  return match?.[1] ?? null
}

const GOAL_UPDATE_TITLE_RE = /^goal updated\s*\(([^)]+)\)\s*[:：]\s*([\s\S]*)$/i

export interface ParsedGoalUpdateTitle {
  status: string
  objective: string
  toolName: "create_goal" | "update_goal"
}

function normalizeGoalStatus(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
}

function goalToolNameFromStatus(status: string): "create_goal" | "update_goal" {
  return normalizeGoalStatus(status) === "active"
    ? "create_goal"
    : "update_goal"
}

export function parseGoalUpdateTitle(
  input: string | null | undefined
): ParsedGoalUpdateTitle | null {
  const match = input?.trim().match(GOAL_UPDATE_TITLE_RE)
  if (!match) return null

  const status = normalizeGoalStatus(match[1] ?? "")
  const objective = (match[2] ?? "").trim()
  if (!status || !objective) return null

  return {
    status,
    objective,
    toolName: goalToolNameFromStatus(status),
  }
}

function tryParseInputObject(rawInput: string | null | undefined) {
  if (!rawInput) return null
  try {
    const parsed = JSON.parse(rawInput)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function hasAnyKey(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.some(
    (key) => key in obj && obj[key] !== null && obj[key] !== undefined
  )
}

/**
 * Codex ACP uses human titles for web-search follow-up actions. Those frames
 * keep `kind: "search"` (the same kind used by local fuzzy-file search), so
 * the title is the only identity signal when the raw-input type is omitted on
 * session replay.
 */
function isCodexWebSearchTitle(input: string | null | undefined): boolean {
  const title = input?.trim()
  if (!title) return false
  return /^(?:web\s+search|open\s+page|find\s+in\s+page)(?:\s*:|\s|$)/i.test(
    title
  )
}

/**
 * Gemini's web-search title, for the same reason Codex needs one above: its
 * `google_web_search` tool reports `kind: "search"` — the kind it also uses for
 * glob and grep — so the title is the only thing that says "web". The format is
 * `Searching the web for: "<query>"`, straight from the tool's own
 * `getDescription()` (packages/core/src/tools/web-search.ts, gemini-cli 0.60.0).
 *
 * Anchored at the start so an assistant or MCP tool that merely mentions the
 * phrase mid-title is not swept in.
 */
function isGeminiWebSearchTitle(input: string | null | undefined): boolean {
  const title = input?.trim()
  if (!title) return false
  return /^searching\s+the\s+web\s+for\s*:/i.test(title)
}

/** Codex's raw-input marker is camelCase on the ACP wire (`webSearch`). */
function isCodexWebSearchType(input: unknown): boolean {
  if (typeof input !== "string") return false
  return canonicalizeToolName(input).replace(/_/g, "") === "websearch"
}

/**
 * Wire spellings that mean the same argument as one of the canonical
 * (snake_case) keys every tool card reads. OpenCode names its tool arguments in
 * camelCase and its ACP adapter forwards them verbatim, so the LIVE stream
 * carries `filePath` / `oldString` where the history parser has already
 * rewritten them (`parsers/opencode.rs::normalize_tool_call`) — the renderers
 * only ever learned the canonical names, so a live Write card lost its path and
 * a live Edit card lost its diff. `include` → `glob` is the same one-sided
 * rename the history parser applies to OpenCode's grep filter.
 */
const TOOL_INPUT_KEY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["filePath", "file_path"],
  ["notebookPath", "notebook_path"],
  ["oldString", "old_string"],
  ["newString", "new_string"],
  ["newSource", "new_source"],
  ["replaceAll", "replace_all"],
  ["editMode", "edit_mode"],
  ["cellType", "cell_type"],
  ["include", "glob"],
]

/**
 * Fill in canonical argument names an agent spelled differently on the wire.
 *
 * Only writes a canonical key that is ABSENT (or null/undefined) on the input,
 * so it can never override what an agent actually sent — which makes it a
 * no-op on every payload that was already normalized in Rust (all history) and
 * on every agent that speaks snake_case natively. Returns the SAME object when
 * nothing had to be added, so `useMemo` consumers keep their reference.
 */
export function aliasToolInputKeys(
  parsed: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!parsed) return parsed
  let out: Record<string, unknown> | null = null
  for (const [alias, canonical] of TOOL_INPUT_KEY_ALIASES) {
    const value = parsed[alias]
    if (value === undefined || value === null) continue
    const existing = parsed[canonical]
    if (existing !== undefined && existing !== null) continue
    out ??= { ...parsed }
    out[canonical] = value
  }
  return out ?? parsed
}

function inferFromInput(
  rawInput: string | null | undefined,
  kind: string | null | undefined,
  title: string | null | undefined
): string | null {
  if (!rawInput) return null

  const normalizedKind = normalizeToolName(kind ?? "")
  const normalizedTitle = normalizeToolName(title ?? "")

  if (rawInput.includes("*** Begin Patch")) {
    return "apply_patch"
  }

  const trimmed = rawInput.trim()
  if (
    trimmed.length > 0 &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[") &&
    (normalizedKind === "bash" ||
      normalizedKind === "exec_command" ||
      normalizedKind === "tool" ||
      normalizedTitle === "bash" ||
      normalizedTitle === "exec_command")
  ) {
    return "bash"
  }

  const parsed = tryParseInputObject(rawInput)
  if (!parsed) return null

  // Cursor live MCP calls (`mcpToolCall`): rawInput carries the provider and
  // tool identity. Resolve to `<provider>__<tool>` — the same shape the
  // history parser emits — so MCP-routed tools (the delegation companions
  // et al) reach their dedicated cards, and before the `args` key below
  // misreads the payload as a terminal command.
  const mcpProvider = parsed.providerIdentifier
  const mcpTool = parsed.toolName
  if (
    typeof mcpProvider === "string" &&
    typeof mcpTool === "string" &&
    mcpTool
  ) {
    return normalizeToolName(
      mcpProvider ? `${mcpProvider}__${mcpTool}` : mcpTool
    )
  }

  if (
    hasAnyKey(parsed, [
      "command",
      "cmd",
      "script",
      "args",
      "argv",
      "command_args",
      // Antigravity's exec tools, in both spellings that reach a client: the
      // SDK hands the EXECUTED call `command_line`/`working_dir`, while the
      // model's own envelope — what a permission-prompt frame carries, and
      // what the trajectory stores — is PascalCase `CommandLine`/`Cwd`. Input
      // shape is the only signal available: the live title IS the command
      // (see the `run_command` alias above), so every title-based rule would
      // name the tool "pnpm build".
      "command_line",
      "CommandLine",
    ])
  )
    return "bash"
  // OpenCode names these arguments in camelCase on the wire, and its ACP
  // adapter forwards them verbatim, so the live stream sees `oldString` where
  // the history parser has already rewritten them to snake_case
  // (`parsers/opencode.rs::normalize_tool_call`).
  if (
    hasAnyKey(parsed, [
      "old_string",
      "new_string",
      "replace_all",
      "oldString",
      "newString",
      "replaceAll",
    ])
  )
    return "edit"
  if (hasAnyKey(parsed, ["changes"])) return "edit"
  if (hasAnyKey(parsed, ["todos"])) return "todowrite"
  // `query` is a common MCP argument (for example CodeGraph's
  // `codegraph_explore` and Context7's query tools), not a web-search
  // discriminator. Only classify it as websearch when the wire also names a
  // web-search tool, or when Codex's action title/type identifies the call;
  // otherwise `inferLiveToolName` can preserve the explicit tool title instead
  // of showing every query-bearing MCP call as "WebSearch". Codex's generic
  // `kind: "search"` intentionally remains a local file search (`grep`).
  if (
    hasAnyKey(parsed, ["query"]) &&
    (normalizedTitle === "websearch" ||
      normalizedTitle === "web_search" ||
      normalizedKind === "websearch" ||
      normalizedKind === "web_search" ||
      isCodexWebSearchTitle(title) ||
      isGeminiWebSearchTitle(title) ||
      isCodexWebSearchType(parsed.type))
  )
    return "websearch"
  if (hasAnyKey(parsed, ["url"])) return "webfetch"

  const hasPattern = hasAnyKey(parsed, ["pattern"])
  const hasGlob = hasAnyKey(parsed, ["glob"])
  if (hasPattern) return hasGlob ? "glob" : "grep"
  if (hasGlob) return "glob"

  // `question` (singular) covers Cline/Codex follow-up tools; `questions`
  // (plural) is the codeg-mcp `ask_user_question` payload shape, so the live
  // stream resolves to "question" before the tool result arrives.
  if (hasAnyKey(parsed, ["question", "questions"])) return "question"

  // `subagent_type` is the Claude Code Task shape; `subagentType` is Cursor's
  // task tool (a protobuf-es oneof object on the live wire).
  if (hasAnyKey(parsed, ["subagent_type", "subagentType"])) {
    return "agent"
  }
  if (hasAnyKey(parsed, ["taskId", "task_id", "subject"])) {
    return "task"
  }

  // Cursor stamps the semantic tool identity in `_toolName` for calls whose
  // args may not have streamed yet. `task` is Cursor's sub-agent tool — route
  // it to the Agent card even when the input snapshot is otherwise empty (the
  // live tool_call is announced before its args are populated). Other values
  // (`createPlan`, `generateImage`, …) collapse via camelCase → snake_case to
  // the canonical names the history parser emits.
  const hinted = parsed._toolName
  if (typeof hinted === "string" && hinted) {
    if (hinted === "task") return "agent"
    return normalizeToolName(
      hinted.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    )
  }

  // `filePath` is OpenCode's spelling; `session-files.ts` already counts it as
  // a path key, so recognising it here keeps classification and file tallies
  // agreeing on the same payload.
  const hasPath = hasAnyKey(parsed, [
    "file_path",
    "notebook_path",
    "path",
    "filePath",
  ])
  if (hasPath) {
    // Check write-specific input keys first — they take priority over
    // kind/title because ACP ToolKind::Edit ("edit") is a category that
    // covers both Edit and Write tools. Without this, a Write tool call
    // (with {content, file_path}) would be classified as "edit" due to
    // its kind, then rendered with EditToolInput which expects
    // old_string/new_string and produces blank output for new files.
    if (
      hasAnyKey(parsed, ["content", "new_source", "cell_type", "edit_mode"])
    ) {
      return "write"
    }
    if (
      normalizedKind === "read" ||
      normalizedKind === "edit" ||
      normalizedKind === "write" ||
      normalizedKind === "delete" ||
      normalizedKind === "move"
    ) {
      return normalizedKind
    }
    if (
      normalizedTitle === "read" ||
      normalizedTitle === "edit" ||
      normalizedTitle === "write"
    ) {
      return normalizedTitle
    }
    return "read"
  }

  return null
}

export function normalizeToolName(toolName: string): string {
  const raw = toolName.trim()
  const trimmed = raw
    .replace(/^[:：'"`“”‘’\s]+/, "")
    .replace(/['"`“”‘’\s]+$/, "")
  if (!trimmed) return "tool"

  const exact = EXACT_TOOL_NAME_ALIASES[trimmed.toLowerCase()]
  if (exact) return exact

  const goalUpdate = parseGoalUpdateTitle(trimmed)
  if (goalUpdate) return goalUpdate.toolName

  // codex-acp command-action tool calls (`createCommandActionEvent`) carry no
  // tool name and no rawInput — only a human title — so the search / list-files
  // identity has to be read back out of it. Without this the whole title becomes
  // the "tool name": no search icon, an "other" tool-group tally, and a body
  // that dumps the raw `{formatted_output, exit_code}` envelope. The sibling
  // `Read file '<path>'` shape already resolves via the `^read` freeform rule.
  //
  // Matched against `raw`, not `trimmed`: these titles END in the quote that
  // closes the interpolated query/path (`Search for 'TODO'`), and the trailing-
  // quote strip above would eat it.
  if (parseCodexSearchTitle(raw)) return "grep"
  if (parseCodexListFilesTitle(raw)) return "glob"

  const canonical = canonicalizeToolName(trimmed)
  const alias = EXACT_TOOL_NAME_ALIASES[canonical]
  if (alias) return alias

  // Multi-agent delegation MCP tools. Server prefix AND separator both
  // vary by host: Claude Code uses `mcp__<server>__<tool>`, Codex live ACP
  // exposes `<server>/<tool>`, others use `.` or `:`. Match the bare tool
  // name after any non-alphanumeric separator so every form collapses to
  // the same canonical name the renderer dispatches on.
  if (/[^a-z0-9]delegate_to_agent$/.test(canonical)) return "delegate_to_agent"
  if (/[^a-z0-9]get_delegation_status$/.test(canonical))
    return "get_delegation_status"
  if (/[^a-z0-9]cancel_delegation$/.test(canonical)) return "cancel_delegation"
  if (/[^a-z0-9]resume_delegation$/.test(canonical)) return "resume_delegation"
  if (/[^a-z0-9]create_goal$/.test(canonical)) return "create_goal"
  if (/[^a-z0-9]update_goal$/.test(canonical)) return "update_goal"

  // codeg-mcp workbench companions — same host-prefix story as the delegation
  // tools above (`mcp__<server>__get_session_info`, `<server>/task_progress`, …).
  if (/[^a-z0-9]get_session_info$/.test(canonical)) return "get_session_info"
  if (/[^a-z0-9]task_progress$/.test(canonical)) return "task_progress"
  if (/[^a-z0-9]task_complete$/.test(canonical)) return "task_complete"
  if (/[^a-z0-9]create_automation$/.test(canonical)) return "create_automation"
  if (/[^a-z0-9]create_work_task$/.test(canonical)) return "create_work_task"

  // codeg-mcp ask-user-question companion tool. Same host-prefix story as the
  // delegation tools above (`mcp__<server>__ask_user_question`,
  // `<server>/ask_user_question`, …) — the bare `ask_user_question` alias only
  // catches the unprefixed form, so collapse every separator here. Note the
  // freeform matcher below intentionally does NOT catch the underscore form.
  if (/[^a-z0-9]ask_user_question$/.test(canonical)) return "question"

  // codeg-mcp live-feedback poll. Same host-prefix story as the delegation tools
  // (`mcp__<server>__check_user_feedback`, `<server>/check_user_feedback`, …) —
  // collapse every separator to the canonical name the renderer dispatches on.
  if (/[^a-z0-9]check_user_feedback$/.test(canonical))
    return "check_user_feedback"

  const freeform = inferFromFreeformName(trimmed)
  if (freeform) return freeform

  const liveTitleToolName = extractToolNameFromLiveCallTitle(trimmed)
  if (liveTitleToolName) {
    const fromLiveTitle = normalizeToolName(liveTitleToolName)
    if (fromLiveTitle !== "tool") return fromLiveTitle
  }

  return trimmed
}

// Canonical names of the codeg-mcp delegation companion tools. Their identity
// must win over input-shape heuristics during live streaming (see
// `inferLiveToolName`): most have a dedicated card renderer, and
// `resume_delegation`'s `{task_id, reason}` input would otherwise be
// misclassified by `inferFromInput` exactly like `cancel_delegation`'s
// `{task_id}` (generic "task" tool).
const DELEGATION_COMPANION_TOOLS: ReadonlySet<string> = new Set([
  "delegate_to_agent",
  "get_delegation_status",
  "cancel_delegation",
  "resume_delegation",
])

export function inferLiveToolName(params: {
  title?: string | null
  kind?: string | null
  rawInput?: string | null
  meta?: Record<string, unknown> | null
}): string {
  // The backend (e.g. ACP connection layer for OpenCode sub-agent task
  // calls) may set `title="agent"` as an *authoritative* sentinel after
  // running agent-specific detection. This must win over `inferFromInput`'s
  // input-shape heuristics, which otherwise classify sub-agent payloads
  // as "bash" / "edit" / etc. when their input objects happen to carry a
  // `command`/`args`/`changes`/... key alongside the real `subagent_type`
  // marker.
  //
  // Match the sentinel by *literal* equality after trimming/lowercasing —
  // NOT via `normalizeToolName`, whose freeform `\bagent\b` matcher would
  // misclassify any title containing the word "agent" (e.g. "Inspect agent
  // config") as an Agent card before raw_input is even consulted.
  if ((params.title ?? "").trim().toLowerCase() === "agent") return "agent"

  // Grok plan-mode tools carry their authoritative identity in
  // `_meta["x.ai/tool"].kind` (`enter_plan`/`exit_plan`), while their human
  // `title` MUTATES across the lifecycle (`enter_plan_mode` → "Plan: Enter" →
  // "Plan mode entered"). Resolve them to the canonical name here, ahead of the
  // title-based fallbacks below, so the live stream routes into the same
  // <PlanModeCard> (and its tool-group run-break) the historical path resolves
  // from `x.ai/tool.name`. Scoped to plan-mode so every other Grok tool keeps
  // its existing resolution. See `extractGrokPlanModeToolName`.
  const grokPlanMode = extractGrokPlanModeToolName(params.meta)
  if (grokPlanMode) return grokPlanMode

  // codex collab / sub-agent activity (codex-acp 1.0.1 #223). The live ACP
  // tool_call's title is the bare, free-form collab op (`spawn_agent`/
  // `wait_agent`/`close_agent`/…), but its rawInput carries inter-agent fields
  // no other tool emits. Detect by that shape so the call routes to the
  // dedicated collab card regardless of the title (and ahead of `inferFromInput`,
  // which returns null for this shape anyway, and the title alias that would
  // otherwise collapse `spawn_agent`→"agent" / `wait_agent`→"task").
  if (isCodexCollabInput(params.rawInput)) return COLLAB_AGENT_TOOL_NAME

  // The codeg-mcp delegation companion tools carry their authoritative identity
  // in `meta.claudeCode.toolName` — claude-agent-acp sets it to the raw
  // `mcp__<server>__<tool>` name for every MCP call — and, on Qoder, in
  // `meta.qoder.toolName`. Resolve them FIRST, ahead of `inferFromInput`, so the
  // live stream routes into the same delegation cards the historical path
  // resolves from the raw tool name. Without this, `cancel_delegation` (input
  // `{task_id}`) gets misclassified by `inferFromInput` as the generic "task"
  // tool (shown as "任务" with no detail), and `get_delegation_status` (input
  // `{task_ids}`) falls through unclassified — both need meta to resolve to the
  // canonical companion tool name.
  // Scoped to these three so the documented input-shape-first ordering below
  // (notably Claude Code's `Task` → "agent" via `subagent_type`, whose meta
  // name is "Task" — not a delegation tool) is preserved for everything else.
  const metaToolName = extractClaudeCodeToolName(params.meta)
  const qoderToolName = extractQoderToolName(params.meta)
  for (const candidate of [metaToolName, qoderToolName]) {
    if (!candidate) continue
    const normalizedMeta = normalizeToolName(candidate)
    if (DELEGATION_COMPANION_TOOLS.has(normalizedMeta)) return normalizedMeta
  }

  // The delegation broker stamps `meta["codeg.delegation"]` onto the parent's
  // `delegate_to_agent` tool call (meta_writer.rs) — an authoritative,
  // codeg-minted marker no other tool ever carries. It is the ONLY live
  // identity signal on hosts whose wire loses the MCP tool name entirely:
  // Cursor announces MCP calls as title "MCP: tool" with empty rawInput and
  // never resends either, so when the broker claims the call and writes the
  // running meta, this is what flips the card to the delegation renderer
  // mid-run (the title-sniff rewrite only lands at completion).
  if (
    params.meta &&
    typeof params.meta === "object" &&
    "codeg.delegation" in params.meta
  ) {
    return "delegate_to_agent"
  }

  // Delegation companion tools also carry their identity in the TITLE on hosts
  // that don't set `claudeCode` meta — notably Grok, whose backend unwraps the
  // `use_tool` envelope so the title becomes the raw `<server>__<tool>` name.
  // Resolve them here, ahead of `inferFromInput`, so `cancel_delegation` (input
  // `{task_id}`) isn't misclassified as the generic "task" tool (and
  // get_delegation_status / delegate_to_agent stay consistent). Scoped to the
  // companion set, so the input-shape-first ordering below is preserved for
  // everything else.
  const titleCompanion = normalizeToolName(params.title ?? "")
  if (DELEGATION_COMPANION_TOOLS.has(titleCompanion)) return titleCompanion

  // claude-agent-acp ≥0.63 marks Agent/Task launches with the authoritative
  // `_meta.claudeCode.subagent: true` (its stated purpose: clients should not
  // infer subagents from `toolName` or the generic `think` kind). Resolve it
  // ahead of `inferFromInput` so the Agent card classifies on frame 1 even
  // when `rawInput` (and its `subagent_type` shape) hasn't streamed yet and
  // the meta toolName is the legacy `Task`. The Task regression guard below
  // (meta toolName must NOT override input shape) is untouched: that path
  // carries no `subagent` flag.
  if (claudeCodeMarksSubagent(params.meta)) return "agent"

  // OpenCode's authoritative tool name, recorded by the backend from the one
  // frame that carries it (`stamp_opencode_tool_name`). This is the exception
  // to the input-shape-first ordering below, and deliberately so: OpenCode's
  // completion frame drops `kind`/`rawInput` and rewrites `title` into a
  // display label, so the input shape is ALL that survives — and several of its
  // tools are ambiguous under it. Measured against opencode 1.18.30's real
  // frames, `glob` ({pattern}) resolved to "grep", `lsp_diagnostics` ({path}) to
  // "read", and an MCP tool taking {query} to "websearch" — each of which the
  // history parser (reading `part.tool`) names correctly, so the same call
  // changed identity on reload.
  //
  // Placed AFTER the `title === "agent"` sentinel at the top, which is what
  // keeps OpenCode's own sub-agent `task` call on the Agent card: the backend
  // rewrites that title once `rawInput.subagent_type` arrives, and the marker
  // here (recorded from the arg-less opening frame) must not undo it.
  const openCodeToolName = extractOpenCodeToolName(params.meta)
  if (openCodeToolName) return normalizeToolName(openCodeToolName)

  // Input-shape detection runs FIRST so cross-agent heuristics (Claude Code
  // `Task` tool routed via `subagent_type`, OpenCode sub-agent calls, etc.)
  // keep priority. The meta-tool-name override below only kicks in when the
  // input shape is silent — i.e. synthesized events with no `rawInput`.
  const byInput = inferFromInput(params.rawInput, params.kind, params.title)
  if (byInput) return byInput

  // Claude-Code override: claude-agent-acp embeds the SDK tool name under
  // `_meta.claudeCode.toolName`. We need it for synthesized events like
  // `memory_recall` (kind="read" + title="Recalled N memories"), where neither
  // the input shape nor the human title carries the real identity. Placed below
  // `inferFromInput` so the more specific subagent_type / patch / command
  // heuristics keep winning when present.
  //
  // Lower-case it so the canonical name matches the rest of this function's
  // returns (all lower-case). The SDK reports the Agent/Task tool as `Agent`
  // (capitalised); before `rawInput` streams in, that is the only signal we
  // have, and the live agent-card nesting check (`getToolName(...) === "agent"`
  // in conversation-runtime-context) is case-sensitive — returning `"Agent"`
  // there left child tool calls un-nested and the card stuck on its fallback
  // title. We deliberately do NOT run `normalizeToolName` here: its live-title
  // heuristic rewrites `memory_recall` to `memory_re`.
  if (metaToolName) return metaToolName.toLowerCase()

  // Grok stamps the authoritative tool name in `_meta["x.ai/tool"].name` while
  // its `title` MUTATES across the lifecycle. A background-task poll is the
  // worst case: `get_command_or_subagent_output` → "Get task output: term_…" →
  // "/bin/bash -lc 'pnpm dev …' (term_b0d)", so the title fallback below named
  // the same call three different things and finally collapsed it to "bash" —
  // where the history path (which reads `x.ai/tool.name`) kept the real name.
  //
  // Placed AFTER `inferFromInput` so every input-shape classification is
  // preserved (`search_replace` → "edit" via old_string/new_string,
  // `run_terminal_command` → "bash" via command, …) and this only decides the
  // cases where the input shape is silent. See `extractGrokToolName` for the
  // `use_tool` exclusion.
  const grokToolName = extractGrokToolName(params.meta)
  if (grokToolName) return normalizeToolName(grokToolName)

  // Qoder stamps the authoritative tool name in `_meta.qoder.toolName` on EVERY
  // `tool_call` (`AOn` in its ACP bridge), while the `title` it ships for an MCP
  // call is a human sentence — `"<tool> (<server> MCP Server)"` — that no
  // suffix/alias rule can collapse. Without this, every codeg-mcp companion but
  // `delegate_to_agent` (rescued by the broker's `codeg.delegation` marker
  // above) fell through to the generic tool shell: `get_session_info` /
  // `task_progress` / `check_user_feedback` kept the sentence as their "name",
  // so their cards never matched — while the historical path, which reads the
  // raw `mcp__codeg-mcp__<tool>` name straight out of the transcript, rendered
  // them correctly. Same placement as the Grok override: AFTER `inferFromInput`,
  // so every input-shape classification Qoder's own tools rely on is preserved
  // (`Agent` → "agent" via `subagent_type`, `TodoWrite` → "todowrite" via
  // `todos`, …) and this only decides the cases where the input shape is silent.
  //
  // Lower-cased for the same reason the claude-agent-acp branch above is: Qoder
  // names its native tools in CamelCase (`ExitPlanMode`, `Workflow`), and
  // `normalizeToolName` passes an unmatched name through with its case intact —
  // but every other return here is lower-case, and some consumers compare
  // case-sensitively. Display is unaffected: the header prefers the ACP `title`,
  // which Qoder always sends.
  if (qoderToolName) return normalizeToolName(qoderToolName).toLowerCase()

  // codex-acp ≥1.1.8 Plan-mode review gate. The backend seeds this tool call
  // from the `session/request_permission` (see `is_codex_plan_review`), so it
  // carries no `rawInput` and its human title is a question ("Implement this
  // plan?") that the title heuristic below would happily mangle into a tool
  // name. Resolve the identity from the marker instead — MUST stay above
  // `byTitle` for that reason.
  if (codexMarksPlanReview(params.meta)) return "plan_review"

  const byTitle = normalizeToolName(params.title ?? "")
  if (byTitle !== "tool") return byTitle

  const byKind = normalizeToolName(params.kind ?? "")
  if (byKind !== "tool") return byKind

  return "tool"
}

function extractClaudeCodeToolName(
  meta: Record<string, unknown> | null | undefined
): string | null {
  if (!meta || typeof meta !== "object") return null
  const cc = (meta as Record<string, unknown>).claudeCode
  if (!cc || typeof cc !== "object") return null
  const tn = (cc as Record<string, unknown>).toolName
  if (typeof tn !== "string") return null
  const trimmed = tn.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Qoder's authoritative tool name from `_meta.qoder.toolName` — the raw SDK name
 * (`Bash`, `TodoWrite`, `mcp__codeg-mcp__get_delegation_status`, …) its ACP
 * bridge attaches to every `tool_call` it emits, and the same name its history
 * parser reads back out of the transcript. Unlike `title`, it neither mutates
 * across the call's lifecycle nor gets rewritten into a human sentence.
 *
 * Only the OPENING `tool_call` carries it — Qoder's `tool_call_update` frames
 * ship status/output only — which is fine: the reducer preserves a block's meta
 * when an update omits it.
 */
function extractQoderToolName(
  meta: Record<string, unknown> | null | undefined
): string | null {
  if (!meta || typeof meta !== "object") return null
  const qoder = (meta as Record<string, unknown>).qoder
  if (!qoder || typeof qoder !== "object") return null
  const name = (qoder as Record<string, unknown>).toolName
  if (typeof name !== "string") return null
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * OpenCode's authoritative tool name from `_meta.opencode.toolName` — the raw
 * tool id (`glob`, `lsp_diagnostics`, `context7_query-docs`, …) codeg's backend
 * lifts off the opening `tool_call` frame, which is the only frame OpenCode
 * states it on (see `stamp_opencode_tool_name` for the captured wire evidence).
 * The same name the history parser reads out of `part.tool`, so both paths land
 * on the same card.
 *
 * Only the OPENING frame carries it; the reducer preserves a block's `meta`
 * when an update omits it, so it stays available for the call's whole lifetime.
 */
function extractOpenCodeToolName(
  meta: Record<string, unknown> | null | undefined
): string | null {
  if (!meta || typeof meta !== "object") return null
  const opencode = (meta as Record<string, unknown>).opencode
  if (!opencode || typeof opencode !== "object") return null
  const name = (opencode as Record<string, unknown>).toolName
  if (typeof name !== "string") return null
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * claude-agent-acp ≥0.63 marks Agent/Task tool calls with
 * `_meta.claudeCode.subagent: true` — the namespaced subagent-launch marker
 * (ACP 1.2 has no standard subagent ToolKind). Strict `=== true`: any other
 * shape reads as unmarked.
 */
export function claudeCodeMarksSubagent(
  meta: Record<string, unknown> | null | undefined
): boolean {
  if (!meta || typeof meta !== "object") return false
  const cc = (meta as Record<string, unknown>).claudeCode
  if (!cc || typeof cc !== "object") return false
  return (cc as Record<string, unknown>).subagent === true
}

/**
 * codex-acp ≥1.1.8 (#351) marks the Plan-mode review gate with
 * `_meta.codex = {kind: "plan_review", planItemId}`. The backend forwards that
 * `_meta` onto the tool call it seeds from the permission request, which is the
 * only identity signal the card has (no `rawInput`, and a question for a title).
 */
export function codexMarksPlanReview(
  meta: Record<string, unknown> | null | undefined
): boolean {
  if (!meta || typeof meta !== "object") return false
  const codex = (meta as Record<string, unknown>).codex
  if (!codex || typeof codex !== "object") return false
  return (codex as Record<string, unknown>).kind === "plan_review"
}

/**
 * claude-agent-acp ≥0.63 exposes the tool's human-readable description as
 * `_meta.claudeCode.title` (for Bash: the model-authored `description` input;
 * falls back to the command upstream). The ACP `title` stays the raw command,
 * so this is the display-friendly label — available from frame 1, including
 * on eager permission tool calls, before `rawInput` streams in.
 */
export function extractClaudeCodeMetaTitle(
  meta: Record<string, unknown> | null | undefined
): string | null {
  if (!meta || typeof meta !== "object") return null
  const cc = (meta as Record<string, unknown>).claudeCode
  if (!cc || typeof cc !== "object") return null
  const title = (cc as Record<string, unknown>).title
  if (typeof title !== "string") return null
  const trimmed = title.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * claude-agent-acp ≥0.67 (#986) stamps Skill tool calls with
 * `_meta.claudeCode.skill` (the invoked skill's name; a sibling `skillPath`
 * carries the resolved SKILL.md when one was located). The AUTHORITATIVE name
 * source for the skill title: available from frame 1 — before `rawInput`
 * streams — and immune to a truncated/unparsable input, which is all the
 * derived-title path otherwise has to work with.
 */
export function extractClaudeCodeSkillName(
  meta: Record<string, unknown> | null | undefined
): string | null {
  if (!meta || typeof meta !== "object") return null
  const cc = (meta as Record<string, unknown>).claudeCode
  if (!cc || typeof cc !== "object") return null
  const skill = (cc as Record<string, unknown>).skill
  if (typeof skill !== "string") return null
  const trimmed = skill.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Whether the agent has moved this tool call's process into the background —
 * JetBrains AIR's `_meta.jetbrains.air.asyncTasks.backgrounded` marker
 * (codex-acp 1.10+, published only because `build_client_capabilities`
 * advertises the `asyncTasks` capability).
 *
 * It arrives on a `tool_call_update` that carries NOTHING else: no status, no
 * content, no output — just the id and this flag, immediately before the
 * matching `async_task_spawned`. That is the point of reading it: the launching
 * `execute` call stays `in_progress` for the rest of the connection (codex only
 * completes it when the process finally exits or a stop lands), so without the
 * marker the card is indistinguishable from a command that hung.
 *
 * Two shape notes, both load-bearing:
 *   - there is NO `version` key inside this `air` block — unlike its
 *     `sessionFailure` sibling — so nothing here may gate on one;
 *   - the flag is only ever published as `true`; the adapter withdraws it by
 *     settling the tool call, never by sending `false`. Strict equality anyway,
 *     so a future `false` reads as "not backgrounded" rather than truthy.
 */
export function toolCallMovedToBackground(
  meta: Record<string, unknown> | null | undefined
): boolean {
  if (!meta || typeof meta !== "object") return false
  const jetbrains = (meta as Record<string, unknown>).jetbrains
  if (!jetbrains || typeof jetbrains !== "object") return false
  const air = (jetbrains as Record<string, unknown>).air
  if (!air || typeof air !== "object") return false
  const asyncTasks = (air as Record<string, unknown>).asyncTasks
  if (!asyncTasks || typeof asyncTasks !== "object") return false
  return (asyncTasks as Record<string, unknown>).backgrounded === true
}

/**
 * Grok stamps the authoritative tool identity in `_meta["x.ai/tool"]`
 * (`{ name, kind, namespace, label }`). For its plan-mode tools this returns the
 * canonical `enter_plan_mode` / `exit_plan_mode` name (which `normalizeToolName`
 * then aliases to `enterplanmode`/`exitplanmode`); `null` for every other Grok
 * tool and every non-Grok host, so their existing title/alias resolution is
 * preserved. Keyed on the stable `kind` discriminator, which — unlike `title` —
 * does not mutate across the tool_call lifecycle.
 */
function extractGrokPlanModeToolName(
  meta: Record<string, unknown> | null | undefined
): string | null {
  if (!meta || typeof meta !== "object") return null
  const tool = (meta as Record<string, unknown>)["x.ai/tool"]
  if (!tool || typeof tool !== "object") return null
  const kind = (tool as Record<string, unknown>).kind
  if (kind === "enter_plan") return "enter_plan_mode"
  if (kind === "exit_plan") return "exit_plan_mode"
  return null
}

/**
 * Grok's authoritative tool name from `_meta["x.ai/tool"].name` — the same
 * field the history parser stores (`parsers/grok.rs`), and the only identity on
 * the live wire that does NOT mutate across a call's lifecycle (`title` does).
 *
 * `use_tool` — Grok's generic MCP envelope — is excluded: the backend unwraps it
 * and puts the inner `<server>__<tool>` name in the TITLE
 * (`connection.rs::unwrap_grok_use_tool`), so the envelope name would send every
 * MCP call (delegation companions included) to the generic tool card.
 */
function extractGrokToolName(
  meta: Record<string, unknown> | null | undefined
): string | null {
  if (!meta || typeof meta !== "object") return null
  const tool = (meta as Record<string, unknown>)["x.ai/tool"]
  if (!tool || typeof tool !== "object") return null
  const name = (tool as Record<string, unknown>).name
  if (typeof name !== "string") return null
  const trimmed = name.trim()
  if (!trimmed || trimmed === "use_tool") return null
  return trimmed
}
