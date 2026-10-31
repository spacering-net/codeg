"use client"

import { memo, useMemo, useRef, useState, type ReactNode } from "react"
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
import { RenderPageResultCard } from "../render-page-result-card"
import { CODEG_MCP_TOOL_ICONS, CodegMcpToolCard } from "../codeg-mcp-tool-card"
import { GoalRunPart, GoalToolCallPart } from "../goal-tool-call"
import { isCodegMcpWorkbenchTool } from "@/lib/codeg-mcp-tool"
import { AgentRow } from "./rows/agent-row"
import { BackgroundTaskRows } from "./rows/background-task-rows"
import { CommandGroupRow, CommandRow } from "./rows/command-rows"
import {
  DelegationCancelRow,
  DelegationPollsRow,
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

/**
 * The activity timeline: a reply's process as one row per step on a left
 * rail. Grouping, status and summary all come from the activity model
 * (`buildActivity`); this only draws it.
 */
/** Past this many rows a reply opens with its head and tail only. */
const LONG_TIMELINE_ROWS = 150
const LONG_TIMELINE_HEAD = 20
const LONG_TIMELINE_TAIL = 50
/** Rows each "show more" reveals. */
const LONG_TIMELINE_STEP = 200
/** Where a long reply's hidden middle sits among its rows (and its key). */
const FOLD = "fold"
/** The foot of a list's rail (its key). */
const FOOT = "foot"

export const ActivityTimeline = memo(function ActivityTimeline({
  model,
  isStreaming,
  renderPart,
  pinnedOnly = false,
  foot,
  headed = false,
  nested = false,
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
}) {
  const t = useTranslations("Folder.chat.activity")
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
  // A giant reply (an agent loop of hundreds of calls) opens with its first
  // and last rows; the middle is revealed a chunk at a time. Message-level
  // virtualization keeps working: this only bounds one row's own DOM.
  const [revealed, setRevealed] = useState(0)
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
  const long = items.length > LONG_TIMELINE_ROWS && !pinnedOnly
  // While it streams, its rows slide into the fold one at a time as new ones
  // arrive: cutting the tail to size the moment it crossed the threshold would
  // unmount dozens of rows at once, mid-stream. Settled, it opens trimmed.
  const tailSize = isStreaming
    ? LONG_TIMELINE_ROWS - LONG_TIMELINE_HEAD
    : LONG_TIMELINE_TAIL
  const hidden = long
    ? Math.max(0, items.length - LONG_TIMELINE_HEAD - tailSize - revealed)
    : 0
  if (items.length === 0 && !standing) return null
  const headSize = LONG_TIMELINE_HEAD + revealed
  // A group the reply has moved past — a row follows it, or the answer under
  // the rows does — takes no more members.
  const lastKey = items.length > 0 ? items[items.length - 1]!.key : null
  const answerFollows = hasVisibleAnswer(model.answer)
  // One list of children, the fold among them: a row that moves between the
  // head, the fold and the tail keeps its key's place, never remounting.
  const rows = items.flatMap<ActivityItem | typeof FOLD>((item, index) => {
    if (hidden === 0 || index < headSize) return [item]
    if (index === headSize) return [FOLD]
    return index >= items.length - tailSize ? [item] : []
  })
  return (
    <ActivityRenderProvider value={context}>
      <ol
        ref={listRef}
        role="list"
        className="activity-timeline empty:hidden"
        data-headed={headed ? "" : undefined}
        // Standing for its first step, the list holds only the turning ring:
        // nothing to read yet, so no list either.
        aria-hidden={items.length === 0 ? true : undefined}
      >
        {rows.map((item) =>
          item === FOLD ? (
            <li key={FOLD} className="activity-item" data-marker="dot">
              <span className="absolute start-[0.4375rem] top-[0.6875rem] flex size-1.5 items-center justify-center">
                <span className="size-1.5 rounded-full bg-muted-foreground/50" />
              </span>
              <button
                type="button"
                className="min-h-7 rounded-sm py-0.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  setRevealed((count) => count + LONG_TIMELINE_STEP)
                }
              >
                {t("row.showMoreSteps", { count: hidden })}
              </button>
            </li>
          ) : (
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
          )
        )}
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
    case "delegation":
      return <DelegationRow step={step} />
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
    case "render-page":
      return (
        <HostedRow
          stepKey={step.key}
          icon={toolIcon(tool)}
          status={tool.status}
          kindLabel={t("kind.renderPage")}
          inset={false}
        >
          <RenderPageResultCard
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
    case "collab-agent":
      return "kind.agent" as const
    case "delegation":
    case "delegation-status":
    case "delegation-cancel":
    case "delegation-resume":
      return "kind.delegation" as const
    case "question":
      return "kind.question" as const
    case "render-page":
      return "kind.renderPage" as const
    case "plan-mode":
      return "kind.plan" as const
    case "goal":
      return "kind.goal" as const
    default:
      return "kind.other" as const
  }
}
