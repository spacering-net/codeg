/**
 * The repository panel's auto-processing section, and the activity card that
 * says what it has done.
 *
 * Three things carry this surface. Switching the webhook on must put
 * everything the forge's form asks for on screen at once (where to deliver,
 * the secret). The per-kind choices must show what the backend will actually
 * run — the kind's default when nothing is chosen. And the activity card must
 * say what the last scan did, including WHY it did nothing, in place: that is
 * the answer someone opens this dialog for.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { DEFAULT_FORGE_AUTO_SETTINGS } from "@/lib/forge-auto"
import type {
  ForgeAutoScanReport,
  ForgeAutoSettings,
  ForgeAutoStatus,
} from "@/lib/types"

const forgeAutoStatus = vi.fn()
const forgeAutoScanNow = vi.fn()
const forgeListLabels = vi.fn()
vi.mock("@/lib/api", () => ({
  forgeAutoStatus: (id: number) => forgeAutoStatus(id),
  forgeAutoScanNow: (id: number) => forgeAutoScanNow(id),
  forgeListLabels: (id: number) => forgeListLabels(id),
  getWebServerStatus: () => Promise.resolve(null),
}))
vi.mock("@/lib/platform", () => ({ isLocalDesktop: () => false }))
vi.mock("@/lib/transport", () => ({
  getServerBaseUrl: () => "https://codeg.test",
}))

import {
  ForgeAutoActivity,
  ForgeAutoSettingsSection,
} from "./forge-auto-settings"

/** The arguments of a mock's latest call. */
function lastCall(fn: Mock): unknown[] {
  const calls = fn.mock.calls
  return calls[calls.length - 1]
}

function report(over: Partial<ForgeAutoScanReport> = {}): ForgeAutoScanReport {
  return {
    trigger: "schedule",
    started_at: "2026-10-14T08:00:00Z",
    finished_at: "2026-10-14T08:00:02Z",
    error: null,
    since: null,
    examined: 6,
    matched: 2,
    already_handled: 1,
    created: [
      {
        number: 12,
        is_pr: false,
        title: "Login times out",
        task_id: 40,
        started: true,
        start_error: null,
      },
    ],
    failed: [],
    skipped: { excluded_label: 3, draft: 1 },
    truncated: false,
    ...over,
  }
}

function status(over: Partial<ForgeAutoStatus> = {}): ForgeAutoStatus {
  return {
    available: true,
    scanning: false,
    last_scan: null,
    next_scan_at: null,
    last_delivery_at: null,
    ...over,
  }
}

function Harness({
  initial = DEFAULT_FORGE_AUTO_SETTINGS,
  folderId = 4 as number | null,
  savedEnabledAt = null as string | null,
  blocked = null as string | null,
  onChange = vi.fn(),
}) {
  const [value, setValue] = useState<ForgeAutoSettings>(initial)
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeAutoSettingsSection
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
        folderId={folderId}
        savedEnabledAt={savedEnabledAt}
        scanBlockedReason={blocked}
      />
    </NextIntlClientProvider>
  )
}

function mountActivity(blocked: string | null = null) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeAutoActivity folderId={4} scanBlockedReason={blocked} />
    </NextIntlClientProvider>
  )
}

const scanNowButton = () => screen.getByRole("button", { name: /Scan now/ })

beforeEach(() => {
  vi.clearAllMocks()
  forgeAutoStatus.mockResolvedValue(status())
  forgeListLabels.mockResolvedValue({ labels: [], truncated: false })
})

describe("ForgeAutoSettingsSection", () => {
  /** Everything the forge's webhook form asks for appears with the switch:
   *  the URL to deliver to and a secret — minted right here, so it can be
   *  pasted before the dialog is even saved. */
  it("mints a secret and shows where to deliver when the webhook goes on", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.click(
      screen.getByRole("switch", { name: /Scan on webhook events/ })
    )
    const next = lastCall(onChange)[0] as ForgeAutoSettings
    expect(next.webhook).toBe(true)
    expect(next.webhook_secret).toMatch(/^[0-9a-f]{64}$/)
    expect(
      await screen.findByText("https://codeg.test/api/forge_webhook")
    ).toBeInTheDocument()
    // Masked until asked for.
    expect(screen.queryByText(next.webhook_secret!)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show secret" }))
    expect(screen.getByText(next.webhook_secret!)).toBeInTheDocument()
  })

  /** Switching it off and on keeps the secret already pasted into the forge. */
  it("keeps the existing secret across an off/on", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Harness
        initial={{
          ...DEFAULT_FORGE_AUTO_SETTINGS,
          webhook: true,
          webhook_secret: "already-in-the-forge",
        }}
        onChange={onChange}
      />
    )
    const toggle = screen.getByRole("switch", {
      name: /Scan on webhook events/,
    })
    await user.click(toggle)
    await user.click(toggle)
    expect((lastCall(onChange)[0] as ForgeAutoSettings).webhook_secret).toBe(
      "already-in-the-forge"
    )
  })

  it("asks for an interval only while the schedule is on", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(
      screen.queryByRole("combobox", { name: "Scan every" })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("switch", { name: /Scan on a schedule/ }))
    expect(
      screen.getByRole("combobox", { name: "Scan every" })
    ).toHaveTextContent("15 minutes")
  })

  /** What the select shows is what the backend runs: the kind's default
   *  until something else is chosen. */
  it("shows each kind's scenario, and the draft switch with pull requests", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(
      screen.getByRole("combobox", {
        name: "How automatic issue tasks are handled",
      })
    ).toHaveTextContent("Fix / implement")
    expect(
      screen.queryByRole("combobox", {
        name: "How automatic pull / merge request tasks are handled",
      })
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole("switch", { name: /Pull \/ merge requests/ })
    )
    expect(
      screen.getByRole("combobox", {
        name: "How automatic pull / merge request tasks are handled",
      })
    ).toHaveTextContent("Review & fix")
    expect(screen.getByRole("checkbox", { name: /Skip drafts/ })).toBeChecked()
  })

  it("edits the rule lists as chips", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.type(
      screen.getByRole("textbox", {
        name: "Never items with any of these labels",
      }),
      "wontfix{Enter}"
    )
    await user.type(
      screen.getByRole("textbox", { name: "Only items opened by" }),
      "alice,"
    )
    const next = lastCall(onChange)[0] as ForgeAutoSettings
    expect(next.exclude_labels).toEqual(["wontfix"])
    expect(next.include_authors).toEqual(["alice"])
  })

  /** The repository's own labels are offered as suggestions in a folder. */
  it("suggests the repository's labels in a folder scope only", async () => {
    forgeListLabels.mockResolvedValue({
      labels: [{ name: "bug", color: null }],
      truncated: false,
    })
    const { unmount } = render(<Harness folderId={4} />)
    await waitFor(() => expect(forgeListLabels).toHaveBeenCalledWith(4))
    unmount()

    forgeListLabels.mockClear()
    render(<Harness folderId={null} />)
    expect(forgeListLabels).not.toHaveBeenCalled()
    // …and the global row says whose rules these are, with no activity card.
    expect(
      screen.getByText(/every project folder that follows the global/)
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Scan now/ })
    ).not.toBeInTheDocument()
  })

  it("says from when items are picked up", () => {
    render(<Harness savedEnabledAt="2026-10-14T08:00:00Z" />)
    expect(
      screen.getByText(/only items opened or updated since .* are picked up/)
    ).toBeInTheDocument()
  })
})

describe("ForgeAutoActivity", () => {
  it("reports what the last scan did, and what it passed over", async () => {
    forgeAutoStatus.mockResolvedValue(
      status({
        last_scan: report(),
        next_scan_at: "2026-10-14T08:15:00Z",
        last_delivery_at: "2026-10-14T07:59:00Z",
      })
    )
    mountActivity()

    expect(
      await screen.findByText(
        /6 listed · 2 matched · 1 already had a task · 1 created\./
      )
    ).toBeInTheDocument()
    expect(screen.getByText(/\(scheduled\)/)).toBeInTheDocument()
    expect(
      screen.getByText("New tasks: #12 Login times out")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Passed over: draft 1 · excluded label 3")
    ).toBeInTheDocument()
    expect(screen.getByText(/Next scheduled scan:/)).toBeInTheDocument()
    expect(screen.getByText(/Last webhook delivery:/)).toBeInTheDocument()
  })

  /** A scan that stopped — no account, a dead token — is the very answer the
   *  user opened the dialog for, so it is said here, not in a toast. */
  it("says in place why a scan stopped", async () => {
    forgeAutoStatus.mockResolvedValue(
      status({
        last_scan: report({ error: "no GitHub account for host github.com" }),
      })
    )
    mountActivity()
    expect(
      await screen.findByText(/stopped: no GitHub account for host github.com/)
    ).toBeInTheDocument()
  })

  it("scans on request and shows the result", async () => {
    const user = userEvent.setup()
    const manual = report({
      trigger: "manual",
      created: [],
      examined: 0,
      matched: 0,
    })
    forgeAutoScanNow.mockResolvedValue(manual)
    // Before the scan there is nothing to show; after it, the processor's
    // own record carries the report — as the backend's does.
    forgeAutoStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ last_scan: manual }))
    mountActivity()
    await waitFor(() => expect(scanNowButton()).toBeEnabled())

    await user.click(scanNowButton())
    expect(forgeAutoScanNow).toHaveBeenCalledWith(4)
    expect(await screen.findByText(/0 listed · 0 matched/)).toBeInTheDocument()
    expect(screen.getByText(/\(manual\)/)).toBeInTheDocument()
  })

  it("shows a refused scan inline", async () => {
    const user = userEvent.setup()
    forgeAutoScanNow.mockRejectedValue(
      new Error("this folder is already being scanned")
    )
    mountActivity()
    await waitFor(() => expect(scanNowButton()).toBeEnabled())
    await user.click(scanNowButton())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "this folder is already being scanned"
    )
  })

  /** A scan with rules other than the ones on screen would answer a question
   *  nobody asked — so unsaved edits hold the button, and say why. */
  it("holds Scan now while the form is unsaved, saying why", async () => {
    mountActivity("Save first — a scan uses the saved rules.")
    await waitFor(() => expect(forgeAutoStatus).toHaveBeenCalled())
    expect(scanNowButton()).toBeDisabled()
    expect(
      screen.getByText("Save first — a scan uses the saved rules.")
    ).toBeInTheDocument()
  })

  it("explains a process that does not run auto-processing", async () => {
    forgeAutoStatus.mockResolvedValue(status({ available: false }))
    mountActivity()
    expect(
      await screen.findByText(/Another codeg process runs the task board/)
    ).toBeInTheDocument()
    expect(scanNowButton()).toBeDisabled()
  })
})
