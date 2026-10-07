"use client"

/**
 * What the window's close button does — the settings-page half of the feature.
 *
 * Desktop-only, and local-desktop-only: the preference drives a Tauri window
 * callback, so a remote workspace window pointed at a server would be
 * configuring a close button that lives on someone else's machine.
 *
 * `tray_available` comes from the backend rather than being guessed from the
 * user agent. Where the tray is unusable the close button force-exits no matter
 * what is stored, and a picker that silently does nothing is worse than one
 * that is visibly disabled with a reason.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { PanelBottomClose } from "lucide-react"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getSystemCloseBehaviorSettings,
  updateSystemCloseBehaviorSettings,
} from "@/lib/api"
import { isDesktop } from "@/lib/platform"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import { toErrorMessage } from "@/lib/app-error"
import type { CloseWindowBehavior } from "@/lib/types"

const BEHAVIOR_LABEL_KEYS = {
  ask: "behaviorAsk",
  minimize: "behaviorMinimize",
  exit: "behaviorExit",
} as const

const BEHAVIOR_IDS = ["ask", "minimize", "exit"] as const

export function CloseBehaviorSettingsSection() {
  const t = useTranslations("CloseBehaviorSettings")
  const supported = isDesktop() && getActiveRemoteConnectionId() === null

  const [behavior, setBehavior] = useState<CloseWindowBehavior | null>(null)
  const [trayAvailable, setTrayAvailable] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!supported) return
    let cancelled = false

    getSystemCloseBehaviorSettings()
      .then((settings) => {
        if (cancelled) return
        setBehavior(settings.behavior)
        setTrayAvailable(settings.tray_available)
      })
      .catch((err) => {
        console.error("[Settings] load close behavior failed:", err)
      })

    return () => {
      cancelled = true
    }
  }, [supported])

  const save = useCallback(
    async (next: CloseWindowBehavior, prev: CloseWindowBehavior) => {
      setSaving(true)
      try {
        const result = await updateSystemCloseBehaviorSettings(next)
        setBehavior(result.behavior)
        setTrayAvailable(result.tray_available)
      } catch (err) {
        setBehavior(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  // Hidden rather than disabled until the row is known: the picker replaces the
  // whole stored value, so rendering it with a guessed selection invites the
  // user to "confirm" a choice they never made.
  if (!supported || behavior === null) return null

  return (
    <SettingsSection
      icon={PanelBottomClose}
      title={t("title")}
      description={trayAvailable ? t("description") : t("trayUnavailable")}
      htmlFor="close-window-behavior"
      control={
        <Select
          value={behavior}
          disabled={saving || !trayAvailable}
          onValueChange={(next) => {
            const prev = behavior
            const value = next as CloseWindowBehavior
            setBehavior(value)
            void save(value, prev)
          }}
        >
          <SelectTrigger
            id="close-window-behavior"
            size="sm"
            className="w-52 bg-background text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {BEHAVIOR_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {t(BEHAVIOR_LABEL_KEYS[id])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
