"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { MoreHorizontal } from "lucide-react"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import type { AgentType, AcpAgentInfo } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { AgentIcon } from "@/components/agent-icon"
import { SelectorTooltip } from "@/components/chat/selector-tooltip"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// Matches the local idiom in `use-reference-search.ts` / `suggestion-popup.tsx`:
// measure before paint in the browser, fall back to `useEffect` on the static
// prerender where `useLayoutEffect` would warn.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

// How much wider the selected pill is than an icon-only one, from padding
// alone (`px-3` vs `px-2`, both sides). The fit math needs the selected pill's
// SETTLED width, but its padding is animated (`transition-all`), so measuring
// the live box mid-transition would report a too-narrow pill and briefly admit
// one agent too many. Deriving it — icon-only width + this + the label's
// natural text width — is stable from the first frame. Keep in step with the
// `px-3` / `px-2` pair below if either changes.
const SELECTED_PADDING_EXTRA = 8

interface AgentSelectorProps {
  defaultAgentType?: AgentType
  /** Fires on user click. The caller should treat this as confirmation. */
  onSelect: (agentType: AgentType) => void
  /**
   * Fires when `defaultAgentType` is missing/unavailable and the selector
   * had to pick a substitute on its own. Distinct from `onSelect` so the
   * caller can avoid promoting a system pick to a confirmed user choice
   * (which would otherwise mask a stale-default correction upstream).
   * When omitted, falls back to `onSelect` for backwards compatibility.
   */
  onFallback?: (agentType: AgentType) => void
  onAgentsLoaded?: (agents: AcpAgentInfo[]) => void
  onOpenAgentsSettings?: () => void
  /** Lock a bound conversation; draft pickers stay usable during startup. */
  disabled?: boolean
  /**
   * Where the pill sits inside the row it is given. The selector now spans the
   * full available width (it has to, to know how much room it has — see the
   * wrapper below), so a caller that used to centre it with `justify-center`
   * on its own container has to push that intent down here instead.
   */
  align?: "start" | "center"
}

/** `parseFloat` for computed styles, with a 0 for `""` / `auto` / NaN. */
function px(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

export function AgentSelector({
  defaultAgentType,
  onSelect,
  onFallback,
  onAgentsLoaded,
  onOpenAgentsSettings,
  disabled = false,
  align = "start",
}: AgentSelectorProps) {
  const t = useTranslations("Folder.chat.agentSelector")
  const { agents: rawAgents } = useAcpAgents()
  const agents = useMemo<AcpAgentInfo[]>(
    () => rawAgents.filter((a) => a.enabled),
    [rawAgents]
  )
  const onSelectRef = useRef(onSelect)
  const onFallbackRef = useRef(onFallback)
  const onAgentsLoadedRef = useRef(onAgentsLoaded)

  // Effective selection. Priority: prop default (when still available) →
  // first available. Derived so we don't have to call setState inside an
  // effect. Click handling lives on the parent — `handleSelect` just
  // forwards via `onSelect`, which patches `defaultAgentType` upstream.
  const selected = useMemo<AgentType | null>(() => {
    const found = defaultAgentType
      ? agents.find((a) => a.agent_type === defaultAgentType && a.available)
      : null
    if (found) return found.agent_type
    const first = agents.find((a) => a.available)
    return first?.agent_type ?? null
  }, [agents, defaultAgentType])

  // Sliding indicator state
  const wrapperRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<AgentType, HTMLButtonElement>>(new Map())
  const moreRef = useRef<HTMLButtonElement>(null)
  const selectedLabelRef = useRef<HTMLSpanElement>(null)
  // Width of one icon-only pill. Identical for every agent (fixed padding
  // around a 16px mark), so one sample sizes the whole row — and it has to be
  // remembered, because once the row collapses to just the selected pill there
  // is nothing left to sample.
  const unitWidthRef = useRef(0)
  const [indicator, setIndicator] = useState<{
    left: number
    width: number
  } | null>(null)
  // How many NON-selected agents the row has room for. `null` = everything
  // fits (or we couldn't measure — see `measure`), which is also the first
  // render, so the natural widths are always available for that first sample.
  const [visibleOtherCount, setVisibleOtherCount] = useState<number | null>(
    null
  )
  const [moreOpen, setMoreOpen] = useState(false)

  // The row as rendered, plus what got pushed into the "more" popover.
  // The selected agent is never pushed out: it keeps its place in the running
  // order, so when it sits past the cut it simply lands at the end of the row
  // (ahead of the ⋯ button) — picking an agent from the popover always leaves
  // it visible, named, and wearing the droplet.
  const { visible, hidden } = useMemo(() => {
    if (visibleOtherCount === null) {
      return { visible: agents, hidden: [] as AcpAgentInfo[] }
    }
    const visible: AcpAgentInfo[] = []
    const hidden: AcpAgentInfo[] = []
    let taken = 0
    for (const agent of agents) {
      if (agent.agent_type === selected) {
        visible.push(agent)
      } else if (taken < visibleOtherCount) {
        visible.push(agent)
        taken += 1
      } else {
        hidden.push(agent)
      }
    }
    return { visible, hidden }
  }, [agents, selected, visibleOtherCount])

  // One pass, two answers: how many pills fit, and where the droplet goes.
  // Both read the same boxes, and the fit result changes those boxes, so
  // splitting them would just make the two measurements disagree for a frame.
  //
  // ⚠️ Every measurement here is LAYOUT px (`offsetWidth` / `offsetLeft`), never
  // `getBoundingClientRect()`. The rects are in SCREEN px — scaled by any CSS
  // transform above us — while `scrollWidth` below (the label's natural width)
  // is not, so mixing the two makes the fit arithmetic wrong the moment this
  // selector is rendered inside something scaled. The infinite-conversation
  // canvas does exactly that: a card at 60% zoom compared a shrunken `inner`
  // against a full-size `labelWidth` and collapsed the row, and the droplet —
  // positioned with screen px inside the scaled subtree — sat off its pill
  // entirely. `offsetWidth`/`offsetLeft` are transform-independent, which also
  // covers the app's own zoom control rewriting the root font-size.
  const measure = useCallback(() => {
    const wrapper = wrapperRef.current
    const frame = frameRef.current
    if (!wrapper || !frame) return

    // --- how many pills fit ---
    // The wrapper is a size-containment context (`@container`), so its width
    // is handed down by the layout and never reflects what we put inside it.
    // That is what makes this loop converge: dropping a pill narrows the frame
    // but leaves `outer` untouched.
    const outer = wrapper.offsetWidth
    let unit = 0
    let samples = 0
    for (const [agentType, el] of itemRefs.current) {
      if (agentType === selected) continue
      const width = el.offsetWidth
      // Smallest sample wins: a pill that was just deselected is still
      // shrinking out of its label, and its in-flight width would overstate
      // how much room its settled siblings need.
      if (width > 0) {
        unit = unit > 0 ? Math.min(unit, width) : width
        samples += 1
      }
    }
    // Only the just-deselected pill animates, so with two or more samples the
    // minimum is necessarily a settled pill. With exactly one, that sample MAY
    // be the shrinking pill — take it only when it doesn't grow the cache,
    // because an over-large unit is the one error that can't heal itself: it
    // collapses the row, which removes the very samples a correction needs.
    // Under-estimating is self-healing (too many pills = more samples).
    const cached = unitWidthRef.current
    if (unit > 0 && (samples > 1 || cached === 0 || unit <= cached)) {
      unitWidthRef.current = unit
    } else {
      unit = cached
    }

    const style = window.getComputedStyle(frame)
    const inner =
      outer -
      px(style.paddingLeft) -
      px(style.paddingRight) -
      px(style.borderLeftWidth) -
      px(style.borderRightWidth)
    // `scrollWidth` is the label's natural text width — unaffected by the
    // `grid-cols-[0fr→1fr]` reveal animation wrapping it.
    const labelWidth = selectedLabelRef.current?.scrollWidth ?? 0
    const selectedWidth = unit + SELECTED_PADDING_EXTRA + labelWidth
    const others = agents.length - (selected ? 1 : 0)

    // Nothing measurable (jsdom, a display:none ancestor, first paint before
    // layout): show every agent rather than guess a cut. Collapsing on a bad
    // number would hide agents that had room all along.
    let next: number | null
    if (outer <= 0 || unit <= 0) {
      next = null
    } else if (selectedWidth + others * unit <= inner) {
      next = null
    } else {
      const moreWidth = moreRef.current?.offsetWidth || unit
      const fits = Math.floor((inner - selectedWidth - moreWidth) / unit)
      next = Math.max(0, Math.min(others, fits))
    }
    setVisibleOtherCount(next)
    // Nothing left to collapse. Close the popover instead of leaving `moreOpen`
    // latched: the Popover unmounts with the last hidden agent, so it only
    // *looks* closed, and a later narrowing would re-mount it already open —
    // a menu the user never asked for.
    if (next === null || next >= others) setMoreOpen(false)

    // --- droplet position ---
    const btn = selected ? itemRefs.current.get(selected) : null
    if (!btn) {
      setIndicator(null)
      return
    }
    // `offsetLeft` is already relative to the frame: it is `position: relative`,
    // making it the offsetParent of every pill.
    setIndicator({
      left: btn.offsetLeft,
      width: btn.offsetWidth,
    })
  }, [agents.length, selected])

  // Measure before the first paint so the row is never shown mid-collapse.
  useIsomorphicLayoutEffect(() => {
    measure()
  }, [measure, visible])

  // Re-measure as the boxes change: buttons resize through the droplet's
  // 300ms transition, and the wrapper resizes when the window, sidebar or
  // dialog around it does.
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || typeof ResizeObserver === "undefined") return

    const ro = new ResizeObserver(() => measure())
    for (const btn of itemRefs.current.values()) ro.observe(btn)
    if (moreRef.current) ro.observe(moreRef.current)
    ro.observe(wrapper)

    const onResize = () => measure()
    window.addEventListener("resize", onResize)

    return () => {
      ro.disconnect()
      window.removeEventListener("resize", onResize)
    }
  }, [measure, visible])

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    onFallbackRef.current = onFallback
  }, [onFallback])

  useEffect(() => {
    onAgentsLoadedRef.current = onAgentsLoaded
  }, [onAgentsLoaded])

  // Notify parent when the agent list changes, and emit a *fallback* event
  // (not onSelect) when the requested preferred agent is unavailable and
  // we had to pick a substitute. Splitting the channel matters: the caller
  // treats `onSelect` as a confirmed user choice and clears any "this is a
  // provisional default" flag upstream — if the auto-fallback came through
  // the same path, a hydrated draft whose old agent is now disabled would
  // be silently locked onto sortedTypes[0] before TabProvider's correction
  // effect has a chance to apply the folder's saved default. Callers that
  // don't supply `onFallback` get the legacy behavior (fallback as
  // onSelect) so this prop stays optional.
  useEffect(() => {
    onAgentsLoadedRef.current?.(agents)
    const found = defaultAgentType
      ? agents.find((a) => a.agent_type === defaultAgentType && a.available)
      : null
    if (found) return
    const first = agents.find((a) => a.available)
    if (!first) return
    const fallback = onFallbackRef.current
    if (fallback) {
      fallback(first.agent_type)
    } else {
      onSelectRef.current(first.agent_type)
    }
  }, [agents, defaultAgentType])

  const handleSelect = (agentType: AgentType) => {
    onSelect(agentType)
  }

  const setItemRef = useCallback(
    (agentType: AgentType) => (el: HTMLButtonElement | null) => {
      if (el) {
        itemRefs.current.set(agentType, el)
      } else {
        itemRefs.current.delete(agentType)
      }
    },
    []
  )

  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-3 text-center text-sm text-muted-foreground">
        <div>{t("noEnabledAgents")}</div>
        {onOpenAgentsSettings ? (
          <button
            type="button"
            onClick={onOpenAgentsSettings}
            className="mt-2 inline-flex items-center rounded-md border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent cursor-pointer"
          >
            {t("openAgentsSettings")}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    // `@container` is load-bearing, not decoration. It gives this box inline
    // size containment, which is the ONLY thing that stops a long agent row
    // from inflating everything above it: `min-w-0` and `overflow-hidden` both
    // leave the pills' min-content size propagating up, and in a Dialog (a
    // `grid` whose `overflow-y-auto` makes `overflow-x` compute to `auto`) that
    // widened the whole dialog and gave it a horizontal scrollbar. Verified in
    // both engines — Chromium and the WKWebView the desktop app actually runs.
    // It also means our own width never feeds back into the fit math below.
    <div
      ref={wrapperRef}
      data-slot="agent-selector"
      className={cn(
        "@container flex min-w-0 flex-1 items-center",
        align === "center" && "justify-center"
      )}
    >
      <div
        ref={frameRef}
        className="relative inline-flex max-w-full items-center overflow-hidden rounded-full bg-muted/50 p-0.5 border border-border/50"
      >
        {/* Sliding droplet indicator */}
        {indicator && (
          <div
            className="absolute top-0.5 bottom-0.5 rounded-full bg-background shadow-sm ring-1 ring-border/50 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
            style={{
              left: indicator.left,
              width: indicator.width,
            }}
          />
        )}
        {visible.map((agent) => {
          const isSelected = selected === agent.agent_type
          // Enabled + platform-available, but the CLI/SDK isn't installed. Kept
          // clickable (selecting it surfaces a persistent install prompt in the
          // composer) but flagged with a marker + tooltip so it reads as "needs
          // install" instead of looking identical to a ready agent.
          const notInstalled = agent.available && !agent.installed_version
          const label = getAgentLabel(agent.agent_type)
          return (
            // A collapsed pill is icon-only, so the hint names it; the selected
            // one already spells its name out and only gets a hint when there
            // is something extra to say. `disabled` (a platform-unavailable
            // agent) falls back to a native `title`: those pills are the
            // icon-only ones that most need naming, and a disabled element
            // takes no pointer events.
            <SelectorTooltip
              key={agent.agent_type}
              label={notInstalled || !isSelected ? label : null}
              description={notInstalled ? t("notInstalled") : null}
              disabled={disabled || !agent.available}
            >
              <button
                ref={setItemRef(agent.agent_type)}
                data-slot="agent-pill"
                aria-pressed={isSelected}
                disabled={disabled || !agent.available}
                onClick={() => handleSelect(agent.agent_type)}
                className={cn(
                  // `shrink-0` keeps every pill at its natural width. Without it
                  // a row that briefly overflows (the frame before the first
                  // measurement, or a window narrower than a single pill) gets
                  // squeezed by flexbox, and since the label below is
                  // `min-w-0 overflow-hidden` the SELECTED agent's name is the
                  // first thing to be crushed to zero — the one label the row
                  // exists to show.
                  "relative z-10 inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-all duration-300",
                  isSelected ? "px-3 py-2" : "px-2 py-2",
                  disabled || !agent.available
                    ? "cursor-not-allowed opacity-40"
                    : "cursor-pointer",
                  isSelected
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground/70"
                )}
              >
                {/* `inline-flex` is load-bearing, not decoration: as a bare
                    inline box this wrapper would lay its icon out on a text
                    baseline, so the strut's descender (~4px at text-xs/Inter)
                    hung below the 16px mark and made the wrapper 20px tall. The
                    row's `items-center` then centered *that* box, parking every
                    icon 2px above the pill's true center while the label — a
                    grid item with no strut — sat dead center. Making the wrapper
                    a flex container drops the line box entirely: its height is
                    the icon's, so icon and label share one centerline. Keep it a
                    flex box if this markup is ever touched. */}
                <span className="relative inline-flex shrink-0 items-center">
                  <AgentIcon agentType={agent.agent_type} className="h-4 w-4" />
                  {notInstalled ? (
                    <span
                      aria-hidden
                      className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-500 ring-1 ring-background"
                    />
                  ) : null}
                </span>
                <span
                  className={cn(
                    "grid transition-[grid-template-columns] duration-300",
                    isSelected ? "grid-cols-[1fr]" : "grid-cols-[0fr]"
                  )}
                >
                  <span
                    ref={isSelected ? selectedLabelRef : undefined}
                    className={cn(
                      "min-w-0 overflow-hidden whitespace-nowrap transition-opacity duration-300",
                      isSelected ? "opacity-100" : "opacity-0"
                    )}
                  >
                    {label}
                  </span>
                </span>
              </button>
            </SelectorTooltip>
          )
        })}
        {hidden.length > 0 ? (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <SelectorTooltip
              label={t("moreAgents", { count: hidden.length })}
              suppressed={moreOpen}
              disabled={disabled}
            >
              <PopoverTrigger asChild>
                <button
                  ref={moreRef}
                  type="button"
                  data-slot="agent-selector-more"
                  disabled={disabled}
                  aria-label={t("moreAgents", { count: hidden.length })}
                  className={cn(
                    "relative z-10 inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full px-2 py-2 text-muted-foreground transition-colors",
                    "hover:text-foreground/70",
                    // Driven off `moreOpen`, NOT `data-[state=open]`: the
                    // wrapping TooltipTrigger's own `data-state` lands on this
                    // button and shadows the Popover's (see SelectorTooltip).
                    moreOpen && "bg-background/70 text-foreground",
                    disabled && "cursor-not-allowed opacity-40"
                  )}
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                </button>
              </PopoverTrigger>
            </SelectorTooltip>
            <PopoverContent
              align="end"
              className="w-56 gap-0.5 p-1"
              aria-label={t("moreAgents", { count: hidden.length })}
            >
              {hidden.map((agent) => {
                const notInstalled = agent.available && !agent.installed_version
                const label = getAgentLabel(agent.agent_type)
                return (
                  <button
                    key={agent.agent_type}
                    type="button"
                    data-slot="agent-option"
                    disabled={disabled || !agent.available}
                    title={
                      notInstalled
                        ? `${label} · ${t("notInstalled")}`
                        : undefined
                    }
                    onClick={() => {
                      setMoreOpen(false)
                      handleSelect(agent.agent_type)
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      disabled || !agent.available
                        ? "cursor-not-allowed opacity-40"
                        : "cursor-pointer hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    <span className="relative flex shrink-0 items-center">
                      <AgentIcon
                        agentType={agent.agent_type}
                        className="h-4 w-4"
                      />
                      {notInstalled ? (
                        <span
                          aria-hidden
                          className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-500 ring-1 ring-background"
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                  </button>
                )
              })}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </div>
  )
}
