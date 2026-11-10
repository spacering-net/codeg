import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

import enMessages from "@/i18n/messages/en.json"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import type { DetectedService } from "@/lib/browser/types"

const mocks = vi.hoisted(() => ({
  openBrowserTab: vi.fn(() => "browser:new"),
  openFilePreview: vi.fn(() => Promise.resolve("/abs/path")),
  openFileDialog: vi.fn(() => Promise.resolve<string | string[] | null>(null)),
  browserListServices: vi.fn(() => Promise.resolve<DetectedService[]>([])),
  fileTabs: [] as FileWorkspaceTab[],
  previewFileTabIds: new Set<string>(),
  browserState: null as { url: string; title: string } | null,
}))

let desktop = true
let remoteDesktop = false
let browserAvailable = true

// The strip is a Reorder.Group; the drag machinery is motion's, not ours, and
// none of it is what these tests are about. Strip the motion-only props so the
// rest (role, className, data-*, handlers) still reaches the DOM.
vi.mock("motion/react", () => {
  const MOTION_ONLY = new Set([
    "as",
    "values",
    "onReorder",
    "axis",
    "drag",
    "dragControls",
    "dragListener",
    "whileDrag",
    "value",
  ])
  const passthrough = ({
    children,
    ...rest
  }: Record<string, unknown> & { children?: ReactNode }) => (
    <div
      {...Object.fromEntries(
        Object.entries(rest).filter(([key]) => !MOTION_ONLY.has(key))
      )}
    >
      {children}
    </div>
  )
  return {
    Reorder: { Group: passthrough, Item: passthrough },
    useDragControls: () => ({ start: vi.fn() }),
  }
})

vi.mock("@/lib/transport", () => ({
  isDesktop: () => desktop,
  isRemoteDesktopMode: () => remoteDesktop,
}))
vi.mock("@/lib/platform", () => ({ openFileDialog: mocks.openFileDialog }))
vi.mock("@/lib/browser/browser-api", () => ({
  browserListServices: mocks.browserListServices,
}))
vi.mock("@/lib/browser/use-browser-capabilities", () => ({
  useBrowserCapabilities: () => ({ available: browserAvailable }),
}))
// Null by default: a record-only tab is the state a restored or not-yet-shown
// tab is in, and it is what the "+" produces. Set `mocks.browserState` for the
// cases that need a live page behind the record.
vi.mock("@/lib/browser/browser-tab-store", () => ({
  useBrowserTabState: () => mocks.browserState,
}))
vi.mock("@/components/browser/browser-agent-access", () => ({
  AGENT_MARK: "agent-mark",
}))
vi.mock("@/hooks/use-is-coarse-pointer", () => ({
  useIsCoarsePointer: () => false,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    switchFileTab: vi.fn(),
    closeFileTab: vi.fn(),
    closeOtherFileTabs: vi.fn(),
    closeAllFileTabs: vi.fn(),
    reorderFileTabs: vi.fn(),
    toggleFilesMaximized: vi.fn(),
    openFilePreview: mocks.openFilePreview,
    openBrowserTab: mocks.openBrowserTab,
  }),
  useWorkspaceFileTabs: () => ({
    fileTabs: mocks.fileTabs,
    activeFileTabId: mocks.fileTabs[0]?.id ?? null,
    previewFileTabIds: mocks.previewFileTabIds,
  }),
  useWorkspaceView: () => ({ mode: "fusion", filesMaximized: false }),
}))

import { FileWorkspaceTabBar } from "./file-workspace-tab-bar"

function fileTab(path: string): FileWorkspaceTab {
  return {
    id: `file:${path}`,
    kind: "file",
    folderId: null,
    title: path.split("/").pop() ?? path,
    description: path,
    path,
    language: "typescript",
    content: "",
    loading: false,
  } as FileWorkspaceTab
}

function htmlTab(path: string, content: string): FileWorkspaceTab {
  return {
    ...fileTab(path),
    language: "html",
    content,
  } as FileWorkspaceTab
}

function browserTab(url: string, title = url): FileWorkspaceTab {
  return {
    id: "browser:abc",
    kind: "browser",
    folderId: null,
    title,
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: false,
    readonly: true,
    browser: { initialUrl: url, openerTabId: null, profile: "default" },
  } as FileWorkspaceTab
}

function renderStrip() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FileWorkspaceTabBar />
    </NextIntlClientProvider>
  )
}

// jsdom has no `PointerEvent`; Radix reads `button` off the event, so a real
// `MouseEvent` under the pointer-event name is what opens the menu.
async function openAddMenu() {
  const trigger = screen.getByRole("button", { name: "New tab" })
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

beforeEach(() => {
  desktop = true
  remoteDesktop = false
  browserAvailable = true
  mocks.fileTabs = [fileTab("/repo/a.ts")]
  mocks.previewFileTabIds = new Set<string>()
  mocks.browserState = null
  vi.clearAllMocks()
  mocks.openFileDialog.mockResolvedValue(null)
  mocks.browserListServices.mockResolvedValue([])
})

function detectedService(
  url: string,
  source: DetectedService["source"] = "terminal"
): DetectedService {
  return {
    url,
    origin: new URL(url).origin,
    authority: new URL(url).host,
    ownerWindow: "main",
    source,
    terminalId: "t1",
  }
}

describe("FileWorkspaceTabBar — the add-tab '+'", () => {
  it("opens an empty browser tab", async () => {
    renderStrip()
    await openAddMenu()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Browser tab" }).click()
    })
    // The blank page, not a home page: an empty tab with a focused address bar.
    expect(mocks.openBrowserTab).toHaveBeenCalledWith("about:blank")
  })

  it("opens the file the native picker returned, as an absolute path", async () => {
    mocks.openFileDialog.mockResolvedValue("/repo/src/../src/notes.md")
    renderStrip()
    await openAddMenu()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Open file…" }).click()
    })
    expect(mocks.openFileDialog).toHaveBeenCalledWith({ title: "Open file" })
    expect(mocks.openFilePreview).toHaveBeenCalledWith("/repo/src/notes.md")
  })

  it("does nothing when the picker is dismissed", async () => {
    renderStrip()
    await openAddMenu()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Open file…" }).click()
    })
    expect(mocks.openFilePreview).not.toHaveBeenCalled()
  })

  it("drops the browser row when there is no built-in browser", async () => {
    browserAvailable = false
    renderStrip()
    await openAddMenu()
    expect(screen.queryByRole("menuitem", { name: "Browser tab" })).toBeNull()
    expect(
      screen.getByRole("menuitem", { name: "Open file…" })
    ).toBeInTheDocument()
  })

  it("drops the picker row where a native dialog would pick the wrong machine", async () => {
    remoteDesktop = true
    renderStrip()
    await openAddMenu()
    expect(screen.queryByRole("menuitem", { name: "Open file…" })).toBeNull()
    expect(
      screen.getByRole("menuitem", { name: "Browser tab" })
    ).toBeInTheDocument()
  })

  it("lists the local servers running now, and opens one", async () => {
    mocks.browserListServices.mockResolvedValue([
      detectedService("http://localhost:5173/"),
      detectedService("http://127.0.0.1:8000/", "agent"),
    ])
    renderStrip()
    await openAddMenu()
    // Asked when the menu opened, not held from an earlier answer: a server
    // that has stopped is already out of what the backend returns.
    expect(mocks.browserListServices).toHaveBeenCalledTimes(1)
    const entry = screen.getByRole("menuitem", { name: /localhost:5173/ })
    // Where it came from is on the row, so a server an agent started is not
    // mistaken for one the person started.
    expect(
      screen.getByRole("menuitem", { name: /127\.0\.0\.1:8000/ })
    ).toHaveTextContent("Agent")
    await act(async () => {
      entry.click()
    })
    expect(mocks.openBrowserTab).toHaveBeenCalledWith("http://localhost:5173/")
  })

  it("shows no local-server section when nothing is running", async () => {
    renderStrip()
    await openAddMenu()
    expect(screen.queryByText("Local servers")).toBeNull()
  })

  it("does not ask for local servers where there is no browser to open them in", async () => {
    browserAvailable = false
    renderStrip()
    await openAddMenu()
    expect(mocks.browserListServices).not.toHaveBeenCalled()
  })

  // Those servers were started by THIS computer's terminals; a window bound
  // to a remote codeg-server runs its terminals on that host.
  it("does not offer this computer's servers in a remote workspace window", async () => {
    remoteDesktop = true
    mocks.browserListServices.mockResolvedValue([
      detectedService("http://localhost:5173/"),
    ])
    renderStrip()
    await openAddMenu()
    expect(mocks.browserListServices).not.toHaveBeenCalled()
    expect(screen.queryByText("Local servers")).toBeNull()
  })

  it("hides itself entirely rather than opening an empty menu", () => {
    desktop = false
    browserAvailable = false
    renderStrip()
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull()
    // The strip itself still renders — this is the button's own gate.
    expect(screen.getByRole("tablist")).toBeInTheDocument()
  })
})

describe("FileWorkspaceTabBar — an empty browser tab", () => {
  it("names itself instead of showing 'about:blank'", () => {
    mocks.fileTabs = [browserTab("about:blank")]
    renderStrip()
    expect(screen.getByRole("tab")).toHaveTextContent("New tab")
    expect(screen.getByRole("tab")).not.toHaveTextContent("about:blank")
  })

  it("carries no address in its tooltip — there is none to show", () => {
    mocks.fileTabs = [browserTab("about:blank")]
    renderStrip()
    expect(screen.getByRole("tab").title).not.toContain("about:blank")
  })

  // A tab opened empty keeps `about:blank` as its record title for life — the
  // record is stamped once, and there was no host to name it after. So once
  // it has gone somewhere, the record title is the one thing that must NOT be
  // shown: the page it names is not the page it is on.
  it("names the host, not 'about:blank', once it has navigated", () => {
    mocks.fileTabs = [browserTab("about:blank")]
    // A page that never says its title — a JSON endpoint, a directory index —
    // and every page for as long as a navigation is in flight.
    mocks.browserState = {
      url: "https://example.com/api/items.json",
      title: "",
    }
    renderStrip()
    const tab = screen.getByRole("tab")
    expect(tab).not.toHaveTextContent("about:blank")
    expect(tab).not.toHaveTextContent("New tab")
    expect(tab).toHaveTextContent("example.com")
    expect(tab.title).toBe("example.com\nhttps://example.com/api/items.json")
  })
})

describe("FileWorkspaceTabBar — a previewed HTML file", () => {
  const PAGE = "<!doctype html><title>NETRUNNER // ACCESS TERMINAL</title><p>x"

  it("is named by the document, with the file behind it on hover", () => {
    mocks.fileTabs = [htmlTab("/repo/site/index.html", PAGE)]
    mocks.previewFileTabIds = new Set(["file:/repo/site/index.html"])
    renderStrip()
    const tab = screen.getByRole("tab")
    expect(tab).toHaveTextContent("NETRUNNER // ACCESS TERMINAL")
    expect(tab).not.toHaveTextContent("index.html")
    // Browser-tab shape: what it is, then where it lives, one per line.
    expect(tab.title).toBe(
      "NETRUNNER // ACCESS TERMINAL\n/repo/site/index.html"
    )
  })

  it("is named by the file while its source is showing", () => {
    // The tab is an editor then, and `index.html` is what is being edited.
    mocks.fileTabs = [htmlTab("/repo/site/index.html", PAGE)]
    renderStrip()
    const tab = screen.getByRole("tab")
    expect(tab).toHaveTextContent("index.html")
    expect(tab).not.toHaveTextContent("NETRUNNER")
    expect(tab.title).toBe("/repo/site/index.html")
  })

  it("keeps the file name when the document has no title of its own", () => {
    mocks.fileTabs = [htmlTab("/repo/site/index.html", "<p>no title here")]
    mocks.previewFileTabIds = new Set(["file:/repo/site/index.html"])
    renderStrip()
    expect(screen.getByRole("tab")).toHaveTextContent("index.html")
  })

  it("leaves a previewed markdown file alone", () => {
    // Only HTML has a document title; a `# heading` is not one, and reading
    // one out of the source would rename the tab on every keystroke.
    const md = { ...fileTab("/repo/notes.md"), language: "markdown" }
    mocks.fileTabs = [md as FileWorkspaceTab]
    mocks.previewFileTabIds = new Set(["file:/repo/notes.md"])
    renderStrip()
    expect(screen.getByRole("tab")).toHaveTextContent("notes.md")
  })
})

describe("FileWorkspaceTabBar — browser tab hover", () => {
  it("gives the full title and the address, one per line", () => {
    mocks.fileTabs = [
      browserTab(
        "https://example.com/docs",
        "A page title far too long for the tab"
      ),
    ]
    renderStrip()
    // The label in the strip is always cut short (a page title is a sentence)
    // and the address appears nowhere in the strip, so hovering has to supply
    // both — that is the whole point of the tooltip on this tab kind.
    expect(screen.getByRole("tab").title).toBe(
      "A page title far too long for the tab\nhttps://example.com/docs"
    )
  })
})
