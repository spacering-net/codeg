"use client"

/**
 * The settings every assistant shares (13.1), across the assistants page in
 * place of the conversation, the roster and the side panel: the team — the
 * work assistants and the executor configs their work runs on — and the
 * preferences. An assistant's own settings are on its own page
 * (`bot-page.tsx`). The navigation down the side under the title — its
 * rows pills — and [← Back to the conversation] over the title; on a
 * narrow screen it folds into a select at the top.
 *
 * Read-only while the engine runs in another codeg process — except the
 * executor configs themselves, which are not the engine's.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowLeft,
  BellRing,
  Bot,
  FolderGit2,
  MessagesSquare,
  UserRound,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react"

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

import { AboutPage } from "./about-page"
import { AutomationPage, CommunicationPage, ProactivePage } from "./pref-pages"
import { ProjectsPage } from "./projects-page"
import { ExecutorsPage, WorkersPage } from "./team-pages"

/** The navigation: the team, then the preferences. */
const GROUPS: { label: "team" | "prefs"; pages: SettingsPage[] }[] = [
  { label: "team", pages: ["workers", "executors"] },
  {
    label: "prefs",
    pages: ["communication", "projects", "proactive", "automation", "about"],
  },
]

const PAGE_ICONS: Record<SettingsPage, LucideIcon> = {
  workers: Users,
  executors: Bot,
  communication: MessagesSquare,
  projects: FolderGit2,
  proactive: BellRing,
  automation: Zap,
  about: UserRound,
}

export function SettingsView() {
  const t = useTranslations("PersonalAgent.settings")
  const isMobile = useIsMobile()
  const settings = usePersonalAgentUi((s) => s.settings)
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const showConversation = usePersonalAgentUi((s) => s.showConversation)
  const { snapshot } = usePersonalAgent()
  const [delegation, setDelegation] = useState<boolean | null>(null)
  useEffect(() => {
    getDelegationSettings()
      .then((s) => setDelegation(s.enabled))
      .catch(() => setDelegation(null))
  }, [])

  const page = settings?.page ?? "workers"
  const account = snapshot?.account ?? null
  const readOnly = snapshot?.status.engine !== "here"
  // The account's items need the primary set up, and the engine here.
  const primarySet = snapshot?.agent != null
  const accountLocked = readOnly || !primarySet
  const accountWhy = readOnly
    ? t("readOnly")
    : !primarySet
      ? t("setUpFirst")
      : null

  const body = (() => {
    switch (page) {
      case "workers":
        return <WorkersPage readOnly={accountLocked} readOnlyWhy={accountWhy} />
      case "executors":
        return <ExecutorsPage delegationEnabled={delegation} />
      case "communication":
        return account ? (
          <CommunicationPage account={account} disabled={accountLocked} />
        ) : null
      case "projects":
        return account ? (
          <ProjectsPage account={account} disabled={accountLocked} />
        ) : null
      case "proactive":
        return account ? (
          <ProactivePage account={account} disabled={accountLocked} />
        ) : null
      case "automation":
        return account ? (
          <AutomationPage account={account} disabled={accountLocked} />
        ) : null
      case "about":
        return account ? (
          <AboutPage account={account} disabled={accountLocked} />
        ) : null
    }
  })()

  // Back to the conversation: a pill saying so above the title, its arrow
  // in the column of the navigation's icons, as the title is in their
  // column of words' start.
  const back = (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-fit max-w-full shrink-0 gap-2 rounded-full ps-2.5 pe-3.5 font-normal text-muted-foreground hover:text-foreground"
      onClick={showConversation}
      data-pa-settings-back
    >
      <ArrowLeft className="size-4 shrink-0 rtl:rotate-180" aria-hidden />
      <span className="truncate">{t("back")}</span>
    </Button>
  )
  const title = (
    <div className="min-w-0 px-2.5" data-pa-settings-title>
      <h1 className="truncate text-xl leading-7 font-semibold tracking-tight">
        {t("viewTitle")}
      </h1>
      <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
        {t("viewSubtitle")}
      </p>
    </div>
  )

  return (
    <div className="flex h-full min-h-0" data-pa-settings>
      {isMobile ? null : (
        <aside
          className="flex w-60 shrink-0 flex-col border-e border-border/60"
          data-pa-settings-nav
        >
          <div className="flex flex-col gap-4 px-3 pt-3 pb-5">
            {back}
            {title}
          </div>
          <nav
            aria-label={t("viewTitle")}
            className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
          >
            {GROUPS.map((g, i) => (
              <div
                key={g.label}
                role="group"
                aria-label={t(`nav.${g.label}`)}
                className={cn(i > 0 && "mt-5")}
              >
                <p
                  aria-hidden
                  className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground"
                >
                  {t(`nav.${g.label}`)}
                </p>
                <div className="flex flex-col gap-0.5">
                  {g.pages.map((p) => {
                    const Icon = PAGE_ICONS[p]
                    const on = page === p
                    return (
                      <button
                        key={p}
                        type="button"
                        data-pa-nav={p}
                        aria-current={on ? "page" : undefined}
                        onClick={() => openSettings(p)}
                        className={cn(
                          "flex h-9 w-full items-center gap-2.5 rounded-full px-2.5 text-start text-sm transition-colors",
                          on
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-foreground/80 hover:bg-muted hover:text-foreground"
                        )}
                      >
                        <Icon
                          className={cn(
                            "size-4 shrink-0",
                            on ? "text-foreground" : "text-muted-foreground"
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 truncate">
                          {t(`nav.${p}`)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div
          className="mx-auto w-full max-w-3xl px-4 pt-4 pb-12 sm:px-8 sm:pt-6"
          data-pa-settings-body
        >
          {isMobile ? (
            <div className="mb-5 flex flex-col gap-3">
              <div className="-ms-2.5 flex flex-col gap-3">
                {back}
                {title}
              </div>
              <Select
                value={page}
                onValueChange={(v) => openSettings(v as SettingsPage)}
              >
                <SelectTrigger
                  aria-label={t("viewTitle")}
                  className="h-9 w-full rounded-full bg-background text-sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GROUPS.map((g) => (
                    <SelectGroup key={g.label}>
                      <SelectLabel className="text-2xs">
                        {t(`nav.${g.label}`)}
                      </SelectLabel>
                      {g.pages.map((p) => (
                        <SelectItem key={p} value={p}>
                          {t(`nav.${p}`)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {readOnly ? (
            <p className="mb-5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
              {t("readOnly")}
            </p>
          ) : null}
          {body}
        </div>
      </ScrollArea>
    </div>
  )
}
