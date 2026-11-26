"use client"

/**
 * The owner's personal assistants on the workspace's sidebar (U2): a
 * section of its own, "Assistants", above the folders by default.
 *
 * - Its rows are the roster's (`PersonalAgentRoster variant="sidebar"`):
 *   the primary — or, before it is set up, the row that sets it up — then
 *   the pinned ones, the owner's groups, the rest; the hidden ones only when
 *   the filter asks for them. A row opens its assistant's conversation on
 *   the assistants page; it is marked chosen while that page shows it.
 * - The section's head carries [filter] — "show the hidden assistants (N)",
 *   kept on this device, shared with the page title's popover — and
 *   [+ new assistant]; folded, the "waiting on you" badge.
 * - Its dialogs (new, delete, name a group) are held by the list, so the
 *   head's [+] and the rows' menus open the same ones.
 */

import { useTranslations } from "next-intl"
import { ListFilter, Plus } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePrimaryAgent } from "@/contexts/personal-agent-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  loadSectionCollapsed,
  saveSectionCollapsed,
} from "@/lib/sidebar-view-mode-storage"
import { cn } from "@/lib/utils"
import { useRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import {
  PersonalAgentRoster,
  useRosterDialogs,
  type RosterDialogs,
} from "./roster"
import { useShowHiddenAssistants } from "./roster-filter"
import { useAssistantsBadge } from "./use-assistants-badge"

/** The window event that opens the sidebar's assistants section (the
 *  collaboration settings' "manage assistants", the composer's). */
export const SHOW_SIDEBAR_ASSISTANTS_EVENT = "codeg:sidebar-show-assistants"

/** Open the sidebar's assistants section, folded or not — kept, so a
 *  sidebar closed now (a phone's drawer) opens with it unfolded. */
export function showSidebarAssistants(): void {
  const held = loadSectionCollapsed()
  if (held.assistants) saveSectionCollapsed({ ...held, assistants: false })
  window.dispatchEvent(new Event(SHOW_SIDEBAR_ASSISTANTS_EVENT))
}

/** The section's dialogs — a new one goes to its conversation on the
 *  assistants page, wherever the workspace was. */
export function useSidebarRosterDialogs() {
  const { setRoute } = useWorkbenchRoute()
  return useRosterDialogs({
    onMade: (made) => {
      if (!made.bot) return
      const ui = usePersonalAgentUi.getState()
      ui.setViewBot(made.bot.kind === "primary" ? null : made.bot.id)
      ui.showConversation()
      setRoute("personalAgent")
    },
  })
}

/** The section's rows. */
export function SidebarAssistants({ dialogs }: { dialogs: RosterDialogs }) {
  const { snapshot } = usePrimaryAgent()
  const { routeId, setRoute } = useWorkbenchRoute()
  const readOnly = snapshot != null && snapshot.status.engine !== "here"
  return (
    <div data-pa-sidebar-assistants>
      <PersonalAgentRoster
        variant="sidebar"
        readOnly={readOnly}
        dialogs={dialogs}
        active={routeId === "personalAgent"}
        onPick={() => setRoute("personalAgent")}
      />
    </div>
  )
}

/** The count beside the section's title: the assistants listed (the hidden
 *  ones only when shown). */
export function useSidebarAssistantsCount(): number {
  const roster = useRoster()
  const [showHidden] = useShowHiddenAssistants()
  return (roster ?? []).filter((e) => showHidden || !e.roster.hidden).length
}

/** The section head's actions: the filter and [+ new assistant]. */
export function AssistantsSectionActions({
  dialogs,
  className,
}: {
  dialogs: RosterDialogs
  /** The head's own button look. */
  className: string
}) {
  const t = useTranslations("PersonalAgent.bots.roster")
  const roster = useRoster()
  const { snapshot } = usePrimaryAgent()
  const [showHidden, setShowHidden] = useShowHiddenAssistants()
  const hiddenCount = (roster ?? []).filter((e) => e.roster.hidden).length
  // A new one needs the primary set up (its brain is the primary's), and
  // the engine here.
  const canAdd = snapshot?.agent != null && snapshot.status.engine === "here"
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            title={t("filter")}
            aria-label={t("filter")}
            data-pa-sidebar-filter={showHidden ? "hidden" : ""}
            className={cn(
              className,
              "data-[state=open]:opacity-100",
              // A filter that changes the list is state to see unhovered.
              showHidden && "opacity-100 text-sidebar-foreground/80"
            )}
          >
            <ListFilter className="h-[0.875rem] w-[0.875rem]" />
          </button>
        </DropdownMenuTrigger>
        {/* As wide as its words, on one line in every language. */}
        <DropdownMenuContent align="end" className="w-max min-w-48">
          <DropdownMenuCheckboxItem
            className="whitespace-nowrap"
            checked={showHidden}
            // Nothing hidden: nothing to show (one shown can still be
            // switched off).
            disabled={hiddenCount === 0 && !showHidden}
            onCheckedChange={(v) => setShowHidden(v === true)}
            onSelect={(e) => e.preventDefault()}
            data-pa-sidebar-show-hidden
          >
            {t("showHidden", { count: hiddenCount })}
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {canAdd ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            dialogs.add()
          }}
          title={t("add")}
          aria-label={t("add")}
          data-pa-sidebar-add
          className={className}
        >
          <Plus className="h-[0.875rem] w-[0.875rem]" />
        </button>
      ) : null}
    </>
  )
}

/** Beside the folded section's title: how many assistants have something
 *  unread, or a dot when one waits on the owner. */
export function AssistantsSectionBadge() {
  const t = useTranslations("Folder.sidebar")
  const { needsOwner, snapshot } = usePrimaryAgent()
  const { unreadBots, needsOwner: anyNeedsOwner } = useAssistantsBadge(
    snapshot?.agent?.id ?? null,
    snapshot?.status.unseen ?? 0,
    needsOwner
  )
  if (unreadBots > 0) {
    return (
      <span
        data-pa-sidebar-badge
        className="inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center rounded-full bg-primary px-1 font-mono text-[0.625rem] leading-none font-medium text-primary-foreground"
        aria-label={t("personalAgentUnreadBots", { count: unreadBots })}
      >
        {unreadBots > 99 ? "99+" : unreadBots}
      </span>
    )
  }
  return anyNeedsOwner ? (
    <span
      data-pa-sidebar-badge="needs"
      className="inline-flex size-2 shrink-0 rounded-full bg-primary"
    />
  ) : null
}
