"use client"

/**
 * Who a delegation card says ran the task, drawn the same way on every surface
 * that shows one: the session drawer's header, the top-right overlay, and the
 * status rings of the activity timeline and the Session
 * Details navigator.
 *
 * An assistant shows its own avatar with a small badge of the agent it ran on,
 * and its name followed by a muted "· Agent"; a bare agent shows the agent's
 * icon and name, as before. The assistant is the owner's one on the roster:
 * by its uid, or — a task from before them — the one converted from the
 * collaboration settings' assistant it ran as, else that assistant as the
 * assistants store has it. The name follows one fallback order everywhere:
 * that row (a deleted one marked so), then the name snapshot the delegation
 * carried, then "Assistant #id". Until the backend says which agent an
 * assistant ran on there is no agent badge and no "· Agent" — never a guess
 * from the call's own `agent_type`.
 *
 * `identity` is required on both pieces so a surface cannot quietly fall back
 * to drawing the bare agent.
 */

import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { BotAvatar } from "@/components/personal-agent/bot-avatar"
import type { DelegationIdentity } from "@/hooks/use-delegation-card-model"
import { getAgentLabel } from "@/lib/custom-agents"
import type { AssistantAvatar, BotAvatar as BotAvatarValue } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAssistant } from "@/stores/assistants-store"
import { usePersonalAgentRoster } from "@/stores/personal-agent-roster-store"

/** The assistant a delegation ran as, as this window has it. */
export interface IdentityAssistant {
  avatar: BotAvatarValue | AssistantAvatar | null
  /** Its name now; null when nothing here knows it. */
  name: string | null
  /** Deleted (or not on this device's roster any more). */
  deleted: boolean
  primary: boolean
}

/** Who ran a delegation, by the order the file's comment gives; `null` for a
 *  plain agent delegation. */
export function useIdentityAssistant(
  identity: Pick<DelegationIdentity, "assistantId" | "botUid">
): IdentityAssistant | null {
  const t = useTranslations("PersonalAgent")
  // Read, not held: the workspace holds the roster (its sidebar, the open
  // bridge); a card anywhere must not start reading it.
  const roster = usePersonalAgentRoster((s) => s.entries)
  const legacyId = identity.botUid ? null : (identity.assistantId ?? null)
  const legacy = useAssistant(legacyId)
  if (!identity.botUid && identity.assistantId == null) return null
  const bot = identity.botUid
    ? roster?.find((e) => e.uid === identity.botUid)
    : roster?.find((e) => e.legacy_assistant_id === legacyId)
  if (bot) {
    return {
      avatar: bot.avatar,
      // As its page names it: the primary with no name of its own by its
      // role, a work assistant with none by its number.
      name:
        bot.name.trim() || (bot.kind === "primary" ? t("title") : `#${bot.id}`),
      deleted: false,
      primary: bot.kind === "primary",
    }
  }
  if (identity.botUid) {
    return { avatar: null, name: null, deleted: roster != null, primary: false }
  }
  return {
    avatar: legacy?.avatar ?? null,
    name: legacy?.name || null,
    deleted: legacy?.deleted_at != null,
    primary: false,
  }
}

/** Whether an identity is an assistant's (else a bare agent's). */
function isAssistantIdentity(identity: DelegationIdentity): boolean {
  // Loosely: an identity built before `botUid` existed has none at all.
  return identity.botUid != null || identity.assistantId != null
}

export type DelegationIdentitySize = "header" | "overlay"

const AVATAR: Record<
  DelegationIdentitySize,
  {
    px: number
    box: string
    agentIcon: string
    placeholder: string
    corner: string
    cornerIcon: string
  }
> = {
  // The session drawer header's 28px tile.
  header: {
    px: 28,
    box: "h-7 w-7 rounded-md",
    agentIcon: "h-4 w-4",
    placeholder: "h-2 w-2",
    corner: "h-3.5 w-3.5",
    cornerIcon: "h-2 w-2",
  },
  // The overlay row's 20px dot.
  overlay: {
    px: 20,
    box: "h-5 w-5 rounded-full",
    agentIcon: "h-3.5 w-3.5",
    placeholder: "h-1.5 w-1.5",
    corner: "h-2.5 w-2.5",
    cornerIcon: "h-1.5 w-1.5",
  },
}

export interface DelegationIdentityAvatarProps {
  identity: DelegationIdentity
  size: DelegationIdentitySize
}

export function DelegationIdentityAvatar({
  identity,
  size,
}: DelegationIdentityAvatarProps) {
  const shape = AVATAR[size]
  const assistant = useIdentityAssistant(identity)
  const isAssistant = isAssistantIdentity(identity)
  return (
    <span className="relative inline-flex shrink-0">
      {isAssistant ? (
        <>
          <BotAvatar
            avatar={assistant?.avatar ?? null}
            name={assistant?.name ?? identity.assistantName ?? ""}
            size={shape.px}
            star={assistant?.primary}
            className={size === "header" ? "rounded-md" : undefined}
          />
          {identity.agentType ? (
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 inline-flex items-center justify-center rounded-full border border-border bg-background text-foreground",
                shape.corner
              )}
            >
              <AgentIcon
                agentType={identity.agentType}
                className={shape.cornerIcon}
              />
            </span>
          ) : null}
        </>
      ) : (
        <span
          className={cn(
            "inline-flex items-center justify-center border border-border bg-background text-foreground",
            shape.box
          )}
        >
          {identity.agentType ? (
            <AgentIcon
              agentType={identity.agentType}
              className={shape.agentIcon}
            />
          ) : (
            <span
              className={cn(
                "rounded-sm bg-muted-foreground/60",
                shape.placeholder
              )}
            />
          )}
        </span>
      )}
    </span>
  )
}

/** The agent's logo — or the assistant's avatar — sized to sit inside a 20px
 *  status ring (`RailIcon`): a delegation's row in the activity timeline, and
 *  a sub-agent of a message in the Session Details navigator. */
export function DelegationIdentityGlyph({
  identity,
}: {
  identity: DelegationIdentity
}) {
  const assistant = useIdentityAssistant(identity)
  if (isAssistantIdentity(identity)) {
    return (
      <BotAvatar
        avatar={assistant?.avatar ?? null}
        name={assistant?.name ?? identity.assistantName ?? ""}
        size={14}
      />
    )
  }
  return identity.agentType ? (
    <AgentIcon agentType={identity.agentType} className="size-3" />
  ) : (
    <span className="size-1.5 rounded-sm bg-muted-foreground/60" />
  )
}

/** The name an identity reads as, by the fallback order above, and whether
 *  the assistant has been deleted. */
export function useDelegationIdentityLabel(identity: DelegationIdentity): {
  name: string
  deleted: boolean
} {
  const t = useTranslations("Folder.chat.delegation")
  const assistant = useIdentityAssistant(identity)
  if (!isAssistantIdentity(identity)) {
    return {
      name: identity.agentType
        ? getAgentLabel(identity.agentType)
        : t("unknownAgent"),
      deleted: false,
    }
  }
  return {
    name:
      assistant?.name ||
      identity.assistantName ||
      t("unknownAssistant", {
        id: identity.assistantId ?? identity.botUid ?? "",
      }),
    deleted: assistant?.deleted ?? false,
  }
}

export interface DelegationIdentityNameProps {
  identity: DelegationIdentity
  /** The name's own text style — size, weight and whether it truncates
   *  differ per surface, so each keeps the look it always had. */
  className?: string
}

/** The identity's name: the agent's, or the assistant's with "(deleted)" and
 *  a muted "· Agent" once the agent it ran on is known. */
export function DelegationIdentityName({
  identity,
  className,
}: DelegationIdentityNameProps) {
  const t = useTranslations("Folder.chat.delegation")
  const { name, deleted } = useDelegationIdentityLabel(identity)
  if (!isAssistantIdentity(identity)) {
    return <span className={className}>{name}</span>
  }
  return (
    <span className={className}>
      {name}
      {deleted ? (
        <span className="font-normal text-muted-foreground">
          {" "}
          {t("deletedAssistant")}
        </span>
      ) : null}
      {identity.agentType ? (
        <span className="font-normal text-muted-foreground">
          {" · "}
          {getAgentLabel(identity.agentType)}
        </span>
      ) : null}
    </span>
  )
}
