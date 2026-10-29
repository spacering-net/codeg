import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { EMPTY_TOOL_APPROVALS } from "@/lib/activity/approval"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { ActivityLiveProvider } from "./activity/activity-live-context"
import {
  CompletedTurnContent,
  splitAssistantTurnParts,
} from "./completed-turn-content"

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const COMPLETED_PARTS: AdaptedContentPart[] = [
  {
    type: "reasoning",
    content: "Inspecting the repository",
    isStreaming: false,
  },
  { type: "text", text: "I found the relevant component." },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "Read",
    input: '{"file_path":"src/app.tsx"}',
    state: "output-available",
    output: "source",
  },
  { type: "text", text: "The fix is complete." },
]

// Expansion is remembered per `parts` array identity (so a virtualizer-
// recycled row re-mounts open), which makes a shared array a hidden channel
// between tests. Render tests take a fresh copy.
const freshCompletedParts = (): AdaptedContentPart[] => [...COMPLETED_PARTS]

/**
 * Prose the agent is still writing fades in a character at a time, each its
 * own span while it does: it is found by the element that holds all of it.
 */
const writing = (text: string) => (_: string, element: Element | null) =>
  element?.textContent === text &&
  ![...element.children].some((child) => child.textContent === text)

/** The header's fold control: its label. */
const toggle = () =>
  screen.getByRole("button", { name: /^(Activity|Working)$/ })
const queryToggle = () =>
  screen.queryByRole("button", { name: /^(Activity|Working)$/ })

describe("splitAssistantTurnParts", () => {
  it("keeps only the trailing final response outside progress", () => {
    const split = splitAssistantTurnParts(COMPLETED_PARTS)

    expect(split.progress).toEqual(COMPLETED_PARTS.slice(0, 3))
    expect(split.answer).toEqual(COMPLETED_PARTS.slice(3))
  })

  it("does not guess within a text-only answer", () => {
    const parts: AdaptedContentPart[] = [
      { type: "text", text: "First paragraph" },
      { type: "text", text: "Second paragraph" },
    ]

    expect(splitAssistantTurnParts(parts)).toEqual({
      progress: [],
      answer: parts,
    })
  })
})

describe("CompletedTurnContent with nothing left to show", () => {
  // A reply that ends on its last tool call has no trailing answer, so
  // collapsing would leave an empty bubble under a lone header.
  // Reachable on every agent (a turn stopped mid-tool-call) and by design on
  // some: Cline's `attempt_completion` card and a plan-mode turn's
  // ExitPlanMode card ARE the answer.
  const TOOL_ONLY_PARTS: AdaptedContentPart[] = [
    { type: "text", text: "Wrapping up." },
    {
      type: "tool-call",
      toolCallId: "call-final",
      toolName: "attempt_completion",
      input: '{"result":"All done."}',
      state: "output-available",
      output: null,
    },
  ]

  it("stays expanded when the reply ends on progress", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={TOOL_ONLY_PARTS}
        durationMs={5_000}
        completed
      />
    )

    // The header still reports the duration — it is the only place that does
    // now — but with no toggle that could hide the reply.
    expect(screen.getByText("Activity")).toBeInTheDocument()
    // The time follows the step count on the same line.
    const header = document.querySelector("div.activity-capsule")!
    expect(header.textContent).toMatch(/5s$/)
    expect(queryToggle()).toBeNull()
    expect(screen.getByText("Wrapping up.")).toBeInTheDocument()
    // The completion card renders the result as both its header title and its
    // body, so match on presence rather than a unique node.
    expect(screen.getAllByText("All done.").length).toBeGreaterThan(0)
  })

  it("does not treat a blank trailing text part as the answer", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={[...TOOL_ONLY_PARTS, { type: "text", text: "   \n" }]}
        durationMs={5_000}
        completed
      />
    )

    expect(screen.getByText("Activity")).toBeInTheDocument()
    expect(queryToggle()).toBeNull()
    expect(screen.getAllByText("All done.").length).toBeGreaterThan(0)
  })

  it("keeps folding it away impossible even after a send folds the thread", () => {
    // The "send folds everything above" epoch bump must not reach a reply that
    // has no answer to fall back on.
    const parts = [...TOOL_ONLY_PARTS]
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={parts}
        durationMs={5_000}
        completed
        foldEpoch={0}
      />
    )
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={parts}
          durationMs={5_000}
          completed
          foldEpoch={1}
        />
      </NextIntlClientProvider>
    )

    expect(screen.getAllByText("All done.").length).toBeGreaterThan(0)
  })
})

describe("CompletedTurnContent", () => {
  it("collapses completed progress by default and keeps the answer visible", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={69_000}
        completed
      />
    )

    expect(document.querySelector("div.activity-capsule")!.textContent).toMatch(
      /1m 9s$/
    )
    const trigger = toggle()
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText("The fix is complete.")).toBeInTheDocument()
    expect(
      screen.queryByText("I found the relevant component.")
    ).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    expect(screen.getByText("The fix is complete.")).toBeInTheDocument()
  })

  it("re-mounts expanded after the virtualizer recycled the row", () => {
    // Scrolling a turn past the overscan buffer unmounts it; coming back must
    // not re-hide work the reader had opened. Same `parts` reference across
    // both mounts — that is what survives the recycle in the real thread.
    const parts = freshCompletedParts()
    const first = renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )
    fireEvent.click(toggle())
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    first.unmount()

    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )

    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
  })

  it("leaves running progress expanded under a live header", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={69_000}
        completed={false}
      />
    )

    // A running reply's header says it is working, not how long it took.
    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.queryByText(/1m 9s/)).not.toBeInTheDocument()
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    expect(screen.getByText("src/app.tsx")).toBeInTheDocument()
    expect(
      screen.getByText(writing("The fix is complete."))
    ).toBeInTheDocument()
  })

  it("does not fold the round when the reply finishes", () => {
    // The regression this guards: fold state used to be keyed on the `parts`
    // array, which the stream settling replaces — so a reply folded itself up
    // the instant it finished. The host owns the round positionally now, so a
    // re-adapted (new array) settled reply must stay exactly as open as it was.
    const live = freshCompletedParts()
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={live}
        durationMs={null}
        completed={false}
        currentRound
        roundOpen
        foldEpoch={0}
      />
    )
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()

    // Settling re-adapts the turn: same content, brand-new array.
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={freshCompletedParts()}
          durationMs={69_000}
          completed
          currentRound
          roundOpen
          foldEpoch={0}
        />
      </NextIntlClientProvider>
    )

    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
  })

  it("does not replay the unfold when an open reply re-mounts", () => {
    // This component re-mounts while staying open: the detail refetch renames
    // the turn, and the virtualizer recycles scrolled-away rows. Each of those
    // would replay the 200ms unfold — the reply would look like it collapsed
    // and re-opened by itself.
    const foldBody = () =>
      document.querySelector('[data-slot="collapsible-content"]')

    const parts = freshCompletedParts()
    const first = renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )
    // A real toggle DOES animate.
    fireEvent.click(toggle())
    expect(foldBody()).toHaveClass("reply-fold-enter")
    first.unmount()

    // Re-mounted already open (same `parts`, so the fold override survives).
    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(foldBody()).not.toHaveClass("reply-fold-enter")
  })

  it("unfolds nothing when the failure link opens a reply that cannot fold", () => {
    // Stopped on a failed call, with no answer: its steps are on show already,
    // so opening it moves nothing.
    const parts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "call-fail",
        toolName: "Bash",
        input: '{"command":"pnpm build"}',
        state: "output-error",
        errorText: "exit 1",
      },
    ]
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0)
    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={9000} completed />
    )
    fireEvent.click(screen.getByRole("button", { name: "1 failed" }))
    expect(
      document.querySelector('[data-slot="collapsible-content"]')
    ).not.toHaveClass("reply-fold-enter")
    vi.restoreAllMocks()
  })

  it("folds a hand-opened reply when a send bumps the epoch", () => {
    const parts = freshCompletedParts()
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={parts}
        durationMs={69_000}
        completed
        foldEpoch={3}
      />
    )
    fireEvent.click(toggle())
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={parts}
          durationMs={69_000}
          completed
          foldEpoch={4}
        />
      </NextIntlClientProvider>
    )

    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    expect(
      screen.queryByText("I found the relevant component.")
    ).not.toBeInTheDocument()
  })

  it("shows a static duration header on a reply with nothing to fold", () => {
    // The reply's footer no longer carries a duration chip, so a plain prose
    // answer would otherwise lose its elapsed time entirely.
    renderWithIntl(
      <CompletedTurnContent
        parts={[{ type: "text", text: "Just an answer." }]}
        durationMs={69_000}
        completed
      />
    )

    expect(screen.getByText("Reply")).toBeInTheDocument()
    expect(screen.getByText("1m 9s")).toBeInTheDocument()
    expect(queryToggle()).toBeNull()
    expect(screen.getByText("Just an answer.")).toBeInTheDocument()
  })

  it("keeps a header while the duration has not been backfilled yet", () => {
    // A reply settles before the post-turn reparse patches `duration_ms` onto
    // it. Dropping the header for that window made it blink out between
    // "Working" and "Reply · 3s"; the bare label holds the slot instead.
    renderWithIntl(
      <CompletedTurnContent
        parts={[{ type: "text", text: "Just an answer." }]}
        durationMs={null}
        completed
      />
    )

    expect(screen.getByText("Reply")).toBeInTheDocument()
    expect(screen.getByText("Just an answer.")).toBeInTheDocument()
  })

  it("stays invisible for an empty placeholder turn", () => {
    // Parsers emit blank assistant turns between tool exchanges. Heading one
    // would promote an invisible turn into a visible empty one.
    const { container } = renderWithIntl(
      <CompletedTurnContent parts={[]} durationMs={null} completed />
    )

    expect(screen.queryByText("Reply")).not.toBeInTheDocument()
    expect(container.textContent).toBe("")
  })
})

describe("CompletedTurnContent: the turning mark while the agent works", () => {
  const RUNNING_PARTS = (): AdaptedContentPart[] => [
    { type: "text", text: "Checking the component." },
    {
      type: "tool-call",
      toolCallId: "call-run",
      toolName: "Read",
      input: '{"file_path":"src/app.tsx"}',
      state: "input-available",
    },
  ]
  const marks = (container: HTMLElement) =>
    container.querySelectorAll('[data-marker="working"]')
  const onRail = (container: HTMLElement) =>
    container.querySelector('.activity-timeline > [data-marker="working"]')
  /** The row that folds the open steps, at their foot. */
  const fold = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(
      '.activity-timeline > [data-marker="foot"] > button'
    )

  it("hangs it off the rail while the timeline ends the reply", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={RUNNING_PARTS()}
        durationMs={null}
        completed={false}
      />
    )

    expect(marks(container)).toHaveLength(1)
    const mark = onRail(container)
    // Last on the rail, so the steps that join go in above it.
    expect(mark).not.toBeNull()
    expect(mark!.parentElement!.lastElementChild).toBe(mark)
    expect(mark).toHaveAttribute("aria-hidden", "true")
    // One plain element turns: every frame restyles it and its children, and
    // an SVG's turn would lay the page out too, for as long as it streams.
    const turning = mark!.querySelector(".animate-spin")
    expect(turning?.tagName).toBe("SPAN")
    expect(turning?.childElementCount).toBe(0)
    // A single ring: no fold row while the agent works.
    expect(fold(container)).toBeNull()
  })

  it("hangs it under the prose being written after the last step, on the rail", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={null}
        completed={false}
      />
    )

    // Until the reply ends there is no telling an aside from its closing
    // words: the prose is a step, the last on the rail, with the one ring
    // under it — not an answer under the steps with the ring turning above
    // the words being written.
    expect(marks(container)).toHaveLength(1)
    const mark = onRail(container)!
    expect(screen.getAllByText(writing("The fix is complete."))).toHaveLength(1)
    const prose = screen
      .getByText(writing("The fix is complete."))
      .closest(".activity-timeline > li")
    expect(prose).toHaveAttribute("data-marker", "dot")
    expect(prose!.nextElementSibling).toBe(mark)
  })

  it("keeps the next step's row under that prose, where it was written", () => {
    // The call that follows goes in under the prose, above the ring; the
    // prose's row stays the same element.
    const parts = freshCompletedParts()
    const view = renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={null} completed={false} />
    )
    const prose = screen
      .getByText(writing("The fix is complete."))
      .closest(".activity-timeline > li")!

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={[
            ...parts,
            {
              type: "tool-call",
              toolCallId: "call-2",
              toolName: "Read",
              input: '{"file_path":"src/next.tsx"}',
              state: "input-available",
            },
          ]}
          durationMs={null}
          completed={false}
        />
      </NextIntlClientProvider>
    )

    expect(
      screen
        .getByText(writing("The fix is complete."))
        .closest(".activity-timeline > li")
    ).toBe(prose)
    const next = screen
      .getByText("src/next.tsx")
      .closest(".activity-timeline > li")!
    expect(prose.nextElementSibling).toBe(next)
    expect(next.nextElementSibling).toBe(onRail(view.container))
  })

  it("keeps the prose under the header, the mark under it, while the reply is folded", () => {
    // Folded there is no rail to put it on: the words being written stay in
    // view as the answer does.
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={null}
        completed={false}
      />
    )

    fireEvent.click(toggle())

    const prose = screen.getByText(writing("The fix is complete."))
    expect(prose.closest(".activity-timeline")).toBeNull()
    expect(marks(container)).toHaveLength(1)
    expect(onRail(container)).toBeNull()
    expect(
      prose.compareDocumentPosition(marks(container)[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("keeps a thought's row while what it says first is still short", () => {
    // Steps without an id of their own are keyed by an anchor hashed from the
    // reply's opening words, which change while those are still few.
    const thinking = (content: string): AdaptedContentPart[] => [
      { type: "reasoning", content, isStreaming: true },
    ]
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={thinking("Look")}
        durationMs={null}
        completed={false}
      />
    )
    const row = view.container.querySelector("li[data-step-key^='thought']")
    expect(row).not.toBeNull()
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={thinking("Looking at the repository layout first")}
          durationMs={null}
          completed={false}
        />
      </NextIntlClientProvider>
    )
    expect(view.container.querySelector("li[data-step-key^='thought']")).toBe(
      row
    )
  })

  it("hangs it on a rail from the header while the reply has nothing in it yet", () => {
    // The pending reply's shape too (`parts` empty): the reply's list stands
    // under the header with its foot alone, the ring where the first step
    // will go, the rail running down to it from the header.
    const { container } = renderWithIntl(
      <CompletedTurnContent parts={[]} durationMs={null} completed={false} />
    )

    expect(marks(container)).toHaveLength(1)
    const mark = onRail(container)!
    expect(mark).not.toBeNull()
    expect(mark.parentElement).toHaveAttribute("data-headed")
    expect(mark.parentElement!.children).toHaveLength(1)
    // No header toggle: there is nothing to fold yet.
    expect(queryToggle()).toBeNull()
  })

  it("puts it under the words of a reply that has no step to hang them on", () => {
    // Prose with no step before it is no list: the words sit under the
    // header as an answer does, the mark under them, no rail.
    const view = renderWithIntl(
      <CompletedTurnContent parts={[]} durationMs={null} completed={false} />
    )

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={[{ type: "text", text: "Let me look." }]}
          durationMs={null}
          completed={false}
        />
      </NextIntlClientProvider>
    )
    expect(marks(view.container)).toHaveLength(1)
    expect(onRail(view.container)).toBeNull()
    expect(view.container.querySelector(".activity-timeline")).toBeNull()
    expect(
      screen
        .getByText(writing("Let me look."))
        .compareDocumentPosition(marks(view.container)[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("moves it under the header when the reader folds the reply", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={RUNNING_PARTS()}
        durationMs={null}
        completed={false}
      />
    )

    fireEvent.click(toggle())

    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    expect(marks(container)).toHaveLength(1)
    expect(onRail(container)).toBeNull()
  })

  it("never turns two marks while the folding steps slide shut", () => {
    // jsdom runs no animations: report the fold's exit, which keeps the steps
    // mounted until it ends — the mark under the reply is there by then.
    const computed = window.getComputedStyle
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudo) =>
        element.classList.contains("reply-fold-body") &&
        element.getAttribute("data-state") === "closed"
          ? ({
              animationName: "reply-fold-close",
              animationDuration: "0.16s",
              animationDelay: "0s",
            } as CSSStyleDeclaration)
          : computed(element, pseudo)
      )
    try {
      const { container } = renderWithIntl(
        <CompletedTurnContent
          parts={RUNNING_PARTS()}
          durationMs={null}
          completed={false}
        />
      )
      fireEvent.click(toggle())
      // Still sliding shut, its steps in view...
      expect(container.querySelector(".activity-timeline > li")).not.toBeNull()
      // ...with one turning mark, under the reply.
      expect(marks(container)).toHaveLength(1)
      expect(onRail(container)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it("shows the prose being written once while the folding steps slide shut", () => {
    // The steps stay mounted until the fold's exit ends; the words being
    // written leave the rail at once for their place under the header, not
    // drawn in both for the length of the slide.
    const computed = window.getComputedStyle
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudo) =>
        element.classList.contains("reply-fold-body") &&
        element.getAttribute("data-state") === "closed"
          ? ({
              animationName: "reply-fold-close",
              animationDuration: "0.16s",
              animationDelay: "0s",
            } as CSSStyleDeclaration)
          : computed(element, pseudo)
      )
    try {
      const { container } = renderWithIntl(
        <CompletedTurnContent
          parts={freshCompletedParts()}
          durationMs={null}
          completed={false}
        />
      )
      fireEvent.click(toggle())
      expect(container.querySelector(".activity-timeline > li")).not.toBeNull()
      expect(screen.getAllByText(writing("The fix is complete."))).toHaveLength(
        1
      )
      expect(
        screen
          .getByText(writing("The fix is complete."))
          .closest(".activity-timeline")
      ).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it.each([
    ["a permission request about one of its calls", "call-run"],
    ["a question or a plan to approve", null],
  ])("leaves it out while the agent waits on %s", (_, awaitingToolCallId) => {
    const { container } = renderWithIntl(
      <ActivityLiveProvider
        value={{
          awaitingToolCallId,
          awaitingUser: true,
          approvals: EMPTY_TOOL_APPROVALS,
        }}
      >
        <CompletedTurnContent
          parts={RUNNING_PARTS()}
          durationMs={null}
          completed={false}
        />
      </ActivityLiveProvider>
    )

    expect(marks(container)).toHaveLength(0)
    // Nothing at work: the steps end on the row that folds them.
    expect(fold(container)).not.toBeNull()
  })

  it("stands no list in a reply with nothing in it while the agent waits on the user", () => {
    // The list stands for the turning ring alone; with nothing turning it
    // would be a rail to nothing.
    const { container } = renderWithIntl(
      <ActivityLiveProvider
        value={{
          awaitingToolCallId: null,
          awaitingUser: true,
          approvals: EMPTY_TOOL_APPROVALS,
        }}
      >
        <CompletedTurnContent parts={[]} durationMs={null} completed={false} />
      </ActivityLiveProvider>
    )

    expect(marks(container)).toHaveLength(0)
    expect(container.querySelector(".activity-timeline")).toBeNull()
  })

  it("stops once the reply is done, the ring giving way to the fold row", () => {
    const parts = freshCompletedParts()
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={parts}
        durationMs={null}
        completed={false}
        currentRound
        roundOpen
      />
    )
    expect(onRail(view.container)).not.toBeNull()

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={parts}
          durationMs={4_000}
          completed
          currentRound
          roundOpen
        />
      </NextIntlClientProvider>
    )
    expect(marks(view.container)).toHaveLength(0)
    const row = fold(view.container)!
    expect(row).toHaveAccessibleName("Collapse 1 step · 4s")
    expect(row.querySelector("svg.lucide-chevron-up")).toBeTruthy()
    // The closing prose, a step while it was written, is lifted out under
    // the steps as the answer — once, not left on the rail as well.
    expect(screen.getAllByText("The fix is complete.")).toHaveLength(1)
    const answer = screen.getByText("The fix is complete.")
    expect(answer.closest(".activity-timeline")).toBeNull()
    expect(
      row.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
