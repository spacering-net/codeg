"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  getChatEventFilter,
  getChatEventTopLevelOnly,
  getChatEventWebhooks,
  setChatEventFilter,
  setChatEventTopLevelOnly,
  setChatEventWebhooks,
} from "@/lib/api"
import type { WebhookConfig } from "@/lib/types"

const ALL_EVENT_TYPES = [
  {
    id: "user_prompt_sent",
    labelKey: "userPromptSent",
    descKey: "userPromptSentDesc",
  },
  {
    id: "turn_complete",
    labelKey: "turnComplete",
    descKey: "turnCompleteDesc",
  },
  { id: "error", labelKey: "error", descKey: "errorDesc" },
  {
    id: "permission_request",
    labelKey: "permissionRequest",
    descKey: "permissionRequestDesc",
  },
  {
    id: "question_request",
    labelKey: "questionRequest",
    descKey: "questionRequestDesc",
  },
] as const

const ALL_IDS = ALL_EVENT_TYPES.map((e) => e.id)

// Events that export user-authored content (the prompt text itself) to external
// sinks — IM channels, webhooks, the outbound message log. They are OFF in the
// default ("all events") filter: a null/absent filter does NOT include them, so
// an existing install does not begin forwarding prompt text after upgrade. The
// user must enable them deliberately, which persists an explicit filter list.
// Mirrors the backend `DEFAULT_OFF_EVENTS` (chat_channel/event_subscriber.rs).
const DEFAULT_OFF_IDS = new Set<string>(["user_prompt_sent"])
const DEFAULT_ON_IDS = ALL_IDS.filter((id) => !DEFAULT_OFF_IDS.has(id))

function parseFilter(arr: string[] | null): Set<string> {
  // null = the default set (everything EXCEPT the opt-in events).
  if (!arr) return new Set(DEFAULT_ON_IDS)
  return new Set(arr)
}

/** True when `url` is a non-empty http(s) URL. Pure — unit tested. */
export function isValidWebhookUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

// Example payloads documenting the wire contract. Kept as literal JSON (not
// translated) so consumers see the exact field names they receive. The
// permission_request example is a delegation sub-session (`session_kind:
// "sub_session"`, naming its parent); the others are top-level sessions.
const PAYLOAD_EXAMPLES: Record<(typeof ALL_EVENT_TYPES)[number]["id"], string> =
  {
    user_prompt_sent: `{
  "event": "user_prompt_sent",
  "level": "info",
  "title": "User Message",
  "body": "Please refactor the auth module",
  "fields": [],
  "connection_id": "conn-abc",
  "conversation_id": 12,
  "conversation_title": "Refactor the auth module",
  "agent_type": "claude_code",
  "agent_name": "Claude Code",
  "assistant_name": null,
  "session_kind": "session",
  "parent_conversation_id": null,
  "parent_conversation_title": null,
  "source": "codeg"
}`,
    turn_complete: `{
  "event": "turn_complete",
  "level": "info",
  "title": "Turn Complete",
  "body": "Claude Code finished its turn.",
  "fields": [{ "label": "Stop Reason", "value": "End Turn" }],
  "connection_id": "conn-abc",
  "conversation_id": 12,
  "conversation_title": "Refactor the auth module",
  "agent_type": "claude_code",
  "agent_name": "Claude Code",
  "assistant_name": null,
  "session_kind": "session",
  "parent_conversation_id": null,
  "parent_conversation_title": null,
  "source": "codeg"
}`,
    error: `{
  "event": "error",
  "level": "error",
  "title": "Agent Error",
  "body": "Claude Code encountered an error.",
  "fields": [{ "label": "Error", "value": "connection reset" }],
  "connection_id": "conn-abc",
  "conversation_id": 12,
  "conversation_title": "Refactor the auth module",
  "agent_type": "claude_code",
  "agent_name": "Claude Code",
  "assistant_name": null,
  "session_kind": "session",
  "parent_conversation_id": null,
  "parent_conversation_title": null,
  "source": "codeg"
}`,
    permission_request: `{
  "event": "permission_request",
  "level": "warning",
  "title": "Permission Request",
  "body": "An agent is waiting for approval.",
  "fields": [{ "label": "Operation", "value": "Bash: npm test" }],
  "connection_id": "conn-def",
  "conversation_id": 15,
  "conversation_title": "Run the test suite",
  "agent_type": "codex",
  "agent_name": "Codex CLI",
  "assistant_name": "Tester",
  "session_kind": "sub_session",
  "parent_conversation_id": 12,
  "parent_conversation_title": "Refactor the auth module",
  "source": "codeg"
}`,
    question_request: `{
  "event": "question_request",
  "level": "warning",
  "title": "Agent Question",
  "body": "An agent is asking a question. Answer it in Codeg.",
  "fields": [{ "label": "Approach", "value": "Which approach should we take?\\n• MVP first\\n• Risk first" }],
  "connection_id": "conn-abc",
  "conversation_id": 12,
  "conversation_title": "Refactor the auth module",
  "agent_type": "claude_code",
  "agent_name": "Claude Code",
  "assistant_name": null,
  "session_kind": "session",
  "parent_conversation_id": null,
  "parent_conversation_title": null,
  "source": "codeg"
}`,
  }

export function ChannelEventsTab() {
  const t = useTranslations("ChatChannelSettings.events")
  const ime = useImeGuard()
  const [enabledEvents, setEnabledEvents] = useState<Set<string>>(
    new Set(DEFAULT_ON_IDS)
  )
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([])
  const [topLevelOnly, setTopLevelOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  // True when the initial config fetch failed. We then refuse to render the
  // controls and surface a retry instead — saving from the still-default state
  // would persist a stale snapshot and clobber the real (unread) config, e.g.
  // overwrite the stored event filter or drop existing webhooks.
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState("webhooks")

  // Add/edit dialog state. `editingIndex === null` means "adding".
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [draftUrl, setDraftUrl] = useState("")
  // Delete-confirmation state. `null` means the confirm dialog is closed.
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)
  // One write is in flight. Every webhook mutation replaces the whole list, so
  // all webhook controls are disabled while a save is pending — this serializes
  // mutations and prevents a stale full-list payload from clobbering another.
  // `savingRef` is the synchronous source of truth (state lags a render, so it
  // alone can't block a re-entrant call e.g. Enter in the dialog mid-save).
  const [webhooksSaving, setWebhooksSaving] = useState(false)
  const savingRef = useRef(false)

  const loadConfig = useCallback(() => {
    setLoading(true)
    setLoadError(false)
    Promise.all([
      getChatEventFilter(),
      getChatEventWebhooks(),
      getChatEventTopLevelOnly(),
    ])
      .then(([filter, hooks, topLevel]) => {
        setEnabledEvents(parseFilter(filter))
        setWebhooks(hooks)
        setTopLevelOnly(topLevel)
        setLoadError(false)
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  const handleToggle = useCallback(
    async (eventId: string, checked: boolean) => {
      setSaving(true)
      try {
        const next = new Set(enabledEvents)
        if (checked) {
          next.add(eventId)
        } else {
          next.delete(eventId)
        }
        // Collapse to the null "default" sentinel ONLY when the selection is
        // exactly the default-on set. Any other selection (an opt-in event
        // enabled, or a default-on event disabled) must persist as an explicit
        // list so it round-trips — null would otherwise re-exclude opt-in
        // events on reload (see backend DEFAULT_OFF_EVENTS).
        const isDefault =
          next.size === DEFAULT_ON_IDS.length &&
          DEFAULT_ON_IDS.every((id) => next.has(id))
        await setChatEventFilter(isDefault ? null : [...next])
        setEnabledEvents(next)
        toast.success(t("saved"))
      } catch {
        toast.error(t("saveFailed"))
      } finally {
        setSaving(false)
      }
    },
    [enabledEvents, t]
  )

  const handleTopLevelOnly = useCallback(
    async (checked: boolean) => {
      setSaving(true)
      try {
        await setChatEventTopLevelOnly(checked)
        setTopLevelOnly(checked)
        toast.success(t("saved"))
      } catch {
        toast.error(t("saveFailed"))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  // Persist the full webhook list. State is updated only on success, so a
  // failed write leaves the UI (including switches) showing the prior value.
  const persistWebhooks = useCallback(
    async (next: WebhookConfig[]): Promise<boolean> => {
      // Re-entrancy guard: ignore a second mutation while one is in flight, so
      // it can't issue a save from a stale full-list snapshot.
      if (savingRef.current) return false
      savingRef.current = true
      setWebhooksSaving(true)
      try {
        await setChatEventWebhooks(next)
        setWebhooks(next)
        toast.success(t("webhooksSaved"))
        return true
      } catch {
        toast.error(t("webhooksSaveFailed"))
        return false
      } finally {
        savingRef.current = false
        setWebhooksSaving(false)
      }
    },
    [t]
  )

  const handleToggleEnabled = useCallback(
    (index: number, enabled: boolean) => {
      const next = webhooks.map((w, i) => (i === index ? { ...w, enabled } : w))
      void persistWebhooks(next)
    },
    [webhooks, persistWebhooks]
  )

  const confirmDelete = useCallback(() => {
    // Index identity is stable for every non-delete mutation (all are in-place
    // or append), and only one confirm dialog is open at a time; still
    // bounds-guard so a stale index can never drop the wrong row.
    if (deleteIndex === null || deleteIndex >= webhooks.length) {
      setDeleteIndex(null)
      return
    }
    void persistWebhooks(webhooks.filter((_, i) => i !== deleteIndex))
    setDeleteIndex(null)
  }, [deleteIndex, webhooks, persistWebhooks])

  const openAddDialog = useCallback(() => {
    setEditingIndex(null)
    setDraftUrl("")
    setDialogOpen(true)
  }, [])

  const openEditDialog = useCallback(
    (index: number) => {
      setEditingIndex(index)
      setDraftUrl(webhooks[index].url)
      setDialogOpen(true)
    },
    [webhooks]
  )

  const handleDialogSave = useCallback(async () => {
    const url = draftUrl.trim()
    if (!isValidWebhookUrl(url)) {
      toast.error(t("webhookInvalidUrl"))
      return
    }
    // Defensive: an edit index could be stale if the list changed underneath;
    // bail rather than rewrite the wrong row.
    if (editingIndex !== null && editingIndex >= webhooks.length) {
      setDialogOpen(false)
      return
    }
    const duplicate = webhooks.some(
      (w, i) => w.url === url && i !== editingIndex
    )
    if (duplicate) {
      toast.error(t("webhookDuplicate"))
      return
    }
    const next =
      editingIndex === null
        ? [...webhooks, { url, enabled: true }]
        : webhooks.map((w, i) => (i === editingIndex ? { ...w, url } : w))
    const ok = await persistWebhooks(next)
    if (ok) setDialogOpen(false)
  }, [draftUrl, webhooks, editingIndex, persistWebhooks, t])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{t("loadFailed")}</p>
        <Button type="button" variant="outline" size="sm" onClick={loadConfig}>
          {t("retry")}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      <section className="space-y-1">
        {ALL_EVENT_TYPES.map((evt) => (
          <div
            key={evt.id}
            className="flex items-center justify-between rounded-lg border bg-card px-4 py-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{t(evt.labelKey)}</div>
              <div className="text-xs text-muted-foreground">
                {t(evt.descKey)}
              </div>
            </div>
            <Switch
              checked={enabledEvents.has(evt.id)}
              disabled={saving}
              aria-label={t(evt.labelKey)}
              onCheckedChange={(checked) => handleToggle(evt.id, checked)}
            />
          </div>
        ))}
      </section>

      <div className="flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("topLevelOnly")}</div>
          <div className="text-xs text-muted-foreground">
            {t("topLevelOnlyDesc")}
          </div>
        </div>
        <Switch
          checked={topLevelOnly}
          disabled={saving}
          aria-label={t("topLevelOnly")}
          onCheckedChange={handleTopLevelOnly}
        />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div className="flex items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="webhooks">{t("webhooksTitle")}</TabsTrigger>
            <TabsTrigger value="format">{t("docsTitle")}</TabsTrigger>
          </TabsList>
          {activeTab === "webhooks" && (
            <Button
              type="button"
              size="sm"
              disabled={webhooksSaving}
              onClick={openAddDialog}
            >
              <Plus className="h-4 w-4" />
              {t("addWebhook")}
            </Button>
          )}
        </div>

        <TabsContent value="webhooks" className="space-y-3 pt-2">
          <p className="text-xs text-muted-foreground">
            {t("webhooksDescription")}
          </p>

          {webhooks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("webhooksEmpty")}
            </p>
          ) : (
            <div className="space-y-2">
              {webhooks.map((w, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    title={w.url}
                  >
                    {w.url}
                  </span>
                  <Switch
                    checked={w.enabled}
                    disabled={webhooksSaving}
                    aria-label={t("enableWebhook")}
                    onCheckedChange={(checked) =>
                      handleToggleEnabled(index, checked)
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={webhooksSaving}
                    aria-label={t("editWebhook")}
                    onClick={() => openEditDialog(index)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={webhooksSaving}
                    aria-label={t("removeWebhook")}
                    onClick={() => setDeleteIndex(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="format" className="space-y-3 pt-2">
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>
              <span className="font-medium text-foreground">
                {t("docsMethod")}:
              </span>{" "}
              <code className="rounded bg-muted px-1 py-0.5">POST</code>
            </div>
            <div>
              <span className="font-medium text-foreground">
                {t("docsContentType")}:
              </span>{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                application/json
              </code>
            </div>
            <p>{t("docsNote")}</p>
          </div>

          <div className="space-y-3">
            {ALL_EVENT_TYPES.map((evt) => (
              <div key={evt.id} className="space-y-1">
                <div className="text-xs font-medium">{t(evt.labelKey)}</div>
                <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3 text-xs">
                  <code>{PAYLOAD_EXAMPLES[evt.id]}</code>
                </pre>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingIndex === null ? t("addWebhook") : t("editWebhook")}
            </DialogTitle>
            <DialogDescription>{t("webhooksDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            value={draftUrl}
            placeholder={t("webhookUrlPlaceholder")}
            disabled={webhooksSaving}
            onChange={(e) => setDraftUrl(e.target.value)}
            {...ime.props}
            onKeyDown={(e) => {
              if (ime.isComposing(e)) return
              if (e.key === "Enter") {
                e.preventDefault()
                void handleDialogSave()
              }
            }}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              disabled={webhooksSaving}
              onClick={handleDialogSave}
            >
              {webhooksSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("webhookSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteIndex !== null}
        onOpenChange={(open) => !open && setDeleteIndex(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteWebhookTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteWebhookMessage")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
