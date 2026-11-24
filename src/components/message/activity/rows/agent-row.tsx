"use client"

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"
import { BotIcon } from "lucide-react"

import { MessageResponse } from "@/components/ai-elements/message"
import { useTruncation } from "@/hooks/use-truncation"
import { buildActivity } from "@/lib/activity/build-activity"
import { describeToolCall } from "@/lib/activity/describe-tool-call"
import { cleanTitle, tallySteps } from "@/lib/activity/progress"
import { previewLine } from "@/lib/activity/format"
import type { StepStatus } from "@/lib/activity/types"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { shortAgentId } from "@/lib/collab-tool"
import { unwrapWholeFence } from "@/lib/fenced-text"
import { cn } from "@/lib/utils"
import { SubagentSessionDialog } from "../../subagent-session-dialog"
import { useAgentCallModel } from "../../use-agent-call-model"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { useFoldRow } from "../fold-back"
import { ProgressLine } from "../progress-line"
import { RailIcon } from "../rail-icon"
import { StatusFigure, useStatusText } from "../step-visuals"
import {
  formatClock,
  LIVE_CLOCK_AFTER_MS,
  useLiveElapsed,
} from "../use-live-elapsed"
import type { ToolStep } from "./explore-rows"

/** Longest result line shown under a finished sub-agent. */
const RESULT_PREVIEW_CHARS = 240

/**
 * A sub-agent the turn launched (Claude Code's Agent/Task, codex's spawned
 * agents, Grok's sub-agents): `Explore  Find binding consumers  Find every
 * consumer of…   48s` — the prompt it was handed on the title line — and,
 * while it runs, its latest step (a skeleton until it has one), or once done
 * the first line of its result, beside "Open conversation ↗" when it has a
 * session of its own. The panel holds the full prompt, the sub-agent's own
 * steps as a nested timeline, and its result.
 */
export const AgentRow = memo(function AgentRow({ step }: { step: ToolStep }) {
  const t = useTranslations("Folder.chat.contentParts")
  const tActivity = useTranslations("Folder.chat.activity")
  const tBg = useTranslations("Folder.chat.backgroundTasks")
  const statusText = useStatusText()
  const { renderNested, pinnedOnly } = useActivityRender()
  const m = useAgentCallModel(step.part)
  const live = m.isRunning || m.isLiveBackgroundLaunch || m.outcomeBackground
  const failed = m.isError || m.backgroundFailed || m.outcomeError != null
  // A codex native sub-agent's card settles when codex acknowledges the
  // launch, not when the child ends; how it ended arrives (if ever) as a
  // separate state. An interrupted one is drawn as interrupted.
  const codexInterrupted =
    m.isCodexSubagent && m.codexSubagentState === "interrupted"
  // …and until codex says, the panel explains why the outcome is unknown.
  const launchCaveat =
    m.isCodexSubagent && !m.isRunning && m.codexSubagentState === null
  const status: StepStatus = live
    ? "running"
    : failed
      ? "failed"
      : codexInterrupted
        ? "cancelled"
        : "succeeded"
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force: failed,
  })
  const foldRow = useFoldRow()
  const elapsed = useLiveElapsed(step.key, live)
  const clock =
    elapsed !== null && elapsed >= LIVE_CLOCK_AFTER_MS
      ? formatClock(elapsed)
      : null

  // The sub-agent's own steps, as a timeline: its transcript in arrival order
  // when there is prose to interleave, else its tool calls alone.
  const childModel = useMemo(() => {
    const parts: AdaptedContentPart[] = []
    if (m.hasTimeline) {
      m.transcript.forEach((entry, at) => {
        if (entry.type === "tool_call") {
          const call = m.adaptedToolCalls[entry.childIndex]
          if (call) parts.push(call)
        } else if (entry.type === "thinking") {
          if (entry.text.trim()) {
            parts.push({
              type: "reasoning",
              content: entry.text,
              isStreaming: m.isRunning && at === m.transcript.length - 1,
            })
          }
        } else if (entry.text.trim()) {
          parts.push({ type: "text", text: entry.text })
        }
      })
    } else {
      parts.push(...m.adaptedToolCalls)
    }
    return parts.length > 0
      ? buildActivity(parts, { isStreaming: m.isRunning, keepAnswer: true })
      : null
  }, [m.hasTimeline, m.transcript, m.adaptedToolCalls, m.isRunning])

  // Its finished steps, one segment each, from the calls it recorded.
  const progress = useMemo(
    () =>
      tallySteps(
        m.adaptedToolCalls.map((call) => {
          const tool = describeToolCall(call)
          return {
            mark:
              tool.status === "succeeded"
                ? ("ok" as const)
                : tool.status === "failed" || tool.status === "rejected"
                  ? ("failed" as const)
                  : null,
            title:
              cleanTitle(tool.command?.display) ??
              cleanTitle(tool.target?.text) ??
              tool.toolName,
          }
        })
      ),
    [m.adaptedToolCalls]
  )

  // A background launch's lifecycle marker stands for its output: the result
  // it settled with, or none — never the marker itself, which is what
  // `part.output` holds then. A settle may carry no result at all (OpenCode's,
  // for a sub-agent that ended without writing a reply).
  const output = m.backgroundLifecycle
    ? m.backgroundLifecycle.result
    : ((m.taskOutcome || m.isLiveBackgroundLaunch ? null : step.part.output) ??
      null)
  const latest = live
    ? (m.grokProgressLine ??
      (m.hasTimeline
        ? previewLine(
            [...m.transcript].reverse().find((e) => e.type !== "tool_call")
              ?.text,
            RESULT_PREVIEW_CHARS
          )
        : null))
    : null
  const summaryLine = live
    ? latest
    : failed
      ? null
      : previewLine(
          output ?? m.backgroundLifecycle?.summary,
          RESULT_PREVIEW_CHARS
        )
  const prompt = m.prompt?.trim() || null
  // The prompt on the title line, as one line; on its own it opens the row
  // only when that line cuts it short.
  const promptLine = prompt?.replace(/\s+/g, " ") ?? null
  const { ref: promptRef, truncated: promptCut } =
    useTruncation<HTMLSpanElement>(promptLine)

  if (pinnedOnly && !live) return null

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
        expandable={
          (promptLine !== null && (promptCut || open)) ||
          !!m.model ||
          !!m.effort ||
          !!childModel ||
          !!output ||
          failed ||
          launchCaveat ||
          !!m.backgroundLifecycle
        }
        expanded={open}
        onExpandedChange={setOpen}
        title={m.title}
        trailing={
          failed ? (
            m.backgroundFailed && m.backgroundLifecycle?.status ? (
              <span className="text-tone-danger">
                {m.backgroundLifecycle.status}
              </span>
            ) : (
              <StatusFigure status="failed" />
            )
          ) : live ? (
            m.isLiveBackgroundLaunch || m.outcomeBackground ? (
              tBg("cardRunning")
            ) : clock ? (
              <span aria-hidden="true">{clock}</span>
            ) : null
          ) : m.isCodexSubagent ? (
            // Never a quiet "done" for a launch codex has not reported on.
            m.codexSubagentState === "completed" ? (
              tActivity("metric.done")
            ) : codexInterrupted ? (
              <StatusFigure status="cancelled" />
            ) : (
              tActivity("metric.outcomeUnknown")
            )
          ) : m.backgroundLifecycle && !m.backgroundSettled ? (
            // Launched; its result has not come back yet.
            tActivity("metric.launched")
          ) : m.backgroundLifecycle?.interim ? (
            // It said it will report again: what it sent is not final.
            tActivity("metric.interim")
          ) : (
            m.durationSuffix
          )
        }
        addon={
          <ProgressLine
            progress={progress}
            working={live}
            summary={summaryLine}
            summaryLive={live}
            onOpenSession={m.openChildSession}
          />
        }
        detail={() => (
          <div className="space-y-2">
            {m.model || m.effort ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {m.model ? (
                  <span>
                    {t("agentModelLabel")}:{" "}
                    <span className="font-mono">{m.model}</span>
                  </span>
                ) : null}
                {m.effort ? (
                  <span>
                    {t("agentEffortLabel")}:{" "}
                    <span className="font-mono">{m.effort}</span>
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
            {childModel
              ? renderNested(childModel, m.isRunning, {
                  working: m.isRunning,
                  what:
                    childModel.summary.steps > 0
                      ? tActivity("header.steps", {
                          count: childModel.summary.steps,
                        })
                      : tActivity("kind.agent"),
                  onFold: (control) => foldRow(control, () => setOpen(false)),
                })
              : null}
            {launchCaveat ? (
              <p className="text-xs text-muted-foreground">
                {t("agentCodexLaunchOnly")}
              </p>
            ) : null}
            {m.isError && step.part.errorText ? (
              <DetailBox tone="danger" anchor="end">
                <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem]">
                  {unwrapWholeFence(step.part.errorText)}
                </pre>
              </DetailBox>
            ) : null}
            {m.isError &&
            m.agentStats?.status === "completed" &&
            m.agentStats.recovered_result ? (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {t("agentRecoveredNote")}
                </p>
                <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                  <MessageResponse>
                    {m.agentStats.recovered_result}
                  </MessageResponse>
                </div>
              </div>
            ) : null}
            {m.outcomeError && !m.isError ? (
              <DetailBox tone="danger">
                <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem]">
                  {m.outcomeError}
                </pre>
              </DetailBox>
            ) : null}
            {m.backgroundLifecycle && !m.isError && !m.backgroundSettled ? (
              <p className="text-xs text-muted-foreground">
                {tBg("cardResultPending")}
              </p>
            ) : null}
            {/* What its notification said about how it ended — for an interim
                result, why it is not final. */}
            {m.backgroundLifecycle?.summary && !m.isError ? (
              <p dir="auto" className="text-xs text-muted-foreground">
                {m.backgroundLifecycle.summary}
              </p>
            ) : null}
            {output && !m.isError ? (
              <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&_ol]:list-inside [&_ul]:list-inside">
                <MessageResponse>{output}</MessageResponse>
              </div>
            ) : null}
          </div>
        )}
      >
        {/* The type and description are its title, the grey prompt after
            them what it was handed — in whatever room the title leaves (it
            is all in the panel); nothing runs past the line's end. */}
        <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
          {m.subagentType ? (
            <>
              <span className="shrink-0 font-semibold text-foreground">
                {m.subagentType}
              </span>
              {m.description ? (
                <span className="min-w-0 truncate text-foreground" dir="auto">
                  {m.description}
                </span>
              ) : null}
            </>
          ) : (
            <span
              dir="auto"
              className={cn(
                "min-w-0 truncate font-semibold",
                live && !m.description ? "activity-shimmer" : "text-foreground"
              )}
            >
              {m.title}
            </span>
          )}
          {m.agentId ? (
            <span
              className="shrink-0 font-mono text-[0.8125rem] text-activity-secondary"
              dir="ltr"
            >
              #{shortAgentId(m.agentId)}
            </span>
          ) : null}
          {promptLine ? (
            <span
              ref={promptRef}
              dir="auto"
              className="min-w-0 flex-1 truncate text-activity-secondary"
            >
              {promptLine}
            </span>
          ) : null}
        </span>
      </ActivityRow>
      {m.childSession && m.viewerHost == null && m.sessionOpen ? (
        <SubagentSessionDialog
          open={m.sessionOpen}
          onOpenChange={m.setSessionOpen}
          sessionId={m.childSession.sessionId}
          agentType={m.childSession.agentType}
          subagentType={m.subagentType}
          description={m.description}
          live={m.isRunning || m.isLiveBackgroundLaunch}
        />
      ) : null}
    </>
  )
})
