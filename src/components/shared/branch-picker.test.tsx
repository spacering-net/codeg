import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useState, type ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"

const branchesMock = vi.fn()
const headMock = vi.fn()

vi.mock("@/lib/api", () => ({
  gitListAllBranches: (...args: unknown[]) => branchesMock(...args),
  getGitBranch: (...args: unknown[]) => headMock(...args),
}))

import { BranchPicker } from "./branch-picker"

function withIntl(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

/** An unpicked picker whose default follows HEAD, as the task editor's does. */
function headPicker(folderPath: string | null) {
  return withIntl(
    <BranchPicker
      folderPath={folderPath}
      value=""
      onChange={vi.fn()}
      defaultFollowsHead
      defaultLabel="Current branch when the task starts"
      title="Base branch"
      allowRemote={false}
    />
  )
}

/** The same picker holding its own value, as a real caller does. */
function ControlledHeadPicker({
  initial,
  spy,
}: {
  initial: string
  spy: (branch: string, isRemote: boolean) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <BranchPicker
      folderPath="/repo"
      value={value}
      onChange={(branch, isRemote) => {
        spy(branch, isRemote)
        setValue(branch)
      }}
      defaultFollowsHead
      defaultLabel="Current branch when the task starts"
      title="Base branch"
      allowRemote={false}
    />
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const trigger = () => screen.getByRole("button", { name: "Base branch" })
const headEntry = () => screen.findByRole("option", { name: /^HEAD/ })

beforeEach(() => {
  branchesMock.mockReset().mockResolvedValue({
    local: ["main", "feature"],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  })
  headMock.mockReset().mockResolvedValue("main")
})

describe("BranchPicker with a default that follows HEAD", () => {
  it("reads HEAD beside the branch HEAD is on, before the list is opened", async () => {
    render(headPicker("/repo"))

    await waitFor(() =>
      expect(within(trigger()).getByText("main")).toBeInTheDocument()
    )
    expect(within(trigger()).getByText("HEAD")).toBeInTheDocument()
    expect(headMock).toHaveBeenCalledWith("/repo")
    // Only HEAD is read up front; the branch list still waits for an open.
    expect(branchesMock).not.toHaveBeenCalled()
  })

  it("the list's default entry reads the same, with the caller's wording as its tooltip", async () => {
    const user = userEvent.setup()
    render(headPicker("/repo"))

    await user.click(trigger())
    const entry = await headEntry()

    expect(entry).toHaveTextContent(/^HEAD\s*main$/)
    expect(entry).toHaveAttribute(
      "title",
      "Current branch when the task starts"
    )
    expect(screen.queryByText("Current branch when the task starts")).toBeNull()
  })

  it("re-reads HEAD when the list opens, since the checkout may have moved", async () => {
    const user = userEvent.setup()
    headMock.mockResolvedValueOnce("main").mockResolvedValueOnce("feature")
    render(headPicker("/repo"))
    await waitFor(() => expect(trigger()).toHaveTextContent("main"))

    await user.click(trigger())

    const entry = await headEntry()
    await waitFor(() => expect(entry).toHaveTextContent("feature"))
    expect(headMock).toHaveBeenCalledTimes(2)
  })

  it("names no branch when HEAD is detached or unreadable", async () => {
    headMock.mockResolvedValueOnce(null)
    const { unmount } = render(headPicker("/detached"))
    await waitFor(() => expect(headMock).toHaveBeenCalledWith("/detached"))
    await act(async () => {})
    expect(trigger()).toHaveTextContent(/^HEAD$/)
    unmount()

    headMock.mockRejectedValueOnce(new Error("not a git repository"))
    render(headPicker("/plain"))
    await waitFor(() => expect(headMock).toHaveBeenCalledWith("/plain"))
    await act(async () => {})
    expect(trigger()).toHaveTextContent(/^HEAD$/)
  })

  it("never shows the previous folder's branch while the new folder's read is in flight", async () => {
    const { rerender } = render(headPicker("/a"))
    await waitFor(() => expect(trigger()).toHaveTextContent("main"))

    const pending = deferred<string | null>()
    headMock.mockReturnValueOnce(pending.promise)
    rerender(headPicker("/b"))

    expect(trigger()).toHaveTextContent(/^HEAD$/)
    await act(async () => pending.resolve("develop"))
    expect(trigger()).toHaveTextContent(/^HEAD\s*develop$/)
    expect(headMock).toHaveBeenLastCalledWith("/b")
  })

  it("drops a late answer about the folder it has since left", async () => {
    const stale = deferred<string | null>()
    headMock.mockReturnValueOnce(stale.promise)
    const { rerender } = render(headPicker("/a"))

    headMock.mockResolvedValueOnce("develop")
    rerender(headPicker("/b"))
    await waitFor(() => expect(trigger()).toHaveTextContent("develop"))

    await act(async () => stale.resolve("main"))
    expect(trigger()).toHaveTextContent(/^HEAD\s*develop$/)
  })

  it("a picked branch shows by name, and picking HEAD returns to the default", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(withIntl(<ControlledHeadPicker initial="feature" spy={onChange} />))

    expect(trigger()).toHaveTextContent(/^feature$/)
    // Nothing on screen needs HEAD until the list opens.
    expect(headMock).not.toHaveBeenCalled()

    await user.click(trigger())
    await user.click(await headEntry())

    expect(onChange).toHaveBeenCalledWith("", false)
    // Back on the default, the trigger reads HEAD again, with its branch.
    await waitFor(() => expect(trigger()).toHaveTextContent(/^HEAD\s*main$/))
  })

  it("searching HEAD keeps the entry and never offers HEAD as a branch name", async () => {
    const user = userEvent.setup()
    render(headPicker("/repo"))

    await user.click(trigger())
    await headEntry()
    await user.type(screen.getByPlaceholderText("Search branches…"), "HEAD")

    expect(screen.getByRole("option", { name: /^HEAD/ })).toBeInTheDocument()
    expect(screen.queryByText('Use "HEAD"')).toBeNull()
  })
})

describe("BranchPicker with a caller-worded default", () => {
  it("keeps the placeholder and the caller's entry, and never reads HEAD", async () => {
    const user = userEvent.setup()
    render(
      withIntl(
        <BranchPicker
          folderPath="/repo"
          value=""
          onChange={vi.fn()}
          placeholder="(default branch)"
          defaultLabel="Default branch"
          title="Branch"
        />
      )
    )

    const button = screen.getByRole("button", { name: "Branch" })
    expect(button).toHaveTextContent(/^\(default branch\)$/)

    await user.click(button)
    expect(
      await screen.findByRole("option", { name: "Default branch" })
    ).toBeInTheDocument()
    expect(screen.queryByText("HEAD")).toBeNull()
    expect(headMock).not.toHaveBeenCalled()
  })
})
