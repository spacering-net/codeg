import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  type ReactNode,
  type Ref,
} from "react"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createTranslator, NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

// A long list renders `ModelOptionList`, which needs the same three stand-ins
// as its own suite: the zoom level (it sizes in rem, and throws outside an
// AppearanceProvider), a Virtualizer that renders every row (virtua renders
// none without layout), and a ScrollArea that reports its viewport. The
// ScrollArea stand-in keeps a marked box, so a test can see what scrolls in it.
vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

vi.mock("virtua", () => ({
  Virtualizer: forwardRef(function VirtualizerMock(
    props: { children?: ReactNode },
    ref: Ref<{ scrollToIndex: (i: number) => void }>
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }))
    return <>{props.children}</>
  }),
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    onViewportRef,
  }: {
    children?: ReactNode
    onViewportRef?: (el: HTMLElement | null) => void
  }) => {
    useEffect(() => {
      onViewportRef?.(document.createElement("div"))
    }, [onViewportRef])
    return <div data-slot="scroll-area">{children}</div>
  },
}))

import enMessages from "@/i18n/messages/en.json"
import { SessionSettingsPicker } from "./session-settings-picker"
import {
  localizeConfigOptions,
  type AgentVocabularyTranslator,
} from "@/lib/agent-label-vocabulary"
import { buildSessionSettings } from "@/lib/session-settings"
import type {
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
  SessionModeInfo,
} from "@/lib/types"

const MSGS = enMessages.Folder.chat.messageInput

afterEach(() => cleanup())

function select(
  id: string,
  name: string,
  category: string | null,
  current: string,
  options: (string | SessionConfigSelectOptionInfo)[],
  extra: Partial<SessionConfigOptionInfo> = {}
): SessionConfigOptionInfo {
  return {
    id,
    name,
    description: null,
    category,
    kind: {
      type: "select",
      current_value: current,
      options: options.map((o) =>
        typeof o === "string" ? { value: o, name: o, description: null } : o
      ),
      groups: [],
    },
    ...extra,
  }
}

// claude-agent-acp 0.88's four settings.
const CLAUDE: SessionConfigOptionInfo[] = [
  select("mode", "Mode", "mode", "default", [
    { value: "default", name: "Manual", description: "Always ask first" },
    { value: "acceptEdits", name: "Accept edits", description: null },
    { value: "plan", name: "Plan", description: "Plan first" },
  ]),
  select(
    "model",
    "Model",
    "model",
    "opus",
    [
      { value: "opus", name: "Opus 5.5", description: "Best for everyday" },
      { value: "sonnet", name: "Sonnet 5.5", description: null },
    ],
    { recommended_value: "sonnet" }
  ),
  select(
    "effort",
    "Effort",
    "thought_level",
    "high",
    [
      { value: "low", name: "Low", description: null },
      { value: "medium", name: "Medium", description: null },
      { value: "high", name: "High", description: null },
    ],
    { recommended_value: "medium" }
  ),
  select(
    "fast",
    "Fast mode",
    "model_config",
    "off",
    [
      { value: "on", name: "On", description: null },
      { value: "off", name: "Off", description: null },
    ],
    { description: "Faster responses on supported models" }
  ),
]

function renderPicker({
  configOptions = CLAUDE,
  modes = [],
  currentModeId = null,
  loadingLabel = null,
}: {
  configOptions?: SessionConfigOptionInfo[]
  modes?: SessionModeInfo[]
  currentModeId?: string | null
  loadingLabel?: string | null
} = {}) {
  const onChange = vi.fn()
  const tree = (options: SessionConfigOptionInfo[]) => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionSettingsPicker
        agentType="claude_code"
        settings={buildSessionSettings({
          configOptions: options,
          modes,
          currentModeId,
          modeTitle: MSGS.modeLabel,
        })}
        loadingLabel={loadingLabel}
        onChange={onChange}
      />
    </NextIntlClientProvider>
  )
  const view = render(tree(configOptions))
  // A live update from the agent: same picker, new options.
  const update = (options: SessionConfigOptionInfo[]) =>
    view.rerender(tree(options))
  return { onChange, view, update }
}

function trigger() {
  return screen.getByRole("button", { name: new RegExp(MSGS.agentSettings) })
}

// The chip's merged label (the agent icon carries an SVG <title> of its own).
function summary() {
  return trigger().querySelector('[data-slot="settings-summary"]')?.textContent
}

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger())
  return screen.findByRole("dialog", { name: MSGS.agentSettings })
}

describe("SessionSettingsPicker — the chip", () => {
  it("joins the values with / — model, effort, then mode", () => {
    renderPicker({
      configOptions: CLAUDE.map((option) =>
        option.id === "mode"
          ? { ...option, kind: { ...option.kind, current_value: "plan" } }
          : option
      ) as SessionConfigOptionInfo[],
    })
    expect(summary()).toBe("Opus 5.5/High/Plan")
  })

  it("leaves a default value and a switch that is off out of the label", () => {
    renderPicker()
    // Mode is `default` (Manual) and Fast mode is off: no segment, and no
    // dangling separator for either.
    expect(summary()).toBe("Opus 5.5/High")
  })

  it("speaks every setting, the left-out ones included", () => {
    renderPicker()
    expect(trigger()).toHaveAccessibleName(
      `${MSGS.agentSettings}: Model Opus 5.5, Effort High, Mode Manual, Fast mode ${MSGS.toggleOff}`
    )
  })

  it("names a switch in the label while it is on", () => {
    renderPicker({
      configOptions: [
        ...CLAUDE.slice(0, 3),
        select("fast", "Fast mode", "model_config", "on", ["on", "off"]),
      ],
    })
    expect(summary()).toBe("Opus 5.5/High/Fast mode")
  })

  it("holds a placeholder while the settings are on their way", () => {
    renderPicker({ configOptions: [], loadingLabel: MSGS.loadingSettings })
    expect(
      screen.getByRole("status", { name: MSGS.loadingSettings })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("renders nothing when there is nothing to show or wait for", () => {
    const { view } = renderPicker({ configOptions: [] })
    expect(view.container).toBeEmptyDOMElement()
  })

  it("hints what the chip is on hover, not what it holds", async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.hover(trigger())
    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent(MSGS.agentSettings)
    expect(tooltip).not.toHaveTextContent("Opus")
    // No native title alongside it — that would be a second hint.
    expect(trigger()).not.toHaveAttribute("title")
  })
})

describe("SessionSettingsPicker — the popover", () => {
  it("opens with focus on the panel itself, not on a control", async () => {
    // A search box first in line would raise the on-screen keyboard on touch.
    const user = userEvent.setup()
    renderPicker({
      configOptions: [
        select(
          "model",
          "Model",
          "model",
          "m0",
          Array.from({ length: 30 }, (_, i) => `m${i}`)
        ),
      ],
    })
    const popover = await openPopover(user)
    expect(popover).toHaveFocus()
  })

  it("applies a model pick at once and stays open for the next one", async () => {
    const user = userEvent.setup()
    const { onChange } = renderPicker()
    const popover = await openPopover(user)

    await user.click(within(popover).getByRole("button", { name: /Sonnet/ }))
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "model" },
      "sonnet"
    )
    // Still open: the next setting can be changed in the same visit.
    await user.click(within(popover).getByRole("button", { name: "Low" }))
    expect(onChange).toHaveBeenLastCalledWith(
      { type: "config", configId: "effort" },
      "low"
    )
    expect(
      screen.getByRole("dialog", { name: MSGS.agentSettings })
    ).toBeInTheDocument()
  })

  it("marks the current model and badges the recommended one apart from it", async () => {
    const user = userEvent.setup()
    renderPicker()
    const popover = await openPopover(user)
    const opus = within(popover).getByRole("button", { name: /Opus 5\.5/ })
    const sonnet = within(popover).getByRole("button", { name: /Sonnet 5\.5/ })
    expect(opus).toHaveAttribute("aria-current", "true")
    expect(opus).not.toHaveTextContent(MSGS.recommendedBadge)
    expect(sonnet).not.toHaveAttribute("aria-current")
    expect(sonnet).toHaveTextContent(MSGS.recommendedBadge)
  })

  it("scrolls the panel and a short list in the app's scrollbar, not the native one", async () => {
    const user = userEvent.setup()
    renderPicker()
    const popover = await openPopover(user)
    // The plain model list scrolls in a ScrollArea of its own, inside the
    // panel's.
    const list = within(popover)
      .getByRole("group", { name: "Model" })
      .closest('[data-slot="scroll-area"]')
    expect(list).not.toBeNull()
    expect(
      list?.parentElement?.closest('[data-slot="scroll-area"]')
    ).not.toBeNull()
    // Nothing in the popover scrolls with a native scrollbar.
    for (const element of [popover, ...popover.querySelectorAll("*")]) {
      expect(element.getAttribute("class") ?? "").not.toMatch(
        /overflow-(y-)?(auto|scroll)/
      )
    }
  })

  it("does not re-send the value that is already selected", async () => {
    const user = userEvent.setup()
    const { onChange } = renderPicker()
    const popover = await openPopover(user)
    await user.click(within(popover).getByRole("button", { name: /Opus 5\.5/ }))
    await user.click(within(popover).getByRole("button", { name: "High" }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("shows a short select as a segmented control with its recommendation", async () => {
    const user = userEvent.setup()
    renderPicker()
    const popover = await openPopover(user)
    const effort = within(popover).getByRole("group", { name: "Effort" })
    expect(
      within(effort).getByRole("button", { name: "High" })
    ).toHaveAttribute("aria-pressed", "true")
    expect(within(effort).getByRole("button", { name: "Low" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
    expect(popover).toHaveTextContent("Recommended: Medium")
    // The current choice's description is spelled out under the control.
    expect(popover).toHaveTextContent("Always ask first")
  })

  it("flips an on/off select as a switch, sending the agent's own values", async () => {
    const user = userEvent.setup()
    const { onChange } = renderPicker()
    const popover = await openPopover(user)
    const fast = within(popover).getByRole("switch", { name: "Fast mode" })
    expect(fast).toHaveAttribute("aria-checked", "false")
    expect(fast).toHaveAccessibleDescription(
      "Faster responses on supported models"
    )
    await user.click(fast)
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "fast" },
      "on"
    )
  })

  it("flips a boolean option from anywhere on its row", async () => {
    const user = userEvent.setup()
    const { onChange } = renderPicker({
      configOptions: [
        {
          id: "auto_approve",
          name: "Auto-approve tools",
          description: "Approve every tool call",
          category: null,
          kind: { type: "boolean", current_value: true },
        },
      ],
    })
    const popover = await openPopover(user)
    await user.click(within(popover).getByText("Approve every tool call"))
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "auto_approve" },
      "false"
    )
  })

  it("groups a provider-prefixed model list and commits the full value", async () => {
    const user = userEvent.setup()
    const { onChange } = renderPicker({
      configOptions: [
        select("model", "Model", null, "anthropic/claude-opus", [
          "anthropic/claude-opus",
          "openai/gpt-4o",
        ]),
      ],
    })
    expect(trigger()).toHaveTextContent("claude-opus")
    expect(trigger()).not.toHaveTextContent("anthropic/")
    const popover = await openPopover(user)
    expect(within(popover).getByText("anthropic")).toBeInTheDocument()
    expect(within(popover).getByText("openai")).toBeInTheDocument()
    await user.click(within(popover).getByRole("button", { name: /gpt-4o/ }))
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "model" },
      "openai/gpt-4o"
    )
  })

  it("searches a long list", async () => {
    const user = userEvent.setup()
    const options = Array.from(
      { length: 30 },
      (_, i) => `openrouter/model-${i}`
    )
    const { onChange } = renderPicker({
      configOptions: [select("model", "Model", "model", options[0], options)],
    })
    const popover = await openPopover(user)
    const search = within(popover).getByRole("combobox", {
      name: MSGS.searchModelAria,
    })
    await user.type(search, "model-17")
    await user.click(within(popover).getByRole("option", { name: /model-17/ }))
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "model" },
      "openrouter/model-17"
    )
  })

  it("searches a long non-model list as options, not models", async () => {
    const user = userEvent.setup()
    const agents = Array.from({ length: 9 }, (_, i) => `agent-${i}`)
    renderPicker({
      configOptions: [select("mode", "Agent", "mode", agents[0], agents)],
    })
    const popover = await openPopover(user)
    expect(
      within(popover).getByRole("combobox", { name: MSGS.searchOptionsAria })
    ).toHaveAttribute("placeholder", MSGS.searchOptions)
  })

  it("sends a legacy mode pick to the mode, not a config option", async () => {
    const user = userEvent.setup()
    const { onChange } = renderPicker({
      configOptions: [],
      modes: [
        { id: "default", name: "Default", description: "Prompts for approval" },
        { id: "yolo", name: "YOLO", description: null },
      ],
      currentModeId: "default",
    })
    // Its only value is `default`, so the label falls back to showing it.
    expect(trigger()).toHaveTextContent("Default")
    const popover = await openPopover(user)
    await user.click(within(popover).getByRole("button", { name: "YOLO" }))
    expect(onChange).toHaveBeenCalledWith({ type: "mode" }, "yolo")
  })

  it("moves through a group with the arrows without committing", async () => {
    const user = userEvent.setup()
    const { onChange } = renderPicker()
    const popover = await openPopover(user)
    const effort = within(popover).getByRole("group", { name: "Effort" })
    const high = within(effort).getByRole("button", { name: "High" })
    // One tab stop per group: the current value.
    expect(
      within(effort)
        .getAllByRole("button")
        .map((button) => button.tabIndex)
    ).toEqual([-1, -1, 0])
    high.focus()
    await user.keyboard("{ArrowLeft}")
    const medium = within(effort).getByRole("button", { name: "Medium" })
    expect(medium).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
    await user.keyboard("{Enter}")
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "effort" },
      "medium"
    )
  })

  it("picks a short-list option with Enter", async () => {
    const user = userEvent.setup()
    const { onChange } = renderPicker()
    const popover = await openPopover(user)
    within(popover)
      .getByRole("button", { name: /Sonnet 5\.5/ })
      .focus()
    await user.keyboard("{Enter}")
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "model" },
      "sonnet"
    )
  })

  it("marks no recommendation when the agent names none, or one it does not offer", async () => {
    const user = userEvent.setup()
    renderPicker({
      configOptions: CLAUDE.map((option) =>
        option.id === "model"
          ? { ...option, recommended_value: "retired" }
          : option.id === "effort"
            ? { ...option, recommended_value: null }
            : option
      ),
    })
    const popover = await openPopover(user)
    expect(popover).not.toHaveTextContent(MSGS.recommendedBadge)
  })

  it("headers a provider group by its display name and floats unprefixed models", async () => {
    // OpenCode: values `opencode/…`, names `OpenCode Zen/…`, plus a model with
    // no provider prefix at all.
    const user = userEvent.setup()
    renderPicker({
      configOptions: [
        select("model", "Model", "model", "opencode/big-pickle", [
          {
            value: "opencode/big-pickle",
            name: "OpenCode Zen/Big Pickle",
            description: null,
          },
          {
            value: "opencode/space-bunny",
            name: "OpenCode Zen/Space Bunny",
            description: null,
          },
          // Last in the agent's list — it still leads, under no header.
          { value: "solo", name: "Solo Model", description: null },
        ]),
      ],
    })
    // The provider is implied by the group, so the chip names the model only.
    expect(summary()).toBe("Big Pickle")
    const popover = await openPopover(user)
    const list = within(popover).getByRole("group", { name: "Model" })
    // The human name heads the group; the value prefix never shows.
    expect(within(list).getByText("OpenCode Zen")).toBeInTheDocument()
    expect(within(list).queryByText("opencode")).toBeNull()
    expect(
      within(list).getByRole("button", { name: /^Space Bunny/ })
    ).toBeInTheDocument()
    // The unprefixed model leads, under no header.
    expect(list.firstElementChild).toHaveAccessibleName(/^Solo Model/)
  })

  it("keeps the tab stop on the focused option when the options reorder", async () => {
    const user = userEvent.setup()
    const effort = (order: string[]) =>
      select(
        "effort",
        "Effort",
        "thought_level",
        "high",
        order.map((value) => ({
          value,
          name: value[0].toUpperCase() + value.slice(1),
          description: null,
        }))
      )
    const { update } = renderPicker({
      configOptions: [effort(["low", "medium", "high"])],
    })
    const popover = await openPopover(user)
    within(popover).getByRole("button", { name: "High" }).focus()
    await user.keyboard("{ArrowLeft}")
    const medium = within(popover).getByRole("button", { name: "Medium" })
    expect(medium).toHaveFocus()
    // The agent re-sends the same levels in another order.
    update([effort(["medium", "low", "high"])])
    const group = within(
      screen.getByRole("dialog", { name: MSGS.agentSettings })
    ).getByRole("group", { name: "Effort" })
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => [button.textContent, button.tabIndex])
    ).toEqual([
      ["Medium", 0],
      ["Low", -1],
      ["High", -1],
    ])
    // Focus itself stayed on the same option through the update.
    expect(within(group).getByRole("button", { name: "Medium" })).toHaveFocus()
  })

  it("names a localised option under its translated title", () => {
    // deepseek-acp names its model picker in Chinese; the composer translates
    // the option's title but keeps the model's own name.
    const vocabularyT = createTranslator({
      locale: "en",
      messages: enMessages,
      namespace: "AgentVocabulary",
    }) as AgentVocabularyTranslator
    const configOptions = localizeConfigOptions(
      "deepseek",
      [
        select("model", "模型", "model", "deepseek-flash", [
          {
            value: "deepseek-flash",
            name: "DeepSeek Flash",
            description: null,
          },
          {
            value: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            description: null,
          },
        ]),
      ],
      vocabularyT
    )
    renderPicker({ configOptions })
    expect(trigger()).toHaveAccessibleName(
      `${MSGS.agentSettings}: Model DeepSeek Flash`
    )
  })
})
