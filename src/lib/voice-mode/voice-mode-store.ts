"use client"

import { useSyncExternalStore } from "react"

import type { AssistantSession } from "@/lib/types"

export type VoiceModePhase =
  | "off"
  | "starting"
  | "listening"
  | "capturing"
  | "transcribing"
  | "waiting"
  | "speaking"
  | "confirming"

export interface VoiceModeState {
  phase: VoiceModePhase
  /** Microphone level, 0..1, in steps of 0.05. */
  level: number
  assistant: AssistantSession | null
  lastSpoken: string | null
  queued: string | null
  error: string | null
}

export interface VoiceModeController {
  start(): void
  stop(): void
}

const INITIAL: VoiceModeState = {
  phase: "off",
  level: 0,
  assistant: null,
  lastSpoken: null,
  queued: null,
  error: null,
}

let state: VoiceModeState = INITIAL
let controller: VoiceModeController | null = null
const listeners = new Set<() => void>()

function update(next: Partial<VoiceModeState>) {
  state = { ...state, ...next }
  for (const listener of [...listeners]) listener()
}

export function getVoiceModeState(): VoiceModeState {
  return state
}

export function subscribeVoiceMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useVoiceModeState(): VoiceModeState {
  return useSyncExternalStore(
    subscribeVoiceMode,
    getVoiceModeState,
    () => INITIAL
  )
}

/** The mounted voice-mode host registers itself here; entry points go through requestVoiceMode. */
export function setVoiceModeController(next: VoiceModeController | null): void {
  controller = next
}

export function requestVoiceMode(on: boolean): void {
  if (on) {
    if (state.phase === "off") controller?.start()
  } else if (state.phase !== "off") {
    controller?.stop()
  }
}

export function setVoicePhase(phase: VoiceModePhase): void {
  if (state.phase !== phase) update({ phase })
}

export function setVoiceLevel(level: number): void {
  const rounded = Math.round(Math.min(1, Math.max(0, level)) * 20) / 20
  if (rounded !== state.level) update({ level: rounded })
}

export function patchVoiceMode(
  next: Partial<Omit<VoiceModeState, "phase" | "level">>
): void {
  update(next)
}

export function resetVoiceMode(): void {
  update({ ...INITIAL, lastSpoken: state.lastSpoken })
}

export function resetVoiceModeStoreForTests(): void {
  state = INITIAL
  controller = null
  listeners.clear()
}
