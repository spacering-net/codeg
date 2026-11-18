"use client"

/** The activity tab: on the primary, today; its open matters by whom each
 *  waits on; its routines. */

import { useTranslations } from "next-intl"
import { Inbox } from "lucide-react"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import type { PersonalAgentSnapshot } from "@/lib/types"
import { useToday } from "@/stores/personal-agent-today-store"

import { PanelEmpty, PanelSection } from "../../panel-section"
import { RoutinesSection } from "../../routines-section"
import { TodaySection } from "../../today-section"
import { WorkSection, MatterCard } from "./work-cards"
import { WorkSkeleton, TabBody } from "../tab-body"
import { GROUPS, useWork, useNow } from "../use-work"

/** The open matters, by whom each waits on: the activity's middle. */
function WorkBody({
  work,
  inDrawer,
}: {
  work: ReturnType<typeof useWork>
  inDrawer: boolean
}) {
  const t = useTranslations("PersonalAgent")
  const now = useNow()
  if (work == null) return <WorkSkeleton />
  const { open } = work
  if (open.length === 0) {
    return <PanelEmpty icon={Inbox}>{t("matters.noneOpen")}</PanelEmpty>
  }
  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map((g) => {
        const list = open.filter((m) => m.group === g)
        if (list.length === 0) return null
        return (
          <WorkSection
            key={g}
            group={g}
            label={t(`items.waits.${g}`)}
            count={list.length}
          >
            {list.map((m) => (
              <MatterCard key={m.key} m={m} inDrawer={inDrawer} now={now} />
            ))}
          </WorkSection>
        )
      })}
    </div>
  )
}

/** What it is about: on the primary, today; its open matters, its
 *  routines. */
export function ActivityTab({
  snapshot,
  work,
  inDrawer,
}: {
  snapshot: PersonalAgentSnapshot
  work: ReturnType<typeof useWork>
  inDrawer: boolean
}) {
  const t = useTranslations("PersonalAgent.detail")
  const { botId } = usePersonalAgent()
  const readOnly = snapshot.status.engine !== "here"
  // "Today" is the primary's: every assistant's, held while it shows.
  const today = useToday(botId == null)
  return (
    <TabBody>
      {botId == null ? (
        <TodaySection
          title={t("sections.today")}
          today={today}
          inDrawer={inDrawer}
          readOnly={readOnly}
        />
      ) : null}
      <PanelSection
        title={t("sections.matters")}
        count={work?.open.length ?? null}
        data-pa-detail="matters"
      >
        <WorkBody work={work} inDrawer={inDrawer} />
      </PanelSection>
      <RoutinesSection title={t("sections.routines")} readOnly={readOnly} />
    </TabBody>
  )
}
