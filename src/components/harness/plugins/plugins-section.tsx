"use client"

import { useEffect, useMemo, useRef, type ReactNode } from "react"
import {
  ArrowUpCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Power,
  PowerOff,
  Puzzle,
  Repeat,
  RotateCw,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  useConsumeHarnessTarget,
  useHarnessSlot,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { defineHarnessSlot } from "@/lib/harness-slots"
import { harnessFailureOf } from "@/lib/harness/errors"
import {
  HARNESS_INSTALLED,
  reloadHarnessInstalled,
} from "@/lib/harness/mcp-install-state"
import { harnessPluginHookTrust } from "@/lib/harness/plugin-install-api"
import type {
  HarnessListedPlugin,
  HarnessListedPluginHost,
} from "@/lib/harness/plugin-install-types"
import {
  hookTrustKey,
  hostActionsOf,
  hostModeOf,
  hostStateKey,
  otherModesOf,
  pluginRowsOf,
  type PluginRow,
} from "@/lib/harness/plugin-list"
import {
  openPluginChange,
  openPluginUninstall,
  openPluginUpdate,
  PLUGIN_HOOK_TRUST,
  type PluginDialogSubject,
  type PluginHookTrustState,
} from "@/lib/harness/plugin-manage-state"
import { useHarnessInstalledSync } from "@/lib/harness/use-harness-installed"
import { useHarnessUpdatesCheckOnOpen } from "@/lib/harness/use-harness-updates"
import { HARNESS_UPDATES } from "@/lib/harness/updates"
import { cn } from "@/lib/utils"
import { useHarnessFailureMessage } from "../discover/discover-failure"
import { DiscoverMark } from "../discover/discover-card"
import {
  HARNESS_LIST_PAD_CLASS,
  HARNESS_ROWS_CLASS,
  HARNESS_ROW_TILE_CLASS,
} from "../harness-styles"
import { HarnessScroller } from "../harness-scroller"
import { HarnessUpdateStatus } from "../harness-update-status"
import {
  HarnessRecordProblem,
  InstallReasonList,
} from "../install/install-parts"
import { PluginMemberList } from "../install/plugin-parts"
import { usePluginInstallLabels } from "../install/use-plugin-install-labels"
import { MachineText } from "../machine-text"
import { AgentGlyph } from "../mcp/mcp-bits"
import { EmptyState, FailureNote } from "../skills/skill-bits"
import { DetailSkeleton } from "../skills/skill-detail"

/** The rows whose members are on show, by item id. */
const PLUGINS_EXPANDED = defineHarnessSlot<Readonly<Record<string, boolean>>>(
  "plugins",
  () => ({})
)

/** The row asked for from outside (`openHarness`), marked as the open one. */
const PLUGINS_CURRENT = defineHarnessSlot<string | null>("plugins", () => null)

/** A key of `PLUGIN_HOOK_TRUST`: an answer about another revision is not
 *  this one's. Answers are kept for the section's visit, and none from
 *  before a plugin write. */
const trustKey = (itemId: string, revision: number, agent: string) =>
  `${itemId}\u0000${revision}\u0000${agent}`

const REMOTE_MARKS = [
  "yanked",
  "unapproved",
  "disabledByAuthor",
  "removedByHarness",
  "gone",
] as const

function subjectOf(plugin: HarnessListedPlugin): PluginDialogSubject {
  return { itemId: plugin.item_id, itemRef: plugin.ref, name: plugin.name }
}

/** Whether Codex's trust of an agent's hooks is there to ask: Codex has the
 *  plugin whole, on, with hooks. */
function trustOffered(host: HarnessListedPluginHost): boolean {
  return (
    hostModeOf(host) === "native" &&
    host.host_id === "codex" &&
    host.codex_hooks &&
    hostStateKey(host.state) === "active"
  )
}

/** The trust answers still to be kept: those of the agents trust is offered
 *  for now, at the revisions installed. One whose agent was switched off or
 *  to another mode is dropped — its trust in Codex may be gone with it — and
 *  so is a read still on its way for it. */
function trustKept(
  trust: Readonly<Record<string, PluginHookTrustState>>,
  plugins: readonly HarnessListedPlugin[]
): Readonly<Record<string, PluginHookTrustState>> {
  const live = new Set(
    plugins.flatMap((plugin) =>
      plugin.hosts
        .filter(trustOffered)
        .map((host) => trustKey(plugin.item_id, plugin.revision, host.agent))
    )
  )
  const kept = Object.entries(trust).filter(([key]) => live.has(key))
  return kept.length === Object.keys(trust).length
    ? trust
    : Object.fromEntries(kept)
}

let trustReads = 0

/** Codex's trust of one agent's hooks: asked only when the user asks, then
 *  said in a word — the answer, or why there is none. */
function useHookTrust(
  plugin: HarnessListedPlugin,
  host: HarnessListedPluginHost
) {
  const [trust, setTrust] = useHarnessSlot(PLUGIN_HOOK_TRUST)
  const key = trustKey(plugin.item_id, plugin.revision, host.agent)
  const state = trust[key]
  const ask = () => {
    const read = ++trustReads
    setTrust((prev) => ({ ...prev, [key]: { phase: "loading", read } }))
    // Only the read still waited for lands: not one whose entry was dropped
    // (or asked again) meanwhile.
    const land = (next: PluginHookTrustState) =>
      setTrust((prev) => {
        const now = prev[key]
        return now?.phase === "loading" && now.read === read
          ? { ...prev, [key]: next }
          : prev
      })
    harnessPluginHookTrust(plugin.item_id, host.agent).then(
      (value) => land({ phase: "ready", value }),
      (error) => land({ phase: "error", failure: harnessFailureOf(error) })
    )
  }
  // Codex could not be asked: said as the error it is, not as a word.
  const problem = state?.phase === "ready" ? state.value.problem : null
  const word =
    state?.phase === "ready" && !problem ? hookTrustKey(state.value) : null
  return { state, word, problem, ask }
}

/** One agent of a plugin: its mode and state (and, asked for, Codex's trust
 *  of its hooks), what its host has of it, and what may be done for it
 *  alone — off and on, another mode. */
function HostLine({
  plugin,
  host,
}: {
  plugin: HarnessListedPlugin
  host: HarnessListedPluginHost
}) {
  const t = useTranslations("Harness.plugins")
  const labels = usePluginInstallLabels()
  const { slots } = useHarnessView()
  const failureMessage = useHarnessFailureMessage()
  const state = hostStateKey(host.state)
  const actions = hostActionsOf(host)
  const subject = subjectOf(plugin)
  const showTrust = trustOffered(host)
  const trust = useHookTrust(plugin, host)
  const trustRead = trust.state !== undefined && trust.state.phase !== "loading"
  return (
    <li className="min-w-0 space-y-1 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <AgentGlyph agent={host.agent} />
        <span className="text-sm font-medium whitespace-nowrap">
          {labels.agent(host.agent)}
        </span>
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {labels.mode(host.mode)}
        </span>
        {state !== "active" && (
          <DiscoverMark
            size="sm"
            tone={state === "disabled" ? "neutral" : "warning"}
          >
            {t(`states.${state}`)}
          </DiscoverMark>
        )}
        {showTrust && trust.word && (
          <DiscoverMark
            size="sm"
            tone={
              trust.word === "trusted" || trust.word === "none"
                ? "neutral"
                : "warning"
            }
          >
            {t(`hooks.${trust.word}`)}
          </DiscoverMark>
        )}
        <span className="ms-auto flex max-w-full flex-wrap items-center justify-end gap-1">
          {showTrust && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={trust.state?.phase === "loading"}
              aria-busy={trust.state?.phase === "loading" || undefined}
              onClick={trust.ask}
              className="max-md:h-9"
            >
              {trust.state?.phase === "loading" ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : trustRead ? (
                <RotateCw aria-hidden="true" />
              ) : (
                <ShieldCheck aria-hidden="true" />
              )}
              {trustRead ? t("hooks.again") : t("actions.hookTrust")}
            </Button>
          )}
          {actions.disable && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                openPluginChange(slots, subject, {
                  kind: "enabled",
                  agent: host.agent,
                  enabled: false,
                })
              }
              className="max-md:h-9"
            >
              <PowerOff aria-hidden="true" />
              {t("actions.disable")}
            </Button>
          )}
          {actions.enable && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                openPluginChange(slots, subject, {
                  kind: "enabled",
                  agent: host.agent,
                  enabled: true,
                })
              }
              className="max-md:h-9"
            >
              <Power aria-hidden="true" />
              {t("actions.enable")}
            </Button>
          )}
          {actions.changeMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="max-md:h-9"
                >
                  <Repeat aria-hidden="true" />
                  {t("actions.changeMode")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {otherModesOf(host).map((mode) => (
                  <DropdownMenuItem
                    key={mode}
                    onSelect={() =>
                      openPluginChange(slots, subject, {
                        kind: "mode",
                        agent: host.agent,
                        mode,
                      })
                    }
                  >
                    {labels.mode(mode)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>
      {host.verify && host.verify.problems.length > 0 && (
        <InstallReasonList
          reasons={host.verify.problems}
          tone="warning"
          wording={labels.reason}
        />
      )}
      {showTrust && trust.state?.phase === "error" && (
        <p role="alert" className="text-xs text-tone-warning">
          {failureMessage(trust.state.failure)}
        </p>
      )}
      {showTrust && trust.problem && (
        <p role="alert" className="text-xs text-tone-warning">
          {labels.reason(trust.problem)}
        </p>
      )}
      {/* The answer read, said to a screen reader as it comes. */}
      {showTrust && (
        <span role="status" className="sr-only">
          {trust.word ? t(`hooks.${trust.word}`) : ""}
        </span>
      )}
    </li>
  )
}

/** One installed plugin: its version and what the update check says of it,
 *  each agent's line, its members on request, and the actions on the whole
 *  of it. */
function PluginCard({ row }: { row: PluginRow }) {
  const t = useTranslations("Harness.plugins")
  const tStates = useTranslations("Harness.skills.harnessStates")
  const tMembers = useTranslations("Harness.pluginInstall.members")
  const labels = usePluginInstallLabels()
  const { slots, discoverEnabled } = useHarnessView()
  const [expanded, setExpanded] = useHarnessSlot(PLUGINS_EXPANDED)
  const [current] = useHarnessSlot(PLUGINS_CURRENT)
  const { plugin, remote } = row
  const open = expanded[plugin.item_id] === true
  const subject = subjectOf(plugin)
  const remoteMark = REMOTE_MARKS.find((mark) => mark === remote.remote)
  const membersId = `plugin-members-${plugin.item_id}`
  return (
    <li
      data-plugin-row={plugin.item_id}
      aria-current={current === plugin.item_id ? "true" : undefined}
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-card",
        "aria-[current=true]:border-primary/70"
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start gap-3 px-3 py-2.5">
        <span className={HARNESS_ROW_TILE_CLASS}>
          <Puzzle aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <bdi
              dir="ltr"
              className="min-w-0 truncate font-mono text-sm font-medium"
            >
              <MachineText>{plugin.name}</MachineText>
            </bdi>
            <DiscoverMark size="sm" tone="info">
              {plugin.version
                ? t("version", { version: plugin.version })
                : t("revision", { revision: String(plugin.revision) })}
            </DiscoverMark>
            {remoteMark && (
              <DiscoverMark size="sm" tone="warning">
                {tStates(remoteMark)}
              </DiscoverMark>
            )}
            {remote.updateAvailable && (
              <DiscoverMark size="sm" tone="info">
                <ArrowUpCircle aria-hidden="true" />
                {tStates("updateAvailable")}
              </DiscoverMark>
            )}
          </div>
          <bdi
            dir="ltr"
            className="block truncate font-mono text-xs text-muted-foreground"
          >
            {plugin.ref}
          </bdi>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {remote.updateAvailable && discoverEnabled && (
            <Button
              type="button"
              size="sm"
              onClick={() => openPluginUpdate(slots, subject)}
              className="max-md:h-10"
            >
              <ArrowUpCircle aria-hidden="true" />
              {t("actions.update")}
            </Button>
          )}
          {row.needsRepair && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                openPluginChange(slots, subject, {
                  kind: "repair",
                  agent: null,
                })
              }
              className="max-md:h-10"
            >
              <Wrench aria-hidden="true" />
              {t("actions.repair")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => openPluginUninstall(slots, subject)}
            className="max-md:h-10"
          >
            <Trash2 aria-hidden="true" />
            {t("actions.uninstall")}
          </Button>
        </div>
      </div>
      {plugin.problems.length > 0 && (
        <div className="px-3 pb-2">
          <InstallReasonList
            reasons={plugin.problems}
            tone="warning"
            wording={labels.reason}
          />
        </div>
      )}
      {plugin.hosts.length > 0 && (
        <ul className="min-w-0 divide-y border-t border-border/60">
          {plugin.hosts.map((host) => (
            <HostLine key={host.agent} plugin={plugin} host={host} />
          ))}
        </ul>
      )}
      <div className="border-t border-border/60 px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={open}
          aria-controls={membersId}
          onClick={() =>
            setExpanded((prev) => ({ ...prev, [plugin.item_id]: !open }))
          }
          className="-ms-1.5 text-muted-foreground"
        >
          {open ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
          {tMembers("title")}
          <span className="tabular-nums">{plugin.members.length}</span>
        </Button>
        {open && (
          <div id={membersId} className="pt-1 pb-1.5">
            <PluginMemberList members={plugin.members} />
          </div>
        )}
      </div>
    </li>
  )
}

/**
 * The Plugins section: the plugins installed from SRN Harness, one row
 * each — the version, each agent's mode and state, the members on request —
 * and only actions on the whole of a plugin: update, repair, uninstall, and
 * for one agent off and on or another mode. Each opens a dialog that asks
 * what it would do first (docs/harness-plugins.md §7, 已装列表).
 */
export function PluginsSection() {
  const t = useTranslations("Harness.plugins")
  const failureMessage = useHarnessFailureMessage()
  const { slots, discoverEnabled, setSection } = useHarnessView()
  const [installed] = useHarnessSlot(HARNESS_INSTALLED)
  const [updates] = useHarnessSlot(HARNESS_UPDATES)
  const [, setExpanded] = useHarnessSlot(PLUGINS_EXPANDED)
  const [current, setCurrent] = useHarnessSlot(PLUGINS_CURRENT)
  const [, setTrust] = useHarnessSlot(PLUGIN_HOOK_TRUST)
  const listRef = useRef<HTMLDivElement>(null)
  useHarnessInstalledSync()
  useHarnessUpdatesCheckOnOpen()

  useConsumeHarnessTarget("plugins", (target) => {
    setCurrent(target.itemId)
    setExpanded((prev) => ({ ...prev, [target.itemId]: true }))
  })

  const value = installed.value
  const rows = useMemo(
    () => pluginRowsOf(value?.plugins ?? [], updates.value),
    [value, updates.value]
  )

  // Each listing drops the trust answers it no longer has a line for. And
  // none outlives the visit: what changed while the section was away (an
  // uninstall and a reinstall from Discover) would not be seen here.
  useEffect(() => {
    if (value) setTrust((prev) => trustKept(prev, value.plugins ?? []))
  }, [value, setTrust])
  useEffect(() => () => setTrust({}), [setTrust])

  // The row asked for, in view once it is there.
  useEffect(() => {
    if (!current) return
    const row = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-plugin-row]") ?? []
    ).find((element) => element.dataset.pluginRow === current)
    row?.scrollIntoView?.({ block: "nearest" })
  }, [current, rows])

  let list: ReactNode
  if (!value) {
    list =
      installed.phase === "error" && installed.failure ? (
        <FailureNote>
          <p>{failureMessage(installed.failure)}</p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void reloadHarnessInstalled(slots)}
            className="mt-1 max-md:h-9"
          >
            <RotateCw aria-hidden="true" />
            {t("retry")}
          </Button>
        </FailureNote>
      ) : (
        <DetailSkeleton />
      )
  } else if (rows.length === 0) {
    list = (
      <EmptyState
        icon={<Puzzle aria-hidden="true" className="size-5" />}
        title={t("none")}
      >
        {discoverEnabled && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSection("discover")}
            className="mt-1 max-md:h-10"
          >
            {t("browse")}
          </Button>
        )}
      </EmptyState>
    )
  } else {
    list = (
      <ul aria-label={t("listLabel")} className={HARNESS_ROWS_CLASS}>
        {rows.map((row) => (
          <PluginCard key={row.plugin.item_id} row={row} />
        ))}
      </ul>
    )
  }

  return (
    <div className="@container/plugins flex h-full min-h-0 min-w-0 flex-col">
      <HarnessScroller ref={listRef} tabIndex={-1} className="flex-1">
        <div className={cn("min-w-0 space-y-3", HARNESS_LIST_PAD_CLASS)}>
          {value?.plugins_problem && (
            <HarnessRecordProblem
              part="plugins"
              problem={value.plugins_problem}
            />
          )}
          {value && installed.phase === "error" && installed.failure && (
            <FailureNote>{failureMessage(installed.failure)}</FailureNote>
          )}
          {rows.length > 0 && <HarnessUpdateStatus inline />}
          {list}
        </div>
      </HarnessScroller>
    </div>
  )
}
