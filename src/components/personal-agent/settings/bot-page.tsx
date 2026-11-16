"use client"

/**
 * An assistant's own page (13.1), in place of its conversation, the roster
 * kept beside it: its face, its name and what it is, over its tabs —
 * "Identity & brain", "Persona & memory", a work assistant's "Execution",
 * "Notifications", "Advanced". The arrow before its face goes back to the
 * conversation, and so does picking an assistant on the roster. With no
 * assistant set up yet, it is the first setup: the identity tab alone.
 *
 * Whose it is shows at once — the roster has every assistant's face and
 * name — while the tabs wait for the assistant to be read: never another's
 * settings under its name. Read-only while the engine runs in another codeg
 * process.
 */

import { useTranslations } from "next-intl"
import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  usePersonalAgent,
  usePersonalAgentSwitch,
} from "@/contexts/personal-agent-context"
import type { BotAvatar as BotAvatarValue } from "@/lib/types"
import { useRoster } from "@/stores/personal-agent-roster-store"
import {
  usePersonalAgentUi,
  type BotTab,
} from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "../bot-avatar"
import { useBotLook, useBotName } from "../shared"
import { useBotTemplates } from "../use-templates"
import { IdentityPage } from "./identity-page"
import { NotifyPage } from "./notify-page"
import { AdvancedPage, ExecutionPage, PersonaPage } from "./own-pages"

/** The face in the page's head, in px at 100% zoom. */
const HEAD_FACE = 48

/** The face of an assistant not set up yet (as the identity page's). */
const SETUP_FACE: BotAvatarValue = {
  kind: "face",
  shape: "blob",
  color: "black",
}

/** The column the head and the tabs' content share. */
const COLUMN = "mx-auto w-full max-w-3xl px-4 sm:px-6"

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
  const templates = useBotTemplates()
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

  const name = setUp ? botName(entry ?? agent) : t("setupTitle")
  const role = worker
    ? (templates?.find((x) => x.id === (entry?.template ?? agent?.template))
        ?.name ?? tp("worker"))
    : tp("primary")
  const brain = agent?.label_snapshot.agent ?? null
  const subtitle = setUp
    ? [role, brain].filter(Boolean).join(" · ")
    : tp("notSetUp")

  const tabs: BotTab[] = [
    "identity",
    "persona",
    ...(worker ? (["execution"] as const) : []),
    "notify",
    "advanced",
  ]
  const asked = open?.tab ?? "identity"
  const tab = tabs.includes(asked) ? asked : "identity"

  const body = (which: BotTab) => {
    if (!read) return null
    if (!agent) {
      // Not set up: the first setup, whatever tab was asked for.
      return (
        <IdentityPage
          key="setup"
          agent={null}
          bot={botId}
          disabled={readOnly}
        />
      )
    }
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
          <PersonaPage key={agent.id} bot={botId} entry={open?.entry ?? null} />
        )
      case "execution":
        return worker ? (
          <ExecutionPage agent={agent} bot={botId} disabled={readOnly} />
        ) : null
      case "notify":
        return <NotifyPage agent={agent} disabled={readOnly} />
      case "advanced":
        return <AdvancedPage agent={agent} bot={botId} disabled={readOnly} />
    }
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => openBotPage(v as BotTab)}
      className="flex h-full min-h-0 flex-col gap-0"
      data-pa-bot-page={tab}
    >
      <header
        className="shrink-0 border-b border-border/60"
        data-pa-bot-page-head
      >
        <div className={COLUMN}>
          <div className="flex items-center gap-3 pt-5" data-pa-face-host>
            {/* Back to the conversation: an arrow on the head's line, as a
                page under another has it. */}
            <Button
              size="icon-sm"
              variant="ghost"
              className="-ms-2 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={showConversation}
              title={t("back")}
              aria-label={t("back")}
              data-pa-bot-page-back
            >
              <ArrowLeft className="rtl:rotate-180" aria-hidden />
            </Button>
            <BotAvatar
              avatar={entry?.avatar ?? agent?.avatar ?? SETUP_FACE}
              name={name}
              size={HEAD_FACE}
              star={setUp && kind === "primary"}
              look={setUp ? look : undefined}
            />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg leading-7 font-semibold tracking-tight">
                {name}
              </h1>
              <p
                className="truncate text-[0.8125rem] leading-5 text-muted-foreground"
                data-pa-bot-page-subtitle
              >
                {subtitle}
              </p>
            </div>
          </div>
          {setUp ? (
            <TabsList
              variant="line"
              aria-label={name}
              // Over the head's bottom line, its underline on it; sideways
              // on a narrow screen.
              className="mt-5 -mb-px flex h-auto max-w-full gap-6 overflow-x-auto p-0 pb-px [scrollbar-width:none] group-data-horizontal/tabs:h-auto"
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
          ) : (
            <div className="h-5" />
          )}
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className={`${COLUMN} pt-6 pb-10`}>
          {readOnly ? (
            <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
              {t("readOnly")}
            </p>
          ) : null}
          {setUp
            ? tabs.map((v) => (
                <TabsContent key={v} value={v} data-pa-bot-tab-body={v}>
                  {v === tab ? body(v) : null}
                </TabsContent>
              ))
            : body("identity")}
        </div>
      </ScrollArea>
    </Tabs>
  )
}
