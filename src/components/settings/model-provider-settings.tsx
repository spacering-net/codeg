"use client"

import { useCallback, useEffect, useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { useModelProviderService } from "@/stores/model-provider-transport"
import {
  emptyProviderDraft,
  recordToDraft,
  type ModelProviderDraft,
  type ModelProviderRecord,
} from "@/lib/model-provider-types"
import { BuiltinProviderPicker } from "./builtin-provider-picker"
import { ModelProviderEditor } from "./model-provider-editor"

interface EditorState {
  draft: ModelProviderDraft
  isNew: boolean
}

/** Settings → Model Providers. pios-style two-mode page: a list of providers
 *  (enable / reorder / clone / edit / delete) that swaps into an in-page editor
 *  (provider fields + model rows) while open. Backed by the
 *  mock service contract until the backend lands. */
export function ModelProviderSettings() {
  const t = useTranslations("ModelProviderSettings")
  const service = useModelProviderService()

  const [records, setRecords] = useState<ModelProviderRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ModelProviderRecord | null>(
    null
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      setRecords(await service.list())
    } catch {
      toast.error(t("loadFailed"))
    } finally {
      setLoading(false)
    }
  }, [service, t])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load's setStates all land after the await, never synchronously in the effect body
    load().catch(console.error)
  }, [load])

  const openEditor = useCallback((state: EditorState) => setEditor(state), [])

  const handleSaved = useCallback(
    (_record: ModelProviderRecord, affected: number) => {
      const key = editor?.isNew ? "createSuccess" : "editSuccess"
      toast.success(
        affected > 0
          ? `${t(key)} ${t("affectedRunningSessions", { count: affected })}`
          : t(key)
      )
      setEditor(null)
      load().catch(console.error)
    },
    [editor, load, t]
  )

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await service.remove(deleteTarget.providerId)
      toast.success(t("deleteSuccess"))
      setDeleteTarget(null)
      await load()
    } catch (err: unknown) {
      const raw = err as { message?: unknown }
      const msg =
        err instanceof Error
          ? err.message
          : typeof raw?.message === "string"
            ? raw.message
            : String(err)
      toast.error(msg)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, load, service, t])

  const handleToggle = useCallback(
    async (record: ModelProviderRecord, enabled: boolean) => {
      const prev = records
      setRecords((rs) =>
        rs.map((r) =>
          r.providerId === record.providerId ? { ...r, enabled } : r
        )
      )
      try {
        await service.setEnabled(record.providerId, enabled)
      } catch {
        setRecords(prev)
        toast.error(t("saveFailed"))
      }
    },
    [records, service, t]
  )

  const handleMove = useCallback(
    async (index: number, dir: -1 | 1) => {
      const target = index + dir
      if (target < 0 || target >= records.length) return
      const next = [...records]
      ;[next[index], next[target]] = [next[target], next[index]]
      setRecords(next)
      try {
        await service.reorder(next.map((r) => r.providerId))
      } catch {
        await load()
      }
    },
    [records, service, load]
  )

  const handleClone = useCallback(
    (record: ModelProviderRecord) => {
      const draft = recordToDraft(record)
      const taken = new Set(records.map((r) => r.providerId))
      let id = `${record.providerId}-2`
      for (let n = 2; taken.has(id); n++) id = `${record.providerId}-${n}`
      openEditor({
        draft: { ...draft, providerId: id, originalId: "", apiKey: "" },
        isNew: true,
      })
    },
    [openEditor, records]
  )

  const handleImport = useCallback(
    (draft: ModelProviderDraft) => {
      setPickerOpen(false)
      openEditor({ draft, isNew: true })
    },
    [openEditor]
  )

  if (editor) {
    const existingIds = records
      .map((r) => r.providerId)
      .filter((id) => id !== editor.draft.originalId)
    return (
      <div className="h-full">
        <ModelProviderEditor
          draft={editor.draft}
          isNew={editor.isNew}
          existingIds={existingIds}
          service={service}
          onSaved={handleSaved}
          onCancel={() => setEditor(null)}
        />
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <section className="space-y-3 px-3 pt-3 md:px-4 md:pt-4">
        <div>
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </div>
      </section>

      <section className="mt-4 space-y-2 px-3 pb-3 md:px-4 md:pb-4">
        <div className="flex items-center justify-end gap-2">
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => setPickerOpen(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1 rotate-45" />
              {t("importBuiltin")}
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() =>
                openEditor({ draft: emptyProviderDraft(), isNew: true })
              }
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t("addProvider")}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <Server className="h-8 w-8 mb-2 opacity-40" />
            <span className="text-xs">{t("noProviders")}</span>
            <span className="mt-1 text-2xs">{t("emptyStateHint")}</span>
          </div>
        ) : (
          <div className="space-y-2">
            {records.map((p, index) => (
              <div
                key={p.providerId}
                className={p.enabled === false ? "opacity-60" : ""}
              >
                <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
                  <div className="flex shrink-0 items-center">
                    <Switch
                      checked={p.enabled}
                      onCheckedChange={(v) => handleToggle(p, v)}
                      aria-label={
                        p.enabled ? t("disableProvider") : t("enableProvider")
                      }
                    />
                  </div>

                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="truncate text-sm font-medium">
                      {p.providerId}
                    </div>
                    <div className="truncate text-xs text-muted-foreground font-mono">
                      {p.api} · {p.baseUrl}
                      {p.proxy ? ` · 🌐 ${p.proxy}` : ""} · {p.models.length}{" "}
                      {t("modelsCount")}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground"
                      disabled={index === 0}
                      onClick={() => handleMove(index, -1)}
                      aria-label={t("moveUp")}
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground"
                      disabled={index === records.length - 1}
                      onClick={() => handleMove(index, 1)}
                      aria-label={t("moveDown")}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground"
                      onClick={() => handleClone(p)}
                      aria-label={t("cloneProvider")}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() =>
                        openEditor({ draft: recordToDraft(p), isNew: false })
                      }
                      aria-label={t("edit")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      onClick={() => setDeleteTarget(p)}
                      aria-label={t("delete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <BuiltinProviderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        service={service}
        onClone={handleImport}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmMessage", {
                name: deleteTarget?.providerId ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault()
                handleDelete()
              }}
            >
              {deleting && (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              )}
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  )
}
