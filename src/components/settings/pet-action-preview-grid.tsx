"use client"

import { useEffect, useState, type CSSProperties } from "react"
import { useTranslations } from "next-intl"
import {
  PET_FRAME_DURATIONS_MS,
  PET_STATE_ROW,
  backgroundPositionFor,
  filmstripFrameCount,
  spriteBackgroundSize,
  spriteRowsFromHeight,
  type PetState,
} from "@/lib/pet/animation"
import { useImageNaturalSize } from "@/lib/pet/use-image-natural-size"

export const PET_ACTION_PREVIEW_STATES = [
  "idle",
  "running_right",
  "running_left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const satisfies readonly PetState[]

export const MARKETPLACE_PREVIEW_FRAME_START = (() => {
  let start = 0
  const starts = {} as Record<PetState, number>
  for (const state of PET_ACTION_PREVIEW_STATES) {
    starts[state] = start
    start += PET_FRAME_DURATIONS_MS[state].length
  }
  return starts
})()

export const MARKETPLACE_PREVIEW_TOTAL_FRAMES =
  PET_ACTION_PREVIEW_STATES.reduce(
    (total, state) => total + PET_FRAME_DURATIONS_MS[state].length,
    0
  )

type PetActionPreviewSource =
  | {
      type: "marketplace"
      url: string
    }
  | {
      type: "spritesheet"
      url: string
    }

interface PetActionPreviewGridProps {
  petName: string
  source: PetActionPreviewSource
}

export function PetActionPreviewGrid({
  petName,
  source,
}: PetActionPreviewGridProps) {
  const t = useTranslations("Pet.marketplace")

  // Measure the asset once so every cell shares the same derived geometry.
  // Spritesheet sources need the row count; marketplace filmstrips need the
  // frame count. Both fall back to the legacy layout until the image loads.
  const size = useImageNaturalSize(source.url)
  const rows = spriteRowsFromHeight(size?.height)
  const measuredFrames = size ? filmstripFrameCount(size.width, size.height) : 0
  const totalFrames = Math.max(MARKETPLACE_PREVIEW_TOTAL_FRAMES, measuredFrames)

  return (
    <div className="grid grid-cols-3 gap-1">
      {PET_ACTION_PREVIEW_STATES.map((state) => {
        const actionName = t(`actions.${state}`)
        return (
          <PetActionPreviewCell
            key={state}
            source={source}
            state={state}
            rows={rows}
            totalFrames={totalFrames}
            label={`${petName} ${actionName}`}
            actionName={actionName}
          />
        )
      })}
    </div>
  )
}

function PetActionPreviewCell({
  source,
  state,
  rows,
  totalFrames,
  label,
  actionName,
}: {
  source: PetActionPreviewSource
  state: PetState
  rows: number
  totalFrames: number
  label: string
  actionName: string
}) {
  const col = usePetActionPreviewFrame(state)
  const frameStyle =
    source.type === "marketplace"
      ? marketplacePreviewFrameStyle(source.url, state, col, totalFrames)
      : spritesheetPreviewFrameStyle(source.url, state, col, rows)

  return (
    <div className="min-w-0 p-1">
      <div
        role="img"
        aria-label={label}
        className="rounded-sm bg-no-repeat"
        style={{
          aspectRatio: "12 / 13",
          imageRendering: "pixelated",
          ...frameStyle,
        }}
      />
      <div
        className="mt-0.5 truncate text-center text-3xs leading-tight text-muted-foreground"
        title={actionName}
      >
        {actionName}
      </div>
    </div>
  )
}

function usePetActionPreviewFrame(state: PetState): number {
  const [col, setCol] = useState(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const durations = PET_FRAME_DURATIONS_MS[state]

    const playFrame = (nextCol: number) => {
      setCol(nextCol)
      const duration = durations[nextCol] ?? durations[durations.length - 1]
      timer = setTimeout(() => {
        playFrame((nextCol + 1) % durations.length)
      }, duration)
    }

    playFrame(0)

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [state])

  return col
}

function marketplacePreviewFrameStyle(
  previewUrl: string,
  state: PetState,
  col: number,
  totalFrames: number
): CSSProperties {
  // The 9 known states always occupy the front of the filmstrip; newer states
  // (if any) are appended after. Using the *actual* frame count for the
  // denominator keeps the known frames aligned even when the strip is longer.
  const frame = MARKETPLACE_PREVIEW_FRAME_START[state] + col
  const denom = Math.max(1, totalFrames - 1)
  const x = (frame / denom) * 100
  return {
    backgroundImage: `url("${previewUrl}")`,
    backgroundSize: `${totalFrames * 100}% 100%`,
    backgroundPosition: `${x}% 0%`,
  }
}

function spritesheetPreviewFrameStyle(
  spritesheetUrl: string,
  state: PetState,
  col: number,
  rows: number
): CSSProperties {
  return {
    backgroundImage: `url("${spritesheetUrl}")`,
    backgroundSize: spriteBackgroundSize(rows),
    backgroundPosition: backgroundPositionFor(PET_STATE_ROW[state], col, rows),
  }
}
