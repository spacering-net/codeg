import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
// The quick actions below the account are `quick-actions-menu.test.tsx`'s:
// here they are one marked item, so the account's items are the rest.
vi.mock("@/components/layout/quick-actions-menu", async () => {
  const { DropdownMenuItem } = await import("@/components/ui/dropdown-menu")
  return {
    useQuickActions: () => ({}),
    QuickActionsItems: () => (
      <DropdownMenuItem data-quick-actions="">QUICK-ACTIONS</DropdownMenuItem>
    ),
    QuickActionsDialogs: () => null,
  }
})

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

/** Signed in, but SpaceRing could not be reached to confirm it. */
const UNCONFIRMED = () =>
  signedIn(
    {},
    { status: "unconfirmed", problem: problem("network", "network") }
  )

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
  await userEvent.click(trigger())
  await settle()
}

/**
 * The menu from top to bottom: the account's head (the group named after
 * it), dividers, and the rows — the quick actions, here one marked item, as
 * "QUICK-ACTIONS".
 */
function layout() {
  return [...screen.getByRole("menu").children].map((el) => {
    if (el.getAttribute("role") === "group") return "head"
    if (el.getAttribute("role") === "separator") return "—"
    if (el.hasAttribute("data-quick-actions")) return "QUICK-ACTIONS"
    return el.textContent
  })
}

/** The links inside the head's notes (not the head itself, which is an
 *  item of its own when signed in). */
function noteLinks() {
  return within(screen.getByRole("group"))
    .queryAllByRole("menuitem")
    .filter((item) => !item.hasAttribute("data-srn-head"))
    .map((item) => item.textContent)
}

/** The head as the way to the console: signed in only. */
function consoleHead() {
  return document.querySelector<HTMLElement>("[data-srn-head]")
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
  it("is a quiet ring while the keychain is being read, with no row of its own", async () => {
    account({ status: "loading" })
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "loading")
    expect(document.querySelector("[data-srn-mark]")).toBeNull()
    await open()
    expect(screen.getByText("Reading the sign-in…")).toBeInTheDocument()
    // Nothing to do yet: no sign-in row, and no divider waiting for one.
    expect(layout()).toEqual(["head", "—", "QUICK-ACTIONS"])
  })

  it("signed out: the head, the rows, and the sign-in alone at the foot", async () => {
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
    expect(trigger()).toHaveAccessibleName("SRN account: not signed in")
    await open()
    const menu = screen.getByRole("menu")
    expect(within(menu).getByText("SRN")).toBeInTheDocument()
    expect(within(menu).getByText("Not signed in")).toBeInTheDocument()
    expect(layout()).toEqual([
      "head",
      "—",
      "QUICK-ACTIONS",
      "—",
      "Sign in to SRN",
    ])
    // Nothing is wrong: no note.
    expect(within(menu).queryByRole("alert")).toBeNull()
    expect(menu).not.toHaveTextContent(/SpaceRing account|without signing in/)
  })

  it("no group titles: the head, then rows", async () => {
    account(signedIn())
    mount()
    await settle()
    await open()
    expect(document.querySelector("[data-slot=dropdown-menu-label]")).toBeNull()
  })

  it("signed out with a reason: one compact note under the head", async () => {
    account({ status: "signedOut", problem: problem("revoked", "revoked") })
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SRN ended this sign-in. Sign in again."
    )
    // The note is the head's; the only row of the account's is still the
    // sign-in.
    expect(within(screen.getByRole("group")).getByRole("alert")).toBeVisible()
    expect(noteLinks()).toEqual([])
    expect(layout()).toEqual([
      "head",
      "—",
      "QUICK-ACTIONS",
      "—",
      "Sign in to SRN",
    ])
  })

  it("waiting for the browser: the mark on the ring, one line, and only the cancel", async () => {
    account(PENDING)
    mount()
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "pending")
    expect(document.querySelector("[data-srn-mark]")).toHaveAttribute(
      "data-srn-mark",
      "waiting"
    )
    await open()
    const menu = screen.getByRole("menu")
    expect(within(menu).getByText("Continue in your browser")).toBeVisible()
    expect(layout()).toEqual([
      "head",
      "—",
      "QUICK-ACTIONS",
      "—",
      "Cancel sign-in",
    ])
    // No "open the page again", no explanation and no deadline: the line
    // and the one row say it.
    expect(
      within(menu).queryByRole("menuitem", { name: /page again/ })
    ).toBeNull()
    expect(within(menu).queryByRole("alert")).toBeNull()
    expect(menu).not.toHaveTextContent(/Approve|waits until|\d:\d\d/)
    // The link is copied on request, never shown.
    expect(document.body.textContent).not.toContain(AUTH_URL)
  })

  it("a browser that would not open: a note, and copying the link is its one way out", async () => {
    account({
      ...PENDING,
      problem: problem("openBrowser", "open_browser_failed"),
    })
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't open the browser."
    )
    expect(noteLinks()).toEqual(["Copy sign-in link"])
    expect(layout()).toEqual([
      "head",
      "—",
      "QUICK-ACTIONS",
      "—",
      "Cancel sign-in",
    ])
    expect(document.body.textContent).not.toContain(AUTH_URL)
  })

  it("finishing the sign-in: one line, and the cancel stays", async () => {
    account({ ...PENDING, completing: true })
    mount()
    await settle()
    await open()
    expect(screen.getByText("Finishing sign-in…")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(layout()).toEqual([
      "head",
      "—",
      "QUICK-ACTIONS",
      "—",
      "Cancel sign-in",
    ])
  })

  it("signed in: avatar and name share one capsule, labelled with the account", async () => {
    account(signedIn())
    mount()
    await settle()
    const capsule = screen.getByRole("button", { name: "SRN account: Ada" })
    expect(capsule).toBe(trigger())
    expect(capsule).toHaveAttribute("data-srn-status", "signedIn")
    expect(capsule).toHaveAttribute("aria-haspopup", "menu")
    expect(capsule).toHaveAttribute("aria-expanded", "false")
    // The same menu holds the quick actions: said as the description.
    expect(capsule).toHaveAccessibleDescription("Quick actions")
    // One control: the picture (or initial) and the name are inside it.
    expect(capsule.querySelector("[data-srn-avatar]")).not.toBeNull()
    expect(capsule).toHaveTextContent("Ada")
    expect(capsule).toHaveClass("rounded-full")
    await open()
    expect(capsule).toHaveAttribute("aria-expanded", "true")
  })

  it("signed in: the head, the rows, sign-out at the foot, and no console row", async () => {
    account(signedIn())
    mount()
    await settle()
    await open()
    const menu = screen.getByRole("menu")
    const head = within(menu).getByRole("group", { name: "SRN account: Ada" })
    expect(within(head).getByText("Ada")).toBeInTheDocument()
    expect(within(head).getByText("SRN 10001")).toBeInTheDocument()
    // Confirmed is the usual case: nothing is said about it.
    expect(menu).not.toHaveTextContent(/Confirmed|Checked|online/)
    expect(within(menu).queryByRole("alert")).toBeNull()
    // The console is the head's to open: no row of its own.
    expect(layout()).toEqual(["head", "—", "QUICK-ACTIONS", "—", "Sign out"])
    expect(
      within(menu).getAllByRole("menuitem", { name: /SRN console/ })
    ).toEqual([consoleHead()])
    // The connections page is for a sign-out SpaceRing did not hear, not
    // for an account that is simply signed in.
    expect(
      within(menu).queryByRole("menuitem", { name: /Manage connections/ })
    ).toBeNull()
  })

  it("signed in, not checked yet: nothing about it either", async () => {
    account(
      signedIn({}, { status: "unchecked", checkedAt: null, confirmedAt: null })
    )
    mount()
    await settle()
    await open()
    expect(layout()).toEqual(["head", "—", "QUICK-ACTIONS", "—", "Sign out"])
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("on phones: the avatar alone, no name", async () => {
    account(signedIn())
    mount({ compact: true })
    await settle()
    expect(trigger()).not.toHaveTextContent("Ada")
    expect(trigger()).toHaveAccessibleName("SRN account: Ada")
    expect(trigger().querySelector("[data-srn-avatar]")).not.toBeNull()
  })

  it("a long name is cut short on the bar, whole in its tooltip", async () => {
    const long = "A".repeat(120)
    account(signedIn({ name: long }))
    mount()
    await settle()
    const name = trigger().querySelector("span.truncate")
    expect(name).toHaveClass("max-w-40", "truncate")
    expect(trigger()).toHaveAttribute("title", `SRN account: ${long}`)
    await open()
    // In the head too: cut short, whole in its tooltip and its name.
    const inHead = within(screen.getByRole("group")).getByText(long)
    expect(inHead).toHaveClass("truncate")
    expect(consoleHead()?.title.split("\n")[0]).toBe(long)
    expect(consoleHead()).toHaveAccessibleName(
      `${long} SRN 10001 Open SRN console`
    )
  })

  it("no name: shown as its number", async () => {
    account(signedIn({ name: "" }))
    mount()
    await settle()
    expect(trigger()).toHaveTextContent("SRN 10001")
  })

  it("not confirmed online: still signed in, one amber line, and check again in it", async () => {
    account(
      signedIn(
        {},
        {
          status: "unconfirmed",
          confirmedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          problem: {
            ...problem("server", "server", { status: "503" }),
            detail: "HTTP 503 from /api/me",
          },
        }
      )
    )
    runtime.backend.srn_check_online = () => signedIn()
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not confirmed online; still signed in."
    )
    expect(noteLinks()).toEqual(["Check again", "Details"])
    // The rows are a signed-in account's: the check is not one of them.
    expect(layout()).toEqual(["head", "—", "QUICK-ACTIONS", "—", "Sign out"])
    // Why, folded away.
    expect(screen.queryByText(/HTTP 503/)).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }))
    await settle()
    expect(
      screen.getByText("SRN answered with an error (HTTP 503).")
    ).toBeInTheDocument()
    expect(screen.getByText("HTTP 503 from /api/me")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("menuitem", { name: "Check again" }))
    await settle()
    expect(calls("srn_check_online")).toEqual([
      ["srn_check_online", { trigger: "user" }],
    ])
    expect(screen.getByRole("menu")).toBeInTheDocument()
  })

  it("not confirmed, with no reason given: still says so, with nothing to unfold", async () => {
    account(signedIn({}, { status: "unconfirmed", problem: null }))
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not confirmed online; still signed in."
    )
    expect(noteLinks()).toEqual(["Check again"])
  })

  it("an unreadable sign-in: not signed out; try again in the note, sign in again at the foot", async () => {
    account({
      status: "credentialUnreadable",
      problem: {
        ...problem("keychainRead", "keychain_read_failed"),
        detail: "locked",
      },
    })
    runtime.backend.srn_sign_in = () => PENDING
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
    expect(noteLinks()).toEqual(["Try again", "Details"])
    // One row of the account's; no sign-out.
    expect(layout()).toEqual([
      "head",
      "—",
      "QUICK-ACTIONS",
      "—",
      "Sign in again",
    ])
    // The platform's words are folded away behind an item the keyboard
    // reaches like the others, and it keeps the menu open.
    const details = screen.getByRole("menuitem", { name: "Details" })
    expect(details).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("locked")).toBeNull()
    fireEvent.click(details)
    await settle()
    expect(details).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("locked")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("menuitem", { name: "Try again" }))
    await settle()
    expect(calls("srn_check_online")).toEqual([
      ["srn_check_online", { trigger: "user" }],
    ])

    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in again" }))
    await settle()
    expect(calls("srn_sign_in")).toEqual([["srn_sign_in", { locale: "zh_cn" }]])
    expect(calls("srn_sign_out")).toEqual([])
  })

  it("a sign-in left in the keychain: its note, and sign-out is the one row", async () => {
    account({
      status: "signedOut",
      problem: problem("keychainCleanup", "keychain_cleanup_failed"),
    })
    mount()
    await settle()
    await open()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A sign-in that has ended is still in the keychain. Sign out to remove it."
    )
    expect(noteLinks()).toEqual([])
    expect(layout()).toEqual(["head", "—", "QUICK-ACTIONS", "—", "Sign out"])
  })

  it("says SRN, not SpaceRing, in every language", async () => {
    const locales = [
      "en",
      "zh-CN",
      "zh-TW",
      "ja",
      "ko",
      "es",
      "de",
      "fr",
      "pt",
      "ar",
    ]
    const strings = (node: unknown): string[] =>
      typeof node === "string"
        ? [node]
        : Object.values(node as Record<string, unknown>).flatMap(strings)
    for (const locale of locales) {
      const { default: messages } = await import(
        `@/i18n/messages/${locale}.json`
      )
      for (const namespace of ["SrnAccount", "Harness"]) {
        const said = strings(messages[namespace])
        expect(said.length, `${locale} ${namespace}`).toBeGreaterThan(0)
        expect(
          said.filter((text) => text.includes("SpaceRing")),
          `${locale} ${namespace}`
        ).toEqual([])
      }
      expect(messages.SrnAccount.errors.network, locale).toContain("SRN")
      expect(messages.SrnAccount.actions.goingToSrn, locale).toContain("SRN")
      expect(messages.SrnAccount.actions.openConsole, locale).toContain("SRN")
    }
    expect(enMessages.SrnAccount.errors.revoked).toBe(
      "SRN ended this sign-in. Sign in again."
    )
    expect(enMessages.Harness.errors.network).toBe(
      "SRN Harness could not be reached. Check the connection and try again."
    )
  })

  it("every problem the account names has words, never its key", async () => {
    const { SRN_PROBLEMS } = await import("@/lib/srn-account/problems")
    const errors = enMessages.SrnAccount.errors as Record<string, string>
    for (const name of SRN_PROBLEMS) {
      expect(errors[name], name).toBeTruthy()
    }
  })
})

describe("StatusBarSrn — the head opens the console", () => {
  it("signed in, the head is one item: named by the account and what it does", async () => {
    account(signedIn())
    mount()
    await settle()
    await open()
    const head = consoleHead() as HTMLElement
    expect(head).toHaveAttribute("role", "menuitem")
    expect(within(screen.getByRole("group")).getAllByRole("menuitem")).toEqual([
      head,
    ])
    expect(head).toHaveAccessibleName("Ada SRN 10001 Open SRN console")
    expect(head).toHaveAttribute("title", "Ada\nSRN 10001\nOpen SRN console")
    // Avatar, name and number are inside it, on the grid as before.
    expect(head.querySelector("[data-srn-avatar]")).not.toBeNull()
    expect(head.firstElementChild).toHaveAttribute("data-srn-avatar")
    expect(head).toHaveTextContent("AdaSRN 10001")
    // Lit as a row is, inside the menu's padding.
    expect(head).toHaveClass("rounded-xl", "focus:bg-accent")
    // The ↗ is always there, phones included, and stronger when lit.
    const mark = head.querySelector(".lucide-arrow-up-right")
    expect(mark).not.toBeNull()
    expect(mark).toHaveAttribute("aria-hidden", "true")
    expect(mark?.getAttribute("class")).toContain(
      "group-focus/srn-head:text-accent-foreground"
    )
  })

  it("with no name, it is named by the number once", async () => {
    account(signedIn({ name: "  " }))
    mount()
    await settle()
    await open()
    expect(consoleHead()).toHaveAccessibleName("SRN 10001 Open SRN console")
    expect(consoleHead()).toHaveAttribute(
      "title",
      "SRN 10001\nOpen SRN console"
    )
  })

  it("the keyboard reaches it first, and Enter opens the console", async () => {
    account(signedIn())
    runtime.backend.srn_open_manage_connections = () => null
    mount()
    await settle()
    trigger().focus()
    await userEvent.keyboard("{Enter}")
    await settle()
    // Radix puts a menu opened from the keyboard on its first item.
    await waitFor(() => expect(document.activeElement).toBe(consoleHead()))
    await userEvent.keyboard("{ArrowDown}")
    expect(document.activeElement).not.toBe(consoleHead())
    await userEvent.keyboard("{ArrowUp}")
    expect(document.activeElement).toBe(consoleHead())
    await userEvent.keyboard("{Enter}")
    await settle()
    expect(calls("srn_open_manage_connections")).toEqual([
      ["srn_open_manage_connections", { locale: "zh_cn", page: "console" }],
    ])
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("in a remote workspace window, the line about whose account it is stays out of its name", async () => {
    runtime.remote = true
    account(signedIn())
    mount()
    await settle()
    await open()
    expect(consoleHead()).toHaveTextContent(
      "This is this computer's account, not the remote workspace's."
    )
    expect(consoleHead()).toHaveAccessibleName("Ada SRN 10001 Open SRN console")
  })

  it.each([
    ["loading", { status: "loading" }],
    ["signed out", SIGNED_OUT],
    ["waiting for the browser", PENDING],
    [
      "unreadable",
      {
        status: "credentialUnreadable",
        problem: problem("keychainRead", "keychain_read_failed"),
      },
    ],
    [
      "left in the keychain",
      {
        status: "signedOut",
        problem: problem("keychainCleanup", "keychain_cleanup_failed"),
      },
    ],
  ] as const)(
    "%s: the head only says, and opens nothing",
    async (_label, state) => {
      account(state)
      runtime.backend.srn_open_manage_connections = () => null
      mount()
      await settle()
      await open()
      expect(consoleHead()).toBeNull()
      const group = screen.getByRole("group")
      // Its picture and words are no item; only a note's links are.
      const items = within(group).queryAllByRole("menuitem")
      expect(items.map((item) => item.textContent)).toEqual(noteLinks())
      expect(
        within(group).getByText("SRN").closest("[role=menuitem]")
      ).toBeNull()
      expect(group.querySelector(".lucide-arrow-up-right")).toBeNull()
      fireEvent.click(within(group).getByText("SRN"))
      await settle()
      expect(calls("srn_open_manage_connections")).toEqual([])
      expect(screen.queryByRole("menuitem", { name: /SRN console/ })).toBeNull()
    }
  )
})

describe("StatusBarSrn — commands", () => {
  it("sign in: in the interface's language, then shows the waiting state", async () => {
    runtime.backend.srn_sign_in = () => PENDING
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to SRN" }))
    await settle()
    expect(calls("srn_sign_in")).toEqual([["srn_sign_in", { locale: "zh_cn" }]])
    expect(trigger()).toHaveAttribute("data-srn-status", "pending")
    // The menu stayed open on the account: the next step is in it.
    expect(
      screen.getByRole("menuitem", { name: "Cancel sign-in" })
    ).toBeInTheDocument()
  })

  it("an account row at work keeps the menu open, with a spinner", async () => {
    let finish: (state: unknown) => void = () => {}
    runtime.backend.srn_sign_in = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to SRN" }))
    await settle()
    const busy = screen.getByRole("menuitem", { name: "Opening the browser…" })
    expect(busy).toHaveAttribute("aria-busy", "true")
    expect(busy).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("menu")).toBeInTheDocument()
    await act(async () => {
      finish(PENDING)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByRole("menu")).toBeInTheDocument()
  })

  it("a sign-in that could not start says why", async () => {
    runtime.backend.srn_sign_in = () => {
      throw problem("rateLimited", "rate_limited", { seconds: "42" })
    }
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to SRN" }))
    await settle()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SRN asked Codeg to wait 42 s before trying again."
    )
    // Still the one row.
    expect(layout().slice(-2)).toEqual(["—", "Sign in to SRN"])
  })

  it("copy the link (where the browser would not open), then cancel", async () => {
    account({
      ...PENDING,
      problem: problem("openBrowser", "open_browser_failed"),
    })
    runtime.backend.srn_cancel_sign_in = () => SIGNED_OUT
    mount()
    await settle()
    await open()

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy sign-in link" }))
    await settle()
    expect(writeText).toHaveBeenCalledWith(AUTH_URL)
    expect(screen.getByRole("menuitem", { name: "Copied" })).toBeInTheDocument()
    // Copying is not a way to leave the menu.
    expect(screen.getByRole("menu")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel sign-in" }))
    await settle()
    expect(calls("srn_cancel_sign_in")).toHaveLength(1)
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
    expect(layout().slice(-1)).toEqual(["Sign in to SRN"])
    // Nothing asks for the page again any more.
    expect(calls("srn_reopen_sign_in")).toEqual([])
  })

  it("the cancel stays while the sign-in completes", async () => {
    account({ ...PENDING, completing: true })
    runtime.backend.srn_cancel_sign_in = () => SIGNED_OUT
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel sign-in" }))
    await settle()
    expect(calls("srn_cancel_sign_in")).toHaveLength(1)
  })

  it("check again while SpaceRing asks for a pause says how long", async () => {
    account(UNCONFIRMED())
    runtime.backend.srn_check_online = () => {
      throw problem("rateLimited", "rate_limited", { seconds: "30" })
    }
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Check again" }))
    await settle()
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) =>
          alert.textContent?.includes(
            "SRN asked Codeg to wait 30 s before trying again."
          )
        )
    ).toBe(true)
    expect(trigger()).toHaveAttribute("data-srn-status", "signedIn")
  })

  it("a check under way says so in its link, and holds it", async () => {
    account(UNCONFIRMED())
    let finish: (state: unknown) => void = () => {}
    runtime.backend.srn_check_online = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Check again" }))
    await settle()
    const busy = screen.getByRole("menuitem", { name: "Checking…" })
    expect(busy).toHaveAttribute("aria-busy", "true")
    expect(busy).toHaveAttribute("aria-disabled", "true")
    await act(async () => {
      finish(signedIn())
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // Confirmed: the note is gone with its link.
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("the head opens the console's front page, in the interface's language", async () => {
    account(signedIn())
    runtime.backend.srn_open_manage_connections = () => null
    mount()
    await settle()
    await open()
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Ada SRN 10001 Open SRN console" })
    )
    await settle()
    expect(calls("srn_open_manage_connections")).toEqual([
      ["srn_open_manage_connections", { locale: "zh_cn", page: "console" }],
    ])
    expect(screen.queryByRole("alert")).toBeNull()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedIn")
    // The page is open in the browser: the menu has done its part.
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("a console that could not be opened says why, under the head", async () => {
    account(signedIn())
    runtime.backend.srn_open_manage_connections = () => {
      throw problem("openBrowser", "open_browser_failed")
    }
    mount()
    await settle()
    await open()
    fireEvent.click(consoleHead() as HTMLElement)
    await settle()
    // The menu stays to say why, and the head can be tried again.
    expect(
      within(screen.getByRole("group")).getByRole("alert")
    ).toHaveTextContent("The browser could not be opened.")
    expect(consoleHead()).not.toHaveAttribute("data-disabled")
    expect(consoleHead()).not.toHaveAttribute("aria-busy")
    expect(
      consoleHead()?.querySelector(".lucide-arrow-up-right")
    ).not.toBeNull()
    fireEvent.click(consoleHead() as HTMLElement)
    await settle()
    expect(calls("srn_open_manage_connections")).toHaveLength(2)
  })

  it("while the console opens, the head says so with a spinner, and the account's rows wait", async () => {
    account(signedIn())
    let finish: () => void = () => {}
    runtime.backend.srn_open_manage_connections = () =>
      new Promise<null>((resolve) => {
        finish = () => resolve(null)
      })
    mount()
    await settle()
    await open()
    const head = consoleHead() as HTMLElement
    expect(head.querySelector(".lucide-arrow-up-right")).not.toBeNull()
    fireEvent.click(head)
    await settle()
    expect(head).toHaveAttribute("aria-busy", "true")
    expect(head).toHaveAttribute("aria-disabled", "true")
    // The spinner in the ↗'s place.
    expect(head.querySelector(".lucide-arrow-up-right")).toBeNull()
    expect(head.querySelector(".animate-spin")).not.toBeNull()
    expect(head).toHaveAccessibleName("Ada SRN 10001 Open SRN console")
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    // One click is one page.
    fireEvent.click(head)
    await settle()
    expect(calls("srn_open_manage_connections")).toHaveLength(1)
    await act(async () => {
      finish()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // Open in the browser: the menu has done its part.
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("another command at work holds the head too, still at full strength", async () => {
    account(signedIn())
    runtime.backend.srn_sign_out = () => new Promise(() => {})
    mount()
    await settle()
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await settle()
    const head = consoleHead() as HTMLElement
    expect(head).toHaveAttribute("aria-disabled", "true")
    expect(head).not.toHaveAttribute("aria-busy")
    expect(head).toHaveClass("data-disabled:pointer-events-none")
    expect(head.className).not.toMatch(/data-disabled:opacity/)
    fireEvent.click(head)
    await settle()
    expect(calls("srn_open_manage_connections")).toEqual([])
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await settle()
    expect(calls("srn_sign_out")).toEqual([
      ["srn_sign_out", { expectedSrn: 10001, locale: "zh_cn" }],
    ])
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
    expect(screen.queryByRole("alert")).toBeNull()
    // Still open, on the signed-out account.
    expect(layout()).toEqual([
      "head",
      "—",
      "QUICK-ACTIONS",
      "—",
      "Sign in to SRN",
    ])
  })

  it("a sign-out SpaceRing did not confirm: a short note, why under Details, and the way to the website", async () => {
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await settle()
    // The sign-out's own event, and the re-read after it, keep the note.
    await announce()

    const note = screen.getByRole("alert")
    expect(note).toHaveTextContent(
      "Signed out on this computer, but SRN did not confirm."
    )
    // The link is the way there, not the address in the words.
    expect(document.body.textContent).not.toContain(url)
    expect(noteLinks()).toEqual(["Manage connections", "Details"])
    expect(layout()).toEqual([
      "head",
      "—",
      "QUICK-ACTIONS",
      "—",
      "Sign in to SRN",
    ])
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }))
    await settle()
    expect(screen.getByText("SRN could not be reached.")).toBeInTheDocument()

    // The connection may need removing by hand: the link opens the list,
    // not the console's front page.
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Manage connections" })
    )
    await settle()
    expect(calls("srn_open_manage_connections")).toEqual([
      ["srn_open_manage_connections", { locale: "zh_cn" }],
    ])
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("signing out by keyboard leaves the focus on the foot row, now the sign-in", async () => {
    account(signedIn())
    runtime.backend.srn_sign_out = () => ({
      state: SIGNED_OUT,
      remote: "confirmed",
    })
    mount()
    await settle()
    await open()
    const signOut = screen.getByRole("menuitem", { name: "Sign out" })
    act(() => signOut.focus())
    fireEvent.keyDown(signOut, { key: "Enter" })
    await settle()
    expect(trigger()).toHaveAttribute("data-srn-status", "signedOut")
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Sign in to SRN" })
    )
  })

  it("a link the keyboard was on that goes away gives the focus back to the menu", async () => {
    account(UNCONFIRMED())
    runtime.backend.srn_check_online = () => signedIn()
    mount()
    await settle()
    await open()
    const check = screen.getByRole("menuitem", { name: "Check again" })
    act(() => check.focus())
    fireEvent.keyDown(check, { key: "Enter" })
    await settle()
    // Confirmed: the note went, and its link with it.
    expect(check).not.toBeInTheDocument()
    // Not left on the page, where the menu's arrow keys cannot reach.
    expect(screen.getByRole("menu")).toContainElement(
      document.activeElement as HTMLElement
    )
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await settle()
    expect(calls("srn_account").length).toBeGreaterThan(readsBefore)
    expect(trigger()).toHaveTextContent("Grace")
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The signed-in account changed, so nothing was signed out."
    )
  })

  it("a sign-in left in the keychain is removed with a sign-out that names no account; then the row is the sign-in", async () => {
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await settle()
    expect(calls("srn_sign_out")[0][1]).toEqual({
      expectedSrn: undefined,
      locale: "zh_cn",
    })
    expect(screen.queryByRole("alert")).toBeNull()
    expect(layout().slice(-1)).toEqual(["Sign in to SRN"])
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to SRN" }))
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

  // Opening the console answers no state: a re-read in flight while it
  // runs still lands.
  it.each([
    ["a sign-in SpaceRing ended", { status: "signedOut" }, "signedOut"],
    ["a check that finished", signedIn({ name: "Grace" }), "signedIn"],
  ] as const)(
    "opening the console leaves %s in flight to land",
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
      fireEvent.click(consoleHead() as HTMLElement)
      await settle()
      await act(async () => {
        land(next)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(trigger()).toHaveAttribute("data-srn-status", status)
      if (status === "signedIn") expect(trigger()).toHaveTextContent("Grace")
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
    // The one menu: the account, and the quick actions under it.
    expect(trigger()).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("QUICK-ACTIONS")).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await settle()
    expect(calls("srn_sign_out")).toHaveLength(1)
    expect(runtime.remoteCalls).toEqual([])
  })
})
