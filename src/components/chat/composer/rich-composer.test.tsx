import { act, render, waitFor } from "@testing-library/react"
import { createRef } from "react"
import { describe, expect, it, vi } from "vitest"

import { RichComposer, type RichComposerHandle } from "./rich-composer"

/** Wait until the editor has mounted (immediatelyRender:false makes it async). */
async function mount(props: React.ComponentProps<typeof RichComposer> = {}) {
  const ref = createRef<RichComposerHandle>()
  const result = render(<RichComposer ref={ref} {...props} />)
  // Generous timeout: editor construction (ProseMirror + React node view) can
  // be slow under parallel worker CPU contention.
  await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
    timeout: 5000,
  })
  return { ref, ...result }
}

describe("RichComposer", () => {
  it("mounts and reports an empty document via the handle", async () => {
    const { ref } = await mount()
    expect(ref.current?.isEmpty()).toBe(true)
    expect(ref.current?.getText()).toBe("")
  })

  it("paints the placeholder on the empty document", async () => {
    const { ref, container } = await mount({ placeholder: "Ask anything" })
    expect(ref.current).not.toBeNull()
    expect(
      container.querySelector('[data-placeholder="Ask anything"]')
    ).not.toBeNull()
  })

  it("exposes an accessible multiline textbox", async () => {
    const { container } = await mount({ ariaLabel: "Message" })
    const textbox = container.querySelector('[role="textbox"]')
    expect(textbox).not.toBeNull()
    expect(textbox).toHaveAttribute("aria-multiline", "true")
    expect(textbox).toHaveAttribute("aria-label", "Message")
  })

  it("round-trips text through the handle and notifies onChange", async () => {
    const onChange = vi.fn()
    const { ref } = await mount({ onChange })

    act(() => {
      ref.current?.setText("hello **world**")
    })

    // Plain text: the markdown-looking syntax is preserved literally.
    expect(ref.current?.getText()).toContain("**world**")
    expect(ref.current?.isEmpty()).toBe(false)
    expect(onChange).toHaveBeenCalled()
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]
    expect(lastCall?.[0]).toContain("**world**")

    act(() => {
      ref.current?.clear()
    })
    expect(ref.current?.isEmpty()).toBe(true)
  })

  it("preserves CJK content through the handle", async () => {
    const { ref } = await mount()
    act(() => {
      ref.current?.setText("发送给智能体的消息")
    })
    expect(ref.current?.getText()).toContain("发送给智能体的消息")
  })

  it("initializes from defaultText without firing onChange", async () => {
    const onChange = vi.fn()
    const { ref } = await mount({
      defaultText: "# Heading",
      onChange,
    })
    // Inserted as literal text (no heading formatting).
    expect(ref.current?.getText().trim()).toBe("# Heading")
    // onCreate sets content with emitUpdate:false → no spurious change events.
    expect(onChange).not.toHaveBeenCalled()
  })

  it("hydrates serialized references in setText into badges", async () => {
    // Restored draft / queued message / injected template: seeded wire-format
    // text shows badges and re-serializes to exactly what was seeded.
    const { ref } = await mount()
    const text = "续 [排查登录](codeg://session/42) 的问题"
    act(() => {
      ref.current?.setText(text)
    })
    expect(JSON.stringify(ref.current?.getJSON())).toContain(
      '"type":"reference"'
    )
    expect(ref.current?.getText()).toBe(text)
  })

  it("round-trips an angle-wrapped destination through setText verbatim", async () => {
    // A uri containing `\`, `<` or `>` is angle-wrapped and backslash-escaped on
    // the wire. Seeding it must reproduce the SAME text on send — otherwise the
    // escapes compound (and the badge points at a `C:\\repo` path that doesn't
    // exist) every time a draft/queued message/automation is reopened.
    const { ref } = await mount()
    // Wire form: `\`/`<`/`>` escaped inside the `<…>` destination, and (for the
    // second link) inside the label too — what referenceToMarkdown emits.
    const text =
      "[app.ts](<file:///C:\\\\repo\\\\app.ts>) and [a\\<b\\>.ts](<file:///x/a\\<b\\>.ts>)"
    act(() => {
      ref.current?.setText(text)
    })
    expect(
      JSON.stringify(ref.current?.getJSON()).match(/"type":"reference"/g)
    ).toHaveLength(2)
    expect(ref.current?.getText()).toBe(text)
    // Re-seeding the serialized result is a fixed point (no escape growth).
    act(() => {
      ref.current?.setText(ref.current.getText())
    })
    expect(ref.current?.getText()).toBe(text)
  })

  it("hydrates serialized references in defaultText into badges", async () => {
    // A saved automation's prompt is seeded via defaultText. Badge node views
    // mount inside the editor's onCreate, so also assert React logged no
    // warning (@tiptap/react defers that first render to a microtask instead of
    // flushSync — see ReactRenderer — but keep the guard in place).
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const text = "run /review on [app.ts](file:///repo/app.ts)"
      const { ref } = await mount({ defaultText: text })
      await waitFor(() =>
        expect(JSON.stringify(ref.current?.getJSON())).toContain(
          '"type":"reference"'
        )
      )
      expect(ref.current?.getText()).toBe(text)
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

function dispatchKey(
  ref: React.RefObject<RichComposerHandle | null>,
  init: KeyboardEventInit
) {
  const dom = ref.current?.getEditor()?.view.dom as HTMLElement
  act(() => {
    dom.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    )
  })
}

describe("RichComposer imperative inserts", () => {
  it("inserts text at the cursor (markdown syntax stays literal)", async () => {
    const { ref } = await mount()
    act(() => ref.current?.insertTextAtCursor("hello **world**"))
    expect(ref.current?.getText()).toContain("**world**")
  })

  it("hydrates serialized references in inserted text into badges", async () => {
    // The quick-message fill path: stored wire-format text must show badges at
    // insert time, and re-serialize to exactly what was inserted.
    const { ref } = await mount()
    const content = "review [app.ts](file:///repo/app.ts) now"
    act(() => ref.current?.insertTextAtCursor(content))
    const doc = JSON.stringify(ref.current?.getJSON())
    expect(doc).toContain('"type":"reference"')
    expect(doc).toContain("file:///repo/app.ts")
    expect(ref.current?.getText()).toBe(content)
  })

  it("inserts a reference badge and exposes it via getJSON", async () => {
    const { ref } = await mount()
    act(() =>
      ref.current?.insertReference({
        refType: "file",
        id: "a.ts",
        label: "a.ts",
        uri: "file:///a.ts",
        meta: null,
      })
    )
    expect(JSON.stringify(ref.current?.getJSON())).toContain(
      '"type":"reference"'
    )
  })

  it("hydrates the document from a Tiptap JSON doc via setDoc", async () => {
    const { ref } = await mount()
    act(() =>
      ref.current?.setDoc({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "from json" }] },
        ],
      })
    )
    expect(ref.current?.getText()).toContain("from json")
    expect(ref.current?.isEmpty()).toBe(false)
  })

  it("preserves a reference badge through a getJSON → setDoc round-trip", async () => {
    const { ref } = await mount()
    act(() =>
      ref.current?.insertReference({
        refType: "file",
        id: "a.ts",
        label: "a.ts",
        uri: "file:///a.ts",
        meta: null,
      })
    )
    const doc = ref.current!.getJSON()
    act(() => ref.current?.clear())
    expect(ref.current?.isEmpty()).toBe(true)
    act(() => ref.current?.setDoc(doc))
    expect(JSON.stringify(ref.current?.getJSON())).toContain(
      '"type":"reference"'
    )
  })
})

describe("RichComposer configurable submit / newline", () => {
  it("submits on a plain Enter by default", async () => {
    const onSubmit = vi.fn()
    const { ref } = await mount({ onSubmit })
    dispatchKey(ref, { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("treats Enter as a newline when submitShortcut is mod+enter", async () => {
    const onSubmit = vi.fn()
    const { ref } = await mount({ onSubmit, submitShortcut: "mod+enter" })
    dispatchKey(ref, { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    dispatchKey(ref, { key: "Enter", metaKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("inserts a hard break on Shift+Enter without submitting", async () => {
    const onSubmit = vi.fn()
    const { ref } = await mount({ onSubmit })
    act(() => ref.current?.focus())
    dispatchKey(ref, { key: "Enter", shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(JSON.stringify(ref.current?.getJSON())).toContain(
      '"type":"hardBreak"'
    )
  })

  it("does not submit while an external menu is open", async () => {
    const onSubmit = vi.fn()
    const { ref } = await mount({ onSubmit, isExternalMenuOpen: true })
    dispatchKey(ref, { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("submits on a custom non-Enter binding (Tab)", async () => {
    const onSubmit = vi.fn()
    const { ref } = await mount({ onSubmit, submitShortcut: "tab" })
    dispatchKey(ref, { key: "Tab" })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("breaks on a custom newline binding (Shift+Tab) without submitting", async () => {
    const onSubmit = vi.fn()
    const { ref } = await mount({ onSubmit, newlineShortcut: "shift+tab" })
    act(() => ref.current?.focus())
    dispatchKey(ref, { key: "Tab", shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(JSON.stringify(ref.current?.getJSON())).toContain(
      '"type":"hardBreak"'
    )
  })

  it("does not swallow Enter when no onSubmit handler is provided", async () => {
    const { ref } = await mount()
    act(() => ref.current?.setText("hello"))
    act(() => ref.current?.focus())
    dispatchKey(ref, { key: "Enter" })
    // Enter fell through to the editor default (paragraph split), not swallowed.
    expect(ref.current?.getJSON().content?.length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * Dispatch a keydown and return the event so the caller can inspect
 * `defaultPrevented` — i.e. whether the composer consumed the key. (Returning
 * true from ProseMirror's handleKeyDown calls preventDefault.)
 */
function pressKey(dom: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    dom.dispatchEvent(event)
  })
  return event
}

describe("RichComposer paste without formatting (Ctrl/⌘+Shift+V)", () => {
  it("routes Ctrl+Shift+V to onPlainPaste and consumes the key when handled", async () => {
    const onPlainPaste = vi.fn(() => true)
    const { ref } = await mount({ onPlainPaste })
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    const event = pressKey(dom, { key: "V", ctrlKey: true, shiftKey: true })
    expect(onPlainPaste).toHaveBeenCalledTimes(1)
    // Consumed → the browser's native rich paste is suppressed.
    expect(event.defaultPrevented).toBe(true)
  })

  it("routes ⌘+Shift+V (metaKey) to onPlainPaste as well", async () => {
    const onPlainPaste = vi.fn(() => true)
    const { ref } = await mount({ onPlainPaste })
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    const event = pressKey(dom, { key: "V", metaKey: true, shiftKey: true })
    expect(onPlainPaste).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it("does not consume the key when onPlainPaste declines (returns false)", async () => {
    const onPlainPaste = vi.fn(() => false)
    const { ref } = await mount({ onPlainPaste })
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    const event = pressKey(dom, { key: "V", ctrlKey: true, shiftKey: true })
    expect(onPlainPaste).toHaveBeenCalledTimes(1)
    // Declined → the browser's native "paste and match style" proceeds.
    expect(event.defaultPrevented).toBe(false)
  })

  it("ignores a plain Ctrl+V so the native rich paste stays in effect", async () => {
    const onPlainPaste = vi.fn(() => true)
    const { ref } = await mount({ onPlainPaste })
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    const event = pressKey(dom, { key: "v", ctrlKey: true })
    expect(onPlainPaste).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})

/** Dispatch a `paste` carrying the given clipboard flavors at the editor. */
function dispatchPaste(
  dom: HTMLElement,
  flavors: { html?: string; text?: string }
): void {
  const html = flavors.html ?? ""
  const text = flavors.text ?? ""
  const clipboardData = {
    getData: (type: string) =>
      type === "text/html" ? html : type === "text/plain" ? text : "",
    setData: () => {},
    clearData: () => {},
    types: [html && "text/html", text && "text/plain"].filter(Boolean),
    files: [] as unknown as FileList,
    items: [] as unknown,
  }
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", { value: clipboardData })
  act(() => {
    dom.dispatchEvent(event)
  })
}

describe("RichComposer text paste (plain-text schema)", () => {
  it("pastes a URL as text/plain, not the browser's title-bearing <a> fragment", async () => {
    const { ref } = await mount()
    act(() => ref.current?.focus())
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    // Exactly what a browser writes when a URL is copied from the address bar:
    // the anchor text is the page <title>, so the default HTML parse (no Link
    // mark) would keep the title. We must insert the URL instead.
    dispatchPaste(dom, {
      html: '<a href="https://github.com/">GitHub · Change is constant. GitHub keeps you ahead. · GitHub</a>',
      text: "https://github.com/",
    })
    expect(ref.current?.getText()).toBe("https://github.com/")
  })

  it("preserves structure for content copied from within the editor (data-pm-slice), without blank lines", async () => {
    const { ref } = await mount()
    act(() => ref.current?.focus())
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    // A native ProseMirror copy of two paragraphs: HTML tagged with data-pm-slice,
    // and text/plain "one\n\ntwo" (block separator is "\n\n"). We must defer to
    // the native HTML paste — forcing text/plain would serialize back to
    // "one\n\ntwo", introducing a blank line the composer never had.
    dispatchPaste(dom, {
      html: '<p data-pm-slice="0 0 []">one</p><p>two</p>',
      text: "one\n\ntwo",
    })
    expect(ref.current?.getText()).toBe("one\ntwo")
  })

  it("reconstructs a reference badge pasted from within the composer", async () => {
    const { ref } = await mount()
    act(() => ref.current?.focus())
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    // A real composer copy carries both the slice wrapper and the badge span;
    // defer to ProseMirror so the badge round-trips instead of collapsing to its
    // plain-text token.
    dispatchPaste(dom, {
      html: '<p data-pm-slice="0 0 []"><span data-reference data-ref-type="file" data-ref-id="a.ts" data-label="a.ts" data-uri="file:///a.ts">a.ts</span></p>',
      text: "a.ts",
    })
    expect(JSON.stringify(ref.current?.getJSON())).toContain(
      '"type":"reference"'
    )
  })

  it("hydrates serialized references in a plain-text paste into badges", async () => {
    const { ref } = await mount({ knownInvocations: new Set(["$deploy"]) })
    act(() => ref.current?.focus())
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    // The wire form of a sent message (file link + Codex `$` skill token): the
    // composer must preview the same badges the transcript renders, not the
    // literal serialized text.
    const wire = "see [app.ts](file:///repo/app.ts) and $deploy"
    dispatchPaste(dom, { text: wire })
    const json = JSON.stringify(ref.current?.getJSON())
    expect(json).toContain('"refType":"file"')
    expect(json).toContain('"refType":"skill"')
    // Round-trip: the hydrated badges re-serialize to exactly the pasted text
    // (the `$` trigger survives — never downgraded to `/deploy`).
    expect(ref.current?.getText()).toBe(wire)
  })

  it("pastes a slash word the agent does not advertise as editable text", async () => {
    const { ref } = await mount({ knownInvocations: new Set(["/review"]) })
    act(() => ref.current?.focus())
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    dispatchPaste(dom, { text: "try /notacommand on /tmp/x" })
    expect(JSON.stringify(ref.current?.getJSON())).not.toContain(
      '"type":"reference"'
    )
    expect(ref.current?.getText()).toBe("try /notacommand on /tmp/x")
  })

  it("seeds a slash word as text until the agent's list says it is a command", async () => {
    // The list arrives with the connection, so a composer that seeds before it
    // lands must not guess — and must honor it once it is there.
    const { ref, rerender } = await mount()
    act(() => ref.current?.setText("/review it"))
    expect(JSON.stringify(ref.current?.getJSON())).not.toContain(
      '"type":"reference"'
    )
    expect(ref.current?.getText()).toBe("/review it")

    rerender(<RichComposer ref={ref} knownInvocations={new Set(["/review"])} />)
    act(() => ref.current?.setText("/review it"))
    expect(JSON.stringify(ref.current?.getJSON())).toContain(
      '"refType":"skill"'
    )
    expect(ref.current?.getText()).toBe("/review it")
  })

  it("does not insert text when the host consumes the paste as files", async () => {
    const onPasteFiles = vi.fn(() => true)
    const { ref } = await mount({ onPasteFiles })
    act(() => ref.current?.focus())
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement
    dispatchPaste(dom, { html: "<a href='x'>x</a>", text: "some text" })
    expect(onPasteFiles).toHaveBeenCalledTimes(1)
    expect(ref.current?.getText()).toBe("")
  })
})

describe("RichComposer prompt-history Arrow routing", () => {
  it("routes ArrowUp to onHistoryKeyDown at the document start and consumes it", async () => {
    const onHistoryKeyDown = vi.fn(() => true)
    const { ref } = await mount({ onHistoryKeyDown })
    act(() => ref.current?.setText("hello"))
    act(() => ref.current?.getEditor()?.commands.focus("start"))
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement

    const event = pressKey(dom, { key: "ArrowUp" })

    expect(onHistoryKeyDown).toHaveBeenCalledWith("older", expect.anything())
    expect(event.defaultPrevented).toBe(true)
  })

  it("routes ArrowDown to onHistoryKeyDown at the document end", async () => {
    const onHistoryKeyDown = vi.fn(() => true)
    const { ref } = await mount({ onHistoryKeyDown })
    act(() => ref.current?.setText("hello"))
    act(() => ref.current?.getEditor()?.commands.focus("end"))
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement

    const event = pressKey(dom, { key: "ArrowDown" })

    expect(onHistoryKeyDown).toHaveBeenCalledWith("newer", expect.anything())
    expect(event.defaultPrevented).toBe(true)
  })

  it("leaves the Arrow keys to the caret away from the edge", async () => {
    const onHistoryKeyDown = vi.fn(() => true)
    const { ref } = await mount({ onHistoryKeyDown })
    act(() => ref.current?.setText("hello"))
    // Caret at the END: ArrowUp is not "older" here, so it stays a caret move
    // and the host is never asked.
    act(() => ref.current?.getEditor()?.commands.focus("end"))
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement

    const event = pressKey(dom, { key: "ArrowUp" })

    expect(onHistoryKeyDown).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it("keeps the Arrow keys to the caret between paragraphs of one document", async () => {
    // A native paste can leave the box holding SEVERAL paragraphs. The start of
    // the second one is the start of its block but not of the document, so it
    // is a plain "move up a line" — recalling there would swap the whole draft
    // out from under the caret.
    const onHistoryKeyDown = vi.fn(() => true)
    const { ref } = await mount({ onHistoryKeyDown })
    act(() =>
      ref.current?.setDoc({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "one" }] },
          { type: "paragraph", content: [{ type: "text", text: "two" }] },
        ],
      })
    )
    const editor = ref.current?.getEditor()
    const dom = editor?.view.dom as HTMLElement

    // Start of paragraph two.
    act(() => editor?.commands.setTextSelection(6))
    expect(pressKey(dom, { key: "ArrowUp" }).defaultPrevented).toBe(false)
    // End of paragraph one.
    act(() => editor?.commands.setTextSelection(4))
    expect(pressKey(dom, { key: "ArrowDown" }).defaultPrevented).toBe(false)

    expect(onHistoryKeyDown).not.toHaveBeenCalled()

    // The document's own edges still route: start of the first paragraph,
    // end of the last.
    act(() => editor?.commands.setTextSelection(1))
    pressKey(dom, { key: "ArrowUp" })
    expect(onHistoryKeyDown).toHaveBeenLastCalledWith(
      "older",
      expect.anything()
    )
    act(() => editor?.commands.setTextSelection(9))
    pressKey(dom, { key: "ArrowDown" })
    expect(onHistoryKeyDown).toHaveBeenLastCalledWith(
      "newer",
      expect.anything()
    )
  })

  it("keeps Arrow keys for the IME while a composition is in flight", async () => {
    const onHistoryKeyDown = vi.fn(() => true)
    const { ref } = await mount({ onHistoryKeyDown })
    act(() => ref.current?.setText("ni"))
    act(() => ref.current?.getEditor()?.commands.focus("start"))
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement

    const event = pressKey(dom, { key: "ArrowUp", isComposing: true })

    expect(onHistoryKeyDown).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it("defers to an open menu before history", async () => {
    const onHistoryKeyDown = vi.fn(() => true)
    const onExternalMenuKeyDown = vi.fn(() => true)
    const { ref } = await mount({
      onHistoryKeyDown,
      onExternalMenuKeyDown,
      isExternalMenuOpen: true,
    })
    act(() => ref.current?.setText("hello"))
    act(() => ref.current?.getEditor()?.commands.focus("start"))
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement

    pressKey(dom, { key: "ArrowUp" })

    expect(onExternalMenuKeyDown).toHaveBeenCalled()
    expect(onHistoryKeyDown).not.toHaveBeenCalled()
  })

  it("does not consume the key when the host declines", async () => {
    const onHistoryKeyDown = vi.fn(() => false)
    const { ref } = await mount({ onHistoryKeyDown })
    act(() => ref.current?.setText("hello"))
    act(() => ref.current?.getEditor()?.commands.focus("start"))
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement

    const event = pressKey(dom, { key: "ArrowUp" })

    expect(onHistoryKeyDown).toHaveBeenCalledWith("older", expect.anything())
    expect(event.defaultPrevented).toBe(false)
  })

  it("keeps Shift+Arrow for selection instead of history", async () => {
    const onHistoryKeyDown = vi.fn(() => true)
    const { ref } = await mount({ onHistoryKeyDown })
    act(() => ref.current?.setText("hello"))
    act(() => ref.current?.getEditor()?.commands.focus("start"))
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement

    const event = pressKey(dom, { key: "ArrowUp", shiftKey: true })

    expect(onHistoryKeyDown).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it("keeps Ctrl/Alt+Arrow for word and line jumps", async () => {
    const onHistoryKeyDown = vi.fn(() => true)
    const { ref } = await mount({ onHistoryKeyDown })
    act(() => ref.current?.setText("hello"))
    act(() => ref.current?.getEditor()?.commands.focus("start"))
    const dom = ref.current?.getEditor()?.view.dom as HTMLElement

    expect(
      pressKey(dom, { key: "ArrowUp", ctrlKey: true }).defaultPrevented
    ).toBe(false)
    expect(
      pressKey(dom, { key: "ArrowUp", altKey: true }).defaultPrevented
    ).toBe(false)
    expect(onHistoryKeyDown).not.toHaveBeenCalled()
  })
})

/**
 * Guards the sizing contract the mobile-web composer regressed on (#746).
 *
 * jsdom has no layout engine, so these assert the declared box model rather
 * than measured pixels — the real geometry is covered by the manual pass
 * described in the PR. What they do catch is the exact edit that broke it:
 * swapping a content flex basis back to a zero one, which lets an engine that
 * distributes no free space in a min-height-only flex column collapse the
 * editable area to 0px.
 */
describe("RichComposer editable-area sizing (#746)", () => {
  it("grows the editable area off a content basis, never a zero basis", async () => {
    const { container } = await mount()
    const scroll = container.querySelector(".codeg-composer-scroll")
    expect(scroll).not.toBeNull()

    const classes = scroll!.className.split(/\s+/)
    // `flex-1` is `flex: 1 1 0%`. With nothing to grow into, that zero basis is
    // the collapsed, untappable composer from #746.
    expect(classes).not.toContain("flex-1")
    expect(classes).toContain("grow")
    // Still free to shrink and scroll when the composer hits its max height.
    expect(classes).toContain("min-h-0")
    expect(classes).toContain("overflow-y-auto")
  })

  it("lets the contenteditable fill the editable area so taps land on it", async () => {
    const { container } = await mount()
    const scroll = container.querySelector(".codeg-composer-scroll")
    const editable = container.querySelector('[contenteditable="true"]')
    expect(editable).not.toBeNull()

    // The scroll area is the column the editable node grows inside of.
    const scrollClasses = scroll!.className.split(/\s+/)
    expect(scrollClasses).toContain("flex")
    expect(scrollClasses).toContain("flex-col")
    // …and the editable node is the child that takes the leftover, so the
    // blank space under a short draft is still the contenteditable and a tap
    // there focuses it natively (touch has no chrome-mousedown fallback).
    expect(editable!.className.split(/\s+/)).toContain("grow")
    expect(scroll!.contains(editable)).toBe(true)
  })
})
