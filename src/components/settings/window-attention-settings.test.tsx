import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PlatformType } from "@/hooks/use-platform"

const h = vi.hoisted(() => ({
  desktop: true,
  platform: "macos" as PlatformType,
}))

vi.mock("@/lib/platform", () => ({ isDesktop: () => h.desktop }))
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    platform: h.platform,
    isMac: h.platform === "macos",
    isWindows: h.platform === "windows",
    isLinux: h.platform === "linux",
  }),
}))

import { WindowAttentionSettingsSection } from "./window-attention-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  DEFAULT_WINDOW_ATTENTION_PREFS,
  loadWindowAttentionPrefs,
  resetWindowAttentionPrefsCacheForTests,
  type WindowAttentionPrefs,
} from "@/lib/window-attention-prefs"

const STORAGE_KEY = "settings:window-attention:v1"
const TITLE = "Taskbar and Dock alerts"
const copy = enMessages.WindowAttentionSettings

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WindowAttentionSettingsSection />
    </NextIntlClientProvider>
  )
}

/** Everything below the heading arrives folded. */
function expandSection() {
  fireEvent.click(screen.getByRole("button", { name: TITLE }))
}

/** Write the key the way another window would, then announce it. */
function writeFromAnotherWindow(prefs: WindowAttentionPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }))
  })
}

beforeEach(() => {
  localStorage.clear()
  resetWindowAttentionPrefsCacheForTests()
  h.desktop = true
  h.platform = "macos"
})

describe("WindowAttentionSettingsSection", () => {
  it("does not exist in a browser, which has no taskbar entry to flash", () => {
    h.desktop = false
    const { container } = renderSection()
    expect(container).toBeEmptyDOMElement()
  })

  it("waits for the platform before rendering anything", () => {
    // `unknown` is the pre-hydration state of the static export.
    h.platform = "unknown"
    const { container } = renderSection()
    expect(container).toBeEmptyDOMElement()
  })

  it("starts on, folded to its heading", () => {
    renderSection()

    expect(screen.getByRole("switch", { name: TITLE })).toBeChecked()
    expect(screen.queryByText("Turn Complete")).not.toBeInTheDocument()
  })

  it.each([
    ["macos", copy.descriptionMac, copy.eventsHintMac],
    ["windows", copy.descriptionWindows, copy.eventsHintWindows],
    ["linux", copy.descriptionLinux, copy.eventsHintLinux],
  ] as const)(
    "describes what %s actually does with the request",
    (platform, description, hint) => {
      h.platform = platform
      renderSection()
      expect(screen.getByText(description)).toBeInTheDocument()

      expandSection()
      expect(screen.getByText(hint)).toBeInTheDocument()
    }
  )

  it("shows every event at its default level", () => {
    renderSection()
    expandSection()

    const level = (event: string) =>
      screen.getByRole("combobox", { name: event })
    expect(level("Turn Complete")).toHaveTextContent("Briefly")
    expect(level("Permission Request")).toHaveTextContent("Until you return")
    expect(level("Agent Question")).toHaveTextContent("Until you return")
    expect(level("Agent Error")).toHaveTextContent("Briefly")
    expect(level("Background task")).toHaveTextContent("Briefly")
    expect(level("Work task")).toHaveTextContent("Briefly")
  })

  it("persists a level for one event without touching the others", async () => {
    // Siblings start away from their defaults, so a write that rebuilt the
    // set from defaults would show here.
    writeFromAnotherWindow({
      ...DEFAULT_WINDOW_ATTENTION_PREFS,
      levels: {
        ...DEFAULT_WINDOW_ATTENTION_PREFS.levels,
        turn_complete: "critical",
        permission_request: "off",
      },
    })
    const user = userEvent.setup()
    renderSection()
    expandSection()

    await user.click(screen.getByRole("combobox", { name: "Agent Error" }))
    const list = await screen.findByRole("listbox")
    await user.click(within(list).getByRole("option", { name: "Off" }))

    const stored = loadWindowAttentionPrefs()
    expect(stored.levels.error).toBe("off")
    expect(stored.levels.turn_complete).toBe("critical")
    expect(stored.levels.permission_request).toBe("off")
    expect(stored.levels.question_request).toBe("critical")
    expect(
      screen.getByRole("combobox", { name: "Agent Error" })
    ).toHaveTextContent("Off")
  })

  it("collapses to the master switch when turned off", () => {
    renderSection()
    expandSection()
    expect(screen.getByText("Turn Complete")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("switch", { name: TITLE }))

    expect(loadWindowAttentionPrefs().enabled).toBe(false)
    expect(screen.queryByText("Turn Complete")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: TITLE })
    ).not.toBeInTheDocument()
  })

  it("unfolds in the same gesture that switches it back on", () => {
    writeFromAnotherWindow({
      ...DEFAULT_WINDOW_ATTENTION_PREFS,
      enabled: false,
    })
    renderSection()

    fireEvent.click(screen.getByRole("switch", { name: TITLE }))

    expect(loadWindowAttentionPrefs().enabled).toBe(true)
    expect(screen.getByText("Turn Complete")).toBeInTheDocument()
  })

  it("follows a change made in another window", () => {
    renderSection()
    expandSection()

    writeFromAnotherWindow({
      ...DEFAULT_WINDOW_ATTENTION_PREFS,
      levels: {
        ...DEFAULT_WINDOW_ATTENTION_PREFS.levels,
        turn_complete: "critical",
      },
    })

    expect(
      screen.getByRole("combobox", { name: "Turn Complete" })
    ).toHaveTextContent("Until you return")
  })
})
