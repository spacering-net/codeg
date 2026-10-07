"use client"

/**
 * Per-agent defaults editor for delegation. Lives inside the
 * "Multi-Agent Collaboration" settings card under the "Agent defaults" tab.
 *
 * Isolation guarantees (critical — see the v2 plan):
 *   1. Options come from a LIVE probe (`describeAgentOptions`), not from the
 *      chat-side `selectorsCache`. What the user sees here is what codeg-mcp
 *      will actually receive when it spawns a subagent.
 *   2. Saving a value here does NOT call `acpSetConfigOption` or write to
 *      `selector-prefs-storage.ts` localStorage. The chat input's own
 *      selectors are untouched. Persistence happens through the parent's
 *      `setDelegationSettings` save action only.
 *   3. The 30s in-memory snapshot cache lives in module scope here; it does
 *      NOT bleed into the chat context.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import {
  type AgentDelegationDefaults,
  type AgentOptionsSnapshot,
  type AgentType,
  type SessionConfigOptionInfo,
} from "@/lib/types"
import { getAgentLabel, isCustomAgentType } from "@/lib/custom-agents"
import { describeAgentOptions } from "@/lib/api"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"
import { toErrorMessage } from "@/lib/app-error"

// Sentinel `value` slot used by the top "Default" Select item in mode +
// config-option rows. Picking it clears the override (sets it back to
// `null`) so the agent's own default takes effect at runtime. Must not
// collide with any real option id any agent could emit — the codeg
// prefix makes a collision implausible.
const DEFAULT_SENTINEL = "__codeg_default__"

// Tab-switch debounce. Without this, rapid clicks across the agent
// buttons would each kick off a real probe (which on the backend now
// serializes per agent_type, but every queued probe still spawns the
// CLI). 250ms is below the threshold of feeling laggy while comfortably
// absorbing a mid-click reconsideration.
const TAB_SWITCH_DEBOUNCE_MS = 250

const BUILTIN_AGENT_TYPES: AgentType[] = [
  "claude_code",
  "codex",
  "open_code",
  "gemini",
  "open_claw",
  "cline",
  "hermes",
  "code_buddy",
  "kimi_code",
  "pi",
  "grok",
  "cursor",
  "deepseek",
  "qoder",
  "antigravity",
]

interface CachedSnapshot {
  snapshot: AgentOptionsSnapshot
  ts: number
}
const SNAPSHOT_TTL_MS = 30_000
const snapshotCache = new Map<AgentType, CachedSnapshot>()

function readCache(agent: AgentType): AgentOptionsSnapshot | null {
  const entry = snapshotCache.get(agent)
  if (!entry) return null
  if (Date.now() - entry.ts > SNAPSHOT_TTL_MS) {
    snapshotCache.delete(agent)
    return null
  }
  return entry.snapshot
}

function writeCache(agent: AgentType, snapshot: AgentOptionsSnapshot): void {
  snapshotCache.set(agent, { snapshot, ts: Date.now() })
}

export interface DelegationAgentDefaultsPanelProps {
  value: Partial<Record<AgentType, AgentDelegationDefaults>>
  onChange: (next: Partial<Record<AgentType, AgentDelegationDefaults>>) => void
  disabled?: boolean
}

export function DelegationAgentDefaultsPanel({
  value,
  onChange,
  disabled,
}: DelegationAgentDefaultsPanelProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  // Custom ACP agents are delegation targets too (codeg-mcp advertises them
  // in `delegate_to_agent`'s enum), so they get a defaults tab after the
  // built-ins. The list mirrors what the agent registry currently holds.
  const { agents } = useAcpAgents()
  const agentTypes = useMemo<AgentType[]>(
    () => [
      ...BUILTIN_AGENT_TYPES,
      ...agents.map((a) => a.agent_type).filter(isCustomAgentType),
    ],
    [agents]
  )
  const [selectedAgent, setSelectedAgent] = useState<AgentType>("claude_code")
  // Snapshot and the agent it was probed from, in ONE state value: the tab
  // switch below is debounced, so for that whole window `selectedAgent` is
  // already the new tab while the snapshot on screen is still the old agent's.
  // Localising the agent's own vocabulary has to key on the producer, or a
  // switch would briefly paint one agent's options in another's wording.
  const [loaded, setLoaded] = useState<{
    agent: AgentType
    snapshot: AgentOptionsSnapshot
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reqIdRef = useRef(0)

  const loadSnapshot = useCallback(async (agent: AgentType, force: boolean) => {
    if (!force) {
      const cached = readCache(agent)
      if (cached) {
        setLoaded({ agent, snapshot: cached })
        setError(null)
        setLoading(false)
        return
      }
    }
    const reqId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    setLoaded(null)
    try {
      const fresh = await describeAgentOptions(agent)
      if (reqIdRef.current !== reqId) return
      writeCache(agent, fresh)
      setLoaded({ agent, snapshot: fresh })
    } catch (err: unknown) {
      if (reqIdRef.current !== reqId) return
      setError(toErrorMessage(err))
    } finally {
      if (reqIdRef.current === reqId) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Debounce so rapid tab clicks (which would each fire a real probe
    // — even with backend serialization, each one still spawns the CLI)
    // collapse into a single load. Cancelling on cleanup means the
    // *last* tab the user lands on wins, not the first.
    const handle = window.setTimeout(() => {
      void loadSnapshot(selectedAgent, false)
    }, TAB_SWITCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [selectedAgent, loadSnapshot])

  const updateAgentDefaults = useCallback(
    (agent: AgentType, next: AgentDelegationDefaults | null) => {
      const updated: Partial<Record<AgentType, AgentDelegationDefaults>> = {
        ...value,
      }
      if (
        next === null ||
        ((!next.mode_id || next.mode_id.length === 0) &&
          Object.keys(next.config_values).length === 0)
      ) {
        delete updated[agent]
      } else {
        updated[agent] = next
      }
      onChange(updated)
    },
    [value, onChange]
  )

  const current = value[selectedAgent] ?? null
  const currentModeId = current?.mode_id ?? null
  const currentConfigValues = current?.config_values ?? {}

  const setMode = (modeId: string | null) => {
    const next: AgentDelegationDefaults = {
      mode_id: modeId ?? undefined,
      config_values: { ...currentConfigValues },
    }
    updateAgentDefaults(selectedAgent, next)
  }

  const setConfigValue = (optionId: string, valueId: string | null) => {
    const nextConfig = { ...currentConfigValues }
    if (valueId === null) {
      delete nextConfig[optionId]
    } else {
      nextConfig[optionId] = valueId
    }
    const next: AgentDelegationDefaults = {
      mode_id: currentModeId ?? undefined,
      config_values: nextConfig,
    }
    updateAgentDefaults(selectedAgent, next)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-5">
        {t("agentDefaultsDescription")}
      </p>

      <div
        role="tablist"
        aria-label={t("tabAgentDefaults")}
        className="flex flex-wrap gap-1 rounded-2xl bg-muted p-1"
      >
        {agentTypes.map((agent) => (
          <button
            key={agent}
            type="button"
            role="tab"
            aria-selected={selectedAgent === agent}
            disabled={disabled}
            onClick={() => setSelectedAgent(agent)}
            className={
              "rounded-xl px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 " +
              (selectedAgent === agent
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {getAgentLabel(agent)}
          </button>
        ))}
      </div>

      <div className="min-h-[7.5rem] rounded-lg border bg-card/50 p-3">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {t("probing")}
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-destructive">
              {t("probeFailed", { detail: error })}
            </p>
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadSnapshot(selectedAgent, true)}
              >
                {t("retry")}
              </Button>
            </div>
          </div>
        )}

        {!loading && !error && loaded && (
          <SnapshotEditor
            agentType={loaded.agent}
            snapshot={loaded.snapshot}
            overrideModeId={currentModeId}
            overrideConfigValues={currentConfigValues}
            onModeChange={setMode}
            onConfigChange={setConfigValue}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  )
}

interface SnapshotEditorProps {
  /** Localises the agent's own mode / option vocabulary; see
   *  `lib/agent-label-vocabulary`. */
  agentType: AgentType
  snapshot: AgentOptionsSnapshot
  overrideModeId: string | null
  overrideConfigValues: Record<string, string>
  onModeChange: (modeId: string | null) => void
  onConfigChange: (optionId: string, valueId: string | null) => void
  disabled?: boolean
}

function SnapshotEditor({
  agentType,
  snapshot,
  overrideModeId,
  overrideConfigValues,
  onModeChange,
  onConfigChange,
  disabled,
}: SnapshotEditorProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  // Localised once here rather than inside the rows: `ModeRow` derives the
  // "agent default" caption from the same list, so translating at the row
  // would leave that caption in the agent's language.
  const vocabulary = useAgentVocabulary(agentType)
  const hasModes =
    snapshot.modes !== null &&
    snapshot.modes !== undefined &&
    snapshot.modes.available_modes.length > 0
  const hasOptions = snapshot.config_options.length > 0

  if (!hasModes && !hasOptions) {
    return (
      <p className="text-xs text-muted-foreground">{t("noConfigAvailable")}</p>
    )
  }

  // Match the chat input box's behavior (`src/components/chat/message-input.tsx`):
  // when the agent advertises both modes AND config options, hide the standalone
  // mode row — some agents (e.g. Codex) expose mode selection as one of the
  // config options too, and showing both produces a duplicate "Mode" entry.
  const showStandaloneMode = hasModes && !hasOptions
  return (
    <div className="space-y-4">
      {showStandaloneMode && snapshot.modes && (
        <ModeRow
          modes={vocabulary.modes(snapshot.modes.available_modes)}
          agentDefaultModeId={snapshot.modes.current_mode_id}
          overrideModeId={overrideModeId}
          onChange={onModeChange}
          disabled={disabled}
        />
      )}
      {snapshot.config_options.map((option) => (
        <ConfigOptionRow
          key={option.id}
          option={vocabulary.configOption(option)}
          overrideValue={overrideConfigValues[option.id] ?? null}
          onChange={(valueId) => onConfigChange(option.id, valueId)}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

interface ModeRowProps {
  modes: Array<{ id: string; name: string; description?: string | null }>
  agentDefaultModeId: string
  overrideModeId: string | null
  onChange: (modeId: string | null) => void
  disabled?: boolean
}

function ModeRow({
  modes,
  agentDefaultModeId,
  overrideModeId,
  onChange,
  disabled,
}: ModeRowProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  const agentDefaultName =
    modes.find((m) => m.id === agentDefaultModeId)?.name ?? agentDefaultModeId
  // When no override exists, show the Default sentinel so the user can
  // see "no override is set" at a glance; selecting any real mode below
  // applies an override, selecting the sentinel clears it.
  const selectValue = overrideModeId ?? DEFAULT_SENTINEL
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5 min-w-0">
        <label className="text-sm font-medium">{t("modeLabel")}</label>
        <p className="text-xs text-muted-foreground">
          {t("agentDefaultHint", { value: agentDefaultName })}
        </p>
      </div>
      <Select
        value={selectValue}
        onValueChange={(v) => onChange(v === DEFAULT_SENTINEL ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL}>
            {t("defaultOptionLabel", { value: agentDefaultName })}
          </SelectItem>
          {modes.map((mode) => (
            <SelectItem key={mode.id} value={mode.id}>
              {mode.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

interface ConfigOptionRowProps {
  option: SessionConfigOptionInfo
  overrideValue: string | null
  onChange: (valueId: string | null) => void
  disabled?: boolean
}

function ConfigOptionRow({
  option,
  overrideValue,
  onChange,
  disabled,
}: ConfigOptionRowProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  if (option.kind.type !== "select") return null

  const allOptions =
    option.kind.groups.length > 0
      ? option.kind.groups.flatMap((g) => g.options)
      : option.kind.options
  const agentDefault = option.kind.current_value
  const agentDefaultLabel =
    allOptions.find((o) => o.value === agentDefault)?.name ?? agentDefault
  // When no override exists, the trigger shows the Default sentinel item
  // so the user can tell "I'm inheriting" apart from "I picked the
  // agent's current default explicitly" — the latter would stick to that
  // literal value even if the agent later changes its own default.
  const selectValue = overrideValue ?? DEFAULT_SENTINEL

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5 min-w-0">
        <label className="text-sm font-medium">{option.name}</label>
        <p className="text-xs text-muted-foreground">
          {t("agentDefaultHint", { value: agentDefaultLabel })}
        </p>
      </div>
      <Select
        value={selectValue}
        onValueChange={(v) => onChange(v === DEFAULT_SENTINEL ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL}>
            {t("defaultOptionLabel", { value: agentDefaultLabel })}
          </SelectItem>
          {option.kind.groups.length > 0
            ? option.kind.groups.map((group) => (
                <SelectGroup key={group.group}>
                  <SelectLabel>{group.name}</SelectLabel>
                  {group.options.map((item) => (
                    <SelectItem
                      key={`${group.group}-${item.value}`}
                      value={item.value}
                    >
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))
            : option.kind.options.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.name}
                </SelectItem>
              ))}
        </SelectContent>
      </Select>
    </div>
  )
}
