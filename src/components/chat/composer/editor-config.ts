import type { Extensions } from "@tiptap/core"
import { Placeholder } from "@tiptap/extension-placeholder"
import StarterKit from "@tiptap/starter-kit"

import { InactiveSelectionHighlight } from "./inactive-selection"
import { Reference } from "./nodes/reference-node"
import { QuoteLineDecoration } from "./quote-decoration"
import {
  MentionSuggestion,
  type MentionController,
} from "./suggestion/mention-suggestion"

/**
 * Options for the shared composer extension set.
 */
export interface ComposerExtensionOptions {
  /** Placeholder shown when the document is empty. Pass a getter to keep it
   *  live: Tiptap resolves it per decoration pass, so a host whose hint changes
   *  (the task drawer's follow-up scenarios) can update it without recreating
   *  the editor — and losing the document with it. */
  placeholder?: string | (() => string)
  /**
   * When provided, enables the unified `@` mention panel: the suggestion plugin
   * forwards lifecycle/keys to this controller, whose React popup owns data and
   * insertion.
   */
  mentionController?: MentionController
}

/**
 * Build the Tiptap extension set powering the message composer.
 *
 * Shared by the live editor ({@link "./rich-composer".RichComposer}) and the
 * headless editor used in tests, so serialization exercised by tests matches
 * what users actually type.
 *
 * This is a PLAIN-TEXT composer: the only content is prose, hard line breaks,
 * and inline {@link Reference} badges (the five built-in reference kinds). All of
 * StarterKit's formatting nodes/marks — headings, bold/italic/strike, inline
 * code, code blocks, blockquotes, lists, horizontal rules, and the Link mark —
 * are disabled, which also removes their Markdown input rules. So typing `# `,
 * `**x**`, `- `, `` ``` `` etc. stays literal, `lib.rs` never linkifies, and a
 * pasted `[label](uri)` is inserted as plain text (never a link mark). Only
 * document/paragraph/text/hardBreak/undoRedo (+ dropcursor/gapcursor/trailing
 * node) remain.
 *
 * The `@tiptap/markdown` extension is intentionally NOT loaded: nothing here
 * parses or serializes Markdown. Send serialization walks the doc to plain text
 * (references → their `referenceToMarkdown` token) in
 * {@link "./to-prompt-blocks".docToPromptBlocks}.
 */
export function buildComposerExtensions(
  options: ComposerExtensionOptions = {}
): Extensions {
  const extensions: Extensions = [
    // Disable every formatting node/mark; keep document/paragraph/text/hardBreak
    // + history (undoRedo) + dropcursor/gapcursor/trailingNode. `false` excludes
    // an extension entirely, so its schema node/mark AND its Markdown input rule
    // both go away.
    StarterKit.configure({
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      link: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      strike: false,
      underline: false,
    }),
    Placeholder.configure({
      placeholder:
        typeof options.placeholder === "function"
          ? options.placeholder
          : (options.placeholder ?? ""),
      // Only paint the placeholder while the editor is editable so a disabled
      // composer reads as empty rather than as a hint.
      showOnlyWhenEditable: true,
    }),
    Reference,
    // Keeps the selection visible when focus moves to the right-click menu.
    InactiveSelectionHighlight,
    // Paints line-leading `> ` markers as a blockquote rule. Decoration only —
    // the characters stay in the document, so send/copy/draft text is unchanged.
    QuoteLineDecoration,
  ]
  if (options.mentionController) {
    extensions.push(
      MentionSuggestion.configure({ controller: options.mentionController })
    )
  }
  return extensions
}
