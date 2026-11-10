"use client"

/**
 * The team pages every assistant shares (10.5): the work assistants, the
 * executor configs — moved here from Collaboration as they were, with what
 * each is doing, whether it keeps failing, its last two weeks, and how the
 * assistants may use it — and the division of work.
 */

import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  Bot,
  Briefcase,
  ChevronRight,
  Layers,
  Users,
} from "lucide-react"
import { toast } from "sonner"

import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import { AssistantsPanel } from "@/components/settings/assistants-panel"
import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { openSettingsWindow, personalAgentSettingsPatch } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AssistantInfo,
  DispatchMode,
  DivisionKind,
  ExecutorUsage,
  ExecutorView,
  PersonalAgentAccount,
  PersonalAgentBotSummary,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAssistants } from "@/stores/assistants-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { canOpenWork, useBotName, useOpenWork } from "../shared"
import { PageHead } from "./pref-pages"
import { useBots, useExecutors, useSettingsPatch } from "./use-settings"

const MODES: DispatchMode[] = ["task", "chat", "session"]

export const DIVISION_KINDS: DivisionKind[] = [
  "code",
  "review",
  "test",
  "fix_ci",
  "docs",
  "release",
  "research",
  "check",
]

const DEFAULT_USAGE: ExecutorUsage = {
  dispatch: true,
  modes: MODES,
  projects: null,
}

function sameUsage(a: ExecutorUsage, b: ExecutorUsage): boolean {
  const modes = (u: ExecutorUsage) => MODES.filter((m) => u.modes.includes(m))
  const projects = (u: ExecutorUsage) =>
    u.projects == null ? null : [...u.projects].sort((x, y) => x - y)
  return (
    a.dispatch === b.dispatch &&
    modes(a).join() === modes(b).join() &&
    JSON.stringify(projects(a)) === JSON.stringify(projects(b))
  )
}

/** The projects an executor config can be limited to. */
function useProjects() {
  const folders = useAppWorkspaceStore((s) => s.folders)
  return useMemo(
    () => folders.filter((f) => f.kind === "regular" && f.parent_id == null),
    [folders]
  )
}

// ── work assistants ─────────────────────────────────────────────────────────

export function WorkersPage() {
  const t = useTranslations("PersonalAgent.settings")
  const bots = useBots()
  const assistants = useAssistants()
  const botName = useBotName()
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const workers = (bots ?? []).filter((b) => b.kind === "worker")
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="workers">
      <PageHead title={t("nav.workers")} description={t("pages.workers")} />
      {bots != null && workers.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 px-6 py-8 text-center">
          <Users className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">{t("team.noWorkers")}</p>
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">
            {t("team.noWorkersHint")}
          </p>
        </div>
      ) : (
        <SettingCard>
          {workers.map((w) => {
            const bound = assistants.find(
              (a) => a.id === w.executor_assistant_id
            )
            return (
              <button
                key={w.id}
                type="button"
                data-pa-worker={w.id}
                onClick={() => openSettings("identity", w.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors hover:bg-muted/60"
              >
                <AssistantAvatar
                  avatar={w.avatar}
                  name={botName(w)}
                  size={32}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {botName(w)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[
                      w.template,
                      bound
                        ? t("team.boundTo", { name: bound.name })
                        : t("team.unbound"),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground rtl:rotate-180"
                  aria-hidden
                />
              </button>
            )
          })}
        </SettingCard>
      )}
    </div>
  )
}

// ── executor configs ────────────────────────────────────────────────────────

/** How the assistants use an executor config, in the editor. */
export interface UsageEditorHandle {
  save: (assistant: AssistantInfo) => void
}

const UsageEditor = forwardRef<
  UsageEditorHandle,
  {
    initial: ExecutorUsage
    /** Changing it needs the engine here and the primary set up. */
    readOnly: boolean
    readOnlyWhy: string | null
  }
>(function UsageEditor({ initial, readOnly, readOnlyWhy }, ref) {
  const t = useTranslations("PersonalAgent.settings.usage")
  const tMode = useTranslations("PersonalAgent.mode")
  const projects = useProjects()
  const [usage, setUsage] = useState<ExecutorUsage>(initial)
  useImperativeHandle(
    ref,
    () => ({
      save: (assistant) => {
        if (readOnly || sameUsage(usage, initial)) return
        personalAgentSettingsPatch([
          {
            key: `team.usage.${assistant.uid}`,
            value: sameUsage(usage, DEFAULT_USAGE) ? null : usage,
          },
        ]).catch((e) =>
          toast.error(t("saveFailed"), { description: toErrorMessage(e) })
        )
      },
    }),
    [usage, initial, readOnly, t]
  )
  const toggleMode = (m: DispatchMode, on: boolean) =>
    setUsage((u) => {
      const modes = on ? [...u.modes, m] : u.modes.filter((x) => x !== m)
      return modes.length === 0 ? u : { ...u, modes }
    })
  const toggleProject = (id: number, on: boolean) =>
    setUsage((u) => {
      const now = u.projects ?? []
      const next = on ? [...now, id] : now.filter((x) => x !== id)
      return next.length === 0 ? u : { ...u, projects: next }
    })
  const off = readOnly || !usage.dispatch
  return (
    <SettingCard data-pa-usage>
      <SettingRow
        icon={Bot}
        title={t("dispatch")}
        description={readOnlyWhy ?? t("dispatchHint")}
        control={
          <Switch
            checked={usage.dispatch}
            disabled={readOnly}
            onCheckedChange={(dispatch) =>
              setUsage((u) => ({ ...u, dispatch }))
            }
            aria-label={t("dispatch")}
          />
        }
      />
      <SettingRow icon={Layers} title={t("modes")} description={t("modesHint")}>
        <div className="flex flex-wrap gap-3">
          {MODES.map((m) => (
            <label key={m} className="flex items-center gap-1.5 text-xs">
              <Checkbox
                checked={usage.modes.includes(m)}
                disabled={off}
                onCheckedChange={(on) => toggleMode(m, on === true)}
              />
              {tMode(m)}
            </label>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        icon={Briefcase}
        title={t("projects")}
        description={t("projectsHint")}
      >
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-1.5 text-xs">
            <Switch
              checked={usage.projects == null}
              disabled={off || projects.length === 0}
              onCheckedChange={(all) =>
                setUsage((u) => ({
                  ...u,
                  projects: all ? null : projects.slice(0, 1).map((p) => p.id),
                }))
              }
            />
            {t("allProjects")}
          </label>
          {usage.projects != null ? (
            <div className="flex flex-wrap gap-3">
              {projects.map((p) => (
                <label key={p.id} className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={usage.projects?.includes(p.id) ?? false}
                    disabled={off}
                    onCheckedChange={(on) => toggleProject(p.id, on === true)}
                  />
                  {p.alias ?? p.name}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </SettingRow>
    </SettingCard>
  )
})

/** What a row says besides the agent: in flight, failing, two weeks, who
 *  it is bound to and first for, and how the assistants use it. */
function ExecutorLine({
  assistant,
  view,
}: {
  assistant: AssistantInfo
  view: ExecutorView | undefined
}) {
  const t = useTranslations("PersonalAgent.settings.executor")
  const tu = useTranslations("PersonalAgent.settings.usage")
  const tMode = useTranslations("PersonalAgent.mode")
  const tKind = useTranslations("PersonalAgent.settings.division")
  const openWork = useOpenWork()
  const botName = useBotName()
  if (!view) return null
  // "Only kanban tasks · only on 2 projects"; nothing for the default.
  const usage = view.usage
  const summary = !usage.dispatch
    ? tu("notForDispatch")
    : [
        usage.modes.length < MODES.length
          ? tu("onlyModes", {
              modes: usage.modes.map((m) => tMode(m)).join(" / "),
            })
          : null,
        usage.projects != null
          ? tu("onlyProjects", { count: usage.projects.length })
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || null
  const chips: ReactNode[] = []
  if (view.running.length > 0) {
    chips.push(
      <Popover key="running">
        <PopoverTrigger asChild>
          <button
            type="button"
            data-pa-running={view.running.length}
            className="rounded-full bg-primary/10 px-1.5 py-0.5 text-primary hover:bg-primary/15"
          >
            {t("running", { count: view.running.length })}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1.5">
          {view.running.map((w) => {
            const target = {
              dispatchId: w.dispatch_id,
              mode: w.mode,
              workTaskId: w.work_task_id,
              conversationId: w.conversation_id,
              folderId: null,
              agentType: assistant.agent_type,
              title: w.title,
              executorId: assistant.id,
              executorName: assistant.name,
              prompt: null,
              connectionId: null,
              state: w.state,
            }
            const openable = canOpenWork(target)
            return (
              <button
                key={w.dispatch_id}
                type="button"
                disabled={!openable}
                onClick={() => openWork(target)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs hover:bg-muted disabled:opacity-60"
              >
                <span className="min-w-0 flex-1 truncate">{w.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {tMode(w.mode)}
                </span>
              </button>
            )
          })}
        </PopoverContent>
      </Popover>
    )
  }
  if (view.dispatches_14d > 0) {
    chips.push(
      <span key="fortnight">
        {t("fortnight", {
          dispatches: view.dispatches_14d,
          completed: view.completed_14d,
        })}
      </span>
    )
  }
  for (const w of view.workers) {
    chips.push(
      <span key={`w${w.id}`}>{t("boundBy", { name: botName(w) })}</span>
    )
  }
  if (view.division.length > 0) {
    chips.push(
      <span key="division">
        {t("firstFor", {
          kinds: view.division.map((k) => tKind(k)).join(" / "),
        })}
      </span>
    )
  }
  if (summary) chips.push(<span key="usage">{summary}</span>)
  return (
    <div className="mt-0.5 space-y-0.5">
      {view.failing ? (
        <p
          data-pa-failing
          className="flex min-w-0 items-center gap-1 text-[0.6875rem] leading-4 text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          <span className="truncate">
            {t("failing", {
              count: view.failing.count,
              error: view.failing.error ?? "—",
            })}
          </span>
        </p>
      ) : null}
      {chips.length > 0 ? (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] leading-4 text-muted-foreground">
          {chips}
        </p>
      ) : null}
    </div>
  )
}

/** What deleting or turning off an executor config takes with it. */
function useImpact(views: ReadonlyMap<number, ExecutorView>) {
  const t = useTranslations("PersonalAgent.settings.executor")
  const tKind = useTranslations("PersonalAgent.settings.division")
  const botName = useBotName()
  return function impactOf(
    assistant: AssistantInfo,
    deleting: boolean
  ): ReactNode | null {
    const v = views.get(assistant.id)
    if (!v) return null
    const lines: string[] = []
    for (const w of v.workers) {
      lines.push(
        t(deleting ? "impactWorkerDelete" : "impactWorkerOff", {
          name: botName(w),
        })
      )
    }
    if (v.division.length > 0) {
      lines.push(
        t(deleting ? "impactDivisionDelete" : "impactDivisionOff", {
          kinds: v.division.map((k) => tKind(k)).join(" / "),
        })
      )
    }
    if (v.running.length > 0) {
      lines.push(t("impactRunning", { count: v.running.length }))
    }
    if (lines.length === 0) return null
    return (
      <ul className="list-disc space-y-0.5 ps-4 text-start" data-pa-impact>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    )
  }
}

export function ExecutorsPage({
  account,
  usageReadOnly,
  usageReadOnlyWhy,
  delegationEnabled,
}: {
  account: PersonalAgentAccount | null
  usageReadOnly: boolean
  usageReadOnlyWhy: string | null
  delegationEnabled: boolean | null
}) {
  const t = useTranslations("PersonalAgent.settings")
  const views = useExecutors()
  const impact = useImpact(views)
  const [editorRef, setEditorRef] = useState<UsageEditorHandle | null>(null)
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="executors">
      <PageHead title={t("nav.executors")} description={t("pages.executors")} />
      <SettingNote icon={Layers}>{t("team.sameBatch")}</SettingNote>
      <AssistantsPanel
        delegationEnabled={delegationEnabled}
        delegationOffText={t("team.delegationOff")}
        delegationOffAction={t("team.openCollaboration")}
        onShowGeneral={() =>
          void openSettingsWindow("collaboration").catch(() => {})
        }
        rowExtra={(a) => <ExecutorLine assistant={a} view={views.get(a.id)} />}
        deleteImpact={(a) => impact(a, true)}
        disableImpact={(a) => impact(a, false)}
        editorSection={(a) => (
          <div className="space-y-2">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              {t("usage.title")}
            </p>
            <UsageEditor
              ref={setEditorRef}
              initial={
                (a && account?.team.usage[a.uid]) ||
                (a ? (views.get(a.id)?.usage ?? DEFAULT_USAGE) : DEFAULT_USAGE)
              }
              readOnly={usageReadOnly}
              readOnlyWhy={usageReadOnlyWhy}
            />
          </div>
        )}
        onEditorSaved={(a) => editorRef?.save(a)}
      />
    </div>
  )
}

// ── division of work ────────────────────────────────────────────────────────

export function DivisionPage({
  account,
  disabled,
}: {
  account: PersonalAgentAccount
  disabled: boolean
}) {
  const t = useTranslations("PersonalAgent.settings")
  const tKind = useTranslations("PersonalAgent.settings.division")
  const { patch } = useSettingsPatch(null)
  const bots = useBots()
  const assistants = useAssistants()
  const botName = useBotName()
  const workers = (bots ?? []).filter(
    (b): b is PersonalAgentBotSummary & { uid: string } =>
      b.kind === "worker" && b.uid != null
  )
  const usageOf = (a: AssistantInfo) =>
    account.team.usage[a.uid] ?? DEFAULT_USAGE
  const restore = DIVISION_KINDS.filter((k) => account.team.division[k] != null)
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="division">
      <PageHead
        title={t("nav.division")}
        description={t("pages.division")}
        onRestore={() =>
          void patch(
            restore.map((k) => ({ key: `team.division.${k}`, value: null }))
          )
        }
        restoreDisabled={disabled || restore.length === 0}
      />
      <SettingCard>
        {DIVISION_KINDS.map((kind) => {
          // "Checking" goes to one that takes work sessions (7.5).
          const takesIt = (a: AssistantInfo) =>
            kind !== "check" || usageOf(a).modes.includes("session")
          const pickable = assistants.filter(
            (a) => a.enabled && usageOf(a).dispatch && takesIt(a)
          )
          const pickableWorkers = workers.filter((w) => {
            if (kind !== "check") return true
            const bound = assistants.find(
              (a) => a.id === w.executor_assistant_id
            )
            return bound != null && takesIt(bound)
          })
          const value = account.team.division[kind] ?? "auto"
          const known =
            value === "auto" ||
            pickable.some((a) => `assistant:${a.uid}` === value) ||
            pickableWorkers.some((w) => `bot:${w.uid}` === value)
          return (
            <SettingRow
              key={kind}
              title={tKind(kind)}
              description={tKind(`${kind}Hint` as "codeHint")}
              control={
                <Select
                  value={known ? value : "auto"}
                  disabled={disabled}
                  onValueChange={(v) =>
                    void patch([
                      {
                        key: `team.division.${kind}`,
                        value: v === "auto" ? null : v,
                      },
                    ])
                  }
                >
                  <SelectTrigger
                    data-pa-division={kind}
                    className={cn("h-8 w-48 bg-background text-xs")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-xs">
                      {t("team.auto")}
                    </SelectItem>
                    {pickableWorkers.length > 0 ? (
                      <SelectGroup>
                        <SelectLabel className="text-2xs">
                          {t("nav.workers")}
                        </SelectLabel>
                        {pickableWorkers.map((w) => (
                          <SelectItem
                            key={w.id}
                            value={`bot:${w.uid}`}
                            className="text-xs"
                          >
                            {botName(w)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null}
                    {pickable.length > 0 ? (
                      <SelectGroup>
                        <SelectLabel className="text-2xs">
                          {t("nav.executors")}
                        </SelectLabel>
                        {pickable.map((a) => (
                          <SelectItem
                            key={a.id}
                            value={`assistant:${a.uid}`}
                            className="text-xs"
                          >
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null}
                  </SelectContent>
                </Select>
              }
            />
          )
        })}
      </SettingCard>
      <SettingNote icon={Users}>{t("team.divisionNote")}</SettingNote>
    </div>
  )
}
