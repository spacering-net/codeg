"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { searchWorkspaceFiles } from "@/lib/api"
import type { WorkspaceFileEntry } from "@/lib/types"
import { randomUUID } from "@/lib/utils"

export interface FlatFileEntry {
  name: string
  /** Relative path from folder root (same as WorkspaceFileEntry.path) */
  relativePath: string
  kind: "file" | "dir"
  /** Pre-computed lowercase relativePath for filtering */
  lowerPath: string
  /** Pre-computed lowercase name for filtering */
  lowerName: string
}

interface UseFileTreeOptions {
  folderPath: string | undefined
  enabled: boolean
  query: string
  limit?: number
  filesOnly?: boolean
}

interface UseFileTreeResult {
  allFiles: FlatFileEntry[]
  loading: boolean
  loaded: boolean
  /** Discard local results; an explicit refresh also invalidates native data. */
  reset: (refreshIndex?: boolean) => void
}

/**
 * Keep only the current query's bounded matches in the renderer. Discovery,
 * indexing and ranking are shared in the backend, with a native cache budget.
 */
export function useFileTree({
  folderPath,
  enabled,
  query,
  limit = 100,
  filesOnly = false,
}: UseFileTreeOptions): UseFileTreeResult {
  const [allFiles, setAllFiles] = useState<FlatFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const loadedForPathRef = useRef<string | null>(null)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const refresh = useRef(false)
  // Set when a refresh was requested and the picker is next enabled: every
  // query until the next reset then needs a native snapshot built since that
  // moment. A window (not a per-request flag) lets later keystrokes reuse the
  // snapshot the first one built, even if that first response was aborted.
  const freshSince = useRef<number | null>(null)
  const consumer = useRef<string | undefined>(undefined)

  // Results for the previous keystroke stay visible (callers re-rank them
  // against the new query) until the new response lands, so typing does not
  // blank the list. Only a different workspace or result shape clears them.
  const scopeRef = useRef<string | null>(null)

  useEffect(() => {
    const current = ++generation.current
    const scope = `${enabled}\0${folderPath ?? ""}\0${filesOnly}`
    if (scopeRef.current !== scope) {
      scopeRef.current = scope
      loadedForPathRef.current = null
      setAllFiles([])
    }
    if (!enabled || !folderPath) {
      setLoading(false)
      return
    }
    let canceled = false
    const abort = new AbortController()
    setLoading(true)
    if (refresh.current) {
      refresh.current = false
      freshSince.current = performance.now()
    }
    const since = freshSince.current

    async function load() {
      try {
        const files: WorkspaceFileEntry[] = await searchWorkspaceFiles(
          folderPath!,
          query,
          {
            limit,
            filesOnly,
            refresh: false,
            ...(since === null
              ? {}
              : {
                  maxAgeMs: Math.max(0, Math.floor(performance.now() - since)),
                }),
            request: {
              consumerId: (consumer.current ??= randomUUID()),
              generation: current,
            },
            signal: abort.signal,
          }
        )
        if (canceled || generation.current !== current) return
        const flat: FlatFileEntry[] = files.map((f) => ({
          name: f.name,
          relativePath: f.path,
          kind: f.kind,
          lowerPath: f.path.toLowerCase(),
          lowerName: f.name.toLowerCase(),
        }))

        if (!canceled && generation.current === current) {
          setAllFiles(flat)
          loadedForPathRef.current = folderPath!
        }
      } catch {
        if (!canceled && generation.current === current) setAllFiles([])
      } finally {
        if (!canceled && generation.current === current) setLoading(false)
      }
    }

    const timer = setTimeout(() => void load(), query.trim() ? 150 : 0)
    return () => {
      canceled = true
      abort.abort()
      clearTimeout(timer)
    }
  }, [enabled, folderPath, query, limit, filesOnly, revision])

  const reset = useCallback((refreshIndex = false) => {
    loadedForPathRef.current = null
    scopeRef.current = null
    generation.current += 1
    if (refreshIndex) {
      refresh.current = true
      freshSince.current = null
    }
    setAllFiles([])
    setRevision((value) => value + 1)
  }, [])

  return {
    allFiles,
    loading,
    loaded: loadedForPathRef.current === folderPath,
    reset,
  }
}
