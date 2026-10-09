import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import {
  AGENT_MENTIONS_KEY,
  loadAgentMentionsEnabled,
  saveAgentMentionsEnabled,
  useAgentMentionsEnabled,
} from "./agent-mention-prefs"

beforeEach(() => {
  localStorage.clear()
})

describe("agent mention prefs", () => {
  it("defaults to on when nothing is stored", () => {
    expect(loadAgentMentionsEnabled()).toBe(true)
  })

  it("only an explicit false turns it off", () => {
    localStorage.setItem(AGENT_MENTIONS_KEY, "garbage")
    expect(loadAgentMentionsEnabled()).toBe(true)
    localStorage.setItem(AGENT_MENTIONS_KEY, "false")
    expect(loadAgentMentionsEnabled()).toBe(false)
  })

  it("updates a mounted reader in the same window on save", () => {
    const { result } = renderHook(() => useAgentMentionsEnabled())
    expect(result.current).toBe(true)
    act(() => saveAgentMentionsEnabled(false))
    expect(result.current).toBe(false)
    act(() => saveAgentMentionsEnabled(true))
    expect(result.current).toBe(true)
  })

  it("follows a write made in another window (storage event)", () => {
    const { result } = renderHook(() => useAgentMentionsEnabled())
    act(() => {
      localStorage.setItem(AGENT_MENTIONS_KEY, "false")
      window.dispatchEvent(
        new StorageEvent("storage", { key: AGENT_MENTIONS_KEY })
      )
    })
    expect(result.current).toBe(false)
  })
})
