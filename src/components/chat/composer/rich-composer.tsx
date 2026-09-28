"use client"

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react"
import { type Editor, type JSONContent } from "@tiptap/core"
import { Selection } from "@tiptap/pm/state"
import { EditorContent, useEditor } from "@tiptap/react"
import { exitSuggestion } from "@tiptap/suggestion"

import type { HistoryDirection } from "@/lib/composer-history"
import { isImeCompositionKey } from "@/lib/ime-composition"
import {
  NO_KNOWN_INVOCATIONS,
  type KnownInvocations,
} from "@/lib/invocation-token"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import { cn } from "@/lib/utils"

import { buildComposerExtensions } from "./editor-config"
import {
  decidePastedContent,
  textToSeededDoc,
  textToSeededInlineContent,
} from "./plain-text-content"
import { serializeDocToText } from "./to-prompt-blocks"
import { decideComposerKey } from "./submit-key"
import type {
  MentionController,
  MentionRenderState,
} from "./suggestion/mention-suggestion"
import {
  MENTION_LISTBOX_ID,
  SuggestionPopup,
} from "./suggestion/suggestion-popup"
import type {
  MentionUiLabels,
  ReferenceSearch,
  SuggestionPopupHandle,
} from "./suggestion/types"
import type { ReferenceAttrs, ReferenceKind } from "./types"

/**
 * Imperative handle exposed to the parent (e.g. the message input that owns
 * attachments, queue and send orchestration). The parent reads/writes plain text
 * and controls focus without re-rendering the editor.
 */
export interface RichComposerHandle {
  /** Serialize the current document to plain text (references → their inline
   *  token, hard breaks → newlines). */
  getText: () => string
  /**
   * Replace the whole document from a plain-text string. Serialized references
   * in the text hydrate into inline badges (see {@link textToSeededDoc}), so a
   * restored draft / queued message / template previews the way the sent
   * message renders.
   */
  setText: (text: string) => void
  /**
   * Replace the whole document from a Tiptap JSON doc — used to hydrate a v2
   * draft or a queue-edit payload, preserving reference badges that a plain-text
   * round-trip would downgrade to their token.
   */
  setDoc: (doc: JSONContent) => void
  /** Clear the document. */
  clear: () => void
  /** Focus the editor at the end of the document. */
  focus: () => void
  /**
   * Focus the editor and place the caret at the document position nearest the
   * given viewport coordinates (native-textarea behavior). Falls back to the
   * end of the document when the point can't be mapped (e.g. it lands outside
   * the editing surface). Used by the host to honor where a user clicks in the
   * composer's blank chrome instead of always jumping to the end.
   */
  focusAtCoords: (clientX: number, clientY: number) => void
  /** Whether the document is empty (no text, no nodes). */
  isEmpty: () => boolean
  /** Serialize the current document to Tiptap JSON (for draft persistence). */
  getJSON: () => JSONContent
  /**
   * Insert plain text at the current selection (quick messages, appended text).
   * Serialized references in the text hydrate into inline badges, so seeded
   * content previews the way the sent message renders.
   */
  insertTextAtCursor: (text: string) => void
  /** Insert an inline reference badge at the current selection. */
  insertReference: (attrs: ReferenceAttrs) => void
  /** Escape hatch to the underlying editor (null until initialized). */
  getEditor: () => Editor | null
}

export interface RichComposerProps {
  /**
   * Initial content, inserted as plain text (serialized references hydrate into
   * badges — see {@link textToSeededDoc}). Applied once on creation.
   */
  defaultText?: string
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  /** Accessible label for the editing surface. */
  ariaLabel?: string
  /** Outer wrapper className (host controls border/ring/max-height). */
  className?: string
  /** Inline style for the outer wrapper (e.g. max-height). */
  style?: CSSProperties
  /**
   * Fires on every document change with the serialized plain text. Serialization
   * runs once per keystroke *only when a handler is attached* (the call is
   * skipped entirely otherwise). Callers that persist drafts must debounce —
   * the draft layer owns that.
   */
  onChange?: (text: string) => void
  /**
   * Submit intent: fired when the `submitShortcut` binding is pressed while not
   * composing (IME-safe) and not on a structural bare Enter (code block / list).
   * The host decides what "submit" means.
   */
  onSubmit?: () => void
  onFocus?: () => void
  onBlur?: () => void
  /**
   * Fired once the (async, `immediatelyRender:false`) editor has mounted and any
   * `defaultText` has been applied. The host uses this to hydrate a draft /
   * queue-edit document via the imperative handle, which isn't usable earlier.
   */
  onReady?: () => void
  /**
   * Enables the unified `@` mention panel. Resolves the typed query into
   * grouped suggestions (files/agents/sessions/commits/skills). MUST be
   * referentially stable (memoize it) — it is a dependency of the panel's fetch
   * effect. Omit to disable mentions.
   */
  referenceSearch?: ReferenceSearch
  /**
   * Localized chrome for the `@` panel (empty / loading / listbox name / "more
   * results" hint / result-count announcement). English fallbacks apply when
   * omitted. Render-only — safe to pass a fresh object per render.
   */
  mentionUiLabels?: MentionUiLabels
  /**
   * Localized per-kind tab labels for the `@` panel (Agents/Files/Sessions/
   * Commits/Skills). English fallbacks apply when omitted. Render-only.
   */
  tabLabels?: Record<ReferenceKind, string>
  /**
   * Box the `@` panel lines up with: it adopts this element's width and left
   * edge and opens above it. Point it at the composer's outer chrome so the
   * panel matches the host's own `/` command menu; defaults to the editor's own
   * root, which is the same box for a host that wraps nothing else around it.
   */
  mentionAnchorRef?: RefObject<HTMLElement | null>
  /**
   * The invocations the host's `/`·`$` menu can offer right now (see
   * {@link "./invocation-reference".buildKnownInvocations}). Seeded and pasted
   * text turns a bare `/cmd`·`$skill` token into a command badge only when it is
   * one of these; anything else stays editable prose. Omit — or leave empty
   * while the agent's list is still on its way — and no bare token is ever
   * badged, which is the safe direction: text that stays text sends exactly as
   * written.
   *
   * Read at event time, so a list that lands mid-compose applies to the next
   * paste without recreating the editor. Badges already in the document are
   * never revisited.
   */
  knownInvocations?: KnownInvocations
  /**
   * Key binding (matchShortcutEvent form) that sends the message. Default
   * `"enter"`. When set to a non-Enter binding, a plain Enter inserts a newline.
   */
  submitShortcut?: string
  /** Key binding that inserts a line break instead of sending. Default `"shift+enter"`. */
  newlineShortcut?: string
  /**
   * When true, an external (parent-driven) menu — e.g. the `/` runtime command
   * list — owns navigation/confirm keys, so the composer never submits or breaks
   * while it is open. The internal `@` panel does not need this flag.
   */
  isExternalMenuOpen?: boolean
  /**
   * Called for every keydown while `isExternalMenuOpen` is true, BEFORE the
   * editor acts. ProseMirror's DOM handler fires before a host capture handler
   * could, so menu navigation has to be routed here. Return true for keys the
   * menu consumed (Arrow/Enter/Tab/Escape) so the editor does nothing; return
   * false (e.g. a letter that filters the list) to let normal editing proceed.
   */
  onExternalMenuKeyDown?: (event: KeyboardEvent) => boolean
  /**
   * Arrow-key prompt history (the chat composer's Up/Down recall). Called for a
   * bare ArrowUp/ArrowDown BEFORE the caret moves, but ONLY when the collapsed
   * selection already sits at the document's first (`"older"`) or last
   * (`"newer"`) position — so the caret keeps moving line by line inside a
   * multi-line entry, and only a press at an edge switches prompts. Return true
   * to consume the key.
   *
   * Optional on purpose: the task and automation composers pass no handler and
   * keep the editor's default Arrow behaviour.
   */
  onHistoryKeyDown?: (
    direction: HistoryDirection,
    event: KeyboardEvent
  ) => boolean
  /**
   * Called on paste before the editor handles it. Return true when the paste was
   * consumed out-of-band (e.g. an image/file became an attachment) so the editor
   * does not also insert it as text.
   */
  onPasteFiles?: (event: ClipboardEvent) => boolean
  /**
   * Called on drop before the editor handles it. Return true when the drop was
   * consumed out-of-band (e.g. a dragged file-tree entry became an inline
   * reference) so ProseMirror does not also insert the drag's `text/plain`
   * fallback as literal text. The host must `stopPropagation()` itself if it
   * needs to keep the drop from bubbling to an ancestor container handler.
   */
  onDropFiles?: (event: DragEvent) => boolean
  /**
   * Paste-without-formatting intent: fired when `Ctrl/⌘+Shift+V` is pressed. The
   * host owns the clipboard read (and its non-secure fallback). Return true when
   * the host took over so the editor consumes the key and the browser's native
   * rich paste is suppressed; return false (or omit the prop) to let the native
   * "paste and match style" proceed (e.g. in a non-secure context where the async
   * clipboard read is unavailable).
   */
  onPlainPaste?: () => boolean
}

/**
 * Plain-text message composer: a Tiptap editor with IME-safe Enter-to-submit,
 * inline reference badges (the five built-in reference kinds), and an optional
 * unified `@` mention panel (enabled by `referenceSearch`). No Markdown — typed
 * formatting stays literal; see {@link buildComposerExtensions}.
 */
export const RichComposer = forwardRef<RichComposerHandle, RichComposerProps>(
  function RichComposer(
    {
      defaultText,
      placeholder,
      autoFocus,
      disabled,
      ariaLabel,
      className,
      style,
      onChange,
      onSubmit,
      onFocus,
      onBlur,
      onReady,
      referenceSearch,
      mentionUiLabels,
      tabLabels,
      mentionAnchorRef,
      knownInvocations,
      submitShortcut,
      newlineShortcut,
      isExternalMenuOpen,
      onExternalMenuKeyDown,
      onHistoryKeyDown,
      onPasteFiles,
      onDropFiles,
      onPlainPaste,
    },
    ref
  ) {
    // Keep callbacks in refs so the editor (and its keymap) is created once and
    // never torn down just because a parent re-renders with new closures.
    const onChangeRef = useRef(onChange)
    const onSubmitRef = useRef(onSubmit)
    const onFocusRef = useRef(onFocus)
    const onBlurRef = useRef(onBlur)
    const onReadyRef = useRef(onReady)
    // Latest referenceSearch, read at event time so the mention plugin (always
    // installed) is gated on whether mentions are currently enabled — robust to
    // the prop being added/removed after the editor is created once.
    const referenceSearchRef = useRef(referenceSearch)
    // Read at event time (paste, seed) rather than baked into the editor, so a
    // command list that arrives after the connection comes up applies without
    // rebuilding the editor — and without disturbing what is already typed.
    const knownInvocationsRef = useRef(knownInvocations)
    const submitShortcutRef = useRef(submitShortcut)
    const newlineShortcutRef = useRef(newlineShortcut)
    const isExternalMenuOpenRef = useRef(isExternalMenuOpen)
    const onExternalMenuKeyDownRef = useRef(onExternalMenuKeyDown)
    const onHistoryKeyDownRef = useRef(onHistoryKeyDown)
    const onPasteFilesRef = useRef(onPasteFiles)
    const onDropFilesRef = useRef(onDropFiles)
    const onPlainPasteRef = useRef(onPlainPaste)
    // The live editor, captured for command access inside editorProps handlers
    // (which are created before `editor` is assigned in this closure).
    const editorInstanceRef = useRef<Editor | null>(null)
    // Fallback anchor for the `@` panel when the host names no outer box.
    const rootRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
      onChangeRef.current = onChange
      onSubmitRef.current = onSubmit
      onFocusRef.current = onFocus
      onBlurRef.current = onBlur
      onReadyRef.current = onReady
      referenceSearchRef.current = referenceSearch
      knownInvocationsRef.current = knownInvocations
      submitShortcutRef.current = submitShortcut
      newlineShortcutRef.current = newlineShortcut
      isExternalMenuOpenRef.current = isExternalMenuOpen
      onExternalMenuKeyDownRef.current = onExternalMenuKeyDown
      onHistoryKeyDownRef.current = onHistoryKeyDown
      onPasteFilesRef.current = onPasteFiles
      onDropFilesRef.current = onDropFiles
      onPlainPasteRef.current = onPlainPaste
    })

    // ── Unified `@` mention panel state bridge ──
    // The suggestion plugin lives in ProseMirror; its lifecycle is bridged to
    // this React state so the popup can render in-tree (where data hooks work).
    const [mentionState, setMentionState] = useState<MentionRenderState | null>(
      null
    )
    // Mirrors `mentionState != null` for synchronous reads inside handleKeyDown
    // (so Enter defers to the panel without waiting for a re-render).
    const mentionOpenRef = useRef(false)
    const popupRef = useRef<SuggestionPopupHandle>(null)
    // Stable controller created once (refs/setState are stable), so the editor
    // is built a single time with it.
    const mentionController = useMemo<MentionController>(
      () => ({
        onStart: (mention) => {
          // Inert unless mentions are enabled (no referenceSearch → no panel).
          if (!referenceSearchRef.current) return
          mentionOpenRef.current = true
          setMentionState(mention)
        },
        onUpdate: (mention) => {
          if (!referenceSearchRef.current) return
          setMentionState(mention)
        },
        onExit: () => {
          mentionOpenRef.current = false
          setMentionState(null)
        },
        onKeyDown: (event) => popupRef.current?.onKeyDown(event) ?? false,
      }),
      []
    )

    // The placeholder is read through a ref rather than baked in, so a host
    // that changes its hint (the task drawer swaps one per follow-up scenario)
    // repaints instead of remounting the editor. A remount would take the
    // document with it — including badges whose bytes live out of band and
    // cannot be recovered from the serialized text.
    const placeholderRef = useRef(placeholder)
    const getPlaceholder = useCallback(() => placeholderRef.current ?? "", [])

    /** The invocations badge-able right now (see the `knownInvocations` prop). */
    const known = useCallback(
      () => knownInvocationsRef.current ?? NO_KNOWN_INVOCATIONS,
      []
    )

    const editor = useEditor({
      // Static export / SSR safety: never render on the server.
      immediatelyRender: false,
      // The mention plugin is always installed (the editor is created once);
      // it stays inert until `referenceSearch` is set (checked at runtime in the
      // controller). `mentionController` (stable, from useMemo) captures refs
      // but only dereferences them inside event-time callbacks, never during
      // render — the React Compiler lint can't prove that. Mirrors Tiptap's own
      // React suggestion pattern (render() → component.ref.onKeyDown).
      // eslint-disable-next-line react-hooks/refs
      extensions: buildComposerExtensions({
        placeholder: getPlaceholder,
        mentionController,
      }),
      editable: !disabled,
      autofocus: autoFocus ? "end" : false,
      editorProps: {
        attributes: {
          // `grow`: the editable node fills the scroll area (a flex column, see
          // EditorContent below) so the blank space under a short draft is
          // still the contenteditable and a tap there focuses it natively. Its
          // automatic minimum size keeps it from being squeezed under its own
          // text once the composer is at max height and scrolling.
          class: "codeg-composer-content grow",
          role: "textbox",
          "aria-multiline": "true",
          ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        },
        handleKeyDown: (view, event) => {
          // Mid-IME-composition every key belongs to the input method, so hand
          // it straight back to the editor before any menu can claim it — the
          // Enter that picks a CJK candidate must not select a slash command
          // (`decideComposerKey` repeats this for the submit/newline path).
          if (isImeCompositionKey(event) || view.composing) return false
          // The internal `@` panel's suggestion plugin owns its navigation keys;
          // never submit/break while it is open.
          if (mentionOpenRef.current) return false
          // An external (host) menu — e.g. the `/` runtime command list — gets
          // first refusal on keys while open. ProseMirror's DOM handler runs
          // before any host capture handler could, so routing happens here: the
          // host returns true for keys it consumed (Arrow/Enter/Tab/Escape) so
          // the editor does nothing, or false (e.g. a letter that filters the
          // list) to let the inline token keep growing.
          if (isExternalMenuOpenRef.current) {
            return onExternalMenuKeyDownRef.current?.(event) ?? false
          }
          // Prompt history (chat composer only): a bare Up/Down at the
          // document's first/last position steps through sent prompts; anywhere
          // else the editor keeps the caret movement, which is what makes a
          // multi-line recalled message navigable line by line. Placed after
          // the menus so an open panel always wins, and after the IME guard
          // above so a CJK candidate list keeps its own Arrow keys.
          //
          // A modifier keeps the native meaning: Shift+Arrow extends the
          // selection (empty until it spans), and Ctrl/Alt+Arrow is a
          // word/line jump — none of them is "recall a prompt".
          if (
            onHistoryKeyDownRef.current &&
            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
            !event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            const { selection, doc } = view.state
            const older = event.key === "ArrowUp"
            // The edge that counts is the DOCUMENT's, not the current block's.
            // The box is normally one paragraph of hard breaks, but a native
            // paste can leave several paragraphs in it (see the quote
            // decoration's scan) — and in one of those, the start of paragraph
            // two is an ordinary "move up a line", not a recall.
            const atBoundary =
              selection.empty &&
              (older
                ? selection.from === Selection.atStart(doc).from
                : selection.to === Selection.atEnd(doc).to)
            if (atBoundary) {
              return onHistoryKeyDownRef.current(
                older ? "older" : "newer",
                event
              )
            }
          }
          // Paste without formatting: Ctrl/⌘+Shift+V routes to the host, which
          // owns the clipboard read. Consume the key (suppressing the browser's
          // native rich paste) only when the host takes over; otherwise return
          // false so the native "paste and match style" proceeds — the correct
          // fallback in a non-secure context where the async read is unavailable.
          if (matchShortcutEvent(event, "mod+shift+v")) {
            return onPlainPasteRef.current?.() === true
          }
          // Bindings are free-form (Enter, Shift+Enter, Mod+Enter, Tab, …). The
          // composer is plain text, so there is no code block or list to carve
          // out — inCodeBlock/inList are always false and one decision suffices.
          const keyEvent = {
            key: event.key,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            isComposing: event.isComposing,
            keyCode: (event as { keyCode?: number }).keyCode ?? 0,
          }
          const bindings = {
            submit: submitShortcutRef.current ?? "enter",
            newline: newlineShortcutRef.current ?? "shift+enter",
          }
          const action = decideComposerKey(
            keyEvent,
            { composing: view.composing, inCodeBlock: false, inList: false },
            bindings
          )
          if (action === "submit") {
            // Only consume the key once a handler actually runs; otherwise let
            // the editor apply its default (Enter splits the paragraph).
            if (!onSubmitRef.current) return false
            onSubmitRef.current()
            return true
          }
          if (action === "newline") {
            const ed = editorInstanceRef.current
            if (!ed) return false
            ed.commands.setHardBreak()
            return true
          }
          return false
        },
        handlePaste: (_view, event) => {
          // Images/files first: the host may consume them as attachments
          // out-of-band, in which case the editor must not also insert text.
          if (onPasteFilesRef.current?.(event) === true) return true
          // Plain-text composer: prefer the clipboard's text/plain over an
          // external text/html fragment (a URL copied from an address bar
          // would otherwise paste as the page title), and hydrate serialized
          // references in the pasted text back into inline badges so the
          // composer previews them the way the sent message renders. See
          // decidePastedContent for what still defers to ProseMirror
          // (reference-free plain text, and our own copied badges/structure).
          const editor = editorInstanceRef.current
          const clipboard = event.clipboardData
          if (!editor || !clipboard) return false
          const inline = decidePastedContent(
            {
              html: clipboard.getData("text/html"),
              text: clipboard.getData("text/plain"),
            },
            known()
          )
          if (!inline) return false
          editor.chain().insertContent(inline).run()
          return true
        },
        handleDrop: (_view, event) => onDropFilesRef.current?.(event) === true,
      },
      onCreate: ({ editor }) => {
        editorInstanceRef.current = editor
        if (defaultText) {
          editor.commands.setContent(textToSeededDoc(defaultText, known()), {
            emitUpdate: false,
          })
        }
        // The imperative handle is now usable; let the host hydrate a draft /
        // queue-edit document that a plain `defaultText` can't represent.
        onReadyRef.current?.()
      },
      onDestroy: () => {
        editorInstanceRef.current = null
      },
      onUpdate: ({ editor }) => {
        onChangeRef.current?.(serializeDocToText(editor.state.doc))
      },
      onFocus: () => onFocusRef.current?.(),
      onBlur: () => onBlurRef.current?.(),
    })

    // Reflect disabled changes onto the live editor. Pass emitUpdate=false so
    // toggling editability never fires onUpdate/onChange without a real edit.
    useEffect(() => {
      editor?.setEditable(!disabled, false)
    }, [editor, disabled])

    useEffect(() => {
      placeholderRef.current = placeholder
      // Tiptap resolves the placeholder while building decorations, which only
      // happens on a transaction — so an empty one is what makes a changed hint
      // appear. Nothing is inserted, and it is skipped entirely on the first
      // pass (the editor already painted this value at creation).
      const view = editor?.view
      if (!view) return
      view.dispatch(view.state.tr)
    }, [editor, placeholder])

    useImperativeHandle(
      ref,
      (): RichComposerHandle => ({
        getText: () => (editor ? serializeDocToText(editor.state.doc) : ""),
        setText: (text) =>
          editor?.commands.setContent(textToSeededDoc(text, known())),
        setDoc: (doc) => editor?.commands.setContent(doc),
        clear: () => editor?.commands.clearContent(true),
        focus: () => editor?.commands.focus("end"),
        focusAtCoords: (clientX, clientY) => {
          if (!editor) return
          const view = editor.view
          // Map the click point to a document position. Chrome clicks land on
          // the composer's padding/dead space, which is *outside* the
          // contenteditable (`view.dom` is the inner `.ProseMirror`; the
          // `px-3 py-2` padding lives on the EditorContent wrapper), so
          // `posAtCoords` returns null there. Clamp the point onto the editor's
          // own box and retry, so left/top/bottom-padding clicks snap to the
          // nearest in-text position (native-textarea feel) instead of jumping
          // to the end. Only a point that maps nowhere even when clamped (e.g.
          // an empty editor edge case) falls through to end-of-doc.
          let hit = view.posAtCoords({ left: clientX, top: clientY })
          if (!hit) {
            const rect = view.dom.getBoundingClientRect()
            const left = Math.min(
              Math.max(clientX, rect.left + 1),
              rect.right - 1
            )
            const top = Math.min(
              Math.max(clientY, rect.top + 1),
              rect.bottom - 1
            )
            hit = view.posAtCoords({ left, top })
          }
          if (hit) {
            editor.chain().focus().setTextSelection(hit.pos).run()
          } else {
            editor.commands.focus("end")
          }
        },
        isEmpty: () => editor?.isEmpty ?? true,
        getJSON: () => editor?.getJSON() ?? { type: "doc", content: [] },
        insertTextAtCursor: (text) => {
          // `\n` → hardBreak so line breaks survive in the plain-text schema,
          // and serialized references hydrate back into badges (same treatment
          // as a paste — see textToSeededInlineContent). No Markdown parsing
          // (and thus no schema-rejection throw) is possible, so no recovery
          // path is needed.
          editor
            ?.chain()
            .focus()
            .insertContent(textToSeededInlineContent(text, known()))
            .run()
        },
        insertReference: (attrs) => {
          editor?.chain().focus().insertReference(attrs).run()
        },
        getEditor: () => editor ?? null,
      }),
      [editor, known]
    )

    const closeMention = useCallback(() => {
      mentionOpenRef.current = false
      setMentionState(null)
      // Also dismiss the Tiptap suggestion plugin so its state can't stay active
      // while React thinks the panel is closed (onExit will also fire).
      const view = editor?.view
      if (view) exitSuggestion(view)
    }, [editor])

    // If mentions get disabled while a panel is open, actively dismiss it so the
    // editor's Enter handling and the plugin state return to normal (the popup
    // also unmounts via the render guard below).
    useEffect(() => {
      if (!referenceSearch && mentionOpenRef.current) closeMention()
    }, [referenceSearch, closeMention])

    const handleReferenceSelect = useCallback(
      (reference: ReferenceAttrs, range: { from: number; to: number }) => {
        editor
          ?.chain()
          .focus()
          .deleteRange(range)
          .insertReference(reference)
          .insertContent(" ")
          .run()
        closeMention()
      },
      [editor, closeMention]
    )

    // Combobox ARIA on the editing surface: DOM focus stays in the editor while
    // the `@` panel is open, so the controlled-listbox relationship lives on the
    // contentEditable. `aria-activedescendant` is mirrored from the popup's
    // active row (below); here we toggle `aria-controls` and clear both when the
    // panel closes. (role stays "textbox" — a multiline editor that surfaces an
    // autocomplete list, the recognized textbox-autocomplete pattern.)
    const isMentionOpen = mentionState !== null
    useEffect(() => {
      const dom = editor?.view.dom
      if (!dom) return
      if (isMentionOpen) {
        // `aria-autocomplete="list"` tells AT this textbox offers a list of
        // completions; `aria-controls` names the listbox it drives.
        dom.setAttribute("aria-autocomplete", "list")
        dom.setAttribute("aria-controls", MENTION_LISTBOX_ID)
      } else {
        dom.removeAttribute("aria-autocomplete")
        dom.removeAttribute("aria-controls")
        dom.removeAttribute("aria-activedescendant")
      }
    }, [editor, isMentionOpen])

    const handleActiveOptionChange = useCallback(
      (optionId: string | null) => {
        const dom = editor?.view.dom
        if (!dom) return
        if (optionId) dom.setAttribute("aria-activedescendant", optionId)
        else dom.removeAttribute("aria-activedescendant")
      },
      [editor]
    )

    return (
      <div
        ref={rootRef}
        className={cn("codeg-composer flex min-h-0 flex-col", className)}
        style={style}
        data-disabled={disabled || undefined}
      >
        {/* `grow` (a CONTENT flex basis), never `flex-1` (a ZERO basis). The
            box this sits in is a flex column whose height usually comes only
            from a `min-height`, and an engine that treats such a column as
            main-size-indefinite hands its `flex-grow` children no free space
            at all. Off a zero basis that leaves the editable area at 0px: the
            action row rides up to the top of the box, the rest of it is
            untappable dead space, and the placeholder is clipped away — the
            mobile-web report in #746. Off a content basis the editor is always
            at least as tall as the text it holds, whatever the engine does,
            while `min-h-0` still lets it shrink and scroll at the box's
            max height.

            The column here plus `grow` on the editable node itself (see the
            `codeg-composer-content` class) also makes the contenteditable
            cover the whole editable area, so a tap on the blank space under a
            short draft lands on the editor natively instead of going through
            the chrome's mousedown fallback — which touch has no reliable
            equivalent for. */}
        <EditorContent
          editor={editor}
          className="codeg-composer-scroll flex min-h-0 grow flex-col overflow-y-auto px-3 py-2 text-base md:text-sm"
        />
        {referenceSearch && mentionState && (
          <SuggestionPopup
            // Remount per `@` session so panel state (active/pinned tab,
            // selection) never leaks when one suggestion exits and another
            // starts in the same React update (onExit + onStart batched).
            key={mentionState.range.from}
            ref={popupRef}
            state={mentionState}
            search={referenceSearch}
            onSelect={handleReferenceSelect}
            onClose={closeMention}
            anchorRef={mentionAnchorRef ?? rootRef}
            onActiveOptionChange={handleActiveOptionChange}
            emptyLabel={mentionUiLabels?.empty}
            loadingLabel={mentionUiLabels?.loading}
            listboxLabel={mentionUiLabels?.listbox}
            moreLabel={mentionUiLabels?.more}
            countLabel={mentionUiLabels?.count}
            tabLabels={tabLabels}
          />
        )}
      </div>
    )
  }
)
