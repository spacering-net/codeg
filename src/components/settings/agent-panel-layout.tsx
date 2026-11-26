"use client"

/**
 * Layout grammar for an agent's settings panel — two levels, never more:
 *
 * - {@link AgentPanelGroup}: what a block of the panel is for (title, one
 *   line of description, optional actions). Borderless — the panel it sits in
 *   is already a bordered surface, so a frame here would only add a layer.
 * - {@link AgentPanelCard}: one decision — an option, or a few fields that are
 *   set together. The only bordered surface inside the panel.
 *
 * Everything finer than a card (a field, a sub-heading, a note) is laid out
 * inside it with spacing and hairlines, not with another box. Panels used to
 * stack four or five frames (panel › section › card › dashed box › …), which
 * read as clutter long before it read as structure.
 *
 * Title and description use one type scale everywhere — `text-xs
 * font-medium` over `text-2xs text-muted-foreground` — so a card for a switch,
 * a card for a sign-in flow and a group heading all read the same.
 */

import { useEffect, useRef, useState } from "react"
import type { LucideIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

interface HeaderProps {
  icon?: LucideIcon
  title?: React.ReactNode
  description?: React.ReactNode
  /** Ties the title to the control it labels, so clicking the title works it. */
  htmlFor?: string
  /** Compact control or actions pinned to the right of the title. */
  control?: React.ReactNode
  /** Rendered as a heading (groups) or as a label/paragraph (cards). */
  as?: "h3" | "div"
}

function PanelHeader({
  icon: Icon,
  title,
  description,
  htmlFor,
  control,
  as = "div",
}: HeaderProps) {
  if (!title && !description && !control) return null
  const heading = title ? (
    <>
      {Icon ? (
        <Icon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      ) : null}
      {title}
    </>
  ) : null
  const titleClass = "flex items-center gap-1.5 text-xs font-medium"
  let titleNode: React.ReactNode = null
  if (heading) {
    if (htmlFor) {
      titleNode = (
        <Label htmlFor={htmlFor} className={cn(titleClass, "leading-normal")}>
          {heading}
        </Label>
      )
    } else if (as === "h3") {
      titleNode = <h3 className={titleClass}>{heading}</h3>
    } else {
      titleNode = <p className={titleClass}>{heading}</p>
    }
  }
  return (
    <div
      className={cn(
        "flex justify-between gap-3",
        description ? "items-start" : "items-center"
      )}
    >
      <div className="min-w-0 space-y-1">
        {titleNode}
        {description ? (
          <p className="text-2xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  )
}

interface AgentPanelGroupProps {
  title?: React.ReactNode
  description?: React.ReactNode
  /** Buttons or links pinned to the right of the title. */
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
}

/** A titled block of an agent's panel. Borderless on purpose — see the module
 *  comment. */
export function AgentPanelGroup({
  title,
  description,
  actions,
  children,
  className,
}: AgentPanelGroupProps) {
  return (
    <section className={cn("space-y-3", className)}>
      <PanelHeader
        as="h3"
        title={title}
        description={description}
        control={actions}
      />
      {children}
    </section>
  )
}

interface AgentPanelCardProps {
  /** Small glyph in front of the title; leave it out when the option has no
   *  natural icon rather than inventing one. */
  icon?: LucideIcon
  title?: React.ReactNode
  /** One line on what the card is for, under the title. */
  description?: React.ReactNode
  htmlFor?: string
  /** Compact control pinned to the right of the title — usually a `Switch`. */
  control?: React.ReactNode
  /** Fields that belong to the same decision, under the header. */
  children?: React.ReactNode
  className?: string
}

/**
 * The one bordered surface inside an agent's panel: no shadow, the panel's own
 * card background, and the shared title/description scale. Holds either a
 * single option (title + description + `control`) or a few related fields
 * (`children`); a sub-part of a card is separated by spacing or a hairline
 * (`border-t pt-3`), never by another frame.
 */
export function AgentPanelCard({
  icon,
  title,
  description,
  htmlFor,
  control,
  children,
  className,
}: AgentPanelCardProps) {
  return (
    <div className={cn("space-y-3 rounded-xl border bg-card p-3", className)}>
      <PanelHeader
        icon={icon}
        title={title}
        description={description}
        htmlFor={htmlFor}
        control={control}
      />
      {children}
    </div>
  )
}

/** Nearest ancestor that scrolls vertically — the panel's scroll area. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    )
      return node
  }
  return null
}

interface AgentPanelSaveBarProps {
  children: React.ReactNode
  /** Layout of the row's contents; defaults to a right-aligned button row. */
  className?: string
}

/**
 * The row holding a section's Save button, pinned to the bottom of the panel's
 * scroll area while the section it saves runs past that edge — so a change
 * made near the top of a long section never leaves its Save scrolled out of
 * sight.
 *
 * `position: sticky` keeps this honest without any bookkeeping: a sticky box
 * cannot leave its parent, so a bar only floats while *its* section spans the
 * bottom edge, and two sibling sections can never stack their bars there. The
 * one rule for callers is to use it only for a section's main Save — a second
 * bar nested inside the same section would pin to the same edge.
 *
 * While pinned it gets a hairline and an opaque backdrop so the content
 * scrolling underneath doesn't show through; in place it looks like the plain
 * row it replaced. The padding is the same in both states, so flipping the
 * style never changes the layout (and can't flip the state back).
 */
export function AgentPanelSaveBar({
  children,
  className,
}: AgentPanelSaveBarProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const root = scrollParentOf(el)
    // Pinned ⇔ the bar sits on the root's bottom edge. Shrinking the root by
    // 1px at the bottom makes a pinned bar report itself as partly hidden; a
    // bar leaving through the *top* edge is partly hidden too, which the
    // position check tells apart.
    const observer = new IntersectionObserver(
      ([entry]) => {
        const bottom = entry.rootBounds?.bottom
        setPinned(
          entry.intersectionRatio > 0 &&
            entry.intersectionRatio < 1 &&
            bottom !== undefined &&
            entry.boundingClientRect.bottom >= bottom
        )
      },
      { root, rootMargin: "0px 0px -1px 0px", threshold: [0, 0.5, 1] }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      data-pinned={pinned ? "" : undefined}
      className={cn(
        "sticky bottom-0 z-10 border-t border-transparent py-2 transition-colors",
        pinned && "border-border bg-card/95 backdrop-blur-sm",
        className ?? "flex justify-end"
      )}
    >
      {children}
    </div>
  )
}
