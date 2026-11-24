"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { X } from "lucide-react"

import {
  MessageInput,
  type ComposerInjectContent,
} from "@/components/chat/message-input"
import { referenceToMarkdown } from "@/components/chat/composer/reference-text"
import { buildQuotedMarkdown } from "@/lib/message-quote"
import { getSavedModeId } from "@/lib/selector-prefs-storage"
import type {
  AgentType,
  PromptCapabilitiesInfo,
  PromptDraft,
  SessionModeInfo,
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

interface SelectionAskComposerProps {
  selection: string
  mention: SelectionAskMention
  agentType: AgentType
  promptCapabilities: PromptCapabilitiesInfo
  /** The agent's modes, when known — the new conversation's first send applies
   *  the pick. Omitted, the composer shows no mode chip. */
  modes?: SessionModeInfo[] | null
  /** cwd for the `@` file search and disk skills. */
  defaultPath?: string
  /** Hand the draft over. `false` when the host couldn't take it now: the
   *  composer (which cleared itself as it sent) gets the draft back. */
  onSubmit: (draft: PromptDraft, modeId: string | null) => boolean
  onClose: () => void
}

/**
 * The conversation composer, in the transcript's selection bubble: the "ask
 * about this selection" draft. It is the same `MessageInput` the conversation
 * page uses — badges, `@` mentions, attachments, mode chip — with no
 * connection behind it: the conversation the question goes to doesn't exist
 * yet, so sending hands the draft to the host, which opens the ask
 * conversation and sends it there once its agent is up.
 *
 * Unscoped on purpose (`attachmentTabId` null, no draft storage): the
 * attach-to-tab events and the draft of the conversation behind it belong to
 * that conversation's own composer, not to this one.
 */
export function SelectionAskComposer({
  selection,
  mention,
  agentType,
  promptCapabilities,
  modes,
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
  // A new conversation starts from the agent's new-conversation default, as a
  // draft tab does.
  const [modeId, setModeId] = useState<string | null>(() =>
    getSavedModeId(agentType)
  )
  const handleSend = useCallback(
    (draft: PromptDraft, selectedModeId?: string | null) => {
      if (!onSubmit(draft, selectedModeId ?? null)) {
        setInject({ handBack: draft.blocks })
      }
    },
    [onSubmit]
  )

  return (
    <div className="relative">
      <MessageInput
        onSend={handleSend}
        placeholder={t("selectionAskPlaceholder")}
        defaultPath={defaultPath}
        agentType={agentType}
        promptCapabilities={promptCapabilities}
        modes={modes ?? undefined}
        selectedModeId={modeId}
        onModeChange={setModeId}
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
