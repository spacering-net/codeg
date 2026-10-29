import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { OverlayScrollbars } from "overlayscrollbars"
import postcss from "postcss"
import { useState, type ReactElement } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  StaticConnectionStoreProvider,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import {
  StaticDelegationProvider,
  type DelegationContextValue,
} from "@/contexts/delegation-context"
import {
  StaticWorkspaceActionsProvider,
  type WorkspaceActionsValue,
} from "@/contexts/workspace-context"
import {
  adaptMessageTurn,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"
import {
  fixtureLines,
  MOCKUP_ADAPTER_TEXT,
  MOCKUP_ASSISTANT_TURN,
  MOCKUP_LIVE_TURN,
  toolResult,
  toolUse,
} from "@/lib/activity/__fixtures__/mockup-turn"
import type { MessageTurn } from "@/lib/types"
import { mockTruncateLayout } from "@/test-layout"
import { CompletedTurnContent } from "../completed-turn-content"
import { MessageScrollProvider } from "../message-scroll-context"
import { resetDisclosureStore } from "./disclosure-store"

const STORE: ConnectionStoreApi = {
  getConnection: () => undefined,
  getConnectPending: () => undefined,
  getConnectError: () => undefined,
  getActiveKey: () => null,
  subscribeKey: () => () => {},
  subscribeActiveKey: () => () => {},
}
const DELEGATION: DelegationContextValue = {
  findByParentToolUseId: () => undefined,
  findByChildConversationId: () => undefined,
  findByTaskId: () => undefined,
}
const WORKSPACE = new Proxy(
  {},
  { get: () => () => {} }
) as unknown as WorkspaceActionsValue

function renderTurn(ui: ReactElement, workspace = WORKSPACE) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StaticConnectionStoreProvider store={STORE}>
        <StaticDelegationProvider value={DELEGATION}>
          <StaticWorkspaceActionsProvider value={workspace}>
            {ui}
          </StaticWorkspaceActionsProvider>
        </StaticDelegationProvider>
      </StaticConnectionStoreProvider>
    </NextIntlClientProvider>
  )
}

function partsOf(turn: MessageTurn, live = false, inProgress?: string[]) {
  return adaptMessageTurn(
    turn,
    MOCKUP_ADAPTER_TEXT,
    live,
    inProgress ? new Set(inProgress) : undefined
  ).content
}

/** The thread's current round: open, with its fold owned here (as
 *  `message-list-view` owns it in the app). */
function CurrentRound({
  parts,
  durationMs,
  completed,
}: {
  parts: AdaptedContentPart[]
  durationMs?: number
  completed: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <CompletedTurnContent
      parts={parts}
      durationMs={durationMs}
      completed={completed}
      currentRound
      roundOpen={open}
      onRoundOpenChange={setOpen}
    />
  )
}

function renderSettled(parts: AdaptedContentPart[], durationMs = 214000) {
  return renderTurn(
    <CurrentRound parts={parts} durationMs={durationMs} completed />
  )
}

/** The header's fold control: its label. */
const foldControl = (label = "Activity") =>
  screen.getByRole("button", { name: label })

/** The capsule itself — the line the label, the figures and the time share. */
const activityHeader = () =>
  document.querySelector<HTMLElement>("div.activity-capsule")!

/** The timeline row whose header contains `text`. */
function rowOf(text: string | RegExp): HTMLElement {
  const row = screen.getByText(text).closest("li")
  if (!row) throw new Error(`no row for ${String(text)}`)
  return row as HTMLElement
}

/** A reply that is all process: prose, then a call that failed, and no answer
 *  after it — so its header has nothing to fold away. */
const STOPPED_ON_FAILURE: MessageTurn = {
  id: "turn-stopped",
  role: "assistant",
  timestamp: "2026-10-22T09:02:00Z",
  blocks: [
    { type: "text", text: "Checking the build before I change anything." },
    toolUse("s1", "Bash", { command: "pnpm --filter web build" }),
    toolResult(
      "s1",
      "Failed to compile.\n[terminal exited: exit code: 1]",
      true
    ),
  ],
}

/** A declaration in globals.css, by one of its rule's selectors (whitespace
 *  folded). */
function globalsDecl(selector: string, prop: string): string | undefined {
  let value: string | undefined
  postcss
    .parse(readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8"))
    .walkRules((rule) => {
      const listed = rule.selectors.map((one) => one.replace(/\s+/g, " "))
      if (!listed.includes(selector)) return
      rule.walkDecls(prop, (decl) => {
        value = decl.value
      })
    })
  return value
}

/** A length from globals.css in rem (16px to the rem), `var(--activity-gap)`
 *  read as the list's own. Sums, products and signs only: anything else in
 *  it throws rather than being read as something it is not. */
function remOf(value: string | undefined): number {
  const gap = globalsDecl(".activity-timeline", "--activity-gap")!
  const source = (value ?? "")
    .replace(/var\(--activity-gap\)/g, gap)
    .replace(/calc\(/g, "(")
    .replace(/\s+/g, "")
  const tokens = source.match(/\d*\.?\d+(?:rem|px)?|[-+*()]/g) ?? []
  if (tokens.length === 0 || tokens.join("") !== source) {
    throw new Error(`cannot read ${String(value)}`)
  }
  let at = 0
  const sum = (): number => {
    let total = product()
    while (tokens[at] === "+" || tokens[at] === "-") {
      const plus = tokens[at++] === "+"
      const next = product()
      total = plus ? total + next : total - next
    }
    return total
  }
  const product = (): number => {
    let total = factor()
    while (tokens[at] === "*") {
      at += 1
      total *= factor()
    }
    return total
  }
  const factor = (): number => {
    const token = tokens[at++]!
    if (token === "-") return -factor()
    if (token === "(") {
      const inner = sum()
      at += 1
      return inner
    }
    const number = Number.parseFloat(token)
    if (Number.isNaN(number)) throw new Error(`cannot read ${String(value)}`)
    return token.endsWith("px") ? number / 16 : number
  }
  const length = sum()
  if (at !== tokens.length) throw new Error(`cannot read ${String(value)}`)
  return length
}

/** The classes that could space `to` from `from`, `to`'s own padding aside:
 *  `to`'s margins above it, the padding and margins of its ancestors below
 *  the element the two share, the gaps that element sets between its
 *  children, and `from`'s margins below it. */
function spacingBetween(from: Element, to: Element): string[] {
  let shared = from.parentElement
  while (shared && !shared.contains(to)) shared = shared.parentElement
  const classes = (node: Element, pattern: RegExp) =>
    node.className.split(/\s+/).filter((name) => pattern.test(name))
  const found = classes(to, /^-?m[ty]?-/)
  for (
    let node = to.parentElement;
    node && node !== shared;
    node = node.parentElement
  ) {
    found.push(...classes(node, /^-?[pm][tbxy]?-/))
  }
  if (shared) found.push(...classes(shared, /^(?:space-y|gap|gap-y)-/))
  found.push(...classes(from, /^-?m[by]?-/))
  return found
}

beforeEach(() => {
  resetDisclosureStore()
})

/**
 * Sets the real OverlayScrollbars up in the enclosing describe: its setup is
 * deferred into an idle callback and then an animation frame, queued here and
 * run by the returned flush; it measures only an element with a size, and
 * jsdom lays nothing out.
 */
function withOverlayScrollbars() {
  const deferred = new Map<number, () => void>()
  let nextHandle = 0
  beforeEach(() => {
    const queue = (callback: () => void) => {
      deferred.set(++nextHandle, callback)
      return nextHandle
    }
    const cancel = (handle: number) => deferred.delete(handle)
    vi.stubGlobal("requestIdleCallback", queue)
    vi.stubGlobal("cancelIdleCallback", cancel)
    vi.stubGlobal("requestAnimationFrame", queue)
    vi.stubGlobal("cancelAnimationFrame", cancel)
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200)
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200)
  })
  afterEach(() => {
    deferred.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  return function flushDeferred() {
    for (let round = 0; round < 2; round++) {
      act(() => {
        for (const [handle, callback] of [...deferred]) {
          deferred.delete(handle)
          callback()
        }
      })
    }
  }
}

/** A viewport that scrolls sideways as far as `reach`, and down as far as
 *  `down` (jsdom keeps no scroll offsets of its own). */
function scrollable(viewport: HTMLElement, reach: number, down = 0) {
  Object.defineProperty(viewport, "clientWidth", { value: 100 })
  Object.defineProperty(viewport, "scrollWidth", { value: 100 + reach })
  Object.defineProperty(viewport, "clientHeight", { value: 100 })
  Object.defineProperty(viewport, "scrollHeight", { value: 100 + down })
  for (const offset of ["scrollLeft", "scrollTop"]) {
    Object.defineProperty(viewport, offset, { value: 0, writable: true })
  }
}

/** The overflow an OverlayScrollbars host was set up with. */
const overflowOf = (host: Element) =>
  OverlayScrollbars(host as HTMLElement)?.options().overflow

describe("activity timeline: the reference turn", () => {
  it("summarizes the turn in the header: steps, how it ended, then the time", () => {
    // Only the step count is spelled out; the breakdown by kind is the
    // tooltip's. The outcome follows the count, then the time, and the
    // chevron closes the capsule.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const header = activityHeader()
    expect(header.textContent).toBe(
      "Activity14 steps · 1 failed, recovered · 3m 34s"
    )
    expect(header.querySelector("[title]")).toHaveAttribute(
      "title",
      "14 steps · 6 commands · 1 edit · 1 agent · 1 MCP call · 3 files read · 1 search"
    )
    const chevron = header.lastElementChild!
    expect(chevron).toBe(header.querySelector("svg.lucide-chevron-right"))
    expect(chevron.previousElementSibling!.lastElementChild!.textContent).toBe(
      " · 3m 34s"
    )
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
  })

  it("folds the reads and the grep into one Explored row", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const explored = rowOf("Explored")
    expect(within(explored).getByText("3 files, 1 search")).toBeTruthy()
    expect(within(explored).queryByText("84 lines")).toBeNull()

    fireEvent.click(within(explored).getAllByRole("button")[0]!)
    expect(within(explored).getByText("84 lines")).toBeTruthy()
    expect(within(explored).getByText("212 lines")).toBeTruthy()
    expect(within(explored).getByText("4 hits")).toBeTruthy()
    expect(within(explored).getAllByText("read")).toHaveLength(3)
    expect(within(explored).getByText("grep")).toBeTruthy()
  })

  it("folds the first two commands and reports that they passed", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const groups = screen.getAllByText("Ran 2 commands")
    expect(groups).toHaveLength(2)
    expect(
      within(groups[0]!.closest("li")!).getByText("all passed")
    ).toBeTruthy()
  })

  it("leaves a failure that was redone folded, with its exit code", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const failed = screen
      .getAllByText("Run web unit tests")
      .map((el) => el.closest("li")!)
      .find((li) => li.getAttribute("data-status") === "failed")!
    expect(within(failed).getByText("exit 1")).toBeTruthy()
    expect(within(failed).queryByText(/Tests: 1 failed/)).toBeNull()
    expect(
      within(failed).getByRole("img", {
        name: "Command, failed with exit code 1",
      })
    ).toBeTruthy()
  })

  it("names the MCP server and summarizes the call", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const mcp = rowOf("get_issue")
    expect(within(mcp).getByText("mcp · linear")).toBeTruthy()
    expect(
      within(mcp).getByText("HVAC-212 · Inactive bindings leak into report")
    ).toBeTruthy()
    fireEvent.click(within(mcp).getByRole("button"))
    expect(within(mcp).getByText("args")).toBeTruthy()
    expect(within(mcp).getByText("result")).toBeTruthy()
  })

  it("shows the edited file, its changed lines and counts", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const edit = rowOf("Edited")
    expect(within(edit).getByText("query_tasks.py")).toBeTruthy()
    expect(within(edit).getByText("L44–46")).toBeTruthy()
    expect(within(edit).getByText("+3")).toBeTruthy()
    expect(within(edit).getByText("−1")).toBeTruthy()
    fireEvent.click(within(edit).getByRole("button"))
    expect(
      within(edit).getByText(
        "binding for binding in item.source_bindings if binding.active",
        {
          exact: false,
        }
      )
    ).toBeTruthy()
  })

  it("titles a thought and opens to its body without repeating the title", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const thought = rowOf("Summarizing log status")
    fireEvent.click(within(thought).getByRole("button"))
    expect(within(thought).getByText(/I need to gather the logs/)).toBeTruthy()
    expect(within(thought).getAllByText("Summarizing log status")).toHaveLength(
      1
    )
  })

  it("hides and shows the process, keeping the answer", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    fireEvent.click(foldControl())
    expect(foldControl()).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Explored")).toBeNull()
    expect(screen.getByText(/The web build is clean/)).toBeTruthy()
    fireEvent.click(foldControl())
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Explored")).toBeTruthy()
  })

  it("draws the header's chevron after its text, always in view, turned while open", () => {
    // Like a row's: after the summary, pointing down while the process shows —
    // but in view folded too, not only on hover.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const header = activityHeader()
    const summary = within(header).getByText(/14 steps/)
    const chevron = header.querySelector("svg.lucide-chevron-right")!
    expect(
      summary.compareDocumentPosition(chevron) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(chevron.getAttribute("class")).toMatch(/\brotate-90\b/)
    fireEvent.click(foldControl())
    expect(chevron.getAttribute("class")).not.toMatch(/\brotate-90\b/)
    expect(chevron.getAttribute("class")).not.toMatch(/\bopacity-0\b/)
  })

  it("draws the header as a capsule only as wide as its line", () => {
    // The capsule is the separation itself, so there is no rule to run to the
    // end — and no full-width bar either: it hugs its own words.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const header = activityHeader()
    expect(header.className).toMatch(/\brounded-full\b/)
    const classes = header.className.split(/\s+/)
    expect(classes).toContain("w-fit")
    // `max-w-full` is not `w-full`: the capsule caps at the column, it does
    // not fill it.
    expect(classes).not.toContain("w-full")
    expect(header.querySelector(".h-px")).toBeNull()
    expect(header.querySelector("span[aria-hidden='true'].flex-1")).toBeNull()
  })

  it("fills the header like the user's bubble, its words in inks that read on it", () => {
    // The capsule takes the bubble's fill, tinted with it in the coloured
    // presets; pointed at, the same colour a step toward the foreground, not
    // another grey. The summary and the time take the stronger muted ink and
    // a failure the stronger red, both keeping 4.5:1 on it, hovered too.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const header = activityHeader()
    const classes = header.className.split(/\s+/)
    expect(classes).toContain("bg-activity-capsule")
    expect(classes).toContain("hover:bg-activity-capsule-hover")
    expect(classes.filter((name) => /bg-(muted|secondary)/.test(name))).toEqual(
      []
    )
    for (const figure of header.querySelectorAll(".activity-mono")) {
      expect(figure).toHaveClass("text-activity-muted-strong")
      expect(figure).not.toHaveClass("text-muted-foreground")
    }
    // The tokens, outside the fallback for engines without color-mix.
    const flat = (value: string | undefined) =>
      (value ?? "")
        .replace(/\s+/g, " ")
        .replace(/\( /g, "(")
        .replace(/ \)/g, ")")
    const css = postcss.parse(
      readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8")
    )
    const tokens = new Map<string, string>()
    css.walkRules((rule) => {
      if (rule.parent?.type !== "root") return
      rule.walkDecls(/^--activity-capsule/, (decl) => {
        tokens.set(`${rule.selector} ${decl.prop}`, flat(decl.value))
      })
    })
    // The bubble's own fill (`bg-secondary` on it), in either theme — the
    // dark one has no capsule of its own; hovered, 6% toward the foreground,
    // which darkens it on a light page and lights it on a dark one.
    expect(tokens.get(":root --activity-capsule")).toBe("var(--secondary)")
    expect(tokens.get(":root --activity-capsule-hover")).toBe(
      "color-mix(in oklab, var(--secondary), var(--foreground) 6%)"
    )
    expect(tokens.has(".dark --activity-capsule")).toBe(false)
    expect(tokens.has(".dark --activity-capsule-hover")).toBe(false)
    // Over a background image the bubble's translucent tint and ring, word
    // for word; hovered, the tint a step toward the foreground at the same
    // translucency, so the image still shows through it.
    const bubble = (prop: string) =>
      flat(
        globalsDecl('[data-workspace-bg="on"] .is-user .ws-msg-secondary', prop)
      )
    expect(tokens.get('[data-workspace-bg="on"] --activity-capsule')).toBe(
      bubble("background-color")
    )
    expect(
      tokens.get('[data-workspace-bg="on"] --activity-capsule-hover')
    ).toBe(
      "color-mix(in oklab, color-mix(in oklab, var(--muted), var(--foreground) 12%) calc(var(--ws-msg-alpha) * 100%), transparent)"
    )
    expect(
      flat(
        globalsDecl('[data-workspace-bg="on"] .activity-capsule', "box-shadow")
      )
    ).toBe(bubble("box-shadow"))
    // An engine with no color-mix drops every mixed fill: the capsule keeps
    // the bubble's there too (the bubble's own tint is dropped with it), and
    // holds it under the pointer.
    const fallback = new Map<string, string>()
    css.walkAtRules("supports", (at) => {
      if (!at.params.startsWith("not")) return
      at.walkRules((rule) =>
        rule.walkDecls(/^--activity-capsule/, (decl) => {
          fallback.set(`${rule.selector} ${decl.prop}`, flat(decl.value))
        })
      )
    })
    expect(Object.fromEntries(fallback)).toEqual({
      ":root --activity-capsule-hover": "var(--secondary)",
      ":root --activity-capsule-danger": "var(--tone-danger)",
      '[data-workspace-bg="on"] --activity-capsule': "var(--secondary)",
      '[data-workspace-bg="on"] --activity-capsule-hover': "var(--secondary)",
    })
    expect(tokens.get(":root --activity-capsule-danger")).toBe(
      "color-mix(in oklab, var(--tone-danger) 85%, var(--foreground))"
    )
  })

  it("sets an unrecovered failure in the capsule's own red", () => {
    const FAILED: MessageTurn = {
      id: "capsule-failure",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [
        toolUse("f1", "Bash", { command: "pnpm test" }),
        toolResult("f1", "Exit code 1\n1 failed", true),
        { type: "text", text: "The tests fail." },
      ],
    }
    renderSettled(partsOf(FAILED))
    const failure = within(activityHeader()).getByText("1 failed")
    expect(failure).toHaveClass("text-activity-capsule-danger")
    expect(failure).not.toHaveClass("text-tone-danger")
  })

  it("makes the header a block 2rem tall", () => {
    // A little taller than a one-line row (1.75rem), the head of the rows
    // under it; and a block, in no line box that could add room under its
    // edge.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const classes = activityHeader().className.split(/\s+/)
    expect(classes).toContain("h-8")
    expect(classes).not.toContain("h-7")
    expect(classes).toContain("flex")
    expect(classes).not.toContain("inline-flex")
  })

  it("sets the header's label and its figures at one size, centred on the line", () => {
    // Only the weight tells the label apart; the chevron is centred by the
    // capsule's own flex, not by a margin meant for a row's 1.5rem line.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const header = activityHeader()
    expect(foldControl().className).toMatch(/\btext-xs\b/)
    const figures = header.querySelectorAll(".activity-mono")
    // The summary and the time.
    expect(figures).toHaveLength(2)
    for (const figure of figures) {
      expect(figure.className).toMatch(/\btext-xs\b/)
    }
    expect(header.className).toMatch(/\bitems-center\b/)
    const chevron = header.querySelector("svg.lucide-chevron-right")!
    const chevronClasses = chevron.getAttribute("class")!.split(/\s+/)
    expect(chevronClasses).toContain("mt-0")
    expect(chevronClasses).toContain("mb-0")
  })

  it("folds and unfolds from anywhere on the header", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    fireEvent.click(within(activityHeader()).getByText(/14 steps/))
    expect(foldControl()).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Explored")).toBeNull()
    fireEvent.click(activityHeader().querySelector(".activity-mono")!)
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Explored")).toBeTruthy()
  })

  it("turns an open row's chevron to point down in either direction", () => {
    // Mirrored under RTL, the chevron has to turn the other way.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const thought = rowOf("Summarizing log status")
    fireEvent.click(within(thought).getByRole("button"))
    const chevron = thought.querySelector("svg.lucide-chevron-right")
    expect(chevron?.getAttribute("class")).toMatch(
      /\brotate-90\b.*\brtl:-rotate-90\b/
    )
  })

  it("marks a group with the group icon and draws its chevron after the label", () => {
    // Like any row's: shown on hover, turned while open — the ring keeps its
    // icon.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    for (const label of ["Explored", "Ran 2 commands"]) {
      const group = screen.getAllByText(label)[0]!.closest("li")!
      const ring = group.querySelector(':scope > span [role="img"]')!
      expect(ring.querySelector("svg.lucide-layers")).toBeTruthy()
      expect(ring.querySelector("svg.lucide-chevron-right")).toBeNull()
      const header = within(group).getAllByRole("button")[0]!
      const chevron = header.querySelector("svg.lucide-chevron-right")!
      expect(
        within(header).getByText(label).compareDocumentPosition(chevron) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(chevron.getAttribute("class")).toMatch(/\bopacity-0\b/)
      fireEvent.click(header)
      expect(chevron.getAttribute("class")).toMatch(/\brotate-90\b/)
      expect(ring.querySelector("svg.lucide-layers")).toBeTruthy()
    }
  })

  it("sets row headers on the 1.5rem line the rail is drawn for", () => {
    // tailwind-merge drops a line height that a later font size follows; the
    // rings, dots and chevrons are placed for this line.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const explored = within(rowOf("Explored")).getAllByRole("button")[0]!
    expect(explored.className).toMatch(/\btext-sm\b.*\bleading-6\b/)
    fireEvent.click(explored)
    const child = within(rowOf(/\/Makefile$/)).getByRole("button")
    expect(child.className).toMatch(/\bleading-6\b/)
  })

  it("lets the agent's own words on a row take their own direction", () => {
    // Under an Arabic UI, English the agent wrote would inherit right to left
    // and be cut at its start; it follows its own direction instead.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    for (const text of [
      "Summarizing log status",
      "HVAC-212 · Inactive bindings leak into report",
      "Regenerate audit report · report.md written",
      "Commit the fix",
    ]) {
      expect(screen.getByText(text)).toHaveAttribute("dir", "auto")
    }
  })

  it("sets a row's verb and a group's title in the ink of the words after them", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    for (const label of ["Thought", "Explored", "Ran 2 commands", "Edited"]) {
      const verb = screen.getAllByText(label)[0]!
      expect(verb).toHaveClass("text-activity-secondary", "font-medium")
      expect(verb).not.toHaveClass("text-muted-foreground")
    }
    // The edited file: its folder and its name alike.
    const name = screen.getByText("query_tasks.py")
    expect(name).not.toHaveClass("text-foreground")
    expect(name.closest(".text-activity-secondary")).toBe(name.parentElement)
    // A group's members: the verb column and the file it read.
    fireEvent.click(within(rowOf("Explored")).getAllByRole("button")[0]!)
    const member = rowOf(/\/Makefile$/)
    expect(within(member).getByText(/\/Makefile$/)).toHaveClass(
      "text-activity-secondary"
    )
    expect(within(member).getByText("read")).toHaveClass(
      "text-activity-secondary"
    )
    // The fold at the foot of the open list reads the same.
    const foot = document.querySelector<HTMLElement>(
      "li[data-marker='foot'] > button"
    )!
    expect(foot).toHaveClass("text-activity-secondary")
    expect(foot).not.toHaveClass("text-muted-foreground")
  })

  it("spaces a group's members like the rows around the group", () => {
    // The same room above and below the line as a main row's header, and the
    // same gap between rows, so an open group keeps the timeline's rhythm
    // instead of packing its members together.
    const stylesheet = postcss.parse(
      readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8")
    )
    const gap = (selector: string) => {
      let value: string | undefined
      stylesheet.walkRules((rule) => {
        if (rule.selector !== selector) return
        rule.walkDecls("margin-top", (decl) => {
          value = decl.value
        })
      })
      return value
    }
    expect(gap(".activity-item:not(:first-child)")).toBeTruthy()
    expect(gap(".activity-child:not(:first-child)")).toBe(
      gap(".activity-item:not(:first-child)")
    )
    // Not with a sibling combinator: Chrome restyles a whole list under one
    // whenever a row leaves from its middle — as a long reply's fold does on
    // every step while it streams.
    const siblingRules: string[] = []
    stylesheet.walkRules((rule) => {
      if (/\.activity-(item|child)[^,{]*[+~]/.test(rule.selector)) {
        siblingRules.push(rule.selector)
      }
    })
    expect(siblingRules).toEqual([])
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const explored = within(rowOf("Explored")).getAllByRole("button")[0]!
    fireEvent.click(explored)
    const child = within(rowOf(/\/Makefile$/)).getByRole("button")
    expect(child.className).toMatch(/\bpy-0\.5\b/)
    expect(explored.className).toMatch(/\bpy-0\.5\b/)
  })

  it("starts a group's words as far past its rings as the timeline's", () => {
    // A member's ring is smaller, so its column is narrower by as much: the
    // words start the same 0.75rem past the ring in every list — a reply's,
    // a sub-agent's, a group's.
    const stylesheet = postcss.parse(
      readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8")
    )
    const column = (selector: string) => {
      let value = Number.NaN
      stylesheet.walkRules((rule) => {
        if (rule.selector !== selector) return
        rule.walkDecls("padding-inline-start", (decl) => {
          value = Number.parseFloat(decl.value)
        })
      })
      return value
    }
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const group = screen.getAllByText("Ran 2 commands")[0]!.closest("li")!
    fireEvent.click(within(group).getAllByRole("button")[0]!)
    // Tailwind's size-N is N quarter-rems.
    const ring = (marker: Element) =>
      Number(marker.className.match(/\bsize-(\d+)\b/)![1]) / 4
    const list = document.querySelector(".activity-timeline")!
    const mainRing = list.querySelector(
      ':scope > li[data-marker="ring"] > span'
    )!
    const memberRing = list.querySelector(
      'li.activity-child[data-marker="ring"] > span'
    )!
    expect(column(".activity-item") - ring(mainRing)).toBe(0.75)
    expect(column(".activity-child") - ring(memberRing)).toBe(0.75)
  })
})

describe("activity timeline: failures", () => {
  const FAILURE: MessageTurn = {
    id: "turn-f",
    role: "assistant",
    timestamp: "2026-10-22T09:00:00Z",
    blocks: [
      toolUse("f1", "Bash", { command: "pnpm build" }),
      toolResult("f1", "Type error\n[terminal exited: exit code: 2]", true),
      { type: "text", text: "It does not build." },
    ],
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("leaves a failed command folded, its failure in red on its row and in the header", () => {
    // A command that exits non-zero is routine — a test run mid-fix, a grep
    // with no match — and opening its output by itself pushed the reply about.
    // The red `exit 2` and the header's count say it failed; the output is a
    // click away.
    renderSettled(partsOf(FAILURE))
    expect(screen.getByText("1 failed")).toBeTruthy()
    const row = rowOf("pnpm build")
    expect(within(row).getByText("exit 2")).toBeTruthy()
    const header = within(row).getByRole("button")
    expect(header).toHaveAttribute("aria-expanded", "false")
    expect(within(row).queryByText(/Type error/)).toBeNull()
    fireEvent.click(header)
    expect(within(row).getByText(/Type error/)).toBeTruthy()
  })

  it("opens the failed command from the header's red count", () => {
    renderSettled(partsOf(FAILURE))
    fireEvent.click(screen.getByRole("button", { name: "1 failed" }))
    const row = rowOf("pnpm build")
    expect(within(row).getAllByRole("button")[0]).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(within(row).getByText(/Type error/)).toBeTruthy()
  })

  it("leaves the failure link to itself, and folds with text selected elsewhere", () => {
    renderSettled(partsOf(FAILURE))
    fireEvent.click(screen.getByText("1 failed"))
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
    // Nothing in the capsule can be selected, so a press on it leaves a
    // selection made elsewhere as it was: that is no reason not to fold.
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "It does not build.",
    } as Selection)
    fireEvent.click(activityHeader().querySelector(".activity-mono")!)
    expect(foldControl()).toHaveAttribute("aria-expanded", "false")
  })

  it("brings the failure into view in a reply that cannot fold", () => {
    // Stopped on the failed call, with no answer after it: the header's red
    // count is still the way to the row.
    renderSettled(partsOf(STOPPED_ON_FAILURE), 9000)
    const into = vi.spyOn(Element.prototype, "scrollIntoView")
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      frame(0)
      return 0
    })
    // jsdom has no `CSS`; the step keys here need no escaping.
    vi.stubGlobal("CSS", { escape: (value: string) => value })
    try {
      fireEvent.click(screen.getByRole("button", { name: "1 failed" }))
      expect(into).toHaveBeenCalledTimes(1)
      expect(into.mock.contexts[0]).toBe(rowOf("pnpm --filter web build"))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("activity timeline: a live turn", () => {
  it("shows the running command with the tail of its output", () => {
    vi.useFakeTimers()
    try {
      renderTurn(
        <CurrentRound
          parts={partsOf(MOCKUP_LIVE_TURN, true, ["l3"])}
          completed={false}
        />
      )
      expect(screen.getByText("Working")).toBeTruthy()
      const row = rowOf("Run web unit tests")
      expect(row.getAttribute("data-status")).toBe("running")
      // The tail opens under the row once the command has run a moment: one
      // that is over at once never opens a gap under its row.
      expect(within(row).queryByText(/lib\/state\.test\.ts/)).toBeNull()
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(within(row).getByText(/lib\/state\.test\.ts/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
    const row = rowOf("Run web unit tests")
    // Its label shimmers while it runs, as a running row's verb does.
    expect(within(row).getByText("Command")).toHaveClass("activity-shimmer")
    expect(within(row).getByText("Run web unit tests")).toHaveClass(
      "text-activity-secondary"
    )
  })
})

describe("activity timeline: the status rings", () => {
  const ring = (row: HTMLElement) =>
    row.querySelector<HTMLElement>(':scope > span [role="img"]')!

  it("turns a solid arc over the track of a running step", () => {
    // A 0.5px dashed ring that turned could not be read as turning: the
    // running ring keeps a light track and adds a heavier arc that spins.
    renderTurn(
      <CurrentRound
        parts={partsOf(MOCKUP_LIVE_TURN, true, ["l3"])}
        completed={false}
      />
    )
    const mark = ring(rowOf("Run web unit tests"))
    // The light track stays under the arc.
    const track = mark.querySelector<HTMLElement>(".border-activity-ring")!
    expect(track.className).toContain("border-[0.5px]")
    expect(track.className).not.toMatch(/\banimate-spin\b/)
    // The arc is one childless span, heavier than the track and turning.
    const arc = mark.querySelector<HTMLElement>(".border-t-activity-ring-live")!
    expect(arc.className).toMatch(/\banimate-spin\b/)
    expect(arc.className).toMatch(/\bborder-transparent\b/)
    expect(arc.className).toContain("border-[1.25px]")
    expect(arc.className).toContain("[animation-duration:1.5s]")
    expect(arc.childElementCount).toBe(0)
    expect(arc.textContent).toBe("")
  })

  it("fades a finished step's ring and stops it turning", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const mark = ring(rowOf("Summarizing log status"))
    const rest = mark.querySelector<HTMLElement>(".rounded-full")!
    expect(rest).toHaveAttribute("data-ring", "quiet")
    expect(rest.className).toMatch(/\bborder-activity-ring-done\b/)
    expect(rest.className).not.toMatch(/\banimate-spin\b/)
    // It fades rather than snapping when a running step settles.
    expect(rest.className).toContain("transition-[border-color]")
    expect(rest.className).toContain("duration-500")
    expect(mark.querySelector(".border-t-activity-ring-live")).toBeNull()
  })

  it("turns the same arc at the foot of a live reply", () => {
    // While the agent works the rail ends on a single turning ring: a track
    // with the arc over it, so the two read as one ring — no fold row yet.
    const { container } = renderTurn(
      <CurrentRound
        parts={partsOf(MOCKUP_LIVE_TURN, true, ["l3"])}
        completed={false}
      />
    )
    const list = container.querySelector(".activity-timeline")!
    const foot = list.lastElementChild as HTMLElement
    expect(foot).toHaveAttribute("data-marker", "working")
    expect(foot).toHaveAttribute("aria-hidden", "true")
    const mark = foot.firstElementChild!
    expect(mark.querySelector(".border-activity-ring")).toBeTruthy()
    const arc = mark.querySelector<HTMLElement>(".border-t-activity-ring-live")!
    expect(arc.className).toMatch(/\banimate-spin\b/)
    // Two plain children: the track and the arc, nothing inside either.
    expect(mark.childElementCount).toBe(2)
    expect(arc.childElementCount).toBe(0)
    expect(foot.querySelector("svg, button")).toBeNull()
    expect(container.querySelectorAll('[data-marker="working"]')).toHaveLength(
      1
    )
  })
})

describe("activity timeline: where the rail ends", () => {
  // The rail itself is CSS (globals.css); the list ends on its foot.
  const list = () => document.querySelector(".activity-timeline")!
  /** The list's own child marked `marker` (not one of a nested list's). */
  const childMarked = (el: Element, marker: string) =>
    ([...el.children].find(
      (child) => child.getAttribute("data-marker") === marker
    ) ?? null) as HTMLElement | null
  const footOf = (el: Element) => childMarked(el, "foot")
  const workingOf = (el: Element) => childMarked(el, "working")
  /** The row that folds the list, at its foot. */
  const foldOf = (el: Element) =>
    within(footOf(el)!).getByRole("button", { name: /^Collapse / })

  it("ends a finished reply's steps on a row that folds them, saying what it folds", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const foot = footOf(list())!
    expect(foot).toBe(list().lastElementChild)
    expect(foot).toHaveClass("activity-item")
    // "Collapse", then the steps it folds and the time they took.
    expect(foldOf(list())).toHaveAccessibleName("Collapse 14 steps · 3m 34s")
    expect(within(foot).getByText("Collapse")).toHaveClass("font-medium")
    // There is no end mark any more: the list keeps no note of being done.
    expect(list()).not.toHaveAttribute("data-end")
  })

  it("rings the fold's chevron like a finished step's icon", () => {
    // Where a step's icon would be: the same faint ring, the same place, a
    // glyph of the same size — the fold's chevron, pointing up.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const classes = (el: Element) =>
      el.getAttribute("class")!.split(/\s+/).sort()
    const fold = foldOf(list())
    const mark = fold.firstElementChild as HTMLElement
    const stepMark = list().querySelector<HTMLElement>(
      ':scope > li[data-marker="ring"] > span'
    )!
    expect(classes(mark)).toEqual(classes(stepMark))
    const ring = mark.querySelector<HTMLElement>('[data-ring="quiet"]')!
    const stepRing = list().querySelector<HTMLElement>(
      'li[data-status="succeeded"] [data-ring="quiet"]'
    )!
    expect(classes(ring)).toEqual(classes(stepRing))
    const chevron = mark.querySelector("svg.lucide-chevron-up")!
    const stepGlyph = stepMark.querySelector("svg")!
    expect(chevron.getAttribute("viewBox")).toBe(
      stepGlyph.getAttribute("viewBox")
    )
    expect(chevron).toHaveClass("absolute", "inset-0", "size-full")
    // The words beside it say what it does: the ring is no image of its own.
    expect(mark.querySelector('[role="img"]')).toBeNull()
  })

  it("says the steps alone with no time to give, and the process with no steps to count", () => {
    const view = renderSettled(partsOf(MOCKUP_ASSISTANT_TURN), 0)
    expect(foldOf(list())).toHaveAccessibleName("Collapse 14 steps")
    view.unmount()
    // A thought is no step: a reply that only thought before it answered
    // folds its process by name, with the time it took when there is one.
    const THOUGHT_ONLY: MessageTurn = {
      id: "turn-t",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [
        { type: "thinking", text: "**Weighing it**\n\nShort and safe." },
        { type: "text", text: "Use the short one." },
      ],
    }
    const bare = renderSettled(partsOf(THOUGHT_ONLY), 0)
    expect(foldOf(list())).toHaveAccessibleName("Collapse Activity")
    bare.unmount()
    renderSettled(partsOf(THOUGHT_ONLY), 5000)
    expect(foldOf(list())).toHaveAccessibleName("Collapse 5s")
  })

  it("folds the reply from its foot, keeping the answer", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    fireEvent.click(foldOf(list()))
    expect(foldControl()).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Explored")).toBeNull()
    expect(screen.getByText(/The web build is clean/)).toBeTruthy()
    expect(document.querySelector('[data-marker="foot"]')).toBeNull()
    // Unfolded again, it ends on its foot again.
    fireEvent.click(foldControl())
    expect(footOf(list())).toBeTruthy()
  })

  it("brings the header into view before it folds from its foot", () => {
    // The foot is at the bottom of what folds away; with the header above the
    // view, the answer would slide in under the reader instead.
    const order: string[] = []
    const revealFromAbove = vi.fn((element: Element) => {
      order.push(
        `reveal:${element.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")}`
      )
    })
    renderTurn(
      <MessageScrollProvider
        value={{ scrollToIndex: vi.fn(), revealFromAbove }}
      >
        <CurrentRound
          parts={partsOf(MOCKUP_ASSISTANT_TURN)}
          durationMs={214000}
          completed
        />
      </MessageScrollProvider>
    )
    fireEvent.click(foldOf(list()))
    expect(revealFromAbove).toHaveBeenCalledTimes(1)
    expect(revealFromAbove.mock.calls[0]![0]).toBe(activityHeader())
    // Read while the steps were still there.
    expect(order).toEqual(["reveal:true"])
    expect(foldControl()).toHaveAttribute("aria-expanded", "false")
  })

  it("hands the focus to the header's fold control when the foot had it", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const fold = foldOf(list())
    fold.focus()
    fireEvent.click(fold)
    expect(document.activeElement).toBe(foldControl())
  })

  it("draws no foot under a reply that cannot fold", () => {
    renderSettled(partsOf(STOPPED_ON_FAILURE), 9000)
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull()
    expect(footOf(list())).toBeNull()
    expect(workingOf(list())).toBeNull()
  })

  it("hangs the reply's rows under the header, a step's gap below it", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    expect(list()).toHaveAttribute("data-headed")
    // Nothing but the list's own padding between the capsule and the rows.
    expect(spacingBetween(activityHeader(), list())).toEqual([])
    // A one-line row is 1.75rem with its ring 0.25rem–1.5rem down it: the
    // first ring is as far below the capsule as a ring below the one before.
    const gap = remOf("var(--activity-gap)")
    const head = remOf(
      globalsDecl(".activity-timeline[data-headed]", "padding-top")
    )
    expect(head + 0.25).toBeCloseTo(1.75 - 1.5 + gap + 0.25)
    // The list draws the rail up to the capsule, from its own top edge, and
    // stops it as a row's segment stops: 0.125rem above the first ring.
    const rail = ".activity-timeline[data-headed]::before"
    const top = remOf(globalsDecl(rail, "top"))
    const end = top + remOf(globalsDecl(rail, "height"))
    expect(globalsDecl(rail, "content")).toBe('""')
    expect(top).toBeCloseTo(0)
    expect(end).toBeCloseTo(head + 0.25 - 0.125)
    // Prose first: its dot's incoming segment, the one a dot gets under any
    // segment, takes the rail on from where the list's stops.
    const dotRail =
      '.activity-timeline[data-headed] > .activity-item[data-marker="dot"]:first-child::after'
    const incoming =
      '.activity-item[data-marker="dot"]:not(:first-child)::after'
    for (const prop of ["content", "top", "height", "inset-inline-start"]) {
      expect(globalsDecl(dotRail, prop)).toBe(globalsDecl(incoming, prop))
    }
    expect(head + remOf(globalsDecl(dotRail, "top"))).toBeCloseTo(end)
    // The first row draws none of its own up there: the two would overlap,
    // and the translucent rail would darken where they do.
    expect(
      globalsDecl(
        ".activity-timeline[data-headed] > .activity-item:first-child::after",
        "content"
      )
    ).toBeUndefined()
    const column = globalsDecl(".activity-item::before", "inset-inline-start")
    expect(column).toBeTruthy()
    expect(globalsDecl(rail, "inset-inline-start")).toBe(column)
  })

  it("hangs the rows of a reply that cannot fold the same way, prose first", () => {
    renderSettled(partsOf(STOPPED_ON_FAILURE), 9000)
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull()
    expect(list()).toHaveAttribute("data-headed")
    expect(list().querySelector(":scope > li")).toHaveAttribute(
      "data-marker",
      "dot"
    )
    expect(spacingBetween(activityHeader(), list())).toEqual([])
  })

  it("starts a row's ring flush with the reply's left edge", () => {
    // The ring is the widest mark and the widest thing in the column, so it
    // starts at 0 and the rail runs down its centre (0.625rem) — history and
    // groups alike, and nothing sits further left than the header above them.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const row = list().querySelector(":scope > li")!
    const marker = row.querySelector(":scope > span")!
    const classes = marker.className.split(/\s+/)
    expect(classes).toContain("start-0")
    expect(classes).not.toContain("start-0.5")
    // A dot's own 0.375rem box is centred on that same line.
    const dot = list().querySelector(
      ':scope > li[data-marker="dot"] > span'
    ) as HTMLElement
    expect(dot.className.split(/\s+/)).toContain("start-[0.4375rem]")
    // The segment under the ring, and a dot's incoming one, follow its centre.
    for (const selector of [
      ".activity-item::before",
      '.activity-item[data-marker="dot"]:not(:first-child)::after',
    ]) {
      expect(globalsDecl(selector, "inset-inline-start")).toBe(
        "calc(0.625rem - 0.5px)"
      )
    }
  })

  it("sets each foot where a ring of its list would be, the rail stopping as short of it", () => {
    // A segment reaches into the next row as far as it must to stop 0.125rem
    // above that row's marker: a reply's ring at 0.25rem, a group member's
    // ring at 0.375rem. The foot's ring — and the turning ring before it —
    // starts the same 0.125rem below where the segment above it stops; after
    // an explore group's dots, which reach 0.3125rem further, the foot starts
    // that much lower.
    const gap = remOf("var(--activity-gap)")
    const reach = (selector: string) =>
      -remOf(globalsDecl(selector, "bottom")) - gap
    const tw: Record<string, number> = { "top-1": 0.25, "top-1.5": 0.375 }
    const topOf = (el: Element) => {
      const name = el
        .getAttribute("class")!
        .split(/\s+/)
        .find((c) => c in tw)
      if (!name) throw new Error(`no top on ${el.getAttribute("class")}`)
      return tw[name]!
    }
    const ringOf = (foot: HTMLElement) =>
      foot.querySelector(":scope > button > span")!
    const lower =
      remOf(
        globalsDecl(
          '.activity-child[data-after="dot"]:not(:first-child)',
          "margin-top"
        )
      ) - gap

    const view = renderTurn(
      <CurrentRound
        parts={partsOf(MOCKUP_ASSISTANT_TURN)}
        durationMs={214000}
        completed
      />
    )
    expect(
      topOf(ringOf(footOf(list())!)) - reach(".activity-item::before")
    ).toBeCloseTo(0.125)
    for (const [label, marker, after] of [
      ["Explored", "dot", "dot"],
      ["Ran 2 commands", "ring", undefined],
    ] as const) {
      const group = screen.getAllByText(label)[0]!.closest("li")!
      fireEvent.click(within(group).getAllByRole("button")[0]!)
      const foot = footOf(group.querySelector(".activity-children")!)!
      expect(foot.getAttribute("data-after") ?? undefined).toBe(after)
      const segment = reach(`.activity-child[data-marker="${marker}"]::before`)
      expect(topOf(ringOf(foot)) - (segment - (after ? lower : 0))).toBeCloseTo(
        0.125
      )
    }
    view.unmount()

    // The turning ring, before it, starts as far under the segment.
    renderTurn(
      <CurrentRound
        parts={partsOf(MOCKUP_LIVE_TURN, true, ["l3"])}
        completed={false}
      />
    )
    expect(
      topOf(workingOf(list())!.firstElementChild!) -
        reach(".activity-item::before")
    ).toBeCloseTo(0.125)
  })

  it("keeps the turning ring and the fold row one height, so nothing under them moves as the steps end", () => {
    const view = renderTurn(
      <CurrentRound
        parts={partsOf(MOCKUP_LIVE_TURN, true, ["l3"])}
        completed={false}
      />
    )
    // h-7: 1.75rem, a one-line row's py-0.5 around its 1.5rem line.
    expect(workingOf(list())).toHaveClass("h-7")
    view.unmount()
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const classes = foldOf(list()).className.split(/\s+/)
    expect(classes).toContain("py-0.5")
    expect(classes).toContain("leading-6")
  })

  it("stands the reply's list under the header before its first step, the rail running down to the turning ring", () => {
    renderTurn(<CurrentRound parts={[]} completed={false} />)
    expect(list()).toHaveAttribute("data-headed")
    // The list is its foot alone: the ring where the first step will go, the
    // one turning mark in the reply.
    const working = workingOf(list())!
    expect([...list().children]).toEqual([working])
    expect(document.querySelectorAll('[data-marker="working"]')).toHaveLength(1)
    // Nothing to read in it yet: no list for a screen reader either.
    expect(list()).toHaveAttribute("aria-hidden", "true")
    // Hung as a step would be: nothing but the list's own padding under the
    // capsule, and the rail from it stopping 0.125rem above the ring.
    expect(spacingBetween(activityHeader(), list())).toEqual([])
    const head = remOf(
      globalsDecl(".activity-timeline[data-headed]", "padding-top")
    )
    const rail = ".activity-timeline[data-headed]::before"
    const end =
      remOf(globalsDecl(rail, "top")) + remOf(globalsDecl(rail, "height"))
    const ring = working.firstElementChild!
    expect(ring.getAttribute("class")!.split(/\s+/)).toContain("top-1")
    expect(head + 0.25 - end).toBeCloseTo(0.125)
  })

  it("keeps that list and its ring as the first step joins above the ring", async () => {
    const live = (parts: AdaptedContentPart[]) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StaticConnectionStoreProvider store={STORE}>
          <StaticDelegationProvider value={DELEGATION}>
            <StaticWorkspaceActionsProvider value={WORKSPACE}>
              <CurrentRound parts={parts} completed={false} />
            </StaticWorkspaceActionsProvider>
          </StaticDelegationProvider>
        </StaticConnectionStoreProvider>
      </NextIntlClientProvider>
    )
    const view = render(live([]))
    const standing = list()
    const working = workingOf(standing)!

    view.rerender(
      live([
        {
          type: "tool-call",
          toolCallId: "first",
          toolName: "Read",
          input: JSON.stringify({ file_path: "/r/README.md" }),
          state: "input-available",
        },
      ])
    )

    // The same list, the rail from the header with it; the same ring, under
    // the step that joined above it.
    expect(list()).toBe(standing)
    expect(workingOf(standing)).toBe(working)
    const first = standing.firstElementChild!
    expect(first).toBe(rowOf("/r/README.md"))
    expect(first.nextElementSibling).toBe(working)
    expect(standing).not.toHaveAttribute("aria-hidden")
    // Its segment grows down to the ring, as a later step's does.
    await act(async () => {})
    expect(first).toHaveAttribute("data-rail-enter")
  })

  it("ends an open group's members on a row that folds the group", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const group = rowOf("Explored")
    const header = within(group).getAllByRole("button")[0]!
    fireEvent.click(header)
    const members = group.querySelector(".activity-children")!
    const foot = footOf(members)!
    expect(foot).toBe(members.lastElementChild)
    expect(foot).toHaveClass("activity-child")
    const fold = foldOf(members)
    // What the group holds, as its header says it.
    expect(fold).toHaveAccessibleName("Collapse 3 files, 1 search")
    expect(fold.querySelector("svg.lucide-chevron-up")).toBeTruthy()
    fold.focus()
    fireEvent.click(fold)
    expect(header).toHaveAttribute("aria-expanded", "false")
    expect(group.querySelector(".activity-children")).toBeNull()
    // The focus goes back to the group's header, not to the page.
    expect(document.activeElement).toBe(header)
    // The reply itself stays open.
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
  })

  it("ends a goal's own steps on the turning ring while it runs, then a row that folds its card", () => {
    const goal = (isRunning: boolean): AdaptedContentPart => ({
      type: "goal-run",
      start: {
        type: "tool-call",
        toolCallId: "g-start",
        toolName: "create_goal",
        input: JSON.stringify({ objective: "Tidy the README" }),
        state: "output-available",
      },
      end: null,
      items: [
        {
          type: "tool-call",
          toolCallId: "g-read",
          toolName: "Read",
          input: JSON.stringify({ file_path: "/r/README.md" }),
          state: "output-available",
          output: "# hvac",
        },
      ],
      isRunning,
    })
    const nested = () =>
      [...document.querySelectorAll<HTMLElement>(".activity-timeline")].find(
        (ol) => ol.parentElement!.closest(".activity-timeline")
      )
    const view = renderTurn(
      <CurrentRound parts={[goal(true)]} completed={false} />
    )
    expect(workingOf(nested()!)).toBeTruthy()
    expect(footOf(nested()!)).toBeNull()

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StaticConnectionStoreProvider store={STORE}>
          <StaticDelegationProvider value={DELEGATION}>
            <StaticWorkspaceActionsProvider value={WORKSPACE}>
              <CurrentRound parts={[goal(false)]} completed />
            </StaticWorkspaceActionsProvider>
          </StaticDelegationProvider>
        </StaticConnectionStoreProvider>
      </NextIntlClientProvider>
    )
    // Settled, the card folds by itself; opened, its steps end on the fold.
    if (!nested()) {
      fireEvent.click(screen.getByRole("button", { name: /Tidy the README/ }))
    }
    const steps = nested()!
    const fold = foldOf(steps)
    expect(fold).toHaveAccessibleName("Collapse 1 step")
    fireEvent.click(fold)
    expect(steps.isConnected).toBe(false)
    expect(screen.queryByText("/r/README.md")).toBeNull()
    // The goal's card folded, its row still on the reply's rail.
    expect(
      screen.getByRole("button", { name: /Tidy the README/ })
    ).toHaveAttribute("aria-expanded", "false")
  })

  it("runs the rail past the last row only beside a body under its line", () => {
    // A list with no foot under it — a reply that cannot fold.
    renderSettled(partsOf(STOPPED_ON_FAILURE), 9000)
    const rows = list().querySelectorAll(":scope > li")
    const last = rows[rows.length - 1] as HTMLElement
    // Folded, the last row ends the rail at its ring: no segment.
    expect(last).not.toHaveAttribute("data-body")
    fireEvent.click(within(last).getAllByRole("button")[0]!)
    expect(last).toHaveAttribute("data-body")
    // Prose is a body under its line, open or not.
    expect(
      list().querySelector(':scope > li[data-marker="dot"]')
    ).toHaveAttribute("data-body")
  })

  it("turns a running group's foot, and draws none under its folded member", () => {
    const LIVE: MessageTurn = {
      id: "turn-g",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [
        toolUse("g1", "Bash", { command: "pnpm lint" }),
        toolResult("g1", "ok"),
        toolUse("g2", "Bash", { command: "pnpm test" }),
      ],
    }
    renderTurn(
      <CurrentRound parts={partsOf(LIVE, true, ["g2"])} completed={false} />
    )
    const group = rowOf("Running 2 commands")
    // Open while the reply is written: its members end on the turning ring.
    const members = () => group.querySelector(".activity-children")!
    const working = workingOf(members())!
    expect(working.querySelector(".animate-spin")).toBeTruthy()
    expect(footOf(members())).toBeNull()
    // Folded, the running member shows under the header: one row, no foot.
    fireEvent.click(within(group).getAllByRole("button")[0]!)
    expect(members().querySelectorAll(":scope > li")).toHaveLength(1)
    expect(workingOf(members())).toBeNull()
    expect(footOf(members())).toBeNull()
  })
})

describe("activity timeline: commands", () => {
  const LONG = "pnpm --filter web test -- --watch=false --reporter=verbose"
  const RUN: MessageTurn = {
    id: "turn-c",
    role: "assistant",
    timestamp: "2026-10-22T09:00:00Z",
    blocks: [
      toolUse("c1", "Bash", { command: LONG }),
      toolResult("c1", "48 passed"),
      { type: "text", text: "All green." },
    ],
  }
  let restoreMetrics: (() => void) | null = null
  afterEach(() => {
    restoreMetrics?.()
    restoreMetrics = null
  })

  it("says the command on one line, and the whole of it in the panel when that line cuts it", () => {
    restoreMetrics = mockTruncateLayout(600, 200)
    renderSettled(partsOf(RUN))
    const row = screen.getByTitle(LONG).closest("li")!
    const line = row.querySelector(":scope > button .truncate")!
    // After the fixed label, which stands for the prompt sign on the row.
    expect(line.textContent).toBe(LONG)
    expect(line.previousElementSibling?.textContent).toBe("Command")
    expect(line.parentElement).toHaveClass("overflow-hidden")
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    const panel = row.querySelector(".activity-detail")!
    expect(panel.querySelector("pre")?.textContent).toBe(`$ ${LONG}`)
    expect(within(panel as HTMLElement).getByText("48 passed")).toBeTruthy()
  })

  it("keeps a command its line shows whole out of the panel", () => {
    renderSettled(partsOf(RUN))
    const row = screen.getByTitle(LONG).closest("li")!
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    const panel = row.querySelector(".activity-detail")!
    expect(panel.querySelector("pre")?.textContent).toBe("48 passed")
  })

  it("says what a command is for when the agent did, and opens on the command", () => {
    // After the fixed label, the agent's description is the row's title, in
    // the label's light ink — words, not a command, so no count of the
    // command's lines — and the command takes the description's place atop
    // the panel, whole.
    const DESCRIBED: MessageTurn = {
      id: "turn-d",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [
        toolUse("d1", "Bash", {
          command: "pnpm install\npnpm --filter web test",
          description: "Install and run the web tests",
        }),
        toolResult("d1", "48 passed"),
        { type: "text", text: "All green." },
      ],
    }
    renderSettled(partsOf(DESCRIBED))
    const row = rowOf("Install and run the web tests")
    const header = within(row).getAllByRole("button")[0]!
    expect(header.textContent).toBe("CommandInstall and run the web tests")
    expect(within(header).getByText("Command")).toHaveClass(
      "text-activity-secondary"
    )
    expect(
      within(header).getByText("Install and run the web tests")
    ).toHaveClass("text-activity-secondary")
    expect(header).toHaveAttribute("title", "Install and run the web tests")
    fireEvent.click(header)
    const panel = row.querySelector(".activity-detail") as HTMLElement
    const [command, output] = panel.querySelectorAll("pre")
    expect(command?.textContent).toBe("$ pnpm install\npnpm --filter web test")
    expect(output?.textContent).toBe("48 passed")
    expect(
      within(panel).queryByText("Install and run the web tests")
    ).toBeNull()
  })

  it("scrolls a panel on the app's overlay scrollbars", () => {
    renderSettled(partsOf(RUN))
    const row = screen.getByTitle(LONG).closest("li")!
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    const box = row.querySelector(".activity-detail-box")!
    expect(
      box.querySelector("[data-overlayscrollbars-initialize]")
    ).toBeTruthy()
  })

  it("draws no footer under a panel with nothing in it to copy", () => {
    // A wait on a shell session whose command spans lines opens; it has no
    // command of its own to copy, and this one printed nothing. Its footer
    // used to be an empty bar.
    const WAITED: MessageTurn = {
      id: "turn-w",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [
        toolUse("w1", "wait", {
          cell_id: "7106",
          session_command: "pnpm build\npnpm start",
        }),
        toolResult("w1", ""),
        { type: "text", text: "Started." },
      ],
    }
    renderSettled(partsOf(WAITED))
    const row = rowOf("Wait")
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    const box = row.querySelector(".activity-detail-box")!
    expect(within(box as HTMLElement).getByText("No output")).toBeTruthy()
    expect(box.querySelector(":scope > .border-t")).toBeNull()
  })
})

describe("activity timeline: codex scripts", () => {
  // A script codex ran that the history parser could not take apart into
  // its calls: its first command titles the row.
  const SOURCE = [
    "const cmds = [",
    '  "git show 71be0b15:web/app/page.tsx",',
    '\t"git show ef1c3766:web/app/page.tsx"',
    "];",
    "",
    "const results = await Promise.allSettled(cmds.map((cmd) => tools.exec_command({ cmd })))",
  ].join("\n")
  function scriptTurn(
    output: string,
    failed = false,
    title: string | null = "git show 71be0b15:web/app/page.tsx"
  ): MessageTurn {
    return {
      id: "turn-script",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [
        toolUse("s1", "codex_script", {
          source: SOURCE,
          ...(title ? { title } : {}),
          call_count: 1,
        }),
        toolResult("s1", output, failed),
        { type: "text", text: "Compared them." },
      ],
    }
  }
  /** The script's panel: a failed one is open already. */
  function scriptPanel(
    output: string,
    failed = false,
    title?: string | null
  ): HTMLElement {
    renderSettled(partsOf(scriptTurn(output, failed, title)))
    const row = rowOf("Script")
    // Folded however it ended: the reader opens it.
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    return row.querySelector(".activity-detail-box") as HTMLElement
  }

  const lineBlocks = (panel: HTMLElement) =>
    [...panel.querySelectorAll("[style*='text-indent']")] as HTMLElement[]

  it("sets the script flush in its panel, in the output's type, with no card of its own", () => {
    // It used to be a whole code block — a bordered card, its own font size
    // and padding — inside the panel, with a count of the script's call
    // sites under it.
    const panel = scriptPanel("2 files differ")
    const lines = lineBlocks(panel)
    // As written, but for its tab, set as the spaces to the next tab stop.
    expect(lines.map((line) => line.textContent)).toEqual(
      SOURCE.replace("\t", "    ")
        .split("\n")
        .map((line) => line || "\n")
    )
    const script = lines[0]!.parentElement!
    const output = panel.querySelector("pre.activity-ansi")!
    expect(output.textContent).toBe("2 files differ")
    for (const type of [
      "font-mono",
      "text-[0.78125rem]",
      "leading-relaxed",
      "px-4",
      "py-3",
    ]) {
      expect(script).toHaveClass(type)
      expect(output).toHaveClass(type)
    }
    expect(script).toHaveAttribute("dir", "ltr")
    expect(panel.querySelector("[data-language]")).toBeNull()
    expect(panel.textContent).not.toMatch(/tool call/)
  })

  it("wraps a long line of the script, hung under its own indent", () => {
    const [first, spaced, tabbed, , blank] = lineBlocks(scriptPanel("ok"))
    for (const line of [first, spaced, tabbed]) {
      expect(line).toHaveClass("whitespace-pre-wrap")
      expect(line).toHaveClass("break-words")
    }
    // Wrapped, a line goes on two columns in from where its text starts.
    expect(first!.style.paddingLeft).toBe("2ch")
    expect(first!.style.textIndent).toBe("-2ch")
    expect(spaced!.style.paddingLeft).toBe("4ch")
    expect(spaced!.style.textIndent).toBe("-4ch")
    // A tab is spelled out as the spaces to the next fourth column (the
    // app's tab size): left in, it would land short of it on a hung line,
    // whose tab stops a browser sets from the block's edge.
    expect(tabbed!.textContent!.startsWith('    "git show')).toBe(true)
    expect(tabbed!.style.paddingLeft).toBe("6ch")
    // An empty line keeps its height.
    expect(blank!.textContent).toBe("\n")
  })

  it("copies the script from its panel, not the command the row is titled by", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    try {
      const panel = scriptPanel("2 files differ")
      expect(within(panel).queryByText("copy command")).toBeNull()
      await act(async () => {
        fireEvent.click(within(panel).getByText("copy script"))
      })
      expect(writeText).toHaveBeenCalledWith(SOURCE)
    } finally {
      Reflect.deleteProperty(navigator, "clipboard")
    }
  })

  it("leaves no empty footer under a script with no title that printed nothing", () => {
    // With no command to copy and no output, its footer used to be an empty
    // bar; the script is always there to copy.
    const panel = scriptPanel("", false, null)
    expect(within(panel).getByText("No output")).toBeTruthy()
    const footer = within(panel).getByText("copy script").closest("div")!
    expect(footer.textContent).toBe("copy script")
  })

  describe("with the overlay scrollbars set up", () => {
    const flushDeferred = withOverlayScrollbars()
    /** The panel's scroll bodies: the box's own, then those within it. */
    const hostsOf = (panel: HTMLElement) =>
      [...panel.querySelectorAll("[data-overlayscrollbars-viewport]")].map(
        (viewport) => ({
          host: viewport.parentElement!,
          viewport: viewport as HTMLElement,
        })
      )

    it("gives the script and its output a scroll body each, and the box none", () => {
      // In one body, a long script pushed the output out of the panel; a
      // script scrolling inside it put two scrollbars on one edge.
      const panel = scriptPanel("2 files differ")
      flushDeferred()
      const [box, script, output] = hostsOf(panel)
      expect(hostsOf(panel)).toHaveLength(3)
      expect(overflowOf(box!.host)?.y).toBe("hidden")
      expect(box!.host.className.split(/\s+/)).not.toContain("max-h-72")
      // The script under a lower cap than the output's, one above the other.
      expect(script!.host.className.split(/\s+/)).toContain("max-h-40")
      expect(script!.host.contains(lineBlocks(panel)[0]!)).toBe(true)
      expect(output!.host.className.split(/\s+/)).toContain("max-h-72")
      expect(output!.host.textContent).toBe("2 files differ")
      expect(script!.host.contains(output!.host)).toBe(false)
      for (const { host, viewport } of [script!, output!]) {
        expect(overflowOf(host)?.y).toBe("scroll")
        expect(viewport).toHaveClass("activity-detail-viewport")
      }
    })

    it("opens a failed script's output at its end, where the error is", () => {
      const observers: { notify: () => void; targets: Element[] }[] = []
      vi.stubGlobal(
        "ResizeObserver",
        class {
          entry: (typeof observers)[number]
          constructor(notify: () => void) {
            this.entry = { notify, targets: [] }
            observers.push(this.entry)
          }
          observe(target: Element) {
            this.entry.targets.push(target)
          }
          unobserve() {}
          disconnect() {}
        }
      )
      const panel = scriptPanel(fixtureLines(40, "FAIL"), true)
      flushDeferred()
      const [, script, output] = hostsOf(panel)
      for (const { viewport } of [script!, output!]) {
        scrollable(viewport, 0, 400)
        observers
          .find((observer) => observer.targets.includes(viewport))!
          .notify()
      }
      expect(output!.viewport.scrollTop).toBe(500)
      expect(script!.viewport.scrollTop).toBe(0)
    })
  })
})

describe("activity timeline: file panels", () => {
  const LAYOUT = "/repo/web/app/layout.tsx"
  const PAGE = "/repo/web/app/settings/page.tsx"
  const FILES: MessageTurn = {
    id: "turn-files",
    role: "assistant",
    timestamp: "2026-10-22T09:00:00Z",
    blocks: [
      toolUse("r1", "Read", { file_path: LAYOUT, offset: 10, limit: 2 }),
      toolResult(
        "r1",
        JSON.stringify({
          start_line: 10,
          content: "export default function RootLayout() {\n  return (",
        })
      ),
      toolUse("w1", "Write", {
        file_path: PAGE,
        content: "export default function Page() {}\n",
      }),
      toolResult("w1", `File created successfully at: ${PAGE}`),
      toolUse("e1", "Edit", {
        file_path: LAYOUT,
        old_string: "<nav>Home</nav>",
        new_string: "<nav>\n  <a>Settings</a>\n</nav>",
      }),
      toolResult("e1", `The file ${LAYOUT} has been updated successfully.`),
      { type: "text", text: "Done." },
    ],
  }

  function renderFiles() {
    const openFilePreview = vi.fn(async () => {})
    const workspace = new Proxy(
      { openFilePreview },
      {
        get: (target, key) =>
          key in target ? target[key as keyof typeof target] : () => {},
      }
    ) as unknown as WorkspaceActionsValue
    renderTurn(
      <CurrentRound parts={partsOf(FILES)} durationMs={1000} completed />,
      workspace
    )
    return openFilePreview
  }

  /** Open the row whose header names `text`, and return its panel. */
  function openPanel(text: string | RegExp): HTMLElement {
    const row = screen.getAllByText(text)[0]!.closest("li")!
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    return row.querySelector(".activity-detail") as HTMLElement
  }

  afterEach(() => {
    localStorage.removeItem("workspace:diff-view-mode")
  })

  it("heads a read with the file it read, opening it at the first line read", () => {
    const openFilePreview = renderFiles()
    const panel = openPanel(LAYOUT)
    const name = within(panel).getByTitle(LAYOUT)
    expect(name.textContent).toBe(LAYOUT)
    fireEvent.click(name)
    expect(openFilePreview).toHaveBeenCalledWith(LAYOUT, {
      line: 10,
      folderId: undefined,
    })
  })

  it("heads an edit with the file, its counts and a switch to side by side", () => {
    renderFiles()
    const panel = openPanel("Edited")
    expect(within(panel).getByTitle(LAYOUT).textContent).toBe(LAYOUT)
    expect(within(panel).getByText("+3")).toBeTruthy()
    expect(within(panel).getByText("−1")).toBeTruthy()
    const toggle = within(panel).getByRole("button", {
      name: "Switch to side-by-side view",
    })
    fireEvent.click(toggle)
    // The old and the new text, each in a half of its own.
    const halves = panel.querySelector(".grid-cols-2")!.children
    expect(halves).toHaveLength(2)
    expect(halves[0]!.textContent).toContain("<nav>Home</nav>")
    expect(halves[0]!.textContent).not.toContain("Settings")
    expect(halves[1]!.textContent).toContain("<a>Settings</a>")
    fireEvent.click(
      within(panel).getByRole("button", { name: "Switch to inline view" })
    )
    expect(panel.querySelector(".grid-cols-2")).toBeNull()
  })

  describe("with the overlay scrollbars set up", () => {
    const flushDeferred = withOverlayScrollbars()

    /** The halves of the open side-by-side view: their hosts and viewports. */
    function halvesOf(panel: HTMLElement) {
      return [...panel.querySelector(".grid-cols-2")!.children].map((host) => ({
        host,
        viewport: host.querySelector(
          "[data-overlayscrollbars-viewport]"
        ) as HTMLElement,
      }))
    }

    it("scrolls the two halves of side by side together, both ways", () => {
      localStorage.setItem("workspace:diff-view-mode", "split")
      renderFiles()
      const panel = openPanel("Edited")
      flushDeferred()
      const [left, right] = halvesOf(panel).map((half) => half.viewport)
      expect(left).toBeTruthy()
      expect(right).toBeTruthy()
      scrollable(left!, 300, 80)
      scrollable(right!, 60, 80)

      left!.scrollLeft = 40
      fireEvent.scroll(left!)
      expect(right!.scrollLeft).toBe(40)

      // As far as the shorter half goes, and no further — nor does its stop
      // pull back the half being scrolled.
      left!.scrollLeft = 200
      fireEvent.scroll(left!)
      expect(right!.scrollLeft).toBe(60)
      fireEvent.scroll(right!)
      expect(left!.scrollLeft).toBe(200)

      right!.scrollLeft = 10
      fireEvent.scroll(right!)
      expect(left!.scrollLeft).toBe(10)

      // Down too: each half scrolls its own rows, level with the other's.
      right!.scrollTop = 30
      fireEvent.scroll(right!)
      expect(left!.scrollTop).toBe(30)
    })

    it("caps each half of side by side, not the box, so its sideways scrollbar stays in view", () => {
      // A half that only scrolled sideways inside a box scrolling down had its
      // scrollbar under its last row, out of view until the box was scrolled
      // to the end. Each half now scrolls both ways within the cap, and the
      // box itself does not.
      localStorage.setItem("workspace:diff-view-mode", "split")
      renderFiles()
      const panel = openPanel("Edited")
      flushDeferred()
      const box = panel.querySelector(".activity-detail-box")!
      const own = box.querySelector(
        "[data-overlayscrollbars-viewport]"
      )!.parentElement!
      expect(own.className.split(/\s+/)).not.toContain("max-h-72")
      expect(overflowOf(own)?.y).toBe("hidden")
      const halves = halvesOf(panel)
      expect(halves).toHaveLength(2)
      for (const { host, viewport } of halves) {
        expect(host.className.split(/\s+/)).toContain("max-h-72")
        expect(overflowOf(host)).toMatchObject({ x: "scroll", y: "scroll" })
        // With the box's own edge fade, now that it is what scrolls.
        expect(viewport).toHaveClass("activity-detail-viewport")
      }

      // Inline, the box scrolls both ways, as it always has.
      fireEvent.click(
        within(panel).getByRole("button", { name: "Switch to inline view" })
      )
      flushDeferred()
      const inline = box.querySelector(
        "[data-overlayscrollbars-viewport]"
      )!.parentElement!
      expect(inline.className.split(/\s+/)).toContain("max-h-72")
      expect(overflowOf(inline)).toMatchObject({ x: "scroll", y: "scroll" })
      expect(
        box.querySelectorAll("[data-overlayscrollbars-viewport]")
      ).toHaveLength(1)
    })

    it("caps a file with no before in a side-by-side patch on its own", () => {
      // The box does not scroll side by side, so a file drawn inline in it —
      // one the patch adds — scrolls itself.
      const PATCH: MessageTurn = {
        id: "turn-patch",
        role: "assistant",
        timestamp: "2026-10-22T09:00:00Z",
        blocks: [
          toolUse(
            "p1",
            "apply_patch",
            [
              "*** Begin Patch",
              "*** Update File: web/app/layout.tsx",
              "@@ export default function RootLayout() {",
              "-  return <nav>Home</nav>",
              "+  return <nav>Settings</nav>",
              "*** Add File: web/app/settings/page.tsx",
              "+export default function Page() {}",
              "*** End Patch",
            ].join("\n")
          ),
          toolResult("p1", "Success."),
          { type: "text", text: "Done." },
        ],
      }
      localStorage.setItem("workspace:diff-view-mode", "split")
      renderTurn(
        <CurrentRound parts={partsOf(PATCH)} durationMs={1000} completed />
      )
      const panel = openPanel(/Edited 2 files/)
      flushDeferred()
      expect(halvesOf(panel)).toHaveLength(2)
      const box = panel.querySelector(".activity-detail-box")!
      const own = box.querySelector(
        "[data-overlayscrollbars-viewport]"
      )!.parentElement!
      expect(overflowOf(own)?.y).toBe("hidden")
      const added = within(panel).getByText("export default function Page() {}")
      const host = added.closest(
        "[data-overlayscrollbars-viewport]"
      )!.parentElement!
      // Its own scroll body, inside the box's — not the box's, nor a half.
      expect(host).not.toBe(own)
      expect(host.closest(".grid-cols-2")).toBeNull()
      expect(host.className.split(/\s+/)).toContain("max-h-72")
      expect(overflowOf(host)).toMatchObject({ x: "scroll", y: "scroll" })
    })
  })

  it("runs an inline row's tint under a line scrolled into view sideways", () => {
    // The rows are as wide as the longest line — not the box — so a line
    // scrolled into view keeps its row's colour.
    renderFiles()
    const panel = openPanel("Edited")
    const box = panel.querySelector(".activity-detail-box")!
    const row = box.querySelector(".bg-diff-added")!
    // Some box between the row and the panel sizes to its content, and to
    // no less than the panel.
    const sized: Element[] = []
    for (let node = row.parentElement; node && node !== box; ) {
      const classes = node.className.split(/\s+/)
      if (classes.includes("w-max") && classes.includes("min-w-full")) {
        sized.push(node)
      }
      node = node.parentElement
    }
    expect(sized).toHaveLength(1)
  })

  it.each([
    ["in the middle", "@@ -12,0 +13,2 @@"],
    ["at the top, with no context", "@@ -0,0 +1,2 @@"],
  ])(
    "offers side by side for lines inserted into a file %s, which has a before",
    (_, hunk) => {
      const INSERT: MessageTurn = {
        id: "turn-insert",
        role: "assistant",
        timestamp: "2026-10-22T09:00:00Z",
        blocks: [
          toolUse(
            "p1",
            "apply_patch",
            `--- a/web/app/layout.tsx\n+++ b/web/app/layout.tsx\n${hunk}\n+<a>Settings</a>\n+<a>Help</a>`
          ),
          toolResult("p1", "Success."),
          { type: "text", text: "Done." },
        ],
      }
      renderTurn(
        <CurrentRound parts={partsOf(INSERT)} durationMs={1000} completed />
      )
      const panel = openPanel("Edited")
      expect(
        within(panel).getByRole("button", {
          name: "Switch to side-by-side view",
        })
      ).toBeTruthy()
    }
  )

  it("offers no side by side for a new file, which has no before", () => {
    renderFiles()
    const panel = openPanel("Created")
    expect(within(panel).getByTitle(PAGE).textContent).toBe(PAGE)
    expect(
      within(panel).queryByRole("button", {
        name: "Switch to side-by-side view",
      })
    ).toBeNull()
  })
})

describe("activity timeline: replies without steps", () => {
  it("keeps a Reply header with no fold control", () => {
    renderSettled([{ type: "text", text: "Already on main." }], 3000)
    expect(screen.getByText("Reply")).toBeTruthy()
    expect(screen.getByText("3s")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
    expect(document.querySelector("svg.lucide-chevron-right")).toBeNull()
  })
})
