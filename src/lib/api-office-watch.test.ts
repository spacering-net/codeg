import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebTransport } from "./transport/web-transport"

let transport: WebTransport

vi.mock("@/lib/transport", () => ({
  getTransport: () => transport,
  getShellTransport: () => transport,
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

import { startOfficeWatch } from "./api"

let finishRequest: (response: Response) => void
let requestSignal: AbortSignal

beforeEach(() => {
  vi.useFakeTimers()
  transport = new WebTransport("http://localhost")
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, options: RequestInit) => {
      requestSignal = options.signal as AbortSignal
      return new Promise<Response>((resolve, reject) => {
        finishRequest = resolve
        requestSignal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"))
        })
      })
    })
  )
})

afterEach(() => {
  transport.destroy()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("office watch startup over WebTransport", () => {
  it("keeps the request alive beyond the backend's 120s startup budget", async () => {
    const started = { port: 26315, cap: "watch-cap" }
    const request = startOfficeWatch("/workspace", "report.docx")
    // Attach the rejection handler before moving time, so the old 60s
    // transport deadline fails this regression without an unhandled rejection.
    const outcome = request.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    await vi.advanceTimersByTimeAsync(135_000)
    expect(requestSignal.aborted).toBe(false)
    finishRequest(new Response(JSON.stringify(started)))
    await expect(outcome).resolves.toEqual({ value: started })
  })

  it("still aborts a hung preview startup after 150s", async () => {
    const outcome = startOfficeWatch("/workspace", "report.docx").catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(150_000)
    expect(requestSignal.aborted).toBe(true)
    await expect(outcome).resolves.toEqual(new Error("Request timed out"))
  })
})
