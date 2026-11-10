"use client"

/**
 * Poll-based freshness for LIVE background-task output logs.
 *
 * The strip's "Output" button (`async-task-strip.tsx`) opens a task's log
 * through `openFilePreview`. That log lives under the OS temp root — OUTSIDE
 * every registered workspace folder — so the notify-driven stream that
 * auto-reloads ordinary open tabs (`use-open-file-tabs-watch.ts`) never sees
 * it: nothing watches a path no root contains. The only existing coverage was
 * the activation-time freshness pass, which fires on the tab SWITCH but not
 * while the user sits on the tab watching a log the task is still appending
 * to. This closes exactly that gap.
 *
 * While (a) this conversation has a live (non-terminal) async task reporting
 * an `output_file_path` and (b) that very file is the ACTIVE, clean text tab,
 * compare its etag against disk every few seconds and route any change
 * through the same `applyExternalReload` the notify watcher uses — its
 * generation guards, atomic dirty refusal and git-base refresh are all
 * wanted here too. A settled task drops out of `liveAsyncTasks`, the interval
 * is torn down, and the disk is quiet again.
 *
 * Why this is cheap (the load-bearing gates):
 *   • One tab, the active one — and only when its path is a LIVE task's
 *     output. Closed tabs, background tabs, and unrelated files never tick.
 *   • Clean tabs only: a dirty buffer is the user's, not ours to clobber (the
 *     activation pass surfaces that divergence on switch-back instead).
 *   • In-flight ticks are skipped, not stacked, so a slow read cannot pile
 *     up reads behind a 2 s interval.
 *   • It is its own leaf component: the subscription to the high-frequency
 *     fileTabs slice re-renders THIS (null-rendering) component on keystroke
 *     churn, never the conversation shell around it.
 */

import { useEffect, useMemo, useRef } from "react"

import { readFileForEdit } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
} from "@/contexts/workspace-context"
import { liveAsyncTasks } from "@/lib/async-tasks"
import { normalizeAbsPath, splitAbsPath } from "@/lib/file-open-target"
import { isImageFile, isOfficePreviewable } from "@/lib/language-detect"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import type { AsyncTaskRecord } from "@/lib/types"

const POLL_INTERVAL_MS = 2000

// Gates on the tab itself. Image tabs carry no etag (and load via base64)
// and office tabs refresh through their own officecli watch — both are
// excluded from etag polling exactly like the activation pass excludes them.
function isPollableTab(tab: FileWorkspaceTab | null): tab is FileWorkspaceTab {
  if (!tab || tab.kind !== "file" || !tab.path) return false
  if (tab.loading || tab.isDirty || tab.saveState === "saving") return false
  return !isImageFile(tab.path) && !isOfficePreviewable(tab.path)
}

export function LiveOutputFileWatcher({ tasks }: { tasks: AsyncTaskRecord[] }) {
  const { activeFileTab } = useWorkspaceFileTabs()
  const { applyExternalReload, rejectFileTab } = useWorkspaceActions()

  // Live tasks' log files in tab-identity form (the same canonical shape
  // `openFilePreview` gives the tab's `path`). Recomputed per task delta,
  // but the effect below keys on the RESULTING booleans, so progress ticks
  // that flip nothing never tear down the interval.
  const liveOutputPaths = useMemo(() => {
    const set = new Set<string>()
    for (const task of liveAsyncTasks(tasks)) {
      if (task.output_file_path) {
        set.add(normalizeAbsPath(task.output_file_path))
      }
    }
    return set
  }, [tasks])

  const activePath =
    activeFileTab?.kind === "file" && activeFileTab.path
      ? normalizeAbsPath(activeFileTab.path)
      : null
  const pollable =
    activePath !== null &&
    liveOutputPaths.has(activePath) &&
    isPollableTab(activeFileTab)

  // Latest snapshot for the interval closure: the effect (and its closure)
  // is rebuilt only when the gates change, but the ref keeps the tab itself
  // fresh through every re-render.
  const activeTabRef = useRef<FileWorkspaceTab | null>(activeFileTab)
  useEffect(() => {
    activeTabRef.current = activeFileTab
  }, [activeFileTab])

  useEffect(() => {
    if (!pollable || activePath === null) return
    const io = splitAbsPath(activePath)
    if (!io) return
    // The identity this poll belongs to: same tab id AND same path, checked
    // against the LIVE ref AFTER the read resolves (close/switch mid-read
    // must not paint the old file onto a different tab).
    const isStillOurTab = (
      tab: FileWorkspaceTab | null
    ): tab is FileWorkspaceTab =>
      isPollableTab(tab) && normalizeAbsPath(tab.path as string) === activePath

    let inFlight = false
    const timer = setInterval(() => {
      if (inFlight) return
      if (!isStillOurTab(activeTabRef.current)) return
      inFlight = true
      void (async () => {
        try {
          const latest = await readFileForEdit(io.rootPath, io.ioPath)
          // Malformed payload: inconclusive, not a divergence to apply.
          if (!latest) return
          const current = activeTabRef.current
          // The gate doubles as the keystroke guard: an edit that landed
          // during the read makes the tab dirty, isStillOurTab refuses it,
          // and the buffer stays the user's (the activation pass surfaces
          // that divergence on switch-back instead).
          if (!isStillOurTab(current)) return
          if ((current.etag ?? null) === latest.etag) return
          await applyExternalReload(activePath, latest)
        } catch (error) {
          // Read failed — most commonly the sweep ate the log. Mirror the
          // notify watcher's clean-tab routing: surface it on the tab.
          const current = activeTabRef.current
          if (!isStillOurTab(current)) return
          rejectFileTab(activePath, toErrorMessage(error))
        } finally {
          inFlight = false
        }
      })()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [pollable, activePath, applyExternalReload, rejectFileTab])

  return null
}
