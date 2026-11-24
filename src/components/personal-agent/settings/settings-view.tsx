"use client"

/**
 * The preferences every assistant shares (13.1) — "Assistant preferences"
 * — across the assistants page in place of the conversation and the side
 * panel. The assistants themselves are on the sidebar's group of them, an
 * assistant's own settings on its own page (`bot-page.tsx`). The
 * navigation down the side under the title — its rows pills — and [← Back
 * to the conversation] over the title; on a narrow screen it folds into a
 * select at the top.
 *
 * Read-only while the engine runs in another codeg process.
 */

import { useTranslations } from "next-intl"
import {
  ArrowLeft,
  BellRing,
  FolderGit2,
  MessagesSquare,
  UserRound,
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
import { cn } from "@/lib/utils"
import {
  usePersonalAgentUi,
  type SettingsPage,
} from "@/stores/personal-agent-ui-store"

import { AboutPage } from "./about-page"
import { AutomationPage, CommunicationPage, ProactivePage } from "./pref-pages"
import { ProjectsPage } from "./projects-page"

/** The navigation: the preferences, under the view's title. */
const PAGES: SettingsPage[] = [
  "communication",
  "projects",
  "proactive",
  "automation",
  "about",
]

const PAGE_ICONS: Record<SettingsPage, LucideIcon> = {
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

  const page = settings?.page ?? "communication"
  const account = snapshot?.account ?? null
  const readOnly = snapshot?.status.engine !== "here"
  // The account's items need the primary set up, and the engine here.
  const primarySet = snapshot?.agent != null
  const accountLocked = readOnly || !primarySet

  const body = (() => {
    switch (page) {
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

  // Back to the conversation: a pill saying so above the navigation, its
  // arrow in the column of the navigation's icons.
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

  return (
    <div className="flex h-full min-h-0" data-pa-settings>
      {isMobile ? null : (
        <aside
          className="flex w-60 shrink-0 flex-col border-e border-border/60"
          data-pa-settings-nav
        >
          <div className="flex flex-col px-3 pt-3 pb-5">{back}</div>
          <nav
            aria-label={t("viewTitle")}
            className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
          >
            {/* The view's title, as small as a group's name over its
                pages. */}
            <h1
              className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground"
              data-pa-settings-title
            >
              {t("viewTitle")}
            </h1>
            <div className="flex flex-col gap-0.5">
              {PAGES.map((p) => {
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
                    <span className="min-w-0 truncate">{t(`nav.${p}`)}</span>
                  </button>
                )
              })}
            </div>
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
              <div className="-ms-2.5 flex flex-col">{back}</div>
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
                  <SelectGroup>
                    <SelectLabel className="text-2xs">
                      {t("viewTitle")}
                    </SelectLabel>
                    {PAGES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`nav.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
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
