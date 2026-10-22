"use client"

import { Fragment, useMemo, useState, type CSSProperties } from "react"
import { useTranslations } from "next-intl"

import type { DiffViewMode } from "@/lib/diff-view-mode-prefs"
import { cn } from "@/lib/utils"
import {
  parseUnifiedDiff,
  toSplitRows,
  type ParsedDiffHunk,
  type ParsedDiffRow,
  type SplitCell,
} from "./unified-diff-preview"

/**
 * Rows rendered before the rest waits behind a "show more" button. Each row is
 * a few DOM nodes, and a rewritten lockfile can run to thousands of them.
 */
const MAX_ROWS = 400

const ROW_TINT: Record<ParsedDiffRow["type"], string> = {
  context: "",
  added: "bg-green-500/10",
  deleted: "bg-red-500/10",
  modified: "bg-blue-500/10",
}

const CELL_TINT: Record<SplitCell["marker"], string> = {
  none: "",
  added: "bg-green-500/10",
  deleted: "bg-red-500/10",
  modified: "bg-blue-500/10",
}

const SIGN_CLASS: Record<ParsedDiffRow["sign"], string> = {
  "+": "text-green-700 dark:text-green-400",
  "-": "text-red-700 dark:text-red-400",
  " ": "",
}

type DiffBlock =
  | { kind: "hunk"; key: string; rows: ParsedDiffRow[] }
  | { kind: "gap"; key: string }
  | { kind: "binary"; key: string }

/** The leading whitespace every non-blank row of `rows` starts with. */
function sharedIndent(rows: readonly ParsedDiffRow[]): string {
  let shared: string | null = null
  for (const row of rows) {
    if (!row.text.trim()) continue
    const indent = /^[ \t]*/.exec(row.text)?.[0] ?? ""
    if (shared === null) {
      shared = indent
    } else {
      let i = 0
      while (
        i < shared.length &&
        i < indent.length &&
        shared[i] === indent[i]
      ) {
        i += 1
      }
      shared = shared.slice(0, i)
    }
    if (shared === "") return ""
  }
  return shared ?? ""
}

/**
 * A hunk's rows with the indentation they all share taken off: the column is
 * narrow, and code nested a few levels deep would otherwise spend half of it
 * on blanks before wrapping. What one row is indented relative to another is
 * kept.
 */
function dedent(rows: ParsedDiffRow[]): ParsedDiffRow[] {
  const indent = sharedIndent(rows)
  if (!indent) return rows
  return rows.map((row) => ({
    ...row,
    text: row.text.startsWith(indent)
      ? row.text.slice(indent.length)
      : row.text.trimStart(),
  }))
}

/**
 * Every file's hunks in order, a gap between each two. A diff here is one
 * file's — possibly several edits to it, one after another — so the files'
 * own headers have nothing to add.
 */
function toBlocks(diffText: string): DiffBlock[] {
  const blocks: DiffBlock[] = []
  for (const file of parseUnifiedDiff(diffText)) {
    if (file.binary) {
      if (blocks.length > 0)
        blocks.push({ kind: "gap", key: `${file.key}:gap` })
      blocks.push({ kind: "binary", key: file.key })
      continue
    }
    file.hunks.forEach((hunk: ParsedDiffHunk) => {
      if (blocks.length > 0)
        blocks.push({ kind: "gap", key: `${hunk.key}:gap` })
      blocks.push({ kind: "hunk", key: hunk.key, rows: dedent(hunk.rows) })
    })
  }
  return blocks
}

/** `blocks` cut to `limit` rows, ending on a clean row. */
function capBlocks(blocks: DiffBlock[], limit: number): DiffBlock[] {
  const out: DiffBlock[] = []
  let budget = limit
  for (const block of blocks) {
    if (budget <= 0) break
    if (block.kind !== "hunk") {
      out.push(block)
      continue
    }
    out.push(
      block.rows.length <= budget
        ? block
        : { ...block, rows: block.rows.slice(0, budget) }
    )
    budget -= block.rows.length
  }
  // A cut can leave a separator with nothing after it.
  while (out.length > 0 && out[out.length - 1].kind === "gap") out.pop()
  return out
}

function countRows(blocks: DiffBlock[]): number {
  let total = 0
  for (const block of blocks) {
    if (block.kind === "hunk") total += block.rows.length
  }
  return total
}

/** The line number a row is shown with inline: a removed line's in the old
 *  file, any other line's in the new one. */
function lineOf(row: ParsedDiffRow): number | null {
  return row.type === "deleted" ? row.oldLine : row.newLine
}

/** Digits in the widest line number `blocks` show (at least two). Side by
 *  side, both sides' numbers show. */
function gutterDigits(blocks: DiffBlock[], view: DiffViewMode): number {
  let max = 0
  for (const block of blocks) {
    if (block.kind !== "hunk") continue
    for (const row of block.rows) {
      max = Math.max(
        max,
        view === "split"
          ? Math.max(row.oldLine ?? 0, row.newLine ?? 0)
          : (lineOf(row) ?? 0)
      )
    }
  }
  return Math.max(2, String(max).length)
}

function UnifiedRows({
  rows,
  gutterStyle,
}: {
  rows: ParsedDiffRow[]
  gutterStyle: CSSProperties
}) {
  return rows.map((row, index) => (
    <div
      key={index}
      data-diff-row={row.type}
      className={cn("flex", ROW_TINT[row.type])}
    >
      <span
        style={gutterStyle}
        className="shrink-0 pe-1.5 text-end text-muted-foreground/50 tabular-nums select-none"
      >
        {lineOf(row) ?? ""}
      </span>
      <span
        className={cn(
          "w-3 shrink-0 text-center select-none",
          SIGN_CLASS[row.sign]
        )}
      >
        {row.sign === " " ? "" : row.sign}
      </span>
      <span className="min-w-0 flex-1 pe-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {/* A blank line still takes its line. */}
        {row.text || " "}
      </span>
    </div>
  ))
}

function SplitCellView({
  cell,
  start,
  gutterStyle,
}: {
  cell: SplitCell
  /** The old side, which rules the two apart. */
  start: boolean
  gutterStyle: CSSProperties
}) {
  const filler = cell.text === null
  return (
    <div
      data-diff-cell={filler ? "filler" : cell.marker}
      className={cn(
        "flex min-w-0",
        filler ? "bg-muted/40" : CELL_TINT[cell.marker],
        start && "border-e border-border/60"
      )}
    >
      {!filler && (
        <>
          <span
            style={gutterStyle}
            className="shrink-0 pe-1 text-end text-muted-foreground/50 tabular-nums select-none"
          >
            {cell.line ?? ""}
          </span>
          <span className="min-w-0 flex-1 ps-1 pe-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {cell.text || " "}
          </span>
        </>
      )}
    </div>
  )
}

/** A hunk side by side: old on the left, new on the right, a delete-run
 *  facing the add-run that replaced it (`toSplitRows`). A row is as tall as
 *  the taller of its two wrapped lines. */
function SplitRows({
  rows,
  gutterStyle,
}: {
  rows: ParsedDiffRow[]
  gutterStyle: CSSProperties
}) {
  const pairs = useMemo(() => toSplitRows(rows), [rows])
  return (
    <div className="grid grid-cols-2">
      {pairs.map((pair, index) => (
        <Fragment key={index}>
          <SplitCellView cell={pair.left} start gutterStyle={gutterStyle} />
          <SplitCellView
            cell={pair.right}
            start={false}
            gutterStyle={gutterStyle}
          />
        </Fragment>
      ))}
    </div>
  )
}

/**
 * A diff drawn for a narrow column — the Session Details side panel, where a
 * file's changes open inline under its row. Unlike `UnifiedDiffPreview` its
 * line-number gutters are only as wide as their numbers, and it wraps long
 * lines instead of scrolling them sideways, so a change can be read without
 * leaving the panel; `view` lays it out inline or side by side.
 *
 * It draws no frame and no scroll box of its own: the host frames it, and a
 * tall diff grows the panel, which already scrolls, rather than trapping the
 * wheel in a box inside it. A very long one shows its first rows and offers
 * the rest.
 */
export function CompactDiff({
  diffText,
  view = "unified",
  className,
}: {
  diffText: string
  view?: DiffViewMode
  className?: string
}) {
  const t = useTranslations("Folder.diffPreview")
  const blocks = useMemo(() => toBlocks(diffText), [diffText])
  const [expanded, setExpanded] = useState(false)
  // Reset the reveal when the diff changes under it (a streaming reply adds an
  // edit): during render, so the longer diff is never committed uncapped.
  const [renderedText, setRenderedText] = useState(diffText)
  if (renderedText !== diffText) {
    setRenderedText(diffText)
    setExpanded(false)
  }
  const rawLines = useMemo(
    () => (blocks.length === 0 ? diffText.split("\n") : []),
    [blocks, diffText]
  )
  const totalRows = useMemo(
    () => (blocks.length === 0 ? rawLines.length : countRows(blocks)),
    [blocks, rawLines]
  )
  const capped = !expanded && totalRows > MAX_ROWS
  const shown = useMemo(
    () => (capped ? capBlocks(blocks, MAX_ROWS) : blocks),
    [capped, blocks]
  )
  // The gutter is as wide as the numbers it holds: in a narrow column every
  // character it doesn't need is one more a line of code can keep.
  const digits = useMemo(() => gutterDigits(shown, view), [shown, view])
  const gutterStyle = useMemo(
    () => ({ width: `calc(${digits}ch + 0.625rem)` }),
    [digits]
  )

  const root = cn(
    "bg-background font-mono text-2xs leading-[1.125rem] [tab-size:2]",
    className
  )

  if (!diffText.trim()) {
    return (
      <div className={cn(root, "px-2 py-1.5 font-sans text-muted-foreground")}>
        {t("noDiffData")}
      </div>
    )
  }

  const showMore = capped && (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      className="w-full border-t border-border/70 px-2 py-1 text-start font-sans text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
    >
      {t("showRemainingLines", { count: totalRows - MAX_ROWS })}
    </button>
  )

  if (blocks.length === 0) {
    // Not a diff we can read: show it as it came.
    return (
      <div className={root}>
        <pre
          dir="ltr"
          className="px-2 py-1.5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]"
        >
          {capped ? rawLines.slice(0, MAX_ROWS).join("\n") : diffText}
        </pre>
        {showMore}
      </div>
    )
  }

  return (
    <div className={root}>
      {/* Code reads left to right whatever the UI language. */}
      <div dir="ltr" className="py-0.5">
        {shown.map((block) => (
          <Fragment key={block.key}>
            {block.kind === "gap" ? (
              <div
                aria-hidden="true"
                className="my-0.5 border-y border-dashed border-border/60 bg-muted/30 px-2 leading-3 text-muted-foreground/60 select-none"
              >
                ⋯
              </div>
            ) : block.kind === "binary" ? (
              <div className="px-2 py-1 font-sans text-muted-foreground">
                {t("binaryFile")}
              </div>
            ) : view === "split" ? (
              <SplitRows rows={block.rows} gutterStyle={gutterStyle} />
            ) : (
              <UnifiedRows rows={block.rows} gutterStyle={gutterStyle} />
            )}
          </Fragment>
        ))}
      </div>
      {showMore}
    </div>
  )
}
