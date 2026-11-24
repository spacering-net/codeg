/**
 * Opening an issue from the panel.
 *
 * This publishes to somebody else's repository, so what matters is: nothing
 * goes out until the button is pressed, a title is required, the description
 * is OMITTED rather than sent blank, and what was typed survives a failure.
 * The row that comes back is the forge's — it carries the number and the URL,
 * which only exist once the issue has been written.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ForgeIssueRow, ForgeLabel } from "@/lib/types"

import {
  ForgeNewIssueDialog,
  MAX_ISSUE_TITLE_CHARS,
} from "./forge-new-issue-dialog"

const forgeCreateIssue = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({ forgeCreateIssue }))

function created(overrides: Partial<ForgeIssueRow> = {}): ForgeIssueRow {
  return {
    number: 123,
    title: "Login times out",
    body: "steps",
    state: "open",
    draft: false,
    labels: [],
    author: "octocat",
    author_avatar: "https://avatars.githubusercontent.com/u/583231",
    updated_at: null,
    html_url: "https://github.com/o/r/issues/123",
    is_pr: false,
    comments: 0,
    ...overrides,
  }
}

function mount(labelOptions: ForgeLabel[] = []) {
  const onOpenChange = vi.fn()
  const onCreated = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeNewIssueDialog
        open
        folderId={7}
        repo="acme/app"
        labelOptions={labelOptions}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    </NextIntlClientProvider>
  )
  return { onOpenChange, onCreated }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ForgeNewIssueDialog", () => {
  it("names the repository it will publish to", () => {
    mount()
    expect(screen.getByText(/acme\/app/)).toBeInTheDocument()
  })

  it("will not create without a title", async () => {
    const user = userEvent.setup()
    mount()
    const submit = screen.getByRole("button", { name: "Create issue" })
    expect(submit).toBeDisabled()
    // Whitespace is not a title — both forges answer 422 with a message the
    // author cannot act on, and this dialog can say so first.
    await user.type(screen.getByLabelText("Title"), "   ")
    expect(submit).toBeDisabled()
    expect(forgeCreateIssue).not.toHaveBeenCalled()
  })

  it("refuses a title past the forge's own cap", () => {
    mount()
    // Set in ONE event rather than typed. `user.type` sends a keystroke per
    // character with its own await, so 256 of them took the whole 5s budget on
    // an idle machine and blew straight past it under a full-suite run — where
    // the timeout then abandoned the loop mid-type and left it typing into a
    // detached input, failing the case AFTER it too. Nothing here is about the
    // typing; the threshold is.
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "t".repeat(MAX_ISSUE_TITLE_CHARS + 1) },
    })
    expect(screen.getByRole("button", { name: "Create issue" })).toBeDisabled()
    // The counter only appears near the limit, where it is the one thing that
    // explains the refusal.
    expect(
      screen.getByText(
        `${MAX_ISSUE_TITLE_CHARS + 1} / ${MAX_ISSUE_TITLE_CHARS}`
      )
    ).toBeInTheDocument()
  })

  it("sends the trimmed title, the labels, and no body when there is none", async () => {
    const user = userEvent.setup()
    forgeCreateIssue.mockResolvedValue(created())
    const { onCreated } = mount([{ name: "bug", color: "#d73a4a" }])

    await user.type(screen.getByLabelText("Title"), "  Login times out  ")
    await user.click(screen.getByRole("button", { name: /bug/ }))
    await user.click(screen.getByRole("button", { name: "Create issue" }))

    await waitFor(() =>
      expect(forgeCreateIssue).toHaveBeenCalledWith(7, {
        title: "Login times out",
        // Null, not "": GitHub stores an empty string as a body and the issue
        // then renders an empty description block.
        body: null,
        labels: ["bug"],
      })
    )
    // The forge's row — the number and the URL only exist once it is written.
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ number: 123 })
    )
  })

  it("keeps what was typed when the create fails", async () => {
    const user = userEvent.setup()
    forgeCreateIssue.mockRejectedValue(new Error("issues are disabled"))
    const { onCreated } = mount()

    const title = screen.getByLabelText("Title")
    await user.type(title, "Login times out")
    await user.type(screen.getByLabelText("Description"), "steps")
    await user.click(screen.getByRole("button", { name: "Create issue" }))

    expect(await screen.findByText("issues are disabled")).toBeInTheDocument()
    expect(title).toHaveValue("Login times out")
    expect(screen.getByLabelText("Description")).toHaveValue("steps")
    expect(onCreated).not.toHaveBeenCalled()
  })

  it("offers no label control when the repository has none", () => {
    mount([])
    // A picker that can only ever open an empty list is worse than no picker.
    expect(screen.queryByText("Labels")).not.toBeInTheDocument()
  })
})

/**
 * The Enter that confirms an IME candidate is the same Enter that submits
 * here. Without a guard, typing a Chinese/Japanese/Korean title and picking a
 * candidate files the issue with whatever the field held BEFORE the
 * composition resolved — an external write to somebody else's repository,
 * triggered by a keystroke that meant "yes, that character".
 */
describe("ForgeNewIssueDialog IME", () => {
  it("does not submit on the Enter that confirms a composition", async () => {
    const user = userEvent.setup()
    forgeCreateIssue.mockResolvedValue(created())
    mount()
    const title = screen.getByLabelText("Title")

    // Mid-composition: the candidate window is open over a half-typed title.
    await user.type(title, "deng")
    fireEvent.compositionStart(title)
    fireEvent.keyDown(title, { key: "Enter" })
    expect(forgeCreateIssue).not.toHaveBeenCalled()

    // WebKit's confirming keydown carries no composition flag of its own —
    // only the legacy 229 code — and can arrive after `compositionend`.
    fireEvent.compositionEnd(title)
    fireEvent.keyDown(title, { key: "Enter", keyCode: 229 })
    expect(forgeCreateIssue).not.toHaveBeenCalled()

    // The NEXT Enter is the one that meant it.
    fireEvent.keyDown(title, { key: "Enter" })
    await waitFor(() => expect(forgeCreateIssue).toHaveBeenCalledTimes(1))
  })
})
