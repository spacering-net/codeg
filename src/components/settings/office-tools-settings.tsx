"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  BarChart3,
  Box,
  Clapperboard,
  ClipboardList,
  Download,
  FileSpreadsheet,
  FileText,
  GraduationCap,
  Loader2,
  Presentation,
  RefreshCw,
  Rocket,
  Trash2,
  TrendingUp,
  type LucideIcon,
  FileStack,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  SkillAgentMatrix,
  type MatrixSkill,
} from "@/components/settings/skill-agent-matrix"
import { Switch } from "@/components/ui/switch"
import { cn, randomUUID } from "@/lib/utils"
import {
  loadOfficeAutoPreview,
  saveOfficeAutoPreview,
} from "@/lib/office-preview-prefs"
import {
  acpListAgents,
  officecliDetect,
  officecliInstall,
  officecliListSkills,
  officecliSkillApplyLinks,
  officecliSkillListAllInstallStatuses,
  officecliSkillReadContent,
  officecliSyncSkills,
  officecliUninstall,
} from "@/lib/api"
import { invalidateAgentSkillsCache } from "@/hooks/use-agent-skills"
import { useLatestCall } from "@/hooks/use-latest-call"
import { useOfficecliInstallStream } from "@/hooks/use-officecli-install-stream"
import { pickLocalized } from "@/lib/expert-presentation"
import type {
  AcpAgentInfo,
  ExpertLinkState,
  OfficecliInfo,
  OfficecliSkill,
} from "@/lib/types"
import { piUsesCustomAgentDir } from "@/lib/pi-config"
import { toErrorMessage } from "@/lib/app-error"

const ICON_MAP: Record<string, LucideIcon> = {
  FileStack,
  Presentation,
  Rocket,
  Clapperboard,
  Box,
  FileText,
  GraduationCap,
  ClipboardList,
  FileSpreadsheet,
  TrendingUp,
  BarChart3,
}

const CATEGORY_SORT: Record<string, number> = {
  general: 0,
  presentations: 1,
  documents: 2,
  spreadsheets: 3,
}

function getIcon(name: string | null | undefined): LucideIcon {
  if (name && ICON_MAP[name]) return ICON_MAP[name]
  return FileStack
}

// ─── Detection card ───────────────────────────────────────────────────

function DetectionCard({
  info,
  detecting,
  installing,
  onInstall,
  onUninstall,
  onSync,
  syncing,
}: {
  info: OfficecliInfo | null
  detecting: boolean
  installing: boolean
  onInstall: () => void
  onUninstall: () => void
  onSync: () => void
  syncing: boolean
}) {
  const t = useTranslations("OfficeToolsSettings")
  const installed = info?.installed === true
  const runtimeError = info?.runtimeError ?? null
  // "Installed" means the binary file exists; "healthy" additionally means it
  // actually runs. On a slim Linux server it can be present yet unrunnable
  // (missing libicu), which must NOT read as a green, working install.
  const healthy = installed && !runtimeError

  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        healthy
          ? "border-green-500/30 bg-green-500/5"
          : installed
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-muted bg-muted/5"
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">OfficeCLI</h3>
            {detecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : healthy ? (
              <Badge
                variant="outline"
                className="h-5 px-1.5 text-3xs border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400"
              >
                {t("detection.installed")}
              </Badge>
            ) : installed ? (
              <Badge
                variant="outline"
                className="h-5 px-1.5 text-3xs border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              >
                {t("detection.notRunnable")}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="h-5 px-1.5 text-3xs text-muted-foreground"
              >
                {t("detection.notInstalled")}
              </Badge>
            )}
          </div>
          {installed && info && (
            <div className="text-2xs text-muted-foreground mt-1 space-x-3">
              {info.version && <span>{info.version}</span>}
              {info.path && (
                <code className="font-mono text-3xs">{info.path}</code>
              )}
            </div>
          )}
          {installed && runtimeError && (
            <p className="text-2xs text-amber-600 dark:text-amber-400 mt-1.5 whitespace-pre-wrap break-words">
              {runtimeError}
            </p>
          )}
          {!installed && !detecting && (
            <p className="text-xs text-muted-foreground mt-1">
              {t("detection.installHint")}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {installed ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={syncing}
                onClick={onSync}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {t("detection.syncSkills")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={onUninstall}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("detection.uninstall")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={installing || detecting}
              onClick={onInstall}
            >
              {installing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {t("detection.install")}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────

export function OfficeToolsBody({
  onRegisterRefresh,
}: {
  onRegisterRefresh?: (refresh: () => void) => void
}) {
  const t = useTranslations("OfficeToolsSettings")
  const locale = useLocale()
  const [autoPreview, setAutoPreview] = useState(() => loadOfficeAutoPreview())

  const [info, setInfo] = useState<OfficecliInfo | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const installStream = useOfficecliInstallStream()
  const installLogEndRef = useRef<HTMLDivElement | null>(null)

  const [skills, setSkills] = useState<OfficecliSkill[]>([])
  const [agents, setAgents] = useState<AcpAgentInfo[]>([])
  const [reloadKey, setReloadKey] = useState(0)

  const translatedState = useCallback(
    (state: ExpertLinkState): string => {
      switch (state) {
        case "not_linked":
          return t("states.not_linked")
        case "linked_to_codeg":
          return t("states.linked_to_codeg")
        case "linked_elsewhere":
          return t("states.linked_elsewhere")
        case "blocked_by_real_directory":
          return t("states.blocked_by_real_directory")
        case "broken":
          return t("states.broken")
        default:
          return state
      }
    },
    [t]
  )

  const translatedCategory = useCallback(
    (category: string): string => {
      switch (category) {
        case "general":
          return t("categories.general")
        case "presentations":
          return t("categories.presentations")
        case "documents":
          return t("categories.documents")
        case "spreadsheets":
          return t("categories.spreadsheets")
        default:
          return category
      }
    },
    [t]
  )

  // A late answer from an earlier Refresh must not overwrite a newer one.
  const beginDetect = useLatestCall()
  const beginSkillsLoad = useLatestCall()

  const detect = useCallback(async () => {
    const current = beginDetect()
    setDetecting(true)
    try {
      const result = await officecliDetect()
      if (current()) setInfo(result)
    } catch {
      if (current()) setInfo(null)
    } finally {
      if (current()) setDetecting(false)
    }
  }, [beginDetect])

  const refreshSkills = useCallback(async () => {
    const current = beginSkillsLoad()
    try {
      const [skillList, agentList] = await Promise.all([
        officecliListSkills(),
        acpListAgents(),
      ])
      if (!current()) return
      setSkills(skillList)
      // A pi pointed at a custom PI_CODING_AGENT_DIR isn't managed by the
      // default-dir skill store, so it doesn't get a column here.
      setAgents(
        agentList.filter(
          (agent) => agent.skills_capable && !piUsesCustomAgentDir(agent)
        )
      )
      // Remount the matrix so it re-fetches the authoritative status snapshot
      // (newly synced skills become enableable).
      setReloadKey((k) => k + 1)
    } catch (err) {
      if (!current()) return
      toast.error(t("toasts.loadFailed"), { description: toErrorMessage(err) })
    }
  }, [beginSkillsLoad, t])

  useEffect(() => {
    Promise.all([detect(), refreshSkills()]).catch((err) => {
      console.error("[OfficeToolsSettings] initial load failed:", err)
    })
  }, [detect, refreshSkills])

  // Publish the reload handler so the hub's fixed "Refresh" button can drive
  // this pack while it is the active tab (without remounting — which would
  // tear down an in-flight install stream).
  useEffect(() => {
    onRegisterRefresh?.(() => {
      Promise.all([detect(), refreshSkills()]).catch((err) => {
        console.error("[OfficeToolsSettings] refresh failed:", err)
      })
    })
  }, [onRegisterRefresh, detect, refreshSkills])

  // Tear down the install log subscription when the panel unmounts.
  useEffect(() => {
    return () => installStream.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the install log scrolled to the latest line.
  useEffect(() => {
    const container = installLogEndRef.current?.parentElement
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [installStream.logs])

  const matrixSkills = useMemo<MatrixSkill[]>(
    () =>
      skills.map((s) => ({
        id: s.id,
        category: s.category,
        displayName: pickLocalized(s.displayName, locale) || s.id,
        description: pickLocalized(s.description, locale),
        icon: getIcon(s.icon),
        ready: s.installedCentrally,
        badge: s.installedCentrally
          ? undefined
          : { label: t("badges.notSynced"), tone: "muted" },
      })),
    [skills, locale, t]
  )

  // Un-synced skills have no SKILL.md on disk; return empty rather than letting
  // the matrix's detail drawer surface a load error.
  const loadContent = useCallback(
    (skillId: string) => {
      const skill = skills.find((s) => s.id === skillId)
      return skill?.installedCentrally
        ? officecliSkillReadContent(skillId)
        : Promise.resolve("")
    },
    [skills]
  )

  const handleInstall = useCallback(async () => {
    setInstalling(true)
    // Subscribe to the install log stream before kicking off the backend so no
    // early lines are missed; `taskId` correlates the stream to this install.
    const taskId = randomUUID()
    await installStream.start(taskId)
    try {
      const result = await officecliInstall(taskId)
      setInfo(result)
      toast.success(t("toasts.installSuccess"))
      // Auto-sync the newly available skills, surfacing failures like handleSync
      // so a partial/failed sync isn't silently swallowed behind the success toast.
      const report = await officecliSyncSkills()
      if (report.errors.length > 0) {
        toast.warning(
          t("toasts.syncPartial", {
            synced: report.synced,
            errors: report.errors.length,
          }),
          { description: report.errors.slice(0, 2).join("\n") }
        )
      }
      await refreshSkills()
    } catch (err) {
      toast.error(t("toasts.installFailed"), {
        description: toErrorMessage(err),
      })
      // The installer may have placed a present-but-unrunnable binary (e.g.
      // missing libicu on a Linux server); re-detect so the card shows the real
      // "installed but not runnable" state instead of staying stale.
      await detect()
    } finally {
      setInstalling(false)
    }
    // `installStream` is a fresh object each render, but its state lives in this
    // component so a streamed line already re-renders us; handleInstall identity
    // is immaterial (its only consumer isn't memoized).
  }, [t, detect, refreshSkills, installStream])

  const handleUninstall = useCallback(async () => {
    try {
      const result = await officecliUninstall()
      setInfo(result)
      await refreshSkills()
      toast.success(t("toasts.uninstallSuccess"))
    } catch (err) {
      toast.error(t("toasts.uninstallFailed"), {
        description: toErrorMessage(err),
      })
    }
  }, [t, refreshSkills])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      const report = await officecliSyncSkills()
      await refreshSkills()
      if (report.errors.length > 0) {
        toast.warning(
          t("toasts.syncPartial", {
            synced: report.synced,
            errors: report.errors.length,
          }),
          // Surface the actual reason(s) — not just a count — so a server-side
          // failure (e.g. missing libicu in Docker) is diagnosable from the UI.
          { description: report.errors.slice(0, 2).join("\n") }
        )
      } else {
        toast.success(t("toasts.syncSuccess", { synced: report.synced }))
      }
    } catch (err) {
      toast.error(t("toasts.syncFailed"), { description: toErrorMessage(err) })
    } finally {
      setSyncing(false)
    }
  }, [t, refreshSkills])

  const installed = info?.installed === true

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0">
        <DetectionCard
          info={info}
          detecting={detecting}
          installing={installing}
          onInstall={handleInstall}
          onUninstall={handleUninstall}
          onSync={handleSync}
          syncing={syncing}
        />
      </div>

      {installStream.status !== "idle" && (
        <div className="mt-3 shrink-0 rounded-md border bg-muted/50 text-muted-foreground p-3 max-h-[12.5rem] overflow-y-auto font-mono text-2xs leading-relaxed">
          {installStream.logs.map((line, i) => (
            <div
              key={i}
              className={line.startsWith("ERROR:") ? "text-destructive" : ""}
            >
              {line}
            </div>
          ))}
          <div ref={installLogEndRef} />
        </div>
      )}

      <div className="mt-4 shrink-0 flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="min-w-0 space-y-1">
          <label htmlFor="office-auto-preview" className="text-sm font-medium">
            {t("autoPreviewLabel")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("autoPreviewHint")}
          </p>
        </div>
        <Switch
          id="office-auto-preview"
          checked={autoPreview}
          onCheckedChange={(next) => {
            setAutoPreview(next)
            saveOfficeAutoPreview(next)
          }}
          className="shrink-0"
        />
      </div>

      <div className="flex-1 min-h-0 min-w-0 mt-4">
        {skills.length === 0 ? (
          <div className="h-full rounded-lg border bg-card flex items-center justify-center text-sm text-muted-foreground">
            {t("emptySkills")}
          </div>
        ) : (
          <SkillAgentMatrix
            key={reloadKey}
            skills={matrixSkills}
            agents={agents}
            categoryOrder={CATEGORY_SORT}
            translateCategory={translatedCategory}
            translateState={translatedState}
            loadAllStatuses={officecliSkillListAllInstallStatuses}
            applyLinks={officecliSkillApplyLinks}
            loadContent={loadContent}
            onApplied={(touched) =>
              touched.forEach((a) => invalidateAgentSkillsCache(a))
            }
            searchPlaceholder={t("searchPlaceholder")}
            notReadyHint={installed ? t("syncFirst") : t("installFirst")}
          />
        )}
      </div>
    </div>
  )
}
