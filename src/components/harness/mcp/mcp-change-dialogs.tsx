"use client"

import { useId, useRef, useState, type ReactNode } from "react"
import { RefreshCw, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  backToInput,
  canCommit,
  closeDialog,
  commitDialog,
  confirmSwitch,
  editableHolders,
  isAgentBusy,
  MCP_BUSY,
  reviewDialog,
  updateDialog,
  type McpConfirmDialog,
  type McpFlow,
  type McpRemoveDialog,
  type McpRenameDialog,
} from "@/lib/harness/mcp-state"
import { newKeyProblem } from "@/lib/mcp/keys"
import {
  agentServerState,
  holderAgentIds,
  type McpModel,
} from "@/lib/mcp/model"
import { agentsOf } from "@/lib/mcp/ops"
import { isSaved } from "@/lib/mcp/results"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { MachineText } from "../machine-text"
import { AgentGlyph, MCP_SECTION_TITLE_CLASS, PathText } from "./mcp-bits"
import { McpDefinitionView } from "./mcp-definition-view"
import { McpDialogFrame } from "./mcp-dialog-frame"
import { McpResults, McpReview } from "./mcp-plan"
import { useMcpLabels } from "./use-mcp-labels"

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

/** The steps every write dialog shares once its input is in: the review, the
 *  save, the results — and their buttons. */
function useFlowParts(
  id: number,
  flow: McpFlow,
  input: ReactNode,
  inputFooter: ReactNode
): { body: ReactNode; footer: ReactNode } {
  const t = useTranslations("Harness.mcp.dialog")
  const { slots } = useHarnessView()
  const [busy] = useHarnessSlot(MCP_BUSY)
  const planBusy = flow.plan
    ? agentsOf(flow.plan.ops).some((agent) => isAgentBusy(busy, agent))
    : false
  if (flow.step === "input") return { body: input, footer: inputFooter }
  if (flow.step === "review" || flow.step === "saving") {
    const again =
      flow.preflight?.outcome === "changed_elsewhere" || flow.failure !== null
    return {
      body: <McpReview flow={flow} />,
      footer: (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={flow.step === "saving"}
            onClick={() => backToInput(slots, id)}
          >
            {t("back")}
          </Button>
          {again ? (
            <Button type="button" onClick={() => void reviewDialog(slots, id)}>
              <RefreshCw aria-hidden="true" />
              {t("checkAgain")}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!canCommit(flow) || flow.step === "saving" || planBusy}
              onClick={() => void commitDialog(slots, id)}
            >
              {flow.step === "saving" ? t("saving") : t("save")}
            </Button>
          )}
        </>
      ),
    }
  }
  const saved = flow.result !== null && isSaved(flow.result)
  return {
    body: <McpResults flow={flow} />,
    footer: saved ? (
      <Button type="button" onClick={() => closeDialog(slots, id)}>
        {t("done")}
      </Button>
    ) : (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={() => backToInput(slots, id)}
        >
          {t("back")}
        </Button>
        {flow.result?.outcome === "busy" ? (
          <Button
            type="button"
            disabled={planBusy}
            onClick={() => void commitDialog(slots, id)}
          >
            <RefreshCw aria-hidden="true" />
            {t("retry")}
          </Button>
        ) : (
          <Button type="button" onClick={() => closeDialog(slots, id)}>
            {t("close")}
          </Button>
        )}
      </>
    ),
  }
}

// ─── Remove ───────────────────────────────────────────────────────────

/** Remove a server from the agents the user picks — all of them that can
 *  change, unless some are unticked. */
export function McpRemoveDialog({
  dialog,
  model,
}: {
  dialog: McpRemoveDialog
  model: McpModel | null
}) {
  const t = useTranslations("Harness.mcp.remove")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const baseId = useId()
  const server = model?.server(dialog.key)
  const removable = model ? editableHolders(model, dialog.key) : []
  const chosen = dialog.agents.filter((agent) => removable.includes(agent))

  const input = (
    <div className="min-w-0 space-y-3">
      <p className="text-sm">{t("intro")}</p>
      <fieldset className="min-w-0">
        <legend className={cn(MCP_SECTION_TITLE_CLASS, "pb-2")}>
          {t("from")}
        </legend>
        <ul className="divide-y rounded-lg border">
          {(server?.holders ?? [])
            // One row per agent, even where an agent holds the key twice.
            .filter(
              (holder, position, all) =>
                all.findIndex((other) => other.info === holder.info) ===
                position
            )
            .map((holder) => {
              const id = `${baseId}-${holder.info.id}`
              const agent = holder.info.agent
              const can = agent !== null && removable.includes(agent)
              const state =
                model && server
                  ? agentServerState(server, holder.info, model.rules)
                  : null
              const why =
                !can && state?.kind === "present"
                  ? state.readOnly?.kind === "agent"
                    ? labels.block(state.readOnly.block)
                    : state.readOnly
                      ? t("readOnly")
                      : holder.info.editBlock
                        ? labels.block(holder.info.editBlock)
                        : t("readOnly")
                  : null
              return (
                <li
                  key={holder.info.id}
                  className="flex min-w-0 items-start gap-3 px-3 py-2"
                >
                  <Checkbox
                    id={id}
                    checked={can && chosen.includes(agent)}
                    disabled={!can}
                    onCheckedChange={(checked) =>
                      agent &&
                      updateDialog(slots, dialog.id, "remove", (prev) => ({
                        ...prev,
                        agents:
                          checked === true
                            ? [
                                ...prev.agents.filter(
                                  (entry) => entry !== agent
                                ),
                                agent,
                              ]
                            : prev.agents.filter((entry) => entry !== agent),
                      }))
                    }
                    className="mt-0.5 max-md:size-5"
                  />
                  <label
                    htmlFor={id}
                    className="flex min-w-0 flex-1 flex-col gap-0.5"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <AgentGlyph agent={holder.info.id} />
                      {labels.agent(holder.info.id)}
                    </span>
                    {why ? (
                      <span className="text-xs text-muted-foreground">
                        {why}
                      </span>
                    ) : (
                      <PathText path={holder.info.inventory.config.path} />
                    )}
                  </label>
                </li>
              )
            })}
        </ul>
      </fieldset>
      <p className="text-xs text-muted-foreground">{t("others")}</p>
    </div>
  )
  const { body, footer } = useFlowParts(
    dialog.id,
    dialog.flow,
    input,
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => closeDialog(slots, dialog.id)}
      >
        {tDialog("cancel")}
      </Button>
      <Button
        type="button"
        variant="destructive"
        disabled={chosen.length === 0}
        onClick={() => void reviewDialog(slots, dialog.id)}
      >
        {tDialog("review")}
      </Button>
    </>
  )
  return (
    <McpDialogFrame
      title={t.rich("title", {
        key: dialog.key,
        code: (chunks) => (
          <bdi dir="ltr">
            <MachineText>{chunks}</MachineText>
          </bdi>
        ),
      })}
      onRequestClose={() =>
        dialog.flow.step !== "saving" && closeDialog(slots, dialog.id)
      }
      footer={footer}
      step={dialog.flow.step}
    >
      {body}
    </McpDialogFrame>
  )
}

// ─── Rename ───────────────────────────────────────────────────────────

/** Rename a server: one rename per agent that has it and can change. */
export function McpRenameDialog({
  dialog,
  model,
}: {
  dialog: McpRenameDialog
  model: McpModel | null
}) {
  const t = useTranslations("Harness.mcp.rename")
  const tEditor = useTranslations("Harness.mcp.editor")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const inputRef = useRef<HTMLInputElement>(null)
  const [attempted, setAttempted] = useState(false)
  const server = model?.server(dialog.key)
  const renamable = model ? editableHolders(model, dialog.key) : []
  const kept =
    server?.holders.filter(
      (holder) => !holder.info.agent || !renamable.includes(holder.info.agent)
    ) ?? []
  const newKey = dialog.newKey.trim()
  const problem = model ? newKeyProblem(newKey, model.rules) : null
  const taken = model
    ? renamable.filter((agent) =>
        model
          .agent(agent)
          ?.inventory.entries.some((entry) => entry.key === newKey)
      )
    : []
  const elsewhere =
    model
      ?.server(newKey)
      ?.holders.filter(
        (holder) => !server?.holders.some((own) => own.info === holder.info)
      ) ?? []
  const same = newKey === dialog.key
  const ready = !problem && !same && taken.length === 0 && renamable.length > 0

  const input = (
    <div className="min-w-0 space-y-4">
      <div className="min-w-0 space-y-1.5">
        <label
          htmlFor={`mcp-rename-${dialog.id}`}
          className="text-sm font-medium"
        >
          {t("newName")}
        </label>
        <Input
          ref={inputRef}
          id={`mcp-rename-${dialog.id}`}
          value={dialog.newKey}
          aria-invalid={
            (attempted && (problem !== null || taken.length > 0)) || undefined
          }
          dir="ltr"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          maxLength={200}
          className="font-mono text-[0.8125rem] max-md:h-10"
          onChange={(event) =>
            updateDialog(slots, dialog.id, "rename", (prev) => ({
              ...prev,
              newKey: event.target.value,
            }))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              setAttempted(true)
              if (ready) void reviewDialog(slots, dialog.id)
            }
          }}
        />
        {(attempted || newKey !== "") && problem && problem !== "empty" && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span className="min-w-0">
              {problem === "reserved"
                ? tEditor.rich("keyReserved", { code })
                : tEditor("keyInvalid")}
            </span>
          </p>
        )}
        {taken.length > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span className="min-w-0">
              {t.rich("taken", {
                name: newKey,
                agents: labels.list(taken.map(labels.agent)),
                code,
              })}
            </span>
          </p>
        )}
        <p className="text-xs text-muted-foreground">{tEditor("keyRule")}</p>
      </div>
      <div className="min-w-0 space-y-1 text-xs">
        <p>
          {t("renamedIn", {
            agents: labels.list(renamable.map(labels.agent)),
          })}
        </p>
        {kept.length > 0 && (
          <p className="text-muted-foreground">
            {t("keptIn", {
              agents: labels.list(holderAgentIds(kept).map(labels.agent)),
            })}
          </p>
        )}
        {elsewhere.length > 0 && !problem && (
          <p className="text-tone-warning">
            {t.rich("mergesWith", {
              name: newKey,
              agents: labels.list(
                elsewhere.map((holder) => labels.agent(holder.info.id))
              ),
              code,
            })}
          </p>
        )}
      </div>
    </div>
  )
  const { body, footer } = useFlowParts(
    dialog.id,
    dialog.flow,
    input,
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => closeDialog(slots, dialog.id)}
      >
        {tDialog("cancel")}
      </Button>
      <Button
        type="button"
        disabled={!ready}
        onClick={() => {
          setAttempted(true)
          void reviewDialog(slots, dialog.id)
        }}
      >
        {tDialog("review")}
      </Button>
    </>
  )
  return (
    <McpDialogFrame
      title={t.rich("title", {
        key: dialog.key,
        code: (chunks) => (
          <bdi dir="ltr">
            <MachineText>{chunks}</MachineText>
          </bdi>
        ),
      })}
      description={dialog.flow.step === "input" ? t("description") : undefined}
      onRequestClose={() =>
        dialog.flow.step !== "saving" && closeDialog(slots, dialog.id)
      }
      footer={footer}
      step={dialog.flow.step}
      initialFocus={() => inputRef.current}
    >
      {body}
    </McpDialogFrame>
  )
}

// ─── A switch's question ──────────────────────────────────────────────

/**
 * What a switch asks before it saves: that off means removal for an agent
 * with no off flag, which definition to add where the agents disagree, and
 * that a save drops the comments of a YAML file.
 */
export function McpConfirmSwitchDialog({
  dialog,
  model,
}: {
  dialog: McpConfirmDialog
  model: McpModel | null
}) {
  const t = useTranslations("Harness.mcp.confirm")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const tAgent = useTranslations("Harness.mcp.agent")
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const info = model?.agent(dialog.agent)
  const agent = labels.agent(dialog.agent)
  const path = info?.inventory.config.path ?? ""
  const comments = info?.inventory.config.comments_lost_on_write === true
  const close = () => closeDialog(slots, dialog.id)
  const values = {
    key: dialog.key,
    agent,
    code: (chunks: ReactNode) => (
      <bdi dir="ltr">
        <MachineText>{chunks}</MachineText>
      </bdi>
    ),
  }

  const title =
    dialog.action === "remove"
      ? t.rich("removeTitle", values)
      : dialog.action === "add"
        ? t.rich("addTitle", values)
        : t.rich(
            dialog.action === "enable" ? "enableTitle" : "disableTitle",
            values
          )
  const confirmLabel =
    dialog.action === "remove"
      ? t("removeAction", { agent })
      : dialog.action === "add"
        ? t("addAction")
        : t(dialog.action === "enable" ? "enableAction" : "disableAction")

  return (
    <McpDialogFrame
      title={title}
      onRequestClose={close}
      footer={
        <>
          <Button type="button" variant="outline" onClick={close}>
            {tDialog("cancel")}
          </Button>
          <Button
            type="button"
            variant={dialog.action === "remove" ? "destructive" : "default"}
            disabled={dialog.action === "add" && dialog.choice === null}
            onClick={() => confirmSwitch(slots, dialog.id)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="min-w-0 space-y-3 text-sm">
        {dialog.action === "remove" && <p>{t("removeBody", { agent })}</p>}
        {dialog.action === "add" && dialog.choices.length > 1 && (
          <>
            <p>{t("chooseBody", { agent })}</p>
            <RadioGroup
              value={dialog.choice ?? ""}
              aria-label={t("chooseLabel")}
              onValueChange={(choice) =>
                updateDialog(slots, dialog.id, "confirm", (prev) => ({
                  ...prev,
                  choice,
                }))
              }
              className="gap-2"
            >
              {/* As they were when the question opened: the one picked is
                  what gets written. */}
              {dialog.choices.map((choice) => {
                const id = `mcp-choice-${dialog.id}-${choice.letter}`
                return (
                  <div
                    key={choice.fingerprint}
                    className="flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5"
                  >
                    <RadioGroupItem
                      id={id}
                      value={choice.fingerprint}
                      className="mt-0.5"
                    />
                    <label htmlFor={id} className="min-w-0 flex-1 space-y-1.5">
                      <span className="block text-xs">
                        <span className="font-semibold">
                          {t("definitionLetter", { letter: choice.letter })}
                        </span>
                        <span className="text-muted-foreground">
                          {" · "}
                          {labels.list(choice.agents.map(labels.agent))}
                        </span>
                      </span>
                      <McpDefinitionView definition={choice.definition} />
                    </label>
                  </div>
                )
              })}
            </RadioGroup>
          </>
        )}
        {path && (
          <div className="space-y-0.5 text-xs">
            <p className="text-muted-foreground">{tAgent("file")}</p>
            <PathText path={path} className="text-xs" />
          </div>
        )}
        {comments && (
          <p className="flex items-start gap-1.5 text-xs text-tone-warning">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span className="min-w-0">{t("commentsLost")}</span>
          </p>
        )}
      </div>
    </McpDialogFrame>
  )
}
