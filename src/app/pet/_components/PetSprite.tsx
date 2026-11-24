"use client"

import { useMemo } from "react"
import {
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
  backgroundPositionFor,
  spriteBackgroundSize,
  spriteRowsFromHeight,
  type PetState,
} from "@/lib/pet/animation"
import { useImageNaturalSize } from "@/lib/pet/use-image-natural-size"
import { usePetAnimator } from "../_hooks/usePetAnimator"

export interface PetSpriteProps {
  spritesheetUrl: string
  state: PetState
  scale: number
  /** Aria-label for screen readers. */
  label: string
}

/**
 * Dedicated full-viewport sprite renderer for `PetWindow`. Sizes against the
 * pet window viewport (`100vw` / `100vh`) while locking the 192:208 cell
 * aspect ratio; reusable inline previews (settings thumbnails / action grids)
 * use `PetSheetThumbnail` / `PetActionPreviewGrid` instead.
 */
export function PetSprite({
  spritesheetUrl,
  state,
  scale,
  label,
}: PetSpriteProps) {
  const { row, col } = usePetAnimator(state)
  const backgroundImage = useMemo(
    () => `url("${spritesheetUrl}")`,
    [spritesheetUrl]
  )
  // Derive the row count from the actual sheet so v2 (11-row) pets don't render
  // squished against the legacy 9-row assumption.
  const size = useImageNaturalSize(spritesheetUrl)
  const rows = spriteRowsFromHeight(size?.height)

  return (
    <div
      role="img"
      aria-label={label}
      style={{
        // Lock the 192:208 cell ratio and fit inside the viewport so a
        // window/scale mismatch can never shrink only one axis (flex-shrink
        // on an empty div with independent width + height compresses width
        // while leaving height intact, squishing the sprite horizontally).
        width: `min(${SPRITE_FRAME_WIDTH * scale}px, 100vw, calc(100vh * ${SPRITE_FRAME_WIDTH} / ${SPRITE_FRAME_HEIGHT}))`,
        aspectRatio: `${SPRITE_FRAME_WIDTH} / ${SPRITE_FRAME_HEIGHT}`,
        flexShrink: 0,
        backgroundImage,
        backgroundRepeat: "no-repeat",
        backgroundSize: spriteBackgroundSize(rows),
        backgroundPosition: backgroundPositionFor(row, col, rows),
        imageRendering: "pixelated",
      }}
    />
  )
}
