"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Info,
  Loader2,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn, copyTextToClipboard } from "@/lib/utils"
import { getAgentLabel } from "@/lib/custom-agents"
import { acpEnvDiagnostics } from "@/lib/api"
import type { AgentDiagnosticsReport, AgentType, DiagLevel } from "@/lib/types"

export interface AgentDiagnosticsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Agent to focus the report on. Omit for a base environment report. */
  agentType?: AgentType
}

const LEVEL_DOT: Record<DiagLevel, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  fail: "bg-red-500",
  info: "bg-muted-foreground/40",
}

const LEVEL_TEXT: Record<DiagLevel, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  fail: "text-red-500",
  info: "text-muted-foreground",
}

const VERDICT_BANNER: Record<DiagLevel, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  fail: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  info: "border-border bg-muted/40 text-foreground",
}

const VERDICT_ICON: Record<DiagLevel, LucideIcon> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  info: Info,
}

// Codes emitted by the backend `compute_verdict`. Kept in sync with the
// `DiagnosticsSettings.verdict.*` i18n keys; anything unknown falls back to the
// backend-provided English summary (never fed through ICU).
const VERDICT_CODES = [
  "ok",
  "node_missing",
  "npm_missing",
  "not_installed",
  "installed_but_unresolved",
  "user_prefix_not_on_path",
  "homebrew_bin_not_on_path",
  "terminal_only_path",
  "npm_prefix_timeout",
  "node_too_old",
  // Adapter agents (Claude Code, Codex): the vendor CLI is not what codeg
  // launches, so "not installed" needs a different explanation.
  "adapter_missing_native_present",
  "adapter_missing",
] as const

type VerdictCode = (typeof VERDICT_CODES)[number]

const isKnownVerdict = (code: string): code is VerdictCode =>
  (VERDICT_CODES as readonly string[]).includes(code)

/** The one-line "likely cause" banner, colored + iconed by severity. */
function VerdictBanner({ level, label }: { level: DiagLevel; label: string }) {
  const Icon = VERDICT_ICON[level]
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm",
        VERDICT_BANNER[level]
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="font-medium leading-snug">{label}</span>
    </div>
  )
}

export function AgentDiagnosticsDialog({
  open,
  onOpenChange,
  agentType,
}: AgentDiagnosticsDialogProps) {
  const t = useTranslations("DiagnosticsSettings")
  const [report, setReport] = useState<AgentDiagnosticsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setReport(await acpEnvDiagnostics(agentType))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [agentType])

  // Run once each time the dialog opens; clear when it closes.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- diagnostics fetch on open; clears with it on close
      void run()
    } else {
      setReport(null)
      setError(null)
    }
  }, [open, run])

  // The adapter verdicts name the agent; every other message ignores the extra
  // value. `agent` is empty only for the base environment report, which cannot
  // produce an agent-specific code.
  const verdictLabel = (code: string, fallback: string): string =>
    isKnownVerdict(code)
      ? t(`verdict.${code}`, {
          agent: agentType ? getAgentLabel(agentType) : "",
        })
      : fallback

  const onCopy = async () => {
    if (!report) return
    if (await copyTextToClipboard(report.plain_text)) {
      toast.success(t("copied"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] min-h-[8rem] overflow-y-auto pr-1">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("loading")}
            </div>
          )}

          {!loading && error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
              {t("error")}: {error}
            </div>
          )}

          {!loading && report && (
            <div className="space-y-3">
              <VerdictBanner
                level={report.verdict.level}
                label={verdictLabel(
                  report.verdict.code,
                  report.verdict.summary
                )}
              />

              {report.sections.map((section, si) => (
                <div
                  key={si}
                  className="overflow-hidden rounded-lg border bg-card/40"
                >
                  <div className="border-b bg-muted/30 px-3 py-1.5">
                    <h4 className="text-xs font-semibold tracking-wide">
                      {section.title}
                    </h4>
                  </div>
                  <div className="divide-y divide-border/40">
                    {section.checks.map((check, ci) => (
                      <div
                        key={ci}
                        className="flex items-start gap-2.5 px-3 py-2"
                      >
                        <span
                          className={cn(
                            "mt-[5px] h-2 w-2 shrink-0 rounded-full",
                            LEVEL_DOT[check.status]
                          )}
                        />
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="text-xs font-medium">
                              {check.label}
                            </span>
                            <span
                              className={cn(
                                "break-all font-mono text-2xs",
                                LEVEL_TEXT[check.status]
                              )}
                            >
                              {check.value}
                            </span>
                          </div>
                          {check.hint && (
                            <div className="text-2xs leading-snug text-muted-foreground/70">
                              {check.hint}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {report.generated_at && (
                <div className="flex items-center justify-center gap-1.5 pt-0.5 text-2xs text-muted-foreground/60">
                  <Clock className="h-3 w-3" />
                  {report.generated_at}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void run()}
            disabled={loading}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
            {t("rerun")}
          </Button>
          <Button
            size="sm"
            onClick={() => void onCopy()}
            disabled={loading || !report}
          >
            <Copy className="h-3.5 w-3.5" />
            {t("copyAll")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
