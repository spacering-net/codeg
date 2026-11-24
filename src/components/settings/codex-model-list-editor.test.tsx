/**
 * The Codex model editor taking its list from a provider: the source switch,
 * fetching, the provider's rows in both shapes, picking ids, and a provider
 * that changed shape.
 */
import { useEffect, useState } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  codexBundledCatalog,
  codexEndpointCatalogCached,
  codexEndpointCatalogPublished,
  codexEndpointCatalogStatus,
  codexFetchEndpointCatalog,
} from "@/lib/api"
import type {
  CodexCatalogStatus,
  CodexEndpointCatalogView,
  CodexModelConfig,
  CodexModelInfo,
} from "@/lib/types"

import type { CodexCatalogEndpoint } from "./codex-catalog-source"
import { CodexModelListEditor } from "./codex-model-list-editor"

vi.mock("@/lib/api", () => ({
  codexBundledCatalog: vi.fn(),
  codexEndpointCatalogCached: vi.fn(),
  codexEndpointCatalogPublished: vi.fn(),
  codexEndpointCatalogStatus: vi.fn(() => new Promise(() => {})),
  codexFetchEndpointCatalog: vi.fn(),
  codexRefreshEndpointCatalog: vi.fn(),
}))

const OFFICIALS: CodexModelInfo[] = [
  { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
  { slug: "gpt-5.5-mini", display_name: "GPT-5.5 mini", visibility: "list" },
]

const ENDPOINT: CodexCatalogEndpoint = {
  baseUrl: "https://relay.test/v1",
  keySource: { kind: "inline", apiKey: "sk-test" },
}

function model(slug: string): CodexModelInfo {
  return { slug, display_name: slug.toUpperCase(), visibility: "list" }
}

function view(
  patch: Partial<CodexEndpointCatalogView> = {}
): CodexEndpointCatalogView {
  return {
    url: "https://relay.test/v1/models",
    host: "relay.test",
    format: "native",
    models: [model("r1"), model("r2")],
    ids: null,
    missing: [],
    counts: { total: 2, listed: 2, usable: 2 },
    bytes: 100,
    elapsedMs: 5,
    clientVersion: "0.160.1",
    clientVersionConfirmed: true,
    requestSeq: 1,
    requestStartedAt: "2026-10-21T10:00:00Z",
    fetchedAt: "2026-10-21T10:00:01Z",
    diff: { added: [], removed: [] },
    keyDigest: "abc",
    warnings: [],
    ...patch,
  }
}

function openAiView(ids: string[]): CodexEndpointCatalogView {
  return view({
    format: "openai_list",
    models: null,
    ids: ids.map((id) => ({
      id,
      contextWindow: null,
      template: id.startsWith("gpt")
        ? { kind: "official", slug: id }
        : { kind: "compat", slug: "gpt-5.5" },
    })),
    counts: { total: ids.length, listed: ids.length, usable: ids.length },
  })
}

let latest: CodexModelConfig = { customs: [] }

function Harness({
  initial,
  endpoint = ENDPOINT,
  readOnly = false,
}: {
  initial: CodexModelConfig
  endpoint?: CodexCatalogEndpoint
  readOnly?: boolean
}) {
  const [value, setValue] = useState(initial)
  return (
    <CodexModelListEditor
      value={value}
      readOnly={readOnly}
      endpoint={endpoint}
      onChange={(next) => {
        latest = next
        setValue(next)
      }}
    />
  )
}

function renderEditor(
  initial: CodexModelConfig,
  props: { endpoint?: CodexCatalogEndpoint; readOnly?: boolean } = {}
) {
  latest = initial
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness initial={initial} {...props} />
    </NextIntlClientProvider>
  )
}

const PROVIDER_RADIO = { name: "From the provider" }

describe("CodexModelListEditor — the provider's list", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(codexBundledCatalog).mockResolvedValue(OFFICIALS)
    vi.mocked(codexEndpointCatalogPublished).mockResolvedValue({
      catalog: null,
      mismatch: "none",
    })
    vi.mocked(codexEndpointCatalogCached).mockResolvedValue({
      catalog: null,
      mismatch: "none",
    })
  })

  it("asks the provider as soon as it becomes the source, and records the shape", async () => {
    const user = userEvent.setup()
    vi.mocked(codexFetchEndpointCatalog).mockResolvedValue(view())
    renderEditor({ customs: [] })
    expect(await screen.findByText("GPT-5.5")).toBeInTheDocument()

    await user.click(screen.getByRole("radio", PROVIDER_RADIO))
    expect(await screen.findByText("R1")).toBeInTheDocument()
    expect(codexFetchEndpointCatalog).toHaveBeenCalledWith({
      baseUrl: "https://relay.test/v1",
      catalogUrl: null,
      keySource: { kind: "inline", apiKey: "sk-test" },
    })
    expect(latest.catalog).toEqual({ format: "native" })
    expect(screen.getByRole("radio", PROVIDER_RADIO)).toBeChecked()
    // How many the provider lists, and from where, atop its rows.
    expect(screen.getByText("2 models · relay.test")).toBeVisible()
    // codex's own officials are not the rows any more.
    expect(screen.queryByText("GPT-5.5")).toBeNull()

    // The bin hides a provider model the way it hides an official.
    const row = screen
      .getByText("R1")
      .closest("[data-model-row]") as HTMLElement
    await user.click(within(row).getByRole("button", { name: "Remove" }))
    expect(latest.excludedOfficials).toEqual(["r1"])
  })

  it("heads codex's own list with its count and a refresh from codex", async () => {
    renderEditor({ customs: [] })
    expect(await screen.findByText("2 models · from codex")).toBeVisible()
    expect(screen.getByRole("radio", { name: "Codex built-in" })).toBeChecked()
    expect(
      screen.getByRole("button", { name: "Refresh from codex" })
    ).toBeEnabled()
    // No provider is asked while codex's own list is the source.
    expect(codexFetchEndpointCatalog).not.toHaveBeenCalled()
  })

  it("counts only the picks the provider still returns, and what was removed", async () => {
    vi.mocked(codexEndpointCatalogPublished).mockResolvedValue({
      catalog: openAiView(["glm-5.2", "kimi-k3"]),
      mismatch: null,
    })
    const picks = renderEditor({
      customs: [],
      catalog: {
        format: "openai_list",
        selected: ["glm-5.2", "kimi-k3", "qwen-4"],
      },
    })
    // A pick it stopped returning is a row of its own, marked; not "3 of 2".
    expect(
      await screen.findByText("2 of 2 picked · relay.test · as applied")
    ).toBeVisible()
    const gone = screen.getByText("qwen-4").closest("[data-model-row]")!
    expect(
      within(gone as HTMLElement).getByText("No longer returned")
    ).toBeVisible()
    picks.unmount()

    vi.mocked(codexEndpointCatalogPublished).mockResolvedValue({
      catalog: view(),
      mismatch: null,
    })
    renderEditor({
      customs: [],
      catalog: { format: "native" },
      excludedOfficials: ["r1"],
    })
    expect(
      await screen.findByText("1 model · relay.test · 1 removed · as applied")
    ).toBeVisible()
  })

  it("says a bound provider manages the list, whatever its source", async () => {
    renderEditor(
      { customs: [] },
      {
        readOnly: true,
        endpoint: {
          ...ENDPOINT,
          keySource: { kind: "provider", providerId: 7 },
          managedBy: "Relay",
        },
      }
    )
    expect(await screen.findByText("Managed by provider “Relay”")).toBeVisible()
    expect(screen.getByText("2 models · from codex")).toBeVisible()
    expect(
      screen.getByRole("radio", { name: "From the provider" })
    ).toBeDisabled()
  })

  it("keeps the list URL folded until it is wanted", async () => {
    const user = userEvent.setup()
    renderEditor({ customs: [], catalog: { format: "native" } })
    const toggle = await screen.findByRole("button", {
      name: "List URL (optional)",
    })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(
      screen.queryByRole("textbox", { name: "List URL (optional)" })
    ).toBeNull()

    await user.click(toggle)
    const field = screen.getByRole("textbox", { name: "List URL (optional)" })
    expect(field).toHaveAttribute("placeholder", "https://relay.test/v1/models")
    await user.type(field, "https://other.test/models")
    expect(latest.catalog?.url).toBe("https://other.test/models")
    expect(
      screen.getByText("The API key will be sent to other.test.")
    ).toBeVisible()
  })

  it("opens the list URL on its own when one is set", async () => {
    renderEditor({
      customs: [],
      catalog: { format: "native", url: "https://relay.test/catalog" },
    })
    expect(
      await screen.findByRole("textbox", { name: "List URL (optional)" })
    ).toHaveValue("https://relay.test/catalog")
  })

  it("drops an answer that arrives after the editor went away", async () => {
    const user = userEvent.setup()
    let answer: (v: CodexEndpointCatalogView) => void = () => {}
    vi.mocked(codexFetchEndpointCatalog).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    function Parent() {
      const [value, setValue] = useState<CodexModelConfig>({ customs: [] })
      const [shown, setShown] = useState(true)
      useEffect(() => {
        latest = value
      }, [value])
      return (
        <>
          <button
            type="button"
            onClick={() => {
              // What switching to the subscription does: the source goes,
              // and with it the editor.
              setValue({ customs: [] })
              setShown(false)
            }}
          >
            subscription
          </button>
          {shown && (
            <CodexModelListEditor
              value={value}
              endpoint={ENDPOINT}
              onChange={setValue}
            />
          )}
        </>
      )
    }
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <Parent />
      </NextIntlClientProvider>
    )
    await user.click(await screen.findByRole("radio", PROVIDER_RADIO))
    await waitFor(() => expect(codexFetchEndpointCatalog).toHaveBeenCalled())
    expect(latest.catalog).toEqual({})

    await user.click(screen.getByRole("button", { name: "subscription" }))
    answer(view())
    await new Promise((r) => setTimeout(r, 0))
    expect(latest).toEqual({ customs: [] })
  })

  it("needs a key before it can fetch", async () => {
    renderEditor(
      { customs: [], catalog: {} },
      { endpoint: { ...ENDPOINT, keySource: null } }
    )
    expect(await screen.findByText("Enter the API key first.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Fetch models" })).toBeDisabled()
    expect(
      screen.getByText("Fetch the provider's models to see them here.")
    ).toBeVisible()
  })

  it("has an OpenAI list picked from, and the picks become the rows", async () => {
    const user = userEvent.setup()
    vi.mocked(codexFetchEndpointCatalog).mockResolvedValue(
      openAiView(["gpt-5.5", "glm-5.2"])
    )
    renderEditor({ customs: [], catalog: {} })
    await user.click(
      await screen.findByRole("button", { name: "Fetch models" })
    )

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Choose models")).toBeVisible()
    const glm = within(dialog).getByText("glm-5.2").closest("label")!
    await user.click(within(glm).getByRole("checkbox"))
    await user.click(
      within(dialog).getByRole("button", { name: "Use 1 model" })
    )

    expect(latest.catalog).toEqual({
      format: "openai_list",
      selected: ["glm-5.2"],
    })
    expect(await screen.findByText("glm-5.2")).toBeVisible()
    expect(screen.getByText("Generic compatible template")).toBeVisible()

    // The bin takes an id out of the allowlist.
    const row = screen.getByText("glm-5.2").closest("[data-model-row]")!
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "Remove" })
    )
    expect(latest.catalog?.selected ?? []).toEqual([])
  })

  it("never uses a list in the other shape as rows, and offers to pick again", async () => {
    const user = userEvent.setup()
    vi.mocked(codexEndpointCatalogPublished).mockResolvedValue({
      catalog: openAiView(["glm-5.2", "kimi-k3"]),
      mismatch: null,
    })
    vi.mocked(codexFetchEndpointCatalog).mockResolvedValue(
      view({ models: [model("glm-5.2"), model("qwen-4")] })
    )
    renderEditor({
      customs: [],
      catalog: { format: "openai_list", selected: ["glm-5.2", "kimi-k3"] },
    })
    expect(await screen.findByText("kimi-k3")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Fetch models" }))
    expect(
      await screen.findByText(/now answers with a Codex catalog/)
    ).toBeVisible()
    // Still the picks of the shape that was applied.
    expect(screen.getByText("kimi-k3")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Pick again" }))
    const dialog = await screen.findByRole("dialog")
    // A pick the new catalog lacks is listed apart, and can stay as a custom.
    expect(
      within(dialog).getByText("1 model goes once you confirm:")
    ).toBeVisible()
    const kimi = within(dialog).getByText("kimi-k3").closest("label")!
    await user.click(within(kimi).getByRole("checkbox"))
    await user.click(
      within(dialog).getByRole("button", { name: "Use 1 model" })
    )

    expect(latest.catalog).toEqual({ format: "native" })
    // What was not picked is hidden; the dropped pick lives on as a custom.
    expect(latest.excludedOfficials).toEqual(["qwen-4"])
    expect(latest.customs.map((c) => c.slug)).toEqual(["kimi-k3"])
  })

  it("says why a fetch failed, in the user's language", async () => {
    const user = userEvent.setup()
    vi.mocked(codexFetchEndpointCatalog).mockRejectedValue({
      code: "authentication_failed",
      message: "the key was rejected (HTTP 401)",
      i18n_key: "codexCatalog.unauthorized",
      i18n_params: { status: "401" },
    })
    renderEditor({ customs: [], catalog: { format: "native" } })
    await user.click(
      await screen.findByRole("button", { name: "Fetch models" })
    )
    expect(
      await screen.findByText(
        "The key is invalid or has no permission (HTTP 401)."
      )
    ).toBeVisible()
  })

  it("shows a bound provider's source without letting it be edited", async () => {
    vi.mocked(codexEndpointCatalogPublished).mockResolvedValue({
      catalog: view(),
      mismatch: null,
    })
    renderEditor(
      { customs: [], catalog: { format: "native" } },
      {
        readOnly: true,
        endpoint: {
          ...ENDPOINT,
          keySource: { kind: "provider", providerId: 7 },
          managedBy: "Relay",
        },
      }
    )
    expect(await screen.findByText("R2")).toBeVisible()
    expect(screen.getByText(/Managed by provider “Relay”/)).toBeVisible()
    expect(screen.queryByRole("button", { name: "Fetch models" })).toBeNull()
    expect(screen.getByRole("radio", PROVIDER_RADIO)).toBeDisabled()
    await waitFor(() =>
      expect(codexEndpointCatalogPublished).toHaveBeenCalledWith({
        baseUrl: "https://relay.test/v1",
        catalogUrl: null,
        keySource: { kind: "provider", providerId: 7 },
        format: "native",
      })
    )
  })
})

function publishedFor(binding: string): CodexCatalogStatus {
  return {
    meta: {
      version: 1,
      intentHash: "h",
      binding,
      validatedBy: [],
      counts: { total: 2, listed: 2, usable: 2 },
      format: "native",
      stale: false,
      diff: { added: [], removed: [] },
    },
    source: null,
    publishesCatalog: true,
    refresh: { inProgress: false } as CodexCatalogStatus["refresh"],
    refreshHours: 24,
    pendingLocalChanges: false,
    catalogUrlHint: false,
    foreignProvider: null,
    missingSelected: [],
    newIds: [],
    runtime: { version: "0.160.1", confirmed: true, adapterVersion: null },
    fetchError: null,
  }
}

describe("CodexModelListEditor — a provider's dialog and what Codex runs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(codexBundledCatalog).mockResolvedValue(OFFICIALS)
    vi.mocked(codexEndpointCatalogPublished).mockResolvedValue({
      catalog: null,
      mismatch: "none",
    })
    vi.mocked(codexEndpointCatalogCached).mockResolvedValue({
      catalog: null,
      mismatch: "none",
    })
  })

  it("shows what is published while Codex is bound to the provider", async () => {
    vi.mocked(codexEndpointCatalogStatus).mockResolvedValue(
      publishedFor("provider:7")
    )
    renderEditor(
      { customs: [], catalog: { format: "native" } },
      { endpoint: { ...ENDPOINT, statusBinding: "provider:7" } }
    )
    expect(await screen.findByText("In use by Codex")).toBeVisible()
  })

  it("says nothing of another provider's published list", async () => {
    vi.mocked(codexEndpointCatalogStatus).mockResolvedValue(
      publishedFor("provider:8")
    )
    renderEditor(
      { customs: [], catalog: { format: "native" } },
      { endpoint: { ...ENDPOINT, statusBinding: "provider:7" } }
    )
    await waitFor(() => expect(codexEndpointCatalogStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText("In use by Codex")).toBeNull()
  })
})
