"use client"

/**
 * A choice card (10.7): a question, its lettered choices and "Other" for
 * the owner's own words. This is codeg's native one; the assistant brain's
 * own questions draw the same way, one question at a time
 * (`question-choice-card.tsx`).
 * A letter key picks while the card has focus. Answered, it folds to one
 * line — "You picked: B. Look at local changes" — that opens to show the
 * card as it was. A choice that is about a project opens the project list
 * first.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  PenLine,
  Send,
} from "lucide-react"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentChoiceAnswer } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import { CardMessage, SheetNote, SheetPart, str, usePageScope } from "./shared"

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
