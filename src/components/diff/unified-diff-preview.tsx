"use client"

import { Fragment, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Columns2, Rows3 } from "lucide-react"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { cn } from "@/lib/utils"
import { useDiffViewMode, type DiffViewMode } from "@/lib/diff-view-mode-prefs"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { FilePathLink } from "@/components/ai-elements/link-safety"
import { useSyncedScroll } from "./use-synced-scroll"

type RowMarker = "none" | "added" | "deleted" | "modified"
type DiffFileMode = "modified" | "added" | "deleted" | "renamed"

export type { DiffViewMode }

interface RawDiffRow {
  kind: "context" | "add" | "del"
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface ParsedDiffRow {
  type: "context" | "added" | "deleted" | "modified"
  text: string
  sign: " " | "+" | "-"
  oldLine: number | null
  newLine: number | null
}

interface ParsedDiffHunk {
  key: string
  oldStart: number | null
  oldCount: number | null
  newStart: number | null
  newCount: number | null
  rows: ParsedDiffRow[]
}

interface ParsedDiffFile {
  key: string
  path: string
  oldPath: string | null
  newPath: string | null
  mode: DiffFileMode
  /** git refused to line-diff this one ("Binary files … differ"). It has no
   *  hunks and is kept only so the change stays visible in the list. */
  binary: boolean
  additions: number
  deletions: number
  hunks: ParsedDiffHunk[]
}

interface WorkingHunk {
  key: string
  oldStart: number | null
  oldCount: number | null
  newStart: number | null
  newCount: number | null
  rows: RawDiffRow[]
}

interface WorkingFile {
  key: string
  path: string
  oldPath: string | null
  newPath: string | null
  mode: DiffFileMode
  binary: boolean
  additions: number
  deletions: number
  hunks: WorkingHunk[]
}

const ROW_CLASS: Record<RowMarker, string> = {
  none: "",
  added: "bg-green-500/10 text-green-900 dark:text-green-300",
  deleted: "bg-red-500/10 text-red-900 dark:text-red-300",
  modified: "bg-blue-500/10 text-blue-900 dark:text-blue-300",
}

const SIGN_CLASS: Record<string, string> = {
  "+": "text-green-700 dark:text-green-400",
  "-": "text-red-700 dark:text-red-400",
  " ": "text-muted-foreground/50",
}

function normalizePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^"|"$/g, "")
  if (!trimmed || trimmed === "/dev/null") return null
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2).replace(/\\/g, "/")
  }
  return trimmed.replace(/\\/g, "/")
}

function parsePathFromDiffGitLine(line: string): string | null {
  const rest = line.slice("diff --git ".length).trim()

  // git does not quote plain spaces, so `a/<p1> b/<p2>` is genuinely ambiguous
  // for a path like "my icon.png". Both sides name the same file unless this is
  // a rename, so look for the split that makes them equal before falling back
  // to the (lazy, first-space) guess. Text files recover either way — their
  // `--- `/`+++ ` lines overwrite the path — but a binary file has none of
  // those, and this line is all it gets.
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== " ") continue
    const left = rest.slice(0, i)
    const right = rest.slice(i + 1)
    if (!left.startsWith("a/") || !right.startsWith("b/")) continue
    if (left.slice(2) === right.slice(2)) return normalizePath(right)
  }

  const match = rest.match(/^(.+?)\s+(.+)$/)
  if (!match) return null
  return normalizePath(match[2]) ?? normalizePath(match[1])
}

function parseApplyPatchMarker(line: string): {
  path: string | null
  mode: DiffFileMode
} | null {
  if (line.startsWith("*** Update File: ")) {
    return {
      path: normalizePath(line.slice("*** Update File: ".length)),
      mode: "modified",
    }
  }
  if (line.startsWith("*** Add File: ")) {
    return {
      path: normalizePath(line.slice("*** Add File: ".length)),
      mode: "added",
    }
  }
  if (line.startsWith("*** Delete File: ")) {
    return {
      path: normalizePath(line.slice("*** Delete File: ".length)),
      mode: "deleted",
    }
  }
  return null
}

function parseHunkHeader(line: string): {
  oldStart: number | null
  oldCount: number | null
  newStart: number | null
  newCount: number | null
} | null {
  if (!line.startsWith("@@")) return null

  const match = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/)
  if (!match) {
    return {
      oldStart: null,
      oldCount: null,
      newStart: null,
      newCount: null,
    }
  }

  return {
    oldStart: Number(match[1]),
    oldCount: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newCount: match[4] ? Number(match[4]) : 1,
  }
}

function classifyRows(rows: RawDiffRow[]): ParsedDiffRow[] {
  const parsed: ParsedDiffRow[] = []
  let index = 0

  while (index < rows.length) {
    const current = rows[index]
    if (!current) break

    if (current.kind === "context") {
      parsed.push({
        type: "context",
        text: current.text,
        sign: " ",
        oldLine: current.oldLine,
        newLine: current.newLine,
      })
      index += 1
      continue
    }

    if (current.kind === "add") {
      let addEnd = index
      while (addEnd < rows.length && rows[addEnd]?.kind === "add") {
        const row = rows[addEnd]
        if (!row) break
        parsed.push({
          type: "added",
          text: row.text,
          sign: "+",
          oldLine: row.oldLine,
          newLine: row.newLine,
        })
        addEnd += 1
      }
      index = addEnd
      continue
    }

    let delEnd = index
    while (delEnd < rows.length && rows[delEnd]?.kind === "del") {
      delEnd += 1
    }

    let addEnd = delEnd
    while (addEnd < rows.length && rows[addEnd]?.kind === "add") {
      addEnd += 1
    }

    for (let d = index; d < delEnd; d++) {
      const row = rows[d]
      if (!row) continue
      parsed.push({
        type: "deleted",
        text: row.text,
        sign: "-",
        oldLine: row.oldLine,
        newLine: row.newLine,
      })
    }

    for (let a = delEnd; a < addEnd; a++) {
      const row = rows[a]
      if (!row) continue
      parsed.push({
        type: "added",
        text: row.text,
        sign: "+",
        oldLine: row.oldLine,
        newLine: row.newLine,
      })
    }

    index = addEnd
  }

  return parsed
}

function resolveFileMode(file: WorkingFile): DiffFileMode {
  if (file.mode !== "modified") return file.mode
  if (file.oldPath && !file.newPath) return "deleted"
  if (!file.oldPath && file.newPath) return "added"
  if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    return "renamed"
  }
  return "modified"
}

function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n")
  const files: WorkingFile[] = []

  let fileIndex = 1
  let hunkIndex = 1
  let currentFile: WorkingFile | null = null
  let currentHunk: WorkingHunk | null = null
  let oldLineCursor: number | null = null
  let newLineCursor: number | null = null
  let inferredOldCursorForNextHunk = 1
  let inferredNewCursorForNextHunk = 1

  const getActiveFile = (): WorkingFile | null =>
    currentFile ?? files[files.length - 1] ?? null
  const getActiveHunk = (): WorkingHunk | null => currentHunk
  const getOldLineCursor = (): number | null => oldLineCursor
  const getNewLineCursor = (): number | null => newLineCursor

  const flushHunk = () => {
    const file = getActiveFile()
    if (!file || !currentHunk) return
    file.hunks.push(currentHunk)
    if (oldLineCursor !== null) {
      inferredOldCursorForNextHunk = Math.max(1, oldLineCursor)
    }
    if (newLineCursor !== null) {
      inferredNewCursorForNextHunk = Math.max(1, newLineCursor)
    }
    currentHunk = null
  }

  const startFile = (
    path: string | null,
    mode: DiffFileMode = "modified"
  ): WorkingFile => {
    flushHunk()
    currentFile = {
      key: `file-${fileIndex}`,
      path: path ?? `Diff #${fileIndex}`,
      oldPath: null,
      newPath: null,
      mode,
      binary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    }
    files.push(currentFile)
    fileIndex += 1
    inferredOldCursorForNextHunk = 1
    inferredNewCursorForNextHunk = 1
    return currentFile
  }

  const ensureFile = () => getActiveFile() ?? startFile(null)

  const startHunk = (line: string) => {
    const file = ensureFile()
    flushHunk()

    const parsed = parseHunkHeader(line)
    const resolvedOldStart = parsed?.oldStart ?? inferredOldCursorForNextHunk
    const resolvedNewStart = parsed?.newStart ?? inferredNewCursorForNextHunk
    oldLineCursor = resolvedOldStart
    newLineCursor = resolvedNewStart

    currentHunk = {
      key: `${file.key}:hunk-${hunkIndex}`,
      oldStart: resolvedOldStart,
      oldCount: parsed?.oldCount ?? null,
      newStart: resolvedNewStart,
      newCount: parsed?.newCount ?? null,
      rows: [],
    }
    hunkIndex += 1
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      startFile(parsePathFromDiffGitLine(line))
      continue
    }

    const applyPatchMarker = parseApplyPatchMarker(line)
    if (applyPatchMarker) {
      startFile(applyPatchMarker.path, applyPatchMarker.mode)
      continue
    }

    if (line.startsWith("*** Move to: ")) {
      const movedPath = normalizePath(line.slice("*** Move to: ".length))
      const file = getActiveFile()
      if (file && movedPath) {
        file.newPath = movedPath
        file.path = movedPath
        file.mode = "renamed"
      }
      continue
    }

    // A rename names each side on a line of its own, which is the only
    // unambiguous statement of the paths git makes when they contain spaces —
    // and for a binary rename, the only one at all.
    if (line.startsWith("rename from ")) {
      const renamedFrom = normalizePath(line.slice("rename from ".length))
      const file = ensureFile()
      if (renamedFrom) file.oldPath = renamedFrom
      continue
    }

    if (line.startsWith("rename to ")) {
      const renamedTo = normalizePath(line.slice("rename to ".length))
      const file = ensureFile()
      if (renamedTo) {
        file.newPath = renamedTo
        file.path = renamedTo
      }
      continue
    }

    // git's extended headers. A binary add/delete carries no `--- /dev/null`
    // line for `resolveFileMode` to read the mode off, so take it from here.
    if (line.startsWith("new file mode ")) {
      ensureFile().mode = "added"
      continue
    }

    if (line.startsWith("deleted file mode ")) {
      ensureFile().mode = "deleted"
      continue
    }

    // "Binary files a/logo.png and b/logo.png differ", or the base85 payload
    // header of `git diff --binary`. Either way there is nothing to line up in
    // a text grid — the file is kept, flagged, and rendered as a stub.
    if (
      (line.startsWith("Binary files ") && line.endsWith(" differ")) ||
      line === "GIT binary patch"
    ) {
      flushHunk()
      ensureFile().binary = true
      continue
    }

    if (line.startsWith("--- ")) {
      const file = ensureFile()
      const oldPath = normalizePath(line.slice(4))
      file.oldPath = oldPath
      if (!file.newPath && oldPath) file.path = oldPath
      continue
    }

    if (line.startsWith("+++ ")) {
      const file = ensureFile()
      const newPath = normalizePath(line.slice(4))
      file.newPath = newPath
      if (newPath) file.path = newPath
      continue
    }

    if (line.startsWith("@@")) {
      startHunk(line)
      continue
    }

    // A binary payload is not diff rows: `git diff --binary` emits base85,
    // whose alphabet includes "+" and "-", and letting those through would
    // paint a wall of fake added/deleted lines.
    if (getActiveFile()?.binary) continue

    let hunk = getActiveHunk()
    // Auto-create an implicit hunk for patch formats (e.g. *** Add File)
    // that emit +/- lines without a preceding @@ header.
    if (
      !hunk &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
    ) {
      if (getActiveFile()) {
        startHunk("@@")
        hunk = getActiveHunk()
      }
    }
    if (!hunk) continue

    if (line.startsWith("+") && !line.startsWith("+++")) {
      hunk.rows.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newLineCursor,
      })
      const cursor = getNewLineCursor()
      if (cursor !== null) newLineCursor = cursor + 1
      const file = getActiveFile()
      if (file) file.additions += 1
      continue
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      hunk.rows.push({
        kind: "del",
        text: line.slice(1),
        oldLine: oldLineCursor,
        newLine: null,
      })
      const cursor = getOldLineCursor()
      if (cursor !== null) oldLineCursor = cursor + 1
      const file = getActiveFile()
      if (file) file.deletions += 1
      continue
    }

    if (line.startsWith(" ")) {
      hunk.rows.push({
        kind: "context",
        text: line.slice(1),
        oldLine: oldLineCursor,
        newLine: newLineCursor,
      })
      const nextOldCursor = getOldLineCursor()
      if (nextOldCursor !== null) oldLineCursor = nextOldCursor + 1
      const nextNewCursor = getNewLineCursor()
      if (nextNewCursor !== null) newLineCursor = nextNewCursor + 1
    }
  }

  flushHunk()

  return files
    .map((file) => ({
      ...file,
      mode: resolveFileMode(file),
      hunks: file.hunks
        .filter((hunk) => hunk.rows.length > 0)
        .map((hunk) => ({
          key: hunk.key,
          oldStart: hunk.oldStart,
          oldCount: hunk.oldCount,
          newStart: hunk.newStart,
          newCount: hunk.newCount,
          rows: classifyRows(hunk.rows),
        })),
    }))
    .filter((file) => file.hunks.length > 0 || file.binary)
}

function modeKey(
  mode: DiffFileMode
): "mode.added" | "mode.deleted" | "mode.renamed" | "mode.modified" {
  if (mode === "added") return "mode.added"
  if (mode === "deleted") return "mode.deleted"
  if (mode === "renamed") return "mode.renamed"
  return "mode.modified"
}

function toDisplayPath(filePath: string, folderPath: string | null): string {
  const normalizedPath = filePath.replace(/\\/g, "/")
  if (!folderPath) return normalizedPath

  const normalizedFolder = folderPath.replace(/\\/g, "/").replace(/\/+$/, "")
  if (!normalizedFolder) return normalizedPath

  const prefix = `${normalizedFolder}/`
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length)
  }

  return normalizedPath
}

function rowMarker(row: ParsedDiffRow): RowMarker {
  if (row.type === "added") return "added"
  if (row.type === "deleted") return "deleted"
  return "none"
}

/** One half of a side-by-side row. `text === null` marks the filler cell a
 *  delete-only or add-only block leaves on the opposite side. */
export interface SplitCell {
  line: number | null
  text: string | null
  marker: RowMarker
}

export interface SplitRow {
  left: SplitCell
  right: SplitCell
}

const EMPTY_CELL: SplitCell = { line: null, text: null, marker: "none" }

/**
 * Re-pair a hunk's unified rows for the side-by-side view: context rows span
 * both sides, and each delete-run followed by its add-run is zipped
 * positionally — the i-th deleted line faces the i-th added line, and the
 * longer run's remainder faces a filler cell (the same alignment GitHub's
 * split view uses; the lines share a row, they are not claimed to be
 * related).
 */
export function toSplitRows(rows: ParsedDiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let index = 0

  while (index < rows.length) {
    const row = rows[index]
    if (!row) break

    // Everything that is not part of a delete/add run spans both sides. The
    // branch keys off "not added and not deleted" rather than "is context" so
    // that the loop is guaranteed to consume a row on every pass: a row of the
    // fourth `ParsedDiffRow` type ("modified") would otherwise match neither
    // this branch nor either run below, leaving `index` unmoved and spinning
    // the tab forever.
    if (row.type !== "added" && row.type !== "deleted") {
      out.push({
        left: { line: row.oldLine, text: row.text, marker: "none" },
        right: { line: row.newLine, text: row.text, marker: "none" },
      })
      index += 1
      continue
    }

    const dels: ParsedDiffRow[] = []
    const adds: ParsedDiffRow[] = []
    while (index < rows.length && rows[index]?.type === "deleted") {
      dels.push(rows[index]!)
      index += 1
    }
    while (index < rows.length && rows[index]?.type === "added") {
      adds.push(rows[index]!)
      index += 1
    }

    const pairs = Math.max(dels.length, adds.length)
    for (let p = 0; p < pairs; p++) {
      const del = dels[p]
      const add = adds[p]
      out.push({
        left: del
          ? { line: del.oldLine, text: del.text, marker: "deleted" }
          : EMPTY_CELL,
        right: add
          ? { line: add.newLine, text: add.text, marker: "added" }
          : EMPTY_CELL,
      })
    }
  }

  return out
}

function HunkSeparator({ hunk }: { hunk: ParsedDiffHunk }) {
  const label =
    hunk.oldStart != null && hunk.oldCount != null
      ? `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart ?? hunk.oldStart},${hunk.newCount ?? hunk.oldCount} @@`
      : "···"
  return (
    <div className="flex items-center gap-2 border-y border-border/50 bg-muted/30 px-3 py-0.5 font-mono text-2xs text-muted-foreground/60">
      {/* Rides along with the line numbers rather than sliding off to the
          left. Nothing scrolls underneath it, so the band needs no backing. */}
      <span className="sticky left-3 select-none">{label}</span>
    </div>
  )
}

/**
 * Holds the line numbers (and, inline, the +/- sign) against the left edge
 * while the code scrolls under them — the numbers are how you keep your place
 * in a long line, and they were the first thing to leave the screen.
 *
 * `bg-background` is load-bearing: the row tints are translucent, so a rail
 * carrying only its row's tint would let the code slide visibly through the
 * digits. The opaque base goes on the rail and `STICKY_RAIL_TINT` re-applies
 * the row's colour on top, which composites to exactly what the row looks like
 * further right. No `z-index` — a sticky (positioned) box already paints above
 * its static siblings, and adding one here would put the rail above the
 * scrollbars.
 *
 * `left-0` is safe as a physical edge because the scroll bodies pin themselves
 * to `dir="ltr"`; the numbers are always on the physical left.
 */
const STICKY_RAIL = "sticky left-0 flex shrink-0 bg-background"

/**
 * The tinted layer inside the rail. Everything the rail covers goes in here,
 * including the trailing gap that keeps scrolled code off the digits: put that
 * padding on the rail itself and it stays card-coloured, drawing a bare stripe
 * down the middle of every added and deleted row.
 */
const STICKY_RAIL_TINT = "flex pr-1"

function HunkLines({ rows }: { rows: ParsedDiffRow[] }) {
  return (
    <div className="font-mono text-xs leading-[1.25rem]">
      {rows.map((row, i) => {
        const tint = ROW_CLASS[rowMarker(row)]
        return (
          <div key={i} className={cn("flex", tint)}>
            <span className={STICKY_RAIL}>
              <span className={cn(STICKY_RAIL_TINT, tint)}>
                <span className="w-[3.5rem] select-none pr-1 text-right text-muted-foreground/40">
                  {row.oldLine ?? ""}
                </span>
                <span className="w-[3.5rem] select-none pr-1 text-right text-muted-foreground/40">
                  {row.newLine ?? ""}
                </span>
                <span
                  className={cn(
                    "w-4 select-none text-center",
                    SIGN_CLASS[row.sign] ?? ""
                  )}
                >
                  {row.sign === " " ? "" : row.sign}
                </span>
              </span>
            </span>
            <span className="flex-1 whitespace-pre pr-3">{row.text}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Clean file content view for new files (no diff signs, green highlight as added) */
function NewFileLines({ rows }: { rows: ParsedDiffRow[] }) {
  return (
    <div className="font-mono text-xs leading-[1.25rem]">
      {rows.map((row, i) => (
        <div key={i} className={cn("flex", ROW_CLASS.added)}>
          <span className={STICKY_RAIL}>
            <span className={cn(STICKY_RAIL_TINT, ROW_CLASS.added)}>
              <span className="w-[3.5rem] select-none pr-1 text-right text-muted-foreground/40">
                {row.newLine ?? i + 1}
              </span>
            </span>
          </span>
          <span className="flex-1 whitespace-pre pr-3">{row.text}</span>
        </div>
      ))}
    </div>
  )
}

function SplitCellView({ cell }: { cell: SplitCell }) {
  const empty = cell.text === null
  const tint = empty ? "bg-muted/20" : ROW_CLASS[cell.marker]
  return (
    // `min-h-[1.25rem]` (one `leading-[1.25rem]` line) is what holds a filler cell
    // open. It carries neither a number nor text, so its flex line has nothing
    // to give it height: the old single grid let the opposite cell hold the row
    // open, but independent panes each lay out alone, and a collapsed filler
    // slides every row below it one line out of step with the other side.
    <div className={cn("flex min-h-[1.25rem]", tint)}>
      <span className={STICKY_RAIL}>
        <span className={cn(STICKY_RAIL_TINT, tint)}>
          <span
            className={cn(
              "w-[3rem] select-none pr-1 text-right",
              empty ? "text-transparent" : "text-muted-foreground/40"
            )}
          >
            {cell.line ?? ""}
          </span>
        </span>
      </span>
      <span className="flex-1 whitespace-pre pr-3">{cell.text}</span>
    </div>
  )
}

/** A file's hunks, paired for the side-by-side view. Both panes walk this same
 *  list — identical block sequence, identical row heights — which is what keeps
 *  the two sides on the same baseline now that each scrolls on its own. */
interface SplitBlock {
  key: string
  hunk: ParsedDiffHunk
  /** Every hunk but the first is preceded by its `@@` marker. */
  separator: boolean
  rows: SplitRow[]
}

function toSplitBlocks(hunks: ParsedDiffHunk[]): SplitBlock[] {
  return hunks.map((hunk, index) => ({
    key: hunk.key,
    hunk,
    separator: index > 0,
    rows: toSplitRows(hunk.rows),
  }))
}

/** The hunk marker, split across the panes: each side shows only its own
 *  range. The box is identical on both sides so the rows below it stay level. */
function SplitHunkSeparator({
  hunk,
  side,
}: {
  hunk: ParsedDiffHunk
  side: "left" | "right"
}) {
  const start = side === "left" ? hunk.oldStart : hunk.newStart
  const count = side === "left" ? hunk.oldCount : hunk.newCount
  const sign = side === "left" ? "-" : "+"
  const label =
    start != null && count != null ? `@@ ${sign}${start},${count} @@` : "···"
  return (
    <div className="border-y border-border/50 bg-muted/30 px-3 text-2xs text-muted-foreground/60">
      <span className="sticky left-3 inline-block select-none">{label}</span>
    </div>
  )
}

/**
 * One side of the split view. `w-max` sizes the pane to its widest line so the
 * enclosing `x="scroll"` ScrollArea has something to scroll; `min-w-full` keeps
 * a short diff filling its half instead of leaving the row tints ending
 * mid-way.
 */
function SplitPane({
  blocks,
  side,
}: {
  blocks: SplitBlock[]
  side: "left" | "right"
}) {
  return (
    <div className="w-max min-w-full font-mono text-xs leading-[1.25rem]">
      {blocks.map((block) => (
        <Fragment key={block.key}>
          {block.separator && (
            <SplitHunkSeparator hunk={block.hunk} side={side} />
          )}
          {block.rows.map((row, i) => (
            <SplitCellView
              key={i}
              cell={side === "left" ? row.left : row.right}
            />
          ))}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * The side-by-side layout: two independent scroll containers, split down the
 * middle by a draggable handle.
 *
 * Two scrollers rather than one two-column grid, because a shared scroller ties
 * the columns' horizontal position together — scrolling to read the end of a
 * long line on one side drags the other side's text off-screen with it. Each
 * pane now scrolls to its own longest line, and `useSyncedScroll` puts the two
 * back in step so the row under the cursor stays the row under the cursor.
 */
function SplitDiffPanes({
  hunks,
  bounded,
}: {
  hunks: ParsedDiffHunk[]
  /** The section caps its own height, so each pane owns a vertical scrollbar.
   *  When false the host scrolls the whole preview and the panes just grow. */
  bounded: boolean
}) {
  const blocks = useMemo(() => toSplitBlocks(hunks), [hunks])
  const { registerLeft, registerRight, handleLeftScroll, handleRightScroll } =
    useSyncedScroll()

  return (
    <ResizablePanelGroup
      direction="horizontal"
      // A diff is left-to-right whatever the UI language, and under `dir="rtl"`
      // (the app switches the document over for Arabic) every part of this
      // layout inverts: the panes swap so "before" lands on the right,
      // react-resizable-panels reads the group's own computed direction and
      // flips the drag delta, each scrollport reports `scrollLeft` as 0 at its
      // right edge counting down into negatives — which the sync clamp would
      // pin at 0 — and the sticky rail below sticks to the wrong edge. Pinning
      // the body to LTR settles all four at the source.
      dir="ltr"
      // `min-h-0` lets the group shrink inside the section's capped height
      // instead of pushing past it; unbounded, it takes its content's height.
      className={cn("min-h-0", bounded ? undefined : "h-auto")}
    >
      <ResizablePanel defaultSize={50} minSize={20}>
        <ScrollArea
          className={bounded ? "h-full" : undefined}
          x="scroll"
          y={bounded ? "scroll" : "hidden"}
          onViewportRef={registerLeft}
          onScroll={handleLeftScroll}
        >
          <SplitPane blocks={blocks} side="left" />
        </ScrollArea>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={50} minSize={20}>
        <ScrollArea
          className={bounded ? "h-full" : undefined}
          x="scroll"
          y={bounded ? "scroll" : "hidden"}
          onViewportRef={registerRight}
          onScroll={handleRightScroll}
        >
          <SplitPane blocks={blocks} side="right" />
        </ScrollArea>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function isNewFileOnly(file: ParsedDiffFile): boolean {
  return !file.binary && file.mode === "added" && file.deletions === 0
}

/** New files render as plain content in BOTH modes (there is no "before" side
 *  to put anything on), so a diff made only of them has nothing to switch —
 *  offering the toggle there would be a control that visibly does nothing.
 *  Write-tool previews in a transcript are exactly this shape. */
function supportsSplitView(files: ParsedDiffFile[]): boolean {
  return files.some((file) => !file.binary && !isNewFileOnly(file))
}

// Beyond this many rows a single file is rendered as a bounded preview: each
// diff row is its own DOM node (line-number gutters + sign + text), so a
// lockfile or bulk-refactor diff of 5k–20k lines would otherwise build tens of
// thousands of nodes synchronously and freeze the UI for seconds — all just to
// be clipped inside the 420px-tall scroll box. The remainder is one click away.
const MAX_PREVIEW_ROWS = 500

/**
 * Take at most `limit` rows across the file's hunks in order, slicing the hunk
 * that crosses the budget so the preview ends on a clean row. Callers only use
 * this when the file's total row count exceeds `limit`.
 */
function capHunks(hunks: ParsedDiffHunk[], limit: number): ParsedDiffHunk[] {
  const out: ParsedDiffHunk[] = []
  let budget = limit
  for (const hunk of hunks) {
    if (budget <= 0) break
    if (hunk.rows.length <= budget) {
      out.push(hunk)
      budget -= hunk.rows.length
    } else {
      out.push({ ...hunk, rows: hunk.rows.slice(0, budget) })
      budget = 0
    }
  }
  return out
}

function DiffFileSection({
  file,
  view,
  switchView,
  embedded,
  clickableFilePath,
  folderPath,
  unbounded,
}: {
  file: ParsedDiffFile
  view: DiffViewMode
  switchView: (mode: DiffViewMode) => void
  embedded: boolean
  clickableFilePath: boolean
  folderPath: string | null
  unbounded: boolean
}) {
  const t = useTranslations("Folder.diffPreview")
  const [expanded, setExpanded] = useState(false)

  // Reset the reveal when a new diff reparses to a fresh `file` object at this
  // position: sections are keyed positionally (`file-1`, …), so React reuses
  // this instance across a `diffText` change. `file` is referentially stable
  // while `diffText` is unchanged (it comes from a `useMemo`), so this only
  // fires on a real content change. Resetting during render — not in an effect —
  // guarantees the incoming file is never committed in the previous file's
  // expanded (un-capped) state, which would resurface the exact multi-second
  // freeze the cap exists to prevent (React discards this render without
  // reconciling its children, then re-renders capped).
  const [renderedFile, setRenderedFile] = useState(file)
  if (file !== renderedFile) {
    setRenderedFile(file)
    setExpanded(false)
  }

  const newFile = isNewFileOnly(file)

  const totalRows = useMemo(
    () => file.hunks.reduce((sum, hunk) => sum + hunk.rows.length, 0),
    [file.hunks]
  )
  // A large file is capped until the user opts to render the rest. Small files
  // (the common case) keep rendering exactly as before.
  const capped = !expanded && totalRows > MAX_PREVIEW_ROWS
  const hunks = useMemo(
    () => (capped ? capHunks(file.hunks, MAX_PREVIEW_ROWS) : file.hunks),
    [capped, file.hunks]
  )

  return (
    <section
      className={cn(
        "flex flex-col",
        // Self-capped by default: the section owns a scroll box so a huge file
        // can't stretch its host. `unbounded` hands both back to the host (it
        // supplies its own cap + reveal), which keeps the two from nesting.
        unbounded ? "min-h-0" : "max-h-[26.25rem]",
        embedded
          ? "bg-transparent"
          : "rounded-lg border border-border bg-background"
      )}
    >
      {!embedded && (
        // The counters sit with the path they belong to; the far right of the
        // bar is the view toggle's, so it lands in the same spot on every file.
        <header className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-2xs">
          <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-3xs text-muted-foreground">
            {newFile ? "WRITE" : t(modeKey(file.mode))}
          </span>
          {clickableFilePath ? (
            <FilePathLink
              filePath={file.path}
              className="min-w-0 font-mono text-foreground"
              title={file.path}
            >
              {toDisplayPath(file.path, folderPath)}
            </FilePathLink>
          ) : (
            <span
              className="min-w-0 truncate font-mono text-foreground"
              title={file.path}
            >
              {toDisplayPath(file.path, folderPath)}
            </span>
          )}
          {!newFile && !file.binary && (
            // The counters are one LTR unit inside a header that still follows
            // the UI direction: without this, RTL reorders them to "3- 2+",
            // moving each sign behind its number. A no-op everywhere else.
            <span
              dir="ltr"
              className="inline-flex shrink-0 items-center gap-2 font-mono"
            >
              <span className="text-green-700 dark:text-green-400">
                +{file.additions}
              </span>
              <span className="text-red-700 dark:text-red-400">
                -{file.deletions}
              </span>
            </span>
          )}
          {!newFile && !file.binary && (
            <ViewModeToggle
              view={view}
              onSwitch={switchView}
              className="ml-auto"
            />
          )}
        </header>
      )}

      {file.binary ? (
        <div className="px-3 py-2 text-2xs text-muted-foreground">
          {t("binaryFile")}
        </div>
      ) : view === "split" && !newFile ? (
        <SplitDiffPanes hunks={hunks} bounded={!unbounded} />
      ) : (
        // `dir="ltr"` for the same reason the split panes force it: the rows
        // are code, and under `dir="rtl"` the sticky rail would pin itself to
        // the edge the numbers are no longer on.
        <ScrollArea dir="ltr" x="scroll" y={unbounded ? "hidden" : "scroll"}>
          <div className="inline-block min-w-full">
            {newFile
              ? hunks.map((hunk) => (
                  <NewFileLines key={hunk.key} rows={hunk.rows} />
                ))
              : hunks.map((hunk, hunkIdx) => (
                  <div key={hunk.key}>
                    {hunkIdx > 0 && <HunkSeparator hunk={hunk} />}
                    <HunkLines rows={hunk.rows} />
                  </div>
                ))}
          </div>
        </ScrollArea>
      )}

      {capped && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={cn(
            "shrink-0 select-none px-3 py-1 text-left font-mono text-2xs text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            embedded ? "border-t border-border/50" : "border-t border-border"
          )}
        >
          {t("showRemainingLines", { count: totalRows - MAX_PREVIEW_ROWS })}
        </button>
      )}
    </section>
  )
}

export function UnifiedDiffPreview({
  diffText,
  className,
  clickableFilePath = false,
  embedded = false,
  unbounded = false,
  hideViewToggle = false,
}: {
  diffText: string
  /** @deprecated No longer used — kept for API compat */
  modelId?: string
  className?: string
  /** When true, file-name header is clickable and opens the workspace open-file dialog. */
  clickableFilePath?: boolean
  /**
   * When true, render each file's diff WITHOUT its own bordered card + header
   * chrome — just the line grid. For hosts that already frame the diff and
   * label the file (e.g. the reply-artifacts accordion), this avoids a
   * double border and a redundant path/mode header.
   */
  embedded?: boolean
  /**
   * Let each file's diff render at its natural height instead of inside its
   * own 420px scroll box. For hosts that cap and reveal the whole preview
   * themselves (the task diff dialog), which would otherwise nest a vertical
   * scroll inside another one.
   */
  unbounded?: boolean
  /**
   * Suppress the `embedded` layout's own toggle row, for a host that renders
   * `ViewModeToggle` itself somewhere better.
   *
   * The repository panel does: it mounts one preview per expanded file, so the
   * built-in row would appear once per file, halfway down a list, and only
   * after something was expanded — while the control belongs in the header
   * above that list. The mode is one global preference either way (see
   * `useDiffViewMode`), so the host's toggle and every preview under it move
   * together through the same broadcast.
   */
  hideViewToggle?: boolean
}) {
  const t = useTranslations("Folder.diffPreview")
  const { activeFolder: folder } = useActiveFolder()
  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText])
  const [view, switchView] = useDiffViewMode()

  if (!diffText.trim()) {
    return (
      <div
        className={cn(
          "h-full flex items-center justify-center text-xs text-muted-foreground",
          className
        )}
      >
        {t("noDiffData")}
      </div>
    )
  }

  if (files.length === 0) {
    const pre = (
      <pre
        dir="ltr"
        className="font-mono text-2xs leading-5 whitespace-pre-wrap text-muted-foreground p-3"
      >
        {diffText}
      </pre>
    )
    return unbounded ? (
      <div className={className}>{pre}</div>
    ) : (
      <ScrollArea className={cn("h-full", className)} x="scroll">
        {pre}
      </ScrollArea>
    )
  }

  // Unbounded: the host sizes and scrolls the preview, so the outer viewport
  // is a plain box (each file still scrolls horizontally on its own).
  const Frame = unbounded ? UnboundedFrame : ScrollAreaFrame

  return (
    <Frame className={className}>
      <div className={embedded ? "space-y-2" : "space-y-3"}>
        {/* Every file renders its own toggle in its header. Embedded previews
            have no header to put it in, so they keep a row of their own —
            unless the host said it has somewhere better for it. */}
        {embedded && !hideViewToggle && supportsSplitView(files) && (
          <div className="flex items-center justify-end">
            <ViewModeToggle view={view} onSwitch={switchView} />
          </div>
        )}
        {files.map((file) => (
          <DiffFileSection
            key={file.key}
            file={file}
            view={view}
            switchView={switchView}
            embedded={embedded}
            clickableFilePath={clickableFilePath}
            folderPath={folder?.path ?? null}
            unbounded={unbounded}
          />
        ))}
      </div>
    </Frame>
  )
}

/**
 * One button for both layouts, showing the view it switches TO rather than the
 * one already on screen — the icon reads as "go here", which is also what the
 * `viewMode` labels say ("Switch to …"). A pair of buttons spent twice the
 * header's width to say the same thing.
 *
 * Exported for hosts that place it themselves (see `hideViewToggle`). Its
 * chrome is a default rather than a fixture: a host that puts it in a row of
 * its own icon buttons overrides `className`/`iconClassName` so the pair reads
 * as one control set, and the *decision* — which mode is next, which glyph and
 * which label say so — stays in one place regardless.
 */
export function ViewModeToggle({
  view,
  onSwitch,
  className,
  iconClassName,
}: {
  view: DiffViewMode
  onSwitch: (mode: DiffViewMode) => void
  className?: string
  iconClassName?: string
}) {
  const t = useTranslations("Folder.diffPreview")
  const next: DiffViewMode = view === "split" ? "unified" : "split"
  const label = t(`viewMode.${next}`)
  const Icon = next === "split" ? Columns2 : Rows3
  return (
    <button
      type="button"
      onClick={() => onSwitch(next)}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className
      )}
    >
      <Icon className={cn("h-3 w-3", iconClassName)} />
    </button>
  )
}

function ScrollAreaFrame({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <ScrollArea className={cn("h-full", className)} x="scroll">
      {children}
    </ScrollArea>
  )
}

function UnboundedFrame({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return <div className={className}>{children}</div>
}
