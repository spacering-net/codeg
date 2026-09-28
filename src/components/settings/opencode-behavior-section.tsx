"use client"

import { useCallback, useMemo } from "react"
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
import {
  OPENCODE_AUTOUPDATE_MODES,
  OPENCODE_NUMBER_FIELDS,
  OPENCODE_SHARE_MODES,
  readOpenCodeBehavior,
  setOpenCodeAutoUpdate,
  setOpenCodeDefaultAgent,
  setOpenCodeNumber,
  setOpenCodeShare,
  setOpenCodeToggle,
  type OpenCodeAutoUpdate,
  type OpenCodeNumberField,
  type OpenCodeShareMode,
  type OpenCodeToggleField,
} from "@/lib/opencode-behavior"
import { isOpenCodeConfigEditable } from "@/lib/opencode-permissions"

/** Radix Select rejects "" as a value, so "not configured" needs a sentinel. */
const UNSET = "__opencode_behavior_unset__"

const DOCS_URL = "https://opencode.ai/docs/config/"

/**
 * Visual editor for the OpenCode config keys that shape a session's behavior:
 * which agent it starts in, whether it shares, how it compacts, and how much
 * tool output survives before it is spilled to disk.
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
      subagent_depth: t("openCode.behavior.fields.subagentDepth"),
      "compaction.tail_turns": t("openCode.behavior.fields.tailTurns"),
      "compaction.preserve_recent_tokens": t(
        "openCode.behavior.fields.preserveRecentTokens"
      ),
      "compaction.reserved": t("openCode.behavior.fields.reserved"),
      "tool_output.max_lines": t("openCode.behavior.fields.maxLines"),
      "tool_output.max_bytes": t("openCode.behavior.fields.maxBytes"),
    }),
    [t]
  )

  const numberHints = useMemo<Record<OpenCodeNumberField, string>>(
    () => ({
      subagent_depth: t("openCode.behavior.hints.subagentDepth"),
      "compaction.tail_turns": t("openCode.behavior.hints.tailTurns"),
      "compaction.preserve_recent_tokens": t(
        "openCode.behavior.hints.preserveRecentTokens"
      ),
      "compaction.reserved": t("openCode.behavior.hints.reserved"),
      "tool_output.max_lines": t("openCode.behavior.hints.maxLines"),
      "tool_output.max_bytes": t("openCode.behavior.hints.maxBytes"),
    }),
    [t]
  )

  const shareLabel = useCallback(
    (mode: OpenCodeShareMode) =>
      mode === "manual"
        ? t("openCode.behavior.shareManual")
        : mode === "auto"
          ? t("openCode.behavior.shareAuto")
          : t("openCode.behavior.shareDisabled"),
    [t]
  )

  const autoUpdateLabel = useCallback(
    (mode: OpenCodeAutoUpdate) =>
      mode === "on"
        ? t("openCode.behavior.autoUpdateOn")
        : mode === "notify"
          ? t("openCode.behavior.autoUpdateNotify")
          : t("openCode.behavior.autoUpdateOff"),
    [t]
  )

  const handleNumberChange = useCallback(
    (field: OpenCodeNumberField, raw: string) => {
      const trimmed = raw.trim()
      if (trimmed === "") {
        onChange(setOpenCodeNumber(configText, field, null))
        return
      }
      const parsed = Number(trimmed)
      // A half-typed value ("1e", "-") is neither written nor an error: the
      // input keeps showing what the document says until it parses.
      if (!Number.isInteger(parsed)) return
      onChange(setOpenCodeNumber(configText, field, parsed))
    },
    [configText, onChange]
  )

  const handleToggle = useCallback(
    (field: OpenCodeToggleField, checked: boolean, defaultOn: boolean) => {
      // Returning to OpenCode's own default UNSETS the key instead of pinning
      // it, so the document keeps following upstream.
      onChange(
        setOpenCodeToggle(
          configText,
          field,
          checked === defaultOn ? null : checked
        )
      )
    },
    [configText, onChange]
  )

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
              {t("openCode.behavior.share")}
            </div>
            <p className="mt-0.5 text-3xs text-muted-foreground">
              {t("openCode.behavior.shareHint")}
            </p>
          </div>
          <Select
            value={view.share ?? UNSET}
            disabled={locked}
            onValueChange={(value) => {
              onChange(
                setOpenCodeShare(
                  configText,
                  value === UNSET ? null : (value as OpenCodeShareMode)
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
              {OPENCODE_SHARE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {shareLabel(mode)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            value={view.autoupdate ?? UNSET}
            disabled={locked}
            onValueChange={(value) => {
              onChange(
                setOpenCodeAutoUpdate(
                  configText,
                  value === UNSET ? null : (value as OpenCodeAutoUpdate)
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
              {OPENCODE_AUTOUPDATE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {autoUpdateLabel(mode)}
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
          // Schema default: snapshots on. Off is what disables undo/revert.
          checked={view.toggles.snapshot ?? true}
          disabled={locked}
          onChange={(checked) => handleToggle("snapshot", checked, true)}
        />
        <ToggleRow
          label={t("openCode.behavior.compactionAuto")}
          hint={t("openCode.behavior.compactionAutoHint")}
          checked={view.toggles["compaction.auto"] ?? true}
          disabled={locked}
          onChange={(checked) => handleToggle("compaction.auto", checked, true)}
        />
        <ToggleRow
          label={t("openCode.behavior.compactionPrune")}
          hint={t("openCode.behavior.compactionPruneHint")}
          checked={view.toggles["compaction.prune"] ?? false}
          disabled={locked}
          onChange={(checked) =>
            handleToggle("compaction.prune", checked, false)
          }
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
          </div>
        ))}
      </div>
    </div>
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
