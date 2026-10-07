"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SelectorTooltip } from "@/components/chat/selector-tooltip"
import { cn } from "@/lib/utils"
import type {
  AgentOptionsSnapshot,
  AgentType,
  SessionConfigOptionInfo,
} from "@/lib/types"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"

// Picking this clears the override (inherit the agent's own default). Mirrors
// delegation-agent-defaults.tsx; the codeg prefix avoids colliding with a real
// option id.
const DEFAULT_SENTINEL = "__codeg_default__"

interface AgentConfigSectionProps {
  /** Probe result, owned by the parent (so a single probe also feeds the `/`
   *  command menu). Null while loading / on error / before the first probe. */
  snapshot: AgentOptionsSnapshot | null
  /** Which agent the snapshot came from. Only used to localise the agent's own
   *  mode / option vocabulary (see `lib/agent-label-vocabulary`); optional so a
   *  caller without it keeps verbatim rendering. */
  agentType?: AgentType | null
  loading: boolean
  error: string | null
  onReload: () => void
  modeId: string | null
  configValues: Record<string, string>
  onModeChange: (modeId: string | null) => void
  onConfigChange: (optionId: string, valueId: string | null) => void
  /** "stacked" (default) renders the labeled card used in standalone forms;
   *  "inline" renders compact label-less select chips that sit in the
   *  composer-style editor's bottom bar. */
  layout?: "stacked" | "inline"
}

/**
 * The composer's model / mode / permission config surface. The probe is owned
 * by the parent (`useAgentOptions`) and passed in, so the editor runs a single
 * transient session that feeds both these selectors and the `/` command menu.
 * The model is one of the config options (id/category "model"); no special-casing.
 */
export function AgentConfigSection({
  snapshot,
  loading,
  error,
  onReload,
  modeId,
  configValues,
  onModeChange,
  onConfigChange,
  layout = "stacked",
  agentType,
}: AgentConfigSectionProps) {
  const t = useTranslations("Automations")
  const vocabulary = useAgentVocabulary(agentType)
  const inline = layout === "inline"

  if (loading) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground",
          // Inline shares the composer's bottom bar with the "+" button: hold
          // the same 24px the chips will occupy so the bar neither jumps nor
          // leaves this line sitting lower than the "+" while the probe runs.
          inline && "h-6"
        )}
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {t("probing")}
      </div>
    )
  }
  if (error) {
    // Same 24px line in the composer bar — a stacked message plus a full-size
    // button would double the bottom bar's height on a failed probe.
    if (inline) {
      return (
        <div className="flex h-6 min-w-0 items-center gap-2">
          <p
            className="min-w-0 truncate text-xs text-destructive"
            title={error}
          >
            {error}
          </p>
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0"
            onClick={onReload}
          >
            {t("retry")}
          </Button>
        </div>
      )
    }
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-xs text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={onReload}>
          {t("retry")}
        </Button>
      </div>
    )
  }
  if (!snapshot) return null

  const hasModes = !!snapshot.modes && snapshot.modes.available_modes.length > 0
  const hasOptions = snapshot.config_options.length > 0
  if (!hasModes && !hasOptions) {
    // Inline lives in the composer bottom bar — stay silent rather than print a
    // sentence there; the stacked form still surfaces the hint.
    if (inline) return null
    return <p className="text-xs text-muted-foreground">{t("configNone")}</p>
  }
  // Mirror the composer: when an agent exposes both modes AND config options,
  // hide the standalone mode row (some agents surface mode as a config option).
  const showMode = hasModes && !hasOptions

  return (
    <div
      className={cn(
        inline
          ? "flex flex-wrap items-center gap-x-3 gap-y-1.5"
          : "flex flex-col gap-2.5 rounded-lg border border-border bg-card/40 p-3"
      )}
    >
      {showMode && snapshot.modes ? (
        <FlatSelect
          label={t("mode")}
          value={modeId}
          inheritLabel={t("inherit")}
          inline={inline}
          allowInherit={!inline}
          currentValue={snapshot.modes.current_mode_id}
          onChange={onModeChange}
          items={vocabulary.modes(snapshot.modes.available_modes).map((m) => ({
            value: m.id,
            name: m.name,
            description: m.description,
          }))}
        />
      ) : null}
      {snapshot.config_options.map((option) => (
        <ConfigOptionRow
          key={option.id}
          option={vocabulary.configOption(option)}
          value={configValues[option.id] ?? null}
          inheritLabel={t("inherit")}
          inline={inline}
          allowInherit={!inline}
          onChange={(v) => onConfigChange(option.id, v)}
        />
      ))}
    </div>
  )
}

/**
 * Mirror of `FieldRow.selectValue` (`value ?? currentValue`) applied across a
 * whole snapshot: the concrete selections the inline (no-inherit) config bar is
 * *displaying*. The editor saves these so a saved automation pins exactly what
 * the user saw — an untouched option persists the agent's current value rather
 * than an empty override that would silently inherit a future default.
 *
 * Kept right beside `FieldRow` so the display rule and the save rule can't drift.
 */
export function effectiveSelections(
  snapshot: AgentOptionsSnapshot | null,
  modeId: string | null,
  configValues: Record<string, string>
): { mode_id: string | null; config_values: Record<string, string> } {
  // No probe landed → nothing concrete was ever shown; persist the raw overrides.
  if (!snapshot) return { mode_id: modeId, config_values: configValues }

  const config: Record<string, string> = {}
  for (const option of snapshot.config_options) {
    if (option.kind.type !== "select") continue
    const effective = configValues[option.id] ?? option.kind.current_value
    if (effective != null && effective !== "") config[option.id] = effective
  }
  // Defensive: never drop a user override for an option this snapshot doesn't
  // advertise (e.g. a stale id from an earlier probe of another agent).
  for (const [id, value] of Object.entries(configValues)) {
    if (!(id in config)) config[id] = value
  }

  // Mirror `showMode = hasModes && !hasOptions`: the standalone mode row is only
  // shown — and thus only pinnable — when the agent has modes but no config
  // options; otherwise leave the user's mode choice (incl. null) untouched.
  const hasModes = !!snapshot.modes && snapshot.modes.available_modes.length > 0
  const hasOptions = snapshot.config_options.length > 0
  const mode_id =
    modeId ?? (hasModes && !hasOptions ? snapshot.modes!.current_mode_id : null)

  return { mode_id, config_values: config }
}

// Friendly name for a selected value within a select option — checks groups
// first, then the flat list, mirroring how ConfigOptionRow renders them.
function selectValueLabel(
  kind: Extract<SessionConfigOptionInfo["kind"], { type: "select" }>,
  value: string
): string | undefined {
  for (const group of kind.groups) {
    const hit = group.options.find((o) => o.value === value)
    if (hit) return hit.name
  }
  return kind.options.find((o) => o.value === value)?.name
}

/**
 * Human-readable labels for the effective selections, captured at save time so
 * the detail page shows friendly names (model/mode/option) instead of raw value
 * ids — and keeps showing them even if the agent is later uninstalled or its
 * option set changes. Pass the same effective `{ mode_id, config_values }` that
 * `effectiveSelections` produced. Returns only the fields it can resolve.
 */
export function snapshotLabels(
  snapshot: AgentOptionsSnapshot | null,
  modeId: string | null,
  configValues: Record<string, string>
): { mode_label?: string; config_labels?: Record<string, string> } {
  if (!snapshot) return {}
  const out: { mode_label?: string; config_labels?: Record<string, string> } =
    {}

  if (modeId && snapshot.modes) {
    const mode = snapshot.modes.available_modes.find((m) => m.id === modeId)
    if (mode) out.mode_label = mode.name
  }

  const config_labels: Record<string, string> = {}
  for (const option of snapshot.config_options) {
    if (option.kind.type !== "select") continue
    const value = configValues[option.id]
    if (value == null) continue
    const name = selectValueLabel(option.kind, value)
    if (name) config_labels[option.id] = name
  }
  if (Object.keys(config_labels).length > 0) out.config_labels = config_labels

  return out
}

// The shared row shell (label + Select trigger) for both the standalone mode
// row and the per-option rows. Keeping the inline-vs-stacked styling here means
// the mode chip and the config chips can never drift apart in the composer's
// bottom bar; callers supply only the differing <SelectContent>.
function FieldRow({
  label,
  description,
  value,
  inline,
  allowInherit,
  currentValue,
  onChange,
  children,
}: {
  label: string
  /** Secondary line for the inline chip's hover hint — the same subtitle the
   *  chat composer's chips carry. Inline only: the stacked layout shows its
   *  label outright and has no hint to hang it off. */
  description?: string | null
  value: string | null
  inline?: boolean
  /** When false (automations), the "inherit/default" escape hatch is dropped:
   *  the selector pins a concrete value, defaulting to the agent's *current*
   *  value so the shown choice always matches what an unset option would run. */
  allowInherit: boolean
  currentValue?: string | null
  onChange: (v: string | null) => void
  children: ReactNode
}) {
  const selectValue = allowInherit
    ? (value ?? DEFAULT_SENTINEL)
    : (value ?? currentValue ?? "")
  return (
    <div
      className={
        inline
          ? "flex items-center gap-1.5"
          : "flex items-center justify-between gap-3"
      }
    >
      {/* Inline (composer bottom bar) drops the visible label entirely — the
          chip shows only its value, like the composer's model/mode selectors. */}
      {!inline ? (
        <label className="min-w-0 truncate text-sm">{label}</label>
      ) : null}
      <Select
        value={selectValue}
        onValueChange={(v) =>
          onChange(allowInherit ? (v === DEFAULT_SENTINEL ? null : v) : v)
        }
      >
        {/* The dropped label still rides along for hover (`SelectorTooltip`, the
            same hint the chat composer's chips use) and screen readers
            (`aria-label`). Stacked keeps its visible <label>, so it passes
            `null` and renders the trigger bare. A Radix `Select` blocks outside
            pointer events while open, so no `suppressed` is needed. */}
        <SelectorTooltip
          label={inline ? label : null}
          description={inline ? description : null}
        >
          <SelectTrigger
            size="sm"
            aria-label={label}
            // 24px (not the size="sm" default) is deliberate: inline chips
            // share the task editor's composer bottom bar with the "+" add-menu
            // button, which is a `size="icon-xs"` (h-6) Button, and the chat
            // composer's own selectors are h-6 too (`size="xs"`,
            // session-config-selector). It takes `data-[size=sm]:h-6` to get
            // there: a bare `h-6` loses to the trigger's own
            // `data-[size=sm]:h-8`, whose attribute selector is the more
            // specific rule, and tailwind-merge only drops the base class when
            // the override carries the same variant. `py-0` sheds the base
            // padding that a 24px box has no room for.
            className={
              inline
                ? "h-6 w-auto max-w-[12rem] gap-1 border-0 bg-transparent px-1.5 py-0 text-xs text-muted-foreground shadow-none hover:text-foreground data-[size=sm]:h-6"
                : "w-52"
            }
          >
            <SelectValue />
          </SelectTrigger>
        </SelectorTooltip>
        {children}
      </Select>
    </div>
  )
}

function FlatSelect({
  label,
  value,
  inheritLabel,
  inline,
  allowInherit,
  currentValue,
  onChange,
  items,
}: {
  label: string
  value: string | null
  inheritLabel: string
  inline?: boolean
  allowInherit: boolean
  currentValue?: string | null
  onChange: (v: string | null) => void
  items: Array<{ value: string; name: string; description?: string | null }>
}) {
  // The chip's hint describes the mode it is currently on, mirroring the chat
  // composer's mode selector (which hangs the selected mode's blurb off it).
  const selected = items.find((it) => it.value === (value ?? currentValue))
  return (
    <FieldRow
      label={label}
      description={selected?.description}
      value={value}
      inline={inline}
      allowInherit={allowInherit}
      currentValue={currentValue}
      onChange={onChange}
    >
      <SelectContent>
        {allowInherit ? (
          <SelectItem value={DEFAULT_SENTINEL}>{inheritLabel}</SelectItem>
        ) : null}
        {items.map((it) => (
          <SelectItem
            key={it.value}
            value={it.value}
            description={it.description}
          >
            {it.name}
          </SelectItem>
        ))}
      </SelectContent>
    </FieldRow>
  )
}

function ConfigOptionRow({
  option,
  value,
  inheritLabel,
  inline,
  allowInherit,
  onChange,
}: {
  option: SessionConfigOptionInfo
  value: string | null
  inheritLabel: string
  inline?: boolean
  allowInherit: boolean
  onChange: (v: string | null) => void
}) {
  if (option.kind.type !== "select") return null
  const groups = option.kind.groups
  return (
    <FieldRow
      label={option.name}
      description={option.description}
      value={value}
      inline={inline}
      allowInherit={allowInherit}
      currentValue={option.kind.current_value}
      onChange={onChange}
    >
      <SelectContent>
        {allowInherit ? (
          <SelectItem value={DEFAULT_SENTINEL}>{inheritLabel}</SelectItem>
        ) : null}
        {groups.length > 0
          ? groups.map((g) => (
              <SelectGroup key={g.group}>
                <SelectLabel>{g.name}</SelectLabel>
                {g.options.map((it) => (
                  <SelectItem
                    key={`${g.group}-${it.value}`}
                    value={it.value}
                    description={it.description}
                  >
                    {it.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))
          : option.kind.options.map((it) => (
              <SelectItem
                key={it.value}
                value={it.value}
                description={it.description}
              >
                {it.name}
              </SelectItem>
            ))}
      </SelectContent>
    </FieldRow>
  )
}
