import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  acpSyncAntigravitySettings: vi.fn(),
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
  acpSyncAntigravitySettings,
} from "@/lib/api"
import {
  ANTIGRAVITY_ENV_KEYS,
  AntigravityConfigPanel,
  antigravityIncompleteReason,
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
    // row with nothing recorded still produces a workable settings.json.
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

describe("buildAntigravityEnv", () => {
  it("keeps only the credential the chosen method uses and preserves the rest", () => {
    // Switching away from API-key auth must DELETE the key. Leaving it would
    // authenticate as something the user did not pick and would contradict the
    // auth.type the same launch writes to settings.json.
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
    })

    expect(
      buildAntigravityEnv(
        stale,
        values("gemini-api-key", { geminiApiKey: "  AIza-new  " })
      )
    ).toEqual({
      KEEP: "y",
      AGY_AUTH_METHOD: "gemini-api-key",
      GEMINI_API_KEY: "AIza-new",
    })
  })

  it("gives Gemini Enterprise its project and location", () => {
    // oauth-business reads gcp.project/location from settings.json only, and
    // the launch path copies them out of these very env values.
    expect(
      buildAntigravityEnv(
        {},
        values("oauth-business", { gcpProject: "acme", gcpLocation: "eu" })
      )
    ).toEqual({
      AGY_AUTH_METHOD: "oauth-business",
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
      GOOGLE_API_KEY: "AIza-vertex",
    })

    expect(
      buildAntigravityEnv(
        {},
        values("agent-platform", { gcpProject: "p", gcpLocation: "us" })
      )
    ).toEqual({
      AGY_AUTH_METHOD: "agent-platform",
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
    onSaveEnv?: ReturnType<typeof vi.fn>
    onSaved?: ReturnType<typeof vi.fn>
  }

  function agentOf(overrides?: PanelOverrides): AcpAgentInfo {
    return {
      agent_type: "antigravity",
      enabled: true,
      env: overrides?.env ?? {},
      config_json: null,
      config_file_path: "/home/u/.gemini/antigravity-acp/settings.json",
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
    vi.mocked(acpSyncAntigravitySettings).mockResolvedValue({
      path: "/home/u/.gemini/antigravity-acp/settings.json",
      status: "written",
      reason: null,
    })
  })

  /**
   * Saving the row is only half of it, so "saved" is only half true.
   *
   * The choice is enforced by `auth.type` in the ACP server's settings.json,
   * and that file is the user's — comments make it Hjson, which codeg refuses
   * to rewrite rather than flatten. The launch skips it with a log line nobody
   * reads. Claiming success anyway is how switching methods becomes a mystery
   * failure hours later: the launch scrubs the credentials for the NEW method
   * while the server keeps reading the OLD auth.type.
   */
  it("does not claim success when the settings file was left alone", async () => {
    vi.mocked(acpSyncAntigravitySettings).mockResolvedValue({
      path: "/home/u/.gemini/antigravity-acp/settings.json",
      status: "skipped",
      reason: "it is not strict JSON codeg can rewrite without losing content",
    })
    const onSaved = vi.fn()
    renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" }, onSaved })

    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    // And it stays on screen: this is a standing disagreement between the form
    // and the file, not a four-second event.
    expect(await screen.findByText(m.syncSkipped)).toBeInTheDocument()
    expect(
      screen.getByText(
        "it is not strict JSON codeg can rewrite without losing content"
      )
    ).toBeInTheDocument()
    // The row itself DID save, so the panel still reports the save as done.
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("reports a plain success when the file was written", async () => {
    renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()
    expect(screen.queryByText(m.syncSkipped)).not.toBeInTheDocument()
  })

  /** A transport failure on the REPORT must not turn a stored row into a
   *  failed save — the launch-time sync still runs either way. */
  it("still reports the save when the sync probe itself fails", async () => {
    vi.mocked(acpSyncAntigravitySettings).mockRejectedValue(
      new Error("offline")
    )
    const onSaved = vi.fn()
    renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" }, onSaved })

    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalled()
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
      screen.getByText("/home/u/.gemini/antigravity-acp/settings.json")
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
        GEMINI_API_KEY: "AIza-new",
      },
      true
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
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
   * The headless sign-in. Antigravity's OAuth is run by the AGENT — it opens a
   * browser on the machine the agent runs on — so on a server with no desktop
   * the first session hangs for five minutes and dies. This section is the only
   * way that user ever sees the link.
   */
  describe("browser-free sign-in", () => {
    const h = m.headless
    const started = {
      alreadySignedIn: false,
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

    /** Gemini Enterprise resolves a license against gcp.project/location during
     *  sign-in, so starting one without them only burns an attempt. */
    it("cannot be started while the form is still missing a credential", () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-business" } })
      expect(screen.getByText(m.missingEnterpriseConfig)).toBeInTheDocument()
      expect(screen.getByRole("button", { name: h.start })).toBeDisabled()
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
        credentialPath: "/srv/gemini/antigravity-acp/acp_token.json",
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
      // The token is a portable file — worth naming so a second headless box
      // can be signed in with a copy instead of another round trip.
      expect(
        screen.getByText("/srv/gemini/antigravity-acp/acp_token.json")
      ).toBeInTheDocument()
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
        credentialPath: null,
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
        credentialPath: null,
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
        credentialPath: null,
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
     * A user who copied a token file across, or who signed in earlier, gets no
     * link at all — `authenticate` returns straight away. Without this the
     * healthiest possible state would look like a 90-second stall followed by
     * "Antigravity did not produce a sign-in link".
     */
    it("says so when the agent was already signed in", async () => {
      vi.mocked(acpAntigravityLoginStart).mockResolvedValue({
        alreadySignedIn: true,
        handle: null,
        authUrl: null,
        redirectUri: null,
        methodId: "oauth-personal",
        expiresInSecs: 300,
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: h.start }))

      expect(await screen.findByText(h.signedIn)).toBeInTheDocument()
      expect(screen.getByText(h.alreadySignedIn)).toBeInTheDocument()
      // No link, so nothing to paste back.
      expect(
        screen.queryByRole("button", { name: h.complete })
      ).not.toBeInTheDocument()
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
     * The backend builds the agent's environment from the DATABASE, so a
     * project typed but not saved is a project the sign-in will not see.
     * Allowing it would spend a whole Google consent round trip and only then
     * fail license resolution.
     */
    it("waits for a save before offering an Enterprise sign-in", () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-business" } })
      const project = screen.getByLabelText(m.gcpProjectLabel)
      const location = screen.getByLabelText(m.gcpLocationLabel)
      fireEvent.change(project, { target: { value: "acme" } })
      fireEvent.change(location, { target: { value: "eu" } })

      // The form is now complete, so its own warning is gone...
      expect(
        screen.queryByText(m.missingEnterpriseConfig)
      ).not.toBeInTheDocument()
      // ...but the stored row is not, and that is what signs in.
      expect(screen.getByText(h.saveFirst)).toBeInTheDocument()
      expect(screen.getByRole("button", { name: h.start })).toBeDisabled()
    })

    it("offers the sign-in once the row actually carries the config", () => {
      renderPanel({
        env: {
          AGY_AUTH_METHOD: "oauth-business",
          GOOGLE_CLOUD_PROJECT: "acme",
          GOOGLE_CLOUD_LOCATION: "eu",
        },
      })
      expect(screen.queryByText(h.saveFirst)).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: h.start })).toBeEnabled()
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
     * method from the database and rewrites `auth.type` back to it, scrubbing
     * this method's credentials on the way, so the user is returned to the
     * five-minute failure they came here to escape after being told they were
     * signed in.
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
      // Still offering to try again, not stuck in a spinner.
      expect(screen.getByRole("button", { name: h.start })).toBeEnabled()
    })
  })

  /**
   * The escape hatch from a wrong account.
   *
   * Antigravity refreshes its cached token by itself, so once a credential
   * exists `authenticate` returns with no link and the sign-in above can only
   * ever report `alreadySignedIn` — leaving the first Google account a user
   * picks as the last one they get, through uninstalls and reinstalls alike.
   */
  describe("sign-out", () => {
    const s = m.signOut
    const h = m.headless

    beforeEach(() => {
      vi.mocked(acpAntigravitySignOut).mockResolvedValue({
        path: "/home/u/.gemini/antigravity-acp/settings.json",
        status: "written",
        reason: null,
      })
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
     * The agent's `logout` removes `auth.type` on its way out and the backend
     * writes the saved method straight back. When that write is refused the
     * file now names NO method, and every later session fails outright with
     * "Authentication required" — so this is the one outcome the panel must not
     * report as a plain success.
     */
    it("warns when the settings file could not be rewritten afterwards", async () => {
      vi.mocked(acpAntigravitySignOut).mockResolvedValue({
        path: "/home/u/.gemini/antigravity-acp/settings.json",
        status: "skipped",
        reason:
          "it is not strict JSON codeg can rewrite without losing content",
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: s.action }))

      await waitFor(() => expect(toast.warning).toHaveBeenCalled())
      expect(toast.success).not.toHaveBeenCalled()
      // And it stays on screen, because it stays true until someone edits that
      // file — the same standing notice a refused save raises.
      expect(await screen.findByText(m.syncSkipped)).toBeInTheDocument()
      expect(
        screen.getByText(
          "it is not strict JSON codeg can rewrite without losing content"
        )
      ).toBeInTheDocument()
    })

    /**
     * A stored row missing its project or location gates the SIGN-IN, because
     * consenting without one only fails at license resolution. Signing out
     * needs none of it — and a half-configured row is exactly what a user
     * trying to leave the wrong account is likely to have.
     */
    it("stays available when the stored row cannot sign in", () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-business" } })
      expect(screen.getByRole("button", { name: h.start })).toBeDisabled()
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
      expect(screen.getByRole("button", { name: s.action })).toBeEnabled()
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
