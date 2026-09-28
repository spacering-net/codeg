"use client"

/**
 * Speech preferences: dictation (input) and read-aloud (output) settings.
 *
 * Stored in localStorage rather than the backend because speech input configuration
 * (microphone access, engine preferences) is per-device. Uses the same reactive
 * pattern as `notification-sound-prefs.ts`: a custom event for the current window
 * plus the native `storage` event for cross-window/tab sync.
 */

import { useSyncExternalStore } from "react"

const PREFS_KEY = "settings:speech:v1"
const PREFS_EVENT = "codeg:speech-prefs-changed"

export type SpeechEnginePreference = "auto" | "browser" | "cloud"

export interface SpeechInputPrefs {
  /** Master switch for speech input. Off by default. */
  enabled: boolean
  /** STT engine preference. */
  engine: SpeechEnginePreference
  /** BCP-47 tag or locale string; empty string means follow UI locale. */
  language: string
}

export interface SpeechOutputPrefs {
  enabled: boolean
  engine: SpeechEnginePreference
  /** `SpeechSynthesisVoice.voiceURI`; empty means the default voice for the language. */
  browserVoiceUri: string
  rate: number
  autoRead: boolean
}

export interface SpeechPrefs {
  input: SpeechInputPrefs
  output: SpeechOutputPrefs
}

export const MIN_SPEECH_RATE = 0.5
export const MAX_SPEECH_RATE = 2

export const DEFAULT_SPEECH_PREFS: SpeechPrefs = {
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
}

function defaultPrefs(): SpeechPrefs {
  return {
    input: { ...DEFAULT_SPEECH_PREFS.input },
    output: { ...DEFAULT_SPEECH_PREFS.output },
  }
}

function isSpeechEnginePreference(
  value: unknown
): value is SpeechEnginePreference {
  return value === "auto" || value === "browser" || value === "cloud"
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

function parseInput(raw: unknown): SpeechInputPrefs {
  const defaults = DEFAULT_SPEECH_PREFS.input
  const source = asRecord(raw)
  if (!source) return { ...defaults }
  return {
    enabled:
      typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
    engine: isSpeechEnginePreference(source.engine)
      ? source.engine
      : defaults.engine,
    language:
      typeof source.language === "string" ? source.language : defaults.language,
  }
}

export function clampSpeechRate(rate: number): number {
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate))
}

function parseOutput(raw: unknown): SpeechOutputPrefs {
  const defaults = DEFAULT_SPEECH_PREFS.output
  const source = asRecord(raw)
  if (!source) return { ...defaults }
  return {
    enabled:
      typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
    engine: isSpeechEnginePreference(source.engine)
      ? source.engine
      : defaults.engine,
    browserVoiceUri:
      typeof source.browserVoiceUri === "string"
        ? source.browserVoiceUri
        : defaults.browserVoiceUri,
    rate:
      typeof source.rate === "number" && Number.isFinite(source.rate)
        ? clampSpeechRate(source.rate)
        : defaults.rate,
    autoRead:
      typeof source.autoRead === "boolean"
        ? source.autoRead
        : defaults.autoRead,
  }
}

/**
 * Merge a stored blob over the defaults, field by field. Every field is
 * validated independently so a partial write from an older build (or a
 * hand-edited value) degrades to the default for that one field instead of
 * discarding the whole preference set.
 */
export function parseSpeechPrefs(raw: unknown): SpeechPrefs {
  const source = asRecord(raw)
  return {
    input: parseInput(source?.input),
    output: parseOutput(source?.output),
  }
}

export function loadSpeechPrefs(): SpeechPrefs {
  if (typeof window === "undefined") return defaultPrefs()
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return defaultPrefs()
    return parseSpeechPrefs(JSON.parse(raw))
  } catch {
    return defaultPrefs()
  }
}

/** Saves a partial update; omitted sections keep their current values. */
export function saveSpeechPrefs(update: {
  input?: SpeechInputPrefs
  output?: SpeechOutputPrefs
}): void {
  if (typeof window === "undefined") return
  const prefs = parseSpeechPrefs({ ...loadSpeechPrefs(), ...update })
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: prefs }))
}

// ── Shared snapshot ──

let snapshot: SpeechPrefs | null = null
const listeners = new Set<() => void>()
let windowBound = false

function bindWindow(): void {
  if (windowBound || typeof window === "undefined") return
  windowBound = true
  const invalidate = () => {
    snapshot = null
    for (const listener of listeners) listener()
  }
  window.addEventListener(PREFS_EVENT, invalidate)
  window.addEventListener("storage", invalidate)
}

/**
 * Current preferences, memoized. Identity only changes when the stored value
 * does, so it is safe as a `useSyncExternalStore` snapshot.
 */
export function getSpeechPrefs(): SpeechPrefs {
  bindWindow()
  if (typeof window === "undefined") return DEFAULT_SPEECH_PREFS
  snapshot ??= loadSpeechPrefs()
  return snapshot
}

/** Subscribe to preference changes from this window or any other. */
export function subscribeSpeechPrefs(onChange: () => void): () => void {
  bindWindow()
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

function getServerSpeechPrefs(): SpeechPrefs {
  return DEFAULT_SPEECH_PREFS
}

/** Reactive read of speech preferences; live across windows. */
export function useSpeechPrefs(): SpeechPrefs {
  return useSyncExternalStore(
    subscribeSpeechPrefs,
    getSpeechPrefs,
    getServerSpeechPrefs
  )
}

/** Test seam: forget the memoized snapshot so the next read hits storage. */
export function resetSpeechPrefsCacheForTests(): void {
  snapshot = null
  windowBound = false
  listeners.clear()
}
