"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { getAgentLabel } from "@/lib/custom-agents"
import type { VoiceModePrefs } from "@/lib/speech-prefs"
import {
  type SessionEvent,
  watchWorkspaceSessions,
} from "@/lib/voice-mode/session-watch"
import {
  getVoiceModeState,
  subscribeVoiceMode,
} from "@/lib/voice-mode/voice-mode-store"

const REPEAT_WINDOW_MS = 10_000
const TITLE_MAX = 60

function shortTitle(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title
}

export function VoiceAnnouncer({
  announce,
  speak,
}: {
  announce: VoiceModePrefs["announce"]
  speak: (text: string) => void
}) {
  const t = useTranslations("VoiceMode.announce")
  const speakRef = useRef(speak)
  const tRef = useRef(t)
  useEffect(() => {
    speakRef.current = speak
    tRef.current = t
  })

  useEffect(() => {
    if (announce === "off") return
    let queue: string[] = []
    let watching: (() => void) | null = null
    const lastSaid = new Map<string, number>()

    const flush = () => {
      if (getVoiceModeState().phase !== "listening") return
      const next = queue.shift()
      if (next) speakRef.current(next)
    }

    const onEvents = (events: SessionEvent[]) => {
      const now = Date.now()
      for (const event of events) {
        const key = `${event.connectionId}:${event.kind}`
        const last = lastSaid.get(key)
        if (last !== undefined && now - last < REPEAT_WINDOW_MS) continue
        lastSaid.set(key, now)
        queue.push(
          tRef.current(event.kind, {
            agent: getAgentLabel(event.agentType),
            title: shortTitle(event.title),
          })
        )
      }
      flush()
    }

    const sync = () => {
      const { phase, assistant } = getVoiceModeState()
      if (phase === "off") {
        watching?.()
        watching = null
        queue = []
        lastSaid.clear()
        return
      }
      if (!watching && assistant) {
        watching = watchWorkspaceSessions(
          onEvents,
          () => getVoiceModeState().assistant?.connectionId ?? null
        )
      }
      flush()
    }

    const unsubscribe = subscribeVoiceMode(sync)
    sync()
    return () => {
      unsubscribe()
      watching?.()
    }
  }, [announce])

  return null
}
