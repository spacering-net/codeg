"use client"

/**
 * The roster, the assistants page's left column (10.1, 4.14).
 *
 * - On top, the primary: a square tile, its face large with its star, and
 *   its name. What it is up to shows when hovered, with its work in hand.
 * - Then a row each: face, name, one line, a time. The line says first what
 *   the owner should know — what waits on them, what it is doing — and its
 *   last words when nothing does. The face is its state (10.6), the dot in
 *   its corner what it wants of the owner. Hovering shows the whole activity
 *   and the work in hand.
 * - Groups: the pinned ones (in the owner's order), the owner's own groups
 *   (folding), the rest. Within a group: waiting on the owner, working,
 *   idle, done, the most recent first. Each group's name on its rows' faces'
 *   edge; a row's time as short as a chat list has it.
 * - A work assistant's row is dragged onto a group to put it there — among
 *   the pinned ones at the slot it is let go over, in a group of the
 *   owner's, with the rest — or onto "new group" to name one. By the
 *   pointer, not the page's drag and drop: the desktop's webview takes that
 *   for an OS drop and never hands the page its drop.
 * - After them, "N hidden", which opens to show them; at the foot, [+ new
 *   work assistant] as a row is drawn.
 * - One measure for the room: the list as far from the top as the primary's
 *   tile from the list, the rail's tiles as far from the top as from its
 *   sides.
 * - Dragged narrower than its least width, the list folds to a rail of
 *   faces (roster-resize.tsx): the primary's, a rule, the others' in the
 *   list's order; each one's name, line and work in hand when hovered.
 * - A row's context menu: open, its page, its name and face, pin, move to a
 *   group, hide, mute, mark unread, notifications, copy, stop everything,
 *   delete.
 * - Rows come and go by their height (the motion tokens), not at once.
 * - On a narrow screen, a strip of faces over the page.
 *
 * Opening an assistant takes away the owner's own unread mark on it.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { useLocale, useTranslations } from "next-intl"
import {
  Bell,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  FolderInput,
  IdCard,
  Mail,
  MailOpen,
  MessageSquareText,
  OctagonX,
  Pin,
  PinOff,
  Plus,
  Trash2,
  UserPen,
  Volume2,
  VolumeX,
} from "lucide-react"
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
import { BotInfoDialog } from "./bot-info-dialog"
import { NewBotDialog } from "./new-bot-dialog"
import {
  groupRoster,
  rosterTime,
  sectionNames,
  viewOf,
  type BotView,
} from "./roster-order"
import {
  ROSTER_RAIL_WIDTH,
  RosterResizeHandle,
  useRosterWidth,
} from "./roster-resize"
import { useBotName } from "./shared"
import { useBotTemplates } from "./use-templates"

/** How often the roster reads the clock while something on it moves
 *  (stale states, waiting past two minutes, a face shown for a while). */
const TICK_FAST_MS = 1000
const TICK_SLOW_MS = 30_000
/** A row's height in or out. */
const ROW_MS = 240
const FOLDED_KEY = "pa:roster:folded:v1"
/** How far the pointer moves, pressed on a row, before the row is
 *  dragged. */
const DRAG_START_PX = 5

/** Where a dragged row can be put: among the pinned ones, in a group of the
 *  owner's, with the rest, or in a group to name. */
type DropGroup =
  | { kind: "pinned" }
  | { kind: "section"; name: string }
  | { kind: "rest" }
  | { kind: "new" }

interface DropTarget {
  /** The group's `data-pa-drop`. */
  key: string
  group: DropGroup
  /** Among the pinned ones: the one it goes before (`null`: the end). */
  before: number | null
}

function dropKey(g: DropGroup): string {
  return g.kind === "section" ? `section:${g.name}` : g.kind
}

function dropGroupOf(key: string): DropGroup | null {
  if (key === "pinned" || key === "rest" || key === "new") return { kind: key }
  return key.startsWith("section:")
    ? { kind: "section", name: key.slice("section:".length) }
    : null
}

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
  // A watched pull request to merge (7.4): the work it came from by name.
  if (live.attention === "needs_you" && needs?.kind === "mergeable") {
    const work = live.work_on_hand.find((w) => w.ladder === "mergeable")
    return {
      text: work
        ? t("bots.roster.mergeable", {
            id: work.dispatch_id,
            title: work.title,
          })
        : t("bots.roster.prReady", { text: needs.text }),
      tone: "ready",
    }
  }
  if (live.attention === "needs_you" && needs) {
    const ask =
      needs.kind === "question" ||
      needs.kind === "choice" ||
      needs.kind === "input"
        ? "answer"
        : needs.kind === "acceptance"
          ? "acceptance"
          : needs.kind === "uncertain" ||
              needs.kind === "loop" ||
              needs.kind === "pr_gave_up" ||
              needs.kind === "plan_stuck"
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
  // A pull request of its work that failed its checks, or conflicts.
  const red = live.work_on_hand.find(
    (w) => w.ladder === "checks_failed" || w.ladder === "stuck"
  )
  if (red) {
    return {
      text: t(
        red.ladder === "stuck" ? "bots.roster.prStuck" : "bots.roster.prFailed",
        { id: red.dispatch_id, title: red.title }
      ),
      tone: "plain",
    }
  }
  if (view.busy && live.activity) {
    return { text: activityText(t, live.activity, now), tone: "busy" }
  }
  // One waiting for its checks: how far they are.
  const checking = live.work_on_hand.find(
    (w) => w.ladder === "waiting_checks" && w.pr && w.pr.total > 0
  )
  if (checking?.pr) {
    return {
      text: t("bots.roster.prChecks", {
        id: checking.dispatch_id,
        passed: checking.pr.passed,
        total: checking.pr.total,
      }),
      tone: "plain",
    }
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

type RowLine = NonNullable<ReturnType<typeof rowLine>>

/** A line's colour by what it says. */
function lineTone(tone: RowLine["tone"]): string {
  return tone === "needs"
    ? "text-orange-700 dark:text-orange-300"
    : tone === "ready"
      ? "text-teal-700 dark:text-teal-300"
      : tone === "busy"
        ? "activity-shimmer text-muted-foreground"
        : "text-muted-foreground"
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
          {/* What folds is this one, clipped to nothing; the room apart
              from the next row is inside it, and folds with it. */}
          <div>
            <div className="py-0.5">{render(h.entry)}</div>
          </div>
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
  const templates = useBotTemplates()
  const viewBot = usePersonalAgentUi((s) => s.viewBot)
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const showConversation = usePersonalAgentUi((s) => s.showConversation)
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [grouping, setGrouping] = useState<RosterEntry | null>(null)
  const [editing, setEditing] = useState<RosterEntry | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [folded, toggleFold] = useFolded()
  // A row dragged by the pointer: where it is, and the group under it.
  const [drag, setDrag] = useState<{ id: number; x: number; y: number } | null>(
    null
  )
  const [target, setTarget] = useState<DropTarget | null>(null)
  const press = useRef<{
    id: number
    pointer: number
    x: number
    y: number
    el: HTMLElement
    /** Let go of by Esc: the rest of the press drags nothing, and its
     *  click opens nothing. */
    dropped?: boolean
  } | null>(null)
  const dragRef = useRef<{ id: number; target: DropTarget | null } | null>(null)
  // The click a drag ends in is the drop's, not a click on the row.
  const swallowClick = useRef(false)
  const navRef = useRef<HTMLElement | null>(null)
  const [size, setSize] = useRosterWidth()
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

  // Its conversation — out of its page or the settings, too.
  const go = (b: RosterEntry) => {
    setViewBot(b.kind === "primary" ? null : b.id)
    showConversation()
  }
  const openDetails = (b: RosterEntry) =>
    openBotPage("identity", { bot: b.kind === "primary" ? null : b.id })
  const act = (b: RosterEntry, a: RosterAct) => {
    void personalAgentRosterAct(b.id, a).catch((e) =>
      toast.error(toErrorMessage(e))
    )
  }

  /** The pinned ones' order with `id` put before `before` (`null`: at the
   *  end). */
  const pinnedOrder = (id: number, before: number | null): number[] => {
    const ids = groups.pinned.map((p) => p.id).filter((x) => x !== id)
    const at = before == null ? -1 : ids.indexOf(before)
    ids.splice(at < 0 ? ids.length : at, 0, id)
    return ids
  }

  /** Put `b` in `g`: where it then shows — out of the pinned ones for a
   *  group, and (dragged out of the hidden ones) shown. A group to name
   *  asks its name first. */
  const moveTo = async (
    b: RosterEntry,
    g: DropGroup,
    opts: { before?: number | null; show?: boolean } = {}
  ) => {
    if (g.kind === "new") {
      setGrouping(b)
      return
    }
    const r = b.roster
    const show = opts.show && r?.hidden
    const acts: RosterAct[] = []
    if (g.kind === "pinned") {
      if (show) acts.push({ act: "show" })
      if (!r?.pinned_at) acts.push({ act: "pin" })
      // Newly pinned, it goes at the end; anywhere else, the order says.
      if (r?.pinned_at || opts.before != null) {
        acts.push({ act: "order", ids: pinnedOrder(b.id, opts.before ?? null) })
      }
    } else {
      const name = g.kind === "section" ? g.name : null
      if ((r?.section?.trim() || null) !== name) {
        acts.push({ act: "section", name })
      }
      // Its group first: unpinned before, it would show a moment where it
      // was.
      if (r?.pinned_at) acts.push({ act: "unpin" })
      if (show) acts.push({ act: "show" })
    }
    try {
      for (const a of acts) await personalAgentRosterAct(b.id, a)
    } catch (e) {
      toast.error(toErrorMessage(e))
    }
  }

  /** Whether `b` put in `g` would move: not into the group it is in. */
  const moves = (b: RosterEntry, g: DropGroup): boolean => {
    const r = b.roster
    const section = r?.section?.trim() || null
    switch (g.kind) {
      case "pinned":
      case "new":
        return true
      case "section":
        return !!r?.pinned_at || !!r?.hidden || section !== g.name
      case "rest":
        return !!r?.pinned_at || !!r?.hidden || section != null
    }
  }

  /** The group under the pointer, for the row `id` dragged — and among the
   *  pinned ones, the slot: before the first other row whose middle is
   *  below the pointer. */
  const hitTest = (x: number, y: number, id: number): DropTarget | null => {
    const el =
      typeof document.elementFromPoint === "function"
        ? (document.elementFromPoint(x, y) as HTMLElement | null)
        : null
    const zone = el?.closest<HTMLElement>("[data-pa-drop]") ?? null
    if (!zone || !navRef.current?.contains(zone)) return null
    const key = zone.dataset.paDrop ?? ""
    const group = dropGroupOf(key)
    const b = list.find((e) => e.id === id)
    if (!group || !b || !moves(b, group)) return null
    if (group.kind !== "pinned") return { key, group, before: null }
    let before: number | null = null
    for (const rowEl of zone.querySelectorAll<HTMLElement>(
      "[data-pa-roster-bot]"
    )) {
      if (rowEl.closest('[data-pa-roster-row-state="out"]')) continue
      // Not before itself: over its own row it stays where it is.
      if (Number(rowEl.dataset.paRosterBot) === id) continue
      const r = rowEl.getBoundingClientRect()
      if (y < r.top + r.height / 2) {
        before = Number(rowEl.dataset.paRosterBot)
        break
      }
    }
    // Where it already is: nowhere to put it.
    if (b.roster?.pinned_at && !b.roster.hidden) {
      const held = groups.pinned.map((p) => p.id)
      const next = pinnedOrder(id, before)
      if (next.every((v, i) => v === held[i])) return null
    }
    return { key, group, before }
  }

  /** The click the press ends in is the drag's, not a click on the row. */
  const swallowNextClick = () => {
    swallowClick.current = true
    window.setTimeout(() => {
      swallowClick.current = false
    }, 0)
  }

  /** The press let go (`commit`: dropped where it is), or the drag let go
   *  of by Esc (`held`: the button still down). */
  const endDrag = (pointer: number, commit: boolean, held = false) => {
    const p = press.current
    if (!p || p.pointer !== pointer) return
    const d = dragRef.current
    dragRef.current = null
    if (held) press.current = { ...p, dropped: true }
    else {
      press.current = null
      if (p.dropped) swallowNextClick()
    }
    // A press that never moved: its click opens the row.
    if (!d) return
    delete document.documentElement.dataset.paRosterDragging
    setDrag(null)
    setTarget(null)
    if (!held) swallowNextClick()
    const b = list.find((e) => e.id === d.id)
    if (commit && b && d.target) {
      void moveTo(b, d.target.group, { before: d.target.before, show: true })
    }
  }

  // Esc lets go of a dragged row where it was.
  const dragging = drag != null
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      const p = press.current
      if (p) endDrag(p.pointer, false, true)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging])
  // Gone mid-drag (the page left): nothing kept dragging.
  useEffect(
    () => () => {
      delete document.documentElement.dataset.paRosterDragging
    },
    []
  )

  /** A work assistant's row, dragged by the pointer onto a group. Not by
   *  touch: a finger on the list scrolls it. */
  const dragHandlers = (b: RosterEntry) =>
    readOnly || b.kind === "primary"
      ? {}
      : {
          onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
            if (e.button !== 0 || e.pointerType === "touch") return
            press.current = {
              id: b.id,
              pointer: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              el: e.currentTarget,
            }
          },
          onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
            const p = press.current
            if (!p || p.pointer !== e.pointerId || p.dropped) return
            if (!dragRef.current) {
              // Let go somewhere else since: nothing to drag.
              if ((e.buttons & 1) === 0) {
                press.current = null
                return
              }
              if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START_PX)
                return
              try {
                p.el.setPointerCapture?.(e.pointerId)
              } catch {
                // Not capturable: the moves still come while over the row.
              }
              dragRef.current = { id: p.id, target: null }
              document.documentElement.dataset.paRosterDragging = ""
            }
            const d = dragRef.current
            const next = hitTest(e.clientX, e.clientY, p.id)
            d.target = next
            setDrag({ id: p.id, x: e.clientX, y: e.clientY })
            setTarget((held) =>
              held?.key === next?.key && held?.before === next?.before
                ? held
                : next
            )
          },
          onPointerUp: (e: ReactPointerEvent<HTMLElement>) =>
            endDrag(e.pointerId, true),
          onPointerCancel: (e: ReactPointerEvent<HTMLElement>) =>
            endDrag(e.pointerId, false),
          onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) =>
            endDrag(e.pointerId, false),
        }

  /** A group a row can be dragged onto: its `data-pa-drop`, lit while the
   *  row is over it. */
  const dropZone = (g: DropGroup) => {
    const key = dropKey(g)
    const over = target?.key === key
    return {
      "data-pa-drop": key,
      "data-pa-drop-over": over || undefined,
      className: cn(
        "rounded-xl transition-colors",
        over && "bg-accent/50 ring-1 ring-primary/25"
      ),
    }
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

  /** What a row says under its name (10.1): its last words when its
   *  state is stale, or says nothing more. */
  const shownLineOf = (b: RosterEntry, view: BotView): RowLine | null => {
    const line = view.stale ? null : rowLine(tt, b, view, now)
    const last = b.live?.last_line
    return line ?? (last ? { text: last.text, tone: "plain" } : null)
  }

  /** The card a face shows when hovered: who, what it is doing, its work
   *  in hand and whom it waits for — and, for one whose line is not shown
   *  (the primary's tile, a face on the rail), that line first. */
  const hover = (b: RosterEntry, view: BotView, line?: RowLine | null) => {
    const live = b.live
    const role = b.template ? (roleOf.get(b.template) ?? null) : null
    return (
      <div className="flex flex-col gap-2 text-xs" data-pa-roster-hover={b.id}>
        <div className="flex items-center gap-2">
          {face(b, 28)}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{botName(b)}</div>
            {role ? (
              <div className="truncate text-muted-foreground">{role}</div>
            ) : null}
          </div>
        </div>
        {line ? (
          <p
            data-pa-roster-line={line.tone}
            className={cn("break-words", lineTone(line.tone))}
          >
            {line.text}
          </p>
        ) : null}
        {view.stale ? (
          <p className="text-muted-foreground">{t("face.stale")}</p>
        ) : live?.activity && view.busy && line?.tone !== "busy" ? (
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
                    {w.ladder === "waiting_checks" &&
                    w.pr &&
                    w.pr.checks_known &&
                    w.pr.total > 0
                      ? tt("ladder.waiting_checks_n", {
                          passed: w.pr.passed,
                          total: w.pr.total,
                        })
                      : tt(`ladder.${w.ladder ?? "working"}`)}
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
    const notify = r?.notify ?? true
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
        <ContextMenuContent data-pa-roster-menu={b.id} className="min-w-48">
          <ContextMenuItem onSelect={() => go(b)}>
            <MessageSquareText aria-hidden />
            {tr("menu.open")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => openDetails(b)}
            data-pa-roster-details={b.id}
          >
            <IdCard aria-hidden />
            {tr("menu.details")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={readOnly}
            onSelect={() => setEditing(b)}
            data-pa-roster-edit={b.id}
          >
            <UserPen aria-hidden />
            {tr("menu.edit")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {worker ? (
            <ContextMenuItem
              disabled={readOnly}
              onSelect={() => act(b, { act: r?.pinned_at ? "unpin" : "pin" })}
            >
              {r?.pinned_at ? <PinOff aria-hidden /> : <Pin aria-hidden />}
              {r?.pinned_at ? tr("menu.unpin") : tr("menu.pin")}
            </ContextMenuItem>
          ) : null}
          {worker ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={readOnly}>
                <FolderInput aria-hidden />
                {tr("menu.moveTo")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {sections.map((name) => (
                  <ContextMenuItem
                    key={name}
                    disabled={!r?.pinned_at && r?.section === name}
                    onSelect={() => void moveTo(b, { kind: "section", name })}
                  >
                    {name}
                  </ContextMenuItem>
                ))}
                <ContextMenuItem
                  disabled={!r?.pinned_at && !r?.section}
                  onSelect={() => void moveTo(b, { kind: "rest" })}
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
              {r?.hidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
              {r?.hidden ? tr("menu.show") : tr("menu.hide")}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            disabled={readOnly}
            onSelect={() => act(b, { act: r?.muted ? "unmute" : "mute" })}
          >
            {r?.muted ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
            {r?.muted ? tr("menu.unmute") : tr("menu.mute")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={readOnly}
            onSelect={() =>
              act(b, { act: r?.unread_mark ? "mark_read" : "mark_unread" })
            }
          >
            {r?.unread_mark ? <MailOpen aria-hidden /> : <Mail aria-hidden />}
            {r?.unread_mark ? tr("menu.markRead") : tr("menu.markUnread")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={readOnly}
            onSelect={() => act(b, { act: "notify", on: !notify })}
          >
            <Bell aria-hidden />
            <span className="flex-1">{tr("menu.notifyOn")}</span>
            {notify ? <span aria-hidden>✓</span> : null}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {worker ? (
            <ContextMenuItem disabled={readOnly} onSelect={() => void copy(b)}>
              <Copy aria-hidden />
              {tr("menu.copy")}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem disabled={readOnly} onSelect={() => stopAll(b)}>
            <OctagonX aria-hidden />
            {tr("menu.stopAll")}
          </ContextMenuItem>
          {worker ? (
            <ContextMenuItem
              disabled={readOnly}
              variant="destructive"
              onSelect={() => setDeleting(b.id)}
            >
              <Trash2 aria-hidden />
              {tr("menu.delete")}
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  /** Where a row dragged among the pinned ones would go: before this
   *  one, or after it (the last). */
  const slotLine = (b: RosterEntry): "before" | "after" | null => {
    if (target?.key !== "pinned") return null
    if (target.before === b.id) return "before"
    const last = groups.pinned[groups.pinned.length - 1]
    return target.before == null && last?.id === b.id ? "after" : null
  }

  const row = (b: RosterEntry) => {
    const view = viewOf(b.live, now, b.roster?.unread_mark)
    const shownLine = shownLineOf(b, view)
    const at = b.live?.last_activity_at
    const isCurrent = b.id === currentId
    const line = slotLine(b)
    const lifted = drag?.id === b.id
    const button = (
      <button
        type="button"
        data-pa-roster-bot={b.id}
        data-pa-roster-look={view.look}
        data-pa-roster-dragged={lifted || undefined}
        data-pa-face-host
        aria-current={isCurrent ? "page" : undefined}
        onClick={() => {
          if (swallowClick.current) return
          go(b)
        }}
        onFocus={hoverOnly}
        {...dragHandlers(b)}
        className={cn(
          "relative flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-start transition-colors",
          isCurrent
            ? "bg-accent text-accent-foreground"
            : "text-foreground/85 hover:bg-muted",
          lifted && "cursor-grabbing opacity-40"
        )}
      >
        {line ? (
          <span
            aria-hidden
            data-pa-roster-slot={line}
            className={cn(
              "pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-primary",
              line === "before" ? "-top-[3px]" : "-bottom-[3px]"
            )}
          />
        ) : null}
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
                {rosterTime(at, now, locale)}
              </span>
            ) : null}
          </span>
          {shownLine ? (
            <span
              data-pa-roster-line={shownLine.tone}
              className={cn("truncate text-xs", lineTone(shownLine.tone))}
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
        <HoverCardContent
          side="right"
          align="start"
          className="w-72"
          data-pa-roster-hovercard
        >
          {hover(b, view)}
        </HoverCardContent>
      </HoverCard>
    )
  }

  const add = (
    <Button
      size="icon-sm"
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
          if (grouping) {
            void moveTo(grouping, { kind: "section", name }, { show: true })
          }
          setGrouping(null)
        }}
      />
      <BotInfoDialog
        bot={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
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

  const primary = groups.primary

  /** A face that says no more than itself — the primary's tile, one on the
   *  rail: its line and its work in hand on the card it shows when
   *  hovered. */
  const tile = (b: RosterEntry, look: (view: BotView) => ReactNode) => {
    const view = viewOf(b.live, now, b.roster?.unread_mark)
    const isCurrent = b.id === currentId
    return (
      <HoverCard key={b.id} openDelay={500} closeDelay={80}>
        {menu(
          b,
          <HoverCardTrigger asChild>
            <button
              type="button"
              data-pa-roster-bot={b.id}
              data-pa-roster-primary={b.kind === "primary" || undefined}
              data-pa-roster-look={view.look}
              data-pa-face-host
              aria-current={isCurrent ? "page" : undefined}
              onClick={() => go(b)}
              onFocus={hoverOnly}
              className={cn(
                "flex shrink-0 flex-col items-center justify-center rounded-xl text-center transition-colors",
                isCurrent
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground/85 hover:bg-muted"
              )}
              {...(size.rail
                ? { "aria-label": faceLabel(b, view), "data-pa-rail-tile": "" }
                : {})}
            >
              {look(view)}
            </button>
          </HoverCardTrigger>
        )}
        <HoverCardContent
          side="right"
          align="start"
          className="w-72"
          data-pa-roster-hovercard
        >
          {hover(b, view, shownLineOf(b, view))}
        </HoverCardContent>
      </HoverCard>
    )
  }

  /** The primary on top: a square, its face large, its name under it. */
  const primaryTile = (b: RosterEntry) => (
    <div className="flex justify-center pb-3">
      {tile(b, () => (
        <span className="flex size-24 flex-col items-center justify-center gap-1 px-1.5">
          {face(b, 56)}
          <span className="max-w-full truncate text-sm">{botName(b)}</span>
        </span>
      ))}
    </div>
  )

  /** A face on the rail. */
  const railTile = (b: RosterEntry) =>
    tile(b, () => (
      <span className="flex size-13 items-center justify-center">
        {face(b, 36)}
      </span>
    ))

  /** "N hidden", after the list: it opens to show them under it — on the
   *  rail, an eye and the count. */
  const hiddenToggle = (rail: boolean) => {
    const count = tr("hiddenCount", { count: groups.hidden.length })
    return (
      <button
        type="button"
        className={cn(
          rail
            ? "mt-1 flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-muted hover:text-foreground"
            : cn(HEAD_CLASS, "w-full text-start hover:text-foreground")
        )}
        aria-expanded={showHidden}
        aria-label={rail ? (showHidden ? tr("hideHidden") : count) : undefined}
        title={rail ? count : undefined}
        onClick={() => setShowHidden((v) => !v)}
        data-pa-roster-hidden-toggle
      >
        {rail ? (
          <>
            <EyeOff className="size-3.5" aria-hidden />
            {groups.hidden.length}
          </>
        ) : (
          <>
            <span className="truncate">{count}</span>
            <FoldChevron open={showHidden} />
          </>
        )}
      </button>
    )
  }

  /** [+ new work assistant], at the foot: a row's geometry, a circle with a
   *  plus where a face would be; on the rail, a tile's, the circle alone. */
  const addButton = (rail: boolean) => (
    <button
      type="button"
      disabled={readOnly}
      onClick={() => setAdding(true)}
      aria-label={rail ? tr("add") : undefined}
      title={rail ? tr("add") : undefined}
      data-pa-roster-add
      className={cn(
        "group/add flex items-center rounded-xl text-sm text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
        rail ? "size-13 shrink-0 justify-center" : "w-full gap-2.5 px-2 py-1.5"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors group-hover/add:text-foreground",
          rail ? "size-9" : "size-7"
        )}
      >
        <Plus className="size-4" />
      </span>
      {rail ? null : (
        <span className="min-w-0 truncate text-start">{tr("add")}</span>
      )}
    </button>
  )

  if (size.rail) {
    const others = [
      ...groups.pinned,
      ...groups.sections.flatMap((s) => s.entries),
      ...groups.rest,
    ]
    // As wide as a tile, as far from the faces on either side as the
    // tiles are from the rail's edges.
    const rule = (
      <div aria-hidden className="my-2 h-px w-13 shrink-0 bg-border" />
    )
    return (
      <>
        <nav
          data-pa-roster
          data-pa-roster-rail
          aria-label={tr("title")}
          style={{ width: `${ROSTER_RAIL_WIDTH}rem` }}
          className="flex max-w-[50%] shrink-0 flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto pt-4 pb-3">
            {primary ? railTile(primary) : null}
            {primary && others.length > 0 ? rule : null}
            {others.map(railTile)}
            {groups.hidden.length > 0 ? hiddenToggle(true) : null}
            {showHidden && groups.hidden.length > 0 ? (
              <>
                {rule}
                {groups.hidden.map(railTile)}
              </>
            ) : null}
          </div>
          <div
            data-pa-roster-foot
            className="flex justify-center border-t border-border/50 py-2"
          >
            {addButton(true)}
          </div>
        </nav>
        <RosterResizeHandle size={size} onSize={setSize} />
        {dialogs}
      </>
    )
  }

  /** A group's name over its rows, on their faces' edge; one the owner
   *  made folds, its chevron after its name. */
  const groupHead = (label: string, foldName?: string) =>
    foldName ? (
      <button
        type="button"
        className={cn(HEAD_CLASS, "w-full text-start hover:text-foreground")}
        aria-expanded={!folded.has(foldName)}
        aria-label={
          folded.has(foldName)
            ? tr("expand", { name: label })
            : tr("collapse", { name: label })
        }
        onClick={() => toggleFold(foldName)}
        data-pa-roster-section={foldName}
      >
        <span className="truncate">{label}</span>
        <FoldChevron open={!folded.has(foldName)} />
      </button>
    ) : (
      <div className={HEAD_CLASS}>
        <span className="truncate">{label}</span>
      </div>
    )

  const hasGroups = groups.pinned.length > 0 || groups.sections.length > 0
  const dragged = drag ? (list.find((e) => e.id === drag.id) ?? null) : null

  return (
    <>
      <nav
        ref={navRef}
        data-pa-roster
        aria-label={tr("title")}
        // Its width is the owner's (dragged on the handle after it), never
        // past half the room the conversation and it share.
        style={{ width: `${size.width}rem` }}
        className="flex max-w-[50%] shrink-0 flex-col"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-4 pb-3">
          {primary ? primaryTile(primary) : null}
          {/* The groups, each its name over its rows, a little apart. */}
          <div className="flex flex-col gap-2">
            {groups.pinned.length > 0 ? (
              <div
                data-pa-roster-group="pinned"
                {...dropZone({ kind: "pinned" })}
              >
                {groupHead(tr("pinned"))}
                <AnimatedRows entries={groups.pinned} render={row} />
              </div>
            ) : null}
            {groups.sections.map((s) => (
              <div
                key={s.name}
                data-pa-roster-group={s.name}
                {...dropZone({ kind: "section", name: s.name })}
              >
                {groupHead(s.name, s.name)}
                {folded.has(s.name) ? null : (
                  <AnimatedRows entries={s.entries} render={row} />
                )}
              </div>
            ))}
            {groups.rest.length > 0 || (drag && hasGroups) ? (
              <div data-pa-roster-group="rest" {...dropZone({ kind: "rest" })}>
                {hasGroups ? groupHead(tr("others")) : null}
                <AnimatedRows entries={groups.rest} render={row} />
              </div>
            ) : null}
            {groups.hidden.length > 0 ? (
              <div data-pa-roster-group="hidden">
                {hiddenToggle(false)}
                {showHidden
                  ? groups.hidden.map((b) => (
                      <div key={b.id} className="py-0.5">
                        {row(b)}
                      </div>
                    ))
                  : null}
              </div>
            ) : null}
            {/* While a row is dragged: a group to name, for it. */}
            {drag ? (
              <div
                {...dropZone({ kind: "new" })}
                className={cn(
                  "flex h-9 items-center justify-center gap-1.5 rounded-xl border border-dashed text-xs transition-colors",
                  target?.key === "new"
                    ? "border-primary/40 bg-accent/50 text-foreground"
                    : "border-border text-muted-foreground"
                )}
              >
                <Plus className="size-3.5" aria-hidden />
                {tr("dropNewGroup")}
              </div>
            ) : null}
          </div>
        </div>
        <div data-pa-roster-foot className="border-t border-border/50 p-2">
          {addButton(false)}
        </div>
      </nav>
      <RosterResizeHandle size={size} onSize={setSize} />
      {dialogs}
      {/* The row dragged, under the pointer. */}
      {drag && dragged
        ? createPortal(
            <div
              aria-hidden
              data-pa-roster-ghost={dragged.id}
              className="pointer-events-none fixed z-50 flex max-w-56 items-center gap-2 rounded-xl border border-border bg-popover py-1.5 ps-1.5 pe-3 text-sm text-popover-foreground shadow-lg"
              style={{
                left: drag.x,
                top: drag.y,
                transform: "translate(12px, 8px)",
              }}
            >
              {face(dragged, 24)}
              <span className="min-w-0 truncate">{botName(dragged)}</span>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/** A face's card opens on the pointer alone, not on focus: the focus a
 *  row's menu hands back to it, closing, would leave the card open over
 *  what the menu opened. (Prevented, the card's own focus handler stands
 *  down.) */
function hoverOnly(e: { preventDefault: () => void }) {
  e.preventDefault()
}

/** A group's name, over its rows: on the rows' faces' edge. */
const HEAD_CLASS =
  "flex h-7 min-w-0 items-center gap-1 px-2 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase"

/** After a folding group's name: down while it is open, toward the end of
 *  the line while it is folded. */
function FoldChevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      className={cn(
        "size-3 shrink-0 transition-transform",
        !open && "-rotate-90 rtl:rotate-90"
      )}
      aria-hidden
    />
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
