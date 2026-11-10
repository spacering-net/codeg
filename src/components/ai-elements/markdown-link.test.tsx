import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LinkSafetyModalProps } from "streamdown"

const mocks = vi.hoisted(() => ({
  onLinkCheck: vi.fn<(url: string) => boolean | Promise<boolean>>(),
  renderModal: vi.fn((props: LinkSafetyModalProps) =>
    props.isOpen ? <div data-testid="link-modal">{props.url}</div> : null
  ),
}))

vi.mock("next-intl", () => {
  const t = (key: string) => key
  return { useTranslations: () => t }
})
vi.mock("@/hooks/use-open-url-target", () => ({
  useOpenUrlTarget: () => () => ({ kind: "system", url: "" }),
  isPrimaryModifier: () => false,
}))
vi.mock("./link-safety", async (importOriginal) => {
  // Only the streamdown hook is stubbed — `parseLocalFileTarget` stays real, so
  // the file badge's hover-actions anchor wraps it exactly as it would in the app.
  const actual = await importOriginal<typeof import("./link-safety")>()
  return {
    ...actual,
    useStreamdownLinkSafety: () => ({
      enabled: true,
      onLinkCheck: mocks.onLinkCheck,
      renderModal: mocks.renderModal,
    }),
  }
})

import { MarkdownLink } from "./markdown-link"

describe("MarkdownLink", () => {
  beforeEach(() => {
    mocks.onLinkCheck.mockReset()
    mocks.renderModal.mockClear()
    vi.spyOn(window, "open").mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ["https://example.com", "web"],
    ["file:///repo/src/app.ts", "file"],
    ["/repo/src/app.ts", "file"],
    ["mailto:hi@example.com", "email"],
    ["tel:+15550100", "phone"],
  ])("tags %s with a %s type icon", (href, kind) => {
    render(<MarkdownLink href={href}>{href}</MarkdownLink>)

    const button = screen.getByRole("button")
    expect(button).toHaveAttribute("data-resource-kind", kind)
    // The lucide icon renders an inline svg before the link text.
    expect(button.querySelector("svg")).not.toBeNull()
  })

  it.each([["#section"], ["src/main.rs"], ["vscode://file/repo/src/app.ts"]])(
    "renders %s without a type icon",
    (href) => {
      render(<MarkdownLink href={href}>{href}</MarkdownLink>)

      const button = screen.getByRole("button")
      expect(button).not.toHaveAttribute("data-resource-kind")
      expect(button.querySelector("svg")).toBeNull()
    }
  )

  it("opens an approved external link inside the click's own call stack", () => {
    mocks.onLinkCheck.mockReturnValue(true)

    render(<MarkdownLink href="https://example.com/docs">docs</MarkdownLink>)
    fireEvent.click(screen.getByRole("button"))

    // Asserted with NO await/waitFor, deliberately — this is the regression
    // test for #410. jsdom can't model browser user activation, but it can
    // model "same task as the click", which is the invariant WebKit's popup
    // blocker actually keys off. Awaiting the (synchronous) safety verdict put
    // window.open one microtask late, and Safari / WKWebView-backed webviews
    // silently swallowed the popup. Don't "fix" this by adding waitFor.
    expect(window.open).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noreferrer"
    )
    expect(screen.queryByTestId("link-modal")).not.toBeInTheDocument()
  })

  it("routes declined links through the link-safety modal hook, in the same task", () => {
    mocks.onLinkCheck.mockReturnValue(false)

    render(<MarkdownLink href="file:///repo/src/app.ts">app.ts</MarkdownLink>)
    fireEvent.click(screen.getByRole("button"))

    expect(screen.getByTestId("link-modal")).toBeInTheDocument()
    expect(window.open).not.toHaveBeenCalled()
  })

  // Streamdown's contract also allows an async check. codeg's own config never
  // returns a promise, but the fallback has to keep working — it just can't
  // preserve the user gesture (openLinkWithSafety documents why).
  it("still opens on a promise verdict, one microtask late", async () => {
    mocks.onLinkCheck.mockReturnValue(Promise.resolve(true))

    render(<MarkdownLink href="https://example.com/async">docs</MarkdownLink>)
    fireEvent.click(screen.getByRole("button"))

    expect(window.open).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(window.open).toHaveBeenCalledWith(
        "https://example.com/async",
        "_blank",
        "noreferrer"
      )
    })
  })

  // The promises are built lazily: an eagerly-rejected one in the table would
  // go unhandled during collection, long before the test attaches a handler.
  it.each([
    ["declining", () => Promise.resolve(false)],
    // A rejected check must still land somewhere — declining beats leaving the
    // click with no outcome and an unhandled rejection.
    ["rejected", () => Promise.reject(new Error("check failed"))],
  ])(
    "falls back to the modal hook on a %s promise verdict",
    async (_, make) => {
      mocks.onLinkCheck.mockReturnValue(make())

      render(<MarkdownLink href="file:///repo/src/app.ts">app.ts</MarkdownLink>)
      fireEvent.click(screen.getByRole("button"))

      await waitFor(() => {
        expect(screen.getByTestId("link-modal")).toBeInTheDocument()
      })
      expect(window.open).not.toHaveBeenCalled()
    }
  )

  describe("codeg:// reference badges", () => {
    it("renders a session link as a session badge (conversation glyph, no agent icon or status dot)", () => {
      render(
        <MarkdownLink href="codeg://session/codex_abc">My chat</MarkdownLink>
      )
      // It's a badge, not a clickable link.
      expect(screen.queryByRole("button")).toBeNull()
      const badge = screen.getByRole("img", { name: "session: My chat" })
      expect(badge).toHaveAttribute("data-reference-badge")
      expect(badge).toHaveAttribute("data-ref-type", "session")
      // Even though the codex agent type is recoverable from the uri, the inline
      // transcript badge shows the neutral conversation glyph — not the owning
      // agent's icon (an AgentIcon svg would carry <title>Codex</title>) — and no
      // trailing status dot. (User messages mirror the composer badge.)
      expect(badge.querySelector(".lucide-message-square")).not.toBeNull()
      expect(badge.querySelector("title")).toBeNull()
      expect(badge.querySelector(".rounded-full")).toBeNull()
    })

    it("renders a legacy numeric session link as a session badge", () => {
      render(<MarkdownLink href="codeg://session/123">Login</MarkdownLink>)
      const badge = screen.getByRole("img", { name: "session: Login" })
      expect(badge).toHaveAttribute("data-ref-type", "session")
    })

    it("renders a commit link as a commit badge", () => {
      render(
        <MarkdownLink href="codeg://commit/%2Frepo@abc1234def">
          abc1234
        </MarkdownLink>
      )
      const badge = screen.getByRole("img", { name: "commit: abc1234" })
      expect(badge).toHaveAttribute("data-ref-type", "commit")
    })

    it("renders an agent link as an agent badge", () => {
      render(<MarkdownLink href="codeg://agent/codex">@Codex</MarkdownLink>)
      const badge = screen.getByRole("img", { name: "agent: Codex" })
      expect(badge).toHaveAttribute("data-ref-type", "agent")
      expect(badge.querySelector("svg")).not.toBeNull()
    })

    it("leaves a non-reference codeg uri as a normal link", () => {
      render(<MarkdownLink href="codeg://unknown/x">x</MarkdownLink>)
      expect(screen.getByRole("button")).toBeInTheDocument()
    })
  })

  describe("file reference badges", () => {
    it("renders a file link as a clickable inline file badge", () => {
      render(<MarkdownLink href="file:///repo/app.ts">app.ts</MarkdownLink>)
      // Clickable: a button wraps the badge (opens in the workspace panel).
      const button = screen.getByRole("button")
      expect(button).toHaveAttribute("data-resource-kind", "file")
      // …whose vertical-align is centered (mirrors ReferenceBadge), not baseline.
      expect(button.className).toContain("align-middle")
      // `appearance-none` + `leading-none` strip the button's UA strut and the
      // inherited surrounding-text line-height so it lays out like the bare
      // badge; `-translate-y` then lifts the chip from the x-height midline onto
      // the line's optical center (WebKit/CJK otherwise read it low). See
      // MarkdownLink's file branch.
      expect(button.className).toContain("appearance-none")
      expect(button.className).toContain("leading-none")
      expect(button.className).toContain("-translate-y-[1.5px]")
      // It reads as a file badge, matching the inline `@`-file chips.
      const badge = screen.getByRole("img", { name: "file: app.ts" })
      expect(badge).toHaveAttribute("data-reference-badge")
      expect(badge).toHaveAttribute("data-ref-type", "file")
    })

    it("wraps the badge in the hover anchor that pops its file actions", () => {
      const { container } = render(
        <MarkdownLink href="file:///repo/app.ts">app.ts</MarkdownLink>
      )
      const hoverAnchor = container.querySelector("[data-file-actions]")
      expect(hoverAnchor).not.toBeNull()
      expect(hoverAnchor?.contains(screen.getByRole("button"))).toBe(true)
    })

    it("adds no hover anchor to a web link", () => {
      const { container } = render(
        <MarkdownLink href="https://example.com">docs</MarkdownLink>
      )
      expect(container.querySelector("[data-file-actions]")).toBeNull()
    })

    it("routes a file badge click through the link-safety modal hook", () => {
      mocks.onLinkCheck.mockReturnValue(false)

      render(<MarkdownLink href="/repo/src/app.ts">app.ts</MarkdownLink>)
      fireEvent.click(screen.getByRole("button"))

      expect(screen.getByTestId("link-modal")).toBeInTheDocument()
      expect(window.open).not.toHaveBeenCalled()
    })
  })

  describe("embedded attachment badges", () => {
    it("renders a codeg://embedded link as an inert file badge", () => {
      // Path-less pasted bytes serialize to this inert display uri; the badge
      // name is the link text the composer wrote.
      render(
        <MarkdownLink href="codeg://embedded/abc-123">report.pdf</MarkdownLink>
      )
      // It's a badge, not a clickable link (nothing to open — bytes are
      // appended out of band as a resource block on send).
      expect(screen.queryByRole("button")).toBeNull()
      const badge = screen.getByRole("img", { name: "file: report.pdf" })
      expect(badge).toHaveAttribute("data-reference-badge")
      expect(badge).toHaveAttribute("data-ref-type", "file")
    })
  })
})
