import { resolveFolderDisplayName } from "@/lib/folder-display"
import type {
  CanvasNode,
  CanvasNodeMovePayload,
  DbConversationSummary,
  FolderDetail,
  FolderGroupDetail,
} from "@/lib/types"

/**
 * Pure derivation layer for the conversation canvas: DB nodes + live workspace
 * store state in, ReactFlow-shaped graph out. Everything here is a plain
 * function of its inputs (unit-tested directly); interaction state — transient
 * drag positions, expanded regions, member freezes — enters as explicit
 * parameters, never as module state.
 */

/** Fixed conversation-card footprint, in BOARD UNITS. Mirrors the backend's
 *  CARD_WIDTH/CARD_HEIGHT so a card pinned by `canvas_detach_member` lands
 *  exactly where the drag ghost showed it.
 *
 *  ⚠️ Board units are the canvas's whole coordinate system — every number in
 *  this file, every position ReactFlow renders, every geometry column in
 *  SQLite. They cannot follow the app's zoom control (which writes
 *  `font-size: 16 * zoom/100` onto `<html>`; see `appearance-provider.tsx`),
 *  because a rem is not a coordinate. So the board opts out of that zoom on
 *  BOTH sides and keeps its own: node components take their box from the RF
 *  wrapper (`h-full w-full`, never a rem utility like `w-56`), and their
 *  contents are drawn in board units too, via the `canvas-board-units` class in
 *  globals.css. Break either half and the two disagree at every zoom but 100% —
 *  cards overlapping their neighbours in the one direction, a title clipped
 *  through the middle of a line in the other. Zooming the board is the corner
 *  control's job. */
export const CARD_WIDTH = 224
export const CARD_HEIGHT = 132

/** Region chrome geometry, shared by the layout math here and the region
 *  component's classNames (which must render the same header height and
 *  padding or member cards would overlap the chrome). */
export const REGION_HEADER_HEIGHT = 40
export const REGION_PADDING = 12
export const CARD_GAP = 12
/** Height of a collapsed region capsule (header only). */
export const REGION_COLLAPSED_HEIGHT = 40
/** Height of the region's bottom "+N more" bar. A real row of chrome the grid
 *  reserves — not an overlay — so the last card row is never covered by it. */
export const REGION_FOOTER_HEIGHT = 36

/** Spacing of the dot lattice the board is drawn on. One constant for two
 *  consumers — the `<Background>` that paints the dots and the drag snapping
 *  that lands elements on them (`computeAlignment`'s `gridGap`). Split them and
 *  the board would snap to dots that aren't where it drew any. */
export const BOARD_DOT_GAP = 24

/** Footprint a pinned card takes when expanded into a live conversation. Used
 *  only while the stored geometry is still the SUMMARY footprint — once the
 *  user resizes a detail card, their size is what persists and wins. */
export const DETAIL_CARD_WIDTH = 520
export const DETAIL_CARD_HEIGHT = 560

/** Default footprint of a file card. Wide enough for ~80 columns of source at
 *  the board's text size, tall enough that a screenful of it is worth pinning;
 *  the user's own resize is what persists afterwards. */
export const FILE_CARD_WIDTH = 460
export const FILE_CARD_HEIGHT = 360
/** Below this a file card is chrome with a sliver of document under it. */
export const FILE_CARD_MIN_WIDTH = 240
export const FILE_CARD_MIN_HEIGHT = 160

/** Default footprint of a terminal card — 80×20-ish at the board's monospace
 *  size, the shape a shell expects to open at. */
export const TERMINAL_CARD_WIDTH = 480
export const TERMINAL_CARD_HEIGHT = 300
export const TERMINAL_CARD_MIN_WIDTH = 260
export const TERMINAL_CARD_MIN_HEIGHT = 140

/** The live-conversation cards' drag handle (their title bar). Fed to
 *  ReactFlow's per-node `dragHandle`, which is what lets the rest of the card be
 *  an ordinary document: selectable text, clickable composer, scrollable
 *  transcript. The class name lives here because the derive layer and the card
 *  component both have to spell it identically. */
export const DRAG_HANDLE_CLASS = "canvas-card-drag-handle"
export const DRAG_HANDLE_SELECTOR = `.${DRAG_HANDLE_CLASS}`

/** Cards shown in a region before the "+N" expander takes over, when the region
 *  has no pinned row count. A cap, not pagination: canvases curate, they don't
 *  list. */
export const MAX_VISIBLE_MEMBERS = 24

/** Where a brand-new conversation should live: a workspace folder, or chat mode
 *  (a hidden folder the backend mints on first send). */
export type NewConversationTarget = { folderId: number } | { chat: true }

/**
 * Where a new conversation card starts out, given the workspace's active
 * folder — the folder of the active TAB, kept in `app-workspace-store`.
 *
 * Same rule the tab strip's own new-conversation button follows
 * (`tabs/tab-bar.tsx`): use the active folder, and fall back to a folderless
 * chat rather than asking. On the canvas the fallback is doubly safe, because
 * the draft card's folder chip stays editable until the first message is sent —
 * picking here is a starting point, not a commitment.
 *
 * The id is re-resolved against the folder list rather than trusted: a folder
 * can be closed or deleted while its id is still the active one, and a draft
 * pointed at a folder that no longer exists would have nowhere to send.
 */
export function resolveNewConversationTarget(
  activeFolderId: number | null,
  folders: readonly FolderDetail[]
): NewConversationTarget {
  if (activeFolderId == null) return { chat: true }
  const folder = folders.find((f) => f.id === activeFolderId)
  if (!folder || folder.kind === "chat") return { chat: true }
  return { folderId: folder.id }
}

/** The width a region needs to fit exactly `columns` cards per row (and the
 *  height for `rows` rows of them). Resizing snaps to these values, so a region
 *  never sits at a width that renders a ragged half-column of dead space. */
export function regionWidthForColumns(columns: number): number {
  const n = Math.max(1, Math.round(columns))
  return REGION_PADDING * 2 + n * CARD_WIDTH + (n - 1) * CARD_GAP
}

export function regionHeightForRows(rows: number): number {
  const n = Math.max(1, Math.round(rows))
  return (
    REGION_HEADER_HEIGHT +
    REGION_PADDING * 2 +
    n * CARD_HEIGHT +
    (n - 1) * CARD_GAP
  )
}

/** Inverse of [`regionWidthForColumns`]: how many whole cards fit across a
 *  region of this width (at least one — a region narrower than a card still
 *  shows it, clipped, rather than rendering an empty frame). */
export function columnsForRegionWidth(width: number): number {
  const usable = Math.max(width - REGION_PADDING * 2, CARD_WIDTH)
  return Math.max(1, Math.floor((usable + CARD_GAP) / (CARD_WIDTH + CARD_GAP)))
}

export function rowsForRegionHeight(height: number): number {
  const usable = Math.max(
    height - REGION_HEADER_HEIGHT - REGION_PADDING * 2,
    CARD_HEIGHT
  )
  return Math.max(1, Math.floor((usable + CARD_GAP) / (CARD_HEIGHT + CARD_GAP)))
}

/** The column count a region actually lays out at: its pinned `grid_columns`
 *  when set, otherwise derived from the width. One place, because the grid, the
 *  visible-member cap and the resize snap all have to agree. */
export function effectiveColumns(
  node: CanvasNode,
  regionWidth: number
): number {
  return node.grid_columns > 0
    ? node.grid_columns
    : columnsForRegionWidth(regionWidth)
}

/** How many member cards a region shows before the "+N" bar takes over.
 *  A pinned row count makes the region a fixed viewport onto its members
 *  (rows × columns); without one it falls back to the flat cap. */
export function visibleMemberCap(node: CanvasNode, columns: number): number {
  return node.grid_rows > 0 ? node.grid_rows * columns : MAX_VISIBLE_MEMBERS
}

/** ReactFlow node ids. Regions/notes/pins are DB rows (`region-<dbId>`);
 *  member cards are DERIVED (`member-<regionDbId>-<convId>`, parented to the
 *  region) and never persisted. */
export function regionNodeId(dbId: number): string {
  return `region-${dbId}`
}

export function memberNodeId(
  regionDbId: number,
  conversationId: number
): string {
  return `member-${regionDbId}-${conversationId}`
}

export function parseRegionNodeId(id: string): number | null {
  if (!id.startsWith("region-")) return null
  const dbId = Number(id.slice("region-".length))
  return Number.isInteger(dbId) ? dbId : null
}

export function parseMemberNodeId(
  id: string
): { regionDbId: number; conversationId: number } | null {
  if (!id.startsWith("member-")) return null
  const parts = id.slice("member-".length).split("-")
  if (parts.length !== 2) return null
  const regionDbId = Number(parts[0])
  const conversationId = Number(parts[1])
  if (!Number.isInteger(regionDbId) || !Number.isInteger(conversationId)) {
    return null
  }
  return { regionDbId, conversationId }
}

/** Canvas scope: root-level work only. Delegation children and loop rows are
 *  sub-structure of a conversation, not peers to curate on a board. */
export function isCanvasEligible(c: DbConversationSummary): boolean {
  if (c.kind === "delegate" || c.kind === "loop") return false
  if (c.parent_id != null) return false
  return true
}

/** Two-key order (updated_at desc, id desc): recency first, and a total order
 *  even when timestamps collide (bulk imports share one clock tick). */
export function compareByRecency(
  a: DbConversationSummary,
  b: DbConversationSummary
): number {
  if (a.updated_at !== b.updated_at) {
    return a.updated_at < b.updated_at ? 1 : -1
  }
  return b.id - a.id
}

/**
 * The conversations a region shows, sorted. Folder regions merge the bound
 * folder with its worktree children (direct `parent_id` children only — a
 * region bound to a child shows just that child); group regions do the same for
 * every folder in the bound sidebar group; agent regions match by agent type
 * across the workspace; custom regions resolve their pinned ids (a stale id —
 * deleted before the prune landed — silently drops out).
 */
export function computeRegionMembers(
  node: CanvasNode,
  conversations: DbConversationSummary[],
  allFolders: FolderDetail[]
): DbConversationSummary[] {
  switch (node.kind) {
    case "folder": {
      if (node.folder_id == null) return []
      const folderIds = new Set<number>([node.folder_id])
      for (const f of allFolders) {
        if (f.parent_id === node.folder_id) folderIds.add(f.id)
      }
      return conversations
        .filter((c) => folderIds.has(c.folder_id) && isCanvasEligible(c))
        .sort(compareByRecency)
    }
    case "group": {
      if (node.folder_group_id == null) return []
      // Only `regular` folders carry a `group_id`; worktree children follow
      // their parent repo into the group (the same merge folder regions do), so
      // resolve the group's folders first and then absorb their children.
      const folderIds = new Set<number>()
      for (const f of allFolders) {
        if (f.group_id === node.folder_group_id) folderIds.add(f.id)
      }
      for (const f of allFolders) {
        if (f.parent_id != null && folderIds.has(f.parent_id))
          folderIds.add(f.id)
      }
      return conversations
        .filter((c) => folderIds.has(c.folder_id) && isCanvasEligible(c))
        .sort(compareByRecency)
    }
    case "agent":
      return conversations
        .filter((c) => c.agent_type === node.agent_type && isCanvasEligible(c))
        .sort(compareByRecency)
    case "custom": {
      const byId = new Map(conversations.map((c) => [c.id, c]))
      return (
        node.member_ids
          .map((id) => byId.get(id))
          // Eligibility re-checked on read: the backend validates liveness, not
          // scope, so a row that later became a sub-structure (re-parented into
          // a delegation) must drop out rather than violate the canvas scope.
          .filter(
            (c): c is DbConversationSummary => c != null && isCanvasEligible(c)
          )
          .sort(compareByRecency)
      )
    }
    default:
      return []
  }
}

/** Whether a binding region's target is gone from the live store (closed or
 *  deleted folder, funnel-missed conversation). Unresolved regions render a
 *  greyed hint instead of members — and come back to life if the folder is
 *  reopened, which is why folder deletion never prunes canvas rows. */
export function isUnresolvedBinding(
  node: CanvasNode,
  conversationsById: ReadonlyMap<number, DbConversationSummary>,
  foldersById: ReadonlyMap<number, FolderDetail>,
  folderGroupsById?: ReadonlyMap<number, FolderGroupDetail>
): boolean {
  if (node.kind === "folder") {
    return node.folder_id == null || !foldersById.has(node.folder_id)
  }
  if (node.kind === "group") {
    // Groups are hard-deleted, so a missing one is permanent — but the region
    // still renders as an unresolved frame rather than vanishing, matching
    // folder regions (and leaving the user something to delete or re-bind).
    return (
      node.folder_group_id == null ||
      (folderGroupsById != null && !folderGroupsById.has(node.folder_group_id))
    )
  }
  if (node.kind === "conversation") {
    return (
      node.conversation_id == null ||
      !conversationsById.has(node.conversation_id)
    )
  }
  return false
}

export interface GridLayout {
  /** Per-card position, relative to the REGION's top-left corner. */
  positions: { x: number; y: number }[]
  /** Height the region needs to show this many cards (header + rows). */
  contentHeight: number
  columns: number
}

/** Grid-managed member placement inside a region. Members are never freely
 *  positioned — the grid owns them; a drop inside the same region snaps back.
 *  `pinnedColumns > 0` overrides the width-derived column count. */
export function layoutRegionGrid(
  count: number,
  regionWidth: number,
  pinnedColumns = 0
): GridLayout {
  const columns =
    pinnedColumns > 0
      ? Math.round(pinnedColumns)
      : columnsForRegionWidth(regionWidth)
  const positions: { x: number; y: number }[] = []
  for (let i = 0; i < count; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    positions.push({
      x: REGION_PADDING + col * (CARD_WIDTH + CARD_GAP),
      y: REGION_HEADER_HEIGHT + REGION_PADDING + row * (CARD_HEIGHT + CARD_GAP),
    })
  }
  const rows = Math.ceil(count / columns)
  const contentHeight =
    rows === 0
      ? REGION_COLLAPSED_HEIGHT + REGION_PADDING * 2
      : REGION_HEADER_HEIGHT +
        REGION_PADDING * 2 +
        rows * CARD_HEIGHT +
        (rows - 1) * CARD_GAP
  return { positions, contentHeight, columns }
}

export interface CanvasRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RegionRect extends CanvasRect {
  dbId: number
  kind: CanvasNode["kind"]
}

/** A top-level pinned conversation card, for card-onto-card hit testing.
 *  Expanded (detail) cards are deliberately excluded by the caller: a 520×560
 *  window is a place you read in, not a tile you stack. */
export interface PinRect extends CanvasRect {
  dbId: number
  conversationId: number
}

/** Where a dragged conversation card is about to land. Purely geometric — what
 *  the caller DOES with it depends on where the card came from (a member card's
 *  `canvas` is a detach; a pinned card's is a plain move). */
export type CanvasDropHint =
  /** Over open canvas. */
  | { type: "canvas"; x: number; y: number }
  /** Over a custom region: it takes the conversation as a member. */
  | { type: "region"; regionDbId: number }
  /** Over another loose card: dropping collects both into a new custom region,
   *  laid out where `rect` shows — iPhone's "drop an app on an app". */
  | {
      type: "merge"
      targetPinDbId: number
      targetConversationId: number
      rect: CanvasRect
    }
  /** Back over its own region — snap to grid, no command. */
  | { type: "same" }

/** Who is being dragged. A member card belongs to a region's grid; a pinned
 *  card is a free-floating top-level node. */
export type CanvasDragSource =
  | { kind: "member"; regionDbId: number; conversationId: number }
  | { kind: "pin"; pinDbId: number; conversationId: number }

/**
 * Classify where a dragged conversation card currently is. `pos` is the card's
 * absolute canvas position (its top-left); the hit point is the CARD CENTER,
 * which is what the drag reads as "where the user is pointing".
 *
 * Regions are tested first and the topmost (= last in paint order, here:
 * highest db id) wins. A hit on the source region is `same`; a hit on a
 * binding region (folder / group / agent) is `canvas` rather than a rejection —
 * their member list is computed, so there is nothing to drop INTO, and pretending
 * otherwise by snapping the card back would read as a broken drag. Only when no
 * region is hit do loose cards get tested, so a card sitting inside a region's
 * frame can never be a merge target.
 *
 * Called on every drag frame (to paint the hint) and once again at drop, so the
 * preview and the committed action can never disagree.
 */
export function computeDropHint(
  source: CanvasDragSource,
  pos: { x: number; y: number },
  regions: readonly RegionRect[],
  pins: readonly PinRect[]
): CanvasDropHint {
  const cx = pos.x + CARD_WIDTH / 2
  const cy = pos.y + CARD_HEIGHT / 2
  const hits = (r: CanvasRect) =>
    cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height

  let region: RegionRect | null = null
  for (const r of regions) {
    if (!hits(r)) continue
    if (!region || r.dbId > region.dbId) region = r
  }
  if (region) {
    if (source.kind === "member" && region.dbId === source.regionDbId) {
      return { type: "same" }
    }
    if (region.kind === "custom") {
      return { type: "region", regionDbId: region.dbId }
    }
    return { type: "canvas", x: pos.x, y: pos.y }
  }

  let pin: PinRect | null = null
  for (const p of pins) {
    if (source.kind === "pin" && p.dbId === source.pinDbId) continue
    if (p.conversationId === source.conversationId) continue
    if (!hits(p)) continue
    if (!pin || p.dbId > pin.dbId) pin = p
  }
  if (pin) {
    return {
      type: "merge",
      targetPinDbId: pin.dbId,
      targetConversationId: pin.conversationId,
      // The frame grows AROUND the stationary card, the way an iPhone folder
      // opens around the icon you dropped onto — and it is exactly the region
      // the drop will create, so the preview is the commitment.
      rect: {
        x: pin.x - REGION_PADDING,
        y: pin.y - REGION_HEADER_HEIGHT - REGION_PADDING,
        width: regionWidthForColumns(2),
        height: regionHeightForRows(1),
      },
    }
  }
  return { type: "canvas", x: pos.x, y: pos.y }
}

/** The box a node actually occupies on screen, which is not always the box in
 *  its DB row — see `renderedSizes`. */
export interface CanvasSize {
  width: number
  height: number
}

// ─── Drag alignment ───

/** One drawn guide: the line everything snapped to, and how far it reaches. */
export interface AlignmentGuide {
  /** `x` = a vertical line at `at`; `y` = a horizontal one. */
  axis: "x" | "y"
  at: number
  /** Span along the OTHER axis, so the line only covers the elements it
   *  relates — a full-viewport rule says nothing about what lined up. */
  from: number
  to: number
}

export interface AlignmentResult {
  /** Correction to apply to the moving rect, 0 when nothing was in range. */
  dx: number
  dy: number
  guides: AlignmentGuide[]
}

const NO_ALIGNMENT: AlignmentResult = { dx: 0, dy: 0, guides: [] }

/** The three lines an edge can align to, per axis. */
function edgesX(r: CanvasRect): number[] {
  return [r.x, r.x + r.width / 2, r.x + r.width]
}
function edgesY(r: CanvasRect): number[] {
  return [r.y, r.y + r.height / 2, r.y + r.height]
}

/**
 * Figma-style alignment for a dragged element: find the nearest edge or centre
 * line within `tolerance` on each axis, return the nudge that lands on it plus
 * the guides to draw.
 *
 * Each axis is decided independently — a card can snap its left edge to one
 * neighbour while its top edge lines up with another, which is the whole point
 * of guides over a grid. Ties go to the smallest correction, so the element
 * moves as little as the alignment allows.
 *
 * `tolerance` is in FLOW units and the caller is expected to divide the screen
 * distance it wants by the current zoom: a fixed flow tolerance would feel
 * sticky when zoomed in and unreachable when zoomed out, because the same 6px
 * of pointer travel covers a different amount of board.
 *
 * `gridGap` adds the board's dot lattice as a per-axis FALLBACK: an axis that
 * found nothing to align to lands its leading edge on the nearest dot instead
 * of nowhere in particular. Elements win over dots because the user put the
 * elements there; the dots are what's left when there is nothing else, which is
 * most of an infinite board.
 */
export function computeAlignment(
  moving: CanvasRect,
  others: readonly CanvasRect[],
  tolerance: number,
  gridGap?: number
): AlignmentResult {
  // `!(> 0)` rather than `<= 0`: a NaN tolerance (a zoom that hasn't been read
  // yet divides into one) would pass every comparison below and snap the
  // element to the first candidate it saw.
  if (!(tolerance > 0)) return NO_ALIGNMENT
  if (others.length === 0 && !(gridGap && gridGap > 0)) return NO_ALIGNMENT

  let bestX: { delta: number; at: number; other: CanvasRect } | null = null
  let bestY: { delta: number; at: number; other: CanvasRect } | null = null

  for (const other of others) {
    for (const from of edgesX(moving)) {
      for (const to of edgesX(other)) {
        const delta = to - from
        if (Math.abs(delta) > tolerance) continue
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
          bestX = { delta, at: to, other }
        }
      }
    }
    for (const from of edgesY(moving)) {
      for (const to of edgesY(other)) {
        const delta = to - from
        if (Math.abs(delta) > tolerance) continue
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
          bestY = { delta, at: to, other }
        }
      }
    }
  }

  // The lattice, on whichever axis is still free. Its own tolerance is capped
  // at a quarter of the gap: the caller's is a screen distance divided by the
  // zoom, so a board at 50% would hand over half a gap — a capture zone
  // covering the entire lattice, and no way left to put anything BETWEEN two
  // dots. A quarter caps the zone at half, which still feels magnetic.
  const gridDx =
    gridGap && gridGap > 0 && !bestX
      ? snapToLattice(moving.x, gridGap, Math.min(tolerance, gridGap / 4))
      : 0
  const gridDy =
    gridGap && gridGap > 0 && !bestY
      ? snapToLattice(moving.y, gridGap, Math.min(tolerance, gridGap / 4))
      : 0

  const dx = bestX?.delta ?? gridDx
  const dy = bestY?.delta ?? gridDy

  // Both guides span the box as it will FINALLY sit — with both corrections
  // applied, not just their own axis's, and a LATTICE correction on the other
  // axis counts just as much as an element one. Using a half-snapped box makes
  // a guide stop short of (or overshoot) the element it claims to touch by the
  // other axis's delta, which is exactly the case where the user is watching
  // closely.
  const snapped: CanvasRect = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides: AlignmentGuide[] = []
  if (bestX) {
    guides.push({
      axis: "x",
      at: bestX.at,
      from: Math.min(snapped.y, bestX.other.y),
      to: Math.max(
        snapped.y + snapped.height,
        bestX.other.y + bestX.other.height
      ),
    })
  }
  if (bestY) {
    guides.push({
      axis: "y",
      at: bestY.at,
      from: Math.min(snapped.x, bestY.other.x),
      to: Math.max(
        snapped.x + snapped.width,
        bestY.other.x + bestY.other.width
      ),
    })
  }
  // No guide for a lattice snap: the dots are already drawn, and a hairline to
  // one of them would be a line the user cannot act on.
  return { dx, dy, guides }
}

/** Nudge onto the nearest multiple of `gap`, or 0 if the nearest one is further
 *  than `tolerance` away. */
function snapToLattice(value: number, gap: number, tolerance: number): number {
  if (!(tolerance > 0)) return 0
  const delta = Math.round(value / gap) * gap - value
  return Math.abs(delta) <= tolerance ? delta : 0
}

/**
 * Shelf-packing auto-arrange: sort by height (regions first, tallest first),
 * fill left-to-right shelves up to a target row width, top-align each shelf.
 * Returns only the nodes that actually move.
 *
 * Both axes come from `renderedSizes`, never from the row. The stored geometry
 * is regularly NOT what is on screen: an expanded card renders 520 wide while
 * its row still holds the 224 summary footprint, and a region with a pinned
 * grid shape derives its width from that shape and overrides the stored one.
 * Packing against the row reserved the smaller box and the bigger one then
 * overlapped its neighbour — which is what "auto-arrange overlaps" was.
 */
export function packLayout(
  nodes: CanvasNode[],
  renderedSizes: ReadonlyMap<number, CanvasSize>,
  opts: { gap?: number; rowWidth?: number } = {}
): CanvasNodeMovePayload[] {
  const gap = opts.gap ?? 48
  const rowWidth = opts.rowWidth ?? 2400
  const sizeOf = (node: CanvasNode): CanvasSize =>
    renderedSizes.get(node.id) ?? { width: node.width, height: node.height }
  const sorted = [...nodes].sort((a, b) => {
    const ha = sizeOf(a).height
    const hb = sizeOf(b).height
    if (ha !== hb) return hb - ha
    return a.id - b.id
  })
  const moves: CanvasNodeMovePayload[] = []
  let shelfX = 0
  let shelfY = 0
  let shelfHeight = 0
  for (const node of sorted) {
    const { width, height } = sizeOf(node)
    if (shelfX > 0 && shelfX + width > rowWidth) {
      shelfY += shelfHeight + gap
      shelfX = 0
      shelfHeight = 0
    }
    if (node.x !== shelfX || node.y !== shelfY) {
      moves.push({ id: node.id, x: shelfX, y: shelfY })
    }
    shelfX += width + gap
    shelfHeight = Math.max(shelfHeight, height)
  }
  return moves
}

// ─── ReactFlow graph derivation ───

export interface RegionNodeData {
  dbNode: CanvasNode
  /** Total members the region resolves to (visible cards may be capped). */
  memberTotal: number
  /** Cards actually laid out right now — `memberTotal - visibleCount` is what
   *  the "+N" footer offers, and the cap depends on the region's grid shape, so
   *  the component must not recompute it from a constant. */
  visibleCount: number
  /** Members currently `in_progress` — the header's running badge. */
  runningCount: number
  unresolved: boolean
  /** The height the region actually renders at (grid growth / collapse). */
  renderedHeight: number
  [key: string]: unknown
}

export interface ConversationCardData {
  conversation: DbConversationSummary | null
  conversationId: number
  /** Set on derived member cards: the region that owns the grid slot. */
  regionDbId?: number
  /** Set alongside `regionDbId`. Only a custom region has a member LIST to
   *  remove from — every other kind computes its members from a live binding,
   *  so offering "remove from region" there is offering a button that can only
   *  fail. */
  regionOwnsMembers?: boolean
  /** The colour this card wears, whatever its source: a pinned card's own row
   *  (`canvas_node.color`, which every kind has), or — for a member card — the
   *  region that holds it, since a region's colour tints everything inside it
   *  and member cards are separate RF nodes rather than children of the
   *  region's DOM. A member has no row of its own to colour, which is also why
   *  the dock only offers the palette on a pinned card. */
  color?: string | null
  /** The conversation's folder, resolved for display: a worktree shows its
   *  parent repo's name, so the card reads "repo + branch" the way the composer
   *  row does. `null` for a folderless chat conversation (its hidden chat folder
   *  is an implementation detail, not a place). Resolved here rather than in the
   *  card because the derivation already holds the folder list — a card per
   *  conversation subscribing to the workspace store would not scale. */
  folderName?: string | null
  /** Set on top-level pinned cards: the backing DB row id. */
  pinDbId?: number
  unresolved: boolean
  [key: string]: unknown
}

export interface NoteNodeData {
  dbNode: CanvasNode
  [key: string]: unknown
}

/** A read-only view of one file on disk. `path` is lifted out of the row (and
 *  narrowed to a string) because it is the card's identity — every read, the
 *  watch join and the "open in workspace" hand-off key on it — and a row that
 *  somehow lost it has nothing to render. */
export interface FileNodeData {
  dbNode: CanvasNode
  path: string
  /** Basename, or the user's own title when they renamed the card. */
  label: string
  [key: string]: unknown
}

/** A shell running on the board. `workingDir` is where it is spawned; the PTY
 *  itself is runtime state keyed off the row id (see `canvasTerminalId`), so
 *  nothing about the process is persisted. */
export interface TerminalNodeData {
  dbNode: CanvasNode
  workingDir: string
  label: string
  [key: string]: unknown
}

/** The PTY id a terminal card owns. Derived from the row id so the same card
 *  re-attaches to the same shell after its host view unmounts (leaving the
 *  canvas route) — and so two windows showing one board share one terminal
 *  rather than racing to spawn two. */
export function canvasTerminalId(dbId: number): string {
  return `canvas-term-${dbId}`
}

/** Last segment of a filesystem path, both separators honoured (a Windows path
 *  reaches this layer verbatim), trailing separators ignored. Falls back to the
 *  whole string so a card is never labelled with an empty line. */
export function basePathName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return (index >= 0 ? trimmed.slice(index + 1) : trimmed) || path
}

/** Whether a node kind lays out a member grid — i.e. whether a resize should
 *  quantize to whole cards. One predicate for the derive layer and the view's
 *  resize handler, which must agree or a file card would snap to a
 *  conversation grid. Mirrors `CanvasNodeKind::is_region` in Rust. */
export function isRegionKind(kind: CanvasNode["kind"]): boolean {
  return (
    kind === "folder" ||
    kind === "group" ||
    kind === "agent" ||
    kind === "custom"
  )
}

/**
 * Whether deleting this row would destroy prose the user typed by hand.
 *
 * The board has no undo, so every delete path stops to ask when it would take
 * one of these — and only then. Everything else on the canvas is an
 * ARRANGEMENT of something that lives elsewhere: removing a card unpins a
 * conversation, removing a region unframes it, and the conversation itself is
 * untouched either way. A note is the one node whose content exists nowhere
 * but the note. An empty one is a blank sheet and carries nothing to lose.
 *
 * Takes the DB row rather than a rendered node so both delete paths ask the
 * identical question. The dock's per-node delete only ever has an id, and the
 * rendered note carries its text as draft state that lags the row anyway — so
 * the store is the one place both can look, and `notesAtRisk` is where they do.
 */
export function noteHoldsProse(
  dbNode: Pick<CanvasNode, "kind" | "content"> | undefined
): boolean {
  if (dbNode?.kind !== "note") return false
  return (dbNode.content ?? "").trim() !== ""
}

/** ReactFlow-compatible node shape (structurally a subset of RF's `Node`,
 *  kept RF-import-free so the derivation stays a plain testable function). */
export interface CanvasFlowNode {
  id: string
  type:
    | "region"
    | "conversationCard"
    | "conversationDetail"
    | "note"
    | "file"
    | "terminal"
  position: { x: number; y: number }
  parentId?: string
  data:
    | RegionNodeData
    | ConversationCardData
    | NoteNodeData
    | FileNodeData
    | TerminalNodeData
  width?: number
  height?: number
  draggable?: boolean
  selectable?: boolean
  /** CSS selector of the node's drag handle. Set on live-conversation cards so
   *  only their title bar drags: the body has to stay a normal document you can
   *  select text in and click into. */
  dragHandle?: string
}

export interface DeriveFlowInput {
  dbNodes: Iterable<CanvasNode>
  conversations: DbConversationSummary[]
  allFolders: FolderDetail[]
  /** Sidebar folder groups, for resolving `kind=group` regions. Optional so
   *  existing callers/tests that have no group regions stay valid. */
  folderGroups?: FolderGroupDetail[]
  /** Regions whose "+N" expander is open (UI state, never persisted). */
  expandedRegions: ReadonlySet<number>
  /**
   * Transient drag positions keyed by RF node id — the dragged node's position
   * is ALWAYS taken from here while a drag is live, so remote updates cannot
   * yank the card out from under the pointer. Member positions are relative to
   * their region (RF child-node semantics), top-level ones absolute.
   */
  overlay: ReadonlyMap<string, { x: number; y: number }>
  /**
   * Member snapshot taken at drag start, per region: while a member card is
   * dragging, its region's grid is laid out from this frozen list so a remote
   * membership change cannot reflow the grid mid-drag (the store still
   * updates; the reflow lands at drag stop when the freeze clears).
   */
  frozenMembers: ReadonlyMap<number, number[]> | null
  /**
   * Transient resize dimensions keyed by RF node id (NodeResizer feed). Like
   * `overlay`, wins over stored width/height while the handles are live;
   * cleared by the resize-end commit.
   */
  sizeOverlay?: ReadonlyMap<string, { width: number; height: number }>
  /**
   * Pinned conversation nodes (by db id) rendered as a full inline conversation
   * instead of a summary tile. Client-local UI state, exactly like
   * `expandedRegions` — a detail card is a way of LOOKING at the canvas, not a
   * property of the board every other client should inherit.
   *
   * Only top-level pins can carry it: a 520×560 surface inside a region's
   * uniform grid would tear the row apart, so expanding a MEMBER card detaches
   * it into a pin first (`canvas_detach_member`) and expands that.
   */
  detailCards?: ReadonlySet<number>
}

export interface DeriveFlowResult {
  nodes: CanvasFlowNode[]
  /** Absolute region rects for drop classification, in derive order. */
  regionRects: RegionRect[]
  /** Absolute rects of the loose SUMMARY cards — the merge targets for the
   *  card-onto-card gesture. Expanded cards are left out on purpose. */
  pinRects: PinRect[]
  /** Rendered (not stored) boxes, for shelf packing. Both axes: an expanded
   *  card and a grid-shaped region both render at a size their row doesn't
   *  hold. */
  renderedSizes: Map<number, CanvasSize>
}

/**
 * DB nodes + live workspace state → the full RF node array. Output order is
 * regions/notes/pins by ascending db id, then member cards — RF requires a
 * parent before its children, and ascending id doubles as the paint order that
 * `computeDropHint` mirrors (highest id wins a hit).
 */
export function deriveFlowGraph(input: DeriveFlowInput): DeriveFlowResult {
  const {
    dbNodes,
    conversations,
    allFolders,
    folderGroups,
    expandedRegions,
    overlay,
    frozenMembers,
    sizeOverlay,
    detailCards,
  } = input
  const conversationsById = new Map(conversations.map((c) => [c.id, c]))
  const foldersById = new Map(allFolders.map((f) => [f.id, f]))
  const folderGroupsById = folderGroups
    ? new Map(folderGroups.map((g) => [g.id, g]))
    : undefined

  /** The folder label a summary card puts in its footer — see
   *  `ConversationCardData.folderName`. */
  const cardFolderName = (
    conversation: DbConversationSummary | null
  ): string | null => {
    if (!conversation) return null
    const folder = foldersById.get(conversation.folder_id)
    // A chat conversation's folder is a hidden bookkeeping row, not a place the
    // user chose — the composer's own picker calls this state "chat mode" and
    // shows no folder either.
    if (!folder || folder.kind === "chat") return null
    return resolveFolderDisplayName(folder, allFolders)
  }

  const sorted = [...dbNodes].sort((a, b) => a.id - b.id)
  const topNodes: CanvasFlowNode[] = []
  const memberNodes: CanvasFlowNode[] = []
  const regionRects: RegionRect[] = []
  const pinRects: PinRect[] = []
  const renderedSizes = new Map<number, CanvasSize>()

  for (const dbNode of sorted) {
    const rfId = regionNodeId(dbNode.id)
    const dragPos = overlay.get(rfId)
    const position = dragPos ?? { x: dbNode.x, y: dbNode.y }
    const liveSize = sizeOverlay?.get(rfId)

    if (dbNode.kind === "note") {
      const width = liveSize?.width ?? dbNode.width
      const height = liveSize?.height ?? dbNode.height
      renderedSizes.set(dbNode.id, { width, height })
      topNodes.push({
        id: rfId,
        type: "note",
        position,
        width,
        height,
        data: { dbNode } satisfies NoteNodeData,
      })
      continue
    }

    // File and terminal cards hold a real document / a real shell, so — like
    // the expanded conversation card — only their title bar may drag. Without
    // `dragHandle` d3-drag installs a window-level `selectstart` preventDefault
    // on every mousedown inside the node, and the browser asks THAT event
    // whether a click may move the caret: the terminal would take focus without
    // taking the cursor, and no text in either card could be selected.
    if (dbNode.kind === "file" || dbNode.kind === "terminal") {
      const width = liveSize?.width ?? dbNode.width
      const height = liveSize?.height ?? dbNode.height
      renderedSizes.set(dbNode.id, { width, height })
      // A row that lost its path renders as unavailable rather than vanishing —
      // the same soft-reference stance the folder and conversation bindings
      // take, and the user needs something on the board to delete.
      const path = dbNode.path ?? ""
      const label = dbNode.title?.trim() || basePathName(path)
      topNodes.push({
        id: rfId,
        type: dbNode.kind === "file" ? "file" : "terminal",
        position,
        width,
        height,
        dragHandle: DRAG_HANDLE_SELECTOR,
        data:
          dbNode.kind === "file"
            ? ({ dbNode, path, label } satisfies FileNodeData)
            : ({
                dbNode,
                workingDir: path,
                label,
              } satisfies TerminalNodeData),
      })
      continue
    }

    if (dbNode.kind === "conversation") {
      const conversation =
        dbNode.conversation_id != null
          ? (conversationsById.get(dbNode.conversation_id) ?? null)
          : null
      const unresolvedPin = isUnresolvedBinding(
        dbNode,
        conversationsById,
        foldersById,
        folderGroupsById
      )
      // A card with no conversation left to show has nothing to expand INTO —
      // it renders the "removed" shell either way, at the summary footprint.
      const detail = !unresolvedPin && (detailCards?.has(dbNode.id) ?? false)
      // Detail cards keep the user's own size once they've resized one; until
      // then the stored geometry is still the summary footprint, which would
      // render the conversation in a 224×132 slot.
      const width = detail
        ? dbNode.width > CARD_WIDTH
          ? (liveSize?.width ?? dbNode.width)
          : (liveSize?.width ?? DETAIL_CARD_WIDTH)
        : CARD_WIDTH
      const height = detail
        ? dbNode.height > CARD_HEIGHT
          ? (liveSize?.height ?? dbNode.height)
          : (liveSize?.height ?? DETAIL_CARD_HEIGHT)
        : CARD_HEIGHT
      renderedSizes.set(dbNode.id, { width, height })
      topNodes.push({
        id: rfId,
        type: detail ? "conversationDetail" : "conversationCard",
        position,
        width,
        height,
        dragHandle: detail ? DRAG_HANDLE_SELECTOR : undefined,
        data: {
          conversation,
          conversationId: dbNode.conversation_id ?? -1,
          pinDbId: dbNode.id,
          color: dbNode.color,
          folderName: cardFolderName(conversation),
          unresolved: unresolvedPin,
        } satisfies ConversationCardData,
      })
      if (!detail && conversation) {
        pinRects.push({
          dbId: dbNode.id,
          conversationId: conversation.id,
          x: position.x,
          y: position.y,
          width,
          height,
        })
      }
      continue
    }

    // Region kinds: folder / group / agent / custom.
    const unresolved = isUnresolvedBinding(
      dbNode,
      conversationsById,
      foldersById,
      folderGroupsById
    )
    const frozen = frozenMembers?.get(dbNode.id)
    // An unresolved binding shows the hint state, never cards — stale member
    // rows would paint right over it.
    const members = unresolved
      ? []
      : frozen
        ? frozen
            .map((id) => conversationsById.get(id))
            .filter((c): c is DbConversationSummary => c != null)
        : computeRegionMembers(dbNode, conversations, allFolders)
    const expanded = expandedRegions.has(dbNode.id)
    // A pinned column count OWNS the frame width: a stored width that drifted
    // from it (menu change, older row, another client) would lay out N columns
    // inside a frame sized for something else — which is exactly how cards end
    // up spilling past the border. A live resize still wins, because the view
    // quantizes it to whole columns before it ever gets here.
    const regionWidth =
      liveSize?.width ??
      (dbNode.grid_columns > 0
        ? regionWidthForColumns(dbNode.grid_columns)
        : dbNode.width)
    // Mid-resize the drag is the truth (quantized upstream); at rest the pinned
    // count is.
    const columns = liveSize
      ? columnsForRegionWidth(regionWidth)
      : effectiveColumns(dbNode, regionWidth)
    const cap = visibleMemberCap(dbNode, columns)
    const visible =
      expanded || dbNode.collapsed ? members : members.slice(0, cap)
    const shown = dbNode.collapsed ? [] : visible
    const grid = layoutRegionGrid(shown.length, regionWidth, columns)
    // The "+N" bar is a real row of chrome at the bottom, not an overlay —
    // reserve its height so it can never sit on top of the last card row.
    const footerPad =
      !dbNode.collapsed && !expanded && members.length > cap
        ? REGION_FOOTER_HEIGHT
        : 0
    // With rows pinned the frame keeps its declared shape even while
    // under-filled — a "3 × 2 region" that holds one conversation still reads
    // as a 3 × 2 region.
    const declaredHeight =
      dbNode.grid_rows > 0
        ? regionHeightForRows(dbNode.grid_rows) + footerPad
        : 0
    const renderedHeight = dbNode.collapsed
      ? REGION_COLLAPSED_HEIGHT
      : Math.max(
          liveSize?.height ?? dbNode.height,
          grid.contentHeight + footerPad,
          declaredHeight
        )
    renderedSizes.set(dbNode.id, {
      width: regionWidth,
      height: renderedHeight,
    })

    let runningCount = 0
    for (const m of members) {
      if (m.status === "in_progress") runningCount++
    }

    topNodes.push({
      id: rfId,
      type: "region",
      position,
      width: regionWidth,
      height: renderedHeight,
      data: {
        dbNode,
        memberTotal: members.length,
        visibleCount: shown.length,
        runningCount,
        unresolved,
        renderedHeight,
      } satisfies RegionNodeData,
    })
    regionRects.push({
      dbId: dbNode.id,
      kind: dbNode.kind,
      x: position.x,
      y: position.y,
      width: regionWidth,
      height: renderedHeight,
    })

    for (let i = 0; i < shown.length; i++) {
      const conversation = shown[i]
      const mid = memberNodeId(dbNode.id, conversation.id)
      const dragged = overlay.get(mid)
      memberNodes.push({
        id: mid,
        type: "conversationCard",
        position: dragged ?? grid.positions[i],
        parentId: rfId,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        data: {
          conversation,
          conversationId: conversation.id,
          regionDbId: dbNode.id,
          regionOwnsMembers: dbNode.kind === "custom",
          color: dbNode.color,
          folderName: cardFolderName(conversation),
          unresolved: false,
        } satisfies ConversationCardData,
      })
    }
  }

  return {
    nodes: [...topNodes, ...memberNodes],
    regionRects,
    pinRects,
    renderedSizes,
  }
}

/** Seed layout for the empty-canvas CTA: one folder region per open workspace
 *  folder, shelf-packed with a uniform footprint. */
export function seedRegionsFromFolders(
  folders: FolderDetail[]
): { folderId: number; x: number; y: number; width: number; height: number }[] {
  const width = 3 * CARD_WIDTH + 2 * CARD_GAP + 2 * REGION_PADDING
  const height =
    REGION_HEADER_HEIGHT + 2 * REGION_PADDING + 2 * CARD_HEIGHT + CARD_GAP
  const perRow = 2
  return folders.map((f, i) => ({
    folderId: f.id,
    x: (i % perRow) * (width + 48),
    y: Math.floor(i / perRow) * (height + 48),
    width,
    height,
  }))
}
