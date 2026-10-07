import { afterEach, describe, expect, it } from "vitest"
import { sessionNotificationPayload } from "./notification-session"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"

function folder(
  id: number,
  name: string,
  alias: string | null = null,
  kind: FolderDetail["kind"] = "regular"
) {
  return { id, name, alias, kind } as unknown as FolderDetail
}

function conversation(id: number, folderId: number, title: string | null) {
  return {
    id,
    folder_id: folderId,
    title,
  } as unknown as DbConversationSummary
}

function seedWorkspace() {
  const folders = [folder(1, "codeg"), folder(2, "web-app", "Storefront")]
  // A chat-mode conversation's folder is hidden from the sidebar's list.
  const chatFolder = folder(3, "Chat", null, "chat")
  useAppWorkspaceStore.setState({
    folders,
    allFolders: [...folders, chatFolder],
    conversations: [
      conversation(10, 1, "Fix the login redirect"),
      conversation(20, 2, "Refactor [README.md](file:///x/README.md) intro"),
      conversation(30, 3, "Plan the release notes"),
    ],
  })
}

function seed(tab: {
  id: string
  folderId: number
  conversationId: number | null
  runtimeConversationId?: number
  title: string
}) {
  seedWorkspace()
  // Tabs derive from the conversation list, so they go in last.
  useTabStore.setState({
    tabs: [
      {
        kind: "conversation",
        agentType: "codex",
        isPinned: false,
        ...tab,
      },
    ] as never,
  })
}

afterEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetConversationRuntimeStore()
})

describe("sessionNotificationPayload", () => {
  it("titles the notification with the session and names ITS folder", () => {
    seed({ id: "t1", folderId: 1, conversationId: 10, title: "tab label" })
    // The window's active folder is a different one — it must not win.
    const p = sessionNotificationPayload("t1", null, "some-other-folder", {
      body: "Agent is waiting for your answer",
    })
    expect(p.title).toBe("Fix the login redirect")
    expect(p.body).toBe("codeg · Agent is waiting for your answer")
    // "Hide notification contents" must not leak the user's own words, and
    // its title names the folder again, so the body doesn't repeat it.
    expect(p.redactedTitle).toBe("codeg - Codeg")
    expect(p.redactedBody).toBe("Agent is waiting for your answer")
  })

  it("prefers the folder alias and folds reference links in the title", () => {
    seed({ id: "t2", folderId: 2, conversationId: 20, title: "tab label" })
    const p = sessionNotificationPayload("t2", null, null, {
      body: "Agent error: boom",
      redactedBody: "Agent ran into an error",
    })
    expect(p.title).toBe("Refactor README.md intro")
    expect(p.body).toBe("Storefront · Agent error: boom")
    expect(p.redactedTitle).toBe("Storefront - Codeg")
    expect(p.redactedBody).toBe("Agent ran into an error")
  })

  it("falls back to the tab's label for a draft with no row yet", () => {
    seed({ id: "t3", folderId: 1, conversationId: null, title: "New chat" })
    const p = sessionNotificationPayload("t3", null, null, { body: "done" })
    expect(p.title).toBe("New chat")
    expect(p.body).toBe("codeg · done")
  })

  it("reaches the row through the runtime session before the tab is bound", () => {
    useConversationRuntimeStore.getState().actions.setDbConversationId(-7, 20)
    seed({
      id: "t4",
      folderId: 2,
      conversationId: null,
      runtimeConversationId: -7,
      title: "New chat",
    })
    const p = sessionNotificationPayload("t4", null, null, { body: "done" })
    expect(p.title).toBe("Refactor README.md intro")
    expect(p.body).toBe("Storefront · done")
  })

  it("names a chat-mode session's hidden folder", () => {
    seed({ id: "t5", folderId: 3, conversationId: 30, title: "tab label" })
    const p = sessionNotificationPayload("t5", null, "codeg", { body: "done" })
    expect(p.title).toBe("Plan the release notes")
    expect(p.body).toBe("Chat · done")
  })

  it("names no folder rather than the active one for a folderless draft", () => {
    // A chat-mode draft has no folder until its first send creates one.
    seed({ id: "t6", folderId: 0, conversationId: null, title: "New chat" })
    const p = sessionNotificationPayload("t6", null, "codeg", { body: "done" })
    expect(p.title).toBe("New chat")
    expect(p.body).toBe("done")
    expect(p.redactedTitle).toBe("Codeg")
  })

  it("names the conversation a tab closed mid-turn was serving", () => {
    // Closing a busy tab keeps its connection, so the turn finishes under a
    // tab id that no longer exists — its connection still knows the row.
    seedWorkspace()
    const p = sessionNotificationPayload("closed-tab", 20, "codeg", {
      body: "done",
    })
    expect(p.title).toBe("Refactor README.md intro")
    expect(p.body).toBe("Storefront · done")
    expect(p.redactedTitle).toBe("Storefront - Codeg")
  })

  it("prefers the tab's own conversation over its connection's", () => {
    seed({ id: "t7", folderId: 1, conversationId: 10, title: "tab label" })
    const p = sessionNotificationPayload("t7", 20, null, { body: "done" })
    expect(p.title).toBe("Fix the login redirect")
    expect(p.body).toBe("codeg · done")
  })

  it("keeps the old folder title when nothing names the session", () => {
    seedWorkspace()
    // No tab, and no conversation known for the connection.
    expect(
      sessionNotificationPayload("unknown-key", undefined, "codeg", {
        body: "done",
      })
    ).toEqual({ title: "codeg - Codeg", body: "done" })
    // A delegated sub-agent's row: the conversation list leaves children out.
    expect(
      sessionNotificationPayload("child-connection", 99, "codeg", {
        body: "done",
      })
    ).toEqual({ title: "codeg - Codeg", body: "done" })
  })
})
