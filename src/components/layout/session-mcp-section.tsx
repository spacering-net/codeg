"use client"

import { useCallback, useState, useSyncExternalStore } from "react"
import {
  Activity,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  PauseCircle,
  Plug,
  RefreshCw,
  Settings2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  useOptionalAcpActions,
  useOptionalConnectionStore,
} from "@/contexts/acp-connections-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { useSessionMcp } from "@/hooks/use-session-mcp"
import { openSettingsWindow } from "@/lib/api"
import type {
  UnifiedMcpServerRow,
  UnifiedMcpStatus,
} from "@/lib/mcp/session-state"
import { useSessionDetailsSectionOpen } from "@/lib/session-details-prefs"
import type { AgentType } from "@/lib/types"
import { cn } from "@/lib/utils"

export interface SessionMcpSectionProps {
  /** Connection context key (`tab.id`), or `null` when unavailable. */
  contextKey: string | null
  /** Active or draft conversation's agent type. */
  agentType: AgentType | null
  /** Whether the Session Details tab is currently on screen. */
  active: boolean
  /** True when rendering in the draft (pre-first-message) view. */
  draft?: boolean
}

const STATUS_DOT_CLASS: Record<UnifiedMcpStatus, string> = {
  session_confirmed: "bg-emerald-500",
  probe_healthy: "bg-emerald-500/80",
  auth_required: "bg-amber-500",
  connection_failed: "bg-red-500",
  saved_pending_reconnect: "bg-amber-500",
  skipped_transport: "bg-amber-500",
  configured: "bg-muted-foreground/50",
  paused: "bg-muted-foreground/35",
}

const STATUS_BADGE_CLASS: Record<UnifiedMcpStatus, string> = {
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

function useOptionalLiveConnection(contextKey: string | null) {
  const store = useOptionalConnectionStore()
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!store || !contextKey) return () => {}
      return store.subscribeKey(contextKey, cb)
    },
    [store, contextKey]
  )
  const getConn = useCallback(
    () => (store && contextKey ? store.getConnection(contextKey) : undefined),
    [store, contextKey]
  )
  const conn = useSyncExternalStore(subscribe, getConn, getConn)
  const getConnectError = useCallback(
    () => (store && contextKey ? store.getConnectError(contextKey) : undefined),
    [store, contextKey]
  )
  const connectError = useSyncExternalStore(
    subscribe,
    getConnectError,
    getConnectError
  )
  return { conn, connectError }
}

/**
 * Flat accordion MCP section for the Session Details side panel (#1296 Phase 2).
 *
 * Follows the flat accordion grammar introduced in `5e1e08faf`: sits directly
 * inside `SESSION_DETAILS_COLUMN` (hairline dividers, no outer card frame),
 * uses a `w-5` left icon rail, right-aligned count + chevron, and persists
 * open/closed state via `useSessionDetailsSectionOpen("mcp")`.
 *
 * Network restraint: only fetches `mcpInventory` and subscribes to
 * `mcp://changed` while BOTH the Session Details tab is active AND this
 * section is expanded.
 */
export function SessionMcpSection({
  contextKey,
  agentType,
  active,
  draft = false,
}: SessionMcpSectionProps) {
  const t = useTranslations("Folder.sessionMcp")
  const [open, setOpen] = useSessionDetailsSectionOpen("mcp")
  const { available: harnessAvailable, openHarness } = useOpenHarness()
  const actions = useOptionalAcpActions()
  const { conn, connectError } = useOptionalLiveConnection(contextKey)

  const [reconnecting, setReconnecting] = useState(false)
  const [testingAll, setTestingAll] = useState(false)
  const [pausingKey, setPausingKey] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
    () => new Set()
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
    loading,
    hasLoadedInventory,
    probeServer,
    probeAllActive,
    pauseServer,
  } = useSessionMcp({
    agentType: effectiveAgentType,
    active: active && open,
    connectionStatus: conn?.status ?? null,
    sessionMcpState: conn?.mcpState ?? null,
    sessionFailures: conn?.sessionFailures,
    errorText,
    configStale: conn?.configStale ?? false,
    configStaleKind: conn?.configStaleKind ?? null,
  })

  // Unknown agents have no MCP surface to display.
  if (!state.mcpAgentId) return null

  // In draft mode, hide quietly once we know the agent either doesn't support
  // MCP or has no configured servers and no errors.
  if (
    draft &&
    hasLoadedInventory &&
    (!state.supportsMcp ||
      (state.rows.length === 0 &&
        state.summary.attentionCount === 0 &&
        !state.needsReconnect))
  ) {
    return null
  }

  const isOwner = Boolean(
    conn && !conn.isViewer && !conn.isDelegationChild && actions && contextKey
  )
  const turnInFlight = conn?.status === "prompting"
  const reconnectBusy = reconnecting || conn?.status === "connecting"

  const toggleExpanded = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleReconnect = async () => {
    if (!actions || !contextKey || turnInFlight || reconnectBusy) return
    setReconnecting(true)
    try {
      const ok = await actions.reapplyConfig(contextKey)
      if (ok) toast.success(t("reconnected"))
    } catch {
      // connect() publishes its own failure notification.
    } finally {
      setReconnecting(false)
    }
  }

  const handleTestRow = async (key: string) => {
    setExpandedKeys((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
    await probeServer(key)
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
      if (actions && contextKey) {
        await actions.reapplyConfig(contextKey)
      }
      toast.success(t("pausedAndReconnecting", { server: key }))
    } catch {
      toast.error(t("pauseFailed", { server: key }))
    } finally {
      setPausingKey(null)
    }
  }

  const hasIssue =
    state.summary.attentionCount > 0 ||
    state.needsReconnect ||
    state.summary.pendingReconnectCount > 0
  const hasFailed = state.rows.some((r) => r.status === "connection_failed")

  const summaryText =
    state.rows.length === 0
      ? "0"
      : state.summary.pausedCount > 0
        ? `${state.summary.activeCount}/${state.rows.length}`
        : `${state.summary.activeCount}`

  const testableCount = state.rows.filter(
    (row) => row.canProbe && !row.paused && !row.removedPendingReconnect
  ).length

  const capabilityParts: string[] = ["stdio"]
  if (state.capabilities?.http) capabilityParts.push("HTTP")
  if (state.capabilities?.sse) capabilityParts.push("SSE")

  return (
    <section
      data-testid="session-mcp-section"
      className={cn("min-w-0 py-1.5", open && "pb-3")}
    >
      <h3 className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group/section flex h-9 w-full min-w-0 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span
            aria-hidden="true"
            className="flex w-5 shrink-0 justify-center text-foreground [&>svg]:size-4"
          >
            <Plug />
          </span>
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-foreground decoration-foreground/40 underline-offset-4 group-hover/section:underline">
            {t("title")}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground tabular-nums transition-colors group-hover/section:text-foreground">
            {hasIssue && (
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  hasFailed ? "bg-red-500" : "bg-amber-500"
                )}
              />
            )}
            {summaryText}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/section:text-foreground motion-safe:transition-[color,rotate]",
              !open && "-rotate-90 rtl:rotate-90"
            )}
          />
        </button>
      </h3>

      {open && (
        <div className="space-y-2.5 ps-7 pt-0.5">
          {/* Delivery & declared capabilities summary */}
          {(state.delivery || state.codegMcpAttached) && (
            <div className="space-y-0.5 text-2xs leading-relaxed text-muted-foreground">
              {state.delivery && (
                <p>
                  {state.delivery === "codeg_session"
                    ? t("deliverySession")
                    : t("deliveryFile")}
                  {state.delivery === "codeg_session" && state.capabilities
                    ? ` · ${
                        capabilityParts.length === 1
                          ? t("capabilitiesStdioOnly")
                          : t("capabilitiesHint", {
                              transports: capabilityParts.join(" / "),
                            })
                      }`
                    : null}
                </p>
              )}
              {state.codegMcpAttached && <p>{t("codegMcpAttached")}</p>}
            </div>
          )}

          {/* Custom agent with supports_mcp = false */}
          {!state.supportsMcp && (
            <div className="space-y-1.5 rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
              <p>{t("mcpDisabled")}</p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="h-6 px-2 text-2xs"
                onClick={() => {
                  openSettingsWindow("agents").catch((err) => {
                    console.error(
                      "[SessionMcpSection] failed to open agent settings:",
                      err
                    )
                  })
                }}
              >
                <Settings2 aria-hidden="true" className="size-3" />
                {t("openAgentSettings")}
              </Button>
            </div>
          )}

          {/* Pending reconnect CTA */}
          {state.needsReconnect && !draft && isOwner && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-2xs text-amber-700 dark:text-amber-300">
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

          {/* Server list */}
          {loading && state.rows.length === 0 ? (
            <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {t("loading")}
            </p>
          ) : state.rows.length === 0 ? (
            state.supportsMcp && (
              <p className="py-0.5 text-xs text-muted-foreground">
                {t("noServers")}
              </p>
            )
          ) : (
            <ul className="divide-y divide-border/50">
              {state.rows.map((row) => (
                <SessionMcpServerItem
                  key={row.key}
                  row={row}
                  expanded={expandedKeys.has(row.key)}
                  onToggleExpand={() => toggleExpanded(row.key)}
                  onTest={() => void handleTestRow(row.key)}
                  onPauseAndReconnect={
                    row.status === "connection_failed" &&
                    row.canPause &&
                    !draft &&
                    isOwner
                      ? () => void handlePauseAndReconnect(row.key)
                      : undefined
                  }
                  onAuthorize={
                    harnessAvailable &&
                    row.status === "auth_required" &&
                    (row.transport === "http" || row.transport === "sse")
                      ? () =>
                          openHarness({
                            section: "mcp",
                            serverKey: row.key,
                            openOAuth: true,
                          })
                      : undefined
                  }
                  pausing={pausingKey === row.key}
                  reconnectDisabled={turnInFlight || reconnectBusy}
                />
              ))}
            </ul>
          )}

          {/* Footer light actions */}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {testableCount > 0 && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={testingAll}
                onClick={() => void handleTestAll()}
                className="h-6 px-2 text-2xs text-muted-foreground hover:text-foreground"
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
                variant="ghost"
                onClick={() =>
                  openHarness({
                    section: "mcp",
                    agentId: state.mcpAgentId ?? undefined,
                  })
                }
                className="h-6 px-2 text-2xs text-muted-foreground hover:text-foreground"
              >
                <Settings2 aria-hidden="true" className="size-3" />
                {t("manageMcp")}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function SessionMcpServerItem({
  row,
  expanded,
  onToggleExpand,
  onTest,
  onPauseAndReconnect,
  onAuthorize,
  pausing,
  reconnectDisabled,
}: {
  row: UnifiedMcpServerRow
  expanded: boolean
  onToggleExpand: () => void
  onTest: () => void
  onPauseAndReconnect?: () => void
  onAuthorize?: () => void
  pausing: boolean
  reconnectDisabled: boolean
}) {
  const t = useTranslations("Folder.sessionMcp")
  const transportLabel = formatTransport(row.transport)
  const probing = row.probe?.phase === "loading"
  const probeResult = row.probe?.phase === "ready" ? row.probe.result : null
  const hasExpandableDetails = Boolean(
    row.detail ||
    row.confirmedTools.length > 0 ||
    (probeResult &&
      (probeResult.tools.length > 0 ||
        probeResult.status === "auth_required" ||
        probeResult.detail)) ||
    row.probe?.phase === "error" ||
    row.status === "skipped_transport" ||
    row.removedPendingReconnect ||
    (row.needsReconnect && row.paused)
  )

  const badgeText =
    row.status === "probe_healthy" && row.toolsCount !== null
      ? `${t("status.probe_healthy")} (${t("toolsCount", { count: row.toolsCount })})`
      : t(`status.${row.status}`)

  return (
    <li className="min-w-0 py-1.5 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-1.5">
        {hasExpandableDetails ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggleExpand}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {expanded ? (
              <ChevronDown
                aria-hidden="true"
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : (
              <ChevronRight
                aria-hidden="true"
                className="size-3 shrink-0 text-muted-foreground rtl:rotate-180"
              />
            )}
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
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
        )}

        {row.canProbe && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={probing}
            onClick={onTest}
            aria-label={`${t("test")} ${row.key}`}
            className="h-5 shrink-0 px-1.5 text-3xs text-muted-foreground hover:text-foreground"
          >
            {probing ? (
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            ) : (
              <Activity aria-hidden="true" className="size-3" />
            )}
            {probing ? t("testing") : t("test")}
          </Button>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium",
            STATUS_BADGE_CLASS[row.status]
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              STATUS_DOT_CLASS[row.status]
            )}
          />
          {badgeText}
        </span>
        {probeResult && probeResult.latency_ms > 0 && (
          <span className="font-mono text-3xs text-muted-foreground tabular-nums">
            {t("latency", { ms: probeResult.latency_ms })}
          </span>
        )}
        {row.oauthBridged && row.oauthRoute?.status === "authorized" && (
          <span className="text-3xs text-muted-foreground">
            {t("oauthBridge")}
          </span>
        )}
        {onAuthorize && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onAuthorize}
            className="h-5 gap-1 border-amber-500/40 px-1.5 text-3xs text-amber-800 hover:bg-amber-500/15 dark:text-amber-200"
          >
            <KeyRound aria-hidden="true" className="size-2.5" />
            {t("authorize")}
          </Button>
        )}
        {onPauseAndReconnect && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={pausing || reconnectDisabled}
            onClick={onPauseAndReconnect}
            className="h-5 gap-1 border-amber-500/40 px-1.5 text-3xs text-amber-800 hover:bg-amber-500/15 dark:text-amber-200"
          >
            {pausing ? (
              <Loader2 aria-hidden="true" className="size-2.5 animate-spin" />
            ) : (
              <PauseCircle aria-hidden="true" className="size-2.5" />
            )}
            {pausing ? t("pausing") : t("pauseAndReconnect")}
          </Button>
        )}
      </div>

      {expanded && hasExpandableDetails && (
        <div className="mt-1.5 space-y-1 rounded-md bg-muted/35 px-2 py-1.5 text-2xs text-muted-foreground">
          {row.status === "auth_required" && (
            <div className="space-y-0.5">
              <p>{t("authRequiredHint")}</p>
              {probeResult?.auth_hint?.resource_metadata && (
                <p className="truncate font-mono text-3xs text-foreground">
                  {probeResult.auth_hint.resource_metadata}
                </p>
              )}
            </div>
          )}
          {row.status === "skipped_transport" && transportLabel && (
            <p>{t("skippedTransportHint", { transport: transportLabel })}</p>
          )}
          {row.removedPendingReconnect && <p>{t("removedPendingHint")}</p>}
          {row.needsReconnect && row.paused && <p>{t("pausedPendingHint")}</p>}
          {row.probe?.phase === "error" && (
            <p className="text-red-600 dark:text-red-400">
              {t("probeRpcFailed")}
            </p>
          )}
          {row.detail && (
            <p className="break-words font-mono text-3xs text-foreground/85">
              {row.detail}
            </p>
          )}
          {row.confirmedTools.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-3xs font-medium text-foreground/80">
                {t("confirmedTools")}
              </p>
              <div className="flex flex-wrap gap-1">
                {row.confirmedTools.map((tool) => (
                  <code
                    key={tool}
                    className="rounded bg-background/80 px-1 py-0.5 font-mono text-3xs text-foreground"
                  >
                    {tool}
                  </code>
                ))}
              </div>
            </div>
          )}
          {probeResult && probeResult.tools.length > 0 && (
            <ul className="max-h-32 space-y-0.5 overflow-y-auto pt-0.5">
              {probeResult.tools.map((tool) => (
                <li key={tool.name} className="min-w-0 truncate">
                  <code className="font-mono text-3xs font-medium text-foreground">
                    {tool.name}
                  </code>
                  {tool.description && (
                    <span className="ms-1 text-3xs text-muted-foreground">
                      {tool.description}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}
