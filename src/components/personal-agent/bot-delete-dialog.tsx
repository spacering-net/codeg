"use client"

/**
 * Deleting a work assistant (4.14): the confirmation says what it touches —
 * its running work (handed to the primary to follow, by default, or
 * stopped), the messages it has not answered (they go back to their
 * senders), its executor config (kept unless ticked), its place in the
 * division (back to auto) and its working directory (kept unless ticked).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
}: {
  /** The work assistant to delete; `null` closes it. */
  botId: number | null
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("PersonalAgent.bots.delete")
  const tk = useTranslations("PersonalAgent.settings.division")
  const viewBot = usePersonalAgentUi((s) => s.viewBot)
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const [impact, setImpact] = useState<BotImpact | null>(null)
  const [handOver, setHandOver] = useState(true)
  const [dropExecutor, setDropExecutor] = useState(false)
  const [dropWorkdir, setDropWorkdir] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setImpact(null)
    setHandOver(true)
    setDropExecutor(false)
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
        delete_executor: dropExecutor,
        delete_workdir: dropWorkdir,
      })
      if (viewBot === botId) setViewBot(null)
      onOpenChange(false)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const shared = (impact?.executor?.shared_with.length ?? 0) > 0
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
          <div className="flex flex-col gap-3 text-sm">
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
            {impact.division.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("division", {
                  kinds: impact.division
                    .map((k) => tk(k as "code"))
                    .join(t("listJoiner")),
                })}
              </p>
            ) : null}
            {impact.executor ? (
              <Label className="flex items-start gap-2 font-normal">
                <Checkbox
                  checked={dropExecutor}
                  disabled={shared}
                  onCheckedChange={(v) => setDropExecutor(v === true)}
                  className="mt-0.5"
                />
                <span>
                  {t("dropExecutor", { name: impact.executor.name })}
                  <span className="block text-xs text-muted-foreground">
                    {shared
                      ? t("executorShared", {
                          names: impact.executor.shared_with.join(
                            t("listJoiner")
                          ),
                        })
                      : t("executorKept")}
                  </span>
                </span>
              </Label>
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
                <span className="block truncate font-mono text-xs text-muted-foreground">
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
          <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />
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
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
