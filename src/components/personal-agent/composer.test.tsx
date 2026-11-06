import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { forwardRef, useImperativeHandle, useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { PersonalAgentInfo, PersonalAgentStatus } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentSend: vi.fn(),
  personalAgentCancel: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

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
    },
    ref
  ) {
    const [text, setText] = useState("")
    useImperativeHandle(ref, () => ({
      getText: () => text,
      clear: () => setText(""),
      focus: () => {},
      getEditor: () => null,
    }))
    return (
      <textarea
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        data-class={props.className}
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
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({ shortcuts: {} }),
}))

import { PersonalAgentComposer } from "./composer"

const agent = { workdir: "/tmp/pa" } as PersonalAgentInfo

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
})

afterEach(cleanup)

describe("PersonalAgentComposer", () => {
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
    // start padding is the room after the plus; its 0.25rem above and
    // below make its 1.375rem line as tall as the buttons.
    expect(grid.className).not.toMatch(/(^| )gap-x-/)
    const editor = screen.getByRole("textbox", {
      name: "Message to your personal agent",
    })
    expect(editor.dataset.class).toContain("[&_.codeg-composer-scroll]:ps-2")
    expect(editor.dataset.class).toContain("[&_.codeg-composer-scroll]:py-1")
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
