"use client"

/**
 * An assistant's own pages besides "Identity & brain": "Persona & memory"
 * (its files) and "Advanced" — compaction, the handoff card's budget,
 * dispatch concurrency, the built-in skill (each saved the moment it
 * changes), and the working directory, moved with [Move] since that starts a
 * new session.
 */

import { useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  FileText,
  FolderCog,
  Gauge,
  Loader2,
  PenLine,
  Shrink,
  Sparkles,
  SquareSlash,
} from "lucide-react"
import { toast } from "sonner"

import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { personalAgentSetWorkdir } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PersonalAgentInfo } from "@/lib/types"

import { PersonaFiles } from "../persona-files"
import { useSettingsPatch } from "./use-settings"

interface OwnPageProps {
  agent: PersonalAgentInfo
  /** Whose: the id of the assistant the page is about. */
  bot: number | null
  disabled: boolean
}

export function PersonaPage({
  bot,
  entry = null,
  unwritten = false,
}: {
  bot: number | null
  /** The file to open on (7.7). */
  entry?: string | null
  /** A work assistant whose persona is still its default file. */
  unwritten?: boolean
}) {
  const t = useTranslations("PersonalAgent.settings")
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="persona">
      {unwritten ? (
        <div data-pa-persona-unwritten>
          <SettingNote icon={PenLine}>{t("personaUnwritten")}</SettingNote>
        </div>
      ) : null}
      <PersonaFiles key={entry ?? ""} botId={bot} initial={entry} />
    </div>
  )
}

/** A number saved when the field is left (or Enter), within its range. */
function NumberField({
  id,
  value,
  min,
  max,
  width,
  disabled,
  onCommit,
}: {
  id: string
  value: number
  min: number
  max: number
  width: string
  disabled: boolean
  onCommit: (n: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null) return
    const n = Number(draft)
    setDraft(null)
    if (
      draft !== "" &&
      Number.isInteger(n) &&
      n >= min &&
      n <= max &&
      n !== value
    ) {
      onCommit(n)
    }
  }
  return (
    <Input
      id={id}
      inputMode="numeric"
      value={draft ?? String(value)}
      disabled={disabled}
      onChange={(e) =>
        setDraft(
          e.target.value.replace(/[^0-9]/g, "").slice(0, String(max).length)
        )
      }
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit()
      }}
      className={`h-8 ${width} bg-background text-center`}
    />
  )
}

export function AdvancedPage({ agent, bot, disabled }: OwnPageProps) {
  const t = useTranslations("PersonalAgent.settings")
  const tw = useTranslations("PersonalAgent.settings.workdir")
  const locale = useLocale()
  const { patch } = useSettingsPatch(bot)
  const s = agent.settings
  const [command, setCommand] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const own = (item: string, value: unknown) =>
    void patch([{ key: `own.${item}`, value }])
  const move = async (next: string | null) => {
    setMoving(true)
    try {
      await personalAgentSetWorkdir(next, locale, bot)
      setPath(null)
      toast.message(tw("saved"))
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setMoving(false)
    }
  }
  const pathValue = path ?? (agent.workdir_custom ? agent.workdir : "")
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="advanced">
      <SettingCard>
        <SettingRow
          icon={Shrink}
          title={t("autoCompact")}
          description={t("autoCompactHint")}
          htmlFor="pa-auto-compact"
          control={
            <div className="flex items-center gap-1.5">
              <NumberField
                id="pa-auto-compact"
                value={s.auto_compact_percent}
                min={0}
                max={100}
                width="w-16"
                disabled={disabled}
                onCommit={(n) => own("auto_compact_percent", n)}
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          }
        />
        <SettingRow
          icon={SquareSlash}
          title={t("compactCommand")}
          description={t("compactCommandHint")}
          htmlFor="pa-compact-command"
        >
          <Input
            id="pa-compact-command"
            value={command ?? s.compact_command ?? ""}
            disabled={disabled}
            onChange={(e) => setCommand(e.target.value)}
            onBlur={() => {
              if (command == null) return
              const next = command.trim() || null
              setCommand(null)
              if (next !== (s.compact_command ?? null))
                own("compact_command", next)
            }}
            placeholder="/compact"
            className="h-8 bg-background font-mono text-xs"
          />
        </SettingRow>
      </SettingCard>
      <SettingNote icon={Shrink}>{t("compactionNote")}</SettingNote>
      <SettingCard>
        <SettingRow
          icon={Gauge}
          title={t("concurrency")}
          description={t("concurrencyHint")}
          htmlFor="pa-concurrency"
          control={
            <NumberField
              id="pa-concurrency"
              value={s.dispatch_concurrency}
              min={0}
              max={64}
              width="w-16"
              disabled={disabled}
              onCommit={(n) => own("dispatch_concurrency", n)}
            />
          }
        />
        <SettingRow
          icon={FileText}
          title={t("handoffBudget")}
          description={t("handoffBudgetHint")}
          htmlFor="pa-handoff"
          control={
            <NumberField
              id="pa-handoff"
              value={s.handoff_budget_chars}
              min={4000}
              max={200000}
              width="w-24"
              disabled={disabled}
              onCommit={(n) => own("handoff_budget_chars", n)}
            />
          }
        />
        <SettingRow
          icon={Sparkles}
          title={t("skill")}
          description={t("skillHint")}
          htmlFor="pa-skill"
          control={
            <Switch
              id="pa-skill"
              checked={s.skill_enabled}
              disabled={disabled}
              onCheckedChange={(on) => own("skill_enabled", on)}
            />
          }
        />
      </SettingCard>
      <SettingCard>
        <SettingRow
          icon={FolderCog}
          title={tw("title")}
          description={tw("hint", { current: agent.workdir })}
          htmlFor="pa-workdir"
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="pa-workdir"
              value={pathValue}
              onChange={(e) => setPath(e.target.value)}
              placeholder={tw("placeholder")}
              disabled={disabled || moving}
              className="h-8 flex-1 bg-background font-mono text-xs"
            />
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || moving || !agent.workdir_custom}
                onClick={() => void move(null)}
              >
                {tw("useDefault")}
              </Button>
              <Button
                size="sm"
                disabled={disabled || moving || pathValue.trim().length === 0}
                onClick={() => void move(pathValue.trim())}
              >
                {moving ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : null}
                {tw("apply")}
              </Button>
            </div>
          </div>
        </SettingRow>
      </SettingCard>
    </div>
  )
}
