"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import {
  CheckCircle2,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  FolderPlus,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { importSelectedSessions, scanImportableSessions } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { subscribe } from "@/lib/platform"
import {
  ALL_AGENT_TYPES,
  IMPORT_SCAN_PROGRESS_EVENT,
  type AgentType,
  type ImportScanProgress,
  type ImportSelectedResult,
  type ScanFolder,
  type ScanResult,
  type ScanSession,
  type SelectedSessionKey,
} from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { cn } from "@/lib/utils"
import {
  FolderHeaderRow,
  SessionRow,
  isSessionSelectable,
  sessionKey,
} from "./import-sessions-rows"

type Phase = "scanning" | "ready" | "importing" | "done" | "error"

type Row =
  | { kind: "folder"; folder: ScanFolder; sessions: ScanSession[] }
  | { kind: "session"; session: ScanSession }

function rowKey(row: Row): string {
  return row.kind === "folder"
    ? `folder-${row.folder.path}`
    : `session-${sessionKey(row.session)}`
}

/** Frontend-loose path comparison for the focusPath handoff: the sidebar sends
 *  the DB row's path and the scan echoes stored-row paths back, so after
 *  separator/trailing-slash trimming they match byte-for-byte in practice; a
 *  case-insensitive second pass covers case-preserving filesystems. */
function normalizePathLoose(path: string): string {
  let p = path.trim().replace(/\\/g, "/")
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1)
  return p
}

interface ScanAgentProgress {
  agentType: AgentType
  sessionCount: number
}

interface ImportSessionsWindowProps {
  focusPath: string | null
  onClose: () => void
}

export function ImportSessionsWindow({
  focusPath,
  onClose,
}: ImportSessionsWindowProps) {
  const t = useTranslations("ImportSessions")

  const [phase, setPhase] = useState<Phase>("scanning")
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [progressAgents, setProgressAgents] = useState<ScanAgentProgress[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | "all">("all")
  const [onlyImportable, setOnlyImportable] = useState(false)
  // Deleting a conversation in codeg is a soft delete, so a deleted session can
  // be brought back by importing it again. Off by default: the deletion was
  // deliberate, and select-all must never resurrect a whole history by
  // accident. Turning it on folds deleted rows into every selection helper.
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [importResult, setImportResult] = useState<ImportSelectedResult | null>(
    null
  )

  const phaseRef = useRef(phase)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  // ── Scan ────────────────────────────────────────────────────────────────
  const scanGen = useRef(0)
  const focusAppliedRef = useRef(false)
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  const rowsRef = useRef<Row[]>([])

  // The async walk itself — no synchronous setState, so the mount effect may
  // call it directly (the initial state is already the clean scanning state).
  // The focusPath handoff (expand + preselect + scroll to the origin folder)
  // applies HERE, on the scan that resolves it, not in a state-sync effect.
  const performScan = useCallback(async () => {
    const gen = ++scanGen.current
    try {
      const result = await scanImportableSessions()
      if (scanGen.current !== gen) return
      setScan(result)
      setPhase("ready")
      if (focusPath && !focusAppliedRef.current) {
        focusAppliedRef.current = true
        const target = normalizePathLoose(focusPath)
        const folder =
          result.folders.find((f) => normalizePathLoose(f.path) === target) ??
          result.folders.find(
            (f) =>
              normalizePathLoose(f.path).toLowerCase() === target.toLowerCase()
          )
        if (folder) {
          // Preselect only the genuinely NEW sessions, never the deleted ones:
          // this handoff arrives from the sidebar without the user having seen
          // the list yet, so it must not stage a restore they did not ask for.
          setSelected(
            new Set(
              folder.sessions.filter((s) => s.status === "new").map(sessionKey)
            )
          )
          setCollapsed((prev) => {
            if (!prev.has(folder.path)) return prev
            const next = new Set(prev)
            next.delete(folder.path)
            return next
          })
          // Scroll once the fresh rows have rendered (double rAF — a
          // scrollToIndex fired in the frame the list mounts can land before
          // the virtualizer has measured).
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const index = rowsRef.current.findIndex(
                (r) => r.kind === "folder" && r.folder.path === folder.path
              )
              if (index >= 0) {
                virtualizerRef.current?.scrollToIndex(index, {
                  align: "start",
                })
              }
            })
          })
        }
      }
    } catch (err) {
      if (scanGen.current !== gen) return
      setScanError(toErrorMessage(err))
      setPhase("error")
    }
  }, [focusPath])

  // Re-scan from a user action: reset to the clean scanning state first.
  const runScan = useCallback(() => {
    setPhase("scanning")
    setScanError(null)
    setProgressAgents([])
    setScan(null)
    setSelected(new Set())
    void performScan()
  }, [performScan])

  useEffect(() => {
    void performScan()
    // Mount-only: re-running on a focusPath identity change would discard an
    // in-flight scan for nothing (the query param never changes in-window).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Per-agent progress while the backend walks the local stores. The channel
  // is a broadcast (another window's scan also lands here) — gate on our own
  // scanning phase and dedupe by agent.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<ImportScanProgress>(
        IMPORT_SCAN_PROGRESS_EVENT,
        (p) => {
          if (phaseRef.current !== "scanning") return
          setProgressAgents((prev) => {
            if (prev.some((entry) => entry.agentType === p.agent_type)) {
              return prev
            }
            return [
              ...prev,
              { agentType: p.agent_type, sessionCount: p.session_count },
            ]
          })
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // ── Filtering + flat row model ──────────────────────────────────────────
  const filteredFolders = useMemo(() => {
    if (!scan) return []
    const query = search.trim().toLowerCase()
    const entries: { folder: ScanFolder; sessions: ScanSession[] }[] = []
    for (const folder of scan.folders) {
      let sessions = folder.sessions
      if (agentFilter !== "all") {
        sessions = sessions.filter((s) => s.agent_type === agentFilter)
      }
      if (onlyImportable) {
        sessions = sessions.filter((s) =>
          isSessionSelectable(s, includeDeleted)
        )
      }
      if (query) {
        const folderMatches =
          folder.path.toLowerCase().includes(query) ||
          folder.name.toLowerCase().includes(query)
        if (!folderMatches) {
          sessions = sessions.filter((s) =>
            (s.title ?? "").toLowerCase().includes(query)
          )
        }
      }
      if (sessions.length > 0) entries.push({ folder, sessions })
    }
    return entries
  }, [scan, search, agentFilter, onlyImportable, includeDeleted])

  const rows = useMemo(() => {
    const out: Row[] = []
    for (const { folder, sessions } of filteredFolders) {
      out.push({ kind: "folder", folder, sessions })
      if (!collapsed.has(folder.path)) {
        for (const session of sessions) out.push({ kind: "session", session })
      }
    }
    return out
  }, [filteredFolders, collapsed])
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  // Per-folder tri-state over the VISIBLE selectable sessions.
  const folderSelection = useMemo(() => {
    const map = new Map<string, { selectable: string[]; selected: number }>()
    for (const { folder, sessions } of filteredFolders) {
      const selectable = sessions
        .filter((s) => isSessionSelectable(s, includeDeleted))
        .map(sessionKey)
      let count = 0
      for (const key of selectable) if (selected.has(key)) count += 1
      map.set(folder.path, { selectable, selected: count })
    }
    return map
  }, [filteredFolders, selected, includeDeleted])
  const folderSelectionRef = useRef(folderSelection)
  useEffect(() => {
    folderSelectionRef.current = folderSelection
  }, [folderSelection])

  const allVisibleImportableKeys = useMemo(() => {
    const keys: string[] = []
    for (const { sessions } of filteredFolders) {
      for (const s of sessions) {
        if (isSessionSelectable(s, includeDeleted)) keys.push(sessionKey(s))
      }
    }
    return keys
  }, [filteredFolders, includeDeleted])

  // Footer total. Computed here rather than read from `scan.importable_count`
  // (which only ever counts `new`) so the number the user reads matches what
  // the checkboxes actually offer once deleted sessions are folded in. Spans
  // the WHOLE scan, not the filtered view — same as `scan.total_sessions`.
  const selectableTotal = useMemo(() => {
    if (!scan) return 0
    let total = 0
    for (const folder of scan.folders) {
      for (const s of folder.sessions) {
        if (isSessionSelectable(s, includeDeleted)) total += 1
      }
    }
    return total
  }, [scan, includeDeleted])

  // How many deleted sessions the scan found, across the whole scan. Drives the
  // toggle's hint so a user who does not know deletion is reversible still sees
  // there is something to recover.
  const deletedTotal = useMemo(() => {
    if (!scan) return 0
    let total = 0
    for (const folder of scan.folders) {
      for (const s of folder.sessions) if (s.status === "deleted") total += 1
    }
    return total
  }, [scan])

  // Whether every visible folder is currently collapsed — drives the
  // expand/collapse-all toggle's icon and action.
  const allCollapsed = useMemo(
    () =>
      filteredFolders.length > 0 &&
      filteredFolders.every(({ folder }) => collapsed.has(folder.path)),
    [filteredFolders, collapsed]
  )

  // ── Selection handlers (stable identities so memo'd rows bail out) ──────
  const toggleSession = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const toggleFolder = useCallback((path: string) => {
    const entry = folderSelectionRef.current.get(path)
    if (!entry || entry.selectable.length === 0) return
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = entry.selectable.every((k) => next.has(k))
      if (allSelected) entry.selectable.forEach((k) => next.delete(k))
      else entry.selectable.forEach((k) => next.add(k))
      return next
    })
  }, [])

  // Turning the opt-in back OFF must also un-stage whatever it staged: the
  // deleted rows go disabled and unchecked on screen, so leaving their keys in
  // `selected` would show a footer count nothing on the list accounts for (and
  // `handleImport` would drop them anyway, importing fewer than it promised).
  const toggleIncludeDeleted = useCallback(
    (next: boolean) => {
      setIncludeDeleted(next)
      if (next || !scan) return
      const deletedKeys = new Set<string>()
      for (const folder of scan.folders) {
        for (const s of folder.sessions) {
          if (s.status === "deleted") deletedKeys.add(sessionKey(s))
        }
      }
      setSelected((prev) => {
        const kept = new Set([...prev].filter((k) => !deletedKeys.has(k)))
        return kept.size === prev.size ? prev : kept
      })
    },
    [scan]
  )

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])

  // Collapse every visible folder, or expand them all if they already are.
  // Operates only over the currently-filtered folders; folders hidden by the
  // active filter keep their prior collapse state.
  const toggleCollapseAll = useCallback(() => {
    setCollapsed((prev) => {
      if (filteredFolders.length === 0) return prev
      const everyCollapsed = filteredFolders.every(({ folder }) =>
        prev.has(folder.path)
      )
      const next = new Set(prev)
      for (const { folder } of filteredFolders) {
        if (everyCollapsed) next.delete(folder.path)
        else next.add(folder.path)
      }
      return next
    })
  }, [filteredFolders])

  // ── Viewport bridge for the virtualized list ────────────────────────────
  const viewportRef = useRef<HTMLElement | null>(null)
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback((element: HTMLElement | null) => {
    viewportRef.current = element
    setViewportEl(element)
  }, [])

  // ── Import ──────────────────────────────────────────────────────────────
  const selectedCount = selected.size
  const handleImport = useCallback(async () => {
    if (!scan || selected.size === 0) return
    const selections: SelectedSessionKey[] = []
    for (const folder of scan.folders) {
      for (const s of folder.sessions) {
        if (
          isSessionSelectable(s, includeDeleted) &&
          selected.has(sessionKey(s))
        ) {
          selections.push({
            agentType: s.agent_type,
            externalId: s.external_id,
          })
        }
      }
    }
    if (selections.length === 0) return
    setPhase("importing")
    try {
      const result = await importSelectedSessions(selections)
      setImportResult(result)
      setPhase("done")
    } catch (err) {
      toast.error(t("toasts.importFailed", { message: toErrorMessage(err) }))
      setPhase("ready")
    }
  }, [scan, selected, includeDeleted, t])

  const handleContinue = useCallback(() => {
    setImportResult(null)
    focusAppliedRef.current = true
    runScan()
  }, [runScan])

  const busy = phase === "importing"

  // ── Render ──────────────────────────────────────────────────────────────
  if (phase === "scanning") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("scanningTitle")}
        </div>
        <p className="max-w-sm text-center text-xs text-muted-foreground">
          {t("scanningHint")}
        </p>
        <div className="grid w-full max-w-sm grid-cols-2 gap-x-6 gap-y-1.5">
          {ALL_AGENT_TYPES.map((agent) => {
            const entry = progressAgents.find((p) => p.agentType === agent)
            return (
              <div
                key={agent}
                className="flex h-5 items-center gap-2 text-xs"
                data-scan-agent={agent}
              >
                <AgentIcon agentType={agent} className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {getAgentLabel(agent)}
                </span>
                {entry ? (
                  <span className="tabular-nums text-muted-foreground">
                    {entry.sessionCount}
                  </span>
                ) : (
                  <Skeleton className="h-3 w-6 rounded-sm" />
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  if (phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <TriangleAlert className="h-6 w-6 text-destructive" />
        <p className="text-sm font-medium">{t("scanFailed")}</p>
        {scanError && (
          <p className="max-w-md text-center text-xs text-muted-foreground">
            {scanError}
          </p>
        )}
        <Button size="sm" onClick={runScan}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("retry")}
        </Button>
      </div>
    )
  }

  if (phase === "done" && importResult) {
    const stats: { label: string; value: number }[] = [
      { label: t("doneImported"), value: importResult.imported },
      { label: t("doneRestored"), value: importResult.restored ?? 0 },
      { label: t("doneUpdated"), value: importResult.updated },
      { label: t("doneSkipped"), value: importResult.skipped },
      { label: t("doneCreatedFolders"), value: importResult.created_folders },
      { label: t("doneNotFound"), value: importResult.not_found },
      { label: t("doneFailed"), value: importResult.failed },
    ]
    const hasFailures =
      importResult.failed > 0 || importResult.errors.length > 0
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        {hasFailures ? (
          <TriangleAlert className="h-7 w-7 text-destructive" />
        ) : (
          <CheckCircle2 className="h-7 w-7 text-green-500" />
        )}
        <p className="text-sm font-semibold">{t("doneTitle")}</p>
        <div className="grid grid-cols-4 gap-x-8 gap-y-2">
          {stats.map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-lg font-semibold tabular-nums">
                {stat.value}
              </div>
              <div className="text-2xs text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
        {hasFailures && importResult.errors.length > 0 && (
          <div className="max-h-28 w-full max-w-lg overflow-y-auto rounded-md border border-destructive/40 bg-destructive/5 p-2">
            {importResult.errors.map((message, index) => (
              <p key={index} className="text-xs text-destructive">
                {message}
              </p>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleContinue}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("continueImport")}
          </Button>
          <Button size="sm" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </div>
    )
  }

  const empty = !scan || scan.folders.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="h-8 w-56 text-xs"
          disabled={busy}
        />
        <Select
          value={agentFilter}
          onValueChange={(value) => setAgentFilter(value as AgentType | "all")}
          disabled={busy}
        >
          <SelectTrigger className="h-8 w-40 text-xs" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              {t("allAgents")}
            </SelectItem>
            {ALL_AGENT_TYPES.map((agent) => (
              <SelectItem key={agent} value={agent} className="text-xs">
                <span className="flex items-center gap-1.5">
                  <AgentIcon agentType={agent} className="h-3.5 w-3.5" />
                  {getAgentLabel(agent)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={onlyImportable}
            onCheckedChange={setOnlyImportable}
            disabled={busy}
          />
          {t("onlyImportable")}
        </label>
        <label
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          title={t("includeDeletedHint")}
        >
          <Switch
            // The opt-in survives a re-scan (it is the user's standing intent,
            // and a re-scan clears the selection anyway), but a scan that finds
            // nothing deleted has nothing to opt into — show it off rather than
            // on-but-disabled. Behaviour is identical either way: with no
            // deleted rows, the flag cannot select anything.
            checked={includeDeleted && deletedTotal > 0}
            onCheckedChange={toggleIncludeDeleted}
            disabled={busy || deletedTotal === 0}
          />
          {deletedTotal > 0
            ? t("includeDeletedWithCount", { count: deletedTotal })
            : t("includeDeleted")}
        </label>
        <div className="flex-1" />
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={busy || filteredFolders.length === 0}
          onClick={toggleCollapseAll}
          aria-label={allCollapsed ? t("expandAll") : t("collapseAll")}
          title={allCollapsed ? t("expandAll") : t("collapseAll")}
        >
          {allCollapsed ? (
            <ChevronsUpDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronsDownUp className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          disabled={busy || allVisibleImportableKeys.length === 0}
          onClick={() => setSelected(new Set(allVisibleImportableKeys))}
        >
          {t("selectAll")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          disabled={busy || selectedCount === 0}
          onClick={() => setSelected(new Set())}
        >
          {t("clearSelection")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          disabled={busy}
          onClick={() => {
            focusAppliedRef.current = true
            runScan()
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("rescan")}
        </Button>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8">
            <FolderPlus className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">{t("empty")}</p>
            <p className="text-xs text-muted-foreground">{t("emptyHint")}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("noMatches")}
          </div>
        ) : (
          <ScrollArea
            className="h-full px-2 py-1.5"
            onViewportRef={handleViewportRef}
          >
            {viewportEl ? (
              <Virtualizer
                ref={virtualizerRef}
                scrollRef={viewportRef}
                data={rows}
                itemSize={36}
                bufferSize={400}
              >
                {(row: Row) => {
                  if (row.kind === "folder") {
                    const entry = folderSelection.get(row.folder.path)
                    return (
                      <div key={rowKey(row)} className="pb-0.5">
                        <FolderHeaderRow
                          folder={row.folder}
                          visibleCount={row.sessions.length}
                          importableCount={entry?.selectable.length ?? 0}
                          selectedCount={entry?.selected ?? 0}
                          collapsed={collapsed.has(row.folder.path)}
                          disabled={busy}
                          onToggleCollapse={toggleCollapse}
                          onToggleFolder={toggleFolder}
                        />
                      </div>
                    )
                  }
                  return (
                    <div key={rowKey(row)}>
                      <SessionRow
                        session={row.session}
                        checked={selected.has(sessionKey(row.session))}
                        disabled={busy}
                        includeDeleted={includeDeleted}
                        onToggle={toggleSession}
                      />
                    </div>
                  )
                }}
              </Virtualizer>
            ) : (
              <div className="space-y-1.5 p-1">
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} className="h-9 w-full rounded-md" />
                ))}
              </div>
            )}
          </ScrollArea>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 border-t border-border/50 px-3 py-2">
        {scan && (
          <span className="text-xs text-muted-foreground">
            {t("summaryCounts", {
              total: scan.total_sessions,
              importable: selectableTotal,
              folders: scan.folders.length,
            })}
            {scan.no_folder_count > 0 && (
              <span className="ml-2">
                {t("noFolderSkipped", { count: scan.no_folder_count })}
              </span>
            )}
          </span>
        )}
        <div className="flex-1" />
        <span
          className={cn(
            "text-xs tabular-nums",
            selectedCount > 0 ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {t("selectedCount", { count: selectedCount })}
        </span>
        <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
          {t("close")}
        </Button>
        <Button
          size="sm"
          disabled={busy || selectedCount === 0}
          onClick={() => void handleImport()}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {busy ? t("importing") : t("importSelected")}
        </Button>
      </div>
    </div>
  )
}
