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
 * The head of an agent list: one box that ticks every agent that can be
 * ticked, or clears them all when they all are, and how many are ticked.
 * Half-ticked while some are.
 */
export function AgentSelectAll({
  total,
  checked,
  onChange,
}: {
  /** The agents the box speaks for — those that can be ticked. */
  total: number
  /** How many of them are ticked. */
  checked: number
  onChange: (checked: boolean) => void
}) {
  const t = useTranslations("Harness.agentList")
  const id = useId()
  const all = total > 0 && checked >= total
  return (
    <div className="flex min-w-0 items-center gap-3 border-b bg-muted/30 px-3 py-1.5">
      <Checkbox
        id={id}
        checked={all ? true : checked > 0 ? "indeterminate" : false}
        disabled={total === 0}
        onCheckedChange={() => onChange(!all)}
        className="max-md:size-5"
      />
      <label
        htmlFor={id}
        className={cn(
          "min-w-0 flex-1 text-xs font-medium",
          total === 0 ? "text-muted-foreground" : "cursor-pointer"
        )}
      >
        {t("selectAll")}
      </label>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {t("selected", { count: checked, total })}
      </span>
    </div>
  )
}

/**
 * The agents a save can go to, each with a box to tick. One that cannot take
 * it is listed all the same — greyed, with the reason — so nobody wonders
 * where it went. Agents that are not installed and hold nothing are folded
 * away behind "Show all agents".
 *
 * Each agent is one line: its name, and after it what saving would do to it.
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
  // Select-all speaks for the agents on show that can be ticked.
  const tickable = visible.filter((row) => row.block === null)
  const ticked = tickable.filter((row) => row.checked).length
  return (
    <fieldset className="min-w-0">
      <legend className={cn(MCP_SECTION_TITLE_CLASS, "pb-2")}>{legend}</legend>
      {hint && (
        <p className="-mt-1 pb-2 text-xs text-muted-foreground">{hint}</p>
      )}
      {visible.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <AgentSelectAll
            total={tickable.length}
            checked={ticked}
            onChange={(on) => {
              for (const row of tickable) {
                if (row.checked !== on) onToggle(row.agent, on)
              }
            }}
          />
          <ul className="divide-y">
            {visible.map((row) => {
              const id = `${baseId}-${row.agent}`
              const noteId = `${id}-note`
              const note = row.block
                ? (row.blockNote ?? blockText(row.block))
                : row.note
              const warn = row.warn && !row.block && !!row.note
              return (
                <li
                  key={row.agent}
                  className="flex min-w-0 items-center gap-3 px-3 py-2"
                >
                  <Checkbox
                    id={id}
                    checked={row.checked}
                    disabled={row.block !== null}
                    aria-describedby={noteId}
                    onCheckedChange={(checked) =>
                      onToggle(row.agent, checked === true)
                    }
                    className="max-md:size-5"
                  />
                  <label
                    htmlFor={id}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-x-3",
                      row.block ? "cursor-default" : "cursor-pointer"
                    )}
                  >
                    <span className="flex shrink-0 items-center gap-2 text-sm">
                      <AgentGlyph agent={row.agent} />
                      <span
                        className={cn(
                          "font-medium whitespace-nowrap",
                          row.block && "text-muted-foreground"
                        )}
                      >
                        {labels.agent(row.agent)}
                      </span>
                    </span>
                    <span
                      id={noteId}
                      className={cn(
                        "flex min-w-0 items-start gap-1 text-xs leading-snug",
                        warn ? "text-tone-warning" : "text-muted-foreground"
                      )}
                    >
                      {/* A note worth noticing is marked by more than its
                          colour. */}
                      {warn && (
                        <TriangleAlert
                          aria-hidden="true"
                          className="mt-px size-3 shrink-0"
                        />
                      )}
                      <span className="min-w-0">{note}</span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <ShowAllAgentsToggle hidden={rows.length - visible.length} />
    </fieldset>
  )
}
