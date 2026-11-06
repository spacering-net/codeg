import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import jaMessages from "@/i18n/messages/ja.json"
import type { PersonalAgentSnapshot } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentGet: vi.fn(),
  personalAgentSetWorkdir: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("sonner", () => ({ toast: { message: vi.fn(), error: vi.fn() } }))

import { PersonalAgentWorkdirSettings } from "./personal-agent-workdir-settings"

const agent = {
  workdir: "/data/personal-agent",
  workdir_custom: false,
}

describe("the personal agent's working directory", () => {
  it("moves it with the UI's language, for the files of a directory made anew", async () => {
    api.personalAgentGet.mockResolvedValue({
      agent,
      status: { engine: "here" },
    } as unknown as PersonalAgentSnapshot)
    api.personalAgentSetWorkdir.mockResolvedValue({
      ...agent,
      workdir: "/work/pa",
      workdir_custom: true,
    })
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <PersonalAgentWorkdirSettings />
      </NextIntlClientProvider>
    )
    const input = await screen.findByRole("textbox")
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false))
    fireEvent.change(input, { target: { value: " /work/pa " } })
    fireEvent.click(screen.getByRole("button", { name: "移動" }))
    await waitFor(() =>
      expect(api.personalAgentSetWorkdir).toHaveBeenCalledWith("/work/pa", "ja")
    )
  })
})
