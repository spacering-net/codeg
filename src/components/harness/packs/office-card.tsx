"use client"

import { useEffect, useRef, useState } from "react"
import {
  CircleCheck,
  Download,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

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
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  askUninstallOffice,
  cancelOfficeAction,
  dismissOfficeAction,
  dismissOfficeInstall,
  installOffice,
  OFFICE_ACTION,
  OFFICE_INFO,
  OFFICE_INSTALL,
  syncOffice,
  uninstallOffice,
} from "@/lib/harness/packs-state"
import {
  loadOfficeAutoPreview,
  saveOfficeAutoPreview,
} from "@/lib/office-preview-prefs"
import type { SkillSyncReport } from "@/lib/types"
import { cn } from "@/lib/utils"
import { HarnessScroller } from "../harness-scroller"
import { DiscoverMark } from "../discover/discover-card"
import {
  FailureNote,
  FailureText,
  IssueList,
  SkillPath,
} from "../skills/skill-bits"

function SyncReport({ report }: { report: SkillSyncReport }) {
  const t = useTranslations("Harness.packs.office")
  const failed = report.errors.length
  return (
    <div className="min-w-0 space-y-1 text-xs">
      <p>
        {failed > 0
          ? t("syncPartial", { synced: report.synced, failed })
          : t("synced", { synced: report.synced })}
      </p>
      {report.issues && report.issues.length > 0 ? (
        <IssueList issues={report.issues} />
      ) : (
        failed > 0 && (
          <ul className="space-y-0.5 font-mono text-2xs leading-4 text-muted-foreground">
            {report.errors.slice(0, 5).map((error, index) => (
              <li key={index} dir="ltr" className="[overflow-wrap:anywhere]">
                {error}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}

/**
 * OfficeCLI, the tool the Office skills are written from: whether it is
 * here and runs, and Install, Sync and Uninstall. The install runs outside
 * this card (`packs-state.ts`): its progress and log are still here after a
 * switch to another pack or section, and Install cannot be pressed again
 * while it runs. Uninstall asks first.
 */
export function OfficeCard() {
  const t = useTranslations("Harness.packs.office")
  const tOld = useTranslations("OfficeToolsSettings")
  const { slots } = useHarnessView()
  const [info] = useHarnessSlot(OFFICE_INFO)
  const [install] = useHarnessSlot(OFFICE_INSTALL)
  const [action] = useHarnessSlot(OFFICE_ACTION)
  const [autoPreview, setAutoPreview] = useState(() => loadOfficeAutoPreview())
  const logRef = useRef<HTMLDivElement>(null)
  const detecting = info.phase === "loading" && info.data === null
  const data = info.data
  const installed = data?.installed === true
  const runtimeError = data?.runtimeError ?? null
  const healthy = installed && !runtimeError
  const running = install.status === "running"
  const busy =
    running || action.phase === "uninstalling" || action.phase === "syncing"

  // The log follows its last line.
  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [install.log.length])

  return (
    <section
      aria-label={t("label")}
      className={cn(
        "min-w-0 space-y-3 rounded-lg border px-3 py-3",
        healthy
          ? "border-tone-success/30 bg-tone-success/5"
          : installed
            ? "border-tone-warning/40 bg-tone-warning/5"
            : "bg-muted/20"
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        {/* Room for the name and path first: on a narrow card the buttons
            go under them rather than squeezing them into a column. */}
        <div className="min-w-0 flex-[1_1_14rem] space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">OfficeCLI</h3>
            {detecting ? (
              <Loader2
                aria-label={t("detecting")}
                className="size-3.5 animate-spin text-muted-foreground"
              />
            ) : healthy ? (
              <DiscoverMark tone="success">
                {tOld("detection.installed")}
              </DiscoverMark>
            ) : installed ? (
              <DiscoverMark tone="warning">
                {tOld("detection.notRunnable")}
              </DiscoverMark>
            ) : (
              <DiscoverMark>{tOld("detection.notInstalled")}</DiscoverMark>
            )}
            {installed && data?.version && (
              <bdi
                dir="ltr"
                className="font-mono text-2xs leading-4 text-muted-foreground"
              >
                {data.version}
              </bdi>
            )}
          </div>
          {installed && data?.path && <SkillPath path={data.path} />}
          {installed && runtimeError && (
            <p className="text-2xs leading-4 whitespace-pre-wrap text-tone-warning [overflow-wrap:anywhere]">
              {runtimeError}
            </p>
          )}
          {!installed && !detecting && (
            <p className="text-xs text-muted-foreground">
              {tOld("detection.installHint")}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {installed ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void syncOffice(slots)}
                className="max-md:h-10"
              >
                {action.phase === "syncing" ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                {tOld("detection.syncSkills")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => askUninstallOffice(slots)}
                className="text-destructive hover:text-destructive max-md:h-10"
              >
                {action.phase === "uninstalling" ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
                {tOld("detection.uninstall")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={running || detecting || action.phase !== "idle"}
              onClick={() => void installOffice(slots)}
              className="max-md:h-10"
            >
              {running ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Download aria-hidden="true" />
              )}
              {running ? t("installing") : tOld("detection.install")}
            </Button>
          )}
        </div>
      </div>

      {install.status !== "idle" && (
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            {install.status === "running" ? (
              <Loader2
                aria-hidden="true"
                className="size-3.5 animate-spin text-muted-foreground"
              />
            ) : install.status === "succeeded" ? (
              <CircleCheck
                aria-hidden="true"
                className="size-3.5 text-tone-success"
              />
            ) : (
              <TriangleAlert
                aria-hidden="true"
                className="size-3.5 text-tone-warning"
              />
            )}
            <span role="status" className="min-w-0 flex-1">
              {install.status === "running"
                ? install.step === "sync"
                  ? t("syncing")
                  : t("installing")
                : install.status === "succeeded"
                  ? t("installed")
                  : t("installFailed")}
            </span>
            {install.status !== "running" && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("dismiss")}
                title={t("dismiss")}
                onClick={() => dismissOfficeInstall(slots)}
                className="max-md:size-9"
              >
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
          {install.log.length > 0 && (
            <HarnessScroller
              ref={logRef}
              role="log"
              aria-label={t("log")}
              dir="ltr"
              className="max-h-48 rounded-md border bg-muted/50"
            >
              <div className="p-2 font-mono text-2xs leading-relaxed text-muted-foreground">
                {install.log.map((line, index) => (
                  <div
                    key={index}
                    className={cn(
                      "[overflow-wrap:anywhere]",
                      line.startsWith("ERROR:") && "text-destructive"
                    )}
                  >
                    {line}
                  </div>
                ))}
              </div>
            </HarnessScroller>
          )}
          {install.failure && (
            <FailureNote>
              <FailureText failure={install.failure} />
            </FailureNote>
          )}
          {install.sync && <SyncReport report={install.sync} />}
        </div>
      )}

      {(action.failure || action.done) && action.phase === "idle" && (
        <div className="flex min-w-0 items-start gap-2 text-xs">
          <div className="min-w-0 flex-1">
            {action.failure ? (
              <FailureNote>
                <FailureText failure={action.failure} />
              </FailureNote>
            ) : action.done === "uninstalled" ? (
              <p role="status">{t("uninstalled")}</p>
            ) : action.sync ? (
              <SyncReport report={action.sync} />
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("dismiss")}
            title={t("dismiss")}
            onClick={() => dismissOfficeAction(slots)}
            className="max-md:size-9"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}

      <div className="flex min-w-0 items-start justify-between gap-3 border-t pt-3">
        <div className="min-w-0 space-y-0.5">
          <label
            htmlFor="harness-office-auto-preview"
            className="text-sm font-medium"
          >
            {tOld("autoPreviewLabel")}
          </label>
          <p className="text-xs text-muted-foreground">
            {tOld("autoPreviewHint")}
          </p>
        </div>
        <Switch
          id="harness-office-auto-preview"
          checked={autoPreview}
          onCheckedChange={(next) => {
            setAutoPreview(next)
            saveOfficeAutoPreview(next)
          }}
          className="mt-0.5 shrink-0"
        />
      </div>

      <AlertDialog
        open={action.phase === "confirm"}
        onOpenChange={(open) => !open && cancelOfficeAction(slots)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("uninstallTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("uninstallBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => cancelOfficeAction(slots)}>
              {t("keep")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void uninstallOffice(slots)}
            >
              {tOld("detection.uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
