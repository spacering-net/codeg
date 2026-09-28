import { memo, useMemo, useState, type ReactNode } from "react"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import {
  classifyToolKind,
  TOOL_KIND_ORDER,
  type ToolKindLabel,
} from "@/lib/adapters/tool-kind-classifier"
import type { MessageRole, PlanEntryInfo } from "@/lib/types"
import {
  aliasToolInputKeys,
  extractClaudeCodeMetaTitle,
  extractClaudeCodeSkillName,
  normalizeToolName,
  toolCallMovedToBackground,
} from "@/lib/tool-call-normalization"
import { parseBackgroundLaunch } from "@/lib/background-task"
import { isUnsettledToolCall } from "@/lib/tool-call-lifecycle"
import { normalizePriority, normalizeStatus } from "@/lib/plan-parse"
import { isDelegateToAgentToolName } from "@/lib/delegation-card"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import {
  countUnifiedDiffLineChanges,
  estimateChangedLineStats,
} from "@/lib/line-change-stats"
import { MessageResponse } from "@/components/ai-elements/message"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolOutput,
} from "@/components/ai-elements/tool"
import { Terminal } from "@/components/ai-elements/terminal"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { JsonTreeView } from "@/components/ai-elements/json-tree"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { generateUnifiedDiff } from "@/lib/unified-diff-generator"
import { FilePathLink } from "@/components/ai-elements/link-safety"
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning"
import { AgentToolCallPart } from "./agent-tool-call"
import { AskQuestionResultCard } from "./ask-question-result-card"
import { CodegMcpToolCard } from "./codeg-mcp-tool-card"
import { ResumedDelegationCard } from "./resumed-delegation-card"
import { CollabAgentCard } from "./collab-agent-card"
import {
  ContextCompactionCard,
  isContextCompactionMeta,
} from "./context-compaction-card"
import { contextCompactionSummary } from "@/lib/context-compaction"
import { FeedbackCheckResultCard } from "./feedback-check-result-card"
import { SearchResultsOutput } from "./search-results-output"
import {
  isCodexGrepNoMatchEnvelope,
  parseCodexCommandEnvelope,
} from "@/lib/codex-command-action"
import {
  CODEX_SCRIPT_TOOL_NAME,
  parseCodexScriptCard,
  parseCodexScriptMeta,
  type CodexScriptCard,
} from "@/lib/codex-code-mode"
import {
  describeStdinChars,
  extractAnnouncedSessionId,
  isShellSessionToolName,
  parseShellSessionInput,
  WAIT_TOOL_NAME,
} from "@/lib/shell-session-tool"
import { COLLAB_AGENT_TOOL_NAME } from "@/lib/collab-tool"
import { isCodegMcpWorkbenchTool } from "@/lib/codeg-mcp-tool"
import { fsSeparator } from "@/lib/path-utils"
import { DelegatedSubThread } from "./delegated-sub-thread"
import { DelegationStatusCard } from "./delegation-status-card"
import { DelegationStatusGroupCard } from "./delegation-status-group-card"
import { BackgroundTaskCard } from "./background-task-card"
import { GeneratedImagesBlock } from "./generated-images-block"
import { GoalRunPart, GoalToolCallPart } from "./goal-tool-call"
import { PlanCard, PlanEntriesList } from "./plan-card"
import { PlanMarkdownCard, PlanModeCard } from "./plan-mode-card"
import { PlainTextWithBadges } from "./plain-text-with-badges"
import {
  FileTextIcon,
  FilePenLineIcon,
  FilePlusIcon,
  TerminalIcon,
  SearchIcon,
  GlobeIcon,
  ListTodoIcon,
  SparklesIcon,
  CircleCheckIcon,
  CompassIcon,
  MapIcon,
  MinusIcon,
  PlusIcon,
  WrenchIcon,
  ChevronRightIcon,
  BrainIcon,
  CodeIcon,
  KeyboardIcon,
  MessageCircleQuestionMarkIcon,
  TimerIcon,
  UsersIcon,
} from "lucide-react"

// ── helpers ────────────────────────────────────────────────────────────

/** Try JSON.parse; return null on failure. */
export function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** Regex-extract a JSON string value for a given key (works on truncated JSON). */
export function extractJsonField(input: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = input.match(re)
  return m?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, "\\") ?? null
}

function asObjectLike(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed.startsWith("{")) return null
  return tryParseJson(trimmed)
}

const NESTED_PAYLOAD_KEYS = ["input", "arguments", "params", "payload"]

function findStringFieldDeep(
  value: unknown,
  key: string,
  depth: number = 0
): string | null {
  if (depth > 4) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringFieldDeep(item, key, depth + 1)
      if (found) return found
    }
    return null
  }
  const obj = asObjectLike(value)
  if (!obj) return null

  const direct = obj[key]
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct
  }

  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findStringFieldDeep(obj[nestedKey], key, depth + 1)
    if (found) return found
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findStringFieldDeep(nestedValue, key, depth + 1)
    if (found) return found
  }

  return null
}

function findObjectFieldDeep(
  value: unknown,
  key: string,
  depth: number = 0
): Record<string, unknown> | null {
  if (depth > 4) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectFieldDeep(item, key, depth + 1)
      if (found) return found
    }
    return null
  }
  const obj = asObjectLike(value)
  if (!obj) return null

  const direct = asObjectLike(obj[key])
  if (direct) return direct

  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findObjectFieldDeep(obj[nestedKey], key, depth + 1)
    if (found) return found
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findObjectFieldDeep(nestedValue, key, depth + 1)
    if (found) return found
  }

  return null
}

function decodeJsonEscapedString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\")
}

function extractEditPathsFromChangesPayload(
  input: string,
  parsed: Record<string, unknown> | null
): string[] {
  const changes = findObjectFieldDeep(parsed, "changes")
  if (changes) {
    const paths = Object.keys(changes)
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
    if (paths.length > 0) return paths
  }

  const firstPathMatch = input.match(/"changes"\s*:\s*\{\s*"((?:[^"\\]|\\.)+)"/)
  if (!firstPathMatch?.[1]) return []

  return [decodeJsonEscapedString(firstPathMatch[1])]
}

function extractPathFromDiffText(
  text: string | null | undefined
): string | null {
  if (!text) return null
  const match = text.match(/^(?:---|\+\+\+)\s+([^\n]+)$/m)
  if (!match?.[1]) return null
  const raw = match[1].trim()
  if (!raw || raw === "/dev/null") return null
  return raw.replace(/^[ab]\//, "")
}

function isLikelyIdField(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    lower === "id" ||
    lower === "uuid" ||
    lower === "callid" ||
    lower === "call_id" ||
    lower === "tool_call_id" ||
    lower.endsWith("_id") ||
    lower.endsWith("id")
  )
}

/**
 * Shorten an absolute path to its last 2 segments. Agents running on Windows
 * report backslash paths (`C:\work\repo\src\a.ts`), so both separators have to
 * split — otherwise the tool title fell back to the whole path — and the
 * shortened form is rejoined with the path's own separator rather than mixing
 * the two.
 */
export function shortPath(p: string): string {
  const segments = p.split(/[\\/]/)
  if (segments.length <= 2) return p
  return segments.slice(-2).join(fsSeparator(p))
}

/** Truncate text to maxLen, appending "…" if truncated. */
export function ellipsis(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s
}

function unwrapQuotedCommand(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length < 2) return trimmed

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\")
  }

  return trimmed
}

function simplifyShellCommand(command: string): string {
  let current = command.trim()
  const wrapperRe =
    /^(?:\/usr\/bin\/env\s+)?(?:(?:\/[^\s]+\/)?(?:bash|zsh|sh))\s+-(?:l?c)\s+(.+)$/i

  // Strip nested shell wrappers like "/bin/zsh -lc bash -lc '<cmd>'".
  for (let i = 0; i < 6; i += 1) {
    const wrapped = current.match(wrapperRe)
    if (!wrapped) break
    const next = unwrapQuotedCommand(wrapped[1] ?? "").trim()
    if (!next || next === current) break
    current = next
  }

  return current
}

function extractDisplayCommandFromToolInput(
  input: string | null | undefined
): string | null {
  if (!input) return null
  const parsed = tryParseJson(input)
  const command =
    (parsed ? commandFromUnknownValue(parsed) : null) ??
    extractCommandFromUnknownInput(input)
  if (!command) return null
  const simplified = simplifyShellCommand(command).trim()
  return simplified.length > 0 ? simplified : null
}

function formatCommandPrompt(command: string): string {
  return command
    .split("\n")
    .map((line, index) => `${index === 0 ? "$" : ">"} ${line}`)
    .join("\n")
}

function buildCommandTerminalOutput(
  command: string | null,
  output: string | null,
  isStreaming: boolean = false
): string {
  if (!command) return output ?? ""
  const prompt = formatCommandPrompt(command)
  const terminalOutput = output ?? ""
  const withTrailingNewline = (text: string): string =>
    text.endsWith("\n") ? text : `${text}\n`
  if (!terminalOutput) {
    return isStreaming ? withTrailingNewline(prompt) : prompt
  }

  const lines = terminalOutput.split("\n")
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0)
  const commandFirstLine = command.split("\n")[0]?.trim() ?? ""

  if (firstNonEmptyLine) {
    const trimmedLine = firstNonEmptyLine.trim()
    const lineWithoutPrompt = trimmedLine.replace(/^\$\s*/, "")
    if (
      trimmedLine === commandFirstLine ||
      lineWithoutPrompt === commandFirstLine
    ) {
      if (isStreaming && !terminalOutput.includes("\n")) {
        return withTrailingNewline(terminalOutput)
      }
      return terminalOutput
    }
  }

  return `${prompt}\n${terminalOutput}`
}

function extractCommandFromUnknownInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "string") {
      return parsed
    }
    if (Array.isArray(parsed)) {
      const parts = parsed.filter((p): p is string => typeof p === "string")
      if (parts.length > 0) return parts.join(" ")
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>
      const direct = obj.command ?? obj.cmd ?? obj.script
      if (typeof direct === "string") {
        return direct
      }
      if (Array.isArray(direct)) {
        const parts = direct.filter((p): p is string => typeof p === "string")
        if (parts.length > 0) return parts.join(" ")
      }
    }
  } catch {
    // Non-JSON command text is handled below.
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return null
  }
  return trimmed
}

function commandFromUnknownValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item : null))
      .filter((item): item is string => item !== null && item.length > 0)
    if (parts.length > 0) {
      return parts.join(" ")
    }
    return null
  }

  if (!value || typeof value !== "object") {
    return null
  }

  const obj = value as Record<string, unknown>
  const directKeys = [
    "command",
    "cmd",
    "script",
    // Antigravity's terminal arguments — `command_line` on the executed call,
    // PascalCase `CommandLine` on the model's own envelope (the shape a
    // permission-prompt frame and the stored trajectory both carry). Ahead of
    // the argv-style keys so an envelope that has both keeps the full command
    // line. See `inferFromInput` in `tool-call-normalization.ts`.
    "command_line",
    "CommandLine",
    "args",
    "argv",
    "command_args",
  ]
  for (const key of directKeys) {
    const found = commandFromUnknownValue(obj[key])
    if (found) return found
  }

  const nestedKeys = ["input", "arguments", "params", "payload"]
  for (const key of nestedKeys) {
    const found = commandFromUnknownValue(obj[key])
    if (found) return found
  }

  return null
}

/** Get string field from parsed object */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === "string" ? v : undefined
}

/** Get number field from parsed object */
function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key]
  return typeof v === "number" ? v : undefined
}

type ApplyPatchOp = "add" | "update" | "delete" | "move"

type ApplyPatchFile = {
  op: ApplyPatchOp
  path: string
  from?: string
  to?: string
}

type LineChangeStats = {
  additions: number
  deletions: number
}

function parseApplyPatchInput(input: string): {
  files: ApplyPatchFile[]
  additions: number
  deletions: number
} {
  const files: ApplyPatchFile[] = []
  let currentFileIndex = -1
  let additions = 0
  let deletions = 0

  for (const line of input.split("\n")) {
    if (line.startsWith("*** Add File: ")) {
      files.push({ op: "add", path: line.slice(14).trim() })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      files.push({ op: "update", path: line.slice(17).trim() })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      files.push({ op: "delete", path: line.slice(17).trim() })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Move to: ")) {
      const to = line.slice(13).trim()
      if (currentFileIndex >= 0) {
        const current = files[currentFileIndex]
        files[currentFileIndex] = {
          op: "move",
          path: `${current.path} -> ${to}`,
          from: current.path,
          to,
        }
      }
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1
    }
  }

  return { files, additions, deletions }
}

function hasLineChanges(
  stats: LineChangeStats | null | undefined
): stats is LineChangeStats {
  return !!stats && (stats.additions > 0 || stats.deletions > 0)
}

function looksLikeDiffPayload(input: string): boolean {
  if (!input.trim()) return false
  const normalized = unescapeInlineEscapes(input)

  return (
    normalized.includes("*** Begin Patch") ||
    normalized.includes("*** Update File:") ||
    /^diff --git /m.test(normalized) ||
    (/^--- .+/m.test(normalized) && /^\+\+\+ .+/m.test(normalized)) ||
    /^@@ /m.test(normalized)
  )
}

function extractEditLineChangeStats(
  input: string | null | undefined
): LineChangeStats | null {
  if (!input || input.trim().length === 0) return null

  const parsed = tryParseJson(input)
  const patchInput = extractApplyPatchTextFromUnknownInput(input, parsed)
  if (patchInput) {
    const patchStats = parseApplyPatchInput(patchInput)
    const stats = {
      additions: patchStats.additions,
      deletions: patchStats.deletions,
    }
    if (hasLineChanges(stats)) return stats
  }

  if (parsed) {
    const changesPayload = extractEditChangesPayload(parsed)
    if (changesPayload.length > 0) {
      let additions = 0
      let deletions = 0

      for (const change of changesPayload) {
        if (change.unifiedDiff && change.unifiedDiff.trim().length > 0) {
          const diffStats = countUnifiedDiffLineChanges(change.unifiedDiff)
          additions += diffStats.additions
          deletions += diffStats.deletions
          continue
        }

        const estimated = estimateChangedLineStats(
          change.oldText,
          change.newText
        )
        additions += estimated.additions
        deletions += estimated.deletions
      }

      const stats = { additions, deletions }
      if (hasLineChanges(stats)) return stats
    }

    if (isCanonicalEditPayload(parsed)) {
      const oldString =
        str(parsed, "old_string") ?? str(parsed, "old_text") ?? ""
      const newString =
        str(parsed, "new_string") ?? str(parsed, "new_text") ?? ""
      const stats = estimateChangedLineStats(oldString, newString)
      if (hasLineChanges(stats)) return stats
    }

    const parsedDiff =
      findStringFieldDeep(parsed, "unified_diff") ??
      findStringFieldDeep(parsed, "unifiedDiff") ??
      findStringFieldDeep(parsed, "patch") ??
      findStringFieldDeep(parsed, "diff")
    if (parsedDiff && looksLikeDiffPayload(parsedDiff)) {
      const stats = countUnifiedDiffLineChanges(
        unescapeInlineEscapes(parsedDiff)
      )
      if (hasLineChanges(stats)) return stats
    }
  }

  if (looksLikeDiffPayload(input)) {
    const stats = countUnifiedDiffLineChanges(unescapeInlineEscapes(input))
    if (hasLineChanges(stats)) return stats
  }

  return null
}

function unescapeInlineEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
}

function extractApplyPatchTextFromUnknownInput(
  input: string,
  parsed: Record<string, unknown> | null
): string | null {
  const candidates: string[] = [input]
  const parsedCommand = parsed ? commandFromUnknownValue(parsed) : null
  if (parsedCommand) candidates.push(parsedCommand)

  const fallbackCommand = extractCommandFromUnknownInput(input)
  if (fallbackCommand) candidates.push(fallbackCommand)

  const seen = new Set<string>()

  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)

    const variants = [candidate]
    const unescaped = unescapeInlineEscapes(candidate)
    if (unescaped !== candidate) variants.push(unescaped)

    for (const variant of variants) {
      if (!variant.includes("*** Begin Patch")) continue

      const block = variant.match(
        /(\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch(?:\n|$))/m
      )?.[1]

      if (block) return block.trim()
      return variant.trim()
    }
  }

  return null
}

function parseApplyPatchFilesFromUnknownInput(
  input: string,
  parsed: Record<string, unknown> | null
): ApplyPatchFile[] {
  const patchText = extractApplyPatchTextFromUnknownInput(input, parsed)
  if (patchText) {
    const fromPatchText = parseApplyPatchInput(patchText)
    if (fromPatchText.files.length > 0) return fromPatchText.files
  }

  const direct = parseApplyPatchInput(input)
  if (direct.files.length > 0) return direct.files

  const unescaped = unescapeInlineEscapes(input)
  if (unescaped !== input) {
    const normalized = parseApplyPatchInput(unescaped)
    if (normalized.files.length > 0) return normalized.files
  }

  return []
}

function isCanonicalEditPayload(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed.file_path === "string" ||
    typeof parsed.path === "string" ||
    typeof parsed.old_string === "string" ||
    typeof parsed.new_string === "string" ||
    parsed.replace_all === true
  )
}

type EditChangePreview = {
  path: string
  oldText: string
  newText: string
  unifiedDiff?: string
}

const EDIT_CHANGE_OLD_KEYS = [
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "old",
  "previous",
  "before",
  "source",
  "original",
]

const EDIT_CHANGE_NEW_KEYS = [
  "new_string",
  "newString",
  "new_text",
  "newText",
  "new_content",
  "newContent",
  "new",
  "new_value",
  "newValue",
  "replacement",
  "after",
  "after_text",
  "afterText",
  "updated",
  "updated_text",
  "updatedText",
  "content",
  "new_source",
  "newSource",
  "text",
]

const EDIT_CHANGE_DIFF_KEYS = ["diff", "patch", "unified_diff", "unifiedDiff"]

function collectLikelyChangeStrings(value: Record<string, unknown>): string[] {
  const entries = Object.entries(value).filter(
    ([, v]) => typeof v === "string" && v.length > 0
  ) as Array<[string, string]>
  if (entries.length === 0) return []

  const preferred = entries
    .filter(([key]) =>
      /(old|new|before|after|content|text|source|replace|value)/i.test(key)
    )
    .map(([, v]) => v)

  if (preferred.length > 0) return preferred

  return entries
    .filter(
      ([key]) =>
        !/^(id|status|type|call_id|callId|source|auto_approved)$/i.test(key)
    )
    .map(([, v]) => v)
}

function firstStringField(
  value: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === "string") {
      return field
    }
  }
  return null
}

function parseEditChangeValue(
  path: string,
  value: unknown
): EditChangePreview | null {
  if (typeof value === "string") {
    return {
      path,
      oldText: "",
      newText: value,
    }
  }

  const record = asObjectLike(value)
  if (!record) return null

  const oldText =
    firstStringField(record, EDIT_CHANGE_OLD_KEYS) ??
    findStringFieldDeep(record, "old_string") ??
    findStringFieldDeep(record, "old_text") ??
    findStringFieldDeep(record, "before_text") ??
    findStringFieldDeep(record, "old") ??
    ""
  const newText =
    firstStringField(record, EDIT_CHANGE_NEW_KEYS) ??
    findStringFieldDeep(record, "new_string") ??
    findStringFieldDeep(record, "new_text") ??
    findStringFieldDeep(record, "after_text") ??
    findStringFieldDeep(record, "new") ??
    ""
  const unifiedDiff =
    firstStringField(record, EDIT_CHANGE_DIFF_KEYS) ??
    findStringFieldDeep(record, "diff") ??
    ""

  if (unifiedDiff) {
    return {
      path,
      oldText,
      newText,
      unifiedDiff,
    }
  }

  if (oldText || newText) {
    return {
      path,
      oldText,
      newText,
    }
  }

  const fallbackStrings = collectLikelyChangeStrings(record)
  if (fallbackStrings.length >= 2) {
    return {
      path,
      oldText: fallbackStrings[0],
      newText: fallbackStrings[1],
    }
  }

  if (fallbackStrings.length === 1) {
    return {
      path,
      oldText: "",
      newText: fallbackStrings[0],
    }
  }

  return {
    path,
    oldText: "",
    newText: "",
  }
}

function extractEditChangesPayload(
  parsed: Record<string, unknown>
): EditChangePreview[] {
  const changes = findObjectFieldDeep(parsed, "changes")
  if (!changes) return []

  const items: EditChangePreview[] = []
  for (const [path, value] of Object.entries(changes)) {
    const normalizedPath = path.trim()
    if (!normalizedPath) continue
    const parsedItem = parseEditChangeValue(normalizedPath, value)
    if (parsedItem) {
      items.push(parsedItem)
    }
  }

  return items
}

// ── tool icon mapping ────────────────────────────────────────────────

const ICON_CLASS = "size-4 text-muted-foreground"

function getTaskToolIcon(input: string | null): ReactNode {
  if (!input) return <ListTodoIcon className={ICON_CLASS} />
  const t = extractJsonField(input, "subagent_type")?.toLowerCase()
  if (!t) return <ListTodoIcon className={ICON_CLASS} />
  if (t.includes("explore")) return <CompassIcon className={ICON_CLASS} />
  if (t.includes("plan")) return <MapIcon className={ICON_CLASS} />
  if (t.includes("bash")) return <TerminalIcon className={ICON_CLASS} />
  return <WrenchIcon className={ICON_CLASS} />
}

function getToolIcon(
  toolName: string,
  input?: string | null
): ReactNode | undefined {
  const name = toolName.toLowerCase()
  if (name === "read" || name === "read file")
    return <FileTextIcon className={ICON_CLASS} />
  if (name === "edit") return <FilePenLineIcon className={ICON_CLASS} />
  if (name === "write" || name === "notebookedit")
    return <FilePlusIcon className={ICON_CLASS} />
  // No `powershell` arm: every caller passes the NORMALIZED name, and
  // `normalizeToolName` now aliases the Windows shells onto `bash` so the icon
  // and the card body can no longer disagree about what the call is. The raw
  // name still reaches `classifyToolKind`, which keeps its own arm.
  if (name === "bash" || name === "exec_command")
    return <TerminalIcon className={ICON_CLASS} />
  if (name === CODEX_SCRIPT_TOOL_NAME)
    return <CodeIcon className={ICON_CLASS} />
  if (isShellSessionToolName(name)) {
    // Sending keystrokes reads as input; everything else (including the 99% of
    // `write_stdin` calls that send nothing) is a poll on a running session.
    const chars = parseShellSessionInput(input ?? null)?.chars
    return chars ? (
      <KeyboardIcon className={ICON_CLASS} />
    ) : (
      <TimerIcon className={ICON_CLASS} />
    )
  }
  if (name === "apply_patch") return <FilePenLineIcon className={ICON_CLASS} />
  // pi spells its glob tool `find` and its directory listing `ls`.
  if (name === "glob" || name === "grep" || name === "find" || name === "ls")
    return <SearchIcon className={ICON_CLASS} />
  if (name === "memory_recall") return <BrainIcon className={ICON_CLASS} />
  if (name === "webfetch" || name === "websearch")
    return <GlobeIcon className={ICON_CLASS} />
  if (name === "todowrite") return <ListTodoIcon className={ICON_CLASS} />
  if (name === "task") return getTaskToolIcon(input ?? null)
  if (name === "taskcreate" || name === "taskupdate" || name === "tasklist")
    return <ListTodoIcon className={ICON_CLASS} />
  if (name === "agent") return getTaskToolIcon(input ?? null)
  if (name === COLLAB_AGENT_TOOL_NAME)
    return <UsersIcon className={ICON_CLASS} />
  if (name === "skill") return <SparklesIcon className={ICON_CLASS} />
  if (
    name === "enterplanmode" ||
    name === "exitplanmode" ||
    name === "switch_mode" ||
    name === "plan_review"
  )
    return <ListTodoIcon className={ICON_CLASS} />
  if (name === "attempt_completion")
    return <CircleCheckIcon className={ICON_CLASS} />
  if (name === "question")
    return <MessageCircleQuestionMarkIcon className={ICON_CLASS} />
  return undefined
}

// ── title derivation ──────────────────────────────────────────────────

function deriveToolTitle(
  toolName: string,
  input: string | null,
  output?: string | null
): string | null {
  const name = toolName.toLowerCase()
  const titleSource = input ?? output ?? null
  if (!titleSource) return null
  const parsedInput = input ? tryParseJson(input) : null
  const parsedOutput = output ? tryParseJson(output) : null
  const parsed = parsedInput ?? parsedOutput

  const getField = (key: string): string | null => {
    const nested = findStringFieldDeep(parsed, key)
    if (nested) return nested
    if (input) {
      const fromInput = extractJsonField(input, key)
      if (fromInput) return fromInput
    }
    if (output) {
      const fromOutput = extractJsonField(output, key)
      if (fromOutput) return fromOutput
    }
    return null
  }

  // Cline: attempt_completion — show result summary as title
  if (name === "attempt_completion") {
    const result = getField("result")
    if (result) {
      const firstLine = result.split("\n")[0].trim()
      return `${ellipsis(firstLine, 80)}`
    }
    return "Completion"
  }

  // File-based tools
  const filePath =
    getField("file_path") ??
    getField("filePath") ??
    getField("target_file") ??
    getField("targetFile") ??
    getField("filename") ??
    getField("path") ??
    getField("notebook_path")
  if (filePath) {
    const sp = shortPath(filePath)
    if (name === "read" || name === "read file") return `Read ${sp}`
    if (name === "edit") return `Edit ${sp}`
    if (name === "write") return `Write ${sp}`
    if (name === "notebookedit") return `NotebookEdit ${sp}`
  }

  // Codex code-mode script that could not be decomposed: title from the first
  // command the parser could read, else a plain "Script" label.
  if (name === CODEX_SCRIPT_TOOL_NAME) {
    const card = parseCodexScriptCard(input)
    if (card?.title) {
      return ellipsis(simplifyShellCommand(card.title).split("\n")[0], 80)
    }
    return "Script"
  }

  // codex unified-exec session tools: neither carries a command, so the bash
  // branch below came up empty and the header fell back to the bare tool name
  // ("wait" / "bash"). Title them by the command whose session they address —
  // resolved by the history parser, see `shell-session-tool.ts`.
  if (isShellSessionToolName(name)) {
    const call = parseShellSessionInput(input)
    if (call) {
      if (call.chars) return `Stdin ${describeStdinChars(call.chars)}`
      const verb =
        name === WAIT_TOOL_NAME && call.terminate ? "Terminate" : "Wait"
      if (call.command) {
        return ellipsis(
          `${verb} ${simplifyShellCommand(call.command).split("\n")[0]}`,
          80
        )
      }
      if (call.sessionId) return `${verb} cell ${call.sessionId}`
    }
    return null
  }

  // Command tools
  if (name === "bash" || name === "exec_command") {
    const description = getField("description")
    if (description) {
      return ellipsis(description, 80)
    }
    const direct = getField("command") ?? getField("cmd") ?? getField("script")
    const parsedCommand = commandFromUnknownValue(parsed)
    const fallback = extractCommandFromUnknownInput(titleSource)
    const command = direct ?? parsedCommand ?? fallback
    if (command) {
      return ellipsis(simplifyShellCommand(command).split("\n")[0], 80)
    }
    return null
  }

  if (name === "apply_patch") {
    const files = parseApplyPatchFilesFromUnknownInput(titleSource, parsed)
    if (files.length === 0) return "Edit"
    if (files.length === 1) {
      const file = files[0]
      const targetPath =
        file.op === "move" && file.to
          ? file.to
          : (file.from ?? file.to ?? file.path)
      return `Edit ${shortPath(targetPath)}`
    }
    return `Edit (${files.length} files)`
  }

  if (name === "edit") {
    const patchFiles = parseApplyPatchFilesFromUnknownInput(titleSource, parsed)
    if (patchFiles.length === 1) {
      const file = patchFiles[0]
      const targetPath =
        file.op === "move" && file.to
          ? file.to
          : (file.from ?? file.to ?? file.path)
      return `Edit ${shortPath(targetPath)}`
    }
    if (patchFiles.length > 1) return `Edit (${patchFiles.length} files)`

    const changedPaths = extractEditPathsFromChangesPayload(titleSource, parsed)
    if (changedPaths.length === 1) return `Edit ${shortPath(changedPaths[0])}`
    if (changedPaths.length > 1) return `Edit (${changedPaths.length} files)`

    const diffPath = extractPathFromDiffText(output)
    if (diffPath) return `Edit ${shortPath(diffPath)}`
    return "Edit"
  }

  // Command-like fallback: if input looks like a shell command payload,
  // keep title behavior consistent with historical command tool rendering.
  const commandLike =
    (parsed ? commandFromUnknownValue(parsed) : null) ??
    extractCommandFromUnknownInput(titleSource)
  if (commandLike && commandLike.trim().length > 0) {
    return ellipsis(simplifyShellCommand(commandLike).split("\n")[0], 80)
  }

  // Search tools. The path fallbacks cover pattern-less listings — Cline's
  // `list_files` and codex's `listFiles` / path-only `search` command actions all
  // classify as glob/grep but carry a scope path instead of a pattern.
  if (name === "glob") {
    const p = getField("pattern")
    if (p) return `Glob ${p}`
    const path = getField("path")
    if (path) return `List files ${ellipsis(path, 50)}`
  }
  if (name === "grep") {
    const p = getField("pattern")
    if (p) return `Grep ${ellipsis(p, 50)}`
    const path = getField("path")
    if (path) return `Grep ${ellipsis(path, 50)}`
  }

  // Task / agent tools
  if (name === "task") {
    const subagent = getField("subagent_type")
    const desc = getField("description")
    const prefix = subagent ? `${subagent}: ` : ""
    if (desc) return `${prefix}${ellipsis(desc, 60 - prefix.length)}`
    if (subagent) return subagent
  }
  if (name === "agent") {
    const subagent = getField("subagent_type")
    const desc = getField("description")
    const prefix = subagent ? `${subagent}: ` : ""
    if (desc) return `${prefix}${ellipsis(desc, 60 - prefix.length)}`
    if (subagent) return subagent
  }
  if (name === "taskcreate") {
    const subj = getField("subject")
    if (subj) return `TaskCreate: ${ellipsis(subj, 50)}`
  }
  if (name === "taskupdate") {
    const id = getField("taskId")
    const status = getField("status")
    if (id) return `TaskUpdate #${id}${status ? ` → ${status}` : ""}`
  }

  // Web tools
  if (name === "webfetch") {
    const url = getField("url")
    if (url) return `WebFetch ${ellipsis(url, 60)}`
  }
  if (name === "websearch") {
    const q = getField("query")
    if (q) return `WebSearch: ${ellipsis(q, 50)}`
  }

  // TodoWrite
  if (name === "todowrite") {
    if (parsed) {
      const todos = parsed.todos
      if (Array.isArray(todos)) {
        const count = todos.length
        const done = todos.filter(
          (t: Record<string, unknown>) => t.status === "completed"
        ).length
        return `Todos (${done}/${count})`
      }
    }
    return "TodoWrite"
  }

  // Skill. OpenCode's native `skill` tool takes `{name}`; the other hosts pass
  // `{skill}`, so accept either rather than falling through to a title-less
  // generic card.
  if (name === "skill") {
    const sk = getField("skill") ?? getField("name")
    if (sk) return `Skill: ${sk}`
  }

  // EnterPlanMode / ExitPlanMode / SwitchMode / codex plan_review
  if (
    name === "enterplanmode" ||
    name === "exitplanmode" ||
    name === "switch_mode" ||
    name === "plan_review"
  ) {
    const plan = getField("plan")
    if (plan) {
      const firstLine = plan
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .find((l) => l.length > 0)
      if (firstLine) return `Plan · ${ellipsis(firstLine, 60)}`
    }
    const title = getField("title")
    if (title) return `Plan · ${title}`
    return "Plan"
  }

  // Generic: try to show the first string field as context
  if (parsed) {
    for (const [k, v] of Object.entries(parsed)) {
      if (isLikelyIdField(k)) {
        continue
      }
      if (typeof v === "string" && v.length > 0) {
        return `${toolName}: ${ellipsis(v, 50)}`
      }
    }
  }

  return null
}

function sanitizeLiveTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim()
  if (!trimmed) return null

  const callIdTitle = trimmed.match(
    /^[:：'"`“”‘’\s]*([a-z0-9_.-]+)(?:\s*[:：])?\s*call[\w-]*['"`“”‘’\s]*$/i
  )
  const source = callIdTitle?.[1] ?? trimmed
  const normalized = normalizeToolName(source)
  if (normalized === "apply_patch" || normalized === "edit") {
    return "Edit"
  }
  if (
    /\b(?:functions\.)?(?:edit|apply[_\s-]?patch)\b/i.test(trimmed) &&
    /\bcall[\w-]*\b/i.test(trimmed)
  ) {
    return "Edit"
  }
  if (normalized === "bash" || normalized === "exec_command") {
    return "Command"
  }
  return trimmed
}

function localizeDerivedToolTitle(
  title: string | null,
  t: (key: string, values?: Record<string, unknown>) => string
): string | null {
  if (!title) return null

  if (title === "Edit") return t("title.edit")
  if (title === "Command") return t("title.command")
  if (title === "Script") return t("title.script")
  if (title === "TodoWrite") return t("title.todoWrite")
  if (title === "Read") return t("title.read")
  if (title === "Write") return t("title.write")
  if (title === "NotebookEdit") return t("title.notebookEdit")

  const editFilesMatch = title.match(/^Edit \((\d+) files\)$/)
  if (editFilesMatch) {
    return t("title.editFiles", { count: Number(editFilesMatch[1]) })
  }

  const editWithTarget = title.match(/^Edit (.+)$/)
  if (editWithTarget) {
    return t("title.editWithTarget", { target: editWithTarget[1] })
  }

  const readWithTarget = title.match(/^Read (.+)$/)
  if (readWithTarget) {
    return t("title.readWithTarget", { target: readWithTarget[1] })
  }

  const writeWithTarget = title.match(/^Write (.+)$/)
  if (writeWithTarget) {
    return t("title.writeWithTarget", { target: writeWithTarget[1] })
  }

  const notebookEditWithTarget = title.match(/^NotebookEdit (.+)$/)
  if (notebookEditWithTarget) {
    return t("title.notebookEditWithTarget", {
      target: notebookEditWithTarget[1],
    })
  }

  // codex session tools. The `cell` forms must be tried first: they are the
  // fallback shape for an unresolved session id, and `^Wait (.+)$` would eat
  // them.
  const waitCell = title.match(/^Wait cell (\d+)$/)
  if (waitCell) return t("title.waitCell", { id: waitCell[1] })

  const waitCommand = title.match(/^Wait (.+)$/)
  if (waitCommand) return t("title.waitCommand", { command: waitCommand[1] })

  const terminateCell = title.match(/^Terminate cell (\d+)$/)
  if (terminateCell) return t("title.terminateCell", { id: terminateCell[1] })

  const terminateCommand = title.match(/^Terminate (.+)$/)
  if (terminateCommand) {
    return t("title.terminateCommand", { command: terminateCommand[1] })
  }

  const stdinChars = title.match(/^Stdin (.+)$/)
  if (stdinChars) return t("title.stdinChars", { chars: stdinChars[1] })

  const globWithPattern = title.match(/^Glob (.+)$/)
  if (globWithPattern) {
    return t("title.globWithPattern", { pattern: globWithPattern[1] })
  }

  const listFilesWithPath = title.match(/^List files (.+)$/)
  if (listFilesWithPath) {
    return t("title.listFilesWithPath", { path: listFilesWithPath[1] })
  }

  const grepWithPattern = title.match(/^Grep (.+)$/)
  if (grepWithPattern) {
    return t("title.grepWithPattern", { pattern: grepWithPattern[1] })
  }

  const taskCreateWithSubject = title.match(/^TaskCreate: (.+)$/)
  if (taskCreateWithSubject) {
    return t("title.taskCreateWithSubject", {
      subject: taskCreateWithSubject[1],
    })
  }

  const taskUpdateWithStatus = title.match(/^TaskUpdate #([^ ]+)(?: → (.+))?$/)
  if (taskUpdateWithStatus) {
    const id = taskUpdateWithStatus[1]
    const status = taskUpdateWithStatus[2]
    if (status) {
      return t("title.taskUpdateWithStatus", { id, status })
    }
    return t("title.taskUpdate", { id })
  }

  const webFetchWithUrl = title.match(/^WebFetch (.+)$/)
  if (webFetchWithUrl) {
    return t("title.webFetchWithUrl", { url: webFetchWithUrl[1] })
  }

  const webSearchWithQuery = title.match(/^WebSearch: (.+)$/)
  if (webSearchWithQuery) {
    return t("title.webSearchWithQuery", { query: webSearchWithQuery[1] })
  }

  const todosProgress = title.match(/^Todos \((\d+)\/(\d+)\)$/)
  if (todosProgress) {
    return t("title.todosProgress", {
      done: Number(todosProgress[1]),
      total: Number(todosProgress[2]),
    })
  }

  const skillWithName = title.match(/^Skill: (.+)$/)
  if (skillWithName) {
    return t("title.skillWithName", { name: skillWithName[1] })
  }

  const genericWithContext = title.match(/^([^:]+): (.+)$/)
  if (genericWithContext) {
    return t("title.genericWithContext", {
      tool: genericWithContext[1],
      context: genericWithContext[2],
    })
  }

  return title
}

// ── Specialized tool input renderers ─────────────────────────────────

/** Edit tool: file path + unified diff view */
function EditToolInput({ input }: { input: Record<string, unknown> }) {
  const filePath = str(input, "file_path")
  const oldString = str(input, "old_string") ?? ""
  const newString = str(input, "new_string") ?? ""
  const startLine = num(input, "_start_line")

  const diffCode = useMemo(() => {
    const diff = generateUnifiedDiff(
      oldString,
      newString,
      filePath ?? undefined
    )
    if (!diff || !startLine || startLine <= 1) return diff ?? ""
    // Replace line numbers in hunk headers with real start line
    return diff.replace(
      /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/gm,
      (_, _o, oc, _n, nc) => `@@ -${startLine},${oc} +${startLine},${nc} @@`
    )
  }, [oldString, newString, filePath, startLine])

  return diffCode ? (
    <UnifiedDiffPreview diffText={diffCode} clickableFilePath />
  ) : null
}

/** Edit tool (changes payload): combined diff view */
function EditChangesToolInput({ changes }: { changes: EditChangePreview[] }) {
  const diffCode = useMemo(() => {
    const diffParts: string[] = []

    for (const change of changes) {
      if (change.unifiedDiff && change.unifiedDiff.trim().length > 0) {
        diffParts.push(change.unifiedDiff.trim())
        diffParts.push("")
        continue
      }

      const generated = generateUnifiedDiff(
        change.oldText,
        change.newText,
        change.path
      )
      if (generated) {
        diffParts.push(generated)
        diffParts.push("")
      }
    }

    return diffParts.join("\n").trim()
  }, [changes])

  return diffCode ? (
    <UnifiedDiffPreview diffText={diffCode} clickableFilePath />
  ) : null
}

/** Bash / exec_command: terminal-style command display */
function BashToolInput({ input }: { input: Record<string, unknown> }) {
  const t = useTranslations("Folder.chat.contentParts")
  const command =
    commandFromUnknownValue(input) ??
    str(input, "command") ??
    str(input, "cmd") ??
    str(input, "script")
  const description = str(input, "description")
  const timeout = num(input, "timeout")
  const background = input.run_in_background === true
  const displayCommand = command ? simplifyShellCommand(command) : null

  return (
    <div className="space-y-2">
      {description && (
        <div className="flex items-center gap-2 text-xs">
          <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{description}</span>
        </div>
      )}
      {displayCommand && <CodeBlock code={displayCommand} language="bash" />}
      {(timeout || background) && (
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {timeout && <span>{t("timeoutMs", { timeout })}</span>}
          {background && <span>{t("backgroundTrue")}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Parse structured read output from backend: `{"start_line":N,"content":"..."}`.
 * Falls back to raw text with startLine=1 if not structured.
 */
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

/** Lightweight file content viewer with line numbers */
function FileContentLines({
  content,
  startLine = 1,
  highlight,
}: {
  content: string
  startLine?: number
  /** "added" tints every line green to indicate new content (e.g. Write tool). */
  highlight?: "added"
}) {
  const lines = useMemo(() => content.split("\n"), [content])
  const rowClass =
    highlight === "added"
      ? "flex bg-green-500/10 text-green-900 dark:text-green-300"
      : "flex"

  return (
    <div className="inline-block min-w-full font-mono text-xs leading-[1.25rem]">
      {lines.map((line, i) => (
        <div key={i} className={rowClass}>
          <span className="w-[3.5rem] shrink-0 select-none pr-1 text-right text-muted-foreground/40">
            {startLine + i}
          </span>
          <span className="flex-1 whitespace-pre pr-3">{line}</span>
        </div>
      ))}
    </div>
  )
}

/** Read / Write / NotebookEdit: file-focused display */
function FileToolInput({
  toolName,
  input,
  output,
}: {
  toolName: string
  input: Record<string, unknown>
  output?: string | null
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const name = toolName.toLowerCase()
  const filePath =
    str(input, "file_path") ?? str(input, "path") ?? str(input, "notebook_path")
  const content = str(input, "content")
  const newSource = str(input, "new_source")
  const offset = num(input, "offset")
  const limit = num(input, "limit")
  const pages = str(input, "pages")
  const cellType = str(input, "cell_type")
  const editMode = str(input, "edit_mode")
  const isRead = name === "read" || name === "read file"

  const badges: string[] = []
  if (offset != null) badges.push(t("offset", { offset }))
  if (limit != null) badges.push(t("limit", { limit }))
  if (pages) badges.push(t("pages", { pages }))
  if (editMode) badges.push(t("mode", { mode: editMode }))
  if (cellType) badges.push(t("cell", { cell: cellType }))

  const { displayContent, startLine } = useMemo(() => {
    if (isRead && output) {
      const parsed = parseReadOutput(output)
      return { displayContent: parsed.content, startLine: parsed.startLine }
    }
    return {
      displayContent: content ?? newSource ?? null,
      startLine: 1,
    }
  }, [isRead, output, content, newSource])

  return (
    <section className="flex max-h-[26.25rem] flex-col rounded-lg border border-border bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-2xs">
        <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-3xs text-muted-foreground">
          {isRead ? "READ" : "WRITE"}
        </span>
        {/* No path in the input is not worth an "unknown" placeholder: the
            enclosing tool card's header already names the file (it derives the
            title from the call's `title`/`locations`, which agents fill even
            when their arguments don't). Printing "unknown" under a header that
            says `minimal/page.tsx` only reads as a bug. */}
        {filePath ? (
          <FilePathLink
            filePath={filePath}
            className="min-w-0 flex-1 font-mono text-foreground"
          >
            {filePath}
          </FilePathLink>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {badges.length > 0 && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-2 text-3xs text-muted-foreground">
            {badges.map((b) => (
              <span key={b}>{b}</span>
            ))}
          </span>
        )}
      </header>
      {displayContent && (
        <div className="overflow-auto">
          <FileContentLines
            content={displayContent}
            startLine={startLine}
            highlight={isRead ? undefined : "added"}
          />
        </div>
      )}
    </section>
  )
}

/** Glob / Grep: search-focused display */
function SearchToolInput({
  toolName,
  input,
}: {
  toolName: string
  input: Record<string, unknown>
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const name = toolName.toLowerCase()
  const pattern = str(input, "pattern")
  const path = str(input, "path")
  const glob = str(input, "glob")
  const outputMode = str(input, "output_mode")
  const fileType = str(input, "type")
  const caseInsensitive = input["-i"] === true
  const multiline = input.multiline === true

  return (
    <div className="space-y-2">
      {pattern && (
        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <code className="break-all text-xs text-foreground">{pattern}</code>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {path && (
          <span>
            {t("pathLabel")}{" "}
            <span className="font-mono text-foreground">{path}</span>
          </span>
        )}
        {glob && (
          <span>
            {t("globLabel")}{" "}
            <span className="font-mono text-foreground">{glob}</span>
          </span>
        )}
        {fileType && (
          <span>
            {t("typeLabel")}{" "}
            <span className="font-mono text-foreground">{fileType}</span>
          </span>
        )}
        {name === "grep" && outputMode && (
          <span>
            {t("outputLabel")}{" "}
            <span className="font-mono text-foreground">{outputMode}</span>
          </span>
        )}
        {caseInsensitive && <span>{t("caseInsensitive")}</span>}
        {multiline && <span>{t("multiline")}</span>}
      </div>
    </div>
  )
}

/** Web tools: URL / query focused */
function WebToolInput({
  toolName,
  input,
}: {
  toolName: string
  input: Record<string, unknown>
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const name = toolName.toLowerCase()
  const url = str(input, "url")
  const query = str(input, "query")
  const prompt = str(input, "prompt")

  return (
    <div className="space-y-2">
      {name === "websearch" && query && (
        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="break-all text-xs font-medium text-foreground">
            {query}
          </span>
        </div>
      )}
      {name === "webfetch" && url && (
        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="break-all font-mono text-xs text-foreground">
            {url}
          </span>
        </div>
      )}
      {prompt && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t("promptLabel")}
          </span>
          <div className="rounded-md bg-muted/50 p-3 text-xs prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
            <MessageResponse>{prompt}</MessageResponse>
          </div>
        </div>
      )}
    </div>
  )
}

/** Task tools: description / subject focused */
function TaskToolInput({ input }: { input: Record<string, unknown> }) {
  const t = useTranslations("Folder.chat.contentParts")
  const subject = str(input, "subject")
  const taskId = str(input, "taskId")
  const status = str(input, "status")
  const agentName = str(input, "name")

  const hasFields = subject || taskId || agentName
  if (!hasFields) return null

  return (
    <div className="space-y-2">
      {subject && (
        <div className="flex items-baseline gap-2 text-xs">
          <span className="shrink-0 font-medium text-muted-foreground">
            {t("subjectLabel")}
          </span>
          <span className="text-foreground">{subject}</span>
        </div>
      )}
      {taskId && (
        <div className="flex items-baseline gap-2 text-xs">
          <span className="shrink-0 font-medium text-muted-foreground">
            {t("taskLabel")}
          </span>
          <span className="font-mono text-foreground">
            #{taskId}
            {status ? ` → ${status}` : ""}
          </span>
        </div>
      )}
      {agentName && (
        <div className="text-xs text-muted-foreground">
          {t("nameLabel")}{" "}
          <span className="font-mono text-foreground">{agentName}</span>
        </div>
      )}
    </div>
  )
}

/**
 * TodoWrite: checklist-style display. Fallback path only — a persisted
 * TodoWrite tool_use is normally converted to a first-class `plan` part
 * (rendered by <PlanCard>) in the adapter; this renders the same checklist
 * via the shared <PlanEntriesList> when that conversion didn't run (live
 * streaming, or unparsable input). Maps raw todos to PlanEntryInfo so the
 * fallback looks identical to the dedicated card.
 */
function TodoWriteToolInput({ input }: { input: Record<string, unknown> }) {
  const todos = Array.isArray(input.todos) ? input.todos : []
  if (todos.length === 0) return null

  const entries: PlanEntryInfo[] = todos.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
    const todo = raw as Record<string, unknown>
    const content = str(todo, "content") ?? ""
    if (!content) return []
    return [
      {
        content,
        status: normalizeStatus(str(todo, "status")),
        priority: normalizePriority(str(todo, "priority")),
      },
    ]
  })

  return <PlanEntriesList entries={entries} />
}

/**
 * Codex code-mode script the history parser could not decompose into real tool
 * calls — show the JS source it ran instead of pretending it was a shell
 * command. See `lib/codex-code-mode.ts`.
 */
function CodexScriptToolInput({ card }: { card: CodexScriptCard }) {
  const t = useTranslations("Folder.chat.contentParts")
  return (
    <div className="space-y-2">
      <CodeBlock code={card.source} language="javascript" />
      {card.callCount > 0 && (
        <div className="text-xs text-muted-foreground">
          {t("scriptToolCalls", { count: card.callCount })}
        </div>
      )}
    </div>
  )
}

function ApplyPatchToolInput({ input }: { input: string }) {
  return <UnifiedDiffPreview diffText={input} clickableFilePath />
}

// ── Generic structured input (fallback) ──────────────────────────────

/** Fields that typically contain code / long text → render in code blocks */
const CODE_FIELDS = new Set([
  "command",
  "old_string",
  "new_string",
  "content",
  "new_source",
  "prompt",
])

/** Fields to hide */
const HIDDEN_FIELDS = new Set([
  "dangerouslyDisableSandbox",
  // Resolved by the history parser purely to title the card
  // (`shell-session-tool.ts`); repeating it as a parameter row would just
  // duplicate the header.
  "session_command",
])

function GenericToolInput({ input }: { input: string }) {
  const t = useTranslations("Folder.chat.contentParts")
  const parsed = useMemo(() => tryParseJson(input), [input])

  if (!parsed) {
    return (
      <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
        {input}
      </pre>
    )
  }

  const entries = Object.entries(parsed).filter(([k]) => !HIDDEN_FIELDS.has(k))

  if (entries.length === 0) return null

  return (
    <div className="space-y-3">
      {entries.map(([key, value]) => {
        const labelKey = fieldLabelKey(key)
        const label = labelKey ? t(labelKey) : key

        if (CODE_FIELDS.has(key) && typeof value === "string") {
          const lang =
            key === "command"
              ? ("bash" as const)
              : key === "prompt"
                ? ("log" as const)
                : ("log" as const)
          return (
            <FieldBlock key={key} label={label}>
              <CodeBlock code={value} language={lang} />
            </FieldBlock>
          )
        }

        if (typeof value === "string") {
          if (value.length > 200) {
            return (
              <FieldBlock key={key} label={label}>
                <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-xs">
                  {value}
                </pre>
              </FieldBlock>
            )
          }
          return <FieldInline key={key} label={label} value={value} />
        }

        if (typeof value === "number" || typeof value === "boolean") {
          return <FieldInline key={key} label={label} value={String(value)} />
        }

        if (value !== null && value !== undefined) {
          // Nested structured value on a tool with no dedicated card — same
          // unreadable-JSON-wall problem the result panel had.
          return (
            <FieldBlock key={key} label={label}>
              <JsonTreeView value={value} />
            </FieldBlock>
          )
        }

        return null
      })}
    </div>
  )
}

// ── Dispatcher ───────────────────────────────────────────────────────

function isTruncatedInput(input: string): boolean {
  return input.endsWith('..."') || input.endsWith("...")
}

function StructuredToolInput({
  toolName,
  input,
  output,
}: {
  toolName: string
  input: string
  output?: string | null
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const name = toolName.toLowerCase()
  // Every dedicated card below reads the canonical (snake_case) argument names.
  // The alias pass fills in the ones an agent spelled differently on the live
  // wire — OpenCode's camelCase `filePath`/`oldString`, which its ACP adapter
  // forwards verbatim while the history parser already rewrites them. Doing it
  // once here rather than per card keeps Write/Read/Edit/Grep in agreement.
  const parsed = useMemo(() => aliasToolInputKeys(tryParseJson(input)), [input])
  const truncated =
    (name === "edit" || name === "write" || name === "apply_patch") &&
    isTruncatedInput(input)

  const truncationBanner = truncated ? (
    <div className="rounded-md bg-yellow-500/10 px-2.5 py-1.5 text-2xs text-yellow-700 dark:text-yellow-400">
      {t("inputTruncated")}
    </div>
  ) : null

  if (name === CODEX_SCRIPT_TOOL_NAME) {
    const card = parseCodexScriptCard(input)
    if (card) return <CodexScriptToolInput card={card} />
  }

  if (name === "apply_patch") {
    const patchInput =
      extractApplyPatchTextFromUnknownInput(input, parsed) ?? input
    return (
      <>
        {truncationBanner}
        <ApplyPatchToolInput input={patchInput} />
      </>
    )
  }

  if (name === "bash" || name === "exec_command") {
    if (parsed) {
      return <BashToolInput input={parsed} />
    }
    const plainCommand = extractCommandFromUnknownInput(input)
    if (plainCommand) {
      return <BashToolInput input={{ command: plainCommand }} />
    }
  }

  if (!parsed) {
    return (
      <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
        {input}
      </pre>
    )
  }

  if (name === "edit") {
    const patchInput = extractApplyPatchTextFromUnknownInput(input, parsed)
    if (patchInput) {
      return (
        <>
          {truncationBanner}
          <ApplyPatchToolInput input={patchInput} />
        </>
      )
    }
    if (parsed) {
      const changesPayload = extractEditChangesPayload(parsed)
      if (changesPayload.length > 0) {
        return (
          <>
            {truncationBanner}
            <EditChangesToolInput changes={changesPayload} />
          </>
        )
      }
    }
    // Prefer tool output if it contains a structured diff with real line numbers
    // (injected by backend from toolUseResult.structuredPatch)
    if (output && typeof output === "string" && /^@@ /m.test(output)) {
      return (
        <>
          {truncationBanner}
          <UnifiedDiffPreview diffText={output} clickableFilePath />
        </>
      )
    }
    if (isCanonicalEditPayload(parsed)) {
      return (
        <>
          {truncationBanner}
          <EditToolInput input={parsed} />
        </>
      )
    }
    return <GenericToolInput input={input} />
  }
  if (name === "bash" || name === "exec_command")
    return <BashToolInput input={parsed} />
  if (
    name === "read" ||
    name === "read file" ||
    name === "write" ||
    name === "notebookedit"
  )
    return <FileToolInput toolName={toolName} input={parsed} output={output} />
  if (name === "glob" || name === "grep")
    return <SearchToolInput toolName={toolName} input={parsed} />
  if (name === "webfetch" || name === "websearch")
    return <WebToolInput toolName={toolName} input={parsed} />
  if (name === "todowrite") return <TodoWriteToolInput input={parsed} />
  if (
    name === "task" ||
    name === "taskcreate" ||
    name === "taskupdate" ||
    name === "tasklist"
  )
    return <TaskToolInput input={parsed} />

  return <GenericToolInput input={input} />
}

// ── Shared field components ──────────────────────────────────────────

function FieldInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="shrink-0 font-medium text-muted-foreground">
        {label}
      </span>
      <span className="break-all font-mono text-foreground">{value}</span>
    </div>
  )
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="rounded-md bg-muted/50">{children}</div>
    </div>
  )
}

const FIELD_LABEL_KEYS = {
  file_path: "field.file",
  notebook_path: "field.notebook",
  command: "field.command",
  cmd: "field.command",
  old_string: "field.old",
  new_string: "field.new",
  pattern: "field.pattern",
  path: "field.path",
  query: "field.query",
  url: "field.url",
  description: "field.description",
  content: "field.content",
  new_source: "field.source",
  prompt: "field.prompt",
  subject: "field.subject",
  taskId: "field.taskId",
  status: "field.status",
  skill: "field.skill",
  args: "field.args",
  offset: "field.offset",
  limit: "field.limit",
  glob: "field.glob",
  type: "field.type",
  output_mode: "field.output",
  replace_all: "field.replaceAll",
  language: "field.language",
  timeout: "field.timeout",
  run_in_background: "field.background",
  subagent_type: "field.agentType",
  libraryName: "field.library",
  libraryId: "field.libraryId",
} as const

function fieldLabelKey(
  key: string
): (typeof FIELD_LABEL_KEYS)[keyof typeof FIELD_LABEL_KEYS] | null {
  const translationKey = FIELD_LABEL_KEYS[key as keyof typeof FIELD_LABEL_KEYS]
  return translationKey ?? null
}

function commandOutputFromJsonString(output: string): string | null {
  try {
    const parsed: unknown = JSON.parse(output)
    if (typeof parsed === "string") {
      return parsed
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }

    const obj = parsed as Record<string, unknown>
    const isCommandEnvelope =
      "command" in obj ||
      "parsed_cmd" in obj ||
      "cwd" in obj ||
      "exit_code" in obj ||
      "stdout" in obj ||
      "stderr" in obj ||
      "formatted_output" in obj ||
      "aggregated_output" in obj
    // Prefer raw stdout/stderr when present (more likely to preserve ANSI colors).
    const stdout = typeof obj.stdout === "string" ? obj.stdout : ""
    const stderr = typeof obj.stderr === "string" ? obj.stderr : ""
    if (stdout.length > 0 || stderr.length > 0) {
      if (stdout.length > 0 && stderr.length > 0) {
        return `${stdout}\n[stderr]\n${stderr}`
      }
      return stdout || stderr
    }

    const preferredKeys = [
      "formatted_output",
      "aggregated_output",
      "output",
      "text",
      "result",
    ]
    for (const key of preferredKeys) {
      const value = obj[key]
      if (typeof value === "string" && value.length > 0) {
        return value
      }
    }

    // Some command results are metadata-only envelopes (command/cwd/exit_code).
    // Returning empty string avoids rendering raw JSON as terminal output.
    if (isCommandEnvelope) {
      return ""
    }

    return null
  } catch {
    return null
  }
}

function stripMarkdownCodeFence(text: string): string {
  let result = text
  // Remove leading fenced-code line like ```sh / ```bash / ```
  result = result.replace(/^\s*```[\w-]*\s*\n?/, "")
  // Remove trailing closing fence if present
  result = result.replace(/\n?\s*```\s*$/, "")
  return result
}

/** Regex matching metadata lines in CLI execution output envelopes. */
const CLI_META_LINE_RE =
  /^(exit code\s*[:=]|wall time\s*[:=]|chunk id\s*[:=]|original token count\s*[:=]|total output lines\s*[:=]|process exited with code\s)/i

/**
 * Parse a CLI execution envelope, stripping all metadata and the "Output:"
 * separator, returning only the actual command output and the wall time.
 *
 * Handles formats like:
 *   Chunk ID: 065b2b
 *   Wall time: 0.05s
 *   Process exited with code 0
 *   Original token count: 27006
 *   Output:
 *   Total output lines: 1134
 *   <actual output here>
 */
function parseCliExecutionEnvelope(text: string): {
  output: string
  wallTime: string | null
} {
  const lines = text.split("\n")
  let wallTime: string | null = null

  // Look for "Output:" separator and extract wall time from header
  let outputSepIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    const wtMatch = trimmed.match(/^wall time\s*:\s*(.+)/i)
    if (wtMatch) wallTime = wtMatch[1].trim()
    if (/^output:\s*$/i.test(trimmed)) {
      outputSepIndex = i
      break
    }
    // Stop scanning if we hit a non-metadata, non-blank line (actual content)
    if (!CLI_META_LINE_RE.test(trimmed) && trimmed.length > 0) break
  }

  // If "Output:" separator found, skip everything before it plus any
  // remaining metadata/blank lines after it
  if (outputSepIndex >= 0) {
    let start = outputSepIndex + 1
    while (start < lines.length) {
      const trimmed = lines[start].trim()
      if (CLI_META_LINE_RE.test(trimmed) || trimmed.length === 0) {
        start++
        continue
      }
      break
    }
    return { output: lines.slice(start).join("\n"), wallTime }
  }

  // No "Output:" separator — strip leading metadata lines
  let index = 0
  let sawMeta = false
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (CLI_META_LINE_RE.test(trimmed)) {
      sawMeta = true
      if (!wallTime) {
        const wtMatch = trimmed.match(/^wall time\s*:\s*(.+)/i)
        if (wtMatch) wallTime = wtMatch[1].trim()
      }
      index++
      continue
    }
    if (sawMeta && trimmed.length === 0) {
      index++
      continue
    }
    break
  }

  if (!sawMeta) return { output: text, wallTime: null }

  while (index < lines.length && lines[index].trim().length === 0) index++
  return { output: lines.slice(index).join("\n"), wallTime }
}

// ── Part components ───────────────────────────────────────────────────

const TextPart = memo(function TextPart({
  text,
  isUser = false,
  isStreaming = false,
}: {
  text: string
  // User messages render as plain text + inline reference badges (no Markdown),
  // matching the plain-text composer. Assistant / system text keeps full Markdown.
  isUser?: boolean
  isStreaming?: boolean
}) {
  if (isUser) {
    return (
      <div className="break-words text-sm">
        <PlainTextWithBadges text={text} />
      </div>
    )
  }
  return (
    <div className='break-words text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'>
      <MessageResponse
        mode={isStreaming ? "streaming" : "static"}
        parseIncompleteMarkdown={isStreaming}
      >
        {text}
      </MessageResponse>
    </div>
  )
})

const ToolCallPart = memo(function ToolCallPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-call" }>
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const [manualOpen, setManualOpen] = useState(false)
  const normalizedToolName = useMemo(
    () => normalizeToolName(part.toolName),
    [part.toolName]
  )
  const toolNameLower = normalizedToolName.toLowerCase()
  // codex's `wait` / `write_stdin` continue a background shell, so they share
  // the command path: same output envelope to strip, same Terminal body. What
  // they must NOT share is the `$ <command>` prompt line — the command already
  // names the card, and reprinting it would read as a re-run (see
  // `displayCommand` below).
  const isShellSessionTool = isShellSessionToolName(toolNameLower)
  const isCommandTool =
    toolNameLower === "bash" ||
    toolNameLower === "exec_command" ||
    isShellSessionTool
  const isCommandLikeTool = isCommandTool || toolNameLower === "apply_patch"
  const isSearchTool = toolNameLower === "grep" || toolNameLower === "glob"
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming"
  // A `Bash(run_in_background: true)` launch — its result is just the task id +
  // an "output is being written to …" notice. Flag the command card as a
  // background launch (header badge + concise body) instead of dumping that
  // notice; the actual run surfaces later in a <BackgroundTaskCard>.
  const backgroundLaunch = useMemo(
    () =>
      isCommandTool
        ? parseBackgroundLaunch(part.output ?? part.errorText ?? null)
        : null,
    [isCommandTool, part.output, part.errorText]
  )
  // The same statement, told a different way. codex-acp doesn't put a launch
  // notice in the output — it never completes the call at all — and says so on
  // the ACP `_meta` instead (`toolCallMovedToBackground`). Not gated on
  // `isCommandTool`: the marker is authoritative about THIS call regardless of
  // how the tool name resolved, which is what makes it safe to trust over a
  // parsed string. The live strip above the transcript owns the rest of the
  // lifecycle (and the stop button); this badge only answers "why is it still
  // spinning".
  //
  // Gated on the call being UNSETTLED, which the claude arm below is not — and
  // the asymmetry is the wire's, not a style choice. Claude's launch call
  // completes immediately (its output IS the ack), so its badge has to survive
  // a settled card; codex's stays open for the process's whole life and settles
  // only when the process dies or a stop lands. Ungated, the marker would
  // outlive its own truth: the reducer keeps the stored meta when an update
  // carries none (`meta: action.meta ?? block.info.meta`), so a settling frame
  // without `_meta` would leave "Background" pinned to a finished command.
  // `isUnsettledToolCall` rather than a bare state check, so the badge survives
  // COMPLETE_TURN promotion — that flips `state` to `output-available` while the
  // forwarded ACP status is still `in_progress`.
  //
  // The gate only fires when the settle lands INSIDE the turn (a short task) or
  // after a detail reload. A process that outlives its turn settles out-of-turn,
  // and the reducer routes an out-of-turn `tool_call_update` to
  // `outOfTurnToolCalls` rather than into the promoted turn — so the card keeps
  // both its `in_progress` status and this badge until the conversation is
  // reloaded. That is pre-existing routing, not something the marker changes,
  // and the strip above the transcript is the surface that does clear on time.
  const airBackgrounded = useMemo(
    () => toolCallMovedToBackground(part.meta) && isUnsettledToolCall(part),
    [part]
  )
  const title = useMemo(() => {
    // claude-agent-acp ≥0.63 supplies the human-readable description as
    // `_meta.claudeCode.title` (ACP `title` stays the raw command). It wins
    // over input-derived titles because it is available from frame 1 —
    // before `rawInput` streams — and is the same string `deriveToolTitle`
    // would later extract from `input.description`, so the title never
    // jitters when the input lands. Same 80-char ellipsis as the derived
    // path for identical truncation behavior.
    const metaTitle = extractClaudeCodeMetaTitle(part.meta)
    // claude-agent-acp ≥0.67 (#986): the invoked skill's name rides
    // `_meta.claudeCode.skill` — authoritative over the input-derived
    // "Skill: …" (same shape, so it flows through the same localization),
    // and present from frame 1 before `rawInput` streams.
    const metaSkillName = extractClaudeCodeSkillName(part.meta)
    const rawTitle =
      (metaSkillName ? `Skill: ${metaSkillName}` : null) ??
      (metaTitle ? ellipsis(metaTitle, 80) : null) ??
      deriveToolTitle(
        normalizedToolName,
        part.input,
        part.output ?? part.errorText ?? null
      ) ??
      sanitizeLiveTitle(part.displayTitle) ??
      null
    return localizeDerivedToolTitle(rawTitle, ((key, values) =>
      t(key as never, values as never)) as (
      key: string,
      values?: Record<string, unknown>
    ) => string)
  }, [
    normalizedToolName,
    part.meta,
    part.input,
    part.output,
    part.errorText,
    part.displayTitle,
    t,
  ])
  const lineChangeStats = useMemo(() => {
    if (toolNameLower !== "edit" && toolNameLower !== "apply_patch") {
      return null
    }

    // Prefer finalized tool output, then the declared input.
    // Keep error text as last fallback because permission wrappers can include
    // verbose envelopes that inflate +/- counts before approval.
    const prioritizedCandidates = [
      part.output ?? null,
      part.input,
      part.errorText ?? null,
    ]
    for (const candidate of prioritizedCandidates) {
      const stats = extractEditLineChangeStats(candidate)
      if (!stats) continue
      return stats
    }
    return null
  }, [toolNameLower, part.input, part.output, part.errorText])
  const wallTime = useMemo(() => {
    const source = part.output ?? part.errorText
    if (!source) return null
    const normalized = commandOutputFromJsonString(source) ?? source
    const match = normalized.match(/^wall time\s*:\s*(.+)/im)
    if (!match) return null
    const raw = match[1].trim()
    // Parse "0.0519 seconds" → "52ms", "1.234 seconds" → "1.2s"
    const numMatch = raw.match(/^([\d.]+)\s*s/)
    if (!numMatch) return raw
    const sec = parseFloat(numMatch[1])
    if (Number.isNaN(sec)) return raw
    if (sec < 0.001) return "<1ms"
    if (sec < 1) return `${Math.round(sec * 1000)}ms`
    if (sec < 60) return `${sec.toFixed(1)}s`
    return `${(sec / 60).toFixed(1)}m`
  }, [part.output, part.errorText])
  // The background shell this command left running, when its own script echoed
  // the id (see `extractAnnouncedSessionId`). One session is polled by any
  // number of later `wait` cards, and the ones this echo comes with are exactly
  // the ones the parser could not title by a command — so naming the session
  // here is what ties those "Wait cell 17983" cards back to the command that
  // started it.
  const announcedSessionId = useMemo(
    () =>
      toolNameLower === "exec_command"
        ? extractAnnouncedSessionId(part.output ?? part.errorText)
        : null,
    [toolNameLower, part.output, part.errorText]
  )
  // One command out of a code-mode script: the row label it was written under,
  // and whether truncation cost this card its output (see `parseCodexScriptMeta`).
  const codexScript = useMemo(
    () => parseCodexScriptMeta(part.meta),
    [part.meta]
  )
  const titleSuffix = useMemo(() => {
    const hasStats =
      lineChangeStats &&
      (lineChangeStats.additions > 0 || lineChangeStats.deletions > 0)
    if (
      !hasStats &&
      !wallTime &&
      !backgroundLaunch &&
      !airBackgrounded &&
      !announcedSessionId &&
      !codexScript?.label
    ) {
      return null
    }

    return (
      <span className="flex items-center gap-1.5 text-xs font-medium">
        {codexScript?.label && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
            {codexScript.label}
          </span>
        )}
        {/*
         * The two notices below the header already say truncation happened, so
         * only cards without one need telling that the output they DO show was
         * cut out of a blob codex had trimmed.
         */}
        {codexScript?.truncated &&
          !codexScript.outputMissing &&
          codexScript.sharedWith.length === 0 && (
            <span className="text-muted-foreground/60 font-normal">
              {t("codexScript.truncated")}
            </span>
          )}
        {announcedSessionId && (
          <span className="text-muted-foreground/60 font-normal">
            {t("shellSession", { id: announcedSessionId })}
          </span>
        )}
        {/* One badge, two sources — a parsed launch notice (claude/grok) or the
            AIR marker (codex). They never coexist on one call, and the claim
            they make is the same, so the AIR arm reuses the existing copy. */}
        {(backgroundLaunch || airBackgrounded) && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
            title={backgroundLaunch?.taskId ?? part.toolCallId}
          >
            <TerminalIcon className="size-3" />
            {t("backgroundTask.runningInBackground")}
          </span>
        )}
        {hasStats && lineChangeStats.additions > 0 && (
          <span className="inline-flex items-center gap-0.5 text-green-600 dark:text-green-400">
            <PlusIcon className="size-3" />
            {lineChangeStats.additions}
          </span>
        )}
        {hasStats && lineChangeStats.deletions > 0 && (
          <span className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400">
            <MinusIcon className="size-3" />
            {lineChangeStats.deletions}
          </span>
        )}
        {wallTime && (
          <span className="text-muted-foreground/60 font-normal">
            {wallTime}
          </span>
        )}
      </span>
    )
  }, [
    lineChangeStats,
    wallTime,
    backgroundLaunch,
    airBackgrounded,
    part.toolCallId,
    announcedSessionId,
    codexScript,
    t,
  ])

  const icon = useMemo(
    () => getToolIcon(normalizedToolName, part.input),
    [normalizedToolName, part.input]
  )
  const displayCommand = useMemo(() => {
    if (!isCommandTool || isShellSessionTool) return null
    return (
      extractDisplayCommandFromToolInput(part.input) ??
      extractDisplayCommandFromToolInput(part.output) ??
      extractDisplayCommandFromToolInput(part.errorText)
    )
  }, [
    isCommandTool,
    isShellSessionTool,
    part.input,
    part.output,
    part.errorText,
  ])
  const commandOutput = useMemo(() => {
    if (!isCommandLikeTool) return null
    const source =
      typeof part.output === "string"
        ? part.output
        : typeof part.errorText === "string"
          ? part.errorText
          : null
    if (!source) return null
    const normalized = commandOutputFromJsonString(source) ?? source
    const envelope = parseCliExecutionEnvelope(normalized)
    return stripMarkdownCodeFence(envelope.output)
  }, [isCommandLikeTool, part.output, part.errorText])
  const hasLiveOutput =
    isRunning && isCommandTool && typeof commandOutput === "string"
  const liveOutput = useMemo(() => {
    if (!hasLiveOutput || typeof commandOutput !== "string") {
      return null
    }
    const maxChars = 24000
    return commandOutput.length > maxChars
      ? commandOutput.slice(-maxChars)
      : commandOutput
  }, [hasLiveOutput, commandOutput])
  const liveOutputTruncated =
    hasLiveOutput &&
    typeof commandOutput === "string" &&
    typeof liveOutput === "string" &&
    liveOutput.length < commandOutput.length
  // Search results get a grouped, clickable body instead of the generic result
  // block. `null` means "not a search tool / nothing to show yet" and falls
  // through to <ToolOutput>; `""` is a real result — an empty search, rendered
  // as "no matches".
  //
  // Only codex's exact `{formatted_output, exit_code}` envelope is unwrapped
  // (that is what the generic block was dumping as raw JSON) — every other
  // agent's search output passes through byte-for-byte, and NOTHING is stripped
  // from the unwrapped text. codex-acp assigns `formatted_output` straight from
  // the process's raw `aggregatedOutput`, so it never carries codex's own
  // "Chunk ID:/Wall time:/Output:" text framing or a Markdown fence — whereas
  // every cleanup step the command/read paths apply is lossy on a legitimate
  // search hit. A single-file grep prints matches with no `<path>:` prefix, so
  // `grep 'Wall time:' server.log`, `grep '^Output:' log`, `grep -h '```' *.md`
  // and a lone `{"exit_code":0}` all used to come out truncated or empty
  // ("no matches").
  const searchOutput = useMemo(() => {
    if (!isSearchTool) return null

    // codex appears to derive the tool status from the exit code, so an rg/grep
    // "no matches" (exit 1, no output) can arrive as a FAILED call and land on
    // the error channel. `adaptMessageTurn` normally takes that shape off the
    // error channel entirely (same `isCodexGrepNoMatchEnvelope` predicate, so
    // the card's status and this body can never disagree); this arm still
    // catches the adapter-independent callers — an `agent_stats` child call, an
    // export/replay part built outside the turn adapter — and renders an empty
    // result instead of a red envelope dump. A real grep failure (exit ≥ 2, or
    // any stderr text) keeps the error rendering, as does any non-codex error
    // string.
    if (typeof part.errorText === "string") {
      if (toolNameLower !== "grep") return null
      return isCodexGrepNoMatchEnvelope(part.errorText) ? "" : null
    }

    if (typeof part.output !== "string") return null
    return parseCodexCommandEnvelope(part.output)?.output ?? part.output
  }, [isSearchTool, toolNameLower, part.output, part.errorText])
  const searchQuery = useMemo(() => {
    if (!isSearchTool || !part.input) return null
    const pattern = tryParseJson(part.input)?.pattern
    return typeof pattern === "string" && pattern.length > 0 ? pattern : null
  }, [isSearchTool, part.input])
  const shouldRenderCommandTerminal =
    isCommandTool &&
    (isRunning ||
      (typeof commandOutput === "string" && commandOutput.length > 0) ||
      (typeof displayCommand === "string" && displayCommand.length > 0))
  const terminalOutput = useMemo(() => {
    if (!shouldRenderCommandTerminal) return ""
    if (backgroundLaunch) {
      // Replace the verbose "Output is being written to <tmp path>…" notice
      // with a concise localized line; the real run shows in its own card.
      return buildCommandTerminalOutput(
        displayCommand,
        t("backgroundTask.launchNote", { id: backgroundLaunch.taskId }),
        false
      )
    }
    const output = hasLiveOutput ? (liveOutput ?? "") : (commandOutput ?? "")
    return buildCommandTerminalOutput(displayCommand, output, isRunning)
  }, [
    shouldRenderCommandTerminal,
    backgroundLaunch,
    t,
    hasLiveOutput,
    liveOutput,
    commandOutput,
    displayCommand,
    isRunning,
  ])
  const isFileTool =
    toolNameLower === "read" ||
    toolNameLower === "read file" ||
    toolNameLower === "write" ||
    toolNameLower === "notebookedit"
  const shouldHideDuplicateResult =
    (toolNameLower === "edit" ||
      toolNameLower === "apply_patch" ||
      toolNameLower === "switch_mode" ||
      toolNameLower === "enterplanmode" ||
      toolNameLower === "exitplanmode" ||
      toolNameLower === "plan_review" ||
      isFileTool) &&
    !part.errorText
  // codex-acp #288: the context-compaction lifecycle is a `tool_call` tagged
  // with `_meta.contextCompaction` (not addressed by tool name) → a subtle
  // status card instead of the generic tool shell.
  if (isContextCompactionMeta(part.meta)) {
    return (
      <ContextCompactionCard
        state={part.state}
        meta={part.meta}
        summary={contextCompactionSummary(part.meta, part.output)}
      />
    )
  }

  // Agent/subagent tools get a dedicated container rendering
  if (toolNameLower === "agent") {
    return (
      <AgentToolCallPart
        part={part}
        renderToolCall={(p, key) => (
          // Strip agentStats/agentTranscript to prevent recursive Agent nesting
          <ToolCallPart
            key={key}
            part={{ ...p, agentStats: undefined, agentTranscript: undefined }}
          />
        )}
      />
    )
  }

  if (toolNameLower === "create_goal" || toolNameLower === "update_goal") {
    return <GoalToolCallPart part={{ ...part, toolName: normalizedToolName }} />
  }

  // codex live collab / sub-agent activity (codex-acp 1.0.1 #223): a compact
  // streaming-time card showing the sub-agent message. Reconstructed into the
  // richer "Agent" capsule from the rollout on history reload.
  if (toolNameLower === COLLAB_AGENT_TOOL_NAME) {
    return (
      <CollabAgentCard
        input={part.input ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // Multi-agent delegation tool: surfaces an inline DelegatedSubThread
  // bound to the child sub-session via parent_tool_use_id. Matches the
  // bare `delegate_to_agent` (post-normalization) plus any host-specific
  // server-prefixed form (`mcp__<server>__delegate_to_agent`,
  // `<server>/delegate_to_agent`, `<server>.delegate_to_agent`, etc.)
  // as a defensive fallback in case the value reaches the renderer
  // un-normalized. Falls through to the normal renderer when no
  // toolCallId is available (snapshot replays without a live binding)
  // so the user still sees the tool input/output.
  if (isDelegateToAgentToolName(normalizedToolName) && part.toolCallId) {
    return (
      <DelegatedSubThread
        parentToolUseId={part.toolCallId}
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
        meta={part.meta ?? null}
      />
    )
  }

  // Multi-agent delegation companion tools: render compact status cards
  // consistent with DelegatedSubThread instead of the generic tool shell.
  // `normalizeToolName` has already collapsed any host-specific server prefix
  // (`mcp__<server>__…`) to these canonical names.
  if (toolNameLower === "get_delegation_status") {
    return (
      <DelegationStatusCard
        kind="status"
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }
  if (toolNameLower === "cancel_delegation") {
    return (
      <DelegationStatusCard
        kind="cancel"
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // codeg-mcp ask_user_question: render the asked question(s) and the user's
  // selection as a dedicated read-only card instead of the generic tool shell.
  // The live interactive answering is handled separately by the pinned
  // AskQuestionCard; this is the in-stream record (historical + in-flight).
  if (toolNameLower === "question") {
    return (
      <AskQuestionResultCard
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // codeg-mcp check_user_feedback: render the received steering notes as a
  // capsule. The no-op polls (count: 0) and in-flight checks are dropped upstream
  // by `dropHiddenFeedbackChecks`, so reaching here means there is feedback to
  // show (or, rarely, an error).
  if (toolNameLower === "check_user_feedback") {
    return (
      <FeedbackCheckResultCard
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // codeg-mcp resume_delegation: the sub-agent that came back. Rendered as the
  // delegation card itself (with a ⟳ marker) rather than a task-id row above
  // one, and tried BEFORE the generic workbench card below — which stays as the
  // fallback for a REFUSED resume (`not_resumable`, unknown task), where there
  // is no sub-agent to draw and only the reason is worth reading.
  if (toolNameLower === "resume_delegation" && part.toolCallId) {
    return (
      <ResumedDelegationCard
        toolCallId={part.toolCallId}
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
        meta={part.meta ?? null}
        // Whether a sub-agent resolves is only known inside the card (it takes
        // a hook to find out), so the fallback goes in rather than the decision
        // coming out.
        fallback={
          <CodegMcpToolCard
            tool="resume_delegation"
            input={part.input ?? null}
            output={part.output ?? null}
            errorText={part.errorText ?? null}
            state={part.state}
          />
        }
      />
    )
  }

  // The remaining codeg-mcp workbench companions (session lookup, work-task
  // reporting, chat authoring). One compact line stating what the call was
  // about, in the same visual language as the delegation cards, instead of the
  // generic tool shell's raw argument dump.
  if (isCodegMcpWorkbenchTool(toolNameLower)) {
    return (
      <CodegMcpToolCard
        tool={toolNameLower}
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // Cline: attempt_completion — render as an expanded card with result + progress
  if (toolNameLower === "attempt_completion") {
    const parsedCompletion = tryParseJson(part.input ?? "")
    const completionResult =
      (parsedCompletion?.result as string | undefined)?.trim() ?? null
    const taskProgress =
      (parsedCompletion?.task_progress as string | undefined)?.trim() ?? null
    return (
      <Tool open onOpenChange={setManualOpen}>
        <ToolHeader
          type="dynamic-tool"
          state={part.state}
          toolName={normalizedToolName}
          title={title ?? "Completion"}
          icon={icon}
        />
        <ToolContent>
          {completionResult && (
            <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
              <MessageResponse>{completionResult}</MessageResponse>
            </div>
          )}
          {taskProgress && (
            <div className="mt-2 rounded-md border bg-muted/30 px-3 py-2">
              <div className="text-2xs font-medium text-muted-foreground mb-1">
                Progress
              </div>
              <div className="text-xs prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{taskProgress}</MessageResponse>
              </div>
            </div>
          )}
        </ToolContent>
      </Tool>
    )
  }

  // Plan-mode transition tools (EnterPlanMode/ExitPlanMode/switch_mode, and
  // codex's plan_review gate): render the plan directly via a dedicated card
  // instead of folding into a misleading "思考 N 次" tool-group. `toolNameLower`
  // is the underscore-preserving `tool-call-normalization` form, so
  // `switch_mode` / `plan_review` keep their underscore here.
  if (
    toolNameLower === "enterplanmode" ||
    toolNameLower === "exitplanmode" ||
    toolNameLower === "switch_mode" ||
    toolNameLower === "plan_review"
  ) {
    return (
      <PlanModeCard
        toolName={toolNameLower}
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  const open = (isRunning && (isCommandTool || hasLiveOutput)) || manualOpen

  return (
    <Tool open={open} onOpenChange={setManualOpen}>
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={normalizedToolName}
        title={title ?? undefined}
        titleSuffix={titleSuffix ?? undefined}
        icon={icon}
      />
      <ToolContent>
        {part.input && (!isCommandTool || !shouldRenderCommandTerminal) && (
          <StructuredToolInput
            toolName={normalizedToolName}
            input={part.input}
            output={part.output}
          />
        )}
        {/*
         * Codex truncates a script's combined output by deleting whole lines,
         * so the label that separated this command's output from the next one
         * may be gone. Say which commands ended up sharing a card, and which
         * ones nothing could be attributed to, instead of letting either read
         * as this command's own result.
         */}
        {codexScript?.sharedWith.length ? (
          <div className="text-2xs text-muted-foreground">
            {t("codexScript.sharedWith", {
              commands: codexScript.sharedWith.join(", "),
            })}
          </div>
        ) : null}
        {codexScript?.outputMissing && (
          <div className="text-2xs text-muted-foreground">
            {t("codexScript.outputMissing")}
          </div>
        )}
        {toolNameLower === "task" && part.output ? (
          <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
            <MessageResponse>{part.output}</MessageResponse>
          </div>
        ) : (
          <>
            {shouldRenderCommandTerminal ? (
              <div>
                <Terminal
                  output={terminalOutput}
                  isStreaming={isRunning}
                  className="max-h-80"
                />
                {liveOutputTruncated && (
                  <div className="text-2xs text-muted-foreground">
                    {t("showingTailOutput")}
                  </div>
                )}
              </div>
            ) : searchOutput !== null ? (
              <div className="space-y-2">
                <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  {t("result")}
                </h4>
                <SearchResultsOutput text={searchOutput} query={searchQuery} />
              </div>
            ) : (
              !shouldHideDuplicateResult &&
              (part.output || part.errorText) && (
                <ToolOutput output={part.output} errorText={part.errorText} />
              )
            )}
          </>
        )}
      </ToolContent>
    </Tool>
  )
})

const ToolResultPart = memo(function ToolResultPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-result" }>
}) {
  const t = useTranslations("Folder.chat.contentParts")
  return (
    <Tool>
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={t("result")}
      />
      <ToolContent>
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
    </Tool>
  )
})

const ReasoningPart = memo(function ReasoningPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "reasoning" }>
}) {
  const hasContent = part.content.trim().length > 0
  const expandable = hasContent || part.isStreaming
  return (
    <Reasoning isStreaming={part.isStreaming} expandable={expandable}>
      <ReasoningTrigger />
      {expandable && <ReasoningContent>{part.content}</ReasoningContent>}
    </Reasoning>
  )
})

const PlanPart = memo(function PlanPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "plan" }>
}) {
  return <PlanCard entries={part.entries} isStreaming={part.isStreaming} />
})

// Codex Plan-mode `<proposed_plan>` block: free-form markdown plan document
// rendered inside card chrome (distinct from the TodoWrite checklist PlanCard).
//
// Renders through the SAME <PlanMarkdownCard> the live `plan_review` tool call
// uses. The two carriers of a codex plan — this lifted block on reload, that
// tool call live — previously had their own chrome, so the reloaded plan lost
// the prose styling and the clamp/expand footer the live one had.
const ProposedPlanPart = memo(function ProposedPlanPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "proposed-plan" }>
}) {
  const t = useTranslations("Folder.chat.proposedPlan")
  return (
    <PlanMarkdownCard
      markdown={part.markdown.trim()}
      label={t("title")}
      emptyLabel={t("planning")}
    />
  )
})

const ToolGroupPart = memo(function ToolGroupPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-group" }>
}) {
  const t = useTranslations("Folder.chat.contentParts.toolGroup")
  const [open, setOpen] = useState(false)

  const { phrases, errorPhrase } = useMemo(() => {
    const counts = TOOL_KIND_ORDER.reduce(
      (acc, kind) => {
        acc[kind] = 0
        return acc
      },
      {} as Record<ToolKindLabel, number>
    )
    let errors = 0
    for (const item of part.items) {
      counts[classifyToolKind(item.toolName)] += 1
      if (item.state === "output-error" || item.errorText) errors += 1
    }
    const built: string[] = []
    for (const kind of TOOL_KIND_ORDER) {
      const count = counts[kind]
      if (count <= 0) continue
      built.push(t(kind, { count }))
    }
    if (built.length === 0) {
      built.push(t("other", { count: part.items.length }))
    }
    return {
      phrases: built,
      errorPhrase: errors > 0 ? t("errorSuffix", { count: errors }) : null,
    }
  }, [part, t])

  if (part.items.length === 0) return null

  const joiner = t("joiner")
  const titleText = phrases.join(joiner)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger
        className={cn(
          "group inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/60 px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ws-msg-chip"
        )}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 opacity-60 transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 truncate">
          {part.isStreaming ? (
            <Shimmer as="span" duration={1} shineColor="var(--primary)">
              {titleText}
            </Shimmer>
          ) : (
            titleText
          )}
          {errorPhrase && (
            <span className="text-destructive">
              {joiner}
              {errorPhrase}
            </span>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "w-full outline-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1"
        )}
      >
        <div className="mt-3 w-full space-y-3">
          {part.items.map((item, idx) => (
            <ToolCallPart
              key={`grouped-tc-${item.toolCallId ?? idx}-${idx}`}
              part={item}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

// ── Main renderer ─────────────────────────────────────────────────────

interface ContentPartsRendererProps {
  parts: AdaptedContentPart[]
  role?: MessageRole
  isStreaming?: boolean
}

export const ContentPartsRenderer = memo(function ContentPartsRenderer({
  parts,
  role,
  isStreaming = false,
}: ContentPartsRendererProps) {
  const renderPart = (part: AdaptedContentPart, keyId: string): ReactNode => {
    if (part.type === "text") {
      // An empty text part renders nothing but still earns a `space-y-4` gap
      // below, which reads as a blank band inside the bubble. A user turn is
      // final by the time it is rendered, so an empty one is always residue —
      // never a stream that has not produced its first token yet, which is why
      // this is scoped to `user` and assistant text is left to render as-is.
      if (role === "user" && part.text.trim().length === 0) return null
      return (
        <TextPart
          key={`text-${keyId}`}
          text={part.text}
          isUser={role === "user"}
          isStreaming={isStreaming}
        />
      )
    }

    if (part.type === "tool-call") {
      return <ToolCallPart key={`tc-${part.toolCallId ?? keyId}`} part={part} />
    }

    if (part.type === "tool-group") {
      return <ToolGroupPart key={`tg-${keyId}`} part={part} />
    }

    if (part.type === "goal-run") {
      return (
        <GoalRunPart
          key={`goal-${keyId}`}
          part={part}
          renderPart={(child, childKey) => renderPart(child, childKey)}
        />
      )
    }

    if (part.type === "delegation-status-group") {
      return (
        <DelegationStatusGroupCard key={`dsg-${keyId}`} polls={part.polls} />
      )
    }

    if (part.type === "background-task-group") {
      return <BackgroundTaskCard key={`btg-${keyId}`} polls={part.polls} />
    }

    if (part.type === "tool-result") {
      return (
        <ToolResultPart key={`tr-${part.toolCallId ?? keyId}`} part={part} />
      )
    }

    if (part.type === "reasoning") {
      return <ReasoningPart key={`reasoning-${keyId}`} part={part} />
    }

    if (part.type === "plan") {
      return <PlanPart key={`plan-${keyId}`} part={part} />
    }

    if (part.type === "proposed-plan") {
      return <ProposedPlanPart key={`proposed-plan-${keyId}`} part={part} />
    }

    if (part.type === "generated-image") {
      return (
        <GeneratedImagesBlock
          key={`gimg-${keyId}`}
          label={part.label}
          revisedPrompt={part.revisedPrompt}
          image={part.image}
          status={part.status}
        />
      )
    }

    return null
  }

  return (
    <div className="space-y-4">
      {parts.map((part, i) => renderPart(part, `${i}`))}
    </div>
  )
})
