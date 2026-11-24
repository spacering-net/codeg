"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Link2Off } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTabActions } from "@/contexts/tab-context"
import { SessionDigestPanel } from "@/components/chat/session-digest-panel"
import {
  useDigestActions,
  useSessionBrief,
  useSessionDigest,
} from "@/hooks/use-session-digest"
import {
  listConversationCollaborators,
  setConversationCollaborator,
} from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  CONVERSATION_CHANGED_EVENT,
  type ConversationChange,
  type DbConversationSummary,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

export function SessionCollaborators({
  conversationId,
}: {
  conversationId: number
}) {
  const t = useTranslations("SessionCollaboration")
  const td = useTranslations("SessionDigest")
  const statusText = useTranslations("Folder.statusLabels")
  const { openTab } = useTabActions()
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const { digest, refresh } = useSessionDigest(conversationId)
  const { answer, dismiss, canAnswer } = useDigestActions(
    conversationId,
    digest,
    refresh
  )
  const brief = useSessionBrief(conversationId)
  const [rows, setRows] = useState<DbConversationSummary[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [target, setTarget] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let disposed = false
    let request = 0
    const known = new Set<number>()
    const refresh = async () => {
      const revision = ++request
      try {
        const next = await listConversationCollaborators(conversationId)
        if (disposed || revision !== request) return
        known.clear()
        for (const row of next) known.add(row.id)
        setRows(next)
      } catch {
        if (!disposed && revision === request) setError(true)
      }
    }
    const memberships = subscribe<number>("collaboration://changed", (id) => {
      if (id === conversationId) void refresh()
    })
    const changes = subscribe<ConversationChange>(
      CONVERSATION_CHANGED_EVENT,
      (event) => {
        if (
          event.kind === "upsert" &&
          (event.summary.parent_id === conversationId ||
            known.has(event.summary.id))
        ) {
          void refresh()
        } else if (event.kind === "deleted" && known.has(event.id)) {
          void refresh()
        }
      }
    )
    const reconnect = onTransportReconnect(() => void refresh())
    void refresh()
    return () => {
      disposed = true
      void memberships.then((off) => off())
      void changes.then((off) => off())
      reconnect?.()
    }
  }, [conversationId, version])

  const choices = conversations.filter(
    (row) =>
      row.id !== conversationId &&
      row.parent_id == null &&
      !rows.some((related) => related.id === row.id)
  )

  const update = async (id: number, linked: boolean) => {
    setBusy(true)
    setError(false)
    try {
      await setConversationCollaborator(conversationId, id, linked)
      setTarget("")
      setPickerOpen(false)
      setVersion((old) => old + 1)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="min-w-0 rounded-lg border border-border p-3">
      <h3 className="font-medium">{t("progress")}</h3>
      {digest && (
        <div className="-mx-3">
          <h4 className="px-3 text-xs text-muted-foreground">{td("title")}</h4>
          <SessionDigestPanel
            digest={digest}
            disabled={!canAnswer}
            onAnswer={answer}
            onDismiss={dismiss}
          />
        </div>
      )}
      {brief?.text && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t("brief")}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
            {brief.text}
          </pre>
        </details>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <h4 className="text-xs text-muted-foreground">{t("title")}</h4>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setPickerOpen(!pickerOpen)}
          aria-expanded={pickerOpen}
        >
          {t("link")}
        </Button>
      </div>
      {pickerOpen && (
        <div className="my-2 flex gap-2">
          <select
            aria-label={t("choose")}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">{t("choose")}</option>
            {choices.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title || `#${row.id}`}
              </option>
            ))}
          </select>
          <Button
            size="xs"
            disabled={!target || busy}
            onClick={() => void update(Number(target), true)}
          >
            {t("link")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="my-2 text-xs text-destructive">
          {t("error")}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  openTab(
                    row.folder_id,
                    row.id,
                    row.agent_type,
                    true,
                    row.title ?? undefined
                  )
                }
              >
                <span
                  className="truncate text-xs"
                  title={row.title ?? undefined}
                >
                  {row.title || `#${row.id}`}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {row.status === "in_progress" ||
                  row.status === "pending_review" ||
                  row.status === "completed" ||
                  row.status === "cancelled"
                    ? statusText(row.status)
                    : row.status}
                </span>
              </button>
              {row.parent_id == null && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  title={t("unlink")}
                  aria-label={t("unlink")}
                  onClick={() => void update(row.id, false)}
                >
                  <Link2Off />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
