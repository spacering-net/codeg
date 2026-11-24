import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { draftRuntimeConversationId } from "./canvas-conversation-surface"

/**
 * The two seams a conversation card has while it is still a DRAFT — before its
 * first message creates the row — and both of them only misbehave in that
 * window, which is why an expanded card looks fine while a new one does not.
 *
 * What the hand-off itself has to preserve is covered behaviourally in
 * `stores/runtime-draft-row-handover.test.ts`; these are the wiring assertions
 * for the caller, read from source because `CanvasView` only mounts under a
 * ReactFlow store, the canvas provider and the whole chat stack — the same
 * reason `draft-card-color.test.ts` is written this way.
 */

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const VIEW = "src/components/canvas/canvas-view.tsx"
const SURFACE = "src/components/canvas/canvas-conversation-surface.tsx"

/** The `materializeDraft` body — the board's half of the swap. */
function materializeDraft(view: string): string {
  const start = view.indexOf("const materializeDraft")
  const end = view.indexOf("const endNodeResize")
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return view.slice(start, end)
}

/** The ReactFlow node built for an unsent draft. */
function draftFlowNode(view: string): string {
  const start = view.indexOf('type: "conversationDraft"')
  expect(start).toBeGreaterThan(-1)
  return view.slice(start, view.indexOf("satisfies ConversationDraftData"))
}

describe("a draft card's runtime session", () => {
  it("is named after the connection key, not the draft", () => {
    // The id has to be derivable by BOTH halves of the swap: the draft surface
    // mints it, and the pinned card that inherits the draft's connection key is
    // what hands it over. Seeding it on the draft id would leave the second
    // half unable to name the session it has to rescue.
    expect(draftRuntimeConversationId("canvas-draft-abc")).toBe(
      draftRuntimeConversationId("canvas-draft-abc")
    )
    expect(draftRuntimeConversationId("canvas-draft-abc")).not.toBe(
      draftRuntimeConversationId("canvas-draft-abd")
    )
    // Negative on purpose: a runtime key that could collide with a row id would
    // stream a draft into somebody else's conversation.
    expect(draftRuntimeConversationId("canvas-draft-abc")).toBeLessThan(0)
  })

  it("is adopted by the card that replaces the draft", () => {
    // The message that created the row was sent before the row existed, so it
    // lives under the draft's id. Skip this and the card that replaces the
    // draft mounts empty: the agent's answer arrives anyway (the live sink
    // follows the inherited connection key) with the user's own message
    // missing, under a transcript that says there are no messages yet.
    const surface = read(SURFACE)
    expect(surface).toMatch(
      /migrateConversation\(\s*draftRuntimeConversationId\(contextKey\),\s*effectiveConversationId\s*\)/
    )
  })

  it("is adopted before the arriving card's first paint, not during the swap", () => {
    // ReactFlow's `StoreUpdater` applies a changed `nodes` prop from a PASSIVE
    // effect, so the draft card is still mounted — and paintable — after the
    // render that drops it from the board. Migrating in `materializeDraft`
    // therefore empties the session under a card that is still on screen, and
    // paints one frame of the very "no messages yet" this fixes. A layout
    // effect in the arriving card lands it before that card's own first paint.
    const surface = read(SURFACE)
    const hook = surface.indexOf("useIsomorphicLayoutEffect(() => {")
    const call = surface.indexOf("migrateConversation(")
    expect(hook).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(hook)
    expect(surface.slice(hook, call)).not.toContain("}")
    expect(materializeDraft(read(VIEW))).not.toContain("migrateConversation")
  })

  it("names the same session from both sides", () => {
    // The surface mints the id and the surface adopts it, so one exported
    // helper is the whole contract — two copies of the hash would agree right
    // up until one of them was edited, and the failure would be a silently
    // empty card.
    const surface = read(SURFACE)
    expect(surface).toContain("export function draftRuntimeConversationId")
    expect(surface).toContain(
      "conversationId ?? draftRuntimeConversationId(contextKey)"
    )
  })

  it("rolls a failed send back out of whichever session holds it", () => {
    // A rejected prompt is its own round trip and can land after the swap, by
    // which time the turn has moved to the row's session. Rolling back only
    // against the mounted id would no-op there and strand the failed message
    // on the card that took over, dimmed under a typing indicator with
    // `awaiting_persist` pinned so no refetch clears it.
    const surface = read(SURFACE)
    const start = surface.indexOf("const onSendFailed = () => {")
    expect(start).toBeGreaterThan(-1)
    const body = surface.slice(start, surface.indexOf("\n      }", start))
    expect(body).toContain(
      "removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)"
    )
    expect(body).toContain("dbConversationIdRef.current")
  })

  it("drops the draft card even though its send is still in flight", () => {
    // `dismissDraft` refuses in exactly this state — its guard is for the three
    // DISCARD paths, where dropping the card would strand a conversation nobody
    // can see. Routing the hand-off through it would leave the draft up beside
    // the card that replaced it, both on one connection key.
    const body = materializeDraft(read(VIEW))
    expect(body).not.toContain("dismissDraft(draftId)")
    expect(body).toContain("setDraftsPersisted((prev) =>")
  })
})

describe("a draft card's body", () => {
  it("drags by its title bar, like the expanded card", () => {
    // Without a `dragHandle` every mousedown in the card passes d3-drag's
    // filter, and d3 answers by preventing `selectstart` on the window until
    // the pointer comes up. That is the same event the browser uses to ask
    // whether a caret may move, so a click into the composer focused it but
    // could not place the cursor, and nothing in the card could be selected.
    expect(draftFlowNode(read(VIEW))).toContain(
      "dragHandle: DRAG_HANDLE_SELECTOR"
    )
  })
})
