import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { messageFingerprint } from "@/lib/message-check"
import type { MessageCheck, PersonalAgentChange } from "@/lib/types"

const api = vi.hoisted(() => ({
  checks: vi.fn(),
  checkMessage: vi.fn(),
  listChecks: vi.fn(),
}))
vi.mock("@/lib/api", () => ({
  personalAgentChecks: (id: number) => api.checks(id),
  personalAgentCheckMessage: (args: unknown) => api.checkMessage(args),
  listAskConversations: () => Promise.resolve([]),
  listCheckConversations: (id: number) => api.listChecks(id),
}))

const bus = vi.hoisted(() => ({
  handlers: [] as Array<(p: PersonalAgentChange) => void>,
}))
vi.mock("@/lib/platform", () => ({
  subscribe: (_event: string, handler: (p: PersonalAgentChange) => void) => {
    bus.handlers.push(handler)
    return Promise.resolve(() => {})
  },
  onTransportReconnect: () => null,
}))

const roster = vi.hoisted(() => ({ entries: null as unknown }))
vi.mock("@/stores/personal-agent-roster-store", () => ({
  useRoster: () => roster.entries,
}))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast: toasts }))

const follow = vi.hoisted(() => vi.fn())
vi.mock("@/lib/personal-agent-notify", () => ({
  followPersonalAgentLink: (link: unknown) => follow(link),
}))

import { useAskConversationDrawerStore } from "@/stores/ask-conversation-drawer-store"
import {
  CheckMarks,
  MessageChecksProvider,
  useMessageChecks,
} from "./message-checks"

const REPLY = "It builds. The tests pass."

function check(over: Partial<MessageCheck>): MessageCheck {
  return {
    id: 1,
    bot_id: 7,
    conversation_id: 42,
    message_fp: messageFingerprint(REPLY),
    quote_fp: "",
    quote: null,
    state: "done",
    verdict: "false",
    evidence: "- src/build.rs:3 still fails",
    note: null,
    dispatch_id: 9,
    check_conversation_id: 77,
    notice_id: 5,
    row_id: 11,
    created_at: "2026-11-15T08:00:00Z",
    updated_at: "2026-11-15T08:05:00Z",
    ...over,
  }
}

function Probe({ text, quote }: { text: string; quote?: string }) {
  const ctx = useMessageChecks()
  if (!ctx) return <p>not offered</p>
  return (
    <>
      <button
        type="button"
        onClick={() =>
          ctx.check({
            message: text,
            asked: "Does it build?",
            quote: quote ?? null,
          })
        }
      >
        ask
      </button>
      <CheckMarks text={text} askedOf={() => "Does it build?"} />
    </>
  )
}

function renderIn(
  ui: React.ReactNode,
  conversationId = 42,
  openInDrawer = false
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageChecksProvider
        conversationId={conversationId}
        openInDrawer={openInDrawer}
      >
        {ui}
      </MessageChecksProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  api.checks.mockReset()
  api.checkMessage.mockReset()
  toasts.success.mockReset()
  toasts.error.mockReset()
  follow.mockReset()
  api.listChecks.mockReset()
  api.listChecks.mockResolvedValue([])
  useAskConversationDrawerStore.setState({ target: null })
  bus.handlers = []
  roster.entries = [{ id: 7, kind: "primary" }]
})

describe("MessageChecks (10.3)", () => {
  it("offers nothing without a primary assistant, or for a draft", () => {
    roster.entries = [{ id: 8, kind: "worker" }]
    renderIn(<Probe text={REPLY} />)
    expect(screen.getByText("not offered")).toBeTruthy()
    roster.entries = [{ id: 7, kind: "primary" }]
    renderIn(<Probe text={REPLY} />, 0)
    expect(screen.getAllByText("not offered")).toHaveLength(2)
    expect(api.checks).not.toHaveBeenCalled()
  })

  it("marks a checked message and its sentences, each opening what was found", async () => {
    api.checks.mockResolvedValue([
      check({}),
      check({
        id: 2,
        quote: "The tests pass.",
        quote_fp: messageFingerprint("The tests pass."),
        verdict: "partly",
        evidence: "- 2 of 40 fail",
        row_id: 12,
      }),
    ])
    renderIn(<Probe text={` ${REPLY}\r\n`} />)
    const whole = await screen.findByText("Check: Not true")
    expect(screen.getByText("“The tests pass.”: Partly true")).toBeTruthy()
    expect(api.checks).toHaveBeenCalledWith(42)
    act(() => {
      fireEvent.click(whole)
    })
    expect(await screen.findByText("- src/build.rs:3 still fails")).toBeTruthy()
    // Nobody's name: the assistant checks it, on what its work runs on.
    expect(screen.queryByText(/Checked by/)).toBeNull()
    // In the assistant's conversation: its card.
    act(() => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "View in the assistant's conversation",
        })
      )
    })
    expect(follow).toHaveBeenCalledWith({ kind: "bot", bot_id: 7, row_id: 11 })
  })

  it("shows how it was checked in a tab where there is no drawer beside it", async () => {
    api.checks.mockResolvedValue([check({})])
    renderIn(<Probe text={REPLY} />)
    const mark = await screen.findByText("Check: Not true")
    act(() => {
      fireEvent.click(mark)
    })
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "See the check" }))
    })
    expect(follow).toHaveBeenCalledWith({
      kind: "conversation",
      conversation_id: 77,
      folder_id: null,
    })
    expect(api.listChecks).not.toHaveBeenCalled()
  })

  it("shows how it was checked in the drawer beside the conversation", async () => {
    api.checks.mockResolvedValue([check({})])
    api.listChecks.mockResolvedValue([
      {
        id: 77,
        folder_id: 3,
        agent_type: "codex",
        kind: "check",
        parent_id: 42,
      },
    ])
    renderIn(<Probe text={REPLY} />, 42, true)
    await waitFor(() => expect(api.listChecks).toHaveBeenCalledWith(42))
    act(() => {
      fireEvent.click(screen.getByText("Check: Not true"))
    })
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "See the check" }))
    })
    await waitFor(() =>
      expect(useAskConversationDrawerStore.getState().target).toMatchObject({
        kind: "check",
        parentConversationId: 42,
        conversationId: 77,
        agentType: "codex",
        folderId: 3,
      })
    )
    expect(follow).not.toHaveBeenCalled()
  })

  it("asks again for a message checked before: its last conclusion opens, nothing is sent", async () => {
    api.checks.mockResolvedValue([check({})])
    renderIn(<Probe text={REPLY} />)
    await screen.findByText("Check: Not true")
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "ask" }))
    })
    expect(await screen.findByText("- src/build.rs:3 still fails")).toBeTruthy()
    expect(api.checkMessage).not.toHaveBeenCalled()
    // [Check again]: a new one, with what it answered — the latest of the
    // message from now on.
    const anew = check({
      id: 3,
      state: "checking",
      verdict: null,
      evidence: null,
    })
    api.checkMessage.mockResolvedValue(anew)
    api.checks.mockResolvedValue([anew])
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Check again" }))
    })
    await waitFor(() => expect(api.checkMessage).toHaveBeenCalledTimes(1))
    expect(api.checkMessage).toHaveBeenCalledWith({
      conversationId: 42,
      message: REPLY,
      asked: "Does it build?",
      quote: null,
      again: true,
    })
    expect(await screen.findByText("Check: Checking…")).toBeTruthy()
  })

  it("hands a new one out, says it is being checked, and follows its end", async () => {
    api.checks.mockResolvedValue([])
    renderIn(<Probe text={REPLY} quote="The tests pass." />)
    await waitFor(() => expect(api.checks).toHaveBeenCalled())
    const made = check({
      id: 4,
      state: "checking",
      verdict: null,
      evidence: null,
      quote: "The tests pass.",
      quote_fp: messageFingerprint("The tests pass."),
    })
    api.checkMessage.mockResolvedValue(made)
    api.checks.mockResolvedValue([made])
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "ask" }))
    })
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(
        "Checking it; the result shows under the message."
      )
    )
    expect(api.checkMessage.mock.calls[0][0]).toMatchObject({
      quote: "The tests pass.",
      again: false,
    })
    expect(await screen.findByText("“The tests pass.”: Checking…")).toBeTruthy()
    // Its end is pushed: read again.
    api.checks.mockResolvedValue([
      check({
        id: 4,
        quote: "The tests pass.",
        quote_fp: messageFingerprint("The tests pass."),
        verdict: "true",
      }),
    ])
    act(() => {
      for (const h of bus.handlers) h({ kind: "check", conversation_id: 99 })
    })
    act(() => {
      for (const h of bus.handlers) h({ kind: "check", conversation_id: 42 })
    })
    expect(await screen.findByText("“The tests pass.”: True")).toBeTruthy()
    // On opening, after the check was handed out, and on its push — not on
    // another conversation's.
    expect(api.checks).toHaveBeenCalledTimes(3)
  })

  it("says why a check could not start", async () => {
    api.checks.mockResolvedValue([])
    api.checkMessage.mockRejectedValue(
      new Error("no executor config can check it")
    )
    renderIn(<Probe text={REPLY} />)
    await waitFor(() => expect(api.checks).toHaveBeenCalled())
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "ask" }))
    })
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(
        "The check could not start: no executor config can check it"
      )
    )
  })

  it("says why one is unsure or did not finish", async () => {
    api.checks.mockResolvedValue([
      check({ verdict: "unsure", evidence: null, note: "no_evidence" }),
    ])
    renderIn(<Probe text={REPLY} />)
    await screen.findByText("Check: Can't tell")
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "ask" }))
    })
    expect(
      await screen.findByText(
        "The check gave a verdict but no evidence, so it counts as can't tell."
      )
    ).toBeTruthy()
    expect(screen.getByText("No evidence given.")).toBeTruthy()
  })

  it("keeps the newest read: an older answer coming late puts nothing back", async () => {
    let first!: (v: MessageCheck[]) => void
    api.checks.mockImplementationOnce(
      () =>
        new Promise<MessageCheck[]>((resolve) => {
          first = resolve
        })
    )
    api.checks.mockResolvedValueOnce([check({})])
    renderIn(<Probe text={REPLY} />)
    await waitFor(() => expect(api.checks).toHaveBeenCalledTimes(1))
    act(() => {
      for (const h of bus.handlers) h({ kind: "check", conversation_id: 42 })
    })
    expect(await screen.findByText("Check: Not true")).toBeTruthy()
    await act(async () => {
      first([])
    })
    expect(screen.getByText("Check: Not true")).toBeTruthy()
  })

  it("a check asked for is not undone by a read that was on its way", async () => {
    let late!: (v: MessageCheck[]) => void
    api.checks.mockResolvedValueOnce([])
    api.checks.mockImplementationOnce(
      () =>
        new Promise<MessageCheck[]>((resolve) => {
          late = resolve
        })
    )
    renderIn(<Probe text={REPLY} />)
    await waitFor(() => expect(api.checks).toHaveBeenCalledTimes(1))
    act(() => {
      for (const h of bus.handlers) h({ kind: "check", conversation_id: 42 })
    })
    await waitFor(() => expect(api.checks).toHaveBeenCalledTimes(2))
    api.checkMessage.mockResolvedValue(
      check({ id: 4, state: "checking", verdict: null, evidence: null })
    )
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "ask" }))
    })
    expect(await screen.findByText("Check: Checking…")).toBeTruthy()
    await act(async () => {
      late([])
    })
    expect(screen.getByText("Check: Checking…")).toBeTruthy()
  })

  it("an answer for the conversation shown before is not this one's", async () => {
    const OTHER = "The cache is warm."
    let old!: (v: MessageCheck[]) => void
    api.checks.mockImplementation((id: number) =>
      id === 42
        ? new Promise<MessageCheck[]>((resolve) => {
            old = resolve
          })
        : Promise.resolve([
            check({
              id: 9,
              conversation_id: 43,
              message_fp: messageFingerprint(OTHER),
              verdict: "true",
            }),
          ])
    )
    const tree = (id: number) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageChecksProvider conversationId={id}>
          <Probe text={OTHER} />
        </MessageChecksProvider>
      </NextIntlClientProvider>
    )
    const { rerender } = render(tree(42))
    await waitFor(() => expect(api.checks).toHaveBeenCalledWith(42))
    rerender(tree(43))
    expect(await screen.findByText("Check: True")).toBeTruthy()
    await act(async () => {
      old([
        check({
          id: 1,
          conversation_id: 42,
          message_fp: messageFingerprint(OTHER),
          verdict: "false",
        }),
      ])
    })
    expect(screen.getByText("Check: True")).toBeTruthy()
    expect(screen.queryByText("Check: Not true")).toBeNull()
  })

  it("a check answered from its last time brings the rest back too", async () => {
    let initial!: (v: MessageCheck[]) => void
    const whole = check({})
    const sentence = check({
      id: 2,
      quote: "The tests pass.",
      quote_fp: messageFingerprint("The tests pass."),
      verdict: "partly",
    })
    api.checks.mockImplementationOnce(
      () =>
        new Promise<MessageCheck[]>((resolve) => {
          initial = resolve
        })
    )
    api.checks.mockResolvedValue([whole, sentence])
    // Asked before the page had read its checks: the last conclusion comes
    // back, nothing is pushed.
    api.checkMessage.mockResolvedValue(whole)
    renderIn(<Probe text={REPLY} />)
    await waitFor(() => expect(api.checks).toHaveBeenCalledTimes(1))
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "ask" }))
    })
    expect(
      await screen.findByText("“The tests pass.”: Partly true")
    ).toBeTruthy()
    expect(screen.getByText("Check: Not true")).toBeTruthy()
    // The first read, older, comes last: nothing goes.
    await act(async () => {
      initial([])
    })
    expect(screen.getByText("“The tests pass.”: Partly true")).toBeTruthy()
    expect(screen.getByText("Check: Not true")).toBeTruthy()
  })
})
