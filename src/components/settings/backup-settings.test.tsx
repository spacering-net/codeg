import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: vi.fn(), subscribe: vi.fn() }),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
  isLocalDesktop: () => false,
  openUrl: vi.fn(),
}))

// Captured so a test can push a live progress frame.
let progressHandler: ((p: unknown) => void) | null = null

vi.mock("@/lib/api", () => ({
  listenBackupProgress: vi.fn(async (handler: (p: unknown) => void) => {
    progressHandler = handler
    return () => {}
  }),
  listSafetySnapshots: vi.fn(async () => []),
  exportBackupDesktop: vi.fn(),
  exportBackupWeb: vi.fn(async () => ({
    url: "/api/backup_download/t",
    filename: "b.zip",
    degradedSqlite: [],
  })),
  prepareBackupSourceDesktop: vi.fn(),
  prepareBackupSourceWeb: vi.fn(),
  releaseBackupSource: vi.fn(async () => true),
  scanExternalConflicts: vi.fn(async () => []),
  backupActiveAgents: vi.fn(async () => []),
  cancelBackup: vi.fn(async () => true),
  discardPendingRestore: vi.fn(async () => true),
  rollbackToSnapshot: vi.fn(async () => undefined),
  stageRestoreDesktop: vi.fn(),
  stageRestoreWeb: vi.fn(),
  uploadBackupWeb: vi.fn(async () => "u1"),
}))

const restartApp = vi.fn()
const waitForServerHealthy = vi.fn(async () => true)
vi.mock("@/lib/updater", () => ({
  relaunchApp: vi.fn(),
  restartApp: () => restartApp(),
  waitForServerHealthy: () => waitForServerHealthy(),
}))

// The panels under test only exist inside the data & sync card, so that card
// is what gets rendered — minus its third panel, whose own API surface has
// nothing to do with backup and is pinned by `config-sync-settings.test.tsx`.
vi.mock("./config-sync-settings", () => ({
  ConfigSyncSettings: () => null,
}))

const toastError = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: (m: string) => toastError(m),
    message: vi.fn(),
  },
}))

import { DataSyncSettings } from "./data-sync-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  backupActiveAgents,
  cancelBackup,
  discardPendingRestore,
  exportBackupWeb,
  listSafetySnapshots,
  prepareBackupSourceWeb,
  rollbackToSnapshot,
  scanExternalConflicts,
  stageRestoreWeb,
  uploadBackupWeb,
} from "@/lib/api"

const t = enMessages.BackupSettings

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DataSyncSettings />
    </NextIntlClientProvider>
  )
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    kind: "codeg-backup",
    createdAt: "2026-06-06T00:00:00Z",
    appVersion: "0.30.0",
    latestMigration: "m1",
    runtime: "server",
    includesExternalTranscripts: false,
    includesSecrets: true,
    entries: [],
    ...overrides,
  }
}

/** Upload + prepare a backup and wait for the preview to render. */
async function selectBackup(preview: Record<string, unknown>) {
  vi.mocked(prepareBackupSourceWeb).mockResolvedValue({
    sourceId: "s1",
    preview,
  } as never)
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(["x"], "b.codeg.zip")
  Object.defineProperty(input, "files", { value: [file] })
  fireEvent.change(input)
  await waitFor(() => expect(uploadBackupWeb).toHaveBeenCalled())
}

/** The card opens on configuration sync, so every test selects its own panel. */
function activateTab(label: string) {
  const tab = screen.getByRole("tab", { name: new RegExp(label) })
  // Radix Tabs default to automatic activation on focus; the click alone is
  // not enough under jsdom.
  fireEvent.focus(tab)
  fireEvent.click(tab)
}

async function openBackupTab() {
  activateTab(t.tabs.backup)
  await screen.findByRole("button", { name: t.export.button })
}

async function openRestoreTab() {
  activateTab(t.tabs.restore)
  await screen.findByRole("button", { name: t.restore.selectFile })
}

beforeEach(() => {
  vi.clearAllMocks()
  progressHandler = null
  restartApp.mockResolvedValue(undefined)
  waitForServerHealthy.mockResolvedValue(true)
  vi.mocked(listSafetySnapshots).mockResolvedValue([])
  vi.mocked(backupActiveAgents).mockResolvedValue([])
  vi.mocked(scanExternalConflicts).mockResolvedValue([])
})

describe("DataSyncSettings — panel wiring", () => {
  // The panels are `forceMount`ed, so only their `hidden` attribute keeps the
  // ones that are off screen out of reach — and only a negative assertion can
  // tell a working strip from a tab wired to a panel that does not exist.
  it("opens on configuration sync, with the backup and restore panels out of reach", () => {
    renderSettings()
    expect(
      screen.getByRole("tab", { name: enMessages.ConfigSyncSettings.title })
    ).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("button", { name: t.export.button })).toBeNull()
    expect(
      screen.queryByRole("button", { name: t.restore.selectFile })
    ).toBeNull()
  })

  it("shows one panel at a time", async () => {
    renderSettings()
    await openBackupTab()
    expect(
      screen.queryByRole("button", { name: t.restore.selectFile })
    ).toBeNull()

    await openRestoreTab()
    expect(screen.queryByRole("button", { name: t.export.button })).toBeNull()
  })
})

describe("BackupSettings — export", () => {
  it("refuses to export when the passphrase confirmation does not match", async () => {
    renderSettings()
    await openBackupTab()
    const fields = screen.getAllByPlaceholderText(
      new RegExp(t.export.passphrasePlaceholder)
    )
    fireEvent.change(fields[0], { target: { value: "secret" } })
    const confirm = await screen.findByPlaceholderText(
      new RegExp(t.export.passphraseConfirm)
    )
    fireEvent.change(confirm, { target: { value: "typo" } })

    const button = screen.getByRole("button", { name: t.export.button })
    expect(button).toBeDisabled()
    expect(exportBackupWeb).not.toHaveBeenCalled()
  })

  it("surfaces a degraded session store instead of reporting a clean backup", async () => {
    vi.mocked(exportBackupWeb).mockResolvedValue({
      url: "/api/backup_download/t",
      filename: "b.zip",
      degradedSqlite: [
        {
          agent: "opencode",
          archivePath: "external/opencode/x.db",
          level: "bareFileOnly",
        },
      ],
    } as never)
    renderSettings()
    await openBackupTab()
    fireEvent.click(screen.getByRole("button", { name: t.export.button }))
    expect(
      await screen.findByText(new RegExp(t.export.degradedTitle))
    ).toBeInTheDocument()
    expect(screen.getByText(/opencode/)).toBeInTheDocument()
  })

  it("offers to cancel an export in flight", async () => {
    let resolveExport: (v: unknown) => void = () => {}
    vi.mocked(exportBackupWeb).mockReturnValue(
      new Promise((r) => {
        resolveExport = r
      }) as never
    )
    renderSettings()
    await openBackupTab()
    fireEvent.click(screen.getByRole("button", { name: t.export.button }))
    // The op id only exists once the backend emits its first frame.
    progressHandler?.({
      opId: "op-1",
      phase: "archiving",
      processedBytes: 10,
      totalBytes: 100,
    })
    const cancel = await screen.findByTitle(t.progress.cancel)
    fireEvent.click(cancel)
    await waitFor(() => expect(cancelBackup).toHaveBeenCalledWith("op-1"))
    resolveExport({ url: "", filename: "", degradedSqlite: [] })
  })
})

describe("BackupSettings — restore", () => {
  it("keeps the restore button disabled for an incompatible archive", async () => {
    renderSettings()
    await openRestoreTab()
    await selectBackup({
      encrypted: false,
      needsPassphrase: false,
      manifest: manifest(),
      compatible: false,
      rejectReason: "backup.error.newerVersion",
    })
    expect(
      await screen.findByText(new RegExp(t.restore.preview.incompatibleHint))
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: t.restore.button })
    ).toBeDisabled()
  })

  it("scans for conflicts and warns about running agents when writing back", async () => {
    vi.mocked(scanExternalConflicts).mockResolvedValue([
      {
        agent: "claude",
        archivePath: "external/claude/projects/a.jsonl",
        targetPath: "/home/u/.claude/projects/a.jsonl",
        targetSize: 10,
      },
    ])
    vi.mocked(backupActiveAgents).mockResolvedValue(["Claude Code"])
    renderSettings()
    await openRestoreTab()
    await selectBackup({
      encrypted: false,
      needsPassphrase: false,
      manifest: manifest({ includesExternalTranscripts: true }),
      compatible: true,
    })

    // Defaults to the side location once an archive turns out to carry
    // transcripts — it never touches an agent's directory.
    const trigger = await screen.findByRole("combobox")
    expect(trigger).toHaveTextContent(t.restore.external.modeSide)

    fireEvent.keyDown(trigger, { key: "Enter" })
    fireEvent.click(await screen.findByText(t.restore.external.modeOriginal))

    await waitFor(() =>
      expect(scanExternalConflicts).toHaveBeenCalledWith("s1")
    )
    expect(await screen.findByText(/1 existing file/)).toBeInTheDocument()
    expect(await screen.findByText(/Claude Code/)).toBeInTheDocument()
  })

  it("reports the downgrade when agents were running, and waits for the user before restarting", async () => {
    vi.mocked(stageRestoreWeb).mockResolvedValue({
      needsRestart: true,
      restartDelayMs: 0,
      staged: {
        stagingDir: "/data/.codeg-restore-staging/op1",
        manifest: manifest({ includesExternalTranscripts: true }),
        restoredExternalPath: "/data/restored-transcripts/x",
        skippedConflicts: [],
        externalDowngraded: {
          reason: "agentsRunning",
          agents: ["Claude Code"],
          path: "/data/restored-transcripts/x",
        },
      },
    } as never)
    renderSettings()
    await openRestoreTab()
    await selectBackup({
      encrypted: false,
      needsPassphrase: false,
      manifest: manifest({ includesExternalTranscripts: true }),
      compatible: true,
    })
    fireEvent.click(screen.getByRole("button", { name: t.restore.button }))
    fireEvent.click(
      await screen.findByRole("button", { name: t.restore.confirmAction })
    )

    expect(
      await screen.findByText(new RegExp(t.restore.result.title))
    ).toBeInTheDocument()
    expect(screen.getByText(/were running/)).toBeInTheDocument()
    // The report is shown BEFORE the restart; the desktop path used to
    // relaunch immediately and drop it.
    expect(restartApp).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole("button", { name: t.restore.result.restartNow })
    )
    await waitFor(() => expect(restartApp).toHaveBeenCalled())
  })

  it("does NOT poll health and reload when the restart request fails", async () => {
    vi.mocked(stageRestoreWeb).mockResolvedValue({
      needsRestart: true,
      restartDelayMs: 0,
      staged: {
        stagingDir: "/data/.codeg-restore-staging/op1",
        manifest: manifest(),
        skippedConflicts: [],
      },
    } as never)
    restartApp.mockRejectedValue(new Error("unsupported"))
    renderSettings()
    await openRestoreTab()
    await selectBackup({
      encrypted: false,
      needsPassphrase: false,
      manifest: manifest(),
      compatible: true,
    })
    fireEvent.click(screen.getByRole("button", { name: t.restore.button }))
    fireEvent.click(
      await screen.findByRole("button", { name: t.restore.confirmAction })
    )
    fireEvent.click(
      await screen.findByRole("button", { name: t.restore.result.restartNow })
    )

    await waitFor(() => expect(restartApp).toHaveBeenCalled())
    // Polling would land back on the still-running OLD process and look like
    // success while the restore never applied.
    expect(waitForServerHealthy).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(t.restore.restartFailed)
    )
  })

  it("offers an escape hatch when a restore is already staged", async () => {
    vi.mocked(stageRestoreWeb).mockRejectedValue({
      code: "already_exists",
      message: "pending",
      i18nKey: "backup.restore.error.alreadyPending",
    })
    renderSettings()
    await openRestoreTab()
    await selectBackup({
      encrypted: false,
      needsPassphrase: false,
      manifest: manifest(),
      compatible: true,
    })
    fireEvent.click(screen.getByRole("button", { name: t.restore.button }))
    fireEvent.click(
      await screen.findByRole("button", { name: t.restore.confirmAction })
    )

    const discard = await screen.findByRole("button", {
      name: t.restore.discardPending,
    })
    fireEvent.click(discard)
    await waitFor(() => expect(discardPendingRestore).toHaveBeenCalled())
  })
})

describe("BackupSettings — safety snapshots", () => {
  it("lists snapshots and only offers rollback for ones that can be rolled back", async () => {
    vi.mocked(listSafetySnapshots).mockResolvedValue([
      {
        id: "20260901-120000-op1",
        path: "/data/.codeg-restore-backup/20260901-120000-op1",
        createdAt: "2026-09-01T12:00:00Z",
        sizeBytes: 5 * 1024 * 1024,
        rollbackSupported: true,
      },
      {
        id: "20260101-000000-legacy",
        path: "/data/.codeg-restore-backup/20260101-000000-legacy",
        createdAt: null,
        sizeBytes: 1024,
        rollbackSupported: false,
      },
    ])
    renderSettings()
    await openRestoreTab()
    expect(await screen.findByText(t.snapshots.unsupported)).toBeInTheDocument()
    expect(
      screen.getAllByText(/20260101-000000-legacy/).length
    ).toBeGreaterThan(0)

    const buttons = screen.getAllByRole("button", {
      name: t.snapshots.rollback,
    })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    fireEvent.click(
      await screen.findByRole("button", { name: t.snapshots.rollback })
    )
    await waitFor(() =>
      expect(rollbackToSnapshot).toHaveBeenCalledWith("20260901-120000-op1")
    )
  })
})
