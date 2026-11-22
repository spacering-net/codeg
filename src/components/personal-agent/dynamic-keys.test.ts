/**
 * Messages whose key is built from a value the backend sends — a matter's
 * kind, a dispatch's state, a card's kind — each value written out here as
 * the backend has it, and a message there for every one. A value with no
 * message logs MISSING_MESSAGE each time it is drawn (a matter waiting on
 * another assistant's answer did, on every render of the side panel). The
 * records are typed by the unions the frontend has, so a value added to one
 * fails to compile here until it is listed — and then here until it has
 * its words.
 */

import { describe, expect, it } from "vitest"

import en from "@/i18n/messages/en.json"
import type {
  DispatchState,
  ItemKind,
  TodayReason,
  TodayRowKind,
} from "@/lib/types"

type Node = string | { [key: string]: Node }

function has(path: string): boolean {
  let node: Node = en as Node
  for (const part of path.split(".")) {
    if (typeof node === "string" || !(part in node)) return false
    node = node[part]
  }
  return typeof node === "string"
}

function missing(prefix: string, values: readonly string[]): string[] {
  return values.map((v) => `${prefix}.${v}`).filter((path) => !has(path))
}

/** Every kind of matter (`ItemKind` in personal_agent_item.rs). */
const ITEM_KINDS = {
  dispatch: true,
  reminder: true,
  followup: true,
  question: true,
  message: true,
  when_mentioned: true,
} satisfies Record<ItemKind, true>

/** Every dispatch state; the Today rows and the morning brief's "tonight"
 *  name each one that has not ended (brief.rs `dispatch_row`). */
const DISPATCH_STATES = {
  queued: true,
  running: true,
  waiting_input: true,
  review: true,
  handed_over: true,
  completed: false,
  failed: false,
  canceled: false,
  interrupted: false,
} satisfies Record<DispatchState, boolean>

/** The Today rows a kind's own words name (`today-section` `useRowWords`'s
 *  default; reach.rs `need_kind` and today.rs). */
const KIND_WORDS: readonly TodayRowKind[] = [
  "approval",
  "forwarded",
  "question",
  "confirm",
  "stuck",
  "waiting",
  "acceptance",
  "routine_paused",
  "used_up",
  "plan_stuck",
  "proposal",
  "failed",
  "reminder",
  "finished",
  "checked",
  "answered",
  "changed",
  "memory",
  "forge",
  "pr_ready",
  "pr",
  "pr_merged",
]

/** What a Today row waits on the owner for (today.rs `task_reason`). */
const REASONS = {
  failed: true,
  accepted_queued: true,
  merge_queued: true,
  accepted_unchecked: true,
  needs_delivery: true,
  merge_ready: true,
  review: true,
  looking: true,
} satisfies Record<TodayReason, true>

/** The kinds of card the owner answers, as the profile counts them
 *  (profile.rs `ANSWERED_KINDS`, named by `notice_kind_name`). */
const ANSWERED_KINDS = [
  "proposal",
  "uncertain",
  "loop",
  "changed",
  "choice",
  "reminder",
  "acceptance",
  "forge",
  "pr",
  "routine",
  "rule",
  "memory",
  "tidy",
  "skill",
] as const

describe("messages for the values the backend sends", () => {
  it("names every kind of matter", () => {
    expect(
      missing("PersonalAgent.items.kind", Object.keys(ITEM_KINDS))
    ).toEqual([])
  })

  it("says where every dispatch that has not ended stands", () => {
    const open = Object.entries(DISPATCH_STATES)
      .filter(([, shown]) => shown)
      .map(([state]) => state)
    expect(missing("PersonalAgent.today.dispatch", open)).toEqual([])
  })

  it("names every kind of Today row that goes by its kind", () => {
    expect(missing("PersonalAgent.today.kind", KIND_WORDS)).toEqual([])
  })

  it("says what every reason a Today row waits on the owner is", () => {
    expect(missing("PersonalAgent.today.reason", Object.keys(REASONS))).toEqual(
      []
    )
  })

  it("names every kind of card the owner answers", () => {
    expect(
      missing("PersonalAgent.settings.about.reactions.kinds", ANSWERED_KINDS)
    ).toEqual([])
  })
})
