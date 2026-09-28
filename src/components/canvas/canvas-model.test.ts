import { describe, expect, it } from "vitest"
import type {
  CanvasNode,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"
import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  DRAG_HANDLE_SELECTOR,
  FILE_CARD_HEIGHT,
  FILE_CARD_WIDTH,
  MAX_VISIBLE_MEMBERS,
  REGION_COLLAPSED_HEIGHT,
  REGION_FOOTER_HEIGHT,
  REGION_HEADER_HEIGHT,
  REGION_PADDING,
  computeDropHint,
  columnsForRegionWidth,
  regionHeightForRows,
  regionWidthForColumns,
  rowsForRegionHeight,
  BOARD_DOT_GAP,
  basePathName,
  canvasTerminalId,
  compareByRecency,
  computeAlignment,
  computeRegionMembers,
  deriveFlowGraph,
  isRegionKind,
  layoutRegionGrid,
  noteHoldsProse,
  memberNodeId,
  packLayout,
  parseMemberNodeId,
  parseRegionNodeId,
  regionNodeId,
  resolveNewConversationTarget,
  type CanvasDragSource,
  type ConversationCardData,
  type FileNodeData,
  type RegionNodeData,
  type TerminalNodeData,
} from "./canvas-model"

/** Every card on the board renders at the fixed summary footprint. */
const CARD_BOX = { width: CARD_WIDTH, height: CARD_HEIGHT }

function conv(
  id: number,
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `conv ${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T10:00:00Z",
    pinned_at: null,
    ...over,
  }
}

function folder(id: number, over: Partial<FolderDetail> = {}): FolderDetail {
  return {
    id,
    name: `folder-${id}`,
    path: `/tmp/folder-${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-08-30T00:00:00Z",
    sort_order: id,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    ...over,
  } as FolderDetail
}

function node(id: number, over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    kind: "custom",
    folder_id: null,
    folder_group_id: null,
    agent_type: null,
    conversation_id: null,
    member_ids: [],
    title: null,
    content: null,
    path: null,
    color: null,
    collapsed: false,
    grid_columns: 0,
    grid_rows: 0,
    x: 0,
    y: 0,
    width: 720,
    height: 344,
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    ...over,
  }
}

const NO_DRAG = {
  expandedRegions: new Set<number>(),
  overlay: new Map<string, { x: number; y: number }>(),
  frozenMembers: null,
}

describe("noteHoldsProse — what the delete gestures stop to ask about", () => {
  it("is true only for a note that actually holds text", () => {
    expect(
      noteHoldsProse(node(1, { kind: "note", content: "worth keeping" }))
    ).toBe(true)
    // An empty sheet carries nothing the user typed, and asking about it would
    // train the reflex the prompt exists to interrupt.
    expect(noteHoldsProse(node(1, { kind: "note", content: null }))).toBe(false)
    expect(noteHoldsProse(node(1, { kind: "note", content: "" }))).toBe(false)
    expect(noteHoldsProse(node(1, { kind: "note", content: "  \n\t " }))).toBe(
      false
    )
  })

  it("is false for every node whose content lives somewhere else", () => {
    // Deleting these unpins or unframes; the conversation itself survives, so
    // there is nothing here a confirmation could save. A region is not a note
    // however much text it carries.
    expect(noteHoldsProse(node(2, { kind: "custom", content: "x" }))).toBe(
      false
    )
    expect(noteHoldsProse(node(3, { kind: "folder", content: "x" }))).toBe(
      false
    )
    expect(
      noteHoldsProse(node(4, { kind: "conversation", content: "x" }))
    ).toBe(false)
  })

  it("is false for a row the store does not have", () => {
    // Both delete paths look the row up by id, and a node deleted underneath
    // us (remote delete, stale selection) is nothing left to protect.
    expect(noteHoldsProse(undefined)).toBe(false)
  })
})

describe("node id codecs", () => {
  it("round-trips region and member ids", () => {
    expect(parseRegionNodeId(regionNodeId(42))).toBe(42)
    expect(parseMemberNodeId(memberNodeId(3, 99))).toEqual({
      regionDbId: 3,
      conversationId: 99,
    })
    expect(parseRegionNodeId("member-3-99")).toBeNull()
    expect(parseMemberNodeId("region-42")).toBeNull()
  })
})

describe("computeRegionMembers", () => {
  it("folder regions merge the bound folder with its direct worktree children", () => {
    const folders = [
      folder(1),
      folder(2, { parent_id: 1 }), // direct worktree child → merged
      folder(3, { parent_id: 2 }), // flattened parent_id points at 1 in prod;
      // here it points elsewhere, so it must NOT be merged
    ]
    const conversations = [
      conv(10, { folder_id: 1 }),
      conv(11, { folder_id: 2 }),
      conv(12, { folder_id: 3 }),
    ]
    const members = computeRegionMembers(
      node(1, { kind: "folder", folder_id: 1 }),
      conversations,
      folders
    )
    expect(members.map((m) => m.id).sort()).toEqual([10, 11])
  })

  it("a region bound to a worktree child shows only that child", () => {
    const folders = [folder(1), folder(2, { parent_id: 1 })]
    const conversations = [
      conv(10, { folder_id: 1 }),
      conv(11, { folder_id: 2 }),
    ]
    const members = computeRegionMembers(
      node(1, { kind: "folder", folder_id: 2 }),
      conversations,
      folders
    )
    expect(members.map((m) => m.id)).toEqual([11])
  })

  it("excludes delegation children and loop rows everywhere", () => {
    const conversations = [
      conv(10),
      conv(11, { kind: "delegate" }),
      conv(12, { kind: "loop" }),
      conv(13, { parent_id: 10 }),
    ]
    const members = computeRegionMembers(
      node(1, { kind: "agent", agent_type: "claude_code" }),
      conversations,
      [folder(1)]
    )
    expect(members.map((m) => m.id)).toEqual([10])
  })

  it("custom regions resolve pinned ids and drop stale ones, recency-sorted", () => {
    const conversations = [
      conv(10, { updated_at: "2026-08-30T09:00:00Z" }),
      conv(11, { updated_at: "2026-08-30T11:00:00Z" }),
    ]
    const members = computeRegionMembers(
      node(1, { kind: "custom", member_ids: [10, 999, 11] }),
      conversations,
      []
    )
    expect(members.map((m) => m.id)).toEqual([11, 10])
  })

  it("orders by (updated_at desc, id desc) — id breaks timestamp ties", () => {
    const same = "2026-08-30T10:00:00Z"
    const list = [conv(1, { updated_at: same }), conv(2, { updated_at: same })]
    expect([...list].sort(compareByRecency).map((c) => c.id)).toEqual([2, 1])
  })
})

describe("layoutRegionGrid", () => {
  it("computes columns from the region width and wraps rows", () => {
    // 720 wide → usable 696 → floor((696+12)/236) = 3 columns.
    const grid = layoutRegionGrid(5, 720)
    expect(grid.columns).toBe(3)
    expect(grid.positions[0]).toEqual({
      x: REGION_PADDING,
      y: REGION_HEADER_HEIGHT + REGION_PADDING,
    })
    expect(grid.positions[3].y).toBe(
      REGION_HEADER_HEIGHT + REGION_PADDING + CARD_HEIGHT + CARD_GAP
    )
    expect(grid.contentHeight).toBe(
      REGION_HEADER_HEIGHT + 2 * REGION_PADDING + 2 * CARD_HEIGHT + CARD_GAP
    )
  })

  it("never returns fewer than one column", () => {
    expect(layoutRegionGrid(2, 10).columns).toBe(1)
  })
})

describe("computeDropHint", () => {
  const regions = [
    { dbId: 1, kind: "custom" as const, x: 0, y: 0, width: 400, height: 300 },
    { dbId: 2, kind: "folder" as const, x: 600, y: 0, width: 400, height: 300 },
    // Overlaps region 1; higher id = painted on top, must win the hit.
    { dbId: 3, kind: "custom" as const, x: 200, y: 0, width: 400, height: 300 },
  ]
  const pins = [
    { dbId: 10, conversationId: 100, x: 1400, y: 700, ...CARD_BOX },
    { dbId: 11, conversationId: 101, x: 2000, y: 700, ...CARD_BOX },
  ]
  const member: CanvasDragSource = {
    kind: "member",
    regionDbId: 1,
    conversationId: 7,
  }
  const pin: CanvasDragSource = {
    kind: "pin",
    pinDbId: 11,
    conversationId: 101,
  }

  it("open canvas → the drop point, wherever the card came from", () => {
    expect(computeDropHint(member, { x: 1500, y: 1500 }, regions, [])).toEqual({
      type: "canvas",
      x: 1500,
      y: 1500,
    })
    expect(computeDropHint(pin, { x: 1500, y: 1500 }, regions, [])).toEqual({
      type: "canvas",
      x: 1500,
      y: 1500,
    })
  })

  it("hit on the source region → same (snap back)", () => {
    // Card center at (-50+112, 20+66) — inside region 1 only.
    expect(computeDropHint(member, { x: -50, y: 20 }, regions, [])).toEqual({
      type: "same",
    })
  })

  it("hit on another custom region → that region; topmost id wins overlap", () => {
    // Center lands where regions 1 and 3 overlap → 3 wins.
    expect(computeDropHint(member, { x: 200, y: 50 }, regions, [])).toEqual({
      type: "region",
      regionDbId: 3,
    })
    // A loose card gets the same target — that's how it joins a region.
    expect(computeDropHint(pin, { x: 200, y: 50 }, regions, [])).toEqual({
      type: "region",
      regionDbId: 3,
    })
  })

  it("hit on a binding region → a plain move, not a rejection", () => {
    // Folder/agent members are computed: there is nothing to drop INTO, and
    // snapping the card back would read as a broken drag.
    expect(computeDropHint(member, { x: 700, y: 50 }, regions, [])).toEqual({
      type: "canvas",
      x: 700,
      y: 50,
    })
  })

  it("card over card → a two-column frame anchored on the STATIONARY card", () => {
    // Dragged card's centre inside pin 10.
    const hint = computeDropHint(member, { x: 1450, y: 720 }, regions, pins)
    expect(hint).toEqual({
      type: "merge",
      targetPinDbId: 10,
      targetConversationId: 100,
      rect: {
        x: 1400 - REGION_PADDING,
        y: 700 - REGION_HEADER_HEIGHT - REGION_PADDING,
        width: regionWidthForColumns(2),
        height: regionHeightForRows(1),
      },
    })
  })

  it("never merges a card with itself or with its own conversation", () => {
    // Pin 11 dragged onto its own slot, and a member card of the SAME
    // conversation dropped on pin 11's mirror: both are no-ops, not a region
    // holding one conversation twice.
    expect(computeDropHint(pin, { x: 2050, y: 720 }, regions, pins)).toEqual({
      type: "canvas",
      x: 2050,
      y: 720,
    })
    const mirror: CanvasDragSource = {
      kind: "member",
      regionDbId: 1,
      conversationId: 101,
    }
    expect(computeDropHint(mirror, { x: 2050, y: 720 }, regions, pins)).toEqual(
      {
        type: "canvas",
        x: 2050,
        y: 720,
      }
    )
  })

  it("a card inside a region is never a merge target", () => {
    // Region 1 covers the point; the loose card sitting under it loses.
    // Centre at (132, 126): inside region 1 only, and right on top of a loose
    // card — the region still wins, so a card can never be merged through a
    // frame that already owns that space.
    const covered = [
      { dbId: 12, conversationId: 102, x: 20, y: 60, ...CARD_BOX },
    ]
    expect(computeDropHint(pin, { x: 20, y: 60 }, regions, covered)).toEqual({
      type: "region",
      regionDbId: 1,
    })
  })
})

describe("computeAlignment", () => {
  const box = (x: number, y: number, width = 100, height = 100) => ({
    x,
    y,
    width,
    height,
  })

  it("reports nothing when every line is out of range", () => {
    const r = computeAlignment(box(0, 0), [box(500, 500)], 6)
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it("snaps a near-miss left edge onto its neighbour's", () => {
    // 4px shy of sharing a left edge, inside a 6px tolerance.
    const r = computeAlignment(box(196, 400), [box(200, 0)], 6)
    expect(r.dx).toBe(4)
    expect(r.guides).toContainEqual({
      axis: "x",
      at: 200,
      // Spans both boxes, so the line visibly touches what it aligned.
      from: 0,
      to: 500,
    })
  })

  it("aligns the two axes independently, against different neighbours", () => {
    // Left edge 3 shy of the first neighbour's, top edge 3 past the second's:
    // both correct, each against a different box. This is what guides buy over
    // a grid — an element can line up with two different things at once.
    const r = computeAlignment(box(197, 303), [box(200, 0), box(900, 300)], 6)
    expect(r.dx).toBe(3)
    expect(r.dy).toBe(-3)
    expect(r.guides.map((g) => `${g.axis}@${g.at}`)).toEqual(["x@200", "y@300"])
  })

  it("ignores a tolerance that isn't a positive number", () => {
    // A zoom read before the viewport settles divides into NaN; every
    // comparison against it is false, which would otherwise mean "in range".
    const r = computeAlignment(box(0, 0), [box(9999, 9999)], Number.NaN)
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it("takes the SMALLEST correction when several lines are in range", () => {
    // Left edge 5 away, centre 1 away: the centre wins, because a snap should
    // move the element as little as the alignment allows.
    const r = computeAlignment(box(0, 0, 100, 100), [box(5, 900, 100, 100)], 6)
    expect(r.dx).toBe(5)
    const closer = computeAlignment(
      box(0, 0, 100, 100),
      [box(5, 900, 100, 100), box(1, 900, 100, 100)],
      6
    )
    expect(closer.dx).toBe(1)
  })

  it("centres align, not just edges", () => {
    // Moving centre 50; other centre 53 → 3 across, inside tolerance.
    const r = computeAlignment(box(0, 0, 100, 100), [box(3, 900, 100, 100)], 6)
    expect(r.dx).toBe(3)
  })

  it("does nothing without candidates or with a zero tolerance", () => {
    expect(computeAlignment(box(0, 0), [], 6).guides).toEqual([])
    expect(computeAlignment(box(196, 0), [box(200, 0)], 0).dx).toBe(0)
  })

  describe("the dot lattice", () => {
    // The board is drawn on a grid of dots (BOARD_DOT_GAP), and most of a drag
    // happens nowhere near another element. The lattice is what an axis falls
    // back to so a card put down on empty board still lands on something.

    it("snaps to the nearest dot with nothing else in range", () => {
      // 3 past a dot at 96, 4 shy of one at 216.
      const r = computeAlignment(box(99, 212), [], 6, BOARD_DOT_GAP)
      expect(r.dx).toBe(-3)
      expect(r.dy).toBe(4)
    })

    it("still snaps when there are no candidates at all", () => {
      // The empty-board case is the one that matters most, and it used to be an
      // early return.
      expect(computeAlignment(box(97, 0), [], 6, BOARD_DOT_GAP).dx).toBe(-1)
    })

    it("lets a neighbour win the axis it is on", () => {
      // Left edge 2 shy of a neighbour's AND 1 past a dot: the neighbour wins,
      // because the user put the neighbour there. The other axis is free, so it
      // still takes the lattice.
      const r = computeAlignment(box(97, 99), [box(99, 900)], 6, BOARD_DOT_GAP)
      expect(r.dx).toBe(2)
      expect(r.dy).toBe(-3)
    })

    it("draws no guide for a lattice snap", () => {
      // The dots are already on screen; a hairline to one of them would be a
      // line the user cannot act on.
      expect(
        computeAlignment(box(99, 99), [], 6, BOARD_DOT_GAP).guides
      ).toEqual([])
    })

    it("caps its reach at a quarter of the gap", () => {
      // The caller's tolerance is a screen distance over the zoom, so a board at
      // 50% hands over 12 — half a gap, which would make every point on the
      // board within reach of a dot and leave no way to sit between two. 8 away
      // from a dot must NOT snap even though the caller allowed 12.
      const r = computeAlignment(box(104, 0), [], 12, BOARD_DOT_GAP)
      expect(r.dx).toBe(0)
      // 5 away is inside the cap of 6, and still snaps.
      expect(computeAlignment(box(101, 0), [], 12, BOARD_DOT_GAP).dx).toBe(-5)
    })

    it("spans a guide across the box as the lattice will leave it", () => {
      // A guide is drawn along the axis that matched an element, but it spans
      // the OTHER axis — where a lattice snap may just have moved the box. Left
      // it out and the hairline stops short of (or runs past) the very edge it
      // claims to touch, by up to the capture distance.
      const r = computeAlignment(
        { x: 97, y: 99, width: 100, height: 100 },
        [{ x: 99, y: 400, width: 100, height: 100 }],
        6,
        BOARD_DOT_GAP
      )
      expect(r.dy).toBe(-3) // 99 → 96, the nearest dot
      expect(r.guides).toEqual([
        { axis: "x", at: 99, from: 96, to: 500 }, // 96, not 99
      ])
    })

    it("is off unless a gap is passed", () => {
      // Every other caller of this function (there is one, but still) gets the
      // old behaviour untouched.
      expect(computeAlignment(box(99, 99), [], 6).dx).toBe(0)
    })
  })
})

describe("packLayout", () => {
  it("shelves nodes tallest-first and only reports actual moves", () => {
    const a = node(1, { x: 0, y: 0, width: 1000, height: 600 })
    const b = node(2, { x: 999, y: 999, width: 1000, height: 300 })
    const c = node(3, { x: 0, y: 0, width: 1000, height: 200 })
    const moves = packLayout([a, b, c], new Map(), { gap: 50, rowWidth: 2200 })
    // a stays at (0,0) → not reported; b beside it; c wraps to a new shelf.
    expect(moves).toEqual([
      { id: 2, x: 1050, y: 0 },
      { id: 3, x: 0, y: 650 },
    ])
  })

  it("prefers rendered heights over stored ones", () => {
    const a = node(1, { width: 100, height: 100 })
    const b = node(2, { x: 500, y: 500, width: 100, height: 400 })
    // Rendered: a is actually taller → a leads the shelf order.
    const moves = packLayout(
      [a, b],
      new Map([
        [1, { width: 100, height: 800 }],
        [2, { width: 100, height: 100 }],
      ]),
      { gap: 10, rowWidth: 1000 }
    )
    expect(moves).toEqual([{ id: 2, x: 110, y: 0 }])
  })

  it("reserves the rendered WIDTH, so an expanded card can't overlap", () => {
    // The shape that made auto-arrange overlap: an expanded card renders at the
    // detail footprint while its row still holds the summary one, because the
    // user never resized it. Packing against the row put the next node 224+gap
    // away from a card 520 wide.
    const expanded = node(1, { width: CARD_WIDTH, height: CARD_HEIGHT })
    const other = node(2, { x: 900, y: 900, width: CARD_WIDTH, height: 100 })
    const moves = packLayout(
      [expanded, other],
      new Map([
        [1, { width: 520, height: 560 }],
        [2, { width: CARD_WIDTH, height: 100 }],
      ]),
      { gap: 20, rowWidth: 4000 }
    )
    expect(moves).toEqual([{ id: 2, x: 540, y: 0 }])
  })
})

describe("deriveFlowGraph", () => {
  const folders = [folder(1)]
  const conversations = [
    conv(10, { status: "in_progress", updated_at: "2026-08-30T12:00:00Z" }),
    conv(11, { updated_at: "2026-08-30T11:00:00Z" }),
  ]

  it("emits regions before member cards, members parented and grid-placed", () => {
    const region = node(1, { kind: "folder", folder_id: 1 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect(nodes.map((n) => n.type)).toEqual([
      "region",
      "conversationCard",
      "conversationCard",
    ])
    const member = nodes[1]
    expect(member.parentId).toBe(regionNodeId(1))
    expect(member.position).toEqual({
      x: REGION_PADDING,
      y: REGION_HEADER_HEIGHT + REGION_PADDING,
    })
    // Recency order: the in-progress conv 10 was updated later → first slot.
    expect((member.data as ConversationCardData).conversationId).toBe(10)
    const regionData = nodes[0].data as RegionNodeData
    expect(regionData.runningCount).toBe(1)
    expect(regionData.memberTotal).toBe(2)
  })

  it("drag overlay wins over stored/grid positions", () => {
    const region = node(1, { kind: "folder", folder_id: 1, x: 100, y: 100 })
    const overlay = new Map([
      [regionNodeId(1), { x: 500, y: 600 }],
      [memberNodeId(1, 10), { x: 42, y: 43 }],
    ])
    const { nodes, regionRects } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      expandedRegions: new Set(),
      overlay,
      frozenMembers: null,
    })
    expect(nodes[0].position).toEqual({ x: 500, y: 600 })
    expect(regionRects[0]).toMatchObject({ x: 500, y: 600 })
    const dragged = nodes.find((n) => n.id === memberNodeId(1, 10))!
    expect(dragged.position).toEqual({ x: 42, y: 43 })
  })

  it("frozen member lists override the live computation while dragging", () => {
    const region = node(1, { kind: "folder", folder_id: 1 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      expandedRegions: new Set(),
      overlay: new Map(),
      // Snapshot from drag start: only conv 11 (10 arrived remotely since).
      frozenMembers: new Map([[1, [11]]]),
    })
    const members = nodes.filter((n) => n.type === "conversationCard")
    expect(
      members.map((n) => (n.data as ConversationCardData).conversationId)
    ).toEqual([11])
  })

  it("collapsed regions render as a capsule with no member cards", () => {
    const region = node(1, { kind: "folder", folder_id: 1, collapsed: true })
    const { nodes, renderedSizes } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect(nodes).toHaveLength(1)
    expect(renderedSizes.get(1)?.height).toBe(REGION_COLLAPSED_HEIGHT)
  })

  it("caps visible members at MAX_VISIBLE_MEMBERS until expanded", () => {
    const many = Array.from({ length: MAX_VISIBLE_MEMBERS + 5 }, (_, i) =>
      conv(100 + i)
    )
    const region = node(1, { kind: "agent", agent_type: "claude_code" })
    const capped = deriveFlowGraph({
      dbNodes: [region],
      conversations: many,
      allFolders: [],
      ...NO_DRAG,
    })
    expect(
      capped.nodes.filter((n) => n.type === "conversationCard")
    ).toHaveLength(MAX_VISIBLE_MEMBERS)

    const expanded = deriveFlowGraph({
      dbNodes: [region],
      conversations: many,
      allFolders: [],
      expandedRegions: new Set([1]),
      overlay: new Map(),
      frozenMembers: null,
    })
    expect(
      expanded.nodes.filter((n) => n.type === "conversationCard")
    ).toHaveLength(MAX_VISIBLE_MEMBERS + 5)
  })

  it("marks unresolved bindings (missing folder / missing conversation)", () => {
    const ghostFolder = node(1, { kind: "folder", folder_id: 404 })
    const ghostPin = node(2, {
      kind: "conversation",
      conversation_id: 404,
      x: 900,
    })
    const { nodes } = deriveFlowGraph({
      dbNodes: [ghostFolder, ghostPin],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect((nodes[0].data as RegionNodeData).unresolved).toBe(true)
    const pin = nodes[1].data as ConversationCardData
    expect(pin.unresolved).toBe(true)
    expect(pin.conversation).toBeNull()
    expect(pin.pinDbId).toBe(2)
  })

  it("unresolved regions emit NO member cards (the hint state owns the body)", () => {
    // Folder 1 is gone from the store but its conversations linger (e.g. a
    // just-closed folder mid-refetch): the region must not paint cards over
    // its unresolved hint.
    const region = node(1, { kind: "folder", folder_id: 1 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: [],
      ...NO_DRAG,
    })
    expect(nodes).toHaveLength(1)
    const data = nodes[0].data as RegionNodeData
    expect(data.unresolved).toBe(true)
    expect(data.memberTotal).toBe(0)
  })

  it("custom members are re-checked for canvas eligibility on read", () => {
    const region = node(1, { kind: "custom", member_ids: [10, 50] })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations: [conv(10), conv(50, { kind: "delegate" })],
      allFolders: [],
      ...NO_DRAG,
    })
    const members = nodes.filter((n) => n.type === "conversationCard")
    expect(
      members.map((n) => (n.data as ConversationCardData).conversationId)
    ).toEqual([10])
  })

  it("live resize dimensions override stored geometry and reflow the grid", () => {
    // Stored 3-column region resized down to one column width mid-gesture.
    const region = node(1, { kind: "folder", folder_id: 1 })
    const { nodes, regionRects } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      expandedRegions: new Set(),
      overlay: new Map(),
      frozenMembers: null,
      sizeOverlay: new Map([[regionNodeId(1), { width: 280, height: 600 }]]),
    })
    expect(nodes[0].width).toBe(280)
    expect(regionRects[0].width).toBe(280)
    // 280 wide → 1 column → second member wraps to the next row.
    const second = nodes[2]
    expect(second.position.x).toBe(REGION_PADDING)
    expect(second.position.y).toBe(
      REGION_HEADER_HEIGHT + REGION_PADDING + CARD_HEIGHT + CARD_GAP
    )
  })

  it("pinned conversation cards use the fixed card footprint", () => {
    const pin = node(2, { kind: "conversation", conversation_id: 10 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [pin],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect(nodes[0].width).toBe(CARD_WIDTH)
    expect(nodes[0].height).toBe(CARD_HEIGHT)
    expect((nodes[0].data as ConversationCardData).conversation?.id).toBe(10)
  })

  it("expands a pinned card into a detail node at the detail footprint", () => {
    // Every pin is born at the summary footprint (`canvas_detach_member` and
    // the add-menu both write CARD_WIDTH/CARD_HEIGHT), which is the sentinel
    // for "the user has never sized this card".
    const pin = node(2, {
      kind: "conversation",
      conversation_id: 10,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    })
    const { nodes } = deriveFlowGraph({
      dbNodes: [pin],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
      detailCards: new Set([2]),
    })
    expect(nodes[0].type).toBe("conversationDetail")
    expect(nodes[0].width).toBe(DETAIL_CARD_WIDTH)
    expect(nodes[0].height).toBe(DETAIL_CARD_HEIGHT)
  })

  it("keeps a resized detail card's own size instead of the default", () => {
    const pin = node(2, {
      kind: "conversation",
      conversation_id: 10,
      width: 640,
      height: 700,
    })
    const { nodes } = deriveFlowGraph({
      dbNodes: [pin],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
      detailCards: new Set([2]),
    })
    expect(nodes[0].width).toBe(640)
    expect(nodes[0].height).toBe(700)
    // Collapsed again it is a summary tile, whatever the stored size says.
    const collapsed = deriveFlowGraph({
      dbNodes: [pin],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect(collapsed.nodes[0].type).toBe("conversationCard")
    expect(collapsed.nodes[0].width).toBe(CARD_WIDTH)
  })

  it("an unresolved pin never expands — there is nothing to show", () => {
    const pin = node(2, {
      kind: "conversation",
      conversation_id: 999,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    })
    const { nodes } = deriveFlowGraph({
      dbNodes: [pin],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
      detailCards: new Set([2]),
    })
    expect(nodes[0].type).toBe("conversationCard")
    expect((nodes[0].data as ConversationCardData).unresolved).toBe(true)
  })

  it("a pinned column count owns the frame width, whatever the stored one says", () => {
    // Stored width says 3 columns' worth; the pinned shape says 2. The frame
    // must follow the SHAPE, or the grid would lay out 2 columns inside a
    // 3-column frame (or worse, N columns inside a narrower one).
    const region = node(1, {
      kind: "folder",
      folder_id: 1,
      width: regionWidthForColumns(3),
      grid_columns: 2,
    })
    const { nodes, regionRects } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect(nodes[0].width).toBe(regionWidthForColumns(2))
    expect(regionRects[0].width).toBe(regionWidthForColumns(2))
    // Two members, two columns → same row.
    expect(nodes[1].position.y).toBe(nodes[2].position.y)
  })

  it("a pinned row count caps the visible members and reserves the footer", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      conv(20 + i, { updated_at: `2026-08-30T1${i}:00:00Z` })
    )
    const region = node(1, {
      kind: "folder",
      folder_id: 1,
      grid_columns: 2,
      grid_rows: 2,
    })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations: many,
      allFolders: folders,
      ...NO_DRAG,
    })
    const data = nodes[0].data as RegionNodeData
    expect(data.memberTotal).toBe(6)
    expect(data.visibleCount).toBe(4)
    expect(nodes).toHaveLength(5) // region + 4 cards
    // Height = the declared 2-row frame PLUS the "+N" bar, so the bar can never
    // sit on top of the last card row.
    expect(nodes[0].height).toBe(regionHeightForRows(2) + REGION_FOOTER_HEIGHT)
  })

  it("expanding the region lifts the row cap and drops the footer", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      conv(20 + i, { updated_at: `2026-08-30T1${i}:00:00Z` })
    )
    const region = node(1, {
      kind: "folder",
      folder_id: 1,
      grid_columns: 2,
      grid_rows: 2,
    })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations: many,
      allFolders: folders,
      ...NO_DRAG,
      expandedRegions: new Set([1]),
    })
    expect((nodes[0].data as RegionNodeData).visibleCount).toBe(6)
    expect(nodes[0].height).toBe(regionHeightForRows(3))
  })

  it("group regions resolve every folder in the group, worktrees included", () => {
    const groupFolders = [
      folder(1, { group_id: 7 }),
      folder(2, { group_id: 7 }),
      // Worktree child of a grouped repo: follows its parent into the group
      // even though it carries no group_id of its own.
      folder(3, { parent_id: 1, group_id: null }),
      folder(4, { group_id: null }),
    ]
    const rows = [
      conv(30, { folder_id: 1 }),
      conv(31, { folder_id: 2 }),
      conv(32, { folder_id: 3 }),
      conv(33, { folder_id: 4 }),
    ]
    const region = node(1, { kind: "group", folder_group_id: 7 })
    const members = computeRegionMembers(region, rows, groupFolders)
    expect(members.map((m) => m.id).sort()).toEqual([30, 31, 32])
  })

  it("a group region whose group is gone renders unresolved, not empty", () => {
    const region = node(1, { kind: "group", folder_group_id: 7 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      folderGroups: [],
      ...NO_DRAG,
    })
    expect((nodes[0].data as RegionNodeData).unresolved).toBe(true)
    expect(nodes).toHaveLength(1)
  })
})

describe("region grid geometry", () => {
  it("round-trips column and row counts through the frame size", () => {
    for (const n of [1, 2, 3, 4, 6, 12]) {
      expect(columnsForRegionWidth(regionWidthForColumns(n))).toBe(n)
      expect(rowsForRegionHeight(regionHeightForRows(n))).toBe(n)
    }
  })

  it("quantizes a ragged drag width down to whole cards", () => {
    // Mid-drag the resizer hands us anything; snapping to the column count it
    // has fully cleared is what makes the frame step one card at a time.
    const ragged = regionWidthForColumns(3) - 40
    expect(columnsForRegionWidth(ragged)).toBe(2)
    expect(regionWidthForColumns(columnsForRegionWidth(ragged))).toBe(
      regionWidthForColumns(2)
    )
  })

  it("never reports zero columns for a frame narrower than one card", () => {
    expect(columnsForRegionWidth(10)).toBe(1)
    expect(rowsForRegionHeight(10)).toBe(1)
  })
})

describe("deriveFlowGraph — the colour a card wears", () => {
  // `canvas_node.color` belongs to every kind of row, so a pinned card can be
  // coloured like a region or a note. A member card has no row of its own —
  // members are ids on the region's row — so it wears the region's, which is
  // also why the dock only offers the palette on a pinned card.
  it("gives a pinned card its own row's colour", () => {
    const pin = node(1, {
      kind: "conversation",
      conversation_id: 10,
      color: "amber",
    })
    const { nodes } = deriveFlowGraph({
      dbNodes: [pin],
      conversations: [conv(10)],
      allFolders: [folder(1)],
      ...NO_DRAG,
    })
    expect((nodes[0].data as ConversationCardData).color).toBe("amber")
  })

  it("gives a member card the colour of the region holding it", () => {
    const region = node(1, { kind: "folder", folder_id: 1, color: "violet" })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations: [conv(10)],
      allFolders: [folder(1)],
      ...NO_DRAG,
    })
    const member = nodes.find((n) => n.type === "conversationCard")!
    expect((member.data as ConversationCardData).color).toBe("violet")
  })
})

describe("deriveFlowGraph — the folder a card names in its footer", () => {
  // Resolved here rather than in the component: the derivation already holds
  // the folder list, and a card per conversation subscribing to the workspace
  // store would put a store read on every tile of a large board.
  it("names the conversation's own folder on a pinned card", () => {
    const pin = node(1, { kind: "conversation", conversation_id: 10 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [pin],
      conversations: [conv(10, { folder_id: 3 })],
      allFolders: [folder(3, { name: "codeg" })],
      ...NO_DRAG,
    })
    expect((nodes[0].data as ConversationCardData).folderName).toBe("codeg")
  })

  it("names the parent repo for a conversation living in a worktree", () => {
    // The worktree's own directory name is `codeg-fix-abc`; what pairs with the
    // branch chip beside it is the repo, exactly as the composer row reads.
    const region = node(1, { kind: "folder", folder_id: 4 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations: [conv(10, { folder_id: 4 })],
      allFolders: [
        folder(3, { name: "codeg" }),
        folder(4, { name: "codeg-fix-abc", parent_id: 3 }),
      ],
      ...NO_DRAG,
    })
    const member = nodes.find((n) => n.type === "conversationCard")!
    expect((member.data as ConversationCardData).folderName).toBe("codeg")
  })

  it("leaves a folderless chat conversation without a folder", () => {
    // A chat conversation's folder is a hidden bookkeeping row, not a place the
    // user picked — the composer's own picker shows no folder there either.
    const pin = node(1, { kind: "conversation", conversation_id: 10 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [pin],
      conversations: [conv(10, { folder_id: 9 })],
      allFolders: [folder(9, { name: "chat-9", kind: "chat" })],
      ...NO_DRAG,
    })
    expect((nodes[0].data as ConversationCardData).folderName).toBeNull()
  })

  it("stays null rather than guessing when the folder is unknown", () => {
    const pin = node(1, { kind: "conversation", conversation_id: 10 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [pin],
      conversations: [conv(10, { folder_id: 404 })],
      allFolders: [folder(3)],
      ...NO_DRAG,
    })
    expect((nodes[0].data as ConversationCardData).folderName).toBeNull()
  })
})

describe("resolveNewConversationTarget", () => {
  it("starts a draft in the workspace's active folder", () => {
    expect(resolveNewConversationTarget(7, [folder(3), folder(7)])).toEqual({
      folderId: 7,
    })
  })

  it("falls back to chat mode when nothing is active", () => {
    // The canvas is reachable with no conversation tab open at all. Asking the
    // user to pick a folder first is exactly what this replaced, so the
    // fallback has to be a real target rather than a refusal.
    expect(resolveNewConversationTarget(null, [folder(3)])).toEqual({
      chat: true,
    })
  })

  it("treats an active chat folder as chat mode", () => {
    // Chat mode IS a folder — a hidden one the backend mints — so the active id
    // is set while in it. Passing that id back as a folder target would pin the
    // draft to someone else's private chat folder.
    expect(
      resolveNewConversationTarget(4, [folder(4, { kind: "chat" })])
    ).toEqual({ chat: true })
  })

  it("falls back when the active folder is gone", () => {
    // The id outlives the row: closing or deleting a folder leaves the active
    // id pointing at nothing until the next tab switch, and a draft aimed at a
    // folder that no longer exists has nowhere to send its first message.
    expect(resolveNewConversationTarget(9, [folder(3)])).toEqual({ chat: true })
  })
})

describe("file and terminal cards", () => {
  it("derives a file card at its stored footprint, with a drag handle", () => {
    const { nodes } = deriveFlowGraph({
      dbNodes: [
        node(1, {
          kind: "file",
          path: "/repo/src/index.ts",
          width: FILE_CARD_WIDTH,
          height: FILE_CARD_HEIGHT,
        }),
      ],
      conversations: [],
      allFolders: [],
      ...NO_DRAG,
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0].type).toBe("file")
    expect(nodes[0].width).toBe(FILE_CARD_WIDTH)
    expect(nodes[0].height).toBe(FILE_CARD_HEIGHT)
    // Without this the whole card is a drag surface and a click inside it
    // cannot place a caret — see the RF drag-filter note in the derive layer.
    expect(nodes[0].dragHandle).toBe(DRAG_HANDLE_SELECTOR)
    const data = nodes[0].data as FileNodeData
    expect(data.path).toBe("/repo/src/index.ts")
    expect(data.label).toBe("index.ts")
  })

  it("prefers a renamed card's own title over the file name", () => {
    const { nodes } = deriveFlowGraph({
      dbNodes: [
        node(1, { kind: "file", path: "/repo/README.md", title: "The plan" }),
      ],
      conversations: [],
      allFolders: [],
      ...NO_DRAG,
    })
    expect((nodes[0].data as FileNodeData).label).toBe("The plan")
  })

  it("derives a terminal card from its working directory", () => {
    const { nodes } = deriveFlowGraph({
      dbNodes: [node(2, { kind: "terminal", path: "/repo/api" })],
      conversations: [],
      allFolders: [],
      ...NO_DRAG,
    })
    expect(nodes[0].type).toBe("terminal")
    const data = nodes[0].data as TerminalNodeData
    expect(data.workingDir).toBe("/repo/api")
    expect(data.label).toBe("api")
  })

  it("renders a row that lost its path rather than dropping it", () => {
    // The path is a SOFT reference like every other binding on this board: a
    // card whose file moved must stay on screen for the user to delete, not
    // silently disappear along with the arrangement around it.
    const { nodes } = deriveFlowGraph({
      dbNodes: [node(3, { kind: "file", path: null })],
      conversations: [],
      allFolders: [],
      ...NO_DRAG,
    })
    expect(nodes).toHaveLength(1)
    expect((nodes[0].data as FileNodeData).path).toBe("")
  })

  it("honours a live resize over the stored box", () => {
    const { nodes, renderedSizes } = deriveFlowGraph({
      dbNodes: [node(4, { kind: "terminal", path: "/repo", width: 480 })],
      conversations: [],
      allFolders: [],
      ...NO_DRAG,
      sizeOverlay: new Map([[regionNodeId(4), { width: 640, height: 200 }]]),
    })
    expect(nodes[0].width).toBe(640)
    // Auto-arrange packs by what is DRAWN, not by what the row says — a card
    // mid-resize that reported its stored width would be packed under its
    // neighbour.
    expect(renderedSizes.get(4)).toEqual({ width: 640, height: 200 })
  })

  it("keeps neither kind out of the merge/region gestures' way", () => {
    // Only conversation cards are droppable into regions. A file or terminal
    // card must never show up as a merge target, or dropping a conversation on
    // one would try to collect a file into a conversation region.
    const { pinRects, regionRects } = deriveFlowGraph({
      dbNodes: [
        node(5, { kind: "file", path: "/repo/a.ts" }),
        node(6, { kind: "terminal", path: "/repo" }),
      ],
      conversations: [],
      allFolders: [],
      ...NO_DRAG,
    })
    expect(pinRects).toEqual([])
    expect(regionRects).toEqual([])
  })
})

describe("canvasTerminalId", () => {
  it("is derived from the row id so a card re-attaches to its own shell", () => {
    // Stability across mounts is the whole point: the canvas route really
    // unmounts, and the PTY has to be findable again by the card that placed
    // it — including from a second window showing the same board.
    expect(canvasTerminalId(12)).toBe("canvas-term-12")
    expect(canvasTerminalId(12)).toBe(canvasTerminalId(12))
    expect(canvasTerminalId(13)).not.toBe(canvasTerminalId(12))
  })
})

describe("isRegionKind", () => {
  it("covers exactly the container kinds", () => {
    // The view quantizes a resize to whole member cards for these and only
    // these; a file or terminal card snapping to a conversation grid would
    // jump under the pointer.
    for (const kind of ["folder", "group", "agent", "custom"] as const) {
      expect(isRegionKind(kind)).toBe(true)
    }
    for (const kind of ["conversation", "note", "file", "terminal"] as const) {
      expect(isRegionKind(kind)).toBe(false)
    }
  })
})

describe("basePathName", () => {
  it("takes the last segment of either separator style", () => {
    expect(basePathName("/repo/src/index.ts")).toBe("index.ts")
    expect(basePathName("C:\\repo\\src\\index.ts")).toBe("index.ts")
  })

  it("ignores trailing separators, which a directory path often has", () => {
    expect(basePathName("/repo/api/")).toBe("api")
  })

  it("never returns an empty label", () => {
    expect(basePathName("/")).toBe("/")
    expect(basePathName("")).toBe("")
  })
})
