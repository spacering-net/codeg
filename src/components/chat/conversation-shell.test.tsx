import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ComponentProps } from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// The shell's own children are not under test: stand each in with a marker.
vi.mock("@/components/chat/chat-input", () => ({
  ChatInput: () => <div data-testid="composer" />,
}))
vi.mock("@/components/chat/chat-width-handles", () => ({
  ChatWidthHandles: () => <div data-testid="width-handles" />,
}))
vi.mock("@/components/chat/composer-status-strips", () => ({
  ComposerStatusStrips: () => null,
}))
vi.mock("@/components/chat/async-task-strip", () => ({
  AsyncTaskStrip: () => null,
}))
vi.mock("@/components/chat/remote-control-strip", () => ({
  RemoteControlStrip: (props: {
    remoteControl: { session_url: string | null }
    onTurnOff?: () => void
    canTurnOff: boolean
  }) => (
    <div
      data-testid="remote-control-strip"
      data-url={String(props.remoteControl.session_url)}
      data-can-turn-off={String(props.canTurnOff)}
      data-has-turn-off={String(props.onTurnOff !== undefined)}
    />
  ),
}))
vi.mock("@/components/chat/permission-dialog", async () => {
  const { useTranscriptRoot } =
    await import("@/components/ai-elements/markdown-local-image")
  return {
    PermissionDialog: function PermissionDialog() {
      const root = useTranscriptRoot()
      return <div data-testid="permission" data-root={String(root)} />
    },
  }
})
vi.mock("@/components/chat/question-dialog", () => ({
  QuestionDialog: () => null,
}))
vi.mock("@/components/chat/ask-question-card", () => ({
  AskQuestionCard: () => null,
}))
vi.mock("@/components/chat/plan-approval-card", async () => {
  const { useTranscriptRoot } =
    await import("@/components/ai-elements/markdown-local-image")
  return {
    PlanApprovalCard: function PlanApprovalCard() {
      const root = useTranscriptRoot()
      return <div data-testid="plan-approval" data-root={String(root)} />
    },
  }
})

import { ConversationShell } from "./conversation-shell"

type ShellProps = ComponentProps<typeof ConversationShell>

function renderShell(extra: Partial<ShellProps> = {}) {
  const noop = () => {}
  const props = {
    status: null,
    promptCapabilities: {},
    claudeApiRetry: null,
    pendingPermission: null,
    pendingQuestion: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    onFocus: noop,
    onSend: noop,
    onCancel: noop,
    onRespondPermission: noop,
    onAnswerQuestion: noop,
    onAnswerAskQuestion: noop,
    onAnswerPlanApproval: noop,
    ...extra,
  } as unknown as ShellProps
  return render(
    <ConversationShell {...props}>
      <div data-testid="transcript" />
    </ConversationShell>
  )
}

/** The shell's root: the transcript's host is its child. */
const shellRoot = () =>
  screen.getByTestId("transcript").parentElement!.parentElement!

describe("ConversationShell chat-width handles", () => {
  it("has neither handles nor a gutter by default (canvas cards)", () => {
    renderShell()
    expect(screen.queryByTestId("width-handles")).toBeNull()
    expect(shellRoot().style.getPropertyValue("--chat-gutter")).toBe("")
  })

  it("adds the handles and the window-edge gutter when resizable", () => {
    renderShell({ resizableWidth: true })
    expect(screen.getByTestId("width-handles")).toBeInTheDocument()
    // Mounted beside the transcript, in a positioned host spanning it.
    const host = screen.getByTestId("transcript").parentElement!
    expect(host).toContainElement(screen.getByTestId("width-handles"))
    expect(host).toHaveClass("relative")
    expect(shellRoot().style.getPropertyValue("--chat-gutter")).toBe("12px")
  })
})

describe("who turns the handles on", () => {
  const read = (path: string) =>
    readFileSync(resolve(process.cwd(), path), "utf8")

  it("is the conversation tab, not the zoomable canvas card", () => {
    // Canvas cards render the shell under the board's scale transform, where
    // the handles' pointer maths would be off by the zoom factor.
    // Boolean shorthand only: `resizableWidth={false}` must not pass.
    expect(
      read("src/components/conversations/conversation-detail-panel.tsx")
    ).toMatch(/<ConversationShell\s+resizableWidth\s/)
    expect(
      read("src/components/canvas/canvas-conversation-surface.tsx")
    ).not.toContain("resizableWidth")
  })
})

describe("ConversationShell Remote Control strip", () => {
  it("shows Claude Code's Remote Control while it is on", () => {
    renderShell()
    expect(screen.queryByTestId("remote-control-strip")).toBeNull()

    renderShell({
      status: "connected",
      remoteControl: { session_url: "https://claude.ai/code/session_01" },
      onRemoteControlOff: () => {},
    })
    const strip = screen.getByTestId("remote-control-strip")
    expect(strip).toHaveAttribute(
      "data-url",
      "https://claude.ai/code/session_01"
    )
    expect(strip).toHaveAttribute("data-has-turn-off", "true")
    expect(strip).toHaveAttribute("data-can-turn-off", "true")
  })

  it("lets it be turned off only between turns", () => {
    // The adapter refuses `/remote-control off` while Claude is working.
    renderShell({
      status: "prompting",
      remoteControl: { session_url: null },
      onRemoteControlOff: () => {},
    })
    expect(screen.getByTestId("remote-control-strip")).toHaveAttribute(
      "data-can-turn-off",
      "false"
    )
  })
})

describe("ConversationShell cards below the transcript", () => {
  it("resolve local images against the conversation's folder", () => {
    // Outside the transcript's own image scope, but the same agent wrote
    // them: a plan or a permission request names images as a reply does.
    renderShell({
      defaultPath: "/repo",
      pendingPlanApproval: { approval_id: "a1" } as never,
    })
    expect(screen.getByTestId("permission")).toHaveAttribute(
      "data-root",
      "/repo"
    )
    expect(screen.getByTestId("plan-approval")).toHaveAttribute(
      "data-root",
      "/repo"
    )
  })
})
