import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"

const mocks = vi.hoisted(() => ({
  activeFileTab: null as FileWorkspaceTab | null,
  previewFileTabIds: new Set<string>(),
  toggleFileTabPreview: vi.fn(),
  // Returns a promise in both runtimes — the caller attaches a `.catch`.
  openPath: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceFileTabs: () => ({
    activeFileTab: mocks.activeFileTab,
    activeFileTabId: mocks.activeFileTab?.id ?? null,
    previewFileTabIds: mocks.previewFileTabIds,
  }),
  useWorkspaceActions: () => ({
    toggleFileTabPreview: mocks.toggleFileTabPreview,
  }),
}))
vi.mock("@/components/files/file-path-breadcrumb", () => ({
  FilePathBreadcrumb: ({ fileName }: { fileName: string }) => (
    <span>{fileName}</span>
  ),
}))
vi.mock("@/lib/platform", () => ({ openPath: mocks.openPath }))

import {
  resetHtmlPreviewControlsForTests,
  usePublishHtmlPreviewControls,
  type HtmlPreviewControls,
} from "./html-preview-controls"
import { FileWorkspaceHeader } from "./file-workspace-header"

/** Stands in for the HTML preview mounted in the column below the header. */
function PreviewStub({
  tabId,
  controls,
}: {
  tabId: string
  controls: HtmlPreviewControls
}) {
  usePublishHtmlPreviewControls(tabId, controls)
  return null
}

function renderHeader(preview?: {
  tabId: string
  controls: HtmlPreviewControls
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FileWorkspaceHeader />
      {preview && (
        <PreviewStub tabId={preview.tabId} controls={preview.controls} />
      )}
    </NextIntlClientProvider>
  )
}

function fileTab(overrides: Partial<FileWorkspaceTab> = {}): FileWorkspaceTab {
  return {
    id: "file:/repo/a.ts",
    kind: "file",
    folderId: null,
    title: "a.ts",
    description: "/repo/a.ts",
    path: "/repo/a.ts",
    language: "typescript",
    content: "",
    loading: false,
    ...overrides,
  } as FileWorkspaceTab
}

function htmlTab(): FileWorkspaceTab {
  return fileTab({
    id: "file:/repo/index.html",
    title: "index.html",
    description: "/repo/index.html",
    path: "/repo/index.html",
    language: "html",
  })
}

// jsdom has no `PointerEvent`; Radix reads `button` off the event, so a real
// `MouseEvent` under the pointer-event name is what opens the menu.
async function openMoreMenu() {
  const trigger = screen.getByRole("button", { name: "More" })
  await act(async () => {
    for (const type of ["pointerdown", "pointerup", "click"]) {
      fireEvent(
        trigger,
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const CONTROLS: HtmlPreviewControls = {
  scripts: {
    on: false,
    disabled: false,
    label: "Enable scripts",
    hint: "Run this document's scripts.",
    toggle: vi.fn(),
  },
  reload: { label: "Reload", run: vi.fn() },
  switchEngine: { to: "inline", label: "Use inline preview", run: vi.fn() },
  note: null,
}

beforeEach(() => {
  mocks.activeFileTab = null
  mocks.previewFileTabIds = new Set<string>()
  vi.clearAllMocks()
  resetHtmlPreviewControlsForTests()
})

describe("FileWorkspaceHeader", () => {
  it("names the active file", () => {
    mocks.activeFileTab = fileTab()
    const { container } = renderHeader()
    expect(screen.getByText("a.ts")).toBeInTheDocument()
    expect(container.firstChild).not.toBeNull()
  })

  it("self-hides for a browser tab, whose toolbar is its own header", () => {
    // Two rows of chrome above a web page is one too many: the page title is
    // already on the tab, and the toolbar below names the page better. Every
    // action this header carries is `kind: "file"` only, so nothing is lost.
    mocks.activeFileTab = {
      id: "browser:abc",
      kind: "browser",
      folderId: null,
      title: "Example",
      description: null,
      path: null,
      language: "browser",
      content: "",
      loading: false,
      readonly: true,
      browser: {
        initialUrl: "https://example.com/",
        openerTabId: null,
        profile: "default",
      },
    } as FileWorkspaceTab
    const { container } = renderHeader()
    expect(container.firstChild).toBeNull()
    expect(screen.queryByText("Example")).toBeNull()
  })

  it("renders nothing with no active tab", () => {
    const { container } = renderHeader()
    expect(container.firstChild).toBeNull()
  })
})

describe("FileWorkspaceHeader — the more menu", () => {
  it("opens an HTML file in the system browser, by that name", async () => {
    mocks.activeFileTab = htmlTab()
    renderHeader()
    // It is a menu row, not a button on the row: it leaves the app, which is
    // not something to sit one stray click away from the preview toggle.
    expect(
      screen.queryByRole("button", { name: "Open in system browser" })
    ).toBeNull()
    await openMoreMenu()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Open in system browser" }).click()
    })
    expect(mocks.openPath).toHaveBeenCalledWith("/repo/index.html")
  })

  it("offers nothing to open for a file the system browser can't show", async () => {
    mocks.activeFileTab = fileTab()
    renderHeader()
    await openMoreMenu()
    expect(
      screen.queryByRole("menuitem", { name: "Open in system browser" })
    ).toBeNull()
    // The path is still there to copy — the menu never opens empty.
    expect(
      screen.getByRole("menuitem", { name: "Copy path" })
    ).toBeInTheDocument()
  })

  it("carries the preview's own rows while one is on screen", async () => {
    mocks.activeFileTab = htmlTab()
    mocks.previewFileTabIds = new Set(["file:/repo/index.html"])
    renderHeader({ tabId: "file:/repo/index.html", controls: CONTROLS })
    await openMoreMenu()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Reload" }).click()
    })
    expect(CONTROLS.reload?.run).toHaveBeenCalled()
    await openMoreMenu()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Use inline preview" }).click()
    })
    expect(CONTROLS.switchEngine?.run).toHaveBeenCalled()
  })
})

describe("FileWorkspaceHeader — a hoisted HTML preview", () => {
  it("shows the scripts switch on the row, not in the menu", () => {
    mocks.activeFileTab = htmlTab()
    mocks.previewFileTabIds = new Set(["file:/repo/index.html"])
    renderHeader({ tabId: "file:/repo/index.html", controls: CONTROLS })
    const toggle = screen.getByRole("button", { name: "Enable scripts" })
    // A switch whose state you cannot see without opening a menu is not a
    // switch — and this one decides whether the document may run code.
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    expect(toggle).toHaveAttribute("title", "Run this document's scripts.")
    fireEvent.click(toggle)
    expect(CONTROLS.scripts.toggle).toHaveBeenCalled()
  })

  it("shows nothing of the preview once it is gone", () => {
    mocks.activeFileTab = htmlTab()
    mocks.previewFileTabIds = new Set(["file:/repo/index.html"])
    const view = renderHeader({
      tabId: "file:/repo/index.html",
      controls: CONTROLS,
    })
    expect(
      screen.getByRole("button", { name: "Enable scripts" })
    ).toBeInTheDocument()
    // Toggling back to source unmounts the preview: its controls go with it.
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <FileWorkspaceHeader />
      </NextIntlClientProvider>
    )
    expect(screen.queryByRole("button", { name: "Enable scripts" })).toBeNull()
  })

  it("never shows another file's controls", () => {
    // The preview of a file behind a full-page route stays mounted; the header
    // is looking at whatever tab is active now.
    mocks.activeFileTab = htmlTab()
    renderHeader({ tabId: "file:/repo/other.html", controls: CONTROLS })
    expect(screen.queryByRole("button", { name: "Enable scripts" })).toBeNull()
  })

  it("says when what is on screen is not what is in the editor", () => {
    mocks.activeFileTab = htmlTab()
    mocks.previewFileTabIds = new Set(["file:/repo/index.html"])
    renderHeader({
      tabId: "file:/repo/index.html",
      controls: { ...CONTROLS, note: "Unsaved changes are not shown" },
    })
    expect(
      screen.getByText("Unsaved changes are not shown")
    ).toBeInTheDocument()
  })
})
