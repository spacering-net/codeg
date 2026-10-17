"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  Lock,
  MoreHorizontal,
} from "lucide-react"
import { useTranslations } from "next-intl"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"
import type { LucideIcon } from "lucide-react"

import { AgentIcon } from "@/components/agent-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { cn } from "@/lib/utils"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AcpAgentInfo,
  AgentType,
  ExpertInstallStatus,
  ExpertLinkState,
  LinkOp,
  LinkOpResult,
} from "@/lib/types"

// ─── Normalized row + props ─────────────────────────────────────────────

export interface MatrixSkill {
  id: string
  category: string
  /** Already localized by the page. */
  displayName: string
  /** Already localized by the page. */
  description: string
  icon: LucideIcon
  /** Office: installedCentrally. Experts: always true. Gates enabling. */
  ready: boolean
  /** Optional row badge, e.g. experts "user modified" or office "not synced". */
  badge?: { label: string; tone: "amber" | "muted" }
}

export interface SkillAgentMatrixProps {
  skills: MatrixSkill[]
  agents: AcpAgentInfo[]
  categoryOrder: Record<string, number>
  translateCategory: (category: string) => string
  translateState: (state: ExpertLinkState) => string
  /** Authoritative snapshot loader; called on mount and after every batch. */
  loadAllStatuses: () => Promise<ExpertInstallStatus[]>
  applyLinks: (ops: LinkOp[]) => Promise<LinkOpResult[]>
  /** SKILL.md body for the detail drawer (page owns the experts/office split). */
  loadContent: (skillId: string) => Promise<string>
  /** Notified after a batch reconciles, with the distinct agents touched. */
  onApplied?: (touchedAgents: AgentType[]) => void
  searchPlaceholder?: string
  /** Shows the search box (the default). A pack of one skill turns it off:
   *  there is nothing to filter. */
  searchable?: boolean
  /** Tooltip shown over a not-ready skill's cells (office: "sync first"). */
  notReadyHint?: string
  /**
   * Optional authoring slots — the three curated packs pass nothing (behavior
   * unchanged); the Custom pack injects create/import/edit/duplicate/delete UI.
   */
  /** Extra buttons in the toolbar, right of the search box (e.g. New / Import). */
  toolbarActions?: ReactNode
  /** Extra items appended to a row's `⋯` menu (e.g. Edit / Duplicate / Delete). */
  rowActions?: (skill: MatrixSkill) => ReactNode
  /** Extra buttons in the selection bulk bar (e.g. Delete selected). */
  bulkActions?: (selectedIds: string[]) => ReactNode
}

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────

export function statusKey(skillId: string, agentType: AgentType): string {
  return `${skillId}:${agentType}`
}

function isEnabled(status: ExpertInstallStatus | undefined): boolean {
  return status?.state === "linked_to_codeg"
}

/** Blocked from being enabled: a real dir or a foreign link sits in the way. */
function isBlockedForEnable(status: ExpertInstallStatus | undefined): boolean {
  return (
    status?.state === "blocked_by_real_directory" ||
    status?.state === "linked_elsewhere"
  )
}

export interface DeltaTarget {
  skillId: string
  agentType: AgentType
}

/**
 * Minimal set of ops to move `targets` to `enable`. Cells already in the target
 * state are skipped; when enabling, not-ready skills and blocked cells are
 * skipped (they can't be linked). Disabling only emits currently-enabled cells.
 * Returns `[]` when nothing needs to change (the caller must not call the
 * backend for an empty delta).
 */
export function computeLinkDelta(
  targets: DeltaTarget[],
  enable: boolean,
  statuses: Map<string, ExpertInstallStatus>,
  isSkillEnableable: (skillId: string) => boolean
): LinkOp[] {
  const ops: LinkOp[] = []
  const seen = new Set<string>()
  for (const { skillId, agentType } of targets) {
    const key = statusKey(skillId, agentType)
    if (seen.has(key)) continue
    seen.add(key)
    const status = statuses.get(key)
    if (enable === isEnabled(status)) continue
    if (enable) {
      if (!isSkillEnableable(skillId)) continue
      if (isBlockedForEnable(status)) continue
    }
    ops.push({ expertId: skillId, agentType, enable })
  }
  return ops
}

function buildMap(
  list: ExpertInstallStatus[]
): Map<string, ExpertInstallStatus> {
  const map = new Map<string, ExpertInstallStatus>()
  for (const s of list) map.set(statusKey(s.expertId, s.agentType), s)
  return map
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/)
  return match ? content.slice(match[0].length) : content
}

// ─── Component ──────────────────────────────────────────────────────────

export function SkillAgentMatrix({
  skills,
  agents,
  categoryOrder,
  translateCategory,
  translateState,
  loadAllStatuses,
  applyLinks,
  loadContent,
  onApplied,
  searchPlaceholder,
  searchable = true,
  notReadyHint,
  toolbarActions,
  rowActions,
  bulkActions,
}: SkillAgentMatrixProps) {
  const t = useTranslations("SkillMatrix")

  const [statuses, setStatuses] = useState<Map<string, ExpertInstallStatus>>(
    new Map()
  )
  const [statusLoading, setStatusLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkAgents, setBulkAgents] = useState<Set<AgentType>>(
    () => new Set(agents.map((a) => a.agent_type))
  )
  const [search, setSearch] = useState("")
  const [confirm, setConfirm] = useState<LinkOp[] | null>(null)
  const [detailSkillId, setDetailSkillId] = useState<string | null>(null)
  const [detailContent, setDetailContent] = useState("")
  const [detailLoading, setDetailLoading] = useState(false)

  const agentTypes = useMemo(() => agents.map((a) => a.agent_type), [agents])

  const isSkillEnableable = useCallback(
    (skillId: string) => skills.find((s) => s.id === skillId)?.ready ?? false,
    [skills]
  )

  // Initial snapshot. `statusLoading` starts true and is only cleared here, so
  // the effect needs no synchronous setState (which the repo lint forbids).
  useEffect(() => {
    let cancelled = false
    loadAllStatuses()
      .then((list) => {
        if (!cancelled) setStatuses(buildMap(list))
      })
      .catch((err) => {
        if (!cancelled)
          toast.error(t("toasts.loadFailed"), {
            description: toErrorMessage(err),
          })
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadAllStatuses, t])

  // Detail drawer content. Loading flags are set by `openDetail` (an event
  // handler) so this effect stays free of synchronous setState.
  useEffect(() => {
    if (!detailSkillId) return
    let cancelled = false
    loadContent(detailSkillId)
      .then((body) => {
        if (!cancelled) setDetailContent(stripFrontmatter(body))
      })
      .catch((err) => {
        if (!cancelled)
          toast.error(t("toasts.loadFailed"), {
            description: toErrorMessage(err),
          })
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [detailSkillId, loadContent, t])

  const visibleSkills = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? skills.filter(
          (s) =>
            s.id.toLowerCase().includes(q) ||
            s.displayName.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q)
        )
      : skills
    return [...filtered].sort((a, b) => {
      const ca = categoryOrder[a.category] ?? 99
      const cb = categoryOrder[b.category] ?? 99
      if (ca !== cb) return ca - cb
      return a.displayName.localeCompare(b.displayName)
    })
  }, [skills, search, categoryOrder])

  const grouped = useMemo(() => {
    const groups = new Map<string, MatrixSkill[]>()
    for (const s of visibleSkills) {
      const list = groups.get(s.category) ?? []
      list.push(s)
      groups.set(s.category, list)
    }
    return Array.from(groups.entries()).sort(
      (a, b) => (categoryOrder[a[0]] ?? 99) - (categoryOrder[b[0]] ?? 99)
    )
  }, [visibleSkills, categoryOrder])

  const visibleIds = useMemo(
    () => visibleSkills.map((s) => s.id),
    [visibleSkills]
  )
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someVisibleSelected = visibleIds.some((id) => selected.has(id))
  const selectedVisibleIds = visibleIds.filter((id) => selected.has(id))

  const enabledCountForSkill = useCallback(
    (id: string) =>
      agentTypes.filter((a) => isEnabled(statuses.get(statusKey(id, a))))
        .length,
    [agentTypes, statuses]
  )
  const enabledCountForAgent = useCallback(
    (a: AgentType) =>
      visibleSkills.filter((s) => isEnabled(statuses.get(statusKey(s.id, a))))
        .length,
    [visibleSkills, statuses]
  )

  // ─── Apply ──────────────────────────────────────────────────────────

  const runOps = useCallback(
    async (ops: LinkOp[]) => {
      if (ops.length === 0) return
      setApplying(true)
      setPendingKeys(
        new Set(ops.map((o) => statusKey(o.expertId, o.agentType)))
      )
      // Optimistic.
      setStatuses((prev) => {
        const next = new Map(prev)
        for (const op of ops) {
          const key = statusKey(op.expertId, op.agentType)
          const existing = next.get(key)
          next.set(key, {
            expertId: op.expertId,
            agentType: op.agentType,
            state: op.enable ? "linked_to_codeg" : "not_linked",
            linkPath: existing?.linkPath ?? "",
            targetPath: existing?.targetPath ?? null,
            expectedTargetPath: existing?.expectedTargetPath ?? "",
            copyMode: existing?.copyMode ?? false,
          })
        }
        return next
      })

      const enable = ops[0]?.enable ?? true
      let results: LinkOpResult[] = []
      let applyError: unknown = null
      try {
        results = await applyLinks(ops)
      } catch (err) {
        applyError = err
      }

      // Reconcile to authoritative truth (covers shared-dir cross-effects and
      // any per-op failure).
      try {
        setStatuses(buildMap(await loadAllStatuses()))
      } catch (err) {
        console.warn("[SkillAgentMatrix] reconcile failed:", err)
      }
      onApplied?.(Array.from(new Set(ops.map((o) => o.agentType))))

      if (applyError) {
        toast.error(t("toasts.applyFailed"), {
          description: toErrorMessage(applyError),
        })
      } else {
        const okCount = results.filter((r) => r.ok).length
        const failCount = results.length - okCount
        if (failCount === 0) {
          toast.success(
            enable
              ? t("toasts.enabled", { count: okCount })
              : t("toasts.disabled", { count: okCount })
          )
        } else {
          const firstErr = results.find((r) => !r.ok)?.error ?? undefined
          toast.warning(
            enable
              ? t("toasts.enabledPartial", { ok: okCount, failed: failCount })
              : t("toasts.disabledPartial", { ok: okCount, failed: failCount }),
            { description: firstErr }
          )
        }
      }

      setApplying(false)
      setPendingKeys(new Set())
    },
    [applyLinks, loadAllStatuses, onApplied, t]
  )

  /** Enable ops run immediately; destructive (disable) bulk ops confirm first. */
  const dispatch = useCallback(
    (ops: LinkOp[], destructive: boolean) => {
      if (ops.length === 0) return
      if (destructive) {
        setConfirm(ops)
      } else {
        void runOps(ops)
      }
    },
    [runOps]
  )

  const toggleCell = useCallback(
    (skillId: string, agentType: AgentType) => {
      const enabled = isEnabled(statuses.get(statusKey(skillId, agentType)))
      // Single-cell toggles are frictionless — no confirm even when disabling.
      void runOps(
        computeLinkDelta(
          [{ skillId, agentType }],
          !enabled,
          statuses,
          isSkillEnableable
        )
      )
    },
    [statuses, isSkillEnableable, runOps]
  )

  const rowBatch = (skillId: string, enable: boolean) =>
    dispatch(
      computeLinkDelta(
        agentTypes.map((agentType) => ({ skillId, agentType })),
        enable,
        statuses,
        isSkillEnableable
      ),
      !enable
    )

  const columnBatch = (agentType: AgentType, enable: boolean) =>
    dispatch(
      computeLinkDelta(
        visibleSkills.map((s) => ({ skillId: s.id, agentType })),
        enable,
        statuses,
        isSkillEnableable
      ),
      !enable
    )

  const everythingBatch = (enable: boolean) =>
    dispatch(
      computeLinkDelta(
        visibleSkills.flatMap((s) =>
          agentTypes.map((agentType) => ({ skillId: s.id, agentType }))
        ),
        enable,
        statuses,
        isSkillEnableable
      ),
      !enable
    )

  const selectedBatch = (enable: boolean) => {
    const targetAgents = bulkAgents.size ? Array.from(bulkAgents) : agentTypes
    dispatch(
      computeLinkDelta(
        selectedVisibleIds.flatMap((skillId) =>
          targetAgents.map((agentType) => ({ skillId, agentType }))
        ),
        enable,
        statuses,
        isSkillEnableable
      ),
      !enable
    )
  }

  // ─── Selection ──────────────────────────────────────────────────────

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleSelectAll = () =>
    setSelected((prev) => {
      if (visibleIds.every((id) => prev.has(id))) {
        const next = new Set(prev)
        for (const id of visibleIds) next.delete(id)
        return next
      }
      const next = new Set(prev)
      for (const id of visibleIds) next.add(id)
      return next
    })

  const openDetail = useCallback((skillId: string) => {
    setDetailContent("")
    setDetailLoading(true)
    setDetailSkillId(skillId)
  }, [])

  const interactive = !applying

  const detailSkill = detailSkillId
    ? (skills.find((s) => s.id === detailSkillId) ?? null)
    : null

  if (statusLoading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-full flex flex-col min-h-0 min-w-0">
        {/* Toolbar: search + everything menu. */}
        <div className="flex items-center gap-2 pb-3">
          {searchable && (
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder ?? t("searchPlaceholder")}
              className="max-w-xs"
            />
          )}
          <div className="ml-auto flex items-center gap-2">
            {toolbarActions}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={!interactive}>
                  {t("everything.label")}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => everythingBatch(true)}>
                  {t("everything.enable")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => everythingBatch(false)}>
                  {t("everything.disable")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Matrix. */}
        <div className="relative flex-1 min-h-0 rounded-lg border bg-card overflow-auto">
          {applying && (
            <div className="absolute inset-0 z-30 bg-background/40 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {visibleSkills.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground p-6">
              {search ? t("emptySearch") : t("empty")}
            </div>
          ) : (
            // `w-full` + a trailing flexible spacer column makes every rule
            // (header border, category bars, row borders) span the full card
            // width — no hard cliff — while real columns stay compact. When the
            // columns exceed the card the wrapper scrolls horizontally.
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-20 bg-card">
                <tr>
                  {/* Corner: select-all + everything menu. */}
                  <th className="sticky left-0 z-10 bg-card border-b border-r px-2 py-2 text-left align-middle min-w-[16.25rem]">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={
                          allVisibleSelected
                            ? true
                            : someVisibleSelected
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={toggleSelectAll}
                        disabled={!interactive}
                        aria-label={t("selectAll")}
                      />
                      <span className="text-2xs uppercase tracking-wide font-semibold text-muted-foreground">
                        {t("skillColumn")}
                      </span>
                    </div>
                  </th>
                  {agents.map((agent) => (
                    <th
                      key={agent.agent_type}
                      scope="col"
                      className="border-b px-1 py-2 align-middle min-w-[3rem]"
                    >
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                disabled={!interactive}
                                className="mx-auto flex flex-col items-center gap-0.5 rounded-md px-1.5 py-1 hover:bg-muted/50 disabled:opacity-50"
                                aria-label={agent.name}
                              >
                                <AgentIcon
                                  agentType={agent.agent_type}
                                  className="h-4 w-4"
                                />
                                <span className="text-3xs text-muted-foreground tabular-nums">
                                  {enabledCountForAgent(agent.agent_type)}
                                </span>
                              </button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent>{agent.name}</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="center">
                          <DropdownMenuLabel>{agent.name}</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => columnBatch(agent.agent_type, true)}
                          >
                            {t("columnMenu.enableAll")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              columnBatch(agent.agent_type, false)
                            }
                          >
                            {t("columnMenu.disableAll")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </th>
                  ))}
                  {/* Flexible spacer: absorbs slack so the header rule reaches
                      the card's right edge. */}
                  <th aria-hidden className="w-full border-b" />
                </tr>
              </thead>
              <tbody>
                {grouped.map(([category, items]) => (
                  <CategoryGroup
                    key={category}
                    label={translateCategory(category)}
                    colSpan={agents.length + 2}
                  >
                    {items.map((skill) => (
                      <tr key={skill.id} className="border-b last:border-b-0">
                        {/* Sticky row header. */}
                        <th
                          scope="row"
                          className="sticky left-0 z-10 bg-card border-r px-2 py-1.5 text-left font-normal min-w-[16.25rem]"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Checkbox
                              checked={selected.has(skill.id)}
                              onCheckedChange={() => toggleSelect(skill.id)}
                              disabled={!interactive}
                              aria-label={t("selectSkill", {
                                name: skill.displayName,
                              })}
                            />
                            <skill.icon className="h-4 w-4 shrink-0 text-primary/80" />
                            <button
                              type="button"
                              onClick={() => openDetail(skill.id)}
                              className="min-w-0 flex-1 text-left"
                            >
                              <span className="block truncate text-sm font-medium hover:underline">
                                {skill.displayName}
                              </span>
                            </button>
                            {skill.badge && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "h-5 px-1.5 text-3xs shrink-0",
                                  skill.badge.tone === "amber"
                                    ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                    : "text-muted-foreground"
                                )}
                              >
                                {skill.badge.label}
                              </Badge>
                            )}
                            <Badge
                              variant="outline"
                              className="h-5 px-1.5 text-3xs shrink-0 tabular-nums text-muted-foreground"
                            >
                              {enabledCountForSkill(skill.id)}/{agents.length}
                            </Badge>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  disabled={!interactive}
                                  className="shrink-0 rounded p-1 hover:bg-muted/60 disabled:opacity-50"
                                  aria-label={t("rowMenu.label", {
                                    name: skill.displayName,
                                  })}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onSelect={() => rowBatch(skill.id, true)}
                                >
                                  {t("rowMenu.enableAll")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => rowBatch(skill.id, false)}
                                >
                                  {t("rowMenu.disableAll")}
                                </DropdownMenuItem>
                                {rowActions && (
                                  <>
                                    <DropdownMenuSeparator />
                                    {rowActions(skill)}
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </th>
                        {agents.map((agent) => {
                          const key = statusKey(skill.id, agent.agent_type)
                          const status = statuses.get(key)
                          return (
                            <td
                              key={agent.agent_type}
                              className="px-1 py-1.5 text-center align-middle leading-none"
                            >
                              <MatrixCell
                                skillName={skill.displayName}
                                agentName={agent.name}
                                ready={skill.ready}
                                status={status}
                                pending={pendingKeys.has(key)}
                                disabled={!interactive}
                                translateState={translateState}
                                notReadyHint={notReadyHint}
                                copyModeHint={t("copyModeHint")}
                                onToggle={() =>
                                  toggleCell(skill.id, agent.agent_type)
                                }
                              />
                            </td>
                          )
                        })}
                        <td aria-hidden className="w-full" />
                      </tr>
                    ))}
                  </CategoryGroup>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Bulk action bar. */}
        {selectedVisibleIds.length > 0 && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
            <span className="text-sm font-medium">
              {t("bulk.selected", { count: selectedVisibleIds.length })}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={!interactive}>
                  {bulkAgents.size === agentTypes.length
                    ? t("bulk.targetAll")
                    : t("bulk.targetSome", { count: bulkAgents.size })}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {agents.map((agent) => (
                  <DropdownMenuCheckboxItem
                    key={agent.agent_type}
                    checked={bulkAgents.has(agent.agent_type)}
                    onCheckedChange={(checked) =>
                      setBulkAgents((prev) => {
                        const next = new Set(prev)
                        if (checked) next.add(agent.agent_type)
                        else next.delete(agent.agent_type)
                        return next
                      })
                    }
                    onSelect={(e) => e.preventDefault()}
                  >
                    {agent.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="ml-auto flex items-center gap-2">
              {bulkActions?.(selectedVisibleIds)}
              <Button
                size="sm"
                disabled={!interactive}
                onClick={() => selectedBatch(true)}
              >
                {t("bulk.enable")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!interactive}
                onClick={() => selectedBatch(false)}
              >
                {t("bulk.disable")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
              >
                {t("bulk.clear")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Destructive-batch confirm. */}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.disableTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirm.disableBody", { count: confirm?.length ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const ops = confirm ?? []
                setConfirm(null)
                void runOps(ops)
              }}
            >
              {t("confirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Detail drawer: preview + per-agent toggles. */}
      <Drawer
        open={detailSkill !== null}
        onOpenChange={(open) => {
          if (!open) setDetailSkillId(null)
        }}
        swipeDirection="right"
      >
        <DrawerContent className="w-[min(42.5rem,calc(100vw-1rem))] sm:max-w-[42.5rem] flex flex-col">
          {detailSkill && (
            <>
              {/* `pr-12` clears the close button (`right-4` + `size-8`), which
                  the header's own `p-4` no longer does on its own. */}
              <DrawerHeader className="pr-12">
                <DrawerTitle className="flex items-center gap-2">
                  <detailSkill.icon className="h-5 w-5 text-primary/80" />
                  {detailSkill.displayName}
                </DrawerTitle>
                <DrawerDescription>{detailSkill.description}</DrawerDescription>
              </DrawerHeader>
              <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-4">
                <div className="rounded-md border p-3">
                  <div className="text-2xs text-muted-foreground mb-2">
                    {t("detail.enableForAgents")}
                  </div>
                  <div className="space-y-1.5">
                    {agents.map((agent) => {
                      const key = statusKey(detailSkill.id, agent.agent_type)
                      const status = statuses.get(key)
                      const enabled = isEnabled(status)
                      const blocked = isBlockedForEnable(status)
                      return (
                        <div
                          key={agent.agent_type}
                          className={cn(
                            "flex items-center gap-3 rounded-md border px-3 py-2",
                            enabled
                              ? "border-primary/40 bg-primary/5"
                              : "border-border"
                          )}
                        >
                          <AgentIcon
                            agentType={agent.agent_type}
                            className="h-4 w-4 shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">
                              {agent.name}
                            </div>
                            <div className="text-2xs text-muted-foreground truncate">
                              {status ? translateState(status.state) : "—"}
                            </div>
                          </div>
                          <Switch
                            checked={enabled}
                            disabled={
                              applying ||
                              pendingKeys.has(key) ||
                              !detailSkill.ready ||
                              (blocked && !enabled)
                            }
                            onCheckedChange={() =>
                              toggleCell(detailSkill.id, agent.agent_type)
                            }
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="rounded-md border p-3">
                  <div className="text-2xs text-muted-foreground mb-2">
                    {t("detail.preview")}
                  </div>
                  {detailLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t("detail.loadingContent")}
                    </div>
                  ) : (
                    <div
                      className={cn(
                        "text-sm leading-6 rounded-md bg-muted/10 p-3 overflow-auto max-h-[30rem]",
                        "[&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mb-3",
                        "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2",
                        "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2",
                        "[&_p]:mb-3 [&_li]:mb-1",
                        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
                        "[&_code]:font-mono [&_code]:text-xs [&_code]:bg-muted [&_code]:rounded [&_code]:px-1",
                        "[&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto"
                      )}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {detailContent}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </TooltipProvider>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────

function CategoryGroup({
  label,
  colSpan,
  children,
}: {
  label: string
  colSpan: number
  children: React.ReactNode
}) {
  return (
    <>
      <tr>
        <td
          colSpan={colSpan}
          className="sticky left-0 bg-muted/30 border-y px-2 py-1 text-2xs uppercase tracking-wide font-semibold text-muted-foreground"
        >
          {label}
        </td>
      </tr>
      {children}
    </>
  )
}

function MatrixCell({
  skillName,
  agentName,
  ready,
  status,
  pending,
  disabled,
  translateState,
  notReadyHint,
  copyModeHint,
  onToggle,
}: {
  skillName: string
  agentName: string
  ready: boolean
  status: ExpertInstallStatus | undefined
  pending: boolean
  disabled: boolean
  translateState: (state: ExpertLinkState) => string
  notReadyHint?: string
  copyModeHint: string
  onToggle: () => void
}) {
  const enabled = isEnabled(status)
  const blocked = isBlockedForEnable(status)
  const broken = status?.state === "broken"
  // Mirror the single-toggle predicate: a not-ready skill or a blocked cell
  // can't be enabled, so it's non-interactive unless already enabled.
  const notInteractive =
    disabled || pending || ((!ready || blocked) && !enabled)

  const stateLabel = status ? translateState(status.state) : "—"
  const tip = [
    `${skillName} · ${agentName}`,
    stateLabel,
    status?.copyMode ? copyModeHint : null,
    !ready && !enabled ? notReadyHint : null,
  ]
    .filter(Boolean)
    .join(" — ")

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${skillName}, ${agentName}: ${stateLabel}`}
          aria-disabled={notInteractive}
          disabled={notInteractive}
          onClick={onToggle}
          className={cn(
            // `align-middle` decouples the button from the text baseline so an
            // empty cell (no svg) and a filled cell (Check svg) reserve the same
            // line-box height — otherwise a fully-enabled row renders shorter.
            "inline-flex h-7 w-7 items-center justify-center rounded-md border align-middle transition-colors",
            enabled
              ? "border-primary bg-primary text-primary-foreground"
              : broken
                ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                : blocked || !ready
                  ? "border-dashed border-border/70 text-muted-foreground/60"
                  : "border-border hover:bg-muted/60",
            status?.copyMode && enabled && "ring-1 ring-amber-400",
            notInteractive && !enabled && "cursor-not-allowed opacity-60"
          )}
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : enabled ? (
            <Check className="h-4 w-4" />
          ) : broken ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : blocked || !ready ? (
            <Lock className="h-3 w-3" />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
