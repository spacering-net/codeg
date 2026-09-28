import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AssistantSession, EventEnvelope } from "@/lib/types"
import type { VadEvent } from "@/lib/voice-mode/vad"
import {
  getVoiceModeState,
  requestVoiceMode,
  resetVoiceModeStoreForTests,
  subscribeVoiceMode,
  type VoiceModePhase,
} from "@/lib/voice-mode/voice-mode-store"

const acp = vi.hoisted(() => ({
  handler: null as ((envelope: EventEnvelope) => void) | null,
  status: new Map<string, string>(),
  pendingAskQuestion: null as unknown,
  triggerSubscribe: null as (() => void) | null,
  actions: {
    answerQuestion: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => {}),
    cancel: vi.fn(),
    attachDelegationChild: vi.fn(),
    detachDelegationChild: vi.fn(),
    registerLiveSurfaceKeys: vi.fn(),
  },
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => acp.actions,
  useConnectionStore: () => ({
    getConnection: (key: string) =>
      acp.status.has(key)
        ? {
            status: acp.status.get(key),
            pendingAskQuestion: acp.pendingAskQuestion,
          }
        : undefined,
    subscribeKey: (_key: string, cb: () => void) => {
      cb()
      acp.triggerSubscribe = cb
      return () => {
        acp.triggerSubscribe = null
      }
    },
  }),
  useAcpEvent: (handler: (envelope: EventEnvelope) => void) => {
    acp.handler = handler
  },
}))

const api = vi.hoisted(() => ({
  assistantEnsure: vi.fn(),
  assistantGetSettings: vi.fn(),
  speechGetSettings: vi.fn(),
  openSettingsWindow: vi.fn(async () => {}),
}))
vi.mock("@/lib/api", () => api)

vi.mock("@/lib/speech-capabilities", () => ({
  detectSpeechCapabilities: () => ({}),
  resolveInputEngine: () => ({ engine: "browser" }),
  resolveOutputEngine: () => ({ engine: "browser" }),
  resolveSpeechLanguage: () => "en-US",
  waitForVoices: async () => [{}],
}))

const prefs = vi.hoisted(() => ({ bargeIn: true }))
vi.mock("@/lib/speech-prefs", () => ({
  getSpeechPrefs: () => ({
    input: { engine: "browser", language: "" },
    output: { engine: "browser" },
    voiceMode: {
      enabled: true,
      endSilenceMs: 900,
      bargeIn: prefs.bargeIn,
      announce: "all",
      voiceApprovals: false,
    },
  }),
  // Announcements have their own tests (voice-announcer.test.tsx).
  useSpeechPrefs: () => ({ voiceMode: { announce: "off" } }),
}))

const player = vi.hoisted(() => ({
  drained: new Set<() => void>(),
  beginSpeechStream: vi.fn(),
  enqueueSpeech: vi.fn(),
  endSpeechStream: vi.fn(),
  stopSpeech: vi.fn(),
}))
vi.mock("@/lib/speech-player", () => ({
  beginSpeechStream: player.beginSpeechStream,
  enqueueSpeech: player.enqueueSpeech,
  endSpeechStream: player.endSpeechStream,
  stopSpeech: player.stopSpeech,
  onSpeechDrained: (listener: () => void) => {
    player.drained.add(listener)
    return () => player.drained.delete(listener)
  },
}))

const front = vi.hoisted(() => ({
  onVadEvent: null as ((event: VadEvent) => void) | null,
  stop: vi.fn(async () => {}),
  setPlaybackActive: vi.fn(),
}))
vi.mock("@/lib/voice-mode/audio-frontend", () => ({
  startAudioFrontend: vi.fn(
    async (options: { onVadEvent: (event: VadEvent) => void }) => {
      front.onVadEvent = options.onVadEvent
      return { stream: {}, stop: front.stop }
    }
  ),
}))
vi.mock("@/lib/voice-mode/vad", () => ({
  createVad: () => ({
    push: () => [],
    setPlaybackActive: front.setPlaybackActive,
  }),
}))

const recorder = vi.hoisted(() => ({
  pending: [] as Array<(text: string) => void>,
  beginUtterance: vi.fn(),
  abort: vi.fn(),
}))
vi.mock("@/lib/voice-mode/utterance-recorder", () => ({
  createUtteranceRecorder: () => ({
    beginUtterance: recorder.beginUtterance,
    abort: recorder.abort,
    endUtterance: () =>
      new Promise<string>((resolve) => recorder.pending.push(resolve)),
  }),
}))

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

import { VoiceModeHost } from "./voice-mode-host"

const ASSISTANT: AssistantSession = {
  connectionId: "assistant-conn",
  conversationId: 41,
  folderId: 7,
  agentType: "open_code",
  primer: "PRIMER",
} as unknown as AssistantSession

function untilPhase(phase: VoiceModePhase): Promise<void> {
  if (getVoiceModeState().phase === phase) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(
        new Error(`phase stayed ${getVoiceModeState().phase}, not ${phase}`)
      )
    }, 2000)
    const unsubscribe = subscribeVoiceMode(() => {
      if (getVoiceModeState().phase !== phase) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

function renderHost() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <VoiceModeHost />
    </NextIntlClientProvider>
  )
}

async function startVoiceMode() {
  const view = renderHost()
  act(() => requestVoiceMode(true))
  await act(() => untilPhase("listening"))
  return view
}

async function say(text: string) {
  act(() => {
    front.onVadEvent?.("speech-candidate")
    front.onVadEvent?.("speech-start")
    front.onVadEvent?.("speech-end")
  })
  const resolve = recorder.pending.shift()
  if (!resolve) throw new Error("no utterance was being recorded")
  await act(async () => resolve(text))
}

function emit(event: Record<string, unknown>) {
  act(() => acp.handler?.({ seq: 1, ...event } as unknown as EventEnvelope))
}

function delta(text: string, connectionId = ASSISTANT.connectionId) {
  emit({ connection_id: connectionId, type: "content_delta", text })
}

function turnComplete(stopReason = "end_turn") {
  emit({
    connection_id: ASSISTANT.connectionId,
    type: "turn_complete",
    session_id: "s",
    stop_reason: stopReason,
  })
}

function drain() {
  act(() => {
    for (const listener of [...player.drained]) listener()
  })
}

function sentTexts() {
  return acp.actions.sendPrompt.mock.calls.map((call) =>
    (call as unknown as [string, Array<{ text: string }>])[1].map(
      (block) => block.text
    )
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  resetVoiceModeStoreForTests()
  acp.handler = null
  acp.status.clear()
  acp.pendingAskQuestion = null
  player.drained.clear()
  recorder.pending.length = 0
  front.onVadEvent = null
  prefs.bargeIn = true
  api.assistantEnsure.mockResolvedValue(ASSISTANT)
  api.assistantGetSettings.mockResolvedValue({
    agentType: "open_code",
    allowSessionControl: false,
    allowPermissionAnswers: false,
  })
  api.speechGetSettings.mockResolvedValue({ apiKeySet: false })
})

afterEach(() => {
  act(() => requestVoiceMode(false))
})

describe("VoiceModeHost", () => {
  it("stays off and points to settings when no assistant agent is set", async () => {
    api.assistantGetSettings.mockResolvedValue({
      agentType: null,
      allowSessionControl: false,
      allowPermissionAnswers: false,
    })
    renderHost()
    act(() => requestVoiceMode(true))
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce())

    expect(getVoiceModeState().phase).toBe("off")
    expect(api.assistantEnsure).not.toHaveBeenCalled()
    expect(front.onVadEvent).toBeNull()
    const [, options] = toast.error.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ]
    options.action.onClick()
    expect(api.openSettingsWindow).toHaveBeenCalledWith("speech")
  })

  it("attaches the assistant and sends utterances there, primer only once", async () => {
    await startVoiceMode()
    expect(acp.actions.attachDelegationChild).toHaveBeenCalledWith({
      connectionId: "assistant-conn",
      parentConnectionId: "assistant-conn",
      parentToolUseId: "voice-assistant",
      agentType: "open_code",
      hydrate: true,
    })
    expect(acp.actions.registerLiveSurfaceKeys).toHaveBeenLastCalledWith(
      "voice-assistant",
      new Set(["assistant-conn"])
    )

    await say("first question")
    expect(getVoiceModeState().phase).toBe("waiting")
    turnComplete()
    drain()
    await say("second question")

    expect(acp.actions.sendPrompt).toHaveBeenCalledTimes(2)
    for (const call of acp.actions.sendPrompt.mock.calls) {
      const [key, , target] = call as unknown as [string, unknown, unknown]
      expect(key).toBe("assistant-conn")
      expect(target).toEqual({ folderId: 7, conversationId: 41 })
    }
    expect(sentTexts()).toEqual([
      ["PRIMER", "first question"],
      ["second question"],
    ])
  })

  it("speaks the reply sentence by sentence and returns to listening once drained", async () => {
    await startVoiceMode()
    await say("hello")
    const [turnId] = player.beginSpeechStream.mock.calls[0] as [string]

    delta("First sentence. Sec")
    expect(player.enqueueSpeech.mock.calls).toEqual([
      [turnId, "First sentence."],
    ])
    expect(getVoiceModeState().phase).toBe("speaking")

    delta("ond sentence")
    turnComplete()
    expect(player.enqueueSpeech).toHaveBeenLastCalledWith(
      turnId,
      "Second sentence."
    )
    expect(player.endSpeechStream).toHaveBeenCalledWith(turnId)
    expect(getVoiceModeState().phase).toBe("speaking")

    drain()
    expect(getVoiceModeState().phase).toBe("listening")
    expect(getVoiceModeState().lastSpoken).toBe(
      "First sentence. Second sentence."
    )
  })

  it("says the turn ended empty when a non end_turn stop has no text", async () => {
    await startVoiceMode()
    await say("hello")
    turnComplete("cancelled")
    expect(player.enqueueSpeech).toHaveBeenCalledWith(
      expect.any(String),
      enMessages.VoiceMode.voiceTurnEndedEmpty
    )
  })

  it("queues speech that interrupts a running turn and sends the latest after turn_complete", async () => {
    await startVoiceMode()
    await say("first")
    acp.status.set("assistant-conn", "prompting")
    await say("replacement one")
    await say("replacement two")

    expect(acp.actions.sendPrompt).toHaveBeenCalledOnce()
    expect(getVoiceModeState().queued).toBe("replacement two")
    expect(getVoiceModeState().phase).toBe("listening")
    expect(toast).toHaveBeenCalledWith(enMessages.VoiceMode.queued)

    acp.status.set("assistant-conn", "connected")
    delta("Late words. ")
    expect(player.enqueueSpeech).not.toHaveBeenCalled()
    turnComplete()

    expect(sentTexts()[1]).toEqual(["replacement two"])
    expect(getVoiceModeState().queued).toBeNull()
    expect(getVoiceModeState().phase).toBe("waiting")
  })

  it("sends text queued during a spoken reply only after the reply drains", async () => {
    window.localStorage.setItem("codeg:voice-debug", "1")
    try {
      await startVoiceMode()
      await say("first")
      delta("Reply one. ")
      act(() => {
        window.__codegVoiceDebug?.inject("follow-up")
      })
      expect(getVoiceModeState().queued).toBe("follow-up")
      expect(getVoiceModeState().phase).toBe("speaking")

      turnComplete()
      expect(acp.actions.sendPrompt).toHaveBeenCalledOnce()
      drain()
      expect(sentTexts()[1]).toEqual(["follow-up"])
      expect(getVoiceModeState().phase).toBe("waiting")
    } finally {
      window.localStorage.removeItem("codeg:voice-debug")
    }
  })

  it("barge-in stops speech without cancelling the turn and drops its late deltas", async () => {
    await startVoiceMode()
    await say("tell me a story")
    delta("Once upon a time. ")
    expect(front.setPlaybackActive).toHaveBeenLastCalledWith(true)
    player.stopSpeech.mockClear()
    player.enqueueSpeech.mockClear()

    act(() => {
      front.onVadEvent?.("speech-candidate")
      front.onVadEvent?.("speech-start")
    })
    expect(player.stopSpeech).toHaveBeenCalledOnce()
    expect(acp.actions.cancel).not.toHaveBeenCalled()
    expect(getVoiceModeState().phase).toBe("capturing")

    delta("There was a dragon. ")
    expect(player.enqueueSpeech).not.toHaveBeenCalled()
  })

  it("ignores speech during a reply when barge-in is off", async () => {
    prefs.bargeIn = false
    await startVoiceMode()
    await say("hello")
    act(() => front.onVadEvent?.("speech-start"))
    expect(getVoiceModeState().phase).toBe("waiting")
    expect(player.stopSpeech).toHaveBeenCalledTimes(1)
  })

  it("ignores events from other connections", async () => {
    await startVoiceMode()
    await say("hello")
    delta("Not mine. ", "tab-conn")
    emit({
      connection_id: "tab-conn",
      type: "turn_complete",
      session_id: "s",
      stop_reason: "end_turn",
    })
    expect(player.enqueueSpeech).not.toHaveBeenCalled()
    expect(player.endSpeechStream).not.toHaveBeenCalled()
    expect(getVoiceModeState().phase).toBe("waiting")
  })

  it("exits on Escape outside inputs, releasing the surface and the microphone", async () => {
    const view = await startVoiceMode()
    const input = document.createElement("input")
    view.container.appendChild(input)
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    })
    expect(getVoiceModeState().phase).toBe("listening")

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    })
    expect(getVoiceModeState().phase).toBe("off")
    expect(front.stop).toHaveBeenCalledOnce()
    expect(acp.actions.detachDelegationChild).toHaveBeenCalledWith(
      "assistant-conn"
    )
    expect(acp.actions.registerLiveSurfaceKeys).toHaveBeenLastCalledWith(
      "voice-assistant",
      new Set()
    )
  })

  it("exits on pagehide", async () => {
    await startVoiceMode()
    act(() => {
      window.dispatchEvent(new Event("pagehide"))
    })
    expect(getVoiceModeState().phase).toBe("off")
    expect(front.stop).toHaveBeenCalledOnce()
  })

  it("exposes a debug hook only behind the local flag", async () => {
    expect(window.__codegVoiceDebug).toBeUndefined()
    window.localStorage.setItem("codeg:voice-debug", "1")
    try {
      const view = await startVoiceMode()
      const debug = window.__codegVoiceDebug
      expect(debug?.inject("typed question")).toBe(true)
      delta("Answer. ")
      expect(sentTexts()[0]).toContain("typed question")
      expect(debug?.state.phase).toBe("speaking")
      expect(debug?.state.spoken).toEqual(["Answer."])
      view.unmount()
      expect(window.__codegVoiceDebug).toBeUndefined()
    } finally {
      window.localStorage.removeItem("codeg:voice-debug")
    }
  })

  it("handles voice commands correctly", async () => {
    acp.status.set("assistant-conn", "connected")
    await startVoiceMode()

    // Stop command
    await say("stop")
    expect(player.stopSpeech).toHaveBeenCalled()
    expect(acp.actions.sendPrompt).not.toHaveBeenCalled()
    expect(getVoiceModeState().phase).toBe("listening")

    // Cancel command
    await say("cancel")
    expect(acp.actions.cancel).toHaveBeenCalledWith("assistant-conn")
    expect(player.stopSpeech).toHaveBeenCalled()
    expect(acp.actions.sendPrompt).not.toHaveBeenCalled()

    // Repeat command
    await say("hello there") // sets turnRef
    delta("hello. ")
    turnComplete()
    drain()
    player.enqueueSpeech.mockClear()
    await say("repeat")
    expect(player.enqueueSpeech).toHaveBeenCalledWith(
      expect.any(String),
      "hello."
    )

    // Exit command
    await say("exit")
    expect(getVoiceModeState().phase).toBe("off")
  })

  it("handles spoken confirmations correctly", async () => {
    acp.status.set("assistant-conn", "connected")
    await startVoiceMode()

    const confirmQ = {
      question_id: "q1",
      questions: [
        {
          id: "sq1",
          question: "Proceed?",
          header: "Confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    }

    // Set pending question
    act(() => {
      acp.pendingAskQuestion = confirmQ
      acp.triggerSubscribe?.()
    })

    expect(getVoiceModeState().phase).toBe("confirming")
    expect(player.enqueueSpeech).toHaveBeenCalledWith(
      expect.any(String),
      enMessages.VoiceMode.confirmPrompt.replace("{action}", "Proceed?")
    )

    // Confirm picks options[0]
    await say("confirm")
    expect(acp.actions.answerQuestion).toHaveBeenCalledWith(
      "assistant-conn",
      "q1",
      { answers: [{ questionId: "sq1", labels: ["Yes"] }], declined: false }
    )
    expect(getVoiceModeState().phase).toBe("listening")
    expect(acp.actions.sendPrompt).not.toHaveBeenCalled()

    // Reset and try reject
    act(() => {
      acp.pendingAskQuestion = { ...confirmQ, question_id: "q2" }
      acp.triggerSubscribe?.()
    })
    expect(getVoiceModeState().phase).toBe("confirming")

    // Reject picks options[1]
    await say("reject")
    expect(acp.actions.answerQuestion).toHaveBeenCalledWith(
      "assistant-conn",
      "q2",
      { answers: [{ questionId: "sq1", labels: ["No"] }], declined: false }
    )

    // Reset and try non-matches
    act(() => {
      acp.pendingAskQuestion = { ...confirmQ, question_id: "q3" }
      acp.triggerSubscribe?.()
    })

    // 1st non-match
    await say("maybe")
    expect(acp.actions.answerQuestion).not.toHaveBeenCalledWith(
      "assistant-conn",
      "q3",
      expect.anything()
    )
    expect(player.enqueueSpeech).toHaveBeenCalledWith(
      expect.any(String),
      enMessages.VoiceMode.confirmRepeat
    )
    expect(getVoiceModeState().phase).toBe("confirming")

    // 2nd non-match
    await say("maybe again")
    expect(acp.actions.answerQuestion).not.toHaveBeenCalledWith(
      "assistant-conn",
      "q3",
      expect.anything()
    )
    expect(player.enqueueSpeech).toHaveBeenCalledWith(
      expect.any(String),
      enMessages.VoiceMode.confirmUseScreen
    )
    expect(getVoiceModeState().phase).toBe("listening")

    // Answered by click
    act(() => {
      acp.pendingAskQuestion = { ...confirmQ, question_id: "q4" }
      acp.triggerSubscribe?.()
    })
    expect(getVoiceModeState().phase).toBe("confirming")
    act(() => {
      acp.pendingAskQuestion = null
      acp.triggerSubscribe?.()
    })
    expect(getVoiceModeState().phase).toBe("listening")
  })

  it("speaks a confirmation card that arrives during a reply", async () => {
    acp.status.set("assistant-conn", "connected")
    await startVoiceMode()
    await say("tell the other tab to run ls")
    delta("Let me check. ")
    expect(getVoiceModeState().phase).toBe("speaking")
    const prompt = enMessages.VoiceMode.confirmPrompt.replace(
      "{action}",
      "Send ls?"
    )

    act(() => {
      acp.pendingAskQuestion = {
        question_id: "q1",
        questions: [
          {
            id: "sq1",
            question: "Send ls?",
            header: "Confirm",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      }
      acp.triggerSubscribe?.()
    })
    const turnId = vi.mocked(player.beginSpeechStream).mock.calls[0][0]
    expect(getVoiceModeState().phase).toBe("confirming")
    expect(player.beginSpeechStream).toHaveBeenLastCalledWith(
      turnId,
      expect.anything()
    )
    expect(player.enqueueSpeech).toHaveBeenLastCalledWith(turnId, prompt)

    await say("confirm")
    expect(acp.actions.answerQuestion).toHaveBeenCalledTimes(1)
    expect(getVoiceModeState().phase).toBe("waiting")
    delta("Sent. ")
    expect(player.enqueueSpeech).toHaveBeenLastCalledWith(turnId, "Sent.")
  })

  it("does not answer non-confirmation questions by voice", async () => {
    acp.status.set("assistant-conn", "connected")
    await startVoiceMode()

    const otherQ = {
      question_id: "q1",
      questions: [
        {
          id: "sq1",
          question: "Which color?",
          header: "Color",
          options: [{ label: "Red" }, { label: "Blue" }],
        },
      ],
    }

    act(() => {
      acp.pendingAskQuestion = otherQ
      acp.triggerSubscribe?.()
    })

    expect(getVoiceModeState().phase).toBe("listening")
    expect(player.enqueueSpeech).toHaveBeenCalledWith(
      expect.any(String),
      enMessages.VoiceMode.questionOnScreen.replace(
        "{question}",
        "Which color?"
      )
    )

    acp.actions.sendPrompt.mockClear()

    await say("Red")
    expect(acp.actions.answerQuestion).not.toHaveBeenCalled()
    expect(acp.actions.sendPrompt).toHaveBeenCalled()
  })
})
