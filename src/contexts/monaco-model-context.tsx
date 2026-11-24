"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import type { Monaco } from "@monaco-editor/react"
import {
  collectLiveModelPaths,
  disposeClosedEditorModels,
} from "@/lib/monaco-model-path"

type TrackMonacoModel = (path: string, monaco: Monaco) => void
const MonacoModelContext = createContext<TrackMonacoModel | null>(null)

/** Own models across mobile pane unmounts, loading Monaco only via an editor. */
export function MonacoModelProvider({
  fileTabs,
  children,
}: {
  fileTabs: ReadonlyArray<{ id: string; path: string | null }>
  children?: ReactNode
}) {
  const tracked = useRef(new Set<string>())
  const monacoRef = useRef<Monaco | null>(null)
  const mounted = useRef(false)
  const trackModel = useCallback<TrackMonacoModel>((path, monaco) => {
    monacoRef.current = monaco
    tracked.current.add(path)
  }, [])
  const sweep = useCallback((live: ReadonlySet<string>) => {
    const monaco = monacoRef.current
    if (!monaco) return
    disposeClosedEditorModels(tracked.current, live, (uri) =>
      monaco.editor.getModel(monaco.Uri.parse(uri))
    )
  }, [])
  // Content changes must not resweep; complete buffer membership owns lifetime.
  const liveKey = useMemo(
    () => collectLiveModelPaths(fileTabs).join("\n"),
    [fileTabs]
  )
  useEffect(() => {
    // Child editor effects (including mobile unmount/detach) run first.
    sweep(new Set(liveKey ? liveKey.split("\n") : []))
  }, [liveKey, sweep])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // Parent cleanup precedes child cleanup. Wait for editor detachment,
      // and allow StrictMode's immediate remount to cancel shutdown disposal.
      queueMicrotask(() => {
        if (!mounted.current) sweep(new Set())
      })
    }
  }, [sweep])
  return (
    <MonacoModelContext.Provider value={trackModel}>
      {children}
    </MonacoModelContext.Provider>
  )
}

export function useTrackMonacoModel(): TrackMonacoModel {
  const track = useContext(MonacoModelContext)
  if (!track) throw new Error("Monaco models require WorkspaceProvider")
  return track
}
