import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  KIMI_DEFAULT_MAX_CONTEXT,
  KIMI_INTERFACE_TYPES,
  KimiCodeConfigPanel,
  kimiBaseUrlForRegion,
  kimiConfigSummary,
  kimiDraftEquals,
  kimiDraftFromConfig,
  kimiEndpointRegionFromBaseUrl,
  kimiInitialMode,
  kimiInterfaceMeta,
  kimiMaxContextForModel,
  kimiOverridingEnvKeys,
  parseKimiManagedConfig,
  validateKimiDraft,
  type KimiDraft,
} from "./kimi-code-config-panel"
import { acpUpdateKimiCodeConfig, listProviderModels } from "@/lib/api"
import enMessages from "@/i18n/messages/en.json"
import type { AcpAgentInfo } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  acpUpdateKimiCodeConfig: vi.fn(),
  listProviderModels: vi.fn(),
}))

/** What `listProviderModels` answers for these ids. */
function listed(...ids: string[]) {
  return { url: "https://x/models", models: ids.map((id) => ({ id })) }
}

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { toast } from "sonner"

describe("kimiEndpointRegionFromBaseUrl", () => {
  it("maps Moonshot endpoints + empty to a region, others to custom", () => {
    expect(kimiEndpointRegionFromBaseUrl("")).toBe("international")
    expect(kimiEndpointRegionFromBaseUrl("https://api.moonshot.ai/v1")).toBe(
      "international"
    )
    expect(kimiEndpointRegionFromBaseUrl("https://api.moonshot.cn/v1")).toBe(
      "china"
    )
    expect(kimiEndpointRegionFromBaseUrl("https://api.deepseek.com/v1")).toBe(
      "custom"
    )
  })

  it("is case-insensitive", () => {
    expect(kimiEndpointRegionFromBaseUrl("HTTPS://API.MOONSHOT.CN/V1")).toBe(
      "china"
    )
  })
})

describe("kimiBaseUrlForRegion", () => {
  it("resolves each region to its endpoint, trimming a custom URL", () => {
    expect(kimiBaseUrlForRegion("international", "")).toBe(
      "https://api.moonshot.ai/v1"
    )
    expect(kimiBaseUrlForRegion("china", "")).toBe("https://api.moonshot.cn/v1")
    expect(kimiBaseUrlForRegion("custom", "  https://x/v1  ")).toBe(
      "https://x/v1"
    )
  })
})

describe("kimiInterfaceMeta + KIMI_INTERFACE_TYPES", () => {
  it("exposes all six interface types in order", () => {
    expect(KIMI_INTERFACE_TYPES.map((m) => m.value)).toEqual([
      "kimi",
      "openai",
      "openai_responses",
      "anthropic",
      "google-genai",
      "vertexai",
    ])
  })

  it("vertexai uses GCP ADC (no API key); kimi defaults to Moonshot", () => {
    expect(kimiInterfaceMeta("vertexai").usesApiKey).toBe(false)
    expect(kimiInterfaceMeta("kimi").defaultBaseUrl).toBe(
      "https://api.moonshot.ai/v1"
    )
  })

  it("only the OpenAI-compatible interfaces demand an explicit base URL", () => {
    // The Anthropic / Google SDKs have a usable built-in endpoint; an
    // OpenAI-compatible one does not, so a blank URL there is a dead config.
    expect(
      KIMI_INTERFACE_TYPES.filter((m) => m.requiresBaseUrl).map((m) => m.value)
    ).toEqual(["openai", "openai_responses"])
  })

  it("falls back to kimi for an unknown type", () => {
    // @ts-expect-error testing the runtime fallback for an out-of-range value
    expect(kimiInterfaceMeta("nope").value).toBe("kimi")
  })
})

describe("parseKimiManagedConfig", () => {
  it("returns an empty object for blank or invalid JSON", () => {
    expect(parseKimiManagedConfig(null)).toEqual({})
    expect(parseKimiManagedConfig("")).toEqual({})
    expect(parseKimiManagedConfig("{not json")).toEqual({})
  })

  it("parses a managed projection incl. gate-credential flags", () => {
    const cfg = parseKimiManagedConfig(
      JSON.stringify({
        interfaceType: "anthropic",
        key: "sk",
        hasManagedBlock: true,
        credentialPresent: true,
        credentialSynthetic: true,
      })
    )
    expect(cfg.interfaceType).toBe("anthropic")
    expect(cfg.key).toBe("sk")
    expect(cfg.hasManagedBlock).toBe(true)
    expect(cfg.credentialPresent).toBe(true)
    expect(cfg.credentialSynthetic).toBe(true)
  })
})

describe("kimiInitialMode", () => {
  it("prefers a managed block, then a real login, else the api-key form", () => {
    expect(kimiInitialMode({ hasManagedBlock: true })).toBe("apikey")
    // A real (non-synthetic) login → show login mode so we don't offer to
    // overwrite it.
    expect(
      kimiInitialMode({ credentialPresent: true, credentialSynthetic: false })
    ).toBe("login")
    // codeg's own synthetic gate token is not a "login" → default to api-key.
    expect(
      kimiInitialMode({ credentialPresent: true, credentialSynthetic: true })
    ).toBe("apikey")
    expect(kimiInitialMode({})).toBe("apikey")
  })
})

describe("kimiMaxContextForModel", () => {
  it("resolves the documented window for a known id, trimming input", () => {
    expect(kimiMaxContextForModel("k3")).toBe(1_048_576)
    expect(kimiMaxContextForModel("  kimi-for-coding  ")).toBe(262_144)
    expect(kimiMaxContextForModel("kimi-for-coding-highspeed")).toBe(262_144)
  })

  it("returns null rather than guessing for an unrecognized id", () => {
    // Open-platform ids don't overlap the documented managed ones, so a fuzzy
    // match would silently write a wrong window.
    expect(kimiMaxContextForModel("kimi-k2.7-code")).toBeNull()
    expect(kimiMaxContextForModel("")).toBeNull()
  })
})

describe("kimiDraftFromConfig", () => {
  it("materializes the backend's silent context fallback for a blank config", () => {
    const seeded = kimiDraftFromConfig({})
    // The backend substitutes this when the field is empty; showing it up front
    // means the number on screen is the number that gets written.
    expect(seeded.maxContext).toBe(String(KIMI_DEFAULT_MAX_CONTEXT))
    expect(seeded.mode).toBe("apikey")
    expect(seeded.interfaceType).toBe("kimi")
    expect(seeded.region).toBe("international")
    expect(seeded.model).toBe("")
  })

  it("round-trips a full projection", () => {
    expect(
      kimiDraftFromConfig({
        interfaceType: "openai",
        baseUrl: "https://api.deepseek.com/v1",
        key: "sk-x",
        authType: "env",
        modelId: "deepseek-chat",
        maxContextSize: 65_536,
        hasManagedBlock: true,
      })
    ).toMatchObject({
      mode: "apikey",
      interfaceType: "openai",
      region: "custom",
      baseUrl: "https://api.deepseek.com/v1",
      authType: "env",
      apiKey: "sk-x",
      model: "deepseek-chat",
      maxContext: "65536",
    })
  })

  it("is stable, so a freshly-seeded form is never reported as dirty", () => {
    const config = { interfaceType: "kimi" as const, modelId: "m" }
    expect(kimiDraftFromConfig(config)).toEqual(kimiDraftFromConfig(config))
  })
})

/** A valid api-key draft; individual tests override one field at a time. */
function draft(overrides: Partial<KimiDraft> = {}): KimiDraft {
  return {
    ...kimiDraftFromConfig({}),
    apiKey: "sk-test",
    model: "kimi-k2.7-code",
    ...overrides,
  }
}

describe("validateKimiDraft", () => {
  it("accepts the happy path (kimi + a region + key + model + context)", () => {
    expect(validateKimiDraft(draft())).toEqual({})
  })

  it("never reports errors in login mode — that form has no fields", () => {
    expect(
      validateKimiDraft(draft({ mode: "login", model: "", apiKey: "" }))
    ).toEqual({})
  })

  it("requires the model the backend rejects a save without", () => {
    expect(validateKimiDraft(draft({ model: "   " })).model).toBe(
      "errorModelRequired"
    )
  })

  it("requires a positive integer context window", () => {
    expect(validateKimiDraft(draft({ maxContext: "" })).maxContext).toBe(
      "errorMaxContextRequired"
    )
    // The old panel sent Number("abc") → NaN → null over the wire.
    expect(validateKimiDraft(draft({ maxContext: "abc" })).maxContext).toBe(
      "errorMaxContextInvalid"
    )
    expect(validateKimiDraft(draft({ maxContext: "0" })).maxContext).toBe(
      "errorMaxContextInvalid"
    )
    expect(validateKimiDraft(draft({ maxContext: "-5" })).maxContext).toBe(
      "errorMaxContextInvalid"
    )
    expect(validateKimiDraft(draft({ maxContext: "1.5" })).maxContext).toBe(
      "errorMaxContextInvalid"
    )
  })

  it("requires an API key for every key-based interface", () => {
    expect(validateKimiDraft(draft({ apiKey: " " })).apiKey).toBe(
      "errorApiKeyRequired"
    )
    expect(validateKimiDraft(draft({ apiKey: "sk\nx" })).apiKey).toBe(
      "errorApiKeyInvalid"
    )
  })

  it("swaps the key requirement for a GCP project on vertexai", () => {
    const vertex = draft({ interfaceType: "vertexai", apiKey: "" })
    expect(validateKimiDraft(vertex).apiKey).toBeUndefined()
    expect(validateKimiDraft(vertex).vertexProject).toBe(
      "errorVertexProjectRequired"
    )
    expect(
      validateKimiDraft({ ...vertex, vertexProject: "p" }).vertexProject
    ).toBeUndefined()
  })

  it("requires a URL for kimi's custom region and for OpenAI-compatible", () => {
    expect(
      validateKimiDraft(draft({ region: "custom", baseUrl: "" })).baseUrl
    ).toBe("errorBaseUrlRequired")
    expect(
      validateKimiDraft(draft({ interfaceType: "openai", baseUrl: "" })).baseUrl
    ).toBe("errorBaseUrlRequired")
  })

  it("leaves the URL optional where the provider SDK has a default", () => {
    expect(
      validateKimiDraft(draft({ interfaceType: "anthropic", baseUrl: "" }))
        .baseUrl
    ).toBeUndefined()
  })

  it("rejects a default level that is not among the offered ones", () => {
    // kimi silently clamps an unlisted default to the middle entry, so the
    // composer would open on a level the user never picked.
    expect(
      validateKimiDraft(
        draft({
          reasoningEnabled: true,
          supportEfforts: ["low", "high"],
          defaultEffort: "max",
        })
      ).defaultEffort
    ).toBe("errorDefaultEffortUnlisted")
    expect(
      validateKimiDraft(
        draft({
          reasoningEnabled: true,
          supportEfforts: ["low", "high"],
          defaultEffort: "high",
        })
      ).defaultEffort
    ).toBeUndefined()
  })

  it("ignores the default level while reasoning is off", () => {
    expect(
      validateKimiDraft(
        draft({
          reasoningEnabled: false,
          supportEfforts: [],
          defaultEffort: "max",
        })
      ).defaultEffort
    ).toBeUndefined()
  })

  it("rejects a URL without an http(s) scheme", () => {
    expect(
      validateKimiDraft(draft({ region: "custom", baseUrl: "api.example.com" }))
        .baseUrl
    ).toBe("errorBaseUrlInvalid")
    expect(
      validateKimiDraft(
        draft({ region: "custom", baseUrl: "http://localhost:8080/v1" })
      ).baseUrl
    ).toBeUndefined()
  })
})

describe("reasoning metadata in kimiDraftFromConfig", () => {
  it("reads reasoning as off when the model declares no capabilities", () => {
    // The shape the panel wrote before this feature. kimi treats an absent
    // capabilities array as "allow everything" AND advertises no Thinking
    // picker, so this must NOT read back as reasoning enabled.
    const seeded = kimiDraftFromConfig({ interfaceType: "kimi", modelId: "m" })
    expect(seeded.reasoningEnabled).toBe(false)
    expect(seeded.alwaysThinking).toBe(false)
    expect(seeded.supportEfforts).toEqual([])
    expect(seeded.defaultEffort).toBe("")
  })

  it("reads either thinking capability as enabled, and always_thinking too", () => {
    expect(
      kimiDraftFromConfig({ capabilities: ["thinking", "image_in"] })
    ).toMatchObject({ reasoningEnabled: true, alwaysThinking: false })
    expect(
      kimiDraftFromConfig({ capabilities: ["always_thinking"] })
    ).toMatchObject({ reasoningEnabled: true, alwaysThinking: true })
  })

  it("round-trips the effort list and default", () => {
    expect(
      kimiDraftFromConfig({
        capabilities: ["thinking"],
        supportEfforts: ["low", "high"],
        defaultEffort: "high",
      })
    ).toMatchObject({ supportEfforts: ["low", "high"], defaultEffort: "high" })
  })
})

describe("kimiDraftEquals", () => {
  it("compares the effort array by value, not by reference", () => {
    // A plain `!==` here would mark every freshly-seeded form as dirty, since
    // kimiDraftFromConfig builds a new array each call.
    const config = { capabilities: ["thinking"], supportEfforts: ["low"] }
    expect(
      kimiDraftEquals(kimiDraftFromConfig(config), kimiDraftFromConfig(config))
    ).toBe(true)
  })

  it("detects an added, removed or reordered level", () => {
    const base = kimiDraftFromConfig({ supportEfforts: ["low", "high"] })
    expect(kimiDraftEquals(base, { ...base, supportEfforts: ["low"] })).toBe(
      false
    )
    expect(
      kimiDraftEquals(base, { ...base, supportEfforts: ["high", "low"] })
    ).toBe(false)
  })
})

describe("kimiOverridingEnvKeys", () => {
  it("reports only the KIMI_MODEL_* keys that actually carry a value", () => {
    expect(
      kimiOverridingEnvKeys({
        KIMI_MODEL_API_KEY: "sk",
        KIMI_MODEL_NAME: "  ",
        OTHER: "x",
      })
    ).toEqual(["KIMI_MODEL_API_KEY"])
    expect(kimiOverridingEnvKeys({})).toEqual([])
  })
})

describe("kimiConfigSummary", () => {
  it("is null without a managed block, so nothing claims to be in effect", () => {
    expect(kimiConfigSummary({})).toBeNull()
    expect(
      kimiConfigSummary({ hasManagedBlock: false, modelId: "m" })
    ).toBeNull()
  })

  it("reads back provider, endpoint, model and window from the projection", () => {
    expect(
      kimiConfigSummary({
        hasManagedBlock: true,
        interfaceType: "kimi",
        baseUrl: "https://api.moonshot.cn/v1",
        modelId: "kimi-k2.7-code",
        maxContextSize: 262_144,
      })
    ).toBe(
      "Kimi / Moonshot · https://api.moonshot.cn/v1 · kimi-k2.7-code · 262144 tokens"
    )
  })

  it("spells out the fallback window when config.toml carries none", () => {
    expect(
      kimiConfigSummary({ hasManagedBlock: true, interfaceType: "kimi" })
    ).toBe("Kimi / Moonshot · 262144 tokens")
  })
})

/** A minimal Kimi AcpAgentInfo; only `config_json` / `env` carry meaning here. */
function makeAgent(
  configJson: string | null,
  env: Record<string, string> = {}
): AcpAgentInfo {
  return {
    agent_type: "kimi_code",
    skills_capable: true,
    registry_id: "kimi-code",
    registry_version: null,
    supports_custom_version: false,
    name: "Kimi Code",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: null,
    host_tools_agent_mode: false,
    env,
    config_json: configJson,
    config_file_path: "/home/u/.kimi-code/config.toml",
    codex_auth_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    cline_secrets_json: null,
    hermes_config_yaml: null,
    grok_config_toml: null,
    grok_settings: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
  }
}

function renderPanel(agent: AcpAgentInfo, onSaved = vi.fn()) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <KimiCodeConfigPanel agent={agent} onSaved={onSaved} />
    </NextIntlClientProvider>
  )
  /** Re-render with a fresh projection, as `onSaved → refreshAgents` does. */
  return (next: AcpAgentInfo) =>
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <KimiCodeConfigPanel agent={next} onSaved={onSaved} />
      </NextIntlClientProvider>
    )
}

const kimi = enMessages.AcpAgentSettings.kimiCode
const saveLabel = enMessages.AcpAgentSettings.actions.saveKimiCodeConfig
/** Labels carry a trailing "*" marker, so match on a prefix. */
const label = (text: string) => new RegExp(`^${text}`)

describe("KimiCodeConfigPanel", () => {
  beforeEach(() => {
    vi.mocked(acpUpdateKimiCodeConfig).mockReset().mockResolvedValue(0)
    vi.mocked(listProviderModels).mockReset().mockResolvedValue(listed())
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
  })

  it("pre-fills the required context window instead of leaving it blank", () => {
    renderPanel(makeAgent(null))
    expect(screen.getByLabelText(label(kimi.maxContextLabel))).toHaveValue(
      String(KIMI_DEFAULT_MAX_CONTEXT)
    )
  })

  it("reports an unconfigured agent rather than a seeded gate token", () => {
    // credentialPresent goes true after ANY save (codeg seeds the token), so
    // the status must key on the managed block, not on the token file.
    renderPanel(
      makeAgent(
        JSON.stringify({
          hasManagedBlock: false,
          credentialPresent: true,
          credentialSynthetic: true,
        })
      )
    )
    expect(screen.getByText(kimi.statusUnconfigured)).toBeInTheDocument()
  })

  it("reads the effective config back from disk once a block exists", () => {
    renderPanel(
      makeAgent(
        JSON.stringify({
          hasManagedBlock: true,
          interfaceType: "kimi",
          baseUrl: "https://api.moonshot.cn/v1",
          modelId: "kimi-k2.7-code",
          maxContextSize: 262144,
        })
      )
    )
    expect(screen.getByText(kimi.gateReadyApiKey)).toBeInTheDocument()
    expect(
      screen.getByText(
        /api\.moonshot\.cn\/v1 · kimi-k2\.7-code · 262144 tokens/
      )
    ).toBeInTheDocument()
  })

  it("blocks the save and shows an inline error when the model is blank", () => {
    renderPanel(makeAgent(null))

    fireEvent.click(screen.getByRole("button", { name: new RegExp(saveLabel) }))

    expect(acpUpdateKimiCodeConfig).not.toHaveBeenCalled()
    expect(screen.getByText(kimi.errorModelRequired)).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith(kimi.fixErrorsFirst)
  })

  it("sends the parsed context window once the form is valid", () => {
    renderPanel(makeAgent(null))

    fireEvent.change(screen.getByLabelText(label(kimi.apiKeyLabel)), {
      target: { value: "sk-abc" },
    })
    fireEvent.change(screen.getByLabelText(label(kimi.modelLabel)), {
      target: { value: "kimi-k2.7-code" },
    })
    fireEvent.click(screen.getByRole("button", { name: new RegExp(saveLabel) }))

    expect(acpUpdateKimiCodeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "apikey",
        interfaceType: "kimi",
        apiKey: "sk-abc",
        model: "kimi-k2.7-code",
        maxContextSize: KIMI_DEFAULT_MAX_CONTEXT,
      })
    )
  })

  it("auto-fills the documented window for a recognized model id", () => {
    renderPanel(makeAgent(null))
    fireEvent.change(screen.getByLabelText(label(kimi.modelLabel)), {
      target: { value: "k3" },
    })
    expect(screen.getByLabelText(label(kimi.maxContextLabel))).toHaveValue(
      "1048576"
    )
  })

  it("never overwrites a context window the user set by hand", () => {
    renderPanel(makeAgent(null))
    fireEvent.change(screen.getByLabelText(label(kimi.maxContextLabel)), {
      target: { value: "8192" },
    })
    fireEvent.change(screen.getByLabelText(label(kimi.modelLabel)), {
      target: { value: "k3" },
    })
    expect(screen.getByLabelText(label(kimi.maxContextLabel))).toHaveValue(
      "8192"
    )
  })

  it("flags unsaved edits so the form is never mistaken for the file", () => {
    renderPanel(
      makeAgent(
        JSON.stringify({
          hasManagedBlock: true,
          interfaceType: "kimi",
          modelId: "kimi-k2.7-code",
          maxContextSize: 262144,
        })
      )
    )
    expect(screen.queryByText(kimi.statusDirty)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(label(kimi.modelLabel)), {
      target: { value: "other-model" },
    })
    expect(screen.getByText(kimi.statusDirty)).toBeInTheDocument()
  })

  it("drops the 'key works' verdict once the credentials it measured change", async () => {
    vi.mocked(listProviderModels).mockResolvedValue(listed("kimi-k2.7-code"))
    renderPanel(makeAgent(null))

    fireEvent.change(screen.getByLabelText(label(kimi.apiKeyLabel)), {
      target: { value: "sk-good" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: enMessages.ProviderModels.choose })
    )
    await vi.waitFor(() => {
      expect(screen.getByText(/Key works/)).toBeInTheDocument()
    })

    // Editing the key invalidates the verdict — it must not keep vouching for
    // a credential that is no longer in the form.
    fireEvent.change(screen.getByLabelText(label(kimi.apiKeyLabel)), {
      target: { value: "sk-different" },
    })
    expect(screen.queryByText(/Key works/)).not.toBeInTheDocument()
  })

  it("tests each interface's key the way its SDK would send it", async () => {
    const cases = [
      {
        interfaceType: "kimi",
        protocol: "openai",
        baseUrl: "https://api.moonshot.ai/v1",
      },
      // A blank URL is the SDK's own default.
      {
        interfaceType: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
      },
      {
        interfaceType: "google-genai",
        protocol: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
      },
    ]
    for (const { interfaceType, protocol, baseUrl } of cases) {
      vi.mocked(listProviderModels).mockClear()
      const view = render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <KimiCodeConfigPanel
            agent={makeAgent(
              JSON.stringify({
                hasManagedBlock: true,
                interfaceType,
                key: "sk-test",
                modelId: "m",
              })
            )}
            onSaved={vi.fn()}
          />
        </NextIntlClientProvider>
      )
      fireEvent.click(
        screen.getByRole("button", { name: enMessages.ProviderModels.choose })
      )
      await vi.waitFor(() =>
        expect(listProviderModels).toHaveBeenCalledWith({
          protocol,
          baseUrl,
          keySource: { kind: "inline", apiKey: "sk-test" },
          keyHeader: null,
        })
      )
      view.unmount()
    }
  })

  it("says why the test failed, in the user's language", async () => {
    vi.mocked(listProviderModels).mockRejectedValue({
      code: "authentication_failed",
      message: "the key was rejected (HTTP 401)",
      i18n_key: "providerModels.unauthorized",
      i18n_params: { status: "401" },
    })
    renderPanel(makeAgent(null))
    fireEvent.change(screen.getByLabelText(label(kimi.apiKeyLabel)), {
      target: { value: "sk-bad" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: enMessages.ProviderModels.choose })
    )
    // In the status card's verdict, and in the list that was asked for.
    const reasons = await screen.findAllByText(
      /The key is invalid or has no permission \(HTTP 401\)\./
    )
    expect(reasons).toHaveLength(2)
    expect(
      reasons.some((el) =>
        el.textContent?.startsWith(`${kimi.fetchModelsFailed}:`)
      )
    ).toBe(true)
  })

  it("asks for a key before testing one", async () => {
    renderPanel(makeAgent(null))
    fireEvent.click(
      screen.getByRole("button", { name: enMessages.ProviderModels.choose })
    )
    expect(
      await screen.findByText(enMessages.ProviderModels.needKey)
    ).toBeVisible()
    expect(listProviderModels).not.toHaveBeenCalled()
  })

  it("fills the model, and its context window, from the listed models", async () => {
    vi.mocked(listProviderModels).mockResolvedValue({
      url: "https://x/models",
      models: [{ id: "kimi-k3-long", contextWindow: 524288 }],
    })
    renderPanel(makeAgent(null))
    fireEvent.change(screen.getByLabelText(label(kimi.apiKeyLabel)), {
      target: { value: "sk-good" },
    })
    // Opening the model's list asks the provider.
    fireEvent.click(
      screen.getByRole("button", { name: enMessages.ProviderModels.choose })
    )
    const option = await screen.findByRole("option", { name: /kimi-k3-long/ })
    fireEvent.click(within(option).getByText("kimi-k3-long"))
    expect(screen.getByLabelText(label(kimi.modelLabel))).toHaveValue(
      "kimi-k3-long"
    )
    expect(screen.getByLabelText(label(kimi.maxContextLabel))).toHaveValue(
      "524288"
    )
  })

  it("warns when the chosen model is absent from the key's model list", async () => {
    vi.mocked(listProviderModels).mockResolvedValue(listed("only-this-one"))
    renderPanel(makeAgent(null))

    fireEvent.change(screen.getByLabelText(label(kimi.apiKeyLabel)), {
      target: { value: "sk-good" },
    })
    fireEvent.change(screen.getByLabelText(label(kimi.modelLabel)), {
      target: { value: "kimi-k2.7-code" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: enMessages.ProviderModels.choose })
    )

    await vi.waitFor(() => {
      expect(screen.getByText(kimi.modelNotInList)).toBeInTheDocument()
    })
  })

  // Regression guard for the panel's headline bug: the previous version seeded
  // ten independent `useState(() => …)` initializers and carries no `key`, so a
  // refresh updated `agent.config_json` while the form kept rendering pre-save
  // values — most visibly after the raw config.toml editor rewrote the file.
  it("re-seeds the form when config.toml changes underneath it", () => {
    const rerender = renderPanel(
      makeAgent(
        JSON.stringify({
          hasManagedBlock: true,
          interfaceType: "kimi",
          modelId: "old-model",
          maxContextSize: 262144,
        })
      )
    )
    expect(screen.getByLabelText(label(kimi.modelLabel))).toHaveValue(
      "old-model"
    )

    rerender(
      makeAgent(
        JSON.stringify({
          hasManagedBlock: true,
          interfaceType: "kimi",
          modelId: "written-by-raw-editor",
          maxContextSize: 1048576,
        })
      )
    )

    expect(screen.getByLabelText(label(kimi.modelLabel))).toHaveValue(
      "written-by-raw-editor"
    )
    expect(screen.getByLabelText(label(kimi.maxContextLabel))).toHaveValue(
      "1048576"
    )
    // Re-seeded from disk, so the form is in sync again — not "unsaved".
    expect(screen.queryByText(kimi.statusDirty)).not.toBeInTheDocument()
  })

  it("keeps in-flight edits when a refresh reports the same config.toml", () => {
    const config = JSON.stringify({
      hasManagedBlock: true,
      interfaceType: "kimi",
      modelId: "m",
      maxContextSize: 262144,
    })
    const rerender = renderPanel(makeAgent(config))

    fireEvent.change(screen.getByLabelText(label(kimi.modelLabel)), {
      target: { value: "typing-in-progress" },
    })
    // An unrelated agent refresh re-renders with an identical projection; the
    // effect keys on the projection string, so it must not fire.
    rerender(makeAgent(config))

    expect(screen.getByLabelText(label(kimi.modelLabel))).toHaveValue(
      "typing-in-progress"
    )
  })

  it("keeps reasoning out of the payload until it is switched on", () => {
    // Off must send no levels, so the backend omits `capabilities` and kimi
    // keeps its permissive default (the pre-feature behaviour).
    renderPanel(makeAgent(null))
    fireEvent.change(screen.getByLabelText(label(kimi.apiKeyLabel)), {
      target: { value: "sk-abc" },
    })
    fireEvent.change(screen.getByLabelText(label(kimi.modelLabel)), {
      target: { value: "m" },
    })
    expect(
      screen.queryByRole("button", { name: "high" })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: new RegExp(saveLabel) }))
    expect(acpUpdateKimiCodeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEnabled: false, supportEfforts: [] })
    )
  })

  it("sends the chosen levels once reasoning is switched on", () => {
    renderPanel(makeAgent(null))
    fireEvent.change(screen.getByLabelText(label(kimi.apiKeyLabel)), {
      target: { value: "sk-abc" },
    })
    fireEvent.change(screen.getByLabelText(label(kimi.modelLabel)), {
      target: { value: "m" },
    })
    fireEvent.click(
      screen.getByRole("switch", {
        name: new RegExp(kimi.reasoningEnableLabel),
      })
    )

    fireEvent.click(screen.getByRole("button", { name: "low" }))
    fireEvent.click(screen.getByRole("button", { name: "high" }))
    fireEvent.click(screen.getByRole("button", { name: new RegExp(saveLabel) }))

    expect(acpUpdateKimiCodeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningEnabled: true,
        alwaysThinking: false,
        supportEfforts: ["low", "high"],
      })
    )
  })

  it("drops a default level when its chip is switched back off", () => {
    // Otherwise the saved default would name a level the composer no longer
    // offers, and kimi would silently clamp it to the middle entry.
    renderPanel(
      makeAgent(
        JSON.stringify({
          hasManagedBlock: true,
          interfaceType: "kimi",
          key: "sk-saved",
          modelId: "m",
          maxContextSize: 262144,
          capabilities: ["thinking"],
          supportEfforts: ["low", "high"],
          defaultEffort: "high",
        })
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "high" }))
    fireEvent.click(screen.getByRole("button", { name: new RegExp(saveLabel) }))

    expect(acpUpdateKimiCodeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ supportEfforts: ["low"], defaultEffort: "" })
    )
  })

  it("warns that a KIMI_MODEL_* override outranks whatever is saved here", () => {
    renderPanel(makeAgent(null, { KIMI_MODEL_API_KEY: "sk-stale" }))
    expect(screen.getByText(/KIMI_MODEL_API_KEY/)).toBeInTheDocument()
  })

  it("surfaces the backend's own message when a save is rejected", async () => {
    vi.mocked(acpUpdateKimiCodeConfig).mockRejectedValue(
      new Error("kimi native config requires a model id")
    )
    renderPanel(makeAgent(null))

    fireEvent.change(screen.getByLabelText(label(kimi.apiKeyLabel)), {
      target: { value: "sk-abc" },
    })
    fireEvent.change(screen.getByLabelText(label(kimi.modelLabel)), {
      target: { value: "m" },
    })
    fireEvent.click(screen.getByRole("button", { name: new RegExp(saveLabel) }))

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("kimi native config requires a model id")
      )
    })
  })
})
