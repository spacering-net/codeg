"use client"

import { Command, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import {
  FLOATING_BALL_INSET,
  type FloatingBallPosition,
} from "@/components/appearance-provider"
import { useFloatingBall } from "@/hooks/use-appearance"
import {
  createFloatingBallTracker,
  DEFAULT_FLOATING_BALL_BINDINGS,
  DOUBLE_TAP_MS,
  GESTURE_ONSET_MS,
  LONG_PRESS_MS,
  MOVE_PX,
  resolveTapGesture,
  type FloatingBallAction,
  type FloatingBallGesture,
} from "@/lib/floating-ball-gestures"
import { cn } from "@/lib/utils"

const BALL_SIZE = 46
const PANEL_WIDTH = 208

/** The rows the tap panel offers, in reading order. */
const PANEL_ACTIONS: readonly Exclude<FloatingBallAction, "panel">[] = [
  "newConversation",
  "toggleSidebar",
  "toggleSearch",
  "toggleTerminal",
  "nextTab",
  "prevTab",
  "reopenClosedTab",
  "openFolder",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "stopGenerating",
  "openSettings",
]

/** Gestures shown in the cheat sheet, with the action they fire. */
const CHEAT_SHEET = [
  "tap",
  "doubleTap",
  "longPress",
  "left",
  "right",
  "up",
  "upLeft",
  "upRight",
  "upThenLeft",
  "upThenRight",
  "upDown",
  "leftThenRight",
  "rightThenLeft",
  "upLeftThenDown",
  "upRightThenDown",
] as const satisfies readonly FloatingBallGesture[]

interface FloatingBallProps {
  /** Runs an action against the workspace (tab, panel, zoom, agent turn). */
  onAction: (action: FloatingBallAction) => void
}

function clampPosition(
  position: FloatingBallPosition,
  viewport: { width: number; height: number }
): FloatingBallPosition {
  const maxX = Math.max(0, viewport.width - BALL_SIZE - 4)
  const maxY = Math.max(0, viewport.height - BALL_SIZE - 4)
  return {
    x: Math.min(Math.max(4, position.x), maxX),
    y: Math.min(Math.max(4, position.y), maxY),
  }
}

/**
 * Where a freshly enabled ball lands: the right edge, a little below the
 * vertical middle.
 *
 * The bottom-right corner is not free in this workspace. The composer's send
 * button occupies the corner above the status bar, and the status bar itself
 * carries the MCP health light and the alerts badge — measured at 390×844 and
 * 1280×800, both covered by the old corner default. The right edge around 55%
 * is the one band that is empty on both phone and desktop.
 */
const DEFAULT_Y_RATIO = 0.55

function defaultPosition(viewport: {
  width: number
  height: number
}): FloatingBallPosition {
  return {
    x: viewport.width - BALL_SIZE - FLOATING_BALL_INSET,
    y: Math.round(viewport.height * DEFAULT_Y_RATIO),
  }
}

function readViewport(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 0, height: 0 }
  // `visualViewport` is what shrinks when the on-screen keyboard opens; the
  // layout viewport does not, so anchoring to it would park the ball behind
  // the keyboard.
  const vv = window.visualViewport
  return {
    width: Math.round(vv?.width ?? window.innerWidth),
    height: Math.round(vv?.height ?? window.innerHeight),
  }
}

/**
 * A draggable ball over the workspace that turns swipes into the actions the
 * keyboard shortcuts already perform — the touch counterpart of those
 * shortcuts, for the phone, where there is no keyboard.
 *
 * The gesture vocabulary comes from MindFS's blue-ring menu so the muscle
 * memory carries over; see `floating-ball-gestures.ts`. Actions are dispatched
 * by the caller, which owns the workspace contexts.
 */
export function FloatingBall({ onAction }: FloatingBallProps) {
  const t = useTranslations("FloatingBall")
  const { floatingBallEnabled, floatingBallPosition, setFloatingBallPosition } =
    useFloatingBall()

  const [viewport, setViewport] = useState(readViewport)
  // The stored position is the only source of truth: deriving the on-screen
  // position from it keeps rotation, window resizing and a reset from another
  // window consistent without copying it into local state.
  const position = floatingBallPosition
    ? clampPosition(floatingBallPosition, viewport)
    : defaultPosition(viewport)
  const [panelOpen, setPanelOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const ballRef = useRef<HTMLButtonElement | null>(null)
  const trackerRef = useRef(createFloatingBallTracker())
  const dragRef = useRef<{
    pointerId: number
    /** Where the ball sat when the press began, in viewport px. */
    origin: FloatingBallPosition
    /** Where the finger went down. */
    startX: number
    startY: number
    startedAt: number
    mode: "undecided" | "gesture" | "drag"
  } | null>(null)
  const lastTapAtRef = useRef<number | null>(null)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameRef = useRef<number | null>(null)

  // Keep the viewport current: it decides both the default corner and where an
  // off-screen ball gets clamped back to.
  useEffect(() => {
    const onResize = () => setViewport(readViewport())
    window.addEventListener("resize", onResize)
    window.visualViewport?.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      window.visualViewport?.removeEventListener("resize", onResize)
    }
  }, [])

  const clearTapTimer = useCallback(() => {
    if (tapTimerRef.current !== null) {
      clearTimeout(tapTimerRef.current)
      tapTimerRef.current = null
    }
  }, [])

  useEffect(() => clearTapTimer, [clearTapTimer])

  const fire = useCallback(
    (gesture: FloatingBallGesture) => {
      const action = DEFAULT_FLOATING_BALL_BINDINGS[gesture]
      if (!action) return
      if (action === "panel") {
        setSettingsOpen(false)
        setPanelOpen((open) => !open)
        return
      }
      if (action === "openSettings") {
        setPanelOpen(false)
        setSettingsOpen((open) => !open)
        return
      }
      setPanelOpen(false)
      setSettingsOpen(false)
      onAction(action)
    },
    [onAction]
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") return
      const now = Date.now()
      dragRef.current = {
        pointerId: event.pointerId,
        origin: position,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: now,
        mode: "undecided",
      }
      trackerRef.current.start(event.clientX, event.clientY)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [position]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      const distance = Math.hypot(dx, dy)

      if (drag.mode === "undecided" && distance > MOVE_PX) {
        // Fast movement is a gesture; a press that only starts moving after
        // the onset window is the user repositioning the ball.
        drag.mode =
          Date.now() - drag.startedAt < GESTURE_ONSET_MS ? "gesture" : "drag"
      }

      if (drag.mode === "drag") {
        event.preventDefault()
        const next = clampPosition(
          { x: drag.origin.x + dx, y: drag.origin.y + dy },
          readViewport()
        )
        // Write the frame directly: a state update per pointer sample would
        // re-render the whole overlay tree on every move.
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
        frameRef.current = requestAnimationFrame(() => {
          if (ballRef.current) {
            ballRef.current.style.left = `${next.x}px`
            ballRef.current.style.top = `${next.y}px`
          }
          frameRef.current = null
        })
        return
      }

      if (drag.mode === "gesture") {
        event.preventDefault()
        trackerRef.current.move(event.clientX, event.clientY)
      }
    },
    []
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      dragRef.current = null
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }

      if (drag.mode === "drag") {
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        setFloatingBallPosition(
          clampPosition(
            { x: drag.origin.x + dx, y: drag.origin.y + dy },
            readViewport()
          )
        )
        return
      }

      if (drag.mode === "gesture") {
        const gesture = trackerRef.current.end(event.clientX, event.clientY)
        trackerRef.current.reset()
        if (gesture) fire(gesture)
        return
      }

      // A press that never moved: tap, double tap or long press.
      const now = Date.now()
      const heldMs = now - drag.startedAt
      const sinceLastTap =
        lastTapAtRef.current === null ? null : now - lastTapAtRef.current
      const gesture = resolveTapGesture(heldMs, sinceLastTap)

      if (gesture === "longPress") {
        clearTapTimer()
        lastTapAtRef.current = null
        fire("longPress")
        return
      }
      if (gesture === "doubleTap") {
        clearTapTimer()
        lastTapAtRef.current = null
        fire("doubleTap")
        return
      }

      // A single tap is only known to be single once the double-tap window
      // has passed, so it waits — otherwise the panel would flash open before
      // a double tap could replace it.
      lastTapAtRef.current = now
      clearTapTimer()
      tapTimerRef.current = setTimeout(() => {
        tapTimerRef.current = null
        lastTapAtRef.current = null
        fire("tap")
      }, DOUBLE_TAP_MS)
    },
    [clearTapTimer, fire, setFloatingBallPosition]
  )

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      dragRef.current = null
      trackerRef.current.reset()
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    },
    []
  )

  // Dismiss either surface on an outside press or Escape.
  useEffect(() => {
    if (!panelOpen && !settingsOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (ballRef.current?.contains(target)) return
      if ((target as Element).closest?.("[data-floating-ball-surface]")) return
      setPanelOpen(false)
      setSettingsOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setPanelOpen(false)
      setSettingsOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [panelOpen, settingsOpen])

  if (!floatingBallEnabled) return null

  // The panel opens toward the middle of the screen: above the ball when it
  // sits in the lower half, below it otherwise. Its height is capped to the
  // space actually left on that side, so a long action list scrolls instead of
  // pushing the header off-screen.
  const opensUpward = position.y > viewport.height / 2
  const panelBottom = opensUpward ? viewport.height - position.y + 8 : undefined
  const panelTop = opensUpward ? undefined : position.y + BALL_SIZE + 8
  const panelMaxHeight = Math.max(
    120,
    (opensUpward
      ? position.y - 8
      : viewport.height - position.y - BALL_SIZE - 8) - 8
  )
  const panelLeft = Math.min(
    Math.max(8, position.x + BALL_SIZE - PANEL_WIDTH),
    Math.max(8, viewport.width - PANEL_WIDTH - 8)
  )

  return (
    <>
      <button
        ref={ballRef}
        type="button"
        aria-label={t("label")}
        aria-haspopup="dialog"
        aria-expanded={panelOpen || settingsOpen}
        data-floating-ball="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(event) => event.preventDefault()}
        style={{
          left: position.x,
          top: position.y,
          width: BALL_SIZE,
          height: BALL_SIZE,
          touchAction: "none",
        }}
        className={cn(
          "fixed z-40 flex items-center justify-center rounded-full",
          "border-2 border-primary-foreground/30 bg-primary text-primary-foreground",
          "shadow-lg select-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        )}
      >
        <Command className="size-5" aria-hidden />
      </button>

      {panelOpen && (
        <div
          data-floating-ball-surface="panel"
          role="dialog"
          aria-label={t("panelTitle")}
          style={{
            left: panelLeft,
            top: panelTop,
            bottom: panelBottom,
            width: PANEL_WIDTH,
            maxHeight: panelMaxHeight,
          }}
          className={cn(
            "fixed z-40 flex flex-col overflow-hidden rounded-xl",
            "border bg-popover text-popover-foreground shadow-2xl"
          )}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-semibold">{t("panelTitle")}</span>
            <button
              type="button"
              aria-label={t("close")}
              onClick={() => setPanelOpen(false)}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {PANEL_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => {
                  setPanelOpen(false)
                  onAction(action)
                }}
                className="flex w-full items-center px-3 py-2 text-start text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                {t(`actions.${action}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {settingsOpen && (
        <div
          data-floating-ball-surface="settings"
          role="dialog"
          aria-label={t("settingsTitle")}
          style={{
            left: panelLeft,
            top: panelTop,
            bottom: panelBottom,
            width: PANEL_WIDTH,
            maxHeight: panelMaxHeight,
          }}
          className={cn(
            "fixed z-40 flex flex-col overflow-hidden rounded-xl",
            "border bg-popover text-popover-foreground shadow-2xl"
          )}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-semibold">{t("settingsTitle")}</span>
            <button
              type="button"
              aria-label={t("close")}
              onClick={() => setSettingsOpen(false)}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
            <button
              type="button"
              onClick={() => {
                setFloatingBallPosition(null)
                setSettingsOpen(false)
              }}
              className="w-full rounded-md border px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {t("resetPosition")}
            </button>
            <div>
              <p className="mb-1 text-2xs font-medium text-muted-foreground">
                {t("cheatSheetTitle")}
              </p>
              <ul className="space-y-0.5">
                {CHEAT_SHEET.map((gesture) => {
                  const action = DEFAULT_FLOATING_BALL_BINDINGS[gesture]
                  if (!action) return null
                  return (
                    <li
                      key={gesture}
                      className="flex items-baseline justify-between gap-2 text-2xs"
                    >
                      <span className="text-muted-foreground">
                        {t(`gestures.${gesture}`)}
                      </span>
                      <span className="truncate text-end">
                        {action === "panel"
                          ? t("panelTitle")
                          : t(`actions.${action}`)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
            <p className="text-2xs leading-4 text-muted-foreground">
              {t("hint")}
            </p>
          </div>
        </div>
      )}
    </>
  )
}

export { LONG_PRESS_MS }
