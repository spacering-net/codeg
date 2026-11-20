import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  resetModelProvidersStore,
  useModelProviders,
} from "./use-model-providers"
import type { ModelProviderRecord } from "@/lib/model-provider-types"

const mockList = vi.fn()
let mockEventHandler: (() => void) | null = null

vi.mock("@/lib/transport-model-provider-service", () => ({
  createTransportModelProviderService: () => ({ list: mockList }),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((_event: string, handler: () => void) => {
    mockEventHandler = handler
    return Promise.resolve(() => {
      mockEventHandler = null
    })
  }),
  onTransportReconnect: vi.fn(() => null),
}))

function record(providerId: string): ModelProviderRecord {
  return {
    providerId,
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
    enabled: true,
    apiKeyMasked: "",
    hasApiKey: true,
    compatSupportsDeveloperRole: null,
    models: [{ id: `${providerId}-m1`, reasoning: false, input: "text" }],
  }
}

beforeEach(() => {
  mockList.mockReset()
  mockEventHandler = null
  resetModelProvidersStore()
})
afterEach(() => {
  resetModelProvidersStore()
})

describe("useModelProviders — shared subscription", () => {
  it("loads the catalog and refreshes when the backend emits an update", async () => {
    mockList.mockResolvedValue([record("provider-a")])

    const { result } = renderHook(() => useModelProviders())
    await waitFor(() =>
      expect(result.current.records).toEqual([record("provider-a")])
    )
    expect(result.current.fresh).toBe(true)
    expect(mockList).toHaveBeenCalledTimes(1)

    // A models.json write (edit in Settings) fires the event; the shared store
    // refetches so the conversation picker sees the new catalog immediately.
    mockList.mockResolvedValue([record("provider-a"), record("provider-b")])
    await act(async () => {
      mockEventHandler?.()
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(result.current.records).toEqual([
        record("provider-a"),
        record("provider-b"),
      ])
    )
    expect(mockList).toHaveBeenCalledTimes(2)
  })

  it("keeps the last good catalog when a reload fails", async () => {
    mockList.mockResolvedValue([record("provider-a")])
    const { result } = renderHook(() => useModelProviders())
    await waitFor(() => expect(result.current.records).not.toBeNull())

    mockList.mockRejectedValueOnce(new Error("offline"))
    await act(async () => {
      mockEventHandler?.()
      await Promise.resolve()
    })

    expect(result.current.records).toEqual([record("provider-a")])
  })
})
