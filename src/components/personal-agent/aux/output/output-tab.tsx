"use client"

/** The output tab: what it made, a list a day, filtered by kind. */

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { FileText, Package } from "lucide-react"
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentOutputRead, personalAgentOutputs } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { DispatchInfo, PersonalAgentOutputDoc } from "@/lib/types"

import { PanelIcon, PanelItem, PanelList } from "../../panel-section"
import { DispatchCard } from "../activity/work-cards"
import { EmptyState, WorkSkeleton } from "../tab-body"
import { type Of, ofBot, useWork, useNow } from "../use-work"

type OutputKind = "all" | "tasks" | "reports" | "docs"

const OUTPUT_KINDS: readonly OutputKind[] = ["all", "tasks", "reports", "docs"]

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
 *  task's card, the report of the rest — and the documents it wrote in its
 *  working directory. */
export function OutputTab({ work }: { work: ReturnType<typeof useWork> }) {
  const t = useTranslations("PersonalAgent.detail.output")
  const tabs = useTranslations("PersonalAgent.detail.tabs")
  const { botId, dispatchVersion } = usePersonalAgent()
  const now = useNow()
  const dayName = useDayName()
  const clock = useClock()
  const [kind, setKind] = useState<OutputKind>("all")
  const [docsOf, setDocsOf] = useState<Of<PersonalAgentOutputDoc[]> | null>(
    null
  )
  const [readingOf, setReading] = useState<{
    bot: number | null
    path: string
    text: string | null
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
    setReading({ bot: botId, path, text: null })
    personalAgentOutputRead(botId, path)
      .then((text) => setReading({ bot: botId, path, text }))
      .catch((e) => {
        setReading(null)
        toast.error(toErrorMessage(e))
      })
  }
  const ended = work?.ended ?? []
  const tasks = ended.filter((d) => d.mode === "task")
  const reports = ended.filter((d) => d.mode !== "task")
  const counts: Record<OutputKind, number> = {
    all: ended.length + (docs?.length ?? 0),
    tasks: tasks.length,
    reports: reports.length,
    docs: docs?.length ?? 0,
  }
  type Shown =
    | { at: string; key: string; dispatch: DispatchInfo }
    | { at: string; key: string; doc: PersonalAgentOutputDoc }
  const shown: Shown[] = [
    ...(kind === "all" || kind === "tasks" ? tasks : []).map((d) => ({
      at: d.finished_at ?? d.updated_at,
      key: `d${d.id}`,
      dispatch: d,
    })),
    ...(kind === "all" || kind === "reports" ? reports : []).map((d) => ({
      at: d.finished_at ?? d.updated_at,
      key: `d${d.id}`,
      dispatch: d,
    })),
    ...(kind === "all" || kind === "docs" ? (docs ?? []) : []).map((doc) => ({
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Which kind: shadcn's toggle group, a pill each, how many it
          holds after its name. */}
      <div className="shrink-0 px-4 pt-4 pb-1">
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          value={kind}
          onValueChange={(v) => {
            if (v) setKind(v as OutputKind)
          }}
          aria-label={tabs("output")}
          className="flex-wrap"
        >
          {OUTPUT_KINDS.map((k) => (
            <ToggleGroupItem
              key={k}
              value={k}
              aria-label={t(k)}
              data-pa-output-kind={k}
              className="h-7 min-w-0 gap-1 px-2.5 text-xs font-normal text-muted-foreground data-[state=on]:font-medium data-[state=on]:text-foreground"
            >
              <span className="truncate">{t(k)}</span>
              {work != null && docs != null && counts[k] > 0 ? (
                <span
                  aria-hidden
                  className="text-[0.6875rem] font-normal text-muted-foreground tabular-nums"
                >
                  {counts[k]}
                </span>
              ) : null}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-4 pt-3 pb-6">
          {work == null || docs == null ? (
            <WorkSkeleton />
          ) : shown.length === 0 ? (
            <EmptyState icon={Package} title={t("empty")} />
          ) : (
            days.map((day) => (
              <section
                key={day.key}
                className="flex min-w-0 flex-col gap-1.5"
                data-pa-output-day={day.key}
              >
                <h4 className="px-0.5 text-xs font-medium text-muted-foreground">
                  {day.name}
                </h4>
                <PanelList>
                  {day.items.map((x) =>
                    "dispatch" in x ? (
                      <DispatchCard
                        key={x.key}
                        d={x.dispatch}
                        now={now}
                        time={clock(x.at)}
                      />
                    ) : (
                      <DocRow
                        key={x.key}
                        doc={x.doc}
                        time={clock(x.at)}
                        onOpen={() => open(x.doc.path)}
                      />
                    )
                  )}
                </PanelList>
              </section>
            ))
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
            {reading?.text == null ? (
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

/** A document it wrote: its name, the folder it is in. */
function DocRow({
  doc,
  time,
  onOpen,
}: {
  doc: PersonalAgentOutputDoc
  time: string
  onOpen: () => void
}) {
  const t = useTranslations("PersonalAgent.detail.output")
  const cut = doc.path.search(/[^\\/]+$/)
  const name = cut > 0 ? doc.path.slice(cut) : doc.path
  const folder = cut > 0 ? doc.path.slice(0, cut).replace(/[\\/]+$/, "") : ""
  return (
    <PanelItem
      media={<PanelIcon icon={FileText} />}
      title={<span title={doc.path}>{name}</span>}
      time={time}
      meta={[t("doc"), folder].filter(Boolean).join(" · ")}
      onOpen={onOpen}
      data-pa-output-doc={doc.path}
    />
  )
}
