"use client"

import { useRef, useState, type ReactNode } from "react"
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { ToggleGroup } from "radix-ui"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { joinFsPath } from "@/lib/path-utils"
import {
  closeSkillsDialog,
  editorIsDirty,
  keepMine,
  makeCustomInstead,
  saveEditor,
  SKILLS_AGENT_LIST,
  SKILLS_AGENT_SCOPE,
  skillsInScope,
  takeDrift,
  updateSkillsDialog,
  type SkillEditorDialog as EditorState,
} from "@/lib/harness/skills-state"
import { skillIdProblem } from "@/lib/skills/ids"
import type { SkillsModel } from "@/lib/skills/model"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { DiscardChangesDialog, McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { sharedReaders } from "./agent-view"
import { FailureNote, FailureText, SkillPath } from "./skill-bits"
import { SkillPreview } from "./skill-preview"
import { useSkillsLabels } from "./use-skills-labels"

const SEGMENT_CLASS = cn(
  "h-7 rounded-full px-3 text-xs font-medium whitespace-nowrap",
  "text-muted-foreground outline-none transition-colors hover:text-foreground max-md:h-9",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
)

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

/** Why the id typed for a new skill cannot be used, before it is sent. */
function useIdProblem(
  dialog: EditorState,
  model: SkillsModel | null
): "invalid" | "taken" | null {
  const [list] = useHarnessSlot(SKILLS_AGENT_LIST)
  const [scope] = useHarnessSlot(SKILLS_AGENT_SCOPE)
  if (dialog.target.mode !== "create") return null
  const id = dialog.draftId.trim()
  const problem = skillIdProblem(id)
  if (problem === "invalid") return "invalid"
  if (problem === "empty") return null
  if (model?.takenIds.has(id)) return "taken"
  if (dialog.target.kind === "agent") {
    const listed = skillsInScope(list, scope)
    if (listed.some((item) => item.id === id)) return "taken"
  }
  return null
}

/**
 * The one SKILL.md editor: a new Custom skill or an edit of one (Codeg's
 * store), an agent's new skill or an edit of its own (in place). Everything
 * typed lives in its slot, so it is still here after a trip to a
 * conversation; closing it with unsaved changes asks first. A refresh never
 * loads over what is being typed: if the file changed underneath, the editor
 * says so and lets the user choose.
 */
export function SkillEditorDialog({
  dialog,
  model,
}: {
  dialog: EditorState
  model: SkillsModel | null
}) {
  const t = useTranslations("Harness.skills.editor")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const labels = useSkillsLabels()
  const { slots } = useHarnessView()
  const [discarding, setDiscarding] = useState(false)
  const idRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const target = dialog.target
  const create = target.mode === "create"
  const idProblem = useIdProblem(dialog, model)
  const id = create ? dialog.draftId.trim() : target.skillId
  const agentName = target.kind === "agent" ? labels.agent(target.agent) : ""
  const close = () => closeSkillsDialog(slots, dialog.id)
  const requestClose = () => {
    if (dialog.phase === "saving") return
    if (editorIsDirty(dialog)) setDiscarding(true)
    else close()
  }

  const title =
    target.kind === "custom"
      ? create
        ? t("newCustom")
        : t.rich("editCustom", { id, code })
      : create
        ? t("newAgent", { agent: agentName })
        : t.rich("editAgent", { id, agent: agentName, code })

  // Where the file is written.
  let where: string | null = null
  if (target.kind === "custom") {
    where =
      id && model?.inventory.store
        ? joinFsPath(model.inventory.store, `${id}/SKILL.md`)
        : null
  } else if (create) {
    where =
      id && target.path
        ? joinFsPath(
            target.path,
            target.layout === null ? `${id}.md` : `${id}/SKILL.md`
          )
        : null
  } else {
    where = target.path
  }
  const readers =
    target.kind === "agent" && where
      ? sharedReaders(model, target.agent, where, target.scope === "global")
      : []

  // A new skill for an agent whose only folder others read too: it can be a
  // Custom skill instead, turned on for the agent (global scope only — a
  // Custom skill is turned on in an agent's global folders).
  const noOwnDirectory =
    dialog.saveFailure?.kind === "coded" &&
    dialog.saveFailure.code === "no_own_directory" &&
    target.kind === "agent" &&
    create &&
    target.scope === "global"

  const canSave =
    dialog.phase === "ready" &&
    dialog.drift === null &&
    !(dialog.loadFailure && !create) &&
    (!create || (id !== "" && idProblem === null))

  const body = (
    <div className="min-w-0 space-y-4">
      {dialog.loadFailure && (
        <FailureNote>
          {t("loadFailed")} <FailureText failure={dialog.loadFailure} />
        </FailureNote>
      )}
      {dialog.drift !== null && (
        <FailureNote role="status">
          <p>{t("drifted")}</p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => takeDrift(slots, dialog.id)}
              className="max-md:h-9"
            >
              <RefreshCw aria-hidden="true" />
              {t("takeTheirs")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => keepMine(slots, dialog.id)}
              className="max-md:h-9"
            >
              {t("keepMine")}
            </Button>
          </div>
        </FailureNote>
      )}
      {target.kind === "custom" && target.enableFor && (
        <p className="rounded-lg bg-tone-info/10 px-3 py-2 text-xs">
          {t("enableFor", { agent: labels.agent(target.enableFor) })}
        </p>
      )}
      {create && (
        <div className="min-w-0 space-y-1.5">
          <label
            htmlFor={`skill-id-${dialog.id}`}
            className="text-sm font-medium"
          >
            {t("id")}
          </label>
          <Input
            ref={idRef}
            id={`skill-id-${dialog.id}`}
            value={dialog.draftId}
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            maxLength={200}
            aria-invalid={idProblem !== null || undefined}
            placeholder={t("idPlaceholder")}
            className="font-mono text-[0.8125rem] max-md:h-10"
            onChange={(event) =>
              updateSkillsDialog(slots, dialog.id, "editor", (prev) => ({
                ...prev,
                draftId: event.target.value,
                saveFailure: null,
              }))
            }
          />
          {idProblem && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span className="min-w-0">
                {idProblem === "invalid"
                  ? t("idInvalid")
                  : t.rich("idTaken", { id, code })}
              </span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t("idRule")}</p>
        </div>
      )}
      {where && (
        <div className="min-w-0 space-y-0.5 text-xs">
          <p className="text-muted-foreground">
            {create ? t("writesTo") : t("file")}
          </p>
          <SkillPath path={where} className="text-xs text-foreground" />
        </div>
      )}
      {readers.length > 0 && (
        <p className="flex min-w-0 items-start gap-1.5 text-xs text-tone-warning">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span className="min-w-0">
            {t("shared", { agents: labels.agents(readers) })}
          </span>
        </p>
      )}
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <label
            htmlFor={`skill-content-${dialog.id}`}
            className="text-sm font-medium"
          >
            {t("content")}
          </label>
          <ToggleGroup.Root
            type="single"
            value={dialog.view}
            aria-label={t("viewLabel")}
            onValueChange={(value) => {
              if (value === "edit" || value === "preview") {
                updateSkillsDialog(slots, dialog.id, "editor", (prev) => ({
                  ...prev,
                  view: value,
                }))
              }
            }}
            className="flex items-center gap-0.5 rounded-full bg-muted/70 p-0.5 ws-msg-chip"
          >
            <ToggleGroup.Item value="edit" className={SEGMENT_CLASS}>
              {t("edit")}
            </ToggleGroup.Item>
            <ToggleGroup.Item value="preview" className={SEGMENT_CLASS}>
              {t("preview")}
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>
        {dialog.phase === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {t("loading")}
          </p>
        ) : dialog.view === "edit" ? (
          <Textarea
            ref={textRef}
            id={`skill-content-${dialog.id}`}
            value={dialog.content}
            dir="auto"
            spellCheck={false}
            disabled={
              dialog.phase === "saving" || (!!dialog.loadFailure && !create)
            }
            className="min-h-[18rem] font-mono text-xs leading-relaxed max-md:min-h-[50dvh]"
            onChange={(event) =>
              updateSkillsDialog(slots, dialog.id, "editor", (prev) => ({
                ...prev,
                content: event.target.value,
              }))
            }
          />
        ) : (
          <div className="min-h-[18rem] rounded-lg border px-3 py-3">
            <SkillPreview content={dialog.content} />
          </div>
        )}
      </div>
      {dialog.saveFailure && (
        <FailureNote>
          {t("notSaved")} <FailureText failure={dialog.saveFailure} />
          {noOwnDirectory && target.kind === "agent" && (
            <div className="space-y-2 pt-2">
              <p>
                {t("noOwnDirectory", { agent: labels.agent(target.agent) })}
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => makeCustomInstead(slots, dialog.id)}
                className="max-md:h-9"
              >
                {t("makeCustom")}
              </Button>
            </div>
          )}
        </FailureNote>
      )}
    </div>
  )

  return (
    <>
      <McpDialogFrame
        title={title}
        description={
          target.kind === "custom" ? t("customAbout") : t("agentAbout")
        }
        size="wide"
        onRequestClose={requestClose}
        initialFocus={() => (create ? idRef.current : textRef.current)}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={dialog.phase === "saving"}
              onClick={requestClose}
            >
              {tDialog("cancel")}
            </Button>
            <Button
              type="button"
              disabled={!canSave}
              onClick={() => void saveEditor(slots, dialog.id)}
            >
              {dialog.phase === "saving" && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {dialog.phase === "saving" ? tDialog("saving") : tDialog("save")}
            </Button>
          </>
        }
      >
        {body}
      </McpDialogFrame>
      <DiscardChangesDialog
        open={discarding}
        onKeep={() => setDiscarding(false)}
        onDiscard={() => {
          setDiscarding(false)
          close()
        }}
      />
    </>
  )
}
