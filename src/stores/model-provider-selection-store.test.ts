import { beforeEach, describe, expect, it } from "vitest"

import {
  clearModelProviderDraftSelection,
  getModelProviderDraftSelection,
  consumeModelProviderDraftSelection,
  isModelProviderRestoreSettled,
  markModelProviderRestoreSettled,
  resetModelProviderSelectionStore,
  setModelProviderDraftSelection,
} from "./model-provider-selection-store"

describe("model provider draft selection store", () => {
  beforeEach(() => {
    resetModelProviderSelectionStore()
  })

  it("keeps one draft selection per tab", () => {
    setModelProviderDraftSelection("tab-1", {
      providerId: "provider-a",
      modelId: "model-a",
    })
    setModelProviderDraftSelection("tab-2", {
      providerId: "provider-b",
      modelId: "model-b",
    })

    expect(getModelProviderDraftSelection("tab-1")).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    })
    expect(getModelProviderDraftSelection("tab-2")).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
    })
  })

  it("clears a tab without affecting other drafts", () => {
    setModelProviderDraftSelection("tab-1", {
      providerId: "provider-a",
      modelId: "model-a",
    })
    setModelProviderDraftSelection("tab-2", {
      providerId: "provider-b",
      modelId: "model-b",
    })

    clearModelProviderDraftSelection("tab-1")

    expect(getModelProviderDraftSelection("tab-1")).toBeNull()
    expect(getModelProviderDraftSelection("tab-2")).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
    })
  })

  it("marks restore keys settled without re-marking", () => {
    expect(isModelProviderRestoreSettled("tab-1:claude_code")).toBe(false)

    markModelProviderRestoreSettled("tab-1:claude_code")
    expect(isModelProviderRestoreSettled("tab-1:claude_code")).toBe(true)

    // Different key (agent switch) is independent.
    expect(isModelProviderRestoreSettled("tab-1:codex")).toBe(false)
    markModelProviderRestoreSettled("tab-1:codex")
    expect(isModelProviderRestoreSettled("tab-1:codex")).toBe(true)
  })

  it("reset clears drafts and restore markers", () => {
    setModelProviderDraftSelection("tab-1", {
      providerId: "provider-a",
      modelId: "model-a",
    })
    markModelProviderRestoreSettled("tab-1:claude_code")

    resetModelProviderSelectionStore()

    expect(getModelProviderDraftSelection("tab-1")).toBeNull()
    expect(isModelProviderRestoreSettled("tab-1:claude_code")).toBe(false)
  })

  it("consumes a draft exactly once", () => {
    setModelProviderDraftSelection("tab-1", {
      providerId: "provider-a",
      modelId: "model-a",
    })

    expect(consumeModelProviderDraftSelection("tab-1")).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    })
    expect(consumeModelProviderDraftSelection("tab-1")).toBeNull()
    expect(getModelProviderDraftSelection("tab-1")).toBeNull()
  })
})
