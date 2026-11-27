"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { AppWindow, File, Folder, Puzzle, Zap } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { listAllConversations } from "@/lib/api"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"
import { useFileTree, type FlatFileEntry } from "@/hooks/use-file-tree"
import { useScopedPluginCommands } from "@/hooks/use-scoped-plugin-commands"
import {
  matchesPluginCommandQuery,
  type ResolvedPluginCommand,
} from "@/lib/host-plugins"
import { rankFileMatches } from "@/lib/file-search-match"
import { compareAgentType } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"

type SearchTab = "conversations" | "files" | "commands"

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SearchCommandDialog({
  open,
  onOpenChange,
}: SearchCommandDialogProps) {
  const t = useTranslations("Folder.search")
  const locale = useLocale()
  const dateFnsLocale =
    locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : enUS
  const { activeFolder: folder, activeFolderId } = useActiveFolder()
  const allConversations = useAppWorkspaceStore((s) => s.conversations)
  const folderId = activeFolderId ?? 0
  const conversations = useMemo(
    () =>
      activeFolderId == null
        ? []
        : allConversations.filter((c) => c.folder_id === activeFolderId),
    [allConversations, activeFolderId]
  )
  const { openTab } = useTabActions()
  const { openConversations, openPluginScreen } = useWorkbenchRoute()
  const { openFilePreview } = useWorkspaceActions()
  const { revealInFileTree, openPluginPanel } = useAuxPanelContext()
  const {
    commands: pluginCommands,
    executeCommand: executePluginCommand,
    scopeLabel: pluginCommandScopeLabel,
  } = useScopedPluginCommands({
    enabled: open,
    openConversations,
    openPluginScreen,
    openPluginPanel,
  })

  const [activeTab, setActiveTab] = useState<SearchTab>("conversations")
  // The search box owns the keyboard: the dialog opens with the cursor in it,
  // and switching tabs or agent filters leaves it there, so typing always
  // searches.
  const inputRef = useRef<HTMLInputElement>(null)
  const switchTab = useCallback((tab: SearchTab) => {
    setActiveTab(tab)
    inputRef.current?.focus()
  }, [])
  const [query, setQuery] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] = useState<DbConversationSummary[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const folderPath = folder?.path ?? ""

  // File search via shared hook (lazy-loaded when files tab is active)
  const {
    allFiles,
    loading: filesLoading,
    reset: resetFileTree,
  } = useFileTree({
    folderPath: folderPath || undefined,
    enabled: open && activeTab === "files",
    query,
  })

  // Compute which agent types exist in current folder
  const availableAgents = Array.from(
    new Set(conversations.map((c) => c.agent_type))
  ).sort(compareAgentType)

  // The backend ranks the whole workspace before capping the response, so a
  // deeply nested match remains reachable without retaining the full index.
  const filteredFiles = useMemo(
    () => rankFileMatches(query, allFiles, 100),
    [allFiles, query]
  )

  const filteredPluginCommands = useMemo(
    () =>
      pluginCommands.filter((command) =>
        matchesPluginCommandQuery(command, query)
      ),
    [pluginCommands, query]
  )

  const hasPluginCommands = pluginCommands.length > 0
  const effectiveActiveTab: SearchTab =
    activeTab === "commands" && !hasPluginCommands ? "conversations" : activeTab

  const doSearch = useCallback(
    async (q: string, agent: AgentType | null) => {
      if (!q.trim() && !agent) {
        setResults([])
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const data = await listAllConversations({
          folder_ids: folderId > 0 ? [folderId] : null,
          search: q.trim() || null,
          agent_type: agent,
        })
        setResults(data)
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    },
    [folderId]
  )

  // Debounced search on query change (conversations tab only)
  useEffect(() => {
    if (effectiveActiveTab !== "conversations") return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(query, agentFilter)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, agentFilter, doSearch, effectiveActiveTab])

  // Reset state when dialog closes. Kept in an effect because it also resets
  // the shared file-tree hook (`resetFileTree`), which is not this component's
  // own state and so cannot be adjusted during render.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on close alongside the file-tree hook reset
      setQuery("")
      setAgentFilter(null)
      setResults([])
      setActiveTab("conversations")
      // Like the full re-list this replaced, each opening searches files as
      // they are now, not a native snapshot left over from before it opened.
      resetFileTree(true)
    }
  }, [open, resetFileTree])

  const handleSelectConversation = useCallback(
    (conv: DbConversationSummary) => {
      // Leave any workbench route (e.g. Automations) so the picked conversation
      // isn't stranded behind the route overlay — covers re-selecting the
      // already-active tab, which doesn't change activeTabId.
      openConversations()
      openTab(conv.folder_id, conv.id, conv.agent_type, true)
      onOpenChange(false)
    },
    [openTab, onOpenChange, openConversations]
  )

  const handleSelectFile = useCallback(
    (entry: FlatFileEntry) => {
      if (entry.kind === "dir") {
        revealInFileTree(entry.relativePath)
      } else {
        // Reveal parent directory in file tree, then open the file
        const lastSlash = entry.relativePath.lastIndexOf("/")
        if (lastSlash > 0) {
          revealInFileTree(entry.relativePath.slice(0, lastSlash))
        }
        openFilePreview(entry.relativePath)
      }
      onOpenChange(false)
    },
    [revealInFileTree, openFilePreview, onOpenChange]
  )

  const handleSelectPluginCommand = useCallback(
    (command: ResolvedPluginCommand) => {
      executePluginCommand(command)
      onOpenChange(false)
    },
    [executePluginCommand, onOpenChange]
  )

  const placeholder =
    effectiveActiveTab === "conversations"
      ? t("placeholder")
      : effectiveActiveTab === "files"
        ? t("filePlaceholder")
        : t("commandPlaceholder")

  return (
    <CommandDialog
      title={
        folder
          ? t("dialogTitleWithFolder", { name: folder.name })
          : t("dialogTitle")
      }
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={effectiveActiveTab === "conversations"}
      // Not `autoFocus`: an input focused while mounting takes focus before
      // the focus trap starts listening, so the trap never records it and has
      // nothing to pull focus back to when the chat composer behind the dialog
      // refocuses itself at the end of a turn — the rest of the query would be
      // typed into the composer.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        inputRef.current?.focus()
      }}
    >
      {/* Folder context header */}
      {folder && (
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">
            {t("dialogTitleWithFolder", { name: folder.name })}
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b px-3">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTab("conversations")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            effectiveActiveTab === "conversations"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabConversations")}
          {effectiveActiveTab === "conversations" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTab("files")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            effectiveActiveTab === "files"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabFiles")}
          {effectiveActiveTab === "files" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
        {hasPluginCommands && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => switchTab("commands")}
            className={cn(
              "relative h-9 px-3 text-sm font-medium transition-colors",
              effectiveActiveTab === "commands"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("tabCommands")}
            {effectiveActiveTab === "commands" && (
              <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
            )}
          </button>
        )}
      </div>

      <CommandInput
        ref={inputRef}
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
      />

      {/* Agent filter (conversations tab only). Wraps: one chip per agent type
          present in the folder, each carrying a full name, so a workspace with
          a dozen enabled agents runs past the dialog — which is
          `overflow-hidden`, so the tail chips were clipped away and simply
          could not be clicked. Wrapping keeps every filter reachable and lets
          the block grow by a row instead of hiding options. */}
      {effectiveActiveTab === "conversations" && availableAgents.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAgentFilter(null)}
            className={cn(
              "h-6 shrink-0 text-xs px-2 rounded-md transition-colors",
              agentFilter === null
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("allAgents")}
          </button>
          {availableAgents.map((at) => (
            <button
              key={at}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAgentFilter(at)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 h-6 text-xs px-2 rounded-md transition-colors",
                agentFilter === at
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <AgentIcon agentType={at} className="w-3.5 h-3.5" />
              {getAgentLabel(at)}
            </button>
          ))}
        </div>
      )}

      <CommandList className="min-h-96">
        {/* Conversations tab */}
        {effectiveActiveTab === "conversations" && (
          <>
            <CommandEmpty>
              {searching
                ? t("searching")
                : !query.trim() && !agentFilter
                  ? t("typeToSearch")
                  : t("noResults")}
            </CommandEmpty>
            {results.length > 0 && (
              <CommandGroup>
                {results.map((conv) => (
                  <CommandItem
                    key={conv.id}
                    value={`${conv.id}-${formatConversationTitle(conv.title)}`}
                    onSelect={() => handleSelectConversation(conv)}
                  >
                    <ConversationStatusDot
                      status={conv.status as ConversationStatus}
                    />
                    <span className="flex-1 truncate">
                      {formatConversationTitle(conv.title) ||
                        t("untitledConversation")}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {getAgentLabel(conv.agent_type)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(conv.created_at), {
                        addSuffix: true,
                        locale: dateFnsLocale,
                      })}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {query.trim().length > 0 && filteredPluginCommands.length > 0 && (
              <CommandGroup heading={t("tabCommands")}>
                {filteredPluginCommands.map((command) => (
                  <PluginCommandPaletteItem
                    key={command.key}
                    command={command}
                    scopeBadge={pluginCommandScopeLabel(command.scope)}
                    onSelect={handleSelectPluginCommand}
                  />
                ))}
              </CommandGroup>
            )}
          </>
        )}

        {/* Files tab */}
        {effectiveActiveTab === "files" && (
          <>
            <CommandEmpty>
              {filesLoading
                ? t("searching")
                : !query.trim()
                  ? t("typeToSearchFiles")
                  : t("noResults")}
            </CommandEmpty>
            {filteredFiles.length > 0 && (
              <CommandGroup>
                {filteredFiles.map((entry) => (
                  <CommandItem
                    key={entry.relativePath}
                    value={entry.relativePath}
                    onSelect={() => handleSelectFile(entry)}
                  >
                    {entry.kind === "dir" ? (
                      <Folder className="w-4 h-4 shrink-0 text-blue-500" />
                    ) : (
                      <File className="w-4 h-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0 truncate max-w-48">
                      {entry.relativePath}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}

        {/* Scoped plugin commands tab */}
        {effectiveActiveTab === "commands" && (
          <>
            <CommandEmpty>{t("noResults")}</CommandEmpty>
            {filteredPluginCommands.length > 0 && (
              <CommandGroup>
                {filteredPluginCommands.map((command) => (
                  <PluginCommandPaletteItem
                    key={command.key}
                    command={command}
                    scopeBadge={pluginCommandScopeLabel(command.scope)}
                    onSelect={handleSelectPluginCommand}
                  />
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}

function PluginCommandPaletteItem({
  command,
  scopeBadge,
  onSelect,
}: {
  command: ResolvedPluginCommand
  scopeBadge: string
  onSelect: (command: ResolvedPluginCommand) => void
}) {
  const Icon =
    command.action.type === "openScreen"
      ? AppWindow
      : command.action.type === "callMethod"
        ? Zap
        : Puzzle
  return (
    <CommandItem
      value={`${command.key} ${command.title} ${command.description ?? ""} ${command.pluginName}`}
      keywords={command.keywords}
      onSelect={() => onSelect(command)}
      className="items-center gap-2.5"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{command.title}</div>
        {command.description && (
          <div className="truncate text-xs text-muted-foreground">
            {command.description}
          </div>
        )}
      </div>
      <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">
        {command.pluginName}
      </span>
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] leading-none font-medium text-muted-foreground">
        {scopeBadge}
      </span>
    </CommandItem>
  )
}
