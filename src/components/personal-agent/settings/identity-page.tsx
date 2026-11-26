"use client"

/**
 * "Identity & brain", the first tab of an assistant's own page: the agent
 * it thinks and talks on with every option picked (the assistant editor's
 * flow and validation), and under it the agent its work runs on, with its
 * options — two cards alike, each the agent picked with its model and
 * options under it (the brain's shown, the work's folded) — and the standing instructions its work
 * sessions get. The two agents are its own
 * apart (D1): one copied from the other when it was made, each changed on
 * its own since — changing the brain never changes its work. The mode and
 * permissions are chosen here, and codeg runs them as picked. Saved with
 * [Save] — switching the brain starts a new session. Its name and face are
 * the page's head's, saved there on their own.
 *
 * With no assistant yet, it is the first setup, the page's own screen: its
 * face, its name and its brain, the agent its work runs on — the same as
 * the brain (its default, copied with every option) or another one picked
 * — and [Chat with your assistant].
 *
 * One converted from the collaboration settings before there was a primary
 * has no brain yet: it gets a copy of the primary's when the primary is set
 * up, so there is none to pick here — only its work.
 */

import { useId, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  ChevronDown,
  Loader2,
  MessageCircle,
  ScrollText,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { AgentSelect } from "@/components/settings/agent-options-editor"
import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { personalAgentSave } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useBotId } from "@/contexts/personal-agent-context"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  MAX_WORK_INSTRUCTIONS_CHARS,
  type AgentType,
  type BotAvatar,
  type PersonalAgentDraft,
  type PersonalAgentInfo,
  type WorkChoice,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { SetupAgentTiles } from "./setup-agent-tiles"
import { SetupFrame } from "./setup-frame"
import { faceColorOf, PRIMARY_FACE } from "../bot-avatar"
import { SetupIdentity } from "./setup-identity"
import { useAgentConfig, type AgentConfigEditor } from "./use-agent-config"

/** The first setup's line under [Chat]: hung below it, taking no room —
 *  the frame's padding under it is its room — so nothing moves for it. */
const UNDER_START =
  "absolute inset-x-0 top-full mt-3 text-center text-xs leading-5"

/** One of its agents on the identity tab — its brain's or its work's: the
 *  agent picked, and under it its model and every option — folded at
 *  first unless `defaultOpen` (the brain's). They unfold when asked for,
 *  and on their own while they want a look (some still to pick, say) — and
 *  stay so until they no longer do. */
function AgentCard({
  icon,
  title,
  description,
  pick,
  editor,
  defaultOpen = false,
  ...props
}: {
  icon: LucideIcon
  title: ReactNode
  description: ReactNode
  /** The agent's picker. */
  pick: ReactNode
  editor: AgentConfigEditor
  defaultOpen?: boolean
} & React.ComponentProps<"div">) {
  const t = useTranslations("PersonalAgent.settings")
  const [open, setOpen] = useState(defaultOpen)
  const optionsId = useId()
  const held = editor.needsLook
  const shown = open || held
  return (
    <SettingCard {...props}>
      <SettingRow
        icon={icon}
        title={title}
        description={description}
        control={pick}
      />
      {editor.agentType !== null ? (
        <>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:bg-muted disabled:pointer-events-none"
            aria-expanded={shown}
            aria-controls={optionsId}
            disabled={held}
            onClick={() => setOpen(!open)}
            data-pa-agent-options-toggle
          >
            {t("agentOptions")}
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                shown && "rotate-180"
              )}
            />
          </button>
          {shown ? (
            <div
              id={optionsId}
              className="divide-y divide-border/60"
              data-pa-agent-options
            >
              {editor.options}
            </div>
          ) : null}
        </>
      ) : null}
    </SettingCard>
  )
}

/** How the agent a new assistant's work runs on is had (D1). */
type WorkMode = "same" | "other"

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
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const locale = useLocale()
  const { agents } = useAcpAgents()

  // The first setup's name and face; one set up has them on its page's
  // head.
  const [name, setName] = useState("")
  const [avatar, setAvatar] = useState<BotAvatar>(PRIMARY_FACE)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const busy = disabled || saving
  // The options still to pick, as the first setup says it ("Your agent has
  // 2 options to pick") or as the identity tab does.
  const missingText = (count: number) =>
    agent ? ta("missingCount", { count }) : t("setupMissing", { count })

  const savedBrain =
    agent?.agent_type && agent.agent_options && agent.label_snapshot
      ? {
          agent_type: agent.agent_type,
          agent_options: agent.agent_options,
          label_snapshot: agent.label_snapshot,
        }
      : null
  const brain = useAgentConfig({
    saved: savedBrain,
    revision: agent?.revision,
    disabled: busy,
    compact: !agent,
    missingText,
  })
  const work = useAgentConfig({
    saved: agent?.work ?? null,
    revision: agent?.revision,
    disabled: busy,
    compact: !agent,
    missingText,
  })
  // The first setup's work: the brain's, copied, unless another is picked.
  const [workMode, setWorkMode] = useState<WorkMode>("same")
  // Its work's standing instructions: as saved until edited here — an
  // edit in another window is shown, and never written back unedited. What
  // a save here answered stands for what is saved until the page's read of
  // the assistant catches up with it (by its revision).
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(
    null
  )
  const [savedHere, setSavedHere] = useState<{
    value: string
    revision: number
  } | null>(null)
  const instructionsSaved =
    savedHere && (agent?.revision ?? 0) < savedHere.revision
      ? savedHere.value
      : (agent?.work_instructions ?? "")
  const instructions = instructionsDraft ?? instructionsSaved
  const instructionsChanged =
    agent != null &&
    instructionsDraft !== null &&
    instructionsDraft !== instructionsSaved
  const noBrain = agent != null && agent.agent_type === null

  // The agent its work runs on cannot run now: not there, or turned off.
  const workInfo =
    work.agentType !== null
      ? (agents.find((a) => a.agent_type === work.agentType) ?? null)
      : null
  // Installed, as the agent picker reads it: available and a version.
  const workOff =
    agent != null &&
    agents.length > 0 &&
    (agent.work === null ||
      (!work.touched &&
        !(
          workInfo?.enabled &&
          workInfo.available &&
          workInfo.installed_version != null
        )))

  const save = async () => {
    if (saving || disabled) return
    setSubmitError(null)
    const draft: PersonalAgentDraft = { locale }
    if (!agent) {
      draft.name = name.trim()
      draft.avatar = avatar
    }
    // Only what changed: one left as saved is not sent (nor read again).
    if (!noBrain && (!agent || brain.touched)) {
      const b = brain.toSave()
      if (!b.ok) {
        setSubmitError(b.error)
        return
      }
      if (b.config) draft.agent_config = b.config
    }
    // What its work runs on: the first setup sends it always (the brain's
    // by default); later, only a change of it.
    let workChoice: WorkChoice | null = null
    if (!agent && workMode === "same") {
      workChoice = { kind: "same_as_brain" }
    } else if (!agent || work.touched) {
      const w = work.toSave()
      if (!w.ok) {
        setSubmitError(w.error)
        return
      }
      if (w.config) workChoice = { kind: "config", config: w.config }
      else if (!agent) {
        setSubmitError(ta("pickAgentFirst"))
        return
      }
    }
    if (workChoice) draft.work = workChoice
    // Counted as the backend counts them: by character, not UTF-16 unit.
    if ([...instructions].length > MAX_WORK_INSTRUCTIONS_CHARS) {
      setSubmitError(
        t("instructionsTooLong", { max: MAX_WORK_INSTRUCTIONS_CHARS })
      )
      return
    }
    if (instructionsChanged) draft.work_instructions = instructions
    setSaving(true)
    try {
      // No settings ride along: the other pages save theirs item by item,
      // and a save here never takes one of them back.
      const saved = await personalAgentSave(draft, botId)
      brain.settle()
      work.settle()
      setSavedHere({
        value: saved.work_instructions,
        revision: saved.revision,
      })
      setInstructionsDraft(null)
      // The first setup says so by opening its conversation — whatever page
      // was asked for on the way in (a link to its persona, say): it shows
      // once there is an assistant.
      if (agent) toast.message(t("saved"))
      else usePersonalAgentUi.getState().showConversation()
      onSaved?.()
    } catch (error) {
      setSubmitError(toErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const footerHint =
    brain.missingHint ??
    (!agent && workMode === "same" ? null : work.missingHint)

  // The agents to pick from: the ones turned on, and the one it is on.
  const offered = (current: AgentType | null) =>
    agents.filter((a) => a.enabled || a.agent_type === current)
  const workOffered = offered(work.agentType)
  const workPick = (
    <AgentSelect
      value={work.agentType}
      onChange={work.pickAgent}
      agents={workOffered}
      fallbackLabel={work.saved?.label_snapshot.agent}
      disabled={busy}
    />
  )
  const workLabel = (agentType: AgentType | null) =>
    agentType ? (getAgentLabel(agentType) ?? agentType) : ""

  // The agent its work runs on, as the first setup asks it: the brain's,
  // or another picked — its options under it then.
  const setupWork = (
    <div className="flex flex-col gap-2.5 border-t border-border/60 p-3">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Workflow className="size-3.5" aria-hidden />
          {t("workTitle")}
        </p>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={workMode}
          onValueChange={(v) => {
            if (v === "same" || v === "other") setWorkMode(v)
          }}
          disabled={busy}
          data-pa-setup-work
        >
          <ToggleGroupItem value="same" data-pa-setup-work-mode="same">
            {t("workSame")}
          </ToggleGroupItem>
          <ToggleGroupItem value="other" data-pa-setup-work-mode="other">
            {t("workOther")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {workMode === "same" ? (
        <p className="px-0.5 text-xs leading-5 text-muted-foreground">
          {t("workSameHint")}
        </p>
      ) : (
        <div className="flex">{workPick}</div>
      )}
    </div>
  )

  if (!agent) {
    return (
      <SetupFrame
        face={faceColorOf(avatar)}
        onSubmit={() => void save()}
        identity={
          <SetupIdentity
            avatar={avatar}
            name={name}
            onAvatar={setAvatar}
            onName={setName}
            disabled={busy}
          />
        }
        agent={
          // Its brain: the tiles, its options under them once picked; then
          // the agent its work runs on.
          <div
            className="w-full overflow-hidden rounded-2xl border border-border/70 bg-background/80"
            data-pa-setup-agent
          >
            <div className="flex flex-col gap-2.5 p-3">
              <p className="flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted-foreground">
                <Brain className="size-3.5" aria-hidden />
                {t("setupBrainAgent")}
              </p>
              <SetupAgentTiles
                value={brain.agentType}
                onChange={brain.pickAgent}
                agents={agents.filter((a) => a.enabled)}
                disabled={busy}
              />
            </div>
            {brain.options ? (
              <div className="divide-y divide-border/60 border-t border-border/60">
                {brain.options}
              </div>
            ) : null}
            {setupWork}
            {workMode === "other" && work.options ? (
              <div className="divide-y divide-border/60 border-t border-border/60">
                {work.options}
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
              disabled={busy}
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
      />
    )
  }

  return (
    <form
      className="flex flex-col gap-3"
      data-pa-settings-page="identity"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      {noBrain ? (
        <SettingNote icon={Brain}>{t("noBrainYet")}</SettingNote>
      ) : (
        <AgentCard
          icon={Brain}
          title={t("setupBrainAgent")}
          description={
            brain.agentType === null ? ta("pickAgentFirst") : t("agentHint")
          }
          pick={
            <AgentSelect
              value={brain.agentType}
              onChange={brain.pickAgent}
              agents={offered(brain.agentType)}
              fallbackLabel={brain.saved?.label_snapshot.agent}
              disabled={busy}
            />
          }
          editor={brain}
          defaultOpen
          data-pa-identity-brain
        />
      )}
      {brain.agentType !== null &&
      agent.agent_type !== null &&
      brain.agentType !== agent.agent_type ? (
        <SettingNote icon={Sparkles}>{t("switchNote")}</SettingNote>
      ) : null}
      <AgentCard
        icon={Workflow}
        title={t("workTitle")}
        description={
          workOff ? (
            <span
              className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"
              data-pa-work-off
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {t("workUnavailable", {
                  agent:
                    agent.work?.label_snapshot.agent ??
                    workLabel(work.agentType),
                })}
              </span>
            </span>
          ) : (
            t("workHint")
          )
        }
        pick={workPick}
        editor={work}
        data-pa-identity-work
      />
      <SettingCard data-pa-identity-instructions>
        <SettingRow
          icon={ScrollText}
          title={t("instructionsTitle")}
          htmlFor="pa-work-instructions"
          description={t("instructionsHint")}
        >
          <Textarea
            id="pa-work-instructions"
            dir="auto"
            value={instructions}
            rows={4}
            placeholder={t("instructionsPlaceholder")}
            onChange={(e) => setInstructionsDraft(e.target.value)}
            disabled={busy}
            className="min-h-20 resize-y bg-background text-sm"
            data-pa-work-instructions
          />
        </SettingRow>
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
        <Button type="submit" size="sm" disabled={busy}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("save")}
        </Button>
      </div>
    </form>
  )
}
