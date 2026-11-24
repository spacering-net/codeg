import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ASK_SELECTION_PARKED_EVENT,
  consumeAskSelectionPrompts,
  discardAskSelectionPrompts,
  parkAskSelectionPrompt,
  resetAskSelectionPromptsForTests,
  type AskSelectionParkedDetail,
} from "./ask-selection-handoff"

/** The identity a draft tab is promised, and reports back when it drains. */
const CODEX_IN_1 = { agentType: "codex", folderId: 1 } as const
const CLAUDE_IN_1 = { agentType: "claude_code", folderId: 1 } as const
const CODEX_IN_2 = { agentType: "codex", folderId: 2 } as const

const park = (
  tabId: string,
  prompt: string,
  identity: {
    agentType: "codex" | "claude_code"
    folderId: number
  } = CODEX_IN_1
) => parkAskSelectionPrompt(tabId, { prompt, ...identity })

beforeEach(() => {
  resetAskSelectionPromptsForTests()
})

afterEach(() => {
  resetAskSelectionPromptsForTests()
})

describe("ask-selection hand-off", () => {
  it("delivers a prompt to the tab it was parked for", () => {
    park("new-1", "> quoted\n\nwhy?")
    expect(consumeAskSelectionPrompts("new-1", CODEX_IN_1)).toEqual([
      "> quoted\n\nwhy?",
    ])
  })

  it("gives nothing to any other tab", () => {
    // Each split group keeps its own draft tab; a sibling draft panel draining
    // on mount must not swallow a prompt meant for the other one.
    park("new-1", "mine")
    expect(consumeAskSelectionPrompts("new-2", CODEX_IN_1)).toEqual([])
    expect(consumeAskSelectionPrompts("new-1", CODEX_IN_1)).toEqual(["mine"])
  })

  it("is one-shot", () => {
    // The panel drains on mount AND on the event, so a second read of the same
    // prompt would send the question twice.
    park("new-1", "once")
    expect(consumeAskSelectionPrompts("new-1", CODEX_IN_1)).toEqual(["once"])
    expect(consumeAskSelectionPrompts("new-1", CODEX_IN_1)).toEqual([])
  })

  it("keeps both prompts when two asks land on one tab before it drains", () => {
    park("new-1", "first")
    park("new-1", "second")
    expect(consumeAskSelectionPrompts("new-1", CODEX_IN_1)).toEqual([
      "first",
      "second",
    ])
  })

  it.each([
    ["the agent it will be retargeted to", CLAUDE_IN_1],
    ["the folder it will be retargeted to", CODEX_IN_2],
  ])("holds a prompt back until the tab is on %s", (_label, current) => {
    // Reusing a draft that belongs to another folder/agent retargets it
    // ASYNCHRONOUSLY. In that window the tab is self-consistently the OLD one —
    // it may even be connected and ready — so draining then would send the
    // question through the wrong agent, in the wrong workspace.
    park("new-1", "for codex in folder 1", CODEX_IN_1)

    expect(consumeAskSelectionPrompts("new-1", current)).toEqual([])
    // Still there, waiting for the retarget to land.
    expect(consumeAskSelectionPrompts("new-1", CODEX_IN_1)).toEqual([
      "for codex in folder 1",
    ])
  })

  it("releases only the prompts that match, keeping the rest parked", () => {
    park("new-1", "for codex", CODEX_IN_1)
    park("new-1", "for claude", CLAUDE_IN_1)

    expect(consumeAskSelectionPrompts("new-1", CLAUDE_IN_1)).toEqual([
      "for claude",
    ])
    expect(consumeAskSelectionPrompts("new-1", CODEX_IN_1)).toEqual([
      "for codex",
    ])
  })

  it("drops what was parked for a tab that closes", () => {
    // Nothing will ever drain it, and tab ids are not reused — without this a
    // prompt held back by the match guard would sit in the map all session.
    park("new-1", "orphaned")
    discardAskSelectionPrompts("new-1")
    expect(consumeAskSelectionPrompts("new-1", CODEX_IN_1)).toEqual([])
  })

  it("announces the target tab so an already-mounted panel can drain", () => {
    const listener = vi.fn()
    window.addEventListener(ASK_SELECTION_PARKED_EVENT, listener)
    try {
      park("new-7", "hi")
      expect(listener).toHaveBeenCalledTimes(1)
      const event = listener.mock
        .calls[0][0] as CustomEvent<AskSelectionParkedDetail>
      expect(event.detail.tabId).toBe("new-7")
      // The prompt itself is NOT in the event: the buffer is the source of
      // truth, so a panel mounting after the event still finds it.
      expect(consumeAskSelectionPrompts("new-7", CODEX_IN_1)).toEqual(["hi"])
    } finally {
      window.removeEventListener(ASK_SELECTION_PARKED_EVENT, listener)
    }
  })
})
