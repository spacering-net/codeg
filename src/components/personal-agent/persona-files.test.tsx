import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PersonalAgentFile } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentFiles: vi.fn(),
  personalAgentFileSave: vi.fn(),
  personalAgentFileDelete: vi.fn(),
}))
const toasts = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("sonner", () => ({ toast: toasts }))

import { entryMeta, PersonaFiles, withoutEntryLine } from "./persona-files"

const file = (name: string, content: string): PersonalAgentFile => ({
  name,
  content,
  exists: true,
})

const MEMORY_INDEX =
  "# Memory\n\n- [Release days](memory/release-days.md) — Fridays\n" +
  "- [Answer first](memory/answer-first.md) — the answer before the steps\n"

function files(): PersonalAgentFile[] {
  return [
    file("SOUL.md", "# Persona\n\nCalm."),
    file("AGENTS.md", "# Rules"),
    file("USER.md", "# The owner"),
    file("MEMORY.md", MEMORY_INDEX),
    file(
      "memory/release-days.md",
      "---\nname: release-days\ndescription: When releases go out\ntype: fact\n---\n\nFridays."
    ),
    file("memory/tea.md", "# Likes tea\n\nGreen."),
    file(
      "memory/answer-first.md",
      "---\nname: answer-first\ntype: Lesson\n---\n\nAnswer first.\n\n**Why:** asked twice."
    ),
  ]
}

function draw() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PersonaFiles />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  api.personalAgentFiles.mockResolvedValue(files())
  api.personalAgentFileSave.mockResolvedValue(undefined)
  api.personalAgentFileDelete.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("entryMeta", () => {
  it("names an entry by its index line, else its own name, heading or file", () => {
    expect(
      entryMeta("memory/release-days.md", "---\nname: x\n---\n", MEMORY_INDEX)
    ).toEqual({ title: "Release days", description: null, type: null })
    // A `./` link is the same link.
    expect(
      entryMeta("memory/a.md", "", "- [Alpha](./memory/a.md) — a").title
    ).toBe("Alpha")
    expect(
      entryMeta(
        "memory/a.md",
        "---\nname: alpha-fact\ndescription: 'What alpha is'\n---\nbody",
        ""
      )
    ).toEqual({ title: "alpha-fact", description: "What alpha is", type: null })
    expect(entryMeta("memory/b.md", "# Be brief\n\ntext", "").title).toBe(
      "Be brief"
    )
    expect(entryMeta("memory/be-brief.md", "text", "").title).toBe("be-brief")
    // Another entry's line is not this one's.
    expect(
      entryMeta("memory/a.md", "", "- [Other](memory/ab.md) — x").title
    ).toBe("a")
  })

  it("reads an entry's kind from its frontmatter, in any case", () => {
    const kind = (type: string) =>
      entryMeta("memory/a.md", `---\ntype: ${type}\n---\nx`, "").type
    expect(kind("lesson")).toBe("lesson")
    expect(kind("Fact")).toBe("fact")
    expect(kind("'reference'")).toBe("reference")
    // Not one of the kinds, or no frontmatter: none.
    expect(kind("feedback")).toBeNull()
    expect(entryMeta("memory/a.md", "type: lesson", "").type).toBeNull()
  })
})

describe("withoutEntryLine", () => {
  it("takes out the lines linking to the entry, as the server does", () => {
    expect(
      withoutEntryLine(
        "# M\n- [A](memory/a.md) — a\n- [B](./memory/b.md) — b\n- [AB](memory/ab.md)\n",
        "memory/a.md"
      )
    ).toBe("# M\n- [B](./memory/b.md) — b\n- [AB](memory/ab.md)\n")
    expect(withoutEntryLine("- [B](./memory/b.md)", "memory/b.md")).toBe("")
  })
})

describe("PersonaFiles", () => {
  it("lists who it is, then the memory with its entries, lessons first, and opens a file", async () => {
    draw()
    const nav = await screen.findByRole("navigation")
    const labels = [...nav.querySelectorAll("button")].map((b) => b.textContent)
    // Each entry with its kind at its end: the lessons, the facts, then the
    // ones of no kind.
    expect(labels).toEqual([
      "Persona",
      "Rules",
      "About you",
      "Memory3",
      "Answer firstLesson",
      "Release daysFact",
      "Likes tea",
    ])
    // The kind is not part of the row's name.
    expect(screen.getByRole("button", { name: "Answer first" })).toBeTruthy()
    // The persona first, the owner's to write.
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
      "# Persona\n\nCalm."
    )
    expect(screen.getByText("You write it")).toBeTruthy()
    // Its name and its count of entries.
    fireEvent.click(screen.getByRole("button", { name: /^Memory\s*3$/ }))
    expect(screen.getByText("The agent keeps it")).toBeTruthy()
    const entry = screen.getByRole("button", { name: "Release days" })
    expect(entry.title).toBe("When releases go out")
    fireEvent.click(entry)
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toContain(
      "Fridays."
    )
    expect(screen.getByText("memory/release-days.md")).toBeTruthy()
    // Over an entry, its kind instead of who writes it.
    const outside = (text: string) =>
      screen.queryAllByText(text).filter((el) => !nav.contains(el))
    expect(outside("Fact")).toHaveLength(1)
    expect(screen.queryByText("The agent keeps it")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Likes tea" }))
    expect(outside("Fact")).toHaveLength(0)
  })

  it("saves the file that is open", async () => {
    draw()
    fireEvent.click(await screen.findByRole("button", { name: "Likes tea" }))
    const save = screen.getByRole("button", { name: "Save file" })
    expect(save).toHaveProperty("disabled", true)
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "# Likes tea\n\nOolong." },
    })
    fireEvent.click(save)
    await waitFor(() =>
      expect(api.personalAgentFileSave).toHaveBeenCalledWith(
        "memory/tea.md",
        "# Likes tea\n\nOolong."
      )
    )
  })

  it("deletes an entry once confirmed, and goes back to its index", async () => {
    draw()
    fireEvent.click(await screen.findByRole("button", { name: "Release days" }))
    // The fixed files have no delete.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(
      screen.getByText("Delete this entry and its index line?")
    ).toBeTruthy()
    const left =
      "# Memory\n\n- [Answer first](memory/answer-first.md) — the answer before the steps\n"
    api.personalAgentFiles.mockResolvedValue(
      files()
        .filter((f) => f.name !== "memory/release-days.md")
        .map((f) => (f.name === "MEMORY.md" ? file(f.name, left) : f))
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(api.personalAgentFileDelete).toHaveBeenCalledWith(
        "memory/release-days.md"
      )
    )
    await waitFor(() =>
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(left)
    )
    expect(screen.queryByRole("button", { name: "Release days" })).toBeNull()
    expect(screen.getByRole("button", { name: /^Memory\s*2$/ })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Persona" }))
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull()
  })

  it("keeps an edit of the index in progress through deleting one of its entries", async () => {
    const entry = "memory/answer-first.md"
    const line = "- [Draft](memory/draft.md) — written, not saved\n"
    draw()
    // The index and the persona, both edited and not saved.
    fireEvent.click(await screen.findByRole("button", { name: /^Memory\s*3$/ }))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: MEMORY_INDEX + line },
    })
    fireEvent.click(screen.getByRole("button", { name: "Persona" }))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "# Persona\n\nCalm and brief." },
    })
    // Then a lesson of that index goes.
    fireEvent.click(screen.getByRole("button", { name: "Answer first" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    const lineOf = (text: string) =>
      text
        .split("\n")
        .filter((l) => !l.includes(`${entry})`))
        .join("\n")
    api.personalAgentFiles.mockResolvedValue(
      files()
        .filter((f) => f.name !== entry)
        .map((f) =>
          f.name === "MEMORY.md" ? file(f.name, lineOf(MEMORY_INDEX)) : f
        )
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(api.personalAgentFileDelete).toHaveBeenCalledWith(entry)
    )
    // The index opens with the edit kept, only the entry's line gone.
    await waitFor(() =>
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
        lineOf(MEMORY_INDEX) + line
      )
    )
    // The persona's edit is kept too.
    fireEvent.click(screen.getByRole("button", { name: "Persona" }))
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
      "# Persona\n\nCalm and brief."
    )
  })
})
