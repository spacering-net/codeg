"use client"

/**
 * Remembers what each agent CALLS its models, so a surface holding nothing but
 * a raw model id can show the name the user picked it by.
 *
 * Most agents name a model with a string a human can read — `claude-opus-5`,
 * `gpt-5.1-codex` — so the id and the label are the same thing and this store
 * stays empty. Qoder is the case that needs it: its transcripts record the
 * account-internal key (`qfmodel`), while the name it advertises over ACP for
 * that same key is `Qwen3.8-Flash`. The composer's model selector reads the
 * advertised name, the reply footer reads the transcript, and the two disagreed
 * on screen.
 *
 * Keyed by agent type rather than globally: generic ids like `auto` or
 * `default` mean different things under different agents, and a single table
 * would let one agent relabel another's model.
 *
 * Persisted because history has to render without a live session — the
 * transcript is on disk long after the connection that named its model is gone.
 * Entries are MERGED, never replaced: an account whose model catalog shrinks
 * should not lose the label for a model its older sessions still reference.
 *
 * `Map`, not a plain object, at BOTH levels. Agent types and model ids are
 * strings codeg does not choose, and a plain object inherits `Object.prototype`
 * — so `labels["__proto__"]` answers with the prototype instead of `undefined`,
 * the caller's `?? rawId` fallback never fires, and a React text slot is handed
 * an object to render (which throws). Restoring from JSON has the mirror
 * problem: `out[agentType] = …` with the key `__proto__` RE-PARENTS the map
 * instead of adding to it, so one crafted storage entry answers lookups for
 * every other agent. A `Map` has neither hazard.
 */

import {
  isModelConfigOption,
  MODEL_CONFIG_OPTION_ID,
} from "@/lib/model-config-groups"
import type {
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
} from "@/lib/types"

const STORAGE_KEY = "codeg:model-labels"

/** model id → the agent's own display name. */
export type ModelLabels = ReadonlyMap<string, string>

/** Stable empty reference. [`getModelLabels`] is read as a
 *  `useSyncExternalStore` snapshot, and a snapshot that returns a fresh empty
 *  map every call never compares equal to itself — React then re-renders
 *  forever ("Maximum update depth exceeded"). */
const NO_LABELS: ModelLabels = new Map()

let labels: Map<string, Map<string, string>> | null = null
const listeners = new Set<() => void>()

/**
 * Keep only `{agent: {id: nonEmptyLabel}}`, discarding anything else.
 *
 * localStorage is shared with every other codeg instance on this machine and
 * survives downgrades, so the parsed value is untrusted input — a bare array, a
 * number, or a bucket whose values are objects all have to degrade to "no
 * labels" rather than reach a `.toString()` somewhere in the render tree.
 */
function normalize(raw: unknown): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  for (const [agentType, bucket] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue
    const kept = new Map<string, string>()
    for (const [modelId, label] of Object.entries(
      bucket as Record<string, unknown>
    )) {
      // Trimmed for the same reason the write path trims: a blank label is a
      // chip with nothing in it, which reads as a rendering bug.
      const text = typeof label === "string" ? label.trim() : ""
      if (text) kept.set(modelId, text)
    }
    if (kept.size > 0) out.set(agentType, kept)
  }
  return out
}

function load(): Map<string, Map<string, string>> {
  if (labels) return labels
  if (typeof window === "undefined") {
    // Deliberately NOT cached: this module outlives a server render, and
    // caching an empty map here would make the first client read skip
    // localStorage.
    return new Map()
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    labels = raw ? normalize(JSON.parse(raw)) : new Map()
  } catch {
    labels = new Map()
  }
  return labels
}

function persist(all: Map<string, Map<string, string>>) {
  labels = all
  if (typeof window !== "undefined") {
    try {
      // `Object.fromEntries` DEFINES each key rather than assigning it, so an
      // agent or model literally named `__proto__` round-trips as data instead
      // of re-parenting the object on the way out.
      const plain = Object.fromEntries(
        [...all].map(([agentType, byId]) => [
          agentType,
          Object.fromEntries(byId),
        ])
      )
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plain))
    } catch {
      /* quota / private mode — the in-memory map still serves this session */
    }
  }
  for (const listener of listeners) listener()
}

/**
 * The agent's model selector, as a flat option list.
 *
 * The exact id wins over [`isModelConfigOption`] on purpose: that helper also
 * matches `category === "model"`, which qoder hangs its `reasoning_effort`
 * selector off — and `low` / `high` / `max` are not model ids, so folding them
 * into a map keyed by one is just wrong. The category signal stays as the
 * fallback for an agent that names its model option something else, which is
 * the same pair the backend matches on (`connection.rs::is_model_config_option`).
 *
 * Grouped selectors need no special case: the backend flattens every group into
 * `kind.options` and repeats the grouping in `kind.groups`.
 */
function modelSelectOptions(
  options: SessionConfigOptionInfo[] | null | undefined
): SessionConfigSelectOptionInfo[] | null {
  if (!options?.length) return null
  const option =
    options.find((o) => o.id === MODEL_CONFIG_OPTION_ID) ??
    options.find(isModelConfigOption)
  if (!option || option.kind.type !== "select") return null
  return option.kind.options
}

/**
 * Record what this agent calls each of its models, from a `config_options`
 * payload. A no-op when nothing new is learned, so the common case (every
 * reconnect re-sends the same list) neither writes nor notifies.
 */
export function rememberModelLabels(
  agentType: string,
  options: SessionConfigOptionInfo[] | null | undefined
): void {
  const selectOptions = modelSelectOptions(options)
  if (!selectOptions) return

  const all = load()
  const existing = all.get(agentType)
  let next: Map<string, string> | null = null
  for (const option of selectOptions) {
    const label = option.name?.trim()
    // An agent whose label IS its id has nothing to translate; storing the
    // identity would grow the record on every agent for no lookup that could
    // ever change an answer.
    if (!label || label === option.value) continue
    if (existing?.get(option.value) === label) continue
    next ??= new Map(existing)
    next.set(option.value, label)
  }
  if (!next) return
  // Written into the SAME outer map: only this agent's snapshot reference
  // changes, so a write here cannot re-render a surface reading another
  // agent's labels.
  all.set(agentType, next)
  persist(all)
}

/**
 * Every label known for an agent, as a `useSyncExternalStore`-safe snapshot:
 * the reference only changes when THIS agent's labels do.
 */
export function getModelLabels(agentType: string): ModelLabels {
  return load().get(agentType) ?? NO_LABELS
}

export function subscribeModelLabels(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
