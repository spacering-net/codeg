"use client"

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Bot,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  GitBranch,
  ListChecks,
  Loader2,
  Search,
  Square,
  Trash2,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AgentIcon } from "@/components/agent-icon"
import {
  buildBranchTree,
  expandedKeysForBranch,
  type BranchTreeLeaf,
  type BranchTreeNode,
} from "@/lib/branch-tree"
import {
  FolderSelect,
  type FolderSelectOption,
} from "@/components/shared/folder-select"
import { FolderAliasLabel } from "@/components/conversations/folder-alias-label"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import {
  deleteConversation,
  listAllConversations,
  updateConversationStatus,
} from "@/lib/api"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"
import { ALL_AGENT_TYPES, STATUS_ORDER } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  excludeChatFolders,
  filterTopLevelFolders,
  formatFolderLabelWithAlias,
} from "@/lib/folder-display"
import { cn } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"
import { toErrorMessage } from "@/lib/app-error"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"

interface ConversationManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The folder the dialog was opened on — the initial value of the folder
   *  facet, which the user can then widen to the whole workspace or point at
   *  another folder. */
  folderId: number
}

/**
 * What the branch facet is filtering by. `none` isolates the conversations that
 * carry no branch at all (started in a non-repo folder, or imported from an
 * agent whose session files don't record one).
 *
 * A union rather than `string | "all" | null`, because a branch can legitimately
 * BE named `all` — a sentinel string would filter to the wrong thing.
 */
type BranchFilter =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "branch"; name: string }

const ALL_BRANCHES: BranchFilter = { kind: "all" }

/**
 * Shared metrics for the four facet controls, so the folder picker, the branch
 * popover and the two `Select`s read as one row of equal columns rather than
 * three unrelated widgets.
 *
 * `w-full max-w-none` is the load-bearing part: `FolderSelect`'s `field`
 * variant is content-sized (`w-auto max-w-[16rem]`), which made the row's
 * columns — and, before the search box moved to its own line, the search box
 * itself — resize every time the picked folder's name changed length.
 */
const FACET_TRIGGER_CLASS = "h-9 w-full min-w-0 max-w-none text-sm"

/**
 * Same, for the two native `Select` triggers: they ship a 16px chevron at full
 * muted strength where the folder and branch popovers beside them use a 14px
 * one at 60%. `>svg` is the chevron alone — the selected value's own glyph
 * renders deeper, inside the value slot.
 */
const FACET_SELECT_TRIGGER_CLASS = cn(
  FACET_TRIGGER_CLASS,
  "[&>svg]:size-3.5 [&>svg]:text-muted-foreground/60"
)

/**
 * A status dot in the same 14px slot the other facets' glyphs occupy — on its
 * own it is 8px, which would start the status label a few pixels left of every
 * other label in the row.
 */
function StatusGlyph({ status }: { status?: ConversationStatus }) {
  return (
    <span className="flex size-3.5 items-center justify-center">
      <ConversationStatusDot status={status} />
    </span>
  )
}

/** One branch the current rows actually use, and how many of them use it. */
interface BranchOption {
  name: string
  count: number
}

function parseTimestamp(value: string): number {
  const ts = Date.parse(value)
  return Number.isNaN(ts) ? 0 : ts
}

function formatRelative(iso: string): string {
  const ts = parseTimestamp(iso)
  if (!ts) return ""
  const diff = Math.max(0, Date.now() - ts)
  const m = Math.floor(diff / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo`
  const y = Math.floor(mo / 12)
  return `${y}y`
}

/**
 * Left padding for a branch row at `depth`, measured from `CommandItem`'s own
 * `px-2` base so the tree's first level lines up with the pinned rows above it.
 * Deliberately not `branchRowPaddingLeft` from the shared tree renderer: that
 * base is tuned to the dropdown selectors' roomier `rounded-xl py-2` rows.
 */
function branchRowIndent(depth: number): string {
  return `${0.5 + depth * 0.75}rem`
}

/**
 * The prefix-grouped branch rows. Group headers are `CommandItem`s like the
 * leaves rather than plain buttons, so arrow keys reach them and Enter folds
 * them — cmdk only navigates its own items, and the shared
 * `BranchTreeCollapsible` renderer (built for Radix dropdowns) would drop its
 * triggers out of this list's keyboard path.
 */
function BranchTreeRows({
  nodes,
  depth,
  expanded,
  onToggleGroup,
  renderLeaf,
}: {
  nodes: readonly BranchTreeNode[]
  depth: number
  expanded: ReadonlySet<string>
  onToggleGroup: (key: string) => void
  renderLeaf: (leaf: BranchTreeLeaf, depth: number) => ReactNode
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === "leaf") {
          return <Fragment key={node.key}>{renderLeaf(node, depth)}</Fragment>
        }
        // Folded by default, like the other branch selectors: a repo whose
        // `task/` group runs to fifty worktrees would otherwise bury `main`
        // below a scroll. The count on the header says what is inside, and
        // typing flattens the whole tree anyway.
        const open = expanded.has(node.key)
        return (
          <Fragment key={node.key}>
            <CommandItem
              // Group keys are `g <scope> <prefix>` and a git ref can't contain
              // a space, so they never collide with a leaf's branch name.
              value={node.key}
              onSelect={() => onToggleGroup(node.key)}
              style={{ paddingLeft: branchRowIndent(depth) }}
            >
              <ChevronRight
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  open && "rotate-90"
                )}
              />
              <span dir="ltr" className="min-w-0 flex-1 truncate text-start">
                {node.label}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {node.count}
              </span>
            </CommandItem>
            {open ? (
              <BranchTreeRows
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                onToggleGroup={onToggleGroup}
                renderLeaf={renderLeaf}
              />
            ) : null}
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * The branch facet: the branches the matched conversations actually ran on,
 * each with its count, plus pinned "all branches" and (when some conversation
 * has none) "no branch" rows.
 *
 * Shaped like the shared `FolderSelect` — a command palette in a popover — for
 * the same reason: a repo accumulates far more branches than a plain `Select`
 * can show without scrolling blindly. Branches are prefix-grouped on `/` with
 * the same `buildBranchTree` the three git selectors use, so `task/49` and
 * `task/50` fold under one `task/` header here too.
 *
 * Filtering is ours rather than cmdk's (`shouldFilter={false}`): a typed query
 * has to flatten the tree — a collapsed group can't offer a match it isn't
 * rendering — which is exactly what the other branch selectors do.
 */
function BranchFilterSelect({
  value,
  onChange,
  branches,
  noBranchCount,
  className,
}: {
  value: BranchFilter
  onChange: (next: BranchFilter) => void
  branches: readonly BranchOption[]
  noBranchCount: number
  className?: string
}) {
  const t = useTranslations("Folder.sidebar.manageConversations")
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const label =
    value.kind === "all"
      ? t("branchFilterAll")
      : value.kind === "none"
        ? t("branchNone")
        : value.name

  const select = (next: BranchFilter) => {
    setOpen(false)
    onChange(next)
  }

  const toggleGroup = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const nodes = useMemo(
    () =>
      buildBranchTree(
        branches.map((b) => ({ full: b.name, display: b.name })),
        "facet"
      ),
    [branches]
  )
  const countByBranch = useMemo(
    () => new Map(branches.map((b) => [b.name, b.count])),
    [branches]
  )

  const q = query.trim().toLowerCase()
  // Searching flattens: full names, so a hit under `task/` still reads as the
  // branch it is once its group header is gone.
  const matches = useMemo(
    () => (q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : []),
    [branches, q]
  )
  const noBranchLabel = t("branchNone")
  const showNoBranch =
    noBranchCount > 0 && (!q || noBranchLabel.toLowerCase().includes(q))
  const nothingMatched = q !== "" && matches.length === 0 && !showNoBranch

  /** One branch row. `label` is the remainder under its group; `fullName` is
   *  the ref the facet actually filters by. */
  const renderLeaf = (leaf: BranchTreeLeaf, depth: number) => (
    <CommandItem
      value={leaf.fullName}
      onSelect={() => select({ kind: "branch", name: leaf.fullName })}
      style={{ paddingLeft: branchRowIndent(depth) }}
    >
      <GitBranch className="h-4 w-4" />
      <span dir="ltr" className="min-w-0 flex-1 truncate text-start">
        {leaf.label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {countByBranch.get(leaf.fullName)}
      </span>
      {value.kind === "branch" && value.name === leaf.fullName ? (
        <Check className="h-4 w-4 shrink-0" />
      ) : null}
    </CommandItem>
  )

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) return
        // Each open starts from the whole tree, not from the last search. Reset
        // on the way IN rather than out: picking a row closes the popover by
        // setting `open` directly, which Radix never reports back here.
        setQuery("")
        // Folds reset per open too, except along the path to whatever is picked
        // — reopening onto a checkmark hidden inside a collapsed group reads as
        // "nothing is selected".
        setExpanded(
          new Set(
            value.kind === "branch"
              ? expandedKeysForBranch(nodes, value.name)
              : []
          )
        )
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          title={label}
          // Looks only — the caller owns the metrics, so this trigger sizes
          // with the rest of the facet row.
          className={cn(
            "justify-between gap-1.5 rounded-4xl border-input bg-input/30 px-3 font-normal hover:bg-input/50 dark:hover:bg-input/50",
            className
          )}
        >
          <GitBranch
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          {/* Branch names read LTR even in RTL locales. */}
          <span
            dir={value.kind === "branch" ? "ltr" : undefined}
            className="min-w-0 flex-1 truncate text-start"
          >
            {label}
          </span>
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground/60"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 overflow-hidden p-0">
        <Command className="rounded-2xl" shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("branchSearchPlaceholder")}
          />
          <CommandList>
            {/* Pinned above the (scrolling) branches, like the folder picker's
                "all folders" row: clearing the facet must never require
                scrolling back up, and it survives any search. */}
            <div className="sticky top-0 z-10 bg-popover">
              <CommandGroup>
                <CommandItem
                  value="__all_branches__"
                  onSelect={() => select(ALL_BRANCHES)}
                >
                  <GitBranch className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">
                    {t("branchFilterAll")}
                  </span>
                  {value.kind === "all" ? (
                    <Check className="h-4 w-4 shrink-0" />
                  ) : null}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
            </div>
            {nothingMatched ? (
              <div className="py-6 text-center text-sm">
                {t("noMatchingBranches")}
              </div>
            ) : null}
            <CommandGroup>
              {showNoBranch ? (
                <CommandItem
                  value="__no_branch__"
                  onSelect={() => select({ kind: "none" })}
                >
                  <GitBranch className="h-4 w-4 opacity-50" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {noBranchLabel}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {noBranchCount}
                  </span>
                  {value.kind === "none" ? (
                    <Check className="h-4 w-4 shrink-0" />
                  ) : null}
                </CommandItem>
              ) : null}
              {q ? (
                matches.map((b) => (
                  <Fragment key={b.name}>
                    {renderLeaf(
                      {
                        type: "leaf",
                        fullName: b.name,
                        label: b.name,
                        key: b.name,
                      },
                      0
                    )}
                  </Fragment>
                ))
              ) : (
                <BranchTreeRows
                  nodes={nodes}
                  depth={0}
                  expanded={expanded}
                  onToggleGroup={toggleGroup}
                  renderLeaf={renderLeaf}
                />
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function ConversationManageDialog({
  open,
  onOpenChange,
  folderId,
}: ConversationManageDialogProps) {
  const t = useTranslations("Folder.sidebar.manageConversations")
  const tCommon = useTranslations("Folder.common")
  const tStatus = useTranslations("Folder.statusLabels")

  const refreshConversations = useAppWorkspaceStore(
    (s) => s.refreshConversations
  )
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const { closeConversationTab } = useTabActions()
  const { agents } = useAcpAgents()

  const [search, setSearch] = useState("")
  /** The folder facet: a folder id, or `null` for the whole workspace. */
  const [scopeFolderId, setScopeFolderId] = useState<number | null>(folderId)
  const [branchFilter, setBranchFilter] = useState<BranchFilter>(ALL_BRANCHES)
  const [agentFilter, setAgentFilter] = useState<AgentType | "all">("all")
  const [statusFilter, setStatusFilter] = useState<ConversationStatus | "all">(
    "all"
  )
  const [rows, setRows] = useState<DbConversationSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Keyed by id but holding the row, so a bulk op can still close the tabs of
  // conversations the current facets have since filtered out of view (the
  // selection deliberately survives a facet change).
  const [selected, setSelected] = useState<Map<number, DbConversationSummary>>(
    new Map()
  )
  const [pending, setPending] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // History remains filterable when an agent is disabled or removed. Prefer
  // the live registry's order, retain built-ins while it loads, and include
  // agents from saved rows plus the selection even after an empty response.
  const agentTypes = useMemo(
    () =>
      Array.from(
        new Set([
          ...agents.map((agent) => agent.agent_type),
          ...ALL_AGENT_TYPES,
          ...rows.map((row) => row.agent_type),
          ...(agentFilter === "all" ? [] : [agentFilter]),
        ])
      ),
    [agents, rows, agentFilter]
  )

  // The folders the scope facet offers: the top-level repos the sidebar draws
  // headers for. Worktree children are reached through their parent (see
  // `queryFolderIds`), and chat folders back folderless chat mode — they never
  // appear in a user-facing folder list.
  const folderOptions = useMemo(() => {
    const options = new Map<number, FolderSelectOption>()
    for (const f of excludeChatFolders(filterTopLevelFolders(allFolders))) {
      options.set(f.id, {
        id: f.id,
        name: f.name,
        alias: f.alias,
        path: f.path,
      })
    }
    // Whatever the dialog was opened on is always offered, top-level or not:
    // with "Show worktrees" on, each worktree draws its own header and so its
    // own menu entry, and the scope would otherwise be a folder the picker can
    // name only as `#<id>` and can never return to once the scope moves.
    if (!options.has(folderId)) {
      const own = allFolders.find((f) => f.id === folderId)
      options.set(folderId, {
        id: folderId,
        name: own?.name ?? `#${folderId}`,
        alias: own?.alias ?? null,
        path: own?.path ?? null,
      })
    }
    return [...options.values()].sort((a, b) =>
      (a.alias ?? a.name).localeCompare(b.alias ?? b.name)
    )
  }, [allFolders, folderId])

  // A picked folder queries the parent id PLUS every worktree child folder id:
  // worktree conversations keep `folder_id = the worktree child folder`, and the
  // sidebar merges them into the parent group as a display-only redirect that
  // never rewrites `folder_id` — so `list_all`'s exact `folder_id IN (...)`
  // filter would otherwise drop them. `allFolders` includes open and closed
  // (non-deleted) folders and a worktree's `parent_id` is flattened to the root,
  // so one level of filtering is complete.
  //
  // The workspace-wide scope enumerates that same universe instead of passing
  // `null`, which on the backend means "every non-deleted folder" and would also
  // sweep in the hidden chat-mode folders no scope here can name.
  const queryFolderIds = useMemo(() => {
    if (scopeFolderId == null)
      return excludeChatFolders(allFolders).map((f) => f.id)
    const ids = [scopeFolderId]
    for (const f of allFolders) {
      if (f.parent_id === scopeFolderId) ids.push(f.id)
    }
    return ids
  }, [allFolders, scopeFolderId])

  // Reset state on open/close transitions
  useEffect(() => {
    if (!open) {
      setSearch("")
      setScopeFolderId(folderId)
      setBranchFilter(ALL_BRANCHES)
      setAgentFilter("all")
      setStatusFilter("all")
      setSelected(new Map())
      setConfirmDelete(false)
      setError(null)
    }
  }, [open, folderId])

  // Debounced data fetch. Each run owns a `cancelled` flag its cleanup trips, so
  // a reply that lands after the facets moved on is dropped rather than written
  // over the newer one. Without it a slow folder-A request finishing behind
  // folder B's would leave the dialog listing A's conversations under B's
  // scope — with no folder column to give it away, since that only appears in
  // the workspace-wide scope — and Delete there would hit rows from a folder the
  // user had already navigated away from.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = setTimeout(async () => {
      // Nothing to query: the workspace-wide scope over an empty folder list.
      // The backend reads an empty id list as "every non-deleted folder", so
      // asking would answer with exactly the hidden chat-mode folders this
      // dialog excludes.
      if (queryFolderIds.length === 0) {
        setRows([])
        setError(null)
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const data = await listAllConversations({
          folder_ids: queryFolderIds,
          search: search.trim() || null,
          agent_type: agentFilter === "all" ? null : agentFilter,
          status: statusFilter === "all" ? null : statusFilter,
        })
        if (cancelled) return
        const sorted = [...data].sort(
          (a, b) => parseTimestamp(b.created_at) - parseTimestamp(a.created_at)
        )
        setRows(sorted)
        setError(null)
      } catch (e) {
        if (cancelled) return
        setError(toErrorMessage(e))
      } finally {
        // A superseded run must leave the flag alone: its successor is in
        // flight (or one debounce away), and the list is still loading.
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, queryFolderIds, search, agentFilter, statusFilter, refreshKey])

  // Branch options are derived from the rows the other facets already matched,
  // so every branch listed is guaranteed to yield at least one conversation —
  // and the list can never disagree with what the filter then selects.
  const { branchOptions, noBranchCount } = useMemo(() => {
    const counts = new Map<string, number>()
    let none = 0
    for (const r of rows) {
      if (r.git_branch)
        counts.set(r.git_branch, (counts.get(r.git_branch) ?? 0) + 1)
      else none++
    }
    return {
      branchOptions: [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      noBranchCount: none,
    }
  }, [rows])

  // Branch is the one facet applied client-side: it shares its source of truth
  // with the option list above, and the rows are already in memory.
  const visibleRows = useMemo(() => {
    switch (branchFilter.kind) {
      case "all":
        return rows
      case "none":
        return rows.filter((r) => !r.git_branch)
      case "branch":
        return rows.filter((r) => r.git_branch === branchFilter.name)
    }
  }, [rows, branchFilter])

  // Only worth a column when rows can come from more than one folder; inside a
  // single folder it would repeat the scope pill on every line.
  const showFolderColumn = scopeFolderId == null
  const folderById = useMemo(
    () => new Map(allFolders.map((f) => [f.id, f])),
    [allFolders]
  )

  const handleScopeChange = useCallback((next: number | null) => {
    setScopeFolderId(next)
    // Branches are per-folder: carrying `feature/x` over to a folder that never
    // had it would show an empty list under a filter the user never chose there.
    setBranchFilter(ALL_BRANCHES)
  }, [])

  const toggleOne = useCallback((conv: DbConversationSummary) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(conv.id)) next.delete(conv.id)
      else next.set(conv.id, conv)
      return next
    })
  }, [])

  const allVisibleSelected = useMemo(
    () =>
      visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id)),
    [visibleRows, selected]
  )

  const toggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      setSelected((prev) => {
        const next = new Map(prev)
        for (const r of visibleRows) next.delete(r.id)
        return next
      })
    } else {
      setSelected((prev) => {
        const next = new Map(prev)
        for (const r of visibleRows) next.set(r.id, r)
        return next
      })
    }
  }, [allVisibleSelected, visibleRows])

  const afterBulkOp = useCallback(() => {
    setSelected(new Map())
    setRefreshKey((k) => k + 1)
    refreshConversations()
  }, [refreshConversations])

  const selectedConversations = useMemo(
    () => [...selected.values()],
    [selected]
  )
  const selectedCount = selected.size

  const handleBulkDelete = useCallback(async () => {
    if (selectedConversations.length === 0) return
    setPending(true)
    try {
      await Promise.all(
        selectedConversations.map((conv) => deleteConversation(conv.id))
      )
      for (const conv of selectedConversations) {
        closeConversationTab(conv.folder_id, conv.id, conv.agent_type)
      }
      toast.success(t("toastDeleted", { count: selectedConversations.length }))
      afterBulkOp()
    } catch (e) {
      toast.error(
        t("toastOpFailed", {
          message: toErrorMessage(e),
        })
      )
    } finally {
      setPending(false)
      setConfirmDelete(false)
    }
  }, [selectedConversations, closeConversationTab, t, afterBulkOp])

  const handleBulkStatus = useCallback(
    async (status: ConversationStatus) => {
      if (selectedConversations.length === 0) return
      setPending(true)
      try {
        await Promise.all(
          selectedConversations.map((conv) =>
            updateConversationStatus(conv.id, status)
          )
        )
        toast.success(
          t("toastStatusUpdated", { count: selectedConversations.length })
        )
        afterBulkOp()
      } catch (e) {
        toast.error(
          t("toastOpFailed", {
            message: toErrorMessage(e),
          })
        )
      } finally {
        setPending(false)
      }
    },
    [selectedConversations, t, afterBulkOp]
  )

  const anyFacetNarrows =
    search.trim() !== "" ||
    branchFilter.kind !== "all" ||
    agentFilter !== "all" ||
    statusFilter !== "all"

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            {/* Which folder is in scope is the folder pill's job now, not the
                title's — the pill names it alias-aware and can also read "all
                folders", which no fixed title could. */}
            <DialogTitle>{t("title")}</DialogTitle>
          </DialogHeader>

          {/* Facets: free text owns the top line — it is the one that wants
              every pixel — and the four narrowing controls line up as equal
              columns beneath it, ordered coarse to fine. */}
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchPlaceholder")}
                className="h-9 ps-9"
              />
            </div>
            {/* Four across once the dialog is at its `max-w-3xl` width, 2x2
                below that. */}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <FolderSelect
                folders={folderOptions}
                value={scopeFolderId}
                onChange={handleScopeChange}
                allLabel={t("folderFilterAll")}
                onSelectAll={() => handleScopeChange(null)}
                variant="field"
                className={FACET_TRIGGER_CLASS}
              />
              <BranchFilterSelect
                value={branchFilter}
                onChange={setBranchFilter}
                branches={branchOptions}
                noBranchCount={noBranchCount}
                className={FACET_TRIGGER_CLASS}
              />
              <Select
                value={agentFilter}
                onValueChange={(v) => setAgentFilter(v as AgentType | "all")}
              >
                <SelectTrigger className={FACET_SELECT_TRIGGER_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Every row — this one included — leads with a glyph, so the
                      list (and the trigger it mirrors into) has one left edge
                      instead of two. */}
                  <SelectItem value="all">
                    <span className="flex items-center gap-2">
                      <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                      {t("agentFilterAll")}
                    </span>
                  </SelectItem>
                  {agentTypes.map((at) => (
                    <SelectItem
                      key={at}
                      value={at}
                      textValue={getAgentLabel(at)}
                    >
                      <span className="flex items-center gap-2">
                        <AgentIcon agentType={at} className="h-3.5 w-3.5" />
                        {getAgentLabel(at)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={statusFilter}
                onValueChange={(v) =>
                  setStatusFilter(v as ConversationStatus | "all")
                }
              >
                <SelectTrigger className={FACET_SELECT_TRIGGER_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    <span className="flex items-center gap-2">
                      {/* Statusless: the dot's grey fallback, which no real
                          status uses (see STATUS_COLORS). */}
                      <StatusGlyph />
                      {t("statusFilterAll")}
                    </span>
                  </SelectItem>
                  {STATUS_ORDER.map((s) => (
                    <SelectItem key={s} value={s}>
                      <span className="flex items-center gap-2">
                        <StatusGlyph status={s} />
                        {tStatus(s)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* List container: select-all header + scrollable list */}
          <div className="flex flex-col rounded-md border border-border/50 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 bg-muted/20">
              <button
                type="button"
                onClick={toggleSelectAll}
                disabled={visibleRows.length === 0}
                className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <span className="flex h-5 w-5 items-center justify-center">
                  {allVisibleSelected ? (
                    <CheckSquare className="h-4 w-4 text-primary" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </span>
                {allVisibleSelected ? t("deselectAll") : t("selectAllVisible")}
              </button>
              <span className="text-xs text-muted-foreground">
                {t("matchedCount", { count: visibleRows.length })}
              </span>
            </div>
            <ScrollArea className="h-[26rem]">
              <div className="flex flex-col gap-0.5 p-1">
                {loading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full rounded-md" />
                  ))
                ) : error ? (
                  <p className="text-destructive text-sm px-3 py-6 text-center">
                    {error}
                  </p>
                ) : visibleRows.length === 0 ? (
                  <p className="text-muted-foreground text-sm px-3 py-6 text-center">
                    {anyFacetNarrows
                      ? t("noMatchingConversations")
                      : scopeFolderId == null
                        ? t("noConversationsWorkspace")
                        : t("noConversations")}
                  </p>
                ) : (
                  visibleRows.map((conv) => {
                    const checked = selected.has(conv.id)
                    const folder = folderById.get(conv.folder_id)
                    return (
                      <div
                        key={conv.id}
                        onClick={() => toggleOne(conv)}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer border border-transparent",
                          "hover:bg-accent/50",
                          checked && "bg-accent/40 border-accent/60"
                        )}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleOne(conv)
                          }}
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                          aria-pressed={checked}
                        >
                          {checked ? (
                            <CheckSquare className="h-4 w-4 text-primary" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </button>
                        <AgentIcon
                          agentType={conv.agent_type}
                          className="h-4 w-4 shrink-0"
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                          <span className="min-w-0 truncate text-sm sm:flex-1">
                            {formatConversationTitle(conv.title) ||
                              t("untitledConversation")}
                          </span>
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:shrink-0 sm:flex-nowrap">
                            {showFolderColumn ? (
                              // Workspace-wide scope only: with rows from every
                              // folder the title alone doesn't say which project a
                              // conversation belongs to.
                              <span
                                className="shrink-0 max-w-28 truncate text-xs text-muted-foreground"
                                title={
                                  folder
                                    ? [
                                        formatFolderLabelWithAlias(folder),
                                        folder.path,
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")
                                    : `#${conv.folder_id}`
                                }
                              >
                                {folder ? (
                                  <FolderAliasLabel
                                    name={folder.name}
                                    alias={folder.alias}
                                  />
                                ) : (
                                  `#${conv.folder_id}`
                                )}
                              </span>
                            ) : null}
                            {/* The branch the conversation was started on — what
                            tells two runs of the same project apart. */}
                            <span
                              className="flex min-w-0 max-w-full items-center gap-1 text-xs text-muted-foreground sm:w-28 sm:shrink-0 sm:justify-end"
                              title={conv.git_branch ?? t("branchNone")}
                            >
                              {conv.git_branch ? (
                                <>
                                  <GitBranch
                                    className="h-3 w-3 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span dir="ltr" className="truncate">
                                    {conv.git_branch}
                                  </span>
                                </>
                              ) : (
                                <span className="text-muted-foreground/60">
                                  —
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground sm:w-10 sm:text-right">
                              {formatRelative(conv.created_at)}
                            </span>
                            <ConversationStatusDot
                              status={conv.status as ConversationStatus}
                              title={
                                STATUS_ORDER.includes(
                                  conv.status as ConversationStatus
                                )
                                  ? tStatus(conv.status as ConversationStatus)
                                  : conv.status
                              }
                            />
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Footer: bulk actions */}
          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {t("selectedCount", { count: selectedCount })}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {/* Set status */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selectedCount === 0 || pending}
                  >
                    <ListChecks className="h-3.5 w-3.5 mr-1" />
                    {t("setStatus")}
                    <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {STATUS_ORDER.map((s) => (
                    <DropdownMenuItem
                      key={s}
                      onSelect={() => handleBulkStatus(s)}
                    >
                      <ConversationStatusDot status={s} />
                      {tStatus(s)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Delete */}
              <Button
                size="sm"
                variant="destructive"
                disabled={selectedCount === 0 || pending}
                onClick={() => setConfirmDelete(true)}
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                )}
                {t("deleteSelected")}
              </Button>

              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {tCommon("close")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("confirmDeleteTitle", { count: selectedCount })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDeleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkDelete}>
              {tCommon("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
