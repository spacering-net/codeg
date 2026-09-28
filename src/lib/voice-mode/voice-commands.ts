export type VoiceCommand =
  | "stop"
  | "cancel"
  | "repeat"
  | "exit"
  | "confirm"
  | "reject"

export interface CommandPhrases {
  stop: string
  cancel: string
  repeat: string
  exit: string
  confirm: string
  reject: string
}

const ENGLISH_PHRASES: CommandPhrases = {
  stop: "stop",
  cancel: "cancel",
  repeat: "repeat",
  exit: "exit",
  confirm: "confirm|yes",
  reject: "reject|no",
}

export function normalizeUtterance(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function matchVoiceCommand(
  utterance: string,
  phrases: CommandPhrases,
  phase: string
): VoiceCommand | null {
  const norm = normalizeUtterance(utterance)
  if (!norm) return null

  const check = (phraseStr: string, engStr: string) => {
    const list = [...phraseStr.split("|"), ...engStr.split("|")]
    return list.some((p) => normalizeUtterance(p) === norm)
  }

  if (check(phrases.stop, ENGLISH_PHRASES.stop)) return "stop"
  if (check(phrases.cancel, ENGLISH_PHRASES.cancel)) return "cancel"
  if (check(phrases.repeat, ENGLISH_PHRASES.repeat)) return "repeat"
  if (check(phrases.exit, ENGLISH_PHRASES.exit)) return "exit"

  if (phase === "confirming") {
    if (check(phrases.confirm, ENGLISH_PHRASES.confirm)) return "confirm"
    if (check(phrases.reject, ENGLISH_PHRASES.reject)) return "reject"
  }

  return null
}
