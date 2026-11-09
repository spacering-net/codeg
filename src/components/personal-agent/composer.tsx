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
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { ArrowUp, Loader2 } from "lucide-react"
import { toast } from "sonner"

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
import { personalAgentSend } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  PersonalAgentInfo,
  PersonalAgentStatus,
  PromptCapabilitiesInfo,
  PromptInputBlock,
} from "@/lib/types"
import { cn } from "@/lib/utils"

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
  onClearQuote: () => void
  /** A message went out. */
  onSent?: () => void
}

export function PersonalAgentComposer({
  agent,
  agentName,
  status,
  quoting,
  onClearQuote,
  onSent,
}: ComposerProps) {
  const t = useTranslations("PersonalAgent.composer")
  const tInput = useTranslations("Folder.chat.messageInput")
  const { shortcuts } = useShortcutSettings()
  const reduced = useReducedMotion()
  const editorRef = useRef<RichComposerHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chromeFocus = useComposerChromeFocus(editorRef)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)

  const { groupLabels, uiLabels } = useComposerMentionLabels()
  const referenceSearch = useReferenceSearch({
    defaultPath: agent.workdir,
    enabled: true,
    labels: groupLabels,
  })
  const attach = useComposerAttachments({
    editorRef,
    containerRef,
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
    embeddedBlocks().length === 0
  const canSend = !readOnly && !sending && !empty
  const hasImages = attach.imageAttachments.length > 0
  // The text has needed a second line since the box was last empty.
  const [wrapped, setWrapped] = useState(false)
  // The editor mounts after the first render (`onReady`).
  const [editorReady, setEditorReady] = useState(false)
  const open = wrapped || quoting != null || hasImages

  const send = async () => {
    if (!canSend || !editorRef.current) return
    if (attach.hasUploadingImage) {
      toast.message(t("waitForUpload"))
      return
    }
    const body = editorRef.current.getText()
    const blocks = [...embeddedBlocks(), ...attach.imagePromptBlocks()]
    setSending(true)
    try {
      await personalAgentSend(body, blocks, quoting, botId)
      editorRef.current?.clear()
      attach.clearAttachments()
      setText("")
      setWrapped(false)
      onClearQuote()
      onSent?.()
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setSending(false)
    }
  }

  // Quoting focuses the line, ready to type the reply.
  useEffect(() => {
    if (quoting != null) editorRef.current?.focus()
  }, [quoting])

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
                  disabled={readOnly}
                  attachments={attach}
                  // `border-0`: the button's transparent border would clip
                  // the fill a pixel short of the send button's on each side.
                  triggerClassName={cn(
                    "size-7.5 rounded-full border-0 text-foreground hover:text-foreground [&_svg]:size-4",
                    PLUS_FILL
                  )}
                />
              </div>
              {quoting != null ? (
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
                  />
                </div>
              ) : null}
              <div className="min-w-0" style={{ gridArea: "editor" }}>
                <RichComposer
                  ref={editorRef}
                  defaultText=""
                  placeholder={placeholder}
                  ariaLabel={t("ariaLabel")}
                  disabled={readOnly}
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
                  // globals.css) is the room before the send button.
                  className="max-h-[40vh] [&_.codeg-composer-scroll]:py-1 [&_.codeg-composer-scroll]:ps-2 [&_.codeg-composer-scroll]:pe-0"
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
                    <Loader2 className="size-4 animate-spin" />
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
