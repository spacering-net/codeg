"use client"

/** The activity tab: on the primary, today; its open matters by whom each
 *  waits on; its routines. A part with nothing in it is one row with no head
 *  over it — the matters' and the routines' on one card when both are. */

import { useTranslations } from "next-intl"
import { Inbox } from "lucide-react"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import type { PersonalAgentSnapshot } from "@/lib/types"
import { useToday } from "@/stores/personal-agent-today-store"

import {
  PanelIcon,
  PanelItem,
  PanelSection,
  PanelStack,
} from "../../panel-section"
import {
  RoutinesEmptyRow,
  RoutinesSection,
  useRoutines,
} from "../../routines-section"
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

/** No open matters: a row saying so, its name leading it. */
function MattersEmptyRow({ title }: { title: string }) {
  const t = useTranslations("PersonalAgent")
  return (
    <PanelItem
      media={<PanelIcon icon={Inbox} />}
      title={title}
      meta={t("matters.noneOpen")}
      data-pa-detail="matters"
    />
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
  const routines = useRoutines()
  const noMatters = work != null && work.open.length === 0
  const noRoutines = routines != null && routines.length === 0
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
      {noMatters && noRoutines ? (
        <PanelStack>
          <MattersEmptyRow title={t("sections.matters")} />
          <RoutinesEmptyRow
            title={t("sections.routines")}
            readOnly={readOnly}
          />
        </PanelStack>
      ) : (
        <>
          {noMatters ? (
            <PanelStack>
              <MattersEmptyRow title={t("sections.matters")} />
            </PanelStack>
          ) : (
            <PanelSection
              title={t("sections.matters")}
              titleInCards
              data-pa-detail="matters"
            >
              <WorkBody work={work} inDrawer={inDrawer} />
            </PanelSection>
          )}
          <RoutinesSection
            title={t("sections.routines")}
            readOnly={readOnly}
            list={routines}
          />
        </>
      )}
    </TabBody>
  )
}
