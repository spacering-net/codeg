"use client"

/**
 * An assistant's face changed where it is shown — its own page's head, the
 * side panel's — saved at once: shown picked till it is read back, taken
 * back on a refusal.
 */

import { useState } from "react"
import { useLocale } from "next-intl"
import { toast } from "sonner"

import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentSave } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { BotAvatar as BotAvatarValue } from "@/lib/types"

/** A face picked here for assistant `whose`, shown till what is read
 *  back says otherwise — and only on that assistant's page. */
export function usePendingFace(
  whose: number | null,
  saved: BotAvatarValue | null
) {
  const [pending, setPending] = useState<{
    whose: number | null
    face: BotAvatarValue
    over: string
  } | null>(null)
  const savedKey = JSON.stringify(saved)
  // Another assistant shown, or read back as something else (what was
  // picked, or a face from elsewhere): what is read back stands.
  if (pending != null && (pending.whose !== whose || pending.over !== savedKey))
    setPending(null)
  const shown =
    pending != null && pending.whose === whose && pending.over === savedKey
      ? pending.face
      : saved
  return {
    shown,
    pick: (face: BotAvatarValue) => {
      const mine = { whose, face, over: savedKey }
      setPending(mine)
      return () => setPending((p) => (p === mine ? null : p))
    },
  }
}

/** Each assistant's face saves, whichever page picked them: one at a time,
 *  and only the last picked — a page closed and opened again meanwhile
 *  shares its queue. */
const faceSaves = new Map<string, { chain: Promise<unknown>; latest: number }>()

/** Save a face picked on the page: shown at once, taken back on a
 *  refusal. One save at a time per assistant, a pick overtaken by a later
 *  one before its turn never sent — each writes the whole face, so the
 *  last picked is the one that stays. */
export function useSaveFace(
  bot: number | null,
  pick: (face: BotAvatarValue) => () => void
) {
  const locale = useLocale()
  const { botId } = usePersonalAgent()
  return (face: BotAvatarValue) => {
    const undo = pick(face)
    const to = bot ?? botId
    const key = String(to ?? "primary")
    const q = faceSaves.get(key) ?? { chain: Promise.resolve(), latest: 0 }
    const mine = q.latest + 1
    q.latest = mine
    q.chain = q.chain.then(() => {
      if (q.latest !== mine) return
      return personalAgentSave({ avatar: face, locale }, to).catch((e) => {
        undo()
        toast.error(toErrorMessage(e))
      })
    })
    faceSaves.set(key, q)
  }
}
