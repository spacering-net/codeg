"use client"

import { NodeResizer } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { DRAG_HANDLE_CLASS } from "../canvas-model"
import { ColorWash } from "../canvas-swatches"

/**
 * Shared frame for every canvas card that hosts a real document rather than a
 * summary tile — live conversations, file previews, terminals: a titled window
 * with a resizer, sized entirely by the ReactFlow node wrapper.
 *
 * The title bar is the ONLY drag handle (`dragHandle` on the node points at
 * `DRAG_HANDLE_CLASS`), which buys the body the two things such a card needs
 * and a canvas node normally forbids: text you can select and inputs you can
 * click into. ReactFlow's own stylesheet sets `user-select: none` and
 * `cursor: grab` on every `.react-flow__node`, so the body has to say
 * `select-text cursor-auto` out loud — the card is a window, not a tile.
 *
 * `onActivate` fires on the first interaction anywhere in the card: a
 * conversation card restored from a previous visit renders its transcript but
 * holds no ACP connection until then. Cards with nothing to wake omit it.
 */
export function CardFrame({
  selected,
  title,
  icon,
  color,
  actions,
  minWidth = 360,
  minHeight = 320,
  onResizeEnd,
  onActivate,
  children,
}: {
  selected?: boolean
  title: React.ReactNode
  icon?: React.ReactNode
  /** The card's colour, same row and same wash as its collapsed form — a
   *  colour that vanished on expanding would read as having been lost. */
  color?: string | null
  actions: React.ReactNode
  /** Resize floor, in board units. Below its own floor a card is chrome with a
   *  sliver of content under it. */
  minWidth?: number
  minHeight?: number
  onResizeEnd?: (geometry: {
    x: number
    y: number
    width: number
    height: number
  }) => void
  onActivate?: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        // Everything inside here renders in board units too (see
        // `canvas-board-units` in globals.css): a card on this board is drawn at
        // the board's scale, and the board is zoomed with its own control. The
        // menus it opens are portalled out and stay on the app's scale, which is
        // right — those are chrome, not board content.
        "canvas-board-units flex h-full w-full cursor-auto flex-col overflow-hidden rounded-2xl border bg-card transition-colors select-text",
        selected
          ? "border-primary ring-2 ring-primary/25"
          : "border-foreground/15"
      )}
      // Primary button only. Right-drag pans the board, and a pan that starts
      // over a restored card — or sweeps the pointer across several — must not
      // be read as "the user wants these conversations connected"; that would
      // spawn the very pile of agent processes dormancy exists to avoid.
      onPointerDownCapture={(e) => {
        if (e.button === 0) onActivate?.()
      }}
    >
      {/* Behind the whole window, clipped to its radius. The two rows below say
          `relative` for this: the wash is a positioned box and would otherwise
          paint over static siblings — i.e. over the entire card body. */}
      <ColorWash color={color} className="rounded-2xl" opacity={0.08} />
      {onResizeEnd && (
        <NodeResizer
          isVisible={Boolean(selected)}
          minWidth={minWidth}
          minHeight={minHeight}
          lineClassName="!border-primary/40"
          handleClassName="!size-2 !rounded-sm !border-primary !bg-background"
          onResizeEnd={(_e, params) =>
            onResizeEnd({
              width: params.width,
              height: params.height,
              x: params.x,
              y: params.y,
            })
          }
        />
      )}
      <div
        className={cn(
          DRAG_HANDLE_CLASS,
          "relative flex h-9 shrink-0 cursor-grab items-center gap-1.5 border-b border-border/70 px-2.5 select-none active:cursor-grabbing"
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {title}
        </span>
        {actions}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}

/** A title-bar action button. `nodrag` because the bar around it IS the drag
 *  handle — without it a click on the button starts a drag instead. */
export const CARD_HEADER_BUTTON_CLASS =
  "nodrag inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
