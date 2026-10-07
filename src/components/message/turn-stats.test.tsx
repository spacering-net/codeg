import { type ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// The create-task action pulls workbench-route + tab-store contexts that this
// unit test doesn't mount; stub it to a no-op handler.
vi.mock("./use-create-task-from-message", () => ({
  useCreateTaskFromMessage: () => () => {},
}))

import { TurnStats } from "./turn-stats"
import { MessageScrollProvider } from "./message-scroll-context"
import { ModelLabelProvider } from "./model-label-context"
import type { ModelLabelResolver } from "@/hooks/use-model-labels"
import enMessages from "@/i18n/messages/en.json"

function renderStats(ui: ReactNode, modelLabel?: ModelLabelResolver) {
  const tree = (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageScrollProvider value={{ scrollToIndex: vi.fn() }}>
        {ui}
      </MessageScrollProvider>
    </NextIntlClientProvider>
  )
  return render(
    modelLabel ? (
      <ModelLabelProvider value={modelLabel}>{tree}</ModelLabelProvider>
    ) : (
      tree
    )
  )
}

const jumpLabel = enMessages.Folder.chat.messageList.jumpToPreviousUserMessage

describe("TurnStats jump-to-previous-user gating", () => {
  it("shows the jump button for a duration-only turn (no token usage)", () => {
    // Cursor never reports per-turn token usage; a turn that still carries a
    // duration is a substantial reply and must keep the jump affordance.
    renderStats(
      <TurnStats
        copyText="hello"
        duration_ms={42_000}
        previousUserIndex={3}
        usage={null}
      />
    )
    expect(screen.getByLabelText(jumpLabel)).toBeInTheDocument()
  })

  it("keeps the jump button hidden when neither usage nor duration exists", () => {
    renderStats(
      <TurnStats
        copyText="hello"
        duration_ms={null}
        previousUserIndex={3}
        usage={null}
      />
    )
    expect(screen.queryByLabelText(jumpLabel)).not.toBeInTheDocument()
  })
})

const forkLabel = enMessages.Folder.chat.messageList.forkFromHere

describe("TurnStats fork-from-here gating", () => {
  it("hides the fork button when the surface passes no handler", () => {
    // The affordance is the ONLY signal that forking is possible here, so it
    // must not render on a disconnected session, an agent without
    // `session/fork`, or a non-owning embed — all of which pass undefined.
    renderStats(<TurnStats copyText="hello" />)
    expect(screen.queryByLabelText(forkLabel)).not.toBeInTheDocument()
  })

  it("forks from this turn when clicked", async () => {
    const onForkFromHere = vi.fn()
    renderStats(<TurnStats copyText="hello" onForkFromHere={onForkFromHere} />)
    await userEvent.click(screen.getByLabelText(forkLabel))
    expect(onForkFromHere).toHaveBeenCalledTimes(1)
  })

  it("renders for a turn that has nothing else to show", () => {
    // The row early-returns when it would be empty; forkability alone has to
    // keep it open, or a turn with no usage/duration/copy text would silently
    // lose its fork point.
    renderStats(<TurnStats copyText="" onForkFromHere={vi.fn()} />)
    expect(screen.getByLabelText(forkLabel)).toBeInTheDocument()
  })

  it("keeps the button in place, disabled, while a turn is in flight", () => {
    // The regression this guards: the button used to be taken away for the
    // length of every reply, moving the whole icon row under the reader.
    renderStats(
      <TurnStats copyText="hello" onForkFromHere={vi.fn()} forkDisabled />
    )
    expect(screen.getByLabelText(forkLabel)).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("does not fork when the disabled button is clicked", async () => {
    // `aria-disabled` leaves the button clickable, so the handler has to be the
    // thing that's withheld.
    const onForkFromHere = vi.fn()
    renderStats(
      <TurnStats
        copyText="hello"
        onForkFromHere={onForkFromHere}
        forkDisabled
      />
    )
    await userEvent.click(screen.getByLabelText(forkLabel))
    expect(onForkFromHere).not.toHaveBeenCalled()
  })

  it("explains on hover why the disabled button is disabled", async () => {
    // Why `aria-disabled` and not the native `disabled`: a disabled element
    // gets no pointer events, so this tooltip — the only thing that says why
    // the button is dead — would never open.
    renderStats(
      <TurnStats copyText="hello" onForkFromHere={vi.fn()} forkDisabled />
    )
    await userEvent.hover(screen.getByLabelText(forkLabel))
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      enMessages.Folder.chat.messageList.forkBusy
    )
  })

  it("says so when the reply has no name to fork at yet", async () => {
    // The other reason the button greys out: a reply this session streamed is
    // named `live-…` until the post-turn reparse renames it, and the backend
    // silently tail-forks such an id. Saying "a turn is running" there would
    // be a lie about a session that is sitting idle.
    renderStats(
      <TurnStats
        copyText="hello"
        onForkFromHere={vi.fn()}
        forkDisabled
        forkDisabledReason="unnamed"
      />
    )
    await userEvent.hover(screen.getByLabelText(forkLabel))
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      enMessages.Folder.chat.messageList.forkNotReady
    )
  })
})

const modelLabel = enMessages.Folder.chat.messageList.model

describe("TurnStats model label", () => {
  // qoder's transcripts record the account-internal key (`qfmodel`) while its
  // own picker — and therefore the composer — says `Qwen3.8-Flash`. The two
  // surfaces used to disagree on screen.
  it("renders the agent's display name for an opaque model id", async () => {
    renderStats(<TurnStats copyText="hello" model="qfmodel" />, (id) =>
      id === "qfmodel" ? "Qwen3.8-Flash" : (id ?? null)
    )
    await userEvent.hover(screen.getByLabelText(modelLabel))
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Qwen3.8-Flash"
    )
  })

  it("maps every model of a reply that switched mid-turn", async () => {
    renderStats(
      <TurnStats
        copyText="hello"
        model="qfmodel"
        models={["qfmodel", "qmodel_38max"]}
      />,
      (id) =>
        id === "qfmodel"
          ? "Qwen3.8-Flash"
          : id === "qmodel_38max"
            ? "Qwen3.8-Max"
            : (id ?? null)
    )
    await userEvent.hover(screen.getByLabelText(modelLabel))
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Qwen3.8-Flash, Qwen3.8-Max"
    )
  })

  it("shows an unmapped id verbatim", async () => {
    // A worse label than the real name, but never a wrong one — and it is what
    // this row showed before the mapping existed.
    renderStats(<TurnStats copyText="hello" model="qfmodel" />, () => null)
    await userEvent.hover(screen.getByLabelText(modelLabel))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("qfmodel")
  })

  it("falls back to the raw id with no provider above it", async () => {
    // Read-only embeds (the sub-agent dialog) mount TurnStats outside the
    // thread's provider; they must still render a model rather than crash.
    renderStats(<TurnStats copyText="hello" model="claude-opus-5" />)
    await userEvent.hover(screen.getByLabelText(modelLabel))
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "claude-opus-5"
    )
  })
})

const tokenStatsLabel = enMessages.Folder.chat.messageList.tokenStats

describe("TurnStats zeroed counters", () => {
  const zeroUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  it("hides the token tooltip rather than claiming the reply cost nothing", () => {
    // Qoder redacts every counter to 0 for its own hosted models, so a reply
    // that plainly consumed context arrives all-zero. The old row showed a
    // lone "Input 0", which reads as a broken counter, not as missing data.
    renderStats(<TurnStats copyText="hello" usage={zeroUsage} />)
    expect(screen.queryByLabelText(tokenStatsLabel)).not.toBeInTheDocument()
  })

  it("keeps the jump affordance for a zero-counter reply", () => {
    // Suppressing the counters must not also suppress navigation: the reply is
    // substantial whether or not its usage survived the agent's redaction.
    renderStats(
      <TurnStats copyText="hello" usage={zeroUsage} previousUserIndex={3} />
    )
    expect(screen.getByLabelText(jumpLabel)).toBeInTheDocument()
  })

  it("shows the tooltip as soon as one counter is non-zero", () => {
    renderStats(
      <TurnStats
        copyText="hello"
        usage={{ ...zeroUsage, input_tokens: 2_803 }}
      />
    )
    expect(screen.getByLabelText(tokenStatsLabel)).toBeInTheDocument()
  })
})
