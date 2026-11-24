"use client"

import { useEffect, useState } from "react"
import {
  ArrowLeft,
  FileText,
  NotebookPen,
  Plus,
  Search,
  Trash2,
} from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import { getTransport } from "@/lib/transport"
import { emitAppendTextToSession } from "@/lib/session-attachment-events"
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
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

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

  const tabs = (
    <TabsList
      variant="line"
      className="h-9 items-stretch gap-2 px-1 group-data-horizontal/tabs:h-9"
    >
      <TabsTrigger value="notes" className="text-xs" disabled={busy}>
        <NotebookPen className="size-3.5" />
        {t("notes")}
      </TabsTrigger>
      <TabsTrigger value="plans" className="text-xs" disabled={busy}>
        <FileText className="size-3.5" />
        {t("plans")}
      </TabsTrigger>
    </TabsList>
  )

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      {draft !== undefined || current ? (
        <>
          <div className="flex min-h-11 items-center gap-2 border-b px-2">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              onClick={closeEntry}
              aria-label={t("back")}
              title={t("back")}
            >
              <ArrowLeft />
            </Button>
            <h3 className="min-w-0 flex-1 truncate font-medium">
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
            ) : (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft(current?.body)
                    setEditorTab("markdown")
                  }}
                >
                  {t("edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDeleteOpen(true)}
                  aria-label={t("delete")}
                  title={t("delete")}
                >
                  <Trash2 />
                </Button>
              </div>
            )}
          </div>
          {draft !== undefined ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
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
                      <MessageResponse mode="static">{draft}</MessageResponse>
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
              <div className="min-h-0 flex-1 overflow-auto p-3 select-text">
                {sessionTabId && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mb-3"
                    onClick={() => {
                      const accepted = emitAppendTextToSession({
                        tabId: sessionTabId,
                        text: current.body,
                      })
                      if (accepted) {
                        toast(
                          tChat("addFileToChatDone", { label: title(current) })
                        )
                      } else {
                        toast.error(tSession("noActiveSession"))
                      }
                    }}
                  >
                    {tChat("addToChat")}
                  </Button>
                )}
                {kind === "plans" ? (
                  <MessageResponse mode="static">
                    {current.body}
                  </MessageResponse>
                ) : (
                  <p className="whitespace-pre-wrap wrap-break-word">
                    {current.body}
                  </p>
                )}
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
          className="min-h-0 flex-1 gap-0"
        >
          <div className="flex shrink-0 items-center justify-between border-b px-2 py-1">
            {tabs}
            <Button
              size="sm"
              variant="outline"
              onClick={newEntry}
              disabled={busy}
            >
              <Plus />
              {t(kind === "notes" ? "newNote" : "newPlan")}
            </Button>
          </div>
          <div className="relative shrink-0 px-3 py-2.5">
            <Search className="pointer-events-none absolute start-5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              className="h-8 ps-8 text-xs"
              aria-label={t(kind === "notes" ? "searchNotes" : "searchPlans")}
              placeholder={t(kind === "notes" ? "searchNotes" : "searchPlans")}
              value={query}
              onChange={(event) => {
                if (event.target.value.trim() !== keyword) setEntries([])
                setQuery(event.target.value)
              }}
            />
          </div>
          <TabsContent
            key={kind}
            value={kind}
            className="min-h-0 overflow-auto px-3 pb-3"
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
              <ul className="space-y-1.5">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          { action: "read", id: entry.id },
                          setCurrent
                        )
                      }
                      className="flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-2.5 py-2 text-start hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <EntryIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-sm font-medium">
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
