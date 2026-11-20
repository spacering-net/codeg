import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ModelProviderSettings } from "./model-provider-settings"
import enMessages from "@/i18n/messages/en.json"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}))
// The settings page reads its data through the transport service. These UI
// tests don't need a backend, so serve them from the in-memory mock contract —
// one fresh instance per mounted component (matching the pre-transport
// behaviour the suite was written against).
vi.mock("@/stores/model-provider-transport", async () => {
  const { createMockModelProviderService } =
    await import("@/stores/model-provider-mock")
  const { useMemo } = await import("react")
  return {
    useModelProviderService: () =>
      useMemo(() => createMockModelProviderService(), []),
  }
})

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ModelProviderSettings />
    </NextIntlClientProvider>
  )
}

async function waitForList() {
  await waitFor(() =>
    expect(screen.getByText("openrouter")).toBeInTheDocument()
  )
}

describe("ModelProviderSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders the seeded provider list", async () => {
    renderPage()
    await waitForList()
    expect(screen.getByText("deepseek")).toBeInTheDocument()
    expect(screen.getByText("local-vllm")).toBeInTheDocument()
    expect(screen.queryByText("OpenRouter gateway")).not.toBeInTheDocument()
  })

  it("deletes a provider", async () => {
    const { toast } = await import("sonner")
    renderPage()
    await waitForList()

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0])
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))

    await waitFor(() =>
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Provider deleted.")
    )
    expect(await screen.findByText("local-vllm")).toBeInTheDocument()
  })

  it("opens the editor from a row", async () => {
    renderPage()
    await waitForList()
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0])
    expect(screen.getByText("Edit Provider")).toBeInTheDocument()
  })

  it("opens a blank editor via Add Provider", async () => {
    renderPage()
    await waitForList()
    fireEvent.click(screen.getByRole("button", { name: "Add Provider" }))
    expect(screen.getByText("Add Provider")).toBeInTheDocument()
    expect(screen.getByText("Models")).toBeInTheDocument()
  })

  it("imports a built-in provider into a pre-filled editor", async () => {
    renderPage()
    await waitForList()
    fireEvent.click(
      screen.getByRole("button", { name: "Import from built-in" })
    )

    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByText("Import from built-in provider")
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(within(dialog).getByText("Configured")).toBeInTheDocument()
    )

    await waitFor(() =>
      expect(within(dialog).getByText("anthropic")).toBeInTheDocument()
    )
    const importButtons = within(dialog).getAllByRole("button", {
      name: "Import",
    })
    const anthropicImport = importButtons.find((b) =>
      b.closest("div")?.textContent?.includes("anthropic")
    )
    expect(anthropicImport).toBeTruthy()
    fireEvent.click(anthropicImport!)

    // The clone is async; wait for the editor's pre-filled provider id.
    await waitFor(() =>
      expect(screen.getByDisplayValue("anthropic-2")).toBeInTheDocument()
    )
  })
})
