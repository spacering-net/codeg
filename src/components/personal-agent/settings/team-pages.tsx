"use client"

/**
 * The team pages every assistant shares (10.5): the work assistants, and
 * the executor configs their work runs on — moved here from Collaboration
 * as they were, with what each is doing, whether it keeps failing, its last
 * two weeks, and the assistants whose work runs on it. Each row's grade
 * opens apart (7.9): an assistant's by executor config and mode, an
 * executor config's by assistant and mode.
 */

import { useEffect, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  AlertTriangle,
  ChartColumn,
  Layers,
  Loader2,
  MoreHorizontal,
  Plus,
  Users,
} from "lucide-react"
import { toast } from "sonner"

import { AssistantsPanel } from "@/components/settings/assistants-panel"
import { SettingCard, SettingNote } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  openSettingsWindow,
  personalAgentBotCopy,
  personalAgentGrades,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AssistantInfo,
  ExecutorView,
  PersonalAgentBotSummary,
  PersonalAgentGrade,
  PersonalAgentGradeCell,
  PersonalAgentGrades,
} from "@/lib/types"
import { useAssistants } from "@/stores/assistants-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "../bot-avatar"
import { BotDeleteDialog } from "../bot-delete-dialog"
import { NewBotDialog } from "../new-bot-dialog"
import { canOpenWork, usePersonaText, useBotName, useOpenWork } from "../shared"
import { PageHead } from "./pref-pages"
import { useBots, useExecutors } from "./use-settings"

// ── grades ──────────────────────────────────────────────────────────────────

/** A grade in a few words (2.11): "first pass 80% (8/10) · 12 min on
 *  average"; `null` with nothing settled. */
export function useGradeText(): (
  g: PersonalAgentGrade | undefined
) => string | null {
  const t = useTranslations("PersonalAgent.settings.grade")
  return (g) => {
    if (!g || g.first_pass_rate == null) return null
    const parts = [
      t("firstPass", {
        rate: g.first_pass_rate,
        pass: g.first_pass,
        settled: g.settled,
      }),
    ]
    if (g.avg_minutes != null) {
      const time =
        g.avg_minutes >= 60
          ? t("hours", {
              h: Math.floor(g.avg_minutes / 60),
              m: g.avg_minutes % 60,
            })
          : t("minutes", { n: g.avg_minutes })
      parts.push(t("average", { time }))
    }
    return parts.join(" · ")
  }
}

/** A grade apart (7.9): the work by executor config and mode (`by:
 *  "executor"`, an assistant's) or by assistant and mode (`by: "bot"`, an
 *  executor config's), the most work first. */
function GradeCells({
  cells,
  by,
}: {
  cells: readonly PersonalAgentGradeCell[]
  by: "executor" | "bot"
}) {
  const t = useTranslations("PersonalAgent.settings.grade")
  const tMode = useTranslations("PersonalAgent.mode")
  const gradeText = useGradeText()
  const bots = useBots()
  const botName = useBotName()
  const nameOf = (c: PersonalAgentGradeCell) => {
    if (by === "executor") return c.executor_name
    const b = (bots ?? []).find((x) => x.id === c.bot_id)
    return b ? botName(b) : t("someone")
  }
  return (
    <div data-pa-grade-cells={by}>
      <p className="px-2 pt-1 pb-1 text-[0.6875rem] font-medium text-muted-foreground">
        {by === "executor" ? t("byExecutor") : t("byBot")}
      </p>
      {cells.map((c) => (
        <div
          key={`${c.bot_id ?? "-"}:${c.executor}:${c.mode}`}
          data-pa-grade-cell={`${c.bot_id ?? ""}:${c.executor}:${c.mode}`}
          className="flex items-baseline gap-2 rounded-md px-2 py-1 text-xs"
        >
          <span className="min-w-0 flex-1 truncate">
            {nameOf(c)}
            <span className="text-muted-foreground"> · {tMode(c.mode)}</span>
          </span>
          <span className="shrink-0 text-muted-foreground">
            {gradeText(c.grade) ?? t("unjudged", { count: c.grade.dispatches })}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── work assistants ─────────────────────────────────────────────────────────

export function WorkersPage({
  readOnly,
  readOnlyWhy,
}: {
  /** Making, copying and deleting need the engine here and the primary
   *  set up. */
  readOnly: boolean
  readOnlyWhy: string | null
}) {
  const t = useTranslations("PersonalAgent.settings")
  const tb = useTranslations("PersonalAgent.bots")
  const locale = useLocale()
  const bots = useBots()
  const assistants = useAssistants()
  const botName = useBotName()
  const personaText = usePersonaText()
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  const showConversation = usePersonalAgentUi((s) => s.showConversation)
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [copying, setCopying] = useState<number | null>(null)
  const [grades, setGrades] = useState<PersonalAgentGrades | null>(null)
  const gradeText = useGradeText()
  useEffect(() => {
    let alive = true
    personalAgentGrades()
      .then((g) => {
        if (alive) setGrades(g)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const workers = (bots ?? []).filter((b) => b.kind === "worker")
  const goTo = (id: number) => {
    setViewBot(id)
    showConversation()
  }
  const copy = async (w: PersonalAgentBotSummary) => {
    setCopying(w.id)
    try {
      const made = await personalAgentBotCopy(
        w.id,
        tb("copyName", { name: botName(w) }),
        locale
      )
      if (made.bot) toast.message(tb("copied", { name: made.bot.name }))
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setCopying(null)
    }
  }
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="workers">
      <PageHead
        title={t("nav.workers")}
        action={
          <Button
            size="sm"
            disabled={readOnly}
            onClick={() => setAdding(true)}
            data-pa-new-worker
          >
            <Plus aria-hidden />
            {tb("new")}
          </Button>
        }
      />
      {readOnly && readOnlyWhy ? (
        <p className="text-xs text-muted-foreground">{readOnlyWhy}</p>
      ) : null}
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
            const persona = personaText(w)
            return (
              <div
                key={w.id}
                data-pa-worker={w.id}
                className="flex w-full items-center gap-3 px-3 py-2.5"
              >
                <button
                  type="button"
                  onClick={() => openBotPage("identity", { bot: w.id })}
                  className="flex min-w-0 flex-1 items-center gap-3 text-start"
                >
                  <BotAvatar avatar={w.avatar} name={botName(w)} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {botName(w)}
                    </span>
                    {persona ? (
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        data-pa-worker-persona={w.id}
                      >
                        {persona}
                      </span>
                    ) : null}
                    {bound ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {t("team.boundTo", { name: bound.name })}
                      </span>
                    ) : (
                      <span
                        className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
                        data-pa-worker-unbound={w.id}
                      >
                        <AlertTriangle
                          className="size-3 shrink-0"
                          aria-hidden
                        />
                        <span className="truncate">{t("team.unbound")}</span>
                      </span>
                    )}
                    {gradeText(grades?.bots[String(w.id)]) ? (
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        data-pa-worker-grade={w.id}
                      >
                        {gradeText(grades?.bots[String(w.id)])}
                      </span>
                    ) : null}
                  </span>
                </button>
                {(grades?.cells ?? []).some((c) => c.bot_id === w.id) ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("grade.apart")}
                        title={t("grade.apart")}
                        data-pa-worker-cells={w.id}
                      >
                        <ChartColumn aria-hidden />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-80 p-1.5">
                      <GradeCells
                        by="executor"
                        cells={(grades?.cells ?? []).filter(
                          (c) => c.bot_id === w.id
                        )}
                      />
                    </PopoverContent>
                  </Popover>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => goTo(w.id)}
                  data-pa-worker-open={w.id}
                >
                  {tb("openConversation")}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={tb("more")}
                      data-pa-worker-menu={w.id}
                    >
                      {copying === w.id ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <MoreHorizontal aria-hidden />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => openBotPage("identity", { bot: w.id })}
                      data-pa-worker-details={w.id}
                    >
                      {tb("roster.menu.details")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={readOnly || copying != null}
                      onSelect={() => void copy(w)}
                      data-pa-worker-copy={w.id}
                    >
                      {tb("copy")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={readOnly}
                      variant="destructive"
                      onSelect={() => setDeleting(w.id)}
                      data-pa-worker-delete={w.id}
                    >
                      {tb("deleteAction")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          })}
        </SettingCard>
      )}
      <NewBotDialog
        open={adding}
        onOpenChange={setAdding}
        onMade={(made) => {
          if (made.bot) goTo(made.bot.id)
        }}
      />
      <BotDeleteDialog
        botId={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      />
    </div>
  )
}

// ── executor configs ────────────────────────────────────────────────────────

/** What a row says besides the agent: in flight, failing, two weeks, and
 *  the assistants whose work runs on it. */
function ExecutorLine({
  assistant,
  view,
}: {
  assistant: AssistantInfo
  view: ExecutorView | undefined
}) {
  const t = useTranslations("PersonalAgent.settings.executor")
  const tMode = useTranslations("PersonalAgent.mode")
  const openWork = useOpenWork()
  const botName = useBotName()
  const gradeText = useGradeText()
  if (!view) return null
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
  const grade = gradeText(view.grade)
  if (grade) {
    const cells = view.grade_cells ?? []
    chips.push(
      cells.length > 0 ? (
        <Popover key="grade">
          <PopoverTrigger asChild>
            <button
              type="button"
              data-pa-executor-grade={view.assistant_id}
              className="rounded-sm underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              {grade}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-1.5">
            <GradeCells by="bot" cells={cells} />
          </PopoverContent>
        </Popover>
      ) : (
        <span key="grade" data-pa-executor-grade={view.assistant_id}>
          {grade}
        </span>
      )
    )
  }
  if (view.workers.length > 0) {
    chips.push(
      <span key="used-by" data-pa-executor-used-by={view.assistant_id}>
        {t("usedBy", {
          names: view.workers.map((w) => botName(w)).join(t("nameJoin")),
        })}
      </span>
    )
  }
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

/** What deleting or turning off an executor config takes with it: the
 *  assistants whose work runs on it can do none of their own for now. */
function useImpact(views: ReadonlyMap<number, ExecutorView>) {
  const t = useTranslations("PersonalAgent.settings.executor")
  const botName = useBotName()
  return function impactOf(assistant: AssistantInfo): ReactNode | null {
    const v = views.get(assistant.id)
    if (!v) return null
    const lines: string[] = []
    if (v.workers.length > 0) {
      lines.push(
        t("impactBots", {
          names: v.workers.map((w) => botName(w)).join(t("nameJoin")),
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
  delegationEnabled,
}: {
  delegationEnabled: boolean | null
}) {
  const t = useTranslations("PersonalAgent.settings")
  const views = useExecutors()
  const impact = useImpact(views)
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="executors">
      <PageHead title={t("nav.executors")} />
      <SettingNote icon={Layers}>{t("team.sameBatch")}</SettingNote>
      <AssistantsPanel
        delegationEnabled={delegationEnabled}
        delegationOffText={t("team.delegationOff")}
        delegationOffAction={t("team.openCollaboration")}
        onShowGeneral={() =>
          void openSettingsWindow("collaboration").catch(() => {})
        }
        rowExtra={(a) => <ExecutorLine assistant={a} view={views.get(a.id)} />}
        deleteImpact={(a) => impact(a)}
        disableImpact={(a) => impact(a)}
      />
    </div>
  )
}
