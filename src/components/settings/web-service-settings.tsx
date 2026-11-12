"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  QrCode,
  RefreshCw,
} from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { useTranslations } from "next-intl"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  startWebServer,
  stopWebServer,
  getWebServerStatus,
  getWebServiceConfig,
  updateWebServiceConfig,
  probeWebServicePort,
  DEFAULT_WEB_SERVICE_HOST,
  WEB_SERVICE_STATUS_CHANGED_EVENT,
  type WebServerInfo,
  type WebServiceHost,
  type WebServicePortProbe,
} from "@/lib/api"

const DEFAULT_PORT = 3080
import { openUrl, subscribe } from "@/lib/platform"
import { copyTextToClipboard } from "@/lib/utils"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import {
  useWebServerStartErrorMessage,
  webServerErrorCode,
} from "@/lib/web-service/start-error"
import { asWebServiceHost } from "@/lib/web-service/hosts"

// Remembers which reachable address the user last chose to display/open.
// Keyed by host (IP) only, so the choice survives a port change.
const DISPLAY_HOST_STORAGE_KEY = "webService.displayHost"

// Extract the host (IP) portion of an `http://ip:port` address.
function addressHost(address: string): string {
  try {
    return new URL(address).hostname
  } catch {
    return address
  }
}

// Read the remembered display host, tolerating environments where storage
// access throws (blocked cookies / private mode) — same posture as the write.
function readSavedDisplayHost(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(DISPLAY_HOST_STORAGE_KEY)
  } catch {
    return null
  }
}

const ADDRESS_ICON_BUTTON_CLASS =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-input text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"

// The running address row: a selector (or read-only field when there is only
// one reachable address) followed by circular copy / QR / open actions.
function AddressBar({
  address,
  addresses,
  hasMultiple,
  onSelect,
}: {
  address: string
  addresses: string[]
  hasMultiple: boolean
  onSelect: (address: string) => void
}) {
  const t = useTranslations("WebServiceSettings")
  const [copied, markCopied] = useCopiedFlag()
  const [qrOpen, setQrOpen] = useState(false)

  async function handleCopy() {
    const ok = await copyTextToClipboard(address)
    if (!ok) return
    markCopied()
  }

  return (
    <>
      <div className="flex items-center gap-2">
        {hasMultiple ? (
          <Select value={address} onValueChange={onSelect}>
            <SelectTrigger className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {addresses.map((addr) => (
                <SelectItem key={addr} value={addr}>
                  {addr}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex h-9 min-w-0 flex-1 items-center rounded-4xl border border-input bg-input/30 px-3">
            <code className="truncate text-sm select-all">{address}</code>
          </div>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className={ADDRESS_ICON_BUTTON_CLASS}
          aria-label={t("copy")}
          title={t("copy")}
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setQrOpen(true)}
          className={ADDRESS_ICON_BUTTON_CLASS}
          aria-label={t("qrcode")}
          title={t("qrcode")}
        >
          <QrCode className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => openUrl(address)}
          className={ADDRESS_ICON_BUTTON_CLASS}
          aria-label={t("open")}
          title={t("open")}
        >
          <ExternalLink className="h-4 w-4" />
        </button>
      </div>
      <AddressQrcodeDialog
        open={qrOpen}
        address={address}
        onOpenChange={setQrOpen}
      />
    </>
  )
}

function AddressQrcodeDialog({
  open,
  address,
  onOpenChange,
}: {
  open: boolean
  address: string
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("WebServiceSettings")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>{t("qrcodeTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 py-2">
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG value={address} size={208} marginSize={0} />
          </div>
          <code className="text-center text-xs break-all text-muted-foreground select-all">
            {address}
          </code>
          <p className="text-center text-xs text-muted-foreground">
            {t("qrcodeHint")}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function generateRandomToken() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "")
  }
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("")
}

function TokenEditor({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  disabled: boolean
  placeholder: string
}) {
  const t = useTranslations("WebServiceSettings")
  const [copied, markCopied] = useCopiedFlag()
  const [revealed, setRevealed] = useState(false)

  async function handleCopy() {
    if (!value) return
    const ok = await copyTextToClipboard(value)
    if (!ok) return
    markCopied()
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="group relative flex items-center rounded-md border bg-muted/40 px-3 py-2">
        <input
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <div className="ml-2 flex shrink-0 items-center gap-1">
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(generateRandomToken())}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title={t("regenerate")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={revealed ? t("hide") : t("show")}
          >
            {revealed ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!value}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title={t("copy")}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export function WebServiceSettings() {
  const t = useTranslations("WebServiceSettings")
  const [status, setStatus] = useState<WebServerInfo | null>(null)
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [host, setHost] = useState<WebServiceHost>(DEFAULT_WEB_SERVICE_HOST)
  const [token, setToken] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [portProbe, setPortProbe] = useState<WebServicePortProbe | null>(null)
  const [autoStart, setAutoStart] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null)
  const startErrorMessage = useWebServerStartErrorMessage()
  /** Bumped by every status read issued: only the newest read lands. Reads
   *  overlap — mount, broadcasts from other windows, our own start/stop's
   *  echo — and an older "running" must not overwrite a newer "stopped".
   *  A start/stop of this page re-reads afterwards for the same reason. */
  const fetchSeqRef = useRef(0)
  /** Bumped by every edit of the form: a read that was asked before the
   *  person changed something must not put the saved values back over it
   *  (the debounced save would then persist the old ones). */
  const editSeqRef = useRef(0)
  const markEdited = () => {
    editSeqRef.current += 1
  }

  const probePort = useCallback(async (portNum: number) => {
    try {
      const result = await probeWebServicePort(portNum)
      setPortProbe(result)
    } catch {
      setPortProbe(null)
    }
  }, [])

  const fetchStatus = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    const editsAtStart = editSeqRef.current
    try {
      const fallbackConfig = {
        token: null,
        port: null,
        autoStart: false,
        host: null,
      }
      const [info, configResult] = await Promise.all([
        getWebServerStatus(),
        getWebServiceConfig()
          .then((config) => ({ ok: true as const, config }))
          .catch(() => ({ ok: false as const, config: fallbackConfig })),
      ])
      if (seq !== fetchSeqRef.current) return
      const savedConfig = configResult.config
      const edited = editSeqRef.current !== editsAtStart
      setStatus(info)
      if (!edited) setAutoStart(savedConfig.autoStart ?? false)
      if (info) {
        setPort(String(info.port))
        setHost(asWebServiceHost(info.bindHost))
        setToken(info.token)
        setPortProbe(null)
      } else if (!edited) {
        const resolvedPort = savedConfig.port ?? DEFAULT_PORT
        setPort(String(resolvedPort))
        setHost(asWebServiceHost(savedConfig.host))
        if (savedConfig.token) {
          setToken(savedConfig.token)
        }
        // Detect leftover/foreign listener on the configured port so the
        // user understands why a fresh start may fail with port-in-use.
        probePort(resolvedPort)
      }
      setConfigLoaded(configResult.ok)
    } catch {
      // Server status unavailable
    }
  }, [probePort])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // Follow starts and stops made elsewhere — the status-bar toggle in a
  // workspace window, or auto-start — so this page never shows a stale
  // Running / Stopped. Our own start/stop is announced too; re-reading then
  // just confirms what the call already returned.
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    subscribe<{ running: boolean }>(WEB_SERVICE_STATUS_CHANGED_EVENT, () => {
      void fetchStatus()
    })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [fetchStatus])

  // Pick which reachable address to display/open. Keep a still-valid prior
  // choice; otherwise honor the remembered host, falling back to the first
  // entry (loopback). Selection is display-only — a wildcard bind reaches
  // every listed address regardless of choice, and a loopback bind lists
  // only its own.
  useEffect(() => {
    const addresses = status?.addresses ?? []
    if (addresses.length === 0) {
      setSelectedAddress(null)
      return
    }
    setSelectedAddress((prev) => {
      if (prev && addresses.includes(prev)) return prev
      const savedHost = readSavedDisplayHost()
      const matched = savedHost
        ? addresses.find((addr) => addressHost(addr) === savedHost)
        : undefined
      return matched ?? addresses[0]
    })
  }, [status])

  function handleSelectAddress(address: string) {
    setSelectedAddress(address)
    try {
      window.localStorage.setItem(
        DISPLAY_HOST_STORAGE_KEY,
        addressHost(address)
      )
    } catch {
      // Ignore storage failures (private mode / quota); the selection still
      // applies for the current session.
    }
  }

  const persistWebServiceConfig = useCallback(
    async (nextAutoStart = autoStart) => {
      const portNum = parseInt(port, 10)
      if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
        return
      }

      try {
        await updateWebServiceConfig({
          port: portNum,
          token: token.trim() || null,
          autoStart: nextAutoStart,
          host,
        })
      } catch {
        setError(t("saveConfigFailed"))
      }
    },
    [autoStart, host, port, t, token]
  )

  useEffect(() => {
    if (!configLoaded) return
    const portNum = parseInt(port, 10)
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      return
    }

    const timeout = window.setTimeout(() => {
      void persistWebServiceConfig()
    }, 500)

    return () => window.clearTimeout(timeout)
  }, [configLoaded, persistWebServiceConfig, port])

  async function handleStart() {
    setError("")
    setLoading(true)
    try {
      const portNum = parseInt(port, 10) || DEFAULT_PORT
      const info = await startWebServer({
        port: portNum,
        host,
        token: token.trim() || null,
      })
      setStatus(info)
      setToken(info.token)
      setPort(String(info.port))
      setHost(asWebServiceHost(info.bindHost))
      setPortProbe(null)
      // Supersede any read asked before the start (it would say Stopped).
      void fetchStatus()
    } catch (e: unknown) {
      const rawMsg = webServerErrorCode(e)
      setError(startErrorMessage(e, parseInt(port, 10) || DEFAULT_PORT))
      // Refresh probe after a port_in_use failure so the banner reflects
      // current reality (e.g. confirms port really is held by another
      // process, not just a stale flag).
      if (rawMsg === "web_server.port_in_use") {
        probePort(parseInt(port, 10) || DEFAULT_PORT)
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleStop() {
    setLoading(true)
    try {
      await stopWebServer()
      setStatus(null)
      // Supersede any read asked before the stop (it would say Running).
      void fetchStatus()
      // After stop, re-probe so the user can see whether the port was
      // released cleanly or is being held by an orphan child process.
      probePort(parseInt(port, 10) || DEFAULT_PORT)
    } catch {
      setError(t("stopFailed"))
    } finally {
      setLoading(false)
    }
  }

  const isRunning = status !== null
  const currentAddress = selectedAddress ?? status?.addresses[0] ?? null
  const hasMultipleAddresses = (status?.addresses.length ?? 0) > 1
  const showStaleBanner =
    !isRunning &&
    portProbe !== null &&
    (portProbe.state === "occupied" || portProbe.state === "unknown")

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-3 md:p-4">
        <div>
          <h3 className="text-lg font-medium">{t("sectionTitle")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </div>

        <div className="space-y-4">
          {showStaleBanner && (
            <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1 text-sm">
                <div className="font-medium text-amber-700 dark:text-amber-300">
                  {portProbe?.state === "occupied"
                    ? t("stalePortOccupiedTitle", { port: portProbe.port })
                    : t("stalePortUnknownTitle", {
                        port: portProbe?.port ?? 0,
                      })}
                </div>
                <div className="text-muted-foreground">
                  {t("stalePortHint")}
                </div>
              </div>
            </div>
          )}

          {/* Port config */}
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium">{t("port")}</label>
            <input
              type="number"
              value={port}
              onChange={(e) => {
                markEdited()
                setPort(e.target.value)
                setPortProbe(null)
              }}
              disabled={isRunning}
              min={1024}
              max={65535}
              className="flex h-9 w-32 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </div>

          {/* Bind host: every interface (the local network can reach it) or
              this computer only (e.g. behind a reverse proxy or Tailscale
              Serve). Fixed while running, like the port. */}
          <div className="flex items-start gap-4">
            <label className="w-20 pt-2 text-sm font-medium">
              {t("bindHost")}
            </label>
            <div className="min-w-0 flex-1 space-y-1.5">
              <Select
                value={host}
                onValueChange={(next) => {
                  markEdited()
                  setHost(asWebServiceHost(next))
                }}
                disabled={isRunning}
              >
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="0.0.0.0">{t("bindHostAll")}</SelectItem>
                  <SelectItem value="127.0.0.1">
                    {t("bindHostLocal")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {host === "127.0.0.1"
                  ? t("bindHostLocalHint")
                  : t("bindHostAllHint")}
              </p>
            </div>
          </div>

          {/* Token config */}
          <TokenEditor
            label={t("tokenLabel")}
            value={token}
            onChange={(next) => {
              markEdited()
              setToken(next)
            }}
            disabled={isRunning}
            placeholder={t("tokenPlaceholder")}
          />
          <p className="text-xs text-muted-foreground">{t("tokenHint")}</p>

          {/* Auto-start config */}
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium">{t("autoStart")}</label>
            <div className="flex min-w-0 items-center gap-3">
              <Switch
                checked={autoStart}
                onCheckedChange={(checked) => {
                  markEdited()
                  setAutoStart(checked)
                  void persistWebServiceConfig(checked)
                }}
              />
              <span className="text-sm text-muted-foreground">
                {t("autoStartHint")}
              </span>
            </div>
          </div>

          {/* Start/Stop button */}
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium">{t("status")}</label>
            <div className="flex items-center gap-3">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  isRunning ? "bg-green-500" : "bg-muted-foreground/30"
                }`}
              />
              <span className="text-sm">
                {isRunning ? t("running") : t("stopped")}
              </span>
              <button
                onClick={isRunning ? handleStop : handleStart}
                disabled={loading}
                className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-xs font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {loading ? t("processing") : isRunning ? t("stop") : t("start")}
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {/* Address (only when running). On a wildcard bind every local IP
              reaches the service; the selector only changes which address
              is shown and opened by the arrow — it never changes what the
              service actually listens on. A loopback bind lists one. */}
          {isRunning && currentAddress && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                {t("addressLabel")}
              </div>
              <AddressBar
                address={currentAddress}
                addresses={status.addresses}
                hasMultiple={hasMultipleAddresses}
                onSelect={handleSelectAddress}
              />
              {hasMultipleAddresses && (
                <p className="text-xs text-muted-foreground">
                  {t("addressSwitchHint")}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}
