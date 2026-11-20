import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { ModelProviderEditor } from "./model-provider-editor"
import { createMockModelProviderService } from "@/stores/model-provider-mock"
import {
  emptyModelEntry,
  emptyProviderDraft,
  type ModelProviderDraft,
} from "@/lib/model-provider-types"
import enMessages from "@/i18n/messages/en.json"

function renderEditor(
  overrides?: Partial<ModelProviderDraft>,
  existingIds: string[] = []
) {
  const draft = {
    ...emptyProviderDraft(),
    providerId: "test",
    baseUrl: "https://example.com/v1",
    models: [{ id: "seed-model", reasoning: false, input: "text" as const }],
    ...overrides,
  }
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ModelProviderEditor
        draft={draft}
        isNew
        existingIds={existingIds}
        service={createMockModelProviderService()}
        onSaved={() => {}}
        onCancel={() => {}}
      />
    </NextIntlClientProvider>
  )
}

const saveButton = () =>
  screen.getByRole("button", { name: "Save" }) as HTMLButtonElement

describe("ModelProviderEditor", () => {
  it("flags a provider-id conflict and blocks saving", () => {
    renderEditor({ providerId: "test" }, ["test"])
    expect(
      screen.getByText("A provider with this id already exists.")
    ).toBeInTheDocument()
    expect(saveButton().disabled).toBe(true)
  })

  it("requires at least one model id", () => {
    renderEditor({ models: [{ id: "", reasoning: false, input: "text" }] })
    expect(saveButton().disabled).toBe(true)
  })

  it("adds and removes model rows", () => {
    renderEditor()
    expect(screen.getAllByPlaceholderText("gpt-5.1")).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Add model" }))
    expect(screen.getAllByPlaceholderText("gpt-5.1")).toHaveLength(2)

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0])
    expect(screen.getAllByPlaceholderText("gpt-5.1")).toHaveLength(1)
  })

  it("applies fetched models and reports the count", async () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Fetch from /models" }))

    await waitFor(() =>
      expect(screen.getByDisplayValue("gpt-5.1-mini")).toBeInTheDocument()
    )
    expect(screen.getByText("Fetched 3 models.")).toBeInTheDocument()
  })

  it("tests a model with a typed key and shows the reply", async () => {
    renderEditor()
    // Provider id "test" is unsaved, so the mock needs the typed key.
    fireEvent.change(
      screen.getByPlaceholderText("Leave blank to keep current"),
      {
        target: { value: "sk-typed" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Test" }))

    await waitFor(() =>
      expect(screen.getByText("OK: pong from seed-model")).toBeInTheDocument()
    )
  })

  it("uses ids only and defaults new models to reasoning and text-image", () => {
    renderEditor({ models: [emptyModelEntry()] })
    expect(screen.queryByText("Provider name")).not.toBeInTheDocument()
    expect(screen.queryByText("Display name")).not.toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Reasoning" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(screen.getByText("Text + image")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Add model" }))
    const switches = screen.getAllByRole("switch", { name: "Reasoning" })
    expect(switches).toHaveLength(2)
    for (const sw of switches) {
      expect(sw).toHaveAttribute("aria-checked", "true")
    }
    expect(screen.getAllByText("Text + image")).toHaveLength(2)
  })

  it("masks the API key with text-security instead of type=password", () => {
    renderEditor()
    const apiKeyInput = screen.getByPlaceholderText(
      "Leave blank to keep current"
    ) as HTMLInputElement
    expect(apiKeyInput.type).toBe("text")
    expect(apiKeyInput.className).toContain("masked-key")

    fireEvent.click(screen.getByRole("button", { name: "Show key" }))
    expect(apiKeyInput.type).toBe("text")
    expect(apiKeyInput.className).not.toContain("masked-key")

    fireEvent.click(screen.getByRole("button", { name: "Hide key" }))
    expect(apiKeyInput.className).toContain("masked-key")
  })

  it("does not render agent bindings", () => {
    renderEditor()
    expect(screen.queryByText("Bind agents")).not.toBeInTheDocument()
  })
})
