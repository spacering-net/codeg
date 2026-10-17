import { type ReactNode } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A Read of an image shows the picture once its card is expanded (#977).
 * codex-acp streams `view_image` as a `read` whose only result is a link to the
 * path, so the expanded card used to show that path and nothing else.
 */

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  home: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFileBase64: mocks.read,
  getHomeDirectory: mocks.home,
}))

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { ContentPartsRenderer } from "./content-parts-renderer"
import { MarkdownImageProvider } from "@/components/ai-elements/markdown-local-image"
import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { resetHomeDirCacheForTests } from "@/lib/file-open-target"

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6TAAAAABJRU5ErkJggg=="
const QR = "/tmp/nanguang-login/login-qr-new.png"
const QR_TITLE = /Read nanguang-login\/login-qr-new\.png/

function toolCall(
  toolName: string,
  input: Record<string, unknown>,
  output?: string
): AdaptedContentPart {
  return {
    type: "tool-call",
    toolCallId: `call_${toolName}`,
    toolName,
    input: JSON.stringify(input),
    state: "output-available",
    output,
  }
}

function renderCard(part: AdaptedContentPart, root: string | null = "/w") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MarkdownImageProvider rootPath={root}>
        <ContentPartsRenderer parts={[part]} role="assistant" />
      </MarkdownImageProvider>
    </NextIntlClientProvider>
  )
}

function expand(title: RegExp) {
  fireEvent.click(screen.getAllByText(title)[0])
}

/** Let a read that should never start prove it did not. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(PNG)
  mocks.home.mockReset().mockResolvedValue("/home/u")
  resetHomeDirCacheForTests()
})

describe("Read card of an image", () => {
  it("shows the picture codex's view_image read, once expanded", async () => {
    // What codex-acp streams: kind `read`, `{path}`, and no text result.
    renderCard(toolCall("read", { path: QR }))
    await settle()
    expect(mocks.read).not.toHaveBeenCalled()

    expand(QR_TITLE)
    const img = await screen.findByRole("img", { name: "login-qr-new.png" })
    expect(img).toHaveAttribute("src", `data:image/png;base64,${PNG}`)
    // The file panel's own reader, with its default size limit, on the path
    // as it stands: `/tmp` is outside the transcript's folder.
    expect(mocks.read).toHaveBeenCalledWith(QR)
    expect(screen.getByText(QR)).toBeInTheDocument()
  })

  it("is the same card when the conversation is reloaded", async () => {
    // The rollout keeps codex's raw function name and its arguments.
    renderCard(toolCall("view_image", { path: QR, detail: "high" }))
    expand(QR_TITLE)
    expect(
      await screen.findByRole("img", { name: "login-qr-new.png" })
    ).toBeInTheDocument()
    expect(mocks.read).toHaveBeenCalledWith(QR)
  })

  it("opens the picture full size", async () => {
    renderCard(toolCall("read", { path: QR }))
    expand(QR_TITLE)
    fireEvent.click(
      await screen.findByRole("button", { name: "login-qr-new.png" })
    )
    const dialog = screen.getByRole("dialog")
    expect(dialog).toBeVisible()
    expect(
      within(dialog).getByRole("img", { name: "login-qr-new.png" })
    ).toHaveAttribute("src", `data:image/png;base64,${PNG}`)
  })

  it("resolves a relative path against the transcript's folder", async () => {
    renderCard(toolCall("read", { file_path: "shots/home.jpg" }), "/w/app")
    expand(/Read shots\/home\.jpg/)
    const img = await screen.findByRole("img", { name: "home.jpg" })
    expect(img).toHaveAttribute("src", `data:image/jpeg;base64,${PNG}`)
    expect(mocks.read).toHaveBeenCalledWith("/w/app/shots/home.jpg")
  })

  it("resolves a home-relative path against the home directory", async () => {
    renderCard(toolCall("read", { file_path: "~/Desktop/shot.webp" }))
    expand(/Read Desktop\/shot\.webp/)
    expect(
      await screen.findByRole("img", { name: "shot.webp" })
    ).toHaveAttribute("src", `data:image/webp;base64,${PNG}`)
    expect(mocks.read).toHaveBeenCalledWith("/home/u/Desktop/shot.webp")
  })

  it("guesses no folder for a relative path the transcript has none for", async () => {
    renderCard(toolCall("read", { file_path: "shots/home.jpg" }), null)
    expand(/Read shots\/home\.jpg/)
    await settle()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("says so when the file cannot be read", async () => {
    mocks.read.mockRejectedValue(new Error("File does not exist"))
    renderCard(toolCall("read", { path: QR }))
    expand(QR_TITLE)
    expect(
      await screen.findByText("Could not load the image")
    ).toBeInTheDocument()
    expect(screen.getByText("File does not exist")).toBeInTheDocument()
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("says so when the file is no picture after all", async () => {
    renderCard(toolCall("read", { path: QR }))
    expand(QR_TITLE)
    fireEvent.error(
      await screen.findByRole("img", { name: "login-qr-new.png" })
    )
    expect(screen.getByText("Could not load the image")).toBeInTheDocument()
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("keeps a text result next to the picture", async () => {
    // OpenCode answers an image read with a line of text.
    renderCard(toolCall("read", { file_path: QR }, "Image read successfully"))
    expand(QR_TITLE)
    expect(
      await screen.findByRole("img", { name: "login-qr-new.png" })
    ).toBeInTheDocument()
    expect(screen.getByText("Image read successfully")).toBeInTheDocument()
  })

  it("reads nothing for a file that is not an image", async () => {
    renderCard(toolCall("read", { file_path: "/w/notes.md" }, "hello"))
    expand(/Read w\/notes\.md|Read notes\.md/)
    await settle()
    expect(screen.getByText("hello")).toBeInTheDocument()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it("reads nothing for an image the call writes", async () => {
    renderCard(
      toolCall("write", { file_path: "/w/logo.svg", content: "<svg/>" })
    )
    expand(/Write w\/logo\.svg|Write logo\.svg/)
    await settle()
    expect(screen.getByText("<svg/>")).toBeInTheDocument()
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
