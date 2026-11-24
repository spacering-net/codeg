"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { workTaskSetWriteback } from "@/lib/api"
import { sourceItems } from "@/lib/forge-source-items"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { ForgeSourceItem, WorkTask } from "@/lib/types"

/**
 * The thread comment of a forge-sourced task, as its acceptance dialogs show
 * it: whether one is posted when the task finishes, and the reply it carries
 * for each item — the agent's draft, which the user reads and may rewrite
 * before anything reaches a thread other people are watching. Accepting the
 * task is what signs it off, so every acceptance dialog shows this.
 */
export interface ThreadComment {
  /** The task came from an issue or pull request, so there is a thread. */
  applies: boolean
  items: ForgeSourceItem[]
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  drafts: Record<number, string>
  setDraft: (number: number, text: string) => void
  /** Store the answer on the task — call before the acceptance itself, every
   *  time: it is what binds the acceptance to the reply on screen. A no-op
   *  only for a task without a thread. */
  persist: () => Promise<void>
}

/** What the task row holds now: the switch from the trigger dialog (or an
 *  earlier acceptance), and the drafts by item number. */
function stored(task: WorkTask | null): {
  enabled: boolean
  drafts: Record<number, string>
} {
  const drafts: Record<number, string> = {}
  for (const [key, text] of Object.entries(task?.writeback_drafts ?? {})) {
    const number = Number(key)
    if (Number.isInteger(number)) drafts[number] = text
  }
  return { enabled: task?.source_meta?.writeback === true, drafts }
}

export function useThreadComment(
  task: WorkTask | null,
  open: boolean
): ThreadComment {
  const applies = task?.source_kind != null && task.source_meta != null
  const items =
    applies && task?.source_meta ? sourceItems(task.source_meta) : []
  const [enabled, setEnabled] = useState(false)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  // Seeded per open off the stored VALUES, never off the row object: the
  // board hands out a fresh row on every refetch, and re-seeding on identity
  // would wipe a half-edited reply whenever any task anywhere changed.
  const taskId = task?.id ?? null
  const seed = JSON.stringify(stored(task))
  useEffect(() => {
    if (!open || taskId == null) return
    const now = JSON.parse(seed) as ReturnType<typeof stored>
    /* eslint-disable react-hooks/set-state-in-effect */
    setEnabled(now.enabled)
    setDrafts(now.drafts)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, taskId, seed])

  const persist = async () => {
    if (!applies || task == null) return
    // Sent before EVERY acceptance, changed or not: it carries the generation
    // this dialog showed, so a task sent back and reviewed again since — with
    // a newer reply nobody here has read — refuses the acceptance instead of
    // posting that reply.
    const kept: Record<number, string> = {}
    for (const { number } of items) {
      const text = drafts[number]?.trim()
      if (text) kept[number] = text
    }
    await workTaskSetWriteback(task.id, task.run_seq, enabled, kept)
  }

  return {
    applies,
    items,
    enabled,
    setEnabled,
    drafts,
    setDraft: (number, text) =>
      setDrafts((held) => ({ ...held, [number]: text })),
    persist,
  }
}

export function ThreadCommentSection({
  comment,
  disabled,
}: {
  comment: ThreadComment
  disabled?: boolean
}) {
  const t = useTranslations("Tasks")
  if (!comment.applies) return null
  const several = comment.items.length > 1
  return (
    <div className="flex flex-col gap-2">
      <Label className="text-sm font-normal">
        <Checkbox
          checked={comment.enabled}
          onCheckedChange={(v) => comment.setEnabled(v === true)}
          disabled={disabled}
        />
        {t(several ? "threadCommentLabelSeveral" : "threadCommentLabel")}
      </Label>
      {comment.enabled ? (
        <div className="flex flex-col gap-2 pl-6">
          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {comment.items.map((item) => {
              const id = `task-thread-reply-${item.number}`
              return (
                <div key={item.number} className="flex flex-col gap-1">
                  <Label
                    htmlFor={id}
                    className="min-w-0 text-xs text-muted-foreground"
                  >
                    {/* As a string: a message placeholder would otherwise be
                        number-formatted ("#1,234"). */}
                    {t("threadCommentReplyLabel", {
                      number: String(item.number),
                    })}
                  </Label>
                  <Textarea
                    id={id}
                    value={comment.drafts[item.number] ?? ""}
                    onChange={(e) =>
                      comment.setDraft(item.number, e.target.value)
                    }
                    placeholder={t("threadCommentPlaceholder")}
                    rows={several ? 4 : 6}
                    disabled={disabled}
                    className="font-mono text-xs"
                  />
                </div>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("threadCommentHint")}
          </p>
        </div>
      ) : null}
    </div>
  )
}
