"use client"

import type { ReactNode } from "react"
import { Check, MinusCircle, PlusCircle } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  bulkPlanForDialog,
  closeDialog,
  isAgentBusy,
  MCP_BUSY,
  reviewDialog,
  type McpBulkDialog as McpBulkDialogState,
} from "@/lib/harness/mcp-state"
import type { McpBulkSkipReason } from "@/lib/mcp/bulk"
import type { McpModel } from "@/lib/mcp/model"
import { agentsOf } from "@/lib/mcp/ops"
import { Code } from "../discover/detail-sections"
import { DiscoverMark } from "../discover/discover-card"
import { MachineText } from "../machine-text"
import { AgentGlyph } from "./mcp-bits"
import { useFlowParts } from "./mcp-change-dialogs"
import { McpDialogFrame } from "./mcp-dialog-frame"
import { useMcpLabels } from "./use-mcp-labels"

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

function useSkipReasonText() {
  const t = useTranslations("Harness.mcp.bulk.skip")
  const labels = useMcpLabels()
  return (reason: McpBulkSkipReason): string => {
    switch (reason.kind) {
      case "unsupportedTransport":
        return t("unsupportedTransport", {
          transport: labels.transport(reason.transport),
        })
      default:
        return t(reason.kind)
    }
  }
}

/**
 * Cross-agent compatible bulk allocation modal (#884).
 *
 * Previews three buckets — will apply, already active/off, and skipped with
 * exact reasons — before running the standard `mcpApply({ preflight: true })`
 * review and atomic commit flow via {@link useFlowParts}.
 */
export function McpBulkDialog({
  dialog,
  model,
}: {
  dialog: McpBulkDialogState
  model: McpModel | null
}) {
  const t = useTranslations("Harness.mcp.bulk")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const labels = useMcpLabels()
  const skipReasonText = useSkipReasonText()
  const { slots } = useHarnessView()
  const [busy] = useHarnessSlot(MCP_BUSY)

  const plan = model ? bulkPlanForDialog(dialog, model) : null
  const ops = plan ? plan.ops.map((item) => item.op) : []
  const planBusy = agentsOf(ops).some((agent) => isAgentBusy(busy, agent))
  const close = () => closeDialog(slots, dialog.id)

  const title =
    dialog.mode === "server_enable"
      ? t.rich("enableServerTitle", { key: dialog.serverKey, code })
      : dialog.mode === "server_disable"
        ? t.rich("disableServerTitle", { key: dialog.serverKey, code })
        : t("enableAgentTitle", { agent: labels.agent(dialog.agent) })

  const description =
    dialog.mode === "server_enable"
      ? t("enableServerDescription")
      : dialog.mode === "server_disable"
        ? t("disableServerDescription")
        : t("enableAgentDescription", { agent: labels.agent(dialog.agent) })

  const input = !plan ? (
    <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
  ) : (
    <div className="min-w-0 space-y-4 text-sm">
      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          <PlusCircle aria-hidden="true" className="size-3.5" />
          {plan.mode === "server_disable"
            ? t("sectionWillDisable", { count: plan.ops.length })
            : t("sectionWillApply", { count: plan.ops.length })}
        </h3>
        {plan.ops.length === 0 ? (
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {t("nothingToDo")}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {plan.mode === "agent_enable"
              ? plan.ops.map((item) => (
                  <li
                    key={item.serverKey}
                    className="flex min-w-0 items-center justify-between gap-2 px-3 py-2 text-xs"
                  >
                    <bdi dir="ltr" className="min-w-0 truncate font-mono">
                      <MachineText>{item.serverKey}</MachineText>
                    </bdi>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-muted-foreground">
                        {labels.transport(item.definition.type)}
                      </span>
                      <DiscoverMark size="sm" tone="info">
                        {t(`effect.${item.effect}`)}
                      </DiscoverMark>
                    </div>
                  </li>
                ))
              : plan.ops.map((item) => {
                  const isPause =
                    item.effect === "disable" &&
                    model?.agent(item.agent)?.disableMode === "codeg_pause"
                  return (
                    <li
                      key={item.agent}
                      className="flex min-w-0 items-center justify-between gap-2 px-3 py-2 text-xs"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <AgentGlyph agent={item.agent} />
                        <span className="truncate font-medium">
                          {labels.agent(item.agent)}
                        </span>
                      </span>
                      <DiscoverMark
                        size="sm"
                        tone={item.effect === "disable" ? "warning" : "info"}
                      >
                        {isPause
                          ? t("effect.pause")
                          : t(`effect.${item.effect}`)}
                      </DiscoverMark>
                    </li>
                  )
                })}
          </ul>
        )}
      </section>

      {plan.alreadyActive.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <Check aria-hidden="true" className="size-3.5" />
            {plan.mode === "server_disable"
              ? t("sectionAlreadyOff", { count: plan.alreadyActive.length })
              : t("sectionAlreadyActive", { count: plan.alreadyActive.length })}
          </h3>
          <div className="flex flex-wrap gap-1.5 rounded-lg border bg-muted/20 px-3 py-2">
            {plan.alreadyActive.map((item) => (
              <DiscoverMark key={item} size="sm">
                {plan.mode === "agent_enable" ? item : labels.agent(item)}
              </DiscoverMark>
            ))}
          </div>
        </section>
      )}

      {plan.skipped.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <MinusCircle aria-hidden="true" className="size-3.5" />
            {t("sectionSkipped", { count: plan.skipped.length })}
          </h3>
          <ul className="divide-y rounded-lg border bg-muted/20">
            {plan.mode === "agent_enable"
              ? plan.skipped.map((item) => (
                  <li
                    key={item.serverKey}
                    className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-xs"
                  >
                    <bdi dir="ltr" className="font-mono text-foreground">
                      <MachineText>{item.serverKey}</MachineText>
                    </bdi>
                    <span className="text-muted-foreground">
                      {skipReasonText(item.reason)}
                    </span>
                  </li>
                ))
              : plan.skipped.map((item) => (
                  <li
                    key={item.agent}
                    className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <AgentGlyph agent={item.agent} />
                      <span className="font-medium text-foreground">
                        {labels.agent(item.agent)}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      {skipReasonText(item.reason)}
                    </span>
                  </li>
                ))}
          </ul>
        </section>
      )}
    </div>
  )

  const inputFooter = (
    <>
      <Button type="button" variant="outline" onClick={close}>
        {tDialog("cancel")}
      </Button>
      <Button
        type="button"
        disabled={!plan || plan.ops.length === 0 || planBusy}
        onClick={() => void reviewDialog(slots, dialog.id)}
      >
        {tDialog("review")}
      </Button>
    </>
  )

  const { body, footer } = useFlowParts(
    dialog.id,
    dialog.flow,
    input,
    inputFooter
  )

  return (
    <McpDialogFrame
      title={title}
      description={dialog.flow.step === "input" ? description : undefined}
      onRequestClose={() => {
        if (dialog.flow.step !== "saving") close()
      }}
      footer={footer}
    >
      {body}
    </McpDialogFrame>
  )
}
