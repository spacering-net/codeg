import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
  currentTaskFromMessage,
  resetTaskFromMessageForTests,
} from "@/lib/task-from-message"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import { useCreateTaskFromMessage } from "./use-create-task-from-message"

function seed(activeFolderId: number | null) {
  useAppWorkspaceStore.setState({
    folders: [
      { id: 3, name: "codeg", parent_id: null, kind: "regular" },
      // A worktree of it.
      { id: 5, name: "codeg-wt", parent_id: 3, kind: "regular" },
      { id: 8, name: "scratch", parent_id: null, kind: "chat" },
    ] as never,
  })
  useTabStore.setState({
    rawTabs:
      activeFolderId == null ? [] : [{ id: "t1", folderId: activeFolderId }],
    activeTabId: activeFolderId == null ? null : "t1",
  } as never)
}

/** Clicks "create task" on a message reading `text`, in the active tab. */
function createTask(text: string) {
  // No workbench route provider: the editor opens over the page, so the action
  // has no route to change.
  const { result } = renderHook(() => useCreateTaskFromMessage(() => text))
  result.current()
}

afterEach(() => {
  resetTaskFromMessageForTests()
  resetTabStore()
  resetAppWorkspaceStore()
})

describe("useCreateTaskFromMessage", () => {
  it("opens the editor on the message, in its conversation's project", () => {
    seed(3)
    createTask("  Fix the login timeout\n")
    expect(currentTaskFromMessage()).toMatchObject({
      text: "Fix the login timeout",
      folderId: 3,
    })
  })

  it("puts a worktree conversation's task in the project it came from", () => {
    seed(5)
    createTask("Fix the login timeout")
    expect(currentTaskFromMessage()).toMatchObject({ folderId: 3 })
  })

  it("leaves the project to the editor for a conversation outside one", () => {
    seed(8)
    createTask("Fix the login timeout")
    expect(currentTaskFromMessage()).toMatchObject({ folderId: null })
    resetTaskFromMessageForTests()

    seed(null)
    createTask("Fix the login timeout")
    expect(currentTaskFromMessage()).toMatchObject({ folderId: null })
  })

  it("opens nothing for a message with no text", () => {
    seed(3)
    createTask("  \n ")
    expect(currentTaskFromMessage()).toBeNull()
  })
})
