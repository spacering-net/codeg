import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ComponentProps } from "react"

// The composer body itself is irrelevant here — these tests are about which
// events the wrapper lets escape to the conversation panel around it, and which
// derived props the wrapper hands down.
const lastProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}))
vi.mock("@/components/chat/message-input", () => ({
  MessageInput: (props: Record<string, unknown>) => {
    lastProps.current = props
    return (
      <button type="button" data-testid="agent-icon">
        agent
      </button>
    )
  },
}))

vi.mock("@/components/chat/message-queue-display", () => ({
  MessageQueueDisplay: () => null,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ChatInput } from "./chat-input"

/**
 * jsdom's `fireEvent.pointerDown` drops `pointerType` (it builds a plain
 * MouseEvent), so the property is pinned by hand — the guard under test reads
 * exactly that field.
 */
function pointerDown(element: Element, pointerType: string) {
  const event = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  fireEvent(element, event)
}

function renderComposer(onPointerDown: () => void, onContextMenu: () => void) {
  // Stands in for the conversation panel's context-menu trigger, which wraps
  // the transcript AND the composer (conversations/conversation-detail-panel).
  return render(
    <div onPointerDown={onPointerDown} onContextMenu={onContextMenu}>
      <ChatInput
        status="connected"
        promptCapabilities={{
          image: false,
          audio: false,
          embedded_context: false,
        }}
        onSend={() => {}}
        onCancel={() => {}}
      />
    </div>
  )
}

describe("ChatInput event containment", () => {
  it("keeps a touch press from arming the conversation panel's long-press menu", () => {
    const onPointerDown = vi.fn()
    const onContextMenu = vi.fn()
    renderComposer(onPointerDown, onContextMenu)

    // A tap on a composer control (e.g. the agent icon) that lingers would
    // otherwise open the conversation context menu on touch devices.
    pointerDown(screen.getByTestId("agent-icon"), "touch")
    expect(onPointerDown).not.toHaveBeenCalled()
  })

  it("lets a mouse press through (the panel's selection bookkeeping needs it)", () => {
    const onPointerDown = vi.fn()
    const onContextMenu = vi.fn()
    renderComposer(onPointerDown, onContextMenu)

    pointerDown(screen.getByTestId("agent-icon"), "mouse")
    expect(onPointerDown).toHaveBeenCalled()
  })

  it("keeps a right-click inside the composer out of the conversation menu", () => {
    const onPointerDown = vi.fn()
    const onContextMenu = vi.fn()
    renderComposer(onPointerDown, onContextMenu)

    fireEvent.contextMenu(screen.getByTestId("agent-icon"))
    expect(onContextMenu).not.toHaveBeenCalled()
  })
})

// The `/` panel's loading state has to span the WHOLE wait for the agent's
// command list. The backend emits `connected` early — before session
// resume/load/new — and only forwards the buffered commands once
// `selectors_ready` has fired, so `connecting` alone would blank the panel again
// for the entire session-init leg.
describe("ChatInput slash-command loading window", () => {
  afterEach(() => {
    cleanup()
    lastProps.current = null
  })

  function renderStatus(props: Partial<ComponentProps<typeof ChatInput>>) {
    render(
      <ChatInput
        status="connected"
        promptCapabilities={{
          image: false,
          audio: false,
          embedded_context: false,
        }}
        onSend={() => {}}
        onCancel={() => {}}
        {...props}
      />
    )
    return lastProps.current
  }

  it("loads while the connection is being established", () => {
    expect(renderStatus({ status: "connecting" })?.commandsLoading).toBe(true)
  })

  it("keeps loading through session init (connected, selectors not ready)", () => {
    expect(
      renderStatus({ status: "connected", selectorsLoading: true })
        ?.commandsLoading
    ).toBe(true)
  })

  it("stops once the session is initialized", () => {
    expect(
      renderStatus({ status: "connected", selectorsLoading: false })
        ?.commandsLoading
    ).toBe(false)
    // Bounded even for an agent that never advertises a single command:
    // `selectors_ready` fires on every establishment path, so this can't hang.
    expect(
      renderStatus({
        status: "connected",
        selectorsLoading: false,
        availableCommands: [],
      })?.commandsLoading
    ).toBe(false)
  })

  it("does not load on a dead connection", () => {
    expect(renderStatus({ status: "disconnected" })?.commandsLoading).toBe(
      false
    )
    expect(renderStatus({ status: "error" })?.commandsLoading).toBe(false)
  })

  // The user-visible half of issue #797: a torn-down connection is what greys
  // the composer out, so a turn-scoped failure must never take the connection
  // with it. `prompting` stays enabled on purpose (the draft enqueues), and
  // `error` / `disconnected` are exactly the states the backend used to enter
  // for a rejected `session/prompt` — the user could not send again until a
  // full agent respawn had finished.
  it("greys the composer out only when the connection itself is gone", () => {
    expect(renderStatus({ status: "connected" })?.disabled).toBe(false)
    expect(renderStatus({ status: "prompting" })?.disabled).toBe(false)
    expect(renderStatus({ status: "error" })?.disabled).toBe(true)
    expect(renderStatus({ status: "disconnected" })?.disabled).toBe(true)
  })
})
