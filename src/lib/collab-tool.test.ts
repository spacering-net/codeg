import { describe, expect, it } from "vitest"

import {
  isCodexCollabInput,
  parseCollabToolInput,
  mergeCollabOp,
  classifyCollabStatus,
  isErrorCollabStatusKind,
  classifyCollabOp,
  mergeCollabAgentStatus,
  isCodexThreadId,
  shortAgentId,
  COLLAB_AGENT_TOOL_NAME,
  COLLAB_OP_KEY,
} from "./collab-tool"

// A realistic codex collab tool call rawInput (codex-acp 1.0.1 mapper shape):
// agentsStates is a map keyed by sub-agent threadId → { status, message }.
// model/reasoningEffort are top-level siblings (codex-acp #304).
const collabRaw = JSON.stringify({
  prompt: "在 /Users/x/work/my-app 中运行 `pnpm build`。",
  senderThreadId: "019f06e2-aaaa",
  receiverThreadIds: ["019f06e3-bbbb"],
  agentsStates: {
    "019f06e3-bbbb": { status: "running", message: "Checking weather" },
  },
  model: "gpt-5-codex",
  reasoningEffort: "high",
  status: "inProgress",
})

describe("isCodexCollabInput", () => {
  it("detects the inter-agent rawInput shape", () => {
    expect(isCodexCollabInput(collabRaw)).toBe(true)
  })

  it("detects even when prompt and receiverThreadIds are empty", () => {
    expect(
      isCodexCollabInput(
        JSON.stringify({
          prompt: "",
          senderThreadId: "t1",
          receiverThreadIds: [],
          agentsStates: {},
          status: "completed",
        })
      )
    ).toBe(true)
  })

  it("rejects regular tool inputs and non-objects", () => {
    expect(
      isCodexCollabInput(
        JSON.stringify({ agent_type: "worker", message: "do it" })
      )
    ).toBe(false)
    expect(
      isCodexCollabInput(
        JSON.stringify({ senderThreadId: "t1", receiverThreadIds: [] })
      )
    ).toBe(false)
    expect(isCodexCollabInput(null)).toBe(false)
    expect(isCodexCollabInput("not json")).toBe(false)
    expect(isCodexCollabInput("[1,2,3]")).toBe(false)
  })
})

describe("parseCollabToolInput", () => {
  it("extracts prompt, op status, op (null by default), model/effort, and per-agent states", () => {
    expect(parseCollabToolInput(collabRaw)).toEqual({
      prompt: "在 /Users/x/work/my-app 中运行 `pnpm build`。",
      status: "inProgress",
      op: null,
      model: "gpt-5-codex",
      reasoningEffort: "high",
      agents: [
        {
          threadId: "019f06e3-bbbb",
          status: "running",
          message: "Checking weather",
        },
      ],
    })
  })

  it("reads top-level model and reasoningEffort (codex-acp #304)", () => {
    const info = parseCollabToolInput(collabRaw)
    expect(info?.model).toBe("gpt-5-codex")
    expect(info?.reasoningEffort).toBe("high")
  })

  it("treats absent or blank model/effort as null (not per-agent)", () => {
    const info = parseCollabToolInput(
      JSON.stringify({
        senderThreadId: "t1",
        receiverThreadIds: ["t2"],
        // model/effort blank at top level; a per-agent field must NOT be read.
        model: "   ",
        agentsStates: { t2: { status: "running", model: "ignored-per-agent" } },
      })
    )
    expect(info?.model).toBeNull()
    expect(info?.reasoningEffort).toBeNull()
  })

  it("reads the merged op key", () => {
    const withOp = JSON.stringify({
      prompt: "",
      senderThreadId: "t1",
      receiverThreadIds: ["t2"],
      agentsStates: { t2: { status: "completed", message: null } },
      status: "completed",
      [COLLAB_OP_KEY]: "wait",
    })
    expect(parseCollabToolInput(withOp)?.op).toBe("wait")
  })

  it("treats a null/blank message as absent", () => {
    expect(
      parseCollabToolInput(
        JSON.stringify({
          prompt: "do it",
          senderThreadId: "t1",
          receiverThreadIds: ["t2"],
          agentsStates: { t2: { status: "completed", message: null } },
          status: "completed",
        })
      )
    ).toEqual({
      prompt: "do it",
      status: "completed",
      op: null,
      model: null,
      reasoningEffort: null,
      agents: [{ threadId: "t2", status: "completed", message: null }],
    })
  })

  it("returns null prompt/op when absent or blank", () => {
    expect(
      parseCollabToolInput(
        JSON.stringify({
          prompt: "   ",
          senderThreadId: "t1",
          receiverThreadIds: [],
          agentsStates: {},
        })
      )
    ).toEqual({
      prompt: null,
      status: null,
      op: null,
      model: null,
      reasoningEffort: null,
      agents: [],
    })
  })

  it("yields no agent rows when agentsStates is missing, an array, or malformed", () => {
    expect(
      parseCollabToolInput(
        JSON.stringify({ agentsStates: [{ threadId: "x" }] })
      )?.agents
    ).toEqual([])
    expect(
      parseCollabToolInput(
        JSON.stringify({ agentsStates: { a: "running", b: { status: "x" } } })
      )?.agents
    ).toEqual([{ threadId: "b", status: "x", message: null }])
  })

  it("returns null for non-objects", () => {
    expect(parseCollabToolInput(null)).toBeNull()
    expect(parseCollabToolInput("nope")).toBeNull()
  })
})

describe("mergeCollabOp", () => {
  it("merges the op into the rawInput JSON under COLLAB_OP_KEY", () => {
    const merged = mergeCollabOp(collabRaw, "spawnAgent")
    expect(merged).not.toBeNull()
    const parsed = JSON.parse(merged as string)
    expect(parsed[COLLAB_OP_KEY]).toBe("spawnAgent")
    // round-trips through the parser
    expect(parseCollabToolInput(merged)?.op).toBe("spawnAgent")
    // original fields preserved (agents + #304 model/effort)
    expect(parseCollabToolInput(merged)?.agents).toHaveLength(1)
    expect(parseCollabToolInput(merged)?.model).toBe("gpt-5-codex")
    expect(parseCollabToolInput(merged)?.reasoningEffort).toBe("high")
  })

  it("returns null when there is no op or the input is not a JSON object", () => {
    expect(mergeCollabOp(collabRaw, null)).toBeNull()
    expect(mergeCollabOp(collabRaw, "  ")).toBeNull()
    expect(mergeCollabOp("not json", "wait")).toBeNull()
    expect(mergeCollabOp("[1,2]", "wait")).toBeNull()
  })
})

describe("classifyCollabStatus", () => {
  it("maps the full CollabAgentStatus enum + op status", () => {
    expect(classifyCollabStatus("pendingInit")).toBe("pending")
    expect(classifyCollabStatus("running")).toBe("running")
    expect(classifyCollabStatus("inProgress")).toBe("running")
    expect(classifyCollabStatus("completed")).toBe("completed")
    expect(classifyCollabStatus("shutdown")).toBe("closed")
    expect(classifyCollabStatus("interrupted")).toBe("interrupted")
    expect(classifyCollabStatus("errored")).toBe("failed")
    expect(classifyCollabStatus("failed")).toBe("failed")
    expect(classifyCollabStatus("notFound")).toBe("notFound")
    expect(classifyCollabStatus("somethingElse")).toBe("other")
    expect(classifyCollabStatus(null)).toBe("other")
  })

  it("flags only failed and notFound as errors", () => {
    expect(isErrorCollabStatusKind("failed")).toBe(true)
    expect(isErrorCollabStatusKind("notFound")).toBe(true)
    expect(isErrorCollabStatusKind("interrupted")).toBe(false)
    expect(isErrorCollabStatusKind("completed")).toBe(false)
    expect(isErrorCollabStatusKind("running")).toBe(false)
  })
})

describe("classifyCollabOp", () => {
  it("classifies camelCase ops (codex-acp 1.0.1 spelling)", () => {
    expect(classifyCollabOp("spawnAgent")).toBe("spawn")
    expect(classifyCollabOp("wait")).toBe("wait")
    expect(classifyCollabOp("closeAgent")).toBe("close")
    expect(classifyCollabOp("resumeAgent")).toBe("resume")
    expect(classifyCollabOp("listAgents")).toBe("list")
  })

  it("classifies snake_case ops (rollout / alias spelling)", () => {
    expect(classifyCollabOp("spawn_agent")).toBe("spawn")
    expect(classifyCollabOp("wait_agent")).toBe("wait")
    expect(classifyCollabOp("close_agent")).toBe("close")
    expect(classifyCollabOp("resume_agent")).toBe("resume")
    // The rollout parser writes the short op, the live title is the tool name.
    expect(classifyCollabOp("list")).toBe("list")
    expect(classifyCollabOp("list_agents")).toBe("list")
  })

  it("maps sendInput / unknown / null to other", () => {
    expect(classifyCollabOp("sendInput")).toBe("other")
    expect(classifyCollabOp("something")).toBe("other")
    expect(classifyCollabOp(null)).toBe("other")
  })
})

describe("mergeCollabAgentStatus", () => {
  it("lifts spawn pendingInit to the agent's later running/completed state", () => {
    // The whole point: spawn froze at pendingInit; a later wait reports running.
    expect(mergeCollabAgentStatus(["pendingInit", "running"])).toBe("running")
    // …and completed once the wait returns.
    expect(
      mergeCollabAgentStatus(["pendingInit", "running", "completed"])
    ).toBe("completed")
  })

  it("prioritises errors over everything", () => {
    expect(mergeCollabAgentStatus(["running", "errored"])).toBe("errored")
    expect(mergeCollabAgentStatus(["completed", "notFound"])).toBe("notFound")
  })

  it("prefers completed over a later close (shutdown)", () => {
    expect(mergeCollabAgentStatus(["completed", "shutdown"])).toBe("completed")
  })

  it("uses closed when there is no completed", () => {
    expect(mergeCollabAgentStatus(["pendingInit", "shutdown"])).toBe("shutdown")
  })

  it("falls back to the last non-empty raw status, else null", () => {
    expect(mergeCollabAgentStatus(["weird-a", "weird-b"])).toBe("weird-b")
    expect(mergeCollabAgentStatus([null, "  ", undefined])).toBeNull()
    expect(mergeCollabAgentStatus([])).toBeNull()
  })
})

describe("isCodexThreadId", () => {
  it("accepts a codex thread id (which is also its rollout's filename id)", () => {
    expect(isCodexThreadId("019f07aa-f57b-7c61-9a86-c93236cee0dc")).toBe(true)
    expect(isCodexThreadId("01A07FC2-DB62-78B3-9762-9CB2540216C2")).toBe(true)
  })

  it("rejects the agent NAMES that key a list_agents roster", () => {
    // `build_collab_list_input` keys `agentsStates` by `agent_name`, so a
    // session entry point built on those keys would open nothing.
    expect(isCodexThreadId("pnpm_build")).toBe(false)
    expect(isCodexThreadId("history_limits")).toBe(false)
    expect(isCodexThreadId("/root")).toBe(false)
  })

  it("rejects partial / malformed ids rather than guessing", () => {
    expect(isCodexThreadId("019f06e3-bbbb")).toBe(false)
    expect(isCodexThreadId("")).toBe(false)
    expect(isCodexThreadId("019f07aa-f57b-7c61-9a86-c93236cee0dc-extra")).toBe(
      false
    )
  })
})

describe("shortAgentId", () => {
  it("returns the first UUID segment", () => {
    expect(shortAgentId("019f07aa-f57b-7c61-9a86-c93236cee0dc")).toBe(
      "019f07aa"
    )
  })

  it("returns the whole string when there is no dash", () => {
    expect(shortAgentId("t-sub".replace("-", ""))).toBe("tsub")
    expect(shortAgentId("nodash")).toBe("nodash")
  })
})

describe("constants", () => {
  it("exposes the canonical tool name and op key", () => {
    expect(COLLAB_AGENT_TOOL_NAME).toBe("collab_agent")
    expect(COLLAB_OP_KEY).toBe("__codegCollabOp")
  })
})
