"use client"

/**
 * "Is this right?" (10.3) in an ordinary conversation: the checks of its
 * messages, asking for one, and the mark under a message that was checked.
 *
 * - Offered where there is someone to ask: a primary assistant is set up,
 *   and the conversation is stored (a draft has nothing to check yet).
 * - A message is known by its fingerprint (`messageFingerprint`, the
 *   backend's own): the conversation's checks are read once and again when
 *   one of them begins or ends — or every few seconds while one runs, for a
 *   page whose process does not run the assistants (nothing is pushed to it).
 * - Asking again for a message (or a sentence of it) already checked opens
 *   its last conclusion, with [Check again] there.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useCheckConversations } from "@/hooks/use-ask-conversations"
import {
  listCheckConversations,
  personalAgentCheckMessage,
  personalAgentChecks,
} from "@/lib/api"
import { messageFingerprint } from "@/lib/message-check"
import { followPersonalAgentLink } from "@/lib/personal-agent-notify"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  PERSONAL_AGENT_CHANGED_EVENT,
  type DbConversationSummary,
  type MessageCheck,
  type MessageCheckVerdict,
  type PersonalAgentChange,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAskConversationDrawerStore } from "@/stores/ask-conversation-drawer-store"
import { useRoster } from "@/stores/personal-agent-roster-store"

/** How often the checks are read again while one runs. */
const RUNNING_POLL_MS = 5_000
/** A checked sentence, as its mark quotes it. */
const QUOTE_MARK_CHARS = 18

/** What a check is asked for. */
export interface CheckAsk {
  /** All of the message. */
  message: string
  /** The owner's message it answered. */
  asked: string | null
  /** The sentence of it the owner selected. */
  quote: string | null
}

interface MessageChecksValue {
  /** The latest checks of each message of this conversation, by the
   *  message's fingerprint. */
  byMessage: ReadonlyMap<string, MessageCheck[]>
  /** Ask for a check: its last one opens when there is one (`again`: a new
   *  one, once that is over). */
  check: (ask: CheckAsk, again?: boolean) => void
  /** The check whose details are open. */
  openId: number | null
  setOpenId: (id: number | null) => void
  /** A check is being asked for. */
  asking: boolean
  /** Show how a check went: its conversation. */
  openProcess: (check: MessageCheck) => void
}

const MessageChecksContext = createContext<MessageChecksValue | null>(null)

/** The conversation's checks, `null` where none are offered. */
export function useMessageChecks(): MessageChecksValue | null {
  return useContext(MessageChecksContext)
}

/** Replace `next`'s check in `held` (the latest of its message and
 *  sentence), or add it. */
function withCheck(held: MessageCheck[], next: MessageCheck): MessageCheck[] {
  const rest = held.filter(
    (c) =>
      c.id !== next.id &&
      !(c.message_fp === next.message_fp && c.quote_fp === next.quote_fp)
  )
  return [...rest, next].sort((a, b) => a.id - b.id)
}

export function MessageChecksProvider({
  conversationId,
  openInDrawer = false,
  children,
}: {
  conversationId: number
  /** A check's conversation opens in the ask drawer beside the transcript
   *  (the conversation page has one), not in a tab. */
  openInDrawer?: boolean
  children: ReactNode
}) {
  const roster = useRoster()
  const offered =
    conversationId > 0 && (roster?.some((e) => e.kind === "primary") ?? false)
  return offered ? (
    <ChecksOf conversationId={conversationId} openInDrawer={openInDrawer}>
      {children}
    </ChecksOf>
  ) : (
    <>{children}</>
  )
}

function ChecksOf({
  conversationId,
  openInDrawer,
  children,
}: {
  conversationId: number
  openInDrawer: boolean
  children: ReactNode
}) {
  const t = useTranslations("MessageCheck")
  const tAsk = useTranslations("Folder.askConversations")
  const [held, setHeld] = useState<{ of: number; checks: MessageCheck[] }>({
    of: conversationId,
    checks: [],
  })
  // Another conversation's checks are not this one's.
  const checks = useMemo(
    () => (held.of === conversationId ? held.checks : []),
    [held, conversationId]
  )
  const [openId, setOpenId] = useState<number | null>(null)
  const [asking, setAsking] = useState(false)
  // Reads (and a check asked for) answer out of order: only the newest
  // read's answer stands — one that was on its way when a newer one went
  // out, or when the answer to a check asked for came back, would put back
  // what they have since replaced. And only for the conversation shown now.
  const readSeq = useRef(0)
  const shown = useRef(conversationId)
  useEffect(() => {
    shown.current = conversationId
  }, [conversationId])

  const reload = useCallback(() => {
    const mine = ++readSeq.current
    const of = conversationId
    personalAgentChecks(of)
      .then((read) => {
        if (mine === readSeq.current && of === shown.current) {
          setHeld({ of, checks: read })
        }
      })
      .catch(() => {})
  }, [conversationId])

  useEffect(() => {
    let live = true
    const offs: Array<() => void> = []
    reload()
    subscribe<PersonalAgentChange>(PERSONAL_AGENT_CHANGED_EVENT, (change) => {
      if (
        live &&
        change.kind === "check" &&
        change.conversation_id === conversationId
      ) {
        reload()
      }
    })
      .then((off) => (live ? offs.push(off) : off()))
      .catch(() => {})
    try {
      const off = onTransportReconnect(() => {
        if (live) reload()
      })
      if (off) offs.push(off)
    } catch {
      // No transport to follow (a test, a page without one).
    }
    return () => {
      live = false
      for (const off of offs.splice(0)) off()
    }
  }, [conversationId, reload])

  const running = checks.some((c) => c.state === "checking")
  useEffect(() => {
    if (!running) return
    const poll = setInterval(reload, RUNNING_POLL_MS)
    return () => clearInterval(poll)
  }, [running, reload])

  const byMessage = useMemo(() => {
    const map = new Map<string, MessageCheck[]>()
    for (const c of checks) {
      const list = map.get(c.message_fp)
      if (list) list.push(c)
      else map.set(c.message_fp, [c])
    }
    return map
  }, [checks])

  const check = useCallback(
    (ask: CheckAsk, again = false) => {
      if (!again) {
        const fp = messageFingerprint(ask.message)
        const quoteFp = ask.quote ? messageFingerprint(ask.quote) : ""
        const last = byMessage.get(fp)?.find((c) => c.quote_fp === quoteFp)
        if (last) {
          setOpenId(last.id)
          return
        }
      }
      setAsking(true)
      personalAgentCheckMessage({
        conversationId,
        message: ask.message,
        asked: ask.asked,
        quote: ask.quote,
        again,
      })
        .then((made) => {
          if (made.conversation_id !== shown.current) return
          setHeld((h) => ({
            of: made.conversation_id,
            checks: withCheck(
              h.of === made.conversation_id ? h.checks : [],
              made
            ),
          }))
          // A read on its way is older than this answer: a fresh one
          // replaces it (and brings the rest — no push need follow a
          // check answered from its last time).
          reload()
          if (made.state === "checking") {
            toast.success(t("sentNoName"))
          } else {
            setOpenId(made.id)
          }
        })
        .catch((e) =>
          toast.error(
            t("startFailed", {
              message: e instanceof Error ? e.message : String(e),
            })
          )
        )
        .finally(() => setAsking(false))
    },
    [byMessage, conversationId, reload, t]
  )

  // The conversations the checks run in, nested under this one — read only
  // where they open in the drawer, and once there is a check to open.
  const checkRows = useCheckConversations(
    openInDrawer && checks.length > 0 ? conversationId : null
  )
  const openProcess = useCallback(
    (c: MessageCheck) => {
      const id = c.check_conversation_id
      if (id == null) return
      const inTab = () =>
        followPersonalAgentLink({
          kind: "conversation",
          conversation_id: id,
          folder_id: null,
        })
      if (!openInDrawer) {
        inTab()
        return
      }
      const open = (row: DbConversationSummary) => {
        const opened = useAskConversationDrawerStore.getState().openExisting({
          kind: "check",
          parentConversationId: c.conversation_id,
          conversationId: id,
          agentType: row.agent_type,
          folderId: row.folder_id,
          workingDir:
            useAppWorkspaceStore
              .getState()
              .allFolders.find((f) => f.id === row.folder_id)?.path ?? null,
        })
        if (!opened) toast.warning(tAsk("pendingFirstMessage"))
      }
      // Nested under this conversation; or, converted into an ordinary
      // conversation, a root of the list.
      const row =
        checkRows?.find((r) => r.id === id) ??
        useAppWorkspaceStore.getState().conversations.find((r) => r.id === id)
      if (row) {
        open(row)
        return
      }
      // The list may not have come in yet.
      listCheckConversations(c.conversation_id)
        .then((rows) => {
          const found = rows.find((r) => r.id === id)
          if (found) open(found)
          else inTab()
        })
        .catch(inTab)
    },
    [checkRows, openInDrawer, tAsk]
  )

  const value = useMemo<MessageChecksValue>(
    () => ({ byMessage, check, openId, setOpenId, asking, openProcess }),
    [byMessage, check, openId, asking, openProcess]
  )
  return (
    <MessageChecksContext.Provider value={value}>
      {children}
    </MessageChecksContext.Provider>
  )
}

const VERDICT_TONE: Record<MessageCheckVerdict, string> = {
  true: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  false: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  partly:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  unsure: "border-border bg-muted/60 text-muted-foreground",
}

function short(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max)}…`
}

/** What a check came to, in words. */
function useVerdictWord(): (c: MessageCheck) => string {
  const t = useTranslations("MessageCheck")
  return useCallback(
    (c: MessageCheck) =>
      c.state === "checking"
        ? t("checking")
        : c.state === "failed" || !c.verdict
          ? t("unfinished")
          : t(`verdict.${c.verdict}`),
    [t]
  )
}

/** Why a check is unsure though it did not say so, or why it did not
 *  finish, in words. */
export function useCheckNote(): (note: string | null) => string | null {
  const t = useTranslations("MessageCheck")
  return useCallback(
    (note: string | null) => {
      if (!note) return null
      if (note.startsWith("failed:")) {
        return t("note.failed", { error: note.slice("failed:".length) || "—" })
      }
      switch (note) {
        case "no_verdict":
        case "no_evidence":
        case "restarted":
        case "stopped":
        case "taken_over":
          return t(`note.${note}`)
        default:
          return note
      }
    },
    [t]
  )
}

/**
 * The marks under a message that was checked: one for the whole message,
 * one per sentence of it — each opens what the check found.
 */
export function CheckMarks({
  text,
  askedOf,
}: {
  text: string
  /** The owner's message it answered, read when it is checked again. */
  askedOf: () => string | null
}) {
  const checks = useMessageChecks()
  const any = (checks?.byMessage.size ?? 0) > 0
  const fp = useMemo(() => (any ? messageFingerprint(text) : null), [any, text])
  const list = fp ? checks?.byMessage.get(fp) : undefined
  if (!checks || !list?.length) return null
  // The whole message first, then its sentences as they were checked.
  const ordered = [...list].sort(
    (a, b) =>
      Number(a.quote_fp !== "") - Number(b.quote_fp !== "") || a.id - b.id
  )
  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-1.5"
      data-check-marks
    >
      {ordered.map((c) => (
        <CheckMark key={c.id} check={c} text={text} askedOf={askedOf} />
      ))}
    </div>
  )
}

function CheckMark({
  check,
  text,
  askedOf,
}: {
  check: MessageCheck
  text: string
  askedOf: () => string | null
}) {
  const t = useTranslations("MessageCheck")
  const ctx = useMessageChecks()
  const word = useVerdictWord()
  const noteOf = useCheckNote()
  if (!ctx) return null
  const open = ctx.openId === check.id
  const verdict = word(check)
  const label = check.quote
    ? t("markQuote", { quote: short(check.quote, QUOTE_MARK_CHARS), verdict })
    : t("mark", { verdict })
  const tone =
    check.state === "done" && check.verdict
      ? VERDICT_TONE[check.verdict]
      : VERDICT_TONE.unsure
  const note = noteOf(check.note)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => ctx.setOpenId(next ? check.id : null)}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-check-mark={check.state === "done" ? check.verdict : check.state}
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] leading-tight transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tone
          )}
        >
          {check.state === "checking" ? (
            <SyncedSpinner small className="size-3" />
          ) : (
            <ShieldCheck className="size-3 shrink-0" aria-hidden />
          )}
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(26rem,calc(100vw-2rem))] gap-2.5 p-3"
        data-check-details={check.id}
      >
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <ShieldCheck className="size-4 shrink-0" aria-hidden />
          {verdict}
        </p>
        {check.quote ? (
          <div className="text-xs">
            <p className="text-muted-foreground">{t("checkedSentence")}</p>
            <p className="mt-0.5 break-words">{check.quote}</p>
          </div>
        ) : null}
        {check.state === "done" ? (
          <div className="text-xs">
            <p className="text-muted-foreground">{t("evidence")}</p>
            {check.evidence ? (
              <pre
                className="field-scrollbar mt-0.5 max-h-60 overflow-auto rounded-md border border-border/70 bg-background/60 p-2 font-sans text-xs leading-relaxed whitespace-pre-wrap break-words"
                data-check-evidence
              >
                {check.evidence}
              </pre>
            ) : (
              <p className="mt-0.5">{t("noEvidence")}</p>
            )}
          </div>
        ) : null}
        {note ? (
          <p className="text-xs text-muted-foreground" data-check-note>
            {note}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={check.state === "checking" || ctx.asking}
            onClick={() => {
              ctx.setOpenId(null)
              ctx.check(
                { message: text, asked: askedOf(), quote: check.quote },
                true
              )
            }}
          >
            {t("again")}
          </Button>
          {check.row_id != null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                ctx.setOpenId(null)
                followPersonalAgentLink({
                  kind: "bot",
                  bot_id: check.bot_id,
                  row_id: check.row_id,
                })
              }}
            >
              {t("inAssistant")}
            </Button>
          ) : null}
          {check.check_conversation_id != null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                ctx.setOpenId(null)
                ctx.openProcess(check)
              }}
            >
              {t("process")}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
