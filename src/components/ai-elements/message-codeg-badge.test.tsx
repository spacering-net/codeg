import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// Exercise the REAL Streamdown pipeline (no streamdown mock) so the assertion
// covers actual rehype sanitize + harden behavior — the layer that previously
// stripped `codeg://` hrefs and rendered them as "[blocked]". The isolated
// MarkdownLink unit test runs after that layer, so it could not catch the
// regression. Only the link-safety hook is stubbed (irrelevant to badges).
//
// These are ASSISTANT-path guards: `codeg://` reference links render as inline
// badges via MarkdownLink + rehype-allow-codeg regardless of role. (User messages
// no longer go through MessageResponse — see message/plain-text-with-badges.tsx.)
vi.mock("next-intl", () => {
  const t = (key: string) => key
  return { useTranslations: () => t }
})
vi.mock("@/hooks/use-open-url-target", () => ({
  useOpenUrlTarget: () => () => ({ kind: "system", url: "" }),
  isPrimaryModifier: () => false,
}))
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { MessageResponse } from "./message"
import { Reasoning, ReasoningContent } from "./reasoning"

describe("MessageResponse — codeg references survive sanitization (real Streamdown)", () => {
  it("renders an agent reference inline as a badge, not as '[blocked]'", async () => {
    const { container } = render(
      <MessageResponse>
        {"[@Codex CLI](codeg://agent/codex) hi"}
      </MessageResponse>
    )
    await waitFor(() => {
      expect(
        container.querySelector("[data-reference-badge][data-ref-type='agent']")
      ).not.toBeNull()
    })
    expect(container.textContent).toContain("Codex CLI")
    expect(container.textContent).toContain("hi")
    expect(container.textContent).not.toContain("[blocked]")
  })

  it("renders a session reference inline as a badge", async () => {
    const { container } = render(
      <MessageResponse>
        {"see [#42](codeg://session/claude_code_abc)"}
      </MessageResponse>
    )
    await waitFor(() => {
      expect(
        container.querySelector(
          "[data-reference-badge][data-ref-type='session']"
        )
      ).not.toBeNull()
    })
    expect(container.textContent).toContain("see")
    expect(container.textContent).not.toContain("[blocked]")
  })

  it("renders a commit reference inline as a badge", async () => {
    const { container } = render(
      <MessageResponse>
        {"[a1b2c3d](codeg://commit/%2Frepo@a1b2c3ddeadbeef)"}
      </MessageResponse>
    )
    await waitFor(() => {
      expect(
        container.querySelector(
          "[data-reference-badge][data-ref-type='commit']"
        )
      ).not.toBeNull()
    })
    expect(container.textContent).toContain("a1b2c3d")
    expect(container.textContent).not.toContain("[blocked]")
  })

  it("still renders a plain http link as a button (regression guard for non-codeg links)", async () => {
    const { container } = render(
      <MessageResponse>{"[docs](https://example.com)"}</MessageResponse>
    )
    await waitFor(() => {
      expect(container.querySelector("[data-streamdown='link']")).not.toBeNull()
    })
    expect(container.textContent).toContain("docs")
    expect(container.textContent).not.toContain("[blocked]")
    // Not mistaken for a reference badge.
    expect(container.querySelector("[data-reference-badge]")).toBeNull()
  })
})

describe("ReasoningContent — codeg references survive sanitization (real Streamdown)", () => {
  // The reasoning panel runs its own Streamdown, so it needs the same sanitize
  // allowance as MessageResponse or a reference there still reads "[blocked]".
  it("renders an agent reference inline as a badge, not as '[blocked]'", async () => {
    const { container } = render(
      <Reasoning isStreaming={false} defaultOpen>
        <ReasoningContent>
          {"[@Codex CLI](codeg://agent/codex) hi"}
        </ReasoningContent>
      </Reasoning>
    )
    await waitFor(() => {
      expect(
        container.querySelector("[data-reference-badge][data-ref-type='agent']")
      ).not.toBeNull()
    })
    expect(container.textContent).toContain("Codex CLI")
    expect(container.textContent).toContain("hi")
    expect(container.textContent).not.toContain("[blocked]")
  })
})
