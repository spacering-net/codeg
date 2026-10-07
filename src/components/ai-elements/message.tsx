"use client"

import type { UIMessage } from "ai"
import type { ComponentProps, HTMLAttributes, ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown"
import { markdownLinkComponents } from "./markdown-link"
import { maskLiteralSpans } from "./markdown-mask"
import { mermaidComponents } from "./mermaid-block"
import { rehypePluginsAllowingCodeg } from "./rehype-allow-codeg"
import { remarkTrimCjkAutolinkTail } from "./remark-cjk-autolink-tail"
import { withRelativeFileLinks } from "./rehype-relative-file-links"
import { remarkRewriteFileUriLinks } from "./remark-file-uri-links"
import { remarkRestoreWindowsPaths } from "./remark-windows-paths"
import { remarkLocalImages } from "./remark-local-images"
import { markdownLocalImageComponents } from "./markdown-local-image"
import { MATH_FENCE_PAD, useStreamdownPlugins } from "./streamdown-plugins"

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"]
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex flex-col gap-2",
      from === "user"
        ? // Outer user capsule hugs its content (`w-fit`) instead of always
          // reserving the full `max-w-[88%]` box — the inner bubble
          // (`MessageContent`) is already `w-fit`, so this just drops the
          // phantom full-width wrapper. Assistant keeps `w-full`.
          "is-user ml-auto justify-end w-fit max-w-[88%]"
        : "is-assistant w-full",
      className
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex min-w-0 flex-col gap-2 overflow-hidden text-sm",
      // `ws-msg-secondary` pairs with the user bubble's `bg-secondary`: with
      // a workspace background image on it turns the bubble translucent + frosted
      // with a hairline ring (fixed `--ws-msg-alpha` + backdrop blur — see
      // globals.css, scoped to `.is-user`) so it stays legible over a busy
      // background. Off / assistant messages: inert (no base rule, no `.is-user`
      // ancestor).
      "group-[.is-user]:ml-auto group-[.is-user]:w-fit group-[.is-user]:max-w-full group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground ws-msg-secondary",
      "group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionsProps = ComponentProps<"div">

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
)

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string
  label?: string
}

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  )

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return button
}

interface MessageBranchContextType {
  currentBranch: number
  totalBranches: number
  goToPrevious: () => void
  goToNext: () => void
  branches: ReactElement[]
  setBranches: (branches: ReactElement[]) => void
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
)

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext)

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    )
  }

  return context
}

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number
  onBranchChange?: (branchIndex: number) => void
}

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch)
  const [branches, setBranches] = useState<ReactElement[]>([])

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch)
      onBranchChange?.(newBranch)
    },
    [onBranchChange]
  )

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  )

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  )
}

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch()
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  )

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray)
    }
  }, [childrenArray, branches, setBranches])

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ))
}

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch()

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  )
}

export type MessageBranchPreviousProps = ComponentProps<typeof Button>

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const t = useTranslations("Folder.chat.messageBranch")
  const { goToPrevious, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label={t("previousBranchAria")}
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  )
}

export type MessageBranchNextProps = ComponentProps<typeof Button>

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const t = useTranslations("Folder.chat.messageBranch")
  const { goToNext, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label={t("nextBranchAria")}
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  )
}

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const t = useTranslations("Folder.chat.messageBranch")
  const { currentBranch, totalBranches } = useMessageBranch()

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {t("pageOf", { current: currentBranch + 1, total: totalBranches })}
    </ButtonGroupText>
  )
}

// MessageResponse renders ASSISTANT / agent Markdown. User messages no longer
// use it — they render as plain text + reference badges via PlainTextWithBadges
// (see message/plain-text-with-badges.tsx) — so the former user-only `softBreaks`
// / `/slash`-badging hooks were removed.
export type MessageResponseProps = ComponentProps<typeof Streamdown>

// remark-math uses dollar delimiters. `\[...\]` / `\(...\)` are rewritten
// to `$$...$$`. Single-dollar `$...$` is disabled (`singleDollarTextMath:
// false`) so currency (`$9.99`) and shell vars (`$HOME`, `$1`) stay prose.
//
// A single-line `$$x$$` inside a paragraph stays *inline* math (mdast tags
// every math-text node `math-inline` regardless of dollar count). The one
// hazard is math FLOW: a `$$` that starts a line's block content opens a
// display fence and swallows the rest of that line as fence metadata. Both
// delimiters of a multi-line `\(...\)` can land there, and both are kept off
// it by putting a zero-width space in front:
//
//   opener — padded only when the `$$` would land exactly at block content
//            start, since the pad sits in the surrounding Markdown, where it
//            is a real character to later constructs. (An emphasis run or a
//            link-reference label padded on one side stops matching.)
//   closer — padded unconditionally. This pad lands INSIDE the formula,
//            where KaTeX ignores it, so it costs nothing to always emit and
//            saves having to decide whether the closing line is container
//            prefix or TeX. That question is not answerable from the line
//            alone: `\(a\n2. \)` and a list continuation look identical, as
//            do a tab-indented `>` and a blockquote marker, and a lazily
//            continued quote carries no marker at all.
//
// Code and inline code are masked BEFORE line endings are folded: the inline
// mask excludes LF but tolerates a bare CR, so folding first would un-mask
// multi-line inline code and rewrite its contents.
//
// Known limit, pre-existing: an INDENTED code block is not masked, so
// `\(...\)` inside one is rewritten (it already is on main). Padding cannot
// avoid it — 4 spaces means "indented code" at top level but "content column"
// inside a nested list, and a prefix scan cannot tell those apart.
export function normalizeMathDelimiters(text: string): string {
  const { masked, restore } = maskLiteralSpans(text)
  // Fold line endings only after masking, so the offsets and line scans below
  // match what remark-parse sees while masked code keeps its own bytes.
  const source = masked.replace(/\r\n|\r/g, "\n")
  const normalized = source
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => `$$${inner}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string, offset: number) => {
      if (!inner.includes("\n")) return `$$${inner}$$`
      const lineStart = source.lastIndexOf("\n", offset - 1) + 1
      const atContentStart =
        containerPrefixEnd(source, lineStart, offset) === offset
      const open = atContentStart ? MATH_FENCE_PAD : ""
      return `${open}$$${inner}${MATH_FENCE_PAD}$$`
    })
  return restore(normalized)
}

function isSpaceOrTab(code: number): boolean {
  return code === 32 || code === 9
}

/**
 * Index just past the CommonMark container prefix (blockquote markers, list
 * markers, indentation) opening the line `[start, end)` — i.e. where that
 * line's block content begins. Returns `start` when content starts
 * immediately. Single pass, no backtracking: every iteration consumes at
 * least one character or returns.
 *
 * Indentation is deliberately not capped at 3. A deeper run only happens
 * inside a nested list (where it IS the content column, so the guard is
 * needed) or in an indented code block (where the guard is inert).
 */
function containerPrefixEnd(
  source: string,
  start: number,
  end: number
): number {
  let i = start
  for (;;) {
    while (i < end && isSpaceOrTab(source.charCodeAt(i))) i += 1
    if (i >= end) return i

    const ch = source.charCodeAt(i)
    if (ch === 62 /* > */) {
      i += 1
      continue
    }

    if (ch === 42 /* * */ || ch === 45 /* - */ || ch === 43 /* + */) {
      if (i + 1 < end && isSpaceOrTab(source.charCodeAt(i + 1))) {
        i += 2
        continue
      }
      return i
    }

    if (ch >= 48 && ch <= 57) {
      let j = i
      let digits = 0
      while (
        j < end &&
        digits < 9 &&
        source.charCodeAt(j) >= 48 &&
        source.charCodeAt(j) <= 57
      ) {
        digits += 1
        j += 1
      }
      const marker = j < end ? source.charCodeAt(j) : 0
      if (
        (marker === 46 /* . */ || marker === 41) /* ) */ &&
        j + 1 < end &&
        isSpaceOrTab(source.charCodeAt(j + 1))
      ) {
        i = j + 2
        continue
      }
      return i
    }

    return i
  }
}

const remarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  // Before remarkRewriteFileUriLinks, which reshapes a drive path's url.
  remarkRestoreWindowsPaths,
  remarkLocalImages,
  remarkRewriteFileUriLinks,
  remarkTrimCjkAutolinkTail,
]

// Streamdown's default rehype pipeline strips `codeg://` reference hrefs in
// sanitization (rendering them as "[blocked]"); re-derive it so they survive to
// MarkdownLink → ReferenceBadge. See rehype-allow-codeg for the full rationale.
// …and relative local links (`./a.md`, `src/a.md`, `~/a.md`) keep their href
// through harden, which would otherwise flatten them to a root path or block
// them. See rehype-relative-file-links.
const rehypePlugins = rehypePluginsAllowingCodeg(
  withRelativeFileLinks(defaultRehypePlugins)
)

/**
 * How finished Markdown renders. Streamdown defaults to `mode="streaming"` +
 * remend; remend 1.2.0 appends a closer after spans that are ALREADY complete —
 * a glob inside code (`` `foo/*` ``), an identifier like `_meta` / `_blank` —
 * so a finished reply grew a stray `*` / `_`. When the reply ends exactly at a
 * closing fence that `_` lands after the final ```, the fence stops closing and
 * the backticks become code content (#555).
 *
 * `mode` is the half that does the work, and it is NOT interchangeable with
 * the other one. Streamdown runs remend only when `mode === "streaming" &&
 * parseIncompleteMarkdown`, so static already bypasses it — but static is also
 * the only half that repaints: Streamdown's own memo compares `mode` and NOT
 * `parseIncompleteMarkdown`, so at the live → finished flip, with the text
 * unchanged (the common case — the last delta already carried the whole
 * reply), flipping only `parseIncompleteMarkdown` leaves the remended DOM on
 * screen. `parseIncompleteMarkdown` is therefore redundant while `mode` is
 * static, and kept as an explicit invariant: it is what keeps a caller who
 * passes `mode="streaming"` for finished content from re-growing the closer.
 *
 * The impl default and the memo comparator below must agree on these, or a
 * caller passing the default explicitly would compare unequal to one omitting
 * it — hence the shared constants.
 */
const FINISHED_MODE = "static" as const
const FINISHED_PARSE_INCOMPLETE_MARKDOWN = false

/**
 * How remend repairs an unclosed link while the text is still streaming: it
 * shows the link's text, and nothing else, until the closing `)` arrives.
 *
 * remend's default instead points the partial link at the placeholder
 * `streamdown:incomplete-link`. sanitize does not allow that scheme, so it
 * drops the href, and harden turns the bare anchor into "label [blocked]" — on
 * every link, for as long as its destination is still arriving. Worse,
 * Streamdown memoizes list items, paragraphs and headings by their source span
 * alone, and the placeholder is 26 characters long: a link whose destination
 * is 26 characters too, and that ends its list item, paragraph or heading,
 * spans the same source before and after it closes, so the element never
 * repaints and the link stays "[blocked]" until the turn ends. As bare text the
 * unclosed link is always shorter than the closed one, so closing it always
 * moves the span and the element repaints.
 *
 * A caller may tune remend's other repairs, but not this one.
 */
export const LIVE_REMEND = {
  linkMode: "text-only",
} as const satisfies NonNullable<MessageResponseProps["remend"]>

function MessageResponseImpl({
  className,
  children,
  // Finished content by default; a live turn opts back into remend by passing
  // `mode="streaming" parseIncompleteMarkdown`. See FINISHED_MODE above.
  mode = FINISHED_MODE,
  parseIncompleteMarkdown = FINISHED_PARSE_INCOMPLETE_MARKDOWN,
  remend,
  ...props
}: MessageResponseProps) {
  const normalized = useMemo(
    () =>
      typeof children === "string"
        ? normalizeMathDelimiters(children)
        : children,
    [children]
  )
  const plugins = useStreamdownPlugins(
    typeof normalized === "string" ? normalized : undefined
  )

  return (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-3 [&_ol]:pl-3",
        // Streamdown gives `blockquote` its own `border-l-4
        // border-muted-foreground/30 … italic`, but those class names live in
        // node_modules, which Tailwind v4 does not scan — so the two border
        // utilities generate no CSS and a quote renders as bare indented text
        // with no rule (the `pl-4`/`my-4`/`text-muted-foreground` on the same
        // element only survive because they happen to be used elsewhere in src).
        // Re-declare the rule here, where it IS scanned; the descendant selector
        // also outranks Streamdown's plain utility class. No `pl-*` — its `pl-4`
        // already works and a same-specificity duplicate would be a coin flip.
        // Upright, not italic: CJK has no true italic, so a browser fakes it by
        // skewing, which looks broken.
        "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:not-italic",
        className
      )}
      plugins={plugins}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      mode={mode}
      parseIncompleteMarkdown={parseIncompleteMarkdown}
      remend={remend ? { ...remend, ...LIVE_REMEND } : LIVE_REMEND}
      {...props}
      // Merge after spreading props so a caller can still override other
      // elements, but the link icon + safety routing on `a` — and the diagram
      // block on `pre` — always win.
      components={{
        ...props.components,
        ...markdownLinkComponents,
        ...markdownLocalImageComponents,
        ...mermaidComponents,
      }}
    >
      {normalized}
    </Streamdown>
  )
}

export const MessageResponse = memo(
  MessageResponseImpl,
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    (prevProps.mode ?? FINISHED_MODE) === (nextProps.mode ?? FINISHED_MODE) &&
    (prevProps.parseIncompleteMarkdown ??
      FINISHED_PARSE_INCOMPLETE_MARKDOWN) ===
      (nextProps.parseIncompleteMarkdown ?? FINISHED_PARSE_INCOMPLETE_MARKDOWN)
)

MessageResponse.displayName = "MessageResponse"

export type MessageToolbarProps = ComponentProps<"div">

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
)
