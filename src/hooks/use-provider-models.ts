"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { listProviderModels } from "@/lib/api"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import type {
  ListedProviderModel,
  ProviderModelList,
  ProviderModelsKeyHeader,
  ProviderModelsKeySource,
  ProviderModelsProtocol,
  ProviderModelsRequest,
} from "@/lib/types"

/** What a settings form knows about the provider it would list. */
export interface ProviderModelsInput {
  protocol: ProviderModelsProtocol
  baseUrl: string
  /** The key as typed; blank falls back to the saved provider's key. */
  apiKey?: string | null
  /** A saved provider whose stored key lists its models. */
  providerId?: number | null
  /** Where a key kept out of the form is, when none is typed. */
  storedKey?: ProviderModelsKeySource | null
  keyHeader?: ProviderModelsKeyHeader | null
}

/** Why there is nothing to fetch yet. */
export type ProviderModelsMissing = "baseUrl" | "apiKey"

/** A failed fetch: `code` is a `ProviderModels.errors` key when known. */
export interface ProviderModelsError {
  code: string
  message: string
  params: Record<string, string>
}

const ERROR_NAMESPACE = "providerModels."

export function parseProviderModelsError(error: unknown): ProviderModelsError {
  const appError = extractAppCommandError(error)
  const key = appError?.i18n_key
  return {
    code: key?.startsWith(ERROR_NAMESPACE)
      ? key.slice(ERROR_NAMESPACE.length)
      : "unknown",
    message: appError?.message ?? toErrorMessage(error),
    params: appError?.i18n_params ?? {},
  }
}

/** The request a form's fields make, or what is missing for one. */
export function providerModelsRequest(input: ProviderModelsInput | null): {
  request: ProviderModelsRequest | null
  missing: ProviderModelsMissing | null
} {
  if (!input) return { request: null, missing: null }
  const baseUrl = input.baseUrl.trim()
  if (!baseUrl) return { request: null, missing: "baseUrl" }
  const apiKey = input.apiKey?.trim() ?? ""
  const keySource: ProviderModelsKeySource | null =
    input.providerId != null
      ? { kind: "provider", providerId: input.providerId, apiKey }
      : apiKey
        ? { kind: "inline", apiKey }
        : (input.storedKey ?? null)
  if (!keySource) return { request: null, missing: "apiKey" }
  return {
    request: {
      protocol: input.protocol,
      baseUrl,
      keySource,
      keyHeader: input.keyHeader ?? null,
    },
    missing: null,
  }
}

/** A provider's models for a form: fetched on demand, and only ever shown for
 *  the URL and key they were fetched with — an edit to either drops them, and
 *  an answer to an older request (or one arriving after the form went away)
 *  is ignored. */
export function useProviderModels(input: ProviderModelsInput | null) {
  // The fields, not the object's identity, decide the request.
  const asked = input != null
  const protocol = input?.protocol
  const baseUrl = input?.baseUrl
  const apiKey = input?.apiKey
  const providerId = input?.providerId
  const storedKey = input?.storedKey
  const storedKeyId = storedKey ? JSON.stringify(storedKey) : ""
  const keyHeader = input?.keyHeader
  const { request, missing } = useMemo(
    () =>
      providerModelsRequest(
        asked && protocol
          ? {
              protocol,
              baseUrl: baseUrl ?? "",
              apiKey,
              providerId,
              storedKey,
              keyHeader,
            }
          : null
      ),
    // `storedKeyId` stands for `storedKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asked, protocol, baseUrl, apiKey, providerId, storedKeyId, keyHeader]
  )
  const key = request ? JSON.stringify(request) : ""

  const [result, setResult] = useState<{
    key: string
    list: ProviderModelList
  } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    error: ProviderModelsError
  } | null>(null)
  const [fetching, setFetching] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    seq.current += 1
    setFetching(false)
  }, [key])
  useEffect(
    () => () => {
      seq.current += 1
    },
    []
  )

  const fetchNow = useCallback(async (): Promise<ProviderModelList | null> => {
    if (!request) return null
    const mine = ++seq.current
    setFetching(true)
    setFailure(null)
    try {
      const list = await listProviderModels(request)
      if (mine !== seq.current) return null
      setResult({ key, list })
      return list
    } catch (e) {
      if (mine !== seq.current) return null
      setFailure({ key, error: parseProviderModelsError(e) })
      return null
    } finally {
      if (mine === seq.current) setFetching(false)
    }
  }, [request, key])

  const list = result && key && result.key === key ? result.list : null
  return {
    request,
    missing,
    list,
    models: list?.models ?? EMPTY,
    fetching,
    error: failure && key && failure.key === key ? failure.error : null,
    fetchNow,
  }
}

const EMPTY: ListedProviderModel[] = []

export type ProviderModelsState = ReturnType<typeof useProviderModels>
