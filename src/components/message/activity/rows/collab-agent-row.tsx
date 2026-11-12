"use client"

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BotIcon } from "lucide-react"

import { MessageResponse } from "@/components/ai-elements/message"
import { previewLine } from "@/lib/activity/format"
import type { StepStatus } from "@/lib/activity/types"
import {
  classifyCollabOp,
  classifyCollabStatus,
  isCodexThreadId,
  isErrorCollabStatusKind,
  parseCollabToolInput,
  shortAgentId,
} from "@/lib/collab-tool"
import { unwrapWholeFence } from "@/lib/fenced-text"
import { cn } from "@/lib/utils"
import { SubagentSessionDialog } from "../../subagent-session-dialog"
import { useSessionViewerHost } from "../../session-viewer-host"
import { ActivityRow } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { ProgressLine } from "../progress-line"
import { RailIcon } from "../rail-icon"
import { StatusFigure, useStatusText } from "../step-visuals"
import type { ToolStep } from "./explore-rows"

/** Longest result line shown under a finished op. */
const RESULT_PREVIEW_CHARS = 240

/**
 * One of codex's live collab sub-agent ops (`collabAgentToolCall`: spawn,
 * wait, close, resume, list — see `@/lib/collab-tool`): `Starting sub-agent
 * #1a2b3c4d  Build the app…` — the op, the child's id, the task it was handed —
 * and under it the first line of what the child sent back, beside "Open
 * conversation ↗" when the op names exactly one child (its thread id IS its
 * rollout, the one live way to its actual work). The panel holds the model it
 * runs on (a spawn's only), the full task, the children's messages and any
 * error.
 */
export const CollabAgentRow = memo(function CollabAgentRow({
  step,
}: {
  step: ToolStep
}) {
  const t = useTranslations("Folder.chat.collabAgent")
  const tcp = useTranslations("Folder.chat.contentParts")
  const tActivity = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { part } = step

  const info = useMemo(() => parseCollabToolInput(part.input), [part.input])
  const agents = useMemo(() => info?.agents ?? [], [info])
  const op = classifyCollabOp(info?.op ?? null)
  const prompt = info?.prompt?.trim() || null
  // How the child runs belongs to its launch. The reconstructed `wait` on
  // reload carries neither, so a live one must not show them either.
  const model = op === "spawn" ? (info?.model ?? null) : null
  const effort = op === "spawn" ? (info?.reasoningEffort ?? null) : null

  const errorText = part.errorText?.trim() || null
  // Collab calls carry no output: a failed op shows only in its `status`.
  const isError =
    part.state === "output-error" ||
    !!errorText ||
    agents.some((a) =>
      isErrorCollabStatusKind(classifyCollabStatus(a.status))
    ) ||
    isErrorCollabStatusKind(classifyCollabStatus(info?.status ?? null))
  const isRunning =
    part.state === "input-streaming" || part.state === "input-available"
  const interrupted = agents.some(
    (a) => classifyCollabStatus(a.status) === "interrupted"
  )
  const status: StepStatus = isRunning
    ? "running"
    : isError
      ? "failed"
      : interrupted
        ? "cancelled"
        : "succeeded"

  const label = (() => {
    switch (op) {
      case "spawn":
        return t("opSpawn")
      case "wait":
        return t("opWait")
      case "close":
        return t("opClose")
      case "resume":
        return t("opResume")
      case "list":
        return t("opList")
      default:
        return t("title")
    }
  })()
  const idBadge =
    agents.length === 0
      ? null
      : agents.length > 1
        ? `${shortAgentId(agents[0]!.threadId)} +${agents.length - 1}`
        : shortAgentId(agents[0]!.threadId)
  const messages = agents.filter((a) => a.message?.trim())
  const summary = isError
    ? null
    : previewLine(messages[0]?.message, RESULT_PREVIEW_CHARS)
  const promptLine = prompt?.replace(/\s+/g, " ") ?? null

  // One child only: with several, one link would pick one and drop the rest.
  // `isCodexThreadId` leaves out `list_agents`' name-keyed roster.
  const childId =
    agents.length === 1 && isCodexThreadId(agents[0]!.threadId)
      ? agents[0]!.threadId
      : null
  const viewerHost = useSessionViewerHost()
  const [sessionOpen, setSessionOpen] = useState(false)
  const openChildSession = childId
    ? () =>
        viewerHost
          ? viewerHost.open({
              kind: "agentSession",
              sessionId: childId,
              agentType: "codex",
              subagentType: null,
              description: null,
              // Keep re-reading the child's transcript until the op settles.
              live: isRunning,
            })
          : setSessionOpen(true)
    : null

  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force: isError,
  })
  const expandable =
    !!prompt ||
    !!model ||
    !!effort ||
    messages.length > 0 ||
    (isError && !!errorText)

  return (
    <>
      <ActivityRow
        stepKey={step.key}
        approval={step.tool.approval}
        status={status}
        marker={
          <RailIcon
            icon={BotIcon}
            status={status}
            label={`${tActivity("kind.agent")}, ${statusText(status)}`}
          />
        }
        expandable={expandable}
        expanded={open}
        onExpandedChange={setOpen}
        title={promptLine ? `${label} ${promptLine}` : label}
        trailing={
          status === "failed" || status === "cancelled" ? (
            <StatusFigure status={status} />
          ) : null
        }
        addon={
          <ProgressLine
            progress={null}
            working={false}
            summary={summary}
            summaryLive={isRunning}
            onOpenSession={openChildSession}
          />
        }
        detail={() => (
          <div className="space-y-2">
            {model || effort ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {model ? (
                  <span>
                    {tcp("agentModelLabel")}:{" "}
                    <span className="font-mono">{model}</span>
                  </span>
                ) : null}
                {effort ? (
                  <span>
                    {tcp("agentEffortLabel")}:{" "}
                    <span className="font-mono">{effort}</span>
                  </span>
                ) : null}
              </div>
            ) : null}
            {prompt ? (
              <DetailBox tone="neutral">
                <div className="prose prose-sm dark:prose-invert max-w-none px-4 py-3 text-sm [&_ol]:list-inside [&_ul]:list-inside">
                  <MessageResponse>{prompt}</MessageResponse>
                </div>
              </DetailBox>
            ) : null}
            {messages.map((agent) => (
              <div
                key={agent.threadId}
                className="prose prose-sm dark:prose-invert max-w-none text-sm [&_ol]:list-inside [&_ul]:list-inside"
              >
                <MessageResponse>{agent.message!}</MessageResponse>
              </div>
            ))}
            {isError && errorText ? (
              <DetailBox tone="danger" anchor="end">
                <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem]">
                  {unwrapWholeFence(errorText)}
                </pre>
              </DetailBox>
            ) : null}
          </div>
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
          <span
            className={cn(
              "shrink-0 font-semibold",
              isRunning ? "activity-shimmer" : "text-foreground"
            )}
          >
            {label}
          </span>
          {idBadge ? (
            <span
              className="shrink-0 font-mono text-[0.8125rem] text-activity-secondary"
              dir="ltr"
            >
              #{idBadge}
            </span>
          ) : null}
          {promptLine ? (
            <span
              dir="auto"
              className="min-w-0 flex-1 truncate text-activity-secondary"
            >
              {promptLine}
            </span>
          ) : null}
        </span>
      </ActivityRow>
      {childId && viewerHost == null && sessionOpen ? (
        <SubagentSessionDialog
          open={sessionOpen}
          onOpenChange={setSessionOpen}
          sessionId={childId}
          agentType="codex"
          subagentType={null}
          description={null}
          live={isRunning}
        />
      ) : null}
    </>
  )
})
