/**
 * The Skill-packs section's state: which pack is on show, each pack's own
 * list (names, categories, marks — the packs' commands), the switches (the
 * engine, through `skill-links.ts`), and Office's tool.
 *
 * Office's install is the one thing here that runs for a long time, and it
 * runs outside any component: its progress and its log are written to slots
 * by plain functions, so switching to another pack, another section or a
 * conversation leaves it running and shows it where it was on the way back.
 * While it runs, Install cannot be pressed again.
 */
import {
  expertsList,
  generativeUiSkillInfo,
  officecliDetect,
  officecliInstall,
  officecliListSkills,
  officecliSyncSkills,
  officecliUninstall,
  scienceList,
  type GenerativeUiSkillInfo,
} from "@/lib/api"
import {
  defineHarnessSlot,
  type HarnessSlot,
  type HarnessSlotStore,
} from "@/lib/harness-slots"
import type { HarnessPackTab } from "@/lib/harness-sections"
import { subscribe } from "@/lib/platform"
import { skillsFailureOf, type SkillsFailure } from "@/lib/skills/errors"
import type {
  ExpertListItem,
  OfficecliInfo,
  OfficecliInstallEvent,
  OfficecliSkill,
  ScienceListItem,
  SkillSyncReport,
} from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import { defineLinks, reloadInventory, type Links } from "./skill-links"

let lastRequest = 0
const newRequest = () => ++lastRequest

export const PACKS_LINKS: Links = defineLinks("packs")

// ─── Which pack ───────────────────────────────────────────────────────

export const PACKS_TAB = defineHarnessSlot<HarnessPackTab>(
  "packs",
  () => "experts"
)

/** Per pack: the search, the skill open in the detail, the scroll. */
export interface PackViewState {
  text: string
  selected: string | null
  scroll: number
  ticked: readonly string[]
}

const PACK_VIEW: PackViewState = {
  text: "",
  selected: null,
  scroll: 0,
  ticked: [],
}

export const PACKS_VIEW = defineHarnessSlot<
  Readonly<Record<HarnessPackTab, PackViewState>>
>("packs", () => ({
  experts: PACK_VIEW,
  science: PACK_VIEW,
  office: PACK_VIEW,
  ui: PACK_VIEW,
}))

export function updatePackView(
  slots: HarnessSlotStore,
  tab: HarnessPackTab,
  update: Partial<PackViewState>
): void {
  slots.set(PACKS_VIEW, (prev) => {
    const current = prev[tab]
    const next = { ...current, ...update }
    if (
      next.text === current.text &&
      next.selected === current.selected &&
      next.scroll === current.scroll &&
      next.ticked === current.ticked
    ) {
      return prev
    }
    return { ...prev, [tab]: next }
  })
}

export const PACKS_SHOW_ALL_AGENTS = defineHarnessSlot<boolean>(
  "packs",
  () => false
)

export const PACKS_DETAIL_SCROLL = defineHarnessSlot<{
  id: string
  top: number
} | null>("packs", () => null)

export const PACKS_RETURN_FOCUS = defineHarnessSlot<string | null>(
  "packs",
  () => null
)

// ─── The packs' own lists ─────────────────────────────────────────────

export interface ListState<T> {
  phase: "idle" | "loading" | "ready" | "error"
  data: T | null
  error: SkillsFailure | null
  request: number
}

const idleList = <T>(): ListState<T> => ({
  phase: "idle",
  data: null,
  error: null,
  request: 0,
})

export const EXPERTS_LIST = defineHarnessSlot<ListState<ExpertListItem[]>>(
  "packs",
  idleList
)
export const SCIENCE_LIST = defineHarnessSlot<ListState<ScienceListItem[]>>(
  "packs",
  idleList
)
export const OFFICE_LIST = defineHarnessSlot<ListState<OfficecliSkill[]>>(
  "packs",
  idleList
)
export const UI_INFO = defineHarnessSlot<ListState<GenerativeUiSkillInfo>>(
  "packs",
  idleList
)
/** Whether OfficeCLI is installed, and runs. */
export const OFFICE_INFO = defineHarnessSlot<ListState<OfficecliInfo>>(
  "packs",
  idleList
)

/** Read one list; only the answer to the latest request lands, and a failed
 *  refresh keeps what was read before. */
async function readList<T>(
  slots: HarnessSlotStore,
  slot: HarnessSlot<ListState<T>>,
  read: () => Promise<T>
): Promise<void> {
  const request = newRequest()
  slots.set(
    slot,
    (prev): ListState<T> => ({ ...prev, phase: "loading", request })
  )
  const current = () => slots.get(slot).request === request
  try {
    const data = await read()
    if (!current()) return
    slots.set(
      slot,
      (prev): ListState<T> => ({ ...prev, phase: "ready", data, error: null })
    )
  } catch (error) {
    if (!current()) return
    slots.set(
      slot,
      (prev): ListState<T> => ({
        ...prev,
        phase: "error",
        error: skillsFailureOf(error),
      })
    )
  }
}

/** Read a pack's own list (and, for Office, whether its tool is there). */
export function reloadPack(
  slots: HarnessSlotStore,
  tab: HarnessPackTab
): Promise<void> {
  switch (tab) {
    case "experts":
      return readList(slots, EXPERTS_LIST, expertsList)
    case "science":
      return readList(slots, SCIENCE_LIST, scienceList)
    case "office":
      return Promise.all([
        readList(slots, OFFICE_LIST, officecliListSkills),
        detectOffice(slots),
      ]).then(() => undefined)
    case "ui":
      return readList(slots, UI_INFO, generativeUiSkillInfo)
  }
}

export function detectOffice(slots: HarnessSlotStore): Promise<void> {
  return readList(slots, OFFICE_INFO, officecliDetect)
}

/** Everything a pack shows, read again: its own list and the switches. */
export function reloadPacks(
  slots: HarnessSlotStore,
  tab: HarnessPackTab
): Promise<void> {
  return Promise.all([
    reloadInventory(slots, PACKS_LINKS).done,
    reloadPack(slots, tab),
  ]).then(() => undefined)
}

// ─── Office ───────────────────────────────────────────────────────────

export interface OfficeInstallState {
  status: "idle" | "running" | "succeeded" | "failed"
  /** What the install is doing: fetching the tool, then syncing its skills. */
  step: "install" | "sync" | null
  taskId: string | null
  /** The installer's output, line by line. */
  log: readonly string[]
  failure: SkillsFailure | null
  /** The sync that follows a successful install. */
  sync: SkillSyncReport | null
}

export const OFFICE_INSTALL = defineHarnessSlot<OfficeInstallState>(
  "packs",
  () => ({
    status: "idle",
    step: null,
    taskId: null,
    log: [],
    failure: null,
    sync: null,
  })
)

/** The log is kept to its last lines: an installer that loops cannot grow it
 *  without end. */
const LOG_LIMIT = 2000

const OFFICE_INSTALL_EVENT = "app://officecli-install"

function appendLog(slots: HarnessSlotStore, taskId: string, line: string) {
  slots.set(
    OFFICE_INSTALL,
    (prev): OfficeInstallState =>
      prev.taskId !== taskId
        ? prev
        : { ...prev, log: [...prev.log, line].slice(-LOG_LIMIT) }
  )
}

/**
 * Install OfficeCLI, then sync its skills — once at a time: while an install
 * runs this does nothing. The installer's lines are followed from before the
 * install is asked for, so none is missed, and land in the slot whether or
 * not anything shows them.
 */
export async function installOffice(slots: HarnessSlotStore): Promise<void> {
  if (slots.get(OFFICE_INSTALL).status === "running") return
  const taskId = randomUUID()
  slots.set(OFFICE_INSTALL, {
    status: "running",
    step: "install",
    taskId,
    log: [],
    failure: null,
    sync: null,
  })
  let stop: (() => void) | null = null
  try {
    stop = await subscribe<OfficecliInstallEvent>(
      OFFICE_INSTALL_EVENT,
      (event) => {
        if (event.task_id !== taskId) return
        if (event.kind === "log" || event.kind === "completed") {
          appendLog(slots, taskId, event.payload)
        } else if (event.kind === "failed") {
          appendLog(slots, taskId, `ERROR: ${event.payload}`)
        }
      }
    )
  } catch {
    // No stream: the install still runs; only its log is not shown.
  }
  const current = () => slots.get(OFFICE_INSTALL).taskId === taskId
  try {
    const info = await officecliInstall(taskId)
    if (!current()) return
    slots.set(
      OFFICE_INFO,
      (prev): ListState<OfficecliInfo> => ({
        ...prev,
        phase: "ready",
        data: info,
        error: null,
      })
    )
    slots.set(
      OFFICE_INSTALL,
      (prev): OfficeInstallState => ({ ...prev, step: "sync" })
    )
    const sync = await officecliSyncSkills()
    if (!current()) return
    slots.set(
      OFFICE_INSTALL,
      (prev): OfficeInstallState => ({
        ...prev,
        status: "succeeded",
        step: null,
        sync,
      })
    )
  } catch (error) {
    if (!current()) return
    slots.set(
      OFFICE_INSTALL,
      (prev): OfficeInstallState => ({
        ...prev,
        status: "failed",
        step: null,
        failure: skillsFailureOf(error),
      })
    )
  } finally {
    stop?.()
  }
  // The installer may have left a tool that is there but does not run (a
  // missing system library): the card shows what is there now.
  await reloadPacks(slots, "office")
}

/** Put a finished install's report away. */
export function dismissOfficeInstall(slots: HarnessSlotStore): void {
  slots.set(
    OFFICE_INSTALL,
    (prev): OfficeInstallState =>
      prev.status === "running"
        ? prev
        : {
            status: "idle",
            step: null,
            taskId: null,
            log: [],
            failure: null,
            sync: null,
          }
  )
}

export interface OfficeActionState {
  /** `confirm`: Uninstall asks first. */
  phase: "idle" | "confirm" | "uninstalling" | "syncing"
  failure: SkillsFailure | null
  /** The last sync's report. */
  sync: SkillSyncReport | null
  /** The last action that finished: what its message is about. */
  done: "uninstalled" | "synced" | null
}

export const OFFICE_ACTION = defineHarnessSlot<OfficeActionState>(
  "packs",
  () => ({ phase: "idle", failure: null, sync: null, done: null })
)

export function askUninstallOffice(slots: HarnessSlotStore): void {
  slots.set(
    OFFICE_ACTION,
    (prev): OfficeActionState =>
      prev.phase === "idle" ? { ...prev, phase: "confirm" } : prev
  )
}

export function cancelOfficeAction(slots: HarnessSlotStore): void {
  slots.set(
    OFFICE_ACTION,
    (prev): OfficeActionState =>
      prev.phase === "confirm" ? { ...prev, phase: "idle" } : prev
  )
}

/** Remove the tool, Codeg's links of its skills from every agent, and the
 *  skills — asked first (see {@link askUninstallOffice}). */
export async function uninstallOffice(slots: HarnessSlotStore): Promise<void> {
  if (slots.get(OFFICE_ACTION).phase !== "confirm") return
  if (slots.get(OFFICE_INSTALL).status === "running") return
  slots.set(OFFICE_ACTION, {
    phase: "uninstalling",
    failure: null,
    sync: null,
    done: null,
  })
  try {
    const info = await officecliUninstall()
    slots.set(
      OFFICE_INFO,
      (prev): ListState<OfficecliInfo> => ({
        ...prev,
        phase: "ready",
        data: info,
        error: null,
      })
    )
    slots.set(OFFICE_ACTION, {
      phase: "idle",
      failure: null,
      sync: null,
      done: "uninstalled",
    })
    dismissOfficeInstall(slots)
  } catch (error) {
    slots.set(OFFICE_ACTION, {
      phase: "idle",
      failure: skillsFailureOf(error),
      sync: null,
      done: null,
    })
  }
  await reloadPacks(slots, "office")
}

/** Write the Office skills into Codeg's store again, from the tool. */
export async function syncOffice(slots: HarnessSlotStore): Promise<void> {
  if (slots.get(OFFICE_ACTION).phase !== "idle") return
  slots.set(OFFICE_ACTION, {
    phase: "syncing",
    failure: null,
    sync: null,
    done: null,
  })
  try {
    const sync = await officecliSyncSkills()
    slots.set(OFFICE_ACTION, {
      phase: "idle",
      failure: null,
      sync,
      done: "synced",
    })
  } catch (error) {
    slots.set(OFFICE_ACTION, {
      phase: "idle",
      failure: skillsFailureOf(error),
      sync: null,
      done: null,
    })
  }
  await reloadPacks(slots, "office")
}

export function dismissOfficeAction(slots: HarnessSlotStore): void {
  slots.set(
    OFFICE_ACTION,
    (prev): OfficeActionState =>
      prev.phase === "idle"
        ? { phase: "idle", failure: null, sync: null, done: null }
        : prev
  )
}
