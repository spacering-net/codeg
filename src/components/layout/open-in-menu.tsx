"use client"

import { FolderClosed, SquareTerminal } from "lucide-react"

import { VSCodeIcon } from "@/components/vscode-icon"
import {
  ContextMenuItem,
  ContextMenuSubContent,
} from "@/components/ui/context-menu"
import { isRemoteDesktopWindow } from "@/lib/platform"

const itemClassName = "gap-1.5 px-3"

export function OpenInSubContent({
  explorerLabel,
  terminalLabel,
  codeLabel,
  onOpenExplorer,
  onOpenTerminal,
  onOpenCode,
  explorerDisabled,
}: {
  explorerLabel: string
  terminalLabel: string
  codeLabel: string
  onOpenExplorer: () => void
  onOpenTerminal: () => void
  onOpenCode: () => void
  explorerDisabled?: boolean
}) {
  // `open_in_code` runs on whichever host owns the path, so a remote-desktop
  // window would pop the editor up on the far machine and look like a no-op
  // here. Same reasoning `isLocalDesktop` documents for "reveal in file
  // manager" — don't render a dead row.
  const codeDisabled = isRemoteDesktopWindow()
  return (
    <ContextMenuSubContent className="min-w-0 w-max">
      <ContextMenuItem
        className={itemClassName}
        disabled={explorerDisabled}
        onSelect={onOpenExplorer}
      >
        <FolderClosed />
        {explorerLabel}
      </ContextMenuItem>
      <ContextMenuItem className={itemClassName} onSelect={onOpenTerminal}>
        <SquareTerminal />
        {terminalLabel}
      </ContextMenuItem>
      <ContextMenuItem
        className={itemClassName}
        disabled={codeDisabled}
        onSelect={onOpenCode}
      >
        <VSCodeIcon />
        {codeLabel}
      </ContextMenuItem>
    </ContextMenuSubContent>
  )
}
