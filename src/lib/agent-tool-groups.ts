import {
  Bubbles,
  CalendarClock,
  Code2,
  Globe,
  HelpCircle,
  ListTodo,
  MessageSquare,
  MessageSquarePlus,
  type LucideIcon,
} from "lucide-react"

/**
 * How codeg's own tool groups are named and drawn, in one table.
 *
 * Two surfaces render this list: the codeg-mcp popover in the bottom-right of
 * the workspace (`components/layout/status-bar-mcp.tsx`) and the "tools an
 * agent may use" panel in Collaboration settings
 * (`components/settings/agent-tools-settings.tsx`). They used to hold a table
 * each, in two message namespaces, and had drifted into calling three of the
 * same switches by different names — which reads as three switches that are
 * not the same switch. One table, one namespace: the drift is not a bug to fix
 * again, it is a shape that cannot happen.
 *
 * The keys are the slugs the backend reports in `tool_groups` (and the
 * `--features` slugs the companion parses), so a group added backend-first
 * shows up with its raw slug rather than throwing.
 *
 * Message keys are written out in full because next-intl only resolves
 * literal keys — a computed `` t(`${slug}.label`) `` compiles but is not
 * checked, and an unchecked key is one rename away from a missing-message
 * error in ten languages at once.
 */
/** The `AgentTools.*` sub-objects, one per switch. Not the backend slugs —
 *  `browser_eval` is `browserEval` here, because message keys are camelCase
 *  everywhere else in this app. */
type AgentToolCopy =
  | "delegation"
  | "feedback"
  | "ask"
  | "sessions"
  | "browser"
  | "browserEval"
  | "automations"
  | "taskboard"

/** Spelled as a union of literal keys rather than `string`, because that is
 *  what `useTranslations` checks against: a widened `string` compiles here
 *  and fails at every call site. */
type AgentToolMessageKey = `${AgentToolCopy}.${"label" | "short" | "hint"}`

export interface AgentToolGroupPresentation {
  /** The switch's name. Both surfaces show this one. */
  label: AgentToolMessageKey
  /** One line, for the popover's dense list. */
  short: AgentToolMessageKey
  /** A paragraph, for the settings panel: what it allows, what it does not,
   *  and what stays the user's decision afterwards. */
  hint: AgentToolMessageKey
  icon: LucideIcon
  /** The slug this one lives inside, when it lives inside one. Shown off and
   *  not touchable until its parent is on, in both surfaces. The backend
   *  sends the same relation on the wire (`CodegMcpToolGroup.requires`); this
   *  is the copy for the settings panel, which reads the switches from their
   *  own endpoints rather than from the status report. */
  requires?: string
}

export const AGENT_TOOL_GROUPS: Record<
  string,
  AgentToolGroupPresentation | undefined
> = {
  delegation: {
    label: "delegation.label",
    short: "delegation.short",
    hint: "delegation.hint",
    icon: Bubbles,
  },
  feedback: {
    label: "feedback.label",
    short: "feedback.short",
    hint: "feedback.hint",
    icon: MessageSquarePlus,
  },
  ask: {
    label: "ask.label",
    short: "ask.short",
    hint: "ask.hint",
    icon: HelpCircle,
  },
  sessions: {
    label: "sessions.label",
    short: "sessions.short",
    hint: "sessions.hint",
    icon: MessageSquare,
  },
  browser: {
    label: "browser.label",
    short: "browser.short",
    hint: "browser.hint",
    icon: Globe,
  },
  // Not "more browser": the group above decides whether an agent may see and
  // drive the browser, this one whether it may run its own code in it. Even
  // on, every snippet is shown to the user and approved on its own.
  browser_eval: {
    label: "browserEval.label",
    short: "browserEval.short",
    hint: "browserEval.hint",
    icon: Code2,
    requires: "browser",
  },
  automations: {
    label: "automations.label",
    short: "automations.short",
    hint: "automations.hint",
    icon: CalendarClock,
  },
  taskboard: {
    label: "taskboard.label",
    short: "taskboard.short",
    hint: "taskboard.hint",
    icon: ListTodo,
  },
}

/** The i18n namespace every key above lives in. */
export const AGENT_TOOLS_NAMESPACE = "AgentTools"
