import type { EventEnvelope, LiveSessionSnapshot } from "@/lib/types"

export type UnsubscribeFn = () => void

export interface RemoteTransportConfig {
  id: number
  name: string
  baseUrl: string
  token: string
  windowInstanceId: string
  onUnauthorized?: () => void
}

/**
 * Reasons the server may end an attach subscription unilaterally.
 * Mirrors `DetachReason` in `src-tauri/src/web/ws_attach.rs`.
 */
export type AttachDetachReason =
  | "connection_gone"
  | "lagged"
  | "server_shutdown"

/**
 * Per-subscription callbacks delivered by `EventStream.attach`. Exactly one
 * of `onSnapshot` / `onReplay` fires first (the response to the attach
 * itself), followed by zero or more `onEvent` calls until either the
 * caller invokes `detach()` or the server emits `onDetached`.
 *
 * `eventSeq` / `highWaterSeq` are the high-water mark after the initial
 * frame; subsequent `onEvent` envelopes have `envelope.seq > highWaterSeq`.
 */
export interface AttachHandlers {
  onSnapshot(snapshot: LiveSessionSnapshot, eventSeq: number): void
  onReplay(events: EventEnvelope[], highWaterSeq: number): void
  onEvent(envelope: EventEnvelope): void
  onDetached(reason: AttachDetachReason): void
}

export interface AttachOptions {
  /**
   * Last seq the consumer has already applied. Omit for a cold start —
   * server responds with a full snapshot. Provide on reconnect to request
   * a batched replay; server still falls back to snapshot if the gap is
   * too large or the cursor is older than the ring buffer.
   */
  sinceSeq?: number
}

export interface EventStreamSubscription {
  /** Server-assigned subscription id (echoed by every related frame). */
  readonly subscriptionId: string
  /**
   * Cancel this subscription. Idempotent — calling twice is a no-op. Sends
   * a `detach` to the server (best-effort) and frees client-side handlers.
   * After detach, neither `onEvent` nor `onDetached` fires for this sub.
   */
  detach(): void
}

/**
 * Subscribe-with-Snapshot event stream — the channel that replaces the
 * legacy global `acp://event` firehose for clients that opt in. See
 * `.docs/dev-design/2026-05-15-event-stream-protocol.md` for the full
 * design rationale.
 *
 * Implementations are responsible for re-attaching active subscriptions
 * after a reconnect (using each sub's running `lastAppliedSeq` as
 * `sinceSeq`), so consumers don't need to handle reconnect explicitly.
 */
export interface EventStream {
  attach(
    connectionId: string,
    options: AttachOptions,
    handlers: AttachHandlers
  ): EventStreamSubscription
}

export interface CallOptions {
  /**
   * Override the transport's default request timeout. Tauri ignores
   * this (its invoke() has no timeout); WebTransport uses it instead
   * of `WEB_CALL_TIMEOUT_MS` for this single call.
   *
   * Use only when a command has a backend-side deadline (e.g. a
   * 60 s probe) that the default 60 s transport timeout would race
   * with — leaving the user staring at "Request timed out" before the
   * backend can return its own structured error.
   */
  timeoutMs?: number
}

export interface Transport {
  /**
   * Invoke a backend command (replaces Tauri's invoke()).
   */
  call<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: CallOptions
  ): Promise<T>

  /**
   * Subscribe to a backend event stream (replaces Tauri's listen()).
   * Returns an unsubscribe function.
   */
  subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn>

  /**
   * Whether the app is running in a desktop Tauri environment.
   */
  isDesktop(): boolean

  /**
   * Register a callback invoked after a WebSocket-based transport reconnects
   * and the server-side broadcaster receiver is re-subscribed. Used by
   * consumers (e.g. ACP connection store) to recover any events emitted
   * during the disconnect window — the broadcaster drops events when
   * `receiver_count == 0`, so anything fired between `onclose` and the next
   * `__ready__` is lost. Re-fetching backend snapshots is the recovery path.
   *
   * Not fired on the initial connect (consumers handle that separately).
   * Returns an unsubscribe function. Optional — IPC-only transports (e.g.
   * Tauri) leave this undefined.
   */
  onReconnect?(callback: () => void): UnsubscribeFn

  /**
   * Verify the WebSocket link is actually alive. Meant for wake-up moments
   * (tab becomes visible, lid opened, network restored): a socket that died
   * while the machine slept can sit in OPEN state for minutes without the
   * browser noticing — no close frame ever arrives, so the reconnect path
   * never runs and the event stream silently stays dark. Implementations
   * send a ping and, if no pong (or any other frame) arrives within a short
   * deadline, tear the socket down and reconnect at once; while already
   * reconnecting they skip the remaining backoff instead. Optional — IPC-only
   * transports leave this undefined.
   */
  probeLiveness?(): void

  /**
   * Resolves when the server-side broadcaster receiver is currently
   * subscribed (i.e. the most recent WS connection has received its
   * `__ready__` frame). Callers should await this immediately before
   * invoking HTTP commands that emit events via the WebSocket — without
   * the await, events fired during a WS reconnect window are silently
   * dropped by the broadcaster's `receiver_count == 0` guard.
   *
   * Bounded by a transport-internal timeout; falls through (resolves)
   * rather than rejecting to avoid permanent UI hang. Optional — IPC-only
   * transports leave this undefined (no disconnect window to guard).
   */
  waitForReady?(): Promise<void>

  /**
   * Per-connection event stream (Subscribe-with-Snapshot). Returns
   * `undefined` for transports that don't yet support the attach protocol —
   * callers fall back to the legacy `subscribe()` channel. Implementations
   * are stateful: the same EventStream instance handles re-attach on
   * reconnect transparently to the caller.
   */
  eventStream?(): EventStream

  destroy?(): void
}
