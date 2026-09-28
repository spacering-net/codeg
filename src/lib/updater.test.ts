import { beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.fn()
// Flipped per-test so the desktop (Tauri plugin) branch of the updater can be
// exercised alongside the server one.
let desktop = false

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
  isDesktop: () => desktop,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
}))

const tauriGetVersion = vi.fn(async () => "0.21.8")
const tauriCheck = vi.fn()
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => tauriGetVersion(),
}))
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (options?: { timeout?: number }) => tauriCheck(options),
}))

import {
  appUpdateErrorMessageKey,
  checkAppUpdateInfo,
  confirmRollbackVersion,
  describeAppUpdateError,
  getCurrentAppVersion,
  getRunningServerVersion,
  getServerUpdateStatus,
  normalizeAppUpdateError,
  readServerVersionStrict,
  waitForServerHealthy,
} from "@/lib/updater"

describe("readServerVersionStrict", () => {
  beforeEach(() => {
    call.mockReset()
  })

  it("returns the version when /health reports one", async () => {
    call.mockResolvedValueOnce({ version: "0.14.12" })
    await expect(readServerVersionStrict()).resolves.toBe("0.14.12")
  })

  it("resolves null when /health responds without a version (older server)", async () => {
    call.mockResolvedValueOnce({})
    await expect(readServerVersionStrict()).resolves.toBeNull()
  })

  it("rejects (does not swallow) when the server is unreachable", async () => {
    call.mockRejectedValueOnce(new Error("down"))
    await expect(readServerVersionStrict()).rejects.toThrow("down")
  })
})

describe("getRunningServerVersion", () => {
  beforeEach(() => {
    call.mockReset()
  })

  it("returns the version on success", async () => {
    call.mockResolvedValueOnce({ version: "1.2.3" })
    await expect(getRunningServerVersion()).resolves.toBe("1.2.3")
  })

  it("swallows a transport failure as null", async () => {
    call.mockRejectedValueOnce(new Error("down"))
    await expect(getRunningServerVersion()).resolves.toBeNull()
  })
})

describe("getServerUpdateStatus", () => {
  beforeEach(() => {
    call.mockReset()
  })

  it("reads local self-update status from app_update_status (no manifest fetch)", async () => {
    // The rollback affordance must survive an unreachable update source, so it
    // is driven by this local endpoint rather than the manifest-dependent
    // check. A failing check_app_update is irrelevant here — this never calls it.
    call.mockResolvedValueOnce({
      currentVersion: "0.14.11",
      selfUpdateSupported: true,
      capability: "supervised",
      runtime: "docker",
      restartDelayMs: 2000,
      rollbackAvailable: true,
    })

    const status = await getServerUpdateStatus()

    expect(call).toHaveBeenCalledWith("app_update_status")
    expect(status).toEqual({
      currentVersion: "0.14.11",
      selfUpdateSupported: true,
      capability: "supervised",
      runtime: "docker",
      restartDelayMs: 2000,
      rollbackAvailable: true,
    })
  })
})

describe("getCurrentAppVersion (server mode)", () => {
  beforeEach(() => {
    call.mockReset()
  })

  it("reads the version from app_update_status, never check_app_update", async () => {
    // Regression: the settings page loads the version alongside unrelated local
    // state, so the version read must not depend on the (network) update check.
    call.mockResolvedValueOnce({
      currentVersion: "0.14.11",
      selfUpdateSupported: true,
      capability: "reexec",
      runtime: "standalone",
      restartDelayMs: 2000,
      rollbackAvailable: false,
    })

    const version = await getCurrentAppVersion()

    expect(version).toBe("0.14.11")
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith("app_update_status")
    expect(call).not.toHaveBeenCalledWith("check_app_update")
  })

  it("falls open to /health when app_update_status is unavailable, never check_app_update", async () => {
    // A newer desktop can talk to an older server lacking /app_update_status;
    // the version read must not throw (it loads alongside unrelated settings)
    // and must never reach the manifest-dependent check.
    call.mockRejectedValueOnce(new Error("not implemented")) // app_update_status
    call.mockResolvedValueOnce({ version: "0.14.11" }) // /health

    const version = await getCurrentAppVersion()

    expect(version).toBe("0.14.11")
    expect(call).toHaveBeenCalledWith("app_update_status")
    expect(call).toHaveBeenCalledWith("health", {}, { timeoutMs: 4000 })
    expect(call).not.toHaveBeenCalledWith("check_app_update")
  })

  it("resolves to 'unknown' when both the status route and /health fail", async () => {
    call.mockRejectedValueOnce(new Error("not implemented")) // app_update_status
    call.mockRejectedValueOnce(new Error("down")) // /health

    await expect(getCurrentAppVersion()).resolves.toBe("unknown")
    expect(call).not.toHaveBeenCalledWith("check_app_update")
  })
})

describe("confirmRollbackVersion", () => {
  beforeEach(() => {
    call.mockReset()
  })

  it("counts a healthy-but-versionless target as rolled-back (not a timeout)", async () => {
    // The rollback target can be an older build whose /health omits the
    // version. The server is up and the previous bundle is restored, so this
    // must NOT be reported as a failed/timed-out restart.
    call.mockResolvedValue({}) // /health answers, but with no version

    await expect(confirmRollbackVersion("0.15.0")).resolves.toBe("rolled-back")
    expect(call).toHaveBeenCalledWith("health", {}, { timeoutMs: 4000 })
  })

  it("counts a moved version as rolled-back", async () => {
    call.mockResolvedValue({ version: "0.14.0" })
    await expect(confirmRollbackVersion("0.15.0")).resolves.toBe("rolled-back")
  })

  it("reports unchanged when the version stays on the pre-rollback value", async () => {
    call.mockResolvedValue({ version: "0.15.0" })
    await expect(
      confirmRollbackVersion("0.15.0", { attempts: 2, intervalMs: 1 })
    ).resolves.toBe("unchanged")
  })

  it("reports unreachable when /health never answers", async () => {
    call.mockRejectedValue(new Error("down"))
    await expect(
      confirmRollbackVersion("0.15.0", { attempts: 2, intervalMs: 1 })
    ).resolves.toBe("unreachable")
  })
})

describe("waitForServerHealthy", () => {
  beforeEach(() => {
    call.mockReset()
  })

  it("resolves true as soon as /health answers", async () => {
    // First poll fails (server still restarting), second succeeds.
    call.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce({})

    const healthy = await waitForServerHealthy({
      timeoutMs: 5_000,
      intervalMs: 5,
    })

    expect(healthy).toBe(true)
    expect(call).toHaveBeenCalledWith("health", {}, { timeoutMs: 4000 })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("resolves false when the server never comes back before the deadline", async () => {
    call.mockRejectedValue(new Error("down"))

    const healthy = await waitForServerHealthy({
      timeoutMs: 30,
      intervalMs: 5,
    })

    expect(healthy).toBe(false)
    expect(call.mock.calls.length).toBeGreaterThan(0)
  })
})

describe("checkAppUpdateInfo", () => {
  beforeEach(() => {
    call.mockReset()
    tauriCheck.mockReset()
    tauriGetVersion.mockClear()
    desktop = false
  })

  it("passes the server's answer through unchanged", async () => {
    call.mockResolvedValueOnce({
      currentVersion: "0.21.7",
      update: { version: "0.21.8", body: "## Notes", date: "2026-07-20" },
      selfUpdateSupported: true,
      capability: "supervised",
      runtime: "standalone",
      restartDelayMs: 2000,
      rollbackAvailable: true,
      liveProgress: true,
    })

    const result = await checkAppUpdateInfo()
    expect(call).toHaveBeenCalledWith("check_app_update")
    expect(result.currentVersion).toBe("0.21.7")
    expect(result.update).toEqual({
      version: "0.21.8",
      body: "## Notes",
      date: "2026-07-20",
    })
    expect(result.liveProgress).toBe(true)
  })

  it("copies the desktop release fields and releases the updater handle", async () => {
    // The Tauri `Update` is a resource handle. Since the download is driven in
    // Rust (which re-checks on its own), holding it would leak an entry in the
    // resource table on every periodic check.
    desktop = true
    const close = vi.fn(async () => {})
    tauriCheck.mockResolvedValueOnce({
      version: "0.21.9",
      body: "fixes",
      date: "2026-07-24",
      close,
    })

    const result = await checkAppUpdateInfo()
    expect(result).toEqual({
      currentVersion: "0.21.8",
      update: { version: "0.21.9", body: "fixes", date: "2026-07-24" },
    })
    expect(close).toHaveBeenCalledTimes(1)
    // Never reaches the server endpoint in desktop mode.
    expect(call).not.toHaveBeenCalled()
  })

  it("reports no update (and closes nothing) when desktop is up to date", async () => {
    desktop = true
    tauriCheck.mockResolvedValueOnce(null)

    const result = await checkAppUpdateInfo()
    expect(result).toEqual({ currentVersion: "0.21.8", update: null })
  })

  it("still releases the handle when reading its fields throws", async () => {
    desktop = true
    const close = vi.fn(async () => {})
    tauriCheck.mockResolvedValueOnce({
      get version(): string {
        throw new Error("resource gone")
      },
      close,
    })

    await expect(checkAppUpdateInfo()).rejects.toThrow("resource gone")
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("bounds the desktop manifest fetch so a black-holed network can't hang it", async () => {
    // tauri-plugin-updater applies no timeout of its own; without an explicit
    // one a dropped-packet network leaves check() pending forever, and with it
    // the provider's in-flight guard — killing checks for the whole session.
    desktop = true
    tauriCheck.mockResolvedValueOnce(null)

    await checkAppUpdateInfo()

    const opts = tauriCheck.mock.calls[0]?.[0] as { timeout?: number }
    expect(opts?.timeout).toBeGreaterThan(0)
  })

  it("propagates a failed check so the caller can classify it", async () => {
    desktop = true
    tauriCheck.mockRejectedValueOnce(new Error("error sending request for url"))

    await expect(checkAppUpdateInfo()).rejects.toThrow()
  })
})

describe("appUpdateErrorMessageKey", () => {
  it("identifies an unwritable server update target as a permission error", () => {
    const { kind } = normalizeAppUpdateError(
      "Update target is not writable: /usr/local/bin"
    )
    expect(kind).toBe("permission_denied")
    expect(appUpdateErrorMessageKey(kind, "install")).toBe(
      "updateErrors.permissionDenied"
    )
  })

  it("keeps permission failures distinct from network and install failures", () => {
    expect(
      normalizeAppUpdateError("Update target is not writable: /mnt/network/bin")
        .kind
    ).toBe("permission_denied")
    expect(
      normalizeAppUpdateError("Download failed: permission denied").kind
    ).toBe("download_failed")
    expect(
      normalizeAppUpdateError("Permission denied (os error 13)").kind
    ).toBe("install_failed")
    expect(normalizeAppUpdateError("Installer failed").kind).toBe(
      "install_failed"
    )
  })

  it("maps each classified kind to its own message", () => {
    const kinds = [
      "source_unreachable",
      "network",
      "download_failed",
      "permission_denied",
      "install_failed",
    ] as const
    const keys = kinds.map((k) => appUpdateErrorMessageKey(k, "check"))
    expect(new Set(keys).size).toBe(kinds.length)
  })

  it("blames the install for an unclassifiable install failure, not the check", () => {
    expect(appUpdateErrorMessageKey("unknown", "install")).toBe(
      "updateErrors.installFailed"
    )
    expect(appUpdateErrorMessageKey("unknown", "check")).toBe(
      "updateErrors.unknown"
    )
  })

  it("agrees with the classifier on a real network failure string", () => {
    const { kind } = normalizeAppUpdateError(
      new Error("error sending request for url")
    )
    expect(appUpdateErrorMessageKey(kind, "check")).toBe("updateErrors.network")
  })
})

describe("describeAppUpdateError", () => {
  const unwritable = (path: string) => ({
    code: "permission_denied",
    message: `Update target is not writable: ${path}`,
    detail: "Permission denied (os error 13)",
    i18n_key: "SystemSettings.updateErrors.permissionDenied",
    i18n_params: { path },
  })

  it("renders the server's explanation with the directory it names", () => {
    // A message the classifier can't place, so only `info` can produce this.
    const info = unwritable("/usr/local/bin")
    expect(describeAppUpdateError("Update failed", "install", info)).toEqual({
      key: "updateErrors.permissionDenied",
      values: { path: "/usr/local/bin" },
    })
  })

  it("tells a full disk apart from refused permission", () => {
    const info = {
      code: "io_error",
      message: "Update target is not writable: /usr/local/bin",
      detail: "No space left on device (os error 28)",
      i18n_key: "SystemSettings.updateErrors.targetWriteFailed",
      i18n_params: {
        path: "/usr/local/bin",
        reason: "No space left on device (os error 28)",
      },
    }
    expect(describeAppUpdateError(info.message, "install", info)).toEqual({
      key: "updateErrors.targetWriteFailed",
      values: {
        path: "/usr/local/bin",
        reason: "No space left on device (os error 28)",
      },
    })
  })

  it("reads the directory out of the message from a server without errorInfo", () => {
    // Older servers only send the string; the path keeps its own spaces.
    expect(
      describeAppUpdateError(
        "Update target is not writable: /opt/My Apps/codeg",
        "install"
      )
    ).toEqual({
      key: "updateErrors.permissionDenied",
      values: { path: "/opt/My Apps/codeg" },
    })
  })

  it("classifies the message when the explanation is unknown or incomplete", () => {
    const message = "Update target is not writable: /usr/local/bin"
    const fallback = {
      key: "updateErrors.permissionDenied",
      values: { path: "/usr/local/bin" },
    }
    for (const info of [
      { ...unwritable("/x"), i18n_key: "SystemSettings.updateErrors.later" },
      { ...unwritable("/x"), i18n_params: {} },
      // Off the wire, so it must not resolve to an Object.prototype member.
      { ...unwritable("/x"), i18n_key: "constructor" },
    ]) {
      expect(describeAppUpdateError(message, "install", info)).toEqual(fallback)
    }
  })

  it("classifies an unexplained failure by its message, as before", () => {
    // The structured error carries a detail the message doesn't; classifying
    // that instead would turn this download failure into a network one.
    const info = {
      code: "network_error",
      message: "Failed to download update package",
      detail: "error sending request for url (https://example.com)",
    }
    expect(describeAppUpdateError(info.message, "install", info)).toEqual({
      key: "updateErrors.downloadFailed",
      values: {},
    })
  })
})
