import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UpdateContextValue } from "@/components/providers/update-provider"
import type { AppUpdateState } from "@/lib/updater"

// Drive the component straight off the context value: the provider's own
// behaviour (checking, scheduling, seq guards) is covered in its test.
let ctx: UpdateContextValue | null = null
vi.mock("@/components/providers/update-provider", () => ({
  useAppUpdate: () => ctx,
}))

const openUrl = vi.fn()
vi.mock("@/lib/platform", () => ({ openUrl: (u: string) => openUrl(u) }))

// The popover pulls the markdown stack in lazily; keep the test off the ESM
// markdown pipeline (its rendering is the settings page's concern).
vi.mock("@/components/settings/release-notes", () => ({
  ReleaseNotes: ({
    notes,
    emptyLabel,
  }: {
    notes: string
    emptyLabel: string
  }) => <div data-testid="notes">{notes || emptyLabel}</div>,
}))

import { StatusBarUpdate } from "./status-bar-update"
import enMessages from "@/i18n/messages/en.json"

const startUpdate = vi.fn(async () => {})
const restart = vi.fn(async () => {})
const dismissAvailable = vi.fn()

function makeCtx(overrides: Partial<UpdateContextValue>): UpdateContextValue {
  const state: AppUpdateState = overrides.state ?? { seq: 1, status: "idle" }
  return {
    state,
    isUpdating: state.status === "downloading" || state.status === "installing",
    restartCountdown: null,
    isRollingBack: false,
    isRestarting: false,
    hydrated: true,
    isBusy: false,
    available: null,
    currentVersion: "0.21.7",
    checking: false,
    checkError: null,
    lastCheckedAt: new Date("2026-07-24T10:00:00Z"),
    selfUpdateSupported: false,
    liveProgress: false,
    runtime: undefined,
    rollbackAvailable: false,
    selfUpdateBlocker: null,
    canInstallInPlace: true,
    dismissedVersion: null,
    checkNow: vi.fn(async () => {}),
    dismissAvailable,
    refreshLocalStatus: vi.fn(async () => {}),
    startUpdate,
    restart,
    rollback: vi.fn(async () => {}),
    ...overrides,
  }
}

function renderWith(overrides: Partial<UpdateContextValue>) {
  ctx = makeCtx(overrides)
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarUpdate />
    </NextIntlClientProvider>
  )
}

const RELEASE = { version: "0.21.9", body: "## Fixes", date: "2026-07-24" }

// What the server reports for an install directory it can't write.
const UNWRITABLE_BIN = {
  code: "permission_denied",
  message: "Update target is not writable: /usr/local/bin",
  detail: "Permission denied (os error 13)",
  i18n_key: "SystemSettings.updateErrors.permissionDenied",
  i18n_params: { path: "/usr/local/bin" },
}

beforeEach(() => {
  startUpdate.mockClear()
  restart.mockClear()
  dismissAvailable.mockClear()
  openUrl.mockClear()
})

describe("StatusBarUpdate — trigger", () => {
  it("renders nothing when idle with no release on offer", () => {
    const { container } = renderWith({})
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing outside a provider", () => {
    ctx = null
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StatusBarUpdate />
      </NextIntlClientProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("badges a newly available release", () => {
    renderWith({ available: RELEASE })
    expect(screen.getByRole("button", { name: /New v0\.21\.9/ })).toBeVisible()
  })

  it("keeps a dismissed release reachable as a muted, label-less icon", () => {
    // Hiding it outright would leave the settings page as the only way back to
    // a release waved away by mistake. The icon stops asking for attention
    // (no accent colour, no label) but still opens the panel.
    renderWith({ available: RELEASE, dismissedVersion: "0.21.9" })

    const trigger = screen.getByRole("button", { name: /New v0\.21\.9/ })
    expect(trigger).toBeVisible()
    // No visible label, and not accented.
    expect(trigger.textContent).toBe("")
    expect(trigger.className).not.toContain("text-primary")
  })

  it("accents the badge with its label while the release is undismissed", () => {
    renderWith({ available: RELEASE })
    const trigger = screen.getByRole("button", { name: /New v0\.21\.9/ })
    expect(trigger.textContent).toContain("New v0.21.9")
    expect(trigger.className).toContain("text-primary")
  })

  it("still shows a dismissed release once its download is staged", () => {
    // Dismissing hides the invitation, not an update the user then chose to
    // install — that one still needs its restart prompt.
    renderWith({
      available: RELEASE,
      dismissedVersion: "0.21.9",
      state: { seq: 4, status: "ready_to_restart", version: "0.21.9" },
    })
    expect(
      screen.getByRole("button", { name: /Restart to update/ })
    ).toBeVisible()
  })

  it("shows download percent while downloading", () => {
    renderWith({
      state: { seq: 2, status: "downloading", downloaded: 50, total: 200 },
    })
    expect(screen.getByRole("button", { name: /25%/ })).toBeVisible()
  })

  it("shows the restart countdown while relaunching", () => {
    renderWith({
      state: { seq: 6, status: "restarting" },
      restartCountdown: 3,
    })
    expect(
      screen.getByRole("button", { name: /Restarting in 3s/ })
    ).toBeVisible()
  })
})

describe("StatusBarUpdate — popover", () => {
  it("shows the version delta, notes and starts the in-place update", async () => {
    renderWith({ available: RELEASE })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(await screen.findByText("Update available")).toBeVisible()
    expect(screen.getByText("v0.21.7 → v0.21.9")).toBeVisible()
    await waitFor(() =>
      expect(screen.getByTestId("notes").textContent).toBe("## Fixes")
    )

    fireEvent.click(
      screen.getByRole("button", { name: /Upgrade to v0\.21\.9/ })
    )
    expect(startUpdate).toHaveBeenCalledTimes(1)
  })

  it("links to the release page when this client can't install in place", async () => {
    // Older remote server: driving the detached flow against it would hang on
    // its legacy blocking endpoint.
    renderWith({ available: RELEASE, canInstallInPlace: false })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    const link = await screen.findByRole("button", {
      name: /View v0\.21\.9 release/,
    })
    fireEvent.click(link)
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/xintaofei/codeg/releases/latest"
    )
    expect(startUpdate).not.toHaveBeenCalled()
  })

  it("relaunches from the staged-update prompt", async () => {
    renderWith({
      available: RELEASE,
      state: { seq: 4, status: "ready_to_restart", version: "0.21.9" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Restart to update/ }))

    // Trigger and popover action share the label, so wait for the second one
    // to appear and click that.
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /Restart to update/ })
      ).toHaveLength(2)
    )
    const actions = screen.getAllByRole("button", { name: /Restart to update/ })
    fireEvent.click(actions[actions.length - 1])
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("still offers the upgrade after a dismissal, without the Later button", async () => {
    // The muted icon must not be a dead end: the action survives, only the
    // nagging goes away — and "Later" is pointless once already dismissed.
    renderWith({ available: RELEASE, dismissedVersion: "0.21.9" })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(
      await screen.findByRole("button", { name: /Upgrade to v0\.21\.9/ })
    ).toBeVisible()
    expect(screen.getByText("Update available")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull()
  })

  it("dismisses the release and closes", async () => {
    renderWith({ available: RELEASE })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    fireEvent.click(await screen.findByRole("button", { name: "Later" }))
    expect(dismissAvailable).toHaveBeenCalledTimes(1)
  })

  it("explains a failed install and offers a retry", async () => {
    renderWith({
      available: RELEASE,
      state: {
        seq: 7,
        status: "error",
        error: "error sending request for url",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(await screen.findByText(/Check your network or proxy/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(startUpdate).toHaveBeenCalled()
  })

  it("offers the release page, and says why, when the server can't install in place", async () => {
    // A root-owned install run by an unprivileged service: the server reports
    // it up front, so the popover must not offer an upgrade certain to fail.
    renderWith({
      available: RELEASE,
      selfUpdateBlocker: UNWRITABLE_BIN,
      canInstallInPlace: false,
    })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(
      await screen.findByText(
        "Cannot write to /usr/local/bin, so updates can't be installed in place. Update manually with administrator privileges or check installation permissions."
      )
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: /View v0\.21\.9 release/ })
    ).toBeVisible()
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull()
  })

  it("names the directory once when the failed install hit that wall", async () => {
    renderWith({
      available: RELEASE,
      state: {
        seq: 7,
        status: "error",
        error: UNWRITABLE_BIN.message,
        errorInfo: UNWRITABLE_BIN,
      },
      selfUpdateBlocker: UNWRITABLE_BIN,
      canInstallInPlace: false,
    })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(
      await screen.findByText(
        /^Update error: Cannot write to \/usr\/local\/bin/
      )
    ).toBeVisible()
    // Not repeated as a separate hint, and no retry that would fail again.
    expect(
      screen.getAllByText(/Cannot write to \/usr\/local\/bin/)
    ).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(
      screen.getByRole("button", { name: /View v0\.21\.9 release/ })
    ).toBeVisible()
  })

  it("reports transferred bytes while downloading", async () => {
    renderWith({
      state: {
        seq: 2,
        status: "downloading",
        downloaded: 1024 * 1024,
        total: 4 * 1024 * 1024,
      },
    })
    fireEvent.click(screen.getByRole("button", { name: /25%/ }))
    expect(await screen.findByText("1.0 MB / 4.0 MB")).toBeVisible()
  })
})
