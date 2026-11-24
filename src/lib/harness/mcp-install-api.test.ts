import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
}))

import { HarnessClientError, harnessFailureOf } from "./errors"
import {
  harnessInstalled,
  harnessMcpInstall,
  harnessMcpPlan,
  harnessMcpUninstall,
  onHarnessInstalledChanged,
} from "./mcp-install-api"
import {
  rawInstallResult,
  rawInstalledItem,
  rawPlan,
  rawSnapshot,
  rawStdioOption,
} from "./mcp-install-fixtures"
import {
  normalizeMcpPlan,
  normalizeVersionState,
} from "./mcp-install-normalize"

beforeEach(() => {
  mocks.call.mockReset()
})

describe("the install commands", () => {
  it("names each command and its arguments as the backend reads them", async () => {
    mocks.call.mockResolvedValueOnce(rawPlan())
    await harnessMcpPlan("acme.dev/notes")
    mocks.call.mockResolvedValueOnce(rawPlan())
    await harnessMcpPlan("acme.dev/notes", 2)
    mocks.call.mockResolvedValueOnce({ mcp: [] })
    await harnessInstalled()
    mocks.call.mockResolvedValueOnce({ outcome: "preflight", agents: [] })
    await harnessMcpUninstall({ itemId: "item-notes", preflight: true })
    expect(mocks.call.mock.calls).toEqual([
      ["harness_mcp_plan", { itemRef: "acme.dev/notes", revision: null }],
      ["harness_mcp_plan", { itemRef: "acme.dev/notes", revision: 2 }],
      ["harness_installed"],
      [
        "harness_mcp_uninstall",
        {
          itemId: "item-notes",
          agents: null,
          removeChanged: [],
          basis: {},
          preflight: true,
        },
      ],
    ])
  })

  it("refuses an address that cannot be one before it leaves", async () => {
    await expect(harnessMcpPlan("not an address")).rejects.toBeInstanceOf(
      HarnessClientError
    )
    await expect(
      harnessMcpInstall({
        itemRef: "../x",
        revision: 1,
        optionId: "o",
        values: {},
        key: "k",
        agents: ["claude_code"],
        replace: [],
        stateSha256: "s",
        basis: {},
        acceptYanked: false,
      })
    ).rejects.toBeInstanceOf(HarnessClientError)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it("refuses an answer that is not a plan, an install result or a listing", async () => {
    mocks.call.mockResolvedValue("nope")
    await expect(harnessMcpPlan("acme.dev/notes")).rejects.toMatchObject({
      kind: "invalidResponse",
    })
    await expect(harnessInstalled()).rejects.toMatchObject({
      kind: "invalidResponse",
    })
  })

  it("rejects, rather than throws, where the transport has no events", async () => {
    await expect(onHarnessInstalledChanged(() => {})).rejects.toBeTruthy()
  })
})

describe("reading the answers", () => {
  it("keeps codes and values this build does not know, as they came", () => {
    const plan = normalizeMcpPlan(
      rawPlan({
        blocking: [{ code: "something_new", params: { a: "1" }, detail: "x" }],
        item_status: "archived",
        snapshot: rawSnapshot({ status: "frozen", risk: "extreme" }),
      })
    )
    expect(plan.blocking).toEqual([
      { code: "something_new", params: { a: "1" }, detail: "x" },
    ])
    expect(plan.item_status).toBe("archived")
    expect(plan.snapshot?.status).toBe("frozen")
    expect(plan.snapshot?.risk).toBe("extreme")
  })

  it("never makes an option choosable that came with a reason not to be", () => {
    const plan = normalizeMcpPlan(
      rawPlan({
        options: [
          rawStdioOption({ selectable: true, blocking: [{ code: "x" }] }),
          rawStdioOption({ id: "b", selectable: "yes" }),
        ],
      })
    )
    expect(plan.options.map((option) => option.selectable)).toEqual([
      false,
      false,
    ])
  })

  it("leaves a part the catalog left out as not stated, never as fine", () => {
    const state = normalizeVersionState({ revision: 3 })
    expect(state).toEqual({
      revision: 3,
      status: "unknown",
      risk: null,
      reviewed: null,
      permissions: null,
      checks: null,
      packages: null,
      stateSha256: null,
    })
    expect(normalizeVersionState(null)).toBeNull()
  })

  it("masks a parameter whose secrecy is not said", () => {
    const plan = normalizeMcpPlan(
      rawPlan({
        options: [
          rawStdioOption({
            parameters: [{ key: "env.X", name: "X", location: "env" }],
          }),
        ],
      })
    )
    expect(plan.options[0].parameters[0]).toMatchObject({
      secret: true,
      required: false,
      kind: "string",
    })
  })

  it("reads an install result's engine report as mcp_apply's, and drops one it cannot read", async () => {
    mocks.call.mockResolvedValueOnce(
      rawInstallResult("busy", { apply: "garbled" })
    )
    const result = await harnessMcpInstall({
      itemRef: "acme.dev/notes",
      revision: 3,
      optionId: "o",
      values: {},
      key: "notes",
      agents: ["claude_code"],
      replace: [],
      stateSha256: "s",
      basis: { claude_code: "b" },
      acceptYanked: false,
    })
    expect(result.outcome).toBe("busy")
    expect(result.apply).toBeNull()
  })

  it("lists installed items, dropping entries that name no item or key", async () => {
    mocks.call.mockResolvedValueOnce({
      mcp: [rawInstalledItem(), { id: "", key: "x" }, "junk"],
    })
    const listing = await harnessInstalled()
    expect(listing.mcp.map((item) => item.key)).toEqual(["notes"])
  })
})

describe("reading what the dialog's follow-up fields carry", () => {
  it("reads recovered values, choices, recovery, agents' reasons and entries", () => {
    const plan = normalizeMcpPlan(
      rawPlan({
        options: [
          rawStdioOption({
            parameters: [
              {
                key: "env.REGION",
                name: "REGION",
                location: "env",
                secret: false,
                choices: ["eu", 7, "us", null],
                current: {
                  value: "eu",
                  agents: ["claude_code"],
                  conflicting: false,
                },
              },
            ],
            recovery: {
              from: ["claude_code"],
              unmatched: ["codex"],
              lost: [{ key: "variables.tenant", agents: ["claude_code"] }, {}],
            },
          }),
        ],
        agents: [
          {
            agent: "cline",
            writable: false,
            status: "unreadable",
            reason: { code: "invalid_json", detail: "line 3" },
            entries: [
              { key: "notes", owner: "other_item", item_ref: "x.dev/notes" },
              { owner: "elsewhere" },
            ],
          },
        ],
      })
    )
    const parameter = plan.options[0].parameters[0]
    expect(parameter.choices).toEqual(["eu", "us"])
    expect(parameter.current).toEqual({
      value: "eu",
      agents: ["claude_code"],
      conflicting: false,
    })
    expect(plan.options[0].recovery).toEqual({
      from: ["claude_code"],
      unmatched: ["codex"],
      lost: [{ key: "variables.tenant", agents: ["claude_code"] }],
    })
    expect(plan.agents[0].reason).toEqual({
      code: "invalid_json",
      detail: "line 3",
    })
    expect(plan.agents[0].entries).toEqual([
      {
        key: "notes",
        owner: "other_item",
        item_id: null,
        item_ref: "x.dev/notes",
      },
    ])
  })

  it("reads an older answer without them as having none", () => {
    const raw = rawPlan()
    const options = raw.options as Record<string, unknown>[]
    delete options[0].recovery
    delete (options[0].parameters as Record<string, unknown>[])[0].current
    const plan = normalizeMcpPlan(raw)
    expect(plan.options[0].recovery).toBeNull()
    expect(plan.options[0].parameters[0].current).toBeNull()
    expect(plan.agents[0].reason).toBeNull()
  })

  it("reads an installed item's title, or none from an older record", async () => {
    mocks.call.mockResolvedValueOnce({
      mcp: [
        rawInstalledItem(),
        rawInstalledItem({ id: "b", key: "b", title: null }),
      ],
    })
    const listing = await harnessInstalled()
    expect(listing.mcp.map((item) => item.title)).toEqual([
      { en: "Acme Notes" },
      null,
    ])
  })
})

describe("failures", () => {
  it("tells an unreadable record apart, with why", () => {
    expect(
      harnessFailureOf({
        code: "io_error",
        message: "record",
        detail: "unexpected end of file",
        i18n_key: "Harness.errors.recordUnreadable",
      })
    ).toEqual({ kind: "recordUnreadable", detail: "unexpected end of file" })
  })

  it("tells an older Codeg apart from the catalog being switched off", () => {
    expect(
      harnessFailureOf({ code: "not_implemented", message: "x" }).kind
    ).toBe("unsupported")
    expect(
      harnessFailureOf({
        code: "network_error",
        message: "harness disabled",
        i18n_key: "Harness.errors.disabled",
      }).kind
    ).toBe("disabled")
  })
})
