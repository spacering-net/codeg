"use client"

import { useEffect, useMemo } from "react"

import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import type { HarnessSectionId } from "@/lib/harness-sections"
import {
  MCP_INVENTORY,
  modelOf as mcpModelOf,
  reloadMcpInventory,
} from "@/lib/harness/mcp-state"
import {
  modelOf as skillsModelOf,
  reloadInventory,
} from "@/lib/harness/skill-links"
import {
  HARNESS_INSTALLED,
  reloadHarnessInstalled,
} from "@/lib/harness/mcp-install-state"
import { pluginSectionCount } from "@/lib/harness/plugin-list"
import { SKILLS_LINKS } from "@/lib/harness/skills-state"
import { listenSkillsChanged } from "@/lib/skills/changes"
import { onMcpChanged } from "@/lib/mcp/api"
import { PACK_ORIGINS } from "@/lib/skills/types"

/** What each section's tab counts, once its read is in. Discover has no count
 *  of its own: the catalog says how big it is on the page. */
export type HarnessSectionCounts = Partial<Record<HarnessSectionId, number>>

/**
 * How much each local section holds: the MCP servers configured in any agent,
 * the skills Codeg manages (Custom and SRN Harness), the plugins installed
 * from SRN Harness, and the skill packs with at least one skill in the
 * store.
 *
 * Read from the same slots the sections fill, so a section's own reads keep
 * the tab up to date. Something has to read them before their section is
 * first opened, though, and keep them current while another section is on
 * show: an inventory nobody has read yet is read once here, and a change
 * event is followed only while the section that would follow it is not on
 * screen — that one reads again by itself.
 */
export function useHarnessSectionCounts(
  current: HarnessSectionId
): HarnessSectionCounts {
  const { slots } = useHarnessView()
  const [mcp] = useHarnessSlot(MCP_INVENTORY)
  const [skills] = useHarnessSlot(SKILLS_LINKS.inventory)
  const [installed] = useHarnessSlot(HARNESS_INSTALLED)

  useEffect(() => {
    if (slots.get(MCP_INVENTORY).phase === "idle") {
      void reloadMcpInventory(slots)
    }
    if (slots.get(SKILLS_LINKS.inventory).phase === "idle") {
      void reloadInventory(slots, SKILLS_LINKS)
    }
    // Every section keeps the installed listing current while it is on
    // screen (`useHarnessInstalledSync`); before the first, it is read here.
    if (slots.get(HARNESS_INSTALLED).phase === "idle") {
      void reloadHarnessInstalled(slots)
    }
  }, [slots])

  const followMcp = current !== "mcp"
  useEffect(() => {
    if (!followMcp) return
    let cancelled = false
    let stop: (() => void) | null = null
    try {
      onMcpChanged(() => void reloadMcpInventory(slots))
        .then((unsubscribe) => {
          if (cancelled) unsubscribe()
          else stop = unsubscribe
        })
        .catch(() => {
          // No event stream: the section reads again when it is opened.
        })
    } catch {
      // No transport (a test): nothing to follow.
    }
    return () => {
      cancelled = true
      stop?.()
    }
  }, [followMcp, slots])

  // Skill packs reads the same store into slots of its own, so the counts
  // follow it there too.
  const followSkills = current !== "skills"
  useEffect(() => {
    if (!followSkills) return
    return listenSkillsChanged(() => void reloadInventory(slots, SKILLS_LINKS))
  }, [followSkills, slots])

  return useMemo(() => {
    const counts: HarnessSectionCounts = {}
    if (mcp.inventory) counts.mcp = mcpModelOf(mcp.inventory).servers.length
    if (skills.inventory) {
      const model = skillsModelOf(skills.inventory)
      counts.skills = model.managed.length
      counts.packs = PACK_ORIGINS.filter(
        (pack) => model.packSkills(pack).size > 0
      ).length
    }
    const plugins = pluginSectionCount(installed.value)
    if (plugins !== undefined) counts.plugins = plugins
    return counts
  }, [mcp.inventory, skills.inventory, installed.value])
}
