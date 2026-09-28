"use client"

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type Ref,
} from "react"
import type { Editor } from "@tiptap/core"

import {
  ComposerInvocationsPopup,
  useComposerInvocations,
} from "@/components/automations/composer-invocations"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import { ComposerAddMenu } from "@/components/chat/composer/composer-add-menu"
import { ComposerImageThumbnails } from "@/components/chat/composer/composer-image-thumbnails"
import { restampSkillPrefixes } from "@/components/chat/composer/composer-commands"
import { useComposerChromeFocus } from "@/components/chat/composer/use-composer-chrome-focus"
import {
  RichComposer,
  type RichComposerHandle,
} from "@/components/chat/composer/rich-composer"
import { isEmbeddedReferenceUri } from "@/components/chat/composer/reference-uri"
import { docToPromptBlocks } from "@/components/chat/composer/to-prompt-blocks"
import { useComposerAttachments } from "@/components/chat/composer/use-composer-attachments"
import { useComposerMentionLabels } from "@/components/chat/composer/use-composer-mention-labels"
import { useComposerShortcuts } from "@/components/chat/composer/use-composer-shortcuts"
import { useReferenceSearch } from "@/components/chat/composer/use-reference-search"
import { ServerFileBrowserDialog } from "@/components/shared/server-file-browser-dialog"
import { useTranslations } from "next-intl"
import type {
  AgentType,
  AvailableCommandInfo,
  PromptCapabilitiesInfo,
  PromptInputBlock,
} from "@/lib/types"

/**
 * What a task agent is assumed to accept before its probe has answered.
 *
 * Optimistic on purpose, and safe to be: unlike a chat send, a task's blocks are
 * STORED and dispatched later, so the engine re-encodes every image for whatever
 * the launched session actually advertises (`reencode_images` in
 * `work_task/engine.rs`) — which also covers a task whose agent changed after
 * the brief was written. That leaves this deciding one thing only: whether a
 * pasted image is presented as a thumbnail or degraded to an inline file badge.
 * Assuming no images would cost the feature outright during the probe window,
 * and permanently for an agent codeg cannot probe at all.
 */
const ASSUMED_PROMPT_CAPABILITIES: PromptCapabilitiesInfo = {
  image: true,
  audio: false,
  embedded_context: true,
}

export interface TaskMessageComposerHandle {
  /** The document's send text: prose with reference badges inlined as their
   *  tokens. Always read this at submit time — React state trails a keystroke. */
  getText: () => string
  getEditor: () => Editor | null
  /** Prose + inline references + out-of-band attachments, ready to store as a
   *  task's `prompt_blocks`. */
  getPromptBlocks: () => PromptInputBlock[]
  /** Just the out-of-band parts (images, path-less pasted bytes) — for the
   *  surfaces whose text rides its own string field. */
  getAttachmentBlocks: () => PromptInputBlock[]
  /** Whether an image upload is still in flight (a send must wait). */
  hasUploadingImage: () => boolean
  /** Whether anything is attached at all — an image-only note is still a note. */
  hasAttachments: () => boolean
  clear: () => void
}

export interface TaskMessageComposerProps {
  ref?: Ref<TaskMessageComposerHandle>
  /** Agent the task runs as — decides the skill trigger, the probed CLI, and
   *  how attached images are encoded. */
  agentType: AgentType
  /** Working directory the references, commands and file pickers resolve in. */
  folderPath: string | null
  /** Content on mount; read once (the editor is uncontrolled afterwards). */
  defaultText: string
  /** A stored prompt to seed instead of `defaultText` — prose, inline
   *  references AND attachments. Editing a task passes its `prompt_blocks` so a
   *  save that touches only the title doesn't drop the images. */
  defaultBlocks?: PromptInputBlock[] | null
  placeholder: string
  /** Accessible name for the editing surface. */
  ariaLabel: string
  autoFocus?: boolean
  /** Key binding that sends. Omit `onSubmit` to make every Enter a newline. */
  submitShortcut?: string
  newlineShortcut?: string
  onChange: (text: string) => void
  onSubmit?: () => void
  /** Notifies the host when the attached set changes, so a send button can
   *  enable on an image-only note. */
  onAttachmentsChange?: (count: number) => void
  /** Extra controls in the bottom bar, right of the "+" (the task editor's
   *  mode/model selectors). */
  bottomBarExtra?: ReactNode
  /** Sizing for the editor surface itself. */
  editorClassName?: string
}

/**
 * The conversation composer, on the to-do board.
 *
 * Every place a task carries a message to an agent — the new/edit task brief,
 * the follow-up on a reviewed task, the note on a restart — gets the same box as
 * the chat page: `@` references (files, agents, sessions, commits), `/` slash
 * commands from the agent's own probe, `$` skills on Codex, the "+" menu (saved
 * quick messages, slash commands, expert / office / research skills, attach
 * files), and pasted / dropped / picked images as thumbnails.
 *
 * The wire format is unchanged and shared with chat: badges serialize back to
 * `[label](file:///…)` / `/cmd` / `$skill` (`referenceToMarkdown`) inside one
 * text block, and attachments ride alongside as their own `PromptInputBlock`s
 * ({@link TaskMessageComposerHandle.getAttachmentBlocks}).
 *
 * The transient agent probe runs on mount, and hosts only mount this while the
 * box is open — opening the drawer alone never spawns a CLI.
 */
export function TaskMessageComposer({
  ref,
  agentType,
  folderPath,
  defaultText,
  defaultBlocks,
  placeholder,
  ariaLabel,
  autoFocus,
  submitShortcut,
  newlineShortcut,
  onChange,
  onSubmit,
  onAttachmentsChange,
  bottomBarExtra,
  editorClassName = "max-h-[12rem] min-h-[4.5rem]",
}: TaskMessageComposerProps) {
  const t = useTranslations("Folder.chat.messageInput")
  const editorRef = useRef<RichComposerHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chromeFocus = useComposerChromeFocus(editorRef)

  const { groupLabels, uiLabels } = useComposerMentionLabels()
  const referenceSearch = useReferenceSearch({
    defaultPath: folderPath,
    enabled: true,
    labels: groupLabels,
  })

  // One transient probe backs the `/` menu (the snapshot carries
  // available_commands) and the image encoding (prompt_capabilities); `$`
  // skills are a filesystem scan inside `useComposerInvocations`.
  const agentOptions = useAgentOptions(agentType, folderPath)
  const availableCommands: AvailableCommandInfo[] =
    agentOptions.snapshot?.available_commands ?? []
  const promptCapabilities =
    agentOptions.snapshot?.prompt_capabilities ?? ASSUMED_PROMPT_CAPABILITIES

  const invocations = useComposerInvocations({
    editorRef,
    agentType,
    folderPath,
    availableCommands,
  })

  const attach = useComposerAttachments({
    editorRef,
    containerRef,
    promptCapabilities,
    defaultPath: folderPath,
    logLabel: "TaskComposer",
  })
  const shortcuts = useComposerShortcuts({
    editorRef,
    agentType,
    onAfterInsert: () => onChange(editorRef.current?.getText() ?? ""),
    logLabel: "TaskComposer",
  })

  // Keep already-inserted skill badges on the current agent's trigger (`$` is
  // Codex's; everyone else invokes skills as `/`).
  useEffect(() => {
    const editor = editorRef.current?.getEditor()
    if (editor) restampSkillPrefixes(editor, agentType === "codex" ? "$" : "/")
  }, [agentType])

  /** The bytes-bearing block behind every embedded badge still in the document,
   *  walked live so a deleted badge simply never emits (and an undo re-emits). */
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

  const getAttachmentBlocks = useCallback(
    (): PromptInputBlock[] => [
      ...embeddedBlocks(),
      ...attach.imagePromptBlocks(),
    ],
    [embeddedBlocks, attach]
  )

  // Everything attached out of band: thumbnails AND the pathless bytes behind
  // sentinel badges. The host gates its send on this, and a pasted file with no
  // path serializes to nothing in the text — counting only images would leave
  // that send disabled with a visible attachment sitting in the box.
  const attachmentTotal = attach.attachments.length + embeddedBlocks().length
  const reportedTotalRef = useRef(-1)
  useEffect(() => {
    if (reportedTotalRef.current === attachmentTotal) return
    reportedTotalRef.current = attachmentTotal
    onAttachmentsChange?.(attachmentTotal)
    // The host only cares about the count; re-firing on a new callback identity
    // would spam it on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentTotal])

  // Seed a stored prompt back into the box (editing a task, applying a
  // template): images return to the strip and bytes-bearing resources get fresh
  // sentinel badges, so a save that changes only the title keeps them. Runs once
  // the editor exists; `defaultBlocks` is read at that moment and not watched,
  // matching `defaultText` — the box is uncontrolled after mount.
  const hydratedRef = useRef(false)
  // Read inside the deferred frame rather than captured with the callback: the
  // agent probe that fills the list can still be in flight at mount, and a brief
  // holding a real `/cmd` should come back as that command's badge.
  const knownInvocationsRef = useRef(invocations.knownInvocations)
  useEffect(() => {
    knownInvocationsRef.current = invocations.knownInvocations
  }, [invocations.knownInvocations])
  const handleReady = useCallback(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    const editor = editorRef.current?.getEditor()
    if (!editor || !defaultBlocks || defaultBlocks.length === 0) return
    // Deferred a frame: restoring a badge mounts a React NodeView rendered with
    // a synchronous flushSync(), which warns if run during React's commit.
    requestAnimationFrame(() => {
      const live = editorRef.current?.getEditor()
      if (!live) return
      attach.hydrateFromBlocks(live, defaultBlocks, knownInvocationsRef.current)
      onChange(editorRef.current?.getText() ?? "")
    })
    // Mount-time seed: re-running on a new `defaultBlocks` identity would
    // clobber whatever the user has typed since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      getText: () => editorRef.current?.getText() ?? "",
      getEditor: () => editorRef.current?.getEditor() ?? null,
      getPromptBlocks: () => {
        const editor = editorRef.current?.getEditor()
        return [
          ...(editor ? docToPromptBlocks(editor) : []),
          ...getAttachmentBlocks(),
        ]
      },
      getAttachmentBlocks,
      hasUploadingImage: () => attach.hasUploadingImage,
      hasAttachments: () =>
        attach.attachments.length > 0 || embeddedBlocks().length > 0,
      clear: () => {
        editorRef.current?.clear()
        attach.clearAttachments()
      },
    }),
    [attach, embeddedBlocks, getAttachmentBlocks]
  )

  return (
    <div
      ref={containerRef}
      // Clicking or tapping the box's padding focuses the nearest caret, like a
      // textarea.
      {...chromeFocus}
      {...attach.containerDragProps}
      // Same shell the drawer's Textarea had (and the same rounding as every
      // other box in it); the editor brings the matching px-3 padding.
      className="codeg-composer-chrome relative rounded-xl border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-inset focus-within:ring-ring/50"
    >
      <ComposerInvocationsPopup inv={invocations} />
      {attach.imageAttachments.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto px-2 pt-2">
          <ComposerImageThumbnails
            attachments={attach.imageAttachments}
            onRemove={attach.removeAttachment}
          />
        </div>
      ) : null}
      {/* Not keyed by the placeholder: RichComposer repaints a changed hint in
          place (the drawer swaps one per follow-up scenario). Remounting would
          take the document with it, and an attachment whose bytes live out of
          band cannot be recovered from the serialized text. */}
      <RichComposer
        ref={editorRef}
        defaultText={defaultText}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        referenceSearch={referenceSearch}
        mentionUiLabels={uiLabels}
        tabLabels={groupLabels}
        // Same box the `/` menu hangs off, so both panels span the composer.
        mentionAnchorRef={containerRef}
        knownInvocations={invocations.knownInvocations}
        submitShortcut={submitShortcut}
        newlineShortcut={newlineShortcut}
        onReady={handleReady}
        onChange={(text) => {
          onChange(text)
          invocations.detect()
        }}
        onSubmit={onSubmit}
        onPasteFiles={attach.handlePasteFiles}
        onDropFiles={attach.handleEditorDrop}
        isExternalMenuOpen={invocations.isOpen}
        onExternalMenuKeyDown={invocations.onKeyDown}
        className={editorClassName}
      />
      {/* Centered, not bottom-aligned: the bar mixes a 24px icon button with
          whatever the config section is currently showing (a one-line spinner
          while probing, chips once it lands), and only centering keeps the "+"
          on the same axis as all of them. */}
      <div className="flex items-center justify-between gap-1 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-1">
          <ComposerAddMenu
            attachments={attach}
            shortcuts={shortcuts}
            slashCommands={availableCommands}
          />
          {bottomBarExtra}
        </div>
      </div>
      {attach.isDragActive ? (
        <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-md border border-dashed border-primary/50 bg-background/80 text-xs text-muted-foreground">
          {t("dropFilesToAttach")}
        </div>
      ) : null}
      {!attach.showNativePaperclip && (
        <ServerFileBrowserDialog
          open={attach.serverFilePickerOpen}
          onOpenChange={attach.setServerFilePickerOpen}
          onSelect={attach.handleServerFilesSelected}
          initialPath={folderPath ?? undefined}
        />
      )}
    </div>
  )
}
