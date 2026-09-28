"use client"

import { useCallback, useState, useSyncExternalStore } from "react"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  HeartHandshake,
  HeartPulse,
  HeartCrack,
  HeartOff,
  RefreshCw,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useAcpActions,
  useConnectionStore,
} from "@/contexts/acp-connections-context"
import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { isConnectionBusy } from "@/lib/connection-teardown"
import { cn } from "@/lib/utils"

// Connection-only states. The session "prompting" state is intentionally
// collapsed into "connected" (the connection stays up while the agent responds),
// and anything unknown falls back to "disconnected".
type ConnStatusKey = "connected" | "connecting" | "error" | "disconnected"

// Heart icons per connection state (HeartCrack stands in for the requested
// HeartX, which lucide does not ship). The steady "connected" state carries no
// colour override, so it inherits the row's default `text-muted-foreground`
// (matching the sibling context-usage circle) — the common resting state
// shouldn't stand out. Only the transient/abnormal states stay colour-coded:
// connecting amber, error red, disconnected dimmed.
const STATUS_ICON: Record<
  ConnStatusKey,
  { Icon: LucideIcon; className: string }
> = {
  connected: { Icon: HeartHandshake, className: "" },
  connecting: { Icon: HeartPulse, className: "text-amber-500 animate-pulse" },
  error: { Icon: HeartCrack, className: "text-red-500" },
  disconnected: { Icon: HeartOff, className: "text-muted-foreground/60" },
}

function toConnStatus(status: string | null): ConnStatusKey {
  switch (status) {
    case "connected":
    case "prompting":
      return "connected"
    case "connecting":
      return "connecting"
    case "error":
      return "error"
    default:
      return "disconnected"
  }
}

/**
 * The popover states the REAL status, so "Responding..." is worth telling apart
 * from a resting "Connected" — the icon keeps collapsing the two.
 */
function toDetailStatus(status: string | null): ConnStatusKey | "prompting" {
  return status === "prompting" ? "prompting" : toConnStatus(status)
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-2xs leading-none text-muted-foreground">{label}</dt>
      <dd className="font-mono text-2xs leading-snug break-all" title={value}>
        {value}
      </dd>
    </div>
  )
}

/**
 * Connection-status icon shown in the row below the composer. Scoped to its own
 * conversation via `tabId` (the connection `contextKey`) so tiled/multi-open
 * composers each reflect their own connection. The inline signal is just a
 * colour-coded heart (no agent icon or model label) with the detail on hover;
 * clicking it opens a popover with the full connection state and a Reconnect
 * button that stays available in EVERY state — including `disconnected`, where
 * the store holds no entry at all and the params come from what `connect()` last
 * recorded for this key (see `AcpActionsValue.reconnect`).
 */
export function ComposerConnectionStatus({ tabId }: { tabId: string | null }) {
  const t = useTranslations("Folder.statusBar.connection")
  const store = useConnectionStore()
  const { reconnect, getReconnectInfo } = useAcpActions()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const subscribeConn = useCallback(
    (cb: () => void) => {
      if (!tabId) return () => {}
      return store.subscribeKey(tabId, cb)
    },
    [store, tabId]
  )
  const getConnSnapshot = useCallback(
    () => (tabId ? store.getConnection(tabId) : undefined),
    [store, tabId]
  )
  const conn = useSyncExternalStore(
    subscribeConn,
    getConnSnapshot,
    getConnSnapshot
  )
  // A `connect()` in flight has no store entry yet — the backend call that
  // creates one only returns once the agent has spawned and resumed the
  // session. Without this the whole (often multi-second) establishment showed
  // the dimmed "disconnected" heart, which is the opposite of what's happening.
  const getPendingSnapshot = useCallback(
    () => (tabId ? store.getConnectPending(tabId) : undefined),
    [store, tabId]
  )
  const connectPending = useSyncExternalStore(
    subscribeConn,
    getPendingSnapshot,
    getPendingSnapshot
  )
  // A connect that FAILED leaves no entry either; without this the heart fell
  // back to a dimmed "disconnected", as if nothing had been tried.
  const getConnectErrorSnapshot = useCallback(
    () => (tabId ? store.getConnectError(tabId) : undefined),
    [store, tabId]
  )
  const connectError = useSyncExternalStore(
    subscribeConn,
    getConnectErrorSnapshot,
    getConnectErrorSnapshot
  )
  const failedConnect = !conn && !connectPending ? connectError : undefined
  const status =
    conn?.status ??
    (connectPending ? "connecting" : failedConnect ? "error" : null)
  // What went wrong, in one line: the live connection's error, or why the
  // last connect attempt failed.
  const errorText =
    conn?.error ??
    (failedConnect
      ? failedConnect.detail
        ? `${failedConnect.title} · ${failedConnect.detail}`
        : failedConnect.title
      : null)

  const statusKey = toConnStatus(status)
  const statusLabel = t(statusKey)
  const agentType =
    conn?.agentType ??
    connectPending?.agentType ??
    failedConnect?.agentType ??
    null
  const agentLabel = agentType ? getAgentLabel(agentType) : null
  const titleText = !agentLabel
    ? statusLabel
    : statusKey === "error" && errorText
      ? t("tooltipError", { agent: agentLabel, error: errorText })
      : t("tooltip", { agent: agentLabel, status: statusLabel })

  const { Icon, className } = STATUS_ICON[statusKey]

  // Only resolved while the popover is open: a closed trigger has no use for it,
  // and this reads a provider ref rather than subscribed state.
  const reconnectInfo = open && tabId ? getReconnectInfo(tabId) : null
  // With no live connection the popover still has something to name — the agent
  // (and cwd) of the connection that WAS here, straight from the reconnect target.
  const detailAgentType = agentType ?? reconnectInfo?.agentType ?? null
  const detailAgentLabel = detailAgentType
    ? getAgentLabel(detailAgentType)
    : null
  const detailStatusKey = toDetailStatus(status)
  const workingDir =
    conn?.workingDir ??
    connectPending?.workingDir ??
    reconnectInfo?.workingDir ??
    null
  const sessionId = conn?.sessionId ?? reconnectInfo?.sessionId ?? null
  // A reconnect on a busy OWNER kills the agent CLI mid-turn; a viewer's only
  // detaches and re-attaches, leaving the owner's agent alone — so only the
  // former is worth warning about.
  const destructive =
    !conn?.isViewer &&
    isConnectionBusy({
      status: conn?.status ?? null,
      backgroundOutstanding: conn?.backgroundOutstanding ?? 0,
    })
  const canReconnect = reconnectInfo !== null

  const handleReconnect = useCallback(() => {
    if (!tabId) return
    setPending(true)
    void reconnect(tabId)
      .catch(() => {
        // connect() notifies its own failures (with the agent-settings
        // action); the status icon flipping to `error` is the local signal.
      })
      .finally(() => setPending(false))
  }, [reconnect, tabId])

  // The trigger keeps the native `title` (hover tooltip) it had as a plain span,
  // so the detail is still one hover away now that a click opens the popover.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("triggerAria", { status: statusLabel })}
          title={titleText}
          className="inline-flex shrink-0 rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Icon className={cn("size-3.5", className)} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 gap-2.5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {detailAgentType ? (
              // Decorative: the label beside it already names the agent.
              <span aria-hidden="true" className="inline-flex">
                <AgentIcon agentType={detailAgentType} className="size-3.5" />
              </span>
            ) : null}
            <span className="truncate text-xs font-medium">
              {detailAgentLabel ?? t("title")}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Icon className={cn("size-3", className)} />
            {t(detailStatusKey)}
          </span>
        </div>

        {errorText ? (
          <p
            className={cn(
              "max-h-24 overflow-auto rounded-md px-2 py-1 text-2xs leading-snug break-words",
              conn?.error && conn.errorLevel === "warning"
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {errorText}
          </p>
        ) : null}

        {workingDir || sessionId ? (
          <dl className="space-y-2">
            {workingDir ? (
              <DetailRow label={t("workingDir")} value={workingDir} />
            ) : null}
            {sessionId ? (
              <DetailRow label={t("sessionId")} value={sessionId} />
            ) : null}
          </dl>
        ) : null}

        {conn?.isViewer ? (
          <p className="text-2xs leading-snug text-muted-foreground">
            {t("viewerNote")}
          </p>
        ) : null}

        {canReconnect && destructive ? (
          <p className="text-2xs leading-snug text-amber-600 dark:text-amber-500">
            {t("reconnectInterrupts")}
          </p>
        ) : null}

        <Button
          type="button"
          size="xs"
          variant="outline"
          className="w-full"
          disabled={!canReconnect || pending}
          onClick={handleReconnect}
        >
          <RefreshCw className={cn(pending && "animate-spin")} />
          {pending ? t("reconnecting") : t("reconnect")}
        </Button>

        {!canReconnect ? (
          <p className="text-2xs leading-snug text-muted-foreground">
            {t("reconnectUnavailable")}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
