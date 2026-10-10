"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Play, Plus, Square, Terminal } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useTerminalContext } from "@/contexts/terminal-context"
import {
  bootstrapFolderCommandsFromPackageJson,
  listFolderCommands,
  terminalStop,
} from "@/lib/api"
import type { FolderCommand } from "@/lib/types"
import {
  resolveLiveCommandTerminalId,
  useCommandTerminalLinkStore,
} from "@/stores/command-terminal-link-store"
import { cn } from "@/lib/utils"
import { CommandManageDialog } from "./command-manage-dialog"

function getSelectedCommandId(folderId: number): number | null {
  try {
    const v = localStorage.getItem(`lastCmd:${folderId}`)
    return v ? Number(v) : null
  } catch {
    return null
  }
}

function setSelectedCommandId(folderId: number, cmdId: number) {
  try {
    localStorage.setItem(`lastCmd:${folderId}`, String(cmdId))
  } catch {
    /* ignore */
  }
}

export function CommandDropdown() {
  const t = useTranslations("Folder.commandDropdown")
  const { activeFolder: folder } = useActiveFolder()
  const {
    createTerminalWithCommand,
    exitedTerminals,
    tabs: terminalTabs,
  } = useTerminalContext()
  const [commands, setCommands] = useState<FolderCommand[]>([])
  const [manageOpen, setManageOpen] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(false)
  const [selectedCommandId, setSelectedCommandIdState] = useState<
    number | null
  >(null)
  // The command↔terminal linkage lives in a module-level store so it survives
  // this component unmounting when the right sidebar is closed (see the store
  // for the full rationale). Liveness is derived against the terminal context
  // below, so a persisted link whose terminal has since ended reads as
  // not-running rather than a stale "Stop".
  const links = useCommandTerminalLinkStore((s) => s.links)
  const setLink = useCommandTerminalLinkStore((s) => s.setLink)
  const clearLink = useCommandTerminalLinkStore((s) => s.clearLink)
  const pruneTerminals = useCommandTerminalLinkStore((s) => s.pruneTerminals)

  const folderId = folder?.id ?? 0
  const folderPath = folder?.path ?? ""

  const isTerminalLive = useCallback(
    (terminalId: string) =>
      !exitedTerminals.has(terminalId) &&
      terminalTabs.some((t) => t.id === terminalId),
    [exitedTerminals, terminalTabs]
  )

  // Drop links whose terminal has exited or whose tab was closed. These also
  // reconcile on (re)mount, so reopening the sidebar sheds any link whose
  // terminal vanished while it was closed.
  useEffect(() => {
    if (exitedTerminals.size === 0) return
    pruneTerminals((termId) => exitedTerminals.has(termId))
  }, [exitedTerminals, pruneTerminals])

  useEffect(() => {
    const tabIds = new Set(terminalTabs.map((t) => t.id))
    pruneTerminals((termId) => !tabIds.has(termId))
  }, [terminalTabs, pruneTerminals])

  // The remembered selection is persisted to localStorage ONLY here — i.e. only
  // on an explicit user pick or a run (see handleSelectCommand / runCommand) —
  // so it survives the panel reopening and folder switches, and is never
  // clobbered by a transient fallback. Display self-heals via `activeCmd`'s
  // `?? commands[0]` when the remembered command is missing.
  const selectCommand = useCallback(
    (commandId: number) => {
      if (!folderId) return
      setSelectedCommandId(folderId, commandId)
      setSelectedCommandIdState(commandId)
    },
    [folderId]
  )

  useEffect(() => {
    if (!folderId) {
      setSelectedCommandIdState(null)
      return
    }
    setSelectedCommandIdState(getSelectedCommandId(folderId))
  }, [folderId])

  // Monotonic epoch guarding async command loads: bumped on every folder change
  // (load effect below) and on every refreshCommands call, so a slow response
  // for a previous folder or a superseded refresh can't overwrite newer state.
  const loadEpochRef = useRef(0)

  const refreshCommands = useCallback(async () => {
    if (!folderId) return
    const epoch = (loadEpochRef.current += 1)
    try {
      const list = await listFolderCommands(folderId)
      if (epoch !== loadEpochRef.current) return
      setCommands(list)
    } catch (err) {
      console.error("Failed to load commands:", err)
    }
  }, [folderId])

  useEffect(() => {
    if (!folderId) return
    loadEpochRef.current += 1
    let ignore = false
    const loadCommands = async () => {
      try {
        setBootstrapping(false)
        const data = await listFolderCommands(folderId)
        if (ignore) return

        if (data.length > 0 || !folderPath) {
          setCommands(data)
          return
        }

        setBootstrapping(true)
        const bootstrapped = await bootstrapFolderCommandsFromPackageJson(
          folderId,
          folderPath
        )
        if (!ignore) setCommands(bootstrapped)
      } catch (err) {
        console.error("Failed to load commands:", err)
      } finally {
        if (!ignore) setBootstrapping(false)
      }
    }

    loadCommands()

    return () => {
      ignore = true
    }
  }, [folderId, folderPath])

  const runCommand = useCallback(
    async (cmd: FolderCommand) => {
      if (!folderPath) return
      // Don't double-launch a command that already has a *live* terminal; a
      // stale link (dead terminal) must not block a restart, hence the liveness
      // check rather than a bare presence check.
      if (
        resolveLiveCommandTerminalId(
          useCommandTerminalLinkStore.getState().links,
          cmd.id,
          isTerminalLive
        )
      )
        return

      selectCommand(cmd.id)
      const terminalId = await createTerminalWithCommand(
        cmd.name,
        cmd.command,
        cmd.id
      )
      if (!terminalId) return

      setLink(cmd.id, terminalId)
    },
    [
      createTerminalWithCommand,
      folderPath,
      isTerminalLive,
      selectCommand,
      setLink,
    ]
  )

  const stopCommand = useCallback(
    async (cmd: FolderCommand) => {
      const terminalId = useCommandTerminalLinkStore.getState().links[cmd.id]
      if (!terminalId) return

      clearLink(cmd.id)
      try {
        // The tab stays open with what the command printed, so the backend
        // keeps that output for it — a reload of the tab still shows it.
        await terminalStop(terminalId)
      } catch (err) {
        console.error("Failed to stop command terminal:", err)
      }
    },
    [clearLink]
  )

  const activeCmd = useMemo(
    () =>
      commands.find((c) => c.id === selectedCommandId) ?? commands[0] ?? null,
    [commands, selectedCommandId]
  )
  const activeTerminalId = activeCmd
    ? resolveLiveCommandTerminalId(links, activeCmd.id, isTerminalLive)
    : undefined
  const isActiveCommandRunning = Boolean(activeTerminalId)

  const handleRunOrStop = useCallback(() => {
    if (!activeCmd) return
    if (isActiveCommandRunning) {
      void stopCommand(activeCmd)
      return
    }
    void runCommand(activeCmd)
  }, [activeCmd, isActiveCommandRunning, runCommand, stopCommand])

  const handleSelectCommand = useCallback(
    (cmd: FolderCommand) => {
      selectCommand(cmd.id)
    },
    [selectCommand]
  )

  if (!folder) return null

  // The trigger varies with command count, but the manage dialog is rendered
  // once outside the branch so saving the first command (which flips the
  // trigger from the add-button to the split-button) never remounts and closes
  // the dialog mid-edit.
  return (
    <>
      {commands.length === 0 ? (
        // No commands → show add command button
        <Button
          variant="ghost"
          size="sm"
          className="h-6 rounded-full px-2 text-xs gap-1 hover:text-foreground/80"
          onClick={() => setManageOpen(true)}
          disabled={bootstrapping}
        >
          <Plus className="h-3 w-3" />
          {bootstrapping ? t("loading") : t("addCommand")}
        </Button>
      ) : (
        // Has commands → one cohesive control: [name ▼ | run/stop]. The whole
        // pill highlights as a SINGLE unit on hover (background overlay on the
        // group container, not on each half), so the two affordances read as one
        // command block rather than two adjacent buttons. `bg-foreground/10` is a
        // translucent overlay on purpose: the status-bar surface is already
        // `--muted`, so a `bg-muted`/`bg-accent` hover would be invisible against
        // it in light mode.
        <div className="group/cmd flex items-center rounded-full text-xs transition-colors hover:bg-foreground/10">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-6 min-w-0 items-center gap-1 rounded-l-full pr-1.5 pl-2 text-muted-foreground outline-none transition-colors hover:text-foreground"
              >
                <Terminal className="h-3 w-3 shrink-0" />
                <span className="max-w-24 truncate">{activeCmd?.name}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              {commands.map((cmd) => (
                <DropdownMenuItem
                  key={cmd.id}
                  onClick={() => handleSelectCommand(cmd)}
                  className={`flex items-center justify-between gap-4 ${
                    cmd.id === activeCmd?.id ? "bg-accent/60" : ""
                  }`}
                >
                  <span className="truncate">{cmd.name}</span>
                  <span className="text-xs text-muted-foreground font-mono truncate max-w-32">
                    {cmd.command}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setManageOpen(true)}>
                {t("manageCommands")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Hairline divider stays visible — and brightens — while the block
              is hovered, so the two halves read as separate actions inside the
              shared pill. Each half lights only its own text/icon on hover. */}
          <span
            aria-hidden
            className="h-3 w-px shrink-0 bg-border/70 transition-colors group-hover/cmd:bg-foreground/20"
          />
          <button
            type="button"
            onClick={handleRunOrStop}
            title={
              isActiveCommandRunning
                ? t("stopCommandTitle", { command: activeCmd?.command ?? "" })
                : t("runCommandTitle", { command: activeCmd?.command ?? "" })
            }
            className={cn(
              "flex h-6 items-center rounded-r-full pr-2 pl-1.5 outline-none transition-colors",
              isActiveCommandRunning
                ? "text-destructive"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {isActiveCommandRunning ? (
              <Square className="h-3 w-3" />
            ) : (
              <Play className="h-3 w-3" />
            )}
          </button>
        </div>
      )}

      <CommandManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        folderId={folderId}
        onChanged={refreshCommands}
      />
    </>
  )
}
