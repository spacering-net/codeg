"use client"

import { useState } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { DropdownRadioItemContent } from "@/components/chat/dropdown-radio-item-content"
import { ModelOptionList } from "@/components/chat/model-option-list"

// One selectable value within a setting (e.g. a single model or mode).
export interface SessionSelectorOption {
  value: string
  name: string
  description?: string | null
}

// A visual group of options. `name === null` renders the options ungrouped
// (the flat / single-group case); a non-null name renders a small header.
export interface SessionSelectorGroup {
  key: string
  name: string | null
  options: SessionSelectorOption[]
}

// Localized labels for the searchable/virtualized list (long model lists).
export interface SessionSelectorSearch {
  placeholder: string
  inputLabel: string
  listLabel: string
  empty: string
}

// One setting shown in the left rail (a config option, or the mode picker).
export interface SessionSelectorSetting {
  key: string
  title: string
  currentValue: string
  currentLabel: string
  groups: SessionSelectorGroup[]
  /** The value the agent recommends (ACP `recommendedValue`), badged wherever it
   *  appears in this setting's list. Absent for settings that carry no hint. */
  recommendedValue?: string | null
  onSelect: (value: string) => void
  /** When set, the detail pane renders a searchable + virtualized list instead
   *  of the plain button list — used for long model lists that otherwise jank. */
  search?: SessionSelectorSearch
}

interface SessionSelectorsPanelProps {
  settings: SessionSelectorSetting[]
  /** Accessible label for the left-hand settings rail. */
  settingsLabel: string
  /** Localized chip text for a setting's `recommendedValue` row. One label for
   *  the whole panel — omit it and no recommendation is shown anywhere. */
  recommendedLabel?: string
  /** Invoked after a value is chosen (used to close the surrounding popover). */
  onAfterSelect?: () => void
}

// Master–detail picker for the collapsed agent settings.
//
// WHY this shape: on WKWebView, nesting a second Radix dismissable layer (a
// `DropdownMenu`/submenu) inside the cog layer's portal silently drops the
// selection — the value never changes. The branch dropdown and the wide inline
// selectors work precisely because they are never nested. So instead of a second
// menu, every option here is a plain `<button>`: a native click always fires,
// and the whole picker lives inside the single cog popover (one layer only).
//
// Left rail = the settings (title + current value, left-aligned). Right pane =
// the active setting's options. Selecting commits immediately and closes.
export function SessionSelectorsPanel({
  settings,
  settingsLabel,
  recommendedLabel,
  onAfterSelect,
}: SessionSelectorsPanelProps) {
  // `activeKey` is only a hint — the active setting is always resolved against
  // the current `settings`, so it stays valid if the list changes underneath.
  const [activeKey, setActiveKey] = useState<string | null>(null)

  if (settings.length === 0) return null
  const active = settings.find((s) => s.key === activeKey) ?? settings[0]
  // The active setting's recommendation, only when there is a label to show it
  // with. `undefined` never equals an option value, so no row is badged.
  const recommendedValue = recommendedLabel ? active.recommendedValue : null

  return (
    <div className="flex max-h-[min(60vh,24rem)] min-h-0">
      {/* Left rail: one row per setting, title over current value. */}
      <div
        role="group"
        aria-label={settingsLabel}
        className="flex w-36 shrink-0 flex-col gap-0.5 overflow-y-auto border-r pr-1"
      >
        {settings.map((setting) => {
          const isActive = setting.key === active.key
          return (
            <button
              key={setting.key}
              type="button"
              aria-current={isActive ? "true" : undefined}
              title={setting.title}
              onClick={() => setActiveKey(setting.key)}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                isActive && "bg-accent text-accent-foreground"
              )}
            >
              <span className="w-full truncate text-sm font-medium">
                {setting.title}
              </span>
              <span
                className={cn(
                  "w-full truncate text-xs",
                  isActive
                    ? "text-accent-foreground/80"
                    : "text-muted-foreground"
                )}
              >
                {setting.currentLabel}
              </span>
            </button>
          )
        })}
      </div>

      {/* Right pane: the active setting's options (the "sub-options").
          Each option is a plain <button>, not a role="radio"/native radio: this
          picker commits-and-closes on choose, which is *menu* semantics, whereas
          a radio group selects-on-focus — arrow-keying a radio would commit and
          close on every keypress. The correct widget (a Radix menu) is the very
          portal/dismissable-layer that drops the selection on WKWebView, which is
          the bug we're fixing. So: plain buttons (full native Tab/Enter/Space
          operability) with `aria-current` marking the chosen value — the same,
          honest pattern as the left rail. */}
      {active.search ? (
        // Long model lists: a searchable + virtualized list (its own scroller),
        // so no surrounding `overflow-y-auto` wrapper here.
        <div className="flex min-w-0 flex-1 flex-col pl-1">
          <ModelOptionList
            groups={active.groups}
            currentValue={active.currentValue}
            recommendedValue={recommendedValue}
            recommendedLabel={recommendedLabel}
            onSelect={(value) => {
              active.onSelect(value)
              onAfterSelect?.()
            }}
            searchPlaceholder={active.search.placeholder}
            searchAriaLabel={active.search.inputLabel}
            listAriaLabel={active.search.listLabel}
            emptyLabel={active.search.empty}
          />
        </div>
      ) : (
        <div
          role="group"
          aria-label={active.title}
          className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto pl-1"
        >
          {active.groups.map((group, groupIndex) => (
            <div key={group.key} className="flex flex-col gap-0.5">
              {group.name ? (
                <div
                  className={cn(
                    "truncate px-2 pb-0.5 text-xs font-medium text-muted-foreground",
                    groupIndex === 0 ? "pt-1" : "mt-1 border-t pt-2"
                  )}
                >
                  {group.name}
                </div>
              ) : null}
              {group.options.map((opt) => {
                const selected = opt.value === active.currentValue
                return (
                  <button
                    key={`${group.key}-${opt.value}`}
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    title={opt.name}
                    onClick={() => {
                      active.onSelect(opt.value)
                      onAfterSelect?.()
                    }}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      selected && "bg-accent/60"
                    )}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                      {selected ? <Check className="size-4" /> : null}
                    </span>
                    <DropdownRadioItemContent
                      label={opt.name}
                      description={opt.description}
                      recommendedLabel={
                        opt.value === recommendedValue ? recommendedLabel : null
                      }
                    />
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
