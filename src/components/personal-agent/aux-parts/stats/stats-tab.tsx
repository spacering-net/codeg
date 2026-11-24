"use client"

/** The stats tab: how it runs — a card of what it runs on, a card of its
 *  context — then its numbers over a range picked from their title (the
 *  last 14 days at first, 7 or 30), kept on this device. */

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { PersonalAgentSnapshot } from "@/lib/types"

import { ViewSelect } from "../kit/view-select"
import { TabBody } from "../tab-body"
import { ContextSection } from "./context-section"
import { RuntimeCard } from "./runtime-card"
import {
  DEFAULT_RANGE,
  STATS_RANGES,
  StatsBody,
  type StatsRange,
} from "./stats-body"

/** Where the range picked is kept on this device. */
const RANGE_KEY = "codeg:personal-agent:stats-days"

function readRange(): StatsRange {
  try {
    const v = Number(window.localStorage.getItem(RANGE_KEY))
    return (STATS_RANGES as readonly number[]).includes(v)
      ? (v as StatsRange)
      : DEFAULT_RANGE
  } catch {
    return DEFAULT_RANGE
  }
}

export function StatsTab({ snapshot }: { snapshot: PersonalAgentSnapshot }) {
  const td = useTranslations("PersonalAgent.data")
  const readOnly = snapshot.status.engine !== "here"
  const [days, setDays] = useState<StatsRange>(readRange)
  const pick = (next: StatsRange) => {
    setDays(next)
    try {
      window.localStorage.setItem(RANGE_KEY, String(next))
    } catch {
      // A private window: kept for this visit only.
    }
  }
  return (
    <TabBody>
      <section
        className="flex min-w-0 flex-col gap-4 text-sm"
        data-pa-detail="status"
      >
        <RuntimeCard snapshot={snapshot} readOnly={readOnly} />
        <ContextSection snapshot={snapshot} readOnly={readOnly} />
      </section>
      {/* The range in the middle, as far from the cards above it as from
          those under it. */}
      <section className="flex min-w-0 flex-col gap-4" data-pa-detail="data">
        <ViewSelect
          value={String(days)}
          onChange={(v) => pick(Number(v) as StatsRange)}
          menuLabel={td("rangeMenu")}
          clearLabel={td("range", { days: DEFAULT_RANGE })}
          clearable={false}
          choices={STATS_RANGES.map((n) => ({
            value: String(n),
            label: td("range", { days: n }),
            count: null,
          }))}
        />
        <StatsBody
          days={days}
          face={
            snapshot.agent?.avatar?.kind === "face"
              ? snapshot.agent.avatar.color
              : null
          }
        />
      </section>
    </TabBody>
  )
}
