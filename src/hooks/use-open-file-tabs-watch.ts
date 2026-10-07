"use client"

// Provider-owned external-change watcher for open file tabs.
//
// A file tab is identified by its absolute path; folder association is
// DERIVED here: the watcher subscribes to the per-root workspace FS stream
// of every registered folder that contains at least one open file tab —
// regardless of which folder/conversation is active and whether the
// (closed-by-default) aux file tree is mounted. Tabs outside every
// registered folder get no live stream; they are covered by the
// activation-time freshness pass at the bottom of this hook (plus the
// provider's save pre-verify and the backend's etag CAS).
//
// Performance model (the load-bearing part):
//   • The subscription effect depends ONLY on `watchSignature`, a
//     collision-safe JSON string of the sorted (folderId, rootPath) pairs
//     derived from the open tabs' paths. Keystrokes churn `fileTabs`
//     every render, but the signature string stays identical, so
//     subscriptions are never torn down/rebuilt on typing — and the
//     backend stream never restarts.
//   • Only the ACTIVE tab is reconciled eagerly (disk read + conflict
//     check). Every other affected tab is batch-marked stale in a single
//     setState with zero disk reads; activating it later refetches via
//     the existing decideLoad stale promotion.
//   • Our own saves echo back as change events. A one-shot etag record
//     per save suppresses the immediate re-mark so switching tabs after
//     an autosave doesn't flash a pointless reload.
import { useEffect, useMemo, useRef, type RefObject } from "react"
import { readFileForEdit } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  findOwningFolder,
  isPathUnderRoot,
  joinRootRel,
  normalizeAbsPath,
  splitAbsPath,
} from "@/lib/file-open-target"
import { isImageFile, isOfficePreviewable } from "@/lib/language-detect"
import { getWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import type { FileEditContent } from "@/lib/types"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"

// One divergence between an open dirty buffer and the file on disk.
// Queued FIFO in the provider and surfaced one at a time by the
// external-conflict dialog; keyed/deduped by absolute path + signature.
export interface WorkspaceExternalConflict {
  // Absolute normalized path — the tab identity.
  path: string
  diskContent: string
  unsavedContent: string
  // Fingerprint of the disk state (etag) — a repeat announcement for the
  // same divergence is dropped so the dialog never flickers.
  signature: string
}

type FileChangeDecision =
  | { kind: "none" }
  | { kind: "reload"; path: string; latest: FileEditContent }
  | {
      kind: "conflict"
      path: string
      diskContent: string
      unsavedContent: string
      signature: string
    }
  | { kind: "missing"; path: string; error: string }

// The backend read pair for one file: `(directory, file name)` — every
// read goes through the backend's root+relative contract regardless of
// whether the file sits inside a registered folder.
interface FileIoTarget {
  rootPath: string
  ioPath: string
}

// Per-tab disk-vs-buffer resolver. Compares the tab's known etag against
// the latest disk read for the same path. Independent of activation —
// callable for any open file tab. Re-reads the tab from `fileTabsRef`
// after the fetch to guard against close/reopen races during the async
// window. The `reload` decision carries the fetched FileEditContent so
// the caller can write it via applyExternalReload without a second read.
async function resolveFileChangeDecision(
  tabSnapshot: FileWorkspaceTab,
  io: FileIoTarget,
  fileTabsRef: RefObject<FileWorkspaceTab[]>
): Promise<FileChangeDecision> {
  if (tabSnapshot.kind !== "file") return { kind: "none" }
  const path = tabSnapshot.path
  if (!path) return { kind: "none" }
  if (tabSnapshot.loading) return { kind: "none" }

  const tabId = tabSnapshot.id

  const stillSameTab = (): FileWorkspaceTab | null => {
    const latestTab = (fileTabsRef.current ?? []).find((t) => t.id === tabId)
    if (!latestTab || latestTab.kind !== "file") return null
    if (latestTab.path !== path) return null
    if (latestTab.loading) return null
    return latestTab
  }

  let latest: FileEditContent | undefined
  try {
    latest = await readFileForEdit(io.rootPath, io.ioPath)
  } catch (error) {
    // Disk read failed — most commonly an external delete, but also
    // permission revocation, an exclusive lock, or a transient FS error.
    // Surface this as its own decision: the watcher routes it to
    // rejectFileTab (clean) or markTabsStale (dirty) so the user is never
    // silently shown a buffer that no longer matches disk.
    const latestTab = stillSameTab()
    if (!latestTab) return { kind: "none" }
    return { kind: "missing", path, error: toErrorMessage(error) }
  }
  // Malformed transport response (no payload): treat as inconclusive
  // rather than fabricating a divergence from a missing etag.
  if (!latest) return { kind: "none" }

  const latestTab = stillSameTab()
  if (!latestTab) return { kind: "none" }

  const latestTabEtag = latestTab.etag ?? null
  if (latest.etag === latestTabEtag) return { kind: "none" }

  if (latestTab.isDirty) {
    return {
      kind: "conflict",
      path,
      diskContent: latest.content,
      unsavedContent: latestTab.content,
      signature: latest.etag ?? "",
    }
  }

  return { kind: "reload", path, latest }
}

// True when `tabPath` (absolute, normalized) is a changed path itself or
// sits under a changed directory. Boundary-safe: walks the tab path's
// ancestor segments and looks each up in the changed set — "/a/foo" never
// matches a change reported for "/a/foobar", and the cost is O(depth),
// not O(changed).
function tabPathAffected(tabPath: string, changedSet: Set<string>): boolean {
  const normalized = normalizeAbsPath(tabPath)
  if (changedSet.has(normalized)) return true
  let slash = normalized.lastIndexOf("/")
  while (slash > 0) {
    if (changedSet.has(normalized.slice(0, slash))) return true
    slash = normalized.lastIndexOf("/", slash - 1)
  }
  return false
}

export interface UseOpenFileTabsWatchParams {
  // Render-scoped tab list — used ONLY to derive the watch signature.
  fileTabs: FileWorkspaceTab[]
  // Latest-state mirrors owned by the provider.
  fileTabsRef: RefObject<FileWorkspaceTab[]>
  activeFileTabIdRef: RefObject<string | null>
  // Render-scoped active tab for the stale-on-activation pass.
  activeFileTab: FileWorkspaceTab | null
  // Registered folders — the derivation source for which roots to watch.
  // Render-scoped; participates in the signature memo so folder add/remove
  // (and path changes) re-key subscriptions.
  allFolders: ReadonlyArray<{ id: number; path: string }>
  // Provider actions (stable identities).
  openFilePreview: (
    path: string,
    options?: { line?: number; reload?: boolean; folderId?: number }
  ) => Promise<string | null>
  reloadOpenFileBackground: (path: string) => Promise<void>
  applyExternalReload: (path: string, fetched: FileEditContent) => Promise<void>
  markTabsStale: (path: string) => void
  markTabsStaleBatch: (paths: string[]) => void
  rejectFileTab: (path: string, errorMessage: string) => void
  enqueueExternalConflict: (conflict: WorkspaceExternalConflict) => void
  // One-shot save-echo suppression (owned by the provider's saveFileTab).
  consumeSelfWriteEcho: (path: string) => boolean
}

export function useOpenFileTabsWatch({
  fileTabs,
  fileTabsRef,
  activeFileTabIdRef,
  activeFileTab,
  allFolders,
  openFilePreview,
  reloadOpenFileBackground,
  applyExternalReload,
  markTabsStale,
  markTabsStaleBatch,
  rejectFileTab,
  enqueueExternalConflict,
  consumeSelfWriteEcho,
}: UseOpenFileTabsWatchParams): void {
  // Collision-safe, stable-by-value signature of the roots to watch: the
  // deduped owning folders of the open file tabs. JSON encoding (not join)
  // so no path content can forge a separator. Recomputed per render (cheap
  // O(tabs × folders)); the effect below only re-runs when the RESULTING
  // STRING changes — i.e. when a folder gains its first open file tab,
  // loses its last one, is added/removed, or its root path changes.
  const watchSignature = useMemo(() => {
    const rootByFolder = new Map<number, string>()
    for (const tab of fileTabs) {
      if (tab.kind !== "file" || !tab.path) continue
      const owning = findOwningFolder(tab.path, allFolders)
      if (!owning) continue
      rootByFolder.set(owning.folderId, owning.rootPath)
    }
    const entries = [...rootByFolder.entries()].sort((a, b) => a[0] - b[0])
    return JSON.stringify(entries)
  }, [fileTabs, allFolders])

  useEffect(() => {
    const targets = JSON.parse(watchSignature) as Array<[number, string]>
    if (targets.length === 0) return

    const subscriptions = targets.map(([, rootPath]) => {
      const store = getWorkspaceStateStore(rootPath)
      // Paths-only: tab watching consumes changed_paths exclusively. The
      // backend runs tree/git scans on this root only while an aux
      // tree/git panel holds a full-mode token.
      const token = store.acquire("paths")

      // Per-root drainer: coalesces envelope bursts via queueMicrotask
      // and a single in-flight loop, mirroring the aux panel's original
      // reconciliation coroutine semantics.
      const pendingPaths = new Set<string>()
      let pendingFullScan = false
      let flushScheduled = false
      let flushPromise: Promise<void> | null = null
      let disposed = false

      const reconcileChanges = async (
        paths: string[],
        fullScan: boolean
      ): Promise<void> => {
        // Tabs covered by THIS stream: boundary containment on the
        // absolute path. Nested roots (a worktree inside a parent repo,
        // both watched) can both match one tab — the duplicate resolve is
        // absorbed by the provider's generation guards.
        const openFileTabs = (fileTabsRef.current ?? []).filter(
          (t) =>
            t.kind === "file" &&
            t.path &&
            !t.loading &&
            isPathUnderRoot(t.path, rootPath)
        )
        if (openFileTabs.length === 0) return

        const candidates = (() => {
          if (fullScan) return openFileTabs
          // changed_paths are root-relative; join onto the stream root so
          // they compare byte-identically with tab identities.
          const changedSet = new Set(
            paths.map((rel) => joinRootRel(rootPath, rel))
          )
          return openFileTabs.filter(
            (t) => t.path && tabPathAffected(t.path, changedSet)
          )
        })()
        if (candidates.length === 0) return

        // Split by activation FIRST: background tabs cost zero disk reads
        // (batched stale mark), only the tab the user is looking at gets
        // the eager read+resolve treatment.
        const activeId = activeFileTabIdRef.current
        const staleBatch: string[] = []
        const eager: FileWorkspaceTab[] = []
        for (const tab of candidates) {
          if (!tab.path) continue
          if (tab.id === activeId) {
            eager.push(tab)
            continue
          }
          // Clean tab whose etag matches a just-issued save of ours: the
          // event is (with overwhelming likelihood) our own write echo.
          // One-shot: the record is consumed, so any FURTHER event for
          // this path marks stale normally.
          if (!tab.isDirty && consumeSelfWriteEcho(tab.path)) {
            continue
          }
          staleBatch.push(tab.path)
        }
        if (staleBatch.length > 0) {
          markTabsStaleBatch(staleBatch)
        }

        for (const tab of eager) {
          if (disposed) return
          const path = tab.path
          if (!path) continue

          // Image tabs do not carry an etag and load via readFileBase64.
          // Bypass the text-file resolver: a single path-match is enough
          // to trigger a refresh.
          if (isImageFile(path)) {
            void reloadOpenFileBackground(path)
            continue
          }

          if (consumeSelfWriteEcho(path)) continue

          const io = splitAbsPath(path)
          if (!io) continue
          const decision = await resolveFileChangeDecision(tab, io, fileTabsRef)
          if (disposed) return

          if (decision.kind === "none") continue

          if (decision.kind === "reload") {
            void applyExternalReload(decision.path, decision.latest)
            continue
          }

          if (decision.kind === "missing") {
            const liveTab = (fileTabsRef.current ?? []).find(
              (t) => t.id === tab.id
            )
            if (liveTab?.isDirty) {
              markTabsStale(decision.path)
            } else {
              rejectFileTab(decision.path, decision.error)
            }
            continue
          }

          // Conflict. Re-read activation AFTER the resolve await: if the
          // user switched away mid-read, degrade to a stale mark instead
          // of popping a dialog for a tab they just left.
          if (tab.id === activeFileTabIdRef.current) {
            enqueueExternalConflict({
              path: decision.path,
              diskContent: decision.diskContent,
              unsavedContent: decision.unsavedContent,
              signature: decision.signature,
            })
          } else {
            markTabsStale(decision.path)
          }
        }
      }

      const ensureFlushing = () => {
        if (flushPromise || flushScheduled) return
        flushScheduled = true
        queueMicrotask(() => {
          flushScheduled = false
          if (disposed) return
          flushPromise = (async () => {
            try {
              // Drain anything pending — including envelopes that arrive
              // while awaiting reconcileChanges; their paths land in
              // pendingPaths and the next loop iteration picks them up.
              while (!disposed && (pendingPaths.size > 0 || pendingFullScan)) {
                const paths = Array.from(pendingPaths)
                pendingPaths.clear()
                const fullScan = pendingFullScan
                pendingFullScan = false
                await reconcileChanges(paths, fullScan)
              }
            } finally {
              flushPromise = null
            }
          })()
        })
      }

      const unsubscribe = store.subscribeEnvelopes(
        ({ changed_paths, kind }) => {
          if (
            kind === "resync_hint" ||
            !changed_paths ||
            changed_paths.length === 0
          ) {
            // Resync or untargeted event — we cannot scope work, so cover
            // every open tab under this root. Targeted paths from later
            // envelopes are additive (full scan is a superset).
            pendingFullScan = true
          } else {
            for (const path of changed_paths) {
              pendingPaths.add(path)
            }
          }
          ensureFlushing()
        }
      )

      return () => {
        disposed = true
        unsubscribe()
        pendingPaths.clear()
        store.release(token)
      }
    })

    return () => {
      for (const dispose of subscriptions) dispose()
    }
  }, [
    watchSignature,
    fileTabsRef,
    activeFileTabIdRef,
    reloadOpenFileBackground,
    applyExternalReload,
    markTabsStale,
    markTabsStaleBatch,
    rejectFileTab,
    enqueueExternalConflict,
    consumeSelfWriteEcho,
  ])

  // Activation pass — one effect, three exclusive branches, no double
  // reads:
  //   ① stale + clean  → reload via openFilePreview's decideLoad promotion.
  //   ② stale + dirty  → conflict detection via the resolver.
  //   ③ unwatched fresh-check: a text tab OUTSIDE every registered folder
  //     has no live stream, so verify it against disk once per activation
  //     TRANSITION (never per re-render/keystroke; the ref below records
  //     the id even on skipped runs so a cold load doesn't double-read).
  const lastActivationCheckedTabIdRef = useRef<string | null>(null)
  useEffect(() => {
    const tab = activeFileTab
    if (!tab || tab.kind !== "file" || !tab.path) {
      lastActivationCheckedTabIdRef.current = null
      return
    }
    const isTransition = lastActivationCheckedTabIdRef.current !== tab.id
    lastActivationCheckedTabIdRef.current = tab.id

    if (tab.stale && !tab.loading) {
      if (!tab.isDirty) {
        // Clean stale — decideLoad promotes this reopen to a reload.
        void openFilePreview(tab.path, { reload: true })
        return
      }
      const io = splitAbsPath(tab.path)
      if (!io) return
      void (async () => {
        const decision = await resolveFileChangeDecision(tab, io, fileTabsRef)
        if (decision.kind === "conflict") {
          enqueueExternalConflict({
            path: decision.path,
            diskContent: decision.diskContent,
            unsavedContent: decision.unsavedContent,
            signature: decision.signature,
          })
        } else if (decision.kind === "reload") {
          void applyExternalReload(decision.path, decision.latest)
        } else if (decision.kind === "missing") {
          // File vanished while the dirty buffer sat in a non-active tab.
          // The buffer is still dirty here (this branch only runs for
          // tab.isDirty === true) so we keep the stale flag on the tab —
          // refusing to silently lose the user's unsaved edits. The user
          // discovers the deletion on save (backend recreates or errors).
          markTabsStale(decision.path)
        }
      })()
      return
    }

    // Branch ③ — activation freshness for unwatched tabs.
    if (!isTransition) return
    if (tab.loading || tab.saveState === "saving") return
    // Text files only: image tabs carry no etag (the resolver would
    // misread a fine image as "missing"), and office tabs are refreshed
    // by their own officecli watch.
    if (isImageFile(tab.path) || isOfficePreviewable(tab.path)) return
    if (findOwningFolder(tab.path, allFolders)) return
    const io = splitAbsPath(tab.path)
    if (!io) return
    void (async () => {
      const decision = await resolveFileChangeDecision(tab, io, fileTabsRef)
      if (decision.kind === "conflict") {
        enqueueExternalConflict({
          path: decision.path,
          diskContent: decision.diskContent,
          unsavedContent: decision.unsavedContent,
          signature: decision.signature,
        })
      } else if (decision.kind === "reload") {
        void applyExternalReload(decision.path, decision.latest)
      } else if (decision.kind === "missing") {
        const liveTab = (fileTabsRef.current ?? []).find((t) => t.id === tab.id)
        if (liveTab?.isDirty) {
          markTabsStale(decision.path)
        } else {
          rejectFileTab(decision.path, decision.error)
        }
      }
    })()
  }, [
    activeFileTab,
    fileTabsRef,
    allFolders,
    openFilePreview,
    applyExternalReload,
    enqueueExternalConflict,
    markTabsStale,
    rejectFileTab,
  ])
}
