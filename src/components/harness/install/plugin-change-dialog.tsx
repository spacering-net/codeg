"use client"

import { useId, type ReactNode } from "react"
import { RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  closeHarnessDialog,
  HARNESS_INSTALLED,
  reloadHarnessInstalled,
} from "@/lib/harness/mcp-install-state"
import { listedPluginOf } from "@/lib/harness/plugin-list"
import {
  changeConsentGiven,
  pluginChangeBlockersOf,
} from "@/lib/harness/plugin-manage"
import {
  canConfirmPluginChange,
  confirmPluginChange,
  preflightPluginChange,
  setPluginChangeConsent,
  type PluginChangeDialog as PluginChangeDialogState,
} from "@/lib/harness/plugin-manage-state"
import type {
  HarnessExpertLink,
  HarnessPluginInstallResult,
} from "@/lib/harness/plugin-install-types"
import { MachineText } from "../machine-text"
import { AgentGlyph } from "../mcp/mcp-bits"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { Headline } from "../mcp/mcp-plan"
import {
  InstallChangeList,
  InstallFailureNotice,
  InstallPart,
  InstallReasonList,
  InstallSnapshot,
} from "./install-parts"
import { Progress } from "./plugin-install-dialog"
import {
  ExpertsNote,
  PluginOperationResult,
  SkillsPlanEffects,
} from "./plugin-manage-parts"
import { AutorunList } from "./plugin-parts"
import { usePluginInstallLabels } from "./use-plugin-install-labels"

const machine = (chunks: ReactNode) => (
  <bdi dir="ltr" className="font-mono">
    <MachineText>{chunks}</MachineText>
  </bdi>
)

/** What the preflight says the change does, agent by agent: the links it
 *  makes or removes and the Experts pack's links it takes or gives back. */
function Effects({ preflight }: { preflight: HarnessPluginInstallResult }) {
  const t = useTranslations("Harness.pluginInstall.hosts")
  const labels = usePluginInstallLabels()
  const agents = [
    ...new Set([
      ...Object.keys(preflight.skills),
      ...Object.keys(preflight.experts_to_take_over),
      ...Object.keys(preflight.experts_to_give_back),
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
              links={preflight.experts_to_take_over[agent] ?? none}
            />
            <ExpertsNote
              agent={agent}
              links={preflight.experts_to_give_back[agent] ?? none}
              give
            />
            <SkillsPlanEffects plan={preflight.skills[agent]} />
          </li>
        ))}
      </ul>
    </InstallPart>
  )
}

/**
 * A change to an installed plugin for one agent — another mode, switched
 * off or on — or its repair. What the change would do is asked first and
 * shown (the links it makes or removes, the Experts pack's links, what runs
 * on its own when it is to run), and done only with exactly that answer's
 * acknowledgements.
 */
export function PluginChangeDialog({
  dialog,
}: {
  dialog: PluginChangeDialogState
}) {
  const t = useTranslations("Harness.plugins.dialog")
  const tInstall = useTranslations("Harness.install.dialog")
  const tAutorun = useTranslations("Harness.pluginInstall.autorun")
  const tPlugin = useTranslations("Harness.pluginInstall")
  const tMissing = useTranslations("Harness.pluginInstall.missing")
  const tSkill = useTranslations("Harness.skillInstall.missing")
  const labels = usePluginInstallLabels()
  const { slots } = useHarnessView()
  const [installed] = useHarnessSlot(HARNESS_INSTALLED)
  const consentId = useId()
  const close = () => closeHarnessDialog(slots, dialog.id)
  const confirm = () => void confirmPluginChange(slots, dialog.id)
  const confirmable = canConfirmPluginChange(dialog)
  const writing = dialog.phase === "writing"
  const preflight = dialog.preflight
  const action = dialog.action
  const plugin = listedPluginOf(installed.value, dialog.subject.itemId)
  const name = dialog.subject.name
  // What runs on its own, as the listing has it — shown, and agreed to, only
  // while it is what the preflight asks agreement for (another window may
  // have updated the plugin since the listing was read).
  const shownExec =
    plugin &&
    preflight &&
    (preflight.revision === null || preflight.revision === plugin.revision)
      ? plugin.exec_sha256
      : null
  // Agreed to only with what runs on its own on show.
  const consentShown =
    preflight !== null &&
    plugin !== null &&
    plugin.autorun.length > 0 &&
    shownExec !== null &&
    shownExec === preflight.consent_exec
  const checkAgain = () => {
    void reloadHarnessInstalled(slots)
    void preflightPluginChange(slots, dialog.id)
  }

  const title =
    action.kind === "repair"
      ? t.rich("title.repair", { name, code: machine })
      : action.kind === "enabled"
        ? t.rich(action.enabled ? "title.enable" : "title.disable", {
            name,
            agent: labels.agent(action.agent),
            code: machine,
          })
        : t.rich("title.mode", {
            name,
            agent: labels.agent(action.agent),
            mode: labels.mode(action.mode),
            code: machine,
          })
  const confirmLabel =
    action.kind === "repair"
      ? t("confirm.repair")
      : action.kind === "enabled"
        ? t(action.enabled ? "confirm.enable" : "confirm.disable")
        : t("confirm.mode")
  const doneText =
    action.kind === "repair" ? t("outcome.repaired") : t("outcome.changed")

  let body: ReactNode
  let footer: ReactNode
  if (dialog.phase === "checking") {
    body = <Progress>{t("checking")}</Progress>
    footer = (
      <Button type="button" variant="outline" onClick={close}>
        {tInstall("cancel")}
      </Button>
    )
  } else if (writing) {
    body = <Progress>{t("writing")}</Progress>
    footer = (
      <Button type="button" disabled>
        {t("writing")}
      </Button>
    )
  } else if (dialog.phase === "result" && dialog.result) {
    const result = dialog.result
    const done =
      result.outcome === "changed" ||
      result.outcome === "repaired" ||
      result.outcome === "updated"
    body = (
      <PluginOperationResult result={result} done={done} doneText={doneText} />
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
    const blockers = preflight
      ? pluginChangeBlockersOf(action, preflight, dialog.input).filter(
          (blocker) => blocker.kind !== "refused"
        )
      : []
    body = (
      <div className="min-w-0 space-y-4">
        {dialog.notice && (
          <Headline tone="neutral">
            {tPlugin(`notices.${dialog.notice}`)}
          </Headline>
        )}
        {dialog.changes.length > 0 && (
          <InstallChangeList changes={dialog.changes} />
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
            {preflight.snapshot && (
              <InstallSnapshot snapshot={preflight.snapshot} />
            )}
            <Effects preflight={preflight} />
            {preflight.consent_required && (
              <InstallPart
                title={tAutorun("title")}
                aside={consentShown ? plugin?.autorun.length : undefined}
              >
                <div className="min-w-0 space-y-2">
                  {consentShown ? (
                    <AutorunList
                      parts={plugin?.autorun ?? []}
                      pkg={null}
                      consent={{
                        id: consentId,
                        checked: changeConsentGiven(preflight, dialog.input),
                        onChange: (agree) =>
                          setPluginChangeConsent(
                            slots,
                            dialog.id,
                            agree,
                            shownExec
                          ),
                      }}
                    />
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={checkAgain}
                      className="max-md:h-10"
                    >
                      <RefreshCw aria-hidden="true" />
                      {tInstall("checkAgain")}
                    </Button>
                  )}
                </div>
              </InstallPart>
            )}
            {blockers.length > 0 && (
              <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2 text-xs">
                <p className="font-medium">{t("missing.titleChange")}</p>
                <ul className="mt-1 list-disc space-y-0.5 ps-5 text-muted-foreground">
                  {blockers.map((blocker) => (
                    <li key={blocker.kind}>
                      {blocker.kind === "consent"
                        ? tMissing("consent")
                        : tSkill("state")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
            onClick={() => void preflightPluginChange(slots, dialog.id)}
          >
            <RefreshCw aria-hidden="true" />
            {tInstall("checkAgain")}
          </Button>
        ) : (
          <Button
            type="button"
            variant={
              action.kind === "mode" && action.mode === "none"
                ? "destructive"
                : "default"
            }
            disabled={!confirmable}
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        )}
      </>
    )
  }

  return (
    <McpDialogFrame
      title={title}
      onRequestClose={() => !writing && close()}
      footer={footer}
      step={`${dialog.phase}:${dialog.notice ?? ""}`}
    >
      {body}
    </McpDialogFrame>
  )
}
