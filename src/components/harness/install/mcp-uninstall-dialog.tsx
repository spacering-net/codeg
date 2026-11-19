"use client"

import { useId, type ReactNode } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useHarnessView } from "@/contexts/harness-view-context"
import { localStateOf } from "@/lib/harness/mcp-marks"
import {
  canConfirmUninstall,
  changeUninstallSelection,
  closeHarnessDialog,
  confirmMcpUninstall,
  installedItemById,
  preflightMcpUninstall,
  type McpUninstallDialog as McpUninstallDialogState,
} from "@/lib/harness/mcp-install-state"
import { isMcpAppType } from "@/lib/mcp/types"
import { cn } from "@/lib/utils"
import { MachineText } from "../machine-text"
import { AgentGlyph } from "../mcp/mcp-bits"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { AgentResults, Headline, Technical } from "../mcp/mcp-plan"
import { useMcpLabels } from "../mcp/use-mcp-labels"
import {
  InstallFailureNotice,
  InstallItemLine,
  InstallReasonList,
} from "./install-parts"
import { useInstallLabels } from "./use-install-labels"

const machine = (chunks: ReactNode) => (
  <bdi dir="ltr">
    <MachineText>{chunks}</MachineText>
  </bdi>
)

/** One recorded agent: ticked or not, how its entry stands, and what the
 *  backend says uninstalling would do to it. An entry changed here since it
 *  was installed is kept unless its own box is ticked too. */
function AgentRow({
  dialog,
  agent,
  state,
  action,
}: {
  dialog: McpUninstallDialogState
  agent: string
  state: string
  action: string | null
}) {
  const t = useTranslations("Harness.install.uninstall")
  const tStates = useTranslations("Harness.mcp.harness.states")
  const mcp = useMcpLabels()
  const labels = useInstallLabels()
  const { slots } = useHarnessView()
  const baseId = useId()
  const known = isMcpAppType(agent) ? agent : null
  const ticked = known !== null && dialog.agents.includes(known)
  const changed = localStateOf(state) === "changedLocally"
  const busy = dialog.phase === "uninstalling" || dialog.phase === "result"
  return (
    <li className="min-w-0 space-y-1.5 px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <Checkbox
          id={`${baseId}-agent`}
          checked={ticked}
          disabled={!known || busy}
          onCheckedChange={(checked) =>
            known &&
            changeUninstallSelection(slots, dialog.id, {
              agent: known,
              list: "agents",
              on: checked === true,
            })
          }
          className="mt-0.5 max-md:size-5"
        />
        <label
          htmlFor={`${baseId}-agent`}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
        >
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <AgentGlyph agent={agent} />
            <span className="min-w-0 truncate">{mcp.agent(agent)}</span>
          </span>
          <span
            className={cn(
              "text-xs",
              changed ? "text-tone-warning" : "text-muted-foreground"
            )}
          >
            {tStates(localStateOf(state))}
            {action && ` · ${labels.uninstallAction(action)}`}
          </span>
        </label>
      </div>
      {ticked && changed && known && (
        <div className="ms-7 flex min-w-0 items-start gap-2.5 rounded-md bg-tone-warning/10 px-2.5 py-2 text-xs">
          <Checkbox
            id={`${baseId}-changed`}
            checked={dialog.removeChanged.includes(known)}
            disabled={busy}
            onCheckedChange={(checked) =>
              changeUninstallSelection(slots, dialog.id, {
                agent: known,
                list: "removeChanged",
                on: checked === true,
              })
            }
            className="mt-0.5 bg-background max-md:size-5"
          />
          <label
            htmlFor={`${baseId}-changed`}
            className="min-w-0 cursor-pointer"
          >
            {t("removeChanged")}
          </label>
        </div>
      )}
    </li>
  )
}

/**
 * Uninstall an MCP server that came from Harness: from the agents ticked,
 * after the backend has said what that would do to each — an entry changed
 * here since it was installed is kept unless the user ticks it after reading
 * that. Nothing is removed before the dialog's own button is pressed.
 */
export function McpUninstallDialog({
  dialog,
}: {
  dialog: McpUninstallDialogState
}) {
  const t = useTranslations("Harness.install.uninstall")
  const tDialog = useTranslations("Harness.install.dialog")
  const tRecord = useTranslations("Harness.install.record")
  const labels = useInstallLabels()
  const { slots } = useHarnessView()
  const close = () => closeHarnessDialog(slots, dialog.id)
  const item = installedItemById(slots, dialog.itemId)
  const preflight = dialog.preflight
  // The backend's report lists every recorded agent; before it is in, the
  // listing's.
  const rows =
    preflight && preflight.agents.length > 0
      ? preflight.agents.map((agent) => ({
          agent: agent.agent,
          state: agent.state,
          action: agent.action as string | null,
        }))
      : (item?.agents ?? []).map((agent) => ({
          agent: agent.agent,
          state: agent.state,
          action: null,
        }))
  const confirmable = canConfirmUninstall(dialog)
  const uninstalling = dialog.phase === "uninstalling"
  const result = dialog.result

  let body: ReactNode
  let footer: ReactNode
  if (dialog.phase === "result" && result) {
    const record = result.record
    body = (
      <div
        role={result.outcome === "uninstalled" ? "status" : "alert"}
        className="min-w-0 space-y-3"
      >
        {result.outcome === "uninstalled" ? (
          <Headline tone="fine">{t("done")}</Headline>
        ) : result.outcome === "refused" ? (
          <>
            <Headline tone="warning">{t("refused")}</Headline>
            <InstallReasonList reasons={result.issues} tone="blocking" />
          </>
        ) : (
          <Headline tone="warning">
            {t(
              result.outcome === "busy"
                ? "busy"
                : result.outcome === "invalid"
                  ? "invalid"
                  : result.outcome === "write_failed"
                    ? "writeFailed"
                    : "unknown"
            )}
          </Headline>
        )}
        {/* An uninstall that only forgets agents writes no file: its
            result has no agents to list. */}
        {result.apply && result.apply.agents.length > 0 && (
          <AgentResults
            result={result.apply}
            phase={result.outcome === "invalid" ? "review" : "result"}
          />
        )}
        {record?.status === "failed" && (
          <Headline tone="warning">
            {tRecord("uninstallFailed")} {labels.record(record.code)}
            <Technical detail={record.detail} />
          </Headline>
        )}
      </div>
    )
    footer =
      result.outcome === "busy" ? (
        <>
          <Button type="button" variant="outline" onClick={close}>
            {tDialog("close")}
          </Button>
          <Button
            type="button"
            disabled={!confirmable}
            onClick={() => void confirmMcpUninstall(slots, dialog.id)}
          >
            <RefreshCw aria-hidden="true" />
            {tDialog("retry")}
          </Button>
        </>
      ) : result.outcome === "refused" || result.outcome === "invalid" ? (
        <>
          <Button type="button" variant="outline" onClick={close}>
            {tDialog("close")}
          </Button>
          <Button
            type="button"
            onClick={() => void preflightMcpUninstall(slots, dialog.id)}
          >
            <RefreshCw aria-hidden="true" />
            {tDialog("checkAgain")}
          </Button>
        </>
      ) : (
        <Button type="button" onClick={close}>
          {tDialog(result.outcome === "uninstalled" ? "done" : "close")}
        </Button>
      )
  } else {
    body = (
      <div className="min-w-0 space-y-4">
        <div className="min-w-0 space-y-2">
          <InstallItemLine
            itemRef={dialog.itemRef}
            title={item?.title}
            version={item?.version ?? null}
            revision={item?.revision ?? 0}
            publishedAt=""
          />
        </div>
        {dialog.notice === "changedElsewhere" && (
          <Headline tone="neutral">{t("changedElsewhere")}</Headline>
        )}
        {dialog.failure && <InstallFailureNotice failure={dialog.failure} />}
        <fieldset className="min-w-0">
          <legend className="pb-2 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("from")}
          </legend>
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <AgentRow
                key={row.agent}
                dialog={dialog}
                agent={row.agent}
                state={row.state}
                action={row.action}
              />
            ))}
          </ul>
        </fieldset>
        {dialog.phase === "checking" ? (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {t("checking")}
          </p>
        ) : uninstalling ? (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {t("uninstalling")}
          </p>
        ) : preflight ? (
          <div className="min-w-0 space-y-2">
            {preflight.outcome === "preflight" ? (
              !confirmable ? (
                <Headline tone="neutral">{t("nothing")}</Headline>
              ) : null
            ) : preflight.outcome === "refused" ? (
              <>
                <Headline tone="warning">{t("refused")}</Headline>
                <InstallReasonList reasons={preflight.issues} tone="blocking" />
              </>
            ) : (
              <Headline tone="warning">
                {t(
                  preflight.outcome === "changed_elsewhere"
                    ? "changedElsewhere"
                    : "blocked"
                )}
              </Headline>
            )}
            {preflight.apply && preflight.apply.agents.length > 0 && (
              <AgentResults result={preflight.apply} phase="review" />
            )}
          </div>
        ) : null}
      </div>
    )
    footer = (
      <>
        <Button
          type="button"
          variant="outline"
          disabled={uninstalling}
          onClick={close}
        >
          {tDialog("cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!confirmable || uninstalling}
          onClick={() => void confirmMcpUninstall(slots, dialog.id)}
        >
          {uninstalling ? t("uninstalling") : t("confirm")}
        </Button>
      </>
    )
  }

  return (
    <McpDialogFrame
      title={t.rich("title", { key: dialog.key, code: machine })}
      description={dialog.phase !== "result" ? t("description") : undefined}
      onRequestClose={() => !uninstalling && close()}
      footer={footer}
      step={dialog.phase === "result" ? "result" : "input"}
    >
      {body}
    </McpDialogFrame>
  )
}
