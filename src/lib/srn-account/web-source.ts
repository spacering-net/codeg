/**
 * Codeg Web's SRN account: this browser's session, which the server keeps
 * and signs in for (`/tmp/codeg-briefs/w2-api.md`). Plain same-origin
 * requests to `/api/account/srn*` — not the JSON transport, whose
 * `POST /api/<command>` does not fit a `GET` — carrying the instance's own
 * credential as every API call does. The SRN cookies travel by themselves.
 *
 * What the server answers is the account's, with one exception: a 401 is
 * always the instance refusing this browser, and goes to the transport's
 * unauthorized dialog like any other. The account itself never answers 401 —
 * "not signed in to SRN" is a state — so nothing here can send someone to the
 * instance's token page for an SRN reason.
 */
import { harnessOrigin } from "@/lib/harness/display"
import { normalizeAsset } from "@/lib/harness/normalize"
import { getHarnessStatus, refreshHarnessStatus } from "@/lib/harness/status"
import { getCurrentEffectiveAppLocale } from "@/lib/i18n"
import { getTransport } from "@/lib/transport"
import {
  codegAuthHeaders,
  getCodegToken,
  unauthorizedSource,
} from "@/lib/transport/web-auth"
import { notifyWebUnauthorized } from "@/lib/transport/web-connection-store"
import { openInNewTab, sendTabTo } from "./navigate"
import { SrnInstanceUnauthorized } from "./problems"
import {
  asAccountState,
  asSignOutResult,
  isSrnAvatarPath,
  record,
} from "./shape"
import type { SrnAccountSource } from "./source"
import type { SrnAccountState, SrnAccountStatus } from "./types"

export const SRN_ACCOUNT_PATH = "/api/account/srn"
export const SRN_LOGIN_PATH = "/api/account/srn/login"
export const SRN_LOGOUT_PATH = "/api/account/srn/logout"

const WEB_STATUSES: ReadonlySet<SrnAccountStatus> = new Set([
  "notEnabled",
  "signedOut",
  "pending",
  "signedIn",
  "unavailable",
])

/** Release builds' SpaceRing, when nothing on the page has said another. */
const DEFAULT_SRN_ORIGIN = "https://spacering.net"

const locale = () => getCurrentEffectiveAppLocale()

/**
 * The SpaceRing this server signs in with, as the page last learned it: from
 * a sign-in's page or a sign-out's "manage connections" address. A
 * development server may follow another one (`CODEG_SRN_ORIGIN`).
 */
let learnedOrigin: string | null = null

function learnOrigin(url: unknown): void {
  learnedOrigin = harnessOrigin(url) ?? learnedOrigin
}

/**
 * A page of the website's console, in the interface's language. Its origin:
 * what the page learned, else the one the server's Harness catalog names —
 * the same setting — else the release one. Worked out without waiting, so
 * that the new tab opens inside the click that asked for it.
 */
function srnConsolePage(path: "" | "clients/"): string {
  const origin =
    learnedOrigin ?? getHarnessStatus().origin ?? DEFAULT_SRN_ORIGIN
  const zh = locale() === "zh_cn" || locale() === "zh_tw"
  return `${origin}${zh ? "/zh" : ""}/console/${path}`
}

/** The website's list of connections. */
export function srnManageConnectionsUrl(): string {
  return srnConsolePage("clients/")
}

/** The console's front page. */
export function srnConsoleUrl(): string {
  return srnConsolePage("")
}

function isAccountProblem(value: unknown): boolean {
  const body = record(value)
  return (
    typeof body?.code === "string" &&
    typeof body.message === "string" &&
    typeof body.i18n_key === "string" &&
    body.i18n_key.startsWith("SrnAccount.errors.")
  )
}

async function accountRequest(
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      // The login and logout routes take JSON and nothing else.
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...codegAuthHeaders(getCodegToken()),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  })
  if (res.status === 401) {
    notifyWebUnauthorized(
      unauthorizedSource(res.headers.get("www-authenticate"))
    )
    throw new SrnInstanceUnauthorized()
  }
  if (res.ok) return res.json()
  const answer: unknown = await res.json().catch(() => null)
  // The account's own refusal (`SrnAccount.errors.*`, a 403 `originRefused`
  // among them), said in the popover. Anything else — a proxy's 403 page, a
  // 413, a gateway's 502 — is not the account's, and is said as what it is.
  if (isAccountProblem(answer)) throw answer
  throw { code: "network_error", message: `HTTP ${res.status}` }
}

async function readAccount(): Promise<SrnAccountState> {
  // The origin "manage connections" needs, ready before anyone asks.
  if (getHarnessStatus().origin === null) void refreshHarnessStatus()
  const state = asAccountState(
    await accountRequest(
      `${SRN_ACCOUNT_PATH}?locale=${encodeURIComponent(locale())}`
    ),
    WEB_STATUSES
  )
  if (state.status === "pending") learnOrigin(state.authorizationUrl)
  return state
}

export const webSrnAccount: SrnAccountSource = {
  kind: "web",
  read: readAccount,
  // No event tells a page its account changed: another tab may have signed
  // in or out. Reading is cheap (the server checks with SpaceRing at most
  // hourly), so the page reads again whenever it comes back into view.
  onChange: async (listener) => {
    const onFocus = () => listener()
    const onVisibility = () => {
      if (document.visibilityState === "visible") listener()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  },
  signIn: async () => {
    const started = record(
      await accountRequest(SRN_LOGIN_PATH, { locale: locale() })
    )
    const authorizationUrl = started?.authorizationUrl
    if (typeof authorizationUrl !== "string") {
      throw new Error("A sign-in without its page")
    }
    learnOrigin(authorizationUrl)
    // This tab goes to SpaceRing, and comes back to `/workspace?srn=…`.
    sendTabTo(authorizationUrl)
    return {
      status: "pending",
      authorizationUrl,
      expiresAt:
        typeof started?.expiresAt === "string" ? started.expiresAt : "",
      completing: false,
    }
  },
  // The page again, if the sign-in is still waiting; otherwise the state
  // says what became of it.
  reopenSignIn: async () => {
    const state = await readAccount()
    if (state.status === "pending") sendTabTo(state.authorizationUrl)
    return state
  },
  // There is no route to cancel: a sign-in left waiting expires by itself,
  // and a new one replaces it.
  cancelSignIn: readAccount,
  // Reading is checking: the server asks SpaceRing when a check is due.
  checkOnline: () => readAccount(),
  signOut: async (expectedSrn) => {
    const result = asSignOutResult(
      await accountRequest(SRN_LOGOUT_PATH, { expectedSrn, locale: locale() }),
      WEB_STATUSES
    )
    learnOrigin(result.manageConnectionsUrl)
    return result
  },
  openManageConnections: async () => {
    openInNewTab(srnManageConnectionsUrl())
  },
  openConsole: async () => {
    openInNewTab(srnConsoleUrl())
  },
  // H1's image proxy has a route in Codeg Web too; the browser never asks
  // SpaceRing itself.
  avatar: async (path) => {
    if (!isSrnAvatarPath(path)) throw new Error("Not an SRN avatar")
    return normalizeAsset(await getTransport().call("srn_asset", { path }))
  },
}

/** Test-only: forget the SpaceRing origin the page learned. */
export function __resetSrnWebSourceForTests(): void {
  learnedOrigin = null
}
