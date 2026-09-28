"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import type { Components } from "streamdown"
import { ImageOff, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { readWorkspaceFileBase64 } from "@/lib/api"
import {
  createLocalImageLoader,
  resolveLocalImage,
} from "@/lib/markdown-local-image"
import {
  ImageActions,
  useImageActions,
} from "@/components/message/image-actions"
import { ImagePreviewDialog } from "@/components/ui/image-preview-dialog"

type ImageScope = {
  root: string
  load: ReturnType<typeof createLocalImageLoader>
}
const LocalImageContext = createContext<ImageScope | null>(null)

/** Scope belongs to this transcript, never the globally active folder. */
export function MarkdownImageProvider({
  rootPath,
  children,
}: {
  rootPath: string | null
  children: ReactNode
}) {
  const scope = useMemo(
    () =>
      rootPath
        ? {
            root: rootPath,
            load: createLocalImageLoader(rootPath, readWorkspaceFileBase64),
          }
        : null,
    [rootPath]
  )
  return (
    <LocalImageContext.Provider value={scope}>
      {children}
    </LocalImageContext.Provider>
  )
}

function LocalMarkdownImage({
  source,
  alt,
  linked,
}: {
  source: string
  alt: string
  linked: boolean
}) {
  const scope = useContext(LocalImageContext)
  const t = useTranslations("Folder.chat.messageList")
  const target = scope ? resolveLocalImage(source, scope.root) : null
  const path = target?.path
  const [result, setResult] = useState<{
    scope: ImageScope
    path: string
    data: string | null
  } | null>(null)
  const [preview, setPreview] = useState<{
    scope: ImageScope
    path: string
  } | null>(null)
  const { canCopy, copy, download } = useImageActions()
  useEffect(() => {
    if (!scope || !path) return
    let cancelled = false
    void scope.load(path).then((data) => {
      if (!cancelled) setResult({ scope, path, data })
    })
    return () => {
      cancelled = true
    }
  }, [scope, path])

  // A source or transcript change must never paint bytes from the previous
  // scope while its replacement is loading (including out-of-order reads).
  const current =
    result?.scope === scope && result?.path === path ? result : null
  const label = alt || target?.name || source
  if (!scope || !target || current?.data === null) {
    return (
      <span
        role="img"
        aria-label={label}
        className="inline-flex max-w-full items-center gap-1.5 text-muted-foreground"
      >
        <ImageOff aria-hidden="true" className="size-4 shrink-0" />
        <span className="wrap-anywhere">{label}</span>
      </span>
    )
  }
  if (!current) {
    return (
      <span
        role="status"
        className="inline-flex max-w-full items-center gap-1.5 text-muted-foreground"
      >
        <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        <span className="wrap-anywhere">{label}</span>
      </span>
    )
  }
  const image = {
    name: target.name,
    mime_type: target.mime,
    data: current.data!,
    uri: null,
  }
  const src = `data:${image.mime_type};base64,${image.data}`
  const picture = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={label}
      className="h-auto max-h-96 max-w-full object-contain"
      onError={() => setResult({ scope, path: target.path, data: null })}
    />
  )
  return (
    <>
      <ImageActions
        image={image}
        as="span"
        className="inline-block max-w-full align-middle"
      >
        {linked ? (
          picture
        ) : (
          <button
            type="button"
            className="inline-block max-w-full cursor-zoom-in"
            aria-label={label}
            onClick={() => setPreview({ scope, path: target.path })}
          >
            {picture}
          </button>
        )}
      </ImageActions>
      <ImagePreviewDialog
        src={src}
        alt={label}
        open={preview?.scope === scope && preview?.path === target.path}
        onOpenChange={(open) =>
          setPreview(open ? { scope, path: target.path } : null)
        }
        onDownload={() => void download(image)}
        onCopy={canCopy ? () => void copy(image) : undefined}
        copyLabel={t("copyImage")}
        downloadLabel={t("downloadImage")}
        renderImage={(preview) => (
          <ImageActions image={image}>{preview}</ImageActions>
        )}
      />
    </>
  )
}

function MarkdownImageSpan({
  // The parser node is not a DOM attribute.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  node: _node,
  children,
  ...props
}: ComponentProps<"span"> & {
  node?: unknown
  "data-codeg-local-image"?: string
  "data-codeg-image-linked"?: string
}) {
  // Non-empty, not merely present: `remarkLocalImages` only ever emits a
  // destination it already parsed, so a valueless attribute can only come from
  // author-written raw HTML — leave that span as the plain text it is instead
  // of decorating it with a broken-image icon.
  const source = props["data-codeg-local-image"]
  if (source) {
    return (
      <LocalMarkdownImage
        source={source}
        alt={typeof children === "string" ? children : ""}
        linked={props["data-codeg-image-linked"] === "true"}
      />
    )
  }
  return <span {...props}>{children}</span>
}

export const markdownLocalImageComponents: Components = {
  span: MarkdownImageSpan as Components["span"],
}
