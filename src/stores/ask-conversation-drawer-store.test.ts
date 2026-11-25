import { beforeEach, describe, expect, it } from "vitest"

import { useAskConversationDrawerStore } from "./ask-conversation-drawer-store"

const draft = {
  blocks: [{ type: "text" as const, text: "why?" }],
  displayText: "why?",
}

function openNew() {
  return useAskConversationDrawerStore.getState().openNew({
    parentConversationId: 1,
    agentType: "claude_code",
    folderId: 3,
    workingDir: "/repo",
    initialSend: { draft, modeId: null },
  })
}

function openExisting(conversationId: number) {
  return useAskConversationDrawerStore.getState().openExisting({
    kind: "ask",
    parentConversationId: 1,
    conversationId,
    agentType: "claude_code",
    folderId: 3,
    workingDir: "/repo",
  })
}

beforeEach(() => {
  useAskConversationDrawerStore.setState({
    target: null,
    discardArmed: false,
    creatingKey: null,
  })
})

describe("ask conversation drawer store", () => {
  it("refuses the first close while a new ask's first message is unsent", () => {
    expect(openNew()).toBe(true)
    const store = useAskConversationDrawerStore.getState()

    expect(store.close()).toBe(false)
    expect(useAskConversationDrawerStore.getState().target).not.toBeNull()
    // The second attempt is the user meaning it.
    expect(useAskConversationDrawerStore.getState().close()).toBe(true)
    expect(useAskConversationDrawerStore.getState().target).toBeNull()
  })

  it("refuses replacing an unsent ask once, for a new ask or an existing one", () => {
    openNew()
    expect(openExisting(9)).toBe(false)
    expect(openNew()).toBe(true)
    expect(
      useAskConversationDrawerStore.getState().target?.initialSend
    ).not.toBeNull()
    expect(openExisting(9)).toBe(false)
    expect(openExisting(9)).toBe(true)
    expect(
      useAskConversationDrawerStore.getState().target?.conversationId
    ).toBe(9)
  })

  it("closes freely once the first message has been handed over", () => {
    openNew()
    const { contextKey } = useAskConversationDrawerStore.getState().target!
    useAskConversationDrawerStore.getState().consumeInitialSend(contextKey)
    // Filed under another conversation than the one it was asked from (an
    // ask asked from an ask): the drawer follows it there.
    useAskConversationDrawerStore.getState().setCreated(contextKey, 12, 3)
    expect(useAskConversationDrawerStore.getState().target).toMatchObject({
      conversationId: 12,
      parentConversationId: 3,
    })
    expect(useAskConversationDrawerStore.getState().close()).toBe(true)
  })

  it("keeps refusing while the first send is creating the row", () => {
    openNew()
    const { contextKey } = useAskConversationDrawerStore.getState().target!
    useAskConversationDrawerStore.getState().setCreating(contextKey, true)
    useAskConversationDrawerStore.getState().consumeInitialSend(contextKey)
    expect(useAskConversationDrawerStore.getState().close()).toBe(false)

    useAskConversationDrawerStore.getState().setCreating(contextKey, false)
    expect(useAskConversationDrawerStore.getState().close()).toBe(true)
  })

  it("keeps the surface when the ask on show is opened again", () => {
    openExisting(5)
    const before = useAskConversationDrawerStore.getState().target
    expect(openExisting(5)).toBe(true)
    expect(useAskConversationDrawerStore.getState().target).toBe(before)
    expect(before?.contextKey).toBe("ask-drawer-5")
  })
})
