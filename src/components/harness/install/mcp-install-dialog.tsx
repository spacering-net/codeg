"use client"

import { useId, useState, type ReactNode } from "react"
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useHarnessView } from "@/contexts/harness-view-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { oneOf, pickLocalized } from "@/lib/harness/display"
import { isRetryableFailure } from "@/lib/harness/errors"
import {
  chooseOption,
  chosenOption,
  installBlockersOf,
  installModeOf,
  isUndecided,
  keyProblemOf,
  needsYankedConfirm,
  packageStateOf,
  parameterProblemOf,
  setInstallKey,
  setValue,
  shownSnapshot,
  targetRowsOf,
  toggleReplace,
  toggleTarget,
  type McpInstallBlocker,
  type McpInstallInput,
  type McpInstallMode,
  type McpInstallTargetRow,
} from "@/lib/harness/mcp-install"
import {
  backToInstallInput,
  canConfirmInstall,
  closeHarnessDialog,
  confirmMcpInstall,
  planMcpInstall,
  updateHarnessDialog,
  updateInstallInput,
  type McpInstallDialog as McpInstallDialogState,
} from "@/lib/harness/mcp-install-state"
import type {
  HarnessMcpPlan,
  HarnessMcpPlanAgent,
  HarnessMcpPlanOption,
  HarnessMcpPlanParameter,
} from "@/lib/harness/mcp-install-types"
import { agentInfoOf, type McpAgentInfo } from "@/lib/mcp/model"
import {
  isMcpAppType,
  type McpAppType,
  type McpTransport,
} from "@/lib/mcp/types"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { DiscoverMark } from "../discover/discover-card"
import { useDiscoverLabels } from "../discover/use-discover-labels"
import { MachineText } from "../machine-text"
import { RevealButton } from "../mcp/mcp-bits"
import { McpDefinitionView } from "../mcp/mcp-definition-view"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { AgentResults, Headline, Technical } from "../mcp/mcp-plan"
import { McpTargetList, type McpTargetRow } from "../mcp/mcp-target-list"
import { useMcpLabels } from "../mcp/use-mcp-labels"
import {
  InstallBlocked,
  InstallChangeList,
  InstallFailureNotice,
  InstallItemLine,
  InstallPart,
  InstallReasonList,
  InstallSnapshot,
  YankedConfirm,
} from "./install-parts"
import { useInstallLabels } from "./use-install-labels"

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

/** A machine name inside a sentence: left to right, broken between its
 *  parts. */
const machine = (chunks: ReactNode) => (
  <bdi dir="ltr">
    <MachineText>{chunks}</MachineText>
  </bdi>
)

/**
 * An agent of the plan, in the shape the MCP section's target list reads:
 * what it can hold, whether it is installed, which servers it has. The plan
 * read these from the agents' files a moment ago; the list folds away the
 * agents that are not installed and hold nothing, as everywhere else.
 */
function agentInfoOfPlan(info: HarnessMcpPlanAgent): McpAgentInfo {
  return agentInfoOf({
    agent: info.agent,
    installed: info.installed,
    config: {
      path: info.path,
      format: "json",
      status: info.status,
      basis: info.basis,
      symlink: false,
      comments_lost_on_write: false,
      related: [],
    },
    writable: info.writable,
    transports: info.transports,
    delivery: "agent_file",
    can_disable: false,
    codeg_mcp: false,
    session_capabilities: null,
    entries: info.keys.map((key) => ({
      key,
      definition: null,
      extra: {},
      enabled: true,
      fingerprint: null,
      read_only: false,
      reserved: false,
      legacy: false,
      problems: [],
    })),
  })
}

/** The variables and headers an option marks secret, by their own names —
 *  masked wherever the option's definition is shown, whatever they are
 *  called. */
function secretNamesOf(option: HarnessMcpPlanOption): ReadonlySet<string> {
  return new Set(
    option.parameters
      .filter(
        (parameter) =>
          parameter.secret &&
          (parameter.location === "env" || parameter.location === "header")
      )
      .map((parameter) => parameter.name)
  )
}

function useParameterName(
  plan: HarnessMcpPlan | null
): (key: string) => string {
  return (key) => {
    for (const option of plan?.options ?? []) {
      const found = option.parameters.find((parameter) => parameter.key === key)
      if (found) return found.name
    }
    return key
  }
}

// ─── The input ────────────────────────────────────────────────────────

function OptionCard({
  plan,
  option,
  dialog,
  selected,
}: {
  plan: HarnessMcpPlan
  option: HarnessMcpPlanOption
  dialog: McpInstallDialogState
  selected: boolean
}) {
  const t = useTranslations("Harness.install.options")
  const mcp = useMcpLabels()
  const labels = useInstallLabels()
  const id = `mcp-install-${dialog.id}-option-${option.id}`
  const pkg = option.package
  const fresh = pkg
    ? packageStateOf(
        shownSnapshot(plan, dialog.restate),
        pkg.registry_type,
        pkg.identifier
      )
    : null
  const version = fresh ? fresh.version : (pkg?.version ?? null)
  const verified = fresh ? fresh.verified : (pkg?.verified ?? null)
  const blocking = option.selectable ? [] : option.blocking
  return (
    <div
      data-install-option={option.id}
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5",
        selected && "border-primary/60 bg-primary/5",
        !option.selectable && "bg-muted/30"
      )}
    >
      <RadioGroupItem
        id={id}
        value={option.id}
        disabled={!option.selectable}
        className="mt-0.5"
      />
      <label
        htmlFor={id}
        className={cn(
          "min-w-0 flex-1 space-y-1.5 text-xs",
          option.selectable ? "cursor-pointer" : "cursor-default"
        )}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">
            {mcp.transport(option.transport)}
          </span>
          <span className="text-muted-foreground">
            {t(option.source === "remote" ? "remote" : "package")}
          </span>
          {!option.selectable && (
            <DiscoverMark tone="danger">{t("notSelectable")}</DiscoverMark>
          )}
        </span>
        {pkg && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-muted-foreground">
              <bdi>{pkg.registry_type}</bdi>
            </span>
            <Code>
              {version ? `${pkg.identifier}@${version}` : pkg.identifier}
            </Code>
            {verified !== null && (
              <DiscoverMark
                tone={
                  verified === "ok"
                    ? "success"
                    : verified === "missing"
                      ? "danger"
                      : "warning"
                }
              >
                {labels.check(verified)}
              </DiscoverMark>
            )}
          </span>
        )}
        {option.source === "remote" && option.url && (
          <span className="block min-w-0">
            <Code>{option.url}</Code>
          </span>
        )}
        {blocking.length > 0 && (
          <InstallReasonList reasons={blocking} tone="blocking" />
        )}
        {option.warnings.length > 0 && (
          <InstallReasonList
            reasons={option.warnings}
            tone={
              option.warnings.some(
                (warning) =>
                  warning.code === "install_script" ||
                  warning.code === "version_unverified"
              )
                ? "warning"
                : "info"
            }
          />
        )}
      </label>
    </div>
  )
}

function OptionsPart({
  plan,
  dialog,
  input,
}: {
  plan: HarnessMcpPlan
  dialog: McpInstallDialogState
  input: McpInstallInput
}) {
  const t = useTranslations("Harness.install.options")
  const { slots } = useHarnessView()
  const chosen = chosenOption(plan, input)
  return (
    <InstallPart title={t("title")}>
      <RadioGroup
        value={input.optionId ?? ""}
        aria-label={t("title")}
        onValueChange={(optionId) =>
          updateInstallInput(slots, dialog.id, (prev, current) =>
            chooseOption(current, prev, optionId)
          )
        }
        className="gap-2"
      >
        {plan.options.map((option) => (
          <OptionCard
            key={option.id}
            plan={plan}
            option={option}
            dialog={dialog}
            selected={option.id === input.optionId}
          />
        ))}
      </RadioGroup>
      {chosen && (
        <div className="mt-2 min-w-0 rounded-lg border bg-muted/20 px-3 py-2.5">
          <p className="pb-1.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t(chosen.transport === "stdio" ? "run" : "reach")}
          </p>
          {chosen.definition ? (
            <McpDefinitionView
              definition={chosen.definition}
              secretNames={secretNamesOf(chosen)}
            />
          ) : chosen.url ? (
            <Code>{chosen.url}</Code>
          ) : (
            <p className="text-xs text-muted-foreground">{t("pending")}</p>
          )}
        </div>
      )}
    </InstallPart>
  )
}

/** A value the field takes from a closed list: a row of choices, or — for a
 *  long list — a menu. "Not set" is one of them where the field may be
 *  left empty. */
function ChoiceField({
  id,
  parameter,
  value,
  choices,
  onChange,
}: {
  id: string
  parameter: HarnessMcpPlanParameter
  value: string
  choices: readonly string[]
  onChange: (value: string) => void
}) {
  const t = useTranslations("Harness.install.params")
  const all = [
    ...(parameter.required && parameter.default === null ? [] : [""]),
    ...choices,
  ]
  const word = (choice: string) =>
    choice === "" ? (
      t("notSet")
    ) : (
      <bdi dir="ltr" className="font-mono">
        <MachineText>{choice}</MachineText>
      </bdi>
    )
  if (all.length <= 6) {
    return (
      <RadioGroup
        value={value}
        aria-labelledby={`${id}-label`}
        onValueChange={onChange}
        className="flex flex-wrap gap-x-4 gap-y-2"
      >
        {all.map((choice, index) => (
          <div key={index} className="flex min-w-0 items-center gap-2">
            <RadioGroupItem id={`${id}-choice-${index}`} value={choice} />
            <label
              htmlFor={`${id}-choice-${index}`}
              className="min-w-0 cursor-pointer text-xs"
            >
              {word(choice)}
            </label>
          </div>
        ))}
      </RadioGroup>
    )
  }
  // Radix keeps "" for "nothing chosen"; "Not set" needs a value of its own.
  const UNSET = "\u0000unset"
  return (
    <Select
      value={value === "" ? UNSET : all.includes(value) ? value : undefined}
      onValueChange={(next) => onChange(next === UNSET ? "" : next)}
    >
      <SelectTrigger
        id={id}
        aria-labelledby={`${id}-label`}
        className="w-full max-w-full min-w-0 max-md:h-10"
      >
        <SelectValue placeholder={t("choose")} />
      </SelectTrigger>
      <SelectContent>
        {all.map((choice, index) => (
          <SelectItem key={index} value={choice === "" ? UNSET : choice}>
            {word(choice)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Where a field's value came from, for an item that is installed: read back
 *  from its entries, those entries disagreeing (the user picks), or not read
 *  back at all (to be entered again). */
function RecoveredNote({
  dialogId,
  parameter,
  undecided,
  lost,
}: {
  dialogId: number
  parameter: HarnessMcpPlanParameter
  undecided: boolean
  lost: readonly string[] | null
}) {
  const t = useTranslations("Harness.install.params")
  const mcp = useMcpLabels()
  const { slots } = useHarnessView()
  const current = parameter.current
  if (lost && lost.length > 0 && !current) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-tone-warning">
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0"
        />
        <span className="min-w-0">
          {t("lost", { agents: mcp.list(lost.map(mcp.agent)) })}
        </span>
      </p>
    )
  }
  if (!current) return null
  const agents = mcp.list(current.agents.map(mcp.agent))
  if (!current.conflicting) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("recovered", { agents })}
      </p>
    )
  }
  if (!undecided) {
    return (
      <p className="text-xs text-muted-foreground">{t("disagreeSettled")}</p>
    )
  }
  const first = current.agents[0]
  return (
    <div
      data-install-disagree={parameter.key}
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-tone-warning/10 px-2.5 py-2 text-xs"
    >
      <span className="flex min-w-0 flex-1 basis-60 items-start gap-1.5">
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
        />
        <span className="min-w-0">{t("disagree", { agents })}</span>
      </span>
      {first && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() =>
            updateInstallInput(slots, dialogId, (prev) =>
              setValue(prev, parameter.key, current.value)
            )
          }
          className="max-md:h-9"
        >
          {t("useValue", { agent: mcp.agent(first) })}
        </Button>
      )}
    </div>
  )
}

function ParameterField({
  dialogId,
  parameter,
  value,
  undecided,
  lost,
}: {
  dialogId: number
  parameter: HarnessMcpPlanParameter
  value: string
  /** The agents' entries disagree and the user has not picked yet. */
  undecided: boolean
  /** Agents whose value for it could not be read back. */
  lost: readonly string[] | null
}) {
  const t = useTranslations("Harness.install.params")
  const { slots } = useHarnessView()
  // Revealing is the field's own: masked again whenever the dialog is drawn
  // anew.
  const [revealed, setRevealed] = useState(false)
  const id = `mcp-install-${dialogId}-param-${parameter.key}`
  const descriptionId = `${id}-description`
  const problem = parameterProblemOf(parameter, value)
  // "Required" is the summary's to say; a value that is wrong says so here.
  const shownProblem =
    problem && problem !== "required" && !undecided ? problem : null
  const location = oneOf(
    ["env", "header", "query", "arg"] as const,
    parameter.location
  )
  const set = (next: string) =>
    updateInstallInput(slots, dialogId, (prev) =>
      setValue(prev, parameter.key, next)
    )
  const common = {
    id,
    value,
    "aria-describedby": parameter.description ? descriptionId : undefined,
    "aria-invalid": shownProblem ? true : undefined,
    "aria-required": parameter.required || undefined,
    // A password field masks its value, not its placeholder: a secret's
    // default is never shown as one.
    placeholder:
      parameter.placeholder ??
      (parameter.secret ? undefined : (parameter.default ?? undefined)),
    dir: "ltr" as const,
    spellCheck: false,
    autoComplete: "off",
    autoCapitalize: "off",
  }
  const choices =
    parameter.choices.length > 0
      ? parameter.choices
      : parameter.kind === "boolean"
        ? ["true", "false"]
        : null
  let field: ReactNode
  if (choices && parameter.secret && !revealed) {
    // A secret one keeps its choice hidden until revealed, as any secret
    // value does; revealed, it is the choices below.
    field = (
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          {...common}
          type="password"
          readOnly
          data-install-secret="masked"
          className="min-w-0 flex-1 font-mono text-[0.8125rem] max-md:h-10"
        />
        <RevealButton
          revealed={revealed}
          onToggle={() => setRevealed(true)}
          label={parameter.name}
        />
      </div>
    )
  } else if (choices) {
    field = (
      <div className="flex min-w-0 items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <ChoiceField
            id={id}
            parameter={parameter}
            value={value}
            choices={choices}
            onChange={set}
          />
        </div>
        {parameter.secret && (
          <RevealButton
            revealed={revealed}
            onToggle={() => setRevealed(false)}
            label={parameter.name}
          />
        )}
      </div>
    )
  } else if (parameter.kind === "json" && (!parameter.secret || revealed)) {
    // A secret one is a masked line until revealed (below), then this.
    field = (
      <div className="flex min-w-0 items-start gap-1.5">
        <Textarea
          {...common}
          rows={3}
          data-install-secret={parameter.secret ? "shown" : undefined}
          onChange={(event) => set(event.target.value)}
          className="min-h-16 min-w-0 flex-1 font-mono text-[0.8125rem]"
        />
        {parameter.secret && (
          <RevealButton
            revealed={revealed}
            onToggle={() => setRevealed((prev) => !prev)}
            label={parameter.name}
          />
        )}
      </div>
    )
  } else {
    field = (
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          {...common}
          type={parameter.secret && !revealed ? "password" : "text"}
          inputMode={
            parameter.kind === "integer"
              ? "numeric"
              : parameter.kind === "number"
                ? "decimal"
                : undefined
          }
          data-install-secret={
            parameter.secret ? (revealed ? "shown" : "masked") : undefined
          }
          onChange={(event) => set(event.target.value)}
          className="min-w-0 flex-1 font-mono text-[0.8125rem] max-md:h-10"
        />
        {parameter.secret && (
          <RevealButton
            revealed={revealed}
            onToggle={() => setRevealed((prev) => !prev)}
            label={parameter.name}
          />
        )}
      </div>
    )
  }
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <label
          id={`${id}-label`}
          htmlFor={choices && (!parameter.secret || revealed) ? undefined : id}
          className="min-w-0 text-sm font-medium"
        >
          <bdi dir="ltr" className="font-mono">
            <MachineText>{parameter.name}</MachineText>
          </bdi>
        </label>
        <span className="flex flex-wrap items-center gap-1">
          {location && <DiscoverMark>{t(`location.${location}`)}</DiscoverMark>}
          <DiscoverMark tone={parameter.required ? "warning" : "neutral"}>
            {t(parameter.required ? "required" : "optional")}
          </DiscoverMark>
          {parameter.secret && (
            <DiscoverMark tone="info">{t("secret")}</DiscoverMark>
          )}
        </span>
      </div>
      {parameter.description && (
        <p
          id={descriptionId}
          dir="auto"
          className="text-xs break-words text-muted-foreground"
        >
          {parameter.description}
        </p>
      )}
      {field}
      <RecoveredNote
        dialogId={dialogId}
        parameter={parameter}
        undecided={undecided}
        lost={lost}
      />
      {shownProblem && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span className="min-w-0">{t(`problems.${shownProblem}`)}</span>
        </p>
      )}
    </div>
  )
}

/** A parameter key as the user knows it: the name of a variable, header or
 *  address part (machine text), or an argument by its place (words). */
function LostKeyName({ entryKey }: { entryKey: string }) {
  const t = useTranslations("Harness.install.recovery")
  const dot = entryKey.indexOf(".")
  const kind = dot === -1 ? entryKey : entryKey.slice(0, dot)
  const rest = dot === -1 ? "" : entryKey.slice(dot + 1)
  if (
    (kind === "package_arguments" || kind === "runtime_arguments") &&
    /^\d+$/.test(rest)
  ) {
    return t("argument", { index: Number(rest) + 1 })
  }
  if (kind === "args") return t("arguments")
  return <Code>{rest || entryKey}</Code>
}

/**
 * What an update cannot carry over from the entries this way of running it
 * installed: agents whose entry no longer fits it (nothing of theirs comes
 * along), and values no field here takes. Said before the user confirms, so
 * they can enter again whatever they still need.
 */
function RecoveryNotice({
  option,
  className,
}: {
  option: HarnessMcpPlanOption
  className?: string
}) {
  const t = useTranslations("Harness.install.recovery")
  const mcp = useMcpLabels()
  const recovery = option.recovery
  if (!recovery) return null
  // Every value an update would drop is listed here, by the key it was
  // installed under — also one whose field is here: that field may now hold
  // another value read back (an argument that moved), and the old one must
  // not go unmentioned.
  const elsewhere = recovery.lost
  if (recovery.unmatched.length === 0 && elsewhere.length === 0) return null
  return (
    <div
      role="note"
      data-install-recovery=""
      className={cn(
        "min-w-0 space-y-1.5 rounded-lg border border-tone-warning/30 bg-tone-warning/10 px-3 py-2.5 text-xs",
        className
      )}
    >
      <p className="text-sm font-medium">{t("title")}</p>
      {recovery.unmatched.length > 0 && (
        <p>
          {t("unmatched", {
            agents: mcp.list(recovery.unmatched.map(mcp.agent)),
          })}
        </p>
      )}
      {elsewhere.length > 0 && (
        <>
          <p>{t("lost")}</p>
          <ul className="list-disc space-y-0.5 ps-5">
            {elsewhere.map((entry) => (
              <li key={entry.key} className="min-w-0">
                <LostKeyName entryKey={entry.key} />{" "}
                <span className="text-muted-foreground">
                  ({mcp.list(entry.agents.map(mcp.agent))})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function ParametersPart({
  dialogId,
  option,
  input,
}: {
  dialogId: number
  option: HarnessMcpPlanOption
  input: McpInstallInput
}) {
  const t = useTranslations("Harness.install.params")
  const recovered = option.parameters.some(
    (parameter) => parameter.current && !parameter.current.conflicting
  )
  if (option.parameters.length === 0) {
    return <RecoveryNotice option={option} />
  }
  const secretsGiven = option.parameters.some(
    (parameter) =>
      parameter.secret && (input.values[parameter.key] ?? "").trim() !== ""
  )
  const lostAt = (key: string) =>
    option.recovery?.lost.find((entry) => entry.key === key)?.agents ?? null
  return (
    <InstallPart
      title={t("title")}
      aside={recovered ? t("recoveredAside") : undefined}
    >
      <RecoveryNotice option={option} className="mb-3" />
      <div className="min-w-0 space-y-4">
        {option.parameters.map((parameter) => (
          <ParameterField
            key={parameter.key}
            dialogId={dialogId}
            parameter={parameter}
            value={input.values[parameter.key] ?? ""}
            undecided={isUndecided(parameter, input)}
            lost={lostAt(parameter.key)}
          />
        ))}
      </div>
      {secretsGiven && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-tone-warning">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span className="min-w-0">{t("secretsPlain")}</span>
        </p>
      )}
    </InstallPart>
  )
}

function KeyPart({
  plan,
  dialogId,
  input,
}: {
  plan: HarnessMcpPlan
  dialogId: number
  input: McpInstallInput
}) {
  const t = useTranslations("Harness.install.key")
  const tEditor = useTranslations("Harness.mcp.editor")
  const { slots } = useHarnessView()
  const id = `mcp-install-${dialogId}-key`
  const key = input.key.trim()
  const problem = keyProblemOf(plan, key)
  const fixed = plan.installed !== null
  return (
    <InstallPart title={t("title")}>
      <div className="min-w-0 space-y-1.5">
        {/* The part's title already names the field. */}
        <label htmlFor={id} className="sr-only">
          {t("label")}
        </label>
        <Input
          id={id}
          value={input.key}
          readOnly={fixed}
          aria-invalid={problem && problem !== "fixed" ? true : undefined}
          dir="ltr"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          maxLength={200}
          onChange={(event) =>
            updateInstallInput(slots, dialogId, (prev, current) =>
              setInstallKey(current, prev, event.target.value)
            )
          }
          className={cn(
            "font-mono text-[0.8125rem] max-md:h-10",
            fixed && "bg-muted/40"
          )}
        />
        {problem === "invalid" || problem === "reserved" ? (
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
        ) : null}
        {fixed ? (
          <p className="text-xs text-muted-foreground">{t("fixed")}</p>
        ) : (
          <>
            {key === plan.key.default && plan.key.default !== plan.key.name && (
              <p className="text-xs text-muted-foreground">
                {t.rich("renamed", {
                  name: plan.key.name,
                  key: plan.key.default,
                  code,
                })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {tEditor("keyRule")}
            </p>
          </>
        )}
      </div>
    </InstallPart>
  )
}

/** Where the server under the chosen name came from, for a row. */
function ownerOf(row: McpInstallTargetRow): string | null {
  return row.conflict?.owner ?? row.entry?.owner ?? null
}

function useTargetNote(
  plan: HarnessMcpPlan,
  input: McpInstallInput
): (row: McpInstallTargetRow) => { note: ReactNode; warn: boolean } {
  const t = useTranslations("Harness.install.targets")
  const key = input.key.trim()
  // Who the name is taken by: this item, another Harness item, or not
  // Harness at all — the same words for any name, typed or proposed.
  const by = (row: McpInstallTargetRow) => {
    const owner = ownerOf(row)
    return t(
      owner === "this_item"
        ? "owner.this_item"
        : owner === "other_item"
          ? "owner.other_item"
          : owner === "elsewhere"
            ? "owner.elsewhere"
            : "owner.unknown"
    )
  }
  return (row) => {
    const recorded = plan.installed?.agents.find(
      (agent) => agent.agent === row.id
    )
    const checked = row.agent !== null && input.agents.includes(row.agent)
    if (!checked) {
      if (recorded && recorded.revision > plan.item.revision) {
        return {
          note: t("newer", { version: recorded.version ?? "?" }),
          warn: false,
        }
      }
      // Not ticked, and holding the name already: worth knowing before
      // ticking it. A row says nothing where all is as expected.
      return {
        note: row.existing
          ? t.rich("holdsName", { key, owner: by(row), code: machine })
          : null,
        warn: false,
      }
    }
    if (!row.existing) return { note: null, warn: false }
    const replacing = row.agent !== null && input.replace.includes(row.agent)
    if (ownerOf(row) === "this_item") {
      // Replacing what this item put there is the update itself: worth a
      // word only where the user changed it since.
      if (replacing && row.conflict?.state !== "changed_locally") {
        return { note: null, warn: false }
      }
      return {
        note: replacing ? t("willUpdate") : t("ownNotTicked"),
        warn: true,
      }
    }
    return {
      note: t.rich(replacing ? "willReplace" : "hasOther", {
        key,
        owner: by(row),
        code: machine,
      }),
      warn: true,
    }
  }
}

function TargetsPart({
  plan,
  dialogId,
  input,
  mode,
}: {
  plan: HarnessMcpPlan
  dialogId: number
  input: McpInstallInput
  mode: McpInstallMode
}) {
  const t = useTranslations("Harness.install.targets")
  const { slots } = useHarnessView()
  const option = chosenOption(plan, input)
  const noteOf = useTargetNote(plan, input)
  const rows = targetRowsOf(plan, option, input.key.trim())
  const listRows: McpTargetRow[] = rows.map((row) => {
    const info = agentInfoOfPlan(row.info)
    const { note, warn } = noteOf(row)
    const block = row.block
    return {
      info,
      // A newer Codeg's agent cannot be named in a call; its row is
      // listed, greyed, under its own spelling.
      agent: (row.agent ?? row.id) as McpAppType,
      checked: row.agent !== null && input.agents.includes(row.agent),
      block:
        block === null
          ? null
          : block.kind === "transport"
            ? {
                kind: "transport",
                // A word this build does not know is shown as spelled.
                transport: block.transport as McpTransport,
              }
            : block.kind === "unknownAgent"
              ? { kind: "agent", block: { kind: "unknownAgent" } }
              : {
                  kind: "agent",
                  // The engine's own reason, where it gave one, is said in
                  // the MCP section's words for it.
                  block: {
                    kind: "file",
                    status: block.status,
                    reason: row.info.reason,
                  },
                },
      blockNote:
        block?.kind === "file" && !row.info.reason
          ? t(
              block.status === "unreadable"
                ? "unreadable"
                : block.status === "read_only"
                  ? "readOnly"
                  : "notWritten"
            )
          : undefined,
      note,
      warn,
      holds: row.existing,
    }
  })
  return (
    <div className="min-w-0 space-y-1.5">
      <McpTargetList
        rows={listRows}
        legend={t("title")}
        hint={t(mode === "install" ? "hint" : "hintInstalled")}
        onToggle={(agent, on) =>
          isMcpAppType(agent) &&
          updateInstallInput(slots, dialogId, (prev, current) =>
            toggleTarget(current, prev, agent, on)
          )
        }
      />
      {mode === "manage" && (
        <p className="text-xs text-muted-foreground">{t("manageNote")}</p>
      )}
    </div>
  )
}

function ReplacePart({
  plan,
  dialogId,
  input,
}: {
  plan: HarnessMcpPlan
  dialogId: number
  input: McpInstallInput
}) {
  const t = useTranslations("Harness.install.replace")
  const mcp = useMcpLabels()
  const { slots } = useHarnessView()
  const baseId = useId()
  const key = input.key.trim()
  const option = chosenOption(plan, input)
  const rows = targetRowsOf(plan, option, key).filter(
    (row) =>
      row.existing &&
      row.agent !== null &&
      row.block === null &&
      input.agents.includes(row.agent)
  )
  if (rows.length === 0) return null
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="pb-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("title")}
      </legend>
      <p className="text-xs">{t.rich("intro", { key, code: machine })}</p>
      <ul className="divide-y rounded-lg border">
        {rows.map((row) => {
          const agent = row.agent as McpAppType
          const id = `${baseId}-${agent}`
          const conflict = row.conflict
          // For the name the plan proposed, its account of the entry (what
          // it holds, whether it was changed here); for one the user typed,
          // who it is from.
          const from = conflict ?? row.entry
          const owner =
            from?.owner === "this_item"
              ? conflict?.state === "changed_locally"
                ? t("ownerThisChanged")
                : t("ownerThis")
              : from?.owner === "other_item"
                ? t.rich("ownerOther", {
                    ref: from.item_ref ?? from.item_id ?? "?",
                    code: machine,
                  })
                : from?.owner === "elsewhere"
                  ? t("ownerElsewhere")
                  : t("ownerUnknown")
          const lost =
            conflict?.owner === "this_item" &&
            conflict.state === "changed_locally"
          return (
            <li key={agent} className="min-w-0 space-y-2 px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-3">
                <Checkbox
                  id={id}
                  checked={input.replace.includes(agent)}
                  aria-describedby={`${id}-owner`}
                  onCheckedChange={(checked) =>
                    updateInstallInput(slots, dialogId, (prev) =>
                      toggleReplace(prev, agent, checked === true)
                    )
                  }
                  className="mt-0.5 max-md:size-5"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <label
                    htmlFor={id}
                    className="cursor-pointer text-sm font-medium"
                  >
                    {t("agent", { agent: mcp.agent(agent) })}
                  </label>
                  <span
                    id={`${id}-owner`}
                    className={cn(
                      "text-xs",
                      lost || from?.owner !== "this_item"
                        ? "text-tone-warning"
                        : "text-muted-foreground"
                    )}
                  >
                    {owner}
                    {conflict && !conflict.enabled && ` · ${t("off")}`}
                  </span>
                </div>
              </div>
              {conflict?.definition ? (
                <div className="ms-7 min-w-0 rounded-md bg-muted/40 px-2.5 py-2">
                  <p className="pb-1 text-2xs text-muted-foreground">
                    {t("overwrites")}
                  </p>
                  {/* What the entry holds was typed by someone at some
                      point; nothing says which of its values are secret,
                      so all of them are masked. */}
                  <McpDefinitionView
                    definition={conflict.definition}
                    maskAllValues
                  />
                </div>
              ) : conflict ? (
                <p className="ms-7 text-xs text-muted-foreground">
                  {t("undescribed")}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

function BlockerLine({
  blocker,
  keyName,
}: {
  blocker: McpInstallBlocker
  keyName: string
}) {
  const t = useTranslations("Harness.install.missing")
  const mcp = useMcpLabels()
  switch (blocker.kind) {
    case "parameter":
      return t.rich(
        blocker.problem === "required" ? "parameter" : "parameterInvalid",
        { name: blocker.parameter.name, code: machine }
      )
    case "replace":
      return t.rich("replace", {
        key: keyName,
        agents: mcp.list(blocker.agents.map(mcp.agent)),
        code: machine,
      })
    case "disagree":
      return t.rich("disagree", {
        name: blocker.parameter.name,
        code: machine,
      })
    case "key":
      return t(blocker.problem === "empty" ? "keyEmpty" : "key")
    case "item":
      return null
    default:
      return t(blocker.kind)
  }
}

/** What still has to be done before the button can install — said, rather
 *  than left to a greyed button. */
function MissingSummary({
  plan,
  input,
  dialog,
}: {
  plan: HarnessMcpPlan
  input: McpInstallInput
  dialog: McpInstallDialogState
}) {
  const t = useTranslations("Harness.install.missing")
  const blockers = installBlockersOf(plan, input, dialog.restate)
  if (blockers.length === 0) return null
  return (
    <div
      data-install-missing=""
      className="min-w-0 rounded-lg bg-muted/50 px-3 py-2 text-xs"
    >
      <p className="font-medium">{t("title")}</p>
      <ul className="mt-1 list-disc space-y-0.5 ps-5 text-muted-foreground">
        {blockers.map((blocker, index) => (
          <li key={index}>
            <BlockerLine blocker={blocker} keyName={input.key.trim()} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function InputBody({
  dialog,
  plan,
  input,
}: {
  dialog: McpInstallDialogState
  plan: HarnessMcpPlan
  input: McpInstallInput
}) {
  const t = useTranslations("Harness.install")
  const { slots } = useHarnessView()
  const parameterName = useParameterName(plan)
  const mode = installModeOf(plan)
  const option = chosenOption(plan, input)
  const yanked = needsYankedConfirm(plan, dialog.restate)
  return (
    <div className="min-w-0 space-y-5">
      <div className="min-w-0 space-y-2">
        <InstallItemLine
          itemRef={plan.item.ref || dialog.itemRef}
          version={plan.item.version}
          revision={plan.item.revision}
          publishedAt={plan.item.published_at}
          listed={plan.item_status === "listed"}
        />
        {mode === "update" && plan.installed && (
          <p className="text-xs">
            {t.rich("dialog.updateFromTo", {
              from: plan.installed.version ?? `#${plan.installed.revision}`,
              to: plan.item.version ?? `#${plan.item.revision}`,
              code,
            })}
          </p>
        )}
        {dialog.purpose === "update" && mode === "manage" && (
          <p className="text-xs text-muted-foreground">
            {t("dialog.alreadyNewest")}
          </p>
        )}
      </div>
      {dialog.notice === "changedElsewhere" && (
        <Headline tone="neutral">{t("notices.changedElsewhere")}</Headline>
      )}
      {dialog.issues.length > 0 && (
        <div role="alert" className="min-w-0 space-y-1.5">
          <Headline tone="warning">{t("notices.refused")}</Headline>
          <InstallReasonList
            reasons={dialog.issues}
            tone="blocking"
            parameterName={parameterName}
            className="ps-1"
          />
        </div>
      )}
      {dialog.failure && <InstallFailureNotice failure={dialog.failure} />}
      {plan.blocking.length > 0 ? (
        <>
          <InstallBlocked reasons={plan.blocking} />
          <InstallSnapshot snapshot={shownSnapshot(plan, dialog.restate)} />
        </>
      ) : (
        <>
          {yanked && (
            <YankedConfirm
              id={`mcp-install-${dialog.id}-yanked`}
              checked={input.acceptYanked}
              onChange={(accept) =>
                updateInstallInput(slots, dialog.id, (prev) => ({
                  ...prev,
                  acceptYanked: accept,
                }))
              }
            />
          )}
          <InstallSnapshot snapshot={shownSnapshot(plan, dialog.restate)} />
          <OptionsPart plan={plan} dialog={dialog} input={input} />
          {option && (
            <ParametersPart
              dialogId={dialog.id}
              option={option}
              input={input}
            />
          )}
          <KeyPart plan={plan} dialogId={dialog.id} input={input} />
          <TargetsPart
            plan={plan}
            dialogId={dialog.id}
            input={input}
            mode={mode}
          />
          <ReplacePart plan={plan} dialogId={dialog.id} input={input} />
          <MissingSummary plan={plan} input={input} dialog={dialog} />
        </>
      )}
    </div>
  )
}

// ─── The other steps ──────────────────────────────────────────────────

function StateChangedBody({
  dialog,
  plan,
  input,
}: {
  dialog: McpInstallDialogState
  plan: HarnessMcpPlan
  input: McpInstallInput
}) {
  const t = useTranslations("Harness.install.changes")
  const { slots } = useHarnessView()
  const restate = dialog.restate
  if (!restate) return null
  return (
    <div className="min-w-0 space-y-4">
      <div role="alert" className="min-w-0 space-y-2">
        <Headline tone="warning">{t("title")}</Headline>
        <p className="text-xs text-muted-foreground">{t("body")}</p>
      </div>
      {dialog.failure && <InstallFailureNotice failure={dialog.failure} />}
      <InstallChangeList changes={restate.changes} />
      {needsYankedConfirm(plan, restate) && (
        <YankedConfirm
          id={`mcp-install-${dialog.id}-yanked-again`}
          checked={input.acceptYanked}
          onChange={(accept) =>
            updateHarnessDialog(slots, dialog.id, "install", (prev) =>
              prev.input && prev.step === "stateChanged"
                ? { ...prev, input: { ...prev.input, acceptYanked: accept } }
                : prev
            )
          }
        />
      )}
      <InstallSnapshot snapshot={restate.snapshot} />
    </div>
  )
}

function ResultBody({
  dialog,
  mode,
}: {
  dialog: McpInstallDialogState
  mode: McpInstallMode
}) {
  const t = useTranslations("Harness.install")
  const labels = useInstallLabels()
  const result = dialog.result
  if (!result) return null
  const record = result.record
  switch (result.outcome) {
    case "installed":
      return (
        <div role="status" className="min-w-0 space-y-3">
          <Headline tone="fine">{t(`outcome.done.${mode}`)}</Headline>
          {result.apply && (
            <AgentResults result={result.apply} phase="result" />
          )}
          {record?.status === "failed" && (
            <Headline tone="warning">
              {t("record.failed")} {labels.record(record.code)}
              <Technical detail={record.detail} />
            </Headline>
          )}
        </div>
      )
    case "aborted":
      return (
        <div role="alert" className="min-w-0 space-y-3">
          <Headline tone="warning">{t("outcome.aborted")}</Headline>
          <InstallReasonList reasons={result.issues} tone="blocking" />
          {result.snapshot && <InstallSnapshot snapshot={result.snapshot} />}
        </div>
      )
    case "busy":
      return (
        <div role="alert" className="min-w-0 space-y-3">
          <Headline tone="warning">{t("outcome.busy")}</Headline>
          {result.apply && (
            <AgentResults result={result.apply} phase="result" />
          )}
        </div>
      )
    case "invalid":
      return (
        <div role="alert" className="min-w-0 space-y-3">
          <Headline tone="warning">{t("outcome.invalid")}</Headline>
          {result.apply && (
            <AgentResults result={result.apply} phase="review" />
          )}
        </div>
      )
    case "write_failed":
      return (
        <div role="alert" className="min-w-0 space-y-3">
          <Headline tone="warning">{t("outcome.writeFailed")}</Headline>
          {result.apply && (
            <AgentResults result={result.apply} phase="result" />
          )}
        </div>
      )
    default:
      return (
        <div role="alert" className="min-w-0 space-y-3">
          <Headline tone="warning">{t("outcome.unknown")}</Headline>
          {result.apply && (
            <AgentResults result={result.apply} phase="result" />
          )}
        </div>
      )
  }
}

function Progress({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      {children}
    </p>
  )
}

// ─── The dialog ───────────────────────────────────────────────────────

/**
 * Install an MCP server from Harness — or update one, or add it to more
 * agents: one dialog, made of what the plan says.
 *
 * It shows who the item is, what the catalog says of the version right now
 * (never what the page it was opened from said), the ways to run it and why
 * some cannot be chosen, what has to be filled in, the name and who already
 * uses it, and the agents — and installs only when its own button is
 * pressed, with exactly what it showed. Each way an install can come back
 * without writing is told for what it is: a file changed under it (planned
 * again, keeping what was typed), the catalog's account changed (the changes,
 * to confirm again), or the version can no longer be installed.
 */
export function McpInstallDialog({
  dialog,
}: {
  dialog: McpInstallDialogState
}) {
  const t = useTranslations("Harness.install")
  const discover = useDiscoverLabels()
  const { slots } = useHarnessView()
  const { openHarness } = useOpenHarness()
  const plan = dialog.plan
  const input = dialog.input
  const mode: McpInstallMode = plan
    ? installModeOf(plan)
    : dialog.purpose === "update"
      ? "update"
      : dialog.purpose === "manage"
        ? "manage"
        : "install"
  // The catalog's title, as text: the plan's, or before the plan is in, the
  // one the page that opened the dialog had; else the address.
  const title =
    pickLocalized(plan?.item.title, discover.lang) ??
    pickLocalized(dialog.knownTitle, discover.lang) ??
    (plan?.item.ref || dialog.itemRef)
  const close = () => closeHarnessDialog(slots, dialog.id)
  const confirm = () => void confirmMcpInstall(slots, dialog.id)
  const confirmable = canConfirmInstall(dialog)
  const installing = dialog.step === "installing"

  let body: ReactNode
  let footer: ReactNode
  if (dialog.planPhase === "loading" || !plan || !input) {
    if (dialog.planPhase === "error" && dialog.planFailure) {
      body = <InstallFailureNotice failure={dialog.planFailure} />
      footer = (
        <>
          <Button type="button" variant="outline" onClick={close}>
            {t("dialog.close")}
          </Button>
          {isRetryableFailure(dialog.planFailure) && (
            <Button
              type="button"
              onClick={() => void planMcpInstall(slots, dialog.id)}
            >
              <RefreshCw aria-hidden="true" />
              {t("dialog.retry")}
            </Button>
          )}
        </>
      )
    } else {
      body = <Progress>{t("dialog.loading")}</Progress>
      footer = (
        <Button type="button" variant="outline" onClick={close}>
          {t("dialog.cancel")}
        </Button>
      )
    }
  } else if (dialog.planPhase === "error" && dialog.planFailure) {
    // A new plan could not be had; the old one is not what would be
    // confirmed any more.
    body = <InstallFailureNotice failure={dialog.planFailure} />
    footer = (
      <>
        <Button type="button" variant="outline" onClick={close}>
          {t("dialog.close")}
        </Button>
        {isRetryableFailure(dialog.planFailure) && (
          <Button
            type="button"
            onClick={() =>
              void planMcpInstall(slots, dialog.id, { notice: dialog.notice })
            }
          >
            <RefreshCw aria-hidden="true" />
            {t("dialog.retry")}
          </Button>
        )}
      </>
    )
  } else if (dialog.step === "installing") {
    body = <Progress>{t(`dialog.working.${mode}`)}</Progress>
    footer = (
      <Button type="button" disabled>
        {t(`dialog.working.${mode}`)}
      </Button>
    )
  } else if (dialog.step === "stateChanged") {
    body = <StateChangedBody dialog={dialog} plan={plan} input={input} />
    footer = (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={() => backToInstallInput(slots, dialog.id)}
        >
          {t("dialog.back")}
        </Button>
        <Button type="button" disabled={!confirmable} onClick={confirm}>
          {t(`dialog.confirmAgain.${mode}`)}
        </Button>
      </>
    )
  } else if (dialog.step === "result" && dialog.result) {
    body = <ResultBody dialog={dialog} mode={mode} />
    const outcome = dialog.result.outcome
    footer =
      outcome === "installed" ? (
        <>
          {dialog.from === "discover" && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const serverKey = input.key.trim()
                close()
                openHarness({ section: "mcp", serverKey })
              }}
            >
              {t("dialog.showInMcp")}
            </Button>
          )}
          <Button type="button" onClick={close}>
            {t("dialog.done")}
          </Button>
        </>
      ) : outcome === "busy" ? (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => backToInstallInput(slots, dialog.id)}
          >
            {t("dialog.back")}
          </Button>
          <Button type="button" disabled={!confirmable} onClick={confirm}>
            <RefreshCw aria-hidden="true" />
            {t("dialog.retry")}
          </Button>
        </>
      ) : outcome === "invalid" ? (
        <>
          <Button type="button" variant="outline" onClick={close}>
            {t("dialog.close")}
          </Button>
          <Button
            type="button"
            onClick={() => backToInstallInput(slots, dialog.id)}
          >
            {t("dialog.back")}
          </Button>
        </>
      ) : (
        <Button type="button" onClick={close}>
          {t("dialog.close")}
        </Button>
      )
  } else {
    body = <InputBody dialog={dialog} plan={plan} input={input} />
    footer =
      plan.blocking.length > 0 ? (
        <Button type="button" onClick={close}>
          {t("dialog.close")}
        </Button>
      ) : (
        <>
          <Button type="button" variant="outline" onClick={close}>
            {t("dialog.cancel")}
          </Button>
          <Button type="button" disabled={!confirmable} onClick={confirm}>
            {t(`dialog.confirm.${mode}`)}
          </Button>
        </>
      )
  }

  return (
    <McpDialogFrame
      size="wide"
      title={t.rich(`dialog.title.${mode}`, {
        title,
        name: (chunks) => <bdi>{chunks}</bdi>,
      })}
      onRequestClose={() => !installing && close()}
      footer={footer}
      step={`${dialog.step}:${dialog.planPhase}:${dialog.request}`}
    >
      {body}
    </McpDialogFrame>
  )
}
