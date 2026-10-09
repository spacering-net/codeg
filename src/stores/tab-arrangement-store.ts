"use client"

import { create } from "zustand"
import { TAB_ARRANGE_MODES, type TabArrangeMode } from "@/lib/tab-arrangement"

/** Per-device display preference, like the sidebar's view options. */
const STORAGE_KEY = "workspace:tab-arrange-mode"

function loadMode(): TabArrangeMode {
  if (typeof window === "undefined") return "manual"
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return (TAB_ARRANGE_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as TabArrangeMode)
      : "manual"
  } catch {
    return "manual"
  }
}

interface TabArrangeState {
  mode: TabArrangeMode
  hydrated: boolean
  /** Read the stored choice. Called from an effect (not at module load) so the
   *  first client render matches the prerendered HTML. Idempotent. */
  hydrate: () => void
  setMode: (mode: TabArrangeMode) => void
}

export const useTabArrangeStore = create<TabArrangeState>((set, get) => ({
  mode: "manual",
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return
    set({ mode: loadMode(), hydrated: true })
  },
  setMode: (mode) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // Private mode / quota: the choice still applies for this session.
    }
    set({ mode, hydrated: true })
  },
}))
