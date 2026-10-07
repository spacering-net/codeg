"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Bot,
  FolderTree,
  Gauge,
  GitMerge,
  Info,
  Merge,
  MessageSquarePlus,
  PackagePlus,
  ShieldCheck,
  Shrink,
  SquareSlash,
  Trash2,
  Zap,
} from "lucide-react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { AgentSelector } from "@/components/chat/agent-selector"
import {
  AgentConfigSection,
  effectiveSelections,
  snapshotLabels,
} from "@/components/automations/agent-config-section"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  listFolderCommands,
  workTaskSettingsDelete,
  workTaskSettingsGet,
  workTaskSettingsGetOwn,
  workTaskSettingsSet,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"
import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
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
import { DirectoryPathInput } from "@/components/shared/directory-path-input"
import { FolderSelect } from "@/components/shared/folder-select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { AgentType, WorkTaskFolderSettings } from "@/lib/types"

/** Sentinel folder id of the global-defaults settings row (backend contract). */
const GLOBAL_SCOPE = 0

/**
 * The launch stages a task flows through, in the order they can happen. The
 * keys are the engine's own stage ids (the `round` event's `kind`), so the
 * labels here are literally the ones the transcript shows above each round —
 * `all` is the extra bucket appended to every stage.
 */
const PROMPT_STAGES = [
  {
    key: "all",
    labelKey: "settingsPromptStageAll",
    hintKey: "settingsPromptHintAll",
    placeholderKey: "settingsPromptPlaceholderAll",
  },
  {
    key: "work",
    labelKey: "phaseWork",
    hintKey: "settingsPromptHintWork",
    placeholderKey: "settingsPromptPlaceholderWork",
  },
  {
    key: "retry",
    labelKey: "phaseRetry",
    hintKey: "settingsPromptHintRetry",
    placeholderKey: "settingsPromptPlaceholderRetry",
  },
  {
    key: "return",
    labelKey: "phaseReturn",
    hintKey: "settingsPromptHintReturn",
    placeholderKey: "settingsPromptPlaceholderReturn",
  },
  {
    key: "merge",
    labelKey: "phaseMerge",
    hintKey: "settingsPromptHintMerge",
    placeholderKey: "settingsPromptPlaceholderMerge",
  },
] as const

/**
 * The two ways a finished task can land. Rendered as side-by-side option cards
 * rather than a dropdown so both trade-offs are readable at once — the choice
 * is made rarely and the wording ("tidier history" vs "every step traceable")
 * is the whole decision.
 */
const MERGE_STRATEGIES = [
  {
    value: "squash",
    labelKey: "strategySquash",
    hintKey: "strategySquashHint",
  },
  { value: "merge", labelKey: "strategyMerge", hintKey: "strategyMergeHint" },
] as const

/**
 * Shared tab body. The floor is the natural height of the Prompts tab, so
 * every tab settles at the same height instead of the dialog resizing under
 * the pointer as you move along the strip; a tab that is genuinely taller
 * grows past it.
 */
const TAB_BODY_CLASS = "mt-1 flex min-h-[19.5rem] flex-col gap-3"

interface TaskSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Board's current folder selection; null = "all folders" → global scope. */
  folderId: number | null
}

/**
 * Task defaults, per folder or global, grouped into four tabs: General (the
 * processing agent + its ACP-probed mode/model options, auto-process, max
 * concurrency), Merge (how a finished task lands), Worktree (where the task's
 * worktree is created and what runs inside it) and Prompts (per-stage
 * instructions appended to what the engine sends the agent). The scope
 * selector above the tabs switches which settings row is being edited; the
 * global row (folder id 0) applies wholesale to folders that never saved their
 * own.
 *
 * Every option is rendered as a `SettingRow` inside a `SettingCard`, and the
 * cards are the grouping: options that are one decision (merge strategy and
 * what happens to the worktree afterwards; auto-process and its concurrency
 * limit) share a card so they read together instead of as a flat list.
 */
export function TaskSettingsDialog({
  open,
  onOpenChange,
  folderId,
}: TaskSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[34rem]">
        {open ? (
          <TaskSettingsScoped
            initialFolderId={folderId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TaskSettingsScoped({
  initialFolderId,
  onClose,
}: {
  initialFolderId: number | null
  onClose: () => void
}) {
  // Mounted fresh per dialog open, so the scope re-seeds from the board's
  // selection every time; switching remounts the body wholesale (clean load).
  const [scope, setScope] = useState<number>(initialFolderId ?? GLOBAL_SCOPE)
  return (
    <TaskSettingsBody
      key={scope}
      folderId={scope}
      onScopeChange={setScope}
      onClose={onClose}
    />
  )
}

function TaskSettingsBody({
  folderId,
  onScopeChange,
  onClose,
}: {
  /** `GLOBAL_SCOPE` (0) edits the global-defaults row. */
  folderId: number
  onScopeChange: (folderId: number) => void
  onClose: () => void
}) {
  const t = useTranslations("Tasks")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const isGlobal = folderId === GLOBAL_SCOPE
  const folder = useMemo(
    () => (isGlobal ? null : (folders.find((f) => f.id === folderId) ?? null)),
    [folders, folderId, isGlobal]
  )
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )

  const [loaded, setLoaded] = useState<WorkTaskFolderSettings | null>(null)
  // Folder scope only: whether this folder follows the global defaults or has
  // its own settings row. Seeded from what actually exists in the DB, so the
  // dialog shows the true source instead of guessing.
  const [source, setSource] = useState<"global" | "custom">("custom")
  const [agentType, setAgentType] = useState<AgentType>("claude_code")
  const [modeId, setModeId] = useState<string | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [autoProcess, setAutoProcess] = useState(false)
  const [maxConcurrent, setMaxConcurrent] = useState("2")
  const [mergeStrategy, setMergeStrategy] = useState<"squash" | "merge">(
    "squash"
  )
  const [autoMerge, setAutoMerge] = useState(false)
  const [deleteWorktreeDefault, setDeleteWorktreeDefault] = useState(true)
  const [worktreeRoot, setWorktreeRoot] = useState("")
  const [initCommand, setInitCommand] = useState("")
  const [autoCompactPercent, setAutoCompactPercent] = useState("0")
  const [compactCommand, setCompactCommand] = useState("")
  const [preflightCommand, setPreflightCommand] = useState("")
  const [stagePrompts, setStagePrompts] = useState<Record<string, string>>({})
  const [stage, setStage] = useState<string>(PROMPT_STAGES[0].key)
  const [tab, setTab] = useState("general")
  const [saving, setSaving] = useState(false)
  const activeStage =
    PROMPT_STAGES.find((s) => s.key === stage) ?? PROMPT_STAGES[0]

  useEffect(() => {
    let cancelled = false

    // Folder scope loads the folder's OWN row (may be absent) plus the global
    // row: the own row decides the source indicator, and the global values
    // seed the form when the folder has nothing of its own — so flipping to
    // "custom" starts from what actually applies today. Folder commands are
    // only fetched to migrate a legacy id-based preflight selection into the
    // free-text field (saving always writes text now).
    Promise.all([
      isGlobal ? Promise.resolve(null) : workTaskSettingsGetOwn(folderId),
      workTaskSettingsGet(GLOBAL_SCOPE),
      isGlobal
        ? Promise.resolve([])
        : listFolderCommands(folderId).catch(() => []),
    ])
      .then(([own, global, commands]) => {
        if (cancelled) return
        const s = isGlobal ? global : (own ?? global)
        setLoaded(s)
        setSource(isGlobal || own != null ? "custom" : "global")
        setAgentType(
          s.default_agent_type ?? folder?.default_agent_type ?? "claude_code"
        )
        setModeId(s.mode_id ?? null)
        setConfigValues(s.config_values ?? {})
        setAutoProcess(s.auto_process)
        setMaxConcurrent(String(s.max_concurrent))
        setMergeStrategy(s.merge_strategy === "merge" ? "merge" : "squash")
        setAutoMerge(s.auto_merge)
        setDeleteWorktreeDefault(s.delete_worktree_default)
        setWorktreeRoot(s.worktree_root ?? "")
        setInitCommand(s.init_command ?? "")
        setAutoCompactPercent(String(s.auto_compact_percent ?? 0))
        setCompactCommand(s.compact_command ?? "")
        setStagePrompts(s.stage_prompts ?? {})
        const legacy =
          s.preflight_command_id != null
            ? (commands.find((c) => c.id === s.preflight_command_id)?.command ??
              "")
            : ""
        setPreflightCommand(s.preflight_command?.trim() || legacy)
      })
      .catch((e) => {
        if (!cancelled) toast.error(toErrorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [folderId, folder?.default_agent_type, isGlobal])

  // The form (and thus the config surface) is live for the global scope and
  // for a folder editing its own settings; while a folder follows the global
  // defaults the form is hidden and the agent probe is skipped.
  const editing = isGlobal || source === "custom"

  const agentOptions = useAgentOptions(
    agentType,
    folder?.path ?? null,
    loaded != null && editing
  )

  const save = async () => {
    setSaving(true)
    try {
      // "Use global defaults" saves by dropping the folder's own row.
      if (!isGlobal && source === "global") {
        await workTaskSettingsDelete(folderId)
        onClose()
        return
      }
      const snapshot = await agentOptions.ensure()
      const { mode_id, config_values } = effectiveSelections(
        snapshot,
        modeId,
        configValues
      )
      const parsed = Number.parseInt(maxConcurrent, 10)
      // A percentage the box can't represent (blank, or typed past 100) reads
      // as "off" rather than as an accidental compact-every-round.
      const compactPercent = Number.parseInt(autoCompactPercent, 10)
      const settings: WorkTaskFolderSettings = {
        default_agent_type: agentType,
        mode_id,
        config_values,
        label_snapshot: {
          agent_label: getAgentLabel(agentType) ?? agentType,
          ...snapshotLabels(snapshot, mode_id, config_values),
        },
        auto_process: autoProcess,
        max_concurrent: Number.isFinite(parsed) && parsed >= 0 ? parsed : 2,
        merge_strategy: mergeStrategy,
        auto_merge: autoMerge,
        delete_worktree_default: deleteWorktreeDefault,
        // Blank = the default layout (next to the project folder), which is
        // also what an absent field means to the engine — so an emptied box
        // is stored as null rather than as an empty directory name.
        worktree_root: worktreeRoot.trim() || null,
        // Free text is the only surface now; a legacy id was migrated into
        // the text field on load, so the id is always cleared on save.
        preflight_command_id: null,
        preflight_command: preflightCommand.trim() || null,
        init_command: initCommand.trim() || null,
        auto_compact_percent:
          Number.isFinite(compactPercent) &&
          compactPercent > 0 &&
          compactPercent <= 100
            ? compactPercent
            : 0,
        compact_command: compactCommand.trim() || null,
        // Blank stages are dropped rather than stored as "" — the engine
        // trims anyway, and an empty entry would only add noise to the blob.
        stage_prompts: Object.fromEntries(
          Object.entries(stagePrompts)
            .map(([key, text]) => [key, text.trim()] as const)
            .filter(([, text]) => text.length > 0)
        ),
      }
      await workTaskSettingsSet(folderId, settings)
      onClose()
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("settingsTitle")}</DialogTitle>
        <DialogDescription>
          {/* Keyed off the scope, not off whether the folder resolves: a folder
              that left the workspace while the dialog was open still owns the
              row `save` writes to, so calling that "global defaults" would name
              the wrong scope. It falls back to the id, like the picker. */}
          {isGlobal
            ? t("settingsScopeGlobalHint")
            : t("settingsDescription", {
                folder: folder?.name ?? `#${folderId}`,
              })}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        {/* Which settings row is on screen — chrome, not a setting. Left
            deliberately without a card so it reads as part of the dialog
            header: muted mini-labels against the `text-sm` titles the cards
            below use, so the eye separates "what am I editing" from "what am
            I changing" without a box around either. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">
              {t("settingsScope")}
            </span>
            {/* The shared searchable picker: the global-defaults row rides in
                as its pinned "all folders" entry, and each folder shows
                `alias [ name ]` over its path. */}
            <FolderSelect
              variant="field"
              className="h-8 w-60 max-w-none justify-between text-sm"
              folders={projectFolders}
              value={isGlobal ? null : folderId}
              onChange={onScopeChange}
              allLabel={t("settingsScopeGlobal")}
              onSelectAll={() => onScopeChange(GLOBAL_SCOPE)}
              title={t("settingsScope")}
            />
          </div>

          {/* Folder scope: which source is in effect — following the global
              defaults, or this folder's own row. Seeded from the DB truth. */}
          {!isGlobal ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("settingsSource")}
                </span>
                <Tabs
                  value={source}
                  onValueChange={(v) =>
                    setSource(v === "global" ? "global" : "custom")
                  }
                >
                  <TabsList className="group-data-horizontal/tabs:h-8">
                    <TabsTrigger value="global" className="px-2.5 text-xs">
                      {t("settingsSourceGlobal")}
                    </TabsTrigger>
                    <TabsTrigger value="custom" className="px-2.5 text-xs">
                      {t("settingsSourceCustom")}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              <span className="text-xs leading-5 text-muted-foreground">
                {source === "global"
                  ? t("settingsSourceGlobalFollow")
                  : t("settingsSourceCustomHint")}
              </span>
            </>
          ) : null}
        </div>

        {editing ? (
          <Tabs value={tab} onValueChange={setTab}>
            {/* Labelled because the Prompts tab nests a second strip whose
                stages carry some of the same words ("Merge"), and a bare
                "tab named Merge" would otherwise be ambiguous to a screen
                reader — and to a test. */}
            <TabsList className="w-full" aria-label={t("settingsTitle")}>
              <TabsTrigger value="general" className="flex-1">
                {t("settingsTabGeneral")}
              </TabsTrigger>
              <TabsTrigger value="merge" className="flex-1">
                {t("settingsTabMerge")}
              </TabsTrigger>
              <TabsTrigger value="worktree" className="flex-1">
                {t("settingsTabWorktree")}
              </TabsTrigger>
              <TabsTrigger value="prompts" className="flex-1">
                {t("settingsTabPrompts")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="general" className={TAB_BODY_CLASS}>
              <SettingCard>
                <SettingRow icon={Bot} title={t("settingsAgent")}>
                  <div className="flex flex-col gap-2.5">
                    <div className="flex">
                      <AgentSelector
                        defaultAgentType={agentType}
                        onSelect={(a) => {
                          setAgentType(a)
                          setModeId(null)
                          setConfigValues({})
                        }}
                        onFallback={setAgentType}
                      />
                    </div>
                    <AgentConfigSection
                      agentType={agentOptions.snapshotAgentType}
                      snapshot={agentOptions.snapshot}
                      loading={agentOptions.loading}
                      error={agentOptions.error}
                      onReload={agentOptions.reload}
                      modeId={modeId}
                      configValues={configValues}
                      layout="inline"
                      onModeChange={setModeId}
                      onConfigChange={(optionId, valueId) =>
                        setConfigValues((prev) => {
                          const next = { ...prev }
                          if (valueId === null) delete next[optionId]
                          else next[optionId] = valueId
                          return next
                        })
                      }
                    />
                  </div>
                </SettingRow>
              </SettingCard>

              {/* The switch that starts work and the valve that limits it —
                  one card, because reading either alone tells you half. */}
              <SettingCard>
                <SettingRow
                  icon={Zap}
                  title={t("settingsAutoProcess")}
                  description={t("settingsAutoProcessHint")}
                  htmlFor="task-auto-process"
                  control={
                    <Switch
                      id="task-auto-process"
                      checked={autoProcess}
                      onCheckedChange={setAutoProcess}
                    />
                  }
                />
                <SettingRow
                  icon={Gauge}
                  title={t("settingsMaxConcurrent")}
                  description={t("settingsMaxConcurrentHint")}
                  htmlFor="task-max-concurrent"
                  control={
                    <Input
                      id="task-max-concurrent"
                      inputMode="numeric"
                      value={maxConcurrent}
                      onChange={(e) =>
                        setMaxConcurrent(e.target.value.replace(/[^0-9]/g, ""))
                      }
                      className="h-8 w-16 bg-background text-center"
                    />
                  }
                />
              </SettingCard>

              {/* Every round after the first resumes the same session, so its
                  context only grows. The threshold and the command that acts
                  on it belong together: the second is unreadable without the
                  first. */}
              <SettingCard>
                <SettingRow
                  icon={Shrink}
                  title={t("settingsAutoCompact")}
                  description={t("settingsAutoCompactHint")}
                  htmlFor="task-auto-compact"
                  control={
                    <div className="flex items-center gap-1.5">
                      <Input
                        id="task-auto-compact"
                        inputMode="numeric"
                        value={autoCompactPercent}
                        onChange={(e) =>
                          setAutoCompactPercent(
                            e.target.value.replace(/[^0-9]/g, "").slice(0, 3)
                          )
                        }
                        className="h-8 w-16 bg-background text-center"
                      />
                      <span className="text-xs text-muted-foreground">%</span>
                    </div>
                  }
                />
                <SettingRow
                  icon={SquareSlash}
                  title={t("settingsCompactCommand")}
                  description={t("settingsCompactCommandHint")}
                  htmlFor="task-compact-command"
                >
                  <Input
                    id="task-compact-command"
                    value={compactCommand}
                    onChange={(e) => setCompactCommand(e.target.value)}
                    placeholder={t("settingsCompactCommandPlaceholder")}
                    className="h-8 bg-background font-mono text-xs"
                  />
                </SettingRow>
              </SettingCard>
            </TabsContent>

            {/* Landing a task: how the commits are recorded, whether it lands
                without you, and what happens to the worktree right after.
                Plain-language options, no git jargon. */}
            <TabsContent value="merge" className={TAB_BODY_CLASS}>
              <SettingCard>
                <SettingRow
                  icon={GitMerge}
                  title={t("settingsMergeStrategy")}
                  description={t("settingsMergeStrategyHint")}
                >
                  <div
                    role="radiogroup"
                    aria-label={t("settingsMergeStrategy")}
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    {MERGE_STRATEGIES.map((opt) => {
                      const active = mergeStrategy === opt.value
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setMergeStrategy(opt.value)}
                          className={cn(
                            "flex gap-2 rounded-lg border p-2.5 text-left transition-colors",
                            "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                            active
                              ? "border-primary/60 bg-primary/5"
                              : "border-border/70 bg-background hover:bg-accent/40"
                          )}
                        >
                          {/* The tinted fill alone is nearly invisible in the
                              neutral theme, so the dot carries the state. */}
                          <span
                            aria-hidden="true"
                            className={cn(
                              "mt-px flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                              active
                                ? "border-primary bg-primary"
                                : "border-muted-foreground/40"
                            )}
                          >
                            {active ? (
                              <span className="size-1.5 rounded-full bg-background" />
                            ) : null}
                          </span>
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="text-xs font-medium">
                              {t(opt.labelKey)}
                            </span>
                            <span className="text-[0.6875rem] leading-4 text-muted-foreground">
                              {t(opt.hintKey)}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </SettingRow>
                {/* Unattended landing: same dispatch as the merge button, so
                    it sits between "how commits land" and "what happens to the
                    worktree" — the two knobs it inherits. */}
                <SettingRow
                  icon={Merge}
                  title={t("settingsAutoMerge")}
                  description={t("settingsAutoMergeHint")}
                  htmlFor="task-auto-merge"
                  control={
                    <Switch
                      id="task-auto-merge"
                      checked={autoMerge}
                      onCheckedChange={setAutoMerge}
                    />
                  }
                />
                <SettingRow
                  icon={Trash2}
                  title={t("settingsDeleteWorktree")}
                  description={t("settingsDeleteWorktreeHint")}
                  htmlFor="task-delete-worktree"
                  control={
                    <Switch
                      id="task-delete-worktree"
                      checked={deleteWorktreeDefault}
                      onCheckedChange={setDeleteWorktreeDefault}
                    />
                  }
                />
                {/* Writing the outcome back to the issue/PR used to be a
                    switch here. It moved into the workbench's own start
                    dialog: it is the one thing a task does in a thread other
                    people are reading, so it is asked per work item, in front
                    of the item. */}
              </SettingCard>
            </TabsContent>

            {/* A worktree's life, in order: where it is created, what runs in
                it once it exists, and what has to pass before it lands. */}
            <TabsContent value="worktree" className={TAB_BODY_CLASS}>
              <SettingCard>
                <SettingRow
                  icon={FolderTree}
                  title={t("settingsWorktreeRoot")}
                  description={t("settingsWorktreeRootHint")}
                  htmlFor="task-worktree-root"
                >
                  <DirectoryPathInput
                    id="task-worktree-root"
                    value={worktreeRoot}
                    onValueChange={setWorktreeRoot}
                    placeholder={t("settingsWorktreeRootPlaceholder")}
                    browseLabel={t("settingsWorktreeRootBrowse")}
                    browserTitle={t("settingsWorktreeRoot")}
                    // The in-app browser (web / remote workspace) opens where
                    // the worktrees would go today, so "one level up" is a
                    // click away instead of a walk from the home directory.
                    initialPath={folder?.path ?? undefined}
                    className="h-8 bg-background font-mono text-xs"
                  />
                </SettingRow>
                <SettingRow
                  icon={PackagePlus}
                  title={t("settingsInitCommand")}
                  description={t("settingsInitCommandHint")}
                  htmlFor="task-init-command"
                >
                  <Input
                    id="task-init-command"
                    value={initCommand}
                    onChange={(e) => setInitCommand(e.target.value)}
                    placeholder={t("settingsInitCommandPlaceholder")}
                    className="h-8 bg-background font-mono text-xs"
                  />
                </SettingRow>
                <SettingRow
                  icon={ShieldCheck}
                  title={t("settingsPreflight")}
                  description={t("settingsPreflightHint")}
                  htmlFor="task-preflight-command"
                >
                  <Input
                    id="task-preflight-command"
                    value={preflightCommand}
                    onChange={(e) => setPreflightCommand(e.target.value)}
                    placeholder={t("settingsPreflightCustomPlaceholder")}
                    className="h-8 bg-background font-mono text-xs"
                  />
                </SettingRow>
              </SettingCard>
            </TabsContent>

            {/* Free-form text appended after the built-in instructions of one
                launch stage. The stage strip doubles as the field's label —
                a dot marks the stages that already carry text, so nothing
                stays hidden behind an unselected segment. */}
            <TabsContent value="prompts" className={TAB_BODY_CLASS}>
              {/* What this tab is: the engine composes a fixed prompt per stage
                  and appends this text under "Additional instructions" — see
                  compose_prompt in work_task/engine.rs. Saying so up front is
                  what stops people from re-stating the built-ins here. */}
              <SettingNote icon={Info}>{t("settingsPromptsIntro")}</SettingNote>
              <Tabs value={stage} onValueChange={setStage}>
                <TabsList
                  className="w-full flex-wrap group-data-horizontal/tabs:h-auto"
                  aria-label={t("settingsTabPrompts")}
                >
                  {PROMPT_STAGES.map((s) => (
                    <TabsTrigger
                      key={s.key}
                      value={s.key}
                      className="h-7 px-2 text-xs"
                    >
                      {t(s.labelKey)}
                      {stagePrompts[s.key]?.trim() ? (
                        <span
                          aria-hidden
                          className="size-1.5 rounded-full bg-primary"
                        />
                      ) : null}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {/* The card restates the selected stage, so the text you type is
                  always framed by when it will be sent — and each stage carries
                  its own example, since what belongs in "merge" is nothing like
                  what belongs in "rework". */}
              <SettingCard>
                <SettingRow
                  icon={MessageSquarePlus}
                  title={t(activeStage.labelKey)}
                  description={t(activeStage.hintKey)}
                  htmlFor="task-stage-prompt"
                >
                  <Textarea
                    id="task-stage-prompt"
                    aria-label={t(activeStage.labelKey)}
                    value={stagePrompts[stage] ?? ""}
                    onChange={(e) =>
                      setStagePrompts((prev) => ({
                        ...prev,
                        [stage]: e.target.value,
                      }))
                    }
                    placeholder={t(activeStage.placeholderKey)}
                    className="max-h-48 min-h-24 overflow-y-auto bg-background text-sm"
                  />
                </SettingRow>
              </SettingCard>
            </TabsContent>
          </Tabs>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={saving}
        >
          {t("cancel")}
        </Button>
        <Button
          type="button"
          onClick={save}
          disabled={saving || loaded == null}
        >
          {t("save")}
        </Button>
      </DialogFooter>
    </>
  )
}
