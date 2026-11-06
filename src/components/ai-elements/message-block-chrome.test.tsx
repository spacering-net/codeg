import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import postcss from "postcss"
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { useFallbackOverlayOpen } from "@/lib/browser/native-surface-occlusion"
import { Message, MessageContent, MessageResponse } from "./message"

// Streamdown's own utility classes live in node_modules, which our Tailwind
// scan skips, so a block's frame is decided by globals.css rules keyed on
// Streamdown's DOM: its `data-streamdown` attributes and the bare divs between
// them. Streamdown 2.7 reshaped that DOM — a framed wrapper around a framed
// table, a framed body and a framed actions chip inside a framed code block —
// and the rules written for 2.2 kept matching just enough to leave two borders
// on every table and code block. Each test below pins a rule to the element it
// has to reach in the REAL output (message.test.tsx mocks Streamdown away), so
// the next reshuffle fails here rather than on screen.

const stylesheet = postcss.parse(
  readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8")
)

const normalize = (selector: string) => selector.replace(/\s+/g, " ").trim()

/** Declarations of the top-level rule written with exactly this selector. */
function declarations(selector: string): Record<string, string> {
  const found: Record<string, string> = {}
  let matched = false
  stylesheet.each((node) => {
    if (node.type !== "rule") return
    if (normalize(node.selector) !== normalize(selector)) return
    matched = true
    node.walkDecls((decl) => {
      found[decl.prop] = decl.value
    })
  })
  expect(matched, `globals.css has no rule for ${selector}`).toBe(true)
  return found
}

const CODE_ROOT = '[data-streamdown="code-block"]'
const CODE_ACTIONS_POSITIONER =
  '[data-streamdown="code-block"] > div:has(> [data-streamdown="code-block-actions"])'
const CODE_TOKEN = '[data-streamdown="code-block-body"] code > span > span'
const TABLE_TOOLBAR =
  '[data-streamdown="table-wrapper"]:not([data-streamdown="table-fullscreen"] > *) > div:first-child:has(button)'
const TABLE_CARD =
  '[data-streamdown="table-wrapper"] > div:has(> [data-streamdown="table"])'
const FULLSCREEN_TABLE_CARD =
  '[data-streamdown="table-fullscreen"] > [data-streamdown="table-wrapper"] > div:has(> [data-streamdown="table"])'

const REPLY = [
  "| Scenario | Before | After |",
  "| --- | --- | --- |",
  "| WMI healthy | 16.5 s | 0.4 s |",
  "",
  "```ts",
  "export const answer: number = 42",
  "```",
].join("\n")

function renderReply() {
  return render(<MessageResponse>{REPLY}</MessageResponse>)
}

describe("MessageResponse code block chrome", () => {
  it("frames the block once: the root, never the body or the actions chip", () => {
    const { container } = renderReply()
    const root = container.querySelector(CODE_ROOT)
    const body = root?.querySelector('[data-streamdown="code-block-body"]')
    const actions = root?.querySelector(
      '[data-streamdown="code-block-actions"]'
    )
    expect(root).toBeInstanceOf(HTMLElement)
    expect(body).toBeInstanceOf(HTMLElement)
    expect(actions).toBeInstanceOf(HTMLElement)

    // The root's own `rounded-xl border` is the frame; its 2.7 padding, gap
    // and fill go, and it clips the title bar and body to its corners.
    expect(declarations(CODE_ROOT)).toMatchObject({
      gap: "0",
      padding: "0",
      overflow: "hidden",
      "background-color": "transparent",
    })
    expect(declarations('[data-streamdown="code-block-body"]')).toMatchObject({
      border: "0",
      "border-radius": "0",
    })
    expect(
      declarations('[data-streamdown="code-block-actions"]')
    ).toMatchObject({
      border: "0",
      padding: "0",
      "background-color": "transparent",
    })
  })

  it("centres the actions on the title bar through their positioner", () => {
    const { container } = renderReply()
    const root = container.querySelector(CODE_ROOT)!
    const actions = root.querySelector(
      '[data-streamdown="code-block-actions"]'
    )!
    const header = root.querySelector('[data-streamdown="code-block-header"]')!

    // The chip hangs off a bare absolutely-positioned div; the rule must land
    // on exactly that div, a direct child of the root.
    const positioners = [...container.querySelectorAll(CODE_ACTIONS_POSITIONER)]
    expect(positioners).toEqual([actions.parentElement])
    expect(actions.parentElement?.parentElement).toBe(root)
    // Language label and actions share the bar, not separate rows.
    expect(header.parentElement).toBe(root)
    expect(header.contains(actions)).toBe(false)

    const bar = declarations('[data-streamdown="code-block-header"]')
    const positioner = declarations(CODE_ACTIONS_POSITIONER)
    expect(positioner.top).toBe("0")
    expect(positioner.height).toBe(bar.height)
  })

  it("puts a code glyph in the title bar of a fence that names no language", () => {
    // Streamdown leaves the language label empty, and the bar bare on its
    // left; the glyph takes the label's place. A fence with a language keeps
    // its label and gets no glyph.
    const LABEL = '[data-streamdown="code-block-header"] > span:empty'
    const { container } = render(
      <MessageResponse>
        {["```", "retry 2/5: ECONNRESET", "```", "", "```ts", "x", "```"].join(
          "\n"
        )}
      </MessageResponse>
    )
    const [bare, named] = [
      ...container.querySelectorAll('[data-streamdown="code-block-header"]'),
    ]
    expect(bare!.getAttribute("data-language")).toBe("")
    expect(bare!.firstElementChild!.matches(LABEL)).toBe(true)
    expect(named!.firstElementChild!.textContent).toBe("ts")
    expect(named!.firstElementChild!.matches(LABEL)).toBe(false)

    const glyph = declarations(`${LABEL}::before`)
    expect(glyph).toMatchObject({
      content: '""',
      display: "block",
      "background-color": "currentColor",
    })
    // The lucide `code` glyph, as a mask in both spellings (older WebKit).
    for (const mask of [glyph.mask, glyph["-webkit-mask"]]) {
      expect(mask).toContain("d='m16 18 6-6-6-6'")
      expect(mask).toContain("d='m8 6-6 6 6 6'")
    }
  })

  it("tints the body like its title bar over a background image, a rule between them", () => {
    // Over a workspace background image the bar and the body both take the
    // translucent tint of the reply's other surfaces — the body used to stay
    // an opaque white panel — and, the two now one colour, a hairline at the
    // foot of the bar tells them apart.
    const BAR = '[data-workspace-bg="on"] [data-streamdown="code-block-header"]'
    const BODY = '[data-workspace-bg="on"] [data-streamdown="code-block-body"]'
    const { container } = render(
      <div data-workspace-bg="on">
        <MessageResponse>{REPLY}</MessageResponse>
      </div>
    )
    const root = container.querySelector(CODE_ROOT)!
    expect(
      root.querySelector('[data-streamdown="code-block-header"]')!.matches(BAR)
    ).toBe(true)
    expect(
      root.querySelector('[data-streamdown="code-block-body"]')!.matches(BODY)
    ).toBe(true)

    const bar = declarations(BAR)
    expect(bar["background-color"]).toContain("var(--ws-msg-alpha)")
    expect(declarations(BODY)["background-color"]).toBe(bar["background-color"])
    expect(bar["box-shadow"]).toBe("inset 0 -1px 0 var(--border)")
  })

  it("paints light token colours, which 2.7 leaves to an ungenerated class", async () => {
    const { container } = renderReply()

    // Once shiki has run, each token carries its light colour as `--sdm-c`.
    // Streamdown's own `text-[var(--sdm-c,inherit)]` is never generated here,
    // so this rule is the only thing that turns it into a colour.
    await waitFor(
      () => {
        const tokens = [...container.querySelectorAll(CODE_TOKEN)]
        expect(tokens.length).toBeGreaterThan(1)
        expect(
          tokens.some((token) =>
            /^#[0-9a-f]{3,8}$/i.test(
              (token as HTMLElement).style.getPropertyValue("--sdm-c").trim()
            )
          )
        ).toBe(true)
      },
      { timeout: 10_000 }
    )
    expect(declarations(CODE_TOKEN).color).toBe("var(--sdm-c, inherit)")
    // Past vitest's 5 s default, so a slow shiki load under a full-suite run
    // gets the whole wait above.
  }, 15_000)
})

describe("MessageResponse table chrome", () => {
  it("frames the table once: the scroll container, not the 2.7 wrapper", () => {
    const { container } = renderReply()
    const wrapper = container.querySelector('[data-streamdown="table-wrapper"]')
    const table = wrapper?.querySelector('[data-streamdown="table"]')
    expect(table).toBeInstanceOf(HTMLElement)

    expect([...container.querySelectorAll(TABLE_CARD)]).toEqual([
      table!.parentElement,
    ])
    expect(table!.parentElement?.parentElement).toBe(wrapper)
    expect(declarations(TABLE_CARD)).toMatchObject({
      border: "1px solid var(--border)",
      "background-color": "transparent",
    })
    expect(declarations('[data-streamdown="table-wrapper"]')).toMatchObject({
      padding: "0",
      border: "0",
      "background-color": "transparent",
    })
  })

  it("floats only the inline toolbar, and keeps the fullscreen one on screen", () => {
    const { container } = renderReply()
    const wrapper = container.querySelector(
      '[data-streamdown="table-wrapper"]'
    )!
    const inlineToolbar = wrapper.firstElementChild

    expect([...document.querySelectorAll(TABLE_TOOLBAR)]).toEqual([
      inlineToolbar,
    ])
    expect(declarations(TABLE_TOOLBAR)).toMatchObject({
      position: "absolute",
      top: "-2rem",
    })

    fireEvent.click(screen.getByTitle("View fullscreen"))

    // The fullscreen view is portaled to <body> and reuses the wrapper
    // attribute. Floating its toolbar the same way put the exit button above
    // the top of the screen.
    const fullscreen = document.querySelector(
      '[data-streamdown="table-fullscreen"]'
    )
    expect(fullscreen).toBeInstanceOf(HTMLElement)
    const exit = screen.getByTitle("Exit fullscreen")
    expect(fullscreen!.contains(exit)).toBe(true)
    expect(exit.closest(TABLE_TOOLBAR)).toBeNull()
    expect([...document.querySelectorAll(TABLE_TOOLBAR)]).toEqual([
      inlineToolbar,
    ])

    // Its card hugs the table instead of tracing the screen edge.
    const fullscreenTable = fullscreen!.querySelector(
      '[data-streamdown="table"]'
    )
    expect([...document.querySelectorAll(FULLSCREEN_TABLE_CARD)]).toEqual([
      fullscreenTable!.parentElement,
    ])
    expect(declarations(FULLSCREEN_TABLE_CARD)).toMatchObject({
      flex: "0 1 auto",
      "min-height": "0",
      padding: "0",
    })
  })

  it("takes a browser tab's page down while the table is fullscreen", async () => {
    // A browser tab is a native view painted over every DOM element, so the
    // fullscreen table (Streamdown's own portal, which holds no lease) must
    // be seen by the fallback detector or it opens behind the page.
    const overlay = renderHook(() => useFallbackOverlayOpen())
    renderReply()
    expect(overlay.result.current).toBe(false)

    await act(async () => {
      fireEvent.click(screen.getByTitle("View fullscreen"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(overlay.result.current).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByTitle("Exit fullscreen"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(overlay.result.current).toBe(false)
  })
})

describe("a message's hairlines over a background image", () => {
  const BG = '[data-workspace-bg="on"]'
  const SCOPE = `${BG} :is(.is-user, .is-assistant, .ws-msg-scope)`

  it("draws them in a tint of the text colour, not the theme's flat grey", () => {
    const { container } = render(
      <div data-workspace-bg="on">
        <Message from="user">
          <MessageContent>Sort the bindings</MessageContent>
        </Message>
        <Message from="assistant">
          <MessageContent>
            <MessageResponse>{REPLY}</MessageResponse>
          </MessageContent>
        </Message>
      </div>
    )
    // A message, the user's or the agent's, swaps the theme's --border…
    expect(declarations(SCOPE)["--border"]).toBe("var(--ws-msg-border)")
    expect(container.querySelector(".is-user")!.matches(SCOPE)).toBe(true)
    expect(container.querySelector(".is-assistant")!.matches(SCOPE)).toBe(true)
    // …for a tint of the text colour, which shows on any colour of the image
    // (the theme's opaque grey vanishes where the image is that grey).
    expect(declarations(BG)["--ws-msg-border"]).toMatch(
      /^color-mix\(in oklab, var\(--foreground\) \d+%, transparent\)$/
    )
    // The code block's frame and title bar, and the table's card, draw in it.
    const root = container.querySelector(CODE_ROOT)!
    expect(root.closest(".is-assistant")).not.toBeNull()
    expect(declarations(TABLE_CARD).border).toBe("1px solid var(--border)")
    expect(
      declarations(`${BG} [data-streamdown="code-block-header"]`)["box-shadow"]
    ).toBe("inset 0 -1px 0 var(--border)")
  })

  it("keeps the theme's grey on an engine without colour-mix", () => {
    // Else --border would be a colour-mix such an engine drops, and every
    // border in a message would fall back to the black of currentColor.
    let fallback: string | undefined
    stylesheet.walkAtRules("supports", (atRule) => {
      if (!atRule.params.startsWith("not")) return
      atRule.walkRules(BG, (rule) => {
        rule.walkDecls("--ws-msg-border", (decl) => {
          fallback = decl.value
        })
      })
    })
    expect(fallback).toBe("var(--border)")
  })
})
