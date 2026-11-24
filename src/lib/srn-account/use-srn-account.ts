"use client"

// The SRN account for the status bar's entry, followed live.
//
// Desktop: one account per app, shown in every window: the backend announces
// each change on `srn://account-changed` and this re-reads the state, which
// never waits. Subscribed before the first read, so nothing that lands in
// between is missed. Codeg Web: this browser's session on the server, read
// again whenever the page comes back into view (no event exists there), and
// the result of a sign-in brought back in the address (`?srn=`) shown once.
//
// Answers are applied in the order things happened, not the order they were
// asked for. A read's answer — and that of an action that only reads, such as
// "check again" — is applied only if nothing was read or applied since it was
// asked (`seq`). The answer of an action that changes the account (sign in,
// sign out, cancel) is newer than any read asked before it came, so it is
// applied, and reads still in flight are let go — unless the account was
// heard to change while it ran (`changes`): then the order of the two is not
// known, and the account is read again after both. (The Web hears of no
// change but its own actions; a read in flight there must never undo a
// sign-out it predates.)

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import type { SrnAsset } from "@/lib/harness/types"
import {
  SrnInstanceUnauthorized,
  srnProblemCode,
  srnProblemOf,
  type SrnProblem,
} from "./problems"
import { getSrnAccountSource, type SrnAccountSource } from "./source"
import type { SrnAccountState } from "./types"
import {
  claimSrnResultFromAddress,
  srnProblemOfResult,
  subscribeWaitingSrnResult,
  takeWaitingSrnResult,
  waitingSrnResult,
} from "./web-result"

export type SrnAccountView = SrnAccountState

const nothingWaiting = () => null

export type SrnAction =
  | "signIn"
  | "reopen"
  | "cancel"
  | "check"
  | "signOut"
  | "manage"
  | "console"

/** Actions that change the account; the rest only read it (`check`, and
 *  `reopen`, which opens a page and answers the state as it is). */
const CHANGES_ACCOUNT: ReadonlySet<SrnAction> = new Set([
  "signIn",
  "cancel",
  "signOut",
])

/** A command that failed, kept to be said beside the button it came from. */
export interface SrnActionFailure {
  action: SrnAction
  problem: SrnProblem
}

/**
 * Ends of a sign-in that follow the browser's return, by `code` — the ones
 * after which the backend brings the main window forward: declined, the
 * exchange refused or lost, the keychain not keeping the token, `/me`
 * refusing it or naming another account, and a sign-in that could not be
 * taken back out of the keychain. Not an expiry, and not a cancel (which
 * leaves no problem, or an unreadable sign-in's own).
 */
const BROWSER_OUTCOMES: ReadonlySet<string> = new Set([
  "access_denied",
  "exchange_failed",
  "client_rejected",
  "network",
  "rate_limited",
  "server",
  "invalid_response",
  "keychain_write_failed",
  "account_changed",
  "revoked",
  "keychain_cleanup_failed",
])

function isBrowserOutcome(prev: SrnAccountView, next: SrnAccountState) {
  if (prev.status !== "pending") return false
  if (next.status === "signedIn") return true
  if (next.status === "signedOut" || next.status === "credentialUnreadable") {
    const code = srnProblemCode(next.problem)
    return code !== null && BROWSER_OUTCOMES.has(code)
  }
  return false
}

export interface SrnAccountController {
  /** Which runtime's account this is: the popover differs where the two do
   *  (the Web has no cancel, and leaves the tab to sign in). */
  kind: SrnAccountSource["kind"]
  state: SrnAccountView
  /** The command in flight from this window, if any. */
  busy: SrnAction | null
  failure: SrnActionFailure | null
  /** A sign-out SpaceRing did not confirm: signed out here, connection
   *  still listed on the website. Kept while signed out. */
  signOutNotice: SrnProblem | null
  /** Codeg Web: how the sign-in this page came back from ended, when it
   *  failed — shown until the popover closes. */
  resultNotice: SrnProblem | null
  /** Fetches the avatar through the backend that knows the account. */
  avatar: (path: string) => Promise<SrnAsset>
  refresh: () => void
  /** Forgets the last command's failure (the popover opening afresh). */
  clearFailure: () => void
  /** Forgets the sign-in's result once it has been seen. */
  dismissResult: () => void
  signIn: () => void
  reopenSignIn: () => void
  cancelSignIn: () => void
  /** "Check again" when signed in; "try again" on an unreadable sign-in. */
  checkAgain: () => void
  signOut: () => void
  /** Opens the website's page; answers whether it went (a failure is kept
   *  in `failure`), so a menu can close only once the page is open. */
  openManageConnections: () => Promise<boolean>
  openConsole: () => Promise<boolean>
}

export interface UseSrnAccountOptions {
  /** A sign-in just ended after the browser came back — signed in, or a
   *  failure worth seeing (on the Web: the page came back with its result). */
  onBrowserOutcome?: () => void
}

export function useSrnAccount(
  options: UseSrnAccountOptions = {}
): SrnAccountController {
  const [source] = useState<SrnAccountSource>(getSrnAccountSource)
  const [state, setState] = useState<SrnAccountView>({ status: "loading" })
  const [busy, setBusy] = useState<SrnAction | null>(null)
  const [failure, setFailure] = useState<SrnActionFailure | null>(null)
  const [signOutNotice, setSignOutNotice] = useState<SrnProblem | null>(null)
  const [resultNotice, setResultNotice] = useState<SrnProblem | null>(null)
  const web = source.kind === "web"
  const waitingResult = useSyncExternalStore(
    subscribeWaitingSrnResult,
    web ? waitingSrnResult : nothingWaiting,
    nothingWaiting
  )

  const stateRef = useRef<SrnAccountView>(state)
  const seqRef = useRef(0)
  /** Changes heard (the desktop's event; the Web page coming back into
   *  view), for commands to tell whether one happened while they ran. */
  const changesRef = useRef(0)
  const aliveRef = useRef(true)
  const onOutcomeRef = useRef(options.onBrowserOutcome)
  useEffect(() => {
    onOutcomeRef.current = options.onBrowserOutcome
  })

  const apply = useCallback((next: SrnAccountState) => {
    // Anything still in flight was asked before this was known.
    seqRef.current += 1
    const prev = stateRef.current
    stateRef.current = next
    setState(next)
    if (next.status !== "signedOut") setSignOutNotice(null)
    if (isBrowserOutcome(prev, next)) {
      // The outcome is what is shown now, not an older command's failure.
      setFailure(null)
      onOutcomeRef.current?.()
    }
  }, [])

  const refresh = useCallback(() => {
    const seq = ++seqRef.current
    source
      .read()
      .then((next) => {
        if (aliveRef.current && seq === seqRef.current) apply(next)
      })
      .catch((error: unknown) => {
        // A state already known stands; the next change or opening re-reads.
        // With none known yet (the Web's server out of reach), there is
        // nothing to stand: say why, and "try again" reads again. An
        // instance that refused this browser is the transport's dialog's.
        if (
          !aliveRef.current ||
          seq !== seqRef.current ||
          error instanceof SrnInstanceUnauthorized ||
          stateRef.current.status !== "loading"
        ) {
          return
        }
        apply({
          status: "unavailable",
          problem: {
            code: "network_error",
            message: srnProblemOf(error).fallback,
          },
        })
      })
  }, [source, apply])

  useEffect(() => {
    aliveRef.current = true
    let disposed = false
    let unsubscribe: (() => void) | undefined
    source
      .onChange(() => {
        changesRef.current += 1
        refresh()
      })
      .then((off) => {
        if (disposed) off()
        else unsubscribe = off
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) refresh()
      })

    // The network came back: worth a check, which the backend throttles to
    // at most hourly. Window focus is not wired here — the desktop's backend
    // checks on focus by itself, and the Web source's `onChange` re-reads.
    const onOnline = () => {
      if (stateRef.current.status !== "signedIn") return
      const since = seqRef.current
      source
        .checkOnline("online")
        .then((next) => {
          if (aliveRef.current && since === seqRef.current) apply(next)
        })
        .catch(() => {})
    }
    window.addEventListener("online", onOnline)

    return () => {
      disposed = true
      aliveRef.current = false
      unsubscribe?.()
      window.removeEventListener("online", onOnline)
    }
  }, [source, refresh, apply])

  /** Runs one command from a button: one at a time per window, its failure
   *  kept to be said, and the state re-read after a failure (several leave
   *  it changed: an account that is not the one shown, a sign-in that ended
   *  meanwhile). */
  const run = useCallback(
    async <T>(
      action: SrnAction,
      call: (source: SrnAccountSource) => Promise<T>,
      stateOf?: (result: T) => SrnAccountState
    ): Promise<T | undefined> => {
      const changesBefore = changesRef.current
      const changing = CHANGES_ACCOUNT.has(action)
      // Asked now, an answer that only reads is newer than reads asked
      // before. One that answers no state (opening a website page) is not an
      // answer at all, and leaves the reads in flight alone.
      const seq = changing || !stateOf ? seqRef.current : ++seqRef.current
      setBusy(action)
      setFailure(null)
      try {
        const result = await call(source)
        if (aliveRef.current && stateOf) {
          if (!changing) {
            if (seq === seqRef.current) apply(stateOf(result))
          } else if (changesRef.current === changesBefore) {
            apply(stateOf(result))
          } else {
            refresh()
          }
        }
        return result
      } catch (error) {
        // The instance refusing this browser is said by the transport's
        // dialog, not here.
        if (aliveRef.current && !(error instanceof SrnInstanceUnauthorized)) {
          setFailure({ action, problem: srnProblemOf(error) })
          refresh()
        }
        return undefined
      } finally {
        if (aliveRef.current) setBusy(null)
      }
    },
    [source, apply, refresh]
  )

  const signIn = useCallback(() => {
    setSignOutNotice(null)
    void run(
      "signIn",
      (s) => s.signIn(),
      (next) => next
    )
  }, [run])

  const reopenSignIn = useCallback(() => {
    void run(
      "reopen",
      (s) => s.reopenSignIn(),
      (next) => next
    )
  }, [run])

  const cancelSignIn = useCallback(() => {
    void run(
      "cancel",
      (s) => s.cancelSignIn(),
      (next) => next
    )
  }, [run])

  const checkAgain = useCallback(() => {
    void run(
      "check",
      (s) => s.checkOnline("user"),
      (next) => next
    )
  }, [run])

  const signOut = useCallback(() => {
    // The account the popover shows: if another has signed in since, the
    // backend refuses rather than sign that one out. An unreadable sign-in,
    // or one left in the keychain, has no number to name.
    const current = stateRef.current
    const expectedSrn =
      current.status === "signedIn" ? current.account.srn : undefined
    void run(
      "signOut",
      (s) => s.signOut(expectedSrn),
      (result) => result.state
    ).then((result) => {
      if (!aliveRef.current || result?.remote !== "unconfirmed") return
      setSignOutNotice(
        result.problem
          ? srnProblemOf(result.problem)
          : {
              name: "signedOutLocally",
              params: { url: result.manageConnectionsUrl ?? "" },
              detail: null,
              fallback: "",
            }
      )
    })
  }, [run])

  // The page is asked for inside the call, before anything is awaited: on
  // the Web the new tab has to open within the click.
  const openPage = useCallback(
    async (
      action: "manage" | "console",
      open: (source: SrnAccountSource) => Promise<void>
    ) => {
      let opened = false
      await run(action, async (s) => {
        await open(s)
        opened = true
      })
      return opened
    },
    [run]
  )

  const openManageConnections = useCallback(
    () => openPage("manage", (s) => s.openManageConnections()),
    [openPage]
  )

  const openConsole = useCallback(
    () => openPage("console", (s) => s.openConsole()),
    [openPage]
  )

  const clearFailure = useCallback(() => setFailure(null), [])
  const dismissResult = useCallback(() => setResultNotice(null), [])

  // Codeg Web: the result of a sign-in comes back in the address. Taken off
  // it as the workspace loads (into a slot outside React, which outlives this
  // entry being mounted again), and shown once the account has been read —
  // which also says the instance admitted this browser. Turned away, the
  // result waits, and goes with the redirect to the login page.
  useEffect(() => {
    if (web) claimSrnResultFromAddress()
  }, [web])

  const readYet = state.status !== "loading"
  useEffect(() => {
    if (!web || !readYet || waitingResult === null) return
    const result = takeWaitingSrnResult()
    if (result === null) return
    // Consumes a result held outside React (taken off the address) once the
    // account has been read; the notice it yields can only be set from here.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads an external one-shot slot
    setResultNotice(srnProblemOfResult(result))
    setFailure(null)
    onOutcomeRef.current?.()
    // The session the server just made, or what is left after a failure.
    refresh()
  }, [web, readYet, waitingResult, refresh])

  return {
    kind: source.kind,
    state,
    busy,
    failure,
    signOutNotice: state.status === "signedOut" ? signOutNotice : null,
    resultNotice,
    avatar: source.avatar,
    refresh,
    clearFailure,
    dismissResult,
    signIn,
    reopenSignIn,
    cancelSignIn,
    checkAgain,
    signOut,
    openManageConnections,
    openConsole,
  }
}
