"use client"

/**
 * The `/settings/computer-use` page: everything about letting agents see and
 * use the desktop's windows, in one place.
 *
 *   * The switch itself. The in-conversation tools panel and the status-bar
 *     popover write the same setting, and each hears the others.
 *   * cua-driver, the program that reads and acts on windows: which release
 *     this codeg runs, fetching it, removing it (desktop only). There is no
 *     picking another release — codeg runs the one it pins and checks — so
 *     "upgrade" appears only where the cache holds an older one.
 *   * The helper's macOS permissions, while computer use is on (the helper
 *     that holds them only runs then), asked afresh whenever this window
 *     comes back to the front: that is when a person returns from granting
 *     one in System Settings.
 *   * Sharing and the stop shortcut (`computer-settings.tsx`).
 *
 * It used to be one section at the bottom of `/settings/collaboration`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CircleAlert,
  CircleCheck,
  Download,
  HardDrive,
  Loader2,
  Monitor,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { ComputerSettingsSection } from "@/components/settings/computer-settings"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSection,
} from "@/components/shared/settings-section"
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
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { useIsMac } from "@/hooks/use-is-mac"
import { toErrorMessage } from "@/lib/app-error"
import {
  computerServerPlatform,
  setComputerToolsEnabled,
  useComputerAvailable,
} from "@/lib/computer/computer-api"
import type { DriverInfo, OsPermission } from "@/lib/computer/types"
import { useComputerDriver } from "@/lib/computer/use-computer-driver"
import { useComputerEnabled } from "@/lib/computer/use-computer-enabled"
import {
  codegHoldsPermission,
  useComputerStatus,
} from "@/lib/computer/use-computer-status"

export function ComputerUseSettings() {
  const t = useTranslations("ComputerUse.settings")
  // The driver and the permissions are where computer use is served: the
  // desktop app's machine, or a server's that shares the screen it runs on.
  const desktop = useComputerAvailable()
  const { enabled, mark, applySince } = useComputerEnabled({
    desktopOnly: false,
  })
  const [switching, setSwitching] = useState(false)

  const setEnabled = async (next: boolean) => {
    setSwitching(true)
    const since = mark()
    try {
      applySince(await setComputerToolsEnabled(next), since)
    } catch (e) {
      toast.error(t("switch.failed"), { description: toErrorMessage(e) })
    } finally {
      setSwitching(false)
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <h1 className="text-sm font-semibold">{t("pageTitle")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("pageDescription")}
          </p>
        </section>

        <SettingsSection
          icon={Monitor}
          title={t("switch.label")}
          description={t("switch.hint")}
          htmlFor="computer-use-enabled"
          control={
            <Switch
              id="computer-use-enabled"
              checked={enabled === true}
              onCheckedChange={(next) => void setEnabled(next)}
              disabled={enabled === null || switching}
            />
          }
        />

        {desktop && <DriverSection />}

        {desktop && <PermissionsSection enabled={enabled === true} />}

        <ComputerSettingsSection />
      </div>
    </ScrollArea>
  )
}

/** How far an install has got: megabytes so far and in all, and the share
 *  done once both are known. */
function progressOf(info: DriverInfo | null): {
  value: number | null
  done: number | null
  total: number | null
} {
  const task = info?.task
  if (task?.kind !== "installing" || task.downloadedMb === undefined) {
    return { value: null, done: null, total: null }
  }
  const total = task.totalMb ?? null
  return {
    done: task.downloadedMb,
    total,
    value: total ? Math.min(100, (task.downloadedMb / total) * 100) : null,
  }
}

function DriverSection() {
  const t = useTranslations("ComputerUse.settings.driver")
  const { info, error, install, uninstall } = useComputerDriver()
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  /** An install or removal this page asked for and has not heard back
   *  from — before the backend's own word on it arrives. */
  const [pending, setPending] = useState(false)

  const task = info?.task
  const busy = task !== undefined || pending
  const current = !!info && info.installed.includes(info.version)
  const older = info ? info.installed.filter((v) => v !== info.version) : []
  const progress = progressOf(info)
  const problem = error ?? info?.error ?? null

  let line: string
  if (!info) line = t("loading")
  else if (!info.supported) line = t("unsupported")
  else if (task?.kind === "installing")
    line =
      progress.done !== null
        ? progress.total !== null
          ? t("downloadingOf", {
              done: progress.done,
              total: progress.total.toFixed(1),
            })
          : t("downloadingSoFar", { done: progress.done })
        : t("installing")
  else if (task?.kind === "uninstalling") line = t("uninstalling")
  else if (current) line = t("installed", { version: info.version })
  else if (older.length > 0)
    line = t("outdated", { installed: older[0], version: info.version })
  else line = t("notInstalled")

  const onInstall = async () => {
    if (busy) return
    setPending(true)
    try {
      if (await install()) toast.success(t("installDone"))
    } finally {
      setPending(false)
    }
  }
  const onUninstall = async () => {
    if (busy) return
    setPending(true)
    try {
      if (await uninstall()) toast.success(t("uninstallDone"))
    } finally {
      setPending(false)
      setConfirmUninstall(false)
    }
  }

  return (
    <SettingsSection
      icon={HardDrive}
      title={t("title")}
      description={t("description", { version: info?.version ?? "" })}
    >
      <SettingCard>
        <SettingRow
          title="cua-driver"
          description={line}
          control={
            busy ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : info?.supported ? (
              <div className="flex items-center gap-1">
                {!current && (
                  <Button size="sm" onClick={() => void onInstall()}>
                    <Download className="size-3.5" />
                    {older.length > 0
                      ? t("upgrade", { version: info.version })
                      : t("install")}
                  </Button>
                )}
                {info.installed.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmUninstall(true)}
                  >
                    <Trash2 className="size-3.5" />
                    {t("uninstall")}
                  </Button>
                )}
              </div>
            ) : null
          }
        >
          {progress.value !== null && (
            <Progress value={progress.value} className="h-1.5" />
          )}
          {current && info?.path && (
            <p
              className="truncate font-mono text-2xs text-muted-foreground"
              title={info.path}
            >
              {info.path}
            </p>
          )}
        </SettingRow>
      </SettingCard>

      {problem && <SettingsError>{problem}</SettingsError>}

      <AlertDialog
        open={confirmUninstall}
        onOpenChange={(open) => {
          if (!busy) setConfirmUninstall(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            {/* Stays open until the backend answers. */}
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void onUninstall()
              }}
            >
              {t("uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}

/** macOS only: the permissions belong to the helper, and nowhere else is
 *  there anything to grant. The Mac is the one whose screen this is: this
 *  machine, or the server's that shares its screen. */
function PermissionsSection({ enabled }: { enabled: boolean }) {
  const isMac = useIsMac()
  const server = computerServerPlatform()
  if (!(server ? server === "macos" : isMac)) return null
  return <MacPermissions enabled={enabled} />
}

function MacPermissions({ enabled }: { enabled: boolean }) {
  const t = useTranslations("ComputerUse")
  const tp = useTranslations("ComputerUse.settings.permissions")
  const { status, loading, error, refresh, request, requesting, revealHelper } =
    useComputerStatus(enabled)
  const permissions = enabled ? status?.permissions : undefined
  const development = status?.backend.peer === "development"
  const missing =
    !!permissions && !(permissions.accessibility && permissions.screenRecording)

  const rows: ReadonlyArray<[OsPermission, boolean | undefined]> = [
    ["accessibility", permissions?.accessibility],
    ["screenRecording", permissions?.screenRecording],
  ]

  return (
    <SettingsSection
      icon={ShieldCheck}
      title={tp("title")}
      description={tp("description")}
      control={
        enabled ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t("refresh")}
            title={t("refresh")}
          >
            <RotateCw className={loading ? "size-3 animate-spin" : "size-3"} />
            {t("refresh")}
          </Button>
        ) : undefined
      }
    >
      {!enabled ? (
        <p className="text-xs text-muted-foreground">{tp("off")}</p>
      ) : (
        <>
          <SettingCard>
            {rows.map(([permission, granted]) => (
              <SettingRow
                key={permission}
                icon={
                  granted === undefined
                    ? undefined
                    : granted
                      ? CircleCheck
                      : CircleAlert
                }
                title={t(`permissions.${permission}`)}
                description={tp(`${permission}Hint`)}
                control={
                  granted === undefined ? null : granted ? (
                    <span className="text-xs text-muted-foreground">
                      {t("permissions.granted")}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={requesting !== null}
                      onClick={() => void request(permission)}
                    >
                      {t("permissions.request")}
                    </Button>
                  )
                }
              />
            ))}
          </SettingCard>
          {missing && (
            <div className="space-y-1 text-xs leading-5 text-muted-foreground">
              <p>
                {t("permissions.why")}
                {development && ` ${t("permissions.devRebuild")}`}
              </p>
              <p>
                {t("permissions.notListed")}{" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={revealHelper}
                >
                  {t("permissions.reveal")}
                </button>
              </p>
            </div>
          )}
        </>
      )}
      {codegHoldsPermission(status) && (
        <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-amber-600 dark:text-amber-400">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("codegGranted")}</span>
        </div>
      )}
      {error && <SettingsError>{error}</SettingsError>}
    </SettingsSection>
  )
}
