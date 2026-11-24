import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ImageInputAttachment } from "@/components/chat/message-input-attachments"

const mocks = vi.hoisted(() => ({
  canCopyImageToClipboard: vi.fn(() => true),
  copyImageToClipboard: vi.fn(async () => {}),
  downloadImage: vi.fn(async () => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ancestorContextMenu: vi.fn(),
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

import { ComposerImageThumbnails } from "./composer-image-thumbnails"

const ATTACHMENT: ImageInputAttachment = {
  id: "att-1",
  type: "image",
  data: "QQ==",
  uri: null,
  name: "shot.png",
  mimeType: "image/png",
}

function renderStrip() {
  return render(
    // The outer handler stands in for the composer's own text context menu,
    // which wraps the whole input area including the attachment strip.
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div onContextMenu={mocks.ancestorContextMenu}>
        <ComposerImageThumbnails
          attachments={[ATTACHMENT]}
          onRemove={vi.fn()}
        />
      </div>
    </NextIntlClientProvider>
  )
}

/** The context-menu trigger wrapped around the staged thumbnail. */
function trigger(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-image-actions]")
  if (!element) throw new Error("expected a context-menu trigger on the tile")
  return element
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canCopyImageToClipboard.mockReturnValue(true)
})

describe("ComposerImageThumbnails", () => {
  it("offers Copy image on right-click instead of the composer text menu", async () => {
    renderStrip()

    fireEvent.contextMenu(trigger())

    const copyItem = await screen.findByRole("menuitem", {
      name: "Copy image",
    })
    expect(mocks.ancestorContextMenu).not.toHaveBeenCalled()

    fireEvent.click(copyItem)
    await waitFor(() =>
      expect(mocks.copyImageToClipboard).toHaveBeenCalledWith({
        data: ATTACHMENT.data,
        mime_type: ATTACHMENT.mimeType,
      })
    )
  })

  it("offers Download image on right-click", async () => {
    renderStrip()

    fireEvent.contextMenu(trigger())

    const downloadItem = await screen.findByRole("menuitem", {
      name: "Download image",
    })
    fireEvent.click(downloadItem)
    await waitFor(() =>
      expect(mocks.downloadImage).toHaveBeenCalledWith({
        data: ATTACHMENT.data,
        mime_type: ATTACHMENT.mimeType,
        suggestedName: ATTACHMENT.name,
      })
    )
  })

  it("carries the actions into the blown-up preview", async () => {
    renderStrip()

    fireEvent.click(screen.getByAltText(ATTACHMENT.name))
    const dialog = await screen.findByRole("dialog")

    fireEvent.click(within(dialog).getByRole("button", { name: "Copy image" }))
    await waitFor(() =>
      expect(mocks.copyImageToClipboard).toHaveBeenCalledWith({
        data: ATTACHMENT.data,
        mime_type: ATTACHMENT.mimeType,
      })
    )
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Download image" })
    )
    await waitFor(() => expect(mocks.downloadImage).toHaveBeenCalled())
    // Neither action doubles as "close": the buttons stop the click from
    // reaching the backdrop that dismisses the preview.
    expect(screen.queryByRole("dialog")).not.toBeNull()
  })

  it("offers the right-click menu on the blown-up image too", async () => {
    renderStrip()

    fireEvent.click(screen.getByAltText(ATTACHMENT.name))
    const dialog = await screen.findByRole("dialog")
    const previewTrigger = dialog.querySelector<HTMLElement>(
      "[data-image-actions]"
    )
    expect(previewTrigger).not.toBeNull()

    fireEvent.contextMenu(previewTrigger as HTMLElement)
    const downloadItem = await screen.findByRole("menuitem", {
      name: "Download image",
    })

    fireEvent.click(downloadItem)
    await waitFor(() => expect(mocks.downloadImage).toHaveBeenCalled())
    // The menu is portaled out, but its click still bubbles through the React
    // tree to the dialog's dismiss-on-click backdrop — which must not fire.
    expect(screen.queryByRole("dialog")).not.toBeNull()
  })

  it("keeps the tile out of our menu when the clipboard cannot take images", () => {
    mocks.canCopyImageToClipboard.mockReturnValue(false)
    renderStrip()

    // The native-menu passthrough still blocks the composer's text menu.
    const native = document.querySelector("[data-image-actions-native]")
    expect(native).not.toBeNull()
    fireEvent.contextMenu(native as HTMLElement)
    expect(mocks.ancestorContextMenu).not.toHaveBeenCalled()
  })
})
