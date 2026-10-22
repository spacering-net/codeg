"use client"

/**
 * Inline card for the codeg-mcp *workbench* companion tools — `get_session_info`,
 * `task_progress`, `task_complete`, `create_automation`, `create_work_task` and
 * `resume_delegation`.
 *
 * One collapsed line framed around what the agent was actually doing ("读取会话
 * #2122", "进度：tests passing", "任务完成 · 成功"), with a status badge and an
 * inline expansion for the result text — for a work-task report, the whole
 * report plus what the board did with it. Deliberately the same shape and visual
 * language as `DelegationStatusCard` / `DelegationStatusRow` so every codeg-mcp
 * companion reads as one family in the transcript instead of these five landing
 * on the generic tool shell as a raw `{"message": "…"}` argument dump.
 *
 * Parsing lives in `@/lib/codeg-mcp-tool` — it handles the per-host argument
 * wrapping and result envelopes, so this component is presentation-only.
 */

import { useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  BookOpen,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheckBig,
  ClipboardList,
  RotateCcw,
  Signpost,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  parseCodegMcpToolCall,
  type CodegMcpWorkbenchTool,
  type TaskReportAck,
} from "@/lib/codeg-mcp-tool"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import { MessageResponse } from "@/components/ai-elements/message"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { StatusBadge } from "@/components/message/delegation-status-badge"

interface Props {
  /** Canonical tool name — selects the label, icon and argument to state. */
  tool: CodegMcpWorkbenchTool
  /** Raw JSON arguments the agent sent to the tool. */
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
}

const ICONS: Record<CodegMcpWorkbenchTool, typeof BookOpen> = {
  get_session_info: BookOpen,
  task_progress: Signpost,
  task_complete: CircleCheckBig,
  create_automation: CalendarClock,
  create_work_task: ClipboardList,
  resume_delegation: RotateCcw,
}

/** The panel's Markdown blocks: the report and the result share one look. */
const MARKDOWN_BLOCK =
  'max-h-80 overflow-auto prose prose-sm max-w-none break-words text-xs dark:prose-invert [&_ol]:list-inside [&_ul]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'

/**
 * What the board did with a work-task report, in the reader's words, where the
 * transcript only has `{"recorded":true}`. A refusal keeps the companion's own
 * reason: it is the only account of why the report went nowhere.
 */
function TaskAckLine({ ack }: { ack: TaskReportAck }) {
  const t = useTranslations("Folder.chat.codegMcpTool")
  if (ack.recorded) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Check className="h-3.5 w-3.5 shrink-0" />
        <span>{t("ackRecorded")}</span>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
      <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        {ack.note
          ? t("ackNotRecordedWithReason", { reason: ack.note })
          : t("ackNotRecorded")}
      </span>
    </div>
  )
}

export function CodegMcpToolCard({
  tool,
  input,
  output,
  errorText,
  state,
}: Props) {
  const t = useTranslations("Folder.chat.codegMcpTool")
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()

  const model = useMemo(
    () => parseCodegMcpToolCall({ tool, input, output, errorText, state }),
    [tool, input, output, errorText, state]
  )

  const label = useMemo(() => {
    switch (tool) {
      case "get_session_info":
        return model.detail
          ? t("getSessionInfo", { session: `#${model.detail}` })
          : t("getSessionInfoNoId")
      case "task_progress":
        return model.detail
          ? t("taskProgress", { message: model.detail })
          : t("taskProgressNoMessage")
      case "task_complete": {
        // The verdict is the headline; the summary rides along when the agent
        // supplied one (it is optional in the schema).
        const verdict = model.verdict
          ? t(`verdict.${model.verdict}`)
          : t("verdict.unknown")
        return model.detail
          ? t("taskCompleteWithSummary", { verdict, summary: model.detail })
          : t("taskComplete", { verdict })
      }
      case "create_automation":
        return model.detail
          ? t("createAutomation", { name: model.detail })
          : t("createAutomationNoName")
      case "create_work_task":
        return model.detail
          ? t("createWorkTask", { title: model.detail })
          : t("createWorkTaskNoTitle")
      case "resume_delegation":
        return model.detail
          ? t("resumeDelegation", { task: model.detail })
          : t("resumeDelegationNoId")
    }
  }, [t, tool, model])

  const Icon = ICONS[tool]
  const isError = model.status === "err"
  const isRunning = model.status === "running"
  const resultText = model.resultText?.trim() ?? ""
  const prompt = model.prompt?.trim() ?? ""
  // The progress message / completion summary, which the row cuts off at one
  // line — the panel is where it can be read whole.
  const report =
    tool === "task_progress" || tool === "task_complete"
      ? (model.detail ?? "")
      : ""
  const ack = model.ack
  // A still-running call has nothing to reveal yet, except what it was sent:
  // an authoring call's prompt is worth auditing and a work-task report is
  // worth reading in full, and both arrive with the arguments, long before any
  // result. Past that, anything that came back is worth a look.
  const expandable =
    resultText !== "" || prompt !== "" || report !== "" || ack !== null

  const row = (
    <>
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          isError ? "text-destructive" : "text-muted-foreground"
        )}
      />
      {/* `title` restores the full text on hover: a long progress message or
          task summary is CSS-truncated here, and the panel below has to be
          opened to read it. */}
      <span
        title={label}
        className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
      >
        {isRunning ? (
          <Shimmer as="span" duration={1} shineColor="var(--primary)">
            {label}
          </Shimmer>
        ) : (
          label
        )}
      </span>
      <StatusBadge status={model.status} />
      {expandable &&
        (expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ))}
    </>
  )

  return (
    <div
      data-testid="codeg-mcp-tool-card"
      data-tool={tool}
      className={cn(
        "overflow-hidden rounded-lg border text-xs ws-msg-card",
        isError
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-card"
      )}
    >
      {expandable ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          // Only reference the panel while it is mounted — it is kept out of the
          // collapsed tree so the Markdown renderer isn't paid for unopened rows.
          aria-controls={expanded ? panelId : undefined}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
        >
          {row}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-3 py-2">{row}</div>
      )}
      {expandable && expanded && (
        <div
          id={panelId}
          className="flex flex-col gap-2 border-t border-border px-3 py-2"
        >
          {/* The instruction the automation / board task will run. Shown as
              plain pre-wrapped text, NOT Markdown: it is an argument the user
              is auditing, so it must read exactly as it was sent. */}
          {prompt !== "" && (
            <div>
              <div className="mb-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("promptLabel")}
              </div>
              <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 text-xs text-foreground/90">
                {prompt}
              </div>
            </div>
          )}
          {/* The report through the chat's Markdown renderer, as the task
              drawer shows the same summary: the agent writes it the way it
              writes anything else — `code`, bullets, bold. */}
          {report !== "" && (
            <div className={MARKDOWN_BLOCK}>
              <MessageResponse>{report}</MessageResponse>
            </div>
          )}
          {ack && <TaskAckLine ack={ack} />}
          {resultText !== "" && (
            <div className={MARKDOWN_BLOCK}>
              <MessageResponse>{resultText}</MessageResponse>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
