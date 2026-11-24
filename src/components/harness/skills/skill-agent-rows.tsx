"use client"

import { useId, type ReactNode } from "react"
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  cellKey,
  isSkillBusy,
  requestBatch,
  requestOnly,
  requestRefresh,
  requestRepair,
  requestToggle,
  type Links,
} from "@/lib/harness/skill-links"
import type { HarnessSlot } from "@/lib/harness-slots"
import type { SkillsAgent, SkillCell } from "@/lib/skills/types"
import type { CellKind } from "@/lib/skills/model"
import { DiscoverMark } from "../discover/discover-card"
import { AgentGlyph, McpDetailPart } from "../mcp/mcp-bits"
import { SHOW_ALL_AGENTS_CLASS } from "../mcp/mcp-server-detail"
import { rowCell, rowReadyFor, WriteNotices, type GridRow } from "./skill-grid"
import { useSkillsLabels } from "./use-skills-labels"
import { SkillPath } from "./skill-bits"

const ENTRY_KINDS = [
  "codeg_link",
  "codeg_copy",
  "codeg_broken",
  "link",
  "broken_link",
  "folder",
  "file",
  "unreadable",
] as const

/** The mark's colour: on, on but needing a look, off, the name taken. */
function cellTone(kind: CellKind): "success" | "warning" | "neutral" {
  if (kind === "on" || kind === "through" || kind === "copy") return "success"
  if (kind === "off" || kind === "unknown") return "neutral"
  return "warning"
}

/** One agent, for one skill: what it sees, why it cannot change where it
 *  cannot, what else holds the name, and the switch. */
function AgentRow({
  row,
  agent,
  links,
  keptSlot,
}: {
  row: GridRow
  agent: SkillsAgent
  links: Links
  keptSlot: HarnessSlot<Readonly<Record<string, string>>>
}) {
  const t = useTranslations("Harness.skills.agentRow")
  const tGrid = useTranslations("Harness.skills.grid")
  const labels = useSkillsLabels()
  const { slots } = useHarnessView()
  const [busy] = useHarnessSlot(links.busy)
  const [writes] = useHarnessSlot(links.writes)
  const [kept, setKept] = useHarnessSlot(keptSlot)
  const stateId = useId()
  const chipId = useId()
  const cell: SkillCell | undefined = row.skill?.cells.find(
    (item) => item.agent === agent.agent
  )
  const { view, dir, state } = rowCell(row, agent)
  const write = writes[cellKey(row.id, agent.agent)]
  const skillBusy = isSkillBusy(busy, row.id)
  const pending =
    write !== undefined &&
    (write.phase === "checking" ||
      write.phase === "saving" ||
      (write.phase === "saved" && skillBusy))
  const checked = pending ? write.on : view.on
  const name = labels.agent(agent.agent)
  const keyOfCell = cellKey(row.id, agent.agent)
  // "Keep it" holds for this copy: a new copy at another path asks again.
  const isKept = cell?.path != null && kept[keyOfCell] === cell.path
  // Entries beside the one that decides: a folder of the same name in
  // another directory it reads, a second link.
  const others = (cell?.entries ?? []).filter(
    (entry) => entry.path !== cell?.path
  )

  // Under the mark: what it leaves out, and why an off cell cannot be
  // switched on.
  const notes: ReactNode[] = []
  const note = labels.cellNote(view.kind, dir)
  if (note !== null) notes.push(note)
  if (view.why === "notReady" && row.notReady) notes.push(row.notReady)
  if (view.why === "noDirectory") notes.push(tGrid("noDirectory"))
  if (view.why === "plugin" && view.plugin) {
    notes.push(tGrid("providedBy", { plugin: view.plugin }))
  }

  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-2.5">
      <AgentGlyph agent={agent.agent} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{name}</span>
          <DiscoverMark size="sm" tone={cellTone(view.kind)}>
            <span id={chipId}>{labels.cellChip(view.kind, state)}</span>
          </DiscoverMark>
        </div>
        {notes.length > 0 && (
          <p id={stateId} className="text-xs text-muted-foreground">
            {notes.map((note, index) => (
              <span key={index}>
                {index > 0 && " · "}
                {note}
              </span>
            ))}
          </p>
        )}
        {cell?.path && <SkillPath path={cell.path} />}
        {cell?.target && view.kind !== "on" && view.kind !== "through" && (
          <p className="text-2xs leading-4 text-muted-foreground">
            {t("pointsTo")}
            <SkillPath path={cell.target} />
          </p>
        )}
        {cell && cell.shared_with.length > 0 && (
          <p className="text-2xs leading-4 text-muted-foreground">
            {t("sharedWith", { agents: labels.agents(cell.shared_with) })}
          </p>
        )}
        {others.length > 0 && (
          <ul className="space-y-0.5 text-2xs leading-4 text-muted-foreground">
            {others.map((entry) => (
              <li key={entry.path} className="min-w-0">
                {(ENTRY_KINDS as readonly string[]).includes(entry.kind)
                  ? t(`entries.${entry.kind}` as never)
                  : t("entries.other")}
                <SkillPath path={entry.path} />
              </li>
            ))}
          </ul>
        )}
        {view.kind === "copyChanged" && !isKept && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <p className="w-full text-xs">{t("copyChangedAsk")}</p>
            {cell?.path && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() =>
                  setKept((prev) => ({ ...prev, [keyOfCell]: cell.path ?? "" }))
                }
                className="max-md:h-9"
              >
                {t("keep")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={skillBusy}
              onClick={() =>
                requestRefresh(slots, links, row.id, agent.agent, true)
              }
              className="max-md:h-9"
            >
              {t("replace")}
            </Button>
          </div>
        )}
        {view.kind === "copyChanged" && isKept && (
          <p className="text-2xs leading-4 text-muted-foreground">
            {t("kept")}
          </p>
        )}
        {(view.only || view.kind === "copyOutdated" || view.brokenPath) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {view.only && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={skillBusy}
                onClick={() => requestOnly(slots, links, row.id, agent.agent)}
                className="max-md:h-9"
              >
                {t("only", { agent: name })}
              </Button>
            )}
            {view.kind === "copyOutdated" && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={skillBusy}
                onClick={() =>
                  requestRefresh(slots, links, row.id, agent.agent, false)
                }
                className="max-md:h-9"
              >
                {t("refresh")}
              </Button>
            )}
            {view.brokenPath && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={skillBusy}
                  onClick={() =>
                    requestRepair(
                      slots,
                      links,
                      row.id,
                      view.brokenPath ?? "",
                      "repoint"
                    )
                  }
                  className="max-md:h-9"
                >
                  {t("repair")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={skillBusy}
                  onClick={() =>
                    requestRepair(
                      slots,
                      links,
                      row.id,
                      view.brokenPath ?? "",
                      "remove"
                    )
                  }
                  className="max-md:h-9"
                >
                  {t("removeLink")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {pending && (
          <Loader2
            aria-label={t("saving")}
            className="size-3.5 animate-spin text-muted-foreground"
          />
        )}
        <Switch
          checked={checked}
          disabled={view.toggle === null || skillBusy || pending}
          onCheckedChange={() =>
            requestToggle(
              slots,
              links,
              row.id,
              agent.agent,
              rowReadyFor(row, agent.agent)
            )
          }
          aria-label={name}
          aria-describedby={notes.length > 0 ? `${chipId} ${stateId}` : chipId}
          className="relative after:absolute after:-inset-2.5"
        />
      </div>
    </li>
  )
}

/**
 * A skill's agents, one per line, each with its switch and its state in
 * words — what a cell of the matrix is on a pane too narrow for one. Above
 * them, the skill on or off for every agent shown.
 */
export function SkillAgentRows({
  row,
  agents,
  links,
  hidden,
  onShowAll,
  showAll,
  keptSlot,
}: {
  row: GridRow
  agents: readonly SkillsAgent[]
  links: Links
  /** Agents folded away (not installed). */
  hidden: number
  showAll: boolean
  onShowAll: (next: boolean) => void
  /** "Keep it" choices for changed copies. */
  keptSlot: HarnessSlot<Readonly<Record<string, string>>>
}) {
  const t = useTranslations("Harness.skills.detail")
  const { slots } = useHarnessView()
  const [busy] = useHarnessSlot(links.busy)
  const skillBusy = isSkillBusy(busy, row.id)
  const targets = agents.map((agent) => ({ skill: row.id, agent: agent.agent }))
  const ready = (_skill: string, agent: string) => rowReadyFor(row, agent)
  return (
    <McpDetailPart
      title={t("agents")}
      aside={
        row.skill && (
          <span className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={skillBusy}
              onClick={() => requestBatch(slots, links, targets, true, ready)}
              className="max-md:h-9"
            >
              {t("allOn")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={skillBusy}
              onClick={() => requestBatch(slots, links, targets, false, ready)}
              className="max-md:h-9"
            >
              {t("allOff")}
            </Button>
          </span>
        )
      }
    >
      <div className="space-y-2">
        <WriteNotices links={links} skills={new Set([row.id])} />
        {agents.length === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
            {t("noAgents")}
          </p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {agents.map((agent) => (
              <AgentRow
                key={agent.agent}
                row={row}
                agent={agent}
                links={links}
                keptSlot={keptSlot}
              />
            ))}
          </ul>
        )}
        {(hidden > 0 || showAll) && (
          <Button
            type="button"
            variant="link"
            size="sm"
            aria-expanded={showAll}
            onClick={() => onShowAll(!showAll)}
            className={SHOW_ALL_AGENTS_CLASS}
          >
            {showAll ? (
              <ChevronUp aria-hidden="true" />
            ) : (
              <ChevronDown aria-hidden="true" />
            )}
            {showAll ? t("hideNotInstalled") : t("showAll", { count: hidden })}
          </Button>
        )}
      </div>
    </McpDetailPart>
  )
}
