import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * What an expanded conversation card has to do when the board it lives on comes
 * back.
 *
 * The canvas is a full-page route: `WorkbenchRoutePage` renders the active page
 * or nothing, so leaving for the tasks or token page UNMOUNTS every card, while
 * the workspace's own conversation tabs are only hidden behind it. That makes a
 * card the one live-conversation surface that routinely disappears while its
 * conversation keeps working, and both halves of coming back have to be handled
 * explicitly — what the store is left holding, and what the connection is.
 *
 * The store half is covered behaviourally in
 * `stores/runtime-canvas-reentry.test.ts`; these are the wiring assertions for
 * the callers, read from source because neither `CanvasView` nor the surface
 * mounts without a ReactFlow store, the canvas provider and the whole chat
 * stack — the same reason `draft-card-handover.test.ts` is written this way.
 */

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const VIEW = "src/components/canvas/canvas-view.tsx"
const SURFACE = "src/components/canvas/canvas-conversation-surface.tsx"

/** The re-entry repair effect in the surface. */
function repairEffect(surface: string): string {
  const start = surface.indexOf("const repairedRef")
  expect(start).toBeGreaterThan(-1)
  const end = surface.indexOf("registerLiveMessageSink", start)
  expect(end).toBeGreaterThan(start)
  return surface.slice(start, end)
}

describe("a card returning to a session it left behind", () => {
  it("only repairs a session an earlier surface already loaded", () => {
    // Read at mount, before the draft hand-off can create one: a card arriving
    // from a draft holds its transcript under the draft's virtual id, so it has
    // no detail under its new row id and must be left alone — refetching there
    // would race the hand-off it depends on.
    const surface = read(SURFACE)
    expect(surface).toMatch(
      /const \[reEnteringSession\] = useState\(\s*\(\) =>\s*conversationId != null &&/
    )
    expect(repairEffect(surface)).toContain("if (!reEnteringSession")
  })

  it("refetches, because nothing else will", () => {
    // `useConversationDetail` fetches only when it has no detail at all, so a
    // card whose session survived the route switch would otherwise show the
    // transcript as of its last visit forever — collapsing and re-expanding it
    // does not help, since the session outlives the card either way.
    expect(repairEffect(read(SURFACE))).toContain(
      "refetchDetail(effectiveConversationId)"
    )
  })

  it("unpins awaiting_persist only when its own connection isn't prompting", () => {
    // Pinned, the refetch preserves exactly the buffers that went stale: the
    // optimistic user turn duplicating its persisted copy, under the fragment
    // of a reply that stopped streaming when the sink unregistered. Unpinned
    // while this card's own send is genuinely still in flight, the same refetch
    // would erase a message the transcript hasn't caught up with yet.
    const body = repairEffect(read(SURFACE))
    expect(body).toContain('session?.syncState === "awaiting_persist"')
    expect(body).toContain('connStatus !== "prompting"')
    expect(body).toContain('setSyncState(effectiveConversationId, "idle")')
  })

  it("runs before the sink that replays the connection's last message", () => {
    // `registerLiveMessageSink` pushes the connection's retained live message
    // on every registration. SET_LIVE_MESSAGE's guard rejects such a settled
    // replay over an existing transcript — but not while `awaiting_persist` is
    // pinned, so the unpin has to have happened first or the stale fragment is
    // written straight back in.
    const surface = read(SURFACE)
    expect(surface.indexOf("const repairedRef")).toBeLessThan(
      surface.indexOf("acpActions.registerLiveMessageSink")
    )
  })
})

describe("a board returning to cards whose agents are still running", () => {
  it("adopts their connections instead of leaving them dormant", () => {
    // `liveSurfaces` is deliberately never restored — six remembered expansions
    // must not start six agent CLIs. But an agent that is ALREADY running is a
    // different case: left dormant, the card shows a connection nobody owns,
    // and `registerLiveSurfaceKeys` claims only live surfaces — so a minute
    // after the turn settles the idle sweep reclaims it and kills the agent
    // while the user is looking at the card.
    const view = read(VIEW)
    const start = view.indexOf("const adoptedLiveRef")
    expect(start).toBeGreaterThan(-1)
    const body = view.slice(start, view.indexOf("}, [connectionStore", start))
    expect(body).toContain("connectionStore.getConnection(key)?.status")
    expect(body).toContain("setLiveSurfaces")
    // Only cards that are actually expanded — a collapsed card has no surface
    // to be live, and claiming its key would pin a connection the sweep is
    // meant to reclaim.
    expect(body).toContain("[...detailCards]")
  })

  it("looks for them under the key they were started on", () => {
    // A card minted by a draft's first send inherits the DRAFT's connection
    // key. Held only in memory, that mapping dies with the route switch — the
    // card then computes `canvas-node-<id>`, finds no connection under it, and
    // shows a disconnected conversation whose agent is in fact still running
    // under the draft's key, now claimed by nothing and swept a minute later.
    const view = read(VIEW)
    expect(view).toMatch(
      /useState<\s*ReadonlyMap<number, CanvasSurfaceKey>\s*>\(\(\) =>\s*loadCanvasSurfaceKeys\(boardId\)\s*\)/
    )
    const materialize = view.slice(
      view.indexOf("const materializeDraft"),
      view.indexOf("const endNodeResize")
    )
    expect(materialize).toContain("saveCanvasSurfaceKeys(boardId, next)")
  })

  it("only honours a key that still names the same card", () => {
    // This storage is not backend-scoped, so an id does not identify a card on
    // its own — two databases behind one origin hand out the same low ids to
    // different cards, and one must not inherit a key written for the other.
    // `created_at` is the part that survives that; the conversation id is the
    // binding the key was inherited for. Checking both beats `dbNodes.has(id)`.
    const view = read(VIEW)
    const prune = view.slice(
      view.indexOf("setDetailCardsPersisted((prev) => {"),
      view.indexOf("}, [boardId, hydrated, dbNodes, setDetailCardsPersisted])")
    )
    expect(prune).toContain("setSurfaceKeys((prev) => {")
    expect(prune).toContain("node?.conversation_id === entry.conversationId")
    expect(prune).toContain("node.created_at === entry.createdAt")
    // And the key a mounted card uses is derived from `surfaceKeys` ALONE. A
    // contextKey must be stable for the card's lifetime; re-deriving it from
    // `dbNodes` (which changes on every board mutation) would re-key a live
    // connection mid-conversation.
    const forPinStart = view.indexOf("const contextKeyForPin")
    expect(forPinStart).toBeGreaterThan(-1)
    const forPin = view.slice(
      forPinStart,
      view.indexOf("[surfaceKeys]", forPinStart)
    )
    expect(forPin).toContain("surfaceKeys.get(pinDbId)?.key")
    expect(forPin).not.toContain("dbNodes")
  })

  it("adopts only connections that already exist", () => {
    // Every branch is an existing entry's status. `connect()` returns on its
    // fast path for an entry with the same agent and working directory, so
    // adopting one starts nothing; a key with no entry is left asleep, which is
    // what keeps a restored board from spawning agents behind the user's back.
    const view = read(VIEW)
    const start = view.indexOf("const adoptedLiveRef")
    const body = view.slice(start, view.indexOf("}, [connectionStore", start))
    expect(body).toMatch(/status === "connected"/)
    expect(body).toMatch(/status === "prompting"/)
    expect(body).toMatch(/status === "connecting"/)
    expect(body).not.toContain("activateSurface(")
  })
})
