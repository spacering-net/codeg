"use client"

/**
 * Taskbar / Dock alert settings — the master switch, and how strongly each
 * event asks the OS to point the user back at the window.
 *
 * Desktop only. A browser tab has no taskbar entry or Dock icon of its own, so
 * on the web the section does not render at all rather than offering a switch
 * that cannot do anything.
 *
 * Shaped like its neighbours (`desktop-notification-settings.tsx`,
 * `notification-sound-settings.tsx`): the master switch is the heading row,
 * the knobs fold away under it, and every change is written straight to
 * localStorage with no Save button.
 *
 * The wording is per platform, because the three platforms do genuinely
 * different things with the same request — a Dock icon that bounces, a
 * taskbar button that flashes and stays lit, an urgency hint whose look the
 * desktop environment decides — and a single sentence covering all three
 * would describe none of them.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ListChecks, PanelBottom } from "lucide-react"

import { useNotifyEventLabel } from "@/components/settings/notify-event-labels"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { usePlatform } from "@/hooks/use-platform"
import { isDesktop } from "@/lib/platform"
import {
  ATTENTION_EVENT_IDS,
  ATTENTION_LEVEL_IDS,
  saveWindowAttentionPrefs,
  useWindowAttentionPrefs,
  type AttentionLevel,
} from "@/lib/window-attention-prefs"

// Literal message keys per id — next-intl only resolves literal keys, so the
// lookup tables keep the rows data-driven without losing key checking.
const LEVEL_LABEL_KEYS = {
  off: "levelOff",
  informational: "levelInformational",
  critical: "levelCritical",
} as const satisfies Record<AttentionLevel, string>

const DESCRIPTION_KEYS = {
  macos: "descriptionMac",
  windows: "descriptionWindows",
  linux: "descriptionLinux",
} as const

const EVENTS_HINT_KEYS = {
  macos: "eventsHintMac",
  windows: "eventsHintWindows",
  linux: "eventsHintLinux",
} as const

export function WindowAttentionSettingsSection() {
  const t = useTranslations("WindowAttentionSettings")
  const eventLabel = useNotifyEventLabel()
  const prefs = useWindowAttentionPrefs()
  // `unknown` until mounted — the static export renders without a browser —
  // so the section, which only exists on desktop anyway, appears after
  // hydration instead of rendering markup the client would disagree with.
  const { platform } = usePlatform()

  // Always folded on arrival, however the master switch is set — same reason
  // as the sections around it: the General tab is a stack of sections, not
  // one long form.
  const [expanded, setExpanded] = useState(false)

  if (platform === "unknown" || !isDesktop()) return null

  return (
    <SettingsSection
      icon={PanelBottom}
      title={t("title")}
      description={t(DESCRIPTION_KEYS[platform])}
      // Only labels the switch while there is nothing to fold; once the
      // heading is the disclosure button the switch names itself instead.
      htmlFor="window-attention-enabled"
      collapsible
      open={expanded}
      onOpenChange={setExpanded}
      control={
        <Switch
          id="window-attention-enabled"
          aria-label={t("title")}
          checked={prefs.enabled}
          onCheckedChange={(enabled) => {
            saveWindowAttentionPrefs({ ...prefs, enabled })
            // Switching it on is a request to see what it does, so unfold in
            // the same gesture. Only here, never on mount.
            if (enabled) setExpanded(true)
          }}
        />
      }
    >
      {prefs.enabled && (
        <SettingCard>
          {/* One setting with many values, so one row whose control is the
              list — the same shape as the per-event lists next door. */}
          <SettingRow
            icon={ListChecks}
            title={t("eventsTitle")}
            description={t(EVENTS_HINT_KEYS[platform])}
          >
            <div className="space-y-1.5">
              {ATTENTION_EVENT_IDS.map((eventId) => {
                const label = eventLabel(eventId)
                return (
                  <div
                    key={eventId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm">{label}</span>
                    <Select
                      value={prefs.levels[eventId]}
                      onValueChange={(value) =>
                        saveWindowAttentionPrefs({
                          ...prefs,
                          levels: {
                            ...prefs.levels,
                            [eventId]: value as AttentionLevel,
                          },
                        })
                      }
                    >
                      {/* `size` rather than a bare `h-8`: the trigger's own
                          height is gated on `data-size`, which outranks an
                          ungated utility in the class list. */}
                      <SelectTrigger
                        size="sm"
                        className="w-40 shrink-0 bg-background text-xs"
                        aria-label={label}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        {ATTENTION_LEVEL_IDS.map((level) => (
                          <SelectItem key={level} value={level}>
                            {t(LEVEL_LABEL_KEYS[level])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )
              })}
            </div>
          </SettingRow>
        </SettingCard>
      )}
    </SettingsSection>
  )
}
