import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { DbConversationSummary } from "@/lib/types"

const api = vi.hoisted(() => ({
  list: vi.fn(async () => [] as DbConversationSummary[]),
  set: vi.fn(async () => {}),
}))
vi.mock("@/lib/api", () => ({
  listConversationCollaborators: api.list,
  setConversationCollaborator: api.set,
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))

const digestState = vi.hoisted(() => ({
  digest: {
    revision: 1,
    updatedAt: "2026-11-24T08:00:00Z",
    now: ["Migrating the server"],
    news: [],
    needsYou: [
      {
        id: "q",
        question: "Pick a schema",
        options: ["A", "B"],
        recommended: "A",
      },
    ],
    suggestions: [],
    answers: {},
    dismissedSuggestions: [],
  },
  brief: { text: "Own the server migration.", updatedAt: null },
}))
const actions = vi.hoisted(() => ({
  answer: vi.fn(async () => {}),
  dismiss: vi.fn(async () => {}),
}))
vi.mock("@/hooks/use-session-digest", () => ({
  useSessionDigest: () => ({
    digest: digestState.digest,
    refresh: async () => {},
  }),
  useDigestActions: () => ({
    answer: actions.answer,
    dismiss: actions.dismiss,
    canAnswer: true,
  }),
  useSessionBrief: () => digestState.brief,
}))

const openTab = vi.fn()
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab }),
}))
const related: DbConversationSummary = {
  id: 8,
  folder_id: 3,
  title: "Migration notes",
  agent_type: "claude",
  status: "in_progress",
  parent_id: null,
} as DbConversationSummary
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (
    sel: (s: { conversations: DbConversationSummary[] }) => unknown
  ) => sel({ conversations: [related] }),
}))

import { SessionCollaborators } from "./session-collaborators"

function show() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionCollaborators conversationId={5} />
    </NextIntlClientProvider>
  )
}

describe("SessionCollaborators progress entry", () => {
  it("shows the digest with clickable answers and the brief under one header", async () => {
    api.list.mockResolvedValueOnce([related])
    show()
    expect(screen.getByText("Migrating the server")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /^A/ }))
    await waitFor(() => expect(actions.answer).toHaveBeenCalledWith("q", "A"))
    expect(screen.getByText("Own the server migration.")).toBeInTheDocument()
  })

  it("jumps to a collaboration session tab", async () => {
    api.list.mockResolvedValueOnce([related])
    show()
    await screen.findByText("Migration notes")
    fireEvent.click(screen.getByRole("button", { name: /Migration notes/ }))
    expect(openTab).toHaveBeenCalledWith(
      3,
      8,
      "claude",
      true,
      "Migration notes"
    )
  })

  it("hides the brief block when nothing was written", async () => {
    digestState.brief = { text: "", updatedAt: null }
    api.list.mockResolvedValueOnce([])
    show()
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(
      screen.queryByText("Own the server migration.")
    ).not.toBeInTheDocument()
    digestState.brief = { text: "Own the server migration.", updatedAt: null }
  })
})
