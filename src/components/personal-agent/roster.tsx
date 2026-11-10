"use client"

/**
 * The roster, the assistants page's left column (10.1, 4.14).
 *
 * - On top: search (by name or role) and [+].
 * - The primary: its face large, centered, with its star, its name and one
 *   line of what it is up to.
 * - Then a row each: face, name, one line, a time. The line says first what
 *   the owner should know — what waits on them, what it is doing — and its
 *   last words when nothing does. The face is its state (10.6), the dot in
 *   its corner what it wants of the owner. Hovering shows the whole activity
 *   and the work in hand.
 * - Groups: the pinned ones (in the owner's order, dragged to reorder), the
 *   owner's own groups (folding), the rest; at the foot, "N hidden", which
 *   opens to show them. Within a group: waiting on the owner, working,
 *   idle, done, the most recent first.
 * - A row's context menu: pin, move to a group, hide, mute, mark unread,
 *   notifications, copy, stop everything, delete.
 * - Rows come and go by their height (the motion tokens), not at once.
 * - On a narrow screen, a strip of faces over the page.
 *
 * Opening an assistant takes away the owner's own unread mark on it.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ChevronRight, Pin, Plus, Search, VolumeX, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { Input } from "@/components/ui/input"
import {
  personalAgentBotCopy,
  personalAgentRosterAct,
  personalAgentStopAll,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { RosterAct, RosterEntry } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import {
  activityText,
  useActivityTranslate,
  type Translate,
} from "./activity-text"
import { BotAvatar } from "./bot-avatar"
import { BotDeleteDialog } from "./bot-delete-dialog"
import { useMessageTime } from "./message-actions"
import { NewBotDialog } from "./new-bot-dialog"
import { groupRoster, sectionNames, viewOf, type BotView } from "./roster-order"
import { useBotName } from "./shared"
import { useBotTemplates } from "./use-templates"

/** How often the roster reads the clock while something on it moves
 *  (stale states, waiting past two minutes, a face shown for a while). */
const TICK_FAST_MS = 1000
const TICK_SLOW_MS = 30_000
/** A row's height in or out. */
const ROW_MS = 240
const FOLDED_KEY = "pa:roster:folded:v1"

/** The clock, read fast only while it can change what is shown. */
function useRosterNow(entries: readonly RosterEntry[] | null): number {
  const [now, setNow] = useState(() => Date.now())
  const fast = (entries ?? []).some(
    (e) =>
      e.live &&
      (e.live.work === "busy" ||
        e.live.attention === "needs_you" ||
        e.live.flash)
  )
  useEffect(() => {
    const id = window.setInterval(
      () => setNow(Date.now()),
      fast ? TICK_FAST_MS : TICK_SLOW_MS
    )
    return () => window.clearInterval(id)
  }, [fast])
  return now
}

/** The groups folded, kept for the next time. */
function useFolded(): [ReadonlySet<string>, (name: string) => void] {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = window.localStorage.getItem(FOLDED_KEY)
      const list = raw ? (JSON.parse(raw) as unknown) : []
      return new Set(Array.isArray(list) ? list.map(String) : [])
    } catch {
      return new Set()
    }
  })
  const toggle = (name: string) =>
    setFolded((held) => {
      const next = new Set(held)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      try {
        window.localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]))
      } catch {
        // Not kept; folded for now all the same.
      }
      return next
    })
  return [folded, toggle]
}

/** The one line a row says (10.1): what waits on the owner, work of its
 *  they can merge, what it is doing, whom it waits for; its last words
 *  otherwise. */
export function rowLine(
  t: Translate,
  entry: RosterEntry,
  view: BotView,
  now: number
): { text: string; tone: "needs" | "ready" | "busy" | "plain" } | null {
  const live = entry.live
  if (!live) return null
  const needs = live.needs
  if (live.attention === "needs_you" && needs) {
    const ask =
      needs.kind === "question" ||
      needs.kind === "choice" ||
      needs.kind === "input"
        ? "answer"
        : needs.kind === "uncertain" || needs.kind === "loop"
          ? "you"
          : "approval"
    return {
      text: needs.text
        ? t(`needs.${ask}`, { text: needs.text })
        : t(`needs.${ask}Plain`),
      tone: "needs",
    }
  }
  // The piece of its work the owner most needs to know of next: one they
  // can merge (8.5).
  const ready = live.work_on_hand.find((w) => w.ladder === "mergeable")
  if (ready) {
    return {
      text: t("bots.roster.mergeable", {
        id: ready.dispatch_id,
        title: ready.title,
      }),
      tone: "ready",
    }
  }
  if (view.busy && live.activity) {
    return { text: activityText(t, live.activity, now), tone: "busy" }
  }
  if (live.awaiting.length > 0 && live.work !== "busy") {
    return {
      text: t("activity.awaitingReply", { name: live.awaiting[0].to_name }),
      tone: "plain",
    }
  }
  if (live.last_line) return { text: live.last_line.text, tone: "plain" }
  return null
}

/** The rows of a group, each coming in and going out by its height (the
 *  motion tokens' `motion-rows`). A row gone is kept, closing, for the
 *  length of the motion. */
function AnimatedRows({
  entries,
  render,
}: {
  entries: readonly RosterEntry[]
  render: (e: RosterEntry) => ReactNode
}) {
  type Held = { entry: RosterEntry; state: "in" | "shown" | "out" }
  const [held, setHeld] = useState<Held[]>(() =>
    entries.map((entry) => ({ entry, state: "shown" }))
  )
  // The rows as they were drawn last: a new list is laid over them while
  // rendering (rows come in, rows gone stay closing).
  const [drawnFor, setDrawnFor] = useState(entries)
  if (drawnFor !== entries) {
    setDrawnFor(entries)
    setHeld((before) => {
      const ids = new Set(entries.map((e) => e.id))
      const was = new Map(before.map((h) => [h.entry.id, h.state]))
      const next: Held[] = entries.map((entry) => {
        const state = was.get(entry.id)
        return {
          entry,
          state: state == null || state === "out" ? "in" : state,
        }
      })
      before.forEach((h, i) => {
        if (!ids.has(h.entry.id)) {
          next.splice(Math.min(i, next.length), 0, {
            entry: h.entry,
            state: "out",
          })
        }
      })
      return next
    })
  }
  // A row gone leaves once closed.
  const closing = held.some((h) => h.state === "out")
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(
      () => setHeld((list) => list.filter((h) => h.state !== "out")),
      ROW_MS
    )
    return () => window.clearTimeout(timer)
  }, [closing, held])
  return (
    <>
      {held.map((h) => (
        <div
          key={h.entry.id}
          data-pa-roster-row-state={h.state}
          data-state={h.state === "out" ? "closed" : "open"}
          className={cn("motion-rows", h.state === "in" && "motion-rows-enter")}
          aria-hidden={h.state === "out" || undefined}
        >
          <div>{render(h.entry)}</div>
        </div>
      ))}
    </>
  )
}

export function PersonalAgentRoster({
  compact,
  readOnly,
}: {
  /** A strip of faces (a narrow screen). */
  compact: boolean
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent")
  const tt = useActivityTranslate()
  const tr = useTranslations("PersonalAgent.bots.roster")
  const locale = useLocale()
  const entries = useRoster()
  const botName = useBotName()
  const time = useMessageTime()
  const templates = useBotTemplates()
  const viewBot = usePersonalAgentUi((s) => s.viewBot)
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [grouping, setGrouping] = useState<RosterEntry | null>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [folded, toggleFold] = useFolded()
  const [dragging, setDragging] = useState<number | null>(null)
  const now = useRosterNow(entries)
  const list = useMemo(() => entries ?? [], [entries])

  // The one shown was deleted (here or in another window): back to the
  // primary.
  useEffect(() => {
    if (entries && viewBot != null && !entries.some((b) => b.id === viewBot)) {
      setViewBot(null)
    }
  }, [entries, viewBot, setViewBot])

  const currentId =
    viewBot ?? list.find((e) => e.kind === "primary")?.id ?? null
  const current = list.find((e) => e.id === currentId) ?? null
  // Opening it takes the owner's unread mark away — on opening, not when
  // the owner marks the one open (it then stays marked till the next).
  const unreadMarked = current?.roster?.unread_mark === true
  const [opened, setOpened] = useState<number | null>(null)
  const [clearFor, setClearFor] = useState<number | null>(null)
  if (currentId != null && currentId !== opened) {
    setOpened(currentId)
    setClearFor(unreadMarked ? currentId : null)
  }
  useEffect(() => {
    if (readOnly || clearFor == null) return
    void personalAgentRosterAct(clearFor, { act: "mark_read" }).catch(() => {})
  }, [clearFor, readOnly])

  const groups = useMemo(
    () => groupRoster(list, now, locale),
    [list, now, locale]
  )
  const sections = useMemo(() => sectionNames(list, locale), [list, locale])
  const roleOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const tpl of templates ?? []) m.set(tpl.id, tpl.name)
    return m
  }, [templates])

  const go = (b: RosterEntry) => setViewBot(b.kind === "primary" ? null : b.id)
  const act = (b: RosterEntry, a: RosterAct) => {
    void personalAgentRosterAct(b.id, a).catch((e) =>
      toast.error(toErrorMessage(e))
    )
  }
  const copy = async (b: RosterEntry) => {
    try {
      const made = await personalAgentBotCopy(
        b.id,
        t("bots.copyName", { name: botName(b) }),
        locale
      )
      if (made.bot) toast.message(t("bots.copied", { name: made.bot.name }))
    } catch (e) {
      toast.error(toErrorMessage(e))
    }
  }
  const stopAll = (b: RosterEntry) => {
    void personalAgentStopAll(b.id).catch((e) => toast.error(toErrorMessage(e)))
  }

  const faceLabel = (b: RosterEntry, view: BotView) => {
    const state = view.stale ? t("face.stale") : tt(`face.${view.look}`)
    return view.dot === "unread"
      ? t("face.labelUnread", { name: botName(b), state })
      : t("face.label", { name: botName(b), state })
  }

  const face = (b: RosterEntry, size: number) => {
    const view = viewOf(b.live, now, b.roster?.unread_mark)
    return (
      <BotAvatar
        avatar={b.avatar}
        name={botName(b)}
        size={size}
        star={b.kind === "primary"}
        look={view.look}
        dot={view.dot}
        label={faceLabel(b, view)}
      />
    )
  }

  const hover = (b: RosterEntry, view: BotView) => {
    const live = b.live
    return (
      <div className="flex flex-col gap-2 text-xs" data-pa-roster-hover={b.id}>
        <div className="flex items-center gap-2">
          {face(b, 28)}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{botName(b)}</div>
            <div className="truncate text-muted-foreground">
              {b.template ? (roleOf.get(b.template) ?? null) : null}
            </div>
          </div>
        </div>
        {view.stale ? (
          <p className="text-muted-foreground">{t("face.stale")}</p>
        ) : live?.activity && view.busy ? (
          <p className="break-words">{activityText(tt, live.activity, now)}</p>
        ) : null}
        <div>
          <div className="mb-1 font-medium text-muted-foreground">
            {tr("handWork")}
          </div>
          {live && live.work_on_hand.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {live.work_on_hand.map((w) => (
                <li key={w.dispatch_id} className="truncate">
                  #{w.dispatch_id} {w.title}
                  <span className="text-muted-foreground">
                    {" · "}
                    {tt(`ladder.${w.ladder ?? "working"}`)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{tr("nothing")}</p>
          )}
        </div>
        {live && live.awaiting.length > 0 ? (
          <div>
            <div className="mb-1 font-medium text-muted-foreground">
              {tr("awaiting")}
            </div>
            <ul className="flex flex-col gap-0.5">
              {live.awaiting.map((a) => (
                <li key={a.message_id} className="truncate">
                  {t("activity.awaitingReply", { name: a.to_name })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    )
  }

  const menu = (b: RosterEntry, trigger: ReactNode) => {
    const worker = b.kind === "worker"
    const r = b.roster
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
        <ContextMenuContent data-pa-roster-menu={b.id}>
          <ContextMenuItem onSelect={() => go(b)}>
            {tr("menu.open")}
          </ContextMenuItem>
          {worker ? (
            <ContextMenuItem
              disabled={readOnly}
              onSelect={() => act(b, { act: r?.pinned_at ? "unpin" : "pin" })}
            >
              {r?.pinned_at ? tr("menu.unpin") : tr("menu.pin")}
            </ContextMenuItem>
          ) : null}
          {worker ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={readOnly}>
                {tr("menu.moveTo")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {sections.map((name) => (
                  <ContextMenuItem
                    key={name}
                    disabled={r?.section === name}
                    onSelect={() => act(b, { act: "section", name })}
                  >
                    {name}
                  </ContextMenuItem>
                ))}
                <ContextMenuItem
                  disabled={!r?.section}
                  onSelect={() => act(b, { act: "section", name: null })}
                >
                  {tr("menu.noGroup")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => setGrouping(b)}>
                  {tr("menu.newGroup")}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}
          {worker ? (
            <ContextMenuItem
              disabled={readOnly}
              onSelect={() => act(b, { act: r?.hidden ? "show" : "hide" })}
            >
              {r?.hidden ? tr("menu.show") : tr("menu.hide")}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            disabled={readOnly}
            onSelect={() => act(b, { act: r?.muted ? "unmute" : "mute" })}
          >
            {r?.muted ? tr("menu.unmute") : tr("menu.mute")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={readOnly}
            onSelect={() =>
              act(b, { act: r?.unread_mark ? "mark_read" : "mark_unread" })
            }
          >
            {r?.unread_mark ? tr("menu.markRead") : tr("menu.markUnread")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={readOnly}
            onSelect={() => act(b, { act: "notify", on: !(r?.notify ?? true) })}
          >
            <span className="flex-1">{tr("menu.notifyOn")}</span>
            {(r?.notify ?? true) ? <span aria-hidden>✓</span> : null}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {worker ? (
            <ContextMenuItem disabled={readOnly} onSelect={() => void copy(b)}>
              {tr("menu.copy")}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem disabled={readOnly} onSelect={() => stopAll(b)}>
            {tr("menu.stopAll")}
          </ContextMenuItem>
          {worker ? (
            <ContextMenuItem
              disabled={readOnly}
              variant="destructive"
              onSelect={() => setDeleting(b.id)}
            >
              {tr("menu.delete")}
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const row = (b: RosterEntry, opts: { draggable?: boolean } = {}) => {
    const view = viewOf(b.live, now, b.roster?.unread_mark)
    const line = view.stale ? null : rowLine(tt, b, view, now)
    const lastLine = b.live?.last_line
    const shownLine =
      line ??
      (lastLine ? { text: lastLine.text, tone: "plain" as const } : null)
    const at = b.live?.last_activity_at
    const isCurrent = b.id === currentId
    const button = (
      <button
        type="button"
        data-pa-roster-bot={b.id}
        data-pa-roster-look={view.look}
        aria-current={isCurrent ? "page" : undefined}
        onClick={() => go(b)}
        draggable={opts.draggable && !readOnly}
        onDragStart={(e) => {
          if (!opts.draggable) return
          setDragging(b.id)
          e.dataTransfer.effectAllowed = "move"
          e.dataTransfer.setData("text/plain", String(b.id))
        }}
        onDragEnd={() => setDragging(null)}
        onDragOver={(e) => {
          if (opts.draggable && dragging != null && dragging !== b.id) {
            e.preventDefault()
          }
        }}
        onDrop={(e) => {
          if (!opts.draggable || dragging == null || dragging === b.id) return
          e.preventDefault()
          const ids = groups.pinned
            .map((p) => p.id)
            .filter((id) => id !== dragging)
          ids.splice(ids.indexOf(b.id), 0, dragging)
          void personalAgentRosterAct(dragging, { act: "order", ids }).catch(
            (err) => toast.error(toErrorMessage(err))
          )
          setDragging(null)
        }}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors",
          isCurrent
            ? "bg-accent text-accent-foreground"
            : "text-foreground/85 hover:bg-muted",
          dragging === b.id && "opacity-50"
        )}
      >
        {face(b, 28)}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-sm">
              {botName(b)}
            </span>
            {b.roster?.muted ? (
              <VolumeX
                className="size-3 shrink-0 text-muted-foreground"
                aria-label={tr("muted")}
              />
            ) : null}
            {at ? (
              <span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
                {time(at)}
              </span>
            ) : null}
          </span>
          {shownLine ? (
            <span
              data-pa-roster-line={shownLine.tone}
              className={cn(
                "truncate text-xs",
                shownLine.tone === "needs"
                  ? "text-orange-700 dark:text-orange-300"
                  : shownLine.tone === "ready"
                    ? "text-teal-700 dark:text-teal-300"
                    : shownLine.tone === "busy"
                      ? "activity-shimmer text-muted-foreground"
                      : "text-muted-foreground"
              )}
            >
              {shownLine.text}
            </span>
          ) : null}
        </span>
      </button>
    )
    return (
      <HoverCard openDelay={500} closeDelay={80}>
        {menu(b, <HoverCardTrigger asChild>{button}</HoverCardTrigger>)}
        <HoverCardContent side="right" align="start" className="w-72">
          {hover(b, view)}
        </HoverCardContent>
      </HoverCard>
    )
  }

  const add = (
    <Button
      size={compact ? "icon-sm" : "icon-xs"}
      variant="ghost"
      disabled={readOnly}
      aria-label={tr("add")}
      title={tr("add")}
      onClick={() => setAdding(true)}
      data-pa-roster-add
    >
      <Plus aria-hidden />
    </Button>
  )

  const dialogs = (
    <>
      <NewBotDialog open={adding} onOpenChange={setAdding} />
      <BotDeleteDialog
        botId={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      />
      <NewGroupDialog
        key={grouping?.id ?? "none"}
        target={grouping}
        onClose={() => setGrouping(null)}
        onSave={(name) => {
          if (grouping) act(grouping, { act: "section", name })
          setGrouping(null)
        }}
      />
    </>
  )

  if (compact) {
    const strip = [
      ...(groups.primary ? [groups.primary] : []),
      ...groups.pinned,
      ...groups.sections.flatMap((s) => s.entries),
      ...groups.rest,
    ]
    return (
      <>
        <div
          data-pa-roster
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-2 py-1.5"
        >
          {strip.map((b) => {
            const view = viewOf(b.live, now, b.roster?.unread_mark)
            return (
              <button
                key={b.id}
                type="button"
                data-pa-roster-bot={b.id}
                aria-current={b.id === currentId ? "page" : undefined}
                aria-label={faceLabel(b, view)}
                title={botName(b)}
                onClick={() => go(b)}
                className={cn(
                  "shrink-0 rounded-full p-0.5 transition-colors",
                  b.id === currentId
                    ? "bg-accent ring-1 ring-ring"
                    : "hover:bg-muted"
                )}
              >
                {face(b, 28)}
              </button>
            )
          })}
          {add}
        </div>
        {dialogs}
      </>
    )
  }

  const q = query?.trim().toLowerCase() ?? ""
  const matches = (b: RosterEntry) =>
    !q ||
    botName(b).toLowerCase().includes(q) ||
    (b.template
      ? (roleOf.get(b.template) ?? b.template).toLowerCase().includes(q)
      : false)
  const primary = groups.primary
  const primaryView = primary
    ? viewOf(primary.live, now, primary.roster?.unread_mark)
    : null
  const primaryLine =
    primary && primaryView && !primaryView.stale
      ? rowLine(tt, primary, primaryView, now)
      : null

  const groupHead = (label: string, foldName?: string) => (
    <div className="flex items-center gap-1 px-2 pt-3 pb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
      {foldName ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-start hover:text-foreground"
          aria-expanded={!folded.has(foldName)}
          aria-label={
            folded.has(foldName)
              ? tr("expand", { name: label })
              : tr("collapse", { name: label })
          }
          onClick={() => toggleFold(foldName)}
          data-pa-roster-section={foldName}
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 transition-transform rtl:-scale-x-100",
              !folded.has(foldName) && "rotate-90 rtl:rotate-90"
            )}
            aria-hidden
          />
          <span className="truncate">{label}</span>
        </button>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </div>
  )

  const searching = q.length > 0
  const found = searching
    ? [
        ...groups.pinned,
        ...groups.sections.flatMap((s) => s.entries),
        ...groups.rest,
        ...groups.hidden,
      ].filter(matches)
    : []
  const hasGroups = groups.pinned.length > 0 || groups.sections.length > 0

  return (
    <>
      <nav
        data-pa-roster
        aria-label={tr("title")}
        className="flex w-60 shrink-0 flex-col border-e border-border/50"
      >
        <div className="flex items-center gap-1 px-2 pt-2.5 pb-1">
          {query != null ? (
            <div className="relative min-w-0 flex-1">
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery(null)
                }}
                placeholder={tr("search")}
                aria-label={tr("search")}
                className="h-7 pe-7 text-xs"
                data-pa-roster-search
              />
              <button
                type="button"
                className="absolute end-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={tr("search")}
                onClick={() => setQuery(null)}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-muted-foreground">
                {tr("title")}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={tr("search")}
                title={tr("search")}
                onClick={() => setQuery("")}
                data-pa-roster-search-open
              >
                <Search aria-hidden />
              </Button>
            </>
          )}
          {add}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {searching ? (
            found.length > 0 ? (
              found.map((b) => <div key={b.id}>{row(b)}</div>)
            ) : (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {tr("noMatch")}
              </p>
            )
          ) : (
            <>
              {primary
                ? menu(
                    primary,
                    <button
                      type="button"
                      data-pa-roster-bot={primary.id}
                      data-pa-roster-primary
                      aria-current={
                        primary.id === currentId ? "page" : undefined
                      }
                      onClick={() => go(primary)}
                      className={cn(
                        "mt-1 flex w-full flex-col items-center gap-1 rounded-lg px-2 py-2.5 text-center transition-colors",
                        primary.id === currentId
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted"
                      )}
                    >
                      {face(primary, 56)}
                      <span className="max-w-full truncate text-sm font-medium">
                        {botName(primary)}
                      </span>
                      {primaryLine ? (
                        <span
                          data-pa-roster-line={primaryLine.tone}
                          className={cn(
                            "max-w-full truncate text-xs",
                            primaryLine.tone === "needs"
                              ? "text-orange-700 dark:text-orange-300"
                              : primaryLine.tone === "ready"
                                ? "text-teal-700 dark:text-teal-300"
                                : primaryLine.tone === "busy"
                                  ? "activity-shimmer text-muted-foreground"
                                  : "text-muted-foreground"
                          )}
                        >
                          {primaryLine.text}
                        </span>
                      ) : null}
                    </button>
                  )
                : null}
              {groups.pinned.length > 0 ? (
                <>
                  <div className="flex items-center gap-1 px-2 pt-3 pb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
                    <Pin className="size-3" aria-hidden />
                    <span>{tr("pinned")}</span>
                  </div>
                  <AnimatedRows
                    entries={groups.pinned}
                    render={(b) => row(b, { draggable: true })}
                  />
                </>
              ) : null}
              {groups.sections.map((s) => (
                <div key={s.name}>
                  {groupHead(s.name, s.name)}
                  {folded.has(s.name) ? null : (
                    <AnimatedRows entries={s.entries} render={(b) => row(b)} />
                  )}
                </div>
              ))}
              {groups.rest.length > 0 ? (
                <>
                  {hasGroups ? (
                    groupHead(tr("others"))
                  ) : (
                    <div className="h-2" />
                  )}
                  <AnimatedRows entries={groups.rest} render={(b) => row(b)} />
                </>
              ) : null}
            </>
          )}
        </div>
        {!searching && groups.hidden.length > 0 ? (
          <div className="border-t border-border/50 px-2 py-1.5">
            <button
              type="button"
              className="w-full rounded px-2 py-1 text-start text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-expanded={showHidden}
              onClick={() => setShowHidden((v) => !v)}
              data-pa-roster-hidden-toggle
            >
              {showHidden
                ? tr("hideHidden")
                : tr("hiddenCount", { count: groups.hidden.length })}
            </button>
            {showHidden ? (
              <div className="mt-1 max-h-48 overflow-y-auto">
                {groups.hidden.map((b) => (
                  <div key={b.id}>{row(b)}</div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </nav>
      {dialogs}
    </>
  )
}

/** Name a new group and move an assistant into it. */
function NewGroupDialog({
  target,
  onClose,
  onSave,
}: {
  target: RosterEntry | null
  onClose: () => void
  onSave: (name: string) => void
}) {
  const tr = useTranslations("PersonalAgent.bots.roster")
  // Each opening starts blank (the dialog is keyed by its target).
  const [name, setName] = useState("")
  const clean = name.trim()
  return (
    <Dialog
      open={target != null}
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{tr("newGroupTitle")}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && clean) onSave(clean)
          }}
          placeholder={tr("groupName")}
          aria-label={tr("groupName")}
          data-pa-roster-group-name
        />
        <DialogFooter>
          <Button disabled={!clean} onClick={() => onSave(clean)}>
            {tr("newGroupSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
