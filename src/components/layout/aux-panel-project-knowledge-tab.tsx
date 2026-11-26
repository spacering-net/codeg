"use client"

import { useEffect, useState } from "react"
import {
  ArrowLeft,
  FileText,
  MessageSquarePlus,
  NotebookPen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import { getTransport } from "@/lib/transport"
import { emitAttachReferenceToSession } from "@/lib/session-attachment-events"
import { MessageResponse } from "@/components/ai-elements/message"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

import { AuxPanelSearchToolbar } from "./aux-panel-search-toolbar"
import { GIT_TOOLBAR_ICON_BUTTON_CLASS } from "./git-toolbar-controls"

type Kind = "notes" | "plans"

export type ProjectKnowledgeEntry = {
  id: string
  title: string
  body: string
  updatedAt: string
}

type Summary = Omit<ProjectKnowledgeEntry, "body">

export function ProjectKnowledgeTab({
  projectKey,
  sessionTabId,
}: {
  projectKey: string
  sessionTabId?: string
}) {
  return (
    <ProjectKnowledgePanel
      key={projectKey}
      folderId={Number(projectKey)}
      sessionTabId={sessionTabId}
    />
  )
}

function knowledge<T>(
  folderId: number,
  kind: Kind,
  request: Record<string, unknown>
) {
  return getTransport().call<T>("project_knowledge", {
    folderId,
    request: { ...request, kind: kind === "notes" ? "note" : "plan" },
  })
}

function ProjectKnowledgePanel({
  folderId,
  sessionTabId,
}: {
  folderId: number
  sessionTabId?: string
}) {
  const t = useTranslations("ProjectKnowledge")
  const tChat = useTranslations("Folder.fileWorkspacePanel")
  const tSession = useTranslations("Folder.sessionDetails")
  const format = useFormatter()
  const [kind, setKind] = useState<Kind>("notes")
  const [query, setQuery] = useState("")
  const keyword = query.trim()
  const [entries, setEntries] = useState<Summary[]>([])
  const [revision, setRevision] = useState(0)
  const [current, setCurrent] = useState<ProjectKnowledgeEntry>()
  const [draft, setDraft] = useState<string>()
  const [editorTab, setEditorTab] = useState("markdown")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [busy, setBusy] = useState(false)
  const title = (entry: Summary) => entry.title || t("untitled")
  const EntryIcon = kind === "notes" ? NotebookPen : FileText

  useEffect(() => {
    if (current || draft !== undefined) return
    let cancelled = false
    async function list() {
      const items: Summary[] = []
      let offset: number | null = 0
      do {
        const page: { entries: Summary[]; nextOffset: number | null } =
          await knowledge(folderId, kind, {
            action: "list",
            query: keyword,
            offset,
          })
        if (cancelled) return
        items.push(...page.entries)
        offset = page.nextOffset
      } while (offset !== null)
      setEntries(items)
      setSaveError(false)
    }
    void list().catch(() => {
      if (!cancelled) setSaveError(true)
    })
    return () => {
      cancelled = true
    }
  }, [folderId, kind, keyword, revision, current, draft])

  function closeEntry() {
    setCurrent(undefined)
    setDraft(undefined)
    setSaveError(false)
  }

  async function mutate(
    request: Record<string, unknown>,
    apply: (value: ProjectKnowledgeEntry) => void
  ) {
    setBusy(true)
    setSaveError(false)
    try {
      apply(await knowledge<ProjectKnowledgeEntry>(folderId, kind, request))
    } catch {
      setSaveError(true)
    } finally {
      setBusy(false)
    }
  }

  function newEntry() {
    setDraft("")
    setEditorTab("markdown")
  }

  function saveEntry() {
    if (!draft?.trim() || busy) return
    void mutate(
      { action: "save", id: current?.id, expected: current?.body, body: draft },
      (value) => {
        setDraft(undefined)
        setCurrent(value)
        setQuery("")
      }
    )
  }

  function addToSession(entry: Summary) {
    if (!sessionTabId) return
    const label = title(entry)
    const referenceKind = kind === "notes" ? "note" : "plan"
    const accepted = emitAttachReferenceToSession({
      tabId: sessionTabId,
      label,
      uri: "codeg://knowledge/" + referenceKind + "/" + entry.id,
    })
    if (accepted) {
      toast(tChat("addFileToChatDone", { label }))
    } else {
      toast.error(tSession("noActiveSession"))
    }
  }

  const newEntryLabel = t(kind === "notes" ? "newNote" : "newPlan")

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col text-sm">
      {draft !== undefined || current ? (
        <>
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 px-2">
            <Button
              variant="ghost"
              size="icon"
              className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
              disabled={busy}
              onClick={closeEntry}
              aria-label={t("back")}
              title={t("back")}
            >
              <ArrowLeft className="size-3.5" aria-hidden />
            </Button>
            <h3
              className="min-w-0 flex-1 truncate pe-1 text-[0.8125rem] font-medium"
              title={current ? title(current) : undefined}
            >
              {draft !== undefined
                ? current
                  ? t("edit")
                  : t(kind === "notes" ? "newNote" : "newPlan")
                : current && title(current)}
            </h3>
            {draft !== undefined ? (
              <Button
                size="sm"
                disabled={busy || !draft.trim()}
                onClick={saveEntry}
              >
                {t("save")}
              </Button>
            ) : current ? (
              <>
                {sessionTabId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
                    title={tChat("addToChat")}
                    aria-label={tChat("addToChat")}
                    onClick={() => addToSession(current)}
                    disabled={busy}
                  >
                    <MessageSquarePlus className="size-3.5" aria-hidden />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
                  title={t("edit")}
                  aria-label={t("edit")}
                  disabled={busy}
                  onClick={() => {
                    setDraft(current.body)
                    setEditorTab("markdown")
                  }}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
                  title={t("delete")}
                  aria-label={t("delete")}
                  disabled={busy}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </>
            ) : null}
          </div>
          {draft !== undefined ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
              {kind === "plans" ? (
                <>
                  <Tabs
                    value={editorTab}
                    onValueChange={setEditorTab}
                    className="min-h-0 flex-1"
                  >
                    <TabsList className="shrink-0">
                      <TabsTrigger value="markdown" className="text-xs">
                        Markdown
                      </TabsTrigger>
                      <TabsTrigger value="preview" className="text-xs">
                        {t("preview")}
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent
                      value="markdown"
                      className="flex min-h-0 flex-col"
                    >
                      <Textarea
                        aria-label={t("planBody")}
                        placeholder={t("planBody")}
                        className="min-h-40 flex-1 resize-none font-mono text-xs"
                        value={draft}
                        disabled={busy}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                    </TabsContent>
                    <TabsContent
                      value="preview"
                      className="overflow-auto select-text"
                    >
                      <MessageResponse
                        mode="static"
                        className="plan-markdown [&_ol]:ps-5! [&_ul]:ps-5!"
                      >
                        {draft}
                      </MessageResponse>
                    </TabsContent>
                  </Tabs>
                </>
              ) : (
                <Textarea
                  aria-label={t("noteBody")}
                  placeholder={t("noteBody")}
                  className="min-h-36 resize-y"
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
              )}
            </div>
          ) : (
            current && (
              <div className="min-h-0 flex-1 overflow-auto px-3 py-2 select-text [scrollbar-width:thin]">
                <MessageResponse
                  mode="static"
                  className="plan-markdown [&_ol]:ps-5! [&_ul]:ps-5!"
                >
                  {kind === "plans"
                    ? current.body.replace(
                        /^(?:[ \t]*\r?\n)* {0,3}# [^\r\n]+(?:\r?\n|$)/,
                        ""
                      )
                    : current.body}
                </MessageResponse>
              </div>
            )
          )}
        </>
      ) : (
        <Tabs
          value={kind}
          onValueChange={(value) => {
            if (value === "notes" || value === "plans") setKind(value)
            setEntries([])
            setQuery("")
          }}
          className="min-h-0 min-w-0 flex-1 gap-0"
        >
          <AuxPanelSearchToolbar
            query={query}
            onQueryChange={(value) => {
              if (value.trim() !== keyword) setEntries([])
              setQuery(value)
            }}
            placeholder={t(kind === "notes" ? "searchNotes" : "searchPlans")}
            type="search"
          >
            <TabsList className="shrink-0 gap-0.5 group-data-horizontal/tabs:h-7">
              <TabsTrigger
                value="notes"
                className="px-2 py-0 text-xs"
                disabled={busy}
              >
                {t("notes")}
              </TabsTrigger>
              <TabsTrigger
                value="plans"
                className="px-2 py-0 text-xs"
                disabled={busy}
              >
                {t("plans")}
              </TabsTrigger>
            </TabsList>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
              title={newEntryLabel}
              aria-label={newEntryLabel}
              onClick={newEntry}
              disabled={busy}
            >
              <Plus className="size-3.5" aria-hidden />
            </Button>
          </AuxPanelSearchToolbar>
          <TabsContent
            key={kind}
            value={kind}
            className="min-h-0 overflow-auto px-2 py-1"
          >
            {entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <EntryIcon className="size-5" />
                {t(
                  keyword
                    ? "noResults"
                    : kind === "notes"
                      ? "noNotes"
                      : "noPlans"
                )}
              </div>
            ) : (
              <ul className="divide-y divide-border/50">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex min-w-0 items-center rounded-md hover:bg-accent/40"
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          { action: "read", id: entry.id },
                          setCurrent
                        )
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-start focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    >
                      <EntryIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span
                          className="truncate text-[0.8125rem] font-medium"
                          title={title(entry)}
                        >
                          {title(entry)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {format.dateTime(new Date(entry.updatedAt), {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </span>
                    </button>
                    {sessionTabId && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
                        title={tChat("addToChat")}
                        aria-label={tChat("addToChat") + " · " + title(entry)}
                        onClick={() => addToSession(entry)}
                        disabled={busy}
                      >
                        <MessageSquarePlus className="size-3.5" aria-hidden />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      )}
      {saveError && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {t("storageError")}
        </p>
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {current && t("deletePrompt", { title: title(current) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (current)
                  void mutate(
                    {
                      action: "delete",
                      id: current.id,
                      expected: current.body,
                    },
                    () => {
                      setRevision((value) => value + 1)
                      closeEntry()
                    }
                  )
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
