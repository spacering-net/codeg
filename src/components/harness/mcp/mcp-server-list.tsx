"use client"

import { memo, type KeyboardEvent } from "react"
import { Layers, Lock, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import type { McpHarnessMark } from "@/lib/harness/mcp-marks"
import { holderAgentIds, type McpHolder, type McpServer } from "@/lib/mcp/model"
import { cn } from "@/lib/utils"
import { DiscoverMark } from "../discover/discover-card"
import { AgentGlyph } from "./mcp-bits"
import { HarnessMarks } from "./mcp-server-detail"
import { useMcpLabels } from "./use-mcp-labels"

/**
 * Moves the focus along a list of rows with the arrow keys, Home and End —
 * a long list should not take a Tab per row to cross. The rows stay plain
 * buttons in the tab order; this only adds the shortcut.
 */
export function moveRowFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"]
  if (!keys.includes(event.key)) return
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-mcp-row]")
  )
  const index = rows.indexOf(document.activeElement as HTMLElement)
  if (index === -1) return
  event.preventDefault()
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.min(
            rows.length - 1,
            Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1))
          )
  rows[next]?.focus()
}

/** One holder's mark: dimmed where the server is off for that agent. */
function HolderGlyph({ holder }: { holder: McpHolder }) {
  return (
    <AgentGlyph
      agent={holder.info.id}
      className={cn(!holder.entry.enabled && "opacity-35 grayscale")}
    />
  )
}

/**
 * Which agents have the server, as a row of their marks. When the agents do
 * not agree on what the server is, the marks are grouped by definition, each
 * group behind its letter — the same letters the detail uses — so a server
 * that is two different things is visibly so. Entries Codeg cannot read go
 * last, behind a question mark.
 */
export function HolderGlyphs({ server }: { server: McpServer }) {
  const lettered = server.groups.length > 1 || server.undescribed.length > 0
  const groups: { label: string | null; holders: McpHolder[] }[] =
    server.groups.map((group) => ({
      label: lettered ? group.letter : null,
      holders: group.holders,
    }))
  if (server.undescribed.length > 0) {
    groups.push({ label: "?", holders: server.undescribed })
  }
  return (
    <span
      aria-hidden="true"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
    >
      {groups.map((group, index) => (
        <span key={index} className="inline-flex items-center gap-1">
          {group.label && (
            <span className="text-2xs font-semibold text-muted-foreground tabular-nums">
              {group.label}
            </span>
          )}
          {group.holders.map((holder, position) => (
            // An agent can hold a key twice (two YAML keys that read as
            // one name): its mark is then drawn twice, as it is listed.
            <HolderGlyph
              key={`${holder.info.id}:${position}`}
              holder={holder}
            />
          ))}
        </span>
      ))}
    </span>
  )
}

/** The words a screen reader hears for a row's marks. */
function useHoldersText(server: McpServer): string {
  const t = useTranslations("Harness.mcp.row")
  const labels = useMcpLabels()
  const on = server.holders.filter((holder) => holder.entry.enabled)
  const off = server.holders.filter((holder) => !holder.entry.enabled)
  const names = (holders: McpHolder[]) =>
    labels.list(holderAgentIds(holders).map(labels.agent))
  const parts: string[] = []
  if (on.length > 0) parts.push(t("onIn", { agents: names(on) }))
  if (off.length > 0) parts.push(t("offIn", { agents: names(off) }))
  return parts.join(" ")
}

interface McpServerRowProps {
  server: McpServer
  selected: boolean
  harness: McpHarnessMark | undefined
  onOpen: (key: string) => void
}

/**
 * One server of the list: its name, its transport, the agents that have it,
 * and its marks. The whole row is one button; what its marks show is also
 * said in words, for a screen reader.
 */
export const McpServerRow = memo(function McpServerRow({
  server,
  selected,
  harness,
  onOpen,
}: McpServerRowProps) {
  const t = useTranslations("Harness.mcp")
  const labels = useMcpLabels()
  const holdersText = useHoldersText(server)
  const problems = server.hasProblems
  const transports =
    server.transports.length > 0
      ? labels.transports(server.transports)
      : t("row.noDefinition")

  return (
    <li className="min-w-0">
      <button
        type="button"
        data-mcp-row={server.key}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(server.key)}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1.5 rounded-lg px-2.5 py-2 text-start transition-colors outline-none",
          "hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "max-md:py-2.5",
          selected && "bg-muted hover:bg-muted"
        )}
      >
        <span className="flex w-full min-w-0 items-baseline gap-2">
          <bdi
            dir="ltr"
            className="min-w-0 truncate text-sm font-medium text-foreground"
          >
            {server.key}
          </bdi>
          <span className="ms-auto shrink-0 text-2xs text-muted-foreground">
            {transports}
          </span>
        </span>
        <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <HolderGlyphs server={server} />
          {(server.groups.length > 1 ||
            problems ||
            server.reserved ||
            harness) && (
            <span className="flex flex-wrap items-center gap-1">
              {server.groups.length > 1 && (
                <DiscoverMark tone="info">
                  <Layers aria-hidden="true" />
                  {t("row.definitions", { count: server.groups.length })}
                </DiscoverMark>
              )}
              {problems && (
                <DiscoverMark tone="warning">
                  <TriangleAlert aria-hidden="true" />
                  {t("row.problems")}
                </DiscoverMark>
              )}
              {server.reserved && (
                <DiscoverMark>
                  <Lock aria-hidden="true" />
                  {t("row.reserved")}
                </DiscoverMark>
              )}
              {harness && <HarnessMarks mark={harness} />}
            </span>
          )}
        </span>
        <span className="sr-only">{holdersText}</span>
      </button>
    </li>
  )
})
