"use client"

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { useTranslations } from "next-intl"

import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { hasVisibleAnswer, rowIdentity } from "@/lib/activity/build-activity"
import type {
  ActivityItem,
  ActivityModel,
  ActivityStep,
} from "@/lib/activity/types"
import { ActivityRenderProvider, useActivityRender } from "./activity-context"
import { GOAL_ICON, IMAGE_ICON, toolIcon } from "./step-visuals"
import { AskQuestionResultCard } from "../ask-question-result-card"
import { CODEG_MCP_TOOL_ICONS, CodegMcpToolCard } from "../codeg-mcp-tool-card"
import { GoalRunPart, GoalToolCallPart } from "../goal-tool-call"
import { isCodegMcpWorkbenchTool } from "@/lib/codeg-mcp-tool"
import { AgentRow } from "./rows/agent-row"
import { BackgroundTaskRows } from "./rows/background-task-rows"
import { CollabAgentRow } from "./rows/collab-agent-row"
import { CommandGroupRow, CommandRow } from "./rows/command-rows"
import {
  DelegationCancelRow,
  DelegationPollsRow,
  DelegationResumeRow,
  DelegationRow,
} from "./rows/delegation-rows"
import { FeedbackRow, PlanModeRow } from "./rows/interaction-rows"
import { PlanRow } from "./rows/plan-row"
import { EditRow } from "./rows/edit-row"
import { ExploreChildRow, ExploreGroupRow } from "./rows/explore-rows"
import { GenericRow, ToolResultRow } from "./rows/generic-row"
import { HostedRow, NoteRow } from "./rows/hosted-row"
import { McpRow } from "./rows/mcp-row"
import { ThoughtRow } from "./rows/thought-row"
import { TimelineFoot, type ActivityFoot } from "./timeline-foot"
import { useLiveToolStep } from "./use-live-step"
import { useRailGrowth } from "./use-rail-growth"
import { useRowPointing } from "./use-row-pointing"
import {
  RevealRequests,
  TimelineRevealContext,
  useTimelineWindow,
  WINDOWED_ROWS,
  type ListMetrics,
} from "./use-timeline-window"

/**
 * The activity timeline: a reply's process as one row per step on a left
 * rail. Grouping, status and summary all come from the activity model
 * (`buildActivity`); this only draws it.
 */
/** The foot of a list's rail (its key). */
const FOOT = "foot"
/** The spacers standing for the rows of a windowed list not drawn (keys). */
const BEFORE = "window-before"
const AFTER = "window-after"

/** Calls drawn as a card of their own on the rail, taller than a row. */
const CARD_KINDS = new Set([
  "agent",
  "collab-agent",
  "delegation",
  "delegation-resume",
  "question",
  "plan-mode",
  "workbench",
  "goal",
])

/**
 * How tall a row is before it has been drawn (see `useTimelineWindow`): a step
 * is a one-line header, prose as many lines as its words take, a card more.
 * Only a reply opened from history meets rows it has not drawn; a streaming
 * one has drawn each as it joined.
 */
function estimateItemHeight(
  item: ActivityItem,
  { rem, width }: ListMetrics
): number {
  // A row's header: a 1.5rem line with 0.125rem above and below.
  const line = 1.75 * rem
  if (item.type === "group") return line
  const { step } = item
  switch (step.type) {
    case "note": {
      const text =
        step.part.type === "text"
          ? step.part.text
          : step.part.type === "proposed-plan"
            ? step.part.markdown
            : step.part.message
      // text-sm: 1.25rem lines, glyphs about 0.45rem wide (CJK twice that),
      // in the column past the rail.
      const perLine = Math.max(1, (width - 2 * rem) / (0.45 * rem))
      let lines = 0
      let paragraphs = 0
      for (const paragraph of text.split(/\n{2,}/)) {
        if (!paragraph.trim()) continue
        paragraphs += 1
        for (const row of paragraph.split("\n")) {
          let units = 0
          for (const char of row) units += char.charCodeAt(0) > 0x2e7f ? 2 : 1
          lines += Math.max(1, Math.ceil(units / perLine))
        }
      }
      return (
        0.25 * rem +
        Math.max(1, lines) * 1.25 * rem +
        Math.max(0, paragraphs - 1) * rem
      )
    }
    case "tool":
      return CARD_KINDS.has(step.tool.kind) ? 4 * rem : line
    case "plan":
      return 6 * rem
    case "image":
      return 12 * rem
    case "goal":
      return 4 * rem
    default:
      return line
  }
}

/**
 * A stretch of a windowed list's rows that is not drawn: as tall as they are,
 * the rail running through it (globals.css), nothing to read.
 */
function WindowSpacer({ height }: { height: number }) {
  return (
    <li
      aria-hidden="true"
      className="activity-item"
      data-marker="spacer"
      style={{ height }}
    />
  )
}

export const ActivityTimeline = memo(function ActivityTimeline({
  model,
  isStreaming,
  renderPart,
  pinnedOnly = false,
  foot,
  headed = false,
  nested = false,
  revealRef,
}: {
  model: ActivityModel
  isStreaming: boolean
  renderPart: (
    part: AdaptedContentPart,
    key: string,
    live?: boolean
  ) => ReactNode
  pinnedOnly?: boolean
  /** The list folds away with its host — the reply, a sub-agent's row, a
   *  goal's card: the rail runs on past the last row to a foot, the turning
   *  ring while the steps go on and then a row that folds them. */
  foot?: ActivityFoot
  /** The list hangs under the turn's header capsule: its first step sits as
   *  far below it as a step below the one before, and the rail runs up to
   *  it (globals.css). While its foot turns it stands before any step has
   *  come: the rail runs from the header down to the turning ring, where the
   *  first step will go, and the steps join above the ring. */
  headed?: boolean
  /** Drawn inside a step (see `ActivityRenderContextValue.nested`). */
  nested?: boolean
  /** Handed a function that draws the row holding a step (by its key) and
   *  scrolls it into view — a long list draws only the rows near the view,
   *  so the header's failure link cannot find one far off by itself. Null
   *  while every row is drawn. */
  revealRef?: RefObject<((stepKey: string) => boolean) | null>
}) {
  const context = useMemo(
    () => ({
      renderPart,
      isStreaming,
      recoveredKeys: model.summary.recoveredKeys,
      pinnedOnly,
      nested,
      renderNested: (
        nestedModel: ActivityModel,
        nestedStreaming: boolean,
        nestedFoot?: ActivityFoot
      ) => (
        <ActivityTimeline
          model={nestedModel}
          isStreaming={nestedStreaming}
          renderPart={renderPart}
          foot={nestedFoot}
          nested
        />
      ),
    }),
    [renderPart, isStreaming, model.summary.recoveredKeys, pinnedOnly, nested]
  )
  const items = model.items
  const listRef = useRef<HTMLOListElement>(null)
  // Under the header, the list is there from the start: with no step yet,
  // it is the rail down to its turning foot (see `headed`).
  const standing = headed && !pinnedOnly && foot?.working === true
  // Still going, its rail grows down to each step that joins it — the first
  // one too, when the list was standing for it.
  useRailGrowth(
    listRef,
    !pinnedOnly && isStreaming && (items.length > 0 || standing)
  )
  // A nested list's rows are marked by the list it is nested in. Keyed on
  // the list being drawn at all, so it listens once the list mounts.
  useRowPointing(listRef, !nested && (items.length > 0 || standing))
  // A long reply (an agent loop of hundreds of calls) draws the rows near the
  // view, the rest a scroll away; live, a view resting at its end keeps up
  // with the rows that join there.
  const windowed = !pinnedOnly && !nested && items.length > WINDOWED_ROWS
  const { span, reveal } = useTimelineWindow({
    listRef,
    scope: "item",
    rows: windowed ? items : null,
    estimate: estimateItemHeight,
    follow: isStreaming,
  })
  // A step in a group's members is drawn by the members, once the group is
  // (see `TimelineRevealContext`).
  const [memberRequests] = useState(() => new RevealRequests())
  useEffect(() => {
    if (!revealRef) return
    revealRef.current = (stepKey: string) => {
      const index = items.findIndex(
        (item) =>
          item.key === stepKey ||
          (item.type === "group" &&
            item.steps.some((step) => step.key === stepKey))
      )
      if (index < 0) return false
      // A step in a group: the group is drawn, and its members draw and
      // scroll to the step — the first member too, which shares the group's
      // key. Scrolling to the group as well would move the step back out.
      const group = items[index]!.type === "group"
      if (windowed) reveal(index, !group)
      memberRequests.ask(group ? stepKey : null)
      return true
    }
  }, [revealRef, windowed, items, reveal, memberRequests])
  if (items.length === 0 && !standing) return null
  // A group the reply has moved past — a row follows it, or the answer under
  // the rows does — takes no more members.
  const lastKey = items.length > 0 ? items[items.length - 1]!.key : null
  const answerFollows = hasVisibleAnswer(model.answer)
  const drawn = span ? items.slice(span.start, span.end) : items
  const list = (
    <ActivityRenderProvider value={context}>
      <ol
        ref={listRef}
        role="list"
        className="activity-timeline empty:hidden"
        data-headed={headed ? "" : undefined}
        data-windowed={span ? "" : undefined}
        // Standing for its first step, the list holds only the turning ring:
        // nothing to read yet, so no list either.
        aria-hidden={items.length === 0 ? true : undefined}
      >
        {span && span.start > 0 ? (
          <WindowSpacer key={BEFORE} height={span.before} />
        ) : null}
        {drawn.map((item) => (
          <ActivityItemView
            key={rowIdentity(item.key)}
            item={item}
            followed={
              item.type === "group" && (item.key !== lastKey || answerFollows)
            }
            // The list's last step while the reply is written: if it is
            // prose, it is the prose being written now.
            tail={isStreaming && !pinnedOnly && item.key === lastKey}
          />
        ))}
        {span && span.end < items.length ? (
          <WindowSpacer key={AFTER} height={span.after} />
        ) : null}
        {/* Last, so the rows that join go in above it: the last row's segment
            runs on to it like to a row's ring. The rows still running under
            a folded reply are no list to fold. */}
        {foot && !pinnedOnly ? (
          <TimelineFoot
            key={FOOT}
            working={foot.working}
            what={foot.what}
            onFold={foot.onFold}
            motionScope={nested ? undefined : ""}
          />
        ) : null}
      </ol>
    </ActivityRenderProvider>
  )
  // A nested list's requests go through the reply's.
  return nested ? (
    list
  ) : (
    <TimelineRevealContext.Provider value={memberRequests}>
      {list}
    </TimelineRevealContext.Provider>
  )
})

/** Rows that can outlive their turn — kept in view when the turn folds (each
 *  says itself whether it is still live). */
function canOutliveTurn(item: ActivityItem): boolean {
  if (item.type !== "step") return false
  const { step } = item
  if (step.type === "background-tasks" || step.type === "delegation-polls") {
    return true
  }
  return (
    step.type === "tool" &&
    (step.tool.kind === "delegation" ||
      step.tool.kind === "delegation-resume" ||
      step.tool.kind === "delegation-status" ||
      step.tool.kind === "agent")
  )
}

const ActivityItemView = memo(function ActivityItemView({
  item,
  followed,
  tail,
}: {
  item: ActivityItem
  /** A group with something after it in the reply (see `useGroupPlace`). */
  followed: boolean
  /** The last step of a list still being written. */
  tail: boolean
}) {
  const { pinnedOnly } = useActivityRender()
  if (pinnedOnly && !canOutliveTurn(item)) return null
  if (item.type === "group") {
    return item.kind === "explore" ? (
      <ExploreGroupRow
        groupKey={item.key}
        steps={item.steps}
        status={item.status}
        followed={followed}
      />
    ) : (
      <CommandGroupRow
        groupKey={item.key}
        steps={item.steps}
        status={item.status}
        followed={followed}
      />
    )
  }
  return <StepView step={item.step} tail={tail} />
})

/** A note's motion key: the prose it holds, by its place in the reply —
 *  `note:<anchor>:<index>` holds the part at `<index>` — which is the key
 *  that prose has as the reply's answer too (`CompletedTurnContent`). */
function proseMotionKey(noteKey: string): string {
  return `prose:${noteKey.slice(noteKey.lastIndexOf(":") + 1)}`
}

function StepView({ step, tail }: { step: ActivityStep; tail: boolean }) {
  const t = useTranslations("Folder.chat.activity")
  const { renderPart, renderNested, nested } = useActivityRender()
  switch (step.type) {
    case "thought":
      return <ThoughtRow step={step} />
    case "note":
      return (
        <NoteRow
          stepKey={step.key}
          motionKey={nested ? undefined : proseMotionKey(step.key)}
        >
          {renderPart(step.part, step.key, tail)}
        </NoteRow>
      )
    case "tool-result":
      return <ToolResultRow step={step} />
    case "tool":
      return <ToolStepView step={step} />
    case "plan":
      return <PlanRow step={step} />
    case "image":
      return (
        <HostedRow
          stepKey={step.key}
          icon={IMAGE_ICON}
          status={
            step.part.status === "failed"
              ? "failed"
              : step.part.image
                ? "succeeded"
                : "running"
          }
          kindLabel={t("kind.image")}
        >
          {renderPart(step.part, step.key)}
        </HostedRow>
      )
    case "delegation-polls":
      return <DelegationPollsRow step={step} />
    case "background-tasks":
      return <BackgroundTaskRows step={step} />
    case "goal":
      return (
        <HostedRow
          stepKey={step.key}
          icon={GOAL_ICON}
          status={step.part.isRunning ? "running" : "succeeded"}
          kindLabel={t("kind.goal")}
          inset={false}
        >
          <GoalRunPart
            part={step.part}
            renderBody={(fold) =>
              renderNested(step.model, step.part.isRunning, {
                working: step.part.isRunning,
                what:
                  step.model.summary.steps > 0
                    ? t("header.steps", { count: step.model.summary.steps })
                    : t("kind.goal"),
                onFold: fold,
              })
            }
          />
        </HostedRow>
      )
  }
}

type ToolStep = Extract<ActivityStep, { type: "tool" }>

function ToolStepView({ step: given }: { step: ToolStep }) {
  const t = useTranslations("Folder.chat.activity")
  const { renderPart } = useActivityRender()
  // A pending approval's call waits on the user, an answered one carries the
  // answer — whatever the transcript says.
  const step = useLiveToolStep(given)
  const { tool, part } = step
  switch (tool.kind) {
    case "read":
    case "search":
    case "glob":
    case "list":
    case "fetch":
    case "web-search":
    case "memory":
      return <ExploreChildRow step={step} standalone />
    case "command":
    case "script":
    case "shell-session":
    case "monitor":
      return <CommandRow step={step} />
    case "edit":
      return <EditRow step={step} />
    case "mcp":
      return <McpRow step={step} />
    case "generic":
    case "skill":
    case "todo":
    case "completion":
    case "network":
      return <GenericRow step={step} />
    case "agent":
      return <AgentRow step={step} />
    case "collab-agent":
      return <CollabAgentRow step={step} />
    case "delegation":
      return <DelegationRow step={step} />
    case "delegation-resume":
      return (
        <DelegationResumeRow
          step={step}
          fallback={
            // A refused resume revived nothing: the reason is the row.
            <HostedRow
              stepKey={step.key}
              icon={CODEG_MCP_TOOL_ICONS.resume_delegation}
              status={tool.status}
              kindLabel={t("kind.delegation")}
              inset={false}
            >
              <CodegMcpToolCard
                layout="timeline"
                tool="resume_delegation"
                input={part.input ?? null}
                output={part.output ?? null}
                errorText={part.errorText ?? null}
                state={part.state}
              />
            </HostedRow>
          }
        />
      )
    case "delegation-status":
      return (
        <DelegationPollsRow
          step={{
            type: "delegation-polls",
            key: step.key,
            polls: [part],
            status: tool.status,
          }}
        />
      )
    case "delegation-cancel":
      return <DelegationCancelRow part={part} stepKey={step.key} />
    case "plan-mode":
      return <PlanModeRow step={step} />
    case "feedback":
      return <FeedbackRow step={step} />
    case "question":
      return (
        <HostedRow
          stepKey={step.key}
          icon={toolIcon(tool)}
          status={tool.status}
          kindLabel={t("kind.question")}
          inset={false}
        >
          <AskQuestionResultCard
            input={part.input ?? null}
            output={part.output ?? null}
            errorText={part.errorText ?? null}
            state={part.state}
          />
        </HostedRow>
      )
    case "workbench": {
      const name = tool.toolName.toLowerCase()
      if (isCodegMcpWorkbenchTool(name)) {
        return (
          <HostedRow
            stepKey={step.key}
            icon={CODEG_MCP_TOOL_ICONS[name]}
            status={tool.status}
            kindLabel={t("kind.other")}
            inset={false}
          >
            <CodegMcpToolCard
              layout="timeline"
              tool={name}
              input={part.input ?? null}
              output={part.output ?? null}
              errorText={part.errorText ?? null}
              state={part.state}
            />
          </HostedRow>
        )
      }
      break
    }
    case "goal":
      return (
        <HostedRow
          stepKey={step.key}
          icon={GOAL_ICON}
          status={tool.status}
          kindLabel={t("kind.goal")}
          inset={false}
        >
          <GoalToolCallPart part={{ ...part, toolName: tool.toolName }} />
        </HostedRow>
      )
  }
  return (
    <HostedRow
      stepKey={step.key}
      icon={toolIcon(tool)}
      status={tool.status}
      kindLabel={t(hostedKindKey(tool.kind))}
    >
      {renderPart(part, step.key)}
    </HostedRow>
  )
}

function hostedKindKey(kind: string) {
  switch (kind) {
    case "agent":
      return "kind.agent" as const
    case "delegation":
    case "delegation-status":
    case "delegation-cancel":
    case "delegation-resume":
      return "kind.delegation" as const
    case "question":
      return "kind.question" as const
    case "plan-mode":
      return "kind.plan" as const
    case "goal":
      return "kind.goal" as const
    default:
      return "kind.other" as const
  }
}
