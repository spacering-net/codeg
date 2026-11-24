/**
 * What the MCP section knows of servers installed from SpaceRing Harness:
 * one mark per server key, from the provenance record as `harness_installed`
 * reads it against the agents' files now — and the actions on such a server.
 *
 * A mark has two halves. `local` is how the agents' entries stand against
 * what Codeg wrote (the record's scan, known now). `remote` is what the
 * catalog says of the installed version — up to date, a newer one out,
 * withdrawn, taken down, no longer on SRN — which the host's update check
 * tells (H6, `./updates.ts`): `null` until it has, and where it has nothing
 * to say, so the section then shows no "update available" and offers no
 * filter for it (a filter that can never match is not offered).
 *
 * Nor can anything tell a server added in Codeg by hand from one that was
 * already in the agent's file: the engine keeps no record of who wrote what,
 * and the page does not pretend to.
 */
import { useMemo } from "react"

import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  HARNESS_INSTALLED,
  openMcpInstall,
  openMcpUninstall,
} from "./mcp-install-state"
import type { HarnessInstalled, HarnessReason } from "./mcp-install-types"
import {
  HARNESS_UPDATES,
  remoteFor,
  updatesById,
  type HarnessUpdates,
} from "./updates"

/** How an installed server's entries stand, by the record's scan. */
export const MCP_HARNESS_LOCAL_STATES = [
  "asInstalled",
  "changedLocally",
  "filesMissing",
  /** An agent's file cannot be read: nothing can be said. */
  "unknown",
] as const

export type McpHarnessLocalState = (typeof MCP_HARNESS_LOCAL_STATES)[number]

/** What the update check (H6) will say of the installed version. */
export const MCP_HARNESS_REMOTE_STATES = [
  "latest",
  "updateAvailable",
  "yanked",
  "unapproved",
  "disabledByAuthor",
  "removedByHarness",
  "gone",
] as const

export type McpHarnessRemoteState = (typeof MCP_HARNESS_REMOTE_STATES)[number]

export interface McpHarnessAgentMark {
  /** As the backend spells it. */
  agent: string
  local: McpHarnessLocalState
  revision: number
  version: string | null
}

/** One server installed from Harness, under its key. */
export interface McpHarnessMark {
  itemId: string
  /** The item's address, `publisher/name`, as recorded at the last
   *  install — what "View on Harness" opens. */
  itemRef: string
  /** The item's title as recorded at the last install; `null` for older
   *  records. */
  title: { en?: string; zh?: string } | null
  /** The lowest revision among its agents: where an update starts. */
  revision: number
  /** That revision's version label, when it has one. */
  version: string | null
  local: McpHarnessLocalState
  /** The update check's word on it; `null` until there is one (H6). */
  remote: McpHarnessRemoteState | null
  /** A newer revision is out — also beside a withdrawn or taken-down one,
   *  when there is one to move to. What the "Update available" filter and
   *  count go by. */
  updateAvailable: boolean
  agents: McpHarnessAgentMark[]
}

export interface McpHarnessSeam {
  /** By server key. */
  marks: ReadonlyMap<string, McpHarnessMark>
  /** The record could not be read: no server is marked, and this says why
   *  (`record_unreadable`, with the backend's account of it). */
  problem: HarnessReason | null
  /** Whether the catalog is offered here. Updating and changing the agents
   *  ask it; uninstalling only touches this host's files. */
  catalog: boolean
  /** Update the server installed under `key` to the newest revision. */
  update?: (key: string) => void
  /** Add the server to more agents, at the revision installed. */
  manage?: (key: string) => void
  uninstall?: (key: string) => void
}

export function localStateOf(state: string): McpHarnessLocalState {
  switch (state) {
    case "as_installed":
      return "asInstalled"
    case "changed_locally":
      return "changedLocally"
    case "missing":
      return "filesMissing"
    default:
      return "unknown"
  }
}

/** The marks a listing makes: one item is one key. Should two records ever
 *  claim one key, the first listed keeps it. `updates`: the host's update
 *  check, for the `remote` half. */
export function marksOf(
  installed: HarnessInstalled,
  updates: HarnessUpdates | null = null
): ReadonlyMap<string, McpHarnessMark> {
  const marks = new Map<string, McpHarnessMark>()
  const checked = updatesById(updates)
  for (const item of installed.mcp) {
    if (marks.has(item.key)) continue
    const { remote, updateAvailable } = remoteFor(
      checked.get(item.id),
      item.revision
    )
    marks.set(item.key, {
      itemId: item.id,
      itemRef: item.ref,
      title: item.title,
      revision: item.revision,
      version: item.version,
      local: localStateOf(item.state),
      remote,
      updateAvailable,
      agents: item.agents.map((agent) => ({
        agent: agent.agent,
        local: localStateOf(agent.state),
        revision: agent.revision,
        version: agent.version,
      })),
    })
  }
  return marks
}

/**
 * The seam, once the host has said what it has installed; `undefined` before
 * that, and from a Codeg too old to say — the section then shows no Harness
 * marks at all rather than guessing.
 */
export function useMcpHarness(): McpHarnessSeam | undefined {
  const { slots, discoverEnabled } = useHarnessView()
  const [state] = useHarnessSlot(HARNESS_INSTALLED)
  const [updatesState] = useHarnessSlot(HARNESS_UPDATES)
  const updates = updatesState.value
  const value = state.value
  // A Codeg from before each part was listed on its own rejects the whole
  // listing when the record cannot be read: that is this part's problem too.
  const rejected =
    state.failure?.kind === "recordUnreadable" ? state.failure.detail : null
  return useMemo(() => {
    if (!value) {
      return rejected === null
        ? undefined
        : {
            marks: new Map(),
            problem: {
              code: "record_unreadable",
              params: {},
              detail: rejected || null,
            },
            catalog: discoverEnabled,
          }
    }
    const marks = marksOf(value, updates)
    const checked = updatesById(updates)
    const itemOf = (key: string) =>
      value.mcp.find((item) => item.key === key) ?? null
    const seam: McpHarnessSeam = {
      marks,
      problem: value.mcp_problem,
      catalog: discoverEnabled,
      uninstall: (key) => {
        const item = itemOf(key)
        if (item) openMcpUninstall(slots, item.id)
      },
    }
    if (discoverEnabled) {
      seam.update = (key) => {
        const item = itemOf(key)
        if (item) {
          // At its address now: a rename keeps the id, not the address.
          openMcpInstall(slots, {
            itemRef: checked.get(item.id)?.ref ?? item.ref,
            title: item.title,
            purpose: "update",
            from: "mcp",
          })
        }
      }
      seam.manage = (key) => {
        const item = itemOf(key)
        if (item) {
          openMcpInstall(slots, {
            itemRef: item.ref,
            title: item.title,
            purpose: "manage",
            revision: item.revision,
            from: "mcp",
          })
        }
      }
    }
    return seam
  }, [value, updates, rejected, slots, discoverEnabled])
}
