"use client"

import { ArrowUpCircle, Download, Users } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { HARNESS_INSTALLED } from "@/lib/harness/mcp-install-state"
import { openSkillInstall } from "@/lib/harness/skill-install-state"
import type { DiscoverDetailActionsProps } from "../discover/detail-kinds"
import { HarnessRecordProblem } from "./install-parts"

/**
 * What a skill's detail in Discover offers: "Install" — or, once the host
 * has it, "Update" when the catalog has a newer revision than the one
 * installed, and "Manage agents", which opens the skill in the Skills
 * section, where each agent has its switch. Installing and updating open the
 * install dialog, which asks before anything is written.
 *
 * Changing the agents does not go through the install: that would download
 * the skill again and put it back in place — files the user changed would
 * go to the backups — when only links change.
 */
export function SkillInstallActions({ item }: DiscoverDetailActionsProps) {
  const t = useTranslations("Harness.skillInstall.actions")
  const { slots } = useHarnessView()
  const { openHarness } = useOpenHarness()
  const [installed] = useHarnessSlot(HARNESS_INSTALLED)
  const problem = installed.value?.skills_problem ?? null
  const record = installed.value?.skills.find((entry) => entry.id === item.id)
  const notice = problem && (
    <HarnessRecordProblem
      part="skills"
      problem={problem}
      className="basis-full"
    />
  )
  if (!record) {
    return (
      <>
        <Button
          type="button"
          size="sm"
          onClick={() =>
            openSkillInstall(slots, {
              itemRef: item.ref,
              title: item.title,
              purpose: "install",
              from: "discover",
            })
          }
          className="max-md:h-10"
        >
          <Download aria-hidden="true" />
          {t("install")}
        </Button>
        {notice}
      </>
    )
  }
  const newer = item.latest.revision > record.revision
  return (
    <>
      {newer && (
        <Button
          type="button"
          size="sm"
          onClick={() =>
            openSkillInstall(slots, {
              itemRef: item.ref,
              title: item.title,
              purpose: "update",
              from: "discover",
            })
          }
          className="max-md:h-10"
        >
          <ArrowUpCircle aria-hidden="true" />
          {t("update")}
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant={newer ? "outline" : "default"}
        onClick={() => openHarness({ section: "skills", skillId: record.name })}
        className="max-md:h-10"
      >
        <Users aria-hidden="true" />
        {t("manage")}
      </Button>
      {notice}
    </>
  )
}
