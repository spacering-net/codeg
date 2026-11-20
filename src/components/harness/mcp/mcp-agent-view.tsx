"use client"

import { memo, useEffect, useId, useRef, type ReactNode } from "react"
import {
  Bubbles,
  Copy,
  Link2,
  Loader2,
  Settings2,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import { openSettingsWindow } from "@/lib/api"
import {
  dismissRow,
  isAgentBusy,
  MCP_BUSY,
  MCP_ROW_WRITES,
  openMcpServer,
  requestSwitch,
  rowId,
  writeRow,
} from "@/lib/harness/mcp-state"
import {
  agentHasFileProblem,
  agentServerState,
  isNotableProblem,
  isSkippedInSessions,
  readOnlyReasonOf,
  switchOf,
  type McpAgentInfo,
  type McpModel,
} from "@/lib/mcp/model"
import type { McpEntry } from "@/lib/mcp/types"
import { cn, copyTextToClipboard } from "@/lib/utils"
import { HarnessScroller } from "../harness-scroller"
import { DiscoverMark } from "../discover/discover-card"
import {
  HARNESS_CARD_CLASS,
  HARNESS_DETAIL_CLASS,
  HARNESS_DETAIL_HEADER_CLASS,
  HARNESS_DETAIL_TILE_CLASS,
  HARNESS_DETAIL_TITLE_CLASS,
  HARNESS_ROW_CLASS,
  HARNESS_ROW_TILE_CLASS,
  HARNESS_ROWS_CLASS,
} from "../harness-styles"
import { MachineText } from "../machine-text"
import { AgentGlyph, McpDetailPart, PathText } from "./mcp-bits"
import {
  DetailBodySkeleton,
  McpBackBar,
  RowWriteNotice,
  STATED_PROBLEMS,
  useDetailScroll,
} from "./mcp-server-detail"
import { useMcpLabels } from "./use-mcp-labels"

// ─── The list of agents ───────────────────────────────────────────────

interface McpAgentRowProps {
  info: McpAgentInfo
  /** The entries the filters let through. */
  count: number
  /** Every entry it has, whatever the filters say. */
  total: number
  selected: boolean
  filtered: boolean
  onOpen: (id: string) => void
}

/** One agent of the agent view's list. */
export const McpAgentRow = memo(function McpAgentRow({
  info,
  count,
  total,
  selected,
  filtered,
  onOpen,
}: McpAgentRowProps) {
  const t = useTranslations("Harness.mcp.agents")
  const labels = useMcpLabels()
  const problem =
    agentHasFileProblem(info) ||
    info.inventory.entries.some((entry) =>
      entry.problems.some(isNotableProblem)
    )
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-mcp-row={info.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(info.id)}
        className={HARNESS_ROW_CLASS}
      >
        <span className={HARNESS_ROW_TILE_CLASS}>
          <AgentGlyph agent={info.id} className="size-4.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {labels.agent(info.id)}
            </span>
            {(problem || info.installed === false || !info.agent) && (
              <span className="flex shrink-0 items-center gap-1">
                {problem && (
                  <DiscoverMark size="sm" tone="warning">
                    <TriangleAlert aria-hidden="true" />
                    <span className="sr-only">{t("problem")}</span>
                  </DiscoverMark>
                )}
                {info.installed === false && (
                  <DiscoverMark size="sm">{t("notInstalled")}</DiscoverMark>
                )}
                {!info.agent && (
                  <DiscoverMark size="sm">{t("unknown")}</DiscoverMark>
                )}
              </span>
            )}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {info.unreadable
              ? t("unreadable")
              : filtered
                ? t("matching", { count, total })
                : t("servers", { count: total })}
          </span>
        </span>
      </button>
    </li>
  )
})

// ─── One agent ────────────────────────────────────────────────────────

function FileFacts({ info }: { info: McpAgentInfo }) {
  const t = useTranslations("Harness.mcp.agent")
  const labels = useMcpLabels()
  const [copied, markCopied] = useCopiedFlag()
  const { config } = info.inventory
  const status = config.status
  let statusText: ReactNode
  switch (status) {
    case "ok":
      statusText = t("status.ok")
      break
    case "missing":
      statusText = t("status.missing")
      break
    case "unreadable":
      statusText = t("status.unreadable")
      break
    case "read_only":
      statusText = t("status.readOnly")
      break
    default:
      statusText = t("status.unknown", { status })
  }
  const problem = agentHasFileProblem(info)
  return (
    <McpDetailPart title={t("file")}>
      <div className="space-y-2.5 rounded-xl border bg-card px-4 py-3.5 text-sm">
        <div className="flex min-w-0 items-start gap-1.5">
          <PathText
            path={config.path || "—"}
            className="flex-1 text-[0.8125rem] text-foreground"
          />
          {config.path && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={copied ? t("copied") : t("copyPath")}
              title={copied ? t("copied") : t("copyPath")}
              onClick={() => {
                void copyTextToClipboard(config.path).then((ok) => {
                  if (ok) markCopied()
                })
              }}
              className="-my-0.5 shrink-0 text-muted-foreground max-md:size-9"
            >
              <Copy aria-hidden="true" />
            </Button>
          )}
        </div>
        <p className="text-muted-foreground">
          {labels.format(config.format)}
          {" · "}
          <span className={cn(problem && "text-tone-warning")}>
            {statusText}
          </span>
        </p>
        {info.editBlock && info.editBlock.kind !== "unknownAgent" && (
          <p
            className={cn(
              "flex min-w-0 items-start gap-1.5",
              problem ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {problem && (
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
              />
            )}
            <span className="min-w-0">
              {labels.block(info.editBlock)}
              {(info.editBlock.kind === "file"
                ? info.editBlock.reason?.detail
                : info.editBlock.reason.detail) && (
                <bdi
                  dir="ltr"
                  className="mt-0.5 block font-mono text-2xs text-muted-foreground"
                >
                  <MachineText>
                    {info.editBlock.kind === "file"
                      ? info.editBlock.reason?.detail
                      : info.editBlock.reason.detail}
                  </MachineText>
                </bdi>
              )}
            </span>
          </p>
        )}
        {!info.agent && (
          <p className="text-muted-foreground">{t("unknownAgent")}</p>
        )}
        {config.symlink && (
          <p className="flex items-start gap-1.5 text-muted-foreground">
            <Link2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {t("symlink")}
          </p>
        )}
        {config.comments_lost_on_write && (
          <p className="text-tone-warning">{t("commentsLost")}</p>
        )}
        {config.related.map((file) => (
          <div key={file.path} className="min-w-0 space-y-0.5 border-t pt-2">
            <p className="text-muted-foreground">{t("pluginGate")}</p>
            <PathText path={file.path} />
            {file.reason && (
              <p className="text-tone-warning">
                {labels.issue(file.reason, "related")}
              </p>
            )}
          </div>
        ))}
      </div>
    </McpDetailPart>
  )
}

function SessionFacts({ info }: { info: McpAgentInfo }) {
  const t = useTranslations("Harness.mcp.agent")
  const labels = useMcpLabels()
  const { delivery, session_capabilities: caps } = info.inventory
  let capsText: ReactNode = null
  if (delivery === "codeg_session") {
    if (!caps) {
      capsText = t("capsUnknown")
    } else {
      const skipped = [
        !caps.http ? labels.transport("http") : null,
        !caps.sse ? labels.transport("sse") : null,
      ].filter((value): value is string => value !== null)
      const when = labels.date(caps.recorded_at)
      capsText =
        skipped.length === 0
          ? t("capsAll", { when })
          : t("capsSkips", { when, transports: labels.list(skipped) })
    }
  }
  return (
    <McpDetailPart title={t("sessions")}>
      <div className="space-y-1.5 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
        <p className="text-foreground">
          {delivery === "agent_file"
            ? t("deliveryFile")
            : delivery === "codeg_session"
              ? t("deliverySession")
              : t("deliveryUnknown")}
        </p>
        {capsText && <p>{capsText}</p>}
      </div>
    </McpDetailPart>
  )
}

/** One entry of the agent's file, with its own switch. */
function EntryRow({
  info,
  entry,
  model,
}: {
  info: McpAgentInfo
  entry: McpEntry
  model: McpModel
}) {
  const t = useTranslations("Harness.mcp")
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const [writes] = useHarnessSlot(MCP_ROW_WRITES)
  const [busy] = useHarnessSlot(MCP_BUSY)
  const stateId = useId()
  const server = model.server(entry.key)
  const state = server ? agentServerState(server, info, model.rules) : null
  const control = state
    ? switchOf(state)
    : { checked: entry.enabled, action: null }
  const write = writes[rowId(info.id, entry.key)]
  const agentBusy = isAgentBusy(busy, info.id)
  const pending =
    write !== undefined &&
    (write.phase === "saving" || (write.phase === "saved" && agentBusy))
  const checked = pending ? write.target : control.checked
  const readOnly = readOnlyReasonOf(info, entry)
  // Without what the state line already says.
  const problems = entry.problems.filter(
    (problem) => isNotableProblem(problem) && !STATED_PROBLEMS.has(problem.code)
  )
  const differs = server !== undefined && server.groups.length > 1
  const skipped = entry.enabled && isSkippedInSessions(info, entry)
  const transport = entry.definition
    ? labels.transport(entry.definition.type)
    : t("row.noDefinition")

  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={() => openMcpServer(slots, entry.key)}
            className="h-auto min-w-0 justify-start p-0 text-sm font-medium text-foreground max-md:min-h-9"
            title={t("agent.showServer")}
          >
            <bdi dir="ltr" className="min-w-0 truncate">
              {entry.key}
            </bdi>
          </Button>
          {differs && (
            <DiscoverMark size="sm" tone="info">
              {t("agent.differs")}
            </DiscoverMark>
          )}
          {entry.legacy && (
            <DiscoverMark size="sm">{t("agent.legacy")}</DiscoverMark>
          )}
          {skipped && (
            <DiscoverMark size="sm" tone="warning">
              {t("agent.skipped")}
            </DiscoverMark>
          )}
        </div>
        <p id={stateId} className="mt-0.5 text-xs text-muted-foreground">
          {transport}
          {" · "}
          {entry.enabled ? t("agentState.on") : t("agentState.off")}
          {readOnly && (
            <>
              {" · "}
              {readOnly.kind === "agent"
                ? labels.block(readOnly.block)
                : readOnly.kind === "reserved"
                  ? t("agentState.reserved")
                  : readOnly.kind === "duplicate"
                    ? labels.issue(
                        {
                          code: "duplicate_key",
                          field: readOnly.field ?? undefined,
                        },
                        "entry"
                      )
                    : t("agentState.readOnly")}
            </>
          )}
        </p>
        {problems.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs">
            {problems.map((problem, index) => (
              <li key={index} className="flex min-w-0 items-start gap-1.5">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-3 shrink-0 text-tone-warning"
                />
                <span className="min-w-0">
                  {labels.issue(problem, "entry")}
                </span>
              </li>
            ))}
          </ul>
        )}
        {write && (
          <RowWriteNotice
            write={write}
            busy={agentBusy}
            onRetry={() => {
              dismissRow(slots, info.id, entry.key)
              void writeRow(
                slots,
                write.agent,
                write.key,
                write.action,
                write.basis
              )
            }}
            onDismiss={() => dismissRow(slots, info.id, entry.key)}
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
          onCheckedChange={() => requestSwitch(slots, entry.key, info.id)}
          aria-label={entry.key}
          aria-describedby={stateId}
          className="relative after:absolute after:-inset-2.5"
        />
      </div>
    </li>
  )
}

/**
 * The built-in collaboration server, as an agent's sessions may receive it.
 * It is not in any file, and the inventory does not say whether it is on:
 * its one switch is in Settings › Collaboration, which this row opens.
 */
function BuiltInRow() {
  const t = useTranslations("Harness.mcp.agent")
  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-2.5">
      <Bubbles
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {t.rich("builtIn", {
            code: (chunks) => (
              <bdi dir="ltr" className="font-mono">
                <MachineText>{chunks}</MachineText>
              </bdi>
            ),
          })}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("builtInNote")}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          openSettingsWindow("collaboration").catch((error) => {
            console.error("[McpSection] failed to open settings:", error)
          })
        }}
        className="shrink-0 max-md:h-10"
      >
        <Settings2 aria-hidden="true" />
        {t("openCollaboration")}
      </Button>
    </li>
  )
}

interface McpAgentDetailProps {
  model: McpModel | null
  agentId: string
  /** The entries the filters let through, in file order. */
  entries: McpEntry[] | null
  filtered: boolean
  onBack?: () => void
}

/**
 * One agent: where its configuration really is (the path with its launch
 * environment applied), whether Codeg can change it and why not, how the
 * servers reach its sessions, and every entry in it — read-only ones and the
 * built-in server included.
 */
export function McpAgentDetail({
  model,
  agentId,
  entries,
  filtered,
  onBack,
}: McpAgentDetailProps) {
  const t = useTranslations("Harness.mcp")
  const labels = useMcpLabels()
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { ref: scrollerRef, onScroll } = useDetailScroll(`agent:${agentId}`)
  const info = model?.agent(agentId)

  useEffect(() => {
    if (onBack) headingRef.current?.focus({ preventScroll: true })
  }, [onBack, agentId])

  let body: ReactNode
  if (!model) {
    body = <DetailBodySkeleton />
  } else if (!info) {
    body = (
      <p
        role="status"
        className="p-6 text-center text-sm text-muted-foreground"
      >
        {t("agent.notFound")}
      </p>
    )
  } else {
    const shown = entries ?? info.inventory.entries
    body = (
      <article aria-labelledby={headingId} className={HARNESS_DETAIL_CLASS}>
        <header
          className={cn(
            HARNESS_DETAIL_HEADER_CLASS,
            "flex min-w-0 items-start gap-4 space-y-0"
          )}
        >
          <span className={HARNESS_DETAIL_TILE_CLASS}>
            <AgentGlyph agent={info.id} className="size-7" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5 pt-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              <h2
                id={headingId}
                ref={headingRef}
                tabIndex={-1}
                className={cn("min-w-0 truncate", HARNESS_DETAIL_TITLE_CLASS)}
              >
                {labels.agent(info.id)}
              </h2>
              {info.installed === false && (
                <DiscoverMark size="sm">
                  {t("agents.notInstalled")}
                </DiscoverMark>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {info.unreadable
                ? t("agents.unreadable")
                : t("agents.servers", { count: info.inventory.entries.length })}
            </p>
          </div>
        </header>
        <FileFacts info={info} />
        <SessionFacts info={info} />
        <McpDetailPart
          title={t("agent.entries")}
          aside={
            filtered
              ? t("agents.matching", {
                  count: shown.length,
                  total: info.inventory.entries.length,
                })
              : undefined
          }
        >
          {info.unreadable ? (
            <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
              {t("agent.entriesUnknown")}
            </p>
          ) : (
            <ul className={cn("divide-y", HARNESS_CARD_CLASS)}>
              {shown.map((entry, position) => (
                <EntryRow
                  // Two entries can share a key (two YAML keys that read
                  // as one name); both are listed.
                  key={`${position}:${entry.key}`}
                  info={info}
                  entry={entry}
                  model={model}
                />
              ))}
              {shown.length === 0 && (
                <li className="px-4 py-2.5 text-sm text-muted-foreground">
                  {filtered ? t("agent.noneMatch") : t("agent.none")}
                </li>
              )}
              {info.inventory.codeg_mcp && !filtered && <BuiltInRow />}
            </ul>
          )}
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

/** A list's place while it is read: rows in the shape the list's rows have. */
export function RowListSkeleton() {
  return (
    <ul aria-hidden="true" className={HARNESS_ROWS_CLASS}>
      {["w-28", "w-36", "w-24", "w-32", "w-28", "w-20"].map((width, index) => (
        <li
          key={index}
          className="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-3 dark:bg-card"
        >
          <Skeleton className="size-9 rounded-lg" />
          <span className="flex-1 space-y-2">
            <Skeleton className={cn("h-3.5", width)} />
            <Skeleton className="h-3 w-16" />
          </span>
        </li>
      ))}
    </ul>
  )
}
