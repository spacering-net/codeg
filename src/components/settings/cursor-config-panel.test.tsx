import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildCursorEnv,
  CursorConfigPanel,
  cursorAuthState,
  cursorLoginCommand,
  cursorLoginIsHeadless,
  cursorLoginRunsOnCodegHost,
  inferCursorMode,
  isCursorForceEnabled,
} from "./cursor-config-panel"
import {
  acpCursorAuthStatus,
  acpCursorListModels,
  acpUpdateAgentConfig,
} from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

vi.mock("@/lib/api", () => ({
  acpCursorAuthStatus: vi.fn(),
  acpCursorListModels: vi.fn(),
  acpUpdateAgentConfig: vi.fn(),
}))

// Default to a local desktop window: cursor-agent runs on this machine, so the
// login command keeps its plain browser-opening form.
const runtime = { desktop: true, remoteDesktop: false }
vi.mock("@/lib/transport", () => ({
  isDesktop: () => runtime.desktop,
  isRemoteDesktopMode: () => runtime.remoteDesktop,
}))

describe("buildCursorEnv", () => {
  it("API-key mode writes the key + model and always scrubs the dead base URL", () => {
    const env = buildCursorEnv(
      { OTHER: "x", CURSOR_API_BASE_URL: "https://stale" },
      "custom",
      "  sk-key  ",
      "claude-opus-4-8-high",
      true
    )
    expect(env).toEqual({
      OTHER: "x",
      CURSOR_AUTH_MODE: "custom",
      CURSOR_API_KEY: "sk-key",
      CURSOR_MODEL: "claude-opus-4-8-high",
      CURSOR_FORCE: "1",
    })
    // The CLI has no custom endpoint — the base URL is never persisted.
    expect(env).not.toHaveProperty("CURSOR_API_BASE_URL")
  })

  it("API-key mode with a blank key clears it but keeps the mode + unrelated keys", () => {
    const env = buildCursorEnv(
      {
        CURSOR_API_KEY: "old",
        CURSOR_API_BASE_URL: "https://old",
        CURSOR_MODEL: "m",
        CURSOR_FORCE: "1",
        KEEP: "y",
      },
      "custom",
      " ",
      "",
      false
    )
    expect(env).toEqual({
      KEEP: "y",
      CURSOR_AUTH_MODE: "custom",
      CURSOR_FORCE: "0",
    })
  })

  it("subscription mode drops the key + base URL but keeps the model", () => {
    // The key arg is ignored in subscription mode — the launch uses browser
    // login, so shipping a key (or a base URL) would be wrong.
    const env = buildCursorEnv(
      { CURSOR_API_KEY: "old", CURSOR_API_BASE_URL: "https://old", KEEP: "y" },
      "subscription",
      "ignored-key",
      "auto",
      false
    )
    expect(env).toEqual({
      KEEP: "y",
      CURSOR_AUTH_MODE: "subscription",
      CURSOR_MODEL: "auto",
      CURSOR_FORCE: "0",
    })
  })

  it("writes the off state explicitly so it differs from never-configured", () => {
    // The bug this closes: off used to be a DELETED key, which the launch read
    // as "unset" — so the panel could show one permission mode while the
    // session ran another. Both states must now be on the wire.
    expect(buildCursorEnv({}, "subscription", "", "", false).CURSOR_FORCE).toBe(
      "0"
    )
    expect(buildCursorEnv({}, "subscription", "", "", true).CURSOR_FORCE).toBe(
      "1"
    )
  })
})

describe("inferCursorMode", () => {
  it("prefers the explicit knob over key presence", () => {
    expect(
      inferCursorMode({ CURSOR_AUTH_MODE: "subscription", CURSOR_API_KEY: "k" })
    ).toBe("subscription")
    expect(inferCursorMode({ CURSOR_AUTH_MODE: "custom" })).toBe("custom")
  })

  it("infers custom from a saved API key, else subscription (legacy rows)", () => {
    expect(inferCursorMode({ CURSOR_API_KEY: "k" })).toBe("custom")
    expect(inferCursorMode({})).toBe("subscription")
  })
})

describe("cursorLoginCommand", () => {
  it("quotes a path with whitespace and falls back when absent", () => {
    expect(cursorLoginCommand("/Applications/My App/cursor-agent")).toBe(
      '"/Applications/My App/cursor-agent" login'
    )
    expect(cursorLoginCommand("/usr/local/bin/cursor-agent")).toBe(
      "/usr/local/bin/cursor-agent login"
    )
    expect(cursorLoginCommand(null)).toBe("cursor-agent login")
    expect(cursorLoginCommand("")).toBe("cursor-agent login")
  })

  it("asks for the printed URL when the host cannot open a browser", () => {
    expect(cursorLoginCommand("/opt/cursor-agent/bin/cursor-agent", true)).toBe(
      "NO_OPEN_BROWSER=1 /opt/cursor-agent/bin/cursor-agent login"
    )
    // The prefix goes before the quoting, not inside it.
    expect(cursorLoginCommand("/opt/my agent/cursor-agent", true)).toBe(
      'NO_OPEN_BROWSER=1 "/opt/my agent/cursor-agent" login'
    )
    // The unresolved-path fallback takes the prefix too: a caller asking for
    // the headless form is showing copy that promises a printed URL.
    expect(cursorLoginCommand(null, true)).toBe(
      "NO_OPEN_BROWSER=1 cursor-agent login"
    )
  })
})

describe("cursorLoginRunsOnCodegHost", () => {
  it("is false only for a window whose backend is this machine", () => {
    expect(cursorLoginRunsOnCodegHost(true, false)).toBe(false)
    // A web page and a remote-desktop window both talk to a codeg server.
    expect(cursorLoginRunsOnCodegHost(false, false)).toBe(true)
    expect(cursorLoginRunsOnCodegHost(true, true)).toBe(true)
  })
})

describe("cursorLoginIsHeadless", () => {
  const POSIX = "/opt/cursor-agent/bin/cursor-agent"

  it("keeps the browser flow on a local desktop window", () => {
    expect(cursorLoginIsHeadless(POSIX, true, false)).toBe(false)
  })

  it("treats a web page and a remote-desktop window as another host", () => {
    // Both talk to a codeg server: `login` would run there, with no display.
    expect(cursorLoginIsHeadless(POSIX, false, false)).toBe(true)
    expect(cursorLoginIsHeadless(POSIX, true, true)).toBe(true)
  })

  it("does not emit POSIX env syntax for a Windows host", () => {
    const WIN = "C:\\Program Files\\cursor-agent.exe"
    expect(cursorLoginIsHeadless(WIN, false, false)).toBe(false)
    expect(
      cursorLoginIsHeadless("\\\\srv\\share\\cursor-agent.exe", false, false)
    ).toBe(false)
    // ...but it is still another machine, so the wording must not claim a
    // browser opens here. Suppressing both was the bug this pair splits.
    expect(cursorLoginRunsOnCodegHost(false, false)).toBe(true)
  })
})

describe("cursorAuthState", () => {
  const signedIn = {
    installed: true,
    is_authenticated: true,
    raw_status: "authenticated",
    email: "itpkcn@gmail.com",
    membership: null,
    error: null,
    binary_path: "/cache/cursor-agent",
  }

  it("demotes a stored-but-unusable login to `stale`", () => {
    // The reported contradiction: `cursor-agent status` reports a login (it
    // only checks that both tokens exist), while `cursor-agent acp` refuses
    // every session/new because the access token has aged out. The card has to
    // show the second answer, not the first.
    expect(
      cursorAuthState({ ...signedIn, credential_verified: false }, false)
    ).toBe("stale")
    expect(
      cursorAuthState({ ...signedIn, credential_verified: true }, false)
    ).toBe("ok")
  })

  it("keeps an unknown verification meaning signed in", () => {
    // A backend that predates the flag sends null/undefined; inventing a login
    // problem there would be worse than the bug being fixed.
    expect(
      cursorAuthState({ ...signedIn, credential_verified: null }, false)
    ).toBe("ok")
    expect(cursorAuthState(signedIn, false)).toBe("ok")
  })

  it("keeps the states that do not depend on verification", () => {
    expect(cursorAuthState(null, true)).toBe("loading")
    expect(cursorAuthState(null, false)).toBe("missing")
    expect(cursorAuthState({ ...signedIn, installed: false }, false)).toBe(
      "missing"
    )
    // Not signed in at all wins over the verification flag, whatever it says.
    expect(
      cursorAuthState(
        { ...signedIn, is_authenticated: false, credential_verified: false },
        false
      )
    ).toBe("unauthenticated")
    // An in-flight re-probe must not blank a card that already has an answer.
    expect(
      cursorAuthState({ ...signedIn, credential_verified: false }, true)
    ).toBe("stale")
  })
})

describe("isCursorForceEnabled", () => {
  it("accepts 1/true in any case with padding, rejects everything else", () => {
    expect(isCursorForceEnabled({ CURSOR_FORCE: "1" })).toBe(true)
    expect(isCursorForceEnabled({ CURSOR_FORCE: " TRUE " })).toBe(true)
    expect(isCursorForceEnabled({ CURSOR_FORCE: "0" })).toBe(false)
    expect(isCursorForceEnabled({ CURSOR_FORCE: "yes" })).toBe(false)
    expect(isCursorForceEnabled({})).toBe(false)
  })
})

describe("CursorConfigPanel", () => {
  const baseAgent = {
    agent_type: "cursor",
    enabled: true,
    env: {} as Record<string, string>,
    cursor_settings: {
      sandbox_mode: null,
      permissions_allow: [],
      permissions_deny: [],
    },
    cursor_cli_config_json: null,
  }

  function renderPanel(overrides?: {
    env?: Record<string, string>
    onSaveEnv?: ReturnType<typeof vi.fn>
    onSaved?: ReturnType<typeof vi.fn>
    onAffectedSessions?: ReturnType<typeof vi.fn>
  }) {
    const onSaveEnv = overrides?.onSaveEnv ?? vi.fn().mockResolvedValue(0)
    const onSaved = overrides?.onSaved ?? vi.fn()
    const onAffectedSessions = overrides?.onAffectedSessions ?? vi.fn()
    const agent = {
      ...baseAgent,
      env: overrides?.env ?? baseAgent.env,
    } as unknown as AcpAgentInfo
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CursorConfigPanel
          agent={agent}
          saving={false}
          onSaveEnv={onSaveEnv}
          onSaved={onSaved}
          onAffectedSessions={onAffectedSessions}
        />
      </NextIntlClientProvider>
    )
    return { onSaveEnv, onSaved, onAffectedSessions }
  }

  const authenticated = {
    installed: true,
    is_authenticated: true,
    raw_status: "authenticated",
    email: "itpkcn@gmail.com",
    membership: null,
    error: null,
    binary_path: "/cache/cursor-agent",
  }

  beforeEach(() => {
    vi.clearAllMocks()
    runtime.desktop = true
    runtime.remoteDesktop = false
    vi.mocked(acpCursorAuthStatus).mockResolvedValue({
      installed: false,
      is_authenticated: false,
      raw_status: null,
      email: null,
      membership: null,
      error: null,
      binary_path: null,
    })
    vi.mocked(acpCursorListModels).mockResolvedValue({
      models: [],
      default_model: null,
      error: null,
    })
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
  })

  it("rolls the env back when the rules write fails (API-key mode)", async () => {
    // A saved API key opens the panel in API-key mode. The widening hazard: the
    // env step already persisted (e.g. Run Everything on) but the deny rules
    // never landed — the save must restore the previous env.
    vi.mocked(acpUpdateAgentConfig).mockRejectedValue(new Error("disk full"))
    const originalEnv = { CURSOR_API_KEY: "old-key" }
    const { onSaveEnv, onSaved } = renderPanel({ env: originalEnv })
    await screen.findByText(enMessages.AcpAgentSettings.cursor.authNotInstalled)

    fireEvent.change(
      screen.getByPlaceholderText(
        enMessages.AcpAgentSettings.cursor.apiKeyPlaceholder
      ),
      { target: { value: "new-key" } }
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.AcpAgentSettings.cursor.saveConfig,
      })
    )

    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(2))
    // No CURSOR_API_BASE_URL is ever written; an unconfigured CURSOR_FORCE
    // means Ask, which is what the launch has always actually done.
    expect(onSaveEnv.mock.calls[0][0]).toEqual({
      CURSOR_AUTH_MODE: "custom",
      CURSOR_API_KEY: "new-key",
      CURSOR_FORCE: "0",
    })
    // Rollback restores the exact prior env map.
    expect(onSaveEnv.mock.calls[1][0]).toEqual(originalEnv)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("blocks an API-key save with no key", async () => {
    const { onSaveEnv } = renderPanel({ env: { CURSOR_AUTH_MODE: "custom" } })
    await screen.findByText(enMessages.AcpAgentSettings.cursor.authNotInstalled)

    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.AcpAgentSettings.cursor.saveConfig,
      })
    )
    // Validation short-circuits before any persistence.
    await waitFor(() =>
      expect(vi.mocked(acpUpdateAgentConfig)).not.toHaveBeenCalled()
    )
    expect(onSaveEnv).not.toHaveBeenCalled()
  })

  it("subscription mode shows the runnable login command and saves login-only env", async () => {
    vi.mocked(acpCursorAuthStatus).mockResolvedValue({
      installed: true,
      is_authenticated: false,
      raw_status: "unauthenticated",
      email: null,
      membership: null,
      error: null,
      binary_path:
        "/Users/x/Library/Caches/app.codeg/acp-binaries/cursor/dist-package/cursor-agent",
    })
    // Empty env → subscription mode.
    const { onSaveEnv, onSaved } = renderPanel({ env: {} })

    // The login command uses the resolved binary path, not a bare name.
    await screen.findByText(
      "/Users/x/Library/Caches/app.codeg/acp-binaries/cursor/dist-package/cursor-agent login"
    )

    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.AcpAgentSettings.cursor.saveConfig,
      })
    )

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(onSaveEnv).toHaveBeenCalledTimes(1)
    // Subscription persists the mode only — no credential. A fresh agent asks
    // before running, and says so explicitly rather than by omission.
    expect(onSaveEnv.mock.calls[0][0]).toEqual({
      CURSOR_AUTH_MODE: "subscription",
      CURSOR_FORCE: "0",
    })
  })

  it("a stored-but-unusable login shows the warning and the login command", async () => {
    // What the user reported: the card said "signed in" while every session
    // died with `Authentication required`. `cursor-agent status` reports the
    // login because both tokens are on disk; it says `unable to fetch user
    // details` in the same breath, which is the probe telling us the token no
    // longer works. The card must say that, and offer the only recovery the
    // CLI has.
    vi.mocked(acpCursorAuthStatus).mockResolvedValue({
      installed: true,
      is_authenticated: true,
      raw_status: "authenticated",
      email: null,
      membership: null,
      error: null,
      binary_path: "/cache/cursor-agent",
      credential_verified: false,
    })
    renderPanel({ env: { CURSOR_AUTH_MODE: "subscription" } })

    await screen.findByText(enMessages.AcpAgentSettings.cursor.authUnverified)
    expect(
      screen.getByText(enMessages.AcpAgentSettings.cursor.authUnverifiedHint)
    ).toBeTruthy()
    // The same runnable command the not-signed-in state offers.
    expect(screen.getByText("/cache/cursor-agent login")).toBeTruthy()
    // ...and never the green "signed in" line it used to show instead.
    expect(
      screen.queryByText(enMessages.AcpAgentSettings.cursor.authLoggedIn)
    ).toBeNull()
  })

  it("offers a command a headless codeg server can actually run", async () => {
    // The reported deployment: codeg-server on a Linux box, panel open in a
    // browser somewhere else. `login` would run on the server, where nothing
    // can open a browser — the reason the offered command "just cannot be
    // run". Cursor's documented answer is to print the URL instead.
    runtime.desktop = false
    vi.mocked(acpCursorAuthStatus).mockResolvedValue({
      installed: true,
      is_authenticated: false,
      raw_status: "unauthenticated",
      email: null,
      membership: null,
      error: null,
      binary_path: "/opt/cursor-agent/bin/cursor-agent",
      credential_verified: null,
    })
    renderPanel({ env: { CURSOR_AUTH_MODE: "subscription" } })

    expect(
      await screen.findByText(
        "NO_OPEN_BROWSER=1 /opt/cursor-agent/bin/cursor-agent login"
      )
    ).toBeTruthy()
    expect(
      screen.getByText(enMessages.AcpAgentSettings.cursor.loginHintRemote)
    ).toBeTruthy()
    // The desktop wording promises a browser window that never opens there.
    expect(
      screen.queryByText(enMessages.AcpAgentSettings.cursor.loginHint)
    ).toBeNull()
  })

  it("still says where to run it when the host is Windows", async () => {
    // A Windows codeg host cannot take the POSIX `VAR=1 cmd` prefix — but it
    // is still not this machine, so the wording must not fall back to "a
    // browser window opens". Suppressing both was the gap here.
    runtime.desktop = false
    vi.mocked(acpCursorAuthStatus).mockResolvedValue({
      installed: true,
      is_authenticated: false,
      raw_status: "unauthenticated",
      email: null,
      membership: null,
      error: null,
      binary_path: "C:\\Program Files\\cursor-agent\\cursor-agent.exe",
      credential_verified: null,
    })
    renderPanel({ env: { CURSOR_AUTH_MODE: "subscription" } })

    expect(
      await screen.findByText(
        '"C:\\Program Files\\cursor-agent\\cursor-agent.exe" login'
      )
    ).toBeTruthy()
    expect(
      screen.getByText(enMessages.AcpAgentSettings.cursor.loginHintRemote)
    ).toBeTruthy()
  })

  it("explains a rejected API key in its own terms, not the browser's", async () => {
    // The same `stale` card serves both modes, but the recoveries differ: an
    // API key is replaced in the field below, and telling that user the CLI
    // "cannot refresh a browser login" describes someone else's problem.
    vi.mocked(acpCursorAuthStatus).mockResolvedValue({
      installed: true,
      is_authenticated: true,
      raw_status: "authenticated",
      email: null,
      membership: null,
      error: null,
      binary_path: "/cache/cursor-agent",
      credential_verified: false,
    })
    renderPanel({ env: { CURSOR_AUTH_MODE: "custom", CURSOR_API_KEY: "sk-x" } })

    await screen.findByText(enMessages.AcpAgentSettings.cursor.authUnverified)
    expect(
      screen.getByText(
        enMessages.AcpAgentSettings.cursor.authUnverifiedHintApiKey
      )
    ).toBeTruthy()
    expect(
      screen.queryByText(enMessages.AcpAgentSettings.cursor.authUnverifiedHint)
    ).toBeNull()
  })

  it("round-trips a saved Run Everything choice", async () => {
    // The switch has to survive a re-open: the panel reads CURSOR_FORCE with
    // the same rule the launch does, so "1" comes back as "1" untouched.
    const { onSaveEnv, onSaved } = renderPanel({
      env: { CURSOR_AUTH_MODE: "subscription", CURSOR_FORCE: "1" },
    })
    await screen.findByText(enMessages.AcpAgentSettings.cursor.authNotInstalled)

    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.AcpAgentSettings.cursor.saveConfig,
      })
    )

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(onSaveEnv.mock.calls[0][0]).toEqual({
      CURSOR_AUTH_MODE: "subscription",
      CURSOR_FORCE: "1",
    })
  })

  it("subscription mode probes with an empty key to use browser login", async () => {
    renderPanel({ env: {} })
    await waitFor(() => expect(acpCursorAuthStatus).toHaveBeenCalled())
    // An empty string forces the login credential and strips any inherited key.
    expect(acpCursorAuthStatus).toHaveBeenCalledWith("")
  })

  it("hides the model picker (and hints to sign in) when no models are fetched", async () => {
    // Authenticated, but the models probe returns nothing → no picker.
    vi.mocked(acpCursorAuthStatus).mockResolvedValue(authenticated)
    vi.mocked(acpCursorListModels).mockResolvedValue({
      models: [],
      default_model: null,
      error: null,
    })
    renderPanel({ env: { CURSOR_AUTH_MODE: "subscription" } })

    await screen.findByText(enMessages.AcpAgentSettings.cursor.modelsNeedAuth)
    expect(
      screen.queryByText(enMessages.AcpAgentSettings.cursor.modelTitle)
    ).toBeNull()
  })

  it("shows the model picker once real models load", async () => {
    vi.mocked(acpCursorAuthStatus).mockResolvedValue(authenticated)
    vi.mocked(acpCursorListModels).mockResolvedValue({
      models: [
        { id: "auto", label: "Auto", is_default: true },
        { id: "claude-opus-4-8-high", label: "Opus 4.8 1M", is_default: false },
      ],
      default_model: "auto",
      error: null,
    })
    renderPanel({ env: { CURSOR_AUTH_MODE: "subscription" } })

    // The picker card (with its header) appears after the catalog loads.
    await screen.findByText(enMessages.AcpAgentSettings.cursor.modelTitle)
  })

  it("offers Thinking / Effort / Fast for the saved model's family", async () => {
    // The point of splitting the flat catalog: a saved
    // `claude-opus-5-thinking-high` has to open with its family selected and
    // the three variant knobs live, instead of being one opaque row among ~200.
    vi.mocked(acpCursorAuthStatus).mockResolvedValue(authenticated)
    vi.mocked(acpCursorListModels).mockResolvedValue({
      models: [
        { id: "auto", label: "Auto", is_default: true },
        {
          id: "claude-opus-5-high",
          label: "Claude Opus 5 1M",
          is_default: false,
        },
        {
          id: "claude-opus-5-high-fast",
          label: "Claude Opus 5 1M Fast",
          is_default: false,
        },
        {
          id: "claude-opus-5-thinking-high",
          label: "Claude Opus 5 1M Thinking",
          is_default: false,
        },
        {
          id: "claude-opus-5-thinking-max",
          label: "Claude Opus 5 1M Max Thinking",
          is_default: false,
        },
      ],
      default_model: "auto",
      error: null,
    })
    renderPanel({
      env: {
        CURSOR_AUTH_MODE: "subscription",
        CURSOR_MODEL: "claude-opus-5-thinking-high",
      },
    })

    await screen.findByText(
      enMessages.AcpAgentSettings.cursor.modelThinkingLabel
    )
    screen.getByText(enMessages.AcpAgentSettings.cursor.modelEffortLabel)
    screen.getByText(enMessages.AcpAgentSettings.cursor.modelFastLabel)
    // The exact id `--model` will receive is spelled out, so a repaired pick
    // is never invisible.
    screen.getByText("claude-opus-5-thinking-high")
  })

  it("hides variant controls for a family that has no variants", async () => {
    vi.mocked(acpCursorAuthStatus).mockResolvedValue(authenticated)
    vi.mocked(acpCursorListModels).mockResolvedValue({
      models: [{ id: "auto", label: "Auto", is_default: true }],
      default_model: "auto",
      error: null,
    })
    renderPanel({
      env: { CURSOR_AUTH_MODE: "subscription", CURSOR_MODEL: "auto" },
    })

    await screen.findByText(enMessages.AcpAgentSettings.cursor.modelTitle)
    expect(
      screen.queryByText(enMessages.AcpAgentSettings.cursor.modelThinkingLabel)
    ).toBeNull()
    expect(
      screen.queryByText(enMessages.AcpAgentSettings.cursor.modelFastLabel)
    ).toBeNull()
  })
})
