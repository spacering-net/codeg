import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("@/lib/platform", () => ({ isDesktop: () => false }))

import LoginPage from "./page"
import enMessages from "@/i18n/messages/en.json"
import {
  AFTER_LOGIN_MAX_AGE_MS,
  __resetHarnessLinkForTests,
  keepHarnessLinkForLogin,
  queueHarnessLink,
} from "@/lib/harness-link"
import {
  __resetSrnResultForTests,
  keepSrnResultForLogin,
  queueSrnResult,
} from "@/lib/srn-account/web-result"

const AFTER_LOGIN_KEY = "codeg:harness-link-after-login"

/** What "Go to login" leaves behind for a page opened for a Harness item. */
function keptForLogin(ref: string) {
  queueHarnessLink(ref)
  keepHarnessLinkForLogin()
  __resetHarnessLinkForTests()
}

const reply = (status: number, challenge?: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(challenge ? { "WWW-Authenticate": challenge } : {}),
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  router.replace.mockClear()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  __resetHarnessLinkForTests()
  __resetSrnResultForTests()
})

function submit(token: string) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LoginPage />
    </NextIntlClientProvider>
  )
  fireEvent.change(screen.getByPlaceholderText("Access Token"), {
    target: { value: token },
  })
  fireEvent.click(screen.getByRole("button", { name: "Connect" }))
}

describe("login page", () => {
  it("asks a proxy for a 401 instead of a redirect", async () => {
    // The page first asks whether a proxy signed the browser in (no token);
    // this server wants one. The form's request follows.
    fetchMock
      .mockResolvedValueOnce(reply(401, 'Bearer realm="codeg"'))
      .mockResolvedValue(reply(200))
    submit("tok")
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalled())
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      Authorization: "Bearer tok",
      "X-Requested-With": "XMLHttpRequest",
    })
  })

  it("calls the token invalid when Codeg rejects it", async () => {
    fetchMock.mockResolvedValue(reply(401, 'Bearer realm="codeg"'))
    submit("bad")
    expect(
      await screen.findByText("Invalid token. Please check and try again.")
    ).toBeInTheDocument()
  })

  it("does not blame the token when a proxy in front of Codeg refused", async () => {
    fetchMock.mockResolvedValue(
      reply(401, 'Cloudflare-Access resource_metadata="https://x.test/m"')
    )
    submit("tok")
    expect(
      await screen.findByText(/Your sign-in to the proxy/)
    ).toBeInTheDocument()
    expect(
      screen.queryByText("Invalid token. Please check and try again.")
    ).not.toBeInTheDocument()
  })
})

describe("login page behind a proxy", () => {
  it("goes straight to the workspace when the proxy already admits the browser", async () => {
    fetchMock.mockResolvedValue(reply(200))
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LoginPage />
      </NextIntlClientProvider>
    )
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
    expect(localStorage.getItem("codeg_proxy_auth")).toBe("1")
  })
})

// A workspace opened for a Harness item (`/workspace?harness=…`) in a browser
// it turned away keeps the item on its way here; a successful login brings it
// back, once.
describe("login page — a Harness item kept for after the login", () => {
  it("sends a token login to the workspace with the item, once", async () => {
    keptForLogin("acme/pdf-tools")
    fetchMock
      .mockResolvedValueOnce(reply(401, 'Bearer realm="codeg"'))
      .mockResolvedValue(reply(200))
    submit("tok")

    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1))
    expect(router.replace).toHaveBeenCalledWith(
      "/workspace?harness=acme%2Fpdf-tools"
    )
    expect(localStorage.getItem("codeg_token")).toBe("tok")
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()
  })

  it("sends a proxy login to the workspace with the item", async () => {
    keptForLogin("acme/pdf-tools")
    fetchMock.mockResolvedValue(reply(200))
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LoginPage />
      </NextIntlClientProvider>
    )
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        "/workspace?harness=acme%2Fpdf-tools"
      )
    )
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()
  })

  it("does not reuse the item on a later login", async () => {
    keptForLogin("acme/pdf-tools")
    fetchMock
      .mockResolvedValueOnce(reply(401, 'Bearer realm="codeg"'))
      .mockResolvedValue(reply(200))
    submit("tok")
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        "/workspace?harness=acme%2Fpdf-tools"
      )
    )
    cleanup()
    router.replace.mockClear()

    fetchMock
      .mockReset()
      .mockResolvedValueOnce(reply(401, 'Bearer realm="codeg"'))
      .mockResolvedValue(reply(200))
    submit("tok")
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
  })

  it("does not bring back an item kept too long ago", async () => {
    const keptAt = Date.now()
    keptForLogin("acme/pdf-tools")
    vi.spyOn(Date, "now").mockReturnValue(keptAt + AFTER_LOGIN_MAX_AGE_MS + 1)
    fetchMock
      .mockResolvedValueOnce(reply(401, 'Bearer realm="codeg"'))
      .mockResolvedValue(reply(200))
    submit("tok")
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()
  })

  it("keeps the item when the token is refused, for the next try", async () => {
    keptForLogin("acme/pdf-tools")
    fetchMock.mockResolvedValue(reply(401, 'Bearer realm="codeg"'))
    submit("bad")
    expect(
      await screen.findByText("Invalid token. Please check and try again.")
    ).toBeInTheDocument()
    expect(router.replace).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).not.toBeNull()
  })

  // The proxy answering while a token goes in: two successes, one item.
  it("sends both successes of one visit to the same place", async () => {
    keptForLogin("acme/pdf-tools")
    let admit: (value: ReturnType<typeof reply>) => void = () => {}
    fetchMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          admit = resolve
        })
      )
      .mockResolvedValue(reply(200))
    submit("tok")
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1))
    admit(reply(200))
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(2))
    expect(router.replace.mock.calls).toEqual([
      ["/workspace?harness=acme%2Fpdf-tools"],
      ["/workspace?harness=acme%2Fpdf-tools"],
    ])
  })
})

describe("login page — an SRN sign-in's result kept for after the login", () => {
  it("sends the login to the workspace with the result, beside a Harness item, once", async () => {
    keptForLogin("acme/pdf-tools")
    queueSrnResult("access_denied")
    keepSrnResultForLogin()
    __resetSrnResultForTests()
    fetchMock.mockResolvedValueOnce(reply(401, 'Bearer realm="codeg"'))
    fetchMock.mockResolvedValue(reply(200))
    submit("tok")

    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1))
    expect(router.replace).toHaveBeenCalledWith(
      "/workspace?harness=acme%2Fpdf-tools&srn=access_denied"
    )
    expect(sessionStorage.getItem("codeg:srn-result-after-login")).toBeNull()
  })
})
