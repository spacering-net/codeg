import type {
  AdaptedContentPart,
  AdaptedGeneratedImagePart,
  AdaptedGoalRunPart,
  AdaptedPlanPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import type { ToolApproval } from "./approval"
import type { CommandExit, HeredocCommand } from "./command"
import type { EditFileChange } from "./edit"
import type { ExitMeaning } from "./exit-meaning"
import type { McpIdentity } from "./mcp"
import type { StepStatus } from "./status"

export type { StepStatus } from "./status"

/**
 * What a tool call was, as far as the activity timeline is concerned. Decides
 * the row's icon, its layout, and which group (if any) it can join.
 */
export type ToolStepKind =
  // Exploration: reading the workspace or the web. Consecutive ones fold into
  // one "Explored" row.
  | "read"
  | "search"
  | "glob"
  | "list"
  | "fetch"
  | "web-search"
  | "memory"
  // Execution. Consecutive ones fold into one "Ran N commands" row.
  | "command"
  | "shell-session"
  | "script"
  // A watch left running in the background (Claude Code's `Monitor`): drawn
  // like a command, never folded with them — it reports on its own schedule.
  | "monitor"
  // A sandbox's request to reach a host (Claude Code's
  // `SandboxNetworkAccess`): a question to the user, not a call that runs.
  | "network"
  // Changes to files.
  | "edit"
  // Anything else that is just a call with arguments and a result.
  | "mcp"
  | "generic"
  | "skill"
  | "todo"
  // Calls with lifecycles or interactive records of their own.
  | "agent"
  | "collab-agent"
  | "delegation"
  | "delegation-status"
  | "delegation-cancel"
  | "delegation-resume"
  | "goal"
  | "plan-mode"
  | "question"
  | "feedback"
  | "workbench"
  | "compaction"
  | "completion"

export const EXPLORE_KINDS: ReadonlySet<ToolStepKind> = new Set([
  "read",
  "search",
  "glob",
  "list",
  "fetch",
  "web-search",
  "memory",
])

export const COMMAND_KINDS: ReadonlySet<ToolStepKind> = new Set([
  "command",
  "shell-session",
  "script",
])

/** The figure in a row's right-hand column. */
export type ToolMetric =
  | { kind: "lines"; count: number }
  | { kind: "matches"; count: number; files: number }
  | { kind: "files"; count: number }
  | { kind: "results"; count: number }
  | { kind: "noMatch" }
  | { kind: "diff"; additions: number; deletions: number }

/** Argument details a row names beside its target (localized there). */
export type ToolNote =
  | { kind: "allowLarge" }
  | { kind: "pages"; value: string }
  | { kind: "offset"; value: number }

export interface CommandInfo {
  /** The command with shell wrappers removed, all lines. */
  display: string
  lineCount: number
  heredoc: HeredocCommand | null
  /** The agent's own one-line description of the command (Claude Code). */
  description: string | null
  /** Set for codex's `wait` / `write_stdin`, which address a running shell. */
  session: {
    verb: "wait" | "terminate" | "stdin"
    sessionId: string | null
    stdin: string | null
  } | null
  /** Wall time the agent reported, in milliseconds. */
  durationMs: number | null
  /** The background shell session the command's own output announced
   *  (`SESSION_ID=…`), which later `wait` calls address by id. */
  announcedSession: string | null
  /** A monitor watching a WebSocket rather than a command's output:
   *  `display` is then the socket's URL, not a command line. */
  websocket?: boolean
}

export interface ToolTarget {
  /** What the row shows. */
  text: string
  /** The untruncated value, for a tooltip when `text` was shortened. */
  full?: string
  /** A file path the row can open. */
  path?: string
}

export interface ToolDescriptor {
  kind: ToolStepKind
  /** Normalized tool name (`normalizeToolName`). */
  toolName: string
  status: StepStatus
  /** What the call acted on: a path, a pattern, a URL, a skill name… */
  target: ToolTarget | null
  /** Muted text after the target. */
  detail: string | null
  notes: ToolNote[]
  metric: ToolMetric | null
  /** A command's non-zero exit status, when the result reported one: a
   *  failure's, or one that answers the command's question (`exitMeaning`). */
  exit: CommandExit | null
  /** What that exit says: an answer — a search that matched nothing, a test
   *  that came out false; the command succeeded — or a failure the code
   *  names (`exit-meaning.ts`). */
  exitMeaning: ExitMeaning | null
  command: CommandInfo | null
  files: EditFileChange[] | null
  mcp: McpIdentity | null
  /** A command whose process was moved to the background, or a monitor's
   *  background task, by the id the agent gave it. */
  background: { taskId: string | null } | null
  /** How the call's permission request was answered, when a reopened
   *  conversation's detail load stamped it on the call. The live record of the
   *  connection that ran it is merged in at render (`useLiveToolStep`). */
  approval: ToolApproval | null
}

export type ReasoningPart = Extract<AdaptedContentPart, { type: "reasoning" }>
export type ToolResultPart = Extract<
  AdaptedContentPart,
  { type: "tool-result" }
>
/** Answer-shaped parts that landed between steps: prose, a proposed plan, a
 *  turn error. They stay where they were written, as notes. */
export type NotePart = Extract<
  AdaptedContentPart,
  { type: "text" } | { type: "proposed-plan" } | { type: "turn-error" }
>

export type ActivityStep =
  | {
      type: "tool"
      key: string
      part: AdaptedToolCallPart
      tool: ToolDescriptor
      /** A delegation's `get_delegation_status` polls about its task, which
       *  came after it — drawn as rows of their own, but the newest says how
       *  the delegation stands now. */
      laterPolls?: AdaptedToolCallPart[]
    }
  | {
      type: "thought"
      key: string
      part: ReasoningPart
      title: string | null
      streaming: boolean
    }
  | { type: "note"; key: string; part: NotePart }
  | { type: "image"; key: string; part: AdaptedGeneratedImagePart }
  | { type: "plan"; key: string; part: AdaptedPlanPart }
  | {
      type: "delegation-polls"
      key: string
      polls: AdaptedToolCallPart[]
      status: StepStatus
    }
  | {
      type: "background-tasks"
      key: string
      polls: AdaptedToolCallPart[]
      status: StepStatus
      /** The commands that started these tasks, by task id — earlier steps of
       *  the same reply whose output announced the launch. */
      launches: Readonly<Record<string, BackgroundLaunch>>
    }
  | {
      type: "goal"
      key: string
      part: AdaptedGoalRunPart
      /** The run's own steps, built like a turn's. */
      model: ActivityModel
    }
  | { type: "tool-result"; key: string; part: ToolResultPart }

/** A command that moved its process to the background, as the task's row
 *  names it ("Regenerate audit report"). */
export interface BackgroundLaunch {
  stepKey: string
  command: string
  description: string | null
}

export type GroupKind = "explore" | "command"

export type ActivityItem =
  | { type: "step"; key: string; step: ActivityStep }
  | {
      type: "group"
      key: string
      kind: GroupKind
      /** The run's calls, in order. */
      steps: Extract<ActivityStep, { type: "tool" }>[]
      status: StepStatus
    }

export interface ActivityCounts {
  commands: number
  editedFiles: number
  agents: number
  mcp: number
  web: number
  readFiles: number
  searches: number
}

export interface ActivitySummary {
  /** Tool-like steps: calls, sub-agents, delegations, finished background
   *  tasks. Thoughts, notes, plans and compactions do not count. */
  steps: number
  counts: ActivityCounts
  failed: number
  /** Failures no later step redid successfully. */
  unrecovered: number
  interrupted: number
  running: boolean
  /** Key of the first unrecovered failure, for "jump to failure". */
  firstUnrecoveredKey: string | null
  /** Keys of failed steps a later step recovered. */
  recoveredKeys: ReadonlySet<string>
}

export interface ActivityModel {
  /** Every process step, in order. */
  steps: ActivityStep[]
  /** The steps with explore / command runs folded into groups. */
  items: ActivityItem[]
  /** The reply's trailing answer — rendered after the timeline, unfolded. */
  answer: AdaptedContentPart[]
  summary: ActivitySummary
}
