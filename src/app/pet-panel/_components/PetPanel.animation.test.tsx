import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PetSessionEntry } from "@/lib/pet/types"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/lib/transport", () => ({ isDesktop: () => false }))
vi.mock("@/lib/pet/api", () => ({
  closePetPanel: vi.fn(),
  resizePetPanel: vi.fn(),
}))
vi.mock("../../pet/_hooks/usePetSessions", () => ({
  usePetSessions: vi.fn(),
}))
vi.mock("./SessionRow", () => ({
  SessionRow: ({ session }: { session: PetSessionEntry }) => (
    <span>{session.title}</span>
  ),
}))

import { usePetSessions } from "../../pet/_hooks/usePetSessions"
import { PetPanel } from "./PetPanel"

function session(id: string): PetSessionEntry {
  return {
    connectionId: id,
    conversationId: 1,
    folderId: 1,
    agentType: "codex",
    title: id,
    status: "prompting",
  }
}

function showSessions(...sessions: PetSessionEntry[]) {
  vi.mocked(usePetSessions).mockReturnValue({
    sessions,
    runningCount: sessions.length,
    waitingCount: 0,
    errorCount: 0,
  })
}

describe("PetPanel native exit animation", () => {
  beforeEach(() => showSessions())

  it("releases the browser's finish callback when a session row exits", async () => {
    const animations: Array<{
      target: HTMLElement
      onfinish: (() => void) | null
    }> = []
    const animate = vi.fn(function (
      this: HTMLElement,
      keyframes: PropertyIndexedKeyframes
    ) {
      const animation = {
        onfinish: null as (() => void) | null,
        oncancel: null,
        currentTime: 200,
        playbackRate: 1,
        startTime: 0,
        playState: "running",
        effect: { getComputedTiming: () => ({ duration: 200 }) },
        cancel: vi.fn(),
        pause: vi.fn(),
        play: vi.fn(),
        target: this,
      }
      if ("opacity" in keyframes) animations.push(animation)
      return animation
    })
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "animate"
    )
    Object.defineProperty(Element.prototype, "animate", {
      value: animate,
      configurable: true,
    })

    const leaving = session("leaving session")
    const staying = session("staying session")
    showSessions(leaving, staying)
    const view = render(<PetPanel />)
    try {
      const row = screen.getByText(leaving.title).closest("li")
      if (!row) throw new Error("Expected the session row to be mounted")
      // jsdom does not provide the default computed opacity of 1.
      row.style.opacity = "1"
      showSessions(staying)
      view.rerender(<PetPanel />)

      const exit = await waitFor(() => {
        const match = animations.find((animation) => animation.target === row)
        expect(match?.onfinish).toBeTypeOf("function")
        return match!
      })
      await act(async () => exit.onfinish?.())
      await waitFor(() =>
        expect(screen.queryByText(leaving.title)).not.toBeInTheDocument()
      )
      expect(screen.getByText(staying.title)).toBeVisible()
      expect(exit.onfinish).toBeNull()
    } finally {
      view.unmount()
      if (original) {
        Object.defineProperty(Element.prototype, "animate", original)
      } else {
        Reflect.deleteProperty(Element.prototype, "animate")
      }
    }
  })
})
