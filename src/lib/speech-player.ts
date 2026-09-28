"use client"

import { useSyncExternalStore } from "react"

import { speechGetSettings, speechSynthesize } from "@/lib/api"
import { extractAppCommandError } from "@/lib/app-error"
import { chunkSpeakableText, toSpeakableText } from "@/lib/speakable-text"
import type { SpeakableLabels } from "@/lib/speakable-text"
import {
  resolveOutputEngine,
  waitForVoices,
  type OutputEngineResolution,
} from "@/lib/speech-capabilities"
import { getSpeechPrefs } from "@/lib/speech-prefs"

export type SpeechPlayerStatus = "idle" | "loading" | "playing"

export interface SpeechPlayerState {
  playingId: string | null
  status: SpeechPlayerStatus
}

export type SpeechPlaybackError =
  | "auth"
  | "not-configured"
  | "unavailable"
  | "failed"

export interface SpeakOptions {
  /** Omitted: resolved from the saved preference and what this device supports. */
  engine?: "browser" | "cloud"
  language: string
  labels: SpeakableLabels
  onError?: (error: SpeechPlaybackError) => void
}

const BROWSER_CHUNK = 220
const CLOUD_CHUNK = 4000
const IDLE: SpeechPlayerState = { playingId: null, status: "idle" }

let state: SpeechPlayerState = IDLE
let generation = 0
let audio: HTMLAudioElement | null = null
const objectUrls = new Set<string>()
const listeners = new Set<() => void>()
const drainListeners = new Set<() => void>()

interface SpeechStream {
  id: string
  run: number
  options: SpeakOptions
  engine: "browser" | "cloud" | null
  queue: string[]
  ended: boolean
  /** Browser: utterances handed to speechSynthesis and not finished yet. */
  pending: number
  /** Cloud: a fetch/play loop is running. */
  busy: boolean
  prefetch: Promise<string | null> | null
}

let stream: SpeechStream | null = null

function setState(next: SpeechPlayerState) {
  if (next.playingId === state.playingId && next.status === state.status) {
    return
  }
  state = next
  for (const listener of listeners) listener()
}

export function getSpeechPlayerState(): SpeechPlayerState {
  return state
}

export function subscribeSpeechPlayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getServerState(): SpeechPlayerState {
  return IDLE
}

export function useSpeechPlayer(): SpeechPlayerState {
  return useSyncExternalStore(
    subscribeSpeechPlayer,
    getSpeechPlayerState,
    getServerState
  )
}

function revokeAll() {
  for (const url of objectUrls) URL.revokeObjectURL(url)
  objectUrls.clear()
}

export function stopReadAloud(): void {
  if (stream) return
  stopSpeech()
}

export function stopSpeech(): void {
  generation += 1
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
  if (audio) {
    audio.onended = null
    audio.onerror = null
    audio.pause()
    audio.removeAttribute("src")
    audio.load()
  }
  revokeAll()
  stream = null
  setState(IDLE)
}

function classify(error: unknown): SpeechPlaybackError {
  switch (extractAppCommandError(error)?.code) {
    case "authentication_failed":
      return "auth"
    case "configuration_missing":
      return "not-configured"
    default:
      return "failed"
  }
}

function pickVoice(
  voices: SpeechSynthesisVoice[],
  uri: string,
  language: string
): SpeechSynthesisVoice | null {
  if (uri) {
    const chosen = voices.find((voice) => voice.voiceURI === uri)
    if (chosen) return chosen
  }
  const lang = language.toLowerCase()
  const base = lang.split("-")[0]
  return (
    voices.find((voice) => voice.lang.toLowerCase() === lang) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith(base)) ??
    null
  )
}

function speakBrowser(
  id: string,
  chunks: string[],
  options: SpeakOptions,
  run: number
) {
  const synth = window.speechSynthesis
  const { rate, browserVoiceUri } = getSpeechPrefs().output
  const voice = pickVoice(synth.getVoices(), browserVoiceUri, options.language)
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk)
    utterance.lang = options.language
    utterance.rate = rate
    if (voice) utterance.voice = voice
    if (index === 0) {
      utterance.onstart = () => {
        if (run === generation) setState({ playingId: id, status: "playing" })
      }
    }
    if (index === chunks.length - 1) {
      utterance.onend = () => {
        if (run === generation) setState(IDLE)
      }
    }
    utterance.onerror = (event) => {
      if (run !== generation) return
      if (event.error === "interrupted" || event.error === "canceled") return
      stopSpeech()
      options.onError?.("failed")
    }
    synth.speak(utterance)
  })
}

async function fetchChunk(
  chunk: string,
  rate: number,
  run: number
): Promise<string | null> {
  const { audioBase64, mimeType } = await speechSynthesize(chunk, rate)
  if (run !== generation) return null
  const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  objectUrls.add(url)
  return url
}

async function speakCloud(
  id: string,
  chunks: string[],
  options: SpeakOptions,
  run: number
) {
  const { rate } = getSpeechPrefs().output
  audio ??= new Audio()
  const player = audio
  let next = fetchChunk(chunks[0], rate, run)
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const url = await next
      if (url === null || run !== generation) return
      if (index + 1 < chunks.length) {
        next = fetchChunk(chunks[index + 1], rate, run)
        next.catch(() => {})
      }
      await new Promise<void>((resolve, reject) => {
        player.onended = () => resolve()
        player.onerror = () => reject(new Error("audio playback failed"))
        player.src = url
        player.play().then(() => {
          if (run === generation) setState({ playingId: id, status: "playing" })
        }, reject)
      })
      URL.revokeObjectURL(url)
      objectUrls.delete(url)
      if (run !== generation) return
    }
    setState(IDLE)
  } catch (error) {
    if (run !== generation) return
    stopSpeech()
    options.onError?.(classify(error))
  }
}

async function resolvePlaybackEngine(): Promise<OutputEngineResolution> {
  const pref = getSpeechPrefs().output
  const voices = pref.engine === "cloud" ? [] : await waitForVoices()
  const browserTts = voices.length > 0
  let cloudConfigured = false
  if (pref.engine === "cloud" || (pref.engine === "auto" && !browserTts)) {
    cloudConfigured = (await speechGetSettings()).apiKeySet
  }
  return resolveOutputEngine(pref, { browserTts }, cloudConfigured)
}

function start(
  id: string,
  markdown: string,
  engine: "browser" | "cloud",
  options: SpeakOptions,
  run: number
) {
  const text = toSpeakableText(markdown, options.labels)
  const chunks = chunkSpeakableText(
    text,
    engine === "cloud" ? CLOUD_CHUNK : BROWSER_CHUNK
  )
  if (chunks.length === 0) {
    setState(IDLE)
    return
  }
  if (engine === "browser") {
    speakBrowser(id, chunks, options, run)
  } else {
    void speakCloud(id, chunks, options, run)
  }
}

export function speak(id: string, markdown: string, options: SpeakOptions) {
  stopSpeech()
  const run = generation
  setState({ playingId: id, status: "loading" })
  if (options.engine) {
    start(id, markdown, options.engine, options, run)
    return
  }
  resolvePlaybackEngine().then(
    (resolution) => {
      if (run !== generation) return
      if (resolution.engine === null) {
        stopSpeech()
        options.onError?.(
          resolution.reason === "cloud-not-configured"
            ? "not-configured"
            : "unavailable"
        )
        return
      }
      start(id, markdown, resolution.engine, options, run)
    },
    (error: unknown) => {
      if (run !== generation) return
      stopSpeech()
      options.onError?.(classify(error))
    }
  )
}

export interface AutoReadContext {
  contextKey: string
  activeId: string | null
  visibility: DocumentVisibilityState
}

export function maybeAutoRead(
  { contextKey, activeId, visibility }: AutoReadContext,
  text: string,
  options: SpeakOptions
): boolean {
  const { enabled, autoRead } = getSpeechPrefs().output
  if (!enabled || !autoRead) return false
  if (contextKey !== activeId || visibility !== "visible") return false
  if (!text.trim()) return false
  speak(`auto:${contextKey}`, text, options)
  return true
}

/**
 * Live replies: segments arrive while the agent is still writing. A stream
 * plays its segments in order and fires the drained listeners once, after
 * `endSpeechStream` and the last segment. `speak`, `stopSpeech` and a new
 * stream end it without a drained notification.
 */
export function beginSpeechStream(id: string, options: SpeakOptions): void {
  stopSpeech()
  const current: SpeechStream = {
    id,
    run: generation,
    options,
    engine: options.engine ?? null,
    queue: [],
    ended: false,
    pending: 0,
    busy: false,
    prefetch: null,
  }
  stream = current
  setState({ playingId: id, status: "loading" })
  if (current.engine) return
  resolvePlaybackEngine().then(
    (resolution) => {
      if (stream !== current) return
      if (resolution.engine === null) {
        stopSpeech()
        options.onError?.(
          resolution.reason === "cloud-not-configured"
            ? "not-configured"
            : "unavailable"
        )
        return
      }
      current.engine = resolution.engine
      pump(current)
    },
    (error: unknown) => {
      if (stream !== current) return
      stopSpeech()
      options.onError?.(classify(error))
    }
  )
}

export function enqueueSpeech(id: string, text: string): void {
  const current = stream
  if (!current || current.id !== id || current.ended || !text.trim()) return
  current.queue.push(text)
  pump(current)
}

export function endSpeechStream(id: string): void {
  const current = stream
  if (!current || current.id !== id) return
  current.ended = true
  pump(current)
}

export function onSpeechDrained(listener: () => void): () => void {
  drainListeners.add(listener)
  return () => {
    drainListeners.delete(listener)
  }
}

function markStreamPlaying(current: SpeechStream) {
  if (stream === current) setState({ playingId: current.id, status: "playing" })
}

function pump(current: SpeechStream) {
  if (stream !== current || current.engine === null) return
  if (current.engine === "browser") {
    while (current.queue.length > 0) {
      speakStreamSegment(current, current.queue.shift() as string)
    }
    if (current.pending > 0) return
  } else {
    if (current.busy) return
    if (current.queue.length > 0) {
      current.busy = true
      void playCloudStream(current)
      return
    }
  }
  if (!current.ended) return
  stream = null
  setState(IDLE)
  for (const listener of [...drainListeners]) listener()
}

function speakStreamSegment(current: SpeechStream, text: string) {
  const synth = window.speechSynthesis
  const { rate, browserVoiceUri } = getSpeechPrefs().output
  const { language } = current.options
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = language
  utterance.rate = rate
  const voice = pickVoice(synth.getVoices(), browserVoiceUri, language)
  if (voice) utterance.voice = voice
  utterance.onstart = () => markStreamPlaying(current)
  utterance.onend = () => {
    if (stream !== current) return
    current.pending -= 1
    pump(current)
  }
  utterance.onerror = (event) => {
    if (stream !== current) return
    if (event.error === "interrupted" || event.error === "canceled") return
    stopSpeech()
    current.options.onError?.("failed")
  }
  current.pending += 1
  synth.speak(utterance)
}

async function playCloudStream(current: SpeechStream) {
  const { rate } = getSpeechPrefs().output
  audio ??= new Audio()
  const player = audio
  const take = () => {
    const text = current.queue.shift()
    if (text === undefined) return null
    const task = fetchChunk(text, rate, current.run)
    task.catch(() => {})
    return task
  }
  try {
    let next = current.prefetch ?? take()
    current.prefetch = null
    while (next) {
      const url = await next
      if (url === null || stream !== current) return
      current.prefetch = take()
      await new Promise<void>((resolve, reject) => {
        player.onended = () => resolve()
        player.onerror = () => reject(new Error("audio playback failed"))
        player.src = url
        player.play().then(() => markStreamPlaying(current), reject)
      })
      URL.revokeObjectURL(url)
      objectUrls.delete(url)
      if (stream !== current) return
      next = current.prefetch ?? take()
      current.prefetch = null
    }
  } catch (error) {
    if (stream !== current) return
    stopSpeech()
    current.options.onError?.(classify(error))
    return
  }
  current.busy = false
  pump(current)
}

export function resetSpeechPlayerForTests(): void {
  stopSpeech()
  audio = null
  listeners.clear()
  drainListeners.clear()
  state = IDLE
}
