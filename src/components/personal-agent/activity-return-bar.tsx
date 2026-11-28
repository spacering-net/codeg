"use client"

/** "← From the activity · N more wait on you · Back to the activity" (7.6):
 *  at the top of where a row of the drawer's activity led, while the way
 *  back stands (`personal-agent-return-store`). Gone once they go back, go
 *  elsewhere, ten minutes pass, or nothing waits on them. */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { readGroups } from "@/lib/activity-groups"
import { personalAgentActivity } from "@/lib/api"
import { ACTIVITY_POLL_MS } from "@/stores/personal-agent-activity-store"
import {
  clearReturn,
  RETURN_MAX_MS,
  returnStands,
  useActivityReturn,
} from "@/stores/personal-agent-return-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

export function ActivityReturnBar() {
  const from = useActivityReturn((s) => s.from)
  // What still waits on the owner in the activity it came from — read on
  // its own: the page may be showing another assistant's by now, whose
  // list the shared read follows.
  // Kept with the leaving it was read for: one of an earlier way back
  // says nothing of this one.
  const [count, setCount] = useState<{ at: number; n: number } | null>(null)
  const bot = from?.bot ?? null
  const since = from?.at ?? null
  useEffect(() => {
    if (since == null) return
    let live = true
    const read = () => {
      personalAgentActivity(bot)
        .then((view) => {
          if (live) setCount({ at: since, n: readGroups(view).waiting })
        })
        .catch(() => {})
    }
    read()
    const timer = setInterval(read, ACTIVITY_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [bot, since])
  const waiting = count != null && count.at === since ? count.n : null
  const t = useTranslations("PersonalAgent.feed.back")
  const [now, setNow] = useState(() => Date.now())
  // Its ten minutes run out on their own.
  useEffect(() => {
    if (!from) return
    const left = from.at + RETURN_MAX_MS - Date.now()
    if (left <= 0) {
      clearReturn()
      return
    }
    const timer = setTimeout(() => {
      setNow(Date.now())
      clearReturn()
    }, left)
    return () => clearTimeout(timer)
  }, [from])
  // Gone elsewhere — the settings, an assistant's page — or back at the
  // activity some other way: no way back to offer.
  const elsewhere = usePersonalAgentUi(
    (s) => s.settings != null || s.botPage != null
  )
  const backAlready = usePersonalAgentUi(
    (s) => s.auxOpen && s.auxTab === "activity"
  )
  const inDrawer = from != null
  useEffect(() => {
    if (inDrawer && (elsewhere || backAlready)) clearReturn()
  }, [inDrawer, elsewhere, backAlready])

  // Nothing waits on them any more: no way back to offer.
  useEffect(() => {
    if (from && waiting === 0) clearReturn()
  }, [from, waiting])
  if (!returnStands(from, now) || waiting == null || waiting === 0) {
    return null
  }
  const back = () => {
    const bot = from?.bot ?? null
    clearReturn()
    const ui = usePersonalAgentUi.getState()
    // The activity it came from: the page's assistant it was then.
    ui.setViewBot(bot)
    ui.showAux("activity")
  }
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground"
      data-pa-return-bar
    >
      <ArrowLeft aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {t("line", { count: waiting })}
      </span>
      <Button
        size="xs"
        variant="outline"
        className="shrink-0 bg-background"
        onClick={back}
        data-pa-return-back
      >
        {t("go")}
      </Button>
    </div>
  )
}

/** The way back as a button where a row led to work's own drawer (7.6):
 *  the drawer closes, and the activity it came from opens. */
export function ActivityReturnButton() {
  const from = useActivityReturn((s) => s.from)
  const t = useTranslations("PersonalAgent.feed.back")
  // Its ten minutes are kept by the bar on the page under the drawer.
  if (!from) return null
  const back = () => {
    const bot = from?.bot ?? null
    clearReturn()
    const ui = usePersonalAgentUi.getState()
    ui.setWorkOpen(false)
    ui.setViewBot(bot)
    ui.showAux("activity")
  }
  return (
    <Button size="xs" variant="outline" onClick={back} data-pa-return-back>
      <ArrowLeft aria-hidden />
      {t("go")}
    </Button>
  )
}
