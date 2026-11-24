"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react"
import { defaultComponents, type Components } from "streamdown"
import { ImageOff, Loader2 } from "lucide-react"
import {
  MessageResponse,
  type MessageResponseProps,
} from "@/components/ai-elements/message"
import { MarkdownImageSpan } from "@/components/ai-elements/markdown-local-image"
import { forgeReadImage } from "@/lib/api"
import type { ForgeImage, ForgeRemote } from "@/lib/types"
import { remarkGitlabImages } from "./remark-gitlab-images"

type ImageScope = {
  projectUrl: string
  load: (path: string) => Promise<ForgeImage | null>
}
const ForgeImageContext = createContext<ImageScope | null>(null)

function imageSize(
  width?: number | string,
  height?: number | string
): CSSProperties {
  const w = Number(width) || undefined
  const h = Number(height) || undefined
  return {
    width: w,
    height: w ? "auto" : h || "auto",
    maxWidth: "100%",
    aspectRatio: w && h ? `${w} / ${h}` : undefined,
    objectFit: "contain",
  }
}

// Retain Streamdown's remote-image controls while applying GitLab dimensions.
const DefaultImage = defaultComponents.img
function ForgeRemoteImage(props: ComponentProps<typeof DefaultImage>) {
  return (
    <DefaultImage
      {...props}
      style={{ ...props.style, ...imageSize(props.width, props.height) }}
    />
  )
}

export function ForgeMarkdownProvider({
  folderId,
  remote,
  children,
}: {
  folderId: number | null
  remote: ForgeRemote | null
  children: ReactNode
}) {
  const projectUrl =
    remote?.provider === "gitlab"
      ? `${(remote.web_origin ?? `https://${remote.server_host}`).replace(/\/+$/, "")}/${remote.owner_repo}`
      : null
  const scope = useMemo<ImageScope | null>(() => {
    if (folderId == null || projectUrl == null) return null
    const pending = new Map<string, Promise<ForgeImage | null>>()
    return {
      projectUrl,
      load(path) {
        const held = pending.get(path)
        if (held) return held
        const read = forgeReadImage(folderId, path)
          .catch(() => null)
          .finally(() => pending.delete(path))
        pending.set(path, read)
        return read
      },
    }
  }, [folderId, projectUrl])
  return (
    <ForgeImageContext.Provider value={scope}>
      {children}
    </ForgeImageContext.Provider>
  )
}

function ForgeUploadImage({
  path,
  alt,
  width,
  height,
}: {
  path: string
  alt: string
  width?: number
  height?: number
}) {
  const scope = useContext(ForgeImageContext)
  const [result, setResult] = useState<{
    scope: ImageScope
    path: string
    image: ForgeImage | null
  } | null>(null)
  useEffect(() => {
    if (!scope) return
    let live = true
    void scope.load(path).then((image) => {
      if (live) setResult({ scope, path, image })
    })
    return () => {
      live = false
    }
  }, [scope, path])
  const current =
    result?.scope === scope && result?.path === path ? result : null
  const label = alt || path.split("/").pop() || path
  if (!scope || current?.image === null) {
    return (
      <span
        role="img"
        aria-label={label}
        className="inline-flex gap-1.5 text-muted-foreground"
      >
        <ImageOff aria-hidden className="size-4 shrink-0" />
        {label}
      </span>
    )
  }
  if (!current) {
    return (
      <span role="status" className="inline-flex gap-1.5 text-muted-foreground">
        <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
        {label}
      </span>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={current.image!.url}
      alt={label}
      width={width}
      height={height}
      className="h-auto max-w-full rounded-lg object-contain"
      style={imageSize(width, height)}
      onError={() => setResult({ scope, path, image: null })}
    />
  )
}

function ForgeImageSpan(
  props: ComponentProps<typeof MarkdownImageSpan> & {
    "data-codeg-forge-image"?: string
    "data-codeg-image-width"?: string
    "data-codeg-image-height"?: string
  }
) {
  const path = props["data-codeg-forge-image"]
  if (!path) return <MarkdownImageSpan {...props} />
  return (
    <ForgeUploadImage
      path={path}
      alt={typeof props.children === "string" ? props.children : ""}
      width={Number(props["data-codeg-image-width"]) || undefined}
      height={Number(props["data-codeg-image-height"]) || undefined}
    />
  )
}

const forgeImageComponents: Components = {
  span: ForgeImageSpan as Components["span"],
  img: ForgeRemoteImage as Components["img"],
}

/** Repository Markdown retains the chat renderer's tables, links and code,
 * with GitLab upload resolution and its image-size extension in this scope. */
export function ForgeMarkdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  const scope = useContext(ForgeImageContext)
  const projectUrl = scope?.projectUrl
  const remarkPlugins = useMemo<
    MessageResponseProps["additionalRemarkPlugins"]
  >(
    () => (projectUrl ? [[remarkGitlabImages, { projectUrl }]] : undefined),
    [projectUrl]
  )
  return (
    <MessageResponse
      // Streamdown's memo omits parser/component props. A newly resolved
      // repository must reparse unchanged text with its image rules.
      key={projectUrl ?? "plain"}
      className={className}
      additionalRemarkPlugins={remarkPlugins}
      components={scope ? forgeImageComponents : undefined}
    >
      {children}
    </MessageResponse>
  )
}
