"use client"

/**
 * Create or edit an assistant: avatar and name, description, the agent and
 * EVERY option it advertises (each one required, nothing preselected — the
 * model first, see `required-agent-options`), and the standing instructions.
 * Whether it is enabled is the list's switch: a new assistant starts enabled,
 * and an edit leaves that state alone.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AlignLeft, Bot, Loader2, ScrollText } from "lucide-react"

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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { defaultAvatarFor } from "@/lib/assistant-avatar"
import {
  extractAppCommandError,
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import type {
  AgentType,
  AssistantAgentConfig,
  AssistantAvatar,
  AssistantInfo,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAssistantsStore } from "@/stores/assistants-store"
import {
  AgentSelect,
  OptionBlock,
  RequiredOptionRow,
  type OptionRow,
} from "./agent-options-editor"
import {
  buildAgentConfig,
  effectivePick,
  missingRows,
  rowMark,
  sameAgentSelection,
  selectionFromOptions,
  EMPTY_SELECTION,
  type AssistantSelection,
} from "./assistant-agent-config"
import { AssistantAvatarPicker } from "./assistant-avatar-picker"
import {
  RequiredOptionsSection,
  useRequiredOptionsGate,
} from "./required-agent-options"

/** Field limits, mirrored from the backend (`assistant_service`). */
export const NAME_MAX = 40
export const DESCRIPTION_MAX = 200
export const INSTRUCTIONS_MAX = 20_000

const charCount = (text: string) => Array.from(text).length

export interface AssistantEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `null` creates a new assistant. */
  assistant: AssistantInfo | null
  /** Called with the saved row. */
  onSaved?: (assistant: AssistantInfo) => void
}

export function AssistantEditorDialog({
  open,
  onOpenChange,
  assistant,
  onSaved,
}: AssistantEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Header, scrolling body and footer as three bands — the body is the
          only part that scrolls, between hairlines, so Save stays in reach and
          the cards never slide under the title unannounced. The header keeps
          room for the close button (the content's own rule, widened for the
          padding this layout moves off the content box). */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[40rem] [&_[data-slot=dialog-header]]:pr-16">
        {open ? (
          <AssistantEditorBody
            assistant={assistant}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function AssistantEditorBody({
  assistant,
  onClose,
  onSaved,
}: {
  assistant: AssistantInfo | null
  onClose: () => void
  onSaved?: (assistant: AssistantInfo) => void
}) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const { agents } = useAcpAgents()
  const create = useAssistantsStore((s) => s.create)
  const update = useAssistantsStore((s) => s.update)
  const editing = assistant !== null

  const [name, setName] = useState(assistant?.name ?? "")
  const [description, setDescription] = useState(assistant?.description ?? "")
  const [avatar, setAvatar] = useState<AssistantAvatar>(
    assistant?.avatar ?? defaultAvatarFor("")
  )
  // A new assistant's monogram follows its name until the user picks one.
  const [avatarTouched, setAvatarTouched] = useState(editing)
  const [instructions, setInstructions] = useState(
    assistant?.instructions ?? ""
  )
  const [agentType, setAgentType] = useState<AgentType | null>(
    assistant?.agent_type ?? null
  )
  const [selection, setSelection] = useState<AssistantSelection>(
    assistant ? selectionFromOptions(assistant.agent_options) : EMPTY_SELECTION
  )
  /** The user changed the agent or any option. */
  const [agentTouched, setAgentTouched] = useState(false)
  /** Display names of the picks made in this editor, by row id — what an
   *  "unavailable (was X)" mark names after a model switch withdrew one. */
  const [pickedLabels, setPickedLabels] = useState<Record<string, string>>({})
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<string>>(new Set())
  const [nameError, setNameError] = useState<string | null>(null)
  // A text over its limit is reported on its own field, like the name — and
  // cleared by the next edit of it, not by the next submit.
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  const [instructionsError, setInstructionsError] = useState<string | null>(
    null
  )
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submittingRef = useRef(false)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const nameRef = useRef<HTMLInputElement | null>(null)
  const descriptionRef = useRef<HTMLInputElement | null>(null)
  const instructionsRef = useRef<HTMLTextAreaElement | null>(null)
  // A refused save that points at the name focuses it once the form is
  // enabled again — a disabled input cannot take focus.
  const focusNameAfterSaveRef = useRef(false)
  useEffect(() => {
    if (saving || !focusNameAfterSaveRef.current) return
    focusNameAfterSaveRef.current = false
    nameRef.current?.focus()
  }, [saving])

  const agentInfo = agents.find((a) => a.agent_type === agentType) ?? null
  // The saved agent can no longer run here: keep it, show what was saved.
  const agentUnavailable =
    editing &&
    !agentTouched &&
    agentType === assistant.agent_type &&
    agents.length > 0 &&
    !(agentInfo?.enabled && agentInfo.available)

  const { gate, probe } = useRequiredOptionsGate({
    agentType,
    selection,
    unavailable: agentUnavailable,
  })

  const saved = useMemo(
    () =>
      assistant && agentType === assistant.agent_type
        ? {
            selection: selectionFromOptions(assistant.agent_options),
            labels: assistant.label_snapshot,
          }
        : null,
    [assistant, agentType]
  )
  const booleanLabels = { on: tm("booleanOn"), off: tm("booleanOff") }

  const readyRows = gate.kind === "ready" ? gate.rows : null
  const missing = readyRows ? missingRows(readyRows, selection) : []
  // Rows that need a pick because the agent's options changed since the save.
  const driftCount =
    editing && readyRows && !agentTouched
      ? readyRows.filter((row) => rowMark(row, selection, saved, pickedLabels))
          .length
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
      [row.id]:
        (row.kind === "select"
          ? row.groups.flatMap((g) => g.options).find((o) => o.value === value)
              ?.name
          : row.kind === "mode"
            ? row.modes.find((m) => m.id === value)?.name
            : value === "true"
              ? booleanLabels.on
              : booleanLabels.off) ?? value,
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
        mark={rowMark(row, selection, saved, pickedLabels)}
        triggerRef={(el) => {
          triggerRefs.current.set(row.id, el)
        }}
      />
    </OptionBlock>
  )

  const tRoot = t as unknown as AppErrorTranslator

  const save = async () => {
    if (submittingRef.current) return
    setSubmitError(null)
    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError(t("errors.emptyName"))
      nameRef.current?.focus()
      return
    }
    if (charCount(trimmedName) > NAME_MAX) {
      setNameError(t("errors.nameTooLong", { max: NAME_MAX }))
      nameRef.current?.focus()
      return
    }
    if (charCount(description) > DESCRIPTION_MAX) {
      setDescriptionError(
        t("errors.descriptionTooLong", { max: DESCRIPTION_MAX })
      )
      descriptionRef.current?.focus()
      return
    }
    if (charCount(instructions) > INSTRUCTIONS_MAX) {
      setInstructionsError(
        t("errors.instructionsTooLong", { max: INSTRUCTIONS_MAX })
      )
      instructionsRef.current?.focus()
      return
    }
    if (agentType === null) {
      setSubmitError(t("pickAgentFirst"))
      return
    }

    let agentConfig: AssistantAgentConfig | undefined
    if (gate.kind === "ready") {
      const stillMissing = missingRows(gate.rows, selection)
      if (stillMissing.length > 0) {
        setInvalidIds(new Set(stillMissing.map((row) => row.id)))
        setSubmitError(t("missingCount", { count: stillMissing.length }))
        triggerRefs.current.get(stillMissing[0].id)?.focus()
        return
      }
      const built = buildAgentConfig({
        agentType,
        agentLabel: getAgentLabel(agentType) ?? agentType,
        rows: gate.rows,
        selection,
        modeLabel: tm("modeLabel"),
        booleanLabels,
      })
      // An edit submits the selection only when it differs from the saved one
      // — the user changed something, or an option the agent dropped is
      // removed — so a rename alone leaves the saved names untouched.
      agentConfig =
        assistant && sameAgentSelection(built, assistant) ? undefined : built
    } else if (
      editing &&
      !agentTouched &&
      (gate.kind === "error" ||
        gate.kind === "unavailable-agent" ||
        gate.kind === "not-switched")
    ) {
      // The options cannot be checked right now — the probe failed, the agent
      // cannot run here, or it would not switch to the saved model — and were
      // not touched: the other fields save, the saved selection stays as it
      // was.
      agentConfig = undefined
    } else {
      setSubmitError(
        gate.kind === "error"
          ? t("cannotSaveProbeFailed")
          : gate.kind === "pick-model"
            ? t("missingCount", { count: 1 })
            : gate.kind === "not-switched"
              ? t("cannotSaveModelNotSwitched")
              : t("cannotSaveStillLoading")
      )
      if (gate.kind === "pick-model") {
        setInvalidIds(new Set([gate.modelRow.id]))
        triggerRefs.current.get(gate.modelRow.id)?.focus()
      }
      return
    }

    submittingRef.current = true
    setSaving(true)
    try {
      const avatarToSave = avatarTouched
        ? avatar
        : defaultAvatarFor(trimmedName)
      let row: AssistantInfo
      if (assistant) {
        row = await update(assistant.id, {
          name: trimmedName,
          description,
          avatar: avatarToSave,
          instructions,
          ...(agentConfig ? { agent_config: agentConfig } : {}),
        })
      } else {
        if (!agentConfig) return
        row = await create({
          name: trimmedName,
          description,
          avatar: avatarToSave,
          agent_config: agentConfig,
          instructions,
          enabled: true,
        })
      }
      onSaved?.(row)
      onClose()
    } catch (err) {
      const message = toLocalizedErrorMessage(err, tRoot)
      if (extractAppCommandError(err)?.i18n_key === "errors.duplicateName") {
        setNameError(message)
        focusNameAfterSaveRef.current = true
      } else {
        setSubmitError(message)
      }
    } finally {
      submittingRef.current = false
      setSaving(false)
    }
  }

  const instructionsLength = charCount(instructions)
  // What the footer says while nothing has gone wrong: how far the selection
  // is from complete. A refused save replaces it with the reason.
  const footerHint =
    readyRows && missing.length > 0
      ? t("missingCount", { count: missing.length })
      : null

  return (
    <>
      <DialogHeader className="px-4 pt-6 pb-4 sm:px-6">
        <DialogTitle>{editing ? t("editTitle") : t("createTitle")}</DialogTitle>
        <DialogDescription>{t("editorDescription")}</DialogDescription>
      </DialogHeader>

      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {/* Only the fields scroll: the footer stays in view, so Save is
            reachable however many options the agent has. `relative` keeps
            the hidden native inputs behind the selects inside this box;
            positioned against the dialog, they would make it scroll as well.

            Three cards, in the settings house style: who the assistant is,
            what it runs, and what it is told. */}
        <div className="relative min-h-0 flex-1 space-y-3 overflow-y-auto border-y border-border/60 px-4 py-4 sm:px-6">
          <SettingCard>
            {/* The name and the avatar drawn from it, side by side. Top-aligned
                (the avatar is as tall as label + field), so an error line
                appearing under the field does not shift the avatar. */}
            <div className="flex items-start gap-3 p-3">
              <div className="mt-0.5 shrink-0">
                <AssistantAvatarPicker
                  avatar={avatarTouched ? avatar : defaultAvatarFor(name)}
                  name={name}
                  onChange={(next) => {
                    setAvatar(next)
                    setAvatarTouched(true)
                  }}
                  disabled={saving}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor="assistant-name" className="text-sm">
                  {t("nameLabel")}
                </Label>
                <Input
                  id="assistant-name"
                  ref={nameRef}
                  dir="auto"
                  value={name}
                  maxLength={NAME_MAX * 2}
                  onChange={(e) => {
                    setName(e.target.value)
                    setNameError(null)
                  }}
                  placeholder={t("namePlaceholder")}
                  aria-invalid={nameError ? true : undefined}
                  disabled={saving}
                  className="h-8 bg-background"
                />
                {nameError ? (
                  <p className="text-xs leading-5 text-destructive">
                    {nameError}
                  </p>
                ) : null}
              </div>
            </div>
            <SettingRow
              icon={AlignLeft}
              title={t("descriptionLabel")}
              description={t("descriptionHint")}
              htmlFor="assistant-description"
            >
              <Input
                id="assistant-description"
                ref={descriptionRef}
                dir="auto"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value)
                  setDescriptionError(null)
                }}
                placeholder={t("descriptionPlaceholder")}
                aria-invalid={descriptionError ? true : undefined}
                disabled={saving}
                className="h-8 bg-background"
              />
              {descriptionError ? (
                <p className="text-xs leading-5 text-destructive">
                  {descriptionError}
                </p>
              ) : null}
            </SettingRow>
          </SettingCard>

          {/* The agent and its options share the card: every option is a
              row of it, on the same edge as the agent row above, so the card
              reads as one decision. */}
          <SettingCard>
            <SettingRow
              icon={Bot}
              title={t("agentLabel")}
              description={
                agentType === null ? t("pickAgentFirst") : t("agentHint")
              }
              control={
                <AgentSelect
                  value={agentType}
                  onChange={pickAgent}
                  agents={agents.filter(
                    (a) => a.enabled || a.agent_type === agentType
                  )}
                  fallbackLabel={assistant?.label_snapshot.agent}
                  disabled={saving}
                />
              }
            />
            {agentType !== null ? (
              <RequiredOptionsSection
                gate={gate}
                loading={probe.loading}
                saved={editing && !agentTouched ? assistant : null}
                driftCount={driftCount}
                renderRow={renderRow}
                onRetry={() => probe.reload()}
              />
            ) : null}
          </SettingCard>

          <SettingCard>
            <SettingRow
              icon={ScrollText}
              title={t("instructionsLabel")}
              description={t("instructionsHint")}
              htmlFor="assistant-instructions"
              control={
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    instructionsLength > INSTRUCTIONS_MAX
                      ? "text-destructive"
                      : "text-muted-foreground"
                  )}
                >
                  {t("charCount", {
                    count: instructionsLength,
                    max: INSTRUCTIONS_MAX,
                  })}
                </span>
              }
            >
              <Textarea
                id="assistant-instructions"
                ref={instructionsRef}
                dir="auto"
                value={instructions}
                onChange={(e) => {
                  setInstructions(e.target.value)
                  setInstructionsError(null)
                }}
                placeholder={t("instructionsPlaceholder")}
                aria-invalid={instructionsError ? true : undefined}
                className="max-h-72 min-h-28 bg-background text-sm"
                disabled={saving}
              />
              {instructionsError ? (
                <p className="text-xs leading-5 text-destructive">
                  {instructionsError}
                </p>
              ) : null}
            </SettingRow>
          </SettingCard>
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
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {editing ? t("save") : t("createSubmit")}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </>
  )
}
