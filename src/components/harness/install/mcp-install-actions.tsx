"use client"

import { ArrowUpCircle, Download, PlugZap, Users } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import {
  HARNESS_INSTALLED,
  openMcpInstall,
} from "@/lib/harness/mcp-install-state"
import type { DiscoverDetailActionsProps } from "../discover/detail-kinds"
import { HarnessRecordProblem } from "./install-parts"

/**
 * What an MCP server's detail in Discover offers: "Install" — or, once the
 * host has it, "Update" when the catalog has a newer revision than the one
 * installed, "Manage agents", and the way to it in the MCP section. Each
 * opens the install dialog, which asks before anything is written.
 */
export function McpInstallActions({ item }: DiscoverDetailActionsProps) {
  const t = useTranslations("Harness.install.actions")
  const { slots } = useHarnessView()
  const { openHarness } = useOpenHarness()
  const [installed] = useHarnessSlot(HARNESS_INSTALLED)
  const record = installed.value?.mcp.find((entry) => entry.id === item.id)
  // The record could not be read: whether this one is installed is not
  // known, and the plan will say nothing can be installed until it is.
  const problem = installed.value?.mcp_problem ?? null
  const notice = problem && (
    <HarnessRecordProblem part="mcp" problem={problem} className="basis-full" />
  )
  if (!record) {
    return (
      <>
        <Button
          type="button"
          size="sm"
          onClick={() =>
            openMcpInstall(slots, {
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
            openMcpInstall(slots, {
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
        onClick={() =>
          openMcpInstall(slots, {
            itemRef: item.ref,
            title: item.title,
            purpose: "manage",
            revision: record.revision,
            from: "discover",
          })
        }
        className="max-md:h-10"
      >
        <Users aria-hidden="true" />
        {t("manage")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => openHarness({ section: "mcp", serverKey: record.key })}
        className="max-md:h-10"
      >
        <PlugZap aria-hidden="true" />
        {t("showInMcp")}
      </Button>
    </>
  )
}
