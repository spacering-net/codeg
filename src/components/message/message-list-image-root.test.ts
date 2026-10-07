import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")

function sourceFiles(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
        ? [path]
        : []
    }
  )
}

/**
 * Every transcript surface must hand `MessageListView` the cwd it renders
 * Markdown images against.
 *
 * `MessageListView` falls back to the path of the folder its persisted detail
 * names, but that fallback is strictly weaker than what each host already
 * knows: a canvas draft's first reply has no persisted detail at all, and a
 * delegation child runs in a scratch dir whose folder row is created closed
 * and without a `folder://changed` broadcast, so it is missing from this
 * client's `allFolders`. In both cases the fallback yields null and the
 * transcript's local screenshots never load.
 *
 * Passing `undefined` is how a host opts back INTO the fallback — this asks
 * only that the decision was made, not which way it went.
 */
const SURFACES = [
  "src/components/conversations/conversation-detail-panel.tsx",
  "src/components/canvas/canvas-conversation-surface.tsx",
  "src/components/message/live-transcript-view.tsx",
]

describe("MessageListView image root", () => {
  it("is decided by every surface that mounts a transcript", () => {
    // The list is derived, not maintained by hand: a new mount fails here
    // until it is added — and adding it forces the `imageRoot` decision below.
    const mounts = sourceFiles("src/components").filter((path) =>
      read(path).includes("<MessageListView")
    )
    expect(mounts.sort()).toEqual([...SURFACES].sort())
  })

  it.each(SURFACES)("%s passes an imageRoot", (path) => {
    const source = read(path)
    const start = source.indexOf("<MessageListView")
    expect(start).toBeGreaterThan(-1)
    // One mount per surface today; a second would need its own decision, so
    // assert that rather than silently checking only the first.
    expect(source.indexOf("<MessageListView", start + 1)).toBe(-1)
    const openingTag = source.slice(start, source.indexOf("/>", start))
    expect(openingTag).toMatch(/\bimageRoot=/)
  })
})
