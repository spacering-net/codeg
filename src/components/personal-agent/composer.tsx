"use client"

/**
 * The personal agent's input box: one line, round at the ends, a "+" on the
 * left (attachments only) on a neutral wash of its own and the send button
 * on the right of the same size, in the theme's colour — solid once there is
 * something to send, a tint of it until then; no shadow, and focus only
 * colours the border.
 * Once the text needs a second line — or a quote or a picture is attached —
 * it opens up: the text takes the box's whole width at the top and the two
 * buttons sit on a row of their own under it, so no line ever runs into
 * them; it stays open until the text is gone (closing at the wrap point
 * would make it flap). It grows with what is typed — the height eases
 * between sizes — up to 40% of the window, then scrolls, the text fading out
 * at the edge it is cut at. Sizes are in rem, so the ends stay round at any
 * app zoom.
 *
 * Everything sent here lands on the timeline at once, unread, and goes out
 * with the next delivery: right away when the agent is idle, after the turn
 * in flight otherwise — so the box sends while the agent works too, and the
 * button stays send. Stopping a turn is on the reply being written (its
 * actions) and in the "⋯" menu, which also stops a compaction.
 *
 * Its own box rather than the board's `TaskMessageComposer`: no slash
 * commands (a typed `/compact` would bypass the compaction codeg keeps
 * account of), no quick messages or skills, and a quote above the line.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { ArrowUp } from "lucide-react"
import { toast } from "sonner"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { ComposerAddMenu } from "@/components/chat/composer/composer-add-menu"
import { ComposerImageThumbnails } from "@/components/chat/composer/composer-image-thumbnails"
import {
  RichComposer,
  type RichComposerHandle,
} from "@/components/chat/composer/rich-composer"
import { isEmbeddedReferenceUri } from "@/components/chat/composer/reference-uri"
import { useComposerAttachments } from "@/components/chat/composer/use-composer-attachments"
import { useComposerChromeFocus } from "@/components/chat/composer/use-composer-chrome-focus"
import { useComposerMentionLabels } from "@/components/chat/composer/use-composer-mention-labels"
import { useReferenceSearch } from "@/components/chat/composer/use-reference-search"
import { ServerFileBrowserDialog } from "@/components/shared/server-file-browser-dialog"
import { useReducedMotion } from "@/hooks/use-chat-motion"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useBotId } from "@/contexts/personal-agent-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"
import { personalAgentSend } from "@/lib/api"
import { extractAppCommandError } from "@/lib/app-error"
import type {
  PersonalAgentInfo,
  PersonalAgentStatus,
  PromptCapabilitiesInfo,
  PromptInputBlock,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { AnswerBar, type AnsweringQuestion } from "./answer-bar"
import { useMatterError } from "./matter-text"
import { QuoteBar } from "./quote-bar"

/** What the agent is assumed to accept: the engine sends the blocks as
 *  stored, and a pasted image should show as a thumbnail, not a badge. */
const ASSUMED_PROMPT_CAPABILITIES: PromptCapabilitiesInfo = {
  image: true,
  audio: false,
  embedded_context: true,
}
const HEIGHT_MS = 180

/** The "+": a wash of the text colour — apart from the box's own surface
 *  and from the theme colour the send button carries, translucent so it
 *  reads the same over a workspace background image — a shade deeper on
 *  hover and while its menu is open. */
const PLUS_FILL =
  "bg-foreground/[0.07] hover:bg-foreground/[0.12] aria-expanded:bg-foreground/[0.12] dark:bg-foreground/10 dark:hover:bg-foreground/15 dark:aria-expanded:bg-foreground/15"

/** Where the parts sit: one row, or the text over the buttons. */
const AREAS_LINE = '"plus editor send"'
const AREAS_OPEN =
  '"quote quote quote" "media media media" "editor editor editor" "plus . send"'

/** Whether the editor's text takes more than one line. */
function textWraps(dom: HTMLElement): boolean {
  const first = dom.firstElementChild
  if (!first) return false
  if (dom.childElementCount > 1) return true
  const line = parseFloat(getComputedStyle(dom).lineHeight)
  return (
    Number.isFinite(line) && first.getBoundingClientRect().height > line * 1.4
  )
}

interface ComposerProps {
  agent: PersonalAgentInfo
  agentName: string
  status: PersonalAgentStatus
  /** The row the next message quotes. */
  quoting: number | null
  /** The assistant's question the next message answers (never with a
   *  quote). */
  answering?: AnsweringQuestion | null
  /** Text to put in the box (a card's message the owner edits first); a
   *  new `n` puts it in again. */
  draft?: { text: string; n: number } | null
  onClearQuote: () => void
  /** A message quoting `rowId` went out: its quote goes, if the page still
   *  has it. */
  onQuoteSent?: (rowId: number) => void
  onClearAnswer?: () => void
  /** A message went out. */
  onSent?: () => void
}

/** Each send's own number, for the window's life: what it settles is its
 *  own, never a later send's. */
let lastRequest = 0

export function PersonalAgentComposer({
  agent,
  agentName,
  status,
  quoting,
  answering = null,
  draft,
  onClearQuote,
  onQuoteSent,
  onClearAnswer,
  onSent,
}: ComposerProps) {
  const t = useTranslations("PersonalAgent.composer")
  const errorText = useMatterError()
  const tInput = useTranslations("Folder.chat.messageInput")
  const { shortcuts } = useShortcutSettings()
  const reduced = useReducedMotion()
  const editorRef = useRef<RichComposerHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chromeFocus = useComposerChromeFocus(editorRef)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)

  const { groupLabels, uiLabels, primaryAssistantName } =
    useComposerMentionLabels()
  // The other assistants are named with `@` (D8): the brain reads each as
  // its name and number, and hands work over itself if it should.
  // The workspace's folders, offered whole ahead of the assistant's own
  // files: "@my-app" names the project — not its task worktrees.
  const openFolders = useAppWorkspaceStore((s) => s.folders)
  const mentionFolders = useMemo(
    () =>
      openFolders
        .filter((f) => f.parent_id == null)
        .map((f) => ({ name: f.alias?.trim() || f.name, path: f.path })),
    [openFolders]
  )
  const referenceSearch = useReferenceSearch({
    defaultPath: agent.workdir,
    enabled: true,
    labels: groupLabels,
    excludeAssistantUid: agent.uid,
    primaryAssistantName,
    folders: mentionFolders,
  })
  const attach = useComposerAttachments({
    editorRef,
    containerRef,
    // Nothing added while it sends: the box is locked until it returns.
    disabled: status.engine !== "here" || sending,
    promptCapabilities: ASSUMED_PROMPT_CAPABILITIES,
    defaultPath: agent.workdir,
    logLabel: "PersonalAgentComposer",
  })

  /** The bytes behind every pasted-file badge still in the document. */
  const embeddedBlocks = useCallback((): PromptInputBlock[] => {
    const editor = editorRef.current?.getEditor()
    if (!editor) return []
    const blocks: PromptInputBlock[] = []
    editor.state.doc.descendants((node) => {
      if (
        node.type.name === "reference" &&
        typeof node.attrs?.uri === "string" &&
        isEmbeddedReferenceUri(node.attrs.uri)
      ) {
        const real = attach.embeddedPayloadsRef.current.get(node.attrs.uri)
        if (real) blocks.push(real)
      }
      return true
    })
    return blocks
  }, [attach.embeddedPayloadsRef])

  const readOnly = status.engine !== "here"
  const botId = useBotId()
  const turn = status.turn
  const empty =
    text.trim().length === 0 &&
    attach.attachments.length === 0 &&
    // eslint-disable-next-line react-hooks/refs -- the pasted files' bytes sit in a ref the editor writes; every edit re-renders, so this reads it fresh
    embeddedBlocks().length === 0
  const canSend = !readOnly && !sending && !empty
  const hasImages = attach.imageAttachments.length > 0
  // The text has needed a second line since the box was last empty.
  const [wrapped, setWrapped] = useState(false)
  // The editor mounts after the first render (`onReady`).
  const [editorReady, setEditorReady] = useState(false)
  const open = wrapped || quoting != null || answering != null || hasImages

  // The box is one assistant's (the page keys it by them): a send that
  // lands once it is gone — the owner switched assistants meanwhile — leaves
  // the page's quote and scroll, now the next one's, alone.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // While it sends, the box is locked — the text, the attachments, a card's
  // "put in the box" — so what it clears on return is exactly what went:
  // the page reads whether this assistant's box is sending.
  const bot = agent.id
  useEffect(() => {
    if (!sending) return
    const ui = usePersonalAgentUi.getState()
    ui.setComposerSending(bot, true)
    return () => ui.setComposerSending(bot, false)
  }, [bot, sending])
  // The quote as the page has it now: one picked while a send is out is not
  // to be undone by that send's failure.
  const quotingNow = useRef(quoting)
  useEffect(() => {
    quotingNow.current = quoting
  }, [quoting])
  // Back to the line once it is unlocked, when it had the focus.
  const refocus = useRef(false)
  useEffect(() => {
    if (sending || !refocus.current) return
    refocus.current = false
    editorRef.current?.focus()
  }, [sending])

  const send = async () => {
    if (!canSend || !editorRef.current) return
    if (attach.hasUploadingImage || attach.intakePending) {
      toast.message(t("waitForUpload"))
      return
    }
    const body = editorRef.current.getText()
    const blocks = [...embeddedBlocks(), ...attach.imagePromptBlocks()]
    // What this send settles, taken now — not read again from the page
    // when it returns.
    const sentAnswer = answering
    const sentQuote = answering ? null : quoting
    const requestId = ++lastRequest
    const ui = usePersonalAgentUi.getState()
    if (sentAnswer) {
      ui.setAnswerSending(bot, { itemId: sentAnswer.itemId, requestId })
    }
    refocus.current =
      containerRef.current?.contains(document.activeElement) ?? false
    setSending(true)
    try {
      await personalAgentSend(
        body,
        blocks,
        sentQuote,
        botId,
        null,
        sentAnswer?.itemId ?? null
      )
      // The answer's bar goes even when the box is gone meanwhile (the
      // owner switched assistants): it is this assistant's, and answered.
      ui.clearAnswerSending(bot, requestId)
      if (sentAnswer) ui.clearPendingAnswer(bot, sentAnswer.itemId)
      if (!mounted.current) return
      editorRef.current?.clear()
      attach.clearAttachments()
      setText("")
      setWrapped(false)
      if (sentQuote != null) onQuoteSent?.(sentQuote)
      onSent?.()
    } catch (e) {
      ui.clearAnswerSending(bot, requestId)
      // What was typed stays; a question that can no longer be answered
      // takes its bar with it, so the next send is a plain message. One
      // that failed otherwise gets its bar back, should it have gone
      // meanwhile — unless something else was picked since (another
      // question, or a quote, which takes the bar's place), or the box is
      // gone (the owner moved on; what this box saw is not the page's now).
      const key = extractAppCommandError(e)?.i18n_key
      if (sentAnswer) {
        if (
          key === "matterErrors.answerChanged" ||
          key === "matterErrors.answerQueued"
        ) {
          ui.clearPendingAnswer(bot, sentAnswer.itemId)
        } else if (
          mounted.current &&
          !usePersonalAgentUi.getState().pendingAnswer[bot] &&
          quotingNow.current == null
        ) {
          ui.setPendingAnswer({ bot, ...sentAnswer })
        }
      }
      toast.error(errorText(e))
    } finally {
      setSending(false)
    }
  }

  // Quoting focuses the line, ready to type the reply; answering too.
  useEffect(() => {
    if (quoting != null) editorRef.current?.focus()
  }, [quoting])
  const answeringId = answering?.itemId ?? null
  useEffect(() => {
    if (answeringId != null) editorRef.current?.focus()
  }, [answeringId])

  // A card's message to edit first: after what is already typed, never in
  // place of it.
  const draftN = draft?.n
  // One the box was opened with is not new: a draft goes in once.
  const draftApplied = useRef(draftN ?? null)
  useEffect(() => {
    const editor = editorRef.current
    if (draftN == null || !draft || !editor) return
    if (draftApplied.current === draftN) return
    draftApplied.current = draftN
    const before = editor.isEmpty() ? "" : editor.getText().trimEnd()
    const next = before ? `${before}\n\n${draft.text}` : draft.text
    editor.setText(next)
    setText(next)
    editor.focus()
    // Only a new draft puts it in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftN, editorReady])

  // Open the box once the text wraps (the editor's own size changes with
  // every wrap, and with the box's width); `onChange` closes it once the
  // text is gone.
  useEffect(() => {
    if (!editorReady) return
    const dom = editorRef.current?.getEditor()?.view.dom
    if (!dom || typeof ResizeObserver === "undefined") return
    // An empty document is one line (its placeholder takes no height), so
    // only real lines open it — blank ones included.
    const ro = new ResizeObserver(() => {
      if (textWraps(dom)) setWrapped(true)
    })
    ro.observe(dom)
    return () => ro.disconnect()
  }, [editorReady])

  // Text scrolled past the editor's top or bottom edge fades out there.
  // Wired once the editor is there: TipTap remounts its scroller when the
  // editor arrives, so the one present at first render goes away.
  useEffect(() => {
    if (!editorReady) return
    const scroller = containerRef.current?.querySelector<HTMLElement>(
      ".codeg-composer-scroll"
    )
    if (!scroller || typeof ResizeObserver === "undefined") return
    const update = () => {
      // Only padding scrolled away cuts no text: no fade for that (nor for
      // the line being typed at the bottom, which the editor keeps in view).
      const style = getComputedStyle(scroller)
      const padTop = parseFloat(style.paddingTop) || 0
      const padBottom = parseFloat(style.paddingBottom) || 0
      const top = scroller.scrollTop > padTop + 1
      const bottom =
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop >
        padBottom + 1
      const fade = [top ? "top" : "", bottom ? "bottom" : ""]
        .filter(Boolean)
        .join(" ")
      if (fade) scroller.setAttribute("data-fade", fade)
      else scroller.removeAttribute("data-fade")
    }
    const ro = new ResizeObserver(update)
    ro.observe(scroller)
    let content: Element | null = null
    const watchContent = () => {
      const next = scroller.firstElementChild
      if (next && next !== content) {
        if (content) ro.unobserve(content)
        content = next
        ro.observe(next)
      }
    }
    const mo = new MutationObserver(watchContent)
    mo.observe(scroller, { childList: true })
    watchContent()
    update()
    scroller.addEventListener("scroll", update, { passive: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
      scroller.removeEventListener("scroll", update)
    }
  }, [editorReady])

  // The box's height eases to its content's. Measured, not animated with
  // `interpolate-size` / `field-sizing`: WebKit (the macOS and Linux
  // desktops) lacks them. First paint and an unchanged size write nothing.
  const inner = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [eased, setEased] = useState(false)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el || typeof ResizeObserver === "undefined") return
    let first = true
    const ro = new ResizeObserver(() => {
      const next = el.offsetHeight
      setHeight((prev) => (prev === next ? prev : next))
      if (first) {
        first = false
        requestAnimationFrame(() => setEased(true))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const placeholder = readOnly
    ? t("readOnly")
    : turn
      ? t("placeholderBusy", { name: agentName })
      : t("placeholder", { name: agentName })

  const buttonBase =
    "inline-flex size-7.5 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"

  return (
    <div className="shrink-0 pt-1 pb-4">
      <div className="mx-auto w-full chat-content-w px-4">
        <div
          ref={containerRef}
          {...chromeFocus}
          {...attach.containerDragProps}
          data-open={open || undefined}
          className={cn(
            // Round ends: half the one-line height (1.875rem buttons,
            // 0.5rem padding, a 1px border), in rem so app zoom keeps them
            // round. Border and surface as the conversation's own box: a
            // border that stays visible over a workspace background image,
            // and no fill there (the image shows through, as on the rest of
            // the canvas). No shadow, and no ring on focus: the border takes
            // the ring colour.
            "pa-composer codeg-composer-chrome relative rounded-[calc(1.4375rem+1px)] border border-foreground/15 bg-background ws-transparent-bg transition-colors focus-within:border-ring",
            readOnly && "opacity-60"
          )}
        >
          {/* Bottom-anchored: while the height eases, what is cut is the top
              of the text, never the buttons on the bottom row. */}
          <div
            className="flex flex-col justify-end overflow-hidden"
            style={{
              height: height ?? undefined,
              transition:
                eased && !reduced
                  ? `height ${HEIGHT_MS}ms ease-out`
                  : undefined,
            }}
          >
            {/* One grid for both shapes, so the editor never remounts (and
                keeps its text, caret and focus) when the box opens. */}
            <div
              ref={inner}
              // `shrink-0`: at its own height while the box eases around it,
              // or it would measure the easing box and never grow. The
              // buttons sit 0.5rem in from the border all round, and on one
              // line the text starts as far from the "+" (the editor's own
              // start padding: no gap between the columns).
              className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center p-2"
              style={{ gridTemplateAreas: open ? AREAS_OPEN : AREAS_LINE }}
            >
              <div className="flex" style={{ gridArea: "plus" }}>
                <ComposerAddMenu
                  attachOnly
                  disabled={readOnly || sending}
                  attachments={attach}
                  // `border-0`: the button's transparent border would clip
                  // the fill a pixel short of the send button's on each side.
                  triggerClassName={cn(
                    "size-7.5 rounded-full border-0 text-foreground hover:text-foreground [&_svg]:size-4",
                    PLUS_FILL
                  )}
                />
              </div>
              {answering ? (
                <div className="pb-1.5" style={{ gridArea: "quote" }}>
                  <AnswerBar
                    question={answering}
                    onDismiss={() => {
                      onClearAnswer?.()
                      editorRef.current?.focus()
                    }}
                  />
                </div>
              ) : quoting != null ? (
                <div className="pb-1.5" style={{ gridArea: "quote" }}>
                  <QuoteBar
                    targetId={quoting}
                    onDismiss={() => {
                      onClearQuote()
                      // Back to the line, to go on typing.
                      editorRef.current?.focus()
                    }}
                  />
                </div>
              ) : null}
              {hasImages ? (
                <div
                  className="flex gap-2 overflow-x-auto px-1 pb-1.5"
                  style={{ gridArea: "media" }}
                >
                  <ComposerImageThumbnails
                    attachments={attach.imageAttachments}
                    onRemove={attach.removeAttachment}
                    disabled={sending}
                  />
                </div>
              ) : null}
              <div className="min-w-0" style={{ gridArea: "editor" }}>
                <RichComposer
                  ref={editorRef}
                  defaultText=""
                  placeholder={placeholder}
                  ariaLabel={t("ariaLabel")}
                  disabled={readOnly || sending}
                  referenceSearch={referenceSearch}
                  mentionUiLabels={uiLabels}
                  tabLabels={groupLabels}
                  mentionAnchorRef={containerRef}
                  submitShortcut={shortcuts.send_message}
                  newlineShortcut={shortcuts.newline_in_message}
                  onChange={(next) => {
                    setText(next)
                    if (next.length === 0) setWrapped(false)
                  }}
                  onReady={() => setEditorReady(true)}
                  onSubmit={() => void send()}
                  onPasteFiles={attach.handlePasteFiles}
                  onDropFiles={attach.handleEditorDrop}
                  // The text's size and line: `.pa-composer` in globals.css.
                  // No end padding: the strip kept for the scroll bar (10px,
                  // globals.css) is the room before the send button. Half a
                  // pixel more under the text than over it, the 0.5rem the
                  // same: the glyphs sit a little low in their line (the
                  // Chinese ones by up to 0.75px, a lowercase line more), so
                  // on one line the text is centred on the buttons to the eye.
                  className="max-h-[40vh] [&_.codeg-composer-scroll]:ps-2 [&_.codeg-composer-scroll]:pe-0 [&_.codeg-composer-scroll]:pt-[0.21875rem] [&_.codeg-composer-scroll]:pb-[0.28125rem]"
                />
              </div>
              <div className="flex" style={{ gridArea: "send" }}>
                <button
                  type="button"
                  className={cn(
                    buttonBase,
                    canSend
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "bg-primary/12 text-primary dark:bg-primary/20"
                  )}
                  disabled={!canSend}
                  onClick={() => void send()}
                  title={turn ? t("queue") : t("send")}
                  aria-label={turn ? t("queue") : t("send")}
                >
                  {sending ? (
                    <SyncedSpinner small className="size-4" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
          {attach.isDragActive ? (
            <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-[1.1875rem] border border-dashed border-primary/50 bg-background/80 text-xs text-muted-foreground">
              {tInput("dropFilesToAttach")}
            </div>
          ) : null}
          {!attach.showNativePaperclip && (
            <ServerFileBrowserDialog
              open={attach.serverFilePickerOpen}
              onOpenChange={attach.setServerFilePickerOpen}
              onSelect={attach.handleServerFilesSelected}
              initialPath={agent.workdir}
            />
          )}
        </div>
      </div>
    </div>
  )
}
