"use client"

import type { ReactNode } from "react"
import {
  CircleAlert,
  CircleCheck,
  FilePlus2,
  Info,
  Loader2,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import type { McpFlow } from "@/lib/harness/mcp-state"
import { headlineOf, isAgentFine } from "@/lib/mcp/results"
import type { McpAgentResult, McpApplyResult } from "@/lib/mcp/types"
import { cn } from "@/lib/utils"
import { MachineText } from "../machine-text"
import { AgentGlyph, PathText } from "./mcp-bits"
import { useMcpLabels } from "./use-mcp-labels"

/** Technical detail under a message: never the message itself. */
export function Technical({ detail }: { detail: string | null | undefined }) {
  if (!detail) return null
  return (
    <bdi
      dir="ltr"
      className="mt-0.5 block font-mono text-2xs text-muted-foreground"
    >
      <MachineText>{detail}</MachineText>
    </bdi>
  )
}

/** One agent's part of a preflight or of a save. */
function AgentResult({
  agent,
  showKeys,
  phase,
}: {
  agent: McpAgentResult
  /** Several servers in one save: each op says which one it is. */
  showKeys: boolean
  phase: "review" | "result"
}) {
  const t = useTranslations("Harness.mcp.plan")
  const labels = useMcpLabels()
  const fine = isAgentFine(agent)
  const Icon = fine ? CircleCheck : CircleAlert
  // One op of one server: its effect fits on the status line.
  const inline = fine && !showKeys && agent.ops.length === 1
  return (
    <li className="min-w-0 space-y-1.5 px-3 py-2.5 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <AgentGlyph agent={agent.agent} />
        <span className="text-sm font-medium">{labels.agent(agent.agent)}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1",
            fine ? "text-muted-foreground" : "text-tone-warning"
          )}
        >
          <Icon aria-hidden="true" className="size-3.5" />
          {labels.status(agent.status)}
          {inline && ` · ${labels.effect(agent.ops[0].effect)}`}
        </span>
      </div>
      {/* What each op does, for an agent whose part goes through: for one
          that is stopped, "updated" would say what did not happen. */}
      {fine && agent.ops.length > 0 && !inline && (
        <ul className="space-y-0.5 text-muted-foreground">
          {agent.ops.map((op) => (
            <li key={op.index} className="flex min-w-0 flex-wrap gap-x-1.5">
              {showKeys && (
                <bdi dir="ltr" className="font-mono text-foreground">
                  <MachineText>{op.key}</MachineText>
                </bdi>
              )}
              <span>{labels.effect(op.effect)}</span>
            </li>
          ))}
        </ul>
      )}
      {(phase === "review" || fine) && agent.writes.length > 0 && (
        <ul aria-label={t("files")} className="space-y-0.5">
          {agent.writes.map((write) => (
            <li key={write.path} className="min-w-0">
              <PathText path={write.path} />
              {(write.creates || write.role === "plugin_gate") && (
                <span className="flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
                  {write.creates && (
                    <span className="inline-flex items-center gap-1">
                      <FilePlus2 aria-hidden="true" className="size-3" />
                      {t("createsFile")}
                    </span>
                  )}
                  {write.role === "plugin_gate" && (
                    <span>{t("pluginGate")}</span>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {agent.warnings.length > 0 && (
        <ul className="space-y-0.5">
          {agent.warnings.map((warning, index) => (
            <li key={index} className="flex min-w-0 items-start gap-1.5">
              <Info
                aria-hidden="true"
                className="mt-0.5 size-3 shrink-0 text-tone-info"
              />
              <span className="min-w-0">
                {labels.issue(warning, "warning")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {agent.issues.length > 0 && (
        <ul className="space-y-0.5">
          {agent.issues.map((issue, index) => (
            <li key={index} className="flex min-w-0 items-start gap-1.5">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-3 shrink-0 text-tone-warning"
              />
              <span className="min-w-0">
                {issue.key && showKeys && (
                  <bdi dir="ltr" className="me-1.5 font-mono">
                    <MachineText>{issue.key}</MachineText>
                  </bdi>
                )}
                {labels.issue(issue, "op")}
                <Technical detail={issue.detail} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {phase === "result" &&
        agent.status === "restore_skipped" &&
        agent.backup_paths.length > 0 && (
          <div className="rounded-md bg-tone-warning/10 px-2 py-1.5">
            <p>{t("backupCopy")}</p>
            {agent.backup_paths.map((path) => (
              <PathText key={path} path={path} className="text-foreground" />
            ))}
          </div>
        )}
    </li>
  )
}

/** Each agent's part of a preflight or of a save, as the MCP section shows
 *  it — also what an install from Harness came to. */
export function AgentResults({
  result,
  phase,
}: {
  result: McpApplyResult
  phase: "review" | "result"
}) {
  const keys = new Set(
    result.agents.flatMap((agent) => agent.ops.map((op) => op.key))
  )
  return (
    <ul className="divide-y rounded-lg border">
      {result.agents.map((agent) => (
        <AgentResult
          key={agent.agent}
          agent={agent}
          showKeys={keys.size > 1}
          phase={phase}
        />
      ))}
    </ul>
  )
}

/** The sentence a review or a result opens with. */
export function Headline({
  tone,
  children,
}: {
  tone: "fine" | "warning" | "neutral"
  children: ReactNode
}) {
  const Icon =
    tone === "fine" ? CircleCheck : tone === "warning" ? TriangleAlert : Info
  return (
    <p
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg px-3 py-2 text-sm",
        tone === "fine" && "bg-tone-success/10 text-foreground",
        tone === "warning" && "bg-tone-warning/10 text-foreground",
        tone === "neutral" && "bg-muted/60 text-foreground"
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "fine" && "text-tone-success",
          tone === "warning" && "text-tone-warning",
          tone === "neutral" && "text-muted-foreground"
        )}
      />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

function FailureHeadline({ flow }: { flow: McpFlow }) {
  const t = useTranslations("Harness.mcp.plan")
  if (!flow.failure) return null
  return (
    <Headline tone="warning">
      {flow.failure.kind === "unsupported" ? t("unsupported") : t("failed")}
      <Technical detail={flow.failure.detail} />
    </Headline>
  )
}

/**
 * What a save would write, before it is made: per agent, the files (and
 * whether one is created), what each op does, the warnings, and what stops
 * it. Nothing is written until the user confirms what this shows.
 */
export function McpReview({ flow }: { flow: McpFlow }) {
  const t = useTranslations("Harness.mcp.plan")
  const preflight = flow.preflight
  return (
    <div
      role="region"
      aria-label={t("reviewTitle")}
      aria-busy={!preflight && !flow.failure}
      className="min-w-0 space-y-3"
    >
      {flow.notice === "changedElsewhere" && (
        <Headline tone="neutral">{t("reread")}</Headline>
      )}
      <FailureHeadline flow={flow} />
      {!preflight && !flow.failure && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          {t("checking")}
        </p>
      )}
      {preflight && (
        <>
          {headlineOf(preflight) === "ready" ? (
            <Headline tone="neutral">{t("ready")}</Headline>
          ) : headlineOf(preflight) === "changedElsewhere" ? (
            <Headline tone="warning">{t("changedElsewhere")}</Headline>
          ) : headlineOf(preflight) === "busy" ? (
            <Headline tone="warning">{t("busy")}</Headline>
          ) : (
            <Headline tone="warning">{t("blocked")}</Headline>
          )}
          <AgentResults result={preflight} phase="review" />
        </>
      )}
    </div>
  )
}

/**
 * What a save came to, agent by agent. "Saved" heads it only when every
 * agent's part went through.
 */
export function McpResults({ flow }: { flow: McpFlow }) {
  const t = useTranslations("Harness.mcp.plan")
  const result = flow.result
  if (!result) {
    return (
      <div className="min-w-0 space-y-3" role="status">
        <FailureHeadline flow={flow} />
      </div>
    )
  }
  const headline = headlineOf(result)
  return (
    <div role="status" className="min-w-0 space-y-3">
      {headline === "saved" ? (
        <Headline tone="fine">{t("saved")}</Headline>
      ) : headline === "busy" ? (
        <Headline tone="warning">{t("busySave")}</Headline>
      ) : headline === "writeFailed" ? (
        <Headline tone="warning">{t("writeFailed")}</Headline>
      ) : headline === "changedElsewhere" ? (
        <Headline tone="warning">{t("changedElsewhere")}</Headline>
      ) : headline === "unknown" ? (
        <Headline tone="warning">{t("unknownOutcome")}</Headline>
      ) : (
        <Headline tone="warning">{t("notSaved")}</Headline>
      )}
      <AgentResults result={result} phase="result" />
    </div>
  )
}
