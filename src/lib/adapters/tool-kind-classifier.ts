import { COLLAB_AGENT_TOOL_NAME } from "@/lib/collab-tool"

/**
 * Identify agent-like tool calls — a sub-agent launch, a codeg delegation, a
 * question, a feedback check, a goal, a codeg-mcp workbench call — which draw
 * a row of their own and handle their own empty in-flight calls, so the
 * generic empty-call filter (`dropEmptyInFlightToolCalls`) leaves them be.
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
const RENDER_PAGE_SUFFIX_RE = /[^a-z0-9]render_page$/

/**
 * The codeg-mcp workbench companions, which own `CodegMcpToolCard` (and, for
 * `resume_delegation`, `ResumedDelegationCard`). Same bare-name-plus-suffix
 * treatment as the delegation tools above: the bare form is what the live path
 * produces post-`inferLiveToolName`, the suffix form is the raw
 * `mcp__<server>__<tool>` name the history parsers keep.
 *
 * MUST stay in sync with `CODEG_MCP_WORKBENCH_TOOLS` in `@/lib/codeg-mcp-tool`
 * — a tool listed there but missing here still gets its dedicated card, but
 * the empty-call filter takes it for a generic call and hides it while it runs
 * without arguments. `tool-kind-classifier.test.ts` asserts the two can't
 * drift.
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
  // compact card, like the other agent-like tools.
  if (name === COLLAB_AGENT_TOOL_NAME) return true
  if (
    name === "delegate_to_agent" ||
    name === "get_delegation_status" ||
    name === "cancel_delegation" ||
    name === "create_goal" ||
    name === "update_goal" ||
    // codeg-mcp ask_user_question — owns the AskQuestionResultCard.
    // "question" is the canonical name (live path); the bare raw name plus the
    // suffix RE below cover the historical `mcp__<server>__ask_user_question`
    // forms, since this runs pre-normalize.
    name === "question" ||
    name === "ask_user_question" ||
    // Google Antigravity's native ask tool: the history parser keeps this raw
    // name. Bare only, like the alias in `tool-call-normalization` — a
    // host-prefixed `*ask_question` is a third-party MCP tool.
    name === "ask_question" ||
    // Kimi Code's native AskUserQuestion (also Claude's SDK tool of the same
    // name). The history parsers keep this raw camel-case name; the live path
    // already collapses it to "question".
    name === "askuserquestion" ||
    // codex Plan-mode `request_user_input` (delivered via elicitation) owns the
    // same AskQuestionResultCard. The history parser keeps this raw name, so
    // hoist it here too; the live path already collapses it to "question".
    name === "request_user_input" ||
    // codeg-mcp check_user_feedback — owns the timeline's feedback row. The
    // no-op polls are dropped upstream by `dropHiddenFeedbackChecks`, so only
    // received-feedback checks reach here.
    name === "check_user_feedback" ||
    // codeg-mcp render_page — owns the RenderPageResultCard, same standalone
    // treatment as `question`. The bare form is the canonical name (live path);
    // the suffix RE below covers the historical host-prefixed forms, since this
    // runs pre-normalize.
    name === "render_page"
  )
    return true
  if (DELEGATE_TO_AGENT_SUFFIX_RE.test(name)) return true
  if (GET_DELEGATION_STATUS_SUFFIX_RE.test(name)) return true
  if (CANCEL_DELEGATION_SUFFIX_RE.test(name)) return true
  if (CREATE_GOAL_SUFFIX_RE.test(name)) return true
  if (UPDATE_GOAL_SUFFIX_RE.test(name)) return true
  if (ASK_USER_QUESTION_SUFFIX_RE.test(name)) return true
  if (CHECK_USER_FEEDBACK_SUFFIX_RE.test(name)) return true
  if (RENDER_PAGE_SUFFIX_RE.test(name)) return true
  if (CODEG_MCP_WORKBENCH_NAMES.has(name)) return true
  if (CODEG_MCP_WORKBENCH_SUFFIX_RE.test(name)) return true
  return false
}

/**
 * Specifically the `get_delegation_status` companion tool, in either the bare
 * canonical form (live streaming, post-`inferLiveToolName`) or any host-
 * prefixed form (historical raw name: `mcp__<server>__get_delegation_status`,
 * `<server>/get_delegation_status`, …). Used to collapse a run of consecutive
 * status polls into one group.
 */
export function isDelegationStatusToolName(toolName: string): boolean {
  const name = toolName.toLowerCase().trim()
  return (
    name === "get_delegation_status" ||
    GET_DELEGATION_STATUS_SUFFIX_RE.test(name)
  )
}
