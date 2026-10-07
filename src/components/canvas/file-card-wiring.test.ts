import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * How a file card on the board relates to the workspace's file tabs.
 *
 * It is a VIEW of the ordinary tab, not a second file system — that is what
 * gets it the content cache, the external-change watcher and the markdown /
 * source toggle for free, and what keeps three surfaces (the file column, the
 * transcript's viewer drawer, this card) from ever disagreeing about what a
 * given file holds.
 *
 * The one thing it must NOT inherit is the ordinary open's side effects: a
 * board can hold a dozen file cards and re-opens all of them on every visit to
 * the route, so an open that brings the (covered) files pane forward and
 * re-points its selection would rearrange a workspace the user isn't looking
 * at, a dozen times, for nothing.
 *
 * Read from source: the card needs a ReactFlow store, the canvas provider and
 * the whole workspace provider stack to mount, the same reason
 * `card-reentry.test.ts` is written this way.
 */

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const CARD = "src/components/canvas/nodes/file-node.tsx"
const WORKSPACE = "src/contexts/workspace-context.tsx"
const SHARED_VIEW = "src/components/files/file-document-view.tsx"
const DRAWER = "src/components/files/file-viewer-drawer.tsx"

describe("the canvas file card", () => {
  it("opens its tab in the background, never in the foreground", () => {
    const card = read(CARD)
    expect(card).toContain("openFilePreview")
    expect(card).toContain("background: true")
  })

  it("refreshes through the dirty-safe path, never a clobbering reload", () => {
    // `openFilePreview(..., { reload: true })` overwrites the buffer, which
    // would throw away edits someone made to the same tab in the file column.
    // The card is read-only, so it has no business winning that race.
    const card = read(CARD)
    expect(card).toContain("reloadOpenFileBackground")
    expect(card).not.toContain("reload: true")
    // …and the button is hidden rather than dead when there is nothing safe to
    // re-read (an office tab holds a live watch, not bytes).
    expect(card).toContain('tab.language !== "office"')
    expect(card).toContain("tab.isDirty !== true")
  })

  it("has a background open that leaves the pane and the reveal alone", () => {
    // Three side effects to suppress, all of them invisible from the canvas:
    // the pane switch, the selection move, and a pending reveal some other
    // opener is waiting on.
    const workspace = read(WORKSPACE)
    expect(workspace).toContain(
      "const background = options?.background === true"
    )
    expect(workspace).toContain(
      "setActiveFileTabId((prev) => prev ?? nextTab.id)"
    )
    // The selection is still claimed when nothing holds it, so "tabs exist but
    // none is active" never becomes reachable.
    expect(workspace).toContain("setActiveFileTabId((prev) => prev ?? tabId)")
    // The reveal is armed only on a foreground open.
    expect(workspace).toContain("if (!background) {")
  })

  it("renders through the same branch table the drawer uses", () => {
    // Code, images and the office trio all come from one component; a second
    // copy of that branch is how two surfaces end up disagreeing about, say,
    // whether a .docx is text.
    const shared = read(SHARED_VIEW)
    for (const marker of [
      'tab.language === "image"',
      'tab.language === "office"',
      "isHtmlPreviewable(tab.path)",
      'tab.language === "markdown"',
      "<SourceView",
    ]) {
      expect(shared).toContain(marker)
    }
    expect(read(CARD)).toContain("<FileDocumentView")
    expect(read(DRAWER)).toContain("<FileDocumentView")
  })

  it("keeps the source view's size ceiling", () => {
    // `CodeBlockContent` builds one DOM node per line with no virtualization;
    // the ceiling is what stops a generated file from locking the board up.
    const shared = read(SHARED_VIEW)
    expect(shared).toContain("SOURCE_VIEW_MAX_BYTES")
    expect(shared).toContain("SOURCE_VIEW_MAX_LINES")
    expect(shared).toContain("tooLargeToPreview")
  })

  it("resolves the preview root the same way the file column does", () => {
    // Markdown/HTML sub-resources resolve against the owning registered folder
    // when the file sits in one, else its own directory. Getting this wrong
    // silently breaks every relative image in a previewed document.
    const card = read(CARD)
    expect(card).toContain("findOwningFolder")
    expect(card).toContain("io?.rootPath")
  })

  it("does not edit", () => {
    // The card is for reading. A dirty buffer on a board with no save
    // affordance in sight is a trap, and the column is one click away.
    const card = read(CARD)
    expect(card).not.toContain("saveFileTab")
    expect(card).not.toContain("updateFileTabContent")
  })
})
