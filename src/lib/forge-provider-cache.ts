"use client"

import { useEffect, useSyncExternalStore } from "react"
import { folderForgeRemote } from "@/lib/api"
import type { ForgeProviderId } from "@/lib/types"

/**
 * Which forge each project folder's remote lives on — just enough to NAME the
 * aux panel's change-request tab before it is ever opened: GitLab calls them
 * merge requests, GitHub and Gitea pull requests (the repository panel words
 * its own switcher the same way).
 *
 * One lookup per folder per session, shared by every reader. A folder whose
 * remote is missing or unreadable is remembered as `null` — the default wording
 * — while a lookup that FAILED is not remembered at all, so the next visit asks
 * again. The repository panel reports each remote it resolves here as well,
 * which is how a forge the backend corrects ("this host is a GitLab after all")
 * reaches the tab's name without a second lookup.
 */
const providers = new Map<number, ForgeProviderId | null>()
const inFlight = new Set<number>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Record the forge a folder's remote resolved to (`null`: none readable). */
export function rememberForgeProvider(
  folderId: number,
  provider: ForgeProviderId | null
): void {
  if (providers.has(folderId) && providers.get(folderId) === provider) return
  providers.set(folderId, provider)
  for (const listener of listeners) listener()
}

function ensureForgeProvider(folderId: number): void {
  if (providers.has(folderId) || inFlight.has(folderId)) return
  inFlight.add(folderId)
  folderForgeRemote(folderId)
    .then((remote) => rememberForgeProvider(folderId, remote?.provider ?? null))
    .catch(() => {
      // Left unknown rather than recorded: a transient failure must not pin
      // the default wording on a GitLab project for the rest of the session.
    })
    .finally(() => {
      inFlight.delete(folderId)
    })
}

/**
 * The forge `folderId`'s remote lives on, or `null` while unknown and for a
 * folder without a readable remote. Looks it up on first use.
 */
export function useFolderForgeProvider(
  folderId: number | null
): ForgeProviderId | null {
  const provider = useSyncExternalStore(
    subscribe,
    () => (folderId == null ? null : (providers.get(folderId) ?? null)),
    () => null
  )
  useEffect(() => {
    if (folderId != null) ensureForgeProvider(folderId)
  }, [folderId])
  return provider
}

/** Test seam: forget every folder, so each test starts from no lookups. */
export function resetForgeProviderCacheForTests(): void {
  providers.clear()
  inFlight.clear()
}
