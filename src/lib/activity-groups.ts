/** The activity's groups as a page reads them (7.1): the five a codeg that
 *  has them sends (`groups`), or — connected to an older one — its four,
 *  drawn as they were (11). */

import type { ActivityRow, PersonalAgentActivity } from "@/lib/types"
import type { ActivityGroup } from "@/stores/personal-agent-ui-store"

export interface ActivityGroupsRead {
  /** `v2`: the five groups; `legacy`: an older codeg's four. */
  mode: "v2" | "legacy"
  /** The groups, in the order they are drawn. */
  order: readonly ActivityGroup[]
  rows: Partial<Record<ActivityGroup, ActivityRow[]>>
  /** The assistants' suggestions: the owner's, one line, never counted.
   *  An older codeg has them among `needs`. */
  suggestions: ActivityRow[]
  /** What waits on the owner: the tab's badge, the group's head. */
  waiting: number
  /** The primary's pill. */
  pill: { count: number; first: string | null }
  /** What the codeg's list can do: a button needing a new action shows
   *  only when it says it can. */
  can: (capability: string) => boolean
}

const V2_ORDER: readonly ActivityGroup[] = [
  "needs",
  "running",
  "watch",
  "next",
  "done",
]
const LEGACY_ORDER: readonly ActivityGroup[] = [
  "needs",
  "watching",
  "next",
  "done",
]

/** "Routine: no change" is not done today's, nor counted there (C2): its
 *  routine's row says it. */
function shownDone(rows: ActivityRow[]): ActivityRow[] {
  return rows.filter(
    (r) => !(r.today?.kind === "routine_report" && r.today.state === "silent")
  )
}

export function readGroups(view: PersonalAgentActivity): ActivityGroupsRead {
  const caps = new Set(view.capabilities ?? [])
  const can = (c: string) => caps.has(c)
  const g = view.groups
  if (g) {
    return {
      mode: "v2",
      order: V2_ORDER,
      rows: {
        needs: g.needs,
        running: g.running,
        watch: g.watch,
        next: g.next,
        done: shownDone(g.done),
      },
      suggestions: g.suggestions,
      waiting: g.waiting,
      pill: g.pill,
      can,
    }
  }
  return {
    mode: "legacy",
    order: LEGACY_ORDER,
    rows: {
      needs: view.needs,
      watching: view.watching,
      next: view.next,
      done: shownDone(view.done),
    },
    suggestions: [],
    waiting: view.waiting,
    pill: view.pill,
    // An older codeg's list can do none of the new actions.
    can: () => false,
  }
}

/** Every row of the list, the ones folded into others with them: what a
 *  thing is looked for in, whichever group it is in. */
export function allActivityRows(view: PersonalAgentActivity): ActivityRow[] {
  const g = view.groups
  const rows = g
    ? [
        ...g.needs,
        ...g.suggestions,
        ...g.running,
        ...g.watch,
        ...g.next,
        ...g.done,
      ]
    : [...view.needs, ...view.watching, ...view.next, ...view.done]
  return rows.flatMap((r) => [r, ...(r.folded ?? [])])
}

/** The keys of what waits on the owner: the conversation's pill's (R5) —
 *  no suggestion among them. */
export function waitingKeys(view: PersonalAgentActivity): string[] {
  return (view.groups?.needs ?? view.needs).map((r) => r.key)
}
