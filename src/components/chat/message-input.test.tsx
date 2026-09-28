import {
  render,
  screen,
  waitFor,
  within,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import type { ComponentProps } from "react"
import type { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { RichComposerHandle } from "./composer/rich-composer"
import {
  serializeDocToDisplayText,
  serializeDocToText,
} from "./composer/to-prompt-blocks"
import {
  clearMessageInputDraftV2,
  loadMessageInputDraftV2,
} from "@/lib/message-input-draft"
import {
  emitAttachFileToSession,
  emitAttachPageToSession,
  emitAttachSessionToSession,
} from "@/lib/session-attachment-events"
import type { DbConversationSummary } from "@/lib/types"

// MessageInput holds its RichComposer handle internally and does not forward a
// ref, so capture that handle through a partial mock that still renders the real
// composer. The "insertion position" tests below drive the very Tiptap editor
// the attach-to-chat event writes into — setting its content + caret — then
// assert where the badge lands.
const composerHandle = vi.hoisted(() => ({
  current: null as RichComposerHandle | null,
}))
vi.mock("./composer/rich-composer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./composer/rich-composer")>()
  const React = await import("react")
  const Captured = React.forwardRef<
    RichComposerHandle,
    ComponentProps<typeof actual.RichComposer>
  >((props, ref) => {
    const assign = (handle: RichComposerHandle | null) => {
      composerHandle.current = handle
      if (typeof ref === "function") ref(handle)
      else if (ref) ref.current = handle
    }
    return React.createElement(actual.RichComposer, { ...props, ref: assign })
  })
  Captured.displayName = "CapturedRichComposer"
  return { ...actual, RichComposer: Captured }
})

// Mock the data hooks / platform so MessageInput mounts without hitting the
// backend. The reference-search provider and slash sources are all empty: this
// is a wiring smoke test (does the RichComposer-based input mount and reflect
// empty/send state), not a data test.
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { send_message: "enter", newline_in_message: "shift+enter" },
  }),
}))
// A vi.fn (not a bare arrow) so the `$` autocomplete tests can land the disk
// scan mid-test; defaults to "no skills" for every other test in this file.
const agentSkills = vi.hoisted(() => vi.fn(() => [] as unknown[]))
vi.mock("@/hooks/use-agent-skills", () => ({ useAgentSkills: agentSkills }))
vi.mock("@/hooks/use-built-in-experts", () => ({ useBuiltInExperts: () => [] }))
vi.mock("@/hooks/use-built-in-science", () => ({ useBuiltInScience: () => [] }))
vi.mock("@/hooks/use-enabled-skill-ids", () => ({
  useEnabledSkillIds: () => ({
    enabledIds: new Set(),
    ready: false,
    supported: true,
  }),
}))
vi.mock("@/components/chat/composer/use-reference-search", () => ({
  useReferenceSearch: () => async () => [],
}))
const folderPickerVisible = vi.hoisted(() => vi.fn(() => false))
vi.mock("@/components/chat/conversation-context-bar", () => ({
  ConversationContextBar: ({
    extraContent,
  }: {
    extraContent?: React.ReactNode
  }) => <div data-testid="ctx-bar">{extraContent}</div>,
  // The composer imports these to render the below-input folder/branch row.
  // Hidden by default; the cold-start test resolves it after the editor mounts.
  ConversationFolderBranchPicker: () => null,
  useConversationFolderBranchPickerVisible: folderPickerVisible,
}))
vi.mock("./composer-context-usage", () => ({
  ComposerContextUsage: () => null,
}))
vi.mock("./composer-connection-status", () => ({
  ComposerConnectionStatus: () => null,
}))
// The platform opener is the DESKTOP arm of the shared opener; this suite runs
// in web mode, where a system-browser target lands on `window.open` instead.
const platform = vi.hoisted(() => ({ openUrl: vi.fn(async () => {}) }))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
  openFileDialog: vi.fn(),
  openUrl: platform.openUrl,
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
}))
// A local-file link target routes to the workspace file column, whose provider
// this suite deliberately renders without.
vi.mock("@/hooks/use-open-file-target", () => ({
  useOpenFileTarget: () => async () => {},
}))
// The right-click menu refreshes the quick-message list as it opens; keep that
// off the backend so the menu tests exercise only the menu.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  quickMessagesList: vi.fn(async () => []),
}))
// Real classifier only recognizes actual backend NoActiveTurn payloads; the
// steering tests flip this per-case to drive the enqueue fallback.
vi.mock("@/lib/turn-busy", () => ({
  isNoActiveTurnRejection: vi.fn(() => false),
}))
// Nothing here mounts a Toaster, so toasts would vanish silently — record them
// instead. The steering tests assert the uploading gate's honest signal.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}))
// Wrap-mock (rich-composer pattern above): render the REAL attachments hook,
// but let a test stage image attachments — the drop/paste pipelines that
// normally populate them need real files and upload endpoints.
type ComposerAttachmentsApi = ReturnType<
  typeof import("./composer/use-composer-attachments").useComposerAttachments
>
const attachmentsOverride = vi.hoisted(() => ({
  current: null as Partial<ComposerAttachmentsApi> | null,
}))
vi.mock("./composer/use-composer-attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./composer/use-composer-attachments")>()
  return {
    ...actual,
    useComposerAttachments: (
      ...args: Parameters<typeof actual.useComposerAttachments>
    ) => {
      const real = actual.useComposerAttachments(...args)
      const override = attachmentsOverride.current
      return override ? { ...real, ...override } : real
    },
  }
})
// virtua renders 0 rows under jsdom — render children directly so the large
// (searchable + virtualized) model list is exercisable here too.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react")
  return {
    Virtualizer: forwardRef(function VirtualizerMock(
      props: { children?: React.ReactNode },
      ref: React.Ref<{ scrollToIndex: () => void }>
    ) {
      useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }))
      return <>{props.children}</>
    }),
  }
})

// ModelOptionList mounts virtua only after the OverlayScrollbars viewport is
// surfaced via `onViewportRef`; jsdom never initializes OS, so drive it here.
vi.mock("@/components/ui/scroll-area", async () => {
  const { useEffect } = await import("react")
  return {
    ScrollArea: ({
      children,
      onViewportRef,
    }: {
      children?: React.ReactNode
      onViewportRef?: (el: HTMLElement | null) => void
    }) => {
      useEffect(() => {
        onViewportRef?.(document.createElement("div"))
      }, [onViewportRef])
      return <>{children}</>
    },
  }
})

// ModelOptionList sizes its scroll window in rem, so it reads the live zoom
// level — which throws outside an AppearanceProvider, and this suite renders the
// composer bare. Pin it at 100% (1rem = 16px). Spread the real module so the
// other appearance hooks keep their real (provider-requiring) behaviour instead
// of silently resolving to `undefined` if something here starts using one.
vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

import enMessages from "@/i18n/messages/en.json"
import type {
  PromptCapabilitiesInfo,
  SessionConfigOptionInfo,
} from "@/lib/types"

import { MessageInput } from "./message-input"
import {
  composerBoxMinHeight,
  composerEditableMinHeight,
} from "./composer/composer-sizing"

const CAPS: PromptCapabilitiesInfo = {
  image: true,
  audio: false,
  embedded_context: true,
}

/**
 * Dispatch a pointer-driven event that actually names its `pointerType`. jsdom
 * ships no `PointerEvent`, so `fireEvent.pointerDown(el, { pointerType })`
 * silently drops the property and every event reads as an unnamed one; React
 * takes `pointerType` straight off the native event, so setting it by hand on a
 * MouseEvent is what the composer's handlers actually see in a browser.
 */
function firePointer(
  element: Element,
  type: "pointerdown" | "click",
  pointerType: "mouse" | "touch" | "pen"
): boolean {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  return fireEvent(element, event)
}

function renderInput(
  props: Partial<React.ComponentProps<typeof MessageInput>>
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageInput onSend={vi.fn()} promptCapabilities={CAPS} {...props} />
    </NextIntlClientProvider>
  )
}

describe("MessageInput (RichComposer integration)", () => {
  afterEach(() => cleanup())

  it("mounts and renders the rich-text composer surface", async () => {
    const { container } = renderInput({})
    await waitFor(
      () => expect(container.querySelector('[role="textbox"]')).not.toBeNull(),
      { timeout: 5000 }
    )
    const textbox = container.querySelector('[role="textbox"]')
    expect(textbox).toHaveAttribute("aria-multiline", "true")
  })

  it("disables Send while the composer is empty and has no attachments", async () => {
    const { container } = renderInput({})
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )
    const sendButton = container.querySelector<HTMLButtonElement>(
      `button[title="${enMessages.Folder.chat.messageInput.send}"]`
    )
    expect(sendButton).not.toBeNull()
    expect(sendButton).toBeDisabled()
  })

  it("claims a mouse press on the input's empty chrome (P8d focus wiring)", async () => {
    const { container } = renderInput({})
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )
    // The bordered card carries the chrome-focus handler; a press on the card
    // itself (not on the editor or a control) is claimed via preventDefault
    // before refocusing the editor. Asserting preventDefault (fireEvent returns
    // false when the event was canceled) avoids relying on jsdom focus.
    const card = container.querySelector('[class~="@container"]') as HTMLElement
    expect(card).not.toBeNull()
    // The same box paints the text I-beam across its blank chrome (see the
    // `.codeg-composer-chrome` rule in globals.css).
    expect(card.className).toContain("codeg-composer-chrome")
    expect(firePointer(card, "pointerdown", "mouse")).toBe(false)
  })

  // A tap's compatibility `mousedown` lands after the gesture has resolved, and
  // cancelling it — which the mouse path above must do — is itself enough to
  // stop the soft keyboard coming up. So touch must NOT go through the press
  // path; it gets the caret from the `click` the tap produces instead.
  it("leaves a touch press on the chrome alone and focuses on the tap", async () => {
    const { container } = renderInput({})
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )
    const card = container.querySelector('[class~="@container"]') as HTMLElement
    const editor = container.querySelector('[role="textbox"]') as HTMLElement

    // Not claimed: no preventDefault, so the browser's own tap handling runs.
    expect(firePointer(card, "pointerdown", "touch")).toBe(true)
    expect(document.activeElement).not.toBe(editor)

    // The tap itself is what puts the caret in the editor.
    firePointer(card, "click", "touch")
    await waitFor(() => expect(document.activeElement).toBe(editor))
  })

  // The press already focused a mouse; focusing again on release would collapse
  // a selection dragged out of the chrome.
  it("ignores a mouse click on the chrome (the press owns it)", async () => {
    const { container } = renderInput({})
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )
    const card = container.querySelector('[class~="@container"]') as HTMLElement
    const editor = container.querySelector('[role="textbox"]') as HTMLElement

    firePointer(card, "click", "mouse")
    expect(document.activeElement).not.toBe(editor)
    // An event that names no pointer kind at all counts as a mouse too.
    fireEvent.click(card)
    expect(document.activeElement).not.toBe(editor)
  })

  // A browser with no Pointer Events dispatches no `pointerdown` and names no
  // pointer kind on its clicks, so both paths above stand down and plain
  // `mousedown` is all there is — jsdom is exactly such an environment, which
  // is what lets this assert the fallback rather than describe it.
  it("falls back to mousedown where the browser has no pointer events", async () => {
    expect("PointerEvent" in window).toBe(false)
    const { container } = renderInput({})
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )
    const card = container.querySelector('[class~="@container"]') as HTMLElement
    const editor = container.querySelector('[role="textbox"]') as HTMLElement

    // Claimed (preventDefault) and focused, the way it behaved before the
    // press/tap split.
    expect(fireEvent.mouseDown(card)).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(editor))
  })

  // A tap on a control inside the box must reach the control, not be swallowed
  // into "put the caret here" — same exclusion the mouse path has always had.
  it("leaves a touch tap on a control inside the box to the control", async () => {
    const { container } = renderInput({ isPrompting: true, onCancel: vi.fn() })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )
    const stop = container.querySelector(
      `button[title="${enMessages.Folder.chat.messageInput.cancel}"]`
    ) as HTMLElement
    expect(stop).not.toBeNull()

    const editor = container.querySelector('[role="textbox"]') as HTMLElement
    firePointer(stop, "click", "touch")
    expect(document.activeElement).not.toBe(editor)
  })
})

describe("MessageInput attach-to-chat insertion position", () => {
  afterEach(() => {
    cleanup()
    composerHandle.current = null
  })

  async function mountWithEditor() {
    renderInput({ attachmentTabId: "tab-1" })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    return editor
  }

  // Seed "hello world" and drop the caret right after "hello" (pos 6), so an
  // insertion at the caret lands between the two words while an append would
  // land after "world".
  function seedWithMidCaret(editor: Editor) {
    act(() => {
      editor.commands.setContent("hello world")
      editor.commands.setTextSelection(6)
    })
  }

  function assertBetweenHelloAndWorld(text: string, link: string) {
    const at = text.indexOf(link)
    expect(at).toBeGreaterThanOrEqual(0)
    // Caret insertion: "hello" precedes the badge and "world" follows it.
    // (An end-of-doc append would put "world" before the link, failing the
    // second assertion.)
    expect(text.slice(0, at)).toContain("hello")
    expect(text.slice(at + link.length)).toContain("world")
  }

  it("drops an attached whole-file badge at the caret, not the end", async () => {
    const editor = await mountWithEditor()
    seedWithMidCaret(editor)
    act(() => {
      emitAttachFileToSession({ tabId: "tab-1", path: "/repo/app.ts" })
    })
    const link = "[app.ts](file:///repo/app.ts)"
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toContain(link)
    )
    assertBetweenHelloAndWorld(serializeDocToText(editor.state.doc), link)
  })

  it("drops a ranged selection badge at the caret, not the end", async () => {
    const editor = await mountWithEditor()
    seedWithMidCaret(editor)
    act(() => {
      emitAttachFileToSession({
        tabId: "tab-1",
        path: "/repo/app.ts",
        range: { start: 10, end: 25 },
      })
    })
    const link = "[app.ts:10-25](file:///repo/app.ts#L10-25)"
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toContain(link)
    )
    assertBetweenHelloAndWorld(serializeDocToText(editor.state.doc), link)
  })

  // The built-in browser's "send to chat". The block is page content, so it
  // goes behind a badge rather than into the prose — but only where the agent
  // takes embedded context; the alternative there would be an agent silently
  // receiving nothing at all.
  it("puts a handed-over page behind a badge", async () => {
    const editor = await mountWithEditor()
    seedWithMidCaret(editor)
    act(() => {
      emitAttachPageToSession({
        tabId: "tab-1",
        label: "button#export",
        text: "Captured from a web page…\n\n- element: button#export",
        uri: "https://example.com/orders",
      })
    })
    // The DISPLAY serialization, which is the one that keeps an embedded
    // badge inline; the send serialization drops it and appends the real
    // bytes-bearing block instead.
    await waitFor(() =>
      expect(serializeDocToDisplayText(editor.state.doc)).toContain(
        "button#export"
      )
    )
    const text = serializeDocToDisplayText(editor.state.doc)
    // A badge, not the block itself — one that carries the page's address,
    // which is what the sent message lists under the bubble.
    expect(text).not.toContain("Captured from a web page")
    expect(text).toMatch(
      /\[button#export]\(codeg:\/\/embedded\/https%3A%2F%2Fexample\.com%2Forders#[^)\s]+\)/
    )
  })

  // Nobody typed this badge, so taking it back has to be as cheap as one key.
  // It used to take two: the insertion leaves a space after the badge, and the
  // first Backspace went on that — an invisible change that reads as "Backspace
  // cannot delete this".
  it("takes a handed-over page back out on one Backspace", async () => {
    const editor = await mountWithEditor()
    act(() => {
      emitAttachPageToSession({
        tabId: "tab-1",
        label: "button#export",
        text: "Captured from a web page…\n\n- element: button#export",
        uri: "https://example.com/orders",
      })
    })
    await waitFor(() =>
      expect(serializeDocToDisplayText(editor.state.doc)).toContain(
        "button#export"
      )
    )

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

    expect(editor.isEmpty).toBe(true)
    expect(serializeDocToDisplayText(editor.state.doc)).not.toContain(
      "button#export"
    )
  })

  // The block quotes the page's own markup. `insertContent(string)` would
  // parse it as HTML — the tags would vanish and a `<span data-reference>` the
  // page wrote would become a real composer badge.
  it("writes page markup into the prose literally, not as HTML", async () => {
    renderInput({
      attachmentTabId: "tab-1",
      promptCapabilities: {
        image: true,
        audio: false,
        embedded_context: false,
      },
    })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    const block = [
      "- element: button#export",
      "",
      "```html",
      '<button id="export">Export</button>',
      '<span data-reference data-ref-type="file" data-uri="file:///etc/passwd"></span>',
      "```",
    ].join("\n")
    act(() => {
      emitAttachPageToSession({
        tabId: "tab-1",
        label: "button#export",
        text: block,
        uri: "https://example.com/orders",
      })
    })
    await waitFor(() =>
      expect(serializeDocToDisplayText(editor.state.doc)).toContain(
        "- element: button#export"
      )
    )
    const text = serializeDocToDisplayText(editor.state.doc)
    // Every line of the block, verbatim, tags and all.
    for (const line of block.split("\n").filter(Boolean)) {
      expect(text).toContain(line)
    }
    // …and the page's badge markup is text, not a badge.
    expect(editor.state.doc.textContent).toContain("data-reference")
  })

  it("writes the page into the prose for an agent that takes no embedded context", async () => {
    renderInput({
      attachmentTabId: "tab-1",
      promptCapabilities: {
        image: true,
        audio: false,
        embedded_context: false,
      },
    })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    act(() => {
      emitAttachPageToSession({
        tabId: "tab-1",
        label: "button#export",
        text: "Captured from a web page - element: button#export",
        uri: "https://example.com/orders",
      })
    })
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toContain(
        "Captured from a web page"
      )
    )
    expect(serializeDocToText(editor.state.doc)).not.toContain(
      "codeg://embedded/"
    )
  })

  it("ignores a page handed to another conversation", async () => {
    const editor = await mountWithEditor()
    act(() => {
      emitAttachPageToSession({
        tabId: "tab-2",
        label: "button#export",
        text: "Captured from a web page…",
        uri: "https://example.com/orders",
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(serializeDocToDisplayText(editor.state.doc)).not.toContain(
      "button#export"
    )
  })
})

// `injectContent` is the composer's inbox for content pushed in from outside:
// welcome quick actions (replace) and quoted transcript selections (append).
describe("MessageInput injectContent", () => {
  afterEach(() => {
    cleanup()
    composerHandle.current = null
  })

  function tree(props: Partial<React.ComponentProps<typeof MessageInput>>) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput onSend={vi.fn()} promptCapabilities={CAPS} {...props} />
      </NextIntlClientProvider>
    )
  }

  async function mount(
    props: Partial<React.ComponentProps<typeof MessageInput>>
  ) {
    const view = render(tree(props))
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    return { view, editor }
  }

  it("appends a quote after an existing draft, separated by a blank line", async () => {
    const onInjectConsumed = vi.fn()
    const { view, editor } = await mount({ onInjectConsumed })
    act(() => {
      editor.commands.setContent("what does this mean?")
    })

    view.rerender(
      tree({
        onInjectConsumed,
        injectContent: { text: "> quoted bit", mode: "append" },
      })
    )

    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toBe(
        "what does this mean?\n\n> quoted bit\n\n"
      )
    )
    expect(onInjectConsumed).toHaveBeenCalled()
  })

  it("appends a quote into an empty composer with no leading gap", async () => {
    const { view, editor } = await mount({})
    view.rerender(
      tree({ injectContent: { text: "> quoted bit", mode: "append" } })
    )
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toBe("> quoted bit\n\n")
    )
  })

  it("still replaces the whole document in the default mode", async () => {
    const { view, editor } = await mount({})
    act(() => {
      editor.commands.setContent("draft to be replaced")
    })
    view.rerender(tree({ injectContent: { text: "quick action prompt" } }))
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toBe("quick action prompt")
    )
  })
})

// The sidebar's "add to session" drops a session mention — the same reference the
// `@` panel's Sessions group builds — into the active tab's composer.
describe("MessageInput session-mention attach", () => {
  afterEach(() => {
    cleanup()
    composerHandle.current = null
  })

  function summary(id: number, title: string | null): DbConversationSummary {
    return {
      id,
      folder_id: 1,
      title,
      title_locked: false,
      agent_type: "claude_code",
      status: "pending",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: 0,
      child_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      pinned_at: null,
    }
  }

  async function mountWithEditor() {
    renderInput({ attachmentTabId: "tab-1" })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    return editor
  }

  it("drops a session badge at the caret, not the end", async () => {
    const editor = await mountWithEditor()
    act(() => {
      editor.commands.setContent("hello world")
      editor.commands.setTextSelection(6)
    })
    act(() => {
      emitAttachSessionToSession({
        tabId: "tab-1",
        conversation: summary(42, "Fix auth"),
      })
    })
    const link = "[Fix auth](codeg://session/42)"
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toContain(link)
    )
    const text = serializeDocToText(editor.state.doc)
    const at = text.indexOf(link)
    expect(text.slice(0, at)).toContain("hello")
    expect(text.slice(at + link.length)).toContain("world")
  })

  it("falls back to #id for an untitled conversation", async () => {
    const editor = await mountWithEditor()
    act(() => {
      emitAttachSessionToSession({
        tabId: "tab-1",
        conversation: summary(7, "   "),
      })
    })
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toContain(
        "[#7](codeg://session/7)"
      )
    )
  })

  it("ignores an event addressed to another tab", async () => {
    const editor = await mountWithEditor()
    act(() => {
      emitAttachSessionToSession({
        tabId: "other-tab",
        conversation: summary(42, "Fix auth"),
      })
    })
    expect(serializeDocToText(editor.state.doc)).not.toContain(
      "codeg://session/42"
    )
  })

  it("does not stack a second badge for the same session", async () => {
    const editor = await mountWithEditor()
    const conversation = summary(42, "Fix auth")
    act(() => {
      emitAttachSessionToSession({ tabId: "tab-1", conversation })
    })
    const link = "[Fix auth](codeg://session/42)"
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toContain(link)
    )
    act(() => {
      emitAttachSessionToSession({ tabId: "tab-1", conversation })
    })
    const text = serializeDocToText(editor.state.doc)
    expect(text.indexOf(link)).toBe(text.lastIndexOf(link))
  })
})

describe("MessageInput file-tree drag-and-drop", () => {
  afterEach(() => {
    cleanup()
    composerHandle.current = null
  })

  // A minimal DataTransfer carrying a file-tree drag: the private JSON payload
  // plus a text/plain absolute-path fallback (jsdom's DataTransfer can't do
  // setData/getData/types faithfully).
  function treeDrag(payload: {
    rootPath: string
    relPath: string
    absPath: string
    name: string
    kind: "file" | "dir"
  }) {
    const store = new Map<string, string>([
      ["application/x-codeg-tree-entry", JSON.stringify(payload)],
      ["text/plain", payload.absPath],
    ])
    return {
      getData: (f: string) => store.get(String(f).toLowerCase()) ?? "",
      setData: (f: string, v: string) => store.set(String(f).toLowerCase(), v),
      get types() {
        return Array.from(store.keys())
      },
      dropEffect: "none",
      effectAllowed: "all",
      files: [] as File[],
      items: [] as DataTransferItem[],
    }
  }

  async function mountWithHost() {
    const { container } = renderInput({ attachmentTabId: "tab-1" })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    const host = container.firstElementChild as HTMLElement
    return { editor, host }
  }

  const OVERLAY = enMessages.Folder.chat.messageInput.dropFilesToAttach
  const PAYLOAD = {
    rootPath: "/repo",
    relPath: "src/app.ts",
    absPath: "/repo/src/app.ts",
    name: "app.ts",
    kind: "file" as const,
  }
  const LINK = "[app.ts](file:///repo/src/app.ts)"

  it("inserts a single reference (no literal path) when dropped on the chrome", async () => {
    const { editor, host } = await mountWithHost()
    const dt = treeDrag(PAYLOAD)

    act(() => {
      fireEvent.dragOver(host, { dataTransfer: dt })
    })
    // The drag overlay shows while a valid drag hovers the composer.
    expect(screen.queryByText(OVERLAY)).not.toBeNull()

    act(() => {
      fireEvent.drop(host, { dataTransfer: dt })
    })
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toContain(LINK)
    )
    // Exactly one reference and no stray text/plain absolute-path insertion.
    expect(serializeDocToText(editor.state.doc).trim()).toBe(LINK)
    // The overlay is cleared by the drop.
    expect(screen.queryByText(OVERLAY)).toBeNull()
  })

  it("clears the overlay and inserts once when dropped on the editor surface", async () => {
    const { editor, host } = await mountWithHost()
    const textbox = host.querySelector('[role="textbox"]') as HTMLElement
    const dt = treeDrag(PAYLOAD)

    // Hover raises the overlay (container-level dragover)…
    act(() => {
      fireEvent.dragOver(host, { dataTransfer: dt })
    })
    expect(screen.queryByText(OVERLAY)).not.toBeNull()

    // …then drop directly on the editor. Whether ProseMirror's handleDrop
    // consumes it (stopping propagation) or it bubbles to the container, the
    // result must be one reference and no lingering overlay — the regression
    // being that an editor-consumed drop left the overlay stuck.
    act(() => {
      fireEvent.drop(textbox, { dataTransfer: dt })
    })
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).toContain(LINK)
    )
    expect(serializeDocToText(editor.state.doc).trim()).toBe(LINK)
    expect(screen.queryByText(OVERLAY)).toBeNull()
  })
})

// When the composer is narrow the model/config/mode selectors collapse behind a
// cog button into a single Popover that renders a master–detail panel: the
// settings on the left, the active setting's options (plain buttons) on the
// right. This is the WebKit-safe replacement for the old nested dropdown/submenu
// — a nested Radix dismissable layer drops the selection on WKWebView, so the
// options are plain <button>s in the one popover layer. jsdom has no layout, so
// the container-query-hidden wide row stays hidden and this collapsed path is
// what renders here.
const MODEL_OPTION: SessionConfigOptionInfo = {
  id: "model",
  name: "Model",
  description: "Pick the model",
  category: null,
  kind: {
    type: "select",
    current_value: "default",
    options: [
      { value: "default", name: "Default", description: "Use the default" },
      { value: "opus", name: "Opus", description: "Most capable" },
    ],
    groups: [],
  },
}

const MSGS = enMessages.Folder.chat.messageInput

// Cline 3.0.50's `auto_approve` — the first boolean config option any pinned
// agent ships. Both the wide inline row and the collapsed popover are always in
// the DOM (a container query, which jsdom does not evaluate, picks one), so a
// single render exercises both surfaces.
const AUTO_APPROVE_OPTION: SessionConfigOptionInfo = {
  id: "auto_approve",
  name: "Auto-approve tools",
  description: "Automatically approve all tool calls without asking",
  category: null,
  kind: { type: "boolean", current_value: false },
}

describe("MessageInput boolean config options", () => {
  afterEach(() => cleanup())

  it("renders the inline chip as a toggle and flips it on click", async () => {
    const user = userEvent.setup()
    const onConfigOptionChange = vi.fn()
    const { container } = renderInput({
      configOptions: [AUTO_APPROVE_OPTION],
      onConfigOptionChange,
    })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )

    const toggle = screen.getByRole("button", {
      name: `Auto-approve tools: ${MSGS.toggleOff}`,
    })
    expect(toggle).toHaveAttribute("aria-pressed", "false")

    await user.click(toggle)
    expect(onConfigOptionChange).toHaveBeenCalledWith("auto_approve", "true")
  })

  it("offers On/Off rows in the collapsed cog popover", async () => {
    const user = userEvent.setup()
    const onConfigOptionChange = vi.fn()
    const { container } = renderInput({
      configOptions: [AUTO_APPROVE_OPTION],
      onConfigOptionChange,
    })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )

    const settingsLabel = MSGS.agentSettings
    await user.click(screen.getByRole("button", { name: settingsLabel }))
    const popover = await screen.findByRole("dialog", { name: settingsLabel })

    // The left rail summarizes the current state…
    expect(
      within(popover).getByRole("button", { name: /Auto-approve tools/ })
    ).toBeInTheDocument()
    // …and the detail pane is a plain two-item choice.
    await user.click(
      within(popover).getByRole("button", { name: MSGS.toggleOn })
    )
    expect(onConfigOptionChange).toHaveBeenCalledWith("auto_approve", "true")
  })
})

describe("MessageInput selector loading placeholder", () => {
  afterEach(() => cleanup())

  it("shows a visible placeholder in the selector row while the session comes up", async () => {
    // Opening a historical conversation spends seconds with no selectors known.
    // The cue has to be in the row itself — the cog popover's loading text is
    // only reachable by a user who already suspects something is loading.
    const { container } = renderInput({
      configOptionsLoading: true,
      configOptions: [],
    })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )
    expect(
      screen.getByRole("status", { name: MSGS.loadingSettings })
    ).toBeInTheDocument()
  })

  it("drops the placeholder as soon as the real options arrive", async () => {
    const view = renderInput({
      configOptionsLoading: true,
      configOptions: [],
    })
    await waitFor(() =>
      expect(view.container.querySelector('[role="textbox"]')).not.toBeNull()
    )
    expect(screen.queryByRole("status")).not.toBeNull()

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={vi.fn()}
          promptCapabilities={CAPS}
          configOptionsLoading={false}
          configOptions={[MODEL_OPTION]}
        />
      </NextIntlClientProvider>
    )
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByRole("button", { name: /Model/ })).toBeInTheDocument()
  })

  it("renders no selector affordance at all when nothing is loading or known", async () => {
    // The pre-fix steady state: an agent with neither modes nor config options
    // must not grow a placeholder that never resolves.
    const { container } = renderInput({ configOptions: [], modes: [] })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )
    expect(screen.queryByRole("status")).toBeNull()
    expect(
      screen.queryByRole("button", { name: MSGS.agentSettings })
    ).toBeNull()
  })
})

describe("MessageInput collapsed selectors popover", () => {
  afterEach(() => cleanup())

  it("selects a config option from the cog Popover and closes it", async () => {
    const user = userEvent.setup()
    const onConfigOptionChange = vi.fn()
    const { container } = renderInput({
      configOptions: [MODEL_OPTION],
      onConfigOptionChange,
    })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )

    const settingsLabel = enMessages.Folder.chat.messageInput.agentSettings
    await user.click(screen.getByRole("button", { name: settingsLabel }))

    const popover = await screen.findByRole("dialog", { name: settingsLabel })
    // The left rail shows the setting as a title + current value row.
    expect(
      within(popover).getByRole("button", { name: /Model/ })
    ).toBeInTheDocument()

    // Options are plain buttons (native clicks) — selecting fires the change.
    await user.click(within(popover).getByRole("button", { name: /Opus/ }))
    expect(onConfigOptionChange).toHaveBeenCalledWith("model", "opus")

    // Selecting a value closes the controlled popover.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: settingsLabel })).toBeNull()
    )
  })

  it("groups model values by their provider prefix in the cog Popover", async () => {
    const user = userEvent.setup()
    const onConfigOptionChange = vi.fn()
    const groupedModel: SessionConfigOptionInfo = {
      id: "model",
      name: "Model",
      description: "Pick the model",
      category: null,
      kind: {
        type: "select",
        current_value: "anthropic/claude-opus",
        options: [
          {
            value: "anthropic/claude-opus",
            name: "anthropic/claude-opus",
            description: null,
          },
          { value: "openai/gpt-4o", name: "openai/gpt-4o", description: null },
        ],
        groups: [],
      },
    }
    const { container } = renderInput({
      configOptions: [groupedModel],
      onConfigOptionChange,
    })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )

    const settingsLabel = enMessages.Folder.chat.messageInput.agentSettings
    await user.click(screen.getByRole("button", { name: settingsLabel }))
    const popover = await screen.findByRole("dialog", { name: settingsLabel })

    // The detail pane carries one header per provider namespace…
    expect(within(popover).getByText("anthropic")).toBeInTheDocument()
    expect(within(popover).getByText("openai")).toBeInTheDocument()

    // …and the option label drops the redundant `openai/` prefix, while the
    // committed value stays the full id. (Pick the non-current model so its
    // label is unique to the detail pane, not echoed in the left-rail summary.)
    await user.click(within(popover).getByRole("button", { name: /gpt-4o/ }))
    expect(onConfigOptionChange).toHaveBeenCalledWith("model", "openai/gpt-4o")
  })

  it("uses a searchable virtualized list for a long model list", async () => {
    const user = userEvent.setup()
    const onConfigOptionChange = vi.fn()
    const options = Array.from({ length: 30 }, (_, i) => ({
      value: `openrouter/model-${i}`,
      name: `openrouter/model-${i}`,
      description: null,
    }))
    const bigModel: SessionConfigOptionInfo = {
      id: "model",
      name: "Model",
      description: null,
      category: null,
      kind: {
        type: "select",
        current_value: "openrouter/model-0",
        options,
        groups: [],
      },
    }
    const { container } = renderInput({
      configOptions: [bigModel],
      onConfigOptionChange,
    })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )

    const settingsLabel = enMessages.Folder.chat.messageInput.agentSettings
    await user.click(screen.getByRole("button", { name: settingsLabel }))
    const popover = await screen.findByRole("dialog", { name: settingsLabel })

    // A long list (> threshold) renders the searchable combobox, not plain rows.
    const search = within(popover).getByRole("combobox")
    await user.type(search, "model-17")
    // Filtering narrows to the one match; the full id is committed on click.
    await user.click(within(popover).getByRole("option", { name: /model-17/ }))
    expect(onConfigOptionChange).toHaveBeenCalledWith(
      "model",
      "openrouter/model-17"
    )
  })

  it("selects a mode from the cog Popover and closes it", async () => {
    const user = userEvent.setup()
    const onModeChange = vi.fn()
    const { container } = renderInput({
      modes: [
        { id: "plan", name: "Plan", description: "Plan first" },
        { id: "act", name: "Act", description: "Act now" },
      ],
      selectedModeId: "plan",
      onModeChange,
    })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )

    const settingsLabel = enMessages.Folder.chat.messageInput.agentSettings
    await user.click(screen.getByRole("button", { name: settingsLabel }))

    const popover = await screen.findByRole("dialog", { name: settingsLabel })
    await user.click(within(popover).getByRole("button", { name: /Act/ }))
    expect(onModeChange).toHaveBeenCalledWith("act")

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: settingsLabel })).toBeNull()
    )
  })
})

// The `/` list is the agent's own `availableCommands`, which only arrive with
// the connection. The editor is typable throughout that wait, so a `/` typed
// mid-connect opens the panel on a loading row instead of doing nothing.
describe("MessageInput slash menu while the agent connects", () => {
  afterEach(() => {
    cleanup()
    composerHandle.current = null
  })

  const LOADING = enMessages.Folder.chat.messageInput.slashLoading
  const COMMANDS = [{ name: "compact", description: "Compact the thread" }]

  async function mountAndType(
    props: Partial<React.ComponentProps<typeof MessageInput>>,
    text = "/"
  ) {
    const view = renderInput(props)
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    act(() => {
      editor.commands.insertContent(text)
    })
    return { editor, view }
  }

  function rerenderInput(
    view: ReturnType<typeof renderInput>,
    props: Partial<React.ComponentProps<typeof MessageInput>>
  ) {
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput onSend={vi.fn()} promptCapabilities={CAPS} {...props} />
      </NextIntlClientProvider>
    )
  }

  it("opens the panel on a loading row while commands are still on their way", async () => {
    await mountAndType({ commandsLoading: true, availableCommands: [] })
    const menu = await screen.findByTestId("slash-menu")
    expect(within(menu).getByText(LOADING)).toBeInTheDocument()
  })

  it("replaces the loading row with the commands once they land", async () => {
    const { view } = await mountAndType({
      commandsLoading: true,
      availableCommands: [],
    })
    await screen.findByTestId("slash-menu")

    // Connection completes: the same open panel fills in, no retyping.
    rerenderInput(view, { commandsLoading: false, availableCommands: COMMANDS })
    const menu = await screen.findByTestId("slash-menu")
    await waitFor(() =>
      expect(within(menu).getByText("/compact")).toBeInTheDocument()
    )
    expect(within(menu).queryByText(LOADING)).toBeNull()
  })

  // The wait has two legs — the transport connecting, then the session
  // initializing behind an already-`connected` status. The panel must not blink
  // out at the seam between them (ChatInput spans both; see its own test).
  it("stays open across the whole wait, then fills in", async () => {
    const { view } = await mountAndType({
      commandsLoading: true,
      availableCommands: [],
    })
    expect(
      within(await screen.findByTestId("slash-menu")).getByText(LOADING)
    ).toBeInTheDocument()

    // Leg two: still loading, still nothing to show — panel stays put.
    rerenderInput(view, { commandsLoading: true, availableCommands: [] })
    expect(
      within(await screen.findByTestId("slash-menu")).getByText(LOADING)
    ).toBeInTheDocument()

    // Commands land.
    rerenderInput(view, { commandsLoading: false, availableCommands: COMMANDS })
    await waitFor(() =>
      expect(
        within(screen.getByTestId("slash-menu")).getByText("/compact")
      ).toBeInTheDocument()
    )
  })

  it("closes the loading row when the session comes up with no commands", async () => {
    const { view } = await mountAndType({
      commandsLoading: true,
      availableCommands: [],
    })
    await screen.findByTestId("slash-menu")

    // A commandless agent: the wait ends, so the panel must not spin forever.
    rerenderInput(view, { commandsLoading: false, availableCommands: [] })
    await waitFor(() => expect(screen.queryByTestId("slash-menu")).toBeNull())
  })

  // `useAgentSkills` reports an in-flight disk scan as an empty list, so `$`
  // must not be gated on it: a `$` typed before the scan lands has to fill in on
  // its own rather than wait for another keystroke.
  it("fills in a `$` panel when the Codex skill scan lands late", async () => {
    const { view } = await mountAndType(
      { agentType: "codex", availableCommands: COMMANDS },
      "$"
    )
    // Scan still running (an in-flight scan reads as an empty list): the panel
    // has nothing to show yet, but the trigger must stay armed.
    expect(screen.queryByTestId("slash-menu")).toBeNull()

    // Scan lands. No new keystroke — only a re-render.
    agentSkills.mockReturnValue([
      {
        id: "brainstorm",
        name: "Brainstorm",
        description: "Ideas",
        scope: "global",
      },
    ])
    try {
      rerenderInput(view, { agentType: "codex", availableCommands: COMMANDS })
      const menu = await screen.findByTestId("slash-menu")
      expect(within(menu).getByText("Brainstorm")).toBeInTheDocument()
    } finally {
      agentSkills.mockReturnValue([])
    }
  })

  it("stays closed when nothing is loading and the agent has no commands", async () => {
    await mountAndType({ commandsLoading: false, availableCommands: [] })
    // Give the trigger detection a turn to run before asserting the absence.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByTestId("slash-menu")).toBeNull()
  })

  it("does not send on Enter while the loading panel owns the keys", async () => {
    const onSend = vi.fn()
    const { editor } = await mountAndType({
      onSend,
      commandsLoading: true,
      availableCommands: [],
    })
    await screen.findByTestId("slash-menu")
    act(() => {
      ;(editor.view.dom as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      )
    })
    expect(onSend).not.toHaveBeenCalled()
    // Escape dismisses it, restoring normal editing.
    act(() => {
      ;(editor.view.dom as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      )
    })
    await waitFor(() => expect(screen.queryByTestId("slash-menu")).toBeNull())
  })
})

describe("MessageInput slash badges", () => {
  afterEach(() => {
    cleanup()
    composerHandle.current = null
  })

  const COMMANDS = [{ name: "compact", description: "Compact the thread" }]

  async function mount(
    props: Partial<React.ComponentProps<typeof MessageInput>> = {}
  ) {
    renderInput({ availableCommands: COMMANDS, ...props })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const handle = composerHandle.current
    const editor = handle?.getEditor()
    if (!handle || !editor) throw new Error("composer editor not mounted")
    return { handle, editor }
  }

  function press(editor: Editor, key: string) {
    act(() => {
      ;(editor.view.dom as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
      )
    })
  }

  for (const key of ["Enter", "Tab"]) {
    it(`still badges the command picked from the menu with ${key}`, async () => {
      const { handle, editor } = await mount()
      act(() => {
        editor.commands.insertContent("/comp")
      })
      await screen.findByTestId("slash-menu")
      press(editor, key)
      await waitFor(() =>
        expect(JSON.stringify(handle.getJSON())).toContain('"type":"reference"')
      )
      // The badge still brings its trailing space, so the next word is typed
      // clear of it.
      expect(handle.getText()).toBe("/compact ")
    })
  }

  it("badges the command clicked in the menu", async () => {
    const { handle, editor } = await mount()
    act(() => {
      editor.commands.insertContent("/comp")
    })
    const menu = await screen.findByTestId("slash-menu")
    fireEvent.mouseDown(within(menu).getByText("/compact"))
    await waitFor(() =>
      expect(JSON.stringify(handle.getJSON())).toContain('"type":"reference"')
    )
    expect(handle.getText()).toBe("/compact ")
  })

  it("leaves a seeded slash word the agent never advertised as plain text", async () => {
    const { handle } = await mount()
    act(() => {
      handle.setText("/notacommand on /tmp/x and and/or")
    })
    expect(JSON.stringify(handle.getJSON())).not.toContain('"type":"reference"')
    expect(handle.getText()).toBe("/notacommand on /tmp/x and and/or")
  })

  it("badges a seeded token that IS one of the agent's commands", async () => {
    const { handle } = await mount()
    act(() => {
      handle.setText("/compact the thread")
    })
    expect(JSON.stringify(handle.getJSON())).toContain('"refType":"skill"')
    // Same bytes on the wire either way — only the composer's rendering differs.
    expect(handle.getText()).toBe("/compact the thread")
  })

  it("leaves a seeded command alone for an agent that has none", async () => {
    const { handle } = await mount({ availableCommands: [] })
    act(() => {
      handle.setText("/compact the thread")
    })
    expect(JSON.stringify(handle.getJSON())).not.toContain('"type":"reference"')
    expect(handle.getText()).toBe("/compact the thread")
  })
})

// The queue-edit / draft restore claims its one-shot guard synchronously but
// mutates the editor in a rAF whose cleanup cancels that frame. Anything in the
// effect's dependency array that changes identity in between therefore cancels
// the restore and then bails on the already-claimed guard — nothing is ever
// restored. The advertised-command list is exactly such a value: it lands with
// the ACP connection, and the Set built from it is fresh every time.
describe("MessageInput queue-edit restore vs. a late command list", () => {
  afterEach(() => {
    cleanup()
    composerHandle.current = null
    vi.unstubAllGlobals()
  })

  /** Hold every rAF callback so the test decides when the frame runs. */
  function captureFrames(): { flush: () => void } {
    const frames: (FrameRequestCallback | null)[] = []
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      frames.push(cb)
    )
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = null
    })
    return {
      flush: () => {
        act(() => {
          // Indexed, not iterated: a callback may queue another frame.
          for (let i = 0; i < frames.length; i++) {
            const cb = frames[i]
            frames[i] = null
            cb?.(0)
          }
        })
      },
    }
  }

  /** The identity the ACP connection replaces once it advertises. */
  const NO_COMMANDS: React.ComponentProps<
    typeof MessageInput
  >["availableCommands"] = []

  function renderAgain(
    view: ReturnType<typeof renderInput>,
    props: Partial<React.ComponentProps<typeof MessageInput>>
  ) {
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput onSend={vi.fn()} promptCapabilities={CAPS} {...props} />
      </NextIntlClientProvider>
    )
  }

  it("restores the queued message when the commands land before its frame", async () => {
    const { flush } = captureFrames()
    const editing = {
      isEditingQueueItem: true,
      editingItemId: "q1",
      editingDraftBlocks: [{ type: "text" as const, text: "queued prose" }],
    }
    const view = renderInput({ availableCommands: NO_COMMANDS, ...editing })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    // The connection comes up: a brand-new command list, and so a brand-new
    // `knownInvocations` Set, while the restore's frame is still pending.
    renderAgain(view, {
      availableCommands: [{ name: "compact", description: "Compact" }],
      ...editing,
    })
    flush()
    expect(composerHandle.current?.getText()).toBe("queued prose")
  })

  // The "re-edit a DIFFERENT queued item" restore is a second effect with its
  // own one-shot guard (the last hydrated item id), so it needs its own case.
  it("restores the next queued item picked while its frame is pending", async () => {
    const { flush } = captureFrames()
    const view = renderInput({ availableCommands: NO_COMMANDS })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    flush()

    // The user clicks "edit" on a queued message…
    const editing = {
      isEditingQueueItem: true,
      editingItemId: "q2",
      editingDraftBlocks: [{ type: "text" as const, text: "the next one" }],
    }
    renderAgain(view, { availableCommands: NO_COMMANDS, ...editing })
    // …and the command list lands before that restore's frame runs.
    renderAgain(view, {
      availableCommands: [{ name: "compact", description: "Compact" }],
      ...editing,
    })
    flush()
    expect(composerHandle.current?.getText()).toBe("the next one")
  })

  // A queued page comes back as the badge it was queued as. Named after its
  // uri instead, a marked-up screenshot of google.com came back as
  // "www.google.com" — and a page with a path as its last segment.
  it("restores a queued page as the badge it was queued as", async () => {
    const { flush } = captureFrames()
    renderInput({
      availableCommands: NO_COMMANDS,
      isEditingQueueItem: true,
      editingItemId: "q3",
      editingDraftBlocks: [
        {
          type: "resource",
          uri: "https://shop.test/orders/42",
          mime_type: "text/markdown",
          text: [
            "Captured from a web page in the built-in browser at the person's request.",
            "",
            "- page: Orders — https://shop.test/orders/42",
            "- screenshot: the visible 1200×800 CSS px of the page",
            "- markup: the person drew 1 numbered mark on this screenshot, in red",
            "  1. box: 20×20 CSS px at (10, 10)",
          ].join("\n"),
          blob: null,
        },
        {
          type: "resource",
          uri: "clipboard://notes.md-1",
          mime_type: "text/markdown",
          text: "# Notes",
          blob: null,
        },
      ],
    })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    flush()
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    const text = serializeDocToDisplayText(editor.state.doc)
    // Named by what it is, and carrying the page for the chip it gets once sent.
    expect(text).toMatch(
      /\[Marked-up screenshot]\(codeg:\/\/embedded\/https%3A%2F%2Fshop\.test%2Forders%2F42#[^)\s]+\)/
    )
    // Anything that is not a page keeps the name its uri gives it.
    expect(text).toMatch(/\[notes\.md-1]\(codeg:\/\/embedded\/[^)\s#]+\)/)
  })
})

describe("MessageInput mid-turn send (live-feedback channel)", () => {
  afterEach(() => {
    cleanup()
    composerHandle.current = null
    attachmentsOverride.current = null
    vi.clearAllMocks()
  })

  const MI = enMessages.Folder.chat.messageInput

  async function mountPrompting(
    props: Partial<React.ComponentProps<typeof MessageInput>> = {}
  ) {
    renderInput({
      isPrompting: true,
      disabled: true,
      onCancel: vi.fn(),
      onEnqueue: vi.fn(),
      // The prop defaults to the weaker `pull` promise, so the native cases
      // below have to say so explicitly; the pull case overrides it back.
      steerChannel: "native",
      ...props,
    })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    return editor
  }

  function typeDraft(editor: Editor, text: string) {
    // insertContent dispatches a real transaction, so the composer's
    // empty-tracking flips (plain setContent doesn't emit an update).
    act(() => {
      editor.commands.insertContent(text)
    })
  }

  it("keeps the historical Stop-only form when onSteer is absent", async () => {
    const editor = await mountPrompting()
    typeDraft(editor, "draft text")
    // Stop is there; none of the split-button chrome is.
    expect(screen.getByTitle(MI.cancel)).toBeInTheDocument()
    expect(screen.queryByTitle(MI.queueMessage)).toBeNull()
    expect(screen.queryByLabelText(MI.steerIntoTurn)).toBeNull()
  })

  it("shows the queue/steer split next to Stop once there is content", async () => {
    const editor = await mountPrompting({ onSteer: vi.fn() })
    // Empty draft: nothing to queue or steer — still Stop-only.
    expect(screen.queryByTitle(MI.queueMessage)).toBeNull()

    typeDraft(editor, "go left")
    await waitFor(() =>
      expect(screen.getByTitle(MI.queueMessage)).toBeInTheDocument()
    )
    expect(screen.getByLabelText(MI.steerIntoTurn)).toBeInTheDocument()
    expect(screen.getByTitle(MI.cancel)).toBeInTheDocument()
  })

  it("steers the draft text and clears the composer on success", async () => {
    const user = userEvent.setup()
    let resolveSteer: () => void = () => {}
    const onSteer = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveSteer = r
        })
    )
    const editor = await mountPrompting({ onSteer })
    typeDraft(editor, "go left")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerIntoTurn)).toBeInTheDocument()
    )

    await user.click(screen.getByLabelText(MI.steerIntoTurn))
    const item = await screen.findByRole("menuitem", { name: MI.steerIntoTurn })
    // The glyph promises what the label does — the bolt is the instant insert.
    expect(item.querySelector(".lucide-zap")).not.toBeNull()
    await user.click(item)
    // A plain-text draft steers as text alone — no blocks payload.
    await waitFor(() =>
      expect(onSteer).toHaveBeenCalledWith("go left", undefined)
    )
    // Unsettled: the draft must survive until the backend confirms.
    expect(serializeDocToText(editor.state.doc)).toContain("go left")

    await act(async () => {
      resolveSteer()
    })
    // Confirmed: the composer clears (the split collapses back to Stop-only).
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).not.toContain("go left")
    )
    await waitFor(() => expect(screen.queryByTitle(MI.queueMessage)).toBeNull())
  })

  it("falls back to the queue when the turn ends in the race window", async () => {
    const user = userEvent.setup()
    const { isNoActiveTurnRejection } = await import("@/lib/turn-busy")
    vi.mocked(isNoActiveTurnRejection).mockReturnValue(true)
    const onSteer = vi.fn().mockRejectedValue(new Error("no active turn"))
    const onEnqueue = vi.fn()
    const editor = await mountPrompting({ onSteer, onEnqueue })
    typeDraft(editor, "late note")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerIntoTurn)).toBeInTheDocument()
    )

    await user.click(screen.getByLabelText(MI.steerIntoTurn))
    await user.click(
      await screen.findByRole("menuitem", { name: MI.steerIntoTurn })
    )

    await waitFor(() => expect(onEnqueue).toHaveBeenCalled())
    const [draft] = onEnqueue.mock.calls[0]
    expect(draft.blocks).toEqual([{ type: "text", text: "late note" }])
    // Draft consumed by the queue, not lost and not duplicated.
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).not.toContain("late note")
    )
  })

  it("keeps the draft on a non-turn-end failure", async () => {
    const user = userEvent.setup()
    const { isNoActiveTurnRejection } = await import("@/lib/turn-busy")
    vi.mocked(isNoActiveTurnRejection).mockReturnValue(false)
    const onSteer = vi.fn().mockRejectedValue(new Error("boom"))
    const onEnqueue = vi.fn()
    const editor = await mountPrompting({ onSteer, onEnqueue })
    typeDraft(editor, "keep me")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerIntoTurn)).toBeInTheDocument()
    )

    await user.click(screen.getByLabelText(MI.steerIntoTurn))
    await user.click(
      await screen.findByRole("menuitem", { name: MI.steerIntoTurn })
    )

    await waitFor(() => expect(onSteer).toHaveBeenCalled())
    // Real failure: nothing queued, draft intact for retry.
    expect(onEnqueue).not.toHaveBeenCalled()
    expect(serializeDocToText(editor.state.doc)).toContain("keep me")
  })

  it("labels the mid-turn action honestly on the pull channel", async () => {
    // A pull-tool session gets the same split, but its action must never
    // promise an instant insert: the note is recorded as waiting and read on
    // the agent's next check, so the copy says exactly that.
    const user = userEvent.setup()
    const onSteer = vi.fn().mockResolvedValue(undefined)
    const editor = await mountPrompting({ onSteer, steerChannel: "pull" })
    typeDraft(editor, "check the tests")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerAsNote)).toBeInTheDocument()
    )
    expect(screen.queryByLabelText(MI.steerIntoTurn)).toBeNull()

    // The action itself rides the same steer path — only the copy differs.
    await user.click(screen.getByLabelText(MI.steerAsNote))
    const pullItem = await screen.findByRole("menuitem", {
      name: MI.steerAsNote,
    })
    // ...and so does the glyph: the notes strip's waiting clock, never the
    // instant-insert bolt.
    expect(pullItem.querySelector(".lucide-clock")).not.toBeNull()
    expect(pullItem.querySelector(".lucide-zap")).toBeNull()
    await user.click(pullItem)
    await waitFor(() =>
      expect(onSteer).toHaveBeenCalledWith("check the tests", undefined)
    )
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).not.toContain(
        "check the tests"
      )
    )
  })

  const stagedImage = {
    id: "att-1",
    type: "image" as const,
    data: "aGk=",
    uri: null,
    name: "mock.png",
    mimeType: "image/png",
  }
  const stagedImageBlock = {
    type: "image" as const,
    data: "aGk=",
    mime_type: "image/png",
  }

  it("steers a draft with an image attachment, blocks included", async () => {
    // The whole point of block steering: the entry stays enabled with an
    // image staged, and the handler ships the SAME block list a normal send
    // would build — text prose plus the attachment — with the prose as the
    // recorded note.
    const user = userEvent.setup()
    attachmentsOverride.current = {
      attachments: [stagedImage],
      imagePromptBlocks: () => [stagedImageBlock],
    }
    const onSteer = vi.fn().mockResolvedValue(undefined)
    const editor = await mountPrompting({ onSteer })
    typeDraft(editor, "match this mock")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerIntoTurn)).toBeInTheDocument()
    )

    await user.click(screen.getByLabelText(MI.steerIntoTurn))
    const item = await screen.findByRole("menuitem", {
      name: MI.steerIntoTurn,
    })
    expect(item).not.toHaveAttribute("aria-disabled", "true")
    await user.click(item)
    await waitFor(() =>
      expect(onSteer).toHaveBeenCalledWith("match this mock", [
        { type: "text", text: "match this mock" },
        stagedImageBlock,
      ])
    )
    // Confirmed: the draft clears like any successful steer.
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).not.toContain(
        "match this mock"
      )
    )
  })

  it("defaults to the pull copy when no channel is declared", async () => {
    // The weaker promise is the default: a call site that wires `onSteer` but
    // forgets `steerChannel` must understate delivery, never claim an insert.
    const editor = await mountPrompting({
      onSteer: vi.fn(),
      steerChannel: undefined,
    })
    typeDraft(editor, "no channel declared")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerAsNote)).toBeInTheDocument()
    )
    expect(screen.queryByLabelText(MI.steerIntoTurn)).toBeNull()
    // The menu item, not just the trigger: they read from `steerChannel`
    // independently, so a default that leaked into only one of them would
    // still promise an insert somewhere.
    await userEvent.setup().click(screen.getByLabelText(MI.steerAsNote))
    expect(
      await screen.findByRole("menuitem", { name: MI.steerAsNote })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("menuitem", { name: MI.steerIntoTurn })
    ).toBeNull()
  })

  it("names the note, not an insert, when a pull send fails", async () => {
    // The failure toast is the last place the pull channel could overpromise:
    // "couldn't insert into the current turn" would describe a delivery this
    // session never attempted.
    const user = userEvent.setup()
    const { isNoActiveTurnRejection } = await import("@/lib/turn-busy")
    vi.mocked(isNoActiveTurnRejection).mockReturnValue(false)
    const onSteer = vi.fn().mockRejectedValue(new Error("boom"))
    const editor = await mountPrompting({ onSteer, steerChannel: "pull" })
    typeDraft(editor, "keep me")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerAsNote)).toBeInTheDocument()
    )

    await user.click(screen.getByLabelText(MI.steerAsNote))
    await user.click(
      await screen.findByRole("menuitem", { name: MI.steerAsNote })
    )

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        MI.steerNoteFailed,
        expect.anything()
      )
    )
    // Exactly one toast: raising the insert copy alongside the note copy is
    // the same overpromise, just louder.
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
    // Same draft policy as native: a real failure keeps the text for retry.
    expect(serializeDocToText(editor.state.doc)).toContain("keep me")
  })

  it("steers an image-only draft with the attachment summary as the note", async () => {
    // No prose to record, so the note falls back to the draft's display text
    // (what the queue chip would have shown) while the wire still carries the
    // real image block.
    const user = userEvent.setup()
    attachmentsOverride.current = {
      attachments: [stagedImage],
      imagePromptBlocks: () => [stagedImageBlock],
    }
    const onSteer = vi.fn().mockResolvedValue(undefined)
    await mountPrompting({ onSteer })
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerIntoTurn)).toBeInTheDocument()
    )

    await user.click(screen.getByLabelText(MI.steerIntoTurn))
    await user.click(
      await screen.findByRole("menuitem", { name: MI.steerIntoTurn })
    )
    await waitFor(() =>
      expect(onSteer).toHaveBeenCalledWith("Attached 1 attachment", [
        stagedImageBlock,
      ])
    )
  })

  it("blocks steering while an image upload is still settling", async () => {
    // Same guard as a plain send: an unsettled upload has no server-side uri
    // to hydrate from. The gate must be its own honest toast — the enqueue
    // fallback would otherwise ship a bytes-less marker block.
    const user = userEvent.setup()
    const { toast } = await import("sonner")
    attachmentsOverride.current = {
      attachments: [{ ...stagedImage, uploading: true }],
      hasUploadingImage: true,
      imagePromptBlocks: () => [stagedImageBlock],
    }
    const onSteer = vi.fn()
    const editor = await mountPrompting({ onSteer })
    typeDraft(editor, "wait for it")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerIntoTurn)).toBeInTheDocument()
    )

    await user.click(screen.getByLabelText(MI.steerIntoTurn))
    await user.click(
      await screen.findByRole("menuitem", { name: MI.steerIntoTurn })
    )
    expect(onSteer).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      enMessages.Folder.chat.messageInput.attachUploadInProgress
    )
    // Draft and attachment stay put for the retry.
    expect(serializeDocToText(editor.state.doc)).toContain("wait for it")
  })

  it("queues the attachment too when the blocks steer is rejected", async () => {
    // The load-bearing half of "attachments are never silently dropped": the
    // backend rejects a blocks-bearing note on the pull path (and on the
    // turn-end race) with NoActiveTurn, and this fallback has to re-route the
    // WHOLE draft — image included — not just the prose.
    const user = userEvent.setup()
    const { isNoActiveTurnRejection } = await import("@/lib/turn-busy")
    vi.mocked(isNoActiveTurnRejection).mockReturnValue(true)
    attachmentsOverride.current = {
      attachments: [stagedImage],
      imagePromptBlocks: () => [stagedImageBlock],
    }
    const onSteer = vi.fn().mockRejectedValue(new Error("no active turn"))
    const onEnqueue = vi.fn()
    const editor = await mountPrompting({ onSteer, onEnqueue })
    typeDraft(editor, "late note")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerIntoTurn)).toBeInTheDocument()
    )

    await user.click(screen.getByLabelText(MI.steerIntoTurn))
    await user.click(
      await screen.findByRole("menuitem", { name: MI.steerIntoTurn })
    )

    await waitFor(() => expect(onEnqueue).toHaveBeenCalled())
    const [draft] = onEnqueue.mock.calls[0]
    expect(draft.blocks).toEqual([
      { type: "text", text: "late note" },
      stagedImageBlock,
    ])
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).not.toContain("late note")
    )
  })

  it("labels the mid-turn action honestly on the pull channel", async () => {
    // A pull-tool session gets the same split, but its action must never
    // promise an instant insert: the note is recorded as waiting and read on
    // the agent's next check, so the copy says exactly that.
    const user = userEvent.setup()
    const onSteer = vi.fn().mockResolvedValue(undefined)
    const editor = await mountPrompting({ onSteer, steerChannel: "pull" })
    typeDraft(editor, "check the tests")
    await waitFor(() =>
      expect(screen.getByLabelText(MI.steerAsNote)).toBeInTheDocument()
    )
    expect(screen.queryByLabelText(MI.steerIntoTurn)).toBeNull()

    // The action itself rides the same steer path — only the copy differs.
    await user.click(screen.getByLabelText(MI.steerAsNote))
    await user.click(
      await screen.findByRole("menuitem", { name: MI.steerAsNote })
    )
    await waitFor(() =>
      expect(onSteer).toHaveBeenCalledWith("check the tests", undefined)
    )
    await waitFor(() =>
      expect(serializeDocToText(editor.state.doc)).not.toContain(
        "check the tests"
      )
    )
  })
})

describe("MessageInput right-click token selection", () => {
  afterEach(() => {
    cleanup()
    composerHandle.current = null
  })

  /**
   * The custom radix menu only replaces the browser's own where the async
   * clipboard read exists (a secure context). jsdom has neither, so each mode is
   * set up here rather than inherited from whatever ran before.
   */
  function setClipboardRead(supported: boolean) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: supported
        ? { readText: async () => "", writeText: async () => {} }
        : undefined,
    })
  }

  async function mountWithEditor({ clipboardRead = true } = {}) {
    setClipboardRead(clipboardRead)
    renderInput({})
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const editor = composerHandle.current?.getEditor()
    if (!editor) throw new Error("composer editor not mounted")
    return editor
  }

  /** Seed the draft and drop a collapsed caret at `caret`. */
  function seed(editor: Editor, text: string, caret: number) {
    act(() => {
      editor.commands.setContent(text)
      editor.commands.setTextSelection(caret)
    })
  }

  /** The editing surface the right click lands on. jsdom has no layout, so
   *  hit-testing declines and the caret above is what the menu resolves. */
  function editingSurface(): HTMLElement {
    const surface = document.querySelector<HTMLElement>(".ProseMirror")
    if (!surface) throw new Error("composer editing surface not mounted")
    return surface
  }

  function selectedText(editor: Editor): string {
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to)
  }

  it("selects the address under the pointer and offers to write to it", async () => {
    const editor = await mountWithEditor()
    seed(editor, "ping adam@example.com today", 8)

    fireEvent.contextMenu(editingSurface(), { clientX: 40, clientY: 12 })

    await screen.findByRole("menuitem", { name: "Send email" })
    expect(selectedText(editor)).toBe("adam@example.com")
    // Copy is live off the same right click — before this it needed the user to
    // highlight the address by hand.
    expect(screen.getByRole("menuitem", { name: "Copy" })).not.toHaveAttribute(
      "data-disabled"
    )
  })

  it("opens a schemeless link through the shared opener", async () => {
    const editor = await mountWithEditor()
    seed(editor, "see example.com/docs later", 8)

    fireEvent.contextMenu(editingSurface(), { clientX: 40, clientY: 12 })

    const open = await screen.findByRole("menuitem", { name: "Open link" })
    expect(selectedText(editor)).toBe("example.com/docs")

    // No built-in browser here (web mode, no capability answer), so the link
    // decision resolves to the system browser — `window.open` in web mode.
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null)
    try {
      fireEvent.click(open)
      await waitFor(() =>
        expect(windowOpen).toHaveBeenCalledWith(
          "https://example.com/docs",
          "_blank",
          "noreferrer"
        )
      )
    } finally {
      windowOpen.mockRestore()
    }
  })

  it("selects a plain word without inventing an action for it", async () => {
    const editor = await mountWithEditor()
    seed(editor, "refactor the parser today", 16)

    fireEvent.contextMenu(editingSurface(), { clientX: 40, clientY: 12 })

    await screen.findByRole("menuitem", { name: "Copy" })
    expect(selectedText(editor)).toBe("parser")
    expect(screen.queryByRole("menuitem", { name: "Open link" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Send email" })).toBeNull()
  })

  it("leaves a hand-made selection alone and acts on that", async () => {
    const editor = await mountWithEditor()
    seed(editor, "ping adam@example.com today", 1)
    act(() => {
      editor.commands.setTextSelection({ from: 6, to: 22 })
    })

    fireEvent.contextMenu(editingSurface(), { clientX: 40, clientY: 12 })

    // A click inside a live selection neither re-selects nor collapses it, and
    // the address it holds still gets its own row.
    await screen.findByRole("menuitem", { name: "Send email" })
    expect(selectedText(editor)).toBe("adam@example.com")
  })

  it("still picks the token up where the native menu takes over", async () => {
    const editor = await mountWithEditor({ clipboardRead: false })
    seed(editor, "ping adam@example.com today", 8)

    fireEvent.contextMenu(editingSurface(), { clientX: 40, clientY: 12 })

    // No custom menu in a non-secure context — the browser's own is left to
    // appear — but it now opens over a selected address instead of a caret.
    expect(screen.queryByRole("menuitem", { name: "Copy" })).toBeNull()
    expect(selectedText(editor)).toBe("adam@example.com")
  })
})

describe("MessageInput prompt history", () => {
  async function mountWithHistory(
    history: string[],
    props: Partial<React.ComponentProps<typeof MessageInput>> = {}
  ) {
    renderInput({ getSentHistory: () => history, ...props })
    await waitFor(
      () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
      { timeout: 5000 }
    )
    const handle = composerHandle.current
    const editor = handle?.getEditor()
    if (!handle || !editor) throw new Error("composer editor not mounted")
    return { handle, editor }
  }

  function press(editor: Editor, key: string) {
    act(() => {
      ;(editor.view.dom as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
      )
    })
  }

  it("recalls sent prompts on Up and restores the draft on Down", async () => {
    const { handle, editor } = await mountWithHistory(["first", "latest"])

    act(() => handle.setText("my draft"))
    act(() => editor.commands.focus("start"))
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("latest")

    act(() => editor.commands.focus("start"))
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("first")

    act(() => editor.commands.focus("end"))
    press(editor, "ArrowDown")
    expect(handle.getText()).toBe("latest")

    // Past the newest entry the original draft comes back.
    act(() => editor.commands.focus("end"))
    press(editor, "ArrowDown")
    expect(handle.getText()).toBe("my draft")
  })

  it("recalls into an empty composer, where the caret is at both edges", async () => {
    const { handle, editor } = await mountWithHistory(["first", "latest"])

    // The common case: nothing typed yet. Down must still fall through (there
    // is nothing recalled to move forward from), Up must recall.
    press(editor, "ArrowDown")
    expect(handle.getText()).toBe("")
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("latest")
  })

  it("persists the draft the first recall replaces", async () => {
    // The stash that ArrowDown restores lives only in memory, and the draft
    // save is debounced: a recall that lands inside that window must flush the
    // typed draft rather than let the timer write the RECALLED prompt over it
    // (a tab switch from there would lose what the user typed).
    const draftKey = "test:history-recall-draft"
    clearMessageInputDraftV2(draftKey)
    const { handle, editor } = await mountWithHistory(["first", "latest"], {
      draftStorageKey: draftKey,
    })

    act(() => editor.commands.insertContent("my draft"))
    act(() => editor.commands.focus("start"))
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("latest")

    // Past the debounce: whatever was going to be written has been written.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    const stored = loadMessageInputDraftV2(draftKey)
    expect(JSON.stringify(stored)).toContain("my draft")
    expect(JSON.stringify(stored)).not.toContain("latest")
    clearMessageInputDraftV2(draftKey)
  })

  it("editing a recalled prompt leaves history mode", async () => {
    const { handle, editor } = await mountWithHistory(["first", "latest"])

    act(() => editor.commands.focus("start"))
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("latest")

    // Type into the recalled entry, then Down must NOT be treated as "newer"
    // past the newest — history mode ended with the edit.
    act(() => editor.commands.focus("end"))
    act(() => editor.commands.insertContent(" edited"))
    expect(handle.getText()).toBe("latest edited")
    act(() => editor.commands.focus("end"))
    press(editor, "ArrowDown")
    expect(handle.getText()).toBe("latest edited")
  })

  it("does nothing on Up when the session has no history", async () => {
    const { handle, editor } = await mountWithHistory([])

    act(() => handle.setText("my draft"))
    act(() => editor.commands.focus("start"))
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("my draft")
  })

  it("steps on the edge and lands on the edge it travelled from", async () => {
    const { handle, editor } = await mountWithHistory([
      "first",
      "older\nmulti\nline",
      "newest\nmulti\nline",
    ])

    act(() => handle.setText("DRAFT"))
    act(() => editor.commands.focus("start"))
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("newest\nmulti\nline")

    // Recalling lands at the TOP, so the same key keeps going older without the
    // caret having to be walked anywhere.
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("older\nmulti\nline")
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("first")

    // Turning around means walking to the bottom edge first — until it gets
    // there the caret is the editor's, not the history's. (jsdom has no native
    // caret movement, so that walk is simulated with focus("end").)
    act(() => editor.commands.focus("end"))
    press(editor, "ArrowDown")
    expect(handle.getText()).toBe("older\nmulti\nline")
    press(editor, "ArrowDown")
    expect(handle.getText()).toBe("newest\nmulti\nline")
    press(editor, "ArrowDown")
    expect(handle.getText()).toBe("DRAFT")
  })

  it("does not switch prompts while the caret is inside a multi-line entry", async () => {
    const { handle, editor } = await mountWithHistory([
      "older",
      "newest\nmulti\nline",
    ])

    act(() => editor.commands.focus("start"))
    press(editor, "ArrowUp")
    expect(handle.getText()).toBe("newest\nmulti\nline")

    // The caret is at the TOP, so Down belongs to the caret, not the history
    // (jsdom has no native caret movement, so the observable is "no recall").
    press(editor, "ArrowDown")
    expect(handle.getText()).toBe("newest\nmulti\nline")
  })

  it("leaves the arrows to the caret while editing a queued message", async () => {
    const { handle, editor } = await mountWithHistory(["older", "newest"], {
      isEditingQueueItem: true,
    })

    act(() => handle.setText("queued edit"))
    act(() => editor.commands.focus("start"))
    press(editor, "ArrowUp")

    // A recall here would replace the queued message being edited.
    expect(handle.getText()).toBe("queued edit")
  })
})

/**
 * The composer box is a flex column: editor on top, action row pinned under
 * it. On mobile web the editor was collapsing to 0px, which floated the add /
 * agent / stop controls to the TOP of the box and left the rest of it as blank
 * dead space that could not be focused (#746).
 *
 * jsdom cannot measure any of that, so these lock the declared contract the
 * geometry rests on. Real pixel behaviour is covered by the manual pass in the
 * PR description.
 */
describe("MessageInput composer box sizing (#746)", () => {
  it("sizes the editor off a content basis so it cannot collapse to zero", async () => {
    const { container } = renderInput({})
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )

    const chrome = container.querySelector(".codeg-composer-chrome")
    expect(chrome).not.toBeNull()
    const chromeClasses = chrome!.className.split(/\s+/)
    expect(chromeClasses).toContain("flex")
    expect(chromeClasses).toContain("flex-col")

    const editorRoot = chrome!.querySelector(".codeg-composer")
    expect(editorRoot).not.toBeNull()
    const editorClasses = editorRoot!.className.split(/\s+/)
    // A zero basis (`flex-1`) only reaches its intended height by absorbing the
    // box's free space. Engines that read a min-height-only flex column as
    // main-size-indefinite hand out none, and the editor lands at 0px.
    expect(editorClasses).not.toContain("flex-1")
    expect(editorClasses).toContain("grow")
  })

  // Both floors have to actually land, and on the right element: the box's on
  // the box, the editable area's on the editor. Only then does the box reach
  // its floor by summing its children, which is what makes the layout come out
  // right on an engine that hands its flex-grow children no free space.
  for (const tall of [false, true]) {
    it(`states both height floors on the ${tall ? "tall" : "compact"} box`, async () => {
      const { container } = renderInput({ tall })
      await waitFor(() =>
        expect(container.querySelector('[role="textbox"]')).not.toBeNull()
      )

      const chrome = container.querySelector(".codeg-composer-chrome")!
      const editorRoot = chrome.querySelector(".codeg-composer")!
      expect(chrome.className.split(/\s+/)).toContain(
        composerBoxMinHeight(tall)
      )
      expect(editorRoot.className.split(/\s+/)).toContain(
        composerEditableMinHeight(tall, false)
      )
    })
  }

  it("keeps the action row a fixed-height last child, below the editor", async () => {
    const { container } = renderInput({ isPrompting: true, onCancel: vi.fn() })
    await waitFor(() =>
      expect(container.querySelector('[role="textbox"]')).not.toBeNull()
    )

    const chrome = container.querySelector(".codeg-composer-chrome")!
    const editorRoot = chrome.querySelector(".codeg-composer")!
    // The row holding the add menu / agent settings / stop button.
    const actionRow = chrome.querySelector(":scope > .shrink-0.items-end")
    expect(actionRow).not.toBeNull()

    // Stop lives in that row (it is what appeared top-right in the report).
    expect(
      actionRow!.querySelector(
        `button[title="${enMessages.Folder.chat.messageInput.cancel}"]`
      )
    ).not.toBeNull()

    // Document order: editor first, action row after it. Anything else and the
    // controls render above the text, which is the reported symptom.
    expect(
      editorRoot.compareDocumentPosition(actionRow!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})

describe("MessageInput folder data arriving after mount", () => {
  afterEach(() => {
    cleanup()
    folderPickerVisible.mockReturnValue(false)
  })

  it("keeps a block wrapper and the editable draft when the folder row appears", async () => {
    const input = (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput onSend={vi.fn()} promptCapabilities={CAPS} />
      </NextIntlClientProvider>
    )
    const { container, rerender } = render(input)
    await waitFor(() =>
      expect(composerHandle.current?.getEditor()).toBeTruthy()
    )
    const handle = composerHandle.current!
    const editor = handle.getEditor()!
    const editorDom = editor.view.dom
    act(() => handle.insertTextAtCursor("keep this draft"))
    const chrome = container.querySelector(".codeg-composer-chrome")!
    const wrapper = chrome.parentElement!
    // jsdom has no layout engine, so it cannot reproduce the collapse; this
    // pins the class contract that avoids it. One class per negative
    // assertion: `not.toHaveClass(a, b)` passes as soon as either is missing.
    // Unattached, nothing may clip the chrome's outer focus ring.
    expect(wrapper).toHaveClass("block")
    expect(wrapper).not.toHaveClass("contents")
    expect(wrapper).not.toHaveClass("overflow-hidden")

    folderPickerVisible.mockReturnValue(true)
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput onSend={vi.fn()} promptCapabilities={CAPS} />
      </NextIntlClientProvider>
    )
    expect(chrome.parentElement).toBe(wrapper)
    expect(wrapper).toHaveClass("block", "overflow-hidden")
    expect(wrapper).not.toHaveClass("contents")
    expect(composerHandle.current!.getEditor()).toBe(editor)
    expect(editor.view.dom).toBe(editorDom)
    expect(handle.getText()).toBe("keep this draft")
    act(() => editor.commands.undo())
    expect(handle.getText()).toBe("")
  })
})
