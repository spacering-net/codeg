import { act, fireEvent, render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// jsdom has no layout, so Motion can never decide that a dragged row crossed
// its neighbour. The fake keeps the wiring that matters here — the order the
// group reports while a drag is live, and the release that ends it — and hands
// both to the test to drive.
const motion = vi.hoisted(() => ({
  onReorder: null as ((next: unknown[]) => void) | null,
  dragEnd: new Map<string, () => void>(),
}))
vi.mock("motion/react", async () => {
  const { useLayoutEffect } = await import("react")
  const MOTION_ONLY = new Set([
    "as",
    "axis",
    "values",
    "onReorder",
    "value",
    "drag",
    "dragListener",
    "dragControls",
    "dragMomentum",
    "layout",
    "onDragEnd",
  ])
  const domProps = (props: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(props).filter(([key]) => !MOTION_ONLY.has(key))
    )
  function Group(
    props: Record<string, unknown> & {
      children?: ReactNode
      onReorder: (next: unknown[]) => void
    }
  ) {
    const { onReorder } = props
    useLayoutEffect(() => {
      motion.onReorder = onReorder
    })
    return <ul {...domProps(props)}>{props.children}</ul>
  }
  function Item(
    props: Record<string, unknown> & {
      children?: ReactNode
      value: string
      onDragEnd: () => void
    }
  ) {
    const { value, onDragEnd } = props
    useLayoutEffect(() => {
      motion.dragEnd.set(value, onDragEnd)
    })
    return <li {...domProps(props)}>{props.children}</li>
  }
  return {
    Reorder: { Group, Item },
    useDragControls: () => ({ start: () => {} }),
  }
})

import enMessages from "@/i18n/messages/en.json"
import {
  resetMentionPanelPrefsCacheForTests,
  saveMentionPanelPrefs,
  type MentionPanelPrefs,
} from "@/lib/mention-panel-prefs"

import { MentionPanelSettingsSection } from "./mention-panel-settings"

const KEY = "settings:mention-panel:v1"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MentionPanelSettingsSection />
    </NextIntlClientProvider>
  )
}

/** Tab names down the list, top to bottom. */
function rowNames(): string[] {
  const list = screen.getByRole("list", { name: "Mention panel tabs" })
  return within(list)
    .getAllByRole("listitem")
    .map((row) => row.getAttribute("data-mention-tab") ?? "")
}

function stored(): MentionPanelPrefs | null {
  const raw = localStorage.getItem(KEY)
  return raw ? (JSON.parse(raw) as MentionPanelPrefs) : null
}

const storedKinds = () => stored()?.tabs.map((tab) => tab.kind)

describe("MentionPanelSettingsSection", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMentionPanelPrefsCacheForTests()
    motion.onReorder = null
    motion.dragEnd.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("lists every tab in the built-in order, named as the panel names them", () => {
    renderSection()
    expect(
      screen.getByRole("heading", { name: "Mention panel" })
    ).toBeInTheDocument()
    expect(rowNames()).toEqual([
      "agent",
      "assistant",
      "file",
      "session",
      "commit",
    ])
    for (const name of [
      "Agents",
      "Assistants",
      "Files",
      "Sessions",
      "Commits",
    ]) {
      expect(
        screen.getByRole("switch", { name: `Show the “${name}” tab` })
      ).toHaveAttribute("data-state", "checked")
    }
    // Nothing customized yet, so there is nothing to reset.
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled()
  })

  it("keeps the Files switch on and inert, and says why", () => {
    renderSection()
    const files = screen.getByRole("switch", { name: "Show the “Files” tab" })
    expect(files).toBeDisabled()
    expect(files).toHaveAttribute("data-state", "checked")
    expect(files).toHaveAccessibleDescription("Always shown")
    // Every other tab can be switched off.
    expect(
      screen.getByRole("switch", { name: "Show the “Agents” tab" })
    ).toBeEnabled()
  })

  it("writes a switch straight through to the stored preference", () => {
    renderSection()
    const commits = screen.getByRole("switch", {
      name: "Show the “Commits” tab",
    })
    fireEvent.click(commits)
    expect(commits).toHaveAttribute("data-state", "unchecked")
    expect(stored()?.tabs).toContainEqual({ kind: "commit", visible: false })
    // The order is untouched by a visibility change.
    expect(storedKinds()).toEqual([
      "agent",
      "assistant",
      "file",
      "session",
      "commit",
    ])
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled()
  })

  it("applies two quick switches without the second undoing the first", () => {
    renderSection()
    // Both clicks land before React re-renders with the first one's result.
    act(() => {
      fireEvent.click(
        screen.getByRole("switch", { name: "Show the “Commits” tab" })
      )
      fireEvent.click(
        screen.getByRole("switch", { name: "Show the “Sessions” tab" })
      )
    })
    expect(stored()?.tabs).toEqual([
      { kind: "agent", visible: true },
      { kind: "assistant", visible: true },
      { kind: "file", visible: true },
      { kind: "session", visible: false },
      { kind: "commit", visible: false },
    ])
  })

  it("saves a dragged order once, on release", () => {
    renderSection()
    const dragged = ["file", "commit", "agent", "assistant", "session"]

    // Mid-drag the rows follow the pointer, but nothing is written yet — every
    // open composer is subscribed to the stored value.
    act(() => motion.onReorder?.(dragged))
    expect(rowNames()).toEqual(dragged)
    expect(stored()).toBeNull()

    act(() => motion.dragEnd.get("commit")?.())
    expect(storedKinds()).toEqual(dragged)
    expect(rowNames()).toEqual(dragged)
  })

  it("writes nothing when a drag ends where it started", () => {
    renderSection()
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    act(() =>
      motion.onReorder?.(["file", "agent", "assistant", "session", "commit"])
    )
    act(() =>
      motion.onReorder?.(["agent", "assistant", "file", "session", "commit"])
    )
    act(() => motion.dragEnd.get("agent")?.())
    // A press that never moved a row doesn't even report an order.
    act(() => motion.dragEnd.get("file")?.())
    expect(setItem).not.toHaveBeenCalled()
    expect(rowNames()).toEqual([
      "agent",
      "assistant",
      "file",
      "session",
      "commit",
    ])
  })

  /** Another window writing the preference, as this one sees it. */
  function writeElsewhere(prefs: MentionPanelPrefs) {
    act(() => {
      localStorage.setItem(KEY, JSON.stringify(prefs))
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }))
    })
  }

  it("keeps a switch flipped in another window while a drag is in flight", () => {
    renderSection()
    act(() =>
      motion.onReorder?.(["file", "agent", "assistant", "session", "commit"])
    )
    // The Commits tab is hidden elsewhere mid-drag…
    writeElsewhere({
      tabs: [
        { kind: "agent", visible: true },
        { kind: "assistant", visible: true },
        { kind: "file", visible: true },
        { kind: "session", visible: true },
        { kind: "commit", visible: false },
      ],
    })
    // …which this list shows straight away, drag or not…
    expect(
      screen.getByRole("switch", { name: "Show the “Commits” tab" })
    ).toHaveAttribute("data-state", "unchecked")
    expect(rowNames()).toEqual([
      "file",
      "agent",
      "assistant",
      "session",
      "commit",
    ])

    // …and the release writes the dragged order without undoing it.
    act(() => motion.dragEnd.get("file")?.())
    expect(stored()?.tabs).toEqual([
      { kind: "file", visible: true },
      { kind: "agent", visible: true },
      { kind: "assistant", visible: true },
      { kind: "session", visible: true },
      { kind: "commit", visible: false },
    ])
  })

  it("lets a reorder made elsewhere stand when a drag ends where it started", () => {
    renderSection()
    act(() =>
      motion.onReorder?.(["file", "agent", "assistant", "session", "commit"])
    )
    const elsewhere: MentionPanelPrefs = {
      tabs: [
        { kind: "commit", visible: true },
        { kind: "session", visible: true },
        { kind: "file", visible: true },
        { kind: "agent", visible: true },
        { kind: "assistant", visible: true },
      ],
    }
    writeElsewhere(elsewhere)
    act(() =>
      motion.onReorder?.(["agent", "assistant", "file", "session", "commit"])
    )
    act(() => motion.dragEnd.get("file")?.())
    // No net move here, so nothing of this drag's starting order is replayed.
    expect(stored()).toEqual(elsewhere)
    expect(rowNames()).toEqual([
      "commit",
      "session",
      "file",
      "agent",
      "assistant",
    ])
  })

  it("moves a tab with the arrow keys on its handle, keeping focus there", () => {
    renderSection()
    const handle = screen.getByRole("button", {
      name: "Move “Agents”: drag, or press the up and down arrow keys",
    })
    handle.focus()

    fireEvent.keyDown(handle, { key: "ArrowDown" })
    const once = ["assistant", "agent", "file", "session", "commit"]
    expect(storedKinds()).toEqual(once)
    expect(rowNames()).toEqual(once)
    expect(handle).toHaveFocus()

    fireEvent.keyDown(handle, { key: "ArrowDown" })
    fireEvent.keyDown(handle, { key: "ArrowDown" })
    fireEvent.keyDown(handle, { key: "ArrowDown" })
    const last = ["assistant", "file", "session", "commit", "agent"]
    expect(rowNames()).toEqual(last)
    expect(handle).toHaveFocus()

    // Already last: the key is left alone rather than claimed for nothing.
    const atEnd = fireEvent.keyDown(handle, { key: "ArrowDown" })
    expect(atEnd).toBe(true)
    expect(rowNames()).toEqual(last)

    fireEvent.keyDown(handle, { key: "ArrowUp" })
    expect(rowNames()).toEqual([
      "assistant",
      "file",
      "session",
      "agent",
      "commit",
    ])
  })

  it("resets to the built-in tabs", () => {
    saveMentionPanelPrefs({
      tabs: [
        { kind: "commit", visible: true },
        { kind: "file", visible: true },
        { kind: "agent", visible: false },
        { kind: "assistant", visible: true },
        { kind: "session", visible: false },
      ],
    })
    renderSection()
    expect(rowNames()).toEqual([
      "commit",
      "file",
      "agent",
      "assistant",
      "session",
    ])

    fireEvent.click(screen.getByRole("button", { name: "Reset" }))
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(rowNames()).toEqual([
      "agent",
      "assistant",
      "file",
      "session",
      "commit",
    ])
    expect(
      screen.getByRole("switch", { name: "Show the “Agents” tab" })
    ).toHaveAttribute("data-state", "checked")
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled()
  })

  it("follows a change made in another window", () => {
    renderSection()
    act(() => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          tabs: [
            { kind: "session", visible: true },
            { kind: "agent", visible: false },
            { kind: "file", visible: true },
            { kind: "commit", visible: true },
          ],
        })
      )
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }))
    })
    // Written before the assistant tab existed: it joins after its
    // neighbour, the hidden agent tab.
    expect(rowNames()).toEqual([
      "session",
      "agent",
      "assistant",
      "file",
      "commit",
    ])
    expect(
      screen.getByRole("switch", { name: "Show the “Agents” tab" })
    ).toHaveAttribute("data-state", "unchecked")
  })
})
