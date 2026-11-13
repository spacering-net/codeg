"use client"

/**
 * "About you" (13.5, 1.12): the owner's time zone — every time the
 * assistants read or write is in it — and whether codeg records when they
 * are in codeg, to learn their usual hours. The hours codeg sees are shown,
 * read-only (changing them comes with the profile, 2.11). Each item saves
 * the moment it changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Activity,
  Globe,
  History,
  LayoutGrid,
  MessagesSquare,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"

import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  personalAgentHistoryRebuild,
  personalAgentHistoryStatus,
  personalAgentProfile,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  PersonalAgentAccount,
  PersonalAgentDayHours,
  PersonalAgentHistoryStatus,
  PersonalAgentProfile,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { DEFAULT_PREFS, PageHead } from "./pref-pages"
import { useSettingsPatch } from "./use-settings"

/** One pick in the zone list: `system`, or a zone's name. */
interface ZoneItem {
  value: string
  label: string
}

/** A time of the hours: `HH:MM` (past 24:00 is the next morning's). */
export function hoursClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
    m % 60
  ).padStart(2, "0")}`
}

/** `at` in `zone`, `HH:MM`; empty when the browser does not know it. */
function clockIn(zone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(at)
  } catch {
    return ""
  }
}

function HoursLine({
  kind,
  hours,
}: {
  kind: "workday" | "restday"
  hours: PersonalAgentDayHours
}) {
  const t = useTranslations("PersonalAgent.settings.about")
  const span = t(hours.end >= 1440 ? "spanOvernight" : "span", {
    start: hoursClock(hours.start),
    end: hoursClock(hours.end),
  })
  return (
    <div
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs"
      data-pa-hours={kind}
      data-learned={hours.learned ? "true" : "false"}
    >
      <span className="text-muted-foreground">{t(kind)}</span>
      <span className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-medium tabular-nums",
            !hours.learned && "text-muted-foreground"
          )}
        >
          {span}
        </span>
        <span className="text-muted-foreground">
          {hours.learned
            ? t("learnedFrom", { count: hours.days })
            : t("stillLearning")}
        </span>
      </span>
    </div>
  )
}

export function AboutPage({
  account,
  disabled,
}: {
  account: PersonalAgentAccount
  /** Nothing can change here: the engine runs elsewhere, or the primary
   *  is not set up. */
  disabled: boolean
}) {
  const t = useTranslations("PersonalAgent.settings")
  const ta = useTranslations("PersonalAgent.settings.about")
  const tp = useTranslations("PersonalAgent.settings.prefs")
  const { patch } = useSettingsPatch(null)
  const prefs = account.prefs
  const [profile, setProfile] = useState<PersonalAgentProfile | null>(null)
  const seq = useRef(0)
  const load = useCallback(() => {
    const id = ++seq.current
    personalAgentProfile()
      .then((p) => {
        if (id === seq.current) setProfile(p)
      })
      .catch(() => {})
  }, [])
  // Read again whenever either item changes (here, in another window, or
  // from the conversation).
  useEffect(() => {
    load()
  }, [load, prefs.time_zone, prefs.presence])

  const save = (key: AboutKey, value: string) => {
    void patch([{ key: `prefs.${key}`, value }]).then(() => load())
  }

  const restore = ABOUT_KEYS.filter((k) => prefs[k] !== DEFAULT_PREFS[k]).map(
    (k) => ({ key: `prefs.${k}`, value: DEFAULT_PREFS[k] })
  )

  const systemZone = profile?.system_zone ?? ""
  const systemItem: ZoneItem = useMemo(
    () => ({
      value: "system",
      label: systemZone
        ? ta("followSystemZone", { zone: systemZone })
        : ta("followSystem"),
    }),
    [ta, systemZone]
  )
  const items: ZoneItem[] = useMemo(() => {
    const zones = profile?.zones ?? []
    const list = zones.map((z) => ({ value: z, label: z }))
    // The zone set shows even before the list is read.
    if (
      prefs.time_zone !== "system" &&
      !list.some((i) => i.value === prefs.time_zone)
    ) {
      list.unshift({ value: prefs.time_zone, label: prefs.time_zone })
    }
    return [systemItem, ...list]
  }, [profile?.zones, prefs.time_zone, systemItem])
  const selected = items.find((i) => i.value === prefs.time_zone) ?? systemItem
  const zone =
    profile?.zone ?? (prefs.time_zone !== "system" ? prefs.time_zone : "")
  const now = zone ? clockIn(zone, new Date()) : ""

  const recording = prefs.presence === "on"
  const lastActive =
    profile?.last_active && zone
      ? clockIn(zone, new Date(profile.last_active)) || null
      : null

  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="about">
      <PageHead
        title={t("nav.about")}
        description={t("pages.about")}
        onRestore={() => void patch(restore).then(() => load())}
        restoreDisabled={disabled || restore.length === 0}
      />
      <SettingCard>
        <SettingRow
          icon={Globe}
          title={tp("time_zone.title")}
          description={
            zone && now
              ? `${tp("time_zone.hint")} ${ta("zoneNow", { zone, time: now })}`
              : tp("time_zone.hint")
          }
          control={
            <div data-pa-pref="time_zone" className="w-56">
              <Combobox
                key={prefs.time_zone}
                items={items}
                value={selected}
                disabled={disabled}
                onValueChange={(item: ZoneItem | null) => {
                  if (item && item.value !== prefs.time_zone) {
                    save("time_zone", item.value)
                  }
                }}
                isItemEqualToValue={(a: ZoneItem | null, b: ZoneItem | null) =>
                  (a?.value ?? null) === (b?.value ?? null)
                }
              >
                <ComboboxInput
                  className="h-8 w-56 bg-background text-xs"
                  placeholder={ta("zoneSearch")}
                  aria-label={tp("time_zone.title")}
                  disabled={disabled}
                />
                <ComboboxContent>
                  <ComboboxList>
                    {(item: ZoneItem) => (
                      <ComboboxItem
                        className="text-xs"
                        key={item.value}
                        value={item}
                        data-pa-zone={item.value}
                      >
                        <span className="truncate">{item.label}</span>
                        {item.value === "system" ? (
                          <span className="ms-1 text-muted-foreground">
                            {tp("default")}
                          </span>
                        ) : null}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                  <ComboboxEmpty>{ta("zoneNoMatch")}</ComboboxEmpty>
                </ComboboxContent>
              </Combobox>
            </div>
          }
        />
        <SettingRow
          icon={Activity}
          title={tp("presence.title")}
          description={tp("presence.hint")}
          htmlFor="pa-pref-presence"
          control={
            <Switch
              id="pa-pref-presence"
              data-pa-pref="presence"
              checked={recording}
              disabled={disabled}
              onCheckedChange={(on) => save("presence", on ? "on" : "off")}
            />
          }
        >
          <div className="space-y-1.5 rounded-lg bg-background/60 px-3 py-2">
            <p className="text-xs font-medium">
              {ta("hoursTitle", { days: profile?.learn_days ?? 28 })}
            </p>
            {profile ? (
              <>
                <HoursLine kind="workday" hours={profile.hours.workday} />
                <HoursLine kind="restday" hours={profile.hours.restday} />
              </>
            ) : null}
            {!recording ? (
              <p className="text-xs text-muted-foreground" data-pa-hours-off>
                {ta("recordOff")}
              </p>
            ) : null}
            {profile ? (
              <p
                className="text-xs text-muted-foreground"
                data-pa-present={profile.present ? "true" : "false"}
              >
                {profile.present
                  ? ta("presentNow")
                  : lastActive
                    ? ta("lastActive", { time: lastActive })
                    : ta("notSeen")}
              </p>
            ) : null}
          </div>
        </SettingRow>
      </SettingCard>
      <TimeMachineCard
        sessions={prefs.history_sessions === "on"}
        tasks={prefs.history_tasks === "on"}
        disabled={disabled}
        onSave={save}
      />
      <SettingNote icon={ShieldCheck}>{ta("note")}</SettingNote>
    </div>
  )
}

/** The items of this page. */
type AboutKey = "time_zone" | "presence" | "history_sessions" | "history_tasks"
const ABOUT_KEYS: readonly AboutKey[] = [
  "time_zone",
  "presence",
  "history_sessions",
  "history_tasks",
]

/** While the index is being read, how often it is asked how far. */
const STATUS_EVERY_MS = 2_000

/** What the time machine searches (8.2): the assistants' timelines and
 *  messages always; every conversation and the board's tasks as the owner
 *  chooses — off, they leave the index. How far it is, and [Rebuild]. */
function TimeMachineCard({
  sessions,
  tasks,
  disabled,
  onSave,
}: {
  sessions: boolean
  tasks: boolean
  disabled: boolean
  onSave: (key: AboutKey, value: string) => void
}) {
  const t = useTranslations("PersonalAgent.settings.about.history")
  const tp = useTranslations("PersonalAgent.settings.prefs")
  const [status, setStatus] = useState<PersonalAgentHistoryStatus | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const seq = useRef(0)
  const read = useCallback(() => {
    const id = ++seq.current
    personalAgentHistoryStatus()
      .then((s) => {
        if (id === seq.current) setStatus(s)
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    read()
  }, [read, sessions, tasks])
  // Still reading: asked again until it is through.
  const going =
    status != null &&
    (status.reading ||
      (status.sessions_on && status.sessions_done < status.sessions_total))
  useEffect(() => {
    if (!going) return
    const timer = window.setInterval(read, STATUS_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [going, read])

  const rebuild = () => {
    setRebuilding(true)
    personalAgentHistoryRebuild()
      .then((s) => {
        setStatus(s)
        toast.message(t("rebuilt"))
      })
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => {
        setRebuilding(false)
        read()
      })
  }

  return (
    <SettingCard>
      <SettingRow
        icon={History}
        title={t("title")}
        description={t("hint")}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || rebuilding}
            onClick={rebuild}
            data-pa-history-rebuild
          >
            {t("rebuild")}
          </Button>
        }
      >
        {status ? (
          <p
            className="text-xs text-muted-foreground"
            data-pa-history-status={going ? "reading" : "ready"}
          >
            {status.sessions_on
              ? t(going ? "reading" : "ready", {
                  done: status.sessions_done,
                  total: status.sessions_total,
                  documents: status.documents,
                })
              : t("readyNoSessions", { documents: status.documents })}
          </p>
        ) : null}
      </SettingRow>
      <SettingRow
        icon={MessagesSquare}
        title={tp("history_sessions.title")}
        description={tp("history_sessions.hint")}
        htmlFor="pa-pref-history-sessions"
        control={
          <Switch
            id="pa-pref-history-sessions"
            data-pa-pref="history_sessions"
            checked={sessions}
            disabled={disabled}
            onCheckedChange={(on) =>
              onSave("history_sessions", on ? "on" : "off")
            }
          />
        }
      />
      <SettingRow
        icon={LayoutGrid}
        title={tp("history_tasks.title")}
        description={tp("history_tasks.hint")}
        htmlFor="pa-pref-history-tasks"
        control={
          <Switch
            id="pa-pref-history-tasks"
            data-pa-pref="history_tasks"
            checked={tasks}
            disabled={disabled}
            onCheckedChange={(on) => onSave("history_tasks", on ? "on" : "off")}
          />
        }
      />
    </SettingCard>
  )
}
