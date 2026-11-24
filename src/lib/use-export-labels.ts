"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { ExportLabels } from "@/lib/export-conversation"

/**
 * Build the localized {@link ExportLabels} passed to the conversation export
 * helpers (`exportAsMarkdown` / `exportAsHtml` / `exportAsImage`). Shared by the
 * conversation detail panel's right-click menu and the per-tile conversation
 * header so the ~20 label strings + status map live in one place.
 */
export function useExportLabels(): ExportLabels {
  const tExport = useTranslations("Folder.conversation.exportLabels")
  const tStatus = useTranslations("Folder.statusLabels")
  return useMemo<ExportLabels>(
    () => ({
      untitledConversation: tExport("untitledConversation"),
      agent: tExport("agent"),
      model: tExport("model"),
      status: tExport("status"),
      started: tExport("started"),
      updated: tExport("updated"),
      tokens: tExport("tokens"),
      duration: tExport("duration"),
      inputTokens: tExport("inputTokens"),
      outputTokens: tExport("outputTokens"),
      cacheRead: tExport("cacheRead"),
      cacheWrite: tExport("cacheWrite"),
      user: tExport("user"),
      assistant: tExport("assistant"),
      system: tExport("system"),
      toolResult: tExport("toolResult"),
      toolError: tExport("toolError"),
      turnFailed: tExport("turnFailed"),
      statusLabels: {
        in_progress: tStatus("in_progress"),
        pending_review: tStatus("pending_review"),
        completed: tStatus("completed"),
        cancelled: tStatus("cancelled"),
      },
    }),
    [tExport, tStatus]
  )
}
