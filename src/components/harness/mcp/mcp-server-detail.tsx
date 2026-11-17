"use client"

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react"
import {
  ArrowLeft,
  ArrowUpCircle,
  ExternalLink,
  Layers,
  Loader2,
  Lock,
  Package,
  PackageMinus,
  PencilLine,
  RotateCw,
  SearchX,
  TextCursorInput,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
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
import { DiscoverMark } from "../discover/discover-card"
import { HarnessUpdateStatus } from "../harness-update-status"
import { MachineText } from "../machine-text"
import { AgentGlyph, McpDetailPart, PathText } from "./mcp-bits"
import { McpDefinitionView } from "./mcp-definition-view"
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
    <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-2 py-1.5 ws-chrome-border md:px-3">
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
export function ShowAllAgentsToggle({ hidden }: { hidden: number }) {
  const t = useTranslations("Harness.mcp.agents")
  const [showAll, setShowAll] = useHarnessSlot(MCP_SHOW_ALL_AGENTS)
  if (hidden === 0 && !showAll) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={showAll}
      onClick={() => setShowAll(!showAll)}
      className="mt-1 max-md:h-10"
    >
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

/** The state of an agent for a server, in words. */
function stateText(
  state: McpAgentServerState,
  server: McpServer,
  labels: McpLabels,
  t: ReturnType<typeof useTranslations<"Harness.mcp">>
): ReactNode {
  const { info } = state
  if (state.kind === "unreadable") {
    return (
      <>
        {t("agentState.unreadable")}{" "}
        {info.editBlock && labels.block(info.editBlock)}
      </>
    )
  }
  if (state.kind === "absent") {
    const block = state.block
    if (!block) return t("agentState.notConfigured")
    switch (block.kind) {
      case "agent":
        return labels.block(block.block)
      case "transport":
        return t("agentState.cannotHold", {
          transports: labels.transports(block.transports),
        })
      case "key":
        return t("agentState.keyNotNew")
      case "noDefinition":
        return t("agentState.noDefinition")
    }
  }
  const { holder, readOnly } = state
  const entry = holder.entry
  const letter =
    server.groups.length > 1 && holder.group !== null
      ? server.groups[holder.group].letter
      : null
  const onOff = entry.enabled ? t("agentState.on") : t("agentState.off")
  const base = letter
    ? t("agentState.withDefinition", { state: onOff, letter })
    : holder.group === null
      ? t("agentState.undescribed", { state: onOff })
      : onOff
  if (!readOnly) return base
  let why: ReactNode
  switch (readOnly.kind) {
    case "agent":
      why = labels.block(readOnly.block)
      break
    case "reserved":
      why = t("agentState.reserved")
      break
    case "duplicate":
      why = labels.issue(
        { code: "duplicate_key", field: readOnly.field ?? undefined },
        "entry"
      )
      break
    case "entry":
      why = t("agentState.readOnly")
      break
  }
  return (
    <>
      {base}
      {" · "}
      {why}
    </>
  )
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
}

/** One agent, for one server: what it has, why it cannot be changed if it
 *  cannot, and the switch. */
function AgentRow({ server, info, model }: AgentRowProps) {
  const t = useTranslations("Harness.mcp")
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const [writes] = useHarnessSlot(MCP_ROW_WRITES)
  const [busy] = useHarnessSlot(MCP_BUSY)
  const stateId = useId()
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

  return (
    <li className="flex min-w-0 items-start gap-3 px-3 py-2.5">
      <AgentGlyph agent={info.id} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{name}</span>
          {info.installed === false && (
            <DiscoverMark>{t("agents.notInstalled")}</DiscoverMark>
          )}
          {!info.agent && <DiscoverMark>{t("agents.unknown")}</DiscoverMark>}
        </div>
        <p id={stateId} className="mt-0.5 text-xs text-muted-foreground">
          {stateText(state, server, labels, t)}
          {skipped && (
            <>
              {" · "}
              {t("agentState.skipped")}
            </>
          )}
        </p>
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
          aria-describedby={stateId}
          className="relative after:absolute after:-inset-2.5"
        />
      </div>
    </li>
  )
}

/** One of the server's definitions, with the agents that hold it. */
function DefinitionCard({
  server,
  group,
  editable,
  explain,
}: {
  server: McpServer
  group: McpDefinitionGroup
  editable: boolean
  /** Say why it cannot be edited, when that is not said above. */
  explain: boolean
}) {
  const t = useTranslations("Harness.mcp.detail")
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const several = server.groups.length > 1
  const noteId = useId()
  const agents = labels.list(holderAgentIds(group.holders).map(labels.agent))
  return (
    <div className="min-w-0 rounded-lg border">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2">
        <span className="min-w-0 flex-1 text-xs">
          {several ? (
            <>
              <span className="font-semibold text-foreground">
                {t("definitionLetter", { letter: group.letter })}
              </span>
              <span className="text-muted-foreground"> · {agents}</span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {t("heldBy", { agents })}
            </span>
          )}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!editable}
          aria-describedby={!editable && explain ? noteId : undefined}
          onClick={() => openEditEditor(slots, server.key, group.fingerprint)}
          className="max-md:h-10"
        >
          <PencilLine aria-hidden="true" />
          {several ? t("editLetter", { letter: group.letter }) : t("edit")}
        </Button>
      </div>
      {!editable && explain && (
        <p
          id={noteId}
          className="border-b px-3 py-1.5 text-xs text-muted-foreground"
        >
          {t("definitionNotEditable")}
        </p>
      )}
      <McpDefinitionView
        definition={group.definition}
        className="px-3 py-2.5"
      />
    </div>
  )
}

/** The marks a server from Harness carries: where it came from, how it
 *  stands — changed here, files missing, not checkable — where that is not
 *  the ordinary "as installed", and what the update check says of its
 *  version (an update, a withdrawn version) where that is not "up to date". */
export function HarnessMarks({ mark }: { mark: McpHarnessMark }) {
  const t = useTranslations("Harness.mcp.harness")
  return (
    <>
      <DiscoverMark>
        <Package aria-hidden="true" />
        {mark.version ? t("markVersion", { version: mark.version }) : t("mark")}
      </DiscoverMark>
      {mark.local !== "asInstalled" && (
        <DiscoverMark tone={mark.local === "unknown" ? "neutral" : "warning"}>
          {t(`states.${mark.local}`)}
        </DiscoverMark>
      )}
      {mark.remote !== null && mark.remote !== "latest" && (
        <DiscoverMark
          tone={mark.remote === "updateAvailable" ? "info" : "warning"}
        >
          {mark.remote === "updateAvailable" && (
            <ArrowUpCircle aria-hidden="true" />
          )}
          {t(`states.${mark.remote}`)}
        </DiscoverMark>
      )}
      {mark.updateAvailable && mark.remote !== "updateAvailable" && (
        <DiscoverMark tone="info">
          <ArrowUpCircle aria-hidden="true" />
          {t("states.updateAvailable")}
        </DiscoverMark>
      )}
    </>
  )
}

/**
 * Where a server from Harness came from — the item, the version — how its
 * entry stands in each agent it was installed in, and what can be done with
 * it as a Harness item: update it, add it to more agents, uninstall it. The
 * first two ask the catalog, so where the catalog is switched off only
 * uninstalling is offered, and the part says why.
 */
function HarnessPart({
  serverKey,
  mark,
  harness,
  onView,
}: {
  serverKey: string
  mark: McpHarnessMark
  harness: McpHarnessSeam
  onView: () => void
}) {
  const t = useTranslations("Harness.mcp.harness")
  const tItem = useTranslations("Harness.install.item")
  const labels = useMcpLabels()
  // The catalog's title as the record keeps it, in the reader's language;
  // the address stays under it.
  const title = pickLocalized(mark.title, harnessLang(labels.locale))
  return (
    <McpDetailPart title={t("title")}>
      <div className="min-w-0 space-y-2.5 rounded-lg border px-3 py-2.5 text-xs">
        <div className="min-w-0 space-y-0.5">
          {title && (
            <p
              dir="auto"
              className="text-sm font-medium break-words text-foreground"
            >
              {title}
            </p>
          )}
          <p className="min-w-0">
            <bdi
              dir="ltr"
              className={cn(
                "font-mono",
                title ? "text-muted-foreground" : "text-foreground"
              )}
            >
              <MachineText>{mark.itemRef}</MachineText>
            </bdi>
          </p>
          <p className="text-muted-foreground">
            {mark.version
              ? tItem.rich("version", {
                  version: mark.version,
                  revision: mark.revision,
                  code: (chunks) => (
                    <bdi dir="ltr" className="font-mono">
                      <MachineText>{chunks}</MachineText>
                    </bdi>
                  ),
                })
              : tItem("revisionOnly", { revision: mark.revision })}
          </p>
        </div>
        <ul aria-label={t("agents")} className="min-w-0 space-y-1">
          {mark.agents.map((agent) => (
            <li
              key={agent.agent}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
            >
              <AgentGlyph agent={agent.agent} />
              <span className="font-medium">{labels.agent(agent.agent)}</span>
              <span
                className={cn(
                  agent.local === "asInstalled"
                    ? "text-muted-foreground"
                    : "text-tone-warning"
                )}
              >
                {t(`states.${agent.local}`)}
                {agent.version &&
                  agent.version !== mark.version &&
                  ` · ${agent.version}`}
              </span>
            </li>
          ))}
        </ul>
        {mark.local === "changedLocally" && (
          <p className="text-muted-foreground">{t("changedNote")}</p>
        )}
        {harness.catalog && <HarnessUpdateStatus itemId={mark.itemId} />}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {harness.update && (
            <Button
              type="button"
              size="sm"
              variant={mark.updateAvailable ? "default" : "outline"}
              onClick={() => harness.update?.(serverKey)}
              className="max-md:h-10"
            >
              <ArrowUpCircle aria-hidden="true" />
              {t("update")}
            </Button>
          )}
          {harness.manage && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => harness.manage?.(serverKey)}
              className="max-md:h-10"
            >
              <Users aria-hidden="true" />
              {t("manage")}
            </Button>
          )}
          {harness.uninstall && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => harness.uninstall?.(serverKey)}
              className="max-md:h-10"
            >
              <PackageMinus aria-hidden="true" />
              {t("uninstall")}
            </Button>
          )}
          {harness.catalog && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onView}
              className="max-md:h-10"
            >
              <ExternalLink aria-hidden="true" />
              {t("view")}
            </Button>
          )}
        </div>
        {!harness.catalog && (
          <p className="text-muted-foreground">{t("catalogOff")}</p>
        )}
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
    body = (
      <div aria-hidden="true" className="space-y-3 px-3 py-4 md:px-5">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
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
    const changeable = server.reserved ? [] : editableHolders(model, server.key)
    const editable = changeable.length > 0
    const visible = model.agents.filter(
      (info) =>
        showAll ||
        !isFolded(info) ||
        server.holders.some((holder) => holder.info === info)
    )
    const hidden = model.agents.length - visible.length
    body = (
      <article
        aria-labelledby={headingId}
        className="mx-auto w-full max-w-4xl min-w-0 space-y-5 px-3 py-4 md:px-5"
      >
        <header className="min-w-0 space-y-2">
          {(server.groups.length > 1 ||
            server.hasProblems ||
            server.reserved ||
            mark) && (
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
              {mark && <HarnessMarks mark={mark} />}
            </div>
          )}
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-lg leading-snug font-semibold outline-none"
          >
            <bdi dir="ltr">
              <MachineText>{server.key}</MachineText>
            </bdi>
          </h2>
          <p className="text-xs text-muted-foreground">
            {server.transports.length > 0
              ? labels.transports(server.transports)
              : t("row.noDefinition")}
            {" · "}
            {t("detail.inAgents", {
              count: holderAgentIds(server.holders).length,
            })}
          </p>
          {server.reserved && (
            <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {labels.issue({ code: "reserved_key" }, "entry")}
            </p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!editable}
              onClick={() => openRenameDialog(slots, server.key)}
              className="max-md:h-10"
            >
              <TextCursorInput aria-hidden="true" />
              {t("detail.rename")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!editable}
              onClick={() => openRemoveDialog(slots, server.key)}
              className="max-md:h-10"
            >
              <Trash2 aria-hidden="true" />
              {t("detail.remove")}
            </Button>
          </div>
          {!editable && !server.reserved && (
            <p className="text-xs text-muted-foreground">
              {t("detail.notEditable")}
            </p>
          )}
        </header>

        {mark && harness && (
          <HarnessPart
            serverKey={server.key}
            mark={mark}
            harness={harness}
            onView={() =>
              openHarness({ section: "discover", itemRef: mark.itemRef })
            }
          />
        )}

        <McpDetailPart
          title={
            server.groups.length > 1
              ? t("detail.definitions")
              : t("detail.definition")
          }
        >
          <div className="space-y-2">
            {server.groups.map((group) => (
              <DefinitionCard
                key={group.fingerprint}
                server={server}
                group={group}
                // As Rename and Remove: an edit writes to the agents that
                // hold this definition, and where none of them can change,
                // there is nothing it could save. (Adding the server to
                // another agent is that agent's switch, below.)
                editable={group.holders.some(
                  (holder) =>
                    holder.info.agent !== null &&
                    changeable.includes(holder.info.agent)
                )}
                // The header already says so when no agent can change at
                // all; one definition among others says it for itself.
                explain={editable}
              />
            ))}
            {server.groups.length === 0 && (
              <p className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
                {t("detail.noDefinition")}
              </p>
            )}
          </div>
        </McpDetailPart>

        <McpDetailPart title={t("detail.agents")}>
          <ul className="divide-y rounded-lg border">
            {visible.map((info) => (
              <AgentRow
                key={info.id}
                server={server}
                info={info}
                model={model}
              />
            ))}
          </ul>
          <ShowAllAgentsToggle hidden={hidden} />
        </McpDetailPart>
      </article>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {onBack && <McpBackBar onBack={onBack} />}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        {body}
      </div>
    </div>
  )
}
