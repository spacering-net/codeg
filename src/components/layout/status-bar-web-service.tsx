"use client"

/**
 * Web service (remote access), bottom-right of the workspace: whether the
 * desktop is serving Codeg over HTTP right now, on which address, and a way
 * to start or stop it without opening Settings.
 *
 * Desktop only — a browser is already talking to a web service, and a
 * remote-desktop window's calls go to the remote server — and always present
 * there, because the point is a passive signal: the glyph turns green while
 * the service is listening, and its tooltip says how far it reaches (every
 * interface, i.e. the local network, or this computer only).
 *
 * Starting a service that will listen on every interface asks first: it puts
 * the terminals and agents within reach of the local network, behind the
 * access token. A loopback-only start, and every stop, just happen.
 *
 * Starts and stops from any window — this one, the Settings page, auto-start
 * at launch — are broadcast, so the glyph never disagrees with Settings.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Check, Copy, RadioTower, Settings2 } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import {
  getWebServiceConfig,
  openSettingsWindow,
  startWebServer,
  stopWebServer,
  type WebServiceConfig,
  type WebServiceHost,
} from "@/lib/api"
import { asWebServiceHost, isLoopbackHost } from "@/lib/web-service/hosts"
import { useLocalWebServerStatus } from "@/lib/web-service/use-local-web-server-status"
import { useWebServerStartErrorMessage } from "@/lib/web-service/start-error"
import { copyTextToClipboard, cn } from "@/lib/utils"

const DEFAULT_PORT = 3080
const RUNNING_TONE = "text-emerald-600 dark:text-emerald-400"

/** Where a start from here binds — decided once, from a fresh read of the
 *  saved settings, and then passed to the start verbatim, so what the
 *  confirmation names is exactly what gets bound. */
interface StartTarget {
  host: WebServiceHost
  port: number
}

function AddressRow({ address }: { address: string }) {
  const t = useTranslations("Folder.statusBar.webService")
  const [copied, markCopied] = useCopiedFlag()
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <code className="min-w-0 flex-1 truncate text-2xs select-all">
        {address}
      </code>
      <button
        type="button"
        onClick={async () => {
          if (await copyTextToClipboard(address)) markCopied()
        }}
        aria-label={t("copyAddress")}
        title={t("copyAddress")}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3 text-green-500" />
        ) : (
          <Copy className="size-3" />
        )}
      </button>
    </div>
  )
}

export function StatusBarWebService() {
  const t = useTranslations("Folder.statusBar.webService")
  const ts = useTranslations("WebServiceSettings")
  const startErrorMessage = useWebServerStartErrorMessage()
  const { status, enabled, refresh, mark, applySince } =
    useLocalWebServerStatus()
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<WebServiceConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The network-wide start awaiting confirmation. */
  const [pending, setPending] = useState<StartTarget | null>(null)

  if (!enabled || status === undefined) return null

  const running = status !== null
  const loopback = running && isLoopbackHost(status.bindHost)
  // What a start would bind, for the stopped hint: the saved choice, or the
  // default when none was ever made. Re-read at the moment of starting.
  const nextHost = asWebServiceHost(config?.host)
  const nextPort = config?.port ?? DEFAULT_PORT
  const nextLoopback = config !== null && isLoopbackHost(nextHost)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    setError(null)
    void refresh()
    getWebServiceConfig()
      .then(setConfig)
      .catch(() => setConfig(null))
  }

  const start = async (target: StartTarget) => {
    setBusy(true)
    setError(null)
    const since = mark()
    try {
      // Host and port explicit (the ones just confirmed, or loopback); the
      // token is left to the backend, which uses the saved one.
      applySince(
        await startWebServer({ host: target.host, port: target.port }),
        since
      )
    } catch (e) {
      setError(startErrorMessage(e, target.port))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    setError(null)
    const since = mark()
    try {
      await stopWebServer()
      applySince(null, since)
    } catch {
      setError(ts("stopFailed"))
    } finally {
      setBusy(false)
    }
  }

  const handleStartClick = async () => {
    setBusy(true)
    setError(null)
    // Fresh, not what the popover read on opening: Settings may have
    // switched the host since, and a network-wide start must never slip
    // through without its confirmation.
    let saved: WebServiceConfig
    try {
      saved = await getWebServiceConfig()
    } catch (e) {
      setError(startErrorMessage(e, nextPort))
      setBusy(false)
      return
    }
    setConfig(saved)
    setBusy(false)
    const target: StartTarget = {
      host: asWebServiceHost(saved.host),
      port: saved.port ?? DEFAULT_PORT,
    }
    if (isLoopbackHost(target.host)) void start(target)
    else setPending(target)
  }

  const listening = running ? `${status.bindHost}:${status.port}` : ""
  const tooltip = running
    ? t(loopback ? "tooltipLocal" : "tooltipNetwork", { address: listening })
    : t("tooltipStopped")

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("title")}
            title={tooltip}
            data-state-running={running ? "true" : "false"}
            className={cn(
              "flex items-center transition-colors",
              running ? RUNNING_TONE : "hover:text-foreground"
            )}
          >
            <RadioTower className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-72 gap-2 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">{t("title")}</span>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium",
                running
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  running ? "bg-emerald-500" : "bg-muted-foreground/50"
                )}
              />
              {running ? ts("running") : ts("stopped")}
            </span>
          </div>

          <p className="text-2xs text-muted-foreground">
            {running
              ? t(loopback ? "hintLocal" : "hintNetwork", {
                  address: listening,
                })
              : t(nextLoopback ? "hintStoppedLocal" : "hintStoppedNetwork", {
                  address: `${nextHost}:${nextPort}`,
                })}
          </p>

          {running && status.addresses.length > 0 && (
            <div className="divide-y overflow-hidden rounded-lg border">
              {status.addresses.map((address) => (
                <AddressRow key={address} address={address} />
              ))}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-2xs break-words text-red-400"
            >
              {error}
            </div>
          )}

          <Button
            size="sm"
            variant={running ? "outline" : "default"}
            className="w-full"
            disabled={busy}
            onClick={() => void (running ? stop() : handleStartClick())}
          >
            {busy ? ts("processing") : running ? t("stop") : t("start")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => {
              openSettingsWindow("web-service").catch((err) => {
                console.error(
                  "[StatusBarWebService] failed to open settings:",
                  err
                )
              })
            }}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("openSettings")}
          </Button>
        </PopoverContent>
      </Popover>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDescription", {
                address: pending ? `${pending.host}:${pending.port}` : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pending
                setPending(null)
                if (target) void start(target)
              }}
            >
              {t("confirmStart")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
