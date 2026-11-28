"use client"

import { type ComponentType } from "react"
import { useTranslations } from "next-intl"

import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { useHarnessView } from "@/contexts/harness-view-context"
import type { HarnessSectionId } from "@/lib/harness-sections"
import { DiscoverSection } from "./discover/discover-section"
import {
  HarnessSectionNav,
  harnessPanelId,
  harnessTabId,
} from "./harness-section-nav"
import { HarnessInstallDialogs } from "./install/harness-install-dialogs"
import { McpSection } from "./mcp/mcp-section"
import { PacksSection } from "./packs/packs-section"
import { PluginsSection } from "./plugins/plugins-section"
import { SkillsSection } from "./skills/skills-section"

const SECTION_VIEWS: Record<HarnessSectionId, ComponentType> = {
  discover: DiscoverSection,
  mcp: McpSection,
  skills: SkillsSection,
  plugins: PluginsSection,
  packs: PacksSection,
}

/** Page title rendered into the window-chrome strip above the page — the
 *  shared breadcrumb header, like every other workbench route — followed by
 *  the page's section tabs. */
export function HarnessPageTitle() {
  const t = useTranslations("Harness")
  return (
    <WorkbenchPageTitle
      title={t("title")}
      className="shrink"
      trail={
        <>
          {/* Halfway between the title and the first tab's label: the
              strip's 4px gap and this 10px before it, the gap and the tab's
              own 10px after it. */}
          <span
            aria-hidden="true"
            className="ms-2.5 h-4 w-px shrink-0 bg-border"
          />
          <HarnessSectionNav />
        </>
      }
    />
  )
}

/**
 * The Harness route page: the current section, under the section tabs the
 * page's title carries in the window-chrome strip (`HarnessPageTitle`).
 *
 * The page keeps nothing of its own. Which section is current, and whatever a
 * section wants back after the user has been to a conversation and returned,
 * lives in the always-mounted `HarnessViewProvider` — this component is
 * unmounted every time the route is left.
 *
 * Only the current section is mounted: each reads what it shows when it is
 * opened, and keeps whatever must outlive it in the provider's slots.
 */
export function HarnessPage() {
  const { section } = useHarnessView()
  const SectionView = SECTION_VIEWS[section]

  return (
    // No background of its own: the route overlay already paints
    // `bg-background ws-transparent-bg` (workspace/layout.tsx), so an opaque
    // layer here would hide the workspace background image behind the page.
    <div className="@container/harness flex h-full min-h-0 flex-col">
      <div
        key={section}
        id={harnessPanelId(section)}
        role="tabpanel"
        aria-labelledby={harnessTabId(section)}
        className="min-h-0 min-w-0 flex-1 overflow-hidden outline-none"
      >
        <SectionView />
      </div>
      {/* Opened from Discover and from the MCP section alike, so drawn
          by the page: a dialog in progress stays up whichever section is
          on show. */}
      <HarnessInstallDialogs />
    </div>
  )
}
