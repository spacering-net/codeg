/**
 * The task board's keyword search: what a task is found by, and — as much
 * the point — what it is NOT found by.
 */
import { describe, expect, it } from "vitest"

import type { WorkTask } from "@/lib/types"

import { searchTerms, taskMatchesSearch } from "./task-search"

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix the retry path",
    config: {
      prompt_blocks: [],
      display_text: "Retries give up after one attempt; make it three.",
      config_values: {},
    },
    status: "todo",
    work_branch: "task/7",
    base_branch: "main",
    agent_type: "claude_code",
    source_meta: null,
    ...overrides,
  } as WorkTask
}

const forgeTask = (overrides: Partial<WorkTask> = {}) =>
  task({
    id: 31,
    title: "#128 · Login times out on slow networks",
    config: {
      prompt_blocks: [],
      config_values: {},
      // The panel's built-in instruction — shared by every forge task.
      display_text:
        "Handle issue #128 (https://github.com/acme/app/issues/128): judge the report first, then fix it.",
    },
    source_kind: "forge_issue",
    source_meta: {
      provider: "github",
      server_host: "github.com",
      api_base: "https://api.github.com",
      account_id: "acc",
      owner_repo: "acme/app",
      number: 128,
      url: "https://github.com/acme/app/issues/128",
      title: "Login times out on slow networks",
    },
    ...overrides,
  })

const matches = (row: WorkTask, query: string, folder: string | null = null) =>
  taskMatchesSearch(row, searchTerms(query), folder)

describe("searchTerms", () => {
  it("splits on whitespace and lower-cases", () => {
    expect(searchTerms("  Retry   PATH ")).toEqual(["retry", "path"])
    expect(searchTerms("   ")).toEqual([])
  })
})

describe("taskMatchesSearch", () => {
  it("matches everything when there is nothing to search for", () => {
    expect(matches(task(), "")).toBe(true)
  })

  it("finds a task by title, description, branch, folder and agent", () => {
    expect(matches(task(), "retry")).toBe(true)
    expect(matches(task(), "RETRY Path")).toBe(true)
    expect(matches(task(), "three")).toBe(true)
    expect(matches(task(), "task/7")).toBe(true)
    expect(matches(task(), "codeg", "codeg-desktop")).toBe(true)
    expect(matches(task(), "claude")).toBe(true)
  })

  /** A search box narrows: two words mean both. */
  it("requires every term to match", () => {
    expect(matches(task(), "retry three")).toBe(true)
    expect(matches(task(), "retry deploy")).toBe(false)
  })

  /** `#7` is exact; a bare `7` is a substring like any other word. */
  it("treats #number as an exact task or item number", () => {
    expect(matches(task(), "#7")).toBe(true)
    expect(matches(task({ id: 17 }), "#7")).toBe(false)
    expect(matches(task({ id: 17 }), "7")).toBe(true)
    expect(matches(forgeTask(), "#128")).toBe(true)
    expect(matches(forgeTask(), "#31")).toBe(true)
    expect(matches(forgeTask(), "#12")).toBe(false)
  })

  it("finds a forge task by its repository and its item", () => {
    expect(matches(forgeTask(), "acme/app")).toBe(true)
    expect(matches(forgeTask(), "acme/app#128")).toBe(true)
    expect(matches(forgeTask(), "slow networks")).toBe(true)
  })

  /** The built-in instruction every forge task carries is not searched —
   *  otherwise "judge" or "report" would match all of them. */
  it("does not search a forge task's built-in instruction text", () => {
    expect(matches(forgeTask(), "judge")).toBe(false)
    expect(matches(forgeTask(), "report")).toBe(false)
    // …while a task someone wrote is found by its description.
    expect(matches(task(), "attempt")).toBe(true)
  })

  it("survives a task with no config or branch", () => {
    const bare = task({ config: null, work_branch: null, base_branch: null })
    expect(matches(bare, "retry")).toBe(true)
    expect(matches(bare, "main")).toBe(false)
  })
})
