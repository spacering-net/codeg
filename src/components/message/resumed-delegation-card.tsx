"use client"

/**
 * Inline card for `resume_delegation` — the sub-agent that came BACK.
 *
 * A resume is only ever about one thing: which interrupted sub-agent is
 * running again. So this card IS the delegation card (`DelegationCardRow`,
 * shared with `DelegatedSubThread`), wearing a ⟳ marker, rather than a second
 * card stating a task id above it.
 *
 * That merge is also what makes live and history agree. Live, the broker's
 * running-meta write goes to the ORIGINAL `delegate_to_agent` call's
 * tool_use_id (`broker.rs::resume_delegation_gated`) — a call from an earlier
 * turn — so nothing in THIS turn ever carried the sub-agent. It only looked
 * like it did because that write used to mint a phantom tool call in the
 * current turn, which the transcript rendered as a full delegation card and
 * then lost on reload. With the phantom gone (see
 * `meta_writer.rs::write_meta`), this card is the single place the resumed
 * sub-agent appears — identically in both.
 *
 * Model resolution (`useDelegationCardModel`, via `taskIdHint`):
 *   - LIVE: the `delegation_started` the resume re-emits creates a binding,
 *     found here by task id (the resume call's own id is not a binding key).
 *     Status tracks the child from running to done/failed, and badges
 *     "waiting" when it parks on a permission prompt.
 *   - HISTORY: the persisted report carries `agent_type` /
 *     `child_conversation_id`, and `inject_delegation_meta` overlays the
 *     child's CURRENT status + task text from its DB row.
 *
 * `input` is deliberately NOT forwarded to the model: a resume's arguments are
 * `{task_id, reason}`, which carry none of the `task` / `agent_type` /
 * `working_dir` that `parseInput` looks for — handing them over would only
 * trip its "unrecognized wire shape" warning on every render.
 *
 * Renders `fallback` when no sub-agent resolves — a REFUSED resume
 * (`not_resumable`, unknown task) has none, and the caller passes
 * `CodegMcpToolCard`, which states the refusal reason.
 */

import { useMemo, useState, type ReactNode } from "react"
import { RotateCcw } from "lucide-react"
import { useTranslations } from "next-intl"

import { parseCodegMcpToolCall } from "@/lib/codeg-mcp-tool"
import { isRefusedResume } from "@/lib/delegation-card"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import { DelegationCardRow } from "@/components/message/delegation-card-row"
import { SubAgentSessionDialog } from "@/components/message/sub-agent-session-dialog"
import { useSessionViewerHost } from "@/components/message/session-viewer-host"
import { useDelegationCardModel } from "@/hooks/use-delegation-card-model"

interface Props {
  /** This `resume_delegation` call's own tool_call_id. */
  toolCallId: string
  /** Raw JSON arguments: `{ task_id, reason? }`. */
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
  meta?: Record<string, unknown> | null
  /** Rendered instead of the card when the resume named no sub-agent. */
  fallback?: ReactNode
}

export function ResumedDelegationCard({
  toolCallId,
  input,
  output,
  errorText,
  state,
  meta,
  fallback = null,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")
  const viewerHost = useSessionViewerHost()
  const [dialogOpen, setDialogOpen] = useState(false)

  // The resume call's own arguments + result text. `detail` is the `task_id`
  // argument — the key everything else is resolved by.
  const call = useMemo(
    () =>
      parseCodegMcpToolCall({
        tool: "resume_delegation",
        input,
        output,
        errorText,
        state,
      }),
    [input, output, errorText, state]
  )

  const source = useMemo(
    () => ({
      parentToolUseId: toolCallId,
      taskIdHint: call.detail,
      output,
      errorText,
      state,
      meta,
    }),
    [toolCallId, call.detail, output, errorText, state, meta]
  )

  const {
    identity,
    task,
    taskId,
    status,
    errorCode,
    childConversationId,
    childConnectionId,
    hasModel,
  } = useDelegationCardModel(source)

  // Placed AFTER every hook so hook order stays stable.
  //
  // A REFUSAL is not a resumed sub-agent, however much it looks like one: the
  // broker answers "Not resumed: …" with the task's real status AND its
  // `agent_type` / `child_conversation_id`, which is enough to satisfy
  // `hasModel`. Drawing the card here would assert — corner marker and all —
  // that a sub-agent was revived when it was not, and would bury the refusal
  // reason, the single thing the user has to read. `CodegMcpToolCard` states
  // it plainly.
  if (!hasModel || isRefusedResume(output, errorText)) {
    return <>{fallback}</>
  }

  // The row's panel holds the task in full (as on every delegation card), and
  // a resume adds the one thing of its own worth expanding to: the
  // interruption context. The report's own text is deliberately dropped: it is
  // an instruction addressed to the LLM ("Delegation resumed. task_id=… Call
  // get_delegation_status with this id …") whose every fact — which agent,
  // which task, which id, what state — the collapsed row already states, in
  // the reader's language.
  const reason = call.reason?.trim() ?? ""

  return (
    <div
      data-testid="resumed-delegation-card"
      className="@container/delegcard overflow-hidden rounded-lg border border-border bg-card ws-msg-card"
    >
      <DelegationCardRow
        identity={identity}
        taskId={taskId}
        status={status}
        errorCode={errorCode}
        task={task}
        detail={
          reason !== "" ? (
            // The interruption context the LLM passed into the child's
            // continuation prompt. Plain pre-wrapped text, NOT Markdown: it is
            // an argument being audited, so it must read exactly as sent.
            <div className="px-3 py-2">
              <div className="mb-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("resumeReasonLabel")}
              </div>
              {/* In its own direction, like the task above it. */}
              <div
                dir="auto"
                className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 text-xs text-foreground/90"
              >
                {reason}
              </div>
            </div>
          ) : undefined
        }
        avatarBadge={
          <span
            className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background"
            title={t("resumed")}
          >
            <RotateCcw className="h-2.5 w-2.5 text-muted-foreground" />
          </span>
        }
        onOpenSession={
          childConversationId != null
            ? () =>
                viewerHost
                  ? viewerHost.open({ kind: "delegation", source })
                  : setDialogOpen(true)
            : undefined
        }
      />
      {viewerHost == null && childConversationId != null && (
        <SubAgentSessionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          childConversationId={childConversationId}
          childConnectionId={childConnectionId}
          identity={identity}
          kickoffTask={task}
        />
      )}
    </div>
  )
}
