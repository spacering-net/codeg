"use client"

import { RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import type { WorkbenchChromeActionsProps } from "@/components/workbench/workbench-content"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  DISCOVER_DETAIL,
  DISCOVER_LIST,
  refreshDiscover,
} from "@/lib/harness/discover-state"
import { MCP_INVENTORY, reloadMcpInventory } from "@/lib/harness/mcp-state"
import { PACKS_LINKS, PACKS_TAB, reloadPacks } from "@/lib/harness/packs-state"
import {
  reloadSkills,
  SKILLS_AGENT_LIST,
  SKILLS_LINKS,
} from "@/lib/harness/skills-state"
import { cn } from "@/lib/utils"

/** Whether the section on show is reading, and how to make it read again. */
function useSectionRefresh() {
  const { slots, section } = useHarnessView()
  const [list] = useHarnessSlot(DISCOVER_LIST)
  const [detail] = useHarnessSlot(DISCOVER_DETAIL)
  const [mcp] = useHarnessSlot(MCP_INVENTORY)
  const [skills] = useHarnessSlot(SKILLS_LINKS.inventory)
  const [agentList] = useHarnessSlot(SKILLS_AGENT_LIST)
  const [packs] = useHarnessSlot(PACKS_LINKS.inventory)
  switch (section) {
    case "discover":
      return {
        busy: detail ? detail.phase === "loading" : list.phase === "loading",
        run: () => refreshDiscover(slots),
      }
    case "mcp":
      return {
        busy: mcp.phase === "loading",
        run: () => void reloadMcpInventory(slots),
      }
    case "skills":
      return {
        busy: skills.phase === "loading" || agentList.phase === "loading",
        run: () => void reloadSkills(slots),
      }
    case "packs":
      return {
        busy: packs.phase === "loading",
        run: () => void reloadPacks(slots, slots.get(PACKS_TAB)),
      }
  }
}

/**
 * The Harness route's entry in the window's top-right chrome cluster, left of
 * the settings gear: Refresh, for whichever section is on show — one place
 * for it on every section, instead of a button in each toolbar.
 */
export function HarnessChromeActions({
  buttonClassName,
  iconClassName,
}: WorkbenchChromeActionsProps) {
  const t = useTranslations("Harness")
  const { section } = useHarnessView()
  const { busy, run } = useSectionRefresh()
  const label = t(`${section}.refresh`)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={buttonClassName}
      onClick={run}
      title={label}
      aria-label={label}
      aria-busy={busy}
    >
      <RefreshCw
        aria-hidden="true"
        className={cn(iconClassName, busy && "animate-spin")}
      />
    </Button>
  )
}
