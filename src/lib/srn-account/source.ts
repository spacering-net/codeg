/**
 * Where the status bar's SRN entry gets the account from.
 *
 * - **Desktop** — every Tauri window, a remote workspace window included:
 *   the account is this computer's, kept by this app. Every call goes
 *   through the SHELL transport. `getTransport()` in a remote window reaches
 *   the remote Codeg, which has no such commands (and is not this computer).
 * - **Codeg Web** — the browser's own SRN session, kept by the server it is
 *   talking to: its own routes, plain same-origin requests
 *   (`./web-source.ts`). This includes a browser on the desktop app's
 *   embedded web service.
 *
 * {@link SrnAccountSource} is what both answer to; the popover asks
 * {@link SrnAccountSource.kind} only for what the two runtimes really do
 * differently (the Web has no cancel, and leaves the tab to sign in).
 */
import { normalizeAsset } from "@/lib/harness/normalize"
import type { SrnAsset } from "@/lib/harness/types"
import { getCurrentEffectiveAppLocale } from "@/lib/i18n"
import { getShellTransport, isDesktop } from "@/lib/transport"
import type { UnsubscribeFn } from "@/lib/transport"
import { asAccountState, asSignOutResult, isSrnAvatarPath } from "./shape"
import type {
  SrnAccountState,
  SrnAccountStatus,
  SrnCheckTrigger,
  SrnSignOutResult,
} from "./types"
import { webSrnAccount } from "./web-source"

export interface SrnAccountSource {
  kind: "desktop" | "web"
  /** The account as it is now. */
  read(): Promise<SrnAccountState>
  /** Calls `listener` whenever the account may have changed; the listener
   *  re-reads. */
  onChange(listener: () => void): Promise<UnsubscribeFn>
  /** Starts a sign-in in the browser; answers once it is waiting. On the
   *  Web this tab goes to SpaceRing. */
  signIn(): Promise<SrnAccountState>
  reopenSignIn(): Promise<SrnAccountState>
  /** Desktop only; the Web has nothing to cancel (a sign-in expires). */
  cancelSignIn(): Promise<SrnAccountState>
  checkOnline(trigger: SrnCheckTrigger): Promise<SrnAccountState>
  /** `expectedSrn`: the account the popover shows — nothing happens if
   *  another one is signed in by then. */
  signOut(expectedSrn?: number): Promise<SrnSignOutResult>
  /** The website's list of connections, in a browser. */
  openManageConnections(): Promise<void>
  /** The front page of the website's console, in a browser. */
  openConsole(): Promise<void>
  /** The avatar's bytes, fetched by the backend that knows the account. */
  avatar(path: string): Promise<SrnAsset>
}

/** `srn://account-changed`. Its payload (status and identity) is a summary;
 *  the state is re-read for the rest. */
export const SRN_ACCOUNT_CHANGED_EVENT = "srn://account-changed"

const DESKTOP_STATUSES: ReadonlySet<SrnAccountStatus> = new Set([
  "loading",
  "signedOut",
  "pending",
  "signedIn",
  "credentialUnreadable",
])

export function asSrnAccountState(value: unknown): SrnAccountState {
  return asAccountState(value, DESKTOP_STATUSES)
}

const shell = () => getShellTransport()
const locale = () => getCurrentEffectiveAppLocale()

/** The desktop app's own account: the `srn_*` commands, shell transport. */
export const desktopSrnAccount: SrnAccountSource = {
  kind: "desktop",
  read: async () => asSrnAccountState(await shell().call("srn_account")),
  onChange: (listener) =>
    shell().subscribe(SRN_ACCOUNT_CHANGED_EVENT, () => listener()),
  signIn: async () =>
    asSrnAccountState(await shell().call("srn_sign_in", { locale: locale() })),
  reopenSignIn: async () =>
    asSrnAccountState(await shell().call("srn_reopen_sign_in")),
  cancelSignIn: async () =>
    asSrnAccountState(await shell().call("srn_cancel_sign_in")),
  checkOnline: async (trigger) =>
    asSrnAccountState(await shell().call("srn_check_online", { trigger })),
  signOut: async (expectedSrn) =>
    asSignOutResult(
      await shell().call("srn_sign_out", {
        expectedSrn,
        locale: locale(),
      }),
      DESKTOP_STATUSES
    ),
  openManageConnections: async () => {
    await shell().call("srn_open_manage_connections", { locale: locale() })
  },
  // One command opens both pages. A backend that predates `page` ignores it
  // and opens the connections, which is still the console.
  openConsole: async () => {
    await shell().call("srn_open_manage_connections", {
      locale: locale(),
      page: "console",
    })
  },
  avatar: async (path) => {
    if (!isSrnAvatarPath(path)) throw new Error("Not an SRN avatar")
    return normalizeAsset(await shell().call("srn_asset", { path }))
  },
}

/**
 * This window's account source, decided by the runtime alone: a remote
 * workspace window is a desktop window, and its account is this computer's;
 * a browser has the server's.
 */
export function getSrnAccountSource(): SrnAccountSource {
  return isDesktop() ? desktopSrnAccount : webSrnAccount
}
