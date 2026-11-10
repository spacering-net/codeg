"use client"

/**
 * The "UI" tab of Skill Packs: the `ui-render` skill, enabled per agent on
 * the same matrix as the Experts tab.
 *
 * An agent with the skill knows how to answer with a ```spec fence, which
 * the chat renders as cards (always: see `ai-elements/json-render-pre.tsx`).
 * A cell links the skill into that agent's skill folder, or takes it out,
 * the moment it is clicked; the cell shows the link on disk.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Info, LayoutDashboard, Loader2, TriangleAlert } from "lucide-react"

import { SettingNote } from "@/components/shared/setting-card"
import {
  SkillAgentMatrix,
  type MatrixSkill,
} from "@/components/settings/skill-agent-matrix"
import { invalidateAgentSkillsCache } from "@/hooks/use-agent-skills"
import { useLatestCall } from "@/hooks/use-latest-call"
import {
  acpListAgents,
  generativeUiApplyLinks,
  generativeUiListAllInstallStatuses,
  generativeUiReadContent,
  generativeUiSkillInfo,
  type GenerativeUiSkillInfo,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { piUsesCustomAgentDir } from "@/lib/pi-config"
import type { AcpAgentInfo, AgentType, ExpertLinkState } from "@/lib/types"

/** The matrix groups rows by category; this pack has one. */
const CATEGORY = "ui"
const CATEGORY_SORT: Record<string, number> = { [CATEGORY]: 1 }

export function GenerativeUiBody({
  onRegisterRefresh,
}: {
  onRegisterRefresh?: (refresh: () => void) => void
}) {
  const t = useTranslations("GenerativeUiSettings")

  const [skill, setSkill] = useState<GenerativeUiSkillInfo | null>(null)
  const [agents, setAgents] = useState<AcpAgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // A late answer from an earlier Refresh must not overwrite a newer one.
  const beginLoad = useLatestCall()

  const refresh = useCallback(async () => {
    const current = beginLoad()
    setLoading(true)
    setLoadError(null)
    try {
      const [info, agentList] = await Promise.all([
        generativeUiSkillInfo(),
        acpListAgents(),
      ])
      if (!current()) return
      setSkill(info)
      // A pi pointed at a custom PI_CODING_AGENT_DIR isn't managed by the
      // default-dir skill store, so it doesn't get a column here.
      setAgents(
        agentList.filter(
          (agent) => agent.skills_capable && !piUsesCustomAgentDir(agent)
        )
      )
      setReloadKey((k) => k + 1)
    } catch (err) {
      if (!current()) return
      setLoadError(toErrorMessage(err))
      setSkill(null)
      setAgents([])
    } finally {
      if (current()) setLoading(false)
    }
  }, [beginLoad])

  useEffect(() => {
    refresh().catch((err) => {
      console.error("[GenerativeUiSettings] initial refresh failed:", err)
    })
  }, [refresh])

  // Publish the reload handler so the hub's fixed "Refresh" button can drive
  // this pack while it is the active tab.
  useEffect(() => {
    onRegisterRefresh?.(() => {
      refresh().catch((err) => {
        console.error("[GenerativeUiSettings] refresh failed:", err)
      })
    })
  }, [onRegisterRefresh, refresh])

  const translateCategory = useCallback(() => t("category"), [t])

  const translateState = useCallback(
    (state: ExpertLinkState): string => {
      switch (state) {
        case "not_linked":
          return t("states.not_linked")
        case "linked_to_codeg":
          return t("states.linked_to_codeg")
        case "linked_elsewhere":
          return t("states.linked_elsewhere")
        case "blocked_by_real_directory":
          return t("states.blocked_by_real_directory")
        case "broken":
          return t("states.broken")
        default:
          return state
      }
    },
    [t]
  )

  const onApplied = useCallback((touched: AgentType[]) => {
    touched.forEach((agent) => invalidateAgentSkillsCache(agent))
  }, [])

  const matrixSkills = useMemo<MatrixSkill[]>(
    () =>
      skill
        ? [
            {
              id: skill.id,
              category: CATEGORY,
              displayName: t("skillName"),
              description: t("skillDescription"),
              icon: LayoutDashboard,
              // A skill of the user's holds the name: nothing can be enabled
              // until it is renamed.
              ready: !skill.conflict,
              badge: skill.conflict
                ? { label: t("badges.nameTaken"), tone: "amber" }
                : undefined,
            },
          ]
        : [],
    [skill, t]
  )

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {loadError && (
        <div className="mb-3 shrink-0 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {loadError}
        </div>
      )}

      {skill?.conflict && (
        <SettingNote
          icon={TriangleAlert}
          className="mb-3 shrink-0 border-amber-500/40 bg-amber-500/5"
        >
          {t("conflict")}
        </SettingNote>
      )}

      {skill && (
        <>
          <SettingNote icon={Info} className="mb-3 shrink-0">
            {t("usage")}
          </SettingNote>
          {/* No `flex-1`: one row needs no room to scroll, so the card
              hugs it rather than stretching to the bottom of the tab. */}
          <div className="min-h-0 min-w-0 flex flex-col">
            <SkillAgentMatrix
              key={reloadKey}
              skills={matrixSkills}
              agents={agents}
              categoryOrder={CATEGORY_SORT}
              translateCategory={translateCategory}
              translateState={translateState}
              loadAllStatuses={generativeUiListAllInstallStatuses}
              applyLinks={generativeUiApplyLinks}
              loadContent={generativeUiReadContent}
              onApplied={onApplied}
              searchable={false}
              notReadyHint={t("notReadyHint")}
            />
          </div>
        </>
      )}
    </div>
  )
}
