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
    }
    saveSpeechPrefs(custom)
    expect(loadSpeechPrefs()).toEqual(custom)
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
