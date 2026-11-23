"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { MessageSquareShare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getAgentLabel } from "@/lib/custom-agents"
import { toErrorMessage } from "@/lib/app-error"
import type {
  SessionConfigOptionInfo,
  WorkTaskConversationSelection,
} from "@/lib/types"
import { useOpenTaskConversation } from "./use-open-task-conversation"

/** The option's and value's display names, when the agent's option list
 *  (probed for the editor) knows them; the raw ids otherwise. */
function describeValue(
  options: SessionConfigOptionInfo[] | null | undefined,
  optionId: string,
  valueId: string
): { name: string; value: string } {
  const option = options?.find((o) => o.id === optionId)
  if (!option) return { name: optionId, value: valueId }
  if (option.kind.type === "select") {
    const all = [
      ...option.kind.options,
      ...option.kind.groups.flatMap((g) => g.options),
    ]
    const hit = all.find((o) => o.value === valueId)
    return { name: option.name, value: hit?.name ?? valueId }
  }
  return { name: option.name, value: valueId }
}

/**
 * A to-do task's conversation selection, read-only (codeg#1179): a task that
 * already has a conversation keeps its agent, and its model / options are
 * changed IN that conversation — the next retry / return / merge continues it
 * with them. "Open conversation to change" opens it as a real tab.
 *
 * `selection`: `undefined` while loading, `null` when the server did not say
 * (an older server).
 */
export function TaskConversationSelection({
  taskId,
  selection,
  configOptions,
  settling = false,
  onOpened,
}: {
  taskId: number
  selection: WorkTaskConversationSelection | null | undefined
  configOptions?: SessionConfigOptionInfo[] | null
  /** The task is queued / preparing: its binding may still change. */
  settling?: boolean
  /** Called once the conversation tab was opened (e.g. to close a dialog). */
  onOpened?: () => void
}) {
  const t = useTranslations("Tasks")
  const openConversation = useOpenTaskConversation()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const open = async () => {
    setNotice(null)
    setBusy(true)
    try {
      const result = await openConversation(taskId)
      if (result === "opened") onOpened?.()
      else if (result === "starting")
        setNotice(t("conversationSelectionStarting"))
      else setNotice(t("conversationSelectionUnavailable"))
    } catch (e) {
      setNotice(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const entries = selection ? Object.entries(selection.config_values) : []

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2"
      data-testid="task-conversation-selection"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t("conversationSelectionTitle")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={busy || settling || selection == null}
          onClick={() => void open()}
        >
          <MessageSquareShare className="size-3.5" aria-hidden="true" />
          {t("conversationSelectionOpen")}
        </Button>
      </div>
      {selection === undefined ? (
        <p className="text-xs text-muted-foreground">
          {t("conversationSelectionLoading")}
        </p>
      ) : selection === null ? (
        <p className="text-xs text-muted-foreground">
          {t("conversationSelectionUnavailable")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-medium">
            {getAgentLabel(selection.agent_type) ?? selection.agent_type}
          </span>
          {entries.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("conversationSelectionEmpty")}
            </span>
          ) : (
            entries.map(([optionId, valueId]) => {
              const d = describeValue(configOptions, optionId, valueId)
              return (
                <span key={optionId} className="text-xs">
                  <span className="text-muted-foreground">{d.name}: </span>
                  {d.value}
                </span>
              )
            })
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {selection?.legacy
          ? t("conversationSelectionLegacy")
          : t("conversationSelectionHint")}
      </p>
      {notice ? (
        <p className="text-xs text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
