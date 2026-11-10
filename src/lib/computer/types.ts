// Mirrors of the Rust computer-use wire types (`src-tauri/src/computer/`,
// `commands/computer.rs`, `commands/computer_tools.rs`). The spellings are the
// Rust side's serde renames, which differ per type — kebab-case for the enums
// shared with the browser, camelCase for the rest — so each is written out
// rather than derived.

/** Same enum, same spelling, as the browser's grant level. */
export type GrantLevel = "none" | "read" | "control"

/** A macOS permission the helper may need. */
export type OsPermission = "accessibility" | "screenRecording"

/** The helper's own OS permissions — never codeg's. */
export interface PermissionReport {
  /** Whether this platform has per-application permissions at all. */
  required: boolean
  accessibility: boolean
  screenRecording: boolean
}

/** What asking for one permission did. */
export interface PermissionRequestResult {
  /** The helper's permissions once the system had been asked. */
  report: PermissionReport
  /** macOS put up its own dialog for it, with a button to the right pane of
   *  System Settings. It does not once the person has turned the switch off
   *  there. */
  prompted: boolean
}

export type BackendState =
  | "idle"
  | "downloading"
  | "starting"
  | "ready"
  | "failed"

/** Whether the running helper checked codeg's code signature. */
export type PeerCheck = "verified" | "development" | "notApplicable"

export interface BackendStatus {
  state: BackendState
  detail?: string
  driverVersion: string
  peer?: PeerCheck
}

/** codeg's own TCC standing (macOS only). */
export interface CodegTccStatus {
  accessibility: boolean
  screenRecording: boolean
  /** When false, the two flags are the launching terminal's. */
  selfResponsible: boolean
}

/** A window with a grant in force. */
export interface SharedWindow {
  targetId: string
  appName: string
  appKey: string
  title: string
  level: GrantLevel
  grantedAt: number
  lastUsedAt: number
  /** Shared with its whole application ({@link SharedApp}), not on its own. */
  wholeApp?: boolean
  /** That application's share, when it is. */
  appId?: string
  /** Shared with the entire screen ({@link SharedScreen}). */
  wholeScreen?: boolean
}

/** The entire screen shared as a whole: every window that may be shared,
 *  the ones that open later too, and the desktop's own shortcuts — what is
 *  never shared stays painted over. */
export interface SharedScreen {
  level: GrantLevel
  grantedAt: number
  lastUsedAt: number
  /** How many windows are shared with it now. */
  windows: number
}

/** An application shared as a whole: every window of it, the ones it opens
 *  later too, its menus and its own shortcuts. */
export interface SharedApp {
  appId: string
  appName: string
  appKey: string
  level: GrantLevel
  grantedAt: number
  lastUsedAt: number
  /** How many of its windows are shared with it now. */
  windows: number
}

export interface ComputerStatus {
  enabled: boolean
  platform: "macos" | "windows" | "linux"
  verifiedPlatform: boolean
  backend: BackendStatus
  permissions?: PermissionReport
  codeg?: CodegTccStatus
  shared: SharedWindow[]
  /** Whether the share picker offers the entire screen: macOS and Windows,
   *  with its switch on in Settings. */
  screenOffered?: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Why a window can never be shared. */
export type NotGrantable = "codeg" | "blocklisted" | "unidentified"

/** One window as the share picker shows it. */
export interface PickerWindow {
  targetId: string
  appName: string
  appKey: string
  pid: number
  title: string
  bounds: Rect
  onScreen: boolean
  minimized: boolean
  /** Its application is hidden (macOS ⌘H). */
  hidden: boolean
  level: GrantLevel
  /** Shared with its whole application, not on its own. */
  wholeApp?: boolean
  /** That application's share, when it is. */
  appId?: string
  /** Shared with the entire screen. */
  wholeScreen?: boolean
  notGrantable?: NotGrantable
}

export type GrantChange =
  | "granted"
  | "revoked"
  | "target-changed"
  | "expired"
  | "disabled"
  | "stopped"

/** `computer://agent-grant` */
export interface ComputerGrantPayload {
  targetId: string
  change: GrantChange
  level: GrantLevel
}

export type ComputerAction =
  | "capture"
  | "snapshot"
  | "verify"
  | "click"
  | "drag"
  | "scroll"
  | "type"
  | "key"
  | "hold-key"
  | "set-value"
  | "restore"
  | "menu"
  | "set-frame"
  | "launch"
  | "clipboard-read"
  | "clipboard-write"
export type ActivityOutcome = "done" | "refused" | "failed"

/** `computer://agent-activity` */
export interface ComputerActivityPayload {
  targetId: string
  action: ComputerAction
  outcome: ActivityOutcome
  /** Unix milliseconds. */
  at: number
  /** The application, for what is done to one rather than to a window —
   *  starting it — where `targetId` is empty. */
  app?: string
}

/** One entry of the default blocklist, as this platform names it. Mirror of
 *  Rust `DefaultBlockView`. */
export interface DefaultBlock {
  /** Stable: what taking it off the list is remembered by. */
  key: string
  /** Its product name; the system's own entries are named by the interface. */
  name: string
  /** Bundle identifiers or executable names. */
  names: string[]
}

/** Mirror of Rust `ComputerToolsSettings`. */
export interface ComputerToolsSettings {
  enabled: boolean
  /** 0 is "until I take it back". */
  grantTtlMinutes: number
  /** Applications added to the default blocklist. */
  blocklist: string[]
  /** Keys of the default entries taken off it. */
  blocklistRemoved: string[]
  /** The default list, for showing; never sent back. */
  blocklistDefaults: DefaultBlock[]
  /** The shortcut that stops all sharing at once, spelled as
   *  `stop-shortcut.ts` spells it; empty when switched off. */
  stopShortcut: string
  /** Whether the strip with Stop on it floats above every window while
   *  anything is shared. */
  showIndicator: boolean
  /** Whether an agent may have a window brought to the front for an action.
   *  On unless the person switched it off. */
  allowForeground: boolean
  /** Whether an agent may start applications and move or size a shared
   *  window. Off unless the person turned it on. */
  launchEnabled?: boolean
  /** Whether an agent may read back what it put on the clipboard, and put
   *  text there. Off unless the person turned it on. */
  clipboardEnabled?: boolean
  /** Whether the share picker offers the entire screen. Off unless the
   *  person turned it on; turning it off ends the screen's sharing. */
  screenEnabled?: boolean
  /** How an action goes when the agent does not say; `foreground` is in
   *  force only while `allowForeground` is on, and kept while it is off. */
  defaultDelivery: ComputerDelivery
}

/** How an agent's action reaches a window: left where it is, or brought to
 *  the front for the one action. Mirror of Rust `ActDelivery`. */
export type ComputerDelivery = "background" | "foreground"

/** `computer://stop-key`: whether the stop shortcut is in force. */
export interface StopKeyStatus {
  /** The shortcut in force, spelled as the settings spell it. */
  active?: string
  /** The shortcut the settings name that the OS would not take — most
   *  likely another application holds it — and what the OS said. */
  failed?: string
  detail?: string
}

/** `computer://marker`, told to the marker window alone: play the mark for
 *  this action. */
export interface ComputerMarkerPayload {
  id: number
  action: ComputerAction
}

/** What sharing several windows at once did. */
export interface ShareManyResult {
  shared: SharedWindow[]
  /** How many of the windows named were not shared: closed since the list
   *  was read, or never shareable. */
  skipped: number
}

/** What is being done to cua-driver right now. */
export type DriverTask =
  | {
      kind: "installing"
      /** Megabytes so far, and in all, once the download has said. */
      downloadedMb?: number
      totalMb?: number
    }
  | { kind: "uninstalling" }

/** cua-driver as Settings shows it (`computer_driver_info`). Desktop only. */
export interface DriverInfo {
  /** The release this codeg runs — the only one it will run. */
  version: string
  /** Whether that release has a build for this platform. */
  supported: boolean
  /** The releases in the cache, newest first. */
  installed: string[]
  /** Where the pinned release's executable is, once it is in the cache. */
  path?: string
  task?: DriverTask
  /** How the last install or removal failed, until the next one. */
  error?: string
}

/** `computer://state`: every shared window, and the applications shared as
 *  a whole. */
export interface ComputerStatePayload {
  shared: SharedWindow[]
  apps?: SharedApp[]
  /** The entire screen, when it is shared. */
  screen?: SharedScreen
}

/** Every shared window, whenever any grant changes. Desktop only. */
export const COMPUTER_STATE_EVENT = "computer://state"
export const COMPUTER_GRANT_EVENT = "computer://agent-grant"
export const COMPUTER_ACTIVITY_EVENT = "computer://agent-activity"
export const COMPUTER_BACKEND_STATUS_EVENT = "computer://backend-status"
export const COMPUTER_STOP_KEY_EVENT = "computer://stop-key"
export const COMPUTER_MARKER_EVENT = "computer://marker"
/** {@link DriverInfo}, whenever it changes or an install moves. */
export const COMPUTER_DRIVER_EVENT = "computer://driver"
/** The settings record, after any of its writers saved it. */
export const COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT =
  "computer-tools-settings://changed"
