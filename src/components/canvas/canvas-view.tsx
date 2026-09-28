"use client"

import "@xyflow/react/dist/style.css"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  type Node,
  type NodeChange,
  type NodeTypes,
  type Viewport,
} from "@xyflow/react"
import { Loader2, Map as MapIcon, Wand2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { toPng } from "html-to-image"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useTabActions } from "@/contexts/tab-context"
import {
  useAcpActions,
  useConnectionStore,
} from "@/contexts/acp-connections-context"
import {
  canvasCreateNode,
  canvasDeleteNode,
  canvasDeleteNodes,
  canvasDetachMember,
  canvasGroupIntoRegion,
  canvasMoveNodes,
  canvasUpdateNode,
  type CanvasNodePatchInput,
  type CreateCanvasNodeInput,
  type GroupIntoRegionInput,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  loadCanvasDrafts,
  loadCanvasExpandedCards,
  loadCanvasExpandedRegions,
  loadCanvasSurfaceKeys,
  loadCanvasViewport,
  saveCanvasDrafts,
  saveCanvasExpandedCards,
  saveCanvasExpandedRegions,
  saveCanvasSurfaceKeys,
  saveCanvasViewport,
  type CanvasDraftCard,
  type CanvasSurfaceKey,
} from "@/lib/canvas-view-storage"
import { resolveDefaultAgent } from "@/lib/resolve-default-agent"
import {
  AGENT_DISPLAY_ORDER,
  type AgentType,
  type CanvasNodeMovePayload,
  type DbConversationSummary,
} from "@/lib/types"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn, randomUUID } from "@/lib/utils"
import {
  isConversationDeleted,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  applyMovesTo,
  beginContentWrite,
  hasContentWriteInFlight,
  useCanvasStore,
} from "@/stores/canvas-store"
import { NOTE_H, NOTE_W } from "./add-node-menu"
import { CanvasConversationDrawer } from "./canvas-conversation-drawer"
import { useCanvasData } from "./canvas-data"
import { CanvasDock, CanvasViewportPanel } from "./canvas-dock"
import {
  BOARD_DOT_GAP,
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  DRAG_HANDLE_SELECTOR,
  REGION_PADDING,
  columnsForRegionWidth,
  computeAlignment,
  computeDropHint,
  computeRegionMembers,
  deriveFlowGraph,
  isRegionKind,
  noteHoldsProse,
  packLayout,
  parseMemberNodeId,
  parseRegionNodeId,
  regionHeightForRows,
  regionNodeId,
  regionWidthForColumns,
  resolveNewConversationTarget,
  rowsForRegionHeight,
  seedRegionsFromFolders,
  type AlignmentGuide,
  type CanvasDragSource,
  type CanvasDropHint,
  type CanvasRect,
  type ConversationCardData,
  type NewConversationTarget,
  type PinRect,
  type RegionRect,
} from "./canvas-model"
import {
  CanvasViewProvider,
  type CanvasViewContextValue,
} from "./canvas-view-context"
import { ConversationCardNode } from "./nodes/conversation-card-node"
import {
  ConversationDetailNode,
  ConversationDraftNode,
  type ConversationDraftData,
} from "./nodes/conversation-detail-node"
import { FileNode } from "./nodes/file-node"
import { NoteNode } from "./nodes/note-node"
import { RegionNode } from "./nodes/region-node"
import { TerminalNode } from "./nodes/terminal-node"
import { useCanvasMarqueeTextGuard } from "./use-canvas-marquee-text-guard"
import { useCanvasRightDragPan } from "./use-canvas-right-drag-pan"

// Each component takes the NARROW NodeProps of its own node type; the registry
// wants them contravariantly widened, which TS can't express — the standard RF
// escape hatch.
const NODE_TYPES = {
  region: RegionNode,
  conversationCard: ConversationCardNode,
  conversationDetail: ConversationDetailNode,
  conversationDraft: ConversationDraftNode,
  note: NoteNode,
  file: FileNode,
  terminal: TerminalNode,
} as unknown as NodeTypes

/** How long a pan/zoom must be quiet before the viewport is written to disk.
 *  Our own pan controller calls `setViewport` per frame, and each call comes
 *  back out through `onMoveEnd` — without this the board would write to
 *  localStorage on every mouse move. */
const VIEWPORT_SAVE_DELAY_MS = 500

/** How close (in SCREEN pixels) a dragged edge has to come before it snaps to a
 *  neighbour's line. Converted to flow units per frame against the live zoom. */
const ALIGN_TOLERANCE_PX = 6

const DRAFT_PREFIX = "draft-"

function draftNodeId(id: string): string {
  return `${DRAFT_PREFIX}${id}`
}

function parseDraftNodeId(rfId: string): string | null {
  return rfId.startsWith(DRAFT_PREFIX) ? rfId.slice(DRAFT_PREFIX.length) : null
}

/** ACP connection keys for the three live-conversation surfaces. Each must be
 *  stable for the surface's whole life — `useConnectionLifecycle` keys its
 *  connection on this string. */
function draftSurfaceKey(draftId: string): string {
  return `canvas-draft-${draftId}`
}

function pinSurfaceKey(pinDbId: number): string {
  return `canvas-node-${pinDbId}`
}

/** The side panel's key is per CONVERSATION, not per card: it can be opened
 *  from a pinned card or from a region member (which has no node of its own),
 *  and the same conversation must land on the same key either way. Distinct
 *  from the card's key on purpose — with both open, the second surface joins
 *  the first one's connection as a co-controlling viewer rather than starting a
 *  second agent (see the discovery gate in `acp-connections-context`). */
function drawerSurfaceKey(conversationId: number): string {
  return `canvas-drawer-${conversationId}`
}

function CanvasFlow() {
  useCanvasData()
  const t = useTranslations("Canvas")
  const { openConversations } = useWorkbenchRoute()
  const { openTab } = useTabActions()
  const { fitView, screenToFlowPosition } = useReactFlow()
  const surfaceRef = useRef<HTMLDivElement>(null)
  useCanvasRightDragPan(surfaceRef)
  useCanvasMarqueeTextGuard(surfaceRef)

  const dbNodes = useCanvasStore((s) => s.nodes)
  const hydrated = useCanvasStore((s) => s.hydrated)
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const folderGroups = useAppWorkspaceStore((s) => s.folderGroups)
  const openFolders = useAppWorkspaceStore((s) => s.folders)
  // Where a new conversation goes by default. Driven by the active TAB behind
  // this route, which is exactly what makes the canvas agree with the tab
  // strip's own new-conversation button.
  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)

  // ── View state (client-local, restored from the last visit) ──

  // Read once: the canvas remounts on every route switch, so this IS "how the
  // user left it" rather than a cache of the current session.
  const [initialViewport] = useState(() => loadCanvasViewport())
  const [expandedRegions, setExpandedRegions] = useState<ReadonlySet<number>>(
    () => new Set(loadCanvasExpandedRegions())
  )
  // Pinned cards currently rendered as a live conversation. Client-local: a
  // detail card is how THIS viewer is looking at the board, not board state.
  const [detailCards, setDetailCards] = useState<ReadonlySet<number>>(
    () => new Set(loadCanvasExpandedCards())
  )
  // Which live surfaces may hold an ACP connection. Session-only and NEVER
  // restored: an expansion remembered from last time renders its transcript but
  // must not spawn an agent process behind the user's back — opening a board
  // with six expanded cards would otherwise start six agent CLIs at once. The
  // card promotes itself the moment it is touched.
  const [liveSurfaces, setLiveSurfaces] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const { registerLiveSurfaceKeys } = useAcpActions()
  // The conversation showing in the side panel, by id. Session-only, and held
  // HERE rather than in the card that opened it: ReactFlow culls nodes outside
  // the viewport, so a panel owned by a card would close itself the first time
  // the user panned away from that card.
  const [drawerConversationId, setDrawerConversationId] = useState<
    number | null
  >(null)

  const [drafts, setDrafts] = useState<readonly CanvasDraftCard[]>(() =>
    loadCanvasDrafts()
  )
  // Drafts whose first send is in flight — see `dismissDraft`. Kept as state
  // (the dock and the card hide their discard controls off it) AND as a ref,
  // because `dismissDraft` must read the current value without re-creating
  // itself on every change.
  const [sendingDrafts, setSendingDrafts] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const sendingDraftsRef = useRef(sendingDrafts)
  const setDraftSending = useCallback((draftId: string, sending: boolean) => {
    setSendingDrafts((prev) => {
      if (prev.has(draftId) === sending) return prev
      const next = new Set(prev)
      if (sending) next.add(draftId)
      else next.delete(draftId)
      sendingDraftsRef.current = next
      return next
    })
  }, [])
  // Pin db id → the connection key its surface must keep using. Only ever
  // written when a draft materializes (see `materializeDraft`); every other
  // card uses `pinSurfaceKey`. Restored like the expansions are: recomputing it
  // after a route switch would point the card at `canvas-node-<id>` while the
  // agent its first message started is still running under the draft's key.
  const [surfaceKeys, setSurfaceKeys] = useState<
    ReadonlyMap<number, CanvasSurfaceKey>
  >(loadCanvasSurfaceKeys)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [renamingRegionId, setRenamingRegionId] = useState<number | null>(null)
  // The delete waiting on the user's answer, or null for "not asking".
  // `notes` is how many written notes it would take and `terminals` how many
  // live shells it would end, so the dialog can say what is at stake. `run` is
  // the delete itself, CAPTURED when the question was asked — the alternative,
  // re-reading the live selection on confirm, lets the prompt describe one set
  // of nodes and the confirm delete another.
  const [pendingDelete, setPendingDelete] = useState<{
    notes: number
    terminals: number
    run: () => Promise<void>
  } | null>(null)
  // Transient drag positions (RF node id → parent-relative position). State,
  // not a ref: the derive layer must re-run as the pointer moves.
  const [overlay, setOverlay] = useState<
    ReadonlyMap<string, { x: number; y: number }>
  >(() => new Map())
  // Transient resize dimensions (NodeResizer feed); cleared by endNodeResize.
  const [sizeOverlay, setSizeOverlay] = useState<
    ReadonlyMap<string, { width: number; height: number }>
  >(() => new Map())
  // Member-list freeze for the region whose member is mid-drag (ref: read only
  // inside the derive memo via state bump below).
  const [frozenMembers, setFrozenMembers] = useState<ReadonlyMap<
    number,
    number[]
  > | null>(null)
  /** The conversation card being dragged right now, if any — what turns drag
   *  positions into a live drop preview. */
  const [dragSource, setDragSource] = useState<{
    token: number
    rfId: string
    source: CanvasDragSource
  } | null>(null)
  // Monotonic gesture id. A drop's command is awaited, and the user can grab
  // the next card long before it settles — the finishing gesture must only tear
  // down its OWN state, or the second drag loses the drop it was aiming for and
  // the card silently just moves instead.
  const dragTokenRef = useRef(0)
  /** RF node ids the CURRENT gesture is moving — what a superseded gesture's
   *  cleanup must leave alone. */
  const draggedNodeIdsRef = useRef<ReadonlySet<string>>(new Set())

  // ── Drag alignment ──

  /** Boxes the current gesture can align to, snapshotted at drag start. */
  const alignCandidatesRef = useRef<CanvasRect[]>([])
  /** The grabbed node, whose snap the whole selection follows. Null when the
   *  gesture can't align (a member card inside a grid). */
  const alignPrimaryRef = useRef<{
    id: string
    width: number
    height: number
  } | null>(null)
  /** Alt suspends snapping — the standard escape hatch for placing something
   *  one pixel off a line on purpose. */
  const altHeldRef = useRef(false)
  /** The correction the most recent drag frame actually painted — the value the
   *  drop must reuse so release changes nothing on screen. */
  const lastSnapRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 })
  const [alignGuides, setAlignGuides] = useState<readonly AlignmentGuide[]>([])
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      altHeldRef.current = e.altKey
    }
    // Losing the window mid-drag leaves the key state unknowable; assume
    // released, which is the recoverable direction (snapping simply resumes).
    const clear = () => {
      altHeldRef.current = false
    }
    window.addEventListener("keydown", sync)
    window.addEventListener("keyup", sync)
    window.addEventListener("blur", clear)
    return () => {
      window.removeEventListener("keydown", sync)
      window.removeEventListener("keyup", sync)
      window.removeEventListener("blur", clear)
    }
  }, [])
  const [exporting, setExporting] = useState(false)
  const [seeding, setSeeding] = useState(false)

  const setDetailCardsPersisted = useCallback(
    (update: (prev: ReadonlySet<number>) => ReadonlySet<number>) => {
      setDetailCards((prev) => {
        const next = update(prev)
        if (next !== prev) saveCanvasExpandedCards([...next])
        return next
      })
    },
    []
  )

  const setDraftsPersisted = useCallback(
    (
      update: (prev: readonly CanvasDraftCard[]) => readonly CanvasDraftCard[]
    ) => {
      setDrafts((prev) => {
        const next = update(prev)
        if (next !== prev) saveCanvasDrafts(next)
        return next
      })
    },
    []
  )

  // Drop ids whose nodes are gone — deleted here, deleted from another window,
  // or belonging to a different backend entirely. Runs on every change to the
  // board rather than once at hydration: a node deleted later in the session
  // would otherwise keep its id in storage, and this storage is not
  // backend-scoped, so two databases behind one origin hand out the same low
  // ids to entirely different nodes — a stale "expanded" id can then reopen a
  // card the user never expanded. (Within ONE database that cannot happen:
  // `canvas_node.id` is AUTOINCREMENT, so a deleted id is never handed out
  // again. An earlier version of this comment said otherwise.)
  // Safe to run continuously because `hydrated` only goes true once the node
  // set has actually loaded, and `reset()` clears it again — the empty map
  // during a refetch is never mistaken for an empty board.
  useEffect(() => {
    if (!hydrated) return
    setDetailCardsPersisted((prev) => {
      const next = new Set([...prev].filter((id) => dbNodes.has(id)))
      return next.size === prev.size ? prev : next
    })
    setExpandedRegions((prev) => {
      const next = new Set([...prev].filter((id) => dbNodes.has(id)))
      if (next.size === prev.size) return prev
      saveCanvasExpandedRegions([...next])
      return next
    })
    // Connection keys are checked against the card they were written for, not
    // just its id — same cross-database reason as above, except a mismatch here
    // would hand a card a stranger's ACP connection key rather than merely open
    // it. `created_at` is the half that survives an id sequence. Runs before any
    // card can mount: `hydrated` is what puts nodes on the board at all.
    setSurfaceKeys((prev) => {
      const next = new Map(
        [...prev].filter(([id, entry]) => {
          const node = dbNodes.get(id)
          return (
            node?.conversation_id === entry.conversationId &&
            node.created_at === entry.createdAt
          )
        })
      )
      if (next.size === prev.size) return prev
      saveCanvasSurfaceKeys(next)
      return next
    })
  }, [hydrated, dbNodes, setDetailCardsPersisted])

  /** Terminal cards on the board, by row id. */
  const terminalNodeIds = useMemo(() => {
    const out: number[] = []
    for (const node of dbNodes.values()) {
      if (node.kind === "terminal") out.push(node.id)
    }
    return out
  }, [dbNodes])

  const derived = useMemo(
    () =>
      deriveFlowGraph({
        dbNodes: dbNodes.values(),
        conversations,
        allFolders,
        folderGroups,
        expandedRegions,
        overlay,
        frozenMembers,
        sizeOverlay,
        detailCards,
      }),
    [
      dbNodes,
      conversations,
      allFolders,
      folderGroups,
      expandedRegions,
      overlay,
      frozenMembers,
      sizeOverlay,
      detailCards,
    ]
  )

  // Mirrors read from inside the drag hot path, which must not re-create its
  // callbacks every time the board changes.
  const derivedRef = useRef(derived)
  derivedRef.current = derived
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const dbNodesRef = useRef(dbNodes)
  dbNodesRef.current = dbNodes
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay
  const zoomRef = useRef(initialViewport?.zoom ?? 1)

  const rfNodes = useMemo(() => {
    const persisted = derived.nodes.map((n) => ({
      ...n,
      selected: selectedIds.has(n.id),
    }))
    // Drafts render on top of everything persisted — they're the thing the user
    // just asked for and are about to type into.
    const draftNodes = drafts.map((draft) => {
      const rfId = draftNodeId(draft.id)
      const pos = overlay.get(rfId)
      const size = sizeOverlay.get(rfId)
      return {
        id: rfId,
        type: "conversationDraft",
        position: pos ?? { x: draft.x, y: draft.y },
        width: size?.width ?? draft.width,
        height: size?.height ?? draft.height,
        selected: selectedIds.has(rfId),
        // Same title-bar-only handle the expanded card uses, and for a reason
        // that is invisible until someone types into the card: a node with NO
        // `dragHandle` passes d3-drag's filter on every mousedown anywhere in
        // it, and d3 answers by installing a capture-phase `selectstart`
        // preventDefault on the window for the life of the gesture. The browser
        // asks permission to move a caret through that same event, so a click
        // inside the composer focused the textarea but could not put the cursor
        // where it was clicked, and no text in the card could be selected. The
        // handle is what keeps the filter from matching in the body at all.
        dragHandle: DRAG_HANDLE_SELECTOR,
        data: {
          draftId: draft.id,
          target: draft.target,
          agentType: draft.agentType,
          color: draft.color ?? null,
        } satisfies ConversationDraftData,
      }
    })
    return [...persisted, ...draftNodes] as Node[]
  }, [derived.nodes, selectedIds, drafts, overlay, sizeOverlay])

  const selectedNodes = useMemo(
    () => rfNodes.filter((n) => selectedIds.has(n.id)),
    [rfNodes, selectedIds]
  )

  const selectedConversationIds = useMemo(() => {
    const out = new Set<number>()
    for (const n of derived.nodes) {
      if (
        (n.type === "conversationCard" || n.type === "conversationDetail") &&
        selectedIds.has(n.id)
      ) {
        const data = n.data as ConversationCardData
        if (data.conversation) out.add(data.conversation.id)
      }
    }
    return out
  }, [derived.nodes, selectedIds])

  // ── Commands (every mutation: fire → optimistic applyResponse → toast on
  // error; the event stream is what advances the revision) ──

  const patchNode = useCallback(
    async (nodeId: number, patch: CanvasNodePatchInput) => {
      // Text in flight is tracked so the delete confirmations can see it — the
      // cached row still reads EMPTY until this resolves. See
      // `beginContentWrite` for why that matters and why it lives in the store.
      const endWrite =
        patch.content !== undefined ? beginContentWrite(nodeId) : null
      try {
        const res = await canvasUpdateNode(nodeId, patch)
        useCanvasStore
          .getState()
          .applyResponse(res.revision, (nodes) =>
            nodes.set(res.value.id, res.value)
          )
      } catch (e) {
        toast.error(toErrorMessage(e))
      } finally {
        endWrite?.()
      }
    },
    []
  )

  /**
   * How many of these nodes would take prose with them — the one question both
   * delete paths ask, against the store rather than the rendered nodes so a
   * caller holding only an id asks it the same way.
   *
   * Counts a note whose text is STILL IN FLIGHT as at risk even though the
   * cached row looks empty. Deliberately conservative: a patch that CLEARS a
   * note is in flight too, and asking about a note the user just emptied costs
   * one dialog, while the other error costs the paragraph they just typed.
   */
  const notesAtRisk = useCallback((ids: readonly number[]) => {
    const rows = useCanvasStore.getState().nodes
    return ids.filter(
      (id) => noteHoldsProse(rows.get(id)) || hasContentWriteInFlight(id)
    ).length
  }, [])

  /**
   * How many of these nodes are terminals — i.e. how many running processes
   * the delete would end.
   *
   * The board's rule is "ask only when the delete destroys something that
   * lives nowhere else", and a shell qualifies for the same reason a written
   * note does: the command halfway through a migration exists only there.
   * Liveness is deliberately not probed — a card whose process already exited
   * answers "yes" and costs one dialog, while asking the backend would make a
   * confirmation prompt depend on a round trip.
   */
  const terminalsAtRisk = useCallback((ids: readonly number[]) => {
    const rows = useCanvasStore.getState().nodes
    return ids.filter((id) => rows.get(id)?.kind === "terminal").length
  }, [])

  const forgetNodes = useCallback(
    (ids: readonly number[]) => {
      if (ids.length === 0) return
      const gone = new Set(ids)
      setDetailCardsPersisted((prev) => {
        const next = new Set([...prev].filter((id) => !gone.has(id)))
        return next.size === prev.size ? prev : next
      })
    },
    [setDetailCardsPersisted]
  )

  const commitDeleteNode = useCallback(
    async (nodeId: number) => {
      try {
        const res = await canvasDeleteNode(nodeId)
        useCanvasStore
          .getState()
          .applyResponse(res.revision, (nodes) => nodes.delete(nodeId))
        forgetNodes([nodeId])
      } catch (e) {
        toast.error(toErrorMessage(e))
      }
    },
    [forgetNodes]
  )

  /**
   * Single-node delete, and the SECOND door into destroying a note: the dock
   * renders a trash button for whatever one node is selected, so a written note
   * can be deleted here without the selection gesture ever running. The guard
   * therefore sits on this chokepoint rather than on its callers — the dock's
   * note button, its region button and the card's unpin all come through here,
   * and only the note among them can take prose with it.
   */
  const deleteNode = useCallback(
    async (nodeId: number) => {
      const notes = notesAtRisk([nodeId])
      const terminals = terminalsAtRisk([nodeId])
      if (notes > 0 || terminals > 0) {
        setPendingDelete({
          notes,
          terminals,
          run: () => commitDeleteNode(nodeId),
        })
        return
      }
      await commitDeleteNode(nodeId)
    },
    [commitDeleteNode, notesAtRisk, terminalsAtRisk]
  )

  const createNode = useCallback(async (input: CreateCanvasNodeInput) => {
    try {
      const res = await canvasCreateNode(input)
      useCanvasStore
        .getState()
        .applyResponse(res.revision, (nodes) =>
          nodes.set(res.value.id, res.value)
        )
      return res.value
    } catch (e) {
      toast.error(toErrorMessage(e))
      return null
    }
  }, [])

  /** Keep a passage from a card's transcript as a note beside it. Parked just
   *  off the card's right edge — the same "next to where it came from" rule
   *  `detachMember` uses, so a new element never lands under the one it was
   *  made from. */
  const saveSelectionAsNote = useCallback(
    async (pinDbId: number, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const source = dbNodesRef.current.get(pinDbId)
      // The card is gone (deleted here or elsewhere while the bubble was up).
      // "Beside it" has no answer then, and dropping the note at the origin
      // would strand it somewhere the user never looked.
      if (!source) return
      const size = derivedRef.current.renderedSizes.get(pinDbId)
      // Mid-drag the card is at its overlay position, not its stored one —
      // place the note next to where it actually IS.
      const live = overlayRef.current.get(regionNodeId(pinDbId))
      const created = await createNode({
        kind: "note",
        content: trimmed,
        x: (live?.x ?? source.x) + (size?.width ?? source.width) + 32,
        y: live?.y ?? source.y,
        width: NOTE_W,
        height: NOTE_H,
      })
      if (created) setSelectedIds(new Set([regionNodeId(created.id)]))
    },
    // Refs throughout: `MessageListView` requires this callback to keep one
    // identity for the card's lifetime, and the board changes constantly.
    [createNode]
  )

  const moveNodes = useCallback(async (moves: CanvasNodeMovePayload[]) => {
    if (moves.length === 0) return
    try {
      const res = await canvasMoveNodes(moves)
      // res.value is what the backend actually wrote (clamped, ghosts
      // dropped) — mirroring the broadcast payload exactly.
      useCanvasStore
        .getState()
        .applyResponse(res.revision, (nodes) => applyMovesTo(nodes, res.value))
    } catch (e) {
      toast.error(toErrorMessage(e))
    }
  }, [])

  const openConversation = useCallback(
    (conversation: DbConversationSummary, pin: boolean) => {
      // Full-page route overlays the workspace: switch back FIRST or the tab
      // opens invisibly underneath the canvas.
      openConversations()
      openTab(
        conversation.folder_id,
        conversation.id,
        conversation.agent_type,
        pin,
        conversation.title ?? undefined
      )
    },
    [openConversations, openTab]
  )

  const setRegionExpanded = useCallback(
    (regionDbId: number, expanded: boolean) => {
      setExpandedRegions((prev) => {
        if (prev.has(regionDbId) === expanded) return prev
        const next = new Set(prev)
        if (expanded) next.add(regionDbId)
        else next.delete(regionDbId)
        saveCanvasExpandedRegions([...next])
        return next
      })
    },
    []
  )

  const activateSurface = useCallback((contextKey: string) => {
    setLiveSurfaces((prev) =>
      prev.has(contextKey) ? prev : new Set(prev).add(contextKey)
    )
  }, [])

  // Reads `surfaceKeys` alone, never `dbNodes`: a card's connection key has to
  // be stable for its whole life, and re-deriving it from a map that changes on
  // every board mutation would re-key a live connection. Entries are validated
  // against their node in the prune above, which runs on hydration — i.e.
  // before there is a board for a card to mount on.
  const contextKeyForPin = useCallback(
    (pinDbId: number) =>
      surfaceKeys.get(pinDbId)?.key ?? pinSurfaceKey(pinDbId),
    [surfaceKeys]
  )

  /**
   * Cards whose agent is ALREADY running come back live, not dormant.
   *
   * Dormancy exists so that arriving on a board with six expanded cards does
   * not start six agent CLIs — it is about not SPAWNING agents, not about
   * refusing to hold one that is already there. Leaving such a card asleep
   * costs twice: it reads as disconnected (or streams a reply into a card whose
   * composer nobody has armed) while the user watches, and because
   * `registerLiveSurfaceKeys` only claims live surfaces, nothing claims that
   * connection — so a minute after the turn settles the idle sweep reclaims it
   * and kills the agent out from under the card.
   *
   * Adopting one starts nothing: `connect()` returns on its fast path for an
   * entry with the same agent and working directory, so this only makes the
   * card own what it is already showing.
   *
   * Runs once per canvas mount, off the connection store's synchronous
   * snapshot. Both inputs are read from storage before first paint, so nothing
   * has to load first — including a key inherited from a draft, which the prune
   * above has not validated yet at this point. That window is harmless in the
   * only direction that matters: an entry belonging to some other database
   * names a key this client never opened a connection under, so it matches
   * nothing and adopts nothing.
   *
   * Drafts are deliberately not scanned. A draft that was merely connected is
   * disconnected by its own unmount (`shouldDisconnectOnUnmount` keeps only
   * BUSY connections), so by the time the board comes back there is nothing
   * left to adopt; a draft that was mid-first-send is a card that should have
   * become a pinned one already.
   */
  const connectionStore = useConnectionStore()
  const adoptedLiveRef = useRef(false)
  useEffect(() => {
    if (adoptedLiveRef.current) return
    adoptedLiveRef.current = true
    const alive = [...detailCards]
      .map((pinDbId) => contextKeyForPin(pinDbId))
      .filter((key) => {
        const status = connectionStore.getConnection(key)?.status
        return (
          status === "connected" ||
          status === "prompting" ||
          status === "connecting"
        )
      })
    if (alive.length === 0) return
    setLiveSurfaces((prev) => {
      const next = new Set(prev)
      for (const key of alive) next.add(key)
      return next
    })
  }, [connectionStore, contextKeyForPin, detailCards])

  /** The side panel's conversation, re-resolved rather than snapshotted so a
   *  rename or a status change reaches its header — and so the panel empties
   *  itself if the conversation is deleted out from under it. */
  const drawerConversation = useMemo(
    () =>
      drawerConversationId == null
        ? null
        : (conversations.find((c) => c.id === drawerConversationId) ?? null),
    [conversations, drawerConversationId]
  )

  // A deleted conversation closes the panel for real, rather than leaving it
  // holding an id nothing resolves. Controlled `open` going false does NOT emit
  // `onOpenChange` (that fires for user-driven closes), so without this the id
  // would sit there until the next manual close — and the connection key below
  // would stay claimed, pinning a connection the idle sweep is meant to reclaim.
  //
  // Only once the list has settled: "not in the list" has to mean deleted, not
  // "not loaded yet". Today `refreshConversations` publishes only on success, so
  // there is no empty window to trip over — but a panel that closes itself on a
  // slow refresh would be a maddening bug to find, and this effect should not
  // depend on that staying true.
  // ...with one thing that outranks the list: a deletion seen at any point
  // wins. `refreshConversations` replaces the list wholesale without consulting
  // the tombstone, so a refresh that was already in flight when the delete
  // landed can put the row back — and this panel would then re-mount a live
  // surface on a conversation that no longer exists.
  const conversationsLoading = useAppWorkspaceStore(
    (s) => s.conversationsLoading
  )
  useEffect(() => {
    if (drawerConversationId == null) return
    if (isConversationDeleted(drawerConversationId)) {
      setDrawerConversationId(null)
      return
    }
    if (conversationsLoading) return
    if (drawerConversation == null) setDrawerConversationId(null)
  }, [conversationsLoading, drawerConversationId, drawerConversation])

  /** Connection keys with a surface actually MOUNTED right now. */
  const mountedSurfaceKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const pinDbId of detailCards) {
      if (dbNodes.has(pinDbId)) keys.add(contextKeyForPin(pinDbId))
    }
    for (const draft of drafts) keys.add(draftSurfaceKey(draft.id))
    // Off the RESOLVED conversation, not the id: the panel renders its surface
    // on exactly the same condition, and "mounted" has to mean mounted.
    if (drawerConversation) {
      keys.add(drawerSurfaceKey(drawerConversation.id))
    }
    return keys
  }, [detailCards, dbNodes, drafts, drawerConversation, contextKeyForPin])

  const openConversationDrawer = useCallback(
    (conversationId: number) => {
      setDrawerConversationId(conversationId)
      // Opening the panel IS the interaction that promotes it: unlike a card
      // restored from a previous visit, nobody arrives here without asking.
      activateSurface(drawerSurfaceKey(conversationId))
    },
    [activateSurface]
  )

  // Tell the connection provider which surfaces are on screen. Its idle sweep
  // reclaims any connection that is neither the single `activeKey` nor an open
  // TAB, and canvas cards are not tabs — so without this the second live card
  // has its agent disconnected after a minute of the user working in the first
  // one, while it sits there looking connected.
  //
  // Registered as `liveSurfaces ∩ mounted`, not `liveSurfaces` alone.
  // `liveSurfaces` never forgets a key (re-expanding a card should reconnect it
  // rather than send it back to sleep), so claiming it raw would keep claiming
  // cards the user collapsed — and a connection that outlived its card, which
  // teardown deliberately leaves running while it is mid-prompt, would then be
  // pinned alive forever instead of being reclaimed once it settles.
  useEffect(() => {
    const onScreen = new Set(
      [...liveSurfaces].filter((key) => mountedSurfaceKeys.has(key))
    )
    registerLiveSurfaceKeys("canvas", onScreen)
    return () => registerLiveSurfaceKeys("canvas", new Set())
  }, [liveSurfaces, mountedSurfaceKeys, registerLiveSurfaceKeys])

  const setCardDetail = useCallback(
    (pinDbId: number, open: boolean) => {
      setDetailCardsPersisted((prev) => {
        if (prev.has(pinDbId) === open) return prev
        const next = new Set(prev)
        if (open) next.add(pinDbId)
        else next.delete(pinDbId)
        return next
      })
      // Expanding here and now IS the interaction — only a restored expansion
      // has to wait to be touched.
      if (open) activateSurface(contextKeyForPin(pinDbId))
    },
    [setDetailCardsPersisted, activateSurface, contextKeyForPin]
  )

  /**
   * Take a MEMBER card out of its region (custom regions move, bindings copy —
   * one transaction either way), optionally expanding the resulting pinned card
   * into a live conversation. A 520×560 surface cannot live in the region's
   * uniform grid, which is why expanding a member card has to detach it first.
   */
  const detachMember = useCallback(
    async (
      regionDbId: number,
      conversationId: number,
      opts?: { expand?: boolean }
    ) => {
      const rect = derived.regionRects.find((r) => r.dbId === regionDbId)
      // Park it just outside the region's right edge rather than on top of it.
      const x = rect ? rect.x + rect.width + 32 : 0
      const y = rect ? rect.y : 0
      try {
        const res = await canvasDetachMember(regionDbId, conversationId, x, y)
        useCanvasStore.getState().applyResponse(res.revision, (nodes) => {
          const region = nodes.get(regionDbId)
          if (region && region.kind === "custom") {
            nodes.set(regionDbId, {
              ...region,
              member_ids: region.member_ids.filter((m) => m !== conversationId),
            })
          }
          nodes.set(res.value.id, res.value)
        })
        if (opts?.expand) setCardDetail(res.value.id, true)
        setSelectedIds(new Set([regionNodeId(res.value.id)]))
      } catch (e) {
        toast.error(toErrorMessage(e))
      }
    },
    [derived.regionRects, setCardDetail]
  )

  const removeMember = useCallback(
    async (regionDbId: number, conversationId: number) => {
      await patchNode(regionDbId, { memberRemove: conversationId })
    },
    [patchNode]
  )

  const dismissDraft = useCallback(
    (draftId: string) => {
      // A draft whose first send is already minting its conversation row is
      // past the point of no return: the row lands regardless and the prompt is
      // on its way to the agent, so dropping the card here would leave a
      // conversation nobody can see running work nobody asked for. The guard
      // lives HERE rather than on the buttons because there are three ways to
      // discard — the card's own control, the dock, and a multi-select delete —
      // and only one of them was ever going to be remembered.
      if (sendingDraftsRef.current.has(draftId)) return
      setDraftsPersisted((prev) => prev.filter((d) => d.id !== draftId))
    },
    [setDraftsPersisted]
  )

  const setDraftAgent = useCallback(
    (draftId: string, agentType: AgentType) => {
      setDraftsPersisted((prev) =>
        prev.map((d) => (d.id === draftId ? { ...d, agentType } : d))
      )
    },
    [setDraftsPersisted]
  )

  /** Colour an unsent draft. Stored on the local draft rather than patched onto
   *  a row, because there is no row yet — `materializeDraft` hands it to the one
   *  the first send creates, so the colour survives the moment the card stops
   *  being a draft. */
  const setDraftColor = useCallback(
    (draftId: string, color: string) => {
      setDraftsPersisted((prev) =>
        prev.map((d) => (d.id === draftId ? { ...d, color } : d))
      )
    },
    [setDraftsPersisted]
  )

  /** Re-point an unsent draft at another folder (or at chat mode). Purely local
   *  — nothing exists on the backend until the first message, so switching is
   *  just a different target for that first send. */
  const setDraftTarget = useCallback(
    (draftId: string, target: NewConversationTarget) => {
      setDraftsPersisted((prev) =>
        prev.map((d) => (d.id === draftId ? { ...d, target } : d))
      )
    },
    [setDraftsPersisted]
  )

  /**
   * The draft's first message created the row: persist the card where the draft
   * sat, expanded, and drop the local draft.
   *
   * The persisted card INHERITS the draft's connection key. The draft's
   * connection is mid-prompt at this moment; letting the new card default to
   * `canvas-node-<id>` would stand up a second surface for a session this
   * client already owns, and leave the draft's entry orphaned for the idle
   * sweep. Carrying the key over means the swap is invisible to the connection
   * layer — same key, same connection, same live turn.
   */
  const materializeDraft = useCallback(
    async (draftId: string, conversationId: number) => {
      const draft = drafts.find((d) => d.id === draftId)
      if (!draft) return
      const rfId = draftNodeId(draftId)
      const pos = overlay.get(rfId)
      const size = sizeOverlay.get(rfId)
      const created = await createNode({
        kind: "conversation",
        conversationId,
        // The draft's colour becomes the row's, in the same write that creates
        // it. Omitted when empty — the palette clears by re-picking, and the
        // column's own "no colour" is null, not "".
        ...(draft.color ? { color: draft.color } : {}),
        x: pos?.x ?? draft.x,
        y: pos?.y ?? draft.y,
        width: size?.width ?? draft.width,
        height: size?.height ?? draft.height,
      })
      if (!created) return
      const key = draftSurfaceKey(draftId)
      // Inheriting the key is also what carries the RUNTIME session across: the
      // message the user just sent, and the reply already answering it, are
      // filed under the id that key derives, and the arriving card adopts them
      // in a layout effect. That has to happen on the far side of this swap —
      // ReactFlow applies a changed `nodes` prop from a passive effect, so the
      // draft card is still mounted (and paintable) after this returns. See
      // `CanvasConversationSurface`'s hand-off effect.
      setSurfaceKeys((prev) => {
        const next = new Map(prev).set(created.id, {
          conversationId,
          createdAt: created.created_at,
          key,
        })
        saveCanvasSurfaceKeys(next)
        return next
      })
      activateSurface(key)
      // Open the persisted card in detail mode BEFORE removing the draft so the
      // surface the user is watching swaps in place rather than blinking away.
      setDetailCardsPersisted((prev) => new Set(prev).add(created.id))
      // Deliberately not `dismissDraft`: its guard refuses to drop a draft whose
      // first send is in flight, which is exactly the state this one is in. That
      // guard exists for the three DISCARD paths, where dropping the card would
      // strand a conversation nobody can see. This is the hand-off — the row is
      // created, the card that shows it is on screen, and leaving the draft up
      // would put a second surface on the same connection key.
      setDraftsPersisted((prev) => prev.filter((d) => d.id !== draftId))
    },
    [
      drafts,
      overlay,
      sizeOverlay,
      createNode,
      activateSurface,
      setDetailCardsPersisted,
      setDraftsPersisted,
    ]
  )

  const endNodeResize = useCallback(
    (
      nodeId: number,
      geometry: { x: number; y: number; width: number; height: number }
    ) => {
      const rfId = regionNodeId(nodeId)
      const dbNode = dbNodes.get(nodeId)
      // A region resize IS a grid-shape change: the drag was snapped to whole
      // cards on the way in, so record the column/row count it landed on as the
      // region's shape. Otherwise the next render would re-derive columns from
      // the width and the pinned shape would silently drift from the frame.
      // Kinds are enumerated through ONE predicate, never re-listed here: the
      // backend rejects grid fields on a non-region outright, so a kind this
      // check forgot about would have its whole geometry patch fail and the
      // card would snap back after every resize.
      const gridPatch =
        dbNode && isRegionKind(dbNode.kind)
          ? {
              gridColumns: columnsForRegionWidth(geometry.width),
              gridRows: rowsForRegionHeight(geometry.height),
            }
          : {}
      void patchNode(nodeId, { ...geometry, ...gridPatch }).finally(() => {
        // Resizes never get a dragStop, so the overlays they fed are cleared
        // here — success (store now holds the geometry) and failure (snap
        // back to the stored one) both want them gone. If a NEW gesture on
        // the same node started during the patch round-trip, this clear
        // costs it one frame at most: every live gesture rewrites its
        // overlay entry on the next change batch.
        setOverlay((prev) => {
          if (!prev.has(rfId)) return prev
          const next = new Map(prev)
          next.delete(rfId)
          return next
        })
        setSizeOverlay((prev) => {
          if (!prev.has(rfId)) return prev
          const next = new Map(prev)
          next.delete(rfId)
          return next
        })
      })
    },
    [dbNodes, patchNode]
  )

  // ── Drop preview ──

  /** Absolute canvas position of a dragged card. Member positions are stored
   *  relative to their region (RF child-node semantics), so they only become
   *  comparable to region/card rects once the region's own origin is added —
   *  and that origin is itself under the drag overlay in a mixed selection. */
  const absoluteDragPosition = useCallback(
    (
      source: CanvasDragSource,
      relative: { x: number; y: number },
      regions: readonly RegionRect[]
    ) => {
      if (source.kind !== "member") return relative
      const rect = regions.find((r) => r.dbId === source.regionDbId)
      return rect
        ? { x: rect.x + relative.x, y: rect.y + relative.y }
        : relative
    },
    []
  )

  const dropHint = useMemo<CanvasDropHint | null>(() => {
    if (!dragSource) return null
    const relative = overlay.get(dragSource.rfId)
    // No overlay entry yet: the pointer went down but hasn't moved, so there is
    // nothing to preview.
    if (!relative) return null
    const abs = absoluteDragPosition(
      dragSource.source,
      relative,
      derived.regionRects
    )
    return computeDropHint(
      dragSource.source,
      abs,
      derived.regionRects,
      derived.pinRects
    )
  }, [dragSource, overlay, derived, absoluteDragPosition])

  const dropTargetRegionId =
    dropHint?.type === "region" ? dropHint.regionDbId : null

  const viewContext = useMemo<CanvasViewContextValue>(
    () => ({
      expandedRegions,
      setRegionExpanded,
      detailCards,
      setCardDetail,
      liveSurfaces: liveSurfaces,
      activateSurface,
      detachMember,
      removeMember,
      selectedConversationIds,
      dropTargetRegionId,
      renamingRegionId,
      setRenamingRegionId,
      patchNode,
      endNodeResize,
      deleteNode,
      openConversation,
      openConversationDrawer,
      contextKeyForPin,
      draftSurfaceKey,
      saveSelectionAsNote,
      dismissDraft,
      sendingDrafts,
      setDraftSending,
      setDraftAgent,
      setDraftTarget,
      setDraftColor,
      materializeDraft,
    }),
    [
      expandedRegions,
      setRegionExpanded,
      detailCards,
      setCardDetail,
      liveSurfaces,
      activateSurface,
      detachMember,
      removeMember,
      selectedConversationIds,
      dropTargetRegionId,
      renamingRegionId,
      patchNode,
      endNodeResize,
      deleteNode,
      openConversation,
      openConversationDrawer,
      contextKeyForPin,
      saveSelectionAsNote,
      dismissDraft,
      sendingDrafts,
      setDraftSending,
      setDraftAgent,
      setDraftTarget,
      setDraftColor,
      materializeDraft,
    ]
  )

  // ── Drag reconcile ──

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setSelectedIds((prev) => {
      let next: Set<string> | null = null
      for (const change of changes) {
        if (change.type !== "select") continue
        next ??= new Set(prev)
        if (change.selected) next.add(change.id)
        else next.delete(change.id)
      }
      return next ?? prev
    })
    // Alignment: nudge the whole gesture by whatever the GRABBED node needs to
    // land on a neighbour's edge or centre line. Computed before the overlay
    // write so the node is painted already snapped — a correction applied after
    // would show the unsnapped frame first and jitter.
    //
    // `dragging === true` is what separates a drag from a resize: RF reports a
    // top/left resize handle as a position change too, and those must not snap
    // (the opposite edge is anchored, so a nudge would silently resize).
    let snapDx = 0
    let snapDy = 0
    const primary = alignPrimaryRef.current
    if (primary && !altHeldRef.current) {
      const lead = changes.find(
        (c) => c.type === "position" && c.id === primary.id && c.dragging
      )
      if (lead?.type === "position" && lead.position) {
        const { dx, dy, guides } = computeAlignment(
          {
            x: lead.position.x,
            y: lead.position.y,
            width: primary.width,
            height: primary.height,
          },
          alignCandidatesRef.current,
          // Constant on SCREEN: the same few pixels of pointer travel must
          // reach a guide whether the board is zoomed in or out.
          ALIGN_TOLERANCE_PX / Math.max(zoomRef.current, 0.01),
          // The dots, as the fallback for whichever axis found no neighbour —
          // which on an infinite board is most of a drag.
          BOARD_DOT_GAP
        )
        snapDx = dx
        snapDy = dy
        lastSnapRef.current = { dx, dy }
        setAlignGuides((prev) =>
          prev.length === 0 && guides.length === 0 ? prev : guides
        )
      }
    } else if (primary && altHeldRef.current) {
      lastSnapRef.current = { dx: 0, dy: 0 }
      setAlignGuides((prev) => (prev.length === 0 ? prev : []))
    }

    // Position changes feed the transient overlay — never the store; the store
    // position only moves via command responses / events. Both drags (cleared
    // at dragStop) and top/left-handle resizes (cleared by endNodeResize)
    // land here.
    setOverlay((prev) => {
      let next: Map<string, { x: number; y: number }> | null = null
      for (const change of changes) {
        if (change.type !== "position" || !change.position) continue
        next ??= new Map(prev)
        const snap = change.dragging === true
        next.set(change.id, {
          x: change.position.x + (snap ? snapDx : 0),
          y: change.position.y + (snap ? snapDy : 0),
        })
      }
      return next ?? prev
    })
    // Dimension changes feed the size overlay ONLY while a NodeResizer handle
    // is actively held (`resizing`): RF also emits dimension changes for
    // plain DOM measurements (mount, visibility), and admitting those would
    // pin every node's size and shadow remote resizes forever. Cleared by
    // endNodeResize.
    //
    // Region dimensions are QUANTIZED to whole cards on the way in, so the
    // frame steps one column / one row at a time and can never come to rest at
    // a width that renders a ragged half-column. Resolved here rather than
    // inside the updater, which must stay a pure function of `prev`.
    const storeNodes = useCanvasStore.getState().nodes
    const liveSizes: [string, { width: number; height: number }][] = []
    for (const change of changes) {
      if (
        change.type !== "dimensions" ||
        !change.dimensions ||
        change.resizing !== true
      ) {
        continue
      }
      const dbId = parseRegionNodeId(change.id)
      const dbNode = dbId != null ? storeNodes.get(dbId) : undefined
      // Only member GRIDS snap; notes, files, terminals and (expanded)
      // conversation cards resize freely — they have no cards to line up.
      const isRegion = dbNode != null && isRegionKind(dbNode.kind)
      liveSizes.push([
        change.id,
        isRegion
          ? {
              width: regionWidthForColumns(
                columnsForRegionWidth(change.dimensions.width)
              ),
              height: regionHeightForRows(
                rowsForRegionHeight(change.dimensions.height)
              ),
            }
          : change.dimensions,
      ])
    }
    if (liveSizes.length > 0) {
      setSizeOverlay((prev) => {
        const next = new Map(prev)
        for (const [id, size] of liveSizes) next.set(id, size)
        return next
      })
    }
  }, [])

  /** Open a gesture: claim the next token, record what it is moving, and
   *  snapshot what it can align to. */
  const beginDrag = useCallback((node: Node, draggedNodes: Node[]): number => {
    const moving = new Set(
      draggedNodes.length > 0 ? draggedNodes.map((n) => n.id) : [node.id]
    )
    draggedNodeIdsRef.current = moving
    // Snapshot once per gesture rather than deriving per frame: the candidate
    // boxes don't change while a drag is in flight (the moving ones are
    // excluded), and rebuilding this map on every pointer move would put an
    // O(nodes) pass in the middle of the drag.
    //
    // Top-level only. Member cards sit in their region's grid — they have no
    // free position to align, and their coordinates are parent-relative, so
    // they would compare against a different origin entirely.
    const candidates: CanvasRect[] = []
    for (const n of derivedRef.current.nodes) {
      if (n.parentId || moving.has(n.id)) continue
      candidates.push({
        x: n.position.x,
        y: n.position.y,
        width: n.width ?? 0,
        height: n.height ?? 0,
      })
    }
    for (const draft of draftsRef.current) {
      const id = draftNodeId(draft.id)
      if (moving.has(id)) continue
      candidates.push({
        x: draft.x,
        y: draft.y,
        width: draft.width,
        height: draft.height,
      })
    }
    alignCandidatesRef.current = candidates
    // The grabbed node leads: its snap is applied to the whole selection so a
    // multi-node drag stays rigid instead of each node chasing its own line.
    const primary =
      draggedNodes.find((n) => n.id === node.id) ?? draggedNodes[0] ?? node
    alignPrimaryRef.current = parseMemberNodeId(primary.id)
      ? null
      : {
          id: primary.id,
          width: primary.width ?? 0,
          height: primary.height ?? 0,
        }
    // Guides belong to the gesture that drew them. A previous drag still
    // settling would otherwise leave its lines on screen through a new one that
    // never snaps at all (a member card), pointing at nothing.
    setAlignGuides((prev) => (prev.length === 0 ? prev : []))
    lastSnapRef.current = { dx: 0, dy: 0 }
    return ++dragTokenRef.current
  }, [])

  const handleSelectionDragStart = useCallback(
    (_e: unknown, nodes: Node[]) => {
      if (nodes.length > 0) beginDrag(nodes[0], nodes)
    },
    [beginDrag]
  )

  const handleNodeDragStart = useCallback(
    (_e: unknown, node: Node, draggedNodes: Node[]) => {
      const token = beginDrag(node, draggedNodes)
      const member = parseMemberNodeId(node.id)
      if (member) {
        const dbNode = dbNodes.get(member.regionDbId)
        if (!dbNode) return
        setDragSource({
          token,
          rfId: node.id,
          source: {
            kind: "member",
            regionDbId: member.regionDbId,
            conversationId: member.conversationId,
          },
        })
        // Freeze the source region's member list so a remote change can't
        // reflow the grid mid-drag.
        const members = computeRegionMembers(dbNode, conversations, allFolders)
        setFrozenMembers(
          new Map([[member.regionDbId, members.map((m) => m.id)]])
        )
        return
      }
      // A loose SUMMARY card can be dropped into a region or onto another card;
      // an expanded one is a window, and windows just move.
      if (node.type !== "conversationCard") return
      const data = node.data as unknown as ConversationCardData
      if (data.pinDbId == null || !data.conversation) return
      setDragSource({
        token,
        rfId: node.id,
        source: {
          kind: "pin",
          pinDbId: data.pinDbId,
          conversationId: data.conversation.id,
        },
      })
    },
    [beginDrag, dbNodes, conversations, allFolders]
  )

  /** The correction the last painted frame applied.
   *
   *  Replayed, not recomputed: what the board must persist is what the user
   *  SAW. Recomputing at release would consult the live Alt state and zoom, so
   *  tapping Alt after the final mouse move (or releasing it) would hand back a
   *  different answer than the frame still on screen — and the card would jump
   *  on mouseup, which is precisely the mismatch snapping exists to avoid. */
  const snapForFinalPositions = useCallback(
    (dragged: Node[]): { dx: number; dy: number } => {
      const primary = alignPrimaryRef.current
      if (!primary || !dragged.some((n) => n.id === primary.id)) {
        return { dx: 0, dy: 0 }
      }
      return lastSnapRef.current
    },
    []
  )

  /** Retire a finished gesture. `token` is what makes it safe to call after an
   *  awaited command: a drag that started while this one was settling owns the
   *  board now, and its source/freeze must survive. */
  const clearDragState = useCallback((nodeIds: string[], token: number) => {
    const superseded = dragTokenRef.current !== token
    setOverlay((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      // Positions the newer drag is actively writing stay put; everything this
      // gesture put there goes back to store truth.
      for (const id of nodeIds) {
        if (superseded && draggedNodeIdsRef.current.has(id)) continue
        next.delete(id)
      }
      return next.size === prev.size ? prev : next
    })
    if (superseded) return
    setFrozenMembers(null)
    setDragSource(null)
    setAlignGuides([])
    alignPrimaryRef.current = null
    alignCandidatesRef.current = []
  }, [])

  /** Persist the final position of every TOP-LEVEL persisted node in a drag,
   *  and fold draft cards (which have no DB row) back into local state. Shared
   *  by the single-node drag and the marquee-selection drag, which RF reports
   *  through two different callbacks. `skipDbIds` are the cards about to be
   *  swallowed by a region — writing their positions first would only race the
   *  deletes that are already committed to happen. */
  const commitDraggedPositions = useCallback(
    (dragged: Node[], skipDbIds?: ReadonlySet<number>) => {
      const moves: CanvasNodeMovePayload[] = []
      const draftMoves = new Map<string, { x: number; y: number }>()
      for (const n of dragged) {
        const dbId = parseRegionNodeId(n.id)
        if (dbId != null) {
          if (!skipDbIds?.has(dbId)) {
            moves.push({ id: dbId, x: n.position.x, y: n.position.y })
          }
          continue
        }
        const draftId = parseDraftNodeId(n.id)
        if (draftId != null) draftMoves.set(draftId, n.position)
      }
      if (draftMoves.size > 0) {
        setDraftsPersisted((prev) =>
          prev.map((d) => {
            const pos = draftMoves.get(d.id)
            return pos ? { ...d, x: pos.x, y: pos.y } : d
          })
        )
      }
      return moves
    },
    [setDraftsPersisted]
  )

  const handleSelectionDragStop = useCallback(
    async (_e: unknown, nodes: Node[]) => {
      // Read synchronously: this is still THIS gesture's token, because the
      // next one cannot start before the handler yields at the await.
      const token = dragTokenRef.current
      // Same reason as the node-drag path: the snap lives in the overlay, so
      // the reported positions are the unsnapped ones.
      const snap = snapForFinalPositions(nodes)
      const snapped =
        snap.dx === 0 && snap.dy === 0
          ? nodes
          : nodes.map((n) => ({
              ...n,
              position: {
                x: n.position.x + snap.dx,
                y: n.position.y + snap.dy,
              },
            }))
      const moves = commitDraggedPositions(snapped)
      try {
        await moveNodes(moves)
      } finally {
        clearDragState(
          nodes.map((n) => n.id),
          token
        )
      }
    },
    [commitDraggedPositions, moveNodes, clearDragState, snapForFinalPositions]
  )

  /** Collect conversations into a region — the one command behind all three
   *  gestures (box-select, card into region, card onto card). */
  const groupIntoRegion = useCallback(
    async (input: GroupIntoRegionInput) => {
      const res = await canvasGroupIntoRegion(input)
      useCanvasStore.getState().applyResponse(res.revision, (nodes) => {
        for (const id of res.value.deletedIds) nodes.delete(id)
        nodes.set(res.value.node.id, res.value.node)
      })
      forgetNodes(res.value.deletedIds)
      setSelectedIds(new Set([regionNodeId(res.value.node.id)]))
    },
    [forgetNodes]
  )

  /** Turn a drop into its command. The hint is recomputed from the drag's FINAL
   *  position rather than reused from the preview, so a last frame the preview
   *  never saw still lands correctly. */
  const applyDrop = useCallback(
    async (source: CanvasDragSource, hint: CanvasDropHint) => {
      if (hint.type === "same") return
      if (hint.type === "canvas") {
        // A loose card just moved (already batched); a member card leaves its
        // region for the spot it was dropped on.
        if (source.kind !== "member") return
        const res = await canvasDetachMember(
          source.regionDbId,
          source.conversationId,
          hint.x,
          hint.y
        )
        useCanvasStore.getState().applyResponse(res.revision, (nodes) => {
          const region = nodes.get(source.regionDbId)
          if (region && region.kind === "custom") {
            nodes.set(source.regionDbId, {
              ...region,
              member_ids: region.member_ids.filter(
                (m) => m !== source.conversationId
              ),
            })
          }
          nodes.set(res.value.id, res.value)
        })
        return
      }
      if (hint.type === "region") {
        // Member → region is a COPY (its own region may be a live binding with
        // nothing to remove); a loose card is absorbed, pin and all.
        await groupIntoRegion({
          targetRegionId: hint.regionDbId,
          memberIds: [source.conversationId],
          consumeNodeIds: source.kind === "pin" ? [source.pinDbId] : [],
        })
        return
      }
      // merge: a new two-card region grows around the STATIONARY card, exactly
      // where the ghost frame promised it would.
      await groupIntoRegion({
        memberIds: [hint.targetConversationId, source.conversationId],
        consumeNodeIds:
          source.kind === "pin"
            ? [hint.targetPinDbId, source.pinDbId]
            : [hint.targetPinDbId],
        gridColumns: 2,
        x: hint.rect.x,
        y: hint.rect.y,
        width: hint.rect.width,
        height: hint.rect.height,
      })
    },
    [groupIntoRegion]
  )

  const handleNodeDragStop = useCallback(
    async (_e: unknown, node: Node, draggedNodes: Node[]) => {
      const token = dragTokenRef.current
      const raw = draggedNodes.length > 0 ? draggedNodes : [node]
      // Re-apply the gesture's snap to the FINAL positions. ReactFlow's own
      // node positions never saw it — the snap lives in our overlay, which is
      // what the user watched — so persisting `node.position` as reported would
      // write the unsnapped spot and the card would jump back on settle. The
      // drop classification below has to agree with the preview too, or a card
      // that visibly landed inside a region would be filed outside it.
      const snap = snapForFinalPositions(raw)
      const dragged =
        snap.dx === 0 && snap.dy === 0
          ? raw
          : raw.map((n) => ({
              ...n,
              position: {
                x: n.position.x + snap.dx,
                y: n.position.y + snap.dy,
              },
            }))
      // The grabbed node from the SNAPPED set, not the raw parameter: the drop
      // is classified from this position, and reading the uncorrected one would
      // file a card by where the pointer was rather than where the card visibly
      // came to rest — the two differ by up to the snap tolerance, which is
      // exactly enough to land on the wrong side of a region edge.
      const grabbed = dragged.find((n) => n.id === node.id) ?? node
      const draggedIds = dragged.map((n) => n.id)
      // Only this gesture's own source counts: a stale one left by a drag still
      // settling would re-home a card the user never dropped there.
      const source =
        dragSource?.rfId === node.id && dragSource.token === token
          ? dragSource.source
          : null

      // The memoized rects lag the very last drag frame (state flushes after
      // this handler), and in a mixed selection regions and cards travelled
      // WITH the grabbed node — reconcile both against the dragged nodes' final
      // positions before classifying.
      const finalPos = new Map(dragged.map((n) => [n.id, n.position]))
      const moveOf = (dbId: number) => finalPos.get(regionNodeId(dbId))
      const regions: RegionRect[] = derived.regionRects.map((r) => {
        const moved = moveOf(r.dbId)
        return moved ? { ...r, x: moved.x, y: moved.y } : r
      })
      const pins: PinRect[] = derived.pinRects.map((p) => {
        const moved = moveOf(p.dbId)
        return moved ? { ...p, x: moved.x, y: moved.y } : p
      })

      const hint = source
        ? computeDropHint(
            source,
            absoluteDragPosition(source, grabbed.position, regions),
            regions,
            pins
          )
        : null

      // Only the GRABBED card re-homes; other selected cards snap back when
      // their overlay clears — multi-card detach is deliberately not a gesture
      // (one transaction per card would spray events).
      //
      // Every card this drop is about to delete is excluded from the move
      // batch: writing a position for a row the same gesture deletes only races
      // its own delete. The merge target counts too — it is stationary in the
      // usual case, but a marquee selection can carry it along.
      const swallowed = new Set<number>()
      if (hint?.type === "region" || hint?.type === "merge") {
        if (source?.kind === "pin") swallowed.add(source.pinDbId)
      }
      if (hint?.type === "merge") swallowed.add(hint.targetPinDbId)
      const moves = commitDraggedPositions(dragged, swallowed)

      try {
        await Promise.all([
          moves.length > 0 ? moveNodes(moves) : null,
          source && hint ? applyDrop(source, hint) : null,
        ])
      } catch (e) {
        toast.error(toErrorMessage(e))
        void useCanvasStore.getState().refetch()
      } finally {
        clearDragState(draggedIds, token)
      }
    },
    [
      dragSource,
      snapForFinalPositions,
      derived.regionRects,
      derived.pinRects,
      absoluteDragPosition,
      commitDraggedPositions,
      moveNodes,
      applyDrop,
      clearDragState,
    ]
  )

  // ── Node-level open ──

  // Single click SELECTS (and nothing else). Opening the workspace on a click
  // used to make the canvas a launcher you fell out of by accident; the
  // conversation now expands in place (double-click / dock) and "open in
  // workspace" is an explicit dock action.
  //
  // An EXPANDED card deliberately has no double-click handler: its body is real
  // text you select by double-clicking a word, and collapsing the card out from
  // under that would be the most annoying possible response.
  const handleNodeDoubleClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (node.type !== "conversationCard") return
      const data = node.data as ConversationCardData
      if (!data.conversation) return
      if (data.pinDbId != null) {
        setCardDetail(data.pinDbId, true)
      } else if (data.regionDbId != null) {
        void detachMember(data.regionDbId, data.conversation.id, {
          expand: true,
        })
      }
    },
    [setCardDetail, detachMember]
  )

  // ── Selection actions ──

  /** Top-level pinned cards in the current selection — the only nodes the
   *  "collect" gesture consumes (a region or note keeps living where it is).
   *
   *  `noteIds` is what the delete gesture asks about before it fires: of
   *  everything on this board, a note's text is the only thing the user typed
   *  by hand and the only thing a delete cannot give back. Cards and regions
   *  are arrangements of things that live elsewhere — re-pinning a card is
   *  tedious, losing a paragraph is not the same kind of loss. Ids rather than
   *  a count, because whether a note is EMPTY is answered at delete time (see
   *  `notesAtRisk`), not when the selection was last derived. */
  const selection = useMemo(() => {
    const memberIds: number[] = []
    const consumeNodeIds: number[] = []
    const deletableIds: number[] = []
    const draftIds: string[] = []
    const noteIds: number[] = []
    for (const n of selectedNodes) {
      const draftId = parseDraftNodeId(n.id)
      if (draftId != null) {
        draftIds.push(draftId)
        continue
      }
      const dbId = parseRegionNodeId(n.id)
      if (dbId != null) deletableIds.push(dbId)
      if (n.type === "note") {
        if (dbId != null) noteIds.push(dbId)
        continue
      }
      if (n.type !== "conversationCard" && n.type !== "conversationDetail") {
        continue
      }
      const data = n.data as unknown as ConversationCardData
      if (!data.conversation) continue
      memberIds.push(data.conversation.id)
      if (data.pinDbId != null) consumeNodeIds.push(data.pinDbId)
    }
    return { memberIds, consumeNodeIds, deletableIds, draftIds, noteIds }
  }, [selectedNodes])

  const groupSelection = useCallback(async () => {
    if (selection.memberIds.length === 0) return
    const bounds = getNodesBounds(selectedNodes)
    // Size the frame to the selection, then round UP to whole cards so the
    // grid inside it can never overflow the border it was just given.
    const columns = Math.max(
      1,
      Math.min(6, columnsForRegionWidth(bounds.width + REGION_PADDING * 2))
    )
    const rows = Math.max(1, Math.ceil(selection.memberIds.length / columns))
    try {
      await groupIntoRegion({
        memberIds: selection.memberIds,
        consumeNodeIds: selection.consumeNodeIds,
        gridColumns: columns,
        x: bounds.x - REGION_PADDING,
        y: bounds.y - REGION_PADDING,
        width: regionWidthForColumns(columns),
        height: regionHeightForRows(rows),
      })
    } catch (e) {
      toast.error(toErrorMessage(e))
    }
  }, [selection, selectedNodes, groupIntoRegion])

  const commitDeleteSelection = useCallback(async () => {
    for (const draftId of selection.draftIds) dismissDraft(draftId)
    if (selection.deletableIds.length === 0) return
    try {
      const res = await canvasDeleteNodes(selection.deletableIds)
      useCanvasStore.getState().applyResponse(res.revision, (nodes) => {
        for (const id of res.value) nodes.delete(id)
      })
      forgetNodes(res.value)
      setSelectedIds(new Set())
    } catch (e) {
      toast.error(toErrorMessage(e))
    }
  }, [selection, dismissDraft, forgetNodes])

  /**
   * Delete is destructive and the board has no undo, so a selection holding
   * written notes stops to ask. Both entry points come through here — the
   * Delete/Backspace chord and the dock's button — so neither can skip it.
   *
   * The ask is scoped to notes with text in them on purpose. Confirming every
   * delete would train the reflex it is meant to interrupt, and there is
   * nothing to protect in the common case: removing a card unpins it, removing
   * a region unframes it, and both leave the conversation itself untouched. An
   * empty note is a blank sheet — no keystroke of the user's dies with it.
   *
   * Backspace is what makes this worth a dialog rather than a toast. A note is
   * single-click to SELECT and double-click to EDIT, so the click that looks
   * like "put the cursor in my note" leaves the board holding the key, and in
   * a webview Backspace has decades of "go back" behind it.
   */
  const deleteSelection = useCallback(async () => {
    const notes = notesAtRisk(selection.noteIds)
    const terminals = terminalsAtRisk(selection.deletableIds)
    if (notes > 0 || terminals > 0) {
      setPendingDelete({ notes, terminals, run: commitDeleteSelection })
      return
    }
    await commitDeleteSelection()
  }, [
    selection.noteIds,
    selection.deletableIds,
    commitDeleteSelection,
    notesAtRisk,
    terminalsAtRisk,
  ])

  // ── Toolbar actions ──

  const startDraft = useCallback(
    (point: { x: number; y: number }) => {
      // Where it lives is decided here rather than asked for: one gesture puts
      // a card on the board, and the card's own folder chip retargets it until
      // the first message. Both entry points (the "+" menu and Cmd/Ctrl+N) come
      // through this function, so they can't drift apart.
      const target = resolveNewConversationTarget(activeFolderId, allFolders)
      // A best guess only: the card's AgentSelector corrects it through
      // `onFallback` once the fresh agent list says this one isn't usable —
      // the same self-correction draft TABS rely on.
      const folderDefault =
        "folderId" in target
          ? (allFolders.find((f) => f.id === target.folderId)
              ?.default_agent_type ?? null)
          : null
      const { agentType } = resolveDefaultAgent({
        folderDefault,
        inherit: null,
        sortedTypes: [],
        fresh: false,
      })
      const id = randomUUID()
      activateSurface(draftSurfaceKey(id))
      setDraftsPersisted((prev) => [
        ...prev,
        {
          id,
          target,
          agentType: agentType ?? AGENT_DISPLAY_ORDER[0],
          x: point.x,
          y: point.y,
          width: DETAIL_CARD_WIDTH,
          height: DETAIL_CARD_HEIGHT,
        },
      ])
    },
    [activeFolderId, allFolders, activateSurface, setDraftsPersisted]
  )

  // ── Element shortcuts ──

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Keys that belong to whatever the user is typing in, or to a layer
      // floating above the board. A canvas card holds a whole conversation —
      // composer, rename input, a note being edited — and Delete inside any of
      // them must delete a character, not the element the caret sits in.
      // Popovers and dialogs (the dock's colour palette, the add menu) are
      // portalled OUTSIDE the surface but are logically on top of it, so their
      // keys are theirs too.
      const target = e.target
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return
        const tag = target.tagName
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
        if (
          target.closest(
            // `alertdialog` is its own role, not a kind of `dialog` — the
            // delete confirmation renders as one, and a Delete pressed on its
            // buttons must not re-enter the gesture that opened it.
            '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]'
          )
        ) {
          return
        }
      }
      // Scope to the board. The canvas is a full-page route, but the window
      // still holds chrome the user can focus (title bar, sidebar), and a
      // Delete pressed there means something else entirely — it must not reach
      // in and remove whatever happens to be selected on the board.
      const active = document.activeElement
      const surface = surfaceRef.current
      if (
        active &&
        active !== document.body &&
        !(surface && surface.contains(active))
      ) {
        return
      }
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === "n") {
        // The canvas owns this while it is on screen: the board IS the user's
        // conversation list here, so a new conversation belongs on it rather
        // than in a workspace tab behind it. `stopPropagation` is what makes
        // "owns" true — the app's own shortcut handler sits on `document`, so
        // only a capture-phase listener that halts the event gets there first.
        e.preventDefault()
        e.stopPropagation()
        const center = screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        })
        startDraft({
          x: center.x - DETAIL_CARD_WIDTH / 2,
          y: center.y - DETAIL_CARD_HEIGHT / 2,
        })
        return
      }
      if (mod && e.key.toLowerCase() === "a") {
        // Inside a card's transcript, select-all means the TEXT — the card body
        // is explicitly selectable (`select-text`), and hijacking the chord
        // there would take away the only way to grab a whole reply.
        if (
          target instanceof HTMLElement &&
          target.closest(".select-text") != null
        ) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        setSelectedIds(new Set(rfNodes.map((n) => n.id)))
        return
      }
      if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault()
        e.stopPropagation()
        void groupSelection()
        return
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.size === 0) return
        e.preventDefault()
        e.stopPropagation()
        void deleteSelection()
        return
      }
      if (e.key === "F2" || e.key === "Enter") {
        // Enter also activates whatever control has focus, and that meaning
        // wins — pressing it on a dock button must press the button.
        if (
          e.key === "Enter" &&
          e.target instanceof HTMLElement &&
          e.target.closest('button,a,[role="button"]')
        ) {
          return
        }
        // Rename is a region's verb — `renamingRegionId` is read by the region
        // component's inline title input and nothing else, so arming it for any
        // other kind swallows the key and opens nothing. Through the shared
        // predicate rather than a list of exclusions, for the same reason the
        // resize commit is.
        if (selectedNodes.length !== 1) return
        const dbId = parseRegionNodeId(selectedNodes[0].id)
        const kind = dbId != null ? dbNodes.get(dbId)?.kind : undefined
        if (dbId == null || kind == null || !isRegionKind(kind)) return
        e.preventDefault()
        setRenamingRegionId(dbId)
        return
      }
      if (e.key === "Escape") {
        if (renamingRegionId != null) setRenamingRegionId(null)
        else if (selectedIds.size > 0) setSelectedIds(new Set())
      }
    }
    // On `window`, not the surface: the board is a full-page route with nothing
    // focused by default, so a listener on the container would only fire after
    // the user happened to click something focusable inside it. The listener
    // lives exactly as long as the route does.
    // Capture phase: the app's global shortcuts listen on `document` in the
    // bubble phase, which runs BEFORE a bubble listener on `window`. Only from
    // capture can the board claim a chord (see Cmd/Ctrl+N) rather than fire
    // alongside whatever the app already bound to it.
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [
    dbNodes,
    deleteSelection,
    groupSelection,
    renamingRegionId,
    rfNodes,
    screenToFlowPosition,
    selectedIds,
    selectedNodes,
    startDraft,
  ])

  const autoArrange = useCallback(() => {
    const moves = packLayout([...dbNodes.values()], derived.renderedSizes)
    void moveNodes(moves)
  }, [dbNodes, derived.renderedSizes, moveNodes])

  const seedFromWorkspace = useCallback(async () => {
    if (seeding) return
    setSeeding(true)
    try {
      for (const seed of seedRegionsFromFolders(openFolders)) {
        await createNode({
          kind: "folder",
          folderId: seed.folderId,
          x: seed.x,
          y: seed.y,
          width: seed.width,
          height: seed.height,
        })
      }
      window.setTimeout(() => void fitView({ padding: 0.2, duration: 400 }), 80)
    } finally {
      setSeeding(false)
    }
  }, [seeding, openFolders, createNode, fitView])

  const exportPng = useCallback(async () => {
    const viewportEl = document.querySelector<HTMLElement>(
      ".react-flow__viewport"
    )
    if (!viewportEl || rfNodes.length === 0) return
    setExporting(true)
    try {
      const bounds = getNodesBounds(rfNodes)
      const width = Math.min(Math.max(bounds.width + 128, 640), 4096)
      const height = Math.min(Math.max(bounds.height + 128, 480), 4096)
      const viewport = getViewportForBounds(
        bounds,
        width,
        height,
        0.25,
        2,
        0.08
      )
      const background = getComputedStyle(
        document.documentElement
      ).getPropertyValue("--background")
      const dataUrl = await toPng(viewportEl, {
        backgroundColor: background.trim() || undefined,
        width,
        height,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        },
        filter: (el) =>
          !(el instanceof HTMLElement && el.dataset?.canvasExportSkip != null),
      })
      const link = document.createElement("a")
      link.download = "canvas.png"
      link.href = dataUrl
      link.click()
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setExporting(false)
    }
  }, [rfNodes])

  // ── Viewport persistence ──

  const pendingViewport = useRef<Viewport | null>(null)
  const saveTimer = useRef<number | null>(null)
  /** Every viewport change, not just the settled ones: `zoomRef` scales the
   *  alignment tolerance, and `fitView` (which runs on a first visit, before
   *  any move has ended) would otherwise leave it at the initial value. */
  const handleMove = useCallback((_e: unknown, viewport: Viewport) => {
    zoomRef.current = viewport.zoom
  }, [])

  const handleMoveEnd = useCallback((_e: unknown, viewport: Viewport) => {
    pendingViewport.current = viewport
    zoomRef.current = viewport.zoom
    // A real debounce, restarted on every frame: the custom pan calls
    // `setViewport` per frame and each call fires `onMoveEnd` again, so leaving
    // the timer to run would put a synchronous localStorage write in the middle
    // of the gesture twice a second. Nothing is lost by waiting — the unmount
    // flush below covers leaving the route mid-pan.
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      if (pendingViewport.current) saveCanvasViewport(pendingViewport.current)
    }, VIEWPORT_SAVE_DELAY_MS)
  }, [])
  useEffect(
    () => () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current)
      // Leaving the route is the most common way a pan ends — flush whatever
      // the debounce still owes rather than losing the last move.
      if (pendingViewport.current) saveCanvasViewport(pendingViewport.current)
    },
    []
  )

  const empty = hydrated && dbNodes.size === 0 && drafts.length === 0
  // Nodes whose unmount would cost the user something: an expanded
  // conversation takes its ACP connection with it, a draft its unsent text,
  // and a terminal its emulator (the PTY survives, but the pane comes back
  // holding only what the scrollback replay can redraw). None of them may be
  // culled off-screen. File cards are absent on purpose — their content lives
  // in the shared file tab and a re-mount rebuilds them from it for free.
  const liveSurfaceCount =
    detailCards.size + drafts.length + terminalNodeIds.length

  return (
    <CanvasViewProvider value={viewContext}>
      <div
        ref={surfaceRef}
        className="canvas-surface relative h-full w-full"
        // Right-drag is the pan gesture everywhere on this board, and on macOS
        // the OS menu opens on mouse-DOWN — so it has to be suppressed before
        // the drag can start, for every element, including the composer inside
        // an expanded card. Capture phase, so nothing below can open one either.
        onContextMenuCapture={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={[]}
          nodeTypes={NODE_TYPES}
          onNodesChange={handleNodesChange}
          onNodeDragStart={handleNodeDragStart}
          onSelectionDragStart={handleSelectionDragStart}
          onNodeDragStop={handleNodeDragStop}
          onSelectionDragStop={handleSelectionDragStop}
          onNodeDoubleClick={handleNodeDoubleClick}
          onMove={handleMove}
          onMoveEnd={handleMoveEnd}
          // Restore the board exactly where it was left; `fitView` is the
          // first-visit fallback (the two are mutually exclusive in RF).
          fitView={initialViewport == null}
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          defaultViewport={initialViewport ?? undefined}
          minZoom={0.1}
          maxZoom={2}
          // Culling off-screen nodes is free for summary tiles — but a live
          // conversation card that unmounts takes its ACP connection with it,
          // so panning away from an expanded card would tear down (and on an
          // idle owner, KILL) the agent behind it. While any live surface is
          // open, correctness beats the render budget.
          onlyRenderVisibleElements={liveSurfaceCount === 0}
          // Left button draws a marquee; panning is `useCanvasRightDragPan`'s
          // job entirely. ReactFlow's own drag-pan is off (`[]`) because it
          // cannot pan over nodes anyway — every draggable node carries the
          // `nopan` class its filter bails out on — and two half-working
          // implementations would only differ in feel.
          panOnDrag={[]}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnScroll
          selectionKeyCode={null}
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={BOARD_DOT_GAP}
            size={1.5}
            className="canvas-dots"
          />
          {/* The frame a drop would create, drawn in canvas coordinates. It
              appears the moment the dragged card covers another one and is gone
              as soon as it moves off — the whole promise of the gesture is that
              what you see is what you get. */}
          {/* Alignment guides, in canvas coordinates. Hairlines rather than
              boxes: a guide's job is to say "these edges are on one line", and
              it spans only the elements it relates. `1/zoom` keeps them one
              screen pixel wide at any zoom — a flow-unit width would fatten
              into a bar when zoomed in and vanish when zoomed out. */}
          {alignGuides.length > 0 && (
            <ViewportPortal>
              {alignGuides.map((guide) => {
                const hair = 1 / Math.max(zoomRef.current, 0.01)
                return (
                  <div
                    key={`${guide.axis}-${guide.at}-${guide.from}`}
                    className="pointer-events-none absolute bg-primary/70"
                    style={
                      guide.axis === "x"
                        ? {
                            transform: `translate(${guide.at}px, ${guide.from}px)`,
                            width: hair,
                            height: guide.to - guide.from,
                          }
                        : {
                            transform: `translate(${guide.from}px, ${guide.at}px)`,
                            width: guide.to - guide.from,
                            height: hair,
                          }
                    }
                  />
                )
              })}
            </ViewportPortal>
          )}
          {dropHint?.type === "merge" && (
            <ViewportPortal>
              <div
                // Board units: this is drawn in flow coordinates like the
                // region it previews, so its label has to be measured the same
                // way or the chip outgrows the ghost it sits in.
                className="canvas-board-units pointer-events-none absolute flex items-start justify-center rounded-2xl border-2 border-dashed border-primary/70 bg-primary/5"
                style={{
                  transform: `translate(${dropHint.rect.x}px, ${dropHint.rect.y}px)`,
                  width: dropHint.rect.width,
                  height: dropHint.rect.height,
                }}
              >
                <span className="mt-1 rounded-full bg-primary/90 px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
                  {t("mergeIntoNewRegion")}
                </span>
              </div>
            </ViewportPortal>
          )}
          <CanvasDock
            onCreate={(input) => void createNode(input)}
            onNewConversation={startDraft}
            onFitView={() => void fitView({ padding: 0.2, duration: 300 })}
            onAutoArrange={autoArrange}
            onExportPng={() => void exportPng()}
            exporting={exporting}
            exportDisabled={rfNodes.length === 0}
            selectedNodes={selectedNodes}
            selectedConversationCount={selection.memberIds.length}
            onGroupSelection={() => void groupSelection()}
            onDeleteSelection={() => void deleteSelection()}
          />
          {/* The map lives in here too, above the zoom controls — one stack in
              one corner, so neither has to be positioned around the other. */}
          <CanvasViewportPanel />
        </ReactFlow>

        {/* Owned by the view, not by the card that opened it — see the note in
            `canvas-conversation-drawer`. A React child of the surface so it
            renders inside the canvas's provider (and so anything IT opens
            stacks on it), while its DOM portals to the body — which is also
            what stands the board's shortcuts down while the panel has focus:
            they are scoped to elements the surface contains. */}
        <CanvasConversationDrawer
          conversation={drawerConversation}
          contextKey={
            drawerConversation ? drawerSurfaceKey(drawerConversation.id) : null
          }
          onOpenChange={(open) => {
            if (!open) setDrawerConversationId(null)
          }}
          onOpenInWorkspace={() => {
            if (drawerConversation) openConversation(drawerConversation, true)
          }}
        />

        {!hydrated && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
          </div>
        )}

        {empty && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <MapIcon
              className="size-10 text-muted-foreground/40"
              aria-hidden="true"
            />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{t("empty")}</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {t("emptyHint")}
              </p>
            </div>
            <button
              type="button"
              className={cn(
                "pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50",
                seeding && "opacity-70"
              )}
              onClick={() => void seedFromWorkspace()}
              disabled={seeding || openFolders.length === 0}
            >
              {seeding ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Wand2 className="size-3.5" aria-hidden="true" />
              )}
              {t("seedFromWorkspace")}
            </button>
          </div>
        )}
        <AlertDialog
          open={pendingDelete !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("confirmDeleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {/* One sentence per situation rather than two stacked
                    clauses: the mixed case is rare enough that a dedicated
                    string reads better than gluing two together, and ICU
                    plurals can't span two independent counts anyway. */}
                {(pendingDelete?.notes ?? 0) > 0 &&
                (pendingDelete?.terminals ?? 0) > 0
                  ? t("confirmDeleteNotesAndTerminals", {
                      notes: pendingDelete?.notes ?? 0,
                      terminals: pendingDelete?.terminals ?? 0,
                    })
                  : (pendingDelete?.terminals ?? 0) > 0
                    ? t("confirmDeleteTerminals", {
                        count: pendingDelete?.terminals ?? 0,
                      })
                    : t("confirmDeleteNotes", {
                        count: pendingDelete?.notes ?? 0,
                      })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("confirmDeleteCancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const run = pendingDelete?.run
                  setPendingDelete(null)
                  void run?.()
                }}
              >
                {t("confirmDeleteConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </CanvasViewProvider>
  )
}

/** Default export for `next/dynamic` — the RF provider wrapper lives here so
 *  every hook below it (`useReactFlow` in the dock/menu, the pan controller)
 *  has its store. */
export default function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasFlow />
    </ReactFlowProvider>
  )
}
