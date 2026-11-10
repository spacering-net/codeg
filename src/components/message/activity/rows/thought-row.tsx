"use client"

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"

import { ReasoningMarkdown } from "@/components/ai-elements/reasoning"
import { thoughtBodyWithoutTitle } from "@/lib/activity/thought"
import type { ActivityStep } from "@/lib/activity/types"
import { cn } from "@/lib/utils"
import { ActivityRow } from "../activity-row"
import { useDisclosure } from "../disclosure-store"
import { RailIcon } from "../rail-icon"
import { THOUGHT_ICON, useStatusText } from "../step-visuals"

type ThoughtStep = Extract<ActivityStep, { type: "thought" }>

/**
 * "Thought · Summarizing log status". Folded by default — opening a thought is
 * the reader's call, and it never closes itself when the block finishes. The
 * open panel is the reasoning in muted text, minus the heading the row
 * already shows.
 */
export const ThoughtRow = memo(function ThoughtRow({
  step,
}: {
  step: ThoughtStep
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const body = useMemo(
    () => thoughtBodyWithoutTitle(step.part.content, step.title).trim(),
    [step.part.content, step.title]
  )
  const [open, setOpen] = useDisclosure(step.key, { defaultOpen: false })
  const status = step.streaming ? "running" : "succeeded"
  // A thinking placeholder with nothing in it yet fades in late, so a block
  // that ends at once never flashes a row.
  const placeholder = step.streaming && !step.part.content.trim()

  return (
    <ActivityRow
      stepKey={step.key}
      status={status}
      className={
        placeholder
          ? "[animation:tool-content-fade_200ms_ease-out_500ms_both]"
          : undefined
      }
      motionSelf={placeholder}
      marker={
        <RailIcon
          icon={THOUGHT_ICON}
          status={status}
          label={`${t("kind.thought")}, ${statusText(status)}`}
        />
      }
      expandable={body.length > 0}
      expanded={open}
      onExpandedChange={setOpen}
      title={step.title ?? undefined}
      detail={() => (
        <div className="max-w-[65ch] text-sm leading-relaxed text-muted-foreground [&_p]:my-1.5">
          <ReasoningMarkdown isStreaming={step.streaming}>
            {body}
          </ReasoningMarkdown>
        </div>
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 font-medium",
            step.streaming ? "activity-shimmer" : "text-activity-secondary"
          )}
        >
          {step.streaming ? t("row.thinking") : t("row.thought")}
        </span>
        {step.title ? (
          <span className="min-w-0 truncate text-activity-secondary" dir="auto">
            {step.title}
          </span>
        ) : null}
      </span>
    </ActivityRow>
  )
})
