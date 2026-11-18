"use client"

import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react"
import {
  ArrowLeft,
  ArrowUpCircle,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  ExternalLink,
  Layers,
  Loader2,
  Lock,
  Package,
  PackageMinus,
  PencilLine,
  RotateCw,
  SearchX,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { harnessLang, pickLocalized } from "@/lib/harness/display"
import type { McpHarnessMark, McpHarnessSeam } from "@/lib/harness/mcp-marks"
import {
  dismissRow,
  editableHolders,
  isAgentBusy,
  MCP_BUSY,
  MCP_DETAIL_SCROLL,
  MCP_ROW_WRITES,
  MCP_SHOW_ALL_AGENTS,
  openEditEditor,
  openRemoveDialog,
  openRenameDialog,
  requestSwitch,
  rowId,
  writeRow,
  type McpRowWrite,
} from "@/lib/harness/mcp-state"
import {
  agentServerState,
  holderAgentIds,
  isFolded,
  isSkippedInSessions,
  switchOf,
  type McpAgentInfo,
  type McpAgentServerState,
  type McpDefinitionGroup,
  type McpModel,
  type McpServer,
} from "@/lib/mcp/model"
import { headlineOf } from "@/lib/mcp/results"
import { cn } from "@/lib/utils"
import { HarnessScroller } from "../harness-scroller"
import { DiscoverMark } from "../discover/discover-card"
import { HarnessUpdateStatus } from "../harness-update-status"
import {
  HARNESS_CARD_CLASS,
  HARNESS_DETAIL_CLASS,
  HARNESS_DETAIL_HEADER_CLASS,
  HARNESS_DETAIL_TILE_CLASS,
  HARNESS_DETAIL_TITLE_CLASS,
} from "../harness-styles"
import { MachineText } from "../machine-text"
import { AgentGlyph, McpDetailPart, PathText } from "./mcp-bits"
import {
  McpDefinitionRow,
  McpDefinitionRows,
  McpDefinitionRowsHead,
  McpDefinitionView,
} from "./mcp-definition-view"
import { ServerGlyph } from "./mcp-server-list"
import { useMcpLabels, type McpLabels } from "./use-mcp-labels"

/** The bar above a detail on a pane that shows one screen at a time. */
export function McpBackBar({
  onBack,
  children,
}: {
  onBack: () => void
  children?: ReactNode
}) {
  const t = useTranslations("Harness.mcp")
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-1 py-1.5 ws-chrome-border @2xl/harness:px-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="max-md:h-10"
      >
        <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
        {t("detail.back")}
      </Button>
      {children}
    </div>
  )
}

/** A detail's place while the configuration is read: its header, then two
 *  boxes, at the detail's own inset. */
export function DetailBodySkeleton() {
  return (
    <div aria-hidden="true" className={HARNESS_DETAIL_CLASS}>
      <div
        className={cn(
          HARNESS_DETAIL_HEADER_CLASS,
          "flex items-start gap-4 space-y-0"
        )}
      >
        <Skeleton className="size-12 rounded-xl" />
        <div className="flex-1 space-y-2.5 pt-1">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-36 w-full rounded-xl" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    </div>
  )
}

/** The dot between two facts of a detail's line. */
export function MetaDot() {
  return (
    <span
      aria-hidden="true"
      className="size-1 shrink-0 rounded-full bg-muted-foreground/40"
    />
  )
}

/** A detail's scroller, put back at the offset it was left at — for the same
 *  detail only. */
export function useDetailScroll(id: string) {
  const { slots } = useHarnessView()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const saved = slots.get(MCP_DETAIL_SCROLL)
    if (ref.current) ref.current.scrollTop = saved?.id === id ? saved.top : 0
  }, [slots, id])
  const onScroll = (event: React.UIEvent<HTMLDivElement>) =>
    slots.set(MCP_DETAIL_SCROLL, { id, top: event.currentTarget.scrollTop })
  return { ref, onScroll }
}

/** "Show all agents" — one choice for every list of agents in the section. */
/** "Show all agents" under an agent list: a quiet link flush with the
 *  list's edge, not a button that reads like a heading. */
export const SHOW_ALL_AGENTS_CLASS =
  "mt-1.5 h-auto gap-1 px-0 py-1 text-xs font-normal text-muted-foreground hover:text-foreground hover:no-underline max-md:h-10 [&_svg]:size-3.5"

export function ShowAllAgentsToggle({
  hidden,
  className,
}: {
  hidden: number
  /** Under a list, the link lines up with the rows' text. */
  className?: string
}) {
  const t = useTranslations("Harness.mcp.agents")
  const [showAll, setShowAll] = useHarnessSlot(MCP_SHOW_ALL_AGENTS)
  if (hidden === 0 && !showAll) return null
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      aria-expanded={showAll}
      onClick={() => setShowAll(!showAll)}
      className={cn(SHOW_ALL_AGENTS_CLASS, className)}
    >
      {showAll ? (
        <ChevronUp aria-hidden="true" />
      ) : (
        <ChevronDown aria-hidden="true" />
      )}
      {showAll ? t("hideNotInstalled") : t("showAll", { count: hidden })}
    </Button>
  )
}

/** What a row's save came to, when it did not simply go through. */
export function RowWriteNotice({
  write,
  busy,
  onRetry,
  onDismiss,
}: {
  write: McpRowWrite
  /** The agent is still being written to, or read again after a write. */
  busy: boolean
  onRetry: () => void
  onDismiss: () => void
}) {
  const t = useTranslations("Harness.mcp.rowResult")
  const tPlan = useTranslations("Harness.mcp.plan")
  const labels = useMcpLabels()
  if (write.phase !== "failed") return null
  const result = write.result
  const agent = result?.agents.find((entry) => entry.agent === write.agent)
  const headline = result ? headlineOf(result) : null
  let message: ReactNode
  if (!result) {
    message =
      write.failure?.kind === "unsupported" ? t("unsupported") : t("failed")
  } else if (headline === "changedElsewhere") {
    message = t("changedElsewhere")
  } else if (headline === "busy") {
    message = t("busy")
  } else if (agent && agent.issues.length > 0) {
    message = labels.issue(agent.issues[0], "op")
  } else {
    message = t("failed")
  }
  const detail = !result
    ? write.failure?.detail
    : agent?.issues.find((issue) => issue.detail)?.detail
  const retryable = !result || headline === "busy"
  return (
    <div
      role="alert"
      className="mt-1.5 flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 rounded-md bg-tone-warning/10 px-2 py-1.5 text-xs"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
      />
      <span className="min-w-0 flex-1">
        {message}
        {detail && (
          <bdi
            dir="ltr"
            className="mt-0.5 block font-mono text-2xs text-muted-foreground"
          >
            <MachineText>{detail}</MachineText>
          </bdi>
        )}
        {agent?.status === "restore_skipped" &&
          agent.backup_paths.length > 0 && (
            <span className="mt-1 block">
              {tPlan("backupCopy")}
              {agent.backup_paths.map((path) => (
                <PathText key={path} path={path} className="text-foreground" />
              ))}
            </span>
          )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {retryable && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={onRetry}
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
          onClick={onDismiss}
          className="max-md:size-9"
        >
          <X aria-hidden="true" />
        </Button>
      </span>
    </div>
  )
}

interface StateChip {
  label: string
  tone?: "neutral" | "info" | "warning"
  icon?: ReactNode
}

/**
 * The state of an agent for a server: the short words as chips beside the
 * agent's name — not set up, off, which definition, read-only — and, in a
 * line under it, whatever takes a sentence to say: why it cannot be added
 * or changed here. "On" is no chip: the switch says it.
 */
function stateParts(
  state: McpAgentServerState,
  server: McpServer,
  labels: McpLabels,
  t: ReturnType<typeof useTranslations<"Harness.mcp">>
): { chips: StateChip[]; reasons: ReactNode[] } {
  const { info } = state
  const chips: StateChip[] = []
  const reasons: ReactNode[] = []
  if (state.kind === "unreadable") {
    reasons.push(
      <>
        {t("agentState.unreadable")}{" "}
        {info.editBlock && labels.block(info.editBlock)}
      </>
    )
    return { chips, reasons }
  }
  if (state.kind === "absent") {
    chips.push({ label: t("agentState.notConfigured") })
    const block = state.block
    if (block) {
      switch (block.kind) {
        case "agent":
          reasons.push(labels.block(block.block))
          break
        case "transport":
          reasons.push(
            t("agentState.cannotHold", {
              transports: labels.transports(block.transports),
            })
          )
          break
        case "key":
          reasons.push(t("agentState.keyNotNew"))
          break
        case "noDefinition":
          reasons.push(t("agentState.noDefinition"))
          break
      }
    }
    return { chips, reasons }
  }
  const { holder, readOnly } = state
  if (!holder.entry.enabled) chips.push({ label: t("agentState.off") })
  if (server.groups.length > 1 && holder.group !== null) {
    chips.push({
      label: t("detail.definitionLetter", {
        letter: server.groups[holder.group].letter,
      }),
      tone: "info",
      icon: <Layers aria-hidden="true" />,
    })
  }
  if (holder.group === null) reasons.push(t("agentState.entryUnreadable"))
  switch (readOnly?.kind) {
    case "agent":
      reasons.push(labels.block(readOnly.block))
      break
    case "reserved":
      reasons.push(t("agentState.reserved"))
      break
    case "duplicate":
      reasons.push(
        labels.issue(
          { code: "duplicate_key", field: readOnly.field ?? undefined },
          "entry"
        )
      )
      break
    case "entry":
      chips.push({
        label: t("agentState.readOnly"),
        icon: <Lock aria-hidden="true" />,
      })
      break
  }
  return { chips, reasons }
}

/** Problems the state line words itself: listing them as well would say the
 *  same thing twice. */
export const STATED_PROBLEMS: ReadonlySet<string> = new Set([
  "reserved_key",
  "duplicate_key",
])

interface AgentRowProps {
  server: McpServer
  info: McpAgentInfo
  model: McpModel
  /** The server came from Harness: how this agent's entry stands against
   *  what was installed, said where it is not "as installed". */
  harness?: McpHarnessMark
}

/** One agent, for one server: what it has, why it cannot be changed if it
 *  cannot, and the switch. */
function AgentRow({ server, info, model, harness }: AgentRowProps) {
  const t = useTranslations("Harness.mcp")
  const tHarness = useTranslations("Harness.mcp.harness")
  const installed = harness?.agents.find((agent) => agent.agent === info.id)
  const otherVersion =
    installed?.version && installed.version !== harness?.version
      ? installed.version
      : null
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const [writes] = useHarnessSlot(MCP_ROW_WRITES)
  const [busy] = useHarnessSlot(MCP_BUSY)
  const stateId = useId()
  const chipsId = useId()
  const state = agentServerState(server, info, model.rules)
  const control = switchOf(state)
  const write = writes[rowId(info.id, server.key)]
  const agentBusy = isAgentBusy(busy, info.id)
  // While a save is on its way — and until the files are read again after
  // it — the switch shows where it is going, not where it was.
  const pending =
    write !== undefined &&
    (write.phase === "saving" || (write.phase === "saved" && agentBusy))
  const checked = pending ? write.target : control.checked
  const holder = state.kind === "present" ? state.holder : null
  // The state line already says why an entry is read-only; its problems
  // list does not say it again.
  const problems = (holder?.entry.problems ?? []).filter(
    (problem) => !STATED_PROBLEMS.has(problem.code)
  )
  const extra = holder ? Object.keys(holder.entry.extra) : []
  const skipped =
    holder && holder.entry.enabled && isSkippedInSessions(info, holder.entry)
  const name = labels.agent(info.id)
  const { chips, reasons } = stateParts(state, server, labels, t)
  if (skipped) reasons.push(t("agentState.skipped"))

  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-2.5">
      <AgentGlyph agent={info.id} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{name}</span>
          {chips.length > 0 && (
            <span
              id={chipsId}
              className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              {chips.map((chip) => (
                <DiscoverMark size="sm" key={chip.label} tone={chip.tone}>
                  {chip.icon}
                  {chip.label}
                </DiscoverMark>
              ))}
            </span>
          )}
          {info.installed === false && (
            <DiscoverMark size="sm">{t("agents.notInstalled")}</DiscoverMark>
          )}
          {!info.agent && (
            <DiscoverMark size="sm">{t("agents.unknown")}</DiscoverMark>
          )}
          {installed &&
            (installed.local !== "asInstalled" || otherVersion !== null) && (
              <DiscoverMark
                size="sm"
                tone={installed.local === "asInstalled" ? "neutral" : "warning"}
              >
                <Package aria-hidden="true" />
                {installed.local !== "asInstalled"
                  ? tHarness(`states.${installed.local}`)
                  : null}
                {installed.local !== "asInstalled" && otherVersion && " · "}
                {otherVersion}
              </DiscoverMark>
            )}
        </div>
        {reasons.length > 0 && (
          <p id={stateId} className="mt-0.5 text-xs text-muted-foreground">
            {reasons.map((reason, index) => (
              <span key={index}>
                {index > 0 && " · "}
                {reason}
              </span>
            ))}
          </p>
        )}
        {info.inventory.config.path && (
          <PathText path={info.inventory.config.path} className="mt-0.5" />
        )}
        {holder && info.editBlock?.kind === "related" && (
          <p className="mt-1 text-xs text-tone-warning">
            {labels.block(info.editBlock)}
          </p>
        )}
        {problems.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs">
            {problems.map((problem, index) => (
              <li key={index} className="flex min-w-0 items-start gap-1.5">
                <TriangleAlert
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-3 shrink-0",
                    problem.code === "legacy_location"
                      ? "text-muted-foreground"
                      : "text-tone-warning"
                  )}
                />
                <span className="min-w-0">
                  {labels.issue(problem, "entry")}
                  {problem.detail && (
                    <bdi
                      dir="ltr"
                      className="ms-1 font-mono text-2xs text-muted-foreground"
                    >
                      <MachineText>{problem.detail}</MachineText>
                    </bdi>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {extra.length > 0 && (
          <p className="mt-1 text-2xs text-muted-foreground">
            {t("detail.extra")}{" "}
            <bdi dir="ltr" className="font-mono">
              <MachineText>{extra.join(", ")}</MachineText>
            </bdi>
          </p>
        )}
        {write && (
          <RowWriteNotice
            write={write}
            busy={agentBusy}
            onRetry={() => {
              dismissRow(slots, info.id, server.key)
              // Against what the user decided on: a file changed since
              // is reported, not written over.
              void writeRow(
                slots,
                write.agent,
                write.key,
                write.action,
                write.basis
              )
            }}
            onDismiss={() => dismissRow(slots, info.id, server.key)}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {pending && (
          <Loader2
            aria-label={t("detail.saving")}
            className="size-3.5 animate-spin text-muted-foreground"
          />
        )}
        <Switch
          checked={checked}
          disabled={control.action === null || agentBusy || pending}
          onCheckedChange={() => requestSwitch(slots, server.key, info.id)}
          aria-label={name}
          aria-describedby={
            [chips.length > 0 && chipsId, reasons.length > 0 && stateId]
              .filter(Boolean)
              .join(" ") || undefined
          }
          className="relative after:absolute after:-inset-2.5"
        />
      </div>
    </li>
  )
}

/** Whether an edit to a definition could be saved: it writes to the agents
 *  that hold the definition, and where none of them can change there is
 *  nothing it could save. (Adding the server to another agent is that
 *  agent's switch.) */
function groupEditable(
  group: McpDefinitionGroup,
  changeable: readonly string[]
): boolean {
  return group.holders.some(
    (holder) =>
      holder.info.agent !== null && changeable.includes(holder.info.agent)
  )
}

/** Edit one definition — "Edit", or "Edit A" where there are several. */
function EditDefinitionButton({
  server,
  group,
  editable,
  describedBy,
}: {
  server: McpServer
  group: McpDefinitionGroup
  editable: boolean
  describedBy?: string
}) {
  const t = useTranslations("Harness.mcp.detail")
  const { slots } = useHarnessView()
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={!editable}
      aria-describedby={describedBy}
      onClick={() => openEditEditor(slots, server.key, group.fingerprint)}
      className="h-7 rounded-full text-foreground max-md:h-10"
    >
      <PencilLine aria-hidden="true" />
      {server.groups.length > 1
        ? t("editLetter", { letter: group.letter })
        : t("edit")}
    </Button>
  )
}

/**
 * What the server is. One definition is one card — its lines, then who uses
 * it — with Edit beside the part's title; several are a card each, headed
 * by their letter, their agents and their own Edit.
 */
function DefinitionPart({
  server,
  changeable,
  explain,
}: {
  server: McpServer
  /** The agents Codeg can change the server in. */
  changeable: readonly string[]
  /** Say why a definition cannot be edited, when that is not said above. */
  explain: boolean
}) {
  const t = useTranslations("Harness.mcp.detail")
  const noteId = useId()
  const several = server.groups.length > 1
  const editableGroup = (group: McpDefinitionGroup) =>
    groupEditable(group, changeable)
  const note = (group: McpDefinitionGroup, id: string) =>
    !editableGroup(group) && explain ? (
      <p id={id} className="border-b px-4 py-3 text-xs text-muted-foreground">
        {t("definitionNotEditable")}
      </p>
    ) : null

  if (server.groups.length === 0) {
    return (
      <McpDetailPart title={t("definition")}>
        <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
          {t("noDefinition")}
        </p>
      </McpDetailPart>
    )
  }

  if (!several) {
    const group = server.groups[0]
    const editable = editableGroup(group)
    return (
      <McpDetailPart
        title={t("definition")}
        aside={
          <EditDefinitionButton
            server={server}
            group={group}
            editable={editable}
            describedBy={!editable && explain ? noteId : undefined}
          />
        }
      >
        <div className={HARNESS_CARD_CLASS}>
          {note(group, noteId)}
          <McpDefinitionView definition={group.definition} layout="rows" />
        </div>
      </McpDetailPart>
    )
  }

  return (
    <McpDetailPart title={t("definitions")}>
      <div className="space-y-2.5">
        {server.groups.map((group) => {
          const editable = editableGroup(group)
          const id = `${noteId}-${group.letter}`
          return (
            <div key={group.fingerprint} className={HARNESS_CARD_CLASS}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/30 py-1.5 ps-4 pe-2">
                {/* Which agents hold it, each agent's row says. */}
                <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">
                  {t("definitionLetter", { letter: group.letter })}
                </span>
                <EditDefinitionButton
                  server={server}
                  group={group}
                  editable={editable}
                  describedBy={!editable && explain ? id : undefined}
                />
              </div>
              {note(group, id)}
              <McpDefinitionView definition={group.definition} layout="rows" />
            </div>
          )
        })}
      </div>
    </McpDetailPart>
  )
}

/** The marks a server from Harness carries: where it came from, how it
 *  stands — changed here, files missing, not checkable — where that is not
 *  the ordinary "as installed", and what the update check says of its
 *  version (an update, a withdrawn version) where that is not "up to date". */
export function HarnessMarks({
  mark,
  size,
  source = true,
  local = true,
}: {
  mark: McpHarnessMark
  size?: "sm" | "md"
  /** Also the "SRN Harness · version" mark — not where the place says it
   *  already (a list's group, a detail's line). */
  source?: boolean
  /** Also how the entries stand against the install — not where a line
   *  says it in words. */
  local?: boolean
}) {
  const t = useTranslations("Harness.mcp.harness")
  return (
    <>
      {source && (
        <DiscoverMark size={size}>
          <Package aria-hidden="true" />
          {mark.version
            ? t("markVersion", { version: mark.version })
            : t("mark")}
        </DiscoverMark>
      )}
      {local && mark.local !== "asInstalled" && (
        <DiscoverMark
          size={size}
          tone={mark.local === "unknown" ? "neutral" : "warning"}
        >
          {t(`states.${mark.local}`)}
        </DiscoverMark>
      )}
      {mark.remote !== null && mark.remote !== "latest" && (
        <DiscoverMark
          size={size}
          tone={mark.remote === "updateAvailable" ? "info" : "warning"}
        >
          {mark.remote === "updateAvailable" && (
            <ArrowUpCircle aria-hidden="true" />
          )}
          {t(`states.${mark.remote}`)}
        </DiscoverMark>
      )}
      {mark.updateAvailable && mark.remote !== "updateAvailable" && (
        <DiscoverMark size={size} tone="info">
          <ArrowUpCircle aria-hidden="true" />
          {t("states.updateAvailable")}
        </DiscoverMark>
      )}
    </>
  )
}

/** The definitions inside the source card's grid, under its status: each
 *  one's rows — headed by its letter where there are several — and why one
 *  cannot be edited, when the header does not say so. */
function SourceDefinitions({
  server,
  changeable,
  explain,
  noteId,
}: {
  server: McpServer
  changeable: readonly string[]
  explain: boolean
  noteId: string
}) {
  const t = useTranslations("Harness.mcp.detail")
  // Inside the card's grid: what is not a row spans it, under a rule.
  const across = "col-span-full border-t px-4 text-muted-foreground"
  if (server.groups.length === 0) {
    return <p className={cn(across, "py-3")}>{t("noDefinition")}</p>
  }
  const several = server.groups.length > 1
  const blocked =
    explain && server.groups.some((group) => !groupEditable(group, changeable))
  return (
    <>
      {blocked && (
        <p id={noteId} className={cn(across, "py-3 text-xs")}>
          {t("definitionNotEditable")}
        </p>
      )}
      {server.groups.map((group) => (
        <Fragment key={group.fingerprint}>
          {several && (
            <McpDefinitionRowsHead>
              {t("definitionLetter", { letter: group.letter })}
            </McpDefinitionRowsHead>
          )}
          <McpDefinitionView definition={group.definition} bare />
        </Fragment>
      ))}
    </>
  )
}

/**
 * Changing a server from Harness, in one place: its definition — each of
 * several on its own — and which agents it is installed in. One choice is a
 * button; more are a menu behind "Edit".
 */
function SourceEditMenu({
  server,
  changeable,
  manage,
  describedBy,
}: {
  server: McpServer
  changeable: readonly string[]
  manage?: () => void
  describedBy?: string
}) {
  const t = useTranslations("Harness.mcp.harness")
  const tDetail = useTranslations("Harness.mcp.detail")
  const { slots } = useHarnessView()
  const several = server.groups.length > 1
  const edits = server.groups.map((group) => ({
    key: group.fingerprint,
    label: several
      ? t("editDefinitionLetter", { letter: group.letter })
      : t("editDefinition"),
    disabled: !groupEditable(group, changeable),
    onSelect: () => openEditEditor(slots, server.key, group.fingerprint),
  }))
  const buttonClass = "rounded-full max-md:h-10"
  if (edits.length + (manage ? 1 : 0) === 0) return null
  if (edits.length === 0 && manage) {
    return (
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={manage}
        className={buttonClass}
      >
        <Users aria-hidden="true" />
        {t("manage")}
      </Button>
    )
  }
  if (edits.length === 1 && !manage) {
    const [edit] = edits
    return (
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={edit.disabled}
        aria-describedby={edit.disabled ? describedBy : undefined}
        onClick={edit.onSelect}
        className={buttonClass}
      >
        <PencilLine aria-hidden="true" />
        {tDetail("edit")}
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={buttonClass}
        >
          <PencilLine aria-hidden="true" />
          {tDetail("edit")}
          <ChevronDown aria-hidden="true" className="-me-0.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {edits.map((edit) => (
          <DropdownMenuItem
            key={edit.key}
            disabled={edit.disabled}
            onSelect={edit.onSelect}
          >
            <PencilLine aria-hidden="true" />
            {edit.label}
          </DropdownMenuItem>
        ))}
        {manage && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={manage}>
              <Users aria-hidden="true" />
              {t("manage")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A server from Harness, in one card: the item and its version; how its
 * entries stand against the install and what the update check says; what
 * the server runs; and what can be done with it as a Harness item — view
 * it, change it (its definition, its agents), update it. Updating and
 * adding agents ask the catalog, so where the catalog is switched off the
 * card says why they are missing. Which agent's entry differs from the
 * install, that agent's row says; uninstalling is the header's.
 */
function HarnessPart({
  server,
  mark,
  harness,
  changeable,
  explain,
  onView,
}: {
  server: McpServer
  mark: McpHarnessMark
  harness: McpHarnessSeam
  changeable: readonly string[]
  explain: boolean
  onView: () => void
}) {
  const t = useTranslations("Harness.mcp.harness")
  const tDetail = useTranslations("Harness.mcp.detail")
  const tItem = useTranslations("Harness.install.item")
  const labels = useMcpLabels()
  const noteId = useId()
  // The catalog's title as the record keeps it, in the reader's language;
  // the address stays under it.
  const title = pickLocalized(mark.title, harnessLang(labels.locale))
  const ref = (
    <bdi dir="ltr" className="font-mono">
      <MachineText>{mark.itemRef}</MachineText>
    </bdi>
  )
  const asInstalled = mark.local === "asInstalled"
  const notes = mark.local === "changedLocally" || !harness.catalog
  const manage = harness.manage
  return (
    <McpDetailPart title={tDetail("source")}>
      <div className={cn(HARNESS_CARD_CLASS, "divide-y")}>
        <div className="flex min-w-0 items-start gap-3 p-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary [&_svg]:size-5">
            <Package aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                dir="auto"
                className="min-w-0 text-base font-semibold break-words text-foreground"
              >
                {title || ref}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("title")}
              </span>
            </p>
            {title && (
              <p className="min-w-0 text-sm text-muted-foreground">{ref}</p>
            )}
          </div>
          <div className="shrink-0 space-y-1 text-end">
            {mark.version && (
              <p className="font-mono text-sm font-semibold text-foreground">
                <bdi dir="ltr">
                  {/^\d/.test(mark.version) ? `v${mark.version}` : mark.version}
                </bdi>
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {tItem("revisionOnly", { revision: mark.revision })}
            </p>
          </div>
        </div>
        {/* How the entries stand against the install, and what the update
            check says — a labelled row, in the same columns as the command
            under it; which agent differs, its row says. */}
        <McpDefinitionRows>
          <McpDefinitionRow
            label={t("state")}
            align={notes ? "start" : "center"}
          >
            <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5",
                  asInstalled ? "text-foreground" : "text-tone-warning"
                )}
              >
                {asInstalled ? (
                  <CircleCheck
                    aria-hidden="true"
                    className="size-4 text-tone-success"
                  />
                ) : (
                  <TriangleAlert aria-hidden="true" className="size-4" />
                )}
                {t(`states.${mark.local}`)}
              </span>
              <HarnessMarks mark={mark} source={false} local={false} />
            </div>
            {mark.local === "changedLocally" && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("changedNote")}
              </p>
            )}
            {!harness.catalog && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("catalogOff")}
              </p>
            )}
          </McpDefinitionRow>
          <SourceDefinitions
            server={server}
            changeable={changeable}
            explain={explain}
            noteId={noteId}
          />
        </McpDefinitionRows>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 bg-muted/40 px-4 py-2">
          {harness.catalog && (
            <HarnessUpdateStatus
              itemId={mark.itemId}
              inline
              className="min-w-0 flex-[1_1_auto]"
            />
          )}
          <div className="ms-auto flex flex-wrap items-center gap-1.5">
            {harness.catalog && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onView}
                className="rounded-full max-md:h-10"
              >
                <ExternalLink aria-hidden="true" />
                {t("view")}
              </Button>
            )}
            <SourceEditMenu
              server={server}
              changeable={changeable}
              manage={manage && (() => manage(server.key))}
              describedBy={noteId}
            />
            {harness.update && (
              <Button
                type="button"
                size="sm"
                variant={mark.updateAvailable ? "default" : "secondary"}
                onClick={() => harness.update?.(server.key)}
                className="rounded-full max-md:h-10"
              >
                <ArrowUpCircle aria-hidden="true" />
                {t("update")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </McpDetailPart>
  )
}

interface McpServerDetailProps {
  model: McpModel | null
  serverKey: string
  /** On a pane that shows one screen at a time: back to the list. */
  onBack?: () => void
  harness: McpHarnessSeam | undefined
}

/**
 * One server, across every agent: what it is — one definition, or each of
 * several, side by side — and, agent by agent, whether it is there, on or
 * off, and why it cannot be changed where it cannot. Every change goes
 * through a dialog that shows what will be written, or through one agent's
 * own switch.
 */
export function McpServerDetail({
  model,
  serverKey,
  onBack,
  harness,
}: McpServerDetailProps) {
  const t = useTranslations("Harness.mcp")
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const { openHarness } = useOpenHarness()
  const [showAll] = useHarnessSlot(MCP_SHOW_ALL_AGENTS)
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { ref: scrollerRef, onScroll } = useDetailScroll(`server:${serverKey}`)
  const server = model?.server(serverKey)

  // On a pane of its own, the detail is a new screen: the focus goes to its
  // heading, so a keyboard or a screen reader lands on the server.
  useEffect(() => {
    if (onBack) headingRef.current?.focus({ preventScroll: true })
  }, [onBack, serverKey])

  let body: ReactNode
  if (!model) {
    body = <DetailBodySkeleton />
  } else if (!server) {
    body = (
      <div
        role="status"
        className="flex min-h-48 items-center justify-center p-6"
      >
        <div className="flex max-w-md min-w-0 flex-col items-center gap-3 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <SearchX aria-hidden="true" className="size-5" />
          </span>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-medium outline-none"
          >
            {t.rich("detail.notFound", {
              key: serverKey,
              code: (chunks) => (
                <bdi dir="ltr" className="font-mono">
                  <MachineText>{chunks}</MachineText>
                </bdi>
              ),
            })}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("detail.notFoundHint")}
          </p>
        </div>
      </div>
    )
  } else {
    const mark = harness?.marks.get(server.key)
    const uninstall = mark ? harness?.uninstall : undefined
    const changeable = server.reserved ? [] : editableHolders(model, server.key)
    const editable = changeable.length > 0
    const visible = model.agents.filter(
      (info) =>
        showAll ||
        !isFolded(info) ||
        server.holders.some((holder) => holder.info === info)
    )
    const hidden = model.agents.length - visible.length
    const on = holderAgentIds(
      server.holders.filter((holder) => holder.entry.enabled)
    ).length
    body = (
      <article aria-labelledby={headingId} className={HARNESS_DETAIL_CLASS}>
        <header className={HARNESS_DETAIL_HEADER_CLASS}>
          <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-3">
            <span className={HARNESS_DETAIL_TILE_CLASS}>
              <ServerGlyph transports={server.transports} />
            </span>
            <div className="min-w-0 flex-1 basis-56 space-y-1 pt-1">
              <h2
                id={headingId}
                ref={headingRef}
                tabIndex={-1}
                className={HARNESS_DETAIL_TITLE_CLASS}
              >
                <bdi dir="ltr">
                  <MachineText>{server.key}</MachineText>
                </bdi>
              </h2>
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                {server.transports.length > 0 ? (
                  <bdi dir="ltr" className="font-mono">
                    {labels.transports(server.transports)}
                  </bdi>
                ) : (
                  <span>{t("row.noDefinition")}</span>
                )}
                <MetaDot />
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 rounded-full",
                      on > 0 ? "bg-tone-success" : "bg-muted-foreground/40"
                    )}
                  />
                  {t("detail.enabledIn", { count: on })}
                </span>
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!editable}
                onClick={() => openRenameDialog(slots, server.key)}
                className="rounded-full max-md:h-10"
              >
                <PencilLine aria-hidden="true" />
                {t("detail.rename")}
              </Button>
              {uninstall ? (
                // From Harness, removing it is uninstalling it: the entries
                // go, and the record forgets it — "Remove" would leave the
                // record behind, pointing at entries no longer there.
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => uninstall(server.key)}
                  className="rounded-full max-md:h-10"
                >
                  <PackageMinus aria-hidden="true" />
                  {t("harness.uninstall")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={!editable}
                  onClick={() => openRemoveDialog(slots, server.key)}
                  className="rounded-full max-md:h-10"
                >
                  <Trash2 aria-hidden="true" />
                  {t("detail.remove")}
                </Button>
              )}
            </div>
          </div>
          {(server.groups.length > 1 ||
            server.hasProblems ||
            server.reserved) && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {server.groups.length > 1 && (
                <DiscoverMark tone="info">
                  <Layers aria-hidden="true" />
                  {t("row.definitions", { count: server.groups.length })}
                </DiscoverMark>
              )}
              {server.hasProblems && (
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
            </div>
          )}
          {server.reserved && (
            <p className="rounded-xl border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
              {labels.issue({ code: "reserved_key" }, "entry")}
            </p>
          )}
          {!editable && !server.reserved && (
            <p className="text-xs text-muted-foreground">
              {t("detail.notEditable")}
            </p>
          )}
        </header>

        {mark && harness ? (
          <HarnessPart
            server={server}
            mark={mark}
            harness={harness}
            changeable={changeable}
            // The header already says so when no agent can change at all.
            explain={editable}
            onView={() =>
              openHarness({ section: "discover", itemRef: mark.itemRef })
            }
          />
        ) : (
          <DefinitionPart
            server={server}
            changeable={changeable}
            // The header already says so when no agent can change at all; one
            // definition among others says it for itself.
            explain={editable}
          />
        )}

        <McpDetailPart title={t("detail.agents")}>
          <ul className={cn("divide-y", HARNESS_CARD_CLASS)}>
            {visible.map((info) => (
              <AgentRow
                key={info.id}
                server={server}
                info={info}
                model={model}
                harness={mark}
              />
            ))}
          </ul>
          <ShowAllAgentsToggle hidden={hidden} className="px-1" />
        </McpDetailPart>
      </article>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {onBack && <McpBackBar onBack={onBack} />}
      <HarnessScroller ref={scrollerRef} onScroll={onScroll} className="flex-1">
        {body}
      </HarnessScroller>
    </div>
  )
}
