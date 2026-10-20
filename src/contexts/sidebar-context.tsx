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
import { detectPlatform } from "@/hooks/use-platform"
import {
  loadPersistedPanelState,
  savePersistedPanelState,
} from "@/lib/panel-state-storage"
import { isDesktop } from "@/lib/platform"
import { MAC_TRAFFIC_LIGHT_INSET } from "@/lib/window-chrome"

const STORAGE_KEY = "workspace:left-sidebar"

const DEFAULT_WIDTH = 320
// The sidebar header is the window's top-left edge: its top-left is reserved
// for the fixed window-chrome overlay (sidebar toggle + search) and its
// top-right holds the view controls, so it needs more room than the old 200.
const BASE_MIN_WIDTH = 224
const MAX_WIDTH = 900
const DEFAULT_IS_OPEN = true

/**
 * The narrowest the sidebar may be dragged. On the macOS desktop app the native
 * traffic lights sit at the header's far left, ahead of the chrome overlay, so
 * only there does the minimum add their inset (224 + 76 = 300). Windows, Linux
 * and the browser have no traffic lights: sized for them anyway, the column
 * bottomed out 76px wider than anything in it needs, which is why it read as
 * so much wider than on macOS. Both minimums leave the header the same room
 * for the overlay and the view controls.
 */
export function resolveSidebarMinWidth(): number {
  const macTrafficLights = isDesktop() && detectPlatform() === "macos"
  return BASE_MIN_WIDTH + (macTrafficLights ? MAC_TRAFFIC_LIGHT_INSET : 0)
}

interface SidebarContextValue {
  isOpen: boolean
  restored: boolean
  width: number
  minWidth: number
  maxWidth: number
  toggle: () => void
  setWidth: (w: number) => void
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

export function useSidebarContext() {
  const ctx = useContext(SidebarContext)
  if (!ctx) {
    throw new Error("useSidebarContext must be used within SidebarProvider")
  }
  return ctx
}

function clampWidth(width: number, minWidth: number) {
  return Math.max(minWidth, Math.min(MAX_WIDTH, width))
}

interface SidebarProviderProps {
  children: ReactNode
}

export function SidebarProvider({ children }: SidebarProviderProps) {
  const storageKey = STORAGE_KEY
  const [isOpen, setIsOpen] = useState(DEFAULT_IS_OPEN)
  const [width, setWidthState] = useState(DEFAULT_WIDTH)
  const [restored, setRestored] = useState(false)
  // Platform-derived minimum (see resolveSidebarMinWidth); stable for the
  // session.
  const minWidth = useMemo(() => resolveSidebarMinWidth(), [])

  const toggle = useCallback(() => setIsOpen((prev) => !prev), [])

  const setWidth = useCallback(
    (w: number) => {
      setWidthState(clampWidth(w, minWidth))
    },
    [minWidth]
  )

  useEffect(() => {
    const stored = loadPersistedPanelState(storageKey)
    // On mobile (< 768px), always start closed regardless of persisted state.
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

  const value = useMemo(
    () => ({
      isOpen,
      restored,
      width,
      minWidth,
      maxWidth: MAX_WIDTH,
      toggle,
      setWidth,
    }),
    [isOpen, restored, width, minWidth, toggle, setWidth]
  )

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  )
}
