import { fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// End-to-end guard for relative local file links. rehype-harden resolves a
// schemeless href against a placeholder origin and keeps only its pathname, so
// `./index.html` used to open `/index.html` at the filesystem root, and a bare
// `index.html` — or `~/a.md`, or `a.ts:12`, whose `a.ts:` sanitize took for a
// scheme — became "<name> [blocked]". Exercises the REAL Streamdown pipeline
// (no streamdown mock), so the assertions cover actual rehype `sanitize` +
// `harden` behavior and the record / restore steps around harden. Only the leaf
// dependencies of the real link-safety hook are stubbed, so the click path
// (badge → link-safety → `openFilePreview`) is genuinely exercised too.
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
import { Reasoning, ReasoningContent } from "./reasoning"

function fileBadgeButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    "button[data-resource-kind='file']"
  )
  if (!button) throw new Error("expected a clickable file badge")
  return button
}

describe("MessageResponse — relative local file links (real Streamdown)", () => {
  beforeEach(() => {
    mocks.openFilePreview.mockReset()
    mocks.openFilePreview.mockResolvedValue(undefined)
    mocks.toastError.mockReset()
    mocks.isDesktop.mockReturnValue(false)
    mocks.getActiveRemoteConnectionId.mockReturnValue(null)
    vi.spyOn(window, "open").mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ["./index.html", "index.html", undefined],
    ["index.html", "index.html", undefined],
    ["../site/index.html", "../site/index.html", undefined],
    ["deploy.sh", "deploy.sh", undefined],
    ["<./my notes.md>", "my notes.md", undefined],
    ["<my notes.md>", "my notes.md", undefined],
    [".gitignore", ".gitignore", undefined],
    ["Dockerfile", "Dockerfile", undefined],
    ["~/notes/a.md", "~/notes/a.md", undefined],
    ["a.ts:12", "a.ts", 12],
    ["src/a.ts#L3", "src/a.ts", 3],
  ])(
    "opens %s relative to the folder, not at the filesystem root",
    async (href, opened, line) => {
      const { container } = render(
        <MessageResponse>{`已创建 [index.html](${href})`}</MessageResponse>
      )

      await waitFor(() => {
        expect(fileBadgeButton(container)).toBeTruthy()
      })
      expect(container.textContent).not.toContain("[blocked]")

      expect(mocks.openFilePreview).not.toHaveBeenCalled()
      fireEvent.click(fileBadgeButton(container))
      await waitFor(() => {
        expect(mocks.openFilePreview).toHaveBeenCalledWith(opened, { line })
      })
      expect(mocks.openFilePreview).toHaveBeenCalledTimes(1)
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["static", false],
    ["streaming", true],
  ] as const)(
    "resolves file links inside headings (%s)",
    async (mode, parseIncompleteMarkdown) => {
      const { container } = render(
        <MessageResponse
          mode={mode}
          parseIncompleteMarkdown={parseIncompleteMarkdown}
        >
          {"## [index.html](index.html)\n\n### [a.ts:12](a.ts:12)\n\nbody"}
        </MessageResponse>
      )
      await waitFor(() => {
        expect(
          container.querySelectorAll("button[data-resource-kind='file']")
        ).toHaveLength(2)
      })
      expect(container.textContent).not.toContain("[blocked]")
      const [page, position] = container.querySelectorAll<HTMLButtonElement>(
        "h2 button[data-resource-kind='file'], h3 button[data-resource-kind='file']"
      )
      expect(mocks.openFilePreview).not.toHaveBeenCalled()

      // One open per click, each for its own link.
      fireEvent.click(page)
      await waitFor(() => {
        expect(mocks.openFilePreview).toHaveBeenCalledTimes(1)
      })
      expect(mocks.openFilePreview).toHaveBeenLastCalledWith("index.html", {
        line: undefined,
      })
      fireEvent.click(position)
      await waitFor(() => {
        expect(mocks.openFilePreview).toHaveBeenCalledTimes(2)
      })
      expect(mocks.openFilePreview).toHaveBeenLastCalledWith("a.ts", {
        line: 12,
      })
    }
  )

  it("resolves a relative raw HTML anchor too", async () => {
    const { container } = render(
      <MessageResponse>{'see <a href="src/a.ts">a.ts</a>'}</MessageResponse>
    )
    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })

    expect(mocks.openFilePreview).not.toHaveBeenCalled()
    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("src/a.ts", {
        line: undefined,
      })
    })
    expect(mocks.openFilePreview).toHaveBeenCalledTimes(1)
  })

  it("resolves a reference link through its relative definition", async () => {
    const { container } = render(
      <MessageResponse>{"see [a][page]\n\n[page]: index.html"}</MessageResponse>
    )
    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })

    expect(mocks.openFilePreview).not.toHaveBeenCalled()
    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("index.html", {
        line: undefined,
      })
    })
    expect(mocks.openFilePreview).toHaveBeenCalledTimes(1)
  })

  it("keeps a reference link on the definition it resolves to", async () => {
    // CommonMark takes the first `[doc]:`, so the link is `/docs/a.md`; the
    // relative duplicate below it must not reach the link in any form.
    const { container } = render(
      <MessageResponse>
        {"see [a][doc]\n\n[doc]: /docs/a.md\n[doc]: docs/a.md"}
      </MessageResponse>
    )
    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })

    expect(mocks.openFilePreview).not.toHaveBeenCalled()
    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("/docs/a.md", {
        line: undefined,
      })
    })
    expect(mocks.openFilePreview).toHaveBeenCalledTimes(1)
  })

  it("leaves a scheme-less web address alone rather than guess it is a file", async () => {
    const { container } = render(
      <MessageResponse>{"see [the repo](github.com/foo/bar)"}</MessageResponse>
    )
    await waitFor(() => {
      expect(container.textContent).toContain("the repo")
    })
    expect(
      container.querySelector("button[data-resource-kind='file']")
    ).toBeNull()
  })

  it("does not let a raw HTML attribute choose where a link opens", async () => {
    // What a link opens comes from its own href as sanitize left it; nothing
    // written beside it in the message is read back. The open is the proof:
    // the badge renders no extra attributes either way.
    const { container } = render(
      <MessageResponse>
        {'<a href="/abs/a.md" data-codeg-relative-href="../x">x</a>'}
      </MessageResponse>
    )
    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })

    expect(mocks.openFilePreview).not.toHaveBeenCalled()
    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("/abs/a.md", {
        line: undefined,
      })
    })
    expect(mocks.openFilePreview).toHaveBeenCalledTimes(1)
  })

  it("restores relative links in the reasoning panel too", async () => {
    const { container } = render(
      <Reasoning isStreaming={false} defaultOpen>
        <ReasoningContent>{"已创建 [index.html](index.html)"}</ReasoningContent>
      </Reasoning>
    )
    await waitFor(() => {
      expect(fileBadgeButton(container)).toBeTruthy()
    })
    expect(container.textContent).not.toContain("[blocked]")

    expect(mocks.openFilePreview).not.toHaveBeenCalled()
    fireEvent.click(fileBadgeButton(container))
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("index.html", {
        line: undefined,
      })
    })
    expect(mocks.openFilePreview).toHaveBeenCalledTimes(1)
  })
})
