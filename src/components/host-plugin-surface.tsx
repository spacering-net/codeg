"use client"

import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/app-error"
import {
  usePluginClientHtml,
  validatePluginComposerInsertPayload,
  type HostPluginSessionContext,
  type PluginClientSurfaceSlot,
  type PluginComposerInsertResult,
} from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"
import { cn } from "@/lib/utils"

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

export type SurfaceContext =
  | ({ id: string } & (
      | { type: "workspacePanel"; folderId: number }
      | { type: "settingsPanel" }
      | { type: "pluginDetail" }
      | { type: "activationPanel" }
      | { type: "screen" }
      | ({
          type: "clientSurface"
          slot: PluginClientSurfaceSlot
        } & HostPluginSessionContext)
    ))
  | {
      type: "timelineItem"
      kind: string
      version: number
      itemId: string
      conversationId: number
      data: unknown
      updatedAt?: string
    }

function safeSerializeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null"
  } catch {
    return "null"
  }
}

const CLIENT_TIMEOUT_MS = 12_000
const MAX_PENDING_CALLS = 4
const MAX_INPUT_BYTES = 64 * 1024
const LIFECYCLE_EVENT_CHANNEL = "host-plugins://event"

type PluginEvent = {
  pluginId: string
  event: string
  folderId?: number | null
  conversationId?: number | null
  data: unknown
}

const CLIENT_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

// A unique handshake key binds the MessagePort to the installed document,
// even if the sandboxed frame navigates and retains its WindowProxy.
function buildDocument(
  html: string,
  key: string,
  options: { composerInsert: boolean }
): string {
  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CLIENT_POLICY}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>
(() => {
  const key = ${JSON.stringify(key)};
  const pending = new Map();
  const subscribers = new Set();
  let seq = 0;
  let port;
  const ready = new Promise(resolve => {
    const announce = () => parent.postMessage({ type: "codeg-plugin-ready", key }, "*");
    const interval = setInterval(announce, 150);
    const bind = event => {
      if (event.source !== parent || event.data?.type !== "codeg-plugin-port" || !event.ports[0]) return;
      removeEventListener("message", bind);
      clearInterval(interval);
      port = event.ports[0];
      port.onmessage = ({ data }) => {
        if (data.type === "context") {
          resolve(Object.freeze(data.context));
          return;
        }
        if (data.type === "event") {
          for (const listener of subscribers) listener(data.value);
          return;
        }
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        data.ok ? request.resolve(data.value) : request.reject(new Error(data.error));
      };
      port.postMessage({ type: "authenticate", key });
    };
    addEventListener("message", bind);
    setTimeout(() => clearInterval(interval), ${CLIENT_TIMEOUT_MS});
    announce();
  });
  const request = async (operation, input) => {
    await ready;
    if (pending.size >= ${MAX_PENDING_CALLS}) {
      throw new Error("Invalid or busy plugin method");
    }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Plugin method timed out"));
      }, ${CLIENT_TIMEOUT_MS});
      pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      try { port.postMessage({ id, operation, json: JSON.stringify(input) }); }
      catch (error) { pending.get(id).reject(error); pending.delete(id); }
    });
  };
  const call = (method, input = null) => request("call", { method, input });
  const settings = Object.freeze({
    read: () => request("settings", { type: "read" }),
    save: (revision, value) => request("settings", { type: "save", revision, value }),
  });
  const events = Object.freeze({
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  });
  const api = { ready, call, settings, events };
  ${
    options.composerInsert
      ? `api.composer = Object.freeze({
    insertText: (text) => request("composer", { type: "insertText", text }),
  });`
      : ""
  }
  Object.defineProperty(window, "codeg", { value: Object.freeze(api) });
})();
</script>
${html}`
}

export type PluginComposerInsertHandler = (
  text: string
) => PluginComposerInsertResult | Promise<PluginComposerInsertResult>

export function HostPluginSurface({
  pluginId,
  title,
  context,
  className,
  onComposerInsertText,
}: {
  pluginId: string
  title: string
  context: SurfaceContext
  className?: string
  /** Controlled plain-text insertion handler; honored ONLY for `composer` clientSurfaces. */
  onComposerInsertText?: PluginComposerInsertHandler
}) {
  const t = useTranslations("HostPlugins")
  const locale = useLocale()
  const { data, error, refresh, transport } = usePluginClientHtml(pluginId)
  if (error) {
    return (
      <div className="space-y-2">
        <p role="alert" className="break-words text-xs text-destructive">
          {toErrorMessage(error)}
        </p>
        <Button size="xs" variant="outline" onClick={refresh}>
          {t("retry")}
        </Button>
      </div>
    )
  }
  if (!data || !transport) {
    return <p className="text-xs text-muted-foreground">{t("loading")}</p>
  }
  return (
    <PluginFrame
      pluginId={pluginId}
      title={title}
      html={data}
      locale={locale}
      context={context}
      host={transport}
      className={className}
      onComposerInsertText={onComposerInsertText}
    />
  )
}

function PluginFrame({
  pluginId,
  title,
  context,
  locale,
  html,
  host,
  className,
  onComposerInsertText,
}: {
  pluginId: string
  title: string
  context: SurfaceContext
  locale: string
  html: string
  host: Transport
  className?: string
  onComposerInsertText?: PluginComposerInsertHandler
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const type = context.type
  const id = context.type === "timelineItem" ? undefined : context.id
  const slot = context.type === "clientSurface" ? context.slot : undefined
  const folderId =
    context.type === "workspacePanel" || context.type === "clientSurface"
      ? context.folderId
      : undefined
  const conversationId =
    context.type === "clientSurface" || context.type === "timelineItem"
      ? context.conversationId
      : undefined
  const sessionKey =
    context.type === "clientSurface" ? context.sessionKey : undefined
  const kind = context.type === "timelineItem" ? context.kind : undefined
  const version = context.type === "timelineItem" ? context.version : undefined
  const itemId = context.type === "timelineItem" ? context.itemId : undefined
  const updatedAt =
    context.type === "timelineItem" ? context.updatedAt : undefined
  const dataJson =
    context.type === "timelineItem"
      ? safeSerializeJson(context.data)
      : undefined
  const allowComposerInsert =
    type === "clientSurface" &&
    slot === "composer" &&
    Boolean(onComposerInsertText)
  const composerInsertRef = useRef(onComposerInsertText)
  useIsomorphicLayoutEffect(() => {
    composerInsertRef.current = onComposerInsertText
  }, [onComposerInsertText])
  const { handshake, doc } = useMemo(() => {
    const handshake = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("")
    return {
      handshake,
      doc: buildDocument(html, handshake, {
        composerInsert: allowComposerInsert,
      }),
    }
    // A context, capability, or host change restarts the frame and disconnects the old port.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    html,
    type,
    id,
    slot,
    folderId,
    conversationId,
    sessionKey,
    kind,
    version,
    itemId,
    updatedAt,
    dataJson,
    allowComposerInsert,
    locale,
    host,
    pluginId,
  ])

  useEffect(() => {
    let channel: MessageChannel | undefined
    let unsubscribe: (() => void) | undefined
    let closed = false
    function connect(event: MessageEvent) {
      if (
        closed ||
        channel ||
        event.origin !== "null" ||
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "codeg-plugin-ready" ||
        event.data?.key !== handshake
      )
        return
      channel = new MessageChannel()
      const { port1, port2 } = channel
      let activeCalls = 0
      let connected = false
      port1.onmessage = async ({ data }) => {
        if (closed) return
        if (!connected) {
          if (data?.type !== "authenticate" || data.key !== handshake) return
          connected = true
          port1.postMessage({
            type: "context",
            context:
              type === "timelineItem"
                ? {
                    type: "timelineItem" as const,
                    kind,
                    version,
                    itemId,
                    conversationId,
                    data: dataJson !== undefined ? JSON.parse(dataJson) : null,
                    locale,
                  }
                : type === "clientSurface"
                  ? {
                      type,
                      slot,
                      id,
                      folderId: folderId ?? null,
                      conversationId: conversationId ?? null,
                      sessionKey,
                      locale,
                    }
                  : { type, id, folderId, locale },
          })
          void host
            .subscribe<PluginEvent>(LIFECYCLE_EVENT_CHANNEL, (event) => {
              if (closed || event.pluginId !== pluginId) return
              if (type === "workspacePanel") {
                if (event.folderId !== folderId) return
              } else if (type === "clientSurface") {
                if (folderId != null) {
                  if (event.folderId !== folderId) return
                } else if (event.folderId != null) {
                  return
                }
                if (
                  event.conversationId != null &&
                  event.conversationId !== conversationId
                ) {
                  return
                }
              } else if (type === "timelineItem") {
                if (
                  event.conversationId != null &&
                  event.conversationId !== conversationId
                ) {
                  return
                }
              }
              port1.postMessage({ type: "event", value: event })
            })
            .then(
              (stop) => {
                if (closed) stop()
                else unsubscribe = stop
              },
              () => undefined
            )
          return
        }
        if (
          !Number.isSafeInteger(data?.id) ||
          (data.operation !== "call" &&
            data.operation !== "settings" &&
            data.operation !== "composer") ||
          typeof data.json !== "string"
        )
          return
        const requestId = data.id
        if (
          activeCalls >= MAX_PENDING_CALLS ||
          data.json.length > MAX_INPUT_BYTES
        ) {
          port1.postMessage({
            id: requestId,
            ok: false,
            error: "Invalid or busy plugin method",
          })
          return
        }
        activeCalls += 1
        try {
          const input: unknown = JSON.parse(data.json)
          let value: unknown
          if (data.operation === "composer") {
            const insertHandler = allowComposerInsert
              ? composerInsertRef.current
              : undefined
            if (!insertHandler || closed) {
              throw new Error("Composer insertion is unavailable")
            }
            const text = validatePluginComposerInsertPayload(input)
            value = await insertHandler(text)
          } else {
            value = await handleRequest(
              host,
              pluginId,
              data.operation,
              input,
              type === "timelineItem" ? conversationId : undefined
            )
          }
          if (!closed) {
            port1.postMessage({ id: requestId, ok: true, value })
          }
        } catch (cause) {
          if (!closed) {
            port1.postMessage({
              id: requestId,
              ok: false,
              error: toErrorMessage(cause),
            })
          }
        } finally {
          activeCalls -= 1
        }
      }
      frame.current?.contentWindow?.postMessage(
        { type: "codeg-plugin-port" },
        "*",
        [port2]
      )
    }
    window.addEventListener("message", connect)
    return () => {
      closed = true
      unsubscribe?.()
      window.removeEventListener("message", connect)
      if (channel) {
        channel.port1.onmessage = null
        channel.port1.close()
      }
    }
  }, [
    handshake,
    slot,
    folderId,
    conversationId,
    sessionKey,
    kind,
    version,
    itemId,
    dataJson,
    allowComposerInsert,
    host,
    id,
    locale,
    pluginId,
    type,
  ])

  return (
    <iframe
      key={handshake}
      ref={frame}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className={cn("block h-80 w-full rounded-md border", className)}
    />
  )
}

function handleRequest(
  host: Transport,
  pluginId: string,
  operation: "call" | "settings",
  payload: unknown,
  conversationId?: number | null
) {
  if (operation === "settings") {
    return host.call<unknown>("host_plugins_settings", {
      pluginId,
      request: payload,
    })
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("method" in payload) ||
    typeof payload.method !== "string" ||
    payload.method.length > 80 ||
    !("input" in payload)
  ) {
    throw new Error("Invalid plugin method")
  }
  return host.call<unknown>("host_plugins_call", {
    pluginId,
    method: payload.method,
    input: payload.input,
    ...(conversationId != null ? { conversationId } : {}),
  })
}
