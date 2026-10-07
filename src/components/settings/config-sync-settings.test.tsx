import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Flipped per-test. The panel is runtime-agnostic now, so the only thing
// `desktop: false` can still catch here is a re-introduced `return null` gate —
// which is exactly what the availability tests below are for. The runtime
// branch itself lives in `@/lib/config-sync` (mocked in this file) and is
// pinned by `src/lib/config-sync.test.ts`.
const env = vi.hoisted(() => ({
  desktop: true,
  remoteId: null as string | null,
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: () => env.desktop,
  isLocalDesktop: () => env.desktop,
  openUrl: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: vi.fn(), subscribe: vi.fn() }),
  isDesktop: () => env.desktop,
  isRemoteDesktopMode: () => env.remoteId !== null,
  getActiveRemoteConnectionId: () => env.remoteId,
}))

// Captured so a test can push a background-sync status frame.
let statusHandler: ((e: unknown) => void) | null = null

vi.mock("@/lib/config-sync", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/config-sync")>(
      "@/lib/config-sync"
    )
  return {
    ...actual,
    getConfigSyncSettings: vi.fn(),
    getConfigSyncState: vi.fn(),
    updateConfigSyncSettings: vi.fn(),
    testConfigSyncConnection: vi.fn(),
    uploadConfigNow: vi.fn(),
    peekRemoteConfig: vi.fn(),
    downloadAndApplyConfig: vi.fn(),
    exportConfigToFile: vi.fn(),
    pickConfigFileToImport: vi.fn(),
    importPickedConfig: vi.fn(),
    listConfigRollbacks: vi.fn(),
    applyConfigRollback: vi.fn(),
    listenConfigSyncStatus: vi.fn(async (handler: (e: unknown) => void) => {
      statusHandler = handler
      return () => {}
    }),
  }
})

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
    message: vi.fn(),
  },
}))

import { ConfigSyncSettings } from "./config-sync-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  applyConfigRollback,
  downloadAndApplyConfig,
  getConfigSyncSettings,
  getConfigSyncState,
  importPickedConfig,
  listConfigRollbacks,
  peekRemoteConfig,
  pickConfigFileToImport,
  updateConfigSyncSettings,
} from "@/lib/config-sync"

const t = enMessages.ConfigSyncSettings

const SAVED = {
  enabled: true,
  serverUrl: "https://dav.example.com/dav/",
  username: "alice",
  hasPassword: true,
  encrypt: false,
  hasPassphrase: false,
  remoteDir: "codeg",
  profile: "default",
  autoSync: true,
  intervalMinutes: 5,
}

/** The shape `pickConfigFileToImport` returns on a local desktop. */
function pickedPath(counts: Record<string, number> = { modelProviders: 3 }) {
  return {
    source: {
      kind: "path" as const,
      path: "/tmp/config.json",
      label: "/tmp/config.json",
    },
    preview: { manifest: manifest(), counts },
  }
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    encryption: "none",
    createdAt: "2026-06-06T10:00:00Z",
    appVersion: "0.30.0",
    sourceDevice: "work-laptop",
    config: { size: 2048, sha256: "abc" },
    counts: { modelProviders: 3, preferences: 7 },
    ...overrides,
  }
}

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ConfigSyncSettings />
    </NextIntlClientProvider>
  )
}

/** Render and wait until the saved settings have populated the form. */
async function renderLoaded() {
  const view = renderPanel()
  await screen.findByRole("button", { name: t.saveButton })
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  statusHandler = null
  env.desktop = true
  env.remoteId = null
  vi.mocked(getConfigSyncSettings).mockResolvedValue({ ...SAVED })
  vi.mocked(getConfigSyncState).mockResolvedValue({
    lastUploadedSha256: null,
    lastUploadedTarget: null,
    lastSyncAt: null,
    lastError: null,
  })
  vi.mocked(updateConfigSyncSettings).mockResolvedValue({ ...SAVED })
  vi.mocked(listConfigRollbacks).mockResolvedValue([])
})

describe("ConfigSyncSettings — availability", () => {
  /// Regression: the panel used to `return null` for anything but a local
  /// desktop window, because the commands were registered on the Tauri
  /// runtime only. They exist on the HTTP API now, and a browser pointed at a
  /// codeg-server has exactly the same configuration worth syncing.
  it("renders in a browser, where the commands now exist too", async () => {
    env.desktop = false
    renderPanel()
    await screen.findByRole("button", { name: t.saveButton })
    expect(getConfigSyncSettings).toHaveBeenCalled()
  })

  it("renders for a remote-desktop window", async () => {
    env.remoteId = "remote-1"
    renderPanel()
    await screen.findByRole("button", { name: t.saveButton })
  })

  it("shows the file actions even before WebDAV is set up", async () => {
    vi.mocked(getConfigSyncSettings).mockResolvedValue({
      ...SAVED,
      enabled: false,
    })
    renderPanel()
    await screen.findByRole("button", { name: t.exportButton })
    expect(
      screen.queryByRole("button", { name: t.uploadButton })
    ).not.toBeInTheDocument()
  })
})

describe("ConfigSyncSettings — credentials", () => {
  it("sends a null password when the field is untouched, keeping the stored one", async () => {
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: t.saveButton }))
    await waitFor(() => expect(updateConfigSyncSettings).toHaveBeenCalled())
    expect(vi.mocked(updateConfigSyncSettings).mock.calls[0][0]).toMatchObject({
      username: "alice",
      password: null,
    })
  })

  it("sends a typed password and then clears the field", async () => {
    const { container } = await renderLoaded()
    const password = container.querySelector(
      "#config-sync-password"
    ) as HTMLInputElement
    fireEvent.change(password, { target: { value: "s3cret" } })
    fireEvent.click(screen.getByRole("button", { name: t.saveButton }))
    await waitFor(() => expect(updateConfigSyncSettings).toHaveBeenCalled())
    expect(vi.mocked(updateConfigSyncSettings).mock.calls[0][0]).toMatchObject({
      password: "s3cret",
    })
    // Cleared so a second save does not resend a value the user cannot see.
    await waitFor(() => expect(password.value).toBe(""))
  })

  /// Regression: every control including Save lives inside the block the
  /// switch hides, so a toggle that only moved local state could be turned on
  /// but never off — the uploader kept running against settings the panel
  /// showed as disabled.
  it("persists the master switch on click, so sync can be turned off", async () => {
    vi.mocked(updateConfigSyncSettings).mockResolvedValue({
      ...SAVED,
      enabled: false,
    })
    await renderLoaded()
    fireEvent.click(screen.getByRole("switch", { name: t.webdavTitle }))
    await waitFor(() => expect(updateConfigSyncSettings).toHaveBeenCalled())
    expect(vi.mocked(updateConfigSyncSettings).mock.calls[0][0]).toMatchObject({
      enabled: false,
    })
    // The credential form (and with it the Save button) is gone; the change
    // must already be stored.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: t.saveButton })
      ).not.toBeInTheDocument()
    )
  })

  /// The backend refuses to send a saved password to an account it was not
  /// typed for, so the field must stop offering to reuse it.
  it("asks for the password again once the account is edited", async () => {
    const { container } = await renderLoaded()
    const password = container.querySelector(
      "#config-sync-password"
    ) as HTMLInputElement
    expect(password.placeholder).toBe(t.passwordKeep)

    fireEvent.change(container.querySelector("#config-sync-url")!, {
      target: { value: "https://dav.other.example/dav/" },
    })
    await waitFor(() =>
      expect(password.placeholder).toBe(t.passwordPlaceholder)
    )
  })

  it("disables the remote actions until a server and user are filled in", async () => {
    vi.mocked(getConfigSyncSettings).mockResolvedValue({
      ...SAVED,
      serverUrl: "",
      username: "",
      hasPassword: false,
    })
    await renderLoaded()
    expect(screen.getByRole("button", { name: t.saveButton })).toBeDisabled()
    expect(screen.getByRole("button", { name: t.uploadButton })).toBeDisabled()
  })
})

describe("ConfigSyncSettings — restore from remote", () => {
  it("never downloads without a confirmation naming the source snapshot", async () => {
    vi.mocked(peekRemoteConfig).mockResolvedValue(manifest())
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: t.restoreButton }))
    await screen.findByText(t.restoreConfirmTitle)
    expect(downloadAndApplyConfig).not.toHaveBeenCalled()
    expect(screen.getByText(/work-laptop/)).toBeInTheDocument()

    vi.mocked(downloadAndApplyConfig).mockResolvedValue({
      manifest: manifest(),
      applied: { domains: { modelProviders: 3 }, total: 3 },
      rollbackPath: null,
    })
    fireEvent.click(
      screen.getByRole("button", { name: t.restoreConfirmAction })
    )
    await waitFor(() => expect(downloadAndApplyConfig).toHaveBeenCalled())
  })

  it("reports an empty remote instead of opening the dialog", async () => {
    vi.mocked(peekRemoteConfig).mockResolvedValue(null)
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: t.restoreButton }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(t.noRemoteSnapshot)
    )
    expect(screen.queryByText(t.restoreConfirmTitle)).not.toBeInTheDocument()
  })
})

describe("ConfigSyncSettings — file import", () => {
  it("previews the file and applies it only after confirmation", async () => {
    const picked = pickedPath()
    vi.mocked(pickConfigFileToImport).mockResolvedValue(picked)
    vi.mocked(importPickedConfig).mockResolvedValue({
      applied: { domains: { modelProviders: 3 }, total: 3 },
      rollbackPath: null,
    })
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: t.importButton }))
    await screen.findByText(t.importConfirmTitle)
    expect(importPickedConfig).not.toHaveBeenCalled()

    // Regression: the confirm button used to be gated on a `preview.importable`
    // field the backend never sends, so it was `undefined` on every real file
    // and importing was impossible.
    const confirm = screen.getByRole("button", {
      name: t.importConfirmAction,
    })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(importPickedConfig).toHaveBeenCalledWith(picked.source)
    )
  })

  /// The panel is deliberately blind to which runtime produced the pick: it
  /// hands the `source` back exactly as given. Which source a real browser
  /// produces is decided inside `@/lib/config-sync` — mocked here — and is
  /// pinned by `config-sync.test.ts` instead, where the branch actually lives.
  it("passes a by-content source straight back, untouched", async () => {
    const picked = {
      source: {
        kind: "content" as const,
        content: '{"schemaVersion":1,"domains":{}}',
        label: "codeg-config.json",
      },
      preview: { manifest: manifest(), counts: { quickMessages: 1 } },
    }
    vi.mocked(pickConfigFileToImport).mockResolvedValue(picked)
    vi.mocked(importPickedConfig).mockResolvedValue({
      applied: { domains: { quickMessages: 1 }, total: 1 },
      rollbackPath: null,
    })
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: t.importButton }))
    await screen.findByText(t.importConfirmTitle)
    fireEvent.click(screen.getByRole("button", { name: t.importConfirmAction }))
    await waitFor(() =>
      expect(importPickedConfig).toHaveBeenCalledWith(picked.source)
    )
  })

  /// `peek` recounts the payload; the file's own manifest is just a claim.
  it("counts what will be applied, not what the file says about itself", async () => {
    vi.mocked(pickConfigFileToImport).mockResolvedValue({
      ...pickedPath({ modelProviders: 2 }),
      preview: {
        manifest: manifest({ counts: { modelProviders: 99 } }),
        counts: { modelProviders: 2 },
      },
    })
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: t.importButton }))
    await screen.findByText(t.importConfirmTitle)
    expect(screen.getByText("2 model providers")).toBeInTheDocument()
    expect(screen.queryByText("99 model providers")).not.toBeInTheDocument()
  })

  it("reports a file the backend refused instead of opening a dialog", async () => {
    vi.mocked(pickConfigFileToImport).mockRejectedValue(
      new Error("Not a codeg config snapshot")
    )
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: t.importButton }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.queryByText(t.importConfirmTitle)).not.toBeInTheDocument()
  })

  it("stays quiet when the file dialog is dismissed", async () => {
    vi.mocked(pickConfigFileToImport).mockResolvedValue(null)
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: t.importButton }))
    await waitFor(() => expect(pickConfigFileToImport).toHaveBeenCalled())
    expect(screen.queryByText(t.importConfirmTitle)).not.toBeInTheDocument()
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe("ConfigSyncSettings — encryption", () => {
  it("asks for a passphrase only once encryption is switched on", async () => {
    const { container } = await renderLoaded()
    expect(
      container.querySelector("#config-sync-passphrase")
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("switch", { name: t.encryptLabel }))
    await waitFor(() =>
      expect(
        container.querySelector("#config-sync-passphrase")
      ).toBeInTheDocument()
    )
    // And the warning stops claiming the upload is plaintext.
    expect(screen.queryByText(t.plaintextWarning)).not.toBeInTheDocument()
    expect(screen.getByText(t.encryptedNotice)).toBeInTheDocument()
  })

  it("sends the typed passphrase and then clears the field", async () => {
    vi.mocked(getConfigSyncSettings).mockResolvedValue({
      ...SAVED,
      encrypt: true,
      hasPassphrase: false,
    })
    vi.mocked(updateConfigSyncSettings).mockResolvedValue({
      ...SAVED,
      encrypt: true,
      hasPassphrase: true,
    })
    const { container } = await renderLoaded()
    const passphrase = container.querySelector(
      "#config-sync-passphrase"
    ) as HTMLInputElement
    expect(passphrase.placeholder).toBe(t.passphrasePlaceholder)

    fireEvent.change(passphrase, { target: { value: "correct horse" } })
    fireEvent.click(screen.getByRole("button", { name: t.saveButton }))
    await waitFor(() => expect(updateConfigSyncSettings).toHaveBeenCalled())
    expect(vi.mocked(updateConfigSyncSettings).mock.calls[0][0]).toMatchObject({
      encrypt: true,
      passphrase: "correct horse",
    })
    await waitFor(() => expect(passphrase.value).toBe(""))
    // Stored now, so an untouched field means "keep it".
    await waitFor(() => expect(passphrase.placeholder).toBe(t.passphraseKeep))
  })

  /// A passphrase typed and then withdrawn — the switch goes back off before
  /// Save — must not be stored. The field is hidden at that point, so state
  /// left behind there would ride along on a later Save about something else
  /// entirely, and `hasPassphrase` would then claim a protection the user
  /// never confirmed.
  it("drops a typed passphrase when encryption is switched back off", async () => {
    const { container } = await renderLoaded()
    fireEvent.click(screen.getByRole("switch", { name: t.encryptLabel }))
    const passphrase = (await waitFor(() => {
      const field = container.querySelector("#config-sync-passphrase")
      expect(field).toBeInTheDocument()
      return field
    })) as HTMLInputElement
    fireEvent.change(passphrase, { target: { value: "withdrawn" } })

    fireEvent.click(screen.getByRole("switch", { name: t.encryptLabel }))
    await waitFor(() =>
      expect(
        container.querySelector("#config-sync-passphrase")
      ).not.toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole("button", { name: t.saveButton }))
    await waitFor(() => expect(updateConfigSyncSettings).toHaveBeenCalled())
    expect(vi.mocked(updateConfigSyncSettings).mock.calls[0][0]).toMatchObject({
      encrypt: false,
      // `null` is "unchanged", which leaves whatever is already stored alone —
      // that copy is what still decrypts the snapshot on the remote.
      passphrase: null,
    })
  })
})

describe("ConfigSyncSettings — a file dialog does not gate the panel", () => {
  /// A dialog is open for as long as the user is reading their filesystem, and
  /// on an engine with no `cancel` event a dismissed one never reports back at
  /// all (see `pickLocalFile`). Disabling the section for the duration would
  /// therefore mean a Settings page that can be bricked by pressing Import and
  /// pressing Escape. Nothing is written until the confirmation dialog, so
  /// there is nothing here worth locking.
  it("leaves every other action usable while the picker is open", async () => {
    // Never resolves — exactly the dismissed-picker case.
    vi.mocked(pickConfigFileToImport).mockReturnValue(new Promise(() => {}))
    await renderLoaded()

    fireEvent.click(screen.getByRole("button", { name: t.importButton }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: t.saveButton })).toBeEnabled()
    )
    expect(screen.getByRole("button", { name: t.exportButton })).toBeEnabled()
    expect(screen.getByRole("button", { name: t.testButton })).toBeEnabled()
    expect(screen.getByRole("switch", { name: t.webdavTitle })).toBeEnabled()
  })
})

describe("ConfigSyncSettings — the master switch is not a Save button", () => {
  /// It has to write something (see the handler's comment), but a credential
  /// typed into a field and never submitted is not part of that something.
  /// Otherwise a user who types a password, thinks better of it and turns sync
  /// OFF has just stored the password instead of discarding it.
  it("does not submit a typed password or passphrase", async () => {
    const { container } = await renderLoaded()
    const password = container.querySelector(
      "#config-sync-password"
    ) as HTMLInputElement
    fireEvent.change(password, { target: { value: "half-typed" } })

    fireEvent.click(screen.getByRole("switch", { name: t.webdavTitle }))
    await waitFor(() => expect(updateConfigSyncSettings).toHaveBeenCalled())
    const sent = vi.mocked(updateConfigSyncSettings).mock.calls[0][0]
    expect(sent).toMatchObject({ enabled: false, password: null })
    expect(JSON.stringify(sent)).not.toContain("half-typed")

    // And the text survives, so the explicit Save the user may still want is
    // one click away rather than retyped.
    await waitFor(() => expect(password.value).toBe("half-typed"))
  })
})

describe("ConfigSyncSettings — rollback snapshots", () => {
  const SNAPSHOT = {
    id: "config-20260606T120000000",
    createdAt: "2026-06-06T12:00:00Z",
    size: 4096,
    counts: { modelProviders: 2 },
  }

  const OLDER = {
    id: "config-20260601T090000000",
    createdAt: "2026-06-01T09:00:00Z",
    size: 2048,
    counts: { quickMessages: 5 },
  }

  /**
   * The restore points live behind the entry on the file-actions row — a list
   * of up to ten of them inline pushed everything else off the panel. Opens it
   * and hands back one undo button per listed snapshot, in list order.
   */
  async function openRollbackList() {
    fireEvent.click(
      await screen.findByRole("button", { name: new RegExp(t.rollbackTitle) })
    )
    return screen.findAllByRole("button", { name: t.rollbackAction })
  }

  it("hides the entry when there is nothing to undo", async () => {
    await renderLoaded()
    expect(screen.queryByText(t.rollbackTitle)).not.toBeInTheDocument()
  })

  /// Regression: every import and restore wrote a pre-apply snapshot and
  /// returned its path, but nothing listed or applied one — the safety net
  /// existed on disk and was unreachable from the product.
  it("lists saved configurations and applies the one that was picked", async () => {
    vi.mocked(listConfigRollbacks).mockResolvedValue([SNAPSHOT, OLDER])
    vi.mocked(applyConfigRollback).mockResolvedValue({
      applied: { domains: { quickMessages: 5 }, total: 5 },
      rollbackPath: null,
    })
    await renderLoaded()
    const [, undoOlder] = await openRollbackList()
    expect(screen.getByText("2 model providers")).toBeInTheDocument()
    expect(screen.getByText("5 quick messages")).toBeInTheDocument()

    // The second row, so the id travelling to the backend proves the rows are
    // wired to their own snapshot rather than to whichever one is first.
    fireEvent.click(undoOlder)
    await screen.findByText(t.rollbackConfirmTitle)
    expect(applyConfigRollback).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole("button", { name: t.rollbackConfirmAction })
    )
    await waitFor(() =>
      expect(applyConfigRollback).toHaveBeenCalledWith(OLDER.id)
    )
  })

  /// The undo writes its own rollback point, so the list has to be re-read
  /// rather than left showing the state from before the click.
  it("re-reads the list after an undo", async () => {
    vi.mocked(listConfigRollbacks).mockResolvedValue([SNAPSHOT])
    vi.mocked(applyConfigRollback).mockResolvedValue({
      applied: { domains: {}, total: 0 },
      rollbackPath: null,
    })
    await renderLoaded()
    const [undo] = await openRollbackList()
    expect(listConfigRollbacks).toHaveBeenCalledTimes(1)

    fireEvent.click(undo)
    await screen.findByText(t.rollbackConfirmTitle)
    fireEvent.click(
      screen.getByRole("button", { name: t.rollbackConfirmAction })
    )
    await waitFor(() => expect(listConfigRollbacks).toHaveBeenCalledTimes(2))
  })

  /// A snapshot pruned since the list was drawn must leave the list rather
  /// than sit there offering a button that fails every time.
  it("drops a snapshot the backend can no longer find", async () => {
    vi.mocked(listConfigRollbacks).mockResolvedValueOnce([SNAPSHOT])
    vi.mocked(applyConfigRollback).mockRejectedValue(
      new Error("That rollback snapshot is no longer on this machine")
    )
    vi.mocked(listConfigRollbacks).mockResolvedValue([])
    await renderLoaded()
    const [undo] = await openRollbackList()

    fireEvent.click(undo)
    await screen.findByText(t.rollbackConfirmTitle)
    fireEvent.click(
      screen.getByRole("button", { name: t.rollbackConfirmAction })
    )
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByText(t.rollbackTitle)).not.toBeInTheDocument()
    )
  })
})

describe("ConfigSyncSettings — background status", () => {
  it("reflects an upload performed by the periodic loop", async () => {
    await renderLoaded()
    expect(screen.getByText(t.neverSynced)).toBeInTheDocument()
    act(() => {
      statusHandler?.({ lastSyncAt: "2026-06-06T12:00:00Z", lastError: null })
    })
    await waitFor(() =>
      expect(screen.queryByText(t.neverSynced)).not.toBeInTheDocument()
    )
  })

  it("surfaces the last background failure", async () => {
    await renderLoaded()
    act(() => {
      statusHandler?.({ lastSyncAt: null, lastError: "connection refused" })
    })
    await screen.findByText(/connection refused/)
  })
})
