"use client"

import {
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { useTranslations } from "next-intl"
import { Tabs as TabsPrimitive } from "radix-ui"

import { AppearanceContext } from "@/components/appearance-provider"
import { Button } from "@/components/ui/button"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { useHarnessView } from "@/contexts/harness-view-context"
import { useElementWidth } from "@/hooks/use-element-width"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  isHarnessSectionId,
  type HarnessSectionId,
} from "@/lib/harness-sections"
import { cn } from "@/lib/utils"
import { DiscoverSection } from "./discover/discover-section"
import { HarnessSectionNav } from "./harness-section-nav"
import { HarnessInstallDialogs } from "./install/harness-install-dialogs"
import { McpSection } from "./mcp/mcp-section"
import { PacksSection } from "./packs/packs-section"
import { SkillsSection } from "./skills/skills-section"

const SECTION_VIEWS: Record<HarnessSectionId, ComponentType> = {
  discover: DiscoverSection,
  mcp: McpSection,
  skills: SkillsSection,
  packs: PacksSection,
}

/**
 * The page width, in rem, below which the section column gives way to the
 * switch on top: the column's own 12rem (`w-48`) plus what a section needs to
 * put its list and its detail side by side (46rem in MCP, Skills and Skill
 * packs) — and no more, so that the most common desktop window, 1280 wide
 * with the sidebar at its default width (a page of about 959px), keeps the
 * column. Narrower than that, the column would cost a section its
 * side-by-side layout.
 *
 * In rem because everything it is weighed against is: the app's zoom scales
 * the root font size, and at 150% a column and a list are half again as wide.
 */
const SECTION_COLUMN_MIN_PAGE_REM = 58

/** Page title rendered into the window-chrome strip above the page — the
 *  shared breadcrumb header, like every other workbench route. */
export function HarnessPageTitle() {
  const t = useTranslations("Harness")
  return <WorkbenchPageTitle title={t("title")} />
}

/**
 * The page's line of description. It says what "Harness" means here before
 * anything else does: one of the agents is called "DeepSeek Harness", and the
 * name alone could be taken for it.
 *
 * On a phone (`folds`) it is held to one line. Two or three would sit on top
 * of the section switch and — in three of the sections — the host's line,
 * nearly half the screen before any of the section. Where the one line cuts
 * it short, a "More" at its end shows the rest, and "Less" folds it again.
 * The whole sentence is in the page all along: the fold is for the eye, and a
 * screen reader reads it through either way.
 */
function PageDescription({ text, folds }: { text: string; folds: boolean }) {
  const t = useTranslations("Harness")
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)
  const id = useId()
  const clamped = folds && !open

  // Whether the one line hides anything, measured before paint and again
  // whenever the line changes width. Only while it is one line: open, the
  // text wraps and fits by definition, and its "Less" must stay.
  useLayoutEffect(() => {
    const node = ref.current
    if (!clamped || !node) return
    const measure = () => setCut(node.scrollWidth > node.clientWidth + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [clamped, text])

  return (
    <header className="shrink-0 border-b border-border/50 px-3 py-2.5 ws-chrome-border md:px-4">
      <div className="flex min-w-0 items-start gap-2">
        <p
          id={id}
          ref={ref}
          className={cn(
            "min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground",
            clamped && "truncate"
          )}
        >
          {text}
        </p>
        {folds && (cut || open) && (
          <Button
            type="button"
            variant="link"
            size="xs"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
            // As tall as the line it ends, so the header keeps its height;
            // the hit area is padded out to a finger's size around it.
            className="relative -my-0.5 -me-1.5 shrink-0 gap-0.5 px-1.5 after:absolute after:-inset-x-1 after:-inset-y-2.5"
          >
            {t(open ? "descriptionLess" : "descriptionMore")}
            {open ? (
              <ChevronUp aria-hidden="true" />
            ) : (
              <ChevronDown aria-hidden="true" />
            )}
          </Button>
        )}
      </div>
    </header>
  )
}

/**
 * The Harness route page: one line saying what the page is for, the section
 * switcher, and the current section.
 *
 * The page keeps nothing of its own. Which section is current, and whatever a
 * section wants back after the user has been to a conversation and returned,
 * lives in the always-mounted `HarnessViewProvider` — this component is
 * unmounted every time the route is left.
 *
 * Only the current section is mounted: each reads what it shows when it is
 * opened, and keeps whatever must outlive it in the provider's slots.
 */
export function HarnessPage() {
  const t = useTranslations("Harness")
  const { discoverEnabled, sections, section, setSection } = useHarnessView()
  const isMobile = useIsMobile()
  const [pageRef, pageWidth] = useElementWidth<HTMLDivElement>()
  // Outside the provider (tests) the zoom is its default.
  const zoom = useContext(AppearanceContext)?.zoomLevel ?? 100
  // The page's OWN width, not the viewport's: on a wide screen the sidebar
  // beside it can still leave the page narrow. Unmeasured (the first render,
  // before the node attaches) counts as wide enough; the measurement lands in
  // the same commit, before anything is painted.
  const compact =
    isMobile ||
    (pageWidth > 0 &&
      pageWidth < (SECTION_COLUMN_MIN_PAGE_REM * 16 * zoom) / 100)

  const handleValueChange = useCallback(
    (value: string) => {
      if (isHarnessSectionId(value)) setSection(value)
    },
    [setSection]
  )

  return (
    // No background of its own: the route overlay already paints
    // `bg-background ws-transparent-bg` (workspace/layout.tsx), so an opaque
    // layer here would hide the workspace background image behind the page.
    <TabsPrimitive.Root
      ref={pageRef}
      value={section}
      onValueChange={handleValueChange}
      // Which arrow keys walk the sections follows the list's axis.
      orientation={compact ? "horizontal" : "vertical"}
      className="@container/harness flex h-full min-h-0 flex-col"
    >
      {/* Without a Discover section the sentence stops before pointing at
          one. */}
      <PageDescription
        text={t(discoverEnabled ? "description" : "descriptionNoDiscover")}
        folds={isMobile}
      />
      <div className={cn("flex min-h-0 flex-1", compact && "flex-col")}>
        <HarnessSectionNav
          sections={sections}
          section={section}
          compact={compact}
        />
        {/* The panels keep their place in the tree whichever shape the
            switcher is in, so a resize that flips it re-lays the section out
            without remounting it. Radix renders only the selected one. */}
        {sections.map((id) => {
          const SectionView = SECTION_VIEWS[id]
          return (
            <TabsPrimitive.Content
              key={id}
              value={id}
              className="min-h-0 min-w-0 flex-1 overflow-hidden outline-none"
            >
              <SectionView />
            </TabsPrimitive.Content>
          )
        })}
      </div>
      {/* Opened from Discover and from the MCP section alike, so drawn
          by the page: a dialog in progress stays up whichever section is
          on show. */}
      <HarnessInstallDialogs />
    </TabsPrimitive.Root>
  )
}
