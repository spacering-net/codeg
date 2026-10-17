"use client"

/**
 * Viewer for a delegated sub-agent's full conversation.
 *
 * Opens from `DelegatedSubThread`'s header. The whole read-only streaming
 * surface — the shared `MessageListView`, the live bridge into the runtime
 * session, and the child's blocking prompts (permission / ask_user_question /
 * plan approval, answered through the CHILD connection id) — lives in
 * `LiveTranscriptView`; this file only owns the Drawer chrome and header.
 * No attach lifecycle here: delegation children are attached by the
 * delegation provider for the parent card, and the connection registration
 * outlives this drawer.
 *
 * A side drawer rather than a modal dialog, for two reasons:
 *
 *  - It is consulted WHILE working in the conversation that spawned the child.
 *    The wrapper's non-modal default keeps the thread behind it readable and
 *    clickable, and its `disablePointerDismissal` default keeps that from
 *    costing the drawer its life on the first click.
 *  - It nests into itself. The transcript it renders contains that child's own
 *    `delegate_to_agent` cards, each with its own "查看会话" — so a grandchild
 *    viewer mounts INSIDE this one's React tree and Base UI stacks it (parent
 *    scales back, its content fades, Escape unwinds one layer at a time).
 *    A modal dialog has no such stack: the second one simply buried the first.
 */

import { useTranslations } from "next-intl"

import {
  DelegationIdentityAvatar,
  DelegationIdentityName,
} from "@/components/message/delegation-identity"
import { LiveTranscriptView } from "@/components/message/live-transcript-view"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  SIDE_PANEL_CONTENT_CLASS,
} from "@/components/ui/drawer"
import type { DelegationIdentity } from "@/hooks/use-delegation-card-model"
import { useHistoryBackDismiss } from "@/hooks/use-history-back-dismiss"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  childConversationId: number
  childConnectionId: string | null
  /** Who ran the task — titles the drawer; its agent drives the transcript. */
  identity: DelegationIdentity
  /**
   * The parent's `delegate_to_agent` task text — the child's kickoff prompt,
   * known synchronously in the card. Surfaced so the kickoff user turn can be
   * shown immediately while the child's persisted transcript still lags the
   * live stream (the agent CLI writes its JSONL asynchronously).
   */
  kickoffTask?: string | null
}

export function SubAgentSessionDialog({
  open,
  onOpenChange,
  childConversationId,
  childConnectionId,
  identity,
  kickoffTask,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")
  // The drawer is a state toggle, not a route: without a history entry behind
  // it, the back gesture unloads the whole page instead of closing the panel.
  useHistoryBackDismiss(open, () => onOpenChange(false))

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      {/* An x-axis drawer is already `inset-y-0`, so the old dialog's explicit
          height goes away; the width comes from the shared side-panel shape so
          this stacks flush with whatever it opened over. */}
      <DrawerContent
        closeButtonClassName="top-2.5 right-3"
        className={SIDE_PANEL_CONTENT_CLASS}
      >
        <DrawerTitle className="sr-only">{t("detailTitle")}</DrawerTitle>
        <DrawerDescription className="sr-only">
          {t("detailDescription")}
        </DrawerDescription>
        {open ? (
          <div className="flex h-full min-h-0 flex-col">
            {/* `px-4` and not `px-5`: the transcript below insets its rows by
                16px, so anything else here leaves the header's icon hanging off
                the column it titles. `pr-12` clears the close button. */}
            <div className="flex items-center gap-3 border-b border-border px-4 py-2.5 pr-12">
              <DelegationIdentityAvatar identity={identity} size="header" />
              <DelegationIdentityName
                identity={identity}
                className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
              />
            </div>
            <LiveTranscriptView
              conversationId={childConversationId}
              connectionId={childConnectionId}
              agentType={identity.agentType}
              kickoffText={kickoffTask}
            />
          </div>
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}
