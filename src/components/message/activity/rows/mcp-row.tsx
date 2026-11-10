"use client"

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"

import { tryParseJson } from "@/lib/activity/json"
import { mcpResultPayload } from "@/lib/activity/mcp"
import { cn } from "@/lib/utils"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { RailIcon } from "../rail-icon"
import { ResultBody } from "../result-body"
import { ToolFigure, toolIcon, useStatusText } from "../step-visuals"
import type { ToolStep } from "./explore-rows"

/** `mcp · linear` — where the tool came from, not a status. */
function McpChip({ server }: { server: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-activity-accent/10 px-2 font-mono text-xs leading-5 text-activity-accent ws-msg-chip">
      mcp · {server}
    </span>
  )
}

function prettyJson(text: string | null): string | null {
  if (!text?.trim()) return null
  const parsed = tryParseJson(text)
  if (parsed) return JSON.stringify(parsed, null, 2)
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * `[mcp · linear] get_issue  HVAC-212 · Inactive bindings leak into report`.
 * Opens to the arguments and the result side by side when there is room
 * (stacked in a narrow column).
 */
export const McpRow = memo(function McpRow({ step }: { step: ToolStep }) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { recoveredKeys } = useActivityRender()
  const { tool, part } = step
  const failed = tool.status === "failed" || tool.status === "rejected"
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force:
      (failed && !recoveredKeys.has(step.key)) || tool.status === "awaiting",
  })
  const args = useMemo(() => prettyJson(part.input), [part.input])
  const result = useMemo(() => {
    const raw = part.output ?? part.errorText ?? null
    const payload = mcpResultPayload(raw)
    if (!payload) return null
    if (payload.text !== null) return payload.text
    return JSON.stringify(payload.json, null, 2)
  }, [part.output, part.errorText])
  const expandable = !!args || !!result

  return (
    <ActivityRow
      stepKey={step.key}
      approval={step.tool.approval}
      status={tool.status}
      marker={
        <RailIcon
          icon={toolIcon(tool)}
          status={tool.status}
          label={`${t("kind.mcp")}, ${statusText(tool.status)}`}
        />
      }
      expandable={expandable}
      expanded={open}
      onExpandedChange={setOpen}
      title={tool.detail ?? undefined}
      trailing={<ToolFigure tool={tool} />}
      detail={() => (
        <div className="@container">
          <div className="grid gap-2 @min-[34rem]:grid-cols-2">
            {args ? (
              <DetailBox tone="neutral">
                <p className="px-4 pt-2.5 font-mono text-xs text-muted-foreground">
                  {t("detail.args")}
                </p>
                <ResultBody text={args} />
              </DetailBox>
            ) : null}
            {result ? (
              <DetailBox tone={failed ? "danger" : "neutral"}>
                <p className="px-4 pt-2.5 font-mono text-xs text-muted-foreground">
                  {t("detail.result")}
                </p>
                <ResultBody
                  text={result}
                  tone={failed ? "danger" : "neutral"}
                />
              </DetailBox>
            ) : null}
          </div>
        </div>
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        {tool.mcp ? <McpChip server={tool.mcp.server} /> : null}
        <span
          className={cn(
            "shrink-0 font-mono text-[0.8125rem] font-semibold",
            failed ? "text-tone-danger" : "text-foreground"
          )}
        >
          {tool.target?.text ?? tool.toolName}
        </span>
        {tool.detail ? (
          <span className="min-w-0 truncate text-activity-secondary" dir="auto">
            {tool.detail}
          </span>
        ) : null}
      </span>
    </ActivityRow>
  )
})
