"use client"

import { useState } from "react"
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  KeyRound,
  Loader2,
  ShieldAlert,
  Terminal,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import type { McpProbeRecord } from "@/lib/harness/mcp-state"
import type { McpProbeResult } from "@/lib/mcp/types"
import { cn } from "@/lib/utils"
import { MachineText } from "../machine-text"
import { Technical } from "./mcp-plan"

const KNOWN_PROBE_STATUSES = [
  "ok",
  "auth_required",
  "forbidden",
  "session_id_mismatch",
  "spawn_failed",
  "timeout",
  "protocol_error",
  "network_error",
  "config_error",
] as const

type KnownProbeStatus = (typeof KNOWN_PROBE_STATUSES)[number]

function isKnownProbeStatus(status: string): status is KnownProbeStatus {
  return (KNOWN_PROBE_STATUSES as readonly string[]).includes(status)
}

/** Trigger button for testing an MCP server entry, group, or editor draft. */
export function McpProbeButton({
  loading,
  tested,
  disabled,
  onClick,
  size = "sm",
  variant = "outline",
  label,
}: {
  loading: boolean
  tested?: boolean
  disabled?: boolean
  onClick: () => void
  size?: "xs" | "sm"
  variant?: "outline" | "ghost"
  label?: string
}) {
  const t = useTranslations("Harness.mcp.probe")
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled || loading}
      onClick={onClick}
      className="gap-1.5"
    >
      {loading ? (
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      ) : (
        <Activity aria-hidden="true" className="size-3.5" />
      )}
      {label ??
        (loading ? t("testing") : tested ? t("retest") : t("testConnection"))}
    </Button>
  )
}

/** Compact health-probe result card. Renders nothing when no probe exists. */
export function McpProbePanel({
  record,
  compact = false,
  onAuthorizeOAuth,
}: {
  record: McpProbeRecord | null | undefined
  compact?: boolean
  /** When provided and status is `auth_required`, renders an inline OAuth
   *  authorization CTA button inside the OAuth hint block. */
  onAuthorizeOAuth?: (resourceMetadataUrl?: string | null) => void
}) {
  const t = useTranslations("Harness.mcp.probe")
  const [toolsOpen, setToolsOpen] = useState(false)
  const [stderrOpen, setStderrOpen] = useState(false)

  if (!record) return null

  if (record.phase === "loading" && !record.result) {
    return (
      <div
        role="status"
        className={cn(
          "flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground",
          compact && "py-1"
        )}
      >
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        <span>{t("testing")}</span>
      </div>
    )
  }

  if (record.phase === "error" && record.failure) {
    return (
      <div
        role="status"
        className="min-w-0 space-y-1 rounded-md border border-tone-warning/30 bg-tone-warning/10 px-2.5 py-2 text-xs"
      >
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <TriangleAlert
            aria-hidden="true"
            className="size-3.5 shrink-0 text-tone-warning"
          />
          <span>
            {record.failure.kind === "unsupported"
              ? t("unsupported")
              : t("rpcFailed")}
          </span>
        </div>
        <Technical detail={record.failure.detail} />
      </div>
    )
  }

  if (!record.result) return null

  return (
    <ProbeResultCard
      result={record.result}
      loading={record.phase === "loading"}
      compact={compact}
      toolsOpen={toolsOpen}
      onToggleTools={() => setToolsOpen((open) => !open)}
      stderrOpen={stderrOpen}
      onToggleStderr={() => setStderrOpen((open) => !open)}
      onAuthorizeOAuth={onAuthorizeOAuth}
    />
  )
}

function ProbeResultCard({
  result,
  loading,
  compact,
  toolsOpen,
  onToggleTools,
  stderrOpen,
  onToggleStderr,
  onAuthorizeOAuth,
}: {
  result: McpProbeResult
  loading: boolean
  compact: boolean
  toolsOpen: boolean
  onToggleTools: () => void
  stderrOpen: boolean
  onToggleStderr: () => void
  onAuthorizeOAuth?: (resourceMetadataUrl?: string | null) => void
}) {
  const t = useTranslations("Harness.mcp.probe")
  const status = result.status
  const isOk = status === "ok"
  const isAuth = status === "auth_required"
  const isForbidden = status === "forbidden"
  const isSessionMismatch = status === "session_id_mismatch"

  const toneClass = isOk
    ? "border-tone-success/30 bg-tone-success/10"
    : isAuth || isForbidden || isSessionMismatch
      ? "border-tone-warning/35 bg-tone-warning/10"
      : "border-destructive/30 bg-destructive/5"

  const Icon = isOk
    ? CircleCheck
    : isAuth
      ? KeyRound
      : isForbidden
        ? ShieldAlert
        : isSessionMismatch
          ? TriangleAlert
          : CircleAlert

  const iconClass = isOk
    ? "text-tone-success"
    : isAuth || isForbidden || isSessionMismatch
      ? "text-tone-warning"
      : "text-destructive"

  const headline = isOk
    ? t("status.ok", { count: result.tools_count })
    : isKnownProbeStatus(status)
      ? t(`status.${status}`)
      : t("status.unknown", { status })

  const serverMeta = result.server_info
    ? result.server_info.version
      ? `${result.server_info.name} ${result.server_info.version}`
      : result.server_info.name
    : null

  return (
    <div
      role="status"
      className={cn(
        "min-w-0 space-y-1.5 rounded-md border px-2.5 py-2 text-xs",
        toneClass,
        compact && "py-1.5"
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          {loading ? (
            <Loader2
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin text-muted-foreground"
            />
          ) : (
            <Icon
              aria-hidden="true"
              className={cn("size-3.5 shrink-0", iconClass)}
            />
          )}
          {headline}
        </span>
        <span className="font-mono text-2xs text-muted-foreground">
          {t("latency", { ms: result.latency_ms })}
        </span>
        {serverMeta && (
          <bdi
            dir="ltr"
            className="truncate font-mono text-2xs text-muted-foreground"
          >
            <MachineText>{serverMeta}</MachineText>
          </bdi>
        )}
        {result.http_status != null && (
          <span className="font-mono text-2xs text-muted-foreground">
            HTTP {result.http_status}
          </span>
        )}
      </div>

      {isAuth && (
        <div className="space-y-1.5 text-2xs text-muted-foreground">
          <p>{t("authRequiredHint")}</p>
          {result.auth_hint?.resource_metadata && (
            <bdi dir="ltr" className="block truncate font-mono text-foreground">
              <MachineText>{result.auth_hint.resource_metadata}</MachineText>
            </bdi>
          )}
          {onAuthorizeOAuth && (
            <div className="pt-0.5">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() =>
                  onAuthorizeOAuth(result.auth_hint?.resource_metadata ?? null)
                }
                className="h-6 gap-1.5 text-2xs"
              >
                <KeyRound aria-hidden="true" className="size-3" />
                {t("authorizeOAuth")}
              </Button>
            </div>
          )}
        </div>
      )}

      {isSessionMismatch && (
        <p className="text-2xs text-muted-foreground">
          {t("sessionIdMismatchHint")}
        </p>
      )}

      {result.detail && <Technical detail={result.detail} />}

      {isOk && result.tools.length > 0 && (
        <div className="pt-0.5">
          <button
            type="button"
            onClick={onToggleTools}
            aria-expanded={toolsOpen}
            className="inline-flex items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground"
          >
            {toolsOpen ? (
              <ChevronDown aria-hidden="true" className="size-3" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-3" />
            )}
            {toolsOpen
              ? t("hideTools")
              : t("showTools", { count: result.tools.length })}
          </button>
          {toolsOpen && (
            <ul className="mt-1.5 max-h-44 space-y-1 overflow-y-auto rounded border bg-background/80 p-2">
              {result.tools.map((tool) => (
                <li key={tool.name} className="min-w-0 text-2xs">
                  <bdi
                    dir="ltr"
                    className="font-mono font-medium text-foreground"
                  >
                    <MachineText>{tool.name}</MachineText>
                  </bdi>
                  {tool.description && (
                    <span className="ms-1.5 text-muted-foreground">
                      {tool.description}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {result.stderr_tail && (
        <div className="pt-0.5">
          <button
            type="button"
            onClick={onToggleStderr}
            aria-expanded={stderrOpen}
            className="inline-flex items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Terminal aria-hidden="true" className="size-3" />
            {stderrOpen ? t("hideStderr") : t("showStderr")}
          </button>
          {stderrOpen && (
            <pre
              dir="ltr"
              className="mt-1 max-h-36 overflow-auto rounded border bg-background/80 p-2 font-mono text-2xs whitespace-pre-wrap text-muted-foreground"
            >
              {result.stderr_tail}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
