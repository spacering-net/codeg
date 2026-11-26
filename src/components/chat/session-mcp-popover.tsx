"use client"

import { useCallback, useState, useSyncExternalStore } from "react"
import {
  Activity,
  Loader2,
  PauseCircle,
  Plug,
  RefreshCw,
  Settings2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  useOptionalAcpActions,
  useOptionalConnectionStore,
} from "@/contexts/acp-connections-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { useSessionMcp } from "@/hooks/use-session-mcp"
import { getAgentLabel } from "@/lib/custom-agents"
import type { UnifiedMcpStatus } from "@/lib/mcp/session-state"
import type { AgentType } from "@/lib/types"
import { cn } from "@/lib/utils"

export interface SessionMcpPopoverProps {
  /** Connection context key (`tab.id`), or `null` when unavailable. */
  tabId: string | null
  /** Active conversation's agent type (fallback when connection is idle). */
  agentType?: AgentType | null
}

const DOT_CLASS: Record<UnifiedMcpStatus, string> = {
  session_confirmed: "bg-emerald-500",
  probe_healthy: "bg-emerald-500/80",
  auth_required: "bg-amber-500",
  connection_failed: "bg-red-500",
  saved_pending_reconnect: "bg-amber-500",
  skipped_transport: "bg-amber-500",
  configured: "bg-muted-foreground/50",
  paused: "bg-muted-foreground/35",
}

const BADGE_CLASS: Record<UnifiedMcpStatus, string> = {
  session_confirmed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  probe_healthy: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  auth_required: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  connection_failed: "bg-red-500/10 text-red-600 dark:text-red-400",
  saved_pending_reconnect: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  skipped_transport: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  configured: "bg-muted text-muted-foreground",
  paused: "bg-muted/60 text-muted-foreground",
}

function formatTransport(transport: string | null): string | null {
  if (!transport) return null
  if (transport === "http") return "HTTP"
  if (transport === "sse") return "SSE"
  return transport
}

/**
 * Compact composer MCP status trigger & popover (#1296 Phase 2).
 *
 * Mirrors `StatusBarMcp` and `ComposerConnectionStatus` in visual restraint:
 * - Default monochrome icon with no permanent badge clutter.
 * - Gentle corner dot ONLY when a server has `connection_failed` (red),
 *   `auth_required` (amber), or `saved_pending_reconnect` / `needsReconnect`
 *   (amber).
 * - Hides quietly when the agent has no MCP servers configured and no error /
 *   reconnect attention state.
 * - Performs zero network fetches while closed; opening the popover loads the
 *   shared inventory and subscribes to `mcp://changed`.
 */
export function SessionMcpPopover({
  tabId,
  agentType,
}: SessionMcpPopoverProps) {
  const t = useTranslations("Folder.sessionMcp")
  const store = useOptionalConnectionStore()
  const actions = useOptionalAcpActions()
  const { available: harnessAvailable, openHarness } = useOpenHarness()
  const [open, setOpen] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [testingAll, setTestingAll] = useState(false)
  const [pausingKey, setPausingKey] = useState<string | null>(null)

  const subscribeConn = useCallback(
    (cb: () => void) => {
      if (!store || !tabId) return () => {}
      return store.subscribeKey(tabId, cb)
    },
    [store, tabId]
  )
  const getConn = useCallback(
    () => (store && tabId ? store.getConnection(tabId) : undefined),
    [store, tabId]
  )
  const conn = useSyncExternalStore(subscribeConn, getConn, getConn)
  const getConnectError = useCallback(
    () => (store && tabId ? store.getConnectError(tabId) : undefined),
    [store, tabId]
  )
  const connectError = useSyncExternalStore(
    subscribeConn,
    getConnectError,
    getConnectError
  )

  const effectiveAgentType = agentType ?? conn?.agentType ?? null
  const errorText =
    conn?.error ??
    (connectError
      ? connectError.detail
        ? `${connectError.title}: ${connectError.detail}`
        : connectError.title
      : null)

  const {
    state,
    inventoryAgent,
    loading,
    probeServer,
    probeAllActive,
    pauseServer,
  } = useSessionMcp({
    agentType: effectiveAgentType,
    active: open,
    connectionStatus: conn?.status ?? null,
    sessionMcpState: conn?.mcpState ?? null,
    sessionFailures: conn?.sessionFailures,
    errorText,
    configStale: conn?.configStale ?? false,
    configStaleKind: conn?.configStaleKind ?? null,
  })

  const hasFailed = state.rows.some((r) => r.status === "connection_failed")
  const hasWarn =
    state.needsReconnect ||
    state.rows.some(
      (r) =>
        r.status === "auth_required" ||
        r.status === "saved_pending_reconnect" ||
        r.status === "skipped_transport"
    )
  const hasAttention = hasFailed || hasWarn
  const hasServers = state.rows.length > 0

  // Restrained visibility: if the agent has no MCP servers and no error/drift
  // attention state, do not clutter the composer status row.
  if (!state.mcpAgentId || (!hasServers && !hasAttention)) {
    return null
  }

  const isOwner = Boolean(
    conn && !conn.isViewer && !conn.isDelegationChild && actions && tabId
  )
  const turnInFlight = conn?.status === "prompting"
  const reconnectBusy = reconnecting || conn?.status === "connecting"

  const agentLabel =
    inventoryAgent?.display_name?.trim() ||
    (effectiveAgentType ? getAgentLabel(effectiveAgentType) : t("title"))

  const summaryCount = state.summary.activeCount
  const triggerTooltip = t("triggerTooltip", {
    summary:
      state.rows.length > 0
        ? `${summaryCount}/${state.rows.length}`
        : t("status.saved_pending_reconnect"),
  })

  const testableCount = state.rows.filter(
    (row) => row.canProbe && !row.paused && !row.removedPendingReconnect
  ).length

  const handleReconnect = async () => {
    if (!actions || !tabId || turnInFlight || reconnectBusy) return
    setReconnecting(true)
    try {
      const ok = await actions.reapplyConfig(tabId)
      if (ok) toast.success(t("reconnected"))
    } catch {
      // connect() publishes its own error notification.
    } finally {
      setReconnecting(false)
    }
  }

  const handleTestAll = async () => {
    if (testingAll) return
    setTestingAll(true)
    try {
      await probeAllActive()
    } finally {
      setTestingAll(false)
    }
  }

  const handlePauseAndReconnect = async (key: string) => {
    if (pausingKey) return
    setPausingKey(key)
    try {
      const outcome = await pauseServer(key)
      if (outcome === "failed") {
        toast.error(t("pauseFailed", { server: key }))
        return
      }
      if (actions && tabId) {
        await actions.reapplyConfig(tabId)
      }
      toast.success(t("pausedAndReconnecting", { server: key }))
    } catch {
      toast.error(t("pauseFailed", { server: key }))
    } finally {
      setPausingKey(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="session-mcp-trigger"
          aria-label={t("triggerAria", { count: summaryCount })}
          title={triggerTooltip}
          className="relative inline-flex shrink-0 items-center rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Plug className="size-3.5" />
          {hasAttention && (
            <span
              data-testid="session-mcp-attention-dot"
              aria-hidden="true"
              className={cn(
                "absolute -top-0.5 -end-0.5 size-1.5 rounded-full ring-1 ring-background",
                hasFailed ? "bg-red-500" : "bg-amber-500"
              )}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 gap-2.5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {effectiveAgentType && (
              <span aria-hidden="true" className="inline-flex shrink-0">
                <AgentIcon
                  agentType={effectiveAgentType}
                  className="size-3.5"
                />
              </span>
            )}
            <span className="truncate text-xs font-medium">{agentLabel}</span>
            <span className="shrink-0 text-2xs text-muted-foreground">
              {t("title")}
            </span>
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {state.summary.activeCount}/{state.rows.length}
          </span>
        </div>

        {state.needsReconnect && isOwner && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-2xs text-amber-700 dark:text-amber-300">
            <span className="min-w-0 flex-1 leading-snug">
              {t("reconnectNotice")}
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={turnInFlight || reconnectBusy}
              title={
                turnInFlight ? t("reconnectDisabledDuringTurn") : undefined
              }
              onClick={() => void handleReconnect()}
              className="h-6 shrink-0 gap-1 border-amber-500/40 bg-transparent px-2 text-2xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-200"
            >
              <RefreshCw
                aria-hidden="true"
                className={cn("size-3", reconnectBusy && "animate-spin")}
              />
              {reconnectBusy ? t("reconnecting") : t("reconnect")}
            </Button>
          </div>
        )}

        {loading && state.rows.length === 0 ? (
          <p className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            {t("loading")}
          </p>
        ) : state.rows.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">{t("noServers")}</p>
        ) : (
          <ul className="max-h-60 divide-y overflow-y-auto rounded-lg border">
            {state.rows.map((row) => {
              const probing = row.probe?.phase === "loading"
              const probeResult =
                row.probe?.phase === "ready" ? row.probe.result : null
              const transportLabel = formatTransport(row.transport)
              const badgeText =
                row.status === "probe_healthy" && row.toolsCount !== null
                  ? `${t("status.probe_healthy")} (${t("toolsCount", { count: row.toolsCount })})`
                  : t(`status.${row.status}`)
              return (
                <li key={row.key} className="space-y-1 px-2.5 py-2">
                  <div className="flex min-w-0 items-center justify-between gap-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <bdi
                        dir="ltr"
                        className={cn(
                          "min-w-0 truncate font-mono text-xs font-medium",
                          row.paused && "text-muted-foreground"
                        )}
                      >
                        {row.key}
                      </bdi>
                      {transportLabel && (
                        <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                          {transportLabel}
                        </span>
                      )}
                    </div>
                    {row.canProbe && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={probing}
                        aria-label={`${t("test")} ${row.key}`}
                        onClick={() => void probeServer(row.key)}
                        className="h-5 shrink-0 px-1.5 text-3xs text-muted-foreground hover:text-foreground"
                      >
                        {probing ? (
                          <Loader2
                            aria-hidden="true"
                            className="size-3 animate-spin"
                          />
                        ) : (
                          <Activity aria-hidden="true" className="size-3" />
                        )}
                        {probing ? t("testing") : t("test")}
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium",
                        BADGE_CLASS[row.status]
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 rounded-full",
                          DOT_CLASS[row.status]
                        )}
                      />
                      {badgeText}
                    </span>
                    {probeResult && probeResult.latency_ms > 0 && (
                      <span className="font-mono text-3xs text-muted-foreground tabular-nums">
                        {t("latency", { ms: probeResult.latency_ms })}
                      </span>
                    )}
                    {row.status === "connection_failed" &&
                      row.canPause &&
                      isOwner && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={
                            pausingKey === row.key ||
                            turnInFlight ||
                            reconnectBusy
                          }
                          onClick={() => void handlePauseAndReconnect(row.key)}
                          className="h-5 gap-1 border-amber-500/40 px-1.5 text-3xs text-amber-800 hover:bg-amber-500/15 dark:text-amber-200"
                        >
                          {pausingKey === row.key ? (
                            <Loader2
                              aria-hidden="true"
                              className="size-2.5 animate-spin"
                            />
                          ) : (
                            <PauseCircle
                              aria-hidden="true"
                              className="size-2.5"
                            />
                          )}
                          {pausingKey === row.key
                            ? t("pausing")
                            : t("pauseAndReconnect")}
                        </Button>
                      )}
                  </div>
                  {row.status === "auth_required" && (
                    <p className="text-3xs text-muted-foreground">
                      {t("authRequiredHint")}
                    </p>
                  )}
                  {row.detail && (
                    <p className="line-clamp-2 break-words font-mono text-3xs text-muted-foreground">
                      {row.detail}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex items-center gap-1.5">
          {testableCount > 0 && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={testingAll}
              onClick={() => void handleTestAll()}
              className="flex-1"
            >
              {testingAll ? (
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
              ) : (
                <Activity aria-hidden="true" className="size-3" />
              )}
              {t("testAll")}
            </Button>
          )}
          {harnessAvailable && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                setOpen(false)
                openHarness({
                  section: "mcp",
                  agentId: state.mcpAgentId ?? undefined,
                })
              }}
              className="flex-1"
            >
              <Settings2 aria-hidden="true" className="size-3" />
              {t("manageMcp")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
