import { beforeEach, describe, expect, it } from "vitest"

import { createMockModelProviderService } from "./model-provider-mock"
import { emptyProviderDraft } from "@/lib/model-provider-types"

describe("createMockModelProviderService", () => {
  let service: ReturnType<typeof createMockModelProviderService>

  beforeEach(() => {
    service = createMockModelProviderService()
  })

  it("lists the seeded providers with masked keys", async () => {
    const rows = await service.list()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.providerId)).toEqual([
      "deepseek",
      "openrouter",
      "local-vllm",
    ])
    expect(rows[0].apiKeyMasked).toContain("\u2022")
    expect(rows[0].apiKeyMasked).not.toContain("sk-demo-deepseek-0123456789")
    expect(rows[0].hasApiKey).toBe(true)
    expect(rows[2].hasApiKey).toBe(false)
  })

  it("creates a provider and rejects a duplicate id", async () => {
    const draft = emptyProviderDraft()
    draft.providerId = "my-gateway"
    draft.baseUrl = "https://gw.example.com/v1"
    draft.apiKey = "sk-new"
    draft.models = [{ id: "m1", reasoning: false, input: "text" }]

    const { record } = await service.create(draft)
    expect(record.providerId).toBe("my-gateway")
    expect(record.hasApiKey).toBe(true)

    await expect(service.create(draft)).rejects.toThrow(/already exists/)
  })

  it("keeps the existing key when updating with a blank apiKey", async () => {
    const draft = emptyProviderDraft()
    draft.providerId = "renamed"
    draft.originalId = "deepseek"
    draft.apiKey = ""
    draft.baseUrl = "https://api.deepseek.com/v1"
    draft.models = [{ id: "deepseek-chat", reasoning: false, input: "text" }]

    const { record } = await service.update(draft)
    expect(record.providerId).toBe("renamed")
    expect(record.hasApiKey).toBe(true)
    expect(record.apiKeyMasked).not.toBe("")
  })

  it("rejects a rename onto an existing id", async () => {
    const draft = emptyProviderDraft()
    draft.providerId = "local-vllm"
    draft.originalId = "deepseek"
    draft.baseUrl = "https://api.deepseek.com/v1"
    draft.models = [{ id: "deepseek-chat", reasoning: false, input: "text" }]

    await expect(service.update(draft)).rejects.toThrow(/already exists/)
  })

  it("deletes a provider without checking agent bindings", async () => {
    await service.remove("deepseek")
    expect(
      (await service.list()).some((r) => r.providerId === "deepseek")
    ).toBe(false)
  })

  it("deletes an unbound provider", async () => {
    const draft = emptyProviderDraft()
    draft.providerId = "temp"
    draft.baseUrl = "https://x/v1"
    draft.models = [{ id: "m", reasoning: false, input: "text" }]
    await service.create(draft)
    await service.remove("temp")
    expect((await service.list()).some((r) => r.providerId === "temp")).toBe(
      false
    )
  })

  it("enables/disables and reorders", async () => {
    await service.setEnabled("local-vllm", true)
    const rows = await service.list()
    expect(rows.find((r) => r.providerId === "local-vllm")?.enabled).toBe(true)

    await service.reorder(["local-vllm", "deepseek", "openrouter"])
    const reordered = await service.list()
    expect(reordered.map((r) => r.providerId)).toEqual([
      "local-vllm",
      "deepseek",
      "openrouter",
    ])
  })

  it("probes canned models and surfaces failures", async () => {
    const ok = await service.probe({
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.models.map((m) => m.id)).toContain("gpt-5.1")

    const fail = await service.probe({
      baseUrl: "https://fail.example/v1",
      api: "openai-completions",
    })
    expect(fail.ok).toBe(false)
  })

  it("tests a saved provider and a keyed draft", async () => {
    const saved = await service.test("deepseek", "deepseek-chat")
    expect(saved.ok).toBe(true)
    if (saved.ok) expect(saved.reply).toContain("pong")

    const draft = await service.test("not-saved", "m1", "sk-typed")
    expect(draft.ok).toBe(true)

    const noKey = await service.test("not-saved", "m1")
    expect(noKey.ok).toBe(false)
  })

  it("clones a built-in with a blank key and a unique id", async () => {
    const builtins = await service.listBuiltins()
    expect(builtins.find((b) => b.id === "deepseek")?.configured).toBe(true)
    expect(builtins.find((b) => b.id === "anthropic")?.configured).toBe(false)

    const draft = await service.cloneBuiltin("anthropic")
    expect(draft.providerId).toBe("anthropic-2")
    expect(draft.originalId).toBe("")
    expect(draft.apiKey).toBe("")
    expect(draft.models.length).toBeGreaterThan(0)
    expect(draft.baseUrl).toContain("api.anthropic.com")
  })
})
