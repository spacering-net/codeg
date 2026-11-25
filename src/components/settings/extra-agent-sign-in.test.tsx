import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ExtraAgentSignIn } from "./extra-agent-sign-in"
import { acpLoginExtraAgent } from "@/lib/api"
import { copyTextToClipboard } from "@/lib/utils"
import messages from "@/i18n/messages/en.json"

vi.mock("@/lib/api", () => ({ acpLoginExtraAgent: vi.fn() }))
vi.mock("@/lib/utils", async (original) => ({
  ...(await original<typeof import("@/lib/utils")>()),
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))

function panel() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ExtraAgentSignIn registryId="codex-work" family="Codex" />
    </NextIntlClientProvider>
  )
}

const reply = {
  family: "codex",
  isolatorKey: "CODEX_HOME",
  home: "/profiles/work",
  command: "export CODEX_HOME='/profiles/work' && codex login",
  launched: false,
}

beforeEach(() => vi.clearAllMocks())

describe("isolated account sign-in", () => {
  it("keeps a server login command visible and copies the exact command", async () => {
    vi.mocked(acpLoginExtraAgent).mockResolvedValue(reply)
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    const copy = await screen.findByRole("button", {
      name: "Copy login command",
    })
    expect(acpLoginExtraAgent).toHaveBeenCalledWith("codex-work")
    expect(screen.getByText(/export CODEX_HOME/)).toBeVisible()
    fireEvent.click(copy)
    await waitFor(() =>
      expect(copyTextToClipboard).toHaveBeenCalledWith(reply.command)
    )
  })

  it("does not offer a command when a desktop terminal opened", async () => {
    vi.mocked(acpLoginExtraAgent).mockResolvedValue({
      ...reply,
      launched: true,
    })
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(acpLoginExtraAgent).toHaveBeenCalledOnce())
    expect(
      screen.queryByRole("button", { name: "Copy login command" })
    ).not.toBeInTheDocument()
  })

  it("shows login errors and allows retry", async () => {
    vi.mocked(acpLoginExtraAgent).mockRejectedValueOnce(
      new Error("Account folder is missing")
    )
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Account folder is missing"
    )
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled()
    vi.mocked(acpLoginExtraAgent).mockResolvedValue(reply)
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await screen.findByRole("button", { name: "Copy login command" })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
