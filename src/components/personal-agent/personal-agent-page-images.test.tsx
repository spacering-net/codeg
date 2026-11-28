import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6TAAAAABJRU5ErkJggg=="

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readWorkspace: vi.fn(),
  markdown: "",
}))

// #1347: the assistant's reply on its own page, drawn by the real Markdown
// pipeline — only the page's heavier parts are stood in for.
vi.mock("@/lib/api", () => {
  const calls = new Map<string, unknown>()
  return new Proxy(
    {},
    {
      has: () => true,
      get: (_, name) => {
        if (name === "readFileBase64") return mocks.readFile
        if (name === "readWorkspaceFileBase64") return mocks.readWorkspace
        if (typeof name !== "string" || name === "then") return undefined
        if (!calls.has(name))
          calls.set(
            name,
            vi.fn(() => new Promise(() => {}))
          )
        return calls.get(name)
      },
    }
  )
})
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
  parseLocalFileTarget: () => null,
}))
vi.mock("@/components/message/image-actions", () => ({
  ImageActions: ({ children }: { children: React.ReactNode }) => children,
  useImageActions: () => ({ canCopy: false, copy: vi.fn(), download: vi.fn() }),
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  usePersonalAgent: () => ({
    botId: 1,
    loading: false,
    rows: [],
    snapshot: {
      agent: {
        id: 1,
        kind: "worker",
        name: "Nova",
        avatar: { kind: "face", shape: "ring", color: "black" },
        agent_type: "claude_code",
        work: null,
        workdir: "/pa/nova",
      },
      status: {
        engine: "here",
        segment: null,
        connection_id: null,
        live_reply: null,
      },
    },
  }),
  usePersonalAgentSwitch: () => ({ switching: false, to: null }),
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: [] }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }))
vi.mock("./message-list", async () => {
  const { MessageResponse } = await import("@/components/ai-elements/message")
  return {
    MessageList: () => <MessageResponse>{mocks.markdown}</MessageResponse>,
  }
})
const { nothing } = vi.hoisted(() => ({ nothing: () => null }))
vi.mock("./aux-panel", () => ({ PersonalAgentAuxPanel: nothing }))
vi.mock("./roster", () => ({
  PersonalAgentRoster: nothing,
  useRosterDialogs: () => ({}),
  useRosterUpkeep: () => {},
}))
vi.mock("./composer", () => ({ PersonalAgentComposer: nothing }))
vi.mock("./live-turn", () => ({ usePersonalAgentAttachment: () => {} }))
vi.mock("./activity-return-bar", () => ({ ActivityReturnBar: nothing }))
vi.mock("./history-search", () => ({
  HistorySearchButton: nothing,
  PersonalAgentHistorySearch: nothing,
}))
vi.mock("./settings/bot-page", () => ({ BotPage: nothing }))
vi.mock("./settings/identity-page", () => ({ IdentityPage: nothing }))
vi.mock("./settings/settings-view", () => ({ SettingsView: nothing }))
vi.mock("./work-drawer", () => ({ PersonalAgentWorkDrawer: nothing }))
vi.mock("./routine-editor", () => ({ RoutineEditor: nothing }))
vi.mock("./status-line", () => ({ StatusLine: nothing }))
vi.mock("./use-assistant-shortcuts", () => ({
  useAssistantShortcuts: () => {},
}))
vi.mock("./session-link", () => ({ useSessionLinkOpener: () => () => {} }))
vi.mock("./answer-bar", () => ({ useAnswerStanding: () => "unknown" }))
vi.mock("./chrome-actions", () => ({ PersonalAgentChromeActions: nothing }))
vi.mock("@/components/message/live-transcript-view", () => ({
  LiveTranscriptView: nothing,
}))
vi.mock("@/components/workbench/workbench-page-title", () => ({
  WorkbenchPageTitle: nothing,
}))

import { PersonalAgentPage } from "./personal-agent-page"

beforeEach(() => {
  mocks.readFile.mockReset().mockResolvedValue(PNG)
  mocks.readWorkspace.mockReset().mockResolvedValue(PNG)
})

describe("local images in an assistant's conversation (#1347)", () => {
  it("loads an absolute path where it is", async () => {
    mocks.markdown = "![shot](F:/shots/login.png)"
    render(<PersonalAgentPage />)
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "shot" })).toHaveAttribute(
        "src",
        `data:image/png;base64,${PNG}`
      )
    )
    expect(mocks.readFile).toHaveBeenCalledWith(
      "F:/shots/login.png",
      expect.any(Number)
    )
  })

  it("reads a relative path in the assistant's working directory", async () => {
    mocks.markdown = "![chart](out/chart.png)"
    render(<PersonalAgentPage />)
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "chart" })).toHaveAttribute(
        "src",
        `data:image/png;base64,${PNG}`
      )
    )
    expect(mocks.readWorkspace).toHaveBeenCalledWith(
      "/pa/nova",
      "out/chart.png",
      expect.any(Number)
    )
  })
})
