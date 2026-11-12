import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: mocks.openFilePreview }),
}))

import enMessages from "@/i18n/messages/en.json"
import {
  StaticConnectionStoreProvider,
  type ConnectionState,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import type { AsyncTaskRecord } from "@/lib/types"
import { LiveRunsChip, type LiveRunsList } from "./live-runs-chip"

const m = enMessages.Folder.chat

function task(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    task_id: "t1",
    name: "pnpm test",
    task_type: "shell",
    description: "pnpm test --watch",
    show_in_transcript: false,
    can_stop: true,
    state: "running",
    ...overrides,
  }
}

function runs(overrides: Partial<LiveRunsList> = {}): LiveRunsList {
  const base: Omit<LiveRunsList, "count"> = {
    tasks: [task()],
    subagents: [
      {
        key: "bg:a1",
        part: null,
        background: true,
        description: "Survey the runners",
        startedAt: null,
      },
    ],
    delegations: [{ childConnectionId: "child-1", binding: null }],
    ...overrides,
  }
  return {
    ...base,
    count: base.tasks.length + base.subagents.length + base.delegations.length,
  }
}

function store(
  connections: Record<string, Partial<ConnectionState>> = {}
): ConnectionStoreApi {
  return {
    getConnection: (key) => connections[key] as ConnectionState | undefined,
    getConnectPending: () => undefined,
    getConnectError: () => undefined,
    getActiveKey: () => null,
    subscribeKey: () => () => {},
    subscribeActiveKey: () => () => {},
  }
}

function renderChip(ui: ReactElement, connectionStore = store()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StaticConnectionStoreProvider store={connectionStore}>
        {ui}
      </StaticConnectionStoreProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mocks.openFilePreview.mockReset()
})

describe("LiveRunsChip", () => {
  it("says how many are running, every row counted", () => {
    renderChip(<LiveRunsChip runs={runs()} interactive />)
    expect(screen.getByRole("button", { name: "3 running" })).toBeVisible()
  })

  it("opens the list, a group per kind headed by what it holds", async () => {
    renderChip(
      <LiveRunsChip
        runs={runs()}
        interactive
        agentName="Claude"
        onStopAsyncTask={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: "3 running" }))
    const list = await screen.findByRole("dialog")
    const headings = within(list)
      .getAllByRole("heading")
      .map((h) => h.textContent)
    expect(headings).toEqual([
      `${m.asyncTasks.title}1`,
      `${m.subAgentOverlay.title}1`,
      `${m.liveRuns.groupDelegations}1`,
    ])
    expect(within(list).getByText("pnpm test")).toBeVisible()
    // A background sub-agent whose card isn't loaded: the producer's words.
    expect(within(list).getByText("Survey the runners")).toBeVisible()
    expect(within(list).getByText(m.liveRuns.background)).toBeVisible()
    // A delegation with no card: listed bare, and never with a stop.
    expect(within(list).getByText(m.liveRuns.delegatedFallback)).toBeVisible()
    expect(
      within(list).getAllByRole("button", { name: m.asyncTasks.stop })
    ).toHaveLength(1)
  })

  it("leaves out the groups with nothing in them", async () => {
    renderChip(
      <LiveRunsChip
        runs={runs({ subagents: [], delegations: [] })}
        interactive
      />
    )
    await userEvent.click(screen.getByRole("button", { name: "1 running" }))
    const list = await screen.findByRole("dialog")
    expect(within(list).getAllByRole("heading")).toHaveLength(1)
  })

  it("stops a task, and keeps the stop on its way through closing the list", async () => {
    let resolveStop: (stopped: boolean) => void = () => {}
    const onStop = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStop = resolve
        })
    )
    renderChip(
      <LiveRunsChip runs={runs()} interactive onStopAsyncTask={onStop} />
    )
    const chip = screen.getByRole("button", { name: "3 running" })
    await userEvent.click(chip)
    await userEvent.click(
      await screen.findByRole("button", { name: m.asyncTasks.stop })
    )
    expect(onStop).toHaveBeenCalledWith("t1")

    // Closed and opened again before the adapter answered: no second stop.
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await userEvent.click(chip)
    expect(
      await screen.findByRole("button", { name: m.asyncTasks.stop })
    ).toBeDisabled()

    // The adapter declined: the button comes back, to try again.
    await act(async () => {
      resolveStop(false)
    })
    expect(
      screen.getByRole("button", { name: m.asyncTasks.stop })
    ).toBeEnabled()
  })

  it("offers no stop without a live connection to send it on", async () => {
    renderChip(<LiveRunsChip runs={runs()} interactive />)
    await userEvent.click(screen.getByRole("button", { name: "3 running" }))
    await screen.findByRole("dialog")
    expect(
      screen.queryByRole("button", { name: m.asyncTasks.stop })
    ).not.toBeInTheDocument()
  })

  it("marks the chip while a delegated sub-agent waits on the user", () => {
    renderChip(
      <LiveRunsChip runs={runs()} interactive />,
      store({
        "child-1": {
          pendingPermission: {
            request_id: "r1",
          } as ConnectionState["pendingPermission"],
          pendingAskQuestion: null,
          pendingPlanApproval: null,
        },
      })
    )
    expect(
      screen.getByRole("button", {
        name: `3 running · ${m.liveRuns.awaiting}`,
      })
    ).toBeVisible()
  })

  it("closes the list and stops answering while the row slides away", async () => {
    const { rerender } = renderChip(<LiveRunsChip runs={runs()} interactive />)
    await userEvent.click(screen.getByRole("button", { name: "3 running" }))
    expect(await screen.findByRole("dialog")).toBeVisible()
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StaticConnectionStoreProvider store={store()}>
          <LiveRunsChip runs={runs()} interactive={false} />
        </StaticConnectionStoreProvider>
      </NextIntlClientProvider>
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "3 running" })).toBeDisabled()
  })
})
