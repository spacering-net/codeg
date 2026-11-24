"use client"

/**
 * The personal agent page's side panel, under the window's top band as the
 * other full pages have it (the tasks' board). On top, who it is: its face,
 * alive, and its name, the bell that says whether it notifies the owner in
 * one corner and the "⋯" of what acts on it in the other; under them
 * shadcn's tabs (10.1), the first open by
 * default — each tab of shadcn's pieces (`panel-section.tsx`):
 * - Activity: one list, in four groups by what each thing means to the
 *   owner — what waits on them, what is under way, what comes next (its
 *   routines among it), what was done today — each thing once, as a row
 *   that unfolds (C1, `activity/activity-tab.tsx`): on the primary,
 *   every assistant's and the owner's own; on a work assistant's page,
 *   its own. A matter is settled on its row — done, put off (15 minutes,
 *   an hour, tomorrow morning, or with no set time), dropped. The tab
 *   counts what waits on the owner, from the same read (C6).
 * - Output: what it made, newest first — the work that ended (tasks, the
 *   reports of the rest) and the documents it wrote in its working
 *   directory — filtered by kind.
 * - Workspace: the work running now, each as a small live view of its
 *   session; a screen with its face asleep on it when nothing runs.
 * - Stats: how it runs, as Session Details shows a conversation — what it
 *   runs on, its state, model and mode, its session (which opens), its
 *   connection, its working directory (copyable) — then folding cards: its
 *   context, the run log, the details; then its numbers: the last two weeks
 *   in four figures, then the charts.
 *
 * Its own panel rather than the workspace's aux panel, which a full-page
 * route closes. Its pieces are the workspace panel's own where they can be
 * (Session Details' property rows and sections).
 */

import { useLayoutEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import type { PersonalAgentSnapshot } from "@/lib/types"
import { useActivity } from "@/stores/personal-agent-activity-store"
import { useChatMotion } from "@/hooks/use-chat-motion"
import {
  usePersonalAgentUi,
  type AuxTab,
} from "@/stores/personal-agent-ui-store"

import { ActivityTab } from "./aux-parts/activity/activity-tab"
import { AuxHead } from "./aux-parts/aux-head"
import { OutputTab } from "./aux-parts/output/output-tab"
import { StatsTab } from "./aux-parts/stats/stats-tab"
import { useWork } from "./aux-parts/use-work"
import { WorkspaceTab } from "./aux-parts/workspace/workspace-tab"

const TABS: readonly AuxTab[] = ["activity", "output", "workspace", "stats"]

export function PersonalAgentAuxPanel({
  snapshot,
  inDrawer = false,
}: {
  snapshot: PersonalAgentSnapshot
  /** In the narrow screen's drawer, whose close button sits at the top
   *  end. */
  inDrawer?: boolean
}) {
  const t = useTranslations("PersonalAgent.aux")
  const tabs = useTranslations("PersonalAgent.detail.tabs")
  const tab = usePersonalAgentUi((s) => s.auxTab)
  const setTab = usePersonalAgentUi((s) => s.setAuxTab)
  const work = useWork()
  const { botId, itemVersion, dispatchVersion, routineVersion } =
    usePersonalAgent()
  // What waits on the owner: the activity's own count (C6).
  const waiting =
    useActivity(botId, [itemVersion, dispatchVersion, routineVersion])
      ?.waiting ?? 0
  // Another assistant shown: its panel comes in, as its conversation does.
  const asideRef = useRef<HTMLElement | null>(null)
  const motion = useChatMotion()
  const agentId = snapshot.agent?.id ?? null
  const shownFor = useRef(agentId)
  useLayoutEffect(() => {
    if (shownFor.current === agentId) return
    shownFor.current = agentId
    if (!motion) return
    asideRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
      duration: 200,
      easing: "ease-out",
    })
  }, [agentId, motion])
  return (
    <aside
      ref={asideRef}
      data-pa-aux
      aria-label={t("title")}
      className="@container/aux flex h-full min-h-0 flex-col overflow-hidden"
    >
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as AuxTab)}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        <AuxHead snapshot={snapshot} inDrawer={inDrawer}>
          {/* shadcn's own tabs, the width of the panel: a word too long
              for a narrow one gives way at its end. */}
          <TabsList aria-label={t("title")} className="w-full">
            {TABS.map((value) => {
              const label = tabs(value)
              // What waits on the owner is in their activity: counted
              // there, for a pointer and a screen reader too.
              const count = value === "activity" ? waiting : 0
              const name =
                count > 0
                  ? `${label} · ${t("waiting", { count: waiting })}`
                  : label
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  title={name}
                  aria-label={name}
                  data-pa-aux-tab={value}
                  // Each as wide as its word, the rest shared: a longer
                  // word is not cut while the panel has room for it — on
                  // a narrow panel a size down, so two characters are not
                  // cut to one.
                  className="min-w-0 flex-auto px-1.5 @max-[18rem]/aux:px-1 @max-[18rem]/aux:text-[0.8125rem]"
                >
                  <span className="min-w-0 truncate">{label}</span>
                  {count > 0 ? (
                    <Badge
                      aria-hidden
                      className="h-4 min-w-4 bg-orange-500/15 px-1 text-[0.625rem] text-orange-700 tabular-nums dark:bg-orange-400/15 dark:text-orange-300"
                    >
                      {count}
                    </Badge>
                  ) : null}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </AuxHead>
        <TabsContent value="activity" className="mt-0 min-h-0 flex-1">
          <ActivityTab snapshot={snapshot} inDrawer={inDrawer} />
        </TabsContent>
        <TabsContent value="output" className="mt-0 min-h-0 flex-1">
          <OutputTab work={work} workdir={snapshot.status.workdir ?? null} />
        </TabsContent>
        <TabsContent value="workspace" className="mt-0 min-h-0 flex-1">
          <WorkspaceTab snapshot={snapshot} work={work} />
        </TabsContent>
        <TabsContent value="stats" className="mt-0 min-h-0 flex-1">
          <StatsTab snapshot={snapshot} />
        </TabsContent>
      </Tabs>
    </aside>
  )
}
