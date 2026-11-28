import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { saveConfigPreference } from "@/lib/selector-prefs-storage"
import type {
  AgentOptionsSnapshot,
  AgentType,
  PromptDraft,
  SessionConfigOptionInfo,
} from "@/lib/types"

import {
  askConfigOptions,
  buildAskComposerText,
  SelectionAskComposer,
  type SelectionAskLiveSelectors,
} from "./selection-ask-composer"

// The props the (mocked) composer was last rendered with.
let inputProps: Record<string, unknown> = {}
vi.mock("@/components/chat/message-input", () => ({
  MessageInput: (props: Record<string, unknown>) => {
    inputProps = props
    return <div data-testid="message-input" />
  },
}))
vi.mock("@/components/chat/agent-selector", () => ({
  AgentSelector: (props: {
    defaultAgentType: AgentType
    onSelect: (a: AgentType) => void
  }) => (
    <div data-testid="agent-selector" data-agent={props.defaultAgentType}>
      <button type="button" onClick={() => props.onSelect("codex")}>
        pick codex
      </button>
      <button type="button" onClick={() => props.onSelect("claude_code")}>
        pick claude
      </button>
    </div>
  ),
}))
const probeCalls: Array<{ agent: AgentType; model: string | null }> = []
// What the probe answers, per agent; a missing agent is still probing.
let probeSnapshots: Partial<Record<AgentType, AgentOptionsSnapshot>> = {}
// Models whose re-probe hasn't answered: the previous model's snapshot is
// still held, but not `current`.
const staleModels = new Set<string>()
vi.mock("@/components/automations/use-agent-options", () => ({
  useAgentOptions: (
    agent: AgentType,
    _folder: unknown,
    _enabled: boolean,
    values: Record<string, string> | null
  ) => {
    probeCalls.push({ agent, model: values?.model ?? null })
    const snapshot = probeSnapshots[agent] ?? null
    return {
      snapshot,
      snapshotAgentType: snapshot ? agent : null,
      snapshotModel: null,
      current: snapshot != null && !staleModels.has(values?.model ?? ""),
      loading: snapshot == null,
      error: null,
      reload: vi.fn(),
      ensure: () => Promise.resolve(null),
    }
  },
}))

function select(
  id: string,
  current: string,
  values: string[]
): SessionConfigOptionInfo {
  return {
    id,
    name: id,
    kind: {
      type: "select",
      current_value: current,
      options: values.map((value) => ({ value, name: value })),
      groups: [],
    },
  }
}

const toggle: SessionConfigOptionInfo = {
  id: "fast",
  name: "fast",
  kind: { type: "boolean", current_value: false },
}

const caps = { image: true, audio: false, embedded_context: true }
const live: SelectionAskLiveSelectors = {
  availableCommands: [{ name: "review", description: "" }],
  promptCapabilities: caps,
}

function snapshotOf(
  config_options: SessionConfigOptionInfo[]
): AgentOptionsSnapshot {
  return {
    modes: null,
    config_options,
    available_commands: [],
    prompt_capabilities: null,
  }
}

const draft: PromptDraft = {
  blocks: [{ type: "text", text: "why?" }],
  displayText: "why?",
}

function renderComposer(
  onSubmit = vi.fn<(d: PromptDraft, p: unknown) => boolean>(() => true)
) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SelectionAskComposer
        selection="some text"
        mention={{ conversationId: 7, label: "Main" }}
        defaultAgentType="claude_code"
        live={live}
        defaultPath="/repo"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    </NextIntlClientProvider>
  )
  return onSubmit
}

function send() {
  act(() => {
    ;(inputProps.onSend as (d: PromptDraft, m?: string | null) => void)(
      draft,
      null
    )
  })
}

function pickOption(id: string, value: string) {
  act(() => {
    ;(inputProps.onConfigOptionChange as (id: string, v: string) => void)(
      id,
      value
    )
  })
}

describe("SelectionAskComposer", () => {
  beforeEach(() => {
    localStorage.clear()
    inputProps = {}
    probeCalls.length = 0
    staleModels.clear()
    probeSnapshots = {
      claude_code: snapshotOf([
        select("model", "opus", ["opus", "sonnet"]),
        select("mode", "default", ["default", "bypassPermissions"]),
        toggle,
      ]),
    }
  })

  it("starts on the conversation's agent, with a new conversation's settings", () => {
    const onSubmit = renderComposer()
    expect(screen.getByTestId("agent-selector").dataset.agent).toBe(
      "claude_code"
    )
    expect(probeCalls.every((c) => c.agent === "claude_code")).toBe(true)
    expect(inputProps.agentType).toBe("claude_code")
    expect(inputProps.availableCommands).toBe(live.availableCommands)
    expect(inputProps.promptCapabilities).toBe(caps)
    expect(inputProps.configOptions).toEqual(
      probeSnapshots.claude_code!.config_options
    )

    send()
    expect(onSubmit).toHaveBeenCalledWith(draft, {
      agentType: "claude_code",
      modeId: null,
      configValues: { model: "opus", mode: "default", fast: "false" },
    })
  })

  it("sends the settings picked in the composer", () => {
    const onSubmit = renderComposer()
    pickOption("model", "sonnet")
    const model = (inputProps.configOptions as SessionConfigOptionInfo[])[0]
    expect(model.kind.current_value).toBe("sonnet")
    // The probe follows the picked model.
    expect(probeCalls[probeCalls.length - 1].model).toBe("sonnet")

    send()
    expect(onSubmit.mock.calls[0][1]).toMatchObject({
      configValues: { model: "sonnet", fast: "false" },
    })
  })

  it("keeps a pick made while its re-probe is still on the way", () => {
    const onSubmit = renderComposer()
    pickOption("model", "sonnet")
    delete probeSnapshots.claude_code
    pickOption("fast", "true")
    expect(inputProps.configOptionsLoading).toBe(true)

    send()
    expect(onSubmit.mock.calls[0][1]).toMatchObject({
      configValues: { model: "sonnet", fast: "true" },
    })
  })

  it("never sends a previous model's option values during its re-probe", () => {
    probeSnapshots.claude_code = snapshotOf([
      select("model", "opus", ["opus", "sonnet"]),
      select("effort", "high", ["default", "high"]),
    ])
    staleModels.add("sonnet")
    const onSubmit = renderComposer()
    pickOption("model", "sonnet")
    expect(inputProps.configOptions).toEqual([])
    expect(inputProps.configOptionsLoading).toBe(true)

    send()
    expect(onSubmit.mock.calls[0][1]).toMatchObject({
      configValues: { model: "sonnet" },
    })
  })

  it("keeps the agent's prompt capabilities through a model re-probe", () => {
    const withImages = { image: true, audio: false, embedded_context: false }
    probeSnapshots.codex = {
      ...snapshotOf([select("model", "gpt-6", ["gpt-6", "gpt-6.2"])]),
      prompt_capabilities: withImages,
    }
    renderComposer()
    fireEvent.click(screen.getByText("pick codex"))
    expect(inputProps.promptCapabilities).toEqual(withImages)
    // Debounce: the previous model's snapshot, no longer current.
    staleModels.add("gpt-6.2")
    pickOption("model", "gpt-6.2")
    expect(inputProps.configOptions).toEqual([])
    expect(inputProps.promptCapabilities).toEqual(withImages)
    // In flight: the hook has dropped its snapshot altogether.
    delete probeSnapshots.codex
    pickOption("effort", "high")
    expect(inputProps.promptCapabilities).toEqual(withImages)
    // Another agent never inherits it.
    fireEvent.click(screen.getByText("pick claude"))
    expect(inputProps.promptCapabilities).toBe(caps)
  })

  it("offers no standalone mode until the probe has answered", () => {
    probeSnapshots = {}
    const onSubmit = renderComposer()
    expect(inputProps.modes).toBeUndefined()
    send()
    expect(onSubmit.mock.calls[0][1]).toMatchObject({ modeId: null })
  })

  it("probes another agent and sends with its options", () => {
    probeSnapshots.codex = snapshotOf([
      select("model", "gpt-6", ["gpt-6", "gpt-6.2"]),
    ])
    saveConfigPreference("codex", "model", "gpt-6.2")
    const onSubmit = renderComposer()
    fireEvent.click(screen.getByText("pick codex"))

    expect(probeCalls[probeCalls.length - 1]).toEqual({
      agent: "codex",
      model: "gpt-6.2",
    })
    expect(inputProps.agentType).toBe("codex")
    // Not the conversation's agent: nothing it hasn't said it takes.
    expect(inputProps.availableCommands).toEqual([])
    expect(inputProps.promptCapabilities).toEqual({
      image: false,
      audio: false,
      embedded_context: false,
    })
    // Starts from codex's saved new-conversation default.
    send()
    expect(onSubmit.mock.calls[0][1]).toEqual({
      agentType: "codex",
      modeId: null,
      configValues: { model: "gpt-6.2" },
    })
  })

  it("drops the previous agent's picks on a switch", () => {
    const onSubmit = renderComposer()
    pickOption("model", "sonnet")
    fireEvent.click(screen.getByText("pick codex"))
    fireEvent.click(screen.getByText("pick claude"))
    send()
    expect(onSubmit.mock.calls[0][1]).toMatchObject({
      configValues: { model: "opus" },
    })
  })

  it("gets the draft back when the host can't take it", () => {
    renderComposer(vi.fn(() => false))
    send()
    expect(inputProps.injectContent).toEqual({ handBack: draft.blocks })
  })
})

describe("askConfigOptions", () => {
  const options = [select("model", "opus", ["opus", "sonnet"]), toggle]

  it("shows a pick over the saved default over the source's value", () => {
    const shown = askConfigOptions(
      options,
      { model: "sonnet", fast: "true" },
      { fast: "false" }
    )
    expect(shown[0].kind.current_value).toBe("sonnet")
    expect(shown[1].kind.current_value).toBe(false)
  })

  it("skips a value the option no longer offers", () => {
    const shown = askConfigOptions(options, { model: "haiku" }, {})
    expect(shown[0]).toBe(options[0])
  })
})

describe("buildAskComposerText", () => {
  const mention = { conversationId: 42, label: "Fix the parser" }

  it("quotes the selection and mentions the conversation on the next line", () => {
    expect(buildAskComposerText("first\nsecond", mention)).toBe(
      "> first\n> second\n[Fix the parser](codeg://session/42) "
    )
  })

  it("escapes a label that would break the mention link", () => {
    expect(
      buildAskComposerText("x", { conversationId: 3, label: "a [b] c" })
    ).toBe("> x\n[a \\[b\\] c](codeg://session/3) ")
  })

  it("leaves only the mention for a selection with no visible content", () => {
    expect(buildAskComposerText(" \n ", mention)).toBe(
      "[Fix the parser](codeg://session/42) "
    )
  })
})
