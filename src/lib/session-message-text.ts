export const sessionMessageHeader =
  /^\[Codeg message from conversation (\d+)(?:; message ([\da-f-]{36})| \([^\r\n]*\) to you, conversation \d+ \([^\r\n]*\))?\]\r?\n\r?\n/
const automaticReplyHeader =
  /^\[Automatic reply from session (\d+)(?:; replying to ([\da-f-]{36}))?\]\r?\n\r?\n/

export type SessionMessageAnchor = {
  kind: "send" | "reply"
  messageId: string
}

export function parseSessionMessageText(text: string): {
  source: string
  text: string
  anchor?: SessionMessageAnchor
} | null {
  const source = text.match(sessionMessageHeader)
  const body = text.slice(source?.[0].length ?? 0)
  const reply = body.match(automaticReplyHeader)
  const match = source ?? reply
  if (!match) return null

  const messageId = (reply ?? match)[2]
  return {
    source: match[1]!,
    text: body
      .slice(reply?.[0].length ?? 0)
      .replace(/^(?:[^\S\r\n]*\r?\n)+/, ""),
    ...(messageId && { anchor: { kind: reply ? "reply" : "send", messageId } }),
  }
}
