import { afterEach, describe, expect, it } from "vitest"

import {
  CLOSED_TAB_STACK_LIMIT,
  batchCloseSlots,
  peekClosedTab,
  popClosedTab,
  pushClosedTab,
  resetClosedTabStackForTests,
  snapshotBrowserTab,
  snapshotConversationTab,
  snapshotFileTab,
} from "./closed-tab-stack"

afterEach(() => {
  resetClosedTabStackForTests()
})

function conversation(id: number, index = 0) {
  return snapshotConversationTab(
    {
      id: `conv-${id}`,
      folderId: 1,
      conversationId: id,
      agentType: "claude_code",
      title: `t${id}`,
      isPinned: false,
    },
    index
  )
}

function drainKeys(): string[] {
  const keys: string[] = []
  while (true) {
    const next = popClosedTab()
    if (!next) return keys
    keys.push(next.key)
  }
}

describe("closed tab stack", () => {
  it("restores the most recently closed tab first", () => {
    pushClosedTab(
      snapshotConversationTab(
        {
          id: "conv-10",
          folderId: 1,
          conversationId: 10,
          agentType: "claude_code",
          title: "first",
          isPinned: false,
        },
        0
      )
    )
    pushClosedTab(
      snapshotConversationTab(
        {
          id: "conv-11",
          folderId: 1,
          conversationId: 11,
          agentType: "codex",
          title: "second",
          isPinned: true,
        },
        1
      )
    )
    expect(peekClosedTab()?.kind).toBe("conversation")
    expect(popClosedTab()).toMatchObject({
      conversationId: 11,
      title: "second",
    })
    expect(popClosedTab()).toMatchObject({ conversationId: 10, title: "first" })
    expect(popClosedTab()).toBeNull()
  })

  it("drops the oldest entry past the browser-like cap", () => {
    for (let i = 0; i < CLOSED_TAB_STACK_LIMIT + 3; i += 1) {
      pushClosedTab(
        snapshotConversationTab(
          {
            id: `conv-${i}`,
            folderId: 1,
            conversationId: i,
            agentType: "grok",
            title: `t${i}`,
            isPinned: false,
          },
          i
        )
      )
    }
    const first = popClosedTab()
    expect(first).toMatchObject({ conversationId: CLOSED_TAB_STACK_LIMIT + 2 })
    let oldestKept: ReturnType<typeof popClosedTab> = null
    while (true) {
      const next = popClosedTab()
      if (!next) break
      oldestKept = next
    }
    expect(oldestKept).toMatchObject({ conversationId: 3 })
  })

  // The file-tab closers record from inside a `setFileTabs` updater, which
  // React double-invokes under StrictMode and may replay when it discards a
  // render. A replayed pass must not cost a second press to walk past.
  it("keeps one entry per tab, replaying a close to the same stack", () => {
    pushClosedTab(conversation(1))
    pushClosedTab(conversation(1))
    expect(drainKeys()).toEqual(["conv-1"])
  })

  it("keeps a replayed close-all batch to one entry per tab, in order", () => {
    const batch = [conversation(1), conversation(2), conversation(3)]
    for (const tab of batch) pushClosedTab(tab)
    for (const tab of batch) pushClosedTab(tab)
    expect(drainKeys()).toEqual(["conv-3", "conv-2", "conv-1"])
  })

  it("moves a re-closed tab back to the top instead of duplicating it", () => {
    pushClosedTab(conversation(1))
    pushClosedTab(conversation(2))
    // Reopened from the sidebar (which does not pop), then closed again.
    pushClosedTab(conversation(1))
    expect(drainKeys()).toEqual(["conv-1", "conv-2"])
  })

  it("skips a file tab with no path", () => {
    expect(
      snapshotFileTab({ id: "f", kind: "file", path: null, folderId: 1 }, 0)
    ).toBeNull()
    expect(
      snapshotFileTab(
        {
          id: "file:/repo/a.ts",
          kind: "file",
          path: "/repo/a.ts",
          folderId: 2,
        },
        3
      )
    ).toEqual({
      kind: "file",
      key: "file:/repo/a.ts",
      index: 3,
      path: "/repo/a.ts",
      folderId: 2,
    })
  })

  // A browser tab reopens at the page it was showing, not the address it was
  // opened with — the caller reads that from the live state.
  it("records a browser tab at its live page", () => {
    expect(
      snapshotBrowserTab(
        { id: "browser:abc", folderId: 3, browser: { profile: "p-work" } },
        "https://example.com/deep",
        "Deep page",
        2
      )
    ).toEqual({
      kind: "browser",
      key: "browser:abc",
      index: 2,
      url: "https://example.com/deep",
      title: "Deep page",
      folderId: 3,
      profile: "p-work",
    })
  })

  it("records a remote browser tab as remote", () => {
    expect(
      snapshotBrowserTab(
        {
          id: "browser:r",
          folderId: 3,
          browser: { profile: "default", remote: true },
        },
        "http://localhost:3000/",
        "localhost:3000",
        0
      )
    ).toMatchObject({
      kind: "browser",
      url: "http://localhost:3000/",
      remote: true,
    })
  })

  // A diff tab carries the path it compares, but reopening goes through
  // `openFilePreview` — restoring one would silently swap the diff for the
  // source editor, so it is not recorded at all.
  it("skips a diff tab even though it carries a path", () => {
    for (const kind of ["diff", "rich-diff"]) {
      expect(
        snapshotFileTab(
          {
            id: `${kind}:/repo/a.ts`,
            kind,
            path: "/repo/a.ts",
            folderId: 2,
          },
          0
        )
      ).toBeNull()
    }
  })

  it("records the strip slot the tab was closed from", () => {
    expect(conversation(1, 3).index).toBe(3)
  })

  // A batch close records every member against the same strip, but the stack
  // is popped newest-first. Each slot is where the tab would sit once the
  // members before it are gone, so reopening in reverse walks the strip back.
  it("gives a batch close the slots that rebuild the strip in reverse", () => {
    const strip = ["a", "b", "c", "d"]
    expect(batchCloseSlots(strip)).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 0],
      ["d", 0],
    ])
    expect(batchCloseSlots(strip, (tab) => tab !== "b")).toEqual([
      ["a", 0],
      ["c", 1],
      ["d", 1],
    ])
    expect(batchCloseSlots(strip, (tab) => tab > "b")).toEqual([
      ["c", 2],
      ["d", 2],
    ])
  })
})
