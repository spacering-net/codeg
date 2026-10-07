import { generateJSON, type Editor, type JSONContent } from "@tiptap/core"
import { act, render, waitFor } from "@testing-library/react"
import { createRef } from "react"
import { describe, expect, it } from "vitest"

import { buildComposerExtensions } from "../editor-config"
import { RichComposer, type RichComposerHandle } from "../rich-composer"
import { serializeDocToText } from "../to-prompt-blocks"
import type { ReferenceAttrs } from "../types"

async function mountEditor() {
  const ref = createRef<RichComposerHandle>()
  const result = render(<RichComposer ref={ref} />)
  // Generous timeout: editor construction can be slow under parallel worker
  // CPU contention.
  await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
    timeout: 5000,
  })
  return { ref, ...result }
}

function editorOf(ref: React.RefObject<RichComposerHandle | null>): Editor {
  const editor = ref.current?.getEditor()
  if (!editor) throw new Error("editor not mounted")
  return editor
}

function findReference(doc: JSONContent): JSONContent | undefined {
  if (doc.type === "reference") return doc
  for (const child of doc.content ?? []) {
    const found = findReference(child)
    if (found) return found
  }
  return undefined
}

const fileRef: ReferenceAttrs = {
  refType: "file",
  id: "src/app.ts",
  label: "app.ts",
  uri: "file:///repo/src/app.ts",
  meta: { fileKind: "file" },
}
const agentRef: ReferenceAttrs = {
  refType: "agent",
  id: "claude_code",
  label: "Claude Code",
  uri: null,
  meta: { agentType: "claude_code" },
}
const sessionRef: ReferenceAttrs = {
  refType: "session",
  id: "123",
  label: "Login refactor",
  uri: "codeg://session/123",
  meta: { agentType: "codex", status: "in_progress" },
}
const commitRef: ReferenceAttrs = {
  refType: "commit",
  id: "abc1234def",
  label: "abc1234",
  uri: "codeg://commit/repo@abc1234def",
  meta: { message: "fix login", shortHash: "abc1234" },
}
const skillRef: ReferenceAttrs = {
  refType: "skill",
  id: "code-review",
  label: "code-review",
  uri: null,
  meta: { scope: "project" },
}

describe("Reference node", () => {
  it("inserts a reference node carrying the given attrs", async () => {
    const { ref } = await mountEditor()
    const editor = editorOf(ref)
    act(() => {
      editor.commands.insertReference(fileRef)
    })
    const node = findReference(editor.getJSON())
    expect(node).toBeDefined()
    expect(node?.attrs).toMatchObject({
      refType: "file",
      id: "src/app.ts",
      label: "app.ts",
      uri: "file:///repo/src/app.ts",
    })
  })

  it.each([
    ["file", fileRef, "[app.ts](file:///repo/src/app.ts)"],
    ["agent", agentRef, "@Claude Code"],
    ["session", sessionRef, "[Login refactor](codeg://session/123)"],
    ["commit", commitRef, "[abc1234](codeg://commit/repo@abc1234def)"],
    ["skill", skillRef, "/code-review"],
  ])(
    "serializes a %s reference to its inline token",
    async (_n, attrs, expected) => {
      const { ref, unmount } = await mountEditor()
      const editor = editorOf(ref)
      act(() => {
        editor.commands.insertReference(attrs as ReferenceAttrs)
      })
      expect(serializeDocToText(editor.state.doc)).toContain(expected as string)
      unmount()
    }
  )

  it("renders a badge with an icon and label in the editor DOM", async () => {
    const { ref, container } = await mountEditor()
    const editor = editorOf(ref)
    act(() => {
      editor.commands.insertReference(agentRef)
    })
    const badge = await waitFor(
      () => {
        const el = container.querySelector(
          '[data-reference-badge][data-ref-type="agent"]'
        )
        expect(el).not.toBeNull()
        return el as HTMLElement
      },
      { timeout: 5000 }
    )
    expect(badge.textContent).toContain("Claude Code")
    expect(badge.querySelector("svg")).not.toBeNull()
    // The inline atom exposes a *computed* accessible name via role="img" +
    // aria-label (a bare span's aria-label would be unreliable); the decorative
    // icon collapses into that single name.
    expect(badge).toHaveAttribute("role", "img")
    expect(badge).toHaveAccessibleName("agent: Claude Code")
  })

  it("deletes a just-inserted badge on one Backspace", async () => {
    const { ref, container } = await mountEditor()
    const editor = editorOf(ref)
    // How every insertion path leaves it: badge, separating space, caret after
    // both (see `insertFileReferences`).
    act(() => {
      editor.chain().focus().insertReference(fileRef).insertContent(" ").run()
    })
    await waitFor(() =>
      expect(container.querySelector("[data-reference-badge]")).not.toBeNull()
    )

    // Through the keymap, not the command: a shortcut the editor never receives
    // is the bug this guards.
    act(() => {
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Backspace",
          keyCode: 8,
          bubbles: true,
          cancelable: true,
        })
      )
    })

    expect(findReference(editor.getJSON())).toBeUndefined()
    expect(ref.current?.isEmpty()).toBe(true)
  })

  it("round-trips through HTML (renderHTML → parseHTML)", async () => {
    const { ref } = await mountEditor()
    const editor = editorOf(ref)
    act(() => {
      editor.commands.insertReference(commitRef)
    })
    const html = editor.getHTML()
    expect(html).toContain("data-reference")

    // Re-parse the serialized HTML through the schema (copy/paste path).
    const json = generateJSON(html, buildComposerExtensions())
    const node = findReference(json)
    expect(node?.attrs).toMatchObject({
      refType: "commit",
      id: "abc1234def",
      uri: "codeg://commit/repo@abc1234def",
    })
    expect(node?.attrs?.meta).toMatchObject({ shortHash: "abc1234" })
  })

  describe("untrusted HTML parse hardening", () => {
    it("drops a reference uri with a disallowed scheme", () => {
      const html =
        '<p><span data-reference data-ref-type="file" ' +
        'data-ref-id="x" data-label="x" ' +
        'data-uri="javascript:alert(1)"></span></p>'
      const node = findReference(generateJSON(html, buildComposerExtensions()))
      expect(node).toBeDefined()
      expect(node?.attrs?.uri).toBeNull()
    })

    it("keeps an allowed file:// uri", () => {
      const html =
        '<p><span data-reference data-ref-type="file" ' +
        'data-ref-id="x" data-label="x" data-uri="file:///repo/x.ts"></span></p>'
      const node = findReference(generateJSON(html, buildComposerExtensions()))
      expect(node?.attrs?.uri).toBe("file:///repo/x.ts")
    })

    it("coerces an unknown ref type to file", () => {
      const html =
        '<p><span data-reference data-ref-type="bogus" ' +
        'data-ref-id="x" data-label="x"></span></p>'
      const node = findReference(generateJSON(html, buildComposerExtensions()))
      expect(node?.attrs?.refType).toBe("file")
    })
  })
})
