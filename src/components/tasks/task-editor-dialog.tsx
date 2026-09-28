"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { BookmarkPlus, LayoutTemplate, Trash2 } from "lucide-react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { AgentSelector } from "@/components/chat/agent-selector"
import {
  TaskMessageComposer,
  type TaskMessageComposerHandle,
} from "./task-message-composer"
import {
  AgentConfigSection,
  effectiveSelections,
  snapshotLabels,
} from "@/components/automations/agent-config-section"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import { getAgentLabel } from "@/lib/custom-agents"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { BranchPicker } from "@/components/shared/branch-picker"
import { FolderSelect } from "@/components/shared/folder-select"
import { useScrollbarSafeDismiss } from "@/hooks/use-scrollbar-safe-dismiss"
import {
  workTaskSettingsEffective,
  workTaskTemplateDelete,
  workTaskTemplateList,
  workTaskTemplateSave,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AgentType,
  WorkTask,
  WorkTaskConfig,
  WorkTaskDraft,
  WorkTaskTemplate,
} from "@/lib/types"

interface TaskEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Existing task to edit, or null for a blank create. */
  task: WorkTask | null
  /** Preselected folder for a create (the board's folder filter). */
  defaultFolderId: number | null
  /** Seed text for a create (the "task from message" hand-off). */
  prefillText?: string | null
  onSubmit: (draft: WorkTaskDraft) => Promise<void>
}

/**
 * Create/edit a task, laid out like the automation editor: borderless title,
 * the agent pill above the real conversation composer (rich text +
 * @-mentions) with the ACP-probed mode/model bar inside the box, and a Target
 * section for the folder. The agent controls prefill from the folder's
 * EFFECTIVE task settings; untouched they keep inheriting (nothing is frozen
 * into the task), and only an explicit change is saved as a per-task override.
 */
export function TaskEditorDialog({
  open,
  onOpenChange,
  task,
  defaultFolderId,
  prefillText,
  onSubmit,
}: TaskEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[40rem]">
        {/* Remount per open so a reopened editor never leaks previous state. */}
        {open ? (
          <TaskEditorBody
            task={task}
            defaultFolderId={defaultFolderId}
            prefillText={prefillText ?? null}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TaskEditorBody({
  task,
  defaultFolderId,
  prefillText,
  onSubmit,
  onCancel,
}: {
  task: WorkTask | null
  defaultFolderId: number | null
  prefillText: string | null
  onSubmit: (draft: WorkTaskDraft) => Promise<void>
  onCancel: () => void
}) {
  const t = useTranslations("Tasks")
  // The upload-in-flight message is the conversation composer's own.
  const tChat = useTranslations("Folder.chat.messageInput")
  const folders = useAppWorkspaceStore((s) => s.folders)
  // Tasks bind to project roots only (never worktrees / chat scratch dirs).
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )

  // A create seeded from a chat message: the text becomes the description and
  // its first line (trimmed) the suggested title.
  const seededText = task == null ? (prefillText ?? "") : ""
  const [title, setTitle] = useState(
    task?.title ?? seededText.split("\n")[0]?.trim().slice(0, 80) ?? ""
  )
  const [prompt, setPrompt] = useState(task?.config?.display_text ?? seededText)
  const [folderId, setFolderId] = useState<number | null>(
    task?.folder_id ?? defaultFolderId ?? projectFolders[0]?.id ?? null
  )
  // The branch this task is for. "" = the project folder's current branch when
  // the task starts, which is what every task did before the choice existed.
  // The REQUEST, never the recorded base: this is what the next save writes
  // back, and a task that branched from the checkout by accident must not come
  // out of the editor asking for that branch by name.
  const [baseBranch, setBaseBranch] = useState(task?.config?.base_branch ?? "")
  // `agentDirty` = the user explicitly chose agent/mode/config for THIS task.
  // While clean, the controls display the folder's effective task settings and
  // the draft keeps inheriting (agent_type null) — nothing is frozen.
  const [agentDirty, setAgentDirty] = useState(task?.config?.agent_type != null)
  const [agentType, setAgentType] = useState<AgentType>(
    task?.config?.agent_type ?? "claude_code"
  )
  const [modeId, setModeId] = useState<string | null>(
    task?.config?.mode_id ?? null
  )
  const [configValues, setConfigValues] = useState<Record<string, string>>(
    task?.config?.config_values ?? {}
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Saved blueprints (global). Applying one reseeds the composer via a key
  // bump — RichComposer only reads defaultText on mount.
  const [templates, setTemplates] = useState<WorkTaskTemplate[]>([])
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templateBusy, setTemplateBusy] = useState(false)
  // The composer's mount seed. Blocks, not just text: an edited task's images
  // and pasted bytes have to come back into the box, or saving it would drop
  // them. A `key` bump remounts the box to apply a template.
  const [composerSeed, setComposerSeed] = useState(() => ({
    key: 0,
    text: task?.config?.display_text ?? seededText,
    blocks: task?.config?.prompt_blocks ?? null,
  }))
  // Mirrors the composer's attached-file count, so a brief that is only a
  // screenshot still passes the "say something" gate below.
  const [attachmentCount, setAttachmentCount] = useState(0)
  const { contentRef, onPointerDownOutside, onFocusOutside } =
    useScrollbarSafeDismiss()

  const composerRef = useRef<TaskMessageComposerHandle>(null)

  useEffect(() => {
    let cancelled = false
    workTaskTemplateList()
      .then((list) => {
        if (!cancelled) setTemplates(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const folderDefaultAgent = useMemo(
    () => folders.find((f) => f.id === folderId)?.default_agent_type ?? null,
    [folders, folderId]
  )

  // Prefill the agent controls from the folder's effective settings while the
  // user hasn't touched them; follows folder switches and template resets
  // (the effect re-runs when `agentDirty` flips back to false).
  useEffect(() => {
    if (agentDirty || folderId == null) return
    let cancelled = false
    workTaskSettingsEffective(folderId)
      .then((s) => {
        if (cancelled) return
        setAgentType(
          s.default_agent_type ?? folderDefaultAgent ?? "claude_code"
        )
        setModeId(s.mode_id ?? null)
        setConfigValues(s.config_values ?? {})
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agentDirty, folderId, folderDefaultAgent])

  const folderPath = useMemo(
    () => folders.find((f) => f.id === folderId)?.path ?? null,
    [folders, folderId]
  )

  // A task that has already minted its worktree: its folder and the branch it
  // branched from are recorded facts by then, not settings.
  const pinned = task != null && task.worktree_folder_id != null
  // A pull-request task has no branch to choose: it starts on the pull request
  // and is reviewed against that review's base ref, so a pick here would be
  // quietly ignored.
  const choosesBranch = task?.source_kind !== "forge_pr"

  const agentOptions = useAgentOptions(agentType, folderPath, true)

  // The captured composer + agent state as a `WorkTaskConfig` — the shared
  // payload of both the task draft and a saved template.
  const buildConfig = async (): Promise<WorkTaskConfig> => {
    const displayText = (composerRef.current?.getText() ?? prompt).trim()
    // Prose + inline references + attached images, exactly as a chat send
    // composes them; the engine replays these blocks when the task launches.
    const blocks = composerRef.current?.getPromptBlocks() ?? [
      { type: "text", text: displayText },
    ]
    // Explicitly null rather than absent when nothing is picked: clearing the
    // choice has to travel, and the save replaces the stored config wholesale.
    const base_branch = baseBranch.trim() || null
    if (!agentDirty) {
      return {
        prompt_blocks: blocks,
        display_text: displayText,
        agent_type: null,
        mode_id: null,
        config_values: {},
        base_branch,
      }
    }
    const snapshot = await agentOptions.ensure()
    const { mode_id, config_values } = effectiveSelections(
      snapshot,
      modeId,
      configValues
    )
    return {
      prompt_blocks: blocks,
      display_text: displayText,
      agent_type: agentType,
      mode_id,
      config_values,
      label_snapshot: {
        agent_label: getAgentLabel(agentType) ?? agentType,
        ...snapshotLabels(snapshot, mode_id, config_values),
      },
      base_branch,
    }
  }

  const submit = async () => {
    setError(null)
    const displayText = (composerRef.current?.getText() ?? prompt).trim()
    const hasAttachments = composerRef.current?.hasAttachments() ?? false
    if (!title.trim()) return setError(t("errorTitle"))
    // A brief that is only a screenshot is still a brief.
    if (!displayText && !hasAttachments) return setError(t("errorPrompt"))
    if (folderId == null) return setError(t("errorFolder"))
    // An unsettled upload has no server-side uri yet, so the stored block would
    // carry nothing for the launch to hydrate from.
    if (composerRef.current?.hasUploadingImage()) {
      return setError(tChat("attachUploadInProgress"))
    }

    setSaving(true)
    try {
      const draft: WorkTaskDraft = {
        folder_id: folderId,
        title: title.trim(),
        config: await buildConfig(),
      }
      await onSubmit(draft)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const applyTemplate = (tpl: WorkTaskTemplate) => {
    const cfg = tpl.config
    const text = cfg?.display_text ?? ""
    setTitle(tpl.title)
    setPrompt(text)
    setComposerSeed((s) => ({
      key: s.key + 1,
      text,
      blocks: cfg?.prompt_blocks ?? null,
    }))
    if (cfg?.agent_type != null) {
      setAgentDirty(true)
      setAgentType(cfg.agent_type)
      setModeId(cfg.mode_id ?? null)
      setConfigValues(cfg.config_values ?? {})
    } else {
      // Back to inheriting — the prefill effect reseeds from settings.
      setAgentDirty(false)
    }
    setTemplatesOpen(false)
  }

  // Saved under the current title (upsert by name) — re-saving the same title
  // updates that template instead of piling up copies.
  const saveTemplate = async () => {
    setError(null)
    const displayText = (composerRef.current?.getText() ?? prompt).trim()
    if (!title.trim()) return setError(t("errorTitle"))
    if (!displayText && !(composerRef.current?.hasAttachments() ?? false)) {
      return setError(t("errorPrompt"))
    }
    // Same gate as the save: an unsettled upload has no server-side uri, so the
    // template would be stored with an image that resolves to nothing (or, in
    // web mode, with raw base64 the strip could not remove).
    if (composerRef.current?.hasUploadingImage()) {
      return setError(tChat("attachUploadInProgress"))
    }
    setTemplateBusy(true)
    try {
      // A blueprint is global — the folder is picked at creation time — so a
      // branch name from one repository must not ride along into another,
      // where it would only fail the launch.
      const config = await buildConfig()
      delete config.base_branch
      await workTaskTemplateSave({
        name: title.trim(),
        title: title.trim(),
        config,
      })
      setTemplates(await workTaskTemplateList())
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setTemplateBusy(false)
    }
  }

  const deleteTemplate = async (id: number) => {
    try {
      await workTaskTemplateDelete(id)
      setTemplates((prev) => prev.filter((tpl) => tpl.id !== id))
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
        <DialogTitle className="text-base">
          {task ? t("editorTitleEdit") : t("editorTitleNew")}
        </DialogTitle>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("titlePlaceholder")}
          aria-label={t("titleLabel")}
          className="w-full bg-transparent text-lg font-semibold tracking-tight outline-none placeholder:font-normal placeholder:text-muted-foreground/50"
        />

        {/* Agent pill above the composer, as in the automation editor. While
            untouched it mirrors the folder's effective task settings. */}
        <div className="flex flex-wrap items-center gap-2">
          <AgentSelector
            defaultAgentType={agentType}
            onSelect={(a) => {
              setAgentDirty(true)
              setAgentType(a)
              setModeId(null)
              setConfigValues({})
            }}
            // A system substitution (agent unavailable) must not count as a
            // user override choice.
            onFallback={setAgentType}
          />
          {agentDirty ? (
            <button
              type="button"
              onClick={() => setAgentDirty(false)}
              className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {t("agentOverrideReset")}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("agentInheritedHint")}
            </span>
          )}
        </div>

        {/* The conversation composer, whole: `@` references, `/` commands, the
            "+" shortcuts menu and image attachments, with the ACP-probed
            mode/model bar sharing its bottom row. Keyed by the template seed —
            applying a blueprint replaces the draft, attachments included. */}
        <TaskMessageComposer
          key={composerSeed.key}
          ref={composerRef}
          agentType={agentType}
          folderPath={folderPath}
          defaultText={composerSeed.text}
          defaultBlocks={composerSeed.blocks}
          placeholder={t("promptPlaceholder")}
          ariaLabel={t("promptLabel")}
          onChange={setPrompt}
          onAttachmentsChange={setAttachmentCount}
          editorClassName="max-h-[14rem] min-h-[6rem]"
          bottomBarExtra={
            <AgentConfigSection
              agentType={agentOptions.snapshotAgentType}
              snapshot={agentOptions.snapshot}
              loading={agentOptions.loading}
              error={agentOptions.error}
              onReload={agentOptions.reload}
              modeId={modeId}
              configValues={configValues}
              layout="inline"
              onModeChange={(m) => {
                setAgentDirty(true)
                setModeId(m)
              }}
              onConfigChange={(optionId, valueId) => {
                setAgentDirty(true)
                setConfigValues((prev) => {
                  const next = { ...prev }
                  if (valueId === null) delete next[optionId]
                  else next[optionId] = valueId
                  return next
                })
              }}
            />
          }
        />

        {/* Target — which project board the task lives on, and which branch of
            it the task is for. */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {t("sectionTarget")}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <FolderSelect
              variant="field"
              folders={projectFolders}
              value={folderId}
              // A branch belongs to a specific repository, so switching folders
              // drops the previous folder's pick rather than saving it against
              // the new one. In the handler, not a folderId effect, so the
              // initial state never wipes an edited task's branch.
              onChange={(id) => {
                setFolderId(id)
                setBaseBranch("")
              }}
              placeholder={t("folderPlaceholder")}
              // A task that already ran is pinned to its folder (its worktree
              // lives there) — the backend rejects a move too.
              disabled={pinned}
            />
            {choosesBranch ? (
              <BranchPicker
                folderPath={folderPath}
                // Read-only, so it can show the branch the task actually
                // branched from; the moment it is editable again it shows the
                // request, because that is what a save would write back.
                value={pinned ? (task?.base_branch ?? baseBranch) : baseBranch}
                onChange={(b) => setBaseBranch(b)}
                placeholder={t("baseBranchPlaceholder")}
                defaultLabel={t("baseBranchDefault")}
                title={t("baseBranch")}
                // The base is recorded when the worktree is minted, and every
                // later decision (merge, delivery, diff) reads THAT — so once
                // a task has run, its branch is history, not a setting.
                disabled={folderId == null || pinned}
                // The merge lands into the project checkout, which can only be
                // on a local branch.
                allowRemote={false}
              />
            ) : null}
          </div>
          {choosesBranch ? (
            <p className="text-xs text-muted-foreground">
              {t("baseBranchHint")}
            </p>
          ) : null}
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
        <Popover open={templatesOpen} onOpenChange={setTemplatesOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs text-muted-foreground"
            >
              <LayoutTemplate className="size-3.5" aria-hidden="true" />
              {t("templates")}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            ref={contentRef}
            align="start"
            side="top"
            className="w-72 p-2"
            onPointerDownOutside={onPointerDownOutside}
            onFocusOutside={onFocusOutside}
          >
            <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {templates.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t("templatesEmpty")}
                </p>
              ) : (
                templates.map((tpl) => (
                  <div key={tpl.id} className="group flex items-center gap-1">
                    {/* px-2 + gap-1.5 + a size-3.5 glyph puts this row's icon
                        and text on exactly the same two x positions as the
                        save entry below the divider. */}
                    <button
                      type="button"
                      onClick={() => applyTemplate(tpl)}
                      className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <LayoutTemplate
                        className="mt-[3px] size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{tpl.name}</span>
                        {tpl.config?.display_text ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {tpl.config.display_text}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => void deleteTemplate(tpl.id)}
                      aria-label={t("templateDelete")}
                      title={t("templateDelete")}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                ))
              )}
            </div>
            {/* pt-2 matches the popover's own p-2 below the button, so it sits
                the same distance from the divider as from the bottom edge;
                mt-2 mirrors that above the divider. */}
            <div className="mt-2 border-t border-border pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-1.5 px-2 text-xs"
                disabled={
                  templateBusy ||
                  !title.trim() ||
                  (!prompt.trim() && attachmentCount === 0)
                }
                onClick={() => void saveTemplate()}
              >
                <BookmarkPlus className="size-3.5" aria-hidden="true" />
                {t("templateSaveCurrent")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={saving}
          >
            {t("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={saving}>
            {t("save")}
          </Button>
        </div>
      </div>
    </>
  )
}
