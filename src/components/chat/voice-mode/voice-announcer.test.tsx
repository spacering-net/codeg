import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { SessionEvent } from "@/lib/voice-mode/session-watch"
import {
  patchVoiceMode,
  resetVoiceModeStoreForTests,
  setVoicePhase,
} from "@/lib/voice-mode/voice-mode-store"

const watch = vi.hoisted(() => ({
  onEvents: null as ((events: SessionEvent[]) => void) | null,
  ignored: null as (() => string | null) | null,
  stop: vi.fn(),
}))

vi.mock("@/lib/voice-mode/session-watch", () => ({
  watchWorkspaceSessions: (
    onEvents: (events: SessionEvent[]) => void,
    ignored: () => string | null
  ) => {
    watch.onEvents = onEvents
    watch.ignored = ignored
    return watch.stop
  },
}))

import { VoiceAnnouncer } from "./voice-announcer"

const finished: SessionEvent = {
  kind: "finished",
  connectionId: "c1",
  agentType: "codex",
  title: "Fix the login bug",
}

function mount(announce: "off" | "all", speak = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <VoiceAnnouncer announce={announce} speak={speak} />
    </NextIntlClientProvider>
  )
  return speak
}

function startVoiceMode() {
  act(() => {
    patchVoiceMode({
      assistant: {
        connectionId: "assistant-conn",
        conversationId: 9,
      } as never,
    })
    setVoicePhase("listening")
  })
}

describe("VoiceAnnouncer", () => {
  beforeEach(() => {
    resetVoiceModeStoreForTests()
    watch.onEvents = null
    watch.ignored = null
    watch.stop.mockClear()
  })
  afterEach(() => resetVoiceModeStoreForTests())

  it("speaks an announcement with the agent and title while listening", () => {
    const speak = mount("all")
    startVoiceMode()
    expect(watch.ignored?.()).toBe("assistant-conn")
    act(() => watch.onEvents?.([finished]))
    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak.mock.calls[0][0]).toContain("Fix the login bug")
    expect(speak.mock.calls[0][0]).toContain("Codex")
  })

  it("holds announcements during a reply until listening resumes", () => {
    const speak = mount("all")
    startVoiceMode()
    act(() => setVoicePhase("speaking"))
    act(() => watch.onEvents?.([finished]))
    expect(speak).not.toHaveBeenCalled()
    act(() => setVoicePhase("listening"))
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it("collapses a repeated event for the same session", () => {
    const speak = mount("all")
    startVoiceMode()
    act(() => watch.onEvents?.([finished]))
    act(() => watch.onEvents?.([finished]))
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it("drops the queue and stops watching when voice mode exits", () => {
    const speak = mount("all")
    startVoiceMode()
    act(() => setVoicePhase("speaking"))
    act(() => watch.onEvents?.([finished]))
    act(() => setVoicePhase("off"))
    expect(watch.stop).toHaveBeenCalled()
    startVoiceMode()
    expect(speak).not.toHaveBeenCalled()
  })

  it("stays silent and never watches when announcements are off", () => {
    const speak = mount("off")
    startVoiceMode()
    expect(watch.onEvents).toBeNull()
    expect(speak).not.toHaveBeenCalled()
  })
})
