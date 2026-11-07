"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon as MonitorIcon,
  AppWindowIcon,
  ArchiveIcon,
  BotIcon,
  BrainIcon,
  CircleCheckIcon,
  CodeIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  FileXIcon,
  FolderTreeIcon,
  GlobeIcon,
  GlobeLockIcon,
  ImageIcon,
  KeyboardIcon,
  LayersIcon,
  LightbulbIcon,
  ListTodoIcon,
  MapIcon,
  MessageCircleQuestionMarkIcon,
  MessagesSquareIcon,
  PlugIcon,
  SearchIcon,
  SparklesIcon,
  SquareTerminalIcon,
  TargetIcon,
  TimerIcon,
  UsersIcon,
  WrenchIcon,
  ClipboardListIcon,
} from "lucide-react"

import type {
  StepStatus,
  ToolDescriptor,
  ToolMetric,
  ToolNote,
  ToolStepKind,
} from "@/lib/activity/types"
import type { CommandExit } from "@/lib/activity/command"
import type { ExitMeaning } from "@/lib/activity/exit-meaning"
import { cn } from "@/lib/utils"
import type { ActivityIcon } from "./rail-icon"

/** One glyph per kind of step — never swapped for a status glyph; status is
 *  the ring's job. */
export function toolIcon(tool: ToolDescriptor): ActivityIcon {
  const kind: ToolStepKind = tool.kind
  switch (kind) {
    case "read":
      return FileTextIcon
    case "search":
      return SearchIcon
    case "glob":
      return FileSearchIcon
    case "list":
      return FolderTreeIcon
    case "fetch":
    case "web-search":
      return GlobeIcon
    case "memory":
      return BrainIcon
    case "command":
      return SquareTerminalIcon
    // The same glyph as the monitor's row in the async-task strip.
    case "monitor":
      return MonitorIcon
    case "network":
      return GlobeLockIcon
    case "shell-session":
      return tool.command?.session?.verb === "stdin" ? KeyboardIcon : TimerIcon
    case "script":
      return CodeIcon
    case "edit": {
      const files = tool.files ?? []
      if (files.length === 1 && files[0]!.op === "delete") return FileXIcon
      if (
        files.length > 0 &&
        files.every((f) => f.op === "add" || f.op === "write")
      ) {
        return FilePlusIcon
      }
      return FilePenLineIcon
    }
    case "mcp":
      return PlugIcon
    case "skill":
      return SparklesIcon
    case "todo":
      return ListTodoIcon
    case "agent":
    case "collab-agent":
      return BotIcon
    case "delegation":
    case "delegation-status":
    case "delegation-cancel":
    case "delegation-resume":
      return UsersIcon
    case "goal":
      return TargetIcon
    case "plan-mode":
      return MapIcon
    case "question":
      return MessageCircleQuestionMarkIcon
    case "render-page":
      return AppWindowIcon
    case "feedback":
      return MessagesSquareIcon
    case "workbench":
      return ClipboardListIcon
    case "compaction":
      return ArchiveIcon
    case "completion":
      return CircleCheckIcon
    case "generic":
      return WrenchIcon
  }
}

export const THOUGHT_ICON = LightbulbIcon
export const GOAL_ICON = TargetIcon
export const PLAN_ICON = ListTodoIcon
export const IMAGE_ICON = ImageIcon
export const RESULT_ICON = WrenchIcon
/** A run of steps folded into one row (an explore or a command group). */
export const GROUP_ICON = LayersIcon

/** Localized words for a step's status, for ring labels and the end column. */
export function useStatusText() {
  const t = useTranslations("Folder.chat.activity")
  return useCallback(
    (status: StepStatus, exit?: CommandExit | null): string => {
      if (status === "failed" && exit?.code != null) {
        return t("status.failedExit", { code: exit.code })
      }
      return t(`status.${status}`)
    },
    [t]
  )
}

/** The word for what a command's exit says (`exit-meaning.ts`). */
const EXIT_WORD = {
  noMatch: "metric.noMatch",
  false: "metric.conditionFalse",
  differs: "metric.differs",
  notFound: "metric.notFound",
  commandNotFound: "metric.commandNotFound",
  notExecutable: "metric.notExecutable",
  timedOut: "metric.timedOut",
} as const satisfies Record<ExitMeaning, string>

/**
 * The end-column word for a step that did not simply succeed: `exit 1`,
 * `failed`, `declined`, `interrupted`, `needs you`. A failed command says
 * what its exit code names when it names something — `command not found`,
 * `timed out`, `killed · SIGKILL` — the code itself on hover. A running step
 * shows "running" only under reduced motion, where its ring stops turning.
 */
export function StatusFigure({
  status,
  exit,
  meaning,
}: {
  status: StepStatus
  exit?: CommandExit | null
  meaning?: ExitMeaning | null
}) {
  const t = useTranslations("Folder.chat.activity")
  switch (status) {
    case "failed": {
      const code =
        exit?.code != null ? t("metric.exit", { code: exit.code }) : null
      const word = meaning
        ? t(EXIT_WORD[meaning])
        : exit?.signal
          ? t("metric.signal", { signal: exit.signal })
          : null
      return (
        <span
          className="text-tone-danger"
          title={word && code ? code : undefined}
        >
          {word ?? code ?? t("metric.failed")}
        </span>
      )
    }
    case "rejected":
      return <span className="text-tone-danger">{t("metric.declined")}</span>
    case "cancelled":
      return <span>{t("metric.interrupted")}</span>
    case "awaiting":
      return <span className="text-tone-warning">{t("metric.needsYou")}</span>
    case "running":
    case "pending":
      return (
        <span className="hidden motion-reduce:inline">
          {t("metric.running")}
        </span>
      )
    case "succeeded":
      return null
  }
}

function MetricFigure({ metric }: { metric: ToolMetric }) {
  const t = useTranslations("Folder.chat.activity")
  switch (metric.kind) {
    case "lines":
      return <>{t("metric.lines", { count: metric.count })}</>
    case "matches":
      return <>{t("metric.hits", { count: metric.count })}</>
    case "files":
      return <>{t("metric.files", { count: metric.count })}</>
    case "results":
      return <>{t("metric.results", { count: metric.count })}</>
    case "noMatch":
      return <>{t("metric.noMatch")}</>
    case "diff":
      return (
        <DiffFigure additions={metric.additions} deletions={metric.deletions} />
      )
  }
}

export function DiffFigure({
  additions,
  deletions,
  className,
}: {
  additions: number
  deletions: number
  className?: string
}) {
  return (
    <span className={cn("inline-flex gap-1.5", className)} dir="ltr">
      {additions > 0 ? (
        <span className="text-tone-success">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-tone-danger">−{deletions}</span>
      ) : null}
    </span>
  )
}

/** The end column of a tool row: a failure word outranks the metric; a
 *  command whose exit answered its question says the answer — `no matches`,
 *  `false` — the code on hover. */
export function ToolFigure({ tool }: { tool: ToolDescriptor }) {
  const t = useTranslations("Folder.chat.activity")
  if (tool.status !== "succeeded") {
    return (
      <StatusFigure
        status={tool.status}
        exit={tool.exit}
        meaning={tool.exitMeaning}
      />
    )
  }
  if (tool.exitMeaning) {
    return (
      <span
        title={
          tool.exit?.code != null
            ? t("metric.exit", { code: tool.exit.code })
            : undefined
        }
      >
        {t(EXIT_WORD[tool.exitMeaning])}
      </span>
    )
  }
  return tool.metric ? <MetricFigure metric={tool.metric} /> : null
}

/** A tool's argument notes ("Over size limit", "Pages: 1-3"), muted. */
export function ToolNotes({ notes }: { notes: ToolNote[] }) {
  const t = useTranslations("Folder.chat.contentParts")
  if (notes.length === 0) return null
  const text = notes
    .map((note) => {
      switch (note.kind) {
        case "allowLarge":
          return t("allowLarge")
        case "pages":
          return t("pages", { pages: note.value })
        case "offset":
          return t("offset", { offset: note.value })
      }
    })
    .join(" · ")
  return (
    <span className="min-w-0 shrink truncate font-sans text-activity-secondary">
      {text}
    </span>
  )
}
