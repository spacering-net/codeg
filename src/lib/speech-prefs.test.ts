import { beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_SPEECH_PREFS,
  getSpeechPrefs,
  loadSpeechPrefs,
  parseSpeechPrefs,
  resetSpeechPrefsCacheForTests,
  saveSpeechPrefs,
  subscribeSpeechPrefs,
} from "./speech-prefs"

describe("speech preferences", () => {
  beforeEach(() => {
    localStorage.clear()
    resetSpeechPrefsCacheForTests()
  })

  it("defaults to disabled with auto engine and empty language", () => {
    expect(DEFAULT_SPEECH_PREFS).toEqual({
      input: {
        enabled: false,
        engine: "auto",
        language: "",
      },
      output: {
        enabled: false,
        engine: "auto",
        browserVoiceUri: "",
        rate: 1,
        autoRead: false,
      },
    })
    expect(loadSpeechPrefs()).toEqual(DEFAULT_SPEECH_PREFS)
  })

  it("returns a fresh object copy on load to avoid mutating default", () => {
    const loaded = loadSpeechPrefs()
    loaded.input.enabled = true
    expect(DEFAULT_SPEECH_PREFS.input.enabled).toBe(false)
  })

  it("round-trips valid preference changes through save and load", () => {
    const custom = {
      input: {
        enabled: true,
        engine: "cloud" as const,
        language: "zh-CN",
      },
      output: {
        enabled: true,
        engine: "browser" as const,
        browserVoiceUri: "Google US English",
        rate: 1.5,
        autoRead: true,
      },
    }
    saveSpeechPrefs(custom)
    expect(loadSpeechPrefs()).toEqual(custom)
  })

  it("saving one section keeps the other", () => {
    saveSpeechPrefs({
      output: { ...DEFAULT_SPEECH_PREFS.output, enabled: true, rate: 1.25 },
    })
    saveSpeechPrefs({
      input: { enabled: true, engine: "browser", language: "" },
    })
    const loaded = loadSpeechPrefs()
    expect(loaded.input.enabled).toBe(true)
    expect(loaded.output).toEqual({
      ...DEFAULT_SPEECH_PREFS.output,
      enabled: true,
      rate: 1.25,
    })
  })

  it("parses output per field and clamps the rate", () => {
    expect(
      parseSpeechPrefs({
        output: {
          enabled: 1,
          engine: "loud",
          browserVoiceUri: null,
          rate: "fast",
          autoRead: "yes",
        },
      }).output
    ).toEqual(DEFAULT_SPEECH_PREFS.output)
    expect(parseSpeechPrefs({ output: { rate: 9 } }).output.rate).toBe(2)
    expect(parseSpeechPrefs({ output: { rate: 0.1 } }).output.rate).toBe(0.5)
    expect(parseSpeechPrefs({ output: { rate: Number.NaN } }).output.rate).toBe(
      1
    )
  })

  it("falls back per-field for invalid or missing values", () => {
    const parsed = parseSpeechPrefs({
      input: {
        enabled: "yes",
        engine: "invalid-engine",
        language: 12345,
      },
    })
    expect(parsed).toEqual(DEFAULT_SPEECH_PREFS)

    const partial = parseSpeechPrefs({
      input: {
        enabled: true,
        engine: "browser",
      },
    })
    expect(partial.input.enabled).toBe(true)
    expect(partial.input.engine).toBe("browser")
    expect(partial.input.language).toBe("")
  })

  it("falls back to default on corrupt storage JSON", () => {
    localStorage.setItem("settings:speech:v1", "corrupt{json")
    expect(loadSpeechPrefs()).toEqual(DEFAULT_SPEECH_PREFS)
  })

  it("notifies same-window subscribers and invalidates snapshot on save", () => {
    const changes: boolean[] = []
    const unsubscribe = subscribeSpeechPrefs(() => {
      changes.push(getSpeechPrefs().input.enabled)
    })

    saveSpeechPrefs({
      input: {
        enabled: true,
        engine: "auto",
        language: "en-US",
      },
    })

    unsubscribe()
    expect(changes).toEqual([true])
  })

  it("invalidates memoized snapshot on storage event", () => {
    const first = getSpeechPrefs()
    expect(getSpeechPrefs()).toBe(first)

    localStorage.setItem(
      "settings:speech:v1",
      JSON.stringify({
        input: { enabled: true, engine: "cloud", language: "ja-JP" },
      })
    )
    window.dispatchEvent(
      new StorageEvent("storage", { key: "settings:speech:v1" })
    )

    const second = getSpeechPrefs()
    expect(second).not.toBe(first)
    expect(second.input.enabled).toBe(true)
    expect(second.input.engine).toBe("cloud")
    expect(second.input.language).toBe("ja-JP")
  })
})
