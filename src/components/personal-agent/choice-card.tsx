"use client"

/**
 * A choice card (10.7): a question, its lettered choices and "Other" for
 * the owner's own words. This is the native one (a new assistant's
 * opening card); the assistant brain's own questions draw the same way,
 * one question at a time (`question-choice-card.tsx`).
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

import { Fragment, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  Bot,
  Brain,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  PenLine,
  Send,
  type LucideIcon,
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
import { MessageRow } from "./message-row"
import {
  CardMessage,
  SheetLabel,
  SheetNote,
  SheetPart,
  str,
  usePageScope,
} from "./shared"
import { useBotTemplates } from "./use-templates"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

/** A choice's letter, on a little tile; the theme's colour on the one
 *  picked. */
export function ChoiceKey({
  letter,
  chosen = false,
  className,
}: {
  letter: string
  chosen?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
        chosen
          ? "bg-primary text-primary-foreground"
          : "bg-foreground/[0.06] text-foreground/60",
        className
      )}
    >
      {letter}
    </span>
  )
}

/** A choice's row, raised off the bubble (`.pa-choice` in globals.css);
 *  `chosen` marks the one picked. */
export function choiceRowClass(chosen: boolean): string {
  return cn(
    "pa-choice flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm transition-[background-color,box-shadow] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default",
    chosen && "pa-choice-chosen"
  )
}

/** "Other", to write one's own: the row's shape, a dashed line on the
 *  bubble's colour. */
export const CHOICE_OTHER_CLASS =
  "pa-choice-other flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

/** Writing one's own, in place of "Other": a raised row holding the field
 *  and the send button. */
export const CHOICE_WRITE_CLASS =
  "pa-choice flex items-center gap-2.5 rounded-xl py-1 ps-3 pe-1 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-1 has-[input:focus-visible]:outline-ring"

/** The field in it: no box of its own — the row is. */
export const CHOICE_INPUT_CLASS =
  "h-8 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"

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
      <p className="mb-3 text-sm leading-6 font-medium break-words">
        {question}
      </p>
      <div
        role="group"
        aria-label={question}
        className="flex flex-col gap-2"
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
                aria-expanded={
                  o.project ? choosingProject === o.key : undefined
                }
                className={choiceRowClass(chosen)}
              >
                <ChoiceKey letter={o.key} chosen={chosen} />
                <span className="min-w-0 flex-1 break-words">{o.label}</span>
                {busy === o.key ? (
                  <SyncedSpinner small className="size-3.5" />
                ) : o.project && !answered ? (
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      choosingProject !== o.key && "-rotate-90 rtl:rotate-90"
                    )}
                  />
                ) : null}
              </button>
              {choosingProject === o.key ? (
                // Under the choice's words.
                <div
                  className="mt-2 ms-11.5 flex flex-wrap gap-1.5"
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
            className={CHOICE_WRITE_CLASS}
            onSubmit={(e) => {
              e.preventDefault()
              const v = text.trim()
              if (v) void send({ key: otherKey, text: v })
            }}
          >
            <ChoiceKey letter={otherKey} />
            <Input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("otherPlaceholder")}
              aria-label={other}
              className={CHOICE_INPUT_CLASS}
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
            className={CHOICE_OTHER_CLASS}
          >
            <ChoiceKey letter={otherKey} />
            <span className="min-w-0 flex-1 break-words">{other}</span>
            <PenLine aria-hidden className="size-3.5 shrink-0 opacity-60" />
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
      <CardMessage
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
        // One width, whatever its words: its set-up opening under it does
        // not widen it.
        className="w-md max-w-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {answered && !unfolded ? (
          <SheetPart>
            <button
              type="button"
              onClick={() => setUnfolded(true)}
              className="flex w-full items-center gap-2 text-start text-sm"
              data-pa-choice-answered
            >
              <CircleCheck
                className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden
              />
              <span className="min-w-0 flex-1 break-words">{answerLine}</span>
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground rtl:rotate-180"
                aria-hidden
              />
            </button>
          </SheetPart>
        ) : (
          <SheetPart className="py-3.5">
            {answered ? (
              <button
                type="button"
                onClick={() => setUnfolded(false)}
                className="mb-2.5 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className="size-3.5" aria-hidden />
                {answerLine}
              </button>
            ) : null}
            {body}
          </SheetPart>
        )}
        {starter ? (
          <StarterFoot
            data={data}
            open={!answered}
            readOnly={readOnly}
            botId={botId}
          />
        ) : null}
        {error ? (
          <SheetNote>
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          </SheetNote>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}

/** Where a picked option's value came from, in the order they are told. */
const FROM_ORDER: readonly PickedOption["from"][] = [
  "given",
  "other_config",
  "agent",
]

/**
 * Under a new assistant's opening card: what codeg set up for it — a panel
 * of three lines, each a label, what it is and how to change it: its role
 * (while the card waits for an answer), its brain and its executor config.
 * The options codeg picked for either open under its line, by where they
 * came from.
 */
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
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  const templates = useBotTemplates()
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const made = (data.made ?? {}) as Record<string, unknown>
  const brain = (made.brain ?? {}) as Record<string, unknown>
  const executor = (made.executor ?? {}) as Record<string, unknown>
  const picked = pickedOf(executor.picked)
  const brainPicked = pickedOf(brain.picked)
  const filled = picked.filter((p) => p.from !== "given").length
  const template = str(data, "template")
  const templateName =
    str(data, "template_name") ??
    templates?.find((tpl) => tpl.id === template)?.name ??
    template ??
    ""
  const bound = executor.created === false

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
    <SheetPart className="pb-2" data-pa-starter-foot>
      <SheetLabel className="mb-1">{t("setup")}</SheetLabel>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
        <SetupLine
          icon={BriefcaseBusiness}
          label={t("role")}
          value={templateName}
          // Changed only before the card is answered: the answer is about
          // the role.
          action={
            open ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={readOnly || switching || !templates}
                    aria-label={t("changeRole")}
                    title={t("changeRole")}
                    data-pa-change-role
                  >
                    {switching ? <SyncedSpinner small /> : null}
                    {t("change")}
                    <ChevronDown aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
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
            ) : null
          }
        />
        <SetupLine
          icon={Brain}
          label={t("brain")}
          value={str(brain, "agent") ?? ""}
          note={brain.same_as_primary === true ? t("sameAsPrimary") : null}
          picked={brainPicked}
          pickedLabel={t("options", { count: brainPicked.length })}
          action={
            <Button
              size="xs"
              variant="ghost"
              onClick={() => openBotPage("identity")}
              aria-label={t("editBrain")}
              title={t("editBrain")}
            >
              {t("change")}
            </Button>
          }
        />
        <SetupLine
          icon={Bot}
          label={t("executor")}
          value={(bound ? str(executor, "name") : str(executor, "agent")) ?? ""}
          note={bound ? t("existing") : null}
          picked={picked}
          pickedLabel={
            filled > 0
              ? t("filled", { count: filled })
              : t("options", { count: picked.length })
          }
          action={
            <Button
              size="xs"
              variant="ghost"
              onClick={() => openBotPage("execution")}
              aria-label={t("editExecutor")}
              title={t("editExecutor")}
            >
              {t("change")}
            </Button>
          }
        />
      </dl>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs break-words text-destructive">
          {error}
        </p>
      ) : null}
    </SheetPart>
  )
}

/** One line of the set-up panel: its label, what it is — with a word on
 *  it and the options picked, folded — and a button to change it. */
function SetupLine({
  icon: Icon,
  label,
  value,
  note = null,
  picked = [],
  pickedLabel,
  action,
}: {
  icon: LucideIcon
  label: string
  value: string
  note?: string | null
  picked?: readonly PickedOption[]
  pickedLabel?: string
  action: ReactNode | null
}) {
  const t = useTranslations("PersonalAgent.bots.choice")
  const [unfolded, setUnfolded] = useState(false)
  const groups = FROM_ORDER.map(
    (from) => [from, picked.filter((p) => p.from === from)] as const
  ).filter(([, items]) => items.length > 0)
  return (
    <>
      <dt className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {label}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
        <span className="min-w-0 truncate font-medium" title={value}>
          {value}
        </span>
        {note ? (
          <span className="text-xs text-muted-foreground">· {note}</span>
        ) : null}
        {picked.length > 0 ? (
          <button
            type="button"
            onClick={() => setUnfolded((u) => !u)}
            aria-expanded={unfolded}
            className="-mx-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors outline-none hover:bg-(--pa-inset-hover) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            data-pa-starter-made
          >
            <span>· {pickedLabel}</span>
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 transition-transform",
                !unfolded && "-rotate-90 rtl:rotate-90"
              )}
            />
          </button>
        ) : null}
      </dd>
      <dd className="flex justify-end">{action}</dd>
      {unfolded ? (
        // Under the values, by where each came from.
        <dd
          className="col-span-2 col-start-2 mb-1 flex flex-col gap-2 border-s border-foreground/10 ps-3 pt-0.5 pb-1"
          data-pa-starter-picked
        >
          {groups.map(([from, items]) => (
            <div key={from}>
              <p className="mb-1 text-xs text-muted-foreground">
                {t(`from.${from}`)}
              </p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.8125rem]">
                {items.map((p) => (
                  <Fragment key={p.id}>
                    <dt className="text-foreground/65">{p.name}</dt>
                    <dd className="min-w-0 break-words">{p.value_label}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          ))}
        </dd>
      ) : null}
    </>
  )
}
