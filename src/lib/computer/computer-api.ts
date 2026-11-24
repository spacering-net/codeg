// Thin transport wrappers over the computer-use commands.
//
// Two kinds: the settings record, which every runtime serves (it is one
// setting in one database), and everything about the screen itself — status,
// permissions, the window list, sharing — which exists where computer use is
// served: the desktop app, for the machine it runs on, and a codeg-server its
// operator has let share the screen it runs on (`CODEG_COMPUTER_USE`), for
// its web clients. Whether this window has it is `computerAvailable`.

import { useEffect, useSyncExternalStore } from "react"

import { isLocalDesktop, onTransportReconnect } from "@/lib/platform"
import { getTransport } from "@/lib/transport"

import type {
  ComputerDelivery,
  ComputerStatePayload,
  ComputerStatus,
  ComputerToolsSettings,
  DriverInfo,
  OsPermission,
  PermissionRequestResult,
  PickerWindow,
  ShareManyResult,
  SharedWindow,
  GrantLevel,
  StopKeyStatus,
} from "./types"

export async function getComputerToolsSettings(): Promise<ComputerToolsSettings> {
  return getTransport().call("get_computer_tools_settings")
}

/** Move only the group switch. */
export async function setComputerToolsEnabled(
  enabled: boolean
): Promise<ComputerToolsSettings> {
  return getTransport().call("set_computer_tools_enabled", { enabled })
}

/** Move the grant timeout, the blocklist, the stop shortcut, the strip,
 *  whether a window may come to the front and how an action goes by
 *  default — only what is given; the rest of the record (the switch
 *  included) stays as it is stored. */
export async function setComputerToolsPreferences(preferences: {
  grantTtlMinutes?: number
  blocklist?: string[]
  /** Keys of the default entries to leave off the list. */
  blocklistRemoved?: string[]
  /** Empty switches the shortcut off. */
  stopShortcut?: string
  showIndicator?: boolean
  allowForeground?: boolean
  defaultDelivery?: ComputerDelivery
  launchEnabled?: boolean
  clipboardEnabled?: boolean
  screenEnabled?: boolean
}): Promise<ComputerToolsSettings> {
  return getTransport().call("set_computer_tools_preferences", preferences)
}

/** What a server says of computer use (`computer_available`). */
export interface ComputerServed {
  /** It shares the screen it runs on with its web clients. */
  available: boolean
  /** The machine whose screen that is. */
  platform: "macos" | "windows" | "linux"
}

/** What the server said of computer use: `null` until it has answered.
 *  Never asked by the desktop app on the machine whose screen it is, which
 *  always has it. */
let served: ComputerServed | null = null
let asking: Promise<boolean> | null = null
/** The transport came back while a question was out: asked again once it
 *  settles, whatever it answers — it was asked before the reconnect. */
let askAgain = false
let reconnectsWatched = false
const servedListeners = new Set<() => void>()

/** Whether this window has computer use: the desktop app on the machine
 *  whose screen this is, or a server that said it shares the screen it runs
 *  on. `false` until a server has answered ({@link askComputerServed}). */
export function computerAvailable(): boolean {
  return isLocalDesktop() || served?.available === true
}

/** The machine whose screen computer use is about, where a server has said
 *  so; `null` for the desktop app's own machine, or before the server has
 *  answered. */
export function computerServerPlatform(): ComputerServed["platform"] | null {
  return isLocalDesktop() ? null : (served?.platform ?? null)
}

/** Ask the server whether it shares the screen it runs on — what a web
 *  window, or a desktop window on a remote server, has computer use by.
 *  Answers at once where that is already known. A call that gets no answer
 *  (the server restarting, or out of reach) leaves it unknown, to be asked
 *  again by the next call — and every time the transport comes back, as the
 *  server may have been restarted with computer use on or off. */
export function askComputerServed(): Promise<boolean> {
  if (isLocalDesktop()) return Promise.resolve(true)
  if (served !== null) return Promise.resolve(served.available)
  return ask()
}

function ask(): Promise<boolean> {
  watchReconnects()
  if (asking) return asking
  asking = getTransport()
    .call<ComputerServed>("computer_available", {})
    .then(
      (answer) => {
        const changed =
          served?.available !== answer.available ||
          served?.platform !== answer.platform
        served = answer
        if (changed) for (const listener of servedListeners) listener()
        return answer.available
      },
      () => served?.available ?? false
    )
    .finally(() => {
      asking = null
      if (askAgain) {
        askAgain = false
        void ask()
      }
    })
  return asking
}

function watchReconnects() {
  if (reconnectsWatched) return
  reconnectsWatched = true
  onTransportReconnect(() => {
    if (asking) askAgain = true
    else void ask()
  })
}

/** Hear whenever what the server says of computer use changes. */
export function subscribeComputerServed(listener: () => void): () => void {
  servedListeners.add(listener)
  return () => servedListeners.delete(listener)
}

/** {@link computerAvailable}, followed: asks the server the first time, and
 *  answers again once it has. */
export function useComputerAvailable(): boolean {
  const available = useSyncExternalStore(
    subscribeComputerServed,
    computerAvailable,
    computerAvailable
  )
  useEffect(() => {
    if (!available) void askComputerServed()
  }, [available])
  return available
}

/** Test-only: forget what the server said, or have it said `answer`. */
export function resetComputerServedForTest(
  answer: ComputerServed | null = null
) {
  served = answer
  asking = null
  askAgain = false
  reconnectsWatched = false
}

export async function computerStatus(): Promise<ComputerStatus> {
  return getTransport().call("computer_status", {})
}

/** The shared windows: codeg's own state, with no helper to start — cheap
 *  enough to ask for when a window loads. */
export async function computerSharedState(): Promise<ComputerStatePayload> {
  return getTransport().call("computer_shared_state", {})
}

/** Ask macOS for this one permission, from a helper started for the
 *  purpose, and say where that leaves things. */
export async function computerRequestPermission(
  permission: OsPermission
): Promise<PermissionRequestResult> {
  return getTransport().call("computer_request_permission", { permission })
}

export async function computerOpenPermissionSettings(
  permission: OsPermission
): Promise<void> {
  return getTransport().call("computer_open_permission_settings", {
    permission,
  })
}

/** Show codeg-computer-helper in the Finder, to drag into System Settings. */
export async function computerRevealHelper(): Promise<void> {
  return getTransport().call("computer_reveal_helper", {})
}

export async function computerListShareableWindows(): Promise<PickerWindow[]> {
  return getTransport().call("computer_list_shareable_windows", {})
}

/** A `data:` URL, or null when there is none to show. */
export async function computerWindowThumbnail(
  targetId: string
): Promise<string | null> {
  return getTransport().call("computer_window_thumbnail", { targetId })
}

export async function computerShareWindow(
  targetId: string,
  level: GrantLevel
): Promise<SharedWindow[]> {
  return getTransport().call("computer_share_window", { targetId, level })
}

/** Share every window named at one level — each as
 *  {@link computerShareWindow} would, skipping those that cannot be. */
export async function computerShareWindows(
  targetIds: string[],
  level: GrantLevel
): Promise<ShareManyResult> {
  return getTransport().call("computer_share_windows", { targetIds, level })
}

/** Share an application as a whole at `level`, or end its share at `none`:
 *  the one a window is of, or one already shared, by its share's id. */
export async function computerShareApp(
  app: { targetId: string } | { appId: string },
  level: GrantLevel
): Promise<ComputerStatePayload> {
  return getTransport().call("computer_share_app", {
    targetId: "targetId" in app ? app.targetId : null,
    appId: "appId" in app ? app.appId : null,
    level,
  })
}

/** Share the entire screen at `level`, or end its share at `none`. */
export async function computerShareScreen(
  level: GrantLevel
): Promise<ComputerStatePayload> {
  return getTransport().call("computer_share_screen", { level })
}

export async function computerRevokeAll(): Promise<void> {
  return getTransport().call("computer_revoke_all", {})
}

/** Stop sharing, all at once: every window stops being shared and whatever
 *  agents are in the middle of is cut off. Nothing is held after it —
 *  sharing a window again is the next step. */
export async function computerStop(): Promise<void> {
  return getTransport().call("computer_stop", {})
}

/** Whether the stop shortcut is in force; `computer://stop-key` carries the
 *  changes. */
export async function computerStopKeyStatus(): Promise<StopKeyStatus> {
  return getTransport().call("computer_stop_key_status", {})
}

/** The strip telling codeg how large it drew itself, in CSS pixels. */
export async function computerIndicatorFit(
  width: number,
  height: number
): Promise<void> {
  return getTransport().call("computer_indicator_fit", { width, height })
}

/** cua-driver: the release this codeg runs, what the cache holds, anything
 *  under way. `computer://driver` carries the changes. */
export async function computerDriverInfo(): Promise<DriverInfo> {
  return getTransport().call("computer_driver_info", {})
}

/** Fetch the release this codeg runs and clear older ones. Answers once it
 *  is done; the download's progress travels on `computer://driver`. */
export async function computerDriverInstall(): Promise<DriverInfo> {
  return getTransport().call(
    "computer_driver_install",
    {},
    { timeoutMs: 600_000 }
  )
}

/** Remove cua-driver: computer use is switched off and the helper stopped
 *  first. */
export async function computerDriverUninstall(): Promise<DriverInfo> {
  return getTransport().call("computer_driver_uninstall", {})
}
