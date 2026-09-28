"use client"

import type { ComponentProps, ReactNode } from "react"

import { useControllableState } from "@radix-ui/react-use-controllable-state"
import { useTranslations } from "next-intl"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { cn } from "@/lib/utils"
import { BrainIcon, ChevronRightIcon } from "lucide-react"
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react"
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown"

import { Shimmer } from "./shimmer"
import { markdownLinkComponents } from "./markdown-link"
import { mermaidComponents } from "./mermaid-block"
import { LIVE_REMEND, normalizeMathDelimiters } from "./message"
import { rehypePluginsAllowingCodeg } from "./rehype-allow-codeg"
import { remarkTrimCjkAutolinkTail } from "./remark-cjk-autolink-tail"
import { withRelativeFileLinks } from "./rehype-relative-file-links"
import { remarkRewriteFileUriLinks } from "./remark-file-uri-links"
import { remarkRestoreWindowsPaths } from "./remark-windows-paths"
import { useStreamdownPlugins } from "./streamdown-plugins"

interface ReasoningContextValue {
  isStreaming: boolean
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  duration: number | undefined
  expandable: boolean
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null)

export const useReasoning = () => {
  const context = useContext(ReasoningContext)
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning")
  }
  return context
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  duration?: number
  expandable?: boolean
}

const MS_IN_S = 1000

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    expandable = true,
    children,
    ...props
  }: ReasoningProps) => {
    // Thinking stays folded until the reader asks for it. Upstream opened the
    // panel the moment a delta arrived and closed it a second after the block
    // ended: that shoves the reply down the viewport mid-turn, and the close
    // then pulls the text out from under anyone still reading it. Only an
    // explicit `defaultOpen`/`open` opens this now, and once opened it stays
    // open until the reader folds it back.
    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: expandable && defaultOpen,
      onChange: onOpenChange,
      prop: expandable ? open : false,
    })
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    })

    const startTimeRef = useRef<number | null>(null)

    // Track when streaming starts and compute duration
    useEffect(() => {
      if (isStreaming) {
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now()
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S))
        startTimeRef.current = null
      }
    }, [isStreaming, setDuration])

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen)
      },
      [setIsOpen]
    )

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen, expandable }),
      [duration, isOpen, isStreaming, setIsOpen, expandable]
    )

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    )
  }
)

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const t = useTranslations("Folder.chat.reasoning")
    const { isStreaming, isOpen, duration, expandable } = useReasoning()
    const defaultGetThinkingMessage = useCallback(
      (nextIsStreaming: boolean, nextDuration?: number) => {
        if (nextIsStreaming || nextDuration === 0) {
          return (
            <Shimmer duration={1} shineColor="var(--primary)">
              {t("thinking")}
            </Shimmer>
          )
        }
        if (nextDuration === undefined) {
          return <p>{t("thoughtForFewSeconds")}</p>
        }
        return <p>{t("thoughtForSeconds", { duration: nextDuration })}</p>
      },
      [t]
    )
    const thinkingMessageBuilder =
      getThinkingMessage ?? defaultGetThinkingMessage

    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors",
          expandable
            ? "hover:text-foreground"
            : "cursor-default hover:text-muted-foreground",
          className
        )}
        disabled={!expandable}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {thinkingMessageBuilder(isStreaming, duration)}
            {expandable && (
              <ChevronRightIcon
                className={cn(
                  "size-4 transition-transform",
                  isOpen ? "rotate-90" : "rotate-0"
                )}
              />
            )}
          </>
        )}
      </CollapsibleTrigger>
    )
  }
)

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string
}

const remarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  // Before remarkRewriteFileUriLinks, which reshapes a drive path's url.
  remarkRestoreWindowsPaths,
  remarkRewriteFileUriLinks,
  remarkTrimCjkAutolinkTail,
]

// The same links survive as in MessageResponse: `codeg://` references keep
// their href through sanitize (rehype-allow-codeg), which would otherwise leave
// "@Codex [blocked]", and relative local links keep theirs through harden —
// without that `./a.md` would leave harden as `/a.md` and a bare `a.md` would
// be blocked (rehype-relative-file-links).
const rehypePlugins = rehypePluginsAllowingCodeg(
  withRelativeFileLinks(defaultRehypePlugins)
)

const reasoningComponents = { ...markdownLinkComponents, ...mermaidComponents }

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    // Reasoning is a LIVE surface — a reader who opens this panel mid-turn
    // keeps it mounted across every delta of a block that routinely runs into
    // the thousands of tokens. `mode="static"` re-parses the whole text each
    // time (streaming splits it into blocks and re-parses only the tail),
    // which measured ~2.9x slower over a 120-delta stream and gets worse the
    // longer the block runs. So track the turn, exactly like the reply prose
    // does: remend while the text is still growing, static — and therefore
    // free of remend's leftover `*` / `_` — once it has settled.
    const { isStreaming } = useReasoning()
    const normalized = useMemo(
      () => normalizeMathDelimiters(children),
      [children]
    )
    const plugins = useStreamdownPlugins(normalized)

    return (
      <CollapsibleContent
        className={cn(
          "mt-4 text-sm",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
          className
        )}
        {...props}
      >
        <Streamdown
          plugins={plugins}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          {...props}
          mode={isStreaming ? "streaming" : "static"}
          parseIncompleteMarkdown={isStreaming}
          // An unclosed link shows as text, as in MessageResponse — see
          // LIVE_REMEND for why the default placeholder cannot be used.
          remend={LIVE_REMEND}
          // Enforce the link icon + safety override after spreading props.
          components={reasoningComponents}
        >
          {normalized}
        </Streamdown>
      </CollapsibleContent>
    )
  }
)

Reasoning.displayName = "Reasoning"
ReasoningTrigger.displayName = "ReasoningTrigger"
ReasoningContent.displayName = "ReasoningContent"
