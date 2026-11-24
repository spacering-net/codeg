"use client"

/** The workspace tab: the work running now, each a window with its live
 *  view. */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Monitor } from "lucide-react"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { LiveTranscriptView } from "@/components/message/live-transcript-view"
import { TaskTranscriptView } from "@/components/tasks/task-transcript-dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { useTasksView } from "@/contexts/tasks-view-context"
import type {
  DispatchInfo,
  DispatchState,
  PersonalAgentSnapshot,
} from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { PANEL_SURFACE, PanelBar } from "../../panel-section"
import {
  canOpenWork,
  WorkGlyph,
  useOpenWork,
  useWorkMeta,
  workTargetOf,
} from "../../shared"
import { BotAvatar } from "../../bot-avatar"
import { LadderChip } from "../../task-strip"
import { ROW_AVATAR_SIZE } from "../activity/work-cards"
import { useWork, useNow } from "../use-work"

/** Its face on the workspace's empty screen, in px at 100% zoom. */
const WORKSPACE_FACE = 44

/** The states a dispatch's conversation streams in. */
const STREAMING: ReadonlySet<DispatchState> = new Set([
  "running",
  "waiting_input",
])

/** A chat or session dispatch's conversation, live: its connection
 *  attached (hydrated, forward only) while the preview is shown, as the work
 *  drawer does. */
function ConversationPreview({ d }: { d: DispatchInfo }) {
  const { attachDelegationChild, detachDelegationChild } = useAcpActions()
  const agentType = d.work.agent_type
  const liveId = STREAMING.has(d.state) ? d.connection_id : null
  const [attachId, setAttachId] = useState<string | null>(liveId)
  if (liveId !== null && liveId !== attachId) setAttachId(liveId)
  useEffect(() => {
    if (attachId == null || agentType == null) return
    attachDelegationChild({
      connectionId: attachId,
      parentConnectionId: attachId,
      parentToolUseId: `personal-agent-dispatch-${d.id}`,
      agentType,
      hydrate: true,
    })
    return () => detachDelegationChild(attachId)
  }, [attachId, agentType, d.id, attachDelegationChild, detachDelegationChild])
  if (d.conversation_id == null || agentType == null) return null
  return (
    <LiveTranscriptView
      conversationId={d.conversation_id}
      connectionId={attachId}
      agentType={agentType}
    />
  )
}

/** A task dispatch's session, live, from the board's task. */
function TaskPreview({ taskId }: { taskId: number }) {
  const { tasks } = useTasksView()
  const task = tasks.find((x) => x.id === taskId) ?? null
  if (!task || task.conversation_id == null) return null
  return <TaskTranscriptView task={task} />
}

/** The work running now, each a window with a small live view of its
 *  session — its head who runs it and where it stands, the way to open it,
 *  the view itself opening it too; an empty window, its face asleep in it,
 *  when nothing runs. While the drawer shows one of them, the previews
 *  stand aside: one surface follows a connection at a time. */
export function WorkspaceTab({
  snapshot,
  work,
}: {
  snapshot: PersonalAgentSnapshot
  work: ReturnType<typeof useWork>
}) {
  const t = useTranslations("PersonalAgent.detail.workspace")
  const tPage = useTranslations("PersonalAgent")
  const openWork = useOpenWork()
  const meta = useWorkMeta()
  const now = useNow()
  const agent = snapshot.agent
  const name = agent?.name?.trim() || tPage("title")
  const drawerOpen = usePersonalAgentUi((s) => s.workOpen)
  const running = (work?.open ?? [])
    .map((m) => m.dispatch)
    .filter((d): d is DispatchInfo => d != null && STREAMING.has(d.state))
  if (work == null) {
    return (
      <div className="px-4 pt-1" aria-hidden>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }
  // A window with nothing on it, its face asleep in it, as over the tabs;
  // whose it is on its bar.
  if (running.length === 0) {
    return (
      <div data-pa-workspace-empty className="px-4 pt-1">
        <div className={cn(PANEL_SURFACE, "overflow-hidden")}>
          <WindowBar>
            <Monitor
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
              {t("whose", { name })}
            </span>
          </WindowBar>
          <Empty className="gap-3 rounded-none bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:14px_14px] px-6 py-12">
            <EmptyHeader className="gap-1.5">
              {agent ? (
                <EmptyMedia className="mb-2">
                  <BotAvatar
                    avatar={agent.avatar}
                    name={name}
                    size={WORKSPACE_FACE}
                    look="sleeping"
                  />
                </EmptyMedia>
              ) : null}
              <EmptyTitle className="text-sm font-medium tracking-normal">
                {t("empty")}
              </EmptyTitle>
              <EmptyDescription className="text-xs/relaxed">
                {t("emptyHint")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </div>
    )
  }
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 px-4 pt-1 pb-6">
        {running.map((d) => {
          const target = workTargetOf(d)
          const canOpen = canOpenWork(target)
          return (
            <Card
              key={d.id}
              data-pa-workspace-item={d.id}
              className={cn(PANEL_SURFACE, "min-w-0 gap-0 py-0 ring-0")}
            >
              <WindowBar className="h-auto items-start gap-2.5 py-2">
                <WorkGlyph mode={d.mode} size={ROW_AVATAR_SIZE} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.8125rem] leading-5 font-medium">
                    #{d.id} {d.title}
                  </p>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <LadderChip ladder={d.ladder ?? null} />
                    <span className="min-w-0 truncate text-xs leading-5 text-muted-foreground">
                      {[
                        meta({
                          mode: d.mode,
                          folder: d.folder_name,
                        }),
                        getAgentLabel(d.work.agent_type) ?? d.work.agent_type,
                        formatRelative(d.updated_at, now),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                </div>
                {canOpen ? (
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => openWork(target)}
                  >
                    {t("open")}
                  </Button>
                ) : null}
              </WindowBar>
              {drawerOpen ? null : (
                <div className="relative">
                  <div
                    data-pa-workspace-preview={d.id}
                    className="pointer-events-none h-56 overflow-hidden text-xs [&_*]:select-none"
                  >
                    {d.mode === "task" ? (
                      d.work_task_id != null ? (
                        <TaskPreview taskId={d.work_task_id} />
                      ) : null
                    ) : (
                      <ConversationPreview d={d} />
                    )}
                  </div>
                  {/* The view fades out at its foot, and opens the work
                      as its button does. */}
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent"
                  />
                  {canOpen ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden
                      data-pa-workspace-open={d.id}
                      className="absolute inset-0 cursor-pointer outline-none"
                      onClick={() => openWork(target)}
                    />
                  ) : null}
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </ScrollArea>
  )
}

/** A window's bar: the strip over what it shows — the panel's card bar. */
const WindowBar = PanelBar
