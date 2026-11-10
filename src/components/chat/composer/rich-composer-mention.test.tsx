import { act, render, screen, waitFor } from "@testing-library/react"
import type { JSONContent } from "@tiptap/core"
import { createRef } from "react"
import { describe, expect, it, vi } from "vitest"

import {
  resetMentionPanelPrefs,
  saveMentionPanelPrefs,
} from "@/lib/mention-panel-prefs"

import { RichComposer, type RichComposerHandle } from "./rich-composer"
import type { ReferenceSearch } from "./suggestion/types"

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
          uri: "file:///repo/src/app.ts",
          meta: { fileKind: "file" },
        },
        detail: "src/app.ts",
      },
    ],
  },
]

function findReference(doc: JSONContent): JSONContent | undefined {
  if (doc.type === "reference") return doc
  for (const child of doc.content ?? []) {
    const found = findReference(child)
    if (found) return found
  }
  return undefined
}

async function mount(onSubmit?: () => void) {
  const ref = createRef<RichComposerHandle>()
  render(
    <RichComposer ref={ref} referenceSearch={search} onSubmit={onSubmit} />
  )
  await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
    timeout: 5000,
  })
  const editor = ref.current?.getEditor()
  if (!editor) throw new Error("editor not mounted")
  return { ref, editor }
}

describe("RichComposer @ mention integration", () => {
  it("opens the panel on @ and inserts the chosen reference", async () => {
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
    await waitFor(() => {
      const node = findReference(editor.getJSON())
      expect(node?.attrs).toMatchObject({ refType: "file", id: "src/app.ts" })
    })
    // The "@app" trigger text is gone, replaced by the badge.
    expect(editor.getText()).not.toContain("@app")
    // Selecting closes the panel and clears the combobox ARIA on the editor.
    const dom = editor.view.dom as HTMLElement
    await waitFor(() => {
      expect(dom.hasAttribute("aria-controls")).toBe(false)
      expect(dom.hasAttribute("aria-activedescendant")).toBe(false)
      expect(dom.hasAttribute("aria-autocomplete")).toBe(false)
    })
  })

  it("wires the editor's combobox ARIA while the panel is open, clears it on Escape", async () => {
    const { editor } = await mount()
    const dom = editor.view.dom as HTMLElement
    expect(dom.getAttribute("role")).toBe("textbox")
    expect(dom.hasAttribute("aria-controls")).toBe(false)
    act(() => {
      editor.commands.insertContent("@app")
    })
    await screen.findByText("app.ts", {}, { timeout: 5000 })
    await waitFor(() => {
      expect(dom.getAttribute("aria-controls")).toBe("mention-listbox")
      expect(dom.getAttribute("aria-autocomplete")).toBe("list")
      // The search returns only a file group, so the panel auto-targets the
      // file tab; option ids are namespaced by tab kind.
      expect(dom.getAttribute("aria-activedescendant")).toBe(
        "mention-option-file-0"
      )
    })
    act(() => {
      dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      )
    })
    await waitFor(() => {
      expect(dom.hasAttribute("aria-controls")).toBe(false)
      expect(dom.hasAttribute("aria-autocomplete")).toBe(false)
      expect(dom.hasAttribute("aria-activedescendant")).toBe(false)
    })
  })

  // Settings → General decides which tabs the panel shows and in what order;
  // every composer reads it, and an open panel follows a change made in
  // another window.
  it("lays the tabs out from the saved preference, live", async () => {
    saveMentionPanelPrefs({
      tabs: [
        { kind: "file", visible: true },
        { kind: "commit", visible: true },
        { kind: "agent", visible: false },
        { kind: "assistant", visible: false },
        { kind: "session", visible: true },
      ],
    })
    try {
      const { editor } = await mount()
      act(() => {
        editor.commands.insertContent("@app")
      })
      await screen.findByText("app.ts", {}, { timeout: 5000 })
      const tabNames = () =>
        screen
          .getAllByRole("tab")
          .map((tab) => tab.textContent?.replace(/\d+$/, ""))
      expect(tabNames()).toEqual(["Files", "Commits", "Sessions"])

      act(() => {
        saveMentionPanelPrefs({
          tabs: [
            { kind: "agent", visible: true },
            { kind: "assistant", visible: false },
            { kind: "file", visible: true },
            { kind: "session", visible: false },
            { kind: "commit", visible: false },
          ],
        })
      })
      await waitFor(() => expect(tabNames()).toEqual(["Agents", "Files"]))
    } finally {
      act(() => resetMentionPanelPrefs())
    }
  })

  it("does not submit on Enter while the panel is open", async () => {
    const onSubmit = vi.fn()
    const { editor } = await mount(onSubmit)
    act(() => {
      editor.commands.insertContent("@app")
    })
    await screen.findByText("app.ts", {}, { timeout: 5000 })
    act(() => {
      ;(editor.view.dom as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      )
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // A phone's soft keyboard types through an IME composition that stays open
  // across the whole word (Android keeps `view.composing` true for five seconds
  // past the last keystroke), so a trigger that refuses to fire while composing
  // never fires on mobile at all — which is what "@ does nothing on my phone"
  // was. Desktop typing never composes, which is why it only showed up there.
  function forceComposing(view: { composing: boolean }) {
    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => true,
    })
  }

  it("opens the panel while an IME composition is in flight", async () => {
    const { editor } = await mount()
    forceComposing(editor.view)
    act(() => {
      editor.commands.insertContent("@app")
    })
    expect(
      await screen.findByText("app.ts", {}, { timeout: 5000 })
    ).toBeTruthy()
  })

  it("lets the IME keep its own Enter while the panel is open", async () => {
    // The other half of the trade: the panel is now open during a composition,
    // so the Enter that picks a CJK candidate must reach the input method
    // rather than insert a row or send the message. The popup reads that off
    // the event itself (`isComposing` here, `keyCode` 229 on WebKit, which
    // fires `compositionend` before the keydown).
    const onSubmit = vi.fn()
    const { editor } = await mount(onSubmit)
    forceComposing(editor.view)
    act(() => {
      editor.commands.insertContent("@app")
    })
    await screen.findByText("app.ts", {}, { timeout: 5000 })
    act(() => {
      ;(editor.view.dom as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        })
      )
    })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(findReference(editor.getJSON())).toBeUndefined()
    // Still open: the composition is unfinished, not dismissed.
    expect(screen.queryByTestId("mention-popup")).not.toBeNull()
  })

  it("leaves Enter to the editor while the panel has nothing to insert", async () => {
    // Between the trigger and the first search result the panel is open but
    // has no selectable row. It must not eat the key: on Android the soft
    // keyboard's Enter reaches the panel as a synthetic event that ProseMirror
    // fires *after* the browser applied the newline, and claiming it there
    // makes ProseMirror drop that change instead of reconciling it.
    const onSubmit = vi.fn()
    const { editor } = await mount(onSubmit)
    // Await only the plugin's own microtask (it resolves `items` before
    // `onStart`), never the 150ms search debounce.
    await act(async () => {
      editor.commands.insertContent("@app")
    })
    // Panel is mounted but the debounced search has not answered yet, so
    // nothing is selectable.
    expect(screen.queryByTestId("mention-popup")).not.toBeNull()
    expect(screen.queryByText("app.ts")).toBeNull()
    act(() => {
      ;(editor.view.dom as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      )
    })
    // Not selected, not sent — and the editor got the key, splitting the
    // paragraph the way a plain Enter does with no panel in the way.
    expect(findReference(editor.getJSON())).toBeUndefined()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(editor.getJSON().content?.length).toBe(2)
  })

  it("dismisses the panel on Escape", async () => {
    const { editor } = await mount()
    act(() => {
      editor.commands.insertContent("@app")
    })
    await screen.findByText("app.ts", {}, { timeout: 5000 })
    act(() => {
      ;(editor.view.dom as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      )
    })
    await waitFor(() => expect(screen.queryByText("app.ts")).toBeNull())
  })

  it("dismisses the panel and restores submit when referenceSearch is removed mid-open", async () => {
    const onSubmit = vi.fn()
    const ref = createRef<RichComposerHandle>()
    const { rerender } = render(
      <RichComposer ref={ref} referenceSearch={search} onSubmit={onSubmit} />
    )
    await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
      timeout: 5000,
    })
    const editor = ref.current?.getEditor()
    if (!editor) throw new Error("editor not mounted")
    act(() => {
      editor.commands.insertContent("@app")
    })
    await screen.findByText("app.ts", {}, { timeout: 5000 })

    // Disable mentions while the panel is open.
    rerender(<RichComposer ref={ref} onSubmit={onSubmit} />)
    await waitFor(() =>
      expect(screen.queryByTestId("mention-popup")).toBeNull()
    )
    // Disabling also clears the combobox ARIA on the editor.
    const dom = editor.view.dom as HTMLElement
    expect(dom.hasAttribute("aria-controls")).toBe(false)
    expect(dom.hasAttribute("aria-activedescendant")).toBe(false)
    expect(dom.hasAttribute("aria-autocomplete")).toBe(false)

    // Enter now submits normally — panel + plugin state were cleared.
    act(() => {
      ;(editor.view.dom as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      )
    })
    expect(onSubmit).toHaveBeenCalled()
  })

  it("does not open a panel when referenceSearch is not provided", async () => {
    const ref = createRef<RichComposerHandle>()
    render(<RichComposer ref={ref} />)
    await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
      timeout: 5000,
    })
    const editor = ref.current?.getEditor()
    if (!editor) throw new Error("editor not mounted")
    act(() => {
      editor.commands.insertContent("@app")
    })
    // Plugin is installed but inert without referenceSearch: no popup ever.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(screen.queryByTestId("mention-popup")).toBeNull()
  })

  it("triggers on an @ typed straight after CJK text", async () => {
    // Chinese, Japanese and Korean put no spaces between words, so the space
    // Tiptap's default `allowedPrefixes` demands never arrives and the panel
    // used to stay shut for the most natural way to write the mention.
    const { editor } = await mount()
    act(() => {
      editor.commands.insertContent("请看@app")
    })
    expect(
      await screen.findByText("app.ts", {}, { timeout: 5000 })
    ).toBeTruthy()
  })

  it("still ignores the @ inside an email address", async () => {
    // The other half of the prefix rule, unchanged: an ASCII letter before `@`
    // means the user is typing an address, not a mention.
    const { editor } = await mount()
    act(() => {
      editor.commands.insertContent("me@app")
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(screen.queryByTestId("mention-popup")).toBeNull()
  })

  it("keeps the query current through an IME composition, including the committed frame", async () => {
    // #518. Chromium writes the *committed* character into the DOM before it
    // fires `compositionend`, so the transaction carrying the final text still
    // lands with `view.composing === true` — and nothing dispatches afterwards.
    // A trigger gated on `!composing` therefore never sees the finished query:
    // the panel goes quiet at the first keystroke of the composition and never
    // catches up. Walk the frames a Chinese IME actually produces (pinyin →
    // converted character, all inside one composition) and require the panel to
    // be showing the committed query's results at the end.
    const queries: string[] = []
    const cjkSearch: ReferenceSearch = (query) => {
      queries.push(query)
      return [
        {
          kind: "file",
          label: "Files",
          items:
            query === "美术"
              ? [
                  {
                    reference: {
                      refType: "file",
                      id: "docs/美术资源清单.md",
                      label: "美术资源清单.md",
                      uri: "file:///repo/docs/美术资源清单.md",
                      meta: { fileKind: "file" },
                    },
                    detail: "docs/美术资源清单.md",
                  },
                ]
              : [],
        },
      ]
    }
    const ref = createRef<RichComposerHandle>()
    render(<RichComposer ref={ref} referenceSearch={cjkSearch} />)
    await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
      timeout: 5000,
    })
    const editor = ref.current?.getEditor()
    if (!editor) throw new Error("editor not mounted")

    const setComposing = (value: boolean) => {
      Object.defineProperty(editor.view, "composing", {
        configurable: true,
        get: () => value,
      })
    }
    // Replace the in-flight composition text with what the IME converted it to,
    // the way `compositionupdate` does — still mid-composition.
    const convert = async (raw: string, converted: string) => {
      const to = editor.state.selection.from
      await act(async () => {
        editor
          .chain()
          .setTextSelection({ from: to - raw.length, to })
          .insertContent(converted)
          .run()
      })
    }

    await act(async () => {
      editor.commands.insertContent("@")
    })
    setComposing(true)
    await act(async () => {
      editor.commands.insertContent("mei")
    })
    await convert("mei", "美")
    await act(async () => {
      editor.commands.insertContent("shu")
    })
    await convert("shu", "术")
    // `compositionend` only flips the flag — it dispatches nothing, so the
    // frame above is the last chance the panel gets.
    setComposing(false)

    expect(editor.getText()).toBe("@美术")
    expect(
      await screen.findByText("美术资源清单.md", {}, { timeout: 5000 })
    ).toBeTruthy()
    expect(queries[queries.length - 1]).toBe("美术")
  })
})
