import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  remoteId: null as number | null,
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getActiveRemoteConnectionId: () => mocks.remoteId,
}))

import { useHarnessView } from "@/contexts/harness-view-context"
import { __resetHarnessStatusForTests } from "@/lib/harness/status"
import { HarnessViewHost } from "./harness-view-host"

const KEY = "workspace:harness-discover-enabled"

/** What the page would be handed: the sections on offer, and whether
 *  Discover is one of them — on every render, to catch a flash. */
const renders: string[] = []

function Probe() {
  const { discoverEnabled, sections } = useHarnessView()
  renders.push(discoverEnabled ? "on" : "off")
  return <p data-testid="sections">{sections.join(",")}</p>
}

function renderHost() {
  return render(
    <HarnessViewHost>
      <Probe />
    </HarnessViewHost>
  )
}

function answerLater() {
  let answer!: (value: unknown) => void
  let fail!: (reason: unknown) => void
  mocks.call.mockReturnValueOnce(
    new Promise((resolve, reject) => {
      answer = resolve
      fail = reject
    })
  )
  return { answer, fail }
}

const sections = () => screen.getByTestId("sections").textContent

beforeEach(() => {
  mocks.call.mockReset()
  mocks.remoteId = null
  localStorage.clear()
  renders.length = 0
  __resetHarnessStatusForTests()
})

describe("HarnessViewHost — whether Discover is offered", () => {
  it("asks the backend once the workspace is up", async () => {
    mocks.call.mockResolvedValue({
      enabled: true,
      origin: "https://spacering.net",
    })
    renderHost()

    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith("harness_status")
    )
    expect(sections()).toBe("discover,mcp,skills,packs")
  })

  it("is on by default, and stays on without a flash when the backend agrees", async () => {
    const { answer } = answerLater()
    renderHost()
    expect(sections()).toBe("discover,mcp,skills,packs")

    await act(async () => {
      answer({ enabled: true, origin: "https://spacering.net" })
    })
    expect(sections()).toBe("discover,mcp,skills,packs")
    expect(new Set(renders)).toEqual(new Set(["on"]))
  })

  it("takes Discover away when the operator switched the catalog off", async () => {
    const { answer } = answerLater()
    renderHost()

    await act(async () => {
      answer({ enabled: false, origin: "https://spacering.net" })
    })
    expect(sections()).toBe("mcp,skills,packs")
    expect(localStorage.getItem(KEY)).toBe("0")
  })

  it("starts from the last answer, so a switched-off catalog never flashes in", async () => {
    localStorage.setItem(KEY, "0")
    const { answer } = answerLater()
    renderHost()
    expect(sections()).toBe("mcp,skills,packs")

    await act(async () => {
      answer({ enabled: false, origin: "https://spacering.net" })
    })
    expect(new Set(renders)).toEqual(new Set(["off"]))
  })

  it("brings Discover back when the catalog was switched on again", async () => {
    localStorage.setItem(KEY, "0")
    const { answer } = answerLater()
    renderHost()

    await act(async () => {
      answer({ enabled: true, origin: "https://spacering.net" })
    })
    expect(sections()).toBe("discover,mcp,skills,packs")
    expect(localStorage.getItem(KEY)).toBe("1")
  })

  it.each([
    [
      "a browser's 501",
      { code: "not_implemented", message: "API endpoint is not available" },
    ],
    [
      "a remote workspace's relayed 501",
      {
        code: "network_error",
        message: "Remote returned HTTP 501 Not Implemented",
      },
    ],
    ["a desktop build without the command", "Command harness_status not found"],
  ])(
    "keeps Discover for a backend too old to answer (%s)",
    async (_how, error) => {
      const { fail } = answerLater()
      renderHost()

      await act(async () => {
        fail(error)
      })
      // Not "off": the section stays, and tells the user to update.
      expect(sections()).toBe("discover,mcp,skills,packs")
      expect(localStorage.getItem(KEY)).toBeNull()
    }
  )

  it("keeps the remembered answer when the backend cannot be reached", async () => {
    localStorage.setItem(KEY, "0")
    const { fail } = answerLater()
    renderHost()

    await act(async () => {
      fail(new Error("Request timed out"))
    })
    expect(sections()).toBe("mcp,skills,packs")
    expect(localStorage.getItem(KEY)).toBe("0")
  })

  it("remembers a remote workspace's answer apart from this computer's", async () => {
    localStorage.setItem(KEY, "0")
    mocks.remoteId = 3
    const { answer } = answerLater()
    renderHost()
    // The local window's "off" says nothing about this host.
    expect(sections()).toBe("discover,mcp,skills,packs")

    await act(async () => {
      answer({ enabled: true, origin: "https://spacering.net" })
    })
    expect(localStorage.getItem(`${KEY}:remote-3`)).toBe("1")
    expect(localStorage.getItem(KEY)).toBe("0")
  })
})
