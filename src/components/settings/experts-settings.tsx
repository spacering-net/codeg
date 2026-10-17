"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import {
  SkillAgentMatrix,
  type MatrixSkill,
} from "@/components/settings/skill-agent-matrix"
import {
  acpListAgents,
  expertsApplyLinks,
  expertsList,
  expertsListAllInstallStatuses,
  expertsReadContent,
} from "@/lib/api"
import { invalidateAgentSkillsCache } from "@/hooks/use-agent-skills"
import { useLatestCall } from "@/hooks/use-latest-call"
import { piUsesCustomAgentDir } from "@/lib/pi-config"
import type { AcpAgentInfo, ExpertLinkState, ExpertListItem } from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"
import { getExpertIcon, pickLocalized } from "@/lib/expert-presentation"

const CATEGORY_SORT: Record<string, number> = {
  discovery: 1,
  planning: 2,
  execution: 3,
  quality: 4,
  debugging: 5,
  review: 6,
  meta: 7,
}

export function ExpertsBody({
  onRegisterRefresh,
}: {
  onRegisterRefresh?: (refresh: () => void) => void
}) {
  const t = useTranslations("ExpertsSettings")
  const locale = useLocale()

  const [experts, setExperts] = useState<ExpertListItem[]>([])
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
      const [expertList, agentList] = await Promise.all([
        expertsList(),
        acpListAgents(),
      ])
      if (!current()) return
      setExperts(expertList)
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
      setExperts([])
      setAgents([])
    } finally {
      if (current()) setLoading(false)
    }
  }, [beginLoad])

  useEffect(() => {
    refresh().catch((err) => {
      console.error("[ExpertsSettings] initial refresh failed:", err)
    })
  }, [refresh])

  // Publish the reload handler so the hub's fixed "Refresh" button can drive
  // this pack while it is the active tab.
  useEffect(() => {
    onRegisterRefresh?.(() => {
      refresh().catch((err) => {
        console.error("[ExpertsSettings] refresh failed:", err)
      })
    })
  }, [onRegisterRefresh, refresh])

  const translatedCategory = useCallback(
    (category: string): string => {
      switch (category) {
        case "discovery":
          return t("categories.discovery")
        case "planning":
          return t("categories.planning")
        case "execution":
          return t("categories.execution")
        case "quality":
          return t("categories.quality")
        case "debugging":
          return t("categories.debugging")
        case "review":
          return t("categories.review")
        case "meta":
          return t("categories.meta")
        default:
          return category
      }
    },
    [t]
  )

  const translatedState = useCallback(
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

  const matrixSkills = useMemo<MatrixSkill[]>(
    () =>
      experts.map((e) => ({
        id: e.metadata.id,
        category: e.metadata.category,
        displayName:
          pickLocalized(e.metadata.display_name, locale) || e.metadata.id,
        description: pickLocalized(e.metadata.description, locale),
        icon: getExpertIcon(e.metadata.icon),
        ready: true,
        badge: e.user_modified
          ? { label: t("badges.userModified"), tone: "amber" }
          : undefined,
      })),
    [experts, locale, t]
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

      {experts.length === 0 ? (
        <div className="flex-1 min-h-0 rounded-lg border bg-card flex items-center justify-center text-sm text-muted-foreground">
          {t("emptyExperts")}
        </div>
      ) : (
        <div className="flex-1 min-h-0 min-w-0">
          <SkillAgentMatrix
            key={reloadKey}
            skills={matrixSkills}
            agents={agents}
            categoryOrder={CATEGORY_SORT}
            translateCategory={translatedCategory}
            translateState={translatedState}
            loadAllStatuses={expertsListAllInstallStatuses}
            applyLinks={expertsApplyLinks}
            loadContent={expertsReadContent}
            onApplied={(touched) =>
              touched.forEach((a) => invalidateAgentSkillsCache(a))
            }
            searchPlaceholder={t("searchPlaceholder")}
          />
        </div>
      )}
    </div>
  )
}
