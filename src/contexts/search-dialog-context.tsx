"use client"

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"

interface SearchDialogContextValue {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
}

const SearchDialogContext = createContext<SearchDialogContextValue | null>(null)

/**
 * Shared open-state for the conversation search command dialog.
 *
 * The dialog itself, and the global ⌘K shortcut that toggles it, are owned by
 * `WorkspaceChromeController` (which is always mounted, desktop + mobile). The
 * trigger buttons live elsewhere: `LeftEdgeChrome` on desktop, `FolderTitleBar`
 * on mobile. Lifting just the boolean here lets any of them open the dialog
 * without owning it — including surfaces that unmount, which is why the trigger
 * was moved out of the sidebar in the first place.
 *
 * `setOpen` is the raw state setter so callers can use the functional updater
 * form (the shortcut handler does `setOpen((prev) => !prev)`).
 */
export function useSearchDialog() {
  const ctx = useContext(SearchDialogContext)
  if (!ctx) {
    throw new Error("useSearchDialog must be used within SearchDialogProvider")
  }
  return ctx
}

export function SearchDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const value = useMemo<SearchDialogContextValue>(
    () => ({ open, setOpen }),
    [open]
  )

  return (
    <SearchDialogContext.Provider value={value}>
      {children}
    </SearchDialogContext.Provider>
  )
}
