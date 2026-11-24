/**
 * How an assistant's definition reads in its detail: its tools by what they
 * let it touch, its colour, its other settings, and the file its definition
 * is. No React, and nothing here trusts the catalog to be complete or current.
 */
import { oneOf } from "./display"
import { isFileHash } from "./item-ref"
import type {
  HarnessAccess,
  HarnessAssistantInfo,
  HarnessFileEntry,
  HarnessItemDetail,
} from "./types"

/** What a tool lets an assistant touch, in the four groups the website shows:
 *  reading files, changing them, running commands, reaching the web. */
export const TOOL_GROUPS = ["read", "edit", "run", "web"] as const

export type ToolGroup = (typeof TOOL_GROUPS)[number]

/**
 * The tools of each group: Claude Code's names today first, then names that
 * collections still use though it has since dropped or renamed them. The same
 * lists the catalog decides an assistant's `access` with, so the groups here
 * and its four answers agree.
 */
const GROUP_TOOLS: Record<
  ToolGroup,
  { now: readonly string[]; also: readonly string[] }
> = {
  read: { now: ["Read", "Grep", "Glob"], also: ["LS", "NotebookRead", "LSP"] },
  edit: { now: ["Write", "Edit", "NotebookEdit"], also: ["MultiEdit"] },
  run: {
    now: ["Bash", "PowerShell"],
    also: ["BashOutput", "KillShell", "KillBash", "Monitor"],
  },
  web: { now: ["WebFetch", "WebSearch"], also: [] },
}

/** A tool by its name, without the pattern some carry: `Bash(git diff:*)`
 *  is Bash. */
export function toolName(tool: string): string {
  return tool.replace(/\(.*$/s, "").trim()
}

/** The group a tool belongs to, or `null` for any other tool — an MCP
 *  server's, a task list, a newer tool this build has not heard of. */
export function toolGroup(tool: string): ToolGroup | null {
  const name = toolName(tool)
  return (
    TOOL_GROUPS.find(
      (group) =>
        GROUP_TOOLS[group].now.includes(name) ||
        GROUP_TOOLS[group].also.includes(name)
    ) ?? null
  )
}

export type GroupedTools = Record<ToolGroup | "other", string[]>

/** The tools a definition lists, sorted into the four groups and the rest,
 *  each in the order the definition lists them. */
export function groupTools(tools: readonly string[]): GroupedTools {
  const grouped: GroupedTools = {
    read: [],
    edit: [],
    run: [],
    web: [],
    other: [],
  }
  for (const tool of tools) grouped[toolGroup(tool) ?? "other"].push(tool)
  return grouped
}

/**
 * What an assistant may touch, worked out from its tools (`null`: not
 * limited) less the ones it is denied — for a catalog that did not say. A
 * pattern in the denied list (`Bash(rm:*)`) takes away part of a tool, not
 * the tool.
 */
export function accessOf(
  tools: readonly string[] | null,
  disallowed: readonly string[]
): HarnessAccess {
  const denied = new Set(
    disallowed.filter((tool) => !tool.includes("(")).map(toolName)
  )
  const has = (group: ToolGroup) => {
    const { now, also } = GROUP_TOOLS[group]
    if (tools === null) return now.some((tool) => !denied.has(tool))
    return tools.some((tool) => {
      const name = toolName(tool)
      return (now.includes(name) || also.includes(name)) && !denied.has(name)
    })
  }
  return {
    read: has("read"),
    edit: has("edit"),
    run: has("run"),
    web: has("web"),
    all: tools === null && disallowed.length === 0,
  }
}

/** Claude Code's eight colours for subagents: what the catalog maps the
 *  colour a definition names to. */
export const ASSISTANT_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const

export type AssistantColor = (typeof ASSISTANT_COLORS)[number]

/** The colour, if it is one of the eight; anything else is shown as none. */
export function assistantColor(value: unknown): AssistantColor | null {
  return oneOf(ASSISTANT_COLORS, value)
}

/** How long a setting's value may run before it is cut. */
const SETTING_MAX = 160

function settingText(value: unknown): string {
  let text: string
  if (typeof value === "string") {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  const chars = Array.from(text)
  return chars.length > SETTING_MAX
    ? `${chars.slice(0, SETTING_MAX).join("")}…`
    : text
}

/**
 * The rest of a definition's frontmatter, as written: a key and its value,
 * the value as JSON where it is not text, and cut where it runs long.
 */
export function settingEntries(
  settings: Record<string, unknown>
): { key: string; value: string }[] {
  return Object.entries(settings).map(([key, value]) => ({
    key,
    value: settingText(value),
  }))
}

/**
 * The starters worth offering on their own: what an example already shows as
 * the user's words is said there, with the answer it gets.
 */
export function startersOf(
  info: Pick<HarnessAssistantInfo, "starters" | "examples">
): string[] {
  const said = new Set(info.examples.map((example) => example.user.trim()))
  return info.starters.filter(
    (starter) => starter.trim() && !said.has(starter.trim())
  )
}

/**
 * Headings an assistant's instructions may open with that only repeat the
 * page's own: its title or name, alone or with "Agent", "Agent Personality"
 * or "Persona" after it — "XR Interface Architect Agent Personality" over a
 * page called "XR Interface Architect".
 */
export function repeatedHeadings(title: string, name: string): string[] {
  const words = ["agent", "agent personality", "persona", "subagent"]
  return [title, name, ...words.map((word) => `${title} ${word}`)]
}

/**
 * The file an assistant's definition is, when there is a copy to hand out:
 * named in the version's file list with a hash `harness_blob` takes, and kept
 * by Harness. `null` otherwise — in particular where the license does not let
 * Harness hand out copies (no `archive`): the files are then read at the
 * source, and there is nothing to fetch by hash.
 */
export function definitionFile(
  item: HarnessItemDetail
): HarnessFileEntry | null {
  const file = item.install.assistant?.file
  if (!file || item.install.archive === null) return null
  const entry = item.install.files.find((candidate) => candidate.path === file)
  return entry && isFileHash(entry.sha256) ? entry : null
}
