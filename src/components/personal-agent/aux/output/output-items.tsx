"use client"

/** What the output tab lists, each as the stack draws it:
 *  - a report (handed-out work that was not a task): a row — its kind's icon
 *    in the colour of how it came out, its title, where it stands, whose
 *    and when — that opens in place into a card saying what it found, with
 *    the way to its session;
 *  - a task: a row with where it stands, why it failed or what it did, its
 *    branch; opening its session as before;
 *  - a document: a row of its name and folder; a folder's documents of a
 *    day one card — its pictures as thumbnails, the rest a line each, past
 *    the first few "N more files".
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Image as ImageIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { DispatchInfo, PersonalAgentOutputDoc } from "@/lib/types"
import { cn } from "@/lib/utils"

import { PanelIcon, PanelItem, PanelMoreRow } from "../../panel-section"
import {
  canOpenWork,
  WorkGlyph,
  useOpenWork,
  useWorkMeta,
  workTargetOf,
} from "../../shared"
import { LadderChip } from "../../task-strip"
import { ROW_AVATAR_SIZE } from "../activity/work-cards"
import { BranchChip } from "../kit/branch-chip"
import { baseName, isImage, outcomeOf, type Outcome } from "./outcome"
import { useThumb } from "./use-thumb"

/** Pictures a folder's card shows before "N more files": two rows of four. */
const THUMBS_SHOWN = 8
/** Its other documents, a line each, before it. */
const LINES_SHOWN = 3

/** A report's icon, in the colour of how it came out. */
const REPORT_TONE: Record<Outcome, string> = {
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/10 text-red-700 dark:text-red-300",
  open: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  closed: "bg-muted text-muted-foreground",
}

/** The first line of a text, for a row's quiet line. */
function firstLine(text: string | null | undefined): string | null {
  const line = text
    ?.split("\n")
    .map((l) => l.trim())
    .find(Boolean)
  return line || null
}

/** A report: a row that opens in place into a card. */
export function ReportItem({
  d,
  time,
  open,
  onToggle,
}: {
  d: DispatchInfo
  time: string
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("PersonalAgent")
  const openWork = useOpenWork()
  const meta = useWorkMeta()
  const target = workTargetOf(d)
  const canOpen = canOpenWork(target)
  const outcome = outcomeOf(d)
  const failed = d.state === "failed" && d.error?.trim()
  const said = failed ? d.error!.trim() : d.result_excerpt?.trim()
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <PanelItem
      media={
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-lg",
            REPORT_TONE[outcome]
          )}
        >
          <FileText className="size-3.5" aria-hidden />
        </span>
      }
      title={d.title}
      time={time}
      chip={<LadderChip ladder={d.ladder ?? null} />}
      meta={meta({
        mode: d.mode,
        folder: d.folder_name,
      })}
      aside={
        <Chevron
          aria-hidden
          className={cn(
            "size-4 text-muted-foreground",
            !open && "rtl:-scale-x-100"
          )}
        />
      }
      onOpen={onToggle}
      expanded={open}
      callout={
        open && said
          ? failed
            ? { tone: "error", mono: true, text: said }
            : { tone: "neutral", text: said }
          : null
      }
      actions={
        open && canOpen ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => openWork(target)}
            data-pa-output-open={d.id}
          >
            {t("timeline.viewSession")}
          </Button>
        ) : undefined
      }
      data-pa-output-report={d.id}
    />
  )
}

/** A task's work: where it stands, why it failed or what it did, its branch;
 *  opening its session. */
export function TaskItem({ d, time }: { d: DispatchInfo; time: string }) {
  const t = useTranslations("PersonalAgent")
  const openWork = useOpenWork()
  const meta = useWorkMeta()
  const target = workTargetOf(d)
  const canOpen = canOpenWork(target)
  const line =
    d.state === "failed" ? firstLine(d.error) : firstLine(d.result_excerpt)
  const branch = d.task?.branch ?? null
  return (
    <PanelItem
      media={<WorkGlyph mode={d.mode} size={ROW_AVATAR_SIZE} />}
      title={d.title}
      time={time}
      chip={<LadderChip ladder={d.ladder ?? null} />}
      meta={meta({
        mode: d.mode,
        folder: d.folder_name,
      })}
      notes={[
        ...(line
          ? [
              <span
                key="line"
                className={
                  d.state === "failed"
                    ? "text-red-700 dark:text-red-400"
                    : undefined
                }
              >
                {line}
              </span>,
            ]
          : []),
        ...(branch
          ? [
              <span key="branch" className="mt-1 flex">
                <BranchChip branch={branch} />
              </span>,
            ]
          : []),
      ]}
      onOpen={canOpen ? () => openWork(target) : null}
      openLabel={canOpen ? t("timeline.viewSession") : undefined}
      data-pa-output-task={d.id}
    />
  )
}

/** A document it wrote: its name, the folder it is in. */
export function DocItem({
  doc,
  time,
  onOpen,
}: {
  doc: PersonalAgentOutputDoc
  time: string
  onOpen: () => void
}) {
  const t = useTranslations("PersonalAgent.detail.output")
  const name = baseName(doc.path)
  const folder =
    name.length < doc.path.length
      ? doc.path.slice(0, doc.path.length - name.length).replace(/[\\/]+$/, "")
      : ""
  return (
    <PanelItem
      media={<PanelIcon icon={isImage(doc.path) ? ImageIcon : FileText} />}
      title={<span title={doc.path}>{name}</span>}
      time={time}
      meta={[t("doc"), folder].filter(Boolean).join(" · ")}
      onOpen={onOpen}
      data-pa-output-doc={doc.path}
    />
  )
}

/** A folder's documents of a day, on one card, in the order of their names
 *  (2 before 10): its pictures as thumbnails, the rest a line each with its
 *  time; past the first few, "N more files". */
export function FolderItem({
  folder,
  docs,
  time,
  workdir,
  clock,
  onOpen,
}: {
  folder: string
  docs: PersonalAgentOutputDoc[]
  time: string
  workdir: string | null
  /** A time of day, as the rows say theirs. */
  clock: (iso: string) => string
  onOpen: (path: string) => void
}) {
  const t = useTranslations("PersonalAgent.detail.output")
  const [all, setAll] = useState(false)
  const byName = [...docs].sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true })
  )
  const pictures = byName.filter((d) => isImage(d.path))
  const others = byName.filter((d) => !isImage(d.path))
  const shownPictures = all ? pictures : pictures.slice(0, THUMBS_SHOWN)
  const shownOthers = all ? others : others.slice(0, LINES_SHOWN)
  const hidden =
    pictures.length - shownPictures.length + others.length - shownOthers.length
  return (
    <PanelItem
      media={<PanelIcon icon={Folder} />}
      title={<span dir="ltr">{folder}/</span>}
      time={time}
      meta={t("files", { count: docs.length })}
      extra={
        <div className="flex min-w-0 flex-col gap-2">
          {shownPictures.length > 0 ? (
            <div className="grid grid-cols-4 gap-2 @max-[18rem]/aux:grid-cols-3">
              {shownPictures.map((doc) => (
                <Thumb
                  key={`${workdir}\0${doc.path}\0${doc.modified_at}`}
                  doc={doc}
                  workdir={workdir}
                  onOpen={() => onOpen(doc.path)}
                />
              ))}
            </div>
          ) : null}
          {shownOthers.length > 0 ? (
            <ul className="flex min-w-0 flex-col">
              {shownOthers.map((doc) => (
                <li key={doc.path} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpen(doc.path)}
                    title={doc.path}
                    data-pa-output-doc={doc.path}
                    className="-mx-1.5 flex h-8 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-lg px-1.5 text-start text-xs transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <FileText
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {baseName(doc.path)}
                    </span>
                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
                      {clock(doc.modified_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {hidden > 0 ? (
            <div>
              <PanelMoreRow
                onClick={() => setAll(true)}
                data-pa-output-more={folder}
              >
                {t("moreFiles", { count: hidden })}
              </PanelMoreRow>
            </div>
          ) : null}
        </div>
      }
      data-pa-output-folder={folder}
    />
  )
}

/** A picture's thumbnail, its name under it; opening it. */
function Thumb({
  doc,
  workdir,
  onOpen,
}: {
  doc: PersonalAgentOutputDoc
  workdir: string | null
  onOpen: () => void
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const src = useThumb(workdir, doc, ref)
  const name = baseName(doc.path)
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      title={doc.path}
      data-pa-output-doc={doc.path}
      className="group/thumb flex min-w-0 flex-col items-center gap-1 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-muted transition-colors group-hover/thumb:bg-muted/70">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data URL, nothing to optimise
          <img
            src={src}
            alt=""
            className="size-full object-contain p-1.5"
            draggable={false}
          />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground/60" aria-hidden />
        )}
      </span>
      <span className="w-full truncate text-center text-[0.6875rem] text-muted-foreground">
        {name}
      </span>
    </button>
  )
}
