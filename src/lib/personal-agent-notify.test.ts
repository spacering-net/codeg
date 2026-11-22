import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  desktop: false,
  permission: "granted" as string,
  prefs: { enabled: true, hideBody: false },
  toast: vi.fn(),
  deliver: vi.fn(async () => {}),
  attention: vi.fn(async () => true),
  shown: [] as { title: string; opts: NotificationOptions; n: unknown }[],
  subscribed: new Map<string, (payload: unknown) => void>(),
}))

vi.mock("sonner", () => ({ toast: h.toast }))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => h.desktop,
  getShellTransport: () => ({
    subscribe: async (event: string, cb: (payload: unknown) => void) => {
      h.subscribed.set(event, cb)
      return () => h.subscribed.delete(event)
    },
  }),
}))
vi.mock("@/lib/notification", () => ({
  deliverSystemNotification: h.deliver,
  getNotificationPermission: () => h.permission,
}))
vi.mock("@/lib/window-attention", () => ({
  requestWindowAttention: h.attention,
}))
vi.mock("@/lib/desktop-notification-prefs", () => ({
  getDesktopNotificationPrefs: () => h.prefs,
}))
vi.mock("@/lib/personal-agent-avatar-png", () => ({
  avatarPngDataUrl: async () => "data:image/png;base64,AAAA",
}))

import {
  __resetPersonalAgentNotifyForTests,
  claimNotification,
  handlePersonalAgentNotify,
  listenPersonalAgentFollow,
} from "./personal-agent-notify"
import type { PersonalAgentNotify, PersonalAgentNotifyLink } from "./types"

let focused = false
let seq = 0

function note(over: Partial<PersonalAgentNotify> = {}): PersonalAgentNotify {
  seq += 1
  return {
    id: `n-${seq}`,
    mode: "system",
    level: "normal",
    bot_id: 3,
    title: "Nova",
    body: "Done: #12 Fix the login\nIt is work it handed out for you.",
    hidden_body: "Open codeg to see it",
    attention: false,
    in_page: false,
    link: { kind: "bot", bot_id: 3, row_id: 40 },
    avatar: { kind: "face", shape: "ring", color: "blue" },
    ...over,
  }
}

class FakeNotification {
  static permission = "granted"
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(title: string, opts: NotificationOptions) {
    h.shown.push({ title, opts, n: this })
  }
}

const words = { open: "Open" }

beforeEach(() => {
  focused = false
  h.desktop = false
  h.permission = "granted"
  h.prefs = { enabled: true, hideBody: false }
  h.shown = []
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused)
  ;(window as unknown as { Notification: unknown }).Notification =
    FakeNotification
  window.history.replaceState(null, "", "/workspace")
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  h.toast.mockClear()
  h.deliver.mockClear()
  h.attention.mockClear()
  __resetPersonalAgentNotifyForTests()
})

describe("the assistants' notifications in a window", () => {
  it("leaves one the desktop backend posted alone", async () => {
    focused = true
    expect(
      await handlePersonalAgentNotify(note({ mode: "posted" }), words)
    ).toBe("ignored")
    expect(h.toast).not.toHaveBeenCalled()
    expect(h.shown).toHaveLength(0)
  })

  it("shows it in page only in the window with the focus", async () => {
    const link: PersonalAgentNotifyLink = { kind: "bot", bot_id: 3, row_id: 40 }
    expect(
      await handlePersonalAgentNotify(note({ mode: "toast", link }), words)
    ).toBe("ignored")
    expect(h.toast).not.toHaveBeenCalled()
    focused = true
    expect(
      await handlePersonalAgentNotify(note({ mode: "toast", link }), words)
    ).toBe("toast")
    expect(h.toast).toHaveBeenCalledWith(
      "Nova",
      expect.objectContaining({
        description: expect.stringContaining("Done: #12"),
        action: expect.objectContaining({ label: "Open" }),
      })
    )
    // Its [Open] follows the link.
    const followed: PersonalAgentNotifyLink[] = []
    const off = listenPersonalAgentFollow((l) => followed.push(l))
    const opts = h.toast.mock.calls[0][1] as {
      action: { onClick: () => void }
    }
    opts.action.onClick()
    off()
    expect(followed).toEqual([link])
    // A system one lands in page too when this window has the focus.
    expect(await handlePersonalAgentNotify(note(), words)).toBe("toast")
    expect(h.shown).toHaveLength(0)
  })

  it("posts it from one tab, as this device's settings say", async () => {
    const first = note()
    expect(await handlePersonalAgentNotify(first, words)).toBe("posted")
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0].title).toBe("Nova")
    expect(h.shown[0].opts).toEqual(
      expect.objectContaining({
        body: first.body,
        tag: first.id,
        icon: "data:image/png;base64,AAAA",
      })
    )
    // The same news again in this window: once.
    expect(await handlePersonalAgentNotify(first, words)).toBe("ignored")
    // Another tab took it already.
    const taken = note()
    localStorage.setItem(`codeg:pa-notify:${taken.id}`, `other@${Date.now()}`)
    expect(await handlePersonalAgentNotify(taken, words)).toBe("dropped")
    expect(h.shown).toHaveLength(1)
    // "Hide contents": the generic body.
    h.prefs = { enabled: true, hideBody: true }
    await handlePersonalAgentNotify(note(), words)
    expect(h.shown[1].opts.body).toBe("Open codeg to see it")
    // The master switch off: nothing.
    h.prefs = { enabled: false, hideBody: false }
    expect(await handlePersonalAgentNotify(note(), words)).toBe("dropped")
    expect(h.shown).toHaveLength(2)
    // A browser not granted: nothing.
    h.prefs = { enabled: true, hideBody: false }
    h.permission = "default"
    expect(await handlePersonalAgentNotify(note(), words)).toBe("dropped")
  })

  it("keeps news the owner wants on the page only on the page", async () => {
    h.desktop = true
    focused = true
    window.history.replaceState(null, "", "/settings")
    expect(
      await handlePersonalAgentNotify(
        note({ mode: "toast", in_page: true }),
        words
      )
    ).toBe("ignored")
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.shown).toHaveLength(0)
    window.history.replaceState(null, "", "/workspace")
    expect(
      await handlePersonalAgentNotify(
        note({ mode: "toast", in_page: true }),
        words
      )
    ).toBe("toast")
    focused = false
    expect(
      await handlePersonalAgentNotify(
        note({ mode: "toast", in_page: true }),
        words
      )
    ).toBe("ignored")
    expect(h.deliver).not.toHaveBeenCalled()
  })

  it("a click on it brings the tab up and follows its link", async () => {
    const link: PersonalAgentNotifyLink = {
      kind: "conversation",
      conversation_id: 8,
      folder_id: 2,
    }
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {})
    await handlePersonalAgentNotify(note({ link }), words)
    const followed: PersonalAgentNotifyLink[] = []
    const off = listenPersonalAgentFollow((l) => followed.push(l))
    const shown = h.shown[0].n as FakeNotification
    shown.onclick?.()
    off()
    expect(focus).toHaveBeenCalled()
    expect(shown.close).toHaveBeenCalled()
    expect(followed).toEqual([link])
  })

  it("posts it through the desktop shell when it must, drawing the owner back when urgent", async () => {
    h.desktop = true
    expect(
      await handlePersonalAgentNotify(
        note({ level: "urgent", attention: true }),
        words
      )
    ).toBe("posted")
    expect(h.deliver).toHaveBeenCalledWith(
      "Nova",
      expect.stringContaining("Done")
    )
    expect(h.attention).toHaveBeenCalledWith("permission_request")
    // A focused window that shows no toasts posts a toast-mode one itself.
    focused = true
    window.history.replaceState(null, "", "/settings")
    expect(
      await handlePersonalAgentNotify(note({ mode: "toast" }), words)
    ).toBe("posted")
    expect(h.toast).not.toHaveBeenCalled()
    expect(h.deliver).toHaveBeenCalledTimes(2)
  })

  it("of two windows that claim at once, one keeps it", async () => {
    const id = "race"
    const a = claimNotification(id)
    // The other window writes after this one.
    localStorage.setItem(`codeg:pa-notify:${id}`, `other@${Date.now()}`)
    expect(await a).toBe(false)
    expect(await claimNotification("alone")).toBe(true)
    expect(await claimNotification("alone")).toBe(false)
  })
})

describe("an assistant picked in the desktop's menu bar", () => {
  it("is opened as a followed notification's assistant", async () => {
    h.desktop = true
    const followed: PersonalAgentNotifyLink[] = []
    const off = listenPersonalAgentFollow((l) => followed.push(l))
    await Promise.resolve()
    await Promise.resolve()
    const tray = h.subscribed.get("workspace://follow-personal-agent")
    expect(tray).toBeTruthy()
    tray?.({ kind: "bot", bot_id: 4, row_id: null })
    tray?.({ kind: "conversation", conversation_id: 1, folder_id: null })
    expect(followed).toEqual([{ kind: "bot", bot_id: 4, row_id: null }])
    off()
    expect(h.subscribed.size).toBe(0)
    h.desktop = false
  })
})
