"use client"

/**
 * The roster, for now (4.12; the full one — states, order, pinning,
 * groups — comes with 1.7): the primary on top with its star, the work
 * assistants under it, and [+] to make one. Picking one shows its
 * conversation. On a narrow screen it is a strip of faces over the page.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useBotId } from "@/contexts/personal-agent-context"
import type { PersonalAgentBotSummary } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "./bot-avatar"
import { NewBotDialog } from "./new-bot-dialog"
import { useBots } from "./settings/use-settings"
import { useBotName } from "./shared"

export function PersonalAgentRoster({
  compact,
  readOnly,
}: {
  /** A strip of faces (a narrow screen). */
  compact: boolean
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent.bots.roster")
  const bots = useBots()
  const botName = useBotName()
  const viewBot = usePersonalAgentUi((s) => s.viewBot)
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const pageBot = useBotId()
  const [adding, setAdding] = useState(false)
  const list = bots ?? []
  // The one shown was deleted (here or in another window): back to the
  // primary.
  useEffect(() => {
    if (bots && viewBot != null && !bots.some((b) => b.id === viewBot)) {
      setViewBot(null)
    }
  }, [bots, viewBot, setViewBot])
  const current = (b: PersonalAgentBotSummary) =>
    b.kind === "primary"
      ? viewBot == null || viewBot === b.id
      : pageBot === b.id
  const go = (b: PersonalAgentBotSummary) =>
    setViewBot(b.kind === "primary" ? null : b.id)

  const add = (
    <Button
      size={compact ? "icon-sm" : "xs"}
      variant="ghost"
      disabled={readOnly}
      aria-label={t("add")}
      title={t("add")}
      onClick={() => setAdding(true)}
      data-pa-roster-add
    >
      <Plus aria-hidden />
      {compact ? null : t("addShort")}
    </Button>
  )

  return (
    <>
      {compact ? (
        <div
          data-pa-roster
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-2 py-1.5"
        >
          {list.map((b) => (
            <button
              key={b.id}
              type="button"
              data-pa-roster-bot={b.id}
              aria-current={current(b) ? "page" : undefined}
              aria-label={botName(b)}
              title={botName(b)}
              onClick={() => go(b)}
              className={cn(
                "shrink-0 rounded-full p-0.5 transition-colors",
                current(b) ? "bg-accent ring-1 ring-ring" : "hover:bg-muted"
              )}
            >
              <BotAvatar
                avatar={b.avatar}
                name={botName(b)}
                size={28}
                star={b.kind === "primary"}
              />
            </button>
          ))}
          {add}
        </div>
      ) : (
        <nav
          data-pa-roster
          aria-label={t("title")}
          className="flex w-48 shrink-0 flex-col border-e border-border/50"
        >
          <div className="flex items-center justify-between px-3 pt-3 pb-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("title")}
            </span>
            {add}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {list.map((b) => (
              <button
                key={b.id}
                type="button"
                data-pa-roster-bot={b.id}
                aria-current={current(b) ? "page" : undefined}
                onClick={() => go(b)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors",
                  current(b)
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground/80 hover:bg-muted"
                )}
              >
                <BotAvatar
                  avatar={b.avatar}
                  name={botName(b)}
                  size={b.kind === "primary" ? 32 : 28}
                  star={b.kind === "primary"}
                />
                <span className="min-w-0 flex-1 truncate">{botName(b)}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
      <NewBotDialog open={adding} onOpenChange={setAdding} />
    </>
  )
}
