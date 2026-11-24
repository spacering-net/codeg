"use client"

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import {
  parseUnifiedDiff,
  toSplitRows,
  ViewModeToggle,
  type ParsedDiffFile,
  type SplitCell,
} from "@/components/diff/unified-diff-preview"
import { useSyncedScroll } from "@/components/diff/use-synced-scroll"
import { FilePathLink } from "@/components/ai-elements/link-safety"
import { editDiffText } from "@/lib/activity/edit"
import { splitPathForDisplay } from "@/lib/activity/format"
import { useDiffViewMode } from "@/lib/diff-view-mode-prefs"
import { cn } from "@/lib/utils"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { DetailBox, DetailScroll } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { FileHeader } from "../file-header"
import { RailIcon } from "../rail-icon"
import { ResultBody } from "../result-body"
import {
  DiffFigure,
  ToolFigure,
  toolIcon,
  useStatusText,
} from "../step-visuals"
import { useDisplayPath, type ToolStep } from "./explore-rows"

/** A diff past either bound opens as a preview of its first rows. */
const LARGE_DIFF_ROWS = 600
const LARGE_DIFF_CHARS = 80_000
const PREVIEW_ROWS = 240

/** `agent/src/hvac_agent/query_tasks.py`, in the label's light ink like a
 *  command line; the directory is what truncates, the name stays whole. */
function PathLabel({ path }: { path: string }) {
  const { dir, name } = splitPathForDisplay(path)
  return (
    <span
      className="flex min-w-0 items-baseline font-mono text-[0.8125rem] text-activity-secondary"
      dir="ltr"
    >
      {dir ? <span className="min-w-0 truncate">{dir}</span> : null}
      <span className="shrink-0">{name}</span>
    </span>
  )
}

/**
 * `Edited agent/src/hvac_agent/query_tasks.py L44–46   +3 −1`. The verb
 * follows the state (Editing while it runs, Created / Deleted / Moved for
 * those operations), counts appear once it has finished, and the line range
 * only when the payload carried real positions. Folded by default.
 */
export const EditRow = memo(function EditRow({ step }: { step: ToolStep }) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { recoveredKeys } = useActivityRender()
  const { tool, part } = step
  const files = useMemo(() => tool.files ?? [], [tool.files])
  const single = files.length === 1 ? files[0]! : null
  const displayPath = useDisplayPath(single?.path)
  const failed = tool.status === "failed" || tool.status === "rejected"
  const live = tool.status === "running" || tool.status === "pending"
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force:
      (failed && !recoveredKeys.has(step.key)) || tool.status === "awaiting",
  })
  const diff = useMemo(
    () => editDiffText(tool.toolName, part.input, part.output ?? null),
    [tool.toolName, part.input, part.output]
  )
  const errorText = failed ? (part.errorText ?? part.output ?? null) : null
  const expandable = !!diff || !!errorText?.trim()

  const verb = live
    ? t("row.editing")
    : single?.op === "add" || single?.op === "write"
      ? t("row.created")
      : single?.op === "delete"
        ? t("row.deleted")
        : single?.op === "move"
          ? t("row.moved")
          : t("row.edited")

  return (
    <ActivityRow
      stepKey={step.key}
      approval={step.tool.approval}
      status={tool.status}
      marker={
        <RailIcon
          icon={toolIcon(tool)}
          status={tool.status}
          label={`${t("kind.edit")}, ${statusText(tool.status)}`}
        />
      }
      expandable={expandable}
      expanded={open}
      onExpandedChange={setOpen}
      title={single?.path}
      trailing={<ToolFigure tool={tool} />}
      detail={() => (
        <div className="space-y-2">
          {errorText ? (
            <DetailBox tone="danger" anchor="end">
              <ResultBody text={errorText} tone="danger" />
            </DetailBox>
          ) : null}
          {diff ? (
            <EditDiff
              diffText={diff.text}
              numbered={diff.numbered}
              noBefore={diff.noBefore ?? false}
              path={single?.path}
              displayPath={displayPath}
            />
          ) : null}
        </div>
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 font-medium",
            live ? "activity-shimmer" : "text-activity-secondary"
          )}
        >
          {single || files.length === 0
            ? verb
            : t("row.editedFiles", { count: files.length })}
        </span>
        {single ? (
          <>
            <PathLabel path={displayPath ?? single.path} />
            {single.lineRange && !live ? (
              <span
                className="shrink-0 font-mono text-[0.8125rem] text-activity-secondary"
                dir="ltr"
              >
                {single.lineRange.start === single.lineRange.end
                  ? t("metric.line", { line: single.lineRange.start })
                  : t("metric.lineRange", {
                      start: single.lineRange.start,
                      end: single.lineRange.end,
                    })}
              </span>
            ) : null}
          </>
        ) : null}
      </span>
    </ActivityRow>
  )
})

/**
 * The edit's diff in a bordered box under a header naming the file (it opens
 * it in the file tabs), with its counts and a switch between the inline and
 * the side-by-side view — the one diff view preference the app keeps. Inline:
 * one line-number column (the old number for a removed line, the new one
 * otherwise — left blank where the payload had no real positions), a sign
 * column, and the code, the box scrolling both ways; side by side: the old
 * and the new text in two halves that each scroll both ways, together, so
 * each half's sideways scrollbar sits at the foot of what shows rather than
 * under rows scrolled out of view — the box itself does not scroll, and every
 * file caps its own height. Multi-file edits get a header per file. Big diffs
 * open as a preview.
 */
export const EditDiff = memo(function EditDiff({
  diffText,
  numbered,
  noBefore = false,
  path,
  displayPath,
}: {
  diffText: string
  numbered: boolean
  /** Drawn from an empty old text (a write's new content): no "before". */
  noBefore?: boolean
  /** The edited file, as the row has it — opened from the header. */
  path?: string
  /** That path as the row shows it. */
  displayPath?: string
}) {
  const t = useTranslations("Folder.chat.activity")
  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText])
  const [view, switchView] = useDiffViewMode()
  // Side by side only says something next to a "before".
  const sideBySide = (file: ParsedDiffFile) =>
    !file.binary && !addsOnly(file, noBefore)
  const switchable = files.some(sideBySide)
  // Side by side, the files scroll themselves (see above).
  const split = view === "split" && switchable
  const totalRows = useMemo(
    () =>
      files.reduce(
        (sum, file) =>
          sum + file.hunks.reduce((n, hunk) => n + hunk.rows.length, 0),
        0
      ),
    [files]
  )
  const large =
    totalRows > LARGE_DIFF_ROWS || diffText.length > LARGE_DIFF_CHARS
  const [showAll, setShowAll] = useState(false)
  const visibleFiles = useMemo(
    () => (large && !showAll ? limitDiffRows(files, PREVIEW_ROWS) : files),
    [files, large, showAll]
  )

  if (files.length === 0) {
    return (
      <DetailBox tone="plain">
        <ResultBody text={diffText} />
      </DetailBox>
    )
  }

  const single = files.length === 1 ? files[0]! : null
  const figures = (
    <>
      <DiffFigure
        additions={files.reduce((sum, file) => sum + file.additions, 0)}
        deletions={files.reduce((sum, file) => sum + file.deletions, 0)}
      />
      {switchable ? (
        <ViewModeToggle
          view={view}
          onSwitch={switchView}
          className="border-transparent bg-transparent"
        />
      ) : null}
    </>
  )

  return (
    <DetailBox
      tone="plain"
      unbounded={split}
      header={
        single ? (
          <FileHeader
            path={path ?? single.path}
            displayPath={displayPath}
            line={numbered ? firstLine(single) : null}
          >
            {figures}
          </FileHeader>
        ) : (
          <>
            <span className="activity-mono">
              {t("metric.files", { count: files.length })}
            </span>
            <span className="ms-auto flex shrink-0 items-center gap-3">
              {figures}
            </span>
          </>
        )
      }
      footer={
        large && !showAll ? t("detail.lines", { count: totalRows }) : null
      }
      actions={
        large && !showAll ? (
          <button
            type="button"
            className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setShowAll(true)}
          >
            {t("detail.showAll", { count: totalRows })}
          </button>
        ) : null
      }
    >
      <div
        className="min-w-full font-mono text-[0.78125rem] leading-relaxed"
        dir="ltr"
      >
        {visibleFiles.map((file) => (
          <DiffFileBlock
            key={file.key}
            file={file}
            showHeader={files.length > 1}
            numbered={numbered}
            split={split && sideBySide(file)}
            scrolls={split}
          />
        ))}
      </div>
    </DetailBox>
  )
})

/** A file with no "before" to set beside it: one a patch adds, or one the
 *  diff draws from an empty old text (`noBefore`: a write's new content). An
 *  insertion into an existing file still has one — the file around it — even
 *  where its hunk numbers cannot say so (`@@ -0,0` at the top of the file). */
function addsOnly(file: ParsedDiffFile, noBefore: boolean): boolean {
  return file.deletions === 0 && (file.mode === "added" || noBefore)
}

/** Where the change starts in the new file — none for a file deleted whole. */
function firstLine(file: ParsedDiffFile): number | null {
  const start = file.hunks[0]?.newStart
  return start != null && start > 0 ? start : null
}

/** The first `budget` rows of a diff, cut at hunk and file boundaries. */
function limitDiffRows(
  files: ParsedDiffFile[],
  budget: number
): ParsedDiffFile[] {
  const out: ParsedDiffFile[] = []
  let remaining = budget
  for (const file of files) {
    if (remaining <= 0) break
    const hunks: ParsedDiffFile["hunks"] = []
    for (const hunk of file.hunks) {
      if (remaining <= 0) break
      const rows = hunk.rows.slice(0, remaining)
      remaining -= rows.length
      hunks.push({ ...hunk, rows })
    }
    out.push({ ...file, hunks })
  }
  return out
}

function DiffFileBlock({
  file,
  showHeader,
  numbered,
  split,
  scrolls,
}: {
  file: ParsedDiffFile
  showHeader: boolean
  numbered: boolean
  /** Side by side: on, and the file has a "before" to set beside it. */
  split: boolean
  /** The box does not scroll (side by side is on): the file scrolls itself,
   *  even one drawn inline for having no "before". */
  scrolls: boolean
}) {
  return (
    <div>
      {showHeader ? (
        <div className="flex items-center gap-2 border-y border-foreground/5 bg-muted/40 px-3 py-1 first:border-t-0">
          <FilePathLink
            filePath={file.path}
            className="min-w-0 truncate text-foreground"
          >
            {file.path}
          </FilePathLink>
          <DiffFigure
            additions={file.additions}
            deletions={file.deletions}
            className="ms-auto shrink-0 text-2xs"
          />
        </div>
      ) : null}
      {split ? (
        <SplitHunks file={file} numbered={numbered} />
      ) : scrolls ? (
        <DetailScroll>
          <UnifiedHunks file={file} numbered={numbered} />
        </DetailScroll>
      ) : (
        <UnifiedHunks file={file} numbered={numbered} />
      )}
    </div>
  )
}

/** The inline view: the file's rows in order, a sign in front of each — as
 *  wide as its longest line, so a row's tint runs on under a line scrolled
 *  into view sideways. */
function UnifiedHunks({
  file,
  numbered,
}: {
  file: ParsedDiffFile
  numbered: boolean
}) {
  return (
    <div className="w-max min-w-full">
      {file.hunks.map((hunk, hunkIndex) => (
        <div
          key={hunk.key}
          className={cn(
            hunkIndex > 0 && "border-t border-dashed border-foreground/10"
          )}
        >
          {hunk.rows.map((row, index) => (
            <div
              key={index}
              className={cn(
                "flex",
                row.type === "added" && "bg-diff-added",
                row.type === "deleted" && "bg-diff-deleted"
              )}
            >
              <span className="w-11 shrink-0 select-none pe-2 text-end tabular-nums text-muted-foreground">
                {numbered
                  ? ((row.type === "deleted" ? row.oldLine : row.newLine) ?? "")
                  : ""}
              </span>
              <span
                className={cn(
                  "w-4 shrink-0 select-none text-center",
                  row.sign === "+" && "text-diff-added-fg",
                  row.sign === "-" && "text-diff-deleted-fg"
                )}
              >
                {row.sign === " " ? "" : row.sign === "-" ? "−" : row.sign}
              </span>
              <span className="flex-1 whitespace-pre pe-4">{row.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The side-by-side view: the old text on the left and the new on the right.
 * Each half is a scroll body of its own, capped at the box's height (the box
 * itself is `unbounded` and does not scroll), as in the workspace's diff
 * view: its sideways scrollbar is at the foot of what shows, not under rows
 * scrolled out of view. It scrolls sideways as far as its own longest line,
 * and the two move together, both ways (`useSyncedScroll`): the line read on
 * one side stays beside its pair, and where one half runs out of line, it
 * stops there instead of pulling the other back. Both halves walk the same
 * paired rows, one line each, so they stay level.
 */
function SplitHunks({
  file,
  numbered,
}: {
  file: ParsedDiffFile
  numbered: boolean
}) {
  const hunks = useMemo(
    () =>
      file.hunks.map((hunk) => ({
        key: hunk.key,
        rows: toSplitRows(hunk.rows),
      })),
    [file.hunks]
  )
  const { registerLeft, registerRight, handleLeftScroll, handleRightScroll } =
    useSyncedScroll()
  return (
    <div className="grid grid-cols-2">
      {(["left", "right"] as const).map((side) => (
        <DetailScroll
          key={side}
          className={cn(
            "min-w-0",
            side === "right" && "border-s border-foreground/5"
          )}
          onViewportRef={side === "left" ? registerLeft : registerRight}
          onScroll={side === "left" ? handleLeftScroll : handleRightScroll}
        >
          <div className="w-max min-w-full">
            {hunks.map((hunk, hunkIndex) => (
              <div
                key={hunk.key}
                className={cn(
                  hunkIndex > 0 && "border-t border-dashed border-foreground/10"
                )}
              >
                {hunk.rows.map((row, index) => (
                  <SplitLine key={index} cell={row[side]} numbered={numbered} />
                ))}
              </div>
            ))}
          </div>
        </DetailScroll>
      ))}
    </div>
  )
}

/** One half of a side-by-side row; a filler where the other side has a line
 *  this one does not. */
function SplitLine({ cell, numbered }: { cell: SplitCell; numbered: boolean }) {
  const filler = cell.text === null
  return (
    <div
      className={cn(
        // One line tall even with nothing in it, so the halves stay level.
        "flex min-h-[1.625em]",
        cell.marker === "added" && "bg-diff-added",
        cell.marker === "deleted" && "bg-diff-deleted",
        filler && "bg-muted/40"
      )}
    >
      <span className="w-11 shrink-0 select-none pe-2 text-end tabular-nums text-muted-foreground">
        {numbered ? (cell.line ?? "") : ""}
      </span>
      <span className="flex-1 whitespace-pre pe-4">{cell.text}</span>
    </div>
  )
}
