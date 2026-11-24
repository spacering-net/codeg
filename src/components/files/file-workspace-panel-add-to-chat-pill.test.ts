import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const panelSource = readFileSync(
  resolve(process.cwd(), "src/components/files/file-workspace-panel.tsx"),
  "utf8"
)

// The pill's placement only misbehaves against a real Monaco layout (see
// add-to-chat-pill-placement.test.ts for the decision itself), so these guard
// the wiring that unit tests cannot reach: that the decision is fed Monaco's
// own viewport-relative measurements, and that it is re-run on every event that
// invalidates it.
describe("file-workspace-panel add-to-chat pill placement wiring", () => {
  it("keeps the pill in the editor's overflow layer", () => {
    // Without this the editor's own scrollbar paints over the pill near the
    // right edge, and the node shrink-to-fits to min-content.
    expect(panelSource).toMatch(/allowEditorOverflow: true/)
  })

  it("feeds the placement helper the viewport-relative anchor offset", () => {
    // Not the raw `getTopForPosition`: that is content-relative, and dropping
    // the scrollTop term silently reinstates the bug for every scrolled file.
    expect(panelSource).toMatch(
      /getTopForPosition\([\s\S]{0,200}anchorTop < 0 \? null : anchorTop - editor\.getScrollTop\(\)/
    )
    expect(panelSource).toMatch(
      /spaceBelowPx:[\s\S]{0,120}editor\.getLayoutInfo\(\)\.height - \(spaceAbovePx \+ lineHeightPx\)/
    )
    expect(panelSource).toMatch(
      /pillHeightPx: measuredHeight \|\| ADD_TO_CHAT_PILL_FALLBACK_HEIGHT_PX/
    )
  })

  it("withholds the widget when the helper reports nowhere to put it", () => {
    expect(panelSource).toMatch(
      /return preference\.length > 0 \? \{ position, preference \} : null/
    )
  })

  it("carries the measure-and-correct handshake on every layout path", () => {
    // Monaco decides the placement while the node is still display:none, so a
    // layout path without the remeasure re-uses a stale height — that is how a
    // live zoom (which resizes the pill without touching the selection) put the
    // pill back behind the path bar.
    expect(panelSource).toMatch(
      /const layoutPill = \(\) => \{\s*\n\s*editorInstance\.layoutContentWidget\(pill\.widget\)\s*\n\s*if \(pill\.remeasure\(\)\) editorInstance\.layoutContentWidget\(pill\.widget\)\s*\n\s*\}/
    )
    // ...and every listener goes through it rather than laying the widget out
    // directly, which is what would silently drop the remeasure again.
    const listenerBody = panelSource.slice(
      panelSource.indexOf("const refreshPill = ()"),
      panelSource.indexOf("editorInstance.onDidDispose(")
    )
    expect(listenerBody).not.toMatch(/layoutContentWidget/)
  })

  it("re-decides the placement on vertical scroll and on editor resize", () => {
    // Monaco latches the preference at layout time, so a visible pill keeps a
    // stale choice until something lays it out again. Scroll changes the room
    // above the anchor; a layout change (terminal splitter, zoom) changes the
    // room below it and the pill's own height.
    expect(panelSource).toMatch(
      /const relayoutPill = \(\) => \{\s*\n\s*if \(pill\.isVisible\(\)\) layoutPill\(\)/
    )
    expect(panelSource).toMatch(
      /onDidScrollChange\(\(event\) => \{\s*\n\s*if \(event\.scrollTopChanged\) relayoutPill\(\)/
    )
    expect(panelSource).toMatch(/onDidLayoutChange\(relayoutPill\)/)
  })

  it("does not use Monaco's EXACT preference", () => {
    // For an overflowing widget Monaco's EXACT coordinate omits the scrollLeft
    // term, which throws the pill outside a horizontally scrolled editor.
    expect(panelSource).not.toMatch(/ContentWidgetPositionPreference\.EXACT/)
  })

  it("disposes both placement listeners with the rest of the teardown", () => {
    expect(panelSource).toMatch(
      /scrollListenerRef\.current\?\.dispose\(\)\s*\n\s*scrollListenerRef\.current = null/
    )
    expect(panelSource).toMatch(
      /layoutListenerRef\.current\?\.dispose\(\)\s*\n\s*layoutListenerRef\.current = null/
    )
  })
})
