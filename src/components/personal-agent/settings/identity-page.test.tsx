import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PersonalAgentInfo } from "@/lib/types"

vi.mock("@/lib/api", () => ({ personalAgentSave: vi.fn() }))
vi.mock("sonner", () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock("@/contexts/personal-agent-context", () => ({ useBotId: () => null }))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: [] }),
}))
// The brain's editors are the assistant editor's, tested there.
vi.mock("@/components/settings/agent-options-editor", () => ({
  AgentSelect: () => <div data-testid="agent-select" />,
  OptionBlock: ({ children }: { children: React.ReactNode }) => children,
  RequiredOptionRow: () => null,
  optionValueLabel: () => null,
}))
vi.mock("@/components/settings/required-agent-options", () => ({
  RequiredOptionsSection: () => null,
  useRequiredOptionsGate: () => ({
    gate: { kind: "unavailable-agent" },
    probe: { loading: false, reload: vi.fn() },
  }),
}))

import { IdentityPage } from "./identity-page"

function agent(name: string, color = "blue"): PersonalAgentInfo {
  return {
    id: 1,
    kind: "primary",
    name,
    avatar: { kind: "face", shape: "blob", color },
    agent_type: "claude_code",
    agent_options: {},
    label_snapshot: { agent: "Claude Code", mode: null, options: [] },
    revision: 1,
  } as unknown as PersonalAgentInfo
}

function page(a: PersonalAgentInfo) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <IdentityPage agent={a} bot={null} disabled={false} />
    </NextIntlClientProvider>
  )
}

afterEach(cleanup)

describe("the identity tab", () => {
  it("takes a name and picture saved elsewhere into a field left as it was, and keeps one being changed", () => {
    const { rerender } = render(page(agent("Nova")))
    const name = screen.getByLabelText("Name") as HTMLInputElement
    expect(name.value).toBe("Nova")
    // Renamed from the roster's "Edit basic info": the untouched field
    // follows.
    rerender(page(agent("Nova 2", "purple")))
    expect(name.value).toBe("Nova 2")
    // Being changed here: what the owner typed stays.
    fireEvent.change(name, { target: { value: "Mine" } })
    rerender(page(agent("Nova 3")))
    expect(name.value).toBe("Mine")
  })
})
