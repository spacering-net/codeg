"use client"

import type { ReactNode } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessView } from "@/contexts/harness-view-context"
import { oneOf } from "@/lib/harness/display"
import { closeHarnessDialog } from "@/lib/harness/mcp-install-state"
import {
  canConfirmSkillUninstall,
  confirmSkillUninstall,
  preflightSkillUninstall,
  type SkillUninstallDialog as SkillUninstallDialogState,
} from "@/lib/harness/skill-install-state"
import type {
  HarnessSkillPhase,
  HarnessSkillUninstallResult,
} from "@/lib/harness/skill-install-types"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { MachineText } from "../machine-text"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { Headline, Technical } from "../mcp/mcp-plan"
import { AgentNames } from "../skills/effects-dialog"
import { SkillPath } from "../skills/skill-bits"
import { useSkillsLabels } from "../skills/use-skills-labels"
import {
  InstallFailureNotice,
  InstallPart,
  InstallReasonList,
} from "./install-parts"
import { useSkillInstallLabels } from "./use-skill-install-labels"

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

const REMOVAL_KINDS = ["link", "copy", "broken_link"] as const

function Paths({ paths }: { paths: readonly string[] }) {
  return (
    <ul className="min-w-0 space-y-0.5">
      {paths.map((path) => (
        <li key={path} className="min-w-0">
          <SkillPath path={path} className="text-foreground" />
        </li>
      ))}
    </ul>
  )
}

function Phases({ phases }: { phases: readonly HarnessSkillPhase[] }) {
  const t = useTranslations("Harness.skillInstall.outcome")
  const labels = useSkillInstallLabels()
  if (phases.length === 0) return null
  return (
    <div className="min-w-0 space-y-1 text-xs">
      <p className="text-muted-foreground">{t("steps")}</p>
      <ol className="min-w-0 divide-y rounded-lg border">
        {phases.map((phase, index) => (
          <li
            key={index}
            className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5"
          >
            <span className="font-medium">{labels.phase(phase.phase)}</span>
            <span
              className={cn(
                phase.status === "failed" || phase.status === "rolled_back"
                  ? "text-tone-warning"
                  : "text-muted-foreground"
              )}
            >
              {labels.phaseStatus(phase.status)}
            </span>
            {phase.detail && (
              <span className="basis-full">
                <Technical detail={phase.detail} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * What uninstalling does, by the backend's preflight: the links and copies
 * it removes from which folder and who stops seeing the skill, the copies
 * changed on an agent's side that stay, the files the user changed — and
 * whether the folder is deleted or kept in the backups.
 */
function Effects({ preflight }: { preflight: HarnessSkillUninstallResult }) {
  const t = useTranslations("Harness.skillInstall.uninstall")
  const skills = useSkillsLabels()
  const { changed, added, missing } = preflight.files
  return (
    <div className="min-w-0 space-y-4">
      <InstallPart title={t("removes")}>
        {preflight.removes.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("nobody")}</p>
        ) : (
          <ul className="min-w-0 divide-y rounded-lg border text-xs">
            {preflight.removes.map((removal) => (
              <li key={removal.path} className="min-w-0 space-y-1 px-3 py-2">
                <p className="text-muted-foreground">
                  {t(
                    `kinds.${oneOf(REMOVAL_KINDS, removal.kind) ?? "unknown"}`
                  )}
                </p>
                <SkillPath path={removal.path} className="text-foreground" />
                {removal.agents.length > 0 && (
                  <p className="text-muted-foreground">
                    {t("seenBy")} <AgentNames agents={removal.agents} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </InstallPart>
      {preflight.loses.length > 0 && (
        <p className="text-xs">
          {t("loses")} <AgentNames agents={preflight.loses} />
        </p>
      )}
      {preflight.kept_copies.length > 0 && (
        <div className="min-w-0 space-y-1 text-xs">
          <p className="text-tone-warning">{t("keptCopies")}</p>
          <ul className="min-w-0 space-y-1">
            {preflight.kept_copies.map((copy, index) => (
              <li key={index} className="min-w-0">
                {copy.path && (
                  <SkillPath path={copy.path} className="text-foreground" />
                )}
                {copy.agents.length > 0 && (
                  <span className="block text-muted-foreground">
                    {skills.agents(copy.agents)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="min-w-0 space-y-2 rounded-lg border px-3 py-2.5 text-xs">
        {changed.length > 0 && (
          <div className="min-w-0 space-y-0.5">
            <p className="text-tone-warning">{t("changedFiles")}</p>
            <Paths paths={changed} />
          </div>
        )}
        {added.length > 0 && (
          <div className="min-w-0 space-y-0.5">
            <p className="text-tone-warning">{t("addedFiles")}</p>
            <Paths paths={added} />
          </div>
        )}
        {missing.length > 0 && (
          <div className="min-w-0 space-y-0.5">
            <p className="text-muted-foreground">{t("missingFiles")}</p>
            <Paths paths={missing} />
          </div>
        )}
        {preflight.files_unreadable !== null ? (
          <p className="text-tone-warning">
            {t("unreadable")}
            <Technical detail={preflight.files_unreadable} />
          </p>
        ) : preflight.keeps_folder ? (
          <p>{t.rich("keepsFolder", { code })}</p>
        ) : (
          <p className="text-muted-foreground">{t("deletesFolder")}</p>
        )}
      </div>
    </div>
  )
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

/**
 * Uninstall a skill installed from Harness: what it would do is asked first
 * and shown — every agent it is unlinked from, the folder deleted or kept
 * with the user's changes — and done only with the acknowledgement of that
 * account. If what it would do changed since, nothing is removed and the new
 * account is shown.
 */
export function SkillUninstallDialog({
  dialog,
}: {
  dialog: SkillUninstallDialogState
}) {
  const t = useTranslations("Harness.skillInstall.uninstall")
  const tInstall = useTranslations("Harness.install.dialog")
  const labels = useSkillInstallLabels()
  const { slots } = useHarnessView()
  const close = () => closeHarnessDialog(slots, dialog.id)
  const confirm = () => void confirmSkillUninstall(slots, dialog.id)
  const confirmable = canConfirmSkillUninstall(dialog)
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
    body = <Progress>{t("uninstalling")}</Progress>
    footer = (
      <Button type="button" disabled>
        {t("uninstalling")}
      </Button>
    )
  } else if (dialog.phase === "result" && result) {
    const done = result.outcome === "uninstalled"
    body = (
      <div role={done ? "status" : "alert"} className="min-w-0 space-y-3">
        <Headline tone={done ? "fine" : "warning"}>
          {done
            ? t("done")
            : result.outcome === "refused"
              ? t("refused")
              : result.outcome === "busy"
                ? t("busy")
                : result.outcome === "write_failed"
                  ? t("writeFailed")
                  : t("unknown")}
        </Headline>
        {result.issues.length > 0 && (
          <InstallReasonList
            reasons={result.issues}
            tone={done ? "warning" : "blocking"}
            wording={labels.reason}
          />
        )}
        {result.backup && (
          <div className="min-w-0 space-y-0.5 text-xs">
            <p className="text-muted-foreground">{t("backup")}</p>
            <Paths paths={[result.backup]} />
          </div>
        )}
        {result.kept.length > 0 && (
          <div className="min-w-0 space-y-0.5 text-xs">
            <p className="text-tone-warning">{t("kept")}</p>
            <Paths paths={result.kept} />
          </div>
        )}
        {!done && result.outcome !== "busy" && (
          <Phases phases={result.phases} />
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
          <Headline tone="neutral">{t("changed")}</Headline>
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
            onClick={() => void preflightSkillUninstall(slots, dialog.id)}
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
            {t("confirm")}
          </Button>
        )}
      </>
    )
  }

  return (
    <McpDialogFrame
      title={t.rich("title", {
        name: dialog.name,
        code: (chunks) => (
          <bdi dir="ltr" className="font-mono">
            <MachineText>{chunks}</MachineText>
          </bdi>
        ),
      })}
      description={dialog.phase === "ready" ? t("description") : undefined}
      onRequestClose={() => !uninstalling && close()}
      footer={footer}
      step={`${dialog.phase}:${dialog.notice ?? ""}`}
    >
      {body}
    </McpDialogFrame>
  )
}
