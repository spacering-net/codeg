"use client"

/**
 * Audible cues for agent events.
 *
 * Same trigger catalogue as the chat-channel Events tab — the events a user
 * already configures for IM/webhook pushes also drive a local sound, chosen
 * per event in Settings → General (`notification-sound-settings.tsx`).
 *
 * Tones are synthesized with the Web Audio API instead of shipping audio
 * files: no binary assets, no asset-path/CSP differences between the Tauri
 * webview, the static web build and a remote-workspace window, and each cue
 * stays a few hundred bytes of oscillator envelope.
 */

import type { EventEnvelope } from "./types"
import {
  getNotificationSoundPrefs,
  resetNotificationSoundPrefsCacheForTests,
  subscribeNotificationSoundPrefs,
  type SoundEventId,
  type SoundToneId,
} from "./notification-sound-prefs"

/**
 * Per-event cooldown. Collapses a burst of the same event (several agents
 * finishing at once) into one cue. Deliberately short: two genuinely separate
 * gates a few seconds apart should each ring. Nothing is lost when a cue is
 * dropped — the event still lands in the UI; only the sound is skipped.
 */
const PER_EVENT_COOLDOWN_MS = 1500

/**
 * Floor between any two cues, regardless of event. Keeps back-to-back events
 * (a failing turn emits `error` and then `turn_complete`) from stacking two
 * tones into a chord. First one wins.
 */
const GLOBAL_MIN_GAP_MS = 250

interface ToneStep {
  /** Hz. */
  freq: number
  /** Seconds after the cue starts. */
  at: number
  /** Seconds; the note's full attack+decay. */
  duration: number
  type: OscillatorType
  /** Relative level, scaled by the user's volume. */
  level: number
}

/**
 * Voicings for the built-in tones. Kept as plain data so the set can grow
 * without touching the player. `none` has no entry — it is the "silent"
 * sentinel and never reaches the player.
 */
const TONE_STEPS: Record<Exclude<SoundToneId, "none">, ToneStep[]> = {
  // Two rising notes (A5 → E6) — the "finished, come look" cue.
  chime: [
    { freq: 880, at: 0, duration: 0.16, type: "sine", level: 1 },
    { freq: 1318.5, at: 0.1, duration: 0.3, type: "sine", level: 0.9 },
  ],
  // Single bell: C6 with a quiet octave above it for a metallic edge.
  ding: [
    { freq: 1046.5, at: 0, duration: 0.42, type: "sine", level: 1 },
    { freq: 2093, at: 0, duration: 0.22, type: "sine", level: 0.22 },
  ],
  // Short and unobtrusive.
  blip: [{ freq: 784, at: 0, duration: 0.1, type: "triangle", level: 0.9 }],
  pop: [{ freq: 660, at: 0, duration: 0.07, type: "sine", level: 0.9 }],
  // Three repeats — reads as "you are blocking something".
  alert: [
    { freq: 988, at: 0, duration: 0.09, type: "triangle", level: 0.75 },
    { freq: 988, at: 0.14, duration: 0.09, type: "triangle", level: 0.75 },
    { freq: 988, at: 0.28, duration: 0.14, type: "triangle", level: 0.75 },
  ],
  // Two falling notes (D5 → G4) — the conventional "something went wrong".
  descend: [
    { freq: 587.3, at: 0, duration: 0.16, type: "sine", level: 1 },
    { freq: 392, at: 0.12, duration: 0.34, type: "sine", level: 0.9 },
  ],
}

// ── Audio context ──
//
// Autoplay policy: a page may only open audio output from inside a user
// gesture. That splits every caller in two, and the split is what the code
// below is organised around:
//
//   - `previewTone` runs INSIDE a gesture (the Settings buttons). It may wait
//     on `resume()`, because the surrounding click is exactly what allows the
//     context to start.
//   - `playEventSound` never does. It must refuse to schedule while output is
//     closed: a blocked `resume()` does not fail fast, it stays pending until
//     the user's next click — and `currentTime` is frozen meanwhile, so
//     anything scheduled would fire *then*, minutes late and attached to an
//     unrelated action.

type AudioContextCtor = new () => AudioContext

let context: AudioContext | null = null
/** Detach handle while gesture listeners are armed; null when they are not. */
let unlockDetach: (() => void) | null = null

/**
 * Grace period after the last cue finished before output is handed back.
 *
 * A *running* context keeps the OS audio device open even while it is playing
 * nothing. On macOS the speaker stream takes a `PreventUserIdleSystemSleep`
 * assertion for as long as it runs and `coreaudiod` never gets to idle —
 * measured at ~6% of a core, continuously, for the whole life of the app. An
 * app that sits for minutes or hours between two cues pays that for nothing.
 *
 * So a cue that has finished sounding releases the device instead of holding it
 * until the window closes, and the next cue (or the next user gesture — see
 * `armUnlockOnGesture`) reopens output.
 *
 * The grace period exists so that a run of cues — and the tail of the one still
 * sounding — never straddles a release: a cue arriving inside it cancels the
 * release outright.
 *
 * The cost is the already-documented closed-output case: an event that lands
 * after the device was handed back is dropped if no gesture has reopened output
 * yet. That loses no cooldown, so the following cue still rings — but it is a
 * real trade, and the reason this is a grace period rather than an immediate
 * suspend. Five minutes keeps it well clear of a turn being read on screen
 * while still reclaiming the device for the idle rest of the session.
 */
export const IDLE_SUSPEND_MS = 5 * 60 * 1000

/** Pending release of the audio device; null when none is armed. */
let suspendTimer: ReturnType<typeof setTimeout> | null = null

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

function getAudioContext(): AudioContext | null {
  if (context) return context
  const Ctor = audioContextCtor()
  if (!Ctor) return null
  try {
    context = new Ctor()
  } catch {
    return null
  }
  watchOutputState(context)
  return context
}

/**
 * React to output closing under us — the tab is backgrounded, iOS hands audio
 * to a phone call, the engine suspends an idle context.
 *
 * Two things must happen the moment that occurs, and neither can wait for the
 * next agent event (that event is precisely the cue we would lose):
 *   - anything still scheduled is cancelled. `currentTime` freezes while
 *     suspended, so a half-played cue would otherwise finish on resume, long
 *     after the turn it belonged to.
 *   - the gesture listeners are re-armed, so returning to the window reopens
 *     output before the next event needs it.
 */
function watchOutputState(ctx: AudioContext): void {
  ctx.addEventListener("statechange", () => {
    if (ctx.state === "running") return
    cancelScheduledCues()
    if (getNotificationSoundPrefs().enabled) armUnlockOnGesture()
  })
}

function disarmUnlock(): void {
  unlockDetach?.()
  unlockDetach = null
}

/**
 * Wait for a user gesture and use it to open audio output.
 *
 * The listeners are deliberately NOT `{ once: true }` and are removed only
 * once the context reports `running`. A `resume()` that rejects or quietly
 * does nothing (WebKit, a gesture the engine doesn't count) must leave the
 * next gesture free to retry — a one-shot listener would burn the unlock on
 * the first failed attempt and leave the window permanently silent.
 *
 * The context is created inside the handler rather than beforehand: on WebKit
 * constructing it within a gesture is itself the unlock, and a user who never
 * enables sounds never pays for an audio thread.
 */
function armUnlockOnGesture(): void {
  if (unlockDetach || typeof window === "undefined") return

  const onGesture = () => {
    const ctx = getAudioContext()
    // No Web Audio at all, or already open — nothing left to wait for.
    if (!ctx || ctx.state === "running") {
      disarmUnlock()
      return
    }
    void ctx.resume().then(
      () => {
        if (ctx.state === "running") disarmUnlock()
      },
      () => {}
    )
  }

  const types = ["pointerdown", "keydown", "touchstart"] as const
  for (const type of types) {
    window.addEventListener(type, onGesture, { passive: true })
  }
  unlockDetach = () => {
    for (const type of types) {
      window.removeEventListener(type, onGesture)
    }
  }
}

/**
 * Start watching for the gesture that opens audio output, so the user's
 * ordinary first click in the workspace unlocks it *before* an agent event
 * needs it. Without this the session's first cue is lost on engines that
 * require a gesture (the Settings preview cannot help — Settings is a separate
 * window, with its own audio context).
 *
 * Re-evaluated whenever the preferences change, so switching sounds on
 * mid-session arms it too. Returns a teardown for the caller's effect.
 */
export function primeNotificationSoundOutput(): () => void {
  const sync = () => {
    if (getNotificationSoundPrefs().enabled) {
      armUnlockOnGesture()
    } else {
      disarmUnlock()
    }
  }
  sync()
  return subscribeNotificationSoundPrefs(sync)
}

// ── Playback ──

interface PreparedTone {
  ctx: AudioContext
  steps: ToneStep[]
  level: number
}

/** Resolve a tone request to everything needed to schedule it, or null. */
function prepareTone(tone: SoundToneId, volume: number): PreparedTone | null {
  if (tone === "none") return null
  const steps = TONE_STEPS[tone]
  if (!steps) return null
  const level = Math.min(1, Math.max(0, volume))
  if (level <= 0) return null
  const ctx = getAudioContext()
  if (!ctx) return null
  return { ctx, steps, level }
}

/**
 * Notes scheduled but not yet finished. Tracked only so `cancelScheduledCues`
 * can silence a cue that output closure interrupted; a note that plays out
 * normally retires itself via `onended`.
 */
const scheduledNotes = new Set<{
  oscillator: OscillatorNode
  gain: GainNode
}>()

type ScheduledNote = typeof scheduledNotes extends Set<infer T> ? T : never

function retireNote(note: ScheduledNote): void {
  scheduledNotes.delete(note)
  try {
    note.oscillator.disconnect()
    note.gain.disconnect()
  } catch {
    /* already torn down */
  }
  // Last note of the cue: nothing is sounding any more, so start the clock on
  // handing the audio device back.
  if (scheduledNotes.size === 0) scheduleIdleSuspend()
}

/** Silence every note still in flight. Idempotent. */
function cancelScheduledCues(): void {
  for (const note of [...scheduledNotes]) {
    try {
      // Disconnecting is what actually guarantees silence — a stop() time on
      // a frozen clock may never be reached.
      note.oscillator.stop()
    } catch {
      /* never started, or already stopped */
    }
    retireNote(note)
  }
}

function clearIdleSuspend(): void {
  if (suspendTimer === null) return
  clearTimeout(suspendTimer)
  suspendTimer = null
}

/**
 * Hand the audio device back now that nothing is sounding. A no-op while output
 * is closed already — there is nothing to give up.
 */
function scheduleIdleSuspend(): void {
  const ctx = context
  if (!ctx || ctx.state !== "running") return
  clearIdleSuspend()
  suspendTimer = setTimeout(() => {
    suspendTimer = null
    // A cue scheduled after this was armed keeps output open; it arms its own
    // release when it finishes.
    if (ctx.state !== "running" || scheduledNotes.size > 0) return
    try {
      // The statechange this raises is what re-arms the gesture unlock, so the
      // next interaction reopens output ahead of the event that needs it.
      void ctx.suspend().then(undefined, () => {})
    } catch {
      /* an engine without suspend() has no device to give back */
    }
  }, IDLE_SUSPEND_MS)
}

/** Schedule one tone's oscillators on a context that is already running. */
function scheduleTone({ ctx, steps, level }: PreparedTone): boolean {
  try {
    // A cue is on its way: cancel any pending release of the device, so the
    // notes below are not suspended out from under themselves.
    clearIdleSuspend()
    const start = ctx.currentTime
    for (const step of steps) {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = step.type
      oscillator.frequency.value = step.freq

      const from = start + step.at
      const to = from + step.duration
      const peak = Math.max(0.0001, level * step.level * 0.3)
      // Ramp in over a few ms — a step from 0 to peak clicks.
      gain.gain.setValueAtTime(0.0001, from)
      gain.gain.linearRampToValueAtTime(peak, from + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, to)

      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(from)
      oscillator.stop(to + 0.02)

      const note = { oscillator, gain }
      scheduledNotes.add(note)
      oscillator.onended = () => retireNote(note)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Play a tone from a user gesture — the Settings preview buttons.
 *
 * Unlike an event cue this may wait on `resume()`: the click that got us here
 * is what allows output to open, so the promise lands within a frame or two.
 * Returns false only when there is nothing to play (no Web Audio, `none`, or
 * zero volume).
 */
export function previewTone(tone: SoundToneId, volume: number): boolean {
  const prepared = prepareTone(tone, volume)
  if (!prepared) return false
  if (prepared.ctx.state === "running") return scheduleTone(prepared)

  // Freshly created, or suspended by a previous block. Keep listening in case
  // this gesture doesn't count, and play as soon as output opens.
  armUnlockOnGesture()
  void prepared.ctx.resume().then(
    () => {
      if (prepared.ctx.state === "running") scheduleTone(prepared)
    },
    () => {}
  )
  return true
}

// ── Event → cue ──

/**
 * Which sound event (if any) an ACP envelope stands for. Mirrors the
 * backend's `parse_acp_event` so the Settings rows mean the same thing here
 * as they do for channel pushes — including the `end_turn` gate, which keeps
 * intermediate turn completions (cancelled, refusal, …) silent.
 */
export function soundEventIdForEnvelope(e: EventEnvelope): SoundEventId | null {
  switch (e.type) {
    case "turn_complete":
      return e.stop_reason === "end_turn" ? "turn_complete" : null
    case "permission_request":
      return "permission_request"
    case "question_request":
      return "question_request"
    case "error":
      return "error"
    case "user_prompt_sent":
      return "user_prompt_sent"
    default:
      return null
  }
}

// ── Gating ──

const lastPlayedAt = new Map<SoundEventId, number>()
let lastAnyPlayedAt = 0
let suppressDepth = 0

/**
 * Run `fn` with event cues muted. Used for snapshot replay: catching up on a
 * gap after a reconnect re-delivers events that already happened, and history
 * should not make noise.
 */
export function withEventSoundsSuppressed<T>(fn: () => T): T {
  suppressDepth += 1
  try {
    return fn()
  } finally {
    suppressDepth -= 1
  }
}

/** Whether the window is currently focused; used by the background-only gate. */
function windowFocused(): boolean {
  if (typeof document === "undefined") return false
  return typeof document.hasFocus === "function" ? document.hasFocus() : true
}

/**
 * Play the cue configured for `envelope`, if any. Safe to call for every ACP
 * event: non-cue events, a disabled master switch and `none` tones all return
 * false without touching the audio device.
 */
export function playEventSound(envelope: EventEnvelope): boolean {
  if (suppressDepth > 0) return false
  const eventId = soundEventIdForEnvelope(envelope)
  if (!eventId) return false

  // Memoized in the prefs module and invalidated on write, so this stays a
  // map lookup on the hot ACP event path rather than a JSON parse per event.
  const settings = getNotificationSoundPrefs()
  if (!settings.enabled) return false
  const tone = settings.tones[eventId]
  if (!tone || tone === "none") return false
  if (settings.onlyWhenUnfocused && windowFocused()) return false

  const now = Date.now()
  const last = lastPlayedAt.get(eventId)
  if (last !== undefined && now - last < PER_EVENT_COOLDOWN_MS) return false
  if (now - lastAnyPlayedAt < GLOBAL_MIN_GAP_MS) return false

  const prepared = prepareTone(tone, settings.volume)
  if (!prepared) return false

  // Output is still closed (autoplay policy, or the engine suspended us in the
  // background). Scheduling now would queue a cue against a frozen clock that
  // fires on the user's next click — long after the turn it belongs to. Wait
  // for a gesture instead, and report "not played" so no cooldown is spent on
  // a sound nobody heard.
  if (prepared.ctx.state !== "running") {
    armUnlockOnGesture()
    return false
  }

  if (!scheduleTone(prepared)) return false
  lastPlayedAt.set(eventId, now)
  lastAnyPlayedAt = now
  return true
}

/** Test seam: drop the cached preferences and the cooldown history. */
export function resetNotificationSoundStateForTests(): void {
  resetNotificationSoundPrefsCacheForTests()
  clearIdleSuspend()
  lastPlayedAt.clear()
  lastAnyPlayedAt = 0
  suppressDepth = 0
  disarmUnlock()
  scheduledNotes.clear()
  context = null
}
