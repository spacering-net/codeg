import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import {
  SessionDigestPanel,
  SessionDigestOverlay,
  SessionDigestSummary,
} from "./session-digest-panel"

const actions = vi.hoisted(() => ({
  action: vi.fn(),
  refresh: vi.fn(async () => {}),
}))
vi.mock("@/lib/api", () => ({ sessionDigestAction: actions.action }))
vi.mock("@/hooks/use-session-digest", () => ({
  useSessionDigest: () => ({ digest, refresh: actions.refresh }),
}))

const digest = {
  revision: 1,
  updatedAt: "2026-11-24T08:00:00Z",
  now: ["Implementing the editor"],
  news: ["Database ready"],
  needsYou: [
    {
      id: "q",
      question: "Choose a mode",
      options: ["Fast", "Careful"],
      recommended: "Careful",
    },
  ],
  suggestions: [{ id: "s", title: "Run the tests" }],
  answers: {},
  dismissedSuggestions: [],
}

function show(props = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionDigestPanel
        digest={digest}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

describe("SessionDigestPanel", () => {
  it("shows all sections, the original recommended option and update time", () => {
    show()
    expect(screen.getByText("Implementing the editor")).toBeInTheDocument()
    expect(screen.getByText("Database ready")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Careful/ })).toBeInTheDocument()
    expect(screen.getByText("Run the tests")).toBeInTheDocument()
    expect(document.querySelector("time")?.dateTime).toBe(digest.updatedAt)
  })

  it("prevents duplicate answers while a send is pending", async () => {
    let finish!: () => void
    const onAnswer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    show({ onAnswer })
    const button = screen.getByRole("button", { name: "Fast" })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("q", "Fast")
    finish()
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it("shows a send failure and allows the answer to be retried", async () => {
    const onAnswer = vi
      .fn()
      .mockRejectedValueOnce(new Error("Send failed"))
      .mockResolvedValue(undefined)
    show({ onAnswer })
    fireEvent.click(screen.getByRole("button", { name: "Fast" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Send failed")
    fireEvent.click(screen.getByRole("button", { name: "Fast" }))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2))
  })

  it("dismisses a suggestion by its original title", async () => {
    const onDismiss = vi.fn().mockResolvedValue(undefined)
    show({ onDismiss })
    fireEvent.click(
      screen.getByRole("button", { name: /Dismiss Run the tests/ })
    )
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith("Run the tests"))
  })
})

describe("SessionDigestOverlay answers", () => {
  function overlay(
    onSendAnswer: (text: string, token: string) => Promise<boolean>
  ) {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SessionDigestOverlay
          conversationId={42}
          disabled={false}
          onSendAnswer={onSendAnswer}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Session summary" }))
  }
  it("releases a reserved answer when the ordinary user-message send fails", async () => {
    actions.action
      .mockReset()
      .mockImplementation(async (_id, action) =>
        action.operation === "reserve"
          ? { token: "digest-answer-token", text: "Choose a mode\nFast" }
          : null
      )
    const send = vi.fn().mockResolvedValue(false)
    overlay(send)
    fireEvent.click(screen.getByRole("button", { name: "Fast" }))
    await waitFor(() =>
      expect(actions.action).toHaveBeenCalledWith(42, {
        operation: "release",
        token: "digest-answer-token",
      })
    )
    expect(send).toHaveBeenCalledWith(
      "Choose a mode\nFast",
      "digest-answer-token"
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Answer could not be sent"
    )
  })
  it("does not send when the server rejects a stale question", async () => {
    actions.action
      .mockReset()
      .mockRejectedValue(new Error("Question is no longer current"))
    const send = vi.fn()
    overlay(send)
    fireEvent.click(screen.getByRole("button", { name: "Fast" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Question is no longer current"
    )
    expect(send).not.toHaveBeenCalled()
  })
  it("shows pending questions and the current work in the title summary", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SessionDigestSummary conversationId={42} />
      </NextIntlClientProvider>
    )
    expect(screen.getByText(/1 awaiting answer/)).toHaveTextContent(
      "Implementing the editor"
    )
  })
})
