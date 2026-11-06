import { useState } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { EMPTY_TOOL_APPROVALS } from "@/lib/activity/approval"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { ActivityLiveProvider } from "./activity/activity-live-context"
import { CompletedTurnContent } from "./completed-turn-content"

const KEY = "settings:chat-process-collapse:v1"
function setMode(mode: string) {
  localStorage.setItem(KEY, mode)
  window.dispatchEvent(new Event("codeg:chat-process-collapse-changed"))
}

function Turn({
  completed,
  failed = false,
  waiting = false,
}: {
  completed: boolean
  failed?: boolean
  waiting?: boolean
}) {
  const [open, setOpen] = useState(true)
  const [parts] = useState<AdaptedContentPart[]>([
    { type: "text", text: "Inspecting source files" },
    {
      type: "tool-call",
      toolCallId: "collapse-test",
      toolName: "Read",
      input: '{"file_path":"src/app.tsx"}',
      state: failed ? "output-error" : "output-available",
      output: "source",
    },
    { type: "text", text: "Final answer stays visible" },
  ])
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ActivityLiveProvider
        value={{
          awaitingUser: waiting,
          awaitingToolCallId: waiting ? "collapse-test" : null,
          approvals: EMPTY_TOOL_APPROVALS,
        }}
      >
        <CompletedTurnContent
          parts={parts}
          completed={completed}
          currentRound
          roundOpen={open}
          onRoundOpenChange={setOpen}
        />
      </ActivityLiveProvider>
    </NextIntlClientProvider>
  )
}

const toggle = () =>
  screen.getByRole("button", { name: /^(Working|Activity)$/ })

afterEach(() => {
  localStorage.removeItem(KEY)
  window.dispatchEvent(new Event("codeg:chat-process-collapse-changed"))
})

describe("聊天过程折叠策略", () => {
  it("默认保留当前轮次的展开行为", () => {
    render(<Turn completed />)
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
  })

  it("执行结束后折叠，并保留最终回答", () => {
    setMode("after-completion")
    const view = render(<Turn completed={false} />)
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    view.rerender(<Turn completed />)
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText("Final answer stays visible")).toBeVisible()
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    view.rerender(<Turn completed />)
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
  })

  it("始终折叠模式在执行中也默认收起，仍可手动展开", () => {
    setMode("always")
    render(<Turn completed={false} />)
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
  })

  it("已有会话立即响应设置切换", () => {
    render(<Turn completed />)
    act(() => setMode("always"))
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    act(() => setMode("current"))
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
  })

  it("响应其他窗口的设置变更", () => {
    render(<Turn completed />)
    act(() => {
      localStorage.setItem(KEY, "always")
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }))
    })
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
  })

  it("始终折叠时仍显示错误", () => {
    setMode("always")
    render(<Turn completed failed />)
    expect(screen.getByText("Inspecting source files")).toBeVisible()
  })

  it("始终折叠时仍显示待用户确认的过程", () => {
    setMode("always")
    render(<Turn completed={false} waiting />)
    expect(screen.getByText("Inspecting source files")).toBeVisible()
  })

  it("已有历史会话可展开，虚拟列表重新挂载后保留选择", () => {
    setMode("always")
    const parts: AdaptedContentPart[] = [
      { type: "reasoning", content: "Checking history", isStreaming: false },
      { type: "text", text: "Historical answer" },
    ]
    const ui = (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent parts={parts} completed />
      </NextIntlClientProvider>
    )
    const view = render(ui)
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(toggle())
    view.unmount()
    render(ui)
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Historical answer")).toBeVisible()
  })

  it("不会折叠唯一的工具结果或丢失最终输出", () => {
    setMode("always")
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={[
            { type: "text", text: "Important tool result" },
            {
              type: "tool-call",
              toolCallId: "no-final-answer",
              toolName: "Read",
              input: "{}",
              state: "output-available",
              output: "source",
            },
          ]}
          completed
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("Important tool result")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull()
  })
})
