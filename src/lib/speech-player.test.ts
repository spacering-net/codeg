import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const synthesize = vi.fn()
const getSettings = vi.fn()
vi.mock("@/lib/api", () => ({
  speechSynthesize: (...args: unknown[]) => synthesize(...args),
  speechGetSettings: () => getSettings(),
}))

import {
  beginSpeechStream,
  endSpeechStream,
  enqueueSpeech,
  getSpeechPlayerState,
  maybeAutoRead,
  onSpeechDrained,
  resetSpeechPlayerForTests,
  speak,
  stopReadAloud,
  stopSpeech,
  subscribeSpeechPlayer,
} from "./speech-player"
import type { SpeakOptions } from "./speech-player"
import {
  DEFAULT_SPEECH_PREFS,
  resetSpeechPrefsCacheForTests,
  saveSpeechPrefs,
} from "./speech-prefs"

const labels = { codeOmitted: "Code omitted", tableOmitted: "Table omitted" }

class FakeUtterance {
  text: string
  lang = ""
  rate = 1
  voice: unknown = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

class FakeSynth {
  queue: FakeUtterance[] = []
  voices = [{ voiceURI: "v-en", lang: "en-US" }]
  speak = vi.fn((u: FakeUtterance): void => {
    this.queue.push(u)
  })
  cancel = vi.fn(() => {
    this.queue = []
  })
  getVoices = () => this.voices
}

class FakeAudio {
  static instances: FakeAudio[] = []
  src = ""
  paused = true
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  played: string[] = []
  constructor() {
    FakeAudio.instances.push(this)
  }
  play = vi.fn(() => {
    this.paused = false
    this.played.push(this.src)
    return Promise.resolve()
  })
  pause = vi.fn(() => {
    this.paused = true
  })
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = ""
  })
  load = vi.fn()
  finish() {
    this.paused = true
    this.onended?.()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function waitForState(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(
        new Error(
          `state never matched: ${JSON.stringify(getSpeechPlayerState())}`
        )
      )
    }, 1000)
    const unsubscribe = subscribeSpeechPlayer(() => {
      if (!predicate()) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

const audioPayload = { audioBase64: btoa("mp3"), mimeType: "audio/mpeg" }

let synth: FakeSynth
let urlCount = 0
const createObjectURL = vi.fn(() => `blob:${++urlCount}`)
const revokeObjectURL = vi.fn()

const browser: SpeakOptions = { engine: "browser", language: "en-US", labels }
const cloud: SpeakOptions = { engine: "cloud", language: "en-US", labels }

beforeEach(() => {
  localStorage.clear()
  resetSpeechPrefsCacheForTests()
  synth = new FakeSynth()
  FakeAudio.instances = []
  urlCount = 0
  synthesize.mockReset()
  getSettings.mockReset()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  vi.stubGlobal("speechSynthesis", synth)
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance)
  vi.stubGlobal("Audio", FakeAudio)
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }))
  resetSpeechPlayerForTests()
})

afterEach(() => {
  resetSpeechPlayerForTests()
  vi.unstubAllGlobals()
})

describe("browser engine", () => {
  it("queues one utterance per chunk and tracks state until the last ends", () => {
    const long = "First sentence here. ".repeat(20)
    speak("turn-1", long, browser)
    expect(synth.queue.length).toBeGreaterThan(1)
    expect(synth.queue.every((u) => u.text.length <= 220)).toBe(true)
    expect(synth.queue[0].lang).toBe("en-US")
    expect(synth.queue[0].voice).toEqual(synth.voices[0])
    expect(getSpeechPlayerState()).toEqual({
      playingId: "turn-1",
      status: "loading",
    })

    synth.queue[0].onstart?.()
    expect(getSpeechPlayerState().status).toBe("playing")
    synth.queue[0].onend?.()
    expect(getSpeechPlayerState().status).toBe("playing")
    synth.queue[synth.queue.length - 1].onend?.()
    expect(getSpeechPlayerState()).toEqual({ playingId: null, status: "idle" })
  })

  it("stops and reports an error, but ignores interruptions", () => {
    const onError = vi.fn()
    speak("turn-1", "Hello there.", { ...browser, onError })
    synth.queue[0].onerror?.({ error: "interrupted" })
    expect(onError).not.toHaveBeenCalled()
    synth.queue[0].onerror?.({ error: "synthesis-failed" })
    expect(onError).toHaveBeenCalledWith("failed")
    expect(getSpeechPlayerState().status).toBe("idle")
  })

  it("uses the saved rate and voice", () => {
    synth.voices.push({ voiceURI: "v-other", lang: "en-GB" })
    saveSpeechPrefs({
      output: {
        ...DEFAULT_SPEECH_PREFS.output,
        rate: 1.5,
        browserVoiceUri: "v-other",
      },
    })
    speak("turn-1", "Hello.", browser)
    expect(synth.queue[0].rate).toBe(1.5)
    expect(synth.queue[0].voice).toEqual({ voiceURI: "v-other", lang: "en-GB" })
  })

  it("speak while playing stops the previous playback", () => {
    speak("turn-1", "One.", browser)
    speak("turn-2", "Two.", browser)
    expect(synth.cancel).toHaveBeenCalled()
    expect(synth.queue.map((u) => u.text)).toEqual(["Two."])
    expect(getSpeechPlayerState().playingId).toBe("turn-2")
    synth.queue[0].onend?.()
    expect(getSpeechPlayerState().status).toBe("idle")
  })
})

describe("cloud engine", () => {
  it("plays chunks in order, prefetches the next and revokes URLs", async () => {
    const first = deferred<typeof audioPayload>()
    const second = deferred<typeof audioPayload>()
    synthesize
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const text = `${"a".repeat(3000)}. ${"b".repeat(3000)}.`

    speak("turn-1", text, cloud)
    expect(synthesize).toHaveBeenCalledTimes(1)
    first.resolve(audioPayload)
    await waitForState(() => getSpeechPlayerState().status === "playing")

    const audio = FakeAudio.instances[0]
    expect(audio.played).toEqual(["blob:1"])
    expect(synthesize).toHaveBeenCalledTimes(2)
    expect(synthesize.mock.calls[1][1]).toBe(1)

    second.resolve(audioPayload)
    const secondPlay = new Promise<void>((resolve) => {
      audio.play.mockImplementationOnce(() => {
        audio.played.push(audio.src)
        resolve()
        return Promise.resolve()
      })
    })
    audio.finish()
    await secondPlay
    expect(audio.played).toEqual(["blob:1", "blob:2"])
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:1")

    const idle = waitForState(() => getSpeechPlayerState().status === "idle")
    audio.finish()
    await idle
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:2")
    expect(FakeAudio.instances).toHaveLength(1)
  })

  it("stopSpeech mid-fetch discards the late response", async () => {
    const pending = deferred<typeof audioPayload>()
    synthesize.mockReturnValueOnce(pending.promise)
    speak("turn-1", "Hello.", cloud)
    stopSpeech()
    expect(getSpeechPlayerState().status).toBe("idle")
    pending.resolve(audioPayload)
    await pending.promise
    await Promise.resolve()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(FakeAudio.instances[0].play).not.toHaveBeenCalled()
  })

  it("stopSpeech while playing pauses, clears src and revokes URLs", async () => {
    synthesize.mockResolvedValue(audioPayload)
    speak("turn-1", "Hello.", cloud)
    await waitForState(() => getSpeechPlayerState().status === "playing")
    const audio = FakeAudio.instances[0]
    stopSpeech()
    expect(audio.pause).toHaveBeenCalled()
    expect(audio.removeAttribute).toHaveBeenCalledWith("src")
    expect(audio.load).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:1")
    expect(getSpeechPlayerState().status).toBe("idle")
  })

  it("maps an auth failure to the auth error", async () => {
    synthesize.mockRejectedValue({
      code: "authentication_failed",
      message: "no",
    })
    const onError = vi.fn()
    const failed = new Promise<void>((resolve) =>
      onError.mockImplementation(() => resolve())
    )
    speak("turn-1", "Hello.", { ...cloud, onError })
    await failed
    expect(onError).toHaveBeenCalledWith("auth")
    expect(getSpeechPlayerState().status).toBe("idle")
  })
})

describe("engine resolution", () => {
  const auto: SpeakOptions = { language: "en-US", labels }

  it("uses browser voices when the preference is auto", async () => {
    const spoken = new Promise<void>((resolve) =>
      synth.speak.mockImplementationOnce((u: FakeUtterance) => {
        synth.queue.push(u)
        resolve()
      })
    )
    speak("turn-1", "Hello.", auto)
    await spoken
    expect(synth.queue.map((q) => q.text)).toEqual(["Hello."])
    expect(getSettings).not.toHaveBeenCalled()
  })

  it("falls back to cloud when no browser voice exists and a key is set", async () => {
    synth.voices = []
    vi.stubGlobal("speechSynthesis", undefined)
    getSettings.mockResolvedValue({ apiKeySet: true })
    synthesize.mockResolvedValue(audioPayload)
    speak("turn-1", "Hello.", auto)
    await waitForState(() => getSpeechPlayerState().status === "playing")
    expect(synthesize).toHaveBeenCalledWith("Hello.", 1)
  })

  it("reports not-configured when neither engine is usable", async () => {
    vi.stubGlobal("speechSynthesis", undefined)
    getSettings.mockResolvedValue({ apiKeySet: false })
    const onError = vi.fn()
    const failed = new Promise<void>((resolve) =>
      onError.mockImplementation(() => resolve())
    )
    speak("turn-1", "Hello.", { ...auto, onError })
    await failed
    expect(onError).toHaveBeenCalledWith("not-configured")
    expect(getSpeechPlayerState().status).toBe("idle")
  })
})

describe("maybeAutoRead", () => {
  const ctx = {
    contextKey: "tab-1",
    activeId: "tab-1",
    visibility: "visible" as DocumentVisibilityState,
  }

  function enableAutoRead(autoRead = true) {
    saveSpeechPrefs({
      output: { ...DEFAULT_SPEECH_PREFS.output, enabled: true, autoRead },
    })
  }

  it("does nothing when read aloud or auto-read is off", () => {
    expect(maybeAutoRead(ctx, "Hi.", browser)).toBe(false)
    enableAutoRead(false)
    expect(maybeAutoRead(ctx, "Hi.", browser)).toBe(false)
    expect(synth.speak).not.toHaveBeenCalled()
  })

  it("skips background tabs, hidden documents and empty text", () => {
    enableAutoRead()
    expect(maybeAutoRead({ ...ctx, activeId: "tab-2" }, "Hi.", browser)).toBe(
      false
    )
    expect(
      maybeAutoRead({ ...ctx, visibility: "hidden" }, "Hi.", browser)
    ).toBe(false)
    expect(maybeAutoRead(ctx, "  \n ", browser)).toBe(false)
    expect(synth.speak).not.toHaveBeenCalled()
  })

  it("speaks the active visible tab's reply", () => {
    enableAutoRead()
    expect(maybeAutoRead(ctx, "All done.", browser)).toBe(true)
    expect(synth.queue.map((u) => u.text)).toEqual(["All done."])
    expect(getSpeechPlayerState().playingId).toBe("auto:tab-1")
  })
})

describe("streaming", () => {
  it("speaks browser segments in order and drains once after the end", () => {
    const drained = vi.fn()
    const unsubscribe = onSpeechDrained(drained)
    beginSpeechStream("turn-1", browser)
    enqueueSpeech("turn-1", "First sentence.")
    enqueueSpeech("turn-1", "Second sentence.")
    expect(synth.queue.map((u) => u.text)).toEqual([
      "First sentence.",
      "Second sentence.",
    ])

    synth.queue[0].onstart?.()
    expect(getSpeechPlayerState()).toEqual({
      playingId: "turn-1",
      status: "playing",
    })
    synth.queue[0].onend?.()
    endSpeechStream("turn-1")
    expect(drained).not.toHaveBeenCalled()

    synth.queue[1].onend?.()
    expect(drained).toHaveBeenCalledOnce()
    expect(getSpeechPlayerState().status).toBe("idle")
    unsubscribe()
  })

  it("keeps a speech stream alive when read-aloud is stopped", () => {
    beginSpeechStream("turn-1", browser)
    enqueueSpeech("turn-1", "First sentence.")
    synth.queue[0].onstart?.()
    synth.cancel.mockClear()
    stopReadAloud()
    expect(synth.cancel).not.toHaveBeenCalled()
    expect(getSpeechPlayerState().status).toBe("playing")
    stopSpeech()
    stopReadAloud()
    expect(getSpeechPlayerState().status).toBe("idle")
  })

  it("drains immediately when the stream ends with nothing queued", () => {
    const drained = vi.fn()
    onSpeechDrained(drained)
    beginSpeechStream("turn-1", browser)
    endSpeechStream("turn-1")
    expect(drained).toHaveBeenCalledOnce()
  })

  it("ignores segments and ends for a stale stream id", () => {
    const drained = vi.fn()
    onSpeechDrained(drained)
    beginSpeechStream("turn-1", browser)
    beginSpeechStream("turn-2", browser)
    enqueueSpeech("turn-1", "Stale.")
    endSpeechStream("turn-1")
    expect(synth.queue).toEqual([])
    expect(drained).not.toHaveBeenCalled()
  })

  it("stopSpeech mid-stream clears the queue and never drains", () => {
    const drained = vi.fn()
    onSpeechDrained(drained)
    beginSpeechStream("turn-1", browser)
    enqueueSpeech("turn-1", "One.")
    enqueueSpeech("turn-1", "Two.")
    const [first] = synth.queue

    stopSpeech()
    expect(synth.cancel).toHaveBeenCalled()
    first.onend?.()
    endSpeechStream("turn-1")
    enqueueSpeech("turn-1", "Three.")

    expect(synth.queue).toEqual([])
    expect(drained).not.toHaveBeenCalled()
    expect(getSpeechPlayerState().status).toBe("idle")
  })

  it("speak during a stream ends it without draining", () => {
    const drained = vi.fn()
    onSpeechDrained(drained)
    beginSpeechStream("turn-1", browser)
    enqueueSpeech("turn-1", "Streaming.")
    const [streamed] = synth.queue

    speak("msg-1", "A saved reply.", browser)
    streamed.onend?.()
    endSpeechStream("turn-1")

    expect(drained).not.toHaveBeenCalled()
    expect(getSpeechPlayerState().playingId).toBe("msg-1")
  })

  it("keeps a drained listener across stops and later streams", () => {
    const drained = vi.fn()
    onSpeechDrained(drained)
    beginSpeechStream("turn-1", browser)
    stopSpeech()
    beginSpeechStream("turn-2", browser)
    endSpeechStream("turn-2")
    expect(drained).toHaveBeenCalledOnce()
  })

  it("lets a drained listener start the next stream", () => {
    const next = vi.fn(() => {
      beginSpeechStream("turn-2", browser)
      enqueueSpeech("turn-2", "Queued follow-up.")
    })
    const unsubscribe = onSpeechDrained(next)
    beginSpeechStream("turn-1", browser)
    endSpeechStream("turn-1")
    unsubscribe()

    expect(next).toHaveBeenCalledOnce()
    expect(synth.queue.map((u) => u.text)).toEqual(["Queued follow-up."])
    expect(getSpeechPlayerState().playingId).toBe("turn-2")
  })

  it("prefetches the next cloud segment and revokes each URL", async () => {
    const fetches = [
      deferred<typeof audioPayload>(),
      deferred<typeof audioPayload>(),
    ]
    synthesize
      .mockReturnValueOnce(fetches[0].promise)
      .mockReturnValueOnce(fetches[1].promise)
    const drained = vi.fn()
    onSpeechDrained(drained)
    beginSpeechStream("turn-1", cloud)
    enqueueSpeech("turn-1", "First.")
    enqueueSpeech("turn-1", "Second.")
    endSpeechStream("turn-1")
    expect(synthesize).toHaveBeenCalledTimes(1)

    fetches[0].resolve(audioPayload)
    await waitForState(() => getSpeechPlayerState().status === "playing")
    const [player] = FakeAudio.instances
    expect(player.played).toEqual(["blob:1"])
    expect(synthesize).toHaveBeenCalledTimes(2)
    expect(synthesize.mock.calls[1][0]).toBe("Second.")

    fetches[1].resolve(audioPayload)
    const secondPlay = new Promise<void>((resolve) => {
      player.play.mockImplementationOnce(() => {
        player.played.push(player.src)
        resolve()
        return Promise.resolve()
      })
    })
    player.finish()
    await secondPlay
    expect(player.played).toEqual(["blob:1", "blob:2"])
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:1")
    expect(drained).not.toHaveBeenCalled()

    const done = new Promise<void>((resolve) =>
      drained.mockImplementation(resolve)
    )
    player.finish()
    await done
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:2")
    expect(drained).toHaveBeenCalledOnce()
    expect(getSpeechPlayerState().status).toBe("idle")
  })
})
