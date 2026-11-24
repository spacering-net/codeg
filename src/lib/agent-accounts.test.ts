import { beforeEach, expect, it, vi } from "vitest"
import {
  agentAccountKey,
  readSelectedAccount,
  resolveConversationAccount,
  saveSelectedAccount,
} from "./agent-accounts"
import { getActiveRemoteConnectionId } from "./transport"

vi.mock("./transport", () => ({
  getTransport: vi.fn(),
  getActiveRemoteConnectionId: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  vi.mocked(getActiveRemoteConnectionId).mockReturnValue(null)
})

it("keeps model preferences and remembered accounts separate across families and servers", () => {
  expect(agentAccountKey("codex")).toBe("codex")
  expect(agentAccountKey("codex", "a")).not.toBe(agentAccountKey("codex", "b"))
  saveSelectedAccount("codex", "local-account")
  expect(readSelectedAccount("claude_code")).toBeNull()
  vi.mocked(getActiveRemoteConnectionId).mockReturnValue(42)
  expect(readSelectedAccount("codex")).toBeNull()
  saveSelectedAccount("codex", "remote-account")
  expect(readSelectedAccount("codex")).toBe("remote-account")
  vi.mocked(getActiveRemoteConnectionId).mockReturnValue(null)
  expect(readSelectedAccount("codex")).toBe("local-account")
  saveSelectedAccount("codex", null)
  expect(readSelectedAccount("codex")).toBeNull()
})

it("uses a draft's picked account until the conversation exists", () => {
  expect(resolveConversationAccount({ persisted: false, draft: "work" })).toBe(
    "work"
  )
  expect(
    resolveConversationAccount({
      persisted: false,
      draft: null,
      listed: { accountId: "x", updatedAt: "2026-10-11T00:00:00Z" },
    })
  ).toBeNull()
})

// A tab that started as a draft keeps a virtual runtime key, so no detail is
// ever fetched for it. Its binding must still be known after the first send,
// or the tab reads as Default and holds its reconnects for good.
it("knows a persisted conversation's account without its detail", () => {
  const persisted = { persisted: true, draft: "picked-later" }
  const at = "2026-10-11T00:00:00Z"
  expect(resolveConversationAccount({ ...persisted, local: "work" })).toBe(
    "work"
  )
  expect(
    resolveConversationAccount({
      ...persisted,
      listed: { accountId: "work", updatedAt: at },
    })
  ).toBe("work")
  expect(
    resolveConversationAccount({
      ...persisted,
      listed: { accountId: null, updatedAt: at },
    })
  ).toBeNull()
  expect(
    resolveConversationAccount({
      ...persisted,
      detail: { accountId: null, updatedAt: at },
    })
  ).toBeNull()
  expect(resolveConversationAccount(persisted)).toBeUndefined()
})

// A list refresh can hand back a copy of the row older than the detail (and
// the detail can be the older one after a switch made elsewhere). The account
// only changes in a write that moves `updated_at`, so the later copy wins.
it("takes the later of the list and detail copies", () => {
  const before = "2026-10-11T00:00:00Z"
  const after = "2026-10-11T00:05:00Z"
  const base = { persisted: true, draft: null }
  expect(
    resolveConversationAccount({
      ...base,
      listed: { accountId: "old", updatedAt: before },
      detail: { accountId: "switched", updatedAt: after },
    })
  ).toBe("switched")
  expect(
    resolveConversationAccount({
      ...base,
      listed: { accountId: "switched", updatedAt: after },
      detail: { accountId: "old", updatedAt: before },
    })
  ).toBe("switched")
  expect(
    resolveConversationAccount({
      ...base,
      listed: { accountId: "list", updatedAt: after },
      detail: { accountId: "detail", updatedAt: after },
    })
  ).toBe("detail")
})

it("puts this view's own binding first", () => {
  expect(
    resolveConversationAccount({
      persisted: true,
      draft: null,
      local: "switched",
      listed: { accountId: "before", updatedAt: "2026-10-11T00:05:00Z" },
      detail: { accountId: "older", updatedAt: "2026-10-11T00:00:00Z" },
    })
  ).toBe("switched")
  expect(
    resolveConversationAccount({ persisted: true, draft: null, local: null })
  ).toBeNull()
})
