"use client"

/**
 * An assistant's own page (13.1), in place of its conversation, the roster
 * kept beside it — laid out as the first setup is, over a soft wash of its
 * face's colour, its own width deciding how:
 *
 * - wide enough (56rem of its own), two parts: on the left who it is — its
 *   face and its name, changed where they are, what it is and what it does
 *   now, and [Chat with it] — held in the middle of the height; on the
 *   right its tabs, "Identity & brain", "Persona & memory",
 *   "Notifications", "Advanced", which alone scroll;
 * - narrow, one column: who it is, then the tabs, the page scrolling.
 *
 * The arrow in its corner goes back to the conversation, and so does
 * picking an assistant on the roster. (With no assistant set up yet the
 * page shows the first setup instead.)
 *
 * Whose it is shows at once — the roster has every assistant's face and
 * name — while the tabs wait for the assistant to be read: never another's
 * settings under its name. Read-only while the engine runs in another codeg
 * process.
 */

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  usePersonalAgent,
  usePersonalAgentSwitch,
} from "@/contexts/personal-agent-context"
import { cn } from "@/lib/utils"
import { useRoster } from "@/stores/personal-agent-roster-store"
import {
  usePersonalAgentUi,
  type BotTab,
} from "@/stores/personal-agent-ui-store"

import { defaultFaceOf } from "../bot-avatar"
import { useBotLook, useBotName } from "../shared"
import { usePendingFace, useSaveFace } from "../face-save"
import { BotHero } from "./bot-hero"
import { IdentityPage } from "./identity-page"
import { NotifyPage } from "./notify-page"
import { AdvancedPage, PersonaPage } from "./own-pages"
import { useWide } from "./setup-frame"

/** From this width of its own, in rem, it is two parts. */
const WIDE_REM = 56

/** The tabs' column, side by side: as wide as their settings read well. */
const TABS_COLUMN = "w-full max-w-[40rem]"

const ENTER =
  "duration-500 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3"

export function BotPage() {
  const t = useTranslations("PersonalAgent.settings")
  const tp = useTranslations("PersonalAgent.botPage")
  const open = usePersonalAgentUi((s) => s.botPage)
  const viewBot = usePersonalAgentUi((s) => s.viewBot)
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  const showConversation = usePersonalAgentUi((s) => s.showConversation)
  const { snapshot, botId } = usePersonalAgent()
  const { switching } = usePersonalAgentSwitch()
  const entries = useRoster()
  const botName = useBotName()

  // The assistant picked: the roster's, at once; its settings once read.
  const entry =
    entries?.find((e) =>
      viewBot == null ? e.kind === "primary" : e.id === viewBot
    ) ?? null
  const read = switching ? null : snapshot
  const agent = read?.agent ?? null
  const kind = entry?.kind ?? agent?.kind ?? "primary"
  const worker = kind === "worker"
  const setUp = entry != null || agent != null
  const look = useBotLook(entry?.id ?? agent?.id ?? null)
  const readOnly = read != null && read.status.engine !== "here"
  const frameRef = useRef<HTMLDivElement>(null)
  const wide = useWide(frameRef, WIDE_REM)
  const face = usePendingFace(
    entry?.id ?? agent?.id ?? null,
    entry?.avatar ?? agent?.avatar ?? null
  )
  const saveFace = useSaveFace(botId, face.pick)

  // Not known yet (an assistant being read with no roster yet): nothing.
  const name = setUp ? botName(entry ?? agent) : ""
  const role = worker ? tp("worker") : tp("primary")
  const brain = agent?.label_snapshot?.agent ?? null
  const subtitle = setUp ? [role, brain].filter(Boolean).join(" · ") : ""

  const tabs: BotTab[] = ["identity", "persona", "notify", "advanced"]
  const asked = open?.tab ?? "identity"
  const tab = tabs.includes(asked) ? asked : "identity"

  const body = (which: BotTab) => {
    if (!agent) return null
    switch (which) {
      case "identity":
        return (
          <IdentityPage
            key={agent.id}
            agent={agent}
            bot={botId}
            disabled={readOnly}
          />
        )
      case "persona":
        return (
          <PersonaPage
            key={agent.id}
            bot={botId}
            entry={open?.entry ?? null}
            unwritten={entry?.persona_unwritten ?? false}
          />
        )
      case "notify":
        return <NotifyPage agent={agent} disabled={readOnly} />
      case "advanced":
        return <AdvancedPage agent={agent} bot={botId} disabled={readOnly} />
    }
  }

  const hero = (
    <BotHero
      read={read}
      name={name}
      avatar={face.shown}
      onAvatar={agent && !readOnly ? saveFace : undefined}
      resetTo={defaultFaceOf(entry ?? agent)}
      primary={setUp && kind === "primary"}
      subtitle={subtitle}
      look={setUp ? look : null}
      readOnly={readOnly}
    />
  )
  const readOnlyNote = readOnly ? (
    <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
      {t("readOnly")}
    </p>
  ) : null
  const tabList = setUp ? (
    // Over a hairline, its underline on it; sideways when narrow.
    <div className="border-b border-border/60">
      <TabsList
        variant="line"
        aria-label={name}
        className="-mb-px flex h-auto max-w-full justify-start gap-6 overflow-x-auto p-0 pb-px [scrollbar-width:none] group-data-horizontal/tabs:h-auto"
      >
        {tabs.map((v) => (
          <TabsTrigger
            key={v}
            value={v}
            data-pa-bot-tab={v}
            className="h-auto flex-none rounded-none px-0 pt-1 pb-3 text-sm group-data-horizontal/tabs:after:-bottom-px"
          >
            {t(`nav.${v}` as "nav.identity")}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  ) : null
  const bodies = setUp
    ? tabs.map((v) => (
        <TabsContent key={v} value={v} data-pa-bot-tab-body={v}>
          {v === tab ? body(v) : null}
        </TabsContent>
      ))
    : body("identity")

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => openBotPage(v as BotTab)}
      className="h-full min-h-0 gap-0"
      data-pa-bot-page={tab}
    >
      <div
        ref={frameRef}
        className="relative h-full min-h-0 overflow-hidden"
        data-pa-bot-frame
        data-pa-face={
          face.shown?.kind === "face" ? face.shown.color : undefined
        }
        data-wide={wide || undefined}
        data-pa-bot-page-layout={wide ? "wide" : "narrow"}
      >
        <div
          aria-hidden
          className="pa-setup-wash pointer-events-none absolute inset-0"
        />
        {/* One tree both ways, the tabs' bodies at the same place in it:
            crossing the width that splits it keeps what is being changed
            on a tab (a brain picked, not saved yet). */}
        <div
          className={cn(
            "relative h-full min-h-0",
            wide && "grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          )}
        >
          {wide ? (
            // Who it is: held in the middle of the height, a scroller of
            // its own only for a frame too short to hold it.
            <ScrollArea className="h-full min-h-0">
              <div className="flex min-h-full items-center justify-center px-8 py-12">
                <div className={`w-full max-w-[22rem] ${ENTER}`}>{hero}</div>
              </div>
            </ScrollArea>
          ) : null}
          <div className="flex h-full min-h-0 flex-col">
            {wide ? (
              // Side by side, the tabs' row held at the top, what they
              // hold alone scrolling.
              <div className="shrink-0 ps-4 pe-8 pt-10">
                <div className={TABS_COLUMN}>{tabList}</div>
              </div>
            ) : null}
            <ScrollArea className="min-h-0 flex-1">
              <div
                className={
                  wide
                    ? "ps-4 pe-8 pt-6 pb-12"
                    : "mx-auto w-full max-w-3xl px-4 pt-12 pb-10 sm:px-6"
                }
              >
                {wide ? null : <div className={ENTER}>{hero}</div>}
                {wide ? null : <div className="mt-10">{tabList}</div>}
                <div className={wide ? TABS_COLUMN : "pt-6"}>
                  {readOnlyNote}
                  {bodies}
                </div>
              </div>
            </ScrollArea>
          </div>
        </div>
        {/* Back to the conversation, from the page's corner. */}
        <Button
          size="icon-sm"
          variant="ghost"
          className="absolute start-3 top-3 text-muted-foreground hover:text-foreground"
          onClick={showConversation}
          title={t("back")}
          aria-label={t("back")}
          data-pa-bot-page-back
        >
          <ArrowLeft className="rtl:rotate-180" aria-hidden />
        </Button>
      </div>
    </Tabs>
  )
}
