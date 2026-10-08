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

/** Local messages require a backend receipt; time/content guessing is forbidden. */
export function resolveEditableUserTurn(
  selected: MessageTurn,
  persisted: readonly MessageTurn[],
  receipt?: MessageTurn
): MessageTurn | null {
  if (selected.role !== "user") return null
  if (receipt) {
    // The backend proves which submission this receipt belongs to. Providers
    // may normalize its text or regroup blocks when persisting the prompt.
    if (receipt.role !== "user") return null
    const current = persisted.find((turn) => turn.id === receipt.id)
    return current?.role === "user" &&
      current.timestamp === receipt.timestamp &&
      sameUserContent(current, receipt)
      ? current
      : null
  }
  const id = selected.source_turn_id ?? selected.id
  const named = persisted.find((turn) => turn.id === id)
  return named?.role === "user" &&
    named.timestamp === selected.timestamp &&
    sameUserContent(named, selected)
    ? named
    : null
}

export function needsEditReceipt(turn: MessageTurn): boolean {
  return !turn.source_turn_id && !/^turn-\d+$/.test(turn.id)
}
