import { render, screen, cleanup, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  AgentConfigSection,
  effectiveSelections,
  snapshotLabels,
} from "./agent-config-section"
import type { AgentOptionsSnapshot } from "@/lib/types"

const SNAPSHOT: AgentOptionsSnapshot = {
  modes: null,
  available_commands: [],
  config_options: [
    {
      id: "model",
      name: "Model",
      description: "Which model answers",
      category: null,
      kind: {
        type: "select",
        current_value: "opus",
        options: [
          { value: "opus", name: "Opus", description: "The deep one" },
          { value: "haiku", name: "Haiku", description: "The quick one" },
        ],
        groups: [],
      },
    },
  ],
}

function renderSection(layout: "inline" | "stacked") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AgentConfigSection
        snapshot={SNAPSHOT}
        loading={false}
        error={null}
        onReload={vi.fn()}
        modeId={null}
        configValues={{}}
        onModeChange={vi.fn()}
        onConfigChange={vi.fn()}
        layout={layout}
      />
    </NextIntlClientProvider>
  )
}

// The automation editor's and task editor's composer chips carry the same
// subtitles the chat composer's selectors do: a blurb per option row, and the
// option's own blurb under the chip's hover hint.
describe("AgentConfigSection subtitles", () => {
  afterEach(() => cleanup())

  it("gives every option row its description", async () => {
    const user = userEvent.setup()
    renderSection("inline")

    await user.click(screen.getByRole("combobox"))
    const list = await screen.findByRole("listbox")
    expect(within(list).getByText("The deep one")).toBeInTheDocument()
    expect(within(list).getByText("The quick one")).toBeInTheDocument()
  })

  it("keeps the description off the closed chip", () => {
    // Radix mirrors an item's `ItemText` into the trigger to render
    // `SelectValue`. A description rendered inside it would print on the chip
    // too and double the composer bar's height — hence it lives outside.
    renderSection("inline")

    const trigger = screen.getByRole("combobox")
    expect(trigger).toHaveTextContent("Opus")
    expect(trigger).not.toHaveTextContent("The deep one")
  })

  it("hangs the option's own blurb under the inline chip's hover hint", async () => {
    const user = userEvent.setup()
    renderSection("inline")

    const trigger = screen.getByRole("combobox")
    expect(trigger).not.toHaveAttribute("title")

    await user.hover(trigger)
    const tip = await screen.findByRole("tooltip")
    expect(tip).toHaveTextContent("Model")
    expect(tip).toHaveTextContent("Which model answers")
  })

  it("shows no hover hint in the stacked layout, which labels itself", async () => {
    const user = userEvent.setup()
    renderSection("stacked")

    // The visible <label> carries the name here, so the chip-only hint would
    // just be a second copy of it.
    expect(screen.getByText("Model")).toBeInTheDocument()
    await user.hover(screen.getByRole("combobox"))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})

const SWITCHED: AgentOptionsSnapshot = {
  ...SNAPSHOT,
  config_options: [
    ...SNAPSHOT.config_options,
    {
      id: "fast",
      name: "Fast",
      description: null,
      category: null,
      kind: { type: "boolean", current_value: true },
    },
  ],
  unapplied_config_ids: [],
}

function renderWith(
  props: Partial<Parameters<typeof AgentConfigSection>[0]> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AgentConfigSection
        snapshot={SWITCHED}
        loading={false}
        error={null}
        onReload={vi.fn()}
        modeId={null}
        configValues={{}}
        onModeChange={vi.fn()}
        onConfigChange={vi.fn()}
        layout="stacked"
        {...props}
      />
    </NextIntlClientProvider>
  )
}

describe("AgentConfigSection staleness and switches", () => {
  afterEach(() => cleanup())

  it("shows a snapshot probed for a previous selection as loading", () => {
    renderWith({ stale: true })
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(screen.getByText("Loading options…")).toBeInTheDocument()
  })

  it("still shows a probe error over a stale snapshot", () => {
    renderWith({ stale: true, error: "not signed in" })
    expect(screen.getByText("not signed in")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })

  it("says when the agent did not switch to the selected model, leaving the options editable", async () => {
    const onReload = vi.fn()
    const user = userEvent.setup()
    renderWith({
      snapshot: { ...SWITCHED, unapplied_config_ids: ["model"] },
      onReload,
    })
    expect(
      screen.getByText(/didn't switch to the selected model/)
    ).toBeInTheDocument()
    expect(screen.getAllByRole("combobox")).toHaveLength(2)
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it("still says so when the agent then lists nothing at all", () => {
    const empty: AgentOptionsSnapshot = {
      modes: null,
      config_options: [],
      available_commands: [],
      unapplied_config_ids: ["model"],
    }
    renderWith({ snapshot: empty })
    expect(
      screen.getByText(/didn't switch to the selected model/)
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    cleanup()
    renderWith({ snapshot: empty, layout: "inline" })
    expect(
      screen.getByText(/didn't switch to the selected model/)
    ).toBeInTheDocument()
  })

  it("offers a switch as On / Off, with the agent default in the stacked layout", async () => {
    const onConfigChange = vi.fn()
    const user = userEvent.setup()
    renderWith({ onConfigChange })
    const fast = screen.getByRole("combobox", { name: "Fast" })
    expect(fast).toHaveTextContent("Agent default")
    await user.click(fast)
    const list = await screen.findByRole("listbox")
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual(["Agent default", "On", "Off"])
    await user.click(within(list).getByRole("option", { name: "Off" }))
    expect(onConfigChange).toHaveBeenLastCalledWith("fast", "false")
  })

  it("shows a switch's current state in the inline layout, which has no default item", async () => {
    const user = userEvent.setup()
    renderWith({ layout: "inline" })
    const fast = screen.getByRole("combobox", { name: "Fast" })
    expect(fast).toHaveTextContent("On")
    await user.click(fast)
    const list = await screen.findByRole("listbox")
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual(["On", "Off"])
  })
})

describe("effectiveSelections and snapshotLabels with switches", () => {
  it("pins a switch's shown state like any other option", () => {
    expect(effectiveSelections(SWITCHED, null, {})).toEqual({
      mode_id: null,
      config_values: { model: "opus", fast: "true" },
    })
    expect(
      effectiveSelections(SWITCHED, null, { fast: "false" }).config_values
    ).toEqual({ model: "opus", fast: "false" })
  })

  it("names a switch's value when given the words for it", () => {
    const labels = { on: "On", off: "Off" }
    expect(
      snapshotLabels(SWITCHED, null, { model: "haiku", fast: "false" }, labels)
    ).toEqual({ config_labels: { model: "Haiku", fast: "Off" } })
    // Without them a switch gets no label, as before.
    expect(
      snapshotLabels(SWITCHED, null, { model: "haiku", fast: "false" })
    ).toEqual({ config_labels: { model: "Haiku" } })
  })
})
