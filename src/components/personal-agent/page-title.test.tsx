import { cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { RosterEntry } from "@/lib/types"
import { usePersonalAgentRoster } from "@/stores/personal-agent-roster-store"

const sw = vi.hoisted(() => ({ switching: false, to: null as number | null }))
const NOVA = {
  agent: {
    id: 1,
    kind: "primary",
    name: "Nova",
    avatar: { kind: "face", shape: "ring", color: "black" },
  },
  status: { engine: "here", turn: null },
}
const store = vi.hoisted(() => ({
  botId: null as number | null,
  snapshot: null as unknown,
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => store.botId,
  usePersonalAgent: () => ({
    botId: store.botId,
    needsOwner: false,
    snapshot: store.snapshot,
  }),
  usePersonalAgentSwitch: () => sw,
  usePrefetchAssistant: () => () => {},
}))
// Nothing here reaches the backend: a call never answers, so the roster
// stays as the test sets it.
vi.mock("@/lib/api", () => {
  const calls = new Map<string, unknown>()
  return new Proxy(
    {},
    {
      has: () => true,
      get: (_, name) => {
        if (typeof name !== "string" || name === "then") return undefined
        if (!calls.has(name))
          calls.set(
            name,
            vi.fn(() => new Promise(() => {}))
          )
        return calls.get(name)
      },
    }
  )
})
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn(), setRoute: vi.fn() }),
}))

import { PersonalAgentPageTitle } from "./personal-agent-page"

const entry = (id: number, kind: "primary" | "worker", name: string) =>
  ({
    id,
    kind,
    uid: `u${id}`,
    name,
    avatar: { kind: "face", shape: "braces", color: "teal" },
    persona: "",
    persona_unwritten: false,
    hidden: false,
    has_brain: true,
    legacy_assistant_id: null,
    created_at: "2026-11-10T10:00:00Z",
    roster: {
      sort_order: 0,
      pinned_at: null,
      section: null,
      hidden: false,
      muted: false,
      unread_mark: false,
      notify: true,
    },
    live: null,
  }) as unknown as RosterEntry

function draw() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PersonalAgentPageTitle />
    </NextIntlClientProvider>
  )
}

const capsule = () =>
  document.querySelector<HTMLElement>("[data-pa-title-capsule]")!

beforeEach(() => {
  sw.switching = false
  sw.to = null
  store.botId = null
  store.snapshot = NOVA
  usePersonalAgentRoster.setState({
    entries: [entry(1, "primary", "Nova"), entry(9, "worker", "Reviewer")],
  })
})
afterEach(cleanup)

describe("the title's capsule", () => {
  it("is the assistant shown, with the chevron that opens the list", () => {
    draw()
    expect(capsule().textContent).toBe("Nova")
    expect(capsule().getAttribute("aria-busy")).toBeNull()
    expect(document.querySelector("[data-pa-title-opening]")).toBeNull()
  })

  it("is the one picked at once while it is read, a spinner for the chevron", () => {
    sw.switching = true
    sw.to = 9
    draw()
    expect(capsule().textContent).toBe("Reviewer")
    expect(capsule().getAttribute("aria-busy")).toBe("true")
    expect(capsule().getAttribute("title")).toBe("Opening Reviewer…")
    expect(document.querySelector("[data-pa-title-opening]")).not.toBeNull()
  })

  it("is the one shown before it is read, after the wait gave up", () => {
    store.botId = 9
    store.snapshot = null
    draw()
    expect(capsule().textContent).toBe("Reviewer")
    expect(capsule().getAttribute("aria-busy")).toBe("true")
  })

  it("is the primary picked back, by its kind", () => {
    sw.switching = true
    sw.to = null
    draw()
    expect(capsule().textContent).toBe("Nova")
    expect(capsule().getAttribute("aria-busy")).toBe("true")
  })
})
