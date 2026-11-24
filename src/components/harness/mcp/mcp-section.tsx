"use client"

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import {
  CircleArrowUp,
  MousePointerClick,
  PlugZap,
  RotateCw,
  SearchX,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { AppearanceContext } from "@/components/appearance-provider"
import { Button } from "@/components/ui/button"
import {
  useConsumeHarnessTarget,
  useHarnessSlot,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { useElementWidth } from "@/hooks/use-element-width"
import { useHistoryBackDismiss } from "@/hooks/use-history-back-dismiss"
import { useIsMobile } from "@/hooks/use-mobile"
import { useMcpHarness, type McpHarnessSeam } from "@/lib/harness/mcp-marks"
import { useHarnessInstalledSync } from "@/lib/harness/use-harness-installed"
import { useHarnessUpdatesCheckOnOpen } from "@/lib/harness/use-harness-updates"
import {
  closeMcpDetail,
  DEFAULT_MCP_FILTERS,
  MCP_ANNOUNCEMENT,
  MCP_DIALOG,
  MCP_FILTERS,
  MCP_INVENTORY,
  MCP_LIST_SCROLL,
  MCP_RETURN_FOCUS,
  MCP_SELECTED_AGENT,
  MCP_SELECTED_SERVER,
  MCP_SHOW_ALL_AGENTS,
  MCP_VIEW,
  modelOf,
  openCreateEditor,
  openMcpServer,
  reloadMcpInventory,
  selectAgent,
  selectServer,
  type McpFilters,
} from "@/lib/harness/mcp-state"
import { onMcpChanged } from "@/lib/mcp/api"
import type { McpFailure } from "@/lib/mcp/errors"
import {
  agentHasFileProblem,
  entryHasProblems,
  isFolded,
  matchesSearch,
  type McpAgentInfo,
  type McpModel,
  type McpServer,
} from "@/lib/mcp/model"
import type { McpEntry } from "@/lib/mcp/types"
import {
  HARNESS_GROUP_LABEL_CLASS,
  HARNESS_LIST_PAD_CLASS,
  HARNESS_LIST_PANE_CLASS,
  HARNESS_ROW_GROUPS_CLASS,
  HARNESS_ROWS_CLASS,
  HARNESS_TOOLBAR_CLASS,
} from "../harness-styles"
import { HarnessScroller } from "../harness-scroller"
import { getTransport } from "@/lib/transport"
import { cn } from "@/lib/utils"
import { useHarnessHost } from "../harness-host-label"
import { HarnessRecordProblem } from "../install/install-parts"
import { MachineText } from "../machine-text"
import { McpAgentDetail, McpAgentRow, RowListSkeleton } from "./mcp-agent-view"
import {
  McpConfirmSwitchDialog,
  McpRemoveDialog,
  McpRenameDialog,
} from "./mcp-change-dialogs"
import { McpEditorDialog } from "./mcp-editor-dialog"
import { McpPasteDialog } from "./mcp-paste-dialog"
import { McpServerDetail, ShowAllAgentsToggle } from "./mcp-server-detail"
import { McpServerRow, moveRowFocus } from "./mcp-server-list"
import { McpToolbar } from "./mcp-toolbar"
import { useMcpLabels } from "./use-mcp-labels"

/**
 * The section width, in rem, from which the list and the detail sit side by
 * side: a list of about 20rem and a detail that still has room for a
 * definition and an agent row with its switch. Narrower, they are two
 * screens, one at a time. In rem for the reason the page gives — the app's
 * zoom scales everything it is weighed against.
 */
const SPLIT_MIN_REM = 46

// ─── Filtering ────────────────────────────────────────────────────────

function serverShown(
  server: McpServer,
  filters: McpFilters,
  harness: McpHarnessSeam | undefined
): boolean {
  if (!matchesSearch(server.key, filters.text)) return false
  switch (filters.show) {
    case "problems":
      return server.hasProblems
    case "harness":
      return harness?.marks.has(server.key) === true
    case "updates":
      return harness?.marks.get(server.key)?.updateAvailable === true
    default:
      return true
  }
}

function entryShown(
  info: McpAgentInfo,
  entry: McpEntry,
  filters: McpFilters,
  harness: McpHarnessSeam | undefined
): boolean {
  if (!matchesSearch(entry.key, filters.text)) return false
  switch (filters.show) {
    case "problems":
      return entryHasProblems(info, entry)
    case "harness":
      return harness?.marks.has(entry.key) === true
    case "updates":
      return harness?.marks.get(entry.key)?.updateAvailable === true
    default:
      return true
  }
}

const isFiltering = (filters: McpFilters) =>
  filters.text.trim() !== "" || filters.show !== "all"

interface AgentListRow {
  info: McpAgentInfo
  entries: McpEntry[]
}

/** The agent view's rows: every agent with an entry the filters let through
 *  — with no filter, every agent, the folded ones once asked for. */
function agentRows(
  model: McpModel,
  filters: McpFilters,
  showAll: boolean,
  harness: McpHarnessSeam | undefined
): { rows: AgentListRow[]; folded: number } {
  const filtering = isFiltering(filters)
  const all = model.agents.map((info) => ({
    info,
    entries: info.inventory.entries.filter((entry) =>
      entryShown(info, entry, filters, harness)
    ),
  }))
  if (filtering) {
    return {
      rows: all.filter(
        ({ info, entries }) =>
          entries.length > 0 ||
          (filters.show === "problems" &&
            filters.text.trim() === "" &&
            agentHasFileProblem(info))
      ),
      folded: 0,
    }
  }
  const rows = all.filter(({ info }) => showAll || !isFolded(info))
  return { rows, folded: all.length - rows.length }
}

// ─── Pieces ───────────────────────────────────────────────────────────

/** In place of the section on a backend too old to have the engine: what to
 *  do about it, worded for the host — which Codeg needs updating is the
 *  whole message. */
function McpUnsupported() {
  const t = useTranslations("Harness.mcp.errors")
  const host = useHarnessHost()
  return (
    <div
      role="alert"
      className="flex h-full min-h-48 items-center justify-center p-6"
    >
      <div className="flex max-w-md min-w-0 flex-col items-center gap-3 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <CircleArrowUp aria-hidden="true" className="size-5" />
        </span>
        <p className="text-sm text-foreground">
          {t(
            host.kind === "remote"
              ? "unsupportedRemote"
              : host.kind === "web"
                ? "unsupportedWeb"
                : "unsupported"
          )}
        </p>
      </div>
    </div>
  )
}

function LoadFailure({
  failure,
  variant,
  onRetry,
}: {
  failure: McpFailure
  variant: "pane" | "banner"
  onRetry: () => void
}) {
  const t = useTranslations("Harness.mcp.errors")
  const retry = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onRetry}
      className="max-md:h-10"
    >
      <RotateCw aria-hidden="true" />
      {t("retry")}
    </Button>
  )
  const detail = failure.detail && (
    <bdi
      dir="ltr"
      className="block max-w-full font-mono text-2xs text-muted-foreground"
    >
      <MachineText>{failure.detail}</MachineText>
    </bdi>
  )
  if (variant === "banner") {
    return (
      <div
        role="alert"
        className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-tone-warning/10 px-3 py-2 text-xs"
      >
        <TriangleAlert
          aria-hidden="true"
          className="size-3.5 shrink-0 text-tone-warning"
        />
        <span className="min-w-0 flex-1">
          {t("refreshFailed")}
          {detail}
        </span>
        {retry}
      </div>
    )
  }
  return (
    <div role="alert" className="flex min-h-48 items-center justify-center p-6">
      <div className="flex max-w-md min-w-0 flex-col items-center gap-3 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <TriangleAlert aria-hidden="true" className="size-5" />
        </span>
        <p className="text-sm text-foreground">
          {failure.kind === "invalidResponse"
            ? t("invalidResponse")
            : t("loadFailed")}
        </p>
        {detail}
        {retry}
      </div>
    </div>
  )
}

function EmptyState({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode
  title: string
  hint?: string
  children?: ReactNode
}) {
  return (
    // Top-aligned, not centred: the list's and the detail's stand side by
    // side, and their icons line up whatever each says under them.
    <div className="flex justify-center px-6 pt-10 pb-6">
      <div className="flex max-w-sm min-w-0 flex-col items-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {icon}
        </span>
        <p className="text-sm font-medium">{title}</p>
        {hint && (
          <p className="text-xs text-balance text-muted-foreground">{hint}</p>
        )}
        {children}
      </div>
    </div>
  )
}

/** What a screen reader is told after a switch has saved, or has not. */
function Announcer() {
  const t = useTranslations("Harness.mcp.announce")
  const labels = useMcpLabels()
  const [announcement] = useHarnessSlot(MCP_ANNOUNCEMENT)
  let text = ""
  if (announcement) {
    const values = {
      agent: labels.agent(announcement.agent),
      key: announcement.key,
    }
    text = !announcement.saved
      ? t("failed", values)
      : t(announcement.target ? "on" : "off", values)
  }
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {text}
    </p>
  )
}

function McpDialogs({ model }: { model: McpModel | null }) {
  const [dialog] = useHarnessSlot(MCP_DIALOG)
  if (!dialog) return null
  switch (dialog.kind) {
    case "editor":
      return <McpEditorDialog key={dialog.id} dialog={dialog} model={model} />
    case "remove":
      return <McpRemoveDialog key={dialog.id} dialog={dialog} model={model} />
    case "rename":
      return <McpRenameDialog key={dialog.id} dialog={dialog} model={model} />
    case "paste":
      return <McpPasteDialog key={dialog.id} dialog={dialog} model={model} />
    case "confirm":
      return (
        <McpConfirmSwitchDialog key={dialog.id} dialog={dialog} model={model} />
      )
  }
}

/** The title over a list or one of its groups, with its count. The list is
 *  named for itself, so the title is for the eye only. */
function ListTitle({ label, count }: { label: string; count: number }) {
  return (
    <p aria-hidden="true" className={HARNESS_GROUP_LABEL_CLASS}>
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </p>
  )
}

/**
 * The servers, as cards. Where some came from Harness, they come first,
 * under the catalog's name, and the rest under "Added by hand" — each group
 * with its count; otherwise one plain list.
 */
function ServerList({
  servers,
  harness,
  selected,
  onOpen,
}: {
  servers: McpServer[]
  harness: McpHarnessSeam | undefined
  selected: string | null
  onOpen: (key: string) => void
}) {
  const t = useTranslations("Harness.mcp")
  const row = (server: McpServer) => (
    <McpServerRow
      key={server.key}
      server={server}
      selected={server.key === selected}
      harness={harness?.marks.get(server.key)}
      onOpen={onOpen}
    />
  )
  const fromHarness = harness
    ? servers.filter((server) => harness.marks.has(server.key))
    : []
  if (fromHarness.length === 0) {
    return (
      <div className="min-w-0">
        <ListTitle label={t("list.serversLabel")} count={servers.length} />
        <ul
          aria-label={t("list.serversLabel")}
          onKeyDown={moveRowFocus}
          className={HARNESS_ROWS_CLASS}
        >
          {servers.map(row)}
        </ul>
      </div>
    )
  }
  const others = servers.filter((server) => !harness?.marks.has(server.key))
  const groups = [
    { id: "harness", label: t("harness.title"), servers: fromHarness },
    { id: "manual", label: t("list.groupManual"), servers: others },
  ].filter((group) => group.servers.length > 0)
  return (
    <ul
      aria-label={t("list.serversLabel")}
      onKeyDown={moveRowFocus}
      className={HARNESS_ROW_GROUPS_CLASS}
    >
      {groups.map((group) => (
        <li key={group.id} className="min-w-0">
          <ListTitle label={group.label} count={group.servers.length} />
          <ul aria-label={group.label} className={HARNESS_ROWS_CLASS}>
            {group.servers.map(row)}
          </ul>
        </li>
      ))}
    </ul>
  )
}

// ─── The section ──────────────────────────────────────────────────────

/**
 * The MCP section: every agent's MCP servers on the workspace's host, read
 * from each agent's own file and never merged, by server or by agent.
 *
 * Wide, the list and the detail sit side by side; narrow — a phone, a
 * narrow window, a wide sidebar — they are two screens, and the back
 * gesture returns to the list. Everything it shows is read from slots
 * (`lib/harness/mcp-state.ts`), so a trip to a conversation and back finds it
 * as it was: the same view, filters, selection and offsets, and an editor
 * still open with what was typed into it. On the way back in, the
 * configuration is read again — once per visit, and once more per
 * `mcp://changed`.
 */
export function McpSection() {
  const t = useTranslations("Harness.mcp")
  const { slots } = useHarnessView()
  const [state] = useHarnessSlot(MCP_INVENTORY)
  const [viewSlot] = useHarnessSlot(MCP_VIEW)
  const [filters, setFilters] = useHarnessSlot(MCP_FILTERS)
  const [showAll] = useHarnessSlot(MCP_SHOW_ALL_AGENTS)
  const [selectedServer] = useHarnessSlot(MCP_SELECTED_SERVER)
  const [selectedAgent] = useHarnessSlot(MCP_SELECTED_AGENT)
  useHarnessInstalledSync()
  useHarnessUpdatesCheckOnOpen()
  const harness = useMcpHarness()
  const isMobile = useIsMobile()
  const [rootRef, width] = useElementWidth<HTMLDivElement>()
  const zoom = useContext(AppearanceContext)?.zoomLevel ?? 100
  const listRef = useRef<HTMLDivElement>(null)

  // `openHarness({ section: "mcp", serverKey })`: drawn on the server asked
  // for from the first frame, then applied to the slots.
  const target = useConsumeHarnessTarget("mcp", (requested) =>
    openMcpServer(slots, requested.serverKey)
  )
  const view = target ? "servers" : viewSlot
  const shownServer = target ? target.serverKey : selectedServer
  const shownFilters = target ? DEFAULT_MCP_FILTERS : filters

  // Unmeasured (the first render, and jsdom) counts as wide, as the page's
  // own switch does.
  const split =
    !isMobile && (width === 0 || width >= (SPLIT_MIN_REM * 16 * zoom) / 100)
  const selected = view === "servers" ? shownServer : selectedAgent
  const detailOpen = selected !== null

  // One read per visit, then one per `mcp://changed` — from this window or
  // any other — and one after the event stream reconnects, since events sent
  // while it was down are lost.
  useEffect(() => {
    void reloadMcpInventory(slots)
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    onMcpChanged(() => {
      void reloadMcpInventory(slots)
    })
      .then((stop) => {
        if (cancelled) stop()
        else unsubscribe = stop
      })
      .catch(() => {
        // No event stream: the page still reads on every visit and on Refresh.
      })
    const stopReconnect = getTransport().onReconnect?.(() => {
      void reloadMcpInventory(slots)
    })
    return () => {
      cancelled = true
      unsubscribe?.()
      stopReconnect?.()
    }
  }, [slots])

  const model = useMemo(
    () => (state.inventory ? modelOf(state.inventory) : null),
    [state.inventory]
  )

  const close = useCallback(() => closeMcpDetail(slots), [slots])
  // The detail is a screen, not a route: on a phone the back gesture should
  // return to the list, not leave the workspace.
  useHistoryBackDismiss(!split && detailOpen, close)

  // The list, back where it was left; after a detail closes, its row has the
  // focus again.
  useLayoutEffect(() => {
    if (!split && detailOpen) return
    const scroller = listRef.current
    if (!scroller) return
    scroller.scrollTop = slots.get(MCP_LIST_SCROLL)[view]
    const returnTo = slots.get(MCP_RETURN_FOCUS)
    if (returnTo === null) return
    slots.set(MCP_RETURN_FOCUS, null)
    const row = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-mcp-row]")
    ).find((element) => element.dataset.mcpRow === returnTo)
    ;(row ?? scroller).focus({ preventScroll: true })
  }, [slots, view, split, detailOpen])

  const openServer = useCallback(
    (key: string) => selectServer(slots, key),
    [slots]
  )
  const openAgent = useCallback((id: string) => selectAgent(slots, id), [slots])

  if (state.error?.kind === "unsupported") {
    return (
      <div className="h-full min-h-0">
        <McpUnsupported />
      </div>
    )
  }

  const retry = () => void reloadMcpInventory(slots)
  const header = (
    <div className={HARNESS_TOOLBAR_CLASS}>
      <McpToolbar harness={harness} />
    </div>
  )

  // ── The list ──
  let list: ReactNode
  let agentEntries: McpEntry[] | null = null
  if (!model) {
    list =
      state.phase === "error" && state.error ? (
        <LoadFailure failure={state.error} variant="pane" onRetry={retry} />
      ) : (
        <RowListSkeleton />
      )
  } else if (view === "servers") {
    const servers = model.servers.filter((server) =>
      serverShown(server, shownFilters, harness)
    )
    list =
      model.servers.length === 0 ? (
        <EmptyState
          icon={<PlugZap aria-hidden="true" className="size-5" />}
          title={t("list.none")}
          hint={t("list.noneHint")}
        >
          <Button
            type="button"
            size="sm"
            onClick={() => openCreateEditor(slots)}
            className="mt-1 max-md:h-10"
          >
            {t("add.manual")}
          </Button>
        </EmptyState>
      ) : servers.length === 0 ? (
        <EmptyState
          icon={<SearchX aria-hidden="true" className="size-5" />}
          title={t("list.noMatch")}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setFilters(DEFAULT_MCP_FILTERS)}
            className="mt-1 max-md:h-10"
          >
            {t("list.clearFilters")}
          </Button>
        </EmptyState>
      ) : (
        <ServerList
          servers={servers}
          harness={harness}
          selected={shownServer}
          onOpen={openServer}
        />
      )
  } else {
    const { rows, folded } = agentRows(model, shownFilters, showAll, harness)
    const filtering = isFiltering(shownFilters)
    if (selectedAgent !== null && filtering) {
      agentEntries =
        rows.find((row) => row.info.id === selectedAgent)?.entries ??
        model.agent(selectedAgent)?.inventory.entries.filter((entry) => {
          const info = model.agent(selectedAgent)
          return info ? entryShown(info, entry, shownFilters, harness) : false
        }) ??
        []
    }
    list =
      rows.length === 0 ? (
        <EmptyState
          icon={<SearchX aria-hidden="true" className="size-5" />}
          title={t("list.noAgentMatch")}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setFilters(DEFAULT_MCP_FILTERS)}
            className="mt-1 max-md:h-10"
          >
            {t("list.clearFilters")}
          </Button>
        </EmptyState>
      ) : (
        <div className="min-w-0">
          <ListTitle label={t("list.agentsLabel")} count={rows.length} />
          <ul
            aria-label={t("list.agentsLabel")}
            onKeyDown={moveRowFocus}
            className={HARNESS_ROWS_CLASS}
          >
            {rows.map(({ info, entries }) => (
              <McpAgentRow
                key={info.id}
                info={info}
                count={entries.length}
                total={info.inventory.entries.length}
                selected={info.id === selectedAgent}
                filtered={filtering}
                onOpen={openAgent}
              />
            ))}
          </ul>
          {!filtering && (
            <ShowAllAgentsToggle hidden={folded} className="px-1" />
          )}
        </div>
      )
  }

  const scroller = (
    <HarnessScroller
      ref={listRef}
      tabIndex={-1}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop
        slots.set(MCP_LIST_SCROLL, (prev) => ({ ...prev, [view]: top }))
      }}
      className="flex-1"
    >
      {/* On a phone the controls scroll away with the list: the page's own
          top — its line of description and the section switch — is already
          above them. */}
      {isMobile && header}
      <div className={cn("min-w-0 space-y-2", HARNESS_LIST_PAD_CLASS)}>
        {model && state.phase === "error" && state.error && (
          <LoadFailure failure={state.error} variant="banner" onRetry={retry} />
        )}
        {harness?.problem && (
          <HarnessRecordProblem part="mcp" problem={harness.problem} />
        )}
        {list}
      </div>
    </HarnessScroller>
  )

  // ── The detail ──
  const detail =
    view === "servers" ? (
      shownServer !== null ? (
        <McpServerDetail
          model={model}
          serverKey={shownServer}
          onBack={split ? undefined : close}
          harness={harness}
        />
      ) : null
    ) : selectedAgent !== null ? (
      <McpAgentDetail
        model={model}
        agentId={selectedAgent}
        entries={agentEntries}
        filtered={isFiltering(shownFilters)}
        onBack={split ? undefined : close}
      />
    ) : null

  return (
    <div ref={rootRef} className="@container/mcp h-full min-h-0 min-w-0">
      {split ? (
        // The controls span both panes: they act on the list and on what
        // the detail beside it shows.
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {header}
          <div className="flex min-h-0 min-w-0 flex-1">
            <div className={HARNESS_LIST_PANE_CLASS}>{scroller}</div>
            <div className="min-h-0 min-w-0 flex-1">
              {detail ?? (
                <EmptyState
                  icon={
                    <MousePointerClick aria-hidden="true" className="size-5" />
                  }
                  title={t(
                    view === "servers"
                      ? "detail.pickServer"
                      : "detail.pickAgent"
                  )}
                />
              )}
            </div>
          </div>
        </div>
      ) : detailOpen ? (
        detail
      ) : (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {!isMobile && header}
          {scroller}
        </div>
      )}
      <McpDialogs model={model} />
      <Announcer />
    </div>
  )
}
