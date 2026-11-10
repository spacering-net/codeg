import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ActivitySummary } from "@/lib/activity/types"
import { ActivityHeader } from "./activity-header"

function summaryOf(given: Partial<ActivitySummary>): ActivitySummary {
  return {
    steps: 0,
    counts: {
      commands: 0,
      editedFiles: 0,
      agents: 0,
      mcp: 0,
      web: 0,
      readFiles: 0,
      searches: 0,
    },
    failed: 0,
    unrecovered: 0,
    interrupted: 0,
    running: false,
    firstUnrecoveredKey: null,
    recoveredKeys: new Set(),
    ...given,
  }
}

function renderHeader(
  summary: ActivitySummary,
  { completed = true, folds = true } = {}
) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ActivityHeader
        summary={summary}
        completed={completed}
        hasSteps={summary.steps > 0}
        elapsed="3s"
        toggle={folds ? { open: true, onToggle: () => {} } : undefined}
      />
    </NextIntlClientProvider>
  )
  return document.querySelector<HTMLElement>(".activity-capsule")!
}

describe("ActivityHeader", () => {
  it.each([
    ["steps alone", { steps: 3 }, "Activity3 steps"],
    [
      "steps and a failure",
      { steps: 4, failed: 1, unrecovered: 1 },
      "Activity4 steps · 1 failed",
    ],
    [
      "steps and an interruption",
      { steps: 3, interrupted: 1 },
      "Activity3 steps · 1 interrupted",
    ],
    [
      "a recovered failure and an interruption",
      { steps: 2, failed: 1, interrupted: 1 },
      "Activity2 steps · 1 failed, recovered · 1 interrupted",
    ],
  ])("reads %s, then the time, before the chevron", (_, given, line) => {
    const capsule = renderHeader(summaryOf(given))
    // The time is the summary's last item, after the same separator.
    expect(capsule.textContent).toBe(`${line} · 3s`)
    const chevron = capsule.lastElementChild!
    expect(chevron).toBe(capsule.querySelector("svg.lucide-chevron-right"))
    const time = chevron.previousElementSibling!.lastElementChild!
    expect(time.textContent).toBe(" · 3s")
    // As a flex item of its own the time would drop the separator's
    // leading space; it keeps it as written.
    expect(time.getAttribute("class")!.split(/\s+/)).toContain("whitespace-pre")
  })

  it("keeps the time of a reply with no steps beside its label", () => {
    const capsule = renderHeader(summaryOf({}), { folds: false })
    expect(capsule.textContent).toBe("Reply3s")
    expect(capsule.querySelector("svg")).toBeNull()
    const time = capsule.querySelector(".activity-mono")!
    expect(time.textContent).toBe("3s")
    // No separator to set it apart: a gap does.
    expect(time.getAttribute("class")!.split(/\s+/)).toContain("ms-2")
  })

  it("shows no time while the turn runs", () => {
    const capsule = renderHeader(summaryOf({ steps: 3 }), { completed: false })
    expect(capsule.textContent).toBe("Working3 steps")
  })

  it.each([
    ["one that folds", true],
    ["one that cannot", false],
  ])("leaves nothing in the capsule to select: %s", (_, folds) => {
    // A quick second press on the capsule selected a word in it, and the
    // transcript's copy bubble came up over it.
    const capsule = renderHeader(
      summaryOf({ steps: 4, failed: 1, unrecovered: 1 }),
      { folds }
    )
    expect(capsule.getAttribute("class")!.split(/\s+/)).toContain("select-none")
    // It reaches every word inside; nothing in there turns selection back on.
    for (const element of capsule.querySelectorAll("*")) {
      expect(element.getAttribute("class") ?? "").not.toMatch(
        /(^|\s)select-(text|all|auto)(\s|$)/
      )
    }
  })

  it("gives way in a narrow column: the summary first, then the label", () => {
    // The summary shrinks to nothing before the label does; the label, never
    // wider than the room the time leaves it, then truncates too. The time
    // and the chevron keep their width, so nothing runs over them.
    const capsule = renderHeader(
      summaryOf({ steps: 4, failed: 1, unrecovered: 1 })
    )
    const classes = (el: Element) => el.getAttribute("class")!.split(/\s+/)
    const [words, chevron] = capsule.children
    expect(capsule.children).toHaveLength(2)
    expect(classes(chevron!)).toContain("shrink-0")
    // What the capsule says can give up its width; within it the label and
    // the summary can, and the time after them cannot.
    expect(classes(words!)).toContain("min-w-0")
    const [group, time] = words!.children
    expect(words!.children).toHaveLength(2)
    expect(classes(group!)).toContain("min-w-0")
    expect(classes(time!)).toContain("shrink-0")
    const [label, summary] = group!.children
    expect(classes(label!)).toEqual(
      expect.arrayContaining(["max-w-full", "shrink-0", "truncate"])
    )
    expect(classes(summary!)).toEqual(
      expect.arrayContaining(["min-w-0", "truncate"])
    )
    expect(classes(summary!)).not.toContain("shrink-0")
  })
})
