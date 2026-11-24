"use client"

/**
 * An assistant's own notifications (13.5 "This assistant → Notifications",
 * 4.14, 10.10): whether it notifies the owner when it is done or waits for
 * them, muted (no system notifications; it still counts as unread), hidden
 * (runs as ever, never notifies, off the roster — a work assistant's
 * only). The same switches as the roster's menu and the details' "Notify
 * me": what changes here is the roster's.
 */

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Bell, BellOff, EyeOff } from "lucide-react"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Switch } from "@/components/ui/switch"
import { personalAgentRosterAct } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PersonalAgentInfo, RosterAct } from "@/lib/types"
import {
  usePersonalAgentRoster,
  useRoster,
} from "@/stores/personal-agent-roster-store"

export function NotifyPage({
  agent,
  disabled,
}: {
  agent: PersonalAgentInfo
  disabled: boolean
}) {
  const tn = useTranslations("PersonalAgent.settings.notifyPage")
  useRoster()
  const entry = usePersonalAgentRoster((s) =>
    s.entries?.find((e) => e.id === agent.id)
  )
  const flags = entry?.roster
  const worker = agent.kind === "worker"
  const act = (a: RosterAct) => {
    void personalAgentRosterAct(agent.id, a).catch((e) =>
      toast.error(toErrorMessage(e))
    )
  }
  const off = disabled || !flags
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="notify">
      <SettingCard>
        <SettingRow
          icon={Bell}
          title={tn("notify")}
          description={tn("notifyHint")}
          htmlFor="pa-notify-notify"
          control={
            <Switch
              id="pa-notify-notify"
              data-pa-notify="notify"
              checked={flags?.notify ?? true}
              disabled={off}
              onCheckedChange={(on) => act({ act: "notify", on })}
            />
          }
        />
        <SettingRow
          icon={BellOff}
          title={tn("muted")}
          description={tn("mutedHint")}
          htmlFor="pa-notify-muted"
          control={
            <Switch
              id="pa-notify-muted"
              data-pa-notify="muted"
              checked={flags?.muted ?? false}
              disabled={off}
              onCheckedChange={(on) => act({ act: on ? "mute" : "unmute" })}
            />
          }
        />
        {worker ? (
          <SettingRow
            icon={EyeOff}
            title={tn("hidden")}
            description={tn("hiddenHint")}
            htmlFor="pa-notify-hidden"
            control={
              <Switch
                id="pa-notify-hidden"
                data-pa-notify="hidden"
                checked={flags?.hidden ?? false}
                disabled={off}
                onCheckedChange={(on) => act({ act: on ? "hide" : "show" })}
              />
            }
          />
        ) : null}
      </SettingCard>
    </div>
  )
}
