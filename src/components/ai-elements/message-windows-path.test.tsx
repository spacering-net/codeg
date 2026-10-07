import { fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// End-to-end guard for issue #508 — "生成的路径错误". An agent wrote a Windows
// path in prose; CommonMark's `characterEscape` construct swallowed the `\`
// before `.playwright-cli`, and link-safety then normalized the survivors to
// `/`, producing exactly the path the reporter saw. Runs the REAL Streamdown
// pipeline (no streamdown mock) so the assertions cover the actual parse, not
// our idea of it; only the leaf dependencies of the link-safety hook are
// stubbed, so the click path (badge → link-safety → `openFilePreview`) is
// exercised too.
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
  useActiveFolder: () => ({
    activeFolder: { path: "C:/workspace/code/hajia/web/hj-cloud-single.git" },
  }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => null,
  useWorkspaceActions: () => ({ openFilePreview: mocks.openFilePreview }),
}))

import { MessageResponse } from "./message"

/** The path the agent wrote, exactly as reported in issue #508. */
const AGENT_PATH =
  "C:\\workspace\\code\\hajia\\web\\hj-cloud-single.git\\.playwright-cli\\pam-login-failed-20260818-083606-368.png"

/** What the file opener must receive (backslashes normalized to forward). */
const OPENER_PATH =
  "C:/workspace/code/hajia/web/hj-cloud-single.git/.playwright-cli/pam-login-failed-20260818-083606-368.png"

/** The corrupted form this test exists to prevent. */
const GLUED = "hj-cloud-single.git.playwright-cli"

describe("MessageResponse — Windows paths in agent text (issue #508)", () => {
  beforeEach(() => {
    mocks.openFilePreview.mockReset()
    mocks.openFilePreview.mockResolvedValue(undefined)
    mocks.openUrl.mockReset()
    mocks.toastError.mockReset()
    mocks.isDesktop.mockReset()
    mocks.isDesktop.mockReturnValue(false)
    mocks.getActiveRemoteConnectionId.mockReset()
    mocks.getActiveRemoteConnectionId.mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders a path in prose byte-identically to what the agent wrote", async () => {
    const { container } = render(
      <MessageResponse>{`截图已保存：${AGENT_PATH}`}</MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toContain("截图已保存"))
    expect(container.textContent).toContain(AGENT_PATH)
    expect(container.textContent).not.toContain(GLUED)
  })

  it("opens the path the agent wrote when it is a markdown link", async () => {
    const { container } = render(
      <MessageResponse>{`[screenshot](${AGENT_PATH})`}</MessageResponse>
    )

    const badge = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        "button[data-resource-kind='file']"
      )
      if (!button) throw new Error("expected a clickable file badge")
      return button
    })
    // The tooltip shows the real path, not the sanitized `%5C` href.
    expect(badge.getAttribute("title")).toBe(OPENER_PATH)

    fireEvent.click(badge)
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith(OPENER_PATH, {
        line: undefined,
      })
    })
  })

  it("keeps a `:line` suffix in the badge tooltip", async () => {
    const { container } = render(
      <MessageResponse>{"[a.ts](C:\\repo\\.src\\a.ts:42)"}</MessageResponse>
    )

    const badge = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        "button[data-resource-kind='file']"
      )
      if (!button) throw new Error("expected a clickable file badge")
      return button
    })
    expect(badge.getAttribute("title")).toBe("C:/repo/.src/a.ts:42")

    fireEvent.click(badge)
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("C:/repo/.src/a.ts", {
        line: 42,
      })
    })
  })

  it("keeps every punctuation-initial segment of a path", async () => {
    const path = "C:\\a\\-dir\\_x\\(y)\\#z\\+w\\!v\\file.txt"
    const { container } = render(<MessageResponse>{path}</MessageResponse>)

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toContain(path)
  })

  it("keeps a spaced path intact when no segment starts with punctuation", async () => {
    const path = "C:\\Program Files\\Google\\chrome.exe"
    const { container } = render(
      <MessageResponse>{`run ${path} now`}</MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toContain(path)
  })

  it("documents the spaced-path limit (a path is never followed across a space)", async () => {
    // A run that could cross whitespace would let a backslash arbitrarily far
    // right pull a whole sentence into the "path", so this shape keeps the
    // #508 bug on purpose. Pinned so a future attempt at spaces is deliberate.
    const { container } = render(
      <MessageResponse>{"C:\\Users\\John Doe\\.gitconfig"}</MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toBe("C:\\Users\\John Doe.gitconfig")
  })

  it("never creates markup while restoring a separator", async () => {
    // Repairing the parsed tree cannot linkify or emphasize anything, so a
    // segment full of punctuation comes back whole and inert.
    for (const path of [
      "C:\\repo\\_private_\\file.txt",
      "C:\\a\\~old~\\b",
      "C:\\a\\[notes](draft)\\b",
      "C:\\a\\foo)\\.env",
      "C:\\a\\my[1].txt\\.env",
    ]) {
      const { container, unmount } = render(
        <MessageResponse>{path}</MessageResponse>
      )
      await waitFor(() => expect(container.textContent).toBeTruthy())
      expect(container.textContent).toContain(path)
      expect(container.querySelector("em, strong, del, a, button")).toBeNull()
      unmount()
    }
  })

  it("leaves markup the eaten separator already caused (documented limit)", async () => {
    // In `__pycache__` the parser had already made emphasis out of the
    // underscores before this ran. The separator comes back; the `<em>` stays,
    // because reshaping the tree is the freedom this deliberately gives up.
    // Still strictly better than main, which loses the separator too.
    const { container } = render(
      <MessageResponse>{"C:\\repo\\__pycache__\\file.txt"}</MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toBe("C:\\repo\\_pycache_\\file.txt")
  })

  it("does not swallow the markup wrapped AROUND a path", async () => {
    // The closing `_` belongs to the emphasis, not to the file name. Escaping
    // it would leave a stray `_` in the text; the opener inside a run is always
    // escaped, so leaving a trailing one bare cannot mint emphasis either.
    for (const wrapped of ["_C:\\a\\.b_", "*C:\\a\\.b*"]) {
      const { container, unmount } = render(
        <MessageResponse>{wrapped}</MessageResponse>
      )
      await waitFor(() => expect(container.textContent).toBeTruthy())
      expect(container.querySelector("em")).not.toBeNull()
      expect(container.textContent).toBe("C:\\a\\.b")
      unmount()
    }
  })

  it("keeps a link closable whatever parens the destination holds", async () => {
    // The run must leave the link a `)` to close on. An unmatched `(` in the
    // path would eat it under balanced scanning; balanced parens in the path
    // must still stay in the target rather than truncate it at the first `)`.
    for (const source of [
      "[shot](C:\\a\\(draft\\b)",
      "[x](C:\\a(foo)\\b\\.env)",
      "[shot](C:\\a\\.b.png)",
    ]) {
      const { container, unmount } = render(
        <MessageResponse>{source}</MessageResponse>
      )
      await waitFor(() => expect(container.textContent).toBeTruthy())
      expect(container.textContent).not.toContain("](")
      expect(container.querySelector("button, a")).not.toBeNull()
      unmount()
    }
  })

  it("leaves Markdown that merely ABUTS the path working", async () => {
    // A `[` that does not follow a separator belongs to the construct next to
    // the path, not to a file name, so the run stops there and both survive:
    // the separator is restored AND the link/footnote still resolves.
    const link = render(
      <MessageResponse>{"C:\\a\\.b[x](https://e.com)"}</MessageResponse>
    )
    await waitFor(() => expect(link.container.textContent).toBeTruthy())
    expect(link.container.textContent).toContain("C:\\a\\.b")
    expect(link.container.querySelector("button, a")).not.toBeNull()
    link.unmount()

    const footnote = render(
      <MessageResponse>{"C:\\a\\.b[^n]\n\n[^n]: note"}</MessageResponse>
    )
    await waitFor(() => expect(footnote.container.textContent).toBeTruthy())
    expect(footnote.container.textContent).toContain("C:\\a\\.b")
    expect(footnote.container.querySelector("sup")).not.toBeNull()
    footnote.unmount()

    // An image right after a path still renders as an image.
    const image = render(
      <MessageResponse>
        {"C:\\a\\.b![alt](https://placehold.co/20x20.png)"}
      </MessageResponse>
    )
    await waitFor(() => expect(image.container.innerHTML).toBeTruthy())
    expect(image.container.textContent).toContain("C:\\a\\.b")
    expect(image.container.querySelector("img")).not.toBeNull()
    image.unmount()

    // A `/` is not the separator this module restores, so `/[` stays live.
    const slash = render(
      <MessageResponse>{"C:\\a\\.b/[x](https://e.test)"}</MessageResponse>
    )
    await waitFor(() => expect(slash.container.textContent).toBeTruthy())
    expect(slash.container.textContent).toContain("C:\\a\\.b/")
    expect(slash.container.querySelector("button, a")).not.toBeNull()
    slash.unmount()
  })

  it("treats an already-escaped `\\\\` as a literal, like main does", async () => {
    // `\\` is an escaped backslash, so what follows is untouched by the parser
    // on main and has to stay that way here: an image opener stays an opener,
    // and a paren in a destination still balances.
    const image = render(
      <MessageResponse>
        {"C:\\\\![alt](https://placehold.co/20x20.png)"}
      </MessageResponse>
    )
    await waitFor(() => expect(image.container.innerHTML).toBeTruthy())
    expect(image.container.querySelector("img")).not.toBeNull()
    image.unmount()

    const link = render(
      <MessageResponse>{"[a](C:\\\\(foo)\\\\.env)"}</MessageResponse>
    )
    await waitFor(() => expect(link.container.textContent).toBeTruthy())
    expect(link.container.textContent).toBe("a")
    link.unmount()

    const odd = render(<MessageResponse>{"C:\\\\\\.env"}</MessageResponse>)
    await waitFor(() => expect(odd.container.textContent).toBeTruthy())
    expect(odd.container.textContent).toBe("C:\\.env")
    odd.unmount()
  })

  it("keeps a link closable when whitespace follows `](`", async () => {
    const { container } = render(
      <MessageResponse>{"[a]( C:\\a\\(x\\.env)"}</MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toBe("a")
    expect(container.querySelector("button, a")).not.toBeNull()
  })

  it("finds a destination past a `](` that is inside the label", async () => {
    // The label here holds `](` in a code span. Searching for that sequence
    // instead of asking the tree where the label ends rewrote the wrong text
    // and pointed the opener at a different file.
    const { container } = render(
      <MessageResponse>{"[x `](C:\\a\\.b` y](C:\\a.b)"}</MessageResponse>
    )

    const badge = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        "button[data-resource-kind='file']"
      )
      if (!button) throw new Error("expected a clickable file badge")
      return button
    })
    fireEvent.click(badge)
    await waitFor(() => {
      expect(mocks.openFilePreview).toHaveBeenCalledWith("C:/a.b", {
        line: undefined,
      })
    })
  })

  it("does not read a mid-token `\\\\` as a UNC anchor", async () => {
    // `A\\B\_C` renders `A\B_C`; the `\\` is an escaped backslash, not a path.
    const { container } = render(
      <MessageResponse>{"A\\\\B\\_C"}</MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toBe("A\\B_C")
  })

  it("keeps a second link on the line closable", async () => {
    // The destination terminator test must look at the character right after
    // the run, not anywhere later on the line, or the first link loses its `)`.
    const { container } = render(
      <MessageResponse>
        {"[a](C:\\a\\(x) and [b](https://e.test)"}
      </MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toBe("a and b")
    expect(container.querySelectorAll("button, a")).toHaveLength(2)
  })

  it("documents the spaced-path limit", async () => {
    // The one shape still traded away: a path is never followed across
    // whitespace, because a backslash arbitrarily far right would otherwise
    // pull a whole sentence in. So a path with BOTH a space and a
    // punctuation-initial segment keeps the #508 bug, on purpose.
    const { container } = render(
      <MessageResponse>{"C:\\Program Files\\.next\\x"}</MessageResponse>
    )
    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toBe("C:\\Program Files.next\\x")
  })

  it("leaves a prose escape that merely shares a line with a path", async () => {
    // A backslash further right must not be dragged into the run.
    const { container } = render(
      <MessageResponse>
        {"saved to C:\\a\\.b.png and use foo\\_bar"}
      </MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toBe("saved to C:\\a\\.b.png and use foo_bar")
  })

  it("leaves a hard break alone, separator or not (documented limit)", async () => {
    // A `\` at end of line is consumed as a hard break, so it lives in a
    // `break` node. Putting it back would mean deciding that this is a path and
    // not the line break the author asked for, which is not decidable — so the
    // interior separators are restored and the trailing one is left to main.
    const { container } = render(
      <MessageResponse>{"out: C:\\ws\\.pw\\\nnext line"}</MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toContain("out: C:\\ws\\.pw")
    expect(container.querySelector("br")).not.toBeNull()
  })

  it("leaves a still-streaming (unterminated) code fence alone", async () => {
    const { container } = render(
      <MessageResponse>{"```\nC:\\repo\\.pw\\a.png"}</MessageResponse>
    )

    await waitFor(() => expect(container.innerHTML).toBeTruthy())
    expect(container.innerHTML).not.toContain("\\\\")
  })

  it("does not regress ordinary markdown escapes", async () => {
    const { container } = render(
      <MessageResponse>
        {"my\\_var\\_name and \\*not bold\\*\n\n1\\. not a list"}
      </MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toContain("my_var_name and *not bold*")
    expect(container.textContent).toContain("1. not a list")
    expect(container.querySelector("em")).toBeNull()
  })

  it("keeps an escape working on the same line as a path", async () => {
    const { container } = render(
      <MessageResponse>
        {"saved to C:\\a\\.b.png and use \\_ to escape"}
      </MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toBe(
      "saved to C:\\a\\.b.png and use _ to escape"
    )
  })

  it("leaves a path inside a code fence exactly as written", async () => {
    const { container } = render(
      <MessageResponse>
        {["```", "C:\\repo\\.playwright-cli\\a.png", "```"].join("\n")}
      </MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toContain("C:\\repo\\.playwright-cli\\a.png")
  })

  it("renders an already-escaped path without showing the escapes", async () => {
    const { container } = render(
      <MessageResponse>{"C:\\\\Users\\\\.gitconfig"}</MessageResponse>
    )

    await waitFor(() => expect(container.textContent).toBeTruthy())
    expect(container.textContent).toBe("C:\\Users\\.gitconfig")
  })
})
