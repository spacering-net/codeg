"use client"

import { useMemo, useState } from "react"
import { useReactFlow } from "@xyflow/react"
import {
  Bot,
  FileText,
  Folder,
  FolderOpen,
  Layers,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  Sparkles,
  SquareTerminal,
  StickyNote,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkspaceFileTabs } from "@/contexts/workspace-context"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { useFileTree } from "@/hooks/use-file-tree"
import type { CreateCanvasNodeInput } from "@/lib/api"
import { formatConversationTitle } from "@/lib/conversation-title"
import { getAgentLabel } from "@/lib/custom-agents"
import { rankFileMatches } from "@/lib/file-search-match"
import { joinRootRel, normalizeAbsPath } from "@/lib/file-open-target"
import { formatFolderLabelWithAlias } from "@/lib/folder-display"
import { openFileDialog } from "@/lib/platform"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  FILE_CARD_HEIGHT,
  FILE_CARD_WIDTH,
  TERMINAL_CARD_HEIGHT,
  TERMINAL_CARD_WIDTH,
  basePathName,
  compareByRecency,
  isCanvasEligible,
} from "./canvas-model"

/** Default footprints for freshly added elements (region fits a 3-column
 *  member grid; see canvas-model geometry). */
const REGION_W = 720
const REGION_H = 344
export const NOTE_W = 208
/** A note is as tall as a collapsed card on purpose: notes are annotations ON
 *  the board's rows, and one dropped beside a row of cards should line up with
 *  it rather than hang off the bottom. Derived rather than copied so it cannot
 *  drift the next time the card's box changes. */
export const NOTE_H = CARD_HEIGHT

interface AddNodeMenuProps {
  onCreate: (input: CreateCanvasNodeInput) => void
  /** Drop a client-local draft conversation card at a canvas point. Nothing is
   *  persisted until the first message — see `canvas-view`'s draft handling.
   *  Where the conversation will live is the view's call
   *  (`resolveNewConversationTarget`), not a question for this menu. */
  onNewConversation: (point: { x: number; y: number }) => void
  /** Extra classes for the trigger button (toolbar styling owns the look). */
  triggerClassName?: string
  /** Which way the menu opens — "top" for the bottom dock. */
  side?: "top" | "bottom"
}

/**
 * The toolbar "+" menu: every way to put something new on the canvas — a
 * folder region (open workspace folders), an agent region (installed agents),
 * a single conversation card (recent root conversations, filterable), a file
 * card (read-only, see `AddFileSubmenu`), a terminal card in a folder's
 * directory, a hand-curated custom region, or a sticky note.
 */
export function AddNodeMenu({
  onCreate,
  onNewConversation,
  triggerClassName,
  side = "bottom",
}: AddNodeMenuProps) {
  const t = useTranslations("Canvas")
  const { screenToFlowPosition } = useReactFlow()
  const folders = useAppWorkspaceStore((s) => s.folders)
  const folderGroups = useAppWorkspaceStore((s) => s.folderGroups)
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const { agents } = useAcpAgents()
  const [query, setQuery] = useState("")

  const recentConversations = useMemo(() => {
    const eligible = conversations.filter(isCanvasEligible)
    eligible.sort(compareByRecency)
    const q = query.trim().toLowerCase()
    const filtered = q
      ? eligible.filter((c) => (c.title ?? "").toLowerCase().includes(q))
      : eligible
    return filtered.slice(0, 15)
  }, [conversations, query])

  /** Viewport-center drop point for a new element, nudged per call so two
   *  adds in a row don't stack perfectly. */
  const dropPoint = (width: number, height: number) => {
    const center = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    const jitter = () => Math.round(Math.random() * 64 - 32)
    return {
      x: center.x - width / 2 + jitter(),
      y: center.y - height / 2 + jitter(),
    }
  }

  const createRegion = (
    partial: Partial<CreateCanvasNodeInput> & {
      kind: CreateCanvasNodeInput["kind"]
    }
  ) => {
    const { x, y } = dropPoint(REGION_W, REGION_H)
    onCreate({ x, y, width: REGION_W, height: REGION_H, ...partial })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          aria-label={t("addNode")}
          title={t("addNode")}
        >
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={side} className="w-52">
        {/* One click, one card. The folder it belongs to is the workspace's
            active one (chat mode when there is none) — the same answer the tab
            strip's new-conversation button gives without asking, and the card's
            own folder chip stays editable right up to the first message. */}
        <DropdownMenuItem
          onSelect={() =>
            onNewConversation(dropPoint(DETAIL_CARD_WIDTH, DETAIL_CARD_HEIGHT))
          }
        >
          <MessageSquarePlus className="text-muted-foreground" />
          {t("newConversation")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Folder className="text-muted-foreground" />
            {t("addFolderRegion")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {folders.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t("noFolders")}
              </div>
            ) : (
              folders.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  onSelect={() =>
                    createRegion({ kind: "folder", folderId: f.id })
                  }
                >
                  <Folder className="text-muted-foreground" />
                  <span className="min-w-0 truncate">
                    {formatFolderLabelWithAlias(f)}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Layers className="text-muted-foreground" />
            {t("addGroupRegion")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {folderGroups.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t("noGroups")}
              </div>
            ) : (
              folderGroups.map((g) => (
                <DropdownMenuItem
                  key={g.id}
                  onSelect={() =>
                    createRegion({ kind: "group", folderGroupId: g.id })
                  }
                >
                  <Layers className="text-muted-foreground" />
                  <span className="min-w-0 truncate">{g.name}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Bot className="text-muted-foreground" />
            {t("addAgentRegion")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {agents.map((a) => (
              <DropdownMenuItem
                key={a.agent_type}
                onSelect={() =>
                  createRegion({ kind: "agent", agentType: a.agent_type })
                }
              >
                <AgentIcon agentType={a.agent_type} className="size-4" />
                <span className="min-w-0 truncate">
                  {getAgentLabel(a.agent_type)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <MessageSquare className="text-muted-foreground" />
            {t("addConversationCard")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchConversations")}
              className="mx-1 mb-1 w-[calc(100%-0.5rem)] rounded-lg border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => e.stopPropagation()}
            />
            <div className="max-h-64 overflow-y-auto">
              {recentConversations.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t("noConversations")}
                </div>
              ) : (
                recentConversations.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onSelect={() => {
                      const { x, y } = dropPoint(CARD_WIDTH, CARD_HEIGHT)
                      onCreate({
                        kind: "conversation",
                        conversationId: c.id,
                        x,
                        y,
                        width: CARD_WIDTH,
                        height: CARD_HEIGHT,
                      })
                    }}
                  >
                    <AgentIcon agentType={c.agent_type} className="size-4" />
                    <span className="min-w-0 truncate">
                      {c.title
                        ? formatConversationTitle(c.title)
                        : t("untitled")}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <AddFileSubmenu
          onPick={(absPath) => {
            const { x, y } = dropPoint(FILE_CARD_WIDTH, FILE_CARD_HEIGHT)
            onCreate({
              kind: "file",
              path: absPath,
              x,
              y,
              width: FILE_CARD_WIDTH,
              height: FILE_CARD_HEIGHT,
            })
          }}
        />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SquareTerminal className="text-muted-foreground" />
            {t("addTerminalCard")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {folders.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t("noFolders")}
              </div>
            ) : (
              folders.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  onSelect={() => {
                    const { x, y } = dropPoint(
                      TERMINAL_CARD_WIDTH,
                      TERMINAL_CARD_HEIGHT
                    )
                    onCreate({
                      kind: "terminal",
                      // The folder's path, not its id: a terminal card outlives
                      // the folder being closed, and a shell that has to look
                      // up where it lives every time it starts is a shell that
                      // stops starting the day that lookup fails.
                      path: normalizeAbsPath(f.path),
                      x,
                      y,
                      width: TERMINAL_CARD_WIDTH,
                      height: TERMINAL_CARD_HEIGHT,
                    })
                  }}
                >
                  <SquareTerminal className="text-muted-foreground" />
                  <span className="min-w-0 truncate">
                    {formatFolderLabelWithAlias(f)}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => createRegion({ kind: "custom" })}>
          <Sparkles className="text-muted-foreground" />
          {t("addCustomRegion")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            const { x, y } = dropPoint(NOTE_W, NOTE_H)
            onCreate({
              kind: "note",
              x,
              y,
              width: NOTE_W,
              height: NOTE_H,
            })
          }}
        >
          <StickyNote className="text-muted-foreground" />
          {t("addNote")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** How many ranked file matches the picker shows. Long enough to scroll a
 *  little, short enough that the submenu stays a menu. */
const FILE_RESULT_LIMIT = 20

/**
 * "Add a file card" — the picker for which file.
 *
 * Two sources, because a board is not scoped to one folder but a file search
 * has to be: with no query it lists the files ALREADY OPEN in the workspace
 * (cross-folder, instant, and almost always what the user means), and typing
 * searches the active folder through the same gitignore-aware backend walk the
 * search dialog and the composer's `@` picker use. "Browse…" covers everything
 * outside a workspace folder.
 *
 * The walk is lazy: `useFileTree` only fetches once `enabled` goes true, which
 * happens when the submenu opens — a board that never adds a file never pays
 * for the listing.
 */
function AddFileSubmenu({ onPick }: { onPick: (absPath: string) => void }) {
  const t = useTranslations("Canvas")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)
  const { fileTabs } = useWorkspaceFileTabs()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const searchFolder = useMemo(() => {
    const active = folders.find((f) => f.id === activeFolderId)
    // Chat folders are a bookkeeping row with a scratch directory behind them,
    // not a place the user filed anything — fall back to the first real folder.
    if (active && active.kind !== "chat") return active
    return folders.find((f) => f.kind !== "chat") ?? null
  }, [activeFolderId, folders])

  const { allFiles, loading } = useFileTree({
    folderPath: searchFolder?.path,
    enabled: open && searchFolder != null,
  })

  const results = useMemo(() => {
    if (!query.trim() || !searchFolder) return []
    return rankFileMatches(
      query,
      allFiles.filter((f) => f.kind === "file"),
      FILE_RESULT_LIMIT
    ).map((f) => ({
      key: f.relativePath,
      label: f.name,
      hint: f.relativePath,
      absPath: joinRootRel(searchFolder.path, f.relativePath),
    }))
  }, [allFiles, query, searchFolder])

  /** Files already open in the workspace — the no-query listing. */
  const openFiles = useMemo(
    () =>
      fileTabs
        .filter(
          (tab): tab is typeof tab & { path: string } =>
            tab.kind === "file" &&
            typeof tab.path === "string" &&
            tab.path !== ""
        )
        .slice(0, FILE_RESULT_LIMIT)
        .map((tab) => ({
          key: tab.id,
          label: basePathName(tab.path),
          hint: tab.path,
          absPath: tab.path,
        })),
    [fileTabs]
  )

  const items = query.trim() ? results : openFiles
  // A native dialog picks a path on THIS machine; a desktop window driving a
  // remote backend would hand the server a path it cannot read, and the web
  // fallback only ever learns a bare file name. Both get the search instead.
  const canBrowse = isDesktop() && !isRemoteDesktopMode()

  const browse = async () => {
    const picked = await openFileDialog({ title: t("addFileCard") }).catch(
      () => null
    )
    const path = Array.isArray(picked) ? picked[0] : picked
    if (path) onPick(normalizeAbsPath(path))
  }

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>
        <FileText className="text-muted-foreground" />
        {t("addFileCard")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            searchFolder
              ? t("searchFilesIn", {
                  folder: formatFolderLabelWithAlias(searchFolder),
                })
              : t("searchFiles")
          }
          disabled={!searchFolder}
          className="mx-1 mb-1 w-[calc(100%-0.5rem)] rounded-lg border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          // The menu treats printable keys as type-ahead navigation; the input
          // owns them while it has focus.
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div className="max-h-64 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {loading && query.trim()
                ? t("searchingFiles")
                : query.trim()
                  ? t("noFiles")
                  : t("noOpenFiles")}
            </div>
          ) : (
            items.map((item) => (
              <DropdownMenuItem
                key={item.key}
                onSelect={() => onPick(normalizeAbsPath(item.absPath))}
                title={item.hint}
              >
                <FileText className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </DropdownMenuItem>
            ))
          )}
        </div>
        {canBrowse && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void browse()}>
              <FolderOpen className="text-muted-foreground" />
              {t("browseForFile")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
