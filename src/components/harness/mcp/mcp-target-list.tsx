"use client"

import { useId, type ReactNode } from "react"
import { TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import { Checkbox } from "@/components/ui/checkbox"
import { useHarnessSlot } from "@/contexts/harness-view-context"
import { MCP_SHOW_ALL_AGENTS } from "@/lib/harness/mcp-state"
import { isFolded, type McpAgentInfo } from "@/lib/mcp/model"
import type { McpTargetBlock } from "@/lib/mcp/targets"
import type { McpAppType } from "@/lib/mcp/types"
import { cn } from "@/lib/utils"
import { MCP_SECTION_TITLE_CLASS, AgentGlyph } from "./mcp-bits"
import { ShowAllAgentsToggle } from "./mcp-server-detail"
import { useMcpLabels } from "./use-mcp-labels"

export interface McpTargetRow {
  info: McpAgentInfo
  agent: McpAppType
  /** Ticked and allowed: what a save writes to. */
  checked: boolean
  /** Why it cannot be ticked, or `null`. */
  block: McpTargetBlock | null
  /** The words for `block`, where the list's own would say less than the
   *  caller knows. */
  blockNote?: ReactNode
  /** What saving would do to it, in a few words. */
  note: ReactNode
  /** The note is a consequence worth noticing (a definition replaced, a
   *  file's comments lost). */
  warn?: boolean
  /** Kept in view even when not installed: it holds the server already. */
  holds?: boolean
}

/** The words for why an agent cannot be ticked. */
export function useTargetBlockText(): (block: McpTargetBlock) => ReactNode {
  const t = useTranslations("Harness.mcp.targets")
  const labels = useMcpLabels()
  return (block) => {
    switch (block.kind) {
      case "agent":
        return labels.block(block.block)
      case "transport":
        return t("cannotHold", { transport: labels.transport(block.transport) })
      case "key":
        return t("keyNotNew")
      case "entry": {
        const { reason } = block
        // A name or a field there twice says what to do about it; the rest
        // say only that the entry cannot be changed, and why it cannot.
        if (reason.kind === "duplicate") {
          return labels.issue(
            { code: "duplicate_key", field: reason.field ?? undefined },
            "entry"
          )
        }
        if (reason.kind === "agent") return labels.block(reason.block)
        return t("entryReadOnly")
      }
    }
  }
}

/**
 * The agents a save can go to, each with a box to tick. One that cannot take
 * it is listed all the same — greyed, with the reason — so nobody wonders
 * where it went. Agents that are not installed and hold nothing are folded
 * away behind "Show all agents".
 */
export function McpTargetList({
  rows,
  onToggle,
  legend,
  hint,
}: {
  rows: McpTargetRow[]
  onToggle: (agent: McpAppType, checked: boolean) => void
  legend: string
  /** What is ticked at first, and why — said before the list. */
  hint?: ReactNode
}) {
  const [showAll] = useHarnessSlot(MCP_SHOW_ALL_AGENTS)
  const labels = useMcpLabels()
  const blockText = useTargetBlockText()
  const baseId = useId()
  const visible = rows.filter(
    (row) => showAll || row.checked || row.holds || !isFolded(row.info)
  )
  return (
    <fieldset className="min-w-0">
      <legend className={cn(MCP_SECTION_TITLE_CLASS, "pb-2")}>{legend}</legend>
      {hint && (
        <p className="-mt-1 pb-2 text-xs text-muted-foreground">{hint}</p>
      )}
      <ul className="divide-y rounded-lg border">
        {visible.map((row) => {
          const id = `${baseId}-${row.agent}`
          const noteId = `${id}-note`
          return (
            <li
              key={row.agent}
              className="flex min-w-0 items-start gap-3 px-3 py-2"
            >
              <Checkbox
                id={id}
                checked={row.checked}
                disabled={row.block !== null}
                aria-describedby={noteId}
                onCheckedChange={(checked) =>
                  onToggle(row.agent, checked === true)
                }
                className="mt-0.5 max-md:size-5"
              />
              <label
                htmlFor={id}
                className={cn(
                  "flex min-w-0 flex-1 flex-col gap-0.5",
                  row.block ? "cursor-default" : "cursor-pointer"
                )}
              >
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <AgentGlyph agent={row.agent} />
                  <span
                    className={cn(
                      "min-w-0 truncate font-medium",
                      row.block && "text-muted-foreground"
                    )}
                  >
                    {labels.agent(row.agent)}
                  </span>
                </span>
                <span
                  id={noteId}
                  className={cn(
                    "flex min-w-0 items-start gap-1 text-xs",
                    row.warn && !row.block
                      ? "text-tone-warning"
                      : "text-muted-foreground"
                  )}
                >
                  {/* A note worth noticing is marked by more than its
                      colour. */}
                  {row.warn && !row.block && row.note && (
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-3 shrink-0"
                    />
                  )}
                  <span className="min-w-0">
                    {row.block
                      ? (row.blockNote ?? blockText(row.block))
                      : row.note}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <ShowAllAgentsToggle hidden={rows.length - visible.length} />
    </fieldset>
  )
}
