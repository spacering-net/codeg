"use client"

/** A view's title that picks what it shows, centred on a soft pill — deeper
 *  when hovered or open: its name, how many it holds and a chevron — a menu of the choices, each with its count — and, while one
 *  other than the first is picked, a round × that goes back to it (unless
 *  there is no first to go back to). */

import { ChevronDown, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface ViewChoice<V extends string> {
  value: V
  /** In the menu. */
  label: string
  /** On the title, when picked; the label by default. */
  title?: string
  /** `null`: not known yet. */
  count: number | null
}

export function ViewSelect<V extends string>({
  value,
  choices,
  onChange,
  menuLabel,
  clearLabel,
  clearable = true,
  itemAttr,
}: {
  value: V
  /** The first is where × goes back to. */
  choices: readonly ViewChoice<V>[]
  onChange: (value: V) => void
  /** The menu's name, for a screen reader. */
  menuLabel: string
  clearLabel: string
  /** Whether the round × shows (a range has no "all" to go back to). */
  clearable?: boolean
  /** A data attribute each choice carries, for the page's tests. */
  itemAttr?: string
}) {
  const picked = choices.find((c) => c.value === value) ?? choices[0]
  const first = choices[0]
  const title = picked.title ?? picked.label
  return (
    // The pill in the middle, the × after it: the pill stays centred
    // whether or not the × shows.
    <div className="grid h-8 min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${menuLabel}: ${title}`}
            className="col-start-2 flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-muted/60 px-3 text-start transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-muted"
          >
            <span className="min-w-0 truncate text-[0.9375rem] font-semibold text-foreground">
              {title}
            </span>
            {picked.count != null ? (
              <span className="shrink-0 text-[0.8125rem] text-muted-foreground tabular-nums">
                {picked.count}
              </span>
            ) : null}
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(v) => onChange(v as V)}
          >
            {choices.map((c) => (
              <DropdownMenuRadioItem
                key={c.value}
                value={c.value}
                {...(itemAttr ? { [itemAttr]: c.value } : {})}
              >
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.count != null ? (
                  <span className="ms-4 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {c.count}
                  </span>
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {clearable && value !== first.value ? (
        <Button
          size="icon-xs"
          variant="secondary"
          className="col-start-3 shrink-0 justify-self-start rounded-full text-muted-foreground"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => onChange(first.value)}
        >
          <X aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}
