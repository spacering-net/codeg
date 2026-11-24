import { useState } from "react"
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
import type { AgentOptionsSnapshot, SessionConfigOptionInfo } from "@/lib/types"

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

function renderStacked(configValues: Record<string, string> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AgentConfigSection
        snapshot={SNAPSHOT}
        loading={false}
        error={null}
        onReload={vi.fn()}
        modeId={null}
        configValues={configValues}
        onModeChange={vi.fn()}
        onConfigChange={vi.fn()}
        layout="stacked"
      />
    </NextIntlClientProvider>
  )
}

// The stacked form's select rows carry the same subtitles the chat composer's
// settings do: a blurb per option row, kept off the trigger.
describe("AgentConfigSection subtitles", () => {
  afterEach(() => cleanup())

  it("gives every option row its description", async () => {
    const user = userEvent.setup()
    renderStacked()

    await user.click(screen.getByRole("combobox"))
    const list = await screen.findByRole("listbox")
    expect(within(list).getByText("The deep one")).toBeInTheDocument()
    expect(within(list).getByText("The quick one")).toBeInTheDocument()
  })

  it("keeps the description off the trigger", () => {
    // Radix mirrors an item's `ItemText` into the trigger to render
    // `SelectValue`. A description rendered inside it would print on the
    // trigger too — hence it lives outside.
    renderStacked({ model: "opus" })

    const trigger = screen.getByRole("combobox")
    expect(trigger).toHaveTextContent("Opus")
    expect(trigger).not.toHaveTextContent("The deep one")
  })

  it("shows no hover hint in the stacked layout, which labels itself", async () => {
    const user = userEvent.setup()
    renderStacked()

    // The visible <label> carries the name here, so a hint would just be a
    // second copy of it.
    expect(screen.getByText("Model")).toBeInTheDocument()
    await user.hover(screen.getByRole("combobox"))
    // Past the 300ms the composer's hover hints wait before opening.
    await new Promise((resolve) => setTimeout(resolve, 400))
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
})

const MSGS = enMessages.Folder.chat.messageInput

const EFFORT: SessionConfigOptionInfo = {
  id: "effort",
  name: "Effort",
  description: null,
  category: "thought_level",
  kind: {
    type: "select",
    current_value: "high",
    options: [
      { value: "low", name: "Low", description: null },
      { value: "high", name: "High", description: null },
    ],
    groups: [],
  },
}

const CHIP: AgentOptionsSnapshot = {
  ...SWITCHED,
  config_options: [
    SWITCHED.config_options[0],
    EFFORT,
    SWITCHED.config_options[1],
  ],
}

// The editors own the selections — a pick comes back as the next render's
// `configValues` / `modeId` — so the harness does too.
function renderChip(
  props: Partial<Parameters<typeof AgentConfigSection>[0]> = {}
) {
  const onConfigChange = vi.fn()
  const onModeChange = vi.fn()
  function Editor() {
    const [configValues, setConfigValues] = useState(props.configValues ?? {})
    const [modeId, setModeId] = useState(props.modeId ?? null)
    return (
      <AgentConfigSection
        agentType="claude_code"
        snapshot={CHIP}
        loading={false}
        error={null}
        onReload={vi.fn()}
        layout="inline"
        {...props}
        modeId={modeId}
        configValues={configValues}
        onModeChange={(next) => {
          onModeChange(next)
          setModeId(next)
        }}
        onConfigChange={(id, value) => {
          onConfigChange(id, value)
          setConfigValues((prev) => {
            const next = { ...prev }
            if (value === null) delete next[id]
            else next[id] = value
            return next
          })
        }}
      />
    )
  }
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Editor />
    </NextIntlClientProvider>
  )
  return { onConfigChange, onModeChange }
}

function chip() {
  return screen.getByRole("button", {
    name: new RegExp(`^${MSGS.agentSettings}`),
  })
}

// The chip's merged label (the agent icon carries an SVG <title> of its own).
function chipSummary() {
  return chip().querySelector('[data-slot="settings-summary"]')?.textContent
}

async function openChip(user: ReturnType<typeof userEvent.setup>) {
  await user.click(chip())
  return screen.findByRole("dialog", { name: MSGS.agentSettings })
}

// The automation and task editors' bottom bar is the chat composer's settings
// chip: every value in one chip, each one adjusted in its popover.
describe("AgentConfigSection inline chip", () => {
  afterEach(() => cleanup())

  it("joins every value in one chip, the user's picks over the agent's", () => {
    renderChip({ configValues: { model: "haiku" } })
    expect(chipSummary()).toBe("Haiku/High/Fast")
    expect(chip()).toHaveAccessibleName(
      `${MSGS.agentSettings}: Model Haiku, Effort High, Fast ${MSGS.toggleOn}`
    )
    // One control, not a select per option.
    expect(screen.queryByRole("combobox")).toBeNull()
  })

  it("shows what the editor will save", () => {
    // An untouched option is saved at the agent's current value, so the chip
    // shows that value rather than an "agent default" it would not save.
    renderChip({ configValues: { fast: "false" } })
    expect(chipSummary()).toBe("Opus/High")
    expect(chip()).toHaveAccessibleName(
      `${MSGS.agentSettings}: Model Opus, Effort High, Fast ${MSGS.toggleOff}`
    )
    expect(
      effectiveSelections(CHIP, null, { fast: "false" }).config_values
    ).toEqual({ model: "opus", effort: "high", fast: "false" })
  })

  it("lists every model with its description in the popover, none on the chip", async () => {
    const user = userEvent.setup()
    renderChip()
    expect(chip()).not.toHaveTextContent("The deep one")
    const popover = await openChip(user)
    const opus = within(popover).getByRole("button", { name: /Opus/ })
    expect(opus).toHaveAttribute("aria-current", "true")
    expect(opus).toHaveTextContent("The deep one")
    expect(
      within(popover).getByRole("button", { name: /Haiku/ })
    ).toHaveTextContent("The quick one")
  })

  it("applies each pick at once and stays open for the next", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = renderChip()
    const popover = await openChip(user)

    const effort = within(popover).getByRole("group", { name: "Effort" })
    await user.click(within(effort).getByRole("button", { name: "Low" }))
    expect(onConfigChange).toHaveBeenLastCalledWith("effort", "low")
    expect(chipSummary()).toBe("Opus/Low/Fast")

    await user.click(within(popover).getByRole("switch", { name: "Fast" }))
    expect(onConfigChange).toHaveBeenLastCalledWith("fast", "false")
    expect(chipSummary()).toBe("Opus/Low")
    expect(
      screen.getByRole("dialog", { name: MSGS.agentSettings })
    ).toBeInTheDocument()
  })

  it("edits the mode list of an agent that has no config options", async () => {
    const user = userEvent.setup()
    const { onModeChange } = renderChip({
      snapshot: {
        modes: {
          current_mode_id: "default",
          available_modes: [
            { id: "default", name: "Default", description: null },
            { id: "plan", name: "Plan", description: "Plan first" },
          ],
        },
        config_options: [],
        available_commands: [],
        unapplied_config_ids: [],
      },
    })
    // A `default` value is left out of the label — unless it is all there is.
    expect(chipSummary()).toBe("Default")
    const popover = await openChip(user)
    const mode = within(popover).getByRole("group", { name: "Mode" })
    await user.click(within(mode).getByRole("button", { name: "Plan" }))
    expect(onModeChange).toHaveBeenLastCalledWith("plan")
    expect(chipSummary()).toBe("Plan")
  })

  it("names the agent's options in the reader's language", () => {
    // deepseek-acp titles its model picker in Chinese.
    renderChip({
      agentType: "deepseek",
      snapshot: {
        ...CHIP,
        config_options: [
          {
            id: "model",
            name: "模型",
            description: null,
            category: "model",
            kind: {
              type: "select",
              current_value: "deepseek-flash",
              options: [
                {
                  value: "deepseek-flash",
                  name: "DeepSeek Flash",
                  description: null,
                },
              ],
              groups: [],
            },
          },
        ],
      },
    })
    expect(chip()).toHaveAccessibleName(
      `${MSGS.agentSettings}: Model DeepSeek Flash`
    )
  })

  it("flips an on/off select picked on as a switch, with the agent's own values", async () => {
    // Claude's and Codex's "Fast mode" is a two-value select, not a boolean.
    const user = userEvent.setup()
    const { onConfigChange } = renderChip({
      configValues: { fast_mode: "on" },
      snapshot: {
        ...CHIP,
        config_options: [
          SWITCHED.config_options[0],
          {
            id: "fast_mode",
            name: "Fast mode",
            description: null,
            category: "model_config",
            kind: {
              type: "select",
              current_value: "off",
              options: [
                { value: "off", name: "Off", description: null },
                { value: "on", name: "On", description: null },
              ],
              groups: [],
            },
          },
        ],
      },
    })
    expect(chipSummary()).toBe("Opus/Fast mode")
    const popover = await openChip(user)
    const fast = within(popover).getByRole("switch", { name: "Fast mode" })
    expect(fast).toHaveAttribute("aria-checked", "true")
    await user.click(fast)
    expect(onConfigChange).toHaveBeenLastCalledWith("fast_mode", "off")
    expect(chipSummary()).toBe("Opus")
  })

  it("keeps the not-switched notice beside the chip", () => {
    renderChip({ snapshot: { ...CHIP, unapplied_config_ids: ["model"] } })
    expect(
      screen.getByText(/didn't switch to the selected model/)
    ).toBeInTheDocument()
    expect(chipSummary()).toBe("Opus/High/Fast")
  })

  it("holds the loading line instead of the chip while a re-probe is pending", () => {
    renderChip({ stale: true })
    expect(screen.getByText("Loading options…")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", {
        name: new RegExp(`^${MSGS.agentSettings}`),
      })
    ).toBeNull()
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
