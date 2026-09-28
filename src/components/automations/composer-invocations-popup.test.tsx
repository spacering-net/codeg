/**
 * The `/` panel must escape its host's clipping box.
 *
 * Every host puts the composer inside something that clips: `DialogContent` is
 * `max-h-[calc(100dvh-2rem)] overflow-y-auto`, and the automation editor's form
 * scrolls. As an ordinary absolutely-positioned child the panel was cut off at
 * the dialog's edge whenever the composer sat low in it — z-index cannot beat
 * `overflow`. These pin the two properties that fix it: the panel is portalled
 * out to the body and positioned against the viewport, and it re-enables its own
 * pointer events (a modal Radix layer sets `pointer-events: none` on the body,
 * which would otherwise make the panel click-dead and turn a press on it into an
 * outside-press that closes the host).
 */
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { AvailableCommandInfo } from "@/lib/types"

import {
  ComposerInvocationsPopup,
  type ComposerInvocations,
} from "./composer-invocations"

function invocations(
  overrides: Partial<ComposerInvocations> = {}
): ComposerInvocations {
  const commands: AvailableCommandInfo[] = [
    { name: "mcp", description: "List configured MCP tools." },
    { name: "skills", description: "List available skills." },
  ]
  return {
    isOpen: true,
    commands,
    skills: [],
    knownInvocations: new Set(commands.map((cmd) => `/${cmd.name}`)),
    activeIndex: 0,
    detect: () => {},
    onKeyDown: () => false,
    selectCommand: () => {},
    selectSkill: () => {},
    ...overrides,
  }
}

/** The shape every host uses: the popup inside the composer's chrome box. */
function renderInHost(inv: ComposerInvocations) {
  return render(
    <div data-testid="composer-chrome" className="relative">
      <ComposerInvocationsPopup inv={inv} />
      <textarea aria-label="composer" />
    </div>
  )
}

describe("ComposerInvocationsPopup", () => {
  it("portals the panel out of the composer box", () => {
    const { getByTestId } = renderInHost(invocations())

    const row = screen.getByText("/mcp")
    const chrome = getByTestId("composer-chrome")
    // Rendering inside the chrome is what the clipping ancestor could cut off.
    expect(chrome.contains(row)).toBe(false)
    expect(document.body.contains(row)).toBe(true)
  })

  it("positions against the viewport and keeps its own pointer events", () => {
    renderInHost(invocations())

    const panel = screen.getByText("/mcp").closest("div[style]") as HTMLElement
    expect(panel.style.position).toBe("fixed")
    expect(panel.style.pointerEvents).toBe("auto")
  })

  it("renders nothing while closed", () => {
    renderInHost(invocations({ isOpen: false }))
    expect(screen.queryByText("/mcp")).toBeNull()
  })
})
