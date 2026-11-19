/**
 * The SRN (SpaceRing) account as the status bar's entry sees it — the shapes
 * the desktop's `srn_*` commands answer, exactly as serialized, and Codeg
 * Web's account routes, which follow them wherever the two mean the same
 * thing. Field names are a wire contract with `src-tauri/src/srn/types.rs`
 * and `src-tauri/src/srn/web/types.rs`.
 */
import type { AppCommandError } from "@/lib/types"

export interface SrnIdentity {
  srn: number
  /** May be empty: shown as `SRN <srn>` then. */
  name: string
  /** `/api/avatars/…` on SpaceRing, for `srn_asset`; `null` for none. */
  avatarPath: string | null
}

export type SrnOnlineStatus = "unchecked" | "confirmed" | "unconfirmed"

export interface SrnOnline {
  status: SrnOnlineStatus
  /** A check is under way. Only command answers show it: no event says a
   *  check started. */
  checking: boolean
  /** RFC 3339: when the last check ended, whatever it found. */
  checkedAt: string | null
  /** RFC 3339: when SpaceRing last confirmed the account. */
  confirmedAt: string | null
  /** Why the last check did not confirm it (`unconfirmed`). */
  problem: AppCommandError | null
}

export type SrnAccountState =
  | { status: "loading" }
  | { status: "signedOut"; problem?: AppCommandError }
  | {
      status: "pending"
      /** The authorization page. Its fragment holds the request id: it is
       *  shown to nobody, copied only on request, and never logged or kept. */
      authorizationUrl: string
      expiresAt: string
      /** The browser came back; Codeg is completing the sign-in. Always
       *  `false` on the Web, whose server completes it before the page is
       *  back. */
      completing: boolean
      /** Only `openBrowser`: the link is the way then. */
      problem?: AppCommandError
    }
  | { status: "signedIn"; account: SrnIdentity; online: SrnOnline }
  /** A stored sign-in that could not be read. NOT signed out. Desktop. */
  | { status: "credentialUnreadable"; problem: AppCommandError }
  /** This server has no SRN sign-in configured. Codeg Web. */
  | { status: "notEnabled" }
  /** The server cannot tell right now (its key or database would not open,
   *  or it could not be reached). NOT signed out. Codeg Web. */
  | { status: "unavailable"; problem: AppCommandError }

export type SrnAccountStatus = SrnAccountState["status"]

export interface SrnSignOutResult {
  /** Always `signedOut`. */
  state: SrnAccountState
  remote: "confirmed" | "unconfirmed" | "notSignedIn"
  /** `unconfirmed` only: where the connection can be removed. */
  manageConnectionsUrl?: string
  /** `unconfirmed` only: `signedOutLocally`, with `url` and `reason`. */
  problem?: AppCommandError
}

/** `srn_check_online`'s reason: `foreground` is the backend's own (window
 *  focus, startup), `online` the webview's `online` event, `user` the
 *  person's "check again" (and, on an unreadable sign-in, "try again"). */
export type SrnCheckTrigger = "foreground" | "online" | "user"
