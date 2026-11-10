/**
 * A configured OpenCode provider's model list, picked from the models the
 * provider itself lists: a model that stays keeps its entry, a new one is
 * `{name: id}`, an unpicked one goes. The provider's key stays in OpenCode's
 * credential store, so the listing is asked with it there, not with a key the
 * panel holds; and a block keeps the shape it was written in.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  acpListAgents,
  acpUpdateAgentConfig,
  listModelProviders,
  listProviderModels,
  opencodeListIntegrations,
} from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"

import { AcpAgentSettings } from "./acp-agent-settings"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  // Every function is stubbed so nothing here can reach the real transport;
  // the calls these tests don't need simply never settle.
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" ? vi.fn(() => new Promise(() => {})) : value,
    ])
  )
})
vi.mock("next/navigation", () => {
  const params = new URLSearchParams()
  return { useSearchParams: () => params }
})

const LEGACY_CONFIG = {
  provider: {
    relay: {
      npm: "@ai-sdk/openai-compatible",
      name: "Relay",
      options: { baseURL: "https://relay.test/v1" },
      models: {
        "glm-5.2": { name: "GLM", limit: { context: 128000, output: 8192 } },
        old: { name: "old" },
      },
    },
  },
}

const NATIVE_CONFIG = {
  providers: {
    relay: {
      package: "aisdk:@ai-sdk/openai-compatible",
      name: "Relay",
      settings: { baseURL: "https://relay.test/v1" },
      models: {
        "glm-5.2": { name: "GLM", limit: { context: 128000, output: 8192 } },
        old: { name: "old" },
      },
    },
  },
}

function openCodeAgent(config: unknown): AcpAgentInfo {
  return {
    agent_type: "open_code",
    skills_capable: true,
    registry_id: "opencode",
    registry_version: "2.2.0",
    supports_custom_version: false,
    name: "OpenCode",
    description: "",
    available: true,
    distribution_type: "binary",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: "2.2.0",
    host_tools_agent_mode: false,
    env: {},
    config_json: JSON.stringify(config),
    config_file_path: null,
    codex_auth_json: null,
    cline_secrets_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    grok_config_toml: null,
    grok_settings: null,
    hermes_config_yaml: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
  }
}

// Each test renders the whole settings page and walks through a dialog: about
// three seconds alone, past the 5 s default when the full suite runs in parallel.
describe(
  "AcpAgentSettings — an OpenCode provider's models",
  { timeout: 20_000 },
  () => {
    beforeEach(() => {
      vi.clearAllMocks()
      vi.mocked(listModelProviders).mockResolvedValue([])
      vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
      vi.mocked(listProviderModels).mockResolvedValue({
        url: "https://relay.test/v1/models",
        models: [{ id: "glm-5.2" }, { id: "kimi-k3" }],
      })
      vi.mocked(opencodeListIntegrations).mockResolvedValue([
        {
          id: "relay",
          name: "Relay",
          methods: [{ type: "key", label: "Manually enter API Key" }],
          connections: [
            {
              type: "credential",
              id: "cred_1",
              label: "Relay",
              method: "key",
              active: true,
            },
          ],
        },
      ])
    })

    async function pickModels(config: unknown) {
      const user = userEvent.setup()
      vi.mocked(acpListAgents).mockResolvedValue([openCodeAgent(config)])
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <AcpAgentSettings />
        </NextIntlClientProvider>
      )
      // The provider's card, then its models.
      await user.click(await screen.findByRole("button", { name: /^relay/ }))
      await user.click(
        await screen.findByRole("button", { name: /Model Management/ })
      )
      await user.click(screen.getByRole("button", { name: "Choose models…" }))
      await waitFor(() =>
        expect(listProviderModels).toHaveBeenCalledWith({
          protocol: "openai",
          baseUrl: "https://relay.test/v1",
          keySource: { kind: "opencodeCredential", integrationId: "relay" },
          keyHeader: null,
        })
      )
      const dialog = await screen.findByRole("dialog")
      for (const id of ["kimi-k3", "old"]) {
        const row = (await within(dialog).findByText(id)).closest("label")!
        await user.click(within(row).getByRole("checkbox"))
      }
      await user.click(
        within(dialog).getByRole("button", { name: "Use 2 models" })
      )

      await user.click(
        screen.getByRole("button", { name: "Save OpenCode Config" })
      )
      await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalled())
      const [, patch] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
      return JSON.parse(patch.config_json ?? "{}")
    }

    const PICKED = {
      "glm-5.2": { name: "GLM", limit: { context: 128000, output: 8192 } },
      "kimi-k3": { name: "kimi-k3" },
    }

    it("picks them from the provider's own list (OpenCode 2 block)", async () => {
      const saved = await pickModels(NATIVE_CONFIG)
      expect(saved.providers.relay.models).toEqual(PICKED)
      expect(saved.provider).toBeUndefined()
    })

    it("keeps a 1.x block in its own shape", async () => {
      const saved = await pickModels(LEGACY_CONFIG)
      expect(saved.provider.relay.models).toEqual(PICKED)
      expect(saved.providers).toBeUndefined()
    })

    it.each(["models", "provider"])(
      "keeps disabled %s out of both default model pickers before the catalog loads",
      async (disabled) => {
        const user = userEvent.setup()
        vi.mocked(acpListAgents).mockResolvedValue([
          openCodeAgent({
            providers: {
              relay: {
                ...NATIVE_CONFIG.providers.relay,
                models: {
                  "glm-5.2": { disabled: disabled === "models" },
                  old: { disabled: disabled === "models" },
                },
              },
            },
            ...(disabled === "provider"
              ? {
                  policies: [
                    {
                      action: "provider.use",
                      resource: "relay",
                      effect: "deny",
                    },
                  ],
                }
              : {}),
          }),
        ])
        render(
          <NextIntlClientProvider locale="en" messages={enMessages}>
            <AcpAgentSettings />
          </NextIntlClientProvider>
        )
        const inputs =
          await screen.findAllByPlaceholderText("provider/model-id")
        expect(inputs).toHaveLength(2)
        for (const input of inputs) {
          await user.click(input)
          expect(
            screen.queryAllByRole("option", { name: /relay\// })
          ).toHaveLength(0)
          await user.keyboard("{Escape}")
        }
      }
    )
  }
)
