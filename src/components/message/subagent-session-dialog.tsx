"use client"

/**
 * Read-only viewer for a sub-agent that ran as a session of its own.
 *
 * Grok is the case this exists for: `spawn_subagent` starts a FULL, standalone
 * session (its own directory, its own `updates.jsonl`, `session_kind:
 * "subagent"` in `summary.json`) and forwards none of the child's chunks or
 * tool calls over ACP. So there is nothing to stream into the parent
 * transcript — but the child writes its transcript to disk as it works, and
 * `get_conversation` parses any session by its native id (the sidebar hides
 * sub-agent sessions in `build_summary`; direct opens still resolve). Reading
 * that file on a timer is therefore a real live view of a running child, and
 * the same call serves a finished one.
 *
 * Deliberately NOT `LiveTranscriptView`/`MessageListView`: those are bound to a
 * codeg conversation row and a live ACP connection, and a grok sub-agent has
 * neither. This renders the parsed turns directly with the shared
 * `ContentPartsRenderer`, which is what the main thread uses for each turn's
 * body anyway.
 *
 * Chrome-wise it is the same side drawer as the other two session viewers:
 * non-modal (the parent thread stays live behind it — this one keeps polling
 * a running child, so watching both at once is the point), no pointer
 * dismissal, and stackable when the card it opens from is itself inside a
 * drawer.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

import { AgentIcon } from "@/components/agent-icon"
import { ContentPartsRenderer } from "@/components/message/content-parts-renderer"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  SIDE_PANEL_CONTENT_CLASS,
} from "@/components/ui/drawer"
import {
  adaptMessageTurns,
  type AdaptedMessage,
} from "@/lib/adapters/ai-elements-adapter"
import { getConversation } from "@/lib/api"
import { usePageHandoffName } from "@/lib/browser/use-page-handoff-name"
import { toolStatusUnsettled } from "@/lib/tool-call-lifecycle"
import type { AgentType, MessageTurn } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Re-parse cadence while the parent card says the child is still working. The
 *  child appends to its transcript continuously; this is cheap (one file parse)
 *  and stops the moment the card settles or the dialog closes. */
const LIVE_REFRESH_MS = 2000

/**
 * Calls the transcript itself says are still working, per turn index.
 *
 * Reading a RUNNING session's file is exactly the case the adapter's "a
 * `tool_use` with no `tool_result` means the conversation ended, so it
 * completed" rule gets wrong — and here it doesn't even apply: the grok parser
 * pairs every call with a placeholder result and backfills it, so an unfinished
 * call arrives MATCHED and lands in the settled branch. The parser's own
 * `status` is the only honest signal, and it is used affirmatively: absent (any
 * other agent) or already terminal leaves the call exactly where it was.
 *
 * Gated on `live` by the caller — a child that was interrupted keeps whatever
 * status it was last given, so once the parent card settles the transcript's
 * stale `in_progress` must stop producing a spinner nothing will ever clear.
 */
function inProgressToolCallsByTurn(
  turns: MessageTurn[]
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>()
  turns.forEach((turn, i) => {
    const pending = new Set<string>()
    for (const block of turn.blocks) {
      if (
        block.type === "tool_use" &&
        block.tool_use_id &&
        toolStatusUnsettled(block.status)
      ) {
        pending.add(block.tool_use_id)
      }
    }
    if (pending.size > 0) out.set(i, pending)
  })
  return out
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The child's native session id (`agent_stats.child_session_id`, or the live
   *  `meta.grokSubagentSession.childSessionId`). */
  sessionId: string
  agentType: AgentType
  /** The sub-agent's declared type ("general-purpose", "explore", …) — the
   *  dialog's subtitle, since a child session has no user-set title. */
  subagentType?: string | null
  /** The parent's `description` argument: what this child was asked to do. */
  description?: string | null
  /** Keep re-reading the transcript while true (the child is still running). */
  live?: boolean
}

export function SubagentSessionDialog({
  open,
  onOpenChange,
  sessionId,
  agentType,
  subagentType,
  description,
  live = false,
}: Props) {
  const t = useTranslations("Folder.chat.contentParts")
  const sharedT = useTranslations("Folder.chat.shared")
  const pageHandoffName = usePageHandoffName()
  const [messages, setMessages] = useState<AdaptedMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the FIRST load blanks the body: a refresh that lands mid-read must not
  // flash the transcript away and bounce the scroll position.
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(true)
  // A child session large enough to parse slower than the refresh cadence would
  // otherwise stack reads: ticks would queue behind each other and an older
  // parse landing after a newer one would rewind the transcript on screen. So a
  // tick is skipped while a read is outstanding, and any read whose sequence
  // has been superseded drops its result instead of applying it.
  const inFlightRef = useRef(false)
  const seqRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(
    async (initial: boolean) => {
      // An open is user-initiated and always runs; only the timer defers.
      if (!initial && inFlightRef.current) return
      const seq = ++seqRef.current
      inFlightRef.current = true
      if (initial) setLoading(true)
      try {
        const detail = await getConversation(agentType, sessionId)
        if (!mountedRef.current || seq !== seqRef.current) return
        setMessages(
          adaptMessageTurns(
            detail.turns,
            {
              attachedResources: sharedT("attachedResources"),
              toolCallFailed: sharedT("toolCallFailed"),
              pageHandoffName,
            },
            undefined,
            live ? inProgressToolCallsByTurn(detail.turns) : undefined
          )
        )
        setError(null)
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return
        // A refresh failing after a good read (the child rewrote the file
        // mid-parse) keeps the last transcript rather than replacing it with an
        // error — the next tick will very likely succeed.
        if (initial) setError(err instanceof Error ? err.message : String(err))
      } finally {
        // Only the newest read owns the gate: an older one finishing later must
        // not reopen it while its successor is still outstanding.
        if (seq === seqRef.current) inFlightRef.current = false
        if (mountedRef.current && initial) setLoading(false)
      }
    },
    [agentType, sessionId, sharedT, pageHandoffName, live]
  )

  useEffect(() => {
    if (!open) return
    void load(true)
  }, [open, load])

  useEffect(() => {
    if (!open || !live) return
    const timer = window.setInterval(() => void load(false), LIVE_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [open, live, load])

  const subtitle = [subagentType, description].filter(Boolean).join(" · ")

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent
        closeButtonClassName="top-2.5 right-3"
        className={SIDE_PANEL_CONTENT_CLASS}
      >
        <DrawerTitle className="sr-only">{t("agentSessionTitle")}</DrawerTitle>
        <DrawerDescription className="sr-only">
          {t("agentSessionTitle")}
        </DrawerDescription>

        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 pr-12">
          <AgentIcon agentType={agentType} className="size-4 shrink-0" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">
              {t("agentSessionTitle")}
            </span>
            {subtitle ? (
              <span className="truncate text-xs text-muted-foreground">
                {subtitle}
              </span>
            ) : null}
          </div>
          {live ? (
            <Loader2
              aria-hidden
              className="ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground"
            />
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loading && messages == null ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 size-3.5 animate-spin" />
              {t("agentSessionLoading")}
            </div>
          ) : error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : messages && messages.length > 0 ? (
            <div className="flex flex-col gap-4">
              {messages.map((message, i) => (
                <div
                  key={`${message.id ?? "turn"}-${i}`}
                  className={cn(
                    "flex flex-col gap-2",
                    // The kickoff prompt (and any later user turn) reads as an
                    // aside — the child's own work is the content here.
                    message.role === "user" &&
                      "rounded-lg bg-muted/50 px-3 py-2 text-sm"
                  )}
                >
                  <ContentPartsRenderer
                    parts={message.content}
                    role={message.role}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("agentSessionEmpty")}
            </p>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
