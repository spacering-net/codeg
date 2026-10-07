"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  CloudUpload,
  FileDown,
  FileUp,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { Switch } from "@/components/ui/switch"
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
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import {
  applyConfigRollback,
  downloadAndApplyConfig,
  exportConfigToFile,
  getConfigSyncSettings,
  getConfigSyncState,
  importPickedConfig,
  listConfigRollbacks,
  listenConfigSyncStatus,
  peekRemoteConfig,
  pickConfigFileToImport,
  summarizeCounts,
  testConfigSyncConnection,
  updateConfigSyncSettings,
  uploadConfigNow,
  type ConfigManifest,
  type ConfigSyncSettingsInput,
  type DomainCounts,
  type PickedConfigImport,
  type RollbackSnapshot,
} from "@/lib/config-sync"

/** Fixed choices instead of a free number field: the interval only has to be
 *  "how stale may the remote copy be", and an open input invites 0 or 99999. */
const INTERVAL_OPTIONS = [5, 15, 30, 60] as const

const SCOPE_INCLUDED = [
  "providers",
  "agentSettings",
  "customAgents",
  "quickMessages",
  "taskTemplates",
  "preferences",
] as const

const SCOPE_EXCLUDED = [
  "conversations",
  "uploads",
  "workspaces",
  "mcp",
  "credentials",
] as const

/// Address templates only. A preset never changes how the client talks to the
/// server, so adding one is a translation change, not a protocol change.
const WEBDAV_PRESETS = [
  { id: "jianguoyun", url: "https://dav.jianguoyun.com/dav/" },
  {
    id: "nextcloud",
    url: "https://example.com/remote.php/dav/files/username/",
  },
  { id: "synology", url: "http://192.168.1.10:5005/" },
  { id: "custom", url: null },
] as const

type PresetId = (typeof WEBDAV_PRESETS)[number]["id"]

/// Recognises a saved URL so reopening settings keeps the preset highlighted.
function presetFromUrl(url: string): PresetId {
  const value = url.trim().toLowerCase()
  if (value.includes("dav.jianguoyun.com")) return "jianguoyun"
  if (value.includes("/remote.php/dav")) return "nextcloud"
  if (/:(5005|5006)(\/|$)/.test(value)) return "synology"
  return "custom"
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

/**
 * The "Configuration sync" panel of the data & sync card
 * (`data-sync-settings.tsx`): what a machine's settings are, in a file or on a
 * WebDAV server. It renders no card shell or heading of its own — the card and
 * the tab that selects this panel supply both.
 */
export function ConfigSyncSettings() {
  const t = useTranslations("ConfigSyncSettings")
  // Root translator so backend errors carrying `configSync.error.*` keys
  // localize; falls back to the English message when the key is unknown.
  const tRoot = useTranslations()
  const localize = useCallback(
    (err: unknown) =>
      toLocalizedErrorMessage(err, tRoot as unknown as AppErrorTranslator),
    [tRoot]
  )

  const [loaded, setLoaded] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [serverUrl, setServerUrl] = useState("")
  const [preset, setPreset] = useState<PresetId>("custom")
  const [username, setUsername] = useState("")
  // Always starts empty. Submitting an empty field means "keep the stored
  // password"; rendering a mask here would risk saving the mask itself.
  const [password, setPassword] = useState("")
  const [hasPassword, setHasPassword] = useState(false)
  // The account the stored password belongs to. The backend drops that
  // password rather than sending it to a host or user it was not typed for,
  // so the "leave empty to keep it" hint has to stop claiming otherwise the
  // moment either field is edited.
  const [savedAccount, setSavedAccount] = useState({
    serverUrl: "",
    username: "",
  })
  // Encryption is opt-in: the default boundary is the user's own authenticated
  // endpoint, which is a real one for a share they host themselves.
  const [encrypt, setEncrypt] = useState(false)
  const [passphrase, setPassphrase] = useState("")
  const [hasPassphrase, setHasPassphrase] = useState(false)
  const [remoteDir, setRemoteDir] = useState("codeg")
  const [profile, setProfile] = useState("default")
  const [autoSync, setAutoSync] = useState(true)
  const [intervalMinutes, setIntervalMinutes] = useState(5)

  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  const [busy, setBusy] = useState<
    | null
    | "save"
    | "test"
    | "upload"
    | "download"
    | "export"
    | "import"
    | "rollback"
  >(null)
  const [pendingImport, setPendingImport] = useState<PickedConfigImport | null>(
    null
  )
  const [remoteManifest, setRemoteManifest] = useState<ConfigManifest | null>(
    null
  )
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [rollbacks, setRollbacks] = useState<RollbackSnapshot[]>([])
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [pendingRollback, setPendingRollback] =
    useState<RollbackSnapshot | null>(null)
  // Reference material, folded by default — see the block it wraps.
  const [scopeOpen, setScopeOpen] = useState(false)

  // Guards against a late `setState` when the settings page unmounts during a
  // slow WebDAV round-trip.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Refreshed after anything that writes one, so the undo list is never a
   *  snapshot of the panel's first paint. */
  const refreshRollbacks = useCallback(async () => {
    try {
      const listed = await listConfigRollbacks()
      if (!mounted.current) return
      setRollbacks(listed)
      // The entry that owns the popover is rendered off this list, so an empty
      // one takes the whole subtree away. Clearing the flag with it stops a
      // later snapshot mounting a popover that is already open, un-asked.
      if (listed.length === 0) setRollbackOpen(false)
    } catch (err) {
      // A missing or unreadable snapshot directory is not worth a toast: the
      // section simply does not appear.
      console.error("[config-sync] failed to list rollback snapshots", err)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [settings, state] = await Promise.all([
          getConfigSyncSettings(),
          getConfigSyncState(),
          refreshRollbacks(),
        ])
        if (cancelled) return
        setEnabled(settings.enabled)
        setServerUrl(settings.serverUrl)
        setPreset(presetFromUrl(settings.serverUrl))
        setUsername(settings.username)
        setHasPassword(settings.hasPassword)
        setSavedAccount({
          serverUrl: settings.serverUrl,
          username: settings.username,
        })
        setEncrypt(settings.encrypt)
        setHasPassphrase(settings.hasPassphrase)
        setRemoteDir(settings.remoteDir)
        setProfile(settings.profile)
        setAutoSync(settings.autoSync)
        setIntervalMinutes(settings.intervalMinutes)
        setLastSyncAt(state.lastSyncAt)
        setLastError(state.lastError)
      } catch (err) {
        console.error("[config-sync] failed to load settings", err)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshRollbacks])

  // The background uploader reports here; without this the panel would show a
  // stale "last synced" until the page is reopened.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    void listenConfigSyncStatus((event) => {
      setLastSyncAt(event.lastSyncAt)
      setLastError(event.lastError)
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const currentInput = useCallback(
    (
      overrides?: Partial<ConfigSyncSettingsInput>
    ): ConfigSyncSettingsInput => ({
      enabled,
      serverUrl: serverUrl.trim(),
      username: username.trim(),
      password: password.length > 0 ? password : null,
      passphrase: passphrase.length > 0 ? passphrase : null,
      encrypt,
      remoteDir: remoteDir.trim(),
      profile: profile.trim(),
      autoSync,
      intervalMinutes,
      ...overrides,
    }),
    [
      enabled,
      serverUrl,
      username,
      password,
      passphrase,
      encrypt,
      remoteDir,
      profile,
      autoSync,
      intervalMinutes,
    ]
  )

  const handleSave = useCallback(async () => {
    setBusy("save")
    try {
      const saved = await updateConfigSyncSettings(currentInput())
      if (!mounted.current) return
      setHasPassword(saved.hasPassword)
      setHasPassphrase(saved.hasPassphrase)
      setSavedAccount({
        serverUrl: saved.serverUrl,
        username: saved.username,
      })
      setRemoteDir(saved.remoteDir)
      setProfile(saved.profile)
      setIntervalMinutes(saved.intervalMinutes)
      // Clear the fields once they are stored, so a second save does not
      // re-send values the user cannot see.
      setPassword("")
      setPassphrase("")
      toast.success(t("saved"))
    } catch (err) {
      toast.error(localize(err))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [currentInput, localize, t])

  /**
   * Turning encryption off drops anything typed into the passphrase field but
   * NOT the one already on file. The field is only visible while the switch is
   * on, so a passphrase left in state there would be submitted by a later Save
   * that the user believes has nothing to do with it — storing a secret they
   * withdrew, and making `hasPassphrase` claim protection they never confirmed.
   * The stored passphrase survives on purpose: it is what still decrypts the
   * copy already sitting on the remote.
   */
  const handleToggleEncrypt = useCallback((next: boolean) => {
    setEncrypt(next)
    if (!next) setPassphrase("")
  }, [])

  /**
   * The master switch saves on click, like the proxy and launch-at-login
   * switches in the sections above. It has to: every other control — Save
   * included — lives inside the block this flag hides, so a toggle that only
   * moved local state could be flipped ON but never OFF, and the background
   * uploader would keep running against settings the panel says are off.
   */
  const handleToggleEnabled = useCallback(
    async (next: boolean) => {
      const previous = enabled
      setEnabled(next)
      setBusy("save")
      try {
        // Secrets are explicitly withheld: `null` means "unchanged". Anything
        // typed into the password or passphrase field has not been submitted
        // yet, and flipping a switch is not a submission — a user who types a
        // password, thinks better of it and turns sync OFF instead must not
        // find that password stored. The fields keep their text, so an
        // explicit Save is still one click away.
        const saved = await updateConfigSyncSettings(
          currentInput({ enabled: next, password: null, passphrase: null })
        )
        if (!mounted.current) return
        setHasPassword(saved.hasPassword)
        setHasPassphrase(saved.hasPassphrase)
        setSavedAccount({
          serverUrl: saved.serverUrl,
          username: saved.username,
        })
      } catch (err) {
        if (mounted.current) setEnabled(previous)
        toast.error(localize(err))
      } finally {
        if (mounted.current) setBusy(null)
      }
    },
    [currentInput, enabled, localize]
  )

  const handleTest = useCallback(async () => {
    setBusy("test")
    try {
      await testConfigSyncConnection(currentInput())
      if (mounted.current) toast.success(t("testSucceeded"))
    } catch (err) {
      toast.error(localize(err))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [currentInput, localize, t])

  const handleUpload = useCallback(async () => {
    setBusy("upload")
    try {
      const outcome = await uploadConfigNow()
      if (!mounted.current) return
      setLastSyncAt(outcome.syncedAt)
      setLastError(null)
      toast.success(t("uploaded"))
    } catch (err) {
      const message = localize(err)
      if (mounted.current) setLastError(message)
      toast.error(message)
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [localize, t])

  /** Look before overwriting: the confirmation names the machine and time the
   *  remote snapshot came from. */
  const handleOpenRestore = useCallback(async () => {
    setBusy("download")
    try {
      const manifest = await peekRemoteConfig()
      if (!mounted.current) return
      if (!manifest) {
        toast.error(t("noRemoteSnapshot"))
        return
      }
      setRemoteManifest(manifest)
      setRestoreOpen(true)
    } catch (err) {
      toast.error(localize(err))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [localize, t])

  const handleConfirmRestore = useCallback(async () => {
    setRestoreOpen(false)
    setBusy("download")
    try {
      const outcome = await downloadAndApplyConfig()
      if (!mounted.current) return
      // Providers, appearance, and language are read once at launch, so the
      // window the user is looking at keeps showing the old values. Saying so
      // is the difference between "it worked" and "it did nothing".
      toast.success(t("restored", { count: outcome.applied.total }), {
        description: t("restartHint"),
      })
      // A restore just wrote a rollback point; the undo list has to show it.
      await refreshRollbacks()
    } catch (err) {
      toast.error(localize(err))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [localize, refreshRollbacks, t])

  const handleExport = useCallback(async () => {
    setBusy("export")
    try {
      const summary = await exportConfigToFile()
      // `null` = the user dismissed the save dialog, which is not an error.
      if (summary && mounted.current) toast.success(t("exported"))
    } catch (err) {
      toast.error(localize(err))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [localize, t])

  /**
   * Deliberately outside the `busy` gate, unlike every other action here.
   * `pickConfigFileToImport` is pending for as long as a file dialog is open,
   * and on an engine that does not dispatch `cancel` (see `pickLocalFile`) a
   * dismissed dialog leaves it pending for good — which, gated, would mean a
   * settings section whose every button stays disabled until the page is
   * remounted. Nothing is written until the confirmation below, so there is
   * nothing here that a second click could corrupt.
   */
  const handlePickImport = useCallback(async () => {
    try {
      const picked = await pickConfigFileToImport()
      if (picked && mounted.current) setPendingImport(picked)
    } catch (err) {
      toast.error(localize(err))
    }
  }, [localize])

  const handleConfirmImport = useCallback(async () => {
    if (!pendingImport) return
    const source = pendingImport.source
    setPendingImport(null)
    setBusy("import")
    try {
      const result = await importPickedConfig(source)
      if (mounted.current) {
        toast.success(t("imported", { count: result.applied.total }), {
          description: t("restartHint"),
        })
      }
      await refreshRollbacks()
    } catch (err) {
      toast.error(localize(err))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [pendingImport, localize, refreshRollbacks, t])

  /**
   * Undo an import or a restore. The backend captures the pre-apply state
   * every time either one runs; without this the snapshots were written,
   * pruned, and never reachable from the product.
   */
  const handleConfirmRollback = useCallback(async () => {
    if (!pendingRollback) return
    const id = pendingRollback.id
    setPendingRollback(null)
    setBusy("rollback")
    try {
      const result = await applyConfigRollback(id)
      if (mounted.current) {
        toast.success(t("rolledBack", { count: result.applied.total }), {
          description: t("restartHint"),
        })
      }
      // The undo wrote its own rollback point, so it is itself undoable.
      await refreshRollbacks()
    } catch (err) {
      toast.error(localize(err))
      // A snapshot that has since been pruned must disappear from the list
      // rather than stay there offering a button that fails.
      await refreshRollbacks()
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [pendingRollback, localize, refreshRollbacks, t])

  const syncedLabel = formatTimestamp(lastSyncAt)
  // Only the hosted services need a setup note; "custom" has nothing to say.
  const presetHint = preset === "custom" ? null : t(`presetHint.${preset}`)
  const remoteBusy = busy === "upload" || busy === "download"
  const credentialsIncomplete =
    serverUrl.trim().length === 0 || username.trim().length === 0
  // Editing either half of the account orphans the stored password: saving
  // from here stores an empty one, so the field must ask for a real value
  // instead of offering to keep something that will be dropped.
  const keepsStoredPassword =
    hasPassword &&
    serverUrl.trim() === savedAccount.serverUrl &&
    username.trim() === savedAccount.username

  return (
    // Panel of the data & sync card: the heading is the tab that selected it,
    // and the two columns below say what "sync" covers better than a paragraph
    // repeating them would.
    <div className="space-y-4">
      {/* Eleven lines of reference text that answer one question — folded, so
          the panel opens on the things you came here to do. The card's own
          description already draws the line between sync and backup; this is
          the detail behind it, and the two columns exist so nobody reads
          "sync" as "backs up everything". */}
      <Collapsible open={scopeOpen} onOpenChange={setScopeOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("scopeTitle")}
            <ChevronDown className="size-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-2xs font-medium text-muted-foreground">
                {t("scopeIncludedTitle")}
              </Label>
              <ul className="space-y-1">
                {SCOPE_INCLUDED.map((key) => (
                  <li key={key} className="flex items-start gap-1.5 text-2xs">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-500" />
                    <span>{t(`scopeIncluded.${key}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-1.5">
              <Label className="text-2xs font-medium text-muted-foreground">
                {t("scopeExcludedTitle")}
              </Label>
              <ul className="space-y-1">
                {SCOPE_EXCLUDED.map((key) => (
                  <li
                    key={key}
                    className="flex items-start gap-1.5 text-2xs text-muted-foreground"
                  >
                    <X className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{t(`scopeExcluded.${key}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Local file transfer works with no server at all, so it comes first.
          Every block below is separated the same way, so the panel reads as a
          list of blocks rather than one run-on wall. */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-xs font-medium text-muted-foreground">
          {t("fileTitle")}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={busy !== null}
          >
            {busy === "export" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="h-4 w-4" />
            )}
            {t("exportButton")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePickImport}
            disabled={busy !== null}
          >
            {busy === "import" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileUp className="h-4 w-4" />
            )}
            {t("importButton")}
          </Button>

          {/* Only once there is something to undo — and on this row rather
              than in a block of its own: it is the way back from the button
              next to it, and up to ten restore points listed inline pushed
              everything else off the panel. */}
          {rollbacks.length > 0 ? (
            <Popover open={rollbackOpen} onOpenChange={setRollbackOpen}>
              <PopoverTrigger asChild>
                {/* Readable while something else is in flight — only the undo
                    buttons inside are gated on `busy`, which is what the
                    inline list did. `ms-auto`, not `ml-auto`: Arabic runs the
                    row right-to-left and a physical margin would park this
                    against the Import button instead of the row's end. */}
                <Button variant="ghost" size="sm" className="ms-auto">
                  {busy === "rollback" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Undo2 className="h-4 w-4" />
                  )}
                  <span>{t("rollbackTitle")}</span>
                  <span className="text-2xs text-muted-foreground tabular-nums">
                    {rollbacks.length}
                  </span>
                </Button>
              </PopoverTrigger>
              {/* Named after its trigger rather than repeating the words in a
                  heading: one more line to read on a list this short, and the
                  popover is a `dialog`, so the label is what announces it. */}
              <PopoverContent
                align="end"
                aria-label={t("rollbackTitle")}
                className="w-80 gap-2"
              >
                <p className="text-2xs text-muted-foreground leading-5">
                  {t("rollbackHint")}
                </p>
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {rollbacks.map((snapshot) => (
                    <li
                      key={snapshot.id}
                      className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate text-2xs">
                          {formatTimestamp(snapshot.createdAt) ??
                            t("rollbackUnknownTime")}
                        </p>
                        <CountsSummary counts={snapshot.counts} />
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        // Closed here rather than left open behind the
                        // confirmation: the popover is not modal, so it would
                        // still be sitting there once the dialog is answered.
                        onClick={() => {
                          setRollbackOpen(false)
                          setPendingRollback(snapshot)
                        }}
                        disabled={busy !== null}
                      >
                        {t("rollbackAction")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
        <p className="text-2xs text-muted-foreground">{t("fileHint")}</p>
      </div>

      <div className="border-t pt-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label
              htmlFor="config-sync-enabled"
              className="text-xs font-medium"
            >
              {t("webdavTitle")}
            </Label>
            <p className="text-2xs text-muted-foreground">{t("webdavHint")}</p>
          </div>
          <Switch
            id="config-sync-enabled"
            checked={enabled}
            onCheckedChange={(next) => void handleToggleEnabled(next)}
            disabled={!loaded || busy !== null}
          />
        </div>

        {enabled ? (
          <div className="space-y-3">
            {/* Pure address templates — no provider-specific logic anywhere. */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("presetLabel")}
              </Label>
              <div className="flex flex-wrap gap-2">
                {WEBDAV_PRESETS.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    size="sm"
                    variant={preset === item.id ? "secondary" : "outline"}
                    onClick={() => {
                      setPreset(item.id)
                      if (item.url) setServerUrl(item.url)
                    }}
                    disabled={busy !== null}
                  >
                    {t(`preset.${item.id}`)}
                  </Button>
                ))}
              </div>
              {presetHint ? (
                <p className="text-2xs text-muted-foreground">{presetHint}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="config-sync-url"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("serverUrl")}
              </Label>
              <Input
                id="config-sync-url"
                value={serverUrl}
                onChange={(e) => {
                  setServerUrl(e.target.value)
                  setPreset(presetFromUrl(e.target.value))
                }}
                placeholder="https://dav.example.com/dav/"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label
                  htmlFor="config-sync-user"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("username")}
                </Label>
                <Input
                  id="config-sync-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="config-sync-password"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("password")}
                </Label>
                <Input
                  id="config-sync-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    keepsStoredPassword
                      ? t("passwordKeep")
                      : t("passwordPlaceholder")
                  }
                  autoComplete="new-password"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label
                  htmlFor="config-sync-dir"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("remoteDir")}
                </Label>
                <Input
                  id="config-sync-dir"
                  value={remoteDir}
                  onChange={(e) => setRemoteDir(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="config-sync-profile"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("profile")}
                </Label>
                <Input
                  id="config-sync-profile"
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
            <p className="text-2xs text-muted-foreground">{t("profileHint")}</p>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label
                  htmlFor="config-sync-encrypt"
                  className="text-xs font-medium"
                >
                  {t("encryptLabel")}
                </Label>
                <p className="text-2xs text-muted-foreground">
                  {t("encryptHint")}
                </p>
              </div>
              <Switch
                id="config-sync-encrypt"
                checked={encrypt}
                onCheckedChange={handleToggleEncrypt}
                disabled={busy !== null}
              />
            </div>

            {encrypt ? (
              <div className="space-y-2">
                <Label
                  htmlFor="config-sync-passphrase"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("passphrase")}
                </Label>
                <Input
                  id="config-sync-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={
                    hasPassphrase
                      ? t("passphraseKeep")
                      : t("passphrasePlaceholder")
                  }
                  autoComplete="new-password"
                />
                <p className="text-2xs text-muted-foreground">
                  {t("passphraseHint")}
                </p>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label
                  htmlFor="config-sync-auto"
                  className="text-xs font-medium"
                >
                  {t("autoSyncLabel")}
                </Label>
                <p className="text-2xs text-muted-foreground">
                  {t("autoSyncHint")}
                </p>
              </div>
              <Switch
                id="config-sync-auto"
                checked={autoSync}
                onCheckedChange={setAutoSync}
                disabled={busy !== null}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("intervalLabel")}
              </Label>
              <Select
                value={String(intervalMinutes)}
                onValueChange={(value) => setIntervalMinutes(Number(value))}
                disabled={!autoSync || busy !== null}
              >
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {INTERVAL_OPTIONS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {t("intervalOption", { minutes })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={busy !== null || credentialsIncomplete}
              >
                {busy === "save" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {t("saveButton")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={busy !== null || credentialsIncomplete}
              >
                {busy === "test" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {t("testButton")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleUpload}
                disabled={busy !== null || credentialsIncomplete}
              >
                {busy === "upload" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CloudUpload className="h-4 w-4" />
                )}
                {t("uploadButton")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenRestore}
                disabled={busy !== null || credentialsIncomplete}
              >
                {busy === "download" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {t("restoreButton")}
              </Button>
            </div>

            <div className="text-2xs text-muted-foreground space-y-1">
              <p>
                {syncedLabel
                  ? t("lastSyncAt", { time: syncedLabel })
                  : t("neverSynced")}
              </p>
              {lastError ? (
                <p className="text-destructive">
                  {t("lastError", { message: lastError })}
                </p>
              ) : null}
              {remoteBusy ? <p>{t("working")}</p> : null}
            </div>

            {/* The warning has to stop saying "plaintext" the moment it stops
                being true, or it trains the user to ignore it. */}
            {encrypt ? (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
                <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
                <p className="text-2xs text-muted-foreground leading-5">
                  {t("encryptedNotice")}
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
                <p className="text-2xs text-muted-foreground leading-5">
                  {t("plaintextWarning")}
                </p>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <AlertDialog
        open={pendingImport !== null}
        onOpenChange={(open) => {
          if (!open) setPendingImport(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("importConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{t("importConfirmBody")}</p>
                {/* The backend's recount, not the file's own `manifest.counts`
                    — a hand-edited export can disagree with its payload, and
                    the confirmation has to name what will really be written. */}
                {pendingImport ? (
                  <CountsSummary counts={pendingImport.preview.counts} />
                ) : null}
                <p>{t("restartHint")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleConfirmImport()
              }}
            >
              {t("importConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingRollback !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRollback(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("rollbackConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t("rollbackConfirmBody", {
                    time:
                      formatTimestamp(pendingRollback?.createdAt ?? null) ??
                      t("rollbackUnknownTime"),
                  })}
                </p>
                {pendingRollback ? (
                  <CountsSummary counts={pendingRollback.counts} />
                ) : null}
                <p>{t("restartHint")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleConfirmRollback()
              }}
            >
              {t("rollbackConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={restoreOpen} onOpenChange={setRestoreOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restoreConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t("restoreConfirmBody", {
                    device: remoteManifest?.sourceDevice ?? "",
                    time:
                      formatTimestamp(remoteManifest?.createdAt ?? null) ?? "",
                  })}
                </p>
                {remoteManifest ? (
                  <CountsSummary counts={remoteManifest.counts} />
                ) : null}
                <p>{t("restartHint")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleConfirmRestore()
              }}
            >
              {t("restoreConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** "3 providers · 2 agents · 12 preferences" — what is actually about to be
 *  written, so a confirmation is more than a shrug. */
function CountsSummary({ counts }: { counts: DomainCounts }) {
  const t = useTranslations("ConfigSyncSettings")
  const entries = summarizeCounts(counts)
  if (entries.length === 0) {
    return (
      <p className="text-2xs text-muted-foreground">{t("emptySnapshot")}</p>
    )
  }
  return (
    <ul className="text-2xs text-muted-foreground space-y-0.5">
      {entries.map((entry) => (
        <li key={entry.id}>
          {t(`domain.${entry.id}`, { count: entry.count })}
        </li>
      ))}
    </ul>
  )
}
