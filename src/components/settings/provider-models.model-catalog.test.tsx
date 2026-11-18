/**
 * The model catalog's suggestions: the two-character search the id field does
 * while keeping focus, the absence of a check before a pick, and how a pick
 * overwrites a custom model row's declared capabilities.
 */
import { useState, type ReactNode } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { getModelCatalog } from "@/lib/api"
import type { ModelCatalogEntry, ModelCatalogView } from "@/lib/types"

import { applyDeepSeekCatalogPick } from "./deepseek-model-list-editor"
import {
  catalogDescription,
  catalogDisplayName,
  catalogMatches,
  ModelIdInputWithCatalog,
} from "./provider-models"

vi.mock("@/lib/api", () => ({
  getModelCatalog: vi.fn(),
  loadDeepSeekModelCatalog: vi.fn(),
  updateDeepSeekModelCatalog: vi.fn(),
}))

function entry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: "openai/gpt-5",
    model: "gpt-5",
    provider: "openai",
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
    reasoningEffortLevels: ["minimal", "low"],
    defaultReasoningEffort: "low",
    supportsVision: true,
    supportsFunctionCalling: true,
    ...overrides,
  }
}

function view(entries: ModelCatalogEntry[]): ModelCatalogView {
  return {
    status: {
      url: "https://catalog.test/models.json",
      autoUpdate: true,
      entryCount: entries.length,
      updatedAt: 1_760_000_000,
      source: "cache",
      error: null,
    },
    entries,
  }
}

function renderWithIntl(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("catalogMatches", () => {
  const entries = [
    entry(),
    entry({ id: "anthropic/claude-sonnet-4-5", model: "claude-sonnet-4-5" }),
    entry({ id: "google/gemini-2.5-pro", model: "gemini-2.5-pro" }),
  ]

  it("searches from two characters on, ignoring case, over the id and the model name", () => {
    expect(catalogMatches(entries, "GPT").map((e) => e.model)).toEqual([
      "gpt-5",
    ])
    expect(catalogMatches(entries, "anthropic").map((e) => e.model)).toEqual([
      "claude-sonnet-4-5",
    ])
    // One character is still an id being typed, not a search.
    expect(catalogMatches(entries, "g")).toHaveLength(3)
    expect(catalogMatches(entries, "zzz")).toEqual([])
  })

  it("caps what a menu renders", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      entry({ id: `m/${i}`, model: `m-${i}` })
    )
    expect(catalogMatches(many, "")).toHaveLength(50)
    expect(catalogMatches(many, "m-7").length).toBeLessThanOrEqual(50)
  })
})

describe("catalogDisplayName", () => {
  it("splits the model id on -/_ and capitalizes each part", () => {
    expect(catalogDisplayName(entry())).toBe("Gpt 5")
    expect(
      catalogDisplayName(
        entry({ id: "anthropic/claude-sonnet-4-5", model: "claude-sonnet-4-5" })
      )
    ).toBe("Claude Sonnet 4 5")
    expect(
      catalogDisplayName(
        entry({ id: "x/gemini_2_5_pro", model: "gemini_2_5_pro" })
      )
    ).toBe("Gemini 2 5 Pro")
  })

  it("falls back to the raw id when nothing can be split", () => {
    expect(catalogDisplayName(entry({ id: "x/", model: "" }))).toBe("")
    expect(catalogDisplayName(entry({ id: "x/gpt5", model: "gpt5" }))).toBe(
      "Gpt5"
    )
  })
})

describe("catalogDescription", () => {
  it("describes the catalog key, capacities and capability flags", () => {
    const text = catalogDescription(entry())
    expect(text).toContain("openai/gpt-5")
    expect(text).toContain("272K input")
    expect(text).toContain("128K output")
    expect(text).toContain("reasoning")
    expect(text).toContain("vision")
    expect(text).toContain("tools")
  })

  it("omits unknown values", () => {
    const text = catalogDescription(
      entry({
        maxInputTokens: null,
        maxOutputTokens: null,
        supportsReasoning: false,
        supportsVision: false,
        supportsFunctionCalling: false,
      })
    )
    expect(text).toBe("openai/gpt-5")
  })
})

describe("applyDeepSeekCatalogPick", () => {
  it("fills a blank row with the catalog's id, capacity and vision", () => {
    const filled = applyDeepSeekCatalogPick({ id: "" }, entry())
    expect(filled.id).toBe("gpt-5")
    expect(filled.contextWindow).toBe(272000)
    expect(filled.maxTokens).toBe(128000)
    expect(filled.inputModalities).toEqual(["text", "image"])
    expect(filled.name).toBe("Gpt 5")
    expect(filled.description).toContain("openai/gpt-5")
  })

  it("overwrites what the user already typed with the picked model's values", () => {
    const filled = applyDeepSeekCatalogPick(
      { id: "custom", contextWindow: 8000, maxTokens: 1000 },
      entry()
    )
    expect(filled.id).toBe("gpt-5")
    expect(filled.contextWindow).toBe(272000)
    expect(filled.maxTokens).toBe(128000)
  })

  it("turns image support off for a text-only pick", () => {
    const filled = applyDeepSeekCatalogPick(
      { id: "custom", inputModalities: ["text", "image"] },
      entry({ supportsVision: false })
    )
    expect(filled.inputModalities).toBeUndefined()
  })

  it("clears capacity when the picked model does not declare it", () => {
    const filled = applyDeepSeekCatalogPick(
      { id: "custom", contextWindow: 8000, maxTokens: 1000 },
      entry({ maxInputTokens: null, maxOutputTokens: null })
    )
    expect(filled.contextWindow).toBeUndefined()
    expect(filled.maxTokens).toBeUndefined()
  })
})

const CHOOSE = { name: "Choose from the provider's models" }

function Form() {
  const [value, setValue] = useState("")
  const [picked, setPicked] = useState("")
  return (
    <>
      <ModelIdInputWithCatalog
        value={value}
        onChange={setValue}
        onPick={(next) => setPicked(next.model)}
        aria-label="model"
      />
      <span data-testid="picked">{picked}</span>
    </>
  )
}

describe("ModelIdInputWithCatalog", () => {
  beforeEach(() => {
    vi.mocked(getModelCatalog).mockReset()
    vi.mocked(getModelCatalog).mockResolvedValue(
      view([
        entry(),
        entry({
          id: "anthropic/claude-sonnet-4-5",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
        }),
      ])
    )
  })

  it("suggests catalog entries once two characters are typed, and fills on a pick", async () => {
    const user = userEvent.setup()
    renderWithIntl(<Form />)

    await user.type(screen.getByLabelText("model"), "g")
    expect(screen.queryByRole("option")).toBeNull()

    await user.type(screen.getByLabelText("model"), "p")
    await user.click(await screen.findByRole("option", { name: /gpt-5/ }))
    expect(screen.getByLabelText("model")).toHaveValue("gpt-5")
    expect(screen.getByTestId("picked")).toHaveTextContent("gpt-5")
  })

  it("keeps the input focused after the menu opens and shows no check before a pick", async () => {
    const user = userEvent.setup()
    renderWithIntl(<Form />)
    const input = screen.getByLabelText("model")

    // Typing must not be cut short when the suggestions appear at two chars.
    await user.type(input, "gpt-5")
    expect(input).toHaveFocus()
    expect(input).toHaveValue("gpt-5")

    const options = await screen.findAllByRole("option")
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) {
      expect(option.querySelector("svg")).toBeNull()
    }
  })

  it("marks only the picked model when the menu is reopened", async () => {
    const user = userEvent.setup()
    renderWithIntl(<Form />)

    await user.type(screen.getByLabelText("model"), "gp")
    await user.click(await screen.findByRole("option", { name: /gpt-5/ }))
    await user.click(screen.getByRole("button", CHOOSE))

    const picked = await screen.findByRole("option", { name: /gpt-5/ })
    const other = screen.getByRole("option", { name: /claude-sonnet-4-5/ })
    expect(picked.querySelector("svg")).not.toBeNull()
    expect(other.querySelector("svg")).toBeNull()
  })

  it("browses the whole catalog from the chevron, and can refresh it", async () => {
    const user = userEvent.setup()
    renderWithIntl(<Form />)

    await user.click(screen.getByRole("button", CHOOSE))
    expect(
      await screen.findByRole("option", { name: /claude-sonnet-4-5/ })
    ).toBeVisible()

    await user.click(
      screen.getByRole("button", { name: "Refresh model catalog" })
    )
    await waitFor(() => expect(getModelCatalog).toHaveBeenLastCalledWith(true))
  })
})
