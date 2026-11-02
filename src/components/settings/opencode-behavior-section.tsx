"use client"

import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ExternalLink, SlidersHorizontal } from "lucide-react"

import { BrowserLink } from "@/components/ui/browser-link"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import {
  OPENCODE_NUMBER_FIELDS,
  OPENCODE_TOGGLE_DEFAULTS,
  OPENCODE_UPDATE_MODES,
  parseOpenCodeNumberInput,
  readOpenCodeBehavior,
  removeIgnoredLegacyKeys,
  setOpenCodeDefaultAgent,
  setOpenCodeNumber,
  setOpenCodeToggle,
  setOpenCodeUpdate,
  type OpenCodeNumberField,
  type OpenCodeNumberValue,
  type OpenCodeToggleField,
  type OpenCodeUpdateMode,
} from "@/lib/opencode-behavior"
import { isOpenCodeConfigEditable } from "@/lib/opencode-permissions"

/** Radix Select rejects "" as a value, so "not configured" needs a sentinel. */
const UNSET = "__opencode_behavior_unset__"

const DOCS_URL = "https://opencode.ai/v2/docs/config"

/** A value a hint quotes, set the way the field takes it. */
const hintLiteral = (chunks: ReactNode) => (
  <code dir="ltr" className="rounded bg-muted px-1 font-mono break-words">
    {chunks}
  </code>
)

/**
 * Visual editor for the OpenCode 2 config keys that shape a session's behavior:
 * which agent it starts in, how it compacts, which experimental tools it has,
 * and how much tool output survives before it is spilled to disk.
 *
 * These were reachable only through the raw-JSON box next to it, which meant
 * every one of them required knowing the key name and its schema type. The
 * component is stateless with respect to the config for the same reason the
 * permissions editor is: it renders whatever `configText` says and hands a
 * rewritten document back through `onChange`, so the card's existing Save
 * button owns the write to `opencode.json`.
 *
 * Every control has an explicit "not configured" state that DELETES the key
 * rather than writing OpenCode's current default, so a document stays free of
 * pins the user never asked for.
 */
export function OpenCodeBehaviorSection({
  configText,
  onChange,
  disabled = false,
}: {
  configText: string
  onChange: (nextConfigText: string) => void
  disabled?: boolean
}) {
  const t = useTranslations("AcpAgentSettings")
  const view = useMemo(() => readOpenCodeBehavior(configText), [configText])
  const editable = isOpenCodeConfigEditable(configText)
  const locked = disabled || !editable || view.invalid

  /**
   * Spelled out rather than looked up with a template literal: next-intl types
   * messages off `en.json`, so a dynamic key would not typecheck.
   */
  const numberLabels = useMemo<Record<OpenCodeNumberField, string>>(
    () => ({
      "experimental.subagent_depth": t(
        "openCode.behavior.fields.subagentDepth"
      ),
      "compaction.keep.tokens": t(
        "openCode.behavior.fields.preserveRecentTokens"
      ),
      "compaction.buffer": t("openCode.behavior.fields.reserved"),
      "tool_output.max_lines": t("openCode.behavior.fields.maxLines"),
      "tool_output.max_bytes": t("openCode.behavior.fields.maxBytes"),
    }),
    [t]
  )

  const numberHints = useMemo<Record<OpenCodeNumberField, ReactNode>>(
    () => ({
      "experimental.subagent_depth": t("openCode.behavior.hints.subagentDepth"),
      "compaction.keep.tokens": t(
        "openCode.behavior.hints.preserveRecentTokens"
      ),
      "compaction.buffer": t.rich("openCode.behavior.hints.reserved", {
        code: hintLiteral,
      }),
      "tool_output.max_lines": t("openCode.behavior.hints.maxLines"),
      "tool_output.max_bytes": t("openCode.behavior.hints.maxBytes"),
    }),
    [t]
  )

  const updateLabel = useCallback(
    (mode: OpenCodeUpdateMode) =>
      mode === "auto"
        ? t("openCode.behavior.autoUpdateOn")
        : mode === "notify"
          ? t("openCode.behavior.autoUpdateNotify")
          : t("openCode.behavior.autoUpdateOff"),
    [t]
  )

  /** Write what `raw` says, and return what the field holds afterwards. */
  const handleNumberChange = useCallback(
    (field: OpenCodeNumberField, raw: string): OpenCodeNumberValue | null => {
      const parsed = parseOpenCodeNumberInput(field, raw)
      // A half-typed value ("1e", "-") is neither written nor an error: the
      // document keeps what it says until the input spells a value.
      if (parsed === undefined) return view.numbers[field]
      const next = setOpenCodeNumber(configText, field, parsed)
      onChange(next)
      return readOpenCodeBehavior(next).numbers[field]
    },
    [configText, onChange, view]
  )

  const handleToggle = useCallback(
    (field: OpenCodeToggleField, checked: boolean) => {
      // Returning to OpenCode's own default UNSETS the key instead of pinning
      // it, so the document keeps following upstream.
      onChange(
        setOpenCodeToggle(
          configText,
          field,
          checked === OPENCODE_TOGGLE_DEFAULTS[field] ? null : checked
        )
      )
    },
    [configText, onChange]
  )

  const toggleChecked = (field: OpenCodeToggleField) =>
    view.toggles[field] ?? OPENCODE_TOGGLE_DEFAULTS[field]

  return (
    <div className="space-y-2.5 rounded-md border bg-background/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <label className="text-2xs font-medium">
            {t("openCode.behavior.title")}
          </label>
          <p className="mt-1 text-3xs text-muted-foreground">
            {t("openCode.behavior.description")}
          </p>
        </div>
        <BrowserLink
          href={DOCS_URL}
          className="inline-flex shrink-0 items-center gap-1 text-2xs text-primary hover:underline"
        >
          {t("openCode.behavior.docsLink")}
          <ExternalLink className="h-3 w-3" />
        </BrowserLink>
      </div>

      {!editable && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-2xs text-amber-500">
          {t("openCode.permissions.unparsableConfig")}
        </p>
      )}

      {editable && view.ignoredLegacyKeys.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5">
          <p className="min-w-0 flex-1 text-2xs text-amber-500">
            {t("openCode.behavior.ignoredLegacyKeys", {
              keys: view.ignoredLegacyKeys.join(", "),
            })}
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={locked}
            onClick={() => onChange(removeIgnoredLegacyKeys(configText))}
          >
            {t("openCode.behavior.removeIgnoredLegacyKeys")}
          </Button>
        </div>
      )}

      {/* ---- Session defaults ---- */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-2xs font-medium">
              {t("openCode.behavior.defaultAgent")}
            </div>
            <p className="mt-0.5 text-3xs text-muted-foreground">
              {t("openCode.behavior.defaultAgentHint")}
            </p>
          </div>
          <Input
            value={view.defaultAgent}
            disabled={locked}
            placeholder="build"
            spellCheck={false}
            className="h-7 w-44 font-mono text-xs"
            onChange={(event) => {
              onChange(setOpenCodeDefaultAgent(configText, event.target.value))
            }}
            aria-label={t("openCode.behavior.defaultAgent")}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-2xs font-medium">
              {t("openCode.behavior.autoUpdate")}
            </div>
            <p className="mt-0.5 text-3xs text-muted-foreground">
              {t("openCode.behavior.autoUpdateHint")}
            </p>
          </div>
          <Select
            value={view.update ?? UNSET}
            disabled={locked}
            onValueChange={(value) => {
              onChange(
                setOpenCodeUpdate(
                  configText,
                  value === UNSET ? null : (value as OpenCodeUpdateMode)
                )
              )
            }}
          >
            <SelectTrigger className="h-7 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={UNSET}>
                {t("openCode.behavior.unset")}
              </SelectItem>
              {OPENCODE_UPDATE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {updateLabel(mode)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ---- Switches ---- */}
      <div className="space-y-2 border-t pt-2">
        <ToggleRow
          icon
          label={t("openCode.behavior.snapshot")}
          hint={t("openCode.behavior.snapshotHint")}
          // Default on. Off is what disables undo/revert.
          checked={toggleChecked("snapshots")}
          disabled={locked}
          onChange={(checked) => handleToggle("snapshots", checked)}
        />
        <ToggleRow
          label={t("openCode.behavior.compactionAuto")}
          hint={t("openCode.behavior.compactionAutoHint")}
          checked={toggleChecked("compaction.auto")}
          disabled={locked}
          onChange={(checked) => handleToggle("compaction.auto", checked)}
        />
        <ToggleRow
          label={t("openCode.behavior.backgroundCompaction")}
          hint={t("openCode.behavior.backgroundCompactionHint")}
          checked={toggleChecked("experimental.background_compaction")}
          disabled={locked}
          onChange={(checked) =>
            handleToggle("experimental.background_compaction", checked)
          }
        />
        <ToggleRow
          label={t("openCode.behavior.todo")}
          hint={t("openCode.behavior.todoHint")}
          checked={toggleChecked("experimental.todo")}
          disabled={locked}
          onChange={(checked) => handleToggle("experimental.todo", checked)}
        />
      </div>

      {/* ---- Numeric limits ---- */}
      <div className="space-y-1.5 border-t pt-2">
        {OPENCODE_NUMBER_FIELDS.map((meta) => (
          <div
            key={meta.field}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <div className="min-w-0">
              <div className="text-2xs font-medium">
                {numberLabels[meta.field]}
              </div>
              <p className="mt-0.5 text-3xs text-muted-foreground">
                {numberHints[meta.field]}
              </p>
            </div>
            {meta.percent ? (
              <ShareOrNumberInput
                value={view.numbers[meta.field]}
                disabled={locked}
                placeholder={meta.placeholder}
                onType={(raw) => handleNumberChange(meta.field, raw)}
                ariaLabel={numberLabels[meta.field]}
              />
            ) : (
              <Input
                type="number"
                inputMode="numeric"
                min={meta.min}
                value={view.numbers[meta.field] ?? ""}
                disabled={locked}
                placeholder={meta.placeholder}
                className="h-7 w-44 font-mono text-xs"
                onChange={(event) => {
                  handleNumberChange(meta.field, event.target.value)
                }}
                aria-label={numberLabels[meta.field]}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The input of a field that takes a token count or a share of the window
 * ("20%"), which a `type="number"` input cannot hold.
 *
 * A text input that only mirrored the document would drop every keystroke that
 * spells no value yet — the "." of "12.5%" — so it shows what was typed for as
 * long as the document holds what that typing wrote, and the document again
 * once it holds anything else (an edit in the JSON box) or the input loses
 * focus.
 */
function ShareOrNumberInput({
  value,
  disabled,
  placeholder,
  onType,
  ariaLabel,
}: {
  value: OpenCodeNumberValue | null
  disabled: boolean
  placeholder: string
  /** Hands the typed text over and returns what the field holds afterwards. */
  onType: (raw: string) => OpenCodeNumberValue | null
  ariaLabel: string
}) {
  const stored = value === null ? "" : String(value)
  const [draft, setDraft] = useState<{ text: string; stored: string } | null>(
    null
  )
  return (
    <Input
      type="text"
      dir="ltr"
      spellCheck={false}
      autoComplete="off"
      value={draft !== null && draft.stored === stored ? draft.text : stored}
      disabled={disabled}
      placeholder={placeholder}
      className="h-7 w-44 font-mono text-xs"
      onChange={(event) => {
        const text = event.target.value
        const held = onType(text)
        setDraft({ text, stored: held === null ? "" : String(held) })
      }}
      onBlur={() => setDraft(null)}
      aria-label={ariaLabel}
    />
  )
}

function ToggleRow({
  icon = false,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  icon?: boolean
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {icon && (
          <SlidersHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <div className="text-2xs font-medium">{label}</div>
          <p className="mt-0.5 text-3xs text-muted-foreground">{hint}</p>
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  )
}
