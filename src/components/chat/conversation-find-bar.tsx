"use client"

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react"
import { ChevronDown, ChevronUp, Loader2, Search, X } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ThreadRenderItem } from "@/components/message/message-list-view"
import type { MessageScrollContextValue } from "@/components/message/message-scroll-context"
import { searchConversationMessages } from "@/lib/api"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { ConversationMessageMatch } from "@/lib/types"

export interface ConversationFindBarProps {
  conversationId: number
  open: boolean
  focusToken: number
  onClose: () => void
  threadItems: readonly ThreadRenderItem[]
  liveMessage?: { id: string; content?: unknown } | null
  scrollApiRef: RefObject<MessageScrollContextValue | null>
  containerRef?: RefObject<HTMLElement | null>
  loadOlderTurnsThrough: (
    conversationId: number,
    throughIndex: number
  ) => Promise<boolean>
  onActiveTurnChange?: (turnId: string | null) => void
  turnsOffset?: number
}

function extractText(parts: AdaptedContentPart[]): string {
  return parts
    .flatMap((p): string[] => {
      if (p.type === "text") return [p.text]
      if (p.type === "goal-run") return [extractText(p.items)]
      if (p.type === "tool-call") {
        const textParts = [p.toolName]
        if (p.input && typeof p.input === "object") {
          try {
            textParts.push(JSON.stringify(p.input))
          } catch {
            // ignore
          }
        }
        if (p.output && typeof p.output === "string") {
          textParts.push(p.output)
        }
        return textParts
      }
      return []
    })
    .filter((text) => text.length > 0)
    .join("\n")
}

function findTextRanges(
  root: HTMLElement,
  query: string,
  excludeSelector?: string
): Range[] {
  if (!query) return []
  const qLower = query.toLowerCase()
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (
        !node.textContent ||
        !node.textContent.toLowerCase().includes(qLower)
      ) {
        return NodeFilter.FILTER_REJECT
      }
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName.toLowerCase()
      if (tag === "script" || tag === "style" || tag === "textarea") {
        return NodeFilter.FILTER_REJECT
      }
      if (excludeSelector && parent.closest(excludeSelector)) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let currentNode = walker.nextNode()
  while (currentNode) {
    const text = currentNode.textContent ?? ""
    const textLower = text.toLowerCase()
    let start = 0
    while ((start = textLower.indexOf(qLower, start)) !== -1) {
      try {
        const range = new Range()
        range.setStart(currentNode, start)
        range.setEnd(currentNode, start + query.length)
        ranges.push(range)
      } catch {
        // ignore
      }
      start += qLower.length
    }
    currentNode = walker.nextNode()
  }
  return ranges
}

const ICON_BTN =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"

export const ConversationFindBar = memo(function ConversationFindBar({
  conversationId,
  open,
  focusToken,
  onClose,
  threadItems,
  liveMessage,
  scrollApiRef,
  containerRef,
  loadOlderTurnsThrough,
  onActiveTurnChange,
  turnsOffset = 0,
}: ConversationFindBarProps) {
  const t = useTranslations("ConversationFind")
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<ConversationMessageMatch[]>([])
  const [matchIndex, setMatchIndex] = useState(0)
  const [searching, setSearching] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)

  // Focus & select input on open or focusToken change
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, focusToken])

  // Clear state when closed
  useEffect(() => {
    if (!open) {
      setQuery("")
      setMatches([])
      setMatchIndex(0)
      onActiveTurnChange?.(null)
    }
  }, [open, onActiveTurnChange])

  // Jump to a specific match item
  const jumpToMatch = useCallback(
    async (match: ConversationMessageMatch) => {
      onActiveTurnChange?.(match.turn_id)

      // Check if turn is currently in threadItems
      const itemIndex = threadItems.findIndex(
        (it) => it.kind === "turn" && it.group.id === match.turn_id
      )

      if (itemIndex !== -1) {
        scrollApiRef.current?.scrollToIndex(itemIndex, {
          align: "center",
          smooth: true,
        })
        return
      }

      // If not loaded and in older turns
      if (conversationId > 0 && match.turn_index < turnsOffset) {
        setLoadingOlder(true)
        try {
          const success = await loadOlderTurnsThrough(
            conversationId,
            match.turn_index
          )
          if (success) {
            // Give virtua a frame to incorporate prepended items
            requestAnimationFrame(() => {
              const updatedIndex = threadItems.findIndex(
                (it) => it.kind === "turn" && it.group.id === match.turn_id
              )
              if (updatedIndex !== -1) {
                scrollApiRef.current?.scrollToIndex(updatedIndex, {
                  align: "center",
                  smooth: false,
                })
              }
            })
          }
        } finally {
          setLoadingOlder(false)
        }
      }
    },
    [
      conversationId,
      loadOlderTurnsThrough,
      onActiveTurnChange,
      scrollApiRef,
      threadItems,
      turnsOffset,
    ]
  )

  // Web-standard text highlighting via CSS Custom Highlight API
  useEffect(() => {
    const cssWithHighlights =
      typeof CSS !== "undefined"
        ? (CSS as unknown as {
            highlights?: {
              set(name: string, highlight: unknown): void
              delete(name: string): void
              clear(): void
            }
          })
        : null
    const windowWithHighlight =
      typeof window !== "undefined"
        ? (window as unknown as {
            Highlight?: new (...ranges: Range[]) => unknown
          })
        : null

    if (!cssWithHighlights?.highlights || !windowWithHighlight?.Highlight) {
      return
    }

    const trimmed = query.trim()
    const container = containerRef?.current

    if (!open || !trimmed || !container) {
      cssWithHighlights.highlights.delete("search-match")
      cssWithHighlights.highlights.delete("search-match-active")
      return
    }

    const rafId = requestAnimationFrame(() => {
      if (!containerRef?.current) return
      const ranges = findTextRanges(
        containerRef.current,
        trimmed,
        "[role='search']"
      )
      if (ranges.length === 0) {
        cssWithHighlights.highlights?.delete("search-match")
        cssWithHighlights.highlights?.delete("search-match-active")
        return
      }

      const activeMatch = matches[matchIndex]
      let activeRangeIndex = -1
      if (activeMatch) {
        activeRangeIndex = ranges.findIndex((r) => {
          const el = r.startContainer.parentElement
          return el?.closest(`[data-turn-id="${activeMatch.turn_id}"]`) !== null
        })
      }
      if (activeRangeIndex === -1 && ranges.length > 0) {
        activeRangeIndex = 0
      }

      try {
        const allHighlight = new windowWithHighlight.Highlight!(...ranges)
        cssWithHighlights.highlights?.set("search-match", allHighlight)

        if (activeRangeIndex !== -1 && ranges[activeRangeIndex]) {
          const activeRange = ranges[activeRangeIndex]
          const activeHighlight = new windowWithHighlight.Highlight!(
            activeRange
          )
          cssWithHighlights.highlights?.set(
            "search-match-active",
            activeHighlight
          )

          activeRange.startContainer.parentElement?.scrollIntoView({
            block: "nearest",
            inline: "nearest",
            behavior: "smooth",
          })
        } else {
          cssWithHighlights.highlights?.delete("search-match-active")
        }
      } catch {
        // ignore highlight registration errors
      }
    })

    return () => {
      cancelAnimationFrame(rafId)
      cssWithHighlights.highlights?.delete("search-match")
      cssWithHighlights.highlights?.delete("search-match-active")
    }
  }, [open, query, matchIndex, matches, containerRef, threadItems])

  // Search execution
  const executeSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim()
      if (!trimmed) {
        setMatches([])
        setMatchIndex(0)
        onActiveTurnChange?.(null)
        setSearching(false)
        return
      }

      const seq = ++searchSeq.current
      setSearching(true)

      try {
        let results: ConversationMessageMatch[] = []

        if (conversationId > 0) {
          // Backend search across full conversation history (including unloaded turns)
          results = await searchConversationMessages(conversationId, trimmed)

          // Check if liveMessage (streaming) matches and append if needed
          if (liveMessage && liveMessage.content) {
            const liveContent = liveMessage.content as unknown[]
            const liveText = Array.isArray(liveContent)
              ? liveContent
                  .map((item) =>
                    item &&
                    typeof item === "object" &&
                    "text" in item &&
                    typeof (item as { text: unknown }).text === "string"
                      ? (item as { text: string }).text
                      : ""
                  )
                  .join(" ")
              : ""
            const qLower = trimmed.toLowerCase()
            if (liveText.toLowerCase().includes(qLower)) {
              const count = liveText.toLowerCase().split(qLower).length - 1
              results.push({
                turn_index: Number.MAX_SAFE_INTEGER,
                turn_id: liveMessage.id,
                role: "assistant",
                match_count: count,
                snippet: liveText.slice(0, 80),
              })
            }
          }
        } else {
          // Draft conversation: search in-memory thread items
          const qLower = trimmed.toLowerCase()
          let turnIdx = 0
          for (const item of threadItems) {
            if (item.kind !== "turn") continue
            const turnText = extractText(item.group.parts)
            if (turnText.toLowerCase().includes(qLower)) {
              const count = turnText.toLowerCase().split(qLower).length - 1
              results.push({
                turn_index: turnIdx,
                turn_id: item.group.id,
                role: item.group.role,
                match_count: count,
                snippet: turnText.slice(0, 80),
              })
            }
            turnIdx++
          }
        }

        if (searchSeq.current === seq) {
          setMatches(results)
          setMatchIndex(0)
          if (results.length > 0) {
            void jumpToMatch(results[0])
          } else {
            onActiveTurnChange?.(null)
          }
        }
      } catch (err) {
        console.error("[ConversationFindBar] search error:", err)
        if (searchSeq.current === seq) {
          setMatches([])
          onActiveTurnChange?.(null)
        }
      } finally {
        if (searchSeq.current === seq) {
          setSearching(false)
        }
      }
    },
    [conversationId, jumpToMatch, liveMessage, onActiveTurnChange, threadItems]
  )

  // Debounced input change
  const handleQueryChange = (val: string) => {
    setQuery(val)
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
    }
    debounceTimer.current = setTimeout(() => {
      void executeSearch(val)
    }, 150)
  }

  // Navigate next/prev
  const step = useCallback(
    (forward: boolean) => {
      if (matches.length === 0) return
      const nextIndex = forward
        ? (matchIndex + 1) % matches.length
        : (matchIndex - 1 + matches.length) % matches.length
      setMatchIndex(nextIndex)
      void jumpToMatch(matches[nextIndex])
    },
    [jumpToMatch, matchIndex, matches]
  )

  if (!open) return null

  return (
    <div
      role="search"
      aria-label={t("placeholder")}
      className="absolute right-4 top-3 z-30 flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/95 p-1.5 shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-150"
    >
      <Search className="h-3.5 w-3.5 text-muted-foreground ml-1 shrink-0" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            step(!e.shiftKey)
          } else if (e.key === "Escape") {
            e.preventDefault()
            onClose()
          }
        }}
        spellCheck={false}
        autoComplete="off"
        placeholder={t("placeholder")}
        aria-label={t("placeholder")}
        className="h-7 w-44 sm:w-56 rounded bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground outline-none"
      />

      <div className="flex items-center text-xs shrink-0 px-1">
        {searching ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : loadingOlder ? (
          <span className="text-[11px] text-muted-foreground animate-pulse">
            {t("loadingOlder")}
          </span>
        ) : query.trim() && matches.length === 0 ? (
          <span className="text-[11px] text-destructive">{t("noMatches")}</span>
        ) : matches.length > 0 ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t("matchCount", {
              current: matchIndex + 1,
              total: matches.length,
            })}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-0.5 border-l border-border/60 pl-1">
        <button
          type="button"
          className={ICON_BTN}
          title={t("previous")}
          aria-label={t("previous")}
          disabled={matches.length === 0}
          onClick={() => step(false)}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={ICON_BTN}
          title={t("next")}
          aria-label={t("next")}
          disabled={matches.length === 0}
          onClick={() => step(true)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={ICON_BTN}
          title={t("close")}
          aria-label={t("close")}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
})
