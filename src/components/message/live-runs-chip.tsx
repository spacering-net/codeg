"use client"

/**
 * The "N running" chip at the end of the live activity row above the
 * composer, and the list it opens: the connection's background tasks, the
 * agent's own sub-agents still at work, and the codeg delegations still
 * running (see `lib/live-runs.ts` for where each comes from).
 *
 * It stands for work that outlives the turn — a background shell, a
 * background sub-agent, an async delegation, a turn the agent started on its
 * own — so the row stays while any of it runs, the turn's figures gone and
 * the chip alone on it.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { Activity, Bot } from "lucide-react"

import { AsyncTaskRow, RUN_ROW_BOX } from "@/components/chat/async-task-row"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DelegationIdentityAvatar,
  DelegationIdentityName,
} from "@/components/message/delegation-identity"
import { StatusBadge } from "@/components/message/delegation-status-badge"
import { useSessionViewerHost } from "@/components/message/session-viewer-host-context"
import { useAgentCallModel } from "@/components/message/use-agent-call-model"
import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import type { DelegationBinding } from "@/contexts/delegation-context"
import {
  useDelegationCardModel,
  type DelegationCardSource,
} from "@/hooks/use-delegation-card-model"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { blockingPrompts } from "@/lib/blocking-prompts"
import { formatElapsedLabel } from "@/lib/format-elapsed"
import type {
  LiveDelegationRun,
  LiveRuns,
  LiveSubAgentRun,
} from "@/lib/live-runs"
import { cn } from "@/lib/utils"

export type LiveRunsList = LiveRuns<DelegationBinding>

export interface LiveRunsChipProps {
  runs: LiveRunsList
  /** False while the row slides away: the list can no longer open, and one
   *  that is open closes. */
  interactive: boolean
  /** Stops one async task. Undefined hides every stop (no live connection
   *  to ask — a read-only surface). */
  onStopAsyncTask?: (taskId: string) => Promise<boolean>
  /** The agent's display name, for the row of a turn it started on its own. */
  agentName?: string
}

const NO_IDS: ReadonlySet<string> = new Set()

export function LiveRunsChip({
  runs,
  interactive,
  onStopAsyncTask,
  agentName,
}: LiveRunsChipProps) {
  const t = useTranslations("Folder.chat.liveRuns")
  const [open, setOpen] = useState(false)
  // The tasks with a stop on its way. Held here, not by their rows: a row
  // unmounts with the list when it closes, and back in view before the adapter
  // has answered it must not offer the stop again.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(NO_IDS)
  const stop = useCallback(
    async (taskId: string) => {
      if (!onStopAsyncTask) return
      setStopping((prev) => new Set(prev).add(taskId))
      try {
        await onStopAsyncTask(taskId)
      } finally {
        // Deliberately NOT left latched on success. The row leaves when the
        // task's terminal state arrives on the wire, which is the real
        // confirmation; keeping the button disabled on a `false` verdict (the
        // adapter declined) would strand the user with no way to try again.
        setStopping((prev) => {
          const next = new Set(prev)
          next.delete(taskId)
          return next
        })
      }
    },
    [onStopAsyncTask]
  )
  const awaiting = useDelegationsAwaitingUser(runs.delegations)
  const label = t("count", { count: runs.count })

  return (
    <Popover open={open && interactive} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={!interactive}
          className="group/runs inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm leading-none text-foreground/80 outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:text-foreground"
          aria-label={awaiting ? `${label} · ${t("awaiting")}` : label}
        >
          <Activity
            aria-hidden="true"
            className="size-3 shrink-0 text-primary"
          />
          <span className="tabular-nums underline-offset-2 group-hover/runs:underline group-data-[state=open]/runs:underline">
            {label}
          </span>
          {awaiting ? (
            <span
              aria-hidden="true"
              title={t("awaiting")}
              className="size-1.5 shrink-0 rounded-full bg-amber-500"
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="w-[min(26rem,calc(100vw-2rem))] gap-0 p-0"
      >
        <div className="max-h-[min(60vh,26rem)] overflow-y-auto py-1">
          <LiveRunsGroups
            runs={runs}
            onStop={onStopAsyncTask ? stop : undefined}
            stopping={stopping}
            agentName={agentName}
            onNavigate={() => setOpen(false)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The list itself, a group per kind, each headed by what it holds. Exported
 *  for the activity gallery. */
export function LiveRunsGroups({
  runs,
  onStop,
  stopping,
  agentName,
  onNavigate,
}: {
  runs: LiveRunsList
  onStop?: (taskId: string) => void
  stopping: ReadonlySet<string>
  agentName?: string
  /** A row opened a viewer: the list gets out of its way. */
  onNavigate: () => void
}) {
  const tTasks = useTranslations("Folder.chat.asyncTasks")
  const tSub = useTranslations("Folder.chat.subAgentOverlay")
  const t = useTranslations("Folder.chat.liveRuns")
  return (
    <>
      {runs.tasks.length > 0 && (
        <RunGroup title={tTasks("title")} count={runs.tasks.length}>
          {runs.tasks.map((task) => (
            <AsyncTaskRow
              key={task.task_id}
              task={task}
              onStop={onStop}
              stopping={stopping.has(task.task_id)}
              agentName={agentName}
            />
          ))}
        </RunGroup>
      )}
      {runs.subagents.length > 0 && (
        <RunGroup title={tSub("title")} count={runs.subagents.length}>
          {runs.subagents.map((run) => (
            <SubAgentRunRow key={run.key} run={run} onNavigate={onNavigate} />
          ))}
        </RunGroup>
      )}
      {runs.delegations.length > 0 && (
        <RunGroup title={t("groupDelegations")} count={runs.delegations.length}>
          {runs.delegations.map((run) => (
            <DelegationRunRow
              key={run.childConnectionId}
              run={run}
              onNavigate={onNavigate}
            />
          ))}
        </RunGroup>
      )}
    </>
  )
}

function RunGroup({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="py-0.5">
      <h3 className="flex items-center gap-1.5 px-3 pt-1.5 pb-0.5 text-2xs font-medium text-muted-foreground">
        <span className="min-w-0 truncate">{title}</span>
        <span className="tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  )
}

/** One of the agent's own sub-agents. A row with its launch card to read
 *  from says what the timeline's card says; one without (the card is outside
 *  the loaded window) falls back to the producer's description. */
const SubAgentRunRow = memo(function SubAgentRunRow({
  run,
  onNavigate,
}: {
  run: LiveSubAgentRun
  onNavigate: () => void
}) {
  return run.part ? (
    <SubAgentCardRunRow run={run} part={run.part} onNavigate={onNavigate} />
  ) : (
    <SubAgentRunLine
      title={run.description}
      background={run.background}
      startedAt={run.startedAt}
      meta={null}
      onOpen={null}
    />
  )
})

function SubAgentCardRunRow({
  run,
  part,
  onNavigate,
}: {
  run: LiveSubAgentRun
  part: AdaptedToolCallPart
  onNavigate: () => void
}) {
  const model = useAgentCallModel(part)
  const { openChildSession, viewerHost } = model
  // Only through the transcript's viewer host: without one the model would
  // open the drawer inside this row, which goes as the list closes.
  const onOpen = useMemo(
    () =>
      openChildSession && viewerHost
        ? () => {
            onNavigate()
            openChildSession()
          }
        : null,
    [openChildSession, viewerHost, onNavigate]
  )
  return (
    <SubAgentRunLine
      title={model.title}
      background={run.background}
      startedAt={run.startedAt}
      meta={model.grokProgressLine}
      onOpen={onOpen}
    />
  )
}

function SubAgentRunLine({
  title,
  background,
  startedAt,
  meta,
  onOpen,
}: {
  title: string | null
  background: boolean
  startedAt: number | null
  meta: string | null
  onOpen: (() => void) | null
}) {
  const t = useTranslations("Folder.chat.liveRuns")
  const tSub = useTranslations("Folder.chat.subAgentOverlay")
  const elapsed = useElapsedSince(startedAt)
  const name = title || tSub("title")
  const details = [background ? t("background") : null, meta, elapsed].filter(
    Boolean
  ) as string[]
  const body = (
    <>
      <Bot aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      <span
        className="min-w-0 truncate font-medium text-foreground"
        title={name}
      >
        {name}
      </span>
      {details.length > 0 && (
        <span className="ms-auto shrink-0 text-muted-foreground/70 tabular-nums">
          {details.join(" · ")}
        </span>
      )}
    </>
  )
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        RUN_ROW_BOX,
        "w-full cursor-pointer text-start outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
      )}
    >
      {body}
    </button>
  ) : (
    <div className={RUN_ROW_BOX}>{body}</div>
  )
}

/** A codeg delegation: who runs it, what it was asked, how it stands
 *  ("waiting" while it is parked on a decision). Opens the child's
 *  conversation. No stop — that is the parent agent's (`cancel_delegation`). */
function DelegationRunRow({
  run,
  onNavigate,
}: {
  run: LiveDelegationRun<DelegationBinding>
  onNavigate: () => void
}) {
  return run.binding ? (
    <BoundDelegationRunRow binding={run.binding} onNavigate={onNavigate} />
  ) : (
    <UnboundDelegationRunRow />
  )
}

function BoundDelegationRunRow({
  binding,
  onNavigate,
}: {
  binding: DelegationBinding
  onNavigate: () => void
}) {
  const viewerHost = useSessionViewerHost()
  const source = useMemo<DelegationCardSource>(
    () => ({
      parentToolUseId: binding.parentToolUseId,
      taskIdHint: binding.taskId,
    }),
    [binding.parentToolUseId, binding.taskId]
  )
  const { identity, task, status, errorCode, childConversationId } =
    useDelegationCardModel(source)
  const body = (
    <>
      <DelegationIdentityAvatar identity={identity} size="overlay" />
      <DelegationIdentityName
        identity={identity}
        className="shrink-0 font-medium text-foreground"
      />
      {task ? (
        <span className="min-w-0 truncate text-muted-foreground" title={task}>
          {task}
        </span>
      ) : null}
      <span className="ms-auto shrink-0">
        <StatusBadge status={status} errorCode={errorCode} />
      </span>
    </>
  )
  // The viewer lives on the transcript (`SessionViewerHost`), so it outlasts
  // this row — which goes as soon as the list closes.
  return viewerHost && childConversationId != null ? (
    <button
      type="button"
      onClick={() => {
        onNavigate()
        viewerHost.open({ kind: "delegation", source })
      }}
      className={cn(
        RUN_ROW_BOX,
        "w-full cursor-pointer text-start outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
      )}
    >
      {body}
    </button>
  ) : (
    <div className={RUN_ROW_BOX}>{body}</div>
  )
}

/** A delegation whose call never got a card (its tool call could not be
 *  identified): nothing names it but the backend's word that it runs. */
function UnboundDelegationRunRow() {
  const t = useTranslations("Folder.chat.liveRuns")
  return (
    <div className={RUN_ROW_BOX}>
      <Bot aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 truncate font-medium text-foreground">
        {t("delegatedFallback")}
      </span>
    </div>
  )
}

/** Whether any listed delegation's child is parked on a decision — the chip's
 *  amber mark. Read from the child connections the parent attached (a
 *  delegation's child IS a connection in the store); `false` outside one. */
function useDelegationsAwaitingUser(
  delegations: readonly LiveDelegationRun<DelegationBinding>[]
): boolean {
  const store = useOptionalConnectionStore()
  const key = delegations.map((run) => run.childConnectionId).join("\n")
  const ids = useMemo(() => (key ? key.split("\n") : []), [key])
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!store) return () => {}
      const offs = ids.map((id) => store.subscribeKey(id, cb))
      return () => {
        for (const off of offs) off()
      }
    },
    [store, ids]
  )
  const getSnapshot = useCallback(
    () =>
      store != null &&
      ids.some((id) => blockingPrompts(store.getConnection(id)) != null),
    [store, ids]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** "3m 5s" since `startedAt`, ticking every second; `null` without one. */
function useElapsedSince(startedAt: number | null): string | null {
  const t = useTranslations("Folder.chat.liveTurnStats")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt == null ? null : formatElapsedLabel(now - startedAt, t)
}
