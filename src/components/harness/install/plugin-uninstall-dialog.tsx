"use client"

import type { ReactNode } from "react"
import { RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessView } from "@/contexts/harness-view-context"
import { closeHarnessDialog } from "@/lib/harness/mcp-install-state"
import {
  canConfirmPluginUninstall,
  confirmPluginUninstall,
  preflightPluginUninstall,
  type PluginUninstallDialog as PluginUninstallDialogState,
} from "@/lib/harness/plugin-manage-state"
import type {
  HarnessExpertLink,
  HarnessPluginUninstallResult,
} from "@/lib/harness/plugin-install-types"
import { MachineText } from "../machine-text"
import { AgentGlyph } from "../mcp/mcp-bits"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { Headline, Technical } from "../mcp/mcp-plan"
import {
  InstallFailureNotice,
  InstallPart,
  InstallReasonList,
} from "./install-parts"
import { HostOutcomes, Progress } from "./plugin-install-dialog"
import { ExpertsNote, SkillsPlanEffects } from "./plugin-manage-parts"
import { usePluginInstallLabels } from "./use-plugin-install-labels"

const machine = (chunks: ReactNode) => (
  <bdi dir="ltr" className="font-mono">
    <MachineText>{chunks}</MachineText>
  </bdi>
)

/** What uninstalling does, by agent: its skills' links removed (and who
 *  else stops seeing them), the Experts pack's links given back. */
function Effects({ preflight }: { preflight: HarnessPluginUninstallResult }) {
  const t = useTranslations("Harness.pluginInstall.hosts")
  const labels = usePluginInstallLabels()
  const agents = [
    ...new Set([
      ...Object.keys(preflight.removes),
      ...Object.keys(preflight.experts),
    ]),
  ]
  if (agents.length === 0) return null
  const none: HarnessExpertLink[] = []
  return (
    <InstallPart title={t("title")}>
      <ul className="min-w-0 divide-y rounded-lg border">
        {agents.map((agent) => (
          <li key={agent} className="min-w-0 space-y-1.5 px-3 py-2.5">
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <AgentGlyph agent={agent} />
              <span className="font-medium">{labels.agent(agent)}</span>
            </span>
            <ExpertsNote
              agent={agent}
              links={preflight.experts[agent] ?? none}
              give
            />
            <SkillsPlanEffects plan={preflight.removes[agent]} />
          </li>
        ))}
      </ul>
    </InstallPart>
  )
}

/**
 * Uninstall a plugin from every agent: what it would do is asked first and
 * shown, and done only with the acknowledgement of that account. If what it
 * would do changed since, nothing is removed and the new account is shown.
 */
export function PluginUninstallDialog({
  dialog,
}: {
  dialog: PluginUninstallDialogState
}) {
  const t = useTranslations("Harness.plugins.dialog")
  const tUninstall = useTranslations("Harness.skillInstall.uninstall")
  const tInstall = useTranslations("Harness.install.dialog")
  const tOutcome = useTranslations("Harness.pluginInstall.outcome")
  const labels = usePluginInstallLabels()
  const { slots } = useHarnessView()
  const close = () => closeHarnessDialog(slots, dialog.id)
  const confirm = () => void confirmPluginUninstall(slots, dialog.id)
  const confirmable = canConfirmPluginUninstall(dialog)
  const uninstalling = dialog.phase === "uninstalling"
  const preflight = dialog.preflight
  const result = dialog.result

  let body: ReactNode
  let footer: ReactNode
  if (dialog.phase === "checking") {
    body = <Progress>{t("checking")}</Progress>
    footer = (
      <Button type="button" variant="outline" onClick={close}>
        {tInstall("cancel")}
      </Button>
    )
  } else if (uninstalling) {
    body = <Progress>{tUninstall("uninstalling")}</Progress>
    footer = (
      <Button type="button" disabled>
        {tUninstall("uninstalling")}
      </Button>
    )
  } else if (dialog.phase === "result" && result) {
    const done = result.outcome === "uninstalled"
    body = (
      <div role={done ? "status" : "alert"} className="min-w-0 space-y-3">
        <Headline tone={done ? "fine" : "warning"}>
          {done
            ? tUninstall("done")
            : result.outcome === "refused"
              ? t("refused")
              : result.outcome === "busy"
                ? tOutcome("busy")
                : result.outcome === "write_failed"
                  ? t("failed")
                  : tOutcome("unknown")}
        </Headline>
        {result.issues.length > 0 && (
          <InstallReasonList
            reasons={result.issues}
            tone={done || result.outcome === "busy" ? "warning" : "blocking"}
            wording={labels.reason}
          />
        )}
        <HostOutcomes hosts={result.hosts} />
        {result.needs_repair.length > 0 && (
          <p className="text-xs text-tone-warning">
            {tOutcome("needsRepair", {
              agents: labels.agents(result.needs_repair),
            })}
          </p>
        )}
        {result.problems.length > 0 && (
          <div className="min-w-0 space-y-0.5 text-xs">
            <p className="text-tone-warning">{tOutcome("problems")}</p>
            {result.problems.map((problem, index) => (
              <Technical key={index} detail={problem} />
            ))}
          </div>
        )}
      </div>
    )
    footer =
      result.outcome === "busy" ? (
        <>
          <Button type="button" variant="outline" onClick={close}>
            {tInstall("close")}
          </Button>
          <Button type="button" disabled={!confirmable} onClick={confirm}>
            <RefreshCw aria-hidden="true" />
            {tInstall("retry")}
          </Button>
        </>
      ) : (
        <Button type="button" onClick={close}>
          {done ? tInstall("done") : tInstall("close")}
        </Button>
      )
  } else {
    const refused = preflight !== null && preflight.outcome !== "preflight"
    body = (
      <div className="min-w-0 space-y-4">
        {dialog.notice === "effectsChanged" && (
          <Headline tone="neutral">{tUninstall("changed")}</Headline>
        )}
        {dialog.failure && <InstallFailureNotice failure={dialog.failure} />}
        {preflight && refused ? (
          <div role="alert" className="min-w-0 space-y-2">
            <Headline tone="warning">{t("refused")}</Headline>
            <InstallReasonList
              reasons={preflight.issues}
              tone="blocking"
              wording={labels.reason}
            />
          </div>
        ) : preflight ? (
          <>
            {preflight.issues.length > 0 && (
              <InstallReasonList
                reasons={preflight.issues}
                tone="warning"
                wording={labels.reason}
              />
            )}
            <Effects preflight={preflight} />
          </>
        ) : null}
      </div>
    )
    footer = refused ? (
      <Button type="button" onClick={close}>
        {tInstall("close")}
      </Button>
    ) : (
      <>
        <Button type="button" variant="outline" onClick={close}>
          {tInstall("cancel")}
        </Button>
        {!preflight && dialog.failure ? (
          <Button
            type="button"
            onClick={() => void preflightPluginUninstall(slots, dialog.id)}
          >
            <RefreshCw aria-hidden="true" />
            {tInstall("checkAgain")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="destructive"
            disabled={!confirmable}
            onClick={confirm}
          >
            {tUninstall("confirm")}
          </Button>
        )}
      </>
    )
  }

  return (
    <McpDialogFrame
      title={tUninstall.rich("title", {
        name: dialog.subject.name,
        code: machine,
      })}
      onRequestClose={() => !uninstalling && close()}
      footer={footer}
      step={`${dialog.phase}:${dialog.notice ?? ""}`}
    >
      {body}
    </McpDialogFrame>
  )
}
