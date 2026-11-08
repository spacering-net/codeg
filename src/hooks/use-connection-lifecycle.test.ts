import { describe, expect, it } from "vitest"
import { shouldDisconnectOnUnmount } from "@/hooks/use-connection-lifecycle"
import type { AsyncTaskRecord } from "@/lib/types"

// Unmount cleanup (tab closed) must not kill an owner whose agent still has
// work in flight: disconnecting kills the agent CLI, and any launched
// background tasks with it. Busy owners are reclaimed by the idle sweeps —
// which exempt them only while that work is live — so once the work settles
// the connection becomes sweep-eligible again through the SAME predicate
// flipping to true on the next idle pass.

/** An idle owner between turns: nothing in flight on any channel. */
const IDLE_OWNER = {
  status: "connected",
  isViewer: false,
  backgroundOutstanding: 0,
  asyncTasks: [] as AsyncTaskRecord[],
  remoteControl: null,
  delegatedChildren: [] as string[],
}

function asyncTask(state: string): AsyncTaskRecord {
  return {
    task_id: "call_bg_1",
    name: "npm run dev",
    task_type: "shell",
    description: "",
    show_in_transcript: false,
    can_stop: true,
    state,
  }
}

describe("shouldDisconnectOnUnmount", () => {
  it("keeps an owner alive while background work is outstanding", () => {
    expect(
      shouldDisconnectOnUnmount({ ...IDLE_OWNER, backgroundOutstanding: 2 })
    ).toBe(false)
  })

  it("keeps a prompting owner alive (existing behavior)", () => {
    expect(
      shouldDisconnectOnUnmount({ ...IDLE_OWNER, status: "prompting" })
    ).toBe(false)
  })

  // The AIR half of the rule: a codex background terminal or a Claude Monitor
  // task is announced on the async-task channel only, so the watcher's count
  // stays 0 while it runs.
  it("keeps an owner alive while an async task is running or paused", () => {
    for (const state of ["running", "paused"]) {
      expect(
        shouldDisconnectOnUnmount({
          ...IDLE_OWNER,
          asyncTasks: [asyncTask(state)],
        })
      ).toBe(false)
    }
  })

  it("disconnects an owner whose async tasks have all settled", () => {
    expect(
      shouldDisconnectOnUnmount({
        ...IDLE_OWNER,
        asyncTasks: ["completed", "failed", "stopped"].map(asyncTask),
      })
    ).toBe(true)
  })

  // Remote Control runs in the agent CLI; the user handed the session to
  // claude.ai/code or a phone, so closing the tab must not end it there.
  it("keeps an owner alive while Remote Control is on", () => {
    expect(
      shouldDisconnectOnUnmount({
        ...IDLE_OWNER,
        remoteControl: { session_url: null },
      })
    ).toBe(false)
  })

  // A codeg delegation outlives the turn that started it, and ending the
  // parent cancels every sub-agent it still has running.
  it("keeps an owner alive while a delegated sub-agent is running", () => {
    expect(
      shouldDisconnectOnUnmount({
        ...IDLE_OWNER,
        delegatedChildren: ["child-conn"],
      })
    ).toBe(false)
  })

  it("disconnects an idle owner once outstanding has settled to zero", () => {
    expect(shouldDisconnectOnUnmount(IDLE_OWNER)).toBe(true)
  })

  it("always tears down viewers — their disconnect only detaches", () => {
    expect(
      shouldDisconnectOnUnmount({
        ...IDLE_OWNER,
        status: "prompting",
        isViewer: true,
        backgroundOutstanding: 5,
        asyncTasks: [asyncTask("running")],
        remoteControl: { session_url: null },
        delegatedChildren: ["child-conn"],
      })
    ).toBe(true)
  })

  // A transient unmount (the tab was REPARENTED across split groups, not
  // closed) never disconnects: the remounted view re-attaches to the same
  // connection under the same contextKey.
  it("keeps an idle owner alive across a transient (reparent) unmount", () => {
    expect(
      shouldDisconnectOnUnmount({ ...IDLE_OWNER, transientUnmount: true })
    ).toBe(false)
  })

  it("keeps a viewer attached across a transient (reparent) unmount", () => {
    expect(
      shouldDisconnectOnUnmount({
        ...IDLE_OWNER,
        isViewer: true,
        transientUnmount: true,
      })
    ).toBe(false)
  })

  it("explicit transientUnmount=false preserves the close-path behavior", () => {
    expect(
      shouldDisconnectOnUnmount({ ...IDLE_OWNER, transientUnmount: false })
    ).toBe(true)
  })
})
