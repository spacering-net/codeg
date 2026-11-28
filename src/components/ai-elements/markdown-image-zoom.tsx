"use client"

import {
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { defaultComponents, type Components } from "streamdown"
import { ImagePreviewDialog } from "@/components/ui/image-preview-dialog"
import { cn } from "@/lib/utils"

type ImageZoom = {
  /** False for an image still loading (no `src`) or inside a link, whose
   *  click is the link's. */
  enabled: boolean
  open: () => void
  /** The full-size preview, rendered beside the image. */
  preview: ReactNode
}

/** A rendered Markdown image that opens at full size when clicked. */
export function useImageZoom({
  src,
  alt,
  linked,
}: {
  src: string | undefined
  alt: string
  linked: boolean
}): ImageZoom {
  // Keyed by the source, so a preview opened for one picture never shows
  // the next one the same element is given.
  const [openSrc, setOpenSrc] = useState<string | null>(null)
  if (!src || linked) return { enabled: false, open: () => {}, preview: null }
  return {
    enabled: true,
    open: () => setOpenSrc(src),
    preview: (
      <ImagePreviewDialog
        src={src}
        alt={alt}
        open={openSrc === src}
        onOpenChange={(next) => setOpenSrc(next ? src : null)}
      />
    ),
  }
}

/** The image as the button that opens its preview, as a local chat image
 *  is; the image alone when it cannot open one. */
export function ZoomButton({
  zoom,
  label,
  children,
}: {
  zoom: ImageZoom
  label: string
  children: ReactNode
}) {
  if (!zoom.enabled) return children
  return (
    <>
      <button
        type="button"
        className="inline-block max-w-full cursor-zoom-in"
        aria-label={label || undefined}
        onClick={zoom.open}
      >
        {children}
      </button>
      {zoom.preview}
    </>
  )
}

export type MarkdownImageProps = ComponentProps<
  typeof defaultComponents.img
> & {
  "data-codeg-image-linked"?: string
}

/**
 * A remote Markdown image — Streamdown's own, with its loading fallback and
 * download button — that opens at full size when clicked. That button sits
 * beside the image in Streamdown's wrapper, so the wrapper cannot itself be
 * a button: the image takes the click, and Enter or Space once focused.
 */
export function ZoomableMarkdownImage(props: MarkdownImageProps) {
  // Read when drawn, not when this module loads: a test standing Streamdown
  // in with a few components of its own still imports the chat renderer.
  const DefaultImage = defaultComponents.img
  const zoom = useImageZoom({
    src: typeof props.src === "string" ? props.src : undefined,
    alt: props.alt ?? "",
    linked: props["data-codeg-image-linked"] === "true",
  })
  if (!zoom.enabled) return <DefaultImage {...props} />
  return (
    <>
      <DefaultImage
        {...props}
        className={cn(props.className, "cursor-zoom-in")}
        tabIndex={0}
        onClick={zoom.open}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return
          e.preventDefault()
          zoom.open()
        }}
      />
      {zoom.preview}
    </>
  )
}

export const markdownImageComponents: Components = {
  img: ZoomableMarkdownImage as Components["img"],
}
