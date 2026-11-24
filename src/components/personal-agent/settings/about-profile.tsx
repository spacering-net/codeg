"use client"

/**
 * What codeg sees of the owner (5.1–5.3, 2.11), on the "About you" page:
 * their hours — each kind of day changeable, and what they set stands
 * whatever codeg learns after —, the projects they worked in lately (each
 * one codeg can be told not to mind) and the agents they use, how they
 * answer each kind of card, and a way to clear what codeg learned.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Eraser, FolderKanban, MousePointerClick } from "lucide-react"

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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import type {
  PersonalAgentDayHours,
  PersonalAgentProfile,
  PersonalAgentProfileOp,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** A time of the hours: `HH:MM` (past 24:00 is the next morning's). */
export function hoursClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
    m % 60
  ).padStart(2, "0")}`
}

/** One kind of day's hours: as known, and changeable. */
export function HoursLine({
  kind,
  hours,
  learned,
  disabled,
  onChange,
}: {
  kind: "workday" | "restday"
  hours: PersonalAgentDayHours
  /** What the record alone says: what letting go of theirs goes back to. */
  learned: PersonalAgentDayHours | null
  disabled: boolean
  onChange: (op: PersonalAgentProfileOp) => Promise<void>
}) {
  const t = useTranslations("PersonalAgent.settings.about")
  const [draft, setDraft] = useState<{ start: string; end: string } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const span = t(hours.end >= 1440 ? "spanOvernight" : "span", {
    start: hoursClock(hours.start),
    end: hoursClock(hours.end),
  })
  const save = (start: string | null, end: string | null) => {
    setError(null)
    onChange({ op: "hours", day: kind, start, end })
      .then(() => setDraft(null))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      )
  }
  const how = hours.set
    ? t("setByYou")
    : hours.learned
      ? t("learnedFrom", { count: hours.days })
      : t("stillLearning")
  return (
    <div
      className="flex flex-col gap-1 text-xs"
      data-pa-hours={kind}
      data-learned={hours.learned ? "true" : "false"}
      data-set={hours.set ? "true" : "false"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-muted-foreground">{t(kind)}</span>
        <span className="flex flex-wrap items-baseline gap-2">
          <span
            className={cn(
              "font-medium tabular-nums",
              !hours.learned && "text-muted-foreground"
            )}
          >
            {span}
          </span>
          <span className="text-muted-foreground">{how}</span>
          {draft == null ? (
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs"
              disabled={disabled}
              onClick={() =>
                setDraft({
                  start: hoursClock(hours.start),
                  end: hoursClock(hours.end),
                })
              }
              data-pa-hours-edit={kind}
            >
              {t("change")}
            </Button>
          ) : null}
          {hours.set && draft == null ? (
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs"
              disabled={disabled}
              onClick={() => save(null, null)}
              data-pa-hours-unset={kind}
            >
              {learned?.learned
                ? t("backToLearned", {
                    span: t(learned.end >= 1440 ? "spanOvernight" : "span", {
                      start: hoursClock(learned.start),
                      end: hoursClock(learned.end),
                    }),
                  })
                : t("backToLearning")}
            </Button>
          ) : null}
        </span>
      </div>
      {draft ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Input
            type="time"
            aria-label={t("start")}
            className="h-7 w-28 text-xs"
            value={draft.start}
            onChange={(e) => setDraft({ ...draft, start: e.target.value })}
            data-pa-hours-start={kind}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="time"
            aria-label={t("end")}
            className="h-7 w-28 text-xs"
            value={draft.end}
            onChange={(e) => setDraft({ ...draft, end: e.target.value })}
            data-pa-hours-end={kind}
          />
          <Button
            size="xs"
            disabled={disabled || !draft.start || !draft.end}
            onClick={() => save(draft.start, draft.end)}
            data-pa-hours-save={kind}
          >
            {t("save")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setDraft(null)
              setError(null)
            }}
          >
            {t("cancel")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** The projects of the last weeks and the agents used. */
export function SeenCard({
  profile,
  agentName,
  disabled,
  onChange,
}: {
  profile: PersonalAgentProfile
  agentName: (agentType: string) => string
  disabled: boolean
  onChange: (op: PersonalAgentProfileOp) => Promise<void>
}) {
  const t = useTranslations("PersonalAgent.settings.about.seen")
  // A page read before these were there has none.
  const projects = profile.projects ?? []
  const excluded = profile.excluded ?? []
  const agents = profile.agents ?? []
  const exclude = (folder_id: number, out: boolean) =>
    void onChange({ op: "project", folder_id, excluded: out }).catch(() => {})
  return (
    <SettingCard>
      <SettingRow
        icon={FolderKanban}
        title={t("title")}
        description={t("hint")}
      >
        <div
          className="space-y-2 rounded-lg bg-background/60 px-3 py-2"
          data-pa-seen
        >
          <p className="text-xs font-medium">{t("projects")}</p>
          {projects.length === 0 && excluded.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noProjects")}</p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {projects.map((p) => (
              <li
                key={p.folder_id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs"
                data-pa-seen-project={p.folder_id}
                data-excluded={p.excluded ? "true" : "false"}
              >
                <span
                  className={cn(
                    "min-w-0 truncate font-medium",
                    p.excluded && "text-muted-foreground line-through"
                  )}
                >
                  {p.name}
                </span>
                <span className="flex items-baseline gap-2 text-muted-foreground">
                  <span className="tabular-nums">
                    {t("projectCounts", { recent: p.recent, all: p.sessions })}
                  </span>
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-xs"
                    disabled={disabled}
                    onClick={() => exclude(p.folder_id, !p.excluded)}
                    data-pa-seen-exclude={p.folder_id}
                  >
                    {p.excluded ? t("mind") : t("dontMind")}
                  </Button>
                </span>
              </li>
            ))}
            {excluded.map(([id, name]) => (
              <li
                key={id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs"
                data-pa-seen-project={id}
                data-excluded="true"
              >
                <span className="min-w-0 truncate text-muted-foreground line-through">
                  {name}
                </span>
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto p-0 text-xs"
                  disabled={disabled}
                  onClick={() => exclude(id, false)}
                  data-pa-seen-exclude={id}
                >
                  {t("mind")}
                </Button>
              </li>
            ))}
          </ul>
          {agents.length > 0 ? (
            <>
              <p className="pt-1 text-xs font-medium">{t("agents")}</p>
              <ul className="flex flex-col gap-1">
                {agents.map((a) => (
                  <li
                    key={a.agent_type}
                    className="flex items-center gap-2 text-xs"
                    data-pa-seen-agent={a.agent_type}
                  >
                    <span className="w-28 shrink-0 truncate">
                      {agentName(a.agent_type)}
                    </span>
                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary/60"
                        style={{ width: `${a.percent}%` }}
                      />
                    </span>
                    <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums">
                      {a.percent}% · {a.sessions}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </SettingRow>
    </SettingCard>
  )
}

/** How the owner answers each kind of card, and whether codeg counts it. */
export function ReactionsCard({
  on,
  profile,
  disabled,
  onSwitch,
}: {
  on: boolean
  profile: PersonalAgentProfile | null
  disabled: boolean
  onSwitch: (on: boolean) => void
}) {
  const t = useTranslations("PersonalAgent.settings.about.reactions")
  const tp = useTranslations("PersonalAgent.settings.prefs")
  const cards = profile?.cards ?? []
  return (
    <SettingCard>
      <SettingRow
        icon={MousePointerClick}
        title={tp("reactions.title")}
        description={tp("reactions.hint")}
        htmlFor="pa-pref-reactions"
        control={
          <Switch
            id="pa-pref-reactions"
            data-pa-pref="reactions"
            checked={on}
            disabled={disabled}
            onCheckedChange={onSwitch}
          />
        }
      >
        {on ? (
          <div
            className="rounded-lg bg-background/60 px-3 py-2"
            data-pa-reactions
          >
            {cards.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("none")}</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-0.5 font-normal">{t("kind")}</th>
                    <th className="py-0.5 text-right font-normal">
                      {t("raised")}
                    </th>
                    <th className="py-0.5 text-right font-normal">
                      {t("acted")}
                    </th>
                    <th className="py-0.5 text-right font-normal">
                      {t("dismissed")}
                    </th>
                    <th className="py-0.5 text-right font-normal">
                      {t("undone")}
                    </th>
                    <th className="py-0.5 text-right font-normal">
                      {t("wait")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((c) => (
                    <tr key={c.kind} data-pa-reaction={c.kind}>
                      <td className="py-0.5">
                        {t(`kinds.${c.kind}` as "kinds.rule")}
                      </td>
                      <td className="py-0.5 text-right tabular-nums">
                        {c.raised}
                      </td>
                      <td className="py-0.5 text-right tabular-nums">
                        {c.acted}
                      </td>
                      <td className="py-0.5 text-right tabular-nums">
                        {c.dismissed + c.muted}
                      </td>
                      <td className="py-0.5 text-right tabular-nums">
                        {c.undone}
                      </td>
                      <td className="py-0.5 text-right text-muted-foreground tabular-nums">
                        {c.act_minutes == null
                          ? "—"
                          : t("minutes", { n: c.act_minutes })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-pa-reactions-off>
            {t("off")}
          </p>
        )}
      </SettingRow>
    </SettingCard>
  )
}

/** Clear what codeg learned (their own corrections stay). */
export function ClearLearned({
  disabled,
  clearedAt,
  onClear,
}: {
  disabled: boolean
  clearedAt: string | null
  onClear: () => Promise<void>
}) {
  const t = useTranslations("PersonalAgent.settings.about.clear")
  const [open, setOpen] = useState(false)
  return (
    <SettingCard>
      <SettingRow
        icon={Eraser}
        title={t("title")}
        description={
          clearedAt
            ? `${t("hint")} ${t("clearedAt", {
                when: new Date(clearedAt).toLocaleString(),
              })}`
            : t("hint")
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setOpen(true)}
            data-pa-profile-clear
          >
            {t("button")}
          </Button>
        }
      />
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void onClear().catch(() => {})
                setOpen(false)
              }}
              data-pa-profile-clear-confirm
            >
              {t("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingCard>
  )
}
