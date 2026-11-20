/**
 * Light checks that an answer is a state the popover can draw: a status this
 * runtime has, and the fields that status is drawn from. The backend and this
 * frontend ship together, so they guard against a development build caught
 * between steps rather than against a hostile answer.
 */
import type {
  SrnAccountState,
  SrnAccountStatus,
  SrnSignOutResult,
} from "./types"

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

/** Where an account's picture may come from: SpaceRing's avatars, and
 *  nothing else the image proxy would also fetch. */
const AVATAR_PREFIX = "/api/avatars/"

export function isSrnAvatarPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith(AVATAR_PREFIX)
}

export function asAccountState(
  value: unknown,
  statuses: ReadonlySet<SrnAccountStatus>
): SrnAccountState {
  const state = record(value)
  const status = state?.status
  if (
    !state ||
    typeof status !== "string" ||
    !statuses.has(status as SrnAccountStatus)
  ) {
    throw new Error("Not an SRN account state")
  }
  if (status === "pending") {
    if (typeof state.authorizationUrl !== "string") {
      throw new Error("A pending sign-in without its page")
    }
    // The Web has no `completing`: its server finishes a sign-in before the
    // page is back.
    return { ...state, completing: state.completing === true } as Extract<
      SrnAccountState,
      { status: "pending" }
    >
  }
  if (status === "signedIn") {
    const account = record(state.account)
    if (!account || typeof account.srn !== "number" || !record(state.online)) {
      throw new Error("A signed-in account without who")
    }
  }
  if (
    (status === "credentialUnreadable" || status === "unavailable") &&
    !record(state.problem)
  ) {
    throw new Error("A state without its problem")
  }
  return state as unknown as SrnAccountState
}

export function asSignOutResult(
  value: unknown,
  statuses: ReadonlySet<SrnAccountStatus>
): SrnSignOutResult {
  const result = record(value)
  if (!result) throw new Error("Not a sign-out result")
  return {
    ...(result as unknown as SrnSignOutResult),
    state: asAccountState(result.state, statuses),
  }
}
