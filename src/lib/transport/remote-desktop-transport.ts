import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { WS_READY_CHANNEL } from "./constants"
import type { AttachTransportHost } from "./web-event-stream"
import { WebEventStream } from "./web-event-stream"
import type {
  CallOptions,
  EventStream,
  RemoteTransportConfig,
  Transport,
  UnsubscribeFn,
} from "./types"

// See WebTransport for rationale. Bounded so an older remote codeg-server
// (no `__ready__` support) can't permanently hang the desktop UI.
const READY_TIMEOUT_MS = 5_000

/// Internal lifecycle channels emitted by the Rust-side proxy
/// (`src-tauri/src/commands/remote_proxy.rs`). Keep these in sync with
/// the `WS_*_CHANNEL` consts on the Rust side. The string literals match
/// the wire format exactly; we re-export `__ready__` via `WS_READY_CHANNEL`
/// to keep the shared-constants invariant with `WebTransport`.
const WS_DISCONNECTED_CHANNEL = "__disconnected__"
/// The server refused the token on the socket's handshake (HTTP 401).
const WS_UNAUTHORIZED_CHANNEL = "__unauthorized__"

// Two wire shapes flow on the same `remote-ws-event-{id}` Tauri event:
//   1. Legacy `{channel, payload}` envelopes from the WebEventBroadcaster
//      firehose (`__ready__`, folder/app channels, etc.).
//   2. Top-level attach-protocol frames `{type, ...}` from the per-connection
//      WS attach forwarders (`ServerMsg` in `web/ws_attach.rs`).
// `forward_frame` in the Rust proxy passes the parsed JSON through
// without re-shaping, so the handler must discriminate on which top-level
// field is present. Using `unknown` here forces that discrimination at the
// call site rather than silently destructuring `undefined`.
type WsFrame = unknown

export type RemoteConnectionState =
  | "connected"
  | "reconnecting"
  | "disconnected"

const ATTACH_FRAME_TYPES = new Set([
  "snapshot",
  "replay",
  "event",
  "detached",
  "pong",
])

function isAttachFrame(
  frame: unknown
): frame is { type: string; [k: string]: unknown } {
  if (!frame || typeof frame !== "object") return false
  const t = (frame as { type?: unknown }).type
  return typeof t === "string" && ATTACH_FRAME_TYPES.has(t)
}

interface LegacyEnvelope {
  channel: string
  payload: unknown
}

interface RustError {
  code?: string
  message?: string
  detail?: string | null
  i18n_key?: string | null
  i18n_params?: Record<string, string> | null
}

function isAuthenticationFailed(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as RustError).code === "authentication_failed"
  }
  return false
}

/**
 * Transport that the desktop client uses when a window is bound to a
 * remote codeg-server. Every HTTP call and WebSocket event is routed
 * through Rust commands (`remote_http_call`, `remote_ws_subscribe`,
 * `remote_ws_unsubscribe`) defined in `src-tauri/src/commands/remote_proxy.rs`.
 *
 * We never open a fetch or WebSocket from the webview directly: the Tauri
 * webview is a secure context, so plain `http://` / `ws://` connections
 * to the remote host get blocked by mixed-content rules. Routing through
 * Rust (reqwest + tokio-tungstenite) bypasses those restrictions.
 *
 * Window isolation: the Rust side dispatches each WS frame only to the
 * webview labels that explicitly subscribed via this transport, never
 * `app.emit` broadcasting. Two remote workspaces opened side-by-side
 * see entirely separate event streams.
 */
export class RemoteDesktopTransport implements Transport {
  private handlers = new Map<string, Set<(payload: unknown) => void>>()
  private config: RemoteTransportConfig
  private readyPromise!: Promise<void>
  private readyResolve!: () => void
  /// Tracks whether `__ready__` has arrived since this transport was
  /// constructed. The first arrival is the initial connect; subsequent
  /// arrivals are reconnects (after `__disconnected__` reset the promise).
  /// A clean initial connect needs no refetch, but one preceded by failed
  /// startup reads must refresh the workspace on its first ready too.
  private hasReadiedOnce = false
  // Initial loads can fail while a restored remote is offline. Its first
  // eventual ready must refetch that state too, even without an earlier ready.
  private recoveryNeeded = false
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private resubscribing = false
  private reconnectCallbacks = new Set<() => void>()
  private connectionState: RemoteConnectionState = "reconnecting"
  private connectionListeners = new Set<() => void>()
  private readyCallbacks = new Set<() => void>()
  /// Listener handle for `remote-ws-event-{id}`. Null when not subscribed.
  private unlistenWsEvent: UnlistenFn | null = null
  /// Opaque ID generated at construction time, passed to `remote_ws_subscribe`
  /// and `remote_ws_unsubscribe`. Because it is known before the invoke
  /// returns, destroy() can always issue a clean unsubscribe regardless of
  /// whether the subscribe invoke is still in-flight.
  private readonly subscriptionId = crypto.randomUUID()
  /// Null = not yet requested; true = subscribe invoke in-flight or done.
  private wsStarted = false
  /// Latched in `destroy()` so any in-flight `subscribe()` awaiters
  /// settle promptly instead of hanging on `readyPromise`.
  private destroyed = false
  /// Attach-protocol plumbing — mirrors WebTransport. `wsOpen` is true
  /// between `__ready__` arrival and the next `__disconnected__`. The
  /// EventStream uses `wsOpen` and `wsReadyCallbacks` to decide whether
  /// to send attach frames immediately vs. queue them for the next
  /// reconnect cycle.
  private wsOpen = false
  private wsReadyCallbacks = new Set<() => void>()
  private eventStreamInstance: WebEventStream | null = null
  /// Debounce timer for the "send failed → reissue active attaches" path.
  /// `sendWsFrame` is fire-and-forget over a Tauri invoke; if Rust reports
  /// the frame was not queued (no entry / queue full / timeout) we kick the
  /// `wsReadyCallbacks` after a short delay so `WebEventStream.reattachAll`
  /// runs once per failure burst rather than once per failed frame.
  private sendFailRetryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: RemoteTransportConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
    }
    this.resetReady()
  }

  private resetReady() {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve
    })
  }

  // Bounded wait on `readyPromise`; logs and falls through on timeout
  // rather than hanging the UI. Public for the same reason as
  // WebTransport.waitForReady — callers gate HTTP commands on WS readiness
  // to avoid mid-reconnect drops.
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
      this.recoveryNeeded = true
      console.warn(
        `[RemoteDesktopTransport] WS __ready__ frame did not arrive within ${READY_TIMEOUT_MS}ms; ` +
          "proceeding without server-side subscribe confirmation (initial-connect race may reopen)."
      )
    }
  }

  async call<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: CallOptions
  ): Promise<T> {
    const initialRequest = !this.hasReadiedOnce
    try {
      // Forward `timeoutMs` through to `remote_http_call`. Without this,
      // the Rust client's 30s default fires before the backend can answer
      // — long-running commands (the 60s ACP probe in particular) would
      // surface "Request timed out" before reaching their own deadline.
      const result = await invoke<T>("remote_http_call", {
        connectionId: this.config.id,
        command,
        args: args ?? {},
        timeoutMs: options?.timeoutMs,
      })
      return result
    } catch (err) {
      if (this.destroyed) throw err
      // The Rust proxy returns 401 from the remote server as
      // `AppErrorCode::AuthenticationFailed`. Surface the connection-expired
      // UI in just the calling window (the rest stay live until they
      // themselves hit a 401 — per design we don't broadcast).
      if (isAuthenticationFailed(err)) {
        if (this.wsOpen) this.resetReady()
        this.wsOpen = false
        this.setConnectionState("disconnected")
        this.config.onUnauthorized?.()
      } else if (
        initialRequest &&
        err &&
        typeof err === "object" &&
        (err as RustError).code === "network_error"
      ) {
        // Initial folder/conversation reads are not gated on the WS. If
        // they failed offline, the first ready must retry their hydration.
        this.recoveryNeeded = true
        if (this.wsOpen && this.recoveryTimer === null) {
          // A slow failed HTTP request can settle AFTER the first ready.
          // Let its caller finish recording the failure before refreshing.
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null
            if (!this.destroyed && this.wsOpen) this.notifyReconnect()
          }, 0)
        }
      }
      throw err
    }
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

    if (!this.wsStarted && !this.destroyed) {
      await this.startWs()
    }

    // Gate on the server-side broadcaster receiver being subscribed (see
    // WebTransport for the full rationale). Without this await, events
    // fired before the server-side `subscribe()` runs are dropped by the
    // `receiver_count == 0` guard, leaving the UI stuck on "正在连接".
    await this.waitForReady()

    return () => {
      this.handlers.get(event)?.delete(wrappedHandler)
    }
  }

  isDesktop(): boolean {
    return true
  }

  onReconnect(callback: () => void): UnsubscribeFn {
    this.reconnectCallbacks.add(callback)
    return () => {
      this.reconnectCallbacks.delete(callback)
    }
  }

  getConnectionSnapshot(): RemoteConnectionState {
    return this.connectionState
  }

  subscribeConnection(callback: () => void): UnsubscribeFn {
    this.connectionListeners.add(callback)
    return () => {
      this.connectionListeners.delete(callback)
    }
  }

  /** Retry a stopped proxy in place, preserving unsaved UI state and streams. */
  reconnectNow(): void {
    if (
      this.destroyed ||
      this.resubscribing ||
      this.connectionState !== "disconnected"
    ) {
      return
    }
    this.resubscribing = true
    this.recoveryNeeded = true
    this.wsStarted = true
    this.setConnectionState("reconnecting")
    void (async () => {
      try {
        // Await removal before reusing the opaque ID, or a delayed
        // unsubscribe could remove the freshly inserted registration.
        await invoke("remote_ws_unsubscribe", {
          connectionId: this.config.id,
          subscriptionId: this.subscriptionId,
        })
        if (this.destroyed) return
        if (this.unlistenWsEvent) await this.subscribeWs()
        else await this.startWs()
      } catch (err) {
        if (!this.destroyed) {
          this.setConnectionState("disconnected")
          console.warn("[RemoteDesktopTransport] reconnect failed:", err)
        }
      } finally {
        this.resubscribing = false
      }
    })()
  }

  private notifyReconnect(): void {
    this.recoveryNeeded = false
    if (this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
    for (const callback of this.reconnectCallbacks) {
      try {
        callback()
      } catch (err) {
        console.error("[RemoteDesktopTransport] reconnect callback threw:", err)
      }
    }
  }

  private setConnectionState(state: RemoteConnectionState): void {
    if (this.connectionState === state) return
    this.connectionState = state
    for (const callback of this.connectionListeners) {
      try {
        callback()
      } catch (err) {
        console.error(
          "[RemoteDesktopTransport] connection listener threw:",
          err
        )
      }
    }
  }

  onReady(callback: () => void): UnsubscribeFn {
    this.readyCallbacks.add(callback)
    return () => {
      this.readyCallbacks.delete(callback)
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
      // Ensure the proxy WS is being maintained so attach frames have
      // somewhere to land. Idempotent — the proxy folds duplicate
      // subscribe calls into the existing entry.
      if (!this.wsStarted && !this.destroyed) {
        void this.startWs().catch((err) => {
          console.warn(
            "[RemoteDesktopTransport] startWs from eventStream failed:",
            err
          )
        })
      }
    }
    return this.eventStreamInstance
  }

  private sendWsFrame(frame: object): boolean {
    if (!this.wsOpen) return false
    const text = JSON.stringify(frame)
    // Optimistic-true return preserves the sync-boolean contract from
    // AttachTransportHost. Real delivery confirmation is async: the Rust
    // proxy now returns Err if the frame couldn't be queued (no entry,
    // closed channel, or 2s queue-full timeout). On failure we trigger
    // the same reattach path that fires on natural reconnect — without
    // this, a dropped attach would leave the subscription stuck waiting
    // for a snapshot until the next WS reconnect.
    void invoke("remote_ws_send_text", {
      connectionId: this.config.id,
      text,
    }).catch((err) => {
      console.warn("[RemoteDesktopTransport] remote_ws_send_text failed:", err)
      this.scheduleReattachAfterSendFailure()
    })
    return true
  }

  private scheduleReattachAfterSendFailure() {
    if (this.destroyed || this.sendFailRetryTimer !== null) return
    this.sendFailRetryTimer = setTimeout(() => {
      this.sendFailRetryTimer = null
      // If the WS dropped in the meantime, the natural __ready__ on
      // reconnect will fire wsReadyCallbacks itself — skip to avoid a
      // wasted attach-burst against a closed channel.
      if (this.destroyed || !this.wsOpen) return
      for (const cb of this.wsReadyCallbacks) {
        try {
          cb()
        } catch (err) {
          console.error(
            "[RemoteDesktopTransport] wsReady callback threw on send-failure retry:",
            err
          )
        }
      }
    }, 200)
  }

  private async startWs() {
    this.wsStarted = true
    try {
      const unlisten = await listen<WsFrame>(
        `remote-ws-event-${this.config.id}`,
        (event) => this.handleWsEvent(event.payload)
      )
      if (this.destroyed) {
        unlisten()
        this.wsStarted = false
        return
      }
      this.unlistenWsEvent = unlisten
    } catch (err) {
      this.wsStarted = false
      this.recoveryNeeded = true
      this.setConnectionState("disconnected")
      throw err
    }

    await this.subscribeWs()
  }

  private async subscribeWs() {
    try {
      await invoke("remote_ws_subscribe", {
        connectionId: this.config.id,
        subscriptionId: this.subscriptionId,
        windowInstanceId: this.config.windowInstanceId,
      })
      if (this.destroyed) {
        // destroy() ran while the invoke was in-flight; clean up immediately.
        invoke("remote_ws_unsubscribe", {
          connectionId: this.config.id,
          subscriptionId: this.subscriptionId,
        }).catch(() => {})
        this.unlistenWsEvent?.()
        this.unlistenWsEvent = null
      }
    } catch (err) {
      this.unlistenWsEvent?.()
      this.unlistenWsEvent = null
      this.wsStarted = false
      this.recoveryNeeded = true
      this.setConnectionState("disconnected")
      throw err
    }
  }

  private handleWsEvent(frame: WsFrame) {
    if (this.destroyed) return

    // Attach-protocol frames are top-level `{ type, ... }` (the Rust proxy
    // forwards the WS text frame as-is, so the wire shape `ServerMsg` from
    // `web/ws_attach.rs` arrives unwrapped). Discriminate by which top-level
    // field is present — this MUST mirror `WebTransport.onmessage`, otherwise
    // remote-desktop loses every snapshot/replay/event frame and the
    // attach-protocol UI silently goes dark.
    if (isAttachFrame(frame)) {
      this.eventStreamInstance?.handleServerFrame(frame)
      return
    }

    if (!frame || typeof frame !== "object") return
    const { channel, payload } = frame as LegacyEnvelope
    if (typeof channel !== "string") return

    if (channel === WS_READY_CHANNEL) {
      // Rust may acknowledge another subscription in the same webview while
      // the shared socket is already ready. This is not another reconnect.
      if (this.wsOpen) return
      const shouldRefresh = this.hasReadiedOnce || this.recoveryNeeded
      this.hasReadiedOnce = true
      this.wsOpen = true
      this.readyResolve()
      this.setConnectionState("connected")
      for (const cb of this.readyCallbacks) {
        try {
          cb()
        } catch (err) {
          console.error("[RemoteDesktopTransport] ready callback threw:", err)
        }
      }
      // Notify EventStream so it can re-issue attach frames for any
      // active subscriptions. Fires on initial connect AND every reconnect.
      for (const cb of this.wsReadyCallbacks) {
        try {
          cb()
        } catch (err) {
          console.error("[RemoteDesktopTransport] wsReady callback threw:", err)
        }
      }
      if (shouldRefresh) {
        // Reconnect path: server-side receiver_count was 0 during the
        // disconnect window, so any event fired in that gap was dropped.
        // Notify consumers to recover state (e.g. refetch snapshots).
        // Errors in user callbacks must not break sibling callbacks.
        this.notifyReconnect()
      }
      return
    }
    if (channel === WS_DISCONNECTED_CHANNEL) {
      this.recoveryNeeded = true
      this.setConnectionState("reconnecting")
      // Repeated failed handshakes share the same waiters. Replacing their
      // promise again would strand them until the readiness timeout.
      if (this.wsOpen) this.resetReady()
      this.wsOpen = false
      return
    }
    if (channel === WS_UNAUTHORIZED_CHANNEL) {
      // Only a definitive authentication rejection ends Rust's retries, and
      // it drops this window's subscription: the same expiry an HTTP 401
      // reports.
      this.recoveryNeeded = true
      if (this.wsOpen) this.resetReady()
      this.wsOpen = false
      this.setConnectionState("disconnected")
      this.config.onUnauthorized?.()
      return
    }
    const handlers = this.handlers.get(channel)
    if (handlers) {
      for (const h of handlers) {
        h(payload)
      }
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.wsOpen = false
    if (this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
    if (this.sendFailRetryTimer !== null) {
      clearTimeout(this.sendFailRetryTimer)
      this.sendFailRetryTimer = null
    }
    if (this.unlistenWsEvent) {
      this.unlistenWsEvent()
      this.unlistenWsEvent = null
    }
    if (this.wsStarted) {
      invoke("remote_ws_unsubscribe", {
        connectionId: this.config.id,
        subscriptionId: this.subscriptionId,
      }).catch((err) => {
        console.warn(
          "[RemoteDesktopTransport] remote_ws_unsubscribe failed:",
          err
        )
      })
      this.wsStarted = false
    }
    this.handlers.clear()
    this.reconnectCallbacks.clear()
    this.connectionListeners.clear()
    this.readyCallbacks.clear()
    this.wsReadyCallbacks.clear()
    this.eventStreamInstance?.destroy()
    this.eventStreamInstance = null
    // Settle any in-flight `subscribe()` awaiters so their promises don't
    // leak alongside the destroyed transport. Safe to call multiple times.
    this.readyResolve?.()
  }
}
