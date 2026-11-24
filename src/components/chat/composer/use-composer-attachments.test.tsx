import { Editor } from "@tiptap/core"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ClipboardFile } from "@/lib/clipboard-files"
import { buildFileUri } from "@/lib/reference-link"

import { DRAG_DROP_IMAGE_MAX_BYTES } from "./attachment-files"
import { buildComposerExtensions } from "./editor-config"
import type { RichComposerHandle } from "./rich-composer"
import { useComposerAttachments } from "./use-composer-attachments"

// A desktop window, local unless a test binds it to a remote workspace.
const env = vi.hoisted(() => ({ remoteId: null as number | null }))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  openFileDialog: vi.fn(),
}))
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  getActiveRemoteConnectionId: () => env.remoteId,
}))

// What the OS clipboard holds as files, per test; `null` makes the read fail.
const clipboard = vi.hoisted(() => ({
  files: [] as ClipboardFile[] | null,
}))
vi.mock("@/lib/clipboard-files", () => ({
  readClipboardFiles: vi.fn(async () => {
    if (clipboard.files === null) throw new Error("no clipboard")
    return clipboard.files
  }),
}))

const api = vi.hoisted(() => ({
  readFileBase64: vi.fn(async () => "aW1hZ2U="),
  uploadAttachment: vi.fn(async (file: File, sessionId?: string | null) => ({
    path: `/uploads/${sessionId ?? "anon"}/${file.name}`,
    name: file.name,
    size: file.size,
    mimeType: file.type || null,
  })),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  readFileBase64: api.readFileBase64,
  uploadAttachment: api.uploadAttachment,
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

let editor: Editor

beforeEach(() => {
  editor = new Editor({ extensions: buildComposerExtensions() })
  env.remoteId = null
  clipboard.files = []
  api.readFileBase64.mockClear()
  api.uploadAttachment.mockClear()
})

afterEach(() => {
  editor.destroy()
})

function renderAttachments() {
  const editorRef = {
    current: { getEditor: () => editor } as unknown as RichComposerHandle,
  }
  return renderHook(() =>
    useComposerAttachments({
      editorRef,
      promptCapabilities: { image: true, embedded_context: true },
      attachmentTabId: "tab-1",
    })
  )
}

function pastedFile(name: string, size: number, type = ""): File {
  return new File([new Uint8Array(size)], name, { type })
}

function paste(files: File[]): ClipboardEvent {
  return {
    clipboardData: {
      files,
      items: [],
      types: ["Files"],
      getData: () => "",
    },
  } as unknown as ClipboardEvent
}

function fileBadgeUris(): string[] {
  const uris: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === "reference" && node.attrs.refType === "file") {
      uris.push(node.attrs.uri)
    }
  })
  return uris
}

describe("a desktop paste of files copied in Finder / Explorer", () => {
  it("attaches each file by its real path, as a drop would", async () => {
    clipboard.files = [
      { path: "/work/bundle.zip", name: "bundle.zip", size: 117, isDir: false },
      { path: "/work/assets", name: "assets", size: null, isDir: true },
    ]
    const { result } = renderAttachments()
    let consumed = false
    act(() => {
      consumed = result.current.handlePasteFiles(
        paste([
          pastedFile("bundle.zip", 117, "application/zip"),
          pastedFile("assets", 0),
        ])
      )
    })
    expect(consumed).toBe(true)
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([
        buildFileUri("/work/bundle.zip"),
        buildFileUri("/work/assets"),
      ])
    )
    // Nothing was read for its bytes or copied anywhere.
    expect(api.uploadAttachment).not.toHaveBeenCalled()
    expect(result.current.embeddedPayloadsRef.current.size).toBe(0)
  })

  it("keeps a pasted image file's thumbnail, read from its path", async () => {
    clipboard.files = [
      { path: "/work/shot.png", name: "shot.png", size: 70, isDir: false },
    ]
    const { result } = renderAttachments()
    act(() => {
      result.current.handlePasteFiles(
        paste([pastedFile("shot.png", 70, "image/png")])
      )
    })
    await waitFor(() => expect(result.current.imageAttachments).toHaveLength(1))
    expect(result.current.imageAttachments[0]).toMatchObject({
      uri: buildFileUri("/work/shot.png"),
      data: "aW1hZ2U=",
    })
    expect(api.readFileBase64).toHaveBeenCalledWith(
      "/work/shot.png",
      DRAG_DROP_IMAGE_MAX_BYTES
    )
  })

  it("attaches an image whose thumbnail cannot be read by its path instead", async () => {
    clipboard.files = [
      { path: "/work/huge.png", name: "huge.png", size: 70, isDir: false },
    ]
    api.readFileBase64.mockRejectedValueOnce(new Error("over the inline cap"))
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = renderAttachments()
    act(() => {
      result.current.handlePasteFiles(
        paste([pastedFile("huge.png", 70, "image/png")])
      )
    })
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([buildFileUri("/work/huge.png")])
    )
    expect(result.current.imageAttachments).toEqual([])
    quiet.mockRestore()
  })

  it("still sends a screenshot's bytes, since no file is behind it", async () => {
    const { result } = renderAttachments()
    act(() => {
      result.current.handlePasteFiles(
        paste([pastedFile("image.png", 70, "image/png")])
      )
    })
    await waitFor(() => expect(result.current.imageAttachments).toHaveLength(1))
    expect(result.current.imageAttachments[0].uri).toBeNull()
    expect(api.readFileBase64).not.toHaveBeenCalled()
  })

  it("keeps other bytes with no file behind them in the uploads directory", async () => {
    const { result } = renderAttachments()
    const clip = pastedFile("clip.zip", 4, "application/zip")
    act(() => {
      result.current.handlePasteFiles(paste([clip]))
    })
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([buildFileUri("/uploads/tab-1/clip.zip")])
    )
    expect(api.uploadAttachment).toHaveBeenCalledWith(clip, "tab-1")
    expect(result.current.embeddedPayloadsRef.current.size).toBe(0)
  })

  it("falls back to the bytes when the clipboard cannot be read", async () => {
    clipboard.files = null
    const { result } = renderAttachments()
    const zip = pastedFile("bundle.zip", 117, "application/zip")
    act(() => {
      result.current.handlePasteFiles(paste([zip]))
    })
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([
        buildFileUri("/uploads/tab-1/bundle.zip"),
      ])
    )
    expect(api.uploadAttachment).toHaveBeenCalledWith(zip, "tab-1")
  })

  it("keeps uploading in a window bound to a remote workspace", async () => {
    env.remoteId = 7
    clipboard.files = [
      { path: "/work/bundle.zip", name: "bundle.zip", size: 117, isDir: false },
    ]
    const { result } = renderAttachments()
    const zip = pastedFile("bundle.zip", 117, "application/zip")
    act(() => {
      result.current.handlePasteFiles(paste([zip]))
    })
    await waitFor(() =>
      expect(api.uploadAttachment).toHaveBeenCalledWith(zip, "tab-1")
    )
    // The local path means nothing to the remote agent.
    expect(fileBadgeUris()).toEqual([buildFileUri("/uploads/tab-1/bundle.zip")])
  })
})

describe("appendClipboardFiles (a paste with no files of its own)", () => {
  it("attaches the files on the clipboard by path", async () => {
    clipboard.files = [
      {
        path: "/work/report.docx",
        name: "report.docx",
        size: 204,
        isDir: false,
      },
    ]
    const { result } = renderAttachments()
    let attached = false
    await act(async () => {
      attached = await result.current.appendClipboardFiles()
    })
    expect(attached).toBe(true)
    expect(fileBadgeUris()).toEqual([buildFileUri("/work/report.docx")])
  })

  it("keeps an image it cannot make a thumbnail of, by its path", async () => {
    clipboard.files = [
      { path: "/work/huge.png", name: "huge.png", size: 70, isDir: false },
    ]
    api.readFileBase64.mockRejectedValueOnce(new Error("over the inline cap"))
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = renderAttachments()
    await act(async () => {
      expect(await result.current.appendClipboardFiles()).toBe(true)
    })
    expect(fileBadgeUris()).toEqual([buildFileUri("/work/huge.png")])
    expect(result.current.imageAttachments).toEqual([])
    quiet.mockRestore()
  })

  it("reports false when the clipboard holds no files, or cannot be read", async () => {
    const { result } = renderAttachments()
    await act(async () => {
      expect(await result.current.appendClipboardFiles()).toBe(false)
    })
    clipboard.files = null
    await act(async () => {
      expect(await result.current.appendClipboardFiles()).toBe(false)
    })
    expect(fileBadgeUris()).toEqual([])
  })

  it("does nothing in a window bound to a remote workspace", async () => {
    env.remoteId = 7
    clipboard.files = [
      {
        path: "/work/report.docx",
        name: "report.docx",
        size: 204,
        isDir: false,
      },
    ]
    const { result } = renderAttachments()
    await act(async () => {
      expect(await result.current.appendClipboardFiles()).toBe(false)
    })
    expect(fileBadgeUris()).toEqual([])
  })
})
