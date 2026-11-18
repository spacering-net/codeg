"use client"

import { memo, useMemo, useState, type ReactNode } from "react"
import {
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  Link2,
  Loader2,
  Lock,
  MoreHorizontal,
  RotateCw,
  TriangleAlert,
  Unlink,
  X,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useElementWidth } from "@/hooks/use-element-width"
import {
  cellKey,
  dismissWrite,
  isSkillBusy,
  requestBatch,
  requestToggle,
  retryWrite,
  type CellWrite,
  type Links,
} from "@/lib/harness/skill-links"
import { cellView, type CellKind, type CellView } from "@/lib/skills/model"
import type { CellTarget } from "@/lib/skills/ops"
import type { SkillsAgent, StoreSkill } from "@/lib/skills/types"
import { cn } from "@/lib/utils"
import {
  HARNESS_GROUP_LABEL_CLASS,
  HARNESS_ROWS_CLASS,
  HARNESS_ROW_CLASS,
  HARNESS_ROW_GROUPS_CLASS,
  HARNESS_ROW_TILE_CLASS,
} from "../harness-styles"
import { DiscoverMark } from "../discover/discover-card"
import { AgentGlyph } from "../mcp/mcp-bits"
import { moveRowFocus } from "../mcp/mcp-server-list"
import { AgentStrip, FailureText, IssueList } from "./skill-bits"
import { useSkillsLabels, type SkillsLabels } from "./use-skills-labels"

/** One skill of a grid: a Custom or Harness skill, or a pack's. */
export interface GridRow {
  id: string
  /** The store skill whose cells this row switches; `null` when there is none
   *  the row may switch (an Office skill not synced yet, a pack skill whose
   *  name another skill holds). */
  skill: StoreSkill | null
  name: string
  description: string
  icon: LucideIcon
  category: string
  /** Can be switched on. */
  ready: boolean
  /** Why it cannot, said over its cells and in its detail. */
  notReady?: string
  /** Marks beside its name: where it comes from, what is wrong. */
  marks?: ReactNode
}

export interface GridGroups {
  order: Readonly<Record<string, number>>
  label: (category: string) => string
}

/** The cell of a row for an agent, as the page presents it. */
export function rowCell(
  row: GridRow,
  agent: SkillsAgent
): { view: CellView; dir: string | null; state: string } {
  const cell = row.skill?.cells.find((item) => item.agent === agent.agent)
  return {
    view: cellView(cell, agent, row.ready),
    dir: cell?.dir ?? null,
    state: cell?.state ?? "not_linked",
  }
}

export function onCount(row: GridRow, agents: readonly SkillsAgent[]) {
  return agents.filter(
    (agent) =>
      cellView(
        row.skill?.cells.find((cell) => cell.agent === agent.agent),
        agent,
        row.ready
      ).on
  ).length
}

const CELL_ICONS: Partial<Record<CellKind, LucideIcon>> = {
  on: Check,
  through: Link2,
  copy: Copy,
  copyOutdated: Copy,
  copyChanged: TriangleAlert,
  blocked: Lock,
  elsewhere: Lock,
  broken: Unlink,
  brokenOther: Unlink,
  unknown: CircleHelp,
}

/**
 * The words for a cell — its accessible name and its tooltip: which skill,
 * which agent, and what the cell is.
 */
export function cellLabel(
  labels: SkillsLabels,
  noDirectory: string,
  row: GridRow,
  agent: string,
  cell: { view: CellView; dir: string | null; state: string }
): string {
  const why =
    cell.view.why === "notReady" && row.notReady
      ? ` · ${row.notReady}`
      : cell.view.why === "noDirectory"
        ? ` · ${noDirectory}`
        : ""
  return `${row.name}, ${labels.agent(agent)}: ${labels.cellText(
    cell.view.kind,
    cell.dir,
    cell.state
  )}${why}`
}

/** One switch of the grid, square, with its state in its mark. */
export const GridCell = memo(function GridCell({
  row,
  agent,
  view,
  label,
  busy,
  write,
  onToggle,
}: {
  row: GridRow
  agent: string
  view: CellView
  label: string
  busy: boolean
  write: CellWrite | undefined
  onToggle: (row: GridRow, agent: string) => void
}) {
  const pending =
    write !== undefined &&
    (write.phase === "checking" ||
      write.phase === "saving" ||
      (write.phase === "saved" && busy))
  const checked = pending ? write.on : view.on
  const Icon = pending ? Loader2 : CELL_ICONS[view.kind]
  const disabled = view.toggle === null || busy || pending
  const warn =
    view.kind === "copyChanged" ||
    view.kind === "broken" ||
    view.kind === "brokenOther"
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onToggle(row, agent)}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md border align-middle transition-colors outline-none",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        warn
          ? "border-tone-warning/60 text-tone-warning"
          : checked && view.kind === "through"
            ? "border-primary bg-primary/10 text-primary"
            : checked && (view.kind === "copy" || view.kind === "copyOutdated")
              ? "border-primary bg-primary/80 text-primary-foreground"
              : checked
                ? "border-primary bg-primary text-primary-foreground"
                : view.toggle === null
                  ? "border-dashed border-border text-muted-foreground/70"
                  : "border-border hover:bg-muted/60",
        view.kind === "copyOutdated" && "ring-2 ring-tone-warning/60",
        disabled && !pending && "cursor-not-allowed"
      )}
    >
      {Icon && (
        <Icon
          aria-hidden="true"
          className={cn("size-3.5", pending && "animate-spin")}
        />
      )}
    </button>
  )
})

/** What one row's failed switch came to, with a retry where one can help. */
export function WriteNotices({
  links,
  skills,
}: {
  links: Links
  /** Only these skills' failures; all of them without. */
  skills?: ReadonlySet<string>
}) {
  const t = useTranslations("Harness.skills.write")
  const labels = useSkillsLabels()
  const { slots } = useHarnessView()
  const [writes] = useHarnessSlot(links.writes)
  const failed = Object.values(writes).filter(
    (write) => write.phase === "failed" && (!skills || skills.has(write.skill))
  )
  if (failed.length === 0) return null
  return (
    <div className="space-y-1.5">
      {failed.map((write) => {
        const op = write.result?.ops[0]
        const busy = write.result?.outcome === "busy"
        return (
          <div
            key={cellKey(write.skill, write.agent)}
            role="alert"
            className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 rounded-md bg-tone-warning/10 px-2 py-1.5 text-xs"
          >
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <p>
                {t.rich(write.on ? "notOn" : "notOff", {
                  skill: write.skill,
                  agent: labels.agent(write.agent),
                  code: (chunks) => (
                    <bdi dir="ltr" className="font-mono">
                      {chunks}
                    </bdi>
                  ),
                })}
              </p>
              {write.failure && <FailureText failure={write.failure} />}
              {busy && <p>{t("busy")}</p>}
              {write.result && <IssueList issues={write.result.issues} />}
              {op && <IssueList issues={op.issues} />}
            </div>
            <span className="flex shrink-0 items-center gap-1">
              {(busy || write.failure) && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => retryWrite(slots, links, write)}
                  className="max-md:h-9"
                >
                  <RotateCw aria-hidden="true" />
                  {t("retry")}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("dismiss")}
                title={t("dismiss")}
                onClick={() =>
                  dismissWrite(slots, links, write.skill, write.agent)
                }
                className="max-md:size-9"
              >
                <X aria-hidden="true" />
              </Button>
            </span>
          </div>
        )
      })}
    </div>
  )
}

interface SkillGridProps {
  rows: readonly GridRow[]
  agents: readonly SkillsAgent[]
  links: Links
  selected: string | null
  onOpen: (id: string) => void
  /** The matrix (a wide pane) or a list (a narrow one, a phone). */
  form: "grid" | "list"
  groups?: GridGroups
  /** The rows ticked for a batch (the matrix only). */
  ticked: readonly string[]
  onTick: (ids: readonly string[]) => void
  /** More for the batch bar — "Delete" for Custom skills. */
  batchExtra?: (ids: readonly string[]) => ReactNode
  label: string
  /** One rem, in the pixels the pane is measured in (the app's zoom). */
  rem: number
}

/** The name column: what the switches leave of the pane, within these. */
const NAME_MIN_REM = 14
const NAME_MAX_REM = 24
const AGENT_REM = 2.75

function grouped(
  rows: readonly GridRow[],
  groups: GridGroups | undefined
): { category: string; rows: GridRow[] }[] {
  if (!groups) return [{ category: "", rows: [...rows] }]
  const map = new Map<string, GridRow[]>()
  for (const row of rows) {
    const list = map.get(row.category) ?? []
    list.push(row)
    map.set(row.category, list)
  }
  return [...map.entries()]
    .sort(([a], [b]) => (groups.order[a] ?? 99) - (groups.order[b] ?? 99))
    .map(([category, list]) => ({ category, rows: list }))
}

/**
 * Skills against agents. Wide, a matrix: a row per skill, a column per agent,
 * a switch in each cell, with batches by row, by column, for everything shown
 * and for the ticked rows. Narrow, a list of skills, each with the agents it
 * is on for; its switches are in its detail, one agent per line.
 *
 * Every switch goes through `skill-links.ts`: planned first where it may
 * reach other agents, its progress its own.
 */
export function SkillGrid({
  rows,
  agents,
  links,
  selected,
  onOpen,
  form,
  groups,
  ticked,
  onTick,
  batchExtra,
  label,
  rem,
}: SkillGridProps) {
  const t = useTranslations("Harness.skills.grid")
  const [frameRef, frameWidth] = useElementWidth<HTMLDivElement>()
  // A fixed layout: a long name is cut, and never pushes the switches out
  // of the pane; spare width goes past the last column, so the switches
  // stay next to the names they belong to.
  const nameRem =
    frameWidth > 0
      ? Math.min(
          NAME_MAX_REM,
          Math.max(NAME_MIN_REM, frameWidth / rem - agents.length * AGENT_REM)
        )
      : 16
  const labels = useSkillsLabels()
  const { slots } = useHarnessView()
  const [busy] = useHarnessSlot(links.busy)
  const [writes] = useHarnessSlot(links.writes)
  const sections = useMemo(() => grouped(rows, groups), [rows, groups])
  const noDirectory = t("noDirectory")

  const ready = (id: string) =>
    rows.find((row) => row.id === id)?.ready ?? false
  const switchable = rows.filter((row) => row.skill !== null)
  const batch = (targets: CellTarget[], on: boolean) =>
    requestBatch(slots, links, targets, on, ready)
  const toggle = (row: GridRow, agent: string) =>
    requestToggle(slots, links, row.id, agent, row.ready)

  if (form === "list") {
    return (
      <div className="min-w-0 space-y-2">
        <ul
          aria-label={label}
          onKeyDown={moveRowFocus}
          className={groups ? HARNESS_ROW_GROUPS_CLASS : HARNESS_ROWS_CLASS}
        >
          {sections.map((section) => (
            <li key={section.category} className="min-w-0">
              {groups && (
                <p className={HARNESS_GROUP_LABEL_CLASS}>
                  {groups.label(section.category)}
                </p>
              )}
              <ul className={HARNESS_ROWS_CLASS}>
                {section.rows.map((row) => {
                  const on = agents.filter(
                    (agent) => rowCell(row, agent).view.on
                  )
                  return (
                    <li key={row.id} className="min-w-0">
                      <button
                        type="button"
                        data-mcp-row={row.id}
                        aria-current={row.id === selected ? "true" : undefined}
                        onClick={() => onOpen(row.id)}
                        className={HARNESS_ROW_CLASS}
                      >
                        <span className={HARNESS_ROW_TILE_CLASS}>
                          <row.icon aria-hidden="true" />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              dir="auto"
                              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                            >
                              {row.name}
                            </span>
                            {/* The marks a detail shows full size, at the
                                size of the row's own small text. */}
                            {row.marks && (
                              <span className="flex shrink-0 items-center gap-1 [&>span]:h-5 [&>span]:px-2 [&>span]:text-2xs [&>span>svg]:size-3">
                                {row.marks}
                              </span>
                            )}
                          </span>
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {row.skill || row.ready
                                ? t("onFor", {
                                    count: on.length,
                                    total: agents.length,
                                  })
                                : (row.notReady ?? t("notReady"))}
                            </span>
                            <AgentStrip
                              agents={on.map((agent) => agent.agent)}
                            />
                          </span>
                          <span className="sr-only">
                            {on.length > 0
                              ? t("onIn", {
                                  agents: labels.agents(
                                    on.map((agent) => agent.agent)
                                  ),
                                })
                              : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const visible = rows.map((row) => row.id)
  const tickedVisible = ticked.filter((id) => visible.includes(id))
  const allTicked =
    visible.length > 0 && visible.every((id) => ticked.includes(id))
  const someTicked = visible.some((id) => ticked.includes(id))

  return (
    <div className="min-w-0 space-y-2">
      <div
        ref={frameRef}
        className="min-w-0 overflow-x-auto rounded-xl border bg-card"
      >
        <table
          aria-label={label}
          className="w-full table-fixed border-collapse text-sm"
          style={{ minWidth: `${nameRem + agents.length * AGENT_REM}rem` }}
        >
          <colgroup>
            <col style={{ width: `${nameRem}rem` }} />
            {agents.map((agent) => (
              <col key={agent.agent} style={{ width: `${AGENT_REM}rem` }} />
            ))}
            <col />
          </colgroup>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky start-0 z-10 border-e border-b bg-background px-2 py-1.5 text-start align-middle"
              >
                <span className="flex items-center gap-2">
                  <Checkbox
                    checked={
                      allTicked ? true : someTicked ? "indeterminate" : false
                    }
                    onCheckedChange={() =>
                      onTick(
                        allTicked
                          ? ticked.filter((id) => !visible.includes(id))
                          : [...new Set([...ticked, ...visible])]
                      )
                    }
                    aria-label={t("tickAll")}
                  />
                  <span className="flex-1 text-2xs leading-4 font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("skill")}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("everything")}
                        title={t("everything")}
                        className="text-muted-foreground"
                      >
                        <ChevronDown aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem
                        onSelect={() =>
                          batch(
                            switchable.flatMap((row) =>
                              agents.map((agent) => ({
                                skill: row.id,
                                agent: agent.agent,
                              }))
                            ),
                            true
                          )
                        }
                      >
                        {t("everythingOn")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          batch(
                            switchable.flatMap((row) =>
                              agents.map((agent) => ({
                                skill: row.id,
                                agent: agent.agent,
                              }))
                            ),
                            false
                          )
                        }
                      >
                        {t("everythingOff")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </th>
              {agents.map((agent) => {
                const count = switchable.filter(
                  (row) => rowCell(row, agent).view.on
                ).length
                const name = labels.agent(agent.agent)
                return (
                  <th
                    key={agent.agent}
                    scope="col"
                    className="border-b px-1 py-1.5 align-middle"
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={t("agentMenu", { agent: name })}
                          title={name}
                          className="mx-auto flex flex-col items-center gap-0.5 rounded-md px-1.5 py-1 outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <AgentGlyph agent={agent.agent} />
                          <span className="text-3xs text-muted-foreground tabular-nums">
                            {count}
                          </span>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="center">
                        <DropdownMenuLabel>{name}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() =>
                            batch(
                              switchable.map((row) => ({
                                skill: row.id,
                                agent: agent.agent,
                              })),
                              true
                            )
                          }
                        >
                          {t("columnOn")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            batch(
                              switchable.map((row) => ({
                                skill: row.id,
                                agent: agent.agent,
                              })),
                              false
                            )
                          }
                        >
                          {t("columnOff")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </th>
                )
              })}
              <th aria-hidden="true" className="border-b" />
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => (
              <GridSection
                key={section.category}
                label={groups ? groups.label(section.category) : null}
                span={agents.length + 2}
              >
                {section.rows.map((row) => {
                  const skillBusy = isSkillBusy(busy, row.id)
                  return (
                    <tr
                      key={row.id}
                      className={cn(
                        "border-b last:border-b-0",
                        row.id === selected && "bg-muted/60"
                      )}
                    >
                      <th
                        scope="row"
                        className={cn(
                          "sticky start-0 z-10 border-e px-2 py-1.5 text-start font-normal",
                          row.id === selected ? "bg-muted" : "bg-background"
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Checkbox
                            checked={ticked.includes(row.id)}
                            onCheckedChange={(checked) =>
                              onTick(
                                checked === true
                                  ? [...ticked, row.id]
                                  : ticked.filter((id) => id !== row.id)
                              )
                            }
                            aria-label={t("tick", { name: row.name })}
                          />
                          <row.icon
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          {/* The marks go under the name, not beside it:
                              beside, they would leave a name a few letters. */}
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <button
                              type="button"
                              data-mcp-row={row.id}
                              aria-current={
                                row.id === selected ? "true" : undefined
                              }
                              onClick={() => onOpen(row.id)}
                              className="min-w-0 rounded text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            >
                              {/* Its own direction, so a long name loses its end, not its
                                  start; as wide as the name, so it sits where
                                  the page's lines start. */}
                              <span
                                dir="auto"
                                className="block w-fit max-w-full truncate text-sm font-medium hover:underline"
                              >
                                {row.name}
                              </span>
                            </button>
                            {row.marks && (
                              <span className="flex min-w-0 flex-wrap items-center gap-1">
                                {row.marks}
                              </span>
                            )}
                          </span>
                          <DiscoverMark className="shrink-0 tabular-nums">
                            {onCount(row, agents)}/{agents.length}
                          </DiscoverMark>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                disabled={row.skill === null}
                                aria-label={t("rowMenu", { name: row.name })}
                                title={t("rowMenu", { name: row.name })}
                                className="shrink-0 text-muted-foreground"
                              >
                                <MoreHorizontal aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() =>
                                  batch(
                                    agents.map((agent) => ({
                                      skill: row.id,
                                      agent: agent.agent,
                                    })),
                                    true
                                  )
                                }
                              >
                                {t("rowOn")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  batch(
                                    agents.map((agent) => ({
                                      skill: row.id,
                                      agent: agent.agent,
                                    })),
                                    false
                                  )
                                }
                              >
                                {t("rowOff")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </span>
                      </th>
                      {agents.map((agent) => {
                        const cell = rowCell(row, agent)
                        return (
                          <td
                            key={agent.agent}
                            className="px-1 py-1.5 text-center align-middle leading-none"
                          >
                            <GridCell
                              row={row}
                              agent={agent.agent}
                              view={cell.view}
                              label={cellLabel(
                                labels,
                                noDirectory,
                                row,
                                agent.agent,
                                cell
                              )}
                              busy={skillBusy}
                              write={writes[cellKey(row.id, agent.agent)]}
                              onToggle={toggle}
                            />
                          </td>
                        )
                      })}
                      <td aria-hidden="true" className="w-full" />
                    </tr>
                  )
                })}
              </GridSection>
            ))}
          </tbody>
        </table>
      </div>
      {tickedVisible.length > 0 && (
        <BatchBar
          ids={tickedVisible}
          agents={agents}
          onRun={(targets, on) => batch(targets, on)}
          onClear={() => onTick([])}
          extra={batchExtra?.(tickedVisible)}
        />
      )}
    </div>
  )
}

function GridSection({
  label,
  span,
  children,
}: {
  label: string | null
  span: number
  children: ReactNode
}) {
  return (
    <>
      {label !== null && (
        <tr>
          <td
            colSpan={span}
            className="border-b bg-muted/40 px-2 py-1 text-2xs leading-4 font-semibold tracking-wide text-muted-foreground uppercase"
          >
            {label}
          </td>
        </tr>
      )}
      {children}
    </>
  )
}

/** The ticked rows: on or off for some agents, or for all of them. */
function BatchBar({
  ids,
  agents,
  onRun,
  onClear,
  extra,
}: {
  ids: readonly string[]
  agents: readonly SkillsAgent[]
  onRun: (targets: CellTarget[], on: boolean) => void
  onClear: () => void
  extra?: ReactNode
}) {
  const t = useTranslations("Harness.skills.grid")
  const labels = useSkillsLabels()
  const [chosen, setChosen] = useHarnessBatchAgents(agents)
  const targets = (on: boolean) =>
    onRun(
      ids.flatMap((skill) => chosen.map((agent) => ({ skill, agent }))),
      on
    )
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="text-sm font-medium">
        {t("ticked", { count: ids.length })}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="outline">
            {chosen.length === agents.length
              ? t("forAll")
              : t("forSome", { count: chosen.length })}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {agents.map((agent) => (
            <DropdownMenuCheckboxItem
              key={agent.agent}
              checked={chosen.includes(agent.agent)}
              onCheckedChange={(checked) =>
                setChosen(
                  checked
                    ? [...chosen, agent.agent]
                    : chosen.filter((item) => item !== agent.agent)
                )
              }
              onSelect={(event) => event.preventDefault()}
            >
              {labels.agent(agent.agent)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="ms-auto flex flex-wrap items-center gap-2">
        {extra}
        <Button
          type="button"
          size="sm"
          disabled={chosen.length === 0}
          onClick={() => targets(true)}
        >
          {t("batchOn")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={chosen.length === 0}
          onClick={() => targets(false)}
        >
          {t("batchOff")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClear}>
          {t("clear")}
        </Button>
      </span>
    </div>
  )
}

/** The agents a batch goes to: all those shown, until some are unticked. */
function useHarnessBatchAgents(
  agents: readonly SkillsAgent[]
): [string[], (next: string[]) => void] {
  const [unticked, setUnticked] = useState<string[]>([])
  const chosen = agents
    .map((agent) => agent.agent)
    .filter((agent) => !unticked.includes(agent))
  const set = (next: string[]) =>
    setUnticked(
      agents
        .map((agent) => agent.agent)
        .filter((agent) => !next.includes(agent))
    )
  return [chosen, set]
}
