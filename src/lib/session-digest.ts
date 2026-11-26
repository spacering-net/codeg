export interface SessionDigestQuestion {
  id: string
  question: string
  options: string[]
  recommended?: string | null
}
export interface SessionBrief {
  text: string
  updatedAt: string | null
}
export interface SessionDigest {
  revision: number
  updatedAt: string
  now: string[]
  news: string[]
  needsYou: SessionDigestQuestion[]
  suggestions: { id: string; title: string; detail?: string | null }[]
  answers: Record<string, { sent: boolean; expiresAt: string }>
  dismissedSuggestions: string[]
}
export type DigestAction =
  | { operation: "read" }
  | { operation: "dismiss"; revision: number; title: string }
  | {
      operation: "reserve"
      revision: number
      questionId: string
      option: string
    }
  | { operation: "release"; token: string }
export interface DigestAnswerClaim {
  token: string
  text: string
}
