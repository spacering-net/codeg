/**
 * Where a file clicked in a transcript lands.
 *
 * The file column is the default and the better answer whenever it is on
 * screen. The whole point of the hook is the ONE case where it is not: a
 * full-page workbench route (the task board, the canvas) covers the workspace,
 * so a tab opened there is invisible and the click reads as broken. These pin
 * down that switch — and, just as importantly, that it does not fire anywhere
 * else, because routing to a drawer when the column was visible would be a
 * regression of its own.
 */
import { act, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi, beforeEach } from "vitest"

import {
  SessionViewerHostContext,
  type SessionViewerRequest,
} from "@/components/message/session-viewer-host-context"
import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "@/contexts/workbench-route-context"
import { useOpenFileTarget } from "@/hooks/use-open-file-target"

const { mockOpenFilePreview, mockOpenSessionFileDiff } = vi.hoisted(() => ({
  mockOpenFilePreview: vi.fn(async () => "/repo/docs/plan.md"),
  mockOpenSessionFileDiff: vi.fn(),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openFilePreview: mockOpenFilePreview,
    openSessionFileDiff: mockOpenSessionFileDiff,
  }),
}))

const opened: SessionViewerRequest[] = []

function Host({ children }: { children: ReactNode }) {
  return (
    <SessionViewerHostContext.Provider
      value={{ open: (request) => opened.push(request) }}
    >
      {children}
    </SessionViewerHostContext.Provider>
  )
}

/** Clicks a file badge, and (when a route is available) can leave the
 *  conversations route the way the sidebar's task/canvas buttons do. */
function Opener() {
  const openFileTarget = useOpenFileTarget()
  return (
    <button
      type="button"
      onClick={() => void openFileTarget("docs/plan.md", { line: 12 })}
    >
      open file
    </button>
  )
}

/** The reply's "view diff" action: it already holds the patch text, so it
 *  asks for a diff rather than a path to read. */
function DiffOpener() {
  const openFileTarget = useOpenFileTarget()
  return (
    <button
      type="button"
      onClick={() =>
        void openFileTarget("src/a.ts", {
          diff: { content: "@@ -1 +1 @@", groupLabel: "turn-1" },
        })
      }
    >
      view diff
    </button>
  )
}

function RouteSwitch({ to }: { to: "tasks" | "conversations" }) {
  const { setRoute } = useWorkbenchRoute()
  return (
    <button type="button" onClick={() => setRoute(to)}>
      go {to}
    </button>
  )
}

function click(label: string) {
  act(() => {
    screen.getByText(label).click()
  })
}

describe("useOpenFileTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    opened.length = 0
  })

  it("opens in the file column on the conversations route", () => {
    render(
      <WorkbenchRouteProvider>
        <Host>
          <Opener />
        </Host>
      </WorkbenchRouteProvider>
    )

    click("open file")

    expect(opened).toEqual([])
    expect(mockOpenFilePreview).toHaveBeenCalledWith("docs/plan.md", {
      line: 12,
      folderId: undefined,
    })
  })

  it("opens in the transcript's viewer once a full-page route covers the column", () => {
    render(
      <WorkbenchRouteProvider>
        <RouteSwitch to="tasks" />
        <Host>
          <Opener />
        </Host>
      </WorkbenchRouteProvider>
    )

    click("go tasks")
    click("open file")

    expect(mockOpenFilePreview).not.toHaveBeenCalled()
    expect(opened).toEqual([
      { kind: "file", path: "docs/plan.md", line: 12, folderId: undefined },
    ])
  })

  it("falls back to the file column when the transcript has no viewer host", () => {
    // A transcript rendered outside `MessageListView` (the grok child
    // transcript) has nothing to render a side panel with — the invisible tab
    // is still better than swallowing the click.
    render(
      <WorkbenchRouteProvider>
        <RouteSwitch to="tasks" />
        <Opener />
      </WorkbenchRouteProvider>
    )

    click("go tasks")
    click("open file")

    expect(opened).toEqual([])
    expect(mockOpenFilePreview).toHaveBeenCalledTimes(1)
  })

  it("sends the reply's diff action down the SAME branch as its file action", () => {
    // The two sit in one action row. Routing only the file one is how the diff
    // one was left opening a tab behind the board with nothing to show for it.
    render(
      <WorkbenchRouteProvider>
        <RouteSwitch to="tasks" />
        <Host>
          <DiffOpener />
        </Host>
      </WorkbenchRouteProvider>
    )

    click("go tasks")
    click("view diff")

    expect(mockOpenSessionFileDiff).not.toHaveBeenCalled()
    expect(opened).toEqual([
      {
        kind: "file",
        path: "src/a.ts",
        line: null,
        folderId: undefined,
        diff: { content: "@@ -1 +1 @@", groupLabel: "turn-1" },
      },
    ])
  })

  it("still opens a diff tab when the file column IS visible", () => {
    render(
      <WorkbenchRouteProvider>
        <Host>
          <DiffOpener />
        </Host>
      </WorkbenchRouteProvider>
    )

    click("view diff")

    expect(opened).toEqual([])
    expect(mockOpenFilePreview).not.toHaveBeenCalled()
    expect(mockOpenSessionFileDiff).toHaveBeenCalledWith(
      "src/a.ts",
      "@@ -1 +1 @@",
      "turn-1",
      { folderId: undefined }
    )
  })

  it("keeps the file column outside the workspace layout, where there is no route", () => {
    render(
      <Host>
        <Opener />
      </Host>
    )

    click("open file")

    expect(opened).toEqual([])
    expect(mockOpenFilePreview).toHaveBeenCalledTimes(1)
  })
})
