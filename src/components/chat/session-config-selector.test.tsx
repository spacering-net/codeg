import { render, screen, cleanup, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  InlineSessionConfigSelector,
  InlineSessionConfigToggle,
} from "./session-config-selector"
import { deriveModelGroups } from "@/lib/model-config-groups"
import type { SessionConfigOptionInfo } from "@/lib/types"

function modelOption(
  options: { value: string; name: string; description?: string | null }[],
  current = options[0]?.value ?? ""
): SessionConfigOptionInfo {
  return {
    id: "model",
    name: "Model",
    description: null,
    category: null,
    kind: {
      type: "select",
      current_value: current,
      options: options.map((o) => ({ description: null, ...o })),
      groups: [],
    },
  }
}

describe("InlineSessionConfigSelector — model grouping", () => {
  afterEach(() => cleanup())

  it("renders provider headers and prefix-stripped labels for derived groups", async () => {
    const user = userEvent.setup()
    const option = modelOption(
      [
        { value: "anthropic/claude-opus", name: "anthropic/claude-opus" },
        { value: "openai/gpt-4o", name: "openai/gpt-4o" },
      ],
      "anthropic/claude-opus"
    )
    const onSelect = vi.fn()
    render(
      <InlineSessionConfigSelector
        option={option}
        derivedGroups={deriveModelGroups(option)}
        onSelect={onSelect}
      />
    )

    // The trigger shows the selected model with its `provider/` prefix
    // stripped (the provider is implied by its group) — not `anthropic/...`.
    const trigger = screen.getByRole("button", { name: /claude-opus/ })
    expect(trigger).not.toHaveTextContent("anthropic/")
    await user.click(trigger)

    // Provider namespaces become headers.
    expect(await screen.findByText("anthropic")).toBeInTheDocument()
    expect(screen.getByText("openai")).toBeInTheDocument()
    // In-group labels drop the redundant `provider/` prefix.
    const item = screen.getByRole("menuitemradio", { name: /claude-opus/ })
    expect(item).toBeInTheDocument()
  })

  it("headers with the human provider name and strips it from rows (value≠name)", async () => {
    const user = userEvent.setup()
    // Real OpenCode shape: ids are `opencode/…` but names repeat `OpenCode Zen/`.
    const option = modelOption(
      [
        { value: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle" },
        { value: "opencode/claude-haiku", name: "OpenCode Zen/Claude Haiku" },
        { value: "anthropic/claude-opus", name: "anthropic/claude-opus" },
      ],
      "opencode/big-pickle"
    )
    const onSelect = vi.fn()
    render(
      <InlineSessionConfigSelector
        option={option}
        derivedGroups={deriveModelGroups(option)}
        onSelect={onSelect}
      />
    )
    // The trigger shows the stripped current label, not "OpenCode Zen/…".
    const trigger = screen.getByRole("button", { name: /Big Pickle/ })
    expect(trigger).not.toHaveTextContent("OpenCode Zen/")
    await user.click(trigger)

    // The header is the human provider name (not the `opencode` id).
    expect(await screen.findByText("OpenCode Zen")).toBeInTheDocument()
    // Rows drop the repeated prefix but commit the full id.
    const haiku = screen.getByRole("menuitemradio", { name: /Claude Haiku/ })
    expect(haiku).not.toHaveTextContent("OpenCode Zen/")
    await user.click(haiku)
    expect(onSelect).toHaveBeenCalledWith("model", "opencode/claude-haiku")
  })

  it("commits the full value (not the stripped label) on select", async () => {
    const user = userEvent.setup()
    const option = modelOption([
      { value: "anthropic/claude-opus", name: "anthropic/claude-opus" },
      { value: "openai/gpt-4o", name: "openai/gpt-4o" },
    ])
    const onSelect = vi.fn()
    render(
      <InlineSessionConfigSelector
        option={option}
        derivedGroups={deriveModelGroups(option)}
        onSelect={onSelect}
      />
    )
    await user.click(screen.getByRole("button", { name: /claude-opus/ }))
    await user.click(
      await screen.findByRole("menuitemradio", { name: /gpt-4o/ })
    )
    expect(onSelect).toHaveBeenCalledWith("model", "openai/gpt-4o")
  })

  it("renders the floating bucket with no header before provider groups", async () => {
    const user = userEvent.setup()
    const option = modelOption(
      [
        { value: "default", name: "Default" },
        { value: "anthropic/opus", name: "anthropic/opus" },
      ],
      "default"
    )
    render(
      <InlineSessionConfigSelector
        option={option}
        derivedGroups={deriveModelGroups(option)}
        onSelect={vi.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: /Default/ }))

    // The prefix-less "Default" option is present…
    expect(
      await screen.findByRole("menuitemradio", { name: /Default/ })
    ).toBeInTheDocument()
    // …with a provider header for the grouped one, but no "Default" header.
    expect(screen.getByText("anthropic")).toBeInTheDocument()
    // Inside the menu "Default" appears once (the option), not also as a group
    // label (the floating bucket is headerless). The trigger's copy of the
    // current label lives outside the menu, so scope the count to the menu.
    const menu = screen.getByRole("menu")
    expect(within(menu).getAllByText(/^Default$/)).toHaveLength(1)
  })

  it("falls back to a flat list when no grouping applies", async () => {
    const user = userEvent.setup()
    const option = modelOption(
      [
        { value: "opus", name: "Opus" },
        { value: "haiku", name: "Haiku" },
      ],
      "opus"
    )
    render(
      <InlineSessionConfigSelector
        option={option}
        derivedGroups={deriveModelGroups(option)}
        onSelect={vi.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: /Opus/ }))
    expect(
      await screen.findByRole("menuitemradio", { name: /Haiku/ })
    ).toBeInTheDocument()
    // No provider headers for an ungroupable flat list.
    expect(screen.queryByText("anthropic")).toBeNull()
  })
})

// codex-acp 1.11.0 names a recommended value per select
// (`_meta.jetbrains.air.recommendedValue`). What makes it worth rendering at
// all is that it is NOT the selection: codeg replays a persisted per-agent
// preference into every new session, so the selected row is routinely a model
// the agent no longer defaults to.
describe("InlineSessionConfigSelector — the agent's recommended value", () => {
  afterEach(() => cleanup())

  const withRecommendation = (recommended: string | null) => ({
    ...modelOption(
      [
        { value: "gpt-6-astra", name: "6 Astra" },
        { value: "gpt-5.5", name: "5.5" },
      ],
      // Selected ≠ recommended, the case the badge exists for.
      "gpt-5.5"
    ),
    recommended_value: recommended,
  })

  it("badges the recommended row, not the selected one", async () => {
    const user = userEvent.setup()
    render(
      <InlineSessionConfigSelector
        option={withRecommendation("gpt-6-astra")}
        onSelect={vi.fn()}
        recommendedLabel="Recommended"
      />
    )
    await user.click(screen.getByRole("button", { name: /5\.5/ }))

    const recommended = await screen.findByRole("menuitemradio", {
      name: /6 Astra/,
    })
    expect(recommended).toHaveTextContent("Recommended")
    // The selected row keeps its checkmark and gains nothing.
    const selected = screen.getByRole("menuitemradio", { name: /^5\.5/ })
    expect(selected).not.toHaveTextContent("Recommended")
  })

  it("shows nothing when the agent named no recommendation", async () => {
    const user = userEvent.setup()
    render(
      <InlineSessionConfigSelector
        option={withRecommendation(null)}
        onSelect={vi.fn()}
        recommendedLabel="Recommended"
      />
    )
    await user.click(screen.getByRole("button", { name: /5\.5/ }))
    await screen.findByRole("menuitemradio", { name: /6 Astra/ })
    expect(screen.queryByText("Recommended")).toBeNull()
  })

  // A recommendation that matches no option marks nothing — the backend
  // deliberately does not validate membership, so this is the guard that makes
  // that safe.
  it("ignores a recommendation that names no option in the list", async () => {
    const user = userEvent.setup()
    render(
      <InlineSessionConfigSelector
        option={withRecommendation("gpt-7-retired")}
        onSelect={vi.fn()}
        recommendedLabel="Recommended"
      />
    )
    await user.click(screen.getByRole("button", { name: /5\.5/ }))
    await screen.findByRole("menuitemradio", { name: /6 Astra/ })
    expect(screen.queryByText("Recommended")).toBeNull()
  })
})

// Cline 3.0.50's `auto_approve` — the first boolean config option any pinned
// agent ships.
function autoApproveOption(current: boolean): SessionConfigOptionInfo {
  return {
    id: "auto_approve",
    name: "Auto-approve tools",
    description: "Automatically approve all tool calls without asking",
    category: null,
    kind: { type: "boolean", current_value: current },
  }
}

describe("InlineSessionConfigToggle", () => {
  afterEach(() => cleanup())

  it("reports its state through aria-pressed and the accessible name", () => {
    render(
      <InlineSessionConfigToggle
        option={autoApproveOption(true)}
        onSelect={vi.fn()}
        onLabel="On"
        offLabel="Off"
      />
    )
    const button = screen.getByRole("button", {
      name: "Auto-approve tools: On",
    })
    expect(button).toHaveAttribute("aria-pressed", "true")
  })

  it("flips the value on click, in both directions", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()

    const { rerender } = render(
      <InlineSessionConfigToggle
        option={autoApproveOption(false)}
        onSelect={onSelect}
        onLabel="On"
        offLabel="Off"
      />
    )
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false")
    await user.click(screen.getByRole("button"))
    expect(onSelect).toHaveBeenLastCalledWith("auto_approve", "true")

    rerender(
      <InlineSessionConfigToggle
        option={autoApproveOption(true)}
        onSelect={onSelect}
        onLabel="On"
        offLabel="Off"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(onSelect).toHaveBeenLastCalledWith("auto_approve", "false")
  })

  it("renders nothing for a select option", () => {
    const { container } = render(
      <InlineSessionConfigToggle
        option={modelOption([{ value: "opus", name: "Opus" }])}
        onSelect={vi.fn()}
        onLabel="On"
        offLabel="Off"
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

// The chips carry a `SelectorTooltip` instead of a native `title`: same hover
// affordance, themed, and naming the setting rather than echoing the value the
// chip already shows.
describe("selector hover hints", () => {
  afterEach(() => cleanup())

  it("names the setting on hover, without echoing the value the chip shows", async () => {
    const user = userEvent.setup()
    const longName = "claude-opus-4-1-20250805-with-a-very-long-name"
    const option = modelOption([{ value: "opus", name: longName }], "opus")
    render(<InlineSessionConfigSelector option={option} onSelect={vi.fn()} />)

    const trigger = screen.getByRole("button")
    expect(trigger).not.toHaveAttribute("title")

    await user.hover(trigger)
    const tip = await screen.findByRole("tooltip")
    expect(tip).toHaveTextContent("Model")
    expect(tip).not.toHaveTextContent(longName)
  })

  it("shows the toggle's description on hover", async () => {
    const user = userEvent.setup()
    render(
      <InlineSessionConfigToggle
        option={autoApproveOption(true)}
        onSelect={vi.fn()}
        onLabel="On"
        offLabel="Off"
      />
    )

    const trigger = screen.getByRole("button")
    expect(trigger).not.toHaveAttribute("title")

    await user.hover(trigger)
    const tip = await screen.findByRole("tooltip")
    expect(tip).toHaveTextContent("Auto-approve tools")
    expect(tip).toHaveTextContent(
      "Automatically approve all tool calls without asking"
    )
  })
})
