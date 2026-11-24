"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { sessionDigestAction } from "@/lib/api"
import { getTransport } from "@/lib/transport"
import type { SessionDigest } from "@/lib/session-digest"

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
