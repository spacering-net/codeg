"use client"

import { useCallback, useRef, useState } from "react"
import { Columns2, MoveHorizontal } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ImageDiffSide } from "@/lib/image-diff"
import { cn } from "@/lib/utils"

// Same alpha checkerboard the image preview uses, so a transparent PNG reads
// the same way in both surfaces.
const CHECKERBOARD =
  "bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type CompareMode = "sideBySide" | "swipe"

interface Dimensions {
  width: number
  height: number
}

/** An addition needs both halves of the claim: one side positively empty AND
 *  the other positively there. A side we failed to read proves neither, so any
 *  pair involving one stays "modified" and lets the pane show what went wrong. */
function changeMode(
  original: ImageDiffSide,
  modified: ImageDiffSide
): "added" | "deleted" | "modified" {
  const known = (side: ImageDiffSide) =>
    side.kind === "image" || side.kind === "tooLarge"
  if (original.kind === "absent" && known(modified)) return "added"
  if (modified.kind === "absent" && known(original)) return "deleted"
  return "modified"
}

function SideCaption({
  label,
  side,
  dimensions,
}: {
  label: string
  side: ImageDiffSide
  dimensions: Dimensions | null
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
      <span className="shrink-0 font-medium text-foreground/80">{label}</span>
      {dimensions && (
        <span className="shrink-0 font-mono tabular-nums">
          {dimensions.width} x {dimensions.height}
        </span>
      )}
      {(side.kind === "image" || side.kind === "tooLarge") &&
        side.byteSize > 0 && (
          <span className="shrink-0 font-mono tabular-nums">
            {formatFileSize(side.byteSize)}
          </span>
        )}
    </div>
  )
}

/** The empty / refused states a pane can be in instead of holding an image. */
function SidePlaceholder({ side }: { side: ImageDiffSide }) {
  const t = useTranslations("Folder.diffPreview")
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-2xs text-muted-foreground">
      {side.kind === "tooLarge" ? (
        t("image.tooLarge", { size: formatFileSize(side.byteSize) })
      ) : side.kind === "unavailable" ? (
        <>
          <span>{t("image.unavailable")}</span>
          <span className="font-mono text-3xs opacity-70">{side.reason}</span>
        </>
      ) : (
        t("image.noImage")
      )}
    </div>
  )
}

function SidePane({
  label,
  side,
  alt,
  dimensions,
  onDimensions,
}: {
  label: string
  side: ImageDiffSide
  alt: string
  dimensions: Dimensions | null
  onDimensions: (size: Dimensions) => void
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-border bg-muted/30 px-2 py-1">
        <SideCaption label={label} side={side} dimensions={dimensions} />
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center p-3",
          side.kind === "image" && CHECKERBOARD
        )}
      >
        {side.kind === "image" ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={side.src}
            alt={alt}
            onLoad={(event) =>
              onDimensions({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            // Never upscaled: a 16px favicon stays a 16px favicon rather than
            // becoming a blurry wall.
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <SidePlaceholder side={side} />
        )}
      </div>
    </div>
  )
}

export interface ImageDiffViewProps {
  original: ImageDiffSide
  modified: ImageDiffSide
  originalLabel: string
  modifiedLabel: string
  loading?: boolean
  className?: string
}

/**
 * Before/after view for images, the counterpart of `DiffViewer` for files a
 * text diff has nothing to say about. Two panes by default; when both sides
 * carry pixels, a swipe mode overlays them under a draggable divider, which is
 * the only way to spot a small change between two similar-looking pictures.
 */
export function ImageDiffView({
  original,
  modified,
  originalLabel,
  modifiedLabel,
  loading = false,
  className,
}: ImageDiffViewProps) {
  const t = useTranslations("Folder.diffPreview")
  const [mode, setMode] = useState<CompareMode>("sideBySide")
  const [swipe, setSwipe] = useState(50)
  const [dragging, setDragging] = useState(false)
  const [originalDimensions, setOriginalDimensions] =
    useState<Dimensions | null>(null)
  const [modifiedDimensions, setModifiedDimensions] =
    useState<Dimensions | null>(null)
  const swipeBoxRef = useRef<HTMLDivElement>(null)

  const bothPresent = original.kind === "image" && modified.kind === "image"
  // Swipe needs two images to lay on top of each other; an added or deleted
  // file falls back to the pane layout, where the missing side says so.
  const effectiveMode: CompareMode = bothPresent ? mode : "sideBySide"

  const moveSwipeTo = useCallback((clientX: number) => {
    const box = swipeBoxRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    if (rect.width === 0) return
    const ratio = ((clientX - rect.left) / rect.width) * 100
    setSwipe(Math.min(100, Math.max(0, ratio)))
  }, [])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Capture on the box, not the handle: the pointer routinely leaves the
      // 1px divider mid-drag, and without capture the drag would end there.
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
      moveSwipeTo(event.clientX)
    },
    [moveSwipeTo]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      moveSwipeTo(event.clientX)
    },
    [dragging, moveSwipeTo]
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setDragging(false)
    },
    []
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 2
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        setSwipe((value) => Math.max(0, value - step))
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        setSwipe((value) => Math.min(100, value + step))
      } else if (event.key === "Home") {
        event.preventDefault()
        setSwipe(0)
      } else if (event.key === "End") {
        event.preventDefault()
        setSwipe(100)
      }
    },
    []
  )

  const nothingToShow =
    !loading && original.kind === "absent" && modified.kind === "absent"

  const nextMode: CompareMode =
    effectiveMode === "sideBySide" ? "swipe" : "sideBySide"
  const nextModeLabel = t(`image.${nextMode}`)
  const NextModeIcon = nextMode === "swipe" ? MoveHorizontal : Columns2

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="flex shrink-0 items-center gap-3 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium">{originalLabel}</span>
        <span className="text-muted-foreground/60">↔</span>
        <span className="font-medium">{modifiedLabel}</span>
        <span className="rounded border border-border bg-background px-1.5 py-0.5 text-3xs">
          {t(`mode.${changeMode(original, modified)}`)}
        </span>
        {loading && <span className="text-3xs">{t("image.loading")}</span>}
        {bothPresent && (
          <button
            type="button"
            onClick={() => setMode(nextMode)}
            aria-label={nextModeLabel}
            title={nextModeLabel}
            className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <NextModeIcon className="h-3 w-3" />
          </button>
        )}
      </div>

      {nothingToShow ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
          {t("noDiffData")}
        </div>
      ) : effectiveMode === "swipe" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/30 px-2 py-1">
            <SideCaption
              label={originalLabel}
              side={original}
              dimensions={originalDimensions}
            />
            <SideCaption
              label={modifiedLabel}
              side={modified}
              dimensions={modifiedDimensions}
            />
          </div>
          {/* Overlay geometry is computed from the box's left edge, so it must
              not flip with the UI direction. */}
          <div
            dir="ltr"
            ref={swipeBoxRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={cn(
              "relative min-h-0 flex-1 touch-none select-none",
              CHECKERBOARD,
              dragging ? "cursor-grabbing" : "cursor-ew-resize"
            )}
          >
            {original.kind === "image" && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={original.src}
                alt={originalLabel}
                onLoad={(event) =>
                  setOriginalDimensions({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                className="pointer-events-none absolute inset-3 object-contain"
              />
            )}
            {modified.kind === "image" && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={modified.src}
                alt={modifiedLabel}
                onLoad={(event) =>
                  setModifiedDimensions({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                style={{ clipPath: `inset(0 0 0 ${swipe}%)` }}
                className="pointer-events-none absolute inset-3 object-contain"
              />
            )}
            <div
              role="slider"
              tabIndex={0}
              aria-label={t("image.swipeHandle")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(swipe)}
              onKeyDown={handleKeyDown}
              style={{ left: `${swipe}%` }}
              className="absolute inset-y-0 -ml-2 w-4 cursor-ew-resize outline-none"
            >
              <div className="mx-auto h-full w-px bg-primary/80" />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border">
          <SidePane
            label={originalLabel}
            side={original}
            alt={originalLabel}
            dimensions={originalDimensions}
            onDimensions={setOriginalDimensions}
          />
          <SidePane
            label={modifiedLabel}
            side={modified}
            alt={modifiedLabel}
            dimensions={modifiedDimensions}
            onDimensions={setModifiedDimensions}
          />
        </div>
      )}
    </div>
  )
}
