"use client"

import type { ReactNode } from "react"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"
import { cn } from "@/lib/utils"

/** Pane changes hide live conversations without releasing their runtimes. */
export function MobileWorkspacePanes({
  showConversation,
  children,
  files,
}: {
  showConversation: boolean
  children: ReactNode
  files: ReactNode
}) {
  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <OverlayHostHiddenProvider hidden={!showConversation}>
        <section
          className={cn(
            "flex h-full min-h-0 flex-col overflow-hidden",
            !showConversation && "conversation-tab-hidden invisible"
          )}
          data-workspace-pane="conversation"
          aria-hidden={!showConversation}
          inert={!showConversation || undefined}
        >
          <div className="relative flex-1 min-h-0 overflow-hidden">
            {children}
          </div>
        </section>
      </OverlayHostHiddenProvider>
      {!showConversation ? (
        <section
          className="absolute inset-0 flex min-h-0 flex-col overflow-hidden"
          data-workspace-pane="files"
        >
          {files}
        </section>
      ) : null}
    </div>
  )
}
