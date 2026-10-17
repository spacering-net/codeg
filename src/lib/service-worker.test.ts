import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/transport", () => ({
  isDesktop: vi.fn(() => false),
}))

import { isDesktop } from "@/lib/transport"
import {
  CACHEABLE_PREFIXES,
  SERVICE_WORKER_SCOPE,
  loadedCacheableAssets,
  registerAppServiceWorker,
  serviceWorkerEligible,
  serviceWorkerUrl,
} from "./service-worker"

/**
 * Registration is an optimization with several silent no-op gates, and a
 * wrong gate has a real cost: registering on desktop would let the worker
 * intercept the Tauri webview's resource loads. So each gate gets its own
 * case, and the passing case asserts the exact register() arguments.
 */

const mockIsDesktop = vi.mocked(isDesktop)

function setServiceWorkerApi(value: ServiceWorkerRegistration | undefined) {
  if (value === undefined) {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  } else {
    Object.defineProperty(navigator, "serviceWorker", {
      value,
      configurable: true,
    })
  }
}

function mockRegistration(
  register: () => Promise<unknown>,
  addEventListener: (type: string, listener: () => void) => void = () => {}
) {
  setServiceWorkerApi({
    register,
    addEventListener,
  } as unknown as ServiceWorkerRegistration)
  return register
}

function stubLoadedResources(names: string[]) {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue(
    names.map((name) => ({ name }) as PerformanceEntry)
  )
}

let originalSecureContext: boolean
let originalApi: unknown

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production")
  mockIsDesktop.mockReturnValue(false)
  originalSecureContext = window.isSecureContext
  originalApi = (navigator as { serviceWorker?: unknown }).serviceWorker
  window.isSecureContext = true
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  window.isSecureContext = originalSecureContext
  setServiceWorkerApi(originalApi as ServiceWorkerRegistration | undefined)
})

describe("serviceWorkerEligible", () => {
  it("is eligible on a secure web runtime in production", () => {
    mockRegistration(async () => ({}))
    expect(serviceWorkerEligible()).toBe(true)
  })

  it("stays out of development builds", () => {
    vi.stubEnv("NODE_ENV", "development")
    mockRegistration(async () => ({}))
    expect(serviceWorkerEligible()).toBe(false)
  })

  it("stays out of the desktop shell", () => {
    mockIsDesktop.mockReturnValue(true)
    mockRegistration(async () => ({}))
    expect(serviceWorkerEligible()).toBe(false)
  })

  it("stays out of non-secure contexts", () => {
    window.isSecureContext = false
    mockRegistration(async () => ({}))
    expect(serviceWorkerEligible()).toBe(false)
  })

  it("reports ineligible where the API is absent", () => {
    setServiceWorkerApi(undefined)
    expect(serviceWorkerEligible()).toBe(false)
  })
})

describe("serviceWorkerUrl", () => {
  it("carries the app version so each release installs a fresh worker", () => {
    expect(serviceWorkerUrl("0.36.0")).toBe("/sw.js?v=0.36.0")
    expect(serviceWorkerUrl("1.0.0-rc.1+b2")).toBe("/sw.js?v=1.0.0-rc.1%2Bb2")
  })

  it("falls back to the bare script without a version", () => {
    expect(serviceWorkerUrl("")).toBe("/sw.js")
  })

  it("reads the version next.config.ts inlines at build", () => {
    vi.stubEnv("CODEG_APP_VERSION", "9.8.7")
    expect(serviceWorkerUrl()).toBe("/sw.js?v=9.8.7")
  })
})

describe("registerAppServiceWorker", () => {
  it("registers the versioned script at the root scope and reports success", async () => {
    vi.stubEnv("CODEG_APP_VERSION", "0.36.0")
    const register = vi.fn(async () => ({}))
    mockRegistration(register)
    await expect(registerAppServiceWorker()).resolves.toBe(true)
    // The literal on purpose: a narrower scope would leave /, /login and
    // the build assets uncontrolled.
    expect(register).toHaveBeenCalledWith("/sw.js?v=0.36.0", { scope: "/" })
    expect(SERVICE_WORKER_SCOPE).toBe("/")
  })

  it("swallows a rejected registration", async () => {
    mockRegistration(async () => {
      throw new Error("blocked")
    })
    await expect(registerAppServiceWorker()).resolves.toBe(false)
  })

  it("never touches the API when ineligible", async () => {
    window.isSecureContext = false
    const register = vi.fn(async () => ({}))
    const addEventListener = vi.fn()
    mockRegistration(register, addEventListener)
    await expect(registerAppServiceWorker()).resolves.toBe(false)
    expect(register).not.toHaveBeenCalled()
    expect(addEventListener).not.toHaveBeenCalled()
  })

  it("re-requests what the page loaded once a worker takes control", async () => {
    // Before control those loads went around the worker's cache; asking
    // again routes them through it, so an offline reload in this session
    // finds the scripts the shell boots with.
    const listeners: Array<() => void> = []
    mockRegistration(
      vi.fn(async () => ({})),
      (type, listener) => {
        if (type === "controllerchange") listeners.push(listener)
      }
    )
    const fetchMock = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", fetchMock)
    const origin = window.location.origin
    stubLoadedResources([
      `${origin}/_next/static/chunks/a.js`,
      `${origin}/api/health`,
      `${origin}/_next/static/chunks/b.css`,
      `${origin}/vs/loader.js`,
    ])

    await registerAppServiceWorker()
    expect(listeners).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
    listeners[0]()
    expect(fetchMock.mock.calls).toEqual([
      [`${origin}/_next/static/chunks/a.js`],
      [`${origin}/_next/static/chunks/b.css`],
      [`${origin}/vs/loader.js`],
    ])
  })
})

describe("loadedCacheableAssets", () => {
  it("lists same-origin files under the cached prefixes, once each", () => {
    const origin = window.location.origin
    stubLoadedResources([
      `${origin}/_next/static/chunks/a.js`,
      `${origin}/_next/static/media/inter.woff2`,
      `${origin}/_next/static/chunks/a.js`,
      `${origin}/vs/loader.js`,
      `${origin}/icon-32x32.png`,
      `${origin}/manifest.json`,
      `${origin}/api/health`,
      `${origin}/workspace.txt?_rsc=abc`,
      "https://cdn.example/_next/static/chunks/b.js",
      "data:image/png;base64,AAAA",
    ])
    expect(loadedCacheableAssets()).toEqual([
      `${origin}/_next/static/chunks/a.js`,
      `${origin}/_next/static/media/inter.woff2`,
      `${origin}/vs/loader.js`,
      `${origin}/icon-32x32.png`,
      `${origin}/manifest.json`,
    ])
  })

  it("mirrors the worker's own list of cacheable prefixes", () => {
    const worker = readFileSync(
      path.resolve(__dirname, "../../public/sw.js"),
      "utf8"
    )
    const declared = worker.match(/const CACHEABLE_PREFIXES = \[([^\]]*)\]/)
    expect(declared).not.toBeNull()
    const prefixes = [...declared![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(prefixes).toEqual(CACHEABLE_PREFIXES)
  })
})
