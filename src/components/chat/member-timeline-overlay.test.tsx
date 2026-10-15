import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { MemberTimelineOverlay } from "./member-timeline-overlay"
import enMessages from "@/i18n/messages/en.json"
import {
  useMemberTimelineStore,
  type MemberChunkEvent,
} from "@/stores/member-timeline-store"

// Streamdown (the real Markdown renderer) and the reasoning collapsible are
// heavy import chains; the overlay only wires them up, so stub both to
// sentinels that expose exactly what the panel passes down.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-testid="message-response">{children}</div>
  ),
}))

vi.mock("@/components/ai-elements/reasoning", () => ({
  Reasoning: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ReasoningTrigger: () => <div data-testid="reasoning-trigger">thinking</div>,
  ReasoningContent: ({ children }: { children: string }) => (
    <div data-testid="reasoning-content">{children}</div>
  ),
}))

function chunk(overrides: Partial<MemberChunkEvent>): MemberChunkEvent {
  return {
    type: "member_chunk",
    member: "impl-x",
    kind: "message",
    ...overrides,
  }
}

function apply(contextKey: string, ...chunks: MemberChunkEvent[]) {
  for (const c of chunks) {
    act(() => {
      useMemberTimelineStore.getState().applyMemberChunk(contextKey, c)
    })
  }
}

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  useMemberTimelineStore.getState().clearAll()
})

describe("MemberTimelineOverlay", () => {
  it("renders nothing without a contextKey or before any member chunk", () => {
    const { container } = renderWithIntl(
      <MemberTimelineOverlay contextKey="tab-1" />
    )
    expect(container.firstChild).toBeNull()

    const bare = renderWithIntl(<MemberTimelineOverlay />)
    expect(bare.container.firstChild).toBeNull()
  })

  it("collapses to a chip summarizing the member count, then expands to the members", () => {
    apply(
      "tab-1",
      chunk({ member: "impl-x", kind: "message", text: "正在处理任务分配" }),
      chunk({
        member: "impl-y",
        kind: "tool_call",
        tool_call_id: "c1",
        title: "Read file",
        status: "completed",
      })
    )
    renderWithIntl(<MemberTimelineOverlay contextKey="tab-1" />)

    // Chip first — content hidden.
    expect(screen.getByText("Team members 2")).toBeInTheDocument()
    expect(screen.queryByText("正在处理任务分配")).not.toBeInTheDocument()

    fireEvent.click(screen.getByText("Team members 2").closest("button")!)
    expect(screen.getByText("Team members")).toBeInTheDocument()
    expect(screen.getByText("impl-x")).toBeInTheDocument()
    expect(screen.getByText("impl-y")).toBeInTheDocument()
    // Member sections open by default: prose through the main-thread presenter,
    // the tool frame as a weak line with its localized status.
    expect(screen.getByText("正在处理任务分配")).toBeInTheDocument()
    expect(screen.getByText("Read file")).toBeInTheDocument()
    expect(screen.getByText("Completed")).toBeInTheDocument()
  })

  it("renders thoughts through the reasoning presenter and user echoes distinctly", () => {
    apply(
      "tab-1",
      chunk({
        kind: "user_echo",
        text: "请写两句进度说明",
        history_item_id: "u1",
      }),
      chunk({
        kind: "thought",
        text: "The lead asks me",
        history_item_id: "h1",
      })
    )
    renderWithIntl(<MemberTimelineOverlay contextKey="tab-1" />)
    fireEvent.click(screen.getByText("Team members 1").closest("button")!)

    expect(screen.getByText("Message received")).toBeInTheDocument()
    expect(screen.getByText("请写两句进度说明")).toBeInTheDocument()
    expect(screen.getByTestId("reasoning-content").textContent).toBe(
      "The lead asks me"
    )
  })

  it("re-renders live as chunks arrive after mount", () => {
    renderWithIntl(<MemberTimelineOverlay contextKey="tab-1" />)
    expect(screen.queryByText("Team members 1")).not.toBeInTheDocument()

    apply("tab-1", chunk({ kind: "message", text: "第一句" }))
    expect(screen.getByText("Team members 1")).toBeInTheDocument()

    fireEvent.click(screen.getByText("Team members 1").closest("button")!)
    expect(screen.getByText("第一句")).toBeInTheDocument()

    apply("tab-1", chunk({ kind: "message", text: "，第二句" }))
    expect(screen.getByText("第一句，第二句")).toBeInTheDocument()
  })

  it("keeps one connection's members out of another's panel", () => {
    apply("tab-2", chunk({ kind: "message", text: "other tab" }))
    const { container } = renderWithIntl(
      <MemberTimelineOverlay contextKey="tab-1" />
    )
    expect(container.firstChild).toBeNull()
  })
})
