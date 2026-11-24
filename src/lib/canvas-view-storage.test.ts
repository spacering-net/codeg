import { beforeEach, describe, expect, it } from "vitest"
import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  forgetCanvasBoardViewState,
  loadCanvasDrafts,
  loadCanvasExpandedCards,
  loadCanvasExpandedRegions,
  loadCanvasMinimapVisible,
  loadCanvasSurfaceKeys,
  loadCanvasViewport,
  saveCanvasDrafts,
  saveCanvasExpandedCards,
  saveCanvasExpandedRegions,
  saveCanvasMinimapVisible,
  saveCanvasSurfaceKeys,
  saveCanvasViewport,
  type CanvasDraftCard,
} from "./canvas-view-storage"

/**
 * These entries are read at mount and drive what the canvas renders before any
 * backend data lands, so every reader has to degrade to "nothing remembered"
 * rather than throw or hand back a shape the view can't use. A corrupted
 * viewport in particular could strand the board at an unreachable zoom.
 */

/** The board most tests read and write. Every entry but the map toggle is
 *  kept per board, under the pre-board key plus `:<boardId>`. */
const B = 3
const LEGACY_VIEWPORT_KEY = "workspace:canvas-viewport"
const LEGACY_CARDS_KEY = "workspace:canvas-expanded-cards"
const LEGACY_DRAFTS_KEY = "workspace:canvas-drafts"
const VIEWPORT_KEY = `${LEGACY_VIEWPORT_KEY}:${B}`
const CARDS_KEY = `${LEGACY_CARDS_KEY}:${B}`
const DRAFTS_KEY = `${LEGACY_DRAFTS_KEY}:${B}`
const MINIMAP_KEY = "workspace:canvas-minimap"
const SURFACE_KEYS_KEY = `workspace:canvas-surface-keys:${B}`
const T = "2026-09-02T09:00:00.000Z"

describe("canvas view storage", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips a viewport", () => {
    saveCanvasViewport(B, { x: -320.5, y: 96, zoom: 0.75 })
    expect(loadCanvasViewport(B)).toEqual({ x: -320.5, y: 96, zoom: 0.75 })
  })

  it("clamps a stored zoom into the flow's own range", () => {
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ x: 0, y: 0, zoom: 40 }))
    expect(loadCanvasViewport(B)?.zoom).toBe(CANVAS_MAX_ZOOM)
    localStorage.setItem(
      VIEWPORT_KEY,
      JSON.stringify({ x: 0, y: 0, zoom: 0.0001 })
    )
    expect(loadCanvasViewport(B)?.zoom).toBe(CANVAS_MIN_ZOOM)
  })

  it("treats damaged or incomplete entries as nothing remembered", () => {
    localStorage.setItem(VIEWPORT_KEY, "{not json")
    expect(loadCanvasViewport(B)).toBeNull()
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ x: 1, y: 2 }))
    expect(loadCanvasViewport(B)).toBeNull()
    localStorage.setItem(
      VIEWPORT_KEY,
      JSON.stringify({ x: Number.NaN, y: 0, zoom: 1 })
    )
    expect(loadCanvasViewport(B)).toBeNull()
  })

  it("keeps only integral ids in the expanded-card set", () => {
    saveCanvasExpandedCards(B, [3, 9])
    expect(loadCanvasExpandedCards(B)).toEqual([3, 9])
    localStorage.setItem(CARDS_KEY, JSON.stringify([1, "2", null, 3.5, 4]))
    expect(loadCanvasExpandedCards(B)).toEqual([1, 4])
    localStorage.setItem(CARDS_KEY, JSON.stringify({ nope: true }))
    expect(loadCanvasExpandedCards(B)).toEqual([])
  })

  it("round-trips drafts and drops the ones it cannot place", () => {
    const draft: CanvasDraftCard = {
      id: "abc",
      target: { folderId: 4 },
      agentType: "claude_code",
      x: 10,
      y: 20,
      width: 520,
      height: 560,
    }
    const chat: CanvasDraftCard = {
      ...draft,
      id: "def",
      target: { chat: true },
    }
    saveCanvasDrafts(B, [draft, chat])
    expect(loadCanvasDrafts(B)).toEqual([draft, chat])

    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify([
        draft,
        // No target at all, a target naming nothing, and no geometry: a card
        // built from any of these would have nowhere to send its first message.
        { ...draft, id: "x", target: undefined },
        { ...draft, id: "y", target: {} },
        { ...draft, id: "z", x: undefined },
        { ...draft, id: "", target: { chat: true } },
      ])
    )
    expect(loadCanvasDrafts(B).map((d) => d.id)).toEqual(["abc"])
  })

  it("refuses drafts with no area and collapses repeated ids", () => {
    const draft: CanvasDraftCard = {
      id: "abc",
      target: { chat: true },
      agentType: "codex",
      x: 0,
      y: 0,
      width: 520,
      height: 560,
    }
    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify([
        // A zero/negative box restores a window too small to read or close.
        { ...draft, id: "flat", height: 0 },
        { ...draft, id: "inverted", width: -520 },
        draft,
        // The id is the connection key too: two cards under one key would be
        // two surfaces fighting over the same agent.
        { ...draft, x: 999 },
      ])
    )
    const loaded = loadCanvasDrafts(B)
    expect(loaded.map((d) => d.id)).toEqual(["abc"])
    expect(loaded[0].x).toBe(0)
  })

  it("remembers a draft's colour without ever failing a draft over it", () => {
    // The colour has nowhere else to live until the first send creates the row
    // that will hold it, so it has to survive a reload here.
    const draft: CanvasDraftCard = {
      id: "abc",
      target: { chat: true },
      agentType: "codex",
      color: "sky",
      x: 0,
      y: 0,
      width: 520,
      height: 560,
    }
    saveCanvasDrafts(B, [draft])
    expect(loadCanvasDrafts(B)).toEqual([draft])

    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify([
        // Junk in the one field that is pure decoration. Dropping the draft
        // would take the card AND the text typed into it with it — the colour
        // is simply forgotten instead, and an unknown name would be ignored at
        // paint time anyway.
        { ...draft, id: "wrong-type", color: 7 },
        { ...draft, id: "unknown-name", color: "not-a-colour" },
      ])
    )
    const loaded = loadCanvasDrafts(B)
    expect(loaded.map((d) => d.id)).toEqual(["wrong-type", "unknown-name"])
    expect(loaded[0].color).toBeUndefined()
    expect(loaded[1].color).toBe("not-a-colour")
  })

  it("clears the draft entry rather than storing an empty list", () => {
    saveCanvasDrafts(B, [
      {
        id: "abc",
        target: { chat: true },
        agentType: "codex",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    ])
    saveCanvasDrafts(B, [])
    expect(localStorage.getItem(DRAFTS_KEY)).toBeNull()
  })

  it("shows the navigator map until it is explicitly dismissed", () => {
    // The asymmetry is the point: this is the one entry whose default is ON, so
    // "nothing remembered" has to mean shown. Reading it as a plain truthiness
    // check would hide the map for every user who has never opened the canvas.
    expect(loadCanvasMinimapVisible()).toBe(true)
    localStorage.setItem(MINIMAP_KEY, "null")
    expect(loadCanvasMinimapVisible()).toBe(true)
    localStorage.setItem(MINIMAP_KEY, "not json")
    expect(loadCanvasMinimapVisible()).toBe(true)
    localStorage.setItem(MINIMAP_KEY, '"false"')
    expect(loadCanvasMinimapVisible()).toBe(true)
  })

  it("round-trips a dismissed map", () => {
    saveCanvasMinimapVisible(false)
    expect(loadCanvasMinimapVisible()).toBe(false)
    saveCanvasMinimapVisible(true)
    expect(loadCanvasMinimapVisible()).toBe(true)
  })

  it("round-trips the connection keys cards inherited from drafts", () => {
    // A card minted by a draft's first send keeps the DRAFT's key, because the
    // send is already in flight on it. Recomputing the default key on the next
    // visit would send the card looking for a connection that isn't there while
    // the agent it started keeps running under a key nothing claims.
    const entry = {
      conversationId: 42,
      createdAt: "2026-09-02T09:00:00.000Z",
      key: "canvas-draft-abc",
    }
    saveCanvasSurfaceKeys(B, new Map([[7, entry]]))
    expect(loadCanvasSurfaceKeys(B)).toEqual(new Map([[7, entry]]))
    saveCanvasSurfaceKeys(B, new Map())
    expect(localStorage.getItem(SURFACE_KEYS_KEY)).toBeNull()
  })

  it("keeps the card identity each key was written for", () => {
    // The id alone doesn't identify a card across databases — this file is not
    // backend-scoped, and two databases behind one origin hand out the same low
    // ids to different cards. `createdAt` is what lets the caller tell those
    // apart instead of handing one of them a stranger's connection key.
    saveCanvasSurfaceKeys(
      B,
      new Map([
        [
          7,
          {
            conversationId: 42,
            createdAt: "2026-09-02T09:00:00.000Z",
            key: "canvas-draft-abc",
          },
        ],
      ])
    )
    const restored = loadCanvasSurfaceKeys(B).get(7)
    expect(restored?.conversationId).toBe(42)
    expect(restored?.createdAt).toBe("2026-09-02T09:00:00.000Z")
  })

  it("drops surface-key entries it can't use", () => {
    // Same contract as the rest of this module: an entry from another database,
    // a hand-edited file or an older shape resolves to "nothing remembered" —
    // the card falls back to its default key, which is merely the pre-draft
    // behaviour, rather than mounting on a key of the wrong type.
    localStorage.setItem(
      SURFACE_KEYS_KEY,
      JSON.stringify([
        { nodeId: 1, conversationId: 10, createdAt: T, key: "canvas-draft-ok" },
        { nodeId: 2.5, conversationId: 10, createdAt: T, key: "fractional" },
        { nodeId: "3", conversationId: 10, createdAt: T, key: "string-node" },
        { nodeId: 4, createdAt: T, key: "no-conversation" },
        { nodeId: 5, conversationId: 10, key: "no-created-at" },
        { nodeId: 6, conversationId: 10, createdAt: T, key: "" },
        [7, "canvas-draft-old-pair-shape"],
        null,
      ])
    )
    expect(loadCanvasSurfaceKeys(B)).toEqual(
      new Map([
        [1, { conversationId: 10, createdAt: T, key: "canvas-draft-ok" }],
      ])
    )

    localStorage.setItem(SURFACE_KEYS_KEY, '{"1":"canvas-draft-ok"}')
    expect(loadCanvasSurfaceKeys(B).size).toBe(0)
  })
  it("keeps each board's memory apart", () => {
    // One shared entry would have every board prune the others' ids away the
    // moment it opened — the view drops ids that name no node on ITS board.
    saveCanvasViewport(1, { x: 10, y: 10, zoom: 1 })
    saveCanvasViewport(2, { x: -50, y: 0, zoom: 0.5 })
    saveCanvasExpandedCards(1, [4, 5])
    expect(loadCanvasViewport(1)).toEqual({ x: 10, y: 10, zoom: 1 })
    expect(loadCanvasViewport(2)).toEqual({ x: -50, y: 0, zoom: 0.5 })
    expect(loadCanvasExpandedCards(1)).toEqual([4, 5])
    expect(loadCanvasExpandedCards(2)).toEqual([])
  })

  it("hands what the pre-board canvas remembered to the first board that asks", () => {
    // Before boards, all of this described THE canvas — which the upgrade put
    // on a board of its own. The first board opened inherits it, once.
    localStorage.setItem(
      LEGACY_VIEWPORT_KEY,
      JSON.stringify({ x: 7, y: 8, zoom: 1.5 })
    )
    localStorage.setItem(LEGACY_CARDS_KEY, JSON.stringify([11, 12]))
    expect(loadCanvasViewport(5)).toEqual({ x: 7, y: 8, zoom: 1.5 })
    expect(loadCanvasExpandedCards(5)).toEqual([11, 12])
    expect(localStorage.getItem(LEGACY_VIEWPORT_KEY)).toBeNull()
    expect(localStorage.getItem(LEGACY_CARDS_KEY)).toBeNull()
    // Adopted, not shared: the next board starts from nothing.
    expect(loadCanvasViewport(6)).toBeNull()
    expect(loadCanvasExpandedCards(6)).toEqual([])
    // And the adopter keeps it as its own from now on.
    expect(loadCanvasViewport(5)).toEqual({ x: 7, y: 8, zoom: 1.5 })
  })

  it("a board with memory of its own leaves the pre-board entry for the next", () => {
    saveCanvasExpandedRegions(1, [3])
    localStorage.setItem(
      "workspace:canvas-expanded-regions",
      JSON.stringify([9])
    )
    expect(loadCanvasExpandedRegions(1)).toEqual([3])
    expect(loadCanvasExpandedRegions(2)).toEqual([9])
  })

  it("adopts pre-board drafts too, so unsent cards are not lost", () => {
    const draft: CanvasDraftCard = {
      id: "legacy",
      target: { chat: true },
      agentType: "codex",
      x: 0,
      y: 0,
      width: 520,
      height: 560,
    }
    localStorage.setItem(LEGACY_DRAFTS_KEY, JSON.stringify([draft]))
    expect(loadCanvasDrafts(8)).toEqual([draft])
    expect(loadCanvasDrafts(9)).toEqual([])
  })

  it("forgets a deleted board without touching the others", () => {
    for (const board of [1, 2]) {
      saveCanvasViewport(board, { x: board, y: 0, zoom: 1 })
      saveCanvasExpandedCards(board, [board])
      saveCanvasExpandedRegions(board, [board])
      saveCanvasDrafts(board, [
        {
          id: `d${board}`,
          target: { chat: true },
          agentType: "codex",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ])
      saveCanvasSurfaceKeys(
        board,
        new Map([[board, { conversationId: 1, createdAt: T, key: "k" }]])
      )
    }
    saveCanvasMinimapVisible(false)
    forgetCanvasBoardViewState(1)

    expect(loadCanvasViewport(1)).toBeNull()
    expect(loadCanvasExpandedCards(1)).toEqual([])
    expect(loadCanvasExpandedRegions(1)).toEqual([])
    expect(loadCanvasDrafts(1)).toEqual([])
    expect(loadCanvasSurfaceKeys(1).size).toBe(0)

    expect(loadCanvasViewport(2)).toEqual({ x: 2, y: 0, zoom: 1 })
    expect(loadCanvasDrafts(2)).toHaveLength(1)
    // The map toggle is the canvas's, not a board's.
    expect(loadCanvasMinimapVisible()).toBe(false)
  })
})
