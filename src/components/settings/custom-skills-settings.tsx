"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  Eye,
  FolderInput,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
} from "lucide-react"
import { useTranslations } from "next-intl"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"

import {
  SkillAgentMatrix,
  type MatrixSkill,
} from "@/components/settings/skill-agent-matrix"
import { AgentIcon } from "@/components/agent-icon"
import { DirectoryBrowserDialog } from "@/components/shared/directory-browser-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import {
  customApplyLinks,
  customCreateSkill,
  customDeleteSkills,
  customDuplicateSkill,
  customImportFromAgent,
  customImportSkill,
  customList,
  customListAllInstallStatuses,
  customReadSkill,
  customSaveSkill,
  acpListAgents,
  acpListAgentSkills,
  expertsList,
  scienceList,
  officecliListSkills,
  generativeUiSkillInfo,
} from "@/lib/api"
import { invalidateAgentSkillsCache } from "@/hooks/use-agent-skills"
import { useLatestCall } from "@/hooks/use-latest-call"
import { isLocalDesktop } from "@/lib/platform"
import { piUsesCustomAgentDir } from "@/lib/pi-config"
import {
  defaultCustomSkillTemplate,
  parseYamlFrontMatter,
} from "@/lib/skill-frontmatter"
import type {
  AcpAgentInfo,
  AgentSkillItem,
  AgentType,
  CustomSkillItem,
  ExpertLinkState,
} from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"

// Custom skills have no curated category taxonomy — they live under one group.
const CATEGORY_ORDER: Record<string, number> = { custom: 1 }

// Built-in pack skill ids (experts / office / science / ui-render) — the same
// union the backend treats as "reserved". When one of these packs is enabled for
// an agent it's symlinked into the agent's skill directory, so it surfaces in
// the agent's skill list; but it's codeg's OWN bundled skill, not the user's,
// and is deliberately excluded from the custom central store. We hide them from
// the import-from-agent picker so users only ever see (and re-import) their own
// agent skills. The set is static per session (bundled at compile time), so it's
// fetched once and cached at module scope. A load failure degrades to
// "no filtering" rather than blocking imports.
let reservedSkillIdsCache: Set<string> | null = null

async function loadReservedSkillIds(): Promise<Set<string>> {
  if (reservedSkillIdsCache) return reservedSkillIdsCache
  try {
    const [experts, science, office, generativeUi] = await Promise.all([
      expertsList(),
      scienceList(),
      officecliListSkills(),
      // On its own catch: without it the packs above still filter.
      generativeUiSkillInfo().catch(() => null),
    ])
    const ids = new Set<string>([
      ...experts.map((e) => e.metadata.id),
      ...science.map((s) => s.metadata.id),
      ...office.map((o) => o.id),
      ...(generativeUi ? [generativeUi.id] : []),
    ])
    reservedSkillIdsCache = ids
    return ids
  } catch (err) {
    console.warn(
      "[CustomSkillsSettings] failed to load built-in skill ids; import filter disabled:",
      err
    )
    return new Set()
  }
}

type EditorMode = "create" | "edit"

export function CustomSkillsBody({
  onRegisterRefresh,
}: {
  onRegisterRefresh?: (refresh: () => void) => void
}) {
  const t = useTranslations("CustomSkillsSettings")

  const [skills, setSkills] = useState<CustomSkillItem[]>([])
  const [agents, setAgents] = useState<AcpAgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Editor (create/edit) dialog.
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<EditorMode>("create")
  const [editorId, setEditorId] = useState("")
  const [editorContent, setEditorContent] = useState("")
  const [editorEditing, setEditorEditing] = useState(true)
  const [editorSaving, setEditorSaving] = useState(false)

  // Import (folder picker) dialog — used only on web / remote workspaces; a
  // local desktop app uses the native OS folder picker instead.
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  // Import-from-agent dialog (multi-select an agent's own global skills).
  const [agentImportOpen, setAgentImportOpen] = useState(false)
  const [agentImportAgent, setAgentImportAgent] = useState<AgentType | null>(
    null
  )
  const [agentImportSkills, setAgentImportSkills] = useState<AgentSkillItem[]>(
    []
  )
  const [agentImportSelected, setAgentImportSelected] = useState<Set<string>>(
    new Set()
  )
  const [agentImportLoading, setAgentImportLoading] = useState(false)
  const [agentImportError, setAgentImportError] = useState<string | null>(null)
  const [agentImportUnsupported, setAgentImportUnsupported] = useState(false)
  const [agentImporting, setAgentImporting] = useState(false)

  // Duplicate dialog.
  const [duplicateSource, setDuplicateSource] = useState<string | null>(null)
  const [duplicateNewId, setDuplicateNewId] = useState("")
  const [duplicating, setDuplicating] = useState(false)

  // Delete confirm (single or batch).
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null)
  const [deleting, setDeleting] = useState(false)

  // A late answer from an earlier Refresh must not overwrite a newer one.
  const beginLoad = useLatestCall()

  const refresh = useCallback(async () => {
    const current = beginLoad()
    setLoading(true)
    setLoadError(null)
    try {
      const [list, agentList] = await Promise.all([
        customList(),
        acpListAgents(),
      ])
      if (!current()) return
      setSkills(list)
      // `skills_capable` is derived backend-side from `skill_storage_spec`:
      // every built-in today, custom agents only once they declare the shared
      // `.agents/skills` store. Without the filter an undeclared custom agent
      // would render a matrix column whose links can only fail.
      setAgents(
        agentList.filter(
          (agent) => agent.skills_capable && !piUsesCustomAgentDir(agent)
        )
      )
      setReloadKey((k) => k + 1)
    } catch (err) {
      if (!current()) return
      setLoadError(toErrorMessage(err))
      setSkills([])
      setAgents([])
    } finally {
      if (current()) setLoading(false)
    }
  }, [beginLoad])

  useEffect(() => {
    refresh().catch((err) => {
      console.error("[CustomSkillsSettings] initial refresh failed:", err)
    })
  }, [refresh])

  useEffect(() => {
    onRegisterRefresh?.(() => {
      refresh().catch((err) => {
        console.error("[CustomSkillsSettings] refresh failed:", err)
      })
    })
  }, [onRegisterRefresh, refresh])

  const invalidateAll = useCallback(() => {
    for (const agent of agents) invalidateAgentSkillsCache(agent.agent_type)
  }, [agents])

  const translateState = useCallback(
    (state: ExpertLinkState): string => {
      switch (state) {
        case "not_linked":
          return t("states.not_linked")
        case "linked_to_codeg":
          return t("states.linked_to_codeg")
        case "linked_elsewhere":
          return t("states.linked_elsewhere")
        case "blocked_by_real_directory":
          return t("states.blocked_by_real_directory")
        case "broken":
          return t("states.broken")
        default:
          return state
      }
    },
    [t]
  )

  const matrixSkills = useMemo<MatrixSkill[]>(
    () =>
      skills.map((s) => ({
        id: s.id,
        category: "custom",
        displayName: s.name || s.id,
        description: s.description ?? "",
        icon: Sparkles,
        ready: true,
      })),
    [skills]
  )

  // Ids already in the central store — used to mark an agent's skills that are
  // already available so they can't be re-imported.
  const libraryIds = useMemo(() => new Set(skills.map((s) => s.id)), [skills])

  // ─── Authoring handlers ─────────────────────────────────────────────

  const openCreate = useCallback(() => {
    setEditorMode("create")
    setEditorId("")
    setEditorContent(defaultCustomSkillTemplate())
    setEditorEditing(true)
    setEditorOpen(true)
  }, [])

  const openEdit = useCallback(
    async (id: string) => {
      try {
        const content = await customReadSkill(id)
        setEditorMode("edit")
        setEditorId(id)
        setEditorContent(content)
        setEditorEditing(false)
        setEditorOpen(true)
      } catch (err) {
        toast.error(t("toasts.loadFailed"), {
          description: toErrorMessage(err),
        })
      }
    },
    [t]
  )

  const handleSave = useCallback(async () => {
    const id = editorId.trim()
    if (!id) {
      toast.error(t("toasts.idRequired"))
      return
    }
    setEditorSaving(true)
    try {
      if (editorMode === "create") {
        await customCreateSkill({ id, content: editorContent })
      } else {
        await customSaveSkill({ id, content: editorContent })
      }
      setEditorOpen(false)
      invalidateAll()
      await refresh()
      toast.success(
        editorMode === "create" ? t("toasts.created") : t("toasts.updated")
      )
    } catch (err) {
      toast.error(t("toasts.saveFailed"), { description: toErrorMessage(err) })
    } finally {
      setEditorSaving(false)
    }
  }, [editorContent, editorId, editorMode, invalidateAll, refresh, t])

  const handleImport = useCallback(
    async (path: string) => {
      setImportOpen(false)
      setImporting(true)
      try {
        await customImportSkill({ sourcePath: path })
        invalidateAll()
        await refresh()
        toast.success(t("toasts.imported"))
      } catch (err) {
        toast.error(t("toasts.importFailed"), {
          description: toErrorMessage(err),
        })
      } finally {
        setImporting(false)
      }
    },
    [invalidateAll, refresh, t]
  )

  // Local desktop → native OS folder picker. Web / remote workspace → the
  // server-aware directory browser (it walks the SERVER's filesystem, which is
  // where the central store lives, not the browser's).
  const handleImportClick = useCallback(async () => {
    if (isLocalDesktop()) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog")
        const picked = await open({
          directory: true,
          multiple: false,
          title: t("import.title"),
        })
        if (typeof picked === "string") await handleImport(picked)
      } catch (err) {
        toast.error(t("toasts.importFailed"), {
          description: toErrorMessage(err),
        })
      }
      return
    }
    setImportOpen(true)
  }, [handleImport, t])

  // ─── Import from agent (multi-select) ───────────────────────────────

  const loadAgentSkills = useCallback(
    async (agentType: AgentType) => {
      setAgentImportLoading(true)
      setAgentImportError(null)
      setAgentImportUnsupported(false)
      setAgentImportSkills([])
      setAgentImportSelected(new Set())
      try {
        const [result, reserved] = await Promise.all([
          acpListAgentSkills({ agentType }),
          loadReservedSkillIds(),
        ])
        if (!result.supported) {
          setAgentImportUnsupported(true)
          return
        }
        // Only global-scope skills belong in the shared store (project skills
        // are workspace-specific). We pass no workspace, so the result is
        // already global-only; filter defensively. Also drop codeg's own
        // built-in pack skills (experts / office / science / ui-render): once
        // enabled they symlink into the agent's dir and would otherwise appear
        // here, but they aren't the user's own skills to re-import.
        const globals = result.skills.filter(
          (s) => s.scope === "global" && !reserved.has(s.id)
        )
        setAgentImportSkills(globals)
        // Pre-select everything not already in the central library so the common
        // "import all" case is a single click.
        setAgentImportSelected(
          new Set(globals.filter((s) => !libraryIds.has(s.id)).map((s) => s.id))
        )
      } catch (err) {
        setAgentImportError(toErrorMessage(err))
      } finally {
        setAgentImportLoading(false)
      }
    },
    [libraryIds]
  )

  const openAgentImport = useCallback(() => {
    const first = agentImportAgent ?? agents[0]?.agent_type ?? null
    setAgentImportAgent(first)
    setAgentImportOpen(true)
    if (first) {
      loadAgentSkills(first).catch((err) => {
        console.error("[CustomSkillsSettings] load agent skills failed:", err)
      })
    }
  }, [agentImportAgent, agents, loadAgentSkills])

  const changeAgentImportAgent = useCallback(
    (agentType: AgentType) => {
      setAgentImportAgent(agentType)
      loadAgentSkills(agentType).catch((err) => {
        console.error("[CustomSkillsSettings] load agent skills failed:", err)
      })
    },
    [loadAgentSkills]
  )

  const toggleAgentSkill = useCallback((id: string) => {
    setAgentImportSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const setAllAgentSkills = useCallback((ids: string[], checked: boolean) => {
    setAgentImportSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const handleAgentImport = useCallback(async () => {
    if (!agentImportAgent || agentImportSelected.size === 0) return
    setAgentImporting(true)
    try {
      const results = await customImportFromAgent({
        agentType: agentImportAgent,
        ids: [...agentImportSelected],
      })
      const ok = results.filter((r) => r.ok).length
      const skipped = results.filter((r) => r.skipped).length
      const failed = results.filter((r) => !r.ok && !r.skipped)
      invalidateAll()
      await refresh()
      if (failed.length > 0) {
        toast.warning(
          t("toasts.importedFromAgentPartial", { ok, failed: failed.length }),
          { description: failed[0]?.error ?? undefined }
        )
      } else if (ok > 0) {
        toast.success(t("toasts.importedFromAgent", { count: ok }))
      } else {
        toast.info(t("toasts.importFromAgentAllSkipped", { count: skipped }))
      }
      setAgentImportOpen(false)
    } catch (err) {
      toast.error(t("toasts.importFromAgentFailed"), {
        description: toErrorMessage(err),
      })
    } finally {
      setAgentImporting(false)
    }
  }, [agentImportAgent, agentImportSelected, invalidateAll, refresh, t])

  const openDuplicate = useCallback((id: string) => {
    setDuplicateSource(id)
    setDuplicateNewId(`${id}-copy`)
  }, [])

  const handleDuplicate = useCallback(async () => {
    if (!duplicateSource) return
    const newId = duplicateNewId.trim()
    if (!newId) {
      toast.error(t("toasts.idRequired"))
      return
    }
    setDuplicating(true)
    try {
      await customDuplicateSkill({ sourceId: duplicateSource, newId })
      setDuplicateSource(null)
      invalidateAll()
      await refresh()
      toast.success(t("toasts.duplicated"))
    } catch (err) {
      toast.error(t("toasts.duplicateFailed"), {
        description: toErrorMessage(err),
      })
    } finally {
      setDuplicating(false)
    }
  }, [duplicateNewId, duplicateSource, invalidateAll, refresh, t])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteIds || deleteIds.length === 0) return
    setDeleting(true)
    try {
      const results = await customDeleteSkills(deleteIds)
      const failed = results.filter((r) => !r.ok)
      invalidateAll()
      await refresh()
      if (failed.length === 0) {
        toast.success(t("toasts.deleted", { count: results.length }))
      } else {
        toast.warning(
          t("toasts.deletedPartial", {
            ok: results.length - failed.length,
            failed: failed.length,
          }),
          { description: failed[0]?.error ?? undefined }
        )
      }
      setDeleteIds(null)
    } catch (err) {
      toast.error(t("toasts.deleteFailed"), {
        description: toErrorMessage(err),
      })
    } finally {
      setDeleting(false)
    }
  }, [deleteIds, invalidateAll, refresh, t])

  // ─── Matrix slots ───────────────────────────────────────────────────

  const toolbarActions = (
    <>
      <Button size="sm" variant="outline" onClick={openCreate}>
        <Plus className="h-3.5 w-3.5" />
        {t("actions.new")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={openAgentImport}
        disabled={agents.length === 0}
      >
        <Bot className="h-3.5 w-3.5" />
        {t("actions.importFromAgent")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          handleImportClick().catch((err) => {
            console.error("[CustomSkillsSettings] import click failed:", err)
          })
        }}
        disabled={importing}
      >
        {importing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FolderInput className="h-3.5 w-3.5" />
        )}
        {t("actions.import")}
      </Button>
    </>
  )

  const rowActions = useCallback(
    (skill: MatrixSkill) => (
      <>
        <DropdownMenuItem
          onSelect={() => {
            openEdit(skill.id).catch((err) => {
              console.error("[CustomSkillsSettings] open edit failed:", err)
            })
          }}
        >
          {t("rowMenu.edit")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDuplicate(skill.id)}>
          {t("rowMenu.duplicate")}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => setDeleteIds([skill.id])}
        >
          {t("rowMenu.delete")}
        </DropdownMenuItem>
      </>
    ),
    [openDuplicate, openEdit, t]
  )

  const bulkActions = useCallback(
    (selectedIds: string[]) => (
      <Button
        size="sm"
        variant="outline"
        className="text-destructive hover:text-destructive"
        onClick={() => setDeleteIds(selectedIds)}
      >
        {t("bulk.delete")}
      </Button>
    ),
    [t]
  )

  // ─── Render ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  const preview = parseYamlFrontMatter(editorContent)

  // Agent skills the user can still import (those not already in the store).
  const importableAgentSkills = agentImportSkills.filter(
    (s) => !libraryIds.has(s.id)
  )
  const allImportableSelected =
    importableAgentSkills.length > 0 &&
    importableAgentSkills.every((s) => agentImportSelected.has(s.id))

  return (
    <div className="flex flex-col h-full min-h-0">
      {loadError && (
        <div className="mb-3 shrink-0 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {loadError}
        </div>
      )}

      {/* Even when empty, the matrix renders its toolbar (New / Import CTA). */}
      <div className="flex-1 min-h-0 min-w-0">
        <SkillAgentMatrix
          key={reloadKey}
          skills={matrixSkills}
          agents={agents}
          categoryOrder={CATEGORY_ORDER}
          translateCategory={() => t("category")}
          translateState={translateState}
          loadAllStatuses={customListAllInstallStatuses}
          applyLinks={customApplyLinks}
          loadContent={customReadSkill}
          onApplied={(touched: AgentType[]) =>
            touched.forEach((a) => invalidateAgentSkillsCache(a))
          }
          searchPlaceholder={t("searchPlaceholder")}
          toolbarActions={toolbarActions}
          rowActions={rowActions}
          bulkActions={bulkActions}
        />
      </div>

      {/* Editor dialog (create / edit). */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-[45rem]">
          <DialogHeader>
            <DialogTitle>
              {editorMode === "create"
                ? t("editor.createTitle")
                : t("editor.editTitle")}
            </DialogTitle>
            <DialogDescription>{t("editor.description")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-2xs text-muted-foreground">
                {t("editor.idLabel")}
              </label>
              <Input
                value={editorId}
                onChange={(e) => setEditorId(e.target.value)}
                placeholder={t("editor.idPlaceholder")}
                // The id is the on-disk directory name; renaming would move
                // files (and break existing agent links), so lock it on edit.
                disabled={editorMode === "edit"}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-2xs text-muted-foreground">
                  {t("editor.contentLabel")}
                </label>
                <Button
                  size="xs"
                  variant={editorEditing ? "secondary" : "outline"}
                  onClick={() => setEditorEditing((v) => !v)}
                >
                  {editorEditing ? (
                    <>
                      <Eye className="h-3 w-3" />
                      {t("editor.preview")}
                    </>
                  ) : (
                    <>
                      <Pencil className="h-3 w-3" />
                      {t("editor.edit")}
                    </>
                  )}
                </Button>
              </div>

              {editorEditing ? (
                <Textarea
                  value={editorContent}
                  onChange={(e) => setEditorContent(e.target.value)}
                  placeholder={t("editor.contentPlaceholder")}
                  className="min-h-[20rem] font-mono text-xs"
                />
              ) : (
                <div className="min-h-[20rem] max-h-[26.25rem] overflow-auto rounded-md border bg-muted/10 p-3 space-y-2">
                  {preview.fields.length > 0 && (
                    <div className="grid gap-1.5 border-b pb-2 mb-1">
                      {preview.fields.map((field) => (
                        <div
                          key={field.key}
                          className="text-xs grid grid-cols-[6.25rem_1fr] gap-2 items-start"
                        >
                          <span className="text-muted-foreground font-mono truncate">
                            {field.key}
                          </span>
                          <span className="font-mono break-all">
                            {field.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {preview.body.trim() ? (
                    <div
                      className={cn(
                        "text-sm leading-6",
                        "[&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mb-3",
                        "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2",
                        "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2",
                        "[&_p]:mb-3 [&_li]:mb-1",
                        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
                        "[&_code]:font-mono [&_code]:text-xs [&_code]:bg-muted [&_code]:rounded [&_code]:px-1",
                        "[&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto"
                      )}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {preview.body}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground py-3">
                      {t("editor.emptyBody")}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditorOpen(false)}
              disabled={editorSaving}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              onClick={() => {
                handleSave().catch((err) => {
                  console.error("[CustomSkillsSettings] save failed:", err)
                })
              }}
              disabled={editorSaving}
            >
              {editorSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("actions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Duplicate dialog. */}
      <Dialog
        open={duplicateSource !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicateSource(null)
        }}
      >
        <DialogContent className="sm:max-w-[27.5rem]">
          <DialogHeader>
            <DialogTitle>{t("duplicate.title")}</DialogTitle>
            <DialogDescription>
              {t("duplicate.description", { id: duplicateSource ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={duplicateNewId}
            onChange={(e) => setDuplicateNewId(e.target.value)}
            placeholder={t("duplicate.newIdPlaceholder")}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDuplicateSource(null)}
              disabled={duplicating}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              onClick={() => {
                handleDuplicate().catch((err) => {
                  console.error("[CustomSkillsSettings] duplicate failed:", err)
                })
              }}
              disabled={duplicating}
            >
              {duplicating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("duplicate.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import folder picker — web / remote only (desktop uses the native
          OS picker via handleImportClick). Server-aware directory browser. */}
      <DirectoryBrowserDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onSelect={(path) => {
          handleImport(path).catch((err) => {
            console.error("[CustomSkillsSettings] import failed:", err)
          })
        }}
        title={t("import.title")}
      />

      {/* Import from agent (multi-select an agent's own skills). */}
      <Dialog open={agentImportOpen} onOpenChange={setAgentImportOpen}>
        <DialogContent className="sm:max-w-[35rem]">
          <DialogHeader>
            <DialogTitle>{t("importFromAgent.title")}</DialogTitle>
            <DialogDescription>
              {t("importFromAgent.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-2xs text-muted-foreground">
                {t("importFromAgent.agentLabel")}
              </label>
              <Select
                value={agentImportAgent ?? ""}
                onValueChange={(value) =>
                  changeAgentImportAgent(value as AgentType)
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("importFromAgent.agentPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent align="start">
                  {agents.map((agent) => (
                    <SelectItem key={agent.agent_type} value={agent.agent_type}>
                      <span className="flex items-center gap-2">
                        <AgentIcon
                          agentType={agent.agent_type}
                          className="h-3.5 w-3.5"
                        />
                        {agent.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* One bordered box wraps the select-all header and the list so
                the header checkbox lines up with each row's checkbox (both are
                `px-3` inside the SAME border). */}
            <div className="overflow-hidden rounded-md border">
              {/* Select-all header (only when there's something importable). */}
              {importableAgentSkills.length > 0 && (
                <label className="flex items-center gap-2.5 border-b px-3 py-2.5 text-xs text-muted-foreground cursor-pointer select-none">
                  <Checkbox
                    checked={allImportableSelected}
                    onCheckedChange={(checked) =>
                      setAllAgentSkills(
                        importableAgentSkills.map((s) => s.id),
                        checked === true
                      )
                    }
                  />
                  {t("importFromAgent.selectAll", {
                    count: importableAgentSkills.length,
                  })}
                </label>
              )}

              <ScrollArea className="h-[20rem]">
                {agentImportLoading ? (
                  <div className="flex h-[20rem] items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("importFromAgent.loading")}
                  </div>
                ) : agentImportError ? (
                  <div className="p-3 text-xs text-red-400">
                    {agentImportError}
                  </div>
                ) : agentImportUnsupported ? (
                  <div className="flex h-[20rem] items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    {t("importFromAgent.unsupported")}
                  </div>
                ) : agentImportSkills.length === 0 ? (
                  <div className="flex h-[20rem] items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    {t("importFromAgent.empty")}
                  </div>
                ) : (
                  <div className="divide-y">
                    {agentImportSkills.map((skill) => {
                      const already = libraryIds.has(skill.id)
                      const checked = agentImportSelected.has(skill.id)
                      return (
                        <label
                          key={`${skill.scope}:${skill.id}`}
                          className={cn(
                            "flex items-start gap-2.5 px-3 py-2.5",
                            already
                              ? "cursor-default opacity-60"
                              : "cursor-pointer hover:bg-muted/40"
                          )}
                        >
                          <Checkbox
                            className="mt-0.5"
                            checked={already ? false : checked}
                            disabled={already}
                            onCheckedChange={() => toggleAgentSkill(skill.id)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {skill.name || skill.id}
                              </span>
                              {already && (
                                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                                  {t("importFromAgent.alreadyInLibrary")}
                                </span>
                              )}
                            </div>
                            <div className="truncate font-mono text-2xs text-muted-foreground">
                              {skill.id}
                            </div>
                            {skill.description && (
                              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                {skill.description}
                              </div>
                            )}
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </ScrollArea>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAgentImportOpen(false)}
              disabled={agentImporting}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              onClick={() => {
                handleAgentImport().catch((err) => {
                  console.error(
                    "[CustomSkillsSettings] agent import failed:",
                    err
                  )
                })
              }}
              disabled={agentImporting || agentImportSelected.size === 0}
            >
              {agentImporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("importFromAgent.confirm", {
                count: agentImportSelected.size,
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm (single or batch). */}
      <AlertDialog
        open={deleteIds !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteIds(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("delete.body", { count: deleteIds?.length ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(e) => {
                // Keep the dialog mounted through the async delete.
                e.preventDefault()
                handleConfirmDelete().catch((err) => {
                  console.error(
                    "[CustomSkillsSettings] confirm delete failed:",
                    err
                  )
                })
              }}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
