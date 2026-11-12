import { cleanup, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

// The agent icon renders inline SVG with a <title> that would duplicate the
// agent label text; stub it so text queries stay unambiguous (same reason as
// `session-details-dialog.test.tsx`).
vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => null,
}))

import { SidebarConversationHoverDetails } from "./sidebar-conversation-hover-details"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

const CREATED_AT = "2026-03-01T10:00:00.000Z"
const UPDATED_AT = "2026-03-02T11:30:00.000Z"

function conv(
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 7,
    folder_id: 1,
    title: "Wire up the parser",
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 3,
    child_count: 0,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    pinned_at: null,
    ...overrides,
  }
}

function folder(overrides: Partial<FolderDetail> = {}): FolderDetail {
  return {
    id: 1,
    name: "codeg",
    path: "/Users/dev/projects/codeg",
    git_branch: null,
    default_agent_type: null,
    last_opened_at: CREATED_AT,
    sort_order: 0,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...overrides,
  }
}

function seed({
  folders = [folder()],
  branches = new Map<number, string | null>(),
}: {
  folders?: FolderDetail[]
  branches?: Map<number, string | null>
} = {}) {
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({ allFolders: folders, branches })
}

function renderBubble(conversation: DbConversationSummary) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SidebarConversationHoverDetails conversation={conversation} />
    </NextIntlClientProvider>
  )
}

/**
 * The rendered value of the field carrying `label`. Read through the DOM rather
 * than with `getByText` because several values are split across elements — the
 * alias label colors its `[ name ]` segment separately, and every technical
 * identifier sits in its own `dir="ltr"` span. The label is matched on the
 * `<dt>`'s leading text node rather than its whole content, since a `<dt>` may
 * also carry a trailing badge ("Folder" + "Worktree").
 */
function fieldValue(label: string): string {
  const dt = Array.from(document.querySelectorAll("dt")).find(
    (el) => el.firstChild?.textContent === label
  )
  return dt?.parentElement?.querySelector("dd")?.textContent ?? ""
}

afterEach(() => {
  // Unmount first: the reset is a zustand write, and a bubble still mounted
  // when it lands would re-render outside `act()`.
  cleanup()
  resetAppWorkspaceStore()
})

describe("SidebarConversationHoverDetails", () => {
  it("shows the full title with the agent chip", () => {
    seed()
    renderBubble(conv())

    expect(screen.getByText("Wire up the parser")).toBeDefined()
    expect(screen.getByText("Claude Code")).toBeDefined()
  })

  // The row the bubble hangs off already badges running and cancelled, so the
  // chip only repeated what the pointer was resting on. The dialog keeps it.
  it("does not show the status chip", () => {
    seed()
    renderBubble(conv({ status: "in_progress" }))

    expect(screen.queryByText("In Progress")).toBeNull()
  })

  it("names the folder and shows its absolute path", () => {
    seed()
    renderBubble(conv())

    expect(fieldValue("Folder")).toBe("codeg")
    expect(fieldValue("Path")).toBe("/Users/dev/projects/codeg")
  })

  it("renders an aliased folder as `alias [ name ]`", () => {
    seed({ folders: [folder({ alias: "My Project" })] })
    renderBubble(conv())

    expect(fieldValue("Folder")).toBe("My Project [ codeg ]")
  })

  // Paths, branches, and model ids read left-to-right in every locale; without
  // this an RTL document reorders the leading `/` to the end.
  it("pins technical identifiers to dir=ltr", () => {
    seed()
    const { container } = renderBubble(
      conv({ git_branch: "feature/x", model: "claude-opus-5" })
    )

    const ltr = Array.from(container.querySelectorAll('[dir="ltr"]')).map(
      (el) => el.textContent
    )
    // Document order, so this doubles as the pin on the layout: the model chip
    // sits above the field list, and within it branch comes before path.
    expect(ltr).toEqual([
      "claude-opus-5",
      "feature/x",
      "/Users/dev/projects/codeg",
    ])
  })

  // Radix keeps a hover card open while a document selection exists, and only
  // clears that latch when the content unmounts — which it can't, because it
  // won't close. In a list of rows that strands the bubble. jsdom has no
  // selection model or layout, so the guards are pinned as the CSS contract they
  // are; the behaviour itself was verified in a real browser.
  it("makes the bubble unselectable", () => {
    seed()
    const { container } = renderBubble(conv())

    expect(container.firstElementChild?.className).toContain("select-none")
  })

  // On the label, not the value: a worktree directory name is long enough that
  // a trailing badge would routinely wrap onto a line of its own.
  it("badges a worktree folder on the field label", () => {
    seed({ folders: [folder({ parent_id: 42, name: "wt" })] })
    renderBubble(conv())

    const badge = screen.getByText("Worktree")
    expect(badge.closest("dt")).not.toBeNull()
    expect(fieldValue("Folder")).toBe("wt")
  })

  it("does not badge a top-level folder", () => {
    seed()
    renderBubble(conv())

    expect(screen.queryByText("Worktree")).toBeNull()
  })

  it("falls back to an em dash when the folder is not in the store", () => {
    // A conversation whose folder was removed from the workspace: the store has
    // no row for it, but the bubble must still render rather than blank out.
    seed({ folders: [] })
    renderBubble(conv())

    expect(fieldValue("Folder")).toBe("—")
    expect(fieldValue("Path")).toBe("—")
  })

  it("prefers the branch the conversation was started on", () => {
    // The folder has since been switched to `main`; the row still describes the
    // session, which ran on `feature/x`.
    seed({ branches: new Map([[1, "main"]]) })
    renderBubble(conv({ git_branch: "feature/x" }))

    expect(fieldValue("Git Branch")).toBe("feature/x")
  })

  it("falls back to the folder's live branch when the conversation has none", () => {
    seed({ branches: new Map([[1, "main"]]) })
    renderBubble(conv({ git_branch: null }))

    expect(fieldValue("Git Branch")).toBe("main")
  })

  it("shows an em dash when neither the conversation nor the folder has a branch", () => {
    seed()
    renderBubble(conv({ git_branch: null }))

    expect(fieldValue("Git Branch")).toBe("—")
  })

  // The bubble answers "where does this session live", not "when did it run".
  // The timestamps are still in the right-click Session Details dialog.
  it("does not show the created/updated timestamps", () => {
    seed()
    renderBubble(conv())

    expect(screen.queryByText("Created")).toBeNull()
    expect(screen.queryByText("Updated")).toBeNull()
    // And no formatted timestamp under any label. Matched on a clock time
    // rather than on the date text, which `dateStyle: "short"` renders in the
    // runner's own timezone (and with a two-digit year).
    expect(document.body.textContent).not.toMatch(/\d{1,2}:\d{2}/)
  })

  // The model reads as a chip beside the agent, not as a labelled field: there
  // is no "Model" label anywhere in the bubble now.
  it("shows the model as a chip beside the agent", () => {
    seed()
    renderBubble(conv({ model: "claude-opus-5" }))

    expect(screen.getByText("claude-opus-5")).toBeDefined()
    expect(screen.queryByText("Model")).toBeNull()
    // Beside the agent rather than down in the field list.
    expect(screen.getByText("claude-opus-5").closest("dl")).toBeNull()

    // Punctuation between two labels, not content, so it stays out of the a11y
    // tree — and it shares one flex item with the model name, which is what
    // keeps a wrapping model id from stranding it on the line above.
    const dot = screen.getByText("·")
    expect(dot.getAttribute("aria-hidden")).toBe("true")
    expect(dot.parentElement?.textContent).toBe("·claude-opus-5")
  })

  it("omits the model chip and its separator when no model is recorded", () => {
    seed()
    renderBubble(conv({ model: null }))

    expect(screen.queryByText("Model")).toBeNull()
    expect(screen.queryByText("claude-opus-5")).toBeNull()
    expect(screen.queryByText("·")).toBeNull()
  })

  it("shows the original path when the source worktree was removed", () => {
    seed()
    renderBubble(conv({ origin_cwd: "/Users/dev/projects/codeg-feature-x" }))

    expect(fieldValue("Original working directory")).toBe(
      "/Users/dev/projects/codeg-feature-x"
    )
  })

  it("omits the removed-worktree row for an ordinary conversation", () => {
    seed()
    renderBubble(conv())

    expect(screen.queryByText("Original working directory")).toBeNull()
  })
})
