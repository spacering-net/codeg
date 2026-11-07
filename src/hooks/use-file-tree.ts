"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { prepareWorkspaceFileSearch, searchWorkspaceFiles } from "@/lib/api"
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
  const consumer = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (enabled && folderPath) {
      void prepareWorkspaceFileSearch(folderPath).catch(() => {})
    }
  }, [enabled, folderPath])

  useEffect(() => {
    const current = ++generation.current
    loadedForPathRef.current = null
    setAllFiles([])
    if (!enabled || !folderPath) {
      setLoading(false)
      return
    }
    let canceled = false
    const abort = new AbortController()
    setLoading(true)

    async function load() {
      try {
        const files: WorkspaceFileEntry[] = await searchWorkspaceFiles(
          folderPath!,
          query,
          {
            limit,
            filesOnly,
            refresh: refresh.current,
            request: {
              consumerId: (consumer.current ??= randomUUID()),
              generation: current,
            },
            signal: abort.signal,
          }
        )
        if (canceled || generation.current !== current) return
        if (query.trim()) refresh.current = false
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
    generation.current += 1
    refresh.current ||= refreshIndex
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
