"use client"

/** The workspace tab: the work running now, each a card — who runs it, where
 *  it stands, and the way to its session. */

import { useTranslations } from "next-intl"
import { Monitor } from "lucide-react"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
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
import type {
  DispatchInfo,
  DispatchState,
  PersonalAgentSnapshot,
} from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { cn } from "@/lib/utils"

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

/** The states a dispatch counts as running in. */
const RUNNING: ReadonlySet<DispatchState> = new Set([
  "running",
  "waiting_input",
])

/** The work running now, each a card — who runs it and where it stands, and
 *  a button that opens its session; an empty window, its face asleep in it,
 *  when nothing runs. The session itself is not shown here. */
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
  const running = (work?.open ?? [])
    .map((m) => m.dispatch)
    .filter((d): d is DispatchInfo => d != null && RUNNING.has(d.state))
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
      <div className="flex flex-col gap-2 px-4 pt-1 pb-6">
        {running.map((d) => {
          const target = workTargetOf(d)
          const canOpen = canOpenWork(target)
          return (
            <Card
              key={d.id}
              data-pa-workspace-item={d.id}
              className={cn(PANEL_SURFACE, "min-w-0 gap-0 py-0 ring-0")}
            >
              <div className="flex min-w-0 items-start gap-2.5 px-3 py-2.5">
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
                    data-pa-workspace-open={d.id}
                    onClick={() => openWork(target)}
                  >
                    {t("viewSession")}
                  </Button>
                ) : null}
              </div>
            </Card>
          )
        })}
      </div>
    </ScrollArea>
  )
}

/** A window's bar: the strip over what it shows — the panel's card bar. */
const WindowBar = PanelBar
