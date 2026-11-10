import { describe, expect, it } from "vitest"

import {
  COMPOSER_SIZING,
  COMPOSER_SIZING_PARTS,
  composerBoxMinHeight,
  composerEditableMinHeight,
} from "./composer-sizing"

/** `min-h-24` → 6rem. Tailwind's spacing scale is 0.25rem per step. */
function spacingUtilityToRem(utility: string): number {
  const step = Number(utility.replace("min-h-", ""))
  expect(Number.isFinite(step)).toBe(true)
  return step * 0.25
}

/** `min-h-[3.375rem]` → 3.375. */
function arbitraryUtilityToRem(utility: string): number {
  const match = /^min-h-\[([\d.]+)rem\]$/.exec(utility)
  expect(match).not.toBeNull()
  return Number(match![1])
}

describe("composer height floors (#746)", () => {
  // The whole point of stating the editable floor is that the box reaches its
  // own floor by summing its children, so no engine has to hand out free space
  // for the layout to come out right. That only holds while the two halves
  // agree — this is the check that keeps them agreeing.
  for (const size of ["compact", "tall"] as const) {
    it(`derives the ${size} editable floor from the box floor`, () => {
      const { boxRem, box, editable } = COMPOSER_SIZING[size]
      const { ACTION_ROW_REM, BOX_BORDERS_REM } = COMPOSER_SIZING_PARTS

      // The written-out box utility says the same thing as `boxRem`.
      expect(spacingUtilityToRem(box)).toBe(boxRem)
      // …and the editable area gets what the action row and the border leave.
      expect(arbitraryUtilityToRem(editable)).toBeCloseTo(
        boxRem - ACTION_ROW_REM - BOX_BORDERS_REM,
        5
      )
    })
  }

  it("picks the floors off the size", () => {
    expect(composerBoxMinHeight(false)).toBe(COMPOSER_SIZING.compact.box)
    expect(composerBoxMinHeight(true)).toBe(COMPOSER_SIZING.tall.box)
    expect(composerEditableMinHeight(false, false)).toBe(
      COMPOSER_SIZING.compact.editable
    )
    expect(composerEditableMinHeight(true, false)).toBe(
      COMPOSER_SIZING.tall.editable
    )
  })

  // A thumbnail strip already pushes the box past its floor on content alone,
  // so the editable floor stands down and the editor keeps the natural height
  // it had before — the attachment layout is untouched by any of this.
  it("stands the editable floor down under a thumbnail strip", () => {
    expect(composerEditableMinHeight(false, true)).toBe("min-h-0")
    expect(composerEditableMinHeight(true, true)).toBe("min-h-0")
  })
})
