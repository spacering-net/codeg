"use client"

import { useRef, useState, type ReactNode } from "react"
import { ArrowLeft, Loader2, ScanText, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  backToInput,
  canCommit,
  closeDialog,
  commitDialog,
  isAgentBusy,
  MCP_BUSY,
  parsePaste,
  reviewDialog,
  updateDialog,
  type McpPasteDialog as McpPasteDialogState,
} from "@/lib/harness/mcp-state"
import { holderAgentIds, type McpModel } from "@/lib/mcp/model"
import { agentsOf } from "@/lib/mcp/ops"
import {
  pasteIssue,
  pasteReady,
  pasteTargetsFor,
  type McpPasteChoice,
} from "@/lib/mcp/paste"
import { isSaved } from "@/lib/mcp/results"
import type { McpAppType } from "@/lib/mcp/types"
import { Code } from "../discover/detail-sections"
import { DiscoverMark } from "../discover/discover-card"
import { MachineText } from "../machine-text"
import { McpDefinitionView } from "./mcp-definition-view"
import { DiscardChangesDialog, McpDialogFrame } from "./mcp-dialog-frame"
import { McpResults, McpReview } from "./mcp-plan"
import {
  McpTargetList,
  useTargetBlockText,
  type McpTargetRow,
} from "./mcp-target-list"
import { useMcpLabels } from "./use-mcp-labels"

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

function ServerCard({
  dialog,
  model,
  index,
}: {
  dialog: McpPasteDialogState
  model: McpModel
  index: number
}) {
  const t = useTranslations("Harness.mcp.paste")
  const tEditor = useTranslations("Harness.mcp.editor")
  const labels = useMcpLabels()
  const blockText = useTargetBlockText()
  const { slots } = useHarnessView()
  const snippet = dialog.parse.snippet!
  const server = snippet.servers[index]
  const choice = dialog.choices[index] ?? { name: "", chosen: false }
  const issue = pasteIssue(snippet, dialog.choices, index, model)
  const name = choice.name.trim()
  const existing = name ? model.server(name) : undefined
  const { agents, skipped } = pasteTargetsFor(
    snippet,
    index,
    choice.name,
    dialog.targets,
    model
  )
  const replaced = existing
    ? existing.holders.filter(
        (holder) => holder.info.agent && agents.includes(holder.info.agent)
      )
    : []
  const extra = Object.keys(server.extra)
  // A name the engine found reserved or invalid is checked by the name field
  // itself, which follows what is typed into it: not said twice.
  const problems = server.problems.filter(
    (problem) =>
      problem.code !== "key_reserved" && problem.code !== "key_invalid"
  )
  // One line per reason: "Not added to Codex, ZCode: cannot use SSE".
  const skippedGroups: {
    id: string
    block: (typeof skipped)[number]["block"]
    agents: McpAppType[]
  }[] = []
  for (const { agent, block } of skipped) {
    const id =
      block.kind === "transport"
        ? `transport:${block.transport}`
        : block.kind === "key"
          ? `key:${block.problem}`
          : `agent:${agent}`
    const group = skippedGroups.find((entry) => entry.id === id)
    if (group) group.agents.push(agent)
    else skippedGroups.push({ id, block, agents: [agent] })
  }
  const nameId = `mcp-paste-${dialog.id}-${index}`
  const setChoice = (patch: Partial<McpPasteChoice>) =>
    updateDialog(slots, dialog.id, "paste", (prev) => ({
      ...prev,
      choices: prev.choices.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry
      ),
    }))

  return (
    <li className="min-w-0 space-y-2.5 px-3 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Checkbox
          checked={choice.chosen && server.definition !== null}
          disabled={server.definition === null}
          aria-label={t("add", { name: name || t("unnamed") })}
          onCheckedChange={(checked) => setChoice({ chosen: checked === true })}
          className="mt-2 max-md:size-5"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          {server.definition ? (
            <>
              <label htmlFor={nameId} className="text-xs text-muted-foreground">
                {t("name")}
              </label>
              <Input
                id={nameId}
                value={choice.name}
                aria-invalid={(choice.chosen && issue !== null) || undefined}
                placeholder={t("namePlaceholder")}
                dir="ltr"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                maxLength={200}
                className="font-mono text-[0.8125rem] max-md:h-10"
                onChange={(event) => setChoice({ name: event.target.value })}
              />
              {choice.chosen && issue && (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <TriangleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <span className="min-w-0">
                    {issue.kind === "repeated"
                      ? t("repeated")
                      : issue.problem === "empty"
                        ? t("nameNeeded")
                        : issue.problem === "reserved"
                          ? tEditor.rich("keyReserved", { code })
                          : tEditor("keyInvalid")}
                  </span>
                </p>
              )}
            </>
          ) : (
            <p className="text-sm font-medium">
              {server.key ? (
                <bdi dir="ltr" className="font-mono">
                  <MachineText>{server.key}</MachineText>
                </bdi>
              ) : (
                t("unnamed")
              )}{" "}
              <DiscoverMark tone="warning">{t("notAServer")}</DiscoverMark>
            </p>
          )}
        </div>
      </div>
      {server.definition && (
        <McpDefinitionView
          definition={server.definition}
          className="rounded-lg bg-muted/40 px-3 py-2"
        />
      )}
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {problems.map((problem, position) => (
            <li key={position} className="flex min-w-0 items-start gap-1.5">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-3 shrink-0 text-tone-warning"
              />
              <span className="min-w-0">
                {labels.issue(problem, "snippet")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {extra.length > 0 && (
        <p className="text-2xs text-muted-foreground">
          {t("extraNotWritten")}{" "}
          <bdi dir="ltr" className="font-mono">
            <MachineText>{extra.join(", ")}</MachineText>
          </bdi>
        </p>
      )}
      {choice.chosen && server.definition && !issue && replaced.length > 0 && (
        <p className="text-xs text-tone-warning">
          {t("replaces", {
            agents: labels.list(holderAgentIds(replaced).map(labels.agent)),
          })}
        </p>
      )}
      {choice.chosen && server.definition && skippedGroups.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {skippedGroups.map(({ id, block, agents: names }) => (
            <li key={id}>
              {t("skipped", {
                agents: labels.list(names.map(labels.agent)),
              })}{" "}
              {blockText(block)}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Paste a piece of configuration — a README's `mcpServers` block, another
 * agent's entry, Codex's TOML — and add the servers it names: each one
 * confirmed, named where it needs a name, and written only to the agents
 * picked here that can hold it.
 */
export function McpPasteDialog({
  dialog,
  model,
}: {
  dialog: McpPasteDialogState
  model: McpModel | null
}) {
  const t = useTranslations("Harness.mcp.paste")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const tTargets = useTranslations("Harness.mcp.targets")
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const [busy] = useHarnessSlot(MCP_BUSY)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const { flow, parse } = dialog
  const snippet = parse.snippet
  const saved =
    flow.step === "result" && flow.result !== null && isSaved(flow.result)
  const close = () => closeDialog(slots, dialog.id)
  const requestClose = () => {
    if (flow.step === "saving") return
    if (dialog.text.trim() !== "" && !saved) setConfirmingClose(true)
    else close()
  }
  const planBusy = flow.plan
    ? agentsOf(flow.plan.ops).some((agent) => isAgentBusy(busy, agent))
    : false

  let body: ReactNode
  let footer: ReactNode
  if (flow.step === "input" && dialog.stage === "text") {
    const unknown =
      parse.phase === "ready" && snippet && snippet.servers.length === 0
    body = (
      <div className="min-w-0 space-y-2">
        <label
          htmlFor={`mcp-paste-text-${dialog.id}`}
          className="text-sm font-medium"
        >
          {t("textLabel")}
        </label>
        <Textarea
          ref={textRef}
          id={`mcp-paste-text-${dialog.id}`}
          value={dialog.text}
          rows={10}
          dir="ltr"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          className="min-h-48 font-mono text-xs [field-sizing:fixed]"
          onChange={(event) =>
            updateDialog(slots, dialog.id, "paste", (prev) => ({
              ...prev,
              text: event.target.value,
            }))
          }
        />
        <p className="text-xs text-muted-foreground">
          {t.rich("textHint", { code })}
        </p>
        {unknown && (
          <div
            role="alert"
            className="space-y-0.5 rounded-lg bg-tone-warning/10 px-3 py-2 text-xs"
          >
            {(snippet.problems.length > 0
              ? snippet.problems
              : [{ code: "snippet_unrecognized" }]
            ).map((problem, index) => (
              <p key={index} className="flex items-start gap-1.5">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
                />
                <span className="min-w-0">
                  {labels.issue(problem, "snippet")}
                  {"detail" in problem && problem.detail && (
                    <bdi
                      dir="ltr"
                      className="mt-0.5 block font-mono text-2xs text-muted-foreground"
                    >
                      <MachineText>{problem.detail}</MachineText>
                    </bdi>
                  )}
                </span>
              </p>
            ))}
          </div>
        )}
        {parse.phase === "error" && parse.failure && (
          <p role="alert" className="text-xs text-tone-warning">
            {parse.failure.kind === "unsupported"
              ? t("unsupported")
              : t("failed")}
            {parse.failure.detail && (
              <bdi
                dir="ltr"
                className="mt-0.5 block font-mono text-2xs text-muted-foreground"
              >
                <MachineText>{parse.failure.detail}</MachineText>
              </bdi>
            )}
          </p>
        )}
      </div>
    )
    footer = (
      <>
        <Button type="button" variant="outline" onClick={requestClose}>
          {tDialog("cancel")}
        </Button>
        <Button
          type="button"
          disabled={dialog.text.trim() === "" || parse.phase === "loading"}
          onClick={() => void parsePaste(slots, dialog.id)}
        >
          {parse.phase === "loading" ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <ScanText aria-hidden="true" />
          )}
          {t("read")}
        </Button>
      </>
    )
  } else if (flow.step === "input") {
    const chosen =
      snippet?.servers.filter((_, index) => dialog.choices[index]?.chosen)
        .length ?? 0
    const targetRows: McpTargetRow[] =
      model && snippet
        ? model.agents.flatMap((info): McpTargetRow[] => {
            const agent = info.agent
            if (!agent) return []
            const count = snippet.servers.filter(
              (_, index) =>
                dialog.choices[index]?.chosen &&
                pasteTargetsFor(
                  snippet,
                  index,
                  dialog.choices[index]?.name ?? "",
                  [agent],
                  model
                ).agents.length > 0
            ).length
            const ticked = dialog.targets.includes(agent)
            // Said in words, not only in colour: a save rewrites the whole
            // file, and a YAML file loses its comments with it.
            const commentsLost =
              ticked && info.inventory.config.comments_lost_on_write
            return [
              {
                info,
                agent,
                checked: ticked && !info.editBlock,
                block: info.editBlock
                  ? { kind: "agent", block: info.editBlock }
                  : null,
                // Said only where it is worth noticing: a ticked agent that
                // gets fewer than the servers chosen, a file that loses its
                // comments.
                note:
                  [
                    ticked && count < chosen
                      ? t("getsServers", { count })
                      : null,
                    commentsLost ? tTargets("commentsLost") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || null,
                warn: commentsLost,
              },
            ]
          })
        : []
    body =
      model && snippet ? (
        <div className="min-w-0 space-y-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              updateDialog(slots, dialog.id, "paste", (prev) => ({
                ...prev,
                stage: "text",
              }))
            }
            className="-ms-2 max-md:h-10"
          >
            <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
            {t("editText")}
          </Button>
          <p className="text-sm">
            {t("found", { count: snippet.servers.length })}
          </p>
          <ul className="divide-y rounded-lg border">
            {snippet.servers.map((_, index) => (
              <ServerCard
                key={index}
                dialog={dialog}
                model={model}
                index={index}
              />
            ))}
          </ul>
          <McpTargetList
            rows={targetRows}
            legend={t("addTo")}
            onToggle={(agent: McpAppType, checked) =>
              updateDialog(slots, dialog.id, "paste", (prev) => ({
                ...prev,
                targets: checked
                  ? [...prev.targets.filter((entry) => entry !== agent), agent]
                  : prev.targets.filter((entry) => entry !== agent),
              }))
            }
          />
          <p className="text-xs text-muted-foreground">{t("secretsPlain")}</p>
        </div>
      ) : null
    footer = (
      <>
        <Button type="button" variant="outline" onClick={requestClose}>
          {tDialog("cancel")}
        </Button>
        <Button
          type="button"
          disabled={
            !model ||
            !snippet ||
            !pasteReady(snippet, dialog.choices, dialog.targets, model) ||
            planBusy
          }
          onClick={() => void reviewDialog(slots, dialog.id)}
        >
          {tDialog("review")}
        </Button>
      </>
    )
  } else if (flow.step === "review" || flow.step === "saving") {
    const again =
      flow.preflight?.outcome === "changed_elsewhere" || flow.failure !== null
    body = <McpReview flow={flow} />
    footer = (
      <>
        <Button
          type="button"
          variant="outline"
          disabled={flow.step === "saving"}
          onClick={() => backToInput(slots, dialog.id)}
        >
          {tDialog("back")}
        </Button>
        {again ? (
          <Button
            type="button"
            onClick={() => void reviewDialog(slots, dialog.id)}
          >
            {tDialog("checkAgain")}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={!canCommit(flow) || flow.step === "saving" || planBusy}
            onClick={() => void commitDialog(slots, dialog.id)}
          >
            {flow.step === "saving" ? tDialog("saving") : tDialog("save")}
          </Button>
        )}
      </>
    )
  } else {
    body = <McpResults flow={flow} />
    footer = saved ? (
      <Button type="button" onClick={close}>
        {tDialog("done")}
      </Button>
    ) : (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={() => backToInput(slots, dialog.id)}
        >
          {tDialog("back")}
        </Button>
        {flow.result?.outcome === "busy" ? (
          <Button
            type="button"
            disabled={planBusy}
            onClick={() => void commitDialog(slots, dialog.id)}
          >
            {tDialog("retry")}
          </Button>
        ) : (
          <Button type="button" onClick={requestClose}>
            {tDialog("close")}
          </Button>
        )}
      </>
    )
  }

  return (
    <>
      <McpDialogFrame
        title={t("title")}
        description={flow.step === "input" ? t("description") : undefined}
        onRequestClose={requestClose}
        footer={footer}
        step={`${flow.step}:${dialog.stage}`}
        size="wide"
        initialFocus={() => textRef.current}
      >
        {body}
      </McpDialogFrame>
      <DiscardChangesDialog
        open={confirmingClose}
        onKeep={() => setConfirmingClose(false)}
        onDiscard={() => {
          setConfirmingClose(false)
          close()
        }}
      />
    </>
  )
}
