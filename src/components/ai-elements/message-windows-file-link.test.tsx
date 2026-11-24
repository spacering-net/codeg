import { fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// End-to-end guard for the "Windows local file link renders as [blocked]" bug
// (issue #362). Exercises the REAL Streamdown pipeline (no streamdown mock) so
// the assertions cover actual rehype `sanitize` + `harden` behavior — the layer
// that read `E:` in `E:/…` as a URL protocol, stripped the href, and let harden
// replace the link with "<name> [blocked]". Only the leaf dependencies of the
// real link-safety hook are stubbed, so the click path (badge → link-safety →
// `openFilePreview`) is genuinely exercised too.
const mocks = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
  openUrl: vi.fn(),
  toastError: vi.fn(),
  isDesktop: vi.fn(() => false),
  getActiveRemoteConnectionId: vi.fn(() => null),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}))

vi.mock("@/lib/platform", () => ({
  openUrl: mocks.openUrl,
}))

vi.mock("@/lib/transport", () => ({
  isDesktop: mocks.isDesktop,
  getActiveRemoteConnectionId: mocks.getActiveRemoteConnectionId,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { path: "/repo" } }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => null,
  useWorkspaceActions: () => ({ openFilePreview: mocks.openFilePreview }),
}))

import { MessageResponse } from "./message"

function fileBadgeButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    "button[data-resource-kind='file']"
  )
  if (!button) throw new Error("expected a clickable file badge")
  return button
}

describe("MessageResponse — Windows local file links (issue #362, real Streamdown)", () => {
  beforeEach(() => {
    mocks.openFilePreview.mockReset()
    mocks.openFilePreview.mockResolvedValue(undefined)
    mocks.openUrl.mockReset()
    mocks.openUrl.mockResolvedValue(undefined)
    mocks.toastError.mockReset()
    mocks.isDesktop.mockReset()
    mocks.isDesktop.mockReturnValue(false)
    mocks.getActiveRemoteConnectionId.mockReset()
    mocks.getActiveRemoteConnectionId.mockReturnValue(null)
    vi.spyOn(window, "open").mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders a bare Windows drive-path link as a file badge, not '[blocked]'", async () => {
    const { container } = render(
      <MessageResponse>{"[Gd.docx](E:/Desktop/docs/Gd.docx)"}</MessageResponse>
    )

    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })
    expect(container.textContent).toContain("Gd.docx")
    expect(container.textContent).not.toContain("[blocked]")

    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(
        "E:/Desktop/docs/Gd.docx",
        {
          line: undefined,
        }
      )
    })
    expect(window.open).not.toHaveBeenCalled()
  })

  it("renders a file:///E:/… link as a file badge, not '[blocked]'", async () => {
    const { container } = render(
      <MessageResponse>
        {"[Gd.docx](file:///E:/Desktop/docs/Gd.docx)"}
      </MessageResponse>
    )

    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })
    expect(container.textContent).not.toContain("[blocked]")

    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(
        "E:/Desktop/docs/Gd.docx",
        {
          line: undefined,
        }
      )
    })
  })

  it("handles a Chinese Windows path", async () => {
    const { container } = render(
      <MessageResponse>{"[手册](E:/桌面/使用手册/G手册.docx)"}</MessageResponse>
    )

    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })
    expect(container.textContent).not.toContain("[blocked]")

    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(
        "E:/桌面/使用手册/G手册.docx",
        { line: undefined }
      )
    })
  })

  it("handles a URL-encoded Windows path with spaces", async () => {
    const { container } = render(
      <MessageResponse>
        {"[手册](E:/My%20Docs/%E6%89%8B%E5%86%8C.docx)"}
      </MessageResponse>
    )

    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })
    expect(container.textContent).not.toContain("[blocked]")

    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(
        "E:/My Docs/手册.docx",
        {
          line: undefined,
        }
      )
    })
  })

  it("keeps blocking javascript:/data:/vbscript: links", async () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
    ]) {
      const { container, unmount } = render(
        <MessageResponse>{`[click](${href})`}</MessageResponse>
      )
      await waitFor(() => {
        expect(container.textContent).toContain("[blocked]")
      })
      // No openable file/web affordance was minted for a dangerous scheme.
      expect(container.querySelector("button[data-resource-kind]")).toBeNull()
      unmount()
    }
  })

  it("does not regress POSIX file links", async () => {
    const { container } = render(
      <MessageResponse>{"[app](file:///repo/src/app.ts)"}</MessageResponse>
    )

    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })
    expect(container.textContent).not.toContain("[blocked]")

    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("/repo/src/app.ts", {
        line: undefined,
      })
    })
  })

  it("documents the known UNC end-to-end limitation (out of scope for #362)", async () => {
    // remark rewrites file://server/share/doc.md to the backslash UNC form
    // `\\server\share\doc.md` (the correct LOCAL signal for link-safety). But
    // rehype-harden re-parses hrefs with `new URL` and only retries relatives
    // starting with `/` `./` `../`, so a backslash href fails to parse and is
    // blocked — while a forward-slash `//server/share` would be collapsed to a
    // hostless `/share/…` (losing the server). UNC therefore can't be expressed
    // as a harden-surviving relative URL without inventing a scheme, which #362
    // forbids. This test pins the CURRENT behavior so a future UNC fix updates
    // it deliberately. The remark layer + the click routing of the backslash
    // form stay covered by their own unit tests (no regression there).
    const { container } = render(
      <MessageResponse>{"[doc](file://server/share/doc.md)"}</MessageResponse>
    )

    await waitFor(() => {
      expect(container.textContent).toContain("[blocked]")
    })
    expect(container.querySelector("button[data-resource-kind]")).toBeNull()
    expect(mocks.openFilePreview).not.toHaveBeenCalled()
  })

  it("does not regress https links (routed to the browser, not the file opener)", async () => {
    const { container } = render(
      <MessageResponse>{"[docs](https://example.com)"}</MessageResponse>
    )

    await waitFor(() => {
      expect(container.querySelector("[data-streamdown='link']")).not.toBeNull()
    })
    expect(container.textContent).not.toContain("[blocked]")

    fireEvent.click(container.querySelector("[data-streamdown='link']")!)
    await waitFor(() => {
      // Streamdown normalizes the href through `new URL`, adding the trailing
      // slash; the click still routes to the browser (never the file opener).
      expect(window.open).toHaveBeenCalledWith(
        "https://example.com/",
        "_blank",
        "noreferrer"
      )
    })
    expect(mocks.openFilePreview).not.toHaveBeenCalled()
  })
})
