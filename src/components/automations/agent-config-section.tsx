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
import { SessionSettingsPicker } from "@/components/chat/session-settings-picker"
import { buildSessionSettings } from "@/lib/session-settings"
import { cn } from "@/lib/utils"
import type {
  AgentOptionsSnapshot,
  AgentType,
  SessionConfigOptionInfo,
} from "@/lib/types"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"

// Picking this clears the override (inherit the agent's own default); the
// codeg prefix avoids colliding with a real option id.
const DEFAULT_SENTINEL = "__codeg_default__"

interface AgentConfigSectionProps {
  /** Probe result, owned by the parent (so a single probe also feeds the `/`
   *  command menu). Null while loading / on error / before the first probe. */
  snapshot: AgentOptionsSnapshot | null
  /** Which agent the snapshot came from. Localises the agent's own mode /
   *  option vocabulary (see `lib/agent-label-vocabulary`) and is the inline
   *  chip's icon; optional so a caller without it keeps verbatim rendering. */
  agentType?: AgentType | null
  loading: boolean
  /** The snapshot was probed for a previous selection (another agent, folder
   *  or model — the hook's `current` is false while its re-probe is pending).
   *  Rendered as loading: picking off a previous selection's options would put
   *  its values into the new one. */
  stale?: boolean
  error: string | null
  onReload: () => void
  modeId: string | null
  configValues: Record<string, string>
  onModeChange: (modeId: string | null) => void
  onConfigChange: (optionId: string, valueId: string | null) => void
  /** "stacked" (default) renders the labeled card used in standalone forms;
   *  "inline" renders the chat composer's settings chip — every value in one
   *  chip, each adjusted in its popover — for the bottom bar of a
   *  composer-style editor. */
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
  stale = false,
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

  if (loading || (stale && !error)) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground",
          // Inline shares the composer's bottom bar with the "+" button: hold
          // the same 24px the chip will occupy so the bar neither jumps nor
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
  // The probe asked for the selected model and the agent did not switch to
  // it: the options below are its OTHER model's. They stay editable (each one
  // may also be left to the agent), but the user must know — even when the
  // agent then lists nothing at all.
  const modelNotSwitched =
    snapshot.unapplied_config_ids?.includes("model") ?? false
  const notSwitchedNotice = modelNotSwitched ? (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2",
        inline ? "h-6" : "justify-between"
      )}
    >
      <p
        className={cn(
          "min-w-0 text-xs text-amber-700 dark:text-amber-400",
          inline && "truncate"
        )}
        title={t("modelNotSwitched")}
      >
        {t("modelNotSwitched")}
      </p>
      <Button
        size="xs"
        variant={inline ? "ghost" : "outline"}
        className="shrink-0"
        onClick={onReload}
      >
        {t("retry")}
      </Button>
    </div>
  ) : null
  if (!hasModes && !hasOptions) {
    // Inline lives in the composer bottom bar — stay silent rather than print a
    // sentence there; the stacked form still surfaces the hint.
    if (inline) return notSwitchedNotice
    return (
      <div className="flex flex-col gap-2">
        {notSwitchedNotice}
        <p className="text-xs text-muted-foreground">{t("configNone")}</p>
      </div>
    )
  }
  // Mirror the composer: when an agent exposes both modes AND config options,
  // hide the standalone mode row (some agents surface mode as a config option).
  const showMode = hasModes && !hasOptions
  const modes = showMode ? snapshot.modes : null

  if (inline) {
    // What the editor will save, which is what the chip shows: the user's
    // pick where there is one, else the agent's current value — there is no
    // "agent default" item to fall back on here (see `effectiveSelections`).
    const settings = buildSessionSettings({
      configOptions: vocabulary
        .configOptions(snapshot.config_options)
        .map((option) => withSelection(option, configValues[option.id])),
      modes: modes ? vocabulary.modes(modes.available_modes) : [],
      currentModeId: modes ? (modeId ?? modes.current_mode_id) : null,
      modeTitle: t("mode"),
    })
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        {notSwitchedNotice}
        <SessionSettingsPicker
          agentType={agentType ?? null}
          settings={settings}
          loadingLabel={null}
          onChange={(target, value) => {
            if (target.type === "mode") onModeChange(value)
            else onConfigChange(target.configId, value)
          }}
        />
      </div>
    )
  }

  const booleanLabels = { on: t("booleanOn"), off: t("booleanOff") }
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card/40 p-3">
      {notSwitchedNotice}
      {modes ? (
        <FlatSelect
          label={t("mode")}
          value={modeId}
          inheritLabel={t("inherit")}
          onChange={onModeChange}
          items={vocabulary.modes(modes.available_modes).map((m) => ({
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
          booleanLabels={booleanLabels}
          onChange={(v) => onConfigChange(option.id, v)}
        />
      ))}
    </div>
  )
}

/** The value a boolean option is shown — and saved — with: the wire encoding
 *  launch replay sends (`"true"` / `"false"`). */
function booleanValue(current: boolean): string {
  return current ? "true" : "false"
}

/** The option as the inline chip shows it: the user's pick, if any, in place
 *  of the agent's current value. `effectiveSelections` saves the same. */
function withSelection(
  option: SessionConfigOptionInfo,
  value: string | undefined
): SessionConfigOptionInfo {
  if (value === undefined) return option
  return option.kind.type === "boolean"
    ? { ...option, kind: { ...option.kind, current_value: value === "true" } }
    : { ...option, kind: { ...option.kind, current_value: value } }
}

/** How a switch's value is named, for {@link snapshotLabels}. */
export function useBooleanOptionLabels(): { on: string; off: string } {
  const t = useTranslations("Automations")
  return { on: t("booleanOn"), off: t("booleanOff") }
}

/**
 * Mirror of `withSelection` (`value ?? currentValue`) applied across a whole
 * snapshot: the concrete selections the inline (no-inherit) config chip is
 * *displaying*. The editor saves these so a saved automation pins exactly what
 * the user saw — an untouched option persists the agent's current value rather
 * than an empty override that would silently inherit a future default.
 *
 * Kept right beside `withSelection` so the display rule and the save rule
 * can't drift.
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
    // A switch shows its current state when untouched, so it pins it too.
    const effective =
      configValues[option.id] ??
      (option.kind.type === "select"
        ? option.kind.current_value
        : booleanValue(option.kind.current_value))
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
  configValues: Record<string, string>,
  /** How a switch's value is named, in the reader's language. Without them a
   *  switch gets no label (and the detail page shows its raw value). */
  booleanLabels?: { on: string; off: string }
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
    const value = configValues[option.id]
    if (value == null) continue
    if (option.kind.type === "boolean") {
      if (booleanLabels && (value === "true" || value === "false")) {
        config_labels[option.id] =
          value === "true" ? booleanLabels.on : booleanLabels.off
      }
      continue
    }
    const name = selectValueLabel(option.kind, value)
    if (name) config_labels[option.id] = name
  }
  if (Object.keys(config_labels).length > 0) out.config_labels = config_labels

  return out
}

// The stacked layout's row shell (label + Select trigger) for both the
// standalone mode row and the per-option rows; callers supply only the
// differing <SelectContent>, which leads with the "agent default" item.
function FieldRow({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  /** `null` inherits the agent's own default. */
  value: string | null
  onChange: (v: string | null) => void
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="min-w-0 truncate text-sm">{label}</label>
      <Select
        value={value ?? DEFAULT_SENTINEL}
        onValueChange={(v) => onChange(v === DEFAULT_SENTINEL ? null : v)}
      >
        <SelectTrigger size="sm" aria-label={label} className="w-52">
          <SelectValue />
        </SelectTrigger>
        {children}
      </Select>
    </div>
  )
}

function FlatSelect({
  label,
  value,
  inheritLabel,
  onChange,
  items,
}: {
  label: string
  value: string | null
  inheritLabel: string
  onChange: (v: string | null) => void
  items: Array<{ value: string; name: string; description?: string | null }>
}) {
  return (
    <FieldRow label={label} value={value} onChange={onChange}>
      <SelectContent>
        <SelectItem value={DEFAULT_SENTINEL}>{inheritLabel}</SelectItem>
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
  booleanLabels,
  onChange,
}: {
  option: SessionConfigOptionInfo
  value: string | null
  inheritLabel: string
  booleanLabels: { on: string; off: string }
  onChange: (v: string | null) => void
}) {
  if (option.kind.type === "boolean") {
    // On / off as two items, after the inherit escape hatch — the same
    // tri-state the select rows have.
    return (
      <FlatSelect
        label={option.name}
        value={value}
        inheritLabel={inheritLabel}
        onChange={onChange}
        items={[
          { value: "true", name: booleanLabels.on },
          { value: "false", name: booleanLabels.off },
        ]}
      />
    )
  }
  const groups = option.kind.groups
  return (
    <FieldRow label={option.name} value={value} onChange={onChange}>
      <SelectContent>
        <SelectItem value={DEFAULT_SENTINEL}>{inheritLabel}</SelectItem>
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
