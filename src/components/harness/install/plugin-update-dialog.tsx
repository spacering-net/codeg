"use client"

import { useId, type ReactNode } from "react"
import { RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessView } from "@/contexts/harness-view-context"
import { isRetryableFailure } from "@/lib/harness/errors"
import { oneOf, pickLocalized } from "@/lib/harness/display"
import { closeHarnessDialog } from "@/lib/harness/mcp-install-state"
import {
  needsUpdateYankedConfirm,
  pluginUpdateBlockersOf,
  updateConsentGiven,
  updateTargetOf,
  type PluginUpdateBlocker,
} from "@/lib/harness/plugin-manage"
import {
  backToPluginUpdateInput,
  canConfirmPluginUpdate,
  confirmPluginUpdate,
  planPluginUpdate,
  updatePluginUpdateInput,
  type PluginUpdateDialog as PluginUpdateDialogState,
} from "@/lib/harness/plugin-manage-state"
import type {
  HarnessPluginUpdateHost,
  HarnessPluginUpdatePlan,
} from "@/lib/harness/plugin-install-types"
import { versionLabel } from "@/lib/harness/plugin-install"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { DiscoverMark } from "../discover/discover-card"
import { useDiscoverLabels } from "../discover/use-discover-labels"
import { MachineText } from "../machine-text"
import { AgentGlyph } from "../mcp/mcp-bits"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { Headline } from "../mcp/mcp-plan"
import {
  InstallBlocked,
  InstallChangeList,
  InstallFailureNotice,
  InstallPart,
  InstallReasonList,
  InstallSnapshot,
  YankedConfirm,
} from "./install-parts"
import { Progress, RowNote } from "./plugin-install-dialog"
import {
  ExpertsNote,
  PluginOperationResult,
  SkillsPlanEffects,
} from "./plugin-manage-parts"
import { AutorunList, PluginVersionsLine } from "./plugin-parts"
import { usePluginInstallLabels } from "./use-plugin-install-labels"

const UPDATE_ACTIONS = [
  "update",
  "resume",
  "to_skills",
  "record_only",
  "none",
  "needs_repair",
] as const

const MEMBER_CHANGES = ["added", "removed", "changed"] as const

/** The members that differ between the installed revision and the target. */
function ChangedMembers({ plan }: { plan: HarnessPluginUpdatePlan }) {
  const t = useTranslations("Harness.plugins.dialog")
  const tMembers = useTranslations("Harness.pluginInstall.members")
  const changes = plan.changed_members
  if (changes === null) return null
  return (
    <InstallPart title={t("changedMembers")} aside={changes.length}>
      {changes.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tMembers("none")}</p>
      ) : (
        <ul className="min-w-0 divide-y rounded-lg border text-xs">
          {changes.map((change) => (
            <li
              key={`${change.kind}:${change.name}`}
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5"
            >
              <bdi dir="ltr" className="min-w-0 font-mono font-medium">
                <MachineText>{change.name}</MachineText>
              </bdi>
              {change.kind !== "skill" && (
                <DiscoverMark size="sm">
                  {tMembers(
                    `kinds.${oneOf(["assistant"] as const, change.kind) ?? "unknown"}`
                  )}
                </DiscoverMark>
              )}
              <span className="ms-auto text-muted-foreground">
                {t(
                  `memberChanges.${oneOf(MEMBER_CHANGES, change.change) ?? "changed"}`
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </InstallPart>
  )
}

/** One agent: how it has the plugin, what the update does for it, and what
 *  that reaches. */
function HostRow({ host }: { host: HarnessPluginUpdateHost }) {
  const t = useTranslations("Harness.plugins.dialog")
  const tHosts = useTranslations("Harness.pluginInstall.hosts")
  const labels = usePluginInstallLabels()
  const action = oneOf(UPDATE_ACTIONS, host.action)
  const modeChanges = host.to_mode !== host.mode
  return (
    <li className="min-w-0 space-y-1.5 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <AgentGlyph agent={host.agent} />
          <span className="font-medium whitespace-nowrap">
            {labels.agent(host.agent)}
          </span>
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            {modeChanges
              ? `${labels.mode(host.mode)} → ${labels.mode(host.to_mode)}`
              : labels.mode(host.mode)}
          </span>
        </span>
        <span
          className={cn(
            "ms-auto text-xs",
            action === "needs_repair" || action === "to_skills"
              ? "text-tone-warning"
              : "text-muted-foreground"
          )}
        >
          {t(`actions.${action ?? "unknown"}`)}
        </span>
      </div>
      {host.why_not && <RowNote>{labels.reason(host.why_not)}</RowNote>}
      {host.to_mode === "native" && host.codex_hooks_need_trust && (
        <RowNote tone="warning">{tHosts("codexTrust")}</RowNote>
      )}
      <ExpertsNote agent={host.agent} links={host.experts_to_take_over} />
      <ExpertsNote agent={host.agent} links={host.experts_to_give_back} give />
      <SkillsPlanEffects plan={host.skills} />
    </li>
  )
}

function BlockerLine({ blocker }: { blocker: PluginUpdateBlocker }) {
  const t = useTranslations("Harness.plugins.dialog.missing")
  const tPlugin = useTranslations("Harness.pluginInstall.missing")
  const tSkill = useTranslations("Harness.skillInstall.missing")
  const labels = usePluginInstallLabels()
  switch (blocker.kind) {
    case "state":
      return tSkill("state")
    case "yanked":
      return t("yanked")
    case "consent":
      return tPlugin("consent")
    case "target":
      return t("target")
    case "agent":
      return tPlugin(
        blocker.problem === "blocked" ? "agentBlocked" : "agentNoPreview",
        { agent: labels.agent(blocker.agent) }
      )
    default:
      return null
  }
}

function InputBody({
  dialog,
  plan,
}: {
  dialog: PluginUpdateDialogState
  plan: HarnessPluginUpdatePlan
}) {
  const t = useTranslations("Harness.plugins.dialog")
  const tAutorun = useTranslations("Harness.pluginInstall.autorun")
  const tPlugin = useTranslations("Harness.pluginInstall")
  const tSkill = useTranslations("Harness.skillInstall")
  const labels = usePluginInstallLabels()
  const { slots } = useHarnessView()
  const consentId = useId()
  const target = updateTargetOf(plan)
  const yanked = needsUpdateYankedConfirm(plan)
  const blockers = pluginUpdateBlockersOf(plan, dialog.input).filter(
    (blocker) => blocker.kind !== "item" && blocker.kind !== "upToDate"
  )
  const from =
    plan.version_from ??
    versionLabel({ revision: plan.revision_from, version: null })
  const to =
    plan.version_to ??
    (plan.target !== null
      ? versionLabel({ revision: plan.target, version: null })
      : null)
  const code = (chunks: ReactNode) => <Code>{chunks}</Code>
  return (
    <div className="min-w-0 space-y-5">
      <div className="min-w-0 space-y-2">
        {to !== null && (
          <p className="text-sm">{t.rich("fromTo", { from, to, code })}</p>
        )}
        {plan.latest && (
          <PluginVersionsLine
            full={plan.full}
            latest={plan.latest}
            notFull={plan.not_full}
          />
        )}
      </div>
      {plan.up_to_date && <Headline tone="fine">{t("upToDate")}</Headline>}
      {dialog.notice && (
        <Headline tone="neutral">
          {tPlugin(`notices.${dialog.notice}`)}
        </Headline>
      )}
      {dialog.changes.length > 0 && (
        <InstallChangeList changes={dialog.changes} />
      )}
      {dialog.issues.length > 0 && (
        <div role="alert" className="min-w-0 space-y-1.5">
          <Headline tone="warning">{t("refused")}</Headline>
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
          id={`plugin-update-${dialog.id}-yanked`}
          checked={dialog.input.acceptYanked}
          onChange={(accept) =>
            updatePluginUpdateInput(slots, dialog.id, (prev) => ({
              ...prev,
              acceptYanked: accept,
            }))
          }
        />
      )}
      <InstallSnapshot snapshot={plan.snapshot} />
      {plan.warnings.length > 0 && (
        <InstallPart title={tSkill("warnings.title")}>
          <InstallReasonList
            reasons={plan.warnings}
            tone="warning"
            wording={labels.reason}
          />
        </InstallPart>
      )}
      {!plan.up_to_date && <ChangedMembers plan={plan} />}
      {plan.hosts.length > 0 && (
        <InstallPart title={tPlugin("hosts.title")}>
          <ul className="min-w-0 divide-y rounded-lg border">
            {plan.hosts.map((host) => (
              <HostRow key={host.agent} host={host} />
            ))}
          </ul>
        </InstallPart>
      )}
      {(plan.needs_consent || plan.autorun.length > 0) && (
        <InstallPart title={tAutorun("title")} aside={plan.autorun.length}>
          <AutorunList
            parts={plan.autorun}
            pkg={target}
            consent={
              plan.needs_consent
                ? {
                    id: consentId,
                    checked: updateConsentGiven(plan, dialog.input),
                    disabled: plan.consent_exec === null,
                    onChange: (agree) =>
                      updatePluginUpdateInput(slots, dialog.id, (prev) => ({
                        ...prev,
                        consentExec: agree ? plan.consent_exec : null,
                      })),
                  }
                : undefined
            }
          />
        </InstallPart>
      )}
      {!plan.up_to_date && blockers.length > 0 && (
        <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2 text-xs">
          <p className="font-medium">{t("missing.title")}</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-5 text-muted-foreground">
            {blockers.map((blocker, index) => (
              <li key={index}>
                <BlockerLine blocker={blocker} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * Update an installed plugin: one revision for every agent — the one to
 * install whole while any agent has it so, else the latest. It shows the
 * versions from and to, the members that changed, what each agent gets,
 * what runs on its own with the agreement asked again when needed, and the
 * Experts pack's links taken or given back — and updates only when its own
 * button is pressed, with exactly what it showed.
 */
export function PluginUpdateDialog({
  dialog,
}: {
  dialog: PluginUpdateDialogState
}) {
  const t = useTranslations("Harness.install")
  const tSkill = useTranslations("Harness.skillInstall.dialog")
  const tManage = useTranslations("Harness.plugins.dialog")
  const discover = useDiscoverLabels()
  const { slots } = useHarnessView()
  const plan = dialog.plan
  const title =
    pickLocalized(plan?.item?.title, discover.lang) ?? dialog.subject.name
  const close = () => closeHarnessDialog(slots, dialog.id)
  const confirm = () => void confirmPluginUpdate(slots, dialog.id)
  const confirmable = canConfirmPluginUpdate(dialog)
  const updating = dialog.step === "updating"

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
            onClick={() => void planPluginUpdate(slots, dialog.id)}
          >
            <RefreshCw aria-hidden="true" />
            {t("dialog.retry")}
          </Button>
        )}
      </>
    )
  } else if (dialog.planPhase === "loading" || !plan) {
    body = <Progress>{tSkill("loading")}</Progress>
    footer = (
      <Button type="button" variant="outline" onClick={close}>
        {t("dialog.cancel")}
      </Button>
    )
  } else if (updating) {
    body = <Progress>{t("dialog.working.update")}</Progress>
    footer = (
      <Button type="button" disabled>
        {t("dialog.working.update")}
      </Button>
    )
  } else if (dialog.step === "result" && dialog.result) {
    const done = dialog.result.outcome === "updated"
    body = (
      <PluginOperationResult
        result={dialog.result}
        done={done}
        doneText={tManage("outcome.updated")}
      />
    )
    footer =
      dialog.result.outcome === "busy" ? (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => backToPluginUpdateInput(slots, dialog.id)}
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
          {done ? t("dialog.done") : t("dialog.close")}
        </Button>
      )
  } else {
    body = <InputBody dialog={dialog} plan={plan} />
    footer = plan.up_to_date ? (
      <Button type="button" onClick={close}>
        {t("dialog.close")}
      </Button>
    ) : (
      <>
        <Button type="button" variant="outline" onClick={close}>
          {t("dialog.cancel")}
        </Button>
        <Button type="button" disabled={!confirmable} onClick={confirm}>
          {t("dialog.confirm.update")}
        </Button>
      </>
    )
  }

  return (
    <McpDialogFrame
      size="wide"
      title={tSkill.rich("title.update", {
        title,
        name: (chunks) => <bdi>{chunks}</bdi>,
      })}
      onRequestClose={() => !updating && close()}
      footer={footer}
      step={`${dialog.step}:${dialog.planPhase}:${dialog.notice ?? ""}`}
    >
      {body}
    </McpDialogFrame>
  )
}
