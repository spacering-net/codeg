import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AcpAgentInfo, AgentType, BotAvatar } from "@/lib/types"

import { SetupAgentTiles } from "./setup-agent-tiles"
import { anotherName, SetupIdentity } from "./setup-identity"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const FACE: BotAvatar = { kind: "face", shape: "ring", color: "black" }

function Named({ start = "" }: { start?: string }) {
  const [name, setName] = useState(start)
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SetupIdentity
        avatar={FACE}
        name={name}
        onAvatar={() => {}}
        onName={setName}
        disabled={false}
      />
    </NextIntlClientProvider>
  )
}

const bubble = () =>
  document.querySelector("[data-pa-setup-bubble]")?.textContent ?? ""
const look = () =>
  document
    .querySelector("[data-pa-face-picker] [data-bot-look]")
    ?.getAttribute("data-bot-look")

describe("naming it on the first setup", () => {
  it("asks for a name, then says it", () => {
    render(<Named />)
    expect(bubble()).toBe("Give me a name?")
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Nova" },
    })
    expect(bubble()).toBe("Hi, I'm Nova!")
  })

  it("watches the name being typed, and smiles once it is given", () => {
    vi.useFakeTimers()
    render(<Named />)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "No" } })
    // Each new look comes through a blink, a moment after.
    act(() => vi.advanceTimersByTime(300))
    expect(look()).toBe("working")
    act(() => vi.advanceTimersByTime(800))
    act(() => vi.advanceTimersByTime(300))
    expect(look()).toBe("done")
    act(() => vi.advanceTimersByTime(2500))
    act(() => vi.advanceTimersByTime(300))
    expect(look()).toBe("idle")
  })

  it("offers another name from the list on the die, and smiles at it", () => {
    vi.useFakeTimers()
    render(<Named start="Nova" />)
    fireEvent.click(document.querySelector("[data-pa-setup-dice]")!)
    act(() => vi.advanceTimersByTime(300))
    const name = (screen.getByLabelText("Name") as HTMLInputElement).value
    const list = enMessages.PersonalAgent.settings.setupNames.split("|")
    expect(list).toContain(name)
    expect(name).not.toBe("Nova")
    expect(look()).toBe("done")
  })

  it("picks a name other than the one there", () => {
    expect(anotherName(["A", "B"], "A", () => 0.99)).toBe("B")
    expect(anotherName(["A"], "A", () => 0)).toBe("A")
    expect(anotherName([], "A")).toBe("")
  })
})

function agent(type: string, available = true): AcpAgentInfo {
  return { agent_type: type, enabled: true, available } as AcpAgentInfo
}

function Tiles({
  agents,
  start = null,
}: {
  agents: AcpAgentInfo[]
  start?: AgentType | null
}) {
  const [value, setValue] = useState<AgentType | null>(start)
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SetupAgentTiles
        value={value}
        onChange={setValue}
        agents={agents}
        disabled={false}
      />
    </NextIntlClientProvider>
  )
}

const tiles = () =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-pa-setup-agent-tile]")
  ).map((b) => b.getAttribute("data-pa-setup-agent-tile"))

describe("picking its agent on the first setup", () => {
  const many = [
    agent("claude_code"),
    agent("codex"),
    agent("gemini", false),
    agent("open_code"),
    agent("cline"),
    agent("grok"),
    agent("cursor"),
    agent("qoder"),
  ]

  it("shows the installed ones first, the first few of them, the rest a click away", () => {
    render(<Tiles agents={many} />)
    // Read out by what the agent is for, as its card's title says it.
    expect(
      screen.getByRole("radiogroup", { name: "Agent for its brain" })
    ).toBeInTheDocument()
    expect(tiles()).toEqual([
      "claude_code",
      "codex",
      "open_code",
      "cline",
      "grok",
      "cursor",
    ])
    fireEvent.click(document.querySelector("[data-pa-setup-agents-more]")!)
    expect(tiles()).toHaveLength(8)
    // One not installed is there, and cannot be picked.
    const gemini = document.querySelector<HTMLButtonElement>(
      '[data-pa-setup-agent-tile="gemini"]'
    )!
    expect(tiles()[tiles().length - 1]).toBe("gemini")
    expect(gemini).toBeDisabled()
  })

  it("marks the one picked", () => {
    render(<Tiles agents={many} />)
    const codex = document.querySelector<HTMLButtonElement>(
      '[data-pa-setup-agent-tile="codex"]'
    )!
    fireEvent.click(codex)
    expect(codex).toHaveAttribute("aria-checked", "true")
    expect(
      screen
        .getAllByRole("radio")
        .filter((r) => r.getAttribute("aria-checked") === "true")
    ).toHaveLength(1)
  })

  it("shows them all when the one picked is past the first few", () => {
    render(<Tiles agents={many} start="qoder" />)
    expect(tiles()).toHaveLength(8)
    expect(document.querySelector("[data-pa-setup-agents-more]")).toBeNull()
  })

  it("says so when there is none", () => {
    render(<Tiles agents={[]} />)
    expect(screen.getByText(/No agent is available yet/)).toBeInTheDocument()
  })

  it("says where to get one when none of them is installed", () => {
    render(<Tiles agents={[agent("codex", false)]} />)
    expect(tiles()).toEqual(["codex"])
    expect(screen.getByText(/No agent is available yet/)).toBeInTheDocument()
  })
})
