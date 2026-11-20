import { beforeEach, describe, expect, it } from "vitest"

import {
  isRememberedAgentModelSelectionAvailable,
  loadRememberedAgentModelSelection,
  rememberAgentModelSelection,
} from "./remembered-agent-model-selection"
import type { ModelProviderRecord } from "@/lib/model-provider-types"

const AGENT_MODEL_SELECTION_KEY = "codeg:agent-model-selection:v1"

function recordsFixture(): ModelProviderRecord[] {
  return [
    {
      providerId: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      enabled: true,
      apiKeyMasked: "",
      hasApiKey: true,
      compatSupportsDeveloperRole: null,
      models: [
        {
          id: "claude-sonnet-4-5",
          reasoning: false,
          input: "text",
          contextWindow: "200000",
        },
        { id: "claude-opus-4-5", reasoning: true, input: "text-image" },
      ],
    },
    // Enabled but its API family is incompatible with claude_code.
    {
      providerId: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      apiKeyMasked: "",
      hasApiKey: true,
      compatSupportsDeveloperRole: null,
      models: [{ id: "gpt-5.1", reasoning: false, input: "text" }],
    },
    // Disabled — the disabled flag alone is enough to make it unavailable.
    {
      providerId: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      enabled: false,
      apiKeyMasked: "",
      hasApiKey: true,
      compatSupportsDeveloperRole: null,
      models: [{ id: "deepseek-chat", reasoning: false, input: "text" }],
    },
  ]
}

describe("remembered agent model selection", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips a per-agent selection", () => {
    expect(loadRememberedAgentModelSelection("claude_code")).toBeNull()

    rememberAgentModelSelection("claude_code", {
      providerId: "anthropic",
      modelId: "claude-opus-4-5",
    })

    expect(loadRememberedAgentModelSelection("claude_code")).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-4-5",
    })
  })

  it("keeps agents isolated and overwrites per agent", () => {
    rememberAgentModelSelection("claude_code", {
      providerId: "anthropic",
      modelId: "claude-opus-4-5",
    })
    rememberAgentModelSelection("codex", {
      providerId: "openai",
      modelId: "gpt-5.1",
    })
    rememberAgentModelSelection("claude_code", {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
    })

    expect(loadRememberedAgentModelSelection("claude_code")).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
    })
    expect(loadRememberedAgentModelSelection("codex")).toEqual({
      providerId: "openai",
      modelId: "gpt-5.1",
    })
    expect(loadRememberedAgentModelSelection("gemini")).toBeNull()
  })

  it("returns null when storage is corrupted or malformed", () => {
    localStorage.setItem(AGENT_MODEL_SELECTION_KEY, "not-json")
    expect(loadRememberedAgentModelSelection("claude_code")).toBeNull()

    localStorage.setItem(
      AGENT_MODEL_SELECTION_KEY,
      JSON.stringify({ claude_code: { providerId: "anthropic" } })
    )
    expect(loadRememberedAgentModelSelection("claude_code")).toBeNull()

    localStorage.setItem(AGENT_MODEL_SELECTION_KEY, JSON.stringify("nope"))
    expect(loadRememberedAgentModelSelection("claude_code")).toBeNull()
  })

  it("reports available only for enabled, compatible, still-present models", () => {
    const records = recordsFixture()

    expect(
      isRememberedAgentModelSelectionAvailable(
        "claude_code",
        { providerId: "anthropic", modelId: "claude-opus-4-5" },
        records
      )
    ).toBe(true)

    // Disabled provider.
    expect(
      isRememberedAgentModelSelectionAvailable(
        "claude_code",
        { providerId: "deepseek", modelId: "deepseek-chat" },
        records
      )
    ).toBe(false)

    // Model removed from the provider.
    expect(
      isRememberedAgentModelSelectionAvailable(
        "claude_code",
        { providerId: "anthropic", modelId: "ghost-model" },
        records
      )
    ).toBe(false)

    // Provider missing entirely.
    expect(
      isRememberedAgentModelSelectionAvailable(
        "claude_code",
        { providerId: "gone", modelId: "anything" },
        records
      )
    ).toBe(false)

    // API family incompatible with the agent.
    expect(
      isRememberedAgentModelSelectionAvailable(
        "claude_code",
        { providerId: "openai", modelId: "gpt-5.1" },
        records
      )
    ).toBe(false)

    // Empty catalog.
    expect(
      isRememberedAgentModelSelectionAvailable(
        "claude_code",
        { providerId: "anthropic", modelId: "claude-opus-4-5" },
        []
      )
    ).toBe(false)
  })
})
