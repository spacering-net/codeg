import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildQoderEnv,
  formatQoderCredits,
  QoderConfigPanel,
  qoderAuthMethod,
  qoderLoginCommand,
  qoderQuotaSummary,
} from "./qoder-config-panel"
import {
  acpQoderAuthStatus,
  acpQoderQuota,
  acpUpdateAgentConfig,
} from "@/lib/api"
import type { AcpAgentInfo, QoderAuthStatus, QoderQuota } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

vi.mock("@/lib/api", () => ({
  acpQoderAuthStatus: vi.fn(),
  acpQoderQuota: vi.fn(),
  acpUpdateAgentConfig: vi.fn(),
}))

describe("buildQoderEnv", () => {
  it("writes a trimmed token and preserves unrelated keys", () => {
    expect(buildQoderEnv({ KEEP: "y" }, "  pat-123  ")).toEqual({
      KEEP: "y",
      QODER_PERSONAL_ACCESS_TOKEN: "pat-123",
    })
  })

  it("clearing the field removes the key rather than writing an empty one", () => {
    expect(
      buildQoderEnv({ KEEP: "y", QODER_PERSONAL_ACCESS_TOKEN: "old" }, "  ")
    ).toEqual({ KEEP: "y" })
  })
})

describe("qoderLoginCommand", () => {
  it("quotes a path with whitespace and falls back when absent", () => {
    expect(qoderLoginCommand("/Applications/My Tools/qoder")).toBe(
      '"/Applications/My Tools/qoder" login'
    )
    expect(qoderLoginCommand("/usr/local/bin/qoder")).toBe(
      "/usr/local/bin/qoder login"
    )
    expect(qoderLoginCommand(null)).toBe("qoder login")
    expect(qoderLoginCommand("")).toBe("qoder login")
  })
})

describe("qoderAuthMethod", () => {
  it("reads security.auth.selectedType out of the settings document", () => {
    expect(
      qoderAuthMethod('{"security":{"auth":{"selectedType":"qoder-browser"}}}')
    ).toBe("qoder-browser")
  })

  it("reads as unknown for anything that is not that string", () => {
    // A settings file this panel can't make sense of must never make the card
    // assert something about the account — it just drops the line.
    expect(qoderAuthMethod("{oops")).toBe("")
    expect(qoderAuthMethod("[1,2]")).toBe("")
    expect(qoderAuthMethod("null")).toBe("")
    expect(qoderAuthMethod('{"security":{}}')).toBe("")
    expect(qoderAuthMethod('{"security":{"auth":{"selectedType":7}}}')).toBe("")
    expect(qoderAuthMethod("")).toBe("")
    expect(qoderAuthMethod(null)).toBe("")
    expect(qoderAuthMethod(undefined)).toBe("")
  })
})

describe("qoderQuotaSummary", () => {
  const labels = {
    remaining: (credits: string) => `${credits} credits left`,
    exceeded: "Quota exhausted",
  }

  /** The shape the CLI's usage reply summarizes to: one package the account is
   *  drawing on, no org package, no add-on. Synthetic numbers on purpose. */
  const quotaOf = (overrides: Partial<QoderQuota> = {}): QoderQuota => ({
    personal: {
      total: 3000,
      used: 2212,
      remaining: 788,
      percentage: 73.73,
      unit: "credits",
      available: true,
    },
    organization: null,
    add_on: null,
    total_remaining: 788,
    unit: "credits",
    total_usage_percentage: 73.73,
    is_quota_exceeded: false,
    ...overrides,
  })

  // One number beside the account name: the packages it is summed from are not
  // itemised in the card.
  it("shows the summed credits and nothing else", () => {
    const { line, title } = qoderQuotaSummary(quotaOf(), labels)
    expect(line).toBe("788 credits left")
    expect(title).toBe("788 credits left")
    expect(line).not.toContain("Personal")
    expect(line).not.toContain("Org")
  })

  // The unit word comes from the message, so it is spelled in the reader's
  // language rather than pasted from whatever token the service sent.
  it("spells the unit from the message it is handed", () => {
    const zh = {
      remaining: (credits: string) => `剩余 ${credits}`,
      exceeded: "额度已用完",
    }
    expect(qoderQuotaSummary(quotaOf(), zh).line).toBe("剩余 788")
    // The payload's own `unit` never reaches the line.
    expect(
      qoderQuotaSummary(quotaOf({ unit: "credits" }), zh).line
    ).not.toContain("credits")
  })

  it("reports a zero balance rather than dropping the row", () => {
    expect(
      qoderQuotaSummary(quotaOf({ total_remaining: 0 }), labels).line
    ).toBe("0 credits left")
  })

  // The backend decides exhaustion (the CLI's rule: the flag, else a spent
  // allowance, else nothing left); the row only carries the note through.
  it("carries the exhausted note the backend decided on", () => {
    expect(qoderQuotaSummary(quotaOf(), labels).title).not.toContain(
      "exhausted"
    )
    expect(
      qoderQuotaSummary(quotaOf({ is_quota_exceeded: true }), labels).title
    ).toContain("Quota exhausted")
  })

  it("keeps whole credits whole and drops unusable numbers", () => {
    expect(formatQoderCredits(3000)).toBe("3000")
    expect(formatQoderCredits(12.5)).toBe("12.5")
    expect(formatQoderCredits(0)).toBe("0")
    expect(formatQoderCredits(null)).toBe("")
    expect(formatQoderCredits(Number.NaN)).toBe("")
  })
})

describe("QoderConfigPanel", () => {
  const m = enMessages.AcpAgentSettings.qoder

  type PanelOverrides = {
    env?: Record<string, string>
    configJson?: string
    onSaveEnv?: ReturnType<typeof vi.fn>
    onSaved?: ReturnType<typeof vi.fn>
    onAffectedSessions?: ReturnType<typeof vi.fn>
  }

  function agentOf(overrides?: PanelOverrides): AcpAgentInfo {
    return {
      agent_type: "qoder",
      enabled: true,
      env: overrides?.env ?? {},
      config_json: overrides?.configJson ?? '{\n  "ui": {}\n}',
      config_file_path: "/home/u/.qoder/settings.json",
    } as unknown as AcpAgentInfo
  }

  /** Renders the panel and hands back a `rerender` that swaps in new persisted
   * values — the settings page refetches after every save, so that is how the
   * panel learns what actually landed. */
  function renderPanel(overrides?: PanelOverrides) {
    const onSaveEnv = overrides?.onSaveEnv ?? vi.fn().mockResolvedValue(0)
    const onSaved = overrides?.onSaved ?? vi.fn()
    const onAffectedSessions = overrides?.onAffectedSessions ?? vi.fn()
    const tree = (agent: AcpAgentInfo) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QoderConfigPanel
          agent={agent}
          saving={false}
          onSaveEnv={onSaveEnv}
          onSaved={onSaved}
          onAffectedSessions={onAffectedSessions}
        />
      </NextIntlClientProvider>
    )
    const view = render(tree(agentOf(overrides)))
    return {
      onSaveEnv,
      onSaved,
      onAffectedSessions,
      rerender: (next: PanelOverrides) =>
        view.rerender(tree(agentOf({ ...overrides, ...next }))),
    }
  }

  /** A signed-in card, with synthetic account data. */
  function signedIn(overrides: Partial<QoderAuthStatus> = {}): QoderAuthStatus {
    return {
      installed: true,
      logged_in: true,
      username: "demo-user",
      email: null,
      user_type: "personal_standard",
      version: "1.1.64",
      allow_byok: null,
      error: null,
      binary_path: "/usr/local/bin/qoder",
      ...overrides,
    }
  }

  /** The credits the usage probe reports, summed across the packages. */
  function creditsOf(overrides: Partial<QoderQuota> = {}): QoderQuota {
    return {
      personal: {
        total: 3000,
        used: 2212,
        remaining: 788,
        percentage: 73.73,
        unit: "credits",
        available: true,
      },
      organization: null,
      add_on: null,
      total_remaining: 788,
      unit: "credits",
      total_usage_percentage: 73.73,
      is_quota_exceeded: false,
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(acpQoderAuthStatus).mockResolvedValue({
      installed: false,
      logged_in: false,
      username: null,
      email: null,
      user_type: null,
      version: null,
      allow_byok: null,
      error: null,
      binary_path: null,
    })
    vi.mocked(acpQoderQuota).mockResolvedValue(null)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
  })

  it("shows the signed-in account, tier and probed CLI version", async () => {
    vi.mocked(acpQoderAuthStatus).mockResolvedValue(signedIn())
    renderPanel()
    expect(await screen.findByText("demo-user")).toBeTruthy()
    expect(screen.getByText("personal_standard")).toBeTruthy()
    expect(screen.getByText("1.1.64")).toBeTruthy()
    // Signed in ⇒ no login command on screen.
    expect(screen.queryByText(/qoder login$/)).toBeNull()
  })

  it("shows the account's credits beside the account name", async () => {
    vi.mocked(acpQoderAuthStatus).mockResolvedValue(signedIn())
    vi.mocked(acpQoderQuota).mockResolvedValue(creditsOf())
    renderPanel()
    expect(await screen.findByText("demo-user")).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByTestId("qoder-quota").textContent).toBe(
        "788 credits left"
      )
    )
  })

  // The usage lookup takes seconds; the account line must not wait for it.
  it("shows the account name before the credits arrive", async () => {
    let release: (value: QoderQuota | null) => void = () => {}
    vi.mocked(acpQoderAuthStatus).mockResolvedValue(signedIn())
    vi.mocked(acpQoderQuota).mockReturnValue(
      new Promise<QoderQuota | null>((resolve) => {
        release = resolve
      })
    )
    renderPanel()
    expect(await screen.findByText("demo-user")).toBeTruthy()
    expect(screen.queryByTestId("qoder-quota")).toBeNull()

    await act(async () => {
      release(creditsOf())
    })
    await waitFor(() =>
      expect(screen.getByTestId("qoder-quota").textContent).toBe(
        "788 credits left"
      )
    )
  })

  // Signed out, no credential the CLI can use, or a failed lookup: all three
  // answer without credits, and the row simply carries no numbers.
  it("leaves the credits out when the lookup has none", async () => {
    vi.mocked(acpQoderAuthStatus).mockResolvedValue(signedIn())
    vi.mocked(acpQoderQuota).mockResolvedValue(null)
    renderPanel()
    expect(await screen.findByText("demo-user")).toBeTruthy()
    await waitFor(() => expect(acpQoderQuota).toHaveBeenCalled())
    expect(screen.queryByTestId("qoder-quota")).toBeNull()
  })

  it("leaves the credits out when the call itself fails", async () => {
    vi.mocked(acpQoderAuthStatus).mockResolvedValue(signedIn())
    vi.mocked(acpQoderQuota).mockRejectedValue(new Error("transport"))
    renderPanel()
    expect(await screen.findByText("demo-user")).toBeTruthy()
    expect(screen.queryByTestId("qoder-quota")).toBeNull()
  })

  // Both calls answer at their own pace, so a reply from a refresh that has
  // already been superseded must not land on the row.
  it("ignores a credits reply from an older refresh", async () => {
    const pending: Array<(value: QoderQuota | null) => void> = []
    vi.mocked(acpQoderAuthStatus).mockResolvedValue(signedIn())
    vi.mocked(acpQoderQuota).mockImplementation(
      () =>
        new Promise<QoderQuota | null>((resolve) => {
          pending.push(resolve)
        })
    )
    renderPanel()
    await screen.findByText("demo-user")
    await waitFor(() => expect(pending.length).toBe(1))

    fireEvent.click(screen.getByTestId("qoder-auth-refresh"))
    await waitFor(() => expect(pending.length).toBe(2))
    await act(async () => {
      pending[1](creditsOf({ total_remaining: 500 }))
    })
    await waitFor(() =>
      expect(screen.getByTestId("qoder-quota").textContent).toBe(
        "500 credits left"
      )
    )

    // The first refresh finally answers with the older balance.
    await act(async () => {
      pending[0](creditsOf({ total_remaining: 788 }))
    })
    expect(screen.getByTestId("qoder-quota").textContent).toBe(
      "500 credits left"
    )
  })

  // A balance belongs to one account: a new credential on screen drops it until
  // a refresh answers for that credential.
  it("drops the previous account's credits when the token changes", async () => {
    vi.mocked(acpQoderAuthStatus).mockResolvedValue(signedIn())
    vi.mocked(acpQoderQuota).mockResolvedValue(creditsOf())
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId("qoder-quota").textContent).toBe(
        "788 credits left"
      )
    )

    fireEvent.change(screen.getByPlaceholderText(m.tokenPlaceholder), {
      target: { value: "pat-other-account" },
    })
    await waitFor(() => expect(screen.queryByTestId("qoder-quota")).toBeNull())
  })

  it("offers the resolved login command when signed out", async () => {
    vi.mocked(acpQoderAuthStatus).mockResolvedValue({
      installed: true,
      logged_in: false,
      username: null,
      email: null,
      user_type: null,
      version: "1.1.25",
      allow_byok: null,
      error: null,
      binary_path: "/cache/qoder",
    })
    renderPanel()
    expect(await screen.findByText("/cache/qoder login")).toBeTruthy()
  })

  it("a probe failure reads as 'unavailable', never as 'signed out'", async () => {
    vi.mocked(acpQoderAuthStatus).mockResolvedValue({
      installed: true,
      logged_in: false,
      username: null,
      email: null,
      user_type: null,
      version: null,
      allow_byok: null,
      error: "qoder status timed out",
      binary_path: "/usr/local/bin/qoder",
    })
    renderPanel()
    expect(await screen.findByText(m.authUnknown)).toBeTruthy()
    expect(screen.queryByText(m.authNotLoggedIn)).toBeNull()
    // A failed probe must not invite a pointless re-login.
    expect(screen.queryByText(/ login$/)).toBeNull()
  })

  it("shows the auth method recorded in settings.json", async () => {
    renderPanel({
      configJson: '{"security":{"auth":{"selectedType":"qoder-browser"}}}',
    })
    await screen.findByText(m.authNotInstalled)
    expect(screen.getByText("qoder-browser")).toBeTruthy()
  })

  it("saves the token through the env channel", async () => {
    const { onSaveEnv, onSaved } = renderPanel({ env: { KEEP: "y" } })
    await screen.findByText(m.authNotInstalled)

    fireEvent.change(screen.getByPlaceholderText(m.tokenPlaceholder), {
      target: { value: "new-token" },
    })
    fireEvent.click(screen.getByText(m.saveToken))

    await waitFor(() => expect(onSaveEnv).toHaveBeenCalled())
    expect(onSaveEnv.mock.calls[0][0]).toEqual({
      KEEP: "y",
      QODER_PERSONAL_ACCESS_TOKEN: "new-token",
    })
    expect(onSaveEnv.mock.calls[0][1]).toBe(true)
    expect(onSaved).toHaveBeenCalled()
    // The account card never touches settings.json.
    expect(acpUpdateAgentConfig).not.toHaveBeenCalled()
  })

  it("clearing the token hands back a map without the key", async () => {
    // The settings page folds this map into the raw env draft, where an absent
    // key means "delete the line". An empty-string value instead would persist
    // an empty credential — and would look like a token to anything reading
    // the draft back.
    const { onSaveEnv } = renderPanel({
      env: { KEEP: "y", QODER_PERSONAL_ACCESS_TOKEN: "old" },
    })
    await screen.findByText(m.authNotInstalled)

    fireEvent.change(screen.getByPlaceholderText(m.tokenPlaceholder), {
      target: { value: "  " },
    })
    fireEvent.click(screen.getByText(m.saveToken))

    await waitFor(() => expect(onSaveEnv).toHaveBeenCalled())
    expect(onSaveEnv.mock.calls[0][0]).toEqual({ KEEP: "y" })
  })

  it("skips the write when the token is unchanged", async () => {
    const { onSaveEnv, onSaved } = renderPanel({
      env: { QODER_PERSONAL_ACCESS_TOKEN: "pat" },
    })
    await screen.findByText(m.authNotInstalled)

    fireEvent.click(screen.getByText(m.saveToken))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    // Rewriting an identical env would only mark running sessions stale.
    expect(onSaveEnv).not.toHaveBeenCalled()
  })

  it("keeps a token typed while the save is in flight", async () => {
    // The field stays editable during the write, so the text on screen can be
    // newer than the text that landed. If the save marked the field clean
    // regardless, the refresh it triggers would re-seed it from the older
    // persisted value and the newer keystrokes would vanish.
    let release: (v: number) => void = () => {}
    const onSaveEnv = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve
        })
    )
    const { rerender } = renderPanel({ env: {}, onSaveEnv })
    await screen.findByText(m.authNotInstalled)

    const field = screen.getByPlaceholderText(m.tokenPlaceholder)
    fireEvent.change(field, { target: { value: "pat-a" } })
    fireEvent.click(screen.getByText(m.saveToken))
    await waitFor(() => expect(onSaveEnv).toHaveBeenCalled())

    fireEvent.change(field, { target: { value: "pat-b" } })
    await act(async () => {
      release(0)
    })

    // The settings page refetches after a save and hands back what landed.
    rerender({ env: { QODER_PERSONAL_ACCESS_TOKEN: "pat-a" } })
    expect((field as HTMLInputElement).value).toBe("pat-b")
  })

  it("keeps raw edits typed while the file write is in flight", async () => {
    let release: (v: number) => void = () => {}
    vi.mocked(acpUpdateAgentConfig).mockReturnValue(
      new Promise<number>((resolve) => {
        release = resolve
      })
    )
    const { rerender } = renderPanel({ configJson: '{"a":1}' })
    await screen.findByText(m.authNotInstalled)

    fireEvent.click(screen.getByText(m.advancedToggle))
    const editor = screen.getByDisplayValue('{"a":1}')
    fireEvent.change(editor, { target: { value: '{"a":2}' } })
    fireEvent.click(screen.getByText(m.saveRawConfig))
    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalled())

    fireEvent.change(editor, { target: { value: '{"a":3}' } })
    await act(async () => {
      release(0)
    })

    rerender({ configJson: '{"a":2}' })
    expect((editor as HTMLTextAreaElement).value).toBe('{"a":3}')
  })

  it("the raw editor writes the whole document through config_json", async () => {
    const { onAffectedSessions } = renderPanel()
    await screen.findByText(m.authNotInstalled)

    fireEvent.click(screen.getByText(m.advancedToggle))
    // The file path is shown so it's clear which file is being rewritten.
    expect(screen.getByText("/home/u/.qoder/settings.json")).toBeTruthy()
    fireEvent.click(screen.getByText(m.saveRawConfig))

    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalled())
    expect(vi.mocked(acpUpdateAgentConfig).mock.calls[0][1]).toEqual({
      config_json: '{\n  "ui": {}\n}',
    })
    expect(onAffectedSessions).toHaveBeenCalledWith(0)
  })
})
