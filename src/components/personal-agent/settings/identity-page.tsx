"use client"

/**
 * "Identity & brain", the first of an assistant's own settings pages: its
 * name and picture, and the agent it runs on with every option picked (the
 * assistant editor's flow and validation). The mode and permissions are
 * chosen here, and codeg runs it as picked. Saved with [Save] — switching
 * the agent starts a new session. With no assistant yet, it is the first
 * setup.
 */

import { useMemo, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Bot, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"

import {
  AgentSelect,
  OptionBlock,
  RequiredOptionRow,
  optionValueLabel,
  type OptionRow,
} from "@/components/settings/agent-options-editor"
import {
  buildAgentConfig,
  effectivePick,
  missingRows,
  rowMark,
  selectionFromOptions,
  EMPTY_SELECTION,
  type AssistantSelection,
} from "@/components/settings/assistant-agent-config"
import { AssistantAvatarPicker } from "@/components/settings/assistant-avatar-picker"
import {
  RequiredOptionsSection,
  useRequiredOptionsGate,
} from "@/components/settings/required-agent-options"
import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { personalAgentSave } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useBotId } from "@/contexts/personal-agent-context"
import { getAgentLabel } from "@/lib/custom-agents"
import type {
  AgentType,
  AssistantAgentConfig,
  AssistantAvatar,
  PersonalAgentInfo,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { PageHead } from "./pref-pages"

/** What a new agent starts with — the backend's own default. */
const DEFAULT_AVATAR: AssistantAvatar = {
  kind: "emoji",
  emoji: "🧭",
  color: "violet",
}

export function IdentityPage({
  agent,
  bot,
  disabled,
  onSaved,
}: {
  agent: PersonalAgentInfo | null
  /** Whose: `null` is the page's own assistant. */
  bot: number | null
  disabled: boolean
  onSaved?: () => void
}) {
  const t = useTranslations("PersonalAgent.settings")
  const pageBot = useBotId()
  const botId = bot ?? pageBot
  const tPage = useTranslations("PersonalAgent")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const locale = useLocale()
  const { agents } = useAcpAgents()

  const [name, setName] = useState(agent?.name ?? "")
  const [avatar, setAvatar] = useState<AssistantAvatar>(
    agent?.avatar ?? DEFAULT_AVATAR
  )
  const [agentType, setAgentType] = useState<AgentType | null>(
    agent?.agent_type ?? null
  )
  const [selection, setSelection] = useState<AssistantSelection>(
    agent ? selectionFromOptions(agent.agent_options) : EMPTY_SELECTION
  )
  const [agentTouched, setAgentTouched] = useState(false)
  const [pickedLabels, setPickedLabels] = useState<Record<string, string>>({})
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<string>>(new Set())
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>())

  const savedAgent: AssistantAgentConfig | null =
    agent && agent.agent_type === agentType
      ? {
          agent_type: agent.agent_type,
          agent_options: agent.agent_options,
          label_snapshot: agent.label_snapshot,
        }
      : null
  const agentInfo = agents.find((a) => a.agent_type === agentType) ?? null
  const agentUnavailable =
    savedAgent !== null &&
    !agentTouched &&
    agents.length > 0 &&
    !(agentInfo?.enabled && agentInfo.available)
  const { gate, probe } = useRequiredOptionsGate({
    agentType,
    selection,
    unavailable: agentUnavailable,
  })
  const booleanLabels = { on: tm("booleanOn"), off: tm("booleanOff") }
  const savedMarks = useMemo(
    () =>
      savedAgent
        ? {
            selection: selectionFromOptions(savedAgent.agent_options),
            labels: savedAgent.label_snapshot,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savedAgent?.agent_type, agent?.revision]
  )
  const readyRows = gate.kind === "ready" ? gate.rows : null
  const missing = readyRows ? missingRows(readyRows, selection) : []
  const driftCount =
    readyRows && savedMarks && !agentTouched
      ? readyRows.filter((row) =>
          rowMark(row, selection, savedMarks, pickedLabels)
        ).length
      : 0

  const pickValue = (row: OptionRow, value: string) => {
    setAgentTouched(true)
    setSubmitError(null)
    setInvalidIds((prev) => {
      if (!prev.has(row.id)) return prev
      const next = new Set(prev)
      next.delete(row.id)
      return next
    })
    setPickedLabels((prev) => ({
      ...prev,
      [row.id]: optionValueLabel(row, value, booleanLabels) ?? value,
    }))
    setSelection((prev) =>
      row.kind === "mode"
        ? { ...prev, modeId: value }
        : { ...prev, configValues: { ...prev.configValues, [row.id]: value } }
    )
  }

  const pickAgent = (next: AgentType) => {
    if (next === agentType) return
    setAgentType(next)
    setAgentTouched(true)
    setSelection(EMPTY_SELECTION)
    setPickedLabels({})
    setInvalidIds(new Set())
    setSubmitError(null)
  }

  const renderRow = (row: OptionRow, rowDisabled = false) => (
    <OptionBlock key={row.id}>
      <RequiredOptionRow
        row={row}
        value={effectivePick(row, selection)}
        onChange={(value) => pickValue(row, value)}
        disabled={rowDisabled || disabled || saving}
        invalid={invalidIds.has(row.id)}
        mark={rowMark(row, selection, savedMarks, pickedLabels)}
        triggerRef={(el) => {
          triggerRefs.current.set(row.id, el)
        }}
      />
    </OptionBlock>
  )

  /** The brain to store, `null` for "unchanged", or a refusal. */
  const brainToSave = ():
    | { ok: true; config: AssistantAgentConfig | null }
    | { ok: false } => {
    if (agentType === null) {
      setSubmitError(ta("pickAgentFirst"))
      return { ok: false }
    }
    if (gate.kind === "ready") {
      const stillMissing = missingRows(gate.rows, selection)
      if (stillMissing.length > 0) {
        setInvalidIds(new Set(stillMissing.map((row) => row.id)))
        setSubmitError(ta("missingCount", { count: stillMissing.length }))
        triggerRefs.current.get(stillMissing[0].id)?.focus()
        return { ok: false }
      }
      return {
        ok: true,
        config: buildAgentConfig({
          agentType,
          agentLabel: getAgentLabel(agentType) ?? agentType,
          rows: gate.rows,
          selection,
          modeLabel: tm("modeLabel"),
          booleanLabels,
        }),
      }
    }
    if (
      savedAgent &&
      !agentTouched &&
      (gate.kind === "error" ||
        gate.kind === "unavailable-agent" ||
        gate.kind === "not-switched")
    ) {
      return { ok: true, config: null }
    }
    setSubmitError(
      gate.kind === "error"
        ? ta("cannotSaveProbeFailed")
        : gate.kind === "pick-model"
          ? ta("missingCount", { count: 1 })
          : gate.kind === "not-switched"
            ? ta("cannotSaveModelNotSwitched")
            : ta("cannotSaveStillLoading")
    )
    return { ok: false }
  }

  const save = async () => {
    if (saving || disabled) return
    setSubmitError(null)
    const brain = brainToSave()
    if (!brain.ok) return
    setSaving(true)
    try {
      // No settings ride along: the other pages save theirs item by item,
      // and a save here never takes one of them back.
      await personalAgentSave(
        {
          name: name.trim(),
          avatar,
          ...(brain.config ? { agent_config: brain.config } : {}),
          locale,
        },
        botId
      )
      setAgentTouched(false)
      toast.message(t("saved"))
      onSaved?.()
    } catch (error) {
      setSubmitError(toErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const footerHint =
    missing.length > 0 ? ta("missingCount", { count: missing.length }) : null

  return (
    <form
      className="flex flex-col gap-3"
      data-pa-settings-page="identity"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <PageHead
        title={agent ? t("nav.identity") : t("setupTitle")}
        description={agent ? t("pages.identity") : t("setupDescription")}
      />
      <SettingCard>
        {/* Who it is: the avatar its messages carry and its name, side by
            side as in the assistant editor. A monogram is drawn from the
            name in effect — the default one while the field is empty. */}
        <div className="flex items-start gap-3 p-3">
          <div className="mt-0.5 shrink-0">
            <AssistantAvatarPicker
              avatar={avatar}
              name={name.trim() || tPage("title")}
              onChange={setAvatar}
              disabled={disabled || saving}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="pa-name" className="text-sm">
              {t("name")}
            </Label>
            <Input
              id="pa-name"
              dir="auto"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              disabled={disabled || saving}
              className="h-8 bg-background text-sm"
            />
            <span className="text-xs leading-5 text-muted-foreground">
              {t("nameHint")}
            </span>
          </div>
        </div>
      </SettingCard>
      <SettingCard>
        <SettingRow
          icon={Bot}
          title={ta("agentLabel")}
          description={
            agentType === null ? ta("pickAgentFirst") : t("agentHint")
          }
          control={
            <AgentSelect
              value={agentType}
              onChange={pickAgent}
              agents={agents.filter(
                (a) => a.enabled || a.agent_type === agentType
              )}
              fallbackLabel={savedAgent?.label_snapshot.agent}
              disabled={disabled || saving}
            />
          }
        />
        {agentType !== null ? (
          <RequiredOptionsSection
            gate={gate}
            loading={probe.loading}
            saved={agentTouched ? null : savedAgent}
            driftCount={driftCount}
            renderRow={renderRow}
            onRetry={() => probe.reload()}
          />
        ) : null}
      </SettingCard>
      {agent && agentType !== null && agentType !== agent.agent_type ? (
        <SettingNote icon={Sparkles}>{t("switchNote")}</SettingNote>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <p
          className={cn(
            "min-w-0 text-xs leading-5",
            submitError ? "text-destructive" : "text-muted-foreground"
          )}
          role={submitError ? "alert" : undefined}
        >
          {submitError ?? footerHint}
        </p>
        <Button type="submit" size="sm" disabled={disabled || saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("save")}
        </Button>
      </div>
    </form>
  )
}
