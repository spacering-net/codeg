"use client"

/** The output tab: what it made, a list a day, filtered by kind — the kind
 *  picked from its title, its count after it. On the tasks, a card summing
 *  up how they came out over them. */

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { CalendarDays, Package } from "lucide-react"
import { toast } from "sonner"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { MessageResponse } from "@/components/ai-elements/message"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import {
  personalAgentOutputRead,
  personalAgentOutputs,
  readWorkspaceFileBase64,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { imageDataUrl } from "@/lib/image-diff"
import type { DispatchInfo, PersonalAgentOutputDoc } from "@/lib/types"
import { cn } from "@/lib/utils"

import { PANEL_SURFACE, PanelBar, PanelStack } from "../../panel-section"
import { SegmentBar, type SegmentTone } from "../kit/segment-bar"
import { ViewSelect } from "../kit/view-select"
import { EmptyState, WorkSkeleton } from "../tab-body"
import { type Of, ofBot, useWork, useNow } from "../use-work"
import { DocItem, FolderItem, ReportItem, TaskItem } from "./output-items"
import {
  gatherDay,
  isImage,
  outcomeCounts,
  OUTCOMES,
  type Outcome,
} from "./outcome"

type OutputKind = "all" | "tasks" | "reports" | "docs"

const OUTPUT_KINDS: readonly OutputKind[] = ["all", "tasks", "reports", "docs"]

/** The largest picture opened from the tab. */
const PICTURE_MAX_BYTES = 8 * 1024 * 1024

/** How each way the tasks came out is drawn on their summary. */
const OUTCOME_TONE: Record<Outcome, SegmentTone> = {
  done: "green",
  failed: "red",
  closed: "muted",
  open: "amber",
}

const OUTCOME_LABEL = {
  done: "outcomeDone",
  failed: "outcomeFailed",
  closed: "outcomeClosed",
  open: "outcomeOpen",
} as const

/** A day's key in the local calendar. */
function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** A day's name: today, yesterday — the language's own words — or its
 *  date, with the weekday. */
function useDayName(): (iso: string, now: number) => string {
  const locale = useLocale()
  return (iso, now) => {
    const day = new Date(iso)
    const start = (d: Date) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const ago = Math.round((start(new Date(now)) - start(day)) / 86_400_000)
    if (ago === 0 || ago === 1) {
      const words = new Intl.RelativeTimeFormat(locale, {
        numeric: "auto",
      }).format(-ago, "day")
      return words.charAt(0).toLocaleUpperCase(locale) + words.slice(1)
    }
    return day.toLocaleDateString(locale, {
      ...(new Date(now).getFullYear() === day.getFullYear()
        ? {}
        : { year: "numeric" }),
      month: "short",
      day: "numeric",
      weekday: "short",
    })
  }
}

/** A time of day, short. */
function useClock(): (iso: string) => string {
  const locale = useLocale()
  return (iso) =>
    new Date(iso).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    })
}

/** What it made, newest first, a list a day: the work that ended — a
 *  task, the report of the rest — and the documents it wrote in its working
 *  directory (`workdir`, where its pictures are read from). */
export function OutputTab({
  work,
  workdir,
}: {
  work: ReturnType<typeof useWork>
  workdir: string | null
}) {
  const t = useTranslations("PersonalAgent.detail.output")
  const tabs = useTranslations("PersonalAgent.detail.tabs")
  const { botId, dispatchVersion } = usePersonalAgent()
  const now = useNow()
  const dayName = useDayName()
  const clock = useClock()
  const [kind, setKind] = useState<OutputKind>("all")
  // The report open in place, of the assistant shown.
  const [openOf, setOpen] = useState<Of<number> | null>(null)
  const openReport = ofBot(openOf, botId)
  const [docsOf, setDocsOf] = useState<Of<PersonalAgentOutputDoc[]> | null>(
    null
  )
  const [readingOf, setReading] = useState<{
    bot: number | null
    path: string
    text: string | null
    image: string | null
  } | null>(null)
  useEffect(() => {
    let live = true
    personalAgentOutputs(botId)
      .then((list) => {
        if (live) setDocsOf({ bot: botId, value: list })
      })
      .catch(() => {
        if (live) setDocsOf({ bot: botId, value: [] })
      })
    return () => {
      live = false
    }
  }, [botId, dispatchVersion])
  const docs = ofBot(docsOf, botId)
  // A document of the assistant shown, not of the last one.
  const reading = readingOf?.bot === botId ? readingOf : null
  const open = (path: string) => {
    setReading({ bot: botId, path, text: null, image: null })
    const fail = (e: unknown) => {
      setReading(null)
      toast.error(toErrorMessage(e))
    }
    // A picture is read as bytes; the reader for text refuses them.
    if (isImage(path) && workdir) {
      readWorkspaceFileBase64(workdir, path, PICTURE_MAX_BYTES)
        .then((b64) =>
          setReading({
            bot: botId,
            path,
            text: null,
            image: imageDataUrl(path, b64),
          })
        )
        .catch(fail)
      return
    }
    personalAgentOutputRead(botId, path)
      .then((text) => setReading({ bot: botId, path, text, image: null }))
      .catch(fail)
  }
  const ended = work?.ended ?? []
  const tasks = ended.filter((d) => d.mode === "task")
  const reports = ended.filter((d) => d.mode !== "task")
  const known = work != null && docs != null
  const counts: Record<OutputKind, number> = {
    all: ended.length + (docs?.length ?? 0),
    tasks: tasks.length,
    reports: reports.length,
    docs: docs?.length ?? 0,
  }
  type Shown =
    | { kind: "dispatch"; at: string; key: string; dispatch: DispatchInfo }
    | { kind: "doc"; at: string; key: string; doc: PersonalAgentOutputDoc }
  const shown: Shown[] = [
    ...(kind === "all" || kind === "tasks" ? tasks : []).map((d) => ({
      kind: "dispatch" as const,
      at: d.finished_at ?? d.updated_at,
      key: `d${d.id}`,
      dispatch: d,
    })),
    ...(kind === "all" || kind === "reports" ? reports : []).map((d) => ({
      kind: "dispatch" as const,
      at: d.finished_at ?? d.updated_at,
      key: `d${d.id}`,
      dispatch: d,
    })),
    ...(kind === "all" || kind === "docs" ? (docs ?? []) : []).map((doc) => ({
      kind: "doc" as const,
      at: doc.modified_at,
      key: `f${doc.path}`,
      doc,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  // A list a day, newest first.
  const days: { key: string; name: string; items: Shown[] }[] = []
  for (const x of shown) {
    const key = dayKey(x.at)
    const last = days[days.length - 1]
    if (last?.key === key) last.items.push(x)
    else days.push({ key, name: dayName(x.at, now), items: [x] })
  }
  const outcomes = outcomeCounts(tasks)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-4 pt-1 pb-6">
          {/* Which kind: picked from the title, as many as it holds after it
              — scrolled with the rest, as far from the cards under it as
              from the tabs over it. */}
          <div className="pb-1">
            <ViewSelect
              value={kind}
              onChange={setKind}
              menuLabel={tabs("output")}
              clearLabel={t("clear")}
              itemAttr="data-pa-output-kind"
              choices={OUTPUT_KINDS.map((k) => ({
                value: k,
                label: t(k),
                title: k === "all" ? t("allTitle") : t(k),
                count: known ? counts[k] : null,
              }))}
            />
          </div>
          {!known ? (
            <WorkSkeleton />
          ) : shown.length === 0 ? (
            <EmptyState icon={Package} title={t("empty")} />
          ) : (
            <>
              {kind === "tasks" ? (
                // How the tasks came out, over them.
                <section
                  data-pa-output-summary
                  className={cn(PANEL_SURFACE, "flex flex-col gap-3 p-4")}
                >
                  <h4 className="text-sm leading-5 font-semibold">
                    {t("tasksSummary", { count: tasks.length })}
                  </h4>
                  <SegmentBar
                    segments={OUTCOMES.map((o) => ({
                      key: o,
                      label: t(OUTCOME_LABEL[o]),
                      value: outcomes[o],
                      tone: OUTCOME_TONE[o],
                    }))}
                  />
                </section>
              ) : null}
              {days.map((day) => (
                // A day one card: its name on the bar across its top.
                <section
                  key={day.key}
                  className={cn(
                    PANEL_SURFACE,
                    "flex min-w-0 flex-col overflow-hidden"
                  )}
                  data-pa-output-day={day.key}
                >
                  <PanelBar className="text-muted-foreground">
                    <CalendarDays aria-hidden className="size-3.5 shrink-0" />
                    <h4 className="min-w-0 truncate">{day.name}</h4>
                  </PanelBar>
                  <PanelStack flush>
                    {gatherDay(day.items).map((x) =>
                      x.kind === "folder" ? (
                        <FolderItem
                          key={x.key}
                          folder={x.folder}
                          docs={x.docs}
                          time={clock(x.at)}
                          workdir={workdir}
                          clock={clock}
                          onOpen={open}
                        />
                      ) : x.kind === "doc" ? (
                        <DocItem
                          key={x.key}
                          doc={x.doc}
                          time={clock(x.at)}
                          onOpen={() => open(x.doc.path)}
                        />
                      ) : x.dispatch.mode === "task" ? (
                        <TaskItem
                          key={x.key}
                          d={x.dispatch}
                          time={clock(x.at)}
                        />
                      ) : (
                        <ReportItem
                          key={x.key}
                          d={x.dispatch}
                          time={clock(x.at)}
                          open={openReport === x.dispatch.id}
                          onToggle={() =>
                            setOpen(
                              openReport === x.dispatch.id
                                ? null
                                : { bot: botId, value: x.dispatch.id }
                            )
                          }
                        />
                      )
                    )}
                  </PanelStack>
                </section>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
      <Dialog
        open={reading != null}
        onOpenChange={(o) => (o ? null : setReading(null))}
      >
        <DialogContent className="max-h-[80vh] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">
              {reading?.path}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            {reading?.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL, nothing to optimise
              <img
                src={reading.image}
                alt={reading.path}
                data-pa-output-picture
                className="mx-auto max-h-[65vh] max-w-full rounded-lg object-contain"
              />
            ) : reading?.text == null ? (
              <SyncedSpinner
                small
                className="mx-auto my-6 size-4 text-muted-foreground"
              />
            ) : /\.(md|markdown)$/i.test(reading.path) ? (
              <MessageResponse>{reading.text}</MessageResponse>
            ) : (
              <pre className="text-xs whitespace-pre-wrap">{reading.text}</pre>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
