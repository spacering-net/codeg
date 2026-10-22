import { render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("@/lib/platform", () => ({ isDesktop: () => false }))

import Page from "./page"

const reply = (status: number, challenge?: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(challenge ? { "WWW-Authenticate": challenge } : {}),
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  router.replace.mockClear()
  localStorage.setItem("codeg_token", "tok")
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("root page token check", () => {
  it("asks a proxy for a 401 instead of a redirect", async () => {
    fetchMock.mockResolvedValue(reply(200))
    render(<Page />)
    await waitFor(() => expect(router.replace).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer tok",
      "X-Requested-With": "XMLHttpRequest",
    })
  })

  it("clears the token and goes to /login when Codeg rejects it", async () => {
    fetchMock.mockResolvedValue(reply(401, 'Bearer realm="codeg"'))
    render(<Page />)
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"))
    expect(localStorage.getItem("codeg_token")).toBeNull()
  })

  it("keeps the token when the 401 came from a proxy in front of Codeg", async () => {
    fetchMock.mockResolvedValue(
      reply(401, 'Cloudflare-Access resource_metadata="https://x.test/m"')
    )
    render(<Page />)
    // The workspace's connection guard offers the reload from there.
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
    expect(localStorage.getItem("codeg_token")).toBe("tok")
  })
})

describe("root page without a token", () => {
  beforeEach(() => localStorage.removeItem("codeg_token"))

  it("enters the workspace when a proxy in front of Codeg admits the browser", async () => {
    fetchMock.mockResolvedValue(reply(200))
    render(<Page />)
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
    expect(localStorage.getItem("codeg_proxy_auth")).toBe("1")
  })

  it("asks for the token when the server wants one", async () => {
    fetchMock.mockResolvedValue(reply(401, 'Bearer realm="codeg"'))
    render(<Page />)
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"))
  })
})
