import { describe, expect, it } from "vitest"
import { recordToDraft } from "./model-provider-types"
import type { ModelProviderRecord } from "./model-provider-types"

describe("recordToDraft", () => {
  it("preserves the saved developer role compatibility setting", () => {
    const record: ModelProviderRecord = {
      providerId: "ark",
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      enabled: true,
      models: [],
      apiKeyMasked: "ark-•••••••key",
      hasApiKey: true,
      compatSupportsDeveloperRole: false,
    }

    expect(recordToDraft(record).compatSupportsDeveloperRole).toBe(false)
  })
})
