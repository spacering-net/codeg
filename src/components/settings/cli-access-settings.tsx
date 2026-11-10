"use client"

import { useCallback, useEffect, useState } from "react"
import { Terminal } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  getCliAccessStatus,
  getCliToolStatus,
  installCliTool,
  setCliAccessEnabled,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"
import type { CliAccessStatus, CliToolStatus } from "@/lib/types"

/** A command to copy as it stands (see `docs/cli.md`). */
export const CLI_ACCESS_EXAMPLE =
  'codeg-cli -a claude_code -p "Review the latest commit"'

/**
 * "Allow command-line access": whether this runtime listens for the
 * `codeg-cli` command of its own machine. On by default; switching it off
 * unpublishes the endpoint file and stops listening at once.
 */
export function CliAccessSettings() {
  const t = useTranslations("SystemSettings")
  const [status, setStatus] = useState<CliAccessStatus | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    getCliAccessStatus()
      .then((next) => {
        if (alive) setStatus(next)
      })
      .catch(() => {
        // An older runtime without the setting: show nothing.
        if (alive) setStatus(null)
      })
    return () => {
      alive = false
    }
  }, [])

  const toggle = useCallback(
    async (enabled: boolean) => {
      setSaving(true)
      try {
        setStatus(await setCliAccessEnabled(enabled))
      } catch (err) {
        toast.error(t("cliAccessSaveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  if (!status) return null

  return (
    <SettingsSection
      icon={Terminal}
      title={t("cliAccessTitle")}
      description={t("cliAccessDescription")}
      htmlFor="cli-access"
      control={
        <Switch
          id="cli-access"
          checked={status.enabled}
          disabled={saving}
          onCheckedChange={(next) => void toggle(next)}
        />
      }
    >
      {status.enabled && status.error && (
        <p className="text-2xs text-amber-500">
          {t("cliAccessUnavailable", { message: status.error })}
        </p>
      )}
      {status.enabled && status.running && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {t("cliAccessEndpointFile")}{" "}
            <code className="break-all">{status.endpointFile}</code>
          </p>
          <p>
            {t("cliAccessExample")}{" "}
            <code className="break-all">{CLI_ACCESS_EXAMPLE}</code>
          </p>
        </div>
      )}
      {!status.enabled && (
        <p className="text-2xs text-muted-foreground">{t("cliAccessOff")}</p>
      )}
      {isDesktop() && !isRemoteDesktopMode() && <CliToolInstall />}
    </SettingsSection>
  )
}

/**
 * "Install command-line tool": this app's `codeg-cli` on the user's PATH —
 * a link on macOS (and for an AppImage), the installer's `bin` folder on the
 * user's PATH on Windows; nothing to do for a Linux package. A `codeg-cli`
 * already there that is not the app's is left alone.
 */
export function CliToolInstall() {
  const t = useTranslations("SystemSettings")
  const [tool, setTool] = useState<CliToolStatus | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    let alive = true
    getCliToolStatus()
      .then((next) => {
        if (alive) setTool(next)
      })
      .catch(() => {
        if (alive) setTool(null)
      })
    return () => {
      alive = false
    }
  }, [])

  const install = useCallback(async () => {
    setInstalling(true)
    try {
      const next = await installCliTool()
      setTool(next)
      if (next.installed) {
        toast.success(t("cliToolInstalledToast", { command: next.command }))
      }
    } catch (err) {
      toast.error(t("cliToolInstallFailed", { message: toErrorMessage(err) }))
    } finally {
      setInstalling(false)
    }
  }, [t])

  if (!tool || tool.method === "none") return null
  const location = tool.location ?? ""

  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {tool.installed ? (
        <p>
          {tool.method === "package"
            ? t("cliToolPackage", { command: tool.command })
            : t("cliToolInstalled", { command: tool.command })}{" "}
          <code className="break-all">{location}</code>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t("cliToolNotInstalled", { command: tool.command })}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={installing || Boolean(tool.conflict)}
            onClick={() => void install()}
          >
            {t("cliToolInstall")}
          </Button>
        </div>
      )}
      {tool.conflict && (
        <p className="text-2xs text-amber-500">
          {t("cliToolConflict", { message: tool.conflict })}
        </p>
      )}
      {tool.note && (
        <p className="text-2xs">{t("cliToolNote", { message: tool.note })}</p>
      )}
    </div>
  )
}
