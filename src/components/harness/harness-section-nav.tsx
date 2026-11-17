"use client"

import { useEffect, useRef } from "react"
import {
  BookOpenText,
  Boxes,
  Compass,
  PlugZap,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Tabs as TabsPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import type { HarnessSectionId } from "@/lib/harness-sections"
import { cn } from "@/lib/utils"

// MCP, Skills and Skill packs keep the glyphs the Settings window's nav gave
// them, so the three read as the same places they were there.
const SECTION_ICONS: Record<HarnessSectionId, LucideIcon> = {
  discover: Compass,
  mcp: PlugZap,
  skills: BookOpenText,
  packs: Boxes,
}

const SEGMENT_CLASS = cn(
  "h-8 flex-1 rounded-full px-2.5 text-[0.8125rem] font-medium whitespace-nowrap",
  "text-muted-foreground outline-none transition-colors hover:text-foreground",
  // Inset: the track scrolls sideways when the labels outgrow it, and a
  // scroller clips a ring drawn outside the segment.
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  // `data-*` rules come after `hover:` in the generated CSS, so the selected
  // segment keeps its colour under the pointer.
  "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
  "@md/harness:h-7 @md/harness:flex-none @md/harness:px-3"
)

interface HarnessSectionNavProps {
  /** The sections on offer, in order. */
  sections: readonly HarnessSectionId[]
  /** The selected one — the column marks it the way the Settings nav does. */
  section: HarnessSectionId
  /** The switch on top of the page instead of the column beside it. */
  compact: boolean
}

/**
 * The Harness page's section switcher, in its two shapes:
 *
 * - a column down the page's leading edge, looking like the Settings window's
 *   nav (the three sections that moved here from that window sit where a user
 *   of it expects them), while the page is wide enough for one;
 * - a segmented switch across the top of the page otherwise — a narrow window,
 *   a wide sidebar, a phone.
 *
 * Either way it is ONE tab list (the Radix `Tabs` the page wraps it in), so
 * both shapes get the same roles, the same roving focus and the same keys:
 * the arrows along the list's axis (↑/↓ in the column, ←/→ in the switch,
 * mirrored in a right-to-left language), Home and End. Moving focus selects,
 * as it does for every other tab list in the app.
 *
 * Built on the Radix primitives rather than the shared `ui/tabs` wrappers, for
 * the reason the aux panel's tab rail gives: those are one particular
 * segmented control, and both shapes here would have to undo most of it.
 */
export function HarnessSectionNav({
  sections,
  section,
  compact,
}: HarnessSectionNavProps) {
  const t = useTranslations("Harness")
  const switchRef = useRef<HTMLDivElement>(null)

  // On a phone the four labels can outgrow the track in the wordier languages
  // ("Paquetes de habilidades"), and the track then scrolls sideways with no
  // scrollbar to say so. A tap can only land on a segment that is in view, but
  // the page also opens on a remembered section and is sent to one by
  // `openHarness` — so the selected segment is brought into view whenever it
  // changes, or the switch could show three segments, none of them selected.
  useEffect(() => {
    if (!compact) return
    switchRef.current
      ?.querySelector<HTMLElement>('[data-state="active"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [compact, section])

  if (compact) {
    return (
      <div className="shrink-0 px-3 pt-3 md:px-4">
        <TabsPrimitive.List
          ref={switchRef}
          aria-label={t("sectionsLabel")}
          className={cn(
            // Full width with equal-growing segments on a phone, where the
            // four labels nearly fill the row anyway and a larger target is
            // welcome; sized to its labels once there is room to spare.
            "no-scrollbar flex h-9 w-full items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-0.5 ws-msg-chip",
            "@md/harness:h-8 @md/harness:w-fit"
          )}
        >
          {sections.map((id) => (
            <TabsPrimitive.Trigger
              key={id}
              value={id}
              className={SEGMENT_CLASS}
            >
              {t(`sections.${id}`)}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
      </div>
    )
  }

  return (
    <TabsPrimitive.List
      aria-label={t("sectionsLabel")}
      className="flex w-48 shrink-0 flex-col gap-1 border-e border-border/50 px-2 py-3 ws-chrome-border"
    >
      {sections.map((id) => {
        const Icon = SECTION_ICONS[id]
        // The Settings nav's row: same button, same variants, same icon size
        // (the Button's own 1rem default).
        return (
          <TabsPrimitive.Trigger key={id} value={id} asChild>
            <Button
              type="button"
              variant={id === section ? "secondary" : "ghost"}
              size="sm"
              className="w-full justify-start px-2"
            >
              <Icon aria-hidden="true" />
              <span className="truncate">{t(`sections.${id}`)}</span>
            </Button>
          </TabsPrimitive.Trigger>
        )
      })}
    </TabsPrimitive.List>
  )
}
