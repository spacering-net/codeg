import { describe, expect, it } from "vitest"

import { runningConversationIds } from "./use-background-conversation-running"

describe("侧栏后台运行兜底", () => {
  it("只取仍有后台工作且绑定了会话的连接", () => {
    expect(
      runningConversationIds([
        { conversation_id: 7, background_running: true },
        { conversation_id: 8, background_running: false },
        { conversation_id: null, background_running: true },
        {},
      ])
    ).toEqual(new Set([7]))
  })
})
