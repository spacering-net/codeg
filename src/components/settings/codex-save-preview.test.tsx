/**
 * The line under the Codex model list that says what a save would set the
 * keys codeg manages to, asked of the backend once the draft settles.
 */
import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { codexCatalogPlanPreview } from "@/lib/api"

import { CodexSavePreview } from "./codex-catalog-source"

vi.mock("@/lib/api", () => ({ codexCatalogPlanPreview: vi.fn() }))

function renderPreview(modelList = '{"customs":[]}') {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CodexSavePreview
        configToml="x = 1"
        authJson="{}"
        modelList={modelList}
      />
    </NextIntlClientProvider>
  )
}

describe("CodexSavePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("says which root model and catalog a save would set", async () => {
    vi.mocked(codexCatalogPlanPreview).mockResolvedValue({
      finalToml: "",
      managesCatalog: true,
      defaultModel: "glm-5.2",
      counts: null,
      warnings: [],
    })
    renderPreview()
    expect(
      await screen.findByText(/sets root model = “glm-5\.2”/)
    ).toBeVisible()
    expect(codexCatalogPlanPreview).toHaveBeenCalledWith({
      configToml: "x = 1",
      authJson: "{}",
      modelList: '{"customs":[]}',
    })
  })

  it("says nothing while codex keeps its own list", async () => {
    vi.mocked(codexCatalogPlanPreview).mockResolvedValue({
      finalToml: "",
      managesCatalog: false,
      defaultModel: null,
      counts: null,
      warnings: [],
    })
    const { container } = renderPreview()
    await waitFor(() => expect(codexCatalogPlanPreview).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("says why a save would be refused", async () => {
    vi.mocked(codexCatalogPlanPreview).mockImplementation(async () => {
      throw {
        code: "configuration_invalid",
        message: "no model is left",
        i18n_key: "codexCatalog.no_usable_models",
        i18n_params: {},
      }
    })
    renderPreview()
    expect(
      await screen.findByText(/This would not save: No usable models/)
    ).toBeVisible()
  })
})
