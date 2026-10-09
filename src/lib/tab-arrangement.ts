import type { ConnectionState } from "@/contexts/acp-connections-context"
import type { ConversationStatus } from "@/lib/types"
import {
  FOLDER_THEME_COLOR_INHERIT,
  normalizeFolderThemeColor,
  type ThemeColor,
} from "@/lib/theme-presets"

/**
 * How the conversation tab strip is laid out. A DISPLAY choice only: the
 * underlying order (`rawTabs`, persisted via `save_opened_tabs`) is never
 * rewritten by grouping or sorting, so switching back to `manual` restores
 * exactly the order the user dragged.
 */
export const TAB_ARRANGE_MODES = ["manual", "folder", "status"] as const
export type TabArrangeMode = (typeof TAB_ARRANGE_MODES)[number]

/** Status bands for `status` mode, most urgent first. */
export const TAB_STATUS_BANDS = [
  "needs_you",
  "awaiting_reply",
  "running",
  "other",
] as const
export type TabStatusBand = (typeof TAB_STATUS_BANDS)[number]

interface ArrangeableTab {
  id: string
  folderId: number
  status?: ConversationStatus
}

export type TabRun<T> =
  | { kind: "folder"; key: string; folderId: number; tabs: T[] }
  | { kind: "status"; key: string; band: TabStatusBand; tabs: T[] }

/** What a tab's session is blocked on until the user acts. */
export type TabAttentionKind = "permission" | "question" | "plan_approval"

/**
 * What a live connection is waiting on the user for, or null. Reads the same
 * pending state the conversation view renders as its permission dialog, its
 * question dialog / ask-question card and its plan-approval card; when more
 * than one is up, the first of permission, question, plan wins.
 */
export function connectionAttentionKind(
  conn:
    | Pick<
        ConnectionState,
        | "pendingPermission"
        | "pendingQuestion"
        | "pendingAskQuestion"
        | "pendingPlanApproval"
      >
    | null
    | undefined
): TabAttentionKind | null {
  if (!conn) return null
  if (conn.pendingPermission) return "permission"
  if (
    conn.pendingQuestion ||
    (conn.pendingAskQuestion?.questions.length ?? 0) > 0
  ) {
    return "question"
  }
  if (conn.pendingPlanApproval) return "plan_approval"
  return null
}

/**
 * - `needs_you`: the tab's session is blocked on a permission, a question or a
 *   plan approval (`attention`, keyed by tab id — a conversation tab's id is
 *   its connection key);
 * - `awaiting_reply`: the agent finished its turn and it's the user's move
 *   (`pending_review`);
 * - `running`: a turn in flight (`in_progress`);
 * - `other`: done, cancelled, or a draft with nothing sent yet.
 */
export function tabStatusBand(
  tab: ArrangeableTab,
  attention: ReadonlyMap<string, TabAttentionKind>
): TabStatusBand {
  if (attention.has(tab.id)) return "needs_you"
  if (tab.status === "pending_review") return "awaiting_reply"
  if (tab.status === "in_progress") return "running"
  return "other"
}

/**
 * Lay the strip out for `mode`. Always stable: within a folder group or a
 * status band, tabs keep their manual order, so nothing jumps around except
 * what actually changed group. Folder groups appear in the order their first
 * tab does. `ordered` keeps the tab objects' identity (the strip's reorder list
 * keys on them); `runs` is null in `manual` mode.
 */
export function arrangeTabs<T extends ArrangeableTab>(
  tabs: readonly T[],
  mode: TabArrangeMode,
  attention: ReadonlyMap<string, TabAttentionKind>
): { ordered: readonly T[]; runs: TabRun<T>[] | null } {
  if (mode === "manual") return { ordered: tabs, runs: null }

  let runs: TabRun<T>[]
  if (mode === "folder") {
    const byFolder = new Map<number, T[]>()
    for (const tab of tabs) {
      const list = byFolder.get(tab.folderId)
      if (list) list.push(tab)
      else byFolder.set(tab.folderId, [tab])
    }
    runs = [...byFolder].map(([folderId, list]) => ({
      kind: "folder" as const,
      key: `folder-${folderId}`,
      folderId,
      tabs: list,
    }))
  } else {
    const byBand = new Map<TabStatusBand, T[]>()
    for (const tab of tabs) {
      const band = tabStatusBand(tab, attention)
      const list = byBand.get(band)
      if (list) list.push(tab)
      else byBand.set(band, [tab])
    }
    runs = TAB_STATUS_BANDS.filter((band) => byBand.has(band)).map((band) => ({
      kind: "status" as const,
      key: `status-${band}`,
      band,
      tabs: byBand.get(band)!,
    }))
  }
  return { ordered: runs.flatMap((run) => run.tabs), runs }
}

/** Distinct, saturated presets for folders the user never colored — so every
 *  group in `folder` mode is told apart by color, not just by its label. */
const AUTO_FOLDER_COLORS: readonly ThemeColor[] = [
  "blue",
  "green",
  "violet",
  "orange",
  "rose",
  "yellow",
  "red",
]

/** The color a folder's tab group is drawn in: its own theme color when set,
 *  otherwise a stable pick from {@link AUTO_FOLDER_COLORS} by folder id. */
export function folderAccentColor(
  folderId: number,
  rawColor: string | null | undefined
): ThemeColor {
  const color = normalizeFolderThemeColor(rawColor)
  if (color !== FOLDER_THEME_COLOR_INHERIT) return color
  const n = AUTO_FOLDER_COLORS.length
  return AUTO_FOLDER_COLORS[((folderId % n) + n) % n]
}

/** Band colors: rose = waiting on you; blue = review and yellow = in progress,
 *  matching the tabs' own status dots. `other` stays neutral. */
export const STATUS_BAND_COLOR: Record<TabStatusBand, ThemeColor | null> = {
  needs_you: "rose",
  awaiting_reply: "blue",
  running: "yellow",
  other: null,
}
