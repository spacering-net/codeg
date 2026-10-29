import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PiProjectTrustState } from "@/lib/api"
import type { AgentType } from "@/lib/types"

const mockConnection = vi.hoisted(() => ({
  value: {
    status: "connected" as string | null,
    isViewer: false,
    isDelegationChild: false,
    reapplyConfig: vi.fn(async () => true),
    connect: vi.fn(async () => undefined),
  },
}))

const api = vi.hoisted(() => ({
  acpPiProjectTrustState: vi.fn(),
  acpPiSetProjectTrust: vi.fn(async () => undefined),
  acpPiAcknowledgeProjectTrust: vi.fn(async () => undefined),
}))

vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => mockConnection.value,
}))

vi.mock("@/lib/api", () => ({
  acpPiProjectTrustState: api.acpPiProjectTrustState,
  acpPiSetProjectTrust: api.acpPiSetProjectTrust,
  acpPiAcknowledgeProjectTrust: api.acpPiAcknowledgeProjectTrust,
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { PiProjectTrustBanner } from "./pi-project-trust-banner"

/** A repo shipping `.pi/extensions` with nobody having decided yet. */
function undecidedWithExtension(): PiProjectTrustState {
  return {
    workspace: "/repo",
    resources: [
      {
        path: "/repo/.pi/extensions/marker.js",
        kind: ".pi/extensions",
        executesCode: true,
      },
    ],
    decision: null,
    decidedAt: null,
    trustFile: "/home/u/.pi/agent/trust.json",
    acknowledged: false,
  }
}

/** The upgrade case: a grant already in force that nobody here confirmed. */
function inheritedGrant(): PiProjectTrustState {
  return {
    ...undecidedWithExtension(),
    decision: true,
    decidedAt: "/",
    acknowledged: false,
  }
}

function banner(agentType: AgentType | null = "pi", workingDir = "/repo") {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PiProjectTrustBanner
        contextKey="tab-1"
        agentType={agentType}
        workingDir={workingDir}
      />
    </NextIntlClientProvider>
  )
}

function renderBanner(
  agentType: AgentType | null = "pi",
  workingDir = "/repo"
) {
  return render(banner(agentType, workingDir))
}

const copy = enMessages.Folder.chat.piProjectTrust

describe("PiProjectTrustBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnection.value = {
      status: "connected",
      isViewer: false,
      isDelegationChild: false,
      reapplyConfig: vi.fn(async () => true),
      connect: vi.fn(async () => undefined),
    }
    api.acpPiProjectTrustState.mockResolvedValue(undecidedWithExtension())
  })

  it("prompts when the repo ships trust-gated resources and nobody has decided", async () => {
    renderBanner()

    expect(
      await screen.findByText(copy.descriptionExecutable)
    ).toBeInTheDocument()
  })

  it("saves and reconnects with the selected native account and saved session", async () => {
    const user = userEvent.setup()
    mockConnection.value.status = null
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PiProjectTrustBanner
          contextKey="tab-1"
          agentType="pi"
          workingDir="/repo"
          agentAccountId="account-work"
          conversationId={41}
          sessionId="saved-session"
        />
      </NextIntlClientProvider>
    )
    await user.click(await screen.findByRole("button", { name: copy.review }))
    await user.click(await screen.findByRole("button", { name: copy.trust }))
    await waitFor(() =>
      expect(api.acpPiSetProjectTrust).toHaveBeenCalledWith(
        "/repo",
        true,
        "account-work"
      )
    )
    expect(api.acpPiProjectTrustState).toHaveBeenCalledWith(
      "/repo",
      "account-work"
    )
    expect(mockConnection.value.connect).toHaveBeenCalledWith(
      "pi",
      "/repo",
      "saved-session",
      41,
      "account-work"
    )
  })

  it("stays silent when the repo ships no trust-gated resources", async () => {
    api.acpPiProjectTrustState.mockResolvedValue({
      ...undecidedWithExtension(),
      resources: [],
    })
    renderBanner()

    await waitFor(() => expect(api.acpPiProjectTrustState).toHaveBeenCalled())
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument()
  })

  it("stays silent when the project was declined", async () => {
    api.acpPiProjectTrustState.mockResolvedValue({
      ...undecidedWithExtension(),
      decision: false,
      decidedAt: "/repo",
    })
    renderBanner()

    await waitFor(() => expect(api.acpPiProjectTrustState).toHaveBeenCalled())
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument()
  })

  // Removing the auto-seeding doesn't undo what it already wrote. A grant still
  // in force — especially one inherited from a parent an older build seeded,
  // which covers repos cloned into it afterwards — has to be disclosed, or the
  // upgrade silently leaves the user exposed.
  it("discloses an existing grant the user has not acknowledged", async () => {
    api.acpPiProjectTrustState.mockResolvedValue(inheritedGrant())
    renderBanner()

    expect(
      await screen.findByText(copy.grantInheritedDescription)
    ).toBeInTheDocument()
  })

  it("stops disclosing a grant once acknowledged", async () => {
    api.acpPiProjectTrustState.mockResolvedValue({
      ...inheritedGrant(),
      acknowledged: true,
    })
    renderBanner()

    await waitFor(() => expect(api.acpPiProjectTrustState).toHaveBeenCalled())
    expect(screen.queryByText(copy.grantTitle)).not.toBeInTheDocument()
  })

  // The launch gate blocks pi while an unacknowledged grant stands, so the
  // notice must be reachable with no connection — that is the whole point.
  it("still surfaces the disclosure while disconnected", async () => {
    mockConnection.value = { ...mockConnection.value, status: "disconnected" }
    api.acpPiProjectTrustState.mockResolvedValue(inheritedGrant())
    renderBanner()

    expect(
      await screen.findByText(copy.grantInheritedDescription)
    ).toBeInTheDocument()
  })

  // Viewers don't own the backend process, so neither the decision nor the
  // restart that applies it is theirs to make.
  it("stays silent for viewers", async () => {
    mockConnection.value = { ...mockConnection.value, isViewer: true }
    renderBanner()

    await waitFor(() =>
      expect(api.acpPiProjectTrustState).not.toHaveBeenCalled()
    )
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument()
  })

  it("stays silent for non-pi agents", async () => {
    renderBanner("claude_code")

    await waitFor(() =>
      expect(api.acpPiProjectTrustState).not.toHaveBeenCalled()
    )
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument()
  })

  // A probe issued for workspace A can land after the tab switched to B. Without
  // a generation guard it repopulates state, so the banner would show A's files
  // for B — and answering it would write the decision to A.
  it("ignores a trust-state response that arrives after the workspace changed", async () => {
    let resolveA: (value: PiProjectTrustState) => void = () => {}
    api.acpPiProjectTrustState.mockImplementationOnce(
      () =>
        new Promise<PiProjectTrustState>((resolve) => {
          resolveA = resolve
        })
    )
    const { rerender } = renderBanner()

    api.acpPiProjectTrustState.mockResolvedValue({
      ...undecidedWithExtension(),
      workspace: "/other",
      resources: [],
    })
    rerender(banner("pi", "/other"))
    resolveA(undecidedWithExtension())

    await waitFor(() =>
      expect(api.acpPiProjectTrustState).toHaveBeenCalledWith(
        "/other",
        undefined
      )
    )
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument()
  })

  it("stops acting on a probe once the tab moves to another workspace", async () => {
    const { rerender } = renderBanner()
    expect(
      await screen.findByText(copy.descriptionExecutable)
    ).toBeInTheDocument()

    api.acpPiProjectTrustState.mockResolvedValue({
      ...undecidedWithExtension(),
      workspace: "/elsewhere",
      resources: [],
    })
    rerender(banner("pi", "/elsewhere"))

    await waitFor(() =>
      expect(
        screen.queryByText(copy.descriptionExecutable)
      ).not.toBeInTheDocument()
    )
    expect(api.acpPiSetProjectTrust).not.toHaveBeenCalled()
  })

  // Trust is resolved once at pi startup, so recording it is only half the job —
  // the running process must restart or it keeps ignoring the resources.
  it("records the decision and restarts pi when the user trusts the project", async () => {
    const user = userEvent.setup()
    renderBanner()

    await user.click(await screen.findByRole("button", { name: copy.review }))
    await user.click(await screen.findByRole("button", { name: copy.trust }))

    await waitFor(() =>
      expect(api.acpPiSetProjectTrust).toHaveBeenCalledWith(
        "/repo",
        true,
        undefined
      )
    )
    expect(mockConnection.value.reapplyConfig).toHaveBeenCalled()
  })

  // Declining is a real answer that must be recorded as `false`, not merely a
  // "write nothing" — otherwise the prompt returns on every reconnect.
  it("records a decline without restarting pi", async () => {
    const user = userEvent.setup()
    renderBanner()

    await user.click(await screen.findByRole("button", { name: copy.review }))
    await user.click(await screen.findByRole("button", { name: copy.decline }))

    await waitFor(() =>
      expect(api.acpPiSetProjectTrust).toHaveBeenCalledWith(
        "/repo",
        false,
        undefined
      )
    )
    expect(mockConnection.value.reapplyConfig).not.toHaveBeenCalled()
  })

  // Revoking has to restart pi too: the running process already loaded the
  // repository's resources, and writing the decision alone would not unload them.
  it("revokes an existing grant and restarts pi", async () => {
    api.acpPiProjectTrustState.mockResolvedValue(inheritedGrant())
    const user = userEvent.setup()
    renderBanner()

    await user.click(await screen.findByRole("button", { name: copy.review }))
    await user.click(await screen.findByRole("button", { name: copy.revoke }))

    await waitFor(() =>
      expect(api.acpPiSetProjectTrust).toHaveBeenCalledWith(
        "/repo",
        null,
        undefined
      )
    )
    expect(mockConnection.value.reapplyConfig).toHaveBeenCalled()
  })

  it("keeping a grant acknowledges it without touching pi's trust store", async () => {
    api.acpPiProjectTrustState.mockResolvedValue(inheritedGrant())
    const user = userEvent.setup()
    renderBanner()

    await user.click(await screen.findByRole("button", { name: copy.review }))
    await user.click(
      await screen.findByRole("button", { name: copy.keepTrusted })
    )

    await waitFor(() =>
      expect(api.acpPiAcknowledgeProjectTrust).toHaveBeenCalledWith(
        "/repo",
        undefined
      )
    )
    expect(api.acpPiSetProjectTrust).not.toHaveBeenCalled()
  })

  // Acknowledging is what releases the launch gate, so it has to start the pi
  // the gate refused — otherwise the user answers and nothing happens.
  it("starts pi after resolving a gate that blocked the launch", async () => {
    mockConnection.value = { ...mockConnection.value, status: "disconnected" }
    api.acpPiProjectTrustState.mockResolvedValue(inheritedGrant())
    const user = userEvent.setup()
    renderBanner()

    await user.click(await screen.findByRole("button", { name: copy.review }))
    await user.click(
      await screen.findByRole("button", { name: copy.keepTrusted })
    )

    await waitFor(() =>
      expect(mockConnection.value.connect).toHaveBeenCalledWith(
        "pi",
        "/repo",
        undefined,
        undefined,
        undefined
      )
    )
    expect(mockConnection.value.reapplyConfig).not.toHaveBeenCalled()
  })
})
