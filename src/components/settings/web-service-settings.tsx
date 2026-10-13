"use client"

import { useCallback, useEffect, useState } from "react"
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
  type WebServerInfo,
  type WebServicePortProbe,
} from "@/lib/api"

const DEFAULT_PORT = 3080
import { openUrl } from "@/lib/platform"
import { copyTextToClipboard } from "@/lib/utils"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import { joinPlan, sidecarCommand } from "@/lib/embedded-tailnet"

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
  const [token, setToken] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [portProbe, setPortProbe] = useState<WebServicePortProbe | null>(null)
  const [autoStart, setAutoStart] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null)
  const [tailnetAuthKey, setTailnetAuthKey] = useState("")
  const [tailnetAuthUrl, setTailnetAuthUrl] = useState("")

  const probePort = useCallback(async (portNum: number) => {
    try {
      const result = await probeWebServicePort(portNum)
      setPortProbe(result)
    } catch {
      setPortProbe(null)
    }
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const fallbackConfig = {
        token: null,
        port: null,
        autoStart: false,
      }
      const [info, configResult] = await Promise.all([
        getWebServerStatus(),
        getWebServiceConfig()
          .then((config) => ({ ok: true as const, config }))
          .catch(() => ({ ok: false as const, config: fallbackConfig })),
      ])
      const savedConfig = configResult.config
      setStatus(info)
      setAutoStart(savedConfig.autoStart ?? false)
      if (info) {
        setPort(String(info.port))
        setToken(info.token)
        setPortProbe(null)
      } else {
        const resolvedPort = savedConfig.port ?? DEFAULT_PORT
        setPort(String(resolvedPort))
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

  // Pick which reachable address to display/open. Keep a still-valid prior
  // choice; otherwise honor the remembered host, falling back to the first
  // entry (loopback). Selection is display-only — the service always binds
  // 0.0.0.0, so every listed address stays reachable regardless of choice.
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
        })
      } catch {
        setError(t("saveConfigFailed"))
      }
    },
    [autoStart, port, t, token]
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

  const startErrorKeys: Record<string, string> = {
    "web_server.already_running": "errors.alreadyRunning",
    "web_server.invalid_address": "errors.invalidAddress",
    "web_server.port_in_use": "errors.portInUse",
    "web_server.permission_denied": "errors.permissionDenied",
    "web_server.address_unavailable": "errors.addressUnavailable",
    "web_server.bind_failed": "errors.bindFailed",
  }

  async function handleStart() {
    setError("")
    setLoading(true)
    try {
      const portNum = parseInt(port, 10) || DEFAULT_PORT
      const info = await startWebServer({
        port: portNum,
        token: token.trim() || null,
      })
      setStatus(info)
      setToken(info.token)
      setPort(String(info.port))
      setPortProbe(null)
    } catch (e: unknown) {
      const rawMsg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : ""
      const localKey = startErrorKeys[rawMsg]
      if (localKey) {
        setError(
          t(localKey as Parameters<typeof t>[0], {
            port: parseInt(port, 10) || DEFAULT_PORT,
          })
        )
      } else {
        setError(rawMsg || t("startFailed"))
      }
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
                setPort(e.target.value)
                setPortProbe(null)
              }}
              disabled={isRunning}
              min={1024}
              max={65535}
              className="flex h-9 w-32 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </div>

          {/* Token config */}
          <TokenEditor
            label={t("tokenLabel")}
            value={token}
            onChange={setToken}
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

          {/* Address (only when running). The listener is bound to
              0.0.0.0, so every local IP reaches the service; the selector
              only changes which address is shown and opened by the arrow —
              it never changes what the service actually listens on. */}
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

          <div className="space-y-2 rounded-md border p-3">
            <div className="text-sm font-medium">{t("phoneReachTitle")}</div>
            <p className="text-xs text-muted-foreground">
              {t("phoneReachHint")}
            </p>
            <input
              value={tailnetAuthKey}
              onChange={(event) => setTailnetAuthKey(event.target.value)}
              placeholder={t("phoneReachAuthKey")}
              spellCheck={false}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            />
            <input
              value={tailnetAuthUrl}
              onChange={(event) => setTailnetAuthUrl(event.target.value)}
              placeholder={t("phoneReachAuthUrl")}
              spellCheck={false}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            />
            {(() => {
              try {
                const plan = joinPlan({
                  target: currentAddress ?? `http://127.0.0.1:${port}`,
                  authKey: tailnetAuthKey || undefined,
                  authUrl: tailnetAuthUrl || undefined,
                })
                const command = sidecarCommand(plan)
                return (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">
                      {t("phoneReachCommand")}
                    </div>
                    <code className="block break-all rounded bg-muted px-2 py-1 text-[11px]">
                      {command}
                    </code>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline"
                      onClick={() => {
                        void copyTextToClipboard(command)
                      }}
                    >
                      {t("phoneReachCopy")}
                    </button>
                  </div>
                )
              } catch {
                return null
              }
            })()}
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}
