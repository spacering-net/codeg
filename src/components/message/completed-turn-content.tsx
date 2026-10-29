"use client"

import { memo, useCallback, useId, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import {
  splitTrailingAnswerParts,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"
import { formatElapsedLabel } from "@/lib/format-elapsed"
import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/instant-collapsible"
import { buildActivity, hasVisibleAnswer } from "@/lib/activity/build-activity"
import { disclosureKeysFor } from "@/lib/activity/group"
import { ActivityParts, ContentPartsRenderer } from "./content-parts-renderer"
import { ActivityHeader } from "./activity/activity-header"
import { useActivityLive } from "./activity/activity-live-context"
import { openDisclosures } from "./activity/disclosure-store"
import { useFoldBack } from "./activity/fold-back"
import { WorkingMark } from "./activity/rail-icon"
import { ReplyMotion } from "./reply-motion"

export interface SplitAssistantTurnParts {
  progress: AdaptedContentPart[]
  answer: AdaptedContentPart[]
}

/**
 * Split a completed assistant reply at its last progress item. Text before or
 * between tool/reasoning work is intermediate commentary; trailing response
 * content is the final answer and must remain visible. A text-only response is
 * left untouched because there is no reliable signal that any of it is
 * progress rather than the answer.
 *
 * The progress/answer taxonomy is the adapter's (`isTurnAnswerPart`), shared
 * with the Goal capsule's trailing-answer lift — the same question ("what may
 * a collapsed chip swallow?") must not get two answers.
 */
export function splitAssistantTurnParts(
  parts: AdaptedContentPart[]
): SplitAssistantTurnParts {
  const { body, trailing } = splitTrailingAnswerParts(parts)
  return { progress: body, answer: trailing }
}

/**
 * Manual fold overrides for turns OUTSIDE the current round, keyed by the
 * group's `parts` array and stamped with the fold epoch.
 *
 * Weak on `parts` because the thread is virtualized: scrolling a turn past the
 * overscan buffer unmounts it, and an uncontrolled Collapsible would forget the
 * expansion — so scrolling away from a turn you opened and back would re-hide
 * its work. For settled history `parts` is exactly as stable as the turn's
 * identity (it comes from the per-turn adapter cache and the merged-run cache
 * in `message-list-view`), and being weak it is collected with the turn rather
 * than accumulating per conversation.
 *
 * The epoch stamp is what makes "sending a new message folds everything above
 * it" a single number bump rather than a walk over the thread: an entry written
 * under an earlier epoch simply stops matching.
 *
 * The CURRENT round deliberately does NOT live here. Its `parts` array is
 * replaced twice on the way into history (the stream settling into a promoted
 * local turn, then the authoritative detail refetch), so anything keyed on it
 * would drop the expansion mid-read — which is exactly the "the reply folds
 * itself up the moment it finishes" behaviour this replaces. `message-list-view`
 * owns that one state positionally and passes it down controlled.
 */
const manualFold = new WeakMap<
  AdaptedContentPart[],
  { epoch: number; open: boolean }
>()

export const CompletedTurnContent = memo(function CompletedTurnContent({
  parts,
  durationMs,
  completed,
  currentRound = false,
  roundOpen = true,
  onRoundOpenChange,
  foldEpoch = 0,
  pending = false,
}: {
  parts: AdaptedContentPart[]
  durationMs?: number | null
  completed: boolean
  /** This reply is the thread's current round — the newest assistant run, from
   *  the moment the agent started replying until the next user send. Its fold
   *  state is owned by `message-list-view` (see `manualFold`). */
  currentRound?: boolean
  /** Current-round fold state. Only read when `currentRound`. */
  roundOpen?: boolean
  onRoundOpenChange?: (open: boolean) => void
  /** Bumped by `message-list-view` on every user send. */
  foldEpoch?: number
  /** Not a reply yet: what stands in the thread between a send and the
   *  agent's first word — the reply's header and turning ring, where the
   *  reply will draw them, so it takes over without a jump (see
   *  `ReplyMotion`'s handoff). */
  pending?: boolean
}) {
  const tElapsed = useTranslations("Folder.chat.liveTurnStats")
  const split = useMemo(() => splitAssistantTurnParts(parts), [parts])

  const [localOpen, setLocalOpen] = useState(() => {
    const entry = manualFold.get(parts)
    if (entry?.epoch === foldEpoch) return entry.open
    // A reply still being written is never folded by default — folding it is
    // an explicit act. Normally `currentRound` covers the live reply, but a
    // host that tracks no rounds at all (the delegation-child viewer) leans on
    // this, and it keeps the component honest on its own.
    return !completed
  })

  // Derived-state-during-render, not an effect: the fold has to be settled in
  // the same render that reads it, or sending a message would paint one frame
  // of the previous round still expanded before collapsing it.
  const [foldMark, setFoldMark] = useState({ epoch: foldEpoch, currentRound })
  if (foldMark.epoch !== foldEpoch || foldMark.currentRound !== currentRound) {
    setFoldMark({ epoch: foldEpoch, currentRound })
    if (foldMark.epoch !== foldEpoch) {
      // A new user message folds everything above it, including whatever the
      // reader had opened by hand. Everything above is settled by definition;
      // the `!completed` case is steering (a send lands mid-reply), where the
      // reply being written must stay open.
      setLocalOpen(!completed)
    } else if (foldMark.currentRound && !currentRound) {
      // A newer round took over this position without a send in between (a
      // background/loop turn). Carry the outgoing round's expansion into local
      // state so it doesn't snap shut under the reader.
      setLocalOpen(roundOpen)
    }
  }

  const open = currentRound ? roundOpen : localOpen

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (currentRound) {
        onRoundOpenChange?.(next)
        return
      }
      manualFold.set(parts, { epoch: foldEpoch, open: next })
      setLocalOpen(next)
    },
    [currentRound, foldEpoch, onRoundOpenChange, parts]
  )

  const elapsed =
    typeof durationMs === "number" && durationMs > 0
      ? formatElapsedLabel(durationMs, tElapsed)
      : null

  // Folding trades the process away to keep the answer. With no answer left
  // over there is nothing to keep, and the reply would fold to a lone header —
  // which is exactly the shape of the turns a reader most needs to see: one
  // stopped mid-tool-call (agents leave no closing prose), a Cline reply whose
  // `attempt_completion` card IS the answer, a plan-mode turn that ends on
  // ExitPlanMode with the plan inside that card. Those settle un-foldable.
  //
  // A live reply is exempt from the answer half of that rule: its closing prose
  // has not been written yet, so applying it would withhold the toggle for the
  // whole stream and hand it over one beat before the turn ends. Folding a live
  // reply is then an explicit choice; the round settling re-applies the rule.
  const foldable =
    split.progress.length > 0 && (!completed || hasVisibleAnswer(split.answer))
  // What is drawn: a reply that cannot fold shows its steps whatever `open`
  // says.
  const bodyOpen = foldable ? open : true

  // The unfold animation belongs to a real closed→open TOGGLE, never to a mount
  // that starts open. This component remounts while staying open: the
  // authoritative detail refetch renames the turn, and the virtualizer
  // recycles any row scrolled past its overscan buffer. Without this gate each
  // of those replays a 200ms unfold, so a finished reply appears to collapse
  // and re-open by itself — precisely the behaviour the round model exists to
  // prevent. Read from what is drawn, so `open` moving under a reply that
  // cannot fold (its failure link opening it) unfolds nothing.
  //
  // Only the ENTER side is gated. The exit animation must always run: it is
  // what unmounts the content (see the presence check in `instant-collapsible`).
  const [openMark, setOpenMark] = useState({
    open: bodyOpen,
    animateEnter: false,
  })
  if (openMark.open !== bodyOpen) {
    setOpenMark({ open: bodyOpen, animateEnter: bodyOpen })
  }
  const animateEnter = openMark.open === bodyOpen && openMark.animateEnter

  // Streamdown's incomplete-markdown repair (remend) may only run on text that
  // is still being written. On settled text it appends a closer after spans
  // that are ALREADY complete — a glob inside code, an identifier like `_meta`
  // — leaving a stray `*` / `_`; landing after a final code fence, that closer
  // reopens the block (#555). Every branch below renders some slice of this one
  // turn, so they all get the same answer.
  const isStreaming = !completed

  // While the agent is still at it, the prose after its last step is one more
  // step, not yet the answer: on the rail, as prose between steps is, with the
  // turning ring under it. Until the reply ends there is no telling an aside
  // ("Checking the tests next.") from its closing words; drawn as the answer,
  // the words being written sat under the ring, cut off from the steps they
  // follow, until the next call pulled them up into the steps. Once the reply
  // is done its closing prose is lifted out under the steps as the answer.
  // Folded, there is no rail to put it on: it stays under the header, as the
  // answer does.
  const proseOnRail = isStreaming && foldable && open

  const bodyId = useId()
  const turnRef = useRef<HTMLDivElement | null>(null)
  const activity = useMemo(
    () => buildActivity(parts, { isStreaming, keepAnswer: proseOnRail }),
    [parts, isStreaming, proseOnRail]
  )
  // The header's red "N failed": open the turn at the first failure nothing
  // redid — the row, and the group it is folded into.
  const failureKey = activity.summary.firstUnrecoveredKey
  const jumpToFailure = useCallback(() => {
    if (!failureKey) return
    openDisclosures(disclosureKeysFor(activity.items, failureKey))
    if (!bodyOpen) handleOpenChange(true)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const escaped = CSS.escape(failureKey)
        turnRef.current
          ?.querySelector(
            `[data-step-key="${escaped}"], [data-step-key^="${escaped}:"]`
          )
          ?.scrollIntoView({ block: "center", behavior: "smooth" })
      })
    )
  }, [activity, failureKey, bodyOpen, handleOpenChange])

  // An open fold's steps end on a foot. While its agent is at work — not
  // while it waits on the user to answer a permission request — that is the
  // turning ring, under whatever it is writing; otherwise a row that folds
  // the steps away, saying what it folds: `Collapse 14 steps · 3m 34s`. A
  // reply with nothing in it yet — no step, no words — is that list with its
  // foot alone: the turning ring hangs under the header on the rail from it,
  // where the first step will go, and the steps join above it. A live reply
  // with no foot in view (its steps folded, or words but no step it can
  // fold) ends on the turning mark under whatever does end it instead.
  const { awaitingUser } = useActivityLive()
  const working = isStreaming && !awaitingUser
  const unstarted =
    working && activity.items.length === 0 && !hasVisibleAnswer(split.answer)
  const footShown =
    bodyOpen && (unstarted || (foldable && activity.items.length > 0))
  const tActivity = useTranslations("Folder.chat.activity")
  const headerRef = useRef<HTMLDivElement | null>(null)
  const foldBack = useFoldBack()
  const steps = activity.summary.steps
  // The time, as the header gives it: once the turn is done.
  const took = completed ? elapsed : null
  const foot = useMemo(
    () => ({
      // Only while the steps are open: folding, they stay in view as they
      // slide shut, and the mark under the reply has taken over by then.
      working: working && bodyOpen,
      what:
        [steps > 0 ? tActivity("header.steps", { count: steps }) : null, took]
          .filter(Boolean)
          .join(tActivity("header.separator")) || tActivity("header.label"),
      onFold: (control: HTMLButtonElement) =>
        foldBack({
          head: headerRef.current,
          control,
          toggle:
            headerRef.current?.querySelector<HTMLElement>(
              "button[aria-expanded]"
            ) ?? null,
          fold: () => handleOpenChange(false),
        }),
    }),
    [working, bodyOpen, steps, took, tActivity, foldBack, handleOpenChange]
  )

  const header = (
    <ActivityHeader
      ref={headerRef}
      summary={activity.summary}
      completed={completed}
      hasSteps={activity.items.length > 0}
      elapsed={elapsed}
      onJumpToFailure={failureKey ? jumpToFailure : undefined}
      toggle={
        foldable
          ? {
              open,
              onToggle: () => handleOpenChange(!open),
              controls: bodyId,
            }
          : undefined
      }
    />
  )
  // Parsers leave empty placeholder turns between tool exchanges;
  // `mergeConsecutiveAssistantTurns` only swallows them mid-run, so a lone one
  // reaches here with nothing in it at all. It has no content for a header to
  // head — heading it would turn an invisible turn into a visible empty one.
  // Settled turns only: a live reply's header is the point, even before its
  // first token lands.
  const blank =
    completed && split.progress.length === 0 && !hasVisibleAnswer(split.answer)
  if (blank) {
    return (
      <ContentPartsRenderer
        parts={parts}
        role="assistant"
        isStreaming={isStreaming}
      />
    )
  }

  // One tree for every shape the reply takes, so its header and its steps
  // stay the same elements as it changes shape: the first step arriving under
  // prose that had no rail, the reply ending with nothing to fold. A reply
  // that cannot fold — all process (stopped on a tool call, or ended on a card
  // that is its answer), or no steps at all — shows its rows as an open fold
  // does, hung under the header, its answer under them; the header's failure
  // link looks for its row in here.
  const answerShown = split.answer.length > 0 && !proseOnRail
  // What moves the layout (see `ReplyMotion`): not the words of the prose
  // being written, which only lengthen it.
  const shape = [
    foldable,
    proseOnRail,
    completed,
    working,
    footShown,
    answerShown,
    activity.items.length,
    activity.summary.steps,
  ].join("|")
  return (
    <ReplyMotion
      shape={shape}
      live={isStreaming}
      open={bodyOpen}
      rootRef={turnRef}
      handoff={pending ? "give" : "take"}
    >
      <div
        ref={turnRef}
        className={foldable ? "space-y-4" : "space-y-3"}
        // The newest reply (globals.css): its blocks are laid out at once
        // rather than when scrolled near, so none of them is drawn first at a
        // placeholder height while it is written or as it settles.
        data-reply-current={isStreaming || currentRound ? "" : undefined}
      >
        <Collapsible
          className="w-full"
          open={bodyOpen}
          onOpenChange={handleOpenChange}
        >
          {header}
          {/* Folded: what can outlive the turn — a delegation or sub-agent
              still running — stays in view under the header. */}
          {!bodyOpen ? (
            <ActivityParts
              model={activity}
              isStreaming={isStreaming}
              pinnedOnly
              headed
            />
          ) : null}
          {/* `reply-fold-body` (globals.css) slides the body open and shut on
              a grid track. The div is the clipped grid item — it must stay a
              single child, and the spacing has to live INSIDE it (the headed
              list's own, under the header) or the closed track never reaches
              zero. */}
          <CollapsibleContent
            id={bodyId}
            className={cn(
              "reply-fold-body w-full outline-none",
              animateEnter && "reply-fold-enter"
            )}
          >
            <div>
              <ActivityParts
                model={activity}
                isStreaming={isStreaming}
                foot={foldable || unstarted ? foot : undefined}
                headed
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
        {answerShown ? (
          // Keyed as the prose it was on the rail (`prose:<its index in the
          // reply>`), so the closing words glide off the rail into place when
          // the reply ends.
          <div data-motion-key={`prose:${split.progress.length}`}>
            <ContentPartsRenderer
              parts={split.answer}
              role="assistant"
              isStreaming={isStreaming}
            />
          </div>
        ) : null}
        {working && !footShown ? <WorkingMark /> : null}
      </div>
    </ReplyMotion>
  )
})
