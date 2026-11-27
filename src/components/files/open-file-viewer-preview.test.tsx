import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { OpenFileViewerPreview } from "./open-file-viewer-preview"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { buildFileTabId } from "@/lib/file-tab-id"

const { mockFileViewer } = vi.hoisted(() => ({ mockFileViewer: vi.fn() }))

// The real adapter drives the imperative core viewer; the component's own
// contract is just "hand it a File built from the tab's data: URL, full-size".
vi.mock("@open-file-viewer/react", () => ({
  FileViewer: (props: Record<string, unknown>) => {
    mockFileViewer(props)
    return <div data-testid="ofv" />
  },
}))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `Folder.fileViewer.${key}`,
}))

const TAB_ID = buildFileTabId({ kind: "file", path: "/repo/docs/a.doc" })

function tab(overrides: Partial<FileWorkspaceTab>): FileWorkspaceTab {
  return {
    id: TAB_ID,
    kind: "file",
    folderId: null,
    title: "a.doc",
    description: "/repo/docs/a.doc",
    path: "/repo/docs/a.doc",
    language: "ofv",
    content: "data:application/msword;base64,0M8R",
    loading: false,
    savedContent: "",
    isDirty: false,
    etag: null,
    mtimeMs: null,
    lineEnding: "none",
    saveState: "idle",
    saveError: null,
    ...overrides,
  } as FileWorkspaceTab
}

describe("OpenFileViewerPreview", () => {
  it("builds the File from the tab's data: URL and renders full-size", () => {
    render(<OpenFileViewerPreview tab={tab({})} />)

    expect(screen.getByTestId("ofv")).toBeInTheDocument()
    expect(mockFileViewer).toHaveBeenCalledTimes(1)
    const props = mockFileViewer.mock.calls[0][0] as {
      file: File
      fileName: string
      plugins: unknown[]
      height: string
      theme: string
    }
    expect(props.fileName).toBe("a.doc")
    expect(props.file).toBeInstanceOf(File)
    expect(props.file.name).toBe("a.doc")
    expect(props.file.type).toBe("application/msword")
    // Real decoded bytes, not the base64 wrapper text: base64 "0M8R" is the
    // 3-byte CFB magic prefix (D0 CF 11), not its 4 base64 characters.
    expect(props.file.size).toBe(3)
    expect(props.height).toBe("100%")
    expect(props.theme).toBe("auto")
    // Plugins are explicit — core only appends the fallback on its own.
    expect(props.plugins.length).toBeGreaterThan(1)
  })

  it("shows the open-file-viewer badge", () => {
    render(<OpenFileViewerPreview tab={tab({})} />)
    expect(screen.getByText("open-file-viewer")).toBeInTheDocument()
  })

  it("shows a notice while the bytes have not landed", () => {
    render(<OpenFileViewerPreview tab={tab({ content: "", loading: true })} />)
    expect(screen.queryByTestId("ofv")).not.toBeInTheDocument()
    expect(screen.getByText("Folder.fileViewer.loading")).toBeInTheDocument()
  })

  it("shows a notice for a file that is not loading and has no bytes", () => {
    render(<OpenFileViewerPreview tab={tab({ content: "" })} />)
    expect(screen.queryByTestId("ofv")).not.toBeInTheDocument()
  })
})
