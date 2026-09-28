"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Cpu,
  FolderCog,
  Loader2,
  Palette,
  RefreshCw,
  SquareTerminal,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSection,
} from "@/components/shared/settings-section"
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
  getAvailableTerminalShells,
  getSystemRenderingSettings,
  getSystemTerminalSettings,
  probeTerminalShellPath,
  updateSystemRenderingSettings,
  updateSystemTerminalSettings,
} from "@/lib/api"
import { isDesktop } from "@/lib/platform"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import type { AvailableTerminalShells, TerminalShellOption } from "@/lib/types"
import { usePlatform } from "@/hooks/use-platform"
import { relaunchApp } from "@/lib/updater"
import { toErrorMessage } from "@/lib/app-error"
import { CloseBehaviorSettingsSection } from "@/components/settings/close-behavior-settings"
import { DesktopNotificationSettingsSection } from "@/components/settings/desktop-notification-settings"
import { NotificationSoundSettingsSection } from "@/components/settings/notification-sound-settings"

const TERMINAL_SHELL_OPTION_SYSTEM = "system"
const TERMINAL_SHELL_OPTION_CUSTOM = "custom"

/// Pick which dropdown row matches a stored `default_shell` value:
/// - null  → "system"
/// - matches a predefined option's `value` → that option's id
/// - anything else → "custom" (user-supplied path)
function resolveSelectedShellId(
  storedShell: string | null,
  options: TerminalShellOption[]
): string {
  if (!storedShell) return TERMINAL_SHELL_OPTION_SYSTEM
  const matched = options.find(
    (opt) => opt.value !== null && opt.value === storedShell
  )
  return matched?.id ?? TERMINAL_SHELL_OPTION_CUSTOM
}

// Captured the first time the rendering section loads: represents the value
// the running webview process was launched with. Survives settings-shell
// remounts so the "Restart now" banner doesn't vanish if the user navigates
// away and back without restarting.
let processStartDisableHwAccel: boolean | null = null

export function GeneralSettings() {
  const t = useTranslations("GeneralSettings")
  // Backend-driven shell label keys are dynamic strings, so widen `t`
  // for that single call site rather than casting at every use.
  const tDynamic = t as unknown as (key: string) => string
  const { isWindows, isLinux } = usePlatform()

  // Rendering settings are a local Tauri preference (preferences.json). They
  // are only meaningful when the active transport is the local Tauri shell —
  // remote workspace windows route every API call to a remote web server,
  // which deliberately does not expose this endpoint.
  const renderingSettingsLoadable =
    isDesktop() && getActiveRemoteConnectionId() === null
  // Windows (WebView2) and Linux (WebKitGTK) each expose an env knob the
  // backend can flip at startup. macOS (WKWebView) exposes none, so showing a
  // switch that cannot do anything there would be a lie.
  const renderingSectionVisible =
    renderingSettingsLoadable && (isWindows || isLinux)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [savingTerminal, setSavingTerminal] = useState(false)
  const [availableShells, setAvailableShells] =
    useState<AvailableTerminalShells | null>(null)
  const [selectedShellId, setSelectedShellId] = useState<string>(
    TERMINAL_SHELL_OPTION_SYSTEM
  )
  const [customShellPath, setCustomShellPath] = useState<string>("")
  const [customPathExists, setCustomPathExists] = useState<boolean | null>(null)
  // The last persisted `default_shell`, kept verbatim. Both terminal settings
  // share one stored row, so saving the color toggle has to send the shell
  // back unchanged — and `selectedShellId`/`customShellPath` can't reconstruct
  // it (the custom row is cleared until the user presses Save).
  //
  // Tri-state, and the third state carries weight: `undefined` means the load
  // never landed, which is NOT the same as `null` ("use the system shell").
  // Sending `null` for an unknown shell would persist "system" over whatever
  // the user had chosen, so the color toggle stays inert until this is known.
  const [storedDefaultShell, setStoredDefaultShell] = useState<
    string | null | undefined
  >(undefined)
  const [colorizeCommandOutput, setColorizeCommandOutput] = useState(false)

  const [disableHwAccel, setDisableHwAccel] = useState(false)
  const [savingRendering, setSavingRendering] = useState(false)
  const [persistedDisableHwAccel, setPersistedDisableHwAccel] = useState(false)
  const [processStartLoaded, setProcessStartLoaded] = useState(
    processStartDisableHwAccel !== null
  )
  const renderingDirty =
    processStartLoaded && persistedDisableHwAccel !== processStartDisableHwAccel

  const loadSettings = useCallback(async () => {
    setLoading(true)
    setLoadError(null)

    try {
      const [terminalSettings, terminalShells, renderingSettings] =
        await Promise.all([
          getSystemTerminalSettings(),
          getAvailableTerminalShells(),
          renderingSettingsLoadable
            ? getSystemRenderingSettings()
            : Promise.resolve(null),
        ])

      setAvailableShells(terminalShells)
      setStoredDefaultShell(terminalSettings.default_shell)
      setColorizeCommandOutput(terminalSettings.colorize_command_output)
      const initialId = resolveSelectedShellId(
        terminalSettings.default_shell,
        terminalShells.options
      )
      setSelectedShellId(initialId)
      if (initialId === TERMINAL_SHELL_OPTION_CUSTOM) {
        setCustomShellPath(terminalSettings.default_shell ?? "")
        setCustomPathExists(
          terminalSettings.default_shell
            ? await probeTerminalShellPath(terminalSettings.default_shell)
            : null
        )
      } else {
        setCustomShellPath("")
        setCustomPathExists(null)
      }

      if (renderingSettings) {
        const value = renderingSettings.disable_hardware_acceleration
        setDisableHwAccel(value)
        setPersistedDisableHwAccel(value)
        if (processStartDisableHwAccel === null) {
          processStartDisableHwAccel = value
          setProcessStartLoaded(true)
        }
      }
    } catch (err) {
      const message = toErrorMessage(err)
      setLoadError(message)
      console.error("[Settings] load general settings failed:", err)
    } finally {
      setLoading(false)
    }
  }, [renderingSettingsLoadable])

  useEffect(() => {
    loadSettings().catch((err) => {
      console.error("[Settings] load general settings failed:", err)
    })
  }, [loadSettings])

  /// Resolves to whether the row was actually written, so the caller can put
  /// back whatever it moved ahead of the save.
  const persistTerminalShell = useCallback(
    async (defaultShell: string | null): Promise<boolean> => {
      setSavingTerminal(true)
      try {
        const result = await updateSystemTerminalSettings({
          default_shell: defaultShell,
          // Sent back unchanged — the save replaces the whole stored row, so
          // omitting it would silently reset the color opt-in.
          colorize_command_output: colorizeCommandOutput,
        })
        // Record the persisted shell BEFORE anything else that can throw. The
        // row is already written at this point, so every later failure is
        // cosmetic — except leaving this stale, which would have the color
        // toggle send the superseded shell back and undo the save that just
        // succeeded.
        setStoredDefaultShell(result.default_shell)

        // Everything below only refreshes what is on screen. It is scoped
        // separately because a failure here is NOT a failed save: reporting it
        // as one sends the user to re-save a setting that is already stored.
        try {
          // Re-fetch options to refresh `exists` flags (e.g. user just
          // installed pwsh, or backend filter dropped a cross-platform stale
          // value) and the shell the new selection resolves to.
          const refreshedShells = await getAvailableTerminalShells()
          setAvailableShells(refreshedShells)
          const nextSelectedId = resolveSelectedShellId(
            result.default_shell,
            refreshedShells.options
          )
          setSelectedShellId(nextSelectedId)
          if (nextSelectedId === TERMINAL_SHELL_OPTION_CUSTOM) {
            setCustomShellPath(result.default_shell ?? "")
            setCustomPathExists(
              result.default_shell
                ? await probeTerminalShellPath(result.default_shell)
                : null
            )
          } else {
            setCustomShellPath("")
            setCustomPathExists(null)
          }
        } catch (err) {
          // The stored row is correct and already in effect; only the line
          // under the picker is a revision behind until the page is reopened.
          console.error("[Settings] refresh terminal shells failed:", err)
        }
        return true
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("terminalSaveFailed", { message }))
        return false
      } finally {
        setSavingTerminal(false)
      }
    },
    [colorizeCommandOutput, t]
  )

  // Persist the command-color opt-in, sending the current shell back
  // unchanged. Reverts the switch on failure so it never shows a state the
  // backend rejected.
  const persistColorizeCommandOutput = useCallback(
    async (next: boolean, prev: boolean) => {
      // The switch is disabled in this state; the guard is here too because a
      // save that guessed at `default_shell` would overwrite a setting the
      // user never touched, and that is not something to leave to one prop.
      if (storedDefaultShell === undefined) {
        setColorizeCommandOutput(prev)
        return
      }
      setSavingTerminal(true)
      try {
        const result = await updateSystemTerminalSettings({
          default_shell: storedDefaultShell,
          colorize_command_output: next,
        })
        setColorizeCommandOutput(result.colorize_command_output)
      } catch (err) {
        setColorizeCommandOutput(prev)
        const message = toErrorMessage(err)
        toast.error(t("terminalSaveFailed", { message }))
      } finally {
        setSavingTerminal(false)
      }
    },
    [storedDefaultShell, t]
  )

  const onShellSelectChange = useCallback(
    (nextId: string) => {
      const previousId = selectedShellId
      setSelectedShellId(nextId)
      if (nextId === TERMINAL_SHELL_OPTION_CUSTOM) {
        // Don't persist yet — wait for user to type a path and press Save.
        setCustomShellPath("")
        setCustomPathExists(null)
        return
      }
      const matched = availableShells?.options.find((opt) => opt.id === nextId)
      void persistTerminalShell(matched?.value ?? null).then((saved) => {
        // The row moves ahead of the save so the picker feels immediate; a
        // rejected save has to put it back. Left alone it would name a shell
        // that nothing uses — not the line under it, not a new terminal tab,
        // not an agent's command — while the toast that said so scrolls away.
        if (!saved) setSelectedShellId(previousId)
      })
    },
    [availableShells, persistTerminalShell, selectedShellId]
  )

  const onCustomPathSave = useCallback(() => {
    const trimmed = customShellPath.trim()
    if (!trimmed) return
    void persistTerminalShell(trimmed)
  }, [customShellPath, persistTerminalShell])

  const saveRenderingSettings = useCallback(
    async (next: boolean, prev: boolean) => {
      setSavingRendering(true)
      try {
        const result = await updateSystemRenderingSettings({
          disable_hardware_acceleration: next,
        })
        setDisableHwAccel(result.disable_hardware_acceleration)
        setPersistedDisableHwAccel(result.disable_hardware_acceleration)
      } catch (err) {
        setDisableHwAccel(prev)
        const message = toErrorMessage(err)
        toast.error(t("renderingSaveFailed", { message }))
      } finally {
        setSavingRendering(false)
      }
    },
    [t]
  )

  const restartNow = useCallback(async () => {
    try {
      await relaunchApp()
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("restartFailed", { message }))
    }
  }, [t])

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
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </section>

        {loadError && (
          <SettingsError>
            {t("loadFailed", { message: loadError })}
          </SettingsError>
        )}

        {/* The section is the picker: heading, purpose and control on one line,
            with what the shell currently resolves to under them. A card holding
            a single row would only say the heading back one line lower. */}
        <SettingsSection
          icon={SquareTerminal}
          title={t("terminalTitle")}
          description={
            <>
              {t("terminalDescription")}
              {availableShells ? (
                <span className="mt-1 block">
                  {t("terminalCurrentShell", {
                    path: availableShells.resolved_shell,
                  })}
                </span>
              ) : null}
            </>
          }
          htmlFor="terminal-default-shell"
          control={
            <Select
              value={selectedShellId}
              onValueChange={onShellSelectChange}
              disabled={savingTerminal || !availableShells}
            >
              {/* `size` rather than a bare `h-8`: the trigger's height is
                  gated on `data-size`, which outranks an ungated utility
                  in the class list. */}
              <SelectTrigger
                id="terminal-default-shell"
                size="sm"
                className="w-52 bg-background text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {availableShells?.options.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    <span className="flex items-center gap-2">
                      <span>{tDynamic(opt.label_key)}</span>
                      {!opt.exists && !opt.accepts_custom_path && (
                        <span className="text-3xs text-muted-foreground">
                          ({t("terminalShellNotInstalled")})
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          {selectedShellId === TERMINAL_SHELL_OPTION_CUSTOM && (
            <SettingCard>
              <SettingRow
                icon={FolderCog}
                title={t("terminalShellCustomPath")}
                description={t("terminalShellCustomHint")}
                htmlFor="terminal-custom-shell"
              >
                <div className="flex gap-2">
                  <Input
                    id="terminal-custom-shell"
                    value={customShellPath}
                    onChange={(event) => {
                      setCustomShellPath(event.target.value)
                      setCustomPathExists(null)
                    }}
                    placeholder={t("terminalShellCustomPlaceholder")}
                    disabled={savingTerminal}
                    className="h-8 flex-1 bg-background font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={onCustomPathSave}
                    disabled={savingTerminal || !customShellPath.trim()}
                  >
                    {t("terminalShellCustomSave")}
                  </Button>
                </div>
                {customPathExists === false && customShellPath.trim() && (
                  <p className="text-2xs text-amber-500">
                    {t("terminalShellNotFoundWarning")}
                  </p>
                )}
              </SettingRow>
            </SettingCard>
          )}
        </SettingsSection>

        {/* Titled by the option rather than by "Color": the switch forces color
            ON for every command an agent runs, so the heading has to say what
            it does, not which category it files under. */}
        <SettingsSection
          icon={Palette}
          title={t("colorizeCommandOutput")}
          description={t("colorizeCommandOutputDescription")}
          htmlFor="colorize-command-output"
          control={
            <Switch
              id="colorize-command-output"
              checked={colorizeCommandOutput}
              // Inert until the persisted row has been read: the save replaces
              // the whole row, so toggling on a failed load would write the
              // shell field back as "system" and silently drop the user's
              // choice. The shell picker above is gated the same way.
              disabled={savingTerminal || storedDefaultShell === undefined}
              onCheckedChange={(next) => {
                const prev = colorizeCommandOutput
                setColorizeCommandOutput(next)
                void persistColorizeCommandOutput(next, prev)
              }}
            />
          }
        />

        {renderingSectionVisible && (
          // Titled by the option, not by the category it belongs to: the switch
          // turns acceleration *off*, so labelling it "Rendering" would read as
          // the opposite of what it does.
          <SettingsSection
            icon={Cpu}
            title={t("disableHardwareAcceleration")}
            description={t("renderingDescription")}
            htmlFor="disable-hardware-acceleration"
            control={
              <Switch
                id="disable-hardware-acceleration"
                checked={disableHwAccel}
                disabled={savingRendering}
                onCheckedChange={(next) => {
                  const prev = disableHwAccel
                  setDisableHwAccel(next)
                  void saveRenderingSettings(next, prev)
                }}
              />
            }
          >
            {renderingDirty && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs">
                <span className="min-w-0 text-muted-foreground">
                  {t("restartRequired")}
                </span>
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void restartNow()}
                  disabled={savingRendering}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("restartNow")}
                </Button>
              </div>
            )}
          </SettingsSection>
        )}

        <CloseBehaviorSettingsSection />

        {/* The two halves of "how Codeg gets my attention", adjacent on
            purpose: one leaves the window, one does not. */}
        <DesktopNotificationSettingsSection />

        <NotificationSoundSettingsSection />
      </div>
    </ScrollArea>
  )
}
