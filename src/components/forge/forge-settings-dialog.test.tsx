/**
 * The repository panel's own preferences.
 *
 * Three rules carry this surface. The first: the dialog must not save a form it
 * has not finished loading — the fields start on the built-in defaults, and
 * writing those back would silently overwrite settings the user never saw. The
 * second: the standing instructions the panel appends to every task it mints
 * are keyed by SCENARIO, and a scenario whose text is hidden behind an
 * unselected segment has to be marked, or an instruction typed once disappears
 * from view forever. The third is the scope: a folder either has its own
 * settings or follows the global row, the dialog has to show WHICH from
 * storage rather than guess, and a save must name exactly one scope.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ForgePanelSettings, ForgeSettingsStore } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

const forgeSettingsGet = vi.fn()
const forgeSettingsSet = vi.fn()
vi.mock("@/lib/api", () => ({
  forgeSettingsGet: () => forgeSettingsGet(),
  forgeSettingsSet: (folderId: number | null, s: unknown) =>
    forgeSettingsSet(folderId, s),
}))

const toastError = vi.fn()
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }))

import { ForgeSettingsDialog } from "./forge-settings-dialog"

const GLOBAL: ForgePanelSettings = {
  default_issue_scenario: "plan_first",
  default_pr_scenario: "review_only",
  writeback_default: false,
  scenario_prompts: { all: "Reply in English.", review_fix: "Check the i18n." },
}

const STORED: ForgeSettingsStore = { global: GLOBAL, folders: {} }

function mount(
  { folderId = null as number | null, onSaved = vi.fn() } = {} as {
    folderId?: number | null
    onSaved?: ReturnType<typeof vi.fn>
  }
) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeSettingsDialog
        open
        onOpenChange={vi.fn()}
        folderId={folderId}
        onSaved={onSaved}
      />
    </NextIntlClientProvider>
  )
  return { onSaved }
}

/** Resolved after the load lands — every assertion here is about a seeded
 *  form, and the Save button is the one thing that says the load is done. */
async function mountLoaded(options?: {
  folderId?: number | null
  onSaved?: ReturnType<typeof vi.fn>
}) {
  const handles = mount(options)
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  )
  return handles
}

/** The last blob sent to storage, with the scope it was sent for. */
function lastSave(): { folderId: number | null; settings: ForgePanelSettings } {
  const calls = forgeSettingsSet.mock.calls
  const [folderId, settings] = calls[calls.length - 1] as [
    number | null,
    ForgePanelSettings,
  ]
  return { folderId, settings }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    folders: [
      { id: 4, name: "codeg", parent_id: null, kind: "regular" },
    ] as never,
  })
  forgeSettingsGet.mockResolvedValue(STORED)
  forgeSettingsSet.mockImplementation((folderId, settings) =>
    Promise.resolve(
      folderId == null
        ? { global: settings, folders: {} }
        : { global: GLOBAL, folders: { [String(folderId)]: settings } }
    )
  )
})

describe("ForgeSettingsDialog global scope", () => {
  it("seeds every field from what is stored", async () => {
    await mountLoaded()

    expect(
      screen.getByRole("combobox", { name: "Default for issues" })
    ).toHaveTextContent("Plan first")
    expect(
      screen.getByRole("combobox", {
        name: "Default for pull / merge requests",
      })
    ).toHaveTextContent("Review only")
    expect(
      screen.getByRole("switch", {
        name: /Comment the outcome back by default/,
      })
    ).not.toBeChecked()
    // The strip opens on `all`, so its text is the one in the box.
    expect(screen.getByRole("textbox")).toHaveValue("Reply in English.")
    // No source switch on the global row: there is nothing behind it to
    // follow, so "use the global defaults" is not an answer it can give.
    expect(
      screen.queryByRole("tab", { name: "Custom" })
    ).not.toBeInTheDocument()
  })

  it("saves the whole blob against the global row, with blanks dropped", async () => {
    const user = userEvent.setup()
    const { onSaved } = await mountLoaded()

    await user.click(
      screen.getByRole("switch", {
        name: /Comment the outcome back by default/,
      })
    )
    // Emptying a box must remove the key rather than store an empty string the
    // reader would then have to filter anyway.
    await user.clear(screen.getByRole("textbox"))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(forgeSettingsSet).toHaveBeenCalled())
    const { folderId, settings } = lastSave()
    expect(folderId).toBeNull()
    expect(settings.writeback_default).toBe(true)
    expect(settings.default_issue_scenario).toBe("plan_first")
    expect(settings.scenario_prompts).toEqual({ review_fix: "Check the i18n." })
    // The page is handed the STORED store, so the next trigger dialog opens on
    // it without another read.
    expect(onSaved).toHaveBeenCalledWith({ global: settings, folders: {} })
  })

  it("sends nothing about the remote, which the panel's picker owns", async () => {
    const user = userEvent.setup()
    await mountLoaded()

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(forgeSettingsSet).toHaveBeenCalled())
    // The selection lives in its own store and is written by the picker alone.
    // A settings save must not carry a value a later read would treat as
    // chosen — and must not be able to clear one either: this blob is dropped
    // wholesale by "use the global defaults".
    expect(Object.keys(lastSave().settings).sort()).toEqual([
      "default_issue_scenario",
      "default_pr_scenario",
      "scenario_prompts",
      "writeback_default",
    ])
  })

  it("keeps each scenario's instruction under its own segment, and marks the ones in use", async () => {
    const user = userEvent.setup()
    await mountLoaded()

    await user.click(screen.getByRole("tab", { name: /Review & fix/ }))
    expect(screen.getByRole("textbox")).toHaveValue("Check the i18n.")
    // A scenario with nothing configured shows an empty box, not the previous
    // segment's text.
    await user.click(screen.getByRole("tab", { name: /Plan first/ }))
    expect(screen.getByRole("textbox")).toHaveValue("")

    await user.type(screen.getByRole("textbox"), "Look at the logs.")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(forgeSettingsSet).toHaveBeenCalled())
    expect(lastSave().settings.scenario_prompts).toEqual({
      all: "Reply in English.",
      review_fix: "Check the i18n.",
      plan_first: "Look at the logs.",
    })
  })

  /**
   * Saving a form that never loaded would write the built-in defaults over
   * whatever is stored — the one destructive thing this dialog could do.
   */
  it("refuses to save until the stored values are in the form", async () => {
    let land: (value: ForgeSettingsStore) => void = () => {}
    forgeSettingsGet.mockReturnValue(
      new Promise<ForgeSettingsStore>((resolve) => {
        land = resolve
      })
    )
    mount()

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    land(STORED)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    )
  })

  /** A stored name this build does not offer for that kind must not leave a
   *  select showing nothing — the same guard the trigger dialog applies. */
  it("falls back when a stored default belongs to the other kind", async () => {
    forgeSettingsGet.mockResolvedValue({
      global: {
        ...GLOBAL,
        default_issue_scenario: "review_only",
        default_pr_scenario: "fix",
      },
      folders: {},
    })
    await mountLoaded()

    expect(
      screen.getByRole("combobox", { name: "Default for issues" })
    ).toHaveTextContent("Fix / implement")
    expect(
      screen.getByRole("combobox", {
        name: "Default for pull / merge requests",
      })
    ).toHaveTextContent("Review & fix")
  })

  /** Same guard, for the name this build RETIRED: a saved "investigate only"
   *  default is still sitting in storage, and preselecting it would send the
   *  trigger dialog off with a scenario the server refuses. */
  it("falls back when a stored default names a retired scenario", async () => {
    forgeSettingsGet.mockResolvedValue({
      global: { ...GLOBAL, default_issue_scenario: "investigate" },
      folders: {},
    })
    await mountLoaded()

    expect(
      screen.getByRole("combobox", { name: "Default for issues" })
    ).toHaveTextContent("Fix / implement")
    // And the retired entry is gone from the instruction strip entirely.
    expect(
      screen.queryByRole("tab", { name: /Investigate/ })
    ).not.toBeInTheDocument()
  })

  it("reports a failed save in place rather than closing over it", async () => {
    const user = userEvent.setup()
    const { onSaved } = await mountLoaded()
    forgeSettingsSet.mockRejectedValueOnce(new Error("disk is full"))

    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("disk is full"))
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })
})

describe("ForgeSettingsDialog folder scope", () => {
  /**
   * A folder with nothing of its own is shown as FOLLOWING, and the form is
   * hidden: there is nothing to edit there, only a switch back to custom. The
   * indicator comes from storage rather than from a guess, because "this
   * folder is following" and "this folder happens to hold the same values" are
   * different facts with different futures.
   */
  it("opens a folder that has nothing of its own on the global row", async () => {
    await mountLoaded({ folderId: 4 })

    expect(
      screen.getByText("How issues and changes in codeg are handled.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("tab", { name: "Global defaults" })
    ).toHaveAttribute("aria-selected", "true")
    expect(
      screen.queryByRole("combobox", { name: "Default for issues" })
    ).not.toBeInTheDocument()
  })

  /**
   * Flipping to "custom" starts from what applies TODAY — the global row —
   * rather than from the built-in defaults, so detaching a folder does not
   * silently change the values it was running under.
   */
  it("seeds a detaching folder from the global values it was following", async () => {
    const user = userEvent.setup()
    await mountLoaded({ folderId: 4 })

    await user.click(screen.getByRole("tab", { name: "Custom" }))
    expect(
      screen.getByRole("combobox", { name: "Default for issues" })
    ).toHaveTextContent("Plan first")
    expect(screen.getByRole("textbox")).toHaveValue("Reply in English.")

    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(forgeSettingsSet).toHaveBeenCalled())
    expect(lastSave().folderId).toBe(4)
    expect(lastSave().settings.scenario_prompts).toEqual({
      all: "Reply in English.",
      review_fix: "Check the i18n.",
    })
  })

  it("opens a folder that has its own settings on those, not the global ones", async () => {
    forgeSettingsGet.mockResolvedValue({
      global: GLOBAL,
      folders: {
        "4": {
          default_issue_scenario: "fix",
          writeback_default: true,
          scenario_prompts: { all: "Reply in Chinese." },
        },
      },
    })
    await mountLoaded({ folderId: 4 })

    expect(screen.getByRole("tab", { name: "Custom" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(
      screen.getByRole("combobox", { name: "Default for issues" })
    ).toHaveTextContent("Fix / implement")
    // Its OWN prompts, wholesale — the global `review_fix` entry is not layered
    // underneath, which is the rule the backend applies too.
    expect(screen.getByRole("textbox")).toHaveValue("Reply in Chinese.")
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: /Review & fix/ }))
    expect(screen.getByRole("textbox")).toHaveValue("")
  })

  /** "Use global defaults" is a DELETE of the folder's own row, not a save of
   *  the global values under the folder's id — otherwise the folder would stop
   *  tracking later changes to the global row while still looking like it. */
  it("saves 'follow the global row' as a null blob for that folder", async () => {
    const user = userEvent.setup()
    forgeSettingsGet.mockResolvedValue({
      global: GLOBAL,
      folders: { "4": { writeback_default: true, scenario_prompts: {} } },
    })
    await mountLoaded({ folderId: 4 })

    await user.click(screen.getByRole("tab", { name: "Global defaults" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(forgeSettingsSet).toHaveBeenCalled())
    expect(forgeSettingsSet).toHaveBeenCalledWith(4, null)
  })

  /** Switching scope re-reads that scope rather than carrying the previous
   *  one's fields across — the load is per scope, and so is the form. */
  it("re-seeds when the scope picker moves to the global row", async () => {
    const user = userEvent.setup()
    forgeSettingsGet.mockResolvedValue({
      global: GLOBAL,
      folders: {
        "4": {
          default_issue_scenario: "fix",
          writeback_default: true,
          scenario_prompts: {},
        },
      },
    })
    await mountLoaded({ folderId: 4 })
    expect(
      screen.getByRole("combobox", { name: "Default for issues" })
    ).toHaveTextContent("Fix / implement")

    // The picker's accessible name is whatever it currently shows — the
    // folder — because a button's own text outranks its `title`.
    await user.click(screen.getByRole("button", { name: "codeg" }))
    await user.click(await screen.findByText("All folders (global defaults)"))
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Default for issues" })
      ).toHaveTextContent("Plan first")
    )
    expect(
      screen.queryByRole("tab", { name: "Custom" })
    ).not.toBeInTheDocument()
  })
})
