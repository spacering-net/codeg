import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { SkillsChanged, SkillsInventory } from "@/lib/skills/types"
import type { AcpAgentInfo, ExpertInstallStatus } from "@/lib/types"

// The inventory, the older packs' status scans and the agent registry are all
// mocked, so the tests can count how many reads a focus or a change costs
// across several mounted consumers. `acpListAgents` comes in through
// `useAcpAgents` (the hook reads each agent's env_json to spot a custom-dir
// pi); with no agents, that detection stays inert.
vi.mock("@/lib/api", () => ({
  expertsListAllInstallStatuses: vi.fn(),
  officecliSkillListAllInstallStatuses: vi.fn(),
  scienceListAllInstallStatuses: vi.fn(),
  customListAllInstallStatuses: vi.fn(),
  generativeUiListAllInstallStatuses: vi.fn(),
  acpListAgents: vi.fn().mockResolvedValue([]),
}))
vi.mock("@/lib/skills/api", () => ({ skillsInventory: vi.fn() }))

// `skills://changed`, as the shared subscription hands it out.
const changes = vi.hoisted(() => ({
  listeners: new Set<(change: SkillsChanged | null) => void>(),
}))
vi.mock("@/lib/skills/changes", () => ({
  listenSkillsChanged: (listener: (change: SkillsChanged | null) => void) => {
    changes.listeners.add(listener)
    return () => changes.listeners.delete(listener)
  },
}))

// `useAcpAgents` subscribes through the platform layer; inert disposers let
// the hook mount cleanly under jsdom.
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))

// The hook caches its snapshot and its listeners at module scope; a fresh
// module registry per test starts each one cold.
beforeEach(() => {
  vi.resetModules()
  changes.listeners.clear()
})

type CellSpec = [agent: string, state: string]

function inventoryOf(
  skills: { id: string; origin: string; cells: CellSpec[] }[]
): SkillsInventory {
  return {
    store: "/home/u/.codeg/skills",
    agents: [],
    name_taken: [],
    broken_links: [],
    problems: [],
    skills: skills.map(({ id, origin, cells }) => ({
      id,
      origin,
      path: `/home/u/.codeg/skills/${id}`,
      name: id,
      description: null,
      pending_user_review: false,
      harness: null,
      backups: 0,
      cells: cells.map(([agent, state]) => ({
        agent,
        state,
        path: null,
        dir: null,
        dir_role: null,
        target: null,
        codeg: state !== "blocked",
        copy_matches: null,
        copy_current: null,
        shared_with: [],
        entries: [],
      })),
    })),
  }
}

async function setup(inventory: SkillsInventory = inventoryOf([])) {
  const api = await import("@/lib/api")
  const skills = await import("@/lib/skills/api")
  for (const fn of [
    api.expertsListAllInstallStatuses,
    api.officecliSkillListAllInstallStatuses,
    api.scienceListAllInstallStatuses,
    api.customListAllInstallStatuses,
    api.generativeUiListAllInstallStatuses,
  ]) {
    vi.mocked(fn).mockReset().mockResolvedValue([])
  }
  vi.mocked(skills.skillsInventory).mockReset().mockResolvedValue(inventory)
  const hook = await import("./use-enabled-skill-ids")
  return { api, skills, hook }
}

async function emit(change: SkillsChanged | null) {
  await act(async () => {
    for (const listener of [...changes.listeners]) listener(change)
    await Promise.resolve()
  })
}

describe("useEnabledSkillIds — what counts as enabled", () => {
  it("covers every origin: the packs, Custom, UI and Harness", async () => {
    const { hook } = await setup(
      inventoryOf([
        {
          id: "brainstorming",
          origin: "experts",
          cells: [["claude_code", "linked"]],
        },
        { id: "mine", origin: "custom", cells: [["claude_code", "linked"]] },
        { id: "ui-render", origin: "ui", cells: [["claude_code", "linked"]] },
        {
          id: "from-harness",
          origin: "harness",
          cells: [["claude_code", "linked"]],
        },
      ])
    )
    const { result } = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect([...result.current.enabledIds].sort()).toEqual([
      "brainstorming",
      "from-harness",
      "mine",
      "ui-render",
    ])
  })

  it("counts a skill seen through a shared folder or a copy, and nothing else", async () => {
    const { hook } = await setup(
      inventoryOf([
        {
          id: "through",
          origin: "custom",
          cells: [["codex", "visible_through"]],
        },
        { id: "copied", origin: "custom", cells: [["codex", "copy"]] },
        { id: "blocked", origin: "custom", cells: [["codex", "blocked"]] },
        { id: "broken", origin: "custom", cells: [["codex", "broken"]] },
        { id: "off", origin: "custom", cells: [["codex", "not_linked"]] },
        {
          id: "elsewhere",
          origin: "custom",
          cells: [["codex", "linked_elsewhere"]],
        },
      ])
    )
    const { result } = renderHook(() => hook.useEnabledSkillIds("codex"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect([...result.current.enabledIds].sort()).toEqual(["copied", "through"])
  })

  it("reads the packs' own snapshots, Custom and UI included, from an older Codeg", async () => {
    const { api, skills, hook } = await setup()
    vi.mocked(skills.skillsInventory).mockRejectedValue({
      code: "not_implemented",
      message: "no such command",
    })
    const linked = (expertId: string): ExpertInstallStatus => ({
      expertId,
      agentType: "claude_code",
      state: "linked_to_codeg",
      linkPath: "",
      targetPath: null,
      expectedTargetPath: "",
      copyMode: false,
    })
    vi.mocked(api.expertsListAllInstallStatuses).mockResolvedValue([
      linked("writer"),
    ])
    vi.mocked(api.customListAllInstallStatuses).mockResolvedValue([
      linked("mine"),
    ])
    vi.mocked(api.generativeUiListAllInstallStatuses).mockResolvedValue([
      linked("ui-render"),
    ])
    const { result } = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect([...result.current.enabledIds].sort()).toEqual([
      "mine",
      "ui-render",
      "writer",
    ])
  })

  it("fails open: a failed refresh keeps the snapshot it would have replaced", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { skills, hook } = await setup(
      inventoryOf([
        { id: "mine", origin: "custom", cells: [["codex", "linked"]] },
      ])
    )
    const { result } = renderHook(() => hook.useEnabledSkillIds("codex"))
    await waitFor(() =>
      expect(result.current.enabledIds.has("mine")).toBe(true)
    )
    vi.mocked(skills.skillsInventory).mockRejectedValue(new Error("down"))
    await emit({ kinds: ["links"], agents: ["codex"] })
    await waitFor(() => expect(skills.skillsInventory).toHaveBeenCalledTimes(2))
    expect(result.current.ready).toBe(true)
    expect(result.current.enabledIds.has("mine")).toBe(true)
    warn.mockRestore()
  })
})

describe("useEnabledSkillIds — focus refresh coalescing", () => {
  it("runs a single read per focus regardless of how many consumers are mounted", async () => {
    const { skills, hook } = await setup()
    // Two mounted consumers — e.g. two tiled conversation composers.
    const a = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    const b = renderHook(() => hook.useEnabledSkillIds("codex"))
    await waitFor(() => {
      expect(a.result.current.ready).toBe(true)
      expect(b.result.current.ready).toBe(true)
    })
    vi.mocked(skills.skillsInventory).mockClear()

    // A window focus must coalesce to ONE refresh — not one scan per instance.
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
    })

    await waitFor(() => expect(skills.skillsInventory).toHaveBeenCalledTimes(1))
  })

  it("detaches the shared listeners once the last consumer unmounts", async () => {
    const { skills, hook } = await setup()
    const a = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    const b = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() => expect(a.result.current.ready).toBe(true))
    expect(changes.listeners.size).toBe(1)

    a.unmount()
    b.unmount()
    vi.mocked(skills.skillsInventory).mockClear()

    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
    })

    expect(skills.skillsInventory).not.toHaveBeenCalled()
    expect(changes.listeners.size).toBe(0)
  })
})

// The Harness page links and unlinks skills inside the workspace window, where
// no window focus follows the change: `skills://changed` carries it instead.
describe("useEnabledSkillIds — following skills://changed", () => {
  it("rescans once, with no focus event, and every consumer follows", async () => {
    const { skills, hook } = await setup()
    const a = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    const b = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() => {
      expect(a.result.current.ready).toBe(true)
      expect(b.result.current.ready).toBe(true)
    })
    expect(a.result.current.enabledIds.has("writer")).toBe(false)

    // The user turns on a skill on the Harness page; the backend says so.
    vi.mocked(skills.skillsInventory)
      .mockClear()
      .mockResolvedValue(
        inventoryOf([
          {
            id: "writer",
            origin: "custom",
            cells: [["claude_code", "linked"]],
          },
        ])
      )
    await emit({ kinds: ["links"], agents: ["claude_code"] })

    await waitFor(() => {
      expect(a.result.current.enabledIds.has("writer")).toBe(true)
      expect(b.result.current.enabledIds.has("writer")).toBe(true)
    })
    // One read for both consumers.
    expect(skills.skillsInventory).toHaveBeenCalledTimes(1)
  })

  it("rescans after the event stream reconnects", async () => {
    const { skills, hook } = await setup()
    const { result } = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    vi.mocked(skills.skillsInventory).mockClear()
    await emit(null)
    await waitFor(() => expect(skills.skillsInventory).toHaveBeenCalledTimes(1))
  })

  it("does not rescan for a change to backups alone", async () => {
    const { skills, hook } = await setup()
    const { result } = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    vi.mocked(skills.skillsInventory).mockClear()
    await emit({ kinds: ["backups"], agents: [] })
    expect(skills.skillsInventory).not.toHaveBeenCalled()
  })

  it("reads again for a consumer that mounts after nothing was listening", async () => {
    const { skills, hook } = await setup()
    // A composer that loaded the snapshot and was then closed: the cache
    // outlives it, but nothing heard of the changes made since.
    const first = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    first.unmount()

    vi.mocked(skills.skillsInventory)
      .mockClear()
      .mockResolvedValue(
        inventoryOf([
          {
            id: "writer",
            origin: "custom",
            cells: [["claude_code", "linked"]],
          },
        ])
      )

    const second = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    // What was kept is shown at once…
    expect(second.result.current.ready).toBe(true)
    // …and read again.
    await waitFor(() =>
      expect(second.result.current.enabledIds.has("writer")).toBe(true)
    )
    expect(skills.skillsInventory).toHaveBeenCalledTimes(1)
  })

  it("gives consumers mounting together after nothing was listening one fresh read", async () => {
    const { skills, hook } = await setup()
    const first = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    first.unmount()

    let answer: (inventory: SkillsInventory) => void = () => {}
    vi.mocked(skills.skillsInventory)
      .mockClear()
      .mockImplementation(
        () =>
          new Promise<SkillsInventory>((resolve) => {
            answer = resolve
          })
      )

    // A composer and the quick actions, mounted in the same commit.
    const both = renderHook(() => ({
      composer: hook.useEnabledSkillIds("claude_code"),
      quick: hook.useEnabledSkillIds("claude_code"),
    }))
    expect(skills.skillsInventory).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer(
        inventoryOf([
          {
            id: "writer",
            origin: "custom",
            cells: [["claude_code", "linked"]],
          },
        ])
      )
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(both.result.current.composer.enabledIds.has("writer")).toBe(true)
      expect(both.result.current.quick.enabledIds.has("writer")).toBe(true)
    })
    expect(skills.skillsInventory).toHaveBeenCalledTimes(1)
  })

  it("reads again on the next mount after a failed read", async () => {
    const { skills, hook } = await setup()
    const first = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    vi.mocked(skills.skillsInventory)
      .mockClear()
      .mockRejectedValueOnce(new Error("offline"))
    await emit({ kinds: ["links"], agents: ["claude_code"] })
    await waitFor(() => expect(skills.skillsInventory).toHaveBeenCalledTimes(1))

    // The change it missed is still unread: a consumer mounting now — the
    // first one still listening — reads again, and both follow.
    vi.mocked(skills.skillsInventory).mockResolvedValue(
      inventoryOf([
        { id: "writer", origin: "custom", cells: [["claude_code", "linked"]] },
      ])
    )
    const second = renderHook(() => hook.useEnabledSkillIds("claude_code"))
    await waitFor(() =>
      expect(second.result.current.enabledIds.has("writer")).toBe(true)
    )
    expect(first.result.current.enabledIds.has("writer")).toBe(true)
    expect(skills.skillsInventory).toHaveBeenCalledTimes(2)
  })
})

// Only the fields the hook + useAcpAgents read; the rest of AcpAgentInfo is
// irrelevant to skill-management gating.
function piAgent(env: Record<string, string>): AcpAgentInfo {
  return {
    agent_type: "pi",
    name: "Pi",
    sort_order: 0,
    env,
  } as unknown as AcpAgentInfo
}

describe("useEnabledSkillIds — custom-dir pi gating", () => {
  const piLinked = () =>
    inventoryOf([
      { id: "writer", origin: "experts", cells: [["pi", "linked"]] },
    ])

  it("never exposes managed skills for a custom-dir pi, before or after the registry resolves", async () => {
    const { api, skills, hook } = await setup(piLinked())
    // A pi pinned to a custom PI_CODING_AGENT_DIR, plus a default-dir link
    // that must NOT be surfaced for it.
    vi.mocked(api.acpListAgents).mockResolvedValue([
      piAgent({ PI_CODING_AGENT_DIR: "/custom/pi" }),
    ])

    const { result } = renderHook(() => hook.useEnabledSkillIds("pi"))

    // Optimistic window: registry not yet loaded → pessimistically unmanaged,
    // so no default-dir link leaks even though the snapshot may resolve first.
    expect(result.current.supported).toBe(false)
    expect(result.current.enabledIds.size).toBe(0)

    await waitFor(() => expect(api.acpListAgents).toHaveBeenCalled())
    await waitFor(() => expect(skills.skillsInventory).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })

    // Custom dir now known → still unmanaged, link still suppressed.
    expect(result.current.supported).toBe(false)
    expect(result.current.enabledIds.size).toBe(0)
  })

  it("manages a default-dir pi once the registry resolves", async () => {
    const { api, hook } = await setup(piLinked())
    vi.mocked(api.acpListAgents).mockResolvedValue([piAgent({})])

    const { result } = renderHook(() => hook.useEnabledSkillIds("pi"))

    // Held unmanaged until the registry is known (pessimistic during load).
    expect(result.current.supported).toBe(false)

    await waitFor(() => expect(result.current.supported).toBe(true))
    await waitFor(() =>
      expect(result.current.enabledIds.has("writer")).toBe(true)
    )
  })
})
