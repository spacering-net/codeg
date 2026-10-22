"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ArrowLeft,
  Folder,
  Plus,
  SquareArrowOutUpRight,
  Zap,
} from "lucide-react"
import {
  AutomationDetail,
  AutomationListItem,
} from "@/components/automations/automations-page"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useAutomationsView } from "@/contexts/automations-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useActiveProjectFolderId } from "@/hooks/use-active-project-folder"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  automationDelete,
  automationRunNow,
  automationSetEnabled,
} from "@/lib/api"
import type { Automation, FolderDetail } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  requestAutomationsFocus,
  type AutomationsFocus,
} from "@/lib/workbench-focus"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { GIT_TOOLBAR_ICON_BUTTON_CLASS } from "./git-toolbar-controls"
import { AuxPanelNoFolderEmpty } from "./aux-panel-no-folder-empty"

/**
 * Whether an automation runs in `projectFolderId`'s project: in the project
 * root itself, or in one of its worktrees (an automation can be pointed at a
 * worktree folder, which belongs to the root it was created under).
 */
export function automationInProject(
  automation: Automation,
  projectFolderId: number,
  foldersById: ReadonlyMap<number, FolderDetail>
): boolean {
  const folderId = automation.root_folder_id
  if (folderId == null) return false
  if (folderId === projectFolderId) return true
  return foldersById.get(folderId)?.parent_id === projectFolderId
}

/**
 * The aux panel's automations tab: the active project's automations, with the
 * Automations page's own rows (run now, enable / disable, delete from the ⋯
 * menu) and its detail view a click deeper — schedule, prompt and run
 * history, whose runs open their conversations right here in the workspace.
 *
 * Creating and editing hand over to the full page, focused on this project
 * (and automation): the editor is a full form with its own composer, and the
 * page is where it has room.
 */
export function AutomationsAuxTab() {
  const t = useTranslations("Automations")
  const tAux = useTranslations("Folder.auxPanel")
  const { automations, refetch } = useAutomationsView()
  const projectFolderId = useActiveProjectFolderId()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const { setRoute } = useWorkbenchRoute()
  const { setOpen } = useAuxPanelContext()
  const isMobile = useIsMobile()

  const foldersById = useMemo(
    () => new Map(allFolders.map((f) => [f.id, f])),
    [allFolders]
  )
  const project =
    projectFolderId != null ? (foldersById.get(projectFolderId) ?? null) : null
  const projectAutomations = useMemo(
    () =>
      projectFolderId == null
        ? []
        : automations.filter((a) =>
            automationInProject(a, projectFolderId, foldersById)
          ),
    [automations, projectFolderId, foldersById]
  )

  // The automation drilled into. Dropped when the conversation moves to
  // another project, so coming back lands on the list rather than on a detail
  // view the user left two projects ago.
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selectedIn, setSelectedIn] = useState(projectFolderId)
  if (selectedIn !== projectFolderId) {
    setSelectedIn(projectFolderId)
    setSelectedId(null)
  }
  // Derived, so a deleted automation (here or anywhere else) falls back to the
  // list instead of leaving a detail view of nothing.
  const selected =
    selectedId == null
      ? null
      : (projectAutomations.find((a) => a.id === selectedId) ?? null)

  // Relative times ("next in 3h") against one shared clock, refreshed each
  // minute: the tab stays mounted for as long as the panel is open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

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

  // The full page, focused. On an automation, the page is filtered to THAT
  // automation's folder rather than the project's: it filters by exact folder,
  // and one pointed at a worktree would be missing from the root's list.
  const openPage = useCallback(
    (
      target: {
        automation?: Automation
        intent?: AutomationsFocus["intent"]
      } = {}
    ) => {
      const { automation, intent } = target
      requestAutomationsFocus({
        folderId: automation?.root_folder_id ?? projectFolderId,
        ...(automation != null ? { automationId: automation.id } : {}),
        ...(intent != null ? { intent } : {}),
      })
      setRoute("automations")
    },
    [projectFolderId, setRoute]
  )

  if (projectFolderId == null) return <AuxPanelNoFolderEmpty />

  if (selected != null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 pl-1.5 pr-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setSelectedId(null)}
          >
            <ArrowLeft className="size-3.5 rtl:rotate-180" aria-hidden />
            {tAux("back")}
          </Button>
          <div className="min-w-0 flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(GIT_TOOLBAR_ICON_BUTTON_CLASS, "-mr-1")}
            title={tAux("openFullPage")}
            aria-label={tAux("openFullPage")}
            onClick={() => openPage({ automation: selected })}
          >
            <SquareArrowOutUpRight className="size-3.5" aria-hidden />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <AutomationDetail
            automation={selected}
            refetch={refetch}
            onEdit={() => openPage({ automation: selected, intent: "edit" })}
            // On a phone the panel is a drawer over the conversation it just
            // opened — get it out of the way.
            onConversationOpened={isMobile ? () => setOpen(false) : undefined}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Which project the list is for — a worktree conversation shows its
          root's automations, so the name says whose they are. */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 pl-3 pr-2">
        <Folder
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={project?.path ?? undefined}
        >
          {project ? (project.alias ?? project.name) : null}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
          title={t("new")}
          aria-label={t("new")}
          onClick={() => openPage({ intent: "create" })}
        >
          <Plus className="size-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(GIT_TOOLBAR_ICON_BUTTON_CLASS, "-mr-1")}
          title={tAux("openFullPage")}
          aria-label={tAux("openFullPage")}
          onClick={() => openPage()}
        >
          <SquareArrowOutUpRight className="size-3.5" aria-hidden />
        </Button>
      </div>

      {projectAutomations.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Zap className="size-8 text-muted-foreground/40" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{tAux("noAutomations")}</p>
            <p className="text-xs text-muted-foreground">{t("onboardHint")}</p>
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={() => openPage({ intent: "create" })}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t("new")}
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-0.5 p-2">
            {projectAutomations.map((a) => (
              <AutomationListItem
                key={a.id}
                automation={a}
                now={now}
                // A drill-down list: the detail replaces it rather than
                // sitting beside it, so no row is ever the "selected" one.
                selected={false}
                onSelect={() => setSelectedId(a.id)}
                onRunNow={() => void runAction(() => automationRunNow(a.id))}
                onToggleEnabled={() =>
                  void runAction(() => automationSetEnabled(a.id, !a.enabled))
                }
                onEdit={() => openPage({ automation: a, intent: "edit" })}
                onDelete={() => void runAction(() => automationDelete(a.id))}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}
