/**
 * The chip list behind auto-processing's rule lists. What it must never do is
 * lose or double what was typed: Enter, a comma and leaving the field all
 * commit, a pasted list becomes several chips, and a pattern already there in
 * another case is not added twice (the rules match case-insensitively).
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { PatternListInput } from "./pattern-list-input"

function Harness({
  initial = [] as string[],
  onChange,
}: {
  initial?: string[]
  onChange?: (next: string[]) => void
}) {
  const [values, setValues] = useState(initial)
  return (
    <PatternListInput
      values={values}
      onChange={(next) => {
        setValues(next)
        onChange?.(next)
      }}
      ariaLabel="Labels"
      placeholder="Label or pattern"
      removeLabel={(p) => `Remove ${p}`}
    />
  )
}

const input = () =>
  screen.getByRole("textbox", { name: "Labels" }) as HTMLInputElement
const chips = () =>
  screen
    .queryAllByRole("button", { name: /^Remove / })
    .map((b) => b.getAttribute("aria-label")!.replace(/^Remove /, ""))

describe("PatternListInput", () => {
  it("turns Enter and commas into chips", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(input(), "bug{Enter}")
    await user.type(input(), "area/*,needs-triage,")
    expect(chips()).toEqual(["bug", "area/*", "needs-triage"])
    expect(input()).toHaveValue("")
  })

  it("adds every entry of a pasted list and drops case-insensitive repeats", async () => {
    const user = userEvent.setup()
    render(<Harness initial={["Bug"]} />)

    await user.click(input())
    await user.paste("bug, wontfix\n*[bot]\n\n")
    expect(chips()).toEqual(["Bug", "wontfix", "*[bot]"])
  })

  /** A pasted list lands where the browser would have put the text: over
   *  the selection. Gluing it onto a selected draft would turn the first
   *  entry into a pattern nobody wrote. */
  it("replaces a selected draft with a pasted list", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(input(), "wontfix")
    input().setSelectionRange(0, input().value.length)
    await user.paste("security\n*[bot]")
    expect(chips()).toEqual(["security", "*[bot]"])
    expect(input()).toHaveValue("")
  })

  it("pastes a list into the middle of a draft at the caret", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(input(), "areaui")
    input().setSelectionRange(4, 4)
    await user.paste("/x,y/")
    expect(chips()).toEqual(["area/x", "y/ui"])
  })

  /** The dialog's Save takes focus before it is clicked — typed text must
   *  not be thrown away on the way there. */
  it("commits what was typed when the field loses focus", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.type(input(), "  docs  ")
    await user.tab()
    expect(chips()).toEqual(["docs"])
    expect(onChange).toHaveBeenLastCalledWith(["docs"])
  })

  it("removes a chip by its button, and the last one by Backspace", async () => {
    const user = userEvent.setup()
    render(<Harness initial={["a", "b", "c"]} />)

    await user.click(screen.getByRole("button", { name: "Remove b" }))
    expect(chips()).toEqual(["a", "c"])
    await user.click(input())
    await user.keyboard("{Backspace}")
    expect(chips()).toEqual(["a"])
  })

  /** Backspace only takes a chip back when there is no text to delete. */
  it("leaves the chips alone while there is text to delete", async () => {
    const user = userEvent.setup()
    render(<Harness initial={["a"]} />)

    await user.type(input(), "xy{Backspace}")
    expect(input()).toHaveValue("x")
    expect(chips()).toEqual(["a"])
  })

  /** Enter while an input method is composing picks a candidate (Chinese,
   *  Japanese…); it must not end the chip half-written. */
  it("ignores Enter while an IME is composing", () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.change(input(), { target: { value: "优先级" } })
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true })
    expect(onChange).not.toHaveBeenCalled()
    expect(input()).toHaveValue("优先级")

    fireEvent.keyDown(input(), { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith(["优先级"])
  })

  it("adds nothing for blank input", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.type(input(), "   {Enter}")
    await user.type(input(), ",,{Enter}")
    expect(onChange).not.toHaveBeenCalled()
  })
})
