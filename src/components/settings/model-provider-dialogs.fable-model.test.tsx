/**
 * A Claude model provider carries its Fable pin (`fable`, which a bind turns
 * into `ANTHROPIC_DEFAULT_FABLE_MODEL`) in its `model` JSON next to the other
 * model pins. These drive both provider dialogs: what the Fable field holds is
 * what gets stored, and an edit starts from the stored pin.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { createModelProvider, updateModelProvider } from "@/lib/api"
import type { ModelProviderInfo } from "@/lib/types"

import { AddModelProviderDialog } from "./add-model-provider-dialog"
import { EditModelProviderDialog } from "./edit-model-provider-dialog"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  // Every function is stubbed so nothing here can reach the real transport.
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" ? vi.fn(() => new Promise(() => {})) : value,
    ])
  )
})

const CLAUDE_PROVIDER: ModelProviderInfo = {
  id: 7,
  name: "Gateway",
  api_url: "https://gateway.test",
  api_key: "key",
  api_key_masked: "",
  agent_type: "claude_code",
  model: JSON.stringify({ opus: "gw/opus", fable: "gw/fable-old" }),
  created_at: "",
  updated_at: "",
}

function withIntl(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

/** The input under a model field's `<label>` (those carry no `htmlFor`). */
function fieldUnder(label: string): HTMLElement {
  const labelEl = screen.getByText(label, { selector: "label" })
  return within(labelEl.parentElement as HTMLElement).getByRole("textbox")
}

describe("model provider dialogs — the Claude Fable model pin", () => {
  beforeEach(() => {
    vi.mocked(createModelProvider).mockResolvedValue(CLAUDE_PROVIDER)
    vi.mocked(updateModelProvider).mockResolvedValue({
      provider: CLAUDE_PROVIDER,
      affectedRunningSessions: 0,
    })
  })

  it("creates a Claude provider with the Fable pin typed into its field", async () => {
    const user = userEvent.setup()
    render(
      withIntl(
        <AddModelProviderDialog
          open
          onOpenChange={() => {}}
          onProviderAdded={() => {}}
        />
      )
    )
    await user.type(screen.getByLabelText("Name"), "Gateway")
    await user.type(screen.getByLabelText("API URL"), "https://gateway.test")
    await user.type(screen.getByLabelText("API Key"), "key")
    await user.type(fieldUnder("Default Fable Model"), "gw/fable")
    await user.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(() => expect(createModelProvider).toHaveBeenCalledTimes(1))
    const [params] = vi.mocked(createModelProvider).mock.calls[0]
    expect(params.agentType).toBe("claude_code")
    expect(JSON.parse(params.model ?? "null")).toEqual({ fable: "gw/fable" })
  })

  it("loads the stored Fable pin and saves an edit to it", async () => {
    const user = userEvent.setup()
    render(
      withIntl(
        <EditModelProviderDialog
          provider={CLAUDE_PROVIDER}
          onOpenChange={() => {}}
          onProviderUpdated={() => {}}
        />
      )
    )
    const fable = fieldUnder("Default Fable Model")
    await waitFor(() => expect(fable).toHaveValue("gw/fable-old"))

    await user.clear(fable)
    await user.type(fable, "gw/fable-2")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(updateModelProvider).toHaveBeenCalledTimes(1))
    const [params] = vi.mocked(updateModelProvider).mock.calls[0]
    expect(JSON.parse(params.model ?? "null")).toEqual({
      opus: "gw/opus",
      fable: "gw/fable-2",
    })
  })
})
