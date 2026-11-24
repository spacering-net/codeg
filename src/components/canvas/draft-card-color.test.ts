import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Colouring a conversation card that has no row yet.
 *
 * Every other element on the board stores its colour in `canvas_node.color`, so
 * its palette is one `patchNode` call. A draft has no row at all until its first
 * message creates one, which makes this the only colour on the board that lives
 * on the client and has to be HANDED OVER at a specific moment. The three seams
 * below are that hand-off; the storage round-trip is in
 * `canvas-view-storage.test.ts`.
 *
 * Read from source because the dock only renders under a ReactFlow store and the
 * canvas view's provider, and `AddNodeMenu` beside it pulls the agent registry —
 * the same reason the drawer's dock assertions are written this way.
 */

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const DOCK = "src/components/canvas/canvas-dock.tsx"
const VIEW = "src/components/canvas/canvas-view.tsx"
const NODE = "src/components/canvas/nodes/conversation-detail-node.tsx"

describe("a draft card's colour", () => {
  it("is picked from the same palette every other element uses", () => {
    const dock = read(DOCK)
    const draftActions = dock.slice(
      dock.indexOf("function DraftActions"),
      dock.indexOf("interface CanvasDockProps")
    )
    expect(draftActions).toContain("<ColorPalette")
    expect(draftActions).toContain("setDraftColor(data.draftId, color)")
  })

  it("is not offered while the first send is minting the row", () => {
    // A colour picked in that window would race the `createNode` already
    // carrying the previous one. The early return has to stay ABOVE the
    // palette, which is the one thing an added control could quietly undo.
    const dock = read(DOCK)
    const draftActions = dock.slice(
      dock.indexOf("function DraftActions"),
      dock.indexOf("interface CanvasDockProps")
    )
    const guard = draftActions.indexOf("sendingDrafts.has(data.draftId)")
    const palette = draftActions.indexOf("<ColorPalette")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(palette)
  })

  it("paints the card it was picked on", () => {
    const node = read(NODE)
    const draftNode = node.slice(node.indexOf("ConversationDraftNode = memo"))
    expect(draftNode).toContain("color={data.color}")
  })

  it("goes into the row the first send creates", () => {
    // Without this the colour is lost at exactly the moment the card stops
    // being a draft — the same class of bug as a colour that vanished when a
    // card was expanded.
    const view = read(VIEW)
    const start = view.indexOf("const materializeDraft")
    const end = view.indexOf("const endNodeResize")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(view.slice(start, end)).toContain("color: draft.color")
  })
})
