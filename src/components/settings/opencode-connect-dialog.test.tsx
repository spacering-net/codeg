/**
 * Editing a connected provider: the base URL starts from the config, what the
 * user types survives the parent re-rendering, and saving only a new base URL
 * sends no key.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { OpenCodeCatalogProvider, OpenCodeIntegration } from "@/lib/types"

import {
  OpenCodeConnectDialog,
  type OpenCodeConnectRequest,
} from "./opencode-connect-dialog"

vi.mock("@/lib/api", () => ({ listProviderModels: vi.fn() }))

const integrations: OpenCodeIntegration[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    methods: [{ type: "key", id: "key", label: "API key" }],
    connections: [
      { type: "credential", id: "cred_1", method: "key", active: true },
    ],
  },
]

const catalog: OpenCodeCatalogProvider[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    npm: "@ai-sdk/deepseek",
    env: ["DEEPSEEK_API_KEY"],
    doc: null,
    auth_kind: "api",
    models: [],
  },
]

function EditDialog({
  onConnect,
}: {
  onConnect: (request: OpenCodeConnectRequest) => Promise<void>
}) {
  // Like the settings page: fresh callbacks on every render.
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <OpenCodeConnectDialog
        open
        onOpenChange={() => {}}
        integrations={integrations}
        integrationsLoading={false}
        integrationsError={null}
        catalog={catalog}
        editProviderId="deepseek"
        editBaseUrl="https://old.example/v1"
        baseUrlEditable={(id) => id === "deepseek"}
        onConnect={(request) => onConnect(request)}
      />
    </NextIntlClientProvider>
  )
}

describe("OpenCodeConnectDialog — editing a provider", () => {
  it("keeps a typed base URL when the parent re-renders", async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn(async () => {})
    const { rerender } = render(<EditDialog onConnect={onConnect} />)

    const baseUrl = screen.getByPlaceholderText("https://proxy.example/v1")
    expect(baseUrl).toHaveValue("https://old.example/v1")
    await user.clear(baseUrl)
    await user.type(baseUrl, "https://new.example/v1")

    rerender(<EditDialog onConnect={onConnect} />)
    expect(screen.getByPlaceholderText("https://proxy.example/v1")).toHaveValue(
      "https://new.example/v1"
    )
  })

  it("saves a new base URL alone, without a key", async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn<(request: OpenCodeConnectRequest) => Promise<void>>(
      async () => {}
    )
    render(<EditDialog onConnect={onConnect} />)

    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()

    const baseUrl = screen.getByPlaceholderText("https://proxy.example/v1")
    await user.clear(baseUrl)
    await user.type(baseUrl, "https://new.example/v1")
    await user.click(save)

    expect(onConnect).toHaveBeenCalledWith({
      providerId: "deepseek",
      apiKey: "",
      answer: undefined,
      baseUrlOverride: "https://new.example/v1",
      replace: true,
    })
  })

  it("clears the override when the field is emptied", async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn<(request: OpenCodeConnectRequest) => Promise<void>>(
      async () => {}
    )
    render(<EditDialog onConnect={onConnect} />)

    await user.clear(screen.getByPlaceholderText("https://proxy.example/v1"))
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "", baseUrlOverride: "" })
    )
  })
})
