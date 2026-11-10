"use client"

import type { ReactNode } from "react"

import { ViewedPersonalAgentProvider } from "@/contexts/personal-agent-context"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

/** The assistant the page shows, as the roster picked it: what
 *  `usePersonalAgent` reads under it. */
export function PersonalAgentViewScope({ children }: { children: ReactNode }) {
  const viewBot = usePersonalAgentUi((s) => s.viewBot)
  return (
    <ViewedPersonalAgentProvider viewBot={viewBot}>
      {children}
    </ViewedPersonalAgentProvider>
  )
}
