"use client"

import { useRef, type ReactNode } from "react"
import { CircleCheck, Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { joinFsPath } from "@/lib/path-utils"
import { planEffects } from "@/lib/harness/skill-links"
import {
  closeSkillsDialog,
  openSkillTarget,
  planAgentDelete,
  runAdopt,
  runBackupDelete,
  runCopy,
  runDelete,
  runRestore,
  SKILLS_DIALOG,
  SKILLS_LINKS,
  updateSkillsDialog,
  type BackupDeleteDialog,
  type BackupRestoreDialog,
  type SkillAdoptDialog,
  type SkillCopyDialog,
  type SkillDeleteDialog,
} from "@/lib/harness/skills-state"
import { skillIdProblem } from "@/lib/skills/ids"
import {
  baseName,
  cellView,
  seenBy,
  type SkillsModel,
} from "@/lib/skills/model"
import { agentSkillFacts } from "@/lib/skills/normalize"
import type { SkillBackup, StoreSkill } from "@/lib/skills/types"
import { Code } from "../discover/detail-sections"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { sharedReaders } from "./agent-view"
import { FailureNote, FailureText, IssueList, SkillPath } from "./skill-bits"
import { SkillEditorDialog } from "./skill-editor-dialog"
import { useSkillsLabels } from "./use-skills-labels"

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

function Done({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="flex min-w-0 items-start gap-2 rounded-lg bg-tone-success/10 px-3 py-2 text-sm"
    >
      <CircleCheck
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-tone-success"
      />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** An id for a new Custom skill, checked as it is typed. */
function NewIdField({
  id,
  value,
  model,
  onChange,
  onEnter,
}: {
  id: string
  value: string
  model: SkillsModel | null
  onChange: (value: string) => void
  onEnter: () => void
}) {
  const t = useTranslations("Harness.skills.editor")
  const trimmed = value.trim()
  const problem = skillIdProblem(trimmed)
  const taken = problem === null && (model?.takenIds.has(trimmed) ?? false)
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {t("id")}
      </label>
      <Input
        id={id}
        value={value}
        dir="ltr"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        maxLength={200}
        aria-invalid={problem === "invalid" || taken || undefined}
        className="font-mono text-[0.8125rem] max-md:h-10"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) onEnter()
        }}
      />
      {(problem === "invalid" || taken) && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span className="min-w-0">
            {problem === "invalid"
              ? t("idInvalid")
              : t.rich("idTaken", { id: trimmed, code })}
          </span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t("idRule")}</p>
    </div>
  )
}

export function newIdUsable(value: string, model: SkillsModel | null) {
  const trimmed = value.trim()
  return (
    skillIdProblem(trimmed) === null && !(model?.takenIds.has(trimmed) ?? false)
  )
}

// ─── Copy as a Custom skill ───────────────────────────────────────────

function CopyDialog({
  dialog,
  model,
}: {
  dialog: SkillCopyDialog
  model: SkillsModel | null
}) {
  const t = useTranslations("Harness.skills.copy")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const { slots } = useHarnessView()
  const inputRef = useRef<HTMLDivElement>(null)
  const saving = dialog.phase === "saving"
  const usable = newIdUsable(dialog.newId, model)
  const source = model?.skill(dialog.sourceId)
  const run = () => usable && !saving && void runCopy(slots, dialog.id)
  return (
    <McpDialogFrame
      title={t.rich(source?.origin === "custom" ? "titleDuplicate" : "title", {
        id: dialog.sourceId,
        code,
      })}
      onRequestClose={() => !saving && closeSkillsDialog(slots, dialog.id)}
      initialFocus={() => inputRef.current?.querySelector("input") ?? null}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => closeSkillsDialog(slots, dialog.id)}
          >
            {tDialog("cancel")}
          </Button>
          <Button type="button" disabled={!usable || saving} onClick={run}>
            {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
            {t("confirm")}
          </Button>
        </>
      }
    >
      <div ref={inputRef} className="min-w-0 space-y-4">
        <p className="text-sm text-muted-foreground">{t("about")}</p>
        <NewIdField
          id={`copy-id-${dialog.id}`}
          value={dialog.newId}
          model={model}
          onChange={(newId) =>
            updateSkillsDialog(slots, dialog.id, "copy", (prev) => ({
              ...prev,
              newId,
              failure: null,
            }))
          }
          onEnter={run}
        />
        {dialog.failure && (
          <FailureNote>
            <FailureText failure={dialog.failure} />
          </FailureNote>
        )}
      </div>
    </McpDialogFrame>
  )
}

// ─── Delete ───────────────────────────────────────────────────────────

function DeleteDialog({
  dialog,
  model,
}: {
  dialog: SkillDeleteDialog
  model: SkillsModel | null
}) {
  const t = useTranslations("Harness.skills.delete")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const labels = useSkillsLabels()
  const { slots } = useHarnessView()
  const saving = dialog.phase === "saving"
  const target = dialog.target
  const close = () => closeSkillsDialog(slots, dialog.id)

  let title: ReactNode
  let body: ReactNode
  if (target.kind === "custom") {
    const skills = target.ids.map((id) => model?.skill(id)).filter(Boolean)
    const keepsCopy = (skill: StoreSkill, agent: string) => {
      const cell = skill.cells.find((item) => item.agent === agent)
      return (
        cell !== undefined &&
        cellView(cell, model?.agent(cell.agent)).kind === "copyChanged"
      )
    }
    // An agent with a copy changed on its side keeps that copy: it does not
    // lose the skill.
    const losers = [
      ...new Set(
        skills.flatMap((skill) =>
          skill ? seenBy(skill).filter((agent) => !keepsCopy(skill, agent)) : []
        )
      ),
    ]
    const changedCopies = skills.some((skill) =>
      skill?.cells.some((cell) => keepsCopy(skill, cell.agent))
    )
    const backups = skills.some((skill) => (skill?.backups ?? 0) > 0)
    title =
      target.ids.length === 1
        ? t.rich("titleCustom", { id: target.ids[0], code })
        : t("titleCustomMany", { count: target.ids.length })
    body = (
      <div className="min-w-0 space-y-3 text-sm">
        <p>{t("customReach", { count: target.ids.length })}</p>
        {target.ids.length === 1 && skills[0] && (
          <SkillPath path={skills[0].path} className="text-xs" />
        )}
        {losers.length > 0 ? (
          <p>{t("losers", { agents: labels.agents(losers) })}</p>
        ) : (
          <p className="text-muted-foreground">{t("noLosers")}</p>
        )}
        {changedCopies && (
          <p className="text-muted-foreground">{t("changedCopiesKept")}</p>
        )}
        {backups && <p className="text-muted-foreground">{t("backupsKept")}</p>}
        <p className="text-muted-foreground">{t("undo")}</p>
      </div>
    )
  } else {
    const facts = agentSkillFacts(target.item)
    const plan = dialog.plan
    // What the backend says it deletes, once it has said; until then, what
    // the listing says it is.
    const link = plan
      ? plan.kind === "link" || plan.kind === "broken_link"
      : facts.linkTarget !== null || facts.owner === "broken"
    const readers = plan?.shared_with ?? []
    title = t.rich(link ? "titleLink" : "titleAgent", {
      id: target.item.id,
      agent: labels.agent(target.agent),
      code,
    })
    body = (
      <div className="min-w-0 space-y-3 text-sm">
        {dialog.notice === "changed" && (
          <p
            role="status"
            className="rounded-lg bg-muted/60 px-3 py-2 text-muted-foreground"
          >
            {t("changed")}
          </p>
        )}
        <p>{link ? t("linkReach") : t("agentReach")}</p>
        <SkillPath path={plan?.path || target.item.path} className="text-xs" />
        {dialog.phase === "checking" ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {t("checking")}
          </p>
        ) : !plan ? (
          dialog.failure && (
            <FailureNote>
              <p>{t("checkFailed")}</p>
              <FailureText failure={dialog.failure} />
            </FailureNote>
          )
        ) : readers.length > 0 ? (
          <p className="flex min-w-0 items-start gap-1.5 text-tone-warning">
            <TriangleAlert
              aria-hidden="true"
              className="mt-1 size-3.5 shrink-0"
            />
            <span className="min-w-0">
              {t("sharedReach", { agents: labels.agents(readers) })}
            </span>
          </p>
        ) : target.item.scope === "project" ? (
          <p className="text-muted-foreground">{t("projectReach")}</p>
        ) : (
          <p className="text-muted-foreground">
            {t("onlyThisAgent", { agent: labels.agent(target.agent) })}
          </p>
        )}
        {!link && plan && <p className="text-muted-foreground">{t("undo")}</p>}
      </div>
    )
  }

  if (dialog.phase === "result" && dialog.done && !dialog.done.deleted) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {t("nothingDeleted")}
      </p>
    )
  } else if (dialog.phase === "result") {
    const failed = (dialog.results ?? []).filter((result) => !result.ok)
    body = (
      <div role="status" className="min-w-0 space-y-3">
        <FailureNote>
          <p>{t("failed")}</p>
          {dialog.failure && <FailureText failure={dialog.failure} />}
        </FailureNote>
        {failed.length > 0 && (
          <ul className="space-y-2 text-xs">
            {failed.map((result) => (
              <li key={result.id} className="min-w-0">
                <bdi dir="ltr" className="font-mono">
                  {result.id}
                </bdi>
                <IssueList
                  issues={[
                    {
                      code: result.code ?? "unknown_failure",
                      detail: result.error ?? undefined,
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <McpDialogFrame
      title={title}
      onRequestClose={() => !saving && close()}
      footer={
        dialog.phase === "result" ? (
          <Button type="button" onClick={close}>
            {tDialog("close")}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={close}
            >
              {tDialog("cancel")}
            </Button>
            {target.kind === "agent" &&
            dialog.phase === "confirm" &&
            !dialog.plan ? (
              <Button
                type="button"
                onClick={() => void planAgentDelete(slots, dialog.id, null)}
              >
                <RefreshCw aria-hidden="true" />
                {tDialog("checkAgain")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="destructive"
                disabled={saving || dialog.phase === "checking"}
                onClick={() => void runDelete(slots, dialog.id)}
              >
                {saving && (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                )}
                {t("confirm")}
              </Button>
            )}
          </>
        )
      }
    >
      {body}
    </McpDialogFrame>
  )
}

// ─── Move into Codeg management ───────────────────────────────────────

function AdoptDialog({
  dialog,
  model,
}: {
  dialog: SkillAdoptDialog
  model: SkillsModel | null
}) {
  const t = useTranslations("Harness.skills.adopt")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const labels = useSkillsLabels()
  const { slots } = useHarnessView()
  const agent = labels.agent(dialog.agent)
  const saving = dialog.phase === "saving"
  const close = () => closeSkillsDialog(slots, dialog.id)
  const from = dialog.dir ? joinFsPath(dialog.dir, dialog.skillId) : null
  const to = model?.inventory.store
    ? joinFsPath(model.inventory.store, dialog.skillId)
    : null
  const readers =
    dialog.dir && from ? sharedReaders(model, dialog.agent, from, true) : []
  const result = dialog.result

  let body: ReactNode
  if (dialog.phase === "result") {
    body = (
      <div className="min-w-0 space-y-3 text-sm">
        {result?.ok && result.outcome === "adopted" ? (
          <Done>
            {result.mode === "copy"
              ? t("doneCopy", { agent })
              : t("done", { agent })}
          </Done>
        ) : (
          <FailureNote>
            <p>
              {result?.outcome === "busy"
                ? t("busy")
                : result?.outcome === "failed"
                  ? result.restored
                    ? t("failedRestored")
                    : t("failedNotRestored")
                  : t("refused")}
            </p>
            {dialog.failure && <FailureText failure={dialog.failure} />}
          </FailureNote>
        )}
        {result && result.issues.length > 0 && (
          <IssueList issues={result.issues} />
        )}
        {result?.ok && result.store_path && (
          <div className="space-y-0.5 text-xs">
            <p className="text-muted-foreground">{t("nowAt")}</p>
            <SkillPath
              path={result.store_path}
              className="text-xs text-foreground"
            />
          </div>
        )}
      </div>
    )
  } else {
    body = (
      <div className="min-w-0 space-y-3 text-sm">
        <p>{t("about", { agent })}</p>
        <ol className="list-decimal space-y-1 ps-5 text-muted-foreground">
          <li>{t("step1")}</li>
          <li>{t("step2")}</li>
          <li>{t("step3", { agent })}</li>
        </ol>
        <p className="text-muted-foreground">{t("safe")}</p>
        {from && (
          <div className="space-y-0.5 text-xs">
            <p className="text-muted-foreground">{t("from")}</p>
            <SkillPath path={from} className="text-xs text-foreground" />
          </div>
        )}
        {to && (
          <div className="space-y-0.5 text-xs">
            <p className="text-muted-foreground">{t("to")}</p>
            <SkillPath path={to} className="text-xs text-foreground" />
          </div>
        )}
        {readers.length > 0 && (
          <p className="text-muted-foreground">
            {t("shared", { agents: labels.agents(readers) })}
          </p>
        )}
      </div>
    )
  }

  const adopted = result?.ok && result.outcome === "adopted"
  return (
    <McpDialogFrame
      title={t.rich("title", { id: dialog.skillId, code })}
      onRequestClose={() => !saving && close()}
      footer={
        dialog.phase === "result" ? (
          <>
            {result?.outcome === "busy" && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  updateSkillsDialog(slots, dialog.id, "adopt", (prev) => ({
                    ...prev,
                    phase: "confirm",
                    result: null,
                    failure: null,
                  }))
                }
              >
                <RefreshCw aria-hidden="true" />
                {tDialog("retry")}
              </Button>
            )}
            {adopted && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  close()
                  openSkillTarget(slots, dialog.skillId)
                }}
              >
                {t("show")}
              </Button>
            )}
            <Button type="button" onClick={close}>
              {adopted ? tDialog("done") : tDialog("close")}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={close}
            >
              {tDialog("cancel")}
            </Button>
            <Button
              type="button"
              disabled={saving}
              onClick={() => void runAdopt(slots, dialog.id)}
            >
              {saving && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("confirm")}
            </Button>
          </>
        )
      }
    >
      {body}
    </McpDialogFrame>
  )
}

// ─── Backups ──────────────────────────────────────────────────────────

function BackupFacts({ backup }: { backup: SkillBackup }) {
  const labels = useSkillsLabels()
  return (
    <div className="min-w-0 space-y-0.5 text-xs">
      <p className="font-medium text-foreground">
        <bdi dir="ltr" className="font-mono">
          {backup.skill}
        </bdi>
        {backup.created_at && (
          <span className="font-normal text-muted-foreground">
            {" · "}
            {labels.date(backup.created_at)}
          </span>
        )}
      </p>
      <SkillPath path={backup.path} />
    </div>
  )
}

function RestoreDialog({
  dialog,
  model,
  onShow,
}: {
  dialog: BackupRestoreDialog
  model: SkillsModel | null
  onShow?: () => void
}) {
  const t = useTranslations("Harness.skills.restore")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const { slots } = useHarnessView()
  const saving = dialog.phase === "saving"
  const close = () => closeSkillsDialog(slots, dialog.id)
  const usable = newIdUsable(dialog.newId, model)
  const result = dialog.result
  const restored = result?.ok && result.outcome === "restored"
  const run = () => usable && !saving && void runRestore(slots, dialog.id)

  return (
    <McpDialogFrame
      title={t("title")}
      onRequestClose={() => !saving && close()}
      footer={
        dialog.phase === "result" ? (
          <>
            {restored && onShow && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  close()
                  onShow()
                }}
              >
                {t("show")}
              </Button>
            )}
            <Button type="button" onClick={close}>
              {restored ? tDialog("done") : tDialog("close")}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={close}
            >
              {tDialog("cancel")}
            </Button>
            <Button type="button" disabled={!usable || saving} onClick={run}>
              {saving && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("confirm")}
            </Button>
          </>
        )
      }
    >
      <div className="min-w-0 space-y-4 text-sm">
        <BackupFacts backup={dialog.backup} />
        {dialog.phase === "result" ? (
          restored ? (
            <>
              <Done>
                {t.rich("done", { id: result?.id ?? dialog.newId, code })}
              </Done>
              {result?.backup_kept && (
                <p className="text-muted-foreground">{t("kept")}</p>
              )}
            </>
          ) : (
            <FailureNote>
              <p>{result?.outcome === "busy" ? t("busy") : t("failed")}</p>
              {result && <IssueList issues={result.issues} />}
              {dialog.failure && <FailureText failure={dialog.failure} />}
            </FailureNote>
          )
        ) : (
          <>
            <p className="text-muted-foreground">{t("about")}</p>
            <NewIdField
              id={`restore-id-${dialog.id}`}
              value={dialog.newId}
              model={model}
              onChange={(newId) =>
                updateSkillsDialog(slots, dialog.id, "restore", (prev) => ({
                  ...prev,
                  newId,
                  failure: null,
                  result: null,
                }))
              }
              onEnter={run}
            />
            {result && !result.ok && <IssueList issues={result.issues} />}
            {dialog.failure && (
              <FailureNote>
                <FailureText failure={dialog.failure} />
              </FailureNote>
            )}
          </>
        )}
      </div>
    </McpDialogFrame>
  )
}

function BackupDeleteDialogView({ dialog }: { dialog: BackupDeleteDialog }) {
  const t = useTranslations("Harness.skills.backupDelete")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const labels = useSkillsLabels()
  const { slots } = useHarnessView()
  const saving = dialog.phase === "saving"
  const close = () => closeSkillsDialog(slots, dialog.id)
  const result = dialog.result
  const linked = result?.issues.find((issue) => issue.code === "backup_linked")
  const linkedBy = linked?.agents ?? dialog.backup.linked_by

  const turnOffLinks = () => {
    close()
    // The legacy backup is linked under its own folder name: those links are
    // turned off as a skill of that name, through the same confirmation as
    // any other switch that reaches several agents.
    const skill = baseName(dialog.backup.path)
    void planEffects(slots, SKILLS_LINKS, {
      intent: { kind: "backupLinks", skill },
      ops: linkedBy.map((agent) => ({ skill, agent, action: "disable" })),
    })
  }

  return (
    <McpDialogFrame
      title={t("title")}
      onRequestClose={() => !saving && close()}
      footer={
        dialog.phase === "result" ? (
          <>
            {linked && linkedBy.length > 0 && (
              <Button type="button" variant="outline" onClick={turnOffLinks}>
                {t("turnOff")}
              </Button>
            )}
            <Button type="button" onClick={close}>
              {tDialog("close")}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={close}
            >
              {tDialog("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={saving}
              onClick={() => void runBackupDelete(slots, dialog.id)}
            >
              {saving && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("confirm")}
            </Button>
          </>
        )
      }
    >
      <div className="min-w-0 space-y-3 text-sm">
        <BackupFacts backup={dialog.backup} />
        {dialog.phase === "result" ? (
          <FailureNote>
            <p>
              {linked
                ? t("linked", { agents: labels.agents(linkedBy) })
                : result?.outcome === "busy"
                  ? t("busy")
                  : t("failed")}
            </p>
            {result && !linked && <IssueList issues={result.issues} />}
            {dialog.failure && <FailureText failure={dialog.failure} />}
          </FailureNote>
        ) : (
          <>
            {dialog.backup.linked_by.length > 0 && (
              <p className="text-tone-warning">
                {t("linked", {
                  agents: labels.agents(dialog.backup.linked_by),
                })}
              </p>
            )}
            <p className="text-muted-foreground">{t("undo")}</p>
          </>
        )}
      </div>
    </McpDialogFrame>
  )
}

/** The Skills section's dialogs — the one open, if any. `onShowSkill` takes
 *  the user to the Skills section from another (a backup restored from the
 *  Skill-packs section). */
export function SkillsDialogs({
  model,
  onShowSkill,
}: {
  model: SkillsModel | null
  onShowSkill?: () => void
}) {
  const [dialog] = useHarnessSlot(SKILLS_DIALOG)
  if (!dialog) return null
  switch (dialog.kind) {
    case "editor":
      return <SkillEditorDialog key={dialog.id} dialog={dialog} model={model} />
    case "delete":
      return <DeleteDialog key={dialog.id} dialog={dialog} model={model} />
    case "adopt":
      return <AdoptDialog key={dialog.id} dialog={dialog} model={model} />
    case "copy":
      return <CopyDialog key={dialog.id} dialog={dialog} model={model} />
    case "restore":
      return (
        <RestoreDialog
          key={dialog.id}
          dialog={dialog}
          model={model}
          onShow={onShowSkill}
        />
      )
    case "backupDelete":
      return <BackupDeleteDialogView key={dialog.id} dialog={dialog} />
  }
}
