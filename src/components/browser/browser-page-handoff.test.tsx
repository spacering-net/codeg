import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import type { BrowserTabState, PageHandoff } from "@/lib/browser/types"
import {
  ATTACH_PAGE_TO_SESSION_EVENT,
  type AttachPageToSessionDetail,
} from "@/lib/session-attachment-events"

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  pickCancel: vi.fn(() => Promise.resolve()),
  capture: vi.fn(),
  console: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  activeTabId: "conv-1" as string | null,
}))
vi.mock("@/lib/browser/browser-api", () => ({
  browserPickElement: mocks.pick,
  browserPickCancel: mocks.pickCancel,
  browserPageCapture: mocks.capture,
  browserPageConsole: mocks.console,
}))
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error, info: mocks.info },
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (
    selector: (s: {
      tabs: Array<{ id: string; kind: string }>
      activeTabId: string | null
    }) => unknown
  ) =>
    selector({
      tabs: [
        { id: "conv-1", kind: "conversation" },
        { id: "file-1", kind: "file" },
      ],
      activeTabId: mocks.activeTabId,
    }),
}))

import {
  setBrowserConsoleErrors,
  resetBrowserTabStoreForTests,
} from "@/lib/browser/browser-tab-store"

import { BrowserSendToChatControl } from "./browser-page-handoff"
import {
  BrowserScreenshotMarkupHost,
  resetScreenshotMarkupForTests,
} from "./browser-screenshot-markup"

const tab = {
  id: "browser:abc",
  kind: "browser",
  folderId: 1,
  title: "example.com",
  browser: {
    initialUrl: "https://example.com/",
    openerTabId: null,
    profile: "default",
  },
} as BrowserWorkspaceTab

function state(over: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId: "abc",
    ownerWindow: "main",
    kind: "page",
    surface: "child",
    channel: "native",
    channelError: null,
    url: "https://example.com/orders",
    requestedUrl: "https://example.com/orders",
    title: "Orders",
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    origin: "https://example.com",
    zoom: 1,
    error: null,
    remoteHost: null,
    openerTabId: null,
    profile: "default",
    agentGrant: null,
    ...over,
  }
}

function handoff(over: Partial<PageHandoff> = {}): PageHandoff {
  return {
    cancelled: false,
    label: "",
    text: "Captured from a web page…",
    url: "https://example.com/orders",
    count: 0,
    ...over,
  }
}

function wrap() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserSendToChatControl tab={tab} state={state()} />
    </NextIntlClientProvider>
  )
}

// jsdom has no `PointerEvent`; Radix reads `button` off the event.
function fireMouse(target: Element, type: string) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  )
}

async function openMenu() {
  const trigger = screen.getByRole("button", { name: "Send to chat" })
  await act(async () => {
    fireMouse(trigger, "pointerdown")
    fireMouse(trigger, "pointerup")
    fireMouse(trigger, "click")
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return trigger
}

async function closeMenu() {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function choose(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Stand in for a mounted composer: record what arrives and, unless
 *  `accept` is false, acknowledge it the way `MessageInput` does. */
function captureAttachEvents(accept = true): AttachPageToSessionDetail[] {
  const seen: AttachPageToSessionDetail[] = []
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<AttachPageToSessionDetail>).detail
    seen.push(detail)
    if (accept) detail.accepted = true
  }
  window.addEventListener(ATTACH_PAGE_TO_SESSION_EVENT, listener)
  listeners.push(listener)
  return seen
}

const listeners: Array<(event: Event) => void> = []

describe("sending a page to the chat", () => {
  beforeEach(() => {
    resetBrowserTabStoreForTests()
    mocks.activeTabId = "conv-1"
    for (const fn of [
      mocks.pick,
      mocks.pickCancel,
      mocks.capture,
      mocks.console,
      mocks.success,
      mocks.error,
      mocks.info,
    ]) {
      fn.mockClear()
    }
    mocks.pickCancel.mockResolvedValue(undefined)
    // The menu asks the tab how many errors it holds as it opens.
    mocks.console.mockResolvedValue(handoff({ count: 0 }))
  })
  afterEach(() => {
    resetBrowserTabStoreForTests()
    for (const listener of listeners.splice(0)) {
      window.removeEventListener(ATTACH_PAGE_TO_SESSION_EVENT, listener)
    }
  })

  it("hands a picked element to the active conversation, picture and all", async () => {
    const seen = captureAttachEvents()
    mocks.pick.mockResolvedValue(
      handoff({
        label: "button#export",
        image: {
          mime: "image/png",
          data: "AAAA",
          width: 10,
          height: 10,
          url: "https://example.com/orders",
          region: { x: 0, y: 0, width: 10, height: 10 },
          clipped: true,
        },
      })
    )
    wrap()
    await openMenu()
    await choose("Pick an element…")
    expect(mocks.pick).toHaveBeenCalledWith("abc")
    expect(seen).toHaveLength(1)
    expect(seen[0].tabId).toBe("conv-1")
    // The page's own name for the element, not one of ours.
    expect(seen[0].label).toBe("button#export")
    expect(seen[0].uri).toBe("https://example.com/orders")
    expect(seen[0].image?.type).toBe("image/png")
    expect(seen[0].image?.name).toBe("button-export.png")
    expect(mocks.success).toHaveBeenCalledWith("Added to the chat")
  })

  it("says nothing to the composer when the person calls the pick off", async () => {
    const seen = captureAttachEvents()
    mocks.pick.mockResolvedValue(handoff({ cancelled: true, text: "" }))
    wrap()
    await openMenu()
    await choose("Pick an element…")
    expect(seen).toHaveLength(0)
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it("becomes the way out while a pick is armed", async () => {
    let finish: (value: PageHandoff) => void = () => {}
    mocks.pick.mockReturnValue(
      new Promise<PageHandoff>((resolve) => {
        finish = resolve
      })
    )
    wrap()
    await openMenu()
    await choose("Pick an element…")
    const cancel = screen.getByRole("button", { name: "Stop picking" })
    await act(async () => {
      fireEvent.click(cancel)
      await Promise.resolve()
    })
    expect(mocks.pickCancel).toHaveBeenCalledWith("abc")
    // The backend answers the pick itself; the control goes back when it does.
    await act(async () => {
      finish(handoff({ cancelled: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByRole("button", { name: "Send to chat" })).toBeTruthy()
  })

  it("ends an armed pick when the control goes away with the tab", async () => {
    mocks.pick.mockReturnValue(new Promise<PageHandoff>(() => {}))
    const view = wrap()
    await openMenu()
    await choose("Pick an element…")
    expect(mocks.pickCancel).not.toHaveBeenCalled()
    view.unmount()
    expect(mocks.pickCancel).toHaveBeenCalledWith("abc")
  })

  // The menu asks the tab as it opens rather than trusting the live mark, so
  // an error the mark missed cannot leave the entry dead — and the count it
  // gets is what the entry says.
  it("offers the console by what the tab holds, not by the mark alone", async () => {
    const seen = captureAttachEvents()
    wrap()
    await openMenu()
    expect(
      screen.getByRole("menuitem", {
        name: "Nothing has gone wrong on this page",
      })
    ).toHaveAttribute("aria-disabled", "true")
    await closeMenu()

    // The mark never arrived, and the entry is live all the same.
    mocks.console.mockResolvedValue(handoff({ count: 3 }))
    await openMenu()
    await choose("Send the 3 console errors")
    expect(mocks.console).toHaveBeenCalledWith("abc", true)
    expect(seen).toHaveLength(1)
    // Named here rather than by the backend, because this one is read by a
    // person and has to be in their language.
    expect(seen[0].label).toBe("3 console errors")
  })

  it("marks the control as soon as the page fails", async () => {
    wrap()
    expect(
      screen.getByRole("button", { name: "Send to chat" }).querySelector("span")
    ).toBeNull()
    act(() => setBrowserConsoleErrors("browser:abc", true))
    expect(
      screen.getByRole("button", { name: "Send to chat" }).querySelector("span")
    ).not.toBeNull()
  })

  it("does not claim to have sent an empty console", async () => {
    const seen = captureAttachEvents()
    act(() => setBrowserConsoleErrors("browser:abc", true))
    wrap()
    // Marked, but the tab says there is nothing there by the time it is asked.
    await openMenu()
    await choose("Nothing has gone wrong on this page")
    expect(seen).toHaveLength(0)
    expect(mocks.success).not.toHaveBeenCalled()
  })

  // A person can close the conversation while they are choosing an element.
  // Nothing hears the handoff then, and saying "added to the chat" would be a
  // plain lie about where their page went.
  it("says so when the conversation it was going to is gone", async () => {
    const seen = captureAttachEvents(false)
    mocks.capture.mockResolvedValue(handoff())
    wrap()
    await openMenu()
    await choose("Send a screenshot")
    expect(seen).toHaveLength(1)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith(
      "That conversation is no longer open"
    )
  })

  it("is disabled with nowhere to send to", async () => {
    mocks.activeTabId = "file-1"
    wrap()
    const trigger = screen.getByRole("button", { name: "Send to chat" })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute(
      "title",
      "Open a conversation to send this page to"
    )
  })

  it("reports a failure instead of quietly dropping the page", async () => {
    const seen = captureAttachEvents()
    mocks.capture.mockRejectedValue(new Error("no pixels"))
    wrap()
    await openMenu()
    await choose("Send a screenshot")
    expect(seen).toHaveLength(0)
    expect(mocks.error).toHaveBeenCalledWith(
      "This page could not be sent to the chat",
      { description: "Error: no pixels" }
    )
  })
})

describe("marking up a screenshot", () => {
  /** jsdom decodes no pictures and has no 2D canvas: a picture that loads on
   *  the next tick, a context that draws nothing, an encoder that answers. */
  class LoadingImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      setTimeout(() => this.onload?.(), 0)
    }
  }

  const screenshot = () =>
    handoff({
      text: "Captured from a web page…\n\n- screenshot: the visible 800×500 CSS px\n",
      image: {
        mime: "image/png",
        data: "AAAA",
        width: 800,
        height: 500,
        url: "https://example.com/orders",
        region: { x: 0, y: 0, width: 800, height: 500 },
        clipped: false,
      },
    })

  beforeEach(() => {
    resetBrowserTabStoreForTests()
    resetScreenshotMarkupForTests()
    mocks.activeTabId = "conv-1"
    for (const fn of [
      mocks.capture,
      mocks.console,
      mocks.success,
      mocks.error,
    ]) {
      fn.mockClear()
    }
    mocks.console.mockResolvedValue(handoff({ count: 0 }))
    vi.stubGlobal("Image", LoadingImage)
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        new Proxy(
          {},
          { get: () => () => {}, set: () => true }
        ) as unknown as CanvasRenderingContext2D
    )
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      function (callback, type = "image/png") {
        callback(new Blob([new Uint8Array(16)], { type }))
      }
    )
    // Shown at its own size, so a screen pixel is a picture pixel.
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "getBoundingClientRect"
    ).mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 500,
      width: 800,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    act(() => resetScreenshotMarkupForTests())
    for (const listener of listeners.splice(0)) {
      window.removeEventListener(ATTACH_PAGE_TO_SESSION_EVENT, listener)
    }
  })

  /** The toolbar control and the workspace's host, mounted apart as they are
   *  in the app — the host outlives any one browser tab. */
  function mountBoth() {
    const control = wrap()
    const host = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BrowserScreenshotMarkupHost />
      </NextIntlClientProvider>
    )
    return { control, host }
  }

  async function openMarkup() {
    await openMenu()
    await choose("Mark up a screenshot…")
    // The picture loads on the next tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  function drawBox() {
    const canvas = screen.getByRole("img", { name: "Mark up the screenshot" })
    for (const [type, x, y] of [
      ["pointerdown", 100, 100],
      ["pointermove", 200, 150],
      ["pointerup", 300, 200],
    ] as const) {
      fireEvent(
        canvas,
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: x,
          clientY: y,
        })
      )
    }
  }

  async function addToChat() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to chat" }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it("takes the picture first and sends nothing until it is added", async () => {
    const seen = captureAttachEvents()
    mocks.capture.mockResolvedValue(screenshot())
    mountBoth()
    await openMarkup()
    expect(mocks.capture).toHaveBeenCalledWith("abc")
    expect(
      screen.getByRole("dialog", { name: "Mark up the screenshot" })
    ).toBeVisible()
    expect(seen).toHaveLength(0)

    drawBox()
    await addToChat()
    expect(seen).toHaveLength(1)
    expect(seen[0].tabId).toBe("conv-1")
    expect(seen[0].label).toBe("Marked-up screenshot")
    expect(seen[0].uri).toBe("https://example.com/orders")
    expect(seen[0].text).toBe(
      `${screenshot().text}- markup: the person drew 1 numbered mark on this screenshot, in red; the marks are not part of the page\n` +
        "  1. box: 200×100 CSS px at (100, 100)\n"
    )
    expect(seen[0].image?.name).toBe("marked-screenshot.png")
    expect(mocks.success).toHaveBeenCalledWith("Added to the chat")
  })

  // Only the browser tab on screen is mounted, and another can come on screen
  // by itself — a local server opening a tab, an agent opening one. The marks
  // do not go with the tab they were started from.
  it("outlives the browser tab it was opened from", async () => {
    const seen = captureAttachEvents()
    mocks.capture.mockResolvedValue(screenshot())
    const { control } = mountBoth()
    await openMarkup()
    drawBox()
    control.unmount()
    expect(screen.getByText("1 mark")).toBeVisible()
    await addToChat()
    expect(seen).toHaveLength(1)
    expect(seen[0].tabId).toBe("conv-1")
    expect(seen[0].label).toBe("Marked-up screenshot")
  })

  // The active tab can change while the person draws; the picture goes where
  // it was taken for.
  it("goes to the conversation it was taken for", async () => {
    const seen = captureAttachEvents()
    mocks.capture.mockResolvedValue(screenshot())
    const { control } = mountBoth()
    await openMarkup()
    mocks.activeTabId = "file-1"
    control.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BrowserSendToChatControl tab={tab} state={state()} />
      </NextIntlClientProvider>
    )
    drawBox()
    await addToChat()
    expect(seen[0].tabId).toBe("conv-1")
  })

  it("sends a capture that came back without a picture as it is", async () => {
    const seen = captureAttachEvents()
    mocks.capture.mockResolvedValue(handoff())
    mountBoth()
    await openMarkup()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0].label).toBe("Page screenshot")
  })

  it("does not open over a screenshot that could not be taken", async () => {
    const seen = captureAttachEvents()
    mocks.capture.mockRejectedValue(new Error("no pixels"))
    mountBoth()
    await openMarkup()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(seen).toHaveLength(0)
    expect(mocks.error).toHaveBeenCalledWith(
      "This page could not be sent to the chat",
      { description: "Error: no pixels" }
    )
  })
})
