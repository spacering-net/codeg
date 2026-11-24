import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The two things the host goes by: the runtime (a Tauri window or a
// browser), and — in a Tauri window — whether it is bound to a remote server.
const runtime = vi.hoisted(() => ({
  desktop: true,
  /** What `RemoteConnectionGate` puts in context. `undefined` = no gate at all. */
  gate: undefined as
    | { connection: { name: string; base_url: string } | null }
    | undefined,
}))

vi.mock("@/lib/platform", () => ({ isDesktop: () => runtime.desktop }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => runtime.gate ?? null,
}))

import { useHarnessHost } from "./harness-host-label"

const host = () => renderHook(() => useHarnessHost()).result.current

beforeEach(() => {
  runtime.desktop = true
  runtime.gate = undefined
})

describe("useHarnessHost", () => {
  it("is this computer in the local desktop window", () => {
    runtime.gate = { connection: null }
    expect(host()).toEqual({ kind: "local" })
  })

  it("is the connection in a remote workspace window", () => {
    runtime.gate = {
      connection: { name: "prod-box", base_url: "https://prod.example:3080" },
    }
    expect(host()).toEqual({
      kind: "remote",
      name: "prod-box",
      address: "https://prod.example:3080",
    })
  })

  it("falls back to the address for a connection with no name", () => {
    runtime.gate = {
      connection: { name: "  ", base_url: "https://prod.example:3080" },
    }
    expect(host()).toMatchObject({
      kind: "remote",
      name: "https://prod.example:3080",
    })
  })

  it("is the server the page came from in a browser", () => {
    runtime.desktop = false
    expect(host()).toEqual({
      kind: "web",
      name: window.location.host,
      address: window.location.origin,
    })
  })
})
