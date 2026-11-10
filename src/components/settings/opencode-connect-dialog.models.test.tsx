/**
 * The custom provider dialog lists the provider's own models, asked the way
 * its AI SDK package talks to it, and fills the model list from the picks.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { listProviderModels } from "@/lib/api"

import { OpenCodeCustomProviderDialog } from "./opencode-connect-dialog"

vi.mock("@/lib/api", () => ({ listProviderModels: vi.fn() }))

function renderDialog() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <OpenCodeCustomProviderDialog
        open
        onOpenChange={() => {}}
        existingProviderIds={[]}
        catalogIds={[]}
        onSubmit={async () => {}}
      />
    </NextIntlClientProvider>
  )
}

describe("OpenCodeCustomProviderDialog — the provider's models", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listProviderModels).mockResolvedValue({
      url: "https://relay.test/v1/models",
      models: [{ id: "glm-5.2" }, { id: "kimi-k3" }, { id: "qwen-4" }],
    })
  })

  it("fills the model list from the picks", async () => {
    const user = userEvent.setup()
    renderDialog()
    const pick = screen.getByRole("button", { name: "Choose models…" })
    expect(pick).toBeDisabled()

    await user.type(
      screen.getByPlaceholderText("https://api.example.com/v1"),
      "https://relay.test/v1"
    )
    await user.type(screen.getByPlaceholderText("sk-..."), "sk-relay")
    const models = screen.getByPlaceholderText(/gpt-6-astra/)
    await user.type(models, "mine")

    await user.click(pick)
    await waitFor(() =>
      expect(listProviderModels).toHaveBeenCalledWith({
        protocol: "openai",
        baseUrl: "https://relay.test/v1",
        keySource: { kind: "inline", apiKey: "sk-relay" },
        keyHeader: null,
      })
    )
    const dialogs = await screen.findAllByRole("dialog")
    const picker = dialogs[dialogs.length - 1]
    const kimi = (await within(picker).findByText("kimi-k3")).closest("label")!
    await user.click(within(kimi).getByRole("checkbox"))
    await user.click(
      within(picker).getByRole("button", { name: "Use 2 models" })
    )
    await waitFor(() => expect(models).toHaveValue("mine\nkimi-k3"))
  })
})
