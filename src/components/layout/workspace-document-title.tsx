"use client"

import { useEffect } from "react"

import { useAssistantsBadge } from "@/components/layout/sidebar"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { usePrimaryAgent } from "@/contexts/personal-agent-context"
import { isDesktop } from "@/lib/platform"

/** The page's title: the folder, and on the web — no dock to badge — how
 *  many assistants have something unread, "(2) …" (10.10). */
export function WorkspaceDocumentTitle() {
  const { activeFolder } = useActiveFolder()
  const { snapshot, needsOwner } = usePrimaryAgent()
  const { unreadBots } = useAssistantsBadge(
    snapshot?.agent?.id ?? null,
    snapshot?.status.unseen ?? 0,
    needsOwner
  )
  const count = isDesktop() ? 0 : unreadBots

  useEffect(() => {
    const base = activeFolder ? `${activeFolder.name} - codeg` : "codeg"
    document.title = count > 0 ? `(${count}) ${base}` : base
  }, [activeFolder, count])

  return null
}
