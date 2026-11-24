"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  loadPersistedPanelState,
  savePersistedPanelState,
} from "@/lib/panel-state-storage"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { detectPlatform } from "@/hooks/use-platform"
import type { AuxPanelTab } from "@/lib/aux-panel-tab-order"
import { isDesktop } from "@/lib/platform"

// Defined beside the list it is derived from, so the tab ids and the stored
// rail order can't drift apart.
export type { AuxPanelTab }

const STORAGE_KEY = "workspace:right-sidebar"

const DEFAULT_WIDTH = 320
const MIN_WIDTH = 200
const MAX_WIDTH = 900
const DEFAULT_IS_OPEN = false

// The tabs sit on the vertical rail at the panel's right edge, below the fixed
// top-right window-chrome overlay (terminal/aux/settings), so they need no
// extra width to clear it. The minimum only has to keep that overlay — and, on
// Windows/Linux, the native caption strip beside it (~116 + 138) — from
// spilling past the panel's left edge over the middle column. Elsewhere the
// base 200 is plenty.
function resolveAuxMinWidth(): number {
  const platform = detectPlatform()
  if (isDesktop() && (platform === "windows" || platform === "linux")) {
    return 260
  }
  return MIN_WIDTH
}

interface AuxPanelContextValue {
  isOpen: boolean
  restored: boolean
  width: number
  minWidth: number
  maxWidth: number
  activeTab: AuxPanelTab
  toggle: () => void
  /** Imperatively set the panel open/closed (used by the chat-mode auto-hide). */
  setOpen: (open: boolean) => void
  setWidth: (w: number) => void
  setActiveTab: (tab: AuxPanelTab) => void
  openTab: (tab: AuxPanelTab) => void
  pendingRevealPath: string | null
  revealInFileTree: (path: string) => void
  consumePendingRevealPath: () => void
}

const AuxPanelContext = createContext<AuxPanelContextValue | null>(null)

export function useAuxPanelContext() {
  const ctx = useContext(AuxPanelContext)
  if (!ctx) {
    throw new Error("useAuxPanelContext must be used within AuxPanelProvider")
  }
  return ctx
}

function clampWidth(width: number, minWidth: number) {
  return Math.max(minWidth, Math.min(MAX_WIDTH, width))
}

interface AuxPanelProviderProps {
  children: ReactNode
}

export function AuxPanelProvider({ children }: AuxPanelProviderProps) {
  const storageKey = STORAGE_KEY
  const { activeFolderId } = useActiveFolder()
  const [isOpen, setIsOpen] = useState(DEFAULT_IS_OPEN)
  const [width, setWidthState] = useState(DEFAULT_WIDTH)
  const [restored, setRestored] = useState(false)
  const [activeTab, setActiveTab] = useState<AuxPanelTab>("session_details")
  const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(
    null
  )
  // Platform-derived minimum (see resolveAuxMinWidth); stable for the session.
  const minWidth = useMemo(() => resolveAuxMinWidth(), [])

  const toggle = useCallback(() => setIsOpen((prev) => !prev), [])

  const setOpen = useCallback((open: boolean) => setIsOpen(open), [])

  const setWidth = useCallback(
    (w: number) => {
      setWidthState(clampWidth(w, minWidth))
    },
    [minWidth]
  )

  const openTab = useCallback((tab: AuxPanelTab) => {
    setActiveTab(tab)
    setIsOpen(true)
  }, [])

  const revealInFileTree = useCallback((path: string) => {
    setPendingRevealPath(path)
    setActiveTab("file_tree")
    setIsOpen(true)
  }, [])

  const consumePendingRevealPath = useCallback(() => {
    setPendingRevealPath(null)
  }, [])

  useEffect(() => {
    const stored = loadPersistedPanelState(storageKey)
    const isMobileViewport = window.innerWidth < 768
    const defaultOpen = isMobileViewport ? false : DEFAULT_IS_OPEN
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOpen(isMobileViewport ? false : (stored?.isOpen ?? defaultOpen))
    setWidthState(clampWidth(stored?.width ?? DEFAULT_WIDTH, minWidth))
    setRestored(true)
  }, [storageKey, minWidth])

  useEffect(() => {
    if (!restored) return
    savePersistedPanelState(storageKey, { isOpen, width })
  }, [isOpen, restored, storageKey, width])

  // Reset pending reveal path when the active folder changes; file tree
  // state is content-driven by the workspace contexts and will refetch
  // naturally via its folder-path dependency.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingRevealPath(null)
  }, [activeFolderId])

  const value = useMemo(
    () => ({
      isOpen,
      restored,
      width,
      minWidth,
      maxWidth: MAX_WIDTH,
      activeTab,
      toggle,
      setOpen,
      setWidth,
      setActiveTab,
      openTab,
      pendingRevealPath,
      revealInFileTree,
      consumePendingRevealPath,
    }),
    [
      isOpen,
      restored,
      width,
      minWidth,
      activeTab,
      toggle,
      setOpen,
      setWidth,
      openTab,
      pendingRevealPath,
      revealInFileTree,
      consumePendingRevealPath,
    ]
  )

  return (
    <AuxPanelContext.Provider value={value}>
      {children}
    </AuxPanelContext.Provider>
  )
}
