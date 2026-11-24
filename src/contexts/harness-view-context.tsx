"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  harnessSectionsFor,
  harnessTargetOf,
  loadHarnessSection,
  resolveHarnessSection,
  saveHarnessSection,
  type HarnessOpenRequest,
  type HarnessOpenTarget,
  type HarnessSectionId,
  type HarnessTargetFor,
} from "@/lib/harness-sections"
import {
  createHarnessSlotStore,
  type HarnessSlot,
  type HarnessSlotStore,
  type HarnessSlotUpdate,
} from "@/lib/harness-slots"

/** What a request to open the page came to — see
 *  {@link HarnessViewContextValue.open}. */
export interface HarnessOpenOutcome {
  /** The section the page shows now. Not the one asked for when this window
   *  does not offer it (Discover, with the catalog switched off). */
  section: HarnessSectionId
  /** Whether the request's target is parked for that section to open. */
  targeted: boolean
}

interface HarnessViewContextValue {
  /** False where the operator switched the catalog off (`CODEG_HARNESS=off`):
   *  the page then has no Discover section. */
  discoverEnabled: boolean
  /** The sections this window offers, in display order. */
  sections: readonly HarnessSectionId[]
  /** The section the page shows — or will, the next time it is opened. */
  section: HarnessSectionId
  /** The user switching sections: remembered across restarts, and it drops a
   *  target still parked for the section they are leaving behind. A section
   *  this window does not offer is ignored. */
  setSection: (section: HarnessSectionId) => void
  /**
   * The provider's half of `openHarness`: go to the requested section and park
   * its target there. It does not switch the workbench route — the caller does
   * (see `useOpenHarness`), which is what lets this provider sit outside the
   * route provider, next to the other always-mounted view providers.
   *
   * With no request, or one for a section this window does not offer, the
   * section stays where it was and nothing is parked.
   */
  open: (request?: HarnessOpenRequest) => HarnessOpenOutcome
  /** The target of the last `open`, until its section takes it. */
  pendingTarget: HarnessOpenTarget | null
  /** Drop a target that has been applied — only that one, so a newer request
   *  parked meanwhile survives. */
  clearPendingTarget: (target: HarnessOpenTarget) => void
  /** Installed Harness items with an update available — the sidebar badge. */
  updatesCount: number
  setUpdatesCount: (count: number) => void
  /** Per-section state that outlives the page — see `harness-slots.ts`. */
  slots: HarnessSlotStore
}

const HarnessViewContext = createContext<HarnessViewContextValue | null>(null)

/**
 * State of the Harness page that has to outlive it.
 *
 * Kept always-mounted, like `TasksViewProvider` and `AutomationsViewProvider`
 * beside it, for the same two reasons: the sidebar's badge (updates available)
 * must stay live while the page is closed, and the page itself is unmounted
 * whenever the user goes back to a conversation — so which section it was on,
 * what it was asked to open, and everything a section wants back on return
 * (the slots) are held here rather than in the page.
 *
 * Navigation stays in `WorkbenchRouteProvider`: this provider knows which
 * SECTION is current, not whether the page is on screen.
 */
export function useHarnessView() {
  const ctx = useOptionalHarnessView()
  if (!ctx) {
    throw new Error("useHarnessView must be used within HarnessViewProvider")
  }
  return ctx
}

/**
 * The Harness view, or `null` outside the workspace layout.
 *
 * Null is a supported answer, as it is for `useOptionalWorkbenchRoute`: the
 * Settings window, the pet panel and the standalone commit / merge windows
 * render components that may offer a way into Harness, and "there is no
 * workbench here" is something they have to be able to find out.
 */
export function useOptionalHarnessView(): HarnessViewContextValue | null {
  return useContext(HarnessViewContext)
}

interface HarnessViewProviderProps {
  children: ReactNode
  /**
   * Whether the SpaceRing Harness catalog is offered. On unless the operator
   * turned it off on the workspace's host (`CODEG_HARNESS=off`); the layout's
   * `HarnessViewHost` passes the backend's answer (`harness_status`).
   */
  discoverEnabled?: boolean
}

export function HarnessViewProvider({
  children,
  discoverEnabled = true,
}: HarnessViewProviderProps) {
  // Restored synchronously from localStorage. Nothing prerendered reads it —
  // the page mounts only after a client-side route switch, and the sidebar
  // takes just the updates count — so there is no SSR markup to mismatch, and
  // the page paints on the remembered section right away.
  const [remembered, setRemembered] = useState<HarnessSectionId | null>(
    loadHarnessSection
  )
  // The same value for `open`, which has to answer with the current section
  // without being rebuilt (and re-running its callers' effects) on every
  // switch. Written only where the state is.
  const rememberedRef = useRef(remembered)
  const [pendingTarget, setPendingTarget] = useState<HarnessOpenTarget | null>(
    null
  )
  const [updatesCount, setUpdatesCountState] = useState(0)
  // One store for the provider's lifetime: created lazily, never replaced.
  const [slots] = useState(createHarnessSlotStore)

  const sections = harnessSectionsFor(discoverEnabled)
  const section = resolveHarnessSection(remembered, discoverEnabled)

  const remember = useCallback((next: HarnessSectionId) => {
    rememberedRef.current = next
    setRemembered(next)
    saveHarnessSection(next)
  }, [])

  const setSection = useCallback(
    (next: HarnessSectionId) => {
      if (!harnessSectionsFor(discoverEnabled).includes(next)) return
      remember(next)
      setPendingTarget(null)
    },
    [discoverEnabled, remember]
  )

  const open = useCallback(
    (request?: HarnessOpenRequest): HarnessOpenOutcome => {
      if (
        !request ||
        !harnessSectionsFor(discoverEnabled).includes(request.section)
      ) {
        return {
          section: resolveHarnessSection(
            rememberedRef.current,
            discoverEnabled
          ),
          targeted: false,
        }
      }
      const target = harnessTargetOf(request)
      remember(request.section)
      // Also when there is none: a newer request supersedes whatever an
      // earlier one left parked.
      setPendingTarget(target)
      return { section: request.section, targeted: target !== null }
    },
    [discoverEnabled, remember]
  )

  const clearPendingTarget = useCallback((target: HarnessOpenTarget) => {
    setPendingTarget((prev) => (prev === target ? null : prev))
  }, [])

  const setUpdatesCount = useCallback((count: number) => {
    setUpdatesCountState(
      Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
    )
  }, [])

  const value = useMemo<HarnessViewContextValue>(
    () => ({
      discoverEnabled,
      sections,
      section,
      setSection,
      open,
      pendingTarget,
      clearPendingTarget,
      updatesCount,
      setUpdatesCount,
      slots,
    }),
    [
      discoverEnabled,
      sections,
      section,
      setSection,
      open,
      pendingTarget,
      clearPendingTarget,
      updatesCount,
      setUpdatesCount,
      slots,
    ]
  )

  return (
    <HarnessViewContext.Provider value={value}>
      {children}
    </HarnessViewContext.Provider>
  )
}

/**
 * A slot's value and its setter — `useState`, except that the value is held by
 * the provider and is still there when the page comes back.
 *
 * Only the components reading this slot re-render when it is written, so a
 * search box can keep its text here without the sidebar hearing every key.
 */
export function useHarnessSlot<T>(
  slot: HarnessSlot<T>
): [T, (next: HarnessSlotUpdate<T>) => void] {
  const { slots } = useHarnessView()
  const subscribe = useCallback(
    (onChange: () => void) => slots.subscribe(slot, onChange),
    [slots, slot]
  )
  const getSnapshot = useCallback(() => slots.get(slot), [slots, slot])
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const setValue = useCallback(
    (next: HarnessSlotUpdate<T>) => slots.set(slot, next),
    [slots, slot]
  )
  return [value, setValue]
}

/**
 * The target parked for `section`, or `null`. Read during render, so a section
 * can paint its first frame already on the target instead of on what it showed
 * last time and then jumping.
 */
export function useHarnessTarget<S extends HarnessSectionId>(
  section: S
): HarnessTargetFor<S> | null {
  const { pendingTarget } = useHarnessView()
  return pendingTarget?.section === section
    ? (pendingTarget as HarnessTargetFor<S>)
    : null
}

/**
 * Take the target parked for `section`: hand it to `apply` once the section
 * has rendered with it, then drop it. Returns the target for the renders in
 * between (see {@link useHarnessTarget}).
 *
 * Applied from an effect rather than during render for the reason
 * `workbench-focus.ts` gives: under StrictMode a render runs twice, and
 * consuming there would hand the second run nothing. `apply` therefore has to
 * be safe to run twice with the same target.
 *
 * Without `apply` the target is only dropped — what a section does until it
 * can honour one, so that a request it cannot serve yet opens the section
 * instead of leaving something parked to go off later.
 */
export function useConsumeHarnessTarget<S extends HarnessSectionId>(
  section: S,
  apply?: (target: HarnessTargetFor<S>) => void
): HarnessTargetFor<S> | null {
  const target = useHarnessTarget(section)
  const { clearPendingTarget } = useHarnessView()
  // Latest-ref: an inline `apply` must not re-run the effect below, which
  // would apply one target once per render.
  const applyRef = useRef(apply)
  useEffect(() => {
    applyRef.current = apply
  }, [apply])
  useEffect(() => {
    if (!target) return
    applyRef.current?.(target)
    clearPendingTarget(target)
  }, [target, clearPendingTarget])
  return target
}
