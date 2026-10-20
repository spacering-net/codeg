"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Bot,
  GitCommitHorizontal,
  Loader2,
  Pin,
  ScrollText,
} from "lucide-react"
import {
  AgentSelect,
  OptionBlock,
  RequiredOptionRow,
  optionValueLabel,
  type OptionRow,
} from "@/components/settings/agent-options-editor"
import {
  buildAgentConfig,
  effectivePick,
  missingRows,
  rowMark,
  selectionFromOptions,
  EMPTY_SELECTION,
  type AssistantSelection,
} from "@/components/settings/assistant-agent-config"
import {
  RequiredOptionsSection,
  useRequiredOptionsGate,
} from "@/components/settings/required-agent-options"
import { FolderSelect } from "@/components/shared/folder-select"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import {
  deleteCommitMessageSettings,
  getCommitMessageSettings,
  listOpenFolderDetails,
  setCommitMessageSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import type {
  AgentType,
  AssistantAgentConfig,
  CommitMessageSettings,
  FolderDetail,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** The scope picker's id for the global settings; real folders start at 1. */
const GLOBAL_SCOPE = 0

const DEFAULT_SETTINGS: CommitMessageSettings = {
  agent: null,
  instructions: "",
  auto_commit: false,
}

interface CommitMessageSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The project folder the box commits to (a worktree folder's repository):
   *  the scope the dialog opens on. `null` opens the global settings. */
  folderId: number | null
}

/**
 * How commit messages are written — globally, or for one project folder,
 * whose own settings then replace the global ones whole (the task settings'
 * scopes): which agent writes them, either following the session or a
 * specific agent with every option it offers picked, model first (the
 * assistant editor's flow); whether the commit follows on its own; and the
 * user's standing instructions. Opened from where the generator is used, not
 * from Settings.
 */
export function CommitMessageSettingsDialog({
  open,
  onOpenChange,
  folderId,
}: CommitMessageSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Header, scrolling body and footer as three bands, as in the
          assistant editor: an agent's options can run long, and Save stays
          in reach. */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[36rem] [&_[data-slot=dialog-header]]:pr-16">
        {/* Mounted per open, so every open loads what is saved now. */}
        {open ? (
          <CommitMessageSettingsScoped
            initialFolderId={folderId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function CommitMessageSettingsScoped({
  initialFolderId,
  onClose,
}: {
  initialFolderId: number | null
  onClose: () => void
}) {
  const [scope, setScope] = useState<number>(initialFolderId ?? GLOBAL_SCOPE)
  // Switching the scope remounts the body: a clean load of that scope.
  return (
    <CommitMessageSettingsBody
      key={scope}
      folderId={scope}
      onScopeChange={setScope}
      onClose={onClose}
    />
  )
}

/** The workspace's project folders — the scopes a folder's own settings can
 *  be saved for. A window without the workspace loaded (the commit window)
 *  asks for them. */
function useProjectFolders(): FolderDetail[] {
  const workspaceFolders = useAppWorkspaceStore((s) => s.folders)
  const [fetched, setFetched] = useState<FolderDetail[] | null>(null)
  const fetchNeeded = workspaceFolders.length === 0
  useEffect(() => {
    if (!fetchNeeded) return
    let cancelled = false
    listOpenFolderDetails()
      .then((folders) => {
        if (!cancelled) setFetched(folders)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [fetchNeeded])
  return useMemo(
    () =>
      (fetchNeeded ? (fetched ?? []) : workspaceFolders).filter(
        (f) => f.parent_id == null && f.kind === "regular"
      ),
    [fetchNeeded, fetched, workspaceFolders]
  )
}

function CommitMessageSettingsBody({
  folderId,
  onScopeChange,
  onClose,
}: {
  /** `GLOBAL_SCOPE` edits the global settings. */
  folderId: number
  onScopeChange: (folderId: number) => void
  onClose: () => void
}) {
  const t = useTranslations("CommitMessageGeneration.dialog")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const { agents } = useAcpAgents()
  const projectFolders = useProjectFolders()
  const isGlobal = folderId === GLOBAL_SCOPE

  // What applies to the scope now: a folder's own settings, or the global
  // ones it follows (so switching it to its own starts from them).
  const [loaded, setLoaded] = useState<CommitMessageSettings | null>(null)
  // Folder scope only: whether the folder follows the global settings or has
  // its own — seeded from what is saved.
  const [source, setSource] = useState<"global" | "custom">("custom")
  // Whether a specific agent writes the messages; off follows the session.
  const [pinned, setPinned] = useState(false)
  const [agentType, setAgentType] = useState<AgentType | null>(null)
  const [selection, setSelection] =
    useState<AssistantSelection>(EMPTY_SELECTION)
  /** The user changed the agent or any option. */
  const [agentTouched, setAgentTouched] = useState(false)
  /** Display names of the picks made here, by row id — what an
   *  "unavailable (was X)" mark names after a model switch withdrew one. */
  const [pickedLabels, setPickedLabels] = useState<Record<string, string>>({})
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<string>>(new Set())
  const [autoCommit, setAutoCommit] = useState(false)
  const [instructions, setInstructions] = useState("")
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>())

  useEffect(() => {
    let cancelled = false
    Promise.all([
      isGlobal ? Promise.resolve(null) : getCommitMessageSettings(folderId),
      getCommitMessageSettings(null),
    ])
      .then(([own, global]) => {
        if (cancelled) return
        const settings = (isGlobal ? global : (own ?? global)) ?? {
          ...DEFAULT_SETTINGS,
        }
        setLoaded(settings)
        setSource(isGlobal || own != null ? "custom" : "global")
        setPinned(settings.agent != null)
        setAgentType(settings.agent?.agent_type ?? null)
        setSelection(selectionFromOptions(settings.agent?.agent_options))
        setAutoCommit(settings.auto_commit)
        setInstructions(settings.instructions)
      })
      .catch((error) => {
        if (cancelled) return
        toast.error(t("loadFailed"), { description: toErrorMessage(error) })
      })
    return () => {
      cancelled = true
    }
  }, [folderId, isGlobal, t])

  // The form is live for the global scope and for a folder with settings of
  // its own; a folder following the global ones shows none, and probes none.
  const editing = isGlobal || source === "custom"

  // The selection the form was seeded with, while its agent is the one
  // picked: what the marks compare against, and what stands in when the
  // agent's options cannot be read.
  const savedAgent: AssistantAgentConfig | null =
    loaded?.agent && loaded.agent.agent_type === agentType ? loaded.agent : null
  const agentInfo = agents.find((a) => a.agent_type === agentType) ?? null
  // The saved agent can no longer run here: keep it, show what was saved.
  const agentUnavailable =
    savedAgent !== null &&
    !agentTouched &&
    agents.length > 0 &&
    !(agentInfo?.enabled && agentInfo.available)

  const { gate, probe } = useRequiredOptionsGate({
    agentType: loaded && editing && pinned ? agentType : null,
    selection,
    unavailable: agentUnavailable,
  })
  const booleanLabels = { on: tm("booleanOn"), off: tm("booleanOff") }
  const savedMarks = useMemo(
    () =>
      savedAgent
        ? {
            selection: selectionFromOptions(savedAgent.agent_options),
            labels: savedAgent.label_snapshot,
          }
        : null,
    [savedAgent]
  )

  const readyRows = pinned && gate.kind === "ready" ? gate.rows : null
  const missing = readyRows ? missingRows(readyRows, selection) : []
  // Rows that need a pick because the agent's options changed since the save.
  const driftCount =
    readyRows && savedMarks && !agentTouched
      ? readyRows.filter((row) =>
          rowMark(row, selection, savedMarks, pickedLabels)
        ).length
      : 0

  const pickValue = (row: OptionRow, value: string) => {
    setAgentTouched(true)
    setSubmitError(null)
    setInvalidIds((prev) => {
      if (!prev.has(row.id)) return prev
      const next = new Set(prev)
      next.delete(row.id)
      return next
    })
    setPickedLabels((prev) => ({
      ...prev,
      [row.id]: optionValueLabel(row, value, booleanLabels) ?? value,
    }))
    setSelection((prev) =>
      row.kind === "mode"
        ? { ...prev, modeId: value }
        : { ...prev, configValues: { ...prev.configValues, [row.id]: value } }
    )
  }

  const pickAgent = (next: AgentType) => {
    if (next === agentType) return
    setAgentType(next)
    setAgentTouched(true)
    // Every option is the new agent's to pick from scratch.
    setSelection(EMPTY_SELECTION)
    setPickedLabels({})
    setInvalidIds(new Set())
    setSubmitError(null)
  }

  const renderRow = (row: OptionRow, disabled = false) => (
    <OptionBlock key={row.id}>
      <RequiredOptionRow
        row={row}
        value={effectivePick(row, selection)}
        onChange={(value) => pickValue(row, value)}
        disabled={disabled || saving}
        invalid={invalidIds.has(row.id)}
        mark={rowMark(row, selection, savedMarks, pickedLabels)}
        triggerRef={(el) => {
          triggerRefs.current.set(row.id, el)
        }}
      />
    </OptionBlock>
  )

  /** The agent the save stores, or a reason it can't be saved yet. */
  const agentToSave = ():
    | { ok: true; agent: AssistantAgentConfig | null }
    | { ok: false } => {
    if (!pinned) return { ok: true, agent: null }
    if (agentType === null) {
      setSubmitError(ta("pickAgentFirst"))
      return { ok: false }
    }
    if (gate.kind === "ready") {
      const stillMissing = missingRows(gate.rows, selection)
      if (stillMissing.length > 0) {
        setInvalidIds(new Set(stillMissing.map((row) => row.id)))
        setSubmitError(ta("missingCount", { count: stillMissing.length }))
        triggerRefs.current.get(stillMissing[0].id)?.focus()
        return { ok: false }
      }
      return {
        ok: true,
        agent: buildAgentConfig({
          agentType,
          agentLabel: getAgentLabel(agentType) ?? agentType,
          rows: gate.rows,
          selection,
          modeLabel: tm("modeLabel"),
          booleanLabels,
        }),
      }
    }
    if (
      savedAgent &&
      !agentTouched &&
      (gate.kind === "error" ||
        gate.kind === "unavailable-agent" ||
        gate.kind === "not-switched")
    ) {
      // The options cannot be checked right now and were not touched: the
      // rest saves, the saved selection stays as it was.
      return { ok: true, agent: savedAgent }
    }
    setSubmitError(
      gate.kind === "error"
        ? ta("cannotSaveProbeFailed")
        : gate.kind === "pick-model"
          ? ta("missingCount", { count: 1 })
          : gate.kind === "not-switched"
            ? ta("cannotSaveModelNotSwitched")
            : ta("cannotSaveStillLoading")
    )
    if (gate.kind === "pick-model") {
      setInvalidIds(new Set([gate.modelRow.id]))
      triggerRefs.current.get(gate.modelRow.id)?.focus()
    }
    return { ok: false }
  }

  const save = async () => {
    if (saving || loaded == null) return
    setSubmitError(null)
    // "Use the global settings" saves by dropping the folder's own.
    const follow = !isGlobal && source === "global"
    const picked = follow ? null : agentToSave()
    if (picked && !picked.ok) return
    setSaving(true)
    try {
      if (follow) {
        await deleteCommitMessageSettings(folderId)
      } else {
        await setCommitMessageSettings(isGlobal ? null : folderId, {
          agent: picked?.ok ? picked.agent : null,
          instructions: instructions.trim(),
          auto_commit: autoCommit,
        })
      }
      onClose()
    } catch (error) {
      setSubmitError(toErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  // What the footer says while nothing has gone wrong: how far the selection
  // is from complete. A refused save replaces it with the reason.
  const footerHint =
    editing && missing.length > 0
      ? ta("missingCount", { count: missing.length })
      : null

  return (
    <>
      <DialogHeader className="px-4 pt-6 pb-4 sm:px-6">
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        {/* Only the fields scroll. `relative` keeps the selects' hidden
            native inputs inside this box. */}
        <div className="relative min-h-0 flex-1 space-y-3 overflow-y-auto border-y border-border/60 px-4 py-4 sm:px-6">
          {/* Which settings are on screen — chrome, not a setting, so no card:
              muted mini-labels, as in the task settings. */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">
                {t("scope")}
              </span>
              <FolderSelect
                variant="field"
                className="h-8 w-60 max-w-none justify-between text-sm"
                folders={projectFolders}
                value={isGlobal ? null : folderId}
                onChange={onScopeChange}
                allLabel={t("scopeGlobal")}
                onSelectAll={() => onScopeChange(GLOBAL_SCOPE)}
                title={t("scope")}
                disabled={saving}
              />
            </div>
            {isGlobal ? (
              <span className="text-xs leading-5 text-muted-foreground">
                {t("scopeGlobalHint")}
              </span>
            ) : loaded ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("source")}
                  </span>
                  <Tabs
                    value={source}
                    onValueChange={(value) => {
                      setSource(value === "global" ? "global" : "custom")
                      setSubmitError(null)
                    }}
                  >
                    <TabsList className="group-data-horizontal/tabs:h-8">
                      <TabsTrigger
                        value="global"
                        className="px-2.5 text-xs"
                        disabled={saving}
                      >
                        {t("sourceGlobal")}
                      </TabsTrigger>
                      <TabsTrigger
                        value="custom"
                        className="px-2.5 text-xs"
                        disabled={saving}
                      >
                        {t("sourceCustom")}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                <span className="text-xs leading-5 text-muted-foreground">
                  {source === "global"
                    ? t("sourceGlobalFollow")
                    : t("sourceCustomHint")}
                </span>
              </>
            ) : null}
          </div>

          {/* Shown once loaded: a folder that follows the global settings
              would otherwise flash a form of its own first. */}
          {loaded && editing ? (
            <>
              {/* Who writes: the switch, then — when on — the agent and every
                  option it offers as rows of the same card, the assistant
                  editor's layout. */}
              <SettingCard>
                <SettingRow
                  icon={Pin}
                  title={t("pinAgent")}
                  description={
                    pinned ? t("pinAgentHint") : t("followSessionHint")
                  }
                  htmlFor="commit-message-pin-agent"
                  control={
                    <Switch
                      id="commit-message-pin-agent"
                      checked={pinned}
                      disabled={saving}
                      onCheckedChange={(next) => {
                        setPinned(next)
                        setInvalidIds(new Set())
                        setSubmitError(null)
                      }}
                    />
                  }
                />
                {pinned ? (
                  <>
                    <SettingRow
                      icon={Bot}
                      title={ta("agentLabel")}
                      description={
                        agentType === null
                          ? ta("pickAgentFirst")
                          : ta("agentHint")
                      }
                      control={
                        <AgentSelect
                          value={agentType}
                          onChange={pickAgent}
                          agents={agents.filter(
                            (a) => a.enabled || a.agent_type === agentType
                          )}
                          fallbackLabel={savedAgent?.label_snapshot.agent}
                          disabled={saving}
                        />
                      }
                    />
                    {agentType !== null ? (
                      <RequiredOptionsSection
                        gate={gate}
                        loading={probe.loading}
                        saved={agentTouched ? null : savedAgent}
                        driftCount={driftCount}
                        renderRow={renderRow}
                        onRetry={() => probe.reload()}
                      />
                    ) : null}
                  </>
                ) : null}
              </SettingCard>

              <SettingCard>
                <SettingRow
                  icon={GitCommitHorizontal}
                  title={t("autoCommit")}
                  description={t("autoCommitHint")}
                  htmlFor="commit-message-auto-commit"
                  control={
                    <Switch
                      id="commit-message-auto-commit"
                      checked={autoCommit}
                      disabled={saving}
                      onCheckedChange={setAutoCommit}
                    />
                  }
                />
              </SettingCard>

              <SettingCard>
                <SettingRow
                  icon={ScrollText}
                  title={t("instructions")}
                  description={t("instructionsHint")}
                  htmlFor="commit-message-instructions"
                >
                  <Textarea
                    id="commit-message-instructions"
                    dir="auto"
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    placeholder={t("instructionsPlaceholder")}
                    disabled={saving}
                    className="field-scrollbar max-h-48 min-h-20 bg-background text-sm"
                  />
                </SettingRow>
              </SettingCard>
            </>
          ) : null}
        </div>

        <DialogFooter className="items-center gap-3 px-4 py-4 sm:justify-between sm:px-6">
          <p
            className={cn(
              "min-w-0 text-xs leading-5",
              submitError ? "text-destructive" : "text-muted-foreground"
            )}
            role={submitError ? "alert" : undefined}
          >
            {submitError ?? footerHint}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={saving}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={saving || loaded == null}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t("save")}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </>
  )
}
