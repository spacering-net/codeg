import { describe, expect, it } from "vitest"

import {
  adoptUnknownAsyncTasks,
  isAsyncTaskTerminal,
  liveAsyncTasks,
  mergeAsyncTasks,
  upsertAsyncTask,
} from "./async-tasks"
import type { AsyncTaskDelta, AsyncTaskRecord } from "@/lib/types"

function delta(
  task_id: string,
  spawned: boolean,
  rest: Partial<AsyncTaskDelta> = {}
): AsyncTaskDelta {
  return { task_id, spawned, ...rest }
}

const SPAWN = delta("t1", true, {
  name: "pnpm test",
  task_type: "shell",
  description: "pnpm test --watch",
  show_in_transcript: false,
  can_stop: true,
})

describe("upsertAsyncTask", () => {
  it("creates a row only from a spawn delta", () => {
    // The spawn frame is the ONLY one carrying name/type/stop affordance, so a
    // progress delta for an id we never saw announced means we missed that
    // frame — a nameless placeholder row would be worse than none.
    expect(
      upsertAsyncTask([], delta("ghost", false, { state: "running" }))
    ).toHaveLength(0)

    const created = upsertAsyncTask([], SPAWN)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      task_id: "t1",
      name: "pnpm test",
      task_type: "shell",
      show_in_transcript: false,
      can_stop: true,
      // A spawn frame carries no state; the row starts live.
      state: "running",
    })
  })

  it("returns the same reference when nothing changed", () => {
    const current: AsyncTaskRecord[] = []
    expect(upsertAsyncTask(current, delta("ghost", false))).toBe(current)
  })

  it("revises only the fields a delta carries", () => {
    // Absent means UNCHANGED, never "clear it": the first progress tick would
    // otherwise blank the task's name and type.
    let tasks = upsertAsyncTask([], SPAWN)
    tasks = upsertAsyncTask(
      tasks,
      delta("t1", false, {
        last_tool_name: "Bash",
        usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4500 },
        output_file_path: "/tmp/tasks/t1.output",
      })
    )
    expect(tasks[0]).toMatchObject({
      name: "pnpm test",
      task_type: "shell",
      last_tool_name: "Bash",
      output_file_path: "/tmp/tasks/t1.output",
    })
    expect(tasks[0].usage?.total_tokens).toBe(1200)
  })

  it("lets a late correction revise a settled task", () => {
    // The adapter infers `stopped` from its liveness level and corrects it when
    // the authoritative edge arrives. Retaining the row is what makes that a
    // revision instead of a resurrection.
    let tasks = upsertAsyncTask([], SPAWN)
    tasks = upsertAsyncTask(tasks, delta("t1", false, { state: "stopped" }))
    expect(liveAsyncTasks(tasks)).toHaveLength(0)
    tasks = upsertAsyncTask(
      tasks,
      delta("t1", false, { state: "completed", summary: "all green" })
    )
    expect(tasks).toHaveLength(1)
    expect(tasks[0].state).toBe("completed")
    expect(tasks[0].summary).toBe("all green")
    // Still the announced task, not a nameless re-creation.
    expect(tasks[0].name).toBe("pnpm test")
  })

  it("clears a Grok workflow's agent with the empty string, not absence", () => {
    // Grok restates its whole run on every frame, so each one is a spawn and
    // an agent that finished comes back as "" — absent would still mean
    // unchanged, and the finished agent would stick to the row.
    const frame = (rest: Partial<AsyncTaskDelta>) =>
      delta("wf_1", true, {
        name: "deep-research",
        task_type: "workflow",
        can_stop: false,
        state: "running",
        ...rest,
      })
    let tasks = upsertAsyncTask(
      [],
      frame({ phase: "Research", current_agent: "researcher-2" })
    )
    expect(tasks[0]).toMatchObject({
      phase: "Research",
      current_agent: "researcher-2",
    })
    tasks = upsertAsyncTask(
      tasks,
      frame({ phase: "Verify", current_agent: "" })
    )
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ phase: "Verify", current_agent: "" })
  })
})

describe("mergeAsyncTasks", () => {
  it("seeds rows a client attached too late to see announced", () => {
    const snapshot: AsyncTaskRecord[] = [
      {
        task_id: "t1",
        name: "pnpm test",
        task_type: "shell",
        description: "",
        show_in_transcript: true,
        can_stop: true,
        state: "running",
      },
    ]
    const merged = mergeAsyncTasks([], snapshot)
    expect(merged).toHaveLength(1)
    expect(merged[0].task_id).toBe("t1")
  })

  it("replaces by id rather than appending a duplicate", () => {
    // The snapshot is the BACKEND's merge of every delta, so it wins outright —
    // unlike a live delta, it is a whole row, not a patch.
    const current = upsertAsyncTask([], SPAWN)
    const merged = mergeAsyncTasks(current, [
      { ...current[0], state: "completed" },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].state).toBe("completed")
  })

  it("returns the same reference for an empty or absent table", () => {
    const current = upsertAsyncTask([], SPAWN)
    expect(mergeAsyncTasks(current, [])).toBe(current)
    expect(mergeAsyncTasks(current, undefined)).toBe(current)
  })
})

describe("adoptUnknownAsyncTasks", () => {
  it("never walks a finished task back to running", () => {
    // The stale branch's whole reason to exist. The client applied the terminal
    // delta at seq 11; the snapshot was taken at seq 10 and still says running.
    // Replacing by id would resurrect it, and the live event that would correct
    // it is already below the applied watermark — it is never replayed.
    const live = upsertAsyncTask(
      upsertAsyncTask([], SPAWN),
      delta("t1", false, { state: "completed", summary: "all green" })
    )
    const staleSnapshot: AsyncTaskRecord[] = [{ ...live[0], state: "running" }]

    const adopted = adoptUnknownAsyncTasks(live, staleSnapshot)
    expect(adopted).toBe(live)
    expect(adopted[0].state).toBe("completed")
    expect(adopted[0].summary).toBe("all green")
  })

  it("still adopts ids the client never saw announced", () => {
    // A client that attached mid-episode has no other source for work already
    // running, so "don't clobber" must not become "don't learn".
    const live = upsertAsyncTask([], SPAWN)
    const staleSnapshot: AsyncTaskRecord[] = [
      { ...live[0], state: "running" },
      { ...live[0], task_id: "t2", name: "deploy watch" },
    ]

    const adopted = adoptUnknownAsyncTasks(live, staleSnapshot)
    expect(adopted).toHaveLength(2)
    expect(adopted[1].task_id).toBe("t2")
    expect(adopted[0]).toBe(live[0])
  })

  it("returns the same reference for an empty or absent table", () => {
    const current = upsertAsyncTask([], SPAWN)
    expect(adoptUnknownAsyncTasks(current, [])).toBe(current)
    expect(adoptUnknownAsyncTasks(current, undefined)).toBe(current)
  })
})

describe("liveAsyncTasks", () => {
  it("shows running and paused, hides the terminal three", () => {
    const rows = ["running", "paused", "completed", "failed", "stopped"].map(
      (state, i) => ({ ...SPAWN, task_id: `t${i}`, state }) as AsyncTaskRecord
    )
    expect(liveAsyncTasks(rows).map((t) => t.state)).toEqual([
      "running",
      "paused",
    ])
    // An unrecognized future state counts as LIVE — hiding a task we can't
    // classify would silently drop work that is still running.
    expect(liveAsyncTasks([{ ...rows[0], state: "throttled" }])).toHaveLength(1)
    expect(isAsyncTaskTerminal({ ...rows[0], state: "throttled" })).toBe(false)
  })
})
