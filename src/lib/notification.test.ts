import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const shellCall = vi.fn<(command: string, args?: unknown) => Promise<unknown>>(
  async () => undefined
)
const remoteCall = vi.fn(async () => undefined)
const desktop = vi.fn(() => true)

vi.mock("./transport", () => ({
  getShellTransport: () => ({ call: shellCall }),
  // Present so a mistaken `getTransport()` in the module under test is a
  // failed assertion here rather than a silent notification sent to whichever
  // machine the remote workspace lives on.
  getTransport: () => ({ call: remoteCall }),
  isDesktop: () => desktop(),
}))

import {
  deliverSystemNotification,
  getNotificationIdentity,
  getNotificationPermission,
  openSystemNotificationSettings,
  requestNotificationPermission,
} from "./notification"

interface FakeNotificationCtor {
  (title: string, options?: { body?: string }): void
  permission: string
  requestPermission: () => Promise<string>
}

/** Install a browser `Notification` with the given permission state. */
function installNotification(
  permission: string,
  requestResult = permission
): { constructed: Array<[string, { body?: string } | undefined]> } {
  const constructed: Array<[string, { body?: string } | undefined]> = []
  const ctor = function (title: string, options?: { body?: string }) {
    constructed.push([title, options])
  } as unknown as FakeNotificationCtor
  ctor.permission = permission
  ctor.requestPermission = vi.fn(async () => {
    ctor.permission = requestResult
    return requestResult
  })
  Object.defineProperty(window, "Notification", {
    value: ctor,
    configurable: true,
    writable: true,
  })
  return { constructed }
}

function removeNotification() {
  Object.defineProperty(window, "Notification", {
    value: undefined,
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  shellCall.mockClear()
  remoteCall.mockClear()
  desktop.mockReturnValue(true)
  removeNotification()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("getNotificationPermission", () => {
  it("reports the desktop as OS-managed rather than inventing a state", () => {
    // Neither notification backend exposes one: the Tauri plugin hard-codes
    // `Granted` on desktop and mac-notification-sys has no permission API at
    // all. Claiming "granted" here would tell a user with Codeg switched off
    // in System Settings that everything is fine.
    expect(getNotificationPermission()).toBe("managed_by_os")
  })

  it("reports `unsupported` when the browser has no Notification API", () => {
    // The shape of a `codeg-server` reached over plain http:// on a LAN
    // address: not a secure context, so the constructor is simply absent.
    desktop.mockReturnValue(false)
    expect(getNotificationPermission()).toBe("unsupported")
  })

  it.each([
    ["granted", "granted"],
    ["denied", "denied"],
    ["default", "default"],
    ["something-else", "default"],
  ])("maps browser permission %s to %s", (browser, expected) => {
    desktop.mockReturnValue(false)
    installNotification(browser)
    expect(getNotificationPermission()).toBe(expected)
  })
})

describe("requestNotificationPermission", () => {
  it("asks the browser and reports the answer", async () => {
    desktop.mockReturnValue(false)
    installNotification("default", "granted")

    await expect(requestNotificationPermission()).resolves.toBe("granted")
  })

  it("is a no-op on desktop", async () => {
    await expect(requestNotificationPermission()).resolves.toBe("managed_by_os")
  })

  it("treats a rejected request as still undecided", async () => {
    desktop.mockReturnValue(false)
    installNotification("default")
    const ctor = window.Notification as unknown as FakeNotificationCtor
    ctor.requestPermission = vi.fn(async () => {
      throw new Error("legacy callback API")
    })

    await expect(requestNotificationPermission()).resolves.toBe("default")
  })
})

describe("deliverSystemNotification", () => {
  it("posts through the LOCAL shell transport, never the remote one", async () => {
    // Regression: this used `getTransport()`, which in a remote-desktop window
    // is the remote HTTP transport — and `send_notification` is a
    // `tauri-runtime`-only command the `codeg-server` binary never registers.
    // Every notification in those windows failed on the far end and was
    // swallowed by the caller's `.catch()`.
    await deliverSystemNotification("t", "b")

    expect(shellCall).toHaveBeenCalledWith("send_notification", {
      title: "t",
      body: "b",
    })
    expect(remoteCall).not.toHaveBeenCalled()
  })

  it("propagates a backend failure instead of swallowing it", async () => {
    shellCall.mockRejectedValueOnce(new Error("could not deliver"))
    await expect(deliverSystemNotification("t", "b")).rejects.toThrow(
      "could not deliver"
    )
  })

  it("constructs a browser notification once permission is granted", async () => {
    desktop.mockReturnValue(false)
    const { constructed } = installNotification("granted")

    await deliverSystemNotification("t", "b")

    expect(constructed).toEqual([["t", { body: "b" }]])
  })

  it("refuses, rather than prompting, when the browser has not granted", async () => {
    // A prompt raised from the event path cannot succeed — the page is
    // backgrounded and carries no user activation. Requesting belongs to the
    // Settings button and nowhere else.
    desktop.mockReturnValue(false)
    const { constructed } = installNotification("default")
    const ctor = window.Notification as unknown as FakeNotificationCtor

    await expect(deliverSystemNotification("t", "b")).rejects.toThrow(
      /permission/i
    )
    expect(ctor.requestPermission).not.toHaveBeenCalled()
    expect(constructed).toEqual([])
  })

  it("fails loudly with no Notification API at all", async () => {
    desktop.mockReturnValue(false)
    await expect(deliverSystemNotification("t", "b")).rejects.toThrow(
      /not available/i
    )
  })
})

describe("getNotificationIdentity", () => {
  it("reads the delivering identity over the LOCAL shell transport", async () => {
    // Same reasoning as delivery: in a remote-desktop window `getTransport()`
    // points at a host that never registers this command, and the identity we
    // want to report is the one on the screen in front of the user.
    shellCall.mockResolvedValueOnce({
      bundleId: "app.codeg",
      requestedBundleId: "app.codeg",
      degraded: false,
    })

    await expect(getNotificationIdentity()).resolves.toEqual({
      bundleId: "app.codeg",
      requestedBundleId: "app.codeg",
      degraded: false,
    })
    expect(shellCall).toHaveBeenCalledWith("notification_identity")
    expect(remoteCall).not.toHaveBeenCalled()
  })

  it("reports a degraded identity verbatim", async () => {
    // The case this whole surface exists for: notifications posted under an
    // app the user never configured, while codeg's own switches govern
    // nothing.
    shellCall.mockResolvedValueOnce({
      bundleId: "com.apple.Terminal",
      requestedBundleId: "app.codeg",
      degraded: true,
    })

    await expect(getNotificationIdentity()).resolves.toMatchObject({
      bundleId: "com.apple.Terminal",
      degraded: true,
    })
  })

  it("has nothing to report in a browser", async () => {
    desktop.mockReturnValue(false)
    await expect(getNotificationIdentity()).resolves.toBeNull()
    expect(shellCall).not.toHaveBeenCalled()
  })

  it("passes through a desktop that declines to name an identity", async () => {
    // Windows and Linux: the backend answers `null` rather than claiming an
    // identity it cannot actually verify.
    shellCall.mockResolvedValueOnce(null)
    await expect(getNotificationIdentity()).resolves.toBeNull()
  })
})

describe("openSystemNotificationSettings", () => {
  it("calls the local command on desktop", async () => {
    await openSystemNotificationSettings()
    expect(shellCall).toHaveBeenCalledWith("open_system_notification_settings")
  })

  it("refuses in a browser, where no page may open the permission UI", async () => {
    desktop.mockReturnValue(false)
    await expect(openSystemNotificationSettings()).rejects.toThrow(/desktop/i)
    expect(shellCall).not.toHaveBeenCalled()
  })
})
