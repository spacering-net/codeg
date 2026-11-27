import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { forwardRef, useEffect, useImperativeHandle, useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { PersonalAgentInfo, PersonalAgentStatus } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentSend: vi.fn(),
  personalAgentCancel: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
}))

// The editor and the attachment plumbing are the conversation box's own,
// tested there: a plain text field stands in for the editor.
vi.mock("@/components/chat/composer/rich-composer", () => ({
  RichComposer: forwardRef(function Stub(
    props: {
      ariaLabel?: string
      placeholder?: string
      className?: string
      onChange?: (text: string) => void
      onSubmit?: () => void
      onReady?: () => void
      disabled?: boolean
    },
    ref
  ) {
    const [text, setText] = useState("")
    useImperativeHandle(ref, () => ({
      getText: () => text,
      isEmpty: () => text === "",
      setText: (next: string) => setText(next),
      clear: () => setText(""),
      focus: () => {},
      getEditor: () => null,
    }))
    const { onReady } = props
    useEffect(() => onReady?.(), [onReady])
    return (
      <textarea
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        data-class={props.className}
        disabled={props.disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          props.onChange?.(e.target.value)
        }}
      />
    )
  }),
}))
vi.mock("@/components/chat/composer/composer-add-menu", () => ({
  ComposerAddMenu: (props: { triggerClassName?: string }) => (
    <button type="button" className={props.triggerClassName}>
      add
    </button>
  ),
}))
vi.mock("@/components/chat/composer/use-composer-attachments", () => ({
  useComposerAttachments: () => ({
    attachments: [],
    imageAttachments: [],
    embeddedPayloadsRef: { current: new Map() },
    hasUploadingImage: false,
    imagePromptBlocks: () => [],
    clearAttachments: () => {},
    containerDragProps: {},
    isDragActive: false,
    showNativePaperclip: true,
    removeAttachment: () => {},
  }),
}))
vi.mock("@/components/chat/composer/use-reference-search", () => ({
  useReferenceSearch: () => ({}),
}))
vi.mock("@/components/chat/composer/use-composer-mention-labels", () => ({
  useComposerMentionLabels: () => ({ groupLabels: {}, uiLabels: {} }),
}))
vi.mock("@/components/chat/composer/use-composer-chrome-focus", () => ({
  useComposerChromeFocus: () => ({}),
}))
// The quote's bar reads the page's rows; what it shows is tested there.
vi.mock("./quote-bar", () => ({
  QuoteBar: ({ targetId }: { targetId: number }) => (
    <div data-quote={targetId} />
  ),
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({ shortcuts: {} }),
}))

import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { PersonalAgentComposer } from "./composer"

const agent = { id: 7, workdir: "/tmp/pa" } as PersonalAgentInfo

function status(turn: PersonalAgentStatus["turn"]): PersonalAgentStatus {
  return { engine: "here", turn } as PersonalAgentStatus
}

const RUNNING: PersonalAgentStatus["turn"] = {
  batch_id: 3,
  kind: "delivery",
  started_at: "2026-11-04T10:00:00Z",
  compaction_initiator: null,
} as PersonalAgentStatus["turn"]

function draw(
  turn: PersonalAgentStatus["turn"],
  onSent = vi.fn(),
  locale: "en" | "zh-CN" = "en"
) {
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? enMessages : zhMessages}
    >
      <PersonalAgentComposer
        agent={agent}
        agentName="Aide"
        status={status(turn)}
        quoting={null}
        onClearQuote={() => {}}
        onSent={onSent}
      />
    </NextIntlClientProvider>
  )
  return onSent
}

beforeEach(() => {
  api.personalAgentSend.mockReset()
  api.personalAgentSend.mockResolvedValue({ id: 9 })
  usePersonalAgentUi.setState({
    pendingAnswer: {},
    answerSending: {},
    composerSending: {},
  })
})

afterEach(cleanup)

describe("PersonalAgentComposer", () => {
  it("answers one of the assistant's questions, and keeps the words when it no longer can be", async () => {
    const onClearAnswer = vi.fn()
    usePersonalAgentUi.getState().setPendingAnswer({
      bot: 7,
      itemId: 12,
      summary: "Move the release to Friday?",
    })
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PersonalAgentComposer
          agent={agent}
          agentName="Aide"
          status={status(null)}
          quoting={null}
          answering={{ itemId: 12, summary: "Move the release to Friday?" }}
          onClearQuote={() => {}}
          onClearAnswer={onClearAnswer}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("Answer: Move the release to Friday?")).toBeTruthy()
    fireEvent.change(
      screen.getByRole("textbox", { name: "Message to your personal agent" }),
      { target: { value: "Yes" } }
    )
    // The question changed meanwhile: refused in the owner's words, the bar
    // gone, what was typed still there.
    api.personalAgentSend.mockRejectedValueOnce({
      code: "invalid_input",
      message: "the question changed meanwhile: the message was not sent",
      i18n_key: "matterErrors.answerChanged",
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    expect(api.personalAgentSend).toHaveBeenCalledWith(
      "Yes",
      [],
      null,
      null,
      null,
      12
    )
    expect(usePersonalAgentUi.getState().pendingAnswer[7]).toBeUndefined()
    expect(usePersonalAgentUi.getState().answerSending[7]).toBeUndefined()
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message to your personal agent",
        }) as HTMLTextAreaElement
      ).value
    ).toBe("Yes")
  })

  it("locks the box while it sends, and clears exactly what went", async () => {
    let done: (v: unknown) => void = () => {}
    api.personalAgentSend.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve
      })
    )
    const onQuoteSent = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PersonalAgentComposer
          agent={agent}
          agentName="Aide"
          status={status(null)}
          quoting={40}
          onClearQuote={() => {}}
          onQuoteSent={onQuoteSent}
        />
      </NextIntlClientProvider>
    )
    const box = screen.getByRole("textbox", {
      name: "Message to your personal agent",
    }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "on it" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    expect(box.disabled).toBe(true)
    expect(usePersonalAgentUi.getState().composerSending[7]).toBe(true)
    await act(async () => {
      done({ id: 9 })
    })
    expect(box.disabled).toBe(false)
    expect(box.value).toBe("")
    expect(onQuoteSent).toHaveBeenCalledWith(40)
    expect(usePersonalAgentUi.getState().composerSending[7]).toBeUndefined()
  })

  it("settles an answer that went even when the box is gone, and gives the bar back after a failure", async () => {
    usePersonalAgentUi
      .getState()
      .setPendingAnswer({ bot: 7, itemId: 12, summary: "Friday?" })
    let done: (v: unknown) => void = () => {}
    api.personalAgentSend.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve
      })
    )
    const drawAnswering = () =>
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <PersonalAgentComposer
            agent={agent}
            agentName="Aide"
            status={status(null)}
            quoting={null}
            answering={{ itemId: 12, summary: "Friday?" }}
            onClearQuote={() => {}}
          />
        </NextIntlClientProvider>
      )
    const { unmount } = drawAnswering()
    fireEvent.change(
      screen.getByRole("textbox", { name: "Message to your personal agent" }),
      { target: { value: "Yes" } }
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    expect(usePersonalAgentUi.getState().answerSending[7]?.itemId).toBe(12)
    // The owner switched assistants: the box is gone before the send lands.
    unmount()
    await act(async () => {
      done({ id: 9 })
    })
    expect(usePersonalAgentUi.getState().pendingAnswer[7]).toBeUndefined()
    expect(usePersonalAgentUi.getState().answerSending[7]).toBeUndefined()

    // A failure that may be tried again: the bar comes back if it went.
    api.personalAgentSend.mockRejectedValueOnce(new Error("offline"))
    drawAnswering()
    fireEvent.change(
      screen.getByRole("textbox", { name: "Message to your personal agent" }),
      { target: { value: "Yes" } }
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    expect(usePersonalAgentUi.getState().pendingAnswer[7]).toEqual({
      bot: 7,
      itemId: 12,
      summary: "Friday?",
    })
  })

  it("keeps the send button while the agent works, with nothing to stop there", () => {
    draw(RUNNING)
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull()
    expect(screen.getByRole("button", { name: "Queue" })).toBeDisabled()
  })

  it("sends while the agent works, and says the message went out", async () => {
    const onSent = draw(RUNNING)
    fireEvent.change(
      screen.getByRole("textbox", { name: "Message to your personal agent" }),
      { target: { value: "one more thing" } }
    )
    const send = screen.getByRole("button", { name: "Queue" })
    expect(send).toBeEnabled()
    await act(async () => {
      fireEvent.click(send)
    })
    expect(api.personalAgentSend).toHaveBeenCalledWith(
      "one more thing",
      [],
      null,
      null,
      null,
      null
    )
    expect(onSent).toHaveBeenCalledTimes(1)
  })

  it("sets the agent's name apart from the Chinese around it", () => {
    draw(null, vi.fn(), "zh-CN")
    expect(screen.getByPlaceholderText("给 Aide 发消息…")).toBeTruthy()
    cleanup()
    draw(RUNNING, vi.fn(), "zh-CN")
    expect(
      screen.getByPlaceholderText("Aide 正在处理，你的消息会排在后面")
    ).toBeTruthy()
  })

  it("sets its buttons 0.5rem in from the border, and the text as far from the plus", () => {
    draw(null)
    const plus = screen.getByRole("button", { name: "add" })
    const send = screen.getByRole("button", { name: "Send" })
    // 1.875rem buttons, the same 0.5rem all round them.
    expect(plus.className).toContain("size-7.5")
    expect(send.className).toContain("size-7.5")
    const grid = plus.closest(".grid")!
    expect(grid.className).toContain("p-2")
    // No gap between the columns: on one line, the editor's own 0.5rem
    // start padding is the room after the plus; its 0.5rem over and under
    // (half a pixel more under: the text centred to the eye) make its
    // 1.375rem line as tall as the buttons.
    expect(grid.className).not.toMatch(/(^| )gap-x-/)
    const editor = screen.getByRole("textbox", {
      name: "Message to your personal agent",
    })
    expect(editor.dataset.class).toContain("[&_.codeg-composer-scroll]:ps-2")
    expect(editor.dataset.class).toContain(
      "[&_.codeg-composer-scroll]:pt-[0.21875rem]"
    )
    expect(editor.dataset.class).toContain(
      "[&_.codeg-composer-scroll]:pb-[0.28125rem]"
    )
  })

  /** The page's box, one per assistant (keyed by them), as the page
   *  draws it. */
  function Page({
    id,
    draft = null,
    onClearQuote,
    onSent,
  }: {
    id: number
    draft?: { text: string; n: number } | null
    onClearQuote: () => void
    onSent: () => void
  }) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PersonalAgentComposer
          key={id}
          agent={{ ...agent, id } as PersonalAgentInfo}
          agentName="Aide"
          status={status(null)}
          quoting={null}
          draft={draft}
          onClearQuote={onClearQuote}
          onSent={onSent}
        />
      </NextIntlClientProvider>
    )
  }
  const box = () =>
    screen.getByRole("textbox", {
      name: "Message to your personal agent",
    }) as HTMLTextAreaElement

  it("leaves the next assistant's box alone when a send to the last one lands after the switch", async () => {
    let land: (row: unknown) => void = () => {}
    api.personalAgentSend.mockReturnValue(
      new Promise((resolve) => {
        land = resolve
      })
    )
    const onClearQuote = vi.fn()
    const onSent = vi.fn()
    const { rerender } = render(
      <Page id={1} onClearQuote={onClearQuote} onSent={onSent} />
    )
    fireEvent.change(box(), { target: { value: "for the first" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    // Switched while it is out: a box of the second's own, written in.
    rerender(<Page id={2} onClearQuote={onClearQuote} onSent={onSent} />)
    expect(box().value).toBe("")
    fireEvent.change(box(), { target: { value: "for the second" } })
    await act(async () => {
      land({ id: 9 })
    })
    expect(box().value).toBe("for the second")
    // Nor the page's quote and scroll, now the second's.
    expect(onClearQuote).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled()
  })

  it("puts a card's message in the box after switching assistants too", () => {
    const props = { onClearQuote: vi.fn(), onSent: vi.fn() }
    const { rerender } = render(<Page id={1} draft={null} {...props} />)
    rerender(<Page id={1} draft={{ text: "first card", n: 1 }} {...props} />)
    expect(box().value).toBe("first card")
    // The page starts its count again for the next assistant.
    rerender(<Page id={2} draft={null} {...props} />)
    expect(box().value).toBe("")
    rerender(<Page id={2} draft={{ text: "second card", n: 1 }} {...props} />)
    expect(box().value).toBe("second card")
  })

  it("does not say a message went out when sending failed", async () => {
    api.personalAgentSend.mockRejectedValue(new Error("nope"))
    const onSent = draw(null)
    fireEvent.change(
      screen.getByRole("textbox", { name: "Message to your personal agent" }),
      { target: { value: "hello" } }
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    expect(onSent).not.toHaveBeenCalled()
  })
})
