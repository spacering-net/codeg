"use client"

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { useActiveFolder } from "@/contexts/active-folder-context"
import { parseReadOutput, searchResultText } from "@/lib/activity/explore"
import type {
  ActivityStep,
  StepStatus,
  ToolDescriptor,
} from "@/lib/activity/types"
import { toFolderRelativePath } from "@/lib/file-path-display"
import { localImageMime } from "@/lib/markdown-local-image"
import { cn } from "@/lib/utils"
import { ReadImagePreview } from "../../read-image-preview"
import { SearchResultsOutput } from "../../search-results-output"
import { useActivityRender } from "../activity-context"
import { ActivityMembers, ActivityRow, useGroupPlace } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { FileHeader } from "../file-header"
import { RailDot, RailIcon } from "../rail-icon"
import { ResultBody } from "../result-body"
import {
  GROUP_ICON,
  ToolFigure,
  ToolNotes,
  toolIcon,
  useStatusText,
} from "../step-visuals"
import { useAwaitedStep, useLiveToolStep } from "../use-live-step"

type ToolStep = Extract<ActivityStep, { type: "tool" }>

/** Lines a read shows before "show all". */
const READ_PREVIEW_LINES = 40

/** A workspace file shown relative to the open folder, else as given. */
export function useDisplayPath(path: string | undefined): string | undefined {
  const { activeFolder } = useActiveFolder()
  return useMemo(
    () =>
      path === undefined
        ? undefined
        : toFolderRelativePath(path, activeFolder?.path ?? undefined),
    [path, activeFolder?.path]
  )
}

/** "3 files, 1 search" for an explore group's header. */
function useExploreSummary(steps: ToolStep[]): string {
  const t = useTranslations("Folder.chat.activity")
  return useMemo(() => {
    const files = new Set<string>()
    let searches = 0
    let listings = 0
    let pages = 0
    let webSearches = 0
    let memories = 0
    for (const step of steps) {
      const { tool } = step
      switch (tool.kind) {
        case "read":
          files.add(tool.target?.path ?? tool.target?.text ?? step.key)
          break
        case "search":
          searches += 1
          break
        case "glob":
        case "list":
          listings += 1
          break
        case "fetch":
          pages += 1
          break
        case "web-search":
          webSearches += 1
          break
        case "memory":
          memories += 1
          break
      }
    }
    const parts: string[] = []
    if (files.size > 0) parts.push(t("explore.files", { count: files.size }))
    if (searches > 0) parts.push(t("explore.searches", { count: searches }))
    if (listings > 0) parts.push(t("explore.listings", { count: listings }))
    if (pages > 0) parts.push(t("explore.pages", { count: pages }))
    if (webSearches > 0) {
      parts.push(t("explore.webSearches", { count: webSearches }))
    }
    if (memories > 0) parts.push(t("explore.memories", { count: memories }))
    return parts.join(t("row.listJoiner"))
  }, [steps, t])
}

/**
 * "Explored · 3 files, 1 search": a run of reads and searches. Folded unless a
 * member failed without being redone. Open, its members end on a foot that
 * turns while more may join the run, then folds it. Folded while the run is
 * the reply's last row, the member that is running shows under the header,
 * so the current step is never hidden; once the reply has moved past, a
 * member still running stays inside.
 */
export const ExploreGroupRow = memo(function ExploreGroupRow({
  groupKey,
  steps,
  status: given,
  followed = false,
}: {
  groupKey: string
  steps: ToolStep[]
  status: StepStatus
  /** Something follows the group in the reply: a row, or the answer. */
  followed?: boolean
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { recoveredKeys } = useActivityRender()
  const summary = useExploreSummary(steps)
  const failedOpen = steps.some(
    (s) =>
      (s.tool.status === "failed" || s.tool.status === "rejected") &&
      !recoveredKeys.has(s.key)
  )
  const awaited = useAwaitedStep(steps)
  const [open, setOpen] = useDisclosure(`group:${groupKey}`, {
    defaultOpen: false,
    force: failedOpen,
  })
  const status = awaited ? "awaiting" : given
  const live = status === "running" || status === "pending"
  const { current, going } = useGroupPlace(followed)
  const liveStep = open
    ? null
    : (awaited ?? (current && live ? lastLiveTool(steps) : null))

  return (
    <ActivityRow
      stepKey={groupKey}
      motionKey={`group:${groupKey}`}
      status={status}
      marker={
        <RailIcon
          icon={GROUP_ICON}
          status={status}
          label={`${t("kind.explore")}, ${statusText(status)}`}
        />
      }
      expandable
      expanded={open}
      onExpandedChange={setOpen}
      addon={
        liveStep ? (
          <ActivityMembers>
            <ExploreChildRow step={liveStep} />
          </ActivityMembers>
        ) : null
      }
      trailing={
        failedOpen ? (
          <span className="text-tone-danger">
            {t("metric.someFailed", {
              count: steps.filter(
                (s) =>
                  s.tool.status === "failed" || s.tool.status === "rejected"
              ).length,
            })}
          </span>
        ) : null
      }
      detail={() => (
        <ActivityMembers
          foot={{
            working: going,
            after: "dot",
            motionScope: groupKey,
            what: summary,
            onFold: () => setOpen(false),
          }}
        >
          {steps.map((step) => (
            <ExploreChildRow key={step.key} step={step} />
          ))}
        </ActivityMembers>
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 font-medium",
            live ? "activity-shimmer" : "text-activity-secondary"
          )}
        >
          {live || awaited ? t("row.exploring") : t("row.explored")}
        </span>
        <span className="min-w-0 truncate text-activity-secondary">
          {summary}
        </span>
      </span>
    </ActivityRow>
  )
})

function lastLiveTool(steps: ToolStep[]): ToolStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!
    if (step.tool.status === "running" || step.tool.status === "pending") {
      return step
    }
  }
  return null
}

const VERB_KEY = {
  read: "verb.read",
  search: "verb.search",
  glob: "verb.glob",
  list: "verb.list",
  fetch: "verb.fetch",
  "web-search": "verb.webSearch",
  memory: "verb.memory",
} as const

const STEP_VERB_KEY = {
  read: "stepVerb.read",
  search: "stepVerb.search",
  glob: "stepVerb.glob",
  list: "stepVerb.list",
  fetch: "stepVerb.fetch",
  "web-search": "stepVerb.webSearch",
  memory: "stepVerb.memory",
} as const

/**
 * One read or search. Inside an explore group it is a child row —
 * `read  agent/src/q.py  212 lines`, with the verb as a short monospace
 * column; on its own it is a full row with its own ring: `Read
 * agent/src/q.py  212 lines`.
 */
export const ExploreChildRow = memo(function ExploreChildRow({
  step: given,
  standalone = false,
}: {
  step: ToolStep
  standalone?: boolean
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { recoveredKeys } = useActivityRender()
  const step = useLiveToolStep(given)
  const { tool, part } = step
  const known = tool.kind in VERB_KEY
  const path = useDisplayPath(tool.target?.path)
  const hasDetail = exploreHasDetail(tool, part.output ?? null, part.errorText)
  const failed = tool.status === "failed" || tool.status === "rejected"
  const live = tool.status === "running" || tool.status === "pending"
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force:
      (failed && !recoveredKeys.has(step.key)) || tool.status === "awaiting",
  })
  const targetText = path ?? tool.target?.text ?? ""

  return (
    <ActivityRow
      stepKey={step.key}
      status={tool.status}
      variant={standalone ? "main" : "child"}
      markerKind={standalone ? "ring" : "dot"}
      marker={
        standalone ? (
          <RailIcon
            icon={toolIcon(tool)}
            status={tool.status}
            label={`${t(tool.kind === "read" ? "kind.read" : "kind.search")}, ${statusText(tool.status)}`}
          />
        ) : (
          <RailDot
            className={cn(
              failed && "bg-tone-danger",
              live && "animate-pulse bg-foreground/60"
            )}
          />
        )
      }
      expandable={hasDetail}
      expanded={open}
      onExpandedChange={setOpen}
      title={tool.target?.full ?? tool.target?.path ?? undefined}
      approval={tool.approval}
      trailing={<ToolFigure tool={tool} />}
      detail={() => <ExploreDetail step={step} />}
    >
      <span
        className={cn(
          "flex min-w-0 items-baseline",
          standalone ? "gap-2" : "gap-3"
        )}
      >
        {known ? (
          standalone ? (
            <span className="shrink-0 font-medium text-activity-secondary">
              {t(STEP_VERB_KEY[tool.kind as keyof typeof STEP_VERB_KEY])}
            </span>
          ) : (
            <span className="activity-mono w-14 shrink-0 text-activity-secondary">
              {t(VERB_KEY[tool.kind as keyof typeof VERB_KEY])}
            </span>
          )
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate font-mono text-activity-secondary",
            standalone && "text-[0.8125rem]"
          )}
          dir="ltr"
        >
          {targetText}
        </span>
        {tool.detail ? (
          <span className="min-w-0 shrink truncate font-sans text-activity-secondary">
            {tool.detail}
          </span>
        ) : null}
        <ToolNotes notes={tool.notes} />
      </span>
    </ActivityRow>
  )
})

function exploreHasDetail(
  tool: ToolDescriptor,
  output: string | null,
  errorText: string | undefined
): boolean {
  if (errorText?.trim()) return true
  if (tool.kind === "read" && tool.target?.path) {
    if (localImageMime(tool.target.path)) return true
  }
  return !!output?.trim()
}

function ExploreDetail({ step }: { step: ToolStep }) {
  const { tool, part } = step
  const failed = tool.status === "failed" || tool.status === "rejected"
  if (failed || (part.errorText && !part.output)) {
    return (
      <DetailBox tone="danger" anchor="end">
        <ResultBody text={part.errorText ?? part.output ?? ""} tone="danger" />
      </DetailBox>
    )
  }
  if (tool.kind === "read") return <ReadDetail step={step} />
  if (tool.kind === "search" || tool.kind === "glob" || tool.kind === "list") {
    const text = searchResultText(
      tool.toolName.toLowerCase(),
      part.output,
      part.errorText
    )
    if (text !== null) {
      return (
        <DetailBox tone="neutral" bodyClassName="py-2">
          <SearchResultsOutput
            text={text}
            query={
              tool.kind === "search"
                ? (tool.target?.full ?? tool.target?.text)
                : null
            }
          />
        </DetailBox>
      )
    }
  }
  return (
    <DetailBox tone="neutral">
      <ResultBody text={part.output ?? ""} />
    </DetailBox>
  )
}

function ReadDetail({ step }: { step: ToolStep }) {
  const t = useTranslations("Folder.chat.activity")
  const path = step.tool.target?.path
  const displayPath = useDisplayPath(path)
  const imageMime = path ? localImageMime(path) : null
  const [showAll, setShowAll] = useState(false)
  const parsed = useMemo(
    () => (step.part.output ? parseReadOutput(step.part.output) : null),
    [step.part.output]
  )
  const lines = useMemo(
    () => (parsed ? parsed.content.replace(/\n$/, "").split("\n") : []),
    [parsed]
  )
  if (imageMime && path) {
    // The picture, and whatever text the read answered with beside it
    // (OpenCode says "Image read successfully"; codex's view_image says
    // nothing at all).
    const note = parsed?.content.trim()
    return (
      <DetailBox
        tone="neutral"
        bodyClassName="p-2"
        header={<FileHeader path={path} displayPath={displayPath} />}
      >
        <ReadImagePreview path={path} mime={imageMime} />
        {note ? (
          <p
            className="whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[0.78125rem] leading-relaxed text-muted-foreground"
            dir="auto"
          >
            {note}
          </p>
        ) : null}
      </DetailBox>
    )
  }
  if (!parsed) return null
  const visible = showAll ? lines : lines.slice(0, READ_PREVIEW_LINES)
  return (
    <DetailBox
      tone="neutral"
      header={
        path ? (
          <FileHeader
            path={path}
            displayPath={displayPath}
            line={parsed.startLine}
          />
        ) : null
      }
      footer={t("detail.lines", { count: lines.length })}
      actions={
        !showAll && lines.length > READ_PREVIEW_LINES ? (
          <button
            type="button"
            className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setShowAll(true)}
          >
            {t("detail.showAll", { count: lines.length })}
          </button>
        ) : null
      }
    >
      <div
        className="inline-block min-w-full py-2 font-mono text-[0.78125rem] leading-relaxed"
        dir="ltr"
      >
        {visible.map((line, index) => (
          <div key={index} className="flex">
            <span className="w-12 shrink-0 select-none pe-3 text-end text-muted-foreground tabular-nums">
              {parsed.startLine + index}
            </span>
            <span className="flex-1 whitespace-pre pe-4">{line}</span>
          </div>
        ))}
      </div>
    </DetailBox>
  )
}

export type { ToolStep }
