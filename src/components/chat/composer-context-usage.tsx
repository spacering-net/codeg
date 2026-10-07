"use client"

import { useCallback, useSyncExternalStore } from "react"
import { Coins } from "lucide-react"
import { useTranslations } from "next-intl"
import { useConnectionStore } from "@/contexts/acp-connections-context"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { formatTokenCount } from "@/lib/token-format"
import { formatContextWindowPercent } from "@/lib/context-window"
import {
  CACHE_HIT_RATE_DIGITS,
  cacheHitRatio,
  formatPercent,
} from "@/lib/token-usage"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

const ICON_RADIUS = 6
const ICON_CENTER = 8
const ICON_VIEWBOX = 16
const ICON_CIRCUMFERENCE = 2 * Math.PI * ICON_RADIUS

/**
 * Context-window usage circle (+ token breakdown popover) shown in the row below
 * the composer. Scoped to its own conversation via `tabId`: the live context
 * window comes from that tab's connection (`contextKey`), and the fallback /
 * token breakdown from that conversation's own runtime-store session stats — so
 * every loaded/tiled composer shows its own context, not the active one's.
 */
export function ComposerContextUsage({ tabId }: { tabId: string | null }) {
  const t = useTranslations("Folder.statusBar.tokens")
  const store = useConnectionStore()
  // This tab's own conversation → its per-conversation session stats, read
  // straight from the runtime store where every panel already keeps them (keyed
  // by the tab's runtime conversation id — the same resolution the panel uses
  // for `effectiveConversationId`: runtimeConversationId ?? conversationId).
  // Reading per-conversation (rather than one shared "active session" value) is
  // what lets every loaded / tiled composer show its own context.
  const runtimeConversationId = useTabStore((s) => {
    const tab = s.tabs.find((x) => x.id === tabId)
    if (!tab || tab.kind !== "conversation") return null
    return tab.runtimeConversationId ?? tab.conversationId ?? null
  })
  const sessionStats = useConversationRuntimeStore((s) =>
    runtimeConversationId != null
      ? (s.byConversationId.get(runtimeConversationId)?.sessionStats ?? null)
      : null
  )
  const usage = sessionStats?.total_usage

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

  const rawLiveUsed = conn?.usage?.used ?? null
  const rawLiveSize = conn?.usage?.size ?? null
  // Treat live used=0 as "no data" so we fall back to sessionStats —
  // Claude Code sends used=0 for synthetic local commands (/context etc.)
  const liveContextUsed =
    rawLiveUsed != null && rawLiveUsed > 0 ? rawLiveUsed : null
  const liveContextMax =
    rawLiveSize != null && rawLiveSize > 0 ? rawLiveSize : null

  const contextUsed =
    liveContextUsed ?? sessionStats?.context_window_used_tokens ?? null
  const contextMax =
    liveContextMax ?? sessionStats?.context_window_max_tokens ?? null
  const contextPercentRaw =
    (liveContextUsed != null && liveContextMax != null && liveContextMax > 0
      ? (liveContextUsed / liveContextMax) * 100
      : sessionStats?.context_window_usage_percent) ??
    (contextUsed != null && contextMax != null && contextMax > 0
      ? (contextUsed / contextMax) * 100
      : null)
  const contextPercent =
    contextPercentRaw == null
      ? null
      : Math.max(0, Math.min(100, contextPercentRaw))
  const hasContext = contextPercent != null
  // All-zero counters are "nobody said", not "nothing was spent" — the same
  // judgement the cache rows below already make, applied to the whole section.
  // A session that produced replies cannot have cost zero tokens; qoder zeroes
  // every counter for its own hosted models (see `QODER_EXPOSE_TOKEN_USAGE` in
  // the registry), and a breakdown of zeros reads as a broken counter. Those
  // sessions still light the ring — qoder states its occupancy separately, as
  // a ratio that survives the redaction.
  const hasUsage =
    usage != null &&
    usage.input_tokens +
      usage.output_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens >
      0
  const fallbackTotal = hasUsage
    ? usage.input_tokens +
      usage.output_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens
    : null
  const reportedTotal = sessionStats?.total_tokens
  const total =
    reportedTotal != null && reportedTotal > 0 ? reportedTotal : fallbackTotal

  const dashOffset = ICON_CIRCUMFERENCE * (1 - (contextPercent ?? 0) / 100)

  const rows: {
    key: "input" | "output" | "cacheRead" | "cacheWrite" | "total"
    value: number
  }[] = []
  if (hasUsage) {
    rows.push(
      { key: "input", value: usage.input_tokens },
      { key: "output", value: usage.output_tokens },
      { key: "cacheRead", value: usage.cache_read_input_tokens },
      { key: "cacheWrite", value: usage.cache_creation_input_tokens }
    )
  }
  if (total != null) {
    rows.push({ key: "total", value: total })
  }

  const hasTokenSection = rows.length > 0

  // Cache hit rate, by the dashboard's definition (one shared `cacheHitRatio`,
  // so the popover and the Token Usage page can never disagree about what the
  // number means): cache reads over everything that entered as context.
  //
  // Gated on the session having ANY cache activity. Plenty of backends — a
  // self-hosted OpenAI-compatible endpoint above all — report no cache counters
  // at all, and codeg cannot tell "the cache did nothing" from "nobody said".
  // Rendering a confident `0.0%` for the latter is worse than rendering
  // nothing. A session with writes but no reads yet is genuinely 0% and still
  // shows.
  const hasCacheActivity =
    hasUsage &&
    usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0
  const cacheHit = hasCacheActivity
    ? cacheHitRatio(
        usage.input_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens
      )
    : null

  if (!hasContext && !hasTokenSection) return null

  // Native hover hint mirroring the popover's headline (the popover stays for
  // the full breakdown on click).
  const triggerTitle = hasContext
    ? contextUsed != null && contextMax != null
      ? `${t("contextWindow")}: ${formatContextWindowPercent(contextPercent)} (${formatTokenCount(contextUsed)} / ${formatTokenCount(contextMax)})`
      : `${t("contextWindow")}: ${formatContextWindowPercent(contextPercent)}`
    : `${t("tokenUsage")}: ${formatTokenCount(total ?? 0)}`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          title={triggerTitle}
          className="flex items-center gap-1 hover:text-foreground transition-colors"
        >
          {hasContext ? (
            <>
              <svg
                aria-label={t("contextWindowUsageAria")}
                className="size-3.5"
                viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
              >
                <circle
                  cx={ICON_CENTER}
                  cy={ICON_CENTER}
                  r={ICON_RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  opacity="0.25"
                />
                <circle
                  cx={ICON_CENTER}
                  cy={ICON_CENTER}
                  r={ICON_RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeDasharray={`${ICON_CIRCUMFERENCE} ${ICON_CIRCUMFERENCE}`}
                  strokeDashoffset={dashOffset}
                  style={{
                    transformOrigin: "center",
                    transform: "rotate(-90deg)",
                  }}
                  opacity="0.75"
                />
              </svg>
              <span>{formatContextWindowPercent(contextPercent)}</span>
            </>
          ) : (
            <>
              <Coins className="size-3.5" />
              <span>{formatTokenCount(total ?? 0)}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-56 gap-2 p-3 text-xs">
        {hasContext || cacheHit != null ? (
          <div
            className={`space-y-1 ${
              hasUsage ? "mb-0.5 border-b border-border pb-0.5" : ""
            }`}
          >
            {hasContext ? (
              <>
                <div className="flex items-center justify-between gap-2 text-xs font-medium whitespace-nowrap">
                  <span>{t("contextWindow")}</span>
                  <span className="tabular-nums shrink-0">
                    {formatContextWindowPercent(contextPercent)}
                  </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="absolute inset-y-0 left-0 bg-foreground/70"
                    style={{ width: `${contextPercent ?? 0}%` }}
                  />
                </div>
                {/* Dropped entirely rather than shown as "--": an agent can
                    state its occupancy as a percentage without ever naming the
                    two token counts behind it (qoder does exactly that once it
                    has redacted them), and a labelled row with nothing in it
                    reads as a figure that failed to load rather than one that
                    was never reported. */}
                {contextUsed != null && contextMax != null ? (
                  <div className="flex items-center justify-between text-xs leading-none text-muted-foreground">
                    <span>{t("usedMax")}</span>
                    <span className="tabular-nums">
                      {`${formatTokenCount(contextUsed)} / ${formatTokenCount(contextMax)}`}
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}
            {/* Sits with the context figures rather than under the token
                breakdown: it is a ratio, not a count, and a rule of its own
                above it only fenced off a single line. */}
            {cacheHit != null ? (
              <div className="flex items-center justify-between gap-2 text-xs leading-none text-muted-foreground">
                <span className="whitespace-nowrap">{t("cacheHit")}</span>
                <span className="tabular-nums shrink-0">
                  {formatPercent(cacheHit, CACHE_HIT_RATE_DIGITS)}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
        {hasTokenSection ? (
          <>
            <div className="mb-0 mt-0.5 text-xs leading-none font-medium">
              {t("tokenUsage")}
            </div>
            <div className="space-y-0">
              {rows.map((row) => (
                <div
                  key={row.key}
                  className={`flex items-center justify-between py-0.5 text-xs leading-none ${
                    row.key === "total"
                      ? "mt-0.5 border-t border-border pt-0.5 font-medium"
                      : "text-muted-foreground"
                  }`}
                >
                  <span>{t(row.key)}</span>
                  <span className="tabular-nums">
                    {formatTokenCount(row.value)}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
