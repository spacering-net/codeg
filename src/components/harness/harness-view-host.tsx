"use client"

import { useEffect, type ReactNode } from "react"

import { HarnessViewProvider } from "@/contexts/harness-view-context"
import { refreshHarnessStatus, useHarnessStatus } from "@/lib/harness/status"

/**
 * `HarnessViewProvider`, told whether this window's host offers the catalog.
 *
 * The provider takes `discoverEnabled` as a prop and knows nothing of where
 * it comes from; this is where it comes from. The backend is asked once the
 * workspace is up (`harness_status`), and until it answers the provider runs
 * on the last answer this device got from the same host — on by default — so
 * the Discover section neither appears a moment late nor disappears a moment
 * after it was drawn.
 *
 * A backend that does not know the command is not a backend that switched
 * the catalog off: the section stays, and says that the Codeg on the other
 * end needs updating (see `lib/harness/status.ts`).
 */
export function HarnessViewHost({ children }: { children: ReactNode }) {
  const { enabled } = useHarnessStatus()

  useEffect(() => {
    void refreshHarnessStatus()
  }, [])

  return (
    <HarnessViewProvider discoverEnabled={enabled}>
      {children}
    </HarnessViewProvider>
  )
}
