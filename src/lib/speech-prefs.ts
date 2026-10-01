"use client"

/**
 * Speech preferences: speech-to-text input configuration including engine choice
 * and language selection.
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

export interface SpeechPrefs {
  input: SpeechInputPrefs
}

export const DEFAULT_SPEECH_PREFS: SpeechPrefs = {
  input: {
    enabled: false,
    engine: "auto",
    language: "",
  },
}

function isSpeechEnginePreference(
  value: unknown
): value is SpeechEnginePreference {
  return value === "auto" || value === "browser" || value === "cloud"
}

/**
 * Merge a stored blob over the defaults, field by field. Every field is
 * validated independently so a partial write from an older build (or a
 * hand-edited value) degrades to the default for that one field instead of
 * discarding the whole preference set.
 */
export function parseSpeechPrefs(raw: unknown): SpeechPrefs {
  const defaults = DEFAULT_SPEECH_PREFS
  if (!raw || typeof raw !== "object") {
    return { input: { ...defaults.input } }
  }
  const source = raw as Record<string, unknown>

  const rawInput = source.input
  if (!rawInput || typeof rawInput !== "object") {
    return { input: { ...defaults.input } }
  }
  const inputSource = rawInput as Record<string, unknown>

  return {
    input: {
      enabled:
        typeof inputSource.enabled === "boolean"
          ? inputSource.enabled
          : defaults.input.enabled,
      engine: isSpeechEnginePreference(inputSource.engine)
        ? inputSource.engine
        : defaults.input.engine,
      language:
        typeof inputSource.language === "string"
          ? inputSource.language
          : defaults.input.language,
    },
  }
}

export function loadSpeechPrefs(): SpeechPrefs {
  const defaults = DEFAULT_SPEECH_PREFS
  if (typeof window === "undefined") {
    return { input: { ...defaults.input } }
  }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { input: { ...defaults.input } }
    return parseSpeechPrefs(JSON.parse(raw))
  } catch {
    return { input: { ...defaults.input } }
  }
}

export function saveSpeechPrefs(prefs: SpeechPrefs): void {
  if (typeof window === "undefined") return
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
