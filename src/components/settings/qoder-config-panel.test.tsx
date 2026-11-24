import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import {
  buildQoderEnv,
  QoderConfigPanel,
  qoderAuthMethod,
  qoderLoginCommand,
} from "./qoder-config-panel"
import { acpQoderAuthStatus, acpUpdateAgentConfig } from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

vi.mock("@/lib/api", () => ({
  acpQoderAuthStatus: vi.fn(),
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

describe("QoderConfigPanel", () => {
  const m = enMessages.AcpAgentSettings.qoder

  type PanelOverrides = {
    env?: Record<string, string>
    configJson?: string
    onSaveEnv?: Mock
    onSaved?: Mock
    onAffectedSessions?: Mock
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
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
  })

  it("shows the signed-in account, tier and probed CLI version", async () => {
    vi.mocked(acpQoderAuthStatus).mockResolvedValue({
      installed: true,
      logged_in: true,
      username: "tao fei",
      email: "t@example.com",
      user_type: "personal_standard",
      version: "1.1.25",
      allow_byok: false,
      error: null,
      binary_path: "/usr/local/bin/qoder",
    })
    renderPanel()
    expect(await screen.findByText("tao fei")).toBeTruthy()
    expect(screen.getByText("personal_standard")).toBeTruthy()
    expect(screen.getByText("1.1.25")).toBeTruthy()
    // Signed in ⇒ no login command on screen.
    expect(screen.queryByText(/qoder login$/)).toBeNull()
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
