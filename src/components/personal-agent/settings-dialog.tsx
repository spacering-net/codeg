"use client"

/**
 * The personal agent's settings, in a dialog on its page: its brain (an agent
 * with every option picked, the assistant editor's flow and validation), the
 * auto-compaction threshold and command (the kanban task settings' two
 * fields), dispatch concurrency, and the persona and memory files of its
 * working directory. The working directory itself lives in Settings →
 * Collaboration.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Bot,
  FileText,
  Gauge,
  Loader2,
  Shrink,
  Sparkles,
  SquareSlash,
  UserRound,
} from "lucide-react"

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import {
  personalAgentFileSave,
  personalAgentFiles,
  personalAgentSave,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import type {
  AgentType,
  AssistantAgentConfig,
  PersonalAgentFile,
  PersonalAgentInfo,
  PersonalAgentSettings,
} from "@/lib/types"
import { cn } from "@/lib/utils"

export type SettingsTab = "brain" | "compaction" | "dispatch" | "persona"

const DEFAULT_SETTINGS: PersonalAgentSettings = {
  auto_compact_percent: 70,
  compact_command: null,
  compact_command_agent: null,
  handoff_budget_chars: 32000,
  dispatch_concurrency: 3,
  skill_enabled: true,
}

const TAB_BODY_CLASS = "mt-1 flex min-h-[22rem] flex-col gap-3"

interface PersonalAgentSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agent: PersonalAgentInfo | null
  initialTab?: SettingsTab
}

export function PersonalAgentSettingsDialog({
  open,
  onOpenChange,
  agent,
  initialTab = "brain",
}: PersonalAgentSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[40rem] [&_[data-slot=dialog-header]]:pr-16">
        {/* Mounted per open, so every open starts from what is saved. */}
        {open ? (
          <SettingsBody
            agent={agent}
            initialTab={agent ? initialTab : "brain"}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SettingsBody({
  agent,
  initialTab,
  onClose,
}: {
  agent: PersonalAgentInfo | null
  initialTab: SettingsTab
  onClose: () => void
}) {
  const t = useTranslations("PersonalAgent.settings")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const locale = useLocale()
  const { agents } = useAcpAgents()
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const saved = agent?.settings ?? DEFAULT_SETTINGS

  const [name, setName] = useState(agent?.name ?? "")
  const [agentType, setAgentType] = useState<AgentType | null>(
    agent?.agent_type ?? null
  )
  const [selection, setSelection] = useState<AssistantSelection>(
    agent ? selectionFromOptions(agent.agent_options) : EMPTY_SELECTION
  )
  const [agentTouched, setAgentTouched] = useState(false)
  const [pickedLabels, setPickedLabels] = useState<Record<string, string>>({})
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<string>>(new Set())
  const [compactPercent, setCompactPercent] = useState(
    String(saved.auto_compact_percent)
  )
  const [compactCommand, setCompactCommand] = useState(
    saved.compact_command ?? ""
  )
  const [concurrency, setConcurrency] = useState(
    String(saved.dispatch_concurrency)
  )
  const [handoffBudget, setHandoffBudget] = useState(
    String(saved.handoff_budget_chars)
  )
  const [skillEnabled, setSkillEnabled] = useState(saved.skill_enabled)
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
    // A compact command means something only to the agent it was written for.
    if (agent && next !== agent.agent_type) setCompactCommand("")
  }

  const renderRow = (row: OptionRow, disabled = false) => (
    <OptionBlock key={row.id}>
      <RequiredOptionRow
        row={row}
        value={effectivePick(row, selection)}
        onChange={(value) => pickValue(row, value)}
        disabled={disabled || saving}
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
      setTab("brain")
      setSubmitError(ta("pickAgentFirst"))
      return { ok: false }
    }
    if (gate.kind === "ready") {
      const stillMissing = missingRows(gate.rows, selection)
      if (stillMissing.length > 0) {
        setTab("brain")
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
    setTab("brain")
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
    if (saving) return
    setSubmitError(null)
    const brain = brainToSave()
    if (!brain.ok) return
    const percent = Number(compactPercent)
    const settings: PersonalAgentSettings = {
      auto_compact_percent:
        Number.isFinite(percent) && percent >= 0 && percent <= 100
          ? percent
          : saved.auto_compact_percent,
      compact_command: compactCommand.trim() || null,
      compact_command_agent: compactCommand.trim() ? agentType : null,
      dispatch_concurrency: Math.max(0, Math.min(64, Number(concurrency) || 0)),
      handoff_budget_chars: Math.max(
        4000,
        Math.min(200000, Number(handoffBudget) || 32000)
      ),
      skill_enabled: skillEnabled,
    }
    setSaving(true)
    try {
      await personalAgentSave({
        name: name.trim(),
        ...(brain.config ? { agent_config: brain.config } : {}),
        settings,
        locale,
      })
      onClose()
    } catch (error) {
      setSubmitError(toErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const footerHint =
    missing.length > 0 ? ta("missingCount", { count: missing.length }) : null

  return (
    <>
      <DialogHeader className="px-4 pt-6 pb-4 sm:px-6">
        <DialogTitle>{agent ? t("title") : t("setupTitle")}</DialogTitle>
        <DialogDescription>
          {agent ? t("description") : t("setupDescription")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="relative min-h-0 flex-1 overflow-y-auto border-y border-border/60 px-4 py-4 sm:px-6">
          <Tabs value={tab} onValueChange={(v) => setTab(v as SettingsTab)}>
            <TabsList className="w-full">
              <TabsTrigger value="brain" className="flex-1">
                {t("tabBrain")}
              </TabsTrigger>
              <TabsTrigger value="compaction" className="flex-1">
                {t("tabCompaction")}
              </TabsTrigger>
              <TabsTrigger value="dispatch" className="flex-1">
                {t("tabDispatch")}
              </TabsTrigger>
              <TabsTrigger value="persona" className="flex-1" disabled={!agent}>
                {t("tabPersona")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="brain" className={TAB_BODY_CLASS}>
              <SettingCard>
                <SettingRow
                  icon={UserRound}
                  title={t("name")}
                  description={t("nameHint")}
                  htmlFor="pa-name"
                >
                  <Input
                    id="pa-name"
                    value={name}
                    maxLength={40}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("namePlaceholder")}
                    className="h-8 bg-background text-sm"
                  />
                </SettingRow>
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
                      disabled={saving}
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
            </TabsContent>

            <TabsContent value="compaction" className={TAB_BODY_CLASS}>
              <SettingCard>
                <SettingRow
                  icon={Shrink}
                  title={t("autoCompact")}
                  description={t("autoCompactHint")}
                  htmlFor="pa-auto-compact"
                  control={
                    <div className="flex items-center gap-1.5">
                      <Input
                        id="pa-auto-compact"
                        inputMode="numeric"
                        value={compactPercent}
                        onChange={(e) =>
                          setCompactPercent(
                            e.target.value.replace(/[^0-9]/g, "").slice(0, 3)
                          )
                        }
                        className="h-8 w-16 bg-background text-center"
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
                    value={compactCommand}
                    onChange={(e) => setCompactCommand(e.target.value)}
                    placeholder="/compact"
                    className="h-8 bg-background font-mono text-xs"
                  />
                </SettingRow>
              </SettingCard>
              <SettingNote icon={Shrink}>{t("compactionNote")}</SettingNote>
            </TabsContent>

            <TabsContent value="dispatch" className={TAB_BODY_CLASS}>
              <SettingCard>
                <SettingRow
                  icon={Gauge}
                  title={t("concurrency")}
                  description={t("concurrencyHint")}
                  htmlFor="pa-concurrency"
                  control={
                    <Input
                      id="pa-concurrency"
                      inputMode="numeric"
                      value={concurrency}
                      onChange={(e) =>
                        setConcurrency(
                          e.target.value.replace(/[^0-9]/g, "").slice(0, 2)
                        )
                      }
                      className="h-8 w-16 bg-background text-center"
                    />
                  }
                />
                <SettingRow
                  icon={FileText}
                  title={t("handoffBudget")}
                  description={t("handoffBudgetHint")}
                  htmlFor="pa-handoff"
                  control={
                    <Input
                      id="pa-handoff"
                      inputMode="numeric"
                      value={handoffBudget}
                      onChange={(e) =>
                        setHandoffBudget(
                          e.target.value.replace(/[^0-9]/g, "").slice(0, 6)
                        )
                      }
                      className="h-8 w-24 bg-background text-center"
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
                      checked={skillEnabled}
                      onCheckedChange={setSkillEnabled}
                    />
                  }
                />
              </SettingCard>
            </TabsContent>

            <TabsContent value="persona" className={TAB_BODY_CLASS}>
              {agent ? <PersonaFiles /> : null}
            </TabsContent>
          </Tabs>
        </div>
        <DialogFooter className="items-center gap-3 px-4 py-4 sm:justify-between sm:px-6">
          <p
            className={cn(
              "min-w-0 text-xs leading-5",
              submitError ? "text-destructive" : "text-muted-foreground"
            )}
            role={submitError ? "alert" : undefined}
          >
            {submitError ?? footerHint}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={saving}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t("save")}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </>
  )
}

/** The persona, rules and memory files, each saved on its own. */
function PersonaFiles() {
  const t = useTranslations("PersonalAgent.settings")
  const [files, setFiles] = useState<PersonalAgentFile[] | null>(null)
  const [active, setActive] = useState("SOUL.md")
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let cancelled = false
    personalAgentFiles()
      .then((list) => {
        if (cancelled) return
        setFiles(list)
        setDrafts(Object.fromEntries(list.map((f) => [f.name, f.content])))
      })
      .catch((e) => toast.error(toErrorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [])
  if (!files)
    return (
      <Loader2 className="mx-auto my-8 size-4 animate-spin text-muted-foreground" />
    )
  const current = files.find((f) => f.name === active)
  const dirty = current != null && drafts[active] !== current.content
  return (
    <div className="flex flex-col gap-2">
      <SettingNote icon={FileText}>{t("filesNote")}</SettingNote>
      <div className="flex flex-wrap gap-1">
        {files.map((f) => (
          <Button
            key={f.name}
            type="button"
            variant={f.name === active ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 font-mono text-xs"
            onClick={() => setActive(f.name)}
          >
            {f.name}
            {drafts[f.name] !== f.content ? " •" : ""}
          </Button>
        ))}
      </div>
      <Textarea
        dir="auto"
        value={drafts[active] ?? ""}
        onChange={(e) => setDrafts((d) => ({ ...d, [active]: e.target.value }))}
        className="field-scrollbar min-h-64 bg-background font-mono text-xs"
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => {
            const content = drafts[active] ?? ""
            setSaving(true)
            personalAgentFileSave(active, content)
              .then(() => {
                setFiles((list) =>
                  (list ?? []).map((f) =>
                    f.name === active ? { ...f, content, exists: true } : f
                  )
                )
                toast.message(t("fileSaved", { name: active }))
              })
              .catch((e) => toast.error(toErrorMessage(e)))
              .finally(() => setSaving(false))
          }}
        >
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("saveFile")}
        </Button>
      </div>
    </div>
  )
}
