"use client"

/**
 * State + actions for the live-feedback ("steering") side channel, lifted out of
 * the old always-on composer bar. The user opens a dialog (from the composer
 * "+" menu) and sends a short note to the running agent; it is delivered the next
 * time the agent calls the `check_user_feedback` MCP tool. Sent notes render as
 * read-only rows above the composer, flipping from "waiting" to "received" once
 * the agent reads them.
 *
 * Cooperative by design: the agent must call the tool to see a note, so this is
 * a side channel, not a hard interrupt. If the turn ends between opening the
 * dialog and sending, the note is rerouted through the message queue
 * (`onResendAsPrompt`) so it is never silently dropped.
 *
 * A note the agent never got round to reading survives the turn it was written
 * for: at turn end the list keeps the still-`pending` rows and flips to its
 * expired form, which says the agent finished without reading them and offers
 * to resend each one as an ordinary message (`resendNote`) or drop it
 * (`dismissNote`). Delivered rows retire with the turn — they did their job.
 * Notes are turn-scoped either way: the next `user_message` clears the lot.
 *
 * State is hydrated from the session snapshot on mount / connection change (so a
 * refresh or a second mid-turn viewer recovers pending notes) and then kept live
 * via the `feedback_submitted` / `feedback_consumed` event stream. Consumed-id
 * tombstones reconcile a consume event that races ahead of hydration.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAcpEvent } from "@/contexts/acp-connections-context"
import { acpGetSessionSnapshot, submitSessionFeedback } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { notify } from "@/lib/notify"
import { isNoActiveTurnRejection } from "@/lib/turn-busy"
import type {
  ConnectionStatus,
  FeedbackItem,
  PromptInputBlock,
} from "@/lib/types"

/** Merge snapshot-hydrated notes with live ones, keyed by id; live entries win
 *  (they carry the most recent status). Snapshot order first, live-only after. */
function mergeNotes(
  base: FeedbackItem[],
  live: FeedbackItem[]
): FeedbackItem[] {
  const byId = new Map<string, FeedbackItem>()
  for (const n of base) byId.set(n.id, n)
  for (const n of live) byId.set(n.id, n)
  return [...byId.values()]
}

export interface UseSessionFeedbackArgs {
  connectionId: string | null
  connStatus: ConnectionStatus | null
  /** Whether the live-feedback feature is enabled (global setting). */
  enabled: boolean
  /**
   * Note ids the live transcript adopted as mid-turn user turns
   * (`ConnectionState.steeredMessageIds`). Their strips are dropped: the note
   * IS the message now, and showing both would print it twice.
   *
   * Taken from the connection rather than derived here on purpose. The
   * transcript can only adopt a note while a turn is actually running, and a
   * note submitted on the closing edge of one may miss that window; letting
   * this hook guess would eventually guess the other way from the reducer and
   * leave a message showing in neither place.
   */
  steeredMessageIds?: readonly string[]
  /** Reroute a note as an ordinary prompt when the turn ended before it could be
   *  submitted (turn-end race). */
  onResendAsPrompt?: (text: string) => void
}

export interface UseSessionFeedback {
  /** All notes for the current turn (pending + delivered). */
  notes: FeedbackItem[]
  /** Global feature flag — gates whether the "+" menu entry is shown at all. */
  featureEnabled: boolean
  /** Whether a note can be sent right now (entry is enabled vs. greyed out). */
  canSubmit: boolean
  /** Which channel a note would ride: `native` = the ACP `_session/steering`
   *  push (injected into the running turn immediately), `pull` = the
   *  `check_user_feedback` MCP tool (read when the agent next checks). Drives
   *  copy and the composer's mid-turn send entry. Backend-synthesized — never
   *  derived from agent type here. */
  channel: "native" | "pull"
  /** Whether THIS session has a working mid-turn delivery channel at all: a
   *  live connection plus native push or the pull tool. Gates the composer's
   *  mid-turn send affordance (`channel` picks its copy); a session with
   *  neither keeps the historical Stop-only prompting form. Distinct from
   *  `canSubmit`, which additionally folds in the feature flag and the
   *  prompting scope — the composer enforces that where the button renders. */
  steerAvailable: boolean
  /** Whether to render the notes list above the composer. */
  showList: boolean
  /** Whether the listed notes outlived their turn: the agent finished without
   *  reading them, so the list drops its "waiting" reading and switches to the
   *  expired form (say so, then offer {@link resendNote} / {@link dismissNote}).
   *  Only ever true for notes still `pending` — a delivered one has nothing
   *  left to salvage. */
  notesExpired: boolean
  /** Send an expired note's text as an ordinary message (via
   *  `onResendAsPrompt`) and retire its row. */
  resendNote: (id: string) => void
  /** Retire an expired note's row without sending it. */
  dismissNote: (id: string) => void
  /** Whether a submit is in flight (disables the dialog send button). */
  submitting: boolean
  dialogOpen: boolean
  openDialog: () => void
  closeDialog: () => void
  /** Send a note. Closes the dialog on success / turn-end reroute. */
  submit: (text: string) => Promise<void>
  /** Composer-facing raw submit: same optimistic note append on success, but
   *  every failure — including the turn-end `NoActiveTurn` race — is
   *  RETHROWN untouched (no toast, no reroute). The composer owns its own
   *  fallback (enqueue) and draft-preservation policy, which `submit`'s
   *  dialog-shaped error handling would preempt. `blocks` carries the full
   *  draft when it holds attachments (native wire only; the backend's
   *  `NoActiveTurn` rejection on the pull path reroutes it to the queue
   *  whole, so an attachment is never silently dropped); `text` stays the
   *  recorded/display form. */
  steer: (text: string, blocks?: PromptInputBlock[]) => Promise<FeedbackItem>
}

export function useSessionFeedback({
  connectionId,
  connStatus,
  enabled,
  steeredMessageIds,
  onResendAsPrompt,
}: UseSessionFeedbackArgs): UseSessionFeedback {
  const t = useTranslations("LiveFeedback")
  const [notes, setNotes] = useState<FeedbackItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  // Whether THIS agent actually has the `check_user_feedback` tool (from the
  // snapshot). The authoritative gate — enabling the feature mid-session can't
  // retrofit the tool onto an already-running agent. Starts false until the
  // snapshot confirms.
  const [toolAvailable, setToolAvailable] = useState(false)
  // Whether notes ride the native `_session/steering` push channel for THIS
  // session (backend-synthesized from advertisement + registry policy +
  // runtime version proof — never re-derived from agent type here). Same
  // monotonic-upgrade discipline as `toolAvailable` for SNAPSHOT reads
  // (hydrate + self-heal only ever flip it true; the synchronous reset on
  // connection change flips it back). The ONE downgrade signal is the submit
  // RESULT (see `reconcileChannel`): a `pending` item on a supposedly-native
  // session means the backend downgraded mid-session (startedNewTurn), and
  // leaving this true would keep offering "insert into current turn" while
  // notes actually land on the pull path.
  const [nativeSteering, setNativeSteering] = useState(false)
  // Latch for that downgrade: once set, a stale pre-downgrade snapshot that
  // resolves late can never flip the channel back to native. Reset with the
  // rest of the per-connection state.
  const steeringDowngradedRef = useRef(false)
  // Latest-connection guard for the post-submit channel verification below: a
  // verify read that resolves after the user switched connections must not
  // latch the NEW connection's state.
  const connectionIdRef = useRef(connectionId)
  connectionIdRef.current = connectionId
  // Tombstones for notes consumed via `feedback_consumed` whose
  // `feedback_submitted` we never held (a consume event that lands BEFORE the
  // matching submit — e.g. before snapshot hydration resolves, or out-of-order
  // broadcast). Applied so a stale snapshot or a late submit can't resurrect a
  // note as `pending` after the agent already read it.
  const consumedRef = useRef<Map<string, string>>(new Map())
  // Ids the user retired from the expired list (resent as a message, or
  // dismissed). Tombstoned rather than merely filtered out of `notes` for the
  // same reason as `consumedRef`: a reconnect re-hydrates from the snapshot,
  // which still carries the note until the next turn clears it backend-side,
  // and a row the user already dealt with must not come back.
  const dismissedRef = useRef<Set<string>>(new Set())
  // Latest notes, for the id → text lookup `resendNote` needs. A ref keeps
  // that callback's identity stable across every note append, which the
  // returned memo (and the list's props) would otherwise churn on.
  const notesRef = useRef<FeedbackItem[]>(notes)
  notesRef.current = notes
  // Bumped on every new turn (`user_message`). A snapshot fetch captures the
  // generation it started in; if a new turn lands before it resolves, its
  // (previous-turn) notes are discarded — feedback is turn-scoped and the new
  // turn already cleared them, so applying the stale snapshot would resurrect
  // them.
  const turnGenRef = useRef(0)

  const isPrompting = connStatus === "prompting"

  // Reset on connection change, then hydrate from the snapshot: recover pending
  // notes (a refresh / second mid-turn viewer won't get the one-shot
  // `feedback_submitted` events) AND read the agent's real feedback-tool
  // capability. Live events arriving before the fetch resolves are preserved
  // (live wins in the merge); consumed-id tombstones override stale `pending`.
  useEffect(() => {
    setNotes([])
    setToolAvailable(false)
    setNativeSteering(false)
    steeringDowngradedRef.current = false
    consumedRef.current = new Map()
    // `dismissedRef` deliberately survives this reset: note ids are uuids, so a
    // carried-over tombstone can never suppress another connection's row, and
    // keeping it is what stops a re-hydrate (same connection, feature flag
    // toggled off and on) from resurrecting a row the user already retired. It
    // is bounded by the per-turn clear below.
    if (!enabled || !connectionId) return
    let cancelled = false
    const startGen = turnGenRef.current
    void acpGetSessionSnapshot(connectionId)
      .then((snap) => {
        if (cancelled || !snap) return
        // Tool availability is fixed at launch and only ever upgrades to true.
        // Never overwrite a confirmed `true` with a stale `false` from a read
        // that raced the spawn — the synchronous reset above is the only place
        // it goes back to false (on connection / feature-flag change).
        if (snap.feedback_tool_available) setToolAvailable(true)
        if (snap.native_steering_available && !steeringDowngradedRef.current) {
          setNativeSteering(true)
        }
        // A new turn started while the fetch was in flight — the snapshot holds
        // the previous turn's (already-cleared) notes; drop them.
        if (turnGenRef.current !== startGen) return
        const hydrated = (snap.feedback ?? []).filter(
          (n) => !dismissedRef.current.has(n.id)
        )
        if (hydrated.length === 0) return
        const reconciled = hydrated.map((n) => {
          const at = consumedRef.current.get(n.id)
          return at
            ? { ...n, status: "delivered" as const, delivered_at: at }
            : n
        })
        setNotes((prev) => mergeNotes(reconciled, prev))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [connectionId, enabled])

  // Self-heal capability flags. The hydrate above is keyed on `connectionId`,
  // which appears the moment a NEW conversation's connection is created — while
  // it's still "connecting", BEFORE the backend sets `feedback_tool_available`
  // / `native_steering_available` at spawn. That first read returns false and
  // would never refresh, leaving the "+" entry permanently disabled. Once the
  // connection is actually live, re-read (only while either is still unknown —
  // a `false` no-ops so this can't loop, and it stops once both are known).
  useEffect(() => {
    if (!enabled || !connectionId || (toolAvailable && nativeSteering)) return
    if (connStatus !== "connected" && connStatus !== "prompting") return
    let cancelled = false
    void acpGetSessionSnapshot(connectionId)
      .then((snap) => {
        if (cancelled) return
        // Monotonic upgrade only (see hydrate effect) — no downgrade, no flicker.
        if (snap?.feedback_tool_available) setToolAvailable(true)
        if (snap?.native_steering_available && !steeringDowngradedRef.current) {
          setNativeSteering(true)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enabled, connectionId, connStatus, toolAvailable, nativeSteering])

  // Build the note list from the live event stream, scoped to this connection.
  useAcpEvent(
    useCallback(
      (envelope) => {
        if (envelope.connection_id !== connectionId) return
        switch (envelope.type) {
          case "feedback_submitted": {
            // A broadcast that lands after the user retired the row (dismissed
            // or resent) must not re-add it.
            if (dismissedRef.current.has(envelope.item.id)) break
            // If a consume already arrived for this id (out-of-order broadcast),
            // honor the tombstone so it never shows as pending.
            const at = consumedRef.current.get(envelope.item.id)
            const item: FeedbackItem = at
              ? { ...envelope.item, status: "delivered", delivered_at: at }
              : envelope.item
            setNotes((prev) =>
              prev.some((n) => n.id === item.id) ? prev : [...prev, item]
            )
            break
          }
          case "feedback_consumed": {
            const ids = new Set(envelope.ids)
            const at = envelope.delivered_at
            for (const id of envelope.ids) consumedRef.current.set(id, at)
            setNotes((prev) =>
              prev.map((n) =>
                ids.has(n.id)
                  ? { ...n, status: "delivered", delivered_at: at }
                  : n
              )
            )
            break
          }
          case "user_message": {
            // A new turn started — notes are turn-scoped, mirror the backend
            // clear so a fresh turn begins empty. Bump the generation so an
            // in-flight snapshot fetch from the previous turn can't re-add them.
            turnGenRef.current += 1
            setNotes([])
            consumedRef.current = new Map()
            // The backend cleared these notes too, so their tombstones have
            // nothing left to guard — dropping them bounds the set.
            dismissedRef.current = new Set()
            break
          }
        }
      },
      [connectionId]
    )
  )

  // Converge the channel from a submit RESULT. Two signals:
  //
  // * A `pending` item on a supposedly-native session PROVES the backend
  //   already downgraded (`startedNewTurn` earlier) and rerouted THIS note
  //   to the pull path — flip immediately and tell the user the delivery
  //   semantics changed (their "insert now" became a waiting note; the note
  //   itself is safe, recorded and listed).
  // * A `delivered` item is ambiguous: the downgrade round ITSELF returns
  //   delivered (the detached turn consumed the content) while the backend
  //   flag flips false before the reply — indistinguishable from a healthy
  //   injection by status alone. So after every native-session submit,
  //   re-read the authoritative snapshot once and converge SILENTLY when it
  //   reports the flag off: the next render stops offering "insert into
  //   current turn" and the dialog copy reverts to pull. (No toast — that
  //   round's note WAS consumed by the agent.)
  //
  // Both paths set the latch so a stale pre-downgrade snapshot can never
  // flip the channel back (see `steeringDowngradedRef`).
  const reconcileChannel = useCallback(
    (item: FeedbackItem) => {
      // Stale-closure guard: a submit that resolves after the user switched
      // connections captured the OLD connection's context, but the state and
      // latch it would mutate now belong to the NEW one — bail out entirely
      // (both branches), or connection B would lose its native entry over
      // connection A's late result.
      if (connectionIdRef.current !== connectionId) return
      if (!nativeSteering) return
      if (item.status === "pending") {
        steeringDowngradedRef.current = true
        setNativeSteering(false)
        toast.info(t("channelDowngraded"))
        return
      }
      const cid = connectionId
      if (!cid) return
      void acpGetSessionSnapshot(cid)
        .then((snap) => {
          // Explicit `false` only — an older server omits the field entirely
          // (undefined), which must not read as a downgrade.
          if (
            connectionIdRef.current === cid &&
            snap &&
            snap.native_steering_available === false
          ) {
            steeringDowngradedRef.current = true
            setNativeSteering(false)
          }
        })
        .catch(() => {})
    },
    [nativeSteering, connectionId, t]
  )

  const submit = useCallback(
    async (rawText: string) => {
      const text = rawText.trim()
      if (!text || submitting || !connectionId) return
      // Eligibility can drop while the dialog is open (e.g. the feature is
      // toggled off in another window). Don't send into a disabled / unsupported
      // session — close the dialog instead. NOTE: a merely-ended turn keeps
      // `enabled`/`toolAvailable` true, so it still flows to the submit below and
      // gets rerouted via the no-active-turn fallback (draft preserved).
      if (!enabled || (!toolAvailable && !nativeSteering)) {
        setDialogOpen(false)
        return
      }
      setSubmitting(true)
      try {
        const item = await submitSessionFeedback(connectionId, text)
        reconcileChannel(item)
        // Optimistically add; the broadcast event dedups against this by id.
        setNotes((prev) =>
          prev.some((n) => n.id === item.id) ? prev : [...prev, item]
        )
        setDialogOpen(false)
      } catch (err: unknown) {
        if (isNoActiveTurnRejection(err) && onResendAsPrompt) {
          // The turn ended between opening the dialog and sending. Fall back to
          // a normal prompt so the user's intent isn't lost.
          onResendAsPrompt(text)
          setDialogOpen(false)
          toast.info(t("turnEndedResent"))
        } else {
          notify({
            level: "error",
            key: `feedback-submit-failed:${connectionId}`,
            title: t("submitFailed"),
            description: toErrorMessage(err),
          })
        }
      } finally {
        setSubmitting(false)
      }
    },
    [
      submitting,
      connectionId,
      enabled,
      toolAvailable,
      nativeSteering,
      onResendAsPrompt,
      reconcileChannel,
      t,
    ]
  )

  // Composer-facing raw submit. Unlike `submit` (dialog-shaped: swallows
  // errors into toasts and reroutes the turn-end race itself), this RETHROWS
  // everything so the composer can run its own policy — fall back to the
  // queue on `NoActiveTurn`, keep the draft on real failures. Shared with
  // `submit`: the optimistic note append and the channel reconciliation.
  const steer = useCallback(
    async (
      rawText: string,
      blocks?: PromptInputBlock[]
    ): Promise<FeedbackItem> => {
      const text = rawText.trim()
      if (!text || !connectionId) {
        throw new Error("nothing to steer")
      }
      const item = await submitSessionFeedback(connectionId, text, blocks)
      // A resolution that landed after a connection switch must not touch the
      // new connection's channel state or note list (reconcileChannel guards
      // itself too; the append needs the same protection).
      if (connectionIdRef.current === connectionId) {
        reconcileChannel(item)
        // Optimistically add; the broadcast event dedups against this by id.
        setNotes((prev) =>
          prev.some((n) => n.id === item.id) ? prev : [...prev, item]
        )
      }
      return item
    },
    [connectionId, reconcileChannel]
  )

  const openDialog = useCallback(() => setDialogOpen(true), [])
  const closeDialog = useCallback(() => setDialogOpen(false), [])

  // Retire an expired row. Tombstone first, then drop it — the note stays
  // recorded backend-side (nothing here un-submits it), this only settles what
  // the user is still being asked about.
  const dismissNote = useCallback((id: string) => {
    dismissedRef.current.add(id)
    setNotes((prev) => prev.filter((n) => n.id !== id))
  }, [])

  // Salvage an expired row as an ordinary message. `onResendAsPrompt` is the
  // same queue hand-off the dialog's turn-end race uses, and the queue
  // auto-flushes against a connected session — so on an already-finished turn
  // this sends immediately rather than parking.
  const resendNote = useCallback(
    (id: string) => {
      // Tombstone first, not `notesRef`: two clicks landing in the same tick
      // both still see the note (the row only leaves on the next render), and
      // resending is the one action here that must not happen twice.
      if (dismissedRef.current.has(id)) return
      const note = notesRef.current.find((n) => n.id === id)
      if (!note) return
      dismissedRef.current.add(id)
      setNotes((prev) => prev.filter((n) => n.id !== id))
      onResendAsPrompt?.(note.text)
    },
    [onResendAsPrompt]
  )

  // `connectionId` belongs here, not only in `canSubmit`: a note rides
  // `submitSessionFeedback(connectionId, …)`, so without one there is no
  // channel to offer — the composer would surface a mid-turn send whose only
  // possible outcome is `steer`'s "nothing to steer" rejection.
  const steerAvailable =
    Boolean(connectionId) && (toolAvailable || nativeSteering)
  const canSubmit = enabled && steerAvailable && isPrompting
  const channel: "native" | "pull" = nativeSteering ? "native" : "pull"
  // Drop the notes the transcript is already rendering as user turns. Kept as
  // a derivation rather than a filter on `setNotes` so a note stays recoverable
  // as a strip if the transcript never took it.
  const unadoptedNotes = useMemo(() => {
    if (!steeredMessageIds || steeredMessageIds.length === 0) return notes
    const adopted = new Set(steeredMessageIds)
    const remaining = notes.filter((n) => !adopted.has(n.id))
    return remaining.length === notes.length ? notes : remaining
  }, [notes, steeredMessageIds])
  // Past the turn, only an UNREAD note still has something to offer: a
  // delivered one was read and retires with the turn it steered. The unread
  // ones stay up in the expired form — the list used to require `isPrompting`
  // outright, which is how a note the agent never got to vanished without a
  // word (and the next turn then cleared it for good).
  const unreadNotes = useMemo(
    () => unadoptedNotes.filter((n) => n.status === "pending"),
    [unadoptedNotes]
  )
  // A live, IDLE session is the only proof the turn actually ended. Not merely
  // `!isPrompting`: a mid-turn attach hydrates while the entry is still
  // `connecting` (`CONNECTION_CREATED` seeds it), and `markConnectionGone`
  // flips to `disconnected` precisely when the terminal event never arrived —
  // both can read "not prompting" with the agent still running and the note
  // still consumable. Calling that expired is the expensive mistake: the user
  // resends a copy, the agent then reads the original, and the same
  // instruction lands twice. So the ambiguous states keep the historical hide.
  const turnEnded = connStatus === "connected"
  const visibleNotes = turnEnded ? unreadNotes : unadoptedNotes
  const showList = visibleNotes.length > 0 && (isPrompting || turnEnded)
  const notesExpired = turnEnded && visibleNotes.length > 0

  return useMemo(
    () => ({
      notes: visibleNotes,
      featureEnabled: enabled,
      canSubmit,
      channel,
      steerAvailable,
      showList,
      notesExpired,
      resendNote,
      dismissNote,
      submitting,
      dialogOpen,
      openDialog,
      closeDialog,
      submit,
      steer,
    }),
    [
      visibleNotes,
      enabled,
      canSubmit,
      channel,
      steerAvailable,
      showList,
      notesExpired,
      resendNote,
      dismissNote,
      submitting,
      dialogOpen,
      openDialog,
      closeDialog,
      submit,
      steer,
    ]
  )
}
