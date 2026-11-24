import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { ClipboardImageUnsupportedError } from "@/lib/copy-image"

const mocks = vi.hoisted(() => ({
  canCopyImageToClipboard: vi.fn(() => true),
  copyImageToClipboard: vi.fn(async () => {}),
  downloadImage: vi.fn(async () => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ancestorContextMenu: vi.fn(),
  ancestorPointerDown: vi.fn(),
}))

vi.mock("@/lib/copy-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copy-image")>()
  return {
    ...actual,
    canCopyImageToClipboard: mocks.canCopyImageToClipboard,
    copyImageToClipboard: mocks.copyImageToClipboard,
  }
})

vi.mock("@/lib/image-download", () => ({ downloadImage: mocks.downloadImage }))

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

import { ImageActions } from "./image-actions"

const IMAGE = {
  data: "QQ==",
  mime_type: "image/png",
  name: "shot.png",
  uri: null,
}

function renderActions() {
  return render(
    // The outer handlers stand in for the conversation panel's own context
    // menu, which wraps the whole transcript.
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div
        onContextMenu={mocks.ancestorContextMenu}
        onPointerDown={mocks.ancestorPointerDown}
      >
        <ImageActions image={IMAGE}>
          <button type="button" data-testid="thumb">
            thumbnail
          </button>
        </ImageActions>
      </div>
    </NextIntlClientProvider>
  )
}

/** The context-menu trigger wrapped around the image. */
function trigger(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-image-actions]")
  if (!element) throw new Error("expected a context-menu trigger on the image")
  return element
}

function item(name: string): HTMLElement {
  return screen.getByRole("menuitem", { name })
}

describe("ImageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canCopyImageToClipboard.mockReturnValue(true)
    mocks.copyImageToClipboard.mockResolvedValue(undefined)
    mocks.downloadImage.mockResolvedValue(true)
  })

  it("opens on right-click, and only on right-click", () => {
    renderActions()
    // A left click belongs to the thumbnail (it opens the preview).
    fireEvent.click(trigger())
    expect(screen.queryByRole("menu")).toBeNull()

    // Radix suppresses the native menu to put its own in that place — the
    // contrast with the no-clipboard case below, which leaves it alone.
    expect(fireEvent.contextMenu(trigger())).toBe(false)
    expect(screen.getByRole("menu")).toBeInTheDocument()
  })

  it("keeps the right-click from also opening the conversation menu", () => {
    renderActions()
    fireEvent.contextMenu(trigger())

    expect(screen.getByRole("menu")).toBeInTheDocument()
    // The transcript is wrapped in the conversation panel's own context menu;
    // both opening at once is what this stopPropagation prevents.
    expect(mocks.ancestorContextMenu).not.toHaveBeenCalled()
  })

  it("keeps a touch long-press from arming the conversation menu too", () => {
    renderActions()
    // jsdom's fireEvent.pointerDown drops `pointerType`, so pin it by hand.
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, "pointerType", { value: "touch" })
    fireEvent(trigger(), event)

    expect(mocks.ancestorPointerDown).not.toHaveBeenCalled()
  })

  it("copies the image and reports success", async () => {
    renderActions()
    fireEvent.contextMenu(trigger())
    fireEvent.click(item("Copy image"))

    await waitFor(() => {
      expect(mocks.copyImageToClipboard).toHaveBeenCalledWith({
        data: IMAGE.data,
        mime_type: IMAGE.mime_type,
      })
    })
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Image copied")
    })
  })

  it("reports an unsupported clipboard in the user's language, not ours", async () => {
    mocks.copyImageToClipboard.mockRejectedValue(
      new ClipboardImageUnsupportedError()
    )
    renderActions()
    fireEvent.contextMenu(trigger())
    fireEvent.click(item("Copy image"))

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        enMessages.Folder.chat.messageList.copyImageUnsupported
      )
    })
    // The typed error's own English text must not reach the toast.
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      expect.stringContaining("This environment cannot")
    )
  })

  it("passes any other failure through with the browser's message", async () => {
    mocks.copyImageToClipboard.mockRejectedValue(new Error("Denied"))
    renderActions()
    fireEvent.contextMenu(trigger())
    fireEvent.click(item("Copy image"))

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not copy image: Denied"
      )
    })
  })

  it("downloads from the menu", async () => {
    renderActions()
    fireEvent.contextMenu(trigger())
    fireEvent.click(item("Download image"))

    await waitFor(() => {
      expect(mocks.downloadImage).toHaveBeenCalledWith({
        data: IMAGE.data,
        mime_type: IMAGE.mime_type,
        suggestedName: IMAGE.name,
      })
    })
  })

  describe("without a usable clipboard (non-secure web context)", () => {
    beforeEach(() => {
      mocks.canCopyImageToClipboard.mockReturnValue(false)
    })

    it("offers no menu of its own, so the native image menu can appear", () => {
      renderActions()
      const event = fireEvent.contextMenu(trigger())

      expect(screen.queryByRole("menu")).toBeNull()
      // Not preventing the default is what lets the browser's own menu — which
      // copies images with no secure-context requirement — take over.
      expect(event).toBe(true)
      expect(mocks.ancestorContextMenu).not.toHaveBeenCalled()
    })

    it("still shields the ancestor from a touch long-press", () => {
      renderActions()
      const event = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
      })
      Object.defineProperty(event, "pointerType", { value: "touch" })
      fireEvent(trigger(), event)

      expect(mocks.ancestorPointerDown).not.toHaveBeenCalled()
    })
  })
})
