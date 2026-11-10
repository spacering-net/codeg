"use client"

/**
 * Remembers which slash commands each agent last advertised in each folder, so
 * a transcript can badge a sent `/review` before the agent has advertised
 * anything on its current connection.
 *
 * A bare `/word` in a sent message is a command badge only when the agent
 * offers that command (see `KnownInvocations`), and the live list exists only
 * once a connection's handshake delivers it. Opening a conversation, a restart
 * and every reconnect all show the transcript first and the list a moment
 * later, so without this record a command badge would start out as text and
 * turn into a badge under the reader, or drop to text and come back across a
 * reconnect. With it, the list this agent last advertised in this folder stands
 * in until the live one replaces it.
 *
 * Keyed by agent AND folder: what an agent offers depends on the folder
 * (project commands and skills live in it), so one folder's list says nothing
 * about another's. A folder an agent has never advertised in has no entry, and
 * badges nothing until the agent advertises there.
 *
 * REPLACED, never merged (unlike `model-label-store`): a badge says the agent
 * offers the command now, so a command it stopped advertising should stop
 * being one. Only names are kept, because a badge checks nothing else.
 *
 * Persisted, because a restart is the case that needs it most, as one
 * localStorage key per agent and folder. Every window of the app shares that
 * storage, and a single record that each window read, changed and wrote back
 * would let two windows recording different folders at once drop one of them;
 * with a key per entry they never write the same key unless they are recording
 * the same thing. A `storage` event brings the other windows' copies up to
 * date. The total is capped, dropping the folder advertised least recently
 * first: it shares the origin's quota with every draft.
 *
 * `Map`, not a plain object, for the reason `model-label-store` gives: agent
 * types and folder paths are strings codeg does not choose.
 */

import type { AvailableCommandInfo } from "@/lib/types"

/** Each entry's key: this prefix, then `[agentType, folder]` as JSON. */
const KEY_PREFIX = "codeg:advertised-commands:"

/**
 * At most this many characters across every entry's key and value: room for
 * the lists of dozens of folders, and a small share of the origin's quota,
 * which every draft also draws on.
 */
export const MAX_STORED_CHARS = 64 * 1024

/** What a badge checks: each command's name, exactly as advertised. */
export type AdvertisedCommands = readonly Pick<AvailableCommandInfo, "name">[]

interface Entry {
  readonly commands: AdvertisedCommands
  /** When it was last advertised (ms since the epoch); orders eviction. */
  readonly at: number
}

/** This window's copy, by storage key. */
let entries: Map<string, Entry> | null = null
const listeners = new Set<() => void>()
let windowBound = false

function storageKeyOf(agentType: string, folder: string): string {
  return KEY_PREFIX + JSON.stringify([agentType, folder])
}

function sameNames(a: AdvertisedCommands, b: AdvertisedCommands): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((command, index) => command.name === b[index].name)
}

function namesOf(names: readonly unknown[]): AdvertisedCommands {
  const seen = new Set<string>()
  const out: Pick<AvailableCommandInfo, "name">[] = []
  for (const name of names) {
    if (typeof name !== "string" || !name || seen.has(name)) continue
    seen.add(name)
    out.push({ name })
  }
  return out
}

/**
 * One stored value, or null when it is not `{at, commands: [name]}`.
 *
 * localStorage is shared with every other codeg instance on this machine and
 * survives downgrades, so a stored value is untrusted input: anything else
 * reads as "nothing remembered" instead of reaching the parser of a sent
 * message.
 *
 * `previous` lends its list when the names did not change, so re-reading an
 * entry (another window re-stamped it) hands its readers the same snapshot and
 * re-renders nothing.
 */
function parseValue(raw: string | null, previous: Entry | undefined) {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const { at, commands } = value as Record<string, unknown>
  if (typeof at !== "number" || !Number.isFinite(at)) return null
  if (!Array.isArray(commands)) return null
  const names = namesOf(commands)
  const entry: Entry = {
    at,
    commands:
      previous && sameNames(previous.commands, names)
        ? previous.commands
        : names,
  }
  return entry
}

function storedValue(entry: Entry): string {
  return JSON.stringify({
    at: entry.at,
    commands: entry.commands.map((command) => command.name),
  })
}

/** Every key this module may have written, or `undefined` when storage
 *  cannot be read at all. */
function storedKeys(): string[] | undefined {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(KEY_PREFIX)) keys.push(key)
    }
    return keys
  } catch {
    return undefined
  }
}

/** One stored value, or `undefined` when storage cannot be read. */
function readStored(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key)
  } catch {
    return undefined
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* quota / private mode — this window's copy still serves it */
  }
}

function removeStored(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* nothing to do: the entry simply stays */
  }
}

/** Every stored entry, or `undefined` when storage cannot be read in full:
 *  a copy missing what it failed to read would pass for one where it is gone. */
function readAll(previous: Map<string, Entry> | null) {
  const keys = storedKeys()
  if (!keys) return undefined
  const out = new Map<string, Entry>()
  for (const key of keys) {
    const raw = readStored(key)
    if (raw === undefined) return undefined
    const entry = parseValue(raw, previous?.get(key))
    if (entry) out.set(key, entry)
  }
  return out
}

function notify() {
  for (const listener of listeners) listener()
}

function sameCopy(a: Map<string, Entry>, b: Map<string, Entry>): boolean {
  if (a.size !== b.size) return false
  for (const [key, entry] of a) {
    if (b.get(key)?.commands !== entry.commands) return false
  }
  return true
}

function bindWindow(): void {
  if (windowBound || typeof window === "undefined") return
  windowBound = true
  window.addEventListener("storage", (event) => {
    // Only a window that has read the record holds a copy to bring up to date.
    const copy = entries
    if (!copy) return
    if (event.key === null) {
      // Another window cleared storage altogether.
      const reread = readAll(copy)
      if (!reread) return
      entries = reread
      if (!sameCopy(copy, reread)) notify()
      return
    }
    if (!event.key.startsWith(KEY_PREFIX)) return
    // What is stored now, not the event's `newValue`: events queue, and one
    // sent before this window's own newer write would put the older list back.
    const raw = readStored(event.key)
    if (raw === undefined) return
    const previous = copy.get(event.key)
    const next = parseValue(raw, previous)
    // Nor may an older list replace a newer one this window could not store.
    if (next && previous && next.at < previous.at) return
    if (next) copy.set(event.key, next)
    else copy.delete(event.key)
    // The same names advertised again only re-stamp the entry: nobody wakes.
    if (next?.commands !== previous?.commands) notify()
  })
}

function load(): Map<string, Entry> {
  if (typeof window === "undefined") {
    // Deliberately NOT cached: this module outlives a server render, and
    // caching an empty record here would make the first client read skip
    // localStorage.
    return new Map()
  }
  bindWindow()
  entries ??= readAll(null) ?? new Map()
  return entries
}

/**
 * Hold the stored entries to {@link MAX_STORED_CHARS}, measured on storage
 * itself (other windows write there too) and never dropping `keep`, which fits
 * on its own. An entry over the cap by itself can never fit, so it goes first;
 * after that, the one advertised least recently. Returns whether this window's
 * copy lost an entry.
 */
function trimToCap(keep: string): boolean {
  const keys = storedKeys()
  if (!keys) return false
  const sized = keys.map((key) => {
    const raw = readStored(key) ?? ""
    return { key, raw, size: key.length + raw.length }
  })
  let total = sized.reduce((sum, item) => sum + item.size, 0)
  if (total <= MAX_STORED_CHARS) return false
  // A value nothing can read is as good as gone: it sorts before any entry.
  const ranked = sized.map((item) => ({
    ...item,
    oversized: item.size > MAX_STORED_CHARS,
    at: parseValue(item.raw, undefined)?.at ?? Number.NEGATIVE_INFINITY,
  }))
  ranked.sort((a, b) => {
    if (a.oversized !== b.oversized) return a.oversized ? -1 : 1
    return a.at === b.at ? 0 : a.at < b.at ? -1 : 1
  })
  let dropped = false
  for (const item of ranked) {
    if (total <= MAX_STORED_CHARS) break
    if (item.key === keep) continue
    removeStored(item.key)
    total -= item.size
    if (entries?.delete(item.key)) dropped = true
  }
  return dropped
}

/**
 * Record the list an agent just advertised in a folder, replacing what it
 * advertised there before and stamping the folder as the one advertised most
 * recently. A connection with no folder (a delegation child) has nothing to
 * file it under, and no transcript would look it up there.
 */
export function rememberAdvertisedCommands(
  agentType: string,
  folder: string | null | undefined,
  commands: readonly Pick<AvailableCommandInfo, "name">[]
): void {
  if (!folder || typeof window === "undefined") return
  const copy = load()
  const key = storageKeyOf(agentType, folder)
  const previous = copy.get(key)
  const names = namesOf(commands.map((command) => command.name))
  const entry: Entry = {
    at: Date.now(),
    commands:
      previous && sameNames(previous.commands, names)
        ? previous.commands
        : names,
  }
  const value = storedValue(entry)
  if (key.length + value.length > MAX_STORED_CHARS) {
    // A list too long to keep even on its own is forgotten rather than kept
    // in its stale form, and pushes no other folder out on its way.
    if (copy.delete(key)) notify()
    removeStored(key)
    return
  }
  copy.set(key, entry)
  writeStored(key, value)
  const trimmed = trimToCap(key)
  if (entry.commands !== previous?.commands || trimmed) notify()
}

/**
 * The list this agent last advertised in this folder, or `null` when it never
 * has (or no folder is known). A `useSyncExternalStore`-safe snapshot: the
 * reference changes only when this pair's names do.
 */
export function getLastAdvertisedCommands(
  agentType: string,
  folder: string | null | undefined
): AdvertisedCommands | null {
  if (!folder) return null
  return load().get(storageKeyOf(agentType, folder))?.commands ?? null
}

export function subscribeLastAdvertisedCommands(
  listener: () => void
): () => void {
  bindWindow()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
