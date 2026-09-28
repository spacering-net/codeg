"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  ArrowUpCircle,
  CheckCircle2,
  Languages,
  Loader2,
  Power,
  RefreshCw,
  RotateCcw,
  Wifi,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { useAppI18n } from "@/components/i18n-provider"
import { DataSyncSettings } from "@/components/settings/data-sync-settings"
import { ReleaseNotes } from "@/components/settings/release-notes"
import { SettingsSection } from "@/components/shared/settings-section"
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
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  getSystemAutostartSettings,
  getSystemProxySettings,
  updateSystemAutostartSettings,
  updateSystemLanguageSettings,
  updateSystemProxySettings,
} from "@/lib/api"
import { isLocalDesktop, openUrl } from "@/lib/platform"
import type { AppLocale } from "@/lib/types"
import { readLastCheck } from "@/lib/update-check-storage"
import { describeAppUpdateError, usesTauriUpdater } from "@/lib/updater"
import { useAppUpdate } from "@/components/providers/update-provider"
import { APP_LOCALES } from "@/lib/i18n"
import { toErrorMessage } from "@/lib/app-error"
import type { AppCommandError } from "@/lib/types"

function GithubMarkIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 0c6.63 0 12 5.276 12 11.79-.001 5.067-3.29 9.567-8.175 11.187-.6.118-.825-.25-.825-.56 0-.398.015-1.665.015-3.242 0-1.105-.375-1.813-.81-2.181 2.67-.295 5.475-1.297 5.475-5.822 0-1.297-.465-2.344-1.23-3.169.12-.295.54-1.503-.12-3.125 0 0-1.005-.324-3.3 1.209a11.32 11.32 0 00-3-.398c-1.02 0-2.04.133-3 .398-2.295-1.518-3.3-1.209-3.3-1.209-.66 1.622-.24 2.83-.12 3.125-.765.825-1.23 1.887-1.23 3.169 0 4.51 2.79 5.527 5.46 5.822-.345.294-.66.81-.765 1.577-.69.31-2.415.81-3.495-.973-.225-.354-.9-1.223-1.845-1.209-1.005.015-.405.56.015.781.51.28 1.095 1.327 1.23 1.666.24.663 1.02 1.93 4.035 1.385 0 .988.015 1.916.015 2.196 0 .31-.225.664-.825.56C3.303 21.374-.003 16.867 0 11.791 0 5.276 5.37 0 12 0z" />
    </svg>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const PROXY_EXAMPLE = "http://127.0.0.1:7890"
// Written exactly as the backend stores the list — comma-separated, no spaces —
// so the example, the placeholder and the saved value all read the same.
const PROXY_BYPASS_EXAMPLE = "git.example.com,.example.org,192.168.1.10"

// A value in a hint, set apart from the prose so its punctuation is not read
// as the sentence's. `dir="ltr"` keeps it intact in Arabic, where the leading
// `.` of `.example.com` would otherwise move to the far end.
const hintLiteral = (chunks: ReactNode) => (
  <code dir="ltr" className="rounded bg-muted px-1 font-mono break-words">
    {chunks}
  </code>
)
const APP_LANGUAGE_VALUES = APP_LOCALES

type LanguageSelectValue = "system" | AppLocale

function isAppLocale(value: string): value is AppLocale {
  return APP_LANGUAGE_VALUES.includes(value as AppLocale)
}

type UpdateAction = "check" | "install"

export function SystemNetworkSettings() {
  const t = useTranslations("SystemSettings")
  const tLanguage = useTranslations("Language")
  const locale = useLocale()
  const { languageSettings, languageSettingsLoaded, setLanguageSettings } =
    useAppI18n()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingLanguage, setSavingLanguage] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [proxyUrl, setProxyUrl] = useState("")
  const [proxyUrlError, setProxyUrlError] = useState<string | null>(null)
  const [noProxy, setNoProxy] = useState("")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false)

  // Launch at login registers *this* machine's executable with the OS, so it
  // only means something for a local Tauri shell — a remote workspace window
  // routes every call to a server that has no login items to speak of.
  const autostartVisible = isLocalDesktop()
  const [autostartEnabled, setAutostartEnabled] = useState(false)
  const [savingAutostart, setSavingAutostart] = useState(false)
  // Non-null when the OS refused to report the registration (no home dir, a
  // locked-down registry, …). The row stays on screen but inert, which beats
  // hiding a setting the user came looking for.
  const [autostartError, setAutostartError] = useState<string | null>(null)

  // Both halves of the update flow — "is a newer release out there" and the
  // in-flight download / install / restart lifecycle — live in the app-wide
  // UpdateProvider (settings/layout.tsx wraps this page), so this page and the
  // workspace status bar always agree and only one manifest fetch happens. It
  // is always mounted inside the provider, hence the non-null assertion.
  const update = useAppUpdate()!
  const {
    state: updateState,
    isUpdating,
    restartCountdown,
    isRollingBack,
    hydrated: updateHydrated,
    isBusy,
    available: availableUpdate,
    currentVersion,
    checking: checkingUpdate,
    checkError,
    lastCheckedAt,
    selfUpdateSupported: serverSelfUpdate,
    liveProgress: serverLiveProgress,
    runtime: serverRuntime,
    rollbackAvailable: serverRollbackAvailable,
    selfUpdateBlocker,
    canInstallInPlace,
    checkNow,
    refreshLocalStatus,
    startUpdate,
    restart,
    rollback,
  } = update
  const updateReady = updateState.status === "ready_to_restart"
  // Rollback is only safe from a settled lifecycle (never while an upgrade is
  // downloading/installing/staged/restarting — that conflicts with the
  // "Restart to update" prompt). For a server that speaks the live-progress
  // protocol, wait for the authoritative snapshot to hydrate before trusting
  // the status (the default is a placeholder `idle`); older servers don't
  // hydrate, so they're allowed through on their reported availability. A
  // rollback renames within the same directories as an update: one the server
  // refuses to write rules it out, while a full disk (which only stops the
  // update from creating files) does not.
  const canRollback =
    serverSelfUpdate &&
    serverRollbackAvailable &&
    selfUpdateBlocker?.code !== "permission_denied" &&
    !usesTauriUpdater() &&
    (updateState.status === "idle" || updateState.status === "error") &&
    (updateHydrated || !serverLiveProgress)
  // A determinate bar needs a known content length; the install phase (and a
  // length-less download) fall back to an indeterminate pulse.
  const downloadDeterminate =
    updateState.status === "downloading" &&
    !!updateState.total &&
    updateState.total > 0
  const downloadPercent = downloadDeterminate
    ? Math.min(
        100,
        ((updateState.downloaded ?? 0) / (updateState.total as number)) * 100
      )
    : 0

  const [appLanguage, setAppLanguage] = useState<LanguageSelectValue>(
    languageSettings.mode === "system" ? "system" : languageSettings.language
  )

  useEffect(() => {
    setAppLanguage(
      languageSettings.mode === "system" ? "system" : languageSettings.language
    )
  }, [languageSettings])

  const languageLabels = useMemo(
    () => ({
      en: tLanguage("english"),
      zh_cn: tLanguage("simplifiedChinese"),
      zh_tw: tLanguage("traditionalChinese"),
      ja: tLanguage("japanese"),
      ko: tLanguage("korean"),
      es: tLanguage("spanish"),
      de: tLanguage("german"),
      fr: tLanguage("french"),
      pt: tLanguage("portuguese"),
      ar: tLanguage("arabic"),
    }),
    [tLanguage]
  )

  const formattedLastCheckedAt = useMemo(() => {
    if (!lastCheckedAt) return null
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(lastCheckedAt)
  }, [lastCheckedAt, locale])

  const formattedUpdateDate = useMemo(() => {
    if (!availableUpdate?.date) return null

    const parsed = new Date(availableUpdate.date)
    if (Number.isNaN(parsed.getTime())) return availableUpdate.date

    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
    }).format(parsed)
  }, [availableUpdate?.date, locale])

  const updateNotes = useMemo(
    () => availableUpdate?.body?.trim() ?? "",
    [availableUpdate?.body]
  )

  const updateStatusMessage = useMemo(() => {
    if (checkingUpdate) return t("checking")
    if (isUpdating) return t("updating")
    if (availableUpdate) return null
    if (lastCheckedAt) return t("alreadyLatest")
    return null
  }, [availableUpdate, checkingUpdate, isUpdating, lastCheckedAt, t])

  const loadSettings = useCallback(async () => {
    setLoading(true)
    setLoadError(null)

    try {
      const [proxySettings, autostart] = await Promise.all([
        getSystemProxySettings(),
        // Kept out of the shared rejection path: a machine that cannot report
        // its login items must not blank out the proxy and language cards.
        autostartVisible
          ? getSystemAutostartSettings().then(
              (settings) => ({ settings, error: null }),
              (err) => {
                console.error("[Settings] load autostart settings failed:", err)
                return { settings: null, error: toErrorMessage(err) }
              }
            )
          : Promise.resolve(null),
      ])

      setEnabled(proxySettings.enabled)
      setProxyUrl(proxySettings.proxy_url ?? "")
      setNoProxy(proxySettings.no_proxy ?? "")

      if (autostart) {
        setAutostartEnabled(autostart.settings?.enabled ?? false)
        setAutostartError(autostart.error)
      }
    } catch (err) {
      const message = toErrorMessage(err)
      setLoadError(message)
      console.error("[Settings] load system settings failed:", err)
    } finally {
      setLoading(false)
    }
  }, [autostartVisible])

  useEffect(() => {
    loadSettings().catch((err) => {
      console.error("[Settings] load system settings failed:", err)
    })
    // The version, capability bits and "is there an update" answer all come
    // from the provider: it seeds local status on mount, restores the last
    // result from storage and runs the periodic manifest check. So opening
    // this page no longer costs a second check — unless nothing has ever been
    // checked (read from storage, not from provider state, which the provider
    // seeds in its own effect and therefore may not have applied yet), or the
    // last attempt failed, in which case opening this page is a natural retry.
    if (!readLastCheck() || checkError) {
      checkNow({ silent: true }).catch((err) => {
        console.error("[Settings] auto check update failed:", err)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveProxySettings = useCallback(
    async (nextEnabled: boolean, nextProxyUrl: string, nextNoProxy: string) => {
      if (nextEnabled && !nextProxyUrl.trim()) return

      setSaving(true)
      try {
        const next = await updateSystemProxySettings({
          enabled: nextEnabled,
          proxy_url: nextProxyUrl.trim() || null,
          no_proxy: nextNoProxy.trim() || null,
        })
        setEnabled(next.enabled)
        setProxyUrl(next.proxy_url ?? "")
        setNoProxy(next.no_proxy ?? "")
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("saveFailed", { message }))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  const saveAutostartSettings = useCallback(
    async (next: boolean, prev: boolean) => {
      setSavingAutostart(true)
      try {
        // The backend answers with what the OS settled on, not with the
        // request — Windows can veto a Run entry through Task Manager, so the
        // switch has to follow the reply rather than the optimistic value.
        const result = await updateSystemAutostartSettings({ enabled: next })
        setAutostartEnabled(result.enabled)
        setAutostartError(null)
      } catch (err) {
        setAutostartEnabled(prev)
        const message = toErrorMessage(err)
        toast.error(t("autostartSaveFailed", { message }))
      } finally {
        setSavingAutostart(false)
      }
    },
    [t]
  )

  const saveLanguage = useCallback(
    async (lang: LanguageSelectValue) => {
      setSavingLanguage(true)

      try {
        const next = await updateSystemLanguageSettings({
          mode: lang === "system" ? "system" : "manual",
          language: lang === "system" ? languageSettings.language : lang,
        })

        setLanguageSettings(next)
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("languageSaveFailed", { message }))
      } finally {
        setSavingLanguage(false)
      }
    },
    [languageSettings.language, setLanguageSettings, t]
  )

  const formatUpdateError = useCallback(
    (
      error: unknown,
      action: UpdateAction,
      info?: AppCommandError | null
    ): string => {
      const { key, values } = describeAppUpdateError(error, action, info)
      if (key === "updateErrors.unknown") {
        console.error(
          "[Settings] updater unknown error:",
          toErrorMessage(error)
        )
      }
      return t(key, values)
    },
    [t]
  )

  // A failure inside the detached backend download/install task lands in the
  // shared update state rather than as a thrown error here, so surface it the
  // same way as a check error — and it stays visible after navigating back.
  const lifecycleError =
    updateState.status === "error" && updateState.error
      ? formatUpdateError(updateState.error, "install", updateState.errorInfo)
      : null

  // The shared check records the raw failure; classify it for display here.
  const updateError = checkError ? formatUpdateError(checkError, "check") : null
  // The banner shows one of the two; a failed check takes precedence.
  const bannerError = updateError || lifecycleError

  // What keeps this server from updating in place, said up front rather than
  // after a click that is certain to fail — unless the banner already says it.
  const blockerMessage = selfUpdateBlocker
    ? formatUpdateError(selfUpdateBlocker.message, "install", selfUpdateBlocker)
    : null
  const blockerHint = blockerMessage !== bannerError ? blockerMessage : null

  // A user-initiated check, so failures toast (the provider's own periodic
  // checks stay silent). Re-reads the local status too: that is where a
  // blocker the operator has since fixed gets cleared.
  const checkForUpdates = useCallback(() => {
    void refreshLocalStatus()
    void checkNow({ silent: false })
  }, [checkNow, refreshLocalStatus])

  // Close a stale rollback confirm dialog if the lifecycle leaves a
  // rollback-able state — e.g. another window staged an update while the dialog
  // sat open — so it can't fire a now-conflicting rollback. The backend also
  // rejects such a rollback; this avoids the user even reaching it.
  useEffect(() => {
    if (rollbackConfirmOpen && !canRollback) {
      setRollbackConfirmOpen(false)
    }
  }, [rollbackConfirmOpen, canRollback])

  // Manual rollback runs through the provider (it owns the restart + verify
  // flow); afterwards refresh the rollback affordance — a single-generation
  // `.bak` is consumed by a successful rollback (which also reloads the page).
  const handleRollback = useCallback(async () => {
    setRollbackConfirmOpen(false)
    await rollback()
    void refreshLocalStatus()
  }, [rollback, refreshLocalStatus])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <div className="flex items-center justify-between">
            <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
            <Button
              variant="ghost"
              className="size-5 rounded-full"
              onClick={() => openUrl("https://github.com/xintaofei/codeg")}
            >
              <GithubMarkIcon className="size-5" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </section>

        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            {checkingUpdate ? (
              <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
            ) : availableUpdate ? (
              <ArrowUpCircle className="h-4 w-4 text-muted-foreground" />
            ) : lastCheckedAt ? (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            ) : (
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
            )}
            <h2 className="text-sm font-semibold">{t("versionTitle")}</h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("updateDescription")}
          </p>

          <div className="rounded-md border bg-muted/20 px-3 py-3 text-xs space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-muted-foreground">
                {t("currentVersion")}：
                {currentVersion ? `v${currentVersion}` : "-"}
              </p>
              {checkingUpdate ? (
                <Button
                  key="checking-update"
                  size="sm"
                  disabled
                  aria-busy="true"
                  className="w-[9.5rem] justify-center transition-none"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("checking")}
                </Button>
              ) : updateReady ? (
                // Download finished in the background — relaunch into it
                // (IDE-style "Restart to update").
                <Button
                  size="sm"
                  onClick={() => void restart()}
                  disabled={isBusy}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("restartToUpdate")}
                </Button>
              ) : isBusy ? (
                <Button
                  size="sm"
                  disabled
                  aria-busy="true"
                  className="w-[9.5rem] justify-center transition-none"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("updating")}
                </Button>
              ) : availableUpdate ? (
                // In-place upgrade only when this client can actually drive it:
                // desktop (Tauri plugin) or a server speaking the live-progress
                // protocol. An older remote server falls back to "view release".
                canInstallInPlace ? (
                  <Button size="sm" onClick={() => void startUpdate()}>
                    <ArrowUpCircle className="h-3.5 w-3.5" />
                    {t("upgradeTo", { version: availableUpdate.version })}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      openUrl(
                        "https://github.com/xintaofei/codeg/releases/latest"
                      )
                    }
                  >
                    <ArrowUpCircle className="h-3.5 w-3.5" />
                    {t("viewRelease", { version: availableUpdate.version })}
                  </Button>
                )
              ) : (
                <Button
                  key="check-update"
                  size="sm"
                  onClick={checkForUpdates}
                  disabled={isBusy}
                  className="w-[9.5rem] justify-center transition-none"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("checkUpdate")}
                </Button>
              )}
            </div>

            {!availableUpdate && formattedLastCheckedAt && (
              <p className="text-muted-foreground">
                {t("lastChecked", { time: formattedLastCheckedAt })}
              </p>
            )}

            {updateStatusMessage && !isUpdating && (
              <p className="text-muted-foreground">{updateStatusMessage}</p>
            )}

            {isUpdating && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>
                    {updateState.status === "downloading"
                      ? t("downloading")
                      : t("updating")}
                  </span>
                  {updateState.status === "downloading" && (
                    <span>
                      {formatBytes(updateState.downloaded ?? 0)}
                      {updateState.total
                        ? ` / ${formatBytes(updateState.total)}`
                        : ""}
                    </span>
                  )}
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  {downloadDeterminate ? (
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{ width: `${downloadPercent}%` }}
                    />
                  ) : (
                    <div className="h-full w-1/3 rounded-full bg-primary animate-pulse" />
                  )}
                </div>
              </div>
            )}

            {updateReady && (
              <p className="text-muted-foreground">{t("updateReadyHint")}</p>
            )}

            {restartCountdown !== null && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {restartCountdown > 0
                  ? t("restartingIn", { seconds: restartCountdown })
                  : t("waitingForServer")}
              </p>
            )}

            {canRollback && (
              <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-muted-foreground/80 text-2xs leading-5">
                  {t("rollbackDescription")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRollbackConfirmOpen(true)}
                  disabled={isBusy}
                >
                  {isRollingBack ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t("rollingBack")}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t("rollbackButton")}
                    </>
                  )}
                </Button>
              </div>
            )}

            {blockerHint && (
              <p className="text-2xs leading-5 text-amber-500">{blockerHint}</p>
            )}

            {availableUpdate &&
              serverSelfUpdate &&
              !selfUpdateBlocker &&
              serverRuntime === "docker" && (
                <p className="text-muted-foreground/80 text-2xs leading-5">
                  {t("dockerUpgradeHint")}
                </p>
              )}

            {availableUpdate && (
              <div className="space-y-2 pt-2 border-t border-border/70">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">
                    {t("upgradableVersion")}：v{availableUpdate.version}
                  </span>
                  {formattedUpdateDate && (
                    <span className="text-muted-foreground text-2xs">
                      {formattedUpdateDate}
                    </span>
                  )}
                </div>
                <ReleaseNotes
                  notes={updateNotes}
                  emptyLabel={t("none")}
                  className="mt-3 max-h-72 overflow-auto rounded-md border bg-background/70 px-3 py-3"
                />
              </div>
            )}
          </div>

          {bannerError && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {t("updateError", { message: bannerError })}
            </div>
          )}
        </section>

        {/* Titled by the option itself: the section *is* the one switch, so a
            card holding a single row would only say the heading back one line
            lower. */}
        {autostartVisible && (
          <SettingsSection
            icon={Power}
            title={t("autostartTitle")}
            description={t("autostartDescription")}
            htmlFor="launch-at-login"
            control={
              <Switch
                id="launch-at-login"
                checked={autostartEnabled}
                disabled={savingAutostart || autostartError !== null}
                onCheckedChange={(next) => {
                  const prev = autostartEnabled
                  setAutostartEnabled(next)
                  void saveAutostartSettings(next, prev)
                }}
              />
            }
          >
            {autostartError !== null && (
              <p className="text-2xs text-amber-500">
                {t("autostartUnavailable", { message: autostartError })}
              </p>
            )}
          </SettingsSection>
        )}

        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("proxyTitle")}</h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("proxyDescription")}
          </p>

          {loadError && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {t("loadFailed", { message: loadError })}
            </div>
          )}

          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              disabled={saving}
              onChange={(event) => {
                const next = event.target.checked
                if (next && !proxyUrl.trim()) {
                  setProxyUrlError(t("proxyRequired"))
                  return
                }
                setProxyUrlError(null)
                setEnabled(next)
                saveProxySettings(next, proxyUrl, noProxy)
              }}
            />
            {t("enableProxy")}
          </label>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("proxyAddress")}
            </label>
            <Input
              value={proxyUrl}
              onChange={(event) => {
                setProxyUrl(event.target.value)
                if (event.target.value.trim()) setProxyUrlError(null)
              }}
              onBlur={() => {
                if (enabled && !proxyUrl.trim()) {
                  setProxyUrlError(t("proxyRequired"))
                  return
                }
                setProxyUrlError(null)
                saveProxySettings(enabled, proxyUrl, noProxy)
              }}
              placeholder={PROXY_EXAMPLE}
              disabled={saving}
              aria-invalid={proxyUrlError ? true : undefined}
            />
            {proxyUrlError && (
              <p className="text-2xs text-destructive">{proxyUrlError}</p>
            )}
            <p className="text-2xs text-muted-foreground">
              {t("proxyHint", { example: PROXY_EXAMPLE })}
            </p>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="system-proxy-bypass"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("proxyBypass")}
            </label>
            <Input
              id="system-proxy-bypass"
              // Hosts read left to right in every locale; in Arabic an entry
              // typed first as `.example.com` would show its dot at the end.
              dir="ltr"
              value={noProxy}
              onChange={(event) => setNoProxy(event.target.value)}
              onBlur={() => saveProxySettings(enabled, proxyUrl, noProxy)}
              placeholder={PROXY_BYPASS_EXAMPLE}
              disabled={saving}
            />
            <p className="text-2xs text-muted-foreground">
              {t.rich("proxyBypassHint", {
                example: PROXY_BYPASS_EXAMPLE,
                code: hintLiteral,
              })}
            </p>
          </div>
        </section>

        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Languages className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("languageTitle")}</h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("languageDescription")}
          </p>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("appLanguage")}
            </label>
            <Select
              value={appLanguage}
              onValueChange={(value) => {
                let nextLang: LanguageSelectValue
                if (value === "system") {
                  nextLang = "system"
                } else if (isAppLocale(value)) {
                  nextLang = value
                } else {
                  return
                }
                setAppLanguage(nextLang)
                saveLanguage(nextLang)
              }}
              disabled={savingLanguage || !languageSettingsLoaded}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="system">
                  {tLanguage("followSystem")}
                </SelectItem>
                <SelectItem value="en">{languageLabels.en}</SelectItem>
                <SelectItem value="zh_cn">{languageLabels.zh_cn}</SelectItem>
                <SelectItem value="zh_tw">{languageLabels.zh_tw}</SelectItem>
                <SelectItem value="ja">{languageLabels.ja}</SelectItem>
                <SelectItem value="ko">{languageLabels.ko}</SelectItem>
                <SelectItem value="es">{languageLabels.es}</SelectItem>
                <SelectItem value="de">{languageLabels.de}</SelectItem>
                <SelectItem value="fr">{languageLabels.fr}</SelectItem>
                <SelectItem value="pt">{languageLabels.pt}</SelectItem>
                <SelectItem value="ar">{languageLabels.ar}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </section>

        <DataSyncSettings />

        <AlertDialog
          open={rollbackConfirmOpen}
          onOpenChange={(open) => {
            if (!isRollingBack) setRollbackConfirmOpen(open)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("rollbackConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("rollbackConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isRollingBack}>
                {t("rollbackCancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault()
                  void handleRollback()
                }}
              >
                {t("rollbackConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </ScrollArea>
  )
}
