import {
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  DEEPSEEK_PROVIDER_APIS,
  DeepSeekProviderRoutesEditor,
  isUsableBaseUrl,
  pruneRoute,
  validateDeepSeekProviderRoutes,
} from "./deepseek-provider-routes-editor"
import {
  loadDeepSeekProviderRoutes,
  updateDeepSeekProviderRoutes,
} from "@/lib/api"
import enMessages from "@/i18n/messages/en.json"
import type { DeepSeekProviderRoute, DeepSeekProviderRoutes } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  loadDeepSeekProviderRoutes: vi.fn(),
  updateDeepSeekProviderRoutes: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// Rendering the editor pulls in the whole agent-settings message bundle and a
// 28-entry Select; under the full parallel suite that can exceed the default
// 5 s per test on a loaded machine.
vi.setConfig({ testTimeout: 20_000 })

const BRIDGE = "/home/u/.dsh/deepseek-acp/settings.yaml"
const LEGACY = "/home/u/.dsh/settings.yaml"

function routes(
  patch: Partial<DeepSeekProviderRoutes> = {}
): DeepSeekProviderRoutes {
  return {
    path: BRIDGE,
    exists: true,
    configured: true,
    source: BRIDGE,
    routes: [{ id: "opencode-go", apiKeyEnv: "OPENCODE_GO_API_KEY" }],
    error: null,
    invalid: null,
    ...patch,
  }
}

async function renderEditor(next: DeepSeekProviderRoutes) {
  vi.mocked(loadDeepSeekProviderRoutes).mockResolvedValue(next)
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DeepSeekProviderRoutesEditor />
    </NextIntlClientProvider>
  )
  await waitForElementToBeRemoved(() =>
    screen.queryByText(/Reading the provider settings document/i)
  )
}

beforeEach(() => {
  vi.mocked(loadDeepSeekProviderRoutes).mockReset()
  vi.mocked(updateDeepSeekProviderRoutes).mockReset()
})

describe("validateDeepSeekProviderRoutes", () => {
  const route = (patch: Partial<DeepSeekProviderRoute> = {}) => ({
    id: "opencode-go",
    ...patch,
  })

  it("accepts a catalog route with only a credential reference", () => {
    expect(validateDeepSeekProviderRoutes([{ id: "opencode-go" }])).toBeNull()
    expect(validateDeepSeekProviderRoutes([route()])).toBeNull()
  })

  it("takes any non-empty route id, as pi-ai does", () => {
    expect(validateDeepSeekProviderRoutes([route({ id: "" })])).toEqual({
      kind: "missingId",
      index: 0,
    })
    expect(validateDeepSeekProviderRoutes([route({ id: "  " })])).toEqual({
      kind: "missingId",
      index: 0,
    })
    // A hand-declared gateway outside the credential-key grammar is served
    // (it authenticates through apiKeyEnv), so it must not block a save.
    expect(
      validateDeepSeekProviderRoutes([route({ id: "my_gateway" })])
    ).toBeNull()
    // Trailing whitespace is trimmed before the id is judged.
    expect(
      validateDeepSeekProviderRoutes([route({ id: " opencode-go " })])
    ).toBeNull()
  })

  it("accepts every protocol pi-ai serves", () => {
    for (const api of DEEPSEEK_PROVIDER_APIS) {
      expect(validateDeepSeekProviderRoutes([route({ api })])).toBeNull()
    }
  })

  it("rejects duplicated ids, bad references, protocols and endpoints", () => {
    expect(
      validateDeepSeekProviderRoutes([route(), route({ id: "opencode-go" })])
    ).toEqual({ kind: "duplicateId", index: 1, id: "opencode-go" })
    expect(
      validateDeepSeekProviderRoutes([route({ apiKeyEnv: "not a ref" })])
    ).toEqual({ kind: "badApiKeyEnv", index: 0, id: "opencode-go" })
    expect(
      validateDeepSeekProviderRoutes([
        // @ts-expect-error -- the UI only offers served protocols; a stored
        // document may carry anything, which is what this rejects.
        route({ api: "bedrock-converse-stream" }),
      ])
    ).toEqual({ kind: "badApi", index: 0, id: "opencode-go" })
    expect(
      validateDeepSeekProviderRoutes([route({ baseURL: "ftp://gateway/v1" })])
    ).toEqual({ kind: "badBaseUrl", index: 0, id: "opencode-go" })
    expect(
      validateDeepSeekProviderRoutes([
        route({ baseURL: "https://user:pw@gateway/v1" }),
      ])
    ).toEqual({ kind: "badBaseUrl", index: 0, id: "opencode-go" })
    expect(
      validateDeepSeekProviderRoutes([
        route({ baseURL: "https://gateway/v1?x=1" }),
      ])
    ).toEqual({ kind: "badBaseUrl", index: 0, id: "opencode-go" })
  })
})

describe("isUsableBaseUrl", () => {
  it("takes http(s) endpoints without credentials or suffixes", () => {
    expect(isUsableBaseUrl("https://gateway.example/v1")).toBe(true)
    expect(isUsableBaseUrl("http://localhost:8080")).toBe(true)
    expect(isUsableBaseUrl("https://gateway.example/v1#frag")).toBe(false)
    expect(isUsableBaseUrl("https://gateway.example/v1?key=1")).toBe(false)
    expect(isUsableBaseUrl("gateway.example/v1")).toBe(false)
  })
})

describe("pruneRoute", () => {
  it("trims and drops blank optional fields", () => {
    expect(
      pruneRoute({
        id: " opencode-go ",
        apiKeyEnv: " OPENCODE_GO_API_KEY ",
        displayName: "   ",
        baseURL: "",
      })
    ).toEqual({ id: "opencode-go", apiKeyEnv: "OPENCODE_GO_API_KEY" })
  })
})

describe("DeepSeekProviderRoutesEditor", () => {
  it("lists the stored routes and saves a reference the user types", async () => {
    const user = userEvent.setup()
    await renderEditor(routes())
    vi.mocked(updateDeepSeekProviderRoutes).mockResolvedValue(undefined)

    const field = screen.getByLabelText("API key reference")
    expect(field).toHaveValue("OPENCODE_GO_API_KEY")
    await user.clear(field)
    await user.type(field, "OPENCODE_API_KEY")
    await user.click(screen.getByRole("button", { name: "Save providers" }))

    await waitFor(() =>
      expect(updateDeepSeekProviderRoutes).toHaveBeenCalledWith([
        { id: "opencode-go", apiKeyEnv: "OPENCODE_API_KEY" },
      ])
    )
  })

  it("adds a provider the document does not have yet", async () => {
    const user = userEvent.setup()
    await renderEditor(routes({ configured: false, routes: [] }))
    vi.mocked(updateDeepSeekProviderRoutes).mockResolvedValue(undefined)

    await user.click(screen.getByRole("button", { name: "Add provider" }))
    // The first unused catalog provider, which keeps the row valid without a
    // second interaction.
    expect(screen.getByLabelText("Provider")).toHaveTextContent("Anthropic")
    await user.click(screen.getByRole("button", { name: "Save providers" }))
    await waitFor(() =>
      expect(updateDeepSeekProviderRoutes).toHaveBeenCalledWith([
        { id: "anthropic" },
      ])
    )
  })

  it("switches a row to OpenCode Go from the picker", async () => {
    const user = userEvent.setup()
    await renderEditor(routes({ configured: false, routes: [] }))
    vi.mocked(updateDeepSeekProviderRoutes).mockResolvedValue(undefined)

    await user.click(screen.getByRole("button", { name: "Add provider" }))
    await user.click(screen.getByRole("combobox", { name: "Provider" }))
    await user.click(await screen.findByRole("option", { name: "OpenCode Go" }))
    await user.click(screen.getByRole("button", { name: "Save providers" }))
    await waitFor(() =>
      expect(updateDeepSeekProviderRoutes).toHaveBeenCalledWith([
        { id: "opencode-go" },
      ])
    )
  })

  it("offers clearing every route", async () => {
    const user = userEvent.setup()
    await renderEditor(routes())
    vi.mocked(updateDeepSeekProviderRoutes).mockResolvedValue(undefined)

    await user.click(screen.getByRole("button", { name: "Remove all routes" }))
    await waitFor(() =>
      expect(updateDeepSeekProviderRoutes).toHaveBeenCalledWith(null)
    )
  })

  it("says which legacy document imported routes came from", async () => {
    await renderEditor(
      routes({ exists: false, source: LEGACY, routes: [{ id: "opencode" }] })
    )
    // Both halves are on screen: where the rows came from, and where a save
    // will put them.
    expect(screen.getByText(LEGACY)).toBeInTheDocument()
    expect(screen.getByText(BRIDGE)).toBeInTheDocument()
  })

  it("refuses to edit a document it could not read", async () => {
    await renderEditor(
      routes({
        error: "`llm-pi-ai.providers` is not a mapping",
        routes: [],
      })
    )
    expect(screen.getByText(/cannot be edited from here/i)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Save providers" })
    ).not.toBeInTheDocument()
  })

  it("points at the legacy document when that is the one to repair", async () => {
    await renderEditor(
      routes({
        exists: false,
        source: "/home/u/.dsh/settings.yaml",
        error: "`llm-pi-ai.providers` is not a mapping",
        routes: [],
      })
    )
    expect(screen.getByText("/home/u/.dsh/settings.yaml")).toBeInTheDocument()
  })

  it("shows routes the agent refuses as editable rows", async () => {
    await renderEditor(
      routes({
        invalid: 'provider route "Bad" must be a lowercase identifier',
        routes: [{ id: "bad" }],
      })
    )
    expect(
      screen.getByText(/The agent refuses these stored routes/i)
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Provider")).toBeInTheDocument()
  })
})
