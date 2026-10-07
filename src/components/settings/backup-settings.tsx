"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { History, Loader2, ShieldAlert, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { TabsContent } from "@/components/ui/tabs"
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
import { isDesktop } from "@/lib/platform"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import { relaunchApp, restartApp, waitForServerHealthy } from "@/lib/updater"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import {
  backupActiveAgents,
  cancelBackup,
  discardPendingRestore,
  exportBackupDesktop,
  exportBackupWeb,
  listSafetySnapshots,
  listenBackupProgress,
  prepareBackupSourceDesktop,
  prepareBackupSourceWeb,
  releaseBackupSource,
  rollbackToSnapshot,
  scanExternalConflicts,
  stageRestoreDesktop,
  stageRestoreWeb,
  uploadBackupWeb,
  type BackupPreview,
  type BackupProgress,
  type DegradedSqlite,
  type ExternalConflict,
  type ExternalRestoreMode,
  type SafetySnapshot,
  type StagedRestore,
} from "@/lib/api"

/** Where the archive came from, kept so a passphrase retry can re-prepare it. */
type RestoreOrigin =
  | { kind: "desktop"; path: string }
  | { kind: "web"; uploadId: string }

type RestoreSource = {
  origin: RestoreOrigin
  name: string
  /** Set once the archive has been decrypted and handed a reusable handle. */
  sourceId: string | null
}

type ExternalChoice = "skip" | "side" | "original"

const ACTIVE_PHASES: BackupProgress["phase"][] = [
  "snapshotting",
  "archiving",
  "encrypting",
  "decrypting",
  "extracting",
  "verifying",
  "swapping",
]

/** The backend's i18n key for "a restore is already staged". */
const ALREADY_PENDING_KEY = "backup.restore.error.alreadyPending"

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isAlreadyPending(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { i18nKey?: string }).i18nKey === ALREADY_PENDING_KEY
  )
}

/** Which panel of the data & sync card is on show — see `data-sync-settings.tsx`. */
export type DataSyncPane = "sync" | "backup" | "restore"

/**
 * The "Backup" and "Restore" panels of the data & sync card. Renders two
 * `TabsContent`s and nothing around them, so it has to be mounted inside the
 * `Tabs` root in `data-sync-settings.tsx` — that is where the tab strip, the
 * heading and the card shell live. Keeping both panels in one component is
 * what lets them share the progress feed, the busy flag and the archive that
 * has been picked.
 *
 * `pane` is the card's selected tab: `forceMount` keeps both panels alive
 * across a switch, and `hidden` is what actually takes the one not on show out
 * of the tree — the wrapper's `data-[state=inactive]:hidden` only does that in
 * a browser (see `data-sync-settings.tsx`).
 */
export function BackupSettings({ pane }: { pane: DataSyncPane }) {
  const t = useTranslations("BackupSettings")
  // Root-scoped translator so backend errors carrying dotted i18n keys
  // (`backup.restore.error.*`) localize; falls back to the English message when
  // a key is absent. next-intl's typed `t` is widened to the loose translator
  // shape `toLocalizedErrorMessage` expects.
  const tRoot = useTranslations()
  const localize = useCallback(
    (err: unknown) =>
      toLocalizedErrorMessage(err, tRoot as unknown as AppErrorTranslator),
    [tRoot]
  )
  // A remote-desktop window is a Tauri shell whose transport points at a remote
  // server: native dialogs + local Tauri commands would not line up with that
  // server's ticket/upload web API, so backup is managed on the server itself.
  const remote = isDesktop() && getActiveRemoteConnectionId() !== null
  // "desktop" path = local Tauri only (native dialogs + Tauri commands). Both
  // standalone web and remote-desktop use the web flow / are gated below.
  const desktop = isDesktop() && getActiveRemoteConnectionId() === null

  // ── Export ──
  const [includeExternal, setIncludeExternal] = useState(false)
  const [passphrase, setPassphrase] = useState("")
  const [passphraseConfirm, setPassphraseConfirm] = useState("")
  const [exporting, setExporting] = useState(false)
  const [degraded, setDegraded] = useState<DegradedSqlite[]>([])

  // ── Restore ──
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [restoreSource, setRestoreSource] = useState<RestoreSource | null>(null)
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [restorePassphrase, setRestorePassphrase] = useState("")
  const [inspecting, setInspecting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [staged, setStaged] = useState<StagedRestore | null>(null)
  const [pendingBlocked, setPendingBlocked] = useState(false)

  // ── External transcripts (opt-in restore) ──
  const [externalChoice, setExternalChoice] = useState<ExternalChoice>("skip")
  const [forceOverwrite, setForceOverwrite] = useState(false)
  const [conflicts, setConflicts] = useState<ExternalConflict[] | null>(null)
  const [scanningConflicts, setScanningConflicts] = useState(false)
  const [runningAgents, setRunningAgents] = useState<string[]>([])

  // ── Safety snapshots ──
  const [snapshots, setSnapshots] = useState<SafetySnapshot[]>([])
  const [rollbackTarget, setRollbackTarget] = useState<SafetySnapshot | null>(
    null
  )

  // ── Shared progress feed ──
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  useEffect(() => {
    let active = true
    let unsub: (() => void) | undefined
    void listenBackupProgress((event) => setProgress(event)).then((fn) => {
      if (active) unsub = fn
      else fn()
    })
    return () => {
      active = false
      unsub?.()
    }
  }, [])

  // Wrapped rather than `.catch()`-ed: the snapshot list is a nicety, and a
  // transport that throws synchronously must not take the settings page down
  // with it.
  const refreshSnapshots = useCallback(() => {
    void (async () => {
      try {
        setSnapshots(await listSafetySnapshots())
      } catch {
        setSnapshots([])
      }
    })()
  }, [])
  useEffect(refreshSnapshots, [refreshSnapshots])

  const passphraseMismatch =
    passphrase.length > 0 && passphrase !== passphraseConfirm
  const busy = exporting || restoring

  const resetExternalState = useCallback(() => {
    setExternalChoice("skip")
    setForceOverwrite(false)
    setConflicts(null)
    setRunningAgents([])
  }, [])

  /**
   * Drop a prepared source's decrypted archive as soon as it is superseded.
   * Skipping this is safe (idle reaping and the startup sweep both cover it),
   * but leaving a plaintext copy around longer than necessary is not the goal.
   */
  const releasePrepared = useCallback((id: string | null | undefined) => {
    if (id) void releaseBackupSource(id).catch(() => {})
  }, [])

  const handleExport = useCallback(async () => {
    if (passphraseMismatch) {
      toast.error(t("export.passphraseMismatch"))
      return
    }
    setExporting(true)
    setProgress(null)
    setDegraded([])
    try {
      const opts = {
        includeExternalTranscripts: includeExternal,
        passphrase: passphrase || null,
      }
      if (desktop) {
        const manifest = await exportBackupDesktop(opts)
        if (manifest) {
          setDegraded(manifest.degradedSqlite ?? [])
          toast.success(t("export.success"))
        }
      } else {
        const result = await exportBackupWeb(opts)
        setDegraded(result.degradedSqlite ?? [])
        toast.success(t("export.started"))
      }
    } catch (err) {
      toast.error(localize(err))
    } finally {
      setExporting(false)
      setProgress(null)
    }
  }, [desktop, includeExternal, passphrase, passphraseMismatch, t, localize])

  /** Decrypt once and keep the handle for the conflict scan and for staging. */
  const runPrepare = useCallback(
    async (source: RestoreSource, pass: string | null) => {
      setInspecting(true)
      releasePrepared(source.sourceId)
      try {
        const prepared =
          source.origin.kind === "desktop"
            ? await prepareBackupSourceDesktop(source.origin.path, pass)
            : await prepareBackupSourceWeb(source.origin.uploadId, pass)
        setPreview(prepared.preview)
        setRestoreSource({ ...source, sourceId: prepared.sourceId ?? null })
      } catch (err) {
        toast.error(localize(err))
        setPreview(null)
        setRestoreSource({ ...source, sourceId: null })
      } finally {
        setInspecting(false)
      }
    },
    [localize, releasePrepared]
  )

  const handlePickDesktop = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog")
    const picked = await open({
      multiple: false,
      filters: [{ name: "Codeg backup", extensions: ["codegbak", "zip"] }],
    })
    if (typeof picked !== "string") return
    releasePrepared(restoreSource?.sourceId)
    const name = picked.split(/[\\/]/).pop() ?? picked
    const source: RestoreSource = {
      origin: { kind: "desktop", path: picked },
      name,
      sourceId: null,
    }
    setRestoreSource(source)
    setPreview(null)
    setStaged(null)
    setRestorePassphrase("")
    resetExternalState()
    await runPrepare(source, null)
  }, [runPrepare, resetExternalState, releasePrepared, restoreSource])

  const handlePickWeb = useCallback(
    async (file: File) => {
      releasePrepared(restoreSource?.sourceId)
      setRestoreSource(null)
      setPreview(null)
      setStaged(null)
      setRestorePassphrase("")
      resetExternalState()
      setUploading(true)
      try {
        const uploadId = await uploadBackupWeb(file)
        const source: RestoreSource = {
          origin: { kind: "web", uploadId },
          name: file.name,
          sourceId: null,
        }
        setRestoreSource(source)
        await runPrepare(source, null)
      } catch (err) {
        toast.error(localize(err))
      } finally {
        setUploading(false)
      }
    },
    [runPrepare, resetExternalState, localize, releasePrepared, restoreSource]
  )

  const handleUnlock = useCallback(async () => {
    if (!restoreSource) return
    await runPrepare(restoreSource, restorePassphrase || null)
  }, [restoreSource, restorePassphrase, runPrepare])

  const hasExternal = !!preview?.manifest?.includesExternalTranscripts

  // `SideLocation` is the safe default once an archive turns out to carry
  // transcripts: it hands the files over without touching any agent's
  // directory. (The API's own default stays `Skip` — changing that would alter
  // what an omitted `externalMode` means for existing callers.)
  useEffect(() => {
    if (hasExternal) setExternalChoice("side")
  }, [hasExternal])

  const buildExternalMode = useCallback((): ExternalRestoreMode | null => {
    if (!hasExternal) return null
    if (externalChoice === "skip") return { mode: "skip" }
    if (externalChoice === "side") return { mode: "side_location" }
    return {
      mode: "original_locations",
      on_conflict: forceOverwrite ? "overwrite" : "skip_existing",
    }
  }, [hasExternal, externalChoice, forceOverwrite])

  const handleExternalChoice = useCallback(
    async (choice: ExternalChoice) => {
      setExternalChoice(choice)
      setConflicts(null)
      setRunningAgents([])
      if (choice !== "original" || !restoreSource?.sourceId) return
      setScanningConflicts(true)
      try {
        const [found, agents] = await Promise.all([
          scanExternalConflicts(restoreSource.sourceId),
          // Advisory only: the backend takes a lock before it writes and
          // downgrades to the side location if anything is running. This just
          // means the user rarely gets there by surprise.
          backupActiveAgents().catch(() => [] as string[]),
        ])
        setConflicts(found)
        setRunningAgents(agents)
      } catch (err) {
        toast.error(localize(err))
      } finally {
        setScanningConflicts(false)
      }
    },
    [restoreSource, localize]
  )

  const handleDiscardPending = useCallback(async () => {
    try {
      await discardPendingRestore()
      setPendingBlocked(false)
      toast.success(t("restore.discarded"))
    } catch (err) {
      toast.error(localize(err))
    }
  }, [t, localize])

  /** Restart after the user has read the result panel. */
  const finishRestore = useCallback(async () => {
    setStaged(null)
    if (desktop) {
      await relaunchApp()
      return
    }
    // The restore is staged but only APPLIED on the next server start. If the
    // restart request fails (e.g. unsupported platform, busy), do NOT poll
    // health + reload — that would land back on the still-running old process
    // and look like success while the restore never applied. Tell the user to
    // restart manually instead.
    try {
      await restartApp()
    } catch {
      toast.error(t("restore.restartFailed"))
      setRestoring(false)
      return
    }
    toast.success(t("restore.restarting"))
    const healthy = await waitForServerHealthy({
      timeoutMs: 120_000,
      initialDelayMs: 1500,
    })
    if (healthy) window.location.reload()
    else {
      toast.error(t("restore.restartTimeout"))
      setRestoring(false)
    }
  }, [desktop, t])

  const performRestore = useCallback(async () => {
    if (!restoreSource?.sourceId) return
    setConfirmOpen(false)
    setRestoring(true)
    setProgress(null)
    try {
      const externalMode = buildExternalMode()
      const result =
        restoreSource.origin.kind === "desktop"
          ? await stageRestoreDesktop({
              sourceId: restoreSource.sourceId,
              externalMode,
            })
          : (
              await stageRestoreWeb({
                sourceId: restoreSource.sourceId,
                externalMode,
              })
            ).staged
      // Both runtimes now show what actually happened before restarting; the
      // desktop path used to relaunch immediately and drop the whole report.
      setStaged(result)
      setRestoreSource({ ...restoreSource, sourceId: null })
      toast.success(t("restore.staged"))
    } catch (err) {
      if (isAlreadyPending(err)) setPendingBlocked(true)
      toast.error(localize(err))
      setRestoring(false)
    }
  }, [restoreSource, buildExternalMode, t, localize])

  const handleRollback = useCallback(async () => {
    const target = rollbackTarget
    setRollbackTarget(null)
    if (!target) return
    try {
      await rollbackToSnapshot(target.id)
      toast.success(t("restore.staged"))
      await finishRestore()
    } catch (err) {
      if (isAlreadyPending(err)) setPendingBlocked(true)
      toast.error(localize(err))
    }
  }, [rollbackTarget, finishRestore, t, localize])

  const handleCancelOp = useCallback(async () => {
    if (!progress?.opId) return
    try {
      await cancelBackup(progress.opId)
    } catch (err) {
      toast.error(localize(err))
    }
  }, [progress, localize])

  const showProgress = progress && ACTIVE_PHASES.includes(progress.phase)

  // Both panels of the tab strip `DataSyncSettings` owns — the card shell, the
  // heading and the strip itself live there, so this renders nothing but the
  // two `TabsContent`s and the dialogs they open.
  if (remote) {
    // Repeated per panel rather than replacing the card: the strip is not
    // ours to collapse, and a tab that opens onto nothing explains nothing.
    const unsupported = (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-500">
        {t("remoteUnsupported")}
      </div>
    )
    return (
      <>
        <TabsContent
          value="backup"
          forceMount
          hidden={pane !== "backup"}
          className="pt-2"
        >
          {unsupported}
        </TabsContent>
        <TabsContent
          value="restore"
          forceMount
          hidden={pane !== "restore"}
          className="pt-2"
        >
          {unsupported}
        </TabsContent>
      </>
    )
  }

  return (
    <>
      {/* ── Backup ── */}
      <TabsContent
        value="backup"
        forceMount
        hidden={pane !== "backup"}
        className="space-y-4 pt-2"
      >
        <p className="text-xs text-muted-foreground leading-5">
          {t("export.description")}
        </p>
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className="text-xs font-medium">
              {t("export.includeExternal")}
            </Label>
            <p className="text-2xs text-muted-foreground">
              {t("export.includeExternalHint")}
            </p>
          </div>
          <Switch
            checked={includeExternal}
            onCheckedChange={setIncludeExternal}
            disabled={busy}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-medium">
            {t("export.passphrase")}
          </Label>
          <Input
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t("export.passphrasePlaceholder")}
            disabled={busy}
          />
          {passphrase.length > 0 && (
            <Input
              type="password"
              autoComplete="new-password"
              value={passphraseConfirm}
              onChange={(e) => setPassphraseConfirm(e.target.value)}
              placeholder={t("export.passphraseConfirm")}
              disabled={busy}
            />
          )}
          {passphraseMismatch && (
            <p className="text-2xs text-red-400">
              {t("export.passphraseMismatch")}
            </p>
          )}
          {passphrase.length === 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-500">
              <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{t("export.noPassphraseWarning")}</span>
            </div>
          ) : (
            <p className="text-2xs text-muted-foreground">
              {t("export.passphraseLossWarning")}
            </p>
          )}
        </div>

        <Button
          type="button"
          size="sm"
          onClick={handleExport}
          disabled={busy || passphraseMismatch}
        >
          {exporting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("export.button")}
        </Button>

        {exporting && showProgress && (
          <ProgressLine
            progress={progress}
            label={t("export.inProgress")}
            cancelLabel={t("progress.cancel")}
            onCancel={handleCancelOp}
          />
        )}

        {degraded.length > 0 && (
          <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-500">
            <p className="font-medium">{t("export.degradedTitle")}</p>
            <p>{t("export.degradedHint")}</p>
            <ul className="space-y-0.5 pt-1">
              {degraded.slice(0, 8).map((d) => (
                <li key={d.archivePath} className="truncate">
                  {d.agent} — {t(`export.degradedLevel.${d.level}`)}
                </li>
              ))}
            </ul>
            {degraded.length > 8 && (
              <p>{t("export.degradedMore", { count: degraded.length - 8 })}</p>
            )}
          </div>
        )}
      </TabsContent>

      {/* ── Restore ── */}
      <TabsContent
        value="restore"
        forceMount
        hidden={pane !== "restore"}
        className="space-y-4 pt-2"
      >
        <p className="text-xs text-muted-foreground leading-5">
          {t("restore.description")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || inspecting || uploading}
            onClick={() => {
              if (desktop) void handlePickDesktop()
              else fileInputRef.current?.click()
            }}
          >
            {(inspecting || uploading) && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {t("restore.selectFile")}
          </Button>
          {restoreSource && (
            <span className="text-xs text-muted-foreground truncate">
              {restoreSource.name}
            </span>
          )}
          {!desktop && (
            <input
              ref={fileInputRef}
              type="file"
              accept=".codegbak,.zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handlePickWeb(file)
                e.target.value = ""
              }}
            />
          )}
        </div>

        {pendingBlocked && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-500">
            <span>{t("restore.pendingBlockedHint")}</span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={handleDiscardPending}
            >
              {t("restore.discardPending")}
            </Button>
          </div>
        )}

        {preview?.needsPassphrase && (
          <div className="space-y-2">
            <Label className="text-xs font-medium">
              {t("restore.passphrasePrompt")}
            </Label>
            <div className="flex gap-2">
              <Input
                type="password"
                value={restorePassphrase}
                onChange={(e) => setRestorePassphrase(e.target.value)}
                disabled={inspecting}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={handleUnlock}
                disabled={inspecting || restorePassphrase.length === 0}
              >
                {t("restore.unlock")}
              </Button>
            </div>
          </div>
        )}

        {preview?.manifest && (
          <div className="rounded-md border bg-muted/20 p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-medium">{t("restore.preview.title")}</span>
              {preview.encrypted && (
                <Badge variant="secondary">
                  {t("restore.preview.encrypted")}
                </Badge>
              )}
              {preview.compatible ? (
                <Badge variant="outline">
                  {t("restore.preview.compatible")}
                </Badge>
              ) : (
                <Badge variant="destructive">
                  {t("restore.preview.incompatible")}
                </Badge>
              )}
            </div>
            <div className="text-muted-foreground">
              {t("restore.preview.createdAt", {
                value: new Date(preview.manifest.createdAt).toLocaleString(),
              })}
            </div>
            <div className="text-muted-foreground">
              {t("restore.preview.appVersion", {
                value: preview.manifest.appVersion,
              })}
            </div>
            {!preview.compatible && (
              <div className="text-red-400">
                {t("restore.preview.incompatibleHint")}
              </div>
            )}
          </div>
        )}

        {hasExternal && preview?.compatible && (
          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <div className="space-y-0.5">
              <Label className="text-xs font-medium">
                {t("restore.external.title")}
              </Label>
              <p className="text-2xs text-muted-foreground">
                {t("restore.external.hint")}
              </p>
            </div>
            <Select
              value={externalChoice}
              onValueChange={(v) =>
                void handleExternalChoice(v as ExternalChoice)
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="skip">
                  {t("restore.external.modeSkip")}
                </SelectItem>
                <SelectItem value="side">
                  {t("restore.external.modeSide")}
                </SelectItem>
                <SelectItem value="original">
                  {t("restore.external.modeOriginal")}
                </SelectItem>
              </SelectContent>
            </Select>
            {externalChoice === "original" && (
              <div className="space-y-2">
                {scanningConflicts ? (
                  <p className="text-2xs text-muted-foreground">
                    {t("restore.external.scanning")}
                  </p>
                ) : conflicts && conflicts.length === 0 ? (
                  <p className="text-2xs text-muted-foreground">
                    {t("restore.external.noConflicts")}
                  </p>
                ) : conflicts && conflicts.length > 0 ? (
                  <div className="space-y-1">
                    <p className="text-2xs text-amber-500">
                      {t("restore.external.conflictCount", {
                        count: conflicts.length,
                      })}
                    </p>
                    <p className="text-2xs text-muted-foreground">
                      {t("restore.external.conflictSkipNote")}
                    </p>
                  </div>
                ) : null}
                {runningAgents.length > 0 && (
                  <p className="text-2xs text-amber-500">
                    {t("restore.external.agentsRunning", {
                      count: runningAgents.length,
                      agents: runningAgents.join(", "),
                    })}
                  </p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <Label className="text-xs font-medium">
                      {t("restore.external.forceOverwrite")}
                    </Label>
                    <p className="text-2xs text-muted-foreground">
                      {t("restore.external.forceOverwriteHint")}
                    </p>
                  </div>
                  <Switch
                    checked={forceOverwrite}
                    onCheckedChange={setForceOverwrite}
                    disabled={busy}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {preview?.manifest && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-2xs text-red-400">
            <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              {t("restore.replaceWarning")}
              {/* Keyring note applies to local desktop only: GitHub/chat
                      tokens live in the OS keychain and are NOT in the backup,
                      so they need re-entry after a desktop restore. In
                      server/web mode those tokens are in tokens.json, which IS
                      backed up. */}
              {desktop ? ` ${t("restore.keyringNote")}` : ""}
            </span>
          </div>
        )}

        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={
            busy ||
            !preview?.manifest ||
            !preview.compatible ||
            !restoreSource?.sourceId ||
            inspecting
          }
          onClick={() => setConfirmOpen(true)}
        >
          {restoring && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("restore.button")}
        </Button>

        {restoring && showProgress && (
          <ProgressLine
            progress={progress}
            label={t("restore.staging")}
            cancelLabel={t("progress.cancel")}
            onCancel={handleCancelOp}
          />
        )}

        {/* ── Safety snapshots ──
            The undo half of this panel: every restore snapshots the current
            data first, so the way back sits under the way in rather than in a
            card of its own. */}
        <div className="space-y-2 border-t pt-4">
          <div className="flex items-center gap-2">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            <Label className="text-xs font-medium">
              {t("snapshots.title")}
            </Label>
          </div>
          <p className="text-2xs text-muted-foreground">
            {t("snapshots.hint")}
          </p>
          {snapshots.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              {t("snapshots.empty")}
            </p>
          ) : (
            <ul className="space-y-2">
              {snapshots.map((snap) => (
                <li
                  key={snap.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-xs">
                      {snap.createdAt
                        ? new Date(snap.createdAt).toLocaleString()
                        : snap.id}
                    </div>
                    <div className="text-2xs text-muted-foreground truncate">
                      {formatMb(snap.sizeBytes)} · {snap.path}
                    </div>
                  </div>
                  {snap.rollbackSupported ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRollbackTarget(snap)}
                    >
                      {t("snapshots.rollback")}
                    </Button>
                  ) : (
                    <span className="text-2xs text-muted-foreground">
                      {t("snapshots.unsupported")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </TabsContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restore.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("restore.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("restore.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={performRestore}>
              {t("restore.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!rollbackTarget}
        onOpenChange={(open) => !open && setRollbackTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("snapshots.rollbackConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("snapshots.rollbackConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("restore.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRollback}>
              {t("snapshots.rollback")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* What the stage actually did — shown on BOTH runtimes before the
          restart. The desktop path used to relaunch immediately, so the side
          location, the skipped conflicts and any downgrade were never seen. */}
      <AlertDialog
        open={!!staged}
        onOpenChange={(open) => {
          if (open) return
          // Escape or an outside click dismisses without going through
          // "Later", so `restoring` has to be cleared here too — otherwise
          // every control stays disabled until the page is reloaded.
          setStaged(null)
          setRestoring(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restore.result.title")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left text-xs">
                <p>{t("restore.result.needsRestart")}</p>
                {staged?.externalDowngraded && (
                  <p className="text-amber-500">
                    {t("restore.result.downgraded", {
                      agents: staged.externalDowngraded.agents.join(", "),
                      path: staged.externalDowngraded.path,
                    })}
                  </p>
                )}
                {!staged?.externalDowngraded &&
                  staged?.restoredExternalPath && (
                    <p>
                      {t("restore.externalSideLocation", {
                        path: staged.restoredExternalPath,
                      })}
                    </p>
                  )}
                {!!staged?.skippedConflicts.length && (
                  <details>
                    <summary className="cursor-pointer">
                      {t("restore.result.skipped", {
                        count: staged.skippedConflicts.length,
                      })}
                    </summary>
                    <ul className="pt-1 space-y-0.5 text-muted-foreground">
                      {staged.skippedConflicts.slice(0, 20).map((p) => (
                        <li key={p} className="truncate">
                          {p}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {!!staged?.refusedExternal?.length && (
                  <details>
                    <summary className="cursor-pointer text-amber-500">
                      {t("restore.result.refused", {
                        count: staged.refusedExternal.length,
                      })}
                    </summary>
                    <p className="pt-1 text-muted-foreground">
                      {t("restore.result.refusedHint")}
                    </p>
                    <ul className="pt-1 space-y-0.5 text-muted-foreground">
                      {staged.refusedExternal.slice(0, 20).map((r) => (
                        <li key={r.archivePath} className="truncate">
                          {r.targetPath}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRestoring(false)}>
              {t("restore.result.later")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={finishRestore}>
              {t("restore.result.restartNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ProgressLine({
  progress,
  label,
  cancelLabel,
  onCancel,
}: {
  progress: BackupProgress
  label: string
  cancelLabel: string
  onCancel: () => void
}) {
  const pct =
    progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, (progress.processedBytes / progress.totalBytes) * 100)
      : null
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        <span>{label}</span>
        <div className="flex items-center gap-2">
          <span>
            {progress.totalBytes
              ? `${formatMb(progress.processedBytes)} / ${formatMb(progress.totalBytes)}`
              : formatMb(progress.processedBytes)}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-5 px-1.5"
            onClick={onCancel}
            title={cancelLabel}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={
            pct === null
              ? "h-full w-1/3 animate-pulse bg-primary"
              : "h-full bg-primary transition-all"
          }
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
