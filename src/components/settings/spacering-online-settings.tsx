"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Globe } from "lucide-react"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import { refreshHarnessStatus } from "@/lib/harness/status"
import { isLocalDesktop } from "@/lib/platform"
import { getShellTransport } from "@/lib/transport"

type OnlineSettings = { enabled: boolean; managed: boolean }

export function SpaceRingOnlineSettings() {
  const t = useTranslations("SpaceRingPrivacy")
  const local = isLocalDesktop()
  const [settings, setSettings] = useState<OnlineSettings | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const version = useRef(0)
  const mounted = useRef(false)

  const read = useCallback(async () => {
    const reading = ++version.current
    try {
      const next = await getShellTransport().call<OnlineSettings>(
        "srn_online_settings"
      )
      if (mounted.current && reading === version.current) {
        setSettings(next)
        setFailed(false)
      }
    } catch {
      if (mounted.current && reading === version.current) setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (!local) return
    mounted.current = true
    let disposed = false
    let off: (() => void) | undefined
    getShellTransport()
      .subscribe("srn://online-settings-changed", () => {
        if (!disposed) void read()
      })
      .then((unsubscribe) => {
        if (disposed) unsubscribe()
        else off = unsubscribe
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) void read()
      })
    return () => {
      disposed = true
      mounted.current = false
      off?.()
    }
  }, [local, read])

  async function save(enabled: boolean) {
    setSaving(true)
    try {
      await getShellTransport().call("srn_set_online_settings", { enabled })
      await Promise.all([read(), refreshHarnessStatus()])
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  if (!local || (!settings && !failed)) return null
  return (
    <SettingsSection
      icon={Globe}
      title={t("title")}
      description={settings?.managed ? t("managed") : t("description")}
      htmlFor="spacering-online-services"
      control={
        failed || !settings ? (
          <Button variant="outline" size="sm" onClick={() => void read()}>
            {t("retry")}
          </Button>
        ) : (
          <Switch
            id="spacering-online-services"
            checked={settings.enabled}
            disabled={settings.managed || saving}
            onCheckedChange={(value) => void save(value)}
          />
        )
      }
    />
  )
}
