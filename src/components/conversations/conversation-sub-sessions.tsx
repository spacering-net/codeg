"use client"

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { Loader2, MessagesSquare } from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { StatusBadge } from "@/components/message/delegation-status-badge"
import { SubAgentSessionDialog } from "@/components/message/sub-agent-session-dialog"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useConnectionStore } from "@/contexts/acp-connections-context"
import { useDelegation } from "@/contexts/delegation-context"
import { useConversationSubSessions } from "@/hooks/use-conversation-sub-sessions"
import {
  compareByChildCreatedAtDesc,
  subsessionPriority,
  subsessionStatus,
} from "@/lib/conversation-children"
import { formatConversationTitle } from "@/lib/conversation-title"
import { getAgentLabel } from "@/lib/custom-agents"
import type { DbConversationSummary } from "@/lib/types"

export function ConversationSubSessions({
  conversationId,
  childCount,
}: {
  conversationId: number
  childCount: number
}) {
  const t = useTranslations("Folder.chat.subsessions")
  const { children, loading, error, reload } =
    useConversationSubSessions(conversationId)
  const { findByChildConversationId } = useDelegation()
  const store = useConnectionStore()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<DbConversationSummary | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const bindings = useMemo(
    () => children.map((child) => findByChildConversationId(child.id)),
    [children, findByChildConversationId]
  )
  const connectionIds = useMemo(
    () =>
      bindings.flatMap((binding) =>
        binding?.status === "running" ? [binding.childConnectionId] : []
      ),
    [bindings]
  )
  const subscribe = useCallback(
    (callback: () => void) => {
      const dispose = connectionIds.map((id) =>
        store.subscribeKey(id, callback)
      )
      return () => dispose.forEach((off) => off())
    },
    [connectionIds, store]
  )
  // Only blocking state affects this menu; token streaming should not repaint it.
  const getBlocked = useCallback(
    () =>
      connectionIds
        .filter((id) => {
          const conn = store.getConnection(id)
          return Boolean(
            conn?.pendingPermission ||
            conn?.pendingQuestion ||
            conn?.pendingPlanApproval
          )
        })
        .join("\n"),
    [connectionIds, store]
  )
  const blocked = useSyncExternalStore(subscribe, getBlocked, getBlocked)
  const entries = useMemo(() => {
    const blockedIds = new Set(blocked.split("\n"))
    return children
      .map((child, i) => {
        const binding = bindings[i]
        return {
          child,
          binding,
          status: subsessionStatus(
            child,
            binding,
            binding != null && blockedIds.has(binding.childConnectionId)
          ),
        }
      })
      .sort(
        (a, b) =>
          subsessionPriority(a.status) - subsessionPriority(b.status) ||
          compareByChildCreatedAtDesc(a.child, b.child)
      )
  }, [children, bindings, blocked])

  const count =
    loading || error ? Math.max(childCount, children.length) : children.length
  const selectedBinding = selected
    ? findByChildConversationId(selected.id)
    : undefined
  if (count === 0 && !open) return null

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            variant="outline"
            size="xs"
            className="h-7"
            aria-label={t("trigger", { count })}
            title={t("trigger", { count })}
            data-testid="conversation-sub-sessions-trigger"
          >
            <MessagesSquare data-icon="inline-start" />
            <span className="hidden sm:inline">{t("trigger", { count })}</span>
            <span className="sm:hidden">{count}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label={t("title")}
          className="w-96 max-w-[calc(100vw-2rem)] gap-2 p-3"
          onCloseAutoFocus={(event) => {
            if (selected) event.preventDefault()
          }}
        >
          <PopoverHeader>
            <PopoverTitle>{t("title")}</PopoverTitle>
          </PopoverHeader>
          {loading ? (
            <p className="flex items-center gap-2 py-3 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("loading")}
            </p>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 py-2"
            >
              <span>{t("loadError")}</span>
              <Button variant="outline" size="xs" onClick={reload}>
                {t("retry")}
              </Button>
            </div>
          ) : null}
          {!loading && !error && entries.length === 0 ? (
            <p>{t("empty")}</p>
          ) : null}
          <ul className="flex max-h-[min(24rem,60vh)] flex-col overflow-y-auto">
            {entries.map(({ child, binding, status }) => {
              const agent = getAgentLabel(child.agent_type)
              const title =
                formatConversationTitle(child.title ?? "") || t("untitled")
              return (
                <li key={child.id}>
                  <Button
                    variant="ghost"
                    className="h-auto w-full justify-start gap-3 rounded-lg px-2 py-2.5"
                    aria-label={t("viewSession", { agent, title })}
                    onClick={() => {
                      setOpen(false)
                      setSelected(child)
                    }}
                    data-sub-session-id={child.id}
                  >
                    <AgentIcon
                      agentType={child.agent_type}
                      className="size-5 shrink-0"
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1 text-start">
                      <span className="flex flex-wrap items-center gap-2">
                        <span>{agent}</span>
                        <StatusBadge
                          status={status}
                          errorCode={binding?.errorCode}
                        />
                      </span>
                      <span
                        className="line-clamp-2 whitespace-normal text-xs text-muted-foreground"
                        title={title}
                      >
                        {title}
                      </span>
                    </span>
                    <span className="shrink-0 text-primary">{t("view")}</span>
                  </Button>
                </li>
              )
            })}
          </ul>
        </PopoverContent>
      </Popover>
      {selected ? (
        <SubAgentSessionDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setSelected(null)
              requestAnimationFrame(() => triggerRef.current?.focus())
            }
          }}
          childConversationId={selected.id}
          childConnectionId={
            selectedBinding?.status === "running"
              ? selectedBinding.childConnectionId
              : null
          }
          agentType={selected.agent_type}
          kickoffTask={selected.title}
        />
      ) : null}
    </>
  )
}
