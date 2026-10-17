"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getActiveRemoteConnectionId, getTransport } from "@/lib/transport"
import { subscribe } from "@/lib/platform"
import type { AgentType } from "@/lib/types"
import type { IsolatableFamily } from "@/lib/subscription-quota"

export interface QuotaAccount {
  agentType: AgentType
  agentAccountId: string | null
  family: IsolatableFamily
  name: string | null
}
export interface QuotaRead extends QuotaAccount {
  payload: unknown
  checkedAt: number
}
export interface QuotaRequest {
  agentType: AgentType
  agentAccountId?: string | null
  conversationId?: number | null
}

export function listQuotaAccounts(): Promise<QuotaAccount[]> {
  return getTransport().call("subscription_quota_accounts")
}

export function useSubscriptionQuota({
  agentType,
  agentAccountId = null,
  conversationId = null,
}: QuotaRequest) {
  const remote = getActiveRemoteConnectionId()
  const key = JSON.stringify([
    remote,
    agentType,
    agentAccountId,
    conversationId,
  ])
  const generation = useRef(0)
  const [state, setState] = useState<{
    key: string
    data: QuotaRead | null
    loading: boolean
  } | null>(null)
  const refresh = useCallback(async () => {
    const id = ++generation.current
    setState((previous) => ({
      key,
      data: previous?.key === key ? previous.data : null,
      loading: true,
    }))
    try {
      const data = await getTransport().call<QuotaRead>(
        "subscription_quota_read",
        {
          request: { agentType, agentAccountId, conversationId },
        }
      )
      if (id === generation.current) setState({ key, data, loading: false })
    } catch {
      if (id === generation.current)
        setState({ key, data: null, loading: false })
    }
  }, [key, agentType, agentAccountId, conversationId])

  useEffect(() => {
    let active = true
    const check = () => {
      if (active && document.visibilityState !== "hidden") void refresh()
    }
    void Promise.resolve().then(check)
    const timer = setInterval(check, 60_000)
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", check)
    const stop = subscribe("app://acp-agents-updated", check).catch(
      () => () => {}
    )
    return () => {
      active = false
      // This is a request sequence, not a DOM ref. Invalidate every pending read.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      clearInterval(timer)
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", check)
      void stop.then((unsubscribe) => unsubscribe())
    }
  }, [refresh])

  const current = state?.key === key ? state : null
  return {
    data: current?.data ?? null,
    loading: current?.loading ?? true,
    refresh,
  }
}
