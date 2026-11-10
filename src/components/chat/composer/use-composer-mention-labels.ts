"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { toErrorMessage } from "@/lib/app-error"
import { openPersonalAgentPage } from "@/lib/personal-agent-open"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import type { MentionUiLabels } from "./suggestion/types"
import type { ReferenceGroupLabels } from "./use-reference-search"

export interface ComposerMentionLabels {
  /** Group headings, doubling as the panel's tab labels. */
  groupLabels: ReferenceGroupLabels
  /** Empty / loading / listbox name / "more results" / count announcement. */
  uiLabels: MentionUiLabels
}

/**
 * Localized chrome for the `@` reference panel, shared by every host that
 * mounts a {@link RichComposer} (the chat input, the automation editor, the
 * task editor, the task follow-up box). The strings live in the chat composer's
 * namespace because that is where the panel came from — a mention menu reads
 * the same wherever it is opened.
 *
 * `groupLabels` is memoized because `useReferenceSearch` takes it as a
 * dependency of its fetch effect; an inline object would re-run the search on
 * every render.
 */
export function useComposerMentionLabels(): ComposerMentionLabels {
  const t = useTranslations("Folder.chat.messageInput")
  const groupLabels = useMemo<ReferenceGroupLabels>(
    () => ({
      file: t("mentionGroupFile"),
      agent: t("mentionGroupAgent"),
      assistant: t("mentionGroupAssistant"),
      session: t("mentionGroupSession"),
      commit: t("mentionGroupCommit"),
      skill: t("mentionGroupSkill"),
    }),
    [t]
  )
  // The assistants are managed on the assistants page: in a workspace, that
  // page here; elsewhere, the workspace's.
  const route = useOptionalWorkbenchRoute()
  const setRoute = route?.setRoute
  const uiLabels = useMemo<MentionUiLabels>(
    () => ({
      empty: t("mentionEmpty"),
      loading: t("mentionLoading"),
      listbox: t("mentionListLabel"),
      more: t("mentionMore"),
      count: (count: number) => t("mentionCount", { count }),
      manageAssistants: {
        label: t("mentionManageAssistants"),
        open: () => {
          if (setRoute) {
            usePersonalAgentUi.getState().openSettings("executors")
            setRoute("personalAgent")
            return
          }
          void openPersonalAgentPage("executors").catch((e) =>
            toast.error(toErrorMessage(e))
          )
        },
      },
    }),
    [t, setRoute]
  )
  return { groupLabels, uiLabels }
}
