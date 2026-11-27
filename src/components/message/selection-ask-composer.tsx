"use client"

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { X } from "lucide-react"

import { useAgentOptions } from "@/components/automations/use-agent-options"
import { AgentSelector } from "@/components/chat/agent-selector"
import {
  MessageInput,
  type ComposerInjectContent,
} from "@/components/chat/message-input"
import { referenceToMarkdown } from "@/components/chat/composer/reference-text"
import { buildQuotedMarkdown } from "@/lib/message-quote"
import {
  getSavedModeId,
  getSavedPrefsForConnect,
} from "@/lib/selector-prefs-storage"
import type {
  AgentOptionsSnapshot,
  AgentType,
  AvailableCommandInfo,
  PromptCapabilitiesInfo,
  PromptDraft,
  SessionConfigOptionInfo,
} from "@/lib/types"

/** The conversation an ask mentions: the one the selection was made in. */
export interface SelectionAskMention {
  conversationId: number
  /** Shown on the badge — the conversation's title, or `#id` without one. */
  label: string
}

/**
 * What the ask composer opens holding: the selection as a quote, then on the
 * next line a mention of the conversation it was selected in, then a space for
 * the caret — so the user types the question straight after the mention.
 *
 * The mention is the same `codeg://session/<id>` reference the `@` panel
 * inserts, which the composer hydrates back into a badge and the agent can
 * resolve with `get_session_info`. A selection with no visible content leaves
 * only the mention.
 */
export function buildAskComposerText(
  selection: string,
  mention: SelectionAskMention
): string {
  const quoted = buildQuotedMarkdown(selection)
  const reference = referenceToMarkdown({
    refType: "session",
    id: String(mention.conversationId),
    label: mention.label,
    uri: `codeg://session/${mention.conversationId}`,
    meta: null,
  })
  return quoted ? `${quoted}\n${reference} ` : `${reference} `
}

/**
 * What the conversation the selection was made in already knows about its own
 * agent: while the ask stays on that agent, its composer uses these until the
 * probe has answered. Its modes and config options are deliberately NOT among
 * them — their current values are that conversation's own picks (a permission
 * mode among them), and the ask is a new conversation, which starts from the
 * agent's defaults.
 */
export interface SelectionAskLiveSelectors {
  availableCommands: AvailableCommandInfo[] | null
  promptCapabilities: PromptCapabilitiesInfo
}

/** Who answers the ask, and how it starts. */
export interface SelectionAskPick {
  agentType: AgentType
  /** The standalone mode pick (an agent with modes but no config options). */
  modeId: string | null
  /** Every config option as the composer showed it, plus any pick it could
   *  not show yet (a re-probe for a picked model still on its way) — the new
   *  conversation's connection starts from these, over the agent's saved
   *  new-conversation default. A value the agent turns out not to offer is
   *  skipped by the backend at connect. */
  configValues: Record<string, string>
}

/** What a prompt is assumed to accept before the picked agent has said:
 *  nothing beyond text, so a pasted image lands as a file badge rather than as
 *  an image block the agent may refuse. */
const NO_PROMPT_CAPABILITIES: PromptCapabilitiesInfo = {
  image: false,
  audio: false,
  embedded_context: false,
}

/** Whether `value` is one the option can take. */
export function configOptionOffers(
  option: SessionConfigOptionInfo,
  value: string
): boolean {
  if (option.kind.type === "boolean")
    return value === "true" || value === "false"
  return (
    option.kind.options.some((o) => o.value === value) ||
    option.kind.groups.some((g) => g.options.some((o) => o.value === value))
  )
}

/** The option's current value, in the string form a pick is made in. */
function configOptionValue(option: SessionConfigOptionInfo): string {
  return option.kind.type === "boolean"
    ? String(option.kind.current_value)
    : option.kind.current_value
}

/**
 * The options as the ask composer shows them: each on the user's pick in this
 * composer, else the agent's saved new-conversation default (what a draft
 * conversation starts from), else what the source reports — skipping a value
 * the option no longer offers.
 */
export function askConfigOptions(
  options: SessionConfigOptionInfo[],
  saved: Record<string, string>,
  picks: Record<string, string>
): SessionConfigOptionInfo[] {
  return options.map((option) => {
    const pick = [picks[option.id], saved[option.id]].find(
      (value) => value != null && configOptionOffers(option, value)
    )
    if (pick == null || pick === configOptionValue(option)) return option
    return option.kind.type === "boolean"
      ? { ...option, kind: { ...option.kind, current_value: pick === "true" } }
      : { ...option, kind: { ...option.kind, current_value: pick } }
  })
}

interface SelectionAskComposerProps {
  selection: string
  mention: SelectionAskMention
  /** The agent the ask starts on: the conversation's own. */
  defaultAgentType: AgentType
  /** The conversation's own selectors for `defaultAgentType`, when it has
   *  them. */
  live?: SelectionAskLiveSelectors | null
  /** cwd for the `@` file search, disk skills and the agent probe. */
  defaultPath?: string
  /** Hand the draft over. `false` when the host couldn't take it now: the
   *  composer (which cleared itself as it sent) gets the draft back. */
  onSubmit: (draft: PromptDraft, pick: SelectionAskPick) => boolean
  onClose: () => void
}

/**
 * The conversation composer, in the transcript's selection bubble: the "ask
 * about this selection" draft. It is the same `MessageInput` the conversation
 * page uses — badges, `@` mentions, attachments, the "+" menu, the agent's
 * settings chip — with no connection behind it: the conversation the question
 * goes to doesn't exist yet, so sending hands the draft to the host, which
 * opens the ask conversation and sends it there once its agent is up.
 *
 * Laid out like the to-do board's new-task dialog: the agent pill row above
 * the composer (starting on the conversation's own agent), and the picked
 * agent's modes, options and slash commands in the box, from the same
 * transient probe the task dialog runs (`useAgentOptions`). On the
 * conversation's own agent its live commands fill in meanwhile.
 *
 * Unscoped on purpose (`attachmentTabId` null, no draft storage): the
 * attach-to-tab events and the draft of the conversation behind it belong to
 * that conversation's own composer, not to this one.
 */
export function SelectionAskComposer({
  selection,
  mention,
  defaultAgentType,
  live,
  defaultPath,
  onSubmit,
  onClose,
}: SelectionAskComposerProps) {
  const t = useTranslations("Folder.chat.messageList")
  const [inject, setInject] = useState<ComposerInjectContent | null>(() => ({
    text: buildAskComposerText(selection, mention),
    mode: "replace",
  }))
  const handleInjectConsumed = useCallback(() => setInject(null), [])
  const [agentType, setAgentType] = useState<AgentType>(defaultAgentType)
  // A new conversation starts from the agent's new-conversation default, as a
  // draft tab does.
  const [modeId, setModeId] = useState<string | null>(() =>
    getSavedModeId(defaultAgentType)
  )
  // The config picks made in this composer. Never written to the saved
  // default: they shape this one ask only.
  const [picks, setPicks] = useState<Record<string, string>>({})
  const switchAgent = useCallback(
    (next: AgentType) => {
      if (next === agentType) return
      setAgentType(next)
      setModeId(getSavedModeId(next))
      setPicks({})
    },
    [agentType]
  )

  const saved = useMemo(
    () => getSavedPrefsForConnect(agentType).configValues ?? {},
    [agentType]
  )
  const sameAgent = agentType === defaultAgentType && live != null
  // The agent's options are always probed, as the new-task dialog does: only
  // a probe reports the values a NEW conversation of this agent starts from.
  // Only `model` is read: the probe applies it first, so the options derived
  // from the model (OpenCode's per-model effort) match the one shown.
  const probeValues = useMemo(() => ({ ...saved, ...picks }), [saved, picks])
  const probe = useAgentOptions(
    agentType,
    defaultPath ?? null,
    true,
    probeValues
  )
  // Only an answer for the agent AND model on screen: a previous model's
  // (still shown during the re-probe's debounce) would send its option values
  // — an effort the user never picked — with the new model.
  const snapshot = probe.current ? probe.snapshot : null
  const probing = !probe.current && probe.error == null
  const sourceOptions = snapshot?.config_options ?? null
  const configOptions = useMemo(
    () => askConfigOptions(sourceOptions ?? [], saved, picks),
    [sourceOptions, saved, picks]
  )
  // From the probe only: until it answers, whether the agent's mode is a
  // config option is unknown, and a standalone pick sent meanwhile would be
  // pushed over the mode the connection starts in.
  const modes = snapshot?.modes?.available_modes ?? null
  // What the agent takes and offers doesn't move with the model, so these
  // read the last answer from THIS agent — kept here because the probe hook
  // drops its snapshot while a re-probe for another model is in flight, and
  // that must not take the image capability out from under an image already
  // attached.
  const [lastAnswer, setLastAnswer] = useState<{
    agentType: AgentType
    snapshot: AgentOptionsSnapshot
  } | null>(null)
  const answered = probe.snapshotAgentType === agentType ? probe.snapshot : null
  if (answered && lastAnswer?.snapshot !== answered) {
    setLastAnswer({ agentType, snapshot: answered })
  }
  const agentSnapshot =
    answered ??
    (lastAnswer?.agentType === agentType ? lastAnswer.snapshot : null)
  const availableCommands =
    sameAgent && live.availableCommands != null
      ? live.availableCommands
      : (agentSnapshot?.available_commands ?? null)
  const promptCapabilities =
    agentSnapshot?.prompt_capabilities ??
    (sameAgent ? live.promptCapabilities : NO_PROMPT_CAPABILITIES)

  const handleConfigOptionChange = useCallback(
    (configId: string, valueId: string) =>
      setPicks((prev) => ({ ...prev, [configId]: valueId })),
    []
  )
  const handleSend = useCallback(
    (draft: PromptDraft, selectedModeId?: string | null) => {
      const configValues: Record<string, string> = { ...picks }
      for (const option of configOptions) {
        configValues[option.id] = configOptionValue(option)
      }
      const pick: SelectionAskPick = {
        agentType,
        modeId: selectedModeId ?? null,
        configValues,
      }
      if (!onSubmit(draft, pick)) {
        setInject({ handBack: draft.blocks })
      }
    },
    [agentType, configOptions, onSubmit, picks]
  )

  return (
    <div className="relative flex flex-col gap-1.5">
      <div className="flex min-w-0 px-0.5 pt-0.5">
        <AgentSelector
          defaultAgentType={agentType}
          onSelect={switchAgent}
          onFallback={switchAgent}
        />
      </div>
      <MessageInput
        onSend={handleSend}
        placeholder={t("selectionAskPlaceholder")}
        defaultPath={defaultPath}
        agentType={agentType}
        promptCapabilities={promptCapabilities}
        modes={modes ?? undefined}
        configOptions={configOptions}
        modeLoading={probing}
        configOptionsLoading={probing}
        selectedModeId={modeId}
        onModeChange={setModeId}
        onConfigOptionChange={handleConfigOptionChange}
        availableCommands={availableCommands}
        commandsLoading={probing}
        attachmentTabId={null}
        draftStorageKey={null}
        isActive
        autoFocus
        injectContent={inject}
        onInjectConsumed={handleInjectConsumed}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label={t("selectionAskClose")}
        title={t("selectionAskClose")}
        className="absolute -top-2 -right-2 z-10 inline-flex size-5 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm transition-colors hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
