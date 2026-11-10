"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CircleDot, GitPullRequest, Info, MessageSquare } from "lucide-react"

import { forgeSettingsGet, forgeSettingsSet } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  DEFAULT_FORGE_AUTO_SETTINGS,
  autoSettingsOf,
  isAutoActive,
  sameAutoSettings,
} from "@/lib/forge-auto"
import {
  effectiveForgeSettings,
  ownForgeSettings,
  FORGE_GLOBAL_SCOPE,
} from "@/lib/forge-settings"
import {
  FORGE_SCENARIO_PROMPT_ALL,
  type ForgeAutoSettings,
  type ForgeScenarioId,
  type ForgeSettingsStore,
} from "@/lib/types"
import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import {
  FolderSelect,
  type FolderSelectOption,
} from "@/components/shared/folder-select"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  ForgeAutoActivity,
  ForgeAutoSettingsSection,
} from "./forge-auto-settings"
import { SCENARIO_LABELS, ScenarioSelect } from "./forge-scenario-select"
import { initialScenario, scenariosForKind } from "./forge-start-dialog"

/** Longest one standing instruction may be — mirrors `settings::PROMPT_CAP`.
 *  Enforced on the field so the cap is a limit you bump into while typing
 *  rather than an error you meet after pressing Save. */
const PROMPT_CAP = 4000

/**
 * The scenario strip of the standing-instructions card, `all` first.
 *
 * One flat list rather than issues-then-changes: what you are picking here is
 * which prompt to edit, and the two kinds never appear together anyway once a
 * task exists.
 */
const PROMPT_KEYS = [
  FORGE_SCENARIO_PROMPT_ALL,
  ...scenariosForKind(false),
  ...scenariosForKind(true),
] as const

/**
 * The repository panel's preferences.
 *
 * Two tabs. "General" holds two things that are deliberately different in
 * kind: what the TRIGGER DIALOG opens with — starting positions for controls
 * you still see and can still change on every item — and standing
 * instructions, which are the opposite: text you will not see again, appended
 * to every task the panel mints for that scenario. "Auto-processing" holds the
 * rules under which the panel mints tasks with nobody pressing Start at all
 * (see `forge-auto-settings.tsx`).
 *
 * Scoped like the task settings one click away: a global row, plus an optional
 * per-folder override that wins WHOLESALE. What it does not replace is a
 * folder's task-settings stage prompts — those cover a stage of a task's life,
 * while these cover a KIND of work item, which the task engine has no word for.
 * See `forge/settings.rs`.
 */
export function ForgeSettingsDialog({
  open,
  onOpenChange,
  folderId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The panel's current folder — the scope this opens on. `null` (no folder
   *  chosen yet) opens on the global row. */
  folderId?: number | null
  /** Hand the stored settings back to the page, so the next trigger dialog
   *  opens on them without a re-fetch. */
  onSaved?: (store: ForgeSettingsStore) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[34rem]">
        {/* Mounted fresh per open, so the form always re-seeds from storage
            rather than showing an abandoned edit from last time. */}
        {open ? (
          <ForgeSettingsBody
            initialFolderId={folderId ?? null}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ForgeSettingsBody({
  initialFolderId,
  onClose,
  onSaved,
}: {
  initialFolderId: number | null
  onClose: () => void
  onSaved?: (store: ForgeSettingsStore) => void
}) {
  const t = useTranslations("Forge")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )
  const [scope, setScope] = useState<number>(
    initialFolderId ?? FORGE_GLOBAL_SCOPE
  )
  return (
    <ForgeSettingsScope
      // Remounted per scope: switching is a fresh load of that row rather than
      // a partial re-seed on top of the previous one's edits.
      key={scope}
      scope={scope}
      onScopeChange={setScope}
      folders={projectFolders}
      folderName={folders.find((f) => f.id === scope)?.name ?? `#${scope}`}
      onClose={onClose}
      onSaved={onSaved}
      t={t}
    />
  )
}

function ForgeSettingsScope({
  scope,
  onScopeChange,
  folders,
  folderName,
  onClose,
  onSaved,
  t,
}: {
  /** `FORGE_GLOBAL_SCOPE` (0) edits the global row. */
  scope: number
  onScopeChange: (scope: number) => void
  folders: readonly FolderSelectOption[]
  folderName: string
  onClose: () => void
  onSaved?: (store: ForgeSettingsStore) => void
  t: ReturnType<typeof useTranslations<"Forge">>
}) {
  const isGlobal = scope === FORGE_GLOBAL_SCOPE
  const [store, setStore] = useState<ForgeSettingsStore | null>(null)
  // Folder scope only: whether this folder follows the global row or has its
  // own. Seeded from what actually exists in storage, so the dialog shows the
  // true source instead of guessing.
  const [source, setSource] = useState<"global" | "custom">("custom")
  const [issueScenario, setIssueScenario] = useState<ForgeScenarioId>("fix")
  const [prScenario, setPrScenario] = useState<ForgeScenarioId>("review_fix")
  const [writeback, setWriteback] = useState(true)
  const [prompts, setPrompts] = useState<Record<string, string>>({})
  const [promptKey, setPromptKey] = useState<string>(PROMPT_KEYS[0])
  const [auto, setAuto] = useState<ForgeAutoSettings>(
    DEFAULT_FORGE_AUTO_SETTINGS
  )
  const [section, setSection] = useState<"general" | "auto">("general")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    forgeSettingsGet()
      .then((loaded) => {
        if (cancelled) return
        const own = ownForgeSettings(loaded, isGlobal ? null : scope)
        // A folder with nothing of its own seeds from what applies to it
        // TODAY — the global row — so flipping to "custom" starts from the
        // values in force rather than from the built-in defaults.
        const s = isGlobal
          ? loaded.global
          : effectiveForgeSettings(loaded, scope)
        setStore(loaded)
        setSource(isGlobal || own != null ? "custom" : "global")
        // The trigger dialog's own guard, shared rather than copied: a stored
        // name from the other kind (or one this build retired) must not leave a
        // select showing nothing, and the two surfaces have to agree on which
        // name that is or the dialog would preview a default it never sends.
        setIssueScenario(initialScenario(false, s?.default_issue_scenario))
        setPrScenario(initialScenario(true, s?.default_pr_scenario))
        setWriteback(s?.writeback_default ?? true)
        setPrompts(s?.scenario_prompts ?? {})
        setAuto(autoSettingsOf(s))
      })
      .catch((e) => {
        if (!cancelled) toast.error(toErrorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [scope, isGlobal])

  // The form is live for the global scope and for a folder editing its own
  // settings; while a folder follows the global row there is nothing here to
  // edit, only a switch back to "custom".
  const editing = isGlobal || source === "custom"

  // What this scope RUNS UNDER as stored — a folder without its own row runs
  // under the global one. "Scan now" scans with exactly this, so it is offered
  // only when the form on screen says the same thing: a scan with rules other
  // than the ones in front of the user would answer a question they did not
  // ask.
  const storedAuto = autoSettingsOf(
    store == null
      ? null
      : isGlobal
        ? store.global
        : effectiveForgeSettings(store, scope)
  )
  // The SOURCE is part of what is stored, not only the values: flipping a
  // folder between its own rules and the global ones, unsaved, leaves the
  // values on screen equal to the stored ones while the scope a scan would
  // run under is about to change.
  const sourceChanged =
    !isGlobal &&
    store != null &&
    (source === "custom") !== (ownForgeSettings(store, scope) != null)
  const scanBlockedReason = !isAutoActive(storedAuto)
    ? t("autoScanNowOff")
    : sourceChanged || !sameAutoSettings(auto, storedAuto)
      ? t("autoScanNowDirty")
      : null

  const save = async () => {
    setSaving(true)
    try {
      // "Use global defaults" saves by dropping the folder's own row.
      const stored = await forgeSettingsSet(
        isGlobal ? null : scope,
        !isGlobal && source === "global"
          ? null
          : {
              default_issue_scenario: issueScenario,
              default_pr_scenario: prScenario,
              writeback_default: writeback,
              // Blank entries are dropped here as well as server-side: the
              // object that comes back is what the page will hand the next
              // trigger dialog, and it should not carry keys that mean nothing.
              scenario_prompts: Object.fromEntries(
                Object.entries(prompts)
                  .map(([key, text]) => [key, text.trim()] as const)
                  .filter(([, text]) => text.length > 0)
              ),
              auto,
            }
      )
      onSaved?.(stored)
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
              the wrong scope. */}
          {isGlobal
            ? t("settingsScopeGlobalHint")
            : t("settingsDescription", { folder: folderName })}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        {/* Which settings row is on screen — chrome, not a setting. Left
            deliberately without a card so it reads as part of the dialog
            header, exactly as the task settings dialog does it. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">
              {t("settingsScope")}
            </span>
            <FolderSelect
              variant="field"
              className="h-8 w-60 max-w-none justify-between text-sm"
              folders={folders}
              value={isGlobal ? null : scope}
              onChange={onScopeChange}
              allLabel={t("settingsScopeGlobal")}
              onSelectAll={() => onScopeChange(FORGE_GLOBAL_SCOPE)}
              title={t("settingsScope")}
            />
          </div>

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
          <Tabs
            value={section}
            onValueChange={(v) => setSection(v === "auto" ? "auto" : "general")}
          >
            {/* Labelled: the General tab nests a second strip (the
                instruction scenarios) whose names could otherwise be read as
                siblings of these two. */}
            <TabsList className="w-full" aria-label={t("settingsSections")}>
              <TabsTrigger value="general" className="flex-1">
                {t("settingsTabGeneral")}
              </TabsTrigger>
              <TabsTrigger value="auto" className="flex-1">
                {t("settingsTabAuto")}
                {/* Says the tab is doing something even while it is not the
                    one on screen — auto-processing runs unattended. */}
                {isAutoActive(auto) ? (
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-primary"
                  />
                ) : null}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="general" className="mt-1 flex flex-col gap-3">
              <SettingCard>
                <SettingRow
                  icon={CircleDot}
                  title={t("settingsIssueDefault")}
                  description={t("settingsIssueDefaultHint")}
                  control={
                    <ScenarioSelect
                      label={t("settingsIssueDefault")}
                      value={issueScenario}
                      options={scenariosForKind(false)}
                      onChange={setIssueScenario}
                    />
                  }
                />
                <SettingRow
                  icon={GitPullRequest}
                  title={t("settingsPrDefault")}
                  description={t("settingsPrDefaultHint")}
                  control={
                    <ScenarioSelect
                      label={t("settingsPrDefault")}
                      value={prScenario}
                      options={scenariosForKind(true)}
                      onChange={setPrScenario}
                    />
                  }
                />
                <SettingRow
                  icon={MessageSquare}
                  title={t("settingsWritebackDefault")}
                  description={t("settingsWritebackDefaultHint")}
                  htmlFor="forge-writeback-default"
                  control={
                    <Switch
                      id="forge-writeback-default"
                      checked={writeback}
                      onCheckedChange={setWriteback}
                    />
                  }
                />
              </SettingCard>

              {/* Where this text ends up, said before the box rather than after
                  it: it is appended AFTER the built-in wording of the scenario
                  and BEFORE whatever is typed in the trigger dialog, which is
                  what stops people from re-stating the built-ins here. */}
              <SettingNote icon={Info}>{t("settingsPromptsIntro")}</SettingNote>
              <Tabs value={promptKey} onValueChange={setPromptKey}>
                <TabsList
                  className="w-full flex-wrap group-data-horizontal/tabs:h-auto"
                  aria-label={t("settingsPromptsLabel")}
                >
                  {PROMPT_KEYS.map((key) => (
                    <TabsTrigger
                      key={key}
                      value={key}
                      className="h-7 px-2 text-xs"
                    >
                      {key === FORGE_SCENARIO_PROMPT_ALL
                        ? t("settingsPromptAll")
                        : t(SCENARIO_LABELS[key])}
                      {/* A dot on the scenarios that already carry text —
                          otherwise an instruction typed once stays hidden behind
                          an unselected segment forever. */}
                      {prompts[key]?.trim() ? (
                        <span
                          aria-hidden
                          className="size-1.5 rounded-full bg-primary"
                        />
                      ) : null}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <SettingCard>
                <SettingRow
                  title={
                    promptKey === FORGE_SCENARIO_PROMPT_ALL
                      ? t("settingsPromptAll")
                      : t(SCENARIO_LABELS[promptKey as ForgeScenarioId])
                  }
                  description={
                    promptKey === FORGE_SCENARIO_PROMPT_ALL
                      ? t("settingsPromptAllHint")
                      : t("settingsPromptScenarioHint")
                  }
                  htmlFor="forge-standing-prompt"
                >
                  <Textarea
                    id="forge-standing-prompt"
                    value={prompts[promptKey] ?? ""}
                    maxLength={PROMPT_CAP}
                    onChange={(e) =>
                      setPrompts((prev) => ({
                        ...prev,
                        [promptKey]: e.target.value,
                      }))
                    }
                    placeholder={t("settingsPromptPlaceholder")}
                    className="max-h-40 min-h-24 overflow-y-auto bg-background text-sm"
                  />
                </SettingRow>
              </SettingCard>
            </TabsContent>
            <TabsContent value="auto" className="mt-1">
              <ForgeAutoSettingsSection
                value={auto}
                onChange={setAuto}
                folderId={isGlobal ? null : scope}
                savedEnabledAt={
                  isAutoActive(storedAuto) ? storedAuto.enabled_at : null
                }
                scanBlockedReason={scanBlockedReason}
              />
            </TabsContent>
          </Tabs>
        ) : store != null && isAutoActive(storedAuto) ? (
          // Following the global row, which runs auto-processing: nothing to
          // edit here, but this folder IS being processed under those rules,
          // and what that has done belongs in front of whoever opened it.
          <ForgeAutoActivity
            folderId={scope}
            scanBlockedReason={scanBlockedReason}
          />
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
        {/* Held until the form has the stored values: saving a form seeded
            with the built-in defaults would overwrite settings the user never
            saw. */}
        <Button type="button" onClick={save} disabled={saving || store == null}>
          {t("save")}
        </Button>
      </DialogFooter>
    </>
  )
}
