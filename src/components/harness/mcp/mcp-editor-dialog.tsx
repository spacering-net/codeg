"use client"

import { useRef, useState, type ReactNode } from "react"
import { Plus, RefreshCw, Sparkles, TriangleAlert, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { ToggleGroup } from "radix-ui"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  applyEditorPreset,
  backToInput,
  canCommit,
  closeDialog,
  commitDialog,
  editorIsDirty,
  isAgentBusy,
  keepEditorVersion,
  MCP_BUSY,
  reloadEditor,
  reviewDialog,
  updateDialog,
  updateEditorDraft,
  type McpEditorDialog as McpEditorDialogState,
} from "@/lib/harness/mcp-state"
import {
  definitionFromDraft,
  definitionToJson,
  draftFromDefinition,
  draftProblems,
  emptyDraft,
  newRowId,
  parseDefinitionJson,
  remoteUrlHint,
  sameDefinition,
  type McpDraft,
  type McpDraftPair,
  type McpDraftProblem,
  type McpJsonProblem,
} from "@/lib/mcp/draft"
import {
  editorDefinition,
  editorDrift,
  editorIssues,
  editorKey,
  editorTargetBlock,
  effectiveTargets,
} from "@/lib/mcp/editor"
import { agentsOf } from "@/lib/mcp/ops"
import type { McpKeyProblem } from "@/lib/mcp/keys"
import type { McpModel } from "@/lib/mcp/model"
import { isSaved } from "@/lib/mcp/results"
import {
  definitionSecrets,
  hasSecrets,
  isSecretArg,
  isSecretEntry,
  maskDefinition,
  urlHasSecret,
} from "@/lib/mcp/secrets"
import {
  MCP_TRANSPORTS,
  type McpAppType,
  type McpDefinition,
} from "@/lib/mcp/types"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { MachineText } from "../machine-text"
import { MCP_SECTION_TITLE_CLASS, RevealButton } from "./mcp-bits"
import { DiscardChangesDialog, McpDialogFrame } from "./mcp-dialog-frame"
import { McpResults, McpReview } from "./mcp-plan"
import { McpTargetList, type McpTargetRow } from "./mcp-target-list"
import { SUGGESTED_SERVERS, type SuggestedServer } from "./suggested-servers"
import { useMcpLabels } from "./use-mcp-labels"

const SEGMENT_CLASS = cn(
  "h-8 flex-1 rounded-full px-3 text-[0.8125rem] font-medium whitespace-nowrap",
  "max-md:h-9 text-muted-foreground outline-none transition-colors hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
)

const TRACK_CLASS =
  "flex h-9 w-full min-w-0 items-center gap-0.5 rounded-full bg-muted/70 p-0.5 ws-msg-chip max-md:h-10 @sm/editor:w-fit"

function suggestionDefinition(suggested: SuggestedServer): McpDefinition {
  const { spec } = suggested
  return { type: spec.type, command: spec.command, args: [...spec.args] }
}

function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-xs text-destructive">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

function useKeyProblemText(): (problem: McpKeyProblem) => ReactNode {
  const t = useTranslations("Harness.mcp.editor")
  return (problem) => {
    switch (problem) {
      case "empty":
        return t("keyEmpty")
      case "reserved":
        return t.rich("keyReserved", {
          code: (chunks) => <Code>{chunks}</Code>,
        })
      case "invalid":
        return t("keyInvalid")
    }
  }
}

function useJsonProblemText(): (problem: McpJsonProblem) => ReactNode {
  const t = useTranslations("Harness.mcp.json")
  const code = (chunks: ReactNode) => <Code>{chunks}</Code>
  return (problem) => {
    switch (problem.kind) {
      case "syntax":
        return t("syntax")
      case "notObject":
        return t("notObject")
      case "type":
        return t.rich("type", { value: problem.value, code })
      case "noTransport":
        return t("noTransport")
      case "fieldType":
        return t.rich("fieldType", { field: problem.field, code })
      case "unknownField":
        return t.rich("unknownField", { field: problem.field, code })
      case "wrongTransportField":
        return t.rich("wrongTransportField", { field: problem.field, code })
    }
  }
}

// ─── The rows of a list ───────────────────────────────────────────────

function ArgsEditor({
  args,
  problems,
  onChange,
}: {
  args: McpDraft["args"]
  problems: McpDraftProblem[]
  onChange: (args: McpDraft["args"]) => void
}) {
  const t = useTranslations("Harness.mcp.editor")
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set())
  const listRef = useRef<HTMLUListElement>(null)
  const values = args.map((arg) => arg.value)
  const empty = new Set(
    problems.flatMap((problem) =>
      problem.kind === "argEmpty" ? [problem.index] : []
    )
  )
  const add = () => {
    onChange([...args, { id: newRowId(), value: "" }])
    // After the row is drawn.
    requestAnimationFrame(() => {
      const inputs = listRef.current?.querySelectorAll("input")
      inputs?.[inputs.length - 1]?.focus()
    })
  }
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-sm font-medium">{t("args")}</p>
      {args.length > 0 && (
        <ul ref={listRef} className="space-y-1.5">
          {args.map((arg, index) => {
            const secret = isSecretArg(values, index)
            const shown = !secret || revealed.has(arg.id)
            const label = t("argLabel", { index: index + 1 })
            return (
              <li key={arg.id} className="flex min-w-0 items-center gap-1.5">
                <Input
                  data-mcp-field={`arg-${index}`}
                  value={arg.value}
                  type={shown ? "text" : "password"}
                  aria-label={label}
                  aria-invalid={empty.has(index) || undefined}
                  dir="ltr"
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  className="min-w-0 flex-1 font-mono text-[0.8125rem] max-md:h-10"
                  onChange={(event) => {
                    // What the user is typing is shown to them: only a
                    // value that was already there opens masked.
                    if (!revealed.has(arg.id)) {
                      setRevealed((prev) => new Set(prev).add(arg.id))
                    }
                    onChange(
                      args.map((entry) =>
                        entry.id === arg.id
                          ? { ...entry, value: event.target.value }
                          : entry
                      )
                    )
                  }}
                />
                {secret && (
                  <RevealButton
                    revealed={revealed.has(arg.id)}
                    label={label}
                    onToggle={() =>
                      setRevealed((prev) => {
                        const next = new Set(prev)
                        if (next.has(arg.id)) next.delete(arg.id)
                        else next.add(arg.id)
                        return next
                      })
                    }
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("removeArg", { index: index + 1 })}
                  title={t("removeArg", { index: index + 1 })}
                  onClick={() =>
                    onChange(args.filter((entry) => entry.id !== arg.id))
                  }
                  className="shrink-0 text-muted-foreground max-md:size-10"
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {empty.size > 0 && <FieldError>{t("argEmpty")}</FieldError>}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={add}
        className="-ms-2 max-md:h-10"
      >
        <Plus aria-hidden="true" />
        {t("addArg")}
      </Button>
    </div>
  )
}

function PairsEditor({
  list,
  rows,
  problems,
  onChange,
}: {
  list: "env" | "headers"
  rows: McpDraftPair[]
  problems: McpDraftProblem[]
  onChange: (rows: McpDraftPair[]) => void
}) {
  const t = useTranslations("Harness.mcp.editor")
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set())
  const listRef = useRef<HTMLUListElement>(null)
  const nameless = new Set(
    problems.flatMap((problem) =>
      problem.kind === "nameRequired" && problem.list === list
        ? [problem.index]
        : []
    )
  )
  const repeated = problems.flatMap((problem) =>
    problem.kind === "nameRepeated" && problem.list === list
      ? [problem.name]
      : []
  )
  const update = (id: number, patch: Partial<McpDraftPair>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const add = () => {
    onChange([...rows, { id: newRowId(), name: "", value: "" }])
    requestAnimationFrame(() => {
      const names = listRef.current?.querySelectorAll<HTMLInputElement>(
        "[data-mcp-pair-name]"
      )
      names?.[names.length - 1]?.focus()
    })
  }
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-sm font-medium">
        {t(list === "env" ? "env" : "headers")}
      </p>
      {rows.length > 0 && (
        <ul ref={listRef} className="space-y-1.5">
          {rows.map((row, index) => {
            const secret = isSecretEntry(row.name, row.value)
            const shown = !secret || revealed.has(row.id)
            const nameLabel = t(list === "env" ? "envName" : "headerName", {
              index: index + 1,
            })
            const valueLabel = t(list === "env" ? "envValue" : "headerValue", {
              index: index + 1,
            })
            return (
              <li
                key={row.id}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1.5 @md/editor:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]"
              >
                <Input
                  data-mcp-pair-name=""
                  data-mcp-field={`${list}-${index}`}
                  value={row.name}
                  aria-label={nameLabel}
                  aria-invalid={
                    nameless.has(index) ||
                    repeated.includes(row.name.trim()) ||
                    undefined
                  }
                  placeholder={t(
                    list === "env"
                      ? "envNamePlaceholder"
                      : "headerNamePlaceholder"
                  )}
                  dir="ltr"
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  className="min-w-0 font-mono text-[0.8125rem] max-md:h-10"
                  onChange={(event) =>
                    update(row.id, { name: event.target.value })
                  }
                />
                <div className="order-last col-span-2 flex min-w-0 items-center gap-1.5 @md/editor:order-none @md/editor:col-span-1">
                  <Input
                    value={row.value}
                    type={shown ? "text" : "password"}
                    aria-label={valueLabel}
                    placeholder={t("valuePlaceholder")}
                    dir="ltr"
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="off"
                    className="min-w-0 flex-1 font-mono text-[0.8125rem] max-md:h-10"
                    onChange={(event) =>
                      update(row.id, { value: event.target.value })
                    }
                  />
                  {secret && (
                    <RevealButton
                      revealed={revealed.has(row.id)}
                      label={row.name.trim() || valueLabel}
                      onToggle={() =>
                        setRevealed((prev) => {
                          const next = new Set(prev)
                          if (next.has(row.id)) next.delete(row.id)
                          else next.add(row.id)
                          return next
                        })
                      }
                    />
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(list === "env" ? "removeEnv" : "removeHeader", {
                    index: index + 1,
                  })}
                  title={t(list === "env" ? "removeEnv" : "removeHeader", {
                    index: index + 1,
                  })}
                  onClick={() =>
                    onChange(rows.filter((entry) => entry.id !== row.id))
                  }
                  className="shrink-0 text-muted-foreground max-md:size-10"
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {nameless.size > 0 && <FieldError>{t("nameRequired")}</FieldError>}
      {repeated.map((name) => (
        <FieldError key={name}>
          {t.rich("nameRepeated", {
            name,
            code: (chunks) => <Code>{chunks}</Code>,
          })}
        </FieldError>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={add}
        className="-ms-2 max-md:h-10"
      >
        <Plus aria-hidden="true" />
        {t(list === "env" ? "addEnv" : "addHeader")}
      </Button>
    </div>
  )
}

// ─── The form ─────────────────────────────────────────────────────────

function FormView({
  dialog,
  attempted,
}: {
  dialog: McpEditorDialogState
  attempted: boolean
}) {
  const t = useTranslations("Harness.mcp.editor")
  const labels = useMcpLabels()
  const { slots } = useHarnessView()
  const { draft } = dialog
  const problems = attempted ? draftProblems(draft) : []
  const has = (kind: McpDraftProblem["kind"]) =>
    problems.some((problem) => problem.kind === kind)
  const set = (patch: Partial<McpDraft>) =>
    updateEditorDraft(slots, dialog.id, (prev) => ({ ...prev, ...patch }))
  const urlHint = draft.transport !== "stdio" ? remoteUrlHint(draft.url) : null
  // An address with a password or a key in it opens masked, like any other
  // secret; typing into it shows it.
  const [urlRevealed, setUrlRevealed] = useState(false)
  const urlSecret = urlHasSecret(draft.url)
  const urlMasked = urlSecret && !urlRevealed

  return (
    <div className="min-w-0 space-y-4">
      <div className="min-w-0 space-y-1.5">
        <p id={`mcp-transport-${dialog.id}`} className="text-sm font-medium">
          {t("transport")}
        </p>
        <ToggleGroup.Root
          type="single"
          value={draft.transport}
          aria-labelledby={`mcp-transport-${dialog.id}`}
          onValueChange={(value) => {
            const next = MCP_TRANSPORTS.find((entry) => entry === value)
            if (next) set({ transport: next })
          }}
          className={TRACK_CLASS}
        >
          {MCP_TRANSPORTS.map((transport) => (
            <ToggleGroup.Item
              key={transport}
              value={transport}
              className={SEGMENT_CLASS}
            >
              {labels.transport(transport)}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        <p className="text-xs text-muted-foreground">
          {t(`transportHint.${draft.transport}`)}
        </p>
      </div>

      {draft.transport === "stdio" ? (
        <>
          <div className="min-w-0 space-y-1.5">
            <label
              htmlFor={`mcp-command-${dialog.id}`}
              className="text-sm font-medium"
            >
              {t("command")}
            </label>
            <Input
              id={`mcp-command-${dialog.id}`}
              data-mcp-field="command"
              value={draft.command}
              placeholder="npx"
              aria-invalid={has("commandRequired") || undefined}
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className="font-mono text-[0.8125rem] max-md:h-10"
              onChange={(event) => set({ command: event.target.value })}
            />
            {has("commandRequired") && (
              <FieldError>{t("commandRequired")}</FieldError>
            )}
          </div>
          <ArgsEditor
            args={draft.args}
            problems={problems}
            onChange={(args) => set({ args })}
          />
          <PairsEditor
            list="env"
            rows={draft.env}
            problems={problems}
            onChange={(env) => set({ env })}
          />
        </>
      ) : (
        <>
          <div className="min-w-0 space-y-1.5">
            <label
              htmlFor={`mcp-url-${dialog.id}`}
              className="text-sm font-medium"
            >
              {t("url")}
            </label>
            <div className="flex min-w-0 items-center gap-1.5">
              <Input
                id={`mcp-url-${dialog.id}`}
                data-mcp-field="url"
                value={draft.url}
                type={urlMasked ? "password" : "url"}
                inputMode="url"
                placeholder="https://"
                aria-invalid={has("urlRequired") || undefined}
                aria-describedby={
                  urlHint ? `mcp-url-hint-${dialog.id}` : undefined
                }
                dir="ltr"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                className="min-w-0 flex-1 font-mono text-[0.8125rem] max-md:h-10"
                onChange={(event) => {
                  setUrlRevealed(true)
                  set({ url: event.target.value })
                }}
              />
              {urlSecret && (
                <RevealButton
                  revealed={urlRevealed}
                  label={t("url")}
                  onToggle={() => setUrlRevealed((prev) => !prev)}
                />
              )}
            </div>
            {has("urlRequired") && <FieldError>{t("urlRequired")}</FieldError>}
            {urlHint && (
              <p
                id={`mcp-url-hint-${dialog.id}`}
                className="flex items-start gap-1.5 text-xs text-tone-warning"
              >
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span className="min-w-0">
                  {t(urlHint === "insecure" ? "urlInsecure" : "urlUnreadable")}
                </span>
              </p>
            )}
          </div>
          <PairsEditor
            list="headers"
            rows={draft.headers}
            problems={problems}
            onChange={(headers) => set({ headers })}
          />
        </>
      )}
    </div>
  )
}

// ─── The JSON view ────────────────────────────────────────────────────

/**
 * The same definition, as JSON, kept in step with the form both ways.
 *
 * Where the definition has secrets, the view opens masked and read-only — a
 * JSON view shows every value at once, and it is the view most likely to be
 * copied out or shared on screen. Showing the values is one deliberate step,
 * for the whole view, after which it can be edited. Text that is not a
 * definition stays as typed, marked, and is never dropped.
 */
function JsonView({ dialog }: { dialog: McpEditorDialogState }) {
  const t = useTranslations("Harness.mcp.json")
  const problemText = useJsonProblemText()
  const { slots } = useHarnessView()
  const definition = definitionFromDraft(dialog.draft)
  const secret = dialog.json === null && hasSecrets(definition)
  const masked = secret && !dialog.revealJson
  const text = masked
    ? definitionToJson(maskDefinition(definition))
    : (dialog.json?.text ?? definitionToJson(definition))
  const problem = dialog.json?.problem ?? null
  const problemId = `mcp-json-problem-${dialog.id}`

  const onText = (next: string) =>
    updateDialog(slots, dialog.id, "editor", (prev) => {
      const parsed = parseDefinitionJson(next)
      if ("problem" in parsed) {
        return { ...prev, json: { text: next, problem: parsed.problem } }
      }
      return {
        ...prev,
        draft: draftFromDefinition(parsed.definition, prev.draft),
        json: { text: next, problem: null },
      }
    })

  return (
    <div className="min-w-0 space-y-2">
      {(masked || dialog.revealJson) &&
        (hasSecrets(definition) || dialog.revealJson) && (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 text-muted-foreground">
              {masked ? t("masked") : t("revealed")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!masked && problem !== null}
              title={!masked && problem !== null ? t("fixToHide") : undefined}
              onClick={() =>
                updateDialog(slots, dialog.id, "editor", (prev) =>
                  prev.revealJson
                    ? prev.json?.problem
                      ? prev
                      : { ...prev, revealJson: false, json: null }
                    : { ...prev, revealJson: true }
                )
              }
              className="max-md:h-9"
            >
              {masked ? t("show") : t("hide")}
            </Button>
          </div>
        )}
      <Textarea
        data-mcp-field="json"
        aria-label={t("label")}
        aria-invalid={problem !== null || undefined}
        aria-describedby={problem ? problemId : undefined}
        readOnly={masked}
        value={text}
        dir="ltr"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        rows={12}
        className="min-h-48 font-mono text-xs leading-relaxed [field-sizing:fixed]"
        onChange={(event) => onText(event.target.value)}
      />
      {problem && (
        <FieldError id={problemId}>
          {problemText(problem)}
          {problem.kind === "syntax" && (
            <bdi
              dir="ltr"
              className="mt-0.5 block font-mono text-2xs text-muted-foreground"
            >
              <MachineText>{problem.detail}</MachineText>
            </bdi>
          )}
        </FieldError>
      )}
    </div>
  )
}

// ─── Apply to ─────────────────────────────────────────────────────────

function useEditorTargetRows(
  dialog: McpEditorDialogState,
  model: McpModel,
  definition: McpDefinition | null
): McpTargetRow[] {
  const t = useTranslations("Harness.mcp.targets")
  const server = model.server(editorKey(dialog))
  const origin = dialog.origin?.snapshot ?? {}
  return model.agents.flatMap((info): McpTargetRow[] => {
    const agent = info.agent
    if (!agent) return []
    const block = editorTargetBlock(dialog, model, agent)
    const ticked = dialog.targets.includes(agent)
    const holder = server?.holders.find((entry) => entry.info === info)
    const entry = holder?.entry
    // A row speaks only of what is worth noticing: an entry replaced that
    // this edit did not start from, one left off, comments lost. Adding,
    // updating and keeping go without saying — the tick says it.
    const notes: string[] = []
    let warn = false
    if (ticked && definition) {
      if (
        entry &&
        !(entry.definition && sameDefinition(entry.definition, definition)) &&
        !(agent in origin)
      ) {
        notes.push(t("willReplace"))
        warn = true
      }
      if (entry && !entry.enabled) notes.push(t("staysOff"))
      if (info.inventory.config.comments_lost_on_write) {
        notes.push(t("commentsLost"))
        warn = true
      }
    }
    const note: ReactNode = notes.length > 0 ? notes.join(" · ") : null
    return [
      {
        info,
        agent,
        checked: ticked && block === null,
        block,
        note,
        warn,
        holds: entry !== undefined,
      },
    ]
  })
}

function SecretsNote({
  definition,
  count,
}: {
  definition: McpDefinition
  count: number
}) {
  const t = useTranslations("Harness.mcp.editor")
  const labels = useMcpLabels()
  const secrets = definitionSecrets(definition)
  if (count === 0) return null
  const parts = [
    ...secrets.names,
    ...(secrets.args ? [t("secretArgs")] : []),
    ...(secrets.url ? [t("secretUrl")] : []),
  ]
  if (parts.length === 0) return null
  return (
    <p className="flex items-start gap-2 rounded-lg border border-tone-warning/30 bg-tone-warning/10 px-3 py-2 text-xs">
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
      />
      <span className="min-w-0">
        {t("secretsPlain", { names: labels.list(parts), count })}
      </span>
    </p>
  )
}

// ─── The dialog ───────────────────────────────────────────────────────

interface McpEditorDialogProps {
  dialog: McpEditorDialogState
  model: McpModel | null
}

/**
 * Add a server, or edit one of its definitions.
 *
 * The name, the transport, the command and its arguments one by one, the
 * variables and headers as rows — or the same as JSON. Then the agents it
 * goes to: by default, for a new server, the installed ones that can hold its
 * transport, and for an edit, the agents that hold the definition being
 * edited and no others. Then what will be written, file by file, as the
 * engine's preflight finds it; then the save, and each agent's own result.
 *
 * Everything typed lives in a slot: the editor is still open, as it was left,
 * after a trip to a conversation.
 */
export function McpEditorDialog({ dialog, model }: McpEditorDialogProps) {
  const t = useTranslations("Harness.mcp.editor")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const keyProblemText = useKeyProblemText()
  const { slots } = useHarnessView()
  const [busy] = useHarnessSlot(MCP_BUSY)
  const [attempted, setAttempted] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const { flow } = dialog
  const server = model?.server(dialog.key)
  const drift = model ? editorDrift(dialog, server) : null
  const dirty = editorIsDirty(dialog)
  const saved =
    flow.step === "result" && flow.result !== null && isSaved(flow.result)
  const issues = model ? editorIssues(dialog, model) : []
  const keyIssue = issues.find((issue) => issue.kind === "key")
  const targets = model ? effectiveTargets(dialog, model) : []
  const planBusy = (flow.plan ? agentsOf(flow.plan.ops) : targets).some(
    (agent) => isAgentBusy(busy, agent)
  )
  const untouched =
    dialog.mode === "create" &&
    dialog.json === null &&
    sameDefinition(
      definitionFromDraft(dialog.draft),
      definitionFromDraft(emptyDraft(dialog.draft.transport))
    )

  const close = () => closeDialog(slots, dialog.id)
  const requestClose = () => {
    if (flow.step === "saving") return
    if (dirty && !saved) setConfirmingClose(true)
    else close()
  }

  const review = () => {
    setAttempted(true)
    if (!model) return
    if (issues.length > 0) {
      // To the first field that holds the problem.
      const first = issues[0]
      const field =
        first.kind === "key"
          ? "name"
          : first.kind === "json"
            ? "json"
            : first.kind === "draft"
              ? first.problem.kind === "commandRequired"
                ? "command"
                : first.problem.kind === "urlRequired"
                  ? "url"
                  : first.problem.kind === "argEmpty"
                    ? `arg-${first.problem.index}`
                    : first.problem.kind === "nameRequired"
                      ? `${first.problem.list}-${first.problem.index}`
                      : null
              : null
      if (field) {
        document
          .querySelector<HTMLElement>(
            `[data-mcp-dialog="${dialog.id}"] [data-mcp-field="${field}"]`
          )
          ?.focus()
      }
      return
    }
    void reviewDialog(slots, dialog.id)
  }

  const title =
    dialog.mode === "create"
      ? t("createTitle")
      : t.rich(dialog.origin?.letter ? "editLetterTitle" : "editTitle", {
          key: dialog.key,
          letter: dialog.origin?.letter ?? "",
          code: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
        })

  let body: ReactNode
  let footer: ReactNode
  if (flow.step === "input") {
    body = (
      <EditorInput
        dialog={dialog}
        model={model}
        attempted={attempted}
        keyIssue={
          keyIssue?.kind === "key" ? keyProblemText(keyIssue.problem) : null
        }
        nameRef={nameRef}
        drift={drift}
        untouched={untouched}
        noTargets={
          attempted && issues.some((issue) => issue.kind === "noTargets")
        }
      />
    )
    const unchanged = dialog.mode === "edit" && !dirty
    footer = (
      <>
        {unchanged && (
          // Said, not only implied by a greyed button.
          <p className="me-auto text-xs text-muted-foreground">
            {t("nothingChanged")}
          </p>
        )}
        <Button type="button" variant="outline" onClick={requestClose}>
          {tDialog("cancel")}
        </Button>
        <Button
          type="button"
          onClick={review}
          disabled={!model || unchanged || drift !== null || planBusy}
        >
          {tDialog("review")}
        </Button>
      </>
    )
  } else if (flow.step === "review" || flow.step === "saving") {
    body = <McpReview flow={flow} />
    const again =
      flow.preflight?.outcome === "changed_elsewhere" || flow.failure !== null
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
            <RefreshCw aria-hidden="true" />
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
    const busyResult = flow.result?.outcome === "busy"
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
          {tDialog("backToEdit")}
        </Button>
        {busyResult ? (
          <Button
            type="button"
            disabled={planBusy}
            onClick={() => void commitDialog(slots, dialog.id)}
          >
            <RefreshCw aria-hidden="true" />
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
        title={title}
        description={
          flow.step === "input"
            ? t(
                dialog.mode === "create"
                  ? "createDescription"
                  : "editDescription"
              )
            : undefined
        }
        onRequestClose={requestClose}
        footer={footer}
        step={flow.step}
        size="wide"
        initialFocus={() =>
          dialog.mode === "create"
            ? nameRef.current
            : document.querySelector<HTMLElement>(
                `[data-mcp-dialog="${dialog.id}"] [data-mcp-field="command"], [data-mcp-dialog="${dialog.id}"] [data-mcp-field="url"]`
              )
        }
      >
        <div data-mcp-dialog={dialog.id} className="@container/editor min-w-0">
          {body}
        </div>
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

function EditorInput({
  dialog,
  model,
  attempted,
  keyIssue,
  nameRef,
  drift,
  untouched,
  noTargets,
}: {
  dialog: McpEditorDialogState
  model: McpModel | null
  attempted: boolean
  keyIssue: ReactNode
  nameRef: React.RefObject<HTMLInputElement | null>
  drift: "changed" | "removed" | null
  untouched: boolean
  noTargets: boolean
}) {
  const t = useTranslations("Harness.mcp.editor")
  const tJson = useTranslations("Harness.mcp.json")
  const tSection = useTranslations("Harness.mcp")
  const { slots } = useHarnessView()
  const definition = editorDefinition(dialog)
  const jsonProblem = dialog.json?.problem ?? null
  const [blockedSwitch, setBlockedSwitch] = useState(false)

  const setView = (view: "form" | "json") => {
    if (view === dialog.view) return
    if (view === "form" && jsonProblem) {
      setBlockedSwitch(true)
      return
    }
    setBlockedSwitch(false)
    updateDialog(slots, dialog.id, "editor", (prev) => ({
      ...prev,
      view,
      // Back in the form, the JSON view's text is the form's again.
      json: view === "form" ? null : prev.json,
    }))
  }

  return (
    <div className="min-w-0 space-y-5">
      {drift && (
        <div
          role="alert"
          className="flex min-w-0 flex-col gap-2 rounded-lg border border-tone-warning/30 bg-tone-warning/10 px-3 py-2.5 text-xs"
        >
          <p className="flex min-w-0 items-start gap-2">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
            />
            <span className="min-w-0">
              {t(drift === "changed" ? "driftChanged" : "driftRemoved")}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {drift === "changed" && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => reloadEditor(slots, dialog.id)}
                className="max-md:h-9"
              >
                <RefreshCw aria-hidden="true" />
                {t("driftReload")}
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => keepEditorVersion(slots, dialog.id)}
              className="max-md:h-9"
            >
              {t("driftKeep")}
            </Button>
          </div>
        </div>
      )}

      {dialog.mode === "create" && (
        <div className="min-w-0 space-y-1.5">
          <p className={MCP_SECTION_TITLE_CLASS}>{t("suggested")}</p>
          {SUGGESTED_SERVERS.map((suggested) => (
            <div key={suggested.key} className="space-y-1.5">
              {/* Only while nothing has been typed: "start from" is for a
                  form nobody has started, and a button that threw away a
                  definition someone had written — with no undo — would be a
                  bad trade for saving them a paste. A name already typed is
                  kept for the same reason. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!untouched}
                onClick={() =>
                  applyEditorPreset(slots, dialog.id, {
                    key: dialog.key.trim() === "" ? suggested.id : dialog.key,
                    definition: suggestionDefinition(suggested),
                  })
                }
                className="max-md:h-10"
              >
                <Sparkles aria-hidden="true" />
                {suggested.label}
              </Button>
              <p className="text-xs text-muted-foreground">
                {/* The note's key is relative to this section's messages. */}
                {tSection.rich(suggested.note, {
                  code: (chunks) => <Code>{chunks}</Code>,
                })}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="min-w-0 space-y-1.5">
        {dialog.mode === "create" ? (
          <>
            <label
              htmlFor={`mcp-name-${dialog.id}`}
              className="text-sm font-medium"
            >
              {t("name")}
            </label>
            <Input
              ref={nameRef}
              id={`mcp-name-${dialog.id}`}
              data-mcp-field="name"
              value={dialog.key}
              placeholder="github"
              aria-invalid={(attempted && keyIssue !== null) || undefined}
              aria-describedby={`mcp-name-hint-${dialog.id}`}
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              maxLength={200}
              className="font-mono text-[0.8125rem] max-md:h-10"
              onChange={(event) =>
                updateDialog(slots, dialog.id, "editor", (prev) => ({
                  ...prev,
                  key: event.target.value,
                }))
              }
            />
            {attempted && keyIssue && <FieldError>{keyIssue}</FieldError>}
            <p
              id={`mcp-name-hint-${dialog.id}`}
              className="text-xs text-muted-foreground"
            >
              {t("keyRule")}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">{t("name")}</p>
            <p className="text-sm">
              <bdi dir="ltr" className="font-mono">
                <MachineText>{dialog.key}</MachineText>
              </bdi>
            </p>
            <p className="text-xs text-muted-foreground">
              {t("renameElsewhere")}
            </p>
          </>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <ToggleGroup.Root
          type="single"
          value={dialog.view}
          aria-label={t("viewLabel")}
          onValueChange={(value) => {
            if (value === "form" || value === "json") setView(value)
          }}
          className={TRACK_CLASS}
        >
          <ToggleGroup.Item value="form" className={SEGMENT_CLASS}>
            {t("viewForm")}
          </ToggleGroup.Item>
          <ToggleGroup.Item value="json" className={SEGMENT_CLASS}>
            {t("viewJson")}
          </ToggleGroup.Item>
        </ToggleGroup.Root>
        {blockedSwitch && jsonProblem && (
          <div
            role="alert"
            className="flex min-w-0 flex-wrap items-center gap-2 text-xs"
          >
            <FieldError>{tJson("fixFirst")}</FieldError>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                setBlockedSwitch(false)
                updateDialog(slots, dialog.id, "editor", (prev) => ({
                  ...prev,
                  view: "form",
                  json: null,
                }))
              }}
              className="max-md:h-9"
            >
              {tJson("discard")}
            </Button>
          </div>
        )}
        {dialog.view === "form" ? (
          <FormView dialog={dialog} attempted={attempted} />
        ) : (
          <JsonView dialog={dialog} />
        )}
      </div>

      {model && (
        <EditorTargets
          dialog={dialog}
          model={model}
          definition={definition}
          noTargets={noTargets}
        />
      )}
    </div>
  )
}

function EditorTargets({
  dialog,
  model,
  definition,
  noTargets,
}: {
  dialog: McpEditorDialogState
  model: McpModel
  definition: McpDefinition | null
  noTargets: boolean
}) {
  const t = useTranslations("Harness.mcp.editor")
  const { slots } = useHarnessView()
  const rows = useEditorTargetRows(dialog, model, definition)
  const count = effectiveTargets(dialog, model).length
  const onToggle = (agent: McpAppType, checked: boolean) =>
    updateDialog(slots, dialog.id, "editor", (prev) => ({
      ...prev,
      targets: checked
        ? [...prev.targets.filter((entry) => entry !== agent), agent]
        : prev.targets.filter((entry) => entry !== agent),
    }))
  return (
    <div className="min-w-0 space-y-2">
      <McpTargetList rows={rows} onToggle={onToggle} legend={t("applyTo")} />
      <p className="text-xs text-muted-foreground">
        {t(dialog.mode === "create" ? "applyToCreate" : "applyToEdit")}
      </p>
      {noTargets && <FieldError>{t("noTargets")}</FieldError>}
      {definition && <SecretsNote definition={definition} count={count} />}
    </div>
  )
}
