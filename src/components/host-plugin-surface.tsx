"use client"

import { useEffect, useMemo, useRef } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/app-error"
import { usePluginClientHtml } from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

type SurfaceContext = { id: string } & (
  | { type: "workspacePanel"; folderId: number }
  | { type: "settingsPanel" }
)

const CLIENT_TIMEOUT_MS = 12_000
const MAX_PENDING_CALLS = 4
const MAX_INPUT_BYTES = 64 * 1024

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
function buildDocument(html: string, key: string): string {
  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CLIENT_POLICY}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>
(() => {
  const key = ${JSON.stringify(key)};
  const pending = new Map();
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
  Object.defineProperty(window, "codeg", { value: Object.freeze({ ready, call, settings }) });
})();
</script>
${html}`
}

export function HostPluginSurface({
  pluginId,
  title,
  context,
}: {
  pluginId: string
  title: string
  context: SurfaceContext
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
}: {
  pluginId: string
  title: string
  context: SurfaceContext
  locale: string
  html: string
  host: Transport
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const { type, id } = context
  const folderId =
    context.type === "workspacePanel" ? context.folderId : undefined
  const { handshake, doc } = useMemo(() => {
    const handshake = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("")
    return { handshake, doc: buildDocument(html, handshake) }
    // A context or host change restarts the frame and disconnects the old port.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, type, id, folderId, locale, host, pluginId])

  useEffect(() => {
    let channel: MessageChannel | undefined
    function connect(event: MessageEvent) {
      if (
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
        if (!connected) {
          if (data?.type !== "authenticate" || data.key !== handshake) return
          connected = true
          port1.postMessage({
            type: "context",
            context: { type, id, folderId, locale },
          })
          return
        }
        if (
          !Number.isSafeInteger(data?.id) ||
          (data.operation !== "call" && data.operation !== "settings") ||
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
          const value = await handleRequest(
            host,
            pluginId,
            data.operation,
            input
          )
          port1.postMessage({ id: requestId, ok: true, value })
        } catch (cause) {
          port1.postMessage({
            id: requestId,
            ok: false,
            error: toErrorMessage(cause),
          })
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
      window.removeEventListener("message", connect)
      channel?.port1.close()
    }
  }, [handshake, folderId, host, id, locale, pluginId, type])

  return (
    <iframe
      key={handshake}
      ref={frame}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className="block h-80 w-full rounded-md border"
    />
  )
}

function handleRequest(
  host: Transport,
  pluginId: string,
  operation: "call" | "settings",
  payload: unknown
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
  })
}
