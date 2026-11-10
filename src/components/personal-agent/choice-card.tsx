"use client"

/**
 * A choice card (10.7; the basic one, which 1.10 takes further): a
 * question, its lettered choices and "Other" for the owner's own words.
 * A letter key picks while the card has focus. Answered, it folds to one
 * line — "You picked: B. Look at local changes" — that opens to show the
 * card as it was. A choice that is about a project opens the project list
 * first.
 *
 * A new work assistant's opening card (4.12) carries more: [Change role]
 * while it has not started, and under it what codeg made for it — its
 * brain, its executor config and the options picked for the owner — with
 * [Change brain] [Change executor config].
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  MessageSquareDashed,
  Repeat2,
  Send,
} from "lucide-react"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useBotId } from "@/contexts/personal-agent-context"
import {
  personalAgentBotSetTemplate,
  personalAgentChoiceAnswer,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PickedOption } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { AGENT_SURFACE, str, usePageScope } from "./shared"
import { useBotTemplates } from "./use-templates"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

interface ChoiceOption {
  key: string
  label: string
  project: boolean
}

function optionsOf(v: unknown): ChoiceOption[] {
  if (!Array.isArray(v)) return []
  return v
    .map((o) => o as Record<string, unknown>)
    .filter((o) => typeof o.key === "string" && typeof o.label === "string")
    .map((o) => ({
      key: o.key as string,
      label: o.label as string,
      project: o.project === true,
    }))
}

function pickedOf(v: unknown): PickedOption[] {
  return Array.isArray(v)
    ? v.filter(
        (p): p is PickedOption =>
          p != null && typeof p === "object" && "id" in p && "from" in p
      )
    : []
}

export function ChoiceCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.bots.choice")
  const { readOnly } = usePageScope()
  const botId = useBotId()
  const row = item.row
  const data = row.data ?? {}
  const noticeId = Number(row.ref_id)
  const answered = str(data, "state") === "answered"
  const question = str(data, "question") ?? row.body
  const options = optionsOf(data.options)
  const other = str(data, "other") ?? t("other")
  const otherKey = String.fromCharCode(65 + options.length)
  const answer = (data.answer ?? null) as Record<string, unknown> | null
  const starter = str(data, "purpose") === "starter"
  const [unfolded, setUnfolded] = useState(false)
  const [choosingProject, setChoosingProject] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const folders = useAppWorkspaceStore((s) => s.folders)
  const projects = useMemo(
    () => folders.filter((f) => f.kind === "regular" && f.parent_id == null),
    [folders]
  )

  const send = async (a: {
    key?: string
    text?: string
    projectId?: number
  }) => {
    if (busy || readOnly) return
    setBusy(a.key ?? "other")
    setError(null)
    try {
      await personalAgentChoiceAnswer(noticeId, a, botId)
      setChoosingProject(null)
      setWriting(false)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const pick = (o: ChoiceOption) => {
    if (o.project) setChoosingProject((k) => (k === o.key ? null : o.key))
    else void send({ key: o.key })
  }

  const answerLine = answer
    ? typeof answer.text === "string"
      ? t("answeredOwn", { text: answer.text })
      : t("answered", {
          choice: `${String(answer.key ?? "")}. ${String(answer.label ?? "")}${
            answer.project &&
            typeof (answer.project as { name?: unknown }).name === "string"
              ? ` — ${(answer.project as { name: string }).name}`
              : ""
          }`,
        })
    : null

  const body = (
    <>
      <p className="mb-2.5 text-sm font-medium break-words">{question}</p>
      <div
        role="group"
        aria-label={question}
        className="flex flex-col gap-1.5"
        data-pa-choices
      >
        {options.map((o) => {
          const chosen = answer?.key === o.key
          return (
            <div key={o.key}>
              <button
                type="button"
                disabled={answered || readOnly || busy != null}
                data-pa-choice={o.key}
                onClick={() => pick(o)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-start text-sm transition-colors enabled:hover:bg-muted disabled:cursor-default",
                  chosen && "border-primary bg-primary/5"
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border/80 text-xs font-medium text-muted-foreground">
                  {o.key}
                </span>
                <span className="min-w-0 flex-1 break-words">{o.label}</span>
                {busy === o.key ? (
                  <SyncedSpinner small className="size-3.5" />
                ) : null}
              </button>
              {choosingProject === o.key ? (
                <div
                  className="mt-1 ms-7 flex flex-wrap gap-1.5"
                  data-pa-choice-projects
                >
                  {projects.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {t("noProjects")}
                    </span>
                  ) : (
                    projects.map((f) => (
                      <Button
                        key={f.id}
                        size="xs"
                        variant="outline"
                        disabled={busy != null}
                        onClick={() =>
                          void send({ key: o.key, projectId: f.id })
                        }
                      >
                        {f.name}
                      </Button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
        {answered ? null : writing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const v = text.trim()
              if (v) void send({ key: otherKey, text: v })
            }}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border/80 text-xs font-medium text-muted-foreground">
              {otherKey}
            </span>
            <Input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("otherPlaceholder")}
              className="h-8 flex-1 bg-background text-sm"
              data-pa-choice-other-input
            />
            <Button
              type="submit"
              size="icon-sm"
              disabled={!text.trim() || busy != null}
              aria-label={t("send")}
            >
              <Send aria-hidden />
            </Button>
          </form>
        ) : (
          <button
            type="button"
            disabled={readOnly || busy != null}
            data-pa-choice={otherKey}
            onClick={() => setWriting(true)}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-start text-sm text-muted-foreground transition-colors enabled:hover:bg-muted"
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border/80 text-xs font-medium">
              {otherKey}
            </span>
            {other}
          </button>
        )}
      </div>
    </>
  )

  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text: question, at: row.created_at }}
    >
      <div
        data-bubble
        data-pa-notice={answered ? "answered" : "open"}
        data-pa-choice-card
        tabIndex={answered ? undefined : 0}
        onKeyDown={(e) => {
          if (answered || writing || e.metaKey || e.ctrlKey || e.altKey) return
          const k = e.key.toUpperCase()
          const o = options.find((x) => x.key === k)
          if (o) {
            e.preventDefault()
            pick(o)
          } else if (k === otherKey) {
            e.preventDefault()
            setWriting(true)
          }
        }}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
      >
        {answered && !unfolded ? (
          <button
            type="button"
            onClick={() => setUnfolded(true)}
            className="flex w-full items-center gap-1.5 text-start text-sm"
            data-pa-choice-answered
          >
            <ChevronRight
              className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
              aria-hidden
            />
            <span className="min-w-0 flex-1 break-words">{answerLine}</span>
          </button>
        ) : (
          <>
            {answered ? (
              <button
                type="button"
                onClick={() => setUnfolded(false)}
                className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <ChevronDown className="size-3.5" aria-hidden />
                {answerLine}
              </button>
            ) : null}
            {body}
          </>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-xs break-words text-destructive">
            {error}
          </p>
        ) : null}
        {starter ? (
          <StarterFoot
            data={data}
            open={!answered}
            readOnly={readOnly}
            botId={botId}
          />
        ) : null}
      </div>
    </MessageRow>
  )
}

/** Under a new assistant's opening card: what codeg made for it. */
function StarterFoot({
  data,
  open,
  readOnly,
  botId,
}: {
  data: Record<string, unknown>
  open: boolean
  readOnly: boolean
  botId: number | null
}) {
  const t = useTranslations("PersonalAgent.bots.choice")
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const templates = useBotTemplates()
  const [details, setDetails] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const made = (data.made ?? {}) as Record<string, unknown>
  const brain = (made.brain ?? {}) as Record<string, unknown>
  const executor = (made.executor ?? {}) as Record<string, unknown>
  const picked = pickedOf(executor.picked)
  const brainPicked = pickedOf(brain.picked)
  const filled = picked.filter((p) => p.from !== "given")
  const template = str(data, "template")
  const executorAgent = str(executor, "agent") ?? ""
  const line = [
    brain.same_as_primary === true
      ? t("brainSame")
      : t("brainOwn", { agent: str(brain, "agent") ?? "" }),
    executor.created === false
      ? t("executorBound", { name: str(executor, "name") ?? "" })
      : filled.length > 0
        ? t("executorFilled", { agent: executorAgent, count: filled.length })
        : t("executorMade", { agent: executorAgent }),
  ].join(t("joiner"))

  const changeRole = async (id: string) => {
    if (botId == null) return
    setSwitching(true)
    setError(null)
    try {
      await personalAgentBotSetTemplate(botId, id)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div
      className="mt-3 border-t border-border/50 pt-2 text-xs text-muted-foreground"
      data-pa-starter-foot
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-start hover:text-foreground"
          onClick={() => setDetails((d) => !d)}
          aria-expanded={details}
          data-pa-starter-made
        >
          {details ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronRight className="size-3 rtl:rotate-180" aria-hidden />
          )}
          {line}
        </button>
        <span className="flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => openSettings("identity", null)}
          >
            {t("editBrain")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => openSettings("execution", null)}
          >
            {t("editExecutor")}
          </Button>
          {open ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={readOnly || switching || !templates}
                  data-pa-change-role
                >
                  {switching ? (
                    <SyncedSpinner small />
                  ) : (
                    <Repeat2 aria-hidden />
                  )}
                  {t("changeRole")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                {(templates ?? []).map((tpl) => (
                  <DropdownMenuItem
                    key={tpl.id}
                    disabled={tpl.id === template}
                    onSelect={() => void changeRole(tpl.id)}
                    data-pa-role={tpl.id}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="text-sm">{tpl.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {tpl.job}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </span>
      </div>
      {details ? (
        <ul className="mt-1.5 space-y-0.5 ps-4" data-pa-starter-picked>
          {[
            ...brainPicked.map((p) => ({ p, brain: true })),
            ...picked.map((p) => ({ p, brain: false })),
          ].map(({ p, brain: isBrain }) => (
            <li key={`${isBrain ? "b" : "e"}-${p.id}`} className="break-words">
              <span className="text-foreground/80">
                {isBrain ? t("brainItem", { name: p.name }) : p.name}
              </span>
              {": "}
              {p.value_label}
              <span className="ms-1 inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[0.6875rem]">
                <MessageSquareDashed className="size-2.5" aria-hidden />
                {t(`from.${p.from}`)}
              </span>
            </li>
          ))}
          {picked.length === 0 && brainPicked.length === 0 ? (
            <li>{t("nothingPicked")}</li>
          ) : null}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 break-words text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
