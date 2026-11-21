"use client"

/**
 * "Identity & brain", the first tab of an assistant's own page: its name
 * and picture, the agent it runs on with every option picked (the
 * assistant editor's flow and validation), and beside it the executor
 * config its work runs on (D4) — the brain thinks, the executor config does
 * the work. The mode and permissions are chosen here, and codeg runs it as
 * picked. Saved with [Save] — switching the agent starts a new session.
 * With no assistant yet, it is the first setup, the page's own screen: its
 * face, its name and its agent, and [Chat with your assistant] — no
 * executor config to pick, a new one made on the brain's agent with its
 * options filled in; when codeg cannot read them nothing is saved and the
 * executor config editor opens, the setup saved again with the one made
 * there. A name or picture saved
 * elsewhere meanwhile (the roster's "Edit basic info") shows here unless
 * the field was changed here.
 */

import { useMemo, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Loader2,
  MessageCircle,
  Sparkles,
  Workflow,
} from "lucide-react"
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
import {
  AssistantEditorDialog,
  type AssistantPrefill,
} from "@/components/settings/assistant-editor-dialog"
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
import {
  EXECUTOR_OPTIONS_UNAVAILABLE,
  type AgentType,
  type AssistantAgentConfig,
  type BotAvatar,
  type PersonalAgentInfo,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAssistants } from "@/stores/assistants-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { BotFacePicker } from "../bot-face-picker"
import { SetupAgentTiles } from "./setup-agent-tiles"
import { SetupFrame } from "./setup-frame"
import { SetupIdentity } from "./setup-identity"
import {
  assistantAvatarOf,
  choiceOf,
  ExecutorPick,
  sameChoice,
  type ExecutorChoice,
} from "./executor-pick"

/** What the primary assistant starts with (10.6): a black blob. */
const DEFAULT_AVATAR: BotAvatar = {
  kind: "face",
  shape: "blob",
  color: "black",
}

/** The first setup's line under [Chat]: hung below it, taking no room —
 *  the frame's padding under it is its room — so nothing moves for it. */
const UNDER_START =
  "absolute inset-x-0 top-full mt-3 text-center text-xs leading-5"

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

  const savedName = agent?.name ?? ""
  const savedAvatar = agent?.avatar ?? DEFAULT_AVATAR
  const [name, setName] = useState(savedName)
  const [avatar, setAvatar] = useState<BotAvatar>(savedAvatar)
  // The saved name and picture as the fields last took them: one saved
  // anew (here or elsewhere) replaces a field still as it was.
  const [base, setBase] = useState({ name: savedName, avatar: savedAvatar })
  if (
    base.name !== savedName ||
    JSON.stringify(base.avatar) !== JSON.stringify(savedAvatar)
  ) {
    setBase({ name: savedName, avatar: savedAvatar })
    if (name === base.name) setName(savedName)
    if (JSON.stringify(avatar) === JSON.stringify(base.avatar))
      setAvatar(savedAvatar)
  }
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
  // The executor config its work runs on: as bound, until another is
  // picked; a new one on the brain's agent for the first setup.
  const tx = useTranslations("PersonalAgent.settings.executorPick")
  const assistants = useAssistants()
  const boundChoice: ExecutorChoice = agent
    ? choiceOf(agent.executor_assistant_id, assistants)
    : { kind: "new" }
  const [executor, setExecutor] = useState<ExecutorChoice | null>(null)
  const executorShown = executor ?? boundChoice
  // The one picked is turned off: its work cannot run on it.
  const executorOff =
    executorShown.kind === "existing" &&
    assistants.some((a) => a.id === executorShown.id && !a.enabled)
  // The agent's options could not be read: the editor, to make it there.
  const [editor, setEditor] = useState<{
    prefill: AssistantPrefill
    why: string
  } | null>(null)
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
  // The options still to pick, as the first setup says it ("Your agent has
  // 2 options to pick") or as the identity tab does.
  const missingText = (count: number) =>
    agent ? ta("missingCount", { count }) : t("setupMissing", { count })
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
        // The first setup's rows: their names alone, picked at a glance.
        hideHint={!agent}
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
      // Left as saved: the save keeps it as it is (one that now lacks an
      // option the agent added never stops the rest of the page saving —
      // its executor config, its name).
      if (stillMissing.length > 0 && savedAgent && !agentTouched) {
        return { ok: true, config: null }
      }
      if (stillMissing.length > 0) {
        setInvalidIds(new Set(stillMissing.map((row) => row.id)))
        setSubmitError(missingText(stillMissing.length))
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
        gate.kind === "not-switched" ||
        // A model to pick now (one added, or the saved one gone): the saved
        // brain kept as it is, as with a missing option above.
        gate.kind === "pick-model")
    ) {
      return { ok: true, config: null }
    }
    setSubmitError(
      gate.kind === "error"
        ? ta("cannotSaveProbeFailed")
        : gate.kind === "pick-model"
          ? missingText(1)
          : gate.kind === "not-switched"
            ? ta("cannotSaveModelNotSwitched")
            : ta("cannotSaveStillLoading")
    )
    return { ok: false }
  }

  /** Save; `made` is the executor config the editor just made for it. */
  const save = async (made?: number) => {
    if (saving || disabled) return
    setSubmitError(null)
    const brain = brainToSave()
    if (!brain.ok) return
    // Sent only when it is the first setup or another was picked.
    const pick: ExecutorChoice | null =
      made != null
        ? { kind: "existing", id: made }
        : !agent || !sameChoice(executorShown, boundChoice)
          ? executorShown
          : null
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
          ...(pick?.kind === "existing"
            ? { executor_assistant_id: pick.id }
            : pick?.kind === "new"
              ? { executor_new: true }
              : {}),
        },
        botId
      )
      setAgentTouched(false)
      setExecutor(null)
      // The first setup says so by opening its conversation — whatever page
      // was asked for on the way in (a link to its persona, say): it shows
      // once there is an assistant.
      if (agent) toast.message(t("saved"))
      else usePersonalAgentUi.getState().showConversation()
      onSaved?.()
    } catch (error) {
      const message = toErrorMessage(error)
      const at = message.indexOf(EXECUTOR_OPTIONS_UNAVAILABLE)
      if (at >= 0 && agentType !== null) {
        // Nothing saved: the editor makes it, and the save goes again.
        setEditor({
          why: message.slice(at + EXECUTOR_OPTIONS_UNAVAILABLE.length),
          prefill: {
            name: name.trim() || tPage("title"),
            avatar: assistantAvatarOf(avatar),
            agentType,
          },
        })
      } else {
        setSubmitError(message)
      }
    } finally {
      setSaving(false)
    }
  }

  const footerHint = missing.length > 0 ? missingText(missing.length) : null

  const agentPick = (
    <AgentSelect
      value={agentType}
      onChange={pickAgent}
      agents={agents.filter((a) => a.enabled || a.agent_type === agentType)}
      fallbackLabel={savedAgent?.label_snapshot.agent}
      disabled={disabled || saving}
    />
  )
  const options =
    agentType !== null ? (
      <RequiredOptionsSection
        gate={gate}
        loading={probe.loading}
        saved={agentTouched ? null : savedAgent}
        driftCount={driftCount}
        renderRow={renderRow}
        onRetry={() => probe.reload()}
      />
    ) : null
  // Outside the form: the editor's own submit, bubbling through its portal,
  // never saves this page.
  const executorEditor = editor ? (
    <AssistantEditorDialog
      open
      onOpenChange={(o) => {
        if (!o) setEditor(null)
      }}
      assistant={null}
      prefill={editor.prefill}
      extraSection={
        <p className="px-1 text-xs leading-5 text-muted-foreground">
          {tx("editorNote", { why: editor.why })}
        </p>
      }
      onSaved={(made) => {
        setEditor(null)
        setExecutor({ kind: "existing", id: made.id })
        void save(made.id)
      }}
    />
  ) : null

  if (!agent) {
    return (
      <SetupFrame
        face={avatar.kind === "face" ? avatar.color : null}
        onSubmit={() => void save()}
        identity={
          <SetupIdentity
            avatar={avatar}
            name={name}
            onAvatar={setAvatar}
            onName={setName}
            disabled={disabled || saving}
          />
        }
        agent={
          // Its agent: the tiles, its options under them once picked.
          <div
            className="w-full overflow-hidden rounded-2xl border border-border/70 bg-background/80"
            data-pa-setup-agent
          >
            <div className="flex flex-col gap-2.5 p-3">
              <p className="flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted-foreground">
                <Bot className="size-3.5" aria-hidden />
                {ta("agentLabel")}
              </p>
              <SetupAgentTiles
                value={agentType}
                onChange={pickAgent}
                agents={agents.filter((a) => a.enabled)}
                disabled={disabled || saving}
              />
            </div>
            {options ? (
              <div className="divide-y divide-border/60 border-t border-border/60">
                {options}
              </div>
            ) : null}
          </div>
        }
        start={
          // The line under [Chat] hangs below it, out of the flow: coming,
          // going or changing (a hint, a refusal), it moves nothing above.
          <div className="relative w-full">
            <Button
              type="submit"
              size="lg"
              disabled={disabled || saving}
              className="group/start h-11 w-full rounded-full text-[0.9375rem]"
              data-pa-setup-start
            >
              {saving ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <MessageCircle aria-hidden />
              )}
              {t("setupStart")}
              <ArrowRight
                className="transition-transform group-hover/start:translate-x-0.5 rtl:rotate-180 rtl:group-hover/start:-translate-x-0.5"
                aria-hidden
              />
            </Button>
            {disabled ? (
              <p
                className={`${UNDER_START} text-muted-foreground`}
                data-pa-setup-hint
              >
                {tPage("readOnly")}
              </p>
            ) : submitError || footerHint ? (
              <p
                className={cn(
                  UNDER_START,
                  submitError ? "text-destructive" : "text-muted-foreground"
                )}
                role={submitError ? "alert" : undefined}
                data-pa-setup-hint
              >
                {submitError ?? footerHint}
              </p>
            ) : null}
          </div>
        }
        overlay={executorEditor}
      />
    )
  }

  return (
    <>
      <form
        className="flex flex-col gap-3"
        data-pa-settings-page="identity"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <SettingCard>
          {/* Who it is: the avatar its messages carry and its name, side by
            side as in the assistant editor. A monogram is drawn from the
            name in effect — the default one while the field is empty. */}
          <div className="flex items-start gap-3 p-3">
            <div className="mt-0.5 shrink-0">
              <BotFacePicker
                value={avatar}
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
            control={agentPick}
          />
          {options}
        </SettingCard>
        {agentType !== null && agentType !== agent.agent_type ? (
          <SettingNote icon={Sparkles}>{t("switchNote")}</SettingNote>
        ) : null}
        <SettingCard>
          <SettingRow
            icon={Workflow}
            title={tx("title")}
            htmlFor="pa-executor"
            description={
              executorShown.kind === "none" || executorOff ? (
                <span
                  className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"
                  data-pa-executor-missing
                >
                  <AlertTriangle
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden
                  />
                  <span>{executorOff ? tx("disabled") : tx("missing")}</span>
                </span>
              ) : executorShown.kind === "new" ? (
                tx("newHint")
              ) : (
                tx("hint")
              )
            }
            control={
              <ExecutorPick
                id="pa-executor"
                value={executorShown}
                onChange={setExecutor}
                disabled={disabled || saving}
              />
            }
          />
        </SettingCard>
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
      {executorEditor}
    </>
  )
}
