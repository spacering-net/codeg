import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { COLLAB_OP_KEY } from "@/lib/collab-tool"
import { ContentPartsRenderer } from "../../content-parts-renderer"

/**
 * codex's live collab sub-agent ops (spawn / wait / close / list) as timeline
 * rows — drawn through the reply renderer, the way the thread draws them.
 */

type ToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

let callSeq = 0

function collab(
  o: {
    prompt?: string
    op?: string
    agents?: Record<string, { status: string; message: string | null }>
    status?: string
    model?: string
    reasoningEffort?: string
  },
  state: ToolCallPart["state"],
  errorText?: string
): ToolCallPart {
  callSeq += 1
  return {
    type: "tool-call",
    toolCallId: `call-collab-${callSeq}`,
    toolName: "collab_agent",
    input: JSON.stringify({
      prompt: o.prompt ?? "",
      senderThreadId: "t-main",
      receiverThreadIds: Object.keys(o.agents ?? {}),
      agentsStates: o.agents ?? {},
      status: o.status ?? "inProgress",
      ...(o.model ? { model: o.model } : {}),
      ...(o.reasoningEffort ? { reasoningEffort: o.reasoningEffort } : {}),
      ...(o.op ? { [COLLAB_OP_KEY]: o.op } : {}),
    }),
    state,
    ...(errorText ? { errorText } : {}),
  }
}

function ui(part: ToolCallPart) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={[part]} role="assistant" />
    </NextIntlClientProvider>
  )
}

function renderRow(part: ToolCallPart) {
  return render(ui(part))
}

function row(): HTMLElement {
  const li = document.querySelector("li")
  if (!li) throw new Error("no row")
  return li as HTMLElement
}

/** The row's header — a button when it has a panel to open. */
function header(): HTMLElement {
  const el = row().querySelector(":scope > button, :scope > div")
  if (!el) throw new Error("no header")
  return el as HTMLElement
}

describe("CollabAgentRow", () => {
  it("is a timeline row, not the old capsule", () => {
    renderRow(
      collab(
        {
          op: "wait",
          status: "completed",
          agents: {
            "22220000-bbbb-cccc-dddd-eeeeeeeeeeee": {
              status: "completed",
              message: null,
            },
          },
        },
        "output-available"
      )
    )
    expect(row().className).toContain("activity-item")
    expect(document.querySelector(".ws-msg-chip")).toBeNull()
    expect(screen.queryByText("View sub-agent session")).toBeNull()
  })

  it("heads a spawn with the op, the short id and the task; the panel holds the task", () => {
    renderRow(
      collab(
        {
          prompt: "Build the app\nUNIQUE_BODY_TOKEN here",
          op: "spawnAgent",
          agents: {
            "11110000-aaaa-bbbb": { status: "running", message: null },
          },
        },
        "input-available"
      )
    )
    expect(screen.getByText("Starting sub-agent")).toBeInTheDocument()
    expect(screen.getByText("#11110000")).toBeInTheDocument()
    expect(
      screen.getByText("Build the app UNIQUE_BODY_TOKEN here")
    ).toBeInTheDocument()
    expect(row().querySelectorAll("pre, .prose")).toHaveLength(0)

    fireEvent.click(header())
    expect(row().querySelector(".prose")?.textContent).toContain(
      "UNIQUE_BODY_TOKEN"
    )
  })

  it("shows a spawn's model and reasoning effort in its panel", () => {
    renderRow(
      collab(
        {
          prompt: "Build the app",
          op: "spawnAgent",
          model: "gpt-5-codex",
          reasoningEffort: "high",
          agents: { "11110000-aaaa": { status: "running", message: null } },
        },
        "input-available"
      )
    )
    fireEvent.click(header())
    expect(screen.getByText("gpt-5-codex")).toBeInTheDocument()
    expect(screen.getByText("high")).toBeInTheDocument()
  })

  it("does not show model/effort on a wait (live/reload parity)", () => {
    renderRow(
      collab(
        {
          op: "wait",
          status: "completed",
          model: "gpt-5-codex",
          reasoningEffort: "high",
          agents: { "22220000-bbbb": { status: "completed", message: "done" } },
        },
        "output-available"
      )
    )
    fireEvent.click(header())
    expect(screen.queryByText("gpt-5-codex")).not.toBeInTheDocument()
    expect(screen.queryByText("high")).not.toBeInTheDocument()
  })

  it("gives a wait its op label and the child's short id", () => {
    renderRow(
      collab(
        {
          op: "wait",
          agents: {
            "22220000-cccc-dddd": { status: "running", message: null },
          },
        },
        "input-available"
      )
    )
    expect(screen.getByText("Fetching sub-agent result")).toBeInTheDocument()
    expect(screen.getByText("#22220000")).toBeInTheDocument()
  })

  it("leaves a resultless wait with nothing to open", () => {
    renderRow(
      collab(
        {
          op: "wait",
          status: "completed",
          agents: { "22220000-bbbb": { status: "completed", message: null } },
        },
        "output-available"
      )
    )
    expect(screen.getByText("Fetching sub-agent result")).toBeInTheDocument()
    expect(header().tagName).not.toBe("BUTTON")
  })

  it("offers the child's conversation when the op names one codex thread", () => {
    renderRow(
      collab(
        {
          op: "wait",
          status: "completed",
          agents: {
            "019a1cf0-5aaa-7bbb-8ccc-0123456789ab": {
              status: "completed",
              message: null,
            },
          },
        },
        "output-available"
      )
    )
    expect(screen.getByText("Open conversation")).toBeInTheDocument()
  })

  it("op labels survive snake_case spellings", () => {
    const { unmount } = renderRow(
      collab(
        {
          op: "wait_agent",
          agents: { "t-sub": { status: "running", message: null } },
        },
        "input-available"
      )
    )
    expect(screen.getByText("Fetching sub-agent result")).toBeInTheDocument()
    unmount()

    renderRow(
      collab({ op: "close_agent", status: "completed" }, "output-available")
    )
    expect(screen.getByText("Closing sub-agent")).toBeInTheDocument()
  })

  it("badges several children as the first (short) + count", () => {
    renderRow(
      collab(
        {
          op: "wait",
          status: "completed",
          agents: {
            "33330000-x": { status: "completed", message: "A done" },
            "44440000-y": { status: "completed", message: "B done" },
          },
        },
        "output-available"
      )
    )
    expect(screen.getByText("#33330000 +1")).toBeInTheDocument()
    expect(screen.queryByText("Open conversation")).toBeNull()
  })

  it("previews a wait's result under the header and shows it whole in the panel", () => {
    renderRow(
      collab(
        {
          op: "wait",
          status: "completed",
          agents: {
            "t-sub": {
              status: "completed",
              message: "Build succeeded with exit code `0`\n\nMORE_DETAIL",
            },
          },
        },
        "output-available"
      )
    )
    expect(
      screen.getByText("Build succeeded with exit code 0")
    ).toBeInTheDocument()
    expect(screen.queryByText(/MORE_DETAIL/)).toBeNull()
    fireEvent.click(header())
    expect(screen.getByText(/MORE_DETAIL/)).toBeInTheDocument()
  })

  it("opens an errored child by itself and shows its message", () => {
    renderRow(
      collab(
        {
          prompt: "risky",
          op: "spawnAgent",
          agents: { "t-sub": { status: "errored", message: "boom" } },
        },
        "output-available"
      )
    )
    expect(screen.getByText(/boom/)).toBeInTheDocument()
    expect(row().dataset.status).toBe("failed")
  })

  it("treats notFound as an error", () => {
    renderRow(
      collab(
        {
          op: "wait",
          agents: { "t-sub": { status: "notFound", message: "gone" } },
        },
        "output-available"
      )
    )
    expect(row().dataset.status).toBe("failed")
    expect(screen.getAllByText(/gone/).length).toBeGreaterThan(0)
  })

  it("draws an interrupted child as interrupted, not failed", () => {
    renderRow(
      collab(
        {
          op: "wait",
          agents: { "t-sub": { status: "interrupted", message: "halted" } },
        },
        "output-available"
      )
    )
    expect(row().dataset.status).toBe("cancelled")
  })

  it("falls back to the generic label with no prompt and an unknown op", () => {
    renderRow(
      collab(
        { agents: { "t-sub": { status: "running", message: null } } },
        "input-available"
      )
    )
    expect(screen.getByText("Sub-agent")).toBeInTheDocument()
  })

  it("shows a failed op's error text, opened", () => {
    renderRow(
      collab({ op: "wait", status: "failed" }, "output-error", "OP_FAILED_TEXT")
    )
    expect(screen.getByText("OP_FAILED_TEXT")).toBeInTheDocument()
    expect(screen.getByText("Fetching sub-agent result")).toBeInTheDocument()
  })

  it("opens when a running op turns into a failure", () => {
    const running = collab(
      {
        op: "wait",
        agents: { "t-sub": { status: "running", message: null } },
      },
      "input-available"
    )
    const { rerender } = render(ui(running))
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument()

    rerender(
      ui({
        ...running,
        input: collab(
          {
            op: "wait",
            status: "failed",
            agents: { "t-sub": { status: "errored", message: "boom" } },
          },
          "output-error"
        ).input,
        state: "output-error",
      })
    )
    expect(screen.getAllByText(/boom/).length).toBeGreaterThan(0)
  })
})
