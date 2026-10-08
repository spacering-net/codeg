import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MessageTurn } from "@/lib/types"

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
  getShellTransport: () => ({ call }),
  isDesktop: () => true,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

import { acpForkBeforeUserTurn, acpPrompt } from "./api"
import { TurnBusyError } from "./turn-busy"

const target: MessageTurn = {
  id: "turn-2",
  role: "user",
  timestamp: "2026-10-08T01:00:00Z",
  blocks: [{ type: "text", text: "old prompt" }],
}

describe("strict message edit transport", () => {
  beforeEach(() => {
    call.mockReset()
  })

  it("uses a dedicated command so old servers cannot silently tail-fork", async () => {
    call.mockResolvedValue({ forkedSessionId: "child" })
    await acpForkBeforeUserTurn("connection", 1, 2, "parent", target)
    expect(call).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith("acp_edit_fork", {
      connectionId: "connection",
      conversationId: 1,
      folderId: 2,
      expectedSessionId: "parent",
      forkBeforeTurnId: "turn-2",
      expectedTurn: target,
    })
  })

  it("never retries against the ordinary fork command", async () => {
    call.mockRejectedValue(new Error("Unknown command acp_edit_fork"))
    await expect(
      acpForkBeforeUserTurn("connection", 1, 2, "parent", target)
    ).rejects.toThrow("Unknown command")
    expect(call).toHaveBeenCalledOnce()
  })

  it("preserves the busy rejection for draft recovery", async () => {
    call.mockRejectedValue({
      code: "turn_in_progress",
      message: "Turn already in progress",
    })
    await expect(
      acpForkBeforeUserTurn("connection", 1, 2, "parent", target)
    ).rejects.toBeInstanceOf(TurnBusyError)
  })

  it("pins the revised prompt to its destination session", async () => {
    const blocks = [{ type: "text" as const, text: "revised prompt" }]
    await acpPrompt("connection", blocks, 2, 1, "message", "child")
    expect(call).toHaveBeenCalledWith(
      "acp_prompt",
      expect.objectContaining({
        expectedSessionId: "child",
        clientMessageId: "message",
        blocks,
      })
    )
  })
})
