"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { getPet, getPetSettings, readPetSpritesheet } from "@/lib/pet/api"
import type { PetDetail, PetWindowConfig } from "@/lib/pet/types"
import {
  createPetSpriteObjectUrl,
  revokePetSpriteObjectUrl,
} from "@/lib/pet/sprite-url"
import { disposeTauriListener } from "@/lib/tauri-listener"
import { getTransport, isDesktop } from "@/lib/transport"
import {
  PET_FRAME_DURATIONS_MS,
  PET_ONESHOT_LOOPS,
  type PetOneShotKind,
  type PetState,
} from "@/lib/pet/animation"
import { usePetState } from "../_hooks/usePetState"
import { usePetOneShot } from "../_hooks/usePetOneShot"
import { usePetDrag } from "../_hooks/usePetDrag"
import { PetSprite } from "./PetSprite"
import { PetMenu } from "./PetMenu"
import { PetBadge } from "./PetBadge"

export interface PetWindowProps {
  petId: string
}

// Hover/click animations loop this many times before resolving back to the
// agent state. The animator naturally chains non-idle states back to col 0,
// so we just hold the state for N × single-cycle duration. The +80ms slack
// covers tick-rounding in the JS animator so we don't cut the last frame.
const INTERACTION_LOOPS = 3
const INTERACTION_SLACK_MS = 80
const JUMPING_DURATION_MS =
  sumDurations("jumping") * INTERACTION_LOOPS + INTERACTION_SLACK_MS
const WAVING_DURATION_MS =
  sumDurations("waving") * INTERACTION_LOOPS + INTERACTION_SLACK_MS
const PET_HOVER_ENTER_EVENT = "pet://hover-enter"
const PET_HOVER_LEAVE_EVENT = "pet://hover-leave"
const PET_ACTIVE_CHANGED_EVENT = "pet://active-changed"

function sumDurations(state: PetState): number {
  return PET_FRAME_DURATIONS_MS[state].reduce((acc, d) => acc + d, 0)
}

// Oneshot animations from the backend (`pet://oneshot`) reuse the same
// "hold for N loops then unstick" model as user interactions. Loop counts
// live in `PET_ONESHOT_LOOPS` so designers can tune them without touching
// component code.
function oneShotDuration(state: PetOneShotKind): number {
  return sumDurations(state) * PET_ONESHOT_LOOPS[state] + INTERACTION_SLACK_MS
}

export function PetWindow({ petId }: PetWindowProps) {
  const t = useTranslations("Pet")
  const [pet, setPet] = useState<PetDetail | null>(null)
  const [spritesheetUrl, setSpritesheetUrl] = useState<string | null>(null)
  const [scale, setScale] = useState<number>(1)
  const [error, setError] = useState<string | null>(null)
  // The URL only carries the *initial* pet id (the active one when the
  // window was opened). After that, settings can switch the active pet
  // and we want the live window to swap sprites without close/reopen, so
  // the rendered id has to be reactive state rather than the prop.
  const [activePetId, setActivePetId] = useState<string>(petId)
  // Follow a changed `petId` prop by adjusting state during render rather
  // than in an effect; the initial value already covers mount.
  const [prevPetId, setPrevPetId] = useState<string>(petId)
  if (petId !== prevPetId) {
    setPrevPetId(petId)
    setActivePetId(petId)
  }
  const agentState = usePetState()
  const oneShot = usePetOneShot()

  // Interaction-driven state takes priority over the agent-driven state so
  // a drag, hover, or click immediately wins over the ambient ACP animation.
  // The override is cleared either by the drag-idle timer (held still during
  // drag) or by the post-action timeout (after waving/jumping finishes).
  const [interactionState, setInteractionState] = useState<PetState | null>(
    null
  )
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerDownRef = useRef(false)

  const handleDragDirection = useCallback((s: PetState | null) => {
    if (interactionTimerRef.current) {
      clearTimeout(interactionTimerRef.current)
      interactionTimerRef.current = null
    }
    setInteractionState(s)
  }, [])

  const playOneShot = useCallback((state: PetState, durationMs: number) => {
    if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current)
    setInteractionState(state)
    interactionTimerRef.current = setTimeout(() => {
      setInteractionState(null)
      interactionTimerRef.current = null
    }, durationMs)
  }, [])

  const cancelInteraction = useCallback(() => {
    handleDragDirection(null)
  }, [handleDragDirection])

  // A tap (vs. drag) on the sprite is just tactile feedback — the jump. Opening
  // the session panel is reserved for the status badge (see PetBadge); tapping
  // the body of the pet must not pop the panel.
  const handleClick = useCallback(() => {
    playOneShot("jumping", JUMPING_DURATION_MS)
  }, [playOneShot])

  // Track held-mouse-button state so hover-driven waving stays out of the
  // way of any active interaction (drag, click-and-hold). Listening on
  // `window` rather than the root div catches pointerup even when it
  // happens off-window mid-drag.
  //
  // Only the primary (left) button matters here — drag is left-only, and
  // right-click is consumed by the native context menu, which eats the
  // paired `pointerup`. If we tracked all buttons we'd get stuck "down"
  // after every right-click and hover-waving would silently break until
  // the user clicked again to clear it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      pointerDownRef.current = true
    }
    const onUp = () => {
      pointerDownRef.current = false
    }
    window.addEventListener("pointerdown", onDown)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    return () => {
      window.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
  }, [])

  // Hover detection runs in Rust (`spawn_pet_hover_watcher` polls the
  // global cursor position and emits enter/leave events). Going through
  // the OS window event system from JS is unreliable when the pet isn't
  // the key window, so we listen for the backend events instead. Leaving
  // the window cancels any in-flight one-shot so the pet returns to its
  // ambient state immediately.
  useEffect(() => {
    if (!isDesktop()) return
    let unlistenEnter: (() => void) | null = null
    let unlistenLeave: (() => void) | null = null
    let cancelled = false
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event")
        const [offEnter, offLeave] = await Promise.all([
          listen(PET_HOVER_ENTER_EVENT, () => {
            if (cancelled || pointerDownRef.current) return
            playOneShot("waving", WAVING_DURATION_MS)
          }),
          listen(PET_HOVER_LEAVE_EVENT, () => {
            if (cancelled || pointerDownRef.current) return
            cancelInteraction()
          }),
        ])
        if (cancelled) {
          disposeTauriListener(offEnter, "Pet")
          disposeTauriListener(offLeave, "Pet")
        } else {
          unlistenEnter = offEnter
          unlistenLeave = offLeave
        }
      } catch (err) {
        console.warn("[Pet] hover subscription failed:", err)
      }
    })()
    return () => {
      cancelled = true
      disposeTauriListener(unlistenEnter, "Pet")
      disposeTauriListener(unlistenLeave, "Pet")
    }
  }, [playOneShot, cancelInteraction])

  // Backend-driven oneshot animations. Skipped while the user is actively
  // pressing the mouse (drag / click-and-hold) so we don't yank a sprite
  // out from under their finger; the backend event is fire-and-forget
  // anyway, missing one mid-drag is fine. Reacts to `oneShot.key` rather
  // than `oneShot.kind` so two same-kind events back-to-back replay.
  useEffect(() => {
    if (!oneShot) return
    if (pointerDownRef.current) return
    playOneShot(oneShot.kind, oneShotDuration(oneShot.kind))
  }, [oneShot, playOneShot])

  useEffect(() => {
    return () => {
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current)
    }
  }, [])

  const drag = usePetDrag({
    onDragDirection: handleDragDirection,
    onClick: handleClick,
  })

  const renderState: PetState = interactionState ?? agentState

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    // Clear the previous pet before the async load below repopulates it.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset paired with an external fetch
    setError(null)
    setPet(null)
    setSpritesheetUrl(null)

    async function load() {
      try {
        const [detail, sprite, config] = await Promise.all([
          getPet(activePetId),
          readPetSpritesheet(activePetId),
          getPetSettings(),
        ])
        objectUrl = createPetSpriteObjectUrl(sprite)
        if (cancelled) {
          revokePetSpriteObjectUrl(objectUrl)
          return
        }
        setPet(detail)
        setSpritesheetUrl(objectUrl)
        setScale(config.scale ?? 1)
      } catch (err) {
        if (!cancelled) setError(toMessage(err))
      }
    }

    void load()
    return () => {
      cancelled = true
      revokePetSpriteObjectUrl(objectUrl)
    }
  }, [activePetId])

  // Settings UI emits `pet://active-changed` when the user picks a new
  // active pet. Swap the rendered id in place; the loader effect above
  // re-runs and pulls the new sprite/config. A null id (e.g. active
  // pet deleted) is ignored — no current UI path to deactivate without
  // also closing the window.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let cancelled = false
    void (async () => {
      try {
        const off = await getTransport().subscribe<PetWindowConfig>(
          PET_ACTIVE_CHANGED_EVENT,
          (payload) => {
            if (cancelled) return
            const next = payload?.activePetId
            if (next) setActivePetId(next)
          }
        )
        if (cancelled) off()
        else unlisten = off
      } catch (err) {
        console.warn("[Pet] active-changed subscription failed:", err)
      }
    })()
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  // Keep the document title clean. macOS hides it via title_bar_style anyway,
  // but server-mode preview shows it.
  useEffect(() => {
    document.title = pet ? `${pet.displayName} - codeg pet` : "codeg pet"
  }, [pet])

  // Fully transparent body so the OS chrome is invisible. Done in JS to keep
  // the global stylesheet untouched.
  useEffect(() => {
    const prevBg = document.body.style.background
    const prevHtmlBg = document.documentElement.style.background
    document.body.style.background = "transparent"
    document.documentElement.style.background = "transparent"
    document.body.classList.add("pet-body")
    return () => {
      document.body.style.background = prevBg
      document.documentElement.style.background = prevHtmlBg
      document.body.classList.remove("pet-body")
    }
  }, [])

  const openManager = () => {
    if (!isDesktop()) return
    void (async () => {
      try {
        const { openSettingsWindow } = await import("@/lib/api")
        await openSettingsWindow("appearance")
      } catch (err) {
        console.warn("[Pet] failed to open manager:", err)
      }
    })()
  }

  if (error) {
    return (
      <div
        className="flex h-screen w-screen items-center justify-center text-xs text-destructive"
        style={{ background: "transparent" }}
        title={error}
      >
        {t("loadError")}
      </div>
    )
  }

  if (!pet || !spritesheetUrl) {
    return (
      <div
        className="flex h-screen w-screen items-center justify-center"
        style={{ background: "transparent" }}
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div
      className="relative flex h-screen w-screen select-none items-center justify-center"
      style={{ background: "transparent" }}
      onPointerDown={drag.onPointerDown}
    >
      <PetSprite
        spritesheetUrl={spritesheetUrl}
        state={renderState}
        scale={scale}
        label={pet.displayName}
      />
      <PetBadge />
      <PetMenu onScaleChange={setScale} onOpenSettings={openManager} />
    </div>
  )
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message
    if (typeof m === "string") return m
  }
  return String(err)
}
