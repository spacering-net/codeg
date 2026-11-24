"use client"

/**
 * Computer use: how long a shared window stays shared while nobody reads it,
 * which applications can never be shared, and — on the desktop — the
 * shortcut that stops all sharing at once and whether the strip with Stop on
 * it floats above every window while anything is shared (turned off, Stop is
 * still in the status-bar popover and on the shortcut). The on/off switch
 * sits above it on the Computer use page (and with the other tool groups,
 * and in the status-bar popover); this section edits only the settings
 * under it, through a writer that leaves the switch alone.
 *
 * The stop shortcut is held with the OS only while computer use is on, and
 * another application may hold the same keys; the row says which, so nobody
 * counts on a shortcut that does nothing.
 *
 * Agents' input goes to a window in the background unless an agent asks to
 * bring it to the front — some applications take keys no other way — which
 * is allowed until the person switches it off; and, while it is allowed,
 * whether that is how every action goes by default. The default shows as
 * Background, and cannot be changed, while the front is switched off; the
 * choice made before is kept for when it is back on.
 *
 * The blocklist is the default entries — credential managers, the system's
 * password prompts, System Settings — less the ones the person took off,
 * plus their own. Every default can be taken off: none is out of an agent's
 * reach for want of a way, only for what it holds, and that is the person's
 * call. "Restore defaults" — once confirmed — takes off everything added
 * and puts back everything removed; like every edit here it is saved with
 * Save.
 *
 * Each field is its own edit. Save sends only the fields this form changed,
 * and another window's save moves every field this form has not touched: a
 * timeout changed here must not carry back a blocklist loaded before another
 * window added to it. Nothing is editable until the stored values have been
 * read — a form showing defaults after a failed read would save them over
 * the real list — or while a save is on its way.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AppWindow,
  ClipboardList,
  Keyboard,
  Layers,
  Monitor,
  MousePointerClick,
  PanelTop,
  Plus,
  RotateCcw,
  RotateCw,
  ScreenShare,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { useIsMac } from "@/hooks/use-is-mac"
import { usePlatform } from "@/hooks/use-platform"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import {
  computerServerPlatform,
  getComputerToolsSettings,
  setComputerToolsPreferences,
  useComputerAvailable,
} from "@/lib/computer/computer-api"
import {
  defaultStopShortcut,
  spellStopShortcut,
  stopShortcutFromEvent,
  stopShortcutLabel,
  stopShortcutProblem,
  type StopShortcutProblem,
} from "@/lib/computer/stop-shortcut"
import {
  COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
  type ComputerDelivery,
  type ComputerToolsSettings,
  type DefaultBlock,
} from "@/lib/computer/types"
import { useComputerStopKey } from "@/lib/computer/use-stop-key"
import { setShortcutRecorderArmed } from "@/lib/keyboard-shortcuts"
import { isLocalDesktop, subscribe } from "@/lib/platform"

/** The choices offered, in minutes; 0 is "until I take it back". */
const TTL_CHOICES = [10, 30, 60, 240, 0] as const

interface Values {
  ttl: number
  /** The person's own entries, in the order added. */
  blocklist: string[]
  /** Keys of the default entries taken off the list. */
  removed: string[]
  /** Spelled as `stop-shortcut.ts` spells it; empty is off. */
  stopShortcut: string
  showIndicator: boolean
  allowForeground: boolean
  /** As chosen — in force only while `allowForeground` is on. */
  defaultDelivery: ComputerDelivery
  launchEnabled: boolean
  clipboardEnabled: boolean
  screenEnabled: boolean
}

const EMPTY: Values = {
  ttl: 30,
  blocklist: [],
  removed: [],
  stopShortcut: "",
  showIndicator: true,
  allowForeground: true,
  defaultDelivery: "background",
  launchEnabled: false,
  clipboardEnabled: false,
  screenEnabled: false,
}

function fromSettings(settings: ComputerToolsSettings): Values {
  return {
    ttl: settings.grantTtlMinutes,
    blocklist: settings.blocklist,
    removed: settings.blocklistRemoved,
    stopShortcut: settings.stopShortcut,
    showIndicator: settings.showIndicator,
    allowForeground: settings.allowForeground,
    defaultDelivery: settings.defaultDelivery,
    launchEnabled: settings.launchEnabled ?? false,
    clipboardEnabled: settings.clipboardEnabled ?? false,
    screenEnabled: settings.screenEnabled ?? false,
  }
}

function ttlDirty(values: Values, baseline: Values): boolean {
  return values.ttl !== baseline.ttl
}

function blocklistDirty(values: Values, baseline: Values): boolean {
  return values.blocklist.join("\n") !== baseline.blocklist.join("\n")
}

function removedDirty(values: Values, baseline: Values): boolean {
  return (
    [...values.removed].sort().join("\n") !==
    [...baseline.removed].sort().join("\n")
  )
}

function stopShortcutDirty(values: Values, baseline: Values): boolean {
  return values.stopShortcut !== baseline.stopShortcut
}

function showIndicatorDirty(values: Values, baseline: Values): boolean {
  return values.showIndicator !== baseline.showIndicator
}

function allowForegroundDirty(values: Values, baseline: Values): boolean {
  return values.allowForeground !== baseline.allowForeground
}

function launchEnabledDirty(values: Values, baseline: Values): boolean {
  return values.launchEnabled !== baseline.launchEnabled
}

function clipboardEnabledDirty(values: Values, baseline: Values): boolean {
  return values.clipboardEnabled !== baseline.clipboardEnabled
}

function screenEnabledDirty(values: Values, baseline: Values): boolean {
  return values.screenEnabled !== baseline.screenEnabled
}

function defaultDeliveryDirty(values: Values, baseline: Values): boolean {
  return values.defaultDelivery !== baseline.defaultDelivery
}

export function ComputerSettingsSection() {
  const t = useTranslations("ComputerUse.settings")
  const tComputer = useTranslations("ComputerUse")
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [values, setValues] = useState<Values>(EMPTY)
  const [baseline, setBaseline] = useState<Values>(EMPTY)
  /** Whether computer use is on: the stop shortcut is held only then. */
  const [enabled, setEnabled] = useState(false)
  /** The default blocklist as this platform names it. */
  const [defaults, setDefaults] = useState<DefaultBlock[]>([])
  // Read by the subscription below, which is set up once.
  const valuesRef = useRef(values)
  const baselineRef = useRef(baseline)
  useEffect(() => {
    valuesRef.current = values
    baselineRef.current = baseline
  }, [values, baseline])
  /** Bumped by every broadcast: a read or a save that started before one is
   *  older than it. */
  const remoteGenRef = useRef(0)
  /** The record as the last broadcast carried it. */
  const remoteRef = useRef<Values | null>(null)

  /** Take in a read that started at broadcast `gen`: unless a broadcast has
   *  landed since (it already set the fields, and is newer), the read is what
   *  is stored. */
  const applyRead = useCallback(
    (settings: ComputerToolsSettings, gen: number) => {
      if (remoteGenRef.current === gen) {
        setValues(fromSettings(settings))
        setBaseline(fromSettings(settings))
        setEnabled(settings.enabled)
      }
      setDefaults(settings.blocklistDefaults)
      setLoaded(true)
      setLoadError(null)
    },
    []
  )

  const load = useCallback(async () => {
    setLoading(true)
    const gen = remoteGenRef.current
    try {
      applyRead(await getComputerToolsSettings(), gen)
    } catch (e) {
      setLoadError(toErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [applyRead])

  useEffect(() => {
    let cancelled = false
    const gen = remoteGenRef.current
    getComputerToolsSettings()
      .then((settings) => {
        if (!cancelled) applyRead(settings, gen)
      })
      .catch((e) => {
        if (!cancelled) setLoadError(toErrorMessage(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyRead])

  // Another window saved the record: every field this form has not touched
  // follows it; a touched one keeps its edit (only its baseline moves, so it
  // stays dirty and still wins on save).
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<ComputerToolsSettings>(
      COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
      (remote) => {
        remoteGenRef.current += 1
        const next = fromSettings(remote)
        remoteRef.current = next
        const current = valuesRef.current
        const base = baselineRef.current
        setValues((prev) => ({
          ttl: ttlDirty(current, base) ? prev.ttl : next.ttl,
          blocklist: blocklistDirty(current, base)
            ? prev.blocklist
            : next.blocklist,
          removed: removedDirty(current, base) ? prev.removed : next.removed,
          stopShortcut: stopShortcutDirty(current, base)
            ? prev.stopShortcut
            : next.stopShortcut,
          showIndicator: showIndicatorDirty(current, base)
            ? prev.showIndicator
            : next.showIndicator,
          allowForeground: allowForegroundDirty(current, base)
            ? prev.allowForeground
            : next.allowForeground,
          defaultDelivery: defaultDeliveryDirty(current, base)
            ? prev.defaultDelivery
            : next.defaultDelivery,
          launchEnabled: launchEnabledDirty(current, base)
            ? prev.launchEnabled
            : next.launchEnabled,
          clipboardEnabled: clipboardEnabledDirty(current, base)
            ? prev.clipboardEnabled
            : next.clipboardEnabled,
          screenEnabled: screenEnabledDirty(current, base)
            ? prev.screenEnabled
            : next.screenEnabled,
        }))
        setBaseline(next)
        setEnabled(remote.enabled)
        setDefaults(remote.blocklistDefaults)
        setLoaded(true)
        setLoadError(null)
      }
    )
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  const dirtyTtl = ttlDirty(values, baseline)
  const dirtyBlocklist = blocklistDirty(values, baseline)
  const dirtyRemoved = removedDirty(values, baseline)
  const dirtyStopShortcut = stopShortcutDirty(values, baseline)
  const dirtyShowIndicator = showIndicatorDirty(values, baseline)
  const dirtyAllowForeground = allowForegroundDirty(values, baseline)
  const dirtyDefaultDelivery = defaultDeliveryDirty(values, baseline)
  const dirtyLaunchEnabled = launchEnabledDirty(values, baseline)
  const dirtyClipboardEnabled = clipboardEnabledDirty(values, baseline)
  const dirtyScreenEnabled = screenEnabledDirty(values, baseline)
  const dirty =
    dirtyTtl ||
    dirtyBlocklist ||
    dirtyRemoved ||
    dirtyStopShortcut ||
    dirtyShowIndicator ||
    dirtyAllowForeground ||
    dirtyDefaultDelivery ||
    dirtyLaunchEnabled ||
    dirtyClipboardEnabled ||
    dirtyScreenEnabled
  const editable = loaded && !saving
  // Computer use itself, here: the desktop app's, or a server's that shares
  // the screen it runs on. The stop shortcut and the strip are the desktop
  // app's alone — a server has neither, its Stop is in this panel.
  const available = useComputerAvailable()
  const desktopHere = isLocalDesktop()
  // The entire screen is offered on macOS and Windows: Linux has no one list
  // of every window on it to judge them by. The machine is the server's,
  // where a server shares its screen — not the one this page shows on.
  const { isLinux: localLinux } = usePlatform()
  const isLinux = desktopHere
    ? localLinux
    : computerServerPlatform() === "linux"

  const save = useCallback(async () => {
    setSaving(true)
    const gen = remoteGenRef.current
    try {
      const applied = await setComputerToolsPreferences({
        grantTtlMinutes: dirtyTtl ? values.ttl : undefined,
        blocklist: dirtyBlocklist ? values.blocklist : undefined,
        blocklistRemoved: dirtyRemoved ? values.removed : undefined,
        stopShortcut: dirtyStopShortcut ? values.stopShortcut : undefined,
        showIndicator: dirtyShowIndicator ? values.showIndicator : undefined,
        allowForeground: dirtyAllowForeground
          ? values.allowForeground
          : undefined,
        defaultDelivery: dirtyDefaultDelivery
          ? values.defaultDelivery
          : undefined,
        launchEnabled: dirtyLaunchEnabled ? values.launchEnabled : undefined,
        clipboardEnabled: dirtyClipboardEnabled
          ? values.clipboardEnabled
          : undefined,
        screenEnabled: dirtyScreenEnabled ? values.screenEnabled : undefined,
      })
      // The save's own broadcast, or another window's after it, may have
      // landed first; the last broadcast is then the newest record there is.
      const latest =
        remoteGenRef.current !== gen && remoteRef.current
          ? remoteRef.current
          : fromSettings(applied)
      setValues(latest)
      setBaseline(latest)
      toast.success(t("saved"))
    } catch (e) {
      toast.error(t("saveFailed"), { description: toErrorMessage(e) })
    } finally {
      setSaving(false)
    }
  }, [
    values,
    dirtyTtl,
    dirtyBlocklist,
    dirtyRemoved,
    dirtyStopShortcut,
    dirtyShowIndicator,
    dirtyAllowForeground,
    dirtyDefaultDelivery,
    dirtyLaunchEnabled,
    dirtyClipboardEnabled,
    dirtyScreenEnabled,
    t,
  ])

  return (
    <SettingsSection
      icon={AppWindow}
      title={t("title")}
      description={t("description")}
    >
      {loadError && (
        <SettingsError>
          <span className="flex flex-wrap items-center gap-2">
            {t("loadFailed", { detail: loadError })}
            {!loaded && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void load()}
                disabled={loading}
              >
                <RotateCw className="size-3" />
                {tComputer("refresh")}
              </Button>
            )}
          </span>
        </SettingsError>
      )}

      <SettingCard>
        <SettingRow
          title={t("ttl.label")}
          description={t("ttl.hint")}
          htmlFor="computer-grant-ttl"
          control={
            <Select
              value={String(values.ttl)}
              onValueChange={(v) =>
                setValues((prev) => ({ ...prev, ttl: Number(v) }))
              }
              disabled={!editable}
            >
              <SelectTrigger id="computer-grant-ttl" size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TTL_CHOICES.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {minutes === 0
                      ? t("ttl.never")
                      : t("ttl.minutes", { minutes })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <BlocklistRow
          defaults={defaults}
          blocklist={values.blocklist}
          removed={values.removed}
          disabled={!editable}
          onChange={(blocklist, removed) =>
            setValues((prev) => ({ ...prev, blocklist, removed }))
          }
        />
        {desktopHere && (
          <StopShortcutRow
            value={loaded ? values.stopShortcut : null}
            saved={loaded && !dirtyStopShortcut ? baseline.stopShortcut : null}
            enabled={enabled}
            disabled={!editable}
            onChange={(stopShortcut) =>
              setValues((prev) => ({ ...prev, stopShortcut }))
            }
          />
        )}
        {desktopHere && (
          <SettingRow
            icon={PanelTop}
            title={t("strip.label")}
            description={t("strip.hint")}
            htmlFor="computer-show-indicator"
            control={
              <Switch
                id="computer-show-indicator"
                checked={values.showIndicator}
                onCheckedChange={(showIndicator) =>
                  setValues((prev) => ({ ...prev, showIndicator }))
                }
                disabled={!editable}
              />
            }
          />
        )}
      </SettingCard>

      {available && (
        <SettingCard>
          <SettingRow
            icon={Layers}
            title={t("foreground.label")}
            description={t("foreground.hint")}
            htmlFor="computer-allow-foreground"
            control={
              <Switch
                id="computer-allow-foreground"
                checked={values.allowForeground}
                onCheckedChange={(allowForeground) =>
                  setValues((prev) => ({ ...prev, allowForeground }))
                }
                disabled={!editable}
              />
            }
          />
          <SettingRow
            icon={MousePointerClick}
            title={t("delivery.label")}
            description={
              values.allowForeground
                ? t("delivery.hint")
                : t("delivery.hintOff")
            }
            htmlFor="computer-default-delivery"
            control={
              <Select
                // Background, whatever was chosen, while the front is not
                // allowed: that is what an action gets then.
                value={
                  values.allowForeground ? values.defaultDelivery : "background"
                }
                onValueChange={(v) =>
                  setValues((prev) => ({
                    ...prev,
                    defaultDelivery:
                      v === "foreground" ? "foreground" : "background",
                  }))
                }
                disabled={!editable || !values.allowForeground}
              >
                <SelectTrigger
                  id="computer-default-delivery"
                  size="sm"
                  className="w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="background">
                    {t("delivery.background")}
                  </SelectItem>
                  <SelectItem value="foreground">
                    {t("delivery.foreground")}
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </SettingCard>
      )}

      {available && (
        <SettingCard>
          <SettingRow
            icon={AppWindow}
            title={t("launch.label")}
            description={t("launch.hint")}
            htmlFor="computer-launch-enabled"
            control={
              <Switch
                id="computer-launch-enabled"
                checked={values.launchEnabled}
                onCheckedChange={(launchEnabled) =>
                  setValues((prev) => ({ ...prev, launchEnabled }))
                }
                disabled={!editable}
              />
            }
          />
          <SettingRow
            icon={ClipboardList}
            title={t("clipboard.label")}
            description={t("clipboard.hint")}
            htmlFor="computer-clipboard-enabled"
            control={
              <Switch
                id="computer-clipboard-enabled"
                checked={values.clipboardEnabled}
                onCheckedChange={(clipboardEnabled) =>
                  setValues((prev) => ({ ...prev, clipboardEnabled }))
                }
                disabled={!editable}
              />
            }
          />
          {!isLinux && (
            <SettingRow
              icon={ScreenShare}
              title={t("screen.label")}
              description={t("screen.hint")}
              htmlFor="computer-screen-enabled"
              control={
                <Switch
                  id="computer-screen-enabled"
                  checked={values.screenEnabled}
                  onCheckedChange={(screenEnabled) =>
                    setValues((prev) => ({ ...prev, screenEnabled }))
                  }
                  disabled={!editable}
                />
              }
            />
          )}
        </SettingCard>
      )}

      <SettingNote icon={Monitor}>{t("boundary")}</SettingNote>

      <SettingsSaveBar
        onSave={() => void save()}
        saving={saving}
        disabled={!editable || !dirty}
        label={t("save")}
        savingLabel={t("saving")}
      />
    </SettingsSection>
  )
}

/** The default entries named by the interface — the system's own — by key. */
const SYSTEM_ENTRY_NAMES = {
  "system-settings": "blocklist.items.systemSettings",
  "credential-prompts": "blocklist.items.credentialPrompts",
  keychain: "blocklist.items.keychain",
  passwords: "blocklist.items.passwords",
} as const

/**
 * The never-share list: the default entries not taken off, each with a
 * remove button, then the person's own, then a field to add one. Typing a
 * default that was taken off puts it back. "Restore defaults" asks first,
 * saying what it would take off and put back: the person's own entries go
 * with it.
 */
function BlocklistRow({
  defaults,
  blocklist,
  removed,
  disabled,
  onChange,
}: {
  defaults: readonly DefaultBlock[]
  blocklist: readonly string[]
  removed: readonly string[]
  disabled: boolean
  onChange: (blocklist: string[], removed: string[]) => void
}) {
  const t = useTranslations("ComputerUse.settings")
  const [draft, setDraft] = useState("")
  const [duplicate, setDuplicate] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const shown = defaults.filter((entry) => !removed.includes(entry.key))
  const removedCount = defaults.length - shown.length
  const atDefaults = blocklist.length === 0 && removedCount === 0

  const nameOf = (entry: DefaultBlock) =>
    entry.key in SYSTEM_ENTRY_NAMES
      ? t(SYSTEM_ENTRY_NAMES[entry.key as keyof typeof SYSTEM_ENTRY_NAMES])
      : entry.name

  const add = () => {
    const entry = draft.trim()
    if (!entry) return
    const lower = entry.toLowerCase()
    // By any name it goes by: its identifiers, or the name the list shows.
    const known = defaults.find(
      (d) =>
        d.names.some((name) => name.toLowerCase() === lower) ||
        d.name.toLowerCase() === lower ||
        nameOf(d).toLowerCase() === lower
    )
    if (known && removed.includes(known.key)) {
      onChange(
        [...blocklist],
        removed.filter((key) => key !== known.key)
      )
      setDraft("")
      return
    }
    if (known || blocklist.some((e) => e.toLowerCase() === lower)) {
      setDuplicate(true)
      return
    }
    onChange([...blocklist, entry], [...removed])
    setDraft("")
  }

  // The dialog's root holds the whole row: the button that opens it is its
  // trigger, which is where the focus goes back to when it closes.
  return (
    <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
      <SettingRow
        title={t("blocklist.label")}
        description={t("blocklist.hint")}
        htmlFor="computer-blocklist"
        control={
          <AlertDialogTrigger asChild>
            <Button size="xs" variant="ghost" disabled={disabled || atDefaults}>
              <RotateCcw className="size-3" />
              {t("blocklist.restore")}
            </Button>
          </AlertDialogTrigger>
        }
      >
        <div className="space-y-2">
          <ul className="divide-y overflow-hidden rounded-lg border">
            {shown.map((entry) => (
              <li
                key={entry.key}
                className="flex items-center justify-between gap-3 px-3 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    {nameOf(entry)}
                  </span>
                  <span
                    className="block truncate font-mono text-2xs text-muted-foreground"
                    title={entry.names.join("\n")}
                  >
                    {entry.names.join(" · ")}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  disabled={disabled}
                  title={t("blocklist.remove", { name: nameOf(entry) })}
                  aria-label={t("blocklist.remove", { name: nameOf(entry) })}
                  onClick={() =>
                    onChange([...blocklist], [...removed, entry.key])
                  }
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
            {blocklist.map((entry) => (
              <li
                key={entry}
                className="flex items-center justify-between gap-3 px-3 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs">
                    {entry}
                  </span>
                  <span className="block truncate text-2xs text-muted-foreground">
                    {t("blocklist.custom")}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  disabled={disabled}
                  title={t("blocklist.remove", { name: entry })}
                  aria-label={t("blocklist.remove", { name: entry })}
                  onClick={() =>
                    onChange(
                      blocklist.filter((e) => e !== entry),
                      [...removed]
                    )
                  }
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <Input
              id="computer-blocklist"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setDuplicate(false)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  add()
                }
              }}
              placeholder={t("blocklist.placeholder")}
              disabled={disabled}
              className="h-8 font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={add}
              disabled={disabled || !draft.trim()}
            >
              <Plus className="size-3.5" />
              {t("blocklist.add")}
            </Button>
          </div>
          {duplicate && (
            <p className="text-xs text-destructive">
              {t("blocklist.duplicate")}
            </p>
          )}
          {removedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("blocklist.removedCount", { count: removedCount })}
            </p>
          )}
        </div>

        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("blocklist.restoreConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {blocklist.length > 0 && (
                <span className="block">
                  {t("blocklist.restoreConfirmAdded", {
                    count: blocklist.length,
                  })}
                </span>
              )}
              {removedCount > 0 && (
                <span className="block">
                  {t("blocklist.restoreConfirmRemoved", {
                    count: removedCount,
                  })}
                </span>
              )}
              <span className="block">{t("blocklist.restoreConfirmSave")}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("blocklist.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={disabled}
              onClick={() => {
                onChange([], [])
                setDuplicate(false)
              }}
            >
              {t("blocklist.restore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </SettingRow>
    </AlertDialog>
  )
}

/**
 * The stop shortcut: the keys as they stand, a button to record new ones
 * (Escape alone cancels), the default back, or none — and, once saved,
 * whether the OS actually holds them. Recording ends when the row is locked
 * (a save on its way would overwrite what it caught), and nothing is said of
 * a shortcut the form has not read yet.
 */
function StopShortcutRow({
  value,
  saved,
  enabled,
  disabled,
  onChange,
}: {
  /** The shortcut in the form, or null until the stored one has been read. */
  value: string | null
  /** The shortcut as stored, or null while unread or edited. */
  saved: string | null
  enabled: boolean
  disabled: boolean
  onChange: (value: string) => void
}) {
  const t = useTranslations("ComputerUse.settings.stopKey")
  const isMac = useIsMac()
  const status = useComputerStopKey()
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState<StopShortcutProblem | null>(null)
  const [wasDisabled, setWasDisabled] = useState(disabled)
  const fallback = defaultStopShortcut(isMac)

  // Locked — a save is on its way, or nothing is read yet: stop listening.
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled)
    if (disabled) {
      setRecording(false)
      setProblem(null)
    }
  }

  useEffect(() => {
    if (!recording) return
    setShortcutRecorderArmed(true)
    const onKeyDown = (event: KeyboardEvent) => {
      // Held keys too: a repeat must not reach the focused button.
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (event.repeat) return
      const parts = stopShortcutFromEvent(event)
      if (!parts) return
      const bare = !(parts.control || parts.alt || parts.shift || parts.command)
      if (bare && parts.code === "Escape") {
        setRecording(false)
        setProblem(null)
        return
      }
      const why = stopShortcutProblem(parts, isMac)
      if (why) {
        setProblem(why)
        return
      }
      setProblem(null)
      setRecording(false)
      onChange(spellStopShortcut(parts))
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      setShortcutRecorderArmed(false)
    }
  }, [recording, isMac, onChange])

  let note: React.ReactNode = null
  if (recording) {
    note = problem
      ? t(`problem.${problem}`)
      : t(isMac ? "recordHintMac" : "recordHint")
  } else if (saved !== null) {
    if (saved === "") note = t("statusOff")
    else if (!enabled) note = t("statusIdle")
    else if (status?.active === saved) note = t("statusActive")
    else if (status?.failed === saved) note = t("statusFailed")
  }

  return (
    <SettingRow
      icon={Keyboard}
      title={t("label")}
      description={t("hint")}
      control={
        <div className="flex items-center gap-1">
          {!recording && value !== null && value !== fallback && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onChange(fallback)}
              disabled={disabled}
            >
              {t("useDefault")}
            </Button>
          )}
          {!recording && value !== null && value !== "" && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onChange("")}
              disabled={disabled}
            >
              {t("turnOff")}
            </Button>
          )}
          <Button
            size="sm"
            variant={recording ? "secondary" : "outline"}
            className="min-w-28 font-mono"
            aria-pressed={recording}
            onClick={() => {
              setProblem(null)
              setRecording((r) => !r)
            }}
            disabled={disabled}
          >
            {recording
              ? t("recording")
              : value === null
                ? "…"
                : value
                  ? stopShortcutLabel(value, isMac)
                  : t("off")}
          </Button>
        </div>
      }
    >
      {note && (
        <p
          className={
            problem || (!recording && status?.failed === saved && saved)
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
          title={
            !recording && status?.failed === saved ? status?.detail : undefined
          }
        >
          {note}
        </p>
      )}
    </SettingRow>
  )
}
