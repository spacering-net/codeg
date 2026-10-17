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
  scienceApplyLinks,
  scienceList,
  scienceListAllInstallStatuses,
  scienceReadContent,
} from "@/lib/api"
import { invalidateAgentSkillsCache } from "@/hooks/use-agent-skills"
import { useLatestCall } from "@/hooks/use-latest-call"
import { piUsesCustomAgentDir } from "@/lib/pi-config"
import type {
  AcpAgentInfo,
  ExpertLinkState,
  ScienceListItem,
} from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"
import { pickLocalized } from "@/lib/expert-presentation"
import { getScienceIcon } from "@/lib/science-presentation"

const CATEGORY_SORT: Record<string, number> = {
  ideation: 1,
  design: 2,
  analysis: 3,
  visualization: 4,
  evaluation: 5,
  literature: 6,
}

export function ScienceBody({
  onRegisterRefresh,
}: {
  onRegisterRefresh?: (refresh: () => void) => void
}) {
  const t = useTranslations("ScienceSettings")
  const locale = useLocale()

  const [skills, setSkills] = useState<ScienceListItem[]>([])
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
      const [skillList, agentList] = await Promise.all([
        scienceList(),
        acpListAgents(),
      ])
      if (!current()) return
      setSkills(skillList)
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
      setSkills([])
      setAgents([])
    } finally {
      if (current()) setLoading(false)
    }
  }, [beginLoad])

  useEffect(() => {
    refresh().catch((err) => {
      console.error("[ScienceSettings] initial refresh failed:", err)
    })
  }, [refresh])

  // Publish the reload handler so the hub's fixed "Refresh" button can drive
  // this pack while it is the active tab.
  useEffect(() => {
    onRegisterRefresh?.(() => {
      refresh().catch((err) => {
        console.error("[ScienceSettings] refresh failed:", err)
      })
    })
  }, [onRegisterRefresh, refresh])

  const translatedCategory = useCallback(
    (category: string): string => {
      switch (category) {
        case "ideation":
          return t("categories.ideation")
        case "design":
          return t("categories.design")
        case "analysis":
          return t("categories.analysis")
        case "visualization":
          return t("categories.visualization")
        case "evaluation":
          return t("categories.evaluation")
        case "literature":
          return t("categories.literature")
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
      skills.map((s) => {
        // Single-badge priority: a user edit (pending review) wins, then the
        // "needs an API key" hint, then the softer "may need a Python setup".
        const badge: MatrixSkill["badge"] = s.user_modified
          ? { label: t("badges.userModified"), tone: "amber" }
          : s.metadata.needs_key
            ? { label: t("badges.needsKey"), tone: "amber" }
            : s.metadata.needs_env
              ? { label: t("badges.needsSetup"), tone: "muted" }
              : undefined
        return {
          id: s.metadata.id,
          category: s.metadata.category,
          displayName:
            pickLocalized(s.metadata.display_name, locale) || s.metadata.id,
          description: pickLocalized(s.metadata.description, locale),
          icon: getScienceIcon(s.metadata.icon),
          ready: true,
          badge,
        }
      }),
    [skills, locale, t]
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

      {skills.length === 0 ? (
        <div className="flex-1 min-h-0 rounded-lg border bg-card flex items-center justify-center text-sm text-muted-foreground">
          {t("emptySkills")}
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
            loadAllStatuses={scienceListAllInstallStatuses}
            applyLinks={scienceApplyLinks}
            loadContent={scienceReadContent}
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
