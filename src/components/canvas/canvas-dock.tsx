"use client"

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  MiniMap,
  Panel,
  useReactFlow,
  useStore,
  type Node,
} from "@xyflow/react"
import {
  ChevronsDownUp,
  ChevronsUpDown,
  CircleMinus,
  CirclePlus,
  Expand,
  ExternalLink,
  Grid2x2,
  ImageDown,
  LayoutGrid,
  Loader2,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  Palette,
  PanelRight,
  Pencil,
  Sparkles,
  Trash2,
  Unlink,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { CreateCanvasNodeInput } from "@/lib/api"
import {
  loadCanvasMinimapVisible,
  saveCanvasMinimapVisible,
} from "@/lib/canvas-view-storage"
import { cn } from "@/lib/utils"
import { AddNodeMenu } from "./add-node-menu"
import type { CanvasNode } from "@/lib/types"
import type {
  ConversationCardData,
  FileNodeData,
  NoteNodeData,
  RegionNodeData,
  TerminalNodeData,
} from "./canvas-model"
import { regionHeightForRows, regionWidthForColumns } from "./canvas-model"
import {
  ColorDot,
  ColorPalette,
  GRID_CHOICES,
  GridChoice,
} from "./canvas-swatches"
import { useCanvasView } from "./canvas-view-context"
import type { ConversationDraftData } from "./nodes/conversation-detail-node"

/**
 * The canvas's action surface: a bottom-centred dock whose left half is always
 * the same board-level tools and whose right half is whatever the current
 * selection can do — plus the viewport stack in the corner
 * (`CanvasViewportPanel`), the map and zoom controls that belong nowhere near a
 * selection.
 *
 * One surface on purpose. Element actions used to be spread across a card
 * context menu, a region header dropdown and a hover button in a note's corner
 * — three idioms, none of them discoverable, and one of them (right-click) now
 * belongs to panning. Selecting an element and reading its verbs off a fixed
 * bar is the same move a canvas app makes for a reason: the actions are always
 * in the place you last saw them.
 */

const DOCK_BUTTON_SHAPE =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors"

const DOCK_BUTTON = `${DOCK_BUTTON_SHAPE} text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40`

/** A toggle that is currently ON. Filled rather than tinted, and the same
 *  filled-primary the dock's other on/off cell uses (`GridChoice`): a hover
 *  wash would be indistinguishable from the pointer merely being here.
 *
 *  A separate class list, not extra classes appended to the one above — two
 *  `hover:bg-*` rules of the same variant have equal specificity, so which one
 *  wins is decided by their order in the generated stylesheet. */
const DOCK_BUTTON_PRESSED = `${DOCK_BUTTON_SHAPE} bg-primary text-primary-foreground disabled:pointer-events-none disabled:opacity-40`

const DOCK_BUTTON_DANGER = `${DOCK_BUTTON_SHAPE} text-muted-foreground hover:bg-destructive/10 hover:text-destructive`

function DockButton({
  label,
  onClick,
  disabled,
  danger,
  /** For the buttons that are toggles rather than verbs: fills the button while
   *  it is on. The label already says which way it will go ("Hide map"), but
   *  that only reaches someone who reads it — the state has to be visible. */
  pressed,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={
        danger
          ? DOCK_BUTTON_DANGER
          : pressed
            ? DOCK_BUTTON_PRESSED
            : DOCK_BUTTON
      }
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
    >
      {children}
    </button>
  )
}

// Matches the local idiom in `agent-selector.tsx` / `suggestion-popup.tsx`:
// measure before paint in the browser, fall back to `useEffect` on the static
// prerender where `useLayoutEffect` would warn.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

/** Long enough to read as a move, short enough not to fight a second click. */
const ZOOM_STEP_DURATION_MS = 150

/** ReactFlow's own minimap proportions (200 × 150), kept as the map is resized
 *  to the pill's width. */
const MINIMAP_ASPECT = 150 / 200
const MINIMAP_FALLBACK_WIDTH = 200

/** Float slop: `zoomTo(2)` lands on 1.9999999999999998 often enough that an
 *  exact `>= maxZoom` would leave the button live at the stop. */
const ZOOM_EPSILON = 0.001

/**
 * Everything that moves the viewport rather than the board: the navigator map
 * and, under it, the zoom pill — one stack in the bottom-right corner.
 *
 * Deliberately NOT in the dock: the dock is a selection-driven strip whose
 * contents change as you click around the board, and a zoom readout that slides
 * sideways every time you select a region is a control you have to hunt for. It
 * also collided head-on with "add to canvas" — both spelled `Plus`, one row
 * apart. Circled glyphs, a fixed corner, nothing else in it.
 *
 * The map sits with the control that shows and hides it, and both are the same
 * kind of thing — "where am I on this board" — so they share a corner rather
 * than facing each other across the window. That it is ONE flex column and not
 * two separately-positioned panels is the load-bearing part: ReactFlow's panels
 * are all absolutely positioned in the same container, and two of them in one
 * corner have to be kept apart by hand-computed offsets that go stale the
 * moment either one changes size.
 *
 * Its own component so it can subscribe to the LIVE zoom: `canvas-view` keeps
 * the zoom in a ref (deliberately — the drag path reads it every frame and must
 * not re-render), so the readout has to come from ReactFlow's store instead. The
 * selector returns a number, so zustand bails out on every pan and re-renders
 * only when the zoom actually moves.
 */
export function CanvasViewportPanel() {
  const t = useTranslations("Canvas")
  const { zoomIn, zoomOut, zoomTo } = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  const minZoom = useStore((s) => s.minZoom)
  const maxZoom = useStore((s) => s.maxZoom)
  // Device-local, like the viewport itself — see `canvas-view-storage`. Owned
  // here rather than by the view: nothing else on the board cares whether the
  // map is up.
  const [mapVisible, setMapVisible] = useState(loadCanvasMinimapVisible)

  // The map is drawn as wide as the pill under it, and that width has to be
  // MEASURED. ReactFlow sizes the minimap from `style.width`/`style.height`,
  // which it also divides by (`boundingRect.width / elementWidth`) to build the
  // svg's viewBox — so those two must be plain numbers; `"100%"` yields a NaN
  // viewBox and a blank map. The pill, meanwhile, is drawn entirely in rem, and
  // the appearance zoom works by writing a font-size onto `<html>`: any px
  // constant here would match at 100% and drift at every other step. Reading
  // the rendered box is the only thing that stays true at all of them (the zoom
  // is a root font-size, not a transform, so this is real CSS px).
  //
  // No feedback loop: the column is `items-end`, which does not stretch its
  // children, so the map's width cannot feed back into the pill's.
  const pillRef = useRef<HTMLDivElement | null>(null)
  const [pillWidth, setPillWidth] = useState(0)
  useIsomorphicLayoutEffect(() => {
    const el = pillRef.current
    if (!el) return
    const measure = () => setPillWidth(el.getBoundingClientRect().width)
    measure()
    // Catches the appearance zoom changing under us — the pill is rem, so a new
    // root font-size resizes it without anything here re-rendering.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // Only ever used where there is no layout to read (the static prerender, and
  // jsdom): the layout effect above lands the real width before the first
  // paint. `MINIMAP_ASPECT` is ReactFlow's own 200×150 — the ask is about the
  // width, and a map whose height didn't follow would flatten into a strip at
  // the larger zoom steps.
  const mapWidth = pillWidth || MINIMAP_FALLBACK_WIDTH

  return (
    <Panel position="bottom-right" data-canvas-export-skip="">
      <div className="flex flex-col items-end gap-2">
        {/* Unmounted rather than hidden: the map re-renders every node on every
            viewport change, and a map nobody is looking at should not be paying
            for that.

            The inline style is load-bearing and deliberately NOT a stylesheet
            rule. MiniMap renders its own ReactFlow `<Panel>`, which the vendor
            stylesheet makes `position: absolute; margin: 15px` — inside THIS
            panel that drops it straight onto the buttons below. An override in
            `globals.css` wins on specificity but only if it arrives, and the
            dev server has served a stale CSS chunk for this exact rule; an
            inline style is immune to which chunk turned up and to any later
            cascade layer. `width`/`height` are here for a different reason:
            MiniMap reads them to size its svg AND to build its viewBox, so they
            are the only way to give the map a size at all. */}
        {mapVisible && (
          <MiniMap
            pannable
            zoomable
            className="canvas-minimap shadow-lg"
            style={{
              position: "static",
              margin: 0,
              width: mapWidth,
              height: Math.round(mapWidth * MINIMAP_ASPECT),
            }}
          />
        )}
        <div
          ref={pillRef}
          className="flex items-center gap-0.5 rounded-full border border-border bg-background/95 p-1 shadow-lg supports-backdrop-filter:backdrop-blur-sm"
          role="toolbar"
          aria-label={t("viewportControls")}
        >
          <DockButton
            label={mapVisible ? t("hideMinimap") : t("showMinimap")}
            pressed={mapVisible}
            onClick={() => {
              const next = !mapVisible
              setMapVisible(next)
              saveCanvasMinimapVisible(next)
            }}
          >
            <MapIcon className="size-4" />
          </DockButton>
          <DockDivider />
          <DockButton
            label={t("zoomOut")}
            onClick={() => void zoomOut({ duration: ZOOM_STEP_DURATION_MS })}
            disabled={zoom <= minZoom + ZOOM_EPSILON}
          >
            <CircleMinus className="size-4" />
          </DockButton>
          {/* The readout doubles as "back to 100%" — the one zoom level a user
              asks for by name. Fixed width so 8% → 100% → 200% doesn't shove
              the neighbouring buttons sideways as the board moves. */}
          <button
            type="button"
            className="inline-flex h-8 w-12 shrink-0 items-center justify-center rounded-full font-mono text-[0.6875rem] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            onClick={() => void zoomTo(1, { duration: ZOOM_STEP_DURATION_MS })}
            aria-label={t("resetZoom")}
            title={t("resetZoom")}
          >
            {Math.round(zoom * 100)}%
          </button>
          <DockButton
            label={t("zoomIn")}
            onClick={() => void zoomIn({ duration: ZOOM_STEP_DURATION_MS })}
            disabled={zoom >= maxZoom - ZOOM_EPSILON}
          >
            <CirclePlus className="size-4" />
          </DockButton>
        </div>
      </div>
    </Panel>
  )
}

/** Separates the fixed tools from the selection's verbs. */
function DockDivider() {
  return (
    <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
  )
}

/** A dock button that opens a picker upward. */
function DockMenu({
  label,
  trigger,
  children,
}: {
  label: string
  trigger: ReactNode
  children: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={DOCK_BUTTON}
          aria-label={label}
          title={label}
        >
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RegionActions({ data }: { data: RegionNodeData }) {
  const t = useTranslations("Canvas")
  const {
    expandedRegions,
    setRegionExpanded,
    setRenamingRegionId,
    patchNode,
    deleteNode,
  } = useCanvasView()
  const { dbNode, memberTotal, visibleCount } = data
  const expanded = expandedRegions.has(dbNode.id)
  const hasHidden = memberTotal > visibleCount

  /** Pin a grid axis and resize the frame to match in ONE patch — leaving the
   *  stored geometry behind would make the region render at a width the derive
   *  layer overrides, so the next plain resize would snap it back. */
  const setGrid = (columns: number, rows: number) => {
    void patchNode(dbNode.id, {
      gridColumns: columns,
      gridRows: rows,
      ...(columns > 0 ? { width: regionWidthForColumns(columns) } : {}),
      ...(rows > 0 ? { height: regionHeightForRows(rows) } : {}),
    })
  }

  return (
    <>
      <DockButton
        label={t("rename")}
        onClick={() => setRenamingRegionId(dbNode.id)}
      >
        <Pencil className="size-4" />
      </DockButton>
      <DockButton
        label={dbNode.collapsed ? t("expand") : t("collapse")}
        onClick={() =>
          void patchNode(dbNode.id, { collapsed: !dbNode.collapsed })
        }
      >
        {dbNode.collapsed ? (
          <ChevronsUpDown className="size-4" />
        ) : (
          <ChevronsDownUp className="size-4" />
        )}
      </DockButton>
      {(hasHidden || expanded) && (
        <DockButton
          label={expanded ? t("showFewerMembers") : t("showAllMembers")}
          onClick={() => setRegionExpanded(dbNode.id, !expanded)}
        >
          {expanded ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
        </DockButton>
      )}
      <DockMenu label={t("grid")} trigger={<Grid2x2 className="size-4" />}>
        <DropdownMenuLabel className="text-[0.6875rem] font-normal text-muted-foreground">
          {t("gridColumns")}
        </DropdownMenuLabel>
        <div className="grid grid-cols-4 gap-1 p-1">
          <GridChoice
            label={t("gridAuto")}
            active={dbNode.grid_columns === 0}
            onSelect={() => setGrid(0, dbNode.grid_rows)}
          />
          {GRID_CHOICES.map((n) => (
            <GridChoice
              key={n}
              label={String(n)}
              active={dbNode.grid_columns === n}
              onSelect={() => setGrid(n, dbNode.grid_rows)}
            />
          ))}
        </div>
        <DropdownMenuLabel className="text-[0.6875rem] font-normal text-muted-foreground">
          {t("gridRows")}
        </DropdownMenuLabel>
        <div className="grid grid-cols-4 gap-1 p-1">
          <GridChoice
            label={t("gridAuto")}
            active={dbNode.grid_rows === 0}
            onSelect={() => setGrid(dbNode.grid_columns, 0)}
          />
          {GRID_CHOICES.map((n) => (
            <GridChoice
              key={n}
              label={String(n)}
              active={dbNode.grid_rows === n}
              onSelect={() => setGrid(dbNode.grid_columns, n)}
            />
          ))}
        </div>
      </DockMenu>
      <DockMenu
        label={t("color")}
        trigger={<ColorDot value={dbNode.color} className="size-4" />}
      >
        <ColorPalette
          value={dbNode.color}
          onSelect={(color) => void patchNode(dbNode.id, { color })}
        />
      </DockMenu>
      <DockButton
        label={t("removeRegion")}
        danger
        onClick={() => void deleteNode(dbNode.id)}
      >
        <Trash2 className="size-4" />
      </DockButton>
    </>
  )
}

function NoteActions({ data }: { data: NoteNodeData }) {
  const t = useTranslations("Canvas")
  const { patchNode, deleteNode } = useCanvasView()
  const { dbNode } = data
  return (
    <>
      <DockMenu label={t("color")} trigger={<Palette className="size-4" />}>
        <ColorPalette
          value={dbNode.color}
          onSelect={(color) => void patchNode(dbNode.id, { color })}
        />
      </DockMenu>
      <DockButton
        label={t("removeNote")}
        danger
        onClick={() => void deleteNode(dbNode.id)}
      >
        <Trash2 className="size-4" />
      </DockButton>
    </>
  )
}

/** File and terminal cards keep their own verbs in their title bar (reload,
 *  preview toggle, restart …) — those depend on state only the card holds. The
 *  dock carries the two every element on the board shares. */
function PlacedCardActions({
  dbNode,
  removeLabel,
}: {
  dbNode: CanvasNode
  removeLabel: string
}) {
  const t = useTranslations("Canvas")
  const { patchNode, deleteNode } = useCanvasView()
  return (
    <>
      <DockMenu label={t("color")} trigger={<Palette className="size-4" />}>
        <ColorPalette
          value={dbNode.color}
          onSelect={(color) => void patchNode(dbNode.id, { color })}
        />
      </DockMenu>
      <DockButton
        label={removeLabel}
        danger
        onClick={() => void deleteNode(dbNode.id)}
      >
        <Trash2 className="size-4" />
      </DockButton>
    </>
  )
}

function CardActions({
  data,
  detail,
}: {
  data: ConversationCardData
  detail: boolean
}) {
  const t = useTranslations("Canvas")
  const {
    setCardDetail,
    detachMember,
    removeMember,
    deleteNode,
    openConversation,
    openConversationDrawer,
    patchNode,
  } = useCanvasView()
  const conversation = data.conversation
  const { pinDbId, regionDbId } = data
  if (!conversation) {
    return pinDbId != null ? (
      <DockButton
        label={t("removeCard")}
        danger
        onClick={() => void deleteNode(pinDbId)}
      >
        <Trash2 className="size-4" />
      </DockButton>
    ) : null
  }

  return (
    <>
      {detail ? (
        <DockButton
          label={t("collapseConversation")}
          onClick={() => pinDbId != null && setCardDetail(pinDbId, false)}
        >
          <Minimize2 className="size-4" />
        </DockButton>
      ) : (
        <>
          <DockButton
            label={t("expandConversation")}
            onClick={() => {
              if (pinDbId != null) setCardDetail(pinDbId, true)
              else if (regionDbId != null) {
                void detachMember(regionDbId, conversation.id, { expand: true })
              }
            }}
          >
            <Expand className="size-4" />
          </DockButton>
          {/* The other way into the same conversation. Expanding gives it board
              space and, for a region member, takes it out of the region first;
              this one leaves the board exactly as it is. */}
          <DockButton
            label={t("openDetailPanel")}
            onClick={() => openConversationDrawer(conversation.id)}
          >
            <PanelRight className="size-4" />
          </DockButton>
        </>
      )}
      <DockButton
        label={t("openInWorkspace")}
        onClick={() => openConversation(conversation, true)}
      >
        <ExternalLink className="size-4" />
      </DockButton>
      {/* Only a pinned card: colour lives on the canvas row, and a member card
          has none of its own — it wears its region's, which is set from the
          region's own palette. Offered in both forms, since the colour follows
          the card when it expands. */}
      {pinDbId != null && (
        <DockMenu
          label={t("color")}
          trigger={<ColorDot value={data.color ?? null} className="size-4" />}
        >
          <ColorPalette
            value={data.color ?? null}
            onSelect={(color) => void patchNode(pinDbId, { color })}
          />
        </DockMenu>
      )}
      {regionDbId != null && (
        <>
          <DockButton
            label={t("detachToCanvas")}
            onClick={() => void detachMember(regionDbId, conversation.id)}
          >
            <Unlink className="size-4" />
          </DockButton>
          {data.regionOwnsMembers && (
            <DockButton
              label={t("removeFromRegion")}
              danger
              onClick={() => void removeMember(regionDbId, conversation.id)}
            >
              <Trash2 className="size-4" />
            </DockButton>
          )}
        </>
      )}
      {pinDbId != null && (
        <DockButton
          label={t("removeCard")}
          danger
          onClick={() => void deleteNode(pinDbId)}
        >
          <Trash2 className="size-4" />
        </DockButton>
      )}
    </>
  )
}

function DraftActions({ data }: { data: ConversationDraftData }) {
  const t = useTranslations("Canvas")
  const { dismissDraft, sendingDrafts, setDraftColor } = useCanvasView()
  // Nothing to discard once the first send is minting the row: `dismissDraft`
  // refuses anyway, and a button that silently does nothing is worse than no
  // button. The card's own control disappears for the same window.
  //
  // The palette goes with it, and deliberately: through that window the draft
  // is turning into a persisted card, and a colour picked mid-flight would have
  // to race the `createNode` that is already carrying the old one. It comes
  // straight back on the card itself, from its own row.
  if (sendingDrafts.has(data.draftId)) return null
  return (
    <>
      {/* Same picker the other elements get. A draft has no row yet, so this
          one writes to the local draft — see `setDraftColor`. */}
      <DockMenu
        label={t("color")}
        trigger={<ColorDot value={data.color ?? null} className="size-4" />}
      >
        <ColorPalette
          value={data.color ?? null}
          onSelect={(color) => setDraftColor(data.draftId, color)}
        />
      </DockMenu>
      <DockButton
        label={t("discardDraft")}
        danger
        onClick={() => dismissDraft(data.draftId)}
      >
        <X className="size-4" />
      </DockButton>
    </>
  )
}

interface CanvasDockProps {
  onCreate: (input: CreateCanvasNodeInput) => void
  onNewConversation: (point: { x: number; y: number }) => void
  onFitView: () => void
  onAutoArrange: () => void
  onExportPng: () => void
  exporting: boolean
  exportDisabled: boolean
  /** The RF nodes currently selected, in board order. */
  selectedNodes: Node[]
  /** Conversations in the selection — a "group these" gesture needs at least
   *  one, and the count is what the chip shows. */
  selectedConversationCount: number
  onGroupSelection: () => void
  onDeleteSelection: () => void
}

export function CanvasDock({
  onCreate,
  onNewConversation,
  onFitView,
  onAutoArrange,
  onExportPng,
  exporting,
  exportDisabled,
  selectedNodes,
  selectedConversationCount,
  onGroupSelection,
  onDeleteSelection,
}: CanvasDockProps) {
  const t = useTranslations("Canvas")
  // The board's own width (ReactFlow tracks it with a ResizeObserver), not the
  // window's: this route sits beside the workspace sidebar, so `100vw` would
  // overstate the room by the whole sidebar and let the strip run under the
  // zoom pill. Kept in the same units the pill is drawn in — the reserve below
  // is `rem`, so it grows with the app's zoom exactly as the pill does.
  const boardWidth = useStore((s) => s.width)

  const single = selectedNodes.length === 1 ? selectedNodes[0] : null
  let elementActions: ReactNode = null
  if (single) {
    switch (single.type) {
      case "region":
        elementActions = (
          <RegionActions data={single.data as unknown as RegionNodeData} />
        )
        break
      case "note":
        elementActions = (
          <NoteActions data={single.data as unknown as NoteNodeData} />
        )
        break
      case "file":
        elementActions = (
          <PlacedCardActions
            dbNode={(single.data as unknown as FileNodeData).dbNode}
            removeLabel={t("removeFileCard")}
          />
        )
        break
      case "terminal":
        elementActions = (
          <PlacedCardActions
            dbNode={(single.data as unknown as TerminalNodeData).dbNode}
            removeLabel={t("removeTerminalCard")}
          />
        )
        break
      case "conversationCard":
      case "conversationDetail":
        elementActions = (
          <CardActions
            data={single.data as unknown as ConversationCardData}
            detail={single.type === "conversationDetail"}
          />
        )
        break
      case "conversationDraft":
        elementActions = (
          <DraftActions
            data={single.data as unknown as ConversationDraftData}
          />
        )
        break
    }
  } else if (selectedNodes.length > 1) {
    elementActions = (
      <>
        <span className="px-1 font-mono text-[0.6875rem] text-muted-foreground">
          {t("selectedCount", { count: selectedNodes.length })}
        </span>
        <DockButton
          label={t("createRegionFromSelection")}
          onClick={onGroupSelection}
          disabled={selectedConversationCount === 0}
        >
          <Sparkles className="size-4" />
        </DockButton>
        <DockButton
          label={t("deleteSelected")}
          danger
          onClick={onDeleteSelection}
        >
          <Trash2 className="size-4" />
        </DockButton>
      </>
    )
  }

  return (
    <Panel position="bottom-center" data-canvas-export-skip="">
      <div
        className={cn(
          // Fully rounded and wrapping: the element half grows and shrinks with
          // the selection, and a narrow window must fold it rather than push it
          // off the edge.
          "flex flex-wrap items-center justify-center gap-0.5",
          "rounded-full border border-border bg-background/95 p-1 shadow-lg supports-backdrop-filter:backdrop-blur-sm"
        )}
        // The strip is CENTRED, so half of whatever it grows to reaches toward
        // the corner the viewport panel sits in. Folding early is the price of
        // never hiding a control under another one.
        //
        // The corner is ONE width in one unit: the map is drawn to the pill's
        // measured width, so whether it is up or not, that corner is exactly
        // the pill — `10.5rem` of rem-scaled boxes plus `3px` that isn't (the
        // divider's hairline and the pill's two borders). No overlap needs
        // `W <= X - 30px - 2C`, hence the reserve below: `2 × 10.5rem` and
        // `2 × 3px + two 15px panel margins`. Exact at every zoom step, where
        // the old two-armed `max()` was a bound that had to over-reserve at one
        // end to be safe at the other.
        //
        // Two, not three, panel margins: a bottom-centre panel gets `left: 50%`
        // — which positions its MARGIN edge — and then a `translateX(-15px)`
        // that exists to cancel exactly that margin, so this strip is truly
        // centred and its own 15px never reaches the corner. Only the corner
        // panel's margin is real here, counted once on each side.
        //
        // The floor is a threshold, not a guarantee: a centred box with a
        // minimum width always reaches a corner box eventually, and below
        // `floor + reserve` of board there is no arrangement that fits both.
        // `9rem` keeps four buttons on a row and puts that point at ~516px of
        // board — narrow enough that the window, not the fold, is the problem.
        style={{
          maxWidth: `max(9rem, calc(${boardWidth}px - 21rem - 36px))`,
        }}
        role="toolbar"
        aria-label={t("canvasActions")}
      >
        <AddNodeMenu
          onCreate={onCreate}
          onNewConversation={onNewConversation}
          triggerClassName={DOCK_BUTTON}
          side="top"
        />
        <DockButton label={t("fitView")} onClick={onFitView}>
          <Expand className="size-4" />
        </DockButton>
        <DockButton label={t("autoArrange")} onClick={onAutoArrange}>
          <LayoutGrid className="size-4" />
        </DockButton>
        <DockButton
          label={t("exportPng")}
          onClick={onExportPng}
          disabled={exporting || exportDisabled}
        >
          {exporting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ImageDown className="size-4" />
          )}
        </DockButton>
        {elementActions && (
          <>
            <DockDivider />
            {elementActions}
          </>
        )}
      </div>
    </Panel>
  )
}
