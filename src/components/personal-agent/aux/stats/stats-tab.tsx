"use client"

/** The stats tab: how it runs, then its numbers. */

import { useTranslations } from "next-intl"
import type { PersonalAgentSnapshot } from "@/lib/types"

import { PanelFolds, PanelSection } from "../../panel-section"
import { ContextSection } from "./context-section"
import { RunLogSection, DetailsSection } from "./run-log"
import { STATS_DAYS, StatsBody } from "./stats-body"
import { StatusRows } from "./status-rows"
import { TabBody } from "../tab-body"

/** How it runs — what on, its context, its run log and details — then its
 *  numbers. */
export function StatsTab({ snapshot }: { snapshot: PersonalAgentSnapshot }) {
  const td = useTranslations("PersonalAgent.data")
  const ts = useTranslations("PersonalAgent.status")
  const readOnly = snapshot.status.engine !== "here"
  return (
    <TabBody>
      {/* How it runs: its rows under the tabs, no heading of their own,
          then the folding cards. */}
      <section
        className="flex min-w-0 flex-col gap-2.5 text-sm"
        data-pa-detail="status"
      >
        {readOnly ? (
          <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
            {ts("elsewhere")}
          </p>
        ) : null}
        <StatusRows snapshot={snapshot} readOnly={readOnly} />
        <ContextSection snapshot={snapshot} readOnly={readOnly} />
        {/* What happened to it and the rest of how it runs, folded, on
            one card. */}
        <PanelFolds>
          <RunLogSection />
          <DetailsSection snapshot={snapshot} />
        </PanelFolds>
      </section>
      <PanelSection
        title={td("range", { days: STATS_DAYS })}
        data-pa-detail="data"
      >
        <StatsBody
          face={
            snapshot.agent?.avatar?.kind === "face"
              ? snapshot.agent.avatar.color
              : null
          }
        />
      </PanelSection>
    </TabBody>
  )
}
