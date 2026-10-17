import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AcpAgentInfo, AssistantChange, AssistantInfo } from "@/lib/types"

// jsdom has no layout, so Motion can never decide that a dragged row crossed
// its neighbour. The fake keeps the wiring that matters here — the order the
// group reports while a drag is live, and the release that ends it — and hands
// both to the test to drive.
const motion = vi.hoisted(() => ({
  onReorder: null as ((next: number[]) => void) | null,
  dragEnd: new Map<number, () => void>(),
}))
vi.mock("motion/react", async () => {
  const { useLayoutEffect } = await import("react")
  const MOTION_ONLY = new Set([
    "as",
    "axis",
    "values",
    "onReorder",
    "value",
    "drag",
    "dragListener",
    "dragControls",
    "dragMomentum",
    "layout",
    "onDragEnd",
  ])
  const domProps = (props: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(props).filter(([key]) => !MOTION_ONLY.has(key))
    )
  function Group(
    props: Record<string, unknown> & {
      children?: ReactNode
      onReorder: (next: number[]) => void
    }
  ) {
    const { onReorder } = props
    useLayoutEffect(() => {
      motion.onReorder = onReorder
    })
    return <ul {...domProps(props)}>{props.children}</ul>
  }
  function Item(
    props: Record<string, unknown> & {
      children?: ReactNode
      value: number
      onDragEnd: () => void
    }
  ) {
    const { value, onDragEnd } = props
    useLayoutEffect(() => {
      motion.dragEnd.set(value, onDragEnd)
    })
    return <li {...domProps(props)}>{props.children}</li>
  }
  return {
    Reorder: { Group, Item },
    useDragControls: () => ({ start: () => {} }),
  }
})

const api = vi.hoisted(() => ({
  describeAgentOptions: vi.fn(),
  assistantList: vi.fn(),
  assistantCreate: vi.fn(),
  assistantUpdate: vi.fn(),
  assistantDelete: vi.fn(),
  assistantReorder: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

const platform = vi.hoisted(() => ({
  onChange: null as ((change: AssistantChange) => void) | null,
  onReconnect: null as (() => void) | null,
}))
vi.mock("@/lib/platform", () => ({
  subscribe: async (
    _event: string,
    handler: (change: AssistantChange) => void
  ) => {
    platform.onChange = handler
    return () => {
      platform.onChange = null
    }
  },
  onTransportReconnect: (handler: () => void) => {
    platform.onReconnect = handler
    return () => {
      platform.onReconnect = null
    }
  },
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

const agents = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: agents.list, fresh: true, refresh: () => {} }),
}))

import enMessages from "@/i18n/messages/en.json"
import { resetAssistantsStore } from "@/stores/assistants-store"
import { AssistantsPanel, copyName } from "./assistants-panel"

function agent(
  agentType: string,
  patch: Partial<AcpAgentInfo> = {}
): AcpAgentInfo {
  return {
    agent_type: agentType,
    name: agentType,
    enabled: true,
    available: true,
    ...patch,
  } as AcpAgentInfo
}

function row(
  id: number,
  name: string,
  patch: Partial<AssistantInfo> = {}
): AssistantInfo {
  return {
    id,
    uid: `u-${id}`,
    name,
    description: `${name} blurb`,
    avatar: { kind: "monogram", color: "teal" },
    agent_type: "codex",
    agent_options: {
      mode_id: null,
      config_values: { model: "gpt-5.5", effort: "high", web: "true" },
    },
    label_snapshot: {
      agent: "Codex",
      mode: null,
      options: [
        { id: "model", kind: "select", name: "Model", value_label: "GPT-5.5" },
        { id: "effort", kind: "select", name: "Effort", value_label: "High" },
        { id: "web", kind: "boolean", name: "Web", value_label: "On" },
      ],
    },
    instructions: "Be brief.",
    enabled: true,
    sort_order: id,
    revision: 1,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
    deleted_at: null,
    ...patch,
  }
}

const ROWS = [row(1, "Reviewer"), row(2, "Planner"), row(3, "Tester")]

function renderPanel(
  props: Partial<Parameters<typeof AssistantsPanel>[0]> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AssistantsPanel delegationEnabled unsavedTabs={[]} {...props} />
    </NextIntlClientProvider>
  )
}

/** Row names in display order, read off each row's drag handle. */
const shownNames = () =>
  screen
    .queryAllByRole("button", { name: /^Move / })
    .map((handle) => handle.getAttribute("aria-label")?.slice("Move ".length))

const rowOf = (name: string) =>
  screen.getByRole("button", { name: `Move ${name}` }).closest("li")!

describe("AssistantsPanel", () => {
  beforeEach(() => {
    resetAssistantsStore()
    for (const fn of Object.values(api)) fn.mockReset()
    toast.success.mockReset()
    toast.error.mockReset()
    motion.onReorder = null
    motion.dragEnd.clear()
    agents.list = [agent("codex"), agent("open_code")]
    api.assistantList.mockResolvedValue(ROWS)
  })

  it("lists the assistants with their saved agent and picks, read without probing", async () => {
    agents.list = [agent("codex"), agent("open_code", { enabled: false })]
    api.assistantList.mockResolvedValue([
      ...ROWS,
      row(4, "Gone", {
        agent_type: "grok",
        label_snapshot: { agent: "Grok", mode: null, options: [] },
      }),
      row(5, "Off", { agent_type: "open_code", enabled: false }),
    ])
    renderPanel()
    await waitFor(() =>
      expect(shownNames()).toEqual([
        "Reviewer",
        "Planner",
        "Tester",
        "Gone",
        "Off",
      ])
    )
    const reviewer = within(rowOf("Reviewer"))
    expect(reviewer.getByText("Reviewer blurb")).toBeInTheDocument()
    expect(
      reviewer.getByText("Codex · GPT-5.5 · High · On")
    ).toBeInTheDocument()
    // An agent that is not installed, or turned off, is called out.
    expect(within(rowOf("Gone")).getByText("not installed")).toBeInTheDocument()
    expect(within(rowOf("Off")).getByText("disabled")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Enable Off" })).not.toBeChecked()
    expect(api.describeAgentOptions).not.toHaveBeenCalled()
  })

  it("shows the empty state, and says when delegation is off or another tab has unsaved changes", async () => {
    api.assistantList.mockResolvedValue([])
    const onShowUnsaved = vi.fn()
    const user = userEvent.setup()
    renderPanel({
      delegationEnabled: false,
      unsavedTabs: ["General"],
      onShowUnsaved,
    })
    await waitFor(() =>
      expect(screen.getByText(/No assistants yet/)).toBeInTheDocument()
    )
    expect(
      screen.getByText(/Multi-Agent Collaboration is off/)
    ).toBeInTheDocument()
    expect(screen.getByText("General has unsaved changes.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Go back" }))
    expect(onShowUnsaved).toHaveBeenCalledTimes(1)
  })

  it("offers one way in from the empty state, and the way to turn delegation on", async () => {
    api.assistantList.mockResolvedValue([])
    api.describeAgentOptions.mockReturnValue(new Promise(() => {}))
    const onShowGeneral = vi.fn()
    const user = userEvent.setup()
    renderPanel({ delegationEnabled: false, onShowGeneral })
    await waitFor(() =>
      expect(screen.getByText("No assistants yet")).toBeInTheDocument()
    )
    // The header's button stands down while the empty state shows its own.
    const create = screen.getAllByRole("button", { name: "New assistant" })
    expect(create).toHaveLength(1)

    await user.click(screen.getByRole("button", { name: "Go to General" }))
    expect(onShowGeneral).toHaveBeenCalledTimes(1)

    await user.click(create[0])
    expect(
      within(await screen.findByRole("dialog")).getByRole("heading", {
        name: "New assistant",
      })
    ).toBeInTheDocument()
  })

  it("says nothing about delegation while it is on or not yet known", async () => {
    const { unmount } = renderPanel({ delegationEnabled: true })
    await waitFor(() => expect(shownNames()).toHaveLength(3))
    expect(screen.queryByText(/Multi-Agent Collaboration is off/)).toBeNull()
    unmount()
    renderPanel({ delegationEnabled: null })
    await waitFor(() => expect(shownNames()).toHaveLength(3))
    expect(screen.queryByText(/Multi-Agent Collaboration is off/)).toBeNull()
  })

  it("reports a failed load", async () => {
    api.assistantList.mockRejectedValue(new Error("db locked"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    renderPanel()
    await waitFor(() =>
      expect(
        screen.getByText("Failed to load assistants: db locked")
      ).toBeInTheDocument()
    )
    spy.mockRestore()
  })

  it("retries a failed load from the error", async () => {
    api.assistantList.mockRejectedValueOnce(new Error("db locked"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() =>
      expect(
        screen.getByText("Failed to load assistants: db locked")
      ).toBeInTheDocument()
    )
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(shownNames()).toHaveLength(3))
    expect(screen.queryByText(/Failed to load assistants/)).toBeNull()
    spy.mockRestore()
  })

  it("opens the editor from a click on the row, but not from its controls or a drag", async () => {
    api.describeAgentOptions.mockReturnValue(new Promise(() => {}))
    api.assistantUpdate.mockResolvedValue(
      row(2, "Planner", { enabled: false, revision: 2 })
    )
    api.assistantCreate.mockImplementation((draft) =>
      Promise.resolve(row(9, draft.name, { sort_order: 9 }))
    )
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))

    // The switch and the menu — its items included, whose clicks bubble to
    // the row through the portal — act on the row without opening it.
    await user.click(screen.getByRole("switch", { name: "Enable Planner" }))
    await user.click(
      screen.getByRole("button", { name: "More actions for Planner" })
    )
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }))
    await waitFor(() => expect(api.assistantCreate).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("dialog")).toBeNull()
    // A press that started on the drag handle ends in a click on the row when
    // the drag is dropped: that is the drop, not a request to edit.
    const handle = screen.getByRole("button", { name: "Move Planner" })
    fireEvent.pointerDown(handle)
    fireEvent.click(rowOf("Planner"))
    expect(screen.queryByRole("dialog")).toBeNull()

    await user.click(within(rowOf("Planner")).getByText("Planner blurb"))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Planner")
  })

  it("enables and disables an assistant in place", async () => {
    api.assistantUpdate.mockResolvedValue(
      row(2, "Planner", { enabled: false, revision: 2 })
    )
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))
    const toggleSwitch = screen.getByRole("switch", { name: "Enable Planner" })
    expect(toggleSwitch).toBeChecked()
    await user.click(toggleSwitch)
    expect(api.assistantUpdate).toHaveBeenCalledWith(2, { enabled: false })
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Enable Planner" })
      ).not.toBeChecked()
    )
  })

  it("deletes only after the confirmation", async () => {
    api.assistantDelete.mockResolvedValue(
      row(2, "Planner", { deleted_at: "2026-10-16T01:00:00Z", revision: 2 })
    )
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))

    await user.click(
      screen.getByRole("button", { name: "More actions for Planner" })
    )
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))
    let confirm = await screen.findByRole("alertdialog")
    expect(within(confirm).getByText("Delete Planner?")).toBeInTheDocument()
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(api.assistantDelete).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole("button", { name: "More actions for Planner" })
    )
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))
    confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByRole("button", { name: "Delete" }))
    expect(api.assistantDelete).toHaveBeenCalledWith(2)
    await waitFor(() => expect(shownNames()).toEqual(["Reviewer", "Tester"]))
  })

  it("deletes once however many times Delete is pressed before the confirmation closes", async () => {
    api.assistantDelete.mockResolvedValue(
      row(2, "Planner", { deleted_at: "2026-10-16T01:00:00Z", revision: 2 })
    )
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))
    await user.click(
      screen.getByRole("button", { name: "More actions for Planner" })
    )
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))
    const confirm = await screen.findByRole("alertdialog")
    const press = within(confirm).getByRole("button", { name: "Delete" })
    // Both presses land before the dialog has closed (in the app: while it
    // animates out, with its button still under the pointer).
    act(() => {
      press.click()
      press.click()
    })
    await waitFor(() => expect(shownNames()).toEqual(["Reviewer", "Tester"]))
    expect(api.assistantDelete).toHaveBeenCalledTimes(1)
    expect(api.assistantDelete).toHaveBeenCalledWith(2)
  })

  it("duplicates an assistant under the next free name, selection and all", async () => {
    api.assistantList.mockResolvedValue([...ROWS, row(4, "reviewer (2)")])
    api.assistantCreate.mockImplementation((draft) =>
      Promise.resolve(row(9, draft.name, { sort_order: 9 }))
    )
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(4))
    await user.click(
      screen.getByRole("button", { name: "More actions for Reviewer" })
    )
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }))
    await waitFor(() => expect(api.assistantCreate).toHaveBeenCalledTimes(1))
    const source = ROWS[0]
    expect(api.assistantCreate).toHaveBeenCalledWith({
      name: "Reviewer (3)",
      description: source.description,
      avatar: source.avatar,
      agent_config: {
        agent_type: source.agent_type,
        agent_options: source.agent_options,
        label_snapshot: source.label_snapshot,
      },
      instructions: source.instructions,
      enabled: true,
    })
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Created Reviewer (3)")
    )
    expect(shownNames()).toContain("Reviewer (3)")
  })

  it("moves a row with the arrow keys on its handle", async () => {
    api.assistantReorder.mockResolvedValue([
      row(1, "Reviewer", { sort_order: 2, revision: 2 }),
      row(2, "Planner", { sort_order: 1, revision: 2 }),
    ])
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))

    screen.getByRole("button", { name: "Move Reviewer" }).focus()
    // Already first: nothing to do.
    await user.keyboard("{ArrowUp}")
    expect(api.assistantReorder).not.toHaveBeenCalled()

    await user.keyboard("{ArrowDown}")
    expect(api.assistantReorder).toHaveBeenCalledWith([2, 1, 3])
    await waitFor(() =>
      expect(shownNames()).toEqual(["Planner", "Reviewer", "Tester"])
    )
  })

  it("follows a drag live and saves the order once, on release", async () => {
    let settle: (rows: AssistantInfo[]) => void = () => {}
    api.assistantReorder.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))

    // Tester dragged to the top, through the middle.
    act(() => motion.onReorder?.([1, 3, 2]))
    act(() => motion.onReorder?.([3, 1, 2]))
    expect(shownNames()).toEqual(["Tester", "Reviewer", "Planner"])
    expect(api.assistantReorder).not.toHaveBeenCalled()

    await act(async () => motion.dragEnd.get(3)?.())
    expect(api.assistantReorder).toHaveBeenCalledTimes(1)
    expect(api.assistantReorder).toHaveBeenCalledWith([3, 1, 2])
    // The new order holds while the write is in flight…
    expect(shownNames()).toEqual(["Tester", "Reviewer", "Planner"])
    // …and the rows' own order takes over once it settles.
    await act(async () =>
      settle([
        row(3, "Tester", { sort_order: 1, revision: 2 }),
        row(1, "Reviewer", { sort_order: 2, revision: 2 }),
        row(2, "Planner", { sort_order: 3, revision: 2 }),
      ])
    )
    expect(shownNames()).toEqual(["Tester", "Reviewer", "Planner"])
  })

  it("does not save a drag released where it started", async () => {
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))
    act(() => motion.onReorder?.([2, 1, 3]))
    act(() => motion.onReorder?.([1, 2, 3]))
    await act(async () => motion.dragEnd.get(1)?.())
    expect(api.assistantReorder).not.toHaveBeenCalled()
    expect(shownNames()).toEqual(["Reviewer", "Planner", "Tester"])
  })

  it("puts the order back and says so when saving it fails", async () => {
    api.assistantReorder.mockRejectedValue(new Error("db locked"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))
    screen.getByRole("button", { name: "Move Planner" }).focus()
    await user.keyboard("{ArrowDown}")
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to reorder assistants", {
        description: "db locked",
      })
    )
    expect(shownNames()).toEqual(["Reviewer", "Planner", "Tester"])
    spy.mockRestore()
  })

  it("stays live: a broadcast shows at once, a reconnect re-reads", async () => {
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))
    await waitFor(() => expect(platform.onChange).not.toBeNull())

    act(() =>
      platform.onChange?.({
        kind: "upsert",
        assistant: row(2, "Architect", { revision: 2 }),
      })
    )
    expect(shownNames()).toEqual(["Reviewer", "Architect", "Tester"])

    api.assistantList.mockResolvedValue([
      ...ROWS.slice(0, 1),
      row(2, "Architect", { revision: 2 }),
      row(3, "Tester", { revision: 2, deleted_at: "2026-10-16T01:00:00Z" }),
    ])
    expect(api.assistantList).toHaveBeenCalledTimes(1)
    await act(async () => platform.onReconnect?.())
    expect(api.assistantList).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(shownNames()).toEqual(["Reviewer", "Architect"]))
  })

  it("opens the editor for a new assistant and for an existing one", async () => {
    api.describeAgentOptions.mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(shownNames()).toHaveLength(3))

    await user.click(screen.getByRole("button", { name: "New assistant" }))
    let dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: "New assistant" })
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await user.click(screen.getByRole("button", { name: "Edit Tester" }))
    dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: "Edit assistant" })
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Tester")
  })
})

describe("copyName", () => {
  it("takes the first free number, ignoring case", () => {
    expect(copyName("Reviewer", ["Reviewer"])).toBe("Reviewer (2)")
    expect(copyName("Reviewer", ["Reviewer", "REVIEWER (2)"])).toBe(
      "Reviewer (3)"
    )
  })

  it("shortens the base so the copy fits the name limit", () => {
    const base = "x".repeat(40)
    const copy = copyName(base, [base])
    expect(Array.from(copy)).toHaveLength(40)
    expect(copy).toBe(`${"x".repeat(36)} (2)`)
  })

  it("never splits a character when shortening", () => {
    const base = "🦊".repeat(40)
    const copy = copyName(base, [base])
    expect(copy).toBe(`${"🦊".repeat(36)} (2)`)
  })
})
