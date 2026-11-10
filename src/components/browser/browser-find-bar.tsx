"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronUp, X } from "lucide-react"
import { useTranslations } from "next-intl"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import { browserFind } from "@/lib/browser/browser-api"
import { browserTabBackendId } from "@/lib/file-tab-id"
import { cn } from "@/lib/utils"

const ICON_BTN =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"

/**
 * ⌘F in a browser tab. The search itself is the engine's (WebKit's
 * `findString:`), so the page cannot see it, style it, or break it — this bar
 * only collects the query and reports whether the last step matched.
 *
 * It sits ABOVE the native surface in the flex column, like the toolbar: a
 * native view paints over any DOM placed on top of it, so an overlay would be
 * invisible.
 *
 * There is no match counter: WebKit's API answers "did this step find
 * something", not "how many are there", and a made-up count is worse than
 * none.
 */
export function BrowserFindBar({
  tab,
  open,
  focusToken,
  onClose,
}: {
  tab: BrowserWorkspaceTab
  open: boolean
  /** Bumped every time the user asks for the bar; re-focuses an open one. */
  focusToken: number
  onClose: () => void
}) {
  const t = useTranslations("Browser.find")
  const backendId = browserTabBackendId(tab.id)
  const [query, setQuery] = useState("")
  const [missing, setMissing] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Searches are answered out of order (each is a round trip to the engine):
  // a stale answer must not relabel the query on screen now.
  const searchSeq = useRef(0)

  const step = useCallback(
    (text: string, forward: boolean) => {
      if (!backendId) return
      searchSeq.current += 1
      const seq = searchSeq.current
      if (!text) {
        setMissing(false)
        void browserFind(backendId, "", true).catch(() => {})
        return
      }
      void browserFind(backendId, text, forward)
        .then((found) => {
          if (searchSeq.current === seq) setMissing(!found)
        })
        .catch(() => {
          // Includes the host's "WebKit did not answer": say nothing rather
          // than claim there are no matches.
          if (searchSeq.current === seq) setMissing(false)
        })
    },
    [backendId]
  )

  // "No matches" belongs to the search that produced it: a bar that opens
  // again starts clean. Adjusted during render on the prop transition (the
  // state-from-previous-render pattern) rather than in an effect, so it never
  // paints stale.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setMissing(false)
  }

  // Opening (or re-pressing ⌘F) selects what is there, the way a browser's
  // find bar does, so a second search replaces the first by typing. Keyed on
  // `focusToken` as well: pressing ⌘F again with the bar already open must
  // pull focus back out of the page, and `open` alone does not change then.
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, focusToken])

  // Closing drops the engine's highlight; leaving it behind would look like
  // a page selection the user cannot get rid of. Counts as a search so any
  // answer still in flight is ignored when it lands.
  useEffect(() => {
    if (open || !backendId) return
    searchSeq.current += 1
    void browserFind(backendId, "", true).catch(() => {})
  }, [open, backendId])

  if (!open) return null

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-muted/40 px-1.5">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          const text = event.target.value
          setQuery(text)
          step(text, true)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            step(query, !event.shiftKey)
          } else if (event.key === "Escape") {
            event.preventDefault()
            onClose()
          }
        }}
        spellCheck={false}
        autoComplete="off"
        placeholder={t("placeholder")}
        aria-label={t("placeholder")}
        className={cn(
          "mx-1 h-7 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-xs text-foreground outline-none",
          missing
            ? "border-destructive/60 text-destructive"
            : "border-transparent focus:border-ring/50 focus:ring-2 focus:ring-ring/20"
        )}
      />
      {missing ? (
        <span className="shrink-0 px-1 text-xs text-muted-foreground">
          {t("noMatches")}
        </span>
      ) : null}
      <button
        type="button"
        className={ICON_BTN}
        title={t("previous")}
        aria-label={t("previous")}
        disabled={!query}
        onClick={() => step(query, false)}
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={ICON_BTN}
        title={t("next")}
        aria-label={t("next")}
        disabled={!query}
        onClick={() => step(query, true)}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={ICON_BTN}
        title={t("close")}
        aria-label={t("close")}
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
