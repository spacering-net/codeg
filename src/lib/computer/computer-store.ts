// The panel's view of computer use: which windows are shared, what the helper
// is doing, and what agents did. Fed by the backend's `computer://*` events
// for the life of the window rather than by the popover, which unmounts when
// it closes — an agent reading a window while the popover is shut is exactly
// the line the person should find when they open it.
//
// The activity list collapses runs of the same (window, action, outcome) into
// one line with a count, for the reason the browser's strip does: an agent
// working through a window reads it dozens of times, and forty identical
// lines hide the one that says something else.
//
// A value fetched by a command is only as new as the moment the command
// began; an event that lands while it is in flight is newer. So fetched
// values go through the `…Since` setters with a mark taken before the fetch,
// and are dropped if an event has moved that part of the store since.

import { useSyncExternalStore } from "react"

import { subscribe } from "@/lib/platform"

import {
  askComputerServed,
  computerAvailable,
  subscribeComputerServed,
} from "./computer-api"
import {
  COMPUTER_ACTIVITY_EVENT,
  COMPUTER_BACKEND_STATUS_EVENT,
  COMPUTER_STATE_EVENT,
  type ActivityOutcome,
  type BackendStatus,
  type ComputerAction,
  type ComputerActivityPayload,
  type ComputerStatePayload,
  type SharedApp,
  type SharedScreen,
  type SharedWindow,
} from "./types"

export interface ComputerActivityLine {
  targetId: string
  /** The application, for a line about one rather than a window of it. */
  app?: string
  action: ComputerAction
  outcome: ActivityOutcome
  /** Unix milliseconds of the most recent one. */
  at: number
  /** How many identical attempts this line stands for. */
  count: number
}

export interface ComputerStoreState {
  shared: readonly SharedWindow[]
  /** The applications shared as a whole. */
  sharedApps: readonly SharedApp[]
  /** The entire screen, when it is shared. */
  sharedScreen: SharedScreen | null
  /** Whether `shared` has been told anything yet — by an event or a fetch.
   *  Until then it is empty for want of news, not because nothing is shared
   *  (a grant made before this window loaded is not in it). */
  sharedKnown: boolean
  backend: BackendStatus | null
  activity: readonly ComputerActivityLine[]
}

const ACTIVITY_LIMIT = 50

let state: ComputerStoreState = {
  shared: [],
  sharedApps: [],
  sharedScreen: null,
  sharedKnown: false,
  backend: null,
  activity: [],
}
const listeners = new Set<() => void>()
let started = false
/** Waiting for a server to say it serves computer use. */
let awaitingServed = false
/** Moved by every write to `shared` / `backend`. */
let sharedVersion = 0
let backendVersion = 0

function emit(next: ComputerStoreState) {
  state = next
  for (const listener of listeners) listener()
}

/** The shared windows — and the applications shared as a whole and the
 *  entire screen, when the news carries them (a window's own share answers
 *  with its windows alone). */
export function setComputerShared(
  shared: readonly SharedWindow[],
  sharedApps?: readonly SharedApp[],
  sharedScreen?: SharedScreen | null
): void {
  sharedVersion += 1
  emit({
    ...state,
    shared,
    sharedApps: sharedApps ?? state.sharedApps,
    sharedScreen:
      sharedScreen === undefined ? state.sharedScreen : sharedScreen,
    sharedKnown: true,
  })
}

export function setComputerBackend(backend: BackendStatus): void {
  backendVersion += 1
  emit({ ...state, backend })
}

/** Where the store stands, to hand back to the `…Since` setters. */
export interface ComputerStoreMark {
  shared: number
  backend: number
}

export function computerStoreMark(): ComputerStoreMark {
  return { shared: sharedVersion, backend: backendVersion }
}

/** A fetched list of shared windows, unless something newer has landed since
 *  `mark` was taken. */
export function setComputerSharedSince(
  shared: readonly SharedWindow[],
  mark: ComputerStoreMark
): void {
  if (sharedVersion === mark.shared) setComputerShared(shared)
}

/** A fetched state — windows, applications and the screen — unless
 *  something newer has landed since `mark` was taken. */
export function setComputerStateSince(
  next: ComputerStatePayload,
  mark: ComputerStoreMark
): void {
  if (sharedVersion === mark.shared)
    setComputerShared(next.shared, next.apps ?? [], next.screen ?? null)
}

/** A fetched backend status, unless something newer has landed since `mark`
 *  was taken. */
export function setComputerBackendSince(
  backend: BackendStatus,
  mark: ComputerStoreMark
): void {
  if (backendVersion === mark.backend) setComputerBackend(backend)
}

export function recordComputerActivity(payload: ComputerActivityPayload): void {
  const head = state.activity[0]
  const activity =
    head &&
    head.targetId === payload.targetId &&
    head.app === payload.app &&
    head.action === payload.action &&
    head.outcome === payload.outcome
      ? [
          { ...head, at: payload.at, count: head.count + 1 },
          ...state.activity.slice(1),
        ]
      : [
          { ...payload, count: 1 },
          ...state.activity.slice(0, ACTIVITY_LIMIT - 1),
        ]
  emit({ ...state, activity })
}

/** Empty the activity list: what this window has seen goes, and what agents
 *  do next starts a fresh one. Nothing an agent did is undone. */
export function clearComputerActivity(): void {
  if (state.activity.length === 0) return
  emit({ ...state, activity: [] })
}

/** Start listening, once per window — once it is known to have computer use
 *  at all (a web window asks its server first). */
function ensureStarted() {
  if (started) return
  if (!computerAvailable()) {
    // Started as soon as the server says so — now, or once it is back.
    if (!awaitingServed) {
      awaitingServed = true
      subscribeComputerServed(() => {
        if (computerAvailable()) ensureStarted()
      })
    }
    void askComputerServed()
    return
  }
  started = true
  void subscribe<ComputerStatePayload>(COMPUTER_STATE_EVENT, (p) =>
    setComputerShared(p.shared, p.apps ?? [], p.screen ?? null)
  ).catch(() => {})
  void subscribe<ComputerActivityPayload>(
    COMPUTER_ACTIVITY_EVENT,
    recordComputerActivity
  ).catch(() => {})
  void subscribe<BackendStatus>(
    COMPUTER_BACKEND_STATUS_EVENT,
    setComputerBackend
  ).catch(() => {})
}

function subscribeStore(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useComputerStore(): ComputerStoreState {
  return useSyncExternalStore(
    subscribeStore,
    () => state,
    () => state
  )
}

/** Test-only: back to the initial state, listeners kept. */
export function resetComputerStoreForTest(): void {
  state = {
    shared: [],
    sharedApps: [],
    sharedScreen: null,
    sharedKnown: false,
    backend: null,
    activity: [],
  }
}
