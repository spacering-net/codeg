import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it } from "vitest"

import { NotificationSoundSettingsSection } from "./notification-sound-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  DEFAULT_NOTIFICATION_SOUND_PREFS,
  loadNotificationSoundPrefs,
  resetNotificationSoundPrefsCacheForTests,
  type NotificationSoundPrefs,
} from "@/lib/notification-sound-prefs"

const STORAGE_KEY = "settings:notification-sound:v1"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <NotificationSoundSettingsSection />
    </NextIntlClientProvider>
  )
}

/**
 * Unfold the section. Everything below the heading arrives collapsed, so any
 * assertion about the knobs has to open it first.
 */
function expandSection() {
  fireEvent.click(screen.getByRole("button", { name: "Notification sounds" }))
}

/** Write the key the way another window would, then announce it. */
function writeFromAnotherWindow(prefs: NotificationSoundPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }))
  })
}

beforeEach(() => {
  localStorage.clear()
  resetNotificationSoundPrefsCacheForTests()
})

describe("NotificationSoundSettingsSection", () => {
  it("hides the per-event rows until sounds are enabled", () => {
    renderSection()

    expect(
      screen.getByRole("switch", { name: /notification sounds/i })
    ).not.toBeChecked()
    // With sounds off the section IS the master switch: the heading labels it,
    // so there is no second row (nor a card around one) saying so again — and
    // no disclosure button, because there is nothing to unfold.
    expect(screen.getAllByRole("switch")).toHaveLength(1)
    expect(
      screen.queryByRole("button", { name: "Notification sounds" })
    ).not.toBeInTheDocument()
    // The event catalogue is only meaningful once something can play.
    expect(screen.queryByText("Turn Complete")).not.toBeInTheDocument()
  })

  it("arrives folded even when sounds are already on", () => {
    // The General tab is a stack of sections; an enabled one still opens as
    // its heading line, not as a slider plus five event rows.
    writeFromAnotherWindow({
      ...DEFAULT_NOTIFICATION_SOUND_PREFS,
      enabled: true,
    })
    renderSection()

    expect(screen.getAllByRole("switch")).toHaveLength(1)
    expect(screen.queryByText("Turn Complete")).not.toBeInTheDocument()
  })

  it("persists the master switch and reveals the event catalogue", () => {
    renderSection()

    // Switching it on unfolds the section in the same gesture — no second
    // click needed to see what was just turned on.
    fireEvent.click(
      screen.getByRole("switch", { name: /notification sounds/i })
    )

    expect(loadNotificationSoundPrefs().enabled).toBe(true)
    // Same five triggers as the chat-channel Events tab, same wording.
    for (const label of [
      "Turn Complete",
      "Permission Request",
      "Agent Question",
      "Agent Error",
      "User Message",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it("shows the default tone of every event, including the silent one", () => {
    writeFromAnotherWindow({
      ...DEFAULT_NOTIFICATION_SOUND_PREFS,
      enabled: true,
    })
    renderSection()
    expandSection()

    expect(
      screen.getByRole("combobox", { name: "Turn Complete" })
    ).toHaveTextContent("Chime")
    expect(
      screen.getByRole("combobox", { name: "Permission Request" })
    ).toHaveTextContent("Alert")
    expect(
      screen.getByRole("combobox", { name: "Agent Question" })
    ).toHaveTextContent("Ding")
    expect(
      screen.getByRole("combobox", { name: "Agent Error" })
    ).toHaveTextContent("Descending")
    // user_prompt_sent echoes the user's own action — off out of the box.
    expect(
      screen.getByRole("combobox", { name: "User Message" })
    ).toHaveTextContent("Silent")
  })

  it("follows a change made in another window", () => {
    renderSection()
    expect(
      screen.getByRole("switch", { name: /notification sounds/i })
    ).not.toBeChecked()

    writeFromAnotherWindow({
      ...DEFAULT_NOTIFICATION_SOUND_PREFS,
      enabled: true,
      volume: 0.3,
    })

    expect(
      screen.getByRole("switch", { name: /notification sounds/i })
    ).toBeChecked()
    expandSection()
    expect(screen.getByText("30%")).toBeInTheDocument()
  })

  it("silences an event when its preview button is disabled", () => {
    writeFromAnotherWindow({
      ...DEFAULT_NOTIFICATION_SOUND_PREFS,
      enabled: true,
    })
    renderSection()
    expandSection()

    // A `none` tone has nothing to preview; every other row does.
    expect(
      screen.getByRole("button", { name: /preview the user message sound/i })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: /preview the turn complete sound/i })
    ).toBeEnabled()
  })
})
