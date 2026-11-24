import type { WorkTask } from "@/lib/types"

export const TASKS_TIME_RANGES = ["24h", "7d", "30d", "all"] as const

export type TasksTimeRange = (typeof TASKS_TIME_RANGES)[number]

const RANGE_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const

/** Rolling windows over the same update time used to sort both task views. */
export function taskMatchesTimeRange(
  task: Pick<WorkTask, "updated_at">,
  range: TasksTimeRange,
  now: number
): boolean {
  return range === "all" || Date.parse(task.updated_at) >= now - RANGE_MS[range]
}
