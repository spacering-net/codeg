import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it } from "vitest"
import en from "@/i18n/messages/en.json"
import {
  CONVERSATION_PANES_PREF_KEY,
  getConversationPanesEnabled,
} from "@/lib/conversation-pane-prefs"
import { ConversationPaneSettings } from "./conversation-pane-settings"

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ConversationPaneSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => localStorage.clear())

describe("multi-project island preference", () => {
  it("defaults to off, applies immediately, and persists across remounts", () => {
    const view = mount()
    const toggle = screen.getByRole("switch", {
      name: en.ConversationPanes.enabled,
    })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(toggle).toBeChecked()
    expect(getConversationPanesEnabled()).toBe(true)
    view.unmount()
    mount()
    expect(
      screen.getByRole("switch", { name: en.ConversationPanes.enabled })
    ).toBeChecked()
  })

  it("follows another window and treats cleared storage as off", () => {
    mount()
    act(() => {
      localStorage.setItem(CONVERSATION_PANES_PREF_KEY, "true")
      window.dispatchEvent(
        new StorageEvent("storage", { key: CONVERSATION_PANES_PREF_KEY })
      )
    })
    const toggle = screen.getByRole("switch", {
      name: en.ConversationPanes.enabled,
    })
    expect(toggle).toBeChecked()
    act(() => {
      localStorage.clear()
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
    })
    expect(toggle).not.toBeChecked()
  })
})
