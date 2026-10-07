"use client"

/**
 * Live capsule for codex collab / sub-agent activity (codex-acp 1.0.1, PR #223).
 * Renders the streaming-time view of a `collabAgentToolCall` through the same
 * `AgentCapsule` chrome as the history "Agent" capsule, so the two are visually
 * consistent. The body is intentionally minimal: the `prompt` (the execution
 * capsule's task) and each sub-agent's `message` rendered bare as markdown (on a
 * `wait` the message is the sub-agent's full result). Per-agent status is NOT
 * shown as a row — it's conveyed by the capsule chrome (title shimmer while
 * running, ✓/⚠ suffix, auto-open on error). The sub-agent UUID(s) are shown in
 * the pill via `idBadge` so execution and wait capsules read uniformly.
 *
 * The full sub-agent transcript is NOT available live — codex-acp's separate
 * `subAgentActivity` signal (codex-acp #304) is suppressed as redundant and
 * carries no transcript content anyway; the richer reconstructed capsule only
 * appears on history reload. The sub-agent's `model` / `reasoningEffort` (also
 * #304) ARE available live and shown on the execution (spawn) capsule. Detection,
 * op-merge and status classification live in `@/lib/collab-tool`.
 */

import { useMemo, useState } from "react"
import { AlertTriangle, Check, Cpu } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  parseCollabToolInput,
  classifyCollabStatus,
  isErrorCollabStatusKind,
  classifyCollabOp,
  isCodexThreadId,
  shortAgentId,
  type CollabAgentState,
} from "@/lib/collab-tool"
import { MessageResponse } from "@/components/ai-elements/message"
import { AgentCapsule } from "./agent-capsule"
import { SubagentSessionButton } from "./subagent-session-button"
import { SubagentSessionDialog } from "./subagent-session-dialog"
import { useSessionViewerHost } from "./session-viewer-host"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"

interface Props {
  input?: string | null
  errorText?: string | null
  state?: ToolCallState
}

export function CollabAgentCard({ input, errorText, state }: Props) {
  const t = useTranslations("Folder.chat.collabAgent")
  const tcp = useTranslations("Folder.chat.contentParts")

  const info = useMemo(() => parseCollabToolInput(input), [input])
  const prompt = info?.prompt ?? null
  const agents = info?.agents ?? []
  const opStatus = info?.status ?? null
  const op = info?.op ?? null
  const model = info?.model ?? null
  const reasoningEffort = info?.reasoningEffort ?? null
  // model/effort describe HOW the sub-agent runs — meaningful on the execution
  // (spawn) capsule, the one collab card that survives live collapse as the
  // sub-agent's definition. Gating to spawn also preserves live/reload parity:
  // the reconstructed `wait` capsule (Rust `build_collab_wait_input`) carries no
  // model/effort, so a live `wait` card must not show them either.
  const showRunMeta =
    classifyCollabOp(op) === "spawn" && (!!model || !!reasoningEffort)

  const hasErrorAgent = agents.some((a) =>
    isErrorCollabStatusKind(classifyCollabStatus(a.status))
  )
  // Collab calls have no rawOutput, so a failed op only shows in `status`; fold
  // it into the error state too, else a failed wait/close with no per-agent
  // states would render "Failed" yet stay collapsed (and show a success check).
  const isError =
    state === "output-error" ||
    !!errorText?.trim() ||
    hasErrorAgent ||
    isErrorCollabStatusKind(classifyCollabStatus(opStatus))
  const isRunning = state === "input-streaming" || state === "input-available"

  // Title: the task's first line when present (CSS-truncated by the shell),
  // else an op-aware label (so `wait`/`close` aren't bare "Sub-agent"), else
  // the generic sub-agent label.
  const title = useMemo(() => {
    const firstLine = prompt?.split("\n")[0]?.trim()
    if (firstLine && firstLine.length > 0) return firstLine
    switch (classifyCollabOp(op)) {
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
        return t("title") // sendInput / unknown → generic label
    }
  }, [prompt, op, t])

  const rightSuffix = isError ? (
    <AlertTriangle className="size-3.5 text-destructive" />
  ) : state === "output-available" ? (
    <Check className="size-3.5" />
  ) : null

  // Sub-agent id(s) shown in the pill so the capsule is identifiable and the
  // execution/wait capsules read uniformly (status is conveyed by the chrome,
  // not a per-agent row). Short form (first UUID segment); multiple → first id
  // + "+N".
  const idBadge =
    agents.length === 0
      ? null
      : agents.length > 1
        ? `${shortAgentId(agents[0].threadId)} +${agents.length - 1}`
        : shortAgentId(agents[0].threadId)

  // The capsule this card most often draws — a native-team `wait` — carries no
  // result of its own (codex answers it with `{"message":"Wait completed."}`),
  // so it renders as an inert pill saying only that a wait happened. It does
  // hold the child's thread id, though, and that id IS its rollout: the same
  // entry point the spawn capsule offers works here, and turns the pill into
  // the one place a live session can reach the child's actual work.
  //
  // ONE agent only, deliberately. With several, a single header button would
  // have to pick one child and silently drop the rest — the badge already says
  // "+N" — and per-agent buttons belong next to per-agent bodies, which a wait
  // capsule does not have. `isCodexThreadId` excludes the name-keyed
  // `list_agents` roster, whose keys open nothing.
  const openableAgentId =
    agents.length === 1 && isCodexThreadId(agents[0].threadId)
      ? agents[0].threadId
      : null
  const viewerHost = useSessionViewerHost()
  const [sessionOpen, setSessionOpen] = useState(false)
  const openChildSession = useMemo(() => {
    if (!openableAgentId) return null
    return () =>
      viewerHost
        ? viewerHost.open({
            kind: "agentSession",
            sessionId: openableAgentId,
            agentType: "codex",
            subagentType: null,
            description: null,
            // A collab capsule is only ever drawn live while the op is in
            // flight; keep re-reading the child's transcript until it settles.
            live: isRunning,
          })
        : setSessionOpen(true)
  }, [openableAgentId, viewerHost, isRunning])

  return (
    <>
      <AgentCapsule
        title={title}
        isRunning={isRunning}
        isError={isError}
        rightSuffix={rightSuffix}
        idBadge={idBadge}
        headerAction={
          openChildSession ? (
            <SubagentSessionButton onClick={openChildSession} />
          ) : null
        }
        statusLabel={title}
      >
        {/* Sub-agent model + reasoning effort (codex-acp #304), execution capsule
          only. Live-side enrichment: previously visible only after reload. */}
        {showRunMeta && (
          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Cpu className="size-3 shrink-0" />
            {model && <span className="font-mono">{model}</span>}
            {model && reasoningEffort && <span aria-hidden>·</span>}
            {reasoningEffort && <span>{reasoningEffort}</span>}
          </div>
        )}

        {/* Prompt — the execution capsule's task (spawn only; wait has none). */}
        {prompt && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">
              {tcp("agentPromptLabel")}
            </div>
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
              <MessageResponse>{prompt}</MessageResponse>
            </div>
          </div>
        )}

        {/* Sub-agent message(s) — rendered bare (no status row, no box): on a
          `wait` these are the fetched results; on a no-wait execution the
          fallback last message. Status is conveyed by the capsule chrome. */}
        {agents.map((agent: CollabAgentState) =>
          agent.message ? (
            <div
              key={agent.threadId}
              className="text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside"
            >
              <MessageResponse>{agent.message}</MessageResponse>
            </div>
          ) : null
        )}

        {/* Error output when the failure carries text but no per-agent message. */}
        {isError && errorText?.trim() && (
          <div className="rounded-md bg-destructive/10 p-3">
            <pre className="whitespace-pre-wrap break-words text-xs text-destructive">
              {errorText.trim()}
            </pre>
          </div>
        )}
      </AgentCapsule>

      {/* Drawer fallback for when there is no `SessionViewerHost` above. A
          SIBLING of the capsule: its children decide whether the capsule has a
          body, and this one has none to speak of. */}
      {openableAgentId && viewerHost == null && sessionOpen && (
        <SubagentSessionDialog
          open={sessionOpen}
          onOpenChange={setSessionOpen}
          sessionId={openableAgentId}
          agentType="codex"
          subagentType={null}
          description={null}
          live={isRunning}
        />
      )}
    </>
  )
}
