import { act, cleanup, renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { isAssistantsPageCurrent } from "@/lib/assistants-page"
import type { BotLive, RosterEntry } from "@/lib/types"
import { usePersonalAgentRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

vi.mock("@/lib/api", () => ({
  // Never answers: the roster is what each test puts in the store.
  personalAgentBots: vi.fn(() => new Promise(() => {})),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))

import {
  resetAssistantShortcuts,
  useAssistantShortcuts,
} from "./use-assistant-shortcuts"

const NOW = Date.parse("2026-11-10T12:00:00Z")

function live(id: number, extra: Partial<BotLive> = {}): BotLive {
  return {
    bot_id: id,
    work: "idle",
    attention: "none",
    needs: null,
    unread: 0,
    activity: null,
    activity_known: true,
    work_on_hand: [],
    awaiting: [],
    face: "idle",
    flash: null,
    connected: true,
    last_line: null,
    last_activity_at: new Date(NOW - id * 60_000).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    expires_at: null,
    ...extra,
  }
}

function entry(
  id: number,
  kind: "primary" | "worker",
  extra: Partial<RosterEntry["roster"]> = {},
  state: Partial<BotLive> = {}
): RosterEntry {
  return {
    id,
    kind,
    uid: `u${id}`,
    name: `Bot ${id}`,
    avatar: { kind: "face", shape: "blob", color: "teal" },
    template: null,
    executor_assistant_id: null,
    created_at: "2026-11-01T00:00:00Z",
    roster: {
      sort_order: 0,
      pinned_at: null,
      section: null,
      hidden: false,
      muted: false,
      unread_mark: false,
      notify: true,
      ...extra,
    },
    live: live(id, state),
  }
}

/** The primary (1), then — by the roster's order — 3 (waiting on the
 *  owner), 2, 4 (the most recently active first); 5 is hidden. */
const ROSTER: RosterEntry[] = [
  entry(1, "primary"),
  entry(2, "worker"),
  entry(3, "worker", {}, { attention: "needs_you" }),
  entry(4, "worker"),
  entry(5, "worker", { hidden: true }),
]

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={{}}>
      {children}
    </NextIntlClientProvider>
  )
}

function press(
  key: string,
  modifiers: Partial<KeyboardEventInit> = {},
  target: EventTarget = document
): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

function release(key: string) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }))
  })
}

const view = () => usePersonalAgentUi.getState().viewBot

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  localStorage.clear()
  resetAssistantShortcuts()
  usePersonalAgentRoster.setState({ entries: ROSTER })
  usePersonalAgentUi.setState({ viewBot: null, settings: null })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("the assistants page's keys", () => {
  it("open the Nth assistant in the roster's order, hidden ones left out", () => {
    renderHook(() => useAssistantShortcuts(), { wrapper })
    expect(press("2", { metaKey: true }).defaultPrevented).toBe(true)
    expect(view()).toBe(3)
    press("4", { ctrlKey: true })
    expect(view()).toBe(4)
    press("1", { metaKey: true })
    expect(view()).toBeNull()
    // No fifth one shown: nothing happens, and the key is left alone.
    expect(press("5", { metaKey: true }).defaultPrevented).toBe(false)
    expect(view()).toBeNull()
  })

  it("walk up and down the roster, round the ends", () => {
    renderHook(() => useAssistantShortcuts(), { wrapper })
    press("ArrowDown", { altKey: true })
    expect(view()).toBe(3)
    press("ArrowDown", { altKey: true })
    press("ArrowDown", { altKey: true })
    expect(view()).toBe(4)
    press("ArrowDown", { altKey: true })
    expect(view()).toBeNull()
    press("ArrowUp", { altKey: true })
    expect(view()).toBe(4)
  })

  it("leave ⌥↑ / ⌥↓ to a field with text in it", () => {
    renderHook(() => useAssistantShortcuts(), { wrapper })
    const box = document.createElement("textarea")
    document.body.appendChild(box)
    box.focus()
    box.value = "half a message"
    const e = press("ArrowDown", { altKey: true }, box)
    expect(e.defaultPrevented).toBe(false)
    expect(view()).toBeNull()
    // Empty, it is the roster's again; ⌘N works with text too.
    box.value = ""
    press("ArrowDown", { altKey: true }, box)
    expect(view()).toBe(3)
    box.value = "text"
    press("1", { metaKey: true }, box)
    expect(view()).toBeNull()
    box.remove()
  })

  it("cycle through the ones opened last, further back while Ctrl is held", () => {
    const { rerender } = renderHook(() => useAssistantShortcuts(), {
      wrapper,
    })
    act(() => usePersonalAgentUi.getState().setViewBot(4))
    rerender()
    act(() => usePersonalAgentUi.getState().setViewBot(2))
    rerender()
    // Tapped: back to the one before, and again: back again.
    press("Tab", { ctrlKey: true })
    expect(view()).toBe(4)
    release("Control")
    press("Tab", { ctrlKey: true })
    expect(view()).toBe(2)
    release("Control")
    // Held: one further back each time — 4, the primary, then the one never
    // opened, then round.
    press("Tab", { ctrlKey: true })
    expect(view()).toBe(4)
    press("Tab", { ctrlKey: true })
    expect(view()).toBeNull()
    press("Tab", { ctrlKey: true })
    expect(view()).toBe(3)
    press("Tab", { ctrlKey: true })
    expect(view()).toBe(2)
    release("Control")
  })

  it("follow the owner's own bindings", () => {
    localStorage.setItem(
      "settings:shortcuts:v1",
      JSON.stringify({ switch_assistant_2: "mod+shift+2" })
    )
    renderHook(() => useAssistantShortcuts(), { wrapper })
    press("2", { metaKey: true })
    expect(view()).toBeNull()
    press("2", { metaKey: true, shiftKey: true, code: "Digit2" })
    expect(view()).toBe(3)
  })

  it("act only while the page is up, and say so", () => {
    const { unmount } = renderHook(() => useAssistantShortcuts(), {
      wrapper,
    })
    expect(isAssistantsPageCurrent()).toBe(true)
    unmount()
    expect(isAssistantsPageCurrent()).toBe(false)
    expect(press("2", { metaKey: true }).defaultPrevented).toBe(false)
    expect(view()).toBeNull()
  })

  it("leave a key something else handled first alone", () => {
    renderHook(() => useAssistantShortcuts(), { wrapper })
    const e = new KeyboardEvent("keydown", {
      key: "2",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    e.preventDefault()
    act(() => {
      document.dispatchEvent(e)
    })
    expect(view()).toBeNull()
  })
})
