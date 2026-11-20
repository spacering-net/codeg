import {
  render,
  screen,
  within,
  cleanup,
  fireEvent,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  SessionSelectorsPanel,
  type SessionSelectorSetting,
} from "./session-selectors-panel"

// Two distinct settings (no substring overlap in their titles) so role queries
// stay unambiguous.
function makeSettings(
  modelOnSelect: () => void = vi.fn(),
  effortOnSelect: () => void = vi.fn()
): SessionSelectorSetting[] {
  return [
    {
      key: "config:model",
      title: "Model",
      currentValue: "default",
      currentLabel: "Default",
      groups: [
        {
          key: "__flat__",
          name: null,
          options: [
            {
              value: "default",
              name: "Default",
              description: "Use the default",
            },
            { value: "opus", name: "Opus", description: "Most capable" },
          ],
        },
      ],
      onSelect: modelOnSelect,
    },
    {
      key: "config:effort",
      title: "Effort",
      currentValue: "low",
      currentLabel: "Low",
      groups: [
        {
          key: "__flat__",
          name: null,
          options: [
            { value: "low", name: "Low", description: null },
            { value: "high", name: "High", description: null },
          ],
        },
      ],
      onSelect: effortOnSelect,
    },
  ]
}

describe("SessionSelectorsPanel", () => {
  afterEach(() => cleanup())

  it("shows the first setting's options with the current one marked", () => {
    render(
      <SessionSelectorsPanel
        settings={makeSettings()}
        settingsLabel="Settings"
      />
    )
    // The right pane is a group labelled by the active setting; options are
    // plain buttons with `aria-current` marking the chosen value.
    const group = screen.getByRole("group", { name: "Model" })
    expect(
      within(group).getByRole("button", { name: /Default/ })
    ).toHaveAttribute("aria-current", "true")
    expect(
      within(group).getByRole("button", { name: /Opus/ })
    ).not.toHaveAttribute("aria-current")
  })

  it("commits a value via a plain click and notifies onAfterSelect", () => {
    const modelOnSelect = vi.fn()
    const onAfterSelect = vi.fn()
    render(
      <SessionSelectorsPanel
        settings={makeSettings(modelOnSelect)}
        settingsLabel="Settings"
        onAfterSelect={onAfterSelect}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }))
    expect(modelOnSelect).toHaveBeenCalledWith("opus")
    expect(onAfterSelect).toHaveBeenCalledTimes(1)
  })

  it("activates an option with the keyboard (native button semantics)", async () => {
    const user = userEvent.setup()
    const modelOnSelect = vi.fn()
    render(
      <SessionSelectorsPanel
        settings={makeSettings(modelOnSelect)}
        settingsLabel="Settings"
      />
    )
    const opus = screen.getByRole("button", { name: /Opus/ })
    // Options are ordinary tab stops (no tabindex=-1 roving), so keyboard users
    // reach them with Tab and activate with Enter/Space.
    expect(opus.tabIndex).toBe(0)
    opus.focus()
    await user.keyboard("{Enter}")
    expect(modelOnSelect).toHaveBeenCalledWith("opus")
  })

  it("switches the detail pane to another setting", () => {
    const modelOnSelect = vi.fn()
    const effortOnSelect = vi.fn()
    render(
      <SessionSelectorsPanel
        settings={makeSettings(modelOnSelect, effortOnSelect)}
        settingsLabel="Settings"
      />
    )
    // Initially the Model pane is shown; Effort's options are not.
    expect(screen.queryByRole("button", { name: /High/ })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /Effort/ }))

    const group = screen.getByRole("group", { name: "Effort" })
    fireEvent.click(within(group).getByRole("button", { name: /High/ }))
    expect(effortOnSelect).toHaveBeenCalledWith("high")
    // Switching panes must not fire the previous setting's handler.
    expect(modelOnSelect).not.toHaveBeenCalled()
  })

  it("renders group headers for grouped options", () => {
    const settings: SessionSelectorSetting[] = [
      {
        key: "config:model",
        title: "Model",
        currentValue: "opus",
        currentLabel: "Opus",
        groups: [
          {
            key: "anthropic",
            name: "Anthropic",
            options: [{ value: "opus", name: "Opus", description: null }],
          },
          {
            key: "openai",
            name: "OpenAI",
            options: [{ value: "gpt", name: "GPT", description: null }],
          },
        ],
        onSelect: vi.fn(),
      },
    ]
    render(
      <SessionSelectorsPanel settings={settings} settingsLabel="Settings" />
    )
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })

  it("renders nothing when there are no settings", () => {
    const { container } = render(
      <SessionSelectorsPanel settings={[]} settingsLabel="Settings" />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
