import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
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
    // Read at once, as the editor's own state is: the box reads it back
    // inside the change it is told of.
    const [text, setTextState] = useState("")
    const current = useRef("")
    const { onChange } = props
    useImperativeHandle(ref, () => {
      // As the editor does, an edit through the handle is told of too.
      const setText = (next: string) => {
        current.current = next
        setTextState(next)
        onChange?.(next)
      }
      return {
        getText: () => current.current,
        isEmpty: () => current.current === "",
        setText,
        setDoc: (doc: { content?: { content?: { text?: string }[] }[] }) =>
          setText(
            (doc.content ?? [])
              .map((p) => (p.content ?? []).map((n) => n.text ?? "").join(""))
              .join("\n")
          ),
        getJSON: () => ({
          type: "doc",
          content: current.current.split("\n").map((line) => ({
            type: "paragraph",
            content: line ? [{ type: "text", text: line }] : [],
          })),
        }),
        clear: () => setText(""),
        focus: () => {},
        getEditor: () => null,
      }
    }, [onChange])
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
          current.current = e.target.value
          setTextState(e.target.value)
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

import {
  buildPersonalAgentDraftStorageKey,
  clearMessageInputDraftV2,
  loadMessageInputDraftV2,
  saveMessageInputDraftV2,
} from "@/lib/message-input-draft"
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

const draftKey = (id: number) =>
  buildPersonalAgentDraftStorageKey({ id, uid: null })
const storedText = (id: number) => {
  const loaded = loadMessageInputDraftV2(draftKey(id))
  if (loaded?.kind !== "doc") return null
  return (loaded.doc.content ?? [])
    .map((p) => (p.content ?? []).map((n) => n.text ?? "").join(""))
    .join("\n")
}

beforeEach(() => {
  for (const id of [1, 2, 7]) clearMessageInputDraftV2(draftKey(id))
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
    // What went is no longer the first's draft; the second keeps its own.
    expect(storedText(1)).toBeNull()
    rerender(<Page id={1} onClearQuote={onClearQuote} onSent={onSent} />)
    expect(storedText(2)).toBe("for the second")
    expect(box().value).toBe("")
  })

  it("holds a send still out in a box opened again for the assistant, and lets it go once it went", async () => {
    const lands: ((v: unknown) => void)[] = []
    const fails: ((e: unknown) => void)[] = []
    api.personalAgentSend.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          lands.push(resolve)
          fails.push(reject)
        })
    )
    const props = { onClearQuote: vi.fn(), onSent: vi.fn() }
    const { rerender } = render(<Page id={1} {...props} />)
    fireEvent.change(box(), { target: { value: "going out" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    // Away and back while it is out: the text shows, locked as it was.
    rerender(<Page id={2} {...props} />)
    rerender(<Page id={1} {...props} />)
    await waitFor(() => expect(box().value).toBe("going out"))
    expect(box().disabled).toBe(true)
    expect(usePersonalAgentUi.getState().composerSending[1]).toBe(true)
    await act(async () => {
      lands[0]({ id: 9 })
    })
    // It went: gone from the box and from the draft, for good.
    expect(box().value).toBe("")
    expect(box().disabled).toBe(false)
    expect(storedText(1)).toBeNull()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350))
    })
    expect(storedText(1)).toBeNull()

    // One that fails stays, to be tried again.
    fireEvent.change(box(), { target: { value: "again" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    rerender(<Page id={2} {...props} />)
    rerender(<Page id={1} {...props} />)
    await waitFor(() => expect(box().value).toBe("again"))
    await act(async () => {
      fails[1](new Error("offline"))
    })
    expect(box().value).toBe("again")
    expect(box().disabled).toBe(false)
    expect(storedText(1)).toBe("again")
  })

  it("keeps what is typed as the assistant's own draft, and puts it back when the box opens again", async () => {
    const props = { onClearQuote: vi.fn(), onSent: vi.fn() }
    const { rerender } = render(<Page id={1} {...props} />)
    fireEvent.change(box(), { target: { value: "half a\nthought" } })
    // Switched before the save was due: saved as the box goes.
    rerender(<Page id={2} {...props} />)
    expect(box().value).toBe("")
    expect(storedText(1)).toBe("half a\nthought")
    rerender(<Page id={1} {...props} />)
    await waitFor(() => expect(box().value).toBe("half a\nthought"))
    // Restored, it can be sent as typed.
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
    // Emptied, the draft goes too.
    fireEvent.change(box(), { target: { value: "" } })
    rerender(<Page id={2} {...props} />)
    expect(storedText(1)).toBeNull()
  })

  it("keeps what was just typed when the page's layout changes", async () => {
    const props = { onClearQuote: vi.fn(), onSent: vi.fn() }
    // The same assistant's box, drawn in another place of the page: the old
    // one goes and the new one comes in the same commit.
    const { rerender } = render(
      <div>
        <Page id={1} {...props} />
      </div>
    )
    fireEvent.change(box(), { target: { value: "just typed" } })
    rerender(
      <section>
        <Page id={1} {...props} />
      </section>
    )
    await waitFor(() => expect(box().value).toBe("just typed"))
    expect(storedText(1)).toBe("just typed")
  })

  it("drops the draft once it is sent, and keeps it when sending failed", async () => {
    const props = { onClearQuote: vi.fn(), onSent: vi.fn() }
    api.personalAgentSend.mockRejectedValueOnce(new Error("offline"))
    const { rerender } = render(<Page id={1} {...props} />)
    fireEvent.change(box(), { target: { value: "hello" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    expect(storedText(1)).toBe("hello")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    expect(box().value).toBe("")
    expect(storedText(1)).toBeNull()
    rerender(<Page id={2} {...props} />)
    rerender(<Page id={1} {...props} />)
    expect(box().value).toBe("")
  })

  it("puts a card's message after the draft the box opened with", async () => {
    saveMessageInputDraftV2(draftKey(1), {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "mine" }] },
      ],
    })
    const props = { onClearQuote: vi.fn(), onSent: vi.fn() }
    const { rerender } = render(<Page id={1} draft={null} {...props} />)
    await waitFor(() => expect(box().value).toBe("mine"))
    rerender(<Page id={1} draft={{ text: "card", n: 1 }} {...props} />)
    expect(box().value).toBe("mine\n\ncard")
    rerender(<Page id={2} {...props} />)
    expect(storedText(1)).toBe("mine\n\ncard")
  })

  it("puts a card's message in the box after switching assistants too", async () => {
    const props = { onClearQuote: vi.fn(), onSent: vi.fn() }
    const { rerender } = render(<Page id={1} draft={null} {...props} />)
    rerender(<Page id={1} draft={{ text: "first card", n: 1 }} {...props} />)
    // In once the saved draft (none here) is back.
    await waitFor(() => expect(box().value).toBe("first card"))
    // The page starts its count again for the next assistant.
    rerender(<Page id={2} draft={null} {...props} />)
    expect(box().value).toBe("")
    rerender(<Page id={2} draft={{ text: "second card", n: 1 }} {...props} />)
    await waitFor(() => expect(box().value).toBe("second card"))
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
