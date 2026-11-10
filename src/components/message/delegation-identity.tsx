"use client"

/**
 * Who a delegation card says ran the task, drawn the same way on every surface
 * that shows one: the session drawer's header, the top-right overlay, and the
 * status rings of the activity timeline and the Session
 * Details navigator.
 *
 * An assistant shows its own avatar with a small badge of the agent it ran on,
 * and its name followed by a muted "· Agent"; a bare agent shows the agent's
 * icon and name, as before. The name follows one fallback order everywhere:
 * the assistants store's row (a deleted one included, marked so), then the
 * name snapshot the delegation carried, then "Assistant #id". Until the backend
 * says which agent an assistant ran on there is no agent badge and no
 * "· Agent" — never a guess from the call's own `agent_type`.
 *
 * `identity` is required on both pieces so a surface cannot quietly fall back
 * to drawing the bare agent.
 */

import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import type { DelegationIdentity } from "@/hooks/use-delegation-card-model"
import { getAgentLabel } from "@/lib/custom-agents"
import { cn } from "@/lib/utils"
import { useAssistant } from "@/stores/assistants-store"

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
  const assistant = useAssistant(identity.assistantId)
  const isAssistant = identity.assistantId !== null
  return (
    <span className="relative inline-flex shrink-0">
      {isAssistant ? (
        <>
          <AssistantAvatar
            avatar={assistant?.avatar ?? null}
            name={assistant?.name ?? identity.assistantName ?? ""}
            size={shape.px}
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
  const assistant = useAssistant(identity.assistantId)
  if (identity.assistantId !== null) {
    return (
      <AssistantAvatar
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
  const assistant = useAssistant(identity.assistantId)
  if (identity.assistantId === null) {
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
      t("unknownAssistant", { id: identity.assistantId }),
    deleted: assistant?.deleted_at != null,
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
  if (identity.assistantId === null) {
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
