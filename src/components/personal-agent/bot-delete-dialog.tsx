"use client"

/**
 * Deleting an assistant (4.14): the confirmation says what it touches —
 * its running work (handed to the primary to follow, by default, or
 * stopped), the messages it has not answered (they go back to their
 * senders) and its working directory (kept unless ticked) — its whole
 * path shown, wrapped.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { personalAgentBotDelete, personalAgentBotImpact } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { BotImpact } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

export function BotDeleteDialog({
  botId,
  onOpenChange,
  onDeleted,
}: {
  /** The work assistant to delete; `null` closes it. */
  botId: number | null
  onOpenChange: (open: boolean) => void
  /** It is gone (a card that asked about it settles). */
  onDeleted?: () => void
}) {
  const t = useTranslations("PersonalAgent.bots.delete")
  const viewBot = usePersonalAgentUi((s) => s.viewBot)
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const [impact, setImpact] = useState<BotImpact | null>(null)
  const [handOver, setHandOver] = useState(true)
  const [dropWorkdir, setDropWorkdir] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset paired with the impact fetch for the assistant now named
    setImpact(null)
    setHandOver(true)
    setDropWorkdir(false)
    setError(null)
    if (botId == null) return
    let live = true
    personalAgentBotImpact(botId)
      .then((i) => {
        if (live) setImpact(i)
      })
      .catch((e) => {
        if (live) setError(toErrorMessage(e))
      })
    return () => {
      live = false
    }
  }, [botId])

  const confirm = async () => {
    if (botId == null || busy) return
    setBusy(true)
    setError(null)
    try {
      await personalAgentBotDelete(botId, {
        hand_over: handOver,
        delete_workdir: dropWorkdir,
      })
      if (viewBot === botId) setViewBot(null)
      onDeleted?.()
      onOpenChange(false)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={botId != null} onOpenChange={onOpenChange}>
      <AlertDialogContent data-pa-bot-delete>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("title", { name: impact?.name ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("description")}</AlertDialogDescription>
        </AlertDialogHeader>
        {impact ? (
          // `min-w-0`: the dialog is a grid, whose items would otherwise
          // grow to their longest unbreakable line (a running task's title).
          <div className="flex min-w-0 flex-col gap-3 text-sm">
            {impact.running.length > 0 ? (
              <div data-pa-delete-running>
                <p className="mb-1.5 font-medium">
                  {t("running", { count: impact.running.length })}
                </p>
                <ul className="mb-2 list-disc ps-5 text-xs text-muted-foreground">
                  {impact.running.slice(0, 5).map((d) => (
                    <li key={d.dispatch_id} className="truncate">
                      #{d.dispatch_id} {d.title}
                    </li>
                  ))}
                </ul>
                <RadioGroup
                  value={handOver ? "hand" : "stop"}
                  onValueChange={(v) => setHandOver(v === "hand")}
                  className="gap-1.5"
                >
                  <Label className="flex items-center gap-2 font-normal">
                    <RadioGroupItem value="hand" />
                    {t("handOver")}
                  </Label>
                  <Label className="flex items-center gap-2 font-normal">
                    <RadioGroupItem value="stop" />
                    {t("stop")}
                  </Label>
                </RadioGroup>
              </div>
            ) : null}
            {impact.unanswered_messages > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("messages", { count: impact.unanswered_messages })}
              </p>
            ) : null}
            {(impact.plans ?? []).length > 0 ? (
              <p className="text-xs text-muted-foreground" data-pa-delete-plans>
                {t("plans", {
                  count: impact.plans.length,
                  titles: impact.plans
                    .slice(0, 3)
                    .map((p) => p.title)
                    .join(t("listJoiner")),
                })}
              </p>
            ) : null}
            {(impact.plan_steps ?? []).length > 0 ? (
              <p
                className="text-xs text-muted-foreground"
                data-pa-delete-plan-steps
              >
                {t("planSteps", {
                  count: impact.plan_steps.length,
                  steps: impact.plan_steps
                    .slice(0, 3)
                    .map((s) => `${s.plan_title} · ${s.seq}. ${s.title}`)
                    .join(t("listJoiner")),
                })}
              </p>
            ) : null}
            <Label className="flex items-start gap-2 font-normal">
              <Checkbox
                checked={dropWorkdir}
                disabled={impact.workdir_custom}
                onCheckedChange={(v) => setDropWorkdir(v === true)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                {t("dropWorkdir")}
                {/* The whole path, wrapped where it must be: the end of it
                    (its own folder) is the part that tells them apart. */}
                <span
                  className="mt-0.5 block font-mono text-xs leading-5 wrap-anywhere text-muted-foreground"
                  data-pa-delete-workdir
                >
                  {impact.workdir}
                </span>
                {impact.workdir_custom ? (
                  <span className="block text-xs text-muted-foreground">
                    {t("workdirCustom")}
                  </span>
                ) : null}
              </span>
            </Label>
          </div>
        ) : error ? null : (
          <SyncedSpinner
            small
            className="mx-auto size-4 text-muted-foreground"
          />
        )}
        {error ? (
          <p role="alert" className="text-xs break-words text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!impact || busy}
            onClick={() => void confirm()}
            data-pa-delete-confirm
          >
            {busy ? <SyncedSpinner small /> : null}
            {t("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
