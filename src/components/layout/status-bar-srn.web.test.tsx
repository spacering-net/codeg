/**
 * The SRN entry in Codeg Web: this browser's session on the server, through
 * `/api/account/srn*` (`w2-api.md`), and the result of a sign-in brought back
 * in the address.
 */
import { StrictMode } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

type Route = (init: RequestInit) => {
  status: number
  body?: unknown
  text?: string
  headers?: Record<string, string>
}

const runtime = vi.hoisted(() => ({
  desktop: false,
  locale: "en" as string,
  routes: {} as Record<string, Route>,
  requests: [] as { url: string; init: RequestInit }[],
  shellCalls: [] as string[],
  transportCalls: [] as [string, unknown][],
  harnessOrigin: null as string | null,
}))

vi.mock("@/lib/transport", () => ({
  isDesktop: () => runtime.desktop,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  getShellTransport: () => ({
    call: async (command: string) => {
      runtime.shellCalls.push(command)
      throw new Error(`Command ${command} not found`)
    },
    subscribe: async () => () => {},
  }),
  // In a browser the transport is the server's: the image proxy is there.
  getTransport: () => ({
    call: async (command: string, args: unknown) => {
      runtime.transportCalls.push([command, args])
      return { mime: "image/png", dataBase64: "AAAA" }
    },
    subscribe: async () => () => {},
  }),
}))
const unauthorized = vi.hoisted(() => vi.fn())
vi.mock("@/lib/transport/web-connection-store", () => ({
  notifyWebUnauthorized: unauthorized,
}))
const navigate = vi.hoisted(() => ({
  sendTabTo: vi.fn(),
  openInNewTab: vi.fn(),
}))
vi.mock("@/lib/srn-account/navigate", () => navigate)
vi.mock("@/lib/platform", () => ({ isRemoteDesktopWindow: () => false }))
vi.mock("@/lib/harness/status", () => ({
  getHarnessStatus: () => ({
    enabled: true,
    origin: runtime.harnessOrigin,
    support: "supported",
  }),
  refreshHarnessStatus: async () => {},
}))
vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  getCurrentEffectiveAppLocale: () => runtime.locale,
}))
vi.mock("@/lib/pet/sprite-url", () => ({
  createPetSpriteObjectUrl: (asset: { mime: string; dataBase64: string }) =>
    `data:${asset.mime};base64,${asset.dataBase64}`,
  revokePetSpriteObjectUrl: () => {},
}))

// The quick actions under the account are `quick-actions-menu.test.tsx`'s.
vi.mock("@/components/layout/quick-actions-menu", () => ({
  useQuickActions: () => ({}),
  QuickActionsItems: () => null,
  QuickActionsDialogs: () => null,
}))

import { StatusBarSrn } from "./status-bar-srn"
import { __resetSrnAvatarCacheForTests } from "@/lib/srn-account/use-srn-avatar"
import { __resetSrnWebSourceForTests } from "@/lib/srn-account/web-source"
import {
  __resetSrnResultForTests,
  keepSrnResultForLogin,
  takeSrnResultAfterLogin,
} from "@/lib/srn-account/web-result"

const AUTH_URL = "https://spacering.net/authorize/#request_id=abc"

const problem = (name: string, code: string, params = {}) => ({
  code: "invalid_input",
  message: `English for ${name}`,
  i18n_key: `SrnAccount.errors.${name}`,
  i18n_params: { code, ...params },
})

const signedIn = (online: Record<string, unknown> = {}) => ({
  status: "signedIn",
  account: {
    srn: 10001,
    name: "Ada",
    avatarPath: "/api/avatars/01a1/a.png",
  },
  online: {
    status: "confirmed",
    checking: false,
    checkedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    confirmedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    problem: null,
    ...online,
  },
})

/** Signed in, but SpaceRing could not be reached to confirm it. */
const UNCONFIRMED = signedIn({
  status: "unconfirmed",
  problem: problem("network", "network"),
})

/** What `GET /api/account/srn` answers from now on. */
function account(body: unknown, status = 200) {
  runtime.routes["GET /api/account/srn"] = () => ({ status, body })
}

function requests(method: string, path: string) {
  return runtime.requests.filter(
    (r) => (r.init.method ?? "GET") === method && r.url.split("?")[0] === path
  )
}

function json(init: RequestInit) {
  return JSON.parse(String(init.body))
}

function header(init: RequestInit, name: string) {
  return new Headers(init.headers).get(name)
}

function mount(strict = false) {
  const tree = (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarSrn />
    </NextIntlClientProvider>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

function trigger() {
  return document.querySelector("[data-srn-status]") as HTMLElement
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

async function open() {
  await userEvent.click(trigger())
  await settle()
}

/** The menu's items, the head (signed in, the way to the console) as
 *  "HEAD". */
function items() {
  return screen
    .getAllByRole("menuitem")
    .map((item) =>
      item.hasAttribute("data-srn-head") ? "HEAD" : item.textContent
    )
}

function consoleHead() {
  return document.querySelector<HTMLElement>("[data-srn-head]")
}

function address() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

beforeEach(() => {
  runtime.desktop = false
  runtime.locale = "en"
  runtime.routes = {}
  runtime.requests = []
  runtime.shellCalls = []
  runtime.transportCalls = []
  runtime.harnessOrigin = null
  unauthorized.mockClear()
  navigate.sendTabTo.mockClear()
  navigate.openInNewTab.mockClear()
  __resetSrnAvatarCacheForTests()
  __resetSrnWebSourceForTests()
  __resetSrnResultForTests()
  sessionStorage.clear()
  localStorage.setItem("codeg_token", "tok")
  window.history.replaceState(null, "", "/workspace")
  account({ status: "signedOut" })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      runtime.requests.push({ url, init })
      const key = `${init.method ?? "GET"} ${url.split("?")[0]}`
      const route = runtime.routes[key]
      if (!route) return new Response("no route", { status: 404 })
      const answer = route(init)
      return new Response(answer.text ?? JSON.stringify(answer.body ?? null), {
        status: answer.status,
        headers: {
          "Content-Type": answer.text ? "text/plain" : "application/json",
          ...answer.headers,
        },
      })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  window.history.replaceState(null, "", "/")
})

describe("Codeg Web — reading the account", () => {
  it("reads it same-origin, with the instance's credential and the interface's language", async () => {
    runtime.locale = "zh_cn"
    mount()
    await settle()
    const [read] = requests("GET", "/api/account/srn")
    expect(read.url).toBe("/api/account/srn?locale=zh_cn")
    expect(header(read.init, "Authorization")).toBe("Bearer tok")
    expect(header(read.init, "X-Requested-With")).toBe("XMLHttpRequest")
    expect(read.init.credentials).toBeUndefined()
    expect(runtime.shellCalls).toEqual([])
  })

  it("not enabled: a quiet ring, and the popover says so without a button", async () => {
    account({ status: "notEnabled" })
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "notEnabled")
    await open()
    expect(screen.getByText("Not enabled on this server")).toBeInTheDocument()
    expect(screen.queryByRole("menuitem")).toBeNull()
  })

  it("signed out, with the reason a session just ended", async () => {
    account({
      status: "signedOut",
      problem: problem("sessionUnreadable", "session_unreadable"),
    })
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This server could not read your saved sign-in. Sign in again."
    )
    expect(
      screen.getByRole("menuitem", { name: "Sign in to SRN" })
    ).toBeInTheDocument()
  })

  it("pending: starting over is the one row — no copy, no cancel, no page again", async () => {
    account({
      status: "pending",
      authorizationUrl: AUTH_URL,
      expiresAt: "2026-11-16T12:10:00.000Z",
    })
    const next = "https://spacering.net/authorize/#request_id=def"
    runtime.routes["POST /api/account/srn/login"] = () => ({
      status: 200,
      body: { authorizationUrl: next, expiresAt: "2026-11-16T12:20:00Z" },
    })
    mount()
    await settle()
    expect(document.querySelector("[data-srn-mark]")).toHaveAttribute(
      "data-srn-mark",
      "waiting"
    )
    await open()
    expect(screen.getByText("Sign-in not finished")).toBeInTheDocument()
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Start over"])
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("menu")).not.toHaveTextContent(/waits|\d:\d\d/)
    expect(document.body.textContent).not.toContain(AUTH_URL)

    fireEvent.click(screen.getByRole("menuitem", { name: "Start over" }))
    await settle()
    expect(requests("POST", "/api/account/srn/login")).toHaveLength(1)
    expect(navigate.sendTabTo).toHaveBeenCalledWith(next)
  })

  it("signed in: name and number in the head, which opens the console, sign-out, and the avatar through the server's image proxy", async () => {
    account(signedIn())
    mount()
    await settle()
    expect(trigger()).toHaveTextContent("Ada")
    expect(runtime.transportCalls).toEqual([
      ["srn_asset", { path: "/api/avatars/01a1/a.png" }],
    ])
    await open()
    expect(screen.getByText("SRN 10001")).toBeInTheDocument()
    expect(screen.getByRole("menu")).not.toHaveTextContent(/Confirmed|Checked/)
    expect(items()).toEqual(["HEAD", "Sign out"])
    expect(consoleHead()).toHaveAccessibleName("Ada SRN 10001 Open SRN console")
    expect(consoleHead()).toHaveAttribute(
      "title",
      "Ada\nSRN 10001\nOpen SRN console"
    )
  })

  it("could not confirm online: still signed in, one line, the reason under Details", async () => {
    account(
      signedIn({
        status: "unconfirmed",
        problem: problem("network", "network"),
      })
    )
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not confirmed online; still signed in."
    )
    // The check is a link in the note; the rows are a signed-in account's.
    expect(items()).toEqual(["HEAD", "Check again", "Details", "Sign out"])
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }))
    await settle()
    expect(screen.getByText("SRN could not be reached.")).toBeInTheDocument()
  })

  it("unavailable: not signed out; try again reads again, and there is no sign-in", async () => {
    account({
      status: "unavailable",
      problem: problem("keyUnavailable", "key_unavailable"),
    })
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The server could not open its sign-in key."
    )
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Try again"])
    const before = requests("GET", "/api/account/srn").length
    account(signedIn())
    fireEvent.click(screen.getByRole("menuitem", { name: "Try again" }))
    await settle()
    expect(requests("GET", "/api/account/srn").length).toBeGreaterThan(before)
    expect(trigger()).toHaveTextContent("Ada")
  })

  it("a server out of reach before anything was read: says so, and tries again", async () => {
    runtime.routes["GET /api/account/srn"] = () => ({
      status: 502,
      text: "Bad gateway",
    })
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "unavailable")
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 502")
    expect(unauthorized).not.toHaveBeenCalled()
  })

  it("reads again when the page comes back into view", async () => {
    mount()
    await settle()
    const before = requests("GET", "/api/account/srn").length
    account(signedIn())
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await settle()
    expect(requests("GET", "/api/account/srn").length).toBe(before + 1)
    expect(trigger()).toHaveTextContent("Ada")
  })
})

describe("Codeg Web — signing in and out", () => {
  it("sign in: JSON with the instance's credential, then this tab goes to SpaceRing", async () => {
    runtime.locale = "zh_tw"
    runtime.routes["POST /api/account/srn/login"] = () => ({
      status: 200,
      body: { authorizationUrl: AUTH_URL, expiresAt: "2026-11-16T12:10:00Z" },
    })
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to SRN" }))
    await settle()
    const [login] = requests("POST", "/api/account/srn/login")
    expect(header(login.init, "Content-Type")).toBe("application/json")
    expect(header(login.init, "Authorization")).toBe("Bearer tok")
    expect(json(login.init)).toEqual({ locale: "zh_tw" })
    expect(navigate.sendTabTo).toHaveBeenCalledWith(AUTH_URL)
  })

  it("sign out names the account shown; one SpaceRing did not confirm leads to the website", async () => {
    const url = "https://spacering.net/console/clients/"
    account(signedIn())
    runtime.routes["POST /api/account/srn/logout"] = () => ({
      status: 200,
      body: {
        state: { status: "signedOut" },
        remote: "unconfirmed",
        manageConnectionsUrl: url,
        problem: problem("signedOutLocally", "signed_out_locally", {
          url,
          reason: "session_unreadable",
        }),
      },
    })
    mount()
    await settle()
    await open()
    account({ status: "signedOut" })
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await settle()
    const [logout] = requests("POST", "/api/account/srn/logout")
    expect(json(logout.init)).toEqual({ expectedSrn: 10001, locale: "en" })
    expect(header(logout.init, "Authorization")).toBe("Bearer tok")

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Signed out in this browser, but SRN did not confirm."
    )
    expect(document.body.textContent).not.toContain(url)
    // Why, under Details; the way to the website, as the note's link; and
    // the sign-in, as the one row.
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Manage connections", "Details", "Sign in to SRN"])
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }))
    await settle()
    expect(
      screen.getByText("This server could not read your saved sign-in.", {
        exact: false,
      })
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Manage connections" })
    )
    expect(navigate.openInNewTab).toHaveBeenCalledWith(url)
  })

  // No event tells the Web its account changed, so a read the page had in
  // flight when it signed out must not undo the sign-out — whether it answers
  // before the sign-out does or after.
  it.each([
    ["confirmed", "before"],
    ["confirmed", "after"],
    ["unconfirmed", "before"],
    ["unconfirmed", "after"],
  ] as const)(
    "a %s sign-out stands against a read answered %s it",
    async (remote, when) => {
      const url = "https://spacering.net/console/clients/"
      account(signedIn())
      mount()
      await settle()

      // The read that opening the popover asks for, held back.
      let answerRead: () => void = () => {}
      const fetchMock = vi.mocked(fetch)
      const realFetch = fetchMock.getMockImplementation()!
      fetchMock.mockImplementationOnce(
        (input, init) =>
          new Promise((resolve) => {
            answerRead = () =>
              resolve(realFetch(input as string, init) as unknown as Response)
          })
      )
      let answerLogout: () => void = () => {}
      runtime.routes["POST /api/account/srn/logout"] = () => ({
        status: 200,
        body: {
          state: { status: "signedOut" },
          remote,
          ...(remote === "unconfirmed"
            ? {
                manageConnectionsUrl: url,
                problem: problem("signedOutLocally", "signed_out_locally", {
                  url,
                  reason: "network",
                }),
              }
            : {}),
        },
      })
      await open()
      fetchMock.mockImplementationOnce(
        (input, init) =>
          new Promise((resolve) => {
            answerLogout = () =>
              resolve(realFetch(input as string, init) as unknown as Response)
          })
      )
      fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
      await settle()

      if (when === "before") {
        await act(async () => answerRead())
        await settle()
        await act(async () => answerLogout())
      } else {
        await act(async () => answerLogout())
        await settle()
        await act(async () => answerRead())
      }
      await settle()

      expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
      if (remote === "unconfirmed") {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Signed out in this browser, but SRN did not confirm."
        )
      } else {
        expect(screen.queryByRole("alert")).toBeNull()
      }
    }
  )

  // "Check again" only reads: an answer of it that a newer read overtook is
  // an older picture, and must not bring back an account already gone.
  it("a slow check again does not undo a newer read", async () => {
    account(UNCONFIRMED)
    mount()
    await settle()
    await open()

    const fetchMock = vi.mocked(fetch)
    const realFetch = fetchMock.getMockImplementation()!
    let answerCheck: () => void = () => {}
    fetchMock.mockImplementationOnce(
      (input, init) =>
        new Promise((resolve) => {
          answerCheck = () =>
            resolve(realFetch(input as string, init) as unknown as Response)
        })
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Check again" }))
    await settle()

    // Meanwhile the menu is closed and opened again, which reads: the
    // server has let the session go.
    account({ status: "signedOut", problem: problem("revoked", "revoked") })
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
    await settle()
    await open()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")

    // The check's answer was asked before that read: it is let go.
    account(signedIn({ checking: true }))
    await act(async () => answerCheck())
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
  })

  it('a check the server has under way does not hold "check again" down', async () => {
    account(signedIn({ ...UNCONFIRMED.online, checking: true }))
    mount()
    await settle()
    await open()
    expect(
      screen.getByRole("menuitem", { name: "Check again" })
    ).not.toHaveAttribute("data-disabled")
  })

  it("the head opens the console's front page in a new tab, inside the click", async () => {
    account(signedIn())
    mount()
    await settle()
    await open()
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Ada SRN 10001 Open SRN console" })
    )
    // Synchronously: a tab opened after an await would be a popup.
    expect(navigate.openInNewTab).toHaveBeenCalledWith(
      "https://spacering.net/console/"
    )
    expect(navigate.sendTabTo).not.toHaveBeenCalled()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedIn")
    // The tab is open: the menu has done its part.
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("the keyboard opens the console from the head too", async () => {
    account(signedIn())
    mount()
    await settle()
    await open()
    const head = consoleHead() as HTMLElement
    act(() => head.focus())
    fireEvent.keyDown(head, { key: "Enter" })
    expect(navigate.openInNewTab).toHaveBeenCalledWith(
      "https://spacering.net/console/"
    )
    await settle()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it.each([
    ["not enabled", { status: "notEnabled" }],
    ["signed out", { status: "signedOut" }],
    [
      "waiting for the browser",
      {
        status: "pending",
        authorizationUrl: AUTH_URL,
        expiresAt: "2026-11-16T12:10:00.000Z",
      },
    ],
    [
      "unavailable",
      {
        status: "unavailable",
        problem: problem("keyUnavailable", "key_unavailable"),
      },
    ],
  ])("%s: the head opens nothing", async (_label, state) => {
    account(state)
    mount()
    await settle()
    await open()
    expect(consoleHead()).toBeNull()
    expect(
      screen.queryByRole("menuitem", { name: /Open SRN console/ })
    ).toBeNull()
    fireEvent.click(screen.getByText("SRN"))
    await settle()
    expect(navigate.openInNewTab).not.toHaveBeenCalled()
  })

  it("the console follows the SpaceRing the server uses, in the interface's language", async () => {
    runtime.harnessOrigin = "https://staging.spacering.net"
    runtime.locale = "zh_cn"
    account(signedIn())
    mount()
    await settle()
    await open()
    fireEvent.click(consoleHead() as HTMLElement)
    expect(navigate.openInNewTab).toHaveBeenCalledWith(
      "https://staging.spacering.net/zh/console/"
    )
  })

  it("manage connections, after a sign-out SpaceRing did not confirm, follows the same SpaceRing and language", async () => {
    runtime.harnessOrigin = "https://staging.spacering.net"
    runtime.locale = "zh_tw"
    account(signedIn())
    runtime.routes["POST /api/account/srn/logout"] = () => ({
      status: 200,
      body: {
        state: { status: "signedOut" },
        remote: "unconfirmed",
        problem: problem("signedOutLocally", "signed_out_locally", {
          reason: "network",
        }),
      },
    })
    mount()
    await settle()
    await open()
    account({ status: "signedOut" })
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await settle()
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Manage connections" })
    )
    expect(navigate.openInNewTab).toHaveBeenCalledWith(
      "https://staging.spacering.net/zh/console/clients/"
    )
  })

  it("a sign-out refused for another account re-reads and says so", async () => {
    account(signedIn())
    runtime.routes["POST /api/account/srn/logout"] = () => ({
      status: 409,
      body: problem("accountChanged", "account_changed"),
    })
    mount()
    await settle()
    await open()
    const before = requests("GET", "/api/account/srn").length
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await settle()
    expect(requests("GET", "/api/account/srn").length).toBeGreaterThan(before)
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The signed-in account changed, so nothing was signed out."
    )
  })
})

describe("Codeg Web — account answers are never the instance's login", () => {
  it.each([
    [
      409,
      problem("notEnabled", "not_enabled"),
      "This server has not enabled SRN sign-in.",
    ],
    [
      403,
      problem("originRefused", "origin_refused"),
      "Sign-in must start from this server's own address.",
    ],
    [
      400,
      problem("invalidRequest", "invalid_request"),
      "The request was not understood.",
    ],
    [
      502,
      problem("clientRejected", "client_rejected"),
      "SRN does not recognise this Codeg client, or has turned it off.",
    ],
    [
      503,
      problem("storage", "storage_failed"),
      "The server's database did not answer.",
    ],
  ])(
    "a %i from the account is said in the popover",
    async (status, body, text) => {
      runtime.routes["POST /api/account/srn/login"] = () => ({ status, body })
      mount()
      await settle()
      await open()
      fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to SRN" }))
      await settle()
      expect(screen.getByRole("alert")).toHaveTextContent(text)
      expect(unauthorized).not.toHaveBeenCalled()
      expect(navigate.sendTabTo).not.toHaveBeenCalled()
    }
  )

  it("a proxy's plain-text 403 is not the account's either: said as what it is", async () => {
    runtime.routes["POST /api/account/srn/login"] = () => ({
      status: 403,
      text: "Cross-origin request refused",
    })
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to SRN" }))
    await settle()
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 403")
    expect(unauthorized).not.toHaveBeenCalled()
  })

  it("a 401 is the instance refusing this browser: the transport's dialog, nothing in the popover", async () => {
    mount()
    await settle()
    await open()
    runtime.routes["POST /api/account/srn/login"] = () => ({
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="codeg"' },
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to SRN" }))
    await settle()
    expect(unauthorized).toHaveBeenCalledWith("codeg")
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

describe("Codeg Web — the result a sign-in comes back with", () => {
  it("opens the popover with it, once, and takes it off the address", async () => {
    window.history.replaceState(
      null,
      "",
      "/workspace?folder=3&srn=access_denied#chat"
    )
    mount()
    await settle()
    expect(address()).toBe("/workspace?folder=3#chat")
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The connection was declined in the browser."
    )

    // Closed, it is gone; opened again, it is not said again.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
    await settle()
    await open()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("ok: the popover opens on the account the server just made", async () => {
    window.history.replaceState(null, "", "/workspace?srn=ok")
    account(signedIn())
    mount()
    await settle()
    expect(address()).toBe("/workspace")
    expect(screen.getByText("SRN 10001")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("a result without a number is said without one", async () => {
    window.history.replaceState(null, "", "/workspace?srn=rate_limited")
    mount()
    await settle()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SRN asked Codeg to wait before trying again."
    )
  })

  it("drops a value that is not a result, and opens nothing", async () => {
    window.history.replaceState(null, "", "/workspace?srn=%3Cb%3Ehi&x=1")
    mount()
    await settle()
    expect(address()).toBe("/workspace?x=1")
    expect(screen.queryByText("Not signed in")).toBeNull()
  })

  it("is not shown twice under StrictMode, nor by the entry mounted again", async () => {
    window.history.replaceState(null, "", "/workspace?srn=expired")
    const first = mount(true)
    await settle()
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    first.unmount()

    mount(true)
    await settle()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("waits while the instance turns this browser away, and goes along to its login", async () => {
    window.history.replaceState(null, "", "/workspace?srn=flow_missing")
    runtime.routes["GET /api/account/srn"] = () => ({
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="codeg"' },
    })
    mount()
    await settle()
    expect(unauthorized).toHaveBeenCalledWith("codeg")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(address()).toBe("/workspace")

    // What "Go to login" does on its way (`redirectToCodegLogin`).
    keepSrnResultForLogin()
    expect(takeSrnResultAfterLogin()).toBe("flow_missing")
  })

  it("drops one kept for a login that never came, as the workspace loads", async () => {
    sessionStorage.setItem(
      "codeg:srn-result-after-login",
      JSON.stringify({ result: "ok", at: Date.now() })
    )
    mount()
    await settle()
    expect(sessionStorage.getItem("codeg:srn-result-after-login")).toBeNull()
    expect(screen.queryByText("Not signed in")).toBeNull()
  })
})

describe("the desktop is untouched", () => {
  it("asks the desktop commands, never the Web routes, and leaves `?srn=` alone", async () => {
    runtime.desktop = true
    window.history.replaceState(null, "", "/workspace?srn=ok")
    mount()
    await settle()
    expect(runtime.requests).toEqual([])
    expect(runtime.shellCalls).toContain("srn_account")
    expect(address()).toBe("/workspace?srn=ok")
  })
})
