import {
  fireEvent,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  DeepSeekModelListEditor,
  deepSeekAcceptsImages,
  deepSeekImageBudgetMode,
  pruneEmpty,
  setDeepSeekImageBudgetMode,
  setDeepSeekImageSupport,
  validateDeepSeekModels,
} from "./deepseek-model-list-editor"
import { loadDeepSeekModelCatalog, updateDeepSeekModelCatalog } from "@/lib/api"
import enMessages from "@/i18n/messages/en.json"
import type { DeepSeekCatalogModel, DeepSeekModelCatalog } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  loadDeepSeekModelCatalog: vi.fn(),
  updateDeepSeekModelCatalog: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

/** The catalog `deepseek-acp` 0.9.0 declares, which is what a session inherits
 *  when the settings document stores none. A third row is kept so the list
 *  tests still exercise more than a pair. */
const DEFAULTS: DeepSeekCatalogModel[] = [
  {
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    imagePixelBudget: 640_000,
    imageMaxBytes: 1_048_576,
    systemPromptUpdate: "in-history",
  },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: 1_000_000 },
  { id: "gw-internal", name: "Internal gateway", contextWindow: 128_000 },
]

function catalog(
  patch: Partial<DeepSeekModelCatalog> = {}
): DeepSeekModelCatalog {
  return {
    path: "/home/u/.dsh/settings.yaml",
    exists: true,
    configured: true,
    models: DEFAULTS,
    error: null,
    invalid: null,
    ...patch,
  }
}

async function renderEditor(next: DeepSeekModelCatalog, launchModel?: string) {
  vi.mocked(loadDeepSeekModelCatalog).mockResolvedValue(next)
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DeepSeekModelListEditor launchModel={launchModel} />
    </NextIntlClientProvider>
  )
  // Settles on both branches: an unreadable document renders no editor at all.
  await waitForElementToBeRemoved(() =>
    screen.queryByText(/Reading the settings document/i)
  )
}

const idField = (index: number) =>
  screen.getAllByLabelText("Model id")[index] as HTMLInputElement

describe("validateDeepSeekModels", () => {
  it("accepts what the agent accepts", () => {
    expect(
      validateDeepSeekModels([
        { id: "a" },
        { id: "b", contextWindow: 1, maxTokens: 2 },
        {
          id: "c",
          inputModalities: ["text", "image"],
          imagePixelBudget: 3,
          imageMaxBytes: 4,
        },
        // The named tier the agent takes in place of a count. No numeric check
        // can judge it, so it has to be let through by name.
        {
          id: "d",
          inputModalities: ["text", "image"],
          imagePixelBudget: "low",
        },
      ])
    ).toBeNull()
  })

  it("names the first offending row, not all of them", () => {
    expect(validateDeepSeekModels([{ id: "a" }, { id: " " }])).toEqual({
      kind: "missingId",
      index: 1,
    })
    // Ids are compared trimmed — the backend stores them trimmed, so two rows
    // differing only in whitespace would collide once written.
    expect(validateDeepSeekModels([{ id: "a" }, { id: " a " }])).toEqual({
      kind: "duplicateId",
      index: 1,
      id: "a",
    })
  })

  it("rejects the numbers the agent would reject", () => {
    // Zero and negatives are out; so is anything past MAX_SAFE_INTEGER, which
    // the agent judges with `Number.isSafeInteger`.
    expect(validateDeepSeekModels([{ id: "a", contextWindow: 0 }])).toEqual({
      kind: "badContextWindow",
      index: 0,
      id: "a",
    })
    expect(validateDeepSeekModels([{ id: "a", maxTokens: -1 }])).toEqual({
      kind: "badMaxTokens",
      index: 0,
      id: "a",
    })
    expect(
      validateDeepSeekModels([{ id: "a", contextWindow: 1.5 }])
    ).not.toBeNull()
    expect(
      validateDeepSeekModels([
        { id: "a", maxTokens: Number.MAX_SAFE_INTEGER + 2 },
      ])
    ).not.toBeNull()
    expect(
      validateDeepSeekModels([
        { id: "a", inputModalities: ["text", "image"], imageMaxBytes: 0 },
      ])
    ).toEqual({ kind: "badImageLimit", index: 0, id: "a" })
    // A count of zero is still a count, named tier or not.
    expect(
      validateDeepSeekModels([
        { id: "a", inputModalities: ["text", "image"], imagePixelBudget: 0 },
      ])
    ).toEqual({ kind: "badImageLimit", index: 0, id: "a" })
  })
})

describe("setDeepSeekImageSupport", () => {
  it("carries the image-only fields in and out with the modality", () => {
    const on = setDeepSeekImageSupport({ id: "a" }, true)
    expect(deepSeekAcceptsImages(on)).toBe(true)
    expect(on.inputModalities).toEqual(["text", "image"])

    // Turning images off drops the fields the agent refuses on a text-only
    // entry — leaving them would make it reject the whole catalog.
    const off = setDeepSeekImageSupport(
      {
        id: "a",
        inputModalities: ["text", "image"],
        imagePixelBudget: 1,
        imageMaxBytes: 2,
      },
      false
    )
    expect(off).toEqual({ id: "a" })
  })
})

describe("the image pixel budget's two kinds", () => {
  it("reads a count, the named tier, and nothing at all", () => {
    expect(deepSeekImageBudgetMode({ id: "a" })).toBe("pixels")
    expect(deepSeekImageBudgetMode({ id: "a", imagePixelBudget: 1 })).toBe(
      "pixels"
    )
    expect(deepSeekImageBudgetMode({ id: "a", imagePixelBudget: "low" })).toBe(
      "low"
    )
  })

  it("survives a move to the named tier and back", () => {
    // Moving to a count CLEARS the field rather than seeding a number: empty
    // is "inherit the agent's default" throughout this editor, and seeding
    // would store a budget the user never picked.
    const low = setDeepSeekImageBudgetMode(
      { id: "a", imagePixelBudget: 262_144 },
      "low"
    )
    expect(low.imagePixelBudget).toBe("low")
    const back = setDeepSeekImageBudgetMode(low, "pixels")
    expect(back).toEqual({ id: "a" })
    expect(deepSeekImageBudgetMode(back)).toBe("pixels")
  })
})

describe("DeepSeekModelListEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(updateDeepSeekModelCatalog).mockResolvedValue(undefined)
  })

  it("shows the stored list and saves an edited copy of it", async () => {
    await renderEditor(catalog())
    expect(screen.getAllByLabelText("Model id")).toHaveLength(3)

    fireEvent.change(idField(0), { target: { value: "gw-flash" } })
    fireEvent.click(screen.getByRole("button", { name: /save model list/i }))

    await waitFor(() =>
      expect(updateDeepSeekModelCatalog).toHaveBeenCalledTimes(1)
    )
    const saved = vi.mocked(updateDeepSeekModelCatalog).mock
      .calls[0][0] as DeepSeekCatalogModel[]
    expect(saved[0].id).toBe("gw-flash")
    expect(saved).toHaveLength(3)
    // It re-reads afterwards, so what is on screen is what actually landed.
    expect(loadDeepSeekModelCatalog).toHaveBeenCalledTimes(2)
  })

  it("offers the first save even when the inherited rows are untouched", async () => {
    // Storing the built-in list is a real change of state: it pins the catalog
    // against a later agent version shipping a different one.
    await renderEditor(catalog({ configured: false }))
    const save = screen.getByRole("button", { name: /save model list/i })
    expect(save).toBeEnabled()
    // ...and there is nothing to restore yet.
    expect(
      screen.queryByRole("button", { name: /use agent defaults/i })
    ).toBeNull()
  })

  it("blocks the save while a row is unusable, and says which model", async () => {
    await renderEditor(catalog())
    fireEvent.change(idField(1), { target: { value: "deepseek-flash" } })

    expect(
      screen.getByRole("button", { name: /save model list/i })
    ).toBeDisabled()
    expect(
      screen.getByText(/Two models share the id .deepseek-flash./)
    ).toBeInTheDocument()
    expect(idField(1)).toHaveAttribute("aria-invalid", "true")
  })

  it("clears the list through the same call an empty list makes", async () => {
    await renderEditor(catalog())
    fireEvent.click(screen.getByRole("button", { name: /use agent defaults/i }))
    await waitFor(() =>
      expect(updateDeepSeekModelCatalog).toHaveBeenCalledWith(null)
    )
  })

  it("warns when a single model would remove the picker entirely", async () => {
    await renderEditor(catalog({ models: [DEFAULTS[0]] }))
    expect(
      screen.getByText(/stops offering a model picker/i)
    ).toBeInTheDocument()
  })

  it("warns when new sessions would start on a model outside the list", async () => {
    // No `DEEPSEEK_ACP_MODEL` set: the agent's own launch default applies, and
    // it is missing here.
    await renderEditor(catalog({ models: [{ id: "gw-only" }] }))
    expect(
      screen.getByText(/New sessions start on .deepseek-flash./)
    ).toBeInTheDocument()
  })

  it("stays quiet when the launch model set in the env is in the list", async () => {
    await renderEditor(catalog({ models: [{ id: "gw-only" }] }), "gw-only")
    expect(screen.queryByText(/New sessions start on/)).toBeNull()
  })

  it("refuses to edit a document it could not read", async () => {
    await renderEditor(
      catalog({
        configured: false,
        error: "`llm-deepseek.models` is not a list",
      })
    )
    expect(screen.getByText(/cannot be edited from here/i)).toBeInTheDocument()
    // No editor, no save button: overwriting would replace a document codeg
    // never understood.
    expect(
      screen.queryByRole("button", { name: /save model list/i })
    ).toBeNull()
    expect(screen.queryByLabelText("Model id")).toBeNull()
  })

  it("says so when the stored list is one the agent refuses", async () => {
    // Understood, but not loadable: the agent keeps its built-in catalog, so
    // the rows must not read as "what a session can pick" — and they stay
    // editable, because fixing them is the point.
    await renderEditor(
      catalog({
        models: [{ id: "same" }, { id: "same" }],
        invalid: 'duplicate model id "same"',
      })
    )
    expect(screen.getByText(/agent refuses/i)).toBeInTheDocument()
    expect(screen.getByText(/duplicate model id/)).toBeInTheDocument()
    expect(screen.getAllByLabelText("Model id")).toHaveLength(2)
  })

  it("still offers the save when the repair is invisible in the rows", async () => {
    // A duplicated modality is normalized away by `pruneEmpty`, so the draft
    // and the stored list compare equal — but the stored one is refused by the
    // agent, and writing the normalized rows back is exactly the repair. Save
    // must not be dead here.
    await renderEditor(
      catalog({
        models: [
          {
            id: "a",
            inputModalities: ["text", "text"] as ("text" | "image")[],
          },
        ],
        invalid: 'model "a" repeats the input modality "text"',
      })
    )
    const save = screen.getByRole("button", { name: /save model list/i })
    expect(save).toBeEnabled()

    fireEvent.click(save)
    await waitFor(() =>
      expect(updateDeepSeekModelCatalog).toHaveBeenCalledTimes(1)
    )
    // What is written is the normalized row the switch actually shows.
    expect(vi.mocked(updateDeepSeekModelCatalog).mock.calls[0][0]).toEqual([
      { id: "a" },
    ])
  })

  it("shows a named pixel budget as the tier it is, not as an empty box", async () => {
    // `"low"` is not a number, so the count input cannot hold it. Rendering it
    // there would show an empty field over a budget that IS set, and the first
    // keystroke would overwrite the tier with a count.
    await renderEditor(
      catalog({
        models: [
          { id: "gw", inputModalities: ["text", "image"] },
          {
            id: "gw-low",
            inputModalities: ["text", "image"],
            imagePixelBudget: "low",
          },
        ],
      })
    )
    fireEvent.click(screen.getAllByRole("button", { name: /more/i })[1])

    expect(screen.getByText(/Low detail \(512×512\)/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Pixel count")).toBeNull()
  })

  it("freezes the rows while a save is in flight", async () => {
    // The request carries a snapshot of the draft and the response reseeds it,
    // so an edit typed during the save would be written over with no dirty
    // state left to show for it.
    let release: () => void = () => {}
    vi.mocked(updateDeepSeekModelCatalog).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        })
    )
    await renderEditor(catalog())
    fireEvent.change(idField(0), { target: { value: "gw-flash" } })
    fireEvent.click(screen.getByRole("button", { name: /save model list/i }))

    await waitFor(() => expect(idField(0)).toBeDisabled())
    expect(screen.getByRole("button", { name: /add model/i })).toBeDisabled()
    expect(screen.getAllByLabelText("Display name")[0]).toBeDisabled()
    expect(
      screen.getAllByRole("button", { name: /remove model/i })[0]
    ).toBeDisabled()

    release()
    await waitFor(() => expect(idField(0)).toBeEnabled())
  })
})

describe("pruneEmpty", () => {
  it("normalizes a hand-written modality list to what the switch shows", () => {
    // A file can hold shapes this editor cannot express; saving must not carry
    // them through, because the agent rejects the whole catalog over one of
    // them.
    expect(
      pruneEmpty({
        id: "a",
        inputModalities: ["text", "text"] as ("text" | "image")[],
      }).inputModalities
    ).toBeUndefined()
    expect(
      pruneEmpty({
        id: "a",
        inputModalities: ["image", "text", "image"] as ("text" | "image")[],
      }).inputModalities
    ).toEqual(["text", "image"])
    // Image-only is legal upstream and is left alone.
    expect(
      pruneEmpty({ id: "a", inputModalities: ["image"] }).inputModalities
    ).toEqual(["image"])
    // Image limits never survive on a text-only entry — including the named
    // pixel tier, which the agent refuses there just as firmly as a count.
    expect(
      pruneEmpty({ id: "a", imageMaxBytes: 5, imagePixelBudget: "low" })
    ).toEqual({ id: "a" })
  })

  it("trims and drops what the backend would drop anyway", () => {
    expect(pruneEmpty({ id: " a ", name: "  ", description: " d " })).toEqual({
      id: "a",
      description: "d",
    })
  })

  it("carries through the prompt-update mode it has no control for", () => {
    // The editor never shows this field, so nothing would flag its loss — and
    // losing it does not fail either, it just moves that model to the other
    // system-prompt delivery mode. It has to ride along untouched.
    expect(
      pruneEmpty({
        id: "a",
        inputModalities: ["text", "image"],
        imagePixelBudget: "low",
        systemPromptUpdate: "in-history",
      })
    ).toEqual({
      id: "a",
      inputModalities: ["text", "image"],
      imagePixelBudget: "low",
      systemPromptUpdate: "in-history",
    })
  })
})
