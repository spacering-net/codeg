import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { OpenCodePermissionsSection } from "./opencode-permissions-section"

/**
 * The section is controlled, so the harness owns `configText` and exposes the
 * latest value the same way the settings page does — through its draft.
 */
function Harness({
  initial,
  onText,
  disabled,
}: {
  initial: string
  onText: (value: string) => void
  disabled?: boolean
}) {
  const [configText, setConfigText] = useState(initial)
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <OpenCodePermissionsSection
        configText={configText}
        disabled={disabled}
        onChange={(next) => {
          setConfigText(next)
          onText(next)
        }}
      />
    </NextIntlClientProvider>
  )
}

function setup(initial = "", disabled = false) {
  const seen: string[] = []
  render(
    <Harness
      initial={initial}
      disabled={disabled}
      onText={(value) => seen.push(value)}
    />
  )
  const latest = () => seen[seen.length - 1] ?? initial
  const doc = () => JSON.parse(latest() || "{}")
  return {
    latest,
    doc,
    permissions: () => doc().permissions,
    changes: () => seen.length,
  }
}

const rule = (action: string, resource: string, effect: string) => ({
  action,
  resource,
  effect,
})

const autoAcceptName = "Auto-accept every permission"
const shellRulesName = "Fine-grained rules for shell"
const autoAccept = () => screen.getByRole("switch", { name: autoAcceptName })

describe("OpenCodePermissionsSection", () => {
  it("lists every documented permission action", () => {
    setup()
    for (const key of [
      "shell",
      "edit",
      "read",
      "external_directory",
      "subagent",
      "skill",
      "webfetch",
      "websearch",
      "glob",
      "grep",
      "execute",
      "question",
      "todowrite",
    ]) {
      expect(screen.getByText(key)).toBeInTheDocument()
    }
  })

  it("turning auto-accept on writes one allow-all rule", () => {
    const harness = setup()
    expect(autoAccept()).toHaveAttribute("data-state", "unchecked")
    fireEvent.click(autoAccept())
    expect(harness.permissions()).toEqual([rule("*", "*", "allow")])
    expect(autoAccept()).toHaveAttribute("data-state", "checked")
  })

  it("auto-accept replaces 1.x rules that would still prompt", () => {
    const harness = setup(
      JSON.stringify({
        model: "anthropic/claude",
        permission: { "*": "ask", bash: { "rm *": "deny" } },
      })
    )
    expect(autoAccept()).toHaveAttribute("data-state", "unchecked")
    fireEvent.click(autoAccept())
    expect(harness.permissions()).toEqual([rule("*", "*", "allow")])
    expect(harness.doc().permission).toBeUndefined()
    expect(harness.doc().model).toBe("anthropic/claude")
  })

  it("turning auto-accept off only drops the global rule", () => {
    const harness = setup(
      JSON.stringify({
        permissions: [rule("*", "*", "allow"), rule("edit", "*", "allow")],
      })
    )
    fireEvent.click(autoAccept())
    expect(harness.permissions()).toEqual([rule("edit", "*", "allow")])
  })

  it("adds, edits and deletes a fine-grained rule", () => {
    const harness = setup()
    fireEvent.click(screen.getByRole("button", { name: shellRulesName }))
    expect(screen.getByText("No fine-grained rules yet.")).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText("git *"), {
      target: { value: "rm *" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }))
    expect(harness.permissions()).toEqual([rule("shell", "rm *", "allow")])

    // The saved rule now owns the first input; the draft row is the second.
    const inputs = screen.getAllByPlaceholderText("git *")
    fireEvent.change(inputs[0], { target: { value: "rm -rf *" } })
    expect(harness.permissions()).toEqual([rule("shell", "rm -rf *", "allow")])

    fireEvent.click(
      screen.getByRole("button", { name: "Delete rule rm -rf *" })
    )
    expect(harness.permissions()).toBeUndefined()
  })

  it("rewrites 1.x rules as permissions on the next edit", () => {
    const harness = setup(
      JSON.stringify({ permission: { bash: { "git *": "allow" } } })
    )
    expect(screen.getByText(/These rules come from OpenCode 1/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: shellRulesName }))
    const inputs = screen.getAllByPlaceholderText("git *")
    fireEvent.change(inputs[inputs.length - 1], { target: { value: "rm *" } })
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }))

    expect(harness.doc().permission).toBeUndefined()
    expect(harness.permissions()).toEqual([
      rule("shell", "git *", "allow"),
      rule("shell", "rm *", "allow"),
    ])
    expect(
      screen.queryByText(/These rules come from OpenCode 1/)
    ).not.toBeInTheDocument()
  })

  it("keeps the row when a pattern is cleared, and reverts on blur", () => {
    const harness = setup(
      JSON.stringify({ permissions: [rule("shell", "git *", "allow")] })
    )
    fireEvent.click(screen.getByRole("button", { name: shellRulesName }))
    const input = screen.getAllByPlaceholderText("git *")[0]

    fireEvent.change(input, { target: { value: "" } })
    // Still one saved rule; only the in-flight text went blank.
    expect(harness.permissions()).toEqual([rule("shell", "git *", "allow")])
    expect(input).toHaveValue("")
    expect(
      screen.getByText(
        "A rule needs a pattern — use the trash icon to remove it."
      )
    ).toBeInTheDocument()

    fireEvent.blur(input)
    expect(screen.getAllByPlaceholderText("git *")[0]).toHaveValue("git *")
  })

  // Keying the row by its pattern used to remount the input on every accepted
  // keystroke, so a multi-character edit was impossible without refocusing.
  it("keeps focus on the pattern input across keystrokes", () => {
    const harness = setup(
      JSON.stringify({ permissions: [rule("shell", "g", "allow")] })
    )
    fireEvent.click(screen.getByRole("button", { name: shellRulesName }))
    const input = screen.getAllByPlaceholderText("git *")[0]
    input.focus()
    expect(document.activeElement).toBe(input)

    for (const value of ["gi", "git", "git ", "git *"]) {
      fireEvent.change(document.activeElement!, { target: { value } })
      expect(document.activeElement).toBe(input)
    }
    expect(harness.permissions()).toEqual([rule("shell", "git *", "allow")])
  })

  it("refuses to retype a pattern onto one the action already has", () => {
    const harness = setup(
      JSON.stringify({
        permissions: [
          rule("shell", "git *", "allow"),
          rule("shell", "rm *", "deny"),
        ],
      })
    )
    fireEvent.click(screen.getByRole("button", { name: shellRulesName }))
    const input = screen.getAllByPlaceholderText("git *")[1]

    fireEvent.change(input, { target: { value: "git *" } })
    expect(harness.permissions()).toEqual([
      rule("shell", "git *", "allow"),
      rule("shell", "rm *", "deny"),
    ])
    expect(screen.getByText("That pattern already exists.")).toBeInTheDocument()
  })

  it("refuses to add a pattern the action already has", () => {
    setup(JSON.stringify({ permissions: [rule("shell", "git *", "allow")] }))
    fireEvent.click(screen.getByRole("button", { name: shellRulesName }))
    const inputs = screen.getAllByPlaceholderText("git *")
    fireEvent.change(inputs[inputs.length - 1], {
      target: { value: "git *" },
    })
    expect(screen.getByRole("button", { name: /Add rule/ })).toBeDisabled()
    expect(screen.getByText("That pattern already exists.")).toBeInTheDocument()
  })

  it("shows a rule count badge for actions that carry patterns", () => {
    setup(
      JSON.stringify({
        permissions: [
          rule("shell", "*", "ask"),
          rule("shell", "git *", "allow"),
          rule("shell", "rm *", "deny"),
        ],
      })
    )
    expect(screen.getByText("rules: 2")).toBeInTheDocument()
  })

  it("surfaces permission actions that are not built-in tools", () => {
    setup(JSON.stringify({ permissions: [rule("my-mcp_tool", "*", "deny")] }))
    expect(
      screen.getByText("Other permission actions in the file")
    ).toBeInTheDocument()
    expect(screen.getByText("my-mcp_tool")).toBeInTheDocument()
  })

  it("pauses editing when the surrounding JSON cannot be parsed", () => {
    setup("{ not json")
    expect(
      screen.getByText(
        "The native JSON below is not valid, so the visual editor is paused. Fix the JSON to resume."
      )
    ).toBeInTheDocument()
    expect(autoAccept()).toBeDisabled()
  })

  it("warns instead of guessing when the rules have an unknown shape", () => {
    setup(JSON.stringify({ permissions: "allow" }))
    expect(
      screen.getByText(
        "The permission rules have a shape codeg does not recognize. Edit them in the native JSON below, or use Reset to start over."
      )
    ).toBeInTheDocument()
    expect(autoAccept()).toBeDisabled()
    // Reset stays live — it is the only repair the visual editor can offer.
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled()
  })

  it("pauses the rows while the rules are out of order, until Fix order", () => {
    const harness = setup(
      JSON.stringify({
        permissions: [rule("shell", "*", "deny"), rule("*", "*", "allow")],
      })
    )
    expect(
      screen.getByText(/not written in the order shown below/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Editing below is paused until the order is fixed/)
    ).toBeInTheDocument()
    // It must not read as auto-accept while the rows claim shell is denied.
    expect(autoAccept()).toHaveAttribute("data-state", "unchecked")
    for (const select of screen.getAllByRole("combobox")) {
      expect(select).toBeDisabled()
    }
    expect(screen.getByRole("button", { name: shellRulesName })).toBeDisabled()
    // Auto-accept and Reset replace every rule, so they stay available.
    expect(autoAccept()).toBeEnabled()
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Fix order" }))
    expect(harness.permissions()).toEqual([
      rule("*", "*", "allow"),
      rule("shell", "*", "deny"),
    ])
    expect(
      screen.queryByText(/not written in the order shown below/)
    ).not.toBeInTheDocument()
    for (const select of screen.getAllByRole("combobox")) {
      expect(select).toBeEnabled()
    }
  })

  // `rm *` allow then `*` ask asks before `rm` too. An edit elsewhere that
  // wrote the list back grouped would put the broad rule first and stop asking.
  it("cannot change a rule list whose order differs from the rows", () => {
    const harness = setup(
      JSON.stringify({
        permissions: [
          rule("shell", "rm *", "allow"),
          rule("shell", "*", "ask"),
        ],
      })
    )
    for (const select of screen.getAllByRole("combobox")) {
      expect(select).toBeDisabled()
    }
    expect(harness.changes()).toBe(0)
  })

  it("offers no Fix order button for shadowing reordering cannot fix", () => {
    setup(
      JSON.stringify({
        permissions: [
          rule("mymcp_run", "*", "deny"),
          rule("mymcp_*", "*", "ask"),
        ],
      })
    )
    expect(
      screen.getByText(/shadowed by a later, more general pattern/)
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Fix order" })
    ).not.toBeInTheDocument()
  })

  it("notes 1.x rules, and a tools deny keeps auto-accept off", () => {
    setup(JSON.stringify({ permission: "allow", tools: { bash: false } }))
    expect(screen.getByText(/These rules come from OpenCode 1/)).toBeVisible()
    expect(autoAccept()).toHaveAttribute("data-state", "unchecked")
  })

  it("warns about agents whose own rules outrank everything shown", () => {
    setup(
      JSON.stringify({
        permissions: [rule("*", "*", "allow")],
        agents: { build: { permissions: [rule("shell", "*", "ask")] } },
      })
    )
    expect(screen.getByText(/These agents override permissions/)).toBeVisible()
    expect(autoAccept()).toHaveAttribute("data-state", "unchecked")
  })

  it("auto-accept clears agent overrides so the switch tells the truth", () => {
    const harness = setup(
      JSON.stringify({
        agents: {
          build: { model: "x/y", permissions: [rule("shell", "*", "ask")] },
        },
        agent: { review: { permission: "deny" } },
      })
    )
    fireEvent.click(autoAccept())
    expect(harness.doc().agents).toEqual({ build: { model: "x/y" } })
    // Kept: the entry is what registers the custom agent at all.
    expect(harness.doc().agent).toEqual({ review: {} })
    expect(autoAccept()).toHaveAttribute("data-state", "checked")
    expect(
      screen.queryByText(/These agents override permissions/)
    ).not.toBeInTheDocument()
  })

  it("keeps the file's comments when it rewrites the rules", () => {
    const harness = setup(
      '{\n  // my model\n  "model": "x/y",\n  "permissions": []\n}\n'
    )
    fireEvent.click(autoAccept())
    expect(harness.latest()).toContain("// my model")
    expect(harness.latest()).toContain('"effect": "allow"')
  })

  it("reset clears the rules but keeps the rest of the config", () => {
    const harness = setup(
      JSON.stringify({ model: "x/y", permissions: [rule("*", "*", "deny")] })
    )
    fireEvent.click(screen.getByRole("button", { name: "Reset" }))
    expect(harness.doc()).toEqual({ model: "x/y" })
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled()
  })

  it("locks every control while a save is in flight", () => {
    setup(JSON.stringify({ permissions: [rule("*", "*", "ask")] }), true)
    expect(autoAccept()).toBeDisabled()
    expect(screen.getByRole("button", { name: shellRulesName })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled()
  })
})
