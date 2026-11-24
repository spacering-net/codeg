"use client"

import { useCallback, useEffect, useMemo } from "react"

import {
  useConsumeHarnessTarget,
  useHarnessSlot,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { useHistoryBackDismiss } from "@/hooks/use-history-back-dismiss"
import {
  closeDiscoverItem,
  closeDiscoverToList,
  DISCOVER_DETAIL,
  DISCOVER_DETAIL_TRAIL,
  openDiscoverItem,
  type DiscoverDetailState,
} from "@/lib/harness/discover-state"
import { parseItemRef } from "@/lib/harness/item-ref"
import { HARNESS_INSTALLED } from "@/lib/harness/mcp-install-state"
import { openDiscoverItemToInstallAny } from "@/lib/harness/skill-install-state"
import { refreshHarnessStatus, useHarnessStatus } from "@/lib/harness/status"
import { useHarnessInstalledSync } from "@/lib/harness/use-harness-installed"
import type { HarnessInstalledMark } from "@/lib/harness/types"
import { HARNESS_UPDATES, remoteFor, updatesById } from "@/lib/harness/updates"
import { DiscoverBrowse } from "./discover-browse"
import { DiscoverDetail } from "./discover-detail"
import { DiscoverFailure } from "./discover-failure"

/**
 * What the workspace's host has installed from the catalog, by item id — the
 * MCP servers, the skills and the plugins, from `harness_installed`. `undefined` until the
 * host has said, and from a Codeg too old to say: no card or detail then
 * claims anything is installed. A part whose record cannot be read lists
 * nothing; the detail's actions say so.
 *
 * Whether a newer version is out is the host's update check's to say (H6,
 * `lib/harness/updates.ts`): `updateAvailable` comes from there. The detail's
 * "Update" still compares the item's latest revision with the installed one
 * by itself.
 */
function useInstalledItems():
  | ReadonlyMap<string, HarnessInstalledMark>
  | undefined {
  useHarnessInstalledSync()
  const [state] = useHarnessSlot(HARNESS_INSTALLED)
  const [updatesState] = useHarnessSlot(HARNESS_UPDATES)
  const updates = updatesState.value
  const value = state.value
  return useMemo(() => {
    if (!value) return undefined
    const checked = updatesById(updates)
    const mark = (id: string, revision: number): HarnessInstalledMark => ({
      revision,
      updateAvailable: remoteFor(checked.get(id), revision).updateAvailable,
    })
    const marks = new Map<string, HarnessInstalledMark>()
    for (const item of value.mcp) {
      marks.set(item.id, mark(item.id, item.revision))
    }
    for (const skill of value.skills) {
      if (marks.has(skill.id)) continue
      marks.set(skill.id, mark(skill.id, skill.revision))
    }
    for (const plugin of value.plugins ?? []) {
      if (marks.has(plugin.item_id)) continue
      marks.set(plugin.item_id, mark(plugin.item_id, plugin.revision))
    }
    return marks
  }, [value, updates])
}

/** The detail as it is drawn for a request that has not been applied yet:
 *  already on the item asked for, loading. */
function pendingDetail(itemRef: string): DiscoverDetailState {
  return {
    ref: parseItemRef(itemRef)?.ref ?? itemRef.trim().slice(0, 120),
    phase: "loading",
    preview: null,
    item: null,
    error: null,
    versions: { phase: "idle", value: null, error: null, request: 0 },
    readme: { phase: "idle", value: null, error: null, request: 0 },
    prompt: { phase: "idle", value: null, error: null, request: 0 },
    releases: { phase: "idle", value: null, error: null, request: 0 },
    request: 0,
  }
}

/**
 * The Discover section: the SpaceRing Harness catalog, browsed from inside
 * Codeg.
 *
 * It is one of two screens at a time — the list, or one item's detail in its
 * place — at every width; the list comes back exactly as it was left. Which
 * of the two, and everything either one shows, is held in slots
 * (`discover-state.ts`), so leaving for a conversation and returning changes
 * nothing.
 *
 * Nothing here talks to spacering.net: every request is a backend command
 * (`lib/harness/api.ts`), and whatever comes back is third-party content,
 * shown as text.
 */
export function DiscoverSection() {
  const { slots } = useHarnessView()
  const status = useHarnessStatus()
  const [detail] = useHarnessSlot(DISCOVER_DETAIL)
  const [trail] = useHarnessSlot(DISCOVER_DETAIL_TRAIL)
  const installed = useInstalledItems()

  // `openHarness({ section: "discover", itemRef })`. The detail is drawn on
  // the requested item from the first frame (`target` is the request until
  // the effect has applied it); applying it twice — StrictMode does — only
  // makes the first load a stale one.
  const target = useConsumeHarnessTarget("discover", (requested) => {
    // `install` (an "Open in Codeg" link) opens the install dialog over an
    // MCP server's or a skill's detail once the item is in — the dialog
    // asks, nothing is installed. Every other kind only has a detail.
    if (requested.intent === "install") {
      void openDiscoverItemToInstallAny(slots, requested.itemRef)
    } else {
      void openDiscoverItem(slots, requested.itemRef)
    }
  })
  const pending = useMemo(
    () => (target ? pendingDetail(target.itemRef) : null),
    [target]
  )
  const shown = pending ?? detail
  // From the list's card while the item is on its way — the same id — so the
  // placeholders can take the shape of the actions to come.
  const shownKnown = shown ? (shown.item ?? shown.preview) : null
  const shownInstalled = shownKnown
    ? (installed?.get(shownKnown.id) ?? null)
    : null

  // Asked again on every visit: it costs one local call, and it is how a
  // catalog switched off (or a backend updated) since the window opened is
  // noticed.
  useEffect(() => {
    void refreshHarnessStatus()
  }, [])

  const close = useCallback(() => closeDiscoverItem(slots), [slots])
  const closeAll = useCallback(() => closeDiscoverToList(slots), [slots])
  // The detail is a screen, not a route: on a phone the back gesture should
  // return to the list, not leave the workspace. A detail opened from another
  // (an assistant's skill) holds one more entry, so that the gesture returns
  // to that one first. (A request still being applied starts afresh.)
  const backTo = pending ? null : (trail[trail.length - 1]?.detail ?? null)
  useHistoryBackDismiss(shown !== null, close)
  useHistoryBackDismiss(backTo !== null, close)

  return (
    <div className="@container/discover h-full min-h-0 min-w-0">
      {status.support === "unsupported" ? (
        // An older Codeg at the other end. Nothing below could load, so the
        // section says what to do about it instead of failing piece by piece.
        <DiscoverFailure
          failure={{ kind: "unsupported", detail: "" }}
          className="h-full"
        />
      ) : shown ? (
        <DiscoverDetail
          detail={shown}
          onBack={close}
          onBackToList={closeAll}
          backTo={backTo}
          installed={shownInstalled}
        />
      ) : (
        <DiscoverBrowse installed={installed} />
      )}
    </div>
  )
}
