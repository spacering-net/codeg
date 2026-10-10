import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The web-mode app popup windows (commit / push / settings / import-sessions /
 * merge / stash) learn their target path from a backend round trip. The window
 * therefore has to be RESERVED inside the click's own call stack — opening it
 * after the await is reliably swallowed by popup blockers, because an HTTP
 * round trip outlasts every browser's user-activation window. These tests pin
 * that ordering, which is the whole point of `openAppWindow` in api.ts.
 * (Issue #410 is the markdown-link variant of the same bug.)
 */

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  shellCall: vi.fn(),
  isDesktop: vi.fn(() => false),
  isRemoteDesktopMode: vi.fn(() => false),
  getActiveRemoteConnectionId: vi.fn<() => string | null>(() => null),
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getShellTransport: () => ({ call: mocks.shellCall }),
  isDesktop: mocks.isDesktop,
  isRemoteDesktopMode: mocks.isRemoteDesktopMode,
  getActiveRemoteConnectionId: mocks.getActiveRemoteConnectionId,
  notifyRemoteDesktopUnauthorized: mocks.notifyRemoteDesktopUnauthorized,
}))

import { openCommitWindow, openSettingsWindow } from "@/lib/api"
import { openLocalWorkspace } from "@/lib/remote-workspace"

/** Stand-in for the reserved WindowProxy: only `location.href` and `close`. */
function fakePopup(initialHref = "about:blank") {
  const popup = { location: { href: initialHref }, close: vi.fn() }
  return popup
}

/** A promise plus its resolve/reject handles, so a test can hold the round
 *  trip open and inspect what happened before it settles. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("web-mode app popup windows", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.shellCall.mockReset()
    mocks.isDesktop.mockReset()
    mocks.isDesktop.mockReturnValue(false)
    mocks.getActiveRemoteConnectionId.mockReset()
    mocks.getActiveRemoteConnectionId.mockReturnValue(null)
    vi.restoreAllMocks()
  })

  it("reserves the window before the backend round trip, then navigates it", async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, "open").mockReturnValue(popup as never)
    const roundTrip = deferred<{ path: string }>()
    mocks.call.mockReturnValue(roundTrip.promise)

    const pending = openCommitWindow(7)

    // The window exists already — reserved in the caller's own task, with an
    // EMPTY url so a name that is already open is handed back un-navigated
    // (that is what preserves the reuse-by-name behaviour).
    expect(open).toHaveBeenCalledWith("", "commit-7")
    expect(popup.location.href).toBe("about:blank")

    roundTrip.resolve({ path: "/commit?folder=7" })
    await pending

    expect(popup.location.href).toBe("/commit?folder=7")
    expect(popup.close).not.toHaveBeenCalled()
  })

  it("rejects without calling the backend when the popup is blocked", async () => {
    // No window features are passed, so unlike the `noreferrer` popups in
    // ai-elements/link-safety.tsx a null return really does mean "blocked".
    vi.spyOn(window, "open").mockReturnValue(null)

    await expect(openSettingsWindow("appearance")).rejects.toThrow(/Popup/)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it("closes a window it just created when the round trip fails", async () => {
    const popup = fakePopup()
    vi.spyOn(window, "open").mockReturnValue(popup as never)
    mocks.call.mockRejectedValue(new Error("backend down"))

    await expect(openCommitWindow(7)).rejects.toThrow("backend down")
    expect(popup.close).toHaveBeenCalledTimes(1)
  })

  it("leaves an already-open window alone when the round trip fails", async () => {
    // Reserving an existing name hands back the user's open window; a failed
    // call must not close it out from under them.
    const popup = fakePopup("/commit?folder=7")
    vi.spyOn(window, "open").mockReturnValue(popup as never)
    mocks.call.mockRejectedValue(new Error("backend down"))

    await expect(openCommitWindow(7)).rejects.toThrow("backend down")
    expect(popup.close).not.toHaveBeenCalled()
    expect(popup.location.href).toBe("/commit?folder=7")
  })

  // Two clicks on the same action reserve the SAME window (that is what an
  // empty url buys us), so a failing request must not close the window a
  // concurrent request is still going to navigate. The call sites have no
  // in-flight guard — see handleOpenCommitWindow in aux-panel-git-changes-tab
  // and aux-panel-file-tree-tab — so this races in practice on a double-click.
  it.each([
    ["the failing request settles first", true],
    ["the succeeding request settles first", false],
  ])(
    "keeps a shared window when one of two concurrent requests fails (%s)",
    async (_, failFirst) => {
      const popup = fakePopup()
      vi.spyOn(window, "open").mockReturnValue(popup as never)
      const failing = deferred<{ path: string }>()
      const succeeding = deferred<{ path: string }>()
      mocks.call
        .mockReturnValueOnce(failing.promise)
        .mockReturnValueOnce(succeeding.promise)

      const first = openCommitWindow(7)
      const second = openCommitWindow(7)

      if (failFirst) {
        failing.reject(new Error("backend down"))
        await expect(first).rejects.toThrow("backend down")
        expect(popup.close).not.toHaveBeenCalled()
        succeeding.resolve({ path: "/commit?folder=7" })
        await second
      } else {
        succeeding.resolve({ path: "/commit?folder=7" })
        await second
        failing.reject(new Error("backend down"))
        await expect(first).rejects.toThrow("backend down")
      }

      // The window survives and shows the page the successful request asked for.
      expect(popup.close).not.toHaveBeenCalled()
      expect(popup.location.href).toBe("/commit?folder=7")
    }
  )

  it("closes the shared window only after every concurrent request has failed", async () => {
    const popup = fakePopup()
    vi.spyOn(window, "open").mockReturnValue(popup as never)
    const first = deferred<{ path: string }>()
    const second = deferred<{ path: string }>()
    mocks.call
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstCall = openCommitWindow(7)
    const secondCall = openCommitWindow(7)

    first.reject(new Error("backend down"))
    await expect(firstCall).rejects.toThrow("backend down")
    expect(popup.close).not.toHaveBeenCalled()

    second.reject(new Error("backend down"))
    await expect(secondCall).rejects.toThrow("backend down")
    expect(popup.close).toHaveBeenCalledTimes(1)
  })

  it("survives a cross-origin window whose location cannot be read", async () => {
    // Never one of our own app windows, but reading `location` on a
    // cross-origin WindowProxy throws — that must not replace the real error.
    const popup = {
      get location(): { href: string } {
        throw new DOMException("cross-origin", "SecurityError")
      },
      close: vi.fn(),
    }
    vi.spyOn(window, "open").mockReturnValue(popup as never)
    mocks.call.mockRejectedValue(new Error("backend down"))

    await expect(openCommitWindow(7)).rejects.toThrow("backend down")
    expect(popup.close).not.toHaveBeenCalled()
  })

  it("opens no browser window on desktop — the shell transport owns it", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    mocks.isDesktop.mockReturnValue(true)
    mocks.shellCall.mockResolvedValue(undefined)

    await openCommitWindow(7)

    expect(mocks.shellCall).toHaveBeenCalledWith(
      "open_commit_window",
      expect.objectContaining({ folderId: 7 })
    )
    expect(open).not.toHaveBeenCalled()
  })

  it("opens the local workspace even when the remote desktop is offline", async () => {
    mocks.isDesktop.mockReturnValue(true)
    mocks.isRemoteDesktopMode.mockReturnValue(true)
    mocks.getActiveRemoteConnectionId.mockReturnValue("12")
    mocks.call.mockImplementation(() => {
      throw new Error("remote server is offline")
    })
    mocks.shellCall.mockResolvedValue(undefined)

    await expect(openLocalWorkspace()).resolves.toBeUndefined()

    expect(mocks.shellCall).toHaveBeenCalledWith("open_local_workspace")
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
