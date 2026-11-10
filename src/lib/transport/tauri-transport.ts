import type { CallOptions, Transport, UnsubscribeFn } from "./types"

type TauriEventListenersWindow = {
  __TAURI_INTERNALS__?: {
    unregisterCallback?: (callbackId: number) => void
  }
  __TAURI_EVENT_PLUGIN_INTERNALS__?: {
    unregisterListener?: (event: string, eventId: number) => void
  }
}

export class TauriTransport implements Transport {
  async call<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: CallOptions
  ): Promise<T> {
    // Tauri invoke() has no client-side timeout — the IPC channel runs
    // for as long as the command needs. `options.timeoutMs` is part
    // of the Transport contract for web-mode parity, ignored here.
    void options
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke(command, args)
  }

  // Tauri registers a callback before awaiting the native listener. The
  // listener's registration eval can arrive after its invoke response; cleanup
  // then cannot find handlerId in the event registry. A rejected listen never
  // populates that registry either. Retain our callback ID so both paths can
  // release the callback and everything captured by the subscriber.
  //
  // Native unlisten must still run if the event registry is absent or its
  // cleanup throws, as happened in older Tauri releases.
  async subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn> {
    const { invoke, transformCallback } = await import("@tauri-apps/api/core")
    const handlerId = transformCallback((e: { payload: T }) => {
      handler(e.payload)
    })
    const releaseCallback = () => {
      const internals = (window as unknown as TauriEventListenersWindow)
        .__TAURI_INTERNALS__
      internals?.unregisterCallback?.(handlerId)
    }
    let eventId: number
    try {
      eventId = await invoke<number>("plugin:event|listen", {
        event,
        target: { kind: "Any" },
        handler: handlerId,
      })
    } catch (error) {
      releaseCallback()
      throw error
    }

    let unlistened = false
    return () => {
      if (unlistened) return
      unlistened = true
      releaseCallback()
      try {
        const internals = (window as unknown as TauriEventListenersWindow)
          .__TAURI_EVENT_PLUGIN_INTERNALS__
        internals?.unregisterListener?.(event, eventId)
      } catch {
        // Registration eval has not landed yet; server-side unlisten below
        // still clears the listener so events stop flowing.
      }
      // Fire-and-forget: callers expect a sync unsubscribe, and a failure here
      // only means the backend already forgot this listener.
      invoke("plugin:event|unlisten", { event, eventId }).catch(() => {})
    }
  }

  isDesktop(): boolean {
    return true
  }
}
