"use client"

import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/app-error"
import {
  MAX_PLUGIN_FILE_WRITE_TEXT_BYTES,
  isCurrentReadyHostTransport,
  usePluginClientHtml,
  validatePluginComposerInsertPayload,
  validatePluginFileReadRequest,
  validatePluginFileReadTextResult,
  validatePluginFileWriteRequest,
  type HostPluginSessionContext,
  type PluginClientSurfaceSlot,
  type PluginComposerInsertResult,
  type PluginFileReadTextResult,
  type PluginFileWriteTextResult,
} from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"
import { cn } from "@/lib/utils"

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

export type SurfaceContext = { id: string } & (
  | { type: "workspacePanel"; folderId: number }
  | { type: "settingsPanel" }
  | { type: "pluginDetail" }
  | { type: "activationPanel" }
  | { type: "screen" }
  | { type: "sidebarView" }
  | {
      type: "filePanel"
      /** Bare file name exposed to the plugin iframe (never a directory or absolute path). */
      fileName: string
      /** Internal host-only scope identity (e.g. tab id) used to restart the
       *  iframe when switching between different files with the same name.
       *  Never sent to the iframe. */
      fileScopeKey: string
    }
  | ({
      type: "clientSurface"
      slot: PluginClientSurfaceSlot
    } & HostPluginSessionContext)
)

const CLIENT_TIMEOUT_MS = 12_000
const MAX_PENDING_CALLS = 4
const MAX_INPUT_BYTES = 64 * 1024
// Accommodate a full 64 KiB UTF-8 text payload even with JSON string escaping
// (up to 6 chars per escaped control character plus envelope overhead) so
// exact-limit and slightly-oversized writes reach validatePluginFileWriteRequest.
const MAX_FILE_INPUT_JSON_LENGTH = 6 * MAX_PLUGIN_FILE_WRITE_TEXT_BYTES + 1024
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
  options: {
    composerInsert: boolean
    fileReadText: boolean
    fileWriteText: boolean
  }
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
  ${
    options.fileReadText
      ? `api.file = Object.freeze({
    readText: (...args) => {
      if (args.length > 0) {
        return Promise.reject(new Error("file.readText does not accept arguments"));
      }
      return request("file", { type: "readText" });
    },${
      options.fileWriteText
        ? `
    writeText: (...args) => {
      if (args.length !== 1 || typeof args[0] !== "string") {
        return Promise.reject(new Error("file.writeText requires a single string argument"));
      }
      return request("file", { type: "writeText", text: args[0] });
    },`
        : ""
    }
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

export type PluginFileReadTextHandler = () =>
  | PluginFileReadTextResult
  | Promise<PluginFileReadTextResult>

export type PluginFileWriteTextHandler = (
  text: string
) => PluginFileWriteTextResult | Promise<PluginFileWriteTextResult>

export function HostPluginSurface({
  pluginId,
  title,
  context,
  className,
  onComposerInsertText,
  onFileReadText,
  onFileWriteText,
}: {
  pluginId: string
  title: string
  context: SurfaceContext
  className?: string
  /** Controlled plain-text insertion handler; honored ONLY for `composer` clientSurfaces. */
  onComposerInsertText?: PluginComposerInsertHandler
  /** Read-only current text file snapshot handler; honored ONLY for `filePanel` surfaces. */
  onFileReadText?: PluginFileReadTextHandler
  /** Controlled current text file buffer write handler; honored ONLY for writable `filePanel` surfaces. */
  onFileWriteText?: PluginFileWriteTextHandler
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
      onFileReadText={onFileReadText}
      onFileWriteText={onFileWriteText}
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
  onFileReadText,
  onFileWriteText,
}: {
  pluginId: string
  title: string
  context: SurfaceContext
  locale: string
  html: string
  host: Transport
  className?: string
  onComposerInsertText?: PluginComposerInsertHandler
  onFileReadText?: PluginFileReadTextHandler
  onFileWriteText?: PluginFileWriteTextHandler
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const { type, id } = context
  const slot = context.type === "clientSurface" ? context.slot : undefined
  const folderId =
    context.type === "workspacePanel" || context.type === "clientSurface"
      ? context.folderId
      : undefined
  const conversationId =
    context.type === "clientSurface" ? context.conversationId : undefined
  const sessionKey =
    context.type === "clientSurface" ? context.sessionKey : undefined
  const fileName = context.type === "filePanel" ? context.fileName : undefined
  const fileScopeKey =
    context.type === "filePanel" ? context.fileScopeKey : undefined
  const allowComposerInsert =
    type === "clientSurface" &&
    slot === "composer" &&
    Boolean(onComposerInsertText)
  const allowFileReadText = type === "filePanel" && Boolean(onFileReadText)
  const allowFileWriteText = allowFileReadText && Boolean(onFileWriteText)
  const composerInsertRef = useRef(onComposerInsertText)
  const fileReadTextRef = useRef(onFileReadText)
  const fileWriteTextRef = useRef(onFileWriteText)
  useIsomorphicLayoutEffect(() => {
    composerInsertRef.current = onComposerInsertText
    fileReadTextRef.current = onFileReadText
    fileWriteTextRef.current = onFileWriteText
  }, [onComposerInsertText, onFileReadText, onFileWriteText])
  const { handshake, doc } = useMemo(() => {
    const handshake = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("")
    return {
      handshake,
      doc: buildDocument(html, handshake, {
        composerInsert: allowComposerInsert,
        fileReadText: allowFileReadText,
        fileWriteText: allowFileWriteText,
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
    fileName,
    fileScopeKey,
    allowComposerInsert,
    allowFileReadText,
    allowFileWriteText,
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
              type === "clientSurface"
                ? {
                    type,
                    slot,
                    id,
                    folderId: folderId ?? null,
                    conversationId: conversationId ?? null,
                    sessionKey,
                    locale,
                  }
                : type === "filePanel"
                  ? {
                      type,
                      id,
                      fileName,
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
            data.operation !== "composer" &&
            data.operation !== "file") ||
          typeof data.json !== "string"
        )
          return
        const requestId = data.id
        const maxJsonLength =
          data.operation === "file"
            ? MAX_FILE_INPUT_JSON_LENGTH
            : MAX_INPUT_BYTES
        if (
          activeCalls >= MAX_PENDING_CALLS ||
          data.json.length > maxJsonLength
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
          } else if (data.operation === "file") {
            const opType =
              input &&
              typeof input === "object" &&
              !Array.isArray(input) &&
              "type" in input
                ? (input as { type: unknown }).type
                : undefined
            if (opType === "writeText") {
              const writeTextHandler = allowFileWriteText
                ? fileWriteTextRef.current
                : undefined
              if (
                !writeTextHandler ||
                closed ||
                !isCurrentReadyHostTransport(host)
              ) {
                throw new Error("File write is unavailable")
              }
              const text = validatePluginFileWriteRequest(input)
              const result = await writeTextHandler(text)
              if (closed || !isCurrentReadyHostTransport(host)) {
                throw new Error("File editor is no longer active")
              }
              value = result
            } else {
              const readTextHandler = allowFileReadText
                ? fileReadTextRef.current
                : undefined
              if (
                !readTextHandler ||
                closed ||
                !isCurrentReadyHostTransport(host)
              ) {
                throw new Error("File snapshot is unavailable")
              }
              validatePluginFileReadRequest(input)
              const snapshot = await readTextHandler()
              if (closed || !isCurrentReadyHostTransport(host)) {
                throw new Error("File snapshot is no longer active")
              }
              value = validatePluginFileReadTextResult(snapshot?.text)
            }
          } else {
            value = await handleRequest(host, pluginId, data.operation, input)
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
    fileName,
    fileScopeKey,
    allowComposerInsert,
    allowFileReadText,
    allowFileWriteText,
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
