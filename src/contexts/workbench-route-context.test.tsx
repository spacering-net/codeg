import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({ remoteId: null as number | null }))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => transport.remoteId,
}))

import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "./workbench-route-context"

function Probe() {
  const { routeId, isConversations, setRoute, openConversations } =
    useWorkbenchRoute()
  return (
    <div>
      <span data-testid="route">{routeId}</span>
      <span data-testid="isConv">{String(isConversations)}</span>
      <button onClick={() => setRoute("automations")}>go</button>
      <button onClick={() => setRoute("personalAgent")}>assistants</button>
      <button onClick={openConversations}>back</button>
    </div>
  )
}

function draw() {
  return render(
    <WorkbenchRouteProvider>
      <Probe />
    </WorkbenchRouteProvider>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  transport.remoteId = null
})
afterEach(cleanup)

describe("WorkbenchRouteProvider", () => {
  it("defaults to the conversation workspace and switches routes", () => {
    const { getByTestId, getByText } = draw()
    expect(getByTestId("route").textContent).toBe("conversations")
    expect(getByTestId("isConv").textContent).toBe("true")

    fireEvent.click(getByText("go"))
    expect(getByTestId("route").textContent).toBe("automations")
    expect(getByTestId("isConv").textContent).toBe("false")

    fireEvent.click(getByText("back"))
    expect(getByTestId("route").textContent).toBe("conversations")
    expect(getByTestId("isConv").textContent).toBe("true")
  })

  it("opens on the home view shown last: the assistants page or the conversations", () => {
    let view = draw()
    fireEvent.click(view.getByText("assistants"))
    expect(window.localStorage.getItem("workspace:last-view:local")).toBe(
      "personalAgent"
    )
    // A place visited from it is not kept.
    fireEvent.click(view.getByText("go"))
    expect(window.localStorage.getItem("workspace:last-view:local")).toBe(
      "personalAgent"
    )
    cleanup()
    view = draw()
    expect(view.getByTestId("route").textContent).toBe("personalAgent")
    fireEvent.click(view.getByText("back"))
    cleanup()
    view = draw()
    expect(view.getByTestId("route").textContent).toBe("conversations")
  })

  it("keeps a remote workspace's apart, and reads nothing it does not know", () => {
    transport.remoteId = 7
    const view = draw()
    fireEvent.click(view.getByText("assistants"))
    expect(window.localStorage.getItem("workspace:last-view:remote-7")).toBe(
      "personalAgent"
    )
    expect(window.localStorage.getItem("workspace:last-view:local")).toBeNull()
    cleanup()
    transport.remoteId = null
    window.localStorage.setItem("workspace:last-view:local", "tasks")
    expect(draw().getByTestId("route").textContent).toBe("conversations")
  })

  it("opens on the conversations when the storage cannot be read", () => {
    window.localStorage.setItem("workspace:last-view:local", "personalAgent")
    const read = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("denied", "SecurityError")
      })
    try {
      act(() => {
        draw()
      })
    } finally {
      read.mockRestore()
    }
    expect(document.querySelector("[data-testid='route']")?.textContent).toBe(
      "conversations"
    )
  })

  it("throws when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/WorkbenchRouteProvider/)
    spy.mockRestore()
  })
})
