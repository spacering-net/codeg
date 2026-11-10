"use client"

import {
  Fragment,
  useId,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react"
import { Check, ChevronDown, Cog } from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ModelOptionList } from "@/components/chat/model-option-list"
import { SelectorTooltip } from "@/components/chat/selector-tooltip"
import { useScrollbarSafeDismiss } from "@/hooks/use-scrollbar-safe-dismiss"
import { flattenModelGroups } from "@/lib/model-config-groups"
import type {
  SessionChoiceSetting,
  SessionSetting,
  SessionSettingTarget,
  SessionSwitchSetting,
} from "@/lib/session-settings"
import type { AgentType } from "@/lib/types"
import { cn } from "@/lib/utils"

type OnChange = (target: SessionSettingTarget, value: string) => void

interface SessionSettingsPickerProps {
  agentType: AgentType | null
  /** Ordered by `buildSessionSettings`. Empty → the placeholder, or nothing. */
  settings: SessionSetting[]
  /** While no setting is known yet and they are on their way: the label of
   *  the placeholder held in their place. `null` when nothing is loading. */
  loadingLabel: string | null
  onChange: OnChange
}

/**
 * The composer's agent settings as ONE control: a chip that reads every
 * current value at once ("Opus 5.5 / High / Plan"), opening a popover in which
 * each setting is adjusted in place. A pick applies immediately and the
 * popover stays open, so several settings can be changed in one visit.
 *
 * One dismissable layer only: every control in the popover is a plain button
 * (or the Radix Switch, which is not a layer). Nesting a second Radix layer —
 * a DropdownMenu, a Select, a Tooltip — inside this portal silently drops the
 * selection on WKWebView.
 *
 * The chip fits any composer width on its own: short values never truncate,
 * long ones share the squeeze in proportion to their width, and in a
 * `@container` narrower than 16rem (the chat composer's chrome is one) only the
 * icon is left. A host with no container always shows the values.
 */
export function SessionSettingsPicker({
  agentType,
  settings,
  loadingLabel,
  onChange,
}: SessionSettingsPickerProps) {
  const t = useTranslations("Folder.chat.messageInput")
  const [open, setOpen] = useState(false)
  // Keep the popover open while one of its scrollbars is dragged — see
  // `useScrollbarSafeDismiss`.
  const { contentRef, onPointerDownOutside, onFocusOutside } =
    useScrollbarSafeDismiss()

  // A popover left open over a session that lost its settings would reopen
  // the moment they come back.
  if (open && settings.length === 0) setOpen(false)

  if (settings.length === 0) {
    return loadingLabel ? (
      <SettingsPlaceholder agentType={agentType} label={loadingLabel} />
    ) : null
  }

  // The accessible name carries every setting, including the ones the visible
  // label leaves out (a `default` value, a switch that is off).
  const onLabel = t("toggleOn")
  const offLabel = t("toggleOff")
  const label = `${t("agentSettings")}: ${settings
    .map((setting) => {
      const value =
        setting.kind === "switch"
          ? setting.checked
            ? onLabel
            : offLabel
          : setting.currentLabel
      return `${setting.title} ${value}`
    })
    .join(", ")}`
  const parts = settings.filter((setting) => setting.summary)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Suppressed while the popover is open — it is non-modal, so the chip
          keeps taking hover underneath it (see SelectorTooltip). */}
      <SelectorTooltip label={t("agentSettings")} suppressed={open}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-label={label}
            // A pill tinted with the theme color chosen in Appearance
            // settings (`--primary`), translucent so it also sits over a
            // workspace background image. Hover and the open popover deepen
            // it.
            // An `xs` Button draws every SVG without a `size-*` class at 12px.
            // The agent's mark is one, so it would shrink inside its 14px
            // AgentIcon box, off the line the values are centered on. Hold
            // such SVGs at the box's size.
            className="max-w-full min-w-0 shrink gap-1 bg-primary/10 px-2 text-muted-foreground hover:bg-primary/15 hover:text-foreground aria-expanded:bg-primary/15 aria-expanded:text-foreground dark:hover:bg-primary/15 [&_svg:not([class*='size-'])]:size-3.5"
          >
            <TriggerIcon agentType={agentType} />
            {/* `overflow-hidden`: when even the shortest form of every value
                does not fit, the last ones are cut at the chevron rather
                than drawn underneath it. */}
            <span
              data-slot="settings-summary"
              className="flex min-w-0 items-center overflow-hidden @max-[16rem]:hidden"
            >
              {parts.map((setting, index) => (
                <Fragment key={setting.key}>
                  {index > 0 ? (
                    <span
                      aria-hidden
                      className="shrink-0 px-1 text-muted-foreground/50"
                    >
                      /
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      [...(setting.summary ?? "")].length <= 8
                        ? "shrink-0"
                        : "min-w-12 shrink truncate"
                    )}
                  >
                    {setting.summary}
                  </span>
                </Fragment>
              ))}
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
      </SelectorTooltip>
      <PopoverContent
        ref={contentRef}
        side="top"
        align="start"
        aria-label={t("agentSettings")}
        tabIndex={-1}
        // Focus the panel itself rather than its first control: when that is
        // a search box, focusing it raises the on-screen keyboard on a touch
        // device for a panel opened to flip a switch. Tab moves into it. (The
        // event is dispatched on the content element, Radix's focus scope.)
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.focus({ preventScroll: true })
          }
        }}
        onPointerDownOutside={onPointerDownOutside}
        onFocusOutside={onFocusOutside}
        // `max-h-(--radix-popover-content-available-height)`: the chip sits at
        // the bottom of the composer, so the panel opens upward and scrolls
        // when the room above it is short. `overflow-hidden` keeps the
        // scrollbar inside the rounded corners.
        className="max-h-(--radix-popover-content-available-height) w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden p-0"
      >
        {/* The app's own scrollbar, here and in every list below, like the
            side panel's: a real element inside the content, so grabbing it is
            not a press outside the popover (see `useScrollbarSafeDismiss`).
            `min-h-0 flex-1` shrinks it to the capped height. */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-1.5">
            {settings.map((setting, index) => {
              const previous = settings[index - 1]
              // A rule around each list (it scrolls on its own) and above the
              // switches, which read as a group of their own.
              const separated =
                previous !== undefined &&
                (setting.kind === "list" ||
                  previous.kind === "list" ||
                  (setting.kind === "switch" && previous.kind !== "switch"))
              return (
                <Fragment key={setting.key}>
                  {separated ? (
                    <div aria-hidden className="mx-2 h-px shrink-0 bg-border" />
                  ) : null}
                  {setting.kind === "switch" ? (
                    <SwitchSetting setting={setting} onChange={onChange} />
                  ) : setting.kind === "segmented" ? (
                    <SegmentedSetting setting={setting} onChange={onChange} />
                  ) : (
                    <ListSetting setting={setting} onChange={onChange} />
                  )}
                </Fragment>
              )
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

function TriggerIcon({ agentType }: { agentType: AgentType | null }) {
  return agentType ? (
    <AgentIcon agentType={agentType} className="size-3.5" />
  ) : (
    <Cog className="size-3.5 shrink-0" />
  )
}

/**
 * Stand-in for the chip while the session is still being established. It holds
 * the row open at the chip's height and fill (`h-6`, like `Button size="xs"`)
 * so nothing jumps when the settings arrive, and it is visible where they will
 * be: opening a historical conversation spends seconds in exactly this state,
 * and showing nothing there made a live, still-connecting composer look like a
 * dead one.
 */
function SettingsPlaceholder({
  agentType,
  label,
}: {
  agentType: AgentType | null
  label: string
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      // The Button's transparent border and padding-box fill too, so the two
      // pills are the same size.
      className="flex h-6 shrink-0 items-center gap-1.5 rounded-4xl border border-transparent bg-primary/10 bg-clip-padding px-2"
    >
      <TriggerIcon agentType={agentType} />
      {/* Neutral ink, not the Skeleton's own `bg-muted` (lighter than the
          pill in light mode, so it would all but vanish on it) and not the
          theme color: the bars pulse, and an animated layer can mis-draw an
          out-of-gamut primary (orange's came out cyan in Chrome's software
          compositor). */}
      <Skeleton className="h-3 w-16 rounded-sm bg-foreground/10" />
      <Skeleton className="h-3 w-10 rounded-sm bg-foreground/10" />
    </div>
  )
}

// Roving focus for a group of option buttons: one tab stop per group (the
// current value until the user moves), arrows move focus without committing —
// Enter/Space picks. A radio group would select on focus, and every select
// here is a live session change. Tracked by option key rather than position,
// so an update that reorders the options while the popover is open keeps the
// tab stop on the option that has focus.
function useRovingFocus(keys: string[], currentKey: string | null) {
  const [focused, setFocused] = useState<string | null>(null)
  const stop =
    focused !== null && keys.includes(focused)
      ? focused
      : currentKey !== null && keys.includes(currentKey)
        ? currentKey
        : (keys[0] ?? null)
  return {
    groupProps: {
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const step = arrowStep(event)
        if (step === null) return
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>("[data-roving]")
        )
        const index = items.indexOf(document.activeElement as HTMLElement)
        if (index < 0 || items.length === 0) return
        event.preventDefault()
        const next =
          step === "first"
            ? 0
            : step === "last"
              ? items.length - 1
              : (index + step + items.length) % items.length
        items[next]?.focus()
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        // Leaving the group hands the tab stop back to the current value.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(null)
      },
    },
    itemProps: (key: string) => ({
      "data-roving": "",
      tabIndex: key === stop ? 0 : -1,
      onFocus: () => setFocused(key),
    }),
  }
}

function arrowStep(
  event: KeyboardEvent<HTMLElement>
): number | "first" | "last" | null {
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
  switch (event.key) {
    case "ArrowUp":
      return -1
    case "ArrowDown":
      return 1
    case "ArrowLeft":
      return rtl ? 1 : -1
    case "ArrowRight":
      return rtl ? -1 : 1
    case "Home":
      return "first"
    case "End":
      return "last"
    default:
      return null
  }
}

function SettingHeader({
  id,
  title,
  description,
  aside,
}: {
  id: string
  title: string
  description: string | null
  aside?: string | null
}) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-3 px-2 text-xs font-medium text-muted-foreground">
      <span id={id} className="truncate" title={description ?? undefined}>
        {title}
      </span>
      {aside ? <span className="shrink-0 font-normal">{aside}</span> : null}
    </div>
  )
}

function SegmentedSetting({
  setting,
  onChange,
}: {
  setting: SessionChoiceSetting
  onChange: OnChange
}) {
  const t = useTranslations("Folder.chat.messageInput")
  const headerId = useId()
  // Keyed by group as well: the same value may sit in two server groups.
  const entries = setting.groups.flatMap((group) =>
    group.options.map((option) => ({
      key: `${group.key}:${option.value}`,
      option,
    }))
  )
  const roving = useRovingFocus(
    entries.map((entry) => entry.key),
    entries.find((entry) => entry.option.value === setting.currentValue)?.key ??
      null
  )
  const recommended = entries.find(
    (entry) => entry.option.value === setting.recommendedValue
  )?.option
  return (
    <div className="flex shrink-0 flex-col pb-1">
      <SettingHeader
        id={headerId}
        title={setting.title}
        description={setting.description}
        aside={
          recommended
            ? t("recommendedValue", { value: recommended.name })
            : null
        }
      />
      <div
        role="group"
        aria-labelledby={headerId}
        {...roving.groupProps}
        className="mx-1 flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.5 dark:bg-muted/60"
      >
        {entries.map(({ key, option }) => {
          const pressed = option.value === setting.currentValue
          return (
            <button
              key={key}
              type="button"
              aria-pressed={pressed}
              title={option.description || option.name}
              {...roving.itemProps(key)}
              onClick={() => {
                if (!pressed) onChange(setting.target, option.value)
              }}
              className="h-6 min-w-0 flex-auto truncate rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm dark:aria-pressed:bg-input/60"
            >
              {option.name}
            </button>
          )
        })}
      </div>
      {setting.currentDescription ? (
        <p className="mt-1 px-2 text-xs leading-snug text-muted-foreground">
          {setting.currentDescription}
        </p>
      ) : null}
    </div>
  )
}

function ListSetting({
  setting,
  onChange,
}: {
  setting: SessionChoiceSetting
  onChange: OnChange
}) {
  const t = useTranslations("Folder.chat.messageInput")
  const headerId = useId()
  const commit = (value: string) => {
    if (value !== setting.currentValue) onChange(setting.target, value)
  }
  if (setting.searchable) {
    return (
      <div className="flex min-h-0 shrink-0 flex-col">
        <SettingHeader
          id={headerId}
          title={setting.title}
          description={setting.description}
        />
        <ModelOptionList
          groups={setting.groups}
          currentValue={setting.currentValue}
          recommendedValue={setting.recommendedValue}
          recommendedLabel={t("recommendedBadge")}
          onSelect={commit}
          searchPlaceholder={
            setting.isModel ? t("searchModel") : t("searchOptions")
          }
          searchAriaLabel={
            setting.isModel ? t("searchModelAria") : t("searchOptionsAria")
          }
          listAriaLabel={setting.title}
          emptyLabel={setting.isModel ? t("noModels") : t("noOptions")}
          maxHeightRem={13}
        />
      </div>
    )
  }
  return (
    <PlainList
      setting={setting}
      headerId={headerId}
      recommendedLabel={t("recommendedBadge")}
      onPick={commit}
    />
  )
}

function PlainList({
  setting,
  headerId,
  recommendedLabel,
  onPick,
}: {
  setting: SessionChoiceSetting
  headerId: string
  recommendedLabel: string
  onPick: (value: string) => void
}) {
  const rows = flattenModelGroups(setting.groups)
  const options = rows.flatMap((row) => (row.kind === "option" ? [row] : []))
  const roving = useRovingFocus(
    options.map((row) => row.key),
    options.find((row) => row.option.value === setting.currentValue)?.key ??
      null
  )
  return (
    <div className="flex min-h-0 shrink-0 flex-col">
      <SettingHeader
        id={headerId}
        title={setting.title}
        description={setting.description}
      />
      {/* Capped and scrolling on its own, so a long list never pushes the
          settings below it out of the panel. */}
      <ScrollArea className="max-h-52 shrink-0">
        <div
          role="group"
          aria-labelledby={headerId}
          {...roving.groupProps}
          className="flex flex-col gap-0.5"
        >
          {rows.map((row, rowIndex) => {
            if (row.kind === "header") {
              return (
                <div
                  key={row.key}
                  role="presentation"
                  className={cn(
                    "shrink-0 truncate px-2 pb-0.5 text-xs font-medium text-muted-foreground",
                    rowIndex === 0 ? "pt-0.5" : "mt-1 border-t pt-2"
                  )}
                >
                  {row.name}
                </div>
              )
            }
            const { option } = row
            const selected = option.value === setting.currentValue
            return (
              <button
                key={row.key}
                type="button"
                aria-current={selected ? "true" : undefined}
                title={
                  option.description
                    ? `${option.name} — ${option.description}`
                    : option.name
                }
                {...roving.itemProps(row.key)}
                onClick={() => onPick(option.value)}
                className={cn(
                  "flex w-full shrink-0 items-start gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                  selected && "bg-accent/60"
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                  {selected ? <Check className="size-4" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate">{option.name}</span>
                    {option.value === setting.recommendedValue ? (
                      <Badge
                        variant="outline"
                        className="px-1 text-3xs font-normal"
                      >
                        {recommendedLabel}
                      </Badge>
                    ) : null}
                  </span>
                  {option.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

function SwitchSetting({
  setting,
  onChange,
}: {
  setting: SessionSwitchSetting
  onChange: OnChange
}) {
  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`
  return (
    // The whole row is the switch's label, so it toggles from anywhere on it.
    <label
      htmlFor={id}
      className="flex shrink-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted dark:hover:bg-muted/50"
    >
      <span className="min-w-0 flex-1">
        <span id={titleId} className="block text-sm">
          {setting.title}
        </span>
        {setting.description ? (
          <span
            id={descriptionId}
            className="block text-xs leading-snug text-muted-foreground"
          >
            {setting.description}
          </span>
        ) : null}
      </span>
      <Switch
        id={id}
        checked={setting.checked}
        aria-labelledby={titleId}
        aria-describedby={setting.description ? descriptionId : undefined}
        onCheckedChange={(next) =>
          onChange(setting.target, next ? setting.onValue : setting.offValue)
        }
      />
    </label>
  )
}
