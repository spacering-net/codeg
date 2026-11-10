"use client"

/**
 * The settings, as a view of the assistants page in place of the
 * conversation (13.1). Two levels: "This assistant" — the one the page is
 * about, or a work assistant picked in the team's list — and "All
 * assistants", the same for every one: the team (work assistants, executor
 * configs, division of work) and the preferences. [Back to the
 * conversation] closes it. On a narrow screen the navigation folds into a
 * select at the top.
 *
 * Read-only while the engine runs in another codeg process — except the
 * executor configs themselves, which are not the engine's (how the
 * assistants use them is).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { getDelegationSettings } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  usePersonalAgentUi,
  type SettingsPage,
} from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "../bot-avatar"
import { useBotName } from "../shared"
import { IdentityPage } from "./identity-page"
import { AdvancedPage, ExecutionPage, PersonaPage } from "./own-pages"
import { AutomationPage, CommunicationPage } from "./pref-pages"
import { DivisionPage, ExecutorsPage, WorkersPage } from "./team-pages"
import { useTargetSnapshot } from "./use-settings"

interface NavGroup {
  label: string
  pages: { page: SettingsPage; disabled: boolean }[]
}

export function SettingsView() {
  const t = useTranslations("PersonalAgent.settings")
  const isMobile = useIsMobile()
  const settings = usePersonalAgentUi((s) => s.settings)
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const closeSettings = usePersonalAgentUi((s) => s.closeSettings)
  const { snapshot: pageSnapshot, botId: pageBot } = usePersonalAgent()
  /** Another assistant than the page's, picked in the team's list. */
  const bot =
    settings?.bot != null && settings.bot !== pageBot ? settings.bot : null
  /** Whose own pages these are, for what they save: the picked one, else
   *  the page's own (a work assistant's page is its own). */
  const target = bot ?? pageBot
  const { snapshot, failed } = useTargetSnapshot(bot)
  const botName = useBotName()
  const [delegation, setDelegation] = useState<boolean | null>(null)
  useEffect(() => {
    getDelegationSettings()
      .then((s) => setDelegation(s.enabled))
      .catch(() => setDelegation(null))
  }, [])

  const page = settings?.page ?? "identity"
  const agent = snapshot?.agent ?? null
  const primarySet = pageSnapshot?.agent != null
  const account = pageSnapshot?.account ?? snapshot?.account ?? null
  // A work assistant's own pages wait for its own snapshot: never another's.
  const targetPending = bot != null && snapshot == null
  const engineHere =
    (bot == null ? pageSnapshot : snapshot)?.status.engine === "here" ||
    (targetPending && pageSnapshot?.status.engine === "here")
  const readOnly = !engineHere
  const worker = agent?.kind === "worker"
  // The account's items need the primary set up, and the engine here.
  const accountLocked = readOnly || !primarySet
  const accountWhy = readOnly
    ? t("readOnly")
    : !primarySet
      ? t("setUpFirst")
      : null

  const groups: NavGroup[] = [
    {
      label: t("nav.thisAssistant"),
      pages: [
        { page: "identity", disabled: false },
        { page: "persona", disabled: !agent },
        ...(worker ? [{ page: "execution" as const, disabled: false }] : []),
        { page: "advanced", disabled: !agent },
      ],
    },
    {
      label: t("nav.team"),
      pages: [
        { page: "workers", disabled: false },
        { page: "executors", disabled: false },
        { page: "division", disabled: false },
      ],
    },
    {
      label: t("nav.prefs"),
      pages: [
        { page: "communication", disabled: false },
        { page: "automation", disabled: false },
      ],
    },
  ]
  const go = (p: SettingsPage) => openSettings(p, bot)

  const body = (() => {
    if (
      targetPending &&
      (page === "identity" ||
        page === "persona" ||
        page === "execution" ||
        page === "advanced")
    ) {
      return (
        <p
          className="py-8 text-center text-sm text-muted-foreground"
          data-pa-settings-pending
        >
          {failed ? t("targetFailed") : t("targetLoading")}
        </p>
      )
    }
    switch (page) {
      case "identity":
        return (
          <IdentityPage
            key={`${target ?? "page"}-${agent?.id ?? 0}`}
            agent={agent}
            bot={target}
            disabled={readOnly}
          />
        )
      case "persona":
        return agent ? <PersonaPage bot={target} /> : null
      case "execution":
        return agent && worker ? (
          <ExecutionPage agent={agent} bot={target} disabled={readOnly} />
        ) : null
      case "advanced":
        return agent ? (
          <AdvancedPage agent={agent} bot={target} disabled={readOnly} />
        ) : null
      case "workers":
        return <WorkersPage readOnly={accountLocked} readOnlyWhy={accountWhy} />
      case "executors":
        return (
          <ExecutorsPage
            account={account}
            usageReadOnly={accountLocked}
            usageReadOnlyWhy={accountWhy}
            delegationEnabled={delegation}
          />
        )
      case "division":
        return account ? (
          <DivisionPage account={account} disabled={accountLocked} />
        ) : null
      case "communication":
        return account ? (
          <CommunicationPage account={account} disabled={accountLocked} />
        ) : null
      case "automation":
        return account ? (
          <AutomationPage account={account} disabled={accountLocked} />
        ) : null
    }
  })()

  const targetName = agent ? botName(agent) : t("setupTitle")
  const ownPage = groups[0].pages.some((p) => p.page === page)

  return (
    <div className="flex h-full min-h-0 flex-col" data-pa-settings>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={closeSettings}
          data-pa-settings-back
        >
          <ArrowLeft className="rtl:rotate-180" aria-hidden />
          {t("back")}
        </Button>
        <span className="text-sm font-semibold">{t("viewTitle")}</span>
        {bot != null ? (
          <Button
            size="sm"
            variant="outline"
            className="ms-auto"
            onClick={() => openSettings(page, null)}
          >
            {t("backToOwn")}
          </Button>
        ) : null}
      </div>
      {readOnly ? (
        <p className="mx-3 mt-2 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
          {t("readOnly")}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {isMobile ? null : (
          <nav
            aria-label={t("viewTitle")}
            className="w-52 shrink-0 overflow-y-auto border-e border-border/50 p-2"
          >
            {groups.map((g, i) => (
              <div key={g.label} className={cn(i > 0 && "mt-3")}>
                {i === 0 ? (
                  <p className="flex items-center gap-1.5 px-2 pb-1 text-xs font-medium text-muted-foreground">
                    {agent ? (
                      <BotAvatar
                        avatar={agent.avatar}
                        name={targetName}
                        size={16}
                      />
                    ) : null}
                    <span className="truncate">
                      {g.label} · {targetName}
                    </span>
                  </p>
                ) : (
                  <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                    {i === 1 ? (
                      <span className="block pb-1 text-[0.6875rem] tracking-wide uppercase">
                        {t("nav.allAssistants")}
                      </span>
                    ) : null}
                    {g.label}
                  </p>
                )}
                {g.pages.map((p) => (
                  <button
                    key={p.page}
                    type="button"
                    disabled={p.disabled}
                    data-pa-nav={p.page}
                    aria-current={page === p.page ? "page" : undefined}
                    onClick={() => go(p.page)}
                    className={cn(
                      "block w-full rounded-md px-2 py-1.5 text-start text-sm transition-colors disabled:opacity-40",
                      page === p.page
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground/80 hover:bg-muted"
                    )}
                  >
                    {t(`nav.${p.page}` as "nav.identity")}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-2xl px-4 py-4">
            {isMobile ? (
              <Select value={page} onValueChange={(v) => go(v as SettingsPage)}>
                <SelectTrigger className="mb-3 h-9 w-full bg-background text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectGroup key={g.label}>
                      <SelectLabel className="text-2xs">{g.label}</SelectLabel>
                      {g.pages.map((p) => (
                        <SelectItem
                          key={p.page}
                          value={p.page}
                          disabled={p.disabled}
                        >
                          {t(`nav.${p.page}` as "nav.identity")}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {ownPage && bot != null && agent ? (
              <p className="mb-3 text-xs text-muted-foreground">
                {t("editingOther", { name: targetName })}
              </p>
            ) : null}
            {body}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
