"use client"

import { createElement, Fragment, useMemo, type ReactNode } from "react"

import { cn } from "@/lib/utils"
import { HarnessLink } from "./harness-link"

/**
 * An item's description, shown without ever being inserted as HTML.
 *
 * The catalog serves descriptions as an HTML fragment it has already made
 * safe for its own pages. That is not enough here: this webview has no
 * content-security policy, and a page in it can call the commands that write
 * the user's agent configuration — so markup that slipped past the catalog's
 * filter, or a filter that changed, must not be able to do anything.
 *
 * The fragment is therefore only ever PARSED, into a detached document that
 * runs nothing and loads nothing, and that document is walked into React
 * elements through the short allowlist below:
 *
 * - an element on the list is rebuilt from scratch, with none of its
 *   attributes — no `style`, no `on…` handler, no `id`, no `class`;
 * - a link keeps its address and nothing else, and only when the address is
 *   `https:` ({@link HarnessLink}, which opens it in the system browser);
 * - an element that is not on the list is left out and its text kept, so a
 *   `<span>` or a `<div>` costs nothing; one whose content is not text to
 *   begin with (a script, a style sheet, a frame, a form, an image) is left
 *   out whole.
 *
 * What React is handed is strings and elements it created itself; there is no
 * path from the fragment's bytes to the page's markup.
 */

/** Left out together with everything inside them. */
const DROPPED = new Set([
  "applet",
  "area",
  "audio",
  "base",
  "button",
  "canvas",
  "datalist",
  "dialog",
  "embed",
  "fieldset",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "img",
  "input",
  "link",
  "map",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "optgroup",
  "option",
  "picture",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
])

/** Rebuilt as the same element, bare. */
const PLAIN = new Set([
  "blockquote",
  "br",
  "em",
  "hr",
  "li",
  "ol",
  "p",
  "s",
  "strong",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
])

/** Older spellings of the same thing. A `Map`, as is every lookup keyed by
 *  an element's name: on a plain object, `<constructor>` would find one. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["b", "strong"],
  ["i", "em"],
  ["del", "s"],
  ["strike", "s"],
])

/** Elements that take only elements: the line breaks between their children
 *  are not text, and React says so when it is handed them. */
const STRUCTURAL = new Set(["ol", "ul", "table", "thead", "tbody", "tr"])

/** How deep the walk goes before the rest is taken as plain text. The parser
 *  caps nesting itself; this is so the walk never depends on that. */
const MAX_DEPTH = 64

const CLASSES: ReadonlyMap<string, string> = new Map([
  ["p", "my-2 leading-relaxed"],
  ["ul", "my-2 list-disc space-y-1 ps-5"],
  ["ol", "my-2 list-decimal space-y-1 ps-5"],
  ["li", "leading-relaxed [&>ol]:my-1 [&>ul]:my-1"],
  ["blockquote", "my-3 border-s-2 border-border ps-3 text-muted-foreground"],
  ["hr", "my-4 border-border"],
  ["thead", "border-b border-border"],
  ["tr", "border-b border-border/60 last:border-b-0"],
  ["th", "px-2 py-1.5 text-start font-medium [overflow-wrap:anywhere]"],
  ["td", "px-2 py-1.5 align-top [overflow-wrap:anywhere]"],
  ["strong", "font-semibold"],
])

/** A description is one part of the item's page, under that page's own
 *  headings, so its headings start two levels down and stop at the last. */
const HEADING_TAGS = ["h4", "h5", "h6", "h6", "h6", "h6"] as const
const HEADING_CLASSES = [
  "mt-5 mb-2 text-base font-semibold",
  "mt-5 mb-2 text-sm font-semibold",
  "mt-4 mb-1.5 text-sm font-medium",
  "mt-4 mb-1.5 text-sm font-medium text-muted-foreground",
  "mt-4 mb-1.5 text-xs font-medium text-muted-foreground",
  "mt-4 mb-1.5 text-xs font-medium text-muted-foreground",
] as const

interface Walk {
  depth: number
  /** Inside a `<pre>`: its code is a block, not a chip in a sentence. */
  inPre: boolean
}

function childrenOf(node: Node, walk: Walk, parentTag: string): ReactNode[] {
  const out: ReactNode[] = []
  const structural = STRUCTURAL.has(parentTag)
  node.childNodes.forEach((child, index) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? ""
      if (text && !(structural && !text.trim())) out.push(text)
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const rendered = elementOf(child as Element, walk, index)
    if (rendered !== null) out.push(rendered)
  })
  return out
}

function elementOf(element: Element, walk: Walk, key: number): ReactNode {
  const source = element.localName.toLowerCase()
  if (DROPPED.has(source)) return null
  if (walk.depth >= MAX_DEPTH) return element.textContent ?? ""
  const tag = ALIASES.get(source) ?? source
  const inner: Walk = { depth: walk.depth + 1, inPre: walk.inPre }

  if (tag === "a") {
    const children = childrenOf(element, inner, tag)
    // `getAttribute`, not `.href`: the property resolves a relative address
    // against whatever document the parser was given.
    return (
      <HarnessLink key={key} href={element.getAttribute("href")}>
        {children}
      </HarnessLink>
    )
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]) - 1
    return createElement(
      HEADING_TAGS[level],
      { key, className: HEADING_CLASSES[level] },
      ...childrenOf(element, inner, tag)
    )
  }
  if (tag === "pre") {
    return (
      <pre
        key={key}
        // Code is left-to-right whatever the interface language is.
        dir="ltr"
        // Long lines wrap: nothing in the detail scrolls sideways, and on a
        // phone a line of code is longer than the screen more often than not.
        className="my-3 rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap"
      >
        {childrenOf(element, { ...inner, inPre: true }, tag)}
      </pre>
    )
  }
  if (tag === "code") {
    return (
      <code
        key={key}
        className={cn(
          "font-mono",
          !walk.inPre &&
            "rounded bg-muted px-1 py-0.5 text-[0.85em] break-words"
        )}
      >
        {childrenOf(element, inner, tag)}
      </code>
    )
  }
  if (tag === "table") {
    return (
      // A table wider than the pane scrolls inside its own box; the page
      // never does.
      <div key={key} className="my-3 overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          {childrenOf(element, inner, tag)}
        </table>
      </div>
    )
  }
  if (PLAIN.has(tag)) {
    if (tag === "br" || tag === "hr") {
      return createElement(tag, { key, className: CLASSES.get(tag) })
    }
    return createElement(
      tag,
      { key, className: CLASSES.get(tag) },
      ...childrenOf(element, inner, tag)
    )
  }
  // Not on the list: the element goes, what it says stays.
  const children = childrenOf(element, inner, tag)
  return children.length > 0 ? <Fragment key={key}>{children}</Fragment> : null
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * The fragment as React nodes. `omitHeading` names text (the item's title,
 * its name) that the page already shows as its own heading: a description
 * that opens by repeating it has that opening left out.
 */
export function readmeNodes(
  fragment: string,
  omitHeading: readonly string[] = []
): ReactNode[] {
  if (typeof DOMParser === "undefined") return []
  // A document built by the parser has no browsing context: its scripts are
  // never run and its images, frames and style sheets are never fetched.
  const body = new DOMParser().parseFromString(fragment, "text/html").body
  const first = body.firstElementChild
  if (
    first?.localName === "h1" &&
    omitHeading.some((text) => sameText(text, first.textContent ?? ""))
  ) {
    first.remove()
  }
  // Loose text between blocks is the line breaks of the fragment's source.
  return childrenOf(body, { depth: 0, inPre: false }, "body").filter(
    (node) => typeof node !== "string" || node.trim() !== ""
  )
}

interface ReadmeContentProps {
  /** The description's HTML fragment, as text. */
  fragment: string
  /** See {@link readmeNodes}. */
  omitHeading?: readonly string[]
  className?: string
}

export function ReadmeContent({
  fragment,
  omitHeading,
  className,
}: ReadmeContentProps) {
  const nodes = useMemo(
    () => readmeNodes(fragment, omitHeading),
    [fragment, omitHeading]
  )
  return (
    <div
      // A description is in whatever language its author wrote, which need
      // not be the interface's: its direction follows its own text.
      dir="auto"
      className={cn(
        "min-w-0 text-sm break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
    >
      {nodes}
    </div>
  )
}
