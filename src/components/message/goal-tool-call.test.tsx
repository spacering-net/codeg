import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { GoalRunPart, GoalToolCallPart } from "./goal-tool-call"
import { GoalControlProvider } from "./goal-control-context"
import type {
  AdaptedContentPart,
  AdaptedGoalRunPart,
} from "@/lib/adapters/ai-elements-adapter"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

function renderWithIntl(
  ui: ReactElement,
  messages = enMessages,
  locale: "en" | "zh-CN" = "en"
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function runningGoalRun(items: AdaptedContentPart[]): AdaptedGoalRunPart {
  return {
    type: "goal-run",
    start: {
      type: "tool-call",
      toolCallId: "call-create-goal",
      toolName: "create_goal",
      input: JSON.stringify({ objective: "Analyze README file" }),
      state: "output-available",
    },
    end: null,
    items,
    isRunning: true,
  }
}

const renderTextPart = (part: AdaptedContentPart, key: string) =>
  part.type === "text" ? <div key={key}>{part.text}</div> : null

describe("GoalToolCallPart", () => {
  it("renders Codex goal completion as a compact goal card", () => {
    renderWithIntl(
      <GoalToolCallPart
        part={{
          type: "tool-call",
          toolCallId: "call-goal",
          toolName: "update_goal",
          input: JSON.stringify({ status: "complete" }),
          state: "output-available",
          output: JSON.stringify({
            goal: {
              objective: "Analyze README file",
              status: "complete",
              tokensUsed: 5184,
              timeUsedSeconds: 19,
            },
            // Real codex output carries an internal LLM instruction here, not a
            // user-facing report. It must never be rendered in the card.
            completionBudgetReport:
              "Goal achieved. Report final usage from this tool result's structured goal fields.",
          }),
        }}
      />
    )

    expect(screen.getByText("Goal: Analyze README file")).toBeInTheDocument()
    expect(screen.queryByText("Goal complete")).not.toBeInTheDocument()
    expect(screen.getByText("5.2K tokens")).toBeInTheDocument()
    expect(screen.getByText("19s")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button"))

    expect(screen.getByText("Objective")).toBeInTheDocument()
    // The internal completionBudgetReport instruction must not leak to the UI.
    expect(screen.queryByText(/Report final usage/)).not.toBeInTheDocument()
  })

  it("wraps in-progress goal process content and shimmers the running title", () => {
    renderWithIntl(
      <GoalRunPart
        part={{
          type: "goal-run",
          start: {
            type: "tool-call",
            toolCallId: "call-create-goal",
            toolName: "create_goal",
            input: JSON.stringify({ objective: "Analyze README file" }),
            state: "output-available",
          },
          end: null,
          items: [{ type: "text", text: "Reading README.md" }],
          isRunning: true,
        }}
        renderPart={(part, key) =>
          part.type === "text" ? <div key={key}>{part.text}</div> : null
        }
      />
    )

    const button = screen.getByRole("button")
    const runningTitle = screen.getByText("Goal: Analyze README file")
    expect(runningTitle).toHaveClass("text-transparent")
    expect(screen.queryByText("Goal active")).not.toBeInTheDocument()
    expect(button.querySelectorAll("svg")).toHaveLength(1)
    // A live goal with process text starts open so the work is visible.
    expect(screen.getByText("Reading README.md")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button"))

    expect(screen.queryByText("Reading README.md")).not.toBeInTheDocument()
  })

  it("opens a live goal when its body arrives without a remount", () => {
    // The production mount order: `create_goal` is adapted on its own, so the
    // card first renders with an EMPTY body and the process content streams in
    // afterwards under the same key. A mount-time seed would miss this.
    const { rerender } = renderWithIntl(
      <GoalRunPart part={runningGoalRun([])} renderPart={renderTextPart} />
    )

    expect(screen.queryByText("Reading README.md")).not.toBeInTheDocument()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <GoalRunPart
          part={runningGoalRun([{ type: "text", text: "Reading README.md" }])}
          renderPart={renderTextPart}
        />
      </NextIntlClientProvider>
    )

    expect(screen.getByText("Reading README.md")).toBeInTheDocument()
  })

  it("keeps a manual collapse across later body updates", () => {
    const { rerender } = renderWithIntl(
      <GoalRunPart
        part={runningGoalRun([{ type: "text", text: "Reading README.md" }])}
        renderPart={renderTextPart}
      />
    )

    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("Reading README.md")).not.toBeInTheDocument()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <GoalRunPart
          part={runningGoalRun([
            { type: "text", text: "Reading README.md" },
            { type: "text", text: "Reading CLAUDE.md" },
          ])}
          renderPart={renderTextPart}
        />
      </NextIntlClientProvider>
    )

    // The user's choice wins over the derived default.
    expect(screen.queryByText("Reading README.md")).not.toBeInTheDocument()
    expect(screen.queryByText("Reading CLAUDE.md")).not.toBeInTheDocument()
  })

  it("collapses the capsule again once the run settles", () => {
    // Settling lifts the answer out of the run (see `groupGoalRuns`), so the
    // capsule folds back to a status chip without hiding anything.
    const { rerender } = renderWithIntl(
      <GoalRunPart
        part={runningGoalRun([{ type: "text", text: "Reading README.md" }])}
        renderPart={renderTextPart}
      />
    )

    expect(screen.getByText("Reading README.md")).toBeInTheDocument()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <GoalRunPart
          part={{
            ...runningGoalRun([{ type: "text", text: "Reading README.md" }]),
            isRunning: false,
          }}
          renderPart={renderTextPart}
        />
      </NextIntlClientProvider>
    )

    expect(screen.queryByText("Reading README.md")).not.toBeInTheDocument()
  })

  it("shows active status for wrapper-prefixed create_goal names", () => {
    renderWithIntl(
      <GoalRunPart
        part={{
          type: "goal-run",
          start: {
            type: "tool-call",
            toolCallId: "call-create-goal",
            toolName: "functions.create_goal",
            input: JSON.stringify({ objective: "Analyze README file" }),
            state: "output-available",
          },
          end: null,
          items: [],
          isRunning: true,
        }}
        renderPart={() => null}
      />
    )

    expect(screen.getByText("Goal: Analyze README file")).toBeInTheDocument()
    expect(screen.queryByText("Goal active")).not.toBeInTheDocument()
  })

  it("localizes the title label", () => {
    renderWithIntl(
      <GoalRunPart
        part={{
          type: "goal-run",
          start: {
            type: "tool-call",
            toolCallId: "call-create-goal",
            toolName: "create_goal",
            input: JSON.stringify({ objective: "分析 README 文件" }),
            state: "output-available",
          },
          end: null,
          items: [],
          isRunning: true,
        }}
        renderPart={() => null}
      />,
      zhMessages,
      "zh-CN"
    )

    expect(screen.getByText("目标：分析 README 文件")).toBeInTheDocument()
  })
})

describe("GoalRunPart error", () => {
  // claude-agent-acp fences a failed tool's result for markdown clients; the
  // card shows it as preformatted text, as the transcript records it.
  it("shows a fenced error without its fence", () => {
    renderWithIntl(
      <GoalRunPart
        part={{
          type: "goal-run",
          start: {
            type: "tool-call",
            toolCallId: "call-create-goal",
            toolName: "create_goal",
            input: JSON.stringify({ objective: "Analyze README file" }),
            state: "output-error",
            errorText: "```\nGoal already active.\n```",
          },
          end: null,
          items: [],
          isRunning: false,
        }}
        renderPart={renderTextPart}
      />
    )
    expect(screen.getByText("Goal already active.").textContent).toBe(
      "Goal already active."
    )
  })
})

describe("GoalCard goal control (codex-acp #293)", () => {
  function renderGoal(
    ui: ReactElement,
    onGoalControl: ((action: "pause" | "clear") => void) | null,
    // Defaults to the legacy vocabulary so pre-extension expectations hold;
    // pass the advertised list to exercise per-adapter gating (claude
    // advertises ["set","clear"] — no pause).
    actions: readonly string[] = ["pause", "clear"]
  ) {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <GoalControlProvider value={{ onGoalControl, actions }}>
          {ui}
        </GoalControlProvider>
      </NextIntlClientProvider>
    )
  }

  function goalWith(status: string): ReactElement {
    const toolName = status === "active" ? "create_goal" : "update_goal"
    return (
      <GoalToolCallPart
        part={{
          type: "tool-call",
          toolCallId: `g-${status}`,
          toolName,
          input: JSON.stringify({ status }),
          state: "output-available",
          output: JSON.stringify({
            goal: { objective: "Ship the release", status },
          }),
        }}
      />
    )
  }

  it("offers Pause + Clear on a live active goal and routes the action", () => {
    const calls: string[] = []
    renderGoal(goalWith("active"), (a) => calls.push(a))
    // Controls live in the (collapsed) body — expand first.
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getByText("Pause"))
    fireEvent.click(screen.getByText("Clear"))
    expect(calls).toEqual(["pause", "clear"])
  })

  it("offers only Clear on a paused goal (codex has no resume control)", () => {
    renderGoal(goalWith("paused"), () => {})
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Clear")).toBeInTheDocument()
    expect(screen.queryByText("Pause")).not.toBeInTheDocument()
  })

  it("shows no controls on a terminal goal", () => {
    renderGoal(goalWith("complete"), () => {})
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("Pause")).not.toBeInTheDocument()
    expect(screen.queryByText("Clear")).not.toBeInTheDocument()
  })

  it("hides controls when the session isn't live (no provider callback)", () => {
    // Reload / viewer / sub-agent dialog → onGoalControl null → no buttons even
    // for an active goal.
    renderGoal(goalWith("active"), null)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("Pause")).not.toBeInTheDocument()
    expect(screen.queryByText("Clear")).not.toBeInTheDocument()
  })

  it("gates each button on the adapter's advertised action vocabulary", () => {
    // claude's neutral goal extension advertises ["set","clear"] — offering
    // Pause there would fire a request the adapter rejects.
    const calls: string[] = []
    renderGoal(goalWith("active"), (a) => calls.push(a), ["set", "clear"])
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("Pause")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Clear"))
    expect(calls).toEqual(["clear"])
  })

  it("shows no controls when the adapter advertises an empty action set", () => {
    renderGoal(goalWith("active"), () => {}, [])
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("Pause")).not.toBeInTheDocument()
    expect(screen.queryByText("Clear")).not.toBeInTheDocument()
  })
})
