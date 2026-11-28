import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

vi.mock("@/lib/api", () => ({
  acpAntigravityLoginStart: vi.fn(),
  acpAntigravityLoginFinish: vi.fn(),
  acpAntigravityLoginCancel: vi.fn(),
  acpAntigravitySignOut: vi.fn(),
  acpScanLeakedTemp: vi.fn(),
  acpReclaimLeakedTemp: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { toast } from "sonner"

import {
  acpAntigravityLoginCancel,
  acpAntigravityLoginFinish,
  acpAntigravityLoginStart,
  acpAntigravitySignOut,
  acpReclaimLeakedTemp,
  acpScanLeakedTemp,
} from "@/lib/api"
import {
  ANTIGRAVITY_ENV_KEYS,
  AntigravityConfigPanel,
  antigravityIncompleteReason,
  antigravityPermissionModeFromEnv,
  buildAntigravityEnv,
  inferAntigravityMethod,
  type AntigravityAuthMethod,
  type AntigravityFormValues,
} from "./antigravity-config-panel"
import type { AcpAgentInfo } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

function values(
  method: AntigravityAuthMethod,
  overrides: Partial<AntigravityFormValues> = {}
): AntigravityFormValues {
  return {
    method,
    permissionMode: "default",
    geminiApiKey: "",
    googleApiKey: "",
    gcpProject: "",
    gcpLocation: "",
    ...overrides,
  }
}

describe("inferAntigravityMethod", () => {
  it("defaults to the browser login and rejects anything unrecognized", () => {
    // The default matters: it is the one path that needs no credential, so a
    // row with nothing recorded still launches with a workable method.
    expect(inferAntigravityMethod({})).toBe("oauth-personal")
    expect(inferAntigravityMethod({ AGY_AUTH_METHOD: "vertex-ai" })).toBe(
      "oauth-personal"
    )
    expect(inferAntigravityMethod({ AGY_AUTH_METHOD: "" })).toBe(
      "oauth-personal"
    )
    expect(inferAntigravityMethod({ AGY_AUTH_METHOD: "agent-platform" })).toBe(
      "agent-platform"
    )
  })
})

describe("antigravityPermissionModeFromEnv", () => {
  // 与后端 `antigravity_skip_permissions_enabled` 保持一致：
  // 仅显式 "1"/"true" 启用 Turbo 模式，其余保持默认。
  it("reads the launch knob the way the backend does", () => {
    expect(antigravityPermissionModeFromEnv({})).toBe("default")
    expect(
      antigravityPermissionModeFromEnv({
        AGY_DANGEROUSLY_SKIP_PERMISSIONS: "0",
      })
    ).toBe("default")
    expect(
      antigravityPermissionModeFromEnv({
        AGY_DANGEROUSLY_SKIP_PERMISSIONS: "turbo",
      })
    ).toBe("default")
    expect(
      antigravityPermissionModeFromEnv({
        AGY_DANGEROUSLY_SKIP_PERMISSIONS: "1",
      })
    ).toBe("turbo")
    expect(
      antigravityPermissionModeFromEnv({
        AGY_DANGEROUSLY_SKIP_PERMISSIONS: " TRUE ",
      })
    ).toBe("turbo")
  })
})

describe("buildAntigravityEnv", () => {
  it("keeps only the credential the chosen method uses and preserves the rest", () => {
    // Switching away from API-key auth must DELETE the key. Leaving it would
    // authenticate as something the user did not pick.
    const stale = {
      KEEP: "y",
      GEMINI_API_KEY: "old",
      GOOGLE_API_KEY: "older",
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_CLOUD_LOCATION: "global",
    }
    expect(buildAntigravityEnv(stale, values("oauth-personal"))).toEqual({
      KEEP: "y",
      AGY_AUTH_METHOD: "oauth-personal",
      AGY_DANGEROUSLY_SKIP_PERMISSIONS: "0",
    })

    expect(
      buildAntigravityEnv(
        stale,
        values("gemini-api-key", {
          geminiApiKey: "  AIza-new  ",
          permissionMode: "turbo",
        })
      )
    ).toEqual({
      KEEP: "y",
      AGY_AUTH_METHOD: "gemini-api-key",
      AGY_DANGEROUSLY_SKIP_PERMISSIONS: "1",
      GEMINI_API_KEY: "AIza-new",
    })
  })

  it("gives Gemini Enterprise its project and location", () => {
    // oauth-business reads its project and location from these env values,
    // which the launch passes through for this method.
    expect(
      buildAntigravityEnv(
        {},
        values("oauth-business", { gcpProject: "acme", gcpLocation: "eu" })
      )
    ).toEqual({
      AGY_AUTH_METHOD: "oauth-business",
      AGY_DANGEROUSLY_SKIP_PERMISSIONS: "0",
      GOOGLE_CLOUD_PROJECT: "acme",
      GOOGLE_CLOUD_LOCATION: "eu",
    })
  })

  it("lets an Agent Platform API key suppress the project and location", () => {
    // Matches the server: when GOOGLE_API_KEY is set its `_vertex_config`
    // suppresses both, so storing all three would keep two values that can
    // never take effect.
    expect(
      buildAntigravityEnv(
        {},
        values("agent-platform", {
          googleApiKey: "AIza-vertex",
          gcpProject: "ignored",
          gcpLocation: "ignored",
        })
      )
    ).toEqual({
      AGY_AUTH_METHOD: "agent-platform",
      AGY_DANGEROUSLY_SKIP_PERMISSIONS: "0",
      GOOGLE_API_KEY: "AIza-vertex",
    })

    expect(
      buildAntigravityEnv(
        {},
        values("agent-platform", { gcpProject: "p", gcpLocation: "us" })
      )
    ).toEqual({
      AGY_AUTH_METHOD: "agent-platform",
      AGY_DANGEROUSLY_SKIP_PERMISSIONS: "0",
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_CLOUD_LOCATION: "us",
    })
  })

  it("writes every key the settings page has to fold into the raw draft", () => {
    // ANTIGRAVITY_ENV_KEYS is what `persistEnv`'s draftEnvPatch iterates; a key
    // this panel writes but that list omits would be silently dropped the next
    // time the enable switch persists the draft wholesale.
    const written = buildAntigravityEnv(
      {},
      values("agent-platform", { gcpProject: "p", gcpLocation: "us" })
    )
    for (const key of Object.keys(written)) {
      expect(ANTIGRAVITY_ENV_KEYS).toContain(key)
    }
  })
})

describe("antigravityIncompleteReason", () => {
  it("mirrors the server's own auth_required rules", () => {
    // Browser login needs nothing — the server opens a browser at session/new.
    expect(antigravityIncompleteReason(values("oauth-personal"))).toBeNull()

    expect(antigravityIncompleteReason(values("gemini-api-key"))).toBe(
      "missingGeminiApiKey"
    )
    expect(
      antigravityIncompleteReason(
        values("gemini-api-key", { geminiApiKey: "AIza" })
      )
    ).toBeNull()

    // Agent Platform: a key OR both a project and a location.
    expect(antigravityIncompleteReason(values("agent-platform"))).toBe(
      "missingAgentPlatformConfig"
    )
    expect(
      antigravityIncompleteReason(values("agent-platform", { gcpProject: "p" }))
    ).toBe("missingAgentPlatformConfig")
    expect(
      antigravityIncompleteReason(
        values("agent-platform", { gcpProject: "p", gcpLocation: "us" })
      )
    ).toBeNull()
    expect(
      antigravityIncompleteReason(
        values("agent-platform", { googleApiKey: "AIza" })
      )
    ).toBeNull()

    // Gemini Enterprise needs BOTH; the server falls through to its no-config
    // path on a partial one.
    expect(
      antigravityIncompleteReason(
        values("oauth-business", { gcpProject: "acme" })
      )
    ).toBe("missingEnterpriseConfig")
    expect(
      antigravityIncompleteReason(
        values("oauth-business", { gcpProject: "acme", gcpLocation: "eu" })
      )
    ).toBeNull()
  })
})

describe("AntigravityConfigPanel", () => {
  const m = enMessages.AcpAgentSettings.antigravity

  type PanelOverrides = {
    env?: Record<string, string>
    onSaveEnv?: Mock
    onSaved?: Mock
  }

  function agentOf(overrides?: PanelOverrides): AcpAgentInfo {
    return {
      agent_type: "antigravity",
      enabled: true,
      env: overrides?.env ?? {},
      config_json: null,
      config_file_path: "/home/u/.gemini/antigravity-cli/settings.json",
    } as unknown as AcpAgentInfo
  }

  function renderPanel(overrides?: PanelOverrides) {
    const onSaveEnv = overrides?.onSaveEnv ?? vi.fn().mockResolvedValue(0)
    const onSaved = overrides?.onSaved ?? vi.fn()
    const tree = (agent: AcpAgentInfo) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AntigravityConfigPanel
          agent={agent}
          saving={false}
          onSaveEnv={onSaveEnv}
          onSaved={onSaved}
        />
      </NextIntlClientProvider>
    )
    const view = render(tree(agentOf(overrides)))
    return {
      onSaveEnv,
      onSaved,
      unmount: view.unmount,
      rerender: (next: PanelOverrides) =>
        view.rerender(tree(agentOf({ ...overrides, ...next }))),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** Storing the row is the whole save: `agy acp` reads no codeg-managed
   *  settings file, so there is no second step that could disagree. */
  it("reports a plain success once the row is stored", async () => {
    const onSaved = vi.fn()
    renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" }, onSaved })
    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("shows the browser-login hint and the settings.json path by default", () => {
    renderPanel()
    // The hint has to say a browser opens: that is the whole sign-in flow for
    // this method, and it happens at the first new session rather than here.
    expect(
      screen.getByText(m.methodHints["oauth-personal"])
    ).toBeInTheDocument()
    expect(
      screen.getByText("/home/u/.gemini/antigravity-cli/settings.json")
    ).toBeInTheDocument()
    // Nothing to fill in, so no warning.
    expect(screen.queryByText(m.missingGeminiApiKey)).not.toBeInTheDocument()
  })

  it("warns when the persisted method has no usable credential", () => {
    renderPanel({ env: { AGY_AUTH_METHOD: "gemini-api-key" } })
    expect(screen.getByText(m.missingGeminiApiKey)).toBeInTheDocument()
  })

  it("saves the credential the persisted method uses and drops the others", async () => {
    const onSaveEnv = vi.fn().mockResolvedValue(0)
    const onSaved = vi.fn()
    renderPanel({
      env: {
        AGY_AUTH_METHOD: "gemini-api-key",
        GEMINI_API_KEY: "old",
        GOOGLE_API_KEY: "stale",
        KEEP: "y",
      },
      onSaveEnv,
      onSaved,
    })

    fireEvent.change(screen.getByLabelText(m.geminiApiKeyLabel), {
      target: { value: "AIza-new" },
    })
    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(1))
    expect(onSaveEnv).toHaveBeenCalledWith(
      {
        KEEP: "y",
        AGY_AUTH_METHOD: "gemini-api-key",
        AGY_DANGEROUSLY_SKIP_PERMISSIONS: "0",
        GEMINI_API_KEY: "AIza-new",
      },
      true
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("shows the turbo permission hint and persists AGY_DANGEROUSLY_SKIP_PERMISSIONS", async () => {
    const onSaveEnv = vi.fn().mockResolvedValue(0)
    const { rerender } = renderPanel({
      env: {
        AGY_AUTH_METHOD: "oauth-personal",
        AGY_DANGEROUSLY_SKIP_PERMISSIONS: "1",
      },
      onSaveEnv,
    })

    expect(screen.getByText(m.permissionModeTurboHint)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(1))
    expect(onSaveEnv).toHaveBeenCalledWith(
      {
        AGY_AUTH_METHOD: "oauth-personal",
        AGY_DANGEROUSLY_SKIP_PERMISSIONS: "1",
      },
      true
    )

    // 未处于编辑态时，持久化行变化会同步刷新权限模式显示
    rerender({
      env: {
        AGY_AUTH_METHOD: "oauth-personal",
        AGY_DANGEROUSLY_SKIP_PERMISSIONS: "0",
      },
      onSaveEnv,
    })
    expect(screen.getByText(m.permissionModeDefaultHint)).toBeInTheDocument()
  })

  it("keeps an in-progress edit when the persisted row changes underneath", () => {
    const { rerender } = renderPanel({
      env: { AGY_AUTH_METHOD: "gemini-api-key", GEMINI_API_KEY: "old" },
    })
    const input = screen.getByLabelText(m.geminiApiKeyLabel)
    fireEvent.change(input, { target: { value: "typing-in-progress" } })

    // The settings page refetches after any save (possibly one from another
    // panel); a re-seed here would throw away what the user is typing.
    rerender({
      env: { AGY_AUTH_METHOD: "gemini-api-key", GEMINI_API_KEY: "x" },
    })
    expect((input as HTMLInputElement).value).toBe("typing-in-progress")
  })

  it("re-seeds from the persisted row while the form is untouched", () => {
    const { rerender } = renderPanel({
      env: { AGY_AUTH_METHOD: "oauth-business", GOOGLE_CLOUD_PROJECT: "acme" },
    })
    expect(
      (screen.getByLabelText(m.gcpProjectLabel) as HTMLInputElement).value
    ).toBe("acme")

    rerender({
      env: {
        AGY_AUTH_METHOD: "oauth-business",
        GOOGLE_CLOUD_PROJECT: "acme-2",
      },
    })
    expect(
      (screen.getByLabelText(m.gcpProjectLabel) as HTMLInputElement).value
    ).toBe("acme-2")
  })

  /**
   * The headless sign-in. It drives `agy acp --login`, which prints a Google
   * consent link and waits for the code — the only way a server with no
   * desktop ever gets a personal Google sign-in.
   */
  describe("browser-free sign-in", () => {
    const h = m.headless
    const started = {
      handle: "handle-1",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
      redirectUri: "http://127.0.0.1:54926/",
      methodId: "oauth-personal",
      expiresInSecs: 300,
    } as const

    beforeEach(() => {
      vi.mocked(acpAntigravityLoginStart).mockResolvedValue(started)
      vi.mocked(acpAntigravityLoginCancel).mockResolvedValue(undefined)
    })

    it("offers itself only for the methods that open a browser", () => {
      const { rerender } = renderPanel({
        env: { AGY_AUTH_METHOD: "oauth-personal" },
      })
      expect(screen.getByText(h.title)).toBeInTheDocument()

      // The API-key methods read their credential straight from the
      // environment, so there is no browser step to work around.
      rerender({
        env: { AGY_AUTH_METHOD: "gemini-api-key", GEMINI_API_KEY: "AIza" },
      })
      expect(screen.queryByText(h.title)).not.toBeInTheDocument()
    })

    /** `agy acp --login` signs a personal Google account in and nothing else,
     *  so Gemini Enterprise (which the CLI signs in at session start) is not
     *  offered a sign-in that would report success without authenticating it. */
    it("is not offered for Gemini Enterprise", () => {
      renderPanel({
        env: {
          AGY_AUTH_METHOD: "oauth-business",
          GOOGLE_CLOUD_PROJECT: "acme",
          GOOGLE_CLOUD_LOCATION: "eu",
        },
      })
      expect(screen.queryByText(h.title)).not.toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: h.start })
      ).not.toBeInTheDocument()
    })

    it("shows the link and the dead-end address it will redirect to", async () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      await waitFor(() =>
        expect(acpAntigravityLoginStart).toHaveBeenCalledWith("oauth-personal")
      )
      expect(await screen.findByText(started.authUrl)).toBeInTheDocument()
      // Naming the unreachable address is the point: without it the browser's
      // "cannot connect" page reads as a broken login rather than step two.
      expect(
        screen.getByText(new RegExp(started.redirectUri.replace(/\//g, "\\/")))
      ).toBeInTheDocument()
    })

    it("hands the pasted address back with the handle it was issued for", async () => {
      vi.mocked(acpAntigravityLoginFinish).mockResolvedValue({
        signedIn: true,
        message: null,
        retryable: false,
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      const input = await screen.findByPlaceholderText(
        `${started.redirectUri}?state=...&code=...`
      )
      const pasted = `${started.redirectUri}?state=s1&code=4%2F0AVGz`
      fireEvent.change(input, { target: { value: pasted } })
      fireEvent.click(screen.getByRole("button", { name: h.complete }))

      await waitFor(() =>
        expect(acpAntigravityLoginFinish).toHaveBeenCalledWith(
          "handle-1",
          pasted
        )
      )
      expect(await screen.findByText(h.signedIn)).toBeInTheDocument()
      expect(toast.success).toHaveBeenCalled()
    })

    /** A refusal has to carry the agent's own words: "onboarding failed",
     *  "ineligible user" and "that link was for an earlier attempt" need
     *  completely different responses from the user. */
    it("keeps the agent's reason on screen when the sign-in is refused", async () => {
      vi.mocked(acpAntigravityLoginFinish).mockResolvedValue({
        signedIn: false,
        message: "Onboarding failed: ineligible user",
        retryable: false,
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      const input = await screen.findByPlaceholderText(
        `${started.redirectUri}?state=...&code=...`
      )
      fireEvent.change(input, { target: { value: "4/0AVGz" } })
      fireEvent.click(screen.getByRole("button", { name: h.complete }))

      expect(await screen.findByText(h.failed)).toBeInTheDocument()
      expect(
        screen.getByText("Onboarding failed: ineligible user")
      ).toBeInTheDocument()
      expect(toast.success).not.toHaveBeenCalled()
    })

    /** Nothing to send yet, and an empty submit would spend the one-shot
     *  listener on a request that cannot carry a code. */
    it("will not submit an empty paste", async () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      expect(
        await screen.findByRole("button", { name: h.complete })
      ).toBeDisabled()
      expect(acpAntigravityLoginFinish).not.toHaveBeenCalled()
    })

    /** Abandoning has to reach the backend: the agent process is holding a
     *  listener open and would otherwise sit there for the full five minutes. */
    it("tells the backend when the user gives up", async () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      fireEvent.click(await screen.findByRole("button", { name: h.cancel }))

      await waitFor(() =>
        expect(acpAntigravityLoginCancel).toHaveBeenCalledWith("handle-1")
      )
      expect(screen.queryByText(started.authUrl)).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: h.start })).toBeInTheDocument()
    })

    /** The pending attempt belongs to the method it was started for. Switching
     *  away must not silently leave that agent process blocked on its listener
     *  for the rest of the five minutes. */
    it("abandons a pending sign-in when the method changes", async () => {
      const { rerender } = renderPanel({
        env: { AGY_AUTH_METHOD: "oauth-personal" },
      })
      fireEvent.click(screen.getByRole("button", { name: h.start }))
      await screen.findByText(started.authUrl)

      // The form is untouched, so the panel re-seeds from the persisted row —
      // the same path a save in another window takes.
      rerender({
        env: { AGY_AUTH_METHOD: "gemini-api-key", GEMINI_API_KEY: "AIza" },
      })

      await waitFor(() =>
        expect(acpAntigravityLoginCancel).toHaveBeenCalledWith("handle-1")
      )
      expect(screen.queryByText(started.authUrl)).not.toBeInTheDocument()
    })

    /** The listener answers one request. Once codeg has sent it, the link on
     *  screen is spent — offering the paste box again would only produce a
     *  second, unexplainable failure. */
    it("retires the link once the redirect has gone out", async () => {
      vi.mocked(acpAntigravityLoginFinish).mockResolvedValue({
        signedIn: false,
        message: "Onboarding failed: ineligible user",
        retryable: false,
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      const input = await screen.findByPlaceholderText(
        `${started.redirectUri}?state=...&code=...`
      )
      fireEvent.change(input, { target: { value: "4/0AVGz" } })
      fireEvent.click(screen.getByRole("button", { name: h.complete }))

      expect(await screen.findByText(h.failed)).toBeInTheDocument()
      expect(screen.queryByText(started.authUrl)).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: h.start })).toBeInTheDocument()
    })

    /**
     * The opposite case, and the reason `retryable` exists: codeg rejected the
     * paste on its own, so the agent never saw it. The consent the user already
     * gave in their browser is still good and only the paste needs fixing —
     * sending them back through Google would be gratuitous.
     */
    it("keeps the link usable when codeg rejected the paste itself", async () => {
      vi.mocked(acpAntigravityLoginFinish).mockResolvedValue({
        signedIn: false,
        message: "No authorization code found.",
        retryable: true,
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      const input = await screen.findByPlaceholderText(
        `${started.redirectUri}?state=...&code=...`
      )
      fireEvent.change(input, { target: { value: "not-a-redirect" } })
      fireEvent.click(screen.getByRole("button", { name: h.complete }))

      expect(await screen.findByText(h.failed)).toBeInTheDocument()
      expect(screen.getByText(started.authUrl)).toBeInTheDocument()
      expect((input as HTMLInputElement).value).toBe("not-a-redirect")
      expect(
        screen.getByRole("button", { name: h.complete })
      ).toBeInTheDocument()
    })

    /**
     * `start` can be in flight for a minute or more — the backend spawns the
     * agent and waits for it to print a link. Until it resolves, the handle
     * exists only inside that promise, so neither cleanup effect can see it: a
     * panel that closes first would leave the child sitting on a loopback
     * listener for Antigravity's full five minutes.
     */
    it("cancels a sign-in that lands after the panel is gone", async () => {
      let resolveStart: (value: typeof started) => void = () => {}
      vi.mocked(acpAntigravityLoginStart).mockReturnValue(
        new Promise((resolve) => {
          resolveStart = resolve
        })
      )
      const { unmount } = renderPanel({
        env: { AGY_AUTH_METHOD: "oauth-personal" },
      })
      fireEvent.click(screen.getByRole("button", { name: h.start }))
      await waitFor(() => expect(acpAntigravityLoginStart).toHaveBeenCalled())

      unmount()
      resolveStart(started)

      await waitFor(() =>
        expect(acpAntigravityLoginCancel).toHaveBeenCalledWith("handle-1")
      )
    })

    /** Same race, but the panel is still open: showing the link would offer a
     *  sign-in for the OLD method while the form reads the new one. */
    it("discards a sign-in that lands after the method changed", async () => {
      let resolveStart: (value: typeof started) => void = () => {}
      vi.mocked(acpAntigravityLoginStart).mockReturnValue(
        new Promise((resolve) => {
          resolveStart = resolve
        })
      )
      const { rerender } = renderPanel({
        env: { AGY_AUTH_METHOD: "oauth-personal" },
      })
      fireEvent.click(screen.getByRole("button", { name: h.start }))
      await waitFor(() => expect(acpAntigravityLoginStart).toHaveBeenCalled())

      rerender({
        env: {
          AGY_AUTH_METHOD: "oauth-business",
          GOOGLE_CLOUD_PROJECT: "acme",
          GOOGLE_CLOUD_LOCATION: "eu",
        },
      })
      resolveStart(started)

      await waitFor(() =>
        expect(acpAntigravityLoginCancel).toHaveBeenCalledWith("handle-1")
      )
      expect(screen.queryByText(started.authUrl)).not.toBeInTheDocument()
    })

    /**
     * The web transport throws the backend's `{code, message}` JSON verbatim —
     * it is not an `Error`. `String(e)` on that renders "[object Object]", and
     * it does so in SERVER mode, which is the only deployment this section
     * exists for. Every actionable message would be lost exactly where it is
     * needed most, so the wire shape is what the test uses.
     */
    it("shows the backend's message when the transport throws its JSON", async () => {
      vi.mocked(acpAntigravityLoginStart).mockRejectedValue({
        code: "sdk_not_installed",
        message: "Google Antigravity is not installed.",
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      await waitFor(() => expect(toast.error).toHaveBeenCalled())
      const shown = String(vi.mocked(toast.error).mock.calls[0]?.[0])
      expect(shown).toContain("Google Antigravity is not installed.")
      expect(shown).not.toContain("[object Object]")
    })

    it("does the same for a failure to complete", async () => {
      vi.mocked(acpAntigravityLoginFinish).mockRejectedValue({
        code: "network_error",
        message: "no sign-in is waiting; start a new one",
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))
      const input = await screen.findByPlaceholderText(
        `${started.redirectUri}?state=...&code=...`
      )
      fireEvent.change(input, { target: { value: "4/0AVGz" } })
      fireEvent.click(screen.getByRole("button", { name: h.complete }))

      expect(
        await screen.findByText("no sign-in is waiting; start a new one")
      ).toBeInTheDocument()
      expect(screen.queryByText("[object Object]")).not.toBeInTheDocument()
    })

    /**
     * The sharpest form of "the sign-in uses the STORED row". Switching to
     * personal OAuth needs no credential, so a field-only check passes it — and
     * the sign-in then genuinely succeeds. But the next launch reads the OLD
     * method from the database and scrubs this method's credentials on the
     * way, so the user is told they were signed in and then cannot start a
     * session.
     */
    it("waits for a save when the method itself is unsaved", () => {
      renderPanel({
        env: { AGY_AUTH_METHOD: "gemini-api-key", GEMINI_API_KEY: "AIza" },
      })
      // Switch to the browser login without saving.
      fireEvent.click(screen.getByLabelText(m.methodLabel))
      fireEvent.click(
        screen.getByRole("option", { name: m.methods["oauth-personal"] })
      )

      expect(screen.getByText(h.title)).toBeInTheDocument()
      expect(screen.getByText(h.saveFirst)).toBeInTheDocument()
      expect(screen.getByRole("button", { name: h.start })).toBeDisabled()
    })

    it("surfaces a failure to even start", async () => {
      vi.mocked(acpAntigravityLoginStart).mockRejectedValue(
        new Error("Google Antigravity is not installed.")
      )
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      await waitFor(() => expect(toast.error).toHaveBeenCalled())
      expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toContain(
        "Google Antigravity is not installed."
      )
      // Still offering to try again, not stuck in a spinner. The toast goes up
      // before the render that releases the button.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: h.start })).toBeEnabled()
      )
    })
  })

  /**
   * The escape hatch from a wrong account.
   *
   * Antigravity refreshes its cached credential by itself, so once one exists
   * every session silently reuses that account — the first Google account a
   * user picks is the last one they get, through reinstalls alike.
   */
  describe("sign-out", () => {
    const s = m.signOut

    beforeEach(() => {
      vi.mocked(acpAntigravitySignOut).mockResolvedValue(undefined)
    })

    it("offers itself only for the methods with a credential to discard", () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      expect(screen.getByRole("button", { name: s.action })).toBeInTheDocument()

      // An API-key method reads its credential from the environment on every
      // request, so there is nothing stored to sign out of.
      fireEvent.click(screen.getByLabelText(m.methodLabel))
      fireEvent.click(
        screen.getByRole("option", { name: m.methods["gemini-api-key"] })
      )
      expect(screen.queryByRole("button", { name: s.action })).toBeNull()
    })

    it("clears the credential and says another account can be picked", async () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: s.action }))

      await waitFor(() => expect(acpAntigravitySignOut).toHaveBeenCalled())
      expect(toast.success).toHaveBeenCalledWith(s.done)
    })

    /**
     * A stored row missing its project or location gates the SIGN-IN, because
     * consenting without one only fails at license resolution. Signing out
     * needs none of it — and a half-configured row is exactly what a user
     * trying to leave the wrong account is likely to have.
     */
    it("stays available when the stored row cannot sign in", () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-business" } })
      expect(screen.getByText(m.missingEnterpriseConfig)).toBeInTheDocument()
      expect(screen.getByRole("button", { name: s.action })).toBeEnabled()
    })

    it("shows the backend's message when the transport throws its JSON", async () => {
      vi.mocked(acpAntigravitySignOut).mockRejectedValue({
        code: "AcpError",
        message: "Google Antigravity is not installed.",
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: s.action }))

      await waitFor(() => expect(toast.error).toHaveBeenCalled())
      expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toContain(
        "Google Antigravity is not installed."
      )
      // The toast goes up before the render that releases the button.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: s.action })).toBeEnabled()
      )
    })
  })
  /**
   * The temp reclaim is a delete against the SYSTEM temp directory, which every
   * PyInstaller application on the machine shares. The panel's own copy admits
   * codeg cannot tell its own leftovers from someone else's — so consent has to
   * be per path, and it cannot be the default.
   */
  describe("leaked temp reclaim", () => {
    const r = enMessages.AcpAgentSettings.antigravity

    const scan = {
      root: "/tmp",
      total_bytes: 3_000_000,
      skipped: 1,
      entries: [
        {
          path: "/tmp/_MEI111111",
          bytes: 2_000_000,
          age_hours: 30,
          is_dir: true,
        },
        {
          path: "/tmp/_MEI222222",
          bytes: 1_000_000,
          age_hours: 5,
          is_dir: true,
        },
      ],
    }

    it("lists every path and pre-selects none of them", async () => {
      vi.mocked(acpScanLeakedTemp).mockResolvedValue(scan)
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })

      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimScan }))

      await screen.findByText("/tmp/_MEI111111")
      expect(screen.getByText("/tmp/_MEI222222")).toBeInTheDocument()
      for (const box of screen.getAllByRole("checkbox")) {
        expect(box).toHaveAttribute("data-state", "unchecked")
      }
      // Nothing selected means nothing to delete, so the destructive action is
      // not reachable at all.
      expect(
        screen.getByRole("button", { name: r.tempReclaimDelete })
      ).toBeDisabled()
    })

    it("deletes only what was ticked, and only after a confirmation", async () => {
      vi.mocked(acpScanLeakedTemp).mockResolvedValue(scan)
      vi.mocked(acpReclaimLeakedTemp).mockResolvedValue({
        removed: 1,
        freed_bytes: 2_000_000,
        failed: [],
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimScan }))
      await screen.findByText("/tmp/_MEI111111")

      // Tick the first entry only. Index 0 is the select-all header box.
      fireEvent.click(screen.getAllByRole("checkbox")[1])
      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimDelete }))

      // The click opens the dialog; it must not have deleted anything yet.
      expect(acpReclaimLeakedTemp).not.toHaveBeenCalled()
      fireEvent.click(
        await screen.findByRole("button", { name: r.tempReclaimConfirmAction })
      )

      await waitFor(() => expect(acpReclaimLeakedTemp).toHaveBeenCalled())
      expect(acpReclaimLeakedTemp).toHaveBeenCalledWith(["/tmp/_MEI111111"])
    })

    it("shows every path the backend refused, not just the first", async () => {
      vi.mocked(acpScanLeakedTemp).mockResolvedValue(scan)
      vi.mocked(acpReclaimLeakedTemp).mockResolvedValue({
        removed: 0,
        freed_bytes: 0,
        failed: ["/tmp/_MEI111111: in use", "/tmp/_MEI222222: access denied"],
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimScan }))
      await screen.findByText("/tmp/_MEI111111")

      fireEvent.click(screen.getAllByRole("checkbox")[0])
      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimDelete }))
      fireEvent.click(
        await screen.findByRole("button", { name: r.tempReclaimConfirmAction })
      )

      await screen.findByText("/tmp/_MEI111111: in use")
      expect(
        screen.getByText("/tmp/_MEI222222: access denied")
      ).toBeInTheDocument()
    })
  })
})
