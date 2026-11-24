"use client"

import { type ReactNode, useCallback } from "react"
import { Copy, Download } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  canCopyImageToClipboard,
  ClipboardImageUnsupportedError,
  copyImageToClipboard,
} from "@/lib/copy-image"
import { downloadImage } from "@/lib/image-download"
import { toErrorMessage } from "@/lib/app-error"
import type { UserImageDisplay } from "@/lib/adapters/ai-elements-adapter"

/**
 * The copy/download pair behind every transcript image, shared by the
 * right-click menu here, the hover button on the thumbnail and the preview
 * dialog — one image can be reached three ways and all three should report
 * success and failure identically.
 *
 * Both handlers take the image rather than closing over one, so a list of
 * thumbnails can call the hook once and use it for every row.
 */
export function useImageActions(): {
  canCopy: boolean
  copy: (image: UserImageDisplay) => Promise<void>
  download: (image: UserImageDisplay) => Promise<void>
} {
  const t = useTranslations("Folder.chat.messageList")

  const copy = useCallback(
    async (image: UserImageDisplay) => {
      try {
        await copyImageToClipboard({
          data: image.data,
          mime_type: image.mime_type,
        })
        toast.success(t("copiedImage"))
      } catch (err) {
        // Our own "can't be done here" carries an English developer string;
        // anything else is a browser error worth showing verbatim.
        toast.error(
          err instanceof ClipboardImageUnsupportedError
            ? t("copyImageUnsupported")
            : t("copyImageFailed", { message: toErrorMessage(err) })
        )
      }
    },
    [t]
  )

  const download = useCallback(
    async (image: UserImageDisplay) => {
      try {
        await downloadImage({
          data: image.data,
          mime_type: image.mime_type,
          suggestedName: image.name,
        })
      } catch (err) {
        toast.error(t("downloadFailed", { message: toErrorMessage(err) }))
      }
    },
    [t]
  )

  return { canCopy: canCopyImageToClipboard(), copy, download }
}

/**
 * Right-click menu on a transcript image: Copy image / Download image.
 *
 * The conversation panel wraps the whole transcript in its own context
 * menu, so this trigger stops the event from bubbling — same contract as
 * `FileReferenceActions`. Right-clicking the image is about the image;
 * right-clicking anywhere else still gets the conversation menu.
 *
 * `className` lands on the trigger itself rather than on a wrapper around it,
 * so callers keep the box they had before: the styled element stays the flex
 * item its parent laid out, with its own `shrink-0` and display.
 */
export function ImageActions({
  image,
  className,
  children,
  as: Tag = "div",
}: {
  image: UserImageDisplay
  className?: string
  children: ReactNode
  as?: "div" | "span"
}) {
  const t = useTranslations("Folder.chat.messageList")
  const { canCopy, copy, download } = useImageActions()

  // Radix's own handler still runs on this element; only the ancestor
  // conversation-panel trigger is cut off.
  const stopContextMenu = (event: { stopPropagation: () => void }) =>
    event.stopPropagation()
  // Touch and pen open a context menu from a long press, which the ancestor
  // arms on pointerdown — stop that press from reaching it. Mouse presses keep
  // bubbling, so the panel's selection bookkeeping is untouched.
  const stopNonMousePointerDown = (event: {
    pointerType: string
    stopPropagation: () => void
  }) => {
    if (event.pointerType !== "mouse") event.stopPropagation()
  }

  // Non-secure web context (the server build over plain HTTP on a LAN): no
  // clipboard write exists, so a Copy row could only ever fail. Drop our menu
  // and let the browser's own image menu through instead — it copies and saves
  // images natively, with no secure-context requirement. Blocking the ancestor
  // without calling preventDefault is what lets it appear.
  if (!canCopy) {
    return (
      <Tag
        data-image-actions=""
        data-image-actions-native=""
        className={className}
        onContextMenu={stopContextMenu}
        onPointerDown={stopNonMousePointerDown}
      >
        {children}
      </Tag>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tag
          data-image-actions=""
          className={className}
          onContextMenu={stopContextMenu}
          onPointerDown={stopNonMousePointerDown}
        >
          {children}
        </Tag>
      </ContextMenuTrigger>
      {/* The menu is portaled, but its click still bubbles through the React
          tree to whatever the trigger sits inside — in the preview dialog that
          is a backdrop that closes on click, which would shut the preview the
          moment an action was picked. */}
      <ContextMenuContent onClick={(event) => event.stopPropagation()}>
        <ContextMenuItem onSelect={() => void copy(image)}>
          <Copy className="size-4" />
          {t("copyImage")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void download(image)}>
          <Download className="size-4" />
          {t("downloadImage")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
