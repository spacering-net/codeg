"use client"

import { createContext, useContext } from "react"

import {
  NO_KNOWN_INVOCATIONS,
  type KnownInvocations,
} from "@/lib/invocation-token"

/**
 * The invocations (`/review`, `$deploy`) the transcript's agent offers, as
 * `useTranscriptKnownInvocations` works them out (including before its
 * connection advertises), provided once by `MessageListView` and read by the
 * user-message renderer: a bare `/word` in a sent message becomes a command
 * badge only when it is on that list, the rule the composer applies to its own.
 *
 * A context rather than a prop for the same reason as `ModelLabelContext`: the
 * memoized message groups between the two never read it themselves.
 */
const KnownInvocationsContext = createContext<KnownInvocations | null>(null)

export const KnownInvocationsProvider = KnownInvocationsContext.Provider

/** Never null. With no provider above (an embed that knows no agent) nothing is
 *  known, so every bare `/word` stays text: unverifiable is not valid. */
export function useKnownInvocations(): KnownInvocations {
  return useContext(KnownInvocationsContext) ?? NO_KNOWN_INVOCATIONS
}
