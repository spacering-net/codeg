import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Codeg's Markdown link, reduced to what matters here: it opens its href on
// click, and — like its real context menu — owns a control rendered in a
// portal.
const { opened, copied } = vi.hoisted(() => ({
  opened: vi.fn(),
  copied: vi.fn(),
}))
vi.mock("@/components/ai-elements/markdown-link", async () => {
  const { createPortal } = await import("react-dom")
  return {
    MarkdownLink: ({
      href,
      children,
    }: {
      href?: string
      children?: ReactNode
    }) => (
      <>
        <button
          type="button"
          onClick={(event) => {
            if (!href) return
            event.preventDefault()
            opened(href)
          }}
        >
          {children}
        </button>
        {createPortal(
          <button type="button" onClick={() => copied(href)}>
            Copy link
          </button>,
          document.body
        )}
      </>
    ),
  }
})

import JsonRenderBlock from "./json-render-block"

const line = (patch: object) => JSON.stringify(patch)

/** A link, and a line of text showing what its `press` binding wrote. */
function linkSpec(link: { href: string; on?: object }) {
  return [
    line({ op: "add", path: "/root", value: "main" }),
    line({
      op: "add",
      path: "/elements/main",
      value: { type: "Stack", props: {}, children: ["link", "status"] },
    }),
    line({
      op: "add",
      path: "/elements/link",
      value: {
        type: "Link",
        props: { label: "Docs", href: link.href },
        ...(link.on ? { on: link.on } : {}),
      },
    }),
    line({
      op: "add",
      path: "/elements/status",
      value: { type: "Text", props: { text: { $state: "/pressed" } } },
    }),
    line({ op: "add", path: "/state/pressed", value: "no" }),
  ].join("\n")
}

const PRESS = {
  press: {
    action: "setState",
    params: { statePath: "/pressed", value: "yes" },
  },
}

beforeEach(() => {
  opened.mockClear()
  copied.mockClear()
})

describe("json-render Link in Codeg", () => {
  it("opens the way every chat link opens", () => {
    render(
      <JsonRenderBlock
        source={linkSpec({ href: "https://example.com/docs" })}
        fallback={null}
      />
    )
    fireEvent.click(screen.getByText("Docs"))
    expect(opened).toHaveBeenCalledWith("https://example.com/docs")
  })

  it("fires its press binding and still opens", () => {
    render(
      <JsonRenderBlock
        source={linkSpec({ href: "https://example.com/docs", on: PRESS })}
        fallback={null}
      />
    )
    expect(screen.getByText("no")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Docs"))
    expect(screen.getByText("yes")).toBeInTheDocument()
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it("stays shut when its press binding prevents the default", () => {
    render(
      <JsonRenderBlock
        source={linkSpec({
          href: "https://example.com/docs",
          on: { press: { ...PRESS.press, preventDefault: true } },
        })}
        fallback={null}
      />
    )
    fireEvent.click(screen.getByText("Docs"))
    expect(screen.getByText("yes")).toBeInTheDocument()
    expect(opened).not.toHaveBeenCalled()
  })

  it("only fires press without an href, from a control the keyboard reaches", () => {
    render(
      <JsonRenderBlock
        source={linkSpec({ href: "", on: PRESS })}
        fallback={null}
      />
    )
    const link = screen.getByRole("button", { name: "Docs" })
    fireEvent.click(link)
    expect(screen.getByText("yes")).toBeInTheDocument()
    expect(opened).not.toHaveBeenCalled()
  })

  it("is not pressed by a click in a portal it owns", () => {
    render(
      <JsonRenderBlock
        source={linkSpec({ href: "https://example.com/docs", on: PRESS })}
        fallback={null}
      />
    )
    fireEvent.click(screen.getByText("Copy link"))
    expect(screen.getByText("no")).toBeInTheDocument()
    expect(copied).toHaveBeenCalledTimes(1)
    expect(opened).not.toHaveBeenCalled()
  })
})

describe("json-render Card in Codeg", () => {
  it("draws no shadow, whatever classes the spec gives it", () => {
    const card = (key: string, props: object, children: string[] = []) =>
      line({
        op: "add",
        path: `/elements/${key}`,
        value: { type: "Card", props, children },
      })
    const { container } = render(
      <JsonRenderBlock
        source={[
          line({ op: "add", path: "/root", value: "main" }),
          card("main", { title: "Outer" }, ["inner", "note"]),
          card("inner", { maxWidth: "sm", className: "shadow-lg" }),
          line({
            op: "add",
            path: "/elements/note",
            value: { type: "Text", props: { text: "Inside" } },
          }),
        ].join("\n")}
        fallback={null}
      />
    )
    const cards = container.querySelectorAll('[data-slot="card"]')
    expect(cards).toHaveLength(2)
    for (const node of cards) {
      expect(
        [...node.classList].filter((name) => name.startsWith("shadow-"))
      ).toEqual(["shadow-none"])
    }
    // The rest is json-render's own card.
    expect(screen.getByText("Outer")).toBeInTheDocument()
    expect(screen.getByText("Inside")).toBeInTheDocument()
    expect(cards[1].classList.contains("max-w-xs")).toBe(true)
  })
})

describe("json-render fallback", () => {
  it("shows the fence as code when the spec cannot render", () => {
    render(
      <JsonRenderBlock
        source={line({
          op: "test",
          path: "/root",
          value: "something else",
        })}
        fallback={<pre>the code block</pre>}
      />
    )
    expect(screen.getByText("the code block")).toBeInTheDocument()
  })
})
