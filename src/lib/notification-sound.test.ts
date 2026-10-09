import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { EventEnvelope } from "./types"
import {
  IDLE_SUSPEND_MS,
  playEventSound,
  previewTone,
  primeNotificationSoundOutput,
  resetNotificationSoundStateForTests,
  soundEventIdForEnvelope,
  withEventSoundsSuppressed,
} from "./notification-sound"
import {
  DEFAULT_NOTIFICATION_SOUND_PREFS,
  saveNotificationSoundPrefs,
  type NotificationSoundPrefs,
} from "./notification-sound-prefs"

// ── Web Audio stub ──
// jsdom ships no AudioContext. This records how many oscillators were actually
// started, which is what "a cue played" means for these tests.

let startedOscillators = 0

class FakeAudioParam {
  value = 0
  setValueAtTime() {
    return this
  }
  linearRampToValueAtTime() {
    return this
  }
  exponentialRampToValueAtTime() {
    return this
  }
}

/**
 * The engine's audio output state, so a test can model the autoplay policy:
 * `"running"` is the permissive engine, `"suspended"` the one that only opens
 * output from inside a user gesture.
 */
let audioState: "running" | "suspended" = "running"
/** When true, `resume()` rejects and leaves output closed. */
let resumeRejects = false
let contextsCreated = 0
/** Notes started and not yet stopped — a cue still audible, in other words. */
let liveOscillators = 0
let stateListeners: Array<() => void> = []
/** How many times the device was handed back to the OS. */
let suspendCalls = 0
/** Oscillators handed out, so a test can let a cue finish sounding. */
let createdOscillators: Array<{ onended: (() => void) | null }> = []

/** The fake audio clock, frozen — nothing here needs time to advance. */
const FAKE_CURRENT_TIME = 0

class FakeAudioContext {
  currentTime = FAKE_CURRENT_TIME
  destination = {}
  constructor() {
    contextsCreated += 1
  }
  get state() {
    return audioState
  }
  addEventListener(type: string, listener: () => void) {
    if (type === "statechange") stateListeners.push(listener)
  }
  createOscillator() {
    let live = false
    const oscillator = {
      type: "sine",
      frequency: { value: 0 },
      onended: null as (() => void) | null,
      connect: () => {},
      disconnect: () => {},
      start: () => {
        startedOscillators += 1
        liveOscillators += 1
        live = true
      },
      // Mirrors the real contract: `stop(when)` with a future time only
      // *schedules* the end, so the note stays audible until then. A bare
      // `stop()` — what cancellation uses — ends it now. The fake clock never
      // advances past FAKE_CURRENT_TIME, so a scheduled end never arrives.
      stop: (when?: number) => {
        if (!live) return
        if (when !== undefined && when > FAKE_CURRENT_TIME) return
        live = false
        liveOscillators -= 1
      },
    }
    createdOscillators.push(oscillator)
    return oscillator
  }
  createGain() {
    return {
      gain: new FakeAudioParam(),
      connect: () => {},
      disconnect: () => {},
    }
  }
  resume() {
    if (resumeRejects) return Promise.reject(new Error("blocked"))
    setOutputState("running")
    return Promise.resolve()
  }
  suspend() {
    suspendCalls += 1
    setOutputState("suspended")
    return Promise.resolve()
  }
}

/** Flip the engine's output state and notify, the way a real context does. */
function setOutputState(next: "running" | "suspended") {
  if (audioState === next) return
  audioState = next
  for (const listener of [...stateListeners]) listener()
}

function installAudioStub() {
  ;(window as unknown as { AudioContext: unknown }).AudioContext =
    FakeAudioContext
}

/** Fire a real user gesture and let the resulting resume promise settle. */
async function userGesture() {
  window.dispatchEvent(new Event("pointerdown"))
  await vi.advanceTimersByTimeAsync(0)
}

/**
 * Let every note handed out finish sounding, the way the audio clock eventually
 * would. `onended` is what retires a note, so this is what "the cue is over"
 * means — and what starts the clock on releasing the device.
 */
function finishCues() {
  const pending = createdOscillators
  createdOscillators = []
  for (const oscillator of pending) oscillator.onended?.()
}

function envelope(payload: Record<string, unknown>): EventEnvelope {
  return { seq: 1, connection_id: "conn-a", ...payload } as EventEnvelope
}

const TURN_COMPLETE = envelope({
  type: "turn_complete",
  session_id: "s",
  stop_reason: "end_turn",
})
const PERMISSION = envelope({
  type: "permission_request",
  request_id: "r",
  tool_call: {},
  options: [],
})

function configure(patch: Partial<NotificationSoundPrefs>) {
  saveNotificationSoundPrefs({
    ...DEFAULT_NOTIFICATION_SOUND_PREFS,
    enabled: true,
    ...patch,
  })
  // Drop the module's cached copy so the next call reads what was just stored.
  resetNotificationSoundStateForTests()
}

describe("soundEventIdForEnvelope", () => {
  it("maps the same five events the chat channels push", () => {
    expect(soundEventIdForEnvelope(TURN_COMPLETE)).toBe("turn_complete")
    expect(soundEventIdForEnvelope(PERMISSION)).toBe("permission_request")
    expect(
      soundEventIdForEnvelope(
        envelope({ type: "question_request", question_id: "q", questions: [] })
      )
    ).toBe("question_request")
    expect(
      soundEventIdForEnvelope(
        envelope({ type: "error", message: "boom", agent_type: "claude_code" })
      )
    ).toBe("error")
    expect(
      soundEventIdForEnvelope(
        envelope({ type: "user_prompt_sent", text_preview: "hi" })
      )
    ).toBe("user_prompt_sent")
  })

  it("only counts a real end of turn", () => {
    // Mirrors the backend feed: intermediate completions (cancel, refusal…)
    // also arrive as turn_complete and must stay silent.
    expect(
      soundEventIdForEnvelope(
        envelope({
          type: "turn_complete",
          session_id: "s",
          stop_reason: "cancelled",
        })
      )
    ).toBeNull()
  })

  it("ignores events with no cue", () => {
    expect(
      soundEventIdForEnvelope(envelope({ type: "content_delta", text: "hi" }))
    ).toBeNull()
  })
})

describe("playEventSound", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T10:00:00Z"))
    localStorage.clear()
    startedOscillators = 0
    liveOscillators = 0
    contextsCreated = 0
    stateListeners = []
    suspendCalls = 0
    createdOscillators = []
    audioState = "running"
    resumeRejects = false
    installAudioStub()
    resetNotificationSoundStateForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetNotificationSoundStateForTests()
  })

  it("stays silent while the master switch is off", () => {
    saveNotificationSoundPrefs(DEFAULT_NOTIFICATION_SOUND_PREFS)
    resetNotificationSoundStateForTests()

    expect(playEventSound(TURN_COMPLETE)).toBe(false)
    expect(startedOscillators).toBe(0)
  })

  it("plays the configured tone once enabled", () => {
    configure({})

    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    expect(startedOscillators).toBeGreaterThan(0)
  })

  it("stays silent for an event whose tone is none", () => {
    // user_prompt_sent ships as `none`: it fires on the user's own action.
    configure({})

    expect(
      playEventSound(envelope({ type: "user_prompt_sent", text_preview: "hi" }))
    ).toBe(false)
    expect(startedOscillators).toBe(0)
  })

  it("collapses a burst of the same event into one cue", () => {
    configure({})

    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    vi.advanceTimersByTime(500)
    expect(playEventSound(TURN_COMPLETE)).toBe(false)
    // Past the cooldown the next one rings again.
    vi.advanceTimersByTime(2000)
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
  })

  it("does not stack two different events into a chord", () => {
    // A failing turn emits `error` and then `turn_complete` back to back.
    configure({})

    expect(playEventSound(PERMISSION)).toBe(true)
    expect(playEventSound(TURN_COMPLETE)).toBe(false)
    vi.advanceTimersByTime(300)
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
  })

  it("stays silent while replaying history", () => {
    configure({})

    const played = withEventSoundsSuppressed(() =>
      playEventSound(TURN_COMPLETE)
    )
    expect(played).toBe(false)
    expect(startedOscillators).toBe(0)
    // Suppression is scoped to the call, not sticky.
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
  })

  it("honours the background-only gate", () => {
    configure({ onlyWhenUnfocused: true })
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true)

    expect(playEventSound(TURN_COMPLETE)).toBe(false)

    hasFocus.mockReturnValue(false)
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    hasFocus.mockRestore()
  })

  it("stays silent at zero volume", () => {
    configure({ volume: 0 })

    expect(playEventSound(TURN_COMPLETE)).toBe(false)
    expect(startedOscillators).toBe(0)
  })

  // ── Autoplay policy ──
  // Engines that only open audio from inside a user gesture are the whole
  // reason for the unlock machinery: `currentTime` is frozen while a context
  // is suspended, so anything scheduled then fires whenever it finally
  // resumes — on the user's next click, long after the turn it belonged to.

  it("schedules nothing while audio output is still closed", async () => {
    audioState = "suspended"
    configure({})

    expect(playEventSound(TURN_COMPLETE)).toBe(false)
    expect(startedOscillators).toBe(0)

    // No cooldown was spent on the cue nobody heard, so the next event after
    // the unlock rings rather than being swallowed as a "repeat".
    await userGesture()
    expect(audioState).toBe("running")
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    expect(startedOscillators).toBeGreaterThan(0)
  })

  it("opens output on a gesture that happens before the first event", async () => {
    // The workspace arms this on mount; an ordinary click then unlocks audio
    // ahead of any agent event, so the session's first cue is not lost.
    audioState = "suspended"
    configure({})
    const teardown = primeNotificationSoundOutput()

    await userGesture()
    expect(contextsCreated).toBe(1)
    expect(audioState).toBe("running")

    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    expect(startedOscillators).toBeGreaterThan(0)
    teardown()
  })

  it("keeps retrying after a gesture whose resume was refused", async () => {
    // A one-shot listener would burn the unlock on the first failed attempt
    // and leave the window permanently silent.
    audioState = "suspended"
    resumeRejects = true
    configure({})
    const teardown = primeNotificationSoundOutput()

    await userGesture()
    expect(audioState).toBe("suspended")
    expect(playEventSound(TURN_COMPLETE)).toBe(false)

    resumeRejects = false
    await userGesture()
    expect(audioState).toBe("running")
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    teardown()
  })

  it("creates no audio context while sounds are disabled", async () => {
    audioState = "suspended"
    saveNotificationSoundPrefs(DEFAULT_NOTIFICATION_SOUND_PREFS)
    resetNotificationSoundStateForTests()
    const teardown = primeNotificationSoundOutput()

    await userGesture()
    expect(contextsCreated).toBe(0)
    teardown()
  })

  it("silences a cue that output closure interrupted", async () => {
    // `alert` is three pulses over ~0.4s. If the OS takes audio away after the
    // first (a call, a backgrounded tab), the rest must not surface on resume.
    configure({
      tones: {
        ...DEFAULT_NOTIFICATION_SOUND_PREFS.tones,
        turn_complete: "alert",
      },
    })

    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    expect(liveOscillators).toBeGreaterThan(0)

    setOutputState("suspended")
    expect(liveOscillators).toBe(0)
  })

  it("re-arms the unlock the moment output closes, not at the next event", async () => {
    // Backgrounding is exactly when the cue matters, so returning to the
    // window must reopen output on its own — waiting for an event to notice
    // would spend that event discovering the problem.
    configure({})
    expect(playEventSound(TURN_COMPLETE)).toBe(true)

    setOutputState("suspended")
    await userGesture()
    expect(audioState).toBe("running")

    vi.advanceTimersByTime(2000)
    startedOscillators = 0
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    expect(startedOscillators).toBeGreaterThan(0)
  })

  it("previews from a gesture even when the context starts suspended", async () => {
    // The preview button IS the gesture, so unlike an event cue it may wait
    // for `resume()` and play once output opens.
    audioState = "suspended"
    configure({})

    expect(previewTone("chime", 0.6)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(startedOscillators).toBeGreaterThan(0)
  })

  it("picks up a preference change without a reload", () => {
    configure({})
    expect(playEventSound(TURN_COMPLETE)).toBe(true)

    // Settings window turns it off; the storage notification invalidates the
    // player's cached copy in this window.
    saveNotificationSoundPrefs({
      ...DEFAULT_NOTIFICATION_SOUND_PREFS,
      enabled: false,
    })
    vi.advanceTimersByTime(5000)
    expect(playEventSound(TURN_COMPLETE)).toBe(false)
  })

  // A running context holds the OS audio device open even while it plays
  // nothing: on macOS the speaker stream takes a `PreventUserIdleSystemSleep`
  // assertion for as long as it runs and `coreaudiod` never idles. An app that
  // waits hours between two cues must not pay that for its whole lifetime.

  it("hands the audio device back once a cue has finished sounding", () => {
    configure({})
    expect(playEventSound(TURN_COMPLETE)).toBe(true)

    finishCues()
    // Grace period first: a release must never straddle the tail of a cue.
    vi.advanceTimersByTime(IDLE_SUSPEND_MS - 1)
    expect(suspendCalls).toBe(0)

    vi.advanceTimersByTime(1)
    expect(suspendCalls).toBe(1)
    expect(audioState).toBe("suspended")
  })

  it("keeps output open while a cue is still sounding", () => {
    configure({})
    expect(playEventSound(TURN_COMPLETE)).toBe(true)

    // No `finishCues()`: the notes are still in flight, so no release is armed
    // at all — advancing well past the grace period must not suspend them.
    vi.advanceTimersByTime(IDLE_SUSPEND_MS * 3)
    expect(suspendCalls).toBe(0)
    expect(audioState).toBe("running")
  })

  it("cancels a pending release when the next cue arrives", () => {
    configure({})
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    finishCues()

    // Still inside the grace period when the next event lands.
    vi.advanceTimersByTime(1000)
    expect(playEventSound(PERMISSION)).toBe(true)

    // The release armed for the first cue must not fire underneath the second.
    vi.advanceTimersByTime(IDLE_SUSPEND_MS)
    expect(suspendCalls).toBe(0)
    expect(audioState).toBe("running")
  })

  it("reopens output on the next gesture after the device was released", async () => {
    // Releasing the device must not leave the window permanently silent: the
    // statechange re-arms the unlock, so the user's ordinary next click opens
    // output ahead of the event that needs it.
    configure({})
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    finishCues()

    vi.advanceTimersByTime(IDLE_SUSPEND_MS)
    expect(suspendCalls).toBe(1)
    expect(audioState).toBe("suspended")

    await userGesture()
    expect(audioState).toBe("running")

    vi.advanceTimersByTime(2000)
    startedOscillators = 0
    expect(playEventSound(TURN_COMPLETE)).toBe(true)
    expect(startedOscillators).toBeGreaterThan(0)
  })

  it("leaves a context it never opened alone", () => {
    // Sounds off: nothing was ever created, so there is no device to release
    // and no timer to leak.
    saveNotificationSoundPrefs(DEFAULT_NOTIFICATION_SOUND_PREFS)
    resetNotificationSoundStateForTests()

    expect(playEventSound(TURN_COMPLETE)).toBe(false)
    vi.advanceTimersByTime(IDLE_SUSPEND_MS * 2)
    expect(suspendCalls).toBe(0)
    expect(contextsCreated).toBe(0)
  })
})
