"use client"

/** [Ignore] on a row waiting on the owner: the row as it stands let go of —
 *  out of the list at once (7.4), out of every list and count once the
 *  server keeps it, and back only when it moves on (stuck again, a new
 *  question). Back at once if it could not be kept. */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { EyeOff } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { personalAgentActivityDismiss } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { ActivityRow } from "@/lib/types"
import {
  leaveRow,
  returnRow,
  rowsCool,
} from "@/stores/personal-agent-activity-leaving-store"
import { refreshActivity } from "@/stores/personal-agent-activity-store"

import type { RowScope } from "./work-cards"

export function DismissButton({
  row,
  scope,
  group,
}: {
  row: ActivityRow
  scope: RowScope
  group: string
}) {
  const t = useTranslations("PersonalAgent.feed")
  const [busy, setBusy] = useState(false)
  const mark = row.dismiss
  if (scope.readOnly || scope.mode !== "v2" || !mark) return null
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      disabled={busy}
      title={t("ignoreHint")}
      aria-label={t("ignore")}
      data-pa-row-dismiss={row.key}
      onClick={(e) => {
        // The second click of one meant for a row that just left.
        if (rowsCool(e.detail)) return
        setBusy(true)
        const left = leaveRow(row.key, group, scope.list)
        personalAgentActivityDismiss(mark)
          .then(() => refreshActivity())
          .catch((err) => {
            returnRow(left)
            toast.error(toErrorMessage(err))
          })
          .finally(() => setBusy(false))
      }}
    >
      <EyeOff aria-hidden />
    </Button>
  )
}
