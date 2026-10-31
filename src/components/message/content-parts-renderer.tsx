import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"

import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { MessageRole } from "@/lib/types"
import { buildActivity } from "@/lib/activity/build-activity"
import type { ActivityModel } from "@/lib/activity/types"
import { COLLAB_AGENT_TOOL_NAME } from "@/lib/collab-tool"
import { contextCompactionSummary } from "@/lib/context-compaction"
import {
  findHtmlFileMentions,
  hasCodexVisualizeRef,
  splitCodexVisualizeRefs,
} from "@/lib/codex-visualize"
import { normalizeToolName } from "@/lib/tool-call-normalization"
import { MessageResponse } from "@/components/ai-elements/message"
import { useChatMotion } from "@/hooks/use-chat-motion"
import { JsonRenderScope } from "@/components/ai-elements/json-render-pre"
import { ActivityTimeline } from "./activity/activity-timeline"
import type { ActivityFoot } from "./activity/timeline-foot"
import { CodegMcpToolCard } from "./codeg-mcp-tool-card"
import { CodexVisualizeCard } from "./codex-visualize-card"
import { CollabAgentCard } from "./collab-agent-card"
import {
  ContextCompactionCard,
  isContextCompactionMeta,
} from "./context-compaction-card"
import { GeneratedImagesBlock } from "./generated-images-block"
import { HtmlFilePreviews } from "./html-file-previews"
import {
  AnnotationReportProvider,
  PlainTextWithBadges,
} from "./plain-text-with-badges"
import { annotationRefsIn } from "./user-message-segments"
import { PlanMarkdownCard } from "./plan-mode-card"
import { ResumedDelegationCard } from "./resumed-delegation-card"
import { TurnErrorPart } from "./turn-error-part"

/**
 * Draws a turn's parts. An agent's reply goes to the activity timeline
 * (`ActivityTimeline`), which draws its steps as rows; this file draws what
 * the timeline hands back — the prose, proposed plans, images and turn errors
 * between and after the steps, and the few tool calls whose own cards sit on
 * its rail — plus the user's and the system's turns.
 */

// ── Part components ───────────────────────────────────────────────────

const TextPart = memo(function TextPart({
  text,
  isUser = false,
  isStreaming = false,
  live = false,
}: {
  text: string
  // User messages render as plain text + inline reference badges (no Markdown),
  // matching the plain-text composer. Assistant / system text keeps full Markdown.
  isUser?: boolean
  isStreaming?: boolean
  /** The prose the agent is writing right now: its words fade in. */
  live?: boolean
}) {
  if (isUser) {
    return (
      <div className="break-words text-sm">
        <PlainTextWithBadges text={text} />
      </div>
    )
  }
  return <AssistantText text={text} isStreaming={isStreaming} live={live} />
})

/**
 * Assistant text, with its inline HTML previews:
 * - explicit references — Codex's `visualize{…}` marker, Hermes'
 *   `::preview{file=…}` — are cut out of the Markdown and rendered in place,
 *   expanded;
 * - any other local HTML file the reply mentions gets an on-demand "Preview"
 *   row under it (not while streaming, so rows do not flicker in and out).
 */
function AssistantText({
  text,
  isStreaming,
  live,
}: {
  text: string
  isStreaming: boolean
  live: boolean
}) {
  const segments = useMemo(
    () => (hasCodexVisualizeRef(text) ? splitCodexVisualizeRefs(text) : null),
    [text]
  )
  const mentions = useMemo(() => {
    if (isStreaming) return []
    const shown =
      segments?.flatMap((s) => (s.kind === "visualize" ? [s.ref.path] : [])) ??
      []
    return findHtmlFileMentions(text, { exclude: shown })
  }, [text, segments, isStreaming])

  const hasInline = segments?.some((s) => s.kind === "visualize") ?? false
  if (!hasInline && mentions.length === 0) {
    return <MarkdownText text={text} isStreaming={isStreaming} live={live} />
  }
  return (
    <div className="space-y-2">
      {hasInline && segments ? (
        segments.map((segment, index) =>
          segment.kind === "visualize" ? (
            <CodexVisualizeCard
              key={`viz-${index}-${segment.ref.path}`}
              path={segment.ref.path}
              mode={segment.ref.mode}
            />
          ) : (
            <MarkdownText
              key={`md-${index}`}
              text={segment.text}
              isStreaming={isStreaming}
              live={live && index === segments.length - 1}
            />
          )
        )
      ) : (
        <MarkdownText text={text} isStreaming={isStreaming} live={live} />
      )}
      {mentions.length > 0 ? <HtmlFilePreviews paths={mentions} /> : null}
    </div>
  )
}

/**
 * How the prose being written arrives: a character at a time, each fading in
 * (globals.css, `[data-word-fade]`), a chunk's characters one after another so
 * a burst of text flows in rather than landing at once. By character, not by
 * word: a run of Chinese or Japanese has no spaces, and as one growing "word"
 * it would never fade at all. Streamdown wraps each new character in a span
 * and spaces their delays; the fade itself is ours, a transition from
 * `@starting-style`, which a later render cannot cut short the way it re-times
 * Streamdown's own keyframes.
 */
const LIVE_TEXT_ANIMATION = { sep: "char", stagger: 8 } as const

/**
 * Arms the fade a frame after the text mounts, so only characters that arrive
 * after that fade in. Text that mounts already written — the prose being
 * written, remounted as it moves onto or off the rail, or brought back by the
 * virtual list — stays as it is instead of fading in all over again. (A
 * starting style applies to an element's first style only: the characters
 * already there were styled before the fade was armed.)
 */
function useFadeArmed(fade: boolean): boolean {
  const [armed, setArmed] = useState(false)
  const [wasFading, setWasFading] = useState(fade)
  if (wasFading !== fade) {
    setWasFading(fade)
    if (!fade) setArmed(false)
  }
  useEffect(() => {
    if (!fade || armed) return
    const frame = requestAnimationFrame(() => setArmed(true))
    return () => cancelAnimationFrame(frame)
  }, [fade, armed])
  return fade && armed
}

function MarkdownText({
  text,
  isStreaming,
  live = false,
}: {
  text: string
  isStreaming: boolean
  live?: boolean
}) {
  const motion = useChatMotion()
  const fade = live && isStreaming && motion
  const armed = useFadeArmed(fade)
  return (
    <div
      className='break-words text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'
      data-word-fade={armed ? "" : undefined}
    >
      {/* An assistant reply's own text: the one place a ```spec fence may
          render as a json-render card. */}
      <JsonRenderScope>
        <MessageResponse
          mode={isStreaming ? "streaming" : "static"}
          parseIncompleteMarkdown={isStreaming}
          animated={fade ? LIVE_TEXT_ANIMATION : undefined}
          isAnimating={fade}
        >
          {text}
        </MessageResponse>
      </JsonRenderScope>
    </div>
  )
}

// Codex Plan-mode `<proposed_plan>` block: free-form markdown plan document
// rendered inside card chrome (distinct from the TodoWrite checklist).
//
// Renders through the SAME <PlanMarkdownCard> the live `plan_review` tool call
// uses. The two carriers of a codex plan — this lifted block on reload, that
// tool call live — previously had their own chrome, so the reloaded plan lost
// the prose styling and the clamp/expand footer the live one had.
const ProposedPlanPart = memo(function ProposedPlanPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "proposed-plan" }>
}) {
  const t = useTranslations("Folder.chat.proposedPlan")
  return (
    <PlanMarkdownCard
      markdown={part.markdown.trim()}
      label={t("title")}
      emptyLabel={t("planning")}
    />
  )
})

type ToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

/**
 * The tool calls whose own cards the timeline hosts on its rail: codex-acp's
 * context compaction (tagged by `_meta.contextCompaction`, not by name),
 * codex's live collab sub-agent activity, and codeg-mcp's `resume_delegation`
 * (the sub-agent that came back, drawn as the delegation card itself, with
 * the generic workbench card for a refused resume, where there is no sub-agent
 * to draw and only the reason is worth reading).
 */
const HostedToolCall = memo(function HostedToolCall({
  part,
}: {
  part: ToolCallPart
}) {
  if (isContextCompactionMeta(part.meta)) {
    return (
      <ContextCompactionCard
        state={part.state}
        meta={part.meta}
        summary={contextCompactionSummary(part.meta, part.output)}
      />
    )
  }
  const toolName = normalizeToolName(part.toolName).toLowerCase()
  if (toolName === COLLAB_AGENT_TOOL_NAME) {
    return (
      <CollabAgentCard
        input={part.input ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }
  if (toolName === "resume_delegation") {
    const fallback = (
      <CodegMcpToolCard
        tool="resume_delegation"
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
    if (!part.toolCallId) return fallback
    return (
      <ResumedDelegationCard
        toolCallId={part.toolCallId}
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
        meta={part.meta ?? null}
        // Whether a sub-agent resolves is only known inside the card (it takes
        // a hook to find out), so the fallback goes in rather than the decision
        // coming out.
        fallback={fallback}
      />
    )
  }
  return null
})

// ── Main renderer ─────────────────────────────────────────────────────

interface ContentPartsRendererProps {
  parts: AdaptedContentPart[]
  role?: MessageRole
  isStreaming?: boolean
}

/**
 * Draw one part outside the timeline's own rows. Module-level so the timeline
 * can be handed it as its `renderPart`: the prose between steps, the reply's
 * answer, the images and plans it shows in place, and the tool calls it hosts.
 */
function renderPart(
  part: AdaptedContentPart,
  keyId: string,
  role: MessageRole | undefined,
  isStreaming: boolean,
  live = false
): ReactNode {
  switch (part.type) {
    case "text":
      // An empty text part renders nothing but still earns a `space-y-4` gap
      // below, which reads as a blank band inside the bubble. A user turn is
      // final by the time it is rendered, so an empty one is always residue —
      // never a stream that has not produced its first token yet, which is why
      // this is scoped to `user` and assistant text is left to render as-is.
      if (role === "user" && part.text.trim().length === 0) return null
      return (
        <TextPart
          key={`text-${keyId}`}
          text={part.text}
          isUser={role === "user"}
          isStreaming={isStreaming}
          live={live}
        />
      )
    case "tool-call":
      return (
        <HostedToolCall key={`tc-${part.toolCallId ?? keyId}`} part={part} />
      )
    case "proposed-plan":
      return <ProposedPlanPart key={`proposed-plan-${keyId}`} part={part} />
    case "generated-image":
      return (
        <GeneratedImagesBlock
          key={`gimg-${keyId}`}
          label={part.label}
          revisedPrompt={part.revisedPrompt}
          image={part.image}
          status={part.status}
        />
      )
    case "turn-error":
      return (
        <TurnErrorPart key={`turn-error-${keyId}`} message={part.message} />
      )
    default:
      return null
  }
}

function useAssistantRenderPart(isStreaming: boolean) {
  return useCallback(
    (part: AdaptedContentPart, key: string, live = false) =>
      renderPart(part, key, "assistant", isStreaming, live),
    [isStreaming]
  )
}

/**
 * The activity timeline for an already-built model. `CompletedTurnContent`
 * builds the model once for its header and hands it here for the body.
 */
export const ActivityParts = memo(function ActivityParts({
  model,
  isStreaming,
  pinnedOnly = false,
  foot,
  headed = false,
}: {
  model: ActivityModel
  isStreaming: boolean
  /** Only the rows still running (see `ActivityTimeline`). */
  pinnedOnly?: boolean
  /** The capsule the rail ends on, which folds the reply's steps away (see
   *  `ActivityTimeline`). */
  foot?: ActivityFoot
  /** Hung under the turn's header (see `ActivityTimeline`). */
  headed?: boolean
}) {
  const render = useAssistantRenderPart(isStreaming)
  return (
    <ActivityTimeline
      model={model}
      isStreaming={isStreaming}
      renderPart={render}
      pinnedOnly={pinnedOnly}
      foot={foot}
      headed={headed}
    />
  )
})

/** An agent's reply as its timeline, then its answer. */
const AssistantActivity = memo(function AssistantActivity({
  parts,
  isStreaming,
}: {
  parts: AdaptedContentPart[]
  isStreaming: boolean
}) {
  const render = useAssistantRenderPart(isStreaming)
  const model = useMemo(
    () => buildActivity(parts, { isStreaming }),
    [parts, isStreaming]
  )
  return (
    <div className="space-y-4">
      <ActivityTimeline
        model={model}
        isStreaming={isStreaming}
        renderPart={render}
      />
      {model.answer.map((part, i) =>
        // The answer's last part, while the reply is written, is the prose
        // being written.
        render(
          part,
          `answer-${i}`,
          isStreaming && i === model.answer.length - 1
        )
      )}
    </div>
  )
})

export const ContentPartsRenderer = memo(function ContentPartsRenderer({
  parts,
  role,
  isStreaming = false,
}: ContentPartsRendererProps) {
  // Every annotation report this bubble holds, whichever part it sits in —
  // an agent's record keeps the block away from the badge that opens it.
  const annotationReports = useMemo(
    () =>
      new Set(
        role === "user"
          ? parts.flatMap((part) =>
              part.type === "text" ? annotationRefsIn(part.text) : []
            )
          : []
      ),
    [parts, role]
  )
  // Anything the agent produced is drawn as its activity. A "tool" turn (a
  // viewer that passes the transcript's roles through) is agent output too.
  if (role !== "user" && role !== "system") {
    return <AssistantActivity parts={parts} isStreaming={isStreaming} />
  }
  const body = parts.map((part, i) =>
    renderPart(part, `${i}`, role, isStreaming)
  )
  if (role !== "user") {
    return <div className="space-y-4">{body}</div>
  }
  // One user bubble shares its open annotation reports across its parts.
  return (
    <AnnotationReportProvider reports={annotationReports}>
      <div className="space-y-4">{body}</div>
    </AnnotationReportProvider>
  )
})
