"use client"

import { useId, type ReactNode } from "react"
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useHarnessView } from "@/contexts/harness-view-context"
import { pickLocalized } from "@/lib/harness/display"
import { isRetryableFailure } from "@/lib/harness/errors"
import { closeHarnessDialog } from "@/lib/harness/mcp-install-state"
import {
  isModeOffered,
  needsPluginYankedConfirm,
  plannedModeOf,
  pluginAutorunOf,
  pluginConsentGiven,
  pluginConsentNeeded,
  pluginInstallBlockersOf,
  pluginPreviewIsStale,
  pluginRowsToSetAll,
  pluginTargetOf,
  pluginTargetSnapshot,
  PLUGIN_MODES,
  setPluginAcceptYanked,
  setPluginConsent,
  setPluginHostMode,
  setPluginModeForAll,
  type PluginInstallBlocker,
  type PluginInstallInput,
} from "@/lib/harness/plugin-install"
import {
  backToPluginInput,
  canConfirmPluginInstall,
  confirmPluginInstall,
  planPluginInstall,
  updatePluginInput,
  type PluginInstallDialog as PluginInstallDialogState,
} from "@/lib/harness/plugin-install-state"
import type {
  HarnessPluginHostOutcome,
  HarnessPluginInstallResult,
  HarnessPluginPlan,
  HarnessPluginPlanHost,
  PluginMode,
} from "@/lib/harness/plugin-install-types"
import { notableOps, reachesOthers } from "@/lib/skills/ops"
import { cn } from "@/lib/utils"
import { useDiscoverLabels } from "../discover/use-discover-labels"
import { MachineText } from "../machine-text"
import { AgentGlyph } from "../mcp/mcp-bits"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { Headline, Technical } from "../mcp/mcp-plan"
import { OpList } from "../skills/effects-dialog"
import { SkillPath } from "../skills/skill-bits"
import {
  InstallBlocked,
  InstallChangeList,
  InstallFailureNotice,
  InstallItemLine,
  InstallPackagePart,
  InstallPart,
  InstallReasonList,
  InstallSnapshot,
  YankedConfirm,
} from "./install-parts"
import {
  AutorunList,
  PluginMemberList,
  PluginVersionsLine,
} from "./plugin-parts"
import { usePluginInstallLabels } from "./use-plugin-install-labels"

/** A short line under a row: an error, or a word on what it reaches. */
export function RowNote({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning"
  children: ReactNode
}) {
  return (
    <p
      className={cn(
        "flex min-w-0 items-start gap-1 text-xs leading-snug",
        tone === "warning" ? "text-tone-warning" : "text-muted-foreground"
      )}
    >
      {tone === "warning" && (
        <TriangleAlert aria-hidden="true" className="mt-px size-3 shrink-0" />
      )}
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** Names a row's plan lists — the Experts skills it takes over or gives
 *  back, the names held: a label with their count, the names themselves on
 *  request. */
export function NamesNote({
  label,
  names: given,
  tone = "muted",
  suffix,
}: {
  /** The label, by how many names there are (each counted once). */
  label: (count: number) => string
  names: readonly string[]
  tone?: "muted" | "warning"
  /** Said after the label, on the same line. */
  suffix?: string
}) {
  const names = [...new Set(given)]
  if (names.length === 0) return null
  return (
    <details className="min-w-0 text-xs leading-snug">
      <summary
        className={cn(
          "cursor-pointer select-none",
          tone === "warning"
            ? "text-tone-warning"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        {tone === "warning" && (
          <TriangleAlert
            aria-hidden="true"
            className="me-1 inline-block size-3 align-[-0.125em]"
          />
        )}
        {label(names.length)}
        {suffix && ` · ${suffix}`}
      </summary>
      <p className="mt-1 min-w-0 text-muted-foreground">
        <bdi dir="ltr" className="font-mono">
          <MachineText>{names.join(", ")}</MachineText>
        </bdi>
      </p>
    </details>
  )
}

// ─── The input's parts ────────────────────────────────────────────────

/** What a row's plan says of the mode chosen: the Experts pack's skills it
 *  takes over (and who else stops seeing them), Codex's trust of the hooks,
 *  and — its skills only — what holds a name, what goes to the backups and
 *  links that reach other agents. Only for the mode the plan was made for. */
function RowEffects({
  row,
  mode,
  stale,
}: {
  row: HarnessPluginPlanHost
  mode: PluginMode
  /** A new plan is on its way: what this one says stays on show, dimmed,
   *  so the rows keep their height until the answer replaces it. */
  stale: boolean
}) {
  const t = useTranslations("Harness.pluginInstall.hosts")
  const tAgents = useTranslations("Harness.skillInstall.agents")
  const labels = usePluginInstallLabels()
  if (mode === "none" || plannedModeOf(row) !== mode) return null
  const experts = row.experts_to_take_over
  const others = [...new Set(experts.flatMap((link) => link.agents))].filter(
    (agent) => agent !== row.agent
  )
  const skills = mode === "skills" ? row.skills : null
  const ops = skills?.links ? notableOps(skills.links) : []
  const showOps = ops.some((op) => op.status === "blocked" || reachesOthers(op))
  return (
    <div
      aria-busy={stale || undefined}
      className={cn(
        "min-w-0 space-y-1 transition-opacity empty:hidden",
        stale && "opacity-50"
      )}
    >
      {mode === "native" && row.codex_hooks_need_trust && (
        <RowNote tone="warning">{t("codexTrust")}</RowNote>
      )}
      <NamesNote
        label={(count) => t("experts", { count })}
        names={experts.map((link) => link.name)}
        tone={others.length > 0 ? "warning" : "muted"}
        suffix={
          others.length > 0
            ? tAgents("needsAck", { agents: labels.agents(others) })
            : undefined
        }
      />
      {skills && (
        <NamesNote
          label={(count) => t("held", { count })}
          names={skills.held.map((held) => held.name)}
          tone="warning"
        />
      )}
      {skills && skills.issues.length > 0 && (
        <InstallReasonList
          reasons={skills.issues}
          tone="blocking"
          wording={labels.reason}
        />
      )}
      {skills && skills.copies_to_take.length > 0 && (
        <div className="min-w-0 space-y-0.5 text-xs">
          <p className="text-tone-warning">{t("copiesToTake")}</p>
          <ul className="min-w-0 space-y-0.5">
            {skills.copies_to_take.map((path) => (
              <li key={path} className="min-w-0">
                <SkillPath path={path} className="text-foreground" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {skills && !skills.links && (
        <RowNote tone="warning">{t("noPreview")}</RowNote>
      )}
      {skills?.links && showOps && (
        <OpList result={skills.links} phase="review" named />
      )}
    </div>
  )
}

/** One agent: how it is to have the plugin — as a plugin, its skills only,
 *  or not at all — with why "as a plugin" is not offered. */
function HostRow({
  dialog,
  input,
  row,
}: {
  dialog: PluginInstallDialogState
  input: PluginInstallInput
  row: HarnessPluginPlanHost
}) {
  const tAgents = useTranslations("Harness.skillInstall.agents")
  const tReasons = useTranslations("Harness.pluginInstall.reasons")
  const labels = usePluginInstallLabels()
  const { slots } = useHarnessView()
  const baseId = useId()
  const mode = input.modes[row.agent] ?? "none"
  const detect = row.detect
  // "This agent cannot have plugins at all" says nothing the disabled option
  // does not: it goes on that option, not under the row — so rows whose
  // only news is that stay one line, like the rest. A reason that is news
  // (a version too old, the plugin not listing it) stays under the row.
  const noAdapter = row.why_not?.code === "plugin_no_adapter"
  const nativeOff =
    !isModeOffered(row, "native") && row.why_not ? row.why_not : null
  return (
    <li className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-h-5 min-w-0 items-center gap-2 text-sm">
          <AgentGlyph agent={row.agent} />
          <span className="font-medium whitespace-nowrap">
            {labels.agent(row.agent)}
          </span>
          {row.installed === false && (
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {tAgents("notInstalled")}
            </span>
          )}
          {detect?.version && (
            <bdi
              dir="ltr"
              className="font-mono text-2xs whitespace-nowrap text-muted-foreground"
            >
              {detect.version}
            </bdi>
          )}
        </span>
        <RadioGroup
          value={mode}
          aria-label={labels.agent(row.agent)}
          onValueChange={(next) =>
            updatePluginInput(slots, dialog.id, (prev, current) =>
              setPluginHostMode(current, prev, row.agent, next as PluginMode)
            )
          }
          className="ms-auto flex w-auto flex-wrap gap-x-4 gap-y-1.5"
        >
          {PLUGIN_MODES.map((option) => {
            const id = `${baseId}-${option}`
            const offered = isModeOffered(row, option)
            return (
              <div key={option} className="flex items-center gap-1.5">
                <RadioGroupItem id={id} value={option} disabled={!offered} />
                <label
                  htmlFor={id}
                  title={
                    option === "native" && !offered && noAdapter
                      ? tReasons("plugin_no_adapter", {
                          agent: labels.agent(row.agent),
                        })
                      : undefined
                  }
                  className={cn(
                    "text-xs whitespace-nowrap",
                    offered
                      ? "cursor-pointer"
                      : "cursor-default text-muted-foreground"
                  )}
                >
                  {labels.mode(option)}
                </label>
              </div>
            )
          })}
        </RadioGroup>
      </div>
      {nativeOff && !noAdapter && <RowNote>{labels.reason(nativeOff)}</RowNote>}
      <RowEffects row={row} mode={mode} stale={dialog.replanning} />
    </li>
  )
}

function HostsPart({
  dialog,
  plan,
  input,
}: {
  dialog: PluginInstallDialogState
  plan: HarnessPluginPlan
  input: PluginInstallInput
}) {
  const t = useTranslations("Harness.pluginInstall.hosts")
  const tAgents = useTranslations("Harness.skillInstall.agents")
  const tInstall = useTranslations("Harness.install")
  const labels = usePluginInstallLabels()
  const { slots } = useHarnessView()
  const stale = pluginPreviewIsStale(plan, input)
  const setAll =
    plan.hosts.length > 1 ? (
      <span
        role="group"
        aria-label={t("setAll")}
        className="inline-flex items-center gap-1.5"
      >
        <span aria-hidden="true">{t("setAll")}</span>
        <span className="inline-flex items-center rounded-md bg-muted/60 p-0.5">
          {PLUGIN_MODES.map((mode) => {
            // Every agent has it already: shown as the state it is in.
            const every = plan.hosts.every(
              (row) => (input.modes[row.agent] ?? "none") === mode
            )
            const changes = pluginRowsToSetAll(plan, input, mode).length > 0
            return (
              <Button
                key={mode}
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={every}
                disabled={!changes}
                onClick={() =>
                  updatePluginInput(slots, dialog.id, (prev, current) =>
                    setPluginModeForAll(current, prev, mode)
                  )
                }
                className={cn(
                  "h-6 rounded-sm px-2 text-2xs font-normal text-foreground max-md:h-9",
                  every
                    ? "bg-background font-medium shadow-xs disabled:opacity-100"
                    : "disabled:text-muted-foreground"
                )}
              >
                {labels.mode(mode)}
              </Button>
            )
          })}
        </span>
      </span>
    ) : undefined
  return (
    <InstallPart title={t("title")} aside={setAll}>
      <div className="min-w-0 space-y-2">
        {plan.hosts.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("none")}</p>
        ) : (
          <ul className="min-w-0 divide-y rounded-lg border">
            {plan.hosts.map((row) => (
              <HostRow
                key={row.agent}
                dialog={dialog}
                input={input}
                row={row}
              />
            ))}
          </ul>
        )}
        <div aria-live="polite" className="min-w-0 empty:hidden">
          {dialog.replanning ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {tAgents("checking")}
            </p>
          ) : stale ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void planPluginInstall(slots, dialog.id, {
                  modes: input.modes,
                })
              }
              className="max-md:h-10"
            >
              <RefreshCw aria-hidden="true" />
              {tInstall("dialog.checkAgain")}
            </Button>
          ) : null}
        </div>
      </div>
    </InstallPart>
  )
}

/** What runs on its own once installed whole, and the user's own agreement
 *  to it — needed for any agent to have the plugin as a plugin. */
function AutorunPart({
  dialog,
  plan,
  input,
}: {
  dialog: PluginInstallDialogState
  plan: HarnessPluginPlan
  input: PluginInstallInput
}) {
  const t = useTranslations("Harness.pluginInstall.autorun")
  const { slots } = useHarnessView()
  const id = useId()
  const parts = pluginAutorunOf(plan)
  if (parts.length === 0) return null
  const needed = pluginConsentNeeded(plan, input)
  return (
    <InstallPart title={t("title")} aside={parts.length}>
      <AutorunList
        parts={parts}
        pkg={plan.full}
        consent={
          needed
            ? {
                id,
                checked: pluginConsentGiven(plan, input),
                disabled: plan.consent_exec === null || dialog.replanning,
                onChange: (agree) =>
                  updatePluginInput(slots, dialog.id, (prev, current) =>
                    setPluginConsent(current, prev, agree)
                  ),
              }
            : undefined
        }
      />
    </InstallPart>
  )
}

function BlockerLine({ blocker }: { blocker: PluginInstallBlocker }) {
  const t = useTranslations("Harness.pluginInstall.missing")
  const tSkill = useTranslations("Harness.skillInstall.missing")
  const labels = usePluginInstallLabels()
  switch (blocker.kind) {
    case "item":
      return null
    case "state":
    case "yanked":
      return tSkill(blocker.kind)
    case "planning":
      return tSkill("links")
    case "agent":
      return t(
        blocker.problem === "blocked" ? "agentBlocked" : "agentNoPreview",
        {
          agent: labels.agent(blocker.agent),
        }
      )
    default:
      return t(blocker.kind)
  }
}

function MissingSummary({
  dialog,
  plan,
  input,
}: {
  dialog: PluginInstallDialogState
  plan: HarnessPluginPlan
  input: PluginInstallInput
}) {
  const t = useTranslations("Harness.skillInstall.missing")
  const blockers = pluginInstallBlockersOf(plan, input).filter(
    (blocker) =>
      blocker.kind !== "item" &&
      (blocker.kind !== "planning" || !dialog.replanning)
  )
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
            <BlockerLine blocker={blocker} />
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
  dialog: PluginInstallDialogState
  plan: HarnessPluginPlan
  input: PluginInstallInput
}) {
  const t = useTranslations("Harness.pluginInstall")
  const tSkill = useTranslations("Harness.skillInstall")
  const labels = usePluginInstallLabels()
  const { slots } = useHarnessView()
  const target = pluginTargetOf(plan, input.modes)
  const snapshot = pluginTargetSnapshot(plan, input.modes)
  const yanked = needsPluginYankedConfirm(plan, input)
  const warnings = [...plan.warnings, ...target.warnings].filter(
    (warning, index, all) =>
      warning.code !== "plugin_no_hosts" &&
      all.findIndex((other) => other.code === warning.code) === index
  )
  return (
    <div className="min-w-0 space-y-5">
      <div className="min-w-0 space-y-2">
        <InstallItemLine
          itemRef={plan.item.ref || dialog.itemRef}
          version={target.version}
          revision={target.revision}
          publishedAt={target.published_at}
          listed={plan.item_status === "listed"}
        />
        <PluginVersionsLine
          full={plan.full}
          latest={plan.latest}
          notFull={plan.not_full}
        />
      </div>
      {dialog.notice && (
        <Headline tone="neutral">{t(`notices.${dialog.notice}`)}</Headline>
      )}
      {dialog.changes.length > 0 && (
        <InstallChangeList changes={dialog.changes} />
      )}
      {dialog.issues.length > 0 && (
        <div role="alert" className="min-w-0 space-y-1.5">
          <Headline tone="warning">{tSkill("notices.refused")}</Headline>
          <InstallReasonList
            reasons={dialog.issues}
            tone="blocking"
            wording={labels.reason}
            className="ps-1"
          />
        </div>
      )}
      {dialog.failure && <InstallFailureNotice failure={dialog.failure} />}
      {plan.blocking.length > 0 && (
        <InstallBlocked reasons={plan.blocking} wording={labels.reason} />
      )}
      {yanked && plan.blocking.length === 0 && (
        <YankedConfirm
          id={`plugin-install-${dialog.id}-yanked`}
          checked={input.acceptYanked}
          onChange={(accept) =>
            updatePluginInput(slots, dialog.id, (prev) =>
              setPluginAcceptYanked(prev, accept)
            )
          }
        />
      )}
      <InstallSnapshot snapshot={snapshot} />
      {warnings.length > 0 && (
        <InstallPart title={tSkill("warnings.title")}>
          <InstallReasonList
            reasons={warnings}
            tone="warning"
            wording={labels.reason}
          />
        </InstallPart>
      )}
      {!plan.installed && (
        <>
          <InstallPart title={t("members.title")} aside={plan.members.length}>
            <PluginMemberList members={plan.members} />
          </InstallPart>
          <HostsPart dialog={dialog} plan={plan} input={input} />
          <AutorunPart dialog={dialog} plan={plan} input={input} />
          <InstallPackagePart pkg={target} />
          <MissingSummary dialog={dialog} plan={plan} input={input} />
        </>
      )}
    </div>
  )
}

// ─── The result ───────────────────────────────────────────────────────

/** What each agent's step of a plugin operation did. */
export function HostOutcomes({
  hosts,
}: {
  hosts: readonly HarnessPluginHostOutcome[]
}) {
  const labels = usePluginInstallLabels()
  if (hosts.length === 0) return null
  return (
    <ul className="min-w-0 divide-y rounded-lg border text-xs">
      {hosts.map((host) => (
        <li key={host.agent} className="min-w-0 space-y-1 px-3 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <AgentGlyph agent={host.agent} />
            <span className="font-medium">{labels.agent(host.agent)}</span>
            <span className="text-muted-foreground">
              {labels.mode(host.mode)}
            </span>
            <span
              className={cn(
                "ms-auto",
                host.status === "done"
                  ? "text-muted-foreground"
                  : "text-tone-warning"
              )}
            >
              {labels.stepStatus(host.status)}
            </span>
          </div>
          {host.issues.length > 0 && (
            <InstallReasonList
              reasons={host.issues}
              tone="blocking"
              wording={labels.reason}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

function ResultBody({ result }: { result: HarnessPluginInstallResult }) {
  const t = useTranslations("Harness.pluginInstall.outcome")
  const tSkill = useTranslations("Harness.skillInstall.outcome")
  const labels = usePluginInstallLabels()
  const installed = result.outcome === "installed"
  const headline = installed
    ? t("installed")
    : result.outcome === "aborted"
      ? tSkill("aborted")
      : result.outcome === "invalid_package"
        ? tSkill("invalidPackage")
        : result.outcome === "busy"
          ? t("busy")
          : result.outcome === "failed"
            ? t("failed")
            : t("unknown")
  return (
    <div role={installed ? "status" : "alert"} className="min-w-0 space-y-3">
      <Headline tone={installed ? "fine" : "warning"}>{headline}</Headline>
      {result.issues.length > 0 && (
        <InstallReasonList
          reasons={result.issues}
          tone={result.outcome === "busy" ? "warning" : "blocking"}
          wording={labels.reason}
        />
      )}
      {result.outcome === "aborted" && result.snapshot && (
        <InstallSnapshot snapshot={result.snapshot} />
      )}
      <HostOutcomes hosts={result.hosts} />
      {result.needs_repair.length > 0 && (
        <p className="text-xs text-tone-warning">
          {t("needsRepair", { agents: labels.agents(result.needs_repair) })}
        </p>
      )}
      {result.problems.length > 0 && (
        <div className="min-w-0 space-y-0.5 text-xs">
          <p className="text-tone-warning">{t("problems")}</p>
          {result.problems.map((problem, index) => (
            <Technical key={index} detail={problem} />
          ))}
        </div>
      )}
    </div>
  )
}

export function Progress({ children }: { children: ReactNode }) {
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
 * Install a plugin from Harness: one revision for every agent, each agent
 * as a plugin, its skills only, or not at all. It shows what the catalog
 * says of the revision those modes install right now, the members, each
 * agent's row, what runs on its own with its own agreement, and the package
 * — and installs only when its own button is pressed, with exactly what it
 * showed.
 */
export function PluginInstallDialog({
  dialog,
}: {
  dialog: PluginInstallDialogState
}) {
  const t = useTranslations("Harness.install")
  const tSkill = useTranslations("Harness.skillInstall.dialog")
  const discover = useDiscoverLabels()
  const { slots } = useHarnessView()
  const plan = dialog.plan
  const input = dialog.input
  const title =
    pickLocalized(plan?.item.title, discover.lang) ??
    pickLocalized(dialog.knownTitle, discover.lang) ??
    (plan?.item.ref || dialog.itemRef)
  const close = () => closeHarnessDialog(slots, dialog.id)
  const confirm = () => void confirmPluginInstall(slots, dialog.id)
  const confirmable = canConfirmPluginInstall(dialog)
  const installing = dialog.step === "installing"

  let body: ReactNode
  let footer: ReactNode
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
            onClick={() =>
              void planPluginInstall(slots, dialog.id, {
                modes: dialog.input?.modes,
              })
            }
          >
            <RefreshCw aria-hidden="true" />
            {t("dialog.retry")}
          </Button>
        )}
      </>
    )
  } else if (dialog.planPhase === "loading" || !plan || !input) {
    body = <Progress>{tSkill("loading")}</Progress>
    footer = (
      <Button type="button" variant="outline" onClick={close}>
        {t("dialog.cancel")}
      </Button>
    )
  } else if (installing) {
    body = <Progress>{t("dialog.working.install")}</Progress>
    footer = (
      <Button type="button" disabled>
        {t("dialog.working.install")}
      </Button>
    )
  } else if (dialog.step === "result" && dialog.result) {
    body = <ResultBody result={dialog.result} />
    footer =
      dialog.result.outcome === "busy" ? (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => backToPluginInput(slots, dialog.id)}
          >
            {t("dialog.back")}
          </Button>
          <Button type="button" disabled={!confirmable} onClick={confirm}>
            <RefreshCw aria-hidden="true" />
            {t("dialog.retry")}
          </Button>
        </>
      ) : (
        <Button type="button" onClick={close}>
          {dialog.result.outcome === "installed"
            ? t("dialog.done")
            : t("dialog.close")}
        </Button>
      )
  } else {
    body = <InputBody dialog={dialog} plan={plan} input={input} />
    footer = plan.installed ? (
      <Button type="button" onClick={close}>
        {t("dialog.close")}
      </Button>
    ) : (
      <>
        <Button type="button" variant="outline" onClick={close}>
          {t("dialog.cancel")}
        </Button>
        <Button type="button" disabled={!confirmable} onClick={confirm}>
          {t("dialog.confirm.install")}
        </Button>
      </>
    )
  }

  return (
    <McpDialogFrame
      size="wide"
      title={tSkill.rich("title.install", {
        title,
        name: (chunks) => <bdi>{chunks}</bdi>,
      })}
      onRequestClose={() => !installing && close()}
      footer={footer}
      step={`${dialog.step}:${dialog.planPhase}:${dialog.notice ?? ""}`}
    >
      {body}
    </McpDialogFrame>
  )
}
