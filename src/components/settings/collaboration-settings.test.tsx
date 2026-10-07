import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getDelegationSettings: vi.fn(async () => ({
    enabled: false,
    depth_limit: 1,
    completed_cache_max_mb: 512,
    agent_defaults: {},
  })),
  setDelegationSettings: vi.fn(async (v: unknown) => v),
  acpListAgents: vi.fn(async () => []),
  getFeedbackSettings: vi.fn(async () => ({ enabled: false })),
  setFeedbackSettings: vi.fn(async (v: unknown) => v),
  getQuestionSettings: vi.fn(async () => ({ enabled: true })),
  setQuestionSettings: vi.fn(async (v: unknown) => v),
  getSessionInfoSettings: vi.fn(async () => ({ enabled: true })),
  setSessionInfoSettings: vi.fn(async (v: unknown) => v),
  getBrowserToolsSettings: vi.fn(async () => ({ enabled: false })),
  setBrowserToolsSettings: vi.fn(async (v: unknown) => v),
  getChatAuthoringSettings: vi.fn(async () => ({
    automations_enabled: false,
    work_tasks_enabled: false,
  })),
  setChatAuthoringSettings: vi.fn(async (v: unknown) => v),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// Both panels subscribe to their settings-change broadcasts so a form left
// open converges instead of reverting a write made elsewhere (the status-bar
// codeg-mcp popover).
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  subscribe: () => Promise.resolve(() => {}),
}))
vi.mock("@/hooks/use-feedback-enabled", () => ({
  primeFeedbackEnabled: vi.fn(),
}))

import { CollaborationSettings } from "./collaboration-settings"
import enMessages from "@/i18n/messages/en.json"

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CollaborationSettings />
    </NextIntlClientProvider>
  )
}

/**
 * The page is the two panels that decide how far an agent reaches out of its
 * own conversation, split off `/settings/general`. What is worth pinning is
 * that both still mount here and that every row's label resolves to the
 * control it names — a `SettingRow` with `htmlFor` left off still looks right
 * and silently loses the association.
 */
describe("CollaborationSettings", () => {
  it("mounts both panels and wires each row's label to its control", async () => {
    renderSettings()

    for (const heading of [
      "Multi-Agent Collaboration",
      "In-conversation tools",
    ]) {
      expect(
        await screen.findByRole("heading", { name: heading })
      ).toBeInTheDocument()
    }

    expect(screen.getByLabelText("Enable delegation")).toBeInTheDocument()
    expect(screen.getByLabelText("Live Feedback")).toBeInTheDocument()
    expect(screen.getByLabelText("Ask user question")).toBeInTheDocument()
    expect(screen.getByLabelText("Get session info")).toBeInTheDocument()
    expect(screen.getByLabelText("Create automations")).toBeInTheDocument()
    expect(screen.getByLabelText("Create to-do tasks")).toBeInTheDocument()
  })
})
