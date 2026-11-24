"use client"

import { memo } from "react"
import type { NodeProps, Node } from "@xyflow/react"
import { Bot, Folder, GitBranch, Trash2, Unlink } from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import { formatConversationTitle } from "@/lib/conversation-title"
import type { ConversationStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { ConversationCardData } from "../canvas-model"
import { ColorWash } from "../canvas-swatches"
import { useCanvasView } from "../canvas-view-context"

export type ConversationCardFlowNode = Node<
  ConversationCardData,
  "conversationCard"
>

/**
 * One conversation on the canvas — either a derived member card inside a
 * region's grid or a standalone pinned card (a `kind=conversation` DB row).
 *
 * ⚠️ The card takes its box from the ReactFlow node wrapper (`h-full w-full`),
 * which the derive layer sizes in FLOW UNITS from CARD_WIDTH/CARD_HEIGHT, and
 * everything inside it is sized in the same units via `canvas-board-units` (see
 * globals.css). Neither half may drift into rem: the app's zoom control rewrites
 * the root font-size, so a rem box would outgrow its grid slot and overlap its
 * neighbours, and rem CONTENTS in a flow-unit box would outgrow the box — which
 * is exactly how this card ended up clipping a title through the middle of a
 * line. The numbers below (a 132-tall box holding 59.75 of chrome — border
 * included, since everything here is `border-box` — and four 17.875 title
 * lines) only hold because of that.
 *
 * The card is deliberately quiet: hover moves the border and nothing else. It
 * carries no menu and no hover bubble — right-click is the pan gesture on this
 * board, and every verb (expand, open the side panel, open in workspace, remove)
 * lives in the action dock keyed off the selection.
 */
export const ConversationCardNode = memo(function ConversationCardNode({
  data,
  selected,
}: NodeProps<ConversationCardFlowNode>) {
  const t = useTranslations("Canvas")
  const { selectedConversationIds, deleteNode } = useCanvasView()
  const conversation = data.conversation

  // Pinned card whose conversation is gone (funnel-missed): a grey shell with
  // an explicit way out. Never rendered for member cards — an unresolvable
  // member simply drops out of the grid.
  if (!conversation) {
    return (
      <div className="canvas-board-units flex h-full w-full flex-col items-start justify-between overflow-hidden rounded-xl border border-dashed border-foreground/20 bg-card/60 p-3 opacity-70">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Unlink className="size-3.5" aria-hidden="true" />
          <span className="text-xs">{t("unresolvedConversation")}</span>
        </div>
        {data.pinDbId != null && (
          <button
            type="button"
            className="nodrag inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void deleteNode(data.pinDbId!)}
          >
            <Trash2 className="size-3" aria-hidden="true" />
            {t("removeCard")}
          </button>
        )}
      </div>
    )
  }

  const status = conversation.status as ConversationStatus
  const running = status === "in_progress"
  // Mirror highlight: another instance of this conversation is selected
  // somewhere on the board (multi-region membership made visible).
  const mirrored = !selected && selectedConversationIds.has(conversation.id)
  const title = conversation.title
    ? formatConversationTitle(conversation.title)
    : t("untitled")

  return (
    <div
      className={cn(
        // `canvas-board-units` is what makes the arithmetic below a constant:
        // the chrome costs 59.75 of the box's 132 at every appearance zoom, so
        // the title's four lines always fit and never get sliced.
        //
        // Nothing here reacts to `dragging`. A card being dragged is already
        // selected — ReactFlow selects before it moves anything — so the ring
        // says so, and a card that also tilts is a sticker effect on an element
        // whose whole job is to land on an exact grid slot.
        "canvas-board-units flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card px-2.5 py-2 transition-colors",
        "border-foreground/15 hover:border-foreground/30",
        running &&
          "ring-1 ring-primary/30 motion-safe:[animation:canvas-breathe_2.6s_ease-in-out_infinite]",
        selected && "border-primary ring-2 ring-primary/25",
        mirrored && "border-primary/50 ring-2 ring-primary/15"
      )}
    >
      {/* The card's colour: its own if it is pinned, its region's if it is a
          member (see `ConversationCardData.color`). Lighter than a region's own
          wash — this sits on the card's OPAQUE surface where the region's sits
          on a translucent frame, so the same opacity would read as a slab and
          drown the title. */}
      <ColorWash color={data.color} className="rounded-xl" opacity={0.08} />
      {/* One row, one height, one line box. `h-3.5` states the height rather
          than letting the tallest child discover it — with `items-center` that
          is what actually centres four things of four different sizes (a 14px
          mark, a 6px dot, 10px text, a pill) on one line. `leading-tight` is
          inherited by every piece of text in here, so the model name and the
          badge's count share a baseline; at the board's 1.5 the 10px text would
          also outgrow the icons beside it. */}
      <div className="relative flex h-3.5 shrink-0 items-center gap-1.5 leading-tight">
        <AgentIcon
          agentType={conversation.agent_type}
          className="size-3.5 shrink-0"
        />
        <ConversationStatusDot
          status={status}
          size="sm"
          className={cn(running && "motion-safe:animate-pulse")}
        />
        {/* The model sits with the agent it belongs to — "which brain is this"
            is one fact, and splitting it across the card's two ends made the
            reader assemble it. Empty until the backend has seen a model for the
            session (`seed_model_if_empty`), so the row must read fine without
            it: the flex spacer is the same element either way, just carrying
            text when there is text. */}
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground"
          dir="ltr"
          title={conversation.model ?? undefined}
        >
          {conversation.model}
        </span>
        {conversation.child_count > 0 && (
          <span
            // No line-height or padding of its own: the count and the model
            // name are the same 10px text one gap apart, so they have to sit in
            // the same line box or their baselines disagree by the difference.
            // It used to say `leading-none py-px` to keep from setting the
            // row's height — the row states its own height now, so it can't.
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 font-mono text-[10px] font-medium text-primary"
            title={t("childCount", {
              count: conversation.child_count,
            })}
          >
            <Bot className="size-2.5" aria-hidden="true" />
            {conversation.child_count}
          </span>
        )}
      </div>
      {/* Four lines, with the same 7 above as below — this margin and the
          footer's `pt-[7px]` are one decision, not two, and 7 is what the box
          affords rather than a taste. The node wrapper is 132 and everything
          here is `border-box`, so the 1px border and the 16 of `py-2` come off
          the top: 114 to spend, of which the icon row takes 14, four 17.875
          title lines take 71.5 and the footer takes 13.75, leaving 14.75 for
          the two gaps. Splitting that evenly is the point — it used to fall
          entirely into the footer's `mt-auto`, which is 4 above the title and
          12.75 below, and made a full card look like it was sliding upwards.

          Four is also the ceiling: `line-clamp` clips to the BOX rather than to
          whole lines, so a budget half a line short doesn't truncate, it slices
          the last line lengthwise — which is what an 8 here would do, by 1.25.
          The 0.75 left over still goes to `mt-auto`, and `min-h-0` keeps the
          order of sacrifice right if a future row ever overflows: the title
          gives, the two metadata rows don't. */}
      <p className="relative mt-[7px] line-clamp-4 min-h-0 text-[13px] font-medium leading-snug">
        {title}
      </p>
      {/* Where the conversation lives: folder on the left, branch on the right.
          Both truncate and both may be absent (a folderless chat has no folder;
          a non-git folder has no branch), so neither is allowed to reserve space
          the other could use — hence `min-w-0` on each and `justify-between`
          rather than a fixed spacer. */}
      <div className="relative mt-auto flex min-w-0 shrink-0 items-center justify-between gap-1.5 pt-[7px] text-[11px] leading-tight text-muted-foreground">
        {data.folderName ? (
          <span
            className="flex min-w-0 items-center gap-0.5"
            title={data.folderName}
          >
            <Folder className="size-2.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{data.folderName}</span>
          </span>
        ) : (
          <span />
        )}
        {conversation.git_branch && (
          <span
            className="flex min-w-0 items-center gap-0.5"
            title={conversation.git_branch}
          >
            <GitBranch className="size-2.5 shrink-0" aria-hidden="true" />
            <span dir="ltr" className="truncate font-mono">
              {conversation.git_branch}
            </span>
          </span>
        )}
      </div>
    </div>
  )
})
