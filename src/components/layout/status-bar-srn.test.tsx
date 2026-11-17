import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

type Handler = (args?: Record<string, unknown>) => unknown

const runtime = vi.hoisted(() => ({
  desktop: true,
  remote: false,
  label: "main",
  backend: {} as Record<string, Handler>,
  shellCalls: [] as [string, Record<string, unknown> | undefined][],
  remoteCalls: [] as string[],
  listeners: new Map<string, (payload: unknown) => void>(),
}))

vi.mock("@/lib/transport", () => ({
  isDesktop: () => runtime.desktop,
  getShellTransport: () => ({
    call: async (command: string, args?: Record<string, unknown>) => {
      runtime.shellCalls.push([command, args])
      const handler = runtime.backend[command]
      if (!handler) throw new Error(`Command ${command} not found`)
      return handler(args)
    },
    subscribe: async (event: string, handler: (payload: unknown) => void) => {
      runtime.listeners.set(event, handler)
      return () => runtime.listeners.delete(event)
    },
  }),
  // A remote workspace window's transport: the remote Codeg, which is not
  // this computer and has no account commands.
  getTransport: () => ({
    call: async (command: string) => {
      runtime.remoteCalls.push(command)
      throw new Error("not the remote's business")
    },
    subscribe: async () => () => {},
  }),
}))
vi.mock("@/lib/platform", () => ({
  isRemoteDesktopWindow: () => runtime.desktop && runtime.remote,
}))
vi.mock("@/lib/browser/window-label", () => ({
  getCurrentWindowLabel: () => runtime.label,
}))
vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  getCurrentEffectiveAppLocale: () => "zh_cn",
}))
vi.mock("@/lib/pet/sprite-url", () => ({
  createPetSpriteObjectUrl: (asset: { mime: string; dataBase64: string }) =>
    `data:${asset.mime};base64,${asset.dataBase64}`,
  revokePetSpriteObjectUrl: () => {},
}))

import { StatusBarSrn } from "./status-bar-srn"
import { __resetSrnAvatarCacheForTests } from "@/lib/srn-account/use-srn-avatar"

const AUTH_URL = "https://spacering.net/authorize/#request_id=abc"

const problem = (
  name: string,
  code: string,
  params: Record<string, string> = {}
) => ({
  code: "network_error",
  message: `English for ${name}`,
  i18n_key: `SrnAccount.errors.${name}`,
  i18n_params: { code, ...params },
})

const SIGNED_OUT = { status: "signedOut" }
const PENDING = {
  status: "pending",
  authorizationUrl: AUTH_URL,
  expiresAt: "2026-11-16T12:10:00.000Z",
  completing: false,
}
const signedIn = (
  account: Record<string, unknown> = {},
  online: Record<string, unknown> = {}
) => ({
  status: "signedIn",
  account: {
    srn: 10001,
    name: "Ada",
    avatarPath: null,
    ...account,
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

/** What `srn_account` answers from now on. */
function account(state: unknown) {
  runtime.backend.srn_account = () => state
}

function calls(command: string) {
  return runtime.shellCalls.filter(([name]) => name === command)
}

function mount(props: { compact?: boolean } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarSrn {...props} />
    </NextIntlClientProvider>
  )
}

function trigger() {
  return document.querySelector("[data-srn-status]") as HTMLElement
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function open() {
  fireEvent.click(trigger())
  await settle()
}

async function announce() {
  await act(async () => {
    runtime.listeners.get("srn://account-changed")?.({ status: "x" })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const writeText = vi.fn(async (text: string) => {
  void text
})

beforeEach(() => {
  runtime.desktop = true
  runtime.remote = false
  runtime.label = "main"
  runtime.shellCalls = []
  runtime.remoteCalls = []
  runtime.listeners.clear()
  runtime.backend = {
    srn_asset: () => ({ mime: "image/png", dataBase64: "AAAA" }),
  }
  account(SIGNED_OUT)
  __resetSrnAvatarCacheForTests()
  writeText.mockClear()
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("StatusBarSrn — what each state shows", () => {
  it("is a quiet ring while the keychain is being read", async () => {
    account({ status: "loading" })
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "loading")
    expect(document.querySelector("[data-srn-mark]")).toBeNull()
    await open()
    expect(screen.getByText("Reading the sign-in…")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sign in to SRN" })).toBeNull()
  })

  it("signed out: says what SRN is, that Harness needs no sign-in, and offers it", async () => {
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
    expect(trigger()).toHaveAccessibleName("SRN account: not signed in")
    await open()
    expect(
      screen.getByText(
        "SRN is your SpaceRing account. Browsing and installing from Harness works without signing in."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Sign in to SRN" })
    ).toBeInTheDocument()
  })

  it("signed out with a reason: says it in the red block", async () => {
    account({ status: "signedOut", problem: problem("revoked", "revoked") })
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SpaceRing ended this sign-in. Sign in again."
    )
  })

  it("waiting for the browser: the mark on the ring, reopen, copy and cancel", async () => {
    account(PENDING)
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "pending")
    expect(document.querySelector("[data-srn-mark]")).toHaveAttribute(
      "data-srn-mark",
      "waiting"
    )
    await open()
    expect(screen.getByText("Waiting")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Open page again" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Copy link" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    // The link is copied on request, never shown.
    expect(document.body.textContent).not.toContain(AUTH_URL)
  })

  it("a browser that would not open: says so, and the link is the way", async () => {
    account({
      ...PENDING,
      problem: problem("openBrowser", "open_browser_failed"),
    })
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The browser could not be opened. Copy the link and open it in your browser."
    )
  })

  it("finishing the sign-in: only the cancel stays", async () => {
    account({ ...PENDING, completing: true })
    mount()
    await settle()
    await open()
    expect(
      screen.getByText("The browser came back. Finishing sign-in…")
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open page again" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("signed in: avatar and name on the bar; number, online status and actions in the popover", async () => {
    account(signedIn())
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedIn")
    expect(trigger()).toHaveTextContent("Ada")
    await open()
    expect(screen.getByText("SRN 10001")).toBeInTheDocument()
    expect(screen.getByText("Confirmed online")).toBeInTheDocument()
    expect(screen.getByText("Checked 6 minutes ago")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Manage connections" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument()
  })

  it("on phones: the avatar alone, no name", async () => {
    account(signedIn())
    mount({ compact: true })
    await settle()
    expect(trigger()).not.toHaveTextContent("Ada")
    expect(trigger()).toHaveAccessibleName("SRN account: Ada")
  })

  it("a long name is cut short on the bar, whole in its tooltip", async () => {
    const long = "A".repeat(120)
    account(signedIn({ name: long }))
    mount()
    await settle()
    const name = trigger().querySelector("span.truncate")
    expect(name).toHaveClass("max-w-40", "truncate")
    expect(trigger()).toHaveAttribute("title", `SRN account: ${long}`)
  })

  it("no name: shown as its number", async () => {
    account(signedIn({ name: "" }))
    mount()
    await settle()
    expect(trigger()).toHaveTextContent("SRN 10001")
  })

  it("not confirmed online: still signed in, with the reason and when it was last confirmed", async () => {
    account(
      signedIn(
        {},
        {
          status: "unconfirmed",
          confirmedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          problem: problem("server", "server", { status: "503" }),
        }
      )
    )
    mount()
    await settle()
    await open()
    expect(screen.getByText("Not confirmed online")).toBeInTheDocument()
    expect(screen.getByText("Last confirmed 3 hours ago")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SpaceRing answered with an error (HTTP 503)."
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You stay signed in on this computer."
    )
  })

  it("an unreadable sign-in: not signed out; try again, sign in again, sign out", async () => {
    account({
      status: "credentialUnreadable",
      problem: {
        ...problem("keychainRead", "keychain_read_failed"),
        detail: "locked",
      },
    })
    mount()
    await settle()
    expect(document.querySelector("[data-srn-mark]")).toHaveAttribute(
      "data-srn-mark",
      "attention"
    )
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The sign-in stored in the keychain could not be read."
    )
    expect(screen.getByText("Details")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await settle()
    expect(calls("srn_check_online")).toEqual([
      ["srn_check_online", { trigger: "user" }],
    ])

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    await settle()
    // No number to name: the backend refuses `expectedSrn` here.
    expect(calls("srn_sign_out")[0][1]).toEqual({
      expectedSrn: undefined,
      locale: "zh_cn",
    })
  })

  it("every problem the account names has words, never its key", async () => {
    const { SRN_PROBLEMS } = await import("@/lib/srn-account/problems")
    const errors = enMessages.SrnAccount.errors as Record<string, string>
    for (const name of SRN_PROBLEMS) {
      expect(errors[name], name).toBeTruthy()
    }
  })
})

describe("StatusBarSrn — commands", () => {
  it("sign in: in the interface's language, then shows the waiting state", async () => {
    runtime.backend.srn_sign_in = () => PENDING
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Sign in to SRN" }))
    await settle()
    expect(calls("srn_sign_in")).toEqual([["srn_sign_in", { locale: "zh_cn" }]])
    expect(trigger()).toHaveAttribute("data-srn-status", "pending")
    expect(
      screen.getByRole("button", { name: "Open page again" })
    ).toBeInTheDocument()
  })

  it("a sign-in that could not start says why", async () => {
    runtime.backend.srn_sign_in = () => {
      throw problem("rateLimited", "rate_limited", { seconds: "42" })
    }
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Sign in to SRN" }))
    await settle()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SpaceRing asked Codeg to wait 42 s before trying again."
    )
  })

  it("reopen, copy and cancel", async () => {
    account(PENDING)
    runtime.backend.srn_reopen_sign_in = () => PENDING
    runtime.backend.srn_cancel_sign_in = () => SIGNED_OUT
    mount()
    await settle()
    await open()

    fireEvent.click(screen.getByRole("button", { name: "Open page again" }))
    await settle()
    expect(calls("srn_reopen_sign_in")).toEqual([
      ["srn_reopen_sign_in", undefined],
    ])

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    await settle()
    expect(writeText).toHaveBeenCalledWith(AUTH_URL)
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await settle()
    expect(calls("srn_cancel_sign_in")).toHaveLength(1)
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
  })

  it("a reopen that could not open the browser says so once; one with nothing waiting re-reads", async () => {
    account(PENDING)
    runtime.backend.srn_reopen_sign_in = () => {
      account({
        ...PENDING,
        problem: problem("openBrowser", "open_browser_failed"),
      })
      throw problem("openBrowser", "open_browser_failed")
    }
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Open page again" }))
    await settle()
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The browser could not be opened. Copy the link and open it in your browser."
    )

    runtime.backend.srn_reopen_sign_in = () => {
      throw problem("noPendingSignIn", "no_pending_sign_in")
    }
    fireEvent.click(screen.getByRole("button", { name: "Open page again" }))
    await settle()
    expect(
      screen.getByText("No sign-in is waiting for the browser.")
    ).toBeInTheDocument()
  })

  it("check again while SpaceRing asks for a pause says how long", async () => {
    account(signedIn())
    runtime.backend.srn_check_online = () => {
      throw problem("rateLimited", "rate_limited", { seconds: "30" })
    }
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Check again" }))
    await settle()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SpaceRing asked Codeg to wait 30 s before trying again."
    )
    expect(trigger()).toHaveAttribute("data-srn-status", "signedIn")
  })

  it("check again", async () => {
    account(signedIn())
    runtime.backend.srn_check_online = () => signedIn()
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Check again" }))
    await settle()
    expect(calls("srn_check_online")).toEqual([
      ["srn_check_online", { trigger: "user" }],
    ])
  })

  it("manage connections opens the website's list, in the interface's language", async () => {
    account(signedIn())
    runtime.backend.srn_open_manage_connections = () => null
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Manage connections" }))
    await settle()
    expect(calls("srn_open_manage_connections")).toEqual([
      ["srn_open_manage_connections", { locale: "zh_cn" }],
    ])
  })

  it("sign out names the account shown", async () => {
    account(signedIn())
    runtime.backend.srn_sign_out = () => ({
      state: SIGNED_OUT,
      remote: "confirmed",
    })
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    await settle()
    expect(calls("srn_sign_out")).toEqual([
      ["srn_sign_out", { expectedSrn: 10001, locale: "zh_cn" }],
    ])
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("a sign-out SpaceRing did not confirm: the red block, the reason, and the way to the website", async () => {
    const url = "https://spacering.net/zh/console/clients/"
    account(signedIn())
    runtime.backend.srn_sign_out = () => ({
      state: SIGNED_OUT,
      remote: "unconfirmed",
      manageConnectionsUrl: url,
      problem: problem("signedOutLocally", "signed_out_locally", {
        url,
        reason: "network",
      }),
    })
    runtime.backend.srn_open_manage_connections = () => null
    mount()
    await settle()
    await open()
    account(SIGNED_OUT)
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    await settle()
    // The sign-out's own event, and the re-read after it, keep the block.
    await announce()

    const block = screen.getByRole("alert")
    expect(block).toHaveTextContent(
      `Signed out on this computer. SpaceRing did not confirm — remove the connection at ${url}.`
    )
    expect(block).toHaveTextContent("SpaceRing could not be reached.")
    fireEvent.click(screen.getByRole("button", { name: "Manage connections" }))
    await settle()
    expect(calls("srn_open_manage_connections")).toHaveLength(1)
  })

  it("a sign-out refused because the account changed re-reads and says so", async () => {
    account(signedIn())
    runtime.backend.srn_sign_out = () => {
      throw problem("accountChanged", "account_changed")
    }
    mount()
    await settle()
    await open()
    account(signedIn({ srn: 20002, name: "Grace" }))
    const readsBefore = calls("srn_account").length
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    await settle()
    expect(calls("srn_account").length).toBeGreaterThan(readsBefore)
    expect(trigger()).toHaveTextContent("Grace")
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The signed-in account changed, so nothing was signed out."
    )
  })

  it("a sign-in left in the keychain is removed with a sign-out that names no account", async () => {
    account({
      status: "signedOut",
      problem: problem("keychainCleanup", "keychain_cleanup_failed"),
    })
    runtime.backend.srn_sign_out = () => ({
      state: SIGNED_OUT,
      remote: "confirmed",
    })
    mount()
    await settle()
    expect(document.querySelector("[data-srn-mark]")).toHaveAttribute(
      "data-srn-mark",
      "attention"
    )
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    await settle()
    expect(calls("srn_sign_out")[0][1]).toEqual({
      expectedSrn: undefined,
      locale: "zh_cn",
    })
  })
})

describe("StatusBarSrn — following the account", () => {
  it("re-reads on the account event and shows what changed", async () => {
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
    account(signedIn({ name: "Grace" }))
    await announce()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedIn")
    expect(trigger()).toHaveTextContent("Grace")
  })

  it("an answer that lost the race to a newer change does not overwrite it", async () => {
    let finish: (state: unknown) => void = () => {}
    runtime.backend.srn_sign_in = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Sign in to SRN" }))
    await settle()
    // The browser came back and the sign-in finished before the command's
    // own answer arrived.
    account(signedIn())
    await announce()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedIn")
    await act(async () => {
      finish(PENDING)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(trigger()).toHaveAttribute("data-srn-status", "signedIn")
  })

  it("a slow read asked before a newer change does not overwrite it", async () => {
    mount()
    await settle()
    // The first change's read is slow and answers what was true then.
    let finish: (state: unknown) => void = () => {}
    runtime.backend.srn_account = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    await announce()
    account(signedIn({ name: "Grace" }))
    await announce()
    expect(trigger()).toHaveTextContent("Grace")
    await act(async () => {
      finish(PENDING)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(trigger()).toHaveAttribute("data-srn-status", "signedIn")
  })

  // "Manage connections" answers no state: a re-read in flight while it
  // runs still lands.
  it.each([
    ["a sign-in SpaceRing ended", { status: "signedOut" }, "signedOut"],
    ["a check that finished", signedIn(), "signedIn"],
  ] as const)(
    "manage connections leaves %s in flight to land",
    async (_label, next, status) => {
      account(signedIn({}, { checking: true }))
      runtime.backend.srn_open_manage_connections = () => null
      mount()
      await settle()
      await open()

      let land: (state: unknown) => void = () => {}
      runtime.backend.srn_account = () =>
        new Promise((resolve) => {
          land = resolve
        })
      await announce()
      account(next)
      fireEvent.click(
        screen.getByRole("button", { name: "Manage connections" })
      )
      await settle()
      await act(async () => {
        land(next)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(trigger()).toHaveAttribute("data-srn-status", status)
      if (status === "signedIn") {
        expect(
          screen.getByRole("button", { name: "Check again" })
        ).toBeEnabled()
      }
    }
  )

  it("the network coming back asks for a check, when signed in", async () => {
    runtime.backend.srn_check_online = () => signedIn()
    mount()
    await settle()
    await act(async () => {
      window.dispatchEvent(new Event("online"))
    })
    expect(calls("srn_check_online")).toEqual([])

    account(signedIn())
    await announce()
    await act(async () => {
      window.dispatchEvent(new Event("online"))
    })
    expect(calls("srn_check_online")).toEqual([
      ["srn_check_online", { trigger: "online" }],
    ])
  })

  it("opens by itself when the browser's sign-in ends, in the main window", async () => {
    account(PENDING)
    mount()
    await settle()
    expect(screen.queryByText("SRN 10001")).toBeNull()
    account(signedIn())
    await announce()
    expect(screen.getByText("SRN 10001")).toBeInTheDocument()
  })

  it("opens for a failure that followed the browser's return, not for an expiry", async () => {
    account(PENDING)
    mount()
    await settle()
    account({ status: "signedOut", problem: problem("expired", "expired") })
    await announce()
    expect(screen.queryByRole("alert")).toBeNull()

    account(PENDING)
    await announce()
    account({
      status: "signedOut",
      problem: problem("accessDenied", "access_denied"),
    })
    await announce()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The connection was declined in the browser."
    )
  })

  it("other windows do not open by themselves", async () => {
    runtime.label = "remote-1"
    account(PENDING)
    mount()
    await settle()
    account(signedIn())
    await announce()
    expect(screen.queryByText("SRN 10001")).toBeNull()
  })
})

describe("StatusBarSrn — the avatar", () => {
  it("shows the picture fetched through the backend", async () => {
    const avatarPath = "/api/avatars/01a1/abcd.png"
    account(signedIn({ avatarPath }))
    mount()
    await settle()
    await waitFor(() =>
      expect(
        trigger().querySelector("[data-srn-avatar=image] img")
      ).toHaveAttribute("src", "data:image/png;base64,AAAA")
    )
    expect(calls("srn_asset")).toEqual([["srn_asset", { path: avatarPath }]])
  })

  it("falls back to the name's initial when the picture fails", async () => {
    runtime.backend.srn_asset = () => {
      throw problem("network", "network")
    }
    account(signedIn({ name: "ada", avatarPath: "/api/avatars/01a1/x.png" }))
    mount()
    await settle()
    const avatar = trigger().querySelector("[data-srn-avatar]")
    expect(avatar).toHaveAttribute("data-srn-avatar", "initial")
    expect(avatar).toHaveTextContent("A")
  })

  it("asks for nothing when there is no picture, or one from elsewhere", async () => {
    account(signedIn({ avatarPath: null }))
    const first = mount()
    await settle()
    expect(trigger().querySelector("[data-srn-avatar]")).toHaveTextContent("A")
    first.unmount()

    account(signedIn({ avatarPath: "/api/harness/v1/media/x.png" }))
    mount()
    await settle()
    expect(calls("srn_asset")).toEqual([])
  })
})

describe("StatusBarSrn — where the account lives (desktop)", () => {
  it("a remote workspace window shows this computer's account, through the shell", async () => {
    runtime.remote = true
    account(signedIn())
    runtime.backend.srn_sign_out = () => ({
      state: SIGNED_OUT,
      remote: "confirmed",
    })
    mount()
    await settle()
    expect(trigger()).toHaveTextContent("Ada")
    expect(runtime.listeners.has("srn://account-changed")).toBe(true)
    await open()
    expect(
      screen.getByText(
        "This is this computer's account, not the remote workspace's."
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    await settle()
    expect(calls("srn_sign_out")).toHaveLength(1)
    expect(runtime.remoteCalls).toEqual([])
  })
})
