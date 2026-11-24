"use client"

/**
 * The one way the settings view writes: item by item
 * (`personalAgentSettingsPatch`), so two windows changing different items
 * both keep theirs.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { personalAgentSettingsPatch } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  PersonalAgentApplied,
  PersonalAgentSettingChange,
} from "@/lib/types"

/**
 * Write settings item by item for assistant `bot`. Resolves to what changed,
 * or `null` when the write was refused (and says why).
 */
export function useSettingsPatch(bot: number | null) {
  const t = useTranslations("PersonalAgent.settings")
  const [busy, setBusy] = useState<string | null>(null)
  const patch = useCallback(
    async (
      changes: PersonalAgentSettingChange[]
    ): Promise<PersonalAgentApplied[] | null> => {
      if (changes.length === 0) return []
      setBusy(changes[0].key)
      try {
        return await personalAgentSettingsPatch(changes, bot)
      } catch (e) {
        toast.error(t("saveFailed"), { description: toErrorMessage(e) })
        return null
      } finally {
        setBusy(null)
      }
    },
    [bot, t]
  )
  return { patch, busy }
}
