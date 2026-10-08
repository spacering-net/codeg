import type { MessageTurn } from "@/lib/types"

/** Parser ids are positional; text alone also cannot identify repeated prompts. */
function sameUserContent(a: MessageTurn, b: MessageTurn): boolean {
  const normalize = (turn: MessageTurn) => ({
    text:
      turn.prompt_text ??
      turn.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    images: turn.blocks
      .filter((block) => block.type === "image")
      .map((block) => ({ data: block.data, mime_type: block.mime_type })),
  })
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

/**
 * Resolve the clicked message against a fresh FULL parse before mutating a
 * session. Local user messages have client UUIDs, not the parser's turn-N ids.
 * A local match must be unique in both content and a small persistence-time
 * window; if the parser is behind or identity is ambiguous, retry later.
 */
export function resolveEditableUserTurn(
  selected: MessageTurn,
  persisted: readonly MessageTurn[],
  context?: { timeline: readonly MessageTurn[]; loadedFromStart: boolean }
): MessageTurn | null {
  if (selected.role !== "user") return null
  const id = selected.source_turn_id ?? selected.id
  const named = persisted.find((turn) => turn.id === id)
  if (named) {
    return named.role === "user" &&
      named.timestamp === selected.timestamp &&
      sameUserContent(named, selected)
      ? named
      : null
  }
  // A parser id which disappeared may have been compacted. Never relocate it
  // by text: an identical instruction elsewhere is still a different message.
  if (selected.source_turn_id || /^turn-\d+$/.test(selected.id)) return null
  if (!context) return null
  const visibleUsers = context.timeline.filter((turn) => turn.role === "user")
  const parsedUsers = persisted.filter((turn) => turn.role === "user")
  const selectedIndex = visibleUsers.findIndex(
    (turn) => turn.id === selected.id
  )
  if (selectedIndex < 0) return null
  // Count from a VERIFIED persisted anchor, rather than picking a matching
  // string near the click's timestamp. The latter could pick the prior prompt
  // when two identical instructions were sent quickly and only one flushed.
  let anchor = -1
  let cursor = 0
  for (let i = selectedIndex - 1; i >= 0; i--) {
    const prior = visibleUsers[i]
    const index = parsedUsers.findIndex(
      (turn) => turn.id === (prior.source_turn_id ?? prior.id)
    )
    if (index < 0) continue
    const candidate = parsedUsers[index]
    if (
      candidate.timestamp !== prior.timestamp ||
      !sameUserContent(candidate, prior)
    ) {
      return null
    }
    anchor = i
    cursor = index + 1
    break
  }
  if (anchor < 0 && !context.loadedFromStart) return null
  let result: MessageTurn | null = null
  for (let i = anchor + 1; i <= selectedIndex; i++, cursor++) {
    const local = visibleUsers[i]
    const parsed = parsedUsers[cursor]
    if (
      !parsed ||
      !Number.isFinite(Date.parse(local.timestamp)) ||
      Math.abs(Date.parse(parsed.timestamp) - Date.parse(local.timestamp)) >
        5000 ||
      !sameUserContent(local, parsed)
    ) {
      return null
    }
    result = parsed
  }
  return result
}
