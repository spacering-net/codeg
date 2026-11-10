import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  browserClearData: vi.fn(),
  browserRemoveProfile: vi.fn(),
  browserCapabilitiesNow: vi.fn(),
  /** Which runtime the page thinks it is in; a box so the mock reads it at
   *  call time rather than closing over the value it had when hoisted. */
  desktop: { value: true },
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/browser/browser-api", () => ({
  browserClearData: mocks.browserClearData,
  browserRemoveProfile: mocks.browserRemoveProfile,
  browserCapabilitiesNow: mocks.browserCapabilitiesNow,
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => mocks.desktop.value }))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import { BrowserSettings } from "./browser-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  getBrowserPrefs,
  resetBrowserPrefsForTests,
  setBrowserDefaultAgentGrant,
  setBrowserEvalApproval,
  setBrowserHostRules,
  setBrowserNewTabProfile,
  setBrowserProfiles,
  setBrowserServiceAutoOpen,
  setDefaultLinkTarget,
} from "@/lib/browser/browser-prefs"

/** Awaited, because the page asks for the browser capabilities on mount: a
 *  synchronous render would land that answer's state update after the test
 *  body had already finished, outside `act`. */
async function renderSection() {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BrowserSettings />
      </NextIntlClientProvider>
    )
  })
  return result
}

function capabilitiesWith(proxy: {
  url: string | null
  applies: "live" | "next-tab" | "restart" | "unsupported"
  reason: string | null
}) {
  return {
    available: true,
    surface: "child",
    platform: "macos",
    channel: "native",
    reasons: [],
    isolatedStorage: true,
    proxy,
    downloadsDir: "/Users/dev/Downloads",
    docGuest: true,
    profiles: true,
    signInUserAgent: true,
    ownedWindowControls: false,
    remoteEgress: false,
    policy: { enabled: true, managedRules: [], managedSource: null },
  }
}

/** Capabilities of a platform without profiles (macOS 13, say): the one
 *  "clear browsing data" row instead of the profile list. */
function capabilitiesWithoutProfiles() {
  return {
    ...capabilitiesWith({ url: null, applies: "live", reason: null }),
    profiles: false,
    signInUserAgent: false,
    ownedWindowControls: false,
    remoteEgress: false,
  }
}

beforeEach(() => {
  resetBrowserPrefsForTests()
  mocks.desktop.value = true
  mocks.browserClearData.mockReset()
  mocks.browserRemoveProfile.mockReset()
  mocks.browserCapabilitiesNow.mockReset()
  mocks.browserCapabilitiesNow.mockResolvedValue(
    capabilitiesWith({ url: null, applies: "live", reason: null })
  )
  mocks.toast.success.mockReset()
  mocks.toast.error.mockReset()
})

describe("BrowserSettings", () => {
  it("shows one picker per link source", async () => {
    await renderSection()
    for (const source of [
      "Conversation messages",
      "Tool results",
      "Terminal",
      "Editor",
      "Notifications",
    ]) {
      expect(screen.getByRole("combobox", { name: source })).toHaveTextContent(
        "Built-in browser"
      )
    }
    // On out of the box: every engine takes the inspector as a creation-time
    // attribute, so off by default made "reopen the tab first" the answer to
    // every look at a page.
    expect(screen.getByLabelText("Web inspector")).toBeChecked()
    expect(
      screen.getByRole("combobox", { name: "Tab surface" })
    ).toHaveTextContent("Automatic")
  })

  it("adds, validates and removes site rules, writing the preference at once", async () => {
    await renderSection()
    expect(screen.getByText("No rules yet.")).toBeInTheDocument()

    const pattern = screen.getByRole("textbox", { name: "Site pattern" })
    fireEvent.change(pattern, { target: { value: " Blocked.Example " } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    // Stored normalized, with the picker's default action.
    expect(getBrowserPrefs().hostRules).toEqual([
      { pattern: "blocked.example", action: "system" },
    ])
    expect(screen.getByText("blocked.example")).toBeInTheDocument()
    expect(screen.queryByText("No rules yet.")).not.toBeInTheDocument()
    expect(pattern).toHaveValue("")

    fireEvent.change(pattern, { target: { value: "blocked.example" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(
      screen.getByText("There is already a rule for this pattern")
    ).toBeInTheDocument()
    expect(getBrowserPrefs().hostRules).toHaveLength(1)

    // Another spelling of the same rule is the same rule.
    fireEvent.change(pattern, { target: { value: "BLOCKED.example" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(
      screen.getByText("There is already a rule for this pattern")
    ).toBeInTheDocument()
    expect(getBrowserPrefs().hostRules).toHaveLength(1)

    fireEvent.change(pattern, { target: { value: "https://not a pattern" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByText("Not a valid pattern")).toBeInTheDocument()
    expect(getBrowserPrefs().hostRules).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Remove rule" }))
    expect(getBrowserPrefs().hostRules).toEqual([])
    expect(screen.getByText("No rules yet.")).toBeInTheDocument()
  })

  it("shows the administrator's rules read-only and says when the browser is turned off", async () => {
    mocks.browserCapabilitiesNow.mockResolvedValue({
      ...capabilitiesWith({ url: null, applies: "live", reason: null }),
      available: false,
      policy: {
        enabled: false,
        managedRules: [{ pattern: "*.internal.example", action: "block" }],
        managedSource: "/etc/codeg/policy.json",
      },
    })
    await renderSection()
    expect(await screen.findByText("*.internal.example")).toBeInTheDocument()
    expect(
      screen.getByText(/turned off by your administrator/)
    ).toBeInTheDocument()
    expect(
      screen.getAllByLabelText("Set by your administrator").length
    ).toBeGreaterThan(0)
    // Nothing to remove: it is not the user's row.
    expect(
      screen.queryByRole("button", { name: "Remove rule" })
    ).not.toBeInTheDocument()
  })

  // Notifying is the default, as it is in every editor that forwards a port
  // on its own: a tab opening by itself should be something a person turned
  // on. The trigger shows the LISTED item for the current value, so a mode
  // that reads back is a mode the picker offers.
  it("offers all three answers for a local server, notifying by default", async () => {
    await renderSection()
    const mode = () => screen.getByRole("combobox", { name: "Local servers" })
    expect(mode()).toHaveTextContent("Notify me")
    act(() => setBrowserServiceAutoOpen("open"))
    expect(mode()).toHaveTextContent("Open a tab")
    act(() => setBrowserServiceAutoOpen("off"))
    expect(mode()).toHaveTextContent("Do nothing")
    expect(getBrowserPrefs().serviceAutoOpen).toBe("off")
  })

  // Reading and acting is what a page hands over unless told otherwise, and
  // the third answer is the browser's original behaviour: hand nothing over
  // until the page's own control is used. The trigger renders the text of the
  // LISTED item for the current value, so a level that reads back is a level
  // the picker offers.
  it("offers all three sharing defaults, including handing nothing over", async () => {
    await renderSection()
    const level = () =>
      screen.getByRole("combobox", { name: "Default sharing level" })
    expect(level()).toHaveTextContent("Read and act")
    act(() => setBrowserDefaultAgentGrant("read"))
    expect(level()).toHaveTextContent("Read only")
    act(() => setBrowserDefaultAgentGrant("none"))
    expect(level()).toHaveTextContent("Share nothing")
    expect(getBrowserPrefs().defaultAgentGrant).toBe("none")
  })

  // Running without asking is what an installation does until someone says
  // otherwise, and this row is where they find that out: a person who never
  // opens it should still have read the truth in the hint beside it, so the
  // trigger has to show the default as the default.
  it("runs code without asking until the dialog is asked for", async () => {
    await renderSection()
    const policy = () =>
      screen.getByRole("combobox", { name: "Running code on a page" })
    expect(policy()).toHaveTextContent("Run without asking")
    act(() => setBrowserEvalApproval("ask"))
    expect(policy()).toHaveTextContent("Ask me every time")
    expect(getBrowserPrefs().evalApproval).toBe("ask")
    act(() => setBrowserEvalApproval("silent"))
    expect(policy()).toHaveTextContent("Run without asking")
    expect(getBrowserPrefs().evalApproval).toBe("silent")
  })

  it("persists the background-unload switch, which is off by default", async () => {
    await renderSection()
    const toggle = screen.getByLabelText("Unload background tabs")
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    expect(getBrowserPrefs().suspendBackgroundTabs).toBe(true)
    expect(screen.getByLabelText("Unload background tabs")).toBeChecked()

    fireEvent.click(screen.getByLabelText("Unload background tabs"))
    expect(getBrowserPrefs().suspendBackgroundTabs).toBe(false)
  })

  it("persists the terminal link-menu switch, which is off by default", async () => {
    await renderSection()
    const toggle = screen.getByLabelText("Terminal link menu")
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    expect(getBrowserPrefs().terminalClickMenu).toBe(true)
    expect(screen.getByLabelText("Terminal link menu")).toBeChecked()

    fireEvent.click(screen.getByLabelText("Terminal link menu"))
    expect(getBrowserPrefs().terminalClickMenu).toBe(false)
  })

  it("persists the HTML preview engine switch, on by default", async () => {
    await renderSection()
    const toggle = screen.getByLabelText("HTML file previews")
    expect(toggle).toBeChecked()
    await waitFor(() => expect(toggle).not.toBeDisabled())

    fireEvent.click(toggle)
    expect(getBrowserPrefs().htmlPreviewEngine).toBe("inline")
    expect(screen.getByLabelText("HTML file previews")).not.toBeChecked()

    fireEvent.click(screen.getByLabelText("HTML file previews"))
    expect(getBrowserPrefs().htmlPreviewEngine).toBe("guest")
  })

  it("leaves the HTML preview switch inert where no document guest exists", async () => {
    mocks.browserCapabilitiesNow.mockResolvedValue({
      ...capabilitiesWith({ url: null, applies: "live", reason: null }),
      docGuest: false,
      profiles: false,
      signInUserAgent: false,
      ownedWindowControls: false,
      remoteEgress: false,
    })
    await renderSection()
    await waitFor(() =>
      expect(screen.getByLabelText("HTML file previews")).toBeDisabled()
    )
  })

  it("persists the inspector switch and follows a change made elsewhere", async () => {
    await renderSection()

    // It starts on, so the press turns it off — and that is the state worth
    // persisting: it is the one that differs from the default.
    fireEvent.click(screen.getByLabelText("Web inspector"))
    expect(getBrowserPrefs().devtools).toBe(false)
    expect(screen.getByLabelText("Web inspector")).not.toBeChecked()
    fireEvent.click(screen.getByLabelText("Web inspector"))
    expect(getBrowserPrefs().devtools).toBe(true)
    expect(screen.getByLabelText("Web inspector")).toBeChecked()

    // The workspace window (the first-open toast) writes the same keys.
    act(() => setDefaultLinkTarget("terminal", "system"))
    expect(
      screen.getByRole("combobox", { name: "Terminal" })
    ).toHaveTextContent("System browser")
    expect(
      screen.getByRole("combobox", { name: "Conversation messages" })
    ).toHaveTextContent("Built-in browser")
  })

  it("clears browsing data only after confirmation", async () => {
    mocks.browserCapabilitiesNow.mockResolvedValue(
      capabilitiesWithoutProfiles()
    )
    mocks.browserClearData.mockResolvedValue(undefined)
    await renderSection()

    fireEvent.click(await screen.findByRole("button", { name: "Clear…" }))
    expect(mocks.browserClearData).not.toHaveBeenCalled()
    expect(
      screen.getByRole("heading", { name: "Clear browsing data?" })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => expect(mocks.browserClearData).toHaveBeenCalledTimes(1))
    expect(mocks.browserClearData).toHaveBeenCalledWith("default")
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("Browsing data cleared")
    )
  })

  it("lists the profiles with the default first and adds one by name", async () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    await renderSection()
    // The list appears once the backend says profiles exist here.
    expect(
      await screen.findByRole("button", { name: "Clear browsing data of Work" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Clear browsing data of Default" })
    ).toBeInTheDocument()
    // The default profile cannot be deleted.
    expect(
      screen.queryByRole("button", { name: "Delete profile Default" })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Delete profile Work" })
    ).toBeInTheDocument()
    // With profiles, the one "browsing data" row is gone: each row clears.
    expect(
      screen.queryByRole("button", { name: "Clear…" })
    ).not.toBeInTheDocument()

    const name = screen.getByRole("textbox", { name: "Profile name" })
    fireEvent.click(screen.getByRole("button", { name: "Add profile" }))
    expect(screen.getByText("Enter a name for the profile")).toBeInTheDocument()
    fireEvent.change(name, { target: { value: " work " } })
    fireEvent.click(screen.getByRole("button", { name: "Add profile" }))
    expect(
      screen.getByText("There is already a profile with this name")
    ).toBeInTheDocument()
    fireEvent.change(name, { target: { value: "Personal" } })
    fireEvent.click(screen.getByRole("button", { name: "Add profile" }))
    const profiles = getBrowserPrefs().profiles
    expect(profiles.map((p) => p.name)).toEqual(["Work", "Personal"])
    expect(profiles[1].id).toMatch(/^p-[0-9a-f]{12}$/)
    expect(name).toHaveValue("")

    // New tabs open in the chosen profile; the picker follows the list.
    const picker = screen.getByRole("combobox", { name: "New tabs open in" })
    expect(picker).toHaveTextContent("Default")
    act(() => setBrowserNewTabProfile("p-work"))
    expect(
      screen.getByRole("combobox", { name: "New tabs open in" })
    ).toHaveTextContent("Work")
  })

  it("clears one profile's data from its row", async () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    mocks.browserClearData.mockResolvedValue(undefined)
    await renderSection()
    fireEvent.click(
      await screen.findByRole("button", { name: "Clear browsing data of Work" })
    )
    expect(
      screen.getByText(/site storage of the profile Work will be removed/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() =>
      expect(mocks.browserClearData).toHaveBeenCalledWith("p-work")
    )
  })

  it("deletes a profile only once the backend has removed it", async () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    setBrowserNewTabProfile("p-work")
    mocks.browserRemoveProfile.mockResolvedValue(undefined)
    await renderSection()
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete profile Work" })
    )
    expect(
      screen.getByRole("heading", { name: "Delete profile Work?" })
    ).toBeInTheDocument()
    expect(mocks.browserRemoveProfile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(mocks.browserRemoveProfile).toHaveBeenCalledWith("p-work")
    )
    await waitFor(() => expect(getBrowserPrefs().profiles).toEqual([]))
    // The "new tabs" choice pointed at it and falls back on its own.
    expect(getBrowserPrefs().newTabProfile).toBe("default")
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("Profile deleted")
    )
  })

  it("closes a delete dialog whose profile vanished meanwhile", async () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    await renderSection()
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete profile Work" })
    )
    expect(
      screen.getByRole("heading", { name: "Delete profile Work?" })
    ).toBeInTheDocument()
    // Another window deleted it: nothing left to confirm.
    act(() => setBrowserProfiles([]))
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Delete profile Work?" })
      ).not.toBeInTheDocument()
    )
    expect(mocks.browserRemoveProfile).not.toHaveBeenCalled()
  })

  it("keeps a profile the backend could not delete", async () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    mocks.browserRemoveProfile.mockRejectedValue(new Error("store in use"))
    await renderSection()
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete profile Work" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Could not delete the profile: store in use"
      )
    )
    expect(getBrowserPrefs().profiles).toEqual([{ id: "p-work", name: "Work" }])
    // The dialog stays, with the failure toast on top of it.
    expect(
      screen.getByRole("heading", { name: "Delete profile Work?" })
    ).toBeInTheDocument()
  })

  it("persists the sign-in user-agent switch, on by default, where supported", async () => {
    await renderSection()
    const toggle = await screen.findByLabelText("Google sign-in compatibility")
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(getBrowserPrefs().signInUserAgent).toBe(false)
    expect(
      screen.getByLabelText("Google sign-in compatibility")
    ).not.toBeChecked()
  })

  it("hides the sign-in switch and the profile list where the platform has neither", async () => {
    mocks.browserCapabilitiesNow.mockResolvedValue(
      capabilitiesWithoutProfiles()
    )
    await renderSection()
    expect(
      await screen.findByRole("button", { name: "Clear…" })
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText("Google sign-in compatibility")
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Add profile" })
    ).not.toBeInTheDocument()
  })

  it("shows the proxy browser tabs use, fetched when the page opens", async () => {
    mocks.browserCapabilitiesNow.mockResolvedValue(
      capabilitiesWith({
        url: "http://127.0.0.1:7890",
        applies: "live",
        reason: null,
      })
    )
    await renderSection()
    // Read on every visit rather than once per app run: the proxy it reports
    // is set on another settings page, so a cached answer would go stale the
    // moment the user changed it and came back.
    expect(mocks.browserCapabilitiesNow).toHaveBeenCalled()
    expect(
      await screen.findByText("Using http://127.0.0.1:7890")
    ).toBeInTheDocument()
    expect(screen.queryByText(/Restart codeg/)).not.toBeInTheDocument()
  })

  it("explains when the proxy needs a restart or is not usable", async () => {
    mocks.browserCapabilitiesNow.mockResolvedValue(
      capabilitiesWith({
        url: "socks5://10.0.0.1:1080",
        applies: "restart",
        reason: "restart codeg for browser tabs to use the new proxy",
      })
    )
    const { unmount } = await renderSection()
    expect(
      await screen.findByText("Using socks5://10.0.0.1:1080")
    ).toBeInTheDocument()
    expect(screen.getByText(/Restart codeg/)).toBeInTheDocument()
    unmount()

    mocks.browserCapabilitiesNow.mockResolvedValue(
      capabilitiesWith({
        url: null,
        applies: "live",
        reason: "the built-in browser cannot use a https:// proxy",
      })
    )
    await renderSection()
    expect(
      await screen.findByText(/not one browser tabs can use/)
    ).toBeInTheDocument()
  })

  it("keeps the dialog and reports the failure when clearing fails", async () => {
    mocks.browserCapabilitiesNow.mockResolvedValue(
      capabilitiesWithoutProfiles()
    )
    mocks.browserClearData.mockRejectedValue(new Error("WebKit said no"))
    await renderSection()

    fireEvent.click(await screen.findByRole("button", { name: "Clear…" }))
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Could not clear browsing data: WebKit said no"
      )
    )
    expect(
      screen.getByRole("heading", { name: "Clear browsing data?" })
    ).toBeInTheDocument()
  })
})

/**
 * The workbench in a browser has no browser engine to embed, so almost all of
 * this page is the desktop's. Three settings are not: they decide something
 * there too and this page is the only place they can be set — which is why it
 * renders in both runtimes instead of being dropped in one.
 */
describe("BrowserSettings in a browser session", () => {
  beforeEach(() => {
    mocks.desktop.value = false
  })

  it("keeps the three settings that still decide something there", async () => {
    await renderSection()
    // A server started in a terminal still announces itself, and this picker
    // is the only way to stop it: the notice was unturnoffable while the page
    // was dropped.
    expect(
      screen.getByRole("combobox", { name: "Local servers" })
    ).toHaveTextContent("Notify me")
    expect(screen.getByLabelText("Terminal link menu")).toBeInTheDocument()
    expect(
      screen.getByRole("textbox", { name: "Site pattern" })
    ).toBeInTheDocument()
  })

  it("drops every row that describes a browser engine, and asks for no capabilities", async () => {
    await renderSection()
    for (const source of ["Conversation messages", "Terminal"]) {
      expect(screen.queryByRole("combobox", { name: source })).toBeNull()
    }
    expect(screen.queryByLabelText("Web inspector")).toBeNull()
    expect(screen.queryByRole("combobox", { name: "Tab surface" })).toBeNull()
    expect(screen.queryByLabelText("Unload background tabs")).toBeNull()
    expect(screen.queryByLabelText("HTML file previews")).toBeNull()
    expect(
      screen.queryByRole("combobox", { name: "Default sharing level" })
    ).toBeNull()
    expect(
      screen.queryByRole("combobox", { name: "Running code on a page" })
    ).toBeNull()
    // Nothing on the page needs the answer, and the backend behind a browser
    // session has no browser to describe.
    expect(mocks.browserCapabilitiesNow).not.toHaveBeenCalled()
  })

  it("still writes the local-server preference", async () => {
    await renderSection()
    act(() => setBrowserServiceAutoOpen("off"))
    expect(
      screen.getByRole("combobox", { name: "Local servers" })
    ).toHaveTextContent("Do nothing")
    expect(getBrowserPrefs().serviceAutoOpen).toBe("off")
  })

  it("offers blocking and nothing else, because nothing else would be carried out", async () => {
    await renderSection()
    // The picker beside the new-rule field, and so the action a rule added
    // here is written with.
    expect(screen.getByRole("combobox", { name: "Action" })).toHaveTextContent(
      "Block"
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Site pattern" }), {
      target: { value: "ads.example" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(getBrowserPrefs().hostRules).toEqual([
      { pattern: "ads.example", action: "block" },
    ])
  })

  it("shows a rule's own answer even when this runtime does not offer it", async () => {
    act(() =>
      setBrowserHostRules([{ pattern: "docs.example", action: "system" }])
    )
    await renderSection()
    // Hand-written, or written by a build that offered it: the row says what
    // the rule says rather than rendering an empty picker.
    expect(
      screen.getByRole("combobox", { name: "Action for docs.example" })
    ).toHaveTextContent("System browser")
  })
})
