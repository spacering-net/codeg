/**
 * The invariant the host exists for: a "查看会话" drawer must outlive the card
 * that opened it.
 *
 * The cards live in virtua's rows, so scrolling far enough unmounts them. When
 * each card owned its own `open` state and rendered its own drawer, that
 * unmount closed the viewer out from under the user mid-read. These tests
 * unmount the opener directly — the same thing virtualization does, without
 * having to drive a scroll container in jsdom.
 */
import { act, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { SessionViewerHost, useSessionViewerHost } from "./session-viewer-host"

// Both viewers reach the runtime provider tree / the conversation API. Stub
// them to sentinels that report what they were pointed at — this file is about
// ownership and lifetime, not about what a transcript renders.
vi.mock("./sub-agent-session-dialog", () => ({
  SubAgentSessionDialog: ({
    open,
    childConversationId,
  }: {
    open: boolean
    childConversationId: number
  }) =>
    open ? (
      <div
        data-testid="delegation-viewer"
        data-conversation-id={childConversationId}
      />
    ) : null,
}))
vi.mock("./subagent-session-dialog", () => ({
  SubagentSessionDialog: ({
    open,
    sessionId,
    live,
  }: {
    open: boolean
    sessionId: string
    live: boolean
  }) =>
    open ? (
      <div
        data-testid="agent-session-viewer"
        data-session-id={sessionId}
        data-live={String(live)}
      />
    ) : null,
}))

// The file viewer reads the workspace file-tab store. Stub the BODY but keep a
// real `Drawer` around it: a plain `<div>` sentinel would still "open", so a
// stacking assertion against it would pass even if the panel were rendered as a
// sibling of the transcript's drawer instead of inside it — the exact
// regression the host placement exists to prevent.
vi.mock("@/components/files/file-viewer-drawer", () => ({
  FileViewerDrawer: ({
    open,
    request,
  }: {
    open: boolean
    request: { path: string; line: number | null }
  }) => (
    <Drawer open={open} swipeDirection="right">
      <DrawerContent>
        <DrawerTitle>
          <span data-testid="file-viewer" data-path={request.path}>
            {request.path}
            {request.line ? `:${request.line}` : ""}
          </span>
        </DrawerTitle>
      </DrawerContent>
    </Drawer>
  ),
}))

// The delegation branch re-derives its model from the raw source; drive that
// resolution directly rather than booting the connection/binding stores.
vi.mock("@/hooks/use-delegation-card-model", () => ({
  useDelegationCardModel: (source: { parentToolUseId: string }) => ({
    agentType: "codex",
    task: "do the thing",
    taskId: null,
    status: "running",
    errorCode: undefined,
    // Derived from the source, so the assertion below proves the viewer is
    // still resolving from it after the opener is gone.
    childConversationId: Number(source.parentToolUseId.replace("tool-", "")),
    childConnectionId: "child-1",
    hasModel: true,
  }),
}))

/** A stand-in for a delegation card: opens the viewer, then can be unmounted
 *  the way virtua unmounts a row that scrolled out of the buffer. */
function OpenerCard({ toolUseId }: { toolUseId: string }) {
  const host = useSessionViewerHost()
  return (
    <button
      type="button"
      onClick={() =>
        host?.open({
          kind: "delegation",
          source: { parentToolUseId: toolUseId },
        })
      }
    >
      open {toolUseId}
    </button>
  )
}

/** A stand-in for a file badge in a tool card. */
function FileOpener() {
  const host = useSessionViewerHost()
  return (
    <button
      type="button"
      onClick={() =>
        host?.open({ kind: "file", path: "/repo/docs/plan.md", line: 12 })
      }
    >
      open file
    </button>
  )
}

function Harness({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(true)
  return (
    <SessionViewerHost>
      <button type="button" onClick={() => setMounted(false)}>
        scroll away
      </button>
      {mounted ? children : null}
    </SessionViewerHost>
  )
}

describe("SessionViewerHost", () => {
  it("keeps the viewer open after the card that opened it unmounts", () => {
    render(
      <Harness>
        <OpenerCard toolUseId="tool-42" />
      </Harness>
    )

    act(() => {
      screen.getByText("open tool-42").click()
    })
    expect(screen.getByTestId("delegation-viewer")).toHaveAttribute(
      "data-conversation-id",
      "42"
    )

    // Virtualization, simulated: the row goes away.
    act(() => {
      screen.getByText("scroll away").click()
    })

    expect(screen.queryByText("open tool-42")).not.toBeInTheDocument()
    // Still open, and still resolving from the source it was handed.
    expect(screen.getByTestId("delegation-viewer")).toHaveAttribute(
      "data-conversation-id",
      "42"
    )
  })

  it("hosts the standalone agent-session viewer too", () => {
    function GrokOpener() {
      const host = useSessionViewerHost()
      return (
        <button
          type="button"
          onClick={() =>
            host?.open({
              kind: "agentSession",
              sessionId: "sess-7",
              agentType: "grok",
              live: true,
            })
          }
        >
          open grok
        </button>
      )
    }

    render(
      <Harness>
        <GrokOpener />
      </Harness>
    )
    act(() => {
      screen.getByText("open grok").click()
    })
    act(() => {
      screen.getByText("scroll away").click()
    })

    const viewer = screen.getByTestId("agent-session-viewer")
    expect(viewer).toHaveAttribute("data-session-id", "sess-7")
    expect(viewer).toHaveAttribute("data-live", "true")
  })

  it("renders nothing until something asks for a viewer", () => {
    render(
      <Harness>
        <OpenerCard toolUseId="tool-1" />
      </Harness>
    )
    expect(screen.queryByTestId("delegation-viewer")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-session-viewer")).not.toBeInTheDocument()
    expect(screen.queryByTestId("file-viewer")).not.toBeInTheDocument()
  })

  it("hosts the file viewer, so it STACKS on the drawer the transcript is in", async () => {
    // The situation this branch exists for: a transcript being read inside a
    // side panel (the task board's session viewer, a canvas card's drawer),
    // where the workspace file column is off screen entirely.
    render(
      <Drawer open swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task session</DrawerTitle>
          <Harness>
            <FileOpener />
          </Harness>
        </DrawerContent>
      </Drawer>
    )

    act(() => {
      screen.getByText("open file").click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId("file-viewer")).toHaveAttribute(
      "data-path",
      "/repo/docs/plan.md"
    )
    expect(screen.getByTestId("file-viewer")).toHaveTextContent(
      "/repo/docs/plan.md:12"
    )

    // Descendant, not sibling: Base UI only stacks through
    // `DialogRootContext`, and the marker on the transcript's own popup is the
    // only proof the panel landed inside its React tree.
    const popups = Array.from(
      document.querySelectorAll("[data-slot=drawer-popup]")
    )
    const parent = popups.find((p) => p.textContent?.includes("Task session"))
    expect(parent).toHaveAttribute("data-nested-drawer-open")
  })

  it("replaces an open session viewer rather than opening a second panel", () => {
    // One slot, not one per kind — two same-width panels at the same level
    // would flatly cover one another.
    render(
      <Harness>
        <OpenerCard toolUseId="tool-9" />
        <FileOpener />
      </Harness>
    )

    act(() => {
      screen.getByText("open tool-9").click()
    })
    expect(screen.getByTestId("delegation-viewer")).toBeInTheDocument()

    act(() => {
      screen.getByText("open file").click()
    })
    expect(screen.queryByTestId("delegation-viewer")).not.toBeInTheDocument()
    expect(screen.getByTestId("file-viewer")).toBeInTheDocument()
  })

  it("reports no host outside a provider, so cards keep their own drawer", () => {
    function Probe() {
      const host = useSessionViewerHost()
      return <span data-testid="probe">{host === null ? "none" : "host"}</span>
    }
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("none")
  })
})
