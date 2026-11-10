import { act, render, screen, waitFor } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import { NextIntlClientProvider } from "next-intl"
import { createRef, useState } from "react"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ReferenceSearch } from "@/components/chat/composer/suggestion/types"
import type {
  AgentSkillItem,
  AgentType,
  AvailableCommandInfo,
  PromptInputBlock,
} from "@/lib/types"

import {
  TaskMessageComposer,
  type TaskMessageComposerHandle,
} from "./task-message-composer"

// The `/` menu's source: the agent-options probe (a transient CLI session).
// A test may swap the list it reports (and must put it back).
const probe = vi.hoisted(() => {
  const commands: AvailableCommandInfo[] = [
    { name: "review", description: "Review the working diff" },
    { name: "commit", description: "Commit the change" },
  ]
  return { defaults: commands, commands }
})
vi.mock("@/components/automations/use-agent-options", () => ({
  useAgentOptions: () => ({
    snapshot: { available_commands: probe.commands },
    loading: false,
    error: null,
    reload: vi.fn(),
    ensure: () => Promise.resolve(null),
  }),
}))

// Skills read from disk in production: Codex's under `$`, Antigravity's under
// `/` (its server never advertises them).
const SKILL: AgentSkillItem = {
  id: "deploy",
  name: "Deploy",
  scope: "global",
  layout: "skill_directory",
  path: "/skills/deploy",
  description: "Ship it",
  read_only: false,
}
// The "+" menu's data sources all hit the transport; none of them is what
// these tests exercise.
vi.mock("@/hooks/use-built-in-experts", () => ({ useBuiltInExperts: () => [] }))
vi.mock("@/hooks/use-built-in-science", () => ({ useBuiltInScience: () => [] }))
vi.mock("@/hooks/use-enabled-skill-ids", () => ({
  useEnabledSkillIds: () => ({
    enabledIds: new Set<string>(),
    ready: true,
    supported: true,
  }),
}))
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isDesktop: () => false,
}))

vi.mock("@/hooks/use-agent-skills", () => ({
  useAgentSkills: (agentType: AgentType | null) =>
    agentType === "codex" || agentType === "antigravity" ? [SKILL] : [],
}))

// The `@` panel's data sources all hit the transport; the panel itself is what
// matters here, so it gets one canned file.
const search: ReferenceSearch = () => [
  {
    kind: "file",
    label: "Files",
    items: [
      {
        reference: {
          refType: "file",
          id: "src/app.ts",
          label: "app.ts",
          uri: "file:///repo-task-7/src/app.ts",
          meta: { fileKind: "file" },
        },
        detail: "src/app.ts",
      },
    ],
  },
]
vi.mock("@/components/chat/composer/use-reference-search", () => ({
  useReferenceSearch: () => search,
}))

async function mount(
  props: Partial<React.ComponentProps<typeof TaskMessageComposer>> = {}
) {
  const ref = createRef<TaskMessageComposerHandle>()
  const onChange = vi.fn()
  const onSubmit = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskMessageComposer
        ref={ref}
        agentType="claude_code"
        folderPath="/repo-task-7"
        defaultText=""
        placeholder="What should the agent change?"
        ariaLabel="Follow up"
        onChange={onChange}
        onSubmit={onSubmit}
        {...props}
      />
    </NextIntlClientProvider>
  )
  // Editor construction (ProseMirror + React node views) is async and can be
  // slow under parallel workers.
  await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
    timeout: 5000,
  })
  const editor = ref.current?.getEditor() as Editor
  return { ref, editor, onChange, onSubmit }
}

describe("TaskMessageComposer", () => {
  it("offers the agent's slash commands and inserts the invocation token", async () => {
    const { editor, onChange } = await mount()
    act(() => {
      editor.commands.insertContent("/rev")
    })
    const row = await screen.findByText("/review", {}, { timeout: 5000 })
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      )
    })
    // The badge serializes to the literal token the agent runs, and the typed
    // trigger text is gone.
    await waitFor(() => expect(editor.getText()).toContain("/review"))
    expect(editor.getText()).not.toContain("/rev ")
    expect(onChange).toHaveBeenCalled()
  })

  // claude-agent-acp 0.99.1 marks skills among the commands, every one only
  // once it has read Claude Code's skill list (then a bundled skill comes
  // without a path). The rows show the marks only for such a list, and the
  // icon column is read off the whole list, not the rows a filter leaves.
  it("shows the skills of a fully marked list with the skill icon", async () => {
    probe.commands = [
      {
        name: "review",
        description: "Review the working diff",
        skill: true,
        skill_path: "/p/review/SKILL.md",
      },
      { name: "simplify", description: "Simplify the code", skill: true },
      { name: "commit", description: "Commit the change" },
    ]
    try {
      const { editor } = await mount()
      const kind = (token: string) =>
        (
          screen.getByText(token).closest("button") as HTMLElement
        ).querySelector<HTMLElement>("[data-command-kind]")?.dataset.commandKind
      act(() => {
        editor.commands.insertContent("/")
      })
      await screen.findByText("/simplify", {}, { timeout: 5000 })
      expect(kind("/review")).toBe("skill")
      expect(kind("/simplify")).toBe("skill")
      expect(kind("/commit")).toBe("command")

      act(() => {
        editor.commands.setContent("")
        editor.commands.insertContent("/com")
      })
      await waitFor(() => expect(screen.queryByText("/simplify")).toBeNull())
      expect(kind("/commit")).toBe("command")
    } finally {
      probe.commands = probe.defaults
    }
  })

  // What the probe gets: it never prompts, so it only sees the first list,
  // where only the skills found on disk are marked.
  it("keeps the rows plain for a partly marked list", async () => {
    probe.commands = [
      {
        name: "review",
        description: "Review the working diff",
        skill: true,
        skill_path: "/p/review/SKILL.md",
      },
      { name: "simplify", description: "Simplify the code" },
    ]
    try {
      const { editor } = await mount()
      act(() => {
        editor.commands.insertContent("/")
      })
      await screen.findByText("/simplify", {}, { timeout: 5000 })
      expect(document.querySelector("[data-command-kind]")).toBeNull()
    } finally {
      probe.commands = probe.defaults
    }
  })

  it("references a file through the @ panel", async () => {
    const { editor } = await mount()
    act(() => {
      editor.commands.insertContent("@app")
    })
    const row = await screen.findByText("app.ts", {}, { timeout: 5000 })
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      )
    })
    // What the backend receives is one string: the reference as a Markdown
    // link, the same shape the chat composer sends.
    await waitFor(() =>
      expect(editor.getText()).toContain(
        "[app.ts](file:///repo-task-7/src/app.ts)"
      )
    )
  })

  it("triggers Codex skills on $, not on #", async () => {
    const { editor } = await mount({ agentType: "codex" })
    act(() => {
      editor.commands.insertContent("#dep")
    })
    // `#` is ordinary text — no menu, nothing swallowed.
    expect(screen.queryByText("Deploy")).toBeNull()

    act(() => {
      editor.commands.setContent("")
      editor.commands.insertContent("$dep")
    })
    const row = await screen.findByText("Deploy", {}, { timeout: 5000 })
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      )
    })
    await waitFor(() => expect(editor.getText()).toContain("$deploy"))
  })

  it("offers Antigravity's skills on `/`, after its commands", async () => {
    const { editor } = await mount({ agentType: "antigravity" })
    act(() => {
      editor.commands.insertContent("/")
    })
    await screen.findByText("Deploy", {}, { timeout: 5000 })
    expect(screen.getByText("/review")).toBeInTheDocument()

    act(() => {
      editor.commands.setContent("")
      editor.commands.insertContent("/dep")
    })
    const row = await screen.findByText("Deploy", {}, { timeout: 5000 })
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      )
    })
    await waitFor(() => expect(editor.getText()).toContain("/deploy"))
    expect(editor.getText()).not.toContain("$deploy")
  })

  it("seeds a stored prompt back into the box, attachments included", async () => {
    // Editing a task hands the composer its stored blocks. Without this, the
    // box would show only the prose and saving an untouched task would drop
    // every image it had.
    const blocks: PromptInputBlock[] = [
      { type: "text", text: "the header is wrong" },
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
    ]
    const { ref } = await mount({ defaultBlocks: blocks })
    await waitFor(() => expect(ref.current?.hasAttachments()).toBe(true))
    // Round-trips: what comes back out is what a save would store.
    const out = ref.current?.getPromptBlocks() ?? []
    expect(out).toContainEqual({ type: "text", text: "the header is wrong" })
    expect(out).toContainEqual(
      expect.objectContaining({ type: "image", data: "aGk=" })
    )
  })

  it("repaints the scenario's placeholder in place, keeping the document", async () => {
    // The drawer swaps a placeholder per follow-up scenario. It must repaint
    // without recreating the editor: a remount would take the document with it,
    // and an attachment whose bytes live out of band (a pasted screenshot, a
    // pathless file) cannot be recovered from the serialized text.
    const ref = createRef<TaskMessageComposerHandle>()
    function Host({ placeholder }: { placeholder: string }) {
      const [text, setText] = useState("")
      return (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <TaskMessageComposer
            ref={ref}
            agentType="claude_code"
            folderPath={null}
            defaultText={text}
            placeholder={placeholder}
            ariaLabel="Follow up"
            onChange={setText}
          />
        </NextIntlClientProvider>
      )
    }
    const { rerender } = render(<Host placeholder="What should it change?" />)
    await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
      timeout: 5000,
    })
    const editor = ref.current?.getEditor() as Editor
    expect(
      document.querySelector('[data-placeholder="What should it change?"]')
    ).not.toBeNull()

    // Tiptap only decorates an EMPTY node, so the switch is observable here.
    rerender(<Host placeholder="What do you want to know?" />)
    await waitFor(() =>
      expect(
        document.querySelector('[data-placeholder="What do you want to know?"]')
      ).not.toBeNull()
    )

    // The same editor instance throughout — so what it holds survives the
    // switch, badges and all.
    act(() => {
      editor.commands.insertContent("check the retry path")
    })
    rerender(<Host placeholder="What should it change?" />)
    expect(ref.current?.getEditor()).toBe(editor)
    expect(ref.current?.getText()).toContain("check the retry path")
  })
})
