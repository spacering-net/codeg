/**
 * The shared "fetch models" pieces: the request a form makes, a result that
 * only ever speaks for the URL and key it was fetched with, the id field's
 * dropdown, and picking several ids without losing configured ones.
 */
import { useState } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  providerModelsRequest,
  useProviderModels,
  type ProviderModelsInput,
} from "@/hooks/use-provider-models"
import { listProviderModels } from "@/lib/api"
import type { ProviderModelList } from "@/lib/types"

import { FetchedModelPicker, ModelIdInputWithFetch } from "./provider-models"

vi.mock("@/lib/api", () => ({ listProviderModels: vi.fn() }))

function listed(...ids: string[]): ProviderModelList {
  return {
    url: "https://relay.test/v1/models",
    models: ids.map((id) => ({ id })),
  }
}

describe("providerModelsRequest", () => {
  it("says what is missing, and prefers a typed key over a saved one", () => {
    const base: ProviderModelsInput = {
      protocol: "openai",
      baseUrl: " https://relay.test/v1 ",
      apiKey: " sk-typed ",
    }
    expect(providerModelsRequest({ ...base, baseUrl: " " }).missing).toBe(
      "baseUrl"
    )
    expect(providerModelsRequest({ ...base, apiKey: "" }).missing).toBe(
      "apiKey"
    )
    expect(providerModelsRequest(base).request).toEqual({
      protocol: "openai",
      baseUrl: "https://relay.test/v1",
      keySource: { kind: "inline", apiKey: "sk-typed" },
      keyHeader: null,
    })
    // A saved provider lists with its stored key unless one is typed.
    expect(
      providerModelsRequest({ ...base, apiKey: "", providerId: 4 }).request
        ?.keySource
    ).toEqual({ kind: "provider", providerId: 4, apiKey: "" })
    expect(providerModelsRequest(null)).toEqual({
      request: null,
      missing: null,
    })
  })
})

function Form({ initialKey = "sk-a" }: { initialKey?: string }) {
  const [apiKey, setApiKey] = useState(initialKey)
  const [model, setModel] = useState("")
  const models = useProviderModels({
    protocol: "openai",
    baseUrl: "https://relay.test/v1",
    apiKey,
  })
  return (
    <div>
      <input
        aria-label="key"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <ModelIdInputWithFetch
        aria-label="model"
        value={model}
        onChange={setModel}
        state={models}
      />
    </div>
  )
}

function renderWithIntl(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const CHOOSE = { name: "Choose from the provider's models" }

describe("useProviderModels and the id field", () => {
  beforeEach(() => {
    // Braced: a function handed back from beforeEach runs as its teardown.
    vi.mocked(listProviderModels).mockReset()
  })

  it("asks the provider when its list opens, and lists its models there", async () => {
    const user = userEvent.setup()
    vi.mocked(listProviderModels).mockResolvedValue(
      listed("glm-5.2", "kimi-k3")
    )
    renderWithIntl(<Form />)
    // Nothing is asked before the list is opened.
    expect(listProviderModels).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", CHOOSE))
    expect(await screen.findByText("2 models · relay.test")).toBeVisible()
    expect(listProviderModels).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("option", { name: /kimi-k3/ }))
    expect(screen.getByLabelText("model")).toHaveValue("kimi-k3")
    // Closed on the pick, and the list is kept: opening again asks nothing.
    expect(screen.queryByRole("option")).toBeNull()
    await user.click(screen.getByRole("button", CHOOSE))
    expect(await screen.findByRole("option", { name: /glm-5.2/ })).toBeVisible()
    expect(listProviderModels).toHaveBeenCalledTimes(1)
  })

  it("drops the list once the key changes, and asks again with the new one", async () => {
    const user = userEvent.setup()
    vi.mocked(listProviderModels).mockResolvedValue(listed("glm-5.2"))
    renderWithIntl(<Form />)
    await user.click(screen.getByRole("button", CHOOSE))
    expect(await screen.findByRole("option", { name: /glm-5.2/ })).toBeVisible()
    await user.keyboard("{Escape}")

    vi.mocked(listProviderModels).mockResolvedValue(listed("qwen-4"))
    await user.type(screen.getByLabelText("key"), "x")
    await user.click(screen.getByRole("button", CHOOSE))
    expect(await screen.findByRole("option", { name: /qwen-4/ })).toBeVisible()
    expect(screen.queryByRole("option", { name: /glm-5.2/ })).toBeNull()
    expect(listProviderModels).toHaveBeenCalledTimes(2)
    expect(vi.mocked(listProviderModels).mock.calls[1]![0].keySource).toEqual({
      kind: "inline",
      apiKey: "sk-ax",
    })
  })

  it("opens from the field with the down arrow", async () => {
    const user = userEvent.setup()
    vi.mocked(listProviderModels).mockResolvedValue(listed("glm-5.2"))
    renderWithIntl(<Form />)
    await user.click(screen.getByLabelText("model"))
    await user.keyboard("{ArrowDown}")
    expect(await screen.findByRole("option", { name: /glm-5.2/ })).toBeVisible()
  })

  it("ignores an answer to a request the form moved away from", async () => {
    const user = userEvent.setup()
    let answer: (list: ProviderModelList) => void = () => {}
    vi.mocked(listProviderModels).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    renderWithIntl(<Form />)
    await user.click(screen.getByRole("button", CHOOSE))
    expect(await screen.findByText("Fetching models…")).toBeVisible()
    await user.keyboard("{Escape}")
    await user.type(screen.getByLabelText("key"), "b")
    answer(listed("stale"))
    await new Promise((r) => setTimeout(r, 0))
    vi.mocked(listProviderModels).mockResolvedValue(listed("fresh"))
    await user.click(screen.getByRole("button", CHOOSE))
    expect(await screen.findByRole("option", { name: /fresh/ })).toBeVisible()
    expect(screen.queryByRole("option", { name: /stale/ })).toBeNull()
  })

  it("says what it needs before it can ask, and why a fetch failed, with a retry", async () => {
    const user = userEvent.setup()
    renderWithIntl(<Form initialKey="" />)
    await user.click(screen.getByRole("button", CHOOSE))
    expect(
      await screen.findByText(
        "Enter the API key first: the models are listed with it."
      )
    ).toBeVisible()
    expect(listProviderModels).not.toHaveBeenCalled()
    await user.keyboard("{Escape}")

    vi.mocked(listProviderModels).mockImplementation(async () => {
      throw {
        code: "network_error",
        message: "no model list",
        i18n_key: "providerModels.not_found",
        i18n_params: { url: "https://relay.test/v1/models", status: "404" },
      }
    })
    await user.type(screen.getByLabelText("key"), "sk")
    await user.click(screen.getByRole("button", CHOOSE))
    const failure = "No model list at https://relay.test/v1/models (HTTP 404)."
    expect(await screen.findByText(failure)).toBeVisible()
    await user.keyboard("{Escape}")
    // The closed field shows the failure on its chevron too.
    expect(screen.getByRole("button", CHOOSE)).toHaveAttribute("title", failure)

    // Opened again, it asks again; and says why once more if that fails.
    await user.click(screen.getByRole("button", CHOOSE))
    expect(await screen.findByText(failure)).toBeVisible()
    expect(listProviderModels).toHaveBeenCalledTimes(2)
    vi.mocked(listProviderModels).mockResolvedValue(listed("glm-5.2"))
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByRole("option", { name: /glm-5.2/ })).toBeVisible()
  })

  it("is a plain field where there is no endpoint to ask, or it is read-only", () => {
    function Plain({ readOnly }: { readOnly: boolean }) {
      const models = useProviderModels(
        readOnly
          ? {
              protocol: "openai",
              baseUrl: "https://relay.test/v1",
              apiKey: "sk",
            }
          : null
      )
      return (
        <ModelIdInputWithFetch
          aria-label="model"
          value=""
          onChange={() => {}}
          state={models}
          readOnly={readOnly}
        />
      )
    }
    const { rerender } = renderWithIntl(<Plain readOnly={false} />)
    expect(screen.queryByRole("button", CHOOSE)).toBeNull()
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <Plain readOnly />
      </NextIntlClientProvider>
    )
    expect(screen.queryByRole("button", CHOOSE)).toBeNull()
  })
})

function Picker({
  configured,
  onConfirm,
}: {
  configured: string[]
  onConfirm: (ids: string[]) => void
}) {
  const models = useProviderModels({
    protocol: "openai",
    baseUrl: "https://relay.test/v1",
    apiKey: "sk",
  })
  return (
    <FetchedModelPicker
      state={models}
      configured={configured}
      onConfirm={onConfirm}
    />
  )
}

describe("FetchedModelPicker", () => {
  beforeEach(() => {
    // Braced: a function handed back from beforeEach runs as its teardown.
    vi.mocked(listProviderModels).mockReset()
  })

  it("fetches on open, keeps configured ids the provider does not list, and keeps their order", async () => {
    const user = userEvent.setup()
    vi.mocked(listProviderModels).mockResolvedValue(
      listed("a-model", "b-model", "c-model")
    )
    const onConfirm = vi.fn()
    renderWithIntl(
      <Picker configured={["c-model", "mine"]} onConfirm={onConfirm} />
    )
    await user.click(screen.getByRole("button", { name: "Choose models…" }))
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText("a-model")
    // Configured but not listed: shown first, picked, marked.
    const mine = within(dialog).getByText("mine").closest("label")!
    expect(within(mine).getByText("Not listed")).toBeVisible()
    expect(within(mine).getByRole("checkbox")).toBeChecked()

    const a = within(dialog).getByText("a-model").closest("label")!
    await user.click(within(a).getByRole("checkbox"))
    await user.click(
      within(dialog).getByRole("button", { name: "Use 3 models" })
    )
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(["c-model", "mine", "a-model"])
    )
  })
})

describe("FetchedModelPicker — the list in the dialog", () => {
  beforeEach(() => {
    vi.mocked(listProviderModels).mockReset()
  })

  it("opens at once, says why the provider could not list, and tries again", async () => {
    const user = userEvent.setup()
    vi.mocked(listProviderModels).mockRejectedValueOnce({
      code: "network_error",
      message: "the key was rejected",
      i18n_key: "providerModels.unauthorized",
      i18n_params: { status: "401" },
    })
    renderWithIntl(<Picker configured={["mine"]} onConfirm={() => {}} />)
    await user.click(screen.getByRole("button", { name: "Choose models…" }))
    const dialog = await screen.findByRole("dialog")
    expect(
      await within(dialog).findByText(
        "The key is invalid or has no permission (HTTP 401)."
      )
    ).toBeVisible()
    // What is configured stays in view meanwhile.
    expect(within(dialog).getByText("mine")).toBeVisible()

    vi.mocked(listProviderModels).mockResolvedValue(listed("a-model"))
    await user.click(within(dialog).getByRole("button", { name: "Retry" }))
    expect(await within(dialog).findByText("a-model")).toBeVisible()
    expect(within(dialog).getByText("Not listed")).toBeVisible()
    expect(
      within(dialog).getByText("1 selected · 1 model · relay.test")
    ).toBeVisible()
  })
})
