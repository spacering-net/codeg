import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  CommitUntrackedFilesDialog,
  MAX_LISTED_UNTRACKED_FILES,
} from "./commit-untracked-files-dialog"

type Props = Parameters<typeof CommitUntrackedFilesDialog>[0]

function dialog(props: Partial<Props> = {}) {
  const full: Props = {
    files: ["a.ts", "b.ts", "c.ts"],
    excluded: new Set(),
    hasTrackedChanges: true,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...props,
  }
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CommitUntrackedFilesDialog {...full} />
    </NextIntlClientProvider>
  )
}

const box = (name: string) => screen.getByRole("checkbox", { name })
const confirmButton = () => screen.getByRole("button", { name: "Generate" })

describe("CommitUntrackedFilesDialog", () => {
  it("starts with every file checked but the ones left out before", () => {
    render(dialog({ excluded: new Set(["b.ts"]) }))

    expect(screen.getByText("Commit untracked files too?")).toBeInTheDocument()
    expect(box("a.ts")).toHaveAttribute("aria-checked", "true")
    expect(box("b.ts")).toHaveAttribute("aria-checked", "false")
    expect(box("c.ts")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("2 / 3 files selected")).toBeInTheDocument()
  })

  it("hands over the checked files in the order they were offered", () => {
    const onConfirm = vi.fn()
    render(dialog({ excluded: new Set(["b.ts"]), onConfirm }))

    fireEvent.click(box("a.ts"))
    fireEvent.click(box("b.ts"))
    fireEvent.click(confirmButton())

    expect(onConfirm).toHaveBeenCalledWith(["b.ts", "c.ts"])
  })

  it("puts focus on the confirm button, so Enter takes the files as offered", () => {
    render(dialog())
    expect(confirmButton()).toHaveFocus()
  })

  it("needs a checked file when there is nothing else to describe", () => {
    const { rerender } = render(dialog({ hasTrackedChanges: false }))
    fireEvent.click(screen.getByRole("button", { name: "Unselect all" }))
    expect(confirmButton()).toBeDisabled()

    // With tracked changes, checking nothing still describes those.
    rerender(dialog({ hasTrackedChanges: true }))
    expect(confirmButton()).toBeEnabled()
  })

  it("lists a long offer in part, while select all covers every file", () => {
    const files = Array.from(
      { length: MAX_LISTED_UNTRACKED_FILES + 20 },
      (_, i) => `gen/${String(i).padStart(4, "0")}.js`
    )
    const onConfirm = vi.fn()
    render(dialog({ files, onConfirm }))

    expect(screen.getAllByRole("checkbox")).toHaveLength(
      MAX_LISTED_UNTRACKED_FILES
    )
    fireEvent.click(screen.getByRole("button", { name: "Unselect all" }))
    expect(
      screen.getByText(`0 / ${files.length} files selected`)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show 20 more files" }))
    const boxes = screen.getAllByRole("checkbox")
    expect(boxes).toHaveLength(files.length)
    expect(boxes[boxes.length - 1]).toHaveAttribute("aria-checked", "false")

    fireEvent.click(screen.getByRole("button", { name: "Select all" }))
    fireEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledWith(files)
  })

  it("reports a cancel from the button and from Escape", () => {
    const onCancel = vi.fn()
    render(dialog({ onCancel }))

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(confirmButton(), { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it("starts each opening afresh", () => {
    const { rerender } = render(dialog())
    fireEvent.click(box("a.ts"))
    expect(box("a.ts")).toHaveAttribute("aria-checked", "false")

    rerender(dialog({ files: null }))
    rerender(dialog({ files: ["a.ts", "d.ts"] }))
    expect(box("a.ts")).toHaveAttribute("aria-checked", "true")
    expect(box("d.ts")).toHaveAttribute("aria-checked", "true")
    expect(screen.queryByRole("checkbox", { name: "b.ts" })).toBeNull()
  })
})
