"use client"

import { memo, type CSSProperties } from "react"
import { Map as MapIcon } from "lucide-react"
import type { CanvasBoardPreviewRect, CanvasNodeKind } from "@/lib/types"
import { canvasTint } from "./canvas-swatches"
import { isRegionKind } from "./canvas-model"

/** Breathing room around the drawn nodes, as a fraction of their extent. */
const PAD_RATIO = 0.08
/** Floor on the drawn extent, in board units: a lone note would otherwise be
 *  blown up to fill the whole card and read as a solid slab. */
const MIN_EXTENT = 1200

/** The board's dot grid, drawn the way the board itself draws it. */
const DOTS: CSSProperties = {
  backgroundImage:
    "radial-gradient(circle, color-mix(in oklab, var(--muted-foreground) 22%, transparent) 1px, transparent 1.2px)",
  backgroundSize: "14px 14px",
}

interface Frame {
  x: number
  y: number
  width: number
  height: number
}

/** The view box that shows every footprint, centred, with a margin. */
export function previewFrame(
  rects: readonly CanvasBoardPreviewRect[]
): Frame | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  const width = Math.max(maxX - minX, MIN_EXTENT)
  const height = Math.max(maxY - minY, MIN_EXTENT * 0.6)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const padX = width * PAD_RATIO
  const padY = height * PAD_RATIO
  return {
    x: cx - width / 2 - padX,
    y: cy - height / 2 - padY,
    width: width + padX * 2,
    height: height + padY * 2,
  }
}

/** How one kind of node reads at thumbnail size: regions are frames, cards and
 *  notes are solid tiles, a terminal is the one toned tile — enough contrast to
 *  tell the kinds apart, in either theme. */
function shapeStyle(
  kind: CanvasNodeKind,
  color: string | null
): { fill: string; fillOpacity: number; stroke: string; radius: number } {
  const tint = canvasTint(color)
  if (isRegionKind(kind)) {
    return {
      fill: tint ?? "var(--muted-foreground)",
      fillOpacity: tint ? 0.14 : 0.06,
      stroke: tint ?? "var(--foreground)",
      radius: 22,
    }
  }
  if (kind === "terminal") {
    // Mid-tone rather than the foreground colour: solid foreground reads as
    // "the dark tile" in a light theme but inverts into a glaring white slab
    // in a dark one. Half-strength muted ink stands apart in both.
    return {
      fill: "var(--muted-foreground)",
      fillOpacity: 0.55,
      stroke: "var(--foreground)",
      radius: 12,
    }
  }
  return {
    fill: tint ?? "var(--card)",
    fillOpacity: tint ? 0.35 : 1,
    stroke: "var(--foreground)",
    radius: 12,
  }
}

/**
 * A board's silhouette for its card on the canvas list: every node it has (up
 * to the server's cap, largest first — which is also the right paint order, so
 * cards land on top of the regions around them) drawn to fit, over the board's
 * dot grid. Strokes stay one pixel however far the board is scaled down.
 */
export const CanvasBoardPreview = memo(function CanvasBoardPreview({
  rects,
  className,
}: {
  rects: readonly CanvasBoardPreviewRect[]
  className?: string
}) {
  const frame = previewFrame(rects)
  return (
    <div className={className} style={DOTS} aria-hidden="true">
      {frame ? (
        <svg
          className="size-full"
          viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {rects.map((r, i) => {
            const shape = shapeStyle(r.kind, r.color)
            return (
              <rect
                key={i}
                x={r.x}
                y={r.y}
                width={r.width}
                height={r.height}
                rx={shape.radius}
                fill={shape.fill}
                fillOpacity={shape.fillOpacity}
                stroke={shape.stroke}
                strokeOpacity={0.22}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </svg>
      ) : (
        <div className="flex size-full items-center justify-center">
          <MapIcon className="size-7 text-muted-foreground/30" />
        </div>
      )}
    </div>
  )
})
