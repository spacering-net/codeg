"use client"

/**
 * The time machine on the assistants' page (8.2): a search button by the
 * title, and the search it opens — type, and what was said and done before
 * comes up: the assistants' timelines, the messages between them, every
 * conversation and the board's tasks, each with its project, agent and
 * time. A hit opens where it is: the row in its assistant's conversation,
 * the conversation, the task. The same search the assistants' own
 * `history_search` makes; no model is asked.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  LayoutGrid,
  Loader2,
  MessageSquareText,
  MessagesSquare,
  Search,
  Send,
} from "lucide-react"

import { useTaskDialogs } from "@/components/tasks/use-task-dialogs"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { usePrimaryAgent } from "@/contexts/personal-agent-context"
import { useOptionalTasksView } from "@/contexts/tasks-view-context"
import { personalAgentHistorySearch } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import type {
  AgentType,
  PersonalAgentHistoryHit,
  PersonalAgentHistoryResults,
  PersonalAgentHistoryScope,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { useSessionLinkOpener } from "./session-link"

/** How long typing rests before the search goes. */
const TYPING_MS = 250
/** Hits the page asks for. */
const HITS = 30

const SCOPES: PersonalAgentHistoryScope[] = [
  "all",
  "timeline",
  "sessions",
  "tasks",
  "messages",
]

const MARK_OPEN = "\u0002"
const MARK_CLOSE = "\u0003"

/** The excerpt's parts: plain, and each match marked. */
export function excerptParts(
  excerpt: string
): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = []
  let rest = excerpt
  while (rest.length > 0) {
    const open = rest.indexOf(MARK_OPEN)
    if (open < 0) {
      out.push({ text: rest, mark: false })
      break
    }
    if (open > 0) out.push({ text: rest.slice(0, open), mark: false })
    const close = rest.indexOf(MARK_CLOSE, open + 1)
    if (close < 0) {
      out.push({ text: rest.slice(open + 1), mark: true })
      break
    }
    out.push({ text: rest.slice(open + 1, close), mark: true })
    rest = rest.slice(close + 1)
  }
  return out.filter((p) => p.text.length > 0)
}

/** The search button by the page's title. */
export function HistorySearchButton() {
  const t = useTranslations("PersonalAgent.history")
  const setOpen = usePersonalAgentUi((s) => s.setSearchOpen)
  return (
    <button
      type="button"
      data-pa-history-open
      className="ms-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      onClick={() => setOpen(true)}
      title={t("open")}
      aria-label={t("open")}
    >
      <Search className="size-3.5" />
    </button>
  )
}

/** Where a hit opens. */
export interface HistoryOpeners {
  /** A row in an assistant's conversation. */
  row: (bot: number, row: number) => void
  session: (conversationId: number) => void
  /** A task: its details, or — not on the board now — its conversation. */
  task: (taskId: number, conversationId: number | null) => void
}

function SourceIcon({ source }: { source: PersonalAgentHistoryHit["source"] }) {
  const Icon =
    source === "session"
      ? MessagesSquare
      : source === "task"
        ? LayoutGrid
        : source === "message"
          ? Send
          : MessageSquareText
  return <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
}

function HitRow({
  hit,
  onOpen,
}: {
  hit: PersonalAgentHistoryHit
  onOpen: () => void
}) {
  const t = useTranslations("PersonalAgent.history")
  const locale = useLocale()
  const heading = (() => {
    switch (hit.source) {
      case "session":
        return hit.title?.trim() || t("untitled", { id: hit.ref_id })
      case "task":
        return hit.title?.trim() || t("task", { id: hit.ref_id })
      case "message":
        return t("message", {
          from: hit.bot_name ?? "?",
          to: hit.peer_name ?? "?",
        })
      default:
        return t("timeline", { name: hit.bot_name ?? "?" })
    }
  })()
  const when = new Date(hit.at)
  const time = Number.isNaN(when.getTime())
    ? ""
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(when)
  const facts = [
    hit.project,
    hit.agent_type ? getAgentLabel(hit.agent_type as AgentType) : null,
    hit.source === "session" && hit.bot_name
      ? t("handedOut", { name: hit.bot_name })
      : null,
    time,
    hit.matches > 1 ? t("matches", { count: hit.matches }) : null,
  ].filter((f): f is string => !!f)
  const who =
    hit.role === "owner"
      ? t("role.owner")
      : hit.role === "assistant"
        ? t("role.assistant")
        : hit.role === "agent"
          ? t("role.agent")
          : null
  return (
    <button
      type="button"
      data-pa-history-hit={`${hit.source}:${hit.ref_id}`}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-start transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      onClick={onOpen}
    >
      <SourceIcon source={hit.source} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{heading}</span>
        <span className="line-clamp-2 text-xs leading-5 text-foreground/80">
          {who ? <span className="text-muted-foreground">{who}: </span> : null}
          {excerptParts(hit.excerpt).map((p, i) =>
            p.mark ? (
              <mark
                key={i}
                className="rounded-sm bg-amber-300/50 px-0.5 text-foreground dark:bg-amber-400/30"
              >
                {p.text}
              </mark>
            ) : (
              <Fragment key={i}>{p.text}</Fragment>
            )
          )}
        </span>
        <span className="truncate text-[0.6875rem] text-muted-foreground">
          {facts.join(" · ")}
        </span>
      </span>
    </button>
  )
}

/** The search itself, over the page. */
export function HistorySearchDialog({ openers }: { openers: HistoryOpeners }) {
  const t = useTranslations("PersonalAgent.history")
  const open = usePersonalAgentUi((s) => s.searchOpen)
  const setOpen = usePersonalAgentUi((s) => s.setSearchOpen)
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState<PersonalAgentHistoryScope>("all")
  // The latest answer, for the search it answered: shown while the next
  // one is on its way.
  const [answer, setAnswer] = useState<{
    key: string
    results: PersonalAgentHistoryResults | null
    error: string | null
  } | null>(null)
  const seq = useRef(0)
  const text = query.trim()
  const key = `${scope}\u0000${text}`

  useEffect(() => {
    if (!open || text.length === 0) return
    const id = ++seq.current
    const timer = window.setTimeout(() => {
      personalAgentHistorySearch({ query: text, scope, limit: HITS })
        .then((results) => {
          if (id === seq.current) setAnswer({ key, results, error: null })
        })
        .catch((e) => {
          if (id === seq.current)
            setAnswer({ key, results: null, error: toErrorMessage(e) })
        })
    }, TYPING_MS)
    return () => window.clearTimeout(timer)
  }, [open, text, scope, key])

  const asked = open && text.length > 0
  const shown = asked ? answer : null
  const results = shown?.results ?? null
  const error = shown?.error ?? null
  const searching = asked && answer?.key !== key

  const notes = useMemo(() => {
    if (!results) return []
    const st = results.status
    const out: string[] = []
    if (results.short) out.push(t("short"))
    if (!st.sessions_on) out.push(t("sessionsOff"))
    else if (st.sessions_done < st.sessions_total)
      out.push(
        t("reading", { done: st.sessions_done, total: st.sessions_total })
      )
    if (!st.tasks_on) out.push(t("tasksOff"))
    return out
  }, [results, t])

  const openHit = (hit: PersonalAgentHistoryHit) => {
    setOpen(false)
    if (hit.source === "session") {
      openers.session(hit.ref_id)
    } else if (hit.source === "task") {
      openers.task(hit.ref_id, hit.conversation_id)
    } else if (hit.bot_id != null && hit.row_id != null) {
      openers.row(hit.bot_id, hit.row_id)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="flex max-h-[80vh] flex-col gap-3 sm:max-w-2xl"
        data-pa-history
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("placeholder")}
            className="ps-8"
            data-pa-history-input
          />
          {searching ? (
            <Loader2 className="absolute end-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1" role="radiogroup">
          {SCOPES.map((s) => (
            <Button
              key={s}
              type="button"
              size="xs"
              variant={scope === s ? "secondary" : "ghost"}
              role="radio"
              aria-checked={scope === s}
              data-pa-history-scope={s}
              onClick={() => setScope(s)}
            >
              {t(`scope.${s}`)}
            </Button>
          ))}
        </div>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-0.5">
          {error ? (
            <p className="px-2.5 py-2 text-sm text-destructive">{error}</p>
          ) : results && results.hits.length === 0 ? (
            <p
              className="px-2.5 py-2 text-sm text-muted-foreground"
              data-pa-history-none
            >
              {t("none")}
            </p>
          ) : results ? (
            <div className="flex flex-col">
              {results.hits.map((h) => (
                <HitRow
                  key={`${h.source}:${h.ref_id}`}
                  hit={h}
                  onOpen={() => openHit(h)}
                />
              ))}
            </div>
          ) : text.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              {t("hint")}
            </p>
          ) : null}
        </div>
        {notes.length > 0 ? (
          <div
            className={cn(
              "flex flex-col gap-0.5 border-t pt-2 text-xs text-muted-foreground"
            )}
            data-pa-history-notes
          >
            {notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const noRefetch = async () => {}

/** The page's search, a hit opening where it is: the row in its
 *  assistant's conversation (as a followed notification does), the
 *  conversation as a tab, the task's details. */
export function PersonalAgentHistorySearch() {
  const openSession = useSessionLinkOpener()
  const { snapshot } = usePrimaryAgent()
  const entries = useRoster()
  const primaryId = snapshot?.agent?.id ?? null
  const view = useOptionalTasksView()
  const tasks = useMemo(() => view?.tasks ?? [], [view?.tasks])
  const refetch = view?.refetch ?? noRefetch
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const folderNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of allFolders) map.set(f.id, f.alias ?? f.name)
    return map
  }, [allFolders])
  const { openDetail, dialogs } = useTaskDialogs({
    tasks,
    refetch,
    folderNames,
    defaultFolderId: null,
  })
  const openers = useMemo<HistoryOpeners>(
    () => ({
      row: (bot, row) => {
        const isPrimary =
          bot === primaryId ||
          (entries ?? []).some((e) => e.id === bot && e.kind === "primary")
        const ui = usePersonalAgentUi.getState()
        ui.setViewBot(isPrimary ? null : bot)
        ui.showConversation()
        ui.setPendingJump({ bot, row })
      },
      session: openSession,
      task: (id, conversationId) => {
        if (tasks.some((t) => t.id === id)) openDetail(id)
        else if (conversationId != null) openSession(conversationId)
      },
    }),
    [primaryId, entries, openSession, openDetail, tasks]
  )
  return (
    <>
      <HistorySearchDialog openers={openers} />
      {dialogs}
    </>
  )
}
