"use client"

import { useEffect, useRef, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { Direction } from "radix-ui"

import { useHarnessView } from "@/contexts/harness-view-context"
import type { HarnessSectionId } from "@/lib/harness-sections"
import { cn } from "@/lib/utils"
import { useHarnessSectionCounts } from "./harness-section-counts"

/** The ids that tie a tab to its panel (`HarnessPage` draws the panel). */
export const harnessTabId = (id: HarnessSectionId) => `harness-tab-${id}`
export const harnessPanelId = (id: HarnessSectionId) => `harness-panel-${id}`

/**
 * The Harness page's sections, as tabs in the window-chrome strip after the
 * page's title — `驾驭工程 | Discover  MCP 4  Skills 12  Skill packs 2`.
 *
 * The strip and the page are drawn by different hosts (the route's strip and
 * its page), so this is a tab list of its own rather than a Radix `Tabs`: the
 * section it selects lives in `HarnessViewProvider`, which both sides read.
 * It keeps a tab list's keys — the arrows along it (mirrored in a
 * right-to-left language), Home and End — and moving the focus selects, as
 * every other tab list in the app does.
 *
 * Each local section carries what it holds (`useHarnessSectionCounts`);
 * Discover's size is the catalog's, said on the page itself.
 */
export function HarnessSectionNav() {
  const t = useTranslations("Harness")
  const { sections, section, setSection } = useHarnessView()
  const counts = useHarnessSectionCounts(section)
  const listRef = useRef<HTMLDivElement>(null)
  const rtl = Direction.useDirection() === "rtl"

  // In a narrow window the tabs scroll sideways with no scrollbar to say so:
  // the selected one is kept in view, however it was selected.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [section])

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = sections.indexOf(section)
    let next: number | null = null
    switch (event.key) {
      case "ArrowRight":
        next = index + (rtl ? -1 : 1)
        break
      case "ArrowLeft":
        next = index + (rtl ? 1 : -1)
        break
      case "Home":
        next = 0
        break
      case "End":
        next = sections.length - 1
        break
    }
    if (next === null) return
    event.preventDefault()
    const target = sections[(next + sections.length) % sections.length]
    setSection(target)
    document.getElementById(harnessTabId(target))?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t("sectionsLabel")}
      aria-orientation="horizontal"
      className="no-scrollbar flex h-10 min-w-0 items-stretch overflow-x-auto"
    >
      {sections.map((id) => {
        const selected = id === section
        const count = counts[id]
        return (
          <button
            key={id}
            id={harnessTabId(id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={harnessPanelId(id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => setSection(id)}
            onKeyDown={move}
            className={cn(
              // Words, not pills: at rest a tab is only its label, so the
              // divider before the first one sits halfway between the title
              // and that label. The tab on show is underlined on the strip's
              // bottom edge.
              "relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[0.8125rem] font-medium whitespace-nowrap outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              "after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors",
              selected
                ? "text-foreground after:bg-primary"
                : "text-muted-foreground after:bg-transparent hover:text-foreground"
            )}
          >
            {t(`sections.${id}`)}
            {count !== undefined && (
              <span
                className={cn(
                  "text-xs font-normal tabular-nums",
                  selected ? "text-primary" : "text-muted-foreground/70"
                )}
              >
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
