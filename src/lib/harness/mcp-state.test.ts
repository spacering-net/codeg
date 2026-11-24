import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getActiveRemoteConnectionId: () => null,
}))

import {
  createHarnessSlotStore,
  type HarnessSlotStore,
} from "@/lib/harness-slots"
import type {
  McpApplyArgs,
  McpApplyResult,
  McpInventory,
} from "@/lib/mcp/types"
import {
  agent,
  appliedOf,
  entry,
  inventory,
  preflightOf,
  remote,
  resetFingerprints,
  stdio,
} from "@/lib/mcp/test-fixtures"
import {
  commitDialog,
  isAgentBusy,
  MCP_BUSY,
  MCP_DIALOG,
  MCP_INVENTORY,
  MCP_ROW_WRITES,
  MCP_SELECTED_SERVER,
  openEditEditor,
  openRemoveDialog,
  openRenameDialog,
  reloadMcpInventory,
  reviewDialog,
  rowId,
  updateDialog,
  updateEditorDraft,
  writeRow,
} from "./mcp-state"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

let slots: HarnessSlotStore
let current: McpInventory
const applied: McpApplyArgs[] = []
let answer: (args: McpApplyArgs) => McpApplyResult

beforeEach(() => {
  resetFingerprints()
  slots = createHarnessSlotStore()
  applied.length = 0
  current = inventory([
    agent("claude_code", [entry("linear", remote("sse"))]),
    agent("codex", [entry("linear", remote("http"))]),
    agent("gemini", [entry("linear", remote("sse"))]),
  ])
  answer = (args) =>
    args.preflight ? preflightOf(args.ops) : appliedOf(args.ops)
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (command: string, args: unknown) => {
    if (command === "mcp_inventory") return current
    if (command === "mcp_apply") {
      applied.push(args as McpApplyArgs)
      return answer(args as McpApplyArgs)
    }
    throw new Error(`unexpected ${command}`)
  })
})

async function load() {
  await reloadMcpInventory(slots).done
}

describe("the inventory", () => {
  it("keeps only the answer to the latest read", async () => {
    const first = deferred<McpInventory>()
    const second = deferred<McpInventory>()
    mocks.call
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const a = reloadMcpInventory(slots)
    const b = reloadMcpInventory(slots)
    second.resolve(inventory([agent("codex")]))
    await b.done
    first.resolve(inventory([agent("claude_code"), agent("gemini")]))
    await a.done
    expect(
      slots.get(MCP_INVENTORY).inventory!.agents.map((info) => info.agent)
    ).toEqual(["codex"])
  })

  it("keeps the last inventory when a new read fails", async () => {
    await load()
    mocks.call.mockRejectedValueOnce(new Error("socket closed"))
    await load()
    const state = slots.get(MCP_INVENTORY)
    expect(state.phase).toBe("error")
    expect(state.error).toEqual({ kind: "unknown", detail: "socket closed" })
    expect(state.inventory).toEqual(current)
  })

  it("tells an older Codeg apart from a failure", async () => {
    mocks.call.mockRejectedValueOnce({
      code: "not_implemented",
      message: "API endpoint is not available in web mode",
    })
    await load()
    expect(slots.get(MCP_INVENTORY).error?.kind).toBe("unsupported")
  })
})

describe("a row's switch", () => {
  it("sends one op for one agent, with that agent's basis", async () => {
    await load()
    await writeRow(slots, "codex", "linear", { kind: "disable" })
    expect(applied).toEqual([
      {
        basis: { codex: "basis-codex-1" },
        ops: [
          {
            agent: "codex",
            key: "linear",
            action: "set_enabled",
            enabled: false,
          },
        ],
        preflight: false,
      },
    ])
  })

  it("keeps that agent busy until the read after the write has landed", async () => {
    await load()
    const read = deferred<McpInventory>()
    mocks.call.mockImplementation(async (command: string, args: unknown) => {
      if (command === "mcp_inventory") return read.promise
      applied.push(args as McpApplyArgs)
      return appliedOf((args as McpApplyArgs).ops)
    })
    await writeRow(slots, "codex", "linear", { kind: "disable" })
    expect(isAgentBusy(slots.get(MCP_BUSY), "codex")).toBe(true)
    expect(isAgentBusy(slots.get(MCP_BUSY), "claude_code")).toBe(false)
    expect(slots.get(MCP_ROW_WRITES)[rowId("codex", "linear")].phase).toBe(
      "saved"
    )
    read.resolve(current)
    await vi.waitFor(() =>
      expect(isAgentBusy(slots.get(MCP_BUSY), "codex")).toBe(false)
    )
    expect(slots.get(MCP_ROW_WRITES)[rowId("codex", "linear")]).toBeUndefined()
  })

  it("keeps a row's failure, with the engine's answer", async () => {
    await load()
    answer = () => ({
      outcome: "busy",
      ok: false,
      agents: [
        {
          ...preflightOf([{ agent: "codex", key: "linear", action: "remove" }])
            .agents[0],
          status: "not_written",
          basis: null,
          issues: [{ code: "lock_busy" }],
        },
      ],
    })
    await writeRow(slots, "codex", "linear", { kind: "remove" })
    const row = slots.get(MCP_ROW_WRITES)[rowId("codex", "linear")]
    expect(row.phase).toBe("failed")
    expect(row.result?.outcome).toBe("busy")
  })
})

describe("a dialog's save", () => {
  it("edits one definition for its own agents, then commits with the preflight's basis", async () => {
    await load()
    const fingerprint =
      slots.get(MCP_INVENTORY).inventory!.agents[1].entries[0].fingerprint!
    expect(openEditEditor(slots, "linear", fingerprint)).toBe(true)
    const id = slots.get(MCP_DIALOG)!.id
    updateEditorDraft(slots, id, (draft) => ({
      ...draft,
      url: "https://b.test/mcp",
    }))
    answer = (args) => {
      const result = args.preflight
        ? preflightOf(args.ops)
        : appliedOf(args.ops)
      if (args.preflight) result.agents[0].basis = "basis-codex-seen"
      return result
    }
    await reviewDialog(slots, id)
    expect(applied[0]).toEqual({
      basis: { codex: "basis-codex-1" },
      ops: [
        {
          agent: "codex",
          key: "linear",
          action: "set",
          definition: { type: "http", url: "https://b.test/mcp" },
        },
      ],
      preflight: true,
    })
    await commitDialog(slots, id)
    expect(applied[1]).toMatchObject({
      basis: { codex: "basis-codex-seen" },
      preflight: false,
    })
    const dialog = slots.get(MCP_DIALOG)
    expect(dialog?.kind === "editor" && dialog.flow.step).toBe("result")
  })

  it("reads the files again and asks once more when one changed elsewhere", async () => {
    await load()
    openRemoveDialog(slots, "linear")
    const id = slots.get(MCP_DIALOG)!.id
    let preflights = 0
    answer = (args) => {
      if (!args.preflight) return appliedOf(args.ops)
      preflights++
      if (preflights === 1) {
        return {
          outcome: "changed_elsewhere",
          ok: false,
          agents: [
            {
              ...preflightOf(args.ops).agents[0],
              status: "changed_elsewhere",
              basis: "basis-claude_code-2",
              issues: [{ code: "basis_mismatch" }],
            },
          ],
        }
      }
      return preflightOf(args.ops)
    }
    const reads = mocks.call.mock.calls.filter(
      ([name]) => name === "mcp_inventory"
    ).length
    current = inventory([
      agent("claude_code", [entry("linear", remote("sse"))], {
        config: { basis: "basis-claude_code-2" },
      }),
      agent("codex", [entry("linear", remote("http"))]),
      agent("gemini", [entry("linear", remote("sse"))]),
    ])
    await reviewDialog(slots, id)
    expect(
      mocks.call.mock.calls.filter(([name]) => name === "mcp_inventory").length
    ).toBe(reads + 1)
    expect(applied[1].basis).toMatchObject({
      claude_code: "basis-claude_code-2",
    })
    const dialog = slots.get(MCP_DIALOG)
    expect(dialog?.kind === "remove" && dialog.flow.notice).toBe(
      "changedElsewhere"
    )
    expect(dialog?.kind === "remove" && dialog.flow.preflight?.ok).toBe(true)
  })

  it("removes from the ticked agents only", async () => {
    await load()
    openRemoveDialog(slots, "linear")
    const id = slots.get(MCP_DIALOG)!.id
    updateDialog(slots, id, "remove", (dialog) => ({
      ...dialog,
      agents: ["gemini"],
    }))
    await reviewDialog(slots, id)
    expect(applied[0].ops).toEqual([
      { agent: "gemini", key: "linear", action: "remove" },
    ])
  })

  it("renames in every agent that has it, and follows the new name", async () => {
    await load()
    slots.set(MCP_SELECTED_SERVER, "linear")
    openRenameDialog(slots, "linear")
    const id = slots.get(MCP_DIALOG)!.id
    updateDialog(slots, id, "rename", (dialog) => ({
      ...dialog,
      newKey: "issues",
    }))
    await reviewDialog(slots, id)
    expect(applied[0].ops).toEqual(
      ["claude_code", "codex", "gemini"].map((id) => ({
        agent: id,
        key: "linear",
        action: "rename",
        new_key: "issues",
      }))
    )
    await commitDialog(slots, id)
    expect(slots.get(MCP_SELECTED_SERVER)).toBe("issues")
  })

  it("does not commit a preflight that says something cannot be written", async () => {
    await load()
    openRemoveDialog(slots, "linear")
    const id = slots.get(MCP_DIALOG)!.id
    answer = (args) => ({
      ...preflightOf(args.ops, {
        codex: { status: "invalid", issues: [{ code: "edit_failed" }] },
      }),
    })
    await reviewDialog(slots, id)
    await commitDialog(slots, id)
    expect(applied.filter((args) => !args.preflight)).toHaveLength(0)
  })
})

describe("stdio", () => {
  it("is a definition the fixtures can build", () => {
    expect(stdio().type).toBe("stdio")
  })
})
