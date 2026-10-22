import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("@/lib/platform", () => ({ isDesktop: () => false }))

import LoginPage from "./page"
import enMessages from "@/i18n/messages/en.json"

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
  localStorage.clear()
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
