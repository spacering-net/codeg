"use client"

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ExternalLink,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { BrowserLink } from "@/components/ui/browser-link"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  OPENCODE_PERMISSION_ACTIONS,
  OPENCODE_PERMISSION_KEYS,
  applyOpenCodeAutoAccept,
  clearOpenCodePermissions,
  effectiveOpenCodeDefault,
  isOpenCodeConfigEditable,
  normalizeOpenCodePermissionOrder,
  readOpenCodePermissions,
  setOpenCodeGlobalPermission,
  setOpenCodeKeyPermission,
  setOpenCodeKeyRules,
  type OpenCodePermissionAction,
  type OpenCodePermissionEntry,
  type OpenCodePermissionRule,
} from "@/lib/opencode-permissions"

/** Radix Select rejects "" as a value, so "not configured" needs a sentinel. */
const UNSET = "__opencode_permission_unset__"

const DOCS_URL = "https://opencode.ai/v2/docs/permissions"

/** Rule-capable keys get a fine-grained editor; the rest are action-only. */
const FINE_GRAINED = new Map(
  OPENCODE_PERMISSION_KEYS.map((meta) => [meta.key, meta])
)

function actionTone(action: OpenCodePermissionAction | null): string {
  if (action === "deny") return "text-destructive"
  if (action === "ask") return "text-amber-500"
  return ""
}

/**
 * Everything the fine-grained rule list needs, bundled so the two `PermissionRow`
 * call sites stay readable. Only one key is expanded at a time, so a single
 * shared draft row and a single in-flight pattern edit are enough.
 */
interface RuleEditor {
  draftPattern: string
  draftAction: OpenCodePermissionAction
  editingRule: { index: number; text: string } | null
  onDraftPatternChange: (value: string) => void
  onDraftActionChange: (value: OpenCodePermissionAction) => void
  onPatternEdit: (
    entry: OpenCodePermissionEntry,
    index: number,
    value: string
  ) => void
  onPatternEditEnd: () => void
  onRulesChange: (key: string, rules: OpenCodePermissionRule[]) => void
  onAddRule: (entry: OpenCodePermissionEntry) => void
}

/**
 * Visual editor for OpenCode 2's `permissions` rules in its config file.
 *
 * The rules are an ordered list where the last match wins; the editor shows
 * them grouped: a global default (the `*` action's `*` rule), a base effect
 * per action, and each action's resource rules. The headline control is the
 * auto-accept switch, which writes one `{action: "*", resource: "*", effect:
 * "allow"}` rule so no tool call stops for approval. 1.x's `permission` and
 * `tools` keys are read the way OpenCode reads them and rewritten as
 * `permissions` by the next edit.
 *
 * The component is stateless with respect to the config: it renders whatever
 * `configText` says and hands a rewritten document back through `onChange`.
 * Only the in-progress "add a rule" inputs are local — an existing rule is
 * edited straight through, which round-trips because the writer emits rules in
 * the grouped order. A list written in another order is read-only until Fix
 * order (or the native JSON) puts it in that order.
 */
export function OpenCodePermissionsSection({
  configText,
  onChange,
  disabled = false,
}: {
  configText: string
  onChange: (nextConfigText: string) => void
  disabled?: boolean
}) {
  const t = useTranslations("AcpAgentSettings")
  const view = useMemo(() => readOpenCodePermissions(configText), [configText])
  const editable = isOpenCodeConfigEditable(configText)
  // Rules written in another order than the rows show would be rewritten in
  // the shown order by any edit, changing what untouched rules decide. The
  // rows wait for Fix order (or a fix in the native JSON).
  const locked = disabled || !editable || view.invalid || view.orderingUnsafe

  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [draftPattern, setDraftPattern] = useState("")
  const [draftAction, setDraftAction] =
    useState<OpenCodePermissionAction>("allow")
  /**
   * Text of the pattern currently being retyped, held apart from the config.
   * Without it, backspacing a pattern down to "" would drop the rule from the
   * document mid-edit and the row would vanish under the cursor.
   */
  const [editingRule, setEditingRule] = useState<{
    index: number
    text: string
  } | null>(null)

  const actionLabel = useCallback(
    (action: OpenCodePermissionAction) =>
      action === "allow"
        ? t("openCode.permissions.actionAllow")
        : action === "ask"
          ? t("openCode.permissions.actionAsk")
          : t("openCode.permissions.actionDeny"),
    [t]
  )

  /**
   * One-line "what does this key gate" blurbs, spelled out rather than looked
   * up with a template literal: next-intl types messages off `en.json`, so a
   * dynamic key would not typecheck.
   */
  const keyHints = useMemo<Record<string, string>>(
    () => ({
      shell: t("openCode.permissions.keys.shell"),
      edit: t("openCode.permissions.keys.edit"),
      read: t("openCode.permissions.keys.read"),
      external_directory: t("openCode.permissions.keys.external_directory"),
      subagent: t("openCode.permissions.keys.subagent"),
      skill: t("openCode.permissions.keys.skill"),
      webfetch: t("openCode.permissions.keys.webfetch"),
      websearch: t("openCode.permissions.keys.websearch"),
      glob: t("openCode.permissions.keys.glob"),
      grep: t("openCode.permissions.keys.grep"),
      execute: t("openCode.permissions.keys.execute"),
      question: t("openCode.permissions.keys.question"),
      todowrite: t("openCode.permissions.keys.todowrite"),
    }),
    [t]
  )

  const toggleExpanded = useCallback((key: string) => {
    setDraftPattern("")
    setDraftAction("allow")
    setEditingRule(null)
    setExpandedKey((current) => (current === key ? null : key))
  }, [])

  const handleGlobalChange = useCallback(
    (value: string) => {
      onChange(
        setOpenCodeGlobalPermission(
          configText,
          value === UNSET ? null : (value as OpenCodePermissionAction)
        )
      )
    },
    [configText, onChange]
  )

  const handleKeyChange = useCallback(
    (key: string, value: string) => {
      onChange(
        setOpenCodeKeyPermission(
          configText,
          key,
          value === UNSET ? null : (value as OpenCodePermissionAction)
        )
      )
    },
    [configText, onChange]
  )

  const handleRulesChange = useCallback(
    (key: string, rules: OpenCodePermissionRule[]) => {
      onChange(setOpenCodeKeyRules(configText, key, rules))
    },
    [configText, onChange]
  )

  /**
   * Retype an existing rule's pattern. The document is only rewritten for a
   * value that can actually be stored — blank, or colliding with a sibling
   * pattern, would silently swallow the row — so the rejected text lives in
   * `editingRule` until the field is left, then snaps back.
   */
  const handlePatternEdit = useCallback(
    (entry: OpenCodePermissionEntry, index: number, value: string) => {
      setEditingRule({ index, text: value })
      const trimmed = value.trim()
      if (!trimmed) return
      const clashes = entry.rules.some(
        (rule, i) => i !== index && rule.pattern === trimmed
      )
      if (clashes) return
      const next = [...entry.rules]
      next[index] = { ...next[index], pattern: trimmed }
      handleRulesChange(entry.key, next)
    },
    [handleRulesChange]
  )

  const handleAddRule = useCallback(
    (entry: OpenCodePermissionEntry) => {
      const pattern = draftPattern.trim()
      if (!pattern) return
      handleRulesChange(entry.key, [
        ...entry.rules,
        { pattern, action: draftAction },
      ])
      setDraftPattern("")
    },
    [draftAction, draftPattern, handleRulesChange]
  )

  const ruleEditor = useMemo<RuleEditor>(
    () => ({
      draftPattern,
      draftAction,
      editingRule,
      onDraftPatternChange: setDraftPattern,
      onDraftActionChange: setDraftAction,
      onPatternEdit: handlePatternEdit,
      onPatternEditEnd: () => setEditingRule(null),
      onRulesChange: handleRulesChange,
      onAddRule: handleAddRule,
    }),
    [
      draftAction,
      draftPattern,
      editingRule,
      handleAddRule,
      handlePatternEdit,
      handleRulesChange,
    ]
  )

  const knownEntries = view.entries.filter((entry) => !entry.custom)
  const customEntries = view.entries.filter((entry) => entry.custom)

  return (
    <div className="space-y-2.5 rounded-md border bg-background/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <label className="text-2xs font-medium">
            {t("openCode.permissions.title")}
          </label>
          <p className="mt-1 text-3xs text-muted-foreground">
            {t("openCode.permissions.description")}
          </p>
        </div>
        <BrowserLink
          href={DOCS_URL}
          className="inline-flex shrink-0 items-center gap-1 text-2xs text-primary hover:underline"
        >
          {t("openCode.permissions.docsLink")}
          <ExternalLink className="h-3 w-3" />
        </BrowserLink>
      </div>

      {!editable && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-2xs text-amber-500">
          {t("openCode.permissions.unparsableConfig")}
        </p>
      )}
      {editable && view.invalid && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-2xs text-amber-500">
          {t("openCode.permissions.invalidBlock")}
        </p>
      )}
      {editable && !view.invalid && view.orderingUnsafe && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5">
          <p className="min-w-0 flex-1 text-2xs text-amber-500">
            {view.orderingFixable
              ? t("openCode.permissions.orderingUnsafe")
              : t("openCode.permissions.orderingUnsafeManual")}{" "}
            {t("openCode.permissions.orderingLocked")}
          </p>
          {view.orderingFixable && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                onChange(normalizeOpenCodePermissionOrder(configText))
              }
            >
              {t("openCode.permissions.fixOrder")}
            </Button>
          )}
        </div>
      )}
      {editable && view.agentOverrides.length > 0 && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-2xs text-amber-500">
          {t("openCode.permissions.agentOverrides", {
            agents: view.agentOverrides.join(", "),
          })}
        </p>
      )}
      {editable && !view.invalid && view.legacy && (
        <p className="rounded-md border bg-muted/20 px-2.5 py-1.5 text-2xs text-muted-foreground">
          {t("openCode.permissions.legacyRules")}
        </p>
      )}

      {/* ---- Auto-accept: the headline knob ---- */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-2.5 py-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-xs font-medium">
              {t("openCode.permissions.autoAcceptTitle")}
            </div>
            <p className="mt-0.5 text-3xs text-muted-foreground">
              {t("openCode.permissions.autoAcceptHint")}
            </p>
          </div>
        </div>
        <Switch
          checked={view.autoAcceptAll}
          // Auto-accept replaces every rule, so it stays available while the
          // order is off (it is never on then: see `autoAcceptAll`).
          disabled={disabled || !editable || view.invalid}
          onCheckedChange={(checked) => {
            // Off only drops the global "*" — anything the user set per tool
            // survives, and a block that held nothing else disappears anyway.
            onChange(
              checked
                ? applyOpenCodeAutoAccept(configText)
                : setOpenCodeGlobalPermission(configText, null)
            )
          }}
          aria-label={t("openCode.permissions.autoAcceptTitle")}
        />
      </div>

      {/* ---- Global default ("*") ---- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-2xs font-medium">
            {t("openCode.permissions.globalLabel")}
          </div>
          <p className="mt-0.5 text-3xs text-muted-foreground">
            {t("openCode.permissions.globalHint")}
          </p>
        </div>
        <Select
          value={view.globalAction ?? UNSET}
          disabled={locked}
          onValueChange={handleGlobalChange}
        >
          <SelectTrigger className="h-7 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={UNSET}>
              {t("openCode.permissions.actionUnset")}
            </SelectItem>
            {OPENCODE_PERMISSION_ACTIONS.map((action) => (
              <SelectItem key={action} value={action}>
                {actionLabel(action)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ---- Per-tool grid ---- */}
      <div className="space-y-1.5 border-t pt-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-2xs font-medium text-muted-foreground">
            {t("openCode.permissions.perToolTitle")}
          </div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            // Deliberately not gated on `view.invalid`: wiping the block is the
            // one repair the visual editor can still offer for a broken one.
            disabled={disabled || !editable || view.shape === "unset"}
            onClick={() => onChange(clearOpenCodePermissions(configText))}
          >
            {t("openCode.permissions.reset")}
          </Button>
        </div>
        <div className="space-y-1">
          {knownEntries.map((entry) => (
            <PermissionRow
              key={entry.key}
              entry={entry}
              label={entry.key}
              hint={keyHints[entry.key] ?? ""}
              fineGrained={FINE_GRAINED.get(entry.key)?.fineGrained ?? false}
              patternExample={
                FINE_GRAINED.get(entry.key)?.patternExample ?? "*"
              }
              inheritLabel={t("openCode.permissions.actionInherit", {
                action: actionLabel(
                  effectiveOpenCodeDefault(entry.key, view.globalAction)
                ),
              })}
              actionLabel={actionLabel}
              expanded={expandedKey === entry.key}
              locked={locked}
              ruleEditor={ruleEditor}
              onToggleExpanded={toggleExpanded}
              onActionChange={handleKeyChange}
            />
          ))}
        </div>
      </div>

      {customEntries.length > 0 && (
        <div className="space-y-1.5 border-t pt-2">
          <div className="text-2xs font-medium text-muted-foreground">
            {t("openCode.permissions.customKeys")}
          </div>
          <div className="space-y-1">
            {customEntries.map((entry) => (
              <PermissionRow
                key={entry.key}
                entry={entry}
                label={entry.key}
                hint={
                  entry.key === "*"
                    ? t("openCode.permissions.allToolsResourcesHint")
                    : t("openCode.permissions.customKeyHint")
                }
                fineGrained
                patternExample="*"
                baseEditable={entry.key !== "*"}
                inheritLabel={t("openCode.permissions.actionInherit", {
                  action: actionLabel(
                    effectiveOpenCodeDefault(entry.key, view.globalAction)
                  ),
                })}
                actionLabel={actionLabel}
                expanded={expandedKey === entry.key}
                locked={locked}
                ruleEditor={ruleEditor}
                onToggleExpanded={toggleExpanded}
                onActionChange={handleKeyChange}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** One tool's row: base action Select plus, when supported, a rule editor. */
function PermissionRow({
  entry,
  label,
  hint,
  fineGrained,
  patternExample,
  inheritLabel,
  actionLabel,
  expanded,
  locked,
  ruleEditor,
  onToggleExpanded,
  onActionChange,
  baseEditable = true,
}: {
  entry: OpenCodePermissionEntry
  label: string
  hint: string
  fineGrained: boolean
  patternExample: string
  inheritLabel: string
  actionLabel: (action: OpenCodePermissionAction) => string
  expanded: boolean
  locked: boolean
  ruleEditor: RuleEditor
  onToggleExpanded: (key: string) => void
  onActionChange: (key: string, value: string) => void
  /** False for the `*` row, whose base effect is the global default above. */
  baseEditable?: boolean
}) {
  const t = useTranslations("AcpAgentSettings")
  const { draftPattern, draftAction, editingRule } = ruleEditor
  const trimmedDraft = draftPattern.trim()
  const duplicate =
    trimmedDraft.length > 0 &&
    entry.rules.some((rule) => rule.pattern === trimmedDraft)
  const editedText = editingRule?.text.trim() ?? ""
  // The retyped pattern is refused while it is blank or already taken.
  const editRejected =
    editingRule !== null &&
    (editedText.length === 0 ||
      entry.rules.some(
        (rule, i) => i !== editingRule.index && rule.pattern === editedText
      ))

  return (
    <Collapsible
      open={expanded}
      onOpenChange={() => onToggleExpanded(entry.key)}
    >
      <div className="rounded-md border bg-muted/10">
        <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-xs">{label}</span>
            <span className="truncate text-3xs text-muted-foreground">
              {hint}
            </span>
          </div>
          {entry.rules.length > 0 && (
            <Badge variant="secondary" className="text-3xs">
              {t("openCode.permissions.ruleCount", {
                count: entry.rules.length,
              })}
            </Badge>
          )}
          {baseEditable && (
            <Select
              value={entry.action ?? UNSET}
              disabled={locked}
              onValueChange={(value) => onActionChange(entry.key, value)}
            >
              <SelectTrigger
                className={cn("h-7 w-40 text-xs", actionTone(entry.action))}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={UNSET}>{inheritLabel}</SelectItem>
                {OPENCODE_PERMISSION_ACTIONS.map((action) => (
                  <SelectItem key={action} value={action}>
                    {actionLabel(action)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {fineGrained && (
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                disabled={locked}
                aria-label={t("openCode.permissions.rulesToggle", {
                  tool: entry.key,
                })}
              >
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground transition-transform",
                    expanded && "rotate-180"
                  )}
                />
              </Button>
            </CollapsibleTrigger>
          )}
        </div>

        {fineGrained && (
          <CollapsibleContent className="px-2.5 pb-2.5">
            <div className="space-y-1.5 border-t pt-2">
              <p className="text-3xs text-muted-foreground">
                {t("openCode.permissions.rulesHint")}
              </p>

              {entry.rules.length === 0 ? (
                <p className="text-2xs text-muted-foreground">
                  {t("openCode.permissions.noRules")}
                </p>
              ) : (
                entry.rules.map((rule, index) => (
                  // Keyed by position, NOT by pattern: the pattern is what the
                  // input edits, so keying on it would remount the row — and
                  // blur the field — on every accepted keystroke.
                  <div className="flex items-center gap-1.5" key={index}>
                    <Input
                      className={cn(
                        "h-7 flex-1 font-mono text-xs",
                        editingRule?.index === index &&
                          editRejected &&
                          "border-destructive/50"
                      )}
                      disabled={locked}
                      value={
                        editingRule?.index === index
                          ? editingRule.text
                          : rule.pattern
                      }
                      placeholder={patternExample}
                      onChange={(event) =>
                        ruleEditor.onPatternEdit(
                          entry,
                          index,
                          event.target.value
                        )
                      }
                      onBlur={ruleEditor.onPatternEditEnd}
                    />
                    <Select
                      value={rule.action}
                      disabled={locked}
                      onValueChange={(value) => {
                        const next = [...entry.rules]
                        next[index] = {
                          ...rule,
                          action: value as OpenCodePermissionAction,
                        }
                        ruleEditor.onRulesChange(entry.key, next)
                      }}
                    >
                      <SelectTrigger
                        className={cn(
                          "h-7 w-32 text-xs",
                          actionTone(rule.action)
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        {OPENCODE_PERMISSION_ACTIONS.map((action) => (
                          <SelectItem key={action} value={action}>
                            {actionLabel(action)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={locked}
                      onClick={() => {
                        ruleEditor.onPatternEditEnd()
                        ruleEditor.onRulesChange(
                          entry.key,
                          entry.rules.filter((_, i) => i !== index)
                        )
                      }}
                      aria-label={t("openCode.permissions.deleteRule", {
                        pattern: rule.pattern,
                      })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}

              <div className="flex items-center gap-1.5 pt-0.5">
                <Input
                  className="h-7 flex-1 font-mono text-xs"
                  disabled={locked}
                  value={draftPattern}
                  placeholder={patternExample}
                  onChange={(event) =>
                    ruleEditor.onDraftPatternChange(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    if (!duplicate) ruleEditor.onAddRule(entry)
                  }}
                />
                <Select
                  value={draftAction}
                  disabled={locked}
                  onValueChange={(value) =>
                    ruleEditor.onDraftActionChange(
                      value as OpenCodePermissionAction
                    )
                  }
                >
                  <SelectTrigger className="h-7 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {OPENCODE_PERMISSION_ACTIONS.map((action) => (
                      <SelectItem key={action} value={action}>
                        {actionLabel(action)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 gap-1 px-2 text-xs"
                  disabled={locked || !trimmedDraft || duplicate}
                  onClick={() => ruleEditor.onAddRule(entry)}
                >
                  <Plus className="h-3 w-3" />
                  {t("openCode.permissions.addRule")}
                </Button>
              </div>
              {(duplicate || editRejected) && (
                <p className="text-3xs text-destructive">
                  {editRejected && editedText.length === 0
                    ? t("openCode.permissions.blankRule")
                    : t("openCode.permissions.duplicateRule")}
                </p>
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  )
}
