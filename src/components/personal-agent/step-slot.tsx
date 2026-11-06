"use client"

/**
 * A reply's one step slot. While the turn runs it holds the step the agent is
 * on — a text run streaming over several lines, or a line of words (no tool
 * icon) for anything else — and a new step replaces the one before; once the
 * turn ended it holds the last text, as the body.
 *
 * What to show comes from `replyView`; this only paces it, and none of the
 * pacing changes what is stored:
 * - a non-text step replaced within ~300ms never shows on its own (the wait
 *   is capped, so a steady stream of quick steps still shows some);
 * - a text stays at least ~1s before anything replaces it;
 * - a step waiting on the owner shows at once;
 * - when the turn ends, whatever waits to show is dropped and the body shows
 *   at once — keyed like the step it streamed in, so the common case (the
 *   turn ended on its text) is the same element, not a remount.
 * Replacing fades the new step in, and the slot's height follows over 200ms;
 * reduced motion turns both off.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { JsonRenderScope } from "@/components/ai-elements/json-render-pre"
import { MessageResponse } from "@/components/ai-elements/message"
import { useReducedMotion } from "@/hooks/use-chat-motion"
import { useElapsedLabel } from "@/hooks/use-elapsed-label"
import { cleanTitle } from "@/lib/activity/progress"
import { cn } from "@/lib/utils"

import type { SlotView, StepInfo } from "./reply-view"
import { BUBBLE_MARKDOWN, MARKDOWN_LIST_ROOM } from "./shared"

/** A non-text step replaced sooner than this never shows. */
const STEP_SETTLE_MS = 300
/** The longest a step waits to settle before it shows anyway. */
const STEP_WAIT_CAP_MS = 900
/** A text stays at least this long before a step replaces it. */
const TEXT_DWELL_MS = 1000
/** A step's time shows once it has run this long. */
const ELAPSED_AFTER_MS = 2000
const HEIGHT_MS = 200

/** The personal agent's own tools, by name as agents title them
 *  (`mcp__codeg__dispatch`, `codeg.dispatch`, `dispatch`…). */
const OWN_TOOLS =
  /(?:^|[\s_.:/-])(dispatch_followup|dispatch|item_list|item_read|item_update|timeline_read|assistant_list|project_list)(?:$|[\s(:)])/i

type OwnTool =
  | "dispatch"
  | "dispatch_followup"
  | "items"
  | "timeline_read"
  | "assistant_list"
  | "project_list"

export function ownToolOf(title: string): OwnTool | null {
  const m = OWN_TOOLS.exec(title)
  if (!m) return null
  const name = m[1].toLowerCase()
  if (name.startsWith("item_")) return "items"
  return name as OwnTool
}

/** The tool kinds a step names on its own when the agent gave no title. */
const KNOWN_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "plan",
  "compact",
  "question",
])

/** The one line a non-text step reads as. */
function useStepLabel(): (step: StepInfo) => string {
  const t = useTranslations("PersonalAgent.step")
  return (step) => {
    const title = cleanTitle(step.title)
    if (step.awaiting) return t("awaiting", { title: title ?? t("anAction") })
    switch (step.kind) {
      case "think":
        return t("thinking")
      case "compact":
        return t("compacting")
      case "plan":
        return title ? t("planNamed", { title }) : t("plan")
    }
    const own = ownToolOf(step.title)
    if (own) return t(`own.${own}`)
    if (title) return title
    return t(
      `kind.${KNOWN_KINDS.has(step.kind) ? step.kind : "other"}` as "kind.other"
    )
  }
}

function StepLine({ step, live }: { step: StepInfo; live: boolean }) {
  const label = useStepLabel()(step)
  const elapsedLabel = useElapsedLabel()
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  const ran = now - startedAt
  const elapsed = live && ran >= ELAPSED_AFTER_MS ? elapsedLabel(ran) : null
  const thinking = step.kind === "think"
  return (
    <div
      className={cn(
        // The text's own line: a one-line reply is as tall on a step as on
        // its text, so the bubble does not jump when the one replaces the
        // other.
        "flex min-h-5 min-w-0 items-center gap-2 text-sm",
        step.awaiting
          ? "text-amber-700 dark:text-amber-300"
          : "text-muted-foreground"
      )}
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          live && (thinking || !step.awaiting) && "activity-shimmer"
        )}
        title={label}
      >
        {label}
      </span>
      {elapsed ? (
        <span className="shrink-0 text-xs tabular-nums">{elapsed}</span>
      ) : null}
    </div>
  )
}

function SlotContent({ view, live }: { view: SlotView; live: boolean }) {
  const t = useTranslations("PersonalAgent.reply")
  switch (view.kind) {
    case "text":
      return (
        <JsonRenderScope>
          <MessageResponse
            className={cn("text-sm", MARKDOWN_LIST_ROOM, BUBBLE_MARKDOWN)}
            mode={view.streaming ? "streaming" : undefined}
            parseIncompleteMarkdown={view.streaming ? true : undefined}
          >
            {view.text}
          </MessageResponse>
        </JsonRenderScope>
      )
    case "step":
      return <StepLine step={view.step} live={live} />
    case "waiting":
      return (
        <div
          className="flex h-5 items-center gap-1"
          role="status"
          aria-label={t("starting")}
        >
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 rounded-full bg-muted-foreground/60 motion-safe:animate-bounce"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          ))}
        </div>
      )
    case "note":
      return (
        <p className="text-sm text-muted-foreground">
          {view.note === "dispatched"
            ? t("noteDispatched", { count: view.count })
            : view.note === "continued"
              ? t("noteContinued", { count: view.count })
              : t("noteNothing")}
        </p>
      )
  }
}

export function StepSlot({
  view,
  running,
}: {
  view: SlotView | null
  running: boolean
}) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState<SlotView | null>(view)
  const shownAt = useRef(Date.now())
  const waitingSince = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(view)
  useEffect(() => {
    latest.current = view
  })

  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
    const show = (next: SlotView | null) => {
      clear()
      waitingSince.current = null
      shownAt.current = Date.now()
      setShown(next)
    }
    if (!view || !running) {
      // Ended (or nothing to show): no pacing, nothing left waiting.
      show(view)
      return
    }
    if (shown && shown.key === view.key) {
      // The same step grew or changed in place.
      clear()
      waitingSince.current = null
      setShown(view)
      return
    }
    const now = Date.now()
    const dwellLeft =
      shown?.kind === "text"
        ? Math.max(0, TEXT_DWELL_MS - (now - shownAt.current))
        : 0
    let delay = dwellLeft
    if (view.kind === "step" && !view.step.awaiting) {
      if (waitingSince.current == null) waitingSince.current = now
      const capLeft = Math.max(
        0,
        STEP_WAIT_CAP_MS - (now - waitingSince.current)
      )
      delay = Math.max(delay, Math.min(STEP_SETTLE_MS, capLeft))
    } else if (view.kind === "step" && view.step.awaiting) {
      delay = 0
    }
    if (delay === 0) {
      show(view)
      return
    }
    clear()
    timer.current = setTimeout(() => show(latest.current), delay)
    // `shown` is read, not followed: following it would re-run on our own
    // update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, running])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  // The height follows a replacement over HEIGHT_MS; between replacements
  // it is the content's own (a growing text never clips). The slot clips
  // only while a replacement plays (the new step slides in from below, and
  // the height eases): settled, nothing in it is cut — a list's bullets hang
  // outside its text, past the slot's edge.
  const outer = useRef<HTMLDivElement | null>(null)
  const inner = useRef<HTMLDivElement | null>(null)
  const lastHeight = useRef<number | null>(null)
  const lastKey = useRef<string | null>(shown?.key ?? null)
  useLayoutEffect(() => {
    const box = outer.current
    const content = inner.current
    if (!box || !content) return
    const key = shown?.key ?? null
    const from = lastHeight.current
    const to = content.offsetHeight
    const replaced = key !== lastKey.current
    lastKey.current = key
    if (!replaced || reduced || from == null) return
    box.style.overflow = "hidden"
    if (from !== to) {
      box.style.height = `${from}px`
      void box.offsetHeight
      box.style.transition = `height ${HEIGHT_MS}ms ease-out`
      box.style.height = `${to}px`
    }
    const done = () => {
      box.style.transition = ""
      box.style.height = ""
      box.style.overflow = ""
    }
    const t = setTimeout(done, HEIGHT_MS + 40)
    // A replacement cut short (the next one, or reduced motion turned on)
    // leaves nothing behind either.
    return () => {
      clearTimeout(t)
      done()
    }
  }, [shown?.key, reduced])
  useEffect(() => {
    const content = inner.current
    if (!content || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      lastHeight.current = content.offsetHeight
    })
    ro.observe(content)
    lastHeight.current = content.offsetHeight
    return () => ro.disconnect()
  }, [])

  // Only a replacement animates in, never the first paint (a reply loaded
  // from history appears as it is).
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
  }, [])
  const animate = mounted.current && !reduced

  return (
    <div ref={outer}>
      <div ref={inner}>
        {shown ? (
          <div
            key={shown.key}
            className={cn(
              animate &&
                "animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
            )}
          >
            <SlotContent view={shown} live={running} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
