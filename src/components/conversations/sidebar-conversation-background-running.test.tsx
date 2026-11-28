import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DbConversationSummary } from "@/lib/types"
import { SidebarConversationCard } from "./sidebar-conversation-card"

// 这个文件只验证“回合结束后后台任务还在跑”时的行状态：后端连接清单的
// 取数规则在 use-background-conversation-running.test.ts 覆盖。
const backendRunning = vi.hoisted(() => ({ value: false }))
vi.mock("@/hooks/use-background-conversation-running", () => ({
  useBackgroundConversationRunning: () => backendRunning.value,
}))

afterEach(() => {
  backendRunning.value = false
})

function conv(status: DbConversationSummary["status"]): DbConversationSummary {
  return {
    id: 1,
    folder_id: 1,
    title: "conv-1",
    title_locked: false,
    agent_type: "claude_code",
    status,
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-11-27T00:00:00.000Z",
    updated_at: "2026-11-27T00:00:00.000Z",
    pinned_at: null,
  }
}

function renderCard(status: DbConversationSummary["status"]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SidebarConversationCard
        conversation={conv(status)}
        isSelected={false}
        timeLabel="now"
        onSelect={vi.fn()}
        onDoubleClick={vi.fn()}
        onRename={vi.fn(async () => {})}
        onDelete={vi.fn(async () => {})}
        onStatusChange={vi.fn(async () => {})}
      />
    </NextIntlClientProvider>
  )
}

describe("SidebarConversationCard background work", () => {
  it("keeps the running badge while a background task outlives the turn", () => {
    backendRunning.value = true
    const { getByTitle, queryByText } = renderCard("pending_review")
    expect(getByTitle("Running")).toBeTruthy()
    // 时间标签让位给运行标记，行看起来不是“已经停下”。
    expect(queryByText("now")).toBeNull()
  })

  it("falls back to the time label once nothing is left running", () => {
    const { queryByTitle, getByText } = renderCard("pending_review")
    expect(queryByTitle("Running")).toBeNull()
    expect(getByText("now")).toBeTruthy()
  })

  it("lets a manual completion win over the backend fallback", () => {
    backendRunning.value = true
    const { queryByTitle } = renderCard("completed")
    expect(queryByTitle("Running")).toBeNull()
  })
})
