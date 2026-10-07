import { WS_READY_CHANNEL } from "./constants"
import type { AttachTransportHost } from "./web-event-stream"
import { WebEventStream } from "./web-event-stream"
import type {
  CallOptions,
  EventStream,
  Transport,
  UnsubscribeFn,
} from "./types"
import { buildCodegWebSocketProtocols } from "./ws-auth"
import { parseJsonOrThrow } from "../json-parse-error"
import { getCodegToken } from "./web-auth"

// 60s covers the worst-case ACP probe path: some agents (Gemini in
// particular) burn 8–10s on the Initialize handshake before session/new
// can even start. The backend probe timeout in `ConnectionManager::
// probe_agent_options` is 60s, so the transport-level cap must be at
// least that high — otherwise the UI aborts with "Request timed out"
// while the backend is still holding a live probe process.
const WEB_CALL_TIMEOUT_MS = 60_000
// Upper bound on how long `subscribe()` will wait for the server `__ready__`
// frame. Generous enough to cover slow local servers and remote round-trips
// (typical: <100ms local, <1s WAN), but bounded so an older server (no
// `__ready__` support), a hung backend task, or a buffering proxy can't
// permanently lock the UI. On timeout we proceed without confirmation — the
// pre-fix race window reopens, but the UI stays responsive.
const READY_TIMEOUT_MS = 5_000
// Exponential backoff bounds, in milliseconds: 1s → 2s → 4s → … capped at
// 32s. Cap matches the Rust-side WS_BACKOFF_MAX_SECS. We never stop retrying:
// a dropped WS is treated as a transient connectivity problem (server
// restart, network blip, laptop sleep), surfaced via the reconnect dialog,
// not as a reason to discard the token and bounce to /login.
const WS_BACKOFF_INITIAL_MS = 1_000
const WS_BACKOFF_MAX_MS = 32_000
// Upper bound on the `/api/health` probe that classifies a dropped WS. The
// browser's native WebSocket can't read the HTTP status of a rejected
// handshake (onclose only reports code 1006), so we can't tell "token
// rejected" from "server unreachable" off the socket alone. An authenticated
// probe disambiguates: 200 = token valid + server up (reconnect),
// 401 = token rejected (session expired), network error / timeout = server
// unreachable (keep retrying). Bounded so a SYN black-hole (dead server still
// completing the TCP handshake) can't hang the "Reconnect now" button.
const HEALTH_PROBE_TIMEOUT_MS = 8_000

// Connection health of the web transport, surfaced to React via
// `subscribeConnection`/`getConnectionSnapshot` so a single global dialog can
// reflect it. Distinct from the per-ACP-agent `ConnectionStatus` — this is
// the browser↔server transport link, not an agent session.
export type WebConnState = "connected" | "reconnecting" | "unauthorized"

interface WebEvent {
  channel: string
  payload: unknown
}

const getToken = getCodegToken

export class WebTransport implements Transport {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<(payload: unknown) => void>>()
  private baseUrl: string
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private wsFailCount = 0
  private readyPromise!: Promise<void>
  private readyResolve!: () => void
  // Tracks whether `__ready__` has ever arrived on this transport instance.
  // The first arrival is the initial connect; subsequent arrivals are
  // reconnects (after `onclose` reset the promise). Reconnect callbacks
  // run only on subsequent arrivals so consumers can refresh state that
  // may have desynced during the disconnect window.
  private hasReadiedOnce = false
  private reconnectCallbacks = new Set<() => void>()
  // Latched in `destroy()`. The async `onclose` fired by `ws.close()` inside
  // `destroy()`/`teardownWs()` would otherwise flip the state machine to
  // "reconnecting" and schedule a fresh backoff on a transport the caller
  // already let go of. Guard `onclose` (and the probe/backoff helpers) to
  // short-circuit once destroyed.
  private destroyed = false
  // Attach-protocol plumbing. The EventStream is created lazily on first
  // call to `eventStream()`; it lives for the entire transport lifetime and
  // re-attaches its subscriptions on every WS-ready transition.
  private wsOpen = false
  private wsReadyCallbacks = new Set<() => void>()
  private eventStreamInstance: WebEventStream | null = null
  // Connection-health state machine. Starts "connected" so SSR/first paint
  // never flashes the dialog; the first real transition comes from `onclose`
  // (→ reconnecting) or a 401 (→ unauthorized). `connListeners` are React
  // `useSyncExternalStore` subscribers notified on every state change.
  private connState: WebConnState = "connected"
  private connListeners = new Set<() => void>()
  // De-dupes concurrent `/api/health` probes (auto-retry tick vs. a manual
  // "Reconnect now" click) so a button mash can't fan out a burst of fetches.
  private healthProbeInFlight = false
  // Invalidates an in-flight probe whose result must be ignored because the
  // machine moved on while it was awaiting (a definitive 401 → unauthorized,
  // or teardown). `probeEpoch` is captured when a probe starts and re-checked
  // after every await; `probeController` lets us abort the fetch outright so
  // a late 200 can't reopen the socket behind the session-expired dialog.
  private probeEpoch = 0
  private probeController: AbortController | null = null

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
    this.resetReady()
  }

  private resetReady() {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve
    })
  }

  // Bounded wait on `readyPromise`. If `__ready__` does not arrive within
  // `READY_TIMEOUT_MS`, log a warning and fall through — degrades to the
  // pre-handshake behavior instead of hanging the UI forever.
  //
  // Public so callers (e.g. `acp_connect` in the ACP context) can gate
  // HTTP commands on WS readiness, not just the initial `subscribe()`.
  // The `subscribe()`-only gate covers the initial-connect race but
  // leaves a window where `acp_connect` fired during a mid-session
  // reconnect would still race the broadcaster's `receiver_count == 0`
  // guard. Awaiting this directly before such HTTP calls closes that gap.
  async waitForReady(): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), READY_TIMEOUT_MS)
    })
    const result = await Promise.race([
      this.readyPromise.then(() => "ready" as const),
      timeoutPromise,
    ])
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (result === "timeout") {
      console.warn(
        `[WebTransport] WS __ready__ frame did not arrive within ${READY_TIMEOUT_MS}ms; ` +
          "proceeding without server-side subscribe confirmation (initial-connect race may reopen)."
      )
    }
  }

  async call<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: CallOptions
  ): Promise<T> {
    const token = getToken()
    const controller = new AbortController()
    // Per-call override beats the transport-wide default. Used for
    // commands whose backend handler has its own long deadline that
    // would otherwise race with `WEB_CALL_TIMEOUT_MS` and surface
    // "Request timed out" before the backend can return a structured
    // error. See `describeAgentOptions` in `lib/api.ts`.
    const effectiveTimeoutMs = options?.timeoutMs ?? WEB_CALL_TIMEOUT_MS
    const timeout = window.setTimeout(
      () => controller.abort(),
      effectiveTimeoutMs
    )
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/${command}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(args ?? {}),
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Request timed out")
      }
      throw err
    } finally {
      window.clearTimeout(timeout)
    }
    if (res.status === 401) {
      // Definitive auth failure. Surface the unified unauthorized dialog
      // rather than an abrupt redirect — a hard `location.href` here would
      // fight a reconnect dialog that may already be on screen. The user
      // re-authenticates from the dialog's "Go to login" action.
      this.markUnauthorized()
      throw new Error("Unauthorized")
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: "network_error",
        message: `HTTP ${res.status}`,
      }))
      throw error
    }
    // Read the body as text and parse it here rather than calling
    // `res.json()`. Identical on the happy path, but a truncated or malformed
    // body otherwise throws a bare engine message — `Unterminated string in
    // JSON at position 80865` — that names neither the endpoint nor anything
    // else a user could report. Exactly that error was reported against the
    // Agents settings page (#736) and could not be traced to a source.
    const body = await res.text()
    return parseJsonOrThrow<T>(body, `API ${command}`)
  }

  async subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn> {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    const wrappedHandler = handler as (payload: unknown) => void
    this.handlers.get(event)!.add(wrappedHandler)

    // If WS is not connected but we now have a token, connect
    if (!this.ws && getToken()) {
      this.connectWs()
    }

    // Gate on the server-side broadcaster receiver actually being subscribed.
    // The backend WS handler sends a `__ready__` frame after subscribing, so
    // any event emitted past this await is guaranteed to reach a receiver.
    // Without this, events fired before the server-side subscribe (e.g. the
    // ACP `Connected` event after a fast Initialize) are silently dropped
    // because the broadcaster skips `send` when receiver_count == 0, leaving
    // the UI permanently stuck on "正在连接".
    if (getToken()) {
      await this.waitForReady()
    }

    return () => {
      this.handlers.get(event)?.delete(wrappedHandler)
    }
  }

  isDesktop(): boolean {
    return false
  }

  onReconnect(callback: () => void): UnsubscribeFn {
    this.reconnectCallbacks.add(callback)
    return () => {
      this.reconnectCallbacks.delete(callback)
    }
  }

  // ── Connection-health surface (consumed by the reconnect dialog) ─────────

  /** Current transport health. Drives the global reconnect dialog. */
  getConnectionSnapshot(): WebConnState {
    return this.connState
  }

  /** Subscribe to health changes (React `useSyncExternalStore`). */
  subscribeConnection(callback: () => void): UnsubscribeFn {
    this.connListeners.add(callback)
    return () => {
      this.connListeners.delete(callback)
    }
  }

  /**
   * Manual "Reconnect now": cancel any pending backoff, drop the stale
   * socket, reset the backoff counter so the next cadence starts short, and
   * fire an immediate health probe. Safe to call from any state.
   */
  reconnectNow(): void {
    if (this.destroyed) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.teardownWs()
    this.wsFailCount = 0
    this.setConnState("reconnecting")
    void this.probeHealth()
  }

  /**
   * Enter the unauthorized state: a definitive 401 was observed (token
   * rejected). Stop reconnecting and let the dialog prompt re-login. Does NOT
   * clear the token — that happens when the user acts on "Go to login" — so a
   * spuriously-cached 401 can't silently wipe a still-valid session.
   */
  markUnauthorized(): void {
    if (this.destroyed) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Invalidate any in-flight probe so its delayed completion can't reopen
    // the socket or re-arm the backoff behind the session-expired dialog.
    this.invalidateProbe()
    this.teardownWs()
    this.setConnState("unauthorized")
  }

  // Bump the epoch (so a pending probe's post-await guard bails) and abort its
  // fetch. Called whenever the machine transitions out from under a live probe.
  private invalidateProbe() {
    this.probeEpoch++
    this.probeController?.abort()
    this.probeController = null
  }

  private setConnState(next: WebConnState) {
    if (this.connState === next) return
    this.connState = next
    for (const cb of this.connListeners) {
      try {
        cb()
      } catch (err) {
        console.error("[WebTransport] connection listener threw:", err)
      }
    }
  }

  eventStream(): EventStream {
    if (!this.eventStreamInstance) {
      const host: AttachTransportHost = {
        isWsOpen: () => this.wsOpen,
        sendFrame: (frame) => this.sendWsFrame(frame),
        onWsReady: (callback) => {
          this.wsReadyCallbacks.add(callback)
          return () => {
            this.wsReadyCallbacks.delete(callback)
          }
        },
      }
      this.eventStreamInstance = new WebEventStream(host)
      // If a token is present but the WS hasn't been opened yet (no legacy
      // subscribe has run), trigger the connect now so attach frames sent
      // by the consumer have a place to land.
      if (!this.ws && getToken()) {
        this.connectWs()
      }
    }
    return this.eventStreamInstance
  }

  private sendWsFrame(frame: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(frame))
      return true
    } catch (err) {
      console.warn("[WebTransport] sendWsFrame failed:", err)
      return false
    }
  }

  // Returns false when there's no token to connect with (caller decides how to
  // surface that — probeHealth treats it as unauthorized rather than a silent
  // dead-end). Returns true once a socket has been created.
  private connectWs(): boolean {
    const token = getToken()
    if (!token) return false

    // Drop any lingering socket before opening a new one. teardownWs detaches
    // handlers first, so the old socket's async onclose can't fire after we've
    // moved on and corrupt the state machine / schedule a duplicate backoff.
    this.teardownWs()

    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws/events"
    this.ws = new WebSocket(wsUrl, buildCodegWebSocketProtocols(token))

    this.ws.onopen = () => {
      this.wsOpen = true
      // NB: connection health is NOT flipped to "connected" here. `onopen`
      // only means the socket is physically up; the application-level
      // "ready" signal is the server's `__ready__` frame (see onmessage),
      // which is also where `reconnectCallbacks` fire to re-sync state. We
      // reset `wsFailCount` and clear the dialog there so "reconnected" and
      // "data refreshed" land together — not in the sub-second gap between
      // socket-open and the ready frame.
      // Notify the EventStream so it can re-issue attach frames for any
      // active subscriptions. Fires on initial connect AND every reconnect;
      // the EventStream uses each sub's running `lastAppliedSeq` so the
      // server can pick replay vs. snapshot. Errors in callbacks must not
      // break sibling callbacks.
      for (const cb of this.wsReadyCallbacks) {
        try {
          cb()
        } catch (err) {
          console.error("[WebTransport] wsReady callback threw:", err)
        }
      }
    }

    this.ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as unknown
        // Attach-protocol frames carry a `type` discriminator; legacy
        // global-broadcast frames carry a `channel` discriminator. Routing
        // by which field is present lets the two coexist on the same WS.
        if (
          parsed &&
          typeof parsed === "object" &&
          "type" in (parsed as object)
        ) {
          this.eventStreamInstance?.handleServerFrame(parsed)
          return
        }
        const event = parsed as WebEvent
        if (event.channel === WS_READY_CHANNEL) {
          this.readyResolve()
          // Application-level ready: the link is fully usable again. Reset the
          // backoff counter and clear the reconnect dialog. Reset happens here
          // (not in onopen) so a socket that opens then drops before `__ready__`
          // keeps growing its backoff instead of restarting from 1s.
          this.wsFailCount = 0
          this.setConnState("connected")
          if (this.hasReadiedOnce) {
            // Reconnect path: server-side receiver_count was 0 during the
            // disconnect window, so any event fired in that gap was dropped.
            // Notify consumers to recover state (e.g. refetch snapshots).
            // Errors in user callbacks must not break sibling callbacks.
            for (const cb of this.reconnectCallbacks) {
              try {
                cb()
              } catch (err) {
                console.error("[WebTransport] reconnect callback threw:", err)
              }
            }
          } else {
            this.hasReadiedOnce = true
          }
          return
        }
        const handlers = this.handlers.get(event.channel)
        if (handlers) {
          for (const h of handlers) {
            h(event.payload)
          }
        }
      } catch {
        // ignore malformed messages
      }
    }

    this.ws.onclose = () => {
      this.ws = null
      this.wsOpen = false
      // New subscribers (and any concurrent subscribe() calls in flight)
      // must wait for the next connection's `__ready__` before resolving.
      this.resetReady()
      // A close fired by destroy()/teardownWs() detaches handlers first, so
      // this runs only for genuine drops. Surface "reconnecting" immediately
      // (honest, instant) and let the backoff loop + health probe drive
      // recovery. We never log out here — only a definitive 401 from the
      // health probe can do that (see probeHealth).
      if (this.destroyed) return
      this.setConnState("reconnecting")
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }

    return true
  }

  // Schedule the next reconnect attempt with exponential backoff. Each failed
  // cycle (a drop, or a probe that found the server unreachable) grows the
  // delay 1s → 2s → 4s → … → 32s; we keep retrying forever. The timer fires a
  // health probe (not a bare connectWs) so every attempt re-classifies the
  // failure — crucially catching a token that expired while we were offline.
  private scheduleReconnect() {
    if (this.destroyed) return
    this.wsFailCount++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const shift = Math.min(this.wsFailCount - 1, 8)
    const delay = Math.min(WS_BACKOFF_INITIAL_MS << shift, WS_BACKOFF_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.probeHealth()
    }, delay)
  }

  // Authenticated liveness probe that classifies a dropped link into one of
  // three outcomes (see HEALTH_PROBE_TIMEOUT_MS). De-duped via
  // `healthProbeInFlight`; self-bounded by an AbortController so a dead-but-
  // listening server can't hang it.
  private async probeHealth(): Promise<void> {
    if (this.destroyed || this.healthProbeInFlight) return
    const token = getToken()
    if (!token) {
      // No token to validate — treat as unauthorized rather than spin.
      this.markUnauthorized()
      return
    }
    this.healthProbeInFlight = true
    const epoch = this.probeEpoch
    const controller = new AbortController()
    this.probeController = controller
    const timeout = setTimeout(
      () => controller.abort(),
      HEALTH_PROBE_TIMEOUT_MS
    )
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: "{}",
        signal: controller.signal,
      })
      // Bail if the machine moved on while awaiting (unauthorized / teardown):
      // a stale completion must not reopen the socket or re-arm the backoff.
      if (this.destroyed || epoch !== this.probeEpoch) return
      if (res.status === 401) {
        // Server is up and rejected the token → session genuinely expired.
        this.markUnauthorized()
        return
      }
      if (res.ok) {
        // Server up + token valid → rebuild the WS. onopen and the `__ready__`
        // frame will flip the dialog back to "connected". If the token vanished
        // between probe start and now (e.g. logout in another tab), connectWs
        // reports false → surface unauthorized rather than a stuck "reconnecting".
        if (!this.connectWs()) this.markUnauthorized()
        return
      }
      // Reachable but unhealthy (5xx, proxy error). Server's coming up or
      // degraded; keep retrying without logging the user out.
      this.scheduleReconnect()
    } catch {
      if (this.destroyed || epoch !== this.probeEpoch) return
      // Network error / probe timeout → unreachable. Stay "reconnecting" and
      // keep backing off. Never give up, never discard the token.
      this.scheduleReconnect()
    } finally {
      clearTimeout(timeout)
      if (this.probeController === controller) this.probeController = null
      this.healthProbeInFlight = false
    }
  }

  // Detach handlers BEFORE close() so the browser's async onclose can't see
  // this instance and drive a spurious state transition / backoff schedule.
  // Shared by connectWs (pre-rebuild), reconnectNow, markUnauthorized, and
  // destroy. Idempotent — a no-op when there's no live socket.
  private teardownWs() {
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      try {
        this.ws.close()
      } catch {
        // close() can throw on a socket in CONNECTING; the handlers are
        // already detached so the failure is inert.
      }
      this.ws = null
    }
    this.wsOpen = false
  }

  destroy() {
    this.destroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Abort any in-flight health probe; the `destroyed` guard already blocks
    // its post-await branches, but this frees the request promptly.
    this.invalidateProbe()
    // Detach handlers + close via the shared teardown so the browser's async
    // onclose can't resurrect the state machine on an instance the caller
    // already discarded. The `destroyed` guard covers any handler already
    // dispatched before this detach.
    this.teardownWs()
    this.handlers.clear()
    this.reconnectCallbacks.clear()
    this.wsReadyCallbacks.clear()
    this.connListeners.clear()
    this.eventStreamInstance?.destroy()
    this.eventStreamInstance = null
    // Settle any in-flight `subscribe()` awaiters so their promises don't
    // leak alongside the destroyed transport. Safe to call multiple times —
    // resolving an already-settled Promise is a no-op.
    this.readyResolve?.()
  }
}
