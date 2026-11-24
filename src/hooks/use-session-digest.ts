"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { sessionBriefRead, sessionDigestAction } from "@/lib/api"
import { getTransport } from "@/lib/transport"
import type {
  DigestAnswerClaim,
  SessionBrief,
  SessionDigest,
} from "@/lib/session-digest"

/**
 * The answer path needs the conversation's composer (optimistic bubble,
 * lifecycle send, queue guards), which lives in the detail panel. Each panel
 * registers its sender while mounted; the digest UI answers the conversation
 * whose sender is registered, and reports the answer as unsent when nobody
 * registered (panel closed) or the send declined.
 */
type DigestSender = (text: string, clientMessageId: string) => Promise<boolean>
const digestSenders = new Map<number, DigestSender>()

export function registerDigestSender(id: number, sender: DigestSender | null) {
  if (sender) digestSenders.set(id, sender)
  else digestSenders.delete(id)
}

/** The reserve → send → release flow behind the digest panel's buttons. */
export function useDigestActions(
  conversationId: number,
  digest: SessionDigest | null,
  refresh: () => Promise<void>
) {
  const t = useTranslations("SessionDigest")
  const answer = useCallback(
    async (questionId: string, option: string) => {
      if (!digest) return
      let token: string | undefined
      try {
        const claim = await sessionDigestAction<DigestAnswerClaim>(
          conversationId,
          {
            operation: "reserve",
            revision: digest.revision,
            questionId,
            option,
          }
        )
        token = claim.token
        const sender = digestSenders.get(conversationId)
        if (!sender || !(await sender(claim.text, claim.token)))
          throw new Error(t("sendFailed"))
      } catch (error) {
        if (token)
          await sessionDigestAction(conversationId, {
            operation: "release",
            token,
          }).catch(() => {})
        throw error
      } finally {
        await refresh()
      }
    },
    [conversationId, digest, refresh, t]
  )
  const dismiss = useCallback(
    async (title: string) => {
      if (!digest) return
      await sessionDigestAction(conversationId, {
        operation: "dismiss",
        revision: digest.revision,
        title,
      })
      await refresh()
    },
    [conversationId, digest, refresh]
  )
  return { answer, dismiss }
}

/**
 * The conversation's brief. Backend writes come from the agent's MCP tools
 * without a change event, so the copy refreshes on load, on transport
 * reconnect, and whenever that conversation's digest changes (an agent that
 * updated the digest just revised its bookkeeping too).
 */
export function useSessionBrief(conversationId: number | null) {
  const [snapshot, setSnapshot] = useState<{
    id: number
    brief: SessionBrief | null
  } | null>(null)
  useEffect(() => {
    if (conversationId == null || conversationId <= 0) return
    let active = true
    const load = () => {
      void sessionBriefRead(conversationId)
        .then((value) => {
          if (active) setSnapshot({ id: conversationId, brief: value })
        })
        .catch(() => {})
    }
    load()
    const subscriptions: (() => void)[] = []
    void getTransport()
      .subscribe<{ conversationId: number }>(
        "session-digest://changed",
        (p) => {
          if (p.conversationId === conversationId) load()
        }
      )
      .then((off) => (active ? subscriptions.push(off) : off()))
      .catch(() => {})
    const reconnect = getTransport().onReconnect?.(load)
    if (reconnect) subscriptions.push(reconnect)
    return () => {
      active = false
      subscriptions.forEach((off) => off())
    }
  }, [conversationId])
  return snapshot?.id === conversationId ? snapshot.brief : null
}

export function useSessionDigest(conversationId: number | null) {
  const gate = useRef({ id: conversationId, enabled: true, epoch: 0 })
  const [snapshot, setSnapshot] = useState<{
    id: number
    digest: SessionDigest | null
  } | null>(null)
  const refresh = useCallback(async () => {
    if (
      conversationId == null ||
      conversationId <= 0 ||
      gate.current.id !== conversationId ||
      !gate.current.enabled
    )
      return
    const epoch = gate.current.epoch
    const digest = await sessionDigestAction<SessionDigest | null>(
      conversationId,
      { operation: "read" }
    )
    if (
      gate.current.id !== conversationId ||
      gate.current.epoch !== epoch ||
      !gate.current.enabled
    )
      return
    setSnapshot((old) =>
      old?.id === conversationId &&
      old.digest &&
      digest &&
      old.digest.revision > digest.revision
        ? old
        : { id: conversationId, digest }
    )
  }, [conversationId])
  useEffect(() => {
    if (conversationId == null || conversationId <= 0) return
    gate.current = {
      id: conversationId,
      enabled: true,
      epoch: gate.current.epoch + 1,
    }
    let active = true
    const transport = getTransport()
    const subscriptions: (() => void)[] = []
    const accept = (payload: {
      conversationId: number
      digest: SessionDigest | null
    }) => {
      if (
        active &&
        gate.current.enabled &&
        payload.conversationId === conversationId
      ) {
        setSnapshot((old) =>
          old?.id === conversationId &&
          old.digest &&
          payload.digest &&
          old.digest.revision > payload.digest.revision
            ? old
            : { id: conversationId, digest: payload.digest }
        )
      }
    }
    void transport
      .subscribe("session-digest://changed", accept)
      .then((off) => (active ? subscriptions.push(off) : off()))
      .catch(() => {})
    void transport
      .subscribe<{ session_messaging_enabled: boolean }>(
        "delegation-settings://changed",
        (settings) => {
          gate.current.enabled = settings.session_messaging_enabled
          gate.current.epoch += 1
          if (!settings.session_messaging_enabled)
            setSnapshot({ id: conversationId, digest: null })
          else void refresh().catch(() => {})
        }
      )
      .then((off) => (active ? subscriptions.push(off) : off()))
      .catch(() => {})
    const reconnect = transport.onReconnect?.(() => {
      void refresh().catch(() => {})
    })
    if (reconnect) subscriptions.push(reconnect)
    void refresh().catch(() => {})
    return () => {
      gate.current.epoch += 1
      active = false
      subscriptions.forEach((off) => off())
    }
  }, [conversationId, refresh])
  return {
    digest: snapshot?.id === conversationId ? snapshot.digest : null,
    refresh,
  }
}
