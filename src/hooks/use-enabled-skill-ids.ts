"use client"

import { useEffect, useMemo, useState } from "react"

import {
  customListAllInstallStatuses,
  expertsListAllInstallStatuses,
  generativeUiListAllInstallStatuses,
  officecliSkillListAllInstallStatuses,
  scienceListAllInstallStatuses,
} from "@/lib/api"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { piUsesCustomAgentDir } from "@/lib/pi-config"
import { skillsInventory } from "@/lib/skills/api"
import { listenSkillsChanged } from "@/lib/skills/changes"
import { skillsFailureOf } from "@/lib/skills/errors"
import { seenBy } from "@/lib/skills/model"
import type { SkillsChanged } from "@/lib/skills/types"
import type { AgentType, ExpertInstallStatus } from "@/lib/types"

/** Per agent, the ids of the Codeg skills it sees. */
type Snapshot = ReadonlyMap<AgentType, ReadonlySet<string>>

// Module-level cache shared across every consumer (each composer, the welcome
// page's quick actions). Agent-agnostic — one entry per agent — so switching
// the selected agent only re-filters in memory, with no refetch.
let cached: Snapshot | null = null
let inflight: Promise<Snapshot | null> | null = null
// Bumped on every invalidation. A load whose generation is stale by the time
// it resolves must not overwrite a fresher snapshot — guards the refresh race
// where an orphaned earlier request resolves last.
let generation = 0
/** The cache was kept while nothing followed its changes. */
let stale = false
const subscribers = new Set<(snapshot: Snapshot) => void>()

function snapshotOf(pairs: Iterable<[AgentType, string]>): Snapshot {
  const out = new Map<AgentType, Set<string>>()
  for (const [agent, id] of pairs) {
    const ids = out.get(agent) ?? new Set<string>()
    ids.add(id)
    out.set(agent, ids)
  }
  return out
}

function* linked(
  statuses: readonly ExpertInstallStatus[]
): Iterable<[AgentType, string]> {
  for (const status of statuses) {
    if (status.state === "linked_to_codeg") {
      yield [status.agentType, status.expertId]
    }
  }
}

/**
 * Which Codeg skills each agent sees: every store skill of every origin —
 * the packs, Custom, UI and Harness — that the agent sees through Codeg's
 * link or copy, in any directory it reads.
 *
 * One `skills_inventory` read covers all of them. An older Codeg (a remote
 * workspace, a browser on an older server) has no inventory: its packs' own
 * status snapshots stand in, as they did before, Custom and UI included.
 */
async function readSnapshot(): Promise<Snapshot> {
  try {
    const inventory = await skillsInventory()
    return snapshotOf(
      inventory.skills.flatMap((skill) =>
        seenBy(skill).map((agent): [AgentType, string] => [agent, skill.id])
      )
    )
  } catch (error) {
    if (skillsFailureOf(error).kind !== "unsupported") throw error
  }
  const optional = (load: () => Promise<ExpertInstallStatus[]>) =>
    load().catch(() => [] as ExpertInstallStatus[])
  const lists = await Promise.all([
    expertsListAllInstallStatuses(),
    officecliSkillListAllInstallStatuses(),
    scienceListAllInstallStatuses(),
    optional(customListAllInstallStatuses),
    optional(generativeUiListAllInstallStatuses),
  ])
  return snapshotOf(lists.flatMap((statuses) => [...linked(statuses)]))
}

/**
 * Load the snapshot.
 *
 * Fails *open*: if the read fails, the previous cached snapshot is kept (and
 * returned) rather than an empty one. That matters because a locked card
 * blocks injection — turning a transient backend error into an empty snapshot
 * would make every skill look "not enabled" and wrongly block skills the user
 * actually enabled. With no prior snapshot the result stays `null`, so `ready`
 * remains false and callers treat everything as usable (the pre-gating
 * behavior) instead of locking it all.
 */
async function loadSnapshot(): Promise<Snapshot | null> {
  if (inflight) return inflight
  const myGeneration = generation
  const request: Promise<Snapshot | null> = readSnapshot()
    .then((next) => {
      // Only clear the shared handle if it still points at *this* request: a
      // refresh may have superseded it, and nulling unconditionally would
      // orphan the newer in-flight request and let a concurrent mount kick off
      // a duplicate scan.
      if (inflight === request) inflight = null
      // A newer invalidation superseded this request while it was in flight —
      // discard its result so it can't clobber the fresher snapshot.
      if (myGeneration !== generation) return cached
      cached = next
      stale = false
      for (const notify of subscribers) notify(next)
      return next
    })
    .catch((err) => {
      if (inflight === request) inflight = null
      console.warn("[useEnabledSkillIds] failed to load the snapshot:", err)
      // The kept snapshot may miss whatever changed: the next consumer to
      // mount reads again.
      if (cached && myGeneration === generation) stale = true
      return cached
    })
  inflight = request
  return inflight
}

/** Read again now, even with a read in flight: it may have started before
 *  the change being followed. On failure the cache is kept, so a transient
 *  error never resets a good snapshot. */
function refreshSnapshot(): void {
  generation += 1
  inflight = null
  void loadSnapshot()
}

/** Backups alone change nothing an agent sees. */
function onSkillsChanged(change: SkillsChanged | null): void {
  if (change && change.kinds.length > 0) {
    if (change.kinds.every((kind) => kind === "backups")) return
  }
  refreshSnapshot()
}

// The window-focus refresh (a change made in the Settings window) and the
// `skills://changed` one (a change made anywhere, the Harness page in this
// same window included) are shared by every consumer through one listener
// each and a refcount: N mounted composers make one coalesced read per
// change, not N.
let consumers = 0
let stopFollowing: (() => void) | null = null

function acquireRefresh(): void {
  if (typeof window === "undefined") return
  consumers += 1
  if (stopFollowing) return
  window.addEventListener("focus", refreshSnapshot)
  const stopChanges = listenSkillsChanged(onSkillsChanged)
  stopFollowing = () => {
    window.removeEventListener("focus", refreshSnapshot)
    stopChanges()
  }
}

function releaseRefresh(): void {
  if (typeof window === "undefined") return
  consumers = Math.max(0, consumers - 1)
  if (consumers > 0 || !stopFollowing) return
  stopFollowing()
  stopFollowing = null
  // Nothing hears of a change from here on: the next consumer shows what is
  // kept, and reads again.
  if (cached) stale = true
}

/**
 * Returns the set of Codeg skill ids — packs, Custom, UI and Harness — the
 * given agent sees through Codeg's link or copy, in any directory it reads.
 *
 * `ready` is false until the first snapshot resolves successfully, so callers
 * can avoid marking everything as "not enabled" during the initial async load
 * (or after an error, where we deliberately stay not-ready and fail open).
 *
 * `supported` is false for an agent codeg's skill store can't manage — today
 * only a pi pointed at a custom `PI_CODING_AGENT_DIR`, whose skills live in a
 * per-agent dir codeg's default-dir store never touches. For such an agent
 * `enabledIds` is forced empty (so no consumer can surface a default-dir link
 * as enabled) and skill UIs should hide their shortcuts rather than show a
 * dead-end "enable it" path the skill pages also hide. pi is held unsupported
 * until the agent registry has loaded, so a custom-dir pi never briefly
 * exposes default-dir shortcuts during the optimistic window.
 */
export function useEnabledSkillIds(agentType: AgentType | null): {
  enabledIds: Set<string>
  ready: boolean
  supported: boolean
} {
  const { agents, fresh: agentsFresh } = useAcpAgents()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => cached)

  // Initial load + subscribe for updates (covers the refreshes below and any
  // concurrent consumer resolving the shared fetch first). Only adopt a
  // non-null result: a null means "load failed / not loaded yet", and
  // overwriting a good local snapshot with null would needlessly drop us back
  // to not-ready.
  useEffect(() => {
    let cancelled = false
    if (stale) {
      // One read again for every consumer mounting now: the first starts it
      // (dropping any older read), the rest find it in flight and join it.
      // The result reaches each through `subscribers`.
      stale = false
      refreshSnapshot()
    } else if (!cached) {
      loadSnapshot().then((next) => {
        if (!cancelled && next) setSnapshot(next)
      })
    }
    const onUpdate = (next: Snapshot) => {
      if (!cancelled) setSnapshot(next)
    }
    subscribers.add(onUpdate)
    return () => {
      cancelled = true
      subscribers.delete(onUpdate)
    }
  }, [])

  useEffect(() => {
    acquireRefresh()
    return () => releaseRefresh()
  }, [])

  // A pi pointed at a custom PI_CODING_AGENT_DIR isn't managed by codeg's
  // default-dir skill store. The custom dir lives in the agent registry's
  // env_json, so pi is held unmanaged until that registry is first `fresh`
  // (pessimistic — a custom-dir pi must never expose default-dir shortcuts
  // during the initial optimistic load), then managed only when it resolves to
  // a default-dir pi. Non-pi agents are unaffected.
  //
  // `fresh` is monotonic, so a mid-session dir change leaves `agents` briefly
  // stale during the reload it triggers. We let that converge within one reload
  // rather than gate on every in-flight reload: the env save that stores the
  // dir override emits `app://acp-agents-updated`, which this hook's
  // `useAcpAgents` reloads on, so the stale view self-heals in one round-trip.
  // Gating all reloads would instead flicker default-dir pi's shortcuts on every
  // window focus (useAcpAgents reloads on focus and the consumers hide whole
  // shortcut surfaces) — a worse, recurring regression than a sub-frame window
  // whose worst case is one ignored skill badge.
  const piSkillsUnmanaged = useMemo(() => {
    if (agentType !== "pi") return false
    if (!agentsFresh) return true
    const agent = agents.find((a) => a.agent_type === agentType)
    return !agent || piUsesCustomAgentDir(agent)
  }, [agentType, agentsFresh, agents])

  const enabledIds = useMemo(() => {
    if (!snapshot || !agentType || piSkillsUnmanaged) return new Set<string>()
    return new Set(snapshot.get(agentType) ?? [])
  }, [snapshot, agentType, piSkillsUnmanaged])

  return {
    enabledIds,
    // An unmanaged pi is authoritatively "no managed skills", so report ready
    // immediately instead of leaving consumers in the optimistic loading state.
    ready: piSkillsUnmanaged || snapshot !== null,
    supported: !piSkillsUnmanaged,
  }
}
