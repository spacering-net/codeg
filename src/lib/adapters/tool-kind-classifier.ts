import { COLLAB_AGENT_TOOL_NAME } from "@/lib/collab-tool"
import { isShellSessionToolName } from "@/lib/shell-session-tool"

export type ToolKindLabel =
  | "search"
  | "command"
  | "read"
  | "memory"
  | "edit"
  | "fetch"
  | "think"
  | "todo"
  | "task"
  | "other"

export const TOOL_KIND_ORDER: ToolKindLabel[] = [
  "search",
  "read",
  "memory",
  "edit",
  "command",
  "fetch",
  "task",
  "todo",
  "think",
  "other",
]

/**
 * Identify agent-like tool calls that own their own card-style rendering
 * (e.g. AgentToolCallPart, DelegatedSubThread). These should not be folded
 * into a tool-group; they each break the run and render standalone.
 *
 * The delegation MCP tools surface with a host-specific server prefix and
 * separator: Claude Code emits `mcp__<server>__<tool>`, Codex live ACP
 * exposes them as `<server>/<tool>`, and other hosts may use `.` or `:`.
 * Match the suffix after any non-alphanumeric separator so every form lands
 * on the same code path. The bare-name comparisons cover the live-streaming
 * path (where `inferLiveToolName` has already collapsed to the canonical
 * name); the suffix regexes cover the historical path (raw tool name).
 */
const DELEGATE_TO_AGENT_SUFFIX_RE = /[^a-z0-9]delegate_to_agent$/
const GET_DELEGATION_STATUS_SUFFIX_RE = /[^a-z0-9]get_delegation_status$/
const CANCEL_DELEGATION_SUFFIX_RE = /[^a-z0-9]cancel_delegation$/
const CREATE_GOAL_SUFFIX_RE = /[^a-z0-9]create_goal$/
const UPDATE_GOAL_SUFFIX_RE = /[^a-z0-9]update_goal$/
const ASK_USER_QUESTION_SUFFIX_RE = /[^a-z0-9]ask_user_question$/
const CHECK_USER_FEEDBACK_SUFFIX_RE = /[^a-z0-9]check_user_feedback$/

/**
 * The codeg-mcp workbench companions, which own `CodegMcpToolCard` (and, for
 * `resume_delegation`, `ResumedDelegationCard`). Same bare-name-plus-suffix
 * treatment as the delegation tools above: the bare form is what the live path
 * produces post-`inferLiveToolName`, the suffix form is the raw
 * `mcp__<server>__<tool>` name the history parsers keep.
 *
 * MUST stay in sync with `CODEG_MCP_WORKBENCH_TOOLS` in `@/lib/codeg-mcp-tool`
 * — a tool listed there but missing here still gets its dedicated card, but
 * folds into a generic "工具 ×N" tool-group shell instead of standing alone.
 * That is exactly what happened to `resume_delegation` when it was added.
 * `tool-kind-classifier.test.ts` asserts the two can't drift again.
 */
const CODEG_MCP_WORKBENCH_NAMES: ReadonlySet<string> = new Set([
  "get_session_info",
  "task_progress",
  "task_complete",
  "create_automation",
  "create_work_task",
  "resume_delegation",
])
const CODEG_MCP_WORKBENCH_SUFFIX_RE =
  /[^a-z0-9](?:get_session_info|task_progress|task_complete|create_automation|create_work_task|resume_delegation)$/

export function isAgentLikeToolName(toolName: string): boolean {
  const name = toolName.toLowerCase().trim()
  if (name === "agent") return true
  // codex live collab / sub-agent card (codex-acp 1.0.1 #223): owns a dedicated
  // compact card, so it breaks the run and renders standalone, like the other
  // agent-like tools, rather than folding into a generic tool-group.
  if (name === COLLAB_AGENT_TOOL_NAME) return true
  if (
    name === "delegate_to_agent" ||
    name === "get_delegation_status" ||
    name === "cancel_delegation" ||
    name === "create_goal" ||
    name === "update_goal" ||
    // codeg-mcp ask_user_question — owns the AskQuestionResultCard, so it must
    // break the run and render standalone rather than fold into a tool-group.
    // "question" is the canonical name (live path); the bare raw name plus the
    // suffix RE below cover the historical `mcp__<server>__ask_user_question`
    // forms, since this runs pre-normalize.
    name === "question" ||
    name === "ask_user_question" ||
    // Kimi Code's native AskUserQuestion (also Claude's SDK tool of the same
    // name). The history parsers keep this raw camel-case name — without it the
    // answered capsule folds into a generic tool-group; the live path already
    // collapses it to "question".
    name === "askuserquestion" ||
    // codex Plan-mode `request_user_input` (delivered via elicitation) owns the
    // same AskQuestionResultCard. The history parser keeps this raw name, so
    // hoist it here too; the live path already collapses it to "question".
    name === "request_user_input" ||
    // codeg-mcp check_user_feedback — owns the FeedbackCheckResultCard capsule,
    // so the (visible) ones must break the run and render standalone rather than
    // fold into a tool-group. The no-op polls are dropped upstream by
    // `dropHiddenFeedbackChecks`, so only received-feedback checks reach here.
    name === "check_user_feedback"
  )
    return true
  if (DELEGATE_TO_AGENT_SUFFIX_RE.test(name)) return true
  if (GET_DELEGATION_STATUS_SUFFIX_RE.test(name)) return true
  if (CANCEL_DELEGATION_SUFFIX_RE.test(name)) return true
  if (CREATE_GOAL_SUFFIX_RE.test(name)) return true
  if (UPDATE_GOAL_SUFFIX_RE.test(name)) return true
  if (ASK_USER_QUESTION_SUFFIX_RE.test(name)) return true
  if (CHECK_USER_FEEDBACK_SUFFIX_RE.test(name)) return true
  if (CODEG_MCP_WORKBENCH_NAMES.has(name)) return true
  if (CODEG_MCP_WORKBENCH_SUFFIX_RE.test(name)) return true
  return false
}

/**
 * Specifically the `get_delegation_status` companion tool, in either the bare
 * canonical form (live streaming, post-`inferLiveToolName`) or any host-
 * prefixed form (historical raw name: `mcp__<server>__get_delegation_status`,
 * `<server>/get_delegation_status`, …). Used to collapse a run of consecutive
 * status polls into a single merged card.
 */
export function isDelegationStatusToolName(toolName: string): boolean {
  const name = toolName.toLowerCase().trim()
  return (
    name === "get_delegation_status" ||
    GET_DELEGATION_STATUS_SUFFIX_RE.test(name)
  )
}

export function classifyToolKind(toolName: string): ToolKindLabel {
  const name = toolName.toLowerCase().trim()

  if (
    name === "grep" ||
    name === "glob" ||
    name === "search" ||
    name === "find" ||
    // pi's directory listing (`ls`), which sits with `find`/`grep` in its
    // built-in set (`bash`/`edit`/`find`/`grep`/`ls`/`powershell`/`read`/`write`)
    // and answers the same "where is it" question.
    name === "ls" ||
    name === "list_files" ||
    name === "list_code_definition_names"
  ) {
    return "search"
  }

  if (
    name === "bash" ||
    name === "exec_command" ||
    name === "shell" ||
    // Windows swaps `bash` for `powershell` — pi always, Claude Code whenever
    // the machine has no Git Bash. Same tool, same tally. Kept even though
    // `normalizeToolName` now aliases the name: this classifier is fed the RAW
    // tool name (see the tool-group builder in `ai-elements-adapter`).
    name === "powershell" ||
    name === "execute_command" ||
    name === "run_command" ||
    // codex's unified-exec session tools continue a background shell started by
    // an `exec_command`, so they belong with the commands in the tool-group
    // tally (see `shell-session-tool.ts`).
    isShellSessionToolName(name)
  ) {
    return "command"
  }

  if (
    name === "read" ||
    name === "read file" ||
    name === "read_file" ||
    name === "view"
  ) {
    return "read"
  }

  if (name === "memory_recall") {
    return "memory"
  }

  if (
    name === "edit" ||
    name === "write" ||
    name === "notebookedit" ||
    name === "apply_patch" ||
    name === "str_replace" ||
    name === "create_file" ||
    name === "write_to_file" ||
    name === "replace_in_file"
  ) {
    return "edit"
  }

  if (
    name === "webfetch" ||
    name === "websearch" ||
    name === "fetch" ||
    name === "browser" ||
    name === "browser_action" ||
    name === "web_search"
  ) {
    return "fetch"
  }

  if (
    name === "think" ||
    name === "sequentialthinking" ||
    name === "enterplanmode" ||
    name === "exitplanmode" ||
    name === "switch_mode"
  ) {
    return "think"
  }

  if (
    name === "todowrite" ||
    name === "tasklist" ||
    name === "taskcreate" ||
    name === "taskupdate" ||
    name === "update_todo_list"
  ) {
    return "todo"
  }

  if (
    name === "task" ||
    name === "agent" ||
    name === "skill" ||
    name === "new_task" ||
    name === "attempt_completion"
  ) {
    return "task"
  }

  return "other"
}
