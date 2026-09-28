"use client"

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CalendarClock,
  Clock,
  CirclePlay,
  Folder,
  GitBranch,
  ListFilter,
  Loader2,
  MoreHorizontal,
  MousePointerClick,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  RotateCw,
  SlidersHorizontal,
  SquareArrowOutUpRight,
  SquareKanban,
  Trash2,
  X,
  Zap,
} from "lucide-react"
import { useAutomationsView } from "@/contexts/automations-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useTabActions } from "@/contexts/tab-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { AutomationEditor } from "./automation-editor"
import {
  templateToDraft,
  type AutomationTemplate,
} from "./automation-templates"
import { TemplateGallery } from "./template-gallery"
import { ScheduleLabel } from "./schedule-label"
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
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import {
  FolderSelect,
  type FolderSelectOption,
} from "@/components/shared/folder-select"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  automationCancelRun,
  automationCreate,
  automationDelete,
  automationMarkSeen,
  automationRunNow,
  automationRuns,
  automationSetEnabled,
  automationUpdate,
} from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { cn } from "@/lib/utils"
import type { Automation, AutomationDraft, AutomationRun } from "@/lib/types"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"

const AUTOMATION_CHANGED_EVENT = "automation://changed"

const STATUS_STYLES: Record<string, string> = {
  running: "bg-primary/10 text-primary",
  succeeded: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
}

function StatusChip({ status }: { status: string | null }) {
  const t = useTranslations("Automations")
  if (!status) return null
  const label =
    {
      running: t("statusRunning"),
      succeeded: t("statusSucceeded"),
      failed: t("statusFailed"),
      cancelled: t("statusCancelled"),
      skipped: t("statusSkipped"),
    }[status] ?? status
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[0.6875rem] font-medium",
        STATUS_STYLES[status] ?? "bg-muted text-muted-foreground"
      )}
    >
      {label}
    </span>
  )
}

// Compact, i18n-free relative time ("now"/"5m"/"2h"/"3d"/"2mo"/"1y"), matching
// the sidebar conversation list's style. Absolute time rides in the title attr.
function formatRelative(iso: string | null, now: number): string {
  if (!iso) return "—"
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return "—"
  const sec = Math.max(0, Math.round((now - ts) / 1000))
  if (sec < 45) return "now"
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d`
  const mo = Math.round(day / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.round(mo / 12)}y`
}

// Forward-looking sibling of formatRelative ("1m"/"3h"/"2d") for the next run.
// Floors at 1m so an imminent run never renders as "0m".
function formatRelativeFuture(iso: string | null, now: number): string {
  if (!iso) return "—"
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return "—"
  const sec = Math.max(0, Math.round((ts - now) / 1000))
  const min = Math.max(1, Math.round(sec / 60))
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d`
  const mo = Math.round(day / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.round(mo / 12)}y`
}

function formatDuration(
  startIso: string | null,
  endIso: string | null
): string {
  if (!startIso || !endIso) return "—"
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—"
  const sec = Math.round((end - start) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

// Absolute local date-time for run-history rows; null/invalid → "—".
function formatDateTime(iso: string | null): string {
  if (!iso) return "—"
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return "—"
  return new Date(ts).toLocaleString()
}

/** The detail pane's three states. "gallery" is the template picker shown when
 *  starting a new automation; "editor" hosts the form, seeded from a template
 *  (create) or an existing automation (edit). */
type EditingState =
  | { kind: "create"; seed: AutomationDraft | null }
  | { kind: "edit"; automation: Automation }

/** Page title rendered into the window-chrome strip above the page (the h-10
 *  band shared with the fixed corner overlays) — the shared breadcrumb header,
 *  so all three workbench routes open with an identical header rhythm and the
 *  same way back to the conversation workspace. */
export function AutomationsPageTitle() {
  const t = useTranslations("Automations")
  return <WorkbenchPageTitle title={t("title")} />
}

export function AutomationsPage() {
  const t = useTranslations("Automations")
  const { automations, unseenFailures, refetch } = useAutomationsView()
  const folders = useAppWorkspaceStore((s) => s.folders)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [mode, setMode] = useState<"detail" | "gallery" | "editor">("detail")
  const [editing, setEditing] = useState<EditingState | null>(null)

  // Clear the unseen-failure badges while the page is open — on entry and again
  // whenever a new failure arrives live (the failed run is already on screen, so
  // the sidebar badge shouldn't keep nagging). Keying on unseenFailures rather
  // than mount makes it re-fire on the automation://changed refetch; it
  // converges because markSeen drives the count to 0, after which this early
  // returns. refetch is stable.
  useEffect(() => {
    if (unseenFailures === 0) return
    void automationMarkSeen()
      .then(() => refetch())
      .catch(() => {})
  }, [unseenFailures, refetch])

  const hasAutomations = automations.length > 0
  // The shown automation: the explicit selection, else the first row, so the
  // detail pane is never blank when automations exist. Derived (no effect) so a
  // deleted selection cleanly falls back instead of dangling.
  const current =
    automations.find((a) => a.id === selectedId) ?? automations[0] ?? null
  // Frozen at mount — the page remounts on each route entry, so relative labels
  // ("Next in 3h") are anchored to when Automations was opened. Reading Date.now
  // during render is impure (react-hooks/purity); this is the RunHistory idiom.
  const [now] = useState(() => Date.now())

  // List filters (folder + enabled state), ephemeral per page mount.
  const [folderFilter, setFolderFilter] = useState<number | "all">("all")
  const [statusFilter, setStatusFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all")
  // Folder options: the workspace's project folders (same set the Tasks board
  // filters by), plus any other folder an automation actually targets — the
  // editor lets a launch_session run point at a worktree subfolder, which is
  // not a project folder but must still be filterable.
  const folderOptions = useMemo(() => {
    const options = new Map<number, FolderSelectOption>()
    for (const f of folders) {
      if (f.parent_id == null && f.kind === "regular")
        options.set(f.id, {
          id: f.id,
          name: f.name,
          alias: f.alias,
          path: f.path,
        })
    }
    const byId = new Map(folders.map((f) => [f.id, f]))
    for (const a of automations) {
      if (a.root_folder_id == null || options.has(a.root_folder_id)) continue
      const known = byId.get(a.root_folder_id)
      options.set(a.root_folder_id, {
        id: a.root_folder_id,
        // A folder the workspace no longer lists is still filterable — by the
        // only handle left, its id.
        name: known?.name ?? `#${a.root_folder_id}`,
        alias: known?.alias ?? null,
        path: known?.path ?? null,
      })
    }
    // Sorted by what the row leads with, so the list reads in the order it looks.
    return [...options.values()].sort((a, b) =>
      (a.alias ?? a.name).localeCompare(b.alias ?? b.name)
    )
  }, [automations, folders])
  // Deleting the last automation of a folder strands the filter on an option
  // that no longer exists. Fall back to "all" by derivation (no effect) so the
  // pill never renders blank over an empty list.
  const activeFolderFilter =
    folderFilter !== "all" && !folderOptions.some((f) => f.id === folderFilter)
      ? "all"
      : folderFilter
  const visibleAutomations = useMemo(
    () =>
      automations.filter(
        (a) =>
          (activeFolderFilter === "all" ||
            a.root_folder_id === activeFolderFilter) &&
          (statusFilter === "all" ||
            (statusFilter === "enabled" ? a.enabled : !a.enabled))
      ),
    [automations, activeFolderFilter, statusFilter]
  )

  const openGallery = () => {
    setEditing(null)
    setMode("gallery")
  }
  const backToGallery = () => {
    setEditing(null)
    setMode("gallery")
  }
  const closeToDetail = () => {
    setEditing(null)
    setMode("detail")
  }
  const pickTemplate = (tpl: AutomationTemplate | null) => {
    const seed = tpl
      ? templateToDraft(tpl, {
          name: t(tpl.titleKey),
          agentType: "claude_code",
          folderId: folders[0]?.id ?? null,
        })
      : null
    setEditing({ kind: "create", seed })
    setMode("editor")
  }
  const startEdit = (a: Automation) => {
    setEditing({ kind: "edit", automation: a })
    setMode("editor")
  }
  const selectAutomation = (a: Automation) => {
    setSelectedId(a.id)
    setEditing(null)
    setMode("detail")
  }

  // Shared mutation runner for the per-row quick actions (run now / toggle /
  // delete) hoisted out of the detail pane so the list's ⋯ menu can drive them.
  const runAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn()
        await refetch()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
    [refetch]
  )

  const handleSubmit = async (draft: AutomationDraft) => {
    const saved =
      editing?.kind === "edit"
        ? await automationUpdate(editing.automation.id, draft)
        : await automationCreate(draft)
    await refetch()
    setSelectedId(saved.id)
    closeToDetail()
  }

  const editorPane =
    editing != null ? (
      <ScrollArea className="h-full">
        {/* PANEL_PAD everywhere inside a panel — the pane used to jump from
            p-4 to p-6 at the sm breakpoint while the panel's own margins
            didn't, which read as inconsistent gutters. */}
        <div className="mx-auto w-full max-w-2xl p-4">
          <AutomationEditor
            // Key by edit target so switching to a different automation (e.g.
            // ⋯ → Edit on another row while the editor is open) remounts with
            // fresh state instead of showing the previous target's fields.
            key={
              editing.kind === "edit"
                ? `edit-${editing.automation.id}`
                : "create"
            }
            automation={
              editing.kind === "edit" ? editing.automation : editing.seed
            }
            onSubmit={handleSubmit}
            onCancel={closeToDetail}
            onBackToTemplates={
              editing.kind === "create" ? backToGallery : undefined
            }
          />
        </div>
      </ScrollArea>
    ) : null

  const picker = (onboarding: boolean) => (
    <ScrollArea className="h-full">
      {/* Onboarding is the whole page, so the gallery is centered in the shell
          both ways. Vertical centering rides on `my-auto` inside a
          `min-h-full` column rather than `justify-center`: when the gallery is
          taller than the viewport the free space goes negative, auto margins
          collapse to 0, and it scrolls from the top instead of having its head
          clipped out of reach. */}
      <div className="flex min-h-full flex-col">
        <div
          className={cn(
            "mx-auto flex w-full max-w-4xl flex-col gap-6 p-4",
            onboarding && "my-auto"
          )}
        >
          {onboarding ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Zap className="size-6" aria-hidden="true" />
              </span>
              <h2 className="text-base font-semibold">{t("onboardTitle")}</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                {t("onboardHint")}
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("startFromTemplate")}
              </h2>
              <Button size="sm" variant="ghost" onClick={closeToDetail}>
                {t("cancel")}
              </Button>
            </div>
          )}
          <TemplateGallery onPick={pickTemplate} />
        </div>
      </div>
    </ScrollArea>
  )

  return (
    // No background of its own: the route overlay already paints
    // `bg-background ws-transparent-bg` (workspace/layout.tsx), so an opaque
    // layer here would hide the workspace background image behind the page.
    <div className="flex h-full min-h-0 flex-col">
      {hasAutomations ? (
        <>
          <PageToolbar
            folderOptions={folderOptions}
            folderFilter={activeFolderFilter}
            onFolderFilter={setFolderFilter}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            showNew={mode === "detail"}
            onNew={openGallery}
          />
          {/* 1rem of clearance on all four sides of the shell: left/right/bottom
              from px-4 pb-4, top from pt-2 plus the toolbar's own pb-2. */}
          <div className="min-h-0 flex-1 px-4 pb-4 pt-2">
            <div className={SHELL_CLASS}>
              <ResizablePanelGroup
                direction="horizontal"
                className="min-h-0 flex-1"
              >
                <ResizablePanel
                  id="automations-list"
                  order={1}
                  defaultSize={32}
                  minSize={22}
                >
                  <div className={LIST_SURFACE_CLASS}>
                    <ScrollArea className="h-full">
                      {visibleAutomations.length === 0 ? (
                        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                          {t("noMatches")}
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-0.5 p-2">
                          {visibleAutomations.map((a) => (
                            <AutomationListItem
                              key={a.id}
                              automation={a}
                              now={now}
                              selected={
                                mode === "detail" && current?.id === a.id
                              }
                              onSelect={() => selectAutomation(a)}
                              onRunNow={() =>
                                runAction(() => automationRunNow(a.id))
                              }
                              onToggleEnabled={() =>
                                runAction(() =>
                                  automationSetEnabled(a.id, !a.enabled)
                                )
                              }
                              onEdit={() => startEdit(a)}
                              onDelete={() =>
                                runAction(() => automationDelete(a.id))
                              }
                            />
                          ))}
                        </ul>
                      )}
                    </ScrollArea>
                  </div>
                </ResizablePanel>
                {/* The handle's own 1px rule IS the column divider now, and
                    inside a single shell that's the honest reading of it: one
                    container split in two, not two boards with a line wedged
                    between them. Tone alone can't carry the split — in the
                    light theme `--muted` and `--card` are one step apart, which
                    measures ~2% on screen; the fixes for that (frosting or an
                    opaque fill) would block the workspace background image. */}
                <ResizableHandle />
                <ResizablePanel
                  id="automations-detail"
                  order={2}
                  defaultSize={68}
                >
                  <div className={DETAIL_SURFACE_CLASS}>
                    {mode === "editor" && editing ? (
                      editorPane
                    ) : mode === "gallery" ? (
                      picker(false)
                    ) : current ? (
                      <AutomationDetail
                        automation={current}
                        refetch={refetch}
                        onEdit={() => startEdit(current)}
                      />
                    ) : (
                      // Defensive only: `current` falls back to automations[0],
                      // which is always present inside this hasAutomations
                      // branch, so this arm is not reached in practice.
                      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
                        {t("selectHint")}
                      </div>
                    )}
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          </div>
        </>
      ) : (
        // Nothing to filter or list yet — the onboarding gallery carries its own
        // call to action, so no toolbar here. Same shell and the same 1rem of
        // clearance on all four sides as the populated state (p-4 alone, since
        // there is no toolbar padding to add to).
        <div className="min-h-0 flex-1 p-4">
          <div className={cn(SHELL_CLASS, DETAIL_SURFACE_CLASS)}>
            {/* SHELL_CLASS is a flex row (it splits into two columns when the
                list exists), so its lone child here must be told to fill it.
                Without `flex-1` the scroller shrink-wraps the gallery's
                intrinsic width, pinning the whole empty state to the left edge
                with a dead gutter on the right — and `mx-auto` inside it has no
                free space left to center in. */}
            <div className="min-w-0 flex-1">
              {mode === "editor" && editing ? editorPane : picker(true)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** ONE shell around both columns — a single rounded border for the whole
 *  content area. Two separately-bordered panels put their facing edges a gutter
 *  apart, which reads as a divider line down the middle even though nothing
 *  draws one. `overflow-hidden` is what makes the rounded corners actually clip
 *  the columns and their scrolling content. */
const SHELL_CLASS =
  "flex h-full overflow-hidden rounded-2xl border border-border ws-chrome-border"

/** Inside the shell the list sits on muted and the detail on card — a quiet
 *  tonal step that backs up the divider rather than replacing it. Both are
 *  translucent so a workspace background image still reads through the shell. */
const LIST_SURFACE_CLASS = "h-full bg-muted/50"
const DETAIL_SURFACE_CLASS = "h-full bg-card/50"

/** Filter-pill trigger, shared verbatim with the Tasks board toolbar
 *  (tasks-page.tsx) so both workbench routes' controls read as one family:
 *  borderless muted pill, `ws-msg-chip` keeping it legible over a workspace
 *  background image (inert without one). */
const FILTER_PILL_CLASS =
  "h-8 w-auto min-w-0 gap-1.5 rounded-full border-transparent bg-muted/70 px-3 text-[0.8125rem] font-medium shadow-none ws-msg-chip hover:bg-muted"

/**
 * The page toolbar: filter pills left, the New primary right — the title itself
 * lives in the chrome strip above (AutomationsPageTitle), so this is a single
 * borderless row rather than the two stacked bordered bars it replaces. Metrics
 * mirror the Tasks board toolbar.
 */
function PageToolbar({
  folderOptions,
  folderFilter,
  onFolderFilter,
  statusFilter,
  onStatusFilter,
  showNew,
  onNew,
}: {
  folderOptions: readonly FolderSelectOption[]
  folderFilter: number | "all"
  onFolderFilter: (v: number | "all") => void
  statusFilter: "all" | "enabled" | "disabled"
  onStatusFilter: (v: "all" | "enabled" | "disabled") => void
  showNew: boolean
  onNew: () => void
}) {
  const t = useTranslations("Automations")
  return (
    // pt-4 / px-4, not py-2: everything else on this page clears its neighbour
    // by 1rem (the shell's four sides), so an 8px gap above the pills was the
    // one odd measure — the row sat tight under the title bar while its left
    // edge and the shell below it were both a full 1rem away. pb-2 stays,
    // because the shell adds its own pt-2 underneath for the same 1rem.
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2 pt-4">
      {/* Always rendered (like the Tasks board's folder pill) — a filter that
          comes and goes with the data is more disorienting than one that is
          briefly redundant. Searchable, and every row shows `alias [ name ]`
          over the folder's path (the shared picker), so an aliased folder is
          still identifiable — and findable by its real name. */}
      <FolderSelect
        folders={folderOptions}
        value={folderFilter === "all" ? null : folderFilter}
        onChange={onFolderFilter}
        allLabel={t("allFolders")}
        onSelectAll={() => onFolderFilter("all")}
      />

      <Select
        value={statusFilter}
        onValueChange={(v) =>
          onStatusFilter(v as "all" | "enabled" | "disabled")
        }
      >
        {/* Both pills lead with an icon: "All" alone doesn't say WHICH axis it
            filters, and a lone icon on the folder pill would read as odd. */}
        <SelectTrigger size="sm" className={FILTER_PILL_CLASS}>
          <ListFilter
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("filterAll")}</SelectItem>
          <SelectItem value="enabled">{t("enabled")}</SelectItem>
          <SelectItem value="disabled">{t("statusDisabled")}</SelectItem>
        </SelectContent>
      </Select>

      <div className="flex-1" />

      {/* Detail mode only: the gallery IS the new-automation flow, and the
          editor has its own cancel / back-to-templates exits — offering "New"
          there would silently discard a draft. Right-aligned, so its absence
          never shifts the filters. */}
      {showNew ? (
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1 rounded-full px-3.5 text-[0.8125rem]"
          onClick={onNew}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t("new")}
        </Button>
      ) : null}
    </div>
  )
}

// A single status dot riding the agent icon, mirroring the sidebar conversation
// row. It blends two facts: a disabled automation reads muted regardless of
// history; an enabled one is colored by its last run (emerald when it has never
// run yet, i.e. "ready").
const RUN_STATUS_DOT: Record<string, string> = {
  running: "bg-amber-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/50",
  skipped: "bg-muted-foreground/50",
}

// Run-history timeline node tint per status — colors the node ring and the
// trigger icon inside it; falls back to a neutral border for unknown states.
const RUN_NODE_RING: Record<string, string> = {
  running: "border-amber-500/50 text-amber-600 dark:text-amber-400",
  succeeded: "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
  failed: "border-destructive/50 text-destructive",
  cancelled: "border-border text-muted-foreground",
  skipped: "border-border text-muted-foreground",
}

function AutomationDot({
  enabled,
  status,
}: {
  enabled: boolean
  status: string | null
}) {
  const color = !enabled
    ? "bg-muted-foreground/40"
    : status
      ? (RUN_STATUS_DOT[status] ?? "bg-emerald-500")
      : "bg-emerald-500"
  return (
    <span
      className={cn(
        "block size-1.5 rounded-full ring-2 ring-background",
        color
      )}
      aria-hidden="true"
    />
  )
}

function AutomationListItem({
  automation,
  now,
  selected,
  onSelect,
  onRunNow,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  automation: Automation
  now: number
  selected: boolean
  onSelect: () => void
  onRunNow: () => void
  onToggleEnabled: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useTranslations("Automations")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const isSchedule = automation.trigger_kind === "schedule" && !!automation.cron
  const isRunning = automation.last_run_status === "running"
  const showNextIn =
    isSchedule && automation.enabled && !!automation.next_run_at
  const timeLabel = showNextIn
    ? t("nextIn", { rel: formatRelativeFuture(automation.next_run_at, now) })
    : automation.last_run_at
      ? formatRelative(automation.last_run_at, now)
      : null

  // The row's quick actions, authored once so the ⋯ dropdown and the right-click
  // context menu render exactly the same set (the user asked for parity).
  const actions: Array<{
    key: string
    icon: React.ReactNode
    label: string
    onSelect: () => void
    variant?: "destructive"
    separatorBefore?: boolean
  }> = [
    {
      key: "run",
      icon: <Play className="size-3.5" aria-hidden="true" />,
      label: t("runNow"),
      onSelect: onRunNow,
    },
    {
      key: "toggle",
      icon: automation.enabled ? (
        <PowerOff className="size-3.5" aria-hidden="true" />
      ) : (
        <Power className="size-3.5" aria-hidden="true" />
      ),
      label: automation.enabled ? t("disable") : t("enable"),
      onSelect: onToggleEnabled,
    },
    {
      key: "edit",
      icon: <Pencil className="size-3.5" aria-hidden="true" />,
      label: t("edit"),
      onSelect: onEdit,
    },
    {
      key: "delete",
      icon: <Trash2 className="size-3.5" aria-hidden="true" />,
      label: t("delete"),
      // Let the menu close (and restore focus) before the dialog mounts —
      // opening synchronously races focus restoration and self-dismisses.
      onSelect: () => setTimeout(() => setConfirmOpen(true), 0),
      variant: "destructive",
      separatorBefore: true,
    },
  ]

  // Render the shared actions into either menu's item/separator components.
  const renderActions = (
    Item: React.ElementType,
    Separator: React.ElementType
  ) =>
    actions.map((a) => (
      <Fragment key={a.key}>
        {a.separatorBefore ? <Separator /> : null}
        <Item variant={a.variant} onSelect={a.onSelect}>
          {a.icon}
          {a.label}
        </Item>
      </Fragment>
    ))

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              // The border is always in the box (transparent when unselected)
              // so selecting a row never shifts its height by 2px.
              "group flex h-8 w-full items-center rounded-full border pr-1 transition-colors",
              // Selection can't lean on fill alone: in the light theme
              // `--accent` and `--muted` are the SAME token value
              // (oklch(0.97)), so `bg-accent` on the muted list panel is a
              // ~0.02 lightness difference — invisible. The outline carries the
              // signal instead (boosted by ws-chrome-border over a background
              // image), and ws-msg-chip keeps the fill translucent there so the
              // row doesn't punch an opaque hole in the picture. Unselected
              // rows stay off the chip so their layered hover:bg-* keeps
              // working — the chip's unlayered background would swallow it.
              selected
                ? "border-border ws-chrome-border bg-accent ws-msg-chip"
                : "border-transparent hover:bg-accent/60"
            )}
          >
            <button
              type="button"
              onClick={onSelect}
              className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-full pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <span className="relative flex size-5 shrink-0 items-center justify-center">
                <AgentIcon
                  agentType={automation.agent_type}
                  className="size-4"
                />
                <span className="absolute -right-0.5 -bottom-0.5">
                  <AutomationDot
                    enabled={automation.enabled}
                    status={automation.last_run_status}
                  />
                </span>
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  automation.enabled
                    ? "font-medium"
                    : "font-normal text-muted-foreground"
                )}
              >
                {automation.name}
              </span>
            </button>

            <div className="flex shrink-0 items-center gap-0.5 pl-1">
              {/* Time yields to the ⋯ affordance on hover, keyboard focus, or
                  while the menu is open — mirroring the conversation row. */}
              <span
                className={cn(
                  "flex items-center group-hover:hidden group-focus-within:hidden",
                  menuOpen && "hidden"
                )}
              >
                {isRunning ? (
                  <Loader2
                    className="size-3.5 animate-spin text-amber-600 dark:text-amber-400"
                    aria-hidden="true"
                  />
                ) : timeLabel ? (
                  <span
                    className={cn(
                      "shrink-0 tabular-nums text-[0.71875rem]",
                      selected
                        ? "font-medium text-muted-foreground"
                        : "text-muted-foreground/70"
                    )}
                  >
                    {timeLabel}
                  </span>
                ) : null}
              </span>

              <DropdownMenu onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  {/* Hidden when idle (the time sits in its place); reveals on
                      hover, on keyboard focus entering the row, and while open.
                      justify-end flushes the glyph to the time's right edge;
                      no hover/open fill — only the icon color shifts. */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="hidden justify-end text-muted-foreground/80 hover:bg-transparent hover:text-foreground group-hover:flex group-focus-within:flex aria-expanded:bg-transparent data-[state=open]:flex dark:hover:bg-transparent"
                    aria-label={t("moreActions")}
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {renderActions(DropdownMenuItem, DropdownMenuSeparator)}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        {/* Right-click anywhere on the row opens the same actions as ⋯. */}
        <ContextMenuContent className="w-40">
          {renderActions(ContextMenuItem, ContextMenuSeparator)}
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

// One fact — icon + uppercase label on top, value below. Deliberately NOT a
// card: these live inside the overview Section, and boxing each of six
// facts inside an already-boxed section read as card-in-card confetti. Grid
// spacing alone separates them.
function StatItem({
  icon,
  label,
  children,
  className,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-center gap-1.5 text-muted-foreground [&>svg]:size-3.5">
        {icon}
        <span className="text-[0.6875rem] font-medium uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  )
}

/**
 * A titled block inside the detail panel. Deliberately NOT a card: the panel
 * already draws the outer boundary, so boxing each block again would stack
 * three borders (panel → card → stat). A rule above the title carries the
 * separation instead; the top rule doubles as the divider from the block above.
 */
function Section({
  title,
  action,
  children,
}: {
  title: string
  /** Optional trailing control on the title row (e.g. run history's refresh). */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border ws-chrome-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function AutomationDetail({
  automation,
  refetch,
  onEdit,
}: {
  automation: Automation
  refetch: () => Promise<void>
  onEdit: () => void
}) {
  const t = useTranslations("Automations")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const folderName =
    folders.find((f) => f.id === automation.root_folder_id)?.name ?? "—"
  // `config` is serialized from an opaque JSON column and falls back to `null`
  // on the backend if the stored blob fails to parse — guard every read so a
  // malformed automation degrades gracefully instead of throwing during render
  // (which, with no error boundary on this route, white-screens the whole app).
  const config = automation.config ?? null
  const labels = config?.label_snapshot
  const configEntries = Object.entries(config?.config_values ?? {})
  // `label_snapshot` freezes whatever the agent CALLED these when the
  // automation was saved — deliberately, so the badges survive the agent being
  // uninstalled. For an agent that hardcodes one language that also freezes the
  // language, and for every automation saved before this existed. Resolve from
  // the stable ids first, fall back to the frozen label, then to the raw id.
  const vocabulary = useAgentVocabulary(automation.agent_type)
  const isSchedule = automation.trigger_kind === "schedule" && !!automation.cron

  return (
    <ScrollArea className="h-full">
      <div className="@container flex w-full flex-col gap-4 p-4">
        {/* Title block: name + last-run status on the left, the enable toggle
            on the right, then the primary actions on their own row. The actions
            used to sit between the prompt and the run-history cards, where they
            read as belonging to neither. */}
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-lg font-semibold">
                {automation.name}
              </h2>
              <StatusChip status={automation.last_run_status} />
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              {automation.enabled ? t("enabled") : t("statusDisabled")}
              <Switch
                checked={automation.enabled}
                disabled={busy}
                onCheckedChange={(v) =>
                  run(() => automationSetEnabled(automation.id, v))
                }
                aria-label={t("enabled")}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-full px-3.5 text-[0.8125rem]"
              onClick={() => run(() => automationRunNow(automation.id))}
              disabled={busy}
            >
              <Play className="size-3.5" aria-hidden="true" />
              {t("runNow")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 rounded-full px-3.5 text-[0.8125rem]"
              onClick={onEdit}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              {t("edit")}
            </Button>
          </div>
        </div>

        <Section title={t("sectionSchedule")}>
          <div className="grid grid-cols-1 gap-x-4 gap-y-4 @sm:grid-cols-2 @xl:grid-cols-3">
            <StatItem
              icon={isSchedule ? <CalendarClock /> : <MousePointerClick />}
              label={t("trigger")}
            >
              {isSchedule && automation.cron ? (
                <span className="flex flex-col gap-0.5">
                  <ScheduleLabel cron={automation.cron} />
                  <span className="font-mono text-xs text-muted-foreground">
                    {automation.cron}
                  </span>
                </span>
              ) : (
                t("manual")
              )}
            </StatItem>
            <StatItem
              icon={
                <AgentIcon
                  agentType={automation.agent_type}
                  className="size-3.5"
                />
              }
              label={t("agent")}
            >
              <span className="block truncate">
                {labels?.agent_label ?? automation.agent_type}
              </span>
            </StatItem>
            <StatItem icon={<Folder />} label={t("folder")}>
              <span className="block truncate">
                {labels?.folder_label ?? folderName}
              </span>
            </StatItem>
            {config?.action === "enqueue_task" ? (
              // Isolation/branch never apply to enqueued tasks (the work-task
              // engine mints the worktree); show what firing does instead.
              <StatItem icon={<SquareKanban />} label={t("sectionAction")}>
                {t("actionEnqueueTask")}
              </StatItem>
            ) : (
              <StatItem icon={<GitBranch />} label={t("isolation")}>
                <span className="block">
                  {automation.isolation === "worktree_per_run"
                    ? t("isolationWorktree")
                    : t("isolationShared")}
                  {automation.isolation === "shared_in_root" &&
                  automation.branch ? (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">
                      {automation.branch}
                    </span>
                  ) : null}
                </span>
              </StatItem>
            )}
            {isSchedule ? (
              <StatItem icon={<Clock />} label={t("nextRun")}>
                {automation.next_run_at
                  ? new Date(automation.next_run_at).toLocaleString()
                  : "—"}
              </StatItem>
            ) : null}
            {config?.mode_id || configEntries.length > 0 ? (
              <StatItem icon={<SlidersHorizontal />} label={t("config")}>
                <div className="flex flex-wrap gap-1">
                  {config?.mode_id ? (
                    <Badge variant="outline" className="text-[0.625rem]">
                      {vocabulary.modeLabel(
                        config.mode_id,
                        labels?.mode_label ?? config.mode_id
                      )}
                    </Badge>
                  ) : null}
                  {configEntries.map(([k, v]) => (
                    <Badge
                      key={k}
                      variant="outline"
                      className="text-[0.625rem]"
                    >
                      {vocabulary.configValueLabel(
                        k,
                        v,
                        labels?.config_labels?.[k] ?? v
                      )}
                    </Badge>
                  ))}
                </div>
              </StatItem>
            ) : null}
          </div>
        </Section>

        <Section title={t("sectionPrompt")}>
          <p className="whitespace-pre-wrap text-sm text-foreground/90">
            {config?.display_text || "—"}
          </p>
        </Section>

        <RunHistory
          key={automation.id}
          automation={automation}
          onChanged={refetch}
        />
      </div>
    </ScrollArea>
  )
}

function RunHistory({
  automation,
  onChanged,
}: {
  automation: Automation
  onChanged: () => Promise<void>
}) {
  const t = useTranslations("Automations")
  const { openTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [loading, setLoading] = useState(true)
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const id = ++reqRef.current
    try {
      const list = await automationRuns(automation.id)
      if (id === reqRef.current) {
        setRuns(list)
      }
    } catch {
      // keep the previous list on transient error
    } finally {
      if (id === reqRef.current) setLoading(false)
    }
  }, [automation.id])

  useEffect(() => {
    setLoading(true)
    void load()
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe(AUTOMATION_CHANGED_EVENT, () => {
      void load()
    }).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    // A run that settled while the WS was disconnected drops its event (the
    // broadcaster skips when receiver_count == 0), so re-load on reconnect to
    // clear a stale "running" row. No-op on desktop IPC.
    const offReconnect = onTransportReconnect(() => {
      void load()
    })
    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
    }
  }, [load])

  const viewConversation = (r: AutomationRun) => {
    // Worktree runs live in their own folder; shared runs in the automation's
    // root. Bail rather than open folderId 0 (a structurally broken tab) if
    // neither resolves. openConversations() also covers re-selecting the
    // already-active tab, which wouldn't change activeTabId.
    const folderId = r.worktree_folder_id ?? automation.root_folder_id
    if (r.conversation_id == null || folderId == null) return
    openConversations()
    openTab(folderId, r.conversation_id, automation.agent_type)
  }

  const cancel = async (r: AutomationRun) => {
    try {
      await automationCancelRun(r.id)
      await load()
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    // A titled Section like the others: it used to be the one block on the page
    // with no boundary at all, which over a background image read as loose text
    // floating on the photo.
    <Section
      title={t("runHistory")}
      action={
        <Button
          size="icon"
          variant="ghost"
          className="-my-1 h-6 w-6 text-muted-foreground"
          onClick={() => void load()}
          title={t("refresh")}
          aria-label={t("refresh")}
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      }
    >
      {loading && runs.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        </div>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noRuns")}</p>
      ) : (
        <ol className="flex flex-col">
          {runs.map((r, i) => (
            <li key={r.id} className="flex gap-3">
              {/* Rail: a status-tinted node + a connector line down to the next
                  run. The connector is omitted on the last item so the line
                  terminates at the final node. */}
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "z-10 flex size-7 shrink-0 items-center justify-center rounded-full border-2 bg-background",
                    RUN_NODE_RING[r.status ?? ""] ??
                      "border-border text-muted-foreground"
                  )}
                >
                  {r.trigger === "manual" ? (
                    <CirclePlay className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Clock className="size-3.5" aria-hidden="true" />
                  )}
                </span>
                {i < runs.length - 1 ? (
                  <span className="w-px flex-1 bg-border" aria-hidden="true" />
                ) : null}
              </div>

              <div
                className={cn(
                  "flex min-w-0 flex-1 flex-col gap-0.5",
                  i < runs.length - 1 && "pb-5"
                )}
              >
                <div className="flex items-center gap-2">
                  <StatusChip status={r.status} />
                  {r.conversation_id != null ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6 shrink-0 text-muted-foreground"
                      onClick={() => viewConversation(r)}
                      title={t("viewConversation")}
                      aria-label={t("viewConversation")}
                    >
                      <SquareArrowOutUpRight
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    </Button>
                  ) : null}
                  {r.status === "running" ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => void cancel(r)}
                      title={t("cancelRun")}
                      aria-label={t("cancelRun")}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  ) : null}
                  <span
                    className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground"
                    title={
                      r.started_at
                        ? new Date(r.started_at).toLocaleString()
                        : undefined
                    }
                  >
                    {formatDateTime(r.started_at)}
                    {r.ended_at ? (
                      <>
                        {" · "}
                        {formatDuration(r.started_at, r.ended_at)}
                      </>
                    ) : null}
                  </span>
                </div>
                {r.error ? (
                  <span className="truncate text-[0.6875rem] text-destructive">
                    {r.error}
                  </span>
                ) : r.summary ? (
                  <span className="truncate text-[0.6875rem] text-muted-foreground">
                    {r.summary}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}
