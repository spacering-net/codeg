import type { ContentBlock, MessageTurn } from "./types"
import { normalizeToolName } from "./tool-call-normalization"
import { estimateChangedLineStats } from "./line-change-stats"
import { generateUnifiedDiff } from "./unified-diff-generator"

export type FileOperation = "read" | "edit" | "write" | "apply_patch"

export interface SessionFileChange {
  path: string
  operations: FileOperation[]
}

export interface FileChangeStat {
  id: string
  path: string
  additions: number
  deletions: number
  diff: string | null
}

export interface UserMessageGroup {
  userTurnId: string
  userMessage: string
  timestamp: string
  files: FileChangeStat[]
}

interface DiffStat {
  additions: number
  deletions: number
}

interface EditChangePreview {
  oldText: string
  newText: string
  unifiedDiff: string | null
}

interface DiffSection extends DiffStat {
  chunk: string
}

const WRITE_OPS = new Set<string>(["edit", "write", "apply_patch"])
const FILE_OPS = new Set<string>(["read", "edit", "write", "apply_patch"])

const NESTED_PAYLOAD_KEYS = ["input", "arguments", "params", "payload"]

const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_file",
  "targetFile",
  "filename",
  "notebook_path",
] as const

const PATCH_TEXT_KEYS = [
  "patch",
  "content",
  "diff",
  "unified_diff",
  "unifiedDiff",
  "input",
  "command",
  "cmd",
  "script",
] as const

const EDIT_CHANGE_OLD_KEYS = [
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "old",
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

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
}

function asObjectLike(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed.startsWith("{")) return null

  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parseInputObject(
  inputPreview: string | null
): Record<string, unknown> | null {
  if (!inputPreview) return null
  return asObjectLike(inputPreview)
}

function findStringFieldDeep(
  value: unknown,
  keys: readonly string[],
  depth: number = 0
): string | null {
  if (depth > 4) return null

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringFieldDeep(item, keys, depth + 1)
      if (found) return found
    }
    return null
  }

  const obj = asObjectLike(value)
  if (!obj) return null

  for (const key of keys) {
    const direct = obj[key]
    if (typeof direct === "string" && direct.trim().length > 0) {
      return direct
    }
  }

  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findStringFieldDeep(obj[nestedKey], keys, depth + 1)
    if (found) return found
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findStringFieldDeep(nestedValue, keys, depth + 1)
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

function firstStringField(
  value: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === "string") {
      return field
    }
  }

  return null
}

function unescapeInlineEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
}

function decodeJsonEscapedString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\")
}

function normalizeDiffPath(rawPath: string | null): string | null {
  if (!rawPath) return null

  const trimmed = rawPath.trim()
  if (!trimmed || trimmed === "/dev/null") return null

  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return normalizePath(trimmed.slice(2))
  }

  return normalizePath(trimmed)
}

function isDiffAddedLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++")
}

function isDiffDeletedLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---")
}

function countLines(s: string): number {
  if (!s) return 0
  return s.split("\n").length
}

function countDiffLines(text: string): DiffStat {
  let additions = 0
  let deletions = 0

  for (const line of text.split("\n")) {
    if (isDiffAddedLine(line)) additions += 1
    if (isDiffDeletedLine(line)) deletions += 1
  }

  return { additions, deletions }
}

function buildUnifiedDiff(
  filePath: string,
  oldText: string,
  newText: string
): string | null {
  return generateUnifiedDiff(oldText, newText, filePath)
}

function parseEditChangeValue(value: unknown): EditChangePreview | null {
  if (typeof value === "string") {
    return {
      oldText: "",
      newText: value,
      unifiedDiff: null,
    }
  }

  const record = asObjectLike(value)
  if (!record) return null

  const oldText =
    firstStringField(record, EDIT_CHANGE_OLD_KEYS) ??
    findStringFieldDeep(record, [
      "old_string",
      "old_text",
      "before_text",
      "old",
    ]) ??
    ""

  const newText =
    firstStringField(record, EDIT_CHANGE_NEW_KEYS) ??
    findStringFieldDeep(record, [
      "new_string",
      "new_text",
      "after_text",
      "new",
    ]) ??
    ""

  const unifiedDiff =
    firstStringField(record, EDIT_CHANGE_DIFF_KEYS) ??
    findStringFieldDeep(record, ["diff"]) ??
    null

  if (!oldText && !newText && !unifiedDiff) {
    return null
  }

  return {
    oldText,
    newText,
    unifiedDiff:
      unifiedDiff && unifiedDiff.trim().length > 0 ? unifiedDiff : null,
  }
}

function collectEditChangeValues(value: unknown): EditChangePreview[] {
  if (value === null || value === undefined) return []

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectEditChangeValues(item))
  }

  const single = parseEditChangeValue(value)
  if (single) return [single]

  const record = asObjectLike(value)
  if (!record) return []

  return Object.values(record).flatMap((item) => collectEditChangeValues(item))
}

function pickValueByNormalizedPath(
  record: Record<string, unknown>,
  filePath: string
): unknown {
  if (filePath in record) return record[filePath]

  const escapedPath = filePath.replace(/\//g, "\\/")
  if (escapedPath in record) return record[escapedPath]

  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = normalizePath(decodeJsonEscapedString(key.trim()))
    if (normalizedKey === filePath) {
      return value
    }
  }

  return undefined
}

function buildChunkFromEditChange(
  filePath: string,
  change: EditChangePreview
): string | null {
  if (change.unifiedDiff) {
    return change.unifiedDiff.trim()
  }

  return buildUnifiedDiff(filePath, change.oldText, change.newText)
}

function extractPatchTextFromInputPreview(
  inputPreview: string | null
): string | null {
  if (!inputPreview) return null

  const parsed = parseInputObject(inputPreview)
  const parsedPatchText = parsed
    ? findStringFieldDeep(parsed, PATCH_TEXT_KEYS)
    : null

  const candidates = [parsedPatchText, inputPreview]

  for (const candidate of candidates) {
    if (!candidate) continue

    const normalized = unescapeInlineEscapes(candidate.trim())
    if (!normalized) continue

    const block = normalized.match(
      /(\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch(?:\n|$))/m
    )?.[1]
    if (block) return block.trim()

    if (normalized.includes("*** Update File:")) return normalized
    if (/^diff --git /m.test(normalized)) return normalized
    if (/^--- .+/m.test(normalized) && /^\+\+\+ .+/m.test(normalized)) {
      return normalized
    }
  }

  return null
}

function parseApplyPatchSections(patchText: string): Map<string, DiffSection> {
  const sections = new Map<string, DiffSection>()

  let currentPath: string | null = null
  let currentLines: string[] = []
  let additions = 0
  let deletions = 0

  const flush = () => {
    if (!currentPath || currentLines.length === 0) return

    const chunk = currentLines.join("\n").trim()
    if (!chunk) return

    const existing = sections.get(currentPath)
    if (!existing) {
      sections.set(currentPath, { chunk, additions, deletions })
      return
    }

    sections.set(currentPath, {
      chunk: `${existing.chunk}\n${chunk}`,
      additions: existing.additions + additions,
      deletions: existing.deletions + deletions,
    })
  }

  const beginMarkers = [
    "*** Update File: ",
    "*** Add File: ",
    "*** Delete File: ",
  ]

  for (const line of patchText.split("\n")) {
    const marker = beginMarkers.find((prefix) => line.startsWith(prefix))
    if (marker) {
      flush()

      currentPath = normalizeDiffPath(line.slice(marker.length))
      currentLines = [line]
      additions = 0
      deletions = 0
      continue
    }

    if (!currentPath) continue

    currentLines.push(line)
    if (line.startsWith("*** Move to: ")) {
      const movedPath = normalizeDiffPath(line.slice(13))
      if (movedPath) currentPath = movedPath
      continue
    }
    if (isDiffAddedLine(line)) additions += 1
    if (isDiffDeletedLine(line)) deletions += 1
  }

  flush()
  return sections
}

function parseUnifiedDiffSections(diffText: string): Map<string, DiffSection> {
  const sections = new Map<string, DiffSection>()

  let currentPath: string | null = null
  let currentLines: string[] = []
  let additions = 0
  let deletions = 0

  const flush = () => {
    if (!currentPath || currentLines.length === 0) return

    const chunk = currentLines.join("\n").trim()
    if (!chunk) return

    const existing = sections.get(currentPath)
    if (!existing) {
      sections.set(currentPath, { chunk, additions, deletions })
      return
    }

    sections.set(currentPath, {
      chunk: `${existing.chunk}\n${chunk}`,
      additions: existing.additions + additions,
      deletions: existing.deletions + deletions,
    })
  }

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush()

      const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/)
      currentPath = normalizeDiffPath(match?.[2] ?? null)
      currentLines = [line]
      additions = 0
      deletions = 0
      continue
    }

    if (line.startsWith("--- ")) {
      const maybePath = normalizeDiffPath(line.slice(4))
      if (!currentPath && maybePath) {
        flush()
        currentPath = maybePath
        currentLines = []
        additions = 0
        deletions = 0
      }

      if (currentPath) currentLines.push(line)
      continue
    }

    if (line.startsWith("+++ ")) {
      const maybePath = normalizeDiffPath(line.slice(4))
      if (maybePath && maybePath !== currentPath) {
        flush()
        currentPath = maybePath
        currentLines = []
        additions = 0
        deletions = 0
      }

      if (currentPath) currentLines.push(line)
      continue
    }

    if (!currentPath) continue

    currentLines.push(line)
    if (isDiffAddedLine(line)) additions += 1
    if (isDiffDeletedLine(line)) deletions += 1
  }

  flush()
  return sections
}

function extractPathsFromPatchText(patchText: string): string[] {
  const applyPatchSections = parseApplyPatchSections(patchText)
  if (applyPatchSections.size > 0) {
    return Array.from(applyPatchSections.keys())
  }

  const unifiedDiffSections = parseUnifiedDiffSections(patchText)
  if (unifiedDiffSections.size > 0) {
    return Array.from(unifiedDiffSections.keys())
  }

  return []
}

function extractFilePaths(inputPreview: string | null): string[] {
  if (!inputPreview) return []

  const paths = new Set<string>()
  const parsed = parseInputObject(inputPreview)

  if (parsed) {
    const directPath = findStringFieldDeep(parsed, PATH_KEYS)
    if (directPath) {
      paths.add(normalizePath(directPath))
    }

    const editChanges = findObjectFieldDeep(parsed, "changes")
    if (editChanges) {
      for (const path of Object.keys(editChanges)) {
        const normalized = normalizePath(path.trim())
        if (normalized) paths.add(normalized)
      }
    }
  }

  // Skip patch-text extraction for edit-shaped inputs: their authoritative
  // paths are the `changes` keys / `file_path` above. Running it anyway would
  // let `extractPatchTextFromInputPreview`'s deep `diff`-field search surface a
  // nested diff's own header path as a phantom file (e.g. `src/a.ts` alongside
  // the real `/repo/src/a.ts`).
  if (!isEditShapedInput(parsed)) {
    const patchText = extractPatchTextFromInputPreview(inputPreview)
    if (patchText) {
      for (const path of extractPathsFromPatchText(patchText)) {
        paths.add(path)
      }
    }
  }

  if (paths.size === 0) {
    const match = inputPreview.match(
      /"(?:file_path|filePath|path|target_file|targetFile|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)+)"/
    )
    if (match?.[1]) {
      paths.add(normalizePath(decodeJsonEscapedString(match[1])))
    }
  }

  return Array.from(paths)
}

/**
 * True when a tool input is an edit descriptor (`{file_path, old_string,
 * new_string}` or `{changes:{path:{...}}}`) rather than V4A/unified patch text.
 * Some agents (e.g. Codex) synthesize `apply_patch` edits this way. Callers use
 * it to keep such inputs out of the patch-text path, because
 * `extractPatchTextFromInputPreview` deep-searches nested `diff` fields — so a
 * multi-file `changes` payload where one entry carries a `diff` would otherwise
 * (a) leak that file's diff/stats onto its siblings and (b) emit a phantom path
 * from the nested diff's own header.
 */
function isEditShapedInput(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false
  if (findObjectFieldDeep(parsed, "changes")) return true
  if (typeof parsed.old_string === "string") return true
  if (typeof parsed.new_string === "string") return true
  return false
}

function computeLineDiff(
  op: string,
  inputPreview: string | null,
  filePath?: string
): DiffStat | null {
  if (!inputPreview) return null

  const normalizedPath = filePath ? normalizePath(filePath) : null
  const parsed = parseInputObject(inputPreview)

  if (op === "edit") {
    if (parsed && normalizedPath) {
      const changes = findObjectFieldDeep(parsed, "changes")
      const changeValue = changes
        ? pickValueByNormalizedPath(changes, normalizedPath)
        : undefined
      const changeValues = collectEditChangeValues(changeValue)

      if (changeValues.length > 0) {
        let additions = 0
        let deletions = 0

        for (const change of changeValues) {
          if (change.unifiedDiff) {
            const diff = countDiffLines(change.unifiedDiff)
            additions += diff.additions
            deletions += diff.deletions
            continue
          }

          const estimated = estimateChangedLineStats(
            change.oldText,
            change.newText
          )
          additions += estimated.additions
          deletions += estimated.deletions
        }

        return { additions, deletions }
      }
    }

    if (!parsed) return null

    const oldStr =
      typeof parsed.old_string === "string" ? parsed.old_string : ""
    const newStr =
      typeof parsed.new_string === "string" ? parsed.new_string : ""

    if (!oldStr && !newStr) return null

    return estimateChangedLineStats(oldStr, newStr)
  }

  if (op === "write") {
    if (!parsed) return null

    const content = typeof parsed.content === "string" ? parsed.content : ""
    if (!content) return null

    return {
      additions: countLines(content),
      deletions: 0,
    }
  }

  if (op === "apply_patch") {
    // Edit-shaped synthesized payloads must go through the `edit` logic, which
    // resolves the change object per path — otherwise a nested `diff` field
    // gets treated as the whole patch and misattributed across files.
    if (isEditShapedInput(parsed)) {
      return computeLineDiff("edit", inputPreview, filePath)
    }

    const patchText = extractPatchTextFromInputPreview(inputPreview)
    if (!patchText) {
      // Any remaining apply_patch payload with no real patch text — fall back
      // to edit stats so the file still reports +/- instead of a misleading
      // +0/-0.
      return computeLineDiff("edit", inputPreview, filePath)
    }

    const applyPatchSections = parseApplyPatchSections(patchText)
    if (normalizedPath && applyPatchSections.has(normalizedPath)) {
      const section = applyPatchSections.get(normalizedPath)
      if (section) {
        return {
          additions: section.additions,
          deletions: section.deletions,
        }
      }
    }

    const unifiedDiffSections = parseUnifiedDiffSections(patchText)
    if (normalizedPath && unifiedDiffSections.has(normalizedPath)) {
      const section = unifiedDiffSections.get(normalizedPath)
      if (section) {
        return {
          additions: section.additions,
          deletions: section.deletions,
        }
      }
    }

    const total = countDiffLines(patchText)
    if (total.additions === 0 && total.deletions === 0) {
      return null
    }

    return total
  }

  return null
}

function extractUserMessage(turn: MessageTurn): string {
  for (const block of turn.blocks) {
    if (block.type === "text" && block.text) {
      const text = block.text.trim()
      if (text.length > 80) return `${text.slice(0, 77)}...`
      return text
    }
  }

  return "User message"
}

/** One file written by one of a turn's tool calls, before it joins a group. */
interface TurnFileChange {
  /** The group-independent part of `FileChangeStat.id`. */
  idPrefix: string
  path: string
  additions: number
  deletions: number
  diff: string | null
}

/**
 * Per-turn-object memo of `turnFileChanges`. Parsing a tool call's input and
 * building its diff is the expensive part of grouping, and the message
 * navigator regroups the whole conversation (history above the loaded window
 * included) on every streaming update while it is open. Keyed by identity,
 * which is sound because a turn is never edited in place: every update
 * (metadata backfill, background-task settlement, a refetch) replaces the
 * turn object, and the streaming turn is rebuilt per batch.
 */
const turnFileChangesCache = new WeakMap<MessageTurn, TurnFileChange[]>()

function turnFileChanges(turn: MessageTurn): TurnFileChange[] {
  const cached = turnFileChangesCache.get(turn)
  if (cached) return cached

  const changes: TurnFileChange[] = []
  for (const block of turn.blocks) {
    if (block.type !== "tool_use") continue

    const normalized = normalizeToolName(block.tool_name)
    if (!WRITE_OPS.has(normalized)) continue

    const filePaths = extractFilePaths(block.input_preview)
    if (filePaths.length === 0) continue

    for (const [fileIndex, filePath] of filePaths.entries()) {
      const normalizedPath = normalizePath(filePath)
      const diff = computeLineDiff(
        normalized,
        block.input_preview,
        normalizedPath
      )
      const toolOutput = findToolResultOutput(turn.blocks, block.tool_use_id)
      const diffChunk = buildDiffChunk(
        normalized,
        block.input_preview,
        normalizedPath,
        toolOutput
      )

      changes.push({
        idPrefix: `${turn.id}:${block.tool_use_id ?? "tool"}:${fileIndex}`,
        path: normalizedPath,
        additions: diff?.additions ?? 0,
        deletions: diff?.deletions ?? 0,
        diff: diffChunk?.trim() ? diffChunk.trim() : null,
      })
    }
  }
  turnFileChangesCache.set(turn, changes)
  return changes
}

/**
 * Group the files each user message led to: one group per user turn, holding
 * the edit/write/apply_patch changes of the assistant turns that follow it.
 *
 * The message navigator also runs this over the backend's outline of the
 * history above the loaded window (`nav_outline_turns` in
 * `src-tauri/src/commands/turn_window.rs`), which keeps only what this reads.
 * Reading more of a turn here means keeping more of it there; the shared
 * vector in `src-tauri/tests/fixtures/nav_outline_vector.json` fails both
 * sides' tests until they agree again.
 */
export function extractSessionFilesGrouped(
  turns: readonly MessageTurn[],
  opts: { includeEmpty?: boolean } = {}
): UserMessageGroup[] {
  const { includeEmpty = false } = opts
  const groups: UserMessageGroup[] = []
  let currentUserTurn: MessageTurn | null = null
  let currentFiles: FileChangeStat[] = []

  const flushGroup = () => {
    if (!currentUserTurn) return
    // The message navigator needs a slot for every user turn (even ones with
    // no edits); the sidebar-style callers keep the default that drops empties.
    if (currentFiles.length === 0 && !includeEmpty) return

    groups.push({
      userTurnId: currentUserTurn.id,
      userMessage: extractUserMessage(currentUserTurn),
      timestamp: currentUserTurn.timestamp,
      files: currentFiles,
    })
  }

  for (const turn of turns) {
    if (turn.role === "user") {
      flushGroup()
      currentUserTurn = turn
      currentFiles = []
      continue
    }

    if (turn.role !== "assistant") continue

    for (const change of turnFileChanges(turn)) {
      currentFiles.push({
        id: `${change.idPrefix}:${currentFiles.length}`,
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        diff: change.diff,
      })
    }
  }

  flushGroup()
  return groups
}

/**
 * Aggregate an assistant reply's write operations into ONE `FileChangeStat`
 * per file path. Unlike `extractSessionFilesGrouped` (which groups by user
 * turn), this collects every edit/write/apply_patch across the supplied turns,
 * summing line counts and concatenating diff chunks per file — the shape the
 * per-reply "artifacts" card needs. Pass only the raw turns that compose a
 * single reply (the assistant sub-turns merged into one visual reply).
 */
export function extractReplyFileChanges(
  turns: MessageTurn[]
): FileChangeStat[] {
  interface Acc {
    path: string
    additions: number
    deletions: number
    diffs: string[]
  }
  const byPath = new Map<string, Acc>()
  const order: string[] = []

  for (const turn of turns) {
    if (turn.role !== "assistant") continue

    for (const block of turn.blocks) {
      if (block.type !== "tool_use") continue

      const normalized = normalizeToolName(block.tool_name)
      if (!WRITE_OPS.has(normalized)) continue

      const filePaths = extractFilePaths(block.input_preview)
      if (filePaths.length === 0) continue

      const toolOutput = findToolResultOutput(turn.blocks, block.tool_use_id)

      for (const filePath of filePaths) {
        const normalizedPath = normalizePath(filePath)
        const diff = computeLineDiff(
          normalized,
          block.input_preview,
          normalizedPath
        )
        const diffChunk = buildDiffChunk(
          normalized,
          block.input_preview,
          normalizedPath,
          toolOutput
        )

        let acc = byPath.get(normalizedPath)
        if (!acc) {
          acc = { path: normalizedPath, additions: 0, deletions: 0, diffs: [] }
          byPath.set(normalizedPath, acc)
          order.push(normalizedPath)
        }
        acc.additions += diff?.additions ?? 0
        acc.deletions += diff?.deletions ?? 0
        if (diffChunk?.trim()) acc.diffs.push(diffChunk.trim())
      }
    }
  }

  return order.map((path, index) => {
    const acc = byPath.get(path)!
    return {
      id: `reply-file:${index}:${path}`,
      path: acc.path,
      additions: acc.additions,
      deletions: acc.deletions,
      diff: acc.diffs.length > 0 ? acc.diffs.join("\n\n") : null,
    }
  })
}

/**
 * Build a unified-diff string for a specific file within a user-message group.
 * Scans from `userTurnId` forward through assistant turns until the next user
 * turn, collecting all edit/write/apply_patch operations on `filePath`.
 */
export function buildSessionFileDiff(
  turns: MessageTurn[],
  userTurnId: string,
  filePath: string
): string {
  let inGroup = false
  const chunks: string[] = []
  const normalizedTargetPath = normalizePath(filePath)

  for (const turn of turns) {
    if (turn.role === "user") {
      if (turn.id === userTurnId) {
        inGroup = true
        continue
      }

      if (inGroup) {
        break
      }

      continue
    }

    if (!inGroup || turn.role !== "assistant") continue

    for (const block of turn.blocks) {
      if (block.type !== "tool_use") continue

      const normalized = normalizeToolName(block.tool_name)
      if (!WRITE_OPS.has(normalized)) continue

      const blockPaths = extractFilePaths(block.input_preview).map(
        normalizePath
      )
      if (!blockPaths.includes(normalizedTargetPath)) continue

      const toolOutput = findToolResultOutput(turn.blocks, block.tool_use_id)
      const chunk = buildDiffChunk(
        normalized,
        block.input_preview,
        normalizedTargetPath,
        toolOutput
      )
      if (chunk && chunk.trim().length > 0) chunks.push(chunk.trim())
    }
  }

  if (chunks.length === 0) {
    return `No diff data available for ${filePath}`
  }

  return chunks.join("\n\n")
}

/** Find the tool_result output matching a tool_use_id within the same turn. */
function findToolResultOutput(
  blocks: ContentBlock[],
  toolUseId: string | null
): string | null {
  if (!toolUseId) return null
  for (const block of blocks) {
    if (
      block.type === "tool_result" &&
      block.tool_use_id === toolUseId &&
      block.output_preview &&
      !block.is_error
    ) {
      return block.output_preview
    }
  }
  return null
}

function buildDiffChunk(
  op: string,
  inputPreview: string | null,
  filePath: string,
  toolOutput?: string | null
): string | null {
  if (!inputPreview) return null

  const parsed = parseInputObject(inputPreview)

  if (op === "edit") {
    if (parsed) {
      const changes = findObjectFieldDeep(parsed, "changes")
      const changeValue = changes
        ? pickValueByNormalizedPath(changes, filePath)
        : undefined
      const changeValues = collectEditChangeValues(changeValue)

      if (changeValues.length > 0) {
        const chunks = changeValues
          .map((change) => buildChunkFromEditChange(filePath, change))
          .filter((chunk): chunk is string => Boolean(chunk?.trim()))
        if (chunks.length > 0) return chunks.join("\n\n")
      }
    }

    // Prefer tool output if backend injected a real diff with line numbers
    if (toolOutput && /^@@ /m.test(toolOutput)) {
      return toolOutput.trim()
    }

    if (!parsed) return null

    const oldStr =
      typeof parsed.old_string === "string" ? parsed.old_string : ""
    const newStr =
      typeof parsed.new_string === "string" ? parsed.new_string : ""

    const diff = buildUnifiedDiff(filePath, oldStr, newStr)
    if (!diff) return null
    const startLine =
      typeof parsed._start_line === "number" ? parsed._start_line : 0
    if (startLine <= 1) return diff
    return diff.replace(
      /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/gm,
      (_, _o, oc, _n, nc) => `@@ -${startLine},${oc} +${startLine},${nc} @@`
    )
  }

  if (op === "write") {
    if (!parsed) return null

    const content = typeof parsed.content === "string" ? parsed.content : ""
    if (!content) return null

    const newLines = content.split("\n")
    const lines: string[] = [
      "--- /dev/null",
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${newLines.length} @@`,
    ]

    for (const line of newLines) lines.push(`+${line}`)

    return lines.join("\n")
  }

  if (op === "apply_patch") {
    // See computeLineDiff: edit-shaped synthesized payloads must build their
    // diff via the `edit` logic (keyed per path), so a nested `diff` field
    // isn't treated as the whole patch and misattributed across files.
    if (isEditShapedInput(parsed)) {
      return buildDiffChunk("edit", inputPreview, filePath, toolOutput)
    }

    const patchText = extractPatchTextFromInputPreview(inputPreview)
    if (!patchText) {
      return buildDiffChunk("edit", inputPreview, filePath, toolOutput)
    }

    const applyPatchSections = parseApplyPatchSections(patchText)
    if (applyPatchSections.has(filePath)) {
      return applyPatchSections.get(filePath)?.chunk ?? null
    }

    const unifiedDiffSections = parseUnifiedDiffSections(patchText)
    if (unifiedDiffSections.has(filePath)) {
      return unifiedDiffSections.get(filePath)?.chunk ?? null
    }

    return patchText
  }

  return null
}

export function extractSessionFiles(turns: MessageTurn[]): SessionFileChange[] {
  const fileMap = new Map<string, Set<FileOperation>>()

  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type !== "tool_use") continue

      const normalized = normalizeToolName(block.tool_name)
      if (!FILE_OPS.has(normalized)) continue

      const filePaths = extractFilePaths(block.input_preview)
      if (filePaths.length === 0) continue

      for (const filePath of filePaths) {
        if (!fileMap.has(filePath)) {
          fileMap.set(filePath, new Set())
        }

        fileMap.get(filePath)?.add(normalized as FileOperation)
      }
    }
  }

  return Array.from(fileMap.entries()).map(([path, operations]) => ({
    path,
    operations: Array.from(operations),
  }))
}
