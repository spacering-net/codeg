"use client"

import type { ComponentProps, MouseEvent, ReactNode } from "react"
import { useCallback, useState } from "react"
import { FileText, Globe, Mail, Phone, type LucideIcon } from "lucide-react"
import type { Components, LinkSafetyModalProps } from "streamdown"

import { ReferenceBadge } from "@/components/chat/composer/badges/reference-badge"
import { parseCodegReferenceUri } from "@/components/chat/composer/reference-uri"
import { FileReferenceActions } from "@/components/message/file-reference-actions"
import type { ReferenceAttrs } from "@/components/chat/composer/types"
import { classifyResourceKind, type ResourceKind } from "@/lib/resource-kind"
import { cn } from "@/lib/utils"
import {
  openExternalTab,
  openLinkWithSafety,
  parseLocalFileTarget,
  useStreamdownLinkSafety,
} from "./link-safety"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useOpenUrlTarget } from "@/hooks/use-open-url-target"
import { copyTextToClipboard } from "@/lib/utils"
import { useTranslations } from "next-intl"

const RESOURCE_KIND_ICON: Record<ResourceKind, LucideIcon> = {
  file: FileText,
  web: Globe,
  email: Mail,
  phone: Phone,
}

type MarkdownLinkProps = ComponentProps<"a"> & {
  // react-markdown passes the originating hast node; it must not reach the DOM.
  node?: unknown
}

/** Flatten a markdown link's children to plain text (used as the badge label). */
function nodeText(children: ReactNode): string {
  if (typeof children === "string") return children
  if (Array.isArray(children)) {
    return children
      .map((child) => (typeof child === "string" ? child : ""))
      .join("")
  }
  return ""
}

/**
 * Anchor override for markdown rendered by `<Streamdown>` (chat messages and
 * reasoning blocks). It mirrors Streamdown's built-in link element — a
 * `<button>` whose clicks are routed through the shared link-safety config
 * (file → workspace panel, http(s) → browser, mailto/tel → OS handler) plus
 * its modal hook — and additionally prepends a small type icon so users can
 * tell at a glance whether an address is a file, a web link, an email, or a
 * phone number.
 *
 * Overriding `components.a` is the right layer for this: the icon is a React
 * node, so it must be injected after rehype-sanitize (which would strip an
 * element/attribute added upstream in a remark/rehype plugin).
 */
export function MarkdownLink({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  node,
  href,
  children,
  className,
  ...rest
}: MarkdownLinkProps) {
  const linkSafety = useStreamdownLinkSafety()
  const openUrlTarget = useOpenUrlTarget()
  const tLink = useTranslations("Browser.link")
  const [modalOpen, setModalOpen] = useState(false)

  // Deliberately NOT async: `openLinkWithSafety` opens the tab inside this
  // handler's own call stack, because awaiting the (synchronous) safety verdict
  // costs the user gesture that WebKit's popup blocker requires — see #410.
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!href) return
      event.preventDefault()
      // The gesture's modifier rides along: ⌘/Ctrl-click opens a web link
      // "the other way" (system browser instead of the built-in one, or vice
      // versa) — see `resolveLinkAction`.
      openLinkWithSafety(href, linkSafety, () => setModalOpen(true), event)
    },
    [href, linkSafety]
  )

  // No usable href: render an inert anchor, matching Streamdown's fallback.
  if (!href) {
    return (
      <a
        className={cn(
          "wrap-anywhere font-medium text-primary underline",
          className
        )}
        {...rest}
      >
        {children}
      </a>
    )
  }

  // A codeg:// reference link renders as an inline badge, mirroring the
  // composer's reference chips: session / commit / agent links, plus the inert
  // `codeg://embedded/…` badge a path-less pasted attachment serializes to (its
  // bytes travel out of band, so it has no openable target). The same parser the
  // editor uses on draft restore recovers refType/id/meta from the uri; the link
  // text is the label.
  if (href.toLowerCase().startsWith("codeg:")) {
    const reference = parseCodegReferenceUri(href, nodeText(children))
    if (reference) return <ReferenceBadge data={reference} />
  }

  const kind = classifyResourceKind(href)
  const Icon = kind ? RESOURCE_KIND_ICON[kind] : null

  const modalProps: LinkSafetyModalProps = {
    url: href,
    isOpen: modalOpen,
    onClose: () => setModalOpen(false),
    onConfirm: () => openExternalTab(href),
  }

  // A file reference — a `file://` uri (rewritten to a local path by
  // remark-file-uri-links before it reaches us) or a bare local path — renders
  // as an inline file badge, visually matching the composer's `@`-file chips and
  // the inline session/commit/agent badges above, while staying clickable: the
  // same link-safety flow (`handleClick` → modal → `useOpenLinkOrFile`) opens it
  // in the workspace file panel.
  //
  // Vertical centering happens in two steps:
  //
  // 1. Equalize with the bare `<ReferenceBadge>` span used for the
  //    session/commit/agent badges above. A `<button>` inherits two metrics a
  //    span never gets from Tailwind's preflight — `appearance: button` (a UA
  //    inline strut) and `font: inherit`, which resets its `line-height` to the
  //    message body's inherited value (the `text-sm` wrapper, ~20px) instead of
  //    the badge's own tighter `leading-snug`. In WebKit (the macOS Tauri
  //    webview) that taller, UA-strutted inline box pulls the badge low.
  //    `appearance-none` + `leading-none` strip both so the button lays out like
  //    the bare badge.
  // 2. Lift onto the line's optical center. `align-middle` centers the chip on
  //    the parent's x-height, which sits ~1.5px below the optical center of a
  //    line that also carries ascenders, caps and full-height CJK glyphs — so
  //    the chip still reads slightly low (most visible next to Chinese text).
  //    A small upward `-translate-y` nudge (purely visual, no layout shift)
  //    seats it on that optical center.
  if (kind === "file") {
    // Hover text shows the path the opener will actually use, not the raw
    // sanitized href — a Windows path reaches us percent-encoded and
    // slash-prefixed (`/C:%5Crepo%5Ca.png`), which reads as a broken path.
    // `ReferenceBadge` renders `uri` as its own title and uses it for nothing
    // else, so both tooltips resolve from the same value. The `:line` suffix is
    // re-appended because the parser splits it off into its own field.
    const target = parseLocalFileTarget(href)
    const displayPath = target
      ? `${target.path}${target.line ? `:${target.line}` : ""}`
      : href
    const fileData: ReferenceAttrs = {
      refType: "file",
      id: href,
      label: nodeText(children) || href,
      uri: displayPath,
      meta: { fileKind: "file" },
    }
    return (
      <>
        {/* Right-clicking the badge opens its actions (reveal in file manager /
            copy paths); a left click still opens the file. */}
        <FileReferenceActions target={href}>
          <button
            type="button"
            data-resource-kind="file"
            title={displayPath}
            onClick={handleClick}
            className="inline-flex max-w-full -translate-y-[1.5px] cursor-pointer appearance-none items-center align-middle leading-none hover:opacity-80"
          >
            <ReferenceBadge data={fileData} />
          </button>
        </FileReferenceActions>
        {linkSafety.renderModal ? linkSafety.renderModal(modalProps) : null}
      </>
    )
  }

  const button = (
    <button
      type="button"
      data-streamdown="link"
      data-resource-kind={kind ?? undefined}
      title={href}
      onClick={handleClick}
      className={cn(
        "wrap-anywhere appearance-none text-left font-medium text-primary underline",
        className
      )}
    >
      {Icon ? (
        <Icon
          aria-hidden="true"
          className="mr-0.5 inline size-[1em] align-[-0.15em] opacity-80"
        />
      ) : null}
      {children}
    </button>
  )

  // A web link gets an explicit-choice menu: built-in browser, system
  // browser, copy. Explicit choices bypass the per-source preference (but not
  // the terminal rules — a blocked host stays blocked).
  return (
    <>
      {kind === "web" ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={() =>
                openUrlTarget(href, {
                  source: "transcript",
                  forceTarget: "builtin",
                })
              }
            >
              {tLink("openBuiltin")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                openUrlTarget(href, {
                  source: "transcript",
                  forceTarget: "system",
                })
              }
            >
              {tLink("openSystem")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void copyTextToClipboard(href)}>
              {tLink("copy")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        button
      )}
      {linkSafety.renderModal ? linkSafety.renderModal(modalProps) : null}
    </>
  )
}

// react-markdown's `Components` map carries a string index signature that forces
// every element override to accept `Record<string, unknown>` props, which is
// incompatible with MarkdownLink's precise anchor props. The cast bridges that
// gap — MarkdownLink receives exactly the props react-markdown passes for `a`.
export const markdownLinkComponents: Components = {
  a: MarkdownLink as Components["a"],
}
