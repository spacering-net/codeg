import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Geometry guards for the right-side drawer stack.
 *
 * These panels open ON TOP OF each other — the session viewer over the task
 * detail sheet, a delegation viewer over another one — so their width and their
 * gutters are properties of the STACK, not of any one panel. Both invariants
 * below are the kind that regress silently: nothing breaks, the panels just
 * stop lining up.
 */

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

/** Every drawer that participates in the side-panel stack. */
const SIDE_PANELS = [
  "src/components/tasks/task-detail-sheet.tsx",
  "src/components/tasks/task-transcript-dialog.tsx",
  "src/components/message/sub-agent-session-dialog.tsx",
  "src/components/message/subagent-session-dialog.tsx",
  "src/components/forge/forge-issue-detail-sheet.tsx",
  "src/components/canvas/canvas-conversation-drawer.tsx",
  // Opens over any of the transcript viewers above (a file badge clicked in
  // one), so it is part of the same stack.
  "src/components/files/file-viewer-drawer.tsx",
]

/** The `<DrawerContent …>` opening tag — where a width would be declared. */
function drawerContentTag(source: string): string {
  const match = source.match(/<DrawerContent\b[\s\S]*?>/)
  return match?.[0] ?? ""
}

describe("side panel width", () => {
  it.each(SIDE_PANELS)(
    "takes its width from the shared constant: %s",
    (path) => {
      const tag = drawerContentTag(read(path))
      expect(tag).not.toBe("")
      expect(tag).toContain("SIDE_PANEL_CONTENT_CLASS")
      // A panel that sets its own cap juts out from under the one stacked on it,
      // on one side only, which reads as a rendering bug rather than a choice.
      expect(tag).not.toMatch(/\bmax-w-/)
    }
  )

  it("declares that width in exactly one place", () => {
    const drawer = read("src/components/ui/drawer.tsx")
    expect(drawer).toContain("const SIDE_PANEL_CONTENT_CLASS")
    expect(drawer.match(/sm:max-w-\[[\d.]+rem\]/g)).toHaveLength(1)
  })
})

describe("transcript inside a side panel", () => {
  const liveTranscript = read("src/components/message/live-transcript-view.tsx")
  const virtualized = read(
    "src/components/message/virtualized-message-thread.tsx"
  )

  /**
   * The gutter belongs to the message list, and only to it. A wrapper that adds
   * its own doubles it — 32px a side instead of 16 — which the full-width chat
   * column absorbs unnoticed and a 36rem drawer very much does not.
   */
  it("does not re-pad a transcript the virtualizer already insets", () => {
    // The layer that owns the gutter, and the reason the wrapper must not.
    expect(virtualized).toContain('"mx-auto max-w-3xl px-4"')
    expect(virtualized).toContain("padding = 16")

    const listIdx = liveTranscript.indexOf("<MessageListView")
    expect(listIdx).toBeGreaterThan(-1)
    const openIdx = liveTranscript.lastIndexOf('<div className="', listIdx)
    expect(openIdx).toBeGreaterThan(-1)
    const start = openIdx + '<div className="'.length
    const wrapperClass = liveTranscript.slice(
      start,
      liveTranscript.indexOf('"', start)
    )

    expect(wrapperClass).toContain("min-h-0")
    expect(wrapperClass).not.toMatch(/(^|\s)p[xytbrsel]?-/)
  })

  it("aligns both viewer headers with that gutter", () => {
    // 16px, like the rows below them — `px-5` left the header's agent icon a
    // few pixels adrift of the column it titles. (`pr-12` clears the close
    // button and is unrelated.)
    for (const path of [
      "src/components/message/sub-agent-session-dialog.tsx",
      "src/components/tasks/task-transcript-dialog.tsx",
    ]) {
      expect(read(path)).toContain("border-b border-border px-4 py-2.5 pr-12")
    }
  })
})
