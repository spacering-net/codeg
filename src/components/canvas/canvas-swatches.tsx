"use client"

import {
  FOLDER_THEME_COLOR_INHERIT,
  THEME_COLORS,
  THEME_COLOR_PREVIEW,
  normalizeFolderThemeColor,
} from "@/lib/theme-presets"
import { cn } from "@/lib/utils"

/**
 * What canvas elements share about colour and grid shape: the swatch used to
 * PICK a colour, the wash that shows one, and a grid-shape cell.
 *
 * An element's colour is a background, not a badge. A region's wash covers the
 * whole frame and every card it holds (member cards are separate RF nodes, so
 * they receive the region's colour through their node data and paint their own
 * wash) — colouring a region is how a cluster is set apart at a glance, which a
 * 12px dot in a header could never do.
 */

/** Resolve a stored colour to a paintable value, or null for "no colour". */
export function canvasTint(value: string | null | undefined): string | null {
  const normalized = normalizeFolderThemeColor(value ?? null)
  return normalized === FOLDER_THEME_COLOR_INHERIT
    ? null
    : THEME_COLOR_PREVIEW[normalized]
}

/**
 * The colour itself, as a wash behind an element's content.
 *
 * Its own layer rather than a `backgroundColor` on the element: the theme
 * previews are fully saturated, and the card underneath is opaque, so the only
 * way to read a colour as a tint (instead of a slab that swallows the text) is
 * to lay it over the surface at low opacity. `pointer-events-none` keeps it out
 * of every hit test — nothing here is clickable.
 */
export function ColorWash({
  color,
  className,
  opacity = 0.12,
}: {
  color: string | null | undefined
  className?: string
  opacity?: number
}) {
  const tint = canvasTint(color)
  if (!tint) return null
  return (
    <div
      className={cn("pointer-events-none absolute inset-0", className)}
      style={{ backgroundColor: tint, opacity }}
      aria-hidden="true"
    />
  )
}

/** Accent chip: a region/note's colour, and the swatches for choosing one. */
export function ColorDot({
  value,
  active,
  className,
}: {
  value: string | null
  active?: boolean
  className?: string
}) {
  const normalized = normalizeFolderThemeColor(value)
  const preview =
    normalized === FOLDER_THEME_COLOR_INHERIT
      ? null
      : THEME_COLOR_PREVIEW[normalized]
  return (
    <span
      className={cn(
        "relative inline-flex size-3 shrink-0 items-center justify-center rounded-full border border-foreground/20",
        active && "ring-2 ring-ring ring-offset-1 ring-offset-background",
        className
      )}
      style={
        preview
          ? { backgroundColor: preview, borderColor: "transparent" }
          : undefined
      }
      aria-hidden="true"
    />
  )
}

/** The full palette grid, including "no colour" (the inherit swatch). */
export function ColorPalette({
  value,
  onSelect,
}: {
  value: string | null
  onSelect: (color: string) => void
}) {
  return (
    <div className="grid grid-cols-6 gap-1 p-1">
      {THEME_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md transition-colors hover:bg-foreground/10"
          // Re-picking the active colour clears it: the palette has no separate
          // "none" cell, and a colour you can set but not unset is a trap.
          onClick={() => onSelect(c === value ? "" : c)}
          aria-label={c}
        >
          <ColorDot value={c} active={value === c} />
        </button>
      ))}
    </div>
  )
}

/** Grid sizes offered for a region. Past six columns a region stops being a
 *  curated cluster and becomes a table — that's what the sidebar is for. */
export const GRID_CHOICES = [1, 2, 3, 4, 5, 6]

/** One cell of the grid-shape picker: a square toggle, so "3 columns" is one
 *  click rather than a nested radio list. */
export function GridChoice({
  label,
  active,
  onSelect,
}: {
  label: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-6 items-center justify-center rounded-md px-1 text-[0.6875rem] font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      )}
      onClick={onSelect}
    >
      {label}
    </button>
  )
}
