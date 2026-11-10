import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  adaptMessageTurn,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"

import { ContentPartsRenderer } from "./content-parts-renderer"
import {
  isTurnErrorGroup,
  type ResolvedMessageGroup,
} from "./message-list-view"

/**
 * A failed turn closes on one muted line in the agent's own words — the
 * `turn_error` block a parser reads from the agent's record of the failure,
 * and the live stream appends when the adapter reports it. It must read as the
 * failure, never as a reply or as the yellow "System message" box.
 */

function group(parts: AdaptedContentPart[]): ResolvedMessageGroup {
  return { id: "g", role: "system", parts, resources: [], images: [] }
}

describe("a failed turn's line", () => {
  it("adapts a turn_error block into a turn-error part", () => {
    const adapted = adaptMessageTurn(
      {
        id: "turn-3",
        role: "system",
        blocks: [{ type: "turn_error", message: "API Error: 503" }],
        timestamp: "2026-10-10T00:00:00Z",
      },
      {
        attachedResources: "Attached resources",
        toolCallFailed: "Tool failed",
        pageHandoffName: () => "",
      }
    )
    expect(adapted.content).toEqual([
      { type: "turn-error", message: "API Error: 503" },
    ])
  })

  it("renders as a note carrying the agent's words", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ContentPartsRenderer
          parts={[
            {
              type: "turn-error",
              message: "stream disconnected before completion",
            },
          ]}
          role="system"
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("note")).toHaveTextContent(
      "Turn failed: stream disconnected before completion"
    )
  })

  it("is a system group of its own only when nothing else is in it", () => {
    const line: AdaptedContentPart = { type: "turn-error", message: "x" }
    expect(isTurnErrorGroup(group([line]))).toBe(true)
    expect(isTurnErrorGroup(group([line, { type: "text", text: "y" }]))).toBe(
      false
    )
    expect(isTurnErrorGroup(group([]))).toBe(false)
  })
})
