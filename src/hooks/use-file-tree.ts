"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { listWorkspaceFiles } from "@/lib/api"
import type { WorkspaceFileEntry } from "@/lib/types"

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

/** Map a `list_workspace_files` listing to search candidates. */
export function toFlatFileEntries(
  files: readonly WorkspaceFileEntry[]
): FlatFileEntry[] {
  return files.map((f) => ({
    name: f.name,
    relativePath: f.path,
    kind: f.kind,
    lowerPath: f.path.toLowerCase(),
    lowerName: f.name.toLowerCase(),
  }))
}

interface UseFileTreeOptions {
  folderPath: string | undefined
  enabled: boolean
}

interface UseFileTreeResult {
  allFiles: FlatFileEntry[]
  loading: boolean
  loaded: boolean
  /** Clear cached data so the next `enabled=true` triggers a fresh load. */
  reset: () => void
}

/**
 * Loads a flat, gitignore-aware listing of every file/dir under `folderPath`
 * (lazily, when `enabled`) for in-memory file search — shared by the search
 * dialog and the composer `@`-mention picker.
 *
 * Discovery and gitignore filtering run on the backend (`list_workspace_files`),
 * which prunes ignored directories *during* the walk and applies no depth cap,
 * so deeply nested files are reachable while `node_modules`/`target`/… are never
 * descended. The result is cached per folder path; a folder switch keeps showing
 * the previous list until the new one loads (`loaded` gates that transition).
 */
export function useFileTree({
  folderPath,
  enabled,
}: UseFileTreeOptions): UseFileTreeResult {
  const [allFiles, setAllFiles] = useState<FlatFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const loadedForPathRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !folderPath) return
    if (loadedForPathRef.current === folderPath) return

    let canceled = false
    setLoading(true)

    async function load() {
      try {
        const files: WorkspaceFileEntry[] = await listWorkspaceFiles(
          folderPath!
        )
        const flat = toFlatFileEntries(files)

        if (!canceled) {
          setAllFiles(flat)
          loadedForPathRef.current = folderPath!
        }
      } catch {
        if (!canceled) setAllFiles([])
      } finally {
        if (!canceled) setLoading(false)
      }
    }

    void load()
    return () => {
      canceled = true
    }
  }, [enabled, folderPath])

  const reset = useCallback(() => {
    loadedForPathRef.current = null
    setAllFiles([])
  }, [])

  return {
    allFiles,
    loading,
    loaded: loadedForPathRef.current === folderPath,
    reset,
  }
}
