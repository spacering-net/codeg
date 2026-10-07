import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ComputerStatePayload,
  ComputerStatus,
  GrantLevel,
  PickerWindow,
  ShareManyResult,
  SharedWindow,
} from "@/lib/computer/types"

const api = vi.hoisted(() => ({
  computerAvailable: vi.fn(() => false),
  useComputerAvailable: () => api.computerAvailable(),
  askComputerServed: vi.fn(async () => api.computerAvailable()),
  subscribeComputerServed: vi.fn(() => () => {}),
  computerServerPlatform: vi.fn(() => null),
  computerListShareableWindows: vi.fn<() => Promise<PickerWindow[]>>(),
  computerShareWindow: vi.fn(),
  computerShareApp:
    vi.fn<(app: object, level: string) => Promise<ComputerStatePayload>>(),
  computerShareScreen:
    vi.fn<(level: string) => Promise<ComputerStatePayload>>(),
  computerShareWindows:
    vi.fn<(ids: string[], level: string) => Promise<ShareManyResult>>(),
  computerRevokeAll: vi.fn(async () => {}),
  computerWindowThumbnail: vi.fn(async () => null),
  computerStatus: vi.fn<() => Promise<ComputerStatus>>(),
  computerRequestPermission: vi.fn(async () => ({
    report: { required: true, accessibility: true, screenRecording: false },
    prompted: false,
  })),
  computerOpenPermissionSettings: vi.fn(async () => {}),
  computerRevealHelper: vi.fn(async () => {}),
}))
vi.mock("@/lib/computer/computer-api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(() => Promise.resolve(() => {})),
}))

import { ComputerWindowPicker } from "./computer-window-picker"
import enMessages from "@/i18n/messages/en.json"
import {
  resetComputerStoreForTest,
  setComputerShared,
} from "@/lib/computer/computer-store"

function window(
  level: PickerWindow["level"],
  overrides: Partial<PickerWindow> = {}
): PickerWindow {
  return {
    targetId: "w1",
    appName: "TextEdit",
    appKey: "com.apple.TextEdit",
    pid: 42,
    title: "notes.txt",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    onScreen: true,
    minimized: false,
    hidden: false,
    level,
    ...overrides,
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComputerWindowPicker open onOpenChange={() => {}} />
    </NextIntlClientProvider>
  )
}

function status(screenRecording: boolean): ComputerStatus {
  return {
    enabled: true,
    platform: "macos",
    verifiedPlatform: false,
    backend: { state: "ready", driverVersion: "0.28.2", peer: "verified" },
    permissions: { required: true, accessibility: true, screenRecording },
    shared: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetComputerStoreForTest()
  api.computerAvailable.mockReturnValue(false)
})

describe("ComputerWindowPicker", () => {
  /** A window shared before this window of codeg loaded is shown as shared —
   * the list says so, and the store has not been told anything yet. */
  it("shows a grant the store has not heard of yet", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("read")])
    mount()
    const levels = await levelsOf("TextEdit")
    expect(levels.getByRole("button", { name: "Read" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  /** The windows are grouped by application, and an application can be
   * shared as a whole from its group — by one of its windows the first time,
   * by its share after. Its windows then go with it: shown at its level,
   * their own choices waiting. */
  it("shares an application as a whole from its group", async () => {
    const one = window("none", { targetId: "w1" })
    const two = window("none", { targetId: "w2", title: "todo.txt" })
    const mail = window("none", {
      targetId: "w3",
      appName: "Mail",
      appKey: "com.apple.mail",
      pid: 7,
    })
    api.computerListShareableWindows.mockResolvedValue([one, two, mail])
    api.computerShareApp.mockResolvedValue({
      shared: [
        { ...sharedOf(one, "control"), wholeApp: true, appId: "a1" },
        { ...sharedOf(two, "control"), wholeApp: true, appId: "a1" },
      ],
      apps: [
        {
          appId: "a1",
          appName: "TextEdit",
          appKey: one.appKey,
          level: "control",
          grantedAt: 0,
          lastUsedAt: 0,
          windows: 2,
        },
      ],
    })
    mount()
    const app = await appLevelsOf("TextEdit")
    await act(async () => {
      fireEvent.click(app.getByRole("button", { name: "Act" }))
    })
    expect(api.computerShareApp).toHaveBeenCalledWith(
      { targetId: "w1" },
      "control"
    )
    expect(app.getByRole("button", { name: "Act" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    const tiles = screen.getAllByRole("group", {
      name: "What agents may do with TextEdit",
    })
    expect(tiles).toHaveLength(2)
    for (const tile of tiles) {
      expect(within(tile).getByRole("button", { name: "Act" })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      expect(within(tile).getByRole("button", { name: "Off" })).toBeDisabled()
    }
    expect(screen.getAllByText("With the app")).toHaveLength(2)
    expect(
      (await levelsOf("Mail")).getByRole("button", { name: "Off" })
    ).toHaveAttribute("aria-pressed", "true")

    api.computerShareApp.mockResolvedValue({ shared: [], apps: [] })
    await act(async () => {
      fireEvent.click(app.getByRole("button", { name: "Off" }))
    })
    expect(api.computerShareApp).toHaveBeenLastCalledWith(
      { appId: "a1" },
      "none"
    )
  })

  /** Where it is offered, the entire screen heads the list; sharing it
   * takes every window with it, their own choices — and their
   * applications' — waiting while it is shared. */
  it("shares the entire screen, which every window goes with", async () => {
    const one = window("none", { targetId: "w1" })
    api.computerAvailable.mockReturnValue(true)
    api.computerStatus.mockResolvedValue({
      ...status(true),
      screenOffered: true,
    })
    api.computerListShareableWindows.mockResolvedValue([one])
    api.computerShareScreen.mockResolvedValue({
      shared: [{ ...sharedOf(one, "read"), wholeScreen: true }],
      apps: [],
      screen: { level: "read", grantedAt: 0, lastUsedAt: 0, windows: 1 },
    })
    mount()
    const card = within(
      await screen.findByRole("group", {
        name: "What agents may do with the entire screen",
      })
    )
    await act(async () => {
      fireEvent.click(card.getByRole("button", { name: "Read" }))
    })
    expect(api.computerShareScreen).toHaveBeenCalledWith("read")
    expect(card.getByRole("button", { name: "Read" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    const levels = await levelsOf("TextEdit")
    expect(levels.getByRole("button", { name: "Read" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(levels.getByRole("button", { name: "Off" })).toBeDisabled()
    expect(screen.getByText("With the screen")).toBeInTheDocument()
    expect(
      (await appLevelsOf("TextEdit")).getByRole("button", { name: "Act" })
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: /Share all/ })).toBeDisabled()
  })

  /** Where it is not offered — switched off, or on Linux — the screen is
   * not in the list. */
  it("offers the entire screen only where it is offered", async () => {
    api.computerAvailable.mockReturnValue(true)
    api.computerStatus.mockResolvedValue(status(true))
    api.computerListShareableWindows.mockResolvedValue([window("none")])
    mount()
    await levelsOf("TextEdit")
    expect(
      screen.queryByRole("group", {
        name: "What agents may do with the entire screen",
      })
    ).toBeNull()
  })

  /** "Share all" leaves a window shared with its whole application to it. */
  it("leaves a whole application's windows out of sharing all", async () => {
    const one = window("none", { targetId: "w1" })
    const mail = window("none", {
      targetId: "w3",
      appName: "Mail",
      appKey: "com.apple.mail",
      pid: 7,
    })
    api.computerListShareableWindows.mockResolvedValue([one, mail])
    api.computerShareWindows.mockResolvedValue({ shared: [], skipped: 0 })
    act(() =>
      setComputerShared([
        { ...sharedOf(one, "read"), wholeApp: true, appId: "a1" },
      ])
    )
    mount()
    await openMenu(await screen.findByRole("button", { name: /Share all/ }))
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Let agents read all of them" })
      )
    })
    expect(api.computerShareWindows).toHaveBeenCalledWith(["w3"], "read")
  })

  /** A window off the screen says why: minimized, or its application
   * hidden (⌘H) — minimized first, when it is both. */
  it("marks a window that is minimized or hidden", async () => {
    api.computerListShareableWindows.mockResolvedValue([
      window("none", { targetId: "w1", appName: "Notes", hidden: true }),
      window("none", {
        targetId: "w2",
        appName: "Mail",
        minimized: true,
        hidden: true,
      }),
      window("none", { targetId: "w3", appName: "TextEdit" }),
    ])
    mount()
    await levelsOf("Notes")
    expect(screen.getByText("Hidden")).toBeInTheDocument()
    expect(screen.getByText("Minimized")).toBeInTheDocument()
    expect(screen.getAllByText(/^(Hidden|Minimized)$/)).toHaveLength(2)
  })

  /** Once the store knows, it is the live word: a grant that ended while the
   * picker was open shows as ended. */
  it("follows the store once it knows", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("read")])
    mount()
    const levels = await levelsOf("TextEdit")
    act(() => setComputerShared([]))
    expect(levels.getByRole("button", { name: "Off" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(levels.getByRole("button", { name: "Read" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  /** A Stop — even from another codeg window — ends every sharing and holds
   * nothing back: the window is on offer again at once. */
  it("offers sharing again straight after a Stop", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("read")])
    api.computerShareWindow.mockResolvedValue([])
    mount()
    const levels = await levelsOf("TextEdit")
    act(() => setComputerShared([]))
    expect(levels.getByRole("button", { name: "Read" })).toBeEnabled()
    await act(async () => {
      fireEvent.click(levels.getByRole("button", { name: "Read" }))
      await Promise.resolve()
    })
    expect(api.computerShareWindow).toHaveBeenCalledWith("w1", "read")
  })

  /** The toolbar says how many of the windows are shared; each window's
   *  level is marked where it is changed. */
  it("counts the shared windows and marks each one's level", async () => {
    api.computerListShareableWindows.mockResolvedValue([
      window("read"),
      window("none", { targetId: "w2", appName: "Notes", title: "todo" }),
    ])
    mount()
    expect(await screen.findByText(/1 shared/)).toBeInTheDocument()
    const textEdit = await levelsOf("TextEdit")
    const notes = await levelsOf("Notes")
    const pressed = (levels: typeof textEdit) =>
      levels
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.textContent)
    expect(pressed(textEdit)).toEqual(["Read"])
    expect(pressed(notes)).toEqual(["Off"])
  })

  /** Each level is one click, from any other — acting straight away, or
   *  taking a shared window back — and the one in force does nothing. */
  it("changes a window's level with one click", async () => {
    const listed = [
      window("none"),
      window("read", { targetId: "w2", appName: "Notes", title: "todo" }),
    ]
    api.computerListShareableWindows.mockResolvedValue(listed)
    // The backend's answer: every window shared once the change is made.
    let shared: SharedWindow[] = [sharedOf(listed[1], "read")]
    api.computerShareWindow.mockImplementation(
      async (targetId: string, level: GrantLevel) => {
        shared = shared.filter((w) => w.targetId !== targetId)
        const item = listed.find((w) => w.targetId === targetId)!
        if (level !== "none") shared = [...shared, sharedOf(item, level)]
        return shared
      }
    )
    mount()
    const textEdit = await levelsOf("TextEdit")
    const notes = await levelsOf("Notes")
    await act(async () => {
      fireEvent.click(textEdit.getByRole("button", { name: "Act" }))
      await Promise.resolve()
    })
    expect(api.computerShareWindow).toHaveBeenLastCalledWith("w1", "control")
    expect(textEdit.getByRole("button", { name: "Act" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await act(async () => {
      fireEvent.click(notes.getByRole("button", { name: "Off" }))
      await Promise.resolve()
    })
    expect(api.computerShareWindow).toHaveBeenLastCalledWith("w2", "none")
    expect(notes.getByRole("button", { name: "Off" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await act(async () => {
      fireEvent.click(notes.getByRole("button", { name: "Off" }))
      await Promise.resolve()
    })
    expect(api.computerShareWindow).toHaveBeenCalledTimes(2)
  })

  /** "All" is every window that can be shared — what the grid shows — and
   * never one of the windows kept out of it. */
  it("shares every shareable window at once", async () => {
    api.computerListShareableWindows.mockResolvedValue([
      window("none"),
      window("read", { targetId: "w2", appName: "Notes", title: "todo" }),
      window("none", {
        targetId: "w3",
        appName: "codeg",
        title: "codeg",
        notGrantable: "codeg",
      }),
    ])
    api.computerShareWindows.mockResolvedValue({ shared: [], skipped: 0 })
    mount()
    await openMenu(await screen.findByRole("button", { name: /Share all/ }))
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", {
          name: "Let agents read and act on all of them",
        })
      )
      await Promise.resolve()
    })
    expect(api.computerShareWindows).toHaveBeenCalledWith(
      ["w1", "w2"],
      "control"
    )
  })

  /** A window that closed between the list and the share is reported, and
   * the list read again. */
  it("says how many could not be shared", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("none")])
    api.computerShareWindows.mockResolvedValue({ shared: [], skipped: 1 })
    mount()
    await openMenu(await screen.findByRole("button", { name: /Share all/ }))
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Let agents read all of them" })
      )
      await Promise.resolve()
    })
    expect(
      await screen.findByText(
        "1 window could not be shared; it may have closed."
      )
    ).toBeInTheDocument()
    expect(api.computerListShareableWindows).toHaveBeenCalledTimes(2)
  })

  /** One change at a time: "stop sharing all" waits for a share still on
   *  its way, which would otherwise land after it and undo it. */
  it("takes one change at a time", async () => {
    api.computerListShareableWindows.mockResolvedValue([
      window("read"),
      window("none", { targetId: "w2", appName: "Notes", title: "todo" }),
    ])
    api.computerShareWindow.mockReturnValue(new Promise(() => {}))
    mount()
    const stopAll = await screen.findByRole("button", {
      name: "Stop sharing all",
    })
    const notes = await levelsOf("Notes")
    await act(async () => {
      fireEvent.click(notes.getByRole("button", { name: "Act" }))
      await Promise.resolve()
    })
    expect(stopAll).toBeDisabled()
    expect(screen.getByRole("button", { name: /Share all/ })).toBeDisabled()
    const textEdit = await levelsOf("TextEdit")
    expect(textEdit.getByRole("button", { name: "Off" })).toBeDisabled()
    expect(notes.getByRole("button", { name: "Read" })).toBeDisabled()
  })

  /** Stopping every sharing is there once anything is shared. */
  it("stops sharing every window at once", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("read")])
    mount()
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop sharing all" })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.computerRevokeAll).toHaveBeenCalled()
  })

  /** Without Screen Recording there are no titles and no pictures: the
   *  picker says so and offers to grant it. */
  it("says Screen Recording is missing and offers it", async () => {
    api.computerAvailable.mockReturnValue(true)
    api.computerStatus.mockResolvedValue(status(false))
    api.computerListShareableWindows.mockResolvedValue([
      window("none", { title: "" }),
    ])
    mount()
    expect(
      await screen.findByText(/doesn't have Screen Recording yet/)
    ).toBeInTheDocument()
    expect(screen.getByText("Untitled window")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Grant…" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.computerRequestPermission).toHaveBeenCalledWith(
      "screenRecording"
    )
  })

  /** A request that fails says why, where it was made. */
  it("says why a permission request failed", async () => {
    api.computerAvailable.mockReturnValue(true)
    api.computerStatus.mockResolvedValue(status(false))
    api.computerRequestPermission.mockRejectedValueOnce(
      new Error("the helper is not running")
    )
    api.computerListShareableWindows.mockResolvedValue([window("none")])
    mount()
    await screen.findByText(/doesn't have Screen Recording yet/)
    fireEvent.click(screen.getByRole("button", { name: "Grant…" }))
    expect(
      await screen.findByText("the helper is not running")
    ).toBeInTheDocument()
  })

  /** Back from System Settings with Screen Recording granted, the windows
   *  are listed again and their pictures fetched again — and the notice is
   *  gone. */
  it("reads the windows again once Screen Recording arrives", async () => {
    api.computerAvailable.mockReturnValue(true)
    api.computerStatus.mockResolvedValue(status(false))
    api.computerListShareableWindows.mockResolvedValue([window("none")])
    mount()
    await screen.findByText(/doesn't have Screen Recording yet/)
    await levelsOf("TextEdit")
    expect(api.computerListShareableWindows).toHaveBeenCalledTimes(1)
    expect(api.computerWindowThumbnail).toHaveBeenCalledTimes(1)

    api.computerStatus.mockResolvedValue(status(true))
    await act(async () => {
      globalThis.window.dispatchEvent(new Event("focus"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByText(/doesn't have Screen Recording yet/)).toBeNull()
    expect(api.computerListShareableWindows).toHaveBeenCalledTimes(2)
    expect(api.computerWindowThumbnail).toHaveBeenCalledTimes(2)
  })

  /** Refresh fetches the pictures again, not only the list. */
  it("fetches the pictures again on refresh", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("none")])
    mount()
    await levelsOf("TextEdit")
    expect(api.computerWindowThumbnail).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.computerWindowThumbnail).toHaveBeenCalledTimes(2)
  })

  /** Windows that can never be shared are kept out of the grid, folded
   * away with their reasons — codeg's with why. */
  it("folds the windows that cannot be shared away, with the reason", async () => {
    api.computerListShareableWindows.mockResolvedValue([
      window("none"),
      window("none", {
        targetId: "w3",
        appName: "codeg",
        title: "Settings",
        notGrantable: "codeg",
      }),
    ])
    mount()
    await levelsOf("TextEdit")
    expect(screen.queryByText("codeg's window")).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "1 window can't be shared" })
    )
    expect(await screen.findByText("codeg's window")).toBeInTheDocument()
    expect(
      screen.getByText(/could approve its own requests/)
    ).toBeInTheDocument()
  })
})

/** The level buttons of the whole application `app`. */
async function appLevelsOf(app: string) {
  return within(
    await screen.findByRole("group", {
      name: `What agents may do with all of ${app}`,
    })
  )
}

function sharedOf(item: PickerWindow, level: GrantLevel): SharedWindow {
  return {
    targetId: item.targetId,
    appName: item.appName,
    appKey: item.appKey,
    title: item.title,
    level,
    grantedAt: 0,
    lastUsedAt: 0,
  }
}

/** The level buttons of the window of `app`. */
async function levelsOf(app: string) {
  return within(
    await screen.findByRole("group", {
      name: `What agents may do with ${app}`,
    })
  )
}

// jsdom has no `PointerEvent`; Radix reads `button` off the event.
function fireMouse(target: Element, type: string) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  )
}

async function openMenu(trigger: Element) {
  await act(async () => {
    fireMouse(trigger, "pointerdown")
    fireMouse(trigger, "pointerup")
    fireMouse(trigger, "click")
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
