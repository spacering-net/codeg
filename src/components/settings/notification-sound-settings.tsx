"use client"

/**
 * Notification-sound settings — pick which agent events play an audible cue,
 * and which tone each one uses.
 *
 * The event rows are the same catalogue as the chat-channel Events tab, and
 * deliberately borrow that tab's labels (`ChatChannelSettings.events.*`) so a
 * user reads the identical trigger names in both places. Only the short names
 * are reused: the channel descriptions talk about what gets pushed off the
 * machine, which does not apply to a local sound.
 *
 * Preferences live in localStorage (see `notification-sound-prefs.ts`), so
 * every change is written immediately — there is no Save button and no
 * failure mode to report, unlike the backend-backed sections around it.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  BellOff,
  ListMusic,
  Play,
  SlidersHorizontal,
  Volume2,
} from "lucide-react"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { previewTone } from "@/lib/notification-sound"
import {
  SOUND_EVENT_IDS,
  SOUND_TONE_IDS,
  saveNotificationSoundPrefs,
  useNotificationSoundPrefs,
  type SoundEventId,
  type SoundToneId,
} from "@/lib/notification-sound-prefs"

// Literal message keys per id — next-intl only resolves literal keys, so the
// lookup tables keep the rows data-driven without losing key checking.
const EVENT_LABEL_KEYS = {
  turn_complete: "turnComplete",
  permission_request: "permissionRequest",
  question_request: "questionRequest",
  error: "error",
  user_prompt_sent: "userPromptSent",
} as const satisfies Record<SoundEventId, string>

const TONE_LABEL_KEYS = {
  none: "toneNone",
  chime: "toneChime",
  ding: "toneDing",
  blip: "toneBlip",
  pop: "tonePop",
  alert: "toneAlert",
  descend: "toneDescend",
} as const satisfies Record<SoundToneId, string>

export function NotificationSoundSettingsSection() {
  const t = useTranslations("NotificationSoundSettings")
  const tEvents = useTranslations("ChatChannelSettings.events")

  // Stored preferences are the only state: the panel renders straight off the
  // shared snapshot, and every write re-renders it through that snapshot — so
  // a write that silently failed (quota, blocked storage) leaves the control
  // showing what is actually stored, not a value nothing kept. Another window
  // (the workspace, or a second settings window) writing the same key lands
  // here the same way.
  const prefs = useNotificationSoundPrefs()

  // Always folded on arrival, however the master switch is set — same reason as
  // the desktop-notification section next door: the General tab is a stack of
  // sections, not one long form.
  const [expanded, setExpanded] = useState(false)

  const setTone = useCallback(
    (eventId: SoundEventId, tone: SoundToneId) => {
      saveNotificationSoundPrefs({
        ...prefs,
        tones: { ...prefs.tones, [eventId]: tone },
      })
      // Play what was just picked, so choosing a tone is how you hear it.
      // (Only unlocks audio in THIS window; the workspace has its own audio
      // context and arms its own gesture — see primeNotificationSoundOutput.)
      previewTone(tone, prefs.volume)
    },
    [prefs]
  )

  const volumePercent = Math.round(prefs.volume * 100)

  return (
    // The master switch is the section's heading row: with sounds off the whole
    // section is that one line, and the knobs it gates appear under it rather
    // than in a card that repeats "Enable notification sounds". With them on
    // the heading also folds those knobs away, and starts folded.
    <SettingsSection
      icon={Volume2}
      title={t("title")}
      description={
        <>
          {t("description")}
          <span className="mt-1 block">{t("enableHint")}</span>
        </>
      }
      // Only labels the switch while there is nothing to fold; once the
      // heading is the disclosure button the switch names itself instead.
      htmlFor="notification-sound-enabled"
      collapsible
      open={expanded}
      onOpenChange={setExpanded}
      control={
        <Switch
          id="notification-sound-enabled"
          aria-label={t("title")}
          checked={prefs.enabled}
          onCheckedChange={(enabled) => {
            saveNotificationSoundPrefs({ ...prefs, enabled })
            // Switching it on is a request to see what it does, so unfold in
            // the same gesture. Only here, never on mount: arriving at the tab
            // is not that request.
            if (enabled) setExpanded(true)
          }}
        />
      }
    >
      {/* The two knobs that shape every cue — one card, because volume and
          "only when unfocused" are meaningless without the switch above. */}
      {prefs.enabled && (
        <SettingCard>
          <SettingRow
            icon={SlidersHorizontal}
            title={t("volume")}
            control={
              <span className="text-xs tabular-nums text-muted-foreground">
                {volumePercent}%
              </span>
            }
          >
            <div className="flex items-center gap-3">
              <Slider
                value={[volumePercent]}
                min={0}
                max={100}
                step={5}
                aria-label={t("volume")}
                onValueChange={([value]) =>
                  saveNotificationSoundPrefs({
                    ...prefs,
                    volume: value / 100,
                  })
                }
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 bg-background"
                onClick={() => previewTone("chime", prefs.volume)}
              >
                <Play className="h-3.5 w-3.5" />
                {t("preview")}
              </Button>
            </div>
          </SettingRow>

          <SettingRow
            icon={BellOff}
            title={t("onlyWhenUnfocused")}
            description={t("onlyWhenUnfocusedHint")}
            htmlFor="notification-sound-unfocused"
            control={
              <Switch
                id="notification-sound-unfocused"
                checked={prefs.onlyWhenUnfocused}
                onCheckedChange={(onlyWhenUnfocused) =>
                  saveNotificationSoundPrefs({ ...prefs, onlyWhenUnfocused })
                }
              />
            }
          />
        </SettingCard>
      )}

      {prefs.enabled && (
        <SettingCard>
          {/* The per-event tones are one setting with many values, so they are
              a single row whose control is the list — not one row per event,
              which would repeat the same explanation five times. */}
          <SettingRow
            icon={ListMusic}
            title={t("eventsTitle")}
            description={t("eventsHint")}
          >
            <div className="space-y-1.5">
              {SOUND_EVENT_IDS.map((eventId) => {
                const tone = prefs.tones[eventId]
                const label = tEvents(EVENT_LABEL_KEYS[eventId])
                return (
                  <div
                    key={eventId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm">{label}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Select
                        value={tone}
                        onValueChange={(value) =>
                          setTone(eventId, value as SoundToneId)
                        }
                      >
                        {/* `size` rather than a bare `h-8`: the trigger's own
                            height is gated on `data-size`, which outranks an
                            ungated utility in the class list. */}
                        <SelectTrigger
                          size="sm"
                          className="w-36 bg-background text-xs"
                          aria-label={label}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end">
                          {SOUND_TONE_IDS.map((toneId) => (
                            <SelectItem key={toneId} value={toneId}>
                              {t(TONE_LABEL_KEYS[toneId])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={tone === "none"}
                        aria-label={t("previewEvent", { event: label })}
                        onClick={() => previewTone(tone, prefs.volume)}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    </div>
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
