"use client"

/**
 * The executor config an assistant's work runs on (D4): a new one, made on
 * the brain's agent with its options filled in, or one of the executor
 * configs there are — several assistants may share one. The identity page
 * and the new work assistant dialog both pick it so.
 */

import { useTranslations } from "next-intl"

import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import type { AssistantPrefill } from "@/components/settings/assistant-editor-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { BotAvatar } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAssistants } from "@/stores/assistants-store"

/** What is picked: a new one, one there is, or — for one bound to none,
 *  until something is picked — nothing. */
export type ExecutorChoice =
  | { kind: "new" }
  | { kind: "existing"; id: number }
  | { kind: "none" }

export function sameChoice(a: ExecutorChoice, b: ExecutorChoice): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== "existing" || a.id === (b as { id: number }).id
}

/** What an assistant bound to `id` starts with: that one while it is
 *  there, else nothing. */
export function choiceOf(
  id: number | null | undefined,
  live: readonly { id: number }[]
): ExecutorChoice {
  return id != null && live.some((a) => a.id === id)
    ? { kind: "existing", id }
    : { kind: "none" }
}

const NEW = "new"

export function ExecutorPick({
  value,
  onChange,
  disabled,
  id,
  className,
}: {
  value: ExecutorChoice
  onChange: (next: ExecutorChoice) => void
  disabled?: boolean
  id?: string
  className?: string
}) {
  const t = useTranslations("PersonalAgent.settings.executorPick")
  const assistants = useAssistants()
  // The ones there are to pick: the enabled ones, and the one picked even
  // when it is turned off.
  const listed = assistants.filter(
    (a) => a.enabled || (value.kind === "existing" && a.id === value.id)
  )
  const selected =
    value.kind === "new"
      ? NEW
      : value.kind === "existing"
        ? String(value.id)
        : undefined
  return (
    <Select
      value={selected}
      onValueChange={(v) =>
        onChange(
          v === NEW ? { kind: "new" } : { kind: "existing", id: Number(v) }
        )
      }
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        className={cn("h-8 w-56 bg-background text-xs", className)}
        data-pa-executor-pick={selected ?? "none"}
      >
        <SelectValue placeholder={t("none")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NEW} className="text-xs" data-pa-executor-new>
          {t("new")}
        </SelectItem>
        {listed.length > 0 ? <SelectSeparator /> : null}
        {listed.map((a) => (
          <SelectItem
            key={a.id}
            value={String(a.id)}
            className="text-xs"
            data-pa-executor-option={a.id}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <AssistantAvatar avatar={a.avatar} name={a.name} size={16} />
              <span className="truncate">{a.name}</span>
              {a.enabled ? null : (
                <span className="text-muted-foreground">{t("off")}</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The executor configs' colour nearest a face's (the backend's
 *  `assistant_color`): the avatar a new one made in the editor starts
 *  with. */
export function assistantAvatarOf(face: BotAvatar): AssistantPrefill["avatar"] {
  if (face.kind !== "face") return face
  const map: Record<string, string> = {
    red: "red",
    orange: "orange",
    yellow: "amber",
    brown: "amber",
    green: "green",
    teal: "teal",
    blue: "blue",
    purple: "violet",
    magenta: "pink",
  }
  return {
    kind: "monogram",
    color: (map[face.color] ?? "slate") as "slate",
  }
}
