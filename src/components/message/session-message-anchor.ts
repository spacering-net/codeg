import { create } from "zustand"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { mcpResultPayload } from "@/lib/activity/mcp"

export const sessionMessageHeader =
  /^\[Codeg message from conversation (\d+)(?:; message ([\da-f-]{36})| \([^\r\n]*\) to you, conversation \d+ \([^\r\n]*\))?\]\r?\n\r?\n/
export const automaticReplyHeader =
  /^\[Automatic reply from session (\d+)(?:; replying to ([\da-f-]{36}))?\]\r?\n\r?\n/

export type SessionMessageAnchor = {
  kind: "send" | "reply"
  messageId: string
}

type Jump = { conversationId: number; anchor: SessionMessageAnchor }

export const useSessionMessageJump = create<{ pending: Jump | null }>(() => ({
  pending: null,
}))

export function findSessionMessageSource(
  groups: ReadonlyArray<{
    role: "user" | "assistant" | "system"
    parts: AdaptedContentPart[]
  } | null>,
  anchor: SessionMessageAnchor
): number {
  let repliedTo = false
  return groups.findIndex((group) => {
    if (!group) return false
    if (anchor.kind === "reply") {
      if (group.role === "assistant" && repliedTo) return true
      repliedTo =
        group.role === "user" &&
        group.parts.some(
          (part) =>
            part.type === "text" &&
            sessionMessageHeader.exec(part.text)?.[2] === anchor.messageId
        )
      return false
    }
    return group.parts.some((part) => {
      if (part.type !== "tool-call" || !part.output?.includes(anchor.messageId))
        return false
      const output = mcpResultPayload(part.output)?.json
      return (
        output != null &&
        typeof output === "object" &&
        "message_id" in output &&
        output.message_id === anchor.messageId
      )
    })
  })
}
