"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type RefObject,
  type SetStateAction,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  isEmptyAttachmentError,
  readFileBase64,
  uploadAttachment,
  uploadLocalPathToRemote,
  UPLOAD_I18N_KEY_NOT_A_FILE,
  UPLOAD_I18N_KEY_QUOTA_EXCEEDED,
  UPLOAD_I18N_KEY_TOO_LARGE,
  UPLOAD_MAX_BYTES,
} from "@/lib/api"
// Local-IPC file read (never proxied to a remote workspace). Used for the
// thumbnail preview of a locally-dropped image whose BYTES were uploaded to
// the remote server — `api.readFileBase64` would route through the remote
// transport and try to read the local path on the wrong machine.
import { readFileBase64 as readLocalFileBase64 } from "@/lib/tauri"
import { extractAppCommandError } from "@/lib/app-error"
import { readPageHandoffBlock } from "@/lib/browser/page-handoff-block"
import { usePageHandoffName } from "@/lib/browser/use-page-handoff-name"
import {
  clipboardHasText,
  filesFromClipboard,
  imageFilesFromClipboardApi,
} from "@/lib/clipboard-images"
import {
  hasFileTreeDragType,
  readFileTreeDragPayload,
} from "@/lib/file-tree-dnd"
import type { KnownInvocations } from "@/lib/invocation-token"
import { isDesktop, openFileDialog } from "@/lib/platform"
import {
  buildFileUri,
  buildFileUriWithRange,
  formatFileRangeLabel,
} from "@/lib/reference-link"
import { disposeTauriListener } from "@/lib/tauri-listener"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import { randomUUID } from "@/lib/utils"
import type { PromptCapabilitiesInfo, PromptInputBlock } from "@/lib/types"
import type { Editor } from "@tiptap/core"

import {
  imageAttachmentToPromptBlock,
  type ImageInputAttachment,
  type InputAttachment,
  type ResourceInputAttachment,
} from "@/components/chat/message-input-attachments"
import { restoreBlocksIntoEditor } from "@/components/chat/composer/composer-commands"
import { buildEmbeddedReferenceUri } from "@/components/chat/composer/reference-uri"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import {
  blobToBase64,
  buildClipboardResourceUri,
  buildDataUri,
  DRAG_DROP_IMAGE_MAX_BYTES,
  editorHasFileReference,
  fileNameFromPath,
  getFilePath,
  hasDragFiles,
  isTextLikeFile,
  mimeTypeFromPath,
  pointWithinElement,
} from "@/components/chat/composer/attachment-files"

/**
 * The composer's attachment engine, shared by the conversation composer and the
 * to-do task composers (new/edit task, follow-up, restart note).
 *
 * Two destinations, decided by the connected agent's declared capabilities:
 *
 * - **Images** → an out-of-band thumbnail strip, serialized at send time by
 *   {@link imageAttachmentToPromptBlock} (native `image` block, or an embedded
 *   `resource` blob for agents that take embedded context but reject images).
 * - **Everything else** → an inline file-reference badge in the editor document,
 *   exactly like an `@`-file mention. A real path uses its `file://` uri; bytes
 *   with no path (a desktop paste) get an inert `codeg://embedded/…` display uri
 *   whose real block is held in `embeddedPayloadsRef` until send.
 *
 * Every entry point funnels through the same classifier, so paste, OS drop,
 * browser drop, the native picker, the web upload picker and the server file
 * browser all produce identical blocks.
 */

/** Console prefix, so a log line still names the surface it came from. */
type LogLabel = string

export interface ComposerAttachmentsOptions {
  /** The editor the inline badges are inserted into. */
  editorRef: RefObject<RichComposerHandle | null>
  /** Drop target for OS drags (Tauri reports window coordinates, not events on
   *  the element). Omit to leave OS drag-drop off for this composer. */
  containerRef?: RefObject<HTMLElement | null>
  /** While true, drops/pastes/picks are ignored (the editor stays editable). */
  disabled?: boolean
  /** Decides whether images may be attached at all, and how they are encoded. */
  promptCapabilities: Pick<PromptCapabilitiesInfo, "image" | "embedded_context">
  /** Groups uploads with the session/tab that owns them (quota + cleanup). */
  attachmentTabId?: string | null
  /** Start directory for the native picker and the server file browser. */
  defaultPath?: string | null
  logLabel?: LogLabel
}

export interface ComposerAttachments {
  attachments: InputAttachment[]
  /** Escape hatch for hosts that restore a whole attachment set at once (the
   *  conversation composer re-editing a queued message). */
  setAttachments: Dispatch<SetStateAction<InputAttachment[]>>
  imageAttachments: ImageInputAttachment[]
  /** True while a web/remote image upload is still in flight — sends must wait,
   *  the block would otherwise carry neither bytes nor a uri to hydrate from. */
  hasUploadingImage: boolean
  /** An OS/browser drag is hovering the composer. */
  isDragActive: boolean
  /** Local desktop: OS paths are readable by the agent, so the native picker is
   *  offered. False in web mode and for a desktop bound to a remote workspace. */
  showNativePaperclip: boolean
  /** Whether images route to the thumbnail strip (in any wire encoding). */
  canAttachImages: boolean
  embeddedPayloadsRef: RefObject<Map<string, PromptInputBlock>>

  insertFileReferences: (
    items: Array<{
      name: string
      uri?: string
      realBlock?: PromptInputBlock
      /** With a `realBlock`: the ref its badge carries in its display uri
       *  (see `buildEmbeddedReferenceUri`). */
      ref?: string
    }>,
    opts?: { atCaret?: boolean }
  ) => void
  appendResourceAttachments: (
    paths: string[],
    opts?: { atCaret?: boolean }
  ) => void
  appendFileRangeAttachment: (
    path: string,
    range: { start: number; end: number },
    opts?: { atCaret?: boolean }
  ) => void
  appendFilesFromInput: (files: File[]) => Promise<void>

  /** Routed from RichComposer's `onPasteFiles`; true = the paste was consumed. */
  handlePasteFiles: (event: ClipboardEvent) => boolean
  /** Routed from RichComposer's `onDropFiles`; true = the drop was consumed. */
  handleEditorDrop: (event: DragEvent) => boolean
  /** Spread onto the composer's outer chrome for browser drag-drop. */
  containerDragProps: {
    onDragOver: (event: ReactDragEvent<HTMLElement>) => void
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => void
    onDrop: (event: ReactDragEvent<HTMLElement>) => void
  }
  handlePickFiles: () => Promise<void>
  handleUploadLocalFiles: () => Promise<void>
  handleServerFilesSelected: (paths: string[]) => void
  serverFilePickerOpen: boolean
  setServerFilePickerOpen: (open: boolean) => void

  /** Replay a stored `PromptInputBlock[]` into this composer: prose + file
   *  badges inline, images into the strip, bytes-bearing resources re-registered
   *  behind fresh sentinel badges. Replaces whatever the editor held. `known`
   *  is the host's advertised invocations, gating bare `/cmd` tokens in the
   *  prose (see {@link restoreBlocksIntoEditor}). */
  hydrateFromBlocks: (
    editor: Editor,
    blocks: PromptInputBlock[],
    known?: KnownInvocations
  ) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  /** The image blocks for a send, in the encoding the agent accepts. Inline
   *  badge payloads are folded in by the caller's document walk. */
  imagePromptBlocks: () => PromptInputBlock[]
}

export function useComposerAttachments({
  editorRef,
  containerRef,
  disabled = false,
  promptCapabilities,
  attachmentTabId = null,
  defaultPath = null,
  logLabel = "Composer",
}: ComposerAttachmentsOptions): ComposerAttachments {
  // Same namespace the conversation composer has always used for these toasts,
  // so no message moves and every surface reports uploads identically.
  const tAttach = useTranslations("Folder.chat.messageInput")

  const desktopMode = isDesktop()
  // Cached for the window's lifetime: `getActiveRemoteConnectionId()` is
  // configured once when a remote-workspace window is created and never
  // mutates afterwards. A desktop window bound to a remote codeg-server
  // has to behave like the web client for attachments — local OS paths
  // would be ENOENT on the remote agent. Only the truly local desktop
  // shows the native Paperclip picker.
  const showNativePaperclip = useMemo(
    () => desktopMode && getActiveRemoteConnectionId() === null,
    [desktopMode]
  )

  // Route pasted / dropped / picked images to the thumbnail strip whenever the
  // agent can receive them in ANY form — either as a native ACP image block
  // (`image`) or as an embedded resource blob (`embedded_context`, what an
  // agent that advertises `image: false` but `embeddedContext: true` takes).
  const canAttachImages =
    promptCapabilities.image || promptCapabilities.embedded_context

  const [attachments, setAttachments] = useState<InputAttachment[]>([])
  const embeddedPayloadsRef = useRef<Map<string, PromptInputBlock>>(new Map())
  const [isDragActive, setIsDragActive] = useState(false)
  const dragActiveRef = useRef(false)
  const lastDomDropAtRef = useRef(0)
  const disabledRef = useRef(disabled)
  const [serverFilePickerOpen, setServerFilePickerOpen] = useState(false)
  // Read when a restore runs rather than closed over: `hydrateFromBlocks`
  // keeps one identity for the composer's lifetime (its hydration effects
  // re-run whenever it changes), and the names follow the app's language.
  const pageHandoffName = usePageHandoffName()
  const pageHandoffNameRef = useRef(pageHandoffName)

  useEffect(() => {
    disabledRef.current = disabled
  }, [disabled])

  useEffect(() => {
    pageHandoffNameRef.current = pageHandoffName
  }, [pageHandoffName])

  const setDragActiveIfChanged = useCallback((next: boolean) => {
    if (dragActiveRef.current === next) return
    dragActiveRef.current = next
    setIsDragActive(next)
  }, [])

  // Insert one inline file reference badge per item, matching `@`-file mentions.
  // A genuine `file://` item uses its uri directly (deduped against the document);
  // an item carrying a `realBlock` (embedded bytes / `data:` link) gets an inert
  // `codeg://embedded/…` display uri (carrying the item's `ref`, when it has
  // one) and its block is stashed in `embeddedPayloadsRef` for send-time
  // reconciliation. Badges append at the doc
  // end by default; pass `atCaret` to drop them at the composer's current caret
  // (`focus()` keeps the retained selection even while the input is blurred —
  // e.g. focus sits in the file editor), so "add to chat" lands a reference
  // where the user left off instead of always at the end.
  const insertFileReferences = useCallback(
    (
      items: Array<{
        name: string
        uri?: string
        realBlock?: PromptInputBlock
        ref?: string
      }>,
      opts: { atCaret?: boolean } = {}
    ) => {
      if (items.length === 0) return
      const editor = editorRef.current?.getEditor()
      if (!editor) return
      const seen = new Set<string>()
      let chain = opts.atCaret
        ? editor.chain().focus()
        : editor.chain().focus("end")
      let inserted = 0
      for (const item of items) {
        let refUri: string
        if (item.realBlock) {
          refUri = buildEmbeddedReferenceUri(item.ref)
          embeddedPayloadsRef.current.set(refUri, item.realBlock)
        } else {
          if (!item.uri) continue
          refUri = item.uri
          if (seen.has(refUri) || editorHasFileReference(editor, refUri))
            continue
          seen.add(refUri)
        }
        chain = chain
          .insertReference({
            refType: "file",
            id: refUri,
            label: item.name,
            uri: refUri,
            meta: { fileKind: "file" },
          })
          .insertContent(" ")
        inserted++
      }
      if (inserted > 0) chain.run()
    },
    [editorRef]
  )

  const appendResourceLinks = useCallback(
    (
      links: Array<{
        uri: string
        name: string
        mimeType: string | null
        dedupeKey: string
      }>,
      opts: { atCaret?: boolean } = {}
    ) => {
      // `file://` links the agent can read directly become inline file badges
      // (uri used as-is); a non-fetchable `data:` link keeps its real block out
      // of band behind a sentinel badge.
      insertFileReferences(
        links
          .filter((link) => link.uri)
          .map((link) =>
            link.uri.toLowerCase().startsWith("file://")
              ? { name: link.name, uri: link.uri }
              : {
                  name: link.name,
                  realBlock: {
                    type: "resource_link" as const,
                    uri: link.uri,
                    name: link.name,
                    mime_type: link.mimeType,
                    description: null,
                  },
                }
          ),
        opts
      )
    },
    [insertFileReferences]
  )

  const appendResourceAttachments = useCallback(
    (paths: string[], opts: { atCaret?: boolean } = {}) => {
      const normalized = paths
        .filter(
          (path): path is string => typeof path === "string" && path.length > 0
        )
        .map((path) => {
          const uri = buildFileUri(path)
          return {
            uri,
            name: fileNameFromPath(path),
            mimeType: mimeTypeFromPath(path),
            dedupeKey: uri,
          }
        })
      appendResourceLinks(normalized, opts)
    },
    [appendResourceLinks]
  )

  // Attach a single file as a ranged badge (`foo.ts:10-25`), used by the file
  // editor's "add selection to chat". The line span is encoded into both the
  // label and the uri fragment (`file://…#L10-25`), so distinct selections of
  // the same file stay distinct (the uri is the dedupe key in
  // `insertFileReferences`) and the range rides along to the agent in the
  // serialized `[label](uri)` link.
  const appendFileRangeAttachment = useCallback(
    (
      path: string,
      range: { start: number; end: number },
      opts: { atCaret?: boolean } = {}
    ) => {
      if (!path) return
      insertFileReferences(
        [
          {
            name: formatFileRangeLabel(fileNameFromPath(path), range),
            uri: buildFileUriWithRange(path, range),
          },
        ],
        opts
      )
    },
    [insertFileReferences]
  )

  // Shared upload pool used by the menu's "Upload local file" button,
  // browser drag-drop in web mode, paste in web mode, and the fallback
  // path of `appendFilesAsResources` for remote-desktop. Splits oversize
  // from acceptable, runs uploads with bounded concurrency, surfaces
  // failures via toast, and finally appends the successful paths as
  // ResourceLinks. Returns nothing — all state changes happen via the
  // existing setters / toast.
  const uploadAndAppendFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const oversized = files.filter((f) => f.size > UPLOAD_MAX_BYTES)
      const accepted = files.filter((f) => f.size <= UPLOAD_MAX_BYTES)
      const limitMb = Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))
      if (oversized.length > 0) {
        toast.error(
          tAttach("attachUploadTooLarge", {
            limit: limitMb,
            names: oversized.map((f) => f.name).join(", "),
          })
        )
      }
      if (accepted.length === 0) return

      // Concurrent uploads — one failure doesn't block the rest. Cap at 3:
      // small enough to keep server load predictable, large enough to feel
      // responsive for a handful of files.
      const uploaded: string[] = []
      const failed: Array<{ name: string; reason: unknown }> = []
      const quotaRejected: string[] = []
      const CONCURRENCY = 3
      let cursor = 0
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, accepted.length) },
        async () => {
          while (cursor < accepted.length) {
            const idx = cursor++
            const file = accepted[idx]
            try {
              const r = await uploadAttachment(file, attachmentTabId ?? null)
              uploaded.push(r.path)
            } catch (error) {
              if (isEmptyAttachmentError(error)) {
                // Empty files are explicitly dropped on the floor — log
                // and move on without a user-facing error toast.
                console.warn(
                  `[${logLabel}] skipping empty attachment: ${file.name}`
                )
                continue
              }
              const appError = extractAppCommandError(error)
              if (appError?.i18n_key === UPLOAD_I18N_KEY_QUOTA_EXCEEDED) {
                quotaRejected.push(file.name)
                continue
              }
              failed.push({ name: file.name, reason: error })
            }
          }
        }
      )
      await Promise.all(workers)

      if (quotaRejected.length > 0) {
        toast.error(
          tAttach("attachUploadQuotaExceeded", {
            names: quotaRejected.join(", "),
          })
        )
      }
      if (failed.length > 0) {
        for (const f of failed) {
          console.error(
            `[${logLabel}] upload attachment failed (${f.name}):`,
            f.reason
          )
        }
        toast.error(
          tAttach("attachUploadFailed", {
            names: failed.map((r) => r.name).join(", "),
          })
        )
      }
      if (uploaded.length > 0) {
        appendResourceAttachments(uploaded)
      }
    },
    [appendResourceAttachments, attachmentTabId, logLabel, tAttach]
  )

  const appendEmbeddedResources = useCallback(
    (
      resources: Array<{
        uri: string
        name: string
        mimeType: string | null
        text?: string | null
        blob?: string | null
      }>
    ) => {
      // Inline bytes (no real path): each becomes a sentinel file badge whose
      // embedded `resource` block is reconciled back in at send time.
      insertFileReferences(
        resources.map((resource) => ({
          name: resource.name,
          realBlock: {
            type: "resource" as const,
            uri: resource.uri,
            mime_type: resource.mimeType,
            text: resource.text ?? null,
            blob: resource.blob ?? null,
          },
        }))
      )
    },
    [insertFileReferences]
  )

  // Path-less files (browser `File` objects: drag-drop in web mode, paste,
  // or `<input type=file>` in any mode) need a real backing path before
  // the agent can read them. Only the truly local desktop keeps the legacy
  // base64/embedded fallback — web and remote-desktop both push through
  // `uploadAndAppendFiles` so the resulting ResourceLink points at a real
  // server-side file.
  const appendFilesAsResources = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const pathLinks: Array<{
        uri: string
        name: string
        mimeType: string | null
        dedupeKey: string
      }> = []
      const fallbackDataLinks: Array<{
        uri: string
        name: string
        mimeType: string | null
        dedupeKey: string
      }> = []
      const embeddedResources: Array<{
        uri: string
        name: string
        mimeType: string | null
        text?: string | null
        blob?: string | null
      }> = []
      const uploadCandidates: File[] = []

      for (const file of files) {
        const path = getFilePath(file)
        const name = file.name || `resource-${randomUUID()}`
        const mimeType = file.type || mimeTypeFromPath(name)
        if (path) {
          const uri = buildFileUri(path)
          pathLinks.push({
            uri,
            name: fileNameFromPath(path),
            mimeType: mimeTypeFromPath(path) ?? mimeType ?? null,
            dedupeKey: uri,
          })
          continue
        }

        if (!showNativePaperclip) {
          uploadCandidates.push(file)
          continue
        }

        if (!promptCapabilities.embedded_context) {
          const base64 = await blobToBase64(file)
          const dataUri = buildDataUri(base64, mimeType ?? null)
          fallbackDataLinks.push({
            uri: dataUri,
            name,
            mimeType: mimeType ?? null,
            dedupeKey: `${name}:${file.size}:${file.lastModified}`,
          })
          continue
        }

        const uri = buildClipboardResourceUri(name)
        if (isTextLikeFile(file)) {
          const textContent = await file.text()
          embeddedResources.push({
            uri,
            name,
            mimeType: mimeType ?? null,
            text: textContent,
          })
        } else {
          const blobContent = await blobToBase64(file)
          embeddedResources.push({
            uri,
            name,
            mimeType: mimeType ?? null,
            blob: blobContent,
          })
        }
      }

      appendResourceLinks(pathLinks)
      appendResourceLinks(fallbackDataLinks)
      appendEmbeddedResources(embeddedResources)
      if (uploadCandidates.length > 0) {
        await uploadAndAppendFiles(uploadCandidates)
      }
    },
    [
      appendEmbeddedResources,
      appendResourceLinks,
      promptCapabilities.embedded_context,
      showNativePaperclip,
      uploadAndAppendFiles,
    ]
  )

  const appendImageAttachments = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      // Web / remote-workspace mode: the prompt request runs through the
      // HTTP API, whose body must stay small (axum's 2 MiB default limit —
      // a couple of inline base64 screenshots would 413 the send). Stream
      // the bytes through the upload endpoint instead; the base64 stays
      // local for the thumbnail and the transport strips it from the sent
      // block (`stripUploadedImagePayloads`), leaving the server to
      // re-inline the bytes from the uploaded file (`prompt_hydration`).
      // Desktop-local mode keeps the inline path — Tauri IPC has no body
      // limit and the workspace has no uploads dir.
      const uploadImages = !showNativePaperclip

      const oversized = uploadImages
        ? files.filter((f) => f.size > UPLOAD_MAX_BYTES)
        : []
      if (oversized.length > 0) {
        toast.error(
          tAttach("attachUploadTooLarge", {
            limit: Math.round(UPLOAD_MAX_BYTES / (1024 * 1024)),
            names: oversized.map((f) => f.name).join(", "),
          })
        )
      }
      const accepted = files.filter((file) => {
        if (uploadImages && file.size > UPLOAD_MAX_BYTES) return false
        if (uploadImages && file.size === 0) {
          // Matches `uploadAttachment`'s EmptyAttachmentError semantics:
          // dropped silently, no toast, no broken thumbnail.
          console.warn(
            `[${logLabel}] skipping empty image attachment: ${file.name}`
          )
          return false
        }
        return true
      })
      if (accepted.length === 0) return

      const parsed = await Promise.all(
        accepted.map(async (file, index) => {
          const mimeType =
            file.type && file.type.startsWith("image/")
              ? file.type
              : (mimeTypeFromPath(file.name) ?? "image/png")
          const base64Data = await blobToBase64(file)
          return {
            attachment: {
              id: `image:${Date.now()}:${index}:${randomUUID()}`,
              type: "image" as const,
              data: base64Data,
              uri: null,
              name: file.name || `image-${Date.now()}-${index + 1}`,
              mimeType,
              ...(uploadImages ? { uploading: true } : {}),
            },
            file,
          }
        })
      )
      // Thumbnails appear immediately; uploads settle in the background and
      // flip `uploading` off (send is gated on that by the host).
      setAttachments((prev) => [...prev, ...parsed.map((p) => p.attachment)])
      if (!uploadImages) return

      const failed: Array<{ name: string; reason: unknown }> = []
      const quotaRejected: string[] = []
      const CONCURRENCY = 3
      let cursor = 0
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, parsed.length) },
        async () => {
          while (cursor < parsed.length) {
            const idx = cursor++
            const { attachment, file } = parsed[idx]
            try {
              const r = await uploadAttachment(file, attachmentTabId ?? null)
              const uri = buildFileUri(r.path)
              setAttachments((prev) =>
                prev.map((a) =>
                  a.id === attachment.id ? { ...a, uri, uploading: false } : a
                )
              )
            } catch (error) {
              setAttachments((prev) =>
                prev.filter((a) => a.id !== attachment.id)
              )
              if (isEmptyAttachmentError(error)) {
                console.warn(
                  `[${logLabel}] skipping empty image attachment: ${attachment.name}`
                )
                continue
              }
              const appError = extractAppCommandError(error)
              if (appError?.i18n_key === UPLOAD_I18N_KEY_QUOTA_EXCEEDED) {
                quotaRejected.push(attachment.name)
                continue
              }
              failed.push({ name: attachment.name, reason: error })
            }
          }
        }
      )
      await Promise.all(workers)

      if (quotaRejected.length > 0) {
        toast.error(
          tAttach("attachUploadQuotaExceeded", {
            names: quotaRejected.join(", "),
          })
        )
      }
      if (failed.length > 0) {
        for (const f of failed) {
          console.error(
            `[${logLabel}] image upload failed (${f.name}):`,
            f.reason
          )
        }
        toast.error(
          tAttach("attachUploadFailed", {
            names: failed.map((r) => r.name).join(", "),
          })
        )
      }
    },
    [attachmentTabId, logLabel, showNativePaperclip, tAttach]
  )

  const appendImagePathAttachments = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || !canAttachImages) return
      const settled = await Promise.allSettled(
        paths.map(async (path, index) => {
          const data = await readFileBase64(path, DRAG_DROP_IMAGE_MAX_BYTES)
          return {
            id: `image:${Date.now()}:${index}:${randomUUID()}`,
            type: "image" as const,
            data,
            uri: buildFileUri(path),
            name: fileNameFromPath(path),
            mimeType: mimeTypeFromPath(path) ?? "image/png",
          }
        })
      )

      const parsed: ImageInputAttachment[] = []
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          parsed.push(result.value)
          return
        }
        console.error(
          `[${logLabel}] drop image path failed (${paths[index]}):`,
          result.reason
        )
      })
      if (parsed.length === 0) return
      setAttachments((prev) => [...prev, ...parsed])
    },
    [canAttachImages, logLabel]
  )

  const appendPathsFromDrop = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return
      const normalized = paths.filter(
        (path): path is string => typeof path === "string" && path.length > 0
      )
      if (normalized.length === 0) return

      const imagePaths: string[] = []
      const resourcePaths: string[] = []
      for (const path of normalized) {
        const mimeType = mimeTypeFromPath(path) ?? ""
        if (canAttachImages && mimeType.startsWith("image/")) {
          imagePaths.push(path)
        } else {
          resourcePaths.push(path)
        }
      }

      if (imagePaths.length > 0) {
        await appendImagePathAttachments(imagePaths)
      }
      if (resourcePaths.length > 0) {
        appendResourceAttachments(resourcePaths)
      }
    },
    [appendImagePathAttachments, appendResourceAttachments, canAttachImages]
  )

  const appendPathsFromDropRef = useRef(appendPathsFromDrop)
  useEffect(() => {
    appendPathsFromDropRef.current = appendPathsFromDrop
  }, [appendPathsFromDrop])

  // Remote-workspace counterpart of `appendPathsFromDrop`. Reads each
  // local path through Rust, ships the bytes via the upload proxy, then
  // appends the resulting server-side paths as ResourceLinks. Failures
  // (oversize, ENOENT, network) are reported in a single aggregated toast
  // matching `uploadAndAppendFiles`.
  const uploadPathsToRemote = useCallback(
    async (paths: string[]) => {
      const normalized = paths.filter(
        (p): p is string => typeof p === "string" && p.length > 0
      )
      if (normalized.length === 0) return

      const limitMb = Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))
      const succeeded: string[] = []
      const failed: Array<{ name: string; reason: unknown }> = []
      const oversize: string[] = []
      const directories: string[] = []
      const quotaRejected: string[] = []
      const imageAttachmentsToAdd: ImageInputAttachment[] = []

      const CONCURRENCY = 3
      let cursor = 0
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, normalized.length) },
        async () => {
          while (cursor < normalized.length) {
            const idx = cursor++
            const path = normalized[idx]
            const name = path.split(/[/\\]/).pop() || path
            try {
              const r = await uploadLocalPathToRemote(
                path,
                attachmentTabId ?? null
              )
              // A dropped image keeps its image-ness: attach it as a
              // thumbnail whose uri is the uploaded server-side file, so the
              // agent receives a real image block (hydrated server-side)
              // instead of a ResourceLink it may never open. The local path
              // is only readable on THIS desktop — the thumbnail preview
              // reads it via local IPC; the remote agent reads the upload.
              const mimeType = r.mimeType ?? mimeTypeFromPath(name) ?? ""
              if (canAttachImages && mimeType.startsWith("image/")) {
                const previewData = await readLocalFileBase64(
                  path,
                  UPLOAD_MAX_BYTES
                )
                imageAttachmentsToAdd.push({
                  id: `image:${Date.now()}:${idx}:${randomUUID()}`,
                  type: "image",
                  data: previewData,
                  uri: buildFileUri(r.path),
                  name,
                  mimeType,
                })
                continue
              }
              succeeded.push(r.path)
            } catch (error) {
              if (isEmptyAttachmentError(error)) {
                console.warn(
                  `[${logLabel}] skipping empty remote-drop attachment: ${name}`
                )
                continue
              }
              // The Rust side tags structured upload errors with an
              // `i18n_key` (see `app_error::UPLOAD_I18N_KEY_*`); branch
              // on the key so each user-visible category lands in its own
              // toast instead of the generic "upload failed" bucket.
              // Falling back to the bare message would couple us to the
              // exact English phrasing in `remote_proxy.rs`.
              const appError = extractAppCommandError(error)
              const i18nKey = appError?.i18n_key ?? null
              if (i18nKey === UPLOAD_I18N_KEY_TOO_LARGE) {
                oversize.push(name)
              } else if (i18nKey === UPLOAD_I18N_KEY_NOT_A_FILE) {
                // Dragging a directory or a special file (FIFO, device
                // node) lands here. The Rust guard short-circuits before
                // we even read bytes; surface a dedicated toast so the
                // user understands why nothing was attached.
                directories.push(name)
              } else if (i18nKey === UPLOAD_I18N_KEY_QUOTA_EXCEEDED) {
                quotaRejected.push(name)
              } else {
                failed.push({ name, reason: error })
              }
            }
          }
        }
      )
      await Promise.all(workers)

      if (oversize.length > 0) {
        toast.error(
          tAttach("attachUploadTooLarge", {
            limit: limitMb,
            names: oversize.join(", "),
          })
        )
      }
      if (directories.length > 0) {
        toast.error(
          tAttach("attachUploadNotAFile", {
            names: directories.join(", "),
          })
        )
      }
      if (quotaRejected.length > 0) {
        toast.error(
          tAttach("attachUploadQuotaExceeded", {
            names: quotaRejected.join(", "),
          })
        )
      }
      if (failed.length > 0) {
        for (const f of failed) {
          console.error(
            `[${logLabel}] remote path upload failed (${f.name}):`,
            f.reason
          )
        }
        toast.error(
          tAttach("attachUploadFailed", {
            names: failed.map((f) => f.name).join(", "),
          })
        )
      }
      if (imageAttachmentsToAdd.length > 0) {
        setAttachments((prev) => [...prev, ...imageAttachmentsToAdd])
      }
      if (succeeded.length > 0) {
        appendResourceAttachments(succeeded)
      }
    },
    [
      appendResourceAttachments,
      attachmentTabId,
      canAttachImages,
      logLabel,
      tAttach,
    ]
  )

  const uploadPathsToRemoteRef = useRef(uploadPathsToRemote)
  useEffect(() => {
    uploadPathsToRemoteRef.current = uploadPathsToRemote
  }, [uploadPathsToRemote])

  const appendFilesFromInput = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const imageFiles: File[] = []
      const resourceFiles: File[] = []
      for (const file of files) {
        const mimeType = file.type || mimeTypeFromPath(file.name) || ""
        if (canAttachImages && mimeType.startsWith("image/")) {
          imageFiles.push(file)
        } else {
          resourceFiles.push(file)
        }
      }

      if (imageFiles.length > 0) {
        await appendImageAttachments(imageFiles)
      }
      if (resourceFiles.length > 0) {
        await appendFilesAsResources(resourceFiles)
      }
    },
    [appendFilesAsResources, appendImageAttachments, canAttachImages]
  )

  // Routed from RichComposer's `onPasteFiles`. Returns true when the paste was
  // consumed as an attachment (so the editor doesn't also insert it as text).
  const handlePasteFiles = useCallback(
    (event: ClipboardEvent): boolean => {
      if (disabled) return false
      // The context-menu "Paste" drives text through `view.pasteText`, which
      // runs this handler with a synthetic `new ClipboardEvent("paste")` whose
      // `clipboardData` is null. There's nothing to attach from it (and the
      // image fallback below would otherwise fire a stray async clipboard read),
      // so let the editor's own text paste proceed. Real pastes always carry a
      // (non-null) DataTransfer, so this never short-circuits a genuine paste.
      if (!event.clipboardData) return false
      const files = filesFromClipboard(event.clipboardData)
      if (files.length > 0) {
        void appendFilesFromInput(files).catch((error) => {
          console.error(`[${logLabel}] paste files failed:`, error)
        })
        return true
      }

      // Linux/Tauri (WebKitGTK) fallback: screenshot tools (e.g. WeChat) write
      // the image to the clipboard in a form the synchronous DataTransfer API
      // can't read, so retry through the async Clipboard API. Only for a pure-
      // image clipboard — when text is present we let the default paste run
      // (mirroring `filesFromClipboard`) so copying a spreadsheet cell or rich
      // web content isn't hijacked into an image attachment. Kept synchronous
      // so `imageFilesFromClipboardApi` runs inside the paste user gesture.
      if (clipboardHasText(event.clipboardData)) return false
      void imageFilesFromClipboardApi()
        .then((imageFiles) => {
          if (imageFiles.length === 0) return
          return appendFilesFromInput(imageFiles)
        })
        .catch((error) => {
          console.error(`[${logLabel}] clipboard image paste failed:`, error)
        })
      // The default paste of a textless clipboard is a no-op, so don't claim it.
      return false
    },
    [appendFilesFromInput, disabled, logLabel]
  )

  // Insert an inline file reference for a file-tree entry dropped onto the
  // composer, placing the caret at the drop point first so the badge lands where
  // the user released (native-textarea feel). Shared by the editor-level drop
  // (`onDropFiles`) and the container-chrome drop (`handleContainerDrop`).
  const insertTreeDropAtPoint = useCallback(
    (absPath: string, clientX: number, clientY: number) => {
      editorRef.current?.focusAtCoords(clientX, clientY)
      appendResourceAttachments([absPath], { atCaret: true })
    },
    [appendResourceAttachments, editorRef]
  )

  // Routed from RichComposer's `onDropFiles` (ProseMirror's `handleDrop`).
  // Consumes a file-tree drag so PM does not insert the drag's `text/plain`
  // absolute-path fallback as literal text, and stops propagation so the
  // container's own drop handler doesn't double-insert. Returns false for every
  // other drop (OS files, editor text moves) so existing behavior is untouched.
  const handleEditorDrop = useCallback(
    (event: DragEvent): boolean => {
      if (disabled) return false
      if (!hasFileTreeDragType(event.dataTransfer)) return false
      const payload = readFileTreeDragPayload(event.dataTransfer)
      if (!payload) return false
      event.preventDefault()
      event.stopPropagation()
      // `stopPropagation` keeps the container's `onDrop` from double-inserting,
      // but that handler is also what clears the drag overlay — and a completed
      // drop doesn't reliably emit `dragleave`. Clear it here so the overlay
      // can't get stuck covering the composer.
      setDragActiveIfChanged(false)
      insertTreeDropAtPoint(payload.absPath, event.clientX, event.clientY)
      return true
    },
    [disabled, insertTreeDropAtPoint, setDragActiveIfChanged]
  )

  const handleContainerDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const isTreeDrag = hasFileTreeDragType(event.dataTransfer)
      if (!hasDragFiles(event.dataTransfer) && !isTreeDrag) return
      event.preventDefault()
      if (!disabled) {
        // A file-tree entry is copied in as a reference, not moved.
        if (isTreeDrag) event.dataTransfer.dropEffect = "copy"
        setDragActiveIfChanged(true)
      }
    },
    [disabled, setDragActiveIfChanged]
  )

  const handleContainerDragLeave = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const related = event.relatedTarget
      if (
        related &&
        related instanceof Node &&
        event.currentTarget.contains(related)
      ) {
        return
      }
      setDragActiveIfChanged(false)
    },
    [setDragActiveIfChanged]
  )

  const handleContainerDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const treePayload = hasFileTreeDragType(event.dataTransfer)
        ? readFileTreeDragPayload(event.dataTransfer)
        : null
      if (!hasDragFiles(event.dataTransfer) && !treePayload) return
      event.preventDefault()
      lastDomDropAtRef.current = Date.now()
      setDragActiveIfChanged(false)
      if (disabled) return
      // A file-tree entry dropped on the composer chrome (the editor's own drop
      // surface is handled first by `handleEditorDrop`) becomes an inline file
      // reference at the drop point.
      if (treePayload) {
        insertTreeDropAtPoint(treePayload.absPath, event.clientX, event.clientY)
        return
      }
      const files = Array.from(event.dataTransfer.files ?? [])
      if (files.length > 0) {
        void appendFilesFromInput(files).catch((error) => {
          console.error(`[${logLabel}] drop files failed:`, error)
        })
      }
    },
    [
      appendFilesFromInput,
      disabled,
      insertTreeDropAtPoint,
      logLabel,
      setDragActiveIfChanged,
    ]
  )

  // OS-level drag-drop. Tauri delivers these as window events (not DOM events on
  // the element), so every mounted composer hears every drop — `pointWithinElement`
  // is what decides whose it was.
  useEffect(() => {
    if (!containerRef) return
    let cancelled = false
    const unlisteners: Array<() => void | Promise<void>> = []

    const cleanupListeners = () => {
      for (const fn of unlisteners.splice(0)) {
        disposeTauriListener(fn, "Composer.dragDrop")
      }
    }

    type DragDropPayload =
      | {
          type: "enter" | "drop"
          paths: string[]
          position: { x: number; y: number }
        }
      | {
          type: "over"
          position: { x: number; y: number }
        }
      | { type: "leave" }

    const handlePayload = (payload: DragDropPayload) => {
      const host = containerRef.current
      if (!host) return
      if (payload.type === "leave") {
        setDragActiveIfChanged(false)
        return
      }
      const inside = pointWithinElement(payload.position, host)
      if (payload.type === "drop") {
        setDragActiveIfChanged(false)
        if (Date.now() - lastDomDropAtRef.current < 250) return
        if (!inside || disabledRef.current) return
        if (getActiveRemoteConnectionId() !== null) {
          // Remote workspace: local OS paths are unreachable from the
          // remote agent, so stream the bytes through the upload proxy and
          // attach the resulting server-side paths instead.
          void uploadPathsToRemoteRef.current(payload.paths).catch((error) => {
            console.error(
              `[${logLabel}] remote drag-drop upload failed:`,
              error
            )
          })
          return
        }
        void appendPathsFromDropRef.current(payload.paths).catch((error) => {
          console.error(`[${logLabel}] drag drop paths failed:`, error)
        })
        return
      }
      setDragActiveIfChanged(inside && !disabledRef.current)
    }

    const setup = async () => {
      if (!isDesktop()) return
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      const { TauriEvent } = await import("@tauri-apps/api/event")
      const webview = getCurrentWebview()
      try {
        const unlistenEnter = await webview.listen<{
          paths: string[]
          position: { x: number; y: number }
        }>(TauriEvent.DRAG_ENTER, (event) => {
          if (cancelled) return
          handlePayload({
            type: "enter",
            paths: event.payload.paths,
            position: event.payload.position,
          })
        })
        unlisteners.push(unlistenEnter)

        const unlistenOver = await webview.listen<{
          position: { x: number; y: number }
        }>(TauriEvent.DRAG_OVER, (event) => {
          if (cancelled) return
          handlePayload({
            type: "over",
            position: event.payload.position,
          })
        })
        unlisteners.push(unlistenOver)

        const unlistenDrop = await webview.listen<{
          paths: string[]
          position: { x: number; y: number }
        }>(TauriEvent.DRAG_DROP, (event) => {
          if (cancelled) return
          handlePayload({
            type: "drop",
            paths: event.payload.paths,
            position: event.payload.position,
          })
        })
        unlisteners.push(unlistenDrop)

        const unlistenLeave = await webview.listen(
          TauriEvent.DRAG_LEAVE,
          () => {
            if (cancelled) return
            handlePayload({ type: "leave" })
          }
        )
        unlisteners.push(unlistenLeave)
      } catch {
        // Ignore non-Tauri environments.
      } finally {
        if (cancelled) {
          cleanupListeners()
        }
      }
    }

    void setup()

    return () => {
      cancelled = true
      cleanupListeners()
    }
  }, [containerRef, logLabel, setDragActiveIfChanged])

  const handlePickFiles = useCallback(async () => {
    if (disabled) return
    // Only wired up when `showNativePaperclip` is true (i.e. local desktop),
    // so we can hand raw OS paths to the local agent without a round-trip.
    try {
      const selected = await openFileDialog({
        multiple: true,
        directory: false,
        defaultPath: defaultPath ?? undefined,
      })
      if (!selected) return
      const picked = Array.isArray(selected) ? selected : [selected]
      appendResourceAttachments(picked.filter((item): item is string => !!item))
    } catch (error) {
      console.error(`[${logLabel}] pick files failed:`, error)
    }
  }, [appendResourceAttachments, defaultPath, disabled, logLabel])

  const handleUploadLocalFiles = useCallback(async () => {
    if (disabled) return
    // Open a hidden <input type="file"> to grab File objects (browsers and
    // Tauri webviews both produce blob-style File objects from this control,
    // never raw OS paths), then upload each one — `uploadAttachment` picks
    // the right transport (direct fetch in web mode, IPC-proxied multipart
    // in remote-desktop mode).
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.onchange = async () => {
      const all = input.files ? Array.from(input.files) : []
      // Route through the shared classifier so images become thumbnail
      // attachments (uploaded, then re-inlined server-side) instead of
      // degrading to plain ResourceLinks; non-images keep the existing
      // upload → ResourceLink path via `appendFilesAsResources`.
      await appendFilesFromInput(all)
    }
    input.click()
  }, [disabled, appendFilesFromInput])

  const handleServerFilesSelected = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return
      appendResourceAttachments(paths)
    },
    [appendResourceAttachments]
  )

  // Replay a sent/stored `PromptInputBlock[]` into the editor: prose + file
  // badges inline, images into `attachments`, and any embedded/data-uri
  // resources re-inlined as sentinel badges with their bytes-bearing blocks
  // re-registered in the payload map (their original sentinel uri was never
  // serialized, so each gets a fresh one).
  const hydrateFromBlocks = useCallback(
    (editor: Editor, blocks: PromptInputBlock[], known?: KnownInvocations) => {
      embeddedPayloadsRef.current.clear()
      const restored = restoreBlocksIntoEditor(editor, blocks, known)
      setAttachments(
        restored.filter((a): a is ImageInputAttachment => a.type === "image")
      )
      const resources = restored.filter(
        (a): a is ResourceInputAttachment => a.type === "resource"
      )
      if (resources.length === 0) return
      let chain = editor.chain().focus("end")
      for (const att of resources) {
        // A page the built-in browser handed over comes back as the badge it
        // was queued as: the composer's name for it, carrying the page's
        // address (see message-input's `handleAttachPage`) — not the last
        // segment of that address, which is all its uri would say.
        const handoff =
          att.kind === "embedded" && att.text
            ? readPageHandoffBlock(att.text)
            : null
        const refUri = buildEmbeddedReferenceUri(handoff ? att.uri : undefined)
        const block: PromptInputBlock =
          att.kind === "embedded"
            ? {
                type: "resource",
                uri: att.uri,
                mime_type: att.mimeType,
                text: att.text ?? null,
                blob: att.blob ?? null,
              }
            : {
                type: "resource_link",
                uri: att.uri,
                name: att.name,
                mime_type: att.mimeType,
                description: null,
              }
        embeddedPayloadsRef.current.set(refUri, block)
        chain = chain
          .insertReference({
            refType: "file",
            id: refUri,
            label: handoff ? pageHandoffNameRef.current(handoff) : att.name,
            uri: refUri,
            meta: { fileKind: "file" },
          })
          .insertContent(" ")
      }
      chain.run()
    },
    []
  )

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const clearAttachments = useCallback(() => {
    setAttachments([])
    embeddedPayloadsRef.current.clear()
  }, [])

  const imageAttachments = useMemo(
    () =>
      attachments.filter(
        (attachment): attachment is ImageInputAttachment =>
          attachment.type === "image"
      ),
    [attachments]
  )

  const hasUploadingImage = useMemo(
    () => attachments.some((a) => a.type === "image" && a.uploading),
    [attachments]
  )

  // `attachments` holds only images — files live inline as editor badges. The
  // wire encoding is capability-driven (native `image` block vs embedded
  // `resource` blob) so an agent that advertises `image: false` but
  // `embedded_context: true` still receives the bytes it accepts.
  const imagePromptBlocks = useCallback(
    (): PromptInputBlock[] =>
      imageAttachments.map((attachment) =>
        imageAttachmentToPromptBlock(attachment, promptCapabilities)
      ),
    [imageAttachments, promptCapabilities]
  )

  return {
    attachments,
    setAttachments,
    imageAttachments,
    hasUploadingImage,
    isDragActive,
    showNativePaperclip,
    canAttachImages,
    embeddedPayloadsRef,
    insertFileReferences,
    appendResourceAttachments,
    appendFileRangeAttachment,
    appendFilesFromInput,
    handlePasteFiles,
    handleEditorDrop,
    containerDragProps: {
      onDragOver: handleContainerDragOver,
      onDragLeave: handleContainerDragLeave,
      onDrop: handleContainerDrop,
    },
    handlePickFiles,
    handleUploadLocalFiles,
    handleServerFilesSelected,
    serverFilePickerOpen,
    setServerFilePickerOpen,
    hydrateFromBlocks,
    removeAttachment,
    clearAttachments,
    imagePromptBlocks,
  }
}
