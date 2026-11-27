import { act, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"

import { SessionReplyPrompts } from "./session-reply-prompts"

const mocks = vi.hoisted(() => ({
  pending: vi.fn(),
  subscribe: vi.fn(),
  reconnect: vi.fn(),
  openTab: vi.fn(),
}))

vi.mock("@/lib/api", () => ({ acpPendingSessionReplyPrompts: mocks.pending }))
vi.mock("@/lib/platform", () => ({
  subscribe: mocks.subscribe,
  onTransportReconnect: mocks.reconnect,
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: mocks.openTab }),
}))

let invalidate: (id: number) => void
let reconnect: () => void

beforeEach(() => {
  vi.resetAllMocks()
  mocks.pending.mockResolvedValue([])
  mocks.subscribe.mockImplementation(async (_event, handler) => {
    invalidate = handler
    return () => {}
  })
  mocks.reconnect.mockImplementation((handler) => {
    reconnect = handler
    return () => {}
  })
})

function renderSender() {
  return render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{
        Folder: {
          sidebar: {
            statusAwaiting: {
              permission: "Needs your permission",
              question: "Needs your answer",
              plan: "Needs your approval",
            },
          },
        },
      }}
    >
      <SessionReplyPrompts conversationId={11} />
    </NextIntlClientProvider>
  )
}

const permission = {
  conversation_id: 12,
  folder_id: 5,
  agent_type: "claude_code",
  title: "Verify the signatures",
  request_id: "permission-1",
  kind: "permission",
}

it("shows a blocked collaborator once, opens that session, and clears after an answer", async () => {
  renderSender()
  await waitFor(() => expect(mocks.pending).toHaveBeenCalledWith(11))
  expect(screen.queryByRole("button")).toBeNull()

  mocks.pending.mockResolvedValue([permission])
  await act(async () => {
    invalidate(12)
    invalidate(12)
  })

  const button = screen.getByRole("button", {
    name: "Verify the signatures Needs your permission",
  })
  button.click()
  expect(mocks.openTab).toHaveBeenCalledWith(
    5,
    12,
    "claude_code",
    true,
    "Verify the signatures"
  )

  mocks.pending.mockResolvedValue([])
  await act(async () => invalidate(12))
  expect(screen.queryByRole("button")).toBeNull()
})

it("restores a pending question on reconnect and discards an older response", async () => {
  let finishOldRequest: (value: (typeof permission)[]) => void = () => {}
  mocks.pending.mockReturnValueOnce(
    new Promise<(typeof permission)[]>((resolve) => {
      finishOldRequest = resolve
    })
  )
  renderSender()
  await waitFor(() => expect(mocks.pending).toHaveBeenCalledWith(11))

  mocks.pending.mockResolvedValue([
    { ...permission, request_id: "question-1", kind: "question" },
  ])
  await act(async () => reconnect())
  await act(async () => finishOldRequest([]))
  expect(
    screen.getByRole("button", {
      name: "Verify the signatures Needs your answer",
    })
  ).toBeInTheDocument()
})
