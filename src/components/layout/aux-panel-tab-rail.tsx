"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { Reorder } from "motion/react"
import type { LucideIcon } from "lucide-react"
import { Tabs as TabsPrimitive } from "radix-ui"
import {
  acquireDragSelectionGuard,
  releaseDragSelectionGuard,
} from "@/lib/drag-selection-guard"
import {
  getAuxTabOrder,
  moveAuxTab,
  sameAuxTabOrder,
  saveAuxTabOrder,
  type AuxPanelTab,
  type AuxTabOrder,
} from "@/lib/aux-panel-tab-order"
import { cn } from "@/lib/utils"

// Built on the Radix primitives rather than the shared `ui/tabs` wrappers:
// those are a horizontal segmented control (rounded track, full-height
// equal-flex triggers, `dark:` colours that outrank a `data-[state]` override),
// and an icon rail would have to undo nearly every class. The primitives keep
// what matters — the Tabs context, roving focus, and the trigger ids each
// panel's `aria-labelledby` points at.
const TRIGGER_CLASS = cn(
  "flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors",
  "hover:bg-foreground/[0.06] hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring/50",
  // `data-*` rules come after `hover:` in the generated CSS, so the selected
  // tab keeps its tint under the pointer.
  "data-[state=active]:bg-primary/10 data-[state=active]:text-primary",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0"
)

/** Alt+↑/↓ moves the focused tab — the keyboard way to do what a drag does.
 *  Radix's roving focus ignores modified arrows, so the two never collide. */
const MOVE_KEYS = "Alt+ArrowUp Alt+ArrowDown"

const WHILE_DRAG = { scale: 1.08 }

interface AuxPanelTabRailProps {
  /** The tabs to list, top to bottom. */
  tabs: AuxTabOrder
  /**
   * Off while only Session Details is shown (chat mode, no folder): the rail
   * is `hidden` then — display:none takes its lone trigger out of the tab
   * order, while the trigger stays in the DOM so the panel's
   * `aria-labelledby` still resolves to a name.
   */
  visible: boolean
  icons: Record<AuxPanelTab, LucideIcon>
  labelOf: (tab: AuxPanelTab) => string
}

/**
 * The aux panel's tab switcher: a vertical icon rail down the panel's right
 * edge, under the window-chrome strip. Drag a tab (or Alt+↑/↓ on a focused one)
 * to reorder; the order is stored per device and followed live by every other
 * window (see `aux-panel-tab-order.ts`).
 *
 * While a drag is in flight the rail shows a local draft of the order, so the
 * tabs move freely under the pointer and the preference — which other windows
 * are listening to — is written once, on release.
 */
export function AuxPanelTabRail({
  tabs,
  visible,
  icons,
  labelOf,
}: AuxPanelTabRailProps) {
  const [dragOrder, setDragOrder] = useState<AuxPanelTab[] | null>(null)
  const dragOrderRef = useRef<AuxPanelTab[] | null>(null)
  // The stored order when this drag first moved a tab.
  const dragStartRef = useRef<AuxTabOrder | null>(null)
  const shown = dragOrder ?? tabs

  const handleReorder = useCallback((next: AuxPanelTab[]) => {
    dragStartRef.current ??= getAuxTabOrder()
    dragOrderRef.current = next
    setDragOrder(next)
  }, [])

  const handleDragEnd = useCallback(() => {
    const order = dragOrderRef.current
    const start = dragStartRef.current
    dragOrderRef.current = null
    dragStartRef.current = null
    setDragOrder(null)
    // A drag that ends where it started writes nothing — otherwise it would
    // replay its starting order over a reorder made elsewhere meanwhile.
    if (!order || !start || sameAuxTabOrder(order, start)) return
    saveAuxTabOrder(order)
  }, [])

  // Moving a tab re-orders the keyed nodes, and a focused node that React
  // moves in the DOM can drop its focus — which would strand a keyboard user
  // after the first nudge. Put it back once the new order has committed.
  const triggerRefs = useRef(new Map<AuxPanelTab, HTMLButtonElement>())
  const pendingFocusRef = useRef<AuxPanelTab | null>(null)
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current
    if (!pending) return
    pendingFocusRef.current = null
    const trigger = triggerRefs.current.get(pending)
    if (trigger && document.activeElement !== trigger) trigger.focus()
  }, [shown])

  // Written from the store's current order rather than this render's copy, so
  // two quick presses in a row can't have the second undo the first.
  const move = useCallback((tab: AuxPanelTab, delta: -1 | 1) => {
    const current = getAuxTabOrder()
    const next = moveAuxTab(current, tab, delta)
    if (next === current) return
    pendingFocusRef.current = tab
    saveAuxTabOrder(next)
  }, [])

  const setTriggerRef = useCallback(
    (tab: AuxPanelTab, node: HTMLButtonElement | null) => {
      if (node) triggerRefs.current.set(tab, node)
      else triggerRefs.current.delete(tab)
    },
    []
  )

  return (
    <TabsPrimitive.List
      data-aux-tab-rail
      className={cn(
        // No background of its own, so the rail shows the same surface as the
        // panel body beside it: the column's `bg-background`, or the workspace
        // background image when one is on. The start border is what separates
        // the two; `ws-chrome-border` boosts it over a background image, where
        // the theme hairline washes out.
        // `w-12` centres the icons 1.5rem in from the window edge: right under
        // the settings button of the corner overlay above (`pr-3` + half an
        // `h-6 w-6` button, both rem, so they stay lined up at any zoom), and
        // within a pixel of the Windows/Linux close button's centre.
        "flex w-12 shrink-0 flex-col items-center border-s border-border py-1.5 ws-chrome-border",
        !visible && "hidden"
      )}
    >
      {visible ? (
        <Reorder.Group
          as="div"
          axis="y"
          values={shown as AuxPanelTab[]}
          onReorder={handleReorder}
          className="flex flex-col items-center gap-1"
        >
          {shown.map((tab) => (
            <AuxTabRailItem
              key={tab}
              tab={tab}
              label={labelOf(tab)}
              Icon={icons[tab]}
              isFirst={tab === shown[0]}
              isLast={tab === shown[shown.length - 1]}
              onMove={move}
              onDragEnd={handleDragEnd}
              setTriggerRef={setTriggerRef}
            />
          ))}
        </Reorder.Group>
      ) : (
        // No Reorder wrapper while hidden: a layout-animated item measured at
        // display:none would fly in from the corner when the rail reappears.
        shown.map((tab) => {
          const Icon = icons[tab]
          const label = labelOf(tab)
          return (
            <TabsPrimitive.Trigger
              key={tab}
              value={tab}
              title={label}
              aria-label={label}
              className={TRIGGER_CLASS}
            >
              <Icon className="size-4" />
            </TabsPrimitive.Trigger>
          )
        })
      )}
    </TabsPrimitive.List>
  )
}

interface AuxTabRailItemProps {
  tab: AuxPanelTab
  label: string
  Icon: LucideIcon
  isFirst: boolean
  isLast: boolean
  onMove: (tab: AuxPanelTab, delta: -1 | 1) => void
  onDragEnd: () => void
  setTriggerRef: (tab: AuxPanelTab, node: HTMLButtonElement | null) => void
}

function AuxTabRailItem({
  tab,
  label,
  Icon,
  isFirst,
  isLast,
  onMove,
  onDragEnd,
  setTriggerRef,
}: AuxTabRailItemProps) {
  const [dragging, setDragging] = useState(false)
  const triggerRef = useCallback(
    (node: HTMLButtonElement | null) => setTriggerRef(tab, node),
    [setTriggerRef, tab]
  )

  // A drag that sweeps across the panel body (or into the middle column)
  // would otherwise smear a text selection over everything it crosses.
  // Released on drop and on unmount, so a rail torn down mid-drag can't leave
  // the page unselectable.
  const guardHeldRef = useRef(false)
  const releaseGuard = useCallback(() => {
    if (!guardHeldRef.current) return
    guardHeldRef.current = false
    releaseDragSelectionGuard()
  }, [])
  useEffect(() => releaseGuard, [releaseGuard])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    // Swallowed at the ends too, so a clamped nudge doesn't fall through to
    // anything else listening for the chord.
    event.preventDefault()
    const delta = event.key === "ArrowUp" ? -1 : 1
    if ((delta < 0 && isFirst) || (delta > 0 && isLast)) return
    onMove(tab, delta)
  }

  return (
    <Reorder.Item
      as="div"
      value={tab}
      drag="y"
      layout="position"
      whileDrag={WHILE_DRAG}
      onDragStart={() => {
        if (!guardHeldRef.current) {
          guardHeldRef.current = true
          acquireDragSelectionGuard()
        }
        setDragging(true)
      }}
      onDragEnd={() => {
        releaseGuard()
        setDragging(false)
        onDragEnd()
      }}
      data-aux-tab={tab}
      className={cn(
        "rounded-lg",
        // Lifted while dragged: opaque, so the tabs it passes over don't show
        // through the selected tab's translucent tint.
        dragging && "cursor-grabbing bg-background shadow-md"
      )}
    >
      {/* The press that starts a drag also selects the tab (Radix activates
          on mousedown), the way a browser tab is selected by grabbing it. */}
      <TabsPrimitive.Trigger
        ref={triggerRef}
        value={tab}
        title={label}
        aria-label={label}
        aria-keyshortcuts={MOVE_KEYS}
        onKeyDown={onKeyDown}
        className={TRIGGER_CLASS}
      >
        <Icon className="size-4" />
      </TabsPrimitive.Trigger>
    </Reorder.Item>
  )
}
