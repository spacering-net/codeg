import { useState } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LinkSafetyModalProps } from "streamdown"
import {
  FilePathLink,
  openLinkWithSafety,
  useStreamdownLinkSafety,
} from "@/components/ai-elements/link-safety"
import { setBrowserCapabilitiesForTests } from "@/lib/browser/browser-api"

/** A desktop whose backend has answered: no built-in browser here. Set in
 *  the desktop cases — until the backend has answered, a web click on the
 *  desktop is held back rather than routed (`useOpenUrlTarget`). */
const DESKTOP_WITHOUT_BROWSER = {
  available: false,
  surface: null,
  platform: "macos",
  channel: "degraded" as const,
  reasons: ["child surface not compiled"],
  isolatedStorage: false,
  proxy: { url: null, applies: "unsupported" as const, reason: null },
  downloadsDir: "",
  docGuest: false,
  profiles: false,
  signInUserAgent: false,
  ownedWindowControls: false,
  remoteEgress: false,
  policy: { enabled: true, managedRules: [], managedSource: null },
}

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  openFilePreview: vi.fn(),
  toastError: vi.fn(),
  isDesktop: vi.fn(() => false),
  getActiveRemoteConnectionId: vi.fn<() => string | null>(() => null),
  activeFolderPath: "/repo",
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}))

vi.mock("@/lib/platform", () => ({
  openUrl: mocks.openUrl,
}))

vi.mock("@/lib/transport", () => ({
  isDesktop: mocks.isDesktop,
  getActiveRemoteConnectionId: mocks.getActiveRemoteConnectionId,
  // A desktop window bound to a remote server — mirrors the real helper.
  isRemoteDesktopMode: () =>
    mocks.isDesktop() && mocks.getActiveRemoteConnectionId() !== null,
  getServerBaseUrl: () => "https://dev.example.com",
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: {
      path: mocks.activeFolderPath,
    },
  }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => null,
  useWorkspaceActions: () => ({
    openFilePreview: mocks.openFilePreview,
  }),
}))

function LinkSafetyHarness({ url }: { url: string }) {
  const linkSafety = useStreamdownLinkSafety()
  const [open, setOpen] = useState(false)
  const renderModal = linkSafety.renderModal

  const props: LinkSafetyModalProps = {
    url,
    isOpen: open,
    onClose: () => setOpen(false),
    onConfirm: () => {},
  }

  return (
    <div>
      {/* Dispatch through the very helper MarkdownLink uses, so these config
          tests exercise the real click path instead of a copy that can drift
          from it (this harness used to hand-roll an awaiting handler — the
          exact shape #410 was about). */}
      <button
        type="button"
        onClick={() => openLinkWithSafety(url, linkSafety, () => setOpen(true))}
      >
        Trigger link
      </button>
      {renderModal?.(props)}
    </div>
  )
}

describe("link safety direct opening", () => {
  beforeEach(() => {
    mocks.openUrl.mockReset()
    mocks.openFilePreview.mockReset()
    mocks.toastError.mockReset()
    mocks.isDesktop.mockReset()
    mocks.isDesktop.mockReturnValue(false)
    setBrowserCapabilitiesForTests(null)
    mocks.getActiveRemoteConnectionId.mockReset()
    mocks.getActiveRemoteConnectionId.mockReturnValue(null)
    mocks.openFilePreview.mockResolvedValue(undefined)
    mocks.activeFolderPath = "/repo"
    vi.spyOn(window, "open").mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("opens markdown hyperlinks in the click's own task, without rendering a confirmation dialog", () => {
    render(<LinkSafetyHarness url="https://example.com/docs" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    // No waitFor: the web verdict is synchronous, so the open must land in the
    // click's own task or WebKit's popup blocker eats it. See #410.
    expect(window.open).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noreferrer"
    )
    expect(mocks.openUrl).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("opens markdown file links directly in the workspace", async () => {
    render(<LinkSafetyHarness url="file:///repo/src/app.ts#L12" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    // Absolute paths pass through untouched — openFilePreview owns routing
    // (owning-folder match or outside-workspace open) by absolute path.
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("/repo/src/app.ts", {
        line: 12,
      })
    })
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("jumps to the start line of a ranged file link (#L<start>-<end>)", async () => {
    render(<LinkSafetyHarness url="file:///repo/src/app.ts#L10-25" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("/repo/src/app.ts", {
        line: 10,
      })
    })
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("preserves the UNC authority of a file://server/share URI", async () => {
    // new URL("file://server/share/doc.md") parses host=server,
    // pathname=/share/doc.md — the opener must receive the full UNC path
    // //server/share/doc.md, not the local /share/doc.md.
    render(<LinkSafetyHarness url="file://server/share/doc.md" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(
        "//server/share/doc.md",
        { line: undefined }
      )
    })
  })

  it("opens a UNC link through the real chat path (remark-rewritten backslash form)", async () => {
    // In chat, remark-file-uri-links rewrites file://server/share/doc.md to
    // the backslash UNC form BEFORE MarkdownLink sees it. That rewritten
    // href must route to the file opener (as //server/share/doc.md), not
    // the browser.
    // JS string "\\\\server\\share\\doc.md" is the 2-backslash UNC form.
    render(<LinkSafetyHarness url={"\\\\server\\share\\doc.md"} />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(
        "//server/share/doc.md",
        { line: undefined }
      )
    })
    expect(window.open).not.toHaveBeenCalled()
  })

  it("opens a Windows drive link through the real chat path (remark-rewritten /C:/ form)", async () => {
    // In chat, remark-file-uri-links rewrites a bare `E:/…` (and file:///E:/…)
    // to the sanitize-safe `/E:/…` form BEFORE MarkdownLink sees it. That
    // rewritten href must route to the file opener as `E:/…` (leading slash
    // stripped), not the browser.
    render(<LinkSafetyHarness url="/E:/Desktop/docs/G.docx" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(
        "E:/Desktop/docs/G.docx",
        {
          line: undefined,
        }
      )
    })
    expect(window.open).not.toHaveBeenCalled()
  })

  it("passes ~ paths through for home expansion by the opener", async () => {
    render(<LinkSafetyHarness url="~/.claude/plans/notes.md" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(
        "~/.claude/plans/notes.md",
        { line: undefined }
      )
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("blocks unsupported markdown link protocols without rendering a confirmation dialog", async () => {
    render(<LinkSafetyHarness url="vscode://file/repo/src/app.ts" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("errorFailedLink", {
        description: "errorUnsupportedLinkProtocol",
      })
    })
    expect(window.open).not.toHaveBeenCalled()
    expect(mocks.openUrl).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("treats protocol-relative // URLs as web links, never local file IO", () => {
    // `//cdn.example.com/app.js` is protocol-relative — the browser resolves
    // it against the page protocol. parseLocalFileTarget must NOT claim it
    // (that would route "//Users/…"-style urls into local file reads);
    // classifyResourceKind tags `//…` with the web icon to match.
    render(<LinkSafetyHarness url="//cdn.example.com/app.js" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    expect(window.open).toHaveBeenCalledWith(
      "//cdn.example.com/app.js",
      "_blank",
      "noreferrer"
    )
    expect(mocks.openFilePreview).not.toHaveBeenCalled()
  })

  it("opens file path labels directly in the workspace", async () => {
    render(
      <FilePathLink filePath="/repo/src/lib.ts" line={5}>
        src/lib.ts
      </FilePathLink>
    )

    fireEvent.click(screen.getByRole("button", { name: "src/lib.ts" }))

    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("/repo/src/lib.ts", {
        line: 5,
      })
    })
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("opens protocol-relative links on desktop as concrete https URLs", async () => {
    // The Tauri opener capability only allows http(s) URLs; a raw "//host"
    // would resolve against the webview's own scheme. The dispatch must
    // canonicalize.
    mocks.isDesktop.mockReturnValue(true)
    mocks.openUrl.mockResolvedValue(undefined)
    setBrowserCapabilitiesForTests(DESKTOP_WITHOUT_BROWSER)

    render(<LinkSafetyHarness url="//cdn.example.com/app.js" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.openUrl).toHaveBeenCalledWith(
        "https://cdn.example.com/app.js"
      )
    })
    expect(window.open).not.toHaveBeenCalled()
    expect(mocks.openFilePreview).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("routes desktop external links through the platform opener instead of streamdown", async () => {
    mocks.isDesktop.mockReturnValue(true)
    mocks.openUrl.mockResolvedValue(undefined)
    setBrowserCapabilitiesForTests(DESKTOP_WITHOUT_BROWSER)

    render(<LinkSafetyHarness url="https://example.com/docs" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/docs")
    })
    expect(window.open).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("routes remote-workspace external links through the opener too", async () => {
    // A remote-desktop window is a Tauri webview bound to a remote server. It
    // has no local filesystem, but `window.open` is just as dead there as in a
    // local window — handing the link to streamdown would open nothing at all.
    mocks.isDesktop.mockReturnValue(true)
    mocks.getActiveRemoteConnectionId.mockReturnValue("conn-7")
    mocks.openUrl.mockResolvedValue(undefined)
    setBrowserCapabilitiesForTests(DESKTOP_WITHOUT_BROWSER)

    render(<LinkSafetyHarness url="https://example.com/docs" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/docs")
    })
    expect(window.open).not.toHaveBeenCalled()
  })

  it("still hands remote-workspace mailto: links to the synthetic anchor", async () => {
    // The OS-handler branch deliberately keeps treating a remote window as a
    // web opener: an anchor reaches the mail client from inside a webview, and
    // it sidesteps whether the opener capability covers non-http(s) schemes.
    mocks.isDesktop.mockReturnValue(true)
    mocks.getActiveRemoteConnectionId.mockReturnValue("conn-7")
    const clickedHrefs: string[] = []
    const clickSpy = vi
      .spyOn(HTMLElement.prototype, "click")
      .mockImplementation(function (this: HTMLElement) {
        if (this instanceof HTMLAnchorElement) clickedHrefs.push(this.href)
      })

    render(<LinkSafetyHarness url="mailto:hi@example.com" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(clickedHrefs).toContain("mailto:hi@example.com")
    })
    expect(mocks.openUrl).not.toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it("opens mailto: links via a synthetic anchor click in the browser to avoid an about:blank tab", async () => {
    mocks.isDesktop.mockReturnValue(false)
    const clickedHrefs: string[] = []
    const clickSpy = vi
      .spyOn(HTMLElement.prototype, "click")
      .mockImplementation(function (this: HTMLElement) {
        if (this instanceof HTMLAnchorElement) clickedHrefs.push(this.href)
      })

    render(<LinkSafetyHarness url="mailto:hi@example.com" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(clickedHrefs).toContain("mailto:hi@example.com")
    })
    expect(mocks.openUrl).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    clickSpy.mockRestore()
  })

  it("opens mailto: links via the platform opener on desktop", async () => {
    mocks.isDesktop.mockReturnValue(true)
    mocks.openUrl.mockResolvedValue(undefined)

    render(<LinkSafetyHarness url="mailto:hi@example.com" />)

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(mocks.openUrl).toHaveBeenCalledWith("mailto:hi@example.com")
    })
    expect(window.open).not.toHaveBeenCalled()
  })

  it("reflects the in-flight state on the file path button while a preview is opening", async () => {
    let resolveOpen: (() => void) | undefined
    mocks.openFilePreview.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve
        })
    )

    render(<FilePathLink filePath="/repo/src/lib.ts">src/lib.ts</FilePathLink>)

    const button = screen.getByRole("button", { name: "src/lib.ts" })
    fireEvent.click(button)

    await waitFor(() => {
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute("aria-busy", "true")
    })

    // Clicking while busy must not enqueue another open call.
    fireEvent.click(button)
    expect(mocks.openFilePreview).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveOpen?.()
    })

    await waitFor(() => {
      expect(button).not.toBeDisabled()
      expect(button).toHaveAttribute("aria-busy", "false")
    })
  })

  it("survives a parent re-render that swaps handler identities mid-flight", async () => {
    let resolvePendingOpen: (() => void) | undefined
    const initialOpenPreview = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePendingOpen = resolve
        })
    )
    mocks.openFilePreview = initialOpenPreview

    function ChurningHarness({ url, churn }: { url: string; churn: number }) {
      const linkSafety = useStreamdownLinkSafety()
      const [open, setOpen] = useState(false)
      return (
        <div data-churn={churn}>
          <button type="button" onClick={() => setOpen(true)}>
            Trigger link
          </button>
          {linkSafety.renderModal?.({
            url,
            isOpen: open,
            onClose: () => setOpen(false),
            onConfirm: () => {},
          })}
        </div>
      )
    }

    const { rerender } = render(
      <ChurningHarness url="file:///repo/src/app.ts" churn={0} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(initialOpenPreview).toHaveBeenCalledTimes(1)
    })

    // Swap `useWorkspaceActions().openFilePreview` to a fresh vi.fn so the
    // next render forces `useOpenLinkOrFile`'s `useCallback` to rebuild —
    // i.e. the `onAction` prop of `<DirectLinkOpen>` changes identity while
    // the original open is still pending. The previous `cancelled`-flag
    // implementation tore down the in-flight callback chain here and never
    // fired `onClose()`, stranding streamdown's `isOpen` at true.
    const replacementOpenPreview = vi.fn().mockResolvedValue(undefined)
    mocks.openFilePreview = replacementOpenPreview
    rerender(<ChurningHarness url="file:///repo/src/app.ts" churn={1} />)

    await act(async () => {
      resolvePendingOpen?.()
    })

    // A second click must reach the replacement handler — which proves the
    // modal state was reset by `onClose()` despite the mid-flight identity
    // change, and that subsequent opens route through the latest handler.
    fireEvent.click(screen.getByRole("button", { name: "Trigger link" }))

    await waitFor(() => {
      expect(replacementOpenPreview).toHaveBeenCalledTimes(1)
    })
    expect(initialOpenPreview).toHaveBeenCalledTimes(1)
  })
})
