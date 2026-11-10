"use client"

/**
 * The data the settings view reads, and the one way it writes: item by item
 * (`personalAgentSettingsPatch`), so two windows changing different items
 * both keep theirs. Everything re-reads when the engine says an assistant
 * changed, or the executor configs did.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { usePersonalAgent } from "@/contexts/personal-agent-context"
import {
  personalAgentExecutors,
  personalAgentGet,
  personalAgentSettingsPatch,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { subscribe } from "@/lib/platform"
import {
  PERSONAL_AGENT_CHANGED_EVENT,
  type ExecutorView,
  type PersonalAgentApplied,
  type PersonalAgentBotSummary,
  type PersonalAgentChange,
  type PersonalAgentSettingChange,
  type PersonalAgentSnapshot,
} from "@/lib/types"
import { useAssistantsStore } from "@/stores/assistants-store"
import { useRoster } from "@/stores/personal-agent-roster-store"

/** Call `onChange` whenever the engine says an assistant changed. */
function usePersonalAgentChanges(
  onChange: (change: PersonalAgentChange) => void
) {
  const ref = useRef(onChange)
  useEffect(() => {
    ref.current = onChange
  })
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe<PersonalAgentChange>(PERSONAL_AGENT_CHANGED_EVENT, (c) =>
      ref.current(c)
    ).then((dispose) => {
      if (cancelled) dispose()
      else unsub = dispose
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])
}

/**
 * The snapshot of the assistant the settings are about: the page's own
 * (from its store), or — a work assistant picked in the team's list — its
 * own, read here and again whenever it changes. Only ever the snapshot of
 * the assistant asked for: while another's is still loading (or failed to),
 * there is none, so nothing is shown — or saved — as the wrong assistant.
 */
export function useTargetSnapshot(bot: number | null): {
  snapshot: PersonalAgentSnapshot | null
  /** A work assistant's could not be read. */
  failed: boolean
  reload: () => void
} {
  const { snapshot: own, refresh } = usePersonalAgent()
  const [other, setOther] = useState<{
    bot: number
    snapshot: PersonalAgentSnapshot | null
    failed: boolean
  } | null>(null)
  const seq = useRef(0)
  const reload = useCallback(() => {
    if (bot == null) {
      void refresh()
      return
    }
    const id = ++seq.current
    personalAgentGet(bot)
      .then((s) => {
        if (id === seq.current) setOther({ bot, snapshot: s, failed: false })
      })
      .catch(() => {
        if (id !== seq.current) return
        // A read that failed keeps what this assistant had, never another's.
        setOther((held) =>
          held?.bot === bot
            ? { ...held, failed: held.snapshot == null }
            : { bot, snapshot: null, failed: true }
        )
      })
  }, [bot, refresh])
  useEffect(() => {
    if (bot != null) reload()
  }, [bot, reload])
  usePersonalAgentChanges((c) => {
    if (bot == null || c.bot_id !== bot) return
    if (c.kind === "agent" || c.kind === "status") reload()
  })
  if (bot == null) return { snapshot: own, failed: false, reload }
  const mine = other?.bot === bot ? other : null
  // The snapshot must also be the assistant's own (an id that names
  // another, or none, is not it).
  const snapshot =
    mine?.snapshot && mine.snapshot.agent?.id === bot ? mine.snapshot : null
  return { snapshot, failed: mine?.failed ?? false, reload }
}

/** The owner's assistants, kept up to date: the roster's (one read and one
 *  subscription for the whole window). */
export function useBots(): PersonalAgentBotSummary[] | null {
  return useRoster()
}

/** The executor configs as the assistants use them, by id; read again when
 *  an executor config or an assistant changes, or work moves. */
export function useExecutors(): ReadonlyMap<number, ExecutorView> {
  const [views, setViews] = useState<ReadonlyMap<number, ExecutorView>>(
    () => new Map()
  )
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const load = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      personalAgentExecutors()
        .then((list) => setViews(new Map(list.map((v) => [v.assistant_id, v]))))
        .catch(() => {})
    }, 120)
  }, [])
  useEffect(() => {
    load()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load])
  const revision = useAssistantsStore((s) => s.byId)
  useEffect(load, [revision, load])
  usePersonalAgentChanges((c) => {
    if (c.kind === "agent" || c.kind === "dispatch" || c.kind === "status") {
      load()
    }
  })
  return views
}

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
