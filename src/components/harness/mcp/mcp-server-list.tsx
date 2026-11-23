"use client"

import { memo, type KeyboardEvent } from "react"
import {
  Globe,
  Layers,
  Lock,
  Plug,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar"
import type { McpHarnessMark } from "@/lib/harness/mcp-marks"
import { holderAgentIds, type McpHolder, type McpServer } from "@/lib/mcp/model"
import { useElementWidth } from "@/hooks/use-element-width"
import { cn } from "@/lib/utils"
import { DiscoverMark } from "../discover/discover-card"
import { HARNESS_ROW_CLASS, HARNESS_ROW_TILE_CLASS } from "../harness-styles"
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

/** How many faces a group shows before the rest go into a count, until the
 *  row's width is known: one row's worth, fewer per definition where there
 *  are several. */
const MAX_FACES = 4
const MAX_FACES_LETTERED = 3

/** A face's width, and what each further one adds over the one before
 *  (they overlap); a definition's letter and the gap after it; the gap
 *  between two definitions; and room for a count wider than a face. */
const FACE = 24
const FACE_STEP = 18
const LETTER = 12
const GROUP_GAP = 10
const SLACK = 6

/**
 * How many places — faces, or a count in the last — each group gets in a
 * line `width` wide: every group at least one, then one more at a time, in
 * turn, to the groups that still have agents to show, while they fit.
 * Before the width is known (0), a fixed few.
 */
export function fitFaces(
  width: number,
  sizes: readonly number[],
  lettered: boolean
): number[] {
  if (width <= 0) {
    return sizes.map(() => (lettered ? MAX_FACES_LETTERED : MAX_FACES))
  }
  const room =
    width -
    SLACK -
    (lettered ? sizes.length * LETTER : 0) -
    Math.max(0, sizes.length - 1) * GROUP_GAP
  let left = Math.max(0, Math.floor((room - sizes.length * FACE) / FACE_STEP))
  const places = sizes.map(() => 1)
  let growing = true
  while (left > 0 && growing) {
    growing = false
    for (let index = 0; index < sizes.length && left > 0; index++) {
      if (places[index] < sizes[index]) {
        places[index] += 1
        left -= 1
        growing = true
      }
    }
  }
  return places
}

/**
 * Some agents, as an avatar group: their marks in overlapping circles, the
 * first few only and a "+N" for the rest. A mark is dimmed where the server
 * is off for that agent.
 */
function HolderFaces({ holders, max }: { holders: McpHolder[]; max: number }) {
  const shown =
    holders.length > max ? holders.slice(0, Math.max(0, max - 1)) : holders
  const rest = holders.length - shown.length
  return (
    <AvatarGroup className="-space-x-1.5 *:data-[slot=avatar]:ring-background dark:*:data-[slot=avatar]:ring-card">
      {shown.map((holder, position) => (
        // An agent can hold a key twice (two YAML keys that read as one
        // name): its mark is then drawn twice, as it is listed.
        <Avatar key={`${holder.info.id}:${position}`} className="size-5">
          <AvatarFallback className="bg-muted">
            <AgentIcon
              agentType={holder.info.id}
              className={cn(
                "size-3",
                !holder.entry.enabled && "opacity-35 grayscale"
              )}
            />
          </AvatarFallback>
        </Avatar>
      ))}
      {rest > 0 && (
        <AvatarGroupCount className="h-5 w-auto min-w-5 border border-border px-1 text-[0.625rem] font-medium tabular-nums">
          +{rest}
        </AvatarGroupCount>
      )}
    </AvatarGroup>
  )
}

/**
 * Which agents have the server, as an avatar group. When the agents do not
 * agree on what the server is, the groups are one per definition, each
 * behind its letter — the same letters the detail uses — so a server that is
 * two different things is visibly so. Entries Codeg cannot read go last,
 * behind a question mark.
 */
export function HolderGlyphs({ server }: { server: McpServer }) {
  const [ref, width] = useElementWidth<HTMLSpanElement>()
  const lettered = server.groups.length > 1 || server.undescribed.length > 0
  const groups: { label: string | null; holders: McpHolder[] }[] =
    server.groups.map((group) => ({
      label: lettered ? group.letter : null,
      holders: group.holders,
    }))
  if (server.undescribed.length > 0) {
    groups.push({ label: "?", holders: server.undescribed })
  }
  const places = fitFaces(
    width,
    groups.map((group) => group.holders.length),
    lettered
  )
  // As wide as the line leaves it, so as many faces show as fit there.
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="flex min-w-0 flex-1 items-center gap-x-2.5 overflow-hidden"
    >
      {groups.map((group, index) => (
        <span key={index} className="inline-flex shrink-0 items-center gap-1">
          {group.label && (
            <span className="text-2xs font-semibold text-muted-foreground tabular-nums">
              {group.label}
            </span>
          )}
          <HolderFaces holders={group.holders} max={places[index]} />
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

/** A server's mark: what it is reached through — a command it runs, or an
 *  address — and a plug where no agent says. */
export function ServerGlyph({
  transports,
  className,
}: {
  transports: readonly string[]
  className?: string
}) {
  const Icon =
    transports.length === 0
      ? Plug
      : transports.every((transport) => transport === "stdio")
        ? SquareTerminal
        : Globe
  return <Icon aria-hidden="true" className={className} />
}

/** A thin rule between two parts of a row's line. */
export function RowRule() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

/**
 * One server of the list, as a card in the same shape as an agent's: its
 * kind's tile, its name with any mark that asks for attention and, for one
 * from Harness, its version at the end; under them how it is reached and the
 * agents that have it on — or that none has. The whole card is one button;
 * what its marks show is also said in words, for a screen reader.
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
  const anyOn = server.holders.some((holder) => holder.entry.enabled)

  return (
    <li className="min-w-0">
      <button
        type="button"
        data-mcp-row={server.key}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(server.key)}
        className={HARNESS_ROW_CLASS}
      >
        <span className={HARNESS_ROW_TILE_CLASS}>
          <ServerGlyph transports={server.transports} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <bdi
              dir="ltr"
              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
            >
              {server.key}
            </bdi>
            {(server.groups.length > 1 ||
              problems ||
              server.reserved ||
              harness) && (
              <span className="flex shrink-0 items-center gap-1">
                {server.groups.length > 1 && (
                  <DiscoverMark size="sm" tone="info">
                    <Layers aria-hidden="true" />
                    {t("row.definitions", { count: server.groups.length })}
                  </DiscoverMark>
                )}
                {problems && (
                  <DiscoverMark size="sm" tone="warning">
                    <TriangleAlert aria-hidden="true" />
                    {t("row.problems")}
                  </DiscoverMark>
                )}
                {server.reserved && (
                  <DiscoverMark size="sm">
                    <Lock aria-hidden="true" />
                    {t("row.reserved")}
                  </DiscoverMark>
                )}
                {harness && (
                  <HarnessMarks mark={harness} size="sm" source={false} />
                )}
                {harness?.version && (
                  <bdi
                    dir="ltr"
                    className="ms-1 font-mono text-2xs text-muted-foreground tabular-nums"
                  >
                    {harness.version}
                  </bdi>
                )}
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">{transports}</span>
            <RowRule />
            {anyOn ? (
              <HolderGlyphs server={server} />
            ) : (
              <span className="truncate">{t("row.off")}</span>
            )}
          </span>
        </span>
        <span className="sr-only">{holdersText}</span>
      </button>
    </li>
  )
})
