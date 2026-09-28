import { fireEvent, render, waitFor } from "@testing-library/react"
import type { ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Links in text that is still streaming. Exercises the REAL Streamdown pipeline
// (no streamdown mock): remend repairs the unclosed link at the tail, sanitize
// + harden decide what survives of it, and Streamdown memoizes each list item,
// paragraph and heading by its source span — the three together are what used
// to leave a link reading "[blocked]". Only the leaf dependencies of the real
// link-safety hook are stubbed, so a click on the finished badge genuinely
// reaches `openFilePreview`.
const mocks = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
  openUrl: vi.fn(),
  toastError: vi.fn(),
  isDesktop: vi.fn(() => false),
  getActiveRemoteConnectionId: vi.fn(() => null),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}))

vi.mock("@/lib/platform", () => ({
  openUrl: mocks.openUrl,
}))

vi.mock("@/lib/transport", () => ({
  isDesktop: mocks.isDesktop,
  getActiveRemoteConnectionId: mocks.getActiveRemoteConnectionId,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { path: "/repo" } }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => null,
  useWorkspaceActions: () => ({ openFilePreview: mocks.openFilePreview }),
}))

import { MessageResponse } from "./message"
import { Reasoning, ReasoningContent } from "./reasoning"

// The two live surfaces, each rendering `text` as a turn in progress does.
const SURFACES: Array<[string, (text: string) => ReactElement]> = [
  [
    "reply",
    (text) => (
      <MessageResponse mode="streaming" parseIncompleteMarkdown>
        {text}
      </MessageResponse>
    ),
  ],
  [
    "reasoning",
    (text) => (
      <Reasoning isStreaming defaultOpen>
        <ReasoningContent>{text}</ReasoningContent>
      </Reasoning>
    ),
  ],
]

function fileBadge(container: HTMLElement, label: string): HTMLButtonElement {
  const badge = Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      "button[data-resource-kind='file']"
    )
  ).find((button) => button.textContent?.includes(label))
  if (!badge) throw new Error(`expected a clickable file badge for ${label}`)
  return badge
}

describe("links in text that is still streaming (real Streamdown)", () => {
  beforeEach(() => {
    mocks.openFilePreview.mockReset()
    mocks.openFilePreview.mockResolvedValue(undefined)
    mocks.toastError.mockReset()
    mocks.isDesktop.mockReturnValue(false)
    mocks.getActiveRemoteConnectionId.mockReturnValue(null)
    vi.spyOn(window, "open").mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(SURFACES)(
    "shows a link that has not closed yet as its text, not '[blocked]' (%s)",
    async (_, live) => {
      const { container } = render(live("见 [a.ts](src/a.t"))

      await waitFor(() => {
        expect(container.textContent).toContain("a.ts")
      })
      expect(container.textContent).not.toContain("[blocked]")
    }
  )

  // `src/components/abc/def.tsx` is 26 characters, exactly as long as the
  // placeholder remend's default puts in place of an unclosed destination, so
  // the element holding the link spans the same source before and after the
  // `)` arrives.
  const PLACES: Array<[string, string]> = [
    ["a list item", "- [def.tsx](src/components/abc/def.tsx)\n- [b](a.ts:12)"],
    [
      "an ordered list item",
      "1. [def.tsx](src/components/abc/def.tsx)\n2. [b](a.ts:12)",
    ],
    ["a paragraph", "见 [def.tsx](src/components/abc/def.tsx)"],
    ["a heading", "## [def.tsx](src/components/abc/def.tsx)"],
  ]

  describe.each(SURFACES)("%s", (_, live) => {
    it.each(PLACES)(
      "turns a link ending %s into its badge as soon as it closes",
      async (_, text) => {
        const { container, rerender } = render(
          live(text.slice(0, text.indexOf(".tsx)")))
        )
        await waitFor(() => {
          expect(container.textContent).toContain("def.tsx")
        })

        rerender(live(text))
        await waitFor(() => {
          expect(fileBadge(container, "def.tsx")).toBeTruthy()
        })
        expect(container.textContent).not.toContain("[blocked]")

        expect(mocks.openFilePreview).not.toHaveBeenCalled()
        fireEvent.click(fileBadge(container, "def.tsx"))
        await waitFor(() => {
          expect(mocks.openFilePreview).toHaveBeenCalledWith(
            "src/components/abc/def.tsx",
            { line: undefined }
          )
        })
        expect(mocks.openFilePreview).toHaveBeenCalledTimes(1)
      }
    )
  })

  it("keeps the placeholder out when a caller passes remend options", async () => {
    const { container } = render(
      <MessageResponse
        mode="streaming"
        parseIncompleteMarkdown
        remend={{ linkMode: "protocol" }}
      >
        {"见 [a.ts](src/a.t"}
      </MessageResponse>
    )

    await waitFor(() => {
      expect(container.textContent).toContain("a.ts")
    })
    expect(container.textContent).not.toContain("[blocked]")
  })

  it("still applies a caller's other remend options", async () => {
    const { container } = render(
      <MessageResponse
        mode="streaming"
        parseIncompleteMarkdown
        remend={{ inlineCode: false }}
      >
        {"run `pnpm te"}
      </MessageResponse>
    )

    // Left unrepaired, the backtick stays literal instead of opening code.
    await waitFor(() => {
      expect(container.textContent).toContain("run `pnpm te")
    })
    expect(container.querySelector("code")).toBeNull()
  })
})
