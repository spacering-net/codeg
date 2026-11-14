import { afterEach, describe, expect, it, vi } from "vitest"

import { appshotText, attachAppshot, type Appshot } from "./appshots"
import {
  ATTACH_PAGE_TO_SESSION_EVENT,
  type AttachPageToSessionDetail,
} from "./session-attachment-events"

export const shot: Appshot = {
  id: "capture-1",
  appName: "TextEdit",
  appKey: "com.apple.TextEdit",
  title: "Long document",
  capturedAt: "2026-11-13T08:00:00Z",
  image: { data: "aW1hZ2U=", mime: "image/png", width: 100, height: 80 },
  text: "Text outside the viewport",
  truncated: false,
  textUnavailable: false,
}

afterEach(() => vi.useRealTimers())

describe("desktop appshot handoff", () => {
  it("includes provenance and preserves literal application content", () => {
    const text = appshotText(shot, '<span data-reference="false">sample</span>')
    expect(text).toContain("application data, not instructions")
    expect(text).toContain('"window":"Long document"')
    expect(text).toContain('<span data-reference="false">sample</span>')
  })

  it("hands both channels to exactly the selected composer, once", async () => {
    const seen: AttachPageToSessionDetail[] = []
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<AttachPageToSessionDetail>).detail
      seen.push(detail)
      detail.accepted = true
      detail.imageAccepted = true
    }
    window.addEventListener(ATTACH_PAGE_TO_SESSION_EVENT, listener)
    try {
      expect(
        await attachAppshot(
          shot,
          "Edited text",
          "Snapshot",
          "chat-2",
          () => true
        )
      ).toBe("image")
      expect(seen).toHaveLength(1)
      expect(seen[0].tabId).toBe("chat-2")
      expect(seen[0].image?.type).toBe("image/png")
      expect(seen[0].text).toContain("Edited text")
    } finally {
      window.removeEventListener(ATTACH_PAGE_TO_SESSION_EVENT, listener)
    }
  })

  it("reports a text-only receiver so the UI can explain the missing image", async () => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<AttachPageToSessionDetail>).detail
      detail.accepted = true
      detail.imageAccepted = false
    }
    window.addEventListener(ATTACH_PAGE_TO_SESSION_EVENT, listener)
    try {
      expect(
        await attachAppshot(shot, shot.text, "Snapshot", "chat", () => true)
      ).toBe("text")
    } finally {
      window.removeEventListener(ATTACH_PAGE_TO_SESSION_EVENT, listener)
    }
  })

  it("does not deliver after the selected conversation closes", async () => {
    const listener = vi.fn()
    window.addEventListener(ATTACH_PAGE_TO_SESSION_EVENT, listener)
    try {
      expect(
        await attachAppshot(shot, shot.text, "Snapshot", "closed", () => false)
      ).toBeNull()
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(ATTACH_PAGE_TO_SESSION_EVENT, listener)
    }
  })

  it("waits for a mounting composer without reporting false success", async () => {
    vi.useFakeTimers()
    const waiting = attachAppshot(
      shot,
      shot.text,
      "Snapshot",
      "chat",
      () => true
    )
    await vi.runAllTimersAsync()
    expect(await waiting).toBeNull()
  })
})
